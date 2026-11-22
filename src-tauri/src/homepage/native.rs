//! 主页仓库的底层操作只接受已经核验、仍由调用者持有的目录句柄。

use std::{fs::File, io};

use super::tr;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct FileId(u64, u64);

#[derive(Clone, Copy)]
enum Access {
    Read,
    Delete,
    Create,
    Inspect,
}

fn leaf(name: &str) -> io::Result<&str> {
    if name.is_empty() || name.len() > 240 || name.trim() != name || name.ends_with('.')
        || name.chars().any(|c| c.is_control() || "\\/:*?\"<>|".contains(c))
    {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$")
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(*prefix).is_some_and(|number| {
                matches!(number, "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")
            })
        });
    if device { return Err(io::ErrorKind::InvalidInput.into()); }
    Ok(name)
}

fn publish_error() -> String {
    tr("无法安全发布主页文件", "無法安全發佈主頁檔案", "Could not safely publish the homepage file")
}

fn cleanup_error() -> String {
    tr("无法确认待清理主页文件的身份，已停止清理", "無法確認待清理主頁檔案的身分，已停止清理", "Could not verify the homepage file for cleanup; cleanup stopped")
}

fn publish_io(error: io::Error) -> String {
    if error.kind() == io::ErrorKind::AlreadyExists {
        tr("主页文件目标已存在，未覆盖", "主頁檔案目標已存在，未覆寫", "The homepage file target already exists; it was not overwritten")
    } else {
        publish_error()
    }
}

pub(super) fn identity(file: &File) -> Result<FileId, String> {
    platform::identity(file).map_err(|_| tr("无法确认主页文件的身份", "無法確認主頁檔案的身分", "Could not verify the homepage file identity"))
}

pub(super) fn mkdir(parent: &File, name: &str) -> io::Result<()> {
    platform::mkdir(parent, leaf(name)?)
}

pub(super) fn open(parent: &File, name: &str, delete: bool) -> io::Result<File> {
    let file = platform::open(parent, leaf(name)?, if delete { Access::Delete } else { Access::Read })?;
    platform::identity(&file)?;
    Ok(file)
}

pub(super) fn create(parent: &File, name: &str) -> io::Result<File> {
    // 独占创建不接受现存叶。成功后由仓管立即登记返回的句柄及其身份。
    platform::open(parent, leaf(name)?, Access::Create)
}

fn has_identity(file: &File, expected: &FileId) -> bool {
    platform::identity(file).is_ok_and(|actual| actual == *expected)
}

pub(super) fn publish(
    parent: &File,
    file: &File,
    from: &str,
    to: &str,
    replace: bool,
    expected: &FileId,
) -> Result<(), String> {
    let from = leaf(from).map_err(publish_io)?;
    let to = leaf(to).map_err(publish_io)?;
    if from.eq_ignore_ascii_case(to) || !has_identity(file, expected) {
        return Err(publish_error());
    }
    // 仅仓管可为明确授权的目标传 replace；发现链接、目录或多硬链就拒绝。
    // 替换目标的检查与提交没有身份 CAS，依赖仓库私有目录及串行操作。
    // 若目标尚不存在，继续使用无覆盖提交，避免覆盖检查后才出现的文件。
    let replace = match platform::open(parent, to, Access::Inspect) {
        Ok(target) if replace => {
            let id = platform::identity(&target).map_err(publish_io)?;
            if id == *expected { return Err(publish_error()); }
            true
        }
        Ok(_) => return Err(publish_io(io::ErrorKind::AlreadyExists.into())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(publish_io(error)),
    };
    let bound = platform::open(parent, from, Access::Inspect).map_err(publish_io)?;
    if !has_identity(&bound, expected) {
        return Err(publish_error());
    }
    drop(bound);
    // 内核提交成功后不再执行可能失败的后验；仓管据此移动身份登记。
    platform::publish(parent, file, from, to, replace).map_err(publish_io)
}

pub(super) fn remove(parent: &File, name: &str, expected: &FileId) -> Result<(), String> {
    let name = leaf(name).map_err(|_| cleanup_error())?;
    let file = platform::open(parent, name, Access::Delete).map_err(|_| cleanup_error())?;
    remove_open(parent, name, file, expected)
}

pub(super) fn remove_open(parent: &File, name: &str, file: File, expected: &FileId) -> Result<(), String> {
    let name = leaf(name).map_err(|_| cleanup_error())?;
    if !has_identity(&file, expected) {
        return Err(cleanup_error());
    }
    let bound = platform::open(parent, name, Access::Inspect).map_err(|_| cleanup_error())?;
    if !has_identity(&bound, expected) {
        return Err(cleanup_error());
    }
    drop(bound);
    platform::remove(parent, name, &file).map_err(|_| cleanup_error())
}

#[cfg(all(unix, any(
    target_os = "macos", target_os = "ios",
    all(any(target_os = "linux", target_os = "android"), any(target_arch = "x86", target_arch = "x86_64", target_arch = "arm", target_arch = "aarch64", target_arch = "riscv64")),
)))]
mod platform {
    use super::*;
    use std::{ffi::{c_char, CString}, os::{fd::{AsRawFd, FromRawFd}, unix::fs::MetadataExt}};

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    mod flags {
        pub(super) type Mode = u16;
        pub(super) const NOFOLLOW: i32 = 0x100;
        pub(super) const CLOEXEC: i32 = 0x1000000;
        pub(super) const NONBLOCK: i32 = 4;
        pub(super) const NOCTTY: i32 = 0x20000;
        pub(super) const CREATE_EXCL: i32 = 0x200 | 0x800;
        pub(super) const INSPECT: i32 = NONBLOCK | NOCTTY;
    }
    #[cfg(any(target_os = "linux", target_os = "android"))]
    mod flags {
        #[cfg(all(target_os = "android", target_pointer_width = "32"))]
        pub(super) type Mode = u16;
        #[cfg(not(all(target_os = "android", target_pointer_width = "32")))]
        pub(super) type Mode = u32;
        // arm/aarch64 的内核头中 O_NOFOLLOW 位与 x86、riscv64 不同。
        #[cfg(any(target_arch = "arm", target_arch = "aarch64"))]
        pub(super) const NOFOLLOW: i32 = 0x8000;
        #[cfg(not(any(target_arch = "arm", target_arch = "aarch64")))]
        pub(super) const NOFOLLOW: i32 = 0x20000;
        pub(super) const CLOEXEC: i32 = 0x80000;
        pub(super) const NONBLOCK: i32 = 0x800;
        pub(super) const NOCTTY: i32 = 0x100;
        pub(super) const CREATE_EXCL: i32 = 0x40 | 0x80;
        // O_PATH 只探测叶身份，不读 FIFO 或设备。若打开的是链接本身，identity 会拒绝。
        pub(super) const INSPECT: i32 = 0x200000;
    }
    use flags::*;

    extern "C" {
        fn openat(fd: i32, name: *const c_char, flags: i32, ...) -> i32;
        fn mkdirat(fd: i32, name: *const c_char, mode: Mode) -> i32;
        fn renameat(from_dir: i32, from: *const c_char, to_dir: i32, to: *const c_char) -> i32;
        fn unlinkat(fd: i32, name: *const c_char, flags: i32) -> i32;
    }

    fn name(value: &str) -> io::Result<CString> {
        CString::new(value).map_err(|_| io::ErrorKind::InvalidInput.into())
    }

    fn status(result: i32) -> io::Result<()> {
        if result == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
    }

    fn directory(parent: &File) -> io::Result<()> {
        if !parent.metadata()?.is_dir() { return Err(io::ErrorKind::InvalidInput.into()); }
        Ok(())
    }

    pub(super) fn identity(file: &File) -> io::Result<FileId> {
        let meta = file.metadata()?;
        if !meta.is_file() || meta.nlink() != 1 || meta.ino() == 0 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(FileId(meta.dev(), meta.ino()))
    }

    pub(super) fn mkdir(parent: &File, leaf: &str) -> io::Result<()> {
        directory(parent)?;
        let text = name(leaf)?;
        status(unsafe { mkdirat(parent.as_raw_fd(), text.as_ptr(), 0o700) })
    }

    pub(super) fn open(parent: &File, leaf: &str, access: Access) -> io::Result<File> {
        directory(parent)?;
        let text = name(leaf)?;
        let mode = NOFOLLOW | CLOEXEC | match access {
            Access::Read => NONBLOCK | NOCTTY,
            Access::Delete | Access::Inspect => INSPECT,
            Access::Create => 2 | CREATE_EXCL,
        };
        // openat 的可变参数遵循 C 整数提升，即使 Darwin 的 mode_t 是 u16。
        let fd = unsafe { openat(parent.as_raw_fd(), text.as_ptr(), mode, 0o600i32) };
        if fd < 0 { Err(io::Error::last_os_error()) } else { Ok(unsafe { File::from_raw_fd(fd) }) }
    }

    #[cfg(target_os = "linux")]
    fn no_replace(dir: i32, from: &CString, to: &CString) -> io::Result<()> {
        extern "C" {
            fn renameat2(from_dir: i32, from: *const c_char, to_dir: i32, to: *const c_char, flags: u32) -> i32;
        }
        status(unsafe { renameat2(dir, from.as_ptr(), dir, to.as_ptr(), 1) })
    }

    #[cfg(target_os = "android")]
    fn no_replace(dir: i32, from: &CString, to: &CString) -> io::Result<()> {
        use std::ffi::c_long;
        // NDK 的 asm/unistd*.h；bionic 的 renameat2 导出要求 API 30，但 syscall 不要求。
        #[cfg(target_arch = "x86")]
        const RENAMEAT2: c_long = 353;
        #[cfg(target_arch = "x86_64")]
        const RENAMEAT2: c_long = 316;
        #[cfg(target_arch = "arm")]
        const RENAMEAT2: c_long = 382;
        #[cfg(any(target_arch = "aarch64", target_arch = "riscv64"))]
        const RENAMEAT2: c_long = 276;
        extern "C" { fn syscall(number: c_long, ...) -> c_long; }
        let fd = c_long::from(dir);
        let result = unsafe { syscall(RENAMEAT2, fd, from.as_ptr(), fd, to.as_ptr(), 1 as c_long) };
        // 内核或文件系统不支持时保留错误，不降级为可覆盖改名。
        status(result as i32)
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    fn no_replace(dir: i32, from: &CString, to: &CString) -> io::Result<()> {
        extern "C" {
            fn renameatx_np(from_dir: i32, from: *const c_char, to_dir: i32, to: *const c_char, flags: u32) -> i32;
        }
        status(unsafe { renameatx_np(dir, from.as_ptr(), dir, to.as_ptr(), 4) })
    }

    pub(super) fn publish(parent: &File, _: &File, from: &str, to: &str, replace: bool) -> io::Result<()> {
        let dir = parent.as_raw_fd();
        let (from, to) = (name(from)?, name(to)?);
        // Unix 的 renameat[2] 无 expected-inode CAS；依赖仓库私有目录及串行操作。
        if replace {
            status(unsafe { renameat(dir, from.as_ptr(), dir, to.as_ptr()) })
        } else {
            no_replace(dir, &from, &to)
        }
    }

    pub(super) fn remove(parent: &File, name_value: &str, _: &File) -> io::Result<()> {
        let text = name(name_value)?;
        // unlinkat 同样不能把 inode 检查与移除合成一次系统调用；同 UID 可在其间换叶。
        status(unsafe { unlinkat(parent.as_raw_fd(), text.as_ptr(), 0) })
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{ffi::c_void, mem::{offset_of, size_of, MaybeUninit}, os::windows::{fs::MetadataExt, io::{AsRawHandle, FromRawHandle}}, ptr};

    type Handle = *mut c_void;
    const READ_ATTRIBUTES: u32 = 0x80;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const DELETE: u32 = 0x0001_0000;
    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const FILE_SHARE_READ: u32 = 1;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    const FILE_TYPE_DISK: u32 = 1;
    const FILE_OPEN: u32 = 1;
    const FILE_CREATE: u32 = 2;
    const OBJ_CASE_INSENSITIVE: u32 = 0x40;
    const OBJ_DONT_REPARSE: u32 = 0x1000;
    const FILE_DIRECTORY_FILE: u32 = 1;
    const FILE_NON_DIRECTORY_FILE: u32 = 0x40;
    const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x20;
    const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_RENAME_INFORMATION: i32 = 10;
    const FILE_DISPOSITION_INFORMATION: i32 = 13;
    const FILE_STANDARD_INFO: i32 = 1;
    const FILE_ID_INFO: i32 = 18;

    #[repr(C)]
    struct UnicodeString { length: u16, maximum: u16, buffer: *mut u16 }
    #[repr(C)]
    struct ObjectAttributes { length: u32, root: Handle, name: *mut UnicodeString, flags: u32, security: *mut c_void, qos: *mut c_void }
    #[repr(C)]
    struct IoStatus { status_or_pointer: isize, information: usize }
    #[repr(C)]
    struct StandardInfo { allocation_size: i64, end_of_file: i64, links: u32, delete_pending: u8, directory: u8 }
    #[repr(C)]
    struct IdInfo { volume: u64, id: [u8; 16] }
    #[repr(C)]
    struct RenameInfo { replace: u8, root: Handle, name_bytes: u32, name: [u16; 1] }

    #[link(name = "ntdll")]
    extern "system" {
        fn NtCreateFile(file: *mut Handle, access: u32, attrs: *mut ObjectAttributes, status: *mut IoStatus, allocation: *const i64, attributes: u32, share: u32, disposition: u32, options: u32, ea: *mut c_void, ea_len: u32) -> i32;
        fn NtSetInformationFile(file: Handle, status: *mut IoStatus, info: *mut c_void, length: u32, class: i32) -> i32;
        fn RtlNtStatusToDosError(status: i32) -> u32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileInformationByHandleEx(file: Handle, class: i32, info: *mut c_void, length: u32) -> i32;
        fn GetFileType(file: Handle) -> u32;
    }

    fn status(result: i32) -> io::Result<()> {
        if result < 0 {
            Err(io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(result) } as i32))
        } else {
            Ok(())
        }
    }

    fn plain(file: &File, directory: bool) -> io::Result<()> {
        if unsafe { GetFileType(file.as_raw_handle()) } != FILE_TYPE_DISK {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let meta = file.metadata()?;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || !(if directory { meta.is_dir() } else { meta.is_file() })
        {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(())
    }

    pub(super) fn identity(file: &File) -> io::Result<FileId> {
        plain(file, false)?;
        let raw = file.as_raw_handle();
        let mut standard = MaybeUninit::<StandardInfo>::uninit();
        if unsafe { GetFileInformationByHandleEx(raw, FILE_STANDARD_INFO, standard.as_mut_ptr().cast(), size_of::<StandardInfo>() as u32) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let standard = unsafe { standard.assume_init() };
        if standard.links != 1 || standard.delete_pending != 0 || standard.directory != 0 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let mut id = MaybeUninit::<IdInfo>::uninit();
        if unsafe { GetFileInformationByHandleEx(raw, FILE_ID_INFO, id.as_mut_ptr().cast(), size_of::<IdInfo>() as u32) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let id = unsafe { id.assume_init() };
        let index = u64::from_le_bytes(id.id[..8].try_into().map_err(|_| io::ErrorKind::InvalidData)?);
        // 拒绝不能装进登记结构的文件身份，不能截断宽 ID 后用于清理。
        if index == 0 || id.id[8..].iter().any(|&b| b != 0) {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(FileId(id.volume, index))
    }

    fn relative(parent: &File, name: &str, directory: bool, access: u32, disposition: u32) -> io::Result<File> {
        plain(parent, true)?;
        let mut wide: Vec<u16> = name.encode_utf16().collect();
        let length = u16::try_from(wide.len() * 2).map_err(|_| io::ErrorKind::InvalidInput)?;
        let mut text = UnicodeString { length, maximum: length, buffer: wide.as_mut_ptr() };
        let mut attrs = ObjectAttributes {
            length: size_of::<ObjectAttributes>() as u32,
            root: parent.as_raw_handle(),
            name: &mut text,
            flags: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
            security: ptr::null_mut(),
            qos: ptr::null_mut(),
        };
        let mut io_status = IoStatus { status_or_pointer: 0, information: 0 };
        let mut raw = ptr::null_mut();
        let options = FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT
            | if directory { FILE_DIRECTORY_FILE } else { FILE_NON_DIRECTORY_FILE };
        status(unsafe {
            NtCreateFile(&mut raw, access | SYNCHRONIZE, &mut attrs, &mut io_status, ptr::null(), 0,
                FILE_SHARE_READ, disposition, options, ptr::null_mut(), 0)
        })?;
        Ok(unsafe { File::from_raw_handle(raw) })
    }

    pub(super) fn mkdir(parent: &File, leaf: &str) -> io::Result<()> {
        relative(parent, leaf, true, READ_ATTRIBUTES, FILE_CREATE).map(drop)
    }

    pub(super) fn open(parent: &File, leaf: &str, access: Access) -> io::Result<File> {
        let (rights, disposition) = match access {
            Access::Read => (GENERIC_READ, FILE_OPEN),
            Access::Delete => (READ_ATTRIBUTES | DELETE, FILE_OPEN),
            Access::Create => (GENERIC_READ | GENERIC_WRITE | DELETE, FILE_CREATE),
            // 只取属性，不申请数据读取、写入或删除。可复验已持有 DELETE 的源，
            // 同时不会给任何文件句柄增加共享写入或共享删除权限。
            Access::Inspect => (READ_ATTRIBUTES, FILE_OPEN),
        };
        relative(parent, leaf, false, rights, disposition)
    }

    pub(super) fn publish(parent: &File, file: &File, _: &str, to: &str, replace: bool) -> io::Result<()> {
        let wide: Vec<u16> = to.encode_utf16().collect();
        let name_bytes = wide.len() * 2;
        let offset = offset_of!(RenameInfo, name);
        let size = (offset + name_bytes).max(size_of::<RenameInfo>());
        // usize 存储保证根句柄字段对齐，柔性名称按 UTF-16 字节数传给内核。
        let mut buffer = vec![0usize; size.div_ceil(size_of::<usize>())];
        let info = buffer.as_mut_ptr().cast::<RenameInfo>();
        let mut io_status = IoStatus { status_or_pointer: 0, information: 0 };
        unsafe {
            (*info).replace = u8::from(replace);
            (*info).root = parent.as_raw_handle();
            (*info).name_bytes = name_bytes as u32;
            ptr::copy_nonoverlapping(wide.as_ptr(), info.cast::<u8>().add(offset).cast::<u16>(), wide.len());
            // 普通 FileRenameInformation 不请求绕开目标句柄的 POSIX 覆盖语义。
            status(NtSetInformationFile(file.as_raw_handle(), &mut io_status, info.cast(), size as u32, FILE_RENAME_INFORMATION))
        }
    }

    pub(super) fn remove(_: &File, _: &str, file: &File) -> io::Result<()> {
        let mut delete = 1u8;
        let mut io_status = IoStatus { status_or_pointer: 0, information: 0 };
        // 标记经身份复验的文件对象，最后一个句柄关闭时生效，不按字符串另删一次。
        status(unsafe { NtSetInformationFile(file.as_raw_handle(), &mut io_status, (&mut delete as *mut u8).cast(), 1, FILE_DISPOSITION_INFORMATION) })
    }
}

#[cfg(not(any(windows, all(unix, any(
    target_os = "macos", target_os = "ios",
    all(any(target_os = "linux", target_os = "android"), any(target_arch = "x86", target_arch = "x86_64", target_arch = "arm", target_arch = "aarch64", target_arch = "riscv64")),
)))))]
mod platform {
    use super::*;

    fn unsupported<T>() -> io::Result<T> { Err(io::ErrorKind::Unsupported.into()) }
    pub(super) fn identity(_: &File) -> io::Result<FileId> { unsupported() }
    pub(super) fn mkdir(_: &File, _: &str) -> io::Result<()> { unsupported() }
    pub(super) fn open(_: &File, _: &str, _: Access) -> io::Result<File> { unsupported() }
    pub(super) fn publish(_: &File, _: &File, _: &str, _: &str, _: bool) -> io::Result<()> { unsupported() }
    pub(super) fn remove(_: &File, _: &str, _: &File) -> io::Result<()> { unsupported() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn homepage_native_rejects_unsafe_leaf_names() {
        for name in ["", ".", "..", "../safe.html", "a\\b", "a:stream", "bad\0name", "a\n", " a", "a.", "NUL.html", "CONOUT$", "com¹.zip", "lpt9.txt", "PRN .html"] {
            assert_eq!(leaf(name).unwrap_err().kind(), io::ErrorKind::InvalidInput, "{name:?}");
        }
        assert!(leaf(&"a".repeat(241)).is_err());
        for name in ["主页.html", ".homepage-012345.part", "page 1.html", "COM12.html"] {
            assert_eq!(leaf(name).unwrap(), name);
        }
    }

    #[cfg(any(windows, target_os = "linux", target_os = "android", target_os = "macos", target_os = "ios"))]
    mod files {
        use super::*;
        use std::{fs, io::Write, path::{Path, PathBuf}};

        struct Fixture(PathBuf);
        impl Fixture {
            fn new() -> Self {
                let path = std::env::temp_dir().join(format!("hcmcl-homepage-native-{}", uuid::Uuid::new_v4()));
                fs::create_dir(&path).unwrap();
                Self(path)
            }
        }
        impl Drop for Fixture {
            fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
        }

        fn directory(path: &Path) -> File {
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                fs::OpenOptions::new().read(true).share_mode(3).custom_flags(0x0220_0000).open(path).unwrap()
            }
            #[cfg(unix)]
            File::open(path).unwrap()
        }

        #[test]
        fn homepage_native_preserves_conflicts_and_explicitly_replaces() {
            let fixture = Fixture::new();
            let root = directory(&fixture.0);
            mkdir(&root, "homepages").unwrap();
            assert_eq!(mkdir(&root, "homepages").unwrap_err().kind(), io::ErrorKind::AlreadyExists);
            let path = fixture.0.join("homepages");
            let parent = directory(&path);
            let mut stage = create(&parent, ".test.part").unwrap();
            stage.write_all(b"replacement").unwrap();
            let id = identity(&stage).unwrap();
            fs::write(path.join("page.html"), b"existing").unwrap();
            assert_eq!(create(&parent, "page.html").unwrap_err().kind(), io::ErrorKind::AlreadyExists);
            assert!(publish(&parent, &stage, ".test.part", "page.html", false, &id).is_err());
            assert_eq!(fs::read(path.join("page.html")).unwrap(), b"existing");
            publish(&parent, &stage, ".test.part", "page.html", true, &id).unwrap();
            drop(stage);
            assert!(!path.join(".test.part").exists());
            assert_eq!(fs::read(path.join("page.html")).unwrap(), b"replacement");
            let opened = open(&parent, "page.html", false).unwrap();
            assert_eq!(identity(&opened).unwrap(), id);
            drop(opened);
            remove(&parent, "page.html", &id).unwrap();
            assert!(!path.join("page.html").exists());
        }

        #[test]
        fn homepage_native_requires_the_recorded_leaf_parent_and_identity() {
            let fixture = Fixture::new();
            let parent = directory(&fixture.0);
            mkdir(&parent, "other").unwrap();
            let other_path = fixture.0.join("other");
            let other = directory(&other_path);
            fs::write(other_path.join(".test.part"), b"different directory").unwrap();
            fs::write(fixture.0.join("unknown.html"), b"keep").unwrap();
            let stage = create(&parent, ".test.part").unwrap();
            let id = identity(&stage).unwrap();
            let unknown = open(&parent, "unknown.html", false).unwrap();
            let wrong_id = identity(&unknown).unwrap();
            drop(unknown);
            assert!(publish(&other, &stage, ".test.part", "new.html", false, &id).is_err());
            assert!(publish(&parent, &stage, "unknown.html", "new.html", false, &id).is_err());
            assert!(publish(&parent, &stage, ".test.part", "new.html", false, &wrong_id).is_err());
            assert!(remove(&parent, "unknown.html", &id).is_err());
            assert!(remove_open(&other, ".test.part", stage, &id).is_err());
            assert_eq!(fs::read(fixture.0.join("unknown.html")).unwrap(), b"keep");
            assert_eq!(fs::read(other_path.join(".test.part")).unwrap(), b"different directory");
            assert!(!other_path.join("new.html").exists());
            let stage = open(&parent, ".test.part", true).unwrap();
            publish(&parent, &stage, ".test.part", "new.html", false, &id).unwrap();
            remove_open(&parent, "new.html", stage, &id).unwrap();
            assert!(!fixture.0.join("new.html").exists());
        }

        #[test]
        fn homepage_native_rejects_hardlinks_and_leaves_the_target_intact() {
            let fixture = Fixture::new();
            let parent = directory(&fixture.0);
            let target = fixture.0.join("page.html");
            let alias = fixture.0.join("alias.html");
            fs::write(&target, b"original").unwrap();
            let original = open(&parent, "page.html", false).unwrap();
            let id = identity(&original).unwrap();
            drop(original);
            fs::hard_link(&target, &alias).unwrap();
            let stage = create(&parent, ".test.part").unwrap();
            let stage_id = identity(&stage).unwrap();
            assert!(open(&parent, "page.html", false).is_err());
            assert!(remove(&parent, "page.html", &id).is_err());
            assert!(publish(&parent, &stage, ".test.part", "page.html", true, &stage_id).is_err());
            assert_eq!(fs::read(&alias).unwrap(), b"original");
            assert_eq!(fs::read(&target).unwrap(), b"original");
            remove_open(&parent, ".test.part", stage, &stage_id).unwrap();
        }

        #[cfg(unix)]
        #[test]
        fn homepage_native_rejects_symlinks_and_uses_the_held_directory() {
            let fixture = Fixture::new();
            let original = fixture.0.join("root");
            let moved = fixture.0.join("moved");
            fs::create_dir(&original).unwrap();
            let parent = directory(&original);
            fs::rename(&original, &moved).unwrap();
            fs::create_dir(&original).unwrap();
            let outside = original.join("outside.html");
            fs::write(&outside, b"do not alter").unwrap();
            std::os::unix::fs::symlink(&outside, moved.join("link.html")).unwrap();
            let stage = create(&parent, ".test.part").unwrap();
            let id = identity(&stage).unwrap();
            assert!(open(&parent, "link.html", false).is_err());
            assert!(publish(&parent, &stage, ".test.part", "link.html", true, &id).is_err());
            assert!(fs::symlink_metadata(moved.join("link.html")).unwrap().is_symlink());
            publish(&parent, &stage, ".test.part", "page.html", false, &id).unwrap();
            assert!(moved.join("page.html").is_file());
            assert!(!original.join("page.html").exists());
            assert_eq!(fs::read(outside).unwrap(), b"do not alter");
        }

        #[cfg(windows)]
        #[test]
        fn homepage_native_windows_denies_shared_writes_and_deletion() {
            let fixture = Fixture::new();
            let parent = directory(&fixture.0);
            let path = fixture.0.join("page.html");
            fs::write(&path, b"existing").unwrap();
            let held = open(&parent, "page.html", false).unwrap();
            assert!(fs::OpenOptions::new().write(true).open(&path).is_err());
            assert!(fs::rename(&path, fixture.0.join("moved.html")).is_err());
            let stage = create(&parent, ".test.part").unwrap();
            let id = identity(&stage).unwrap();
            assert!(publish(&parent, &stage, ".test.part", "page.html", true, &id).is_err());
            drop(held);
            publish(&parent, &stage, ".test.part", "page.html", true, &id).unwrap();
            remove_open(&parent, "page.html", stage, &id).unwrap();
            assert!(!path.exists());
        }
    }
}

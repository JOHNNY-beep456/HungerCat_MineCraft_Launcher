//! 仅接受已持有的父目录和单个 leaf；绝不把绝对路径重新用作写入授权。
use super::{Identity, Result, conflict, identity, linked, unsupported, validate_segment};
use super::super::access::Directory;
use std::{fs::File, io};

fn checked(file: &File, expected: Option<&Identity>, directory: bool) -> Result<Identity> {
    let meta = file.metadata().map_err(|_| "无法检查暂存句柄")?;
    if linked(&meta) || if directory { !meta.is_dir() } else { !meta.is_file() } {
        return Err("暂存句柄类型改变或成为链接".into());
    }
    if !directory && super::link_count(file, &meta)? != 1 { return Err("暂存文件不是唯一硬链接".into()); }
    let id = identity(file, &meta)?;
    if expected.map(|old| old != &id).unwrap_or(false) { return Err("暂存句柄身份改变".into()); }
    Ok(id)
}

pub(super) fn mkdir(parent: &Directory, name: &str) -> Result<File> {
    validate_segment(name)?;
    parent.verify()?;
    let file = os::mkdir(parent.handle(), name).map_err(|_| "无法建立独占暂存子目录")?;
    checked(&file, None, true)?;
    parent.verify()?;
    Ok(file)
}
pub(super) fn new_file(parent: &Directory, name: &str) -> Result<File> {
    validate_segment(name)?;
    parent.verify()?;
    let file = os::new_file(parent.handle(), name).map_err(|_| "无法建立独占暂存文件")?;
    checked(&file, None, false)?;
    parent.verify()?;
    Ok(file)
}
pub(super) fn remove(parent: &Directory, name: &str, expected: &Identity, directory: bool) -> Result<()> {
    validate_segment(name)?;
    parent.verify()?;
    os::remove(parent.handle(), name, expected, directory)?;
    parent.verify()
}
pub(super) fn remove_open(parent: &Directory, name: &str, file: File, expected: &Identity) -> Result<()> {
    validate_segment(name)?;
    parent.verify()?;
    checked(&file, Some(expected), false)?;
    os::remove_open(parent.handle(), name, file, expected)?;
    parent.verify()
}
pub(super) fn rename_file_noreplace(parent: &Directory, file: &File, from: &str, to: &str, expected: &Identity) -> Result<()> {
    validate_segment(from)?;
    validate_segment(to)?;
    parent.verify()?;
    checked(file, Some(expected), false)?;
    os::rename(parent.handle(), Some(file), from, to, expected, false)
}
/// 返回 Ok 只表示内核已完成 rename；成功后的状态必须由调用方立刻设为 Published。
pub(super) fn publish_dir_noreplace(parent: &Directory, from: &str, to: &str, expected: &Identity) -> Result<()> {
    validate_segment(from)?;
    validate_segment(to)?;
    parent.verify()?;
    os::rename(parent.handle(), None, from, to, expected, true)
}

#[cfg(any(target_os="linux", target_os="android", target_os="macos", target_os="ios"))]
mod os {
    use super::*;
    use std::{ffi::{CString, c_char, c_void}, os::fd::{AsRawFd, FromRawFd}};
    // Android NDK 30 sysroot usr/include/{arm,aarch64}-linux-android/asm/fcntl.h。
    #[cfg(any(target_os="macos", target_os="ios"))] const NOFOLLOW: i32 = 0x100;
    #[cfg(all(any(target_os="linux", target_os="android"), any(target_arch="arm", target_arch="aarch64")))] const NOFOLLOW: i32 = 0x8000;
    #[cfg(all(any(target_os="linux", target_os="android"), not(any(target_arch="arm", target_arch="aarch64"))))] const NOFOLLOW: i32 = 0x20000;
    #[cfg(any(target_os="macos", target_os="ios"))] const DIRECTORY: i32 = 0x100000;
    #[cfg(all(any(target_os="linux", target_os="android"), any(target_arch="arm", target_arch="aarch64")))] const DIRECTORY: i32 = 0x4000;
    #[cfg(all(any(target_os="linux", target_os="android"), not(any(target_arch="arm", target_arch="aarch64"))))] const DIRECTORY: i32 = 0x10000;
    #[cfg(any(target_os="macos", target_os="ios"))] const CLOEXEC: i32 = 0x1000000;
    #[cfg(any(target_os="linux", target_os="android"))] const CLOEXEC: i32 = 0x80000;
    #[cfg(any(target_os="macos", target_os="ios"))] const CREATE_EXCL: i32 = 0x200 | 0x800;
    #[cfg(any(target_os="linux", target_os="android"))] const CREATE_EXCL: i32 = 0x40 | 0x80;
    #[cfg(any(target_os="macos", target_os="ios"))] const NONBLOCK: i32 = 4;
    #[cfg(any(target_os="linux", target_os="android"))] const NONBLOCK: i32 = 0x800;
    #[cfg(any(target_os="macos", target_os="ios"))] const REMOVEDIR: i32 = 0x80;
    #[cfg(any(target_os="linux", target_os="android"))] const REMOVEDIR: i32 = 0x200;
    extern "C" {
        fn openat(fd: i32, name: *const c_char, flags: i32, ...) -> i32;
        fn mkdirat(fd: i32, name: *const c_char, mode: u32) -> i32;
        fn unlinkat(fd: i32, name: *const c_char, flags: i32) -> i32;
    }
    fn name(name: &str) -> io::Result<CString> { CString::new(name).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput)) }
    fn open(parent: &File, leaf: &str, flags: i32, mode: u32) -> io::Result<File> {
        let leaf = name(leaf)?;
        let fd = unsafe { openat(parent.as_raw_fd(), leaf.as_ptr(), flags, mode) };
        if fd < 0 { Err(io::Error::last_os_error()) } else { Ok(unsafe { File::from_raw_fd(fd) }) }
    }
    pub(super) fn mkdir(parent: &File, leaf: &str) -> io::Result<File> {
        let text = name(leaf)?;
        if unsafe { mkdirat(parent.as_raw_fd(), text.as_ptr(), 0o700) } < 0 { return Err(io::Error::last_os_error()); }
        open(parent, leaf, DIRECTORY | NOFOLLOW | CLOEXEC, 0)
    }
    pub(super) fn new_file(parent: &File, leaf: &str) -> io::Result<File> { open(parent, leaf, 2 | CREATE_EXCL | NOFOLLOW | CLOEXEC, 0o600) }
    pub(super) fn remove(parent: &File, leaf: &str, expected: &Identity, directory: bool) -> Result<()> {
        let file = open(parent, leaf, NOFOLLOW | CLOEXEC | NONBLOCK | if directory { DIRECTORY } else { 0 }, 0)
            .map_err(|_| "无法打开待删除暂存项")?;
        checked(&file, Some(expected), directory)?;
        // unlinkat 没有 expected-inode CAS：仍明确保留同 UID 恶意替换 leaf 的竞态边界。
        let text = name(leaf).map_err(|_| "暂存名称无效")?;
        if unsafe { unlinkat(parent.as_raw_fd(), text.as_ptr(), if directory { REMOVEDIR } else { 0 }) } < 0 {
            return Err("通过目录句柄删除暂存项失败".into());
        }
        Ok(())
    }
    pub(super) fn remove_open(parent: &File, leaf: &str, file: File, expected: &Identity) -> Result<()> {
        checked(&file, Some(expected), false)?;
        remove(parent, leaf, expected, false)
    }
    #[cfg(target_os="linux")]
    fn rename_call(parent: &File, from: &CString, to: &CString) -> io::Result<()> {
        extern "C" { fn renameat2(oldfd: i32, old: *const c_char, newfd: i32, new: *const c_char, flags: u32) -> i32; }
        if unsafe { renameat2(parent.as_raw_fd(), from.as_ptr(), parent.as_raw_fd(), to.as_ptr(), 1) } == 0 { Ok(()) }
        else { Err(io::Error::last_os_error()) }
    }
    #[cfg(target_os="android")]
    fn rename_call(parent: &File, from: &CString, to: &CString) -> io::Result<()> {
        // bionic renameat2 从 API 30 才导出；动态查询避免低 API 装载时强链接失败。
        #[link(name="dl")] extern "C" { fn dlsym(handle: *mut c_void, name: *const c_char) -> *mut c_void; }
        type Rename = unsafe extern "C" fn(i32, *const c_char, i32, *const c_char, u32) -> i32;
        // bionic dlfcn.h：LP64 RTLD_DEFAULT=0；LP32 历史 ABI 使用 0xffffffff。
        #[cfg(target_pointer_width="64")] let default = std::ptr::null_mut();
        #[cfg(target_pointer_width="32")] let default = usize::MAX as *mut c_void;
        let symbol = unsafe { dlsym(default, b"renameat2\0".as_ptr().cast()) };
        if symbol.is_null() { return Err(io::Error::from(io::ErrorKind::Unsupported)); }
        let call: Rename = unsafe { std::mem::transmute(symbol) };
        if unsafe { call(parent.as_raw_fd(), from.as_ptr(), parent.as_raw_fd(), to.as_ptr(), 1) } == 0 { Ok(()) }
        else { Err(io::Error::last_os_error()) }
    }
    #[cfg(any(target_os="macos", target_os="ios"))]
    fn rename_call(parent: &File, from: &CString, to: &CString) -> io::Result<()> {
        // Apple xnu bsd/sys/stdio.h：SWAP=2，EXCL=4；这里仅能用 EXCL。
        extern "C" { fn renameatx_np(oldfd: i32, old: *const c_char, newfd: i32, new: *const c_char, flags: u32) -> i32; }
        if unsafe { renameatx_np(parent.as_raw_fd(), from.as_ptr(), parent.as_raw_fd(), to.as_ptr(), 4) } == 0 { Ok(()) }
        else { Err(io::Error::last_os_error()) }
    }
    pub(super) fn rename(parent: &File, file: Option<&File>, from: &str, to: &str, expected: &Identity, directory: bool) -> Result<()> {
        let opened = open(parent, from, NOFOLLOW | CLOEXEC | NONBLOCK | if directory { DIRECTORY } else { 0 }, 0)
            .map_err(|_| "无法打开待发布暂存项")?;
        checked(&opened, Some(expected), directory)?;
        if let Some(file) = file { checked(file, Some(expected), false)?; }
        let old = name(from).map_err(|_| "暂存名称无效")?;
        let new = name(to).map_err(|_| "目标名称无效")?;
        match rename_call(parent, &old, &new) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Err(conflict()),
            Err(error) if error.kind() == io::ErrorKind::Unsupported || matches!(error.raw_os_error(), Some(22 | 38 | 45 | 95 | 102)) => Err(unsupported()),
            Err(_) => Err("目录句柄无覆盖改名失败，暂存已保留".into()),
        }
    }
}

#[cfg(windows)]
mod os {
    use super::*;
    use std::{ffi::c_void, os::windows::io::{AsRawHandle, FromRawHandle}};
    type Handle = *mut c_void;
    #[repr(C)] struct UnicodeString { length: u16, maximum: u16, buffer: *mut u16 }
    #[repr(C)] struct ObjectAttributes { length: u32, root: Handle, name: *mut UnicodeString, attributes: u32, security: *mut c_void, qos: *mut c_void }
    #[repr(C)] struct IoStatus { status: isize, information: usize }
    #[link(name="ntdll")]
    extern "system" {
        fn NtCreateFile(file: *mut Handle, access: u32, attrs: *mut ObjectAttributes, status: *mut IoStatus, allocation: *const i64, attributes: u32, share: u32, disposition: u32, options: u32, ea: *mut c_void, ea_len: u32) -> i32;
        fn RtlNtStatusToDosError(status: i32) -> u32;
        fn NtSetInformationFile(file: Handle, status: *mut IoStatus, info: *mut c_void, length: u32, class: i32) -> i32;
    }
    #[link(name="kernel32")]
    extern "system" { fn SetFileInformationByHandle(file: Handle, class: i32, info: *mut c_void, len: u32) -> i32; }
    fn open(parent: &File, leaf: &str, create: bool, directory: bool, delete: bool, writable: bool) -> io::Result<File> {
        let mut wide = leaf.encode_utf16().collect::<Vec<_>>();
        let length = u16::try_from(wide.len().checked_mul(2).ok_or(io::ErrorKind::InvalidInput)?).map_err(|_| io::ErrorKind::InvalidInput)?;
        let mut unicode = UnicodeString { length, maximum: length, buffer: wide.as_mut_ptr() };
        let mut attrs = ObjectAttributes { length: std::mem::size_of::<ObjectAttributes>() as u32, root: parent.as_raw_handle(), name: &mut unicode, attributes: 0x40, security: std::ptr::null_mut(), qos: std::ptr::null_mut() };
        let mut status = IoStatus { status: 0, information: 0 };
        let mut raw: Handle = std::ptr::null_mut();
        let access = 0x80000000 | 0x00100000 | if writable { 0x40000000 } else { 0 } | if delete { 0x10000 } else { 0 };
        let options = 0x20 | 0x200000 | if directory { 1 } else { 0x40 }; // 同步、OPEN_REPARSE_POINT、明确目录/普通文件。
        // 活目录不共享 DELETE；DELETE 叶句柄也不共享写/删除。读写新文件的后验使用其自身句柄。
        let share = if directory { 3 } else { 1 };
        let result = unsafe { NtCreateFile(&mut raw, access, &mut attrs, &mut status, std::ptr::null(), 0, share, if create { 2 } else { 1 }, options, std::ptr::null_mut(), 0) };
        if result < 0 { return Err(io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(result) } as i32)); }
        Ok(unsafe { File::from_raw_handle(raw) })
    }
    pub(super) fn mkdir(parent: &File, leaf: &str) -> io::Result<File> { open(parent, leaf, true, true, false, false) }
    pub(super) fn new_file(parent: &File, leaf: &str) -> io::Result<File> { open(parent, leaf, true, false, true, true) }
    fn disposition(file: &File) -> Result<()> {
        let mut delete = 1u8;
        if unsafe { SetFileInformationByHandle(file.as_raw_handle(), 4, (&mut delete as *mut u8).cast(), 1) } == 0 {
            return Err("通过暂存句柄删除失败，现场已保留".into());
        }
        Ok(())
    }
    pub(super) fn remove(parent: &File, leaf: &str, expected: &Identity, directory: bool) -> Result<()> {
        let file = open(parent, leaf, false, directory, true, false).map_err(|_| "无法取得待删暂存项的 DELETE 句柄")?;
        checked(&file, Some(expected), directory)?;
        disposition(&file)
    }
    pub(super) fn remove_open(_: &File, _: &str, file: File, expected: &Identity) -> Result<()> {
        checked(&file, Some(expected), false)?;
        disposition(&file)
    }
    #[repr(C)] struct RenameInfo { replace: u8, root: Handle, length: u32, name: [u16; 1] }
    pub(super) fn rename(parent: &File, file: Option<&File>, from: &str, to: &str, expected: &Identity, directory: bool) -> Result<()> {
        let source;
        let handle = if let Some(file) = file { file } else {
            source = open(parent, from, false, directory, true, false).map_err(|_| "无法取得源暂存目录 DELETE 句柄")?;
            &source
        };
        checked(handle, Some(expected), directory)?;
        let wide = to.encode_utf16().collect::<Vec<_>>();
        let offset = std::mem::offset_of!(RenameInfo, name);
        let total = offset.checked_add(wide.len().checked_mul(2).ok_or("目标名称过长")?).ok_or("目标名称过长")?.max(std::mem::size_of::<RenameInfo>());
        let length = u32::try_from(total).map_err(|_| "目标名称过长")?;
        let mut storage = vec![0usize; (total + std::mem::size_of::<usize>() - 1) / std::mem::size_of::<usize>()];
        let info = storage.as_mut_ptr().cast::<RenameInfo>();
        unsafe {
            (*info).replace = 0;
            (*info).root = parent.as_raw_handle();
            (*info).length = u32::try_from(wide.len() * 2).map_err(|_| "目标名称过长")?;
            std::ptr::copy_nonoverlapping(wide.as_ptr(), storage.as_mut_ptr().cast::<u8>().add(offset).cast::<u16>(), wide.len());
            let mut status = IoStatus { status: 0, information: 0 };
            let result = NtSetInformationFile(handle.as_raw_handle(), &mut status, info.cast(), length, 10);
            if result < 0 {
                let code = RtlNtStatusToDosError(result);
                return Err(if matches!(code, 80 | 183) { conflict() } else { format!("句柄无覆盖改名失败，现场已保留（系统错误：{code}）") });
            }
        }
        // 此处不进行可能失败的后验；调用者必须立即记录系统提交。
        Ok(())
    }
}

#[cfg(not(any(windows, target_os="linux", target_os="android", target_os="macos", target_os="ios")))]
mod os {
    use super::*;
    pub(super) fn mkdir(_: &File, _: &str) -> io::Result<File> { Err(io::Error::from(io::ErrorKind::Unsupported)) }
    pub(super) fn new_file(_: &File, _: &str) -> io::Result<File> { Err(io::Error::from(io::ErrorKind::Unsupported)) }
    pub(super) fn remove(_: &File, _: &str, _: &Identity, _: bool) -> Result<()> { Err(unsupported()) }
    pub(super) fn remove_open(_: &File, _: &str, _: File, _: &Identity) -> Result<()> { Err(unsupported()) }
    pub(super) fn rename(_: &File, _: Option<&File>, _: &str, _: &str, _: &Identity, _: bool) -> Result<()> { Err(unsupported()) }
}

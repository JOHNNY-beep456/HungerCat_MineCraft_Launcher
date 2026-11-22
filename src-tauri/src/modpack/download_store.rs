//! 整合包下载的受控暂存；不接受前端路径，也不把缓存路径返回前端。
//! cache_root 必须由宿主直接取自可信 app_cache_dir；仅有 Path 无法证明其来源。
//! 所有方法在后台调用。take_file 交出唯一写句柄，宿主必须等待写 worker 真正
//! flush/sync/drop 后再 seal/cleanup；尤其 Unix 无法证明调用方没有遗留写 FD。
//! 目录身份和 no-follow 用于拒绝换绑与误清理，不是抵抗同权限进程攻击的沙箱。
use super::{access::{leaf, linked, Directory, DirectoryMark, Source}, Result};
use crate::downloads::Cancel;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs::{self, File, Metadata, OpenOptions}, io::{self, Read, Write}, path::{Component, Path}};

const NAMESPACE: &str = "hcmcl-pack-downloads";
const PAYLOAD: &str = "payload";
const OWNER: &str = "owner";
const FILE_CAP: u64 = 2 * 1024 * 1024 * 1024;

fn io_error(_: io::Error) -> String { "整合包下载暂存文件操作失败".into() }

#[derive(Clone, Debug, PartialEq, Eq)]
struct Identity(u64, u64);
#[cfg(unix)]
fn identity(_: &File, metadata: &Metadata) -> Result<Identity> {
    use std::os::unix::fs::MetadataExt;
    Ok(Identity(metadata.dev(), metadata.ino()))
}
#[cfg(windows)]
fn identity(file: &File, _: &Metadata) -> Result<Identity> {
    use std::{ffi::c_void, os::windows::io::AsRawHandle};
    #[repr(C)] struct Info {
        attributes: u32, created: [u32; 2], accessed: [u32; 2], modified: [u32; 2],
        volume: u32, size_high: u32, size_low: u32, links: u32, index_high: u32, index_low: u32,
    }
    #[link(name = "kernel32")]
    extern "system" { fn GetFileInformationByHandle(file: *mut c_void, info: *mut Info) -> i32; }
    let mut info: Info = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err("无法确认下载暂存文件身份".into());
    }
    if info.links != 1 { return Err("下载暂存文件存在未确认硬链接".into()); }
    Ok(Identity(info.volume as u64, (info.index_high as u64) << 32 | info.index_low as u64))
}
#[cfg(not(any(unix, windows)))]
fn identity(_: &File, _: &Metadata) -> Result<Identity> { Err("当前平台无法确认下载暂存身份".into()) }

fn file_identity(file: &File) -> Result<Identity> {
    let metadata = file.metadata().map_err(io_error)?;
    if linked(&metadata) || !metadata.is_file() { return Err("下载暂存不是普通文件".into()); }
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 { return Err("下载暂存文件存在未确认硬链接".into()); }
        if metadata.mode() & 0o777 != 0o600 || metadata.uid() != native::effective_uid() {
            return Err("下载暂存文件权限或所有者已改变".into());
        }
    }
    identity(file, &metadata)
}
fn private_directory(directory: &Directory) -> Result<()> {
    directory.verify()?;
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        let metadata = directory.handle().metadata().map_err(io_error)?;
        if metadata.mode() & 0o777 != 0o700 || metadata.uid() != native::effective_uid() {
            return Err("整合包下载专属目录权限或所有者无效".into());
        }
    }
    Ok(())
}

// 逐级建立，而非 create_dir_all；每次 mkdir 都通过已验证父目录，随后重验全祖先。
fn ensure_child(parent: &Directory, name: &str) -> Result<Directory> {
    leaf(name)?;
    let node = match parent.child(name)? {
        Some(node) => node,
        None => {
            parent.verify()?;
            match native::mkdir(parent.handle(), parent.path(), name) {
                Ok(()) => {},
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {},
                Err(error) => return Err(io_error(error)),
            }
            parent.verify()?;
            parent.child(name)?.ok_or("缓存目录建立后无法确认身份")?
        }
    };
    parent.directory(node)
}
fn cache_directory(path: &Path) -> Result<Directory> {
    if !path.is_absolute() { return Err("缓存根必须是宿主提供的可信绝对路径".into()); }
    let mut root = std::path::PathBuf::new();
    let mut names = Vec::new();
    for part in path.components() {
        match part {
            Component::Prefix(prefix) => {
                #[cfg(windows)] {
                    use std::path::Prefix;
                    if !matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)) {
                        return Err("下载缓存不支持 UNC、网络共享或设备路径".into());
                    }
                }
                root.push(prefix.as_os_str());
            }
            Component::RootDir => root.push(part.as_os_str()),
            Component::Normal(name) => names.push(leaf(name.to_str().ok_or("缓存路径不是有效 UTF-8")?)?.to_owned()),
            _ => return Err("缓存根不能包含相对跳转".into()),
        }
    }
    if names.is_empty() { return Err("不能把磁盘根目录用作应用下载缓存".into()); }
    let mut directory = Directory::open(&root)?;
    for name in names { directory = ensure_child(&directory, &name)?; }
    let directory = ensure_child(&directory, NAMESPACE)?;
    private_directory(&directory)?;
    Ok(directory)
}

pub(super) struct Stage {
    parent: Directory,
    name: String,
    directory: Option<Directory>,
    directory_mark: Option<DirectoryMark>,
    created: bool,
    owner_text: String,
    owner_identity: Option<Identity>,
    owner_source: Option<Source>,
    payload_identity: Option<Identity>,
    file: Option<File>,
    sealed: Option<Source>,
}
impl Stage {
    pub(super) fn create(cache_root: &Path) -> Result<Self> {
        let parent = cache_directory(cache_root)?;
        let token = uuid::Uuid::new_v4().to_string();
        let mut stage = Self {
            parent, name: token.clone(), directory: None, directory_mark: None, created: false,
            owner_text: format!("hcmcl-pack-download-v1\n{token}\n"), owner_identity: None,
            owner_source: None, payload_identity: None, file: None, sealed: None,
        };
        if let Err(error) = stage.initialize() {
            // 初始化失败时也不按路径猜测所有权；未确认清理必须让宿主保留 busy。
            return match stage.cleanup() {
                Ok(()) => Err(error),
                Err(cleanup) => Err(format!("{error}；暂存清理未确认：{cleanup}")),
            };
        }
        Ok(stage)
    }
    fn initialize(&mut self) -> Result<()> {
        self.parent.verify()?;
        native::mkdir(self.parent.handle(), self.parent.path(), &self.name).map_err(io_error)?;
        self.created = true;
        let node = self.parent.child(&self.name)?.ok_or("下载暂存目录建立后已改变")?;
        let directory = self.parent.directory(node)?;
        self.directory_mark = Some(directory.mark());
        self.directory = Some(directory);
        let directory = self.directory()?;
        private_directory(directory)?;
        let mut owner = native::new_file(directory.handle(), directory.path(), OWNER)?;
        self.owner_identity = Some(file_identity(&owner)?);
        owner.write_all(self.owner_text.as_bytes()).map_err(io_error)?;
        owner.flush().map_err(io_error)?;
        owner.sync_all().map_err(io_error)?;
        drop(owner);
        let owner_source = self.directory()?.source(OWNER)?;
        self.owner_source = Some(owner_source);
        let directory = self.directory()?;
        let file = native::new_file(directory.handle(), directory.path(), PAYLOAD)?;
        self.payload_identity = Some(file_identity(&file)?);
        self.file = Some(file);
        self.verify_owner()?;
        Ok(())
    }
    fn directory(&self) -> Result<&Directory> {
        if !self.created { return Err("下载暂存已经清理".into()); }
        self.directory.as_ref().ok_or_else(|| "下载暂存目录句柄不可用".into())
    }
    fn verify_owner(&self) -> Result<()> {
        self.parent.verify()?;
        let directory = self.directory()?;
        private_directory(directory)?;
        let source = self.owner_source.as_ref().ok_or("下载暂存 owner 未完整写入，拒绝猜测所有权")?;
        let mut opened = source.open()?;
        if Some(&file_identity(&opened.file)?) != self.owner_identity.as_ref() {
            return Err("下载暂存 owner 身份已改变".into());
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut opened.file).take(128).read_to_end(&mut bytes).map_err(io_error)?;
        opened.verify()?;
        if bytes != self.owner_text.as_bytes() { return Err("下载暂存 owner 不匹配".into()); }
        Ok(())
    }
    fn verify_payload(&self) -> Result<()> {
        self.verify_owner()?;
        let directory = self.directory()?;
        let file = native::existing(directory.handle(), directory.path(), PAYLOAD)?;
        if Some(&file_identity(&file)?) != self.payload_identity.as_ref() {
            return Err("下载暂存 payload 身份已改变".into());
        }
        directory.verify()
    }
    pub(super) fn take_file(&mut self) -> Result<File> {
        if self.sealed.is_some() { return Err("已封存下载不能再次写入".into()); }
        self.verify_owner()?;
        self.file.take().ok_or_else(|| "下载写句柄已经交出或暂存已关闭".into())
    }
    pub(super) fn payload_sha256(&self, cancel: &Cancel) -> Result<String> {
        cancel.check()?;
        if self.file.is_some() { return Err("下载写句柄尚未关闭，不能计算摘要".into()); }
        self.verify_payload()?;
        let source = self.directory()?.source(PAYLOAD)?;
        if source.len() == 0 || source.len() > FILE_CAP { return Err("下载暂存大小无效".into()); }
        let mut opened = source.open()?;
        let mut digest = Sha256::new();
        let mut total = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            cancel.check()?;
            let count = opened.file.read(&mut buffer).map_err(io_error)?;
            if count == 0 { break; }
            total = total.checked_add(count as u64).filter(|value| *value <= source.len()).ok_or("下载暂存在摘要校验期间增大")?;
            digest.update(&buffer[..count]);
        }
        cancel.check()?;
        opened.verify()?;
        self.verify_payload()?;
        if total != source.len() { return Err("下载暂存大小在摘要校验期间改变".into()); }
        Ok(format!("{:x}", digest.finalize()))
    }
    pub(super) fn seal(&mut self, bytes: u64, sha256: &str) -> Result<()> {
        if self.sealed.is_some() { return Err("下载暂存已经封存".into()); }
        if self.file.is_some() { return Err("下载写句柄尚未交给后台 writer".into()); }
        if bytes == 0 || bytes > FILE_CAP { return Err("下载归档必须大于零且不超过 2 GiB".into()); }
        if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("下载 SHA-256 必须为完整的 64 位十六进制摘要".into());
        }
        self.verify_payload()?;
        let source = self.directory()?.source(PAYLOAD)?;
        if source.len() != bytes { return Err("下载实际大小与传输记录不一致".into()); }
        let mut opened = source.open()?;
        let mut digest = Sha256::new();
        let mut actual = 0u64;
        let mut buffer = [0u8; 65_536];
        loop {
            let count = opened.file.read(&mut buffer).map_err(io_error)?;
            if count == 0 { break; }
            actual = actual.checked_add(count as u64).filter(|size| *size <= bytes && *size <= FILE_CAP)
                .ok_or("下载文件在封存期间增大")?;
            digest.update(&buffer[..count]);
        }
        opened.verify()?;
        if actual != bytes || format!("{:x}", digest.finalize()) != sha256.to_ascii_lowercase() {
            return Err("下载完整 SHA-256 或大小校验失败".into());
        }
        drop(opened);
        source.verify()?;
        self.verify_payload()?;
        self.sealed = Some(source);
        Ok(())
    }
    /// 仅供后台同步读取；调用方必须在整个回调期间持有 Stage，不能外借路径或文件句柄。
    pub(super) fn read_archive<T>(&self, cancel: &Cancel, read: impl FnOnce(&mut File) -> Result<T>) -> Result<T> {
        cancel.check()?;
        self.verify_payload()?;
        let source = self.sealed.as_ref().ok_or("下载尚未通过完整校验，不能读取归档")?;
        let mut opened = source.open()?;
        let result = read(&mut opened.file);
        // 即使解析返回错误，也完成取消与身份检查，不把读取期间的改变当作可信结果。
        cancel.check()?;
        opened.verify()?;
        self.verify_payload()?;
        result
    }
    /// 已认领读取同时检查能力取消和导入取消。
    /// Stage 会在回调 I/O 前后复核源文件与目录身份。
    pub(super) fn read_claimed_archive<T>(&self, capability_cancel: &Cancel, parent_cancel: &Cancel, read: impl FnOnce(&mut File) -> Result<T>) -> Result<T> {
        capability_cancel.check()?;
        parent_cancel.check()?;
        self.read_archive(capability_cancel, |file| {
            parent_cancel.check()?;
            let value = read(file)?;
            parent_cancel.check()?;
            Ok(value)
        })
    }
    #[cfg(test)]
    pub(super) fn test_directory_path(&self) -> Result<std::path::PathBuf> {
        Ok(self.directory()?.path().to_path_buf())
    }
    pub(super) fn probe(&self, cancel: &Cancel) -> Result<Value> {
        // 不走 picker：本归档来自宿主拥有的下载能力。注册表另存原始文件名；这里不泄露路径。
        self.read_archive(cancel, |file| super::parser::probe(file, Path::new("整合包")))
    }
    pub(super) fn cleanup(&mut self) -> Result<()> {
        // 未交出的写句柄也必须先真正关闭，Windows 才允许后续重开和删除。
        drop(self.file.take());
        if !self.created { return Ok(()); }
        self.parent.verify()?;
        if self.directory.is_none() {
            self.directory = Some(self.directory_mark.as_ref().ok_or("暂存目录身份未确认，拒绝清理")?.open()?);
        }
        let directory = self.directory()?;
        private_directory(directory)?;
        let mut budget = 4;
        let names = directory.names(&mut budget)?;
        let expected: Vec<&str> = [OWNER, PAYLOAD].into_iter().filter(|name| {
            if *name == OWNER { self.owner_identity.is_some() } else { self.payload_identity.is_some() }
        }).collect();
        if names.iter().any(|name| !expected.contains(&name.as_str())) {
            return Err("下载暂存含未知子节点，拒绝删除任何内容".into());
        }
        if self.owner_identity.is_some() { self.verify_owner()?; }
        if self.payload_identity.is_some() { self.verify_payload()?; }
        if self.payload_identity.is_some() {
            let directory = self.directory()?;
            native::unlink(directory.handle(), directory.path(), PAYLOAD, false)?;
            self.payload_identity = None;
            self.sealed = None;
        }
        if self.owner_identity.is_some() {
            // payload 删除后仍独立核对 owner；不把已删 payload 当成 owner 授权的一部分。
            self.verify_owner()?;
            let directory = self.directory()?;
            native::unlink(directory.handle(), directory.path(), OWNER, false)?;
            self.owner_identity = None;
            self.owner_source = None;
        }
        let directory = self.directory()?;
        let mut budget = 1;
        if !directory.names(&mut budget)?.is_empty() { return Err("下载暂存未清空，拒绝递归清理".into()); }
        directory.verify()?;
        // Directory 的 Windows 句柄不共享 DELETE；先关本目录，再经仍持有的父目录精确删除。
        drop(self.directory.take());
        self.parent.verify()?;
        self.directory_mark.as_ref().ok_or("暂存目录身份未确认")?.verify()?;
        native::unlink(self.parent.handle(), self.parent.path(), &self.name, true)?;
        self.created = false;
        self.directory_mark = None;
        Ok(())
    }
}
impl Drop for Stage {
    fn drop(&mut self) {
        // Drop 无法向宿主确认结果；宿主应先显式 cleanup，失败时继续持有 Stage/busy。
        let _ = self.cleanup();
    }
}

#[cfg(unix)]
mod native {
    use super::*;
    use std::{ffi::CString, os::{fd::{AsRawFd, FromRawFd}, raw::c_char}};
    #[cfg(any(target_os = "macos", target_os = "ios"))] const NOFOLLOW: i32 = 0x100;
    #[cfg(all(target_os = "android", any(target_arch = "arm", target_arch = "aarch64")))] const NOFOLLOW: i32 = 0x8000;
    #[cfg(not(any(target_os = "macos", target_os = "ios", all(target_os = "android", any(target_arch = "arm", target_arch = "aarch64")))))] const NOFOLLOW: i32 = 0x20000;
    #[cfg(any(target_os = "macos", target_os = "ios"))] const CLOEXEC: i32 = 0x1000000;
    #[cfg(not(any(target_os = "macos", target_os = "ios")))] const CLOEXEC: i32 = 0x80000;
    #[cfg(any(target_os = "macos", target_os = "ios"))] const NONBLOCK: i32 = 4;
    #[cfg(not(any(target_os = "macos", target_os = "ios")))] const NONBLOCK: i32 = 0x800;
    #[cfg(any(target_os = "macos", target_os = "ios"))] const CREATE_EXCL: i32 = 0x200 | 0x800;
    #[cfg(not(any(target_os = "macos", target_os = "ios")))] const CREATE_EXCL: i32 = 0x40 | 0x80;
    extern "C" {
        fn openat(fd: i32, name: *const c_char, flags: i32, ...) -> i32;
        fn mkdirat(fd: i32, name: *const c_char, mode: u32) -> i32;
        fn unlinkat(fd: i32, name: *const c_char, flags: i32) -> i32;
        fn geteuid() -> u32;
    }
    pub(super) fn effective_uid() -> u32 { unsafe { geteuid() } }
    fn name(value: &str) -> Result<CString> { CString::new(leaf(value)?).map_err(|_| "下载暂存名称无效".into()) }
    pub(super) fn mkdir(parent: &File, _: &Path, value: &str) -> io::Result<()> {
        let name = CString::new(value).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        if unsafe { mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } < 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
    }
    pub(super) fn new_file(parent: &File, _: &Path, value: &str) -> Result<File> {
        let name = name(value)?;
        let fd = unsafe { openat(parent.as_raw_fd(), name.as_ptr(), 1 | CREATE_EXCL | NOFOLLOW | CLOEXEC, 0o600u32) };
        if fd < 0 { Err(io_error(io::Error::last_os_error())) } else { Ok(unsafe { File::from_raw_fd(fd) }) }
    }
    pub(super) fn existing(parent: &File, _: &Path, value: &str) -> Result<File> {
        let name = name(value)?;
        let fd = unsafe { openat(parent.as_raw_fd(), name.as_ptr(), NOFOLLOW | CLOEXEC | NONBLOCK) };
        if fd < 0 { Err(io_error(io::Error::last_os_error())) } else { Ok(unsafe { File::from_raw_fd(fd) }) }
    }
    pub(super) fn unlink(parent: &File, _: &Path, value: &str, directory: bool) -> Result<()> {
        let name = name(value)?;
        #[cfg(any(target_os = "macos", target_os = "ios"))] let remove_dir = 0x80;
        #[cfg(not(any(target_os = "macos", target_os = "ios")))] let remove_dir = 0x200;
        if unsafe { unlinkat(parent.as_raw_fd(), name.as_ptr(), if directory { remove_dir } else { 0 }) } < 0 {
            Err(io_error(io::Error::last_os_error()))
        } else { Ok(()) }
    }
}
#[cfg(windows)]
mod native {
    use super::*;
    use std::os::windows::fs::OpenOptionsExt;
    pub(super) fn mkdir(_: &File, parent: &Path, name: &str) -> io::Result<()> { fs::create_dir(parent.join(name)) }
    pub(super) fn new_file(_: &File, parent: &Path, name: &str) -> Result<File> {
        // 交出后不在 Stage 留副本；share=0 使 seal/cleanup 无法越过尚未结束的写句柄。
        OpenOptions::new().write(true).create_new(true).share_mode(0).custom_flags(0x00200000)
            .open(parent.join(leaf(name)?)).map_err(io_error)
    }
    pub(super) fn existing(_: &File, parent: &Path, name: &str) -> Result<File> {
        OpenOptions::new().read(true).share_mode(1).custom_flags(0x00200000)
            .open(parent.join(leaf(name)?)).map_err(io_error)
    }
    pub(super) fn unlink(_: &File, parent: &Path, name: &str, directory: bool) -> Result<()> {
        let path = parent.join(leaf(name)?);
        if directory { fs::remove_dir(path) } else { fs::remove_file(path) }.map_err(io_error)
    }
}
#[cfg(not(any(unix, windows)))]
mod native {
    use super::*;
    pub(super) fn mkdir(_: &File, _: &Path, _: &str) -> io::Result<()> { Err(io::Error::from(io::ErrorKind::Unsupported)) }
    pub(super) fn new_file(_: &File, _: &Path, _: &str) -> Result<File> { Err("当前平台不支持安全下载暂存".into()) }
    pub(super) fn existing(_: &File, _: &Path, _: &str) -> Result<File> { Err("当前平台不支持安全下载暂存".into()) }
    pub(super) fn unlink(_: &File, _: &Path, _: &str, _: bool) -> Result<()> { Err("当前平台不支持安全下载暂存".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Cursor, path::PathBuf};
    use zip::{write::FileOptions, CompressionMethod, ZipWriter};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("hcmcl-pack-download-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
        fn cache(&self) -> PathBuf { self.0.join("missing/cache") }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    fn archive() -> Vec<u8> {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file("launcher.packmeta", FileOptions::default().compression_method(CompressionMethod::Stored)).unwrap();
        zip.write_all(br#"{"name":"download fixture","game_version":"1.21.1","mod_loader":"vanilla"}"#).unwrap();
        zip.start_file("overrides/config/example.txt", FileOptions::default().compression_method(CompressionMethod::Stored)).unwrap();
        zip.write_all(b"fixture data").unwrap();
        zip.finish().unwrap().into_inner()
    }
    fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
    fn write_download(stage: &mut Stage, bytes: &[u8]) {
        let mut file = stage.take_file().unwrap();
        file.write_all(bytes).unwrap();
        file.flush().unwrap();
        file.sync_all().unwrap();
        drop(file);
    }
    fn private_path(stage: &Stage) -> PathBuf { stage.directory().unwrap().path().to_path_buf() }

    #[test]
    fn real_zip_seals_and_probes_without_exposing_cache_paths_or_picker_authority() {
        let fixture = Fixture::new();
        let outside = fixture.0.join("source.zip");
        let bytes = archive();
        fs::write(&outside, &bytes).unwrap();
        let mut stage = Stage::create(&fixture.cache()).unwrap();
        let path = private_path(&stage);
        assert_eq!(fs::read_dir(&path).unwrap().count(), 2);
        assert!(stage.probe(&Cancel::default()).is_err());
        write_download(&mut stage, &bytes);
        stage.seal(bytes.len() as u64, &digest(&bytes).to_ascii_uppercase()).unwrap();
        assert!(stage.take_file().is_err());
        assert!(stage.seal(bytes.len() as u64, &digest(&bytes)).is_err());
        let value = stage.probe(&Cancel::default()).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 6);
        assert_eq!(value["format"], "native");
        assert_eq!(value["name"], "download fixture");
        assert_eq!(value["mcVersion"], "1.21.1");
        assert!(!value.to_string().contains(&fixture.0.to_string_lossy().to_string()));
        let stopped = Cancel::default();
        stopped.stop();
        assert!(stage.probe(&stopped).is_err());
        stage.cleanup().unwrap();
        stage.cleanup().unwrap();
        assert!(!path.exists());
        assert_eq!(fs::read(outside).unwrap(), bytes);
    }

    #[test]
    fn archive_reader_rechecks_cancellation_after_real_parsing() {
        let fixture = Fixture::new();
        let bytes = archive();
        let mut stage = Stage::create(&fixture.cache()).unwrap();
        let cancel = Cancel::default();
        let mut called = false;
        assert!(stage.read_archive(&cancel, |_| { called = true; Ok(()) }).is_err());
        assert!(!called);
        write_download(&mut stage, &bytes);
        stage.seal(bytes.len() as u64, &digest(&bytes)).unwrap();
        let result = stage.read_archive(&cancel, |file| {
            let (_, manifest) = super::super::parser::open_validated(file)?;
            assert_eq!(manifest.name, "launcher.packmeta");
            cancel.stop();
            Ok("不能交付迟到结果")
        });
        assert!(result.is_err());
        stage.cleanup().unwrap();
    }

    #[test]
    fn full_hash_size_and_nonempty_limits_are_enforced_before_sealing() {
        let fixture = Fixture::new();
        let bytes = archive();
        let mut stage = Stage::create(&fixture.cache()).unwrap();
        write_download(&mut stage, &bytes);
        assert!(stage.seal(0, &digest(&bytes)).is_err());
        assert!(stage.seal(FILE_CAP + 1, &digest(&bytes)).is_err());
        assert!(stage.seal(bytes.len() as u64, &"a".repeat(63)).is_err());
        assert!(stage.seal(bytes.len() as u64, &"z".repeat(64)).is_err());
        assert!(stage.seal(bytes.len() as u64 + 1, &digest(&bytes)).is_err());
        assert!(stage.seal(bytes.len() as u64, &"0".repeat(64)).is_err());
        assert!(stage.probe(&Cancel::default()).is_err());
        stage.seal(bytes.len() as u64, &digest(&bytes)).unwrap();
        stage.cleanup().unwrap();
    }

    #[test]
    fn sealed_source_stamp_rejects_later_writes_and_invalid_zip_stays_unprobed() {
        let fixture = Fixture::new();
        let bytes = archive();
        let mut stage = Stage::create(&fixture.cache()).unwrap();
        write_download(&mut stage, &bytes);
        stage.seal(bytes.len() as u64, &digest(&bytes)).unwrap();
        let path = private_path(&stage);
        let mut changed = OpenOptions::new().append(true).open(path.join(PAYLOAD)).unwrap();
        changed.write_all(b"changed after seal").unwrap();
        changed.sync_all().unwrap();
        drop(changed);
        assert!(stage.probe(&Cancel::default()).is_err());
        // 封存后的同 inode 内容变化不是外部所有权；仍只能精确清理本任务节点。
        stage.cleanup().unwrap();
        let mut invalid = Stage::create(&fixture.cache()).unwrap();
        write_download(&mut invalid, b"not a zip archive");
        invalid.seal(17, &digest(b"not a zip archive")).unwrap();
        assert!(invalid.probe(&Cancel::default()).is_err());
        invalid.cleanup().unwrap();
    }

    #[test]
    fn payload_replacement_is_not_sealed_probed_or_deleted() {
        let fixture = Fixture::new();
        let bytes = archive();
        let mut stage = Stage::create(&fixture.cache()).unwrap();
        write_download(&mut stage, &bytes);
        let path = private_path(&stage);
        let moved = fixture.0.join("original-payload");
        fs::rename(path.join(PAYLOAD), &moved).unwrap();
        let directory = stage.directory().unwrap();
        let mut replacement = native::new_file(directory.handle(), directory.path(), PAYLOAD).unwrap();
        replacement.write_all(&bytes).unwrap();
        replacement.sync_all().unwrap();
        drop(replacement);
        assert!(stage.seal(bytes.len() as u64, &digest(&bytes)).is_err());
        assert!(stage.probe(&Cancel::default()).is_err());
        assert!(stage.cleanup().is_err());
        assert_eq!(fs::read(path.join(PAYLOAD)).unwrap(), bytes);
        assert!(path.join(OWNER).exists());
        drop(stage);
        assert_eq!(fs::read(moved).unwrap(), bytes);
        assert_eq!(fs::read(path.join(PAYLOAD)).unwrap(), bytes);
    }

    #[test]
    fn unknown_children_and_modified_owner_preserve_payload_and_external_sources() {
        let fixture = Fixture::new();
        let bytes = archive();
        let source = fixture.0.join("keep-source");
        fs::write(&source, b"never delete source").unwrap();
        let mut stage = Stage::create(&fixture.cache()).unwrap();
        write_download(&mut stage, &bytes);
        let path = private_path(&stage);
        fs::write(path.join("unexpected"), b"keep").unwrap();
        assert!(stage.cleanup().unwrap_err().contains("未知子节点"));
        assert!(path.join(PAYLOAD).exists());
        assert!(path.join(OWNER).exists());
        assert_eq!(fs::read(path.join("unexpected")).unwrap(), b"keep");
        fs::remove_file(path.join("unexpected")).unwrap();
        fs::write(path.join(OWNER), b"different owner").unwrap();
        assert!(stage.cleanup().is_err());
        assert!(path.join(PAYLOAD).exists());
        drop(stage);
        assert_eq!(fs::read(source).unwrap(), b"never delete source");
        assert_eq!(fs::read(path.join(OWNER)).unwrap(), b"different owner");
    }

    #[test]
    fn cleanup_closes_its_own_file_and_repeated_cleanup_is_safe() {
        let fixture = Fixture::new();
        let mut stage = Stage::create(&fixture.cache()).unwrap();
        let path = private_path(&stage);
        stage.cleanup().unwrap();
        stage.cleanup().unwrap();
        assert!(!path.exists());
        assert!(stage.take_file().is_err());
        assert!(stage.probe(&Cancel::default()).is_err());
        let mut writing = Stage::create(&fixture.cache()).unwrap();
        let path = private_path(&writing);
        let bytes = archive();
        let mut file = writing.take_file().unwrap();
        file.write_all(&bytes).unwrap();
        file.sync_all().unwrap();
        #[cfg(windows)] {
            assert!(writing.seal(bytes.len() as u64, &digest(&bytes)).is_err());
            assert!(writing.cleanup().is_err());
            assert!(path.join(PAYLOAD).exists());
        }
        // Unix 调用约定也要求真实关闭后才能 seal/cleanup；不伪造遗留 FD 检测能力。
        drop(file);
        writing.seal(bytes.len() as u64, &digest(&bytes)).unwrap();
        writing.cleanup().unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn invalid_cache_roots_and_hardlinked_payloads_are_rejected() {
        assert!(Stage::create(Path::new("relative/cache")).is_err());
        let fixture = Fixture::new();
        // Windows verbatim PathBuf::push/join 会提前规范化 ..；直接拼 OsString 保留待验证输入。
        let mut raw = fixture.0.as_os_str().to_os_string();
        raw.push(std::path::MAIN_SEPARATOR_STR);
        raw.push("a"); raw.push(std::path::MAIN_SEPARATOR_STR);
        raw.push(".."); raw.push(std::path::MAIN_SEPARATOR_STR); raw.push("cache");
        let noncanonical = PathBuf::from(raw);
        assert!(noncanonical.components().any(|part| matches!(part, Component::ParentDir)));
        assert!(Stage::create(&noncanonical).is_err());
        #[cfg(windows)] {
            for path in [r"\\server\share\cache", r"\\?\UNC\server\share\cache", r"\\.\C:\cache"] {
                assert!(Stage::create(Path::new(path)).is_err());
            }
        }
        let bytes = archive();
        let mut stage = Stage::create(&fixture.cache()).unwrap();
        write_download(&mut stage, &bytes);
        let path = private_path(&stage);
        let alias = fixture.0.join("external-alias");
        fs::hard_link(path.join(PAYLOAD), &alias).unwrap();
        assert!(stage.seal(bytes.len() as u64, &digest(&bytes)).is_err());
        assert!(stage.cleanup().is_err());
        assert_eq!(fs::read(&alias).unwrap(), bytes);
        fs::remove_file(&alias).unwrap();
        stage.cleanup().unwrap();
    }

    #[test]
    fn held_ancestor_cannot_rebind_cleanup_to_another_directory() {
        let fixture = Fixture::new();
        let bytes = archive();
        let mut stage = Stage::create(&fixture.cache()).unwrap();
        write_download(&mut stage, &bytes);
        stage.seal(bytes.len() as u64, &digest(&bytes)).unwrap();
        let parent = fixture.cache().join(NAMESPACE);
        let moved = fixture.cache().join("moved-downloads");
        #[cfg(windows)] {
            assert!(fs::rename(&parent, &moved).is_err());
            stage.cleanup().unwrap();
        }
        #[cfg(unix)] {
            fs::rename(&parent, &moved).unwrap();
            let replacement = parent.join(&stage.name);
            fs::create_dir_all(&replacement).unwrap();
            fs::write(replacement.join(PAYLOAD), b"concurrent winner").unwrap();
            assert!(stage.probe(&Cancel::default()).is_err());
            assert!(stage.cleanup().is_err());
            drop(stage);
            assert_eq!(fs::read(replacement.join(PAYLOAD)).unwrap(), b"concurrent winner");
            assert_eq!(fs::read(moved.join(fs::read_dir(&moved).unwrap().next().unwrap().unwrap().file_name()).join(PAYLOAD)).unwrap(), bytes);
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_cache_ancestors_and_payload_are_refused_without_deleting_sources() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let outside = fixture.0.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("source"), b"keep").unwrap();
        symlink(&outside, fixture.0.join("linked")).unwrap();
        assert!(Stage::create(&fixture.0.join("linked/cache")).is_err());
        let mut stage = Stage::create(&fixture.cache()).unwrap();
        drop(stage.take_file().unwrap());
        let path = private_path(&stage);
        fs::remove_file(path.join(PAYLOAD)).unwrap();
        symlink(outside.join("source"), path.join(PAYLOAD)).unwrap();
        assert!(stage.cleanup().is_err());
        drop(stage);
        assert_eq!(fs::read(outside.join("source")).unwrap(), b"keep");
        assert!(fs::symlink_metadata(path.join(PAYLOAD)).unwrap().file_type().is_symlink());
    }
}

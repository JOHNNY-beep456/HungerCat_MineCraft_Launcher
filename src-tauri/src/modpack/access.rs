//! 只读句柄与路径约束；不创建目录，也不通过符号链接读取目标。
use super::Result;
use std::{fs::{self, File, Metadata, OpenOptions}, io, path::{Component, Path, PathBuf}, sync::Arc, time::SystemTime};

pub(super) fn leaf(name: &str) -> Result<&str> {
    if name.is_empty() || name.len() > 240 || name.trim() != name || name.ends_with('.')
        || matches!(name, "." | "..") || name.chars().any(|c| c.is_control() || "\\/:*?\"<>|".contains(c)) {
        return Err("整合包路径含不安全名称".into());
    }
    let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$"].contains(&stem.as_str())
        || ["COM", "LPT"].iter().any(|prefix| stem.strip_prefix(*prefix).map(|n| ["1","2","3","4","5","6","7","8","9","¹","²","³"].contains(&n)).unwrap_or(false)) {
        return Err("整合包路径不能使用系统设备名称".into());
    }
    Ok(name)
}

pub(super) fn linked(meta: &Metadata) -> bool {
    if meta.file_type().is_symlink() { return true; }
    #[cfg(windows)] { use std::os::windows::fs::MetadataExt; if meta.file_attributes() & 0x400 != 0 { return true; } }
    false
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Identity { volume: u64, index: u64 }
#[cfg(unix)]
fn identity(_: &File, meta: &Metadata) -> Result<Identity> {
    use std::os::unix::fs::MetadataExt;
    Ok(Identity { volume: meta.dev(), index: meta.ino() })
}
#[cfg(windows)]
fn identity(file: &File, _: &Metadata) -> Result<Identity> {
    use std::{ffi::c_void, os::windows::io::AsRawHandle};
    #[repr(C)] struct Info { attributes:u32, created:[u32;2], accessed:[u32;2], modified:[u32;2], volume:u32, size_high:u32, size_low:u32, links:u32, high:u32, low:u32 }
    #[link(name="kernel32")] extern "system" { fn GetFileInformationByHandle(handle:*mut c_void, info:*mut Info)->i32; }
    let mut info: Info = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 { return Err("无法确认整合包文件身份".into()); }
    if !file.metadata().map_err(|_| "无法确认整合包文件状态")?.is_dir() && info.links != 1 { return Err("拒绝多硬链接文件".into()); }
    Ok(Identity { volume: info.volume as u64, index: (info.high as u64) << 32 | info.low as u64 })
}
#[cfg(not(any(unix, windows)))]
fn identity(_: &File, _: &Metadata) -> Result<Identity> { Err("当前平台不支持只读文件身份检查".into()) }

fn checked_meta(file: &File) -> Result<Metadata> {
    let meta = file.metadata().map_err(|_| "无法读取整合包文件状态")?;
    if linked(&meta) || !(meta.is_dir() || meta.is_file()) { return Err("拒绝链接或特殊文件".into()); }
    #[cfg(unix)] { use std::os::unix::fs::MetadataExt; if meta.is_file() && meta.nlink() != 1 { return Err("拒绝多硬链接文件".into()); } }
    Ok(meta)
}

#[derive(Clone)]
struct Anchor { path: PathBuf, file: Arc<File>, identity: Identity, alias: bool }
#[derive(Clone)]
pub(super) struct Directory { path: PathBuf, anchors: Vec<Anchor> }
impl Directory {
    pub(super) fn open(path: &Path) -> Result<Self> {
        Self::open_exact(path).or_else(|error| match crate::path_alias::resolved_alias(path) {
            // 系统别名落在末级时，规范化一次再复核；仍然失败则保留原始错误。
            Some(canonical) => Self::open_exact(&canonical).map_err(|_| error),
            None => Err(error),
        })
    }
    fn open_exact(path: &Path) -> Result<Self> {
        if !path.is_absolute() { return Err("整合包目录必须为绝对路径".into()); }
        let mut current = PathBuf::new();
        let mut anchors: Vec<Anchor> = Vec::new();
        let mut parts = path.components().peekable();
        while let Some(part) = parts.next() {
            // 只有末级是启动器自己定位并创建的对象；祖先前缀在 Android 上可能由系统
            // 维护成别名软链接（`/data/user/0` ↔ `/data/data`），见 `crate::path_alias`。
            let final_segment = parts.peek().is_none();
            match part {
                Component::Prefix(prefix) => {
                    #[cfg(windows)] { use std::path::Prefix; if !matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)) { return Err("不支持网络共享或设备目录".into()); } }
                    current.push(prefix.as_os_str());
                }
                Component::RootDir => {
                    current.push(part.as_os_str());
                    let file = native::root(&current, false).map_err(|_| "无法打开整合包根目录")?;
                    anchors.push(anchor_of(file, &current, false)?);
                }
                Component::Normal(name) => {
                    let name = leaf(name.to_str().ok_or("路径不是有效 UTF-8")?)?;
                    let parent = anchors.last().ok_or("缺少整合包根目录")?;
                    current.push(name);
                    let follow = !final_segment && crate::path_alias::ancestor_alias_allowed();
                    let file = native::child(&parent.file, &current, name, follow).map_err(|_| "无法打开现存整合包目录")?;
                    anchors.push(anchor_of(file, &current, follow)?);
                }
                _ => return Err("整合包路径不得包含相对跳转".into()),
            }
        }
        if anchors.is_empty() { return Err("整合包目录无效".into()); }
        let result = Self { path: current, anchors };
        result.verify()?;
        Ok(result)
    }
    pub(super) fn verify(&self) -> Result<()> {
        for anchor in &self.anchors {
            let meta = fs::symlink_metadata(&anchor.path).map_err(|_| "整合包目录已改变")?;
            if meta.file_type().is_symlink() {
                // 仅祖先前缀允许是系统别名；末级（`alias == false`）永远是真实目录。
                if !anchor.alias { return Err("整合包目录已改变或成为链接".into()); }
            } else if !meta.is_dir() {
                return Err("整合包目录已改变或成为链接".into());
            }
            let current = native::root(&anchor.path, anchor.alias).map_err(|_| "无法重验整合包目录")?;
            if identity(&current, &checked_meta(&current)?)? != anchor.identity { return Err("整合包目录身份已改变".into()); }
        }
        Ok(())
    }
    pub(super) fn path(&self) -> &Path { &self.path }
    pub(super) fn handle(&self) -> &File { &self.anchors.last().expect("已验证非空目录链").file }
    pub(super) fn mark(&self)->DirectoryMark {DirectoryMark{path:self.path.clone(),identities:self.anchors.iter().map(|anchor|anchor.identity.clone()).collect()}}
    pub(super) fn source(&self, name: &str) -> Result<Source> {
        let node=self.child(name)?.ok_or("导出源文件不存在")?;
        if !node.meta.is_file(){return Err("导出源不是普通文件".into());}
        Ok(Source {directory:self.mark(),name:name.to_owned(),stamp:node.stamp})
    }
    fn clone_anchors(&self) -> Vec<Anchor> { self.anchors.clone() }
    pub(super) fn child(&self, name: &str) -> Result<Option<Node>> {
        leaf(name)?;
        self.verify()?;
        let path = self.path.join(name);
        let file = match native::child(self.handle(), &path, name, false) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => { self.verify()?; return Ok(None); }
            Err(_) => return Err("无法安全读取实例内容；链接或特殊文件不受支持".into()),
        };
        let meta = checked_meta(&file)?;
        let stamp = Stamp::new(&file, &meta)?;
        self.verify()?;
        let node=Node { path, file, meta, stamp };
        node.verify()?;
        Ok(Some(node))
    }
    pub(super) fn directory(&self, node: Node) -> Result<Self> {
        if !node.meta.is_dir() { return Err("实例内容不是目录".into()); }
        node.verify()?;
        let mut anchors = self.clone_anchors();
        anchors.push(Anchor { path: node.path.clone(), identity: node.stamp.identity, file: Arc::new(node.file), alias: false });
        let result = Self { path: node.path, anchors };
        result.verify()?;
        Ok(result)
    }
    pub(super) fn names(&self, budget: &mut usize) -> Result<Vec<String>> {
        self.verify()?;
        let mut names = Vec::new();
        let mut folded = std::collections::BTreeSet::new();
        for entry in native::names(self.handle(), &self.path).map_err(|_| "无法通过现存目录句柄读取实例内容")? {
            if *budget == 0 { return Err("实例内容超过遍历预算".into()); }
            *budget -= 1;
            let name = entry.map_err(|_| "读取实例内容条目失败")?.into_string().map_err(|_| "实例内容名称不是有效 UTF-8")?;
            leaf(&name)?;
            if !folded.insert(name.to_lowercase()) { return Err("实例内容存在大小写别名冲突".into()); }
            names.push(name);
        }
        self.verify()?;
        names.sort();
        Ok(names)
    }
}

/// 校验刚打开的一级目录并登记其身份；`alias` 表示该级允许是系统维护的别名软链接。
fn anchor_of(file: File, path: &Path, alias: bool) -> Result<Anchor> {
    let meta = checked_meta(&file)?;
    if !meta.is_dir() { return Err("整合包路径不是目录".into()); }
    let value = Anchor { path: path.to_path_buf(), identity: identity(&file, &meta)?, file: Arc::new(file), alias };
    Ok(value)
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp { identity: Identity, size: u64, modified: SystemTime, changed:(i64,i64) }
#[cfg(unix)]fn change_time(_:&File,meta:&Metadata)->Result<(i64,i64)>{use std::os::unix::fs::MetadataExt;Ok((meta.ctime(),meta.ctime_nsec()))}
#[cfg(windows)]fn change_time(file:&File,_:&Metadata)->Result<(i64,i64)>{use std::{ffi::c_void,os::windows::io::AsRawHandle};#[repr(C)]struct Basic{creation:i64,access:i64,write:i64,change:i64,attributes:u32}#[link(name="kernel32")]extern "system"{fn GetFileInformationByHandleEx(file:*mut c_void,class:i32,info:*mut c_void,size:u32)->i32;}let mut basic:Basic=unsafe{std::mem::zeroed()};if unsafe{GetFileInformationByHandleEx(file.as_raw_handle(),0,(&mut basic as *mut Basic).cast(),std::mem::size_of::<Basic>()as u32)}==0{return Err("无法读取文件变更时间".into());}Ok((basic.change,0))}
#[cfg(not(any(unix,windows)))]fn change_time(_:&File,_:&Metadata)->Result<(i64,i64)>{Err("当前平台不支持变更时间校验".into())}
impl Stamp {
    fn new(file: &File, meta: &Metadata) -> Result<Self> {
        Ok(Self { identity: identity(file, meta)?, size: meta.len(), modified: meta.modified().map_err(|_| "无法读取文件修改时间")?, changed:change_time(file,meta)? })
    }
}
pub(super) struct Node { path: PathBuf, file: File, pub(super) meta: Metadata, stamp: Stamp }
impl Node {
    fn verify(&self) -> Result<()> {
        let meta = fs::symlink_metadata(&self.path).map_err(|_| "实例内容已改变")?;
        if linked(&meta) { return Err("实例内容已变成链接".into()); }
        let current = native::root(&self.path, false).map_err(|_| "无法重验实例内容")?;
        let current_meta = checked_meta(&current)?;
        if self.meta.is_dir() {
            // 目录新增/移除成员会改变时间和大小，不等于目录被换绑。
            // 成员一致性由导出计划的 names 快照单独检查；普通文件仍比较完整 Stamp。
            if !current_meta.is_dir() || identity(&current, &current_meta)? != self.stamp.identity {
                return Err("实例目录身份已改变".into());
            }
        } else if !current_meta.is_file() || Stamp::new(&current, &current_meta)? != self.stamp {
            return Err("实例内容身份或大小已改变".into());
        }
        Ok(())
    }
}

#[derive(Clone)]
pub(super) struct DirectoryMark {path:PathBuf,identities:Vec<Identity>}
impl DirectoryMark {
    pub(super) fn open(&self)->Result<Directory>{let directory=Directory::open(&self.path)?;if directory.anchors.len()!=self.identities.len()||directory.anchors.iter().zip(&self.identities).any(|(anchor,id)|&anchor.identity!=id){return Err("导出源祖先目录身份改变".into());}Ok(directory)}
    pub(super) fn verify(&self)->Result<()> {self.open()?.verify()}
}
#[derive(Clone)]
pub(super) struct Source { directory:DirectoryMark, name:String, stamp:Stamp }
impl Source {
    pub(super) fn len(&self)->u64 {self.stamp.size}
    pub(super) fn modified(&self)->SystemTime {self.stamp.modified}
    pub(super) fn open(&self)->Result<OpenedFile> {
        let directory=self.directory.open()?;
        let node=directory.child(&self.name)?.ok_or("导出源文件已移除")?;
        if !node.meta.is_file()||node.stamp!=self.stamp{return Err("导出源文件身份、大小或时间已改变".into());}
        Ok(OpenedFile{file:node.file,directory,path:node.path,stamp:node.stamp})
    }
    pub(super) fn verify(&self)->Result<()> {self.open()?.verify()}
}

pub(super) struct OpenedFile { pub(super) file: File, directory: Directory, path: PathBuf, stamp: Stamp }
impl OpenedFile {
    pub(super) fn open(path: &Path) -> Result<Self> {
        let name = leaf(path.file_name().and_then(|v| v.to_str()).ok_or("整合包文件名无效")?)?;
        let directory = Directory::open(path.parent().ok_or("整合包缺少父目录")?)?;
        let node = directory.child(name)?.ok_or("整合包文件不存在")?;
        if !node.meta.is_file() { return Err("整合包必须为普通文件".into()); }
        node.verify()?;
        Ok(Self { file: node.file, directory, path: node.path, stamp: node.stamp })
    }
    pub(super) fn verify(&self) -> Result<()> {
        self.directory.verify()?;
        if Stamp::new(&self.file, &checked_meta(&self.file)?)? != self.stamp { return Err("整合包文件在读取期间已改变".into()); }
        let name = self.path.file_name().and_then(|n| n.to_str()).ok_or("整合包文件名无效")?;
        let node = self.directory.child(name)?.ok_or("整合包文件已移除")?;
        if node.stamp != self.stamp { return Err("整合包文件身份已改变，请重新选择".into()); }
        Ok(())
    }
}

#[cfg(unix)]
mod native {
    use super::*;
    use std::ffi::CString;
    use std::os::{fd::{AsRawFd, FromRawFd}, unix::{ffi::OsStrExt, fs::OpenOptionsExt}};
    #[cfg(any(target_os="macos",target_os="ios"))] const NOFOLLOW:i32=0x100;
    #[cfg(all(target_os="android",any(target_arch="arm",target_arch="aarch64")))] const NOFOLLOW:i32=0x8000;
    #[cfg(not(any(target_os="macos",target_os="ios",all(target_os="android",any(target_arch="arm",target_arch="aarch64")))))] const NOFOLLOW:i32=0x20000;
    #[cfg(any(target_os="macos",target_os="ios"))] const CLOEXEC:i32=0x1000000;
    #[cfg(not(any(target_os="macos",target_os="ios")))] const CLOEXEC:i32=0x80000;
    #[cfg(any(target_os="macos",target_os="ios"))] const NONBLOCK:i32=0x4;
    #[cfg(not(any(target_os="macos",target_os="ios")))] const NONBLOCK:i32=0x800;
    // O_PATH：只取锚点、不要读权限。Android 的 `/data` 一类祖先只有执行权限，
    // 可读句柄打不开，但 O_PATH 句柄仍能继续 openat 与 fstat。
    #[cfg(any(target_os="linux",target_os="android"))] const PATH_ONLY:i32=0x200000;
    #[allow(dead_code)] const AT_FDCWD:i32=-100;
    extern "C" { fn openat(dir:i32,name:*const std::os::raw::c_char,flags:i32,...)->i32; }

    fn raw(path:&Path)->io::Result<CString> { CString::new(path.as_os_str().as_bytes()).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput,"路径无效")) }
    fn from_fd(fd:i32)->io::Result<File> { if fd<0 { Err(io::Error::last_os_error()) } else { Ok(unsafe { File::from_raw_fd(fd) }) } }
    /// 祖先不可读时的退路；只在这两个 errno 上使用，其它错误照旧上报。
    fn path_only(dir:i32,name:&CString,nofollow:i32)->io::Result<File> {
        #[cfg(any(target_os="linux",target_os="android"))]
        { return from_fd(unsafe { openat(dir,name.as_ptr(),PATH_ONLY|nofollow|CLOEXEC) }); }
        #[cfg(not(any(target_os="linux",target_os="android")))]
        { let _=(dir,name,nofollow); Err(io::Error::new(io::ErrorKind::PermissionDenied,"祖先目录不可读")) }
    }
    fn unreadable(dir:i32,name:&CString,error:&io::Error,nofollow:i32)->io::Result<File> {
        if matches!(error.raw_os_error(),Some(1)|Some(13)) { path_only(dir,name,nofollow) } else { Err(io::Error::new(error.kind(),error.to_string())) }
    }

    pub(super) fn root(path:&Path,follow:bool)->io::Result<File> {
        let nofollow=if follow {0} else {NOFOLLOW};
        match OpenOptions::new().read(true).custom_flags(nofollow|CLOEXEC|NONBLOCK).open(path) {
            Ok(file) => Ok(file),
            Err(error) => unreadable(AT_FDCWD,&raw(path)?,&error,nofollow),
        }
    }
    pub(super) fn names(file:&File,_:&Path)->io::Result<Box<dyn Iterator<Item=io::Result<std::ffi::OsString>>>> {
        #[cfg(any(target_os="linux",target_os="android"))]
        {let path=PathBuf::from(format!("/proc/self/fd/{}",file.as_raw_fd()));Ok(Box::new(fs::read_dir(path)?.map(|entry|entry.map(|e|e.file_name()))))}
        #[cfg(any(target_os="macos",target_os="ios"))]
        {darwin::names(file)}
        #[cfg(not(any(target_os="linux",target_os="android",target_os="macos",target_os="ios")))]
        {Err(io::Error::new(io::ErrorKind::Unsupported,"当前平台无目录句柄枚举接口"))}
    }
    #[cfg(any(target_os="macos",target_os="ios"))]
    mod darwin {
        use super::*;
        use std::{ffi::{c_void,OsString},os::unix::ffi::OsStringExt};
        #[repr(C)] struct Dirent {ino:u64,seek:u64,reclen:u16,namlen:u16,kind:u8,name:[u8;1024]}
        extern "C" {fn fdopendir(fd:i32)->*mut c_void;fn readdir(dir:*mut c_void)->*mut Dirent;fn closedir(dir:*mut c_void)->i32;fn close(fd:i32)->i32;fn __error()->*mut i32;}
        struct Names(*mut c_void);
        impl Drop for Names {fn drop(&mut self){unsafe{closedir(self.0);}}}
        impl Iterator for Names {type Item=io::Result<OsString>;fn next(&mut self)->Option<Self::Item>{loop{
            unsafe{*__error()=0;let row=readdir(self.0);if row.is_null(){return if *__error()==0{None}else{Some(Err(io::Error::last_os_error()))};}
                let row=&*row;let len=row.namlen as usize;if len>row.name.len(){return Some(Err(io::Error::new(io::ErrorKind::InvalidData,"目录名称长度无效")));}
                let name=&row.name[..len];if name==b"."||name==b".."{continue;}return Some(Ok(OsString::from_vec(name.to_vec())));
            }
        }}}
        pub(super) fn names(file:&File)->io::Result<Box<dyn Iterator<Item=io::Result<OsString>>>> {
            // 为枚举创建独立目录描述符，fdopendir 接管；不用 /dev/fd 的平台假设。
            let fd=unsafe{openat(file.as_raw_fd(),b".\0".as_ptr().cast(),NOFOLLOW|CLOEXEC|NONBLOCK)};
            if fd<0{return Err(io::Error::last_os_error());}let dir=unsafe{fdopendir(fd)};
            if dir.is_null(){let error=io::Error::last_os_error();unsafe{close(fd);}return Err(error);}Ok(Box::new(Names(dir)))
        }
    }
    pub(super) fn child(parent:&File,_:&Path,name:&str,follow:bool)->io::Result<File> {
        let name=CString::new(name).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput,"文件名无效"))?;
        let nofollow=if follow {0} else {NOFOLLOW};
        match from_fd(unsafe { openat(parent.as_raw_fd(),name.as_ptr(),nofollow|CLOEXEC|NONBLOCK) }) {
            Ok(file) => Ok(file),
            Err(error) => unreadable(parent.as_raw_fd(),&name,&error,nofollow),
        }
    }
}
#[cfg(windows)]
mod native {
    use super::*; use std::os::windows::fs::OpenOptionsExt;
    pub(super) fn root(path:&Path,_follow:bool)->io::Result<File> {
        // 不共享 DELETE；整个读取期间祖先不能被换名。OPEN_REPARSE_POINT 后再检查属性。
        let share=if fs::symlink_metadata(path)?.is_dir(){3}else{1};
        OpenOptions::new().read(true).share_mode(share).custom_flags(0x02000000|0x00200000).open(path)
    }
    pub(super) fn child(_:&File,path:&Path,_:&str,_follow:bool)->io::Result<File> { root(path,false) }
    pub(super) fn names(_:&File,path:&Path)->io::Result<Box<dyn Iterator<Item=io::Result<std::ffi::OsString>>>> {Ok(Box::new(fs::read_dir(path)?.map(|entry|entry.map(|e|e.file_name()))))}
}
#[cfg(not(any(unix,windows)))]
mod native {
    use super::*;
    pub(super) fn root(_:&Path,_follow:bool)->io::Result<File> { Err(io::Error::new(io::ErrorKind::Unsupported,"平台不支持安全只读句柄")) }
    pub(super) fn child(_:&File,path:&Path,_:&str,_follow:bool)->io::Result<File> { root(path,false) }
    pub(super) fn names(_:&File,_:&Path)->io::Result<Box<dyn Iterator<Item=io::Result<std::ffi::OsString>>>> {Err(io::Error::new(io::ErrorKind::Unsupported,"平台不支持安全目录枚举"))}
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {fn new()->Self{let p=std::env::temp_dir().join(format!("hcmcl-pack-access-{}",uuid::Uuid::new_v4()));fs::create_dir(&p).unwrap();Self(fs::canonicalize(p).unwrap())}}
    impl Drop for Fixture {fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}
    #[test] fn unsafe_aliases_are_rejected_on_every_platform(){
        for name in ["",".","..","a/b","a\\b","a:stream","CON","COM¹.zip","LPT2","name.","name ","a\0b"] {assert!(leaf(name).is_err(),"{name:?}");}
        for name in ["中文包.zip","normal name","1.21.1-Fabric",".hidden"] {assert!(leaf(name).is_ok());}
    }
    #[test] fn readonly_file_keeps_identity_and_rejects_replacement_or_resize(){
        let f=Fixture::new();let path=f.0.join("fixture.zip");fs::write(&path,b"fixture").unwrap();
        let opened=OpenedFile::open(&path).unwrap();opened.verify().unwrap();
        #[cfg(windows)] {assert!(fs::rename(&path,f.0.join("other.zip")).is_err());assert!(OpenOptions::new().write(true).open(&path).is_err());}
        #[cfg(unix)] {fs::rename(&path,f.0.join("old.zip")).unwrap();fs::write(&path,b"new").unwrap();assert!(opened.verify().is_err());}
        drop(opened);
        let opened=OpenedFile::open(&path).unwrap();drop(opened);assert!(!f.0.join(".hcmcl-install.lock").exists());
    }
    #[test] fn directory_members_may_change_without_weakening_file_stamps(){
        let f=Fixture::new();
        fs::create_dir(f.0.join("inside")).unwrap();
        let root=Directory::open(&f.0).unwrap();
        let node=root.child("inside").unwrap().unwrap();
        fs::write(f.0.join("inside/new-member"),b"new").unwrap();
        node.verify().unwrap();
        let directory=root.directory(node).unwrap();
        directory.verify().unwrap();
        fs::write(directory.path().join("data"),b"original").unwrap();
        let source=directory.source("data").unwrap();
        fs::write(directory.path().join("data"),b"changed-length").unwrap();
        assert!(source.verify().is_err());
    }
    #[test] fn hardlinks_are_rejected_on_windows_and_unix(){
        let f=Fixture::new();let source=f.0.join("source");fs::write(&source,b"fixture").unwrap();fs::hard_link(&source,f.0.join("alias")).unwrap();assert!(OpenedFile::open(&source).is_err());
    }
    #[cfg(unix)]
    #[test] fn renamed_ancestor_and_symlink_cannot_rebind_the_held_directory(){
        use std::os::unix::fs::symlink;
        let f=Fixture::new();fs::create_dir(f.0.join("inside")).unwrap();fs::write(f.0.join("inside/file"),b"fixture").unwrap();
        let opened=OpenedFile::open(&f.0.join("inside/file")).unwrap();fs::rename(f.0.join("inside"),f.0.join("moved")).unwrap();fs::create_dir(f.0.join("inside")).unwrap();fs::write(f.0.join("inside/file"),b"replacement").unwrap();assert!(opened.verify().is_err());drop(opened);
        symlink(f.0.join("moved"),f.0.join("link")).unwrap();assert!(Directory::open(&f.0.join("link")).is_err());
    }
}

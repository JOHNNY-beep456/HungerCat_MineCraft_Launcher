//! 外部 .minecraft 扫描与目录导入。来源只读，assets 与继承父版本沿用上游的不复制语义。
//! IPC 等待者退出只发送取消；真正的复制、提交和收尾由持有台账的后台任务完成。
use crate::{downloads::{Cancel, JobGuard}, install_lock::RootOperationGuard};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::{BTreeMap, BTreeSet}, fs::File, io::{Read, Write}, path::{Path, PathBuf}, sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, Ordering}}};
use tauri::{AppHandle, Manager};
type Result<T> = std::result::Result<T, String>;
#[path = "modpack/access.rs"]
mod access;
use access::{Directory, DirectoryMark, Source};
const JSON_LIMIT: u64 = 32 * 1024 * 1024;
const FILE_LIMIT: u64 = 16 * 1024 * 1024 * 1024;
const TOTAL_LIMIT: u64 = 128 * 1024 * 1024 * 1024;
const NODE_LIMIT: usize = 200_000;
const DEPTH_LIMIT: usize = 64;
type Check = Arc<dyn Fn() -> Result<()> + Send + Sync>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Policy { Rename, Overwrite, Skip }
impl Policy {
    fn parse(value: &str) -> Result<Self> { match value { "rename" => Ok(Self::Rename), "overwrite" => Ok(Self::Overwrite), "skip" => Ok(Self::Skip), _ => Err("外部版本冲突策略必须是 rename、overwrite 或 skip".into()) } }
}
fn segment(value: &str) -> Result<&str> {
    access::leaf(value)?;
    if value.to_ascii_lowercase().starts_with(".hcmcl-") { return Err("外部版本路径使用了宿主保留名称".into()); }
    Ok(value)
}
fn checked_root(path: &Path) -> Result<Directory> {
    if path.as_os_str().len() > 32768 { return Err("外部版本目录路径过长".into()); }
    Directory::open(path)
}
fn directory(parent: &Directory, name: &str) -> Result<Directory> {
    parent.directory(parent.child(name)?.ok_or("外部版本目录不存在")?)
}
#[derive(Clone)]
struct FilePlan { relative: String, source: Source }
#[derive(Clone)]
struct DirPlan { relative: String, mark: DirectoryMark, names: Vec<String> }
struct TreePlan { directories: Vec<DirPlan>, files: Vec<FilePlan>, bytes: u64 }
impl TreePlan {
    fn collect(root: Directory, check: &dyn Fn() -> Result<()>) -> Result<Self> {
        let mut budget = NODE_LIMIT;
        Self::collect_with_budget(root,&mut budget,check)
    }
    fn collect_with_budget(root:Directory,budget:&mut usize,check:&dyn Fn()->Result<()>)->Result<Self>{
        let mut plan=Self{directories:Vec::new(),files:Vec::new(),bytes:0};
        plan.walk(root,String::new(),budget,check)?;plan.verify(check)?;Ok(plan)
    }
    fn walk(&mut self, dir: Directory, relative: String, budget: &mut usize, check: &dyn Fn() -> Result<()>) -> Result<()> {
        check()?;
        if relative.len() > 4096 || relative.split('/').count() > DEPTH_LIMIT { return Err("外部实例目录层数或路径长度超过限制".into()); }
        let names = dir.names(budget)?;
        self.directories.push(DirPlan { relative: relative.clone(), mark: dir.mark(), names: names.clone() });
        for name in names {
            check()?; segment(&name)?;
            let path = if relative.is_empty() { name.clone() } else { format!("{relative}/{name}") };
            if path.len()>4096 || path.split('/').count()>DEPTH_LIMIT{return Err("外部实例文件路径超过限制".into());}
            let node = dir.child(&name)?.ok_or("外部实例内容在扫描中丢失")?;
            if node.meta.is_dir() { self.walk(dir.directory(node)?, path, budget, check)?; }
            else {
                let source = dir.source(&name)?;
                if source.len() > FILE_LIMIT { return Err("外部实例单文件超过 16 GiB 限制".into()); }
                self.bytes = self.bytes.checked_add(source.len()).filter(|n| *n <= TOTAL_LIMIT).ok_or("外部实例内容超过 128 GiB 限制")?;
                self.files.push(FilePlan { relative: path, source });
            }
        }
        Ok(())
    }
    fn verify(&self, check: &dyn Fn() -> Result<()>) -> Result<()> {
        let mut budget = NODE_LIMIT;
        for row in &self.directories {
            check()?;
            if row.mark.open()?.names(&mut budget)? != row.names { return Err("外部实例目录成员在操作期间改变".into()); }
        }
        for row in &self.files { check()?; row.source.verify()?; }
        Ok(())
    }
    fn file(&self, relative: &str) -> Option<&FilePlan> { self.files.iter().find(|file| file.relative == relative) }
}
fn read_metadata(source: &Source) -> Result<Vec<u8>> {
    if source.len() > JSON_LIMIT { return Err("外部版本 JSON 超过 32 MiB 限制".into()); }
    let mut opened = source.open()?;
    let mut bytes = Vec::new();
    (&mut opened.file).take(JSON_LIMIT + 1).read_to_end(&mut bytes).map_err(|_| "无法读取外部版本 JSON")?;
    opened.verify()?;
    if bytes.len() as u64 != source.len() || bytes.len() as u64 > JSON_LIMIT { return Err("外部版本 JSON 大小在读取期间改变".into()); }
    Ok(bytes)
}
fn loader_of(value: &Value, id: &str) -> Option<&'static str> {
    let names = value.get("libraries").and_then(Value::as_array).into_iter().flatten().filter_map(|lib| lib.get("name").and_then(Value::as_str)).collect::<Vec<_>>().join(" ").to_lowercase();
    for (needle, kind) in [("net.neoforged", "neoforge"), ("net.minecraftforge", "forge"), ("net.fabricmc", "fabric"), ("org.quiltmc", "quilt")] {
        if names.contains(needle) { return Some(kind); }
    }
    let id = id.to_lowercase();
    ["neoforge", "fabric", "quilt", "forge"].into_iter().find(|kind| id.contains(*kind))
}
fn mc_version(value: &Value, fallback: &str) -> String {
    for lib in value.get("libraries").and_then(Value::as_array).into_iter().flatten() {
        let Some(name) = lib.get("name").and_then(Value::as_str) else { continue; };
        let parts = name.split(':').collect::<Vec<_>>();
        if parts.len() < 3 { continue; }
        let group = parts[0].to_ascii_lowercase(); let artifact = parts[1].to_ascii_lowercase(); let version = parts[2];
        if parts.len()==3 && ((group == "net.fabricmc" && matches!(artifact.as_str(), "intermediary" | "hashed")) || (group == "org.quiltmc" && artifact == "hashed"))
            && version.starts_with(|c: char| c.is_ascii_digit()) && version.bytes().all(|c| c.is_ascii_alphanumeric() || b".+-".contains(&c)) { return version.into(); }
        if (group == "net.minecraftforge" && matches!(artifact.as_str(), "forge" | "fmlloader")) || (group == "net.neoforged" && artifact == "neoforge") {
            if let Some((mc, _)) = version.split_once('-') { if numeric_version(mc) { return mc.into(); } }
        }
    }
    if let Some(direct) = value.get("clientVersion").filter(|v|!v.is_null()).or_else(|| value.get("inheritsFrom")).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()) { return direct.into(); }
    for (index, ch) in fallback.char_indices() {
        if matches!(ch, '-' | '_') && numeric_version(&fallback[..index]) && ["forge", "fabric", "quilt", "neoforge", "optifine"].iter().any(|kind| fallback[index+1..].to_ascii_lowercase().starts_with(kind)) { return fallback[..index].into(); }
    }
    fallback.into()
}
fn numeric_version(value: &str) -> bool { let parts = value.split('.').collect::<Vec<_>>(); (2..=3).contains(&parts.len()) && parts.iter().all(|part| !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit())) }
fn conflict_name(versions: Option<&Directory>, id: &str) -> Result<Option<String>> {
    let Some(versions) = versions else { return Ok(None); };
    let mut budget = NODE_LIMIT;
    Ok(versions.names(&mut budget)?.into_iter().find(|name| name.to_lowercase() == id.to_lowercase()))
}
fn optional_directory(parent: &Directory, name: &str) -> Result<Option<Directory>> { parent.child(name)?.map(|node| parent.directory(node)).transpose() }
fn canonical_future(path:&Path)->Result<PathBuf>{
    if !path.is_absolute()||path.components().any(|part|matches!(part,std::path::Component::CurDir|std::path::Component::ParentDir)){return Err("游戏目录必须为无跳转绝对路径".into());}
    let mut parent=path;let mut missing=Vec::new();
    while !parent.exists(){missing.push(parent.file_name().ok_or("游戏目录祖先不存在")?.to_os_string());parent=parent.parent().ok_or("游戏目录祖先不存在")?;}
    let anchor=Directory::open(parent)?;let mut path=std::fs::canonicalize(anchor.path()).map_err(|_|"无法规范化游戏目录")?;
    for name in missing.into_iter().rev(){access::leaf(name.to_str().ok_or("目录名称不是 UTF-8")?)?;path.push(name);}Ok(path)
}
fn distinct_paths(source:&Path,target:&Path)->Result<()>{
    let fold=|p:PathBuf|{let s=p.to_string_lossy().replace('\\',"/").trim_end_matches('/').to_owned();if cfg!(windows){s.to_lowercase()}else{s}};
    let a=fold(canonical_future(source)?);let b=fold(canonical_future(target)?);
    if a==b||a.starts_with(&(b.clone()+"/"))||b.starts_with(&(a+"/")){return Err("来源与目标游戏目录不能相同或互相包含".into());}Ok(())
}
fn distinct_roots(source: &Directory, target: &Directory) -> Result<()> {
    let fold = |p: &Path| -> Result<String> { let value = std::fs::canonicalize(p).map_err(|_| "无法规范化游戏目录")?.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_owned(); Ok(if cfg!(windows) { value.to_lowercase() } else { value }) };
    let a = fold(source.path())?; let b = fold(target.path())?;
    if a == b || a.starts_with(&(b.clone() + "/")) || b.starts_with(&(a + "/")) { return Err("来源与目标游戏目录不能相同或互相包含".into()); }
    Ok(())
}
fn scan(source: &Directory, target: &Directory, check: &dyn Fn() -> Result<()>) -> Result<Value> {
    distinct_roots(source, target)?;
    let versions = directory(source, "versions").map_err(|_| "该目录下没有安全的 versions 文件夹，可能不是有效的 .minecraft 目录")?;
    let targets = optional_directory(target, "versions")?;
    let mut budget = NODE_LIMIT;
    let mut out = Vec::new(); let mut scanned_bytes=0u64;
    for id in versions.names(&mut budget)? {
        check()?;
        if id.starts_with(".hcmcl-") { continue; }
        segment(&id)?;
        let node = versions.child(&id)?.ok_or("外部版本在扫描中丢失")?;
        if !node.meta.is_dir() { continue; }
        let dir = versions.directory(node)?;
        let Some(node) = dir.child(&format!("{id}.json"))? else { continue; };
        if !node.meta.is_file() { return Err("外部版本 JSON 不是普通文件".into()); }
        drop(node);
        let plan = TreePlan::collect_with_budget(dir.clone(),&mut budget,check)?;
        scanned_bytes=scanned_bytes.checked_add(plan.bytes).filter(|n|*n<=TOTAL_LIMIT).ok_or("外部版本扫描总量超过 128 GiB 限制")?;
        if out.len()>=4096{return Err("外部版本数量超过 4096 个限制".into());}
        let bytes = read_metadata(&dir.source(&format!("{id}.json"))?)?;
        let value = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);plan.verify(check)?;
        out.push(json!({"id":id,"mcVersion":mc_version(&value,&id),"loader":loader_of(&value,&id),"size":plan.bytes,"conflict":conflict_name(targets.as_ref(),&id)?.is_some()}));
    }
    source.verify()?; target.verify()?; check()?;
    Ok(Value::Array(out))
}


#[derive(Clone, Debug, PartialEq, Eq)]
struct Identity { volume: u64, number: u64 }
#[cfg(unix)]
fn identity(file: &File) -> Result<Identity> { use std::os::unix::fs::MetadataExt; let m=file.metadata().map_err(|_| "无法读取导入文件身份")?; Ok(Identity { volume:m.dev(), number:m.ino() }) }
#[cfg(windows)]
fn identity(file: &File) -> Result<Identity> {
    use std::{ffi::c_void, os::windows::io::AsRawHandle};
    #[repr(C)] struct Info { attributes:u32, created:[u32;2], accessed:[u32;2], modified:[u32;2], volume:u32, size_high:u32, size_low:u32, links:u32, high:u32, low:u32 }
    #[link(name="kernel32")] extern "system" { fn GetFileInformationByHandle(file:*mut c_void, info:*mut Info)->i32; }
    let mut info:Info=unsafe{std::mem::zeroed()};
    if unsafe{GetFileInformationByHandle(file.as_raw_handle(),&mut info)}==0 { return Err("无法读取导入文件身份".into()); }
    if !file.metadata().map_err(|_| "无法读取导入文件状态")?.is_dir() && info.links!=1 { return Err("拒绝多硬链接导入文件".into()); }
    Ok(Identity{volume:info.volume as u64,number:(info.high as u64)<<32|info.low as u64})
}
#[cfg(not(any(unix,windows)))]
fn identity(_: &File) -> Result<Identity> { Err("当前平台不支持安全目录导入".into()) }
fn dir_id(directory:&Directory)->Result<Identity> { directory.verify()?; identity(directory.handle()) }
fn check_file(file:&File,expected:Option<&Identity>,is_dir:bool)->Result<Identity> {
    let meta=file.metadata().map_err(|_| "无法校验导入文件句柄")?;
    if access::linked(&meta) || if is_dir { !meta.is_dir() } else { !meta.is_file() } { return Err("导入句柄类型改变或成为链接".into()); }
    #[cfg(unix)] { use std::os::unix::fs::MetadataExt; if !is_dir && meta.nlink()!=1 { return Err("拒绝多硬链接导入文件".into()); } }
    let id=identity(file)?;
    if expected.is_some_and(|old| old!=&id) { return Err("导入文件身份改变".into()); }
    Ok(id)
}
// 下列内核调用只接受已持有父目录和单个 leaf。Unix 的最终 unlink/rename 不提供 inode CAS，
// 与现有 Stage 相同，不能防御同 UID 恶意进程在最后一次核验之后抢换叶名。
mod native {
    use super::*;
    #[cfg(unix)] mod os {
        use super::*; use std::{ffi::{CString,c_char},os::fd::{AsRawFd,FromRawFd}};
        #[cfg(any(target_os="macos",target_os="ios"))] const NOFOLLOW:i32=0x100;
        #[cfg(all(not(any(target_os="macos",target_os="ios")),any(target_arch="arm",target_arch="aarch64")))] const NOFOLLOW:i32=0x8000;
        #[cfg(all(not(any(target_os="macos",target_os="ios")),not(any(target_arch="arm",target_arch="aarch64"))))] const NOFOLLOW:i32=0x20000;
        #[cfg(any(target_os="macos",target_os="ios"))] const DIRECTORY:i32=0x100000;
        #[cfg(all(not(any(target_os="macos",target_os="ios")),any(target_arch="arm",target_arch="aarch64")))] const DIRECTORY:i32=0x4000;
        #[cfg(all(not(any(target_os="macos",target_os="ios")),not(any(target_arch="arm",target_arch="aarch64"))))] const DIRECTORY:i32=0x10000;
        #[cfg(any(target_os="macos",target_os="ios"))] const CLOEXEC:i32=0x1000000;
        #[cfg(not(any(target_os="macos",target_os="ios")))] const CLOEXEC:i32=0x80000;
        #[cfg(any(target_os="macos",target_os="ios"))] const CREATE:i32=0x200|0x800;
        #[cfg(not(any(target_os="macos",target_os="ios")))] const CREATE:i32=0x40|0x80;
        #[cfg(any(target_os="macos",target_os="ios"))] const NONBLOCK:i32=4;
        #[cfg(not(any(target_os="macos",target_os="ios")))] const NONBLOCK:i32=0x800;
        #[cfg(any(target_os="macos",target_os="ios"))] const REMOVEDIR:i32=0x80;
        #[cfg(not(any(target_os="macos",target_os="ios")))] const REMOVEDIR:i32=0x200;
        extern "C" {fn openat(fd:i32,name:*const c_char,flags:i32,...)->i32; fn mkdirat(fd:i32,name:*const c_char,mode:u32)->i32; fn unlinkat(fd:i32,name:*const c_char,flags:i32)->i32;}
        fn name(value:&str)->Result<CString>{CString::new(value).map_err(|_| "导入路径含空字节".into())}
        fn open(parent:&File,leaf:&str,flags:i32)->Result<File>{let name=name(leaf)?;let fd=unsafe{openat(parent.as_raw_fd(),name.as_ptr(),flags,0o600u32)};if fd<0{Err("通过目录句柄打开导入文件失败".into())}else{Ok(unsafe{File::from_raw_fd(fd)})}}
        pub(super) fn mkdir(parent:&File,leaf:&str)->Result<File>{let text=name(leaf)?;if unsafe{mkdirat(parent.as_raw_fd(),text.as_ptr(),0o700)}<0{return Err("无法建立独占导入目录".into());}open(parent,leaf,NOFOLLOW|CLOEXEC|DIRECTORY)}
        pub(super) fn new_file(parent:&File,leaf:&str)->Result<File>{open(parent,leaf,2|CREATE|NOFOLLOW|CLOEXEC)}
        pub(super) fn remove(parent:&File,leaf:&str,expected:&Identity,dir:bool)->Result<()>{let opened=open(parent,leaf,NOFOLLOW|CLOEXEC|NONBLOCK|if dir{DIRECTORY}else{0})?;check_file(&opened,Some(expected),dir)?;let text=name(leaf)?;if unsafe{unlinkat(parent.as_raw_fd(),text.as_ptr(),if dir{REMOVEDIR}else{0})}<0{Err("通过目录句柄清理导入内容失败".into())}else{Ok(())}}
        pub(super) fn rename(parent:&File,from:&str,to:&str,expected:&Identity,dir:bool,file:Option<&File>)->Result<()>{
            let opened=open(parent,from,NOFOLLOW|CLOEXEC|NONBLOCK|if dir{DIRECTORY}else{0})?;check_file(&opened,Some(expected),dir)?;if let Some(file)=file{check_file(file,Some(expected),dir)?;}
            let a=name(from)?;let b=name(to)?;
            #[cfg(target_os="linux")] let result={extern "C"{fn renameat2(a:i32,b:*const c_char,c:i32,d:*const c_char,flags:u32)->i32;}unsafe{renameat2(parent.as_raw_fd(),a.as_ptr(),parent.as_raw_fd(),b.as_ptr(),1)}};
            #[cfg(any(target_os="macos",target_os="ios"))] let result={extern "C"{fn renameatx_np(a:i32,b:*const c_char,c:i32,d:*const c_char,flags:u32)->i32;}unsafe{renameatx_np(parent.as_raw_fd(),a.as_ptr(),parent.as_raw_fd(),b.as_ptr(),4)}};
            #[cfg(not(any(target_os="linux",target_os="macos",target_os="ios")))] let result=-1;
            if result<0{Err("导入目录无覆盖改名失败；现场已保留".into())}else{Ok(())}
        }
    }
    #[cfg(windows)] mod os {
        use super::*;use std::{ffi::c_void,os::windows::io::{AsRawHandle,FromRawHandle}};
        type Handle=*mut c_void;
        #[repr(C)]struct Unicode{length:u16,maximum:u16,buffer:*mut u16}
        #[repr(C)]struct Attributes{length:u32,root:Handle,name:*mut Unicode,attributes:u32,security:*mut c_void,qos:*mut c_void}
        #[repr(C)]struct Status{status:isize,information:usize}
        #[link(name="ntdll")]extern "system"{fn NtCreateFile(file:*mut Handle,access:u32,attrs:*mut Attributes,status:*mut Status,allocation:*const i64,attributes:u32,share:u32,disposition:u32,options:u32,ea:*mut c_void,ea_len:u32)->i32;fn NtSetInformationFile(file:Handle,status:*mut Status,info:*mut c_void,length:u32,class:i32)->i32;}
        #[link(name="kernel32")]extern "system"{fn SetFileInformationByHandle(file:Handle,class:i32,info:*mut c_void,len:u32)->i32;}
        fn open(parent:&File,leaf:&str,create:bool,dir:bool,delete:bool,write:bool)->Result<File>{let mut wide=leaf.encode_utf16().collect::<Vec<_>>();let len=u16::try_from(wide.len().checked_mul(2).ok_or("导入文件名过长")?).map_err(|_|"导入文件名过长")?;let mut text=Unicode{length:len,maximum:len,buffer:wide.as_mut_ptr()};let mut attrs=Attributes{length:std::mem::size_of::<Attributes>()as u32,root:parent.as_raw_handle(),name:&mut text,attributes:0x40,security:std::ptr::null_mut(),qos:std::ptr::null_mut()};let mut status=Status{status:0,information:0};let mut raw=std::ptr::null_mut();let result=unsafe{NtCreateFile(&mut raw,0x80000000|0x100000|if write{0x40000000}else{0}|if delete{0x10000}else{0},&mut attrs,&mut status,std::ptr::null(),0,if dir{3}else{1},if create{2}else{1},0x20|0x200000|if dir{1}else{0x40},std::ptr::null_mut(),0)};if result<0{Err("通过目录句柄打开导入文件失败".into())}else{Ok(unsafe{File::from_raw_handle(raw)})}}
        pub(super)fn mkdir(parent:&File,name:&str)->Result<File>{open(parent,name,true,true,false,false)}
        pub(super)fn new_file(parent:&File,name:&str)->Result<File>{open(parent,name,true,false,true,true)}
        pub(super)fn remove(parent:&File,name:&str,expected:&Identity,dir:bool)->Result<()>{let file=open(parent,name,false,dir,true,false)?;check_file(&file,Some(expected),dir)?;let mut delete=1u8;if unsafe{SetFileInformationByHandle(file.as_raw_handle(),4,(&mut delete as *mut u8).cast(),1)}==0{Err("通过句柄清理导入内容失败".into())}else{Ok(())}}
        #[repr(C)]struct Rename{replace:u8,root:Handle,length:u32,name:[u16;1]}
        pub(super)fn rename(parent:&File,from:&str,to:&str,expected:&Identity,dir:bool,file:Option<&File>)->Result<()>{let opened;let handle=if let Some(file)=file{file}else{opened=open(parent,from,false,dir,true,false)?;&opened};check_file(handle,Some(expected),dir)?;let wide=to.encode_utf16().collect::<Vec<_>>();let offset=std::mem::offset_of!(Rename,name);let total=offset.checked_add(wide.len().checked_mul(2).ok_or("导入文件名过长")?).ok_or("导入文件名过长")?.max(std::mem::size_of::<Rename>());let mut storage=vec![0usize;(total+std::mem::size_of::<usize>()-1)/std::mem::size_of::<usize>()];let info=storage.as_mut_ptr().cast::<Rename>();unsafe{(*info).replace=0;(*info).root=parent.as_raw_handle();(*info).length=u32::try_from(wide.len()*2).map_err(|_|"导入文件名过长")?;std::ptr::copy_nonoverlapping(wide.as_ptr(),storage.as_mut_ptr().cast::<u8>().add(offset).cast::<u16>(),wide.len());let mut status=Status{status:0,information:0};if NtSetInformationFile(handle.as_raw_handle(),&mut status,info.cast(),u32::try_from(total).map_err(|_|"导入文件名过长")?,10)<0{return Err("导入目录无覆盖改名失败；现场已保留".into());}}Ok(())}
    }
    #[cfg(not(any(unix,windows)))]mod os{use super::*;pub(super)fn mkdir(_:&File,_:&str)->Result<File>{Err("平台不支持安全目录写入".into())}pub(super)fn new_file(_:&File,_:&str)->Result<File>{Err("平台不支持安全文件写入".into())}pub(super)fn remove(_:&File,_:&str,_:&Identity,_:bool)->Result<()>{Err("平台不支持安全清理".into())}pub(super)fn rename(_:&File,_:&str,_:&str,_:&Identity,_:bool,_:Option<&File>)->Result<()>{Err("平台不支持安全发布".into())}}
    pub(super)fn mkdir(parent:&Directory,name:&str)->Result<File>{access::leaf(name)?;parent.verify()?;let file=os::mkdir(parent.handle(),name)?;check_file(&file,None,true)?;parent.verify()?;Ok(file)}
    pub(super)fn file(parent:&Directory,name:&str)->Result<File>{access::leaf(name)?;parent.verify()?;let file=os::new_file(parent.handle(),name)?;check_file(&file,None,false)?;parent.verify()?;Ok(file)}
    pub(super)fn remove(parent:&Directory,name:&str,id:&Identity,dir:bool)->Result<()>{parent.verify()?;os::remove(parent.handle(),name,id,dir)?;parent.verify()}
    pub(super)fn rename(parent:&Directory,from:&str,to:&str,id:&Identity,dir:bool,file:Option<&File>)->Result<()>{parent.verify()?;access::leaf(from)?;access::leaf(to)?;os::rename(parent.handle(),from,to,id,dir,file)}
}

#[derive(Clone)]
struct Receipt { id: Identity, size: u64, hash: Option<String> }
struct Tree {
    parent: Directory, name: String, id: Option<Identity>,
    files: BTreeMap<String, Receipt>, dirs: BTreeMap<String, Identity>,
    published: bool, removed: bool, original: Option<String>,
}
fn renamed_path(path:&str,old:&str,new:&str)->String {
    if path==format!("{old}.json"){format!("{new}.json")}else if path==format!("{old}.jar"){format!("{new}.jar")}else{path.to_owned()}
}
fn path_parts(relative: &str) -> Result<Vec<&str>> {
    if relative.is_empty() || relative.len()>4096 || relative.contains('\\') { return Err("导入相对路径无效".into()); }
    let parts=relative.split('/').collect::<Vec<_>>();
    if parts.len()>DEPTH_LIMIT { return Err("导入路径层数超过限制".into()); }
    for part in &parts { access::leaf(part)?; }
    Ok(parts)
}
fn hash_source(source:&Source,check:&dyn Fn()->Result<()>)->Result<String> {
    let mut opened=source.open()?;let mut hash=Sha256::new();let mut total=0u64;let mut buf=[0u8;65536];
    loop { check()?;let n=opened.file.read(&mut buf).map_err(|_|"读取导入文件失败")?;if n==0{break;}total=total.checked_add(n as u64).filter(|n|*n<=source.len()).ok_or("导入文件变大")?;hash.update(&buf[..n]); }
    opened.verify()?;if total!=source.len(){return Err("导入文件大小改变".into());}Ok(format!("{:x}",hash.finalize()))
}
impl Tree {
    fn pending(parent:Directory,name:String)->Self { Self { parent,name,id:None,files:BTreeMap::new(),dirs:BTreeMap::new(),published:false,removed:false,original:None } }
    fn create(&mut self)->Result<()> {
        let file=native::mkdir(&self.parent,&self.name)?;let id=check_file(&file,None,true)?;self.id=Some(id.clone());drop(file);
        let dir=self.root()?;if dir_id(&dir)?!=id{return Err("新建导入暂存目录身份改变".into());}Ok(())
    }
    fn root(&self)->Result<Directory>{let root=directory(&self.parent,&self.name)?;if self.id.as_ref()!=Some(&dir_id(&root)?){return Err("导入目录身份改变".into());}Ok(root)}
    fn parent_for(&self,relative:&str)->Result<(Directory,String)>{let parts=path_parts(relative)?;let mut dir=self.root()?;for (index,part) in parts[..parts.len()-1].iter().enumerate(){dir=directory(&dir,part)?;if self.dirs.get(&parts[..=index].join("/"))!=Some(&dir_id(&dir)?){return Err("导入父目录不在台账中或已改变".into());}}Ok((dir,parts.last().ok_or("导入路径为空")?.to_string()))}
    fn mkdir(&mut self,relative:&str)->Result<()> {
        let (parent,name)=self.parent_for(relative)?;
        if parent.child(&name)?.is_some(){return Err("导入暂存存在未知同名目录".into());}
        let file=native::mkdir(&parent,&name)?;let id=check_file(&file,None,true)?;
        self.dirs.insert(relative.into(),id);drop(file);Ok(())
    }
    fn write(&mut self,relative:&str,mut reader:impl Read,size:u64,check:&dyn Fn()->Result<()>)->Result<()> {
        check()?;if size>FILE_LIMIT{return Err("导入文件超过大小限制".into());}
        let (parent,name)=self.parent_for(relative)?;
        if parent.child(&name)?.is_some(){return Err("拒绝覆盖导入暂存中的未知文件".into());}
        let mut file=native::file(&parent,&name)?;let id=check_file(&file,None,false)?;
        self.files.insert(relative.into(),Receipt{id,size:0,hash:None});
        let mut hash=Sha256::new();let mut remaining=size;let mut buf=[0u8;65536];
        while remaining>0{check()?;let wanted=remaining.min(buf.len()as u64)as usize;let n=reader.read(&mut buf[..wanted]).map_err(|_|"读取外部文件失败")?;if n==0{return Err("外部文件提前结束".into());}file.write_all(&buf[..n]).map_err(|_|"写入外部实例失败")?;hash.update(&buf[..n]);remaining-=n as u64;}
        if reader.read(&mut[0u8;1]).map_err(|_|"读取外部文件末尾失败")?!=0{return Err("外部文件大小改变".into());}
        file.flush().map_err(|_|"刷新外部实例文件失败")?;file.sync_all().map_err(|_|"同步外部实例文件失败")?;
        let receipt=self.files.get_mut(relative).ok_or("导入文件台账丢失")?;check_file(&file,Some(&receipt.id),false)?;receipt.size=size;receipt.hash=Some(format!("{:x}",hash.finalize()));drop(file);parent.verify()?;check()
    }
    fn copy(&mut self,plan:&TreePlan,old:&str,new:&str,check:&dyn Fn()->Result<()>)->Result<()> {
        for row in &plan.directories{check()?;if !row.relative.is_empty(){self.mkdir(&row.relative)?;}}
        for row in &plan.files{
            check()?;let relative=renamed_path(&row.relative,old,new);
            if old!=new && row.relative==format!("{old}.json"){
                let bytes=read_metadata(&row.source)?;let bytes=match serde_json::from_slice::<Value>(&bytes){Ok(mut value)if value.is_object()=>{
                    value["id"]=json!(new);
                    // 仅同步确实随本实例搬迁的自引用 JAR；外部 JAR 与继承引用保持不变。
                    if value.get("jar").and_then(Value::as_str)==Some(old) && plan.file(&format!("{old}.jar")).is_some(){value["jar"]=json!(new);}
                    serde_json::to_vec_pretty(&value).map_err(|_|"无法改写版本标识")?
                },_=>bytes};
                self.write(&relative,bytes.as_slice(),bytes.len()as u64,check)?;
            }else{let mut opened=row.source.open()?;self.write(&relative,&mut opened.file,row.source.len(),check)?;opened.verify()?;}
        }
        plan.verify(check)
    }
    fn snapshot(parent:Directory,name:String,check:&dyn Fn()->Result<()>)->Result<Self>{
        let dir=directory(&parent,&name)?;let id=dir_id(&dir)?;let plan=TreePlan::collect(dir,check)?;
        let mut tree=Self::pending(parent,name);tree.id=Some(id);
        for row in &plan.directories{if !row.relative.is_empty(){tree.dirs.insert(row.relative.clone(),dir_id(&row.mark.open()?)?);}}
        for row in &plan.files{check()?;let opened=row.source.open()?;let id=check_file(&opened.file,None,false)?;drop(opened);tree.files.insert(row.relative.clone(),Receipt{id,size:row.source.len(),hash:Some(hash_source(&row.source,check)?)});}
        plan.verify(check)?;Ok(tree)
    }
    fn verify(&self,check:&dyn Fn()->Result<()>)->Result<()> {
        if self.removed{return Ok(());}let root=self.root()?;let mut budget=NODE_LIMIT;let mut seen_files=BTreeSet::new();let mut seen_dirs=BTreeSet::new();
        self.walk(root,String::new(),&mut budget,&mut seen_files,&mut seen_dirs,check)?;
        if self.files.len()!=seen_files.len()||self.dirs.len()!=seen_dirs.len(){return Err("导入台账中的文件或目录丢失".into());}Ok(())
    }
    fn walk(&self,dir:Directory,prefix:String,budget:&mut usize,files:&mut BTreeSet<String>,dirs:&mut BTreeSet<String>,check:&dyn Fn()->Result<()>)->Result<()> {
        for name in dir.names(budget)?{check()?;let relative=if prefix.is_empty(){name.clone()}else{format!("{prefix}/{name}")};let node=dir.child(&name)?.ok_or("导入节点丢失")?;
            if node.meta.is_dir(){let child=dir.directory(node)?;if self.dirs.get(&relative)!=Some(&dir_id(&child)?){return Err("导入目录含未知或已换绑子目录，保留现场".into());}dirs.insert(relative.clone());self.walk(child,relative,budget,files,dirs,check)?;}
            else{drop(node);let receipt=self.files.get(&relative).ok_or("导入目录含未知文件，保留现场")?;let source=dir.source(&name)?;let opened=source.open()?;check_file(&opened.file,Some(&receipt.id),false)?;drop(opened);if let Some(hash)=&receipt.hash{if source.len()!=receipt.size||hash_source(&source,check)?!=*hash{return Err("导入文件内容改变，保留现场".into());}}files.insert(relative);}
        }Ok(())
    }
    fn rename(&mut self,to:&str)->Result<()> {let id=self.id.as_ref().ok_or("导入目录没有身份回执")?;native::rename(&self.parent,&self.name,to,id,true,None)?;self.name=to.into();Ok(())}
    fn cleanup(&mut self)->Result<()> {
        if self.removed||self.published{return Ok(());}
        if self.id.is_none(){if self.parent.child(&self.name)?.is_none(){self.removed=true;return Ok(());}return Err("导入暂存创建结果未知，保留现场".into());}
        self.verify(&||Ok(()))?;
        for relative in self.files.keys().cloned().collect::<Vec<_>>(){let (parent,name)=self.parent_for(&relative)?;let receipt=self.files.get(&relative).ok_or("导入文件台账丢失")?;native::remove(&parent,&name,&receipt.id,false)?;self.files.remove(&relative);}
        let mut paths=self.dirs.keys().cloned().collect::<Vec<_>>();paths.sort_by_key(|p|std::cmp::Reverse(p.matches('/').count()));
        for relative in paths{let (parent,name)=self.parent_for(&relative)?;let child=directory(&parent,&name)?;let id=self.dirs.get(&relative).ok_or("导入目录台账丢失")?;if dir_id(&child)?!=*id{return Err("导入目录身份改变".into());}let mut budget=1;if !child.names(&mut budget)?.is_empty(){return Err("导入目录出现未知内容，保留现场".into());}drop(child);native::remove(&parent,&name,id,true)?;self.dirs.remove(&relative);}
        let root=self.root()?;let mut budget=1;if !root.names(&mut budget)?.is_empty(){return Err("导入暂存出现未知内容".into());}drop(root);native::remove(&self.parent,&self.name,self.id.as_ref().ok_or("导入根身份丢失")?,true)?;self.removed=true;Ok(())
    }
}

struct LibraryTemp { parent: Directory, name: String, id: Option<Identity>, moved: bool }
impl LibraryTemp {
    fn cleanup(&mut self)->Result<()> {
        if self.moved{return Ok(());}
        match (&self.id,self.parent.child(&self.name)?) {
            (_,None)=>{self.moved=true;Ok(())},
            (Some(id),Some(node))=>{drop(node);native::remove(&self.parent,&self.name,id,false)?;self.moved=true;Ok(())},
            _=>Err("库文件临时写入身份未确认，保留现场".into()),
        }
    }
}
fn alias_check(parent:&Directory,name:&str)->Result<()> {
    let mut budget=NODE_LIMIT;
    if parent.names(&mut budget)?.iter().any(|old|old.to_lowercase()==name.to_lowercase()&&old!=name){return Err("目标目录已有大小写别名，拒绝覆盖".into());}Ok(())
}
fn ensure_child(parent:&Directory,name:&str)->Result<Directory> {
    alias_check(parent,name)?;
    if let Some(node)=parent.child(name)?{return parent.directory(node);}
    let file=native::mkdir(parent,name)?;let id=check_file(&file,None,true)?;drop(file);
    let child=directory(parent,name)?;if dir_id(&child)?!=id{return Err("新建目标目录身份改变".into());}Ok(child)
}
#[derive(Default)]struct Commit { attempted:bool, committed:bool }
struct Operation { cancel:Arc<Cancel>, job:Mutex<Option<Arc<Cancel>>>, commit:Mutex<Commit> }
impl Operation {
    fn new()->Self{Self{cancel:Arc::new(Cancel::default()),job:Mutex::new(None),commit:Mutex::new(Commit::default())}}
    fn stop(&self){self.cancel.stop();if let Ok(job)=self.job.lock(){if let Some(job)=&*job{job.stop();}}}
    fn check(&self)->Result<()>{self.cancel.check()?;if let Some(job)=&*self.job.lock().map_err(|_|"导入取消状态不可用")?{job.check()?;}Ok(())}
    fn request_cancel(&self)->Result<()>{match self.commit.try_lock(){Ok(state)=>{if state.committed{return Err("外部版本已提交，取消不能撤销导入".into());}self.stop();if state.attempted{Err("外部版本正在提交或恢复，不能保证撤销".into())}else{Ok(())}},Err(_)=>{self.stop();Err("外部版本提交状态未确认，已发送停止信号".into())}}}
}
struct Ledger {
    source:Mutex<Option<Directory>>, target:Mutex<Option<Directory>>,
    stage:Mutex<Option<Tree>>, backup:Mutex<Option<Tree>>, temps:Mutex<Vec<LibraryTemp>>,
    root:Mutex<Option<RootOperationGuard>>, job:Mutex<Option<JobGuard>>,
    request:Mutex<Option<crate::lifecycle::Request>>, unknown:AtomicBool,
}
impl Ledger {
    fn new()->Self{Self{source:Mutex::new(None),target:Mutex::new(None),stage:Mutex::new(None),backup:Mutex::new(None),temps:Mutex::new(Vec::new()),root:Mutex::new(None),job:Mutex::new(None),request:Mutex::new(None),unknown:AtomicBool::new(false)}}
    fn roots(&self)->Result<(Directory,Directory)>{Ok((self.source.lock().map_err(|_|"来源目录台账不可用")?.clone().ok_or("来源目录尚未登记")?,self.target.lock().map_err(|_|"目标目录台账不可用")?.clone().ok_or("目标目录尚未登记")?))}
    fn cleanup(&self,operation:&Operation)->Result<()> {
        let committed=operation.commit.lock().map_err(|_|"导入提交状态不可用")?.committed;
        let mut errors=Vec::new();
        match self.temps.lock(){Ok(mut temps)=>for temp in &mut *temps{if let Err(e)=temp.cleanup(){errors.push(e);}},Err(_)=>errors.push("库文件台账不可用".into())}
        if !committed {
            match self.backup.lock(){Ok(mut slot)=>if let Some(backup)=&mut *slot{
                if backup.name.starts_with(".hcmcl-external-backup-"){
                    // 旧目录仍按快照验身份和内容，然后用 no-replace 恢复；从不删除抢占目标。
                    let original=backup.original.clone().ok_or("旧实例原名台账丢失")?;
                    match backup.verify(&||Ok(())).and_then(|_|backup.rename(&original)){Ok(())=>{backup.published=true;},Err(e)=>errors.push(format!("旧实例恢复未确认：{e}"))}
                }
            },Err(_)=>errors.push("旧实例台账不可用".into())}
        } else {
            match self.backup.lock(){Ok(mut slot)=>if let Some(backup)=&mut *slot{if let Err(e)=backup.cleanup(){errors.push(format!("新实例已提交，但旧实例备份清理未确认：{e}"));}},Err(_)=>errors.push("旧实例台账不可用".into())}
        }
        match self.stage.lock(){Ok(mut slot)=>if let Some(stage)=&mut *slot{if let Err(e)=stage.cleanup(){errors.push(e);}},Err(_)=>errors.push("导入暂存台账不可用".into())}
        if errors.is_empty(){Ok(())}else{Err(errors.join("；"))}
    }
}
struct Entry { task:String, target:Option<String>, operation:Arc<Operation>, ledger:Arc<Ledger> }
#[derive(Default)]struct Registry { closed:bool, entries:BTreeMap<String,Entry> }
static REGISTRY:OnceLock<Mutex<Registry>>=OnceLock::new();
fn registry()->&'static Mutex<Registry>{REGISTRY.get_or_init(||Mutex::new(Registry::default()))}
fn register(operation:Arc<Operation>,ledger:Arc<Ledger>,target:Option<String>)->Result<String>{let mut state=registry().lock().map_err(|_|"外部版本任务登记不可用")?;if state.closed||state.entries.len()>=128{return Err("主窗口已关闭或外部版本任务超过上限".into());}let id=uuid::Uuid::new_v4().to_string();state.entries.insert(id.clone(),Entry{task:format!("external-import:{id}"),target,operation,ledger});Ok(id)}
pub(crate)fn cancel_for_window(){if let Ok(mut state)=registry().lock(){state.closed=true;for entry in state.entries.values(){entry.operation.stop();}}}
pub(crate)fn cancel_download(id:Option<&str>)->Result<()>{let state=registry().lock().map_err(|_|"外部版本任务登记不可用")?;let mut errors=Vec::new();for entry in state.entries.values(){if id.map_or(true,|id|id==entry.task||entry.target.as_deref()==Some(id)){if let Err(e)=entry.operation.request_cancel(){errors.push(e);}}}if errors.is_empty(){Ok(())}else{Err(errors.join("；"))}}
pub(crate)fn relaunch_ready()->Result<()>{let state=registry().try_lock().map_err(|_|"外部版本任务状态忙碌或未知")?;if state.entries.values().any(|entry|entry.ledger.unknown.load(Ordering::Acquire)){return Err("外部版本收尾状态未知，目录保持忙碌，不能重启".into());}if !state.entries.is_empty(){Err("外部版本仍在扫描、导入或收尾，不能重启".into())}else{Ok(())}}
struct Waiting(Arc<Operation>);
impl Drop for Waiting{fn drop(&mut self){self.0.stop();}}

fn merge_libraries(plan:&TreePlan,target:&Directory,ledger:&Ledger,check:&dyn Fn()->Result<()>)->Result<()> {
    check()?;let root=ensure_child(target,"libraries")?;
    for row in &plan.directories {
        check()?;if row.relative.is_empty(){continue;}
        let mut parent=root.clone();for part in path_parts(&row.relative)?{parent=ensure_child(&parent,part)?;}
    }
    for row in &plan.files {
        check()?;let parts=path_parts(&row.relative)?;let name=parts.last().ok_or("库文件路径为空")?;
        let mut parent=root.clone();for part in &parts[..parts.len()-1]{parent=directory(&parent,part)?;}
        alias_check(&parent,name)?;
        if let Some(node)=parent.child(name)?{if !node.meta.is_file(){return Err("目标库文件位置被目录占用".into());}continue;}
        let temporary=format!(".hcmcl-external-file-{}",uuid::Uuid::new_v4());
        let mut temps=ledger.temps.lock().map_err(|_|"库文件台账不可用")?;
        temps.push(LibraryTemp{parent:parent.clone(),name:temporary.clone(),id:None,moved:false});
        let receipt=temps.last_mut().ok_or("库文件台账丢失")?;
        let mut output=native::file(&parent,&temporary)?;let id=check_file(&output,None,false)?;receipt.id=Some(id.clone());
        let mut input=row.source.open()?;let mut count=0u64;let mut buf=[0u8;65536];let mut hash=Sha256::new();
        loop {check()?;let n=input.file.read(&mut buf).map_err(|_|"读取来源依赖库失败")?;if n==0{break;}count=count.checked_add(n as u64).filter(|n|*n<=row.source.len()).ok_or("来源依赖库大小改变")?;output.write_all(&buf[..n]).map_err(|_|"复制依赖库失败")?;hash.update(&buf[..n]);}
        if count!=row.source.len(){return Err("来源依赖库提前结束".into());}input.verify()?;
        output.flush().map_err(|_|"刷新依赖库失败")?;output.sync_all().map_err(|_|"同步依赖库失败")?;
        check_file(&output,Some(&id),false)?;check()?;parent.verify()?;alias_check(&parent,name)?;
        let expected=format!("{:x}",hash.finalize());
        // 新建文件仍持可写句柄，Windows 此时禁止重开；flush/sync 后以同句柄改名，
        // 立即记入已提交状态，再关闭并用只读句柄复核真实落地内容。
        native::rename(&parent,&temporary,name,&id,false,Some(&output))?;receipt.moved=true;drop(output);drop(input);
        let source=parent.source(name)?;let opened=source.open()?;check_file(&opened.file,Some(&id),false)?;drop(opened);
        if hash_source(&source,check)?!=expected{return Err("已合并依赖库的落地内容校验失败；库文件保留且实例未发布".into());}
    }
    plan.verify(check)
}
fn final_id(versions:&Directory,base:&str,policy:Policy)->Result<(String,Option<String>)>{
    let conflict=conflict_name(Some(versions),base)?;
    if conflict.is_none()||policy!=Policy::Rename{return Ok((base.into(),conflict));}
    for n in 2..1000{let suffix=format!("-{n}");let max=235-suffix.len();let mut end=base.len().min(max);while !base.is_char_boundary(end){end-=1;}let candidate=format!("{}{suffix}",&base[..end]);if conflict_name(Some(versions),&candidate)?.is_none(){return Ok((candidate,None));}}
    let suffix=format!("-{}",uuid::Uuid::new_v4());let max=235-suffix.len();let mut end=base.len().min(max);while !base.is_char_boundary(end){end-=1;}Ok((format!("{}{suffix}",&base[..end]),None))
}
fn preflight_renamed(plan:&TreePlan,old:&str,new:&str)->Result<()> {
    if old==new{return Ok(());}let mut nodes=BTreeSet::new();
    for target in plan.directories.iter().map(|row|row.relative.clone()).filter(|p|!p.is_empty()).chain(plan.files.iter().map(|row|renamed_path(&row.relative,old,new))){
        if !nodes.insert(target.to_lowercase()){return Err("改名后的外部实例文件与已有内容冲突".into());}
    }Ok(())
}
fn import_under_guard(source:&Directory,target:&Directory,id:&str,policy:Policy,ledger:&Ledger,operation:&Operation,check:&dyn Fn()->Result<()>)->Result<Value> {
    check()?;distinct_roots(source,target)?;let versions=directory(source,"versions")?;let origin=directory(&versions,id)?;
    let metadata=origin.child(&format!("{id}.json"))?.ok_or("来源中找不到指定版本 JSON")?;if !metadata.meta.is_file(){return Err("来源版本 JSON 不是普通文件".into());}drop(metadata);
    // 隔离标记使用与 runtime/catalog 同一个受控读取器；完整版本目录包含存档、模组和配置。
    let isolation=crate::modpack::instance_isolation(source.path(),id,&json!({}))?;
    let targets=ensure_child(target,"versions")?;let (final_id,conflict)=final_id(&targets,id,policy)?;
    if conflict.is_some()&&policy==Policy::Skip{check()?;isolation.verify()?;return Ok(json!({"id":id,"action":"skipped"}));}
    let plan=TreePlan::collect(origin,check)?;read_metadata(&plan.file(&format!("{id}.json")).ok_or("来源版本 JSON 丢失")?.source)?;
    let libraries=optional_directory(source,"libraries")?.map(|dir|TreePlan::collect(dir,check)).transpose()?;
    if let Some(libraries)=&libraries{
        if plan.bytes.checked_add(libraries.bytes).is_none_or(|bytes|bytes>TOTAL_LIMIT)
            || plan.files.len()+plan.directories.len()+libraries.files.len()+libraries.directories.len()>NODE_LIMIT{return Err("实例与依赖库的合计大小或节点数超过导入预算".into());}
    }
    preflight_renamed(&plan,id,&final_id)?;
    let staging_name=format!(".hcmcl-external-stage-{}",uuid::Uuid::new_v4());
    {let mut slot=ledger.stage.lock().map_err(|_|"导入暂存台账不可用")?;*slot=Some(Tree::pending(targets.clone(),staging_name));let stage=slot.as_mut().ok_or("导入暂存台账丢失")?;stage.create()?;stage.copy(&plan,id,&final_id,check)?;stage.verify(check)?;}
    if let Some(libraries)=&libraries{merge_libraries(libraries,target,ledger,check)?;}
    plan.verify(check)?;if let Some(libraries)=&libraries{libraries.verify(check)?;}isolation.verify()?;check()?;
    let mut gate=operation.commit.lock().map_err(|_|"导入提交状态不可用")?;check()?;
    if let Some(existing)=conflict {
        let mut backup=Tree::snapshot(targets.clone(),existing.clone(),check)?;backup.original=Some(existing.clone());
        let backup_name=format!(".hcmcl-external-backup-{}",uuid::Uuid::new_v4());
        let mut slot=ledger.backup.lock().map_err(|_|"旧实例台账不可用")?;*slot=Some(backup);let backup=slot.as_mut().ok_or("旧实例台账丢失")?;
        backup.verify(check)?;check()?;gate.attempted=true;backup.rename(&backup_name)?;
    }
    check()?;
    {let mut slot=ledger.stage.lock().map_err(|_|"导入暂存台账不可用")?;let stage=slot.as_mut().ok_or("导入暂存台账丢失")?;stage.verify(check)?;
        // overwrite 旧树快照可能耗时；必须在真正发布前再次复核全部来源和授权。
        plan.verify(check)?;if let Some(libraries)=&libraries{libraries.verify(check)?;}isolation.verify()?;check()?;gate.attempted=true;
        stage.rename(&final_id)?;
        // 内核成功即提交；后验失败与取消不得将已发布目录当作暂存删除。
        stage.published=true;gate.committed=true;
        if stage.verify(&||Ok(())).is_err(){return Err("外部版本已提交，但发布后身份或内容校验失败；目标保留".into());}
    }
    Ok(json!({"id":final_id,"action":if final_id==id{"imported"}else{"renamed"}}))
}

fn request_args(channel:&str,args:&[Value])->Result<(PathBuf,Option<(String,Policy)>)>{
    let expected=if channel=="versions:scanExternal"{1}else{3};if args.len()!=expected{return Err("外部版本操作参数数量不符".into());}
    let raw=args[0].as_str().filter(|v|!v.is_empty()&&v.len()<=32768&&!v.chars().any(char::is_control)).ok_or("外部版本目录必须是有效文本")?;let path=PathBuf::from(raw);
    if !path.is_absolute()||path.components().any(|p|matches!(p,std::path::Component::ParentDir|std::path::Component::CurDir)){return Err("外部版本目录必须是无跳转的绝对路径".into());}
    let import=if expected==3{let id=args[1].as_str().ok_or("外部版本标识必须是字符串")?;segment(id)?;access::leaf(&format!("{id}.json"))?;let policy=Policy::parse(args[2].as_str().ok_or("冲突策略必须是字符串")?)?;Some((id.to_owned(),policy))}else{None};Ok((path,import))
}
pub(crate)async fn call(app:&AppHandle,channel:&str,args:&[Value],_settings:&Value,game_dir:&Path)->Result<Option<Value>>{
    if !matches!(channel,"versions:scanExternal"|"versions:importExternal"){return Ok(None);}
    #[cfg(any(target_os="android",target_os="ios"))]{let _=(app,args,game_dir);return Err("当前移动平台尚未提供外部 Minecraft 目录树授权，不能扫描或导入；单文件授权不等于目录树授权".into());}
    #[cfg(not(any(target_os="android",target_os="ios")))]{
        let (source,import)=request_args(channel,args)?;
        let ledger=Arc::new(Ledger::new());let operation=Arc::new(Operation::new());
        let gate=app.try_state::<crate::lifecycle::Gate>().ok_or("后台生命周期门禁未初始化")?;
        *ledger.request.lock().map_err(|_|"导入生命周期台账不可用")?=Some(gate.enter()?);
        let key=match register(operation.clone(),ledger.clone(),import.as_ref().map(|(id,_)|id.clone())){
            Ok(key)=>key,Err(error)=>{if let Some(request)=ledger.request.lock().map_err(|_|"导入生命周期台账不可用")?.take(){request.finish();}return Err(error);}
        };
        let waiting=Waiting(operation.clone());let app=app.clone();let root=game_dir.to_path_buf();
        let (tx,rx)=tokio::sync::oneshot::channel();
        tokio::spawn(async move{
            let worker_ledger=ledger.clone();let worker_op=operation.clone();
            let child=tokio::spawn(async move{run(app,source,root,import,worker_ledger,worker_op).await});
            let result=supervise(&key,ledger,operation,child).await;let _=tx.send(result);
        });
        let result=rx.await.map_err(|_|"外部版本后台收尾状态未确认".to_owned())?;drop(waiting);result.map(Some)
    }
}
async fn run(app:AppHandle,source_path:PathBuf,target_path:PathBuf,import:Option<(String,Policy)>,ledger:Arc<Ledger>,operation:Arc<Operation>)->Result<Value>{
    let check_op=operation.clone();let check_app=app.clone();let check_path=source_path.clone();
    let check:Check=Arc::new(move||{check_op.check()?;crate::desktop::require_picked_directory(&check_app,&check_path)});
    let open_check=check.clone();let open_source=source_path;let target_copy=target_path.clone();let opening=ledger.clone();
    tokio::task::spawn_blocking(move||{open_check()?;let source=checked_root(&open_source)?;open_check()?;distinct_paths(source.path(),&target_copy)?;*opening.source.lock().map_err(|_|"来源台账不可用")?=Some(source);if target_copy.exists(){*opening.target.lock().map_err(|_|"目标台账不可用")?=Some(checked_root(&target_copy)?);}Ok::<(),String>(())}).await.map_err(|_|"打开外部目录后台任务异常".to_owned())??;
    if let Some((id,_))=&import{
        let job=JobGuard::register(&target_path,id)?;let cancel=job.cancel();if operation.cancel.check().is_err(){cancel.stop();}*operation.job.lock().map_err(|_|"取消台账不可用")?=Some(cancel);*ledger.job.lock().map_err(|_|"任务台账不可用")?=Some(job);
    }
    let lock_check=check.clone();let guard=crate::install_lock::acquire(&target_path,move||lock_check().is_err()).await?;
    *ledger.root.lock().map_err(|_|"导入根锁台账不可用")?=Some(guard);
    let work=ledger.clone();tokio::task::spawn_blocking(move||{
        check()?;if work.target.lock().map_err(|_|"目标台账不可用")?.is_none(){*work.target.lock().map_err(|_|"目标台账不可用")?=Some(checked_root(&target_path)?);}
        execute(&work,&operation,import,&*check)
    }).await.map_err(|_|{ledger.unknown.store(true,Ordering::Release);"外部版本复制后台任务异常；现场状态未知".to_owned()})?
}
fn execute(ledger:&Ledger,operation:&Operation,import:Option<(String,Policy)>,check:&dyn Fn()->Result<()>)->Result<Value>{
    let (source,target)=ledger.roots()?;distinct_roots(&source,&target)?;
    match import{None=>scan(&source,&target,check),Some((id,policy))=>import_under_guard(&source,&target,&id,policy,ledger,operation,check)}
}
async fn supervise(key:&str,ledger:Arc<Ledger>,operation:Arc<Operation>,child:tokio::task::JoinHandle<Result<Value>>)->Result<Value>{
    let mut result=match child.await{Ok(result)=>result,Err(_)=>{ledger.unknown.store(true,Ordering::Release);Err("外部版本后台任务异常；现场与目录锁保持保留".into())}};
    let cleaning=ledger.clone();let cleaning_op=operation.clone();
    match tokio::task::spawn_blocking(move||cleaning.cleanup(&cleaning_op)).await{
        Ok(Ok(()))=>{},Ok(Err(e))=>{ledger.unknown.store(true,Ordering::Release);result=Err(match result{Ok(_)=>e,Err(old)=>format!("{old}；{e}")});},Err(_)=>{ledger.unknown.store(true,Ordering::Release);result=Err("外部版本收尾异常；现场与目录锁保持保留".into());}
    }
    let unknown=ledger.unknown.load(Ordering::Acquire);
    if let Ok(job)=ledger.job.lock(){if let Some(job)=&*job{job.complete(result.as_ref().map(|_|()).map_err(Clone::clone));}}
    if !unknown{
        ledger.stage.lock().map_err(|_|"导入暂存台账不可用")?.take();ledger.backup.lock().map_err(|_|"旧实例台账不可用")?.take();ledger.temps.lock().map_err(|_|"库文件台账不可用")?.clear();
        ledger.source.lock().map_err(|_|"来源台账不可用")?.take();ledger.target.lock().map_err(|_|"目标台账不可用")?.take();ledger.job.lock().map_err(|_|"任务台账不可用")?.take();ledger.root.lock().map_err(|_|"根锁台账不可用")?.take();
        if let Some(request)=ledger.request.lock().map_err(|_|"生命周期台账不可用")?.take(){request.finish();}
        registry().lock().map_err(|_|"任务登记不可用")?.entries.remove(key);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, sync::atomic::AtomicUsize};
    struct Fixture { root:PathBuf, source:PathBuf, target:PathBuf }
    impl Fixture {
        fn new()->Self{let root=std::env::temp_dir().join(format!("hcmcl-external-tests-{}",uuid::Uuid::new_v4()));fs::create_dir_all(root.join("source/versions/demo/saves/world")).unwrap();fs::create_dir_all(root.join("target")).unwrap();let root=fs::canonicalize(root).unwrap();let source=root.join("source");let target=root.join("target");
            fs::write(source.join("versions/demo/demo.json"),br#"{"id":"demo","inheritsFrom":"parent","jar":"parent","clientVersion":"1.20.1","libraries":[{"name":"net.fabricmc:intermediary:1.20.1"}]}"#).unwrap();
            fs::write(source.join("versions/demo/demo.jar"),b"own-client").unwrap();fs::write(source.join("versions/demo/saves/world/level.dat"),b"world").unwrap();
            fs::write(source.join("versions/demo/instance.json"),br#"{"isolation":true,"name":"original"}"#).unwrap();
            fs::create_dir_all(source.join("libraries/group/artifact")).unwrap();fs::write(source.join("libraries/group/artifact/library.jar"),b"library").unwrap();
            fs::create_dir_all(source.join("assets/objects/aa")).unwrap();fs::write(source.join("assets/objects/aa/unused"),b"asset").unwrap();Self{root,source,target}
        }
        fn old(&self){fs::create_dir_all(self.target.join("versions/demo")).unwrap();fs::write(self.target.join("versions/demo/demo.json"),br#"{"id":"old"}"#).unwrap();fs::write(self.target.join("versions/demo/old-data"),b"old").unwrap();}
        fn ledger(&self)->Arc<Ledger>{let ledger=Arc::new(Ledger::new());*ledger.source.lock().unwrap()=Some(Directory::open(&self.source).unwrap());*ledger.target.lock().unwrap()=Some(Directory::open(&self.target).unwrap());ledger}
        fn hidden(&self)->Vec<String>{if !self.target.join("versions").exists(){return Vec::new();}fs::read_dir(self.target.join("versions")).unwrap().map(|e|e.unwrap().file_name().into_string().unwrap()).filter(|n|n.starts_with(".hcmcl-external-")).collect()}
    }
    impl Drop for Fixture{fn drop(&mut self){let _=fs::remove_dir_all(&self.root);}}
    #[test]fn metadata_contract_bad_json_fallback_and_real_sizes(){
        let fixture=Fixture::new();fixture.old();fs::create_dir_all(fixture.source.join("versions/1.19.2-forge-43")).unwrap();fs::write(fixture.source.join("versions/1.19.2-forge-43/1.19.2-forge-43.json"),b"broken").unwrap();
        let source=Directory::open(&fixture.source).unwrap();let target=Directory::open(&fixture.target).unwrap();let value=scan(&source,&target,&||Ok(())).unwrap();let rows=value.as_array().unwrap();assert_eq!(rows.len(),2);
        let demo=rows.iter().find(|v|v["id"]=="demo").unwrap();assert_eq!(demo["mcVersion"],"1.20.1");assert_eq!(demo["loader"],"fabric");assert_eq!(demo["conflict"],true);assert!(demo["size"].as_u64().unwrap()>5);
        let broken=rows.iter().find(|v|v["id"]=="1.19.2-forge-43").unwrap();assert_eq!(broken["size"],6);assert_eq!(broken["mcVersion"],"1.19.2");assert_eq!(broken["loader"],"forge");
        assert_eq!(mc_version(&json!({"clientVersion":null,"inheritsFrom":"1.18.2"}),"fallback"),"1.18.2");assert!(!fixture.source.join(".hcmcl-install.lock").exists());
    }
    #[tokio::test]async fn three_conflict_policies_preserve_source_and_merge_libraries_without_assets_or_parents(){
        for policy in [Policy::Rename,Policy::Overwrite,Policy::Skip]{let fixture=Fixture::new();fixture.old();fs::create_dir_all(fixture.target.join("libraries/group/artifact")).unwrap();fs::write(fixture.target.join("libraries/group/artifact/library.jar"),b"existing-library").unwrap();
            let ledger=fixture.ledger();let operation=Operation::new();let _root=crate::install_lock::acquire(&fixture.target,||false).await.unwrap();let result=execute(&ledger,&operation,Some(("demo".into(),policy)),&||Ok(())).unwrap();ledger.cleanup(&operation).unwrap();
            let id=if policy==Policy::Rename{"demo-2"}else{"demo"};assert_eq!(result["id"],id);assert_eq!(result["action"],if policy==Policy::Rename{"renamed"}else if policy==Policy::Skip{"skipped"}else{"imported"});
            assert_eq!(fs::read(fixture.target.join("libraries/group/artifact/library.jar")).unwrap(),b"existing-library");assert!(!fixture.target.join("assets").exists());assert!(!fixture.target.join("versions/parent").exists());assert!(fixture.hidden().is_empty());
            if policy!=Policy::Skip{let dir=fixture.target.join("versions").join(id);assert_eq!(fs::read(dir.join(format!("{id}.jar"))).unwrap(),b"own-client");assert_eq!(fs::read(dir.join("saves/world/level.dat")).unwrap(),b"world");let profile:Value=serde_json::from_slice(&fs::read(dir.join(format!("{id}.json"))).unwrap()).unwrap();if policy==Policy::Rename{assert_eq!(profile["id"],id);assert!(!dir.join("demo.jar").exists());}assert_eq!(profile["inheritsFrom"],"parent");assert_eq!(profile["jar"],"parent");assert!(crate::modpack::instance_isolated(&fixture.target,id,&json!({})).unwrap());}
            assert_eq!(fs::read(fixture.source.join("versions/demo/demo.jar")).unwrap(),b"own-client");assert_eq!(fs::read(fixture.source.join("versions/demo/saves/world/level.dat")).unwrap(),b"world");
            drop(_root);drop(ledger);
        }
    }
    #[tokio::test]async fn renamed_self_jar_reference_follows_the_moved_root_jar(){
        let fixture=Fixture::new();fixture.old();
        let original=br#"{"id":"demo","jar":"demo","inheritsFrom":"parent"}"#;
        fs::write(fixture.source.join("versions/demo/demo.json"),original).unwrap();
        fs::write(fixture.target.join("versions/demo/demo.jar"),b"conflicting-target-client").unwrap();
        let ledger=fixture.ledger();let operation=Operation::new();let _root=crate::install_lock::acquire(&fixture.target,||false).await.unwrap();
        let result=execute(&ledger,&operation,Some(("demo".into(),Policy::Rename)),&||Ok(())).unwrap();ledger.cleanup(&operation).unwrap();
        assert_eq!(result,json!({"id":"demo-2","action":"renamed"}));
        let dir=fixture.target.join("versions/demo-2");let profile:Value=serde_json::from_slice(&fs::read(dir.join("demo-2.json")).unwrap()).unwrap();
        assert_eq!(profile["id"],"demo-2");assert_eq!(profile["jar"],"demo-2");assert_eq!(profile["inheritsFrom"],"parent");
        assert_eq!(fs::read(dir.join("demo-2.jar")).unwrap(),b"own-client");assert!(!dir.join("demo.jar").exists());
        assert_eq!(fs::read(fixture.target.join("versions/demo/demo.jar")).unwrap(),b"conflicting-target-client");
        assert_eq!(fs::read(fixture.source.join("versions/demo/demo.json")).unwrap(),original);assert_eq!(fs::read(fixture.source.join("versions/demo/demo.jar")).unwrap(),b"own-client");
        assert!(!fixture.target.join("versions/parent").exists());assert!(fixture.hidden().is_empty());
    }
    #[tokio::test]async fn rename_preserves_external_jar_and_parent_references(){
        let fixture=Fixture::new();fixture.old();let original=fs::read(fixture.source.join("versions/demo/demo.json")).unwrap();
        let ledger=fixture.ledger();let operation=Operation::new();let _root=crate::install_lock::acquire(&fixture.target,||false).await.unwrap();
        let result=execute(&ledger,&operation,Some(("demo".into(),Policy::Rename)),&||Ok(())).unwrap();ledger.cleanup(&operation).unwrap();
        assert_eq!(result,json!({"id":"demo-2","action":"renamed"}));let dir=fixture.target.join("versions/demo-2");
        let profile:Value=serde_json::from_slice(&fs::read(dir.join("demo-2.json")).unwrap()).unwrap();
        assert_eq!(profile["id"],"demo-2");assert_eq!(profile["jar"],"parent");assert_eq!(profile["inheritsFrom"],"parent");
        assert_eq!(fs::read(dir.join("demo-2.jar")).unwrap(),b"own-client");assert!(!dir.join("demo.jar").exists());assert!(!fixture.target.join("versions/parent").exists());
        assert_eq!(fs::read(fixture.source.join("versions/demo/demo.json")).unwrap(),original);assert!(fixture.hidden().is_empty());
    }
    #[tokio::test]async fn rename_does_not_retarget_self_jar_without_a_moved_root_jar(){
        let fixture=Fixture::new();fixture.old();let original=br#"{"id":"demo","jar":"demo","inheritsFrom":"parent"}"#;
        fs::write(fixture.source.join("versions/demo/demo.json"),original).unwrap();fs::remove_file(fixture.source.join("versions/demo/demo.jar")).unwrap();
        let ledger=fixture.ledger();let operation=Operation::new();let _root=crate::install_lock::acquire(&fixture.target,||false).await.unwrap();
        let result=execute(&ledger,&operation,Some(("demo".into(),Policy::Rename)),&||Ok(())).unwrap();ledger.cleanup(&operation).unwrap();
        assert_eq!(result,json!({"id":"demo-2","action":"renamed"}));let dir=fixture.target.join("versions/demo-2");
        let profile:Value=serde_json::from_slice(&fs::read(dir.join("demo-2.json")).unwrap()).unwrap();
        assert_eq!(profile["id"],"demo-2");assert_eq!(profile["jar"],"demo");assert_eq!(profile["inheritsFrom"],"parent");assert!(!dir.join("demo-2.jar").exists());assert!(!dir.join("demo.jar").exists());
        assert_eq!(fs::read(fixture.source.join("versions/demo/demo.json")).unwrap(),original);assert!(fixture.hidden().is_empty());
    }
    #[test]fn new_import_copies_missing_libraries_and_keeps_empty_directories(){
        let fixture=Fixture::new();fs::create_dir(fixture.source.join("versions/demo/empty")).unwrap();let ledger=fixture.ledger();let operation=Operation::new();let result=execute(&ledger,&operation,Some(("demo".into(),Policy::Rename)),&||Ok(())).unwrap();ledger.cleanup(&operation).unwrap();assert_eq!(result,json!({"id":"demo","action":"imported"}));assert_eq!(fs::read(fixture.target.join("libraries/group/artifact/library.jar")).unwrap(),b"library");assert!(fixture.target.join("versions/demo/empty").is_dir());assert!(operation.request_cancel().is_err());assert!(fixture.hidden().is_empty());
    }
    #[test]fn revoked_source_before_commit_cleans_real_stage_and_does_not_publish(){
        let fixture=Fixture::new();let ledger=fixture.ledger();let operation=Operation::new();let allowed=AtomicBool::new(true);
        let check=||{operation.check()?;if fixture.target.join("versions").exists(){let has_output=fs::read_dir(fixture.target.join("versions")).unwrap().any(|e|{let e=e.unwrap();e.file_name().to_string_lossy().starts_with(".hcmcl-external-stage-")&&e.path().join("demo.jar").exists()});if has_output{allowed.store(false,Ordering::SeqCst);}}if allowed.load(Ordering::SeqCst){Ok(())}else{Err("测试目录授权已撤销".into())}};
        assert!(execute(&ledger,&operation,Some(("demo".into(),Policy::Rename)),&check).is_err());assert!(!operation.commit.lock().unwrap().committed);ledger.cleanup(&operation).unwrap();assert!(!fixture.target.join("versions/demo").exists());assert!(fixture.hidden().is_empty());
    }
    #[test]fn overwrite_restores_old_tree_when_cancellation_wins_after_backup_move(){
        let fixture=Fixture::new();fixture.old();let ledger=fixture.ledger();let operation=Operation::new();
        let check=||{if fixture.hidden().iter().any(|n|n.starts_with(".hcmcl-external-backup-")){operation.stop();}operation.check()};
        assert!(execute(&ledger,&operation,Some(("demo".into(),Policy::Overwrite)),&check).is_err());assert!(!operation.commit.lock().unwrap().committed);ledger.cleanup(&operation).unwrap();assert_eq!(fs::read(fixture.target.join("versions/demo/old-data")).unwrap(),b"old");assert!(fixture.hidden().is_empty());
    }
    #[test]fn unknown_stage_contents_and_stolen_restore_target_are_never_deleted(){
        let fixture=Fixture::new();let ledger=fixture.ledger();let operation=Operation::new();let versions=ensure_child(&Directory::open(&fixture.target).unwrap(),"versions").unwrap();let mut tree=Tree::pending(versions,".hcmcl-external-stage-fixture".into());tree.create().unwrap();let unknown=tree.root().unwrap().path().join("unknown");fs::write(&unknown,b"foreign").unwrap();*ledger.stage.lock().unwrap()=Some(tree);assert!(ledger.cleanup(&operation).is_err());assert_eq!(fs::read(&unknown).unwrap(),b"foreign");drop(ledger);
        let fixture2=Fixture::new();fixture2.old();let ledger=fixture2.ledger();let operation=Operation::new();let target=Directory::open(&fixture2.target).unwrap();let versions=directory(&target,"versions").unwrap();let mut backup=Tree::snapshot(versions,"demo".into(),&||Ok(())).unwrap();backup.original=Some("demo".into());backup.rename(".hcmcl-external-backup-fixture").unwrap();*ledger.backup.lock().unwrap()=Some(backup);fs::create_dir(fixture2.target.join("versions/demo")).unwrap();fs::write(fixture2.target.join("versions/demo/new-owner"),b"foreign").unwrap();assert!(ledger.cleanup(&operation).is_err());assert_eq!(fs::read(fixture2.target.join("versions/demo/new-owner")).unwrap(),b"foreign");assert_eq!(fs::read(fixture2.target.join("versions/.hcmcl-external-backup-fixture/old-data")).unwrap(),b"old");
    }
    #[test]fn source_changes_aliases_paths_and_limits_fail_before_unsafe_copy(){
        let fixture=Fixture::new();let dir=Directory::open(&fixture.source.join("versions/demo")).unwrap();let plan=TreePlan::collect(dir,&||Ok(())).unwrap();fs::write(fixture.source.join("versions/demo/new-file"),b"late").unwrap();assert!(plan.verify(&||Ok(())).is_err());
        assert!(distinct_paths(&fixture.source,&fixture.source.join("missing/target")).is_err());assert!(!fixture.source.join("missing").exists());
        assert!(request_args("versions:scanExternal",&[]).is_err());assert!(request_args("versions:scanExternal",&[json!("relative/path")]).is_err());assert!(request_args("versions:importExternal",&[json!(fixture.source),json!("demo"),json!("unknown")]).is_err());
        for id in ["../demo","CON","demo/../other",".hcmcl-external-stage-x"]{assert!(request_args("versions:importExternal",&[json!(fixture.source),json!(id),json!("rename")]).is_err());}
        assert!(Policy::parse("delete").is_err());assert!(path_parts("a/../b").is_err());assert!(path_parts("a\\b").is_err());
        fs::write(fixture.source.join("versions/demo/demo-2.jar"),b"conflict").unwrap();let plan=TreePlan::collect(Directory::open(&fixture.source.join("versions/demo")).unwrap(),&||Ok(())).unwrap();assert!(preflight_renamed(&plan,"demo","demo-2").is_err());
    }
    async fn owned_fixture(fixture:&Fixture,gate:&crate::lifecycle::Gate)->(Arc<Ledger>,Arc<Operation>,String){
        let ledger=fixture.ledger();let operation=Arc::new(Operation::new());*ledger.request.lock().unwrap()=Some(gate.enter().unwrap());
        let job=JobGuard::register(&fixture.target,"demo").unwrap();*operation.job.lock().unwrap()=Some(job.cancel());*ledger.job.lock().unwrap()=Some(job);
        let root=crate::install_lock::acquire(&fixture.target,||false).await.unwrap();*ledger.root.lock().unwrap()=Some(root);
        let key=register(operation.clone(),ledger.clone(),Some("demo".into())).unwrap();(ledger,operation,key)
    }
    fn writer_stage(ledger:&Ledger){let (_,target)=ledger.roots().unwrap();let versions=ensure_child(&target,"versions").unwrap();let mut stage=Tree::pending(versions,format!(".hcmcl-external-stage-{}",uuid::Uuid::new_v4()));stage.create().unwrap();*ledger.stage.lock().unwrap()=Some(stage);}
    struct PausedReader { ready:Option<tokio::sync::oneshot::Sender<()>>, barrier:Arc<(Mutex<bool>,std::sync::Condvar)>, bytes:&'static[u8] }
    impl Read for PausedReader {fn read(&mut self,out:&mut[u8])->std::io::Result<usize>{if let Some(ready)=self.ready.take(){let _=ready.send(());let(lock,cv)=&*self.barrier;let hold=lock.lock().unwrap();let(hold,timeout)=cv.wait_timeout_while(hold,std::time::Duration::from_secs(5),|released|!*released).unwrap();if timeout.timed_out()&&!*hold{return Err(std::io::Error::new(std::io::ErrorKind::TimedOut,"测试写入屏障未释放"));}}let count=self.bytes.len().min(out.len());out[..count].copy_from_slice(&self.bytes[..count]);self.bytes=&self.bytes[count..];Ok(count)}}
    struct Release(Arc<(Mutex<bool>,std::sync::Condvar)>);
    impl Drop for Release {fn drop(&mut self){let(lock,cv)=&*self.0;if let Ok(mut released)=lock.lock(){*released=true;cv.notify_all();}}}
    async fn writer_barrier_case(ipc_drop:bool){
        let fixture=Fixture::new();let gate=crate::lifecycle::Gate::default();let(ledger,operation,key)=owned_fixture(&fixture,&gate).await;writer_stage(&ledger);
        let (ready,waiting)=tokio::sync::oneshot::channel();let barrier=Arc::new((Mutex::new(false),std::sync::Condvar::new()));let release=Release(barrier.clone());
        let copying=ledger.clone();let copying_op=operation.clone();let child=tokio::spawn(async move{tokio::task::spawn_blocking(move||{
            let mut slot=copying.stage.lock().unwrap();let stage=slot.as_mut().unwrap();let check=||copying_op.check();
            stage.write("partial.bin",PausedReader{ready:Some(ready),barrier,bytes:b"real-data"},9,&check)?;Ok(Value::Null)
        }).await.map_err(|_|"测试真实写入后台异常".to_owned())?});
        let(supervisor_tx,supervisor_rx)=tokio::sync::oneshot::channel();let supervising=ledger.clone();let supervising_op=operation.clone();let task_key=key.clone();tokio::spawn(async move{let result=supervise(&task_key,supervising,supervising_op,child).await;let _=supervisor_tx.send(result);});
        tokio::time::timeout(std::time::Duration::from_secs(5),waiting).await.unwrap().unwrap();
        if ipc_drop{drop(Waiting(operation.clone()));}else{cancel_download(Some(&format!("external-import:{key}"))).unwrap();}
        assert!(operation.check().is_err());assert!(ledger.job.lock().unwrap().is_some());assert!(ledger.root.lock().unwrap().is_some());assert!(registry().lock().unwrap().entries.contains_key(&key));assert!(gate.begin_restart().is_err());assert!(JobGuard::register(&fixture.target,"demo").is_err());
        let probes=AtomicUsize::new(0);let blocked=crate::install_lock::acquire(&fixture.target,||probes.fetch_add(1,Ordering::SeqCst)>1).await;assert!(blocked.is_err());
        drop(release);let result=tokio::time::timeout(std::time::Duration::from_secs(5),supervisor_rx).await.unwrap().unwrap();assert!(result.is_err());
        assert!(!ledger.unknown.load(Ordering::Acquire));assert!(ledger.job.lock().unwrap().is_none());assert!(ledger.root.lock().unwrap().is_none());assert!(!registry().lock().unwrap().entries.contains_key(&key));assert!(fixture.hidden().is_empty());assert!(!fixture.target.join("versions/demo").exists());
        gate.begin_restart().unwrap();let job=JobGuard::register(&fixture.target,"demo").unwrap();drop(job);let root=crate::install_lock::acquire(&fixture.target,||false).await.unwrap();drop(root);
    }
    #[tokio::test]async fn ipc_drop_keeps_real_writer_job_root_and_lifecycle_until_join_and_cleanup(){writer_barrier_case(true).await;}
    #[tokio::test]async fn explicit_cancel_keeps_real_writer_job_root_and_lifecycle_until_join_and_cleanup(){writer_barrier_case(false).await;}
    #[tokio::test]async fn unknown_cleanup_and_panics_keep_registered_busy_state_after_actual_join(){
        for panic in [false,true]{let fixture=Fixture::new();let gate=crate::lifecycle::Gate::default();let(ledger,operation,key)=owned_fixture(&fixture,&gate).await;writer_stage(&ledger);
            let unknown={let stage=ledger.stage.lock().unwrap();stage.as_ref().unwrap().root().unwrap().path().join("foreign")};if !panic{fs::write(&unknown,b"foreign").unwrap();}
            let child=tokio::spawn(async move{if panic{panic!("测试复制后台异常");}Err("测试复制失败".to_owned())});
            assert!(supervise(&key,ledger.clone(),operation.clone(),child).await.is_err());assert!(ledger.unknown.load(Ordering::Acquire));assert!(ledger.job.lock().unwrap().is_some());assert!(ledger.root.lock().unwrap().is_some());assert!(registry().lock().unwrap().entries.contains_key(&key));assert!(gate.begin_restart().is_err());assert!(JobGuard::register(&fixture.target,"demo").is_err());assert!(relaunch_ready().is_err());
            // 仅夹具回收自己创建的未知文件和保留票据；生产路径不解除未知状态。
            if !panic{assert_eq!(fs::read(&unknown).unwrap(),b"foreign");fs::remove_file(&unknown).unwrap();}ledger.cleanup(&operation).unwrap();ledger.stage.lock().unwrap().take();ledger.backup.lock().unwrap().take();ledger.temps.lock().unwrap().clear();ledger.source.lock().unwrap().take();ledger.target.lock().unwrap().take();ledger.job.lock().unwrap().take();ledger.root.lock().unwrap().take();ledger.request.lock().unwrap().take().unwrap().finish();registry().lock().unwrap().entries.remove(&key);gate.begin_restart().unwrap();
        }
    }
    #[test]fn no_replace_publish_preserves_an_existing_empty_directory(){
        let fixture=Fixture::new();let versions=ensure_child(&Directory::open(&fixture.target).unwrap(),"versions").unwrap();let mut tree=Tree::pending(versions.clone(),".hcmcl-external-stage-noreplace".into());tree.create().unwrap();fs::create_dir(fixture.target.join("versions/occupied")).unwrap();let before=dir_id(&directory(&versions,"occupied").unwrap()).unwrap();assert!(tree.rename("occupied").is_err());assert_eq!(dir_id(&directory(&versions,"occupied").unwrap()).unwrap(),before);tree.cleanup().unwrap();assert!(fixture.target.join("versions/occupied").is_dir());
    }
    #[cfg(unix)]#[test]fn symlinks_hardlinks_and_special_sources_are_rejected(){
        use std::os::unix::fs::symlink;let fixture=Fixture::new();symlink(&fixture.target,fixture.source.join("versions/demo/link")).unwrap();assert!(TreePlan::collect(Directory::open(&fixture.source.join("versions/demo")).unwrap(),&||Ok(())).is_err());fs::remove_file(fixture.source.join("versions/demo/link")).unwrap();fs::hard_link(fixture.source.join("versions/demo/demo.jar"),fixture.source.join("versions/demo/hardlink")).unwrap();assert!(TreePlan::collect(Directory::open(&fixture.source.join("versions/demo")).unwrap(),&||Ok(())).is_err());
    }
}

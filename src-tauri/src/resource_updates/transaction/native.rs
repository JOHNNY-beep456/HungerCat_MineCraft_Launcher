//! 只接受持有的父目录句柄与单个 leaf。Unix *at 没有叶 inode CAS；不保证同 UID 恶意竞争。
use super::{access, Identity, Result};
use access::Directory;
use std::{fs::File, io};

pub(super) fn open(parent: &Directory, leaf: &str, directory: bool, writable: bool, delete: bool) -> io::Result<File> {
    access::leaf(leaf).map_err(io::Error::other)?;
    parent.verify().map_err(io::Error::other)?;
    os::open(parent.handle(), leaf, directory, writable, delete, false)
}
pub(super) fn create(parent: &Directory, leaf: &str) -> Result<File> {
    access::leaf(leaf)?; parent.verify()?;
    os::open(parent.handle(), leaf, false, true, true, true).map_err(|e| format!("无法独占建立事务文件：{e}"))
}
pub(super) fn mkdir(parent: &Directory, leaf: &str) -> Result<File> {
    access::leaf(leaf)?; parent.verify()?;
    os::mkdir(parent.handle(), leaf).map_err(|e| format!("无法独占建立事务目录：{e}"))
}
pub(super) fn sync(parent: &Directory) -> Result<()> {
    parent.verify()?;
    os::sync(parent.handle()).map_err(|e| format!("事务目录同步失败：{e}"))
}
/// 内核 rename 成功后不再执行可失败的后验；调用方记录 applied 并同步两个父目录。
pub(super) fn rename(from: &Directory, name: &str, file: &File, to: &Directory, target: &str) -> Result<()> {
    access::leaf(name)?; access::leaf(target)?; from.verify()?; to.verify()?;
    os::rename(from.handle(), name, file, to.handle(), target).map_err(|e| format!("事务无覆盖移动失败：{e}"))
}
pub(super) fn remove_file(parent: &Directory, leaf: &str, file: File) -> Result<()> {
    access::leaf(leaf)?; parent.verify()?;
    os::remove(parent.handle(), leaf, file, false).map_err(|e| format!("事务自有文件清理失败：{e}"))
}
pub(super) fn remove_dir(parent: &Directory, leaf: &str, expected: &Identity) -> Result<()> {
    let file = open(parent, leaf, true, false, true).map_err(|e| format!("无法打开待清理事务目录：{e}"))?;
    if super::identity(&file, true)? != *expected { return Err("事务目录身份改变，保留现场".into()); }
    os::remove(parent.handle(), leaf, file, true).map_err(|e| format!("事务目录清理失败：{e}"))
}

#[cfg(any(target_os="linux",target_os="android",target_os="macos",target_os="ios"))]
mod os {
    use super::*;
    use std::{ffi::{CString,c_char,c_void},os::fd::{AsRawFd,FromRawFd}};
    #[cfg(any(target_os="macos",target_os="ios"))] const NOFOLLOW:i32=0x100;
    #[cfg(all(any(target_os="linux",target_os="android"),any(target_arch="arm",target_arch="aarch64")))] const NOFOLLOW:i32=0x8000;
    #[cfg(all(any(target_os="linux",target_os="android"),not(any(target_arch="arm",target_arch="aarch64"))))] const NOFOLLOW:i32=0x20000;
    #[cfg(any(target_os="macos",target_os="ios"))] const DIRECTORY:i32=0x100000;
    #[cfg(all(any(target_os="linux",target_os="android"),any(target_arch="arm",target_arch="aarch64")))] const DIRECTORY:i32=0x4000;
    #[cfg(all(any(target_os="linux",target_os="android"),not(any(target_arch="arm",target_arch="aarch64"))))] const DIRECTORY:i32=0x10000;
    #[cfg(any(target_os="macos",target_os="ios"))] const CLOEXEC:i32=0x1000000;
    #[cfg(any(target_os="linux",target_os="android"))] const CLOEXEC:i32=0x80000;
    #[cfg(any(target_os="macos",target_os="ios"))] const EXCLUSIVE:i32=0x200|0x800;
    #[cfg(any(target_os="linux",target_os="android"))] const EXCLUSIVE:i32=0x40|0x80;
    #[cfg(any(target_os="macos",target_os="ios"))] const NONBLOCK:i32=4;
    #[cfg(any(target_os="linux",target_os="android"))] const NONBLOCK:i32=0x800;
    #[cfg(any(target_os="macos",target_os="ios"))] const REMOVEDIR:i32=0x80;
    #[cfg(any(target_os="linux",target_os="android"))] const REMOVEDIR:i32=0x200;
    extern "C" {
        fn openat(fd:i32,name:*const c_char,flags:i32,...)->i32;
        fn mkdirat(fd:i32,name:*const c_char,mode:u32)->i32;
        fn unlinkat(fd:i32,name:*const c_char,flags:i32)->i32;
    }
    fn name(s:&str)->io::Result<CString>{CString::new(s).map_err(|_|io::Error::from(io::ErrorKind::InvalidInput))}
    pub(super) fn open(parent:&File,leaf:&str,directory:bool,writable:bool,_delete:bool,create:bool)->io::Result<File>{
        let leaf=name(leaf)?;
        let flags=NOFOLLOW|CLOEXEC|NONBLOCK|(if directory{DIRECTORY}else{0})|(if writable{2}else{0})|(if create{EXCLUSIVE}else{0});
        let fd=unsafe{openat(parent.as_raw_fd(),leaf.as_ptr(),flags,0o600u32)};
        if fd<0{Err(io::Error::last_os_error())}else{Ok(unsafe{File::from_raw_fd(fd)})}
    }
    pub(super) fn mkdir(parent:&File,leaf:&str)->io::Result<File>{
        let text=name(leaf)?;
        if unsafe{mkdirat(parent.as_raw_fd(),text.as_ptr(),0o700)}<0{return Err(io::Error::last_os_error());}
        open(parent,leaf,true,false,false,false)
    }
    pub(super) fn sync(parent:&File)->io::Result<()>{parent.sync_all()}
    #[cfg(target_os="linux")]
    fn move_noreplace(from:&File,old:&CString,to:&File,new:&CString)->io::Result<()>{
        extern "C"{fn renameat2(a:i32,b:*const c_char,c:i32,d:*const c_char,flags:u32)->i32;}
        if unsafe{renameat2(from.as_raw_fd(),old.as_ptr(),to.as_raw_fd(),new.as_ptr(),1)}==0{Ok(())}else{Err(io::Error::last_os_error())}
    }
    #[cfg(target_os="android")]
    fn move_noreplace(from:&File,old:&CString,to:&File,new:&CString)->io::Result<()>{
        #[link(name="dl")]extern "C"{fn dlsym(handle:*mut c_void,name:*const c_char)->*mut c_void;}
        type Rename=unsafe extern "C" fn(i32,*const c_char,i32,*const c_char,u32)->i32;
        #[cfg(target_pointer_width="64")]let handle=std::ptr::null_mut();
        #[cfg(target_pointer_width="32")]let handle=usize::MAX as *mut c_void;
        let symbol=unsafe{dlsym(handle,b"renameat2\0".as_ptr().cast())};
        if symbol.is_null(){return Err(io::Error::from(io::ErrorKind::Unsupported));}
        let call:Rename=unsafe{std::mem::transmute(symbol)};
        if unsafe{call(from.as_raw_fd(),old.as_ptr(),to.as_raw_fd(),new.as_ptr(),1)}==0{Ok(())}else{Err(io::Error::last_os_error())}
    }
    #[cfg(any(target_os="macos",target_os="ios"))]
    fn move_noreplace(from:&File,old:&CString,to:&File,new:&CString)->io::Result<()>{
        extern "C"{fn renameatx_np(a:i32,b:*const c_char,c:i32,d:*const c_char,flags:u32)->i32;}
        if unsafe{renameatx_np(from.as_raw_fd(),old.as_ptr(),to.as_raw_fd(),new.as_ptr(),4)}==0{Ok(())}else{Err(io::Error::last_os_error())}
    }
    pub(super) fn rename(from:&File,leaf:&str,file:&File,to:&File,target:&str)->io::Result<()>{
        // 核验的是同一文件描述符及当前 leaf；no-replace 保证不覆盖并发 winner。
        let current=open(from,leaf,false,false,false,false)?;
        if super::super::identity(&current,false).map_err(io::Error::other)?!=super::super::identity(file,false).map_err(io::Error::other)?{
            return Err(io::Error::other("源文件身份改变"));
        }
        move_noreplace(from,&name(leaf)?,to,&name(target)?)
    }
    pub(super) fn remove(parent:&File,leaf:&str,file:File,directory:bool)->io::Result<()>{
        let current=open(parent,leaf,directory,false,false,false)?;
        if super::super::identity(&current,directory).map_err(io::Error::other)?!=super::super::identity(&file,directory).map_err(io::Error::other)?{
            return Err(io::Error::other("待清理文件身份改变"));
        }
        if unsafe{unlinkat(parent.as_raw_fd(),name(leaf)?.as_ptr(),if directory{REMOVEDIR}else{0})}<0{Err(io::Error::last_os_error())}else{Ok(())}
    }
}

#[cfg(windows)]
mod os{
    use super::*;
    use std::{ffi::c_void,os::windows::io::{AsRawHandle,FromRawHandle}};
    type Handle=*mut c_void;
    #[repr(C)]struct UnicodeString{length:u16,maximum:u16,buffer:*mut u16}
    #[repr(C)]struct ObjectAttributes{length:u32,root:Handle,name:*mut UnicodeString,attributes:u32,security:*mut c_void,qos:*mut c_void}
    #[repr(C)]struct IoStatus{status:isize,information:usize}
    #[repr(C)]struct RenameInfo{replace:u8,root:Handle,length:u32,name:[u16;1]}
    #[link(name="ntdll")]extern "system"{
        fn NtCreateFile(out:*mut Handle,access:u32,attrs:*mut ObjectAttributes,status:*mut IoStatus,allocation:*const i64,attributes:u32,share:u32,disposition:u32,options:u32,ea:*mut c_void,ea_len:u32)->i32;
        fn RtlNtStatusToDosError(status:i32)->u32;
        fn NtSetInformationFile(file:Handle,status:*mut IoStatus,info:*mut c_void,size:u32,class:i32)->i32;
        fn NtFlushBuffersFile(file:Handle,status:*mut IoStatus)->i32;
    }
    #[link(name="kernel32")]extern "system"{
        fn SetFileInformationByHandle(file:Handle,class:i32,info:*mut c_void,size:u32)->i32;
    }
    pub(super) fn open(parent:&File,leaf:&str,directory:bool,writable:bool,delete:bool,create:bool)->io::Result<File>{
        let mut wide=leaf.encode_utf16().collect::<Vec<_>>();
        let length=u16::try_from(wide.len().checked_mul(2).ok_or(io::ErrorKind::InvalidInput)?).map_err(|_|io::ErrorKind::InvalidInput)?;
        let mut text=UnicodeString{length,maximum:length,buffer:wide.as_mut_ptr()};
        let mut attrs=ObjectAttributes{length:std::mem::size_of::<ObjectAttributes>()as u32,root:parent.as_raw_handle(),name:&mut text,attributes:0x40,security:std::ptr::null_mut(),qos:std::ptr::null_mut()};
        let mut status=IoStatus{status:0,information:0};let mut handle=std::ptr::null_mut();
        // 目录使用具体的目录权限，不能套用含 FILE_WRITE_DATA 的 GENERIC_WRITE 文件映射。
        let access=if directory{0x00100000|0x1|0x20|0x80|(if writable{0x2|0x4}else{0})|(if delete{0x10000}else{0})}
            else{0x80000000|0x00100000|(if writable{0x40000000}else{0})|(if delete{0x10000}else{0})};
        // 普通文件写入使用 write-through；目录链始终不共享 DELETE。
        let options=0x20|0x200000|(if writable&&!directory{2}else{0})|(if directory{1}else{0x40});
        let result=unsafe{NtCreateFile(&mut handle,access,&mut attrs,&mut status,std::ptr::null(),0,if directory{3}else{1},if create{2}else{1},options,std::ptr::null_mut(),0)};
        if result<0{return Err(io::Error::from_raw_os_error(unsafe{RtlNtStatusToDosError(result)}as i32));}
        Ok(unsafe{File::from_raw_handle(handle)})
    }
    pub(super) fn mkdir(parent:&File,leaf:&str)->io::Result<File>{open(parent,leaf,true,true,false,true)}
    pub(super) fn sync(parent:&File)->io::Result<()>{
        // 空的相对 NT 名称重新打开同一个 held 目录，不经由可变绝对路径。
        // ReOpenFile 对目录返回 ACCESS_DENIED；使用 FILE_ADD_FILE | SYNCHRONIZE 获取 flush 所需权限。
        let mut empty=0u16;let mut text=UnicodeString{length:0,maximum:0,buffer:&mut empty};
        let mut attrs=ObjectAttributes{length:std::mem::size_of::<ObjectAttributes>()as u32,root:parent.as_raw_handle(),name:&mut text,attributes:0x40,security:std::ptr::null_mut(),qos:std::ptr::null_mut()};
        let mut status=IoStatus{status:0,information:0};let mut raw=std::ptr::null_mut();
        let result=unsafe{NtCreateFile(&mut raw,0x00100000|0x2|0x80,&mut attrs,&mut status,std::ptr::null(),0,3,1,0x21|0x200000,std::ptr::null_mut(),0)};
        if result<0{return Err(io::Error::from_raw_os_error(unsafe{RtlNtStatusToDosError(result)}as i32));}
        let directory=unsafe{File::from_raw_handle(raw)};
        if super::super::identity(parent,true).map_err(io::Error::other)?!=super::super::identity(&directory,true).map_err(io::Error::other)?{return Err(io::Error::other("目录同步句柄身份不符"));}
        let result=unsafe{NtFlushBuffersFile(directory.as_raw_handle(),&mut status)};
        if result<0{Err(io::Error::from_raw_os_error(unsafe{RtlNtStatusToDosError(result)}as i32))}else{Ok(())}
    }
    pub(super) fn rename(_from:&File,_leaf:&str,file:&File,to:&File,target:&str)->io::Result<()>{
        let wide=target.encode_utf16().collect::<Vec<_>>();let offset=std::mem::offset_of!(RenameInfo,name);
        let size=offset.checked_add(wide.len().checked_mul(2).ok_or(io::ErrorKind::InvalidInput)?).ok_or(io::ErrorKind::InvalidInput)?.max(std::mem::size_of::<RenameInfo>());
        let mut memory=vec![0usize;(size+std::mem::size_of::<usize>()-1)/std::mem::size_of::<usize>()];
        let info=memory.as_mut_ptr().cast::<RenameInfo>();let mut status=IoStatus{status:0,information:0};
        unsafe{(*info).replace=0;(*info).root=to.as_raw_handle();(*info).length=u32::try_from(wide.len()*2).map_err(|_|io::ErrorKind::InvalidInput)?;
            std::ptr::copy_nonoverlapping(wide.as_ptr(),memory.as_mut_ptr().cast::<u8>().add(offset).cast::<u16>(),wide.len());}
        let result=unsafe{NtSetInformationFile(file.as_raw_handle(),&mut status,info.cast(),u32::try_from(size).map_err(|_|io::ErrorKind::InvalidInput)?,10)};
        if result<0{Err(io::Error::from_raw_os_error(unsafe{RtlNtStatusToDosError(result)}as i32))}else{Ok(())}
    }
    pub(super) fn remove(_parent:&File,_leaf:&str,file:File,_directory:bool)->io::Result<()>{
        let mut delete=1u8;
        if unsafe{SetFileInformationByHandle(file.as_raw_handle(),4,(&mut delete as *mut u8).cast(),1)}==0{Err(io::Error::last_os_error())}else{Ok(())}
    }
}
#[cfg(not(any(windows,target_os="linux",target_os="android",target_os="macos",target_os="ios")))]
mod os{
    use super::*;
    pub(super)fn open(_:&File,_:&str,_:bool,_:bool,_:bool,_:bool)->io::Result<File>{Err(io::ErrorKind::Unsupported.into())}
    pub(super)fn mkdir(_:&File,_:&str)->io::Result<File>{Err(io::ErrorKind::Unsupported.into())}
    pub(super)fn sync(_:&File)->io::Result<()>{Err(io::ErrorKind::Unsupported.into())}
    pub(super)fn rename(_:&File,_:&str,_:&File,_:&File,_:&str)->io::Result<()>{Err(io::ErrorKind::Unsupported.into())}
    pub(super)fn remove(_:&File,_:&str,_:File,_:bool)->io::Result<()>{Err(io::ErrorKind::Unsupported.into())}
}

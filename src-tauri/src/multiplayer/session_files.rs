//! 仅复制正式 core 到应用私有的随机会话目录；不复用用户提供的路径或旧程序。
use std::{fs::{self,File,OpenOptions},io::{Read,Write,Seek,SeekFrom},path::{Path,PathBuf},sync::atomic::{AtomicBool,Ordering}};
use std::os::windows::fs::OpenOptionsExt;
use sha2::{Digest,Sha512};
type Result<T> = std::result::Result<T,String>;
fn failure()->String { "EasyTier 私有运行目录或复制失败 / EasyTier 私有執行目錄或複製失敗 / EasyTier private runtime preparation failed".into() }
fn directory(path:&Path)->Result<()> {
    if !path.is_absolute() { return Err(failure()); }
    match fs::symlink_metadata(path) {
        Ok(_)=>super::resources::check_directory(path).map_err(|_|failure()),
        Err(e) if e.kind()==std::io::ErrorKind::NotFound=>{
            directory(path.parent().ok_or_else(failure)?)?;
            match fs::create_dir(path) { Ok(())=>{},Err(e) if e.kind()==std::io::ErrorKind::AlreadyExists=>{},Err(_)=>return Err(failure()) }
            super::resources::check_directory(path).map_err(|_|failure())
        },Err(_)=>Err(failure()),
    }
}
pub(super) struct Files {
    pub directory:PathBuf,pub program:PathBuf,held:Option<File>,
    mark:Option<super::access::DirectoryMark>,anchor:Option<super::access::Directory>,parent:super::access::Directory,
}
impl Files {
    pub fn create(root:&Path)->Result<Self> {
        directory(root)?;
        let parent=super::access::Directory::open(root)?;
        let path=root.join(format!("session-{}",uuid::Uuid::new_v4()));
        fs::create_dir(&path).map_err(|_|failure())?;
        // 失败时也保留目录 owner。只在创建阶段捕获身份，不在重试时接管替换目录。
        let anchor=super::access::Directory::open(&path).ok();
        let mark=anchor.as_ref().map(|directory|directory.mark());
        Ok(Self {program:path.join("easytier-core.exe"),directory:path,held:None,mark,anchor,parent})
    }
    pub fn copy_core(&mut self,source:&Path,cancel:&AtomicBool)->Result<()> {
        self.parent.verify()?;
        self.anchor.as_ref().ok_or_else(failure)?.verify()?;
        self.mark.as_ref().ok_or_else(failure)?.verify()?;
        let own=self;
        (||->Result<()> {
            let source_anchor=super::access::Directory::open(source)?;
            let mut input=super::resources::open_core(source)?;
            source_anchor.verify()?;
            let length=input.metadata().map_err(|_|failure())?.len();
            let mut output=OpenOptions::new().write(true).create_new(true).share_mode(0).open(&own.program).map_err(|_|failure())?;
            let mut digest=Sha512::new(); let mut buffer=[0u8;65536]; let mut count=0u64;
            loop {
                if cancel.load(Ordering::Acquire) { return Err("联机启动已取消 / 連線啟動已取消 / Multiplayer startup cancelled".into()); }
                let n=input.read(&mut buffer).map_err(|_|failure())?; if n==0 {break;}
                count=count.saturating_add(n as u64); if count>512*1024*1024 {return Err(failure());}
                output.write_all(&buffer[..n]).map_err(|_|failure())?;digest.update(&buffer[..n]);
            }
            if count!=length {return Err(failure());} output.sync_all().map_err(|_|failure())?;drop(output);
            let mut held=OpenOptions::new().read(true).share_mode(1).custom_flags(0x00200000).open(&own.program).map_err(|_|failure())?;
            use std::os::windows::fs::MetadataExt;
            let metadata=held.metadata().map_err(|_|failure())?;
            if !metadata.is_file() || metadata.file_attributes()&0x400!=0 || metadata.len()!=length {return Err(failure());}
            let expected=digest.finalize();let mut digest=Sha512::new();
            loop {if cancel.load(Ordering::Acquire) {return Err(failure());}let n=held.read(&mut buffer).map_err(|_|failure())?;if n==0{break;}digest.update(&buffer[..n]);}
            if digest.finalize().as_slice()!=expected.as_slice(){return Err(failure());}
            held.seek(SeekFrom::Start(0)).map_err(|_|failure())?;
            own.held=Some(held);Ok(())
        })()
    }
    pub fn verify(&self)->Result<()> {
        self.parent.verify()?;
        self.anchor.as_ref().ok_or_else(failure)?.verify()?;
        self.mark.as_ref().ok_or_else(failure)?.verify()?;
        let metadata=self.held.as_ref().ok_or_else(failure)?.metadata().map_err(|_|failure())?;
        use std::os::windows::fs::MetadataExt;
        if !metadata.is_file() || metadata.file_attributes()&0x400!=0 {return Err(failure());}Ok(())
    }
    pub fn cleanup(&mut self)->Result<()> {
        self.held.take();
        self.parent.verify()?;
        match fs::symlink_metadata(&self.directory) {
            Err(error) if error.kind()==std::io::ErrorKind::NotFound=>return Ok(()),
            Err(_)=>return Err(failure()),Ok(_)=>{},
        }
        self.mark.as_ref().ok_or_else(failure)?.verify()?;
        self.anchor.take();
        // 仅同一 UUID 目录身份；remove_dir_all 不跟随内部符号链接。不清理其它会话。
        fs::remove_dir_all(&self.directory).map_err(|_|failure())
    }
}
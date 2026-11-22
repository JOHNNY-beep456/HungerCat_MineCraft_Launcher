//! Tauri 壁纸：受控选图、私有复制、无覆盖发布和设置比较提交。
//! 所有文件副作用都留在真实阻塞 worker 内，清理未确认或 panic 时保留生命周期门禁。
use base64::Engine as _;
use serde_json::{json, Value};
use std::{fs::{self, File}, io::{Cursor, Read, Write}, path::{Path, PathBuf}, sync::Arc};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use crate::{downloads, storage};

type Result<T> = std::result::Result<T, String>;
#[allow(dead_code)]
#[path = "modpack/access.rs"]
mod access;
use access::{Directory, OpenedFile};

const MAX_SIZE: u64 = 8 * 1024 * 1024;
const GIF_MAX_SIZE: u64 = 32 * 1024 * 1024;
const MAX_EDGE: u32 = 2560;
const MAX_INPUT_BYTES: u64 = 128 * 1024 * 1024;
const MAX_PIXELS: u64 = 256 * 1024 * 1024;
const MAX_DECODE_ALLOC: u64 = 512 * 1024 * 1024;
// 明确列出 C 符号的终止字节，避免把反斜杠和数字 0 传入 dlsym。
#[cfg(any(target_os="android",test))]
const RENAMEAT2_SYMBOL: &[u8; 10] = &[114,101,110,97,109,101,97,116,50,0];
const MIME: &[(&str, &str)] = &[("png","image/png"),("jpg","image/jpeg"),("jpeg","image/jpeg"),("webp","image/webp"),("gif","image/gif"),("bmp","image/bmp")];
thread_local! { static WALLPAPER_LANGUAGE: std::cell::RefCell<String> = std::cell::RefCell::new("zh-CN".into()); }
fn with_language<T>(language:&str,work:impl FnOnce()->T)->T{
    struct Restore(String);
    impl Drop for Restore{fn drop(&mut self){WALLPAPER_LANGUAGE.with(|value|*value.borrow_mut()=std::mem::take(&mut self.0));}}
    let _restore=Restore(WALLPAPER_LANGUAGE.with(|value|value.replace(language.to_owned())));work()
}
fn tr(cn: &str, tw: &str, en: &str) -> String { WALLPAPER_LANGUAGE.with(|value|{let language=value.borrow();if language.as_str()=="en"||language.starts_with("en-")||language.starts_with("en_"){en.into()}else if language.as_str()=="zh-TW"||language.starts_with("zh_TW")||language.starts_with("zh-HK"){tw.into()}else{cn.into()}}) }
fn storage_language<R:Runtime>(app:&AppHandle<R>)->String{app.try_state::<storage::Storage>().and_then(|state|state.settings_for_backend().ok()).and_then(|settings|settings.get("language").and_then(Value::as_str).map(str::to_owned)).unwrap_or_else(||"zh-CN".into())}
fn invalid_image() -> String { tr("无法读取该图片，请换一张再试", "無法讀取此圖片，請換一張再試", "Unable to read this image; choose another one") }
fn too_large() -> String { tr("图片超过安全大小限制", "圖片超過安全大小限制", "The image exceeds the safety size limit") }
fn file_error() -> String { tr("壁纸文件操作失败，请重试", "桌布檔案操作失敗，請重試", "Wallpaper file operation failed; retry") }
fn cleanup_error() -> String { tr("壁纸收尾状态未确认，已保留现场，请重启后检查", "桌布收尾狀態未確認，已保留現場，請重新啟動後檢查", "Wallpaper cleanup is unconfirmed; retained files require inspection after restart") }
fn cancelled() -> String { tr("壁纸操作已取消", "桌布操作已取消", "Wallpaper operation was cancelled") }
fn invalid_state() -> String { tr("壁纸设置状态无效，请重新选择", "桌布設定狀態無效，請重新選取", "Wallpaper settings are invalid; select an image again") }
fn unsupported() -> String { tr("当前平台不支持安全壁纸存储", "目前平台不支援安全桌布儲存", "Secure wallpaper storage is unavailable on this platform") }
fn check_cancel(cancel: &downloads::Cancel) -> Result<()> { cancel.check().map_err(|_| cancelled()) }
fn mime(ext: &str) -> Option<&'static str> { MIME.iter().find(|(key,_)| *key == ext).map(|(_,value)| *value) }
fn extension(path: &Path) -> Result<String> {
    let ext = path.extension().and_then(|v|v.to_str()).ok_or_else(invalid_image)?.to_ascii_lowercase();
    mime(&ext).ok_or_else(invalid_image)?; Ok(ext)
}
fn image_format(ext: &str) -> Result<image::ImageFormat> {
    match ext { "png"=>Ok(image::ImageFormat::Png), "jpg"|"jpeg"=>Ok(image::ImageFormat::Jpeg), "webp"=>Ok(image::ImageFormat::WebP), "gif"=>Ok(image::ImageFormat::Gif), "bmp"=>Ok(image::ImageFormat::Bmp), _=>Err(invalid_image()) }
}
fn dimension_limit(width: u32, height: u32) -> Result<()> {
    if width == 0 || height == 0 || u64::from(width).checked_mul(u64::from(height)).unwrap_or(u64::MAX) > MAX_PIXELS { Err(too_large()) } else { Ok(()) }
}
fn read_held(mut held: OpenedFile, limit: u64, cancel: Option<&downloads::Cancel>) -> Result<Vec<u8>> {
    held.verify().map_err(|_|invalid_image())?;
    let size = held.file.metadata().map_err(|_|invalid_image())?.len();
    if size > limit { return Err(too_large()); }
    let mut bytes = Vec::new();
    // 同一持有句柄至多读取 limit+1 字节，不依据路径重新打开源文件。
    let mut bounded = (&mut held.file).take(limit + 1);
    let mut chunk = [0u8;65536];
    loop {
        if let Some(cancel) = cancel { check_cancel(cancel)?; }
        let n = bounded.read(&mut chunk).map_err(|_|invalid_image())?;
        if n == 0 { break; }
        if bytes.len() as u64 + n as u64 > limit { return Err(too_large()); }
        bytes.extend_from_slice(&chunk[..n]);
    }
    drop(bounded);
    held.verify().map_err(|_|invalid_image())?;
    if bytes.len() as u64 != size { return Err(invalid_image()); }
    Ok(bytes)
}
struct Prepared { bytes: Vec<u8>, ext: String }
fn normalize(bytes: Vec<u8>, ext: &str, cancel: &downloads::Cancel) -> Result<Prepared> {
    check_cancel(cancel)?;
    let format = image_format(ext)?;
    if bytes.len() as u64 > if ext == "gif" { GIF_MAX_SIZE } else { MAX_INPUT_BYTES } { return Err(too_large()); }
    if image::guess_format(&bytes).map_err(|_|invalid_image())? != format { return Err(invalid_image()); }
    // 先只读取格式尺寸，再为完整解码设置轴限制和内存预算，避免先分配后拒绝。
    let (width,height) = image::io::Reader::with_format(Cursor::new(&bytes),format).into_dimensions().map_err(|_|invalid_image())?;
    dimension_limit(width,height)?;
    if bytes.len() as u64 <= MAX_SIZE || ext == "gif" { return Ok(Prepared {bytes,ext:ext.into()}); }
    let mut limits = image::io::Limits::default();
    limits.max_image_width = Some(width);
    limits.max_image_height = Some(height);
    // image 0.24 的 max_alloc 为尽力限制；不能声称所有 codec 都提供硬内存隔离。
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    let mut reader = image::io::Reader::with_format(Cursor::new(&bytes),format);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|_|invalid_image())?;
    check_cancel(cancel)?;
    dimension_limit(decoded.width(),decoded.height())?;
    let scaled = if decoded.width().max(decoded.height()) > MAX_EDGE { decoded.resize(MAX_EDGE,MAX_EDGE,image::imageops::FilterType::Triangle) } else { decoded };
    if ext == "png" {
        let mut encoded = Cursor::new(Vec::new());
        scaled.write_to(&mut encoded,image::ImageFormat::Png).map_err(|_|invalid_image())?;
        let bytes = encoded.into_inner();
        if bytes.len() as u64 <= MAX_SIZE { check_cancel(cancel)?; return Ok(Prepared {bytes,ext:"png".into()}); }
    }
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes,85).encode_image(&scaled).map_err(|_|invalid_image())?;
    check_cancel(cancel)?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_SIZE { return Err(too_large()); }
    Ok(Prepared {bytes,ext:"jpg".into()})
}
fn owned_name(name: &str) -> Option<String> {
    access::leaf(name).ok()?;
    let (stem,ext) = name.rsplit_once('.')?;
    if stem.len()!=42 || !stem.starts_with("wallpaper-") || !stem[10..].bytes().all(|b|b.is_ascii_hexdigit()) { return None; }
    let ext=ext.to_ascii_lowercase(); mime(&ext).map(|_|ext)
}
fn wallpaper_dir(root: &Path) -> Result<Directory> {
    let root = Directory::open(root).map_err(|_|file_error())?;
    if root.child("wallpapers").map_err(|_|file_error())?.is_none() {
        root.verify().map_err(|_|file_error())?;
        match native::mkdir(root.handle(),"wallpapers") { Ok(())=>{}, Err(e) if e.kind()==std::io::ErrorKind::AlreadyExists=>{}, Err(_)=>return Err(file_error()) }
    }
    let node=root.child("wallpapers").map_err(|_|file_error())?.ok_or_else(file_error)?;
    root.directory(node).map_err(|_|file_error())
}
#[derive(Clone,Debug,PartialEq,Eq)]
struct Identity(u64,u64);
#[cfg(unix)]
fn identity(file: &File) -> Result<Identity> {
    use std::os::unix::fs::MetadataExt;
    let meta=file.metadata().map_err(|_|file_error())?;
    if access::linked(&meta)||!meta.is_file()||meta.nlink()!=1 {return Err(file_error());}
    Ok(Identity(meta.dev(),meta.ino()))
}
#[cfg(windows)]
fn identity(file: &File) -> Result<Identity> {
    use std::{ffi::c_void,os::windows::io::AsRawHandle};
    #[repr(C)]struct Info{attributes:u32,created:[u32;2],accessed:[u32;2],modified:[u32;2],volume:u32,size_hi:u32,size_lo:u32,links:u32,index_hi:u32,index_lo:u32}
    #[link(name="kernel32")]extern "system"{fn GetFileInformationByHandle(file:*mut c_void,info:*mut Info)->i32;}
    let mut info:Info=unsafe{std::mem::zeroed()};
    let meta=file.metadata().map_err(|_|file_error())?;
    if !meta.is_file()||access::linked(&meta)||unsafe{GetFileInformationByHandle(file.as_raw_handle(),&mut info)}==0||info.links!=1 {return Err(file_error());}
    Ok(Identity(info.volume as u64,(info.index_hi as u64)<<32|info.index_lo as u64))
}
#[cfg(not(any(unix,windows)))]fn identity(_: &File)->Result<Identity>{Err(unsupported())}
struct Owned {name:String,id:Identity}
fn old_file(dir:&Directory,name:&str)->Result<Option<Owned>> {
    if owned_name(name).is_none(){return Ok(None);}
    dir.verify().map_err(|_|file_error())?;
    let Some(node)=dir.child(name).map_err(|_|file_error())? else{return Ok(None)};
    if !node.meta.is_file(){return Err(file_error());}
    drop(node);
    let source=dir.source(name).map_err(|_|file_error())?;
    let held=source.open().map_err(|_|file_error())?;
    held.verify().map_err(|_|file_error())?;
    Ok(Some(Owned{name:name.into(),id:identity(&held.file)?}))
}
fn remove_owned(dir:&Directory,owned:&Owned)->Result<()> {
    dir.verify().map_err(|_|file_error())?;
    native::remove(dir.handle(),&owned.name,&owned.id)?;
    dir.verify().map_err(|_|file_error())
}
// ledger 在创建后立刻持有文件，发布后立刻更新名称，后验失败也不会遗失所属对象。
struct Stage {dir:Directory,name:String,target:String,file:Option<File>,id:Option<Identity>,owned:bool}
impl Drop for Stage{fn drop(&mut self){if self.owned{let _=self.cleanup();}}}
impl Stage {
    fn new(dir:&Directory,target:String)->Result<Self>{
        if owned_name(&target).is_none(){return Err(invalid_state());}
        dir.verify().map_err(|_|file_error())?;
        Ok(Self{dir:dir.clone(),name:format!(".hcmcl-wallpaper-{}.part",uuid::Uuid::new_v4().simple()),target,file:None,id:None,owned:false})
    }
    fn initialize(&mut self)->Result<()> {
        self.dir.verify().map_err(|_|file_error())?;
        let file=native::new_file(self.dir.handle(),&self.name).map_err(|_|file_error())?;
        self.file=Some(file);self.owned=true;
        self.id=Some(identity(self.file.as_ref().ok_or_else(file_error)?)?);
        self.verify()
    }
    fn verify(&self)->Result<()> {
        self.dir.verify().map_err(|_|file_error())?;
        let expected=self.id.as_ref().ok_or_else(cleanup_error)?;
        if identity(self.file.as_ref().ok_or_else(cleanup_error)?)?!=*expected{return Err(cleanup_error());}
        #[cfg(not(windows))]
        {
            let current=native::existing(self.dir.handle(),&self.name).map_err(|_|file_error())?;
            if identity(&current)?!=*expected{return Err(cleanup_error());}
        }
        // Windows 暂存句柄不共享删除/写入，路径无法被替换；仅校验该独占句柄身份。
        Ok(())
    }
    fn write_publish(&mut self,bytes:&[u8],cancel:&downloads::Cancel)->Result<()> {
        self.initialize()?;
        let file=self.file.as_mut().ok_or_else(file_error)?;
        for chunk in bytes.chunks(65536){check_cancel(cancel)?;file.write_all(chunk).map_err(|_|file_error())?;}
        file.sync_all().map_err(|_|file_error())?;
        check_cancel(cancel)?;self.verify()?;
        native::publish(self.dir.handle(),self.file.as_ref().ok_or_else(file_error)?,&self.name,&self.target,self.id.as_ref().ok_or_else(file_error)?)?;
        // 内核发布成功至 ledger 更新之间不能插入可失败操作。
        self.name=self.target.clone();
        self.verify()
    }
    fn cleanup(&mut self)->Result<()> {
        if !self.owned{return Ok(());}
        self.verify()?;
        let file=self.file.take().ok_or_else(cleanup_error)?;
        native::remove_open(self.dir.handle(),&self.name,file,self.id.as_ref().ok_or_else(cleanup_error)?)?;
        self.owned=false;
        self.dir.verify().map_err(|_|cleanup_error())
    }
    fn commit(&mut self){self.owned=false;self.file.take();}
}
fn finish_cleanup<T>(stage:&mut Stage,result:Result<T>)->(Result<T>,bool){
    match stage.cleanup(){Ok(())=>(result,true),Err(_)=>(Err(cleanup_error()),false)}
}
fn replace_prepared<T>(dir:&Directory,old:Option<Owned>,prepared:&Prepared,cancel:&downloads::Cancel,commit:impl FnOnce(&str)->Result<T>,after_publish:impl FnOnce())->(Result<T>,bool){
    let target=format!("wallpaper-{}.{}",uuid::Uuid::new_v4().simple(),prepared.ext);
    let mut stage=match Stage::new(dir,target){Ok(s)=>s,Err(e)=>return(Err(e),true)};
    if let Err(e)=stage.write_publish(&prepared.bytes,cancel){return finish_cleanup(&mut stage,Err(e));}
    after_publish();
    if let Err(e)=check_cancel(cancel){return finish_cleanup(&mut stage,Err(e));}
    let value=match commit(&stage.target){Ok(value)=>value,Err(e)=>return finish_cleanup(&mut stage,Err(e))};
    stage.commit();
    if let Some(old)=old{if remove_owned(dir,&old).is_err(){return(Err(cleanup_error()),false);}}
    (Ok(value),true)
}
fn complete_worker<T>(request:crate::lifecycle::Request,work:impl FnOnce()->(Result<T>,bool))->Result<T>{
    let(result,confirmed)=work();
    if confirmed{request.finish();}
    result
}
struct CancelOnDrop(Arc<downloads::Cancel>);
impl Drop for CancelOnDrop{fn drop(&mut self){self.0.stop();}}
fn require_picked<R:Runtime>(app:&AppHandle<R>,path:&Path)->Result<()>{
    #[cfg(target_os="android")] {crate::mobile_files::require_imported_file(app,path)}
    #[cfg(target_os="ios")] {let _=(app,path);Err(unsupported())}
    #[cfg(not(any(target_os="android",target_os="ios")))] {crate::desktop::require_picked_file(app,path)}
}
async fn pick_path<R:Runtime>(app:&AppHandle<R>,window:&WebviewWindow<R>,language:&str)->Result<Option<PathBuf>>{
    #[cfg(target_os="ios")]
    {let _=(app,window);Err(with_language(language,unsupported))}
    #[cfg(not(target_os="ios"))]
    {
        let filters=json!([{"name":"图片 / 圖片 / Images","extensions":["png","jpg","jpeg","webp","gif","bmp"]}]);
        let args=[filters];
        #[cfg(target_os="android")]let value=crate::mobile_files::call(app,window,"shell:pickFile",&args).await?;
        #[cfg(not(any(target_os="android",target_os="ios")))]let value=crate::desktop::call(app,window,"shell:pickFile",&args).await?;
        match value{Some(Value::Null)=>Ok(None),Some(Value::String(path))=>Ok(Some(PathBuf::from(path))),_=>Err(with_language(language,unsupported))}
    }
}
async fn pick<R:Runtime>(app:&AppHandle<R>,window:&WebviewWindow<R>)->Result<Value>{
    let cancel=Arc::new(downloads::Cancel::default());let _cancel_on_drop=CancelOnDrop(cancel.clone());
    let language=storage_language(app);
    let Some(source)=pick_path(app,window,&language).await? else{return app.state::<storage::Storage>().settings_for_backend()};
    let(expected,root)={let state=app.state::<storage::Storage>();let settings=state.settings_for_backend()?;(settings.get("backgroundImage").and_then(Value::as_str).unwrap_or("").to_owned(),state.data_root_for_backend())};
    require_picked(app,&source)?;
    let handle=app.clone();let request=app.state::<crate::lifecycle::Gate>().enter()?;let join_language=language.clone();
    tauri::async_runtime::spawn_blocking(move||with_language(&language,||complete_worker(request,||{
        let prepared=(||{
            check_cancel(&cancel)?;require_picked(&handle,&source)?;
            let ext=extension(&source)?;
            let held=OpenedFile::open(&source).map_err(|_|invalid_image())?;
            let bytes=read_held(held,if ext=="gif"{GIF_MAX_SIZE}else{MAX_INPUT_BYTES},Some(&cancel))?;
            require_picked(&handle,&source)?;
            let prepared=normalize(bytes,&ext,&cancel)?;
            let dir=wallpaper_dir(&root)?;let old=old_file(&dir,&expected)?;
            Ok::<_,String>((prepared,dir,old))
        })();
        match prepared{Err(e)=>(Err(e),true),Ok((prepared,dir,old))=>replace_prepared(&dir,old,&prepared,&cancel,|next|handle.state::<storage::Storage>().compare_set_wallpaper_for_backend(&expected,next),||{})}
    }))).await.map_err(|_|with_language(&join_language,cleanup_error))?
}
fn clear_prepared<T>(dir:&Directory,old:Option<Owned>,commit:impl FnOnce()->Result<T>)->(Result<T>,bool){
    // 设置比较提交失败时绝不触碰原图；成功后只清理此前捕获的同一对象。
    let value=match commit(){Ok(value)=>value,Err(error)=>return(Err(error),true)};
    if let Some(old)=old{
        if remove_owned(dir,&old).is_err(){
            // 设置可能已清空，删除也可能已发生但后验失败；保留未知状态，不能伪报回滚或成功。
            return(Err(cleanup_error()),false);
        }
    }
    (Ok(value),true)
}
async fn clear<R:Runtime>(app:&AppHandle<R>)->Result<Value>{
    let language=storage_language(app);
    let(expected,root)={let state=app.state::<storage::Storage>();let settings=state.settings_for_backend()?;(settings.get("backgroundImage").and_then(Value::as_str).unwrap_or("").to_owned(),state.data_root_for_backend())};
    let handle=app.clone();let request=app.state::<crate::lifecycle::Gate>().enter()?;let join_language=language.clone();
    tauri::async_runtime::spawn_blocking(move||with_language(&language,||complete_worker(request,||{
        let before=(||{let dir=wallpaper_dir(&root)?;let old=old_file(&dir,&expected)?;Ok::<_,String>((dir,old))})();
        match before{Err(e)=>(Err(e),true),Ok((dir,old))=>clear_prepared(&dir,old,||handle.state::<storage::Storage>().compare_set_wallpaper_for_backend(&expected,""))}
    }))).await.map_err(|_|with_language(&join_language,cleanup_error))?
}
fn data_worker(name:String,root:PathBuf)->Result<Value>{
    let empty=||Value::String(String::new());
    if name.is_empty(){return Ok(empty());}
    let Some(ext)=owned_name(&name) else{return Ok(empty())};
    let Ok(dir)=wallpaper_dir(&root) else{return Ok(empty())};
    if dir.verify().is_err(){return Ok(empty());}
    let Ok(Some(_))=dir.child(&name) else{return Ok(empty())};
    let Ok(source)=dir.source(&name) else{return Ok(empty())};
    let Ok(held)=source.open() else{return Ok(empty())};
    let Ok(bytes)=read_held(held,if ext=="gif"{GIF_MAX_SIZE}else{MAX_SIZE},None) else{return Ok(empty())};
    if dir.verify().is_err(){return Ok(empty());}
    Ok(Value::String(format!("data:{};base64,{}",mime(&ext).ok_or_else(invalid_image)?,base64::engine::general_purpose::STANDARD.encode(bytes))))
}
async fn data<R:Runtime>(app:&AppHandle<R>)->Result<Value>{
    let(name,root,language)={let state=app.state::<storage::Storage>();let settings=state.settings_for_backend()?;(settings.get("backgroundImage").and_then(Value::as_str).unwrap_or("").to_owned(),state.data_root_for_backend(),settings.get("language").and_then(Value::as_str).unwrap_or("zh-CN").to_owned())};
    let request=app.state::<crate::lifecycle::Gate>().enter()?;let join_language=language.clone();
    tauri::async_runtime::spawn_blocking(move||with_language(&language,||complete_worker(request,||(data_worker(name,root),true)))).await.map_err(|_|with_language(&join_language,cleanup_error))?
}
/// 在 Storage 初始化后、通用桌面桥接之前调用；未知 channel 交回后续分派。
pub(crate) async fn call<R:Runtime>(app:&AppHandle<R>,window:&WebviewWindow<R>,channel:&str,args:&[Value])->Result<Option<Value>>{
    if !matches!(channel,"settings:pickWallpaper"|"settings:clearWallpaper"|"settings:wallpaperData"){return Ok(None);}
    let language=storage_language(app);
    with_language(&language,||->Result<()>{
        if window.label()!="main"{return Err(tr("此接口仅允许主窗口调用","此介面僅允許主視窗呼叫","This operation is only available to the main window"));}
        if !args.is_empty(){return Err(invalid_state());}
        #[cfg(target_os="ios")]
        {return Err(unsupported());}
        #[cfg(not(target_os="ios"))]
        {Ok(())}
    })?;
    Ok(Some(match channel{"settings:pickWallpaper"=>pick(app,window).await?,"settings:clearWallpaper"=>clear(app).await?,"settings:wallpaperData"=>data(app).await?,_=>unreachable!()}))
}

#[cfg(unix)]mod native{
    use super::*;
    use std::{ffi::{CString,c_char},io,os::fd::{AsRawFd,FromRawFd}};
    #[cfg(any(target_os="macos",target_os="ios"))]const NOFOLLOW:i32=0x100;
    #[cfg(all(target_os="android",any(target_arch="arm",target_arch="aarch64")))]const NOFOLLOW:i32=0x8000;
    #[cfg(not(any(target_os="macos",target_os="ios",all(target_os="android",any(target_arch="arm",target_arch="aarch64")))))]const NOFOLLOW:i32=0x20000;
    #[cfg(any(target_os="macos",target_os="ios"))]const CLOEXEC:i32=0x1000000;
    #[cfg(not(any(target_os="macos",target_os="ios")))]const CLOEXEC:i32=0x80000;
    #[cfg(any(target_os="macos",target_os="ios"))]const NONBLOCK:i32=4;
    #[cfg(not(any(target_os="macos",target_os="ios")))]const NONBLOCK:i32=0x800;
    #[cfg(any(target_os="macos",target_os="ios"))]const CREATE_EXCL:i32=0x200|0x800;
    #[cfg(not(any(target_os="macos",target_os="ios")))]const CREATE_EXCL:i32=0x40|0x80;
    extern "C"{fn openat(fd:i32,name:*const c_char,flags:i32,...)->i32;fn mkdirat(fd:i32,name:*const c_char,mode:u32)->i32;fn unlinkat(fd:i32,name:*const c_char,flags:i32)->i32;}
    fn name(value:&str)->io::Result<CString>{access::leaf(value).map_err(|_|io::Error::from(io::ErrorKind::InvalidInput))?;CString::new(value).map_err(|_|io::Error::from(io::ErrorKind::InvalidInput))}
    fn open(parent:&File,leaf:&str,flags:i32)->io::Result<File>{let text=name(leaf)?;let fd=unsafe{openat(parent.as_raw_fd(),text.as_ptr(),flags,0o600u32)};if fd<0{Err(io::Error::last_os_error())}else{Ok(unsafe{File::from_raw_fd(fd)})}}
    pub(super)fn mkdir(parent:&File,leaf:&str)->io::Result<()>{let text=name(leaf)?;if unsafe{mkdirat(parent.as_raw_fd(),text.as_ptr(),0o700)}<0{Err(io::Error::last_os_error())}else{Ok(())}}
    pub(super)fn new_file(parent:&File,leaf:&str)->io::Result<File>{open(parent,leaf,2|CREATE_EXCL|NOFOLLOW|CLOEXEC)}
    pub(super)fn existing(parent:&File,leaf:&str)->io::Result<File>{open(parent,leaf,NOFOLLOW|CLOEXEC|NONBLOCK)}
    pub(super)fn remove(parent:&File,leaf:&str,expected:&Identity)->Result<()>{let file=existing(parent,leaf).map_err(|_|file_error())?;if identity(&file)?!=*expected{return Err(cleanup_error());}let text=name(leaf).map_err(|_|file_error())?;
        // unlinkat 无 expected-inode CAS；同 UID 恶意替换叶名称的窄竞态仍是平台边界。
        if unsafe{unlinkat(parent.as_raw_fd(),text.as_ptr(),0)}<0{Err(file_error())}else{Ok(())}}
    pub(super)fn remove_open(parent:&File,leaf:&str,file:File,expected:&Identity)->Result<()>{if identity(&file)?!=*expected{return Err(cleanup_error());}remove(parent,leaf,expected)}
    #[cfg(target_os="linux")]fn rename(parent:&File,from:&CString,to:&CString)->io::Result<()>{extern "C"{fn renameat2(a:i32,b:*const c_char,c:i32,d:*const c_char,flags:u32)->i32;}if unsafe{renameat2(parent.as_raw_fd(),from.as_ptr(),parent.as_raw_fd(),to.as_ptr(),1)}<0{Err(io::Error::last_os_error())}else{Ok(())}}
    #[cfg(target_os="android")]fn rename(parent:&File,from:&CString,to:&CString)->io::Result<()>{use std::ffi::c_void;#[link(name="dl")]extern "C"{fn dlsym(handle:*mut c_void,name:*const c_char)->*mut c_void;}type Rename=unsafe extern "C" fn(i32,*const c_char,i32,*const c_char,u32)->i32;
        #[cfg(target_pointer_width="64")]let default=std::ptr::null_mut();#[cfg(target_pointer_width="32")]let default=usize::MAX as *mut c_void;
        // API 30 才导出 renameat2，旧 API 不走覆盖式回退。
        let symbol=unsafe{dlsym(default,RENAMEAT2_SYMBOL.as_ptr().cast())};if symbol.is_null(){return Err(io::Error::from(io::ErrorKind::Unsupported));}let call:Rename=unsafe{std::mem::transmute(symbol)};if unsafe{call(parent.as_raw_fd(),from.as_ptr(),parent.as_raw_fd(),to.as_ptr(),1)}<0{Err(io::Error::last_os_error())}else{Ok(())}}
    #[cfg(any(target_os="macos",target_os="ios"))]fn rename(parent:&File,from:&CString,to:&CString)->io::Result<()>{extern "C"{fn renameatx_np(a:i32,b:*const c_char,c:i32,d:*const c_char,flags:u32)->i32;}if unsafe{renameatx_np(parent.as_raw_fd(),from.as_ptr(),parent.as_raw_fd(),to.as_ptr(),4)}<0{Err(io::Error::last_os_error())}else{Ok(())}}
    #[cfg(not(any(target_os="linux",target_os="android",target_os="macos",target_os="ios")))]fn rename(_:&File,_:&CString,_:&CString)->io::Result<()>{Err(io::Error::from(io::ErrorKind::Unsupported))}
    pub(super)fn publish(parent:&File,file:&File,from:&str,to:&str,expected:&Identity)->Result<()>{if identity(file)?!=*expected||identity(&existing(parent,from).map_err(|_|file_error())?)?!=*expected{return Err(file_error());}let from=name(from).map_err(|_|file_error())?;let to=name(to).map_err(|_|file_error())?;rename(parent,&from,&to).map_err(|e|if e.kind()==io::ErrorKind::AlreadyExists{tr("壁纸目标已存在，未覆盖", "桌布目標已存在，未覆寫", "Wallpaper target exists; it was not overwritten")}else{file_error()})}
}
#[cfg(windows)]mod native{
    use super::*;use std::{ffi::c_void,io,os::windows::io::{AsRawHandle,FromRawHandle}};
    type Handle=*mut c_void;
    #[repr(C)]struct UnicodeString{length:u16,maximum:u16,buffer:*mut u16}
    #[repr(C)]struct Attributes{length:u32,root:Handle,name:*mut UnicodeString,flags:u32,security:*mut c_void,qos:*mut c_void}
    #[repr(C)]struct Status{status:isize,information:usize}
    #[link(name="ntdll")]extern "system"{fn NtCreateFile(file:*mut Handle,access:u32,attrs:*mut Attributes,status:*mut Status,allocation:*const i64,attributes:u32,share:u32,disposition:u32,options:u32,ea:*mut c_void,ea_len:u32)->i32;fn RtlNtStatusToDosError(status:i32)->u32;fn NtSetInformationFile(file:Handle,status:*mut Status,info:*mut c_void,length:u32,class:i32)->i32;}
    #[link(name="kernel32")]extern "system"{fn SetFileInformationByHandle(file:Handle,class:i32,info:*mut c_void,length:u32)->i32;}
    fn open(parent:&File,leaf:&str,create:bool,directory:bool,delete:bool,write:bool)->io::Result<File>{
        access::leaf(leaf).map_err(|_|io::Error::from(io::ErrorKind::InvalidInput))?;
        let mut wide=leaf.encode_utf16().collect::<Vec<_>>();let length=u16::try_from(wide.len().checked_mul(2).ok_or(io::ErrorKind::InvalidInput)?).map_err(|_|io::ErrorKind::InvalidInput)?;
        let mut unicode=UnicodeString{length,maximum:length,buffer:wide.as_mut_ptr()};let mut attrs=Attributes{length:std::mem::size_of::<Attributes>()as u32,root:parent.as_raw_handle(),name:&mut unicode,flags:0x40,security:std::ptr::null_mut(),qos:std::ptr::null_mut()};let mut status=Status{status:0,information:0};let mut raw=std::ptr::null_mut();
        let access=0x80000000|0x00100000|if write{0x40000000}else{0}|if delete{0x10000}else{0};
        // 文件句柄一律只共享读取；暂存句柄持有写入/删除权时仍可安全重验。
        let share=if directory{3}else{1};
        let result=unsafe{NtCreateFile(&mut raw,access,&mut attrs,&mut status,std::ptr::null(),0,share,if create{2}else{1},0x20|0x200000|if directory{1}else{0x40},std::ptr::null_mut(),0)};
        if result<0{Err(io::Error::from_raw_os_error(unsafe{RtlNtStatusToDosError(result)}as i32))}else{Ok(unsafe{File::from_raw_handle(raw)})}
    }
    pub(super)fn mkdir(parent:&File,leaf:&str)->io::Result<()>{open(parent,leaf,true,true,false,false).map(drop)}
    pub(super)fn new_file(parent:&File,leaf:&str)->io::Result<File>{open(parent,leaf,true,false,true,true)}
    pub(super)fn existing(parent:&File,leaf:&str)->io::Result<File>{open(parent,leaf,false,false,false,false)}
    fn disposition(file:&File)->Result<()>{let mut delete=1u8;if unsafe{SetFileInformationByHandle(file.as_raw_handle(),4,(&mut delete as *mut u8).cast(),1)}==0{Err(cleanup_error())}else{Ok(())}}
    pub(super)fn remove(parent:&File,leaf:&str,expected:&Identity)->Result<()>{let file=open(parent,leaf,false,false,true,false).map_err(|_|file_error())?;if identity(&file)?!=*expected{return Err(cleanup_error());}disposition(&file)}
    pub(super)fn remove_open(_:&File,_:&str,file:File,expected:&Identity)->Result<()>{if identity(&file)?!=*expected{return Err(cleanup_error());}disposition(&file)}
    #[repr(C)]struct Rename{replace:u8,root:Handle,length:u32,name:[u16;1]}
    pub(super)fn publish(parent:&File,file:&File,_:&str,to:&str,expected:&Identity)->Result<()>{
        if identity(file)?!=*expected{return Err(file_error());}access::leaf(to)?;let wide=to.encode_utf16().collect::<Vec<_>>();let offset=std::mem::offset_of!(Rename,name);let size=offset.checked_add(wide.len().checked_mul(2).ok_or_else(file_error)?).ok_or_else(file_error)?.max(std::mem::size_of::<Rename>());let mut buffer=vec![0usize;(size+std::mem::size_of::<usize>()-1)/std::mem::size_of::<usize>()];let info=buffer.as_mut_ptr().cast::<Rename>();
        unsafe{(*info).replace=0;(*info).root=parent.as_raw_handle();(*info).length=u32::try_from(wide.len()*2).map_err(|_|file_error())?;std::ptr::copy_nonoverlapping(wide.as_ptr(),buffer.as_mut_ptr().cast::<u8>().add(offset).cast::<u16>(),wide.len());let mut status=Status{status:0,information:0};let result=NtSetInformationFile(file.as_raw_handle(),&mut status,info.cast(),u32::try_from(size).map_err(|_|file_error())?,10);if result<0{return Err(file_error());}}
        // 返回成功后由调用者立即登记；这里不插入可失败后验。
        Ok(())
    }
}
#[cfg(not(any(unix,windows)))]mod native{
    use super::*;use std::io;
    pub(super)fn mkdir(_:&File,_:&str)->io::Result<()>{Err(io::Error::from(io::ErrorKind::Unsupported))}
    pub(super)fn new_file(_:&File,_:&str)->io::Result<File>{Err(io::Error::from(io::ErrorKind::Unsupported))}
    pub(super)fn existing(_:&File,_:&str)->io::Result<File>{Err(io::Error::from(io::ErrorKind::Unsupported))}
    pub(super)fn publish(_:&File,_:&File,_:&str,_:&str,_:&Identity)->Result<()>{Err(unsupported())}
    pub(super)fn remove(_:&File,_:&str,_:&Identity)->Result<()>{Err(unsupported())}
    pub(super)fn remove_open(_:&File,_:&str,_:File,_:&Identity)->Result<()>{Err(unsupported())}
}

#[cfg(test)]mod tests{
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture{fn new()->Self{let path=std::env::temp_dir().join(format!("hcmcl-wallpaper-test-{}",uuid::Uuid::new_v4()));fs::create_dir(&path).unwrap();Self(fs::canonicalize(path).unwrap())}fn dir(&self)->Directory{wallpaper_dir(&self.0).unwrap()}}
    impl Drop for Fixture{fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}
    fn png()->Vec<u8>{let mut output=Cursor::new(Vec::new());image::DynamicImage::new_rgba8(2,3).write_to(&mut output,image::ImageFormat::Png).unwrap();output.into_inner()}
    fn prepared()->Prepared{Prepared{bytes:png(),ext:"png".into()}}
    fn target()->String{format!("wallpaper-{}.png",uuid::Uuid::new_v4().simple())}
    fn old(dir:&Directory)->Owned{let name=target();fs::write(dir.path().join(&name),b"old wallpaper").unwrap();old_file(dir,&name).unwrap().unwrap()}
    #[test]fn android_rename_symbol_is_exact_nul_terminated_c_string(){let name=std::ffi::CStr::from_bytes_with_nul(RENAMEAT2_SYMBOL).unwrap();assert_eq!(name.to_bytes(),b"renameat2");assert_eq!(RENAMEAT2_SYMBOL.len(),10);assert_eq!(RENAMEAT2_SYMBOL[9],0);}
    #[test]fn clear_settings_failure_keeps_captured_old_file(){let f=Fixture::new();let dir=f.dir();let previous=old(&dir);let name=previous.name.clone();let(result,confirmed)=clear_prepared(&dir,Some(previous),||Err::<(),_>("synthetic CAS conflict".into()));assert!(result.is_err());assert!(confirmed);assert_eq!(fs::read(dir.path().join(&name)).unwrap(),b"old wallpaper");assert_eq!(fs::read_dir(dir.path()).unwrap().count(),1);let previous=old_file(&dir,&name).unwrap();let(result,confirmed)=clear_prepared(&dir,previous,||Ok(()));result.unwrap();assert!(confirmed);assert!(!dir.path().join(name).exists());}
    #[test]fn clear_identity_failure_preserves_old_and_does_not_finish_gate(){let f=Fixture::new();let dir=f.dir();let mut previous=old(&dir);let name=previous.name.clone();previous.id=Identity(u64::MAX,u64::MAX);let gate=crate::lifecycle::Gate::default();let mut committed=false;let result=complete_worker(gate.enter().unwrap(),||clear_prepared(&dir,Some(previous),||{committed=true;Ok(())}));assert!(result.is_err());assert!(committed);assert_eq!(fs::read(dir.path().join(name)).unwrap(),b"old wallpaper");assert!(gate.begin_restart().is_err());}
    #[test]fn format_and_name_policy_rejects_mismatch_and_traversal(){assert_eq!(extension(Path::new("image.PNG")).unwrap(),"png");assert!(extension(Path::new("x.svg")).is_err());assert!(owned_name("../x.png").is_none());assert!(owned_name("settings.json").is_none());assert!(owned_name(&target()).is_some());assert!(normalize(png(),"gif",&downloads::Cancel::default()).is_err());assert!(dimension_limit(0,1).is_err());assert!(dimension_limit(u32::MAX,u32::MAX).is_err());}
    #[test]fn opt_in_real_wallpaper_file_probe(){
        let Ok(path)=std::env::var("HC_WALLPAPER_PROBE") else{return};
        let bytes=fs::read(&path).unwrap();
        println!("probe file={} bytes={}",path,bytes.len());
        let held=OpenedFile::open(Path::new(&path)).unwrap();
        let read=read_held(held,if path.ends_with("gif"){GIF_MAX_SIZE}else{MAX_INPUT_BYTES},None);
        match read{Ok(b)=>println!("read_held ok len={}",b.len()),Err(e)=>{println!("read_held FAIL: {e}");return;}}
        let held2=OpenedFile::open(Path::new(&path)).unwrap();
        let ext=extension(Path::new(&path)).unwrap();
        let b2=read_held(held2,if ext=="gif"{GIF_MAX_SIZE}else{MAX_INPUT_BYTES},None).unwrap();
        match normalize(b2,&ext,&downloads::Cancel::default()){
            Ok(p)=>println!("normalize ok ext={} out_len={}",p.ext,p.bytes.len()),
            Err(e)=>println!("normalize FAIL: {e}"),
        }
    }
    #[test]fn real_png_preserves_small_bytes_and_roundtrips_data_url(){let bytes=png();assert_eq!(&bytes[..8],&[137,80,78,71,13,10,26,10]);let p=normalize(bytes.clone(),"png",&downloads::Cancel::default()).unwrap();assert_eq!(p.bytes,bytes);let f=Fixture::new();let dir=f.dir();let(result,confirmed)=replace_prepared(&dir,None,&p,&downloads::Cancel::default(),|name|Ok(name.to_owned()),||{});assert!(confirmed);let name=result.unwrap();drop(dir);let url=data_worker(name,f.0.clone()).unwrap();let text=url.as_str().unwrap().strip_prefix("data:image/png;base64,").unwrap();assert_eq!(base64::engine::general_purpose::STANDARD.decode(text).unwrap(),bytes);}
    #[test]fn real_large_bmp_is_resized_and_encoded_as_jpeg(){let mut bytes=Cursor::new(Vec::new());image::DynamicImage::new_rgb8(3000,1000).write_to(&mut bytes,image::ImageFormat::Bmp).unwrap();assert!(bytes.get_ref().len()as u64>MAX_SIZE);let p=normalize(bytes.into_inner(),"bmp",&downloads::Cancel::default()).unwrap();assert_eq!(p.ext,"jpg");assert!(p.bytes.len()as u64<=MAX_SIZE);let image=image::load_from_memory(&p.bytes).unwrap();assert_eq!((image.width(),image.height()),(2560,853));}
    #[test]fn real_gif_is_preserved_and_oversize_rejected(){let mut encoded=Cursor::new(Vec::new());image::DynamicImage::new_rgba8(2,2).write_to(&mut encoded,image::ImageFormat::Gif).unwrap();let bytes=encoded.into_inner();assert_eq!(normalize(bytes.clone(),"gif",&downloads::Cancel::default()).unwrap().bytes,bytes);assert!(normalize(vec![0;GIF_MAX_SIZE as usize+1],"gif",&downloads::Cancel::default()).is_err());}
    #[test]fn held_read_enforces_limit_and_rejects_changed_source(){let f=Fixture::new();let path=f.0.join("source.png");fs::write(&path,b"12345").unwrap();assert!(read_held(OpenedFile::open(&path).unwrap(),4,None).is_err());let held=OpenedFile::open(&path).unwrap();#[cfg(unix)]{fs::write(&path,b"changed").unwrap();assert!(read_held(held,64,None).is_err());}#[cfg(not(unix))]{assert_eq!(read_held(held,64,None).unwrap(),b"12345");}}
    #[test]fn native_no_replace_preserves_existing_and_concurrent_winner(){let f=Fixture::new();let dir=f.dir();let name=target();let mut stage=Stage::new(&dir,name.clone()).unwrap();stage.initialize().unwrap();stage.file.as_mut().unwrap().write_all(b"candidate").unwrap();fs::write(dir.path().join(&name),b"winner").unwrap();stage.verify().unwrap();assert!(native::publish(dir.handle(),stage.file.as_ref().unwrap(),&stage.name,&stage.target,stage.id.as_ref().unwrap()).is_err());stage.cleanup().unwrap();assert_eq!(fs::read(dir.path().join(&name)).unwrap(),b"winner");assert_eq!(fs::read_dir(dir.path()).unwrap().count(),1);}
    #[test]fn cancel_after_publish_removes_only_candidate_and_preserves_old(){let f=Fixture::new();let dir=f.dir();let previous=old(&dir);let previous_name=previous.name.clone();let cancel=downloads::Cancel::default();let mut committed=false;let(result,confirmed)=replace_prepared(&dir,Some(previous),&prepared(),&cancel,|_|{committed=true;Ok(())},||cancel.stop());assert!(result.is_err());assert!(confirmed);assert!(!committed);assert_eq!(fs::read(dir.path().join(previous_name)).unwrap(),b"old wallpaper");assert_eq!(fs::read_dir(dir.path()).unwrap().count(),1);}
    #[test]fn settings_failure_keeps_old_and_success_removes_old(){let f=Fixture::new();let dir=f.dir();let previous=old(&dir);let previous_name=previous.name.clone();let(result,confirmed)=replace_prepared(&dir,Some(previous),&prepared(),&downloads::Cancel::default(),|_|Err::<(),_>("synthetic CAS conflict".into()),||{});assert!(result.is_err());assert!(confirmed);assert_eq!(fs::read(dir.path().join(&previous_name)).unwrap(),b"old wallpaper");assert_eq!(fs::read_dir(dir.path()).unwrap().count(),1);let previous=old_file(&dir,&previous_name).unwrap();let(result,confirmed)=replace_prepared(&dir,previous,&prepared(),&downloads::Cancel::default(),|name|Ok(name.to_owned()),||{});assert!(confirmed);let name=result.unwrap();assert!(!dir.path().join(previous_name).exists());assert_eq!(fs::read(dir.path().join(name)).unwrap(),png());}
    #[test]fn cleanup_failure_does_not_report_lifecycle_ready(){let f=Fixture::new();let dir=f.dir();let gate=crate::lifecycle::Gate::default();let result=complete_worker(gate.enter().unwrap(),||{let mut stage=Stage::new(&dir,target()).unwrap();stage.write_publish(&png(),&downloads::Cancel::default()).unwrap();stage.id=Some(Identity(u64::MAX,u64::MAX));finish_cleanup::<()>(&mut stage,Err(cancelled()))});assert!(result.is_err());assert!(gate.begin_restart().is_err());}
    #[cfg(unix)]#[test]fn changed_directory_identity_never_writes_or_cleans_replacement(){let f=Fixture::new();let dir=f.dir();let mut stage=Stage::new(&dir,target()).unwrap();stage.initialize().unwrap();fs::rename(f.0.join("wallpapers"),f.0.join("moved")).unwrap();fs::create_dir(f.0.join("wallpapers")).unwrap();fs::write(f.0.join("wallpapers/unknown"),b"keep").unwrap();assert!(stage.verify().is_err());assert!(stage.cleanup().is_err());assert_eq!(fs::read(f.0.join("wallpapers/unknown")).unwrap(),b"keep");assert_eq!(fs::read_dir(f.0.join("wallpapers")).unwrap().count(),1);}
    #[test]fn panic_keeps_gate_unconfirmed(){let gate=crate::lifecycle::Gate::default();let request=gate.enter().unwrap();let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||complete_worker::<()>(request,||panic!("synthetic worker panic"))));assert!(result.is_err());assert!(gate.begin_restart().is_err());}
}

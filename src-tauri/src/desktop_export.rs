//! 桌面资源另存：原生 picker 产生一次能力，后台持有目录与文件直到写入和清理结束。
//! 本批只发布新文件。系统没有统一的按 inode 比较并覆盖接口，因此绝不检查后盲目替换。
use super::{file_identity, fs_error, invalid, is_link, picker_path, reject_link_ancestors, storage_language, tr, valid_name, with_language};
use crate::{downloads::Cancel, mobile_export::{Lifecycle, Phase, SignalOnDrop, StateError, SAVE_TTL}};
use serde_json::{json, Value};
use std::{fs::{self, File, OpenOptions}, io, path::{Component, Path, PathBuf}, sync::{Arc, Mutex}, time::Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;
fn denied() -> String { tr("保存授权已失效，请重新选择目标文件", "儲存授權已失效，請重新選取目標檔案", "Save authorization expired; choose the destination again") }
fn conflict() -> String { tr("目标已存在。此版本仅支持另存为新文件，请更改文件名；原文件未被覆盖", "目標已存在。此版本僅支援另存為新檔案，請變更檔名；原檔案未被覆寫", "The destination already exists. Choose a new filename; this version does not overwrite existing files") }
fn changed() -> String { tr("保存目录或暂存文件已变化，导出已停止；请重新选择", "儲存目錄或暫存檔案已變更，匯出已停止；請重新選取", "The destination directory or staged file changed; select it again") }
fn cleanup_error() -> String { tr("导出暂存清理未完成，请检查所选目录后重启再试", "匯出暫存清理未完成，請檢查所選目錄後重新啟動再試", "Export staging cleanup is incomplete; check the chosen directory and restart before retrying") }
fn state_error(error: StateError) -> String { match error {
    StateError::Busy => tr("另一个资源另存尚未结束，请完成或取消后重试", "另一個資源另存尚未結束，請完成或取消後重試", "Another resource export is still active; complete or cancel it first"),
    StateError::CommitStarted => tr("资源已进入最终发布，无法保证取消；请等待结果", "資源已進入最終發布，無法保證取消；請等待結果", "Final publication has started; cancellation cannot be guaranteed. Wait for the result"),
    StateError::Denied => denied(),
} }
fn checked_name(name: &str) -> Result<String> {
    let value = valid_name(name)?;
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if value != name || name.chars().any(|c| c.is_control())
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.chars().skip(3).any(|c| matches!(c, '¹' | '²' | '³'))) { return Err(invalid()); }
    Ok(value)
}

// 目录操作由真实句柄锚定。Unix 用 *at(fd, name)，Windows 持有不共享 DELETE 的祖先句柄。
// Unix 目录即使被外部改名也不会转向攻击者新建的同名目录；发布前仍核对用户选中的原路径。
struct Parent { path: PathBuf, handles: Vec<File>, identities: Vec<(PathBuf, (u64, u64))> }
impl Parent {
    fn open(path: &Path) -> Result<Self> {
        if !path.is_absolute() { return Err(invalid()); }
        reject_link_ancestors(path)?;
        let mut handles = Vec::new(); let mut identities = Vec::new(); let mut current = PathBuf::new();
        for component in path.components() {
            current.push(component.as_os_str());
            if matches!(component, Component::Prefix(_)) { continue; }
            let file = if handles.is_empty() { native::open_directory(&current)? }
                else { match component { Component::Normal(name) => native::open_child_directory(handles.last().unwrap(), &current, name.to_str().ok_or_else(invalid)?)?, Component::CurDir => continue, _ => return Err(invalid()) } };
            let metadata = file.metadata().map_err(fs_error)?;
            if !metadata.is_dir() || is_link(&metadata) { return Err(changed()); }
            identities.push((current.clone(), file_identity(&file, &metadata)?)); handles.push(file);
        }
        if handles.is_empty() { return Err(invalid()); }
        let result = Self { path: path.to_owned(), handles, identities }; result.verify()?; Ok(result)
    }
    fn file(&self) -> &File { self.handles.last().unwrap() }
    fn verify(&self) -> Result<()> {
        reject_link_ancestors(&self.path).map_err(|_| changed())?;
        for (path, identity) in &self.identities {
            let file = native::open_directory(path).map_err(|_| changed())?;
            let metadata = file.metadata().map_err(|_| changed())?;
            if !metadata.is_dir() || is_link(&metadata) || file_identity(&file, &metadata)? != *identity { return Err(changed()); }
        }
        Ok(())
    }
}
struct SaveGrant { parent: Parent, name: String, original_name: String }
impl SaveGrant {
    fn new(path: PathBuf, original_name: String) -> Result<Self> {
        let path = picker_path(path)?;
        let name = checked_name(path.file_name().and_then(|name| name.to_str()).ok_or_else(invalid)?)?;
        let parent = Parent::open(path.parent().ok_or_else(invalid)?)?;
        native::require_absent(parent.file(), &parent.path, &name)?;
        Ok(Self { parent, name, original_name })
    }
}
struct Stage { grant: SaveGrant, directory: File, directory_name: String, identity: (u64, u64), file_identity: (u64, u64), anchor: Option<File>, moved: bool }
impl Stage {
    fn new(grant: SaveGrant) -> Result<(Self, File)> {
        grant.parent.verify()?; native::require_absent(grant.parent.file(), &grant.parent.path, &grant.name)?;
        let directory_name = format!(".hcmcl-export-{}", Uuid::new_v4());
        native::mkdir(grant.parent.file(), &grant.parent.path, &directory_name)?;
        let path = grant.parent.path.join(&directory_name);
        let directory = match native::open_child_directory(grant.parent.file(), &path, &directory_name) { Ok(file) => file, Err(error) => { return if native::remove_dir(grant.parent.file(), &grant.parent.path, &directory_name).is_err() { Err(cleanup_error()) } else { Err(error) }; } };
        let opened = (|| {
            let identity = file_identity(&directory, &directory.metadata().map_err(fs_error)?)?;
            let file = native::new_file(&directory, &path, "payload")?;
            let file_identity = file_identity(&file, &file.metadata().map_err(fs_error)?)?;
            let anchor = file.try_clone().map_err(fs_error)?;
            Ok::<_, String>((identity, file_identity, anchor, file))
        })();
        match opened {
            Ok((identity, file_identity, anchor, file)) => Ok((Self { grant, directory, directory_name, identity, file_identity, anchor: Some(anchor), moved: false }, file)),
            // 初始化未完成时没有可证明归属的 payload stamp；不按文件名盲删，只尝试移除空目录。
            Err(error) => { drop(directory); let cleanup = native::remove_dir(grant.parent.file(), &grant.parent.path, &directory_name); if cleanup.is_err() { Err(cleanup_error()) } else { Err(error) } },
        }
    }
    fn verify(&self, bytes: u64) -> Result<()> {
        self.grant.parent.verify()?;
        let path = self.grant.parent.path.join(&self.directory_name);
        let directory = native::open_child_directory(self.grant.parent.file(), &path, &self.directory_name).map_err(|_| changed())?;
        if file_identity(&directory, &directory.metadata().map_err(fs_error)?)? != self.identity { return Err(changed()); }
        let file = native::open_existing(&self.directory, &path, "payload").map_err(|_| changed())?;
        let metadata = file.metadata().map_err(fs_error)?;
        if !metadata.is_file() || is_link(&metadata) || file_identity(&file, &metadata)? != self.file_identity || metadata.len() != bytes { return Err(changed()); }
        let anchor = self.anchor.as_ref().ok_or_else(changed)?;
        if file_identity(anchor, &anchor.metadata().map_err(fs_error)?)? != self.file_identity { return Err(changed()); }
        Ok(())
    }
    fn publish(&mut self, bytes: u64) -> Result<()> {
        self.verify(bytes)?;
        // 发布以已经校验的源文件句柄为依据；目标存在时由内核原子失败，不覆盖或删除赢家。
        self.moved = native::link(self.anchor.as_ref().ok_or_else(changed)?, &self.directory, &self.grant.parent.path.join(&self.directory_name), "payload", self.grant.parent.file(), &self.grant.parent.path, &self.grant.name)?;
        Ok(())
    }
    fn cleanup(mut self) -> Result<()> {
        let path = self.grant.parent.path.join(&self.directory_name);
        let directory = native::open_child_directory(self.grant.parent.file(), &path, &self.directory_name).map_err(|_| cleanup_error())?;
        if file_identity(&directory, &directory.metadata().map_err(fs_error)?)? != self.identity { return Err(cleanup_error()); }
        if !self.moved {
            let file = native::open_existing(&self.directory, &path, "payload").map_err(|_| cleanup_error())?;
            if file_identity(&file, &file.metadata().map_err(fs_error)?)? != self.file_identity { return Err(cleanup_error()); }
            drop(file); self.anchor.take();
            native::remove_file(&self.directory, &path, "payload").map_err(|_| cleanup_error())?;
        } else { self.anchor.take(); }
        drop(directory); drop(self.directory);
        native::remove_dir(self.grant.parent.file(), &self.grant.parent.path, &self.directory_name).map_err(|_| cleanup_error())
    }
}

#[derive(Default)]
struct Slot { lifecycle: Lifecycle, epoch: u64, owner: String, locale: String, pending: Option<SaveGrant>, cancel: Option<Arc<Cancel>>, cleanup_failed: bool }
#[derive(Clone, Default)]
struct ExportState(Arc<Mutex<Slot>>);
fn relaunch_blocked() -> String {
    tr("资源另存仍在进行或清理结果未确认，暂时无法安全重启", "資源另存仍在進行或清理結果未確認，暫時無法安全重新啟動", "Resource export is active or cleanup is unconfirmed; restarting is not safe yet")
}
fn slot_relaunch_ready(slot: &Slot) -> Result<()> {
    if slot.cleanup_failed || slot.lifecycle.phase().is_some() || slot.lifecycle.id().is_some()
        || slot.pending.is_some() || slot.cancel.is_some() { return Err(relaunch_blocked()); }
    Ok(())
}
fn state_relaunch_ready(state: &ExportState) -> Result<()> {
    let slot = state.0.try_lock().map_err(|_| relaunch_blocked())?;
    slot_relaunch_ready(&slot)
}
/// 只观察当前槽；不取消、清票或等待 worker，后续禁止新任务由重启调用方保证。
pub(super) fn relaunch_ready(app: &AppHandle) -> Result<()> {
    let Some(state) = app.try_state::<ExportState>() else { return Ok(()); };
    state_relaunch_ready(state.inner())
}
fn finish(state: &ExportState, id: &str, cleanup_failed: bool) {
    if let Ok(mut slot) = state.0.lock() { if slot.lifecycle.id() == Some(id) { slot.cleanup_failed |= cleanup_failed; slot.pending = None; slot.cancel = None; slot.lifecycle.finish(id); } }
}
fn request_cancel(state: &ExportState, task: Option<&str>) -> Result<()> {
    let mut slot = state.0.lock().map_err(|_| "资源另存状态不可用 / 資源另存狀態無法使用 / Resource export state unavailable".to_owned())?;
    // 语言在授权时缓存；停止信号不得等待存储、密钥库或设置事务。
    let locale = slot.locale.clone();
    with_language(&locale, || {
        if !slot.lifecycle.cancel(task).map_err(state_error)? { return Ok(()); }
        if let Some(cancel) = &slot.cancel { cancel.stop(); }
        // Pending 没有写入任务，只有只读目录句柄；运行中的 worker 则独占 grant，不能提前释放槽。
        if slot.lifecycle.phase() == Some(Phase::Pending) {
            let id = slot.lifecycle.id().unwrap_or("").to_owned(); slot.pending = None; slot.cancel = None; slot.lifecycle.finish(&id);
        }
        Ok(())
    })
}
pub(super) fn init(app: &AppHandle) { app.manage(ExportState::default()); }

fn state<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) -> Result<ExportState> {
    if window.label() != "main" { return Err(denied()); }
    // 实际退出时由统一的后台清理作废授权；原生窗口回调不等最终发布持有的槽锁。
    app.try_state::<ExportState>().map(|state| state.inner().clone()).ok_or_else(denied)
}
fn expire(state: &ExportState, id: &str, now: Instant) {
    if let Ok(mut slot) = state.0.lock() {
        if slot.lifecycle.expire(id, now) {
            if let Some(cancel) = &slot.cancel { cancel.stop(); }
            if slot.lifecycle.phase() == Some(Phase::Pending) { slot.pending = None; slot.cancel = None; slot.lifecycle.finish(id); }
        }
    }
}
pub(super) async fn save_capability<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>, requested: &str) -> Result<Value> {
    let locale = storage_language(app);
    let original = with_language(&locale, || checked_name(requested))?;
    let state = state(app, window)?; let id = format!("hcmcl-desktop-save:{}", Uuid::new_v4());
    let epoch = with_language(&locale, || {
        let mut slot = state.0.lock().map_err(|_| denied())?;
        if slot.cleanup_failed { return Err(cleanup_error()); }
        let epoch = slot.lifecycle.reserve(id.clone(), Instant::now()).map_err(state_error)?;
        slot.owner = window.label().to_owned(); slot.locale = locale.clone(); slot.cancel = Some(Arc::new(Cancel::default())); slot.epoch = epoch; Ok(epoch)
    })?;
    let ttl_state = state.clone(); let ttl_id = id.clone();
    tauri::async_runtime::spawn(async move { tokio::time::sleep(SAVE_TTL).await; expire(&ttl_state, &ttl_id, Instant::now()); });
    let signal_state = state.clone(); let signal_id = id.clone();
    let mut ipc = SignalOnDrop::new(Arc::new(move || { let _ = request_cancel(&signal_state, Some(&signal_id)); }));
    let app = app.clone(); let window = window.clone(); let join_locale = locale.clone();
    let worker = tauri::async_runtime::spawn(async move {
        let selected = super::blocking(&locale, move || {
            let selected = app.dialog().file().set_parent(&window).set_file_name(&original).blocking_save_file();
            selected.map(|file| SaveGrant::new(file.into_path().map_err(|_| invalid())?, original)).transpose()
        }).await;
        match selected {
            Ok(Some(grant)) => {
                let published = with_language(&locale, || {
                    let mut slot = state.0.lock().map_err(|_| denied())?;
                    if slot.cancel.as_ref().is_some_and(|cancel| cancel.check().is_err()) { return Err(denied()); }
                    slot.lifecycle.publish(&id, epoch, Instant::now()).map_err(state_error)?;
                    slot.pending = Some(grant); Ok(json!(id))
                });
                if published.is_err() { finish(&state, &id, false); } published
            },
            Ok(None) => { finish(&state, &id, false); Ok(Value::Null) },
            Err(error) => { finish(&state, &id, false); Err(error) },
        }
    });
    let result = worker.await.map_err(|_| with_language(&join_locale, || tr("保存选择任务异常，未授予写入权限", "儲存選取工作異常，未授予寫入權限", "The save picker failed; no write permission was granted")))?;
    ipc.disarm(); result
}
fn arguments(args: &[Value]) -> Result<(String, String, Option<u64>)> {
    if !(2..=3).contains(&args.len()) { return Err(invalid()); }
    let url = args[0].as_str().filter(|url| !url.is_empty() && url.len() <= 8192 && !url.chars().any(char::is_control)).ok_or_else(invalid)?.to_owned();
    let id = args[1].as_str().filter(|id| id.strip_prefix("hcmcl-desktop-save:").is_some_and(|id| Uuid::parse_str(id).is_ok())).ok_or_else(denied)?.to_owned();
    let size = match args.get(2) { None | Some(Value::Null) => None, Some(value) => Some(value.as_u64().filter(|size| *size > 0 && *size <= 2 * 1024 * 1024 * 1024).ok_or_else(invalid)?) };
    Ok((url, id, size))
}
fn emit_progress(app: &AppHandle, id: &str, title: &str, bytes: u64, total: u64, done: bool, ok: bool) {
    let percent = if done { if ok { 100.0 } else { 0.0 } } else if total > 0 { (bytes as f64 * 99.0 / total as f64).min(99.0) } else { 0.0 };
    let task = if done { if ok { tr("另存完成", "另存完成", "Export complete") } else { tr("另存未完成，请检查错误", "另存未完成，請檢查錯誤", "Export did not complete; check the error") } } else { title.to_owned() };
    let _ = app.emit_to("main", "launcher:event", json!({"channel":"download:progress","payload":{"taskId":id,"jobTitle":title,"task":task,"current":if done && ok {1} else {0},"total":1,"currentBytes":bytes,"totalBytes":total,"phase":if done {"done"} else {"mod"},"percent":percent,"speed":0}}));
}
pub(super) async fn export_download(app: &AppHandle, window: &WebviewWindow, args: &[Value], settings: &Value) -> Result<Option<Value>> {
    let locale = storage_language(app); let (url, id, hint) = with_language(&locale, || arguments(args))?;
    let state = state(app, window)?;
    let (grant, cancel, epoch) = with_language(&locale, || {
        let mut slot = state.0.lock().map_err(|_| denied())?;
        if slot.owner != window.label() { return Err(denied()); }
        let epoch = slot.epoch; slot.lifecycle.consume(&id, epoch, Instant::now()).map_err(state_error)?;
        let grant = slot.pending.take().ok_or_else(denied)?; let cancel = slot.cancel.clone().ok_or_else(denied)?; Ok((grant, cancel, epoch))
    })?;
    let signal_state = state.clone(); let signal_id = id.clone(); let mut ipc = SignalOnDrop::new(Arc::new(move || { let _ = request_cancel(&signal_state, Some(&signal_id)); }));
    let app = app.clone(); let settings = settings.clone(); let join_locale = locale.clone();
    let worker = tauri::async_runtime::spawn(async move {
        let title = grant.original_name.clone(); let counters = Arc::new(Mutex::new((0u64, hint.unwrap_or(0))));
        with_language(&locale, || emit_progress(&app, &id, &title, 0, hint.unwrap_or(0), false, false));
        let mut stage = None;
        let result: Result<Value> = async {
            cancel.check()?;
            let bound = tokio::select! { biased; _ = cancel.cancelled() => return Err(with_language(&locale, denied)), bound = crate::catalog::prepare_export_download(&url, &grant.original_name, hint, &settings) => bound? };
            cancel.check()?;
            let prepared = super::blocking(&locale, move || Ok(Stage::new(grant))).await.map_err(|_| with_language(&locale, cleanup_error))?;
            let (prepared, file) = prepared?; stage = Some(prepared);
            let progress_app = app.clone(); let progress_id = id.clone(); let progress_title = title.clone(); let progress_locale = locale.clone(); let progress_counters = counters.clone();
            let progress: Arc<dyn Fn(u64, u64) + Send + Sync> = Arc::new(move |bytes, total| { if let Ok(mut value) = progress_counters.lock() { *value = (bytes, total); } with_language(&progress_locale, || emit_progress(&progress_app, &progress_id, &progress_title, bytes, total, false, false)); });
            // 不 select/abort 写 worker；IPC drop 只发 cancel，grant 与暂存 inode 由本任务持有到真实关闭。
            let bytes = crate::catalog::write_export_download(bound, file, cancel.clone(), progress).await?;
            let mut prepared = stage.take().unwrap(); let commit_state = state.clone(); let commit_id = id.clone(); let commit_cancel = cancel.clone();
            let published = super::blocking(&locale, move || {
                let result = (|| { let mut slot = commit_state.0.lock().map_err(|_| denied())?; commit_cancel.check()?; slot.lifecycle.commit(&commit_id, epoch).map_err(state_error)?; prepared.publish(bytes) })();
                Ok((result, prepared))
            });
            // blocking helper 返回 Result<T>，保留 Stage 到真实发布/失败以后再清理。
            let (published, prepared) = published.await.map_err(|_| with_language(&locale, cleanup_error))?; stage = Some(prepared); published?;
            Ok(json!(id))
        }.await;
        let cleanup = if let Some(prepared) = stage { super::blocking(&locale, move || prepared.cleanup()).await } else { Ok(()) };
        let failed = cleanup.is_err() || result.as_ref().err().is_some_and(|error| error == &with_language(&locale, cleanup_error));
        let result = if failed { Err(with_language(&locale, cleanup_error)) } else { result };
        finish(&state, &id, failed);
        let (bytes, total) = counters.lock().map(|value| *value).unwrap_or((0, 0)); with_language(&locale, || emit_progress(&app, &id, &title, bytes, total, true, result.is_ok())); result
    });
    let result = worker.await.map_err(|_| with_language(&join_locale, || tr("资源另存后台任务异常，未确认发布结果", "資源另存背景工作異常，未確認發布結果", "The resource export worker failed; publication is unconfirmed")))?;
    ipc.disarm(); result.map(Some)
}
pub(super) fn cancel_download(app: &AppHandle, task_id: Option<&str>) -> Result<()> {
    let Some(state) = app.try_state::<ExportState>() else { return Ok(()); };
    request_cancel(state.inner(), task_id)
}
pub(super) fn cancel_for_window(app: &AppHandle) {
    let Some(state) = app.try_state::<ExportState>() else { return; };
    if let Ok(mut slot) = state.inner().0.lock() {
        slot.lifecycle.invalidate(true);
        if let Some(cancel) = &slot.cancel { cancel.stop(); }
        if slot.lifecycle.phase() == Some(Phase::Pending) {
            let id = slot.lifecycle.id().unwrap_or("").to_owned(); slot.pending = None; slot.cancel = None; slot.lifecycle.finish(&id);
        }
    };
}

#[cfg(unix)]
mod native {
    use super::*; use std::{ffi::CString, os::{fd::{AsRawFd, FromRawFd}, unix::fs::OpenOptionsExt}};
    #[cfg(target_os = "macos")] const DIRECTORY: i32 = 0x100000;
    #[cfg(not(target_os = "macos"))] const DIRECTORY: i32 = 0x10000;
    #[cfg(target_os = "macos")] const NOFOLLOW: i32 = 0x100;
    #[cfg(not(target_os = "macos"))] const NOFOLLOW: i32 = 0x20000;
    #[cfg(target_os = "macos")] const CLOEXEC: i32 = 0x1000000;
    #[cfg(not(target_os = "macos"))] const CLOEXEC: i32 = 0x80000;
    #[cfg(target_os = "macos")] const CREATE: i32 = 0x200;
    #[cfg(not(target_os = "macos"))] const CREATE: i32 = 0x40;
    #[cfg(target_os = "macos")] const EXCLUSIVE: i32 = 0x800;
    #[cfg(not(target_os = "macos"))] const EXCLUSIVE: i32 = 0x80;
    #[cfg(target_os = "macos")] const REMOVE_DIR: i32 = 0x80;
    #[cfg(not(target_os = "macos"))] const REMOVE_DIR: i32 = 0x200;
    #[cfg(target_os = "macos")] const NONBLOCK: i32 = 0x4;
    #[cfg(not(target_os = "macos"))] const NONBLOCK: i32 = 0x800;
    extern "C" { fn openat(fd:i32,path:*const std::os::raw::c_char,flags:i32,...)->i32; fn mkdirat(fd:i32,path:*const std::os::raw::c_char,mode:u32)->i32; fn unlinkat(fd:i32,path:*const std::os::raw::c_char,flags:i32)->i32; fn linkat(oldfd:i32,old:*const std::os::raw::c_char,newfd:i32,new:*const std::os::raw::c_char,flags:i32)->i32; }
    fn name(value:&str)->Result<CString> { checked_name(value)?; CString::new(value).map_err(|_| invalid()) }
    fn open(parent:&File,child:&str,flags:i32)->Result<File> { let child=name(child)?; let fd=unsafe { openat(parent.as_raw_fd(),child.as_ptr(),flags,0o600u32) }; if fd<0 { return Err(fs_error(io::Error::last_os_error())); } Ok(unsafe { File::from_raw_fd(fd) }) }
    pub(super) fn open_directory(path:&Path)->Result<File> { OpenOptions::new().read(true).custom_flags(DIRECTORY|NOFOLLOW|CLOEXEC).open(path).map_err(fs_error) }
    pub(super) fn open_child_directory(parent:&File,_:&Path,child:&str)->Result<File> { open(parent,child,DIRECTORY|NOFOLLOW|CLOEXEC) }
    pub(super) fn new_file(parent:&File,_:&Path,child:&str)->Result<File> { open(parent,child,2|CREATE|EXCLUSIVE|NOFOLLOW|CLOEXEC) }
    pub(super) fn open_existing(parent:&File,_:&Path,child:&str)->Result<File> { open(parent,child,NOFOLLOW|CLOEXEC|NONBLOCK) }
    pub(super) fn require_absent(parent:&File,_:&Path,child:&str)->Result<()> {
        // openat(NO_FOLLOW) 拒绝符号链接；任何非 ENOENT（包括链接/FIFO/权限）均不授权覆盖。
        let child=name(child)?; let fd=unsafe { openat(parent.as_raw_fd(),child.as_ptr(),NOFOLLOW|CLOEXEC|NONBLOCK) };
        if fd>=0 { drop(unsafe { File::from_raw_fd(fd) }); return Err(conflict()); }
        let error=io::Error::last_os_error(); if error.kind()==io::ErrorKind::NotFound { Ok(()) } else { Err(conflict()) }
    }
    pub(super) fn mkdir(parent:&File,_:&Path,child:&str)->Result<()> { let child=name(child)?; if unsafe { mkdirat(parent.as_raw_fd(),child.as_ptr(),0o700) }!=0 { return Err(fs_error(io::Error::last_os_error())); } Ok(()) }
    pub(super) fn link(source:&File,_:&File,_:&Path,_:&str,to:&File,_:&Path,new:&str)->Result<bool> {
        let new=name(new)?;
        #[cfg(target_os="linux")]
        let status = {
            // linkat 跟随的是内核为已持有 FD 暴露的链接，不再按暂存文件名重新查找源 inode。
            // /proc 不可用或文件系统不支持 hard link 时真实失败，不回退到路径覆盖。
            let fd_path=CString::new(format!("/proc/self/fd/{}",source.as_raw_fd())).map_err(|_| invalid())?;
            unsafe { linkat(-100,fd_path.as_ptr(),to.as_raw_fd(),new.as_ptr(),0x400) }
        };
        #[cfg(target_os="macos")]
        let status = {
            extern "C" { fn fclonefileat(source:i32,destination:i32,path:*const std::os::raw::c_char,flags:u32)->i32; }
            // APFS 的 clone 从已打开源 FD 复制到目录 FD，新目标存在时系统拒绝；不支持则明确失败。
            unsafe { fclonefileat(source.as_raw_fd(),to.as_raw_fd(),new.as_ptr(),0) }
        };
        #[cfg(not(any(target_os="linux",target_os="macos")))]
        let status = -1;
        if status!=0 { let error=io::Error::last_os_error(); return Err(if error.kind()==io::ErrorKind::AlreadyExists {conflict()} else {fs_error(error)}); }
        Ok(false)
    }
    pub(super) fn remove_file(parent:&File,_:&Path,child:&str)->Result<()> { let child=name(child)?; if unsafe { unlinkat(parent.as_raw_fd(),child.as_ptr(),0) }!=0 { return Err(fs_error(io::Error::last_os_error())); } Ok(()) }
    pub(super) fn remove_dir(parent:&File,_:&Path,child:&str)->Result<()> { let child=name(child)?; if unsafe { unlinkat(parent.as_raw_fd(),child.as_ptr(),REMOVE_DIR) }!=0 { return Err(fs_error(io::Error::last_os_error())); } Ok(()) }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, time::Duration};
    #[test]
    fn relaunch_checks_idle_residual_state_and_every_active_phase_without_cancelling() {
        let state = ExportState::default();
        { let mut slot = state.0.lock().unwrap(); slot.owner = "main".into(); slot.epoch = 9; }
        assert!(state_relaunch_ready(&state).is_ok());
        let now = Instant::now();
        for phase in [Phase::Picking, Phase::Pending, Phase::Downloading, Phase::Committing, Phase::Cleaning] {
            let state = ExportState::default(); let cancel = Arc::new(Cancel::default());
            {
                let mut slot = state.0.lock().unwrap();
                let epoch = slot.lifecycle.reserve("owned".into(), now).unwrap();
                if phase != Phase::Picking { slot.lifecycle.publish("owned", epoch, now).unwrap(); }
                if matches!(phase, Phase::Downloading | Phase::Committing | Phase::Cleaning) { slot.lifecycle.consume("owned", epoch, now).unwrap(); }
                if phase == Phase::Committing { slot.lifecycle.commit("owned", epoch).unwrap(); }
                if phase == Phase::Cleaning { slot.lifecycle.cleaning("owned"); }
            }
            // Pending 即使没有 SaveGrant 或 cancel 句柄也不能被当作空闲。
            assert!(state_relaunch_ready(&state).is_err());
            { state.0.lock().unwrap().cancel = Some(cancel.clone()); }
            assert!(state_relaunch_ready(&state).is_err());
            let slot = state.0.lock().unwrap();
            assert_eq!(slot.lifecycle.phase(), Some(phase)); assert_eq!(slot.lifecycle.id(), Some("owned"));
            assert!(slot.cancel.as_ref().is_some_and(|token| Arc::ptr_eq(token, &cancel))); assert!(cancel.check().is_ok());
        }
        { state.0.lock().unwrap().cancel = Some(Arc::new(Cancel::default())); }
        assert!(state_relaunch_ready(&state).is_err());
        { let mut slot = state.0.lock().unwrap(); slot.cancel = None; slot.cleanup_failed = true; }
        assert!(state_relaunch_ready(&state).is_err()); assert!(state.0.lock().unwrap().cleanup_failed);
    }
    #[test]
    fn relaunch_never_waits_for_a_locked_or_poisoned_slot() {
        let state = ExportState::default(); let held = state.0.lock().unwrap();
        assert!(state_relaunch_ready(&state).is_err()); drop(held);
        assert!(state_relaunch_ready(&state).is_ok());
        let result = std::panic::catch_unwind(|| { let _held = state.0.lock().unwrap(); panic!("fixture poison"); });
        assert!(result.is_err()); assert!(state_relaunch_ready(&state).is_err());
    }
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("hcmcl-desktop-export-{}", Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(picker_path(fs::canonicalize(path).unwrap()).unwrap())
        }
        fn stage(&self, target: &str) -> (Stage, File) { Stage::new(SaveGrant::new(self.0.join(target), "official.jar".into()).unwrap()).unwrap() }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    fn write_fixture(mut file: File) { file.write_all(b"verified fixture").unwrap(); file.sync_all().unwrap(); drop(file); }
    #[test]
    fn native_publish_uses_verified_inode_and_cleanup_handles_moved_payload() {
        let fixture = Fixture::new(); let target = fixture.0.join("user-renamed.jar");
        let (mut stage, file) = fixture.stage("user-renamed.jar");
        assert_eq!(stage.grant.original_name, "official.jar");
        let expected = stage.file_identity; let staging = fixture.0.join(&stage.directory_name);
        write_fixture(file); stage.publish(16).unwrap(); stage.cleanup().unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"verified fixture"); assert!(!staging.exists());
        #[cfg(not(target_os="macos"))] {
            let file = File::open(target).unwrap(); assert_eq!(file_identity(&file, &file.metadata().unwrap()).unwrap(), expected);
        }
        #[cfg(target_os="macos")] let _ = expected;
    }
    #[test]
    fn existing_and_concurrent_target_keep_original_bytes() {
        let fixture = Fixture::new(); let target = fixture.0.join("chosen.jar"); fs::write(&target, b"original").unwrap();
        match SaveGrant::new(target.clone(), "official.jar".into()) { Err(error) => assert_eq!(error, conflict()), Ok(_) => panic!("existing target was authorized") }
        assert_eq!(fs::read(&target).unwrap(), b"original"); fs::remove_file(&target).unwrap();
        let (mut stage, file) = fixture.stage("chosen.jar"); write_fixture(file); fs::write(&target, b"concurrent winner").unwrap();
        assert!(stage.publish(16).is_err()); stage.cleanup().unwrap(); assert_eq!(fs::read(&target).unwrap(), b"concurrent winner");
    }
    #[test]
    fn directory_replacement_is_blocked_or_detected_without_publishing() {
        let fixture = Fixture::new(); let parent = fixture.0.join("chosen"); fs::create_dir(&parent).unwrap();
        let (mut stage, file) = Stage::new(SaveGrant::new(parent.join("chosen.jar"), "official.jar".into()).unwrap()).unwrap(); write_fixture(file);
        let moved = fixture.0.join("moved");
        #[cfg(windows)] { assert!(fs::rename(&parent, &moved).is_err()); stage.cleanup().unwrap(); }
        #[cfg(unix)] {
            fs::rename(&parent, &moved).unwrap(); fs::create_dir(&parent).unwrap();
            assert!(stage.publish(16).is_err()); assert!(!parent.join("chosen.jar").exists());
            // 清理从目录 FD 定位原暂存目录，不会删除替换目录中的项目。
            stage.cleanup().unwrap(); assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);
        }
    }
    #[test]
    fn capability_arguments_single_use_ttl_and_sticky_cleanup() {
        let id = format!("hcmcl-desktop-save:{}", Uuid::new_v4());
        assert!(arguments(&[json!("https://example.invalid/file"), json!(id), json!(0)]).is_err());
        assert!(arguments(&[json!("https://example.invalid/file"), json!("C:/forged.jar")]).is_err());
        for name in ["../a.jar", "a.jar ", "COM¹.jar", "a:stream"] { assert!(checked_name(name).is_err()); }
        let state = ExportState::default(); let now = Instant::now();
        let epoch = { let mut slot = state.0.lock().unwrap(); let epoch = slot.lifecycle.reserve(id.clone(), now).unwrap(); slot.cancel = Some(Arc::new(Cancel::default())); slot.lifecycle.publish(&id, epoch, now).unwrap(); epoch };
        expire(&state, &id, now + SAVE_TTL); assert!(state.0.lock().unwrap().lifecycle.consume(&id, epoch, now).is_err());
        state.0.lock().unwrap().lifecycle.reserve(id.clone(), now).unwrap();
        finish(&state, &id, true); assert!(state.0.lock().unwrap().cleanup_failed); finish(&state, &id, false); assert!(state.0.lock().unwrap().cleanup_failed);
        let mut lifecycle = Lifecycle::default(); let epoch = lifecycle.reserve(id.clone(), now).unwrap(); lifecycle.publish(&id, epoch, now).unwrap(); lifecycle.consume(&id, epoch, now).unwrap(); assert!(lifecycle.consume(&id, epoch, now).is_err());
    }
    #[test]
    fn cancellation_uses_cached_language_and_keeps_running_owner_until_finish() {
        for locale in ["zh-CN", "zh-TW", "en"] {
            let state = ExportState::default(); let now = Instant::now(); let cancel = Arc::new(Cancel::default());
            { let mut slot = state.0.lock().unwrap(); let epoch = slot.lifecycle.reserve("worker".into(), now).unwrap(); slot.lifecycle.publish("worker", epoch, now).unwrap(); slot.lifecycle.consume("worker", epoch, now).unwrap(); slot.locale = locale.into(); slot.cancel = Some(cancel.clone()); }
            with_language("other-language", || request_cancel(&state, Some("unrelated"))).unwrap();
            assert!(cancel.check().is_ok());
            with_language("other-language", || request_cancel(&state, Some("worker"))).unwrap();
            assert!(cancel.check().is_err());
            let slot = state.0.lock().unwrap();
            assert_eq!(slot.lifecycle.id(), Some("worker")); assert!(slot.cancel.is_some());
            assert!(slot_relaunch_ready(&slot).is_err()); drop(slot);
            finish(&state, "worker", false); assert!(state_relaunch_ready(&state).is_ok());
            { let mut slot = state.0.lock().unwrap(); let epoch = slot.lifecycle.reserve("committing".into(), now).unwrap(); slot.lifecycle.publish("committing", epoch, now).unwrap(); slot.lifecycle.consume("committing", epoch, now).unwrap(); slot.lifecycle.commit("committing", epoch).unwrap(); slot.cancel = Some(Arc::new(Cancel::default())); }
            let expected = with_language(locale, || state_error(StateError::CommitStarted));
            assert_eq!(with_language("other-language", || request_cancel(&state, None)).unwrap_err(), expected);
            let slot = state.0.lock().unwrap(); assert_eq!(slot.lifecycle.id(), Some("committing")); assert!(slot.cancel.as_ref().unwrap().check().is_ok());
        }
    }
    #[tokio::test]
    async fn ipc_drop_cancels_but_worker_keeps_stage_and_slot_until_actual_cleanup() {
        let fixture = Fixture::new(); let (stage, file) = fixture.stage("cancelled.jar"); let staging = fixture.0.join(&stage.directory_name);
        let state = ExportState::default(); let id = "worker".to_owned(); let now = Instant::now(); let cancel = Arc::new(Cancel::default());
        { let mut slot = state.0.lock().unwrap(); let epoch = slot.lifecycle.reserve(id.clone(), now).unwrap(); slot.lifecycle.publish(&id, epoch, now).unwrap(); slot.lifecycle.consume(&id, epoch, now).unwrap(); slot.cancel = Some(cancel.clone()); }
        let (release, waiting) = std::sync::mpsc::channel(); let (started, ready) = tokio::sync::oneshot::channel(); let worker_state = state.clone(); let worker_id = id.clone();
        let worker = tokio::spawn(async move {
            tokio::task::spawn_blocking(move || { let _ = started.send(()); waiting.recv_timeout(Duration::from_secs(3)).unwrap(); drop(file); stage.cleanup().unwrap(); }).await.unwrap();
            finish(&worker_state, &worker_id, false);
        });
        let signal_state = state.clone(); let signal_id = id.clone(); let guard = SignalOnDrop::new(Arc::new(move || { let _ = request_cancel(&signal_state, Some(&signal_id)); }));
        let entered = tokio::time::timeout(Duration::from_secs(2), ready).await;
        drop(guard); let signalled = cancel.check().is_err(); let held = staging.exists() && state.0.lock().unwrap().lifecycle.reserve("second".into(), now) == Err(StateError::Busy);
        // 无论前置条件是否符合预期都释放屏障，防止失败夹具留下阻塞 worker。
        let _ = release.send(()); worker.await.unwrap();
        assert!(entered.is_ok()); assert!(signalled && held); assert!(!staging.exists()); assert!(!fixture.0.join("cancelled.jar").exists()); assert!(state.0.lock().unwrap().lifecycle.reserve("second".into(), now).is_ok());
    }
}

#[cfg(windows)]
mod native {
    use super::*; use std::os::windows::fs::OpenOptionsExt;
    const BACKUP_SEMANTICS:u32=0x02000000; const OPEN_REPARSE:u32=0x00200000;
    pub(super) fn open_directory(path:&Path)->Result<File> { OpenOptions::new().read(true).share_mode(3).custom_flags(BACKUP_SEMANTICS|OPEN_REPARSE).open(path).map_err(fs_error) }
    pub(super) fn open_child_directory(_:&File,path:&Path,_:&str)->Result<File> { let file=open_directory(path)?; if is_link(&file.metadata().map_err(fs_error)?) { return Err(changed()); } Ok(file) }
    pub(super) fn new_file(_:&File,path:&Path,child:&str)->Result<File> { OpenOptions::new().write(true).create_new(true).access_mode(0x40000000|0x00010000).share_mode(1).custom_flags(OPEN_REPARSE).open(path.join(checked_name(child)?)).map_err(fs_error) }
    pub(super) fn open_existing(_:&File,path:&Path,child:&str)->Result<File> { let file=OpenOptions::new().read(true).share_mode(7).custom_flags(OPEN_REPARSE).open(path.join(checked_name(child)?)).map_err(fs_error)?; if is_link(&file.metadata().map_err(fs_error)?) { return Err(changed()); } Ok(file) }
    pub(super) fn require_absent(_:&File,parent:&Path,child:&str)->Result<()> { match fs::symlink_metadata(parent.join(checked_name(child)?)) { Err(error) if error.kind()==io::ErrorKind::NotFound=>Ok(()),_=>Err(conflict()) } }
    pub(super) fn mkdir(_:&File,parent:&Path,child:&str)->Result<()> { fs::create_dir(parent.join(checked_name(child)?)).map_err(fs_error) }
    pub(super) fn link(source:&File,_:&File,_:&Path,_:&str,_:&File,to:&Path,new:&str)->Result<bool> {
        use std::{ffi::c_void, os::windows::{ffi::OsStrExt, io::AsRawHandle}};
        #[repr(C)] struct RenameInfo { replace: u8, root: *mut c_void, length: u32, name: [u16; 1] }
        #[link(name="kernel32")] extern "system" { fn SetFileInformationByHandle(file:*mut c_void,class:i32,info:*mut c_void,size:u32)->i32; }
        // DELETE 属于已经独占的源句柄；不共享 WRITE/DELETE，第三方不能替换暂存 inode。
        // 所有祖先目录句柄拒绝共享 DELETE，因此绝对目标路径不能在此期间被换绑。
        let target=to.join(checked_name(new)?); let wide=target.as_os_str().encode_wide().collect::<Vec<_>>();
        let offset=std::mem::offset_of!(RenameInfo,name); let size=offset.checked_add(wide.len().checked_mul(2).ok_or_else(invalid)?).ok_or_else(invalid)?.max(std::mem::size_of::<RenameInfo>());
        let mut storage=vec![0usize;(size.max(std::mem::size_of::<RenameInfo>())+std::mem::size_of::<usize>()-1)/std::mem::size_of::<usize>()];
        let info=storage.as_mut_ptr().cast::<RenameInfo>();
        // 对齐分配的缓冲区固定布局，文件名是唯一可变长字段；ReplaceIfExists=false。
        unsafe { (*info).replace=0; (*info).root=std::ptr::null_mut(); (*info).length=(wide.len()*2) as u32; std::ptr::copy_nonoverlapping(wide.as_ptr(),storage.as_mut_ptr().cast::<u8>().add(offset).cast::<u16>(),wide.len()); }
        if unsafe { SetFileInformationByHandle(source.as_raw_handle(),3,info.cast(),size as u32) }==0 { let error=io::Error::last_os_error(); return Err(if error.kind()==io::ErrorKind::AlreadyExists || matches!(error.raw_os_error(),Some(80|183)) {conflict()} else {fs_error(error)}); }
        Ok(true)
    }
    pub(super) fn remove_file(_:&File,parent:&Path,child:&str)->Result<()> { fs::remove_file(parent.join(checked_name(child)?)).map_err(fs_error) }
    pub(super) fn remove_dir(_:&File,parent:&Path,child:&str)->Result<()> { fs::remove_dir(parent.join(checked_name(child)?)).map_err(fs_error) }
}

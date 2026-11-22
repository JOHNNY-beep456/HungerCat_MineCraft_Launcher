use serde_json::Value;
use std::path::Path;
use tauri::{plugin::TauriPlugin, AppHandle, Manager, Runtime, WebviewWindow};

fn language<R: Runtime>(app: &AppHandle<R>) -> String {
    use tauri::Manager;
    app.try_state::<crate::storage::Storage>()
        .and_then(|storage| storage.call("settings:get", &[]).ok().flatten())
        .and_then(|settings| settings.get("language").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_else(|| "zh-CN".into())
}
fn message(language: &str, cn: &str, tw: &str, en: &str) -> String {
    if language.starts_with("en") { en.into() }
    else if language == "zh-TW" || language.starts_with("zh-HK") { tw.into() }
    else { cn.into() }
}
fn cancellation_locale(cached: Option<&str>) -> &str {
    cached.filter(|value| !value.is_empty()).unwrap_or("zh-CN")
}
#[cfg(test)]
mod cancellation_locale_tests {
    use super::cancellation_locale;
    #[test]
    fn cancel_uses_registration_locale_or_storage_independent_default() {
        assert_eq!(cancellation_locale(Some("en-US")), "en-US");
        assert_eq!(cancellation_locale(Some("zh-TW")), "zh-TW");
        assert_eq!(cancellation_locale(None), "zh-CN");
        assert_eq!(cancellation_locale(Some("")), "zh-CN");
    }
}
fn unavailable(language: &str) -> String {
    message(language, "此平台尚未接通安全文档导入或两阶段保存", "此平台尚未接通安全文件匯入或兩階段儲存", "Secure document import or two-phase saving is not connected on this platform")
}
fn denied(language: &str) -> String {
    message(language, "文档授权已失效，请重新使用系统文件选择器选择", "文件授權已失效，請重新使用系統檔案選擇器選取", "Document authorization has expired; select it again with the system file picker")
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("hcmcl-files")
        .invoke_handler(|invoke| {
            invoke.resolver.reject("禁止从网页直接调用原生文档桥接 / 禁止從網頁直接呼叫原生文件橋接 / Direct WebView access to the native document bridge is forbidden");
            true
        })
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = api.register_android_plugin("top.johnnyblog.hcmcl.files", "HcmclFilesPlugin")?;
                app.manage(android::MobileFiles::new(handle));
            }
            #[cfg(not(target_os = "android"))]
            { let _ = (app, api); }
            Ok(())
        })
        .on_event(|app, event| {
            #[cfg(target_os = "android")]
            match event {
                tauri::RunEvent::WindowEvent { label, event, .. } if label == "main" => {
                    if matches!(event, tauri::WindowEvent::Destroyed) { android::invalidate(app, true); }
                    else if matches!(event, tauri::WindowEvent::CloseRequested { .. }) { android::invalidate(app, false); }
                }
                tauri::RunEvent::Exit => android::invalidate(app, true),
                _ => {},
            }
            #[cfg(not(target_os = "android"))]
            { let _ = (app, event); }
        })
        .on_drop(|app| {
            #[cfg(target_os = "android")]
            android::invalidate(&app, true);
            #[cfg(not(target_os = "android"))]
            let _ = app;
        })
        .build()
}

pub async fn call<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>, channel: &str, args: &[Value]) -> Result<Option<Value>, String> {
    if !matches!(channel, "shell:pickFile" | "shell:pickFiles" | "shell:saveFile") { return Ok(None); }
    let locale = language(app);
    if window.label() != "main" { return Err(denied(&locale)); }
    if channel == "shell:saveFile" {
        #[cfg(target_os = "android")]
        { return android::save_capability(app, window, args, &locale).await.map(Some); }
        #[cfg(not(target_os = "android"))]
        { return Err(unavailable(&locale)); }
    }
    #[cfg(target_os = "android")]
    { android::pick(app, window, channel == "shell:pickFiles", args, &locale).await.map(Some) }
    #[cfg(not(target_os = "android"))]
    { let _ = args; Err(unavailable(&locale)) }
}

/// 仅 Android 的 mods:downloadTo 宿主；能力字符串不是实际路径，也不能用于其它文件 IPC。
pub async fn export_download(app: &AppHandle, window: &WebviewWindow, args: &[Value], settings: &Value) -> Result<Option<Value>, String> {
    #[cfg(target_os = "android")]
    { android::export_download(app, window, args, settings).await.map(Some) }
    #[cfg(not(target_os = "android"))]
    { let _ = (app, window, args, settings); Ok(None) }
}
/// 只发送取消请求。进入提供程序提交后明确报错，不伪装为已撤销。
pub fn cancel_download(app: &AppHandle, task_id: Option<&str>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    { android::cancel_export(app, task_id) }
    #[cfg(not(target_os = "android"))]
    { let _ = (app, task_id); Ok(()) }
}

pub fn require_imported_file<R: Runtime>(app: &AppHandle<R>, path: &Path) -> Result<(), String> {
    #[cfg(target_os = "android")]
    { android::require_imported(app, path, &language(app)) }
    #[cfg(not(target_os = "android"))]
    { let _ = path; Err(unavailable(&language(app))) }
}

#[derive(Debug)]
pub struct SaveOutcome {
    pub size: u64,
    pub cleanup_incomplete: bool,
}

#[cfg(target_os = "android")]
pub use android::{begin_save, cancel_pending, cancel_save, commit_save, PreparedSave};

#[cfg(not(target_os = "android"))]
pub struct PreparedSave<R: Runtime>(std::marker::PhantomData<R>);
#[cfg(not(target_os = "android"))]
impl<R: Runtime> PreparedSave<R> { pub fn staging_path(&self) -> &Path { Path::new("") } }
#[cfg(not(target_os = "android"))]
pub async fn begin_save<R: Runtime>(app: &AppHandle<R>, _: &WebviewWindow<R>, _: &str) -> Result<Option<PreparedSave<R>>, String> { Err(unavailable(&language(app))) }
#[cfg(not(target_os = "android"))]
pub async fn commit_save<R: Runtime>(_: PreparedSave<R>) -> Result<SaveOutcome, String> { Err(unavailable("zh-CN")) }
#[cfg(not(target_os = "android"))]
pub async fn cancel_save<R: Runtime>(_: PreparedSave<R>) -> Result<(), String> { Err(unavailable("zh-CN")) }
#[cfg(not(target_os = "android"))]
pub async fn cancel_pending<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> { Err(unavailable(&language(app))) }

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;
    use std::{collections::BTreeMap, fs::{self, File, Metadata, OpenOptions}, os::unix::fs::{MetadataExt, OpenOptionsExt}, path::{Component, PathBuf}, sync::{Arc, Mutex}, time::{Instant, SystemTime}};
    use tauri::{plugin::{mobile::PluginInvokeError, PluginHandle}, Emitter, Manager};
    use crate::{downloads::Cancel, mobile_export::{CleanupStatus, Lifecycle, Phase, SignalOnDrop, StateError, SAVE_TTL}};
    use uuid::Uuid;

    const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
    const MAX_FILES: usize = 64;
    #[cfg(any(target_arch = "arm", target_arch = "aarch64"))]
    const OPEN_NOFOLLOW: i32 = 0x8000;
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    const OPEN_NOFOLLOW: i32 = 0x20000;
    #[cfg(target_arch = "riscv64")]
    const OPEN_NOFOLLOW: i32 = 0x400000;
    #[cfg(not(any(target_arch = "arm", target_arch = "aarch64", target_arch = "x86", target_arch = "x86_64", target_arch = "riscv64")))]
    const OPEN_NOFOLLOW: i32 = 0;
    #[derive(Clone, Debug, PartialEq, Eq)]
    struct Stamp { size: u64, modified: SystemTime, device: u64, inode: u64 }
    #[derive(Clone)]
    struct Grant { session: String, request: String, stamp: Stamp }
    #[derive(Default)]
    struct Grants { generation: u64, destroyed: bool, settling: bool, session: Option<String>, root: Option<PathBuf>, files: BTreeMap<PathBuf, Grant> }
    struct PendingExport<R: Runtime> { save: PreparedSave<R>, original_name: String }
    struct ExportSlot<R: Runtime> {
        lifecycle: Lifecycle, pending: Option<PendingExport<R>>, cancel: Option<Arc<Cancel>>, epoch: u64,
        deferred_sessions: Vec<String>, cleanup: CleanupStatus,
        // 只在任务登记时读取配置；取消路径只能使用此缓存，不能等待 Storage。
        locale: String,
    }
    pub(super) struct MobileFiles<R: Runtime> {
        handle: PluginHandle<R>, grants: Arc<Mutex<Grants>>, initialize: Arc<tokio::sync::Mutex<()>>, exports: Arc<Mutex<ExportSlot<R>>>, export_done: Arc<tokio::sync::Notify>,
    }
    impl<R: Runtime> Clone for MobileFiles<R> {
        fn clone(&self) -> Self { Self { handle: self.handle.clone(), grants: self.grants.clone(), initialize: self.initialize.clone(), exports: self.exports.clone(), export_done: self.export_done.clone() } }
    }
    impl<R: Runtime> MobileFiles<R> {
        pub(super) fn new(handle: PluginHandle<R>) -> Self { Self { handle, grants: Arc::new(Mutex::new(Grants::default())), initialize: Arc::new(tokio::sync::Mutex::new(())), exports: Arc::new(Mutex::new(ExportSlot { lifecycle: Lifecycle::default(), pending: None, cancel: None, epoch: 0, deferred_sessions: Vec::new(), cleanup: CleanupStatus::default(), locale: "zh-CN".into() })), export_done: Arc::new(tokio::sync::Notify::new()) } }
    }
    #[derive(Clone)]
    struct Session { id: String, root: PathBuf, generation: u64 }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct NativeCancellation { #[serde(default)] cancelled: bool, #[serde(default)] cleanup_incomplete: bool }
    #[derive(Deserialize)]
    struct NativeRoot { root: String }
    #[derive(Deserialize)]
    struct NativeFile { path: String, name: String, size: u64 }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct NativePick { cancelled: bool, #[serde(default)] files: Vec<NativeFile>, #[serde(default)] cleanup_incomplete: bool }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct NativeSave { cancelled: bool, #[serde(default)] ticket: String, #[serde(default)] path: String, #[serde(default)] name: String, #[serde(default)] cleanup_incomplete: bool }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct NativeCommitted { cancelled: bool, #[serde(default)] saved: bool, #[serde(default)] size: u64, #[serde(default)] cleanup_incomplete: bool }

    fn native_error(locale: &str, error: PluginInvokeError) -> String {
        let code = match &error { PluginInvokeError::InvokeRejected(response) => response.code.as_deref().unwrap_or("io"), _ => "io" };
        match code {
            "busy" => message(locale, "另一个文档选择或复制操作尚未结束", "另一個文件選取或複製操作尚未結束", "Another document selection or copy operation has not finished"),
            "limit" => message(locale, "文件或本次选择总量超过 2 GiB", "檔案或本次選取總量超過 2 GiB", "The file or selected batch exceeds 2 GiB"),
            "session" | "changed" | "grant" => denied(locale),
            _ => message(locale, "文档操作失败；若已创建目标文档，请检查提供程序中是否残留未完成文档", "文件操作失敗；若已建立目標文件，請檢查提供者是否殘留未完成文件", "Document operation failed; if a destination was created, check the provider for an unfinished document"),
        }
    }
    fn cleanup_error(locale: &str) -> String {
        message(locale, "操作已取消或保存已完成，但提供程序未能确认完整清理；请检查目标位置", "操作已取消或儲存已完成，但提供者未能確認完整清理；請檢查目標位置", "The operation was cancelled or saved, but cleanup could not be fully confirmed; check the destination")
    }
    fn state<R: Runtime>(app: &AppHandle<R>, locale: &str) -> Result<MobileFiles<R>, String> {
        app.try_state::<MobileFiles<R>>().map(|state| state.inner().clone()).ok_or_else(|| unavailable(locale))
    }
    fn native_save_result<R: Runtime, T>(state: &MobileFiles<R>, result: Result<T, PluginInvokeError>, locale: &str) -> Result<T, String> {
        // Tauri 的 InvokeRejected 使用 ErrorResponse<()>，Kotlin reject 的清理详情无法取回。
        // 必须在再次 cancelRequest 之前粘滞记录未知状态；空取消成功不能清除此记录。
        state.exports.lock().map_err(|_| cleanup_error(locale))?.cleanup.native_result(result).map_err(|()| cleanup_error(locale))
    }
    async fn background<T: Send + 'static>(locale: &str, work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
        tauri::async_runtime::spawn_blocking(work).await.map_err(|_| denied(locale))?
    }
    fn uuid(value: &str) -> bool { Uuid::parse_str(value).map(|parsed| parsed.to_string() == value).unwrap_or(false) }
    fn plain_path(path: &Path, locale: &str) -> Result<(), String> {
        if !path.is_absolute() || path.components().any(|part| matches!(part, Component::ParentDir | Component::CurDir)) { return Err(denied(locale)); }
        for parent in path.ancestors() {
            let metadata = fs::symlink_metadata(parent).map_err(|_| denied(locale))?;
            if metadata.file_type().is_symlink() { return Err(denied(locale)); }
        }
        if fs::canonicalize(path).map_err(|_| denied(locale))? != path { return Err(denied(locale)); }
        Ok(())
    }
    fn validate_root(path: &Path, session: &str, locale: &str) -> Result<PathBuf, String> {
        plain_path(path, locale)?;
        let metadata = fs::symlink_metadata(path).map_err(|_| denied(locale))?;
        extern "C" { fn geteuid() -> u32; }
        if !metadata.is_dir() || metadata.uid() != unsafe { geteuid() } || metadata.mode() & 0o077 != 0
            || path.file_name().and_then(|value| value.to_str()) != Some(session)
            || path.parent().and_then(Path::file_name).and_then(|value| value.to_str()) != Some("hcmcl-saf-staging")
            || path.parent().and_then(Path::parent).and_then(Path::file_name).and_then(|value| value.to_str()) != Some("no_backup") { return Err(denied(locale)); }
        Ok(path.to_path_buf())
    }
    fn stamp(metadata: Metadata, owner: u32, locale: &str) -> Result<Stamp, String> {
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.uid() != owner || metadata.nlink() != 1 || metadata.mode() & 0o077 != 0 || metadata.len() > MAX_BYTES { return Err(denied(locale)); }
        Ok(Stamp { size: metadata.len(), modified: metadata.modified().map_err(|_| denied(locale))?, device: metadata.dev(), inode: metadata.ino() })
    }
    fn snapshot(root: &Path, request: &str, path: &Path, locale: &str) -> Result<(PathBuf, Stamp), String> {
        if !uuid(request) || !path.starts_with(root) { return Err(denied(locale)); }
        let parts: Vec<_> = path.strip_prefix(root).map_err(|_| denied(locale))?.components().collect();
        if parts.len() != 3 || parts[0].as_os_str() != std::ffi::OsStr::new(request)
            || !uuid(parts[1].as_os_str().to_str().unwrap_or("")) || !matches!(parts[2], Component::Normal(_)) { return Err(denied(locale)); }
        plain_path(path, locale)?;
        let owner = fs::metadata(root).map_err(|_| denied(locale))?.uid();
        let before = stamp(fs::symlink_metadata(path).map_err(|_| denied(locale))?, owner, locale)?;
        if OPEN_NOFOLLOW == 0 { return Err(denied(locale)); }
        let first = OpenOptions::new().read(true).custom_flags(OPEN_NOFOLLOW).open(path).map_err(|_| denied(locale))?;
        if stamp(first.metadata().map_err(|_| denied(locale))?, owner, locale)? != before { return Err(denied(locale)); }
        plain_path(path, locale)?;
        let check = File::open(path).map_err(|_| denied(locale))?;
        if stamp(check.metadata().map_err(|_| denied(locale))?, owner, locale)? != before { return Err(denied(locale)); }
        Ok((path.to_path_buf(), before))
    }
    fn check_session<R: Runtime>(state: &MobileFiles<R>, session: &Session, locale: &str) -> Result<(), String> {
        let grants = state.grants.lock().map_err(|_| denied(locale))?;
        if grants.destroyed || grants.generation != session.generation || grants.session.as_deref() != Some(&session.id) || grants.root.as_ref() != Some(&session.root) { Err(denied(locale)) } else { Ok(()) }
    }
    struct CancelGuard<R: Runtime> { state: MobileFiles<R>, session: String, request: Option<String>, armed: bool }
    impl<R: Runtime> CancelGuard<R> {
        fn disarm(&mut self) { self.armed = false; }
        async fn cancel(&mut self, locale: &str) -> Result<(), String> {
            if !self.armed { return Ok(()); }
            let result = cancel_native(&self.state, &self.session, self.request.as_deref(), locale).await;
            self.armed = false; result
        }
    }
    impl<R: Runtime> Drop for CancelGuard<R> {
        fn drop(&mut self) {
            if !self.armed { return; }
            let state = self.state.clone(); let session = self.session.clone(); let request = self.request.clone();
            tauri::async_runtime::spawn(async move { let _ = cancel_native(&state, &session, request.as_deref(), "zh-CN").await; });
        }
    }
    async fn cancel_native<R: Runtime>(state: &MobileFiles<R>, session: &str, request: Option<&str>, locale: &str) -> Result<(), String> {
        {
            let mut grants = state.grants.lock().map_err(|_| denied(locale))?;
            grants.files.retain(|_, grant| grant.session != session || request.map(|request| grant.request != request).unwrap_or(false));
        }
        let command = if request.is_some() { "cancelRequest" } else { "cancelAll" };
        let result: NativeCancellation = state.handle.run_mobile_plugin_async(command, json!({"session":session,"request":request.unwrap_or(""),"language":locale})).await.map_err(|error| native_error(locale, error))?;
        if !result.cancelled || result.cleanup_incomplete { Err(cleanup_error(locale)) } else { Ok(()) }
    }
    async fn ensure_session<R: Runtime>(state: &MobileFiles<R>, locale: &str) -> Result<Session, String> {
        let _initializing = state.initialize.lock().await;
        let (id, generation) = {
            let mut grants = state.grants.lock().map_err(|_| denied(locale))?;
            if grants.destroyed || grants.settling { return Err(denied(locale)); }
            if let (Some(id), Some(root)) = (&grants.session, &grants.root) { return Ok(Session { id: id.clone(), root: root.clone(), generation: grants.generation }); }
            let id = Uuid::new_v4().to_string(); grants.session = Some(id.clone()); grants.root = None;
            (id, grants.generation)
        };
        let mut guard = CancelGuard { state: state.clone(), session: id.clone(), request: None, armed: true };
        let initialized: Result<PathBuf, String> = async {
            let result: NativeRoot = state.handle.run_mobile_plugin_async("initialize", json!({"session":id,"language":locale})).await.map_err(|error| native_error(locale, error))?;
            let path = PathBuf::from(result.root); let validate_id = id.clone(); let validate_locale = locale.to_owned();
            let root = background(locale, move || validate_root(&path, &validate_id, &validate_locale)).await?;
            {
                let mut grants = state.grants.lock().map_err(|_| denied(locale))?;
                if grants.destroyed || grants.generation != generation || grants.session.as_deref() != Some(&id) { return Err(denied(locale)); }
                grants.root = Some(root.clone());
            }
            Ok(root)
        }.await;
        match initialized {
            Ok(root) => { guard.disarm(); Ok(Session { id, root, generation }) }
            Err(error) => { guard.cancel(locale).await?; if let Ok(mut grants) = state.grants.lock() { if grants.session.as_deref() == Some(&id) { grants.session = None; grants.root = None; } } Err(error) }
        }
    }
    pub(super) fn invalidate<R: Runtime>(app: &AppHandle<R>, destroyed: bool) {
        if let Some(state) = app.try_state::<MobileFiles<R>>() { invalidate_state(state.inner().clone(), destroyed); }
    }
    fn invalidate_state<R: Runtime>(state: MobileFiles<R>, destroyed: bool) {
        // 一致锁序 grants -> exports。只标记失效；原位写的 File 仍由 worker 持有时不删会话目录。
        let (cleanup, picking) = {
            let Ok(mut grants) = state.grants.lock() else { return; };
            let Ok(mut slot) = state.exports.lock() else { return; };
            grants.generation = grants.generation.wrapping_add(1); grants.destroyed |= destroyed; grants.files.clear(); grants.root = None;
            if let Some(session) = grants.session.take() { slot.deferred_sessions.push(session); }
            let mut idle_cleanup = None;
            if slot.lifecycle.phase().is_none() && !slot.deferred_sessions.is_empty() {
                let id = format!("hcmcl-save:{}", Uuid::new_v4());
                if slot.lifecycle.reserve(id.clone(), Instant::now()).is_ok() { slot.lifecycle.cleaning(&id); idle_cleanup = Some(id); }
            }
            let was_picking = slot.lifecycle.phase() == Some(Phase::Picking);
            slot.lifecycle.invalidate(destroyed);
            if let Some(cancel) = &slot.cancel { cancel.stop(); }
            grants.settling = slot.lifecycle.phase().is_some();
            let pending = slot.pending.take();
            if let Some(pending) = pending {
                let id = slot.lifecycle.id().unwrap_or("").to_owned(); slot.lifecycle.cleaning(&id);
                (Some((id, Some(pending.save))), was_picking)
            } else { (idle_cleanup.map(|id| (id, None)), was_picking) }
        };
        // picker 尚未取得 File，可以定向唤醒/取消；Downloading/Committing 必须由 worker 收尾。
        if picking { cancel_picking(&state); }
        if let Some((id, save)) = cleanup { tauri::async_runtime::spawn(async move { let failed = if let Some(save) = save { cancel_save(save).await.is_err() } else { false }; finish_export(&state, &id, failed).await; }); }
    }
    async fn finish_export<R: Runtime>(state: &MobileFiles<R>, id: &str, failed: bool) {
        let locale = {
            let Ok(mut slot) = state.exports.lock() else { return; };
            if slot.lifecycle.id() != Some(id) { return; }
            slot.cleanup.record_cleanup(failed); slot.lifecycle.cleaning(id);
            cancellation_locale(Some(&slot.locale)).to_owned()
        };
        loop {
            let sessions = {
                let Ok(mut slot) = state.exports.lock() else { return; };
                if slot.lifecycle.id() != Some(id) { return; }
                std::mem::take(&mut slot.deferred_sessions)
            };
            for session in sessions { if cancel_native(state, &session, None, &locale).await.is_err() { if let Ok(mut slot) = state.exports.lock() { slot.cleanup.record_cleanup(true); } } }
            let finished = {
                let Ok(mut grants) = state.grants.lock() else { return; };
                let Ok(mut slot) = state.exports.lock() else { return; };
                if !slot.deferred_sessions.is_empty() { false }
                else if slot.lifecycle.finish(id) { slot.cancel = None; grants.settling = false; true }
                else { return; }
            };
            if finished { state.export_done.notify_waiters(); return; }
        }
    }
    fn filters(args: &[Value], locale: &str) -> Result<Value, String> {
        if args.len() > 1 { return Err(denied(locale)); }
        let Some(value) = args.first().filter(|value| !value.is_null()) else { return Ok(json!([])); };
        let values = value.as_array().filter(|items| items.len() <= 32).ok_or_else(|| denied(locale))?;
        let mut filters = Vec::new();
        for value in values {
            let extensions = value.get("extensions").and_then(Value::as_array).filter(|items| !items.is_empty() && items.len() <= 32).ok_or_else(|| denied(locale))?;
            let mut checked = Vec::new();
            for extension in extensions {
                let extension = extension.as_str().filter(|value| !value.is_empty() && value.len() <= 32 && (*value == "*" || value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte)))).ok_or_else(|| denied(locale))?;
                checked.push(extension);
            }
            filters.push(json!({"extensions":checked}));
        }
        Ok(Value::Array(filters))
    }
    pub(super) async fn pick<R: Runtime>(app: &AppHandle<R>, _: &WebviewWindow<R>, multiple: bool, args: &[Value], locale: &str) -> Result<Value, String> {
        let filters = filters(args, locale)?; let state = state(app, locale)?; let session = ensure_session(&state, locale).await?;
        let request = Uuid::new_v4().to_string();
        let mut guard = CancelGuard { state: state.clone(), session: session.id.clone(), request: Some(request.clone()), armed: true };
        let result: NativePick = state.handle.run_mobile_plugin_async("pickDocuments", json!({"session":session.id,"request":request,"multiple":multiple,"filters":filters,"language":locale})).await.map_err(|error| native_error(locale, error))?;
        if result.cancelled {
            guard.cancel(locale).await?;
            if result.cleanup_incomplete { return Err(cleanup_error(locale)); }
            return Ok(if multiple { json!([]) } else { Value::Null });
        }
        if result.files.is_empty() || result.files.len() > MAX_FILES || !multiple && result.files.len() != 1 { return Err(denied(locale)); }
        let validate_root = session.root.clone(); let validate_request = request.clone(); let validate_locale = locale.to_owned();
        let records = background(locale, move || {
            let mut total = 0u64; let mut records = BTreeMap::new();
            for file in result.files {
                let path = PathBuf::from(file.path);
                if path.file_name().and_then(|name| name.to_str()) != Some(file.name.as_str()) { return Err(denied(&validate_locale)); }
                let (path, stamp) = snapshot(&validate_root, &validate_request, &path, &validate_locale)?;
                total = total.checked_add(stamp.size).ok_or_else(|| denied(&validate_locale))?;
                if total > MAX_BYTES || stamp.size != file.size || records.insert(path, stamp).is_some() { return Err(denied(&validate_locale)); }
            }
            Ok(records)
        }).await?;
        check_session(&state, &session, locale)?;
        let paths: Vec<_> = records.keys().map(|path| path.to_str().map(str::to_owned).ok_or_else(|| denied(locale))).collect::<Result<_, _>>()?;
        {
            let mut grants = state.grants.lock().map_err(|_| denied(locale))?;
            if grants.destroyed || grants.generation != session.generation || grants.session.as_deref() != Some(&session.id) || grants.files.len().saturating_add(records.len()) > 4096 { return Err(denied(locale)); }
            for (path, stamp) in records { grants.files.insert(path, Grant { session: session.id.clone(), request: request.clone(), stamp }); }
        }
        guard.disarm(); Ok(if multiple { json!(paths) } else { json!(paths[0]) })
    }
    pub(super) fn require_imported<R: Runtime>(app: &AppHandle<R>, path: &Path, locale: &str) -> Result<(), String> {
        let state = state(app, locale)?;
        let (session, grant) = {
            let grants = state.grants.lock().map_err(|_| denied(locale))?;
            if grants.destroyed { return Err(denied(locale)); }
            let grant = grants.files.get(path).cloned().ok_or_else(|| denied(locale))?;
            let session = Session { id: grants.session.clone().ok_or_else(|| denied(locale))?, root: grants.root.clone().ok_or_else(|| denied(locale))?, generation: grants.generation };
            (session, grant)
        };
        let (path, stamp) = snapshot(&session.root, &grant.request, path, locale)?;
        check_session(&state, &session, locale)?;
        let grants = state.grants.lock().map_err(|_| denied(locale))?;
        if grant.session == session.id && grants.files.get(&path).map(|grant| &grant.stamp) == Some(&stamp) { Ok(()) } else { Err(denied(locale)) }
    }
    fn export_error(locale: &str, error: StateError) -> String {
        match error {
            StateError::Busy => message(locale, "另一个文档导出尚未结束，请完成或取消后重试", "另一個文件匯出尚未結束，請完成或取消後重試", "Another document export has not finished; complete or cancel it first"),
            StateError::CommitStarted => message(locale, "已进入文档提交，无法保证取消；请等待结果并检查目标文档", "已進入文件提交，無法保證取消；請等待結果並檢查目標文件", "Document commit has started; cancellation cannot be guaranteed. Wait for the result and check the destination"),
            StateError::Denied => denied(locale),
        }
    }
    fn cancel_picking<R: Runtime>(state: &MobileFiles<R>) {
        if let Ok(slot) = state.exports.lock() { if slot.lifecycle.phase() == Some(Phase::Picking) { if let Some(cancel) = &slot.cancel { cancel.stop(); } } }
    }
    // 仅查已登记的导出槽并发送信号；未知任务不初始化插件、读取配置或读取密钥。
    fn request_export_cancel<R: Runtime>(state: &MobileFiles<R>, task_id: Option<&str>) -> Result<(), String> {
        let cleanup = {
            let mut slot = state.exports.lock().map_err(|_| denied("zh-CN"))?;
            let locale = cancellation_locale(Some(&slot.locale)).to_owned();
            if !slot.lifecycle.cancel(task_id).map_err(|error| export_error(&locale, error))? { return Ok(()); }
            if let Some(cancel) = &slot.cancel { cancel.stop(); }
            if let Some(pending) = slot.pending.take() {
                let id = slot.lifecycle.id().unwrap_or("").to_owned(); slot.lifecycle.cleaning(&id); Some((id, pending.save))
            } else { None }
        };
        if let Some((id, save)) = cleanup {
            let state = state.clone(); tauri::async_runtime::spawn(async move { let failed = cancel_save(save).await.is_err(); finish_export(&state, &id, failed).await; });
        }
        Ok(())
    }
    pub(super) fn cancel_export<R: Runtime>(app: &AppHandle<R>, task_id: Option<&str>) -> Result<(), String> {
        let Some(state) = app.try_state::<MobileFiles<R>>() else { return Ok(()); };
        request_export_cancel(state.inner(), task_id)
    }
    fn start_expiry<R: Runtime>(state: MobileFiles<R>, id: String) {
        tauri::async_runtime::spawn(async move {
            let deadline = tokio::time::Instant::now() + SAVE_TTL;
            loop {
                let notified = state.export_done.notified(); tokio::pin!(notified); notified.as_mut().enable();
                if !state.exports.lock().map(|slot| slot.lifecycle.id() == Some(id.as_str())).unwrap_or(false) { return; }
                tokio::select! { _ = &mut notified => {}, _ = tokio::time::sleep_until(deadline) => break }
            }
            let expired = state.exports.lock().map(|mut slot| slot.lifecycle.expire(&id, Instant::now())).unwrap_or(false);
            if expired { let _ = request_export_cancel(&state, Some(&id)); }
        });
    }
    pub(super) async fn save_capability<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>, args: &[Value], locale: &str) -> Result<Value, String> {
        if args.len() != 1 { return Err(denied(locale)); }
        let name = args[0].as_str().filter(|name| !name.is_empty() && name.len() <= 512 && !name.chars().any(|c| c.is_control() || "/\\".contains(c))).ok_or_else(|| denied(locale))?.to_owned();
        let state = state(app, locale)?; let id = format!("hcmcl-save:{}", Uuid::new_v4()); let cancel = Arc::new(Cancel::default());
        let epoch = {
            let grants = state.grants.lock().map_err(|_| denied(locale))?;
            let mut slot = state.exports.lock().map_err(|_| denied(locale))?;
            if grants.destroyed || grants.settling { return Err(denied(locale)); }
            if slot.cleanup.is_unconfirmed() { return Err(cleanup_error(locale)); }
            let epoch = slot.lifecycle.reserve(id.clone(), Instant::now()).map_err(|error| export_error(locale, error))?;
            slot.cancel = Some(cancel); slot.epoch = epoch; slot.locale = locale.to_owned(); epoch
        };
        start_expiry(state.clone(), id.clone());
        let signal_state = state.clone(); let signal_id = id.clone();
        let mut ipc_guard = SignalOnDrop::new(Arc::new(move || { let _ = request_export_cancel(&signal_state, Some(&signal_id)); }));
        let app = app.clone(); let window = window.clone(); let locale = locale.to_owned(); let join_locale = locale.clone();
        let worker = tauri::async_runtime::spawn(async move {
            let result = begin_save_impl(&app, &window, &name, Some(&id)).await;
            match result {
                Ok(Some(save)) => {
                    let mut save = Some(save);
                    let published = {
                        let mut slot = state.exports.lock().map_err(|_| denied(&locale))?;
                        if slot.cancel.as_ref().is_some_and(|cancel| cancel.check().is_err()) { false }
                        else if slot.lifecycle.publish(&id, epoch, Instant::now()).is_ok() { slot.pending = Some(PendingExport { save: save.take().unwrap(), original_name: name }); true }
                        else { false }
                    };
                    if published { Ok(json!(id)) }
                    else { let failed = cancel_save(save.unwrap()).await.is_err(); finish_export(&state, &id, failed).await; Err(if failed { cleanup_error(&locale) } else { denied(&locale) }) }
                }
                Ok(None) => { finish_export(&state, &id, false).await; Ok(Value::Null) }
                Err(error) => { let failed = error == cleanup_error(&locale); finish_export(&state, &id, failed).await; Err(error) }
            }
        });
        let result = worker.await.map_err(|_| message(&join_locale, "文档选择后台任务异常，未报告保存成功", "文件選取背景工作異常，未回報儲存成功", "Document selection worker failed; no save success was reported"))?;
        ipc_guard.disarm(); result
    }
    fn download_args(args: &[Value], locale: &str) -> Result<(String, String, Option<u64>), String> {
        if !(2..=3).contains(&args.len()) { return Err(denied(locale)); }
        let url = args[0].as_str().filter(|url| !url.is_empty() && url.len() <= 32768 && !url.chars().any(char::is_control)).ok_or_else(|| denied(locale))?.to_owned();
        let id = args[1].as_str().filter(|id| id.strip_prefix("hcmcl-save:").is_some_and(uuid)).ok_or_else(|| denied(locale))?.to_owned();
        let hint = match args.get(2) { None | Some(Value::Null) => None, Some(value) => Some(value.as_u64().filter(|size| *size > 0 && *size <= MAX_BYTES).ok_or_else(|| denied(locale))?) };
        Ok((url, id, hint))
    }
    fn export_progress(app: &AppHandle, id: &str, title: &str, phase: &str, bytes: u64, total: u64, success: bool, locale: &str) {
        let task = if phase == "done" { if success { message(locale, "导出完成", "匯出完成", "Export complete") } else { message(locale, "导出未完成，请检查错误", "匯出未完成，請檢查錯誤", "Export did not complete; check the error") } }
            else if phase == "commit" { message(locale, "提交文档中，无法保证取消", "提交文件中，無法保證取消", "Committing document; cancellation cannot be guaranteed") } else { title.to_owned() };
        let percent = if phase == "done" { if success { 100.0 } else { 0.0 } } else if total > 0 { ((bytes as f64 / total as f64) * 99.0).min(99.0) } else { 0.0 };
        let _ = app.emit_to("main", "launcher:event", json!({"channel":"download:progress","payload":{"taskId":id,"jobTitle":title,"task":task,"current":if success { 1 } else { 0 },"total":1,"currentBytes":bytes,"totalBytes":total,"phase":if phase == "done" { "done" } else { "mod" },"percent":percent,"speed":0}}));
    }
    pub(super) async fn export_download(app: &AppHandle, window: &WebviewWindow, args: &[Value], settings: &Value) -> Result<Value, String> {
        let locale = language(app); if window.label() != "main" { return Err(denied(&locale)); }
        let (url, id, hint) = download_args(args, &locale)?; let state = state(app, &locale)?;
        let (pending, cancel, epoch) = {
            let mut slot = state.exports.lock().map_err(|_| denied(&locale))?;
            let epoch = slot.epoch;
            slot.lifecycle.consume(&id, epoch, Instant::now()).map_err(|error| export_error(&locale, error))?;
            let pending = slot.pending.take().ok_or_else(|| denied(&locale))?;
            let cancel = slot.cancel.clone().ok_or_else(|| denied(&locale))?;
            (pending, cancel, epoch)
        };
        let signal_state = state.clone(); let signal_id = id.clone();
        let mut ipc_guard = SignalOnDrop::new(Arc::new(move || { let _ = request_export_cancel(&signal_state, Some(&signal_id)); }));
        let app = app.clone(); let settings = settings.clone(); let join_locale = locale.clone();
        let worker = tauri::async_runtime::spawn(async move {
            let PendingExport { save, original_name } = pending; let mut save = Some(save);
            let counters = Arc::new(Mutex::new((0u64, hint.unwrap_or(0))));
            export_progress(&app, &id, &original_name, "mod", 0, hint.unwrap_or(0), false, &locale);
            let downloading: Result<u64, String> = async {
                cancel.check()?;
                let bound = tokio::select! { biased; _ = cancel.cancelled() => return Err(denied(&locale)), bound = crate::catalog::prepare_export_download(&url, &original_name, hint, &settings) => bound? };
                cancel.check()?;
                let file = save.as_ref().unwrap().open_staging().await?;
                cancel.check()?;
                let emit_app = app.clone(); let emit_id = id.clone(); let title = original_name.clone(); let emit_locale = locale.clone(); let progress_counters = counters.clone();
                let last = Arc::new(Mutex::new(Instant::now() - std::time::Duration::from_secs(1)));
                let progress: Arc<dyn Fn(u64, u64) + Send + Sync> = Arc::new(move |bytes, total| {
                    if let Ok(mut value) = progress_counters.lock() { *value = (bytes, total); }
                    let Ok(mut previous) = last.lock() else { return; }; if bytes != total && previous.elapsed() < std::time::Duration::from_millis(100) { return; } *previous = Instant::now();
                    export_progress(&emit_app, &emit_id, &title, "mod", bytes, total, false, &emit_locale);
                });
                // 不能 select/drop 这个 future：其内部阻塞写开始后必须等 File 真正关闭。
                let bytes = crate::catalog::write_export_download(bound, file, cancel.clone(), progress).await?;
                {
                    let mut slot = state.exports.lock().map_err(|_| denied(&locale))?;
                    cancel.check()?; slot.lifecycle.commit(&id, epoch).map_err(|error| export_error(&locale, error))?;
                }
                Ok(bytes)
            }.await;
            let mut outcome_unconfirmed = false;
            let result = match downloading {
                Ok(bytes) => {
                    export_progress(&app, &id, &original_name, "commit", bytes, bytes, false, &locale);
                    // 提交以后不再观察 download:cancel；原生结果不等价于提供程序原子事务/持久化保证。
                    match commit_save(save.take().unwrap()).await {
                        Ok(outcome) if outcome.size == bytes && !outcome.cleanup_incomplete => Ok(json!(id)),
                        Ok(_) => { outcome_unconfirmed = true; Err(message(&locale, "文档已写入，但大小或清理状态未能完整确认；请先检查目标文档，不要直接重试", "文件已寫入，但大小或清理狀態未能完整確認；請先檢查目標文件，不要直接重試", "The document was written, but its size or cleanup could not be fully confirmed. Check the destination before retrying")) },
                        Err(error) => { outcome_unconfirmed = error == cleanup_error(&locale); Err(error) },
                    }
                }
                Err(error) => Err(error),
            };
            let cleanup_failed = if let Some(save) = save { cancel_save(save).await.is_err() } else { false };
            let mut result = if cleanup_failed { Err(cleanup_error(&locale)) } else { result };
            finish_export(&state, &id, cleanup_failed || outcome_unconfirmed).await;
            if state.exports.lock().map(|slot| slot.cleanup.is_unconfirmed()).unwrap_or(true) && result.is_ok() { result = Err(cleanup_error(&locale)); }
            let (bytes, total) = counters.lock().map(|value| *value).unwrap_or((0, 0));
            export_progress(&app, &id, &original_name, "done", bytes, total, result.is_ok(), &locale);
            result
        });
        let result = worker.await.map_err(|_| message(&join_locale, "导出后台任务异常，未确认保存结果；请检查目标文档", "匯出背景工作異常，未確認儲存結果；請檢查目標文件", "Export worker failed; the save result is unconfirmed. Check the destination"))?;
        ipc_guard.disarm(); result
    }

    pub struct PreparedSave<R: Runtime> { state: MobileFiles<R>, session: Session, request: String, ticket: String, path: PathBuf, initial: Stamp, locale: String, guard: CancelGuard<R> }
    impl<R: Runtime> PreparedSave<R> {
        pub fn staging_path(&self) -> &Path { &self.path }
        /// 原位打开 begin_save 创建的零文件；绝不 create/truncate/rename，File 只交受信任下载 worker。
        pub async fn open_staging(&self) -> Result<File, String> {
            check_session(&self.state, &self.session, &self.locale)?;
            let root = self.session.root.clone(); let request = self.request.clone(); let path = self.path.clone(); let initial = self.initial.clone(); let locale = self.locale.clone();
            let file = background(&self.locale, move || {
                let (_, before) = snapshot(&root, &request, &path, &locale)?;
                if before != initial || before.size != 0 || OPEN_NOFOLLOW == 0 { return Err(denied(&locale)); }
                let file = OpenOptions::new().write(true).custom_flags(OPEN_NOFOLLOW).open(&path).map_err(|_| denied(&locale))?;
                let metadata = file.metadata().map_err(|_| denied(&locale))?;
                if metadata.mode() & 0o7777 != 0o600 || stamp(metadata, fs::metadata(&root).map_err(|_| denied(&locale))?.uid(), &locale)? != initial { return Err(denied(&locale)); }
                let (_, after) = snapshot(&root, &request, &path, &locale)?;
                if after != initial { return Err(denied(&locale)); }
                Ok(file)
            }).await?;
            check_session(&self.state, &self.session, &self.locale)?;
            Ok(file)
        }
    }
    pub async fn begin_save<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>, default_name: &str) -> Result<Option<PreparedSave<R>>, String> {
        begin_save_impl(app, window, default_name, None).await
    }
    async fn begin_save_impl<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>, default_name: &str, host_id: Option<&str>) -> Result<Option<PreparedSave<R>>, String> {
        let locale = language(app);
        if window.label() != "main" || default_name.is_empty() || default_name.len() > 512 || default_name.chars().any(|character| character.is_control() || "/\\".contains(character)) { return Err(denied(&locale)); }
        let state = state(app, &locale)?; let session = ensure_session(&state, &locale).await?; let request = Uuid::new_v4().to_string();
        if let Some(id) = host_id {
            let mut slot = state.exports.lock().map_err(|_| denied(&locale))?;
            if slot.lifecycle.id() != Some(id) || slot.lifecycle.phase() != Some(Phase::Picking) { return Err(denied(&locale)); }
            slot.cancel.as_ref().ok_or_else(|| denied(&locale))?.check()?;
        }
        let mut guard = CancelGuard { state: state.clone(), session: session.id.clone(), request: Some(request.clone()), armed: true };
        let host_cancel = if host_id.is_some() { state.exports.lock().map_err(|_| denied(&locale))?.cancel.clone() } else { None };
        let create = async {
            let request = state.handle.run_mobile_plugin_async::<NativeSave>("createDocument", json!({"session":session.id,"request":request,"name":default_name,"language":locale}));
            if let Some(cancel) = host_cancel { tokio::select! { biased; _ = cancel.cancelled() => Err(denied(&locale)), result = request => native_save_result(&state, result, &locale) } }
            else { native_save_result(&state, request.await, &locale) }
        };
        let result: NativeSave = match create.await {
            Ok(result) => result,
            Err(error) => { guard.cancel(&locale).await?; return Err(error); }
        };
        state.exports.lock().map_err(|_| cleanup_error(&locale))?.cleanup.record_cleanup(result.cleanup_incomplete);
        if result.cancelled { guard.cancel(&locale).await?; if result.cleanup_incomplete { return Err(cleanup_error(&locale)); } return Ok(None); }
        let ticket = result.ticket; let raw_path = result.path; let raw_name = result.name;
        let validated: Result<(PathBuf, Stamp), String> = async {
            if !uuid(&ticket) { return Err(denied(&locale)); }
            let root = session.root.clone(); let validate_request = request.clone(); let validate_locale = locale.clone(); let path = PathBuf::from(raw_path);
            if path.file_name().and_then(|value| value.to_str()) != Some(raw_name.as_str()) { return Err(denied(&locale)); }
            let (path, initial) = background(&locale, move || snapshot(&root, &validate_request, &path, &validate_locale)).await?;
            if initial.size != 0 { return Err(denied(&locale)); }
            check_session(&state, &session, &locale)?;
            Ok((path, initial))
        }.await;
        let (path, initial) = match validated { Ok(value) => value, Err(error) => { guard.cancel(&locale).await?; return Err(error); } };
        Ok(Some(PreparedSave { state, session, request, ticket, path, initial, locale, guard }))
    }
    pub async fn commit_save<R: Runtime>(mut save: PreparedSave<R>) -> Result<SaveOutcome, String> {
        let committed: Result<(Stamp, NativeCommitted), String> = async {
            check_session(&save.state, &save.session, &save.locale)?;
            let root = save.session.root.clone(); let request = save.request.clone(); let path = save.path.clone(); let locale = save.locale.clone();
            let (_, current) = background(&save.locale, move || snapshot(&root, &request, &path, &locale)).await?;
            if current.device != save.initial.device || current.inode != save.initial.inode { return Err(denied(&save.locale)); }
            let result: NativeCommitted = native_save_result(&save.state, save.state.handle.run_mobile_plugin_async("commitSave", json!({"session":save.session.id,"request":save.request,"ticket":save.ticket,"language":save.locale})).await, &save.locale)?;
            Ok((current, result))
        }.await;
        let (current, result) = match committed { Ok(value) => value, Err(error) => { save.guard.cancel(&save.locale).await?; return Err(error); } };
        save.state.exports.lock().map_err(|_| cleanup_error(&save.locale))?.cleanup.record_cleanup(result.cleanup_incomplete || result.saved && result.size != current.size);
        if result.cancelled || !result.saved { save.guard.cancel(&save.locale).await?; return Err(denied(&save.locale)); }
        save.guard.disarm();
        if result.size != current.size { return Err(message(&save.locale, "提供程序已完成写入，但返回的文件大小不一致，请检查目标文档", "提供者已完成寫入，但回傳的檔案大小不一致，請檢查目標文件", "The provider completed writing but returned a different file size; check the destination document")); }
        Ok(SaveOutcome { size: result.size, cleanup_incomplete: result.cleanup_incomplete })
    }
    pub async fn cancel_save<R: Runtime>(mut save: PreparedSave<R>) -> Result<(), String> { save.guard.cancel(&save.locale).await }
    pub async fn cancel_pending<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
        let Some(state) = app.try_state::<MobileFiles<R>>() else { return Ok(()); };
        let state = state.inner().clone();
        let locale = state.exports.lock().map(|slot| cancellation_locale(Some(&slot.locale)).to_owned()).map_err(|_| denied("zh-CN"))?;
        invalidate_state(state.clone(), false);
        loop {
            let notified = state.export_done.notified(); tokio::pin!(notified); notified.as_mut().enable();
            let idle = state.exports.lock().map_err(|_| denied(&locale))?.lifecycle.phase().is_none();
            if idle { return if state.exports.lock().map_err(|_| denied(&locale))?.cleanup.is_unconfirmed() { Err(cleanup_error(&locale)) } else { Ok(()) }; }
            notified.await;
        }
    }
}

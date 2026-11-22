//! 开发工具的原生操作在 UI 队列执行；授权快照不与磁盘发布锁共用。
use super::{valid_token, Epoch};
#[cfg(test)]
use crate::storage::DevModeSnapshot;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU8, Ordering}};
use tauri::{AppHandle, Manager, WebviewWindow};

#[cfg(windows)]
#[path = "devmode_inspector.rs"]
mod inspector;
#[cfg(windows)]
#[path = "devmode_inspector_host.rs"]
mod inspector_host;

type Result<T> = std::result::Result<T, String>;
const UNAVAILABLE: &str = "开发工具原生状态不可用 / 開發工具原生狀態無法使用 / Native developer-tools state is unavailable";
const DENIED: &str = "开发模式未授权、已关闭或已过期 / 開發模式未授權、已關閉或已過期 / Development mode is unauthorized, disabled or expired";
const DESTROY_RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(500);
const MAX_DESTROY_ATTEMPTS: u8 = 8;

#[derive(Clone, PartialEq, Eq)]
struct Grant {
    epoch: u64,
    expires: u64,
    token_hash: [u8; 32],
}
#[derive(Default)]
struct AuthorityState { serial: u64, grant: Option<Grant> }
#[derive(Default)]
pub(super) struct Authority(Mutex<AuthorityState>);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Ticket { serial: u64, expires: u64 }
impl Authority {
    /// 调用者已持有授权纪元锁；这里只发布小投影，UI 从不反向等待纪元或存储锁。
    pub(super) fn publish(&self, epoch: &Epoch, now: u64) {
        let grant = if !epoch.closed {
            epoch.trusted.as_ref().zip(epoch.cached.as_ref()).filter(|(trusted, cached)| {
                trusted == cached && cached.enabled && cached.expires_at > now
                    && matches!(cached.mode.as_str(), "normal" | "minimal") && valid_token(&cached.token)
            }).map(|(_, cached)| Grant { epoch: epoch.generation, expires: cached.expires_at, token_hash: Sha256::digest(cached.token.as_bytes()).into() })
        } else { None };
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if state.grant != grant {
            state.serial = state.serial.checked_add(1).unwrap_or(u64::MAX);
            state.grant = if state.serial == u64::MAX { None } else { grant };
        }
    }
    fn ticket(&self, now: u64) -> Result<Ticket> {
        let state = self.0.lock().map_err(|_| UNAVAILABLE)?;
        let grant = state.grant.as_ref().filter(|grant| grant.expires > now).ok_or(DENIED)?;
        Ok(Ticket { serial: state.serial, expires: grant.expires })
    }
    fn accepts(&self, ticket: Ticket, now: u64) -> bool { self.ticket(now).ok() == Some(ticket) }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Command { OpenTools, CloseTools, OpenInspector, CloseInspector }
impl Command {
    fn parse(channel: &str, args: &[Value]) -> Result<Option<Self>> {
        let command = match channel {
            "devmode:openTools" => Self::OpenTools, "devmode:closeTools" => Self::CloseTools,
            "devmode:openDevTools" => Self::OpenInspector, "devmode:closeDevTools" => Self::CloseInspector,
            _ => return Ok(None),
        };
        if !args.is_empty() { return Err("开发工具通道不接受参数 / 開發工具通道不接受參數 / Developer-tools channels accept no arguments".into()); }
        Ok(Some(command))
    }
}

// bit 0 表示一次保存已获准进入发布；bit 1 表示窗口已关闭/失效。UI 只置位，不等待磁盘。
#[derive(Default)]
struct WindowLife(AtomicU8, AtomicBool);
impl WindowLife {
    fn active(&self) -> bool { self.0.load(Ordering::Acquire) & 2 == 0 }
    fn invalidate(&self) { self.0.fetch_or(2, Ordering::AcqRel); }
    fn begin(&self) -> Result<Publication<'_>> {
        self.0.compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire).map_err(|_| DENIED)?;
        Ok(Publication(self))
    }
}
struct Publication<'a>(&'a WindowLife);
impl Drop for Publication<'_> {
    fn drop(&mut self) { self.0.0.fetch_and(!1, Ordering::AcqRel); }
}
#[derive(Clone)]
struct WindowBinding { stamp: String, ticket: Ticket, live: Arc<WindowLife> }

// W 在生产中是精确 WebviewWindow；测试仅替换句柄载荷，仍调用同一组状态转移。
struct WindowOwner<W> {
    live: Arc<WindowLife>, ticket: Ticket, stamp: Option<String>, window: Option<W>,
    request: Option<crate::lifecycle::Request>, destroy_pending: bool,
    destroy_attempts: u8, last_destroy: Option<std::time::Instant>,
}
impl<W> WindowOwner<W> {
    fn binding(&self) -> Option<WindowBinding> {
        Some(WindowBinding { stamp: self.stamp.clone()?, ticket: self.ticket, live: self.live.clone() })
    }
}
enum ToolWindowSlot<W> {
    Absent, Creating(WindowOwner<W>), Open(WindowOwner<W>), Closing(WindowOwner<W>), Uncertain(WindowOwner<W>),
}
impl<W> ToolWindowSlot<W> {
    fn owner(&self) -> Option<&WindowOwner<W>> {
        match self { Self::Absent => None, Self::Creating(owner) | Self::Open(owner) | Self::Closing(owner) | Self::Uncertain(owner) => Some(owner) }
    }
    fn owner_mut(&mut self) -> Option<&mut WindowOwner<W>> {
        match self { Self::Absent => None, Self::Creating(owner) | Self::Open(owner) | Self::Closing(owner) | Self::Uncertain(owner) => Some(owner) }
    }
}
struct WindowTracker<W = WebviewWindow> {
    slot: Mutex<ToolWindowSlot<W>>,
    changed: tokio::sync::watch::Sender<()>,
}
struct CloseAction<W = WebviewWindow> { live: Arc<WindowLife>, window: W }
enum WindowSnapshot<W = WebviewWindow> {
    Absent, Creating, Open(WindowBinding, W), Closing, Uncertain,
}
impl<W> Default for WindowTracker<W> {
    fn default() -> Self {
        let (changed, _) = tokio::sync::watch::channel(());
        Self { slot: Mutex::new(ToolWindowSlot::Absent), changed }
    }
}
impl<W: Clone> WindowTracker<W> {
    fn snapshot(&self) -> Result<WindowSnapshot<W>> {
        let slot = self.slot.lock().map_err(|_| UNAVAILABLE)?;
        Ok(match &*slot {
            ToolWindowSlot::Absent => WindowSnapshot::Absent,
            ToolWindowSlot::Creating(_) => WindowSnapshot::Creating,
            ToolWindowSlot::Open(owner) => match (owner.binding(), owner.window.clone()) {
                (Some(binding), Some(window)) if owner.live.active() => WindowSnapshot::Open(binding, window),
                _ => WindowSnapshot::Uncertain,
            },
            ToolWindowSlot::Closing(_) => WindowSnapshot::Closing,
            ToolWindowSlot::Uncertain(_) => WindowSnapshot::Uncertain,
        })
    }
    fn begin_create(&self, ticket: Ticket, request: &mut Option<crate::lifecycle::Request>) -> Result<Arc<WindowLife>> {
        let mut slot = self.slot.lock().map_err(|_| UNAVAILABLE)?;
        if !matches!(*slot, ToolWindowSlot::Absent) { return Err(UNAVAILABLE.into()); }
        let request = request.take().ok_or(UNAVAILABLE)?;
        let live = Arc::new(WindowLife::default());
        *slot = ToolWindowSlot::Creating(WindowOwner {
            live: live.clone(), ticket, stamp: None, window: None, request: Some(request),
            destroy_pending: false, destroy_attempts: 0, last_destroy: None,
        });
        drop(slot);
        self.changed.send_replace(());
        Ok(live)
    }
    fn set_window(&self, live: &Arc<WindowLife>, window: W) -> Result<()> {
        // 中毒时仍保存已创建的精确句柄；授权/重开继续拒绝，收尾事件可以释放该 owner。
        let poisoned = self.slot.is_poisoned();
        let mut slot = self.slot.lock().unwrap_or_else(|error| error.into_inner());
        let owner = slot.owner_mut().filter(|owner| Arc::ptr_eq(&owner.live, live)).ok_or(UNAVAILABLE)?;
        if owner.window.is_some() { return Err(UNAVAILABLE.into()); }
        owner.window = Some(window);
        drop(slot);
        self.changed.send_replace(());
        if poisoned { Err(UNAVAILABLE.into()) } else { Ok(()) }
    }
    fn promote(&self, live: &Arc<WindowLife>, stamp: String) -> Result<()> {
        let mut slot = self.slot.lock().map_err(|_| UNAVAILABLE)?;
        if !matches!(&*slot, ToolWindowSlot::Creating(owner) if Arc::ptr_eq(&owner.live, live) && owner.live.active() && owner.window.is_some()) {
            return Err(UNAVAILABLE.into());
        }
        if let ToolWindowSlot::Creating(mut owner) = std::mem::replace(&mut *slot, ToolWindowSlot::Absent) {
            owner.stamp = Some(stamp);
            *slot = ToolWindowSlot::Open(owner);
        }
        drop(slot);
        self.changed.send_replace(());
        Ok(())
    }
    fn begin_close(&self, expected: Option<&Arc<WindowLife>>, now: std::time::Instant) -> Result<Option<CloseAction<W>>> {
        // 中毒后拒绝新授权，但仍可对已登记的精确窗口执行收尾。
        let mut slot = self.slot.lock().unwrap_or_else(|error| error.into_inner());
        let Some(owner) = slot.owner() else { return Ok(None); };
        if expected.is_some_and(|expected| !Arc::ptr_eq(expected, &owner.live)) { return Err(UNAVAILABLE.into()); }
        let current = std::mem::replace(&mut *slot, ToolWindowSlot::Absent);
        let mut owner = match current {
            ToolWindowSlot::Creating(owner) | ToolWindowSlot::Open(owner) | ToolWindowSlot::Closing(owner) | ToolWindowSlot::Uncertain(owner) => owner,
            ToolWindowSlot::Absent => unreachable!(),
        };
        // 失效先于原生请求；销毁未回执时按固定间隔重试，耗尽后保留未知 owner。
        owner.live.invalidate();
        let elapsed = owner.last_destroy.map(|last| now.saturating_duration_since(last) >= DESTROY_RETRY_INTERVAL).unwrap_or(true);
        let retryable = owner.destroy_attempts < MAX_DESTROY_ATTEMPTS;
        let action = if (!owner.destroy_pending || elapsed) && elapsed && retryable {
            owner.window.clone().map(|window| {
                owner.destroy_pending = true;
                owner.destroy_attempts = owner.destroy_attempts.saturating_add(1);
                owner.last_destroy = Some(now);
                CloseAction { live: owner.live.clone(), window }
            })
        } else { None };
        let exhausted = owner.destroy_attempts >= MAX_DESTROY_ATTEMPTS && owner.destroy_pending;
        *slot = if owner.window.is_some() && !exhausted { ToolWindowSlot::Closing(owner) } else { ToolWindowSlot::Uncertain(owner) };
        drop(slot);
        self.changed.send_replace(());
        Ok(action)
    }
    fn close_result(&self, live: &Arc<WindowLife>, enqueued: bool) {
        let mut slot = self.slot.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(owner) = slot.owner_mut().filter(|owner| Arc::ptr_eq(&owner.live, live)) {
            owner.destroy_pending = enqueued;
        }
        drop(slot);
        self.changed.send_replace(());
    }
    fn destroyed(&self, live: &Arc<WindowLife>) {
        // 精确回执与 manager 双表释放均由 UI 外层确认后才调用。
        live.invalidate();
        if !live.1.load(Ordering::Acquire) { return; }
        let mut slot = self.slot.lock().unwrap_or_else(|error| error.into_inner());
        let owner = if slot.owner().is_some_and(|owner| Arc::ptr_eq(&owner.live, live)) {
            match std::mem::replace(&mut *slot, ToolWindowSlot::Absent) {
                ToolWindowSlot::Creating(owner) | ToolWindowSlot::Open(owner) | ToolWindowSlot::Closing(owner) | ToolWindowSlot::Uncertain(owner) => Some(owner),
                ToolWindowSlot::Absent => None,
            }
        } else { None };
        drop(slot);
        // 不持状态锁析构原生句柄、释放 Gate 或通知等待者。
        if let Some(mut owner) = owner { if let Some(request) = owner.request.take() { request.finish(); } }
        self.changed.send_replace(());
    }
    fn ready(&self) -> Result<()> {
        if matches!(self.snapshot()?, WindowSnapshot::Absent) { Ok(()) } else { Err(UNAVAILABLE.into()) }
    }
    fn closing_identity(&self) -> Option<Arc<WindowLife>> {
        self.slot.lock().unwrap_or_else(|error| error.into_inner()).owner()
            .filter(|owner| owner.live.1.load(Ordering::Acquire)).map(|owner| owner.live.clone())
    }
    fn creation_failed(&self, live: &Arc<WindowLife>, clean: bool) {
        if clean {
            live.1.store(true, Ordering::Release);
            self.destroyed(live);
        } else {
            let _ = self.begin_close(Some(live), std::time::Instant::now());
        }
    }
    async fn wait_absent(&self) -> Result<()> {
        // 先订阅再读状态；即使 Destroyed 发生在复核与 await 之间也不会漏唤醒。
        let mut changed = self.changed.subscribe();
        loop {
            if matches!(self.snapshot()?, WindowSnapshot::Absent) { return Ok(()); }
            changed.changed().await.map_err(|_| UNAVAILABLE.to_string())?;
        }
    }
}

#[derive(Clone)]
pub(super) struct Origin { authority: Arc<Authority>, ticket: Ticket, live: Arc<WindowLife> }
impl Origin {
    pub(super) fn check(&self, now: u64) -> Result<()> {
        if !self.live.active() || !self.authority.accepts(self.ticket, now) { return Err(DENIED.into()); }
        Ok(())
    }
    pub(super) fn commit<T>(&self, now: u64, publish: impl FnOnce() -> Result<T>) -> Result<T> {
        let _publication = self.live.begin()?;
        if !self.authority.accepts(self.ticket, now) { return Err(DENIED.into()); }
        publish()
    }
}
#[derive(Default)]
pub(super) struct Windows {
    tracker: Arc<WindowTracker>,
    serial: Arc<tokio::sync::Mutex<()>>,
    #[cfg(windows)] inspector: Mutex<Option<InspectorRecord>>,
}
/// 多个关闭调用可等待同一原生收尾；始终保留一个登记，确认 gone 后才释放。
#[derive(Default)]
struct CleanupOwner(Option<crate::lifecycle::Request>);
impl CleanupOwner {
    fn retain(&mut self, request: crate::lifecycle::Request) {
        if self.0.is_some() { request.finish(); } else { self.0 = Some(request); }
    }
    fn finish(&mut self) { if let Some(request) = self.0.take() { request.finish(); } }
}
#[cfg(windows)]
#[derive(Default)]
struct CloseRetry {
    attempts: u8,
    last_attempt: Option<std::time::Instant>,
}
#[cfg(windows)]
struct InspectorRecord {
    main: String, ticket: Ticket, snapshot: inspector::Snapshot, origin: String,
    owned: Option<inspector::OwnedInspector>, close_retry: CloseRetry, close_required: bool, uncertain: bool,
    pending: CleanupOwner,
    opened: std::time::Instant,
}
fn stamp(window: &WebviewWindow) -> Result<String> {
    use raw_window_handle::HasWindowHandle;
    window.window_handle().map(|handle| format!("{:?}", handle.as_raw())).map_err(|_| UNAVAILABLE.into())
}
fn authority(app: &AppHandle) -> Result<Arc<Authority>> { Ok(app.try_state::<super::State>().ok_or(UNAVAILABLE)?.tools.clone()) }
fn current_main(app: &AppHandle, expected: &str) -> Result<WebviewWindow> {
    let window = app.get_webview_window("main").ok_or(UNAVAILABLE)?;
    if stamp(&window)? != expected { return Err(UNAVAILABLE.into()); }
    crate::trusted_main(&window)?;
    Ok(window)
}
fn check(app: &AppHandle, ticket: Ticket) -> Result<()> {
    if !authority(app)?.accepts(ticket, super::now_ms()) { return Err(DENIED.into()); }
    Ok(())
}
async fn on_ui<T: Send + 'static>(app: &AppHandle, action: impl FnOnce(&AppHandle) -> Result<T> + Send + 'static) -> Result<T> {
    let handle = app.clone();
    let (done, result) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || { let _ = done.send(action(&handle)); }).map_err(|_| UNAVAILABLE)?;
    result.await.map_err(|_| UNAVAILABLE.to_string())?
}

fn dispatch_destroy(tracker: &Arc<WindowTracker>, action: Option<CloseAction>) -> Result<()> {
    let Some(action) = action else { return Ok(()); };
    let result = action.window.destroy();
    tracker.close_result(&action.live, result.is_ok());
    result.map_err(|_| UNAVAILABLE.into())
}
fn confirm_destroyed(app: &AppHandle) {
    let tracker = app.state::<Windows>().tracker.clone();
    if app.get_window("devtools").is_none() && app.get_webview("devtools").is_none() {
        if let Some(live) = tracker.closing_identity() { tracker.destroyed(&live); }
    }
}
fn close_window(app: &AppHandle, only: Option<&WindowBinding>) -> Result<()> {
    confirm_destroyed(app);
    let tracker = app.state::<Windows>().tracker.clone();
    let action = tracker.begin_close(only.map(|binding| &binding.live), std::time::Instant::now())?;
    dispatch_destroy(&tracker, action)
}
fn window_failure(stage: &str) -> String { format!("{UNAVAILABLE} [{stage}]") }
fn rollback_window(app: &AppHandle, live: &Arc<WindowLife>, error: String) -> Result<()> {
    let tracker = app.state::<Windows>().tracker.clone();
    let action = tracker.begin_close(Some(live), std::time::Instant::now())?;
    if let Err(cleanup_error) = dispatch_destroy(&tracker, action) {
        let _ = crate::debug::append(app, "error", "devtools", &window_failure("tools-cleanup"));
        return Err(cleanup_error);
    }
    Err(error)
}
fn open_window(app: &AppHandle, ticket: Ticket, expected: &str, request: Arc<Mutex<Option<crate::lifecycle::Request>>>) -> Result<()> {
    let main = current_main(app, expected).map_err(|_| window_failure("tools-current-main"))?;
    check(app, ticket)?;
    let tracker = app.state::<Windows>().tracker.clone();
    match tracker.snapshot()? {
        WindowSnapshot::Open(binding, window) if binding.live.active() && binding.ticket == ticket => {
            if stamp(&window).ok().as_ref() != Some(&binding.stamp) {
                return rollback_window(app, &binding.live, window_failure("tools-existing-handle"));
            }
            let existing = (|| {
                crate::debug::devtools_window(&window)?;
                if window.is_minimized().map_err(|_| UNAVAILABLE)? { window.unminimize().map_err(|_| UNAVAILABLE)?; }
                check(app, ticket)?;
                window.show().map_err(|_| window_failure("tools-show"))?;
                check(app, ticket)?;
                window.set_focus().map_err(|_| window_failure("tools-focus"))?;
                check(app, ticket)?;
                Ok(())
            })();
            return match existing {
                Ok(()) => Ok(()),
                Err(error) => rollback_window(app, &binding.live, error),
            };
        }
        WindowSnapshot::Open(binding, _) => {
            close_window(app, Some(&binding))?;
            return Err(window_failure("tools-closing"));
        }
        WindowSnapshot::Creating | WindowSnapshot::Closing | WindowSnapshot::Uncertain => {
            return Err(window_failure("tools-closing"));
        }
        WindowSnapshot::Absent => {}
    }
    // 未归属的同名窗口不被领养或销毁；等待显式调查，避免误触其它窗口。
    if app.get_webview_window("devtools").is_some() { return Err(window_failure("tools-untracked-window")); }
    let language = app.try_state::<crate::storage::Storage>().map(|storage| storage.shell_preferences().language).unwrap_or_else(|| "zh-CN".into());
    let language = if matches!(language.as_str(), "zh-CN" | "zh-TW" | "en") { language } else { "zh-CN".into() };
    let title = match language.as_str() { "zh-TW" => "開發者工具 - 開發模式", "en" => "Developer Tools - Development Mode", _ => "开发者工具 - 开发模式" };
    let builder = tauri::WebviewWindowBuilder::new(app, "devtools", tauri::WebviewUrl::App("index.html?window=devtools".into()))
        .title(title).inner_size(900.0, 640.0).min_inner_size(560.0, 400.0)
        .background_color(tauri::webview::Color(11, 13, 20, 255)).visible(false).devtools(false)
        .initialization_script(format!("window.__HC_DEVTOOLS_LOCALE__ = {};", serde_json::to_string(&language).map_err(|_| UNAVAILABLE)?))
        .on_navigation(crate::debug::devtools_url_allowed)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .parent(&main).map_err(|_| window_failure("tools-parent"))?;
    let live = {
        let mut request = request.lock().map_err(|_| window_failure("tools-request-owner"))?;
        tracker.begin_create(ticket, &mut request)?
    };
    let window = match builder.build() {
        Ok(window) => window,
        Err(error) => {
            let detail = error.to_string().chars().take(512).collect::<String>();
            let _ = crate::debug::append(app, "error", "devtools", &format!("工具窗口构建失败：{detail}"));
            // builder 失败不能证明没有未知 native 副作用；保留 owner/登记，禁止自动重建。
            tracker.creation_failed(&live, false);
            return Err(window_failure("tools-build"));
        }
    };
    let event_tracker = tracker.clone();
    let event_live = live.clone();
    let event_app = app.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let action = event_tracker.begin_close(Some(&event_live), std::time::Instant::now()).ok().flatten();
            let _ = dispatch_destroy(&event_tracker, action);
        }
        tauri::WindowEvent::Destroyed => {
            event_live.invalidate();
            event_live.1.store(true, Ordering::Release);
            let handle = event_app.clone();
            // listener 返回后再排独立 UI 回合核验双表，不能在事件栈内提前释放标签。
            tauri::async_runtime::spawn(async move { let _ = on_ui(&handle, |app| { confirm_destroyed(app); Ok(()) }).await; });
        }
        _ => {}
    });
    if let Err(error) = tracker.set_window(&live, window.clone()) {
        return rollback_window(app, &live, error);
    }
    let stamp = match stamp(&window) {
        Ok(stamp) => stamp,
        Err(_) => return rollback_window(app, &live, window_failure("tools-native-handle")),
    };
    if let Err(error) = tracker.promote(&live, stamp) {
        return rollback_window(app, &live, error);
    }
    if let Err(error) = check(app, ticket) { return rollback_window(app, &live, error); }
    if let Err(_) = window.show() { return rollback_window(app, &live, window_failure("tools-show")); }
    if let Err(error) = check(app, ticket) { return rollback_window(app, &live, error); }
    if let Err(_) = window.set_focus() { return rollback_window(app, &live, window_failure("tools-focus")); }
    if let Err(error) = check(app, ticket) { return rollback_window(app, &live, error); }
    Ok(())
}

pub(super) fn origin(app: &AppHandle, window: &WebviewWindow) -> Result<Origin> {
    crate::debug::devtools_window(window)?;
    let WindowSnapshot::Open(binding, _) = app.try_state::<Windows>().ok_or(UNAVAILABLE)?.tracker.snapshot()? else { return Err(DENIED.into()); };
    if stamp(window)? != binding.stamp { return Err(DENIED.into()); }
    let origin = Origin { authority: authority(app)?, ticket: binding.ticket, live: binding.live };
    origin.check(super::now_ms())?;
    Ok(origin)
}
pub(super) fn authorize(app: &AppHandle, window: &WebviewWindow) -> Result<()> { origin(app, window).map(|_| ()) }
fn reclaim_window(app: &AppHandle) -> Result<()> {
    confirm_destroyed(app);
    match app.state::<Windows>().tracker.snapshot()? {
        WindowSnapshot::Open(binding, _) => {
            // 回收按当前精确票据判断；旧通知不能清理随后获准的新一代。
            if !binding.live.active() || check(app, binding.ticket).is_err() { close_window(app, Some(&binding))?; }
        }
        WindowSnapshot::Closing | WindowSnapshot::Uncertain => close_window(app, None)?,
        WindowSnapshot::Absent | WindowSnapshot::Creating => {}
    }
    Ok(())
}
pub(super) fn close_all(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || { let _ = reclaim_window(&handle); });
}
pub(super) fn log_target(app: &AppHandle) -> Option<WebviewWindow> {
    let window = app.get_webview_window("devtools")?;
    authorize(app, &window).ok()?;
    Some(window)
}
pub(super) fn relaunch_ready(app: &AppHandle) -> Result<()> {
    let state = app.try_state::<Windows>().ok_or(UNAVAILABLE)?;
    let _serial = state.serial.try_lock().map_err(|_| UNAVAILABLE)?;
    state.tracker.ready()?;
    #[cfg(windows)]
    if inspector_host::unconfirmed(app) { return Err(UNAVAILABLE.into()); }
    Ok(())
}
pub(super) async fn shutdown(app: &AppHandle) -> Result<()> {
    let serial = app.state::<Windows>().serial.clone();
    let cleanup = async {
        let _serial = serial.lock().await;
        on_ui(app, |app| close_window(app, None)).await?;
        app.state::<Windows>().tracker.wait_absent().await?;
        #[cfg(windows)]
        { inspector_host::close(app).await?; }
        #[cfg(not(windows))]
        on_ui(app, |app| {
            if let Some(main) = app.get_webview_window("main") {
                main.close_devtools();
                if main.is_devtools_open() { return Err(UNAVAILABLE.into()); }
            }
            Ok(())
        }).await?;
        Ok(())
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), cleanup).await.map_err(|_| UNAVAILABLE.to_owned())?
}
pub(super) fn init(app: &AppHandle) {
    app.manage(Windows::default());
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let state = handle.state::<super::State>();
            tokio::select! { _ = state.shutdown.wait() => break, _ = tokio::time::sleep(std::time::Duration::from_millis(250)) => {} }
            let _ = on_ui(&handle, reclaim_window).await;
            #[cfg(windows)]
            { let _ = inspector_host::maintain(&handle).await; }
        }
    });
}
async fn tools_on_ui(app: &AppHandle, command: Command, ticket: Option<Ticket>, expected: String) -> Result<Value> {
    let request = Arc::new(Mutex::new(Some(app.state::<crate::lifecycle::Gate>().enter()?)));
    let callback_request = request.clone();
    let result = on_ui(app, move |app| {
        let main = current_main(app, &expected).map_err(|error| {
            if error == UNAVAILABLE { window_failure("tools-ui-current-main") } else { error }
        })?;
        let result = (|| match command {
            Command::OpenTools => open_window(app, ticket.ok_or(DENIED)?, &expected, callback_request).map(|()| Value::Null),
            Command::CloseTools => close_window(app, None).map(|()| Value::Null),
            #[cfg(not(windows))]
            Command::OpenInspector => {
                check(app, ticket.ok_or(DENIED)?)?;
                main.open_devtools();
                check(app, ticket.ok_or(DENIED)?)?;
                if main.is_devtools_open() { Ok(Value::Bool(true)) } else { Err(UNAVAILABLE.into()) }
            }
            #[cfg(not(windows))]
            Command::CloseInspector => { main.close_devtools(); if main.is_devtools_open() { Err(UNAVAILABLE.into()) } else { Ok(Value::Null) } },
            #[cfg(windows)]
            _ => Err(UNAVAILABLE.into()),
        })();
        let _ = main;
        result
    }).await;
    // 新窗 owner 已接手的登记等 Destroyed 收尾；复用/拒绝/准备失败则结束这一短请求。
    if let Some(request) = request.lock().unwrap_or_else(|error| error.into_inner()).take() { request.finish(); }
    let value = result?;
    if command == Command::CloseTools {
        let tracker = app.state::<Windows>().tracker.clone();
        tokio::time::timeout(std::time::Duration::from_secs(4), tracker.wait_absent()).await.map_err(|_| UNAVAILABLE.to_owned())??;
    }
    Ok(value)
}
pub(super) async fn call(app: &AppHandle, window: &WebviewWindow, channel: &str, args: &[Value]) -> Result<Option<Value>> {
    let Some(command) = Command::parse(channel, args)? else { return Ok(None); };
    crate::trusted_main(window)?;
    let expected = stamp(window).map_err(|_| window_failure("tools-request-handle"))?;
    let ticket = authority(app).map_err(|_| window_failure("tools-authority-state"))?.ticket(super::now_ms());
    if command == Command::OpenInspector && ticket.is_err() { return Ok(Some(Value::Bool(false))); }
    let ticket = if command == Command::OpenTools { Some(ticket?) } else { ticket.ok() };
    let request = app.state::<crate::lifecycle::Gate>().enter()?;
    let handle = app.clone();
    let serial = app.state::<Windows>().serial.clone();
    // IPC 等待方退出不撤销已排队的原生工作；真实任务一直保有生命周期登记。
    tauri::async_runtime::spawn(async move {
        let _serial = serial.lock().await;
        #[cfg(windows)]
        let result = async { match command {
            Command::OpenInspector => inspector_host::open(&handle, ticket.ok_or(DENIED)?, expected).await,
            Command::CloseInspector => {
                let verify = expected.clone();
                on_ui(&handle, move |app| current_main(app, &verify).map(|_| ())).await?;
                inspector_host::close(&handle).await
            }
            _ => tools_on_ui(&handle, command, ticket, expected).await,
        } }.await;
        #[cfg(not(windows))]
        let result = tools_on_ui(&handle, command, ticket, expected).await;
        #[cfg(windows)]
        {
            if inspector_host::unconfirmed(&handle) {
                let mut request = Some(request);
                let queued = on_ui(&handle, move |app| {
                    let state = app.state::<Windows>();
                    let mut slot = state.inspector.lock().map_err(|_| UNAVAILABLE)?;
                    let record = slot.as_mut().ok_or(UNAVAILABLE)?;
                    record.pending.retain(request.take().ok_or(UNAVAILABLE)?);
                    Ok(())
                }).await;
                if queued.is_err() { /* 未登记收尾的请求析构为 uncertain，阻止重启。 */ }
            } else { request.finish(); }
        }
        #[cfg(not(windows))]
        request.finish();
        result.map(Some)
    }).await.map_err(|_| UNAVAILABLE.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn saved(now: u64) -> DevModeSnapshot { DevModeSnapshot { revision: 1, mode: "normal".into(), token: "a".repeat(64), expires_at: now + 1000, email_masked: "a***@b.example".into(), enabled: true, security_mode: "full".into() } }
    #[test]
    fn tools_authority_requires_verified_enabled_current_grant() {
        let authority = Authority::default(); let now = 100;
        let mut epoch = Epoch { cached: Some(saved(now)), ..Epoch::default() };
        authority.publish(&epoch, now); assert!(authority.ticket(now).is_err());
        epoch.trusted = epoch.cached.clone(); authority.publish(&epoch, now);
        let ticket = authority.ticket(now).unwrap(); assert!(authority.accepts(ticket, now)); assert!(!authority.accepts(ticket, ticket.expires));
        epoch.cached.as_mut().unwrap().enabled = false; epoch.trusted = epoch.cached.clone(); authority.publish(&epoch, now);
        assert!(!authority.accepts(ticket, now));
        epoch.cached.as_mut().unwrap().enabled = true; epoch.trusted = epoch.cached.clone(); epoch.generation += 1; authority.publish(&epoch, now);
        assert!(!authority.accepts(ticket, now)); assert!(authority.ticket(now).is_ok());
        epoch.closed = true; authority.publish(&epoch, now); assert!(authority.ticket(now).is_err());
    }
    #[test]
    fn security_preference_does_not_replace_tools_grant_but_control_epoch_does() {
        let authority = Authority::default(); let now = 100; let value = saved(now);
        let mut epoch = Epoch { trusted: Some(value.clone()), cached: Some(value), ..Epoch::default() };
        authority.publish(&epoch, now); let ticket = authority.ticket(now).unwrap();
        epoch.cached.as_mut().unwrap().revision += 1; epoch.cached.as_mut().unwrap().security_mode = "warn".into(); epoch.trusted = epoch.cached.clone(); authority.publish(&epoch, now);
        assert!(authority.accepts(ticket, now));
        epoch.generation += 1; epoch.trusted = None; authority.publish(&epoch, now); assert!(!authority.accepts(ticket, now));
    }
    #[test]
    fn window_close_and_publication_have_one_nonblocking_order() {
        let authority = Arc::new(Authority::default());
        let value = saved(100);
        let epoch = Epoch { trusted: Some(value.clone()), cached: Some(value), ..Epoch::default() };
        authority.publish(&epoch, 100);
        let ticket = authority.ticket(100).unwrap();
        let live = Arc::new(WindowLife::default());
        let origin = Origin { authority: authority.clone(), ticket, live: live.clone() };
        live.invalidate();
        assert!(origin.commit(100, || -> Result<()> { panic!("关闭先发生不得执行发布") }).is_err());

        let live = Arc::new(WindowLife::default());
        let origin = Origin { authority, ticket, live: live.clone() };
        origin.commit(100, || {
            live.invalidate();
            assert!(!live.active());
            assert!(live.begin().is_err());
            Ok(())
        }).unwrap();
        assert!(origin.commit(100, || Ok(())).is_err());
    }
    #[test]
    fn repeated_cleanup_waiters_keep_one_owner_until_confirmed_gone() {
        let gate = crate::lifecycle::Gate::default();
        let mut owner = CleanupOwner::default();
        for _ in 0..12 { owner.retain(gate.enter().unwrap()); }
        assert!(gate.begin_restart().is_err());
        owner.finish();
        let restart = gate.begin_restart().unwrap();
        drop(restart);
        owner.finish();
        gate.begin_restart().unwrap();
    }
    #[test]
    fn unknown_cleanup_drop_remains_unconfirmed() {
        let gate = crate::lifecycle::Gate::default();
        let mut owner = CleanupOwner::default();
        owner.retain(gate.enter().unwrap());
        drop(owner);
        assert!(gate.begin_restart().is_err());
    }
    fn tracked_window(tracker: &WindowTracker<u64>, gate: &crate::lifecycle::Gate, handle: u64) -> Arc<WindowLife> {
        let mut request = Some(gate.enter().unwrap());
        let live = tracker.begin_create(Ticket { serial: handle, expires: 1000 }, &mut request).unwrap();
        assert!(request.is_none());
        tracker.set_window(&live, handle).unwrap();
        live
    }
    #[tokio::test]
    async fn window_cleanup_waits_for_exact_receipt_and_keeps_the_restart_lease() {
        let gate = crate::lifecycle::Gate::default();
        let tracker = WindowTracker::<u64>::default();
        let live = tracked_window(&tracker, &gate, 1);
        tracker.promote(&live, "native-1".into()).unwrap();
        let action = tracker.begin_close(Some(&live), std::time::Instant::now()).unwrap().unwrap();
        assert_eq!(action.window, 1);
        tracker.close_result(&live, true);
        assert!(!live.active());
        assert!(tracker.ready().is_err());
        assert!(gate.begin_restart().is_err());
        // destroy 入队/重复关闭没有回执时，不能释放 owner 或漏过等待。
        assert!(tracker.begin_close(Some(&live), std::time::Instant::now()).unwrap().is_none());
        assert!(tokio::time::timeout(std::time::Duration::from_millis(10), tracker.wait_absent()).await.is_err());
        tracker.destroyed(&live);
        assert!(tracker.ready().is_err());
        live.1.store(true, Ordering::Release);
        tracker.destroyed(&live);
        tracker.wait_absent().await.unwrap();
        gate.begin_restart().unwrap();
    }
    #[test]
    fn rollback_before_binding_and_stale_receipts_cannot_release_a_new_window() {
        let gate = crate::lifecycle::Gate::default();
        let tracker = WindowTracker::<u64>::default();
        // 模拟 build 已返回、stamp/promote 尚未成功时失败，精确窗口仍由 owner 持有。
        let old = tracked_window(&tracker, &gate, 1);
        assert_eq!(tracker.begin_close(Some(&old), std::time::Instant::now()).unwrap().unwrap().window, 1);
        old.1.store(true, Ordering::Release);
        tracker.destroyed(&old);
        let new = tracked_window(&tracker, &gate, 2);
        tracker.promote(&new, "native-2".into()).unwrap();
        tracker.destroyed(&old);
        assert!(matches!(tracker.snapshot().unwrap(), WindowSnapshot::Open(_, 2)));
        assert!(tracker.begin_close(Some(&old), std::time::Instant::now()).is_err());
        assert!(new.active());
        new.1.store(true, Ordering::Release);
        tracker.destroyed(&new);
        tracker.destroyed(&new);
        gate.begin_restart().unwrap();
    }
    #[test]
    fn failed_destroy_is_rate_limited_and_unknown_builder_never_reopens() {
        let gate = crate::lifecycle::Gate::default();
        let tracker = WindowTracker::<u64>::default();
        let live = tracked_window(&tracker, &gate, 1);
        let now = std::time::Instant::now();
        assert!(tracker.begin_close(Some(&live), now).unwrap().is_some());
        tracker.close_result(&live, false);
        assert!(tracker.begin_close(Some(&live), now + std::time::Duration::from_millis(499)).unwrap().is_none());
        assert!(tracker.begin_close(Some(&live), now + std::time::Duration::from_millis(500)).unwrap().is_some());
        live.1.store(true, Ordering::Release);
        tracker.destroyed(&live);
        let mut request = Some(gate.enter().unwrap());
        let unknown = tracker.begin_create(Ticket { serial: 2, expires: 1000 }, &mut request).unwrap();
        tracker.creation_failed(&unknown, false);
        assert!(matches!(tracker.snapshot().unwrap(), WindowSnapshot::Uncertain));
        assert!(tracker.ready().is_err());
        assert!(gate.begin_restart().is_err());
    }
    #[test]
    fn destroy_retry_cap_keeps_unknown_owner_and_gate_lease() {
        let gate = crate::lifecycle::Gate::default();
        let tracker = WindowTracker::<u64>::default();
        let live = tracked_window(&tracker, &gate, 1);
        let start = std::time::Instant::now();
        for attempt in 0..MAX_DESTROY_ATTEMPTS {
            let now = start + DESTROY_RETRY_INTERVAL * attempt as u32;
            let action = tracker.begin_close(Some(&live), now).unwrap();
            assert!(action.is_some(), "第 {} 次尝试应保留原生关闭请求", attempt + 1);
            tracker.close_result(&live, true);
        }
        let now = start + DESTROY_RETRY_INTERVAL * MAX_DESTROY_ATTEMPTS as u32;
        assert!(tracker.begin_close(Some(&live), now).unwrap().is_none());
        assert!(matches!(tracker.snapshot().unwrap(), WindowSnapshot::Uncertain));
        assert!(tracker.ready().is_err());
        assert!(gate.begin_restart().is_err());
        live.1.store(true, Ordering::Release);
        tracker.destroyed(&live);
        gate.begin_restart().unwrap();
    }
    #[test]
    fn poisoned_tracker_denies_publication_but_keeps_exact_cleanup_available() {
        let gate = crate::lifecycle::Gate::default();
        let tracker = WindowTracker::<u64>::default();
        let live = tracked_window(&tracker, &gate, 1);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = tracker.slot.lock().unwrap();
            panic!("模拟状态锁中毒");
        }));
        assert!(tracker.snapshot().is_err());
        assert!(tracker.promote(&live, "native-1".into()).is_err());
        assert_eq!(tracker.begin_close(Some(&live), std::time::Instant::now()).unwrap().unwrap().window, 1);
        live.1.store(true, Ordering::Release);
        tracker.destroyed(&live);
        gate.begin_restart().unwrap();
    }
    #[test]
    fn four_tools_channels_keep_shape_and_boolean_open_contract() {
        for channel in ["devmode:openTools", "devmode:closeTools", "devmode:openDevTools", "devmode:closeDevTools"] { assert!(Command::parse(channel, &[]).unwrap().is_some()); assert!(Command::parse(channel, &[Value::Null]).is_err()); }
        assert!(Command::parse("devmode:verify", &[]).unwrap().is_none());
    }
}

//! Windows 联机迷你窗宿主。仅发布大厅快照；精确 Destroyed 与双表清理前保留 owner。
use super::session;
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewWindow};

#[path = "../ai_hud_window/lifecycle.rs"]
mod lifecycle;
use lifecycle::{Action, Desired, Model, Registry};

type Result<T> = std::result::Result<T, String>;
const LABEL: &str = "mini";
const ENTRY: &str = "index.html?window=mini";
const WIDTH: f64 = 300.0;
const HEIGHT: f64 = 420.0;
const MIN_WIDTH: f64 = 240.0;
const MIN_HEIGHT: f64 = 56.0;
const MAX_PENDING_CHATS: usize = 300;
const RETRY_DELAY: Duration = Duration::from_millis(100);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Default)]
struct Signals { destroyed: AtomicBool, close_requested: AtomicBool }
struct Binding { id: u64, stamp: Option<String>, window: WebviewWindow, signals: Arc<Signals> }
#[derive(Default)]
struct Inner {
    pending: bool,
    busy: bool,
    retry_scheduled: bool,
    // 普通关闭只撤销本次显示请求，不把整个宿主变成不可重开的终态。
    requested: bool,
    model: Model,
    binding: Option<Binding>,
    // 迷你窗存活期间持有资源票；仅回执且双表清空后 finish。
    lease: Option<crate::lifecycle::Request>,
    error: Option<String>,
    state_dirty: bool,
    mailbox: VecDeque<(u64, Value)>,
}
struct State { closed: AtomicBool, publish_pending: AtomicBool, started: Instant, inner: Mutex<Inner> }
impl Default for State {
    fn default() -> Self { Self { closed: AtomicBool::new(false), publish_pending: AtomicBool::new(false), started: Instant::now(), inner: Mutex::new(Inner::default()) } }
}
impl State { fn now(&self) -> u64 { self.started.elapsed().as_millis().min(u64::MAX as u128) as u64 } }

fn failure() -> String { "联机迷你窗状态不可用 / 連線迷你視窗狀態無法使用 / Multiplayer mini window is unavailable".into() }
fn unsupported() -> String { "当前平台尚未接入联机迷你窗 / 目前平台尚未接入連線迷你視窗 / Multiplayer mini window is unavailable on this platform".into() }
fn state(app: &AppHandle) -> Result<Arc<State>> { app.try_state::<Arc<State>>().map(|v| v.inner().clone()).ok_or_else(failure) }

fn allowed_url(label: &str, url: &url::Url) -> bool {
    if label != LABEL || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() { return false; }
    let bundled = url.port().is_none()
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost")));
    let dev = cfg!(debug_assertions) && url.scheme() == "http"
        && matches!(url.host_str(), Some("localhost") | Some("127.0.0.1")) && url.port() == Some(1420);
    (bundled || dev) && matches!(url.path(), "/" | "/index.html") && url.query() == Some("window=mini")
}

pub(crate) fn init(app: &AppHandle) { let _ = app.manage(Arc::new(State::default())); }

async fn on_ui<T: Send + 'static>(app: &AppHandle, work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || { let _ = tx.send(work()); }).map_err(|_| failure())?;
    rx.await.map_err(|_| failure())?
}

fn mark(state: &State, terminal: bool) -> bool {
    let Ok(mut inner) = state.inner.lock() else { return false; };
    if terminal { inner.model.terminate(); }
    else { if state.closed.load(Ordering::Acquire) { return false; } inner.model.request(); }
    inner.pending = true;
    if inner.busy { false } else { inner.busy = true; true }
}

pub(crate) fn open(app: &AppHandle) -> Result<()> {
    #[cfg(not(windows))] { let _ = app; return Err(unsupported()); }
    #[cfg(windows)] {
        let state = state(app)?;
        if state.closed.load(Ordering::Acquire) { return Err(failure()); }
        {
            let mut inner = state.inner.lock().map_err(|_| failure())?;
            inner.requested = true;
        }
        if mark(&state, false) { spawn(app, state); }
        Ok(())
    }
}

pub(crate) fn request_close(app: &AppHandle) -> Result<()> {
    #[cfg(not(windows))] { let _ = app; return Err(unsupported()); }
    #[cfg(windows)] {
        let state = state(app)?;
        if state.closed.load(Ordering::Acquire) { return Err(failure()); }
        {
            let mut inner = state.inner.lock().map_err(|_| failure())?;
            inner.requested = false;
            inner.state_dirty = false;
            inner.mailbox.clear();
        }
        if mark(&state, false) { spawn(app, state); }
        Ok(())
    }
}

pub(crate) fn close(app: &AppHandle) {
    #[cfg(windows)] if let Ok(state) = state(app) {
        state.closed.store(true, Ordering::Release);
        if let Ok(mut inner) = state.inner.lock() {
            inner.requested = false;
            inner.state_dirty = false;
            inner.mailbox.clear();
        }
        if mark(&state, true) { spawn(app, state); }
    }
    #[cfg(not(windows))] { let _ = app; }
}

fn wake(app: &AppHandle, id: u64) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(state) = state(&handle) else { return; };
        let start = match state.inner.lock() {
            Ok(mut inner) if inner.model.instance() == Some(id) => {
                inner.pending = true;
                if inner.busy { false } else { inner.busy = true; true }
            }
            _ => false,
        };
        if start { spawn(&handle, state); }
    });
}

fn retry(app: &AppHandle, state: &Arc<State>) {
    let schedule = match state.inner.lock() {
        Ok(mut inner) if inner.pending && !inner.busy && !inner.retry_scheduled => { inner.retry_scheduled = true; true }
        _ => false,
    };
    if !schedule { return; }
    let handle = app.clone(); let state = state.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(RETRY_DELAY).await;
        let start = match state.inner.lock() {
            Ok(mut inner) => { inner.retry_scheduled = false; if inner.pending && !inner.busy { inner.busy = true; true } else { false } }
            _ => false,
        };
        if start { spawn(&handle, state); }
    });
}

fn spawn(app: &AppHandle, state: Arc<State>) {
    let handle = app.clone(); let monitor = handle.clone(); let retained = state.clone();
    let task = tauri::async_runtime::spawn(async move { worker(&handle, &state).await; });
    tauri::async_runtime::spawn(async move {
        if task.await.is_err() {
            let should_retry = if let Ok(mut inner) = retained.inner.lock() {
                inner.model.fault(); inner.error = Some(failure()); inner.busy = false;
                if inner.binding.is_some() { inner.pending = true; true } else { false }
            } else { false };
            if should_retry { retry(&monitor, &retained); }
        }
    });
}

#[derive(Clone, Copy)]
enum Step { Again, Wait, Visible, Idle, Retained }
fn finish(inner: &mut Inner) { if let Some(lease) = inner.lease.take() { lease.finish(); } }

async fn worker(app: &AppHandle, state: &Arc<State>) {
    loop {
        {
            let Ok(mut inner) = state.inner.lock() else { return; };
            if !inner.pending { inner.busy = false; return; }
            inner.pending = false;
        }
        let needs_lease = state.inner.lock().map(|i| i.lease.is_none()).unwrap_or(false);
        if needs_lease && !state.closed.load(Ordering::Acquire) {
            match app.state::<crate::lifecycle::Gate>().enter_classified() {
                Ok(lease) => { let Ok(mut inner) = state.inner.lock() else { return; }; inner.lease = Some(lease); }
                Err(crate::lifecycle::EnterFailure::Closed) => { state.closed.store(true, Ordering::Release); if let Ok(mut inner) = state.inner.lock() { inner.model.terminate(); } }
                Err(crate::lifecycle::EnterFailure::Restarting) => { if let Ok(mut inner) = state.inner.lock() { inner.pending = true; inner.busy = false; } retry(app, state); return; }
                Err(_) => { if let Ok(mut inner) = state.inner.lock() { inner.error = Some(failure()); inner.busy = false; } return; }
            }
        }
        let handle = app.clone(); let owned = state.clone();
        let result = on_ui(app, move || sync_on_ui(&handle, &owned)).await;
        let mut again = false; let mut wait = false;
        if let Ok(mut inner) = state.inner.lock() {
            match result {
                Ok(Step::Again) => { inner.pending = true; again = true; }
                Ok(Step::Wait) => { inner.pending = true; inner.busy = false; wait = true; }
                Ok(Step::Visible) => { inner.error = None; if inner.pending { again = true; } else { inner.busy = false; } }
                Ok(Step::Idle) => {
                    if inner.model.instance().is_none() && !inner.model.busy_resource() && inner.binding.is_none() {
                        inner.error = None; finish(&mut inner);
                    } else { inner.error = Some(failure()); }
                    if inner.pending { again = true; } else { inner.busy = false; }
                }
                Ok(Step::Retained) => { inner.error = Some(failure()); if inner.pending { again = true; } else { inner.busy = false; } }
                Err(error) => {
                    inner.error = Some(error);
                    if let Some(id) = inner.model.instance() {
                        if inner.binding.is_some() { inner.model.native_failed(id, state.now()); inner.pending = true; again = true; }
                        else { inner.model.creation_failed(id); inner.busy = false; }
                    } else {
                        // WindowBuilder 失败可能存在副作用，未取得 exact handle 时不得假定清理完成。
                        inner.model.fault(); inner.busy = false;
                    }
                }
            }
        }
        if wait { retry(app, state); }
        if !again { return; }
    }
}

#[cfg(windows)]
fn stamp(window: &WebviewWindow) -> Result<String> {
    use raw_window_handle::HasWindowHandle;
    Ok(format!("{:?}", window.window_handle().map_err(|_| failure())?.as_raw()))
}

#[cfg(windows)]
fn registry(app: &AppHandle, binding: Option<&(u64, Option<String>, Arc<Signals>)>) -> Registry {
    let native = app.get_window(LABEL).is_some(); let webview = app.get_webview(LABEL).is_some();
    let destroyed = binding.is_some_and(|(_, _, signals)| signals.destroyed.load(Ordering::Acquire));
    let identity = if native && webview && !destroyed {
        binding.and_then(|(_, expected, _)| expected.as_ref())
            .zip(app.get_webview_window(LABEL).and_then(|window| stamp(&window).ok()))
            .map(|(expected, actual)| expected == &actual)
    } else { None };
    Registry::observe(native, webview, binding.is_some(), destroyed, identity)
}

#[cfg(windows)]
fn current(app: &AppHandle) -> Result<WebviewWindow> {
    let state = state(app)?;
    let (id, expected, bound) = {
        let inner = state.inner.lock().map_err(|_| failure())?;
        if state.closed.load(Ordering::Acquire) || !inner.requested || inner.model.closing() || inner.model.uncertain() { return Err(failure()); }
        let binding = inner.binding.as_ref().filter(|binding| !binding.signals.destroyed.load(Ordering::Acquire)
            && !binding.signals.close_requested.load(Ordering::Acquire)).ok_or_else(failure)?;
        (binding.id, binding.stamp.clone().ok_or_else(failure)?, binding.window.clone())
    };
    if app.get_window(LABEL).is_none() || app.get_webview(LABEL).is_none() { return Err(failure()); }
    let window = app.get_webview_window(LABEL).ok_or_else(failure)?;
    let url = window.url().map_err(|_| failure())?;
    if stamp(&window)? != expected || stamp(&bound)? != expected || !allowed_url(window.label(), &url) { return Err(failure()); }
    let inner = state.inner.lock().map_err(|_| failure())?;
    if state.closed.load(Ordering::Acquire) || !inner.requested || inner.model.closing() || inner.model.uncertain()
        || !inner.binding.as_ref().is_some_and(|binding| binding.id == id && binding.stamp.as_ref() == Some(&expected)
            && !binding.signals.destroyed.load(Ordering::Acquire) && !binding.signals.close_requested.load(Ordering::Acquire)) {
        return Err(failure());
    }
    Ok(window)
}

/// 多次状态变更只排一个 UI 回合；实际投递时读取最新快照，不让旧快照最后到达。
pub(crate) fn publish_state(app: &AppHandle) {
    #[cfg(windows)] {
        let Ok(state) = state(app) else { return; };
        if state.closed.load(Ordering::Acquire) { return; }
        {
            let Ok(mut inner) = state.inner.lock() else { return; };
            if !inner.requested { return; }
            inner.state_dirty = true;
        }
        schedule_publish(app, state);
    }
    #[cfg(not(windows))] { let _ = app; }
}

/// 没有活动小窗时与 Electron 一样丢弃聊天；有界邮箱避免迟到消息无限积累。
pub(crate) fn publish_chat(app: &AppHandle, generation: u64, chat: &Value) {
    #[cfg(windows)] {
        if !session::mini_generation_is_live(app, generation).unwrap_or(false) { return; }
        let Ok(state) = state(app) else { return; };
        {
            let Ok(mut inner) = state.inner.lock() else { return; };
            if state.closed.load(Ordering::Acquire) || !inner.requested || inner.model.closing() || inner.model.uncertain() { return; }
            let Some(binding) = inner.binding.as_ref().filter(|binding| !binding.signals.destroyed.load(Ordering::Acquire)
                && !binding.signals.close_requested.load(Ordering::Acquire)) else { return; };
            let _ = binding;
            if inner.mailbox.len() == MAX_PENDING_CHATS { inner.mailbox.pop_front(); }
            inner.mailbox.push_back((generation, chat.clone()));
        }
        schedule_publish(app, state);
    }
    #[cfg(not(windows))] { let _ = (app, generation, chat); }
}

#[cfg(windows)]
fn schedule_publish(app: &AppHandle, state: Arc<State>) {
    if state.publish_pending.swap(true, Ordering::AcqRel) { return; }
    let handle = app.clone();
    let pending = state.clone();
    if app.run_on_main_thread(move || {
        pending.publish_pending.store(false, Ordering::Release);
        use tauri::Emitter;
        let (snapshot, chats) = {
            let Ok(mut inner) = pending.inner.lock() else { return; };
            if !inner.requested || pending.closed.load(Ordering::Acquire) { inner.state_dirty = false; inner.mailbox.clear(); return; }
            let snapshot = if inner.state_dirty { inner.state_dirty = false; session::mini_snapshot(&handle).ok() } else { None };
            (snapshot, inner.mailbox.drain(..).collect::<Vec<_>>())
        };
        let Ok(window) = current(&handle) else { return; };
        if let Some(snapshot) = snapshot {
            let _ = handle.emit_to(LABEL, "launcher:event", serde_json::json!({"channel":"mp:miniState","payload":snapshot}));
        }
        for (generation, chat) in chats {
            if !session::mini_generation_is_live(&handle, generation).unwrap_or(false) { continue; }
            let _ = handle.emit_to(LABEL, "launcher:event", serde_json::json!({"channel":"mp:chat","payload":chat}));
        }
        let _ = window;
    }).is_err() { state.publish_pending.store(false, Ordering::Release); }
}

/// 小窗固定 URL 与精确自有实例的受限来源检查；不接受仅凭 `mini` label 的替代实例。
pub(crate) async fn authorize(app: &AppHandle, window: &WebviewWindow) -> Result<()> {
    #[cfg(not(windows))] { let _ = (app, window); return Err(unsupported()); }
    #[cfg(windows)] {
        let handle = app.clone(); let caller = window.clone();
        on_ui(app, move || {
            let owner = current(&handle)?;
            if stamp(&caller)? != stamp(&owner)? { return Err(failure()); }
            let url = caller.url().map_err(|_| failure())?;
            if allowed_url(caller.label(), &url) { Ok(()) } else { Err(failure()) }
        }).await
    }
}

pub(crate) async fn resize(app: &AppHandle, width: f64, height: f64) -> Result<()> {
    #[cfg(not(windows))] { let _ = (app, width, height); return Err(unsupported()); }
    #[cfg(windows)] {
        if !width.is_finite() || !height.is_finite() { return Err(failure()); }
        let requested = (width.round().clamp(MIN_WIDTH, 1_600.0), height.round().clamp(MIN_HEIGHT, 1_200.0));
        let handle = app.clone();
        on_ui(app, move || {
            let window = current(&handle)?;
            let monitor = window.current_monitor().map_err(|_| failure())?
                .or(window.primary_monitor().map_err(|_| failure())?).ok_or_else(failure)?;
            let scale = monitor.scale_factor();
            let area = monitor.work_area();
            if !scale.is_finite() || scale <= 0.0 || area.size.width == 0 || area.size.height == 0 { return Err(failure()); }
            let max_width = (f64::from(area.size.width) / scale).max(MIN_WIDTH);
            let max_height = (f64::from(area.size.height) / scale - 40.0).max(320.0);
            let width = requested.0.min(max_width);
            let height = requested.1.min(max_height);
            window.set_size(tauri::LogicalSize::new(width, height)).map_err(|_| failure())
        }).await
    }
}

pub(crate) async fn drag(app: &AppHandle) -> Result<()> {
    #[cfg(not(windows))] { let _ = app; return Err(unsupported()); }
    #[cfg(windows)] {
        let handle = app.clone();
        on_ui(app, move || current(&handle)?.start_dragging().map_err(|_| failure())).await
    }
}

/// 与 Electron 合同一致：返回调用者是否就是仍存活的主窗口，而不是任意窗口是否存在。
pub(crate) async fn has_main(app: &AppHandle, caller: &WebviewWindow) -> Result<bool> {
    let handle = app.clone(); let caller = caller.clone();
    on_ui(app, move || Ok(caller.label() == "main" && handle.get_webview_window("main").is_some())).await
}

#[cfg(windows)]
fn sync_on_ui(app: &AppHandle, state: &Arc<State>) -> Result<Step> {
    let observation = {
        let mut inner = state.inner.lock().map_err(|_| failure())?;
        if state.closed.load(Ordering::Acquire) { inner.model.terminate(); }
        if let Some(binding) = &inner.binding {
            let id = binding.id;
            if binding.signals.destroyed.load(Ordering::Acquire) { inner.model.destroyed(id, state.now()); }
            else if binding.signals.close_requested.load(Ordering::Acquire) {
                inner.requested = false;
                inner.state_dirty = false;
                inner.mailbox.clear();
                inner.model.begin_close(id, state.now());
            }
        }
        inner.binding.as_ref().map(|binding| (binding.id, binding.stamp.clone(), binding.signals.clone()))
    };
    let observed = registry(app, observation.as_ref());
    let requested = state.inner.lock().map_err(|_| failure())?.requested;
    let desired = Desired { enabled: requested && !state.closed.load(Ordering::Acquire), revision: 0, language: "en".into() };
    let action = {
        let mut inner = state.inner.lock().map_err(|_| failure())?;
        if inner.binding.as_ref().map(|binding| binding.id) != observation.map(|binding| binding.0) { return Ok(Step::Again); }
        inner.model.plan(&desired, observed, state.now())
    };
    match action {
        Action::Idle => {
            let mut inner = state.inner.lock().map_err(|_| failure())?;
            if !inner.requested { inner.state_dirty = false; inner.mailbox.clear(); }
            Ok(Step::Idle)
        },
        Action::Wait => Ok(Step::Wait),
        Action::Retained => Ok(Step::Retained),
        Action::Released(id) => {
            let mut inner = state.inner.lock().map_err(|_| failure())?;
            if inner.binding.as_ref().is_some_and(|binding| binding.id == id) { inner.binding = None; }
            inner.error = None; inner.state_dirty = false; inner.mailbox.clear(); finish(&mut inner); Ok(Step::Again)
        }
        Action::Destroy { id } => {
            let window = {
                let inner = state.inner.lock().map_err(|_| failure())?;
                inner.binding.as_ref().filter(|binding| binding.id == id && !binding.signals.destroyed.load(Ordering::Acquire))
                    .map(|binding| binding.window.clone()).ok_or_else(failure)?
            };
            if window.destroy().is_err() {
                let mut inner = state.inner.lock().map_err(|_| failure())?;
                inner.model.queue_failed(id); inner.error = Some(failure());
            }
            Ok(Step::Wait)
        }
        Action::Create { id, generation } => create(app, state, id, generation),
        Action::Show { id, generation } => show(app, state, id, generation),
    }
}
#[cfg(not(windows))]
fn sync_on_ui(_app: &AppHandle, _state: &Arc<State>) -> Result<Step> { Err(unsupported()) }

#[cfg(windows)]
fn create(app: &AppHandle, state: &Arc<State>, id: u64, generation: u64) -> Result<Step> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let main = match app.get_webview_window("main") { Some(main) => main, None => {
        state.inner.lock().map_err(|_| failure())?.model.cancel_creation(id); return Err(failure());
    }};
    let monitor = match main.current_monitor().map_err(|_| failure())?.or(main.primary_monitor().map_err(|_| failure())?) {
        Some(monitor) => monitor, None => { state.inner.lock().map_err(|_| failure())?.model.cancel_creation(id); return Err(failure()); }
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    if !scale.is_finite() || scale <= 0.0 || area.size.width == 0 || area.size.height == 0 {
        state.inner.lock().map_err(|_| failure())?.model.cancel_creation(id); return Err(failure());
    }
    let width = WIDTH.min(f64::from(area.size.width) / scale);
    let height = HEIGHT.min(f64::from(area.size.height) / scale);
    let x = (f64::from(area.position.x) / scale) + ((f64::from(area.size.width) / scale - width).max(0.0) / 2.0);
    let y = (f64::from(area.position.y) / scale) + ((f64::from(area.size.height) / scale - height).max(0.0) / 2.0);
    {
        let inner = state.inner.lock().map_err(|_| failure())?;
        if state.closed.load(Ordering::Acquire) || !inner.requested || !inner.model.can_create(id, generation) {
            drop(inner); state.inner.lock().map_err(|_| failure())?.model.defer_creation(id); return Ok(Step::Again);
        }
    }
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(ENTRY.into()))
        .inner_size(width, height).position(x, y).min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .visible(false).focused(false).decorations(false).transparent(true).shadow(false)
        .always_on_top(true).skip_taskbar(true).resizable(true).maximizable(false).minimizable(false)
        .fullscreen(false).devtools(false)
        .on_navigation(|url| allowed_url(LABEL, url))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build().map_err(|_| failure())?;
    let signals = Arc::new(Signals::default()); let callback_signals = signals.clone(); let callback_app = app.clone();
    window.on_window_event(move |event| {
        match event {
            tauri::WindowEvent::Destroyed => callback_signals.destroyed.store(true, Ordering::Release),
            tauri::WindowEvent::CloseRequested { api, .. } => { api.prevent_close(); callback_signals.close_requested.store(true, Ordering::Release); }
            _ => return,
        }
        wake(&callback_app, id);
    });
    let native_stamp = stamp(&window);
    {
        let mut inner = state.inner.lock().map_err(|_| failure())?;
        inner.binding = Some(Binding { id, stamp: native_stamp.as_ref().ok().cloned(), window: window.clone(), signals });
        if !inner.model.created(id, "en".into()) { inner.model.fault(); inner.error = Some(failure()); return Err(failure()); }
    }
    if native_stamp.is_err() { let mut inner = state.inner.lock().map_err(|_| failure())?; inner.model.native_failed(id, state.now()); inner.pending = true; return Ok(Step::Again); }
    show(app, state, id, generation)
}

#[cfg(windows)]
fn show(app: &AppHandle, state: &Arc<State>, id: u64, generation: u64) -> Result<Step> {
    let window = {
        let inner = state.inner.lock().map_err(|_| failure())?;
        if !inner.model.can_show(id, generation) || !inner.requested || state.closed.load(Ordering::Acquire) { return Ok(Step::Again); }
        inner.binding.as_ref().filter(|binding| binding.id == id && !binding.signals.destroyed.load(Ordering::Acquire)
            && !binding.signals.close_requested.load(Ordering::Acquire)).map(|binding| binding.window.clone()).ok_or_else(failure)?
    };
    window.set_always_on_top(true).map_err(|_| failure())?;
    window.set_skip_taskbar(true).map_err(|_| failure())?;
    window.set_resizable(true).map_err(|_| failure())?;
    if !window.is_visible().map_err(|_| failure())? { window.show().map_err(|_| failure())?; }
    window.set_focus().map_err(|_| failure())?;
    let inner = state.inner.lock().map_err(|_| failure())?;
    let visible = inner.model.can_show(id, generation) && inner.requested && !state.closed.load(Ordering::Acquire);
    drop(inner);
    if visible {
        // 首帧在窗口已登记且可见后补推最新快照，不依赖固定 300ms 定时器。
        publish_state(app);
        Ok(Step::Visible)
    } else { Ok(Step::Again) }
}

pub(crate) async fn shutdown(app: &AppHandle) -> Result<()> {
    #[cfg(not(windows))] { close(app); return Ok(()); }
    #[cfg(windows)] {
        close(app);
        let state = state(app)?;
        let deadline = tokio::time::Instant::now() + SHUTDOWN_TIMEOUT;
        loop {
            let ready = {
                let inner = state.inner.lock().map_err(|_| failure())?;
                inner.model.terminal() && !inner.model.busy_resource() && inner.binding.is_none()
                    && !inner.busy && !inner.pending && !inner.model.uncertain() && inner.lease.is_none()
            };
            if ready {
                let handle = app.clone();
                let check = on_ui(app, move || Ok(handle.get_window(LABEL).is_none() && handle.get_webview(LABEL).is_none()));
                if tokio::time::timeout_at(deadline, check).await.map_err(|_| failure())?? { return Ok(()); }
            }
            if tokio::time::Instant::now() >= deadline { return Err(failure()); }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

pub(crate) fn relaunch_ready(app: &AppHandle) -> Result<()> {
    #[cfg(not(windows))] { let _ = app; return Ok(()); }
    #[cfg(windows)] {
        let state = state(app)?;
        let inner = state.inner.try_lock().map_err(|_| failure())?;
        if state.closed.load(Ordering::Acquire) || inner.busy || inner.pending || inner.retry_scheduled
            || inner.model.busy_resource() || inner.model.uncertain() || inner.lease.is_some() { Err(failure()) }
        else { Ok(()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mini_authorization_requires_exact_fixed_origin_and_query() {
        assert!(allowed_url(LABEL, &url::Url::parse("tauri://localhost/index.html?window=mini").unwrap()));
        for raw in ["tauri://localhost/index.html?window=mini&x=1", "tauri://localhost/index.html?window=mini#x", "tauri://user@localhost/index.html?window=mini", "tauri://localhost/other?window=mini", "https://evil.invalid/index.html?window=mini"] {
            assert!(!allowed_url(LABEL, &url::Url::parse(raw).unwrap()));
        }
        assert!(!allowed_url("main", &url::Url::parse("tauri://localhost/index.html?window=mini").unwrap()));
    }

    #[test]
    fn mini_model_keeps_destroy_owner_until_receipt_and_both_tables_are_empty() {
        let visible = Desired { enabled: true, revision: 1, language: "en".into() };
        let hidden = Desired { enabled: false, revision: 1, language: "en".into() };
        let mut model = Model::default(); model.request();
        let Action::Create { id, .. } = model.plan(&visible, Registry::Empty, 0) else { panic!() };
        assert!(model.created(id, "en".into())); model.request();
        assert_eq!(model.plan(&hidden, Registry::Owned, 1), Action::Destroy { id });
        assert_eq!(model.plan(&hidden, Registry::Owned, 2), Action::Wait);
        assert!(model.destroyed(id, 3));
        assert_eq!(model.plan(&hidden, Registry::observe(true, true, true, true, None), 3), Action::Wait);
        assert_eq!(model.plan(&hidden, Registry::observe(false, true, true, true, None), 4), Action::Wait);
        assert_eq!(model.plan(&hidden, Registry::observe(true, false, true, true, None), 5), Action::Wait);
        assert_eq!(model.plan(&hidden, Registry::Empty, 6), Action::Released(id));
        assert!(matches!(model.plan(&visible, Registry::Empty, 7), Action::Create { .. }));
    }

    #[test]
    fn ordinary_close_releases_owner_and_allows_a_fresh_open() {
        let visible = Desired { enabled: true, revision: 0, language: "en".into() };
        let hidden = Desired { enabled: false, revision: 0, language: "en".into() };
        let mut inner = Inner::default(); inner.requested = true; inner.model.request();
        let Action::Create { id, .. } = inner.model.plan(&visible, Registry::Empty, 0) else { panic!() };
        assert!(inner.model.created(id, "en".into()));
        inner.requested = false; inner.model.request();
        assert_eq!(inner.model.plan(&hidden, Registry::Owned, 1), Action::Destroy { id });
        assert!(inner.model.destroyed(id, 2));
        assert_eq!(inner.model.plan(&hidden, Registry::Empty, 3), Action::Released(id));
        inner.binding = None;
        inner.requested = true; inner.model.request();
        assert!(matches!(inner.model.plan(&visible, Registry::Empty, 4), Action::Create { .. }));
        assert!(!inner.model.terminal());
    }

    #[test]
    fn mini_model_retains_unknown_and_terminal_close_never_reopens() {
        let desired = Desired { enabled: true, revision: 1, language: "en".into() };
        let mut model = Model::default(); model.request();
        let Action::Create { id, .. } = model.plan(&desired, Registry::Empty, 0) else { panic!() };
        assert!(model.created(id, "en".into())); model.terminate();
        assert_eq!(model.plan(&desired, Registry::Owned, 1), Action::Destroy { id });
        assert_eq!(model.plan(&desired, Registry::Empty, 2_501), Action::Retained);
        assert!(model.uncertain() && model.busy_resource());
    }
}

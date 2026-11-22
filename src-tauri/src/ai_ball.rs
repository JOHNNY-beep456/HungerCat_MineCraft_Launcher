//! 受限 AI 桌面悬浮球：共享原有 React 页面，原生与存储分别在 UI / 后台执行。
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewWindow};

// 私有复用已使用的销毁回执模型，不改变 HUD 的状态或实现。
#[path = "ai_hud_window/lifecycle.rs"]
mod lifecycle;
mod geometry;
#[cfg(target_os = "windows")]
mod native;
use lifecycle::{Action, Desired, Model, Registry};
use geometry::Point;

type Result<T> = std::result::Result<T, String>;
const LABEL: &str = "ai-ball";
const ENTRY: &str = "index.html?window=ai-ball";
fn unavailable() -> String { "AI 悬浮球状态尚未确认 / AI 懸浮球狀態尚未確認 / AI ball state is not confirmed".into() }
fn unsupported() -> String { "此平台的 AI 桌面悬浮球尚未接线 / 此平台的 AI 桌面懸浮球尚未接線 / AI desktop ball is not implemented on this platform".into() }

#[derive(Clone)]
struct Preferences { enabled: bool, x: f64, y: f64 }
impl Default for Preferences { fn default() -> Self { Self { enabled: false, x: -1.0, y: -1.0 } } }
impl Preferences {
    fn from_settings(value: &Value) -> Self {
        let number = |key| value.get(key).and_then(Value::as_f64).filter(|v| v.is_finite()).unwrap_or(-1.0);
        Self { enabled: value["aiEnabled"].as_bool() == Some(true) && value["aiBallEnabled"].as_bool() == Some(true), x: number("aiBallX"), y: number("aiBallY") }
    }
}
#[derive(Default)]
struct Signals { destroyed: AtomicBool, close_requested: AtomicBool }
struct Binding { id: u64, stamp: Option<String>, window: WebviewWindow, signals: Arc<Signals> }
#[derive(Default)]
struct Inner {
    model: Model,
    binding: Option<Binding>,
    preferences: Preferences,
    revision: u64,
    expanded: bool,
    pending: bool,
    refresh: bool,
    busy: bool,
    retry_scheduled: bool,
    lease: Option<crate::lifecycle::Resource>,
    error: Option<String>,
}
struct State {
    closed: AtomicBool,
    started: Instant,
    inner: Mutex<Inner>,
    // 只在后台异步等待；UI 从不等待此锁。几何修改与实际位置写入保持次序。
    operations: tokio::sync::Mutex<()>,
}
impl Default for State {
    fn default() -> Self { Self { closed: AtomicBool::new(false), started: Instant::now(), inner: Mutex::new(Inner::default()), operations: tokio::sync::Mutex::new(()) } }
}
impl State { fn now(&self) -> u64 { self.started.elapsed().as_millis().min(u64::MAX as u128) as u64 } }

pub(crate) fn init(app: &AppHandle) { let _ = app.manage(Arc::new(State::default())); }
fn state(app: &AppHandle) -> Result<Arc<State>> { app.try_state::<Arc<State>>().map(|s| s.inner().clone()).ok_or_else(unavailable) }
fn allowed_url(label: &str, url: &url::Url) -> bool {
    if label != LABEL || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() { return false; }
    let bundled = url.port().is_none() && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost")));
    let development = cfg!(debug_assertions) && url.scheme() == "http"
        && matches!(url.host_str(), Some("localhost") | Some("127.0.0.1")) && url.port() == Some(1420);
    (bundled || development) && matches!(url.path(), "/" | "/index.html") && url.query() == Some("window=ai-ball")
}
fn initial_sync_ready(url: &url::Url) -> Result<bool> {
    if url.as_str() == "about:blank" { return Ok(false); }
    if allowed_url(LABEL, url) { Ok(true) } else { Err(unavailable()) }
}
pub(crate) fn authorize(app: &AppHandle, window: &WebviewWindow) -> Result<()> {
    #[cfg(not(target_os = "windows"))]
    { let _ = (app, window); Err(unsupported()) }
    #[cfg(target_os = "windows")]
    {
        let state = state(app)?;
        if state.closed.load(Ordering::Acquire) || !allowed_url(window.label(), &window.url().map_err(|_| unavailable())?) { return Err(unavailable()); }
        // 原生 getter 必须在状态锁外；label 或 WebviewWindow::eq 不能证明实例相同。
        let actual = native::stamp(window)?;
        let inner = state.inner.lock().map_err(|_| unavailable())?;
        let binding = inner.binding.as_ref().ok_or_else(unavailable)?;
        if !state.closed.load(Ordering::Acquire) && inner.preferences.enabled && !inner.model.closing() && !inner.model.uncertain()
            && inner.model.instance() == Some(binding.id) && binding.stamp.as_deref() == Some(actual.as_str())
            && !binding.signals.destroyed.load(Ordering::Acquire) && !binding.signals.close_requested.load(Ordering::Acquire) {
            Ok(())
        } else { Err(unavailable()) }
    }
}
fn request(state: &State, refresh: bool, terminal: bool) -> bool {
    let Ok(mut inner) = state.inner.lock() else { return false; };
    if terminal { inner.model.terminate(); }
    else {
        if state.closed.load(Ordering::Acquire) { return false; }
        inner.model.request(); inner.refresh |= refresh;
    }
    inner.pending = true;
    if inner.busy { false } else { inner.busy = true; true }
}
pub(crate) fn request_sync(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    if let Ok(state) = state(app) { if request(&state, true, false) { spawn_worker(app, state); } }
    #[cfg(not(target_os = "windows"))]
    let _ = app;
}
pub(crate) fn close(app: &AppHandle) {
    if let Ok(state) = state(app) {
        state.closed.store(true, Ordering::Release);
        #[cfg(target_os = "windows")]
        if request(&state, false, true) { spawn_worker(app, state); }
    }
}
struct RestartView { binding: Option<(u64, Option<String>, Arc<Signals>)>, permit: Option<crate::lifecycle::ResourcePermit> }
fn restart_view(state: &State, inner: &Inner) -> Result<RestartView> {
    if state.closed.load(Ordering::Acquire) || inner.busy || inner.pending || inner.refresh || inner.retry_scheduled
        || inner.model.terminal() || inner.model.closing() || inner.model.uncertain() || inner.error.is_some() { return Err(unavailable()); }
    match (&inner.binding, &inner.lease) {
        (None, None) if !inner.model.busy_resource() => Ok(RestartView { binding: None, permit: None }),
        (Some(binding), Some(lease)) if inner.preferences.enabled && inner.model.instance() == Some(binding.id)
            && binding.stamp.is_some() && !binding.signals.destroyed.load(Ordering::Acquire)
            && !binding.signals.close_requested.load(Ordering::Acquire) => Ok(RestartView {
                binding: Some((binding.id, binding.stamp.clone(), binding.signals.clone())), permit: Some(lease.permit()),
            }),
        _ => Err(unavailable()),
    }
}
/// 稳定的自有显示资源允许由退出链收尾，不提前释放它的资源票据。
pub(crate) async fn restart_resource(app: &AppHandle) -> Result<Option<crate::lifecycle::ResourcePermit>> {
    #[cfg(not(target_os = "windows"))]
    { let _ = app; Ok(None) }
    #[cfg(target_os = "windows")]
    {
        let state = state(app)?;
        // 真实位置 writer / 原生操作尚未返回时，不能把它当作空闲显示资源。
        let _operation = state.operations.try_lock().map_err(|_| unavailable())?;
        let handle = app.clone(); let ui = state.clone();
        on_ui(app, move || native::restart_resource(&handle, &ui)).await
    }
}
pub(crate) async fn relaunch_ready(app: &AppHandle, expected: Option<&crate::lifecycle::ResourcePermit>) -> Result<()> {
    let actual = restart_resource(app).await?;
    match (expected, actual.as_ref()) {
        (None, None) => Ok(()),
        (Some(expected), Some(actual)) if expected.same_resource(actual) => Ok(()),
        _ => Err(unavailable()),
    }
}
pub(crate) async fn shutdown(app: &AppHandle) -> Result<()> {
    close(app);
    #[cfg(not(target_os = "windows"))]
    return Ok(());
    #[cfg(target_os = "windows")]
    {
        let state = state(app)?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
        loop {
            let ready = {
                let inner = state.inner.lock().map_err(|_| unavailable())?;
                inner.model.terminal() && !inner.model.busy_resource() && inner.binding.is_none()
                    && !inner.busy && !inner.pending && !inner.model.uncertain() && inner.lease.is_none()
            };
            if ready {
                let handle = app.clone();
                if tokio::time::timeout_at(deadline, on_ui(app, move || Ok(handle.get_window(LABEL).is_none() && handle.get_webview(LABEL).is_none())))
                    .await.map_err(|_| unavailable())?? { return Ok(()); }
            }
            if tokio::time::Instant::now() >= deadline { return Err(unavailable()); }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}
async fn on_ui<T: Send + 'static>(app: &AppHandle, callback: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || { let _ = send.send(callback()); }).map_err(|_| unavailable())?;
    receive.await.map_err(|_| unavailable())?
}
fn finish_lease(inner: &mut Inner) { if let Some(lease) = inner.lease.take() { lease.finish(); } }
#[derive(Clone, Copy)]
enum Step { Again, Wait, Idle, Retained }
fn wake_instance(app: &AppHandle, id: u64) {
    let handle = app.clone();
    // Destroyed 回调只记录原子回执，不在 manager 事件栈内取锁或宣布标签已释放。
    tauri::async_runtime::spawn(async move {
        let Ok(state) = state(&handle) else { return; };
        let start = match state.inner.lock() {
            Ok(mut inner) if inner.model.instance() == Some(id) => {
                inner.pending = true;
                if inner.busy { false } else { inner.busy = true; true }
            }
            _ => false,
        };
        if start { spawn_worker(&handle, state); }
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
        tokio::time::sleep(Duration::from_millis(100)).await;
        let start = match state.inner.lock() {
            Ok(mut inner) => { inner.retry_scheduled = false; if inner.pending && !inner.busy { inner.busy = true; true } else { false } }
            _ => false,
        };
        if start { spawn_worker(&handle, state); }
    });
}
fn spawn_worker(app: &AppHandle, state: Arc<State>) {
    let handle = app.clone(); let monitor = handle.clone(); let retained = state.clone();
    let task = tauri::async_runtime::spawn(async move { worker(&handle, &state).await; });
    tauri::async_runtime::spawn(async move {
        if task.await.is_err() {
            let schedule = if let Ok(mut inner) = retained.inner.lock() {
                inner.model.fault(); inner.error = Some(unavailable()); inner.busy = false;
                inner.pending = inner.binding.is_some(); inner.pending
            } else { false };
            if schedule { retry(&monitor, &retained); }
        }
    });
}
async fn refresh_preferences(app: &AppHandle, state: &Arc<State>) -> Result<()> {
    let handle = app.clone();
    let preferences = tauri::async_runtime::spawn_blocking(move || {
        handle.state::<crate::storage::Storage>().settings_for_backend().map(|s| Preferences::from_settings(&s))
    }).await.map_err(|_| unavailable())??;
    let mut inner = state.inner.lock().map_err(|_| unavailable())?;
    inner.preferences = preferences; inner.revision = inner.revision.wrapping_add(1);
    Ok(())
}
async fn worker(app: &AppHandle, state: &Arc<State>) {
    loop {
        let _serial = state.operations.lock().await;
        let refresh = {
            let Ok(mut inner) = state.inner.lock() else { return; };
            if !inner.pending { inner.busy = false; return; }
            inner.pending = false; std::mem::take(&mut inner.refresh)
        };
        let needs_lease = state.inner.lock().map(|i| i.lease.is_none()).unwrap_or(false);
        if needs_lease && !state.closed.load(Ordering::Acquire) {
            match app.state::<crate::lifecycle::Gate>().enter_resource_classified() {
                Ok(lease) => { if let Ok(mut inner) = state.inner.lock() { inner.lease = Some(lease); } else { return; } }
                Err(crate::lifecycle::EnterFailure::Closed) => {
                    state.closed.store(true, Ordering::Release);
                    if let Ok(mut inner) = state.inner.lock() { inner.model.terminate(); }
                }
                Err(crate::lifecycle::EnterFailure::Restarting) => {
                    if let Ok(mut inner) = state.inner.lock() { inner.pending = true; inner.refresh |= refresh; inner.busy = false; }
                    retry(app, state); return;
                }
                Err(_) => { if let Ok(mut inner) = state.inner.lock() { inner.error = Some(unavailable()); inner.busy = false; } return; }
            }
        }
        let result = if refresh && !state.closed.load(Ordering::Acquire) { refresh_preferences(app, state).await } else { Ok(()) };
        let step = match result {
            Err(error) => Err(error),
            Ok(()) => {
                let handle = app.clone(); let ui = state.clone();
                #[cfg(target_os = "windows")]
                { on_ui(app, move || native::sync(&handle, &ui)).await }
                #[cfg(not(target_os = "windows"))]
                { let _ = (handle, ui); Err(unsupported()) }
            }
        };
        let mut wait = false; let mut again = false;
        if let Ok(mut inner) = state.inner.lock() {
            match step {
                Ok(Step::Again) => { inner.pending = true; again = true; }
                Ok(Step::Wait) => { inner.pending = true; inner.busy = false; wait = true; }
                Ok(Step::Idle) => {
                    // 已存在的窗口仍保留 owner / Gate；只在完全没有 native 资源时结束登记。
                    if !inner.model.busy_resource() { finish_lease(&mut inner); }
                    if inner.pending { again = true; } else { inner.busy = false; }
                }
                Ok(Step::Retained) => { inner.error = Some(unavailable()); if inner.pending { again = true; } else { inner.busy = false; } }
                Err(error) => {
                    inner.error = Some(error);
                    if let Some(id) = inner.model.instance() {
                        if inner.binding.is_some() { inner.model.native_failed(id, state.now()); inner.pending = true; again = true; }
                        else { inner.model.creation_failed(id); inner.busy = false; }
                    } else {
                        finish_lease(&mut inner); if inner.pending { again = true; } else { inner.busy = false; }
                    }
                }
            }
        }
        if wait { retry(app, state); }
        if !again { return; }
    }
}

#[derive(Clone, Copy)]
enum Command { Sync, Expand(bool), Move(Point, bool), Position }
impl Command {
    fn parse(channel: &str, args: &[Value]) -> Result<Option<Self>> {
        let invalid = || "悬浮球参数无效 / 懸浮球參數無效 / Invalid AI ball arguments".to_string();
        Ok(Some(match channel {
            "ai:ball:sync" if args.is_empty() => Self::Sync,
            "ai:ball:position" if args.is_empty() => Self::Position,
            "ai:ball:expand" if args.len() == 1 => Self::Expand(args[0].as_bool().ok_or_else(invalid)?),
            "ai:ball:move" if args.len() == 3 => {
                let number = |i: usize| args[i].as_f64().filter(|v| v.is_finite() && v.abs() <= 10_000_000.0).ok_or_else(invalid);
                Self::Move(Point { x: number(0)?, y: number(1)? }, args[2].as_bool().ok_or_else(invalid)?)
            }
            "ai:ball:sync" | "ai:ball:position" | "ai:ball:expand" | "ai:ball:move" => return Err(invalid()),
            _ => return Ok(None),
        }))
    }
}
#[cfg(target_os = "windows")]
struct Output { value: Value, persist: Option<Point>, expanded: Option<(u64, bool)> }
#[cfg(target_os = "windows")]
async fn execute(app: &AppHandle, state: &Arc<State>, command: Command) -> Result<Value> {
    let _serial = state.operations.lock().await;
    if state.closed.load(Ordering::Acquire) { return Err(unavailable()); }
    if matches!(command, Command::Sync) { request_sync(app); }
    let handle = app.clone(); let ui = state.clone();
    let output = on_ui(app, move || native::command(&handle, &ui, command)).await;
    let output = match output {
        Ok(output) => output,
        Err(error) => {
            if let Ok(mut inner) = state.inner.lock() {
                if let Some(id) = inner.binding.as_ref().map(|b| b.id) { inner.model.native_failed(id, state.now()); }
            }
            if request(state, false, state.closed.load(Ordering::Acquire)) { spawn_worker(app, state.clone()); }
            return Err(error);
        }
    };
    let persisted = if let Some(point) = output.persist {
        let handle = app.clone();
        // 真实 writer 始终被等待；IPC 接收方离开不取消这项有序位置提交。
        let result = tauri::async_runtime::spawn_blocking(move || {
            handle.state::<crate::storage::Storage>().call("settings:set", &[json!({"aiBallX":point.x,"aiBallY":point.y})]).map(|_| ())
        }).await.map_err(|_| unavailable())?;
        if result.is_ok() {
            if let Ok(mut inner) = state.inner.lock() { inner.preferences.x = point.x; inner.preferences.y = point.y; }
        }
        result
    } else { Ok(()) };
    if let Some((id, expanded)) = output.expanded {
        let handle = app.clone(); let ui = state.clone();
        // 尺寸已经实际变更，即使保存失败也发布真实展开态，随后仍向调用方报告保存错误。
        on_ui(app, move || native::emit_expanded(&handle, &ui, id, expanded)).await?;
    }
    persisted?;
    Ok(output.value)
}
pub(crate) async fn call(app: &AppHandle, channel: &str, args: &[Value]) -> Result<Option<Value>> {
    // 非球通道必须先放行，不能使未接线平台的普通业务全部报错。
    let Some(command) = Command::parse(channel, args)? else { return Ok(None); };
    #[cfg(not(target_os = "windows"))]
    { let _ = (app, command); Err(unsupported()) }
    #[cfg(target_os = "windows")]
    {
        let state = state(app)?; let handle = app.clone();
        let lease = app.state::<crate::lifecycle::Gate>().enter()?;
        let (send, receive) = tokio::sync::oneshot::channel();
        tauri::async_runtime::spawn(async move {
            let result = execute(&handle, &state, command).await;
            lease.finish(); let _ = send.send(result);
        });
        receive.await.map_err(|_| unavailable())?.map(Some)
    }
}
/// 固定热键只由已在 UI 回合的调度方调用；不会开放任意目标或事件名。
pub(crate) fn voice_event_on_ui(app: &AppHandle, enabled: Option<bool>) -> Result<bool> {
    #[cfg(not(windows))]
    { let _ = (app, enabled); Ok(false) }
    #[cfg(windows)]
    { let state = state(app)?; native::voice_event(app, state.as_ref(), enabled) }
}

/// 辅助确认界面只收到同一个一次性队列的 DTO；无球时不影响主窗口确认。
pub(crate) fn emit_tool_request(app: &AppHandle, payload: &Value) -> Result<()> {
    #[cfg(not(target_os = "windows"))]
    { let _ = (app, payload); Ok(()) }
    #[cfg(target_os = "windows")]
    {
        let state = state(app)?; let payload = payload.clone(); let handle = app.clone();
        app.run_on_main_thread(move || { let _ = native::emit_tool_request(&handle, &state, payload); }).map_err(|_| unavailable())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_projection_uses_the_two_enable_switches_and_geometry_only() {
        let prefs = Preferences::from_settings(&json!({"aiEnabled":true,"aiBallEnabled":true,"aiBallX":123,"aiBallY":456,"unrelated":"fixture"}));
        assert!(prefs.enabled); assert_eq!((prefs.x,prefs.y), (123.0,456.0));
        assert!(!Preferences::from_settings(&json!({"aiBallEnabled":true})).enabled);
    }
    #[test]
    fn restart_projection_rejects_busy_unknown_and_missing_native_owner() {
        let state = State::default();
        let mut inner = Inner::default();
        assert!(restart_view(&state, &inner).unwrap().permit.is_none());
        inner.busy = true; assert!(restart_view(&state, &inner).is_err()); inner.busy = false;
        inner.pending = true; assert!(restart_view(&state, &inner).is_err()); inner.pending = false;
        inner.refresh = true; assert!(restart_view(&state, &inner).is_err()); inner.refresh = false;
        inner.retry_scheduled = true; assert!(restart_view(&state, &inner).is_err()); inner.retry_scheduled = false;
        let gate = crate::lifecycle::Gate::default();
        inner.lease = Some(gate.enter_resource_classified().unwrap());
        assert!(restart_view(&state, &inner).is_err());
        finish_lease(&mut inner);
        inner.model.fault(); assert!(restart_view(&state, &inner).is_err());
        let inner = Inner::default(); state.closed.store(true, Ordering::Release);
        assert!(restart_view(&state, &inner).is_err());
    }
    #[test]
    fn initial_sync_waits_for_blank_but_never_authorizes_it_or_an_external_page() {
        assert!(!initial_sync_ready(&url::Url::parse("about:blank").unwrap()).unwrap());
        for raw in ["tauri://localhost/index.html?window=ai-ball", "http://tauri.localhost/?window=ai-ball"] {
            assert!(initial_sync_ready(&url::Url::parse(raw).unwrap()).unwrap());
        }
        for raw in ["https://evil.invalid/?window=ai-ball", "http://tauri.localhost/?window=main"] {
            assert!(initial_sync_ready(&url::Url::parse(raw).unwrap()).is_err());
        }
    }
    #[test]
    fn normal_ball_commands_preserve_the_existing_argument_contract() {
        assert!(matches!(Command::parse("ai:ball:expand", &[json!(true)]).unwrap(), Some(Command::Expand(true))));
        assert!(matches!(Command::parse("ai:ball:move", &[json!(12),json!(34),json!(true)]).unwrap(), Some(Command::Move(Point { x:12.0,y:34.0 },true))));
        assert!(Command::parse("app:version", &[]).unwrap().is_none());
    }
}

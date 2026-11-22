//! 共享 AI / 歌词 HUD：UI 只执行短 native 操作，销毁回执与双 manager 表释放后才允许重建。
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewWindow};

mod lifecycle;
use lifecycle::{Action, Desired, Model, Registry};

const LABEL: &str = "ai-hud";
const ENTRY: &str = "index.html?window=ai-hud";
type Result<T> = std::result::Result<T, String>;

#[derive(Default)]
struct Signals { destroyed: AtomicBool, close_requested: AtomicBool }
struct Binding { id: u64, stamp: Option<String>, window: WebviewWindow, signals: Arc<Signals> }
#[derive(Default)]
struct Inner {
    pending: bool,
    busy: bool,
    retry_scheduled: bool,
    model: Model,
    binding: Option<Binding>,
    // destroy 入队后仍是进行中的清理；超时不 finish，也不丢弃为不可恢复的 Gate 污染。
    lease: Option<crate::lifecycle::Request>,
    unsupported: Option<String>,
}
struct State { closed: AtomicBool, interactive: AtomicBool, pointer_pending: AtomicBool, multiplayer_pending: AtomicBool, started: Instant, inner: Mutex<Inner> }
impl Default for State {
    fn default() -> Self { Self { closed: AtomicBool::new(false), interactive: AtomicBool::new(false), pointer_pending: AtomicBool::new(false), multiplayer_pending: AtomicBool::new(false), started: Instant::now(), inner: Mutex::new(Inner::default()) } }
}
impl State {
    fn now(&self) -> u64 { self.started.elapsed().as_millis().min(u64::MAX as u128) as u64 }
}
fn unavailable() -> String { "AI 悬浮窗状态不可用 / AI 懸浮視窗狀態無法使用 / AI HUD state unavailable".into() }

fn allowed_url(label: &str, url: &url::Url) -> bool {
    if label != LABEL || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() { return false; }
    let bundled = url.port().is_none()
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost")));
    let development = cfg!(debug_assertions) && url.scheme() == "http"
        && matches!(url.host_str(), Some("localhost") | Some("127.0.0.1")) && url.port() == Some(1420);
    (bundled || development) && matches!(url.path(), "/" | "/index.html") && url.query() == Some("window=ai-hud")
}
pub(crate) fn authorize_snapshot_read(window: &WebviewWindow) -> Result<()> {
    let url = window.url().map_err(|_| unavailable())?;
    if allowed_url(window.label(), &url) { Ok(()) }
    else { Err("AI 悬浮窗来源无权读取 / AI 懸浮窗來源無權讀取 / AI HUD origin is not authorized".into()) }
}
pub(crate) fn init(app: &AppHandle) { let _ = app.manage(Arc::new(State::default())); }

/// 仅在短 UI 回合核验真实实例；label 或相同 URL 本身不能授权录音后的业务调用。
#[cfg(windows)]
fn voice_target_on_ui(app: &AppHandle, allow_inactive: bool) -> Result<Option<WebviewWindow>> {
    let state = app.try_state::<Arc<State>>().ok_or_else(unavailable)?;
    let expected = {
        let inner = state.inner.lock().map_err(|_| unavailable())?;
        if state.closed.load(Ordering::Acquire) && !allow_inactive { return Err(unavailable()); }
        let Some(binding) = &inner.binding else {
            if inner.model.busy_resource() || inner.model.uncertain() { return Err(unavailable()); }
            drop(inner);
            if app.get_window(LABEL).is_some() || app.get_webview(LABEL).is_some() { return Err(unavailable()); }
            return Ok(None);
        };
        if ((!allow_inactive && inner.model.closing()) || inner.model.uncertain() || inner.unsupported.is_some())
            || binding.signals.destroyed.load(Ordering::Acquire) || (!allow_inactive && binding.signals.close_requested.load(Ordering::Acquire)) {
            return Err(unavailable());
        }
        (binding.id, binding.stamp.clone().ok_or_else(unavailable)?, binding.window.clone())
    };
    if app.get_window(LABEL).is_none() || app.get_webview(LABEL).is_none() { return Err(unavailable()); }
    let current = app.get_webview_window(LABEL).ok_or_else(unavailable)?;
    if stamp(&current)? != expected.1 || stamp(&expected.2)? != expected.1 { return Err(unavailable()); }
    authorize_snapshot_read(&current)?;
    if !allow_inactive && (!crate::ai_hud::view(app)?.snapshot.get("enabled").and_then(serde_json::Value::as_bool).unwrap_or(false)
        || !current.is_visible().map_err(|_| unavailable())?) { return Ok(None); }
    let inner = state.inner.lock().map_err(|_| unavailable())?;
    if ((!allow_inactive && (state.closed.load(Ordering::Acquire) || inner.model.closing())) || inner.model.uncertain())
        || !inner.binding.as_ref().is_some_and(|binding| binding.id == expected.0
            && binding.stamp.as_ref() == Some(&expected.1) && !binding.signals.destroyed.load(Ordering::Acquire)
            && (allow_inactive || !binding.signals.close_requested.load(Ordering::Acquire))) { return Err(unavailable()); }
    Ok(Some(current))
}

pub(crate) async fn authorize_voice(app: &AppHandle, window: &WebviewWindow, snapshot_only: bool) -> Result<()> {
    #[cfg(not(windows))]
    { let _ = (app, window, snapshot_only); Err(unavailable()) }
    #[cfg(windows)]
    {
        let handle = app.clone(); let window = window.clone();
        run_on_ui(app, move || {
            authorize_snapshot_read(&window)?;
            // 新建的隐藏 HUD 也能读取开关快照；实际录音业务仍须活动可见实例。
            let owned = voice_target_on_ui(&handle, snapshot_only)?.ok_or_else(unavailable)?;
            if stamp(&window)? == stamp(&owned)? { Ok(()) } else { Err(unavailable()) }
        }).await
    }
}
/// None 是切换命令，Some 是开关快照。调用方已在 UI 回合，不在 with_webview 回调内重入。
pub(crate) fn voice_event_on_ui(app: &AppHandle, enabled: Option<bool>) -> Result<bool> {
    #[cfg(not(windows))]
    { let _ = (app, enabled); Ok(false) }
    #[cfg(windows)]
    {
        use tauri::Emitter;
        let Some(_) = voice_target_on_ui(app, enabled.is_some())? else { return Ok(false); };
        let (channel, payload) = match enabled {
            Some(enabled) => ("ai:voiceState", serde_json::Value::Bool(enabled)),
            None => ("ai:voiceToggle", serde_json::Value::Null),
        };
        app.emit_to(LABEL, "launcher:event", serde_json::json!({"channel":channel,"payload":payload})).map_err(|_| unavailable())?;
        Ok(true)
    }
}

/// 歌词沿用同一扇窗，但不借用 AI 语音开关；命令只可作用于活动的精确自有实例。
#[cfg(windows)]
fn lyrics_target_on_ui(app: &AppHandle, snapshot_only: bool) -> Result<Option<WebviewWindow>> {
    let Some(window) = voice_target_on_ui(app, true)? else { return Ok(None); };
    if snapshot_only { return Ok(Some(window)); }
    let state = app.try_state::<Arc<State>>().ok_or_else(unavailable)?;
    let expected = stamp(&window)?;
    if !crate::lyrics::view(app)?.wanted || !window.is_visible().map_err(|_| unavailable())? { return Ok(None); }
    let inner = state.inner.lock().map_err(|_| unavailable())?;
    if state.closed.load(Ordering::Acquire) || inner.model.closing() || inner.model.uncertain()
        || !inner.binding.as_ref().is_some_and(|b| b.stamp.as_ref() == Some(&expected)
            && !b.signals.destroyed.load(Ordering::Acquire) && !b.signals.close_requested.load(Ordering::Acquire)) { return Err(unavailable()); }
    Ok(Some(window))
}
pub(crate) async fn authorize_lyrics(app: &AppHandle, window: &WebviewWindow, snapshot_only: bool) -> Result<()> {
    #[cfg(not(windows))]
    { let _ = (app, window, snapshot_only); Err(unavailable()) }
    #[cfg(windows)]
    {
        let handle = app.clone(); let window = window.clone();
        run_on_ui(app, move || {
            authorize_snapshot_read(&window)?;
            let owned = lyrics_target_on_ui(&handle, snapshot_only)?.ok_or_else(unavailable)?;
            if stamp(&window)? == stamp(&owned)? { Ok(()) } else { Err(unavailable()) }
        }).await
    }
}
/// 联机 HUD 只增加固定无参数投影读取，不授予大厅、聊天或文件权限。
pub(crate) async fn authorize_multiplayer(app: &AppHandle, window: &WebviewWindow) -> Result<()> {
    #[cfg(not(windows))]
    { let _ = (app, window); Err(unavailable()) }
    #[cfg(windows)]
    {
        let handle=app.clone(); let window=window.clone();
        run_on_ui(app, move || {
            authorize_snapshot_read(&window)?;
            let owned=voice_target_on_ui(&handle,true)?.ok_or_else(unavailable)?;
            if stamp(&window)?==stamp(&owned)? { Ok(()) } else { Err(unavailable()) }
        }).await
    }
}
/// 任意数量成员更新最多排一个短 UI 回合；回合内读取最新投影，不捕获旧代次成员数据。
pub(crate) fn publish_multiplayer(app: &AppHandle) {
    #[cfg(windows)]
    if let Some(state)=app.try_state::<Arc<State>>().map(|s|s.inner().clone()) {
        if state.multiplayer_pending.swap(true,Ordering::AcqRel) { return; }
        let handle=app.clone(); let pending=state.clone();
        if app.run_on_main_thread(move || {
            pending.multiplayer_pending.store(false,Ordering::Release);
            let _=(||->Result<()> {
                use tauri::Emitter;
                let Some(_)=voice_target_on_ui(&handle,true)? else { return Ok(()); };
                let view=crate::multiplayer::hud_view(&handle)?;
                handle.emit_to(LABEL,"launcher:event",serde_json::json!({"channel":"mp:hudState","payload":view.snapshot})).map_err(|_|unavailable())
            })();
        }).is_err() { state.multiplayer_pending.store(false,Ordering::Release); }
    }
    #[cfg(not(windows))]
    { let _=app; }
}
pub(crate) async fn set_interactive(app: &AppHandle, window: &WebviewWindow, args: &[serde_json::Value]) -> Result<()> {
    if args.len() != 1 { return Err(unavailable()); }
    let over = args[0].as_bool().ok_or_else(unavailable)?;
    #[cfg(not(windows))]
    { let _ = (app, window, over); Err(unavailable()) }
    #[cfg(windows)]
    {
        let handle = app.clone(); let window = window.clone();
        run_on_ui(app, move || {
            authorize_snapshot_read(&window)?;
            let owned = lyrics_target_on_ui(&handle, !over)?.ok_or_else(unavailable)?;
            if stamp(&window)? != stamp(&owned)? { return Err(unavailable()); }
            let state = handle.try_state::<Arc<State>>().ok_or_else(unavailable)?;
            let view = crate::lyrics::view(&handle)?;
            let over = over && view.wanted && view.snapshot["status"] == "sync";
            owned.set_ignore_cursor_events(!over).map_err(|_| unavailable())?;
            state.interactive.store(over, Ordering::Release);
            Ok(())
        }).await
    }
}
/// 穿透时 WebView2 不提供 Electron 的 forward mousemove；只读取当前鼠标点并在本页命中测试。
/// 一个回调尚未完成时不再排队，不执行外部脚本，也不记录鼠标轨迹。
pub(crate) fn poll_lyrics_pointer(app: &AppHandle) {
    #[cfg(windows)]
    {
        let Some(state) = app.try_state::<Arc<State>>().map(|s| s.inner().clone()) else { return; };
        if state.closed.load(Ordering::Acquire) || state.pointer_pending.swap(true, Ordering::AcqRel) { return; }
        let handle = app.clone(); let pending = state.clone();
        if app.run_on_main_thread(move || {
            let state = pending.clone();
            struct Pending(Arc<State>);
            impl Drop for Pending { fn drop(&mut self) { self.0.pointer_pending.store(false, Ordering::Release); } }
            let _pending = Pending(pending);
            let _ = (|| -> Result<()> {
                let Some(window) = lyrics_target_on_ui(&handle, false)? else { return Ok(()); };
                if crate::lyrics::view(&handle)?.snapshot["status"] != "sync" {
                    window.set_ignore_cursor_events(true).map_err(|_| unavailable())?;
                    state.interactive.store(false, Ordering::Release); return Ok(());
                }
                let point = window.cursor_position().map_err(|_| unavailable())?;
                let origin = window.inner_position().map_err(|_| unavailable())?;
                let scale = window.scale_factor().map_err(|_| unavailable())?;
                if !scale.is_finite() || scale <= 0.0 { return Err(unavailable()); }
                let x = (point.x - origin.x as f64) / scale; let y = (point.y - origin.y as f64) / scale;
                if !x.is_finite() || !y.is_finite() { return Err(unavailable()); }
                let detail = serde_json::json!({"detail":{"x":x,"y":y}});
                window.eval(&format!("window.dispatchEvent(new CustomEvent('hc:lyrics-pointer',{}));", detail)).map_err(|_| unavailable())
            })();
        }).is_err() { state.pointer_pending.store(false, Ordering::Release); }
    }
    #[cfg(not(windows))]
    { let _ = app; }
}

fn mark_request(state: &State, terminal: bool) -> bool {
    let Ok(mut inner) = state.inner.lock() else { return false; };
    if terminal { inner.model.terminate(); }
    else {
        if state.closed.load(Ordering::Acquire) { return false; }
        inner.model.request();
    }
    inner.pending = true;
    if inner.busy { false } else { inner.busy = true; true }
}
fn wake_instance(app: &AppHandle, id: u64) {
    let handle = app.clone();
    // 事件栈只写原子标志并排后台通知；不在 manager 的 Destroyed/close 回调里拿宿主锁或等待 UI。
    tauri::async_runtime::spawn(async move {
        let Some(state) = handle.try_state::<Arc<State>>().map(|s| s.inner().clone()) else { return; };
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
fn schedule_retry(app: &AppHandle, state: &Arc<State>) {
    let schedule = match state.inner.lock() {
        Ok(mut inner) if inner.pending && !inner.busy && !inner.retry_scheduled => { inner.retry_scheduled = true; true }
        _ => false,
    };
    if !schedule { return; }
    let handle = app.clone(); let state = state.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let start = match state.inner.lock() {
            Ok(mut inner) => {
                inner.retry_scheduled = false;
                if inner.pending && !inner.busy { inner.busy = true; true } else { false }
            }
            _ => false,
        };
        if start { spawn_worker(&handle, state); }
    });
}
fn spawn_worker(app: &AppHandle, state: Arc<State>) {
    let handle = app.clone(); let monitor = handle.clone(); let monitored = state.clone();
    let task = tauri::async_runtime::spawn(async move { worker(&handle, &state).await; });
    tauri::async_runtime::spawn(async move {
        if task.await.is_err() {
            // 不把后台 panic 当作 native 已回收；保留 lease，只有精确回执可收尾。
            let retry = if let Ok(mut inner) = monitored.inner.lock() {
                inner.model.fault(); inner.unsupported = Some(unavailable()); inner.busy = false;
                if inner.binding.is_some() { inner.pending = true; true } else { false }
            } else { false };
            if retry { schedule_retry(&monitor, &monitored); }
        }
    });
}
pub(crate) fn request_sync(app: &AppHandle) {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    { let _ = app; }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if let Some(state) = app.try_state::<Arc<State>>() {
        if mark_request(state.inner(), false) { spawn_worker(app, state.inner().clone()); }
    }
}
pub(crate) fn close(app: &AppHandle) {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    { let _ = app; }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if let Some(state) = app.try_state::<Arc<State>>() {
        state.closed.store(true, Ordering::Release);
        // terminate() 是幂等的；重复退出仅再次核验回执，不开放显示或重置销毁次数。
        if mark_request(state.inner(), true) { spawn_worker(app, state.inner().clone()); }
    }
}
/// 退出方必须在调用 app.exit 之前 await；close() 本身仍只是终止请求。
/// 不在主线程用 block_on/recv 等此 future；超时返回未确认，调用方决定保持进程还是强制退出。
pub(crate) async fn shutdown(app: &AppHandle) -> Result<()> {
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    { close(app); return Ok(()); }
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        close(app);
        let Some(state) = app.try_state::<Arc<State>>().map(|s| s.inner().clone()) else { return Ok(()); };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
        loop {
            let ready = {
                let inner = state.inner.lock().map_err(|_| unavailable())?;
                inner.model.terminal() && !inner.model.busy_resource() && inner.binding.is_none()
                    && !inner.busy && !inner.pending && !inner.model.uncertain() && inner.lease.is_none()
            };
            if ready {
                let handle = app.clone();
                // 不在 Destroyed listener 栈内宣布 Gone；等待一次独立 UI 回合检查两张 manager 表。
                let check = run_on_ui(app, move || Ok(handle.get_window(LABEL).is_none() && handle.get_webview(LABEL).is_none()));
                if tokio::time::timeout_at(deadline, check).await.map_err(|_| unavailable())?? {
                    return Ok(());
                }
            }
            if tokio::time::Instant::now() >= deadline { return Err(unavailable()); }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}
pub(crate) fn relaunch_ready(app: &AppHandle) -> Result<()> {
    let Some(state) = app.try_state::<Arc<State>>() else { return Ok(()); };
    let inner = state.inner.try_lock().map_err(|_| unavailable())?;
    if state.closed.load(Ordering::Acquire) || inner.busy || inner.pending || inner.model.busy_resource() || inner.lease.is_some() {
        Err(unavailable())
    } else { Ok(()) }
}

async fn run_on_ui<T: Send + 'static>(app: &AppHandle, callback: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || { let _ = send.send(callback()); }).map_err(|_| unavailable())?;
    receive.await.map_err(|_| unavailable())?
}
#[derive(Clone, Copy)]
enum Step { Again, Wait, Idle, Retained }
fn finish_lease(inner: &mut Inner) {
    if let Some(lease) = inner.lease.take() { lease.finish(); }
}
async fn worker(app: &AppHandle, state: &Arc<State>) {
    loop {
        {
            let Ok(mut inner) = state.inner.lock() else { return; };
            if !inner.pending { inner.busy = false; return; }
            inner.pending = false;
        }
        let needs_lease = state.inner.lock().map(|i| i.lease.is_none()).unwrap_or(false);
        if needs_lease && !state.closed.load(Ordering::Acquire) {
            let admission = app.try_state::<crate::lifecycle::Gate>().map(|gate| gate.enter_classified());
            match admission {
                Some(Ok(lease)) => {
                    let Ok(mut inner) = state.inner.lock() else { return; };
                    inner.lease = Some(lease);
                }
                Some(Err(crate::lifecycle::EnterFailure::Closed)) => {
                    state.closed.store(true, Ordering::Release);
                    if let Ok(mut inner) = state.inner.lock() { inner.model.terminate(); }
                }
                Some(Err(crate::lifecycle::EnterFailure::Restarting)) => {
                    if let Ok(mut inner) = state.inner.lock() { inner.pending = true; inner.busy = false; }
                    schedule_retry(app, state); return;
                }
                _ => {
                    if let Ok(mut inner) = state.inner.lock() { inner.unsupported = Some(unavailable()); inner.busy = false; }
                    return;
                }
            }
        }
        let handle = app.clone(); let ui_state = state.clone();
        let step = run_on_ui(app, move || sync_window_on_ui(&handle, ui_state)).await;
        let mut retry = false;
        let mut again = false;
        if let Ok(mut inner) = state.inner.lock() {
            match step {
                Ok(Step::Again) => { inner.pending = true; again = true; }
                Ok(Step::Wait) => { inner.pending = true; inner.busy = false; retry = true; }
                Ok(Step::Idle) => {
                    finish_lease(&mut inner);
                    if inner.pending { again = true; } else { inner.busy = false; }
                }
                Ok(Step::Retained) => {
                    inner.unsupported = Some(unavailable());
                    if inner.pending { again = true; } else { inner.busy = false; }
                }
                Err(error) => {
                    inner.unsupported = Some(error);
                    if let Some(id) = inner.model.instance() {
                        if inner.binding.is_some() { inner.model.native_failed(id, state.now()); inner.pending = true; again = true; }
                        else { inner.model.creation_failed(id); inner.busy = false; }
                    } else {
                        // 尚未触及 native 的 view/platform 失败可以正常结束，但不伪造显示成功。
                        finish_lease(&mut inner);
                        if inner.pending { again = true; } else { inner.busy = false; }
                    }
                }
            }
        }
        if retry { schedule_retry(app, state); }
        if !again { return; }
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn stamp(window: &WebviewWindow) -> Result<String> {
    use raw_window_handle::HasWindowHandle;
    Ok(format!("{:?}", window.window_handle().map_err(|_| unavailable())?.as_raw()))
}
// 必须在 UI 上核验两张表；Window/WebviewWindow 的 PartialEq 只比 label，不能证明实例身份。
#[cfg(any(target_os = "windows", target_os = "linux"))]
fn registry(app: &AppHandle, binding: Option<&(u64, Option<String>, Arc<Signals>)>) -> Registry {
    let native = app.get_window(LABEL).is_some();
    let webview = app.get_webview(LABEL).is_some();
    let destroyed = binding.is_some_and(|(_, _, signals)| signals.destroyed.load(Ordering::Acquire));
    // 已回执或标签未成对时不访问失效 native 句柄；identity=None 绝不当作匹配。
    let identity = if native && webview && !destroyed {
        binding.and_then(|(_, expected_stamp, _)| expected_stamp.as_ref())
            .zip(app.get_webview_window(LABEL).and_then(|w| stamp(&w).ok()))
            .map(|(expected, current)| expected == &current)
    } else { None };
    Registry::observe(native, webview, binding.is_some(), destroyed, identity)
}
fn desired(app: &AppHandle, closed: bool) -> Result<Desired> {
    if closed { return Ok(Desired { enabled: false, revision: 0, language: "zh-CN".into() }); }
    let view = crate::ai_hud::view(app)?;
    let lyrics = crate::lyrics::view(app)?;
    let multiplayer = crate::multiplayer::hud_view(app)?;
    if !matches!(view.language.as_str(), "zh-CN" | "zh-TW" | "en") { return Err(unavailable()); }
    Ok(Desired { enabled: view.snapshot.get("enabled").and_then(|v| v.as_bool()).ok_or_else(unavailable)? || lyrics.wanted
            || multiplayer.snapshot.get("enabled").and_then(|v|v.as_bool()).ok_or_else(unavailable)?,
        revision: view.revision.wrapping_add(lyrics.revision).wrapping_add(multiplayer.revision), language: if lyrics.wanted { lyrics.language } else { view.language } })
}
#[cfg(any(target_os = "windows", target_os = "linux"))]
fn window_bounds(app: &AppHandle) -> Result<(tauri::PhysicalSize<u32>, tauri::PhysicalPosition<i32>)> {
    let main = app.get_webview_window("main").ok_or_else(unavailable)?;
    let monitor = main.primary_monitor().map_err(|_| unavailable())?.ok_or_else(unavailable)?;
    let area = monitor.work_area(); let scale = monitor.scale_factor();
    if !scale.is_finite() || scale <= 0.0 { return Err(unavailable()); }
    let wide = crate::lyrics::view(app)?.wanted;
    let (logical_w, logical_h) = if wide { (460.0, 420.0) } else { (360.0, 300.0) };
    let width = (logical_w * scale).round().clamp(1.0, area.size.width.max(1) as f64) as u32;
    let height = (logical_h * scale).round().clamp(1.0, area.size.height.max(1) as f64) as u32;
    let margin = (20.0 * scale).round() as i64;
    let x = area.position.x as i64 + (area.size.width as i64 - width as i64 - margin).max(0);
    let y = area.position.y as i64 + margin.min((area.size.height as i64 - height as i64).max(0));
    Ok((tauri::PhysicalSize::new(width, height), tauri::PhysicalPosition::new(x.clamp(i32::MIN as i64,i32::MAX as i64) as i32, y.clamp(i32::MIN as i64,i32::MAX as i64) as i32)))
}
#[cfg(any(target_os = "windows", target_os = "linux"))]
fn sync_window_on_ui(app: &AppHandle, state: Arc<State>) -> Result<Step> {
    let closed = state.closed.load(Ordering::Acquire);
    let latest = desired(app, closed);
    let (action, latest) = {
        let mut inner = state.inner.lock().map_err(|_| unavailable())?;
        if closed { inner.model.terminate(); }
        if let Some(binding) = &inner.binding {
            let id = binding.id; let destroyed = binding.signals.destroyed.load(Ordering::Acquire);
            let close_requested = binding.signals.close_requested.load(Ordering::Acquire);
            if destroyed { inner.model.destroyed(id, state.now()); }
            else if close_requested { inner.model.begin_close(id, state.now()); }
        }
        let latest = match latest {
            Ok(view) => view,
            Err(error) if inner.model.closing() => { inner.unsupported = Some(error); Desired { enabled: false, revision: 0, language: "zh-CN".into() } }
            Err(error) => return Err(error),
        };
        // registry 只读取 manager/原生身份，不能在持状态锁时调用可重入 native getter。
        let observation = inner.binding.as_ref().map(|b| (b.id, b.stamp.clone(), b.signals.clone()));
        drop(inner);
        let observed = registry(app, observation.as_ref());
        let mut inner = state.inner.lock().map_err(|_| unavailable())?;
        if inner.binding.as_ref().map(|b| b.id) != observation.map(|b| b.0) { return Ok(Step::Again); }
        (inner.model.plan(&latest, observed, state.now()), latest)
    };
    match action {
        Action::Idle => Ok(Step::Idle),
        Action::Retained => Ok(Step::Retained),
        Action::Wait => Ok(Step::Wait),
        Action::Released(id) => {
            let mut inner = state.inner.lock().map_err(|_| unavailable())?;
            if inner.binding.as_ref().is_some_and(|b| b.id == id) { inner.binding = None; }
            inner.unsupported = None; finish_lease(&mut inner);
            // 下一次 UI 请求重新读取 view；不复用语言切换前的 Desired。
            Ok(Step::Again)
        }
        Action::Destroy { id } => {
            let window = {
                let inner = state.inner.lock().map_err(|_| unavailable())?;
                let binding = inner.binding.as_ref().filter(|b| b.id == id && !b.signals.destroyed.load(Ordering::Acquire)).ok_or_else(unavailable)?;
                binding.window.clone()
            };
            // 不持状态锁调用 native；成功仅表示入队。后续必须收到该实例 Destroyed 且双表均空。
            if window.destroy().is_err() {
                let mut inner = state.inner.lock().map_err(|_| unavailable())?;
                inner.model.queue_failed(id); inner.unsupported = Some(unavailable());
            }
            Ok(Step::Wait)
        }
        Action::Create { id, generation } => create_window(app, &state, id, generation, &latest),
        Action::Show { id, generation } => show_window(app, &state, id, generation, &latest),
    }
}
#[cfg(any(target_os = "windows", target_os = "linux"))]
fn create_window(app: &AppHandle, state: &Arc<State>, id: u64, generation: u64, latest: &Desired) -> Result<Step> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let (size, position) = match window_bounds(app) {
        Ok(value) => value,
        Err(error) => {
            state.inner.lock().map_err(|_| unavailable())?.model.cancel_creation(id);
            return Err(error);
        }
    };
    let current = desired(app, state.closed.load(Ordering::Acquire));
    {
        let mut inner = state.inner.lock().map_err(|_| unavailable())?;
        match current {
            Err(error) => { inner.model.cancel_creation(id); return Err(error); }
            Ok(current) if state.closed.load(Ordering::Acquire) || !inner.model.can_create(id, generation)
                || !current.enabled || current.revision != latest.revision || current.language != latest.language => {
                inner.model.defer_creation(id); return Ok(Step::Again);
            }
            _ => {}
        }
    }
    let language = latest.language.clone();
    let script = format!("window.__HC_AI_HUD_LOCALE__ = {};", serde_json::to_string(&language).map_err(|_| unavailable())?);
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(ENTRY.into()))
        .inner_size(360.0, 300.0)
        .decorations(false).transparent(true).visible(false).focused(false).focusable(false).devtools(false)
        .always_on_top(true).skip_taskbar(true).resizable(false).shadow(false).initialization_script(&script)
        .on_navigation(|url| allowed_url(LABEL, url))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build().map_err(|_| unavailable())?;
    let signals = Arc::new(Signals::default()); let callback_signals = signals.clone(); let callback_app = app.clone();
    window.on_window_event(move |event| {
        match event {
            tauri::WindowEvent::Destroyed => { callback_signals.destroyed.store(true, Ordering::Release); }
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close(); callback_signals.close_requested.store(true, Ordering::Release);
            }
            _ => return,
        }
        wake_instance(&callback_app, id);
    });
    let native_stamp = stamp(&window);
    {
        let mut inner = state.inner.lock().map_err(|_| unavailable())?;
        // 句柄读取失败也保留 builder 返回的确切 dispatcher，不能遗失已经创建的窗口。
        inner.binding = Some(Binding { id, stamp: native_stamp.as_ref().ok().cloned(), window, signals });
        if !inner.model.created(id, language) { return Err(unavailable()); }
    }
    native_stamp?;
    // 创建时先登记确切 dispatcher，再施加主屏物理尺寸，避免多屏不同 DPI 使用错误缩放。
    let created = state.inner.lock().map_err(|_| unavailable())?.binding.as_ref().filter(|b| b.id == id).map(|b| b.window.clone()).ok_or_else(unavailable)?;
    created.set_size(size).map_err(|_| unavailable())?;
    created.set_position(position).map_err(|_| unavailable())?;
    // 即使创建期间 desired/close 变化，也先登记这一个真实实例，再由同一生产状态机精确清理。
    show_window(app, state, id, generation, latest)
}
#[cfg(any(target_os = "windows", target_os = "linux"))]
fn show_window(app: &AppHandle, state: &Arc<State>, id: u64, generation: u64, expected: &Desired) -> Result<Step> {
    let current = desired(app, state.closed.load(Ordering::Acquire))?;
    let window = {
        let mut inner = state.inner.lock().map_err(|_| unavailable())?;
        if !inner.model.can_show(id, generation) || !current.enabled || current.revision != expected.revision || current.language != expected.language {
            inner.model.request(); return Ok(Step::Again);
        }
        let binding = inner.binding.as_ref().filter(|b| b.id == id && !b.signals.destroyed.load(Ordering::Acquire) && !b.signals.close_requested.load(Ordering::Acquire)).ok_or_else(unavailable)?;
        binding.window.clone()
    };
    window.set_focusable(false).map_err(|_| unavailable())?;
    window.set_always_on_top(true).map_err(|_| unavailable())?;
    window.set_skip_taskbar(true).map_err(|_| unavailable())?;
    let (size, position) = window_bounds(app)?;
    if window.inner_size().map_err(|_| unavailable())? != size {
        window.set_size(size).map_err(|_| unavailable())?;
        window.set_position(position).map_err(|_| unavailable())?;
    }
    if !crate::lyrics::view(app)?.wanted { state.interactive.store(false, Ordering::Release); }
    window.set_ignore_cursor_events(!state.interactive.load(Ordering::Acquire)).map_err(|_| unavailable())?;
    // 每个 native 调用都可能重入；show 前再次检查终止/实例，之后再核对最新 revision。
    let before_show = desired(app, state.closed.load(Ordering::Acquire))?;
    {
        let mut inner = state.inner.lock().map_err(|_| unavailable())?;
        let bound = inner.binding.as_ref().is_some_and(|b| b.id == id
            && !b.signals.destroyed.load(Ordering::Acquire) && !b.signals.close_requested.load(Ordering::Acquire));
        if state.closed.load(Ordering::Acquire) || !bound || !inner.model.can_show(id, generation)
            || !before_show.enabled || before_show.revision != expected.revision || before_show.language != expected.language {
            inner.model.request(); return Ok(Step::Again);
        }
    }
    window.show().map_err(|_| unavailable())?;
    let latest = desired(app, state.closed.load(Ordering::Acquire))?;
    let mut inner = state.inner.lock().map_err(|_| unavailable())?;
    if !inner.model.can_show(id, generation) || !latest.enabled || latest.revision != expected.revision || latest.language != expected.language {
        inner.model.request(); return Ok(Step::Again);
    }
    inner.unsupported = None; Ok(Step::Idle)
}
#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn sync_window_on_ui(_app: &AppHandle, _state: Arc<State>) -> Result<Step> { Err(unavailable()) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_origin_label_and_query_only() {
        assert!(allowed_url(LABEL, &url::Url::parse("tauri://localhost/index.html?window=ai-hud").unwrap()));
        for raw in ["tauri://localhost/index.html?window=ai-hud&x=1", "tauri://localhost/index.html?window=ai-hud#x", "tauri://user@localhost/index.html?window=ai-hud", "tauri://localhost:123/index.html?window=ai-hud", "tauri://localhost/other?window=ai-hud", "https://evil.invalid/index.html?window=ai-hud"] {
            assert!(!allowed_url(LABEL, &url::Url::parse(raw).unwrap()));
        }
        assert!(!allowed_url("main", &url::Url::parse("tauri://localhost/index.html?window=ai-hud").unwrap()));
    }
    #[test]
    fn queued_cleanup_lease_blocks_restart_until_confirmed_release() {
        let gate = crate::lifecycle::Gate::default(); let mut inner = Inner::default();
        let visible = Desired { enabled: true, revision: 1, language: "en".into() };
        inner.model.request();
        let Action::Create { id, .. } = inner.model.plan(&visible, Registry::Empty, 0) else { panic!() };
        assert!(inner.model.created(id, "en".into()));
        inner.lease = Some(gate.enter().unwrap()); inner.model.terminate();
        assert_eq!(inner.model.plan(&visible, Registry::Owned, 1), Action::Destroy { id });
        assert!(gate.begin_restart().is_err());
        assert!(inner.model.destroyed(id, 2));
        assert_eq!(inner.model.plan(&visible, Registry::Owned, 2), Action::Wait);
        assert!(gate.begin_restart().is_err());
        assert_eq!(inner.model.plan(&visible, Registry::Empty, 3), Action::Released(id));
        // 与生产 Released 分支相同，只有回执且双表空才能完成 cleanup lease。
        finish_lease(&mut inner); assert!(gate.begin_restart().is_ok());
    }
    #[test]
    fn terminal_close_and_unknown_do_not_grant_relaunch() {
        let state = State::default(); assert!(mark_request(&state, false));
        state.closed.store(true, Ordering::Release); assert!(!mark_request(&state, false));
        assert!(!mark_request(&state, true));
        let inner = state.inner.lock().unwrap(); assert!(inner.model.terminal());
    }
}
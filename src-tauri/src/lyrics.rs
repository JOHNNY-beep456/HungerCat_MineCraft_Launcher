//! 网易云歌词域：只在原有两个 HUD 开关开启且非本地模式时读取系统公开媒体会话。
//! 后台网络和 SMTC 各有一个所有者；退出等待真实收尾，不在 UI 上等待 COM、存储或网络。
mod model;
mod network;
#[cfg(windows)]
mod native;
use model::{Model, Outcome, Preferences, Request, Session};
use serde_json::{json, Value};
use std::{future::Future, pin::Pin, sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Emitter, Manager};
type Result<T> = std::result::Result<T, String>;
#[derive(Default)]
struct Control { wanted: AtomicBool, closed: AtomicBool, revision: AtomicU64 }
impl Control {
    fn current(&self, revision: u64) -> bool { !self.closed.load(Ordering::Acquire) && self.wanted.load(Ordering::Acquire) && self.revision.load(Ordering::Acquire) == revision }
}
#[derive(Default)]
struct Inner { model: Model, pending: Option<Request> }
struct State {
    control: Arc<Control>, inner: Mutex<Inner>, refresh: Mutex<()>, delivery: Mutex<u64>, notify: tokio::sync::Notify,
    done: tokio::sync::watch::Sender<bool>,
    #[cfg(windows)]
    worker: Mutex<Option<native::Worker>>,
}
impl Default for State {
    fn default() -> Self { Self { control: Arc::new(Control::default()), inner: Mutex::new(Inner::default()), refresh: Mutex::new(()), delivery: Mutex::new(0), notify: tokio::sync::Notify::new(), done: tokio::sync::watch::channel(false).0, #[cfg(windows)] worker: Mutex::new(None) } }
}
#[derive(Clone)]
pub(crate) struct View { pub(crate) snapshot: Value, pub(crate) wanted: bool, pub(crate) language: String, pub(crate) opacity: f64, pub(crate) revision: u64 }
fn unavailable() -> String { "歌词服务状态不可用 / 歌詞服務狀態無法使用 / Lyrics service state unavailable".into() }
fn state(app: &AppHandle) -> Result<Arc<State>> { app.try_state::<Arc<State>>().map(|s| s.inner().clone()).ok_or_else(unavailable) }
fn now() -> f64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64() * 1000.0 }
fn projection(inner: &Inner) -> Result<View> {
    Ok(View { snapshot: serde_json::to_value(&inner.model.snapshot).map_err(|_| unavailable())?, wanted: inner.model.preferences.wanted, language: inner.model.preferences.language.clone(), opacity: inner.model.preferences.opacity, revision: inner.model.revision })
}
pub(crate) fn view(app: &AppHandle) -> Result<View> { let state = state(app)?; let inner = state.inner.lock().map_err(|_| unavailable())?; projection(&inner) }
fn publish(app: &AppHandle, state: &State) {
    let Ok(inner) = state.inner.lock() else { return; }; let Ok(view) = projection(&inner) else { return; }; drop(inner);
    let Ok(mut delivered) = state.delivery.lock() else { return; };
    if view.revision <= *delivered { return; }
    let payload = json!({"channel":"music:lyricsState","payload":view.snapshot});
    let _ = app.emit_to("main", "launcher:event", payload.clone()); let _ = app.emit_to("ai-hud", "launcher:event", payload);
    *delivered = view.revision; drop(delivered);
    crate::ai_hud_window::request_sync(app);
}
fn desired(settings: &Value) -> Preferences {
    let language = match settings["language"].as_str() { Some("en") => "en", Some("zh-TW") => "zh-TW", _ => "zh-CN" };
    let opacity = settings["hudOpacity"].as_f64().filter(|n| n.is_finite() && (0.0..=1.0).contains(n)).unwrap_or(0.8);
    Preferences { wanted: cfg!(windows) && settings["hudEnabled"] == true && settings["hudShowLyrics"] == true && settings["mode"].as_str().is_some_and(|mode| mode != "local"), language: language.into(), opacity }
}
pub(crate) fn init(app: &AppHandle) {
    let state = Arc::new(State::default()); if !app.manage(state.clone()) { return; }
    #[cfg(windows)]
    match native::Worker::start(app.clone(), state.clone()) {
        Ok(worker) => { if let Ok(mut slot) = state.worker.lock() { *slot = Some(worker); } }
        Err(_) => { let _ = crate::debug::append(app, "warn", "lyrics", "歌词媒体线程未启动 / 歌詞媒體執行緒未啟動 / Lyrics media worker did not start"); }
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        struct Finished(tokio::sync::watch::Sender<bool>);
        impl Drop for Finished { fn drop(&mut self) { self.0.send_replace(true); } }
        let _finished = Finished(state.done.clone()); coordinator(&handle, state).await;
    });
}
/// 由存储初始化/提交后的后台 worker 调用，读取最新设置而非 IPC 的旧返回值。
pub(crate) fn refresh_settings(app: &AppHandle) {
    let Ok(state) = state(app) else { return; }; let Ok(_refresh) = state.refresh.lock() else { return; };
    if state.control.closed.load(Ordering::Acquire) { return; }
    let preferences = app.try_state::<crate::storage::Storage>().and_then(|s| s.settings_for_backend().ok()).map(|s| desired(&s)).unwrap_or_default();
    if let Ok(mut inner) = state.inner.lock() {
        if state.control.closed.load(Ordering::Acquire) { return; }
        let old = &inner.model.preferences;
        let changed = old.wanted != preferences.wanted || old.language != preferences.language || old.opacity != preferences.opacity;
        if !changed { return; }
        let wanted = preferences.wanted;
        inner.model.configure(preferences); if !wanted { inner.pending = None; }
        state.control.wanted.store(wanted, Ordering::Release); state.control.revision.fetch_add(1, Ordering::AcqRel);
    }
    state.notify.notify_one(); publish(app, &state);
}
#[cfg(windows)]
fn sampled(app: &AppHandle, state: &State, revision: u64, session: Option<Session>) {
    if let Ok(mut inner) = state.inner.lock() {
        if !state.control.current(revision) { return; }
        let generation = inner.model.generation;
        let request = inner.model.sample(session, now());
        if inner.model.generation != generation { inner.pending = request; }
    }
    state.notify.notify_one(); publish(app, state);
}
fn apply_result(app: &AppHandle, state: &State, generation: u64, outcome: Outcome) {
    if let Ok(mut inner) = state.inner.lock() { inner.model.result(generation, outcome, now()); }
    publish(app, state);
}
struct Fetch { generation: u64, future: Pin<Box<dyn Future<Output = Outcome> + Send>>, lease: crate::lifecycle::Request }
async fn coordinator(app: &AppHandle, state: Arc<State>) {
    let mut fetch: Option<Fetch> = None; let mut client = None;
    let mut tick = tokio::time::interval(Duration::from_millis(250));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        let generation = state.inner.lock().map(|inner| inner.model.generation).unwrap_or(u64::MAX);
        if state.control.closed.load(Ordering::Acquire) || fetch.as_ref().is_some_and(|work| work.generation != generation) {
            if let Some(work) = fetch.take() { drop(work.future); work.lease.finish(); }
        }
        if state.control.closed.load(Ordering::Acquire) { return; }
        if fetch.is_none() {
            let pending = state.inner.lock().ok().and_then(|mut inner| inner.pending.take());
            if let Some(request) = pending {
                match app.state::<crate::lifecycle::Gate>().enter_classified() {
                    Ok(lease) => {
                        if client.is_none() { client = network::client().ok(); }
                        if let Some(client) = client.clone() {
                            fetch = Some(Fetch { generation: request.generation, future: Box::pin(network::fetch(client, request.query)), lease });
                        } else { lease.finish(); apply_result(app, &state, request.generation, Outcome::Network); }
                    }
                    Err(crate::lifecycle::EnterFailure::Restarting) => { if let Ok(mut inner) = state.inner.lock() { if inner.model.generation == request.generation { inner.pending = Some(request); } } }
                    Err(_) => {}
                }
            }
        }
        tokio::select! {
            result = async { fetch.as_mut().unwrap().future.as_mut().await }, if fetch.is_some() => {
                if let Some(work) = fetch.take() { work.lease.finish(); apply_result(app, &state, work.generation, result); }
            }
            _ = state.notify.notified() => {}
            _ = tick.tick() => {
                if let Ok(mut inner) = state.inner.lock() {
                    if inner.pending.is_none() && fetch.is_none() { inner.pending = inner.model.retry(now()); }
                    inner.model.tick(now());
                }
                publish(app, &state);
                // 原生穿透窗口没有 Electron forward 鼠标事件；仅探测当前歌词控制区。
                crate::ai_hud_window::poll_lyrics_pointer(app);
            }
        }
    }
}
pub(crate) fn channel_allowed(channel: &str) -> bool { matches!(channel, "music:lyricsState" | "music:lyricsNudge") }
pub(crate) fn nudge(app: &AppHandle, direction: i32) -> Result<()> {
    if !matches!(direction, -1 | 1) { return Err("歌词校准参数必须为 -1 或 1 / 歌詞校準參數必須為 -1 或 1 / Lyrics adjustment must be -1 or 1".into()); }
    let state = state(app)?;
    if state.control.closed.load(Ordering::Acquire) { return Err(unavailable()); }
    let mut inner = state.inner.lock().map_err(|_| unavailable())?; inner.model.nudge(direction, now()); drop(inner); publish(app, &state); Ok(())
}
pub(crate) fn call(app: &AppHandle, channel: &str, args: &[Value]) -> Result<Option<Value>> {
    match channel {
        "music:lyricsState" => { if !args.is_empty() { return Err(unavailable()); } Ok(Some(view(app)?.snapshot)) }
        "music:lyricsNudge" => {
            #[cfg(not(windows))]
            { let _ = args; return Err("此平台尚未接入系统歌词 / 此平台尚未接入系統歌詞 / System lyrics are not integrated on this platform".into()); }
            #[cfg(windows)]
            { if args.len() != 1 { return Err(unavailable()); } let direction = args[0].as_i64().filter(|n| matches!(n, -1 | 1)).ok_or_else(unavailable)?; nudge(app, direction as i32)?; Ok(Some(Value::Null)) }
        }
        _ => Ok(None),
    }
}
pub(crate) fn close(app: &AppHandle) {
    let Ok(state) = state(app) else { return; };
    state.control.closed.store(true, Ordering::Release); state.control.wanted.store(false, Ordering::Release); state.control.revision.fetch_add(1, Ordering::AcqRel);
    if let Ok(mut inner) = state.inner.lock() { let mut preferences = inner.model.preferences.clone(); preferences.wanted = false; inner.model.configure(preferences); inner.pending = None; }
    state.notify.notify_one(); publish(app, &state);
}
async fn wait_done(mut done: tokio::sync::watch::Receiver<bool>) -> Result<()> {
    loop { if *done.borrow_and_update() { return Ok(()); } done.changed().await.map_err(|_| unavailable())?; }
}
pub(crate) async fn shutdown(app: &AppHandle) -> Result<()> {
    close(app); let state = state(app)?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    tokio::time::timeout_at(deadline, wait_done(state.done.subscribe())).await.map_err(|_| unavailable())??;
    #[cfg(windows)]
    {
        let done = state.worker.lock().map_err(|_| unavailable())?.as_ref().map(|worker| worker.subscribe());
        if let Some(done) = done { tokio::time::timeout_at(deadline, wait_done(done)).await.map_err(|_| unavailable())??; }
        let worker = state.worker.lock().map_err(|_| unavailable())?.take();
        if let Some(worker) = worker { tauri::async_runtime::spawn_blocking(move || worker.join()).await.map_err(|_| unavailable())??; }
    }
    Ok(())
}
#[cfg(windows)]
fn dispatch_nudge(app: &AppHandle, direction: i32) {
    let Ok(state) = state(app) else { return; }; let revision = state.control.revision.load(Ordering::Acquire);
    if !state.control.current(revision) { return; }
    let Ok(request) = app.state::<crate::lifecycle::Gate>().enter() else { return; };
    if state.control.current(revision) { let _ = nudge(app, direction); } request.finish();
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn lyrics_settings_and_business_channels_remain_narrow() {
        let mut settings = json!({"hudEnabled":true,"hudShowLyrics":true,"mode":"normal","language":"en","hudOpacity":0.7});
        assert_eq!(desired(&settings).wanted, cfg!(windows)); settings["mode"] = json!("local"); assert!(!desired(&settings).wanted);
        assert!(channel_allowed("music:lyricsState")); assert!(channel_allowed("music:lyricsNudge"));
        for channel in ["settings:get","settings:set","ai:decideTool","files:readText"] { assert!(!channel_allowed(channel)); }
    }
}

//! 固定 AI 语音热键：只登记 Ctrl+Alt+V，不安装键盘钩子，不采集普通按键。
use serde_json::Value;
use std::sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}};
use tauri::{AppHandle, Manager};

#[cfg(windows)]
mod shortcut;
type Result<T> = std::result::Result<T, String>;

#[derive(Default)]
struct Control {
    wanted: AtomicBool,
    closed: AtomicBool,
    revision: AtomicU64,
    pending: AtomicBool,
}
impl Control {
    fn enabled(&self) -> bool { !self.closed.load(Ordering::Acquire) && self.wanted.load(Ordering::Acquire) }
}
#[derive(Default)]
struct State {
    control: Arc<Control>,
    // 与已提交设置的读取同序，不接收可能过期的 settings:set 返回值。
    refresh: Mutex<()>,
    #[cfg(windows)]
    worker: Mutex<Option<shortcut::Worker>>,
}
fn state(app: &AppHandle) -> Result<Arc<State>> {
    app.try_state::<Arc<State>>().map(|value| value.inner().clone()).ok_or_else(unavailable)
}
fn unavailable() -> String { "AI 语音状态不可用 / AI 語音狀態無法使用 / AI voice state unavailable".into() }
fn warning(app: &AppHandle, message: &str) { let _ = crate::debug::append(app, "warn", "ai-voice", message); }
fn desired(settings: &Value) -> bool { settings["aiEnabled"] == true && settings["aiVoiceEnabled"] == true }

pub(crate) fn init(app: &AppHandle) {
    let state = Arc::new(State::default());
    if !app.manage(state.clone()) { return; }
    #[cfg(windows)]
    match shortcut::Worker::start(app.clone(), state.control.clone()) {
        Ok(worker) => { if let Ok(mut slot) = state.worker.lock() { *slot = Some(worker); } }
        Err(_) => warning(app, "AI 语音热键线程未启动 / AI 語音快速鍵執行緒未啟動 / AI voice hotkey worker did not start"),
    }
}
/// 只由 Storage 初始化或提交后的后台 worker 调用；UI 不等待 Data / 磁盘 / 凭据库。
pub(crate) fn refresh_settings(app: &AppHandle) {
    let Ok(state) = state(app) else { return; };
    let Ok(_refresh) = state.refresh.lock() else { return; };
    if state.control.closed.load(Ordering::Acquire) { return; }
    let wanted = app.try_state::<crate::storage::Storage>()
        .and_then(|storage| storage.settings_for_backend().ok()).is_some_and(|settings| desired(&settings));
    if state.control.wanted.swap(wanted, Ordering::AcqRel) != wanted {
        state.control.revision.fetch_add(1, Ordering::AcqRel);
        publish_state(app);
    }
    #[cfg(windows)]
    if let Ok(worker) = state.worker.lock() { if let Some(worker) = worker.as_ref() { worker.wake(); } };
}
pub(crate) fn enabled(app: &AppHandle) -> bool {
    #[cfg(windows)]
    { state(app).is_ok_and(|state| state.control.enabled()) }
    #[cfg(not(windows))]
    { let _ = app; false }
}
/// 内部快照只返回布尔开关，不添加账号、目录或设置读取能力。
pub(crate) fn snapshot(app: &AppHandle, args: &[Value]) -> Result<Value> {
    if !args.is_empty() { return Err("AI 语音快照必须无参 / AI 語音快照必須無參數 / AI voice snapshot takes no arguments".into()); }
    Ok(Value::Bool(enabled(app)))
}
pub(crate) fn hud_channel_allowed(channel: &str) -> bool {
    matches!(channel, "ai:voiceState" | "ai:transcribe" | "ai:chat" | "ai:setHudStatus")
}
pub(crate) fn require_enabled(app: &AppHandle) -> Result<()> {
    if enabled(app) { Ok(()) } else { Err("AI 或语音聊天已关闭 / AI 或語音聊天已關閉 / AI or voice chat is disabled".into()) }
}
fn publish_state(app: &AppHandle) {
    #[cfg(windows)]
    {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            // 排队期间可能又发生设置提交/退出，只投递当前状态，不重放旧 true。
            let enabled = enabled(&handle);
            let _ = crate::ai_hud_window::voice_event_on_ui(&handle, Some(enabled));
            let _ = crate::ai_ball::voice_event_on_ui(&handle, Some(enabled));
        });
    }
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(windows)]
fn dispatch(app: &AppHandle, control: &Arc<Control>) {
    if !control.enabled() || control.pending.swap(true, Ordering::AcqRel) { return; }
    let request = match app.state::<crate::lifecycle::Gate>().enter_classified() {
        Ok(request) => request,
        Err(_) => { control.pending.store(false, Ordering::Release); return; }
    };
    let revision = control.revision.load(Ordering::Acquire);
    let handle = app.clone(); let control = control.clone(); let queued = control.clone();
    // 只把一个合并后的固定动作送到 UI；这里不读 Storage，也不调用录音 / 网络。
    if app.run_on_main_thread(move || {
        struct Pending(Arc<Control>);
        impl Drop for Pending { fn drop(&mut self) { self.0.pending.store(false, Ordering::Release); } }
        let _pending = Pending(control.clone());
        if control.enabled() && control.revision.load(Ordering::Acquire) == revision {
            let sent = crate::ai_hud_window::voice_event_on_ui(&handle, None)
                .and_then(|sent| if sent { Ok(true) } else { crate::ai_ball::voice_event_on_ui(&handle, None) });
            if sent.is_err() { warning(&handle, "AI 语音目标尚未确认，本次未投递 / AI 語音目標尚未確認，本次未傳送 / AI voice target is unconfirmed; no toggle was delivered"); }
        }
        request.finish();
    }).is_err() {
        queued.pending.store(false, Ordering::Release);
        // UI 调度失败时闭包及请求由框架释放；不能冒充实际动作完成。
    }
}

pub(crate) fn close(app: &AppHandle) {
    let Ok(state) = state(app) else { return; };
    state.control.closed.store(true, Ordering::Release);
    state.control.wanted.store(false, Ordering::Release);
    state.control.revision.fetch_add(1, Ordering::AcqRel);
    publish_state(app);
    #[cfg(windows)]
    if let Ok(worker) = state.worker.lock() { if let Some(worker) = worker.as_ref() { worker.wake(); } };
}
pub(crate) async fn shutdown(app: &AppHandle) -> Result<()> {
    close(app);
    #[cfg(windows)]
    {
        let state = state(app)?;
        let mut done = {
            let slot = state.worker.lock().map_err(|_| unavailable())?;
            match slot.as_ref() { Some(worker) => worker.subscribe(), None => return Ok(()) }
        };
        let wait = async {
            loop {
                if *done.borrow_and_update() { return Ok::<(), String>(()); }
                done.changed().await.map_err(|_| unavailable())?;
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(2), wait).await.map_err(|_| unavailable())??;
        let worker = state.worker.lock().map_err(|_| unavailable())?.take();
        if let Some(worker) = worker {
            // 在后台 join 原生消息线程；不把 PostThreadMessage 成功当作注销完成。
            tauri::async_runtime::spawn_blocking(move || worker.join()).await.map_err(|_| unavailable())??;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registration_is_requested_only_by_both_existing_switches() {
        for (ai, voice, expected) in [(false, false, false), (false, true, false), (true, false, false), (true, true, true)] {
            assert_eq!(desired(&serde_json::json!({"aiEnabled":ai,"aiVoiceEnabled":voice})), expected);
        }
        assert!(!desired(&serde_json::json!({"aiEnabled":true,"aiVoiceEnabled":"true"})));
    }
    #[test]
    fn voice_hud_commands_do_not_open_settings_or_tool_decisions() {
        for channel in ["ai:voiceState", "ai:transcribe", "ai:chat", "ai:setHudStatus"] { assert!(hud_channel_allowed(channel)); }
        for channel in ["settings:get", "settings:set", "ai:decideTool", "ai:setHudActive", "launch:start", "files:readText"] { assert!(!hud_channel_allowed(channel)); }
    }
}

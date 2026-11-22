//! Tauri AI HUD 状态机：只保存公开快照，不持有设置密钥或游戏路径。
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

const HUD_CHANNEL: &str = "ai:hudState";
const DEFAULT_LANGUAGE: &str = "zh-CN";
const MAX_TEXT: usize = 64 * 1024;
const MAX_USER: usize = 64 * 1024;

pub(crate) type Result<T> = std::result::Result<T, String>;

#[derive(Clone)]
pub(crate) struct View {
    pub snapshot: Value,
    pub language: String,
    pub revision: u64,
}

#[derive(Clone)]
struct Inner {
    active: bool,
    game_session: Option<String>,
    ai_enabled: bool,
    hud_enabled: bool,
    hud_show_ai: bool,
    opacity: f64,
    language: String,
    status: String,
    text: String,
    last_user: String,
    chat_generation: u64,
    revision: u64,
    closed: bool,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            active: false,
            game_session: None,
            ai_enabled: false,
            hud_enabled: false,
            hud_show_ai: false,
            opacity: 0.8,
            language: DEFAULT_LANGUAGE.into(),
            status: "idle".into(),
            text: String::new(),
            last_user: String::new(),
            chat_generation: 0,
            revision: 0,
            closed: false,
        }
    }
}

#[derive(Default)]
pub(crate) struct State {
    inner: Mutex<Inner>,
    delivery: Mutex<u64>,
    settings_refresh: Mutex<()>,
}

fn unavailable() -> String { "AI HUD 状态不可用 / AI HUD 狀態無法使用 / AI HUD state unavailable".into() }
fn bad_args() -> String { "AI HUD 参数无效 / AI HUD 參數無效 / Invalid AI HUD arguments".into() }
fn state(app: &AppHandle) -> Result<Arc<State>> {
    app.try_state::<Arc<State>>().map(|s| s.inner().clone()).ok_or_else(unavailable)
}
fn clean_text(value: &str, limit: usize) -> Result<String> {
    if value.len() > limit || value.chars().any(|c| c.is_control() && c as u32 != 10 && c as u32 != 13 && c as u32 != 9) { return Err(bad_args()); }
    Ok(value.to_owned())
}
fn language(value: &Value) -> String {
    match value.as_str() { Some("zh-CN") => "zh-CN".into(), Some("zh-TW") => "zh-TW".into(), Some("en") => "en".into(), _ => DEFAULT_LANGUAGE.into() }
}
fn snapshot(inner: &Inner) -> Value {
    let enabled = inner.active && inner.ai_enabled && inner.hud_enabled && inner.hud_show_ai;
    json!({"enabled": enabled, "active": inner.active, "opacity": inner.opacity, "status": inner.status, "text": inner.text, "lastUser": inner.last_user})
}
fn bump(inner: &mut Inner) { inner.revision = inner.revision.saturating_add(1); }
fn invalidate(inner: &mut Inner, clear_text: bool) {
    inner.chat_generation = inner.chat_generation.wrapping_add(1);
    inner.status = "idle".into();
    if clear_text { inner.text.clear(); inner.last_user.clear(); }
    bump(inner);
}
fn view_locked(inner: &Inner) -> View { View { snapshot: snapshot(inner), language: inner.language.clone(), revision: inner.revision } }

/// Delivery lock serializes the complete broadcast pair so an older view cannot arrive last.
fn emit_view(app: &AppHandle, state: &State, view: &View) {
    let mut delivery = match state.delivery.lock() { Ok(value) => value, Err(_) => return };
    if view.revision <= *delivery { return; }
    let payload = json!({"channel": HUD_CHANNEL, "payload": view.snapshot});
    let _ = app.emit_to("main", "launcher:event", payload.clone());
    let _ = app.emit_to("ai-hud", "launcher:event", payload);
    *delivery = view.revision;
}
fn request_sync(app: &AppHandle) { crate::ai_hud_window::request_sync(app); }
fn publish(app: &AppHandle, state: &State, changed: bool) {
    if !changed { return; }
    let view = match state.inner.lock() { Ok(inner) => view_locked(&inner), Err(_) => return };
    emit_view(app, state, &view);
    request_sync(app);
}
pub(crate) fn init(app: &AppHandle) { let _ = app.manage(Arc::new(State::default())); }

fn view_from(state: &State) -> Result<View> {
    state.inner.lock().map(|inner| view_locked(&inner)).map_err(|_| unavailable())
}
pub(crate) fn view(app: &AppHandle) -> Result<View> { let state = state(app)?; view_from(state.as_ref()) }

fn settings_transition(inner: &mut Inner, settings: &Value) -> Result<bool> {
    if inner.closed { return Err(unavailable()); }
    let ai = settings.get("aiEnabled").and_then(Value::as_bool).ok_or_else(bad_args)?;
    let hud = settings.get("hudEnabled").and_then(Value::as_bool).ok_or_else(bad_args)?;
    let show = settings.get("hudShowAi").and_then(Value::as_bool).ok_or_else(bad_args)?;
    let opacity = match settings.get("hudOpacity") {
        None | Some(Value::Null) => 0.8,
        Some(value) => value.as_f64().ok_or_else(bad_args)?,
    };
    if !opacity.is_finite() || !(0.0..=1.0).contains(&opacity) { return Err(bad_args()); }
    let next_language = language(settings.get("language").unwrap_or(&Value::Null));
    let switch_changed = inner.ai_enabled != ai || inner.hud_enabled != hud || inner.hud_show_ai != show;
    let changed = switch_changed || inner.opacity != opacity || inner.language != next_language;
    if !changed { return Ok(false); }
    inner.ai_enabled = ai;
    inner.hud_enabled = hud;
    inner.hud_show_ai = show;
    inner.opacity = opacity;
    inner.language = next_language;
    if switch_changed { invalidate(inner, false); }
    else { bump(inner); }
    Ok(true)
}
/// 先串行化“读取最新 Storage 快照 -> 应用状态”，不接收可能过期的调用返回值。
/// 读取 Storage 时不持 HUD 锁，发送事件及宿主同步也在这两个短状态锁之外。
fn refresh_settings_from(state: &State, read: impl FnOnce() -> Result<Value>) -> Result<bool> {
    let _refresh = state.settings_refresh.lock().map_err(|_| unavailable())?;
    let settings = read()?;
    let mut inner = state.inner.lock().map_err(|_| unavailable())?;
    settings_transition(&mut inner, &settings)
}
pub(crate) fn refresh_settings(app: &AppHandle) -> Result<()> {
    let state = state(app)?;
    let changed = refresh_settings_from(&state, || app.state::<crate::storage::Storage>().settings_for_backend())?;
    publish(app, &state, changed);
    Ok(())
}
/// 保留既有入口；并发提交后以 Storage 的最新快照为准，不重放旧调用返回值。
pub(crate) fn settings_changed(app: &AppHandle, _settings: &Value) -> Result<()> { refresh_settings(app) }

/// Pure transition shared by runtime callbacks and deterministic fixtures.
fn start_transition(inner: &mut Inner, requested: &str, authoritative: Option<&str>) -> bool {
    if inner.closed || requested.is_empty() || authoritative != Some(requested) || inner.game_session.as_deref() == Some(requested) { return false; }
    inner.game_session = Some(requested.to_owned());
    inner.active = true;
    invalidate(inner, false);
    true
}
/// A stop event only removes its matching session; a newer authoritative session wins.
fn stop_transition(inner: &mut Inner, stopped: &str, authoritative: Option<&str>) -> bool {
    if inner.closed || inner.game_session.as_deref() != Some(stopped) { return false; }
    match authoritative {
        Some(current) if !current.is_empty() => {
            if current == stopped { return false; }
            inner.game_session = Some(current.to_owned());
            inner.active = true;
        }
        _ => { inner.game_session = None; inner.active = false; }
    }
    invalidate(inner, false);
    true
}
fn active_hint_transition(inner: &mut Inner, active_hint: bool, authoritative: Option<&str>) -> bool {
    if inner.closed { return false; }
    if !active_hint {
        invalidate(inner, false);
    }
    let session = authoritative.filter(|value| !value.is_empty());
    let next_active = session.is_some();
    let next_session = session.map(str::to_owned);
    let changed = inner.active != next_active || inner.game_session != next_session;
    if changed {
        inner.active = next_active;
        inner.game_session = next_session;
        if active_hint { invalidate(inner, false); } else { bump(inner); }
    }
    changed || !active_hint
}
fn runtime_transition_from(state: &State, session: &str, authoritative: impl FnOnce() -> Result<Option<String>>, transition: fn(&mut Inner, &str, Option<&str>) -> bool) -> Result<bool> {
    if session.is_empty() { return Ok(false); }
    // 锁顺序固定为 HUD -> GAME；权威读取在 HUD 短锁内，较早回调不能覆盖已处理的新会话。
    let mut inner = state.inner.lock().map_err(|_| unavailable())?;
    let authoritative = authoritative()?;
    Ok(transition(&mut inner, session, authoritative.as_deref()))
}
pub(crate) fn game_started(app: &AppHandle, session: &str) {
    let Ok(state) = state(app) else { return; };
    let changed = runtime_transition_from(&state, session, crate::runtime::hud_game_session, start_transition).unwrap_or(false);
    publish(app, &state, changed);
}
pub(crate) fn game_stopped(app: &AppHandle, session: &str) {
    let Ok(state) = state(app) else { return; };
    let changed = runtime_transition_from(&state, session, crate::runtime::hud_game_session, stop_transition).unwrap_or(false);
    publish(app, &state, changed);
}
pub(crate) fn close(app: &AppHandle) {
    let Ok(state) = state(app) else { return; };
    let changed = state.inner.lock().map(|mut inner| {
        if inner.closed { false } else { inner.closed = true; inner.game_session = None; inner.active = false; invalidate(&mut inner, false); true }
    }).unwrap_or(false);
    publish(app, &state, changed);
}

fn begin_chat_transition(inner: &mut Inner, last_user: String) -> Result<u64> {
    if inner.closed { return Err(unavailable()); }
    inner.chat_generation = inner.chat_generation.saturating_add(1);
    inner.last_user = last_user;
    inner.status = "thinking".into();
    bump(inner);
    Ok(inner.chat_generation)
}
fn status_transition(inner: &mut Inner, status: &str) -> Result<bool> {
    if inner.closed { return Err(unavailable()); }
    if !matches!(status, "idle" | "thinking" | "speaking" | "listening") { return Err(bad_args()); }
    inner.status = status.to_owned();
    bump(inner);
    Ok(true)
}
fn publish_chat_transition(inner: &mut Inner, generation: u64, status: &str, text: Option<String>) -> Result<bool> {
    if inner.closed { return Err(unavailable()); }
    if !matches!(status, "idle" | "thinking" | "speaking" | "listening") { return Err(bad_args()); }
    if inner.chat_generation != generation { return Ok(false); }
    inner.status = status.to_owned();
    if let Some(text) = text { inner.text = text; }
    bump(inner);
    Ok(true)
}
fn begin_chat_from(state: &State, last_user: &str) -> Result<u64> {
    let input = clean_text(last_user, MAX_USER)?;
    let mut inner = state.inner.lock().map_err(|_| unavailable())?;
    begin_chat_transition(&mut inner, input)
}
pub(crate) fn begin_chat(app: &AppHandle, last_user: &str) -> Result<u64> {
    let state = state(app)?;
    let generation = begin_chat_from(&state, last_user)?;
    publish(app, &state, true);
    Ok(generation)
}
fn publish_chat_from(state: &State, generation: u64, status: &str, text: Option<&str>) -> Result<bool> {
    let clean = text.map(|value| clean_text(value, MAX_TEXT)).transpose()?;
    let mut inner = state.inner.lock().map_err(|_| unavailable())?;
    publish_chat_transition(&mut inner, generation, status, clean)
}
pub(crate) fn publish_chat(app: &AppHandle, generation: u64, status: &str, text: Option<&str>) -> Result<bool> {
    let state = state(app)?;
    let changed = publish_chat_from(&state, generation, status, text)?;
    publish(app, &state, changed);
    Ok(changed)
}
pub(crate) fn finish_chat(app: &AppHandle, generation: u64, text: Option<&str>) -> Result<bool> { publish_chat(app, generation, "idle", text) }
fn invalidate_chat_from(state: &State, clear_text: bool) -> Result<()> {
    let mut inner = state.inner.lock().map_err(|_| unavailable())?;
    if inner.closed { return Err(unavailable()); }
    invalidate(&mut inner, clear_text);
    Ok(())
}
pub(crate) fn invalidate_chat(app: &AppHandle, clear_text: bool) -> Result<()> {
    let state = state(app)?;
    invalidate_chat_from(&state, clear_text)?;
    publish(app, &state, true);
    Ok(())
}
fn invalidate_generation_transition(inner: &mut Inner, generation: u64) -> bool {
    if inner.closed || inner.chat_generation != generation { return false; }
    invalidate(inner, false);
    true
}
fn invalidate_generation_from(state: &State, generation: u64) -> bool {
    state.inner.lock().map(|mut inner| invalidate_generation_transition(&mut inner, generation)).unwrap_or(false)
}
pub(crate) fn invalidate_generation(app: &AppHandle, generation: u64) {
    let Ok(state) = state(app) else { return; };
    let changed = invalidate_generation_from(&state, generation);
    publish(app, &state, changed);
}

/// 只替换 AppHandle 传输层；服务夹具仍使用与生产相同的锁、校验和状态转移。
#[cfg(test)]
pub(crate) mod fixture {
    use super::*;
    pub(crate) fn begin(state: &State, input: &str) -> Result<u64> { begin_chat_from(state, input) }
    pub(crate) fn finish(state: &State, generation: u64, text: Option<&str>) -> Result<bool> { publish_chat_from(state, generation, "idle", text) }
    pub(crate) fn invalidate_generation(state: &State, generation: u64) -> bool { invalidate_generation_from(state, generation) }
    pub(crate) fn invalidate(state: &State, clear_text: bool) -> Result<()> { invalidate_chat_from(state, clear_text) }
    pub(crate) fn game_started(state: &State, session: &str, authoritative: impl FnOnce() -> Result<Option<String>>) -> Result<bool> { runtime_transition_from(state, session, authoritative, start_transition) }
    pub(crate) fn game_stopped(state: &State, session: &str, authoritative: impl FnOnce() -> Result<Option<String>>) -> Result<bool> { runtime_transition_from(state, session, authoritative, stop_transition) }
    pub(crate) fn snapshot(state: &State) -> Value { view_from(state).unwrap().snapshot }
}
pub(crate) fn set_status(app: &AppHandle, status: &str) -> Result<()> {
    let state = state(app)?;
    let changed = {
        let mut inner = state.inner.lock().map_err(|_| unavailable())?;
        status_transition(&mut inner, status)?
    };
    publish(app, &state, changed);
    Ok(())
}
pub(crate) fn set_active(app: &AppHandle, active_hint: bool) -> Result<()> {
    let state = state(app)?;
    let changed = {
        let mut inner = state.inner.lock().map_err(|_| unavailable())?;
        if inner.closed { return Err(unavailable()); }
        let authoritative = crate::runtime::hud_game_session()?;
        active_hint_transition(&mut inner, active_hint, authoritative.as_deref())
    };
    publish(app, &state, changed);
    Ok(())
}

pub(crate) async fn call(app: &AppHandle, channel: &str, args: &[Value]) -> Result<Option<Value>> {
    match channel {
        "ai:hudState" => { if !args.is_empty() { return Err(bad_args()); } Ok(Some(view(app)?.snapshot)) }
        "ai:setHudActive" => {
            if args.len() != 1 { return Err(bad_args()); }
            let active = args[0].as_bool().ok_or_else(bad_args)?;
            set_active(app, active)?;
            Ok(Some(view(app)?.snapshot))
        }
        "ai:setHudStatus" => {
            if args.len() != 1 { return Err(bad_args()); }
            let status = args[0].as_str().ok_or_else(bad_args)?;
            set_status(app, status)?;
            Ok(Some(view(app)?.snapshot))
        }
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enabled_settings() -> Value { json!({"aiEnabled":true,"hudEnabled":true,"hudShowAi":true,"hudOpacity":0.7,"language":"en"}) }

    #[test]
    fn public_snapshot_has_exact_six_keys() {
        let value = snapshot(&Inner::default());
        let object = value.as_object().unwrap();
        assert_eq!(object.len(), 6);
        for key in ["enabled", "active", "opacity", "status", "text", "lastUser"] { assert!(object.contains_key(key)); }
    }

    #[test]
    fn settings_disable_invalidates_the_live_chat_generation() {
        let mut inner = Inner::default();
        settings_transition(&mut inner, &enabled_settings()).unwrap();
        inner.active = true;
        let ticket = begin_chat_transition(&mut inner, "question".into()).unwrap();
        assert_eq!(snapshot(&inner)["enabled"], true);
        for key in ["aiEnabled", "hudEnabled", "hudShowAi"] {
            let previous_generation = inner.chat_generation;
            let mut disabled = enabled_settings(); disabled[key] = json!(false);
            assert!(settings_transition(&mut inner, &disabled).unwrap(), "{key}");
            assert!(inner.chat_generation > previous_generation, "{key}");
            assert_eq!(inner.status, "idle");
            assert_eq!(snapshot(&inner)["enabled"], false);
            assert!(!publish_chat_transition(&mut inner, ticket, "thinking", None).unwrap());
            assert!(settings_transition(&mut inner, &enabled_settings()).unwrap(), "re-enable {key}");
        }
    }

    #[test]
    fn settings_refresh_serializes_snapshot_read_and_does_not_hold_hud_lock_during_storage_read() {
        let state=State::default();
        let latest=Mutex::new(enabled_settings());
        let stale_return=enabled_settings();
        latest.lock().unwrap()["hudEnabled"]=json!(false);
        assert!(refresh_settings_from(&state,||{
            assert!(state.settings_refresh.try_lock().is_err(),"读取 Storage 前先取得刷新串行锁");
            assert!(state.inner.try_lock().is_ok(),"读取 Storage 时不得持有 HUD 锁");
            assert_eq!(stale_return["hudEnabled"],true);
            Ok(latest.lock().unwrap().clone())
        }).unwrap());
        assert!(!state.inner.lock().unwrap().hud_enabled,"必须应用最新 Storage，而不是已过期调用返回值");
        assert!(state.settings_refresh.try_lock().is_ok(),"事件与宿主同步前释放刷新锁");
        assert!(state.inner.try_lock().is_ok());
        let generation=begin_chat_from(&state,"live question").unwrap();
        assert!(!refresh_settings_from(&state,||Ok(latest.lock().unwrap().clone())).unwrap());
        assert!(publish_chat_from(&state,generation,"idle",Some("unchanged settings answer")).unwrap(),"相同设置刷新不得失效聊天");
    }

    #[test]
    fn settings_language_opacity_refresh_preserves_ticket_but_switch_change_rejects_late_answer() {
        let state=State::default();let initial=enabled_settings();
        refresh_settings_from(&state,||Ok(initial.clone())).unwrap();
        let generation=begin_chat_from(&state,"live question").unwrap();
        let mut cosmetic=initial.clone();cosmetic["language"]=json!("zh-TW");cosmetic["hudOpacity"]=json!(0.25);
        assert!(refresh_settings_from(&state,||Ok(cosmetic.clone())).unwrap());
        assert_eq!(view_from(&state).unwrap().language,"zh-TW");
        assert_eq!(view_from(&state).unwrap().snapshot["opacity"],0.25);
        assert!(publish_chat_from(&state,generation,"thinking",None).unwrap());
        cosmetic["hudShowAi"]=json!(false);
        assert!(refresh_settings_from(&state,||Ok(cosmetic)).unwrap());
        assert!(!publish_chat_from(&state,generation,"idle",Some("late answer")).unwrap());
        let before=view_from(&state).unwrap();
        assert!(refresh_settings_from(&state,||Err("夹具读取失败".into())).is_err());
        let mut malformed=initial;malformed["hudOpacity"]=json!(2.0);
        assert!(refresh_settings_from(&state,||Ok(malformed)).is_err());
        let after=view_from(&state).unwrap();
        assert_eq!(after.revision,before.revision);assert_eq!(after.snapshot,before.snapshot);
    }

    #[test]
    fn runtime_authority_is_read_inside_hud_lock_and_unknown_does_not_change_state() {
        let state=State::default();
        assert!(runtime_transition_from(&state,"current",||{
            assert!(state.inner.try_lock().is_err(),"不能先取权威快照再排队修改 HUD");
            Ok(Some("current".into()))
        },start_transition).unwrap());
        let before=view_from(&state).unwrap();
        assert!(runtime_transition_from(&state,"current",||Err("夹具进程表不可用".into()),stop_transition).is_err());
        assert_eq!(view_from(&state).unwrap().revision,before.revision);
        assert_eq!(view_from(&state).unwrap().snapshot,before.snapshot);
        assert!(!runtime_transition_from(&state,"",||panic!("空会话不可读取 GAME"),start_transition).unwrap());
    }

    #[test]
    fn runtime_session_transition_rejects_late_start_and_stale_stop() {
        let mut inner = Inner::default();
        assert!(!start_transition(&mut inner, "short", None));
        assert_eq!(inner.game_session, None);
        assert!(start_transition(&mut inner, "old", Some("old")));
        assert_eq!(inner.game_session.as_deref(), Some("old"));
        assert!(start_transition(&mut inner, "new", Some("new")));
        assert_eq!(inner.game_session.as_deref(), Some("new"));
        assert!(!stop_transition(&mut inner, "old", None));
        assert_eq!(inner.game_session.as_deref(), Some("new"));
        assert!(stop_transition(&mut inner, "new", None));
        assert_eq!(inner.game_session, None);
        assert!(!inner.active);
    }

    #[test]
    fn caller_drop_generation_and_reset_prevent_late_chat_revival() {
        let mut inner = Inner::default();
        let dropped = begin_chat_transition(&mut inner, "old request".into()).unwrap();
        assert!(invalidate_generation_transition(&mut inner, dropped));
        assert!(!publish_chat_transition(&mut inner, dropped, "thinking", None).unwrap());
        let next = begin_chat_transition(&mut inner, "new request".into()).unwrap();
        assert!(publish_chat_transition(&mut inner, next, "speaking", Some("answer".into())).unwrap());
        let before_reset = inner.chat_generation;
        invalidate(&mut inner, true);
        assert!(inner.chat_generation > before_reset);
        assert!(!invalidate_generation_transition(&mut inner, next), "旧 caller drop 不能取消新一轮");
        assert!(!publish_chat_transition(&mut inner, next, "idle", Some("late answer".into())).unwrap());
        assert_eq!(inner.text, "");
        assert_eq!(inner.last_user, "");
    }

    #[test]
    fn active_false_hint_invalidates_but_does_not_override_running_game() {
        let mut inner = Inner::default();
        start_transition(&mut inner, "current", Some("current"));
        let ticket = begin_chat_transition(&mut inner, "question".into()).unwrap();
        assert!(active_hint_transition(&mut inner, false, Some("current")));
        assert_eq!(inner.game_session.as_deref(), Some("current"));
        assert!(inner.active);
        assert!(!publish_chat_transition(&mut inner, ticket, "thinking", None).unwrap());
    }

    #[test]
    fn status_rejects_invalid_values_and_closed_state() {
        let mut inner = Inner::default();
        assert!(status_transition(&mut inner, "invalid").is_err());
        assert!(status_transition(&mut inner, "speaking").unwrap());
        assert_eq!(inner.status, "speaking");
        inner.closed = true;
        assert!(status_transition(&mut inner, "idle").is_err());
    }

    #[test]
    fn language_and_text_bounds_are_explicit() {
        assert_eq!(language(&json!("en")), "en");
        assert_eq!(language(&json!("fr")), "zh-CN");
        assert!(clean_text(&char::from_u32(0).unwrap().to_string(), 16).is_err());
        assert!(clean_text(&char::from_u32(10).unwrap().to_string(), 16).is_ok());
        assert!(clean_text(&"x".repeat(MAX_TEXT + 1), MAX_TEXT).is_err());
    }
}

//! 仅由用户显式触发的诊断上传：固定 PHP 目的地、白名单快照、独立 worker 生命周期。
use serde_json::{json, Value};
use std::{sync::{Arc, Mutex}, time::Duration};
use tauri::{AppHandle, Manager};
use tokio::sync::Notify;

const ENDPOINT: &str = "https://hcmcl.johnnyblog.top/api.php?action=debug_submit";
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_REQUEST_BYTES: usize = 512 * 1024;
const MAX_LOG_BYTES: usize = 400 * 1024;
const BUSY: &str = "诊断上传仍在运行、收尾或结果未确认，请稍后重试 / 診斷上傳仍在執行、收尾或結果未確認，請稍後重試 / Diagnostic upload is running, finishing, or unconfirmed; retry later";
const UNAVAILABLE: &str = "诊断上传状态不可用 / 診斷上傳狀態無法使用 / Diagnostic upload state is unavailable";
const UNKNOWN: &str = "诊断上传结果未确认；没有自动重试，服务端是否接收及剩余次数未知 / 診斷上傳結果未確認；沒有自動重試，伺服器是否接收及剩餘次數未知 / Diagnostic upload is unconfirmed; no retry was made and server receipt and remaining uses are unknown";
const CANCELLED: &str = "已请求取消上传；不能保证服务端尚未接收，未自动重试 / 已請求取消上傳；不能保證伺服器尚未接收，未自動重試 / Upload cancellation requested; the server may already have received it, and it was not retried";
const SETTINGS_ERROR: &str = "无法读取诊断上传设置 / 無法讀取診斷上傳設定 / Cannot read diagnostic upload settings";
const CONSENT_ERROR: &str = "请先明确同意诊断日志上传，且不能处于本地模式；设置变化后需重新提交 / 請先明確同意診斷日誌上傳，且不能處於本機模式；設定變更後須重新提交 / Explicit diagnostic-log consent is required outside local mode; submit again after settings change";
const SNAPSHOT_ERROR: &str = "诊断快照无效或超过安全上限 / 診斷快照無效或超過安全上限 / Diagnostic snapshot is invalid or exceeds the safety limit";

#[derive(Default)]
pub(super) struct State { slot: Arc<Mutex<Slot>> }
#[derive(Default)]
struct Slot { current: Option<Arc<Upload>>, closed: bool, uncertain: bool }
#[derive(Default)]
struct Upload { stopped: std::sync::atomic::AtomicBool, notify: Notify }
impl Upload {
    fn cancel(&self) { self.stopped.store(true, std::sync::atomic::Ordering::Release); self.notify.notify_waiters(); }
    fn check(&self) -> Result<(), String> {
        if self.stopped.load(std::sync::atomic::Ordering::Acquire) { Err(CANCELLED.into()) } else { Ok(()) }
    }
    async fn cancelled(&self) {
        loop {
            if self.stopped.load(std::sync::atomic::Ordering::Acquire) { return; }
            // Notify 不保留 notify_waiters 的历史；定时重查避免取消先于订阅而丢失唤醒。
            tokio::select! { _ = self.notify.notified() => {}, _ = tokio::time::sleep(Duration::from_millis(50)) => {} }
        }
    }
}

/// 拥有额外 Gate Request；IPC future 的析构不会把真实后台任务释放为 idle。
struct Owner {
    slot: Arc<Mutex<Slot>>, task: Arc<Upload>, request: Option<crate::lifecycle::Request>, finished: bool,
}
impl Owner {
    fn finish(mut self) {
        let released = match self.slot.lock() {
            Ok(mut slot) if slot.current.as_ref().is_some_and(|active| Arc::ptr_eq(active, &self.task)) => {
                slot.current = None; true
            },
            Ok(mut slot) => { slot.uncertain = true; false },
            Err(_) => false,
        };
        if released { if let Some(request) = self.request.take() { request.finish(); } }
        self.finished = true;
        // 无法证明登记匹配时，Request 按未完成析构，Gate 同样保持未知状态。
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        if !self.finished {
            self.task.cancel();
            if let Ok(mut slot) = self.slot.lock() { slot.uncertain = true; }
            // 保留 current；panic/drop 不能假装上传已收尾。
        }
    }
}
struct CallerSignal(Arc<Upload>);
impl Drop for CallerSignal { fn drop(&mut self) { self.0.cancel(); } }

fn reserve(state: &State, request: Option<crate::lifecycle::Request>) -> Result<Owner, String> {
    let task = Arc::new(Upload::default());
    let accepted = match state.slot.lock() {
        Ok(mut slot) if !slot.closed && !slot.uncertain && slot.current.is_none() => { slot.current = Some(task.clone()); true },
        _ => false,
    };
    if !accepted { if let Some(request) = request { request.finish(); } return Err(BUSY.into()); }
    Ok(Owner { slot: state.slot.clone(), task, request, finished: false })
}
fn ready(state: &State) -> Result<(), String> {
    let slot = state.slot.try_lock().map_err(|_| BUSY.to_owned())?;
    if slot.closed || slot.uncertain || slot.current.is_some() { return Err(BUSY.into()); }
    Ok(())
}
fn close(state: &State) {
    if let Ok(mut slot) = state.slot.lock() {
        slot.closed = true;
        if let Some(task) = &slot.current { task.cancel(); }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ConsentSnapshot { mode: String }
fn consent(settings: &Value) -> Result<ConsentSnapshot, String> {
    let mode = settings.get("mode").and_then(Value::as_str).ok_or(SETTINGS_ERROR)?;
    if !matches!(mode, "normal" | "minimal") || settings.get("feedbackLogConsent").and_then(Value::as_bool) != Some(true) {
        return Err(CONSENT_ERROR.into());
    }
    Ok(ConsentSnapshot { mode: mode.to_owned() })
}
fn key_arg(args: &[Value]) -> Result<String, String> {
    let invalid = || "调试密钥必须为 8–128 位十六进制字符 / 調試密鑰必須為 8–128 位十六進位字元 / Debug key must contain 8–128 hexadecimal characters".to_owned();
    if args.len() != 1 { return Err(invalid()); }
    let key = args[0].as_str().ok_or_else(invalid)?.trim();
    if !(8..=128).contains(&key.len()) || !key.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err(invalid()); }
    Ok(key.to_owned())
}
fn bounded(value: Option<&Value>, cap: usize, fallback: &str) -> String {
    value.and_then(Value::as_str).filter(|s| s.len() <= cap && !s.chars().any(char::is_control)).unwrap_or(fallback).to_owned()
}
fn known_secrets(settings: &Value, key: &str) -> Vec<String> {
    let mut secrets = vec![key.to_owned()];
    for name in ["debugKey", "devModeToken", "multiplayerLobbyPassword", "aiApiKey", "uapisApiKey", "curseForgeApiKey", "aiHeaders"] {
        if let Some(value) = settings.get(name).and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() <= 32768) { secrets.push(value.to_owned()); }
    }
    if let Some(headers) = settings.get("aiHeaders").and_then(Value::as_str).filter(|s| s.len() <= 16384) {
        if let Ok(Value::Object(headers)) = serde_json::from_str::<Value>(headers) {
            for value in headers.values().filter_map(Value::as_str).filter(|s| !s.is_empty()) { secrets.push(value.to_owned()); }
        } else {
            for value in headers.lines().filter_map(|line| line.split_once(':').map(|(_, value)| value.trim())).filter(|s| !s.is_empty()) { secrets.push(value.to_owned()); }
        }
    }
    secrets.sort_by_key(|value| std::cmp::Reverse(value.len())); secrets.dedup(); secrets
}
fn redact_known(value: &mut Value, secrets: &[String], paths: &[String]) {
    match value {
        Value::String(text) => {
            for secret in secrets.iter().filter(|s| !s.is_empty()) { *text = text.replace(secret, "[已隐藏]"); }
            for path in paths.iter().filter(|s| s.len() > 3) { *text = text.replace(path, "[本地路径未收集]"); }
        },
        Value::Array(values) => { for value in values { redact_known(value, secrets, paths); } },
        Value::Object(values) => { for value in values.values_mut() { redact_known(value, secrets, paths); } },
        _ => {},
    }
}

fn diagnostic_payload(version: &str, settings: &Value, snapshot: &Value, system: &Value, now: u64, secrets: &[String]) -> Result<Value, String> {
    let source = snapshot.get("logs").and_then(Value::as_array).filter(|logs| logs.len() <= 800).ok_or(SNAPSHOT_ERROR)?;
    let stats = snapshot.get("stats").and_then(Value::as_object).ok_or(SNAPSHOT_ERROR)?;
    let total = stats.get("total").and_then(Value::as_u64).filter(|total| *total >= source.len() as u64 && *total <= 2000).ok_or(SNAPSHOT_ERROR)?;
    let errors = stats.get("errorCount").and_then(Value::as_u64).ok_or(SNAPSHOT_ERROR)?;
    let warnings = stats.get("warnCount").and_then(Value::as_u64).ok_or(SNAPSHOT_ERROR)?;
    if errors.saturating_add(warnings) > total { return Err(SNAPSHOT_ERROR.into()); }
    // 再次使用同一脱敏器隐藏本次及已保存密钥；不允许上游快照中的未知字段搭车。
    let mut buffer = super::buffer::Buffer::default();
    for entry in source {
        let ts = entry.get("ts").and_then(Value::as_u64).ok_or(SNAPSHOT_ERROR)?;
        let level = entry.get("level").and_then(Value::as_str).ok_or(SNAPSHOT_ERROR)?;
        let text = entry.get("message").and_then(Value::as_str).filter(|text| text.len() <= 8000).ok_or(SNAPSHOT_ERROR)?;
        buffer.push(ts, level, "", text, secrets).map_err(|_| SNAPSHOT_ERROR.to_owned())?;
    }
    let redacted = buffer.diagnostic();
    let logs = redacted.get("logs").and_then(Value::as_array).ok_or(SNAPSHOT_ERROR)?;
    let platform = match std::env::consts::OS { "windows" => "win32", "macos" => "darwin", other => other };
    let arch = match std::env::consts::ARCH { "x86_64" => "x64", "x86" => "ia32", "aarch64" => "arm64", "arm" => "arm", other => other };
    let mut result = json!({
        "generatedAt":now,
        "launcher":{
            "version":version,"platform":platform,"arch":arch,"electron":"","chrome":"","node":"",
            "locale":bounded(settings.get("language"),64,"zh-CN"),
            "mode":bounded(settings.get("mode"),64,""),"gameDir":"[本地路径未收集]",
            "selectedVersionId":bounded(settings.get("selectedVersionId"),256,""),
            "multiplayer":settings.get("enableMultiplayer").and_then(Value::as_bool).unwrap_or(false)
        },
        "system":{
            "osRelease":bounded(system.get("osRelease"),256,""),
            "cpuCores":system.get("cpuCores").and_then(Value::as_u64).unwrap_or(0),
            "totalMemMb":system.get("totalMemMb").and_then(Value::as_u64).unwrap_or(0)
        },
        "stats":{"total":total,"sent":logs.len(),"errorCount":errors,"warnCount":warnings},"logs":logs
    });
    let paths: Vec<String> = ["gameDirAbs", "gameDir"].iter().filter_map(|name| settings.get(*name).and_then(Value::as_str)).filter(|path| path.len() <= 32768).map(str::to_owned).collect();
    redact_known(&mut result, secrets, &paths);
    // 路径替换可能扩张正文；按最终 JSON 字节重新保留连续的最新后缀。
    let logs = result.get_mut("logs").and_then(Value::as_array_mut).ok_or(SNAPSHOT_ERROR)?;
    let mut bytes = 2usize; let mut keep_from = logs.len();
    for (index, entry) in logs.iter().enumerate().rev() {
        let next = bytes.saturating_add(serde_json::to_vec(entry).map_err(|_| SNAPSHOT_ERROR)?.len()).saturating_add(usize::from(keep_from != logs.len()));
        if next > MAX_LOG_BYTES { break; }
        bytes = next; keep_from = index;
    }
    logs.drain(..keep_from); let sent = logs.len();
    result["stats"]["sent"] = json!(sent);
    if serde_json::to_vec(&result).map_err(|_| SNAPSHOT_ERROR)?.len() > MAX_REQUEST_BYTES { return Err(SNAPSHOT_ERROR.into()); }
    Ok(result)
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().use_rustls_tls().no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(60))
        .build().map_err(|_| UNKNOWN.into())
}
fn parse_success(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() > MAX_RESPONSE_BYTES { return Err(UNKNOWN.into()); }
    let result: Value = serde_json::from_slice(bytes).map_err(|_| UNKNOWN)?;
    let remaining = result.get("remaining").and_then(Value::as_u64).filter(|n| *n <= 9_007_199_254_740_991).ok_or(UNKNOWN)?;
    if result.get("ok").and_then(Value::as_bool) != Some(true) { return Err(UNKNOWN.into()); }
    Ok(json!({"ok":true,"remaining":remaining,"message":format!("日志已上传（剩余可用次数 {remaining}） / 日誌已上傳（剩餘可用次數 {remaining}） / Logs uploaded ({remaining} uses remaining)")}))
}
async fn send(client: reqwest::Client, bytes: Vec<u8>, task: &Upload) -> Result<Value, String> {
    task.check()?;
    let response = client.post(ENDPOINT).header(reqwest::header::CONTENT_TYPE,"application/json").body(bytes).send();
    let mut response = tokio::select! { biased; _ = task.cancelled() => return Err(CANCELLED.into()), result = response => result.map_err(|_| UNKNOWN)? };
    if !response.status().is_success() || response.content_length().is_some_and(|n| n > MAX_RESPONSE_BYTES as u64) { return Err(UNKNOWN.into()); }
    let mut bytes = Vec::new();
    loop {
        let chunk = tokio::select! { biased; _ = task.cancelled() => return Err(CANCELLED.into()), chunk = response.chunk() => chunk.map_err(|_| UNKNOWN)? };
        let Some(chunk) = chunk else { break; };
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES { return Err(UNKNOWN.into()); }
        bytes.extend_from_slice(&chunk);
    }
    task.check()?;
    parse_success(&bytes)
}

struct Failure { message: String, uncertain: bool }
impl From<String> for Failure { fn from(message: String) -> Self { Self { message, uncertain: false } } }
async fn settings(app: &AppHandle) -> Result<Value, Failure> {
    let app = app.clone();
    // 不 select/drop blocking 读取：其锁等待真正返回前 owned worker 必须一直持有 Gate 和 busy。
    tauri::async_runtime::spawn_blocking(move || {
        app.try_state::<crate::storage::Storage>().ok_or_else(|| SETTINGS_ERROR.to_owned())?.settings_for_backend().map_err(|_| SETTINGS_ERROR.to_owned())
    }).await.map_err(|_| Failure { message: UNKNOWN.into(), uncertain: true })?.map_err(Failure::from)
}
async fn perform(app: &AppHandle, task: &Upload, key: &str) -> Result<Value, Failure> {
    task.check()?;
    let initial = settings(app).await?;
    let captured = consent(&initial)?;
    task.check()?;
    let snapshot = super::snapshot(app).map_err(|_| SNAPSHOT_ERROR.to_owned())?;
    let system = crate::desktop::diagnostic_system();
    let client = http_client()?;
    // Storage 尚无单调设置纪元接口；多次快照一致复核不能探知中间短暂撤回后又同意。
    // 设置锁释放后才构造固定请求，绝不在 Storage 锁下联网。
    let latest = settings(app).await?;
    if consent(&latest)? != captured { return Err(CONSENT_ERROR.to_owned().into()); }
    task.check()?;
    let mut secrets = known_secrets(&initial, key); secrets.extend(known_secrets(&latest, key));
    secrets.sort_by_key(|value| std::cmp::Reverse(value.len())); secrets.dedup();
    let diagnostic = diagnostic_payload(&app.package_info().version.to_string(), &latest, &snapshot, &system, super::now_ms(), &secrets)?;
    let bytes = serde_json::to_vec(&json!({"key":key,"diagnostics":diagnostic})).map_err(|_| SNAPSHOT_ERROR.to_owned())?;
    if bytes.len() > MAX_REQUEST_BYTES { return Err(SNAPSHOT_ERROR.to_owned().into()); }
    // CPU 脱敏/编码完成后再复核授权；复核后不再等待其它读取，直接派发固定请求。
    let dispatch = settings(app).await?;
    if consent(&dispatch)? != captured { return Err(CONSENT_ERROR.to_owned().into()); }
    task.check()?;
    send(client, bytes, task).await.map_err(Failure::from)
}

pub(super) async fn submit(app: &AppHandle, args: &[Value]) -> Result<Value, String> {
    let key = key_arg(args)?;
    let state = app.try_state::<State>().ok_or(UNAVAILABLE)?;
    let gate = app.try_state::<crate::lifecycle::Gate>().ok_or(UNAVAILABLE)?;
    let owner = reserve(state.inner(), Some(gate.enter()?))?;
    let task = owner.task.clone(); let _caller = CallerSignal(task.clone()); let app = app.clone();
    let worker = tokio::spawn(async move {
        let result = perform(&app, &task, &key).await;
        let uncertain = result.as_ref().err().is_some_and(|error| error.uncertain);
        let result = result.map_err(|error| error.message);
        if !uncertain { owner.finish(); } // 未知的 blocking panic 保留登记并使 Gate 粘滞。
        result
    });
    // JoinHandle 被调用方丢弃只会 detach；worker 仍持有 owner，不会释放为 idle。
    worker.await.map_err(|_| UNKNOWN.to_owned())?
}
pub(super) fn cancel_for_window(app: &AppHandle) {
    if let Some(state) = app.try_state::<State>() { close(state.inner()); }
}
pub(super) fn relaunch_ready(app: &AppHandle) -> Result<(), String> {
    let state = app.try_state::<State>().ok_or(UNAVAILABLE)?;
    ready(state.inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn key_requires_one_trimmed_bounded_hex_without_echoing_input() {
        assert_eq!(key_arg(&[json!(" 0123456789ABCDEF ")]).unwrap(), "0123456789ABCDEF");
        for invalid in ["", "1234567", "not-a-debug-key", &"a".repeat(129)] {
            let error = key_arg(&[json!(invalid)]).unwrap_err();
            if !invalid.is_empty() { assert!(!error.contains(invalid)); }
        }
        assert!(key_arg(&[]).is_err()); assert!(key_arg(&[json!("01234567"),json!(true)]).is_err());
    }
    #[test]
    fn explicit_consent_and_same_mode_are_required() {
        let initial = consent(&json!({"mode":"normal","feedbackLogConsent":true})).unwrap();
        assert_eq!(initial, consent(&json!({"mode":"normal","feedbackLogConsent":true,"debugMode":false})).unwrap());
        assert_ne!(initial, consent(&json!({"mode":"minimal","feedbackLogConsent":true})).unwrap());
        for settings in [json!({}),json!({"mode":"local","feedbackLogConsent":true}),json!({"mode":"normal","feedbackLogConsent":false}),json!({"mode":"normal","feedbackLogConsent":"true"})] { assert!(consent(&settings).is_err()); }
    }
    #[test]
    fn payload_projects_fields_redacts_keys_and_does_not_collect_private_paths() {
        let key = "0123456789abcdef";
        let settings = json!({"mode":"normal","language":"en","selectedVersionId":"1.20","enableMultiplayer":true,"gameDir":"/private/user/game","debugKey":key,"accounts":[{"token":"private"}]});
        let snapshot = json!({"stats":{"total":2,"errorCount":1,"warnCount":0},"logs":[{"ts":3,"level":"error","message":format!("{key} /private/user/game failure"),"extra":"private"}]});
        let value = diagnostic_payload("0.7.6",&settings,&snapshot,&json!({"osRelease":"test","cpuCores":8,"totalMemMb":1024,"extra":"private"}),7,&known_secrets(&settings,key)).unwrap();
        let text = value.to_string();
        assert!(!text.contains(key)); assert!(!text.contains("/private/user/game")); assert!(!text.contains("accounts")); assert!(!text.contains("extra"));
        assert_eq!(value["launcher"]["electron"], ""); assert_eq!(value["launcher"]["gameDir"],"[本地路径未收集]");
        assert_eq!(value["stats"]["total"],2); assert_eq!(value["stats"]["sent"],1); assert_eq!(value["stats"]["errorCount"],1);
        assert!(serde_json::to_vec(&value["logs"]).unwrap().len() <= MAX_LOG_BYTES);
    }
    #[test]
    fn payload_rejects_oversized_or_inconsistent_private_snapshots() {
        let settings = json!({"mode":"normal","feedbackLogConsent":true});
        let system = json!({});
        for snapshot in [
            json!({"stats":{"total":0,"errorCount":1,"warnCount":0},"logs":[]}),
            json!({"stats":{"total":1,"errorCount":0,"warnCount":0},"logs":[{"ts":1,"level":"info","message":"x".repeat(8001)}]}),
            json!({"stats":{"total":1,"errorCount":0,"warnCount":0},"logs":[{"ts":1,"level":"trace","message":"x"}]}),
        ] { assert!(diagnostic_payload("v",&settings,&snapshot,&system,1,&[]).is_err()); }
        let settings = json!({"aiHeaders":json!({"X-Secret":"short-private-value"}).to_string()});
        let secrets = known_secrets(&settings,"0123456789abcdef");
        assert!(secrets.contains(&"short-private-value".into()));
    }
    #[test]
    fn response_never_coerces_false_fraction_negative_or_string_remaining() {
        assert_eq!(parse_success(br#"{"ok":true,"remaining":0}"#).unwrap()["remaining"],0);
        for value in [json!({"ok":false,"remaining":1,"error":"private"}),json!({"ok":true,"remaining":-1}),json!({"ok":true,"remaining":1.5}),json!({"ok":true,"remaining":"2"}),json!({"ok":"true","remaining":2}),json!({"ok":true})] {
            let error = parse_success(&serde_json::to_vec(&value).unwrap()).unwrap_err(); assert!(!error.contains("private"));
        }
        assert!(parse_success(&vec![b' ';MAX_RESPONSE_BYTES+1]).is_err());
    }
    #[test]
    fn cancellation_only_signals_until_real_owner_finishes_and_unknown_drop_is_sticky() {
        let state = State::default(); let gate = crate::lifecycle::Gate::default();
        let owner = reserve(&state,Some(gate.enter().unwrap())).unwrap(); let task = owner.task.clone();
        drop(CallerSignal(task.clone())); assert!(task.check().is_err()); assert!(ready(&state).is_err()); assert!(gate.begin_restart().is_err());
        owner.finish(); assert!(ready(&state).is_ok()); drop(gate.begin_restart().unwrap());
        let owner = reserve(&state,None).unwrap(); drop(owner); assert!(ready(&state).is_err()); assert!(reserve(&state,None).is_err());
    }
    #[test]
    fn window_close_and_busy_rejection_do_not_clear_active_registration() {
        let state = State::default(); let gate = crate::lifecycle::Gate::default();
        let owner = reserve(&state,Some(gate.enter().unwrap())).unwrap();
        assert!(reserve(&state,Some(gate.enter().unwrap())).is_err()); close(&state);
        assert!(owner.task.check().is_err()); assert!(ready(&state).is_err()); owner.finish();
        assert!(ready(&state).is_err()); assert!(reserve(&state,None).is_err());
    }
    #[test]
    fn poisoned_or_locked_registry_fails_closed_without_clearing_owner() {
        let state = State::default(); let owner = reserve(&state,None).unwrap();
        let guard = state.slot.lock().unwrap(); assert!(ready(&state).is_err()); drop(guard);
        let poisoned = state.slot.clone();
        let _ = std::thread::spawn(move || { let _guard = poisoned.lock().unwrap(); panic!("fixture poison"); }).join();
        assert!(ready(&state).is_err()); assert!(reserve(&state,None).is_err());
        owner.finish(); assert!(ready(&state).is_err());
    }
    #[tokio::test]
    async fn dropped_caller_detaches_owned_worker_until_blocking_work_returns() {
        let state = State::default(); let gate = crate::lifecycle::Gate::default();
        let owner = reserve(&state,Some(gate.enter().unwrap())).unwrap(); let task = owner.task.clone();
        let (entered, started) = tokio::sync::oneshot::channel(); let (release, waiting) = std::sync::mpsc::channel();
        let (finished, done) = tokio::sync::oneshot::channel();
        let worker = tokio::spawn(async move {
            tokio::task::spawn_blocking(move || { let _ = entered.send(()); waiting.recv_timeout(Duration::from_secs(3)).unwrap(); }).await.unwrap();
            owner.finish(); let _ = finished.send(());
        });
        let (waiting, signalled) = tokio::sync::oneshot::channel(); let signal = task.clone();
        let caller = tokio::spawn(async move { let _signal = CallerSignal(signal); let _ = waiting.send(()); let _ = worker.await; });
        tokio::time::timeout(Duration::from_secs(2),started).await.unwrap().unwrap();
        tokio::time::timeout(Duration::from_secs(2),signalled).await.unwrap().unwrap();
        caller.abort(); let _ = caller.await; assert!(task.check().is_err()); assert!(ready(&state).is_err()); assert!(gate.begin_restart().is_err());
        release.send(()).unwrap(); tokio::time::timeout(Duration::from_secs(2),done).await.unwrap().unwrap();
        assert!(ready(&state).is_ok()); drop(gate.begin_restart().unwrap());
    }
}

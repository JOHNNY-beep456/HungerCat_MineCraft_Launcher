//! WebView2 Inspector 的异步宿主：只关闭已确认的本次窗口，不关闭浏览器进程或主控制器。
use super::{check, current_main, inspector, on_ui, stamp, CloseRetry, InspectorRecord, Ticket, Windows, DENIED, UNAVAILABLE};
use serde_json::Value;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

type Result<T> = std::result::Result<T, String>;
const UNCONFIRMED: &str = "Inspector 打开或关闭未确认，已保留归属记录 / Inspector 開啟或關閉未確認，已保留歸屬記錄 / Inspector opening or closure is unconfirmed; ownership records were retained";
const CLOSE_RETRY_INTERVAL: Duration = Duration::from_millis(500);
const CLOSE_RETRY_LIMIT: u8 = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CloseDecision { Complete, Keep, Send, Wait, Unconfirmed }

fn close_decision(retry: &CloseRetry, gone: bool, alive: bool, required: bool, now: Instant) -> CloseDecision {
    if gone { return CloseDecision::Complete; }
    if !alive { return CloseDecision::Unconfirmed; }
    if !required { return CloseDecision::Keep; }
    if retry.attempts >= CLOSE_RETRY_LIMIT { return CloseDecision::Unconfirmed; }
    if retry.last_attempt.is_some_and(|last| now.saturating_duration_since(last) < CLOSE_RETRY_INTERVAL) {
        return CloseDecision::Wait;
    }
    CloseDecision::Send
}

fn record_close_attempt(retry: &mut CloseRetry, now: Instant) {
    retry.attempts = retry.attempts.saturating_add(1);
    retry.last_attempt = Some(now);
}

fn raw_main(app: &AppHandle, expected: &str) -> Result<tauri::WebviewWindow> {
    let main = app.get_webview_window("main").ok_or(UNAVAILABLE)?;
    if stamp(&main)? != expected { return Err(UNAVAILABLE.into()); }
    Ok(main)
}
fn take(app: &AppHandle) -> Result<Option<InspectorRecord>> {
    Ok(app.state::<Windows>().inspector.lock().map_err(|_| UNAVAILABLE)?.take())
}
fn put(app: &AppHandle, record: InspectorRecord) -> Result<()> {
    let state = app.state::<Windows>();
    let mut slot = state.inspector.lock().map_err(|_| UNAVAILABLE)?;
    if slot.is_some() { return Err(UNCONFIRMED.into()); }
    *slot = Some(record);
    Ok(())
}

/// 调用方持有工具操作串行门；with_webview 的真实回调返回前不释放请求登记。
async fn start(app: &AppHandle, ticket: Ticket, expected: String) -> Result<()> {
    let handle = app.clone();
    let (done, result) = tokio::sync::oneshot::channel();
    on_ui(app, move |app| {
        let main = current_main(app, &expected)?;
        check(app, ticket)?;
        let url = main.url().map_err(|_| UNAVAILABLE)?;
        let origin = match url.port() { Some(port) => format!("{}:{port}", url.host_str().ok_or(UNAVAILABLE)?), None => url.host_str().ok_or(UNAVAILABLE)?.to_owned() };
        let request = app.state::<crate::lifecycle::Gate>().enter()?;
        let request = std::sync::Arc::new(std::sync::Mutex::new(Some(request)));
        let callback_request = request.clone();
        let handle = app.clone();
        let dispatched = main.with_webview(move |platform| {
            let result = (|| {
                check(&handle, ticket)?;
                let core = unsafe { platform.controller().CoreWebView2() }.map_err(|_| UNAVAILABLE)?;
                let mut pid = 0;
                unsafe { core.BrowserProcessId(&mut pid) }.map_err(|_| UNAVAILABLE)?;
                let snapshot = inspector::snapshot(pid)?;
                // 禁用用户快捷键/菜单入口；程序入口仍需独立授权。原生调用不持有状态锁。
                unsafe { core.Settings().and_then(|settings| settings.SetAreDevToolsEnabled(false)) }.map_err(|_| UNAVAILABLE)?;
                check(&handle, ticket)?;
                put(&handle, InspectorRecord { main: expected, ticket, snapshot, origin, owned: None,
                    close_retry: CloseRetry::default(), close_required: false, uncertain: false,
                    pending: super::CleanupOwner::default(), opened: Instant::now() })?;
                if unsafe { core.OpenDevToolsWindow() }.is_err() {
                    if let Some(mut record) = take(&handle)? { record.close_required = true; put(&handle, record)?; }
                    return Err(UNCONFIRMED.into());
                }
                Ok(())
            })();
            if let Ok(mut request) = callback_request.lock() {
                if let Some(request) = request.take() { request.finish(); }
            }
            let _ = done.send(result);
        });
        if dispatched.is_err() {
            if let Ok(mut request) = request.lock() {
                if let Some(request) = request.take() { request.finish(); }
            }
            return Err(UNAVAILABLE.into());
        }
        Ok(())
    }).await?;
    result.await.map_err(|_| UNAVAILABLE.to_owned())?
}

/// 不在 inspector/binding 锁内调用 EnumWindows、WM_CLOSE、窗口或 COM。
fn advance(app: &AppHandle, explicit_close: bool) -> Result<bool> {
    let Some(mut record) = take(app)? else { return Ok(true); };
    record.close_required |= explicit_close || check(app, record.ticket).is_err();
    let result = (|| {
        if record.owned.is_none() {
            raw_main(app, &record.main)?;
            // 首次关联只限打开后的短窗口；过时记录不会领养后来出现的 Inspector。
            if record.opened.elapsed() > Duration::from_secs(2) { return Err(UNCONFIRMED.into()); }
            record.owned = inspector::capture(&record.snapshot, &record.origin)?;
        }
        let Some(owned) = record.owned.as_ref() else { return Ok(false); };
        let gone = owned.gone();
        let alive = !gone && owned.alive();
        match close_decision(&record.close_retry, gone, alive, record.close_required, Instant::now()) {
            CloseDecision::Complete => Ok(true),
            CloseDecision::Keep | CloseDecision::Wait => Ok(false),
            CloseDecision::Send => {
                let sent = owned.close();
                record_close_attempt(&mut record.close_retry, Instant::now());
                sent?;
                Ok(false)
            }
            CloseDecision::Unconfirmed => Err(UNCONFIRMED.into()),
        }
    })();
    record.uncertain |= result.is_err();
    if matches!(result, Ok(true)) {
        record.pending.finish();
    } else { put(app, record)?; }
    result
}
async fn poll(app: &AppHandle, close: bool) -> Result<()> {
    for _ in 0..9 {
        let done = on_ui(app, move |app| advance(app, close)).await?;
        if close && done { return Ok(()); }
        if !close {
            let handle = app.clone();
            let ready = on_ui(app, move |app| {
                let Some(record) = take(app)? else { return Err(UNCONFIRMED.into()); };
                let result = (|| {
                    current_main(&handle, &record.main)?;
                    check(app, record.ticket)?;
                    if record.close_required { return Err(DENIED.into()); }
                    Ok(record.owned.as_ref().is_some_and(|owned| owned.alive()))
                })();
                put(app, record)?;
                result
            }).await?;
            if ready { return Ok(()); }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err(UNCONFIRMED.into())
}
pub(super) async fn open(app: &AppHandle, ticket: Ticket, expected: String) -> Result<Value> {
    let focus_main = expected.clone();
    let existing = on_ui(app, move |app| {
        current_main(app, &focus_main)?;
        check(app, ticket)?;
        let Some(mut record) = take(app)? else { return Ok(false); };
        let reusable = record.main == focus_main && record.ticket == ticket && !record.close_required && !record.uncertain
            && check(app, record.ticket).is_ok() && record.owned.as_ref().is_some_and(|owned| owned.alive());
        let result = (|| {
            if !reusable { return Ok(false); }
            record.owned.as_ref().ok_or(UNCONFIRMED)?.focus()?;
            current_main(app, &focus_main)?;
            check(app, ticket)?;
            if !record.owned.as_ref().is_some_and(|owned| owned.alive()) { return Err(UNCONFIRMED.into()); }
            Ok(true)
        })();
        if result.is_err() { record.close_required = true; record.uncertain = true; }
        put(app, record)?;
        result
    }).await?;
    if existing { return Ok(Value::Bool(true)); }
    let occupied = app.state::<Windows>().inspector.lock().map_err(|_| UNAVAILABLE)?.is_some();
    if occupied { poll(app, true).await?; }
    start(app, ticket, expected).await?;
    if let Err(error) = poll(app, false).await {
        let _ = on_ui(app, |app| advance(app, true)).await;
        return Err(error);
    }
    Ok(Value::Bool(true))
}
pub(super) async fn close(app: &AppHandle) -> Result<Value> { poll(app, true).await.map(|_| Value::Null) }
pub(super) async fn maintain(app: &AppHandle) -> Result<()> {
    let serial = app.state::<Windows>().serial.clone();
    let Ok(_serial) = serial.try_lock() else { return Ok(()); };
    on_ui(app, |app| advance(app, false).map(|_| ())).await
}
pub(super) fn unconfirmed(app: &AppHandle) -> bool {
    let state = app.state::<Windows>();
    let status = state.inspector.lock().map(|slot| slot.as_ref().map(|record| {
        (record.ticket, record.owned.is_none() || record.close_required || record.uncertain)
    }));
    match status {
        Ok(Some((ticket, pending))) => pending || check(app, ticket).is_err(),
        Ok(None) => false,
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_retry_is_rate_limited_and_stops_at_the_fixed_attempt_cap() {
        let start = Instant::now();
        let mut retry = CloseRetry::default();
        for attempt in 0..CLOSE_RETRY_LIMIT {
            let at = start + CLOSE_RETRY_INTERVAL * u32::from(attempt);
            assert_eq!(close_decision(&retry, false, true, true, at), CloseDecision::Send);
            record_close_attempt(&mut retry, at);
            if attempt + 1 < CLOSE_RETRY_LIMIT {
                assert_eq!(close_decision(&retry, false, true, true, at + CLOSE_RETRY_INTERVAL - Duration::from_millis(1)), CloseDecision::Wait);
            }
        }
        assert_eq!(retry.attempts, CLOSE_RETRY_LIMIT);
        assert_eq!(close_decision(&retry, false, true, true, start + CLOSE_RETRY_INTERVAL * 10), CloseDecision::Unconfirmed);
    }

    #[test]
    fn close_retry_requires_confirmed_identity_and_only_gone_completes() {
        let retry = CloseRetry::default();
        let now = Instant::now();
        assert_eq!(close_decision(&retry, false, false, true, now), CloseDecision::Unconfirmed);
        assert_eq!(close_decision(&retry, false, true, false, now), CloseDecision::Keep);
        assert_eq!(close_decision(&retry, true, false, true, now), CloseDecision::Complete);
    }
}

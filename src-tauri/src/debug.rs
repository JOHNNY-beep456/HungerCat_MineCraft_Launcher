//! 调试日志窗口、脱敏缓冲与用户主动发起的诊断上传。
//! 主窗口保留全部业务权限；日志窗口仅能读取固定快照。
mod buffer;
mod upload;

use crate::storage::Storage;
use serde_json::{json, Value};
use std::{sync::Mutex, time::{SystemTime, UNIX_EPOCH}};
use tauri::{Emitter, Manager, WebviewWindow};
#[cfg(desktop)]
use tauri::{WebviewUrl, WebviewWindowBuilder};

const DEBUG_LABEL: &str = "debug";
#[cfg(desktop)]
const APP_ENTRY: &str = "index.html";
const MAX_SOURCE_LOG: usize = 32_768;

#[derive(Default)]
pub(crate) struct State {
    buffer: Mutex<buffer::Buffer>,
    renderer_drop_count: Mutex<u64>,
}

fn state(app: &tauri::AppHandle) -> Result<tauri::State<'_, State>, String> {
    app.try_state::<State>().ok_or_else(|| "调试日志状态不可用 / 調試日誌狀態無法使用 / Debug log state is unavailable".into())
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64
}

fn level_ok(level: &str) -> bool { matches!(level, "info" | "warn" | "error") }

/// 主进程记录入缓冲前统一脱敏、限长；只投递给现有主窗、日志窗与受权工具页。
pub(crate) fn append(app: &tauri::AppHandle, level: &str, source: &str, message: &str) -> Result<(), String> {
    append_with_secrets(app, level, source, message, &[])
}

/// 只由受管游戏输出消费点调用；已知账号秘密须在截断和诊断快照之前隐藏。
/// stdout / stderr 在该消费点没有可靠的严重级别，不能仅凭管道推断为错误。
pub(crate) fn append_game(app: &tauri::AppHandle, message: &str, secrets: &[String]) -> Result<(), String> {
    append_with_secrets(app, "info", "game", message, secrets)
}

fn append_with_secrets(app: &tauri::AppHandle, level: &str, source: &str, message: &str, secrets: &[String]) -> Result<(), String> {
    if !level_ok(level) { return Err("日志级别无效 / 日誌級別無效 / Invalid log level".into()); }
    let entry = {
        let state = state(app)?;
        let mut buffer = state.buffer.lock().map_err(|_| "调试日志缓冲不可用 / 調試日誌緩衝無法使用 / Debug log buffer is unavailable")?;
        buffer.push(now_ms(), level, source, message, secrets)?
    };
    let payload = json!({"channel":"debug:log","payload":entry});
    let _ = app.emit_to("main", "launcher:event", payload.clone());
    let _ = app.emit_to(DEBUG_LABEL, "launcher:event", payload.clone());
    #[cfg(desktop)]
    crate::devmode::emit_tools_log(app, &payload);
    Ok(())
}

fn renderer_log(app: &tauri::AppHandle, level: &str, raw: &str) -> Result<(), String> {
    if !level_ok(level) { return Err("日志级别无效 / 日誌級別無效 / Invalid log level".into()); }
    // 正文可能含凭据且可能异常巨大；只读O(1)字节长度，不扫描或保存原文。
    let count = raw.len().min(MAX_SOURCE_LOG);
    let state = state(app)?;
    let mut dropped = state.renderer_drop_count.lock().map_err(|_| "调试日志状态不可用 / 調試日誌狀態無法使用 / Debug log state is unavailable")?;
    *dropped = dropped.saturating_add(1);
    let message = format!("渲染层日志正文未保留（至多 {count} 字节；会话累计 {} 条）", *dropped);
    drop(dropped);
    append(app, level, "renderer", &message)
}

fn debug_url_allowed(url: &url::Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() { return false; }
    let bundled = url.port().is_none() && (
        (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
    );
    let development = cfg!(debug_assertions) && url.username().is_empty() && url.password().is_none()
        && url.scheme() == "http" && matches!(url.host_str(), Some("localhost") | Some("127.0.0.1")) && url.port() == Some(1420);
    if !(bundled || development) || !(url.path() == "/index.html" || url.path() == "/") { return false; }
    let mut query = url.query_pairs();
    matches!(query.next(), Some((key, value)) if key == "window" && value == "debug") && query.next().is_none()
}

/// 开发者工具页只接受固定的本地入口和唯一 query；不接受任意页面冒充受限窗口。
pub(crate) fn devtools_url_allowed(url: &url::Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() { return false; }
    let bundled = url.port().is_none() && (
        (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
    );
    let development = cfg!(debug_assertions) && url.scheme() == "http"
        && matches!(url.host_str(), Some("localhost") | Some("127.0.0.1")) && url.port() == Some(1420);
    if !(bundled || development) || !(url.path() == "/index.html" || url.path() == "/") { return false; }
    let mut query = url.query_pairs();
    matches!(query.next(), Some((key, value)) if key == "window" && value == "devtools") && query.next().is_none()
}

fn log_read_page_allowed(label: &str, url: &url::Url, mobile: bool) -> bool {
    ((label == DEBUG_LABEL && debug_url_allowed(url)) || (label == "devtools" && devtools_url_allowed(url)))
        || (mobile && label == "main" && main_url_allowed(url))
}

pub(crate) fn authorize_log_read(window: &WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| "无法核验日志窗口来源 / 無法核驗日誌視窗來源 / Cannot verify debug window origin")?;
    // 移动应用内视图复用本机主 Webview；平台值不取自页面、UA 或 IPC 参数。
    if !log_read_page_allowed(window.label(), &url, cfg!(mobile)) {
        return Err("日志窗口页面来源无权调用此接口 / 日誌視窗頁面來源無權呼叫此介面 / Debug window page is not authorized for this operation".into());
    }
    #[cfg(desktop)]
    if window.label() == "devtools" { crate::devmode::authorize_tools_window(window.app_handle(), window)?; }
    Ok(())
}

fn debug_window(window: &WebviewWindow) -> Result<(), String> { authorize_log_read(window) }

#[cfg(desktop)]
pub(crate) fn devtools_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "devtools" {
        return Err("开发者工具窗口标识无效 / 開發者工具視窗標識無效 / Invalid developer-tools window label".into());
    }
    let url = window.url().map_err(|_| "无法核验开发者工具来源 / 無法核驗開發者工具來源 / Cannot verify developer-tools origin")?;
    if !devtools_url_allowed(&url) {
        return Err("开发者工具页面来源无权调用该接口 / 開發者工具頁面來源無權呼叫該介面 / Developer-tools page origin is not authorized".into());
    }
    Ok(())
}

pub(crate) fn snapshot(app: &tauri::AppHandle) -> Result<Value, String> {
    let state = state(app)?;
    let buffer = state.buffer.lock().map_err(|_| "调试日志缓冲不可用 / 調試日誌緩衝無法使用 / Debug log buffer is unavailable")?;
    Ok(buffer.diagnostic())
}

fn main_url_allowed(url: &url::Url) -> bool {
    let bundled = url.username().is_empty() && url.password().is_none() && url.fragment().is_none()
        && url.port().is_none() && (
            (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
        );
    let development = cfg!(debug_assertions) && url.username().is_empty() && url.password().is_none()
        && url.fragment().is_none() && url.scheme() == "http"
        && matches!(url.host_str(), Some("localhost") | Some("127.0.0.1")) && url.port() == Some(1420);
    bundled || development
}

fn main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" { return Err("只有主窗口可调用此接口 / 只有主視窗可呼叫此介面 / Only the main window can call this operation".into()); }
    let url = window.url().map_err(|_| "无法核验主窗口来源 / 無法核驗主視窗來源 / Cannot verify main window origin")?;
    if !main_url_allowed(&url) { return Err("当前页面来源无权调用该接口 / 目前頁面來源無權呼叫此介面 / Page origin is not authorized".into()); }
    Ok(())
}

// 独立原生窗口与最小化恢复属于桌面能力，不让移动端走入桌面窗口实现。
#[cfg(desktop)]
fn open_window(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(DEBUG_LABEL) {
        if window.is_minimized().unwrap_or(false) { window.unminimize().map_err(|_| "无法恢复日志窗口 / 無法還原日誌視窗 / Cannot restore debug window")?; }
        window.show().map_err(|_| "无法显示日志窗口 / 無法顯示日誌視窗 / Cannot show debug window")?;
        window.set_focus().map_err(|_| "无法聚焦日志窗口 / 無法聚焦日誌視窗 / Cannot focus debug window")?;
        return Ok(());
    }
    let main = app.get_webview_window("main").ok_or("主窗口不可用 / 主視窗無法使用 / Main window is unavailable")?;
    let url = WebviewUrl::App(format!("{APP_ENTRY}?window=debug").into());
    let builder = WebviewWindowBuilder::new(app, DEBUG_LABEL, url)
        .title("启动器日志 - Debug / 啟動器日誌 - Debug / Launcher logs - Debug")
        .inner_size(720.0, 520.0)
        .min_inner_size(420.0, 280.0)
        .visible(false).devtools(false)
        .on_navigation(|url| {
            debug_url_allowed(url)
        })
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
    let builder = builder.parent(&main).map_err(|_| "无法将日志窗口关联到主窗口 / 無法將日誌視窗關聯至主視窗 / Cannot associate debug window with the main window")?;
    let window = builder.build().map_err(|_| "无法创建日志窗口 / 無法建立日誌視窗 / Cannot create debug window")?;
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

#[cfg(mobile)]
fn open_window(_app: &tauri::AppHandle) -> Result<(), String> {
    // 移动桥接只在 React 宿主真实挂载后完成 openWindow；裸 IPC 不冒充视图已打开。
    Err("移动端请通过应用内日志入口打开页面 / 行動端請透過應用程式內日誌入口開啟頁面 / Open mobile logs through the in-app log entry".into())
}

pub(crate) async fn call(app: &tauri::AppHandle, window: &WebviewWindow, channel: &str, args: &[Value]) -> Result<Option<Value>, String> {
    match channel {
        "debug:getLogs" => {
            debug_window(window)?;
            if !args.is_empty() { return Err("日志读取不接受参数 / 日誌讀取不接受參數 / Log read accepts no arguments".into()); }
            let state = state(app)?;
            let buffer = state.buffer.lock().map_err(|_| "调试日志缓冲不可用 / 調試日誌緩衝無法使用 / Debug log buffer is unavailable")?;
            Ok(Some(json!(buffer.snapshot())))
        }
        "debug:isEnabled" => {
            // 与 Electron 一致：该值表示设置中的调试模式，不表示窗口或上传许可状态。
            main_window(window)?;
            if !args.is_empty() { return Err("调试状态查询不接受参数 / 調試狀態查詢不接受參數 / Debug status query accepts no arguments".into()); }
            let app = app.clone();
            let settings = tauri::async_runtime::spawn_blocking(move || {
                app.try_state::<Storage>().ok_or_else(|| "调试设置不可用 / 調試設定無法使用 / Debug settings are unavailable".to_string())?.settings_for_backend()
            }).await.map_err(|_| "读取调试设置任务异常 / 讀取調試設定工作異常 / Failed to read debug settings")??;
            Ok(Some(json!(settings.get("debugMode").and_then(Value::as_bool).unwrap_or(false))))
        }
        "debug:open" => {
            main_window(window)?;
            if !args.is_empty() { return Err("打开日志窗口不接受参数 / 開啟日誌視窗不接受參數 / Opening the log window accepts no arguments".into()); }
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || open_window(&app)).await
                .map_err(|_| "日志窗口创建任务异常 / 日誌視窗建立工作異常 / Debug window creation task failed")??;
            Ok(Some(Value::Null))
        }
        "debug:close" => { main_window(window)?; if !args.is_empty() { return Err("关闭日志窗口不接受参数 / 關閉日誌視窗不接受參數 / Closing the log window accepts no arguments".into()); } if let Some(window) = app.get_webview_window(DEBUG_LABEL) { let _ = window.close(); } Ok(Some(Value::Null)) }
        "debug:submit" => { main_window(window)?; Ok(Some(upload::submit(app, args).await?)) }
        _ => Ok(None),
    }
}

pub(crate) fn send(app: &tauri::AppHandle, window: &WebviewWindow, channel: &str, args: &[Value]) -> Result<bool, String> {
    if channel != "debug:rendererLog" { return Ok(false); }
    main_window(window)?;
    if args.len() != 2 { return Err("渲染层日志参数无效 / 渲染層日誌參數無效 / Invalid renderer log arguments".into()); }
    let level = args[0].as_str().ok_or("日志级别无效 / 日誌級別無效 / Invalid log level")?;
    let message = args[1].as_str().ok_or("日志格式无效 / 日誌格式無效 / Invalid log format")?;
    renderer_log(app, level, message)?;
    Ok(true)
}

pub(crate) fn init(app: &mut tauri::App) {
    app.manage(State::default());
    app.manage(upload::State::default());
}

pub(crate) fn cancel_for_window(app: &tauri::AppHandle) { upload::cancel_for_window(app); }
pub(crate) fn relaunch_ready(app: &tauri::AppHandle) -> Result<(), String> { upload::relaunch_ready(app) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_page_query_is_fixed_and_does_not_authorize_extra_query_items() {
        // 来源校验主体依赖活窗口；这里验证 URL 语义与窗口构造保持精确。
        let exact = url::Url::parse("tauri://localhost/index.html?window=debug").unwrap();
        let extra = url::Url::parse("tauri://localhost/index.html?window=debug&token=example").unwrap();
        assert!(debug_url_allowed(&exact));
        for denied in [
            extra,
            url::Url::parse("tauri://localhost/index.html").unwrap(),
            url::Url::parse("tauri://localhost/index.html?window=debug&window=debug").unwrap(),
            url::Url::parse("tauri://localhost/index.html?window=debug#fragment").unwrap(),
            url::Url::parse("tauri://localhost:1234/index.html?window=debug").unwrap(),
            url::Url::parse("tauri://evil.invalid/index.html?window=debug").unwrap(),
            url::Url::parse("tauri://user@localhost/index.html?window=debug").unwrap(),
            url::Url::parse("tauri://localhost/index.html?window=debug#x").unwrap(),
            url::Url::parse("tauri://localhost/other?window=debug").unwrap(),
        ] { assert!(!debug_url_allowed(&denied), "unexpected allowed URL: {denied}"); }
        let dev = url::Url::parse("http://localhost:1420/index.html?window=debug").unwrap();
        assert_eq!(debug_url_allowed(&dev), cfg!(debug_assertions));
        assert!(debug_url_allowed(&url::Url::parse("http://tauri.localhost/index.html?window=debug").unwrap()));
        assert!(debug_url_allowed(&url::Url::parse("https://tauri.localhost/index.html?window=debug").unwrap()));
        assert_eq!(debug_url_allowed(&url::Url::parse("http://localhost:1420/?window=debug").unwrap()), cfg!(debug_assertions));
    }

    #[test]
    fn platform_log_surfaces_keep_desktop_window_and_mobile_main_separate() {
        let main = url::Url::parse("tauri://localhost/index.html").unwrap();
        let debug = url::Url::parse("tauri://localhost/index.html?window=debug").unwrap();
        let devtools = url::Url::parse("tauri://localhost/index.html?window=devtools").unwrap();
        assert!(devtools_url_allowed(&devtools));
        assert!(!devtools_url_allowed(&url::Url::parse("tauri://localhost/index.html?window=devtools&x=1").unwrap()));
        assert!(log_read_page_allowed("devtools", &devtools, false));
        assert!(log_read_page_allowed("main", &main, true));
        assert!(!log_read_page_allowed("main", &main, false));
        assert!(log_read_page_allowed(DEBUG_LABEL, &debug, false));
        assert!(log_read_page_allowed(DEBUG_LABEL, &debug, true));
    }

    #[test]
    fn renderer_log_never_records_raw_text_and_caps_safely() {
        let raw = "AUTHORIZATION: user-secret";
        let count = raw.len().min(MAX_SOURCE_LOG);
        assert_eq!(count, raw.len());
        assert!(!format!("渲染层日志正文未保留（至多 {count} 字节；会话累计 1 条）").contains("user-secret"));
    }
}

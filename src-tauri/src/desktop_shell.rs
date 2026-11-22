//! 桌面关窗意图与真实退出分离；取消、托盘隐藏都不关闭业务门禁。
use crate::storage::{CloseBehavior, ShellPreferences, Storage};
use raw_window_handle::HasWindowHandle;
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

type Result<T> = std::result::Result<T, String>;
const TRAY_ID: &str = "hcmcl-main-tray";
const SHOW_ID: &str = "hcmcl-tray-show";
const QUIT_ID: &str = "hcmcl-tray-quit";

#[derive(Default)]
struct State { prompt: AtomicBool, exiting: AtomicBool, exit_ready: AtomicBool }
impl State {
    fn begin_exit(&self, gate: &crate::lifecycle::Gate) -> bool {
        if self.exiting.swap(true, Ordering::AcqRel) { return false; }
        gate.close_once();
        true
    }
    fn permits_exit(&self, code: Option<i32>) -> bool {
        // 只放行后台清理完成后主动重发的退出；窗口消失引发的 None 不得抢先结束事件循环。
        code.is_some() && self.exit_ready.load(Ordering::Acquire)
    }
}

fn preferences(app: &AppHandle) -> ShellPreferences {
    app.try_state::<Storage>().map(|storage| storage.shell_preferences()).unwrap_or_default()
}
fn text(language: &str, cn: &str, tw: &str, en: &str) -> String {
    if language == "en" || language.starts_with("en-") || language.starts_with("en_") { en.into() }
    else if language == "zh-TW" || language.starts_with("zh_TW") || language.starts_with("zh-HK") { tw.into() }
    else { cn.into() }
}
fn unavailable(language: &str) -> String {
    text(language, "主窗口已关闭或被替换", "主視窗已關閉或被替換", "The main window is closed or replaced")
}
fn stamp(window: &WebviewWindow) -> Result<String> {
    window.window_handle().map(|handle| format!("{:?}", handle.as_raw())).map_err(|_| unavailable("zh-CN"))
}
fn current(app: &AppHandle, expected: &str) -> Result<WebviewWindow> {
    let window = app.get_webview_window("main").ok_or_else(|| unavailable("zh-CN"))?;
    if stamp(&window)? != expected { return Err(unavailable("zh-CN")); }
    // 原生 X / 托盘 / 确认框只绑定真实窗口，不受页面 URL 约束；业务 IPC 仍独立校验来源。
    Ok(window)
}

pub(crate) fn init(app: &AppHandle) {
    app.manage(Arc::new(State::default()));
    // 仅注册一次；重建托盘不能积累全局菜单监听器。
    app.on_menu_event(|app, event| match event.id().as_ref() {
        SHOW_ID => restore(app),
        QUIT_ID => exit(app),
        _ => {}
    });
}

fn report(app: &AppHandle, message: &str) {
    let language = preferences(app).language;
    let _ = crate::debug::append(app, "warn", "window", message);
    if let Some(window) = app.get_webview_window("main") {
        // 失败时保留恢复入口；此提示由关窗/托盘动作触发，不含路径或账号。
        let _ = window.show();
        app.dialog().message(message)
            .title(text(&language, "关闭启动器", "關閉啟動器", "Close launcher"))
            .kind(MessageDialogKind::Warning).parent(&window).show(|_| {});
    }
}
fn restore_result(app: &AppHandle) -> Result<()> {
    let state = app.state::<Arc<State>>();
    if state.exiting.load(Ordering::Acquire) { return Ok(()); }
    let window = app.get_webview_window("main").ok_or_else(|| unavailable(&preferences(app).language))?;
    // 托盘恢复属于原生操作；错误页或未知页面来源也必须能恢复同一原生窗口。
    let window = current(app, &stamp(&window)?)?;
    window.unminimize().map_err(|_| unavailable("zh-CN"))?;
    window.show().map_err(|_| unavailable("zh-CN"))?;
    window.set_focus().map_err(|_| unavailable("zh-CN"))?;
    Ok(())
}
fn restore(app: &AppHandle) {
    if let Err(error) = restore_result(app) { report(app, &error); }
}

fn ensure_tray(app: &AppHandle, language: &str) -> Result<()> {
    let show = MenuItem::with_id(app, SHOW_ID, text(language, "显示主界面", "顯示主介面", "Show launcher"), true, None::<&str>);
    let quit = MenuItem::with_id(app, QUIT_ID, text(language, "退出程序", "結束程式", "Quit launcher"), true, None::<&str>);
    let error = || text(language, "系统托盘不可用，启动器保持可见", "系統匣無法使用，啟動器保持可見", "System tray is unavailable; the launcher will remain visible");
    let show = show.map_err(|_| error())?;
    let quit = quit.map_err(|_| error())?;
    let separator = PredefinedMenuItem::separator(app).map_err(|_| error())?;
    let menu = Menu::with_items(app, &[&show, &separator, &quit]).map_err(|_| error())?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu)).map_err(|_| error())?;
        tray.set_visible(true).map_err(|_| error())?;
    } else {
        let icon = app.default_window_icon().cloned().ok_or_else(error)?;
        TrayIconBuilder::with_id(TRAY_ID).icon(icon).menu(&menu)
            .tooltip(text(language, "饥饿猫我的世界启动器", "飢餓貓我的世界啟動器", "HungerCat MineCraft Launcher"))
            // Windows 使用双击恢复；macOS 左键直接打开带有恢复入口的菜单。
            .show_menu_on_left_click(cfg!(target_os = "macos"))
            .on_tray_icon_event(|tray, event| {
                if matches!(event, TrayIconEvent::DoubleClick { button: MouseButton::Left, .. }) { restore(tray.app_handle()); }
            })
            .build(app).map_err(|_| error())?;
    }
    Ok(())
}
fn tray_recoverable(app: &AppHandle, language: &str) -> Result<()> {
    let error = || text(language, "无法确认托盘恢复入口，启动器保持可见", "無法確認系統匣還原入口，啟動器保持可見", "A tray restore entry could not be confirmed; the launcher will remain visible");
    let tray = app.tray_by_id(TRAY_ID).ok_or_else(error)?;
    // build/set_visible 不保证操作系统已注册图标。Windows/macOS 必须取得真实托盘矩形。
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    { if tray.rect().map_err(|_| error())?.is_none() { return Err(error()); } }
    // GTK AppIndicator 无矩形/宿主确认接口；未核验恢复入口前保持可见。
    #[cfg(target_os = "linux")]
    { let _ = tray; return Err(error()); }
    #[allow(unreachable_code)]
    Ok(())
}
fn keep_in_background(app: &AppHandle, identity: &str, language: &str) -> Result<()> {
    let window = current(app, identity)?;
    ensure_tray(app, language)?;
    tray_recoverable(app, language)?;
    if app.state::<Arc<State>>().exiting.load(Ordering::Acquire) { return Ok(()); }
    window.hide().map_err(|_| unavailable(language))
}

pub(crate) fn sync_preferences(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if handle.state::<Arc<State>>().exiting.load(Ordering::Acquire) { return; }
        let preferences = preferences(&handle);
        if preferences.close_behavior == CloseBehavior::Tray {
            if let Err(error) = ensure_tray(&handle, &preferences.language) { report(&handle, &error); }
        } else {
            // 隐藏时仍保留唯一恢复入口；可见后才能移除。
            if handle.get_webview_window("main").and_then(|window| window.is_visible().ok()) == Some(true) {
                handle.remove_tray_by_id(TRAY_ID);
            }
        }
    });
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Choice { Quit, Background, Cancel }
fn selected(result: MessageDialogResult, quit: &str, background: &str) -> Choice {
    match result {
        MessageDialogResult::Custom(value) if value == quit => Choice::Quit,
        MessageDialogResult::Custom(value) if value == background => Choice::Background,
        _ => Choice::Cancel,
    }
}
struct Prompt(Arc<State>);
impl Drop for Prompt { fn drop(&mut self) { self.0.prompt.store(false, Ordering::Release); } }

pub(crate) fn request_close(app: &AppHandle) {
    let state = app.state::<Arc<State>>().inner().clone();
    if state.exiting.load(Ordering::Acquire) { return; }
    let preferences = preferences(app);
    let Some(window) = app.get_webview_window("main") else { return; };
    let identity = match stamp(&window) { Ok(value) => value, Err(error) => { report(app, &error); return; } };
    if let Err(error) = current(app, &identity) { report(app, &error); return; }
    match preferences.close_behavior {
        CloseBehavior::Quit => exit(app),
        CloseBehavior::Tray => if let Err(error) = keep_in_background(app, &identity, &preferences.language) { report(app, &error); },
        CloseBehavior::Ask => {
            if state.prompt.swap(true, Ordering::AcqRel) { return; }
            let prompt = Prompt(state);
            let language = preferences.language;
            let quit = text(&language, "完全关闭", "完全關閉", "Quit launcher");
            let background = text(&language, "退至后台", "退至背景", "Keep in background");
            let cancel = text(&language, "取消", "取消", "Cancel");
            let handle = app.clone();
            app.dialog().message(text(&language,
                "要关闭启动器吗？\n「完全关闭」将退出程序；「退至后台」将隐藏主窗口，程序继续运行。\n可在「设置 → 模式 → 关闭按钮行为」中固定这个选择。",
                "要關閉啟動器嗎？\n「完全關閉」將結束程式；「退至背景」將隱藏主視窗，程式繼續執行。\n可在「設定 → 模式 → 關閉按鈕行為」中固定這個選擇。",
                "Close the launcher?\nQuit launcher exits the application. Keep in background hides the main window while the application continues running.\nYou can save this choice under Settings → Mode → Close button behavior."))
                .title(text(&language, "关闭启动器", "關閉啟動器", "Close launcher"))
                .kind(MessageDialogKind::Info).parent(&window)
                .buttons(MessageDialogButtons::YesNoCancelCustom(quit.clone(), background.clone(), cancel))
                .show_with_result(move |result| {
                    let choice = selected(result, &quit, &background);
                    let callback = handle.clone();
                    // 回调可能来自系统线程；检查身份和原生动作仍在 UI 队列执行。
                    let _ = handle.run_on_main_thread(move || {
                        let _prompt = prompt;
                        if callback.state::<Arc<State>>().exiting.load(Ordering::Acquire) { return; }
                        if current(&callback, &identity).is_err() { return; }
                        match choice {
                            Choice::Quit => exit(&callback),
                            Choice::Background => if let Err(error) = keep_in_background(&callback, &identity, &language) { report(&callback, &error); },
                            Choice::Cancel => {}
                        }
                    });
                });
        }
    }
}

enum Exit { Quit(i32), Restart }

fn schedule_exit(app: &AppHandle, action: Exit) -> bool {
    let state = app.state::<Arc<State>>();
    if !state.begin_exit(app.state::<crate::lifecycle::Gate>().inner()) { return false; }
    let handle = app.clone();
    // 部分取消与最终发布共用锁。保留事务先后，但不要在系统窗口回调里等待磁盘。
    tauri::async_runtime::spawn(async move {
        let cancel_handle = handle.clone();
        let cancelled = tauri::async_runtime::spawn_blocking(move || crate::cancel_main_domains(&cancel_handle)).await;
        let cleanup = match cancelled {
            Ok(()) => {
                // 每个独立窗口域都必须尝试收尾；一项失败不能跳过其余项，排队 destroy 不等于完成。
                let voice = crate::ai_voice::shutdown(&handle).await;
                let lyrics = crate::lyrics::shutdown(&handle).await;
                let multiplayer = crate::multiplayer::shutdown(&handle).await;
                let hud = crate::ai_hud_window::shutdown(&handle).await;
                let ball = crate::ai_ball::shutdown(&handle).await;
                let tools = crate::devmode::shutdown_tools(&handle).await;
                let errors: Vec<_> = [voice.err(), lyrics.err(), multiplayer.err(), hud.err(), ball.err(), tools.err()].into_iter().flatten().collect();
                if errors.is_empty() { Ok(()) } else { Err(errors.join("；")) }
            }
            Err(_) => Err("退出清理任务异常，尚未退出 / 結束清理工作異常，尚未結束 / Exit cleanup failed; the application has not exited".into()),
        };
        if let Err(error) = cleanup {
            // 门禁保持关闭，不宣称退出成功；原生 X/托盘可重新尝试清理，不恢复业务。
            handle.state::<Arc<State>>().exiting.store(false, Ordering::Release);
            let ui = handle.clone();
            let _ = handle.run_on_main_thread(move || report(&ui, &error));
            return;
        }
        handle.state::<Arc<State>>().exit_ready.store(true, Ordering::Release);
        match action {
            Exit::Quit(code) => handle.exit(code),
            Exit::Restart => handle.request_restart(),
        }
    });
    true
}

pub(crate) fn exit(app: &AppHandle) { schedule_exit(app, Exit::Quit(0)); }

pub(crate) fn restart(app: &AppHandle) -> Result<()> {
    if schedule_exit(app, Exit::Restart) { Ok(()) }
    else { Err(crate::lifecycle::EnterFailure::Closed.message().into()) }
}

pub(crate) fn on_exit_requested(app: &AppHandle, code: Option<i32>, api: &tauri::ExitRequestApi) {
    if app.state::<Arc<State>>().permits_exit(code) { return; }
    // 主窗口已销毁且只剩空事件循环时，仍要让取消任务有机会完成；完成后重发退出。
    api.prevent_exit();
    schedule_exit(app, Exit::Quit(code.unwrap_or(0)));
}

pub(crate) fn on_exit(app: &AppHandle) { app.remove_tray_by_id(TRAY_ID); }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dialog_dismissal_and_unrecognized_result_are_cancel() {
        assert_eq!(selected(MessageDialogResult::Custom("quit".into()), "quit", "background"), Choice::Quit);
        assert_eq!(selected(MessageDialogResult::Custom("background".into()), "quit", "background"), Choice::Background);
        for value in [MessageDialogResult::Cancel, MessageDialogResult::Yes, MessageDialogResult::No,
            MessageDialogResult::Ok, MessageDialogResult::Custom("unexpected".into())] {
            assert_eq!(selected(value, "quit", "background"), Choice::Cancel);
        }
    }
    #[test]
    fn only_explicit_exit_after_cleanup_can_end_the_event_loop() {
        let state = State::default();
        let gate = crate::lifecycle::Gate::default();
        let inflight = gate.enter().unwrap();
        assert!(!state.permits_exit(None));
        assert!(state.begin_exit(&gate));
        assert!(!state.begin_exit(&gate));
        assert!(matches!(gate.enter_classified(), Err(crate::lifecycle::EnterFailure::Closed)));
        assert!(!state.permits_exit(Some(0)));
        assert!(!state.permits_exit(None));
        inflight.finish();
        state.exit_ready.store(true, Ordering::Release);
        assert!(!state.permits_exit(None));
        assert!(state.permits_exit(Some(0)));
        assert!(state.permits_exit(Some(tauri::RESTART_EXIT_CODE)));
    }

    #[test]
    fn prompt_lease_prevents_duplicate_dialog_and_releases_on_drop() {
        let state = Arc::new(State::default());
        assert!(!state.prompt.swap(true, Ordering::AcqRel));
        let prompt = Prompt(state.clone());
        assert!(state.prompt.swap(true, Ordering::AcqRel));
        drop(prompt);
        assert!(!state.prompt.load(Ordering::Acquire));
    }
}

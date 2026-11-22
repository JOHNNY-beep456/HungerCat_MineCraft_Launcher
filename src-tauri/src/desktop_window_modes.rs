//! 主窗口全屏模式：所有原生动作在 UI 回调内串行执行；计时器只投递带代次的维护请求。
use serde_json::Value;
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use raw_window_handle::HasWindowHandle;

type Result<T> = std::result::Result<T, String>;
#[derive(Clone, Copy, Debug)]
enum Command { Desktop(bool), Security(bool), Fullscreen(bool), Top(bool), Maximize, Minimize, Close, IsMaximized }
impl Command {
    fn parse(channel: &str, args: &[Value]) -> Result<Option<Self>> {
        let boolean = |make: fn(bool) -> Self| {
            if args.len() != 1 { return Err(super::invalid()); }
            args[0].as_bool().map(make).ok_or_else(super::invalid)
        };
        let empty = |value| if args.is_empty() { Ok(Some(value)) } else { Err(super::invalid()) };
        match channel {
            "window:setDesktopMode" => boolean(Self::Desktop).map(Some),
            "window:securityFullscreen" => boolean(Self::Security).map(Some),
            "window:setFullscreen" => boolean(Self::Fullscreen).map(Some),
            "window:setAlwaysOnTop" => boolean(Self::Top).map(Some),
            "window:maximize" => empty(Self::Maximize), "window:minimize" => empty(Self::Minimize),
            "window:close" => empty(Self::Close), "window:isMaximized" => empty(Self::IsMaximized),
            _ => Ok(None),
        }
    }
}
fn guarded<T>(gate: &crate::lifecycle::Gate, work: impl FnOnce() -> Result<T>) -> Result<T> {
    let request = gate.enter()?;
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(work)) {
        Ok(result) => { request.finish(); result }
        // 未确认的原生调用保留 Gate 的 uncertain，不能让重启绕过失败。
        Err(_) => Err(unavailable()),
    }
}
fn unavailable() -> String { super::tr("窗口已关闭、被替换或状态未确认", "視窗已關閉、被替換或狀態未確認", "The window is closed, replaced, or its state is unconfirmed") }
trait WindowOps {
    fn check(&self, token: u128) -> Result<()>;
    fn fullscreen(&self) -> Result<bool>;
    fn maximized(&self) -> Result<bool>;
    fn top(&self) -> Result<bool>;
    fn set_fullscreen(&mut self, on: bool) -> Result<()>;
    fn set_maximized(&mut self, on: bool) -> Result<()>;
    fn set_top(&mut self, on: bool) -> Result<()>;
    fn taskbar_visible(&mut self) -> Result<()>;
    fn show(&mut self) -> Result<()>;
    fn raise(&mut self) -> Result<()>;
    fn minimize(&mut self) -> Result<()>;
    fn close(&mut self) -> Result<()>;
}
fn checked<T>(ops: &mut impl WindowOps, token: u128, work: impl FnOnce(&mut dyn WindowOps) -> Result<T>) -> Result<T> {
    ops.check(token)?;
    let result = work(ops)?;
    ops.check(token)?;
    Ok(result)
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Snapshot { fullscreen: bool, maximized: bool }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Tick { token: u128, generation: u64 }
struct Model {
    token: u128, generation: u64, closed: bool, uncertain: bool,
    desktop: bool, timer: bool, security: Option<Snapshot>,
}
impl Model {
    fn new(token: u128) -> Self { Self { token, generation: 0, closed: false, uncertain: false, desktop: false, timer: false, security: None } }
    fn stop_timer(&mut self) { self.generation = self.generation.wrapping_add(1); self.timer = false; }
    fn close(&mut self) { if !self.closed { self.closed = true; self.stop_timer(); } }
    fn ticket(&self) -> Option<Tick> { if self.timer && !self.closed && !self.uncertain { Some(Tick { token: self.token, generation: self.generation }) } else { None } }
    fn apply(&mut self, command: Command, ops: &mut impl WindowOps) -> Result<Value> {
        if self.closed || self.uncertain { return Err(unavailable()); }
        ops.check(self.token)?;
        // 原生调用可能部分成功或 panic；只有整条命令正常返回才解除未知状态。
        self.uncertain = true;
        let result = self.apply_inner(command, ops);
        if result.is_ok() { self.uncertain = false; }
        result
    }
    fn apply_inner(&mut self, command: Command, ops: &mut impl WindowOps) -> Result<Value> {
        let token = self.token;
        match command {
            Command::Desktop(on) => {
                if !on || !self.desktop { self.stop_timer(); }
                self.desktop = on;
                if let Some(previous) = self.security.as_mut() { *previous = Snapshot { fullscreen: on, maximized: false }; }
                if on {
                    checked(ops, token, |w| w.taskbar_visible())?;
                    checked(ops, token, |w| w.set_top(false))?;
                    checked(ops, token, |w| w.set_fullscreen(true))?;
                    checked(ops, token, |w| w.show())?;
                    self.timer = true;
                } else {
                    checked(ops, token, |w| w.set_top(false))?;
                    checked(ops, token, |w| w.taskbar_visible())?;
                    // 安全遮罩仍存在时只更新底层目标，直到解除遮罩再恢复。
                    if self.security.is_none() { restore(ops, token, Snapshot { fullscreen: false, maximized: false })?; }
                }
                Ok(Value::Bool(on))
            }
            Command::Security(true) => {
                if self.security.is_none() {
                    let fullscreen = checked(ops, token, |w| w.fullscreen())?;
                    let maximized = checked(ops, token, |w| w.maximized())?;
                    self.security = Some(Snapshot { fullscreen, maximized });
                }
                checked(ops, token, |w| w.set_fullscreen(true))?;
                checked(ops, token, |w| w.show())?;
                checked(ops, token, |w| w.raise())?;
                Ok(Value::Bool(checked(ops, token, |w| w.fullscreen())?))
            }
            Command::Security(false) => {
                if let Some(previous) = self.security {
                    restore(ops, token, previous)?;
                    let fullscreen = checked(ops, token, |w| w.fullscreen())?;
                    self.security = None;
                    Ok(Value::Bool(fullscreen))
                } else { Ok(Value::Bool(checked(ops, token, |w| w.fullscreen())?)) }
            }
            Command::Fullscreen(on) => {
                if let Some(previous) = self.security.as_mut() {
                    previous.fullscreen = on;
                    if !on { previous.maximized = false; }
                } else {
                    checked(ops, token, |w| w.set_fullscreen(on))?;
                    if !on { checked(ops, token, |w| w.set_maximized(false))?; }
                }
                Ok(Value::Bool(checked(ops, token, |w| w.fullscreen())?))
            }
            Command::Maximize => {
                if let Some(previous) = self.security.as_mut() { previous.fullscreen = false; previous.maximized = !previous.maximized; }
                else { let on = !checked(ops, token, |w| w.maximized())?; checked(ops, token, |w| w.set_maximized(on))?; }
                Ok(Value::Null)
            }
            Command::Top(on) => { checked(ops, token, |w| w.set_top(on))?; Ok(Value::Bool(checked(ops, token, |w| w.top())?)) }
            Command::Minimize => { checked(ops, token, |w| w.minimize())?; Ok(Value::Null) }
            Command::IsMaximized => Ok(Value::Bool(checked(ops, token, |w| w.maximized())?)),
            Command::Close => {
                // 原生 close 仅提出意图，取消后模型和维护代次保持可用。
                ops.check(token)?;
                ops.close()?;
                Ok(Value::Null)
            }
        }
    }
    fn tick(&mut self, ticket: Tick, ops: &mut impl WindowOps) -> Result<()> {
        if self.ticket() != Some(ticket) { return Ok(()); }
        ops.check(ticket.token)?;
        self.uncertain = true;
        if !checked(ops, ticket.token, |w| w.fullscreen())? { checked(ops, ticket.token, |w| w.set_fullscreen(true))?; }
        self.uncertain = false;
        Ok(())
    }
}
fn restore(ops: &mut impl WindowOps, token: u128, previous: Snapshot) -> Result<()> {
    checked(ops, token, |w| w.set_fullscreen(previous.fullscreen))?;
    if !previous.fullscreen { checked(ops, token, |w| w.set_maximized(previous.maximized))?; }
    Ok(())
}

struct Timer { ticket: Tick, stop: tokio::sync::watch::Sender<bool> }
struct Binding {
    token: u128, stamp: String, closed: AtomicBool, model: Mutex<Model>, timer: Mutex<Option<Timer>>,
}
#[derive(Default)]
struct Registry(Mutex<Option<Arc<Binding>>>);
impl Binding {
    fn invalidate(&self) {
        self.closed.store(true, Ordering::Release);
        if let Ok(mut timer) = self.timer.lock() { if let Some(timer) = timer.take() { timer.stop.send_replace(true); } }
        // close 事件可能在原生 close 调用栈中同步到达，禁止等待 model 锁。
        if let Ok(mut model) = self.model.try_lock() { model.close(); }
    }
}
fn stamp<R: Runtime>(window: &WebviewWindow<R>) -> Result<String> {
    window.window_handle().map(|handle| format!("{:?}", handle.as_raw())).map_err(|_| unavailable())
}
fn binding<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) -> Result<Arc<Binding>> {
    let _ = app.manage(Registry::default());
    let state = app.state::<Registry>();
    let mut current = state.0.lock().map_err(|_| unavailable())?;
    let identity = stamp(window)?;
    if let Some(old) = current.as_ref() {
        if !old.closed.load(Ordering::Acquire) && old.stamp == identity { return Ok(old.clone()); }
        old.invalidate();
    }
    let token = uuid::Uuid::new_v4().as_u128();
    let owner = Arc::new(Binding { token, stamp: identity, closed: AtomicBool::new(false), model: Mutex::new(Model::new(token)), timer: Mutex::new(None) });
    let weak = Arc::downgrade(&owner);
    window.on_window_event(move |event| {
        if crate::invalidates_main_window(event) {
            if let Some(owner) = weak.upgrade() { owner.invalidate(); }
        }
    });
    *current = Some(owner.clone());
    Ok(owner)
}
struct NativeWindow<'a, R: Runtime> { app: &'a AppHandle<R>, window: &'a WebviewWindow<R>, binding: &'a Binding }
impl<R: Runtime> WindowOps for NativeWindow<'_, R> {
    fn check(&self, token: u128) -> Result<()> {
        if token != self.binding.token || self.binding.closed.load(Ordering::Acquire) { return Err(unavailable()); }
        let current = self.app.get_webview_window(self.window.label()).ok_or_else(unavailable)?;
        if stamp(&current)? != self.binding.stamp || stamp(self.window)? != self.binding.stamp { return Err(unavailable()); }
        Ok(())
    }
    fn fullscreen(&self) -> Result<bool> { self.window.is_fullscreen().map_err(|_| super::platform_unsupported()) }
    fn maximized(&self) -> Result<bool> { self.window.is_maximized().map_err(|_| super::platform_unsupported()) }
    fn top(&self) -> Result<bool> { self.window.is_always_on_top().map_err(|_| super::platform_unsupported()) }
    fn set_fullscreen(&mut self, on: bool) -> Result<()> { self.window.set_fullscreen(on).map_err(|_| super::platform_unsupported()) }
    fn set_maximized(&mut self, on: bool) -> Result<()> { if on { self.window.maximize() } else { self.window.unmaximize() }.map_err(|_| super::platform_unsupported()) }
    fn set_top(&mut self, on: bool) -> Result<()> { self.window.set_always_on_top(on).map_err(|_| super::platform_unsupported()) }
    fn taskbar_visible(&mut self) -> Result<()> {
        // macOS 没有 Windows/Linux 的任务栏隐藏开关，不改变 Dock 策略。
        #[cfg(any(windows, target_os = "linux"))]
        self.window.set_skip_taskbar(false).map_err(|_| super::platform_unsupported())?;
        Ok(())
    }
    fn show(&mut self) -> Result<()> { self.window.show().map_err(|_| super::platform_unsupported()) }
    // Tauri 无 Electron moveTop；聚焦只用于安全提示显式 on，不用于维护 tick。
    fn raise(&mut self) -> Result<()> { self.window.set_focus().map_err(|_| super::platform_unsupported()) }
    fn minimize(&mut self) -> Result<()> { self.window.minimize().map_err(|_| super::platform_unsupported()) }
    fn close(&mut self) -> Result<()> { self.window.close().map_err(|_| super::platform_unsupported()) }
}
fn sync_timer<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>, owner: &Arc<Binding>) -> Result<()> {
    let desired = owner.model.lock().map_err(|_| unavailable())?.ticket();
    let mut timer = owner.timer.lock().map_err(|_| unavailable())?;
    if timer.as_ref().map(|timer| timer.ticket) == desired { return Ok(()); }
    if let Some(old) = timer.take() { old.stop.send_replace(true); }
    let Some(ticket) = desired else { return Ok(()); };
    let (stop, mut stopped) = tokio::sync::watch::channel(false);
    *timer = Some(Timer { ticket, stop });
    let weak = Arc::downgrade(owner); let handle = app.clone(); let target = window.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                changed = stopped.changed() => { let _ = changed; break; }
                _ = tokio::time::sleep(std::time::Duration::from_millis(1000)) => {}
            }
            if *stopped.borrow() { break; }
            let Some(owner) = weak.upgrade() else { break; };
            if owner.closed.load(Ordering::Acquire) { break; }
            let callback_app = handle.clone(); let callback_window = target.clone();
            let (done, completed) = tokio::sync::oneshot::channel();
            if handle.run_on_main_thread(move || {
                // 票据只在真正执行的 UI 回调取得。重启已 commit 时零窗口动作。
                let result = guarded(callback_app.state::<crate::lifecycle::Gate>().inner(), || {
                    // 托盘隐藏不等于退出，暂停维护而不销毁票据；恢复可见后继续。
                    if !callback_window.is_visible().map_err(|_| unavailable())? { return Ok(()); }
                    let mut model = owner.model.lock().map_err(|_| unavailable())?;
                    let mut native = NativeWindow { app: &callback_app, window: &callback_window, binding: &owner };
                    model.tick(ticket, &mut native)
                });
                let _ = done.send(result);
            }).is_err() { break; }
            // 不堆积 tick：每轮等待前一 UI 回调真正完成。失败不清状态或安全票据。
            let _ = completed.await;
            // begin_restart 的临时封闭可能随后因业务忙碌回滚；保留原代次继续等待，
            // 不能把一次 Gate 拒绝误当作已关闭并遗失唯一 timer。
            let Some(owner) = weak.upgrade() else { break; };
            if owner.closed.load(Ordering::Acquire) || owner.model.lock().map(|model| model.ticket() != Some(ticket)).unwrap_or(true) { break; }
        }
    });
    Ok(())
}
pub(super) async fn call<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>, channel: &str, args: &[Value], language: &str) -> Result<Option<Value>> {
    let command = super::with_language(language, || Command::parse(channel, args))?;
    let Some(command) = command else { return Ok(None); };
    let app = app.clone(); let window = window.clone(); let language = language.to_owned();
    let callback_app = app.clone();
    let (send, received) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = super::with_language(&language, || {
            guarded(callback_app.state::<crate::lifecycle::Gate>().inner(), || {
                let current = callback_app.get_webview_window(window.label()).ok_or_else(unavailable)?;
                if stamp(&current)? != stamp(&window)? { return Err(unavailable()); }
                crate::trusted_main(&current)?;
                // 关闭入口不依赖可能已 unknown 的全屏模型，仍须核验真实窗口与来源。
                if matches!(command, Command::Close) {
                    current.close().map_err(|_| super::platform_unsupported())?;
                    return Ok(Some(Value::Null));
                }
                let owner = binding(&callback_app, &window)?;
                let result = {
                    let mut model = owner.model.lock().map_err(|_| unavailable())?;
                    let mut native = NativeWindow { app: &callback_app, window: &window, binding: &owner };
                    model.apply(command, &mut native)
                };
                // 即使命令部分失败也停掉失效计时器，未知状态仍保留在 model。
                let timer = sync_timer(&callback_app, &window, &owner);
                match (result, timer) { (Ok(value), Ok(())) => Ok(Some(value)), (Err(error), _) | (_, Err(error)) => Err(error) }
            })
        });
        let _ = send.send(result);
    }).map_err(|_| unavailable())?;
    received.await.map_err(|_| unavailable())?
}
pub(super) async fn start_titlebar_drag<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>, language: &str) -> Result<()> {
    let callback_app = app.clone();
    let window = window.clone();
    let language = language.to_owned();
    let (send, received) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = super::with_language(&language, || guarded(callback_app.state::<crate::lifecycle::Gate>().inner(), || {
            let current = callback_app.get_webview_window(window.label()).ok_or_else(unavailable)?;
            if stamp(&current)? != stamp(&window)? { return Err(unavailable()); }
            crate::trusted_main(&current)?;
            // 无需持有窗口模式状态锁；全屏时不向操作系统发起拖动。
            if !current.is_fullscreen().map_err(|_| unavailable())? {
                current.start_dragging().map_err(|_| super::platform_unsupported())?;
            }
            Ok(())
        }));
        let _ = send.send(result);
    }).map_err(|_| unavailable())?;
    received.await.map_err(|_| unavailable())?
}

pub(super) fn cancel_for_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<Registry>() {
        if let Ok(current) = state.0.lock() { if let Some(owner) = current.as_ref() { owner.invalidate(); } }
    }
}
pub(super) fn relaunch_ready<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    if let Some(state) = app.try_state::<Registry>() {
        let current = state.0.try_lock().map_err(|_| unavailable())?;
        if let Some(owner) = current.as_ref() {
            let model = owner.model.try_lock().map_err(|_| unavailable())?;
            if model.closed || model.uncertain || owner.closed.load(Ordering::Acquire) { return Err(unavailable()); }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Clone, Copy)]
    enum Fault { Before, After, Panic }
    /// 真实状态机使用同一 WindowOps；计数包含查询，变更日志只记窗口副作用。
    struct FakeWindow {
        token: u128, alive: bool, full: bool, max: bool, top: bool,
        visible: bool, taskbar: bool, minimized: bool,
        calls: RefCell<Vec<&'static str>>, mutations: Vec<&'static str>,
        fault: Option<(&'static str, usize, Fault)>,
    }
    impl FakeWindow {
        fn new(token: u128) -> Self {
            Self { token, alive: true, full: false, max: false, top: false,
                visible: false, taskbar: false, minimized: false,
                calls: RefCell::new(Vec::new()), mutations: Vec::new(), fault: None }
        }
        fn begin(&self, name: &'static str) -> Result<bool> {
            let mut calls = self.calls.borrow_mut(); calls.push(name);
            let occurrence = calls.iter().filter(|value| **value == name).count();
            if let Some((step, wanted, fault)) = self.fault {
                if step == name && wanted == occurrence {
                    return match fault { Fault::Before => Err("模拟原生失败".into()),
                        Fault::After => Ok(true), Fault::Panic => panic!("模拟原生 panic: {name}") };
                }
            }
            Ok(false)
        }
        fn end(after: bool) -> Result<()> { if after { Err("模拟部分成功后失败".into()) } else { Ok(()) } }
        fn reset_log(&mut self) { self.calls.get_mut().clear(); self.mutations.clear(); }
        fn inject(&mut self, step: &'static str, fault: Fault) { self.reset_log(); self.fault = Some((step, 1, fault)); }
    }
    impl WindowOps for FakeWindow {
        fn check(&self, token: u128) -> Result<()> {
            let after = self.begin("check")?;
            if !self.alive || token != self.token { return Err(unavailable()); }
            Self::end(after)
        }
        fn fullscreen(&self) -> Result<bool> { let after = self.begin("full:get")?; Self::end(after)?; Ok(self.full) }
        fn maximized(&self) -> Result<bool> { let after = self.begin("max:get")?; Self::end(after)?; Ok(self.max) }
        fn top(&self) -> Result<bool> { let after = self.begin("top:get")?; Self::end(after)?; Ok(self.top) }
        fn set_fullscreen(&mut self, on: bool) -> Result<()> { let after = self.begin("full:set")?; self.full = on; self.mutations.push("full:set"); Self::end(after) }
        fn set_maximized(&mut self, on: bool) -> Result<()> { let after = self.begin("max:set")?; self.max = on; self.mutations.push("max:set"); Self::end(after) }
        fn set_top(&mut self, on: bool) -> Result<()> { let after = self.begin("top:set")?; self.top = on; self.mutations.push("top:set"); Self::end(after) }
        fn taskbar_visible(&mut self) -> Result<()> { let after = self.begin("taskbar")?; self.taskbar = true; self.mutations.push("taskbar"); Self::end(after) }
        fn show(&mut self) -> Result<()> { let after = self.begin("show")?; self.visible = true; self.mutations.push("show"); Self::end(after) }
        fn raise(&mut self) -> Result<()> { let after = self.begin("raise")?; self.mutations.push("raise"); Self::end(after) }
        fn minimize(&mut self) -> Result<()> { let after = self.begin("minimize")?; self.minimized = true; self.mutations.push("minimize"); Self::end(after) }
        fn close(&mut self) -> Result<()> { let after = self.begin("close")?; self.mutations.push("close"); Self::end(after) }
    }
    fn pair() -> (Model, FakeWindow) { (Model::new(95), FakeWindow::new(95)) }

    #[test]
    fn commands_validate_single_boolean_and_all_three_locales() {
        for (locale, expected) in [("zh-CN", "参数无效"), ("zh-TW", "參數無效"), ("en", "Invalid arguments")] {
            super::super::with_language(locale, || {
                for channel in ["window:setDesktopMode", "window:securityFullscreen", "window:setFullscreen", "window:setAlwaysOnTop"] {
                    assert!(Command::parse(channel, &[Value::Bool(true)]).unwrap().is_some());
                    assert!(Command::parse(channel, &[Value::Bool(false)]).unwrap().is_some());
                    for args in [vec![], vec![Value::Null], vec![Value::String("true".into())], vec![Value::Bool(true), Value::Bool(false)]] {
                        assert_eq!(Command::parse(channel, &args).unwrap_err(), expected);
                    }
                }
                for channel in ["window:close", "window:minimize", "window:maximize", "window:isMaximized"] {
                    assert!(Command::parse(channel, &[]).unwrap().is_some());
                    assert_eq!(Command::parse(channel, &[Value::Null]).unwrap_err(), expected);
                }
                assert!(Command::parse("unrelated", &[Value::Null]).unwrap().is_none());
            });
        }
    }
    #[test]
    fn desktop_normal_on_off_keeps_taskbar_and_removes_top_and_maximize() {
        let (mut model, mut window) = pair(); window.top = true; window.max = true;
        assert_eq!(model.apply(Command::Desktop(true), &mut window).unwrap(), Value::Bool(true));
        assert!(window.full && window.visible && window.taskbar && !window.top);
        assert!(!window.mutations.contains(&"raise")); assert!(model.ticket().is_some());
        assert_eq!(model.apply(Command::Desktop(false), &mut window).unwrap(), Value::Bool(false));
        assert!(!window.full && !window.max && !window.top && window.taskbar);
        assert!(model.ticket().is_none()); assert!(!model.uncertain);
    }
    #[test]
    fn repeated_desktop_on_has_one_ticket_and_tick_only_repairs_fullscreen() {
        let (mut model, mut window) = pair(); model.apply(Command::Desktop(true), &mut window).unwrap();
        let ticket = model.ticket().unwrap(); model.apply(Command::Desktop(true), &mut window).unwrap();
        assert_eq!(model.ticket(), Some(ticket)); window.reset_log();
        model.tick(ticket, &mut window).unwrap(); assert!(window.mutations.is_empty());
        window.full = false; window.reset_log(); model.tick(ticket, &mut window).unwrap();
        assert_eq!(window.mutations, ["full:set"]); assert!(window.full);
        assert_eq!(model.ticket(), Some(ticket));
    }
    #[test]
    fn security_repeated_on_preserves_first_snapshot_and_off_without_ticket_never_mutates() {
        let (mut model, mut window) = pair();
        assert_eq!(model.apply(Command::Security(false), &mut window).unwrap(), Value::Bool(false));
        assert!(window.mutations.is_empty());
        model.apply(Command::Security(true), &mut window).unwrap(); let first = model.security;
        window.max = true; model.apply(Command::Security(true), &mut window).unwrap();
        assert_eq!(model.security, first); assert!(window.mutations.contains(&"raise"));
        model.apply(Command::Security(false), &mut window).unwrap();
        assert!(!window.full && !window.max && model.security.is_none());
    }
    #[test]
    fn security_restores_normal_maximized_and_existing_fullscreen() {
        for original in [Snapshot { fullscreen: false, maximized: false }, Snapshot { fullscreen: false, maximized: true }, Snapshot { fullscreen: true, maximized: false }] {
            let (mut model, mut window) = pair(); window.full = original.fullscreen; window.max = original.maximized;
            model.apply(Command::Security(true), &mut window).unwrap();
            assert_eq!(model.security, Some(original));
            assert_eq!(model.apply(Command::Security(false), &mut window).unwrap(), Value::Bool(original.fullscreen));
            assert_eq!(window.full, original.fullscreen); assert_eq!(window.max, original.maximized);
            assert!(model.security.is_none());
        }
    }
    #[test]
    fn desktop_and_security_interleaving_does_not_resurrect_old_desktop_mode() {
        let (mut model, mut window) = pair(); model.apply(Command::Desktop(true), &mut window).unwrap();
        let old = model.ticket().unwrap(); model.apply(Command::Security(true), &mut window).unwrap();
        model.apply(Command::Desktop(false), &mut window).unwrap(); assert!(window.full);
        assert!(model.ticket().is_none()); model.apply(Command::Security(false), &mut window).unwrap();
        assert!(!window.full && !window.max); window.reset_log(); model.tick(old, &mut window).unwrap();
        assert!(window.calls.borrow().is_empty());
        model.apply(Command::Security(true), &mut window).unwrap(); model.apply(Command::Desktop(true), &mut window).unwrap();
        model.apply(Command::Security(false), &mut window).unwrap(); assert!(window.full && model.ticket().is_some());
    }
    #[test]
    fn fullscreen_maximize_and_top_during_security_update_only_the_intended_layer() {
        let (mut model, mut window) = pair(); model.apply(Command::Security(true), &mut window).unwrap();
        model.apply(Command::Fullscreen(false), &mut window).unwrap(); assert!(window.full);
        model.apply(Command::Maximize, &mut window).unwrap(); assert!(window.full);
        model.apply(Command::Top(true), &mut window).unwrap(); assert!(window.top);
        model.apply(Command::Security(false), &mut window).unwrap(); assert!(!window.full && window.max && window.top);
        model.apply(Command::Fullscreen(true), &mut window).unwrap();
        model.apply(Command::Fullscreen(false), &mut window).unwrap(); assert!(!window.full && !window.max);
        model.apply(Command::Maximize, &mut window).unwrap(); assert!(window.max);
        model.apply(Command::Top(false), &mut window).unwrap(); assert!(!window.top);
    }
    #[test]
    fn late_ticks_after_off_or_new_generation_are_zero_operations() {
        let (mut model, mut window) = pair(); model.apply(Command::Desktop(true), &mut window).unwrap();
        let old = model.ticket().unwrap(); model.apply(Command::Desktop(false), &mut window).unwrap();
        window.reset_log(); model.tick(old, &mut window).unwrap(); assert!(window.calls.borrow().is_empty());
        model.apply(Command::Desktop(true), &mut window).unwrap(); let current = model.ticket().unwrap();
        assert_ne!(current, old); window.reset_log(); model.tick(old, &mut window).unwrap(); assert!(window.calls.borrow().is_empty());
        model.apply(Command::Desktop(false), &mut window).unwrap();
        model.apply(Command::Desktop(false), &mut window).unwrap(); assert!(model.ticket().is_none() && !window.full);
    }
    #[test]
    fn close_and_destroy_invalidation_are_idempotent_and_keep_security_evidence() {
        let (mut model, mut window) = pair(); model.apply(Command::Desktop(true), &mut window).unwrap();
        model.apply(Command::Security(true), &mut window).unwrap(); let previous = model.security;
        let ticket = model.ticket().unwrap(); model.close(); let generation = model.generation; model.close();
        assert_eq!(model.generation, generation); assert_eq!(model.security, previous);
        window.reset_log(); model.tick(ticket, &mut window).unwrap();
        assert!(model.apply(Command::Security(false), &mut window).is_err());
        assert!(model.apply(Command::Desktop(false), &mut window).is_err()); assert!(window.calls.borrow().is_empty());
    }
    #[test]
    fn replaced_window_token_rejects_old_commands_and_ticks_without_mutation() {
        let (mut model, mut window) = pair(); model.apply(Command::Desktop(true), &mut window).unwrap();
        let old = model.ticket().unwrap(); window.token = 96; window.reset_log();
        assert!(model.tick(old, &mut window).is_err()); assert!(window.mutations.is_empty());
        assert!(model.apply(Command::Security(true), &mut window).is_err());
        let mut replacement = Model::new(96); window.reset_log(); replacement.tick(old, &mut window).unwrap();
        assert!(window.calls.borrow().is_empty()); replacement.apply(Command::Security(true), &mut window).unwrap();
        assert!(window.full); assert_ne!(replacement.token, model.token);
    }
    #[test]
    fn temporary_restart_rejection_preserves_ticket_and_resume_after_failed_restart() {
        let (mut model, mut window) = pair(); let gate = crate::lifecycle::Gate::default();
        model.apply(Command::Desktop(true), &mut window).unwrap(); let ticket = model.ticket().unwrap(); window.full = false; window.reset_log();
        let restart = gate.begin_restart().unwrap();
        assert!(guarded(&gate, || model.tick(ticket, &mut window)).is_err());
        assert_eq!(model.ticket(), Some(ticket)); assert!(window.calls.borrow().is_empty());
        drop(restart); guarded(&gate, || model.tick(ticket, &mut window)).unwrap();
        assert_eq!(window.mutations, ["full:set"]); assert_eq!(model.ticket(), Some(ticket));
    }
    #[test]
    fn active_gate_blocks_restart_and_committed_restart_or_close_blocks_queued_mutations() {
        let (mut model, mut window) = pair(); let gate = crate::lifecycle::Gate::default();
        model.apply(Command::Desktop(true), &mut window).unwrap(); let ticket = model.ticket().unwrap();
        let active = gate.enter().unwrap(); assert!(gate.begin_restart().is_err());
        guarded(&gate, || model.tick(ticket, &mut window)).unwrap(); active.finish();
        gate.begin_restart().unwrap().commit(); window.full = false; window.reset_log();
        assert!(guarded(&gate, || model.tick(ticket, &mut window)).is_err());
        assert!(guarded(&gate, || model.apply(Command::Desktop(false), &mut window)).is_err()); assert!(window.calls.borrow().is_empty());
        let closed_gate = crate::lifecycle::Gate::default(); closed_gate.close();
        assert!(guarded(&closed_gate, || model.tick(ticket, &mut window)).is_err()); assert!(window.calls.borrow().is_empty());
    }
    #[test]
    fn every_desktop_native_step_failure_marks_unknown_and_stops_effective_timer() {
        for command in [Command::Desktop(true), Command::Desktop(false)] {
            for step in if matches!(command, Command::Desktop(true)) { vec!["taskbar", "top:set", "full:set", "show"] } else { vec!["top:set", "taskbar", "full:set", "max:set"] } {
                for fault in [Fault::Before, Fault::After] {
                    let (mut model, mut window) = pair();
                    if matches!(command, Command::Desktop(false)) { model.apply(Command::Desktop(true), &mut window).unwrap(); }
                    window.inject(step, fault); assert!(model.apply(command, &mut window).is_err(), "{step}");
                    assert!(model.uncertain && model.ticket().is_none()); let mutations = window.mutations.len();
                    assert!(model.apply(Command::Desktop(false), &mut window).is_err()); assert_eq!(window.mutations.len(), mutations);
                }
            }
        }
    }
    #[test]
    fn security_native_failures_keep_snapshot_until_fully_restored() {
        for step in ["full:get", "max:get", "full:set", "show", "raise"] {
            for fault in [Fault::Before, Fault::After] {
                let (mut model, mut window) = pair(); window.inject(step, fault);
                assert!(model.apply(Command::Security(true), &mut window).is_err(), "{step}"); assert!(model.uncertain);
                if matches!(step, "full:set" | "show" | "raise") { assert!(model.security.is_some()); }
            }
        }
        for step in ["full:set", "max:set", "full:get"] {
            let (mut model, mut window) = pair(); model.apply(Command::Security(true), &mut window).unwrap();
            let saved = model.security; window.inject(step, Fault::After);
            assert!(model.apply(Command::Security(false), &mut window).is_err(), "{step}");
            assert_eq!(model.security, saved); assert!(model.uncertain);
        }
    }
    #[test]
    fn ordinary_window_native_failure_matrix_is_conservative() {
        for (command, steps) in [(Command::Fullscreen(false), vec!["full:set", "max:set", "full:get"]),
            (Command::Maximize, vec!["max:get", "max:set"]), (Command::Top(true), vec!["top:set", "top:get"]),
            (Command::Minimize, vec!["minimize"]), (Command::Close, vec!["close"]), (Command::IsMaximized, vec!["max:get"])] {
            for step in steps {
                let (mut model, mut window) = pair(); window.inject(step, Fault::After);
                assert!(model.apply(command, &mut window).is_err(), "{step}"); assert!(model.uncertain);
            }
        }
    }
    #[test]
    fn native_panic_is_caught_without_dropping_snapshot_or_reopening_restart_gate() {
        for step in ["full:set", "show", "raise"] {
            let (mut model, mut window) = pair(); let gate = crate::lifecycle::Gate::default(); window.inject(step, Fault::Panic);
            assert!(guarded(&gate, || model.apply(Command::Security(true), &mut window)).is_err());
            assert!(model.uncertain && model.security.is_some()); assert!(gate.begin_restart().is_err());
        }
    }
    #[test]
    fn tick_failure_and_panic_retain_desktop_state_and_forbid_further_mutations() {
        for step in ["full:get", "full:set"] {
            for fault in [Fault::Before, Fault::After, Fault::Panic] {
                let (mut model, mut window) = pair(); let gate = crate::lifecycle::Gate::default();
                model.apply(Command::Desktop(true), &mut window).unwrap(); let ticket = model.ticket().unwrap();
                window.full = false; window.inject(step, fault); assert!(guarded(&gate, || model.tick(ticket, &mut window)).is_err());
                assert!(model.desktop && model.uncertain && model.ticket().is_none()); let count = window.mutations.len();
                model.tick(ticket, &mut window).unwrap(); assert_eq!(window.mutations.len(), count);
            }
        }
    }
    #[test]
    fn cancelled_close_intent_preserves_desktop_timer_and_security_snapshot() {
        let (mut model, mut window) = pair();
        model.apply(Command::Desktop(true), &mut window).unwrap();
        model.apply(Command::Security(true), &mut window).unwrap();
        let ticket = model.ticket(); let snapshot = model.security;
        window.reset_log();
        model.apply(Command::Close, &mut window).unwrap();
        assert_eq!(window.mutations, ["close"]);
        assert!(!model.closed && !model.uncertain && window.alive);
        assert_eq!(model.ticket(), ticket); assert_eq!(model.security, snapshot);
        assert!(model.apply(Command::IsMaximized, &mut window).is_ok());
    }

    #[test]
    fn ordinary_success_and_identity_recheck_after_native_side_effect_are_explicit() {
        let (mut model, mut window) = pair();
        assert_eq!(model.apply(Command::IsMaximized, &mut window).unwrap(), Value::Bool(false));
        model.apply(Command::Minimize, &mut window).unwrap(); assert!(window.minimized);
        assert_eq!(model.apply(Command::Close, &mut window).unwrap(), Value::Null);
        assert!(!model.closed && window.alive && !model.uncertain);
        assert!(model.apply(Command::IsMaximized, &mut window).is_ok());
        model.close(); window.alive = false;
        assert!(model.apply(Command::IsMaximized, &mut window).is_err());
        let (mut model, mut window) = pair();
        // apply 入口、原生调用前、原生调用后依次是三个身份检查。
        window.fault = Some(("check", 3, Fault::Before));
        assert!(model.apply(Command::Desktop(true), &mut window).is_err());
        assert_eq!(window.mutations, ["taskbar"]); assert!(model.uncertain);
        assert!(!window.full && !window.visible && model.ticket().is_none());
    }
    #[test]
    fn every_native_step_panic_preserves_unknown_model_and_sticky_lifecycle() {
        for (command, steps) in [(Command::Desktop(true), vec!["taskbar", "top:set", "full:set", "show"]),
            (Command::Desktop(false), vec!["top:set", "taskbar", "full:set", "max:set"]),
            (Command::Security(true), vec!["full:get", "max:get", "full:set", "show", "raise"]),
            (Command::Security(false), vec!["full:set", "max:set", "full:get"]),
            (Command::Fullscreen(false), vec!["full:set", "max:set", "full:get"]),
            (Command::Maximize, vec!["max:get", "max:set"]), (Command::Top(true), vec!["top:set", "top:get"]),
            (Command::Minimize, vec!["minimize"]), (Command::Close, vec!["close"]), (Command::IsMaximized, vec!["max:get"])] {
            for step in steps {
                let (mut model, mut window) = pair(); let gate = crate::lifecycle::Gate::default();
                if matches!(command, Command::Security(false)) { model.apply(Command::Security(true), &mut window).unwrap(); }
                if matches!(command, Command::Desktop(false)) { model.apply(Command::Desktop(true), &mut window).unwrap(); }
                window.inject(step, Fault::Panic);
                assert!(guarded(&gate, || model.apply(command, &mut window)).is_err(), "{step}");
                assert!(model.uncertain && model.ticket().is_none()); assert!(gate.begin_restart().is_err());
            }
        }
    }
    #[test]
    fn binding_close_during_locked_command_never_waits_and_invalidates_watch() {
        let owner = Binding { token: 95, stamp: "fake-native-handle".into(), closed: AtomicBool::new(false), model: Mutex::new(Model::new(95)), timer: Mutex::new(None) };
        let (stop, mut receiver) = tokio::sync::watch::channel(false);
        *owner.timer.lock().unwrap() = Some(Timer { ticket: Tick { token: 95, generation: 1 }, stop });
        let held = owner.model.lock().unwrap(); owner.invalidate();
        assert!(owner.closed.load(Ordering::Acquire)); assert!(*receiver.borrow_and_update());
        assert!(owner.timer.lock().unwrap().is_none()); drop(held);
        owner.invalidate(); assert!(owner.model.lock().unwrap().closed);
    }
}

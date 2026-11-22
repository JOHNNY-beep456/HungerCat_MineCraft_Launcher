//! Windows 原生窗口操作。调用方只从短 UI 回合进入；这里不读写 Storage。
use super::*;
use super::geometry::{self, Area, Size};
use raw_window_handle::HasWindowHandle;
use tauri::{Emitter, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

pub(super) fn stamp(window: &WebviewWindow) -> Result<String> {
    Ok(format!("{:?}", window.window_handle().map_err(|_| unavailable())?.as_raw()))
}
fn area(app: &AppHandle) -> Result<(Area, f64)> {
    let main = app.get_webview_window("main").ok_or_else(unavailable)?;
    let monitor = main.primary_monitor().map_err(|_| unavailable())?.ok_or_else(unavailable)?;
    let scale = monitor.scale_factor();
    if !scale.is_finite() || scale <= 0.0 { return Err(unavailable()); }
    let work = monitor.work_area();
    Ok((Area { origin: Point { x: work.position.x as f64 / scale, y: work.position.y as f64 / scale },
        size: Size { width: work.size.width as f64 / scale, height: work.size.height as f64 / scale } }, scale))
}
fn position(window: &WebviewWindow, scale: f64) -> Result<Point> {
    let pos = window.outer_position().map_err(|_| unavailable())?;
    Ok(Point { x: pos.x as f64 / scale, y: pos.y as f64 / scale })
}
fn move_to(window: &WebviewWindow, point: Point, scale: f64) -> Result<Point> {
    window.set_position(PhysicalPosition::new((point.x * scale).round() as i32, (point.y * scale).round() as i32)).map_err(|_| unavailable())?;
    position(window, scale)
}
fn current(app: &AppHandle, state: &State) -> Result<Option<(u64, WebviewWindow, bool)>> {
    let candidate = {
        let inner = state.inner.lock().map_err(|_| unavailable())?;
        if state.closed.load(Ordering::Acquire) { return Err(unavailable()); }
        let Some(binding) = &inner.binding else {
            if inner.model.busy_resource() { return Err(unavailable()); }
            return Ok(None);
        };
        if !inner.preferences.enabled || inner.model.closing() || inner.model.uncertain()
            || binding.signals.destroyed.load(Ordering::Acquire) || binding.signals.close_requested.load(Ordering::Acquire) { return Err(unavailable()); }
        (binding.id, binding.window.clone(), inner.expanded)
    };
    authorize(app, &candidate.1)?;
    Ok(Some(candidate))
}
fn observation(app: &AppHandle, binding: Option<&(u64, Option<String>, Arc<Signals>)>) -> Registry {
    let window = app.get_window(LABEL).is_some(); let webview = app.get_webview(LABEL).is_some();
    let destroyed = binding.is_some_and(|(_, _, signals)| signals.destroyed.load(Ordering::Acquire));
    let identity = if window && webview && !destroyed {
        binding.and_then(|(_, expected, _)| expected.as_ref())
            .zip(app.get_webview_window(LABEL).and_then(|w| stamp(&w).ok())).map(|(expected, current)| expected == &current)
    } else { None };
    Registry::observe(window, webview, binding.is_some(), destroyed, identity)
}
pub(super) fn restart_resource(app: &AppHandle, state: &State) -> Result<Option<crate::lifecycle::ResourcePermit>> {
    let before = {
        let inner = state.inner.try_lock().map_err(|_| unavailable())?;
        restart_view(state, &inner)?
    };
    let expected = if before.binding.is_some() { Registry::Owned } else { Registry::Empty };
    if observation(app, before.binding.as_ref()) != expected { return Err(unavailable()); }
    if let Some((id, _, _)) = &before.binding {
        let Some((current_id, _, _)) = current(app, state)? else { return Err(unavailable()); };
        if *id != current_id { return Err(unavailable()); }
    }
    // native getter 与宿主锁分离；回到锁内再次核验同一个资源，拒绝过期快照。
    let after = {
        let inner = state.inner.try_lock().map_err(|_| unavailable())?;
        restart_view(state, &inner)?
    };
    if before.binding.as_ref().map(|binding| binding.0) != after.binding.as_ref().map(|binding| binding.0) { return Err(unavailable()); }
    let same = match (&before.permit, &after.permit) {
        (None, None) => true,
        (Some(before), Some(after)) => before.same_resource(after),
        _ => false,
    };
    if same { Ok(after.permit) } else { Err(unavailable()) }
}
fn desired(state: &State, inner: &Inner) -> Desired {
    // 页面自身从两字段投影选择语言；和 Electron 一样，不为语言更改重建聊天窗口。
    Desired { enabled: !state.closed.load(Ordering::Acquire) && inner.preferences.enabled, revision: inner.revision, language: "ai-ball".into() }
}
pub(super) fn sync(app: &AppHandle, state: &Arc<State>) -> Result<Step> {
    let (expected, observed_binding) = {
        let mut inner = state.inner.lock().map_err(|_| unavailable())?;
        if state.closed.load(Ordering::Acquire) { inner.model.terminate(); }
        if let Some(binding) = &inner.binding {
            let id = binding.id;
            let destroyed = binding.signals.destroyed.load(Ordering::Acquire);
            let close_requested = binding.signals.close_requested.load(Ordering::Acquire);
            if destroyed { inner.model.destroyed(id, state.now()); }
            else if close_requested { inner.model.begin_close(id, state.now()); }
        }
        if inner.refresh && !state.closed.load(Ordering::Acquire) { return Ok(Step::Again); }
        (desired(state, &inner), inner.binding.as_ref().map(|b| (b.id, b.stamp.clone(), b.signals.clone())))
    };
    let registry = observation(app, observed_binding.as_ref());
    let action = {
        let mut inner = state.inner.lock().map_err(|_| unavailable())?;
        if inner.binding.as_ref().map(|b| b.id) != observed_binding.map(|b| b.0) { return Ok(Step::Again); }
        inner.model.plan(&expected, registry, state.now())
    };
    match action {
        Action::Idle => Ok(Step::Idle), Action::Retained => Ok(Step::Retained), Action::Wait => Ok(Step::Wait),
        Action::Released(id) => {
            let mut inner = state.inner.lock().map_err(|_| unavailable())?;
            if inner.binding.as_ref().is_some_and(|b| b.id == id) { inner.binding = None; }
            inner.expanded = false; inner.error = None; finish_lease(&mut inner);
            Ok(Step::Again)
        }
        Action::Destroy { id } => {
            let window = {
                let inner = state.inner.lock().map_err(|_| unavailable())?;
                inner.binding.as_ref().filter(|b| b.id == id && !b.signals.destroyed.load(Ordering::Acquire))
                    .map(|b| b.window.clone()).ok_or_else(unavailable)?
            };
            if window.destroy().is_err() {
                let mut inner = state.inner.lock().map_err(|_| unavailable())?;
                inner.model.queue_failed(id); inner.error = Some(unavailable());
            }
            Ok(Step::Wait)
        }
        Action::Create { id, generation } => create(app, state, id, generation, &expected),
        Action::Show { id, generation } => show(app, state, id, generation, &expected),
    }
}
fn create(app: &AppHandle, state: &Arc<State>, id: u64, generation: u64, expected: &Desired) -> Result<Step> {
    let (work, scale) = match area(app) {
        Ok(value) => value,
        Err(error) => { state.inner.lock().map_err(|_| unavailable())?.model.cancel_creation(id); return Err(error); }
    };
    let (point, size) = {
        let mut inner = state.inner.lock().map_err(|_| unavailable())?;
        if !inner.model.can_create(id, generation) || !desired(state, &inner).enabled || inner.refresh || inner.revision != expected.revision {
            inner.model.defer_creation(id); return Ok(Step::Again);
        }
        let size = geometry::size(inner.expanded);
        let stored = Point { x: inner.preferences.x, y: inner.preferences.y };
        let point = if stored.x >= 0.0 && stored.y >= 0.0 { work.clamp(stored, size) } else { work.default_position(size) };
        (point, size)
    };
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(ENTRY.into()))
        .title("AI 助手").inner_size(size.width, size.height).position(point.x, point.y)
        .decorations(false).transparent(true).visible(false).focused(false).focusable(true)
        .always_on_top(true).skip_taskbar(true).resizable(false).maximizable(false).minimizable(false).shadow(false).devtools(false)
        .on_navigation(|url| allowed_url(LABEL, url))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build().map_err(|_| unavailable())?;
    let signals = Arc::new(Signals::default()); let event_signals = signals.clone(); let handle = app.clone();
    window.on_window_event(move |event| {
        match event {
            tauri::WindowEvent::Destroyed => { event_signals.destroyed.store(true, Ordering::Release); }
            tauri::WindowEvent::CloseRequested { api, .. } => { api.prevent_close(); event_signals.close_requested.store(true, Ordering::Release); }
            _ => return,
        }
        wake_instance(&handle, id);
    });
    let actual = stamp(&window);
    {
        let mut inner = state.inner.lock().map_err(|_| unavailable())?;
        inner.binding = Some(Binding { id, stamp: actual.as_ref().ok().cloned(), window, signals });
        if !inner.model.created(id, "ai-ball".into()) { return Err(unavailable()); }
    }
    // 即使 stamp/show 失败，也已登记 builder 返回的确切 dispatcher，交给同一个 owner 收尾。
    actual?;
    let window = {
        let inner = state.inner.lock().map_err(|_| unavailable())?;
        inner.binding.as_ref().filter(|b| b.id == id).map(|b| b.window.clone()).ok_or_else(unavailable)?
    };
    // 明确按主屏 DPI 应用 physical bounds，不依赖窗口创建时默认选中的显示器。
    window.set_size(PhysicalSize::new((size.width * scale).round() as u32, (size.height * scale).round() as u32)).map_err(|_| unavailable())?;
    move_to(&window, point, scale)?;
    show(app, state, id, generation, expected)
}
fn show(app: &AppHandle, state: &Arc<State>, id: u64, generation: u64, expected: &Desired) -> Result<Step> {
    let window = {
        let mut inner = state.inner.lock().map_err(|_| unavailable())?;
        if !inner.model.can_show(id, generation) || !desired(state, &inner).enabled || inner.refresh || inner.revision != expected.revision {
            inner.model.request(); return Ok(Step::Again);
        }
        let binding = inner.binding.as_ref().filter(|b| b.id == id && !b.signals.destroyed.load(Ordering::Acquire)
            && !b.signals.close_requested.load(Ordering::Acquire)).ok_or_else(unavailable)?;
        binding.window.clone()
    };
    window.set_always_on_top(true).map_err(|_| unavailable())?;
    window.set_skip_taskbar(true).map_err(|_| unavailable())?;
    window.set_ignore_cursor_events(false).map_err(|_| unavailable())?;
    {
        let inner = state.inner.lock().map_err(|_| unavailable())?;
        if state.closed.load(Ordering::Acquire) || !inner.model.can_show(id, generation) || !inner.preferences.enabled || inner.refresh {
            return Ok(Step::Again);
        }
    }
    if !window.is_visible().map_err(|_| unavailable())? { window.show().map_err(|_| unavailable())?; }
    let expanded = {
        let inner = state.inner.lock().map_err(|_| unavailable())?;
        if !inner.model.can_show(id, generation) || !desired(state, &inner).enabled || inner.refresh || inner.revision != expected.revision { return Ok(Step::Again); }
        inner.expanded
    };
    let url = window.url().map_err(|_| unavailable())?;
    if !initial_sync_ready(&url)? { return Ok(Step::Wait); }
    emit_expanded(app, state, id, expanded)?;
    state.inner.lock().map_err(|_| unavailable())?.error = None;
    Ok(Step::Idle)
}
pub(super) fn emit_expanded(app: &AppHandle, state: &State, id: u64, expanded: bool) -> Result<()> {
    let Some((current_id, _, _)) = current(app, state)? else { return Ok(()); };
    if current_id != id { return Err(unavailable()); }
    // Emitter::emit 是全局广播；自有窗口核验与指定 label 投递必须在同一 UI 回合。
    app.emit_to(LABEL, "launcher:event", json!({"channel":"ai:ballExpanded","payload":expanded})).map_err(|_| unavailable())
}
pub(super) fn emit_tool_request(app: &AppHandle, state: &State, payload: Value) -> Result<()> {
    if current(app, state)?.is_none() { return Ok(()); }
    app.emit_to(LABEL, "launcher:event", json!({"channel":"ai:toolRequest","payload":payload})).map_err(|_| unavailable())
}
pub(super) fn voice_event(app: &AppHandle, state: &State, enabled: Option<bool>) -> Result<bool> {
    if app.get_window(LABEL).is_none() && app.get_webview(LABEL).is_none() {
        let inner = state.inner.lock().map_err(|_| unavailable())?;
        if inner.binding.is_none() && !inner.model.busy_resource() && !inner.model.uncertain() { return Ok(false); }
    }
    // 关闭开关时，精确自有的 Closing 窗口仍须收到取消；不能因此授权它启动新业务。
    let expected = if enabled == Some(false) {
        let inner = state.inner.lock().map_err(|_| unavailable())?;
        let binding = inner.binding.as_ref().ok_or_else(unavailable)?;
        if inner.model.uncertain() || binding.signals.destroyed.load(Ordering::Acquire) { return Err(unavailable()); }
        (binding.id, binding.window.clone(), binding.stamp.clone().ok_or_else(unavailable)?)
    } else {
        let Some((id, window, _)) = current(app, state)? else { return Ok(false); };
        if enabled.is_none() && !window.is_visible().map_err(|_| unavailable())? { return Ok(false); }
        let native = stamp(&window)?;
        (id, window, native)
    };
    if app.get_window(LABEL).is_none() || app.get_webview(LABEL).is_none() { return Err(unavailable()); }
    let manager = app.get_webview_window(LABEL).ok_or_else(unavailable)?;
    if !allowed_url(expected.1.label(), &expected.1.url().map_err(|_| unavailable())?)
        || stamp(&manager)? != expected.2 || stamp(&expected.1)? != expected.2 { return Err(unavailable()); }
    {
        let inner = state.inner.lock().map_err(|_| unavailable())?;
        if inner.model.uncertain() || !inner.binding.as_ref().is_some_and(|binding| binding.id == expected.0
            && binding.stamp.as_ref() == Some(&expected.2) && !binding.signals.destroyed.load(Ordering::Acquire)) { return Err(unavailable()); }
    }
    let (channel, payload) = match enabled {
        Some(enabled) => ("ai:voiceState", Value::Bool(enabled)), None => ("ai:voiceToggle", Value::Null),
    };
    app.emit_to(LABEL, "launcher:event", json!({"channel":channel,"payload":payload})).map_err(|_| unavailable())?;
    Ok(true)
}

pub(super) fn command(app: &AppHandle, state: &Arc<State>, command: Command) -> Result<Output> {
    let current = current(app, state)?;
    let empty = |value| Output { value, persist: None, expanded: None };
    match command {
        Command::Sync => {
            if let Some((id, _, expanded)) = current { emit_expanded(app, state, id, expanded)?; }
            Ok(empty(Value::Null))
        }
        Command::Position => {
            let (work, scale) = area(app)?;
            let point = if let Some((_, window, _)) = current { position(&window, scale)? } else { work.default_position(geometry::size(false)) };
            Ok(empty(json!({"x":point.x,"y":point.y})))
        }
        Command::Move(point, persist) => {
            let Some((_, window, expanded)) = current else { return Ok(empty(Value::Null)); };
            let (work, scale) = area(app)?;
            let requested = work.clamp(point, geometry::size(expanded));
            let actual = move_to(&window, requested, scale)?;
            // native 调用之后重新核验；终止或旧实例不能发布位置写入。
            authorize(app, &window)?;
            Ok(Output { value: json!({"x":actual.x,"y":actual.y}), persist: persist.then_some(actual), expanded: None })
        }
        Command::Expand(open) => {
            let Some((id, window, previous)) = current else { return Ok(empty(Value::Null)); };
            if previous == open { return Ok(Output { value: Value::Null, persist: None, expanded: Some((id, open)) }); }
            let (work, scale) = area(app)?;
            let old = position(&window, scale)?; let size = geometry::size(open);
            let requested = work.resize(old, geometry::size(previous), size);
            window.set_size(PhysicalSize::new((size.width * scale).round() as u32, (size.height * scale).round() as u32)).map_err(|_| unavailable())?;
            let actual = move_to(&window, requested, scale)?;
            authorize(app, &window)?;
            {
                let mut inner = state.inner.lock().map_err(|_| unavailable())?;
                if !inner.binding.as_ref().is_some_and(|b| b.id == id) || inner.model.closing() { return Err(unavailable()); }
                inner.expanded = open;
            }
            if open { window.set_focus().map_err(|_| unavailable())?; }
            Ok(Output { value: Value::Null, persist: Some(actual), expanded: Some((id, open)) })
        }
    }
}

//! 游戏内容区尺寸：纯决策与主 UI 原生采样分离，不访问游戏目录或启动状态锁。
use serde_json::{json, Value};
use std::sync::Arc;

type Result<T> = std::result::Result<T, String>;
const MIN_WINDOW: u32 = 320;
const MAX_WINDOW: u32 = 16_384;

fn message(zh: &str, tw: &str, en: &str) -> String { format!("{zh} / {tw} / {en}") }
fn unavailable() -> String { message("无法读取主显示器尺寸，未猜测全屏分辨率", "無法讀取主顯示器尺寸，未猜測全螢幕解析度", "Primary display size is unavailable; fullscreen resolution was not guessed") }
fn cancelled() -> String { message("游戏启动已取消", "遊戲啟動已取消", "Game launch was cancelled") }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode { Fullscreen, Maximized, Custom, Hd, FullHd }

#[derive(Clone, Copy, Debug)]
struct Request { mode: Mode, fullscreen: bool, custom: (u32, u32) }

fn custom_dimension(settings: &Value, key: &str) -> u32 {
    // 与 Electron 的 Math.round(value) || MIN_WINDOW 后 clamp 一致；不把 caller resolution 当设置。
    let value = settings.get(key).and_then(Value::as_f64).filter(|n| n.is_finite()).unwrap_or(0.0);
    (value + 0.5).floor().clamp(MIN_WINDOW as f64, MAX_WINDOW as f64) as u32
}

impl Request {
    fn parse(settings: &Value, options: &Value) -> Result<Self> {
        if !options.is_object() { return Err(message("启动选项必须是对象", "啟動選項必須是物件", "Launch options must be an object")); }
        let mode = if settings["experimental"].as_str() == Some("win10") { Mode::Fullscreen } else {
            match settings["gameWindowSize"].as_str() {
                Some("fullscreen") => Mode::Fullscreen, Some("maximized") => Mode::Maximized,
                Some("custom") => Mode::Custom, Some("1080p") => Mode::FullHd, _ => Mode::Hd,
            }
        };
        let caller_fullscreen = match options.get("fullscreen") {
            None | Some(Value::Null) => false, Some(Value::Bool(value)) => *value,
            _ => return Err(message("fullscreen 必须是布尔值", "fullscreen 必須是布林值", "fullscreen must be a boolean")),
        };
        Ok(Self { mode, fullscreen: mode == Mode::Fullscreen || caller_fullscreen,
            custom: (custom_dimension(settings, "gameWindowWidth"), custom_dimension(settings, "gameWindowHeight")) })
    }
    fn needs_monitor(self) -> bool { matches!(self.mode, Mode::Fullscreen | Mode::Maximized | Mode::Custom) }
}

#[derive(Clone, Copy, Debug)]
struct Display { full: (u32, u32), work: (u32, u32), scale: f64 }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Frame { width: u32, height: u32 }
#[derive(Clone, Debug)]
struct Sample { display: Display, frame: std::result::Result<Frame, String> }

// 显示器/窗口 API 返回物理像素。每个采样使用自己的 DPI，先差分后统一转逻辑像素。
fn logical(value: u32, scale: f64) -> Result<u32> {
    if !scale.is_finite() || scale <= 0.0 { return Err(unavailable()); }
    let result = (value as f64 / scale).round();
    if !result.is_finite() || result < 1.0 || result > u32::MAX as f64 { return Err(unavailable()); }
    Ok(result as u32)
}
fn logical_frame(outer: (u32, u32), inner: (u32, u32), scale: f64) -> Result<Frame> {
    if inner.0 == 0 || inner.1 == 0 || !scale.is_finite() || scale <= 0.0 { return Err(unavailable()); }
    let width = outer.0.checked_sub(inner.0).ok_or_else(unavailable)?;
    let height = outer.1.checked_sub(inner.1).ok_or_else(unavailable)?;
    // 隐藏窗口在部分 WM 下不提供装饰；零差值不能冒充真实 decorated 测量。
    if width == 0 && height == 0 { return Err(message("隐藏窗口未提供可测装饰", "隱藏視窗未提供可測裝飾", "Hidden window decorations could not be measured")); }
    Ok(Frame { width: (width as f64 / scale).ceil() as u32, height: (height as f64 / scale).ceil() as u32 })
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Warning { Oversize { full: (u32, u32) }, FrameUnavailable(String) }
#[derive(Clone, Debug, PartialEq, Eq)]
struct Decision { width: u32, height: u32, fullscreen: bool, warning: Option<Warning> }

fn decide(request: Request, sample: Option<&Sample>) -> Result<Decision> {
    let mut warning = None;
    let (width, height) = match request.mode {
        Mode::Hd => (1280, 720), Mode::FullHd => (1920, 1080),
        Mode::Fullscreen | Mode::Custom | Mode::Maximized => {
            let sample = sample.ok_or_else(unavailable)?;
            let display = sample.display;
            let full = (logical(display.full.0, display.scale)?, logical(display.full.1, display.scale)?);
            match request.mode {
                Mode::Fullscreen => full,
                Mode::Custom => {
                    if request.custom.0 > full.0 || request.custom.1 > full.1 { warning = Some(Warning::Oversize { full }); }
                    request.custom
                }
                Mode::Maximized => {
                    let work = (logical(display.work.0, display.scale)?, logical(display.work.1, display.scale)?);
                    let frame = match &sample.frame {
                        Ok(frame) => *frame,
                        Err(reason) => {
                            // 与 Electron 测量失败时一致保留工作区，但必须明确标记这是降级而非实测。
                            warning = Some(Warning::FrameUnavailable(reason.clone()));
                            Frame { width: 0, height: 0 }
                        }
                    };
                    (work.0.saturating_sub(frame.width).max(MIN_WINDOW), work.1.saturating_sub(frame.height).max(MIN_WINDOW))
                }
                _ => unreachable!(),
            }
        }
    };
    Ok(Decision { width, height, fullscreen: request.fullscreen, warning })
}

impl Decision {
    fn apply(&self, mut options: Value) -> Result<Value> {
        let object = options.as_object_mut().ok_or_else(|| message("启动选项必须是对象", "啟動選項必須是物件", "Launch options must be an object"))?;
        // Electron 最后写 resolution；caller 中的旧/畸形 resolution 也不会越过保存设置。
        object.insert("resolution".into(), json!({"width":self.width,"height":self.height}));
        object.insert("fullscreen".into(), json!(self.fullscreen));
        Ok(options)
    }
}

/// 只接受本模块决策后写入的尺寸；显示器全尺寸不受自定义 16384 上限二次截断。
pub(super) fn launch_arguments(options: &Value) -> Result<(u32, u32, bool)> {
    let number = |key: &str| options["resolution"][key].as_u64().filter(|n| *n > 0 && *n <= u32::MAX as u64)
        .map(|n| n as u32).ok_or_else(|| message("游戏窗口尺寸未完成解析", "遊戲視窗尺寸尚未解析", "Game window size has not been resolved"));
    let fullscreen = options["fullscreen"].as_bool().ok_or_else(|| message("游戏全屏状态未完成解析", "遊戲全螢幕狀態尚未解析", "Game fullscreen state has not been resolved"))?;
    Ok((number("width")?, number("height")?, fullscreen))
}

#[cfg(windows)]
mod win_probe {
    use super::*;
    use std::ffi::c_void;
    #[repr(C)] struct Rect { left: i32, top: i32, right: i32, bottom: i32 }
    #[link(name = "user32")]
    extern "system" {
        fn CreateWindowExW(ex_style: u32, class: *const u16, title: *const u16, style: u32, x: i32, y: i32, width: i32, height: i32, parent: *mut c_void, menu: *mut c_void, instance: *mut c_void, param: *mut c_void) -> *mut c_void;
        fn DestroyWindow(window: *mut c_void) -> i32;
        fn GetWindowRect(window: *mut c_void, rect: *mut Rect) -> i32;
        fn GetClientRect(window: *mut c_void, rect: *mut Rect) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetModuleHandleW(name: *const u16) -> *mut c_void;
        fn GetProcAddress(module: *mut c_void, name: *const i8) -> *mut c_void;
    }
    type AdjustForDpi = unsafe extern "system" fn(*mut Rect, u32, i32, u32, u32) -> i32;
    type DpiForWindow = unsafe extern "system" fn(*mut c_void) -> u32;
    fn procedure<T: Copy>(name: &'static [u8]) -> Option<T> {
        if name.last() != Some(&0) { return None; }
        let module = unsafe { GetModuleHandleW("user32.dll\0".encode_utf16().collect::<Vec<_>>().as_ptr()) };
        if module.is_null() { return None; }
        let address = unsafe { GetProcAddress(module, name.as_ptr().cast()) };
        if address.is_null() { return None; }
        // 安全前提：仅下方两个固定 user32 导出使用其文档 ABI/签名，不接收外部函数名。
        Some(unsafe { std::mem::transmute_copy(&address) })
    }
    struct Probe(*mut c_void);
    impl Drop for Probe { fn drop(&mut self) { unsafe { DestroyWindow(self.0); } } }
    fn size(rect: Rect) -> Result<(u32, u32)> {
        let width = rect.right.checked_sub(rect.left).filter(|n| *n > 0).ok_or_else(unavailable)?;
        let height = rect.bottom.checked_sub(rect.top).filter(|n| *n > 0).ok_or_else(unavailable)?;
        Ok((width as u32, height as u32))
    }
    pub(super) fn measure(monitor: &tauri::window::Monitor) -> Result<Frame> {
        // 与游戏普通可调整窗口同类的 WS_OVERLAPPEDWINDOW；没有 WS_VISIBLE、不建 WebView、不抢焦点。
        const STYLE: u32 = 0x00cf_0000;
        let scale = monitor.scale_factor();
        if !scale.is_finite() || scale <= 0.0 || scale > 64.0 { return Err(unavailable()); }
        let dpi = (scale * 96.0).round() as u32;
        let mut bounds = Rect { left: 0, top: 0, right: (400.0 * scale).round() as i32, bottom: (300.0 * scale).round() as i32 };
        // 延迟查找较新 DPI API：旧系统缺少入口时显式降级，不能让整个程序在加载器阶段退出。
        let adjust: AdjustForDpi = procedure(b"AdjustWindowRectExForDpi\0").ok_or_else(unavailable)?;
        let window_dpi: DpiForWindow = procedure(b"GetDpiForWindow\0").ok_or_else(unavailable)?;
        if unsafe { adjust(&mut bounds, STYLE, 0, 0, dpi) } == 0 { return Err(unavailable()); }
        let (width, height) = size(bounds)?;
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let title: Vec<u16> = "HCMCL size probe\0".encode_utf16().collect();
        let position = monitor.work_area().position;
        let window = unsafe { CreateWindowExW(0, class.as_ptr(), title.as_ptr(), STYLE, position.x.saturating_add(16), position.y.saturating_add(16), width as i32, height as i32, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut()) };
        if window.is_null() { return Err(unavailable()); }
        let probe = Probe(window);
        let actual_dpi = unsafe { window_dpi(probe.0) };
        if actual_dpi == 0 || actual_dpi != dpi { return Err(message("探针与主显示器 DPI 不一致", "探針與主顯示器 DPI 不一致", "Probe DPI does not match the primary display")); }
        let mut outer = Rect { left: 0, top: 0, right: 0, bottom: 0 };
        let mut inner = Rect { left: 0, top: 0, right: 0, bottom: 0 };
        if unsafe { GetWindowRect(probe.0, &mut outer) } == 0 || unsafe { GetClientRect(probe.0, &mut inner) } == 0 { return Err(unavailable()); }
        // 真正读取 outer-client，而非使用 AdjustWindowRect 的预估值作为测量结果。
        logical_frame(size(outer)?, size(inner)?, actual_dpi as f64 / 96.0)
    }
}

#[cfg(desktop)]
async fn sample(app: &tauri::AppHandle, request: Request, cancel: Arc<crate::downloads::Cancel>) -> Result<Sample> {
    let app = app.clone(); let callback_app = app.clone(); let callback_cancel = cancel.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        // 排队后取消/超时的回调不再操作窗口。这里不取得 GAME/STARTS/Storage/根目录锁。
        if send.is_closed() || callback_cancel.check().is_err() { return; }
        let result = (|| {
            let monitor = callback_app.primary_monitor().map_err(|_| unavailable())?.ok_or_else(unavailable)?;
            let display = Display { full: (monitor.size().width, monitor.size().height),
                work: (monitor.work_area().size.width, monitor.work_area().size.height), scale: monitor.scale_factor() };
            let frame = if request.mode == Mode::Maximized {
                #[cfg(windows)] { win_probe::measure(&monitor) }
                #[cfg(not(windows))] { Err(message("当前平台未提供隐藏原生装饰探针，按工作区降级", "目前平台未提供隱藏原生裝飾探針，改用工作區", "Hidden native decoration probing is unavailable on this platform; using the work area")) }
            } else { Ok(Frame { width: 0, height: 0 }) };
            Ok(Sample { display, frame })
        })();
        let _ = send.send(result);
    }).map_err(|_| unavailable())?;
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(cancelled()),
        value = tokio::time::timeout(std::time::Duration::from_secs(10), receive) => value.map_err(|_| unavailable())?.map_err(|_| unavailable())?,
    }
}

#[cfg(desktop)]
async fn warn(app: &tauri::AppHandle, decision: &Decision, cancel: Arc<crate::downloads::Cancel>) -> Result<()> {
    use tauri::Manager;
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let Some(warning) = &decision.warning else { return Ok(()); };
    let (title, body) = match warning {
        Warning::Oversize { full } => (message("游戏窗口尺寸超出屏幕", "遊戲視窗尺寸超出螢幕", "Game window is larger than the screen"), message(
            &format!("自定义尺寸 {}×{} 超出主屏幕 {}×{}，游戏可能显示不全。可在设置→游戏中选择较小尺寸或最大化。", decision.width, decision.height, full.0, full.1),
            &format!("自訂尺寸 {}×{} 超出主螢幕 {}×{}，遊戲可能顯示不全。可在設定→遊戲選擇較小尺寸或最大化。", decision.width, decision.height, full.0, full.1),
            &format!("The custom size {}×{} exceeds the primary screen {}×{}. The game may be clipped. Choose a smaller size or Maximized under Settings → Game.", decision.width, decision.height, full.0, full.1))),
        Warning::FrameUnavailable(reason) => (message("窗口装饰测量不可用", "視窗裝飾測量無法使用", "Window decorations could not be measured"), format!("{}\n{reason}", message("本次最大化采用主显示器工作区，未扣除未经测量的边框；窗口可能超出工作区。", "本次最大化採用主顯示器工作區，未扣除未經測量的邊框；視窗可能超出工作區。", "Maximized uses the primary work area without an unmeasured frame deduction; the window may extend beyond the work area."))),
    };
    let handle = app.clone(); let callback_app = handle.clone(); let callback_cancel = cancel.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    handle.run_on_main_thread(move || {
        if send.is_closed() || callback_cancel.check().is_err() { return; }
        let Some(main) = callback_app.get_webview_window("main") else { let _ = send.send(Err(unavailable())); return; };
        // 非阻塞原生对话框：仅异步启动任务等待用户，不让主 UI recv/等待工作线程。
        callback_app.dialog().message(body).title(title).parent(&main).kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCustom(message("仍然启动", "仍然啟動", "Launch anyway")))
            .show(move |_| { let _ = send.send(Ok(())); });
    }).map_err(|_| unavailable())?;
    tokio::select! { biased; _ = cancel.cancelled() => Err(cancelled()), value = receive => value.map_err(|_| unavailable())? }
}

/// 移动端的「窗口」就是屏幕：画面由 `SurfaceView` 铺满，没有边框、任务栏与 DPI 换算。
///
/// 桌面分支的采样是必需的（缺显示器就报错，不猜分辨率）；手机上却压根没有窗口可测，
/// 只有一块屏幕。取不到时按 720P 兜底而不拒绝启动——真正的画面尺寸随后由
/// `surfaceChanged` 上报，这里的值只影响 `--width/--height` 这个初始提示。
#[cfg(all(not(desktop), target_os = "android"))]
fn mobile_decision() -> Decision {
    let (width, height) = crate::android_host::display_size().unwrap_or((1280, 720));
    Decision {
        width: width.clamp(MIN_WINDOW, MAX_WINDOW),
        height: height.clamp(MIN_WINDOW, MAX_WINDOW),
        // 手机上没有「切全屏」这一步：Surface 已经占满屏幕，再传 `--fullscreen`
        // 只会让 GLFW 去找一个并不存在的显示器。
        fullscreen: false,
        warning: None,
    }
}

/// 每次启动采样，不缓存任务栏/DPI；调用点必须在游戏目录根锁之前。
pub(super) async fn resolve_options(app: &tauri::AppHandle, settings: &Value, options: Value, cancel: Arc<crate::downloads::Cancel>) -> Result<Value> {
    if cancel.check().is_err() { return Err(cancelled()); }
    let request = Request::parse(settings, &options)?;
    #[cfg(desktop)]
    {
        let measured = if request.needs_monitor() { Some(sample(app, request, cancel.clone()).await?) } else { None };
        let decision = decide(request, measured.as_ref())?;
        warn(app, &decision, cancel.clone()).await?;
        if cancel.check().is_err() { return Err(cancelled()); }
        decision.apply(options)
    }
    #[cfg(all(not(desktop), target_os = "android"))]
    {
        let _ = (app, request);
        mobile_decision().apply(options)
    }
    #[cfg(all(not(desktop), not(target_os = "android")))]
    {
        let _ = (app, request);
        Err(message("移动端未提供桌面游戏窗口尺寸", "行動端未提供桌面遊戲視窗尺寸", "Desktop game window sizing is unavailable on mobile"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn screen(full: (u32,u32), work: (u32,u32), scale: f64, frame: Frame) -> Sample { Sample { display: Display { full, work, scale }, frame: Ok(frame) } }
    fn resolve(settings: Value, options: Value, sample: Option<&Sample>) -> (Decision, Value) {
        let decision = decide(Request::parse(&settings,&options).unwrap(),sample).unwrap();
        let applied = decision.apply(options).unwrap(); (decision,applied)
    }
    #[test]
    fn saved_modes_override_caller_resolution_and_fullscreen_precedence_is_explicit() {
        let sample = screen((3840,2160),(3840,2080),2.0,Frame { width: 8,height: 31 });
        let (full,options) = resolve(json!({"gameWindowSize":"fullscreen"}),json!({"fullscreen":false,"resolution":{"width":500,"height":400},"demo":true}),Some(&sample));
        assert_eq!((full.width,full.height,full.fullscreen),(1920,1080,true));
        assert_eq!(options["demo"],true); assert_eq!(launch_arguments(&options).unwrap(),(1920,1080,true));
        let (win10,_) = resolve(json!({"experimental":"win10","gameWindowSize":"custom","gameWindowWidth":500,"gameWindowHeight":400}),json!({"fullscreen":false}),Some(&sample));
        assert_eq!(win10,full);
        for (mode,expected) in [("720p",(1280,720)),("1080p",(1920,1080)),("unknown",(1280,720))] {
            let (decision,_) = resolve(json!({"gameWindowSize":mode}),json!({"resolution":"ignored caller value","fullscreen":true}),None);
            assert_eq!((decision.width,decision.height),(expected.0,expected.1)); assert!(decision.fullscreen);
        }
        assert!(Request::parse(&json!({}),&json!({"fullscreen":"true"})).is_err());
    }
    #[test]
    fn maximized_subtracts_measured_decorations_in_logical_pixels_and_refreshes_workarea() {
        let frame = logical_frame((816,714),(800,600),2.0).unwrap();
        assert_eq!(frame,Frame { width: 8,height: 57 });
        let sample = screen((3840,2160),(3840,2064),2.0,frame);
        let settings=json!({"gameWindowSize":"maximized"});
        let (decision,_) = resolve(settings.clone(),json!({}),Some(&sample));
        assert_eq!((decision.width,decision.height),(1912,975)); assert!(decision.warning.is_none());
        let hidden_taskbar=screen((3840,2160),(3840,2160),2.0,frame);
        assert_eq!(resolve(settings.clone(),json!({}),Some(&hidden_taskbar)).0.height,1023);
        let small=screen((400,400),(200,200),1.0,frame);
        assert_eq!((resolve(settings,json!({}),Some(&small)).0.width,resolve(json!({"gameWindowSize":"maximized"}),json!({}),Some(&small)).0.height),(320,320));
    }
    #[test]
    fn custom_rounds_clamps_and_warns_without_replacing_saved_dimensions() {
        let sample=screen((1920,1080),(1920,1032),1.0,Frame { width:8,height:57 });
        let (decision,_) = resolve(json!({"gameWindowSize":"custom","gameWindowWidth":20000,"gameWindowHeight":-5}),json!({"resolution":{"width":640,"height":480}}),Some(&sample));
        assert_eq!((decision.width,decision.height),(16384,320));
        assert_eq!(decision.warning,Some(Warning::Oversize { full:(1920,1080) }));
        let (decision,_) = resolve(json!({"gameWindowSize":"custom","gameWindowWidth":800.5,"gameWindowHeight":600.4}),json!({}),Some(&sample));
        assert_eq!((decision.width,decision.height),(801,600)); assert!(decision.warning.is_none());
        let (missing,_) = resolve(json!({"gameWindowSize":"custom"}),json!({}),Some(&sample));
        assert_eq!((missing.width,missing.height),(320,320));
    }
    #[test]
    fn absent_or_invalid_display_is_not_a_guessed_fullscreen_and_frame_failure_is_visible() {
        let request=Request::parse(&json!({"gameWindowSize":"fullscreen"}),&json!({})).unwrap();
        assert!(decide(request,None).is_err());
        for scale in [0.0,-1.0,f64::NAN,f64::INFINITY] {
            assert!(decide(request,Some(&screen((1920,1080),(1920,1032),scale,Frame { width:8,height:57 }))).is_err());
        }
        let mut sample=screen((1920,1080),(1920,1032),1.0,Frame { width:8,height:57 });
        sample.frame=Err("synthetic unsupported platform".into());
        let (decision,_) = resolve(json!({"gameWindowSize":"maximized"}),json!({}),Some(&sample));
        assert_eq!((decision.width,decision.height),(1920,1032));
        assert_eq!(decision.warning,Some(Warning::FrameUnavailable("synthetic unsupported platform".into())));
        assert!(logical_frame((400,300),(400,300),1.0).is_err());
        assert!(logical_frame((399,300),(400,300),1.0).is_err());
    }
}

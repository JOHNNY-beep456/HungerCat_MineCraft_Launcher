//! Android 宿主桥：连接「启动器（Kotlin/ART）」与「游戏（进程内 HotSpot）」。
//!
//! 两个方向都要跨过**两个虚拟机**的边界：
//! - Kotlin → Rust：`GameHost.native*` 由 ART 调用，传进来的 `JNIEnv` 属于 ART，
//!   只能用来读字符串，不能碰游戏类。
//! - Rust → Kotlin：铺开游戏画面必须回到 Android 主线程，而主线程的 `JNIEnv` 只能从
//!   进程的 `JavaVM` 取（`ndk-context`），并且要经 Activity 的类加载器才能找到应用类。

use jni::objects::{JClass, JObject, JString, JValue};
use jni::sys::jstring;
use jni::JavaVM;
use serde_json::Value;
use std::panic::{catch_unwind, AssertUnwindSafe};

const GAME_HOST: &str = "top.johnnyblog.hcmcl.runtime.GameHost";

fn read(env: &mut jni::JNIEnv<'_>, value: &JString<'_>) -> String {
    env.get_string(value).map(String::from).unwrap_or_default()
}

/// ART 调用：下发 `nativeLibraryDir` 与 `filesDir`。
#[no_mangle]
pub extern "system" fn Java_top_johnnyblog_hcmcl_runtime_GameHost_nativeConfigure<'local>(
    mut env: jni::JNIEnv<'local>,
    _this: JObject<'local>,
    native_dir: JString<'local>,
    files_dir: JString<'local>,
) {
    let native = read(&mut env, &native_dir);
    let files = read(&mut env, &files_dir);
    if native.is_empty() || files.is_empty() {
        return;
    }
    crate::android_jvm::configure(&native, &files);
}

/// ART 调用：在当前线程建立（或复用）JVM 并跑游戏主类，直到主方法返回。
///
/// 返回 `ok` 或错误说明。无论成功失败都要登记「已结束」，否则界面会一直停在运行中。
#[no_mangle]
pub extern "system" fn Java_top_johnnyblog_hcmcl_runtime_GameHost_nativeStartGame<'local>(
    mut env: jni::JNIEnv<'local>,
    _this: JObject<'local>,
    spec: JString<'local>,
) -> jstring {
    let raw = read(&mut env, &spec);
    let outcome = catch_unwind(AssertUnwindSafe(|| -> Result<(), String> {
        let parsed: Value =
            serde_json::from_str(&raw).map_err(|_| "启动规格不是合法 JSON".to_string())?;
        crate::android_jvm::launch(&parsed)
    }));
    let (code, message) = match outcome {
        Ok(Ok(())) => (0, "ok".to_string()),
        Ok(Err(error)) => (-1, error),
        Err(_) => (-1, "游戏启动过程中发生内部错误（详见 logcat）".to_string()),
    };
    crate::runtime::android_game_finished(code);
    env.new_string(message)
        .map(|value| value.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

/// 游戏 JVM 里的引导类回调：把宿主的七个事件发送入口登记到 GLFW 事件桥。
#[no_mangle]
pub extern "system" fn Java_hcmcl_Boot_nativePrepareInput(mut env: jni::JNIEnv<'_>, _class: JClass<'_>) {
    if let Err(error) = crate::android_jvm::register_input(&mut env) {
        log_error(&error);
    }
}

/// 所有输入入口都走同一套「附着到游戏 JVM 再调用引导类」的路径。
///
/// 触控事件本身属于 ART，而 GLFW 的事件队列在进程内的 HotSpot 里，两次虚拟机之间的
/// 桥只能是 JNI；这里不做聚合，因为一次拖动每秒也就一两百个事件。
fn forward(method: &str, signature: &str, args: &[JValue<'_, '_>]) {
    if let Err(error) = crate::android_jvm::input(method, signature, args) {
        log_error(&error);
    }
}

extern "C" {
    fn __android_log_write(priority: std::ffi::c_int, tag: *const std::ffi::c_char, text: *const std::ffi::c_char) -> std::ffi::c_int;
}

fn log_error(message: &str) {
    let text = std::ffi::CString::new(message.replace('\0', " ")).unwrap_or_default();
    let tag = std::ffi::CString::new("HcmclInput").unwrap_or_default();
    unsafe {
        // 6 = ANDROID_LOG_ERROR：输入失败不该打断游戏，只留一条 logcat。
        __android_log_write(6, tag.as_ptr(), text.as_ptr());
    }
}

#[no_mangle]
pub extern "system" fn Java_top_johnnyblog_hcmcl_runtime_GameHost_nativeKey(
    _env: jni::JNIEnv<'_>,
    _this: JObject<'_>,
    key: jni::sys::jint,
    scancode: jni::sys::jint,
    action: jni::sys::jint,
    mods: jni::sys::jint,
) {
    forward(
        "key",
        "(IIII)V",
        &[
            JValue::Int(key),
            JValue::Int(scancode),
            JValue::Int(action),
            JValue::Int(mods),
        ],
    );
}

#[no_mangle]
pub extern "system" fn Java_top_johnnyblog_hcmcl_runtime_GameHost_nativeLook(
    _env: jni::JNIEnv<'_>,
    _this: JObject<'_>,
    dx: jni::sys::jfloat,
    dy: jni::sys::jfloat,
) {
    forward("look", "(FF)V", &[JValue::Float(dx), JValue::Float(dy)]);
}

#[no_mangle]
pub extern "system" fn Java_top_johnnyblog_hcmcl_runtime_GameHost_nativeMouse(
    _env: jni::JNIEnv<'_>,
    _this: JObject<'_>,
    button: jni::sys::jint,
    action: jni::sys::jint,
    mods: jni::sys::jint,
) {
    forward(
        "mouse",
        "(III)V",
        &[JValue::Int(button), JValue::Int(action), JValue::Int(mods)],
    );
}

#[no_mangle]
pub extern "system" fn Java_top_johnnyblog_hcmcl_runtime_GameHost_nativeScroll(
    _env: jni::JNIEnv<'_>,
    _this: JObject<'_>,
    amount: jni::sys::jdouble,
) {
    forward("scroll", "(D)V", &[JValue::Double(amount)]);
}

/// 文字输入：输入法一次提交的整串字符。
///
/// 整串传而不是逐字传，是因为中文/日文输入法一次提交常是多个字符，每个字符跨一次
/// 虚拟机边界没有意义；拆成码点的工作交给游戏侧的 `hcmcl.Boot.text`。
#[no_mangle]
pub extern "system" fn Java_top_johnnyblog_hcmcl_runtime_GameHost_nativeText<'local>(
    mut env: jni::JNIEnv<'local>,
    _this: JObject<'local>,
    value: JString<'local>,
) {
    if read(&mut env, &value).is_empty() {
        return;
    }
    forward("text", "(Ljava/lang/String;)V", &[JValue::Object(&value)]);
}

#[no_mangle]
pub extern "system" fn Java_top_johnnyblog_hcmcl_runtime_GameHost_nativeScreen(
    _env: jni::JNIEnv<'_>,
    _this: JObject<'_>,
    width: jni::sys::jint,
    height: jni::sys::jint,
) {
    SCREEN.store(
        ((width as u64) << 32) | (height as u32 as u64),
        std::sync::atomic::Ordering::Release,
    );
    forward("screen", "(II)V", &[JValue::Int(width), JValue::Int(height)]);
}

/// 画面尺寸。
///
/// `surfaceChanged` 往往早于 JVM 创建完成，那一次投递会失败；因此这里留一份，
/// 等 JVM 起来（`android_jvm::launch`）再补一次，否则视角移动会被夹在 1×1 的窗口里。
static SCREEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub(crate) fn screen_size() -> Option<(i32, i32)> {
    let packed = SCREEN.load(std::sync::atomic::Ordering::Acquire);
    if packed == 0 {
        None
    } else {
        Some(((packed >> 32) as i32, (packed & 0xffff_ffff) as i32))
    }
}

/// 屏幕尺寸查询的超时上限。
///
/// 这个值只影响初始 `--width/--height`，真正画面尺寸由 `surfaceChanged` 决定，
/// 所以绝不该为了它把整条启动流程挂起：JNI 附着或窗口度量在个别设备/线程上可能长时间
/// 不返回，超时就按 720P 兜底继续启动。
const DISPLAY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// 屏幕尺寸（物理像素，横向）。
///
/// 手机上不存在桌面窗口：游戏画面铺满 `SurfaceView`，尺寸就是屏幕本身。启动流程在
/// `GameHost.start` 之前就要 `resolution` 参数，那时 Surface 还没创建，只能先问屏幕；
/// 之后 `surfaceChanged` 上报的真实尺寸会把它覆盖掉。
pub(crate) fn display_size() -> Option<(u32, u32)> {
    let (send, receive) = std::sync::mpsc::channel();
    // 单独一条短命线程：JNI 一旦卡住，只损失这条线程，启动流程照常前进。
    let spawned = std::thread::Builder::new()
        .name("hcmcl-display".into())
        .spawn(move || {
            let _ = send.send(display_size_inner());
        });
    if spawned.is_err() {
        log_error("无法创建屏幕尺寸查询线程，按 720P 兜底");
        return None;
    }
    match receive.recv_timeout(DISPLAY_TIMEOUT) {
        Ok(Ok(size)) => Some(size),
        Ok(Err(error)) => {
            log_error(&error);
            None
        }
        Err(_) => {
            log_error("屏幕尺寸查询超时，按 720P 兜底继续启动");
            None
        }
    }
}

fn display_size_inner() -> Result<(u32, u32), String> {
    let context = catch_unwind(ndk_context::android_context)
        .map_err(|_| "Android 上下文尚未初始化".to_string())?;
    let vm = unsafe { JavaVM::from_raw(context.vm() as *mut jni::sys::JavaVM) }
        .map_err(|_| "无法获取应用 JavaVM".to_string())?;
    // 启动流程跑在异步线程池上：附着一次、返回后自动分离，不长期占用该线程。
    let mut env = vm
        .attach_current_thread()
        .map_err(|_| "无法连接 Android 应用线程".to_string())?;
    let activity = unsafe { JObject::from_raw(context.context() as jni::sys::jobject) };
    let loader = env
        .call_method(&activity, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
        .and_then(|value| value.l())
        .map_err(|error| clear(&mut env, error))?;
    let name = env
        .new_string(GAME_HOST)
        .map_err(|error| clear(&mut env, error))?;
    let class = env
        .call_method(
            &loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::Object(&name)],
        )
        .and_then(|value| value.l())
        .map_err(|error| clear(&mut env, error))?;
    let value = env
        .call_static_method(JClass::from(class), "displaySize", "()[I", &[])
        .map_err(|error| clear(&mut env, error))?;
    let array = value.l().map_err(|error| clear(&mut env, error))?;
    let array = jni::objects::JIntArray::from(array);
    if env
        .get_array_length(&array)
        .map_err(|error| clear(&mut env, error))?
        < 2
    {
        return Err("宿主返回的屏幕尺寸不完整".into());
    }
    let mut buffer = [0i32; 2];
    env.get_int_array_region(&array, 0, &mut buffer)
        .map_err(|error| clear(&mut env, error))?;
    let (width, height) = (buffer[0], buffer[1]);
    if width <= 0 || height <= 0 {
        return Err("宿主未能确定屏幕尺寸".into());
    }
    Ok((width as u32, height as u32))
}

fn clear(env: &mut jni::JNIEnv<'_>, error: jni::errors::Error) -> String {
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
        return "Android 宿主调用抛出异常（详见 logcat）".into();
    }
    format!("Android 宿主调用失败：{error}")
}

fn call_start(spec: &str) -> Result<(), String> {
    let context = catch_unwind(ndk_context::android_context)
        .map_err(|_| "Android 上下文尚未初始化".to_string())?;
    let vm = unsafe { JavaVM::from_raw(context.vm() as *mut jni::sys::JavaVM) }
        .map_err(|_| "无法获取应用 JavaVM".to_string())?;
    // 主线程已经附着在 ART 上，这里不能再走会在 Drop 时分离的路径。
    let mut env = vm
        .attach_current_thread_permanently()
        .map_err(|_| "无法连接 Android 主线程".to_string())?;
    let activity = unsafe { JObject::from_raw(context.context() as jni::sys::jobject) };

    let loader = env
        .call_method(&activity, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
        .and_then(|value| value.l())
        .map_err(|error| clear(&mut env, error))?;
    let name = env
        .new_string(GAME_HOST)
        .map_err(|error| clear(&mut env, error))?;
    let class = env
        .call_method(
            &loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::Object(&name)],
        )
        .and_then(|value| value.l())
        .map_err(|error| clear(&mut env, error))?;
    let class = JClass::from(class);
    let argument = env
        .new_string(spec)
        .map_err(|error| clear(&mut env, error))?;
    env.call_static_method(
        &class,
        "start",
        "(Ljava/lang/String;)V",
        &[JValue::Object(&argument)],
    )
    .map_err(|error| clear(&mut env, error))?;
    Ok(())
}

/// 回到 Android 主线程铺开游戏画面，并等它真正完成视图挂载。
///
/// 不等待就会踩到一个经典竞态：调用方以为已经「运行中」，而 `Surface` 还没创建，
/// 游戏线程拿不到 `ANativeWindow`。
pub(crate) fn show_game(app: &tauri::AppHandle, spec: String) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(call_start(&spec));
    })
    .map_err(|_| "无法切换到 Android 主线程".to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(15))
        .map_err(|_| "等待主线程创建游戏画面超时".to_string())?
}

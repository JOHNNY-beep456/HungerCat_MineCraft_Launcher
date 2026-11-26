//! Android 进程内 JVM。
//!
//! Android 10 起应用私有目录不再允许 `exec`，桌面那套「解压 JRE 后跑 `bin/java`」在手机上
//! 不可用。这里改为：bionic 编译的 JRE 原生库随 APK 的 `lib/<abi>/` 分发，由本进程
//! `dlopen` `libjvm.so` 后直接 `JNI_CreateJavaVM`，JVM 与系统 ART 并存于同一进程。
//! 平台无关部分（`lib/modules`、`conf`、引导 jar）由 Kotlin 侧从 assets 解到 filesDir。
//!
//! 注意 ART 与这个 HotSpot 是**两个独立虚拟机**：Kotlin 线程带进来的是 ART 的 `JNIEnv`，
//! 不能用来碰游戏类。所有对游戏 JVM 的调用都走本模块持有的 `JavaVM`，由它新建/附加线程。

use jni::objects::{JObject, JValue};
use jni::sys::{jint, JavaVMInitArgs, JavaVMOption, JNI_VERSION_1_8};
use jni::JavaVM;
use serde_json::Value;
use std::ffi::{c_char, c_void, CString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicPtr, Ordering};
use std::sync::{Mutex, OnceLock};

type CreateJavaVm =
    unsafe extern "C" fn(*mut *mut c_void, *mut *mut c_void, *mut JavaVMInitArgs) -> jint;

/// 写进 `-Dminecraft.launcher.brand` 的品牌串。
///
/// 部分 mod 与崩溃报告会把它原样显示；留空会让它们退化成 `Unknown`，出问题时反而
/// 少了一条「是哪个启动器」的线索。
const LAUNCHER_BRAND: &str = "HCMCL";

struct Runtime {
    vm: JavaVM,
}

/// 创建后的 `JavaVM` 原始句柄。
///
/// `RUNTIME` 的互斥锁在整局游戏期间被 `launch` 持有，输入线程不能去抢同一把锁，
/// 因此单独存一份裸指针，输入调用只读它。
static VM_HANDLE: AtomicPtr<jni::sys::JavaVM> = AtomicPtr::new(std::ptr::null_mut());

/// Kotlin 侧 `GameHost.attach` 下发的目录：`nativeLibraryDir` 与 `filesDir`。
///
/// `nativeLibraryDir` 是 APK 解出的 `lib/<abi>/` 绝对路径，正是 `libjvm.so`、
/// `libpojavexec.so` 与 `libgl4es_114.so` 的实际位置，因此它也充当 `java.library.path`。
static CONFIG: OnceLock<(PathBuf, PathBuf)> = OnceLock::new();
static RUNTIME: OnceLock<Mutex<Option<Runtime>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<Runtime>> {
    RUNTIME.get_or_init(|| Mutex::new(None))
}

/// 已创建的那个 JVM 属于哪个 Java 版本与目录。
///
/// 进程内只能创建一次 JVM，因此这里既是「用了几版」的记录，也是换版本时的判断依据。
static ACTIVE: OnceLock<Mutex<Option<(u64, PathBuf)>>> = OnceLock::new();

fn active_home() -> &'static Mutex<Option<(u64, PathBuf)>> {
    ACTIVE.get_or_init(|| Mutex::new(None))
}

/// 记录 Kotlin 侧下发的目录；重复调用以首次为准。
pub(crate) fn configure(native_dir: &str, files_dir: &str) {
    let _ = CONFIG.set((PathBuf::from(native_dir), PathBuf::from(files_dir)));
}

fn config() -> Result<(&'static Path, &'static Path), String> {
    CONFIG
        .get()
        .map(|(native, files)| (native.as_path(), files.as_path()))
        .ok_or_else(|| "Android 运行时目录尚未下发，请重新打开应用".to_string())
}

/// 运行时根目录，与 Kotlin 的 `RuntimeInstaller` 使用同一个 `filesDir/runtime` 约定。
fn runtime_root() -> Result<PathBuf, String> {
    Ok(config()?.1.join("runtime"))
}

fn java_home() -> Result<PathBuf, String> {
    Ok(runtime_root()?.join("jre"))
}

fn boot_jar() -> Result<PathBuf, String> {
    Ok(runtime_root()?.join("boot.jar"))
}

/// 随包的 LWJGL for Android 类库。桌面版 LWJGL 的 Java 绑定在 bionic 上无法加载原生库，
/// 必须由它整体替换，因此它会排在游戏类路径最前面。
pub(crate) fn lwjgl_jar() -> Option<PathBuf> {
    let jar = runtime_root().ok()?.join("lwjgl").join("lwjgl-glfw-classes.jar");
    jar.is_file().then_some(jar)
}

/// APK 原生库目录；移动端 `java.library.path` 与 `natives_directory` 都指向这里。
pub(crate) fn native_dir() -> Option<PathBuf> {
    config().ok().map(|(native, _)| native.to_path_buf())
}

/// 应用私有目录；下载的 Java 运行时放在它下面的 `runtimes/`。
pub(crate) fn files_dir() -> Option<PathBuf> {
    config().ok().map(|(_, files)| files.to_path_buf())
}

/// 内置 JRE 根目录（`assets/runtime/jre` 解出来的那份）。
pub(crate) fn bundled_home() -> Option<PathBuf> {
    java_home().ok()
}

/// 运行时就绪判据：类库镜像与引导 jar 都由 Kotlin 侧解压完成后才存在。
pub(crate) fn installed() -> bool {
    match (java_home(), boot_jar()) {
        (Ok(home), Ok(jar)) => home.join("lib").join("modules").is_file() && jar.is_file(),
        _ => false,
    }
}

/// 从 `jre/release` 读取版本，回答「这套运行时是什么」。
///
/// 这里刻意不创建 JVM：堆上限在创建时固定，若为了探测先建一次，用户配置的内存就再也改不了。
fn release_field(text: &str, key: &str) -> Option<String> {
    text.lines()
        .find_map(|line| line.strip_prefix(key)?.strip_prefix('=').map(|v| v.trim().trim_matches('"').to_string()))
}

pub(crate) fn probe() -> Result<String, String> {
    // 已经建过 VM 时回答「正在用的那套」，否则回答内置那套——`java:check` 的用途就是这个。
    let active = active_home()
        .lock()
        .ok()
        .and_then(|state| state.as_ref().map(|(_, home)| home.clone()))
        .filter(|home| home.join("release").is_file());
    let home = match active {
        Some(home) => home,
        None => {
            if !installed() {
                return Err("Android 运行时尚未准备完成，请重新打开应用".into());
            }
            java_home()?
        }
    };
    let text = std::fs::read_to_string(home.join("release"))
        .map_err(|_| "无法读取内置运行时版本信息".to_string())?;
    let version = release_field(&text, "JAVA_VERSION").unwrap_or_else(|| "?".into());
    let implementor = release_field(&text, "IMPLEMENTOR").unwrap_or_else(|| "OpenJDK".into());
    Ok(format!("{version}|{implementor}|{}", home.display()))
}

/// 本次会话已经创建过 JVM 的 Java 主版本；还没建过时返回 `None`。
///
/// 用于两件事：换版本时要求重启；删运行时前判断「是不是正在用的那一套」。
pub(crate) fn active_major() -> Option<u64> {
    active_home()
        .lock()
        .ok()
        .and_then(|state| state.as_ref().map(|(major, _)| *major))
}

fn set_env(key: &str, value: &str) {
    let (Ok(key), Ok(value)) = (CString::new(key), CString::new(value)) else {
        return;
    };
    unsafe {
        libc::setenv(key.as_ptr(), value.as_ptr(), 1);
    }
}

/// gl4es 的开关必须在它被 dlopen 之前设好，初始化时只读一次环境变量。
///
/// `LIBGL_ES=3` 让 gl4es 走 GLES 3 后端——Minecraft 1.17 起要求 GL 3.2，
/// 只有 GLES 3 设备才可能在转发层上满足；`LIBGL_NOBANNER` 避免往 stdout 打印横幅。
fn prepare_renderer() {
    set_env("LIBGL_ES", "3");
    set_env("LIBGL_NOBANNER", "1");
    set_env("LIBGL_FB", "1");
}

fn create(options: &[String], library_path: Option<&Path>) -> Result<Runtime, String> {
    let mut texts: Vec<CString> = Vec::new();
    for text in options {
        texts.push(CString::new(text.as_str()).map_err(|_| "JVM 参数包含空字符")?);
    }
    let mut raw: Vec<JavaVMOption> = texts
        .iter()
        .map(|text| JavaVMOption {
            optionString: text.as_ptr() as *mut c_char,
            extraInfo: std::ptr::null_mut(),
        })
        .collect();
    let mut args = JavaVMInitArgs {
        version: JNI_VERSION_1_8,
        nOptions: raw.len() as jint,
        options: raw.as_mut_ptr(),
        ignoreUnrecognized: 1,
    };

    // 两个来源：内置 17 的 `libjvm.so` 在 APK 的 `lib/<abi>/`（由 linker 搜索路径找到），
    // 下载来的 21/25 自带 `lib/server/libjvm.so`，必须按绝对路径加载——同名库已在进程里
    // 存在时，`dlopen("libjvm.so")` 只会拿到旧的那份，版本就对不上了。
    let library = match library_path {
        Some(path) => CString::new(path.to_string_lossy().as_ref()).map_err(|_| "JVM 库路径包含空字符")?,
        None => CString::new("libjvm.so").expect("literal"),
    };
    let reason = match library_path {
        Some(_) => "无法加载所选 Java 运行时的 libjvm.so：该目录可能不完整，请删除后重新下载",
        None => "无法加载 libjvm.so：APK 未包含 JRE 原生库，或当前 ABI 没有对应的构建",
    };
    unsafe {
        let handle = libc::dlopen(library.as_ptr(), libc::RTLD_NOW | libc::RTLD_GLOBAL);
        if handle.is_null() {
            return Err(reason.into());
        }
        let entry = libc::dlsym(handle, b"JNI_CreateJavaVM\0".as_ptr() as *const c_char);
        if entry.is_null() {
            return Err("JVM 原生库缺少 JNI_CreateJavaVM 符号".into());
        }
        let create: CreateJavaVm = std::mem::transmute(entry);
        let mut vm: *mut c_void = std::ptr::null_mut();
        let mut env: *mut c_void = std::ptr::null_mut();
        let code = create(&mut vm, &mut env, &mut args);
        if code != 0 || vm.is_null() {
            return Err(format!(
                "创建 Android JVM 失败（JNI 错误码 {code}）；请重新安装应用以补齐运行时"
            ));
        }
        let vm = JavaVM::from_raw(vm as *mut jni::sys::JavaVM)
            .map_err(|_| "JVM 句柄无效".to_string())?;
        VM_HANDLE.store(vm.get_java_vm_pointer(), Ordering::Release);
        Ok(Runtime { vm })
    }
}

fn java_error(env: &mut jni::JNIEnv<'_>) -> String {
    if let Ok(true) = env.exception_check() {
        // 详细堆栈交给 logcat 与游戏日志：上层只需要一个稳定的中文说明。
        let _ = env.exception_describe();
        let _ = env.exception_clear();
        return "Android JVM 引导类抛出异常（详见 logcat）".into();
    }
    "Android JVM 调用失败".into()
}

/// 建立（或复用）JVM 并在当前线程运行游戏主类。
///
/// 调用方必须是一条**自己新建的线程**：HotSpot 会把调用 `JNI_CreateJavaVM` 的线程当作
/// JVM 的主线程，游戏的渲染线程也就在这条线程上。
pub(crate) fn launch(spec: &Value) -> Result<(), String> {
    if !installed() {
        return Err("Android 运行时尚未准备完成，请重新打开应用".into());
    }
    let classpath = spec["classpath"].as_str().unwrap_or_default().to_string();
    let main = spec["main"].as_str().unwrap_or_default().to_string();
    let log = spec["log"].as_str().unwrap_or_default().to_string();
    if classpath.is_empty() || main.is_empty() || log.is_empty() {
        return Err("启动规格缺少类路径、主类或日志路径".into());
    }
    let heap = spec["heap"].as_u64().unwrap_or(2048).clamp(256, 262_144);

    // 1. 工作目录：多数版本管理器与模组会按相对路径找配置和资源。
    if let Some(cwd) = spec["cwd"].as_str().filter(|v| !v.is_empty()) {
        let path = CString::new(cwd).map_err(|_| "启动目录包含空字符".to_string())?;
        unsafe {
            libc::chdir(path.as_ptr());
        }
    }
    prepare_renderer();

    // 2. JVM 只加载引导 jar；游戏类路径交给 `Boot.launch` 的子加载器。
    let bundled_home = java_home()?;
    let custom = spec["custom"].as_bool().unwrap_or(false);
    let major = spec["major"].as_u64().unwrap_or(17);
    let home = if custom {
        let raw = spec["runtime"].as_str().unwrap_or_default();
        if raw.is_empty() {
            return Err("启动规格缺少 Java 运行时目录".into());
        }
        PathBuf::from(raw)
    } else {
        bundled_home.clone()
    };
    // 一个进程只能有一个 JVM：`libjvm.so` 一旦进来就不会走，第二次启动换版本只能是另一份库。
    // 与其让它莫名跑在旧版本上，不如明确要求重启。
    {
        if let Some((used_major, used_home)) = active_home().lock().map_err(|_| "Java 运行时状态不可用")?.as_ref() {
            if used_home != &home {
                return Err(format!(
                    "本次应用已用 Java {used_major} 创建过虚拟机，切换 Java 版本需要重启应用后再启动"
                ));
            }
        }
    }
    let scratch = runtime_root()?;
    let tmp = scratch.join("tmp");
    let user_home = scratch.join("home");
    let _ = std::fs::create_dir_all(&tmp);
    let _ = std::fs::create_dir_all(&user_home);
    let boot = boot_jar()?;
    let mut options = vec![
        format!("-Djava.home={}", home.display()),
        format!("-Djava.class.path={}", boot.display()),
        format!("-Djava.io.tmpdir={}", tmp.display()),
        format!("-Duser.home={}", user_home.display()),
        "-Dfile.encoding=UTF-8".to_string(),
        "-Dsun.jnu.encoding=UTF-8".to_string(),
        "-Djava.awt.headless=true".to_string(),
        "-XX:+UseSerialGC".to_string(),
        // 不接管进程信号：HotSpot 的 signal handler 会与 ART 冲突。
        "-Xrs".to_string(),
        format!("-Xmx{heap}M"),
    ];
    // 自定义运行时自带 `lib/` 下的 JVM 依赖库，内置版本则依赖 APK 的 `lib/<abi>/`；
    // 两种情况下都要包含 `nativeLibraryDir`，因为 `libpojavexec`、gl4es 与宿主库都在那里。
    {
        let mut paths: Vec<String> = Vec::new();
        if custom {
            paths.push(home.join("lib").to_string_lossy().into_owned());
        }
        if let Some(native) = native_dir() {
            paths.push(native.to_string_lossy().into_owned());
        }
        if !paths.is_empty() {
            options.push(format!("-Djava.library.path={}", paths.join(":")));
        }
        // 原生库查找通道要走两条：`java.library.path` 只被 `System.loadLibrary` 用，
        // 而 LWJGL3 的 SharedLibraryLoader 与 JNA 各自认自己的属性。只设前者时，
        // stb/tinyfd/openal 这些模块会在运行到一半时才报「找不到库」。
        let writable = tmp.to_string_lossy().into_owned();
        if !paths.is_empty() {
            let joined = paths.join(":");
            options.push(format!("-Dorg.lwjgl.librarypath={joined}"));
        }
        // JNA / Netty 会先把 .so 解到临时目录再 dlopen。默认位置在 Android 上要么不存在
        // （`/tmp`），要么不可写；指向应用自己的临时目录才能稳定落地。
        options.push(format!("-Djna.tmpdir={writable}"));
        options.push(format!("-Dio.netty.native.workdir={writable}"));
        // 版本清单里的 `-Dfml.*` 只有 Forge 自家安装器会写；移动端走自己的组装流程，
        // 需要在这里补上：Forge 对证书链与二进制补丁差异是硬失败，而手机上的网络栈
        // 与桌面差异很大（系统 CA、透明代理、CDN 分片）。
        options.push("-Dfml.ignoreInvalidMinecraftCertificates=true".into());
        options.push("-Dfml.ignorePatchDiscrepancies=true".into());
        // 1.17 之前的版本仍带 log4j2 2.0~2.14；这条属性让消息体不被当成查找表达式。
        // 对已修复的版本是无副作用的空操作，因此不做版本判断。
        options.push("-Dlog4j2.formatMsgNoLookups=true".into());
        // 崩溃报告与部分 mod 会读这两项；留空会让它们显示 "Unknown"。
        options.push(format!("-Dminecraft.launcher.brand={LAUNCHER_BRAND}"));
        options.push(format!("-Dminecraft.launcher.version={}", env!("CARGO_PKG_VERSION")));
        // 不写 hsperfdata：默认会在临时目录建 mmap 文件，Android 上既无用又可能失败。
        options.push("-XX:-UsePerfData".into());
    }
    if let Some(extra) = spec["jvm"].as_array() {
        for value in extra.iter().filter_map(Value::as_str) {
            // 类路径与堆上限由本模块决定，重复项一律丢弃，避免两套值互相覆盖。
            // 原生库路径同理：清单里写的是桌面路径，留在后面会把上面算好的值盖掉。
            let skip = ["-cp", "-classpath", "--class-path"].contains(&value)
                || value.starts_with("-Xmx")
                || value.starts_with("-Djava.class.path=")
                || value.starts_with("-Djava.home=")
                || value.starts_with("-Djava.library.path=")
                || value.starts_with("-Dorg.lwjgl.librarypath=");
            if !skip {
                options.push(value.to_string());
            }
        }
    }

    let library = if custom {
        Some(home.join("lib").join("server").join("libjvm.so"))
    } else {
        None
    };
    let mut guard = slot().lock().map_err(|_| "JVM 状态不可用")?;
    if guard.is_none() {
        *guard = Some(create(&options, library.as_deref())?);
        if let Ok(mut active) = active_home().lock() {
            *active = Some((major, home.clone()));
        }
    }
    let runtime = guard.as_ref().expect("just created");
    let mut env = runtime
        .vm
        .attach_current_thread()
        .map_err(|_| "无法连接 Android JVM 线程".to_string())?;

    // 3. 定位引导类：附加线程上的 FindClass 只会看到引导加载器，必须显式走系统加载器。
    let name = env
        .new_string("hcmcl.Boot")
        .map_err(|_| java_error(&mut env))?;
    let system = env
        .call_static_method("java/lang/ClassLoader", "getSystemClassLoader", "()Ljava/lang/ClassLoader;", &[])
        .and_then(|value| value.l())
        .map_err(|_| java_error(&mut env))?;
    let class = env
        .call_method(&system, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", &[JValue::Object(&name)])
        .and_then(|value| value.l())
        .map_err(|_| java_error(&mut env))?;
    let class = jni::objects::JClass::from(class);

    // 4. 组装游戏参数并交给 Boot.launch。
    let args = spec["args"].as_array().cloned().unwrap_or_default();
    let array = env
        .new_object_array(args.len() as i32, "java/lang/String", JObject::null())
        .map_err(|_| java_error(&mut env))?;
    for (index, value) in args.iter().enumerate() {
        let text = env
            .new_string(value.as_str().unwrap_or_default())
            .map_err(|_| java_error(&mut env))?;
        env.set_object_array_element(&array, index as i32, &text)
            .map_err(|_| java_error(&mut env))?;
    }
    let cp = env.new_string(&classpath).map_err(|_| java_error(&mut env))?;
    let entry = env.new_string(&main).map_err(|_| java_error(&mut env))?;
    let log_path = env.new_string(&log).map_err(|_| java_error(&mut env))?;

    // 画面尺寸可能在 JVM 起来之前就上报过了，这里补一次：光标包裹与滚动换算都依赖它。
    if let Some((width, height)) = crate::android_host::screen_size() {
        let _ = env.call_static_method(
            &class,
            "screen",
            "(II)V",
            &[JValue::Int(width), JValue::Int(height)],
        );
    }

    env.call_static_method(
        &class,
        "launch",
        "(Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)V",
        &[
            JValue::Object(&cp),
            JValue::Object(&entry),
            JValue::Object(&array),
            JValue::Object(&log_path),
        ],
    )
    .map_err(|_| java_error(&mut env))?;
    Ok(())
}

/// 定位引导类。附加线程上的 `FindClass` 只看得到引导加载器，只能显式走系统加载器。
fn boot_class<'local>(env: &mut jni::JNIEnv<'local>) -> Result<jni::objects::JClass<'local>, String> {
    let name = env.new_string("hcmcl.Boot").map_err(|_| java_error(env))?;
    let system = env
        .call_static_method(
            "java/lang/ClassLoader",
            "getSystemClassLoader",
            "()Ljava/lang/ClassLoader;",
            &[],
        )
        .and_then(|value| value.l())
        .map_err(|_| java_error(env))?;
    let class = env
        .call_method(
            &system,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::Object(&name)],
        )
        .and_then(|value| value.l())
        .map_err(|_| java_error(env))?;
    Ok(jni::objects::JClass::from(class))
}

/// 在游戏 JVM 上调用 `hcmcl.Boot` 的静态输入入口。
///
/// 触控事件来自 Android 的 UI 线程（属于 ART），必须先把这条线程附着到游戏 JVM；
/// 附着是幂等的，重复调用只有一次线程局部查表开销。
pub(crate) fn input(method: &str, signature: &str, args: &[JValue<'_, '_>]) -> Result<(), String> {
    let raw = VM_HANDLE.load(Ordering::Acquire);
    if raw.is_null() {
        return Err("Android JVM 尚未创建，无法投递输入".into());
    }
    let vm = unsafe { JavaVM::from_raw(raw) }.map_err(|_| "JVM 句柄无效".to_string())?;
    let mut env = vm
        .attach_current_thread_permanently()
        .map_err(|_| "无法把输入线程附着到游戏 JVM".to_string())?;
    let class = boot_class(&mut env)?;
    env.call_static_method(class, method, signature, args)
        .map_err(|_| java_error(&mut env))?;
    Ok(())
}

type FnKey = unsafe extern "system" fn(*mut jni::sys::JNIEnv, jni::sys::jclass, jint, jint, jint, jint);
type FnChar = unsafe extern "system" fn(*mut jni::sys::JNIEnv, jni::sys::jclass, jni::sys::jchar);
type FnCharMods =
    unsafe extern "system" fn(*mut jni::sys::JNIEnv, jni::sys::jclass, jni::sys::jchar, jint);
type FnCursor = unsafe extern "system" fn(
    *mut jni::sys::JNIEnv,
    jni::sys::jclass,
    jni::sys::jfloat,
    jni::sys::jfloat,
);
type FnMouse = unsafe extern "system" fn(*mut jni::sys::JNIEnv, jni::sys::jclass, jint, jint, jint);
type FnScroll = unsafe extern "system" fn(
    *mut jni::sys::JNIEnv,
    jni::sys::jclass,
    jni::sys::jdouble,
    jni::sys::jdouble,
);
type FnSize = unsafe extern "system" fn(*mut jni::sys::JNIEnv, jni::sys::jclass, jint, jint);

fn symbol(handle: *mut c_void, name: &str) -> Result<*mut c_void, String> {
    let text = CString::new(name).map_err(|_| "符号名包含空字符".to_string())?;
    let found = unsafe { libc::dlsym(handle, text.as_ptr()) };
    if found.is_null() {
        Err(format!("图形层缺少 {name}"))
    } else {
        Ok(found)
    }
}

/// 把 `libpojavexec` 的事件发送入口登记到 `org.lwjgl.glfw.CallbackBridge`。
///
/// 图形层自己也会在 `JNI_OnLoad` 里尝试登记一次，但那是按名字查找的：
/// 只要类上的声明与它预期的签名有出入就会整体失败。这里主动登记一次，
/// 用的是 `noncritical_*` 这一组普通 JNI 入口，签名由本工程完全掌握。
pub(crate) fn register_input(env: &mut jni::JNIEnv<'_>) -> Result<(), String> {
    let native = config()?.0.to_path_buf();
    let path = native.join("libpojavexec.so");
    // 优先拿「已经加载过的那一份」：Java 侧的 `System.loadLibrary("pojavexec")` 早已把它映射进来，
    // 再按绝对路径 dlopen 一次可能得到**另一个实例**——那样事件会进入一条没人抽的队列。
    // RTLD_NOLOAD 只查已有映射，不会新建。
    let handle = {
        let name = CString::new("libpojavexec.so").expect("literal");
        let existing = unsafe {
            libc::dlopen(name.as_ptr(), libc::RTLD_NOW | libc::RTLD_NOLOAD)
        };
        if !existing.is_null() {
            existing
        } else {
            let text = CString::new(path.to_string_lossy().as_ref())
                .map_err(|_| "库路径包含空字符")?;
            unsafe { libc::dlopen(text.as_ptr(), libc::RTLD_NOW | libc::RTLD_GLOBAL) }
        }
    };
    if handle.is_null() {
        return Err("无法加载 libpojavexec.so".into());
    }

    let send_key: FnKey = unsafe { std::mem::transmute(symbol(handle, "noncritical_send_key")?) };
    let send_char: FnChar = unsafe { std::mem::transmute(symbol(handle, "noncritical_send_char")?) };
    let send_char_mods: FnCharMods =
        unsafe { std::mem::transmute(symbol(handle, "noncritical_send_char_mods")?) };
    let send_cursor: FnCursor =
        unsafe { std::mem::transmute(symbol(handle, "noncritical_send_cursor_pos")?) };
    let send_button: FnMouse =
        unsafe { std::mem::transmute(symbol(handle, "noncritical_send_mouse_button")?) };
    let send_scroll: FnScroll =
        unsafe { std::mem::transmute(symbol(handle, "noncritical_send_scroll")?) };
    let send_size: FnSize =
        unsafe { std::mem::transmute(symbol(handle, "noncritical_send_screen_size")?) };

    let names = [
        "nativeSendKey",
        "nativeSendChar",
        "nativeSendCharMods",
        "nativeSendCursorPos",
        "nativeSendMouseButton",
        "nativeSendScroll",
        "nativeSendScreenSize",
    ];
    let signatures = ["(IIII)V", "(C)V", "(CI)V", "(FF)V", "(III)V", "(DD)V", "(II)V"];
    let pointers: [*mut c_void; 7] = [
        send_key as *mut c_void,
        send_char as *mut c_void,
        send_char_mods as *mut c_void,
        send_cursor as *mut c_void,
        send_button as *mut c_void,
        send_scroll as *mut c_void,
        send_size as *mut c_void,
    ];
    let methods: Vec<jni::NativeMethod> = (0..7)
        .map(|index| jni::NativeMethod {
            name: jni::strings::JNIString::from(names[index]),
            sig: jni::strings::JNIString::from(signatures[index]),
            fn_ptr: pointers[index],
        })
        .collect();
    let name = env
        .new_string("org.lwjgl.glfw.CallbackBridge")
        .map_err(|_| java_error(env))?;
    let system = env
        .call_static_method(
            "java/lang/ClassLoader",
            "getSystemClassLoader",
            "()Ljava/lang/ClassLoader;",
            &[],
        )
        .and_then(|value| value.l())
        .map_err(|_| java_error(env))?;
    let class = env
        .call_method(
            &system,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::Object(&name)],
        )
        .and_then(|value| value.l())
        .map_err(|_| java_error(env))?;
    let class = jni::objects::JClass::from(class);
    env.register_native_methods(&class, &methods)
        .map_err(|error| format!("登记输入入口失败：{error}"))?;
    Ok(())
}

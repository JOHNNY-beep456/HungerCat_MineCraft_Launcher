//! Android 内部安全存储桥，不发布 JavaScript command 或权限。
//!
//! 接线：Builder.plugin(mobile_security::init()) 必须早于 Storage 初始化；Android 的
//! Storage::from_app 及后续 secure_* 必须在事件循环已运行后的 spawn_blocking 中调用。
//! setup 线程或 Android UI 线程调用会直接失败，不能在主线程同步等待 mobile plugin。
//! Kotlin 类位于应用 sourceSet，注册参数使用包名和短类名，无需另加插件 AAR。

use serde_json::{json, Value};
use uuid::Uuid;

const MAX_SECRET_BYTES: usize = 32768;
const UNAVAILABLE: &str = "Android 安全存储不可用，未读取或保存秘密";
type Result<T> = std::result::Result<T, String>;

fn validate_reference(reference: &str) -> Result<()> {
    if Uuid::parse_str(reference).map(|id| id.to_string() == reference).unwrap_or(false) {
        Ok(())
    } else {
        Err("安全存储引用格式无效".into())
    }
}
fn validate_secret(secret: &str) -> Result<()> {
    if secret.len() > MAX_SECRET_BYTES || secret.chars().any(|c| c.is_control() && !matches!(c, '\r' | '\n' | '\t')) {
        Err("凭据格式无效或过长".into())
    } else {
        Ok(())
    }
}
fn read_ack(value: Value) -> Result<()> {
    let object = value.as_object().ok_or(UNAVAILABLE)?;
    if object.len() != 1 || object.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(UNAVAILABLE.into());
    }
    Ok(())
}
fn read_secret(value: Value) -> Result<String> {
    let object = value.as_object().ok_or(UNAVAILABLE)?;
    if object.len() != 1 { return Err(UNAVAILABLE.into()); }
    let secret = object.get("secret").and_then(Value::as_str).ok_or(UNAVAILABLE)?;
    validate_secret(secret).map_err(|_| UNAVAILABLE.to_string())?;
    Ok(secret.into())
}

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use std::sync::{Arc, Mutex, OnceLock};
    use std::thread::ThreadId;

    type Invoke = dyn Fn(&str, Value) -> Result<Value> + Send + Sync;
    struct Bridge { setup_thread: ThreadId, invoke: Box<Invoke> }
    static BRIDGE: OnceLock<Mutex<Option<Arc<Bridge>>>> = OnceLock::new();

    fn slot() -> &'static Mutex<Option<Arc<Bridge>>> { BRIDGE.get_or_init(|| Mutex::new(None)) }

    fn is_ui_thread() -> bool {
        // Android/bionic API 21+ 提供 gettid；应用 UI Looper 运行在进程主线程。
        // 不依赖 Rust 线程名称，也不为检测线程而再调度一次需要 UI 响应的 JNI 调用。
        extern "C" { fn getpid() -> i32; fn gettid() -> i32; }
        unsafe { getpid() == gettid() }
    }
    pub(super) fn invoke(command: &str, payload: Value) -> Result<Value> {
        if is_ui_thread() { return Err("安全存储必须在后台线程调用".into()); }
        let bridge = slot().lock().map_err(|_| UNAVAILABLE)?.clone().ok_or(UNAVAILABLE)?;
        if std::thread::current().id() == bridge.setup_thread {
            return Err("安全存储不能在插件初始化线程同步调用".into());
        }
        (bridge.invoke)(command, payload)
    }
    pub(super) fn install<R: tauri::Runtime>(api: tauri::plugin::PluginApi<R, ()>) -> std::result::Result<(), Box<dyn std::error::Error>> {
        // Tauri 2.12.5 内部拼接 package.replace('.', '/') + '/' + class_name。
        let handle = api.register_android_plugin("top.johnnyblog.hcmcl.security", "HcmclSecretStore")?;
        let bridge = Bridge {
            setup_thread: std::thread::current().id(),
            invoke: Box::new(move |command, payload| {
                // 这里只会在后台线程执行；原始 PluginInvokeError 不返回日志或调用方。
                handle.run_mobile_plugin::<Value>(command, payload).map_err(|_| UNAVAILABLE.into())
            }),
        };
        let mut current = slot().lock().map_err(|_| std::io::Error::other(UNAVAILABLE))?;
        if current.is_some() { return Err(std::io::Error::other("安全存储插件重复初始化").into()); }
        *current = Some(Arc::new(bridge));
        Ok(())
    }
    pub(super) fn clear() {
        if let Ok(mut current) = slot().lock() { *current = None; }
    }
}

fn invoke(command: &str, payload: Value) -> Result<Value> {
    #[cfg(target_os = "android")]
    { android::invoke(command, payload) }
    #[cfg(not(target_os = "android"))]
    { let _ = (command, payload); Err(UNAVAILABLE.into()) }
}

/// 注册 Rust 内部 mobile handle；显式终止所有 WebView invoke，阻断 Kotlin 默认回退。
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::<R>::new("hcmcl-secret-store")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            android::install(_api)?;
            Ok(())
        })
        .invoke_handler(|invoke| {
            invoke.resolver.reject("此安全存储仅供 Rust 内部调用");
            true
        })
        .on_drop(|_app| {
            #[cfg(target_os = "android")]
            android::clear();
        })
        .build()
}

/// 新引用保存：不覆盖其它值；Kotlin 在加密后自行解密比对，再原子提交密文。
pub fn secure_set(reference: &str, secret: &str) -> Result<()> {
    validate_reference(reference)?;
    validate_secret(secret)?;
    read_ack(invoke("set", json!({"reference":reference,"secret":secret}))?)
}
/// 必须存在且 GCM 身份校验通过；缺失或损坏不会回退空值或明文。
pub fn secure_get(reference: &str) -> Result<String> {
    validate_reference(reference)?;
    read_secret(invoke("get", json!({"reference":reference}))?)
}
/// 幂等删除该引用的密文，不删除共用 Keystore 密钥或其它引用。
pub fn secure_delete(reference: &str) -> Result<()> {
    validate_reference(reference)?;
    read_ack(invoke("delete", json!({"reference":reference}))?)
}

#[cfg(test)]
mod tests {
    use super::*;
    const REFERENCE: &str = "01234567-89ab-cdef-0123-456789abcdef";

    #[test]
    fn references_require_canonical_uuid_and_reject_paths() {
        assert!(validate_reference(REFERENCE).is_ok());
        for value in ["", "../secret", "0123456789abcdef0123456789abcdef", "01234567-89AB-CDEF-0123-456789ABCDEF", "{01234567-89ab-cdef-0123-456789abcdef}"] {
            assert!(validate_reference(value).is_err());
        }
    }
    #[test]
    fn secret_size_is_utf8_bytes_and_unsafe_controls_are_rejected() {
        assert!(validate_secret("").is_ok());
        assert!(validate_secret(&"x".repeat(MAX_SECRET_BYTES)).is_ok());
        assert!(validate_secret(&"x".repeat(MAX_SECRET_BYTES + 1)).is_err());
        assert!(validate_secret(&"😀".repeat(MAX_SECRET_BYTES / 4)).is_ok());
        assert!(validate_secret(&"😀".repeat(MAX_SECRET_BYTES / 4 + 1)).is_err());
        // aiHeaders 允许格式化 JSON；CR/LF/TAB 是加密数据，不是 HTTP 头或日志。
        assert!(validate_secret("{\n\t\"Authorization\": \"FAKE_PRIVATE\"\r\n}").is_ok());
        for value in ["a\0b", "a\u{0008}b", "a\u{0085}b"] { assert!(validate_secret(value).is_err()); }
    }
    #[test]
    fn native_responses_are_strict_and_errors_do_not_echo_payload() {
        assert!(read_ack(json!({"ok":true})).is_ok());
        for value in [json!(null), json!({"ok":false}), json!({"ok":true,"secret":"FAKE_PRIVATE"})] {
            assert!(!read_ack(value).unwrap_err().contains("FAKE_PRIVATE"));
        }
        assert_eq!(read_secret(json!({"secret":"FAKE_PRIVATE"})).unwrap(), "FAKE_PRIVATE");
        for value in [json!({"secret":null}), json!({"secret":"x\u{0008}y"}), json!({"secret":"FAKE_PRIVATE","extra":true})] {
            assert!(!read_secret(value).unwrap_err().contains("FAKE_PRIVATE"));
        }
    }
    #[cfg(not(target_os = "android"))]
    #[test]
    fn unconfigured_platform_fails_closed_without_creating_files() {
        assert!(secure_set(REFERENCE,"FAKE_PRIVATE").is_err());
        assert!(secure_get(REFERENCE).is_err());
        assert!(secure_delete(REFERENCE).is_err());
    }
}

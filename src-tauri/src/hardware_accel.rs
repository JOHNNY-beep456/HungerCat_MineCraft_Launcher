//! Windows WebView2 的进程启动策略；不是 GPU 使用率或驱动能力探测。
//!
//! 第一个插件初始化时冻结设置，早于 Tauri 创建配置窗口；之后所有 WebView
//! 都使用相同的进程附加参数。仅投影一个布尔设置，不初始化 Storage 或密钥库。

#[cfg(any(windows, test))]
use std::{ffi::{OsStr, OsString}, io::Read};
#[cfg(windows)]
use std::{path::Path, sync::Mutex};
#[cfg(windows)]
use tauri::Manager;

#[cfg(any(windows, test))]
const MAX_STATE_BYTES: u64 = 8 * 1024 * 1024;
#[cfg(windows)]
const BROWSER_ARGUMENTS: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";

type Result<T> = std::result::Result<T, String>;

#[cfg(any(windows, test))]
#[derive(serde::Deserialize)]
struct Snapshot {
    schema: u32,
    settings: HardwareSettings,
}

#[cfg(any(windows, test))]
#[derive(serde::Deserialize)]
struct HardwareSettings {
    #[serde(default, rename = "hardwareAcceleration")]
    enabled: bool,
}

#[cfg(any(windows, test))]
fn decode_requested(reader: impl Read, maximum: u64) -> Result<bool> {
    use serde::Deserialize;
    // 未声明的字段由 serde 忽略；账号、凭据引用和其它设置不形成内存快照。
    // 与 storage::read_state 一致容忍单个前导 UTF-8 BOM：外部工具/脚本可能写入 BOM，
    // 严格拒绝会把「已开启硬件加速」误判为投影无效而保守关闭。
    let mut limited = reader.take(maximum.saturating_add(1));
    let mut bytes = Vec::new();
    limited.read_to_end(&mut bytes).map_err(|_| "无法读取启动设置".to_string())?;
    if bytes.len() as u64 > maximum { return Err("启动设置体积超限".into()); }
    let bytes = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { &bytes[3..] } else { &bytes[..] };
    let mut json = serde_json::Deserializer::from_slice(bytes);
    let snapshot = Snapshot::deserialize(&mut json).map_err(|_| "启动设置投影无效".to_string())?;
    json.end().map_err(|_| "启动设置投影无效".to_string())?;
    if snapshot.schema != 1 { return Err("不支持的启动设置版本".into()); }
    Ok(snapshot.settings.enabled)
}

#[cfg(windows)]
fn read_requested(root: &Path) -> Result<bool> {
    use std::{fs::{self, OpenOptions}, io::ErrorKind, os::windows::fs::{MetadataExt, OpenOptionsExt}};
    const REPARSE_POINT: u32 = 0x400;
    const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    let path = root.join("storage-state.json");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("无法读取启动设置属性".into()),
    };
    if !metadata.is_file() || metadata.file_attributes() & REPARSE_POINT != 0 || metadata.len() > MAX_STATE_BYTES {
        return Err("启动设置不是有界普通文件".into());
    }
    let file = OpenOptions::new().read(true).custom_flags(OPEN_REPARSE_POINT).open(path)
        .map_err(|_| "无法打开启动设置".to_string())?;
    let opened = file.metadata().map_err(|_| "无法核验启动设置".to_string())?;
    if !opened.is_file() || opened.file_attributes() & REPARSE_POINT != 0 || opened.len() > MAX_STATE_BYTES {
        return Err("启动设置不是有界普通文件".into());
    }
    decode_requested(file, MAX_STATE_BYTES)
}

#[cfg(any(windows, test))]
fn browser_arguments(original: Option<&OsStr>, enabled: bool) -> Option<OsString> {
    if enabled { return original.map(OsStr::to_os_string); }
    let mut arguments = original.unwrap_or_else(|| OsStr::new("")).to_os_string();
    if !arguments.is_empty() { arguments.push(" "); }
    arguments.push("--disable-gpu");
    Some(arguments)
}

#[cfg(windows)]
fn set_browser_arguments(value: Option<&OsStr>) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn SetEnvironmentVariableW(name: *const u16, value: *const u16) -> i32;
    }
    let name: Vec<u16> = OsStr::new(BROWSER_ARGUMENTS).encode_wide().chain(Some(0)).collect();
    let value = value.map(|value| value.encode_wide().chain(Some(0)).collect::<Vec<_>>());
    if value.as_ref().map(|value| value.len() > 32_767).unwrap_or(false) {
        return Err("WebView2 启动参数体积超限 / WebView2 啟動參數體積超限 / WebView2 startup arguments are too large".into());
    }
    // Windows 的进程环境 API 本身支持跨线程；不更改用户/系统环境或注册表。
    let pointer = value.as_ref().map_or(std::ptr::null(), |value| value.as_ptr());
    if unsafe { SetEnvironmentVariableW(name.as_ptr(), pointer) } == 0 {
        return Err("无法应用 WebView2 启动策略 / 無法套用 WebView2 啟動策略 / Cannot apply the WebView2 startup policy".into());
    }
    Ok(())
}

#[cfg(windows)]
struct EnvironmentChange {
    original: Option<OsString>,
    applied: OsString,
}

#[cfg(windows)]
struct BootPolicy {
    requested: bool,
    environment: Mutex<Option<EnvironmentChange>>,
}

#[cfg(windows)]
impl BootPolicy {
    fn apply(requested: bool) -> Result<Self> {
        let original = std::env::var_os(BROWSER_ARGUMENTS);
        let applied = browser_arguments(original.as_deref(), requested);
        let environment = if applied == original {
            None
        } else {
            set_browser_arguments(applied.as_deref())?;
            Some(EnvironmentChange { original, applied: applied.expect("关闭策略总有附加参数") })
        };
        Ok(Self { requested, environment: Mutex::new(environment) })
    }

    fn restore(&self) -> Result<()> {
        let mut environment = self.environment.lock().unwrap_or_else(|error| error.into_inner());
        let Some(change) = environment.as_ref() else { return Ok(()); };
        // Tauri restart 会继承父进程环境；退出时还原，避免下次开启后仍继承本次禁用参数。
        // 不覆盖其它原生组件在此期间主动更换的参数。
        if std::env::var_os(BROWSER_ARGUMENTS).as_ref() == Some(&change.applied) {
            set_browser_arguments(change.original.as_deref())?;
        }
        *environment = None;
        Ok(())
    }
}

pub(crate) fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("hardware-acceleration")
        .setup(|_app, _api| {
            #[cfg(windows)]
            {
                // 使用官方路径解析器，包含 appDirectoriesOverride；不猜测 APPDATA 或可执行目录。
                let requested = _app.path().app_data_dir().map_err(|_| "无法取得启动设置目录".to_string())
                    .and_then(|root| read_requested(&root)).unwrap_or_else(|_| {
                        // 与首次启动相同，读取失败也使用保守关闭策略；正式 Storage 仍单独报告其错误。
                        eprintln!("[hardware-acceleration] 启动设置投影不可用，本次关闭硬件加速");
                        false
                    });
                let policy = BootPolicy::apply(requested).map_err(std::io::Error::other)?;
                if !_app.manage(policy) {
                    return Err(std::io::Error::other("硬件加速启动策略重复初始化").into());
                }
            }
            Ok(())
        })
        .on_event(|_app, _event| {
            #[cfg(windows)]
            if matches!(_event, tauri::RunEvent::Exit) {
                if let Some(policy) = _app.try_state::<BootPolicy>() {
                    if policy.restore().is_err() {
                        eprintln!("[hardware-acceleration] 未能还原进程附加参数");
                    }
                }
            }
        })
        .build()
}

pub(crate) fn booted(_app: &tauri::AppHandle, args: &[serde_json::Value]) -> Result<serde_json::Value> {
    if !args.is_empty() {
        return Err("启动策略查询不接受参数 / 啟動策略查詢不接受參數 / Startup policy query takes no arguments".into());
    }
    #[cfg(windows)]
    {
        let policy = _app.try_state::<BootPolicy>().ok_or("硬件加速启动策略尚未初始化 / 硬體加速啟動策略尚未初始化 / Hardware-acceleration startup policy is not initialized")?;
        // 与 Electron 接口一致：返回本次启动冻结的设置，而不是 settings:set 的当前值或 GPU 遥测。
        Ok(serde_json::json!(policy.requested))
    }
    #[cfg(not(windows))]
    Err("此平台尚未接入硬件加速启动策略 / 此平台尚未接入硬體加速啟動策略 / Hardware-acceleration startup policy is not available on this platform".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_projection_uses_only_the_boolean_and_ignores_other_sections() {
        assert!(decode_requested(&br#"{"schema":1,"settings":{"hardwareAcceleration":true},"accounts":[{"id":"isolated-fixture"}],"secrets":{}}"#[..], MAX_STATE_BYTES).unwrap());
        assert!(!decode_requested(&br#"{"schema":1,"settings":{}}"#[..], MAX_STATE_BYTES).unwrap());
        assert!(!decode_requested(&br#"{"schema":1,"settings":{"hardwareAcceleration":false}}"#[..], MAX_STATE_BYTES).unwrap());
        // 带 UTF-8 BOM 的快照同样可读，避免「已开启」被误判为投影无效而保守关闭。
        assert!(decode_requested(&b"\xEF\xBB\xBF{\"schema\":1,\"settings\":{\"hardwareAcceleration\":true}}"[..], MAX_STATE_BYTES).unwrap());
        assert!(decode_requested(&b"\xEF\xBB\xBF{bad json"[..], MAX_STATE_BYTES).is_err());
    }

    #[test]
    fn startup_projection_rejects_wrong_types_versions_and_trailing_input() {
        for bytes in [
            &br#"{"schema":2,"settings":{"hardwareAcceleration":true}}"#[..],
            &br#"{"schema":1,"settings":{"hardwareAcceleration":"true"}}"#[..],
            &br#"{"schema":1,"settings":{"hardwareAcceleration":null}}"#[..],
            &br#"{"schema":1,"settings":{}} {}"#[..],
        ] {
            assert!(decode_requested(bytes, MAX_STATE_BYTES).is_err());
        }
    }

    #[test]
    fn startup_projection_checks_stream_limit_including_trailing_whitespace() {
        let bytes = br#"{"schema":1,"settings":{}}"#;
        assert!(!decode_requested(&bytes[..], bytes.len() as u64).unwrap());
        let mut oversized = bytes.to_vec();
        oversized.push(b' ');
        assert!(decode_requested(&oversized[..], bytes.len() as u64).is_err());
    }

    #[test]
    fn browser_arguments_preserve_existing_flags_and_only_append_the_disabled_policy() {
        let existing = OsStr::new("--example-fixture=\"含空格 路径\"");
        assert_eq!(browser_arguments(Some(existing), true), Some(existing.to_os_string()));
        assert_eq!(browser_arguments(None, true), None);
        assert_eq!(browser_arguments(Some(existing), false), Some(OsString::from("--example-fixture=\"含空格 路径\" --disable-gpu")));
        assert_eq!(browser_arguments(None, false), Some(OsString::from("--disable-gpu")));
    }
}

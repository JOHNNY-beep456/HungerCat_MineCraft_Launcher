//! 有界的账户来源文件读取。
//! 这里只消费系统文件选择器授予的路径，不扫描磁盘、不执行外部程序、不联网。

use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};
use tauri::{AppHandle, Runtime, WebviewWindow};

use crate::downloads::Cancel;

const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_FILES: usize = 8;
const MAX_TOTAL_BYTES: u64 = 32 * 1024 * 1024;

fn denied() -> String { "无法安全读取账户文件，请重新使用系统文件选择器选择".into() }
fn invalid_source() -> String { "不支持的账户导入来源".into() }
fn filters(source: &str) -> Value {
    match source {
        "pcl2" => json!([{"name":"PCL 账户文件","extensions":["reg","json"]}]),
        "hmcl" | "official" => json!([{"name":"JSON 账户文件","extensions":["json"]}]),
        _ => Value::Array(Vec::new()),
    }
}

async fn pick_paths<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    source: &str,
    multiple: bool,
    cancel: &Arc<Cancel>,
) -> Result<Option<Vec<PathBuf>>, String> {
    let args = vec![filters(source)];
    let future = async {
        #[cfg(target_os = "android")]
        {
            crate::mobile_files::call(app, window, if multiple { "shell:pickFiles" } else { "shell:pickFile" }, &args)
                .await
                .map(|value| value.map(|value| values_to_paths(value, multiple)))
        }
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            crate::desktop::call(app, window, if multiple { "shell:pickFiles" } else { "shell:pickFile" }, &args)
                .await
                .map(|value| value.map(|value| values_to_paths(value, multiple)))
        }
        #[cfg(target_os = "ios")]
        {
            let _ = (app, window, args);
            Err(denied())
        }
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Ok(None),
        result = future => {
            let paths = result.map_err(|_| denied())?.transpose()?;
            Ok(paths)
        }
    }
}

fn values_to_paths(value: Value, multiple: bool) -> Result<Vec<PathBuf>, String> {
    if value.is_null() { return Ok(Vec::new()); }
    if multiple {
        let values = value.as_array().filter(|values| values.len() <= MAX_FILES).ok_or_else(denied)?;
        values.iter().map(path_value).collect()
    } else {
        Ok(vec![path_value(&value)?])
    }
}

fn path_value(value: &Value) -> Result<PathBuf, String> {
    value.as_str().filter(|path| !path.is_empty() && path.len() <= 32768 && !path.chars().any(char::is_control))
        .map(PathBuf::from).ok_or_else(denied)
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp { size: u64, modified: Option<SystemTime>, identity: (u64, u64), links: u64 }

#[cfg(windows)]
fn identity(file: &File, _: &fs::Metadata) -> Result<((u64, u64), u64), String> {
    use std::{ffi::c_void, os::windows::io::AsRawHandle};
    #[repr(C)] struct Info { attributes:u32, created:[u32;2], accessed:[u32;2], modified:[u32;2], volume:u32, high:u32, low:u32, links:u32, index_high:u32, index_low:u32 }
    #[link(name="kernel32")]
    extern "system" { fn GetFileInformationByHandle(h:*mut c_void, i:*mut Info)->i32; }
    let mut info: Info = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 || info.links != 1 { return Err(denied()); }
    Ok(((info.volume as u64, ((info.index_high as u64)<<32) | info.index_low as u64), info.links as u64))
}
#[cfg(unix)]
fn identity(_: &File, meta: &fs::Metadata) -> Result<((u64, u64), u64), String> {
    use std::os::unix::fs::MetadataExt;
    let links = meta.nlink();
    if links != 1 { return Err(denied()); }
    Ok(((meta.dev(), meta.ino()), links))
}
#[cfg(not(any(windows, unix)))]
fn identity(_: &File, _: &fs::Metadata) -> Result<((u64, u64), u64), String> { Err(denied()) }

fn open_nofollow(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x00000001;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x00200000;
        options.share_mode(FILE_SHARE_READ).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0o400000 | 0x800);
    }
    #[cfg(target_os = "android")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(any(target_arch = "arm", target_arch = "aarch64"))] const nofollow: i32 = 0x8000;
        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))] const nofollow: i32 = 0x20000;
        #[cfg(target_arch = "riscv64")] const nofollow: i32 = 0x20000;
        options.custom_flags(nofollow | 0x800);
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x100 | 0x4);
    }
    options.open(path).map_err(|_| denied())
}

fn is_reparse(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() { return true; }
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        return meta.file_attributes() & 0x400 != 0;
    }
    false
}

fn reject_link_ancestors(path: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if matches!(component, std::path::Component::Prefix(_)) { continue; }
        match fs::symlink_metadata(&current) {
            Ok(meta) if is_reparse(&meta) => return Err(denied()),
            Ok(_) => {},
            Err(_) => return Err(denied()),
        }
    }
    Ok(())
}

fn stamp(file: &File) -> Result<Stamp, String> {
    let meta = file.metadata().map_err(|_| denied())?;
    if !meta.is_file() || is_reparse(&meta) || meta.len() > MAX_FILE_BYTES { return Err(denied()); }
    let (identity, links) = identity(file, &meta)?;
    Ok(Stamp { size: meta.len(), modified: meta.modified().ok(), identity, links })
}

fn path_stamp(path: &Path) -> Result<Stamp, String> {
    reject_link_ancestors(path)?;
    let meta = fs::symlink_metadata(path).map_err(|_| denied())?;
    if !meta.is_file() || is_reparse(&meta) { return Err(denied()); }
    let file = open_nofollow(path)?;
    let opened = stamp(&file)?;
    let (current_identity, current_links) = identity(&file, &meta)?;
    if opened.identity != current_identity || opened.links != current_links || opened.size != meta.len() { return Err(denied()); }
    Ok(opened)
}

fn read_stable(path: &Path) -> Result<(String, u64), String> {
    if !path.is_absolute() || path.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::CurDir)) { return Err(denied()); }
    let canonical = fs::canonicalize(path).map_err(|_| denied())?;
    reject_link_ancestors(path)?;
    let path_meta = fs::symlink_metadata(path).map_err(|_| denied())?;
    if !path_meta.is_file() || is_reparse(&path_meta) { return Err(denied()); }
    let mut file = open_nofollow(path)?;
    let before = stamp(&file)?;
    let path_before = path_stamp(path)?;
    if before != path_before || before.size > MAX_FILE_BYTES { return Err(denied()); }
    let mut bytes = Vec::with_capacity(before.size as usize + 1);
    file.by_ref().take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes).map_err(|_| denied())?;
    if bytes.len() as u64 > MAX_FILE_BYTES || bytes.len() as u64 != before.size { return Err(denied()); }
    let after = stamp(&file)?;
    let path_after = path_stamp(path)?;
    if before != after || before != path_after || fs::canonicalize(path).map_err(|_| denied())? != canonical { return Err(denied()); }
    let decoded = crate::account_import::parser::decode_file(&bytes).map_err(|_| denied())?;
    Ok((decoded, before.size))
}

fn require_picked_sync<R: Runtime>(app: &AppHandle<R>, path: &Path) -> Result<(), String> {
    #[cfg(target_os = "android")]
    { crate::mobile_files::require_imported_file(app, path) }
    #[cfg(not(target_os = "android"))]
    { crate::desktop::require_picked_file(app, path) }
}

async fn read_stable_authorized<R: Runtime>(app: &AppHandle<R>, path: PathBuf, cancel: &Arc<Cancel>) -> Result<Option<(String, u64)>, String> {
    if cancel.check().is_err() { return Ok(None); }
    let handle = app.clone();
    let worker_cancel = cancel.clone();
    let task = tauri::async_runtime::spawn_blocking(move || {
        worker_cancel.check().map_err(|_| denied())?;
        require_picked_sync(&handle, &path).map_err(|_| denied())?;
        let result = read_stable(&path)?;
        require_picked_sync(&handle, &path).map_err(|_| denied())?;
        worker_cancel.check().map_err(|_| denied())?;
        Ok(result)
    });
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Ok(None),
        result = task => match result {
            Ok(Ok(value)) => Ok(Some(value)),
            Ok(Err(error)) => Err(error),
            Err(_) => Err(denied()),
        },
    }
}

fn is_json_name(path: &Path) -> bool {
    path.file_name().and_then(|v| v.to_str()).map(|v| v.to_ascii_lowercase().ends_with(".json")).unwrap_or(false)
}

fn parse_json_document(text: &str, source: &str) -> Result<Value, String> {
    let parsed: Value = serde_json::from_str(text).map_err(|_| denied())?;
    let mut value = if parsed.is_array() { json!({"accounts": parsed}) } else { parsed };
    if source == "pcl2" {
        if let Some(object) = value.as_object_mut() { object.insert("_pclPlaintext".into(), Value::Bool(true)); }
    }
    Ok(value)
}

fn parse_selected(path: &Path, text: &str, source: &str) -> Result<Vec<Value>, String> {
    if source == "pcl2" && path.file_name().and_then(|name| name.to_str()).map(|name| name.to_ascii_lowercase().ends_with(".reg")).unwrap_or(false) {
        crate::account_import::parser::parse_registry(text).map_err(|_| denied())
    } else {
        Ok(vec![parse_json_document(text, source)?])
    }
}

fn has_hmcl_metadata(value: &Value) -> bool {
    value.get("accounts").and_then(Value::as_array).map(|items| items.iter().any(|item| item.get("accountID").is_some())).unwrap_or(false)
}
fn has_hmcl_private(value: &Value) -> bool { value.get("protection").is_some() }

async fn read_selected<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    source: &str,
    cancel: &Arc<Cancel>,
) -> Result<Option<Vec<Value>>, String> {
    let first = match pick_paths(app, window, source, source == "hmcl", cancel).await? {
        None => return Ok(None),
        Some(paths) if paths.is_empty() => return Ok(None),
        Some(paths) => paths,
    };
    if first.len() > MAX_FILES { return Err(denied()); }
    if source != "pcl2" && first.iter().any(|p| !is_json_name(p)) { return Err(denied()); }
    let mut total = 0u64;
    let mut documents = Vec::with_capacity(first.len() + 1);
    let mut selected_files = first.len();
    let mut metadata = false;
    let mut private = false;
    for path in first {
        let Some((text, bytes)) = read_stable_authorized(app, path.clone(), cancel).await? else { return Ok(None); };
        total = total.checked_add(bytes).filter(|n| *n <= MAX_TOTAL_BYTES).ok_or_else(denied)?;
        for value in parse_selected(&path, &text, source)? {
            metadata |= has_hmcl_metadata(&value);
            private |= has_hmcl_private(&value);
            documents.push(value);
        }
    }
    if source == "hmcl" && metadata != private && selected_files < MAX_FILES {
        // 配套文件可以取消；取消只保留首轮已授权文档，让 parser 给出 protected warning。
        if let Some(companion) = pick_paths(app, window, "hmcl", false, cancel).await? {
            if let Some(path) = companion.into_iter().next() {
                if !is_json_name(&path) { return Err(denied()); }
                selected_files = selected_files.saturating_add(1);
                if selected_files > MAX_FILES { return Err(denied()); }
                let Some((text, bytes)) = read_stable_authorized(app, path.clone(), cancel).await? else { return Ok(None); };
                total = total.checked_add(bytes).filter(|n| *n <= MAX_TOTAL_BYTES).ok_or_else(denied)?;
                documents.extend(parse_selected(&path, &text, source)?);
            }
        }
    }
    if selected_files > MAX_FILES { return Err(denied()); }
    if cancel.check().is_err() { return Ok(None); }
    Ok(Some(documents))
}

#[cfg(windows)]
const REG_FIELDS: &[&str] = &[
    "Identify", "LoginLegacyName", "LoginMsJson", "CacheMsUuid", "CacheMsName", "CacheMsAccess", "CacheMsOAuthRefresh",
    "CacheMsV2Uuid", "CacheMsV2Name", "CacheMsV2Access", "CacheMsV2OAuthRefresh", "CacheMsV2Expires", "CacheAuthUuid",
    "CacheAuthName", "CacheAuthAccess", "CacheAuthClient", "CacheAuthServerServer", "CacheAuthServerName",
];

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(std::iter::once(0)).collect() }

#[cfg(windows)]
fn registry_documents() -> Result<String, String> {
    use std::{ffi::c_void, ptr};
    type Hkey = *mut c_void;
    const HKCU: Hkey = (-2147483647i32 as isize) as Hkey;
    const KEY_QUERY_VALUE: u32 = 0x0001;
    const ERROR_SUCCESS: i32 = 0;
    const ERROR_FILE_NOT_FOUND: i32 = 2;
    const ERROR_MORE_DATA: i32 = 234;
    const REG_SZ: u32 = 1;
    const REG_EXPAND_SZ: u32 = 2;
    #[link(name="advapi32")]
    extern "system" {
        fn RegOpenKeyExW(h:Hkey, sub:*const u16, opt:u32, access:u32, out:*mut Hkey)->i32;
        fn RegCloseKey(h:Hkey)->i32;
        fn RegQueryValueExW(h:Hkey, name:*const u16, reserved:*mut u32, kind:*mut u32, data:*mut u8, size:*mut u32)->i32;
    }
    struct RegistryKey(Hkey);
    impl Drop for RegistryKey { fn drop(&mut self) { if !self.0.is_null() { unsafe { RegCloseKey(self.0); } } } }
    let mut out = String::new();
    for subkey in ["Software\\PCL", "Software\\PCL2", "Software\\PCLDebug"] {
        let mut raw: Hkey = ptr::null_mut();
        let opened = unsafe { RegOpenKeyExW(HKCU, wide(subkey).as_ptr(), 0, KEY_QUERY_VALUE, &mut raw) };
        if opened == ERROR_FILE_NOT_FOUND { continue; }
        if opened != ERROR_SUCCESS || raw.is_null() { return Err(denied()); }
        let _key = RegistryKey(raw);
        let header = format!("[HKEY_CURRENT_USER\\{}]\r\n", subkey);
        if out.len().checked_add(header.len()).filter(|n| *n <= MAX_TOTAL_BYTES as usize).is_none() { return Err(denied()); }
        out.push_str(&header);
        for name in REG_FIELDS {
            let n = wide(name); let mut kind = 0u32; let mut size = 0u32;
            let first = unsafe { RegQueryValueExW(raw, n.as_ptr(), ptr::null_mut(), &mut kind, ptr::null_mut(), &mut size) };
            if first != ERROR_SUCCESS && first != ERROR_MORE_DATA { continue; }
            if !matches!(kind, REG_SZ | REG_EXPAND_SZ) || size == 0 || size as u64 > MAX_FILE_BYTES { continue; }
            let mut bytes = vec![0u8; size as usize]; let mut actual = size;
            if unsafe { RegQueryValueExW(raw, n.as_ptr(), ptr::null_mut(), &mut kind, bytes.as_mut_ptr(), &mut actual) } != ERROR_SUCCESS
                || !matches!(kind, REG_SZ | REG_EXPAND_SZ) || actual > size || actual < 2 || actual % 2 != 0 { continue; }
            let units: Vec<u16> = bytes[..actual as usize].chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
            let value = String::from_utf16(&units).map_err(|_| denied())?.trim_end_matches('\0').to_string();
            if value.len() as u64 > MAX_FILE_BYTES || value.chars().any(char::is_control) { return Err(denied()); }
            let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
            let line = format!("\"{}\"=\"{}\"\r\n", name, escaped);
            if out.len().checked_add(line.len()).filter(|n| *n <= MAX_TOTAL_BYTES as usize).is_none() { return Err(denied()); }
            out.push_str(&line);
        }
        if out.len().checked_add(2).filter(|n| *n <= MAX_TOTAL_BYTES as usize).is_none() { return Err(denied()); }
        out.push_str("\r\n");
    }
    Ok(out)
}

#[cfg(not(windows))]
fn registry_documents() -> Result<String, String> { Err("读取本机 PCL2 注册表仅适用于 Windows".into()) }

pub(super) async fn pick_documents<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    source: &str,
    local: bool,
    cancel: Arc<Cancel>,
) -> Result<Option<Vec<Value>>, String> {
    if !matches!(source, "pcl2" | "hmcl" | "official") { return Err(invalid_source()); }
    if local {
        if source != "pcl2" { return Err(denied()); }
        if cancel.check().is_err() { return Ok(None); }
        let worker = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<Value>, String> {
            let content = registry_documents()?;
            crate::account_import::parser::parse_registry(&content).map_err(|_| denied())
        });
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Ok(None),
            result = worker => result.map_err(|_| denied())?,
        };
        if cancel.check().is_err() { return Ok(None); }
        return result.map(Some);
    }
    read_selected(app, window, source, &cancel).await
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Temporary(PathBuf);
    impl Temporary {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("hcmcl-account-files-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
        fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let path = self.0.join(name);
            fs::write(&path, bytes).unwrap();
            path
        }
    }
    impl Drop for Temporary { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[test]
    fn reads_only_synthetic_utf8_and_bom_files() {
        let temp = Temporary::new();
        let path = temp.file("account.json", br#"{"accounts":[]}"#);
        let (text, bytes) = read_stable(&path).unwrap();
        assert_eq!(text, "{\"accounts\":[]}");
        assert_eq!(bytes, 15);
        let path = temp.file("bom.json", b"\xef\xbb\xbf{\"accounts\":[]}");
        assert_eq!(read_stable(&path).unwrap().0, text);
    }

    #[test]
    fn decodes_utf16_both_byte_orders_without_reading_real_accounts() {
        let temp = Temporary::new();
        for (name, bom, little) in [("le.json", [0xff, 0xfe], true), ("be.json", [0xfe, 0xff], false)] {
            let mut bytes = bom.to_vec();
            for unit in "{\"accounts\":[]}".encode_utf16() {
                bytes.extend_from_slice(&if little { unit.to_le_bytes() } else { unit.to_be_bytes() });
            }
            assert_eq!(read_stable(&temp.file(name, &bytes)).unwrap().0, "{\"accounts\":[]}");
        }
        assert_eq!(read_stable(&temp.file("bad.json", &[0xff, 0xfe, 1])).unwrap_err(), denied());
    }

    #[test]
    fn rejects_size_limit_hardlinks_and_nonregular_paths_with_fixed_error() {
        let temp = Temporary::new();
        let path = temp.file("large.json", b"");
        File::options().write(true).open(&path).unwrap().set_len(MAX_FILE_BYTES + 1).unwrap();
        assert_eq!(read_stable(&path).unwrap_err(), denied());
        let original = temp.file("original.json", b"{}");
        let linked = temp.0.join("linked.json");
        fs::hard_link(&original, &linked).unwrap();
        assert_eq!(read_stable(&original).unwrap_err(), denied());
        assert_eq!(read_stable(&linked).unwrap_err(), denied());
        assert_eq!(read_stable(&temp.0).unwrap_err(), denied());
        assert_eq!(read_stable(Path::new("relative-account.json")).unwrap_err(), denied());
    }

    #[test]
    fn preserves_hmcl_pair_detection_and_marks_only_pcl_json_plaintext() {
        let metadata = parse_json_document("[{\"accountID\":\"FAKE_ID\"}]", "hmcl").unwrap();
        assert!(has_hmcl_metadata(&metadata));
        assert!(!has_hmcl_private(&metadata));
        assert!(has_hmcl_private(&json!({"protection":"plain","payload":[]})));
        let json_doc = parse_selected(Path::new("selected.json"), "{\"LoginLegacyName\":\"Fixture\"}", "pcl2").unwrap();
        assert_eq!(json_doc[0]["_pclPlaintext"], true);
        let reg_doc = parse_selected(Path::new("selected.reg"), "Windows Registry Editor Version 5.00\n[HKEY_CURRENT_USER\\Software\\PCL2]\n\"Identify\"=\"FAKE\"\n", "pcl2").unwrap();
        assert_eq!(reg_doc.len(), 1);
        assert!(reg_doc[0].get("_pclPlaintext").is_none());
    }

    #[test]
    fn picker_results_reject_more_than_eight_and_invalid_paths() {
        assert!(values_to_paths(json!(["a", "b", "c", "d", "e", "f", "g", "h", "i"]), true).is_err());
        assert!(values_to_paths(json!([1]), true).is_err());
        assert!(path_value(&json!("bad\npath")).is_err());
        assert!(values_to_paths(Value::Null, false).unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_and_fifo_without_blocking_or_external_programs() {
        use std::{ffi::CString, os::unix::{ffi::OsStrExt, fs::symlink}};
        extern "C" { fn mkfifo(path: *const std::os::raw::c_char, mode: u32) -> i32; }
        let temp = Temporary::new();
        let target = temp.file("real.json", b"{}");
        let link = temp.0.join("link.json");
        symlink(&target, &link).unwrap();
        assert_eq!(read_stable(&link).unwrap_err(), denied());
        let fifo = temp.0.join("pipe.json");
        let raw = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { mkfifo(raw.as_ptr(), 0o600) }, 0);
        let opened = open_nofollow(&fifo).unwrap();
        assert_eq!(stamp(&opened).unwrap_err(), denied());
        assert_eq!(read_stable(&fifo).unwrap_err(), denied());
    }
}

//! 旧 Electron 版用户数据的首启迁移（覆盖安装场景）。
//!
//! 旧版安装身份的数据目录：
//!   Windows  %APPDATA%\HungerCatLauncher
//!   macOS    ~/Library/Application Support/HungerCatLauncher
//!   Linux    ${XDG_CONFIG_HOME:-~/.config}/HungerCatLauncher
//! 便携身份的数据在 exe 旁的 ./HCMCL，随目录整体迁移，不在本模块处理。
//!
//! 原则：对旧目录只读不删；任何一步失败都回落全新默认数据，不阻断启动；
//! 新状态文件仍由调用方统一原子落盘，本模块只构造内存数据与复制资源。

use super::*;
use std::fs;
use std::path::{Path, PathBuf};

const ELECTRON_DIR: &str = "HungerCatLauncher";
const MIGRATION_MARKER: &str = ".electron-migration-v1.json";
/// 单个资源文件上限（壁纸允许大图，但拒绝异常文件）。
const MAX_ASSET_FILE: u64 = 512 * 1024 * 1024;
/// 迁移复制的文件总数上限，防止旧目录失控拖死启动。
const MAX_ASSET_FILES: usize = 2000;
/// 跟随 Electron secret.ts 的落盘文件名；feedback-session.bin 在 Tauri 端仅内存会话，不迁移。
const SECRET_FILES: &[(&str, &str)] = &[("uapis-key.bin", "api:uapis"), ("ai-key.bin", "api:ai")];
/// 账号允许带入的字段（与 validate_account 白名单一致，多余字段直接丢弃而不是整号失败）。
const ACCOUNT_KEYS: &[&str] = &[
    "id", "name", "accessToken", "refreshToken", "expiresAt", "skinUrl", "capeUrl", "skinModel", "addedAt",
    "offline", "authType", "yggdrasilServer", "siteName", "clientToken", "microsoftAuth",
];
/// 只读派生字段：由运行环境重建，绝不能从旧文件带入。
const DERIVED_KEYS: &[&str] = &["portable", "gameDirAbs", "aiApiKeySet", "uapisApiKeySet"];

fn fresh_data(context: &Context) -> Data {
    Data {
        settings: defaults(context), accounts: Vec::new(), selected: None,
        references: BTreeMap::new(), committed_secrets: BTreeMap::new(), api_secrets: BTreeMap::new(),
        devmode_revision: 0,
    }
}

/// 旧 Electron 版的 userData 目录（不存在时返回 None）。
fn electron_userdata_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library").join("Application Support"));
    #[cfg(target_os = "linux")]
    let base = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")));
    let dir = base?.join(ELECTRON_DIR);
    if dir.is_dir() { Some(dir) } else { None }
}

/// 新根目录首次创建时调用：有旧 Electron 数据则迁移，否则返回全新默认数据。
pub(super) fn initial_data(context: &Context) -> (Data, bool) {
    let Some(old) = electron_userdata_dir() else { return (fresh_data(context), false) };
    match migrate(&old, context) {
        Ok(Some(data)) => {
            copy_assets(&old, &context.root);
            (data, true)
        }
        Ok(None) => (fresh_data(context), false),
        Err(error) => {
            eprintln!("[migration] 旧 Electron 数据迁移失败，使用全新默认数据：{error}");
            (fresh_data(context), false)
        }
    }
}

/// 补迁已经启动过旧迁移实现的安装：新版非默认设置与现有账号优先。
pub(super) fn recover_data(context: &Context, current: Data) -> (Data, bool) {
    if fs::symlink_metadata(context.root.join(MIGRATION_MARKER)).map(|m| m.is_file()).unwrap_or(false) {
        return (current, false);
    }
    let Some(old) = electron_userdata_dir() else { return (current, false) };
    match recover_at(&old, context, &current) {
        Ok(Some(data)) => {
            copy_assets(&old, &context.root);
            (data, true)
        }
        Ok(None) => (current, false),
        Err(error) => {
            eprintln!("[migration] 旧 Electron 数据补迁失败，保留当前数据：{error}");
            (current, false)
        }
    }
}

/// 状态成功提交后记录迁移完成，避免以后重复导入已删除的旧账号。
pub(super) fn mark_complete(root: &Path) {
    if let Err(error) = atomic_json(&root.join(MIGRATION_MARKER), &json!({"schema":1})) {
        eprintln!("[migration] 无法记录迁移完成状态：{error}");
    }
}

/// 读取并转换旧目录数据；旧目录没有任何可识别文件时返回 Ok(None)。
fn migrate(old_dir: &Path, context: &Context) -> Result<Option<Data>> {
    if !old_dir.join("settings.json").is_file() && !old_dir.join("accounts.json").is_file() {
        return Ok(None);
    }
    // 防御：规范化后若与新根目录相同则拒绝（目录名不同，理论上不可能）。
    let same = fs::canonicalize(old_dir).ok().zip(fs::canonicalize(&context.root).ok())
        .map(|(a, b)| a == b).unwrap_or(false);
    if same { return Err("旧数据目录与新数据目录相同，拒绝迁移".into()); }

    let mut data = fresh_data(context);
    migrate_settings(old_dir, context, &mut data.settings);
    migrate_accounts(old_dir, &mut data);
    migrate_secret_files(old_dir, &mut data);
    Ok(Some(data))
}

fn recover_at(old_dir: &Path, context: &Context, current: &Data) -> Result<Option<Data>> {
    let Some(mut legacy) = migrate(old_dir, context)? else { return Ok(None) };
    let defaults = defaults(context);
    for (key, value) in &current.settings {
        if !legacy.settings.contains_key(key) || defaults.get(key) != Some(value) {
            legacy.settings.insert(key.clone(), value.clone());
        }
    }
    for account in &current.accounts {
        let id = account["id"].as_str();
        if let Some(existing) = legacy.accounts.iter_mut().find(|old| old["id"].as_str() == id) {
            *existing = account.clone();
        } else {
            legacy.accounts.push(account.clone());
        }
    }
    if current.selected.is_some() { legacy.selected = current.selected.clone(); }
    for (slot, secret) in &current.api_secrets {
        legacy.api_secrets.insert(slot.clone(), secret.clone());
    }
    legacy.references = current.references.clone();
    legacy.committed_secrets = current.committed_secrets.clone();
    legacy.devmode_revision = current.devmode_revision;
    Ok(Some(legacy))
}

/// 设置：只接受当前版本认识的键，逐键校验，坏键跳过而不是整批失败。
fn migrate_settings(old_dir: &Path, context: &Context, settings: &mut Map<String, Value>) {
    let defs = defaults(context);
    let Some(saved) = read_json_object(&old_dir.join("settings.json")) else { return };
    for (key, value) in saved {
        if key == "javaPath" {
            // javaPath 可为 null（语义=移除）；迁移时直接跳过，让自动探测重建。
            if value.is_string() && validate_setting(&key, &value).is_ok() { settings.insert(key, value); }
            continue;
        }
        if !defs.contains_key(&key) || DERIVED_KEYS.contains(&key.as_str()) { continue; }
        if validate_setting(&key, &value).is_ok() { settings.insert(key, value); }
    }
}

/// 账号：白名单字段 + validate_account；凭据明文只进内存 Data，
/// 由调用方的统一 persist 提取进系统安全存储，绝不写进新状态文件。
fn migrate_accounts(old_dir: &Path, data: &mut Data) {
    let Some(saved) = read_json_object(&old_dir.join("accounts.json")) else { return };
    let selected_id = saved.get("selectedId").and_then(Value::as_str).map(str::to_string);
    let Some(raw_accounts) = saved.get("accounts").and_then(Value::as_array) else { return };
    let mut skipped = 0usize;
    for raw in raw_accounts.iter().take(500) {
        let Some(input) = raw.as_object() else { skipped += 1; continue };
        let filtered: Map<String, Value> = input.iter()
            .filter(|(key, _)| ACCOUNT_KEYS.contains(&key.as_str()))
            .map(|(key, value)| (key.clone(), value.clone())).collect();
        match validate_account(json!(filtered)) {
            Ok(account) => data.accounts.push(account),
            Err(_) => skipped += 1,
        }
    }
    if skipped > 0 {
        eprintln!("[migration] {skipped} 个旧账号不符合当前格式，已跳过（需重新登录）");
    }
    data.selected = selected_id
        .filter(|id| data.accounts.iter().any(|account| account["id"].as_str() == Some(id.as_str())))
        .or_else(|| data.accounts.first().and_then(|account| account["id"].as_str().map(str::to_string)));
}

/// Electron safeStorage 落盘的秘密文件：Windows 走 DPAPI 解密，
/// Linux basic_text 为明文 UTF-8；macOS（v10/v11 钥匙串派生）暂不支持，跳过并提示。
/// 解不开按「未设置」处理，用户在新版里重新填写，绝不按明文落盘。
fn migrate_secret_files(old_dir: &Path, data: &mut Data) {
    for (file, slot) in SECRET_FILES {
        let path = old_dir.join(file);
        if !path.is_file() { continue; }
        let bytes = match fs::read(&path) { Ok(bytes) if bytes.len() as u64 <= MAX_JSON => bytes, _ => continue };
        match decrypt_electron_secret(&bytes) {
            Some(value) if !value.trim().is_empty() => {
                data.api_secrets.insert((*slot).to_string(), value.trim().to_string());
            }
            _ => eprintln!("[migration] 无法迁移 {file}（需在新版重新设置）"),
        }
    }
}

#[cfg(target_os = "windows")]
fn decrypt_electron_secret(bytes: &[u8]) -> Option<String> {
    // Electron safeStorage 在 Windows 的格式：前缀 "DPAPI" + CryptProtectData 密文。
    let cipher = bytes.strip_prefix(b"DPAPI")?;
    decrypt_dpapi(cipher)
}

/// Linux 无密钥环时 Electron 使用 basic_text，内容即明文 UTF-8；其余前缀不识别。
#[cfg(target_os = "linux")]
fn decrypt_electron_secret(bytes: &[u8]) -> Option<String> {
    if bytes.starts_with(b"v10") || bytes.starts_with(b"v11") || bytes.starts_with(b"DPAPI") { return None; }
    String::from_utf8(bytes.to_vec()).ok()
}

/// macOS 的 safeStorage 密文由钥匙串派生密钥加密，暂不尝试解密。
#[cfg(target_os = "macos")]
fn decrypt_electron_secret(_bytes: &[u8]) -> Option<String> {
    None
}

#[cfg(target_os = "windows")]
fn decrypt_dpapi(cipher: &[u8]) -> Option<String> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB { cbData: cipher.len() as u32, pbData: cipher.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    unsafe {
        CryptUnprotectData(&input, None, None, None, None, 0, &mut output).ok()?;
        let plain = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
        let text = String::from_utf8(plain.to_vec()).ok();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut core::ffi::c_void)));
        text
    }
}

/// 复制用户资源：主页脚本（homepages/ 与 homepages.json）与壁纸（wallpapers/）。
/// 只复制不删除；逐文件有界，已存在的目标不覆盖；失败只警告不阻断。
fn copy_assets(old_dir: &Path, new_root: &Path) {
    let mut count = 0usize;
    for name in ["homepages", "wallpapers"] {
        let source = old_dir.join(name);
        if !source.is_dir() { continue; }
        if let Err(error) = copy_dir_bounded(&source, &new_root.join(name), &mut count) {
            eprintln!("[migration] 资源目录 {name} 迁移不完整：{error}");
        }
    }
    let homepage_state = old_dir.join("homepages.json");
    let target = new_root.join("homepages.json");
    if homepage_state.is_file() && !target.exists() {
        if let Err(error) = fs::copy(&homepage_state, &target) {
            eprintln!("[migration] homepages.json 迁移失败：{error}");
        }
    }
}

fn copy_dir_bounded(source: &Path, target: &Path, count: &mut usize) -> Result<()> {
    fs::create_dir_all(target).map_err(|_| "无法创建目标目录".to_string())?;
    let entries = fs::read_dir(source).map_err(|_| "无法读取源目录".to_string())?;
    for entry in entries {
        let entry = entry.map_err(|_| "目录项读取失败".to_string())?;
        let path = entry.path();
        let metadata = entry.metadata().map_err(|_| "目录项元数据失败".to_string())?;
        if metadata.is_dir() {
            copy_dir_bounded(&path, &target.join(entry.file_name()), count)?;
        } else if metadata.is_file() {
            if metadata.len() > MAX_ASSET_FILE { continue; }
            *count += 1;
            if *count > MAX_ASSET_FILES { return Err("迁移文件数量超过上限".into()); }
            let destination = target.join(entry.file_name());
            if !destination.exists() {
                fs::copy(&path, &destination).map_err(|_| format!("复制 {} 失败", entry.file_name().to_string_lossy()))?;
            }
        }
    }
    Ok(())
}

/// 读取 ≤ MAX_JSON 的 JSON 对象；不存在或格式不符返回 None。
fn read_json_object(path: &Path) -> Option<Map<String, Value>> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_JSON { return None; }
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice::<Value>(&bytes).ok()?.as_object().cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_context(root: &Path) -> Context {
        Context {
            root: root.to_path_buf(), executable_dir: root.to_path_buf(),
            default_game_dir: root.join("HungerCatMC"), portable: false,
        }
    }

    #[test]
    fn migration_keeps_known_settings_drops_derived_and_unknown() {
        let old = std::env::temp_dir().join(format!("hcmcl-mig-{}", Uuid::new_v4()));
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("settings.json"), json!({
            "theme": "dark", "language": "en", "portable": true, "gameDirAbs": "/should/not/leak",
            "aiApiKeySet": true, "unknownLegacyKey": 1, "maxDownloadConcurrency": 8,
            "multiplayerLobbyPassword": "secret-should-move"
        }).to_string().as_bytes()).unwrap();
        let new_root = std::env::temp_dir().join(format!("hcmcl-mig-new-{}", Uuid::new_v4()));
        fs::create_dir_all(&new_root).unwrap();
        let context = fixture_context(&new_root);
        let data = migrate(&old, &context).unwrap().unwrap();
        assert_eq!(data.settings["theme"], json!("dark"));
        assert_eq!(data.settings["language"], json!("en"));
        assert_eq!(data.settings["maxDownloadConcurrency"], json!(8));
        assert_eq!(data.settings["multiplayerLobbyPassword"], json!("secret-should-move"));
        assert!(!data.settings.contains_key("portable"));
        assert!(!data.settings.contains_key("gameDirAbs"));
        assert!(!data.settings.contains_key("aiApiKeySet"));
        assert!(!data.settings.contains_key("unknownLegacyKey"));
        validate_settings(&data.settings, &context).unwrap();
        let _ = fs::remove_dir_all(&old);
        let _ = fs::remove_dir_all(&new_root);
    }

    #[test]
    fn migration_keeps_valid_accounts_skips_invalid_and_falls_back_selected() {
        let old = std::env::temp_dir().join(format!("hcmcl-mig-{}", Uuid::new_v4()));
        fs::create_dir_all(&old).unwrap();
        let offline_id = offline_uuid("Steve");
        fs::write(old.join("accounts.json"), json!({
            "selectedId": "missing",
            "accounts": [
                {"id": offline_id, "name": "Steve", "accessToken": "0", "refreshToken": "",
                 "expiresAt": MAX_SAFE_INTEGER, "addedAt": 1, "offline": true, "legacyField": true},
                {"id": "not-a-uuid", "name": "Broken", "accessToken": "x", "addedAt": 1, "expiresAt": 2}
            ]
        }).to_string().as_bytes()).unwrap();
        let new_root = std::env::temp_dir().join(format!("hcmcl-mig-new-{}", Uuid::new_v4()));
        fs::create_dir_all(&new_root).unwrap();
        let context = fixture_context(&new_root);
        let data = migrate(&old, &context).unwrap().unwrap();
        assert_eq!(data.accounts.len(), 1);
        assert_eq!(data.accounts[0]["name"], json!("Steve"));
        assert!(!data.accounts[0].as_object().unwrap().contains_key("legacyField"));
        assert_eq!(data.selected, data.accounts[0]["id"].as_str().map(str::to_string));
        let _ = fs::remove_dir_all(&old);
        let _ = fs::remove_dir_all(&new_root);
    }

    #[test]
    fn migration_without_recognized_files_returns_none() {
        let old = std::env::temp_dir().join(format!("hcmcl-mig-{}", Uuid::new_v4()));
        fs::create_dir_all(&old).unwrap();
        let new_root = std::env::temp_dir().join(format!("hcmcl-mig-new-{}", Uuid::new_v4()));
        fs::create_dir_all(&new_root).unwrap();
        let context = fixture_context(&new_root);
        assert!(migrate(&old, &context).unwrap().is_none());
        let _ = fs::remove_dir_all(&old);
        let _ = fs::remove_dir_all(&new_root);
    }

    #[test]
    fn electron_data_directory_uses_the_name_set_by_the_old_main_process() {
        assert_eq!(ELECTRON_DIR, "HungerCatLauncher");
    }

    #[test]
    fn recovery_imports_legacy_data_when_the_new_state_is_still_default() {
        let old = std::env::temp_dir().join(format!("hcmcl-mig-{}", Uuid::new_v4()));
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("settings.json"), json!({"theme":"dark","language":"en"}).to_string()).unwrap();
        let offline_id = offline_uuid("Steve");
        fs::write(old.join("accounts.json"), json!({
            "selectedId":offline_id,
            "accounts":[{"id":offline_id,"name":"Steve","accessToken":"0","refreshToken":"",
                "expiresAt":MAX_SAFE_INTEGER,"addedAt":1,"offline":true}]
        }).to_string()).unwrap();
        let new_root = std::env::temp_dir().join(format!("hcmcl-mig-new-{}", Uuid::new_v4()));
        fs::create_dir_all(&new_root).unwrap();
        let context = fixture_context(&new_root);
        let recovered = recover_at(&old, &context, &fresh_data(&context)).unwrap().unwrap();
        assert_eq!(recovered.settings["theme"], json!("dark"));
        assert_eq!(recovered.settings["language"], json!("en"));
        assert_eq!(recovered.accounts.len(), 1);
        assert_eq!(recovered.selected.as_deref(), Some(offline_id.as_str()));
        let _ = fs::remove_dir_all(&old);
        let _ = fs::remove_dir_all(&new_root);
    }

    #[test]
    fn recovery_preserves_non_default_new_settings_and_current_accounts() {
        let old = std::env::temp_dir().join(format!("hcmcl-mig-{}", Uuid::new_v4()));
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("settings.json"), json!({"theme":"dark","language":"en"}).to_string()).unwrap();
        let old_id = offline_uuid("Old");
        fs::write(old.join("accounts.json"), json!({
            "selectedId":old_id,
            "accounts":[{"id":old_id,"name":"Old","accessToken":"0","refreshToken":"",
                "expiresAt":MAX_SAFE_INTEGER,"addedAt":1,"offline":true}]
        }).to_string()).unwrap();
        let new_root = std::env::temp_dir().join(format!("hcmcl-mig-new-{}", Uuid::new_v4()));
        fs::create_dir_all(&new_root).unwrap();
        let context = fixture_context(&new_root);
        let mut current = fresh_data(&context);
        current.settings.insert("language".into(), json!("zh-TW"));
        let current_id = offline_uuid("Current");
        current.accounts.push(json!({"id":current_id,"name":"Current","accessToken":"0","refreshToken":"",
            "expiresAt":MAX_SAFE_INTEGER,"addedAt":2,"offline":true}));
        current.selected = Some(current_id.clone());
        let recovered = recover_at(&old, &context, &current).unwrap().unwrap();
        assert_eq!(recovered.settings["theme"], json!("dark"));
        assert_eq!(recovered.settings["language"], json!("zh-TW"));
        assert_eq!(recovered.accounts.len(), 2);
        assert_eq!(recovered.selected.as_deref(), Some(current_id.as_str()));
        let _ = fs::remove_dir_all(&old);
        let _ = fs::remove_dir_all(&new_root);
    }

    #[test]
    fn asset_copy_is_bounded_and_never_overwrites() {
        let old = std::env::temp_dir().join(format!("hcmcl-mig-{}", Uuid::new_v4()));
        let nested = old.join("wallpapers").join("sub");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("a.png"), b"png").unwrap();
        fs::write(old.join("homepages.json"), b"{}").unwrap();
        let new_root = std::env::temp_dir().join(format!("hcmcl-mig-new-{}", Uuid::new_v4()));
        fs::create_dir_all(&new_root).unwrap();
        fs::write(new_root.join("homepages.json"), b"existing").unwrap();
        copy_assets(&old, &new_root);
        assert_eq!(fs::read(new_root.join("wallpapers").join("sub").join("a.png")).unwrap(), b"png");
        assert_eq!(fs::read(new_root.join("homepages.json")).unwrap(), b"existing");
        assert!(old.join("wallpapers").join("sub").join("a.png").is_file());
        let _ = fs::remove_dir_all(&old);
        let _ = fs::remove_dir_all(&new_root);
    }
}

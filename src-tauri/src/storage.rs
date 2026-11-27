//! HCMCL 的 Rust 持久化层。日常读写只使用传入数据目录内的 storage-state.json；
//! 覆盖安装时从固定的旧 Electron 目录迁移一次，不扫描其它启动器账号，不进行网络请求。
//!
//! 接线：Storage::from_app(app.handle())，然后 app.manage(storage)。
//! dispatcher 调用 storage.call(channel, args)，None 表示交给其它模块。
//! 此处的 Mutex 负责进程内串行化；程序入口仍须保证同一数据目录只有一个写进程。
//! 桌面 keyring 必须启用真实系统后端；Android 通过内部 Keystore 桥在后台线程操作秘密。

use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
mod migration;

const STATE_FILE: &str = "storage-state.json";
const SERVICE: &str = "HungerCat.HCMCL.Tauri.Storage.v1";
const MAX_JSON: u64 = 8 * 1024 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const SECRET_SETTINGS: &[&str] = &[
    "debugKey", "devModeToken", "multiplayerLobbyPassword", "aiHeaders",
];
const API_SECRET_SLOTS: &[&str] = &["api:ai", "api:uapis"];

#[derive(Clone)]
struct Data {
    settings: Map<String, Value>,
    accounts: Vec<Value>,
    selected: Option<String>,
    // 引用只在本模块生成；前端没有读取或指定系统凭据条目的接口。
    references: BTreeMap<String, String>,
    // 上次成功提交的秘密，仅在 Rust 内存中用于避免反复重写 keyring，不序列化到磁盘。
    committed_secrets: BTreeMap<String, String>,
    api_secrets: BTreeMap<String, String>,
    // 仅在进程内使用，防止授权请求跨越本地模式/授权变更后发布旧响应。
    devmode_revision: u64,
}

struct Context {
    root: PathBuf,
    executable_dir: PathBuf,
    default_game_dir: PathBuf,
    portable: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum CloseBehavior {
    #[default]
    Ask,
    Tray,
    Quit,
}

#[derive(Clone)]
pub(crate) struct ShellPreferences {
    pub(crate) language: String,
    pub(crate) close_behavior: CloseBehavior,
}

impl Default for ShellPreferences {
    fn default() -> Self { Self { language: "zh-CN".into(), close_behavior: CloseBehavior::Ask } }
}

impl ShellPreferences {
    fn from_settings(settings: &Map<String, Value>) -> Self {
        let mut preferences = Self::default();
        if let Some(language) = settings.get("language").and_then(Value::as_str) {
            preferences.language = language.to_owned();
        }
        preferences.close_behavior = match settings.get("closeBehavior").and_then(Value::as_str) {
            Some("tray") => CloseBehavior::Tray,
            Some("quit") => CloseBehavior::Quit,
            _ => CloseBehavior::Ask,
        };
        preferences
    }
}

pub struct Storage {
    context: Context,
    data: Mutex<Data>,
    shell: Mutex<ShellPreferences>,
}

type Result<T> = std::result::Result<T, String>;

// 仅后台读取真实令牌；此类型不序列化，也不通过 settings:get 返回。
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct DevModeSnapshot {
    pub(crate) revision: u64,
    pub(crate) mode: String,
    pub(crate) token: String,
    pub(crate) expires_at: u64,
    pub(crate) email_masked: String,
    pub(crate) enabled: bool,
    pub(crate) security_mode: String,
}
pub(crate) enum DevModeChange {
    Grant { token: String, expires_at: u64, email_masked: String },
    Enable { expires_at: u64, email_masked: String },
    Disable,
    Clear,
    Security(String),
}
fn devmode_snapshot(data: &Data) -> DevModeSnapshot {
    let s = &data.settings;
    DevModeSnapshot {
        revision: data.devmode_revision, mode: s["mode"].as_str().unwrap_or("local").into(),
        token: s["devModeToken"].as_str().unwrap_or("").into(),
        expires_at: s["devModeGrantedUntil"].as_u64().unwrap_or(0),
        email_masked: s["devModeEmailMasked"].as_str().unwrap_or("").into(),
        enabled: s["devModeEnabled"].as_bool().unwrap_or(false),
        security_mode: s["devModeSecurityMode"].as_str().unwrap_or("full").into(),
    }
}
fn validate_public_settings_patch(patch: &Map<String, Value>) -> Result<()> {
    if patch.keys().any(|key| matches!(key.as_str(), "devModeGrantedUntil" | "devModeToken" | "devModeEmailMasked" | "devModeEnabled" | "devModeSecurityMode")) {
        return Err("开发模式授权字段只能由专用后台接口更改 / 開發模式授權欄位只能由專用後台介面變更 / Development authorization fields require their dedicated backend".into());
    }
    Ok(())
}

/// 仅供后台导入编排计数，不携带账号或凭据，不注册为 IPC 类型。
pub(crate) struct ImportInsertResult {
    pub(crate) inserted: usize,
    pub(crate) skipped: usize,
}

impl Storage {
    fn with_data(context: Context, data: Data) -> Self {
        let shell = Mutex::new(ShellPreferences::from_settings(&data.settings));
        Self { context, data: Mutex::new(data), shell }
    }

    /// 独立调用时，默认游戏目录为 root/HungerCatMC；不猜测 Documents 的本地化路径。
    pub fn open(root: PathBuf) -> Result<Self> {
        let default_game_dir = absolute_path(&root)?.join("HungerCatMC");
        Self::open_with_default_game_dir(root, default_game_dir)
    }

    /// 使用 Tauri 2 路径解析器。移动端 Documents 不可用时退到应用私有数据目录。
    pub fn from_app<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Self> {
        use tauri::Manager;
        let root = app.path().app_data_dir().map_err(|_| "无法取得应用数据目录".to_string())?;
        #[cfg(target_os = "android")]
        let game_parent = root.clone();
        #[cfg(not(target_os = "android"))]
        let game_parent = app.path().document_dir().unwrap_or_else(|_| root.clone());
        Self::open_with_default_game_dir(root, game_parent.join("HungerCatMC"))
    }

    pub fn open_with_default_game_dir(root: PathBuf, default_game_dir: PathBuf) -> Result<Self> {
        let root = absolute_path(&root)?;
        create_private_dir(&root)?;
        let root = fs::canonicalize(&root).map_err(|_| "无法解析应用数据目录".to_string())?;
        let executable = std::env::current_exe().map_err(|_| "无法取得程序路径".to_string())?;
        let executable_dir = executable.parent().ok_or("程序路径无父目录")?.to_path_buf();
        // Tauri 没有 Electron portable 环境变量。采用实际程序旁的显式标记，不能由 settings 伪造。
        let marker = executable_dir.join("portable.flag");
        let portable = cfg!(any(target_os = "windows", target_os = "linux", target_os = "macos"))
            && fs::symlink_metadata(marker).map(|m| m.is_file() && !m.file_type().is_symlink()).unwrap_or(false);
        let context = Context {
            root, executable_dir, default_game_dir: absolute_path(&default_game_dir)?, portable,
        };
        let path = context.root.join(STATE_FILE);
        let existing = read_state(&path)?;
        let needs_persist;
        #[cfg(all(not(test), any(target_os = "windows", target_os = "linux", target_os = "macos")))]
        let migration_completed;
        let data = match existing {
            Some(value) => {
                let data = decode_state(value, &context)?;
                #[cfg(all(not(test), any(target_os = "windows", target_os = "linux", target_os = "macos")))]
                {
                    let (data, recovered) = migration::recover_data(&context, data);
                    needs_persist = recovered;
                    migration_completed = recovered;
                    data
                }
                #[cfg(any(test, target_os = "android"))]
                {
                    needs_persist = false;
                    data
                }
            },
            None => {
                needs_persist = true;
                // 覆盖安装：全新根目录先尝试从旧 Electron 数据目录迁移；
                // 测试构建不触发真实迁移，迁移函数由夹具直接覆盖。
                #[cfg(all(not(test), any(target_os = "windows", target_os = "linux", target_os = "macos")))]
                {
                    let (data, migrated) = migration::initial_data(&context);
                    migration_completed = migrated;
                    data
                }
                #[cfg(any(test, target_os = "android"))]
                { Data {
                    settings: defaults(&context), accounts: Vec::new(), selected: None,
                    references: BTreeMap::new(), committed_secrets: BTreeMap::new(), api_secrets: BTreeMap::new(), devmode_revision: 0,
                } }
            }
        };
        let storage = Self::with_data(context, data);
        // 新建或补迁时落盘；其它已有文件只验证并加载，不因一次读取覆盖旧值。
        if needs_persist {
            let mut data = storage.data.lock().map_err(|_| "存储状态不可用".to_string())?;
            storage.persist(&mut data)?;
            #[cfg(all(not(test), any(target_os = "windows", target_os = "linux", target_os = "macos")))]
            if migration_completed { migration::mark_complete(&storage.context.root); }
        }
        Ok(storage)
    }

    /// 所有返回前端的账号都经过字段白名单，不包含 accessToken / refreshToken / clientToken。
    pub fn call(&self, channel: &str, args: &[Value]) -> Result<Option<Value>> {
        let supported = matches!(channel,
            "settings:get" | "settings:set" | "accounts:list" | "accounts:selected"
            | "accounts:select" | "accounts:remove" | "accounts:addOffline"
            | "versionDirs:list" | "versionDirs:add" | "versionDirs:update"
            | "versionDirs:remove" | "versionDirs:select"
            | "ai:clearKey" | "translate:clearKey"
        );
        if !supported { return Ok(None); }
        let mut current = self.data.lock().map_err(|_| "存储状态不可用".to_string())?;
        let result = match channel {
            "settings:get" => { argument_count(args, 0)?; self.public_settings(&current) }
            "accounts:list" => {
                argument_count(args, 0)?;
                Value::Array(current.accounts.iter().map(public_account).collect())
            }
            "accounts:selected" => {
                argument_count(args, 0)?;
                selected_account(&current).map(public_account).unwrap_or(Value::Null)
            }
            "versionDirs:list" => { argument_count(args, 0)?; self.directories(&current) }
            "settings:set" => {
                argument_count(args, 1)?;
                let patch = args[0].as_object().ok_or("设置补丁必须是对象")?;
                validate_public_settings_patch(patch)?;
                let mut next = current.clone();
                apply_settings(&mut next.settings, patch, &self.context)?;
                if patch.contains_key("mode") { next.devmode_revision = next.devmode_revision.checked_add(1).ok_or("开发授权纪元已耗尽")?; }
                self.persist(&mut next)?;
                // 只在成功提交后发布；原设置写锁保证次序，窗口快照锁内不做文件或凭据操作。
                *self.shell.lock().unwrap_or_else(|error| error.into_inner()) = ShellPreferences::from_settings(&next.settings);
                *current = next;
                self.public_settings(&current)
            }
            "accounts:addOffline" => {
                argument_count(args, 1)?;
                let name = offline_name(string_arg(args, 0)?)?;
                let id = offline_uuid(&name);
                let mut next = current.clone();
                if next.accounts.iter().any(|a| a["id"] == id && a["offline"] != true) {
                    return Err("离线 UUID 与已有在线账号冲突".into());
                }
                let mut account = create_offline(&name);
                if let Some(old) = next.accounts.iter().find(|a| a["id"] == id) {
                    account["addedAt"] = old["addedAt"].clone();
                }
                upsert(&mut next.accounts, account.clone());
                if next.accounts.len() > 500 { return Err("账号数量超过上限".into()); }
                next.selected = Some(id);
                self.persist(&mut next)?;
                *current = next;
                public_account(&account)
            }
            "accounts:select" => {
                argument_count(args, 1)?;
                let id = canonical_uuid(string_arg(args, 0)?)?;
                if !current.accounts.iter().any(|a| a["id"] == id) { return Ok(Some(Value::Null)); }
                let mut next = current.clone();
                next.selected = Some(id);
                self.persist(&mut next)?;
                *current = next;
                selected_account(&current).map(public_account).unwrap_or(Value::Null)
            }
            "accounts:remove" => {
                argument_count(args, 1)?;
                let id = canonical_uuid(string_arg(args, 0)?)?;
                let mut next = current.clone();
                next.accounts.retain(|a| a["id"] != id);
                if next.selected.as_deref() == Some(id.as_str()) {
                    next.selected = next.accounts.first().and_then(|a| a["id"].as_str()).map(str::to_string);
                }
                self.persist(&mut next)?;
                *current = next;
                json!({
                    "accounts": current.accounts.iter().map(public_account).collect::<Vec<_>>(),
                    "selected": selected_account(&current).map(public_account),
                })
            }
            "versionDirs:add" | "versionDirs:update" | "versionDirs:remove" | "versionDirs:select" => {
                self.modify_directory(&mut current, channel, args)?
            }
            "ai:clearKey" | "translate:clearKey" => {
                argument_count(args, 0)?;
                let slot = if channel.starts_with("ai:") { "api:ai" } else { "api:uapis" };
                let mut next = current.clone();
                next.api_secrets.remove(slot);
                self.persist(&mut next)?;
                *current = next;
                json!({"ok": true, "message": "已删除本机保存的 API 密钥"})
            }
            _ => unreachable!(),
        };
        Ok(Some(result))
    }

    /// 仅供 Rust 登录/刷新模块保存账号。不能注册成可由 WebView 任意调用的 upsert command。
    pub fn save_account(&self, account: Value) -> Result<()> {
        self.save_accounts_for_backend(vec![account])
    }

    /// 整批先校验，再持同一把锁一次提交；系统凭据或快照写入失败时不发布部分账号。
    /// 此接口不经过 IPC，多角色登录/共享令牌轮换必须提交完整的一批。
    pub fn save_accounts_for_backend(&self, accounts: Vec<Value>) -> Result<()> {
        if accounts.len() > 500 { return Err("账号数量超过上限".into()); }
        let mut validated = Vec::with_capacity(accounts.len());
        let mut ids = BTreeSet::new();
        for account in accounts {
            let account = validate_account(account)?;
            let id = account["id"].as_str().ok_or("账号 UUID 无效")?.to_string();
            if !ids.insert(id) { return Err("批量账号 UUID 重复".into()); }
            validated.push(account);
        }
        if validated.is_empty() { return Ok(()); }
        let mut current = self.data.lock().map_err(|_| "存储状态不可用".to_string())?;
        let mut next = current.clone();
        for account in validated {
            if next.selected.is_none() { next.selected = account["id"].as_str().map(str::to_string); }
            upsert(&mut next.accounts, account);
        }
        if next.accounts.len() > 500 { return Err("账号数量超过上限".into()); }
        self.persist(&mut next)?;
        *current = next;
        Ok(())
    }

    /// 刷新只替换原快照：同一存储锁内复核完整账号，绝不重新插入已删除账号。
    /// 调用方在认证后台持有提交闸门；网络请求不能持此存储锁，返回值也不能发给 WebView。
    pub(crate) fn replace_refreshed_accounts_for_backend(&self, expected: Vec<Value>, updated: Vec<Value>) -> Result<Vec<Value>> {
        self.replace_refreshed_accounts_for_backend_with_credentials(expected, updated, secure_set, secure_delete)
    }

    fn replace_refreshed_accounts_for_backend_with_credentials(
        &self,
        expected: Vec<Value>,
        updated: Vec<Value>,
        write_secret: impl FnMut(&str, &str) -> Result<()>,
        delete_secret: impl FnMut(&str) -> Result<()>,
    ) -> Result<Vec<Value>> {
        if expected.is_empty() || expected.len() > 500 || expected.len() != updated.len() {
            return Err("刷新账号批次无效".into());
        }
        let mut originals = BTreeMap::new();
        for account in expected {
            let account = validate_account(account)?;
            let id = account["id"].as_str().ok_or("账号 UUID 无效")?.to_string();
            if originals.insert(id, account).is_some() { return Err("刷新账号 UUID 重复".into()); }
        }
        let mut replacements = Vec::with_capacity(updated.len());
        let mut ids = BTreeSet::new();
        for account in updated {
            let account = validate_account(account)?;
            let id = account["id"].as_str().ok_or("账号 UUID 无效")?.to_string();
            let original = originals.get(&id).ok_or("刷新结果与原账号不匹配")?;
            if !ids.insert(id) { return Err("刷新账号 UUID 重复".into()); }
            if account["authType"] != original["authType"] || account["offline"] != original["offline"] || account["addedAt"] != original["addedAt"] {
                return Err("刷新结果改变了账号身份或创建时间".into());
            }
            replacements.push(account);
        }
        let mut current = self.data.lock().map_err(|_| "存储状态不可用".to_string())?;
        for (id, original) in &originals {
            let saved = current.accounts.iter().find(|account| account["id"].as_str() == Some(id.as_str()))
                .ok_or("账号已被移除，未保存刷新结果")?;
            if saved != original { return Err("账号已发生变化，未保存旧刷新结果".into()); }
        }
        // 同凭据的角色集合也属于快照：网络期间新增同组角色时不能只轮换旧子集。
        let mut groups:BTreeMap<(String,String,String),BTreeSet<String>>=BTreeMap::new();
        for (id,account) in &originals {
            if account["authType"]=="yggdrasil" {
                let base=crate::auth::ygg_base(account["yggdrasilServer"].as_str().ok_or("第三方账号服务器无效")?)?;
                let access=account["accessToken"].as_str().ok_or("第三方账号凭据无效")?.to_string();
                let client=account["clientToken"].as_str().ok_or("第三方账号凭据无效")?.to_string();
                groups.entry((base,access,client)).or_default().insert(id.clone());
            }
        }
        for ((base,access,client),expected_ids) in groups {
            let mut current_ids=BTreeSet::new();
            for account in &current.accounts {
                if account["authType"]=="yggdrasil" && account["accessToken"].as_str()==Some(access.as_str()) && account["clientToken"].as_str()==Some(client.as_str())
                    && crate::auth::ygg_base(account["yggdrasilServer"].as_str().unwrap_or("")).ok().as_deref()==Some(base.as_str()) {
                    current_ids.insert(account["id"].as_str().ok_or("第三方账号 UUID 无效")?.to_string());
                }
            }
            if current_ids!=expected_ids {return Err("第三方账号角色组已发生变化，未保存旧刷新结果".into());}
        }
        let mut next = current.clone();
        for account in &replacements { upsert(&mut next.accounts, account.clone()); }
        if next.accounts != current.accounts {
            self.persist_with_credentials(&mut next, write_secret, delete_secret)?;
            *current = next;
        }
        Ok(replacements)
    }

    /// 导入只新增：校验整批后在同一存储锁内重新过滤重复 UUID，绝不覆盖并发登录或已有账号。
    /// 调用者在后台线程持导入提交闸门；凭据与快照一次提交成功后才发布内存。
    pub(crate) fn insert_import_accounts_for_backend(&self, accounts: Vec<Value>) -> Result<ImportInsertResult> {
        if accounts.len() > 500 { return Err("账号数量超过上限".into()); }
        let mut validated = Vec::with_capacity(accounts.len());
        let mut ids = BTreeSet::new();
        for account in accounts {
            let account = validate_account(account)?;
            let id = account["id"].as_str().ok_or("账号 UUID 无效")?.to_string();
            if !ids.insert(id) { return Err("导入账号 UUID 重复".into()); }
            validated.push(account);
        }
        let mut current = self.data.lock().map_err(|_| "存储状态不可用".to_string())?;
        let mut next = current.clone();
        let mut inserted = 0;
        let mut skipped = 0;
        for account in validated {
            if next.accounts.iter().any(|saved| saved["id"] == account["id"]) { skipped += 1; continue; }
            if next.selected.is_none() { next.selected = account["id"].as_str().map(str::to_string); }
            next.accounts.push(account);
            inserted += 1;
        }
        if next.accounts.len() > 500 { return Err("账号数量超过上限".into()); }
        if inserted != 0 {
            self.persist(&mut next)?;
            *current = next;
        }
        Ok(ImportInsertResult { inserted, skipped })
    }

    /// 同步实例重命名/删除后的设置引用，不移动实例文件，也不自行选择另一个实例。
    /// 调用方负责文件操作及其失败恢复；目标已有任何引用时拒绝合并或覆盖。
    pub fn commit_version_change_for_backend(&self, old_id: &str, new_id: Option<&str>) -> Result<()> {
        validate_version_reference(old_id)?;
        if let Some(id) = new_id { validate_version_reference(id)?; }
        let mut current = self.data.lock().map_err(|_| "存储状态不可用".to_string())?;
        if new_id == Some(old_id) { return Ok(()); }
        let selected = current.settings["selectedVersionId"].as_str().ok_or("当前实例设置无效")?;
        let isolated = current.settings["isolatedVersions"].as_array().ok_or("实例隔离设置无效")?;
        let disabled = current.settings["disabledVersions"].as_array().ok_or("禁用实例设置无效")?;
        let java = current.settings["versionJava"].as_object().ok_or("实例 Java 设置无效")?;
        if let Some(id) = new_id {
            if selected == id || isolated.iter().chain(disabled).any(|item| item.as_str() == Some(id)) || java.contains_key(id) {
                return Err("目标实例已有设置引用，不能覆盖".into());
            }
        }
        let mut next = current.clone();
        if selected == old_id {
            next.settings.insert("selectedVersionId".into(), json!(new_id.unwrap_or("")));
        }
        for key in ["isolatedVersions", "disabledVersions"] {
            let items = next.settings.get_mut(key).and_then(Value::as_array_mut).ok_or("实例列表设置无效")?;
            if let Some(id) = new_id {
                for item in items.iter_mut() { if item.as_str() == Some(old_id) { *item = json!(id); } }
            } else {
                items.retain(|item| item.as_str() != Some(old_id));
            }
        }
        let java = next.settings.get_mut("versionJava").and_then(Value::as_object_mut).ok_or("实例 Java 设置无效")?;
        if let Some(value) = java.remove(old_id) {
            if let Some(id) = new_id { java.insert(id.into(), value); }
        }
        if next.settings == current.settings { return Ok(()); }
        self.persist(&mut next)?;
        *current = next;
        Ok(())
    }

    /// 不经过 IPC；调用者必须保证不把原始令牌发送给前端或日志。
    pub fn account_for_backend(&self, id: Option<&str>) -> Result<Option<Value>> {
        let data = self.data.lock().map_err(|_| "存储状态不可用".to_string())?;
        Ok(match id {
            Some(id) => {
                let id = canonical_uuid(id)?;
                data.accounts.iter().find(|a| a["id"] == id).cloned()
            }
            None => selected_account(&data).cloned(),
        })
    }

    /// 启动派发的线性化点：短暂持账号存储锁复核整个快照，再调用固定的宿主进程派发闭包。
    /// 闭包不能读取/修改 Storage、发送事件、联网或等待游戏退出；账号删除只能发生在它之前或之后。
    pub(crate) fn with_unchanged_account_for_launch<T>(&self, expected: &Value, dispatch: impl FnOnce() -> Result<T>) -> Result<T> {
        let id = canonical_uuid(expected.get("id").and_then(Value::as_str).ok_or("启动账号 UUID 无效")?)?;
        let current = self.data.lock().map_err(|_| "存储状态不可用".to_string())?;
        let saved = current.accounts.iter().find(|account| account["id"].as_str() == Some(id.as_str()))
            .ok_or("启动账号已被移除，未派发游戏进程")?;
        if saved != expected { return Err("启动账号已发生变化，请重试启动".into()); }
        dispatch()
    }

    /// 专用快照不解析游戏目录、不读取无关 API 密钥，也不向前端泄漏令牌。
    pub(crate) fn devmode_snapshot_for_backend(&self) -> Result<DevModeSnapshot> {
        let data = self.data.lock().map_err(|_| "开发模式存储状态不可用".to_string())?;
        Ok(devmode_snapshot(&data))
    }

    /// 网络在锁外完成；比较进程内版本和全部授权字段，再原子提交系统凭据与 JSON。
    pub(crate) fn devmode_update_for_backend(&self, expected: &DevModeSnapshot, change: DevModeChange, permit: &crate::devmode::Permit) -> Result<DevModeSnapshot> {
        self.devmode_update_with(expected, change, permit, secure_set, secure_delete)
    }
    fn devmode_update_with(&self, expected: &DevModeSnapshot, change: DevModeChange, permit: &crate::devmode::Permit,
        write_secret: impl FnMut(&str, &str) -> Result<()>, delete_secret: impl FnMut(&str) -> Result<()>) -> Result<DevModeSnapshot> {
        let mut current = self.data.lock().map_err(|_| "开发模式存储状态不可用".to_string())?;
        if &devmode_snapshot(&current) != expected { return Err("开发模式设置已改变，请重试 / 開發模式設定已變更，請重試 / Development settings changed; retry".into()); }
        let mut next = current.clone();
        match change {
            DevModeChange::Grant { token, expires_at, email_masked } => {
                crate::devmode::validate_grant(&token, expires_at, &email_masked, now_ms())?;
                if expected.mode == "local" { return Err("本地模式不能签发开发授权".into()); }
                next.settings.insert("devModeToken".into(), json!(token));
                next.settings.insert("devModeGrantedUntil".into(), json!(expires_at));
                next.settings.insert("devModeEmailMasked".into(), json!(email_masked));
                next.settings.insert("devModeEnabled".into(), json!(true));
            }
            DevModeChange::Enable { expires_at, email_masked } => {
                crate::devmode::validate_grant(&expected.token, expires_at, &email_masked, now_ms())?;
                if expected.mode == "local" { return Err("本地模式不能启用开发授权".into()); }
                next.settings.insert("devModeGrantedUntil".into(), json!(expires_at));
                next.settings.insert("devModeEmailMasked".into(), json!(email_masked));
                next.settings.insert("devModeEnabled".into(), json!(true));
            }
            DevModeChange::Disable => { next.settings.insert("devModeEnabled".into(), json!(false)); }
            DevModeChange::Clear => {
                next.settings.insert("devModeEnabled".into(), json!(false));
                next.settings.insert("devModeToken".into(), json!(""));
                next.settings.insert("devModeGrantedUntil".into(), json!(0));
                next.settings.insert("devModeEmailMasked".into(), json!(""));
            }
            DevModeChange::Security(mode) => {
                if !matches!(mode.as_str(), "full" | "warn" | "off") { return Err("开发模式防护偏好无效".into()); }
                next.settings.insert("devModeSecurityMode".into(), json!(mode));
            }
        }
        next.devmode_revision = next.devmode_revision.checked_add(1).ok_or("开发授权纪元已耗尽")?;
        self.persist_with_guard(&mut next, write_secret, delete_secret, Some(permit))?;
        *current = next;
        Ok(devmode_snapshot(&current))
    }

    pub fn settings_for_backend(&self) -> Result<Value> {
        let data = self.data.lock().map_err(|_| "存储状态不可用".to_string())?;
        Ok(self.complete_settings(&data))
    }

    /// 小快照只在提交后赋值；读取不等待 Data、文件、账号或密钥库。
    pub(crate) fn shell_preferences(&self) -> ShellPreferences {
        self.shell.lock().unwrap_or_else(|error| error.into_inner()).clone()
    }

    pub(crate) fn try_shell_language(&self) -> Option<String> {
        Some(self.shell_preferences().language)
    }

    /// 调用方须先取得游戏目录锁；闭包不得重入 Storage、联网或等待其他锁。
    /// 同一锁内读取设置并完成目录操作，避免与设置更改交错。
    pub(crate) fn with_settings_for_backend<T>(&self, operation: impl FnOnce(&Value) -> T) -> Result<T> {
        let data = self.data.lock().map_err(|_| "存储状态不可用".to_string())?;
        Ok(operation(&self.complete_settings(&data)))
    }

    /// 只供 Rust 管理文件模块使用；不作为 IPC 返回，也不能由前端指定。
    pub(crate) fn data_root_for_backend(&self) -> PathBuf { self.context.root.clone() }

    /// 仅替换仍与选图时一致的壁纸字段；并发修改的其它设置始终保留。
    /// 文件的创建与清理由调用方管理，本方法只在原子持久化成功后发布新值。
    pub(crate) fn compare_set_wallpaper_for_backend(&self, expected: &str, next: &str) -> Result<Value> {
        if !next.is_empty() && (next.len() > 240 || next.trim() != next || next.ends_with('.')
            || matches!(next, "." | "..") || next.chars().any(|c| c.is_control() || "\\/:*?\"<>|".contains(c))
            || Path::new(next).file_name().and_then(|v| v.to_str()) != Some(next)) {
            return Err("壁纸文件名无效 / 桌布檔案名稱無效 / Invalid wallpaper filename".into());
        }
        let mut current = self.data.lock().map_err(|_| "存储状态不可用".to_string())?;
        if current.settings.get("backgroundImage").and_then(Value::as_str) != Some(expected) {
            return Err("壁纸选择已改变，请重新选择 / 桌布選擇已變更，請重新選取 / Wallpaper selection changed; select it again".into());
        }
        let mut updated = current.clone();
        apply_settings(&mut updated.settings, json!({"backgroundImage":next}).as_object().expect("壁纸设置对象"), &self.context)?;
        self.persist(&mut updated)?;
        *current = updated;
        Ok(self.public_settings(&current))
    }

    /// 主页工作只比较选择字段，保留同期其它设置；调用方在仓库串行区内验证内容。
    pub(crate) fn compare_set_homepage_for_backend(&self, expected: &str, next: &str) -> Result<()> {
        if !next.is_empty() && !crate::homepage::valid_id(next) {
            return Err("主页标识无效 / 主頁標識無效 / Invalid homepage identifier".into());
        }
        let mut current = self.data.lock().map_err(|_| "存储状态不可用".to_owned())?;
        if current.settings.get("homepageId").and_then(Value::as_str).unwrap_or("") != expected {
            return Err("主页选择已改变，请重试 / 主頁選擇已變更，請重試 / Homepage selection changed; retry".into());
        }
        let mut next_data = current.clone();
        next_data.settings.insert("homepageId".into(), json!(next));
        self.persist(&mut next_data)?;
        *current = next_data;
        Ok(())
    }

    /// 可信 Java 安装 worker 已完成最终路径、架构与主版本核验后调用。
    /// 同一存储锁内比较选择字段，避免下载期间的手动选择被旧任务覆盖；不改变自动选择策略。
    pub(crate) fn select_installed_java_for_backend(&self, expected: &Value, installed: &Path) -> Result<bool> {
        let snapshot = expected.as_object().ok_or("Java 选择快照必须是对象")?;
        if !snapshot.get("javaAutoDetect").is_some_and(Value::is_boolean)
            || snapshot.get("javaPath").is_some_and(|value| !value.is_string()) {
            return Err("Java 选择快照无效".into());
        }
        if !installed.is_absolute() || installed.components().any(|part| matches!(part, Component::ParentDir | Component::CurDir)) {
            return Err("已安装的 Java 必须使用可信绝对路径".into());
        }
        let installed = installed.to_str().ok_or("Java 路径不是有效 Unicode")?;
        let patch = json!({"javaPath":installed});
        validate_setting("javaPath", &patch["javaPath"])?;
        let mut current = self.data.lock().map_err(|_| "存储状态不可用".to_string())?;
        if ["javaPath", "javaAutoDetect"].iter().any(|key| current.settings.get(*key) != snapshot.get(*key)) {
            return Ok(false);
        }
        let mut next = current.clone();
        apply_settings(&mut next.settings, patch.as_object().expect("已构造对象"), &self.context)?;
        self.persist(&mut next)?;
        *current = next;
        Ok(true)
    }

    /// 协议服务采用 SHA-256 前 32 位十六进制；仅给已接受且指纹为空的旧记录补值。
    pub fn migrate_agreement_version_for_backend(&self, version: &str) -> Result<bool> {
        if version.len() != 32 || !version.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("协议版本指纹无效".into());
        }
        let mut current = self.data.lock().map_err(|_| "存储状态不可用".to_string())?;
        if current.settings.get("agreementAcceptedAt").and_then(Value::as_u64).unwrap_or(0) == 0
            || !current.settings.get("agreementAcceptedVersion").and_then(Value::as_str).unwrap_or("").is_empty() {
            return Ok(false);
        }
        let mut next = current.clone();
        next.settings.insert("agreementAcceptedVersion".into(), json!(version));
        self.persist(&mut next)?;
        *current = next;
        Ok(true)
    }

    /// 上层 ai:setKey / translate:setKey 先做真实连通性验证，成功后才调用此方法。
    /// 存储层没有联网，不能冒充密钥验证成功，因此不接管这两个 setKey channel。
    pub fn save_api_key_for_backend(&self, kind: &str, key: &str) -> Result<()> {
        let slot = match kind { "ai" => "api:ai", "uapis" => "api:uapis", _ => return Err("未知密钥类别".into()) };
        let key = key.trim();
        secret_string(key)?;
        if key.is_empty() { return Err("密钥不能为空".into()); }
        let mut current = self.data.lock().map_err(|_| "存储状态不可用".to_string())?;
        let mut next = current.clone();
        next.api_secrets.insert(slot.into(), key.into());
        self.persist(&mut next)?;
        *current = next;
        Ok(())
    }

    pub fn api_key_for_backend(&self, kind: &str) -> Result<Option<String>> {
        let slot = match kind { "ai" => "api:ai", "uapis" => "api:uapis", _ => return Err("未知密钥类别".into()) };
        let data = self.data.lock().map_err(|_| "存储状态不可用".to_string())?;
        Ok(data.api_secrets.get(slot).cloned())
    }

    pub fn active_game_dir(&self) -> Result<PathBuf> {
        let data = self.data.lock().map_err(|_| "存储状态不可用".to_string())?;
        let selected = data.settings["selectedVersionDirId"].as_str().unwrap_or("");
        if let Some(dir) = data.settings["versionDirs"].as_array().and_then(|dirs| dirs.iter().find(|d| d["id"] == selected)) {
            return Ok(PathBuf::from(dir["path"].as_str().ok_or("版本目录无效")?));
        }
        self.resolve_game_dir(&data)
    }

    fn resolve_game_dir(&self, data: &Data) -> Result<PathBuf> {
        let path = PathBuf::from(data.settings["gameDir"].as_str().ok_or("游戏目录无效")?);
        if path.is_absolute() { Ok(path) }
        else if self.context.portable { Ok(self.context.executable_dir.join(path)) }
        else { Err("非便携版游戏目录必须为绝对路径".into()) }
    }

    fn complete_settings(&self, data: &Data) -> Value {
        let mut settings = data.settings.clone();
        settings.insert("portable".into(), json!(self.context.portable));
        settings.insert("gameDirAbs".into(), json!(path_string(&self.resolve_game_dir(data).expect("已校验游戏目录"))));
        settings.insert("aiApiKeySet".into(), json!(data.api_secrets.contains_key("api:ai")));
        settings.insert("uapisApiKeySet".into(), json!(data.api_secrets.contains_key("api:uapis")));
        Value::Object(settings)
    }

    fn public_settings(&self, data: &Data) -> Value {
        let mut settings = self.complete_settings(data);
        for key in SECRET_SETTINGS { settings[*key] = json!(""); }
        settings
    }

    fn directories(&self, data: &Data) -> Value {
        let mut dirs = vec![json!({
            "id": "default", "alias": "默认", "isDefault": true,
            "path": path_string(&self.resolve_game_dir(data).expect("已校验游戏目录")),
        })];
        dirs.extend(data.settings["versionDirs"].as_array().expect("已校验目录列表").clone());
        Value::Array(dirs)
    }

    fn modify_directory(&self, current: &mut Data, channel: &str, args: &[Value]) -> Result<Value> {
        let mut next = current.clone();
        let mut dirs = next.settings["versionDirs"].as_array().ok_or("版本目录列表无效")?.clone();
        match channel {
            "versionDirs:add" => {
                argument_count(args, 1)?;
                let input = args[0].as_object().ok_or("目录参数必须是对象")?;
                keys_only(input, &["path", "alias"])?;
                let path = path_input(input.get("path").ok_or("缺少目录路径")?)?;
                let alias = input.get("alias").map(|v| text(v, 256, false)).transpose()?.unwrap_or_default().trim().to_string();
                if path_string(&self.resolve_game_dir(current)?) == path || dirs.iter().any(|d| d["path"] == path) {
                    return Ok(self.directories(current));
                }
                dirs.push(json!({ "id": format!("dir-{}", Uuid::new_v4()), "alias": alias, "path": path }));
                if dirs.len() > 256 { return Err("版本目录数量超过上限".into()); }
            }
            "versionDirs:update" => {
                argument_count(args, 2)?;
                let id = string_arg(args, 0)?;
                let patch = args[1].as_object().ok_or("目录补丁必须是对象")?;
                keys_only(patch, &["path", "alias"])?;
                if id == "default" { return Ok(self.directories(current)); }
                let dir = dirs.iter_mut().find(|d| d["id"] == id).ok_or("版本目录不存在")?;
                if let Some(alias) = patch.get("alias") { dir["alias"] = json!(text(alias, 256, false)?.trim()); }
                if let Some(path) = patch.get("path") { dir["path"] = json!(path_input(path)?); }
            }
            "versionDirs:remove" => {
                argument_count(args, 1)?;
                let id = string_arg(args, 0)?;
                if id == "default" { return Ok(self.directories(current)); }
                dirs.retain(|d| d["id"] != id);
                if next.settings["selectedVersionDirId"] == id { next.settings.insert("selectedVersionDirId".into(), json!("")); }
            }
            "versionDirs:select" => {
                argument_count(args, 1)?;
                let id = string_arg(args, 0)?;
                let selected = if id != "default" && dirs.iter().any(|d| d["id"] == id) { id } else { "" };
                next.settings.insert("selectedVersionDirId".into(), json!(selected));
            }
            _ => unreachable!(),
        }
        next.settings.insert("versionDirs".into(), Value::Array(dirs));
        validate_settings(&next.settings, &self.context)?;
        self.persist(&mut next)?;
        *current = next;
        if channel == "versionDirs:select" {
            let id = current.settings["selectedVersionDirId"].as_str().unwrap_or("");
            Ok(json!(if id.is_empty() { "default" } else { id }))
        } else { Ok(self.directories(current)) }
    }

    /// 秘密先写到全新的系统凭据条目，再原子发布 JSON 引用；失败时不改内存和旧快照。
    fn persist(&self, next: &mut Data) -> Result<()> {
        self.persist_with_credentials(next, secure_set, secure_delete)
    }

    // 私有凭据操作参数便于纯夹具模拟后项失败；生产入口始终使用上面的系统后端。
    fn persist_with_credentials(
        &self, next: &mut Data,
        write_secret: impl FnMut(&str, &str) -> Result<()>,
        delete_secret: impl FnMut(&str) -> Result<()>,
    ) -> Result<()> {
        self.persist_with_guard(next, write_secret, delete_secret, None)
    }

    fn persist_with_guard(&self, next: &mut Data,
        mut write_secret: impl FnMut(&str, &str) -> Result<()>, mut delete_secret: impl FnMut(&str) -> Result<()>,
        permit: Option<&crate::devmode::Permit>) -> Result<()> {
        validate_settings(&next.settings, &self.context)?;
        let (mut disk, secrets) = encode_state(next)?;
        let old = next.references.clone();
        let mut references = BTreeMap::new();
        let mut created = Vec::new();
        let result: Result<()> = (|| {
            for (slot, value) in &secrets {
                // 只复用值完全未变的引用；有变化时建新条目，不原地修改旧快照引用。
                if next.committed_secrets.get(slot) == Some(value) {
                    if let Some(reference) = old.get(slot) {
                        references.insert(slot.clone(), reference.clone());
                        continue;
                    }
                }
                let reference = Uuid::new_v4().to_string();
                write_secret(&reference, value)?;
                created.push(reference.clone());
                references.insert(slot.clone(), reference);
            }
            disk["secrets"] = json!(references);
            match permit {
                Some(permit) => permit.commit(|| atomic_json(&self.context.root.join(STATE_FILE), &disk))?,
                None => atomic_json(&self.context.root.join(STATE_FILE), &disk)?,
            }
            Ok(())
        })();
        if let Err(error) = result {
            for reference in created { let _ = delete_secret(&reference); }
            return Err(error);
        }
        // 快照提交成功后才回收旧凭据；回收失败只遗留受系统保护的旧条目，不能回滚已提交快照。
        for reference in old.values() {
            if !references.values().any(|r| r == reference) { let _ = delete_secret(reference); }
        }
        next.references = references;
        next.committed_secrets = secrets;
        Ok(())
    }
}

fn defaults(context: &Context) -> Map<String, Value> {
    // 与 src/shared/settings.ts SETTINGS_DEFS 对齐；派生字段由 complete_settings 补齐。
    let mut out = Map::new();
    macro_rules! fields { ($($key:literal => $value:expr),* $(,)?) => { $(out.insert($key.into(), json!($value));)* }; }
    fields! {
        "theme" => "system", "mode" => "normal", "experimental" => "off",
        "materialStyle" => "you", "githubStyle" => "system", "accentColor" => "#0a84ff",
        "reducedMotion" => false, "background" => "midnight", "backgroundImage" => "",
        "customBackgroundEnabled" => false, "customBackgroundCount" => 2,
        "customBackgroundDirection" => "diagonal",
        "customBackgroundColors" => json!(["#0a84ff", "#bf5af2", "#ff9f0a"]),
        "navPosition" => "left", "showServerStatus" => true, "closeBehavior" => "ask",
        "language" => "zh-CN", "autoTranslateResources" => false, "translateResourceNames" => true,
        "autoThemeFromWallpaper" => false, "enableMultiplayer" => false, "hardwareAcceleration" => false,
        "gameDir" => if context.portable { "./.minecraft".to_string() } else { path_string(&context.default_game_dir) },
        "versionIsolation" => false, "metadataOnlyMods" => false, "hudEnabled" => false,
        "hudOpacity" => 0.8, "hudShowMultiplayer" => true, "hudShowAi" => true, "hudShowLyrics" => false,
        "gameWindowSize" => "720p", "gameWindowWidth" => 1280, "gameWindowHeight" => 720,
        "closeOnLaunch" => false, "javaAutoDetect" => true, "versionJava" => json!({}),
        "debugMode" => false, "debugKey" => "", "downloadSource" => "auto", "versionListSource" => "auto",
        "downloadAcceleration" => "auto", "maxDownloadConcurrency" => 16, "downloadConnections" => 16,
        "curseforgeApiKey" => "$2a$10$X3Oi59zph7PyOAEO/0kyxuQmxAOJxOunNaDT3LJmw2jPzUzZaFCr.",
        "communitySource" => "auto", "modTitleStyle" => "translated-first", "announcementDisplay" => "all",
        "autoCheckLauncherUpdate" => true, "autoCheckHomepageUpdate" => true,
        "aiEnabled" => false, "aiFormat" => "openai", "aiBaseUrl" => "https://api.openai.com/v1",
        "aiHeaders" => "", "aiModel" => "gpt-4o-mini", "aiHistoryTurns" => 10,
        "aiVoiceEnabled" => false, "aiVoiceModel" => "whisper-1", "aiBallEnabled" => false,
        "aiBallX" => -1, "aiBallY" => -1, "aiAutoAnalyzeErrors" => true, "aiToolsEnabled" => false,
        "aiToolPolicy" => json!({}), "memoryMb" => 4096, "versionDirs" => json!([]),
        "selectedVersionDirId" => "", "disabledVersions" => json!([]), "isolatedVersions" => json!([]),
        "agreementAcceptedAt" => 0, "agreementAcceptedVersion" => "", "announcementSeen" => json!({}),
        "onboardingDone" => false, "feedbackLogConsent" => false, "homepageId" => "", "selectedVersionId" => "",
        "hardwareChecked" => false, "devModeGrantedUntil" => 0, "devModeToken" => "",
        "devModeEmailMasked" => "", "devModeEnabled" => false, "devModeSecurityMode" => "full",
        "multiplayerLicenseAcceptedAt" => 0, "multiplayerPlayerName" => "", "multiplayerUsePrivateServer" => false,
        "multiplayerEasytierServer" => "udp://us01.225284.xyz:11010",
        "multiplayerSignalingServer" => "wss://mctier.pmhs.top/signaling", "multiplayerUseDomain" => false,
        "multiplayerAutoLobbyEnabled" => false, "multiplayerLobbyName" => "", "multiplayerLobbyPassword" => "",
        "multiplayerCustomNodes" => json!([]), "multiplayerSoundVolume" => 0.8,
        "multiplayerSoundNewMsg" => true, "multiplayerSoundJoined" => true, "multiplayerSoundLeft" => true,
        "multiplayerDndEnabled" => false, "multiplayerDndStart" => 1320, "multiplayerDndEnd" => 480,
        "multiplayerSummonHotkey" => "Ctrl+Alt+M", "multiplayerDanmakuEnabled" => true,
        "multiplayerDanmakuFontSize" => 16, "multiplayerDanmakuSpeed" => 8, "multiplayerDanmakuOpacity" => 0.85,
        "multiplayerDanmakuTracks" => 4, "multiplayerTheme" => "system", "multiplayerStatsMinutes" => 0,
        "multiplayerJoinCount" => 0, "multiplayerHostCount" => 0,
    }
    out
}

fn apply_settings(settings: &mut Map<String, Value>, patch: &Map<String, Value>, context: &Context) -> Result<()> {
    let defs = defaults(context);
    for (key, value) in patch {
        if matches!(key.as_str(), "portable" | "gameDirAbs" | "aiApiKeySet" | "uapisApiKeySet") {
            return Err(format!("设置 {key} 是只读派生字段"));
        }
        if key == "javaPath" && value.is_null() { settings.remove(key); continue; }
        if key != "javaPath" && !defs.contains_key(key) { return Err(format!("未知设置字段：{key}")); }
        validate_setting(key, value)?;
        settings.insert(key.clone(), value.clone());
    }
    if context.portable { settings.insert("gameDir".into(), json!("./.minecraft")); }
    // 删除当前选中的目录时，统一回退默认目录。
    let id = settings["selectedVersionDirId"].as_str().unwrap_or("");
    if !id.is_empty() && !settings["versionDirs"].as_array().ok_or("版本目录列表无效")?.iter().any(|d| d["id"] == id) {
        settings.insert("selectedVersionDirId".into(), json!(""));
    }
    validate_settings(settings, context)
}

fn validate_settings(settings: &Map<String, Value>, context: &Context) -> Result<()> {
    let defs = defaults(context);
    for (key, value) in settings {
        if !defs.contains_key(key) && key != "javaPath" { return Err(format!("未知设置字段：{key}")); }
        validate_setting(key, value)?;
    }
    for key in defs.keys() { if !settings.contains_key(key) { return Err(format!("缺少设置字段：{key}")); } }
    let game = settings["gameDir"].as_str().ok_or("游戏目录无效")?;
    if context.portable {
        if game != "./.minecraft" { return Err("便携版游戏目录必须使用 ./.minecraft".into()); }
    } else { path_input(&json!(game))?; }
    Ok(())
}

fn validate_setting(key: &str, value: &Value) -> Result<()> {
    let bad = || format!("设置 {key} 的类型或取值无效");
    let enumeration: Option<&[&str]> = match key {
        "theme" | "multiplayerTheme" => Some(&["light", "dark", "system"]),
        "mode" => Some(&["normal", "local", "minimal"]),
        "experimental" => Some(&["off", "mica", "mac", "frosted", "material", "github", "winui2", "winui3", "minecraft", "pcl2", "win10"]),
        "materialStyle" => Some(&["baseline", "you", "expressive"]),
        "githubStyle" => Some(&["system", "light", "dark", "dimmed", "light-hc", "dark-hc"]),
        "navPosition" => Some(&["top", "bottom", "left", "right"]),
        "customBackgroundDirection" => Some(&["vertical", "horizontal", "diagonal"]),
        "closeBehavior" => Some(&["ask", "tray", "quit"]),
        "gameWindowSize" => Some(&["720p", "1080p", "maximized", "fullscreen", "custom"]),
        "downloadSource" | "versionListSource" | "communitySource" => Some(&["mirror-first", "auto", "official-first"]),
        "downloadAcceleration" => Some(&["auto", "balanced", "turbo"]),
        "modTitleStyle" => Some(&["translated-first", "filename-first"]),
        "announcementDisplay" => Some(&["all", "important-only"]),
        "aiFormat" => Some(&["openai", "anthropic", "gemini", "ollama", "custom"]),
        "devModeSecurityMode" => Some(&["full", "warn", "off"]),
        _ => None,
    };
    if let Some(options) = enumeration {
        return if value.as_str().map(|s| options.contains(&s)).unwrap_or(false) { Ok(()) } else { Err(bad()) };
    }
    let number_range = match key {
        "memoryMb" => Some((128.0, 1_048_576.0, true)),
        "maxDownloadConcurrency" => Some((1.0, 64.0, true)),
        "downloadConnections" => Some((1.0, 256.0, true)),
        "gameWindowWidth" | "gameWindowHeight" => Some((1.0, 32768.0, true)),
        "aiHistoryTurns" => Some((1.0, 50.0, true)),
        "customBackgroundCount" => Some((1.0, 3.0, true)),
        "aiBallX" | "aiBallY" => Some((-1.0, 1_000_000.0, false)),
        "hudOpacity" | "multiplayerSoundVolume" | "multiplayerDanmakuOpacity" => Some((0.0, 1.0, false)),
        "multiplayerDndStart" | "multiplayerDndEnd" => Some((0.0, 1439.0, true)),
        "multiplayerDanmakuFontSize" => Some((1.0, 256.0, true)),
        "multiplayerDanmakuSpeed" => Some((0.1, 3600.0, false)),
        "multiplayerDanmakuTracks" => Some((1.0, 256.0, true)),
        "agreementAcceptedAt" | "devModeGrantedUntil" | "multiplayerLicenseAcceptedAt"
        | "multiplayerStatsMinutes" | "multiplayerJoinCount" | "multiplayerHostCount" => Some((0.0, MAX_SAFE_INTEGER as f64, true)),
        _ => None,
    };
    if let Some((min, max, integer)) = number_range {
        let number = value.as_f64().ok_or_else(bad)?;
        return if number.is_finite() && number >= min && number <= max && (!integer || number.fract() == 0.0) { Ok(()) } else { Err(bad()) };
    }
    match key {
        "versionDirs" => {
            let dirs = value.as_array().ok_or_else(bad)?;
            if dirs.len() > 256 { return Err(bad()); }
            let mut ids = BTreeSet::new();
            let mut paths = BTreeSet::new();
            for dir in dirs {
                let object = dir.as_object().ok_or_else(bad)?;
                keys_only(object, &["id", "alias", "path"])?;
                let id = text(object.get("id").ok_or_else(bad)?, 128, true)?;
                if id == "default" || !ids.insert(id) || !paths.insert(path_input(object.get("path").ok_or_else(bad)?)?) { return Err(bad()); }
                text(object.get("alias").ok_or_else(bad)?, 256, false)?;
            }
        }
        "disabledVersions" | "isolatedVersions" => {
            let array = value.as_array().ok_or_else(bad)?;
            if array.len() > 10000 { return Err(bad()); }
            for item in array { text(item, 512, true)?; }
        }
        "versionJava" | "announcementSeen" | "aiToolPolicy" => {
            let object = value.as_object().ok_or_else(bad)?;
            if object.len() > 10000 { return Err(bad()); }
            for (name, item) in object {
                if name.is_empty() || name.len() > 512 || name.chars().any(char::is_control) { return Err(bad()); }
                match key {
                    "versionJava" => { let p = text(item, 32768, false)?; if !p.is_empty() { path_input(item)?; } }
                    "announcementSeen" => { let n = item.as_u64().ok_or_else(bad)?; if n > MAX_SAFE_INTEGER { return Err(bad()); } }
                    _ => { if !matches!(item.as_str(), Some("allow" | "ask" | "deny")) { return Err(bad()); } }
                }
            }
        }
        "multiplayerCustomNodes" => {
            let array = value.as_array().ok_or_else(bad)?;
            if array.len() > 256 { return Err(bad()); }
            for node in array {
                let node = node.as_object().ok_or_else(bad)?;
                keys_only(node, &["name", "address"])?;
                text(node.get("name").ok_or_else(bad)?, 256, false)?;
                text(node.get("address").ok_or_else(bad)?, 4096, true)?;
            }
        }
        "aiHeaders" => {
            let headers = value.as_str().ok_or_else(bad)?;
            if headers.len() > 32768 || headers.chars().any(|c| c.is_control() && !matches!(c, '\r' | '\n' | '\t')) { return Err(bad()); }
            if !headers.is_empty() {
                let headers: Value = serde_json::from_str(&headers).map_err(|_| bad())?;
                let headers = headers.as_object().ok_or_else(bad)?;
                if headers.len() > 128 { return Err(bad()); }
                for (name, value) in headers {
                    if name.is_empty() || !name.bytes().all(|c| c.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&c)) { return Err(bad()); }
                    text(value, 8192, false)?;
                }
            }
        }
        "accentColor" => {
            let color = value.as_str().ok_or_else(bad)?;
            if color.len() != 7 || !color.starts_with('#') || !color[1..].bytes().all(|c| c.is_ascii_hexdigit()) { return Err(bad()); }
        }
        // 自定义背景色：固定三个槽位（未参与取色的槽位也保留上一次的值，供来回切换）。
        // 只在前端校验是不够的：settings.json 可被手改，非法值会原样拼进 CSS。
        "customBackgroundColors" => {
            let colors = value.as_array().ok_or_else(bad)?;
            if colors.len() != 3 { return Err(bad()); }
            for color in colors {
                let color = color.as_str().ok_or_else(bad)?;
                if color.len() != 7 || !color.starts_with('#') || !color[1..].bytes().all(|c| c.is_ascii_hexdigit()) { return Err(bad()); }
            }
        }
        "gameDir" | "javaPath" => { text(value, 32768, key == "gameDir")?; }
        "language" => { text(value, 64, true)?; }
        _ => {
            if BOOLEAN_FIELDS.contains(&key) {
                if !value.is_boolean() { return Err(bad()); }
            } else {
                // 这里只接受注册表里的字符串键；未知键由 apply / validate_settings 先行拒绝。
                text(value, if SECRET_SETTINGS.contains(&key) { 32768 } else { 8192 }, false)?;
            }
        }
    }
    Ok(())
}

const BOOLEAN_FIELDS: &[&str] = &[
    "reducedMotion", "showServerStatus", "autoTranslateResources", "translateResourceNames",
    "autoThemeFromWallpaper", "enableMultiplayer", "hardwareAcceleration", "versionIsolation",
    "metadataOnlyMods", "hudEnabled", "hudShowMultiplayer", "hudShowAi", "hudShowLyrics", "closeOnLaunch",
    "javaAutoDetect", "debugMode", "autoCheckLauncherUpdate", "autoCheckHomepageUpdate", "aiEnabled",
    "aiVoiceEnabled", "aiBallEnabled", "aiAutoAnalyzeErrors", "aiToolsEnabled", "onboardingDone",
    "feedbackLogConsent", "hardwareChecked", "devModeEnabled", "multiplayerUsePrivateServer",
    "multiplayerUseDomain", "multiplayerAutoLobbyEnabled", "multiplayerSoundNewMsg", "multiplayerSoundJoined",
    "multiplayerSoundLeft", "multiplayerDndEnabled", "multiplayerDanmakuEnabled",
    "customBackgroundEnabled",
];

fn create_offline(name: &str) -> Value {
    let digest = Uuid::new_v4();
    let index = digest.as_bytes()[0] as usize % DEFAULT_SKINS.len();
    let (hash, model) = DEFAULT_SKINS[index];
    json!({
        "id": offline_uuid(name), "name": name, "accessToken": "0", "refreshToken": "",
        "expiresAt": MAX_SAFE_INTEGER, "skinUrl": format!("https://textures.minecraft.net/texture/{hash}"),
        "skinModel": model, "addedAt": now_ms(), "offline": true, "authType": "offline",
    })
}

const DEFAULT_SKINS: &[(&str, &str)] = &[
    ("46b9aa7b7965f9397e49fb5a0051711b6b8c1a08", "classic"),
    ("2e191c48e7c0fe120a3adb2425773688d15021fe", "slim"),
    ("745417f10866ee5130469efb9edcddf27f1ce5b3", "slim"),
    ("dfc845526527f29cfc46279d033bd05a86ed085c", "slim"),
    ("706559d6bdf11a18621d830efa7c4c6a12b1a2b4", "slim"),
    ("74ce72ce43faa29eef0a12e66b0000de6a912eaf", "slim"),
    ("4d3fbd9d52341356ab76c15e973e61562afe8344", "slim"),
    ("64ae4556d10665de238c7106912d45e70cdc27de", "slim"),
    ("1277a561362c72b2aa906f67713178da04a805fb", "slim"),
];

fn offline_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.chars().any(char::is_control) { return Err("离线名称不能含控制字符".into()); }
    // 与 JavaScript slice(0,16) 的 UTF-16 上限一致，但不截断一个代理对。
    let mut out = String::new();
    let mut units = 0;
    for c in name.chars() {
        units += c.len_utf16();
        if units > 16 { break; }
        out.push(c);
    }
    Ok(if out.is_empty() { "Steve".into() } else { out })
}

fn offline_uuid(name: &str) -> String {
    let mut bytes = md5::compute(format!("OfflinePlayer:{name}").as_bytes()).0;
    bytes[6] = (bytes[6] & 0x0f) | 0x30;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn selected_account(data: &Data) -> Option<&Value> {
    data.selected.as_ref().and_then(|id| data.accounts.iter().find(|a| a["id"] == id.as_str())).or_else(|| data.accounts.first())
}

fn upsert(accounts: &mut Vec<Value>, account: Value) {
    if let Some(index) = accounts.iter().position(|a| a["id"] == account["id"]) { accounts[index] = account; }
    else { accounts.push(account); }
}

fn public_account(account: &Value) -> Value {
    let mut out = Map::new();
    for key in ["id", "name", "expiresAt", "skinUrl", "capeUrl", "skinModel", "addedAt", "offline", "authType", "yggdrasilServer", "siteName"] {
        if let Some(value) = account.get(key) { out.insert(key.into(), value.clone()); }
    }
    Value::Object(out)
}

fn validate_account(account: Value) -> Result<Value> {
    let input = account.as_object().ok_or("账号必须是对象")?;
    keys_only(input, &[
        "id", "name", "accessToken", "refreshToken", "expiresAt", "skinUrl", "capeUrl", "skinModel", "addedAt",
        "offline", "authType", "yggdrasilServer", "siteName", "clientToken", "microsoftAuth",
    ])?;
    let mut out = input.clone();
    out.insert("id".into(), json!(canonical_uuid(input.get("id").and_then(Value::as_str).ok_or("账号 UUID 无效")?)?));
    let name = text(input.get("name").ok_or("缺少账号名称")?, 256, true)?;
    if name.encode_utf16().count() > 64 { return Err("账号名称过长".into()); }
    let offline = match input.get("offline") { Some(v) => v.as_bool().ok_or("账号 offline 字段无效")?, None => false };
    let auth = match input.get("authType") {
        Some(value) => value.as_str().ok_or("账号认证类型必须是字符串")?,
        None => if offline { "offline" } else { "microsoft" },
    };
    if !matches!(auth, "offline" | "microsoft" | "yggdrasil") || (auth == "offline") != offline { return Err("账号认证类型无效".into()); }
    out.insert("offline".into(), json!(offline));
    out.insert("authType".into(), json!(auth));
    for key in ["accessToken", "refreshToken", "clientToken"] {
        let value = input.get(key).map(|v| text(v, 32768, false)).transpose()?.unwrap_or_default();
        secret_string(&value)?;
        out.insert(key.into(), json!(value));
    }
    for key in ["addedAt", "expiresAt"] {
        if input.get(key).and_then(Value::as_u64).filter(|n| *n <= MAX_SAFE_INTEGER).is_none() { return Err(format!("账号 {key} 无效")); }
    }
    if offline {
        if canonical_uuid(out["id"].as_str().ok_or("账号 UUID 无效")?)? != offline_uuid(&name) { return Err("离线账号 UUID 与名称不匹配".into()); }
        if out["accessToken"] != "0" || out["refreshToken"] != "" || out["clientToken"] != "" { return Err("离线账号不应包含在线凭据".into()); }
    } else if out["accessToken"].as_str().unwrap_or("").is_empty() && out["refreshToken"].as_str().unwrap_or("").is_empty() {
        return Err("在线账号缺少凭据".into());
    }
    for key in ["skinUrl", "capeUrl", "yggdrasilServer", "siteName"] {
        if let Some(value) = input.get(key) { text(value, 8192, false)?; }
    }
    if let Some(model) = input.get("skinModel") { if !matches!(model.as_str(), Some("classic" | "slim")) { return Err("皮肤模型无效".into()); } }
    if let Some(auth) = input.get("microsoftAuth") {
        let auth = auth.as_object().ok_or("微软授权来源无效")?;
        keys_only(auth, &["clientId", "scope", "endpoint"])?;
        text(auth.get("clientId").ok_or("缺少微软 clientId")?, 128, true)?;
        text(auth.get("scope").ok_or("缺少微软 scope")?, 1024, true)?;
        if !matches!(auth.get("endpoint").and_then(Value::as_str), Some("live" | "consumers")) { return Err("微软授权 endpoint 无效".into()); }
    }
    Ok(Value::Object(out))
}

fn encode_state(data: &Data) -> Result<(Value, BTreeMap<String, String>)> {
    let mut settings = data.settings.clone();
    let mut secrets = data.api_secrets.clone();
    for key in SECRET_SETTINGS {
        let secret = settings[*key].as_str().ok_or("敏感设置类型无效")?;
        if !secret.is_empty() { secrets.insert(format!("settings:{key}"), secret.to_string()); }
        settings.insert((*key).into(), json!(""));
    }
    let mut accounts = Vec::new();
    for account in &data.accounts {
        let mut account = validate_account(account.clone())?;
        let id = account["id"].as_str().ok_or("账号 UUID 无效")?.to_string();
        for key in ["accessToken", "refreshToken", "clientToken"] {
            let value = account[key].as_str().ok_or("账号凭据无效")?.to_string();
            if !value.is_empty() && !(account["offline"] == true && key == "accessToken" && value == "0") {
                secrets.insert(format!("account:{id}:{key}"), value);
            }
            account.as_object_mut().ok_or("账号无效")?.remove(key);
        }
        accounts.push(account);
    }
    Ok((json!({
        "schema": 1, "settings": settings, "accounts": accounts,
        "selectedAccountId": data.selected, "secrets": {},
    }), secrets))
}

fn decode_state(value: Value, context: &Context) -> Result<Data> {
    let object = value.as_object().ok_or("存储快照不是对象")?;
    keys_only(object, &["schema", "settings", "accounts", "selectedAccountId", "secrets"])?;
    if value["schema"] != 1 { return Err("不支持的存储快照版本".into()); }
    let references = parse_references(value.get("secrets").ok_or("缺少秘密引用")?)?;
    let saved = value["settings"].as_object().ok_or("设置快照无效")?;
    let mut settings = defaults(context);
    apply_settings(&mut settings, saved, context)?;
    for key in SECRET_SETTINGS {
        if saved.get(*key).and_then(Value::as_str).unwrap_or("") != "" { return Err("拒绝读取含明文秘密的设置快照".into()); }
    }
    let raw_accounts = value["accounts"].as_array().ok_or("账号快照无效")?;
    if raw_accounts.len() > 500 { return Err("账号数量超过上限".into()); }
    let mut accounts = Vec::new();
    let mut expected = BTreeSet::new();
    for key in SECRET_SETTINGS { expected.insert(format!("settings:{key}")); }
    for slot in API_SECRET_SLOTS { expected.insert((*slot).to_string()); }
    let mut ids = BTreeSet::new();
    for raw in raw_accounts {
        let mut account = raw.clone();
        let id = canonical_uuid(account["id"].as_str().ok_or("账号 UUID 无效")?)?;
        if !ids.insert(id.clone()) { return Err("账号 UUID 重复".into()); }
        for key in ["accessToken", "refreshToken", "clientToken"] {
            if account.get(key).is_some() { return Err("拒绝读取含明文凭据的账号快照".into()); }
            let slot = format!("account:{id}:{key}");
            expected.insert(slot.clone());
            let secret = match references.get(&slot) {
                Some(reference) => secure_get(reference)?,
                None if key == "accessToken" && account["offline"] == true => "0".into(),
                None => String::new(),
            };
            account[key] = json!(secret);
        }
        accounts.push(validate_account(account)?);
    }
    if references.keys().any(|key| !expected.contains(key)) { return Err("秘密引用与当前设置或账号不匹配".into()); }
    for key in SECRET_SETTINGS {
        if let Some(reference) = references.get(&format!("settings:{key}")) { settings.insert((*key).into(), json!(secure_get(reference)?)); }
    }
    let mut api_secrets = BTreeMap::new();
    for slot in API_SECRET_SLOTS {
        if let Some(reference) = references.get(*slot) { api_secrets.insert((*slot).into(), secure_get(reference)?); }
    }
    validate_settings(&settings, context)?;
    let selected = match value.get("selectedAccountId") {
        Some(Value::Null) => None,
        Some(Value::String(id)) => Some(canonical_uuid(id)?),
        _ => return Err("选中账号字段无效".into()),
    };
    let selected = selected.filter(|id| accounts.iter().any(|account| account["id"] == id.as_str()))
        .or_else(|| accounts.first().and_then(|a| a["id"].as_str()).map(str::to_string));
    let mut data = Data { settings, accounts, selected, references, committed_secrets: BTreeMap::new(), api_secrets, devmode_revision: 0 };
    data.committed_secrets = encode_state(&data)?.1;
    Ok(data)
}

fn parse_references(value: &Value) -> Result<BTreeMap<String, String>> {
    let input = value.as_object().ok_or("秘密引用表无效")?;
    if input.len() > 1600 { return Err("秘密引用数量过多".into()); }
    let mut out = BTreeMap::new();
    let mut unique = BTreeSet::new();
    for (slot, reference) in input {
        let reference = reference.as_str().ok_or("秘密引用格式无效")?;
        if Uuid::parse_str(reference).map(|id| id.to_string() == reference).unwrap_or(false) == false || !unique.insert(reference) { return Err("秘密引用格式无效".into()); }
        out.insert(slot.clone(), reference.to_string());
    }
    Ok(out)
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
fn secure_entry(reference: &str) -> Result<keyring::Entry> {
    use keyring::credential::CredentialPersistence;
    // 直接使用该平台的编译后端，不受进程中其它模块设置的默认 builder 影响。
    // keyring 未启用系统 feature 时会退到 mock；不能把 mock 的读回成功当成安全落盘。
    let builder = keyring::default::default_credential_builder();
    if !matches!(builder.persistence(), CredentialPersistence::UntilDelete) {
        return Err("未启用可持久化的系统安全存储后端，拒绝保存秘密".into());
    }
    let credential = builder.build(None, SERVICE, reference).map_err(|_| "无法初始化系统安全存储".to_string())?;
    if credential.as_any().is::<keyring::mock::MockCredential>() {
        return Err("模拟凭据存储不能保存真实秘密".into());
    }
    Ok(keyring::Entry::new_with_credential(credential))
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
fn secure_set(reference: &str, secret: &str) -> Result<()> {
    let entry = secure_entry(reference)?;
    entry.set_password(secret).map_err(|_| "系统安全存储不可用，秘密未保存".to_string())?;
    // 未连接真实后端、拒绝写入或读回不一致时，不发布引用。
    match entry.get_password() {
        Ok(readback) if readback == secret => Ok(()),
        _ => { let _ = entry.delete_credential(); Err("系统安全存储写入后无法验证，秘密未保存".into()) }
    }
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
fn secure_get(reference: &str) -> Result<String> {
    secure_entry(reference)?.get_password()
        .map_err(|_| "无法解锁系统安全存储；账号和设置未被覆盖".into())
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
fn secure_delete(reference: &str) -> Result<()> {
    secure_entry(reference)?.delete_credential()
        .map_err(|_| "无法清理旧的系统凭据条目".into())
}

#[cfg(target_os = "android")]
fn secure_set(reference: &str, secret: &str) -> Result<()> {
    crate::mobile_security::secure_set(reference, secret)
}
#[cfg(target_os = "android")]
fn secure_get(reference: &str) -> Result<String> {
    crate::mobile_security::secure_get(reference)
}
#[cfg(target_os = "android")]
fn secure_delete(reference: &str) -> Result<()> {
    crate::mobile_security::secure_delete(reference)
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos", target_os = "android")))]
fn secure_set(_reference: &str, _secret: &str) -> Result<()> {
    Err("此平台的原生安全存储尚未接入，拒绝保存秘密".into())
}
#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos", target_os = "android")))]
fn secure_get(_reference: &str) -> Result<String> {
    Err("此平台的原生安全存储尚未接入，拒绝读取秘密".into())
}
#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos", target_os = "android")))]
fn secure_delete(_reference: &str) -> Result<()> {
    Err("此平台的原生安全存储尚未接入，拒绝操作秘密".into())
}

fn read_state(path: &Path) -> Result<Option<Value>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法读取存储快照属性".into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_JSON { return Err("存储快照不是安全的普通文件或体积超限".into()); }
    let mut file = File::open(path).map_err(|_| "无法打开存储快照".to_string())?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file).take(MAX_JSON + 1).read_to_end(&mut bytes).map_err(|_| "无法读取存储快照".to_string())?;
    if bytes.len() as u64 > MAX_JSON { return Err("存储快照体积超限".into()); }
    let bytes = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { bytes[3..].to_vec() } else { bytes };
    serde_json::from_slice(&bytes).map(Some).map_err(|_| "存储快照损坏，原件已保留".into())
}

fn atomic_json(target: &Path, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| "无法序列化存储快照".to_string())?;
    if bytes.len() as u64 > MAX_JSON { return Err("存储快照体积超限".into()); }
    if let Ok(metadata) = fs::symlink_metadata(target) {
        if !metadata.is_file() || metadata.file_type().is_symlink() { return Err("拒绝覆盖非普通存储文件".into()); }
    }
    let parent = target.parent().ok_or("存储文件缺少父目录")?;
    let temp = parent.join(format!(".storage-{}.tmp", Uuid::new_v4()));
    let result: Result<()> = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(&temp).map_err(|_| "无法创建存储暂存文件".to_string())?;
        file.write_all(&bytes).map_err(|_| "无法写入存储暂存文件".to_string())?;
        file.sync_all().map_err(|_| "无法同步存储暂存文件".to_string())?;
        drop(file);
        replace_file(&temp, target)?;
        // 目录 fsync 不由所有平台/文件系统支持；不在 rename 已成功后谎报本次事务未提交。
        #[cfg(unix)] { if let Ok(directory) = File::open(parent) { let _ = directory.sync_all(); } }
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(&temp); }
    result
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" { fn MoveFileExW(source: *const u16, target: *const u16, flags: u32) -> i32; }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH，不先删除旧快照。
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0x1 | 0x8) } == 0 { Err("原子替换存储失败；旧快照已保留".into()) }
    else { Ok(()) }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> Result<()> {
    fs::rename(source, target).map_err(|_| "原子替换存储失败；旧快照已保留".into())
}

fn create_private_dir(path: &Path) -> Result<()> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.is_dir() || metadata.file_type().is_symlink() { return Err("应用数据目录必须是普通目录".into()); }
    }
    fs::create_dir_all(path).map_err(|_| "无法创建应用数据目录".to_string())?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| "无法设置私有数据目录权限".to_string())?;
    }
    Ok(())
}

fn absolute_path(path: &Path) -> Result<PathBuf> {
    let path = if path.is_absolute() { path.to_path_buf() } else {
        std::env::current_dir().map_err(|_| "无法取得当前目录".to_string())?.join(path)
    };
    if path.components().any(|c| matches!(c, Component::ParentDir)) { return Err("路径不能包含父目录跳转".into()); }
    Ok(path)
}

fn path_input(value: &Value) -> Result<String> {
    let value = text(value, 32768, true)?;
    let path = Path::new(&value);
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) { return Err("目录路径必须为无父目录跳转的绝对路径".into()); }
    Ok(value)
}

fn validate_version_reference(value: &str) -> Result<()> {
    // 使用调用方已确定的实际实例 ID，不替调用方 trim，避免与落盘目录名不一致。
    if value.is_empty() || value.len() > 512 || value.trim().is_empty() || matches!(value, "." | "..")
        || value.chars().any(|c| c.is_control() || "\\/:*?\"<>|".contains(c)) {
        return Err("实例 ID 为空、过长或包含非法字符".into());
    }
    Ok(())
}

fn canonical_uuid(value: &str) -> Result<String> {
    if value.len() != 32 && value.len() != 36 { return Err("账号 UUID 无效".into()); }
    Uuid::parse_str(value).map(|id| id.simple().to_string()).map_err(|_| "账号 UUID 无效".into())
}

fn text(value: &Value, max: usize, required: bool) -> Result<String> {
    let value = value.as_str().ok_or("字段必须是字符串")?;
    if value.len() > max || value.chars().any(char::is_control) || (required && value.trim().is_empty()) { return Err("字符串为空、过长或含控制字符".into()); }
    Ok(value.to_string())
}

fn secret_string(value: &str) -> Result<()> {
    if value.len() > 32768 || value.chars().any(char::is_control) { return Err("凭据格式无效或过长".into()); }
    Ok(())
}

fn keys_only(value: &Map<String, Value>, keys: &[&str]) -> Result<()> {
    if value.keys().any(|key| !keys.contains(&key.as_str())) { return Err("参数包含未知字段".into()); }
    Ok(())
}

fn argument_count(args: &[Value], count: usize) -> Result<()> {
    if args.len() == count { Ok(()) } else { Err("参数数量无效".into()) }
}

fn string_arg(args: &[Value], index: usize) -> Result<&str> {
    args.get(index).and_then(Value::as_str).ok_or_else(|| "参数必须是字符串".into())
}

fn path_string(path: &Path) -> String { path.to_string_lossy().into_owned() }
fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis().min(MAX_SAFE_INTEGER as u128) as u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture { root: PathBuf }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("hcmcl-rust-storage-{}", Uuid::new_v4()));
            fs::create_dir_all(&root).expect("创建测试目录");
            Self { root }
        }
        fn context(&self, portable: bool) -> Context {
            Context {
                root: self.root.clone(), executable_dir: self.root.clone(),
                default_game_dir: self.root.join("documents").join("HungerCatMC"), portable,
            }
        }
        fn storage(&self, portable: bool) -> Storage {
            let context = self.context(portable);
            let data = Data {
                settings: defaults(&context), accounts: Vec::new(), selected: None,
                references: BTreeMap::new(), committed_secrets: BTreeMap::new(), api_secrets: BTreeMap::new(), devmode_revision: 0,
            };
            Storage::with_data(context, data)
        }
        fn bytes(&self) -> Vec<u8> { fs::read(self.root.join(STATE_FILE)).expect("读取测试快照") }

        // 在线账号夹具使用合法的内存状态和虚拟引用，避免测试依赖本机 keyring；生产写入路径不变。
        fn seed_accounts(&self, storage: &Storage, accounts: Vec<Value>) {
            let mut data = storage.data.lock().expect("测试存储锁");
            data.accounts = accounts.into_iter().map(validate_account).collect::<Result<Vec<_>>>().expect("校验测试账号");
            data.selected = data.accounts.first().and_then(|account| account["id"].as_str()).map(str::to_string);
            let (mut disk, secrets) = encode_state(&data).expect("编码测试快照");
            let references: BTreeMap<_, _> = secrets.keys().map(|slot| (slot.clone(), Uuid::new_v4().to_string())).collect();
            disk["secrets"] = json!(references);
            atomic_json(&self.root.join(STATE_FILE), &disk).expect("写入测试快照");
            data.references = references;
            data.committed_secrets = secrets;
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            // 仅清理本夹具通过随机名称创建的临时目录，不读取或操作真实账号、系统凭据。
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    fn call(storage: &Storage, channel: &str, args: &[Value]) -> Value {
        storage.call(channel, args).expect("存储调用").expect("模块接管 channel")
    }

    #[test]
    fn offline_uuid_matches_java_and_utf16_limit() {
        assert_eq!(offline_uuid("Notch"), "b50ad385829d3141a2167e7d7539ba7f");
        assert_eq!(offline_name("   ").unwrap(), "Steve");
        assert_eq!(offline_name("  abc  ").unwrap(), "abc");
        assert_eq!(offline_name("123456789012345😀").unwrap(), "123456789012345");
        assert!(offline_name("a\nb").is_err());
    }

    #[test]
    fn offline_accounts_roundtrip_selection_and_redaction() {
        let fixture = Fixture::new();
        let storage = fixture.storage(false);
        let first = call(&storage, "accounts:addOffline", &[json!("Notch")]);
        let second = call(&storage, "accounts:addOffline", &[json!("Alex")]);
        assert_eq!(call(&storage, "accounts:selected", &[])["id"], second["id"]);
        assert!(first.get("accessToken").is_none());
        assert!(first.get("refreshToken").is_none());
        assert!(first.get("clientToken").is_none());
        call(&storage, "accounts:select", &[first["id"].clone()]);
        let disk: Value = serde_json::from_slice(&fixture.bytes()).unwrap();
        assert_eq!(disk["selectedAccountId"], first["id"]);
        assert_eq!(disk["secrets"], json!({}));
        assert!(disk["accounts"][0].get("accessToken").is_none());
        let loaded = decode_state(disk, &fixture.context(false)).unwrap();
        assert_eq!(selected_account(&loaded).unwrap()["accessToken"], "0");
        assert_eq!(loaded.accounts.len(), 2);
        let result = call(&storage, "accounts:remove", &[first["id"].clone()]);
        assert_eq!(result["accounts"].as_array().unwrap().len(), 1);
        assert_eq!(result["selected"]["id"], second["id"]);
        call(&storage, "accounts:remove", &[second["id"].clone()]);
        assert_eq!(call(&storage, "accounts:selected", &[]), Value::Null);
    }

    #[test]
    fn shell_snapshot_does_not_wait_for_data_and_only_publishes_successful_commits() {
        let fixture = Fixture::new(); let storage = fixture.storage(false);
        {
            let _held = storage.data.lock().unwrap();
            let preferences = storage.shell_preferences();
            assert_eq!(preferences.language, "zh-CN");
            assert_eq!(preferences.close_behavior, CloseBehavior::Ask);
        }
        call(&storage, "settings:set", &[json!({"language":"zh-TW","closeBehavior":"tray"})]);
        let preferences = storage.shell_preferences();
        assert_eq!(preferences.language, "zh-TW");
        assert_eq!(preferences.close_behavior, CloseBehavior::Tray);
        assert!(storage.call("settings:set", &[json!({"closeBehavior":"invalid"})]).is_err());
        assert_eq!(storage.shell_preferences().close_behavior, CloseBehavior::Tray);
        let path = fixture.root.join(STATE_FILE);
        // 此路径由本夹具创建并已核验，转换为目录以模拟原子发布失败。
        assert!(path.starts_with(&fixture.root) && path.file_name().unwrap() == STATE_FILE);
        fs::remove_file(&path).unwrap(); fs::create_dir(&path).unwrap();
        assert!(storage.call("settings:set", &[json!({"language":"en","closeBehavior":"quit"})]).is_err());
        let preferences = storage.shell_preferences();
        assert_eq!(preferences.language, "zh-TW");
        assert_eq!(preferences.close_behavior, CloseBehavior::Tray);
        assert_eq!(storage.settings_for_backend().unwrap()["closeBehavior"], "tray");
    }

    #[test]
    fn shell_snapshot_is_initialized_from_loaded_settings() {
        let fixture = Fixture::new(); let storage = fixture.storage(false);
        call(&storage, "settings:set", &[json!({"language":"en","closeBehavior":"quit"})]);
        let loaded = decode_state(serde_json::from_slice(&fixture.bytes()).unwrap(), &fixture.context(false)).unwrap();
        let reopened = Storage::with_data(fixture.context(false), loaded);
        assert_eq!(reopened.shell_preferences().language, "en");
        assert_eq!(reopened.shell_preferences().close_behavior, CloseBehavior::Quit);
    }

    #[test]
    fn settings_reject_unknown_and_wrong_types_without_changes() {
        let fixture = Fixture::new();
        let storage = fixture.storage(false);
        let good = call(&storage, "settings:set", &[json!({"theme":"dark", "versionJava":{}, "language":"zh-TW"})]);
        assert_eq!(good["theme"], "dark");
        assert_eq!(good["portable"], false);
        assert_eq!(good["gameDirAbs"], json!(path_string(&fixture.context(false).default_game_dir)));
        let before = fixture.bytes();
        for patch in [
            json!({"unknownField":true}), json!({"memoryMb":"4096"}), json!({"mode":"invalid"}),
            json!({"showServerStatus":1}), json!({"aiHistoryTurns":0}), json!({"portable":true}),
            json!({"gameDirAbs":"fake"}), json!({"aiApiKeySet":true}), json!({"aiToolPolicy":{"tool":"invalid"}}),
            // 自定义背景色：个数越界 / 方向不在枚举内 / 颜色不是 3 个与非法色值都必须拒绝
            json!({"customBackgroundCount":4}), json!({"customBackgroundDirection":"upside"}),
            json!({"customBackgroundColors":["#ffffff"]}), json!({"customBackgroundEnabled":"yes"}),
            json!({"customBackgroundColors":["#ffffff","#000000","red"]}),
            json!({"customBackgroundColors":["#ffffff","#000000","#12345"]}),
        ] {
            assert!(storage.call("settings:set", &[patch]).is_err());
            assert_eq!(fixture.bytes(), before);
            assert_eq!(call(&storage, "settings:get", &[])["theme"], "dark");
        }
    }

    #[test]
    fn custom_background_settings_round_trip() {
        let fixture = Fixture::new();
        let storage = fixture.storage(false);
        let saved = call(&storage, "settings:set", &[json!({
            "customBackgroundEnabled": true, "customBackgroundCount": 3,
            "customBackgroundDirection": "horizontal",
            "customBackgroundColors": ["#112233", "#445566", "#778899"]
        })]);
        assert_eq!(saved["customBackgroundEnabled"], true);
        assert_eq!(saved["customBackgroundCount"], 3);
        assert_eq!(saved["customBackgroundDirection"], "horizontal");
        assert_eq!(saved["customBackgroundColors"], json!(["#112233", "#445566", "#778899"]));
        // 从磁盘快照解码一次：确认布尔 / 数组真的落盘，且校验放行
        let disk: Value = serde_json::from_slice(&fixture.bytes()).expect("读取快照");
        let decoded = decode_state(disk, &fixture.context(false)).expect("解码快照");
        assert_eq!(decoded.settings["customBackgroundEnabled"], true);
        assert_eq!(decoded.settings["customBackgroundColors"][2], "#778899");
        // 未设置过该功能的老配置：读出的是默认值，不会因为缺字段而拒绝整份快照
        let fresh = Fixture::new();
        let defaults = call(&fresh.storage(false), "settings:get", &[]);
        assert_eq!(defaults["customBackgroundEnabled"], false);
        assert_eq!(defaults["customBackgroundColors"].as_array().map(Vec::len), Some(3));
    }

    #[test]
    fn wallpaper_compare_set_preserves_other_settings_and_one_concurrent_winner() {
        let fixture = Fixture::new(); let storage = fixture.storage(false);
        call(&storage, "settings:set", &[json!({"theme":"dark"})]);
        let barrier = std::sync::Barrier::new(3);
        let results = std::thread::scope(|scope| {
            let a = scope.spawn(|| { barrier.wait(); storage.compare_set_wallpaper_for_backend("", "wallpaper-a.png") });
            let b = scope.spawn(|| { barrier.wait(); storage.compare_set_wallpaper_for_backend("", "wallpaper-b.gif") });
            barrier.wait(); [a.join().unwrap(), b.join().unwrap()]
        });
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        let saved = call(&storage, "settings:get", &[]);
        assert_eq!(saved["theme"], "dark");
        let name = saved["backgroundImage"].as_str().unwrap();
        assert!(matches!(name, "wallpaper-a.png" | "wallpaper-b.gif"));
        assert_eq!(serde_json::from_slice::<Value>(&fixture.bytes()).unwrap()["settings"]["backgroundImage"], name);
        call(&storage, "settings:set", &[json!({"theme":"light"})]);
        let cleared = storage.compare_set_wallpaper_for_backend(name, "").unwrap();
        assert_eq!(cleared["theme"], "light"); assert_eq!(cleared["backgroundImage"], "");
        assert_eq!(storage.data_root_for_backend(), fixture.root);
    }

    #[test]
    fn wallpaper_compare_set_rejects_paths_and_keeps_memory_after_persist_failure() {
        let fixture = Fixture::new(); let storage = fixture.storage(false);
        let before = storage.settings_for_backend().unwrap();
        for name in ["../x.png", "a/b.png", "a\\b.png", "C:x.png", ".", "..", " x.png", "x.png.", "x\n.png"] {
            assert!(storage.compare_set_wallpaper_for_backend("", name).is_err());
        }
        fs::create_dir(fixture.root.join(STATE_FILE)).unwrap();
        assert!(storage.compare_set_wallpaper_for_backend("", "wallpaper-new.png").is_err());
        assert_eq!(storage.settings_for_backend().unwrap(), before);
    }

    #[test]
    fn installed_java_selection_preserves_manual_changes_and_auto_policy() {
        let fixture = Fixture::new();
        let storage = fixture.storage(false);
        call(&storage, "settings:set", &[json!({"theme":"dark"})]);
        let expected = storage.settings_for_backend().unwrap();
        let installed = fixture.root.join("java17").join("bin").join("java");
        assert!(storage.select_installed_java_for_backend(&expected, &installed).unwrap());
        let selected = call(&storage, "settings:get", &[]);
        assert_eq!(selected["javaPath"], json!(installed));
        assert_eq!(selected["javaAutoDetect"], true);
        assert_eq!(selected["theme"], "dark");
        let captured = storage.settings_for_backend().unwrap();
        call(&storage, "settings:set", &[json!({"javaPath":"user-selected", "javaAutoDetect":false})]);
        let before = fixture.bytes();
        assert!(!storage.select_installed_java_for_backend(&captured, &installed).unwrap());
        assert_eq!(fixture.bytes(), before);
        assert_eq!(call(&storage, "settings:get", &[])["javaPath"], "user-selected");
        // 单独改变自动策略也会保留新选择，不被完成较晚的安装回写。
        let captured = storage.settings_for_backend().unwrap();
        call(&storage, "settings:set", &[json!({"javaAutoDetect":true})]);
        assert!(!storage.select_installed_java_for_backend(&captured, &installed).unwrap());
    }

    #[test]
    fn concurrent_java_installs_compare_and_save_under_one_storage_lock() {
        let fixture = Fixture::new();
        let storage = fixture.storage(false);
        let expected = storage.settings_for_backend().unwrap();
        let barrier = std::sync::Barrier::new(3);
        let paths = [fixture.root.join("java-a"), fixture.root.join("java-b")];
        let outcomes = std::thread::scope(|scope| {
            let a = scope.spawn(|| { barrier.wait(); storage.select_installed_java_for_backend(&expected, &paths[0]).unwrap() });
            let b = scope.spawn(|| { barrier.wait(); storage.select_installed_java_for_backend(&expected, &paths[1]).unwrap() });
            barrier.wait();
            [a.join().unwrap(), b.join().unwrap()]
        });
        assert_eq!(outcomes.iter().filter(|saved| **saved).count(), 1);
        let winner = if outcomes[0] { &paths[0] } else { &paths[1] };
        assert_eq!(call(&storage, "settings:get", &[])["javaPath"], json!(winner));
        let disk: Value = serde_json::from_slice(&fixture.bytes()).unwrap();
        assert_eq!(disk["settings"]["javaPath"], json!(winner));
        assert_eq!(disk["settings"]["javaAutoDetect"], true);
    }

    #[test]
    fn failed_installed_java_selection_keeps_memory_and_owned_runtime() {
        let fixture = Fixture::new();
        let storage = fixture.storage(false);
        let installed = fixture.root.join("owned-java");
        fs::create_dir(&installed).unwrap();
        fs::write(installed.join("keep-runtime"), b"retained installed bytes").unwrap();
        let expected = storage.settings_for_backend().unwrap();
        // 以夹具专属的目录阻止原子发布快照，不改真实存储或凭据。
        fs::create_dir(fixture.root.join(STATE_FILE)).unwrap();
        assert!(storage.select_installed_java_for_backend(&expected, &installed).is_err());
        assert_eq!(storage.settings_for_backend().unwrap(), expected);
        assert_eq!(fs::read(installed.join("keep-runtime")).unwrap(), b"retained installed bytes");
        for snapshot in [json!(null), json!({}), json!({"javaAutoDetect":"true"}), json!({"javaAutoDetect":true,"javaPath":null})] {
            assert!(storage.select_installed_java_for_backend(&snapshot, &installed).is_err());
        }
        assert!(storage.select_installed_java_for_backend(&expected, Path::new("relative/java")).is_err());
    }

    #[test]
    fn directories_persist_switch_and_remove_without_deleting_content() {
        let fixture = Fixture::new();
        let storage = fixture.storage(false);
        let game = fixture.root.join("other-game");
        fs::create_dir_all(game.join("saves")).unwrap();
        fs::write(game.join("saves").join("keep.txt"), b"world").unwrap();
        let dirs = call(&storage, "versionDirs:add", &[json!({"path":path_string(&game), "alias":"存档"})]);
        let id = dirs[1]["id"].clone();
        assert_eq!(call(&storage, "versionDirs:select", &[id.clone()]), id);
        assert_eq!(storage.active_game_dir().unwrap(), game);
        let removed = call(&storage, "versionDirs:remove", &[id]);
        assert_eq!(removed.as_array().unwrap().len(), 1);
        assert_eq!(call(&storage, "settings:get", &[])["selectedVersionDirId"], "");
        assert_eq!(fs::read(game.join("saves").join("keep.txt")).unwrap(), b"world");
        assert_eq!(call(&storage, "versionDirs:select", &[json!("missing")]), "default");
    }

    #[test]
    fn portable_fields_are_derived_after_every_write() {
        let fixture = Fixture::new();
        let storage = fixture.storage(true);
        let settings = call(&storage, "settings:set", &[json!({"theme":"dark", "gameDir":path_string(&fixture.root)})]);
        assert_eq!(settings["portable"], true);
        assert_eq!(settings["gameDir"], "./.minecraft");
        assert_eq!(settings["gameDirAbs"], json!(path_string(&fixture.root.join("./.minecraft"))));
        let disk: Value = serde_json::from_slice(&fixture.bytes()).unwrap();
        for key in ["portable", "gameDirAbs", "aiApiKeySet", "uapisApiKeySet"] { assert!(disk["settings"].get(key).is_none()); }
    }

    #[test]
    fn invalid_snapshot_and_failed_write_preserve_original() {
        let fixture = Fixture::new();
        let storage = fixture.storage(false);
        call(&storage, "settings:set", &[json!({"theme":"light"})]);
        let before = fixture.bytes();
        let blocked = fixture.root.join("blocked");
        fs::create_dir(&blocked).unwrap();
        assert!(atomic_json(&blocked, &json!({"bad":true})).is_err());
        assert_eq!(fixture.bytes(), before);
        fs::write(fixture.root.join(STATE_FILE), b"{bad json").unwrap();
        assert!(read_state(&fixture.root.join(STATE_FILE)).is_err());
        assert_eq!(fixture.bytes(), b"{bad json");
        // 兼容带 UTF-8 BOM 的快照（外部工具 / 脚本可能写入 BOM；serde_json 本身不接受）。
        let with_bom = [b"\xEF\xBB\xBF", before.as_slice()].concat();
        fs::write(fixture.root.join(STATE_FILE), &with_bom).unwrap();
        let loaded = read_state(&fixture.root.join(STATE_FILE)).unwrap().unwrap();
        assert_eq!(loaded, serde_json::from_slice::<Value>(&before).unwrap());
        let bom_garbage = b"\xEF\xBB\xBF{bad json";
        fs::write(fixture.root.join(STATE_FILE), bom_garbage).unwrap();
        assert!(read_state(&fixture.root.join(STATE_FILE)).is_err());
        fs::write(fixture.root.join(STATE_FILE), &before).unwrap();
        let mut plain: Value = serde_json::from_slice(&before).unwrap();
        plain["settings"]["debugKey"] = json!("FAKE-DO-NOT-STORE");
        assert!(decode_state(plain, &fixture.context(false)).is_err());
    }

    #[test]
    fn settings_and_account_secrets_are_split_before_disk_serialization() {
        let fixture = Fixture::new();
        let mut data = fixture.storage(false).data.into_inner().unwrap();
        data.settings.insert("debugKey".into(), json!("FAKE-DEBUG-KEY"));
        data.settings.insert("multiplayerLobbyPassword".into(), json!("FAKE-LOBBY-PASSWORD"));
        data.accounts.push(json!({
            "id":"0123456789abcdef0123456789abcdef", "name":"Fixture", "offline":false,
            "accessToken":"FAKE-ACCESS", "refreshToken":"FAKE-REFRESH", "clientToken":"FAKE-CLIENT",
            "expiresAt":123456789, "addedAt":123456700,
        }));
        let (disk, secrets) = encode_state(&data).unwrap();
        let bytes = serde_json::to_string(&disk).unwrap();
        for value in ["FAKE-DEBUG-KEY", "FAKE-LOBBY-PASSWORD", "FAKE-ACCESS", "FAKE-REFRESH", "FAKE-CLIENT"] {
            assert!(!bytes.contains(value));
            assert!(secrets.values().any(|secret| secret == value));
        }
        assert_eq!(secrets.len(), 5);
        assert!(public_account(&data.accounts[0]).get("microsoftAuth").is_none());
    }

    #[test]
    fn agreement_migration_accepts_only_32_hex_and_keeps_existing_decisions() {
        let fixture = Fixture::new();
        let storage = fixture.storage(false);
        call(&storage, "settings:set", &[json!({"agreementAcceptedAt":123, "agreementAcceptedVersion":""})]);
        let before = fixture.bytes();
        for version in ["a".repeat(64), "a".repeat(31), "g".repeat(32), String::new()] {
            assert!(storage.migrate_agreement_version_for_backend(&version).is_err());
            assert_eq!(fixture.bytes(), before);
        }
        let version = "0123456789abcdefABCDEF0123456789";
        assert!(storage.migrate_agreement_version_for_backend(version).unwrap());
        assert_eq!(call(&storage, "settings:get", &[])["agreementAcceptedVersion"], version);
        let migrated = fixture.bytes();
        assert!(!storage.migrate_agreement_version_for_backend(&"b".repeat(32)).unwrap());
        assert_eq!(fixture.bytes(), migrated);
        call(&storage, "settings:set", &[json!({"agreementAcceptedAt":0, "agreementAcceptedVersion":""})]);
        let unaccepted = fixture.bytes();
        assert!(!storage.migrate_agreement_version_for_backend(version).unwrap());
        assert_eq!(fixture.bytes(), unaccepted);
        assert_eq!(call(&storage, "settings:get", &[])["agreementAcceptedVersion"], "");
    }

    #[test]
    fn version_rename_commits_all_references_and_preserves_other_settings() {
        let fixture = Fixture::new();
        let storage = fixture.storage(false);
        let java = path_string(&fixture.root.join("runtime").join("java"));
        let fingerprint = "a".repeat(32);
        call(&storage, "settings:set", &[json!({
            "selectedVersionId":"旧实例", "isolatedVersions":["keep", "旧实例"],
            "disabledVersions":["旧实例", "other"], "versionJava":{"旧实例":java, "keep":""},
            "theme":"dark", "agreementAcceptedAt":1, "agreementAcceptedVersion":fingerprint,
        })]);
        storage.commit_version_change_for_backend("旧实例", Some("新实例")).unwrap();
        let settings = call(&storage, "settings:get", &[]);
        assert_eq!(settings["selectedVersionId"], "新实例");
        assert_eq!(settings["isolatedVersions"], json!(["keep", "新实例"]));
        assert_eq!(settings["disabledVersions"], json!(["新实例", "other"]));
        assert_eq!(settings["versionJava"], json!({"新实例":java, "keep":""}));
        assert_eq!(settings["theme"], "dark");
        assert_eq!(settings["agreementAcceptedVersion"], fingerprint);
        let loaded = decode_state(serde_json::from_slice(&fixture.bytes()).unwrap(), &fixture.context(false)).unwrap();
        for key in ["selectedVersionId", "isolatedVersions", "disabledVersions", "versionJava"] {
            assert_eq!(loaded.settings[key], settings[key]);
        }
        assert!(!fixture.root.join("documents").exists());
    }

    #[test]
    fn version_delete_clears_all_old_references_and_is_idempotent() {
        let fixture = Fixture::new();
        let storage = fixture.storage(false);
        call(&storage, "settings:set", &[json!({
            "selectedVersionId":"old", "isolatedVersions":["old", "keep", "old"],
            "disabledVersions":["keep", "old"], "versionJava":{"old":"", "keep":""},
        })]);
        storage.commit_version_change_for_backend("old", None).unwrap();
        let settings = call(&storage, "settings:get", &[]);
        assert_eq!(settings["selectedVersionId"], "");
        assert_eq!(settings["isolatedVersions"], json!(["keep"]));
        assert_eq!(settings["disabledVersions"], json!(["keep"]));
        assert_eq!(settings["versionJava"], json!({"keep":""}));
        let before = fixture.bytes();
        storage.commit_version_change_for_backend("old", None).unwrap();
        assert_eq!(fixture.bytes(), before);
        call(&storage, "settings:set", &[json!({"selectedVersionId":"keep"})]);
        storage.commit_version_change_for_backend("old", None).unwrap();
        assert_eq!(call(&storage, "settings:get", &[])["selectedVersionId"], "keep");
    }

    #[test]
    fn version_rename_rejects_every_target_reference_without_overwriting() {
        let fixture = Fixture::new();
        let storage = fixture.storage(false);
        for conflict in [
            json!({"selectedVersionId":"target"}),
            json!({"isolatedVersions":["old", "target"]}),
            json!({"disabledVersions":["old", "target"]}),
            json!({"versionJava":{"old":"", "target":""}}),
        ] {
            call(&storage, "settings:set", &[json!({
                "selectedVersionId":"old", "isolatedVersions":["old"],
                "disabledVersions":["old"], "versionJava":{"old":""},
            })]);
            call(&storage, "settings:set", &[conflict]);
            let before = fixture.bytes();
            let settings = call(&storage, "settings:get", &[]);
            assert!(storage.commit_version_change_for_backend("old", Some("target")).is_err());
            assert_eq!(fixture.bytes(), before);
            assert_eq!(call(&storage, "settings:get", &[]), settings);
        }
    }

    #[test]
    fn version_invalid_ids_same_name_and_failed_disk_commit_leave_state_unchanged() {
        let fixture = Fixture::new();
        let mut storage = fixture.storage(false);
        call(&storage, "settings:set", &[json!({"selectedVersionId":"old", "versionJava":{"old":""}})]);
        let before = fixture.bytes();
        let settings = call(&storage, "settings:get", &[]);
        for id in ["", ".", "..", "../escape", "a\\b", "a:b", "a\nb", "   "] {
            assert!(storage.commit_version_change_for_backend(id, None).is_err());
            assert!(storage.commit_version_change_for_backend("old", Some(id)).is_err());
        }
        assert!(storage.commit_version_change_for_backend("old", Some(&"a".repeat(513))).is_err());
        storage.commit_version_change_for_backend("old", Some("old")).unwrap();
        assert_eq!(fixture.bytes(), before);
        let blocked = fixture.root.join("blocked-parent");
        fs::write(&blocked, b"keep").unwrap();
        storage.context.root = blocked;
        assert!(storage.commit_version_change_for_backend("old", Some("new")).is_err());
        assert_eq!(fixture.bytes(), before);
        assert_eq!(call(&storage, "settings:get", &[]), settings);
        assert_eq!(fs::read(&storage.context.root).unwrap(), b"keep");
    }

    #[test]
    fn account_batch_commits_selection_and_replacements_together() {
        let fixture = Fixture::new();
        let storage = fixture.storage(false);
        storage.save_accounts_for_backend(vec![]).unwrap();
        assert!(!fixture.root.join(STATE_FILE).exists());
        let first = create_offline("BatchFirst");
        let second = create_offline("BatchSecond");
        storage.save_accounts_for_backend(vec![first.clone(), second.clone()]).unwrap();
        assert_eq!(call(&storage, "accounts:list", &[]).as_array().unwrap().len(), 2);
        assert_eq!(call(&storage, "accounts:selected", &[])["id"], first["id"]);
        call(&storage, "accounts:select", &[second["id"].clone()]);
        let mut updated = first.clone();
        updated["skinModel"] = json!("slim");
        storage.save_accounts_for_backend(vec![updated.clone(), create_offline("BatchThird")]).unwrap();
        assert_eq!(call(&storage, "accounts:selected", &[])["id"], second["id"]);
        // 存档入口会把缺省的凭据字段补成空串；保留完整对象比较，不只检查变更字段。
        let mut expected = updated;
        expected["clientToken"] = json!("");
        assert_eq!(storage.account_for_backend(first["id"].as_str()).unwrap(), Some(expected.clone()));
        let disk: Value = serde_json::from_slice(&fixture.bytes()).unwrap();
        assert_eq!(disk["accounts"].as_array().unwrap().len(), 3);
        assert_eq!(disk["secrets"], json!({}));
        let loaded = decode_state(disk, &fixture.context(false)).unwrap();
        assert_eq!(loaded.accounts.len(), 3);
        assert_eq!(loaded.accounts.iter().find(|account| account["id"] == first["id"]), Some(&expected));
        assert_eq!(loaded.selected.as_deref(), second["id"].as_str());
        storage.save_account(create_offline("BatchLegacyApi")).unwrap();
        assert_eq!(call(&storage, "accounts:list", &[]).as_array().unwrap().len(), 4);
    }

    #[test]
    fn account_batch_prevalidates_all_items_and_canonical_uuid_duplicates() {
        let fixture = Fixture::new();
        let storage = fixture.storage(false);
        storage.save_account(create_offline("KeepAccount")).unwrap();
        let before = fixture.bytes();
        let original = call(&storage, "accounts:list", &[]);
        let online = json!({
            "id":"0123456789abcdef0123456789abcdef", "name":"SyntheticOnly", "offline":false,
            "accessToken":"FAKE-NOT-WRITTEN", "refreshToken":"FAKE-NOT-WRITTEN-REFRESH",
            "expiresAt":123456789, "addedAt":123456700,
        });
        assert!(storage.save_accounts_for_backend(vec![online, json!({"id":"bad"})]).is_err());
        let first = create_offline("Duplicate");
        let mut alias = first.clone();
        alias["id"] = json!(Uuid::parse_str(first["id"].as_str().unwrap()).unwrap().hyphenated().to_string().to_uppercase());
        assert!(storage.save_accounts_for_backend(vec![first, alias]).is_err());
        assert!(storage.save_accounts_for_backend(vec![create_offline("TooMany"); 501]).is_err());
        assert_eq!(fixture.bytes(), before);
        assert_eq!(call(&storage, "accounts:list", &[]), original);
    }

    #[test]
    fn account_batch_checks_final_capacity_and_disk_failure_without_partial_update() {
        let fixture = Fixture::new();
        let mut storage = fixture.storage(false);
        let accounts: Vec<Value> = (0..500).map(|i| create_offline(&format!("Capacity{i}"))).collect();
        storage.save_accounts_for_backend(accounts.clone()).unwrap();
        let before = fixture.bytes();
        let original = call(&storage, "accounts:list", &[]);
        let mut changed = accounts[0].clone();
        changed["skinModel"] = json!("slim");
        assert!(storage.save_accounts_for_backend(vec![changed.clone(), create_offline("Overflow")]).is_err());
        assert_eq!(fixture.bytes(), before);
        assert_eq!(call(&storage, "accounts:list", &[]), original);
        storage.save_accounts_for_backend(vec![changed]).unwrap();
        let before = fixture.bytes();
        let original = call(&storage, "accounts:list", &[]);
        let mut next = accounts[1].clone();
        next["skinModel"] = json!("slim");
        let blocked = fixture.root.join("blocked-batch-parent");
        fs::write(&blocked, b"keep").unwrap();
        storage.context.root = blocked;
        assert!(storage.save_accounts_for_backend(vec![next]).is_err());
        assert_eq!(fixture.bytes(), before);
        assert_eq!(call(&storage, "accounts:list", &[]), original);
    }

    #[test]
    fn secret_batch_failure_cleans_new_refs_and_keeps_old_snapshot_without_keyring() {
        use std::cell::RefCell;
        let fixture = Fixture::new();
        let storage = fixture.storage(false);
        storage.save_account(create_offline("OldSnapshot")).unwrap();
        let before = fixture.bytes();
        let mut next = storage.data.lock().unwrap().clone();
        next.references.insert("api:ai".into(), "old-ref-fixture-only".into());
        let original_refs = next.references.clone();
        let original_committed = next.committed_secrets.clone();
        for id in ["0123456789abcdef0123456789abcdef", "1123456789abcdef0123456789abcdef"] {
            next.accounts.push(validate_account(json!({
                "id":id, "name":"SyntheticOnly", "offline":false, "accessToken":format!("FAKE-{id}"),
                "expiresAt":123456789, "addedAt":123456700,
            })).unwrap());
        }
        let secrets = RefCell::new(BTreeMap::<String, String>::new());
        let deleted = RefCell::new(Vec::<String>::new());
        let mut writes = 0;
        let result = storage.persist_with_credentials(&mut next,
            |reference, value| {
                writes += 1;
                if writes == 2 { return Err("夹具模拟第二项凭据写入失败".into()); }
                secrets.borrow_mut().insert(reference.into(), value.into()); Ok(())
            },
            |reference| { deleted.borrow_mut().push(reference.into()); secrets.borrow_mut().remove(reference); Ok(()) },
        );
        assert!(result.is_err());
        assert_eq!(writes, 2);
        assert!(secrets.borrow().is_empty());
        assert_eq!(deleted.borrow().len(), 1);
        assert!(!deleted.borrow().iter().any(|reference| reference == "old-ref-fixture-only"));
        assert_eq!(next.references, original_refs);
        assert_eq!(next.committed_secrets, original_committed);
        assert_eq!(fixture.bytes(), before);
        assert_eq!(call(&storage, "accounts:list", &[]).as_array().unwrap().len(), 1);
    }

    #[test]
    fn launch_dispatch_checks_full_snapshot_and_does_not_follow_new_selection() {
        use std::sync::atomic::{AtomicBool,Ordering};
        let fixture=Fixture::new();let storage=fixture.storage(false);
        let first=create_offline("LaunchSnapshot");let second=create_offline("LaunchOther");
        storage.save_accounts_for_backend(vec![first.clone(),second.clone()]).unwrap();
        let expected=storage.account_for_backend(first["id"].as_str()).unwrap().unwrap();
        call(&storage,"accounts:select",&[second["id"].clone()]);
        let invoked=AtomicBool::new(false);
        storage.with_unchanged_account_for_launch(&expected,||{invoked.store(true,Ordering::Release);Ok(())}).unwrap();
        assert!(invoked.load(Ordering::Acquire));assert_eq!(call(&storage,"accounts:selected",&[])["id"],second["id"]);
        let mut updated=expected.clone();updated["siteName"]=json!("并发更换登录");storage.save_account(updated).unwrap();
        invoked.store(false,Ordering::Release);
        assert!(storage.with_unchanged_account_for_launch(&expected,||{invoked.store(true,Ordering::Release);Ok(())}).is_err());
        assert!(!invoked.load(Ordering::Acquire));
        call(&storage,"accounts:remove",&[first["id"].clone()]);
        assert!(storage.with_unchanged_account_for_launch(&expected,||{invoked.store(true,Ordering::Release);Ok(())}).is_err());
        assert!(!invoked.load(Ordering::Acquire));
    }

    #[test]
    fn launch_dispatch_and_removal_are_ordered_by_the_same_storage_lock() {
        use std::sync::{Arc,mpsc};
        let fixture=Fixture::new();let storage=Arc::new(fixture.storage(false));
        let account=create_offline("LaunchLocked");storage.save_account(account.clone()).unwrap();
        let expected=storage.account_for_backend(account["id"].as_str()).unwrap().unwrap();
        let (entered_tx,entered_rx)=mpsc::channel();let (release,released)=mpsc::channel();
        let dispatch_storage=storage.clone();let dispatch=std::thread::spawn(move||dispatch_storage.with_unchanged_account_for_launch(&expected,||{
            entered_tx.send(()).unwrap();released.recv().unwrap();Ok(())
        }));
        entered_rx.recv().unwrap();let (trying_tx,trying_rx)=mpsc::channel();let (deleted_tx,deleted_rx)=mpsc::channel();
        let remove_storage=storage.clone();let id=account["id"].clone();
        let removal=std::thread::spawn(move||{trying_tx.send(()).unwrap();let result=remove_storage.call("accounts:remove",&[id]);deleted_tx.send(result).unwrap();});
        trying_rx.recv().unwrap();assert!(matches!(storage.data.try_lock(),Err(std::sync::TryLockError::WouldBlock)));
        assert!(matches!(deleted_rx.try_recv(),Err(mpsc::TryRecvError::Empty)));
        release.send(()).unwrap();dispatch.join().unwrap().unwrap();deleted_rx.recv().unwrap().unwrap();removal.join().unwrap();
        assert!(storage.account_for_backend(account["id"].as_str()).unwrap().is_none());
    }

    #[test]
    fn refreshed_batch_replaces_only_matching_snapshots_and_keeps_selection() {
        let fixture=Fixture::new();let storage=fixture.storage(false);
        let first=create_offline("RefreshFirst");let second=create_offline("RefreshSecond");
        storage.save_accounts_for_backend(vec![first.clone(),second.clone()]).unwrap();
        call(&storage,"accounts:select",&[second["id"].clone()]);
        let first=storage.account_for_backend(first["id"].as_str()).unwrap().unwrap();
        let second=storage.account_for_backend(second["id"].as_str()).unwrap().unwrap();
        let mut changed=first.clone();changed["siteName"]=json!("刷新夹具名称");
        let result=storage.replace_refreshed_accounts_for_backend(vec![first.clone()],vec![changed.clone()]).unwrap();
        assert_eq!(result,vec![changed.clone()]);
        assert_eq!(call(&storage,"accounts:selected",&[])["id"],second["id"]);
        let before=fixture.bytes();
        // 组中任一快照已经改变，不能先写入其它仍匹配的角色。
        let mut next_second=second.clone();next_second["skinModel"]=json!("classic");
        assert!(storage.replace_refreshed_accounts_for_backend(vec![first.clone(),second.clone()],vec![first.clone(),next_second]).is_err());
        assert_eq!(fixture.bytes(),before);
        assert_eq!(storage.account_for_backend(second["id"].as_str()).unwrap(),Some(second.clone()));
        let mut changed_identity=changed.clone();changed_identity["addedAt"]=json!(0);
        if changed["addedAt"]==0 {changed_identity["addedAt"]=json!(1);}
        assert!(storage.replace_refreshed_accounts_for_backend(vec![changed.clone()],vec![changed_identity]).is_err());
        call(&storage,"accounts:remove",&[first["id"].clone()]);
        let before=fixture.bytes();
        assert!(storage.replace_refreshed_accounts_for_backend(vec![changed.clone()],vec![changed]).is_err());
        assert_eq!(fixture.bytes(),before);assert!(storage.account_for_backend(first["id"].as_str()).unwrap().is_none());
    }

    #[test]
    fn concurrent_refresh_snapshots_cannot_overwrite_the_first_committed_result() {
        use std::sync::{Arc,Barrier};
        let fixture=Fixture::new();let storage=Arc::new(fixture.storage(false));
        let original=create_offline("RefreshRace");storage.save_account(original.clone()).unwrap();
        let original=storage.account_for_backend(original["id"].as_str()).unwrap().unwrap();
        let barrier=Arc::new(Barrier::new(3));let mut workers=Vec::new();
        for label in ["刷新夹具甲","刷新夹具乙"] {
            let storage=storage.clone();let barrier=barrier.clone();let expected=original.clone();
            workers.push(std::thread::spawn(move||{
                let mut updated=expected.clone();updated["siteName"]=json!(label);
                barrier.wait();storage.replace_refreshed_accounts_for_backend(vec![expected],vec![updated])
            }));
        }
        barrier.wait();let results:Vec<_>=workers.into_iter().map(|worker|worker.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|result|result.is_ok()).count(),1);
        assert_eq!(results.iter().filter(|result|result.is_err()).count(),1);
        assert_eq!(call(&storage,"accounts:list",&[]).as_array().unwrap().len(),1);
    }

    #[test]
    fn refreshed_ygg_group_rejects_new_matching_roles_and_updates_the_complete_group() {
        let fixture=Fixture::new();let storage=fixture.storage(false);
        let role=|name:&str,server:&str|{let mut value=create_offline(name);value["offline"]=json!(false);value["authType"]=json!("yggdrasil");value["accessToken"]=json!("FAKE-OLD-ACCESS");value["clientToken"]=json!("FAKE-CLIENT");value["yggdrasilServer"]=json!(server);value};
        let first=role("LaunchRoleOne","https://EXAMPLE.invalid/api/yggdrasil/");
        let second=role("LaunchRoleTwo","https://example.invalid/api/yggdrasil");
        fixture.seed_accounts(&storage, vec![first.clone()]);
        let expected=storage.account_for_backend(first["id"].as_str()).unwrap().unwrap();
        // 刷新期间新增同服务器、同 access/client 的角色，不能仅提交旧子集。
        fixture.seed_accounts(&storage, vec![first.clone(), second.clone()]);let before=fixture.bytes();
        let mut changed=expected.clone();changed["accessToken"]=json!("FAKE-ROTATED-ACCESS");
        let no_secret_io=|_:&str,_:&str|Ok(());let no_secret_delete=|_:&str|Ok(());
        assert!(storage.replace_refreshed_accounts_for_backend_with_credentials(vec![expected.clone()],vec![changed.clone()],no_secret_io,no_secret_delete).is_err());assert_eq!(fixture.bytes(),before);
        let second=storage.account_for_backend(second["id"].as_str()).unwrap().unwrap();let mut changed_second=second.clone();changed_second["accessToken"]=json!("FAKE-ROTATED-ACCESS");
        let updated=storage.replace_refreshed_accounts_for_backend_with_credentials(vec![expected,second.clone()],vec![changed.clone(),changed_second],no_secret_io,no_secret_delete).unwrap();assert_eq!(updated.len(),2);
        assert_eq!(storage.account_for_backend(first["id"].as_str()).unwrap().unwrap()["accessToken"],"FAKE-ROTATED-ACCESS");
        // 不同 client 或服务器的角色不属于该次刷新组。
        let mut unrelated=role("LaunchOtherClient","https://example.invalid/api/yggdrasil");unrelated["clientToken"]=json!("FAKE-OTHER-CLIENT");unrelated["accessToken"]=json!("FAKE-ROTATED-ACCESS");
        let first_now=storage.account_for_backend(first["id"].as_str()).unwrap().unwrap();
        let second_now=storage.account_for_backend(second["id"].as_str()).unwrap().unwrap();
        fixture.seed_accounts(&storage, vec![first_now, second_now, unrelated]);
        let current_first=storage.account_for_backend(first["id"].as_str()).unwrap().unwrap();let current_second=storage.account_for_backend(second["id"].as_str()).unwrap().unwrap();
        assert!(storage.replace_refreshed_accounts_for_backend(vec![current_first.clone(),current_second.clone()],vec![current_first,current_second]).is_ok());
    }

    #[test]
    fn refreshed_batch_validation_and_disk_failure_do_not_change_memory_or_snapshot() {
        let fixture=Fixture::new();let mut storage=fixture.storage(false);
        let account=create_offline("RefreshDisk");storage.save_account(account.clone()).unwrap();
        let expected=storage.account_for_backend(account["id"].as_str()).unwrap().unwrap();
        let mut updated=expected.clone();updated["siteName"]=json!("刷新磁盘失败夹具");
        let before=fixture.bytes();
        assert!(storage.replace_refreshed_accounts_for_backend(vec![],vec![]).is_err());
        assert!(storage.replace_refreshed_accounts_for_backend(vec![expected.clone()],vec![create_offline("OtherIdentity")]).is_err());
        assert!(storage.replace_refreshed_accounts_for_backend(vec![expected.clone(),expected.clone()],vec![updated.clone(),updated.clone()]).is_err());
        let blocked=fixture.root.join("refresh-blocked");fs::write(&blocked,b"keep").unwrap();storage.context.root=blocked;
        assert!(storage.replace_refreshed_accounts_for_backend(vec![expected.clone()],vec![updated]).is_err());
        assert_eq!(fixture.bytes(),before);assert_eq!(storage.account_for_backend(account["id"].as_str()).unwrap(),Some(expected));
    }

    #[test]
    fn import_insert_never_overwrites_existing_account_and_preserves_selection() {
        let fixture=Fixture::new();let storage=fixture.storage(false);
        let existing=create_offline("ImportExisting");let first=create_offline("ImportFirst");
        storage.save_accounts_for_backend(vec![existing.clone(),first.clone()]).unwrap();
        call(&storage,"accounts:select",&[first["id"].clone()]);
        let original=storage.account_for_backend(existing["id"].as_str()).unwrap();
        let mut incoming=existing.clone();incoming["skinModel"]=json!("slim");
        let added=create_offline("ImportAdded");
        let result=storage.insert_import_accounts_for_backend(vec![incoming,added.clone()]).unwrap();
        assert_eq!((result.inserted,result.skipped),(1,1));
        assert_eq!(storage.account_for_backend(existing["id"].as_str()).unwrap(),original);
        assert_eq!(call(&storage,"accounts:selected",&[])["id"],first["id"]);
        let before=fixture.bytes();
        let result=storage.insert_import_accounts_for_backend(vec![added]).unwrap();
        assert_eq!((result.inserted,result.skipped),(0,1));assert_eq!(fixture.bytes(),before);
    }

    #[test]
    fn import_insert_is_atomic_on_invalid_input_capacity_and_disk_failure() {
        let fixture=Fixture::new();let mut storage=fixture.storage(false);
        let existing=create_offline("ImportKeep");storage.save_account(existing.clone()).unwrap();
        let before=fixture.bytes();let original=call(&storage,"accounts:list",&[]);
        assert!(storage.insert_import_accounts_for_backend(vec![create_offline("ImportValid"),json!({"id":"bad"})]).is_err());
        assert_eq!(fixture.bytes(),before);assert_eq!(call(&storage,"accounts:list",&[]),original);
        let blocked=fixture.root.join("import-blocked");fs::write(&blocked,b"keep").unwrap();storage.context.root=blocked;
        assert!(storage.insert_import_accounts_for_backend(vec![create_offline("ImportFail")]).is_err());
        assert_eq!(fixture.bytes(),before);assert_eq!(call(&storage,"accounts:list",&[]),original);
        // 只有重复项时不尝试持久化，不会因不可写路径改掉已有账号。
        let result=storage.insert_import_accounts_for_backend(vec![existing]).unwrap();assert_eq!((result.inserted,result.skipped),(0,1));
        let full_fixture=Fixture::new();let full=full_fixture.storage(false);
        full.save_accounts_for_backend((0..500).map(|i|create_offline(&format!("ImportCapacity{i}"))).collect()).unwrap();
        let before=full_fixture.bytes();assert!(full.insert_import_accounts_for_backend(vec![create_offline("ImportOverflow")]).is_err());assert_eq!(full_fixture.bytes(),before);
    }

    #[test]
    fn concurrent_imports_recheck_duplicate_under_the_storage_lock() {
        use std::sync::{Arc,Barrier};
        let fixture=Fixture::new();let storage=Arc::new(fixture.storage(false));let barrier=Arc::new(Barrier::new(3));
        let mut threads=Vec::new();
        for model in ["classic","slim"] {
            let storage=storage.clone();let barrier=barrier.clone();
            threads.push(std::thread::spawn(move||{
                let mut account=create_offline("ImportRace");account["skinModel"]=json!(model);
                barrier.wait();storage.insert_import_accounts_for_backend(vec![account]).unwrap()
            }));
        }
        barrier.wait();let results:Vec<_>=threads.into_iter().map(|thread|thread.join().unwrap()).collect();
        assert_eq!(results.iter().map(|result|result.inserted).sum::<usize>(),1);
        assert_eq!(results.iter().map(|result|result.skipped).sum::<usize>(),1);
        assert_eq!(call(&storage,"accounts:list",&[]).as_array().unwrap().len(),1);
        assert_eq!(call(&storage,"accounts:selected",&[])["id"],create_offline("ImportRace")["id"]);
    }

    #[test]
    fn settings_snapshot_closure_serializes_directory_policy_changes() {
        use std::sync::{mpsc, Arc};
        use std::time::Duration;

        let fixture = Fixture::new();
        let storage = Arc::new(fixture.storage(false));
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let reader = {
            let storage = storage.clone();
            std::thread::spawn(move || {
                storage.with_settings_for_backend(|settings| {
                    entered_tx.send(settings["versionIsolation"].clone()).unwrap();
                    release_rx.recv().unwrap();
                    settings["versionIsolation"].clone()
                }).unwrap()
            })
        };
        assert_eq!(entered_rx.recv().unwrap(), json!(false));

        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let writer = {
            let storage = storage.clone();
            std::thread::spawn(move || {
                started_tx.send(()).unwrap();
                let result = storage.call("settings:set", &[json!({"versionIsolation":true})]);
                done_tx.send(result).unwrap();
            })
        };
        started_rx.recv().unwrap();
        assert!(done_rx.recv_timeout(Duration::from_millis(20)).is_err());
        release_tx.send(()).unwrap();
        assert_eq!(reader.join().unwrap(), json!(false));
        assert!(done_rx.recv().unwrap().is_ok());
        writer.join().unwrap();
        assert_eq!(storage.settings_for_backend().unwrap()["versionIsolation"], json!(true));
    }

    #[test]
    fn devmode_public_patch_rejects_only_five_fields_and_internal_loading_still_works() {
        let fixture=Fixture::new(); let storage=fixture.storage(false);
        call(&storage,"settings:set",&[json!({"theme":"dark"})]); let before=fixture.bytes();
        for (name,value) in [("devModeGrantedUntil",json!(123)),("devModeToken",json!("a".repeat(64))),
            ("devModeEmailMasked",json!("a***@example.invalid")),("devModeEnabled",json!(true)),("devModeSecurityMode",json!("off"))] {
            let mut patch=Map::new(); patch.insert(name.into(), value); patch.insert("theme".into(), json!("light"));
            assert!(storage.call("settings:set",&[Value::Object(patch)]).is_err()); assert_eq!(fixture.bytes(),before);
        }
        // 内部加载仍接受合法非秘密字段，公开入口守卫不污染 apply_settings。
        let mut disk:Value=serde_json::from_slice(&before).unwrap();
        disk["settings"]["devModeSecurityMode"]=json!("warn");disk["settings"]["devModeGrantedUntil"]=json!(123);
        let loaded=decode_state(disk,&fixture.context(false)).unwrap();
        assert_eq!(loaded.settings["devModeSecurityMode"],"warn");
        assert_eq!(loaded.settings["devModeGrantedUntil"],123);
        call(&storage,"settings:set",&[json!({"debugMode":true,"theme":"light"})]);
        assert_eq!(call(&storage,"settings:get",&[])["debugMode"],true);
    }

    #[test]
    fn devmode_internal_grant_uses_real_token_snapshot_and_atomic_secret_projection() {
        let fixture=Fixture::new();let storage=fixture.storage(false);
        call(&storage,"settings:set",&[json!({"theme":"dark"})]);
        let expected=storage.devmode_snapshot_for_backend().unwrap(); let permit=crate::devmode::fixture_permit();
        let token="a".repeat(64); let mut saved_secrets=BTreeMap::new();
        let saved=storage.devmode_update_with(&expected,DevModeChange::Grant{token:token.clone(),expires_at:now_ms()+60_000,email_masked:"a***@example.invalid".into()},&permit,
            |reference,value|{saved_secrets.insert(reference.to_owned(),value.to_owned());Ok(())}, |_|Ok(())).unwrap();
        assert_eq!(saved.token,token);assert!(saved.enabled);assert_eq!(saved_secrets.len(),1);
        let disk:Value=serde_json::from_slice(&fixture.bytes()).unwrap();
        assert_eq!(disk["settings"]["devModeToken"],"");assert_eq!(disk["secrets"].as_object().unwrap().len(),1);
        let public=call(&storage,"settings:get",&[]);assert_eq!(public["devModeToken"],"");assert_eq!(public["theme"],"dark");
        let updated=storage.devmode_update_with(&saved,DevModeChange::Security("off".into()),&permit,|_,_|panic!("不应重写未变秘密"), |_|Ok(())).unwrap();
        assert_eq!(updated.token,token);assert_eq!(updated.security_mode,"off");
        assert!(storage.devmode_update_with(&saved,DevModeChange::Disable,&permit,|_,_|Ok(()),|_|Ok(())).is_err());
        let cleared=storage.devmode_update_with(&updated,DevModeChange::Clear,&permit,|_,_|panic!("清理不写秘密"), |_|Ok(())).unwrap();
        assert!(cleared.token.is_empty());assert!(!cleared.enabled);assert_eq!(cleared.security_mode,"off");
    }

    #[test]
    fn devmode_epoch_during_credential_write_rolls_back_new_secret_without_publishing() {
        let fixture=Fixture::new();let storage=fixture.storage(false);call(&storage,"settings:set",&[json!({"theme":"dark"})]);
        let before=fixture.bytes();let expected=storage.devmode_snapshot_for_backend().unwrap();let permit=crate::devmode::fixture_permit();let mut removed=0;
        let result=storage.devmode_update_with(&expected,DevModeChange::Grant{token:"b".repeat(64),expires_at:now_ms()+60_000,email_masked:"b***@example.invalid".into()},&permit,
            |_,_|{crate::devmode::fixture_invalidate(&permit);Ok(())}, |_|{removed+=1;Ok(())});
        assert!(result.is_err());assert_eq!(removed,1);assert_eq!(fixture.bytes(),before);
        assert_eq!(storage.devmode_snapshot_for_backend().unwrap().token,"");
    }

    #[test]
    fn devmode_failed_secret_or_disk_commit_and_mode_aba_preserve_previous_snapshot() {
        let fixture=Fixture::new();let mut storage=fixture.storage(false);call(&storage,"settings:set",&[json!({"theme":"dark"})]);
        let original=storage.devmode_snapshot_for_backend().unwrap();let before=fixture.bytes();let permit=crate::devmode::fixture_permit();
        let change=||DevModeChange::Grant{token:"c".repeat(64),expires_at:now_ms()+60_000,email_masked:"c***@example.invalid".into()};
        assert!(storage.devmode_update_with(&original,change(),&permit,|_,_|Err("注入凭据失败".into()),|_|Ok(())).is_err());
        assert_eq!(fixture.bytes(),before);assert_eq!(storage.devmode_snapshot_for_backend().unwrap().token,"");
        call(&storage,"settings:set",&[json!({"mode":"local"})]);call(&storage,"settings:set",&[json!({"mode":"normal"})]);
        assert!(storage.devmode_update_with(&original,change(),&permit,|_,_|panic!("旧纪元不应写秘密"),|_|Ok(())).is_err());
        let latest=storage.devmode_snapshot_for_backend().unwrap();let before=fixture.bytes();
        let blocked=fixture.root.join("devmode-blocked");fs::write(&blocked,b"keep").unwrap();storage.context.root=blocked;let mut removed=0;
        assert!(storage.devmode_update_with(&latest,change(),&permit,|_,_|Ok(()),|_|{removed+=1;Ok(())}).is_err());
        assert_eq!(removed,1);assert_eq!(fixture.bytes(),before);assert_eq!(storage.devmode_snapshot_for_backend().unwrap().token,"");
    }

    #[test]
    fn unknown_channels_and_paths_fail_without_side_effects() {
        let fixture = Fixture::new();
        let storage = fixture.storage(false);
        assert_eq!(storage.call("not-storage:action", &[]).unwrap(), None);
        assert_eq!(storage.call("ai:setKey", &[json!("FAKE")]).unwrap(), None);
        assert!(storage.call("settings:get", &[Value::Null]).is_err());
        assert!(storage.call("versionDirs:add", &[json!({"path":"relative/world"})]).is_err());
        assert!(storage.call("accounts:select", &[json!("not-a-uuid")]).is_err());
        assert!(!fixture.root.join(STATE_FILE).exists());
    }
}

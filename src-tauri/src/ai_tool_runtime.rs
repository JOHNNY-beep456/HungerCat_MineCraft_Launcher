//! AI 工具的纯校验与授权状态层。
//!
//! 本模块不访问网络、文件系统、进程或 Storage；业务执行由上层编排器负责。
//! 它只提供 13 项工具声明、严格参数规范化，以及绑定目录/参数的单次授权快照。
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{collections::{HashMap, HashSet}, path::{Component, Path, PathBuf}, sync::Mutex};

/// 危险操作必须逐次取得用户明确确认；策略层不能把 Dangerous 降级为免确认。
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolRisk {
    Safe,
    Dangerous,
}

/// 给模型和设置页使用的工具声明。字段名保持原 TypeScript `AiToolSpec` 契约。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ToolSpec {
    pub name: String,
    pub title: String,
    pub risk: ToolRisk,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
}

/// provider 层归一化后的工具意图；不包含任何执行结果或审批状态。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ToolIntent {
    /// 厂商返回的 tool call id；为空、过长或含控制字符均拒绝。
    pub provider_call_id: String,
    pub name: String,
    /// 已严格校验且已应用内部默认值的 JSON object。
    pub args: Value,
}

/// 工具执行层回灌给模型的最小结果，不是前端 `AiChatResult`。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ToolExecution {
    pub ok: bool,
    pub text: String,
}

impl ToolExecution {
    pub fn success(text: impl Into<String>) -> Self { Self { ok: true, text: text.into() } }
    pub fn failure(text: impl Into<String>) -> Self { Self { ok: false, text: text.into() } }
}

impl ToolIntent {
    /// 仅提供给可信 provider 解析层；调用前仍必须通过 validate_intent。
    pub fn new(provider_call_id: impl Into<String>, name: impl Into<String>, args: &Value) -> Result<Self, String> {
        let provider_call_id = provider_call_id.into();
        let name = name.into();
        validate_intent(&provider_call_id, &name, args)
    }

    pub fn risk(&self) -> Result<ToolRisk, String> {
        spec_for(&self.name).map(|spec| spec.risk).ok_or_else(|| "未知工具".into())
    }
}

/// 危险确认的绑定快照。执行前必须以当前状态重新校验全部绑定字段。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApprovalSnapshot {
    request_id: String,
    chat_id: String,
    provider_call_id: String,
    name: String,
    canonical_args: Value,
    game_dir: PathBuf,
    selected_dir_id: String,
    issued_at_ms: u64,
    expires_at_ms: u64,
}

pub const APPROVAL_TTL_MS: u64 = 180_000;
const MAX_ID_BYTES: usize = 256;
const MAX_OFFLINE_NAME_CHARS: usize = 16;
const MAX_INSTANCE_NAME_CHARS: usize = 256;
const MAX_QUERY_CHARS: usize = 4096;
const MAX_PATH_CHARS: usize = 32_768;

/// 调用方负责在快照创建前解析真实目录；本层只做纯词法校验，不访问文件系统。
fn valid_game_dir(path: &Path) -> bool {
    path.is_absolute() && !path.components().any(|part| matches!(part, Component::ParentDir | Component::CurDir))
}

fn valid_id(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > MAX_ID_BYTES || value.chars().any(char::is_control) {
        return Err(format!("{label}无效"));
    }
    Ok(())
}

fn valid_selected_dir_id(value: &str) -> Result<(), String> {
    // 原设置用空串表示默认目录，必须按原值绑定，不能错误地拒绝或改写为 default。
    if value.len() > MAX_ID_BYTES || value.chars().any(char::is_control) || (!value.is_empty() && value.trim().is_empty()) {
        return Err("版本目录 id 无效".into());
    }
    Ok(())
}

fn required_string(object: &Map<String, Value>, key: &str, max_chars: usize) -> Result<String, String> {
    let value = object.get(key).ok_or_else(|| format!("缺少参数 {key}"))?;
    let text = value.as_str().ok_or_else(|| format!("参数 {key} 必须是字符串"))?;
    if text.trim().is_empty() || text.chars().count() > max_chars || text.chars().any(char::is_control) {
        return Err(format!("参数 {key} 无效"));
    }
    Ok(text.trim().to_owned())
}

fn optional_string(object: &Map<String, Value>, key: &str, max_chars: usize) -> Result<Option<String>, String> {
    let Some(value) = object.get(key) else { return Ok(None) };
    let text = value.as_str().ok_or_else(|| format!("参数 {key} 必须是字符串"))?;
    if text.chars().count() > max_chars || text.chars().any(char::is_control) {
        return Err(format!("参数 {key} 无效"));
    }
    let text = text.trim();
    Ok((!text.is_empty()).then(|| text.to_owned()))
}

fn enum_string(object: &Map<String, Value>, key: &str, allowed: &[&str]) -> Result<Option<String>, String> {
    let Some(value) = object.get(key) else { return Ok(None) };
    let text = value.as_str().ok_or_else(|| format!("参数 {key} 必须是字符串"))?;
    if !allowed.contains(&text) { return Err(format!("参数 {key} 的值不受支持")); }
    Ok(Some(text.to_owned()))
}

fn object_args(args: &Value) -> Result<&Map<String, Value>, String> {
    args.as_object().ok_or_else(|| "工具参数必须是 JSON 对象".to_owned())
}

fn reject_unknown(object: &Map<String, Value>, allowed: &[&str]) -> Result<(), String> {
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("工具参数包含未声明字段".into());
    }
    Ok(())
}

fn schema(properties: Value, required: &[&str]) -> Value {
    let mut out = serde_json::json!({
        "type": "object",
        "properties": properties,
        "additionalProperties": false
    });
    if !required.is_empty() { out["required"] = serde_json::json!(required); }
    out
}

fn string_schema(description: &str) -> Value {
    serde_json::json!({"type":"string", "description":description})
}

fn spec(name: &str, title: &str, risk: ToolRisk, description: &str, input_schema: Value) -> ToolSpec {
    ToolSpec { name: name.into(), title: title.into(), risk, description: description.into(), input_schema }
}

/// 原 TS `AI_TOOLS` 的 13 项声明，顺序保持设置页展示顺序。
pub fn specs() -> Vec<ToolSpec> {
    let resource_type = serde_json::json!({"type":"string","enum":["mod","resourcepack","shader"],"description":"资源类型：mod 模组 / resourcepack 资源包 / shader 光影，默认 mod"});
    vec![
        spec("launcher_list_versions", "查询已安装实例", ToolRisk::Safe, "列出当前已安装的所有 Minecraft 实例（版本 id、是否隔离、存档数）。不需要参数。", schema(serde_json::json!({}), &[])),
        spec("launcher_list_accounts", "查询账号列表", ToolRisk::Safe, "列出启动器里已登录的账号（名称、类型、当前选中项）。不要输出任何令牌或密码。", schema(serde_json::json!({}), &[])),
        spec("launcher_get_status", "查询启动器状态", ToolRisk::Safe, "查询游戏是否正在运行、当前游戏目录、以及是否开启了版本隔离。", schema(serde_json::json!({}), &[])),
        spec("launcher_create_offline_account", "新建离线账号", ToolRisk::Safe, "新建一个离线（免登录、仅单机可用）账号，并把它设为当前账号。名字会作为游戏内昵称，1–16 个字符；已存在同名账号时会被拒绝。", schema(serde_json::json!({"name":string_schema("离线账号名（游戏内昵称，1–16 个字符）")}), &["name"])),
        spec("launcher_delete_account", "删除账号", ToolRisk::Dangerous, "从启动器里删除一个账号（按 id 或完全同名的账号名指定）。只移除本地登录状态，不影响该账号在服务器上的数据，也不删除存档。不可撤销。", schema(serde_json::json!({"account":string_schema("账号 id 或完全同名的账号名（先查 launcher_list_accounts）")}), &["account"])),
        spec("launcher_launch_version", "启动游戏实例", ToolRisk::Safe, "用当前选中的账号启动指定实例。会像用户自己点「启动」一样走完整流程（含补全文件）。", schema(serde_json::json!({"versionId":string_schema("要启动的实例 id（来自 launcher_list_versions）")}), &["versionId"])),
        spec("launcher_stop_game", "结束游戏进程", ToolRisk::Safe, "结束当前正在运行的游戏进程。没有运行时返回相应说明。", schema(serde_json::json!({}), &[])),
        spec("launcher_delete_version", "删除实例", ToolRisk::Dangerous, "彻底删除一个已安装实例（含该实例版本目录、natives、以及隔离时的存档与模组）。不可恢复。", schema(serde_json::json!({"versionId":string_schema("要删除的实例 id（务必与用户确认过）")}), &["versionId"])),
        spec("launcher_list_mods", "查询实例模组", ToolRisk::Safe, "列出某个实例的模组文件名，用于在删除前确认目标。", schema(serde_json::json!({"versionId":string_schema("实例 id")}), &["versionId"])),
        spec("launcher_search_resources", "搜索资源（模组 / 资源包 / 光影）", ToolRisk::Safe, "在 Modrinth / CurseForge 上按关键词搜索资源，返回项目 slug、标题、下载量与是否可下载。装之前先用它找到正确的项目。", schema(serde_json::json!({"query":string_schema("搜索关键词，例如「小地图」「Iris」"),"type":resource_type.clone(),"gameVersion":string_schema("可选：只保留适配某个 MC 版本的结果，例如 1.20.1"),"loader":string_schema("可选：只保留适配某个加载器的结果，例如 fabric / forge / neoforge / quilt")}), &["query"])),
        spec("launcher_install_resource", "下载并安装资源", ToolRisk::Dangerous, "把 Modrinth / CurseForge 上的一个资源下载并安装进指定实例（模组进 mods，资源包进 resourcepacks，光影进 shaderpacks）。会按实例的 MC 版本与加载器挑选文件；只下载允许分发的文件。", schema(serde_json::json!({"versionId":string_schema("目标实例 id（来自 launcher_list_versions）"),"project":string_schema("项目 slug 或 id（来自 launcher_search_resources）"),"type":resource_type.clone(),"source":{"type":"string","enum":["modrinth","curseforge"],"description":"来源；不传则先试 Modrinth，没结果再兜底 CurseForge"}}), &["versionId", "project"])),
        spec("launcher_delete_path", "删除游戏目录内的文件 / 文件夹", ToolRisk::Dangerous, "删除当前游戏目录内的某个文件或文件夹（模组、资源包、存档等）。路径必须是游戏目录内的绝对路径；越界会被拒绝。不可恢复。", schema(serde_json::json!({"path":string_schema("要删除的绝对路径，必须位于当前游戏目录内")}), &["path"])),
        spec("launcher_rename_version", "重命名实例", ToolRisk::Dangerous, "修改实例名称（同时改目录名与 JSON 内的 id）。会影响依赖旧名字的快捷方式 / 配置。", schema(serde_json::json!({"versionId":string_schema("原实例 id"),"newName":string_schema("新名称")}), &["versionId", "newName"])),
    ]
}

/// 供服务层直接返回的 JSON tool list；不是 `AiChatResult`。
pub fn specs_value() -> Value {
    Value::Array(specs().into_iter().map(|item| serde_json::to_value(item).expect("ToolSpec 可序列化")).collect())
}

fn spec_for(name: &str) -> Option<ToolSpec> { specs().into_iter().find(|item| item.name == name) }

/// 严格检查模型工具调用参数，并应用与原 TS 相同的默认资源类型。
/// `confirmed` 等模型伪造的确认字段不会被接受，确认只能来自 `ApprovalState::decide`。
pub fn validate_intent(provider_call_id: &str, name: &str, args: &Value) -> Result<ToolIntent, String> {
    valid_id(provider_call_id, "provider 工具调用 id")?;
    let object = object_args(args)?;
    let spec = spec_for(name).ok_or_else(|| format!("未知工具：{name}"))?;
    let allowed: Vec<&str> = match name {
        "launcher_list_versions" | "launcher_list_accounts" | "launcher_get_status" | "launcher_stop_game" => vec![],
        "launcher_create_offline_account" => vec!["name"],
        "launcher_delete_account" => vec!["account"],
        "launcher_launch_version" | "launcher_delete_version" | "launcher_list_mods" => vec!["versionId"],
        "launcher_search_resources" => vec!["query", "type", "gameVersion", "loader"],
        "launcher_install_resource" => vec!["versionId", "project", "type", "source"],
        "launcher_delete_path" => vec!["path"],
        "launcher_rename_version" => vec!["versionId", "newName"],
        _ => return Err(format!("未知工具：{name}")),
    };
    reject_unknown(object, &allowed)?;
    let mut normalized = Map::new();
    match name {
        "launcher_list_versions" | "launcher_list_accounts" | "launcher_get_status" | "launcher_stop_game" => {}
        "launcher_create_offline_account" => { normalized.insert("name".into(), Value::String(required_string(object, "name", MAX_OFFLINE_NAME_CHARS)?)); }
        "launcher_delete_account" => { normalized.insert("account".into(), Value::String(required_string(object, "account", MAX_ID_BYTES)?)); }
        "launcher_launch_version" | "launcher_delete_version" | "launcher_list_mods" => { normalized.insert("versionId".into(), Value::String(required_string(object, "versionId", MAX_ID_BYTES)?)); }
        "launcher_search_resources" => {
            normalized.insert("query".into(), Value::String(required_string(object, "query", MAX_QUERY_CHARS)?));
            normalized.insert("type".into(), Value::String(enum_string(object, "type", &["mod", "resourcepack", "shader"])?.unwrap_or_else(|| "mod".into())));
            for key in ["gameVersion", "loader"] { if let Some(value) = optional_string(object, key, 256)? { normalized.insert(key.into(), Value::String(value)); } }
        }
        "launcher_install_resource" => {
            normalized.insert("versionId".into(), Value::String(required_string(object, "versionId", MAX_ID_BYTES)?));
            normalized.insert("project".into(), Value::String(required_string(object, "project", MAX_ID_BYTES)?));
            normalized.insert("type".into(), Value::String(enum_string(object, "type", &["mod", "resourcepack", "shader"])?.unwrap_or_else(|| "mod".into())));
            if let Some(value) = enum_string(object, "source", &["modrinth", "curseforge"])? { normalized.insert("source".into(), Value::String(value)); }
        }
        "launcher_delete_path" => {
            let value = required_string(object, "path", MAX_PATH_CHARS)?;
            if !Path::new(&value).is_absolute() { return Err("path 必须是绝对路径".into()); }
            normalized.insert("path".into(), Value::String(value));
        }
        "launcher_rename_version" => {
            normalized.insert("versionId".into(), Value::String(required_string(object, "versionId", MAX_ID_BYTES)?));
            normalized.insert("newName".into(), Value::String(required_string(object, "newName", MAX_INSTANCE_NAME_CHARS)?));
        }
        _ => unreachable!(),
    }
    debug_assert_eq!(spec.name, name);
    Ok(ToolIntent { provider_call_id: provider_call_id.into(), name: name.into(), args: Value::Object(normalized) })
}

fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut keys: Vec<&String> = object.keys().collect(); keys.sort();
            let mut out = Map::new();
            for key in keys { out.insert(key.clone(), canonical(&object[key])); }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        _ => value.clone(),
    }
}

impl ApprovalSnapshot {
    pub fn new(request_id: &str, chat_id: &str, intent: &ToolIntent, game_dir: &Path, selected_dir_id: &str, now_ms: u64) -> Result<Self, String> {
        valid_id(request_id, "审批请求 id")?;
        valid_id(chat_id, "对话 id")?;
        valid_selected_dir_id(selected_dir_id)?;
        let normalized = validate_intent(&intent.provider_call_id, &intent.name, &intent.args)?;
        if normalized != *intent { return Err("只有已规范化的有效工具调用可建立审批快照".into()); }
        // 安全工具也可能被用户设置为 ask，因此允许它们使用相同的审批绑定。
        if !valid_game_dir(game_dir) { return Err("游戏目录必须是已解析的绝对路径".into()); }
        let expires_at_ms = now_ms.checked_add(APPROVAL_TTL_MS).ok_or("审批有效期溢出")?;
        let snapshot = Self { request_id: request_id.into(), chat_id: chat_id.into(), provider_call_id: intent.provider_call_id.clone(), name: intent.name.clone(), canonical_args: canonical(&intent.args), game_dir: game_dir.to_path_buf(), selected_dir_id: selected_dir_id.into(), issued_at_ms: now_ms, expires_at_ms };
        snapshot.validate_integrity()?;
        Ok(snapshot)
    }

    fn validate_integrity(&self) -> Result<(), String> {
        valid_id(&self.request_id, "审批请求 id")?;
        valid_id(&self.chat_id, "对话 id")?;
        valid_selected_dir_id(&self.selected_dir_id)?;
        if !valid_game_dir(&self.game_dir) || self.expires_at_ms.checked_sub(self.issued_at_ms) != Some(APPROVAL_TTL_MS) {
            return Err("审批快照结构无效".into());
        }
        let intent = validate_intent(&self.provider_call_id, &self.name, &self.canonical_args)?;
        if canonical(&intent.args) != self.canonical_args {
            return Err("审批快照工具或参数无效".into());
        }
        Ok(())
    }

    pub fn validate(&self, current_chat_id: &str, intent: &ToolIntent, current_game_dir: &Path, current_selected_dir_id: &str, now_ms: u64) -> Result<(), String> {
        self.validate_integrity()?;
        if now_ms < self.issued_at_ms || now_ms >= self.expires_at_ms { return Err("工具审批已过期或时钟无效，请重新确认".into()); }
        let normalized = validate_intent(&intent.provider_call_id, &intent.name, &intent.args)?;
        if normalized != *intent || self.chat_id != current_chat_id || self.name != intent.name || self.provider_call_id != intent.provider_call_id || self.canonical_args != canonical(&intent.args) { return Err("工具参数、调用身份或对话已变化，审批失效".into()); }
        if self.selected_dir_id != current_selected_dir_id || self.game_dir != current_game_dir { return Err("游戏目录或选中目录已变化，审批失效".into()); }
        Ok(())
    }

    pub fn request_id(&self) -> &str { &self.request_id }
    pub fn chat_id(&self) -> &str { &self.chat_id }
    pub fn intent_name(&self) -> &str { &self.name }
    pub fn args(&self) -> &Value { &self.canonical_args }
    pub fn provider_call_id(&self) -> &str { &self.provider_call_id }
    pub fn expires_at_ms(&self) -> u64 { self.expires_at_ms }
}

#[derive(Default)]
struct ApprovalData {
    pending: HashMap<String, ApprovalSnapshot>,
    // 在本状态实例生命周期内记住所有 id，取消/清空也不能复用旧确认。
    seen: HashSet<String>,
}

/// 推荐每轮聊天持有一个实例。最多 64 个待审批、4096 个累计请求；达到上限后拒绝。
#[derive(Default)]
pub struct ApprovalState {
    data: Mutex<ApprovalData>,
}

impl ApprovalState {
    pub fn insert(&self, snapshot: ApprovalSnapshot, now_ms: u64) -> Result<(), String> {
        snapshot.validate_integrity()?;
        if snapshot.issued_at_ms > now_ms || now_ms >= snapshot.expires_at_ms { return Err("不能加入已失效的工具审批".into()); }
        let mut data = self.data.lock().map_err(|_| "工具审批状态不可用".to_owned())?;
        data.pending.retain(|_, value| value.expires_at_ms > now_ms);
        if data.seen.contains(&snapshot.request_id) { return Err("审批请求 id 已使用，不能重放".into()); }
        if data.pending.len() >= 64 || data.seen.len() >= 4096 { return Err("工具审批请求过多".into()); }
        data.seen.insert(snapshot.request_id.clone());
        data.pending.insert(snapshot.request_id.clone(), snapshot);
        Ok(())
    }

    /// 决策是单次消费：无论批准、拒绝、过期或绑定不匹配，记录都会先移除，防止重放。
    pub fn decide(&self, request_id: &str, approved: bool, current_chat_id: &str, intent: &ToolIntent, current_game_dir: &Path, current_selected_dir_id: &str, now_ms: u64) -> Result<Option<ApprovalSnapshot>, String> {
        let snapshot = self.data.lock().map_err(|_| "工具审批状态不可用".to_owned())?.pending.remove(request_id).ok_or("工具审批不存在、已消费或已取消")?;
        if !approved { return Ok(None); }
        snapshot.validate(current_chat_id, intent, current_game_dir, current_selected_dir_id, now_ms)?;
        Ok(Some(snapshot))
    }

    pub fn cancel(&self, request_id: &str) -> Result<bool, String> {
        Ok(self.data.lock().map_err(|_| "工具审批状态不可用".to_owned())?.pending.remove(request_id).is_some())
    }

    /// 清理取消的聊天；历史请求 id 仍不可再次使用。
    pub fn clear(&self) -> Result<(), String> {
        self.data.lock().map_err(|_| "工具审批状态不可用".to_owned())?.pending.clear();
        Ok(())
    }

    pub fn len(&self) -> Result<usize, String> {
        Ok(self.data.lock().map_err(|_| "工具审批状态不可用".to_owned())?.pending.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn declares_thirteen_tools_and_five_dangerous() {
        let list = specs();
        assert_eq!(list.len(), 13);
        assert_eq!(list.iter().filter(|s| s.risk == ToolRisk::Dangerous).count(), 5);
        assert!(list.iter().all(|s| s.input_schema["additionalProperties"] == false));
    }

    #[test]
    fn all_thirteen_names_risks_and_argument_shapes_match_contract() {
        let expected = [
            ("launcher_list_versions", ToolRisk::Safe, serde_json::json!({})),
            ("launcher_list_accounts", ToolRisk::Safe, serde_json::json!({})),
            ("launcher_get_status", ToolRisk::Safe, serde_json::json!({})),
            ("launcher_create_offline_account", ToolRisk::Safe, serde_json::json!({"name":"Kitty"})),
            ("launcher_delete_account", ToolRisk::Dangerous, serde_json::json!({"account":"id-1"})),
            ("launcher_launch_version", ToolRisk::Safe, serde_json::json!({"versionId":"1.20.1"})),
            ("launcher_stop_game", ToolRisk::Safe, serde_json::json!({})),
            ("launcher_delete_version", ToolRisk::Dangerous, serde_json::json!({"versionId":"1.20.1"})),
            ("launcher_list_mods", ToolRisk::Safe, serde_json::json!({"versionId":"1.20.1"})),
            ("launcher_search_resources", ToolRisk::Safe, serde_json::json!({"query":"Iris"})),
            ("launcher_install_resource", ToolRisk::Dangerous, serde_json::json!({"versionId":"1.20.1","project":"iris"})),
            ("launcher_delete_path", ToolRisk::Dangerous, serde_json::json!({"path":std::env::temp_dir().join("mods").to_string_lossy()})),
            ("launcher_rename_version", ToolRisk::Dangerous, serde_json::json!({"versionId":"old","newName":"new"})),
        ];
        let list = specs();
        assert_eq!(list.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), expected.iter().map(|(name, _, _)| *name).collect::<Vec<_>>());
        for (spec, (name, risk, args)) in list.iter().zip(expected.iter()) {
            assert_eq!(&spec.risk, risk, "risk mismatch for {name}");
            assert!(spec.input_schema["additionalProperties"] == false);
            assert!(validate_intent("provider-call", name, args).is_ok(), "valid args rejected for {name}");
            assert_eq!(specs_value()[list.iter().position(|entry| entry.name == *name).unwrap()]["name"], *name);
        }
        assert_eq!(ToolExecution::success("ok"), ToolExecution { ok: true, text: "ok".into() });
        assert_eq!(ToolExecution::failure("no"), ToolExecution { ok: false, text: "no".into() });
    }

    #[test]
    fn strict_args_reject_unknown_confirm_and_bad_enum() {
        let ok = validate_intent("provider-1", "launcher_search_resources", &serde_json::json!({"query":"Iris"})).unwrap();
        assert_eq!(ok.args["type"], "mod");
        assert!(validate_intent("provider-1", "launcher_search_resources", &serde_json::json!({"query":"Iris","confirmed":true})).is_err());
        assert!(validate_intent("provider-1", "launcher_search_resources", &serde_json::json!({"query":"Iris","type":"wat"})).is_err());
        assert!(validate_intent("provider-1", "launcher_delete_path", &serde_json::json!({"path":"relative/file"})).is_err());
        assert!(validate_intent("provider-1", "launcher_install_resource", &serde_json::json!({"versionId":"v","project":"p","source":"other"})).is_err());
    }

    #[test]
    fn approval_is_bound_to_args_directory_and_single_use() {
        let intent = validate_intent("provider-1", "launcher_delete_version", &serde_json::json!({"versionId":"1.20.1"})).unwrap();
        let state = ApprovalState::default();
        let root = std::env::temp_dir().join("games").join("minecraft");
        let snapshot = ApprovalSnapshot::new("req-1", "chat-1", &intent, &root, "default", 1000).unwrap();
        state.insert(snapshot, 1001).unwrap();
        let changed = validate_intent("provider-1", "launcher_delete_version", &serde_json::json!({"versionId":"other"})).unwrap();
        assert!(state.decide("req-1", true, "chat-1", &changed, &root, "default", 1001).is_err());
        assert!(state.decide("req-1", true, "chat-1", &intent, &root, "default", 1001).is_err());

        let snapshot = ApprovalSnapshot::new("req-2", "chat-1", &intent, &root, "default", 1000).unwrap();
        state.insert(snapshot, 1001).unwrap();
        assert!(state.decide("req-2", true, "other-chat", &intent, &root, "default", 1001).is_err());
        assert!(state.decide("req-2", true, "chat-1", &intent, &root.join("other"), "default", 1001).is_err());
        assert!(state.decide("req-2", true, "chat-1", &intent, &root, "other", 1001).is_err());
        assert!(state.decide("req-2", true, "chat-1", &intent, &root, "default", 1001).is_err());

        let safe_intent = validate_intent("safe-call", "launcher_list_versions", &serde_json::json!({})).unwrap();
        assert!(ApprovalSnapshot::new("safe-ask", "chat-1", &safe_intent, &root, "default", 1000).is_ok());

        let snapshot = ApprovalSnapshot::new("req-3", "chat-1", &intent, &root, "default", 1000).unwrap();
        state.insert(snapshot, 1001).unwrap();
        assert!(state.decide("req-3", true, "chat-1", &intent, &root, "default", 1000 + APPROVAL_TTL_MS).is_err());
    }

    #[test]
    fn malformed_arguments_and_ids_fail_closed() {
        for args in [Value::Null, serde_json::json!([]), serde_json::json!(true), serde_json::json!(1)] {
            assert!(validate_intent("call", "launcher_list_versions", &args).is_err());
        }
        for args in [serde_json::json!({}), serde_json::json!({"name":null}), serde_json::json!({"name":1}), serde_json::json!({"name":"   "}), serde_json::json!({"name":"x".repeat(17)}), serde_json::json!({"name":"a\0b"})] {
            assert!(validate_intent("call", "launcher_create_offline_account", &args).is_err());
        }
        assert!(validate_intent("call", "launcher_list_versions", &serde_json::json!({"confirmed":true})).is_err());
        assert!(validate_intent("call", "launcher_search_resources", &serde_json::json!({"query":"q","loader":null})).is_err());
        assert!(validate_intent("call", "launcher_search_resources", &serde_json::json!({"query":"q","type":"mods"})).is_err());
        assert!(validate_intent("call", "unknown_tool", &serde_json::json!({})).is_err());
        for id in [String::new(), " ".into(), "a\nb".into(), "x".repeat(257)] {
            assert!(validate_intent(&id, "launcher_list_versions", &serde_json::json!({})).is_err());
        }
        let intent = ToolIntent::new("call", "launcher_rename_version", &serde_json::json!({"versionId":"old","newName":"a".repeat(32)})).unwrap();
        assert_eq!(intent.risk().unwrap(), ToolRisk::Dangerous);
    }

    #[test]
    fn approval_checks_every_binding_and_exact_expiry() {
        let root = std::env::temp_dir().join("games").join("minecraft");
        let intent = validate_intent("call", "launcher_delete_version", &serde_json::json!({"versionId":"one"})).unwrap();
        let snapshot = ApprovalSnapshot::new("request", "chat", &intent, &root, "", 1000).unwrap();
        assert!(snapshot.validate("chat", &intent, &root, "", 1000).is_ok());
        assert!(snapshot.validate("chat", &intent, &root, "", 999).is_err());
        assert!(snapshot.validate("chat", &intent, &root, "", 180999).is_ok());
        assert!(snapshot.validate("chat", &intent, &root, "", 181000).is_err());
        assert!(snapshot.validate("other-chat", &intent, &root, "", 1001).is_err());
        assert!(snapshot.validate("chat", &intent, &root.join("other"), "", 1001).is_err());
        assert!(snapshot.validate("chat", &intent, &root, "default", 1001).is_err());
        let mut changed = intent.clone(); changed.provider_call_id = "other-call".into();
        assert!(snapshot.validate("chat", &changed, &root, "", 1001).is_err());
        changed = intent.clone(); changed.args["versionId"] = serde_json::json!("two");
        assert!(snapshot.validate("chat", &changed, &root, "", 1001).is_err());
        changed = intent.clone(); changed.name = "launcher_launch_version".into();
        assert!(snapshot.validate("chat", &changed, &root, "", 1001).is_err());
        assert!(ApprovalSnapshot::new("r", "chat", &intent, Path::new("relative"), "", 0).is_err());
        assert!(ApprovalSnapshot::new("r", "chat", &intent, &root, "", u64::MAX).is_err());
    }

    #[test]
    fn successful_decision_consumes_id_and_clear_does_not_restore_it() {
        let root = std::env::temp_dir().join("minecraft");
        let intent = validate_intent("call", "launcher_delete_account", &serde_json::json!({"account":"cat"})).unwrap();
        let snapshot = ApprovalSnapshot::new("request", "chat", &intent, &root, "", 0).unwrap();
        let state = ApprovalState::default();
        state.insert(snapshot.clone(), 1).unwrap();
        assert!(state.insert(snapshot.clone(), 1).is_err());
        let granted = state.decide("request", true, "chat", &intent, &root, "", 2).unwrap().unwrap();
        assert_eq!(granted.request_id(), "request");
        assert_eq!(granted.chat_id(), "chat");
        assert_eq!(granted.intent_name(), "launcher_delete_account");
        assert_eq!(granted.provider_call_id(), "call");
        assert_eq!(granted.args(), &intent.args);
        assert_eq!(granted.expires_at_ms(), APPROVAL_TTL_MS);
        assert!(state.decide("request", true, "chat", &intent, &root, "", 2).is_err());
        assert!(state.insert(snapshot.clone(), 2).is_err());
        state.clear().unwrap();
        assert!(state.insert(snapshot, 3).is_err());
    }

    #[test]
    fn pending_queue_is_bounded_and_expired_slots_are_reclaimed() {
        let root = std::env::temp_dir().join("minecraft");
        let intent = validate_intent("call", "launcher_list_versions", &serde_json::json!({})).unwrap();
        let state = ApprovalState::default();
        for n in 0..64 {
            state.insert(ApprovalSnapshot::new(&format!("r-{n}"), "chat", &intent, &root, "", 0).unwrap(), 0).unwrap();
        }
        assert_eq!(state.len().unwrap(), 64);
        assert!(state.insert(ApprovalSnapshot::new("overflow", "chat", &intent, &root, "", 0).unwrap(), 1).is_err());
        let expired = ApprovalSnapshot::new("expired", "chat", &intent, &root, "", 0).unwrap();
        assert!(state.insert(expired, APPROVAL_TTL_MS).is_err());
        let fresh = ApprovalSnapshot::new("fresh", "chat", &intent, &root, "", APPROVAL_TTL_MS).unwrap();
        state.insert(fresh, APPROVAL_TTL_MS).unwrap();
        assert_eq!(state.len().unwrap(), 1);
        state.clear().unwrap();
        assert_eq!(state.len().unwrap(), 0);
    }

    #[test]
    fn deny_and_cancel_consume_pending_record() {
        let intent = validate_intent("p", "launcher_delete_account", &serde_json::json!({"account":"a"})).unwrap();
        let state = ApprovalState::default();
        let root = std::env::temp_dir().join("games").join("minecraft");
        state.insert(ApprovalSnapshot::new("deny", "chat", &intent, &root, "default", 0).unwrap(), 1).unwrap();
        assert_eq!(state.decide("deny", false, "chat", &intent, &root, "default", 1).unwrap(), None);
        assert!(state.decide("deny", true, "chat", &intent, &root, "default", 1).is_err());
        state.insert(ApprovalSnapshot::new("cancel", "chat", &intent, &root, "default", 0).unwrap(), 1).unwrap();
        assert!(state.cancel("cancel").unwrap());
        assert!(!state.cancel("cancel").unwrap());
        assert_eq!(state.len().unwrap(), 0);
    }
}

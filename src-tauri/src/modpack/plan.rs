//! 纯本地整合包导入计划。
//! 这里只读取已由 parser::open_validated 完成有界预检的 ZIP，不解压、不联网、不创建实例。
use super::{access::leaf, parser::open_validated, Result};
use serde_json::Value;
use std::{collections::BTreeSet, fs::File, io::Read, path::Path};
use zip::ZipArchive;

const JSON_CAP: u64 = 4 * 1024 * 1024;
const VALUE_CAP: usize = 8192;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SourceFormat { Modrinth, CurseForge, Mcbbs, Native }

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct LoaderSpec {
    pub(super) kind: String,
    pub(super) version: String,
    pub(super) source_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum EnvironmentStatus { Unspecified, Required, Optional, Unsupported }

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Environment {
    pub(super) client: EnvironmentStatus,
    pub(super) server: EnvironmentStatus,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct DeclaredHash {
    pub(super) algorithm: String,
    pub(super) value: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct RemoteFile {
    pub(super) path: Option<String>,
    pub(super) filename: Option<String>,
    pub(super) file_type: Option<String>,
    pub(super) size: Option<u64>,
    pub(super) hashes: Vec<DeclaredHash>,
    pub(super) urls: Vec<String>,
    pub(super) file_api_template: Option<String>,
    pub(super) curse_project_id: Option<u64>,
    pub(super) curse_file_id: Option<u64>,
    pub(super) required: bool,
    pub(super) environment: Environment,
    pub(super) source_index: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum ArchivePhase { Manifest, Metadata, Overrides, ClientOverrides, Unscoped }

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum ApplyPhase { Remote, Overrides, ClientOverrides }

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ArchiveMember {
    pub(super) archive_path: String,
    pub(super) target_path: Option<String>,
    pub(super) size: u64,
    pub(super) phase: ArchivePhase,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct SourceDeclaration {
    pub(super) kind: String,
    pub(super) index: usize,
    pub(super) path: Option<String>,
    pub(super) details: Vec<(String, String)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ManifestSource {
    pub(super) archive_path: String,
    pub(super) bytes: u64,
    pub(super) recognized: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct FullPackPlan {
    pub(super) format: SourceFormat,
    pub(super) name: String,
    pub(super) mc_version: String,
    pub(super) target_id: String,
    pub(super) loader: Option<LoaderSpec>,
    pub(super) summary: String,
    pub(super) manifest_prefix: String,
    pub(super) sources: Vec<ManifestSource>,
    pub(super) remote_files: Vec<RemoteFile>,
    pub(super) declarations: Vec<SourceDeclaration>,
    pub(super) members: Vec<ArchiveMember>,
    pub(super) apply_order: Vec<ApplyPhase>,
}

fn text(value: Option<&Value>, field: &str) -> Result<Option<String>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.len() <= VALUE_CAP && !s.chars().any(char::is_control) => Ok(Some(s.clone())),
        _ => Err(format!("整合包字段 {field} 必须为有效文本")),
    }
}
fn required_text(value: &Value, field: &str) -> Result<String> {
    text(value.get(field), field)?.filter(|s| !s.is_empty()).ok_or_else(|| format!("整合包缺少 {field}"))
}
fn safe_id(value: &str, field: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 240 || value.chars().any(|c| c.is_control() || r##"<>:"/\|?*"##.contains(c)) || value.ends_with('.') || value.ends_with(' ') {
        return Err(format!("{field}不是安全的实例标识"));
    }
    leaf(value).map_err(|_| format!("{field}不是安全的实例标识"))?;
    Ok(value.to_owned())
}
fn relative_path(raw: &str, field: &str) -> Result<String> {
    if raw.is_empty() || raw.len() > 4096 || raw.starts_with('/') || raw.contains('\\') || raw.chars().any(char::is_control) {
        return Err(format!("{field}包含绝对路径或无效分隔符"));
    }
    let parts: Vec<&str> = raw.split('/').collect();
    if parts.len() > 64 || parts.iter().any(|part| part.is_empty()) { return Err(format!("{field}层级或组件无效")); }
    for part in &parts { leaf(part).map_err(|_| format!("{field}包含不安全组件"))?; }
    Ok(raw.to_owned())
}
fn number(value: Option<&Value>, field: &str) -> Result<Option<u64>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n.as_u64().filter(|n| *n <= 2 * 1024 * 1024 * 1024).ok_or_else(|| format!("{field}超过大小上限或不是非负整数")).map(Some),
        _ => Err(format!("{field}必须为非负整数")),
    }
}
fn id(value: Option<&Value>, field: &str) -> Result<Option<u64>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n.as_u64().filter(|n| *n > 0).ok_or_else(|| format!("{field}不是有效 ID")).map(Some),
        Some(Value::String(s)) => s.parse::<u64>().ok().filter(|n| *n > 0).map(Some).ok_or_else(|| format!("{field}不是有效 ID")),
        _ => Err(format!("{field}必须为数字 ID")),
    }
}
fn bool_value(value: Option<&Value>, field: &str, default: bool) -> Result<bool> {
    match value { None | Some(Value::Null) => Ok(default), Some(Value::Bool(v)) => Ok(*v), _ => Err(format!("{field}必须为布尔值")) }
}
fn hashes(value: Option<&Value>) -> Result<Vec<DeclaredHash>> {
    let Some(Value::Object(map)) = value else { return if value.is_none() || value == Some(&Value::Null) { Ok(Vec::new()) } else { Err("整合包 hashes 必须为对象".into()) }; };
    let mut out = Vec::new();
    for (algorithm, value) in map {
        let Some(value) = value.as_str() else { return Err("整合包哈希值必须为文本".into()); };
        if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) { return Err("整合包哈希值无效".into()); }
        out.push(DeclaredHash { algorithm: algorithm.clone(), value: value.to_owned() });
    }
    out.sort_by(|a, b| a.algorithm.cmp(&b.algorithm));
    Ok(out)
}
fn hash_fields(value: &Value) -> Result<Vec<DeclaredHash>> {
    let mut map = serde_json::Map::new();
    for key in ["sha1", "sha256", "sha512", "md5"] { if let Some(v) = value.get(key) { map.insert(key.to_owned(), v.clone()); } }
    hashes(Some(&Value::Object(map)))
}
fn status(value: Option<&Value>, field: &str) -> Result<EnvironmentStatus> {
    match value {
        None | Some(Value::Null) => Ok(EnvironmentStatus::Unspecified),
        Some(Value::String(s)) => match s.as_str() { "required" => Ok(EnvironmentStatus::Required), "optional" => Ok(EnvironmentStatus::Optional), "unsupported" => Ok(EnvironmentStatus::Unsupported), _ => Err(format!("{field}环境标记无效")) },
        _ => Err(format!("{field}环境标记必须为文本")),
    }
}
fn environment(value: Option<&Value>) -> Result<Environment> {
    let Some(value) = value else { return Ok(Environment { client: EnvironmentStatus::Unspecified, server: EnvironmentStatus::Unspecified }); };
    let object = value.as_object().ok_or("整合包环境字段必须为对象")?;
    Ok(Environment { client: status(object.get("client"), "client")?, server: status(object.get("server"), "server")? })
}
fn urls(value: Option<&Value>, field: &str) -> Result<Vec<String>> {
    let Some(value) = value else { return Ok(Vec::new()); };
    let mut out = Vec::new();
    match value {
        Value::String(s) => { if !s.is_empty() { out.push(s.clone()); } },
        Value::Array(rows) => for row in rows { let s = row.as_str().filter(|s| !s.is_empty() && s.len() <= VALUE_CAP && !s.chars().any(char::is_control)).ok_or_else(|| format!("{field}含无效地址"))?; out.push(s.to_owned()); },
        _ => return Err(format!("{field}必须为文本或数组")),
    }
    Ok(out)
}
fn parse_loader(raw: &str, source_key: &str) -> Result<LoaderSpec> {
    let lower = raw.to_ascii_lowercase();
    let (kind, version) = [
        ("neoforge", "neoforge-"), ("neo-forge", "neoforge-"), ("forge", "forge-"),
        ("fabric", "fabric-"), ("quilt", "quilt-"),
    ].iter().find_map(|(kind, prefix)| lower.strip_prefix(prefix).filter(|v| !v.is_empty()).map(|v| ((*kind).to_owned(), v.to_owned())))
        .ok_or_else(|| format!("未知或不完整的加载器标识：{raw}"))?;
    Ok(LoaderSpec { kind, version, source_key: source_key.to_owned() })
}
fn loader_from_dependencies(deps: &Value) -> Result<Option<LoaderSpec>> {
    let object = deps.as_object().ok_or("dependencies 必须为对象")?;
    let mut found = None;
    for key in ["fabric-loader", "quilt-loader", "forge", "neoforge", "neo-forge"] {
        if let Some(value) = object.get(key) {
            let version = value.as_str().filter(|s| !s.is_empty()).ok_or("加载器版本必须为文本")?;
            if found.is_some() { return Err("整合包声明多个加载器，无法确定唯一配置".into()); }
            found = Some(LoaderSpec { kind: key.replace("neo-forge", "neoforge").replace("-loader", ""), version: version.to_owned(), source_key: key.to_owned() });
        }
    }
    for key in object.keys() {
        if key.to_ascii_lowercase().contains("loader") && !["fabric-loader", "quilt-loader"].contains(&key.as_str()) && !["forge", "neoforge", "neo-forge"].contains(&key.as_str()) {
            return Err(format!("未知加载器依赖：{key}"));
        }
    }
    Ok(found)
}
fn fallback_name(source_name: &str) -> String {
    let raw = Path::new(source_name).file_name().and_then(|s| s.to_str()).unwrap_or("整合包");
    raw.rsplit_once('.').filter(|(_, ext)| ext.eq_ignore_ascii_case("zip") || ext.eq_ignore_ascii_case("mrpack")).map(|(stem, _)| stem).unwrap_or(raw).to_owned()
}
fn row_file_with_api(value: &Value, index: usize, source: SourceFormat, default_required: bool, inherited_file_api: Option<&str>) -> Result<RemoteFile> {
    let path = text(value.get("path").or_else(|| value.get("relativePath")), "path")?.map(|s| relative_path(&s, "远程文件路径")).transpose()?;
    if matches!(source, SourceFormat::Modrinth) && path.is_none() { return Err("Modrinth 文件缺少相对路径".into()); }
    let filename = text(value.get("fileName").or_else(|| value.get("filename")), "fileName")?;
    let filename = filename.map(|s| relative_path(&s, "远程文件名")).transpose()?;
    let urls = urls(value.get("downloads").or_else(|| value.get("urls")).or_else(|| value.get("url")), "下载地址")?;
    let file_type = text(value.get("type"), "type")?;
    let inherited_file_api = if file_type.as_deref().is_some_and(|kind| kind.eq_ignore_ascii_case("curse")) { None } else { inherited_file_api };
    let file_api = text(value.get("fileApi").or_else(|| value.get("fileAPI")), "fileApi")?.or_else(|| inherited_file_api.map(str::to_owned));
    let mut all_hashes = hashes(value.get("hashes"))?;
    all_hashes.extend(hash_fields(value)?);
    if let Some(hash) = value.get("hash").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        all_hashes.push(DeclaredHash { algorithm: "sha1".into(), value: hash.to_owned() });
    }
    all_hashes.sort_by(|a, b| a.algorithm.cmp(&b.algorithm));
    let mut dedupe = BTreeSet::new(); all_hashes.retain(|h| dedupe.insert((h.algorithm.clone(), h.value.clone())));
    let curse_project_id = id(value.get("projectID").or_else(|| value.get("projectId")), "projectID")?;
    let curse_file_id = id(value.get("fileID").or_else(|| value.get("fileId")), "fileID")?;
    if matches!(source, SourceFormat::CurseForge) && (curse_project_id.is_none() || curse_file_id.is_none()) { return Err("CurseForge 文件缺少项目或文件 ID".into()); }
    let required = bool_value(value.get("required"), "required", default_required)?;
    Ok(RemoteFile { path, filename, file_type, size: number(value.get("fileSize").or_else(|| value.get("size")), "文件大小")?, hashes: all_hashes, urls, file_api_template: file_api, curse_project_id, curse_file_id, required, environment: environment(value.get("env").or_else(|| value.get("environment")))?, source_index: index })
}
fn row_file(value: &Value, index: usize, source: SourceFormat, default_required: bool) -> Result<RemoteFile> {
    row_file_with_api(value, index, source, default_required, None)
}
fn phase_rank(phase: &ArchivePhase) -> u8 {
    match phase { ArchivePhase::Manifest => 0, ArchivePhase::Metadata | ArchivePhase::Unscoped => 1, ArchivePhase::Overrides => 2, ArchivePhase::ClientOverrides => 3 }
}
fn archive_members(archive: &mut ZipArchive<&mut File>, manifest_index: usize, prefix: &str) -> Result<(Vec<ArchiveMember>, Vec<ArchiveMember>)> {
    let mut members = Vec::new(); let mut overrides = Vec::new(); let mut targets: std::collections::BTreeMap<String, ArchivePhase> = std::collections::BTreeMap::new();
    for index in 0..archive.len() {
        let item = archive.by_index(index).map_err(|_| "无法读取整合包条目")?;
        if item.is_dir() { continue; }
        let archive_path = item.name().to_owned();
        if archive_path == prefix.to_owned() + "overrides/" || archive_path == prefix.to_owned() + "client-overrides/" { continue; }
        let relative = archive_path.strip_prefix(prefix);
        let (phase, target) = if index == manifest_index { (ArchivePhase::Manifest, None) } else if let Some(relative) = relative {
            if let Some(target) = relative.strip_prefix("overrides/") { (ArchivePhase::Overrides, Some(relative_path(target, "overrides 目标路径")?)) }
            else if let Some(target) = relative.strip_prefix("client-overrides/") { (ArchivePhase::ClientOverrides, Some(relative_path(target, "client-overrides 目标路径")?)) }
            else { (ArchivePhase::Metadata, None) }
        } else { (ArchivePhase::Unscoped, None) };
        if let Some(target) = &target {
            let key = target.to_ascii_lowercase();
            if targets.insert(key, phase.clone()).is_some_and(|prior| phase_rank(&prior) == phase_rank(&phase)) { return Err(format!("同一覆盖阶段存在目标冲突：{target}")); }
        }
        let member = ArchiveMember { archive_path, target_path: target.clone(), size: item.size(), phase: phase.clone() };
        if target.is_some() { overrides.push(member.clone()); }
        members.push(member);
    }
    // 真实应用顺序固定：远程文件、overrides、client-overrides；同阶段保留归档顺序。
    members.sort_by_key(|member| phase_rank(&member.phase));
    overrides.sort_by_key(|member| phase_rank(&member.phase));
    Ok((members, overrides))
}
fn manifest_bytes(archive: &mut ZipArchive<&mut File>, index: usize) -> Result<Vec<u8>> {
    let mut entry = archive.by_index(index).map_err(|_| "无法读取整合包清单")?;
    if entry.size() > JSON_CAP { return Err("整合包清单超过 4 MiB".into()); }
    let size = entry.size(); let mut bytes = Vec::new(); entry.by_ref().take(JSON_CAP + 1).read_to_end(&mut bytes).map_err(|_| "整合包清单损坏或 CRC 校验失败")?;
    if bytes.len() as u64 != size || bytes.len() as u64 > JSON_CAP { return Err("整合包清单大小不符".into()); }
    Ok(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes).to_vec())
}
fn parse_mr(value: &Value) -> Result<(String, String, Option<LoaderSpec>, Vec<RemoteFile>)> {
    let deps = value.get("dependencies").ok_or("Modrinth 清单缺少 dependencies")?;
    let mc = deps.get("minecraft").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("Modrinth 清单缺少 dependencies.minecraft")?.to_owned();
    let loader = loader_from_dependencies(deps)?;
    let files = value.get("files").and_then(Value::as_array).ok_or("Modrinth 清单缺少 files 数组")?;
    let mut remote = Vec::new();
    for (index, row) in files.iter().enumerate() { if !row.is_object() { return Err("Modrinth files 条目必须为对象".into()); } remote.push(row_file(row, index, SourceFormat::Modrinth, true)?); }
    Ok((text(value.get("name"), "name")?.unwrap_or_default(), mc, loader, remote))
}
fn parse_cf(value: &Value) -> Result<(String, String, Option<LoaderSpec>, Vec<RemoteFile>)> {
    let minecraft = value.get("minecraft").and_then(Value::as_object).ok_or("CurseForge 清单缺少 minecraft")?;
    let mc = minecraft.get("version").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("CurseForge 清单缺少 Minecraft 版本")?.to_owned();
    let mut loader_spec = None; let mut primary = 0usize;
    if let Some(raw_rows) = minecraft.get("modLoaders") {
        let rows = raw_rows.as_array().ok_or("CurseForge modLoaders 必须为数组")?;
        for row in rows {
            let object = row.as_object().ok_or("CurseForge 加载器条目必须为对象")?;
            let item = object.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("CurseForge 加载器缺少 id")?;
            let selected = bool_value(object.get("primary"), "primary", false)?;
            if selected { primary += 1; loader_spec = Some(parse_loader(item, "modLoaders")?); } else if loader_spec.is_none() { loader_spec = Some(parse_loader(item, "modLoaders")?); }
        }
        if primary > 1 { return Err("CurseForge 清单声明多个 primary 加载器".into()); }
        if primary == 0 && rows.len() > 1 { return Err("CurseForge 清单声明多个未区分加载器".into()); }
    }
    let rows = value.get("files").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut remote = Vec::new(); for (index, row) in rows.iter().enumerate() { if !row.is_object() { return Err("CurseForge files 条目必须为对象".into()); } remote.push(row_file(row, index, SourceFormat::CurseForge, true)?); }
    Ok((text(value.get("name"), "name")?.unwrap_or_default(), mc, loader_spec, remote))
}
fn addon_loader(id: &str, version: &Value) -> Result<Option<LoaderSpec>> {
    let kind = id.to_ascii_lowercase();
    if !["fabric", "quilt", "forge", "neoforge"].contains(&kind.as_str()) { return Ok(None); }
    let version = version.as_str().filter(|s| !s.is_empty()).ok_or("加载器缺少版本")?;
    Ok(Some(LoaderSpec { kind, version: version.to_owned(), source_key: "addons".into() }))
}
fn generic_meta(value: &Value) -> Result<(Option<String>, Option<LoaderSpec>)> {
    let mut mc = None;
    let mut loader = None;
    if let Some(addons) = value.get("addons") {
        match addons {
            Value::Array(rows) => for row in rows {
                let Some(object) = row.as_object() else { return Err("addons 条目必须为对象".into()); };
                let id = text(object.get("id"), "addon id")?.unwrap_or_default().to_ascii_lowercase();
                if (id == "game" || id == "minecraft") && mc.is_none() { mc = text(object.get("version"), "game version")?.filter(|s| !s.is_empty()); }
                if let Some(candidate) = addon_loader(&id, object.get("version").unwrap_or(&Value::Null))? {
                    if loader.is_some() { return Err("整合包声明多个加载器".into()); }
                    loader = Some(candidate);
                }
            },
            Value::Object(map) => {
                mc = map.get("game").or_else(|| map.get("minecraft")).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
                for key in ["fabric", "quilt", "forge", "neoforge"] {
                    if let Some(version) = map.get(key) {
                        if loader.is_some() { return Err("整合包声明多个加载器".into()); }
                        loader = addon_loader(key, version)?;
                    }
                }
            },
            _ => return Err("addons 必须为数组或对象".into()),
        }
    }
    if mc.is_none() {
        if let Some(object) = value.get("minecraft").and_then(Value::as_object) { mc = object.get("version").or_else(|| object.get("id")).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned); }
        else if let Some(raw) = value.get("minecraft").and_then(Value::as_str).filter(|s| !s.is_empty()) { mc = Some(raw.to_owned()); }
    }
    if mc.is_none() {
        for key in ["clientVersion", "gameVersion", "mcVersion", "minecraftVersion", "game_version", "mc_version"] {
            if let Some(raw) = value.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()) { mc = Some(raw.to_owned()); break; }
        }
    }
    if loader.is_none() {
        if let Some(rows) = value.get("minecraft").and_then(|m| m.get("modLoaders")).and_then(Value::as_array) {
            for row in rows {
                let raw = row.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("modLoader id 无效")?;
                let candidate = parse_loader(raw, "modLoaders")?;
                if loader.is_some() { return Err("整合包声明多个加载器".into()); }
                loader = Some(candidate);
            }
        }
    }
    if loader.is_none() {
        let raw = text(value.get("mod_loader").or_else(|| value.get("loader")), "loader")?.unwrap_or_default();
        if !raw.is_empty() && !raw.eq_ignore_ascii_case("vanilla") {
            let version = text(value.get("mod_loader_version").or_else(|| value.get("loader_version")), "loader version")?.unwrap_or_default();
            let full = if raw.contains('-') { raw } else { format!("{raw}-{version}") };
            loader = Some(parse_loader(&full, "loader")?);
        }
    }
    Ok((mc, loader))
}
fn parse_mcbbs(value: &Value) -> Result<(String, String, Option<LoaderSpec>, Vec<RemoteFile>, Vec<SourceDeclaration>)> {
    let (addon_mc, loader) = generic_meta(value)?;
    let mc = addon_mc.or_else(|| value.get("minecraft").and_then(|m| m.get("version")).and_then(Value::as_str).map(str::to_owned)).ok_or("MCBBS 清单缺少 Minecraft 版本")?;
    let inherited_api = text(value.get("fileApi"), "fileApi")?;
    let mut remote = Vec::new(); let mut declarations = Vec::new(); let mut index = 0;
    if let Some(files) = value.get("files") {
        match files {
            Value::Array(rows) => for row in rows { let object = row.as_object().ok_or("MCBBS 文件条目必须为对象")?; declarations.push(SourceDeclaration { kind: "files".into(), index, path: text(object.get("path"), "path")?, details: vec![] }); remote.push(row_file_with_api(row, index, SourceFormat::Mcbbs, true, inherited_api.as_deref())?); index += 1; },
            Value::Object(map) => for (name, row) in map { let object = row.as_object().ok_or("MCBBS 映射条目必须为对象")?; let mut details = vec![("key".into(), name.clone())]; declarations.push(SourceDeclaration { kind: "files".into(), index, path: text(object.get("path"), "path")?, details }); remote.push(row_file_with_api(row, index, SourceFormat::Mcbbs, true, inherited_api.as_deref())?); index += 1; },
            _ => return Err("MCBBS files 必须为数组或对象".into()),
        }
    }
    if let Some(api) = inherited_api { declarations.push(SourceDeclaration { kind: "fileApi-template".into(), index, path: None, details: vec![("template".into(), api)] }); }
    Ok((text(value.get("name").or_else(|| value.get("title")), "name")?.unwrap_or_default(), mc, loader, remote, declarations))
}
fn parse_native(value: &Value) -> Result<(String, String, Option<LoaderSpec>, Vec<RemoteFile>, Vec<SourceDeclaration>)> {
    let (addon_mc, loader) = generic_meta(value)?;
    let mc = addon_mc.ok_or("native 清单缺少本地 Minecraft 版本")?;
    Ok((text(value.get("name").or_else(|| value.get("title")), "name")?.unwrap_or_default(), mc, loader, Vec::new(), Vec::new()))
}
fn conflict_with_remote(remote: &[RemoteFile], members: &[ArchiveMember]) -> Result<()> {
    let paths: BTreeSet<String> = remote.iter().filter_map(|file| file.path.as_ref()).map(|path| path.to_ascii_lowercase()).collect();
    let _overlapped = members.iter().filter_map(|member| member.target_path.as_ref()).filter(|path| paths.contains(&path.to_ascii_lowercase())).count();
    Ok(())
}

pub(super) fn plan(file: &mut File, source_name: &str, custom_name: Option<&str>) -> Result<FullPackPlan> {
    let (mut archive, manifest) = open_validated(file)?;
    let bytes = manifest_bytes(&mut archive, manifest.index)?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "整合包清单不是有效 JSON".to_owned())?;
    let format = match manifest.name.as_str() { "modrinth.index.json" => SourceFormat::Modrinth, "launcher.packmeta" => SourceFormat::Native, "mcbbs.packmeta" => SourceFormat::Mcbbs, "manifest.json" if value.get("files").and_then(Value::as_array).is_some() && value.get("minecraft").and_then(|v| v.get("version")).is_some() => SourceFormat::CurseForge, "manifest.json" => SourceFormat::Mcbbs, _ => return Err("无法识别的整合包清单来源".into()) };
    let (manifest_name, mc, loader, mut remote_files, declarations) = match format { SourceFormat::Modrinth => { let (name, mc, loader, files) = parse_mr(&value)?; (name, mc, loader, files, Vec::new()) }, SourceFormat::CurseForge => { let (name, mc, loader, files) = parse_cf(&value)?; (name, mc, loader, files, Vec::new()) }, SourceFormat::Mcbbs => { let (name, mc, loader, files, decl) = parse_mcbbs(&value)?; (name, mc, loader, files, decl) }, SourceFormat::Native => { let (name, mc, loader, files, decl) = parse_native(&value)?; (name, mc, loader, files, decl) } };
    let fallback = fallback_name(source_name); let name = custom_name.map(|name| safe_id(name, "自定义名称")).transpose()?.unwrap_or_else(|| if manifest_name.is_empty() { fallback.clone() } else { manifest_name });
    let target_id = safe_id(&name, "实例名称")?;
    if mc.len() > VALUE_CAP || mc.chars().any(char::is_control) { return Err("Minecraft 版本字段无效".into()); }
    let (members, _) = archive_members(&mut archive, manifest.index, &manifest.prefix)?;
    conflict_with_remote(&remote_files, &members)?;
    remote_files.shrink_to_fit();
    let sources = vec![ManifestSource { archive_path: format!("{}{}", manifest.prefix, manifest.name), bytes: bytes.len() as u64, recognized: true }];
    let summary = text(value.get("summary").or_else(|| value.get("description")), "summary")?.unwrap_or_default();
    Ok(FullPackPlan { format, name, mc_version: mc, target_id, loader, summary, manifest_prefix: manifest.prefix, sources, remote_files, declarations, members, apply_order: vec![ApplyPhase::Remote, ApplyPhase::Overrides, ApplyPhase::ClientOverrides] })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::{write::FileOptions, CompressionMethod, ZipWriter};

    fn fixture(entries: &[(&str, &[u8])]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("hcmcl-pack-plan-{}.zip", uuid::Uuid::new_v4()));
        let mut zip = ZipWriter::new(File::create(&path).unwrap());
        for (name, bytes) in entries { zip.start_file(*name, FileOptions::default().compression_method(CompressionMethod::Stored)).unwrap(); zip.write_all(bytes).unwrap(); }
        zip.finish().unwrap(); path
    }
    fn run(path: &std::path::Path, custom: Option<&str>) -> FullPackPlan { let mut file = File::open(path).unwrap(); plan(&mut file, path.to_str().unwrap(), custom).unwrap() }
    #[test]
    fn modrinth_preserves_urls_hashes_environment_and_override_order() {
        let manifest = br#"{"name":"MR","summary":"S","dependencies":{"minecraft":"1.21.1","fabric-loader":"0.16.9"},"files":[{"path":"mods/a.jar","fileSize":3,"hashes":{"sha512":"abc","sha1":"def"},"downloads":["https://one","https://two"],"env":{"client":"required","server":"unsupported"}}]}"#;
        let path = fixture(&[("modrinth.index.json", manifest), ("overrides/mods/a.jar", b"x"), ("client-overrides/config/x", b"y")]);
        let plan = run(&path, Some("custom")); std::fs::remove_file(path).unwrap();
        assert_eq!(plan.format, SourceFormat::Modrinth); assert_eq!(plan.target_id, "custom"); assert_eq!(plan.loader.as_ref().unwrap().kind, "fabric"); assert_eq!(plan.remote_files[0].urls, vec!["https://one", "https://two"]); assert_eq!(plan.remote_files[0].environment.client, EnvironmentStatus::Required); assert_eq!(plan.members.iter().filter(|m| m.target_path.is_some()).count(), 2);
    }
    #[test]
    fn curseforge_ids_without_path_are_retained_and_mcbbs_fileapi_is_not_executed() {
        let cf = br#"{"name":"CF","minecraft":{"version":"1.20.1","modLoaders":[{"id":"forge-47.2.0","primary":true}]},"files":[{"projectID":12,"fileID":34,"required":false}]}"#;
        let path = fixture(&[("manifest.json", cf)]); let plan = run(&path, None); std::fs::remove_file(path).unwrap(); assert_eq!(plan.format, SourceFormat::CurseForge); assert_eq!(plan.remote_files[0].path, None); assert_eq!(plan.remote_files[0].curse_project_id, Some(12));
        let mcbbs = br#"{"title":"B","minecraft":{"version":"1.20.1"},"files":[{"path":"mods/a.jar","fileApi":"https://api/{id}","required":true}]}"#;
        let path = fixture(&[("mcbbs.packmeta", mcbbs)]); let plan = run(&path, None); std::fs::remove_file(path).unwrap(); assert_eq!(plan.format, SourceFormat::Mcbbs); assert_eq!(plan.remote_files[0].file_api_template.as_deref(), Some("https://api/{id}")); assert!(plan.remote_files[0].urls.is_empty());
    }
    #[test]
    fn native_nested_prefix_and_conflicting_override_are_explicit() {
        let native = br#"{"name":"N","game_version":"1.20.4","mod_loader":"quilt","mod_loader_version":"0.26.0"}"#;
        let path = fixture(&[("pack/launcher.packmeta", native), ("pack/overrides/config/x", b"a"), ("pack/client-overrides/config/X", b"b")]);
        let mut file = File::open(&path).unwrap(); let plan = plan(&mut file, "native.zip", None).unwrap();
        assert_eq!(plan.members.iter().filter_map(|member| member.target_path.as_ref()).collect::<Vec<_>>(), vec![&"config/x".to_owned(), &"config/X".to_owned()]);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn mcbbs_addons_array_infers_metadata_and_inherits_only_addon_file_api() {
        let manifest = br#"{"title":"Array","addons":[{"id":"game","version":"1.20.1"},{"id":"forge","version":"47.2.0"},{"id":"unknown-addon","version":"ignored"}],"fileApi":"https://files.example.invalid","files":[{"type":"curse","projectID":12,"fileID":34,"fileName":"example.jar","hash":"ABCDEF","required":true},{"type":"addon","path":"config/example.txt","hash":"123ABC"}]}"#;
        let path = fixture(&[("mcbbs.packmeta", manifest)]); let plan = run(&path, None); std::fs::remove_file(path).unwrap();
        assert_eq!(plan.mc_version, "1.20.1"); assert_eq!(plan.loader.as_ref().unwrap().kind, "forge"); assert_eq!(plan.loader.as_ref().unwrap().version, "47.2.0");
        assert_eq!(plan.remote_files.len(), 2); let file = &plan.remote_files[0]; assert_eq!(file.file_type.as_deref(), Some("curse")); assert_eq!(file.file_api_template, None); assert_eq!(file.curse_project_id, Some(12)); assert_eq!(file.curse_file_id, Some(34)); assert!(file.hashes.iter().any(|hash| hash.algorithm == "sha1" && hash.value == "ABCDEF"));
        let addon = &plan.remote_files[1]; assert_eq!(addon.file_type.as_deref(), Some("addon")); assert_eq!(addon.path.as_deref(), Some("config/example.txt")); assert_eq!(addon.file_api_template.as_deref(), Some("https://files.example.invalid")); assert!(addon.hashes.iter().any(|hash| hash.algorithm == "sha1" && hash.value == "123ABC"));
    }
    #[test]
    fn mcbbs_addons_map_infers_game_and_loader_without_treating_addons_as_files() {
        let manifest = br#"{"name":"Map","addons":{"game":"1.19.4","fabric":"0.15.0"},"files":[]}"#;
        let path = fixture(&[("mcbbs.packmeta", manifest)]); let plan = run(&path, None); std::fs::remove_file(path).unwrap();
        assert_eq!(plan.mc_version, "1.19.4"); assert_eq!(plan.loader.as_ref().unwrap().kind, "fabric"); assert!(plan.remote_files.is_empty());
    }
    #[test]
    fn native_addons_array_infers_game_and_loader() {
        let manifest = br#"{"name":"Native","addons":[{"id":"game","version":"1.20.4"},{"id":"neoforge","version":"20.4.237"}]}"#;
        let path = fixture(&[("launcher.packmeta", manifest), ("overrides/config/example.txt", b"ok")]); let plan = run(&path, None); std::fs::remove_file(path).unwrap();
        assert_eq!(plan.mc_version, "1.20.4"); assert_eq!(plan.loader.as_ref().unwrap().kind, "neoforge"); assert_eq!(plan.members.iter().filter(|member| member.target_path.is_some()).count(), 1);
    }
    #[test]
    fn mcbbs_rejects_unsafe_remote_path() {
        let manifest = br#"{"minecraft":{"version":"1.20.1"},"files":[{"path":"../escape","hash":"abc"}]}"#;
        let path = fixture(&[("mcbbs.packmeta", manifest)]); let mut file = File::open(&path).unwrap(); assert!(plan(&mut file, "bad.zip", None).is_err()); std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn ordinary_manifest_is_not_selected_as_mcbbs_without_parser_recognition() {
        let path = fixture(&[("manifest.json", br#"{}"#)]); let mut file = File::open(&path).unwrap(); assert!(plan(&mut file, "x.zip", None).is_err()); std::fs::remove_file(path).unwrap();
    }
}

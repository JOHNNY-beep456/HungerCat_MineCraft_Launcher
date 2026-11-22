//! 更新应用的官方重绑定和依赖计划。只查询元数据，不写入实例。
use super::super::BoundDownload;
use super::{FileMeta, LocalQuery, PlannedChange, PreparedUpdate, ResourceKind, Result, Session, Transport, UpdateInfo, VerifiedFile};
use crate::resource_updates::model::DetectedUpdate;
use serde_json::Value;
use std::{collections::{BTreeMap, BTreeSet}, sync::{atomic::AtomicBool, Arc}};

#[cfg(test)]
mod tests;

const MAX_DEPTH: usize = 16;
const MAX_NODES: usize = 128;
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
fn invalid() -> String { "官方依赖元数据无效或不一致 / 官方相依中繼資料無效或不一致 / Invalid or inconsistent official dependency metadata".into() }
fn conflict() -> String { "依赖计划或本地文件存在冲突，请先处理冲突后重新检查 / 相依計畫或本機檔案存在衝突，請先處理後重新檢查 / Dependency plan or local file conflict; resolve it and check again".into() }
fn cross_kind() -> String { "此更新含跨资源类型依赖，尚不能由单目录事务应用；未更改文件 / 此更新含跨資源類型相依，尚不能由單目錄交易套用；未更改檔案 / Cross-kind dependencies are not supported by this single-directory transaction; no files changed".into() }
#[derive(Clone)]
struct OfficialFile { file: VerifiedFile, dependencies: Vec<Value> }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Relation { Required, Optional, Incompatible, Embedded }
#[derive(Clone, Debug)]
struct DependencyRef { source: String, project: Option<String>, version: Option<String>, relation: Relation }
fn relation(value: &Value) -> Result<Relation> {
    match value.as_str() {
        Some("required") => Ok(Relation::Required), Some("optional" | "tool") => Ok(Relation::Optional),
        Some("incompatible") => Ok(Relation::Incompatible), Some("embedded" | "include") => Ok(Relation::Embedded),
        _ => Err(invalid()),
    }
}
fn optional_id(value: Option<&Value>, numeric: bool) -> Result<Option<String>> {
    let Some(value) = value.filter(|v| !v.is_null()) else { return Ok(None); };
    if numeric { if let Some(value) = value.as_u64().filter(|value| *value > 0) { return Ok(Some(value.to_string())); } }
    let text = value.as_str().ok_or_else(invalid)?;
    super::word(text)?;
    if numeric && text.parse::<u64>().ok().filter(|v| *v > 0).is_none() { return Err(invalid()); }
    Ok(Some(text.into()))
}
fn dependency_ref(raw: &Value) -> Result<DependencyRef> {
    let source = raw.get("source").and_then(Value::as_str).ok_or_else(invalid)?;
    if !matches!(source, "modrinth" | "curseforge") { return Err(invalid()); }
    let cf = source == "curseforge";
    let relation = relation(raw.get("dependency_type").ok_or_else(invalid)?)?;
    let project = optional_id(raw.get("project_id").or_else(|| raw.get("modId")), cf)?;
    let version = optional_id(if cf { raw.get("fileId") } else { raw.get("version_id") }, cf)?;
    // 官方可用 file_name 表示未关联项目的可选或内嵌文件；这些关系不产生下载动作。
    if project.is_none() && (cf || version.is_none()) && !matches!(relation, Relation::Optional | Relation::Embedded) { return Err(invalid()); }
    Ok(DependencyRef { source: source.into(), project, version, relation })
}
fn dependency_refs(raw: &[Value]) -> Result<Vec<DependencyRef>> {
    if raw.len() > 1024 { return Err(super::limited()); }
    raw.iter().map(dependency_ref).collect()
}
fn bound(source: &'static str, kind: ResourceKind, project: &str, id: &str, title: &str, version: &str, file: &FileMeta, dependencies: Vec<Value>) -> Result<OfficialFile> {
    Ok(OfficialFile { file: VerifiedFile { source: source.into(), project_id: project.into(), version_id: id.into(),
        title: super::label(title)?, version: super::label(version)?, download: BoundDownload { source, kind: kind.as_str(),
            url: file.url.clone(), filename: file.filename.clone(), size: file.size, sha1: file.sha1.clone(), sha512: file.sha512.clone() } }, dependencies })
}
async fn main_file<T: Transport>(session: &mut Session<'_, T>, input: &LocalQuery, requested: &UpdateInfo) -> Result<OfficialFile> {
    if requested.path != input.path.to_str().ok_or_else(invalid)? || requested.kind != input.kind { return Err(invalid()); }
    // 使用检测器同一条身份链；前端地址只参与最终相等比较，不选择下载能力或来源。
    let detected: DetectedUpdate = match super::detect_modrinth(session, input).await {
        Ok(Some(value)) => value,
        Ok(None) => return Err(invalid()),
        Err(error) if error == super::HASH_UNKNOWN => super::detect_curseforge(session, input).await?.ok_or_else(invalid)?,
        Err(error) => return Err(error),
    };
    if detected.info != *requested { return Err("更新候选已改变，请重新检查 / 更新候選已改變，請重新檢查 / Update candidate changed; check again".into()); }
    let dep = DependencyRef { source: detected.source, project: Some(detected.project_id), version: Some(detected.version_id), relation: Relation::Required };
    let file = resolve(session, input, &dep).await?;
    if file.file.version != requested.latest_version || file.file.title != requested.title || file.file.download.filename != requested.filename
        || file.file.download.size != requested.size || file.file.download.url != requested.file_url
        || file.file.download.sha1 != detected.sha1 || file.file.download.sha512 != detected.sha512
        || file.dependencies != detected.dependencies { return Err(invalid()); }
    Ok(file)
}

/// 只凭官方项目决定资源类型；当前事务不跨多个资源目录写入。
fn mr_kind(project: &Value, input: &LocalQuery) -> Result<()> {
    if super::text(project, "project_type") != input.kind.as_str() { return Err(cross_kind()); }
    super::mr_type(project, input.kind)
}
async fn mr_reference<T: Transport>(session: &mut Session<'_, T>, dep: &DependencyRef) -> Result<(String, Option<Value>)> {
    let raw = if let Some(version) = &dep.version {
        let raw = session.get(super::endpoint(super::MR, &["version", version])?, false).await?;
        if super::text(&raw, "id") != version { return Err(invalid()); }
        Some(raw)
    } else { None };
    let project = match (&dep.project, &raw) {
        (Some(project), Some(raw)) if super::mr_project_id(raw)? != project => return Err(invalid()),
        (Some(project), _) => project.clone(),
        (None, Some(raw)) => super::mr_project_id(raw)?.into(),
        _ => return Err(invalid()),
    };
    Ok((project, raw))
}
async fn resolve<T: Transport>(session: &mut Session<'_, T>, input: &LocalQuery, dep: &DependencyRef) -> Result<OfficialFile> {
    session.check()?;
    if dep.source == "modrinth" {
        let (project_id, raw_version) = mr_reference(session, dep).await?;
        let project = session.get(super::endpoint(super::MR, &["project", &project_id])?, false).await?;
        if super::word(super::text(&project, "id"))? != project_id { return Err(invalid()); }
        mr_kind(&project, input)?;
        let candidate = if let Some(raw) = raw_version {
            super::mr_candidate(&raw, input, &project_id)?.ok_or_else(invalid)?
        } else {
            let raw = session.get(super::mr_version_url(&project_id, input)?, false).await?;
            let rows = raw.as_array().filter(|v| v.len() < super::MAX_ITEMS).ok_or_else(invalid)?;
            let mut ids = BTreeSet::new(); let mut candidates = Vec::new();
            for raw in rows { session.check()?; if !ids.insert(super::word(super::text(raw, "id"))?) { return Err(invalid()); }
                if let Some(value) = super::mr_candidate(raw, input, &project_id)? { candidates.push(value); } }
            candidates.sort_by(|a,b| b.date.cmp(&a.date).then_with(|| a.id.cmp(&b.id)));
            candidates.into_iter().next().ok_or_else(invalid)?
        };
        return bound("modrinth", input.kind, &project_id, &candidate.id, super::text(&project, "title"), &candidate.version, &candidate.file, candidate.dependencies);
    }
    if dep.source != "curseforge" { return Err(invalid()); }
    let project_id = dep.project.as_ref().ok_or_else(invalid)?.parse::<u64>().map_err(|_| invalid())?;
    let raw = session.get(super::endpoint(super::CF, &["mods", &project_id.to_string()])?, true).await?;
    let project = raw.get("data").filter(|v| v.is_object()).ok_or_else(invalid)?;
    if project.get("classId").and_then(Value::as_u64) != Some(super::cf_class(input.kind)) { return Err(cross_kind()); }
    if project.get("id").and_then(Value::as_u64) != Some(project_id) || project.get("gameId").and_then(Value::as_u64) != Some(432)
        || project.get("allowModDistribution").and_then(Value::as_bool) != Some(true) { return Err(invalid()); }
    let candidate = if let Some(version) = &dep.version {
        let raw = session.get(super::endpoint(super::CF, &["mods", &project_id.to_string(), "files", version])?, true).await?;
        let file = raw.get("data").filter(|v| v.is_object()).ok_or_else(invalid)?;
        if file.get("id").and_then(Value::as_u64).map(|v| v.to_string()).as_ref() != Some(version) { return Err(invalid()); }
        super::cf_candidate(file, project, project_id, input)?.ok_or_else(invalid)?
    } else {
        let rows = super::cf_pages(session, project_id, input).await?;
        let mut values = Vec::new();
        for raw in &rows { session.check()?; if let Some(value) = super::cf_candidate(raw, project, project_id, input)? { values.push(value); } }
        values.sort_by(|a,b| b.date.cmp(&a.date).then_with(|| a.id.cmp(&b.id)));
        values.into_iter().next().ok_or_else(invalid)?
    };
    bound("curseforge", input.kind, &project_id.to_string(), &candidate.id, super::text(project, "name"), &candidate.version, &candidate.file, candidate.dependencies)
}

#[derive(Clone, Debug)]
struct InstalledIdentity { project: String, version: String }
type Identities = BTreeMap<(String, std::path::PathBuf), Option<InstalledIdentity>>;
fn same_query(a: &LocalQuery, b: &LocalQuery) -> bool {
    a.path == b.path && a.filename == b.filename && a.enabled == b.enabled && a.size == b.size
        && a.sha1 == b.sha1 && a.sha512 == b.sha512 && a.fingerprint == b.fingerprint && context_matches(a, b)
}
fn context_matches(old: &LocalQuery, input: &LocalQuery) -> bool {
    old.kind == input.kind && old.path.parent() == input.path.parent() && old.mc_version == input.mc_version
        && old.loader == input.loader && old.shader_runtimes == input.shader_runtimes
}
async fn installed_identity<T: Transport>(session: &mut Session<'_, T>, source: &str, old: &LocalQuery, known: &mut Identities) -> Result<Option<InstalledIdentity>> {
    let key = (source.to_owned(), old.path.clone());
    if let Some(value) = known.get(&key) { return Ok(value.clone()); }
    let value = if source == "modrinth" {
        match super::mr_version_by_hash(session, old).await {
            Err(error) if error == super::HASH_UNKNOWN => None,
            Err(error) => return Err(error),
            Ok(raw) => { let project = super::mr_project_id(&raw)?.to_owned();
                let (version, _) = super::select_mr_file(&raw, old, &project)?;
                super::mr_project(session, &project, old.kind).await?;
                Some(InstalledIdentity { project, version }) }
        }
    } else if source == "curseforge" {
        match super::cf_fingerprint(session, old).await? {
            None => None,
            Some((project, raw, _)) => { super::cf_project(session, project, old.kind).await?;
                Some(InstalledIdentity { project: project.to_string(), version: raw.get("id").and_then(Value::as_u64).ok_or_else(invalid)?.to_string() }) }
        }
    } else { return Err(invalid()); };
    known.insert(key, value.clone()); Ok(value)
}
fn hash_match(old: &LocalQuery, file: &VerifiedFile) -> bool {
    let data = &file.download;
    old.kind.as_str() == data.kind && old.size == data.size && (data.sha1.is_some() || data.sha512.is_some())
        && data.sha1.as_deref().map_or(true, |v| v.eq_ignore_ascii_case(&old.sha1))
        && data.sha512.as_deref().map_or(true, |v| v.eq_ignore_ascii_case(&old.sha512))
}
fn same_file(a: &VerifiedFile, b: &VerifiedFile) -> bool {
    a.source == b.source && a.project_id == b.project_id && a.version_id == b.version_id
        && a.download.kind == b.download.kind && a.download.filename == b.download.filename && a.download.url == b.download.url
        && a.download.size == b.download.size && a.download.sha1 == b.download.sha1 && a.download.sha512 == b.download.sha512
}
fn planned_file(change: &PlannedChange) -> Option<&VerifiedFile> {
    match change { PlannedChange::Replace { file, .. } | PlannedChange::Install { file } => Some(file), _ => None }
}
async fn add_change<T: Transport>(session: &mut Session<'_, T>, input: &LocalQuery, installed: &[LocalQuery], known: &mut Identities, changes: &mut Vec<PlannedChange>, file: VerifiedFile) -> Result<()> {
    if changes.iter().filter_map(planned_file).any(|v| same_file(v, &file)) { return Ok(()); }
    if changes.iter().filter_map(planned_file).any(|v| v.download.filename.eq_ignore_ascii_case(&file.download.filename)) { return Err(conflict()); }
    let mut exact = Vec::new(); let mut project_matches = Vec::new();
    for old in installed.iter().filter(|old| context_matches(old, input)) {
        session.check()?;
        if hash_match(old, &file) { exact.push(old); continue; }
        if let Some(identity) = installed_identity(session, &file.source, old, known).await? {
            if identity.project == file.project_id { project_matches.push(old); }
        }
    }
    if exact.len() + project_matches.len() > 1 { return Err(conflict()); }
    if let Some(old) = exact.first() {
        if !old.enabled && !changes.iter().any(|v| matches!(v, PlannedChange::Enable { old: existing } if existing.path == old.path)) {
            changes.push(PlannedChange::Enable { old: (*old).clone() });
        }
        return Ok(());
    }
    if let Some(old) = project_matches.first() {
        // Replace 保留原有禁用状态；尚不能合并启用和替换为同一个动作时，拒绝整个计划。
        if !old.enabled { return Err("所需依赖的旧版本处于禁用状态，请先启用后重新检查更新 / 所需相依的舊版本已停用，請先啟用後重新檢查更新 / An older required dependency is disabled; enable it and check again".into()); }
        if changes.iter().any(|v| matches!(v, PlannedChange::Replace { old: existing, .. } | PlannedChange::Enable { old: existing } if existing.path == old.path)) { return Err(conflict()); }
        changes.push(PlannedChange::Replace { old: (*old).clone(), file });
    } else {
        // 未知同名文件不能凭名称获得替换授权。
        if installed.iter().any(|old| old.kind.as_str() == file.download.kind && old.filename.eq_ignore_ascii_case(&file.download.filename)) { return Err(conflict()); }
        changes.push(PlannedChange::Install { file });
    }
    Ok(())
}
#[derive(Clone)]
struct Constraint { source: String, project: String, version: Option<String> }
async fn constraint<T: Transport>(session: &mut Session<'_, T>, input: &LocalQuery, dep: &DependencyRef) -> Result<Constraint> {
    let project = if dep.source == "modrinth" { mr_reference(session, dep).await?.0 }
        else { dep.project.clone().ok_or_else(invalid)? };
    // 不兼容关系不要求其文件仍可下载或与当前加载器兼容；身份按官方项目/版本检查。
    if dep.source == "modrinth" { super::mr_project(session, &project, input.kind).await?; }
    else { super::cf_project(session, project.parse().map_err(|_| invalid())?, input.kind).await?; }
    Ok(Constraint { source: dep.source.clone(), project, version: dep.version.clone() })
}
fn identifies(constraint: &Constraint, source: &str, project: &str, version: &str) -> bool {
    constraint.source == source && constraint.project == project && constraint.version.as_deref().map_or(true, |v| v == version)
}
async fn verify_constraints<T: Transport>(session: &mut Session<'_, T>, input: &LocalQuery, installed: &[LocalQuery], known: &mut Identities, changes: &[PlannedChange], selected: &BTreeMap<(String,String), VerifiedFile>, constraints: &[Constraint]) -> Result<()> {
    for constraint in constraints {
        if selected.values().any(|v| identifies(constraint, &v.source, &v.project_id, &v.version_id)) { return Err(conflict()); }
        for old in installed.iter().filter(|old| context_matches(old, input)) {
            if changes.iter().any(|v| matches!(v, PlannedChange::Replace { old: replaced, .. } if replaced.path == old.path)) { continue; }
            if let Some(identity) = installed_identity(session, &constraint.source, old, known).await? {
                if identifies(constraint, &constraint.source, &identity.project, &identity.version) { return Err(conflict()); }
            }
        }
    }
    Ok(())
}
pub(super) async fn prepare_with<T: Transport>(transport: &T, input: &LocalQuery, requested: &UpdateInfo, installed: &[LocalQuery], settings: &Value, cancel: &Arc<AtomicBool>, policy_check: Arc<dyn Fn() -> Result<()> + Send + Sync>) -> Result<PreparedUpdate> {
    super::validate_input(input)?;
    if super::super::online(settings).is_err() || settings.get("metadataOnlyMods").and_then(Value::as_bool) == Some(true) { return Err(invalid()); }
    let local: Vec<_> = installed.iter().filter(|old| old.path == input.path).collect();
    if local.len() != 1 || !same_query(local[0], input) { return Err(invalid()); }
    let mut session = Session::new(transport, settings, cancel, policy_check); session.check()?;
    let main = main_file(&mut session, input, requested).await?;
    let key = (main.file.source.clone(), main.file.project_id.clone());
    let mut selected = BTreeMap::from([(key.clone(), main.file.clone())]);
    let mut total = main.file.download.size;
    if total > MAX_BYTES { return Err(super::limited()); }
    let mut changes = vec![PlannedChange::Replace { old: input.clone(), file: main.file.clone() }];
    let mut known = Identities::new(); let mut constraints = Vec::new();
    let mut pending = dependency_refs(&main.dependencies)?.into_iter().rev().map(|dep| (dep, 1usize, vec![key.clone()])).collect::<Vec<_>>();
    while let Some((dep, depth, ancestors)) = pending.pop() {
        session.check()?;
        if depth > MAX_DEPTH { return Err(super::limited()); }
        if matches!(dep.relation, Relation::Optional | Relation::Embedded) { continue; }
        if dep.relation == Relation::Incompatible { constraints.push(constraint(&mut session, input, &dep).await?); continue; }
        let file = resolve(&mut session, input, &dep).await?;
        let key = (file.file.source.clone(), file.file.project_id.clone());
        if ancestors.contains(&key) { return Err(conflict()); }
        if let Some(existing) = selected.get(&key) { if !same_file(existing, &file.file) { return Err(conflict()); } continue; }
        if selected.len() >= MAX_NODES { return Err(super::limited()); }
        total = total.checked_add(file.file.download.size).filter(|v| *v <= MAX_BYTES).ok_or_else(super::limited)?;
        add_change(&mut session, input, installed, &mut known, &mut changes, file.file.clone()).await?;
        selected.insert(key.clone(), file.file);
        let mut next = ancestors; next.push(key);
        for child in dependency_refs(&file.dependencies)?.into_iter().rev() { pending.push((child, depth + 1, next.clone())); }
    }
    verify_constraints(&mut session, input, installed, &mut known, &changes, &selected, &constraints).await?;
    session.check()?;
    Ok(PreparedUpdate { requested: requested.clone(), changes })
}

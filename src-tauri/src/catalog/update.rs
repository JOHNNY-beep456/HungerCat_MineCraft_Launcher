//! 资源更新的官方身份与兼容版本检测；只进行有界 HTTP 查询，不触碰本地文件。
use super::{endpoint, loader_id, remote_request, text, Method, Url, CF, FILE_CAP, MR};
use crate::resource_updates::model::{DetectedUpdate, LocalQuery, ResourceKind, UpdateInfo};
use serde_json::{json, Value};
use std::{collections::BTreeSet, future::Future, pin::Pin, sync::{atomic::{AtomicBool, Ordering}, Arc}, time::{Duration, Instant}};

type Result<T> = std::result::Result<T, String>;
mod dependencies;

/// 仅由本模块的官方验证链构造；宿主据此展示批准并准备事务，不接受界面下载授权。
#[derive(Clone, Debug)]
pub(crate) struct VerifiedFile {
    pub source: String,
    pub project_id: String,
    pub version_id: String,
    pub title: String,
    pub version: String,
    pub download: super::BoundDownload,
}
#[derive(Clone, Debug)]
pub(crate) enum PlannedChange {
    Install { file: VerifiedFile },
    Replace { old: LocalQuery, file: VerifiedFile },
    Enable { old: LocalQuery },
}
#[derive(Clone, Debug)]
pub(crate) struct PreparedUpdate {
    pub requested: UpdateInfo,
    pub changes: Vec<PlannedChange>,
}

/// 每次重新查询官方，不采用检测缓存；额外变更仍须由宿主按整份计划明确征求批准。
pub(crate) async fn prepare_apply_guarded(
    input: &LocalQuery, requested: &UpdateInfo, installed: &[LocalQuery], settings: &Value,
    cancel: &Arc<AtomicBool>, policy_check: Arc<dyn Fn() -> Result<()> + Send + Sync>,
) -> Result<PreparedUpdate> {
    dependencies::prepare_with(&Official, input, requested, installed, settings, cancel, policy_check).await
}
const MAX_ITEMS: usize = 5000;
const PAGE_SIZE: usize = 50;
const MAX_PAGES: usize = MAX_ITEMS / PAGE_SIZE;
const MAX_REQUESTS: usize = MAX_PAGES + 8;
const TOTAL_TIME: Duration = Duration::from_secs(90);
const HASH_UNKNOWN: &str = "update:modrinth-hash-unknown";
const CANCELLED: &str = "资源更新检测已取消 / 資源更新檢測已取消 / Resource update detection cancelled";
const TIMED_OUT: &str = "资源更新检测总时限已到 / 資源更新檢測總時限已到 / Resource update detection timed out";

fn invalid() -> String { "官方资源更新元数据无效或不一致 / 官方資源更新中繼資料無效或不一致 / Invalid or inconsistent official resource update metadata".into() }
fn limited() -> String { "资源更新查询超过安全预算，结果未确认 / 資源更新查詢超過安全預算，結果未確認 / Resource update query exceeded its safety budget; result unconfirmed".into() }
fn stopped(cancel: &Arc<AtomicBool>) -> Result<()> { if cancel.load(Ordering::Acquire) { Err(CANCELLED.into()) } else { Ok(()) } }
fn digest(value: &str, length: usize) -> Result<String> {
    if value.len() != length || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err(invalid()); }
    Ok(value.to_ascii_lowercase())
}
fn word(value: &str) -> Result<&str> {
    if value.is_empty() || value.len() > 256 || !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'+')) { return Err(invalid()); }
    Ok(value)
}
fn label(value: &str) -> Result<String> {
    if value.is_empty() || value.len() > 1024 || value.chars().any(char::is_control) { return Err(invalid()); }
    Ok(value.to_owned())
}
fn known_loader(value: &str) -> bool { matches!(value, "fabric" | "quilt" | "forge" | "neoforge") }
fn strings<'a>(value: &'a Value, key: &str) -> Result<Vec<&'a str>> {
    let array = value.get(key).and_then(Value::as_array).ok_or_else(invalid)?;
    if array.len() > 1024 { return Err(limited()); }
    array.iter().map(|item| item.as_str().filter(|item| !item.is_empty() && item.len() <= 256 && !item.chars().any(char::is_control)).ok_or_else(invalid)).collect()
}
fn validate_input(input: &LocalQuery) -> Result<()> {
    if !input.path.is_absolute() || input.path.to_str().is_none() || input.path.components().any(|part| matches!(part, std::path::Component::ParentDir | std::path::Component::CurDir)) { return Err(invalid()); }
    super::leaf(&input.filename).map_err(|_| invalid())?;
    if input.size == 0 || input.size > FILE_CAP { return Err(invalid()); }
    digest(&input.sha1, 40)?; digest(&input.sha512, 128)?;
    word(&input.mc_version)?;
    if input.kind == ResourceKind::Mod && !input.loader.as_deref().is_some_and(known_loader) {
        return Err("模组更新需要已确认的实际加载器 / 模組更新需要已確認的實際載入器 / Mod updates require a verified instance loader".into());
    }
    if input.shader_runtimes.len() > 32 || input.shader_runtimes.iter().any(|runtime| word(runtime).is_err()) { return Err(invalid()); }
    // filename 是扫描器剥离 .disabled 后的逻辑文件名，enabled 单独保留状态。
    Ok(())
}

trait Transport: Sync {
    fn request<'a>(&'a self, url: Url, settings: &'a Value, curseforge: bool, method: Method, body: Option<Value>) -> Pin<Box<dyn Future<Output = Result<Value>> + Send + 'a>>;
}
struct Official;
impl Transport for Official {
    fn request<'a>(&'a self, url: Url, settings: &'a Value, curseforge: bool, method: Method, body: Option<Value>) -> Pin<Box<dyn Future<Output = Result<Value>> + Send + 'a>> {
        Box::pin(remote_request(url, settings, curseforge, method, body))
    }
}
// 统计序列化大小而不再复制响应，限制跨页累计保留的官方元数据。
struct JsonBudget(usize);
impl std::io::Write for JsonBudget {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self.0.checked_add(bytes.len()).filter(|size| *size <= 16 * 1024 * 1024)
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "metadata budget"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}
type PolicyCheck = Arc<dyn Fn() -> Result<()> + Send + Sync>;
struct Session<'a, T> { transport: &'a T, settings: &'a Value, cancel: &'a Arc<AtomicBool>, policy_check: PolicyCheck, started: Instant, requests: usize, metadata_bytes: usize }
impl<'a, T: Transport> Session<'a, T> {
    fn new(transport: &'a T, settings: &'a Value, cancel: &'a Arc<AtomicBool>, policy_check: PolicyCheck) -> Self { Self { transport, settings, cancel, policy_check, started: Instant::now(), requests: 0, metadata_bytes: 0 } }
    fn check(&self) -> Result<()> {
        stopped(self.cancel)?;
        (self.policy_check)()?;
        if self.started.elapsed() >= TOTAL_TIME { return Err(TIMED_OUT.into()); }
        Ok(())
    }
    async fn request(&mut self, url: Url, curseforge: bool, method: Method, body: Option<Value>) -> Result<Value> {
        self.check()?;
        if self.requests >= MAX_REQUESTS { return Err(limited()); }
        let remaining = TOTAL_TIME.checked_sub(self.started.elapsed()).ok_or(TIMED_OUT)?;
        self.requests += 1;
        let query = self.transport.request(url, self.settings, curseforge, method, body);
        tokio::pin!(query);
        let cancel = self.cancel.clone();
        let cancellation = async move { loop { stopped(&cancel)?; tokio::time::sleep(Duration::from_millis(20)).await; } #[allow(unreachable_code)] Ok::<(), String>(()) };
        tokio::select! {
            biased;
            result = cancellation => { result?; Err(CANCELLED.into()) },
            _ = tokio::time::sleep(remaining) => Err(TIMED_OUT.into()),
            result = &mut query => {
                self.check()?;
                let value = result?;
                let mut budget = JsonBudget(0);
                serde_json::to_writer(&mut budget, &value).map_err(|_| limited())?;
                self.metadata_bytes = self.metadata_bytes.checked_add(budget.0).filter(|size| *size <= 64 * 1024 * 1024).ok_or_else(limited)?;
                Ok(value)
            },
        }
    }
    async fn get(&mut self, url: Url, curseforge: bool) -> Result<Value> { self.request(url, curseforge, Method::GET, None).await }
}

#[derive(Clone)]
struct FileMeta { filename: String, url: String, size: u64, sha1: Option<String>, sha512: Option<String> }
#[derive(Clone)]
struct Candidate { id: String, version: String, date: chrono::DateTime<chrono::FixedOffset>, file: FileMeta, dependencies: Vec<Value> }
fn published(value: &str) -> Result<chrono::DateTime<chrono::FixedOffset>> { chrono::DateTime::parse_from_rfc3339(value).map_err(|_| invalid()) }
fn decoded_segment(value: &str) -> Result<String> {
    let raw = value.as_bytes(); let mut bytes = Vec::with_capacity(raw.len()); let mut index = 0;
    while index < raw.len() {
        if raw[index] == b'%' {
            if index + 2 >= raw.len() { return Err(invalid()); }
            let high = (raw[index + 1] as char).to_digit(16).ok_or_else(invalid)?;
            let low = (raw[index + 2] as char).to_digit(16).ok_or_else(invalid)?;
            bytes.push((high * 16 + low) as u8); index += 3;
        } else { bytes.push(raw[index]); index += 1; }
    }
    String::from_utf8(bytes).map_err(|_| invalid())
}
fn dependencies(version: &Value, source: &str) -> Result<Vec<Value>> {
    let Some(raw) = version.get("dependencies") else { return Ok(Vec::new()); };
    let rows = raw.as_array().filter(|rows| rows.len() <= 1024).ok_or_else(invalid)?;
    rows.iter().map(|row| {
        let mut object = row.as_object().cloned().ok_or_else(invalid)?;
        object.insert("source".into(), json!(source));
        if source == "curseforge" {
            let project = row.get("modId").and_then(Value::as_u64).filter(|id| *id > 0).ok_or_else(invalid)?;
            let relation = row.get("relationType").and_then(Value::as_u64).ok_or_else(invalid)?;
            let relation = match relation { 1 => "embedded", 2 => "optional", 3 => "required", 4 => "tool", 5 => "incompatible", 6 => "include", _ => return Err(invalid()) };
            object.insert("project_id".into(), json!(project.to_string()));
            object.insert("dependency_type".into(), json!(relation));
        }
        Ok(Value::Object(object))
    }).collect()
}
fn output(input: &LocalQuery, source: &str, project: &str, slug: &str, title: &str, current: String, latest: Candidate) -> Result<DetectedUpdate> {
    let path = input.path.to_str().ok_or_else(invalid)?.to_owned();
    Ok(DetectedUpdate {
        info: UpdateInfo { path, kind: input.kind, current_version: current, latest_version: latest.version, file_url: latest.file.url, filename: latest.file.filename, slug: label(slug)?, title: label(title)?, size: latest.file.size },
        source: source.into(), project_id: project.into(), version_id: latest.id,
        sha1: latest.file.sha1, sha512: latest.file.sha512, dependencies: latest.dependencies,
    })
}
fn local_match(file: &FileMeta, input: &LocalQuery, require_sha512: bool) -> Result<()> {
    if file.size != input.size || file.sha1.as_ref().is_some_and(|hash| !hash.eq_ignore_ascii_case(&input.sha1))
        || file.sha512.as_ref().is_some_and(|hash| !hash.eq_ignore_ascii_case(&input.sha512))
        || require_sha512 && file.sha512.as_ref().map_or(true, |hash| !hash.eq_ignore_ascii_case(&input.sha512))
        || !require_sha512 && file.sha1.as_ref().map_or(true, |hash| !hash.eq_ignore_ascii_case(&input.sha1)) { return Err(invalid()); }
    Ok(())
}
fn mr_file(file: &Value, project: &str, version: &str) -> Result<FileMeta> {
    let filename = label(text(file, "filename"))?; super::leaf(&filename).map_err(|_| invalid())?;
    let raw_url = text(file, "url"); let url = super::official_download_url(raw_url, "modrinth").map_err(|_| invalid())?;
    if url.host_str() != Some("cdn.modrinth.com") || raw_url.len() > 8192 || raw_url.chars().any(char::is_control)
        || url.port().is_some_and(|port| port != 443) || url.query().is_some() { return Err(invalid()); }
    let parts: Vec<_> = url.path_segments().ok_or_else(invalid)?.collect();
    if parts.len() != 5 || parts[0] != "data" || decoded_segment(parts[1])? != project || parts[2] != "versions" || decoded_segment(parts[3])? != version || decoded_segment(parts[4])? != filename { return Err(invalid()); }
    let hashes = file.get("hashes").and_then(Value::as_object).ok_or_else(invalid)?;
    let sha1 = hashes.get("sha1").map(|hash| hash.as_str().ok_or_else(invalid).and_then(|hash| digest(hash, 40))).transpose()?;
    let sha512 = hashes.get("sha512").map(|hash| hash.as_str().ok_or_else(invalid).and_then(|hash| digest(hash, 128))).transpose()?;
    if sha1.is_none() && sha512.is_none() { return Err(invalid()); }
    let size = file.get("size").and_then(Value::as_u64).filter(|size| *size > 0 && *size <= FILE_CAP).ok_or_else(invalid)?;
    Ok(FileMeta { filename, url: raw_url.into(), size, sha1, sha512 })
}
fn mr_type(project: &Value, kind: ResourceKind) -> Result<()> {
    if text(project, "project_type") != kind.as_str() { return Err(invalid()); }
    if project.get("client_side").and_then(Value::as_str) == Some("unsupported") { return Err(invalid()); }
    Ok(())
}
fn compatible_tags(input: &LocalQuery, games: &[&str], loaders: &[&str]) -> bool {
    if !games.contains(&input.mc_version.as_str()) { return false; }
    match input.kind {
        ResourceKind::Mod => input.loader.as_deref().is_some_and(|loader| loaders.iter().any(|tag| tag.eq_ignore_ascii_case(loader))),
        ResourceKind::ResourcePack => true,
        ResourceKind::Shader => {
            let runtimes: Vec<_> = loaders.iter().filter(|loader| matches!(loader.to_ascii_lowercase().as_str(), "iris" | "optifine" | "oculus" | "canvas" | "vanilla" | "minecraft")).collect();
            if runtimes.is_empty() { return false; }
            runtimes.iter().any(|runtime| matches!(runtime.to_ascii_lowercase().as_str(), "vanilla" | "minecraft") || input.shader_runtimes.iter().any(|installed| installed.eq_ignore_ascii_case(runtime)))
        }
    }
}
fn mr_candidate(version: &Value, input: &LocalQuery, project: &str) -> Result<Option<Candidate>> {
    if text(version, "project_id") != project { return Err(invalid()); }
    let id = word(text(version, "id"))?.to_owned();
    let games = strings(version, "game_versions")?; let loaders = strings(version, "loaders")?;
    if !matches!(text(version, "status"), "listed" | "archived") { return Ok(None); }
    if !compatible_tags(input, &games, &loaders) { return Ok(None); }
    let files = version.get("files").and_then(Value::as_array).filter(|files| !files.is_empty() && files.len() <= 256).ok_or_else(invalid)?;
    let mut selected = None; let mut names = BTreeSet::new(); let mut primary = false;
    for raw in files {
        let file = mr_file(raw, project, &id)?;
        if !names.insert(file.filename.to_lowercase()) { return Err(invalid()); }
        let is_primary = raw.get("primary").and_then(Value::as_bool).ok_or_else(invalid)?;
        if is_primary && primary { return Err(invalid()); }
        if selected.is_none() || is_primary { selected = Some(file); }
        primary |= is_primary;
    }
    Ok(Some(Candidate { id, version: label(text(version, "version_number"))?, date: published(text(version, "date_published"))?, file: selected.ok_or_else(invalid)?, dependencies: dependencies(version, "modrinth")? }))
}

fn mr_project_id(version: &Value) -> Result<&str> { word(text(version, "project_id")) }
fn select_mr_file(version: &Value, input: &LocalQuery, project: &str) -> Result<(String, FileMeta)> {
    if mr_project_id(version)? != project { return Err(invalid()); }
    let version_id = word(text(version, "id"))?.to_owned();
    // 当前文件由官方摘要确认；不要求它仍出现在当前实例的兼容筛选页。
    let files = version.get("files").and_then(Value::as_array).filter(|files| !files.is_empty() && files.len() <= 256).ok_or_else(invalid)?;
    let mut matching = Vec::new();
    for raw in files {
        let file = mr_file(raw, project, &version_id)?;
        if file.size == input.size && file.sha512.as_deref() == Some(input.sha512.to_ascii_lowercase().as_str()) {
            local_match(&file, input, true)?;
            matching.push(file);
        }
    }
    if matching.len() != 1 { return Err(invalid()); }
    Ok((version_id, matching.remove(0)))
}
async fn mr_version_by_hash<T: Transport>(session: &mut Session<'_, T>, input: &LocalQuery) -> Result<Value> {
    let hash = digest(&input.sha512, 128)?;
    let mut url = endpoint(MR, &["version_file", &hash])?;
    url.query_pairs_mut().append_pair("algorithm", "sha512");
    match session.get(url, false).await {
        Err(error) if error == "资源项目或版本不存在（HTTP 404）" => Err(HASH_UNKNOWN.into()),
        result => result,
    }
}
async fn mr_project<T: Transport>(session: &mut Session<'_, T>, project_id: &str, kind: ResourceKind) -> Result<Value> {
    let raw = session.get(endpoint(MR, &["project", project_id])?, false).await?;
    if word(text(&raw, "id"))? != project_id { return Err(invalid()); }
    mr_type(&raw, kind)?;
    Ok(raw)
}
fn mr_version_url(project: &str, input: &LocalQuery) -> Result<Url> {
    let loaders = if input.kind == ResourceKind::Mod { vec![input.loader.as_deref().ok_or_else(invalid)?] } else { Vec::new() };
    let mut url = endpoint(MR, &["project", project, "version"])?;
    let mut query = url.query_pairs_mut();
    if !loaders.is_empty() { query.append_pair("loaders", &json!(loaders).to_string()); }
    query.append_pair("game_versions", &json!([input.mc_version]).to_string());
    drop(query); Ok(url)
}
async fn detect_modrinth<T: Transport>(session: &mut Session<'_, T>, input: &LocalQuery) -> Result<Option<DetectedUpdate>> {
    let local_version = mr_version_by_hash(session, input).await?;
    let local_id = word(text(&local_version, "id"))?.to_owned();
    let project_id = mr_project_id(&local_version)?.to_owned();
    let project = mr_project(session, &project_id, input.kind).await?;
    let project_slug = word(text(&project, "slug"))?;
    let project_title = label(text(&project, "title"))?;
    let (confirmed_id, local_file) = select_mr_file(&local_version, input, &project_id)?;
    if confirmed_id != local_id { return Err(invalid()); }
    let current = label(text(&local_version, "version_number"))?;
    let current_date = published(text(&local_version, "date_published"))?;
    let versions = session.get(mr_version_url(&project_id, input)?, false).await?;
    let rows = versions.as_array().ok_or_else(invalid)?;
    if rows.len() >= MAX_ITEMS { return Err(limited()); }
    let mut compatible = Vec::new();
    let mut ids = BTreeSet::new();
    for version in rows {
        session.check()?;
        let id = word(text(version, "id"))?;
        if !ids.insert(id) { return Err(invalid()); }
        if id == local_id {
            select_mr_file(version, input, &project_id)?;
            if published(text(version, "date_published"))? != current_date { return Err(invalid()); }
        }
        if let Some(candidate) = mr_candidate(version, input, &project_id)? { compatible.push(candidate); }
    }
    compatible.sort_by(|left, right| right.date.cmp(&left.date).then_with(|| left.id.cmp(&right.id)));
    session.check()?;
    let Some(latest) = compatible.first() else { return Ok(None); };
    if latest.date <= current_date || latest.id == local_id { return Ok(None); }
    if latest.file.size == input.size && (latest.file.sha512.as_deref() == Some(input.sha512.to_ascii_lowercase().as_str())
        || latest.file.sha1.as_deref() == Some(input.sha1.to_ascii_lowercase().as_str())) { return Ok(None); }
    let latest = latest.clone();
    local_match(&local_file, input, true)?;
    Ok(Some(output(input, "modrinth", &project_id, project_slug, &project_title, current, latest)?))
}

fn cf_hashes(file: &Value) -> Result<(Option<String>, Option<String>)> {
    let rows = file.get("hashes").and_then(Value::as_array).ok_or_else(invalid)?;
    if rows.len() > 32 { return Err(limited()); }
    let mut sha1 = None; let mut md5 = None;
    for row in rows {
        let Some(algo) = row.get("algo").and_then(Value::as_u64) else { return Err(invalid()); };
        let raw = row.get("value").and_then(Value::as_str).ok_or_else(invalid)?;
        match algo {
            1 => { let value = digest(raw, 40)?; if sha1.replace(value.clone()).is_some_and(|old| old != value) { return Err(invalid()); } }
            2 => { let value = digest(raw, 32)?; if md5.replace(value.clone()).is_some_and(|old| old != value) { return Err(invalid()); } }
            _ => {}
        }
    }
    Ok((sha1, md5))
}
fn cf_file(file: &Value, project_id: u64, _kind: ResourceKind, require_available: bool) -> Result<FileMeta> {
    // 官方 File 只有 gameId/modId；资源类别由已核验的 Mod.classId 绑定。
    if file.get("modId").and_then(Value::as_u64) != Some(project_id)
        || file.get("gameId").and_then(Value::as_u64) != Some(432) { return Err(invalid()); }
    if require_available && file.get("isAvailable").and_then(Value::as_bool) != Some(true) { return Err(invalid()); }
    let filename = label(text(file, "fileName"))?; super::leaf(&filename).map_err(|_| invalid())?;
    let raw_url = text(file, "downloadUrl");
    if raw_url.is_empty() { return Err(invalid()); }
    let url = super::official_download_url(raw_url, "curseforge").map_err(|_| invalid())?;
    if raw_url.len() > 8192 || raw_url.chars().any(char::is_control) || url.port().is_some_and(|port| port != 443) || super::curseforge_file_id_from_url(&url)? != file.get("id").and_then(Value::as_u64).ok_or_else(invalid)? { return Err(invalid()); }
    let size = file.get("fileLength").and_then(Value::as_u64).filter(|size| *size > 0 && *size <= FILE_CAP).ok_or_else(invalid)?;
    let (sha1, _) = cf_hashes(file)?;
    let sha1 = sha1.ok_or_else(invalid)?;
    Ok(FileMeta { filename, url: raw_url.into(), size, sha1: Some(sha1), sha512: None })
}
fn cf_class(kind: ResourceKind) -> u64 { match kind { ResourceKind::Mod => 6, ResourceKind::ResourcePack => 12, ResourceKind::Shader => 6552 } }
fn cf_runtime_supported(input: &LocalQuery, file: &Value) -> Result<bool> {
    if input.kind != ResourceKind::Shader { return Ok(true); }
    let tags = strings(file, "gameVersions")?;
    let requirements: Vec<_> = tags.iter().map(|tag| tag.to_ascii_lowercase()).filter(|tag| matches!(tag.as_str(), "iris" | "optifine" | "oculus" | "canvas" | "vanilla" | "minecraft")).collect();
    if requirements.is_empty() { return Ok(false); }
    Ok(requirements.iter().any(|runtime| matches!(runtime.as_str(), "vanilla" | "minecraft") || input.shader_runtimes.iter().any(|installed| installed.eq_ignore_ascii_case(runtime))))
}
fn cf_compatible(input: &LocalQuery, file: &Value) -> Result<bool> {
    let tags = strings(file, "gameVersions")?;
    if !tags.iter().any(|tag| *tag == input.mc_version) { return Ok(false); }
    if input.kind == ResourceKind::Mod {
        let wanted = input.loader.as_deref().ok_or_else(invalid)?;
        let loader_tags: Vec<_> = tags.iter().filter(|tag| loader_id(tag).is_some()).collect();
        if !loader_tags.iter().any(|tag| tag.eq_ignore_ascii_case(wanted)) { return Ok(false); }
    }
    cf_runtime_supported(input, file)
}
fn cf_candidate(file: &Value, project: &Value, project_id: u64, input: &LocalQuery) -> Result<Option<Candidate>> {
    let project_kind = project.get("classId").and_then(Value::as_u64).ok_or_else(invalid)?;
    if project_kind != cf_class(input.kind) || project.get("gameId").and_then(Value::as_u64) != Some(432) { return Err(invalid()); }
    if project.get("allowModDistribution").and_then(Value::as_bool) != Some(true) { return Err("CurseForge 项目未明确允许分发 / CurseForge 專案未明確允許分發 / CurseForge project is not explicitly distributable".into()); }
    if !cf_compatible(input, file)? || file.get("isAvailable").and_then(Value::as_bool) != Some(true) { return Ok(None); }
    let meta = cf_file(file, project_id, input.kind, true)?;
    let date = published(text(file, "fileDate"))?;
    let id = file.get("id").and_then(Value::as_u64).filter(|id| *id > 0).ok_or_else(invalid)?.to_string();
    let version = if text(file, "displayName").is_empty() { meta.filename.clone() } else { label(text(file, "displayName"))? };
    Ok(Some(Candidate { id, version, date, file: meta, dependencies: dependencies(file, "curseforge")? }))
}
async fn cf_project<T: Transport>(session: &mut Session<'_, T>, id: u64, kind: ResourceKind) -> Result<Value> {
    let raw = session.get(endpoint(CF, &["mods", &id.to_string()])?, true).await?;
    let project = raw.get("data").filter(|data| data.is_object()).ok_or_else(invalid)?;
    if project.get("id").and_then(Value::as_u64) != Some(id) || project.get("gameId").and_then(Value::as_u64) != Some(432)
        || project.get("classId").and_then(Value::as_u64) != Some(cf_class(kind)) { return Err(invalid()); }
    if project.get("allowModDistribution").and_then(Value::as_bool) != Some(true) { return Err("CurseForge 项目未明确允许分发 / CurseForge 專案未明確允許分發 / CurseForge project is not explicitly distributable".into()); }
    Ok(project.clone())
}
fn cf_fingerprint_url() -> Result<Url> { endpoint(CF, &["fingerprints", "432"]) }
async fn cf_fingerprint<T: Transport>(session: &mut Session<'_, T>, input: &LocalQuery) -> Result<Option<(u64, Value, FileMeta)>> {
    let reply = session.request(cf_fingerprint_url()?, true, Method::POST, Some(json!({"fingerprints":[input.fingerprint]}))).await?;
    let data = reply.get("data").filter(|data| data.is_object()).ok_or_else(invalid)?;
    let matches = data.get("exactMatches").and_then(Value::as_array).filter(|items| items.len() <= 64).ok_or_else(invalid)?;
    // 合法空列表仅表示官方未识别此文件；非空列表仍须唯一确认完整身份。
    if matches.is_empty() { return Ok(None); }
    let mut confirmed = Vec::new();
    for item in matches {
        let Some(file) = item.get("file") else { return Err(invalid()); };
        let Some(project_id) = file.get("modId").and_then(Value::as_u64).filter(|id| *id > 0) else { return Err(invalid()); };
        if file.get("fileLength").and_then(Value::as_u64) != Some(input.size) { continue; }
        let (sha1, _) = cf_hashes(file)?;
        if sha1.as_deref() != Some(input.sha1.to_ascii_lowercase().as_str()) { continue; }
        if file.get("id").and_then(Value::as_u64).is_none() { return Err(invalid()); }
        if item.get("id").and_then(Value::as_u64) != Some(project_id) || file.get("fileFingerprint").and_then(Value::as_u64) != Some(input.fingerprint as u64) { return Err(invalid()); }
        let meta = cf_file(file, project_id, input.kind, false)?;
        local_match(&meta, input, false)?;
        confirmed.push((project_id, file.clone(), meta));
    }
    if confirmed.len() != 1 { return Err("指纹未能唯一确认本地 CurseForge 文件身份 / 指紋未能唯一確認本機 CurseForge 檔案身分 / Fingerprint did not uniquely identify the local CurseForge file".into()); }
    let (project_id, file, meta) = confirmed.remove(0);
    Ok(Some((project_id, file, meta)))
}
async fn cf_pages<T: Transport>(session: &mut Session<'_, T>, project_id: u64, input: &LocalQuery) -> Result<Vec<Value>> {
    let mut all = Vec::new();
    let mut ids = BTreeSet::new();
    let mut expected_total = None;
    for page in 0..MAX_PAGES {
        stopped(session.cancel)?;
        let offset = page * PAGE_SIZE;
        let mut url = endpoint(CF, &["mods", &project_id.to_string(), "files"])?;
        {
            let mut query = url.query_pairs_mut(); query.append_pair("pageSize", &PAGE_SIZE.to_string()).append_pair("index", &offset.to_string()).append_pair("gameVersion", &input.mc_version);
            if input.kind == ResourceKind::Mod { query.append_pair("modLoaderType", &loader_id(input.loader.as_deref().ok_or_else(invalid)?).ok_or_else(invalid)?.to_string()); }
        }
        let raw = session.get(url, true).await?;
        let data = raw.get("data").and_then(Value::as_array).filter(|rows| rows.len() <= PAGE_SIZE).ok_or_else(invalid)?;
        let pagination = raw.get("pagination").and_then(Value::as_object).ok_or_else(invalid)?;
        let index = pagination.get("index").and_then(Value::as_u64).ok_or_else(invalid)?;
        let page_size = pagination.get("pageSize").and_then(Value::as_u64).ok_or_else(invalid)?;
        let result_count = pagination.get("resultCount").and_then(Value::as_u64).ok_or_else(invalid)?;
        let total_count = pagination.get("totalCount").and_then(Value::as_u64).ok_or_else(invalid)?;
        if index != offset as u64 || page_size != PAGE_SIZE as u64 || result_count != data.len() as u64 || total_count < offset as u64 + result_count { return Err(invalid()); }
        if expected_total.replace(total_count).is_some_and(|old| old != total_count) { return Err(invalid()); }
        if total_count > MAX_ITEMS as u64 { return Err(limited()); }
        for file in data {
            if file.get("modId").and_then(Value::as_u64) != Some(project_id) { return Err(invalid()); }
            let id = file.get("id").and_then(Value::as_u64).filter(|id| *id > 0).ok_or_else(invalid)?;
            if !ids.insert(id) { return Err(invalid()); }
            all.push(file.clone());
        }
        let next = offset as u64 + result_count;
        if next == total_count {
            if all.len() as u64 != total_count { return Err(invalid()); }
            return Ok(all);
        }
        if result_count != PAGE_SIZE as u64 || next > total_count { return Err(invalid()); }
    }
    Err(limited())
}
async fn detect_curseforge<T: Transport>(session: &mut Session<'_, T>, input: &LocalQuery) -> Result<Option<DetectedUpdate>> {
    let Some((project_id, fingerprint_raw, fingerprint_file)) = cf_fingerprint(session, input).await? else { return Ok(None) };
    let project = cf_project(session, project_id, input.kind).await?;
    let current_id = fingerprint_raw.get("id").and_then(Value::as_u64).filter(|id| *id > 0).ok_or_else(invalid)?;
    // 当前版本须单独按同项目文件端点复核；不能因兼容页省略它便误报无更新。
    let reply = session.get(endpoint(CF, &["mods", &project_id.to_string(), "files", &current_id.to_string()])?, true).await?;
    let current_raw = reply.get("data").filter(|value| value.is_object()).ok_or_else(invalid)?;
    if current_raw.get("id").and_then(Value::as_u64) != Some(current_id) { return Err(invalid()); }
    let current_file = cf_file(current_raw, project_id, input.kind, false)?;
    local_match(&current_file, input, false)?;
    if current_file.sha1 != fingerprint_file.sha1 || current_file.size != fingerprint_file.size
        || current_file.filename != fingerprint_file.filename || current_file.url != fingerprint_file.url { return Err(invalid()); }
    let current_date = published(text(current_raw, "fileDate"))?;
    let current = if text(current_raw, "displayName").is_empty() { current_file.filename.clone() } else { label(text(current_raw, "displayName"))? };
    let candidates_raw = cf_pages(session, project_id, input).await?;
    let mut candidates = Vec::new();
    for file in &candidates_raw {
        session.check()?;
        if file.get("id").and_then(Value::as_u64) == Some(current_id) {
            let repeated = cf_file(file, project_id, input.kind, false)?;
            local_match(&repeated, input, false)?;
            if published(text(file, "fileDate"))? != current_date { return Err(invalid()); }
        }
        if let Some(candidate) = cf_candidate(file, &project, project_id, input)? { candidates.push(candidate); }
    }
    candidates.sort_by(|left, right| right.date.cmp(&left.date).then_with(|| left.id.cmp(&right.id)));
    session.check()?;
    let Some(latest) = candidates.first() else { return Ok(None); };
    if latest.date <= current_date || latest.id == current_id.to_string() { return Ok(None); }
    if latest.file.sha1 == current_file.sha1 && latest.file.size == current_file.size { return Ok(None); }
    Ok(Some(output(input, "curseforge", &project_id.to_string(), text(&project, "slug"), text(&project, "name"), current, latest.clone())?))
}

async fn detect_with<T: Transport>(transport: &T, input: &LocalQuery, settings: &Value, cancel: &Arc<AtomicBool>, policy_check: PolicyCheck) -> Result<Option<DetectedUpdate>> {
    stopped(cancel)?;
    policy_check()?;
    validate_input(input)?;
    if super::online(settings).is_err() || settings.get("metadataOnlyMods").and_then(Value::as_bool) == Some(true) {
        return Err("当前模式禁止在线资源更新检测 / 目前模式禁止線上資源更新檢測 / Online resource update checks are disabled in the current mode".into());
    }
    let mut session = Session::new(transport, settings, cancel, policy_check);
    let result = match detect_modrinth(&mut session, input).await {
        Ok(update) => Ok(update),
        Err(error) if error == HASH_UNKNOWN => {
            session.check()?;
            // 单个文件的官方校验不通过（如 Modrinth 项目声明 client_side 不支持、
            // CurseForge 元数据与本地不一致）只说明该文件无法确认更新，不应让
            // 整个实例的更新检测失败；传输层错误、超时与取消除外。
            match detect_curseforge(&mut session, input).await {
                Err(error) if error == invalid() => Ok(None),
                other => other,
            }
        },
        // 官方项目存在但不符合本客户端更新条件（类型不符、client_side 不支持等），
        // 视为无更新而不是元数据损坏。
        Err(error) if error == invalid() => Ok(None),
        Err(error) => Err(error),
    };
    session.check()?;
    result
}

pub(crate) async fn detect(input: &LocalQuery, settings: &Value, cancel: &Arc<AtomicBool>) -> Result<Option<DetectedUpdate>> {
    detect_guarded(input, settings, cancel, Arc::new(|| Ok(()))).await
}

/// gate 仅阻止后续派发和结果采用，不能承诺撤销已发出的 HTTP 请求。
pub(crate) async fn detect_guarded(input: &LocalQuery, settings: &Value, cancel: &Arc<AtomicBool>, policy_check: Arc<dyn Fn() -> std::result::Result<(), String> + Send + Sync>) -> Result<Option<DetectedUpdate>> {
    detect_with(&Official, input, settings, cancel, policy_check).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::VecDeque, sync::{atomic::AtomicUsize, Mutex}};
    use tokio::sync::oneshot;

    struct FixtureTransport { replies: Mutex<VecDeque<Result<Value>>>, requests: Mutex<Vec<(Url, bool, Method, Option<Value>)>> }
    impl FixtureTransport {
        fn new(replies: Vec<Result<Value>>) -> Self { Self { replies: Mutex::new(replies.into()), requests: Mutex::new(Vec::new()) } }
        fn requests(&self) -> Vec<(Url, bool, Method, Option<Value>)> { self.requests.lock().unwrap().clone() }
    }
    impl Transport for FixtureTransport {
        fn request<'a>(&'a self, url: Url, _settings: &'a Value, curseforge: bool, method: Method, body: Option<Value>) -> Pin<Box<dyn Future<Output = Result<Value>> + Send + 'a>> {
            self.requests.lock().unwrap().push((url, curseforge, method, body));
            let reply = self.replies.lock().unwrap().pop_front().unwrap_or_else(|| Err("fixture response missing".into()));
            Box::pin(async move { reply })
        }
    }

    struct PendingTransport { started: Mutex<Option<oneshot::Sender<()>>>, requests: AtomicUsize }
    impl Transport for PendingTransport {
        fn request<'a>(&'a self, _url: Url, _settings: &'a Value, _curseforge: bool, _method: Method, _body: Option<Value>) -> Pin<Box<dyn Future<Output = Result<Value>> + Send + 'a>> {
            self.requests.fetch_add(1, Ordering::AcqRel);
            if let Some(started) = self.started.lock().unwrap().take() { let _ = started.send(()); }
            Box::pin(std::future::pending())
        }
    }

    fn fixture_input() -> LocalQuery {
        LocalQuery { kind: ResourceKind::Mod, path: std::env::temp_dir().join("hcmcl-update-fixture").join("mods").join("sample.jar"), filename: "sample.jar".into(), enabled: true,
            size: 10, sha1: "a".repeat(40), sha512: "b".repeat(128), fingerprint: 17, mc_version: "1.20.1".into(), loader: Some("fabric".into()), shader_runtimes: Vec::new() }
    }
    fn fixture_cf_file(id: u64, project: u64, filename: &str, sha1: &str, date: &str) -> Value {
        json!({"id":id,"gameId":432,"modId":project,"isAvailable":true,"fileName":filename,
            "downloadUrl":format!("https://edge.forgecdn.net/files/{}/{:03}/{}", id / 1000, id % 1000, filename),
            "fileLength":10,"hashes":[{"algo":1,"value":sha1}],"gameVersions":["1.20.1","Fabric"],
            "fileDate":date,"displayName":filename,"fileFingerprint":17,"dependencies":[]})
    }
    fn cf_page(index: u64, files: Vec<Value>, total: u64) -> Value {
        let count = files.len();
        json!({"data":files,"pagination":{"index":index,"pageSize":PAGE_SIZE,"resultCount":count,"totalCount":total}})
    }
    fn mr_file(project: &str, version: &str, filename: &str, sha1: &str, sha512: &str) -> Value {
        json!({"filename":filename,"url":format!("https://cdn.modrinth.com/data/{project}/versions/{version}/{filename}"),
            "size":10,"hashes":{"sha1":sha1,"sha512":sha512},"primary":true})
    }
    fn mr_version(id: &str, number: &str, date: &str, sha1: &str, sha512: &str) -> Value {
        json!({"id":id,"project_id":"sample-project","version_number":number,"date_published":date,"status":"listed",
            "game_versions":["1.20.1"],"loaders":["fabric"],"files":[mr_file("sample-project",id,"sample.jar",sha1,sha512)],"dependencies":[]})
    }
    fn mr_project() -> Value {
        json!({"id":"sample-project","project_type":"mod","client_side":"required","slug":"sample","title":"Sample Mod"})
    }

    #[tokio::test]
    async fn policy_gate_blocks_before_request_and_after_inflight_response() {
        let input = fixture_input(); let cancel = Arc::new(AtomicBool::new(false)); let settings = json!({});
        let no_requests = FixtureTransport::new(vec![]);
        let closed: PolicyCheck = Arc::new(|| Err("policy changed".into()));
        assert!(detect_with(&no_requests, &input, &settings, &cancel, closed).await.unwrap_err().contains("policy changed"));
        assert!(no_requests.requests().is_empty());

        let in_flight = FixtureTransport::new(vec![Err("fixture HTTP failure".into())]);
        let checks = Arc::new(AtomicUsize::new(0)); let observed = checks.clone();
        let gate: PolicyCheck = Arc::new(move || { if observed.fetch_add(1, Ordering::AcqRel) >= 2 { Err("policy changed after response".into()) } else { Ok(()) } });
        assert!(detect_with(&in_flight, &input, &settings, &cancel, gate).await.unwrap_err().contains("policy changed after response"));
        assert_eq!(in_flight.requests().len(), 1);
    }

    #[tokio::test]
    async fn cancellation_stops_a_pending_readonly_request() {
        let (started_tx, started_rx) = oneshot::channel();
        let transport = Arc::new(PendingTransport { started: Mutex::new(Some(started_tx)), requests: AtomicUsize::new(0) });
        let input = fixture_input(); let cancel = Arc::new(AtomicBool::new(false)); let settings = json!({});
        let worker_transport = transport.clone(); let worker_input = input.clone(); let worker_cancel = cancel.clone();
        let worker = tokio::spawn(async move { detect_with(&*worker_transport, &worker_input, &settings, &worker_cancel, Arc::new(|| Ok(()))).await });
        started_rx.await.unwrap();
        cancel.store(true, Ordering::Release);
        assert!(worker.await.unwrap().unwrap_err().contains("cancelled"));
        assert_eq!(transport.requests.load(Ordering::Acquire), 1);
    }

    #[tokio::test]
    async fn ineligible_official_project_means_no_update_not_a_batch_error() {
        let input = fixture_input();
        let current = mr_version("current", "1.0.0", "2025-01-01T00:00:00Z", &input.sha1, &input.sha512);
        // 项目声明 client_side 不支持（真实回归：Almanac 等 server_only 库被 mr_type
        // 判为 invalid，进而让整批更新检测失败）→ 应降级为「无更新」而不是报错。
        let unsupported = json!({"id":"sample-project","project_type":"mod","slug":"sample","title":"Sample Mod","client_side":"unsupported"});
        let transport = FixtureTransport::new(vec![Ok(current), Ok(unsupported)]);
        let cancel = Arc::new(AtomicBool::new(false)); let settings = json!({});
        let result = detect_with(&transport, &input, &settings, &cancel, Arc::new(|| Ok(()))).await.unwrap();
        assert!(result.is_none());
        assert_eq!(transport.requests().len(), 2);

        // CurseForge 腿同样：指纹命中但项目类别与本地资源类型不符（invalid）只表示
        // 该文件无法确认更新，不报错、也不再有后续请求。
        let settings = json!({"curseforgeApiKey":"fixture"});
        let current = fixture_cf_file(1234, 55, "sample.jar", &input.sha1, "2025-01-01T00:00:00Z");
        let fingerprint = json!({"data":{"exactMatches":[{"id":55,"file":current}]}});
        let mismatched = json!({"data":{"id":55,"gameId":432,"classId":4471,"allowModDistribution":true,"slug":"sample","name":"Sample Mod"}});
        let cf_transport = FixtureTransport::new(vec![
            Err("资源项目或版本不存在（HTTP 404）".into()),
            Ok(fingerprint), Ok(mismatched),
        ]);
        assert!(detect_with(&cf_transport, &input, &settings, &cancel, Arc::new(|| Ok(()))).await.unwrap().is_none());
        assert_eq!(cf_transport.requests().len(), 3);
    }

    #[tokio::test]
    async fn modrinth_detection_confirms_local_hash_and_returns_only_new_compatible_file() {
        let input = fixture_input();
        let current = mr_version("current", "1.0.0", "2025-01-01T00:00:00Z", &input.sha1, &input.sha512);
        let latest = mr_version("latest", "2.0.0", "2025-02-01T00:00:00Z", &"c".repeat(40), &"d".repeat(128));
        let transport = FixtureTransport::new(vec![Ok(current), Ok(mr_project()), Ok(json!([latest]))]);
        let cancel = Arc::new(AtomicBool::new(false)); let settings = json!({});
        let result = detect_with(&transport, &input, &settings, &cancel, Arc::new(|| Ok(()))).await.unwrap().unwrap();
        assert_eq!(result.info.latest_version, "2.0.0");
        assert_eq!(result.info.filename, "sample.jar");
        assert_eq!(result.source, "modrinth");
        assert_eq!(result.project_id, "sample-project");
        assert_eq!(transport.requests().len(), 3);
        assert!(transport.requests().iter().all(|(_, curseforge, _, _)| !curseforge));
    }

    #[tokio::test]
    async fn modrinth_same_file_hash_is_not_reported_as_an_update_and_forged_current_means_no_update() {
        let input = fixture_input();
        let current = mr_version("current", "1.0.0", "2025-01-01T00:00:00Z", &input.sha1, &input.sha512);
        let newer_same_bytes = mr_version("newer", "2.0.0", "2025-02-01T00:00:00Z", &input.sha1, &input.sha512);
        let transport = FixtureTransport::new(vec![Ok(current.clone()), Ok(mr_project()), Ok(json!([newer_same_bytes]))]);
        let cancel = Arc::new(AtomicBool::new(false)); let settings = json!({});
        assert!(detect_with(&transport, &input, &settings, &cancel, Arc::new(|| Ok(()))).await.unwrap().is_none());

        let forged = mr_version("current", "1.0.0", "2025-01-01T00:00:00Z", &"e".repeat(40), &"f".repeat(128));
        let mismatch = FixtureTransport::new(vec![Ok(forged), Ok(mr_project())]);
        // 当前版本的官方文件哈希与本地不一致：视为「无法确认更新」而不是整批报错。
        assert!(detect_with(&mismatch, &input, &settings, &cancel, Arc::new(|| Ok(()))).await.unwrap().is_none());
        assert_eq!(mismatch.requests().len(), 2);
    }

    #[tokio::test]
    async fn curseforge_detection_fingerprints_file_checks_distribution_and_returns_update() {
        let input = fixture_input();
        let current = fixture_cf_file(1234, 55, "sample.jar", &input.sha1, "2025-01-01T00:00:00Z");
        let latest = fixture_cf_file(2234, 55, "sample-new.jar", &"c".repeat(40), "2025-02-01T00:00:00Z");
        let project = json!({"data":{"id":55,"gameId":432,"classId":6,"allowModDistribution":true,"slug":"sample","name":"Sample Mod"}});
        let current_reply = json!({"data":current.clone()});
        let settings = json!({"curseforgeApiKey":"fixture"}); let cancel = Arc::new(AtomicBool::new(false));
        let fingerprint = json!({"data":{"exactMatches":[{"id":55,"file":current.clone()}]}});
        let transport = FixtureTransport::new(vec![Err("资源项目或版本不存在（HTTP 404）".into()), Ok(fingerprint.clone()), Ok(project.clone()), Ok(current_reply), Ok(cf_page(0, vec![latest], 1))]);
        let result = detect_with(&transport, &input, &settings, &cancel, Arc::new(|| Ok(()))).await.unwrap().unwrap();
        assert_eq!(result.source, "curseforge");
        assert_eq!(result.project_id, "55");
        assert_eq!(result.info.latest_version, "sample-new.jar");
        let requests = transport.requests();
        assert_eq!(requests.len(), 5);
        assert_eq!(requests[1].2, Method::POST);
        assert_eq!(requests[1].3, Some(json!({"fingerprints":[17]})));
        assert!(requests.iter().skip(1).all(|(_, curseforge, _, _)| *curseforge));

        let denied_project = json!({"data":{"id":55,"gameId":432,"classId":6,"allowModDistribution":false,"slug":"sample","name":"Sample Mod"}});
        let denied = FixtureTransport::new(vec![Err("资源项目或版本不存在（HTTP 404）".into()), Ok(fingerprint), Ok(denied_project)]);
        assert!(detect_with(&denied, &input, &settings, &cancel, Arc::new(|| Ok(()))).await.is_err());
        assert_eq!(denied.requests().len(), 3);
    }

    #[tokio::test]
    async fn curseforge_real_file_schema_mismatch_means_no_update_and_stops_requests() {
        let input = fixture_input();
        let settings = json!({"curseforgeApiKey":"fixture"});
        let cancel = Arc::new(AtomicBool::new(false));
        let current = fixture_cf_file(1234, 55, "sample.jar", &input.sha1, "2025-01-01T00:00:00Z");
        assert!(current.get("classId").is_none());
        let fingerprint = json!({"data":{"exactMatches":[{"id":55,"file":current.clone()}]}});
        let project = json!({"id":55,"gameId":432,"classId":6,"allowModDistribution":true,"slug":"sample","name":"Sample Mod"});
        let unknown_hash = || Err("资源项目或版本不存在（HTTP 404）".into());
        for class_id in [None, Some(json!(12)), Some(Value::Null)] {
            let mut invalid_project = project.clone();
            if let Some(class_id) = class_id { invalid_project["classId"] = class_id; } else { invalid_project.as_object_mut().unwrap().remove("classId"); }
            let transport = FixtureTransport::new(vec![unknown_hash(), Ok(fingerprint.clone()), Ok(json!({"data":invalid_project}))]);
            // 项目类别与本地资源类型不符：该文件无法确认更新（不报错、不继续请求）。
            assert!(detect_with(&transport, &input, &settings, &cancel, Arc::new(|| Ok(()))).await.unwrap().is_none());
            assert_eq!(transport.requests().len(), 3);
        }
        for game_id in [None, Some(json!(1))] {
            let mut invalid_file = current.clone();
            if let Some(game_id) = game_id { invalid_file["gameId"] = game_id; } else { invalid_file.as_object_mut().unwrap().remove("gameId"); }
            let invalid_fingerprint = json!({"data":{"exactMatches":[{"id":55,"file":invalid_file.clone()}]}});
            let transport = FixtureTransport::new(vec![unknown_hash(), Ok(invalid_fingerprint)]);
            assert!(detect_with(&transport, &input, &settings, &cancel, Arc::new(|| Ok(()))).await.unwrap().is_none());
            assert_eq!(transport.requests().len(), 2);
            let current_mismatch = FixtureTransport::new(vec![unknown_hash(), Ok(fingerprint.clone()), Ok(json!({"data":project.clone()})), Ok(json!({"data":invalid_file}))]);
            assert!(detect_with(&current_mismatch, &input, &settings, &cancel, Arc::new(|| Ok(()))).await.unwrap().is_none());
            assert_eq!(current_mismatch.requests().len(), 4);
        }
    }

    #[tokio::test]
    async fn curseforge_only_schema_valid_empty_fingerprints_mean_no_identified_update() {
        let input = fixture_input();
        let settings = json!({"curseforgeApiKey":"fixture"});
        let cancel = Arc::new(AtomicBool::new(false));
        let unknown_hash = || Err("资源项目或版本不存在（HTTP 404）".into());
        let empty = FixtureTransport::new(vec![unknown_hash(), Ok(json!({"data":{"exactMatches":[]}}))]);
        assert!(detect_with(&empty, &input, &settings, &cancel, Arc::new(|| Ok(()))).await.unwrap().is_none());
        let requests = empty.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[1].0.path(), "/v1/fingerprints/432");
        assert_eq!(requests[1].2, Method::POST);
        assert_eq!(requests[1].3, Some(json!({"fingerprints":[17]})));

        // 结构不完整的指纹响应一律视为「无法确认更新」（不报错、不继续请求）。
        for malformed in [json!({}), json!({"data":null}), json!({"data":[]}), json!({"data":{}}),
            json!({"data":{"exactMatches":null}}), json!({"data":{"exactMatches":{}}}), json!({"data":{"exactMatches":[null]}})] {
            let transport = FixtureTransport::new(vec![unknown_hash(), Ok(malformed)]);
            assert!(detect_with(&transport, &input, &settings, &cancel, Arc::new(|| Ok(()))).await.unwrap().is_none());
            assert_eq!(transport.requests().len(), 2);
        }

        let mismatch = fixture_cf_file(1234, 55, "sample.jar", &"e".repeat(40), "2025-01-01T00:00:00Z");
        let mismatch = FixtureTransport::new(vec![unknown_hash(), Ok(json!({"data":{"exactMatches":[{"id":55,"file":mismatch}]}}))]);
        // 哈希不匹配→唯一确认失败：这条路径保留报错（区别于结构/元数据 invalid）。
        assert!(detect_with(&mismatch, &input, &settings, &cancel, Arc::new(|| Ok(()))).await.is_err());
        assert_eq!(mismatch.requests().len(), 2);

        let current = fixture_cf_file(1234, 55, "sample.jar", &input.sha1, "2025-01-01T00:00:00Z");
        let duplicate = FixtureTransport::new(vec![unknown_hash(), Ok(json!({"data":{"exactMatches":[{"id":55,"file":current.clone()},{"id":55,"file":current}]}}))]);
        assert!(detect_with(&duplicate, &input, &settings, &cancel, Arc::new(|| Ok(()))).await.is_err());
        assert_eq!(duplicate.requests().len(), 2);
    }

    #[test]
    fn local_and_official_metadata_checks_reject_forged_identity_and_unknown_shader_runtime() {
        let input = fixture_input();
        let file = fixture_cf_file(1234, 55, "sample.jar", &input.sha1, "2025-01-01T00:00:00Z");
        assert!(file.get("classId").is_none());
        assert!(super::cf_file(&file, 55, ResourceKind::Mod, true).is_ok());
        assert!(super::cf_file(&file, 55, ResourceKind::Mod, false).is_ok());
        assert!(super::cf_file(&file, 56, ResourceKind::Mod, true).is_err());
        let project = json!({"classId":6,"gameId":432,"allowModDistribution":true});
        for game_id in [None, Some(json!(1)), Some(Value::Null), Some(json!("432"))] {
            let mut invalid_file = file.clone();
            if let Some(game_id) = game_id { invalid_file["gameId"] = game_id; } else { invalid_file.as_object_mut().unwrap().remove("gameId"); }
            assert!(super::cf_file(&invalid_file, 55, ResourceKind::Mod, true).is_err());
            assert!(super::cf_file(&invalid_file, 55, ResourceKind::Mod, false).is_err());
            assert!(super::cf_candidate(&invalid_file, &project, 55, &input).is_err());
        }
        for mod_id in [None, Some(json!(56)), Some(Value::Null)] {
            let mut invalid_file = file.clone();
            if let Some(mod_id) = mod_id { invalid_file["modId"] = mod_id; } else { invalid_file.as_object_mut().unwrap().remove("modId"); }
            assert!(super::cf_file(&invalid_file, 55, ResourceKind::Mod, true).is_err());
            assert!(super::cf_file(&invalid_file, 55, ResourceKind::Mod, false).is_err());
        }
        assert!(super::cf_candidate(&file, &project, 55, &input).unwrap().is_some());
        for class_id in [None, Some(json!(12)), Some(Value::Null)] {
            let mut invalid_project = project.clone();
            if let Some(class_id) = class_id { invalid_project["classId"] = class_id; } else { invalid_project.as_object_mut().unwrap().remove("classId"); }
            assert!(super::cf_candidate(&file, &invalid_project, 55, &input).is_err());
        }
        let mut shader = input.clone(); shader.kind = ResourceKind::Shader; shader.loader = None; shader.shader_runtimes.clear();
        let unknown = json!({"gameVersions":["1.20.1","unknown-shader-runtime"]});
        assert!(!cf_runtime_supported(&shader, &unknown).unwrap());
        let universal = json!({"gameVersions":["1.20.1","Minecraft"]});
        assert!(cf_runtime_supported(&shader, &universal).unwrap());
    }

    #[tokio::test]
    async fn curseforge_pagination_requires_complete_metadata_and_reports_budget_as_unknown() {
        let input = fixture_input();
        let row = fixture_cf_file(1234, 55, "sample.jar", &input.sha1, "2025-01-01T00:00:00Z");
        let transport = FixtureTransport::new(vec![Ok(cf_page(0, vec![row.clone()], 1))]);
        let cancel = Arc::new(AtomicBool::new(false));
        let settings = json!({"curseforgeApiKey":"fixture"});
        let mut session = Session::new(&transport, &settings, &cancel, Arc::new(|| Ok(())));
        let rows = cf_pages(&mut session, 55, &input).await.unwrap();
        assert_eq!(rows, vec![row.clone()]);

        let first_page: Vec<Value> = (0..PAGE_SIZE).map(|offset| fixture_cf_file(3000 + offset as u64, 55, "sample.jar", &input.sha1, "2025-01-01T00:00:00Z")).collect();
        let tail = fixture_cf_file(4000, 55, "tail.jar", &input.sha1, "2025-01-01T00:00:00Z");
        let paged = FixtureTransport::new(vec![Ok(cf_page(0, first_page.clone(), 51)), Ok(cf_page(50, vec![tail.clone()], 51))]);
        let mut session = Session::new(&paged, &settings, &cancel, Arc::new(|| Ok(())));
        let rows = cf_pages(&mut session, 55, &input).await.unwrap();
        assert_eq!(rows.len(), 51);
        assert_eq!(rows.last(), Some(&tail));
        assert_eq!(paged.requests()[1].0.query_pairs().find(|(key, _)| key == "index").unwrap().1, "50");

        let changed_total = FixtureTransport::new(vec![Ok(cf_page(0, first_page, 51)), Ok(cf_page(50, vec![tail], 52))]);
        let mut session = Session::new(&changed_total, &settings, &cancel, Arc::new(|| Ok(())));
        assert!(cf_pages(&mut session, 55, &input).await.is_err());

        let incomplete = FixtureTransport::new(vec![Ok(cf_page(0, vec![row.clone()], 2))]);
        let mut session = Session::new(&incomplete, &settings, &cancel, Arc::new(|| Ok(())));
        assert!(cf_pages(&mut session, 55, &input).await.is_err());

        let duplicate = FixtureTransport::new(vec![Ok(cf_page(0, vec![row.clone(), row.clone()], 2))]);
        let mut session = Session::new(&duplicate, &settings, &cancel, Arc::new(|| Ok(())));
        assert!(cf_pages(&mut session, 55, &input).await.is_err());

        let over = FixtureTransport::new(vec![Ok(cf_page(0, Vec::new(), (MAX_ITEMS + 1) as u64))]);
        let mut session = Session::new(&over, &settings, &cancel, Arc::new(|| Ok(())));
        assert!(cf_pages(&mut session, 55, &input).await.unwrap_err().contains("budget"));
    }
}


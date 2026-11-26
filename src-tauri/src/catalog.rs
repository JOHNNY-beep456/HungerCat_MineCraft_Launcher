//! 资源查询与本地实例管理。仅固定站点 API；未迁移的下载、整合包通道返回 None。
//! settings 是 Rust 内部快照；CF 密钥不进入返回值、日志或错误正文。
//! 文件选择授权与重命名后的设置引用迁移由调用本模块的宿主负责。

use reqwest::{Client, Method, Url};
use serde_json::{json, Map, Value};
use sha1::{Digest, Sha1};
use sha2::Sha512;
use std::collections::BTreeSet;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::{desktop, install_lock::{acquire, acquire_blocking}, storage::Storage};

pub(crate) mod update;
pub(crate) mod install;
mod mod_metadata;
mod offline_translate;

type Result<T> = std::result::Result<T, String>;
const MR: &str = "https://api.modrinth.com/v2/";
const CF: &str = "https://api.curseforge.com/v1/";
const JSON_CAP: usize = 16 * 1024 * 1024;
const FILE_CAP: u64 = 2 * 1024 * 1024 * 1024;
const UA: &str = "HungerCatLauncher/0.7 (Tauri; github: JOHNNY-beep456)";
/// 资源接口客户端：证书校验、UA 与重定向策略一致，进程内复用连接池。
/// 逐请求新建客户端会让每次 Modrinth / CurseForge 查询都重新做一次 TLS 握手，
/// 批量补齐图标、批量安装模组时握手开销会累积成秒级等待。
fn api_client() -> Result<&'static Client> {
    static CLIENT: OnceLock<Option<Client>> = OnceLock::new();
    CLIENT.get_or_init(|| Client::builder().use_rustls_tls().connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none()).user_agent(UA).pool_max_idle_per_host(24)
        .build().ok()).as_ref().ok_or_else(|| "无法初始化资源 HTTPS 客户端".to_owned())
}
/// 资源文件下载客户端：不设总超时（由各调用方按文件体量用请求级 timeout 收口），复用连接池。
fn transfer_client() -> Result<&'static Client> {
    static CLIENT: OnceLock<Option<Client>> = OnceLock::new();
    CLIENT.get_or_init(|| Client::builder().use_rustls_tls().connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none()).user_agent(UA).pool_max_idle_per_host(16)
        .build().ok()).as_ref().ok_or_else(|| "无法初始化资源下载客户端".to_owned())
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn arg(args: &[Value], index: usize) -> &Value {
    args.get(index).unwrap_or(&Value::Null)
}
fn count(args: &[Value], min: usize, max: usize) -> Result<()> {
    if args.len() < min || args.len() > max { Err("调用参数数量无效".into()) } else { Ok(()) }
}
fn string_arg(args: &[Value], index: usize, max: usize, required: bool) -> Result<String> {
    match arg(args, index) {
        Value::Null if !required => Ok(String::new()),
        Value::String(value) if value.len() <= max && !value.chars().any(char::is_control)
            && (!required || !value.trim().is_empty()) => Ok(value.clone()),
        _ => Err(format!("第 {} 个参数必须是有效文本", index + 1)),
    }
}
fn string_array(args: &[Value], index: usize) -> Result<Vec<String>> {
    if arg(args, index).is_null() { return Ok(Vec::new()); }
    let list = arg(args, index).as_array().ok_or("筛选条件必须是数组")?;
    if list.len() > 64 { return Err("筛选条件过多".into()); }
    list.iter().map(|value| {
        let value = value.as_str().ok_or("筛选条件必须是字符串")?;
        if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
            return Err("筛选条件无效".into());
        }
        Ok(value.to_owned())
    }).collect()
}
fn resource_type(raw: &str) -> Result<&str> {
    match raw { "" => Ok("mod"), "mod" | "modpack" | "resourcepack" | "shader" => Ok(raw), _ => Err("未知资源类型".into()) }
}
fn loader_id(loader: &str) -> Option<u32> {
    match loader.to_ascii_lowercase().as_str() { "forge" => Some(1), "fabric" => Some(4), "quilt" => Some(5), "neoforge" => Some(6), _ => None }
}
fn class_id(kind: &str) -> u32 {
    match kind { "resourcepack" => 12, "shader" => 6552, "modpack" => 4471, _ => 6 }
}
fn category_id(kind: &str, category: &str) -> Option<u32> {
    match (kind, category.to_ascii_lowercase().as_str()) {
        ("mod", "adventure") => Some(422), ("mod", "technology") => Some(412),
        ("mod", "magic") => Some(419), ("mod", "decoration") => Some(424),
        ("mod", "optimization") => Some(6814), ("mod", "utility") => Some(5191),
        ("mod", "worldgen") => Some(406), ("mod", "equipment") => Some(434),
        ("resourcepack", "decoration") => Some(405), ("resourcepack", "adventure") => Some(402),
        ("resourcepack", "modern") => Some(401), ("resourcepack", "realistic") => Some(400), _ => None,
    }
}
fn online(settings: &Value) -> Result<()> {
    if text(settings, "mode") == "local" { Err("本地模式禁止联网查询资源".into()) } else { Ok(()) }
}
fn endpoint(base: &str, segments: &[&str]) -> Result<Url> {
    let mut url = Url::parse(base).map_err(|_| "资源 API 地址无效")?;
    let mut path = url.path_segments_mut().map_err(|_| "资源 API 地址无效")?;
    path.pop_if_empty();
    for segment in segments {
        if segment.is_empty() || segment.len() > 256 || segment.chars().any(char::is_control)
            || segment.contains('/') || segment.contains('\\') || *segment == "." || *segment == ".." {
            return Err("资源标识无效".into());
        }
        path.push(segment);
    }
    drop(path);
    Ok(url)
}
async fn remote_request(url: Url, settings: &Value, curseforge: bool, method: Method, body: Option<Value>) -> Result<Value> {
    online(settings)?;
    let expected = if curseforge { "api.curseforge.com" } else { "api.modrinth.com" };
    if url.scheme() != "https" || url.host_str() != Some(expected) || !url.username().is_empty() || url.password().is_some()
        || url.fragment().is_some() {
        return Err("不允许的资源 API 地址".into());
    }
    let client = api_client()?;
    let mut request = client.request(method, url).timeout(Duration::from_secs(20)).header("accept", "application/json");
    if curseforge {
        let key = text(settings, "curseforgeApiKey").trim();
        if key.is_empty() { return Err("尚未配置 CurseForge API KEY".into()); }
        request = request.header("x-api-key", reqwest::header::HeaderValue::from_str(key).map_err(|_| "CurseForge API KEY 格式无效")?);
    }
    if let Some(body) = body { request = request.json(&body); }
    let mut response = request.send().await.map_err(|error| {
        if error.is_timeout() { "资源请求超时" } else { "资源连接失败，请检查网络与证书" }.to_owned()
    })?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        return Err(match status {
            401 | 403 if curseforge => "CurseForge API KEY 无效、已过期或缺少权限".into(),
            404 => "资源项目或版本不存在（HTTP 404）".into(),
            429 => "资源接口请求过于频繁，请稍后重试".into(),
            _ => format!("资源接口返回 HTTP {status}"),
        });
    }
    if response.content_length().map(|size| size > JSON_CAP as u64).unwrap_or(false) { return Err("资源响应过大".into()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取资源响应失败")? {
        if bytes.len().saturating_add(chunk.len()) > JSON_CAP { return Err("资源响应过大".into()); }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "资源接口响应不是有效 JSON".into())
}

async fn remote(url: Url, settings: &Value, curseforge: bool) -> Result<Value> {
    remote_request(url, settings, curseforge, Method::GET, None).await
}
fn cf_page(project: &Value, kind: &str) -> String {
    let class = project.get("classId").and_then(Value::as_u64).unwrap_or(class_id(kind) as u64);
    let section = match class { 12 => "texture-packs", 6552 => "shaders", 4471 => "modpacks", _ => "mc-mods" };
    let slug = text(project, "slug");
    let mut url = Url::parse("https://www.curseforge.com/minecraft/").expect("固定 URL");
    url.path_segments_mut().expect("固定 URL").pop_if_empty().push(section).push(slug);
    url.to_string()
}
fn cf_project_dto(project: &Value, kind: &str, detail: bool) -> Result<Value> {
    let mut out = project.as_object().cloned().ok_or("CurseForge 项目格式无效")?;
    let id = project.get("id").and_then(Value::as_u64).ok_or("CurseForge 项目缺少 id")?.to_string();
    let slug = if text(project, "slug").is_empty() { &id } else { text(project, "slug") };
    let title = if text(project, "name").is_empty() { slug } else { text(project, "name") };
    out.insert("slug".into(), json!(slug));
    out.insert("title".into(), json!(title));
    out.insert("description".into(), json!(text(project, "summary")));
    out.insert("downloads".into(), project.get("downloadCount").filter(|v| v.is_number()).cloned().unwrap_or(json!(0)));
    if let Some(categories) = project.get("categories") { out.insert("curseforge_categories".into(), categories.clone()); }
    out.insert("categories".into(), json!([]));
    out.insert("project_type".into(), json!(kind));
    out.insert("source".into(), json!("curseforge"));
    out.insert("pageUrl".into(), json!(cf_page(project, kind)));
    out.insert("downloadable".into(), json!(project.get("allowModDistribution").and_then(Value::as_bool) != Some(false)));
    let icon = project.pointer("/logo/thumbnailUrl").and_then(Value::as_str).filter(|s| !s.is_empty())
        .or_else(|| project.pointer("/logo/url").and_then(Value::as_str));
    if let Some(icon) = icon { out.insert("icon_url".into(), json!(icon)); }
    if detail { out.insert("body".into(), json!("")); }
    Ok(Value::Object(out))
}
fn cf_version_dto(file: &Value, project: &Value, kind: &str) -> Result<Value> {
    let mut out = file.as_object().cloned().ok_or("CurseForge 文件格式无效")?;
    let id = file.get("id").and_then(Value::as_u64).ok_or("CurseForge 文件缺少 id")?.to_string();
    let versions = file.get("gameVersions").and_then(Value::as_array).ok_or("CurseForge 文件缺少 gameVersions")?;
    let games: Vec<&str> = versions.iter().filter_map(Value::as_str).filter(|v| v.as_bytes().first().map(u8::is_ascii_digit).unwrap_or(false)).collect();
    let mut loaders = BTreeSet::new();
    for name in versions.iter().filter_map(Value::as_str) {
        let name = name.to_ascii_lowercase();
        if matches!(name.as_str(), "fabric" | "quilt" | "neoforge") { loaders.insert(name); }
        else if name.contains("forge") { loaders.insert(if name.contains("neo") { "neoforge" } else { "forge" }.to_owned()); }
    }
    let filename = text(file, "fileName");
    let name = if text(file, "displayName").is_empty() { filename } else { text(file, "displayName") };
    let url = text(file, "downloadUrl");
    let downloadable = !url.is_empty() && project.get("allowModDistribution").and_then(Value::as_bool) != Some(false);
    let mut hashes = Map::new();
    for hash in file.get("hashes").and_then(Value::as_array).into_iter().flatten() {
        let algorithm = match hash.get("algo").and_then(Value::as_u64) { Some(1) => "sha1", Some(2) => "md5", _ => continue };
        if let Some(value) = hash.get("value").and_then(Value::as_str) { hashes.insert(algorithm.into(), json!(value)); }
    }
    let files = if downloadable {
        json!([{"url":url,"filename":filename,"primary":true,"size":file.get("fileLength").and_then(Value::as_u64).unwrap_or(0),"hashes":hashes}])
    } else { json!([]) };
    let mut dependencies = Vec::new();
    for dependency in file.get("dependencies").and_then(Value::as_array).into_iter().flatten() {
        let relation = match dependency.get("relationType").and_then(Value::as_u64) {
            Some(3) => "required", Some(2) => "optional", Some(5) => "incompatible", Some(1) => "embedded", _ => continue,
        };
        if let Some(id) = dependency.get("modId").and_then(Value::as_u64) {
            dependencies.push(json!({"project_id":id.to_string(),"version_id":null,"file_name":null,"dependency_type":relation,"source":"curseforge"}));
        }
    }
    out.insert("id".into(), json!(id));
    out.insert("name".into(), json!(name));
    out.insert("version_number".into(), json!(name));
    out.insert("game_versions".into(), json!(games));
    out.insert("loaders".into(), json!(loaders));
    out.insert("downloads".into(), json!(0));
    out.insert("date_published".into(), json!(text(file, "fileDate")));
    out.insert("files".into(), files);
    out.insert("source".into(), json!("curseforge"));
    out.insert("downloadable".into(), json!(downloadable));
    out.insert("pageUrl".into(), json!(format!("{}/files/{id}", cf_page(project, kind))));
    if let Some(raw) = file.get("dependencies") { out.insert("curseforge_dependencies".into(), raw.clone()); }
    out.insert("dependencies".into(), json!(dependencies));
    Ok(Value::Object(out))
}
async fn mr_search(args: &[Value], settings: &Value) -> Result<Value> {
    let query = string_arg(args, 0, 4096, false)?;
    let raw_kind = string_arg(args, 1, 32, false)?;
    let kind = resource_type(&raw_kind)?;
    let category = string_arg(args, 2, 128, false)?;
    let game = string_arg(args, 3, 128, false)?;
    let loader = string_arg(args, 4, 128, false)?;
    let offset = match arg(args, 5) { Value::Null => 0, value => value.as_u64().filter(|n| *n <= 100_000).ok_or("资源分页位置无效")? };
    let mut facets = vec![vec![format!("project_type:{kind}")]];
    if !category.is_empty() && category != "all" { facets.push(vec![format!("categories:{category}")]); }
    if !loader.is_empty() && loader != "all" { facets.push(vec![format!("categories:{loader}")]); }
    if !game.is_empty() { facets.push(vec![format!("versions:{game}")]); }
    let mut url = endpoint(MR, &["search"])?;
    url.query_pairs_mut().append_pair("query", &query).append_pair("facets", &json!(facets).to_string())
        .append_pair("limit", "24").append_pair("offset", &offset.to_string());
    let mut raw = remote(url, settings, false).await?;
    let hits = raw.get_mut("hits").and_then(Value::as_array_mut).ok_or("Modrinth 搜索响应缺少 hits")?;
    for hit in hits.iter_mut() {
        hit.as_object_mut().ok_or("Modrinth 项目格式无效")?.insert("source".into(), json!("modrinth"));
    }
    let total = raw.get("total_hits").and_then(Value::as_u64).ok_or("Modrinth 搜索响应缺少总数")?;
    raw.as_object_mut().ok_or("Modrinth 搜索响应无效")?.insert("totalHits".into(), json!(total));
    Ok(raw)
}
async fn cf_search(args: &[Value], settings: &Value) -> Result<Value> {
    let query = string_arg(args, 0, 4096, false)?;
    let raw_kind = string_arg(args, 1, 32, false)?;
    let kind = resource_type(&raw_kind)?;
    let category = string_arg(args, 2, 128, false)?;
    let game = string_arg(args, 3, 128, false)?;
    let loader = string_arg(args, 4, 128, false)?;
    let offset = match arg(args, 5) { Value::Null => 0, value => value.as_u64().filter(|n| *n <= 100_000).ok_or("资源分页位置无效")? };
    let mut url = endpoint(CF, &["mods", "search"])?;
    {
        let mut query_params = url.query_pairs_mut();
        query_params.append_pair("gameId", "432").append_pair("classId", &class_id(kind).to_string())
            .append_pair("pageSize", "24").append_pair("index", &offset.to_string());
        if query.trim().is_empty() { query_params.append_pair("sortField", "2").append_pair("sortOrder", "desc"); }
        else { query_params.append_pair("searchFilter", query.trim()); }
        if !game.is_empty() { query_params.append_pair("gameVersion", &game); }
        if let Some(id) = category_id(kind, &category) { query_params.append_pair("categoryId", &id.to_string()); }
        if !matches!(kind, "shader" | "resourcepack") {
            if let Some(id) = loader_id(&loader) { query_params.append_pair("modLoaderType", &id.to_string()); }
        }
    }
    let raw = remote(url, settings, true).await?;
    let list = raw.get("data").and_then(Value::as_array).ok_or("CurseForge 搜索响应缺少 data")?;
    let hits = list.iter().map(|project| cf_project_dto(project, kind, false)).collect::<Result<Vec<_>>>()?;
    Ok(json!({"hits":hits,"totalHits":raw.pointer("/pagination/totalCount").and_then(Value::as_u64).unwrap_or(list.len() as u64)}))
}
async fn search(args: &[Value], settings: &Value) -> Result<Value> {
    count(args, 1, 7)?;
    online(settings)?;
    let source = string_arg(args, 6, 32, false)?;
    match source.as_str() {
        "modrinth" => mr_search(args, settings).await,
        "curseforge" => cf_search(args, settings).await,
        "" | "all" => {
            if text(settings, "curseforgeApiKey").trim().is_empty() { return mr_search(args, settings).await; }
            let (mr, cf) = tokio::join!(mr_search(args, settings), cf_search(args, settings));
            let mut hits = Vec::new();
            let mut seen = BTreeSet::new();
            let mut total = 0u64;
            let mut errors = Vec::new();
            for (source, result) in [("modrinth", mr), ("curseforge", cf)] {
                match result {
                    Ok(value) => {
                        total = total.saturating_add(value["totalHits"].as_u64().unwrap_or(0));
                        for hit in value["hits"].as_array().ok_or("搜索响应缺少 hits")? {
                            let identity = format!("{}:{}", source, text(hit, "slug"));
                            if seen.insert(identity) { hits.push(hit.clone()); }
                        }
                    }
                    Err(error) => errors.push(json!({"source":source,"error":error})),
                }
            }
            if errors.len() == 2 { return Err("Modrinth 与 CurseForge 查询均失败，请检查网络及资源来源设置".into()); }
            Ok(json!({"hits":hits,"totalHits":total,"partial":!errors.is_empty(),"errors":errors}))
        }
        _ => Err("未知资源来源".into()),
    }
}
async fn cf_project(id_or_slug: &str, settings: &Value) -> Result<Value> {
    let id = if id_or_slug.bytes().all(|byte| byte.is_ascii_digit()) {
        id_or_slug.parse::<u64>().ok().filter(|id| *id > 0).ok_or("CurseForge 项目 id 无效")?
    } else {
        let mut url = endpoint(CF, &["mods", "search"])?;
        url.query_pairs_mut().append_pair("gameId", "432").append_pair("slug", id_or_slug).append_pair("pageSize", "50");
        let raw = remote(url, settings, true).await?;
        raw["data"].as_array().ok_or("CurseForge 项目查询响应无效")?.iter()
            .find(|project| text(project, "slug").eq_ignore_ascii_case(id_or_slug))
            .and_then(|project| project["id"].as_u64()).ok_or("CurseForge 未找到该项目")?
    };
    let raw = remote(endpoint(CF, &["mods", &id.to_string()])?, settings, true).await?;
    let project = raw.get("data").filter(|value| value.is_object()).ok_or("CurseForge 项目响应缺少 data")?;
    if project["id"].as_u64() != Some(id) { return Err("CurseForge 返回的项目 id 不匹配".into()); }
    Ok(project.clone())
}
async fn project(args: &[Value], settings: &Value) -> Result<Value> {
    count(args, 1, 2)?;
    online(settings)?;
    let id = string_arg(args, 0, 256, true)?;
    let raw_kind = string_arg(args, 1, 32, false)?;
    let kind = resource_type(&raw_kind)?;
    let has_key = !text(settings, "curseforgeApiKey").trim().is_empty();
    if has_key && id.bytes().all(|byte| byte.is_ascii_digit()) {
        return cf_project_dto(&cf_project(&id, settings).await?, kind, true);
    }
    match remote(endpoint(MR, &["project", &id])?, settings, false).await {
        Ok(mut value) => {
            let object = value.as_object_mut().ok_or("Modrinth 项目响应无效")?;
            object.insert("source".into(), json!("modrinth"));
            Ok(value)
        }
        Err(error) if has_key => cf_project_dto(&cf_project(&id, settings).await?, kind, true).map_err(|_| error),
        Err(error) => Err(error),
    }
}
async fn versions(args: &[Value], settings: &Value) -> Result<Value> {
    count(args, 3, 5)?;
    online(settings)?;
    let id = string_arg(args, 0, 256, true)?;
    let loaders = string_array(args, 1)?;
    let games = string_array(args, 2)?;
    let source = string_arg(args, 3, 32, false)?;
    let raw_kind = string_arg(args, 4, 32, false)?;
    let kind = resource_type(&raw_kind)?;
    if source.is_empty() || source == "modrinth" {
        let mut url = endpoint(MR, &["project", &id, "version"])?;
        if !loaders.is_empty() { url.query_pairs_mut().append_pair("loaders", &json!(loaders).to_string()); }
        if !games.is_empty() { url.query_pairs_mut().append_pair("game_versions", &json!(games).to_string()); }
        let mut raw = remote(url, settings, false).await?;
        for version in raw.as_array_mut().ok_or("Modrinth 版本响应必须是数组")? {
            version.as_object_mut().ok_or("Modrinth 版本格式无效")?.insert("source".into(), json!("modrinth"));
            if version.get("files").and_then(Value::as_array).is_none() { return Err("Modrinth 版本缺少文件列表".into()); }
        }
        return Ok(raw);
    }
    if source != "curseforge" { return Err("未知资源来源".into()); }
    let project = cf_project(&id, settings).await?;
    let project_id = project["id"].as_u64().ok_or("CurseForge 项目 id 无效")?;
    let mut url = endpoint(CF, &["mods", &project_id.to_string(), "files"])?;
    {
        let mut params = url.query_pairs_mut();
        params.append_pair("pageSize", "50");
        if let Some(game) = games.first() { params.append_pair("gameVersion", game); }
        if !matches!(kind, "shader" | "resourcepack") {
            if let Some(id) = loaders.iter().find_map(|loader| loader_id(loader)) { params.append_pair("modLoaderType", &id.to_string()); }
        }
    }
    let raw = remote(url, settings, true).await?;
    let files = raw["data"].as_array().ok_or("CurseForge 版本响应缺少 data")?;
    let mut result = Vec::new();
    for file in files {
        if file.get("isAvailable").and_then(Value::as_bool) == Some(false) { continue; }
        if file.get("modId").and_then(Value::as_u64) != Some(project_id) { return Err("CurseForge 返回的文件不属于当前项目".into()); }
        let version = cf_version_dto(file, &project, kind)?;
        let compatible_game = games.is_empty() || version["game_versions"].as_array().map(|list| list.iter().any(|v| v.as_str().map(|v| games.iter().any(|g| g == v)).unwrap_or(false))).unwrap_or(false);
        let compatible_loader = loaders.is_empty() || matches!(kind, "shader" | "resourcepack") || version["loaders"].as_array().map(|list| list.iter().any(|v| v.as_str().map(|v| loaders.iter().any(|loader| loader.eq_ignore_ascii_case(v))).unwrap_or(false))).unwrap_or(false);
        if compatible_game && compatible_loader { result.push(version); }
    }
    result.sort_by(|left, right| text(right, "date_published").cmp(text(left, "date_published")));
    Ok(Value::Array(result))
}

#[derive(Clone, Debug)]
pub(crate) struct BoundDownload {
    source: &'static str,
    kind: &'static str,
    url: String,
    filename: String,
    size: u64,
    sha1: Option<String>,
    sha512: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PackBoundMetadata {
    pub(crate) kind: &'static str,
    pub(crate) filename: String,
    pub(crate) size: u64,
    pub(crate) sha1: Option<String>,
    pub(crate) sha512: Option<String>,
}

/// 离线计划夹具的内部构造器；发布构建不包含此入口。
#[cfg(test)]
pub(crate) fn resource_update_test_download(kind: &'static str, filename: &str, size: u64, sha1: &str, sha512: &str) -> BoundDownload {
    BoundDownload { source: "modrinth", kind, url: format!("https://cdn.modrinth.com/data/fixture/versions/next/{filename}"),
        filename: filename.into(), size, sha1: Some(sha1.into()), sha512: Some(sha512.into()) }
}

pub(crate) fn pack_bound_metadata(bound: &BoundDownload) -> PackBoundMetadata {
    PackBoundMetadata {
        kind: bound.kind, filename: bound.filename.clone(), size: bound.size,
        sha1: bound.sha1.clone(), sha512: bound.sha512.clone(),
    }
}

fn normalize_hash(value: &str, expected_len: usize) -> Option<String> {
    let value = value.trim();
    if value.len() != expected_len || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) { return None; }
    Some(value.to_ascii_lowercase())
}

fn official_download_url(raw: &str, source: &str) -> Result<Url> {
    let url = Url::parse(raw).map_err(|_| "官方资源下载地址无效")?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("官方资源下载地址不安全".into());
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    match source {
        "modrinth" => {
            if !matches!(host.as_str(), "cdn.modrinth.com" | "api.modrinth.com") { return Err("Modrinth 文件地址不是官方 CDN".into()); }
            let parts: Vec<&str> = url.path_segments().map(|parts| parts.collect()).unwrap_or_default();
            if parts.len() < 5 || parts[0] != "data" || parts[2] != "versions" {
                return Err("Modrinth 文件地址路径无效".into());
            }
        }
        "curseforge" => {
            if !matches!(host.as_str(), "edge.forgecdn.net" | "mediafilez.forgecdn.net" | "media.forgecdn.net" | "www.curseforge.com") {
                return Err("CurseForge 文件地址不是允许的官方分发域名".into());
            }
        }
        _ => return Err("未知资源来源".into()),
    }
    Ok(url)
}

fn bound_modrinth_file(file: &Value, expected_url: Option<&str>, expected_filename: &str) -> Result<BoundDownload> {
    let filename = text(file, "filename");
    if filename != expected_filename { return Err("官方资源文件名与请求不匹配".into()); }
    leaf(filename)?;
    let raw_url = text(file, "url");
    if let Some(expected) = expected_url {
        if raw_url != expected { return Err("用户下载地址与官方版本文件不匹配".into()); }
    }
    official_download_url(raw_url, "modrinth")?;
    let hashes = file.get("hashes").and_then(Value::as_object).ok_or("官方 Modrinth 文件缺少哈希")?;
    let sha1 = hashes.get("sha1").and_then(Value::as_str).and_then(|value| normalize_hash(value, 40));
    let sha512 = hashes.get("sha512").and_then(Value::as_str).and_then(|value| normalize_hash(value, 128));
    if sha1.is_none() && sha512.is_none() { return Err("官方 Modrinth 文件缺少可验证哈希".into()); }
    let size = file.get("size").and_then(Value::as_u64).filter(|size| *size > 0 && *size <= FILE_CAP).ok_or("官方 Modrinth 文件缺少有效大小")?;
    Ok(BoundDownload { source: "modrinth", kind: "mod", url: raw_url.to_owned(), filename: filename.to_owned(), size, sha1, sha512 })
}

fn bound_curseforge_file(file: &Value, project: &Value, expected_url: &str, expected_filename: &str, kind: &str) -> Result<BoundDownload> {
    if project.get("allowModDistribution").and_then(Value::as_bool) == Some(false) { return Err("CurseForge 项目禁止分发文件".into()); }
    if file.get("isAvailable").and_then(Value::as_bool) == Some(false) { return Err("CurseForge 文件当前不可下载".into()); }
    if file.get("classId").and_then(Value::as_u64).map(|id| id != class_id(kind) as u64).unwrap_or(false) {
        return Err("CurseForge 文件类型与请求不匹配".into());
    }
    let filename = text(file, "fileName");
    if filename != expected_filename { return Err("官方 CurseForge 文件名与请求不匹配".into()); }
    leaf(filename)?;
    let raw_url = text(file, "downloadUrl");
    if raw_url != expected_url { return Err("用户下载地址与官方 CurseForge 文件不匹配".into()); }
    official_download_url(raw_url, "curseforge")?;
    let mut sha1 = None;
    for hash in file.get("hashes").and_then(Value::as_array).into_iter().flatten() {
        if hash.get("algo").and_then(Value::as_u64) == Some(1) {
            sha1 = hash.get("value").and_then(Value::as_str).and_then(|value| normalize_hash(value, 40));
        }
    }
    let sha1 = sha1.ok_or("官方 CurseForge 文件缺少 SHA-1")?;
    let size = file.get("fileLength").and_then(Value::as_u64).filter(|size| *size > 0 && *size <= FILE_CAP).ok_or("官方 CurseForge 文件缺少有效大小")?;
    let kind = match kind { "resourcepack" => "resourcepack", "shader" => "shader", "modpack" => "modpack", _ => "mod" };
    Ok(BoundDownload { source: "curseforge", kind, url: raw_url.to_owned(), filename: filename.to_owned(), size, sha1: Some(sha1), sha512: None })
}

fn modrinth_version_from_url(url: &Url) -> Result<String> {
    let parts: Vec<&str> = url.path_segments().map(|parts| parts.collect()).unwrap_or_default();
    let version = parts.windows(2).find(|pair| pair[0] == "versions").map(|pair| pair[1]).ok_or("无法从 Modrinth 下载地址确定版本")?;
    leaf(version)?;
    Ok(version.to_owned())
}

fn curseforge_file_id_from_url(url: &Url) -> Result<u64> {
    let parts: Vec<&str> = url.path_segments().map(|parts| parts.collect()).unwrap_or_default();
    let id = if let Some(index) = parts.iter().position(|part| *part == "files") {
        let high = parts.get(index + 1).filter(|value| !value.is_empty() && value.chars().all(|c| c.is_ascii_digit())).ok_or("无法从 CurseForge 下载地址确定文件")?
            .parse::<u64>().map_err(|_| "CurseForge 文件 id 无效")?;
        let low = parts.get(index + 2).filter(|value| !value.is_empty() && value.chars().all(|c| c.is_ascii_digit())).ok_or("无法从 CurseForge 下载地址确定文件")?
            .parse::<u64>().map_err(|_| "CurseForge 文件 id 无效")?;
        high.checked_mul(1000).and_then(|value| value.checked_add(low)).ok_or("CurseForge 文件 id 溢出")?.to_string()
    } else if let Some(index) = parts.iter().position(|part| *part == "download") {
        parts.get(index + 1).filter(|value| !value.is_empty() && value.chars().all(|c| c.is_ascii_digit())).ok_or("无法从 CurseForge 下载地址确定文件")?.to_string()
    } else {
        return Err("无法从 CurseForge 下载地址确定文件".into());
    };
    id.parse::<u64>().ok().filter(|id| *id > 0).ok_or("CurseForge 文件 id 无效".into())
}

async fn bind_modrinth_download(file_url: &str, filename: &str, settings: &Value) -> Result<BoundDownload> {
    let url = official_download_url(file_url, "modrinth")?;
    let version_id = modrinth_version_from_url(&url)?;
    let raw = remote(endpoint(MR, &["version", &version_id])?, settings, false).await?;
    if text(&raw, "id") != version_id { return Err("Modrinth 官方版本 id 不匹配".into()); }
    let files = raw.get("files").and_then(Value::as_array).ok_or("Modrinth 官方版本缺少文件列表")?;
    files.iter().find(|file| text(file, "filename") == filename && text(file, "url") == file_url)
        .map(|file| bound_modrinth_file(file, Some(file_url), filename))
        .unwrap_or_else(|| Err("用户下载文件未在官方 Modrinth 版本中找到".into()))
}

async fn bind_curseforge_download(file_url: &str, filename: &str, kind: &str, settings: &Value) -> Result<BoundDownload> {
    let url = official_download_url(file_url, "curseforge")?;
    let file_id = curseforge_file_id_from_url(&url)?;
    let raw = remote_request(endpoint(CF, &["mods", "files"])?, settings, true, Method::POST, Some(json!({"fileIds":[file_id]}))).await?;
    let file = raw.get("data").and_then(Value::as_array).ok_or("CurseForge 文件查询响应缺少 data")?.iter()
        .find(|file| file.get("id").and_then(Value::as_u64) == Some(file_id)).ok_or("CurseForge 官方文件不存在")?;
    let project_id = file.get("modId").and_then(Value::as_u64).ok_or("CurseForge 文件缺少项目 id")?;
    let project = cf_project(&project_id.to_string(), settings).await?;
    bound_curseforge_file(file, &project, file_url, filename, kind)
}

fn curseforge_export_kind(project: &Value) -> Result<&'static str> {
    match project.get("classId").and_then(Value::as_u64) {
        Some(6) => Ok("mod"),
        Some(12) => Ok("resourcepack"),
        Some(6552) => Ok("shader"),
        Some(4471) => Ok("modpack"),
        _ => Err("CurseForge 项目类型不支持导出下载".into()),
    }
}

fn bound_curseforge_export(file: &Value, project: &Value, file_url: &str, original_filename: &str) -> Result<BoundDownload> {
    let kind = curseforge_export_kind(project)?;
    let project_id = project.get("id").and_then(Value::as_u64).filter(|id| *id > 0).ok_or("CurseForge 项目标识无效")?;
    if project.get("gameId").and_then(Value::as_u64) != Some(432)
        || file.get("modId").and_then(Value::as_u64) != Some(project_id) {
        return Err("CurseForge 文件不属于官方 Minecraft 项目".into());
    }
    let url = official_download_url(file_url, "curseforge")?;
    if file.get("id").and_then(Value::as_u64) != Some(curseforge_file_id_from_url(&url)?) {
        return Err("CurseForge 文件标识与官方地址不一致".into());
    }
    bound_curseforge_file(file, project, file_url, original_filename, kind)
}

fn validate_export_bound(bound: &BoundDownload, hint: Option<u64>) -> Result<()> {
    let url = official_download_url(&bound.url, bound.source)?;
    if url.port().is_some_and(|port| port != 443) || bound.url.len() > 8192 || bound.url.chars().any(char::is_control) {
        return Err("资源导出只允许标准官方 HTTPS".into());
    }
    leaf(&bound.filename)?;
    if bound.size == 0 || bound.size > FILE_CAP {
        return Err("官方导出文件大小无效".into());
    }
    if bound.sha1.is_none() && bound.sha512.is_none()
        || bound.sha1.as_deref().is_some_and(|hash| normalize_hash(hash, 40).as_deref() != Some(hash))
        || bound.sha512.as_deref().is_some_and(|hash| normalize_hash(hash, 128).as_deref() != Some(hash)) {
        return Err("官方导出文件摘要无效".into());
    }
    if hint.is_some_and(|size| size == 0 || size > FILE_CAP || size != bound.size) {
        return Err("导出大小提示与官方元数据不一致".into());
    }
    Ok(())
}

/// original_filename 是资源的原始官方文件名，与 SAF 保存时用户选择的名称无关。
pub(crate) async fn prepare_export_download(file_url: &str, original_filename: &str, size_hint: Option<u64>, settings: &Value) -> Result<BoundDownload> {
    leaf(original_filename)?;
    if let Some(size) = size_hint {
        if size == 0 || size > FILE_CAP { return Err("导出文件大小提示无效".into()); }
    }
    online(settings)?;
    if settings.get("metadataOnlyMods").and_then(Value::as_bool) == Some(true) {
        return Err("仅元数据模式不下载导出资源".into());
    }
    let parsed = Url::parse(file_url).map_err(|_| "导出下载地址无效")?;
    if file_url.len() > 8192 || file_url.chars().any(char::is_control) || parsed.port().is_some_and(|port| port != 443) {
        return Err("导出下载地址不安全".into());
    }
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    let bound = match host.as_str() {
        "cdn.modrinth.com" | "api.modrinth.com" => bind_modrinth_download(file_url, original_filename, settings).await?,
        "edge.forgecdn.net" | "mediafilez.forgecdn.net" | "media.forgecdn.net" | "www.curseforge.com" => {
            let url = official_download_url(file_url, "curseforge")?;
            let file_id = curseforge_file_id_from_url(&url)?;
            let raw = remote_request(endpoint(CF, &["mods", "files"])?, settings, true, Method::POST, Some(json!({"fileIds":[file_id]}))).await?;
            let file = raw.get("data").and_then(Value::as_array).ok_or("CurseForge 文件查询响应缺少 data")?.iter()
                .find(|file| file.get("id").and_then(Value::as_u64) == Some(file_id)).ok_or("CurseForge 官方文件不存在")?;
            let project_id = file.get("modId").and_then(Value::as_u64).ok_or("CurseForge 文件缺少项目 id")?;
            let project = cf_project(&project_id.to_string(), settings).await?;
            bound_curseforge_export(file, &project, file_url, original_filename)?
        }
        _ => return Err("导出下载地址不属于允许的官方来源".into()),
    };
    validate_export_bound(&bound, size_hint)?;
    Ok(bound)
}

fn pack_download_allowed(settings: &Value) -> Result<()> {
    online(settings)?;
    if settings.get("metadataOnlyMods").and_then(Value::as_bool) == Some(true) {
        return Err("仅元数据模式不下载整合包成员".into());
    }
    Ok(())
}

fn pack_curseforge_ids(project_id: u64, file_id: u64) -> Result<()> {
    if project_id == 0 || file_id == 0 || project_id > i32::MAX as u64 || file_id > i32::MAX as u64 {
        return Err("CurseForge 项目和文件 ID 必须在 1 到 2147483647 之间".into());
    }
    Ok(())
}

fn bound_pack_curseforge(file: &Value, project: &Value, project_id: u64, file_id: u64) -> Result<BoundDownload> {
    pack_curseforge_ids(project_id, file_id)?;
    if project.get("id").and_then(Value::as_u64) != Some(project_id)
        || file.get("modId").and_then(Value::as_u64) != Some(project_id)
        || file.get("id").and_then(Value::as_u64) != Some(file_id) {
        return Err("CurseForge 官方项目或文件 ID 与整合包声明不匹配".into());
    }
    if project.get("gameId").and_then(Value::as_u64) != Some(432) {
        return Err("CurseForge 项目不属于 Minecraft".into());
    }
    let kind = match project.get("classId").and_then(Value::as_u64) {
        Some(6) => "mod", Some(12) => "resourcepack", Some(6552) => "shader",
        Some(4471) => return Err("整合包成员不支持嵌套整合包".into()),
        _ => return Err("CurseForge 项目不是支持的整合包成员类型".into()),
    };
    if let Some(class) = file.get("classId") {
        if class.as_u64() != Some(class_id(kind) as u64) {
            return Err("CurseForge 官方文件类型与项目不匹配".into());
        }
    }
    match project.get("allowModDistribution").and_then(Value::as_bool) {
        Some(true) => {},
        Some(false) => return Err("CurseForge 项目禁止分发文件".into()),
        None => return Err("CurseForge 官方元数据未明确确认分发状态".into()),
    }
    match file.get("isAvailable").and_then(Value::as_bool) {
        Some(true) => {},
        Some(false) => return Err("CurseForge 文件当前不可下载".into()),
        None => return Err("CurseForge 官方元数据未明确确认可用状态".into()),
    }
    let raw_url = text(file, "downloadUrl");
    let url = official_download_url(raw_url, "curseforge")?;
    if curseforge_file_id_from_url(&url)? != file_id {
        return Err("CurseForge 官方下载地址与请求文件 ID 不匹配".into());
    }
    let mut expected_sha1: Option<String> = None;
    let hashes = file.get("hashes").and_then(Value::as_array).ok_or("官方 CurseForge 文件缺少 SHA-1")?;
    for hash in hashes {
        if hash.get("algo").and_then(Value::as_u64) != Some(1) { continue; }
        let value = hash.get("value").and_then(Value::as_str)
            .and_then(|value| normalize_hash(value, 40)).ok_or("官方 CurseForge SHA-1 无效")?;
        if expected_sha1.as_ref().is_some_and(|expected| expected != &value) {
            return Err("官方 CurseForge SHA-1 存在冲突".into());
        }
        expected_sha1 = Some(value);
    }
    let expected_sha1 = expected_sha1.ok_or("官方 CurseForge 文件缺少 SHA-1")?;
    let bound = bound_curseforge_file(file, project, raw_url, text(file, "fileName"), kind)?;
    if bound.sha1.as_deref() != Some(expected_sha1.as_str()) { return Err("官方 CurseForge SHA-1 绑定不一致".into()); }
    validate_export_bound(&bound, None)?;
    Ok(bound)
}

pub(crate) async fn prepare_pack_curseforge(project_id: u64, file_id: u64, settings: &Value) -> Result<BoundDownload> {
    pack_download_allowed(settings)?;
    pack_curseforge_ids(project_id, file_id)?;
    let project_text = project_id.to_string();
    let file_text = file_id.to_string();
    let raw_project = remote(endpoint(CF, &["mods", &project_text])?, settings, true).await?;
    let project = raw_project.get("data").filter(|value| value.is_object()).ok_or("CurseForge 项目响应缺少 data")?;
    let raw_file = remote(endpoint(CF, &["mods", &project_text, "files", &file_text])?, settings, true).await?;
    let file = raw_file.get("data").filter(|value| value.is_object()).ok_or("CurseForge 文件响应缺少 data")?;
    bound_pack_curseforge(file, project, project_id, file_id)
}

fn pack_manifest_hash(value: Option<&str>, length: usize, algorithm: &str) -> Result<Option<String>> {
    value.map(|value| {
        if value.len() != length || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(format!("整合包声明的 {algorithm} 无效"));
        }
        Ok(value.to_ascii_lowercase())
    }).transpose()
}

fn pack_modrinth_declaration(size: u64, sha1: Option<&str>, sha512: Option<&str>) -> Result<(Option<String>, Option<String>)> {
    if size == 0 || size > FILE_CAP { return Err("整合包声明的文件大小无效".into()); }
    let sha1 = pack_manifest_hash(sha1, 40, "SHA-1")?;
    let sha512 = pack_manifest_hash(sha512, 128, "SHA-512")?;
    if sha1.is_none() && sha512.is_none() { return Err("整合包成员必须声明 SHA-1 或 SHA-512".into()); }
    Ok((sha1, sha512))
}

fn validate_pack_modrinth_declared(bound: &BoundDownload, size: u64, sha1: Option<&str>, sha512: Option<&str>) -> Result<()> {
    let (sha1, sha512) = pack_modrinth_declaration(size, sha1, sha512)?;
    if bound.source != "modrinth" { return Err("整合包 Modrinth 文件必须绑定官方 Modrinth 元数据".into()); }
    validate_export_bound(bound, Some(size))?;
    if sha1.as_ref().is_some_and(|expected| bound.sha1.as_ref() != Some(expected)) {
        return Err("整合包 SHA-1 与官方 Modrinth 元数据不一致或官方缺少对应摘要".into());
    }
    if sha512.as_ref().is_some_and(|expected| bound.sha512.as_ref() != Some(expected)) {
        return Err("整合包 SHA-512 与官方 Modrinth 元数据不一致或官方缺少对应摘要".into());
    }
    Ok(())
}

pub(crate) async fn prepare_pack_modrinth(file_url: &str, original_filename: &str, size: u64, declared_sha1: Option<&str>, declared_sha512: Option<&str>, settings: &Value) -> Result<BoundDownload> {
    pack_download_allowed(settings)?;
    pack_modrinth_declaration(size, declared_sha1, declared_sha512)?;
    let url = official_download_url(file_url, "modrinth")?;
    if file_url.len() > 8192 || file_url.chars().any(char::is_control) || url.port().is_some_and(|port| port != 443) {
        return Err("整合包 Modrinth 下载地址不安全".into());
    }
    let bound = prepare_export_download(file_url, original_filename, Some(size), settings).await?;
    validate_pack_modrinth_declared(&bound, size, declared_sha1, declared_sha512)?;
    Ok(bound)
}

#[derive(Debug)]
enum ExportChunk { Data(Vec<u8>), Finish }

// 抽出同步 sink 以便夹具能阻塞真实 write；正式实现只接收宿主已经安全打开的 File。
trait ExportSink: Write {
    fn prepare(&mut self) -> Result<()>;
    fn sync_export(&mut self) -> Result<()>;
}
impl ExportSink for File {
    fn prepare(&mut self) -> Result<()> {
        let info = self.metadata().map_err(|_| "无法读取导出文件状态")?;
        if !info.is_file() || info.len() != 0 { return Err("导出目标必须是已准备好的空普通文件".into()); }
        #[cfg(unix)] {
            use std::os::unix::fs::MetadataExt;
            if info.nlink() != 1 || info.mode() & 0o777 != 0o600 { return Err("导出目标文件权限或链接数量无效".into()); }
        }
        self.seek(SeekFrom::Start(0)).map_err(|_| "无法定位导出文件")?;
        Ok(())
    }
    fn sync_export(&mut self) -> Result<()> { self.sync_all().map_err(|_| "提交资源导出文件失败".into()) }
}

fn export_writer<S: ExportSink>(mut output: S, bound: BoundDownload, mut chunks: tokio::sync::mpsc::Receiver<ExportChunk>, cancel: Arc<crate::downloads::Cancel>, progress: Arc<dyn Fn(u64, u64) + Send + Sync>) -> Result<u64> {
    cancel.check()?;
    output.prepare()?;
    let mut sha1 = Sha1::new();
    let mut sha512 = Sha512::new();
    let mut received = 0u64;
    let mut last_progress = Instant::now();
    progress(0, bound.size);
    loop {
        cancel.check()?;
        match chunks.blocking_recv().ok_or("资源导出传输未完整结束")? {
            ExportChunk::Data(bytes) => {
                cancel.check()?;
                received = received.checked_add(bytes.len() as u64).ok_or("资源导出大小溢出")?;
                if received > bound.size || received > FILE_CAP { return Err("资源导出超过官方声明大小".into()); }
                output.write_all(&bytes).map_err(|_| "写入资源导出文件失败")?;
                cancel.check()?;
                sha1.update(&bytes);
                sha512.update(&bytes);
                if last_progress.elapsed() >= Duration::from_millis(100) {
                    progress(received, bound.size);
                    last_progress = Instant::now();
                }
            }
            ExportChunk::Finish => break,
        }
    }
    cancel.check()?;
    if received != bound.size { return Err("资源导出未达到官方声明大小".into()); }
    let actual_sha1 = format!("{:x}", sha1.finalize());
    let actual_sha512 = format!("{:x}", sha512.finalize());
    if bound.sha1.as_deref().is_some_and(|value| value != actual_sha1) { return Err("资源导出 SHA-1 校验失败".into()); }
    if bound.sha512.as_deref().is_some_and(|value| value != actual_sha512) { return Err("资源导出 SHA-512 校验失败".into()); }
    output.flush().map_err(|_| "刷新资源导出文件失败")?;
    cancel.check()?;
    output.sync_export()?;
    cancel.check()?;
    progress(received, bound.size);
    drop(output);
    Ok(received)
}

/// 独占宿主传入的现有 inode；返回前等待所有同步写入、sync 和关闭完成，不创建或替换路径。
pub(crate) async fn write_export_download(bound: BoundDownload, file: File, cancel: Arc<crate::downloads::Cancel>, progress: Arc<dyn Fn(u64, u64) + Send + Sync>) -> Result<u64> {
    validate_export_bound(&bound, None)?;
    cancel.check()?;
    let client = transfer_client()?;
    let (sender, receiver) = tokio::sync::mpsc::channel(2);
    let expected = bound.clone();
    let writer_cancel = cancel.clone();
    let worker = tokio::task::spawn_blocking(move || export_writer(file, expected, receiver, writer_cancel, progress));
    let transfer: Result<()> = async {
        let mut response = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err("导出下载已取消".into()),
            _ = sender.closed() => return Err("资源导出写入任务已停止".into()),
            response = client.get(&bound.url).timeout(Duration::from_secs(180)).send() => response.map_err(|_| "资源导出连接失败，请检查网络与证书")?,
        };
        if response.status() != reqwest::StatusCode::OK { return Err(format!("资源导出返回 HTTP {}", response.status().as_u16())); }
        if response.content_length().is_some_and(|size| size != bound.size) { return Err("资源导出响应大小与官方元数据不一致".into()); }
        let mut received = 0u64;
        loop {
            let next = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err("导出下载已取消".into()),
                _ = sender.closed() => return Err("资源导出写入任务已停止".into()),
                chunk = response.chunk() => chunk.map_err(|_| "读取资源导出数据失败")?,
            };
            let Some(chunk) = next else { break; };
            received = received.checked_add(chunk.len() as u64).ok_or("资源导出大小溢出")?;
            if received > bound.size || received > FILE_CAP { return Err("资源导出超过官方声明大小".into()); }
            for bytes in chunk.chunks(64 * 1024) {
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err("导出下载已取消".into()),
                    sent = sender.send(ExportChunk::Data(bytes.to_vec())) => sent.map_err(|_| "资源导出写入任务已停止")?,
                }
            }
        }
        if received != bound.size { return Err("资源导出未达到官方声明大小".into()); }
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("导出下载已取消".into()),
            sent = sender.send(ExportChunk::Finish) => sent.map_err(|_| "资源导出写入任务已停止".to_owned()),
        }
    }.await;
    if transfer.is_err() { cancel.stop(); }
    drop(sender);
    // 无条件等待，不能以 select/abort 提前释放 PreparedSave；worker 返回时 File 已真实关闭。
    let written = worker.await.map_err(|_| "资源导出写入任务异常".to_owned())?;
    transfer?;
    let count = written?;
    cancel.check()?;
    Ok(count)
}

fn hash_matches(path: &Path, expected: &BoundDownload) -> Result<()> {
    let mut file = File::open(path).map_err(|_| "无法读取下载临时文件")?;
    let mut sha1 = Sha1::new();
    let mut sha512 = Sha512::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|_| "读取下载临时文件失败")?;
        if count == 0 { break; }
        total = total.checked_add(count as u64).ok_or("下载文件大小溢出")?;
        if total > FILE_CAP { return Err("下载文件超过安全上限".into()); }
        sha1.update(&buffer[..count]);
        sha512.update(&buffer[..count]);
    }
    if total != expected.size { return Err("下载文件大小与官方元数据不一致".into()); }
    let actual_sha1 = format!("{:x}", sha1.finalize());
    if expected.sha1.as_deref().map(|value| value != actual_sha1).unwrap_or(false) { return Err("下载文件 SHA-1 校验失败".into()); }
    let actual_sha512 = format!("{:x}", sha512.finalize());
    if expected.sha512.as_deref().map(|value| value != actual_sha512).unwrap_or(false) { return Err("下载文件 SHA-512 校验失败".into()); }
    Ok(())
}

struct TempDownload { path: PathBuf, committed: bool }
impl Drop for TempDownload { fn drop(&mut self) { if !self.committed { let _ = fs::remove_file(&self.path); } } }

async fn download_temp(bound: &BoundDownload, temporary: &Path) -> Result<()> {
    official_download_url(&bound.url, bound.source)?;
    let client = transfer_client()?;
    let response = client.get(&bound.url).timeout(Duration::from_secs(30)).send().await.map_err(|error| if error.is_timeout() { "资源下载超时".to_owned() } else { "资源下载连接失败，请检查网络与证书".to_owned() })?;
    if !response.status().is_success() { return Err(format!("资源下载返回 HTTP {}", response.status().as_u16())); }
    if response.content_length().map(|size| size != bound.size).unwrap_or(false) { return Err("资源下载响应大小与官方元数据不一致".into()); }
    let mut file = tokio::fs::OpenOptions::new().write(true).create_new(true).open(temporary).await.map_err(|_| "无法创建资源下载临时文件")?;
    let mut received = 0u64;
    let mut pending: Vec<u8> = Vec::with_capacity(crate::downloads::DOWNLOAD_CHUNK_BUFFER);
    let mut response = response;
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取资源下载失败")? {
        received = received.checked_add(chunk.len() as u64).ok_or("资源下载大小溢出")?;
        if received > bound.size || received > FILE_CAP { return Err("资源下载超过官方声明大小".into()); }
        crate::downloads::buffer_download_chunk(&mut file, &mut pending, &chunk).await.map_err(|_| "写入资源下载失败")?;
    }
    if received != bound.size { return Err("资源下载未达到官方声明大小".into()); }
    crate::downloads::flush_download_buffer(&mut file, &mut pending).await.map_err(|_| "刷新资源下载失败")?;
    file.sync_all().await.map_err(|_| "提交资源下载失败")?;
    Ok(())
}

fn install_folder(kind: &str) -> Result<&'static str> {
    match kind { "mod" => Ok("mods"), "resourcepack" => Ok("resourcepacks"), "shader" => Ok("shaderpacks"), _ => Err("mods:install 不支持整合包类型".into()) }
}

fn size_hint(args: &[Value], index: usize) -> Result<Option<u64>> {
    match arg(args, index) { Value::Null => Ok(None), Value::Number(value) => value.as_u64().filter(|size| *size > 0 && *size <= FILE_CAP).map(Some).ok_or("资源大小提示无效".into()), _ => Err("资源大小提示必须是正整数".into()) }
}

async fn run_blocking<T, F>(task: F) -> Result<T>
where T: Send + 'static, F: FnOnce() -> Result<T> + Send + 'static {
    tokio::task::spawn_blocking(task).await.map_err(|_| "资源文件任务异常".to_owned())?
}

async fn install_bound(bound: BoundDownload, root: PathBuf, run: PathBuf, kind: &str) -> Result<Value> {
    let folder = install_folder(kind)?;
    let filename = bound.filename.clone();
    let target_dir = child(&run, &[folder])?;
    let target = child(&target_dir, &[&filename])?;
    let temporary = child(&target_dir, &[&format!(".hcmcl-download-{}.tmp", Uuid::new_v4())])?;
    run_blocking({ let target_dir = target_dir.clone(); let target = target.clone(); move || {
        create_dirs(&target_dir)?;
        if metadata(&target)?.is_some() { return Err("同名资源已存在，拒绝覆盖".into()); }
        Ok(())
    }}).await?;
    let mut temp = TempDownload { path: temporary.clone(), committed: false };
    download_temp(&bound, &temporary).await?;
    let verify_path = temporary.clone();
    let publish_target = target.clone();
    run_blocking(move || { hash_matches(&verify_path, &bound)?; move_new(&verify_path, &publish_target) }).await?;
    temp.committed = true;
    let _ = root;
    Ok(json!(path_text(&target)?))
}

async fn install_mod(args: &[Value], settings: &Value, game_dir: &Path) -> Result<Value> {
    count(args, 3, 6)?;
    online(settings)?;
    if settings.get("metadataOnlyMods").and_then(Value::as_bool) == Some(true) { return Err("仅元数据模式不安装资源".into()); }
    let file_url = string_arg(args, 0, 8192, true)?;
    let filename = string_arg(args, 1, 240, true)?;
    leaf(&filename)?;
    let instance = string_arg(args, 2, 240, true)?;
    leaf(&instance)?;
    let raw_kind = string_arg(args, 3, 32, false)?;
    let kind = resource_type(&raw_kind)?;
    let _ = install_folder(kind)?;
    let hint = size_hint(args, 4)?;
    let dir_id = string_arg(args, 5, 128, false)?;
    let root = root_for(settings, game_dir, &dir_id)?;
    let run = run_dir(&root, settings, &instance)?;
    let _guard = acquire(&root, || false).await?;
    let target_dir = child(&run, &[install_folder(kind)?])?;
    let target = child(&target_dir, &[&filename])?;
    if metadata(&target)?.is_some() { return Err("同名资源已存在，拒绝覆盖".into()); }
    let bound = match Url::parse(&file_url).map_err(|_| "资源下载地址无效")?.host_str().unwrap_or("").to_ascii_lowercase().as_str() {
        "cdn.modrinth.com" | "api.modrinth.com" => bind_modrinth_download(&file_url, &filename, settings).await?,
        "edge.forgecdn.net" | "mediafilez.forgecdn.net" | "media.forgecdn.net" | "www.curseforge.com" => bind_curseforge_download(&file_url, &filename, kind, settings).await?,
        _ => return Err("资源下载地址不属于允许的官方来源".into()),
    };
    if let Some(hint) = hint { if hint != bound.size { return Err("资源大小提示与官方元数据不一致".into()); } }
    install_bound(bound, root, run, kind).await
}

async fn install_fabric_api(args: &[Value], settings: &Value, game_dir: &Path) -> Result<Value> {
    count(args, 2, 2)?;
    online(settings)?;
    if settings.get("metadataOnlyMods").and_then(Value::as_bool) == Some(true) { return Err("仅元数据模式不安装资源".into()); }
    let game = string_arg(args, 0, 128, true)?;
    let instance = string_arg(args, 1, 240, true)?;
    leaf(&instance)?;
    let root = root_for(settings, game_dir, "")?;
    let run = run_dir(&root, settings, &instance)?;
    let _guard = acquire(&root, || false).await?;
    let raw = versions(&[json!("fabric-api"), json!(["fabric"]), json!([game]), json!("modrinth"), json!("mod")], settings).await?;
    let versions = raw.as_array().ok_or("Fabric API 版本响应无效")?;
    let mut selected = None;
    for version in versions {
        let compatible = version.get("game_versions").and_then(Value::as_array).map(|list| list.iter().any(|item| item.as_str() == Some(game.as_str()))).unwrap_or(false)
            && version.get("loaders").and_then(Value::as_array).map(|list| list.iter().any(|item| item.as_str() == Some("fabric"))).unwrap_or(false);
        if !compatible { continue; }
        let file = version.get("files").and_then(Value::as_array).and_then(|files| files.iter().find(|file| file.get("primary").and_then(Value::as_bool) == Some(true)).or_else(|| files.first()));
        if let Some(file) = file { selected = Some(bound_modrinth_file(file, None, text(file, "filename"))?); break; }
    }
    let bound = selected.ok_or_else(|| format!("未在 Modrinth 找到适配 {} 的 Fabric API", game))?;
    install_bound(bound, root, run, "mod").await
}

fn leaf(name: &str) -> Result<&str> {
    if name.is_empty() || name.len() > 240 || name.trim() != name || name.ends_with('.')
        || name.chars().any(|c| c.is_control() || "\\/:*?\"<>|".contains(c)) || matches!(name, "." | "..") {
        return Err("文件或实例名称不是安全的单级名称".into());
    }
    let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$"].contains(&stem.as_str())
        || ["COM", "LPT"].iter().any(|prefix| stem.strip_prefix(*prefix).map(|tail| ["1","2","3","4","5","6","7","8","9","¹","²","³"].contains(&tail)).unwrap_or(false)) {
        return Err("文件名不能使用系统设备名称".into());
    }
    Ok(name)
}
fn linked(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() { return true; }
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 { return true; }
    }
    false
}
fn checked_absolute(path: &Path) -> Result<PathBuf> {
    walk_absolute(path).or_else(|error| match crate::path_alias::resolved_alias(path) {
        // 系统别名落在末级时，规范化一次再复核；仍然失败则保留原始错误。
        Some(canonical) => walk_absolute(&canonical).map_err(|_| error),
        None => Err(error),
    })
}
fn walk_absolute(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() { return Err("必须提供绝对路径".into()); }
    let mut cursor = PathBuf::new();
    let mut parts = path.components().peekable();
    while let Some(component) = parts.next() {
        // 末级由启动器自己创建，任何平台都拒绝链接；祖先级只在桌面平台拒绝
        // （Android 私有目录前缀由系统维护，见 `crate::path_alias`）。
        let final_segment = parts.peek().is_none();
        match component {
            Component::Prefix(prefix) => {
                #[cfg(windows)] {
                    use std::path::Prefix;
                    if !matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)) {
                        return Err("不允许网络共享或设备路径".into());
                    }
                }
                cursor.push(prefix.as_os_str());
                continue;
            }
            Component::RootDir => cursor.push(component.as_os_str()),
            Component::Normal(name) => {
                let name = name.to_str().ok_or_else(|| "路径不是有效 UTF-8".to_owned())?;
                leaf(name)?;
                cursor.push(name);
            }
            _ => return Err("路径不得包含当前目录或上级目录段".into()),
        }
        match fs::symlink_metadata(&cursor) {
            Ok(metadata) if linked(&metadata) && crate::path_alias::link_is_fatal(final_segment) => {
                return Err("拒绝符号链接或重解析点路径".into());
            }
            Ok(_) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(_) => return Err("无法检查路径状态".into()),
        }
    }
    Ok(cursor)
}
fn metadata(path: &Path) -> Result<Option<Metadata>> {
    checked_absolute(path)?;
    match fs::symlink_metadata(path) {
        Ok(value) if linked(&value) => Err("拒绝符号链接或重解析点".into()),
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("无法读取文件状态".into()),
    }
}
fn child(root: &Path, segments: &[&str]) -> Result<PathBuf> {
    let mut path = checked_absolute(root)?;
    for name in segments { path.push(leaf(name)?); }
    checked_absolute(&path)
}
fn required_dir(path: &Path) -> Result<()> {
    if !metadata(path)?.map(|m| m.is_dir()).unwrap_or(false) { return Err("目录不存在或不是普通目录".into()); }
    Ok(())
}
fn required_file(path: &Path) -> Result<Metadata> {
    metadata(path)?.filter(|m| m.is_file()).ok_or("文件不存在或不是普通文件".into())
}
fn root_for(settings: &Value, game_dir: &Path, dir_id: &str) -> Result<PathBuf> {
    if dir_id.is_empty() { return checked_absolute(game_dir); }
    if dir_id == "default" {
        let raw = text(settings, "gameDirAbs");
        return if raw.is_empty() { checked_absolute(game_dir) } else { checked_absolute(Path::new(raw)) };
    }
    let directory = settings.get("versionDirs").and_then(Value::as_array).and_then(|dirs| dirs.iter().find(|dir| dir["id"] == dir_id))
        .ok_or("指定版本目录不存在")?;
    checked_absolute(Path::new(directory["path"].as_str().ok_or("版本目录路径无效")?))
}
fn version_dir(root: &Path, id: &str) -> Result<PathBuf> {
    let dir = child(root, &["versions", leaf(id)?])?;
    required_dir(&dir)?;
    Ok(dir)
}
fn run_dir(root: &Path, settings: &Value, id: &str) -> Result<PathBuf> {
    let version = version_dir(root, id)?;
    Ok(if crate::modpack::instance_isolated(root, id, settings)? { version } else { root.to_path_buf() })
}
fn content_kind(kind: &str) -> Result<&str> {
    match kind { "mods" | "resourcepacks" | "shaderpacks" | "screenshots" | "schematics" | "saves" => Ok(kind), _ => Err("未知本地内容类型".into()) }
}
fn extension_allowed(name: &str, kind: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let extension = lower.rsplit('.').next().unwrap_or("");
    match kind {
        "mods" => matches!(extension, "jar" | "zip"),
        "resourcepacks" => matches!(extension, "zip" | "jar" | "mcpack" | "mctemplate"),
        "shaderpacks" => matches!(extension, "zip" | "fsb" | "shader" | "glsl"),
        "screenshots" => matches!(extension, "png" | "jpg" | "jpeg" | "webp"),
        "schematics" => matches!(extension, "litematic" | "schem" | "schematic"),
        _ => false,
    }
}
fn path_text(path: &Path) -> Result<String> {
    path.to_str().map(str::to_owned).ok_or("路径不是有效 UTF-8".into())
}
fn list_content(root: &Path, settings: &Value, id: &str, kind: &str) -> Result<Value> {
    content_kind(kind)?;
    leaf(id)?;
    if metadata(root)?.is_none() { return Ok(json!([])); }
    let run = run_dir(root, settings, id)?;
    let dir = child(&run, &[kind])?;
    if metadata(&dir)?.is_none() { return Ok(json!([])); }
    required_dir(&dir)?;
    let mut out = Vec::new();
    // 单个坏文件（非 UTF-8 名、扫描期被占用/删除、权限等）只跳过该文件，绝不让整列变空——
    // 资源一多，碰到一个异常文件的概率显著上升，以前一个 ? 就让「资源列表直接显示空」。
    for entry in fs::read_dir(&dir).map_err(|_| "无法列出本地内容目录")? {
        let row = (|| -> Result<Option<Value>> {
            let entry = entry.map_err(|_| "无法读取本地内容目录项")?;
            let name = entry.file_name().into_string().map_err(|_| "文件名不是有效 UTF-8")?;
            leaf(&name)?;
            let info = entry.file_type().map_err(|_| "无法读取文件类型")?;
            if info.is_symlink() || !info.is_file() { return Ok(None); }
            let path = child(&dir, &[&name])?;
            let info = required_file(&path)?;
            let enabled = !name.ends_with(".disabled");
            let real_name = if kind == "mods" && !enabled { name.strip_suffix(".disabled").unwrap_or(&name) } else { &name };
            if !extension_allowed(real_name, kind) { return Ok(None); }
            let mut row = json!({"name":real_name,"path":path_text(&path)?,"size":info.len()});
            if kind == "mods" {
                row["enabled"] = json!(enabled);
                if let Some(name) = mod_metadata::display_name(&path, info.len()) {
                    row["displayName"] = json!(name);
                }
            }
            Ok(Some(row))
        })();
        if let Ok(Some(row)) = row { out.push(row); }
    }
    if matches!(kind, "resourcepacks" | "shaderpacks") {
        out.sort_by_key(|item| std::cmp::Reverse(item["size"].as_u64().unwrap_or(0)));
    } else { out.sort_by(|a, b| text(a, "name").to_lowercase().cmp(&text(b, "name").to_lowercase())); }
    Ok(Value::Array(out))
}
/* ------------------------------------------------------------------ */
/* 已安装资源的联网元数据补齐（Electron enrichMods / enrichResources 的移植）。   */
/* 「仅识别资源元数据」或本地模式下不联网，列表只显示 JAR 内本地元数据名。          */
/* ------------------------------------------------------------------ */

const ENRICH_CACHE_MAX: usize = 4096;
const ENRICH_CONCURRENCY: usize = 6;
static ENRICH_HITS: OnceLock<Mutex<std::collections::BTreeMap<String, Value>>> = OnceLock::new();
static ENRICH_INFLIGHT: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();
fn enrich_hits() -> &'static Mutex<std::collections::BTreeMap<String, Value>> { ENRICH_HITS.get_or_init(|| Mutex::new(std::collections::BTreeMap::new())) }
fn enrich_inflight() -> &'static Mutex<BTreeSet<String>> { ENRICH_INFLIGHT.get_or_init(|| Mutex::new(BTreeSet::new())) }

/// 归一化用于比较：只留小写字母数字（Electron squash 的移植）。
fn squash(value: &str) -> String { value.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_lowercase()).collect() }

/// Modrinth 识别挑选（Electron findProject 同策略）：slug 与 modId/查询词一致，
/// 或标题与查询词一致，否则取首个命中。
fn pick_project(hits: &[Value], id: &str, query: &str) -> Option<Value> {
    let id = id.trim().to_lowercase();
    let query = query.trim().to_lowercase();
    let exact = hits.iter().find(|hit| {
        let slug = text(hit, "slug").to_lowercase();
        let title = text(hit, "title").to_lowercase();
        (!id.is_empty() && slug == id) || (!query.is_empty() && (slug == query || title == query))
    });
    exact.or_else(|| hits.first()).cloned()
}

/// 资源包 / 光影没有可读项目名，只能拿文件名搜；从严匹配，避免挂错项目图标。
fn pick_pack_project(hits: &[Value], query: &str) -> Option<Value> {
    let target = squash(query);
    if target.is_empty() { return None; }
    hits.iter().find(|hit| {
        let title = squash(text(hit, "title"));
        title == target || title.starts_with(&target) || target.starts_with(&title)
    }).cloned()
}

async fn mr_find_project(query: &str, kind: &str, settings: &Value) -> Result<Option<Value>> {
    let mut url = endpoint(MR, &["search"])?;
    url.query_pairs_mut().append_pair("query", query)
        .append_pair("facets", &json!([[format!("project_type:{kind}")]]).to_string())
        .append_pair("limit", "5");
    let mut raw = remote(url, settings, false).await?;
    let hits = std::mem::take(raw.get_mut("hits").and_then(Value::as_array_mut).ok_or("Modrinth 搜索响应缺少 hits")?);
    Ok(Some(Value::Array(hits)))
}

/// 按「项目标识 + 名称」识别模组项目（Modrinth）。
async fn find_project_by_identity(id: &str, name: &str, settings: &Value) -> Result<Option<Value>> {
    let query = if name.trim().is_empty() { id.trim().to_owned() } else { name.trim().to_owned() };
    if query.is_empty() { return Ok(None); }
    let hits = match mr_find_project(&query, "mod", settings).await? { Some(Value::Array(hits)) => hits, _ => return Ok(None) };
    if hits.is_empty() { return Ok(None); }
    Ok(pick_project(&hits, id, &query))
}

/// 把安装文件名收拾成搜索关键词（Electron packSearchName 的移植）。
fn pack_search_name(filename: &str) -> String {
    let stem = filename.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(filename);
    let mut out = String::new();
    let mut chars = stem.chars().peekable();
    let mut bracket_depth = 0i32;
    while let Some(c) = chars.next() {
        if matches!(c, '(' | '[' | '{') { bracket_depth += 1; continue; }
        if matches!(c, ')' | ']' | '}') { bracket_depth = (bracket_depth - 1).max(0); continue; }
        if bracket_depth > 0 { continue; }
        if c == '_' || c == '-' || c == '.' { out.push(' '); continue; }
        if c.is_uppercase() {
            if let Some(prev) = out.chars().last() { if prev.is_ascii_lowercase() || prev.is_ascii_digit() { out.push(' '); } }
            out.extend(c.to_lowercase());
            continue;
        }
        out.push(c);
    }
    let words: Vec<&str> = out.split_whitespace().collect();
    // 去掉结尾的版本号串：1 20 / v2 / r5.5 这类尾巴都不是项目名的一部分。
    let mut end = words.len();
    while end > 0 {
        let word = words[end - 1];
        let digits = word.chars().filter(|c| c.is_ascii_digit()).count();
        let letters: String = word.chars().filter(|c| c.is_ascii_alphabetic()).collect();
        let version_tail = !word.is_empty() && digits > 0 && letters.len() <= 1 && word.chars().all(|c| c.is_ascii_alphanumeric() || c == '.');
        if version_tail { end -= 1; } else { break; }
    }
    words[..end].join(" ").trim().to_owned()
}

fn valid_icon_url(raw: &str) -> Option<String> {
    if raw.len() > 2048 || !raw.starts_with("https://") || raw.chars().any(char::is_control) { return None; }
    Some(raw.to_owned())
}

fn emit_resource_event<R: Runtime>(app: &AppHandle<R>, channel: &str, version_id: &str, kind: &str, file: Value) {
    let _ = app.emit_to("main", "launcher:event", json!({"channel":channel,"payload":{"versionId":version_id,"kind":kind,"file":file}}));
}

/// 已安装模组行的联网补齐：逐项识别 Modrinth 项目，命中后经 manage:mods-updated 推回整行。
async fn enrich_mods_task<R: Runtime>(app: AppHandle<R>, root: PathBuf, version_id: String, settings: Value) {
    let registration = match app.state::<crate::lifecycle::Gate>().enter() { Ok(r) => r, Err(_) => return };
    let result = async {
        let run = run_dir(&root, &settings, &version_id)?;
        let dir = child(&run, &["mods"])?;
        if metadata(&dir)?.is_none() { return Ok(()); }
        let mut rows = Vec::new();
        for entry in fs::read_dir(&dir).map_err(|_| "无法列出本地内容目录")? {
            let item = (|| -> Result<Option<(Value, Option<(String, String)>)>> {
                let entry = entry.map_err(|_| "无法读取本地内容目录项")?;
                let name = entry.file_name().into_string().map_err(|_| "文件名不是有效 UTF-8")?;
                leaf(&name)?;
                let info = entry.file_type().map_err(|_| "无法读取文件类型")?;
                if info.is_symlink() || !info.is_file() { return Ok(None); }
                let path = child(&dir, &[&name])?;
                let meta = required_file(&path)?;
                let enabled = !name.ends_with(".disabled");
                let real_name = name.strip_suffix(".disabled").unwrap_or(&name);
                if !extension_allowed(real_name, "mods") { return Ok(None); }
                let mut row = json!({"name":real_name,"path":path_text(&path)?,"size":meta.len()});
                row["enabled"] = json!(enabled);
                let identity = mod_metadata::mod_identity(&path, meta.len());
                if let Some(display) = mod_metadata::display_name(&path, meta.len()) { row["displayName"] = json!(display); }
                Ok(Some((row, identity)))
            })();
            if let Ok(Some(item)) = item { rows.push(item); }
        }
        let permits = Arc::new(tokio::sync::Semaphore::new(ENRICH_CONCURRENCY));
        let mut workers = tokio::task::JoinSet::new();
        for (row, identity) in rows {
            let Some((id, name)) = identity else { continue; };
            let cache_key = id.to_lowercase();
            let cached = enrich_hits().lock().map_err(|_| "资源补齐缓存不可用")?.get(&cache_key).cloned();
            let app = app.clone(); let version_id = version_id.clone(); let settings = settings.clone(); let permits = permits.clone();
            workers.spawn(async move {
                let _permit = permits.acquire_owned().await.ok();
                let project = match cached.clone() {
                    Some(hit) => Some(hit),
                    None => match find_project_by_identity(&id, &name, &settings).await { Ok(hit) => hit, Err(_) => None },
                };
                let Some(project) = project else { return };
                if cached.is_none() {
                    if let Ok(mut cache) = enrich_hits().lock() {
                        if cache.len() >= ENRICH_CACHE_MAX { cache.clear(); }
                        cache.insert(cache_key, project.clone());
                    }
                }
                let mut row = row;
                row["displayName"] = json!(text(&project, "title"));
                if let Some(icon) = project.get("icon_url").and_then(Value::as_str).and_then(valid_icon_url) { row["iconUrl"] = json!(icon); }
                let slug = text(&project, "slug");
                if !slug.is_empty() { row["slug"] = json!(slug); row["source"] = json!("modrinth"); }
                let description = text(&project, "description");
                if !description.is_empty() { row["description"] = json!(description); }
                if let Some(page) = project.get("pageUrl").and_then(Value::as_str).filter(|s| s.starts_with("https://")) { row["pageUrl"] = json!(page); }
                let _ = app.emit_to("main", "launcher:event", json!({"channel":"manage:mods-updated","payload":{"versionId":version_id,"mod":row}}));
            });
        }
        while workers.join_next().await.is_some() {}
        Ok::<(), String>(())
    }.await;
    registration.finish();
    let _ = result;
}

/// 已安装资源包 / 光影行的联网补齐：按文件名搜索 Modrinth，从严命中后经 manage:resources-updated 推回整行。
async fn enrich_resources_task<R: Runtime>(app: AppHandle<R>, root: PathBuf, version_id: String, kind: String, settings: Value) {
    let registration = match app.state::<crate::lifecycle::Gate>().enter() { Ok(r) => r, Err(_) => return };
    let result = async {
        let resource_kind = if kind == "shaderpacks" { "shader" } else { "resourcepack" };
        let run = run_dir(&root, &settings, &version_id)?;
        let dir = child(&run, &[&kind])?;
        if metadata(&dir)?.is_none() { return Ok(()); }
        let mut rows = Vec::new();
        for entry in fs::read_dir(&dir).map_err(|_| "无法列出本地内容目录")? {
            let item = (|| -> Result<Option<Value>> {
                let entry = entry.map_err(|_| "无法读取本地内容目录项")?;
                let name = entry.file_name().into_string().map_err(|_| "文件名不是有效 UTF-8")?;
                leaf(&name)?;
                let info = entry.file_type().map_err(|_| "无法读取文件类型")?;
                if info.is_symlink() || !info.is_file() { return Ok(None); }
                let path = child(&dir, &[&name])?;
                let meta = required_file(&path)?;
                if !extension_allowed(&name, &kind) { return Ok(None); }
                Ok(Some(json!({"name":name,"path":path_text(&path)?,"size":meta.len()})))
            })();
            if let Ok(Some(item)) = item { rows.push(item); }
        }
        let permits = Arc::new(tokio::sync::Semaphore::new(4));
        let mut workers = tokio::task::JoinSet::new();
        for row in rows {
            // 已有元数据的是命中过缓存的，不必再查。
            let query = pack_search_name(text(&row, "name"));
            if query.is_empty() { continue; }
            let cache_key = format!("{resource_kind}:{}", squash(&query));
            let cached = enrich_hits().lock().map_err(|_| "资源补齐缓存不可用")?.get(&cache_key).cloned();
            let app = app.clone(); let version_id = version_id.clone(); let settings = settings.clone(); let permits = permits.clone(); let kind = kind.clone();
            workers.spawn(async move {
                let _permit = permits.acquire_owned().await.ok();
                let project = match cached.clone() {
                    Some(hit) => Some(hit),
                    None => match mr_find_project(&query, resource_kind, &settings).await {
                        Ok(Some(Value::Array(hits))) => pick_pack_project(&hits, &query),
                        _ => None,
                    },
                };
                let Some(project) = project else { return };
                if cached.is_none() {
                    if let Ok(mut cache) = enrich_hits().lock() {
                        if cache.len() >= ENRICH_CACHE_MAX { cache.clear(); }
                        cache.insert(cache_key, project.clone());
                    }
                }
                let mut row = row;
                row["displayName"] = json!(text(&project, "title"));
                if let Some(icon) = project.get("icon_url").and_then(Value::as_str).and_then(valid_icon_url) { row["iconUrl"] = json!(icon); }
                let slug = text(&project, "slug");
                if !slug.is_empty() { row["slug"] = json!(slug); row["source"] = json!("modrinth"); }
                let description = text(&project, "description");
                if !description.is_empty() { row["description"] = json!(description); }
                if let Some(page) = project.get("pageUrl").and_then(Value::as_str).filter(|s| s.starts_with("https://")) { row["pageUrl"] = json!(page); }
                emit_resource_event(&app, "resources:updated", &version_id, &kind, row);
            });
        }
        while workers.join_next().await.is_some() {}
        Ok::<(), String>(())
    }.await;
    registration.finish();
    let _ = result;
}

fn enrichment_gated(settings: &Value) -> bool { text(settings, "mode") == "local" || settings.get("metadataOnlyMods").and_then(Value::as_bool) == Some(true) }

/// 登记一次后台补齐；同实例已在补齐中或设置不允许时返回 false（前端据此跳过渲染态即可）。
fn start_enrichment<R: Runtime>(app: &AppHandle<R>, root: PathBuf, version_id: &str, kind: &str, settings: &Value) -> Result<bool> {
    if enrichment_gated(settings) { return Ok(false); }
    let key = format!("{}|{version_id}|{kind}", path_text(&root)?);
    {
        let mut inflight = enrich_inflight().lock().map_err(|_| "资源补齐状态不可用")?;
        if !inflight.insert(key.clone()) { return Ok(false); }
    }
    let settings = settings.clone(); let app = app.clone(); let version_id = version_id.to_owned();
    let kind_owned = kind.to_owned();
    let _join = tauri::async_runtime::spawn(async move {
        let _guard = EnrichGuard(key.clone());
        let kind = kind_owned;
        if kind == "mods" { enrich_mods_task(app, root, version_id, settings).await; }
        else { enrich_resources_task(app, root, version_id, kind.to_owned(), settings).await; }
    });
    Ok(true)
}
struct EnrichGuard(String);
impl Drop for EnrichGuard { fn drop(&mut self) { if let Ok(mut set) = enrich_inflight().lock() { set.remove(&self.0); } } }

fn content_path(root: &Path, raw: &str, only_mod: bool) -> Result<PathBuf> {    let path = checked_absolute(Path::new(raw))?;
    let relative = path.strip_prefix(root).map_err(|_| "文件不在当前游戏目录内")?;
    let parts = relative.components().map(|part| part.as_os_str().to_str().ok_or_else(|| "文件路径无效".to_owned())).collect::<Result<Vec<_>>>()?;
    let (kind, filename) = match parts.as_slice() {
        [kind, filename] => (*kind, *filename),
        ["versions", id, kind, filename] => { version_dir(root, id)?; (*kind, *filename) },
        _ => return Err("只允许直接管理指定内容目录内的文件，禁止根目录及任意路径删除".into()),
    };
    content_kind(kind)?;
    if kind == "saves" || (only_mod && kind != "mods") { return Err("操作目标不属于允许的内容类型".into()); }
    let base_name = if kind == "mods" { filename.strip_suffix(".disabled").unwrap_or(filename) } else { filename };
    if !extension_allowed(base_name, kind) { return Err("不支持管理此文件类型".into()); }
    required_file(&path)?;
    Ok(path)
}
fn create_dirs(path: &Path) -> Result<()> {
    checked_absolute(path)?;
    fs::create_dir_all(path).map_err(|_| "无法创建内容目录")?;
    required_dir(path)
}
fn move_new(source: &Path, destination: &Path) -> Result<()> {
    checked_absolute(source)?;
    checked_absolute(destination)?;
    if metadata(destination)?.is_some() { return Err("目标已存在，拒绝覆盖".into()); }
    let info = metadata(source)?.ok_or("移动源不存在")?;
    if info.is_file() {
        fs::hard_link(source, destination).map_err(|_| "无法无覆盖发布文件（文件系统可能不支持硬链接）")?;
        if fs::remove_file(source).is_err() {
            return Err("目标文件已发布，但无法移除源文件；已保留两份，未删除可能被替换的目标".into());
        }
        Ok(())
    } else if info.is_dir() {
        fs::create_dir(destination).map_err(|_| "无法预留移动目标目录，未覆盖已有目录")?;
        let token = child(destination, &[&format!(".hcmcl-move-{}", Uuid::new_v4())])?;
        if let Err(error) = write_new(&token, b"") {
            let _ = fs::remove_dir(destination);
            return Err(error);
        }
        let mut moved = Vec::<String>::new();
        let operation: Result<()> = (|| {
            for entry in fs::read_dir(source).map_err(|_| "无法读取待移动目录")? {
                let name = entry.map_err(|_| "无法读取待移动目录项")?.file_name().into_string().map_err(|_| "目录项不是有效 UTF-8")?;
                move_new(&child(source, &[&name])?, &child(destination, &[&name])?)?;
                moved.push(name);
            }
            checked_absolute(source)?;
            fs::remove_dir(source).map_err(|_| "源目录已发生变化，未完成移动")?;
            fs::remove_file(&token).map_err(|_| "无法清理目录移动标记")?;
            Ok(())
        })();
        if let Err(error) = operation {
            let rollback: Result<()> = (|| {
                required_file(&token)?;
                if metadata(source)?.is_none() { fs::create_dir(source).map_err(|_| "无法恢复源目录")?; }
                for name in moved.iter().rev() { move_new(&child(destination, &[name])?, &child(source, &[name])?)?; }
                fs::remove_file(&token).map_err(|_| "无法移除移动回滚标记")?;
                fs::remove_dir(destination).map_err(|_| "无法移除移动回滚目录")?;
                Ok(())
            })();
            return Err(match rollback { Ok(()) => error, Err(detail) => format!("{error}；目录移动回滚未完成：{detail}，未覆盖冲突文件") });
        }
        Ok(())
    } else { Err("不支持移动特殊文件".into()) }
}
fn copy_local<R: Runtime>(app: &AppHandle<R>, root: &Path, settings: &Value, id: &str, kind: &str, source: &Path) -> Result<Value> {
    desktop::require_picked_file(app, source)?;
    if !matches!(kind, "mods" | "resourcepacks" | "shaderpacks") { return Err("不支持导入此内容类型".into()); }
    let source = checked_absolute(source)?;
    let source_info = required_file(&source)?;
    if source_info.len() > FILE_CAP { return Err("本地资源超过 2 GiB 上限".into()); }
    let name = source.file_name().and_then(|v| v.to_str()).ok_or("本地资源文件名无效")?;
    leaf(name)?;
    if !extension_allowed(name, kind) { return Err("所选文件扩展名与资源类型不匹配".into()); }
    let run = run_dir(root, settings, id)?;
    let dir = child(&run, &[kind])?;
    create_dirs(&dir)?;
    let target = child(&dir, &[name])?;
    if metadata(&target)?.is_some() { return Err("同名文件已存在，未覆盖".into()); }
    let temporary = child(&dir, &[&format!(".hcmcl-import-{}.tmp", Uuid::new_v4())])?;
    let result = (|| {
        let mut input = File::open(&source).map_err(|_| "无法打开本地资源")?;
        let opened = input.metadata().map_err(|_| "无法读取本地资源状态")?;
        if opened.len() != source_info.len() || !opened.is_file() { return Err("本地资源在读取前发生变化".into()); }
        let mut output = OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|_| "无法暂存本地资源")?;
        let mut limited = (&mut input).take(FILE_CAP + 1);
        let copied = std::io::copy(&mut limited, &mut output).map_err(|_| "复制本地资源失败")?;
        if copied > FILE_CAP || copied != source_info.len() || required_file(&source)?.len() != source_info.len() {
            return Err("本地资源在复制期间发生变化或超过上限".into());
        }
        output.flush().map_err(|_| "刷新本地资源失败")?;
        output.sync_all().map_err(|_| "提交本地资源失败")?;
        drop(output);
        move_new(&temporary, &target)?;
        Ok(json!(path_text(&target)?))
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}
fn preflight_tree(root: &Path, budget: &mut usize, depth: usize) -> Result<()> {
    if depth > 128 || *budget == 0 { return Err("目录过深或条目过多，拒绝批量管理".into()); }
    *budget -= 1;
    let info = metadata(root)?.ok_or("待操作目录项已不存在")?;
    if info.is_file() { return Ok(()); }
    if !info.is_dir() { return Err("拒绝管理特殊文件".into()); }
    for entry in fs::read_dir(root).map_err(|_| "无法检查待操作目录")? {
        let entry = entry.map_err(|_| "无法检查待操作目录项")?;
        preflight_tree(&entry.path(), budget, depth + 1)?;
    }
    Ok(())
}
fn remove_tree(path: &Path) -> Result<()> {
    fn remove(path: &Path, budget: &mut usize, depth: usize) -> Result<()> {
        if depth > 128 || *budget == 0 { return Err("删除期间目录过深或条目过多，已停止操作".into()); }
        *budget -= 1;
        let info = metadata(path)?.ok_or("待删除目录项已不存在")?;
        if info.is_file() { return fs::remove_file(path).map_err(|_| "删除文件失败".into()); }
        if !info.is_dir() { return Err("拒绝删除特殊文件".into()); }
        for entry in fs::read_dir(path).map_err(|_| "无法列出待删除目录")? {
            remove(&entry.map_err(|_| "无法读取待删除目录项")?.path(), budget, depth + 1)?;
        }
        checked_absolute(path)?;
        fs::remove_dir(path).map_err(|_| "删除目录失败".into())
    }
    let mut budget = 200_000;
    remove(path, &mut budget, 0)
}
fn read_file_bytes(path: &Path) -> Result<Vec<u8>> {
    let info = required_file(path)?;
    if info.len() > JSON_CAP as u64 { return Err("文件超过安全大小上限".into()); }
    let mut data = Vec::new();
    File::open(path).map_err(|_| "无法读取文件")?.take(JSON_CAP as u64 + 1)
        .read_to_end(&mut data).map_err(|_| "读取文件失败")?;
    if data.len() > JSON_CAP { return Err("文件超过安全大小上限".into()); }
    Ok(data)
}
fn read_json(path: &Path) -> Result<Value> {
    let data = read_file_bytes(path).map_err(|_| "无法读取实例 JSON")?;
    let bytes = data.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&data);
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "实例 JSON 已损坏，未修改实例")?;
    if !value.is_object() { return Err("实例 JSON 必须是对象".into()); }
    Ok(value)
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    checked_absolute(path)?;
    let mut file = OpenOptions::new().write(true).create_new(true).open(path).map_err(|_| "无法创建文件，或目标已存在")?;
    if file.write_all(bytes).and_then(|_| file.sync_all()).is_err() {
        drop(file);
        let _ = fs::remove_file(path);
        return Err("写入文件失败".into());
    }
    Ok(())
}
fn rename_version(root: &Path, storage: &Storage, id: &str, new_id: &str) -> Result<Value> {
    leaf(id)?;
    leaf(new_id)?;
    let source = version_dir(root, id)?;
    let original_json = child(&source, &[&format!("{id}.json")])?;
    let original_bytes = read_file_bytes(&original_json)?;
    let mut version = serde_json::from_slice::<Value>(original_bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&original_bytes))
        .map_err(|_| "实例 JSON 已损坏，未修改实例")?;
    if !version.is_object() { return Err("实例 JSON 必须是对象".into()); }
    if new_id == id { return Ok(json!(id)); }
    let destination = child(root, &["versions", new_id])?;
    if metadata(&destination)?.is_some() { return Err("新实例名称已存在，未覆盖".into()); }
    let old_natives = child(root, &["natives", id])?;
    let new_natives = child(root, &["natives", new_id])?;
    let has_natives = metadata(&old_natives)?.is_some();
    if has_natives && metadata(&new_natives)?.is_some() { return Err("新实例的 natives 目录已存在，未覆盖".into()); }
    let mut budget = 200_000;
    preflight_tree(&source, &mut budget, 0)?;
    if has_natives { required_dir(&old_natives)?; preflight_tree(&old_natives, &mut budget, 0)?; }
    for suffix in ["json", "jar"] {
        if metadata(&child(&source, &[&format!("{new_id}.{suffix}")])?)?.is_some() {
            return Err("实例内部存在与新名称冲突的文件，未重命名".into());
        }
    }
    version["id"] = json!(new_id);
    let bytes = serde_json::to_vec_pretty(&version).map_err(|_| "无法编码实例 JSON")?;
    fs::create_dir(&destination).map_err(|_| "无法预留新实例目录，目标可能已存在")?;
    let token = child(&destination, &[&format!(".hcmcl-rename-{}", Uuid::new_v4())])?;
    if let Err(error) = write_new(&token, b"") {
        let _ = fs::remove_dir(&destination);
        return Err(error);
    }
    let mut moved = Vec::<String>::new();
    let mut natives_moved = false;
    let mut new_json_written = false;
    let mut jar_renamed = false;
    let new_json = child(&destination, &[&format!("{new_id}.json")])?;
    let old_json = child(&destination, &[&format!("{id}.json")])?;
    let mut old_json_moved = false;
    let mut storage_committed = false;
    let operation: Result<()> = (|| {
        let entries = fs::read_dir(&source).map_err(|_| "无法读取原实例目录")?.collect::<std::io::Result<Vec<_>>>().map_err(|_| "无法读取原实例目录项")?;
        for entry in entries {
            let name = entry.file_name().into_string().map_err(|_| "实例内部文件名无效")?;
            if name == format!("{id}.json") { continue; }
            move_new(&child(&source, &[&name])?, &child(&destination, &[&name])?)?;
            moved.push(name);
        }
        write_new(&new_json, &bytes)?;
        new_json_written = true;
        let old_jar = child(&destination, &[&format!("{id}.jar")])?;
        if metadata(&old_jar)?.is_some() {
            move_new(&old_jar, &child(&destination, &[&format!("{new_id}.jar")])?)?;
            jar_renamed = true;
        }
        if has_natives { move_new(&old_natives, &new_natives)?; natives_moved = true; }
        move_new(&original_json, &old_json)?;
        old_json_moved = true;
        fs::remove_dir(&source).map_err(|_| "原实例目录发生变化，无法完成重命名")?;
        storage.commit_version_change_for_backend(id, Some(new_id))?;
        storage_committed = true;
        fs::remove_file(&old_json).map_err(|_| "无法清理旧实例 JSON")?;
        fs::remove_file(&token).map_err(|_| "无法清理实例重命名标记")?;
        Ok(())
    })();
    if let Err(error) = operation {
        if storage_committed {
            return Err(format!("实例设置已提交，但重命名后的清理失败：{error}"));
        }
        let rollback: Result<()> = (|| {
            if required_file(&token).is_err() { return Err("实例所有权标记已改变，未清理可能属于并发操作的目录".into()); }
            if metadata(&source)?.is_none() { fs::create_dir(&source).map_err(|_| "无法恢复原实例目录")?; }
            if natives_moved { move_new(&new_natives, &old_natives)?; }
            if jar_renamed { move_new(&child(&destination, &[&format!("{new_id}.jar")])?, &child(&destination, &[&format!("{id}.jar")])?)?; }
            if new_json_written { fs::remove_file(&new_json).map_err(|_| "无法回滚新实例 JSON")?; }
            if old_json_moved { move_new(&old_json, &original_json)?; }
            for name in moved.iter().rev() { move_new(&child(&destination, &[name])?, &child(&source, &[name])?)?; }
            fs::remove_file(&token).map_err(|_| "无法清理回滚标记")?;
            fs::remove_dir(&destination).map_err(|_| "无法清理回滚目录")?;
            Ok(())
        })();
        return Err(match rollback { Ok(()) => error, Err(rollback) => format!("{error}；回滚未完成：{rollback}。请检查两个实例目录，未覆盖冲突文件") });
    }
    Ok(json!(new_id))
}

fn quarantine_version(root: &Path, storage: &Storage, id: &str) -> Result<Value> {
    leaf(id)?;
    let target = version_dir(root, id)?;
    let natives = child(root, &["natives", id])?;
    let has_natives = metadata(&natives)?.is_some();
    let mut budget = 200_000;
    preflight_tree(&target, &mut budget, 0)?;
    if has_natives { required_dir(&natives)?; preflight_tree(&natives, &mut budget, 0)?; }
    let trash_root = child(root, &[".hcmcl-quarantine"])?;
    create_dirs(&trash_root)?;
    let trash = child(&trash_root, &[&format!("{}-{}", id, Uuid::new_v4())])?;
    fs::create_dir(&trash).map_err(|_| "无法建立实例隔离目录，未删除实例")?;
    let token = child(&trash, &[&format!(".hcmcl-delete-{}", Uuid::new_v4())])?;
    write_new(&token, b"")?;
    let staged_version = child(&trash, &["version"])?;
    let staged_natives = child(&trash, &["natives"])?;
    let mut version_moved = false;
    let mut natives_moved = false;
    let operation: Result<()> = (|| {
        move_new(&target, &staged_version)?;
        version_moved = true;
        if has_natives { move_new(&natives, &staged_natives)?; natives_moved = true; }
        storage.commit_version_change_for_backend(id, None)?;
        Ok(())
    })();
    if let Err(error) = operation {
        let rollback: Result<()> = (|| {
            required_file(&token)?;
            if natives_moved { move_new(&staged_natives, &natives)?; }
            if version_moved { move_new(&staged_version, &target)?; }
            fs::remove_file(&token).map_err(|_| "无法清理删除回滚标记")?;
            fs::remove_dir(&trash).map_err(|_| "无法清理删除隔离目录")?;
            Ok(())
        })();
        return Err(match rollback { Ok(()) => error, Err(detail) => format!("{error}；删除回滚未完成：{detail}，实例已隔离于 {}", path_text(&trash)? ) });
    }
    if let Err(error) = remove_tree(&trash) {
        return Err(format!("实例设置已提交，但隔离目录清理失败，请手动处理 {}：{error}", path_text(&trash)?));
    }
    let _ = fs::remove_dir(&trash_root);
    Ok(json!(true))
}

fn local_call<R: Runtime>(app: &AppHandle<R>, storage: &Storage, channel: &str, args: &[Value], settings: &Value, game_dir: &Path) -> Result<Value> {
    let dir_id = if channel == "manage:mods" { string_arg(args, 1, 128, false)? } else { String::new() };
    let root = root_for(settings, game_dir, &dir_id)?;
    if root.parent().is_none() || root.file_name().is_none() { return Err("禁止将文件系统根目录作为游戏目录".into()); }
    match channel {
        "manage:enrichMods" => {
            count(args, 1, 2)?;
            if metadata(&root)?.is_none() { return Ok(json!(false)); }
            let id = string_arg(args, 0, 240, true)?;
            return start_enrichment(app, root, &id, "mods", settings).map(|started| json!(started));
        }
        "manage:enrichResources" => {
            count(args, 2, 3)?;
            if metadata(&root)?.is_none() { return Ok(json!(false)); }
            let id = string_arg(args, 0, 240, true)?;
            let kind = string_arg(args, 1, 32, true)?;
            if !matches!(kind.as_str(), "resourcepacks" | "shaderpacks") { return Err("未知资源目录类型".into()); }
            return start_enrichment(app, root, &id, &kind, settings).map(|started| json!(started));
        }
        "manage:mods" => {
            count(args, 1, 2)?;
            return list_content(&root, settings, &string_arg(args, 0, 240, true)?, "mods");
        }
        "resources:list" => {
            count(args, 2, 2)?;
            let id = string_arg(args, 0, 240, true)?;
            let kind = string_arg(args, 1, 32, true)?;
            if !matches!(kind.as_str(), "resourcepacks" | "shaderpacks") { return Err("未知资源目录类型".into()); }
            return list_content(&root, settings, &id, &kind);
        }
        "manage:schematics" => {
            count(args, 1, 1)?;
            return list_content(&root, settings, &string_arg(args, 0, 240, true)?, "schematics");
        }
        _ => {},
    }
    match channel {
        "manage:toggleMod" | "manage:deleteMod" | "manage:deleteFile" | "resources:remove" | "manage:deleteVersion" => count(args, 1, 1)?,
        "manage:installLocalMod" | "manage:deleteWorld" | "manage:renameVersion" => count(args, 2, 2)?,
        "manage:installLocalResource" => count(args, 3, 3)?,
        _ => return Err("未实现的本地管理操作".into()),
    }
    if matches!(channel, "manage:installLocalMod" | "manage:installLocalResource") && settings.get("metadataOnlyMods").and_then(Value::as_bool) == Some(true) {
        return Err("仅元数据模式不安装或导入资源".into());
    }
    let _lock = acquire_blocking(&root)?;
    match channel {
        "manage:toggleMod" => {
            count(args, 1, 1)?;
            let path = content_path(&root, &string_arg(args, 0, 32768, true)?, true)?;
            let name = path.file_name().and_then(|name| name.to_str()).ok_or("模组文件名无效")?;
            let destination_name = name.strip_suffix(".disabled").map(str::to_owned).unwrap_or_else(|| format!("{name}.disabled"));
            let destination = child(path.parent().ok_or("模组目录无效")?, &[&destination_name])?;
            move_new(&path, &destination)?;
            Ok(Value::Null)
        }
        "manage:deleteMod" | "manage:deleteFile" | "resources:remove" => {
            count(args, 1, 1)?;
            let path = content_path(&root, &string_arg(args, 0, 32768, true)?, channel == "manage:deleteMod")?;
            if channel == "resources:remove" {
                let kind = path.parent().and_then(Path::file_name).and_then(|value| value.to_str()).ok_or("资源目录无效")?;
                if !matches!(kind, "resourcepacks" | "shaderpacks") { return Err("只能移除资源包或光影文件".into()); }
            }
            fs::remove_file(&path).map_err(|_| "删除本地文件失败")?;
            Ok(Value::Null)
        }
        "manage:installLocalMod" | "manage:installLocalResource" => {
            if settings.get("metadataOnlyMods").and_then(Value::as_bool) == Some(true) {
                return Err("仅元数据模式不安装或导入资源".into());
            }
            let (kind, source) = if channel == "manage:installLocalMod" {
                count(args, 2, 2)?;
                ("mods".to_owned(), string_arg(args, 1, 32768, true)?)
            } else {
                count(args, 3, 3)?;
                (string_arg(args, 1, 32, true)?, string_arg(args, 2, 32768, true)?)
            };
            copy_local(app, &root, settings, &string_arg(args, 0, 240, true)?, &kind, Path::new(&source))
        }
        "manage:deleteWorld" => {
            count(args, 2, 2)?;
            let id = string_arg(args, 0, 240, true)?;
            let name = string_arg(args, 1, 240, true)?;
            let run = run_dir(&root, settings, &id)?;
            let target = child(&run, &["saves", leaf(&name)?])?;
            required_dir(&target)?;
            let mut budget = 200_000;
            preflight_tree(&target, &mut budget, 0)?;
            remove_tree(&target)?;
            Ok(Value::Null)
        }
        "manage:deleteVersion" => {
            count(args, 1, 1)?;
            quarantine_version(&root, storage, &string_arg(args, 0, 240, true)?)
        }
        "manage:renameVersion" => {
            count(args, 2, 2)?;
            rename_version(&root, storage, &string_arg(args, 0, 240, true)?, &string_arg(args, 1, 240, true)?)
        }
        _ => Err("未实现的本地管理操作".into()),
    }
}

/// None 只表示未实现的通道，不代表操作成功。宿主必须传入可信的内部设置和当前游戏目录。
pub async fn call<R: Runtime>(app: &AppHandle<R>, channel: &str, args: &[Value], settings: &Value, game_dir: &Path) -> Result<Option<Value>> {
    match channel {
        "mods:search" => return search(args, settings).await.map(Some),
        "mods:project" => return project(args, settings).await.map(Some),
        "mods:versions" => return versions(args, settings).await.map(Some),
        "mods:install" | "mods:installFabricApi" | "mods:installOfflineTranslate" => return install::call(app, channel, args, settings, game_dir).await.map(Some),
        "resources:list" | "resources:remove" | "manage:mods" | "manage:schematics"
        | "manage:enrichMods" | "manage:enrichResources"
        | "manage:toggleMod" | "manage:deleteMod" | "manage:installLocalMod"
        | "manage:installLocalResource" | "manage:deleteWorld" | "manage:deleteFile"
        | "manage:renameVersion" | "manage:deleteVersion" => {},
        _ => return Ok(None),
    }
    let app = app.clone();
    let channel = channel.to_owned();
    let args = args.to_vec();
    let settings = settings.clone();
    let game_dir = game_dir.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let storage = app.state::<Storage>();
        local_call(&app, storage.inner(), &channel, &args, &settings, &game_dir)
    }).await.map_err(|_| "本地资源管理任务异常".to_owned())?.map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enrichment_project_picking_and_pack_search_name() {
        let hits = vec![
            json!({"slug":"not-it","title":"Something Else","icon_url":"https://cdn.modrinth.com/a.png"}),
            json!({"slug":"jei","title":"Just Enough Items","icon_url":"https://cdn.modrinth.com/b.png","description":"d","pageUrl":"https://modrinth.com/mod/jei"}),
        ];
        // slug 与 modId 一致时命中对应项目。
        let picked = pick_project(&hits, "jei", "Just Enough Items").unwrap();
        assert_eq!(text(&picked, "slug"), "jei");
        // 标题与查询词一致同样命中。
        let picked = pick_project(&hits, "anything", "just enough items").unwrap();
        assert_eq!(text(&picked, "slug"), "jei");
        // 无一致项时回退首个（Electron findProject 同策略）。
        let picked = pick_project(&hits, "zzz", "zzz").unwrap();
        assert_eq!(text(&picked, "slug"), "not-it");
        // 资源包从严： squashed 前缀匹配才认，避免挂错图标。
        let packs = vec![
            json!({"slug":"complementary","title":"Complementary Unbound r5.5"}),
            json!({"slug":"other","title":"Unrelated Pack"}),
        ];
        assert_eq!(text(&pick_pack_project(&packs, "Complementary Unbound").unwrap(), "slug"), "complementary");
        assert!(pick_pack_project(&packs, "Stay True").is_none());
        // packSearchName：扩展名 / 括号备注 / 驼峰 / 分隔符 / 结尾版本号。
        assert_eq!(pack_search_name("ComplementaryUnbound r5.5 (Chocapic13 edit) [1.20].zip"), "complementary unbound");
        assert_eq!(pack_search_name("Stay True 1 20.zip"), "stay true");
        assert_eq!(pack_search_name("Bliss v2 1 2.zip"), "bliss");
        assert_eq!(pack_search_name("Sildurs_Vibrant_Shaders_v1.29.zip"), "sildurs vibrant shaders");
        // 非 https 图标一律不进事件。
        assert!(valid_icon_url("http://insecure.example/a.png").is_none());
        assert!(valid_icon_url("https://cdn.modrinth.com/a.png").is_some());
        assert!(valid_icon_url(&format!("https://x/{}", "a".repeat(2100))).is_none());
    }

    #[test]
    fn names_reject_traversal_devices_and_windows_aliases() {
        for name in ["", ".", "..", "../outside", "a/b", "a\\b", "accounts.dat.", "name ", "a:stream", "CON", "nul.txt", "COM1.jar", "LPT¹.zip"] {
            assert!(leaf(name).is_err(), "{name}");
        }
        for name in ["1.21.1-Fabric", "中文实例", "sodium.jar", "sodium.jar.disabled"] {
            assert_eq!(leaf(name).unwrap(), name);
        }
        assert!(checked_absolute(Path::new("relative/file.jar")).is_err());
        assert!(extension_allowed("mod.JAR", "mods"));
        assert!(!extension_allowed("script.exe", "mods"));
        assert!(extension_allowed("pack.mcpack", "resourcepacks"));
        assert!(extension_allowed("shader.glsl", "shaderpacks"));
    }

    #[test]
    fn curseforge_fields_hashes_and_dependencies_are_preserved() {
        let project = json!({"id":12,"name":"Fixture","slug":"fixture","summary":"描述","classId":6,"logo":{"url":"https://example.invalid/icon.png"},"allowModDistribution":true,"extraProjectField":17});
        let dto = cf_project_dto(&project, "mod", true).unwrap();
        assert_eq!(dto["title"], "Fixture");
        assert_eq!(dto["extraProjectField"], 17);
        assert_eq!(dto["body"], "");
        let file = json!({"id":34,"modId":12,"fileName":"fixture.jar","displayName":"Fixture 1","fileLength":5,"fileDate":"2026-01-01T00:00:00Z","downloadUrl":"https://example.invalid/fixture.jar","gameVersions":["1.21.1","Fabric"],"hashes":[{"algo":1,"value":"sha1-fixture"},{"algo":2,"value":"md5-fixture"}],"dependencies":[{"modId":56,"relationType":3}],"extraFileField":true});
        let version = cf_version_dto(&file, &project, "mod").unwrap();
        assert_eq!(version["id"], "34");
        assert_eq!(version["game_versions"], json!(["1.21.1"]));
        assert_eq!(version["loaders"], json!(["fabric"]));
        assert_eq!(version["files"][0]["filename"], "fixture.jar");
        assert_eq!(version["files"][0]["hashes"]["sha1"], "sha1-fixture");
        assert_eq!(version["dependencies"][0]["project_id"], "56");
        assert_eq!(version["dependencies"][0]["dependency_type"], "required");
        assert_eq!(version["curseforge_dependencies"], file["dependencies"]);
        assert_eq!(version["extraFileField"], true);
        let mut blocked_project = project;
        blocked_project["allowModDistribution"] = json!(false);
        let blocked = cf_version_dto(&file, &blocked_project, "mod").unwrap();
        assert_eq!(blocked["downloadable"], false);
        assert_eq!(blocked["files"], json!([]));
        let mut blocked_file = file;
        blocked_file["downloadUrl"] = Value::Null;
        assert_eq!(cf_version_dto(&blocked_file, &blocked_project, "mod").unwrap()["files"], json!([]));
    }

    #[test]
    fn fixed_endpoints_and_parameter_validation_do_not_need_network() {
        let url = endpoint(MR, &["project", "fabric-api", "version"]).unwrap();
        assert_eq!(url.host_str(), Some("api.modrinth.com"));
        assert_eq!(url.path(), "/v2/project/fabric-api/version");
        assert!(endpoint(MR, &["project", "../escape"]).is_err());
        assert!(endpoint(CF, &["mods", ""]).is_err());
        assert_eq!(category_id("mod", "optimization"), Some(6814));
        assert_eq!(category_id("shader", "optimization"), None);
        assert!(string_array(&[json!(false)], 0).is_err());
        assert!(string_arg(&[json!(42)], 0, 32, true).is_err());
        assert!(online(&json!({"mode":"local"})).is_err());
        let fixture = Fixture::new("legacy-isolation");
        fs::create_dir_all(fixture.0.join("versions/isolated")).unwrap();
        fs::create_dir_all(fixture.0.join("versions/shared")).unwrap();
        assert_eq!(run_dir(&fixture.0, &json!({"versionIsolation":false,"isolatedVersions":["isolated"]}), "isolated").unwrap(), fixture.0.join("versions/isolated"));
        assert_eq!(run_dir(&fixture.0, &json!({"versionIsolation":false}), "shared").unwrap(), fixture.0);
    }

    #[test]
    fn local_mode_rejects_network_and_metadata_only_is_separate() {
        let settings = json!({"mode":"local"});
        assert!(online(&settings).is_err());
        // 上游设置字段是 metadataOnlyMods；它限制元数据补齐/安装，不是 mode 枚举值。
        assert!(online(&json!({"mode":"normal", "metadataOnlyMods":true})).is_ok());
        assert!(matches!("modpack:import", "modpack:import"));
        assert!(matches!("mods:install", "mods:install"));
    }

    struct Fixture(PathBuf);
    impl Fixture {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!("hcmcl-catalog-{label}-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn local_mod_list_preserves_file_fields_sorting_and_metadata_fallback() {
        let fixture = Fixture::new("mod-names");
        let root = fs::canonicalize(&fixture.0).unwrap();
        let version = root.join("versions").join("fixture");
        let mods = version.join("mods");
        fs::create_dir_all(&mods).unwrap();
        fs::write(version.join("instance.json"), br#"{"isolation":true}"#).unwrap();

        for (file, display) in [("a.JAR.disabled", "Zulu"), ("B.zip", "Alpha")] {
            let mut zip = zip::ZipWriter::new(File::create(mods.join(file)).unwrap());
            zip.start_file("fabric.mod.json", zip::write::FileOptions::default()).unwrap();
            zip.write_all(&serde_json::to_vec(&json!({"id":"fixture","name":display})).unwrap()).unwrap();
            zip.finish().unwrap();
        }
        let bad_archive = b"not a ZIP";
        fs::write(mods.join("c.jar"), bad_archive).unwrap();
        fs::write(mods.join("ignored.txt"), b"ignored").unwrap();
        fs::create_dir(mods.join("ignored.jar")).unwrap();
        fs::create_dir(root.join("mods")).unwrap();
        fs::write(root.join("mods/wrong-root.jar"), b"ignored").unwrap();

        let rows = list_content(&root, &json!({"mode":"local"}), "fixture", "mods").unwrap();
        let disabled = mods.join("a.JAR.disabled");
        let enabled = mods.join("B.zip");
        assert_eq!(rows, json!([
            {"name":"a.JAR","path":path_text(&disabled).unwrap(),"size":fs::metadata(&disabled).unwrap().len(),"enabled":false,"displayName":"Zulu"},
            {"name":"B.zip","path":path_text(&enabled).unwrap(),"size":fs::metadata(&enabled).unwrap().len(),"enabled":true,"displayName":"Alpha"},
            {"name":"c.jar","path":path_text(&mods.join("c.jar")).unwrap(),"size":bad_archive.len(),"enabled":true}
        ]));
    }

    #[test]
    fn instance_marker_selects_resource_directory_without_crossing_roots() {
        let first = Fixture::new("marked-resource");
        let second = Fixture::new("unmarked-resource");
        for root in [&first.0, &second.0] { fs::create_dir_all(root.join("versions/same")).unwrap(); }
        fs::write(first.0.join("versions/same/instance.json"), br#"{"isolation":true}"#).unwrap();
        assert_eq!(run_dir(&first.0, &json!({}), "same").unwrap(), first.0.join("versions/same"));
        assert_eq!(run_dir(&second.0, &json!({}), "same").unwrap(), second.0);
        fs::write(first.0.join("versions/same/instance.json"), b"invalid").unwrap();
        assert!(run_dir(&first.0, &json!({}), "same").is_err());
    }

    #[test]
    fn install_binding_requires_official_url_filename_and_file_id() {
        let sha1 = "a".repeat(40);
        let sha512 = "b".repeat(128);
        let url = "https://cdn.modrinth.com/data/fixture/versions/v1/fixture.jar";
        let file = json!({"filename":"fixture.jar","url":url,"size":7,"hashes":{"sha1":sha1,"sha512":sha512}});
        let bound = bound_modrinth_file(&file, Some(url), "fixture.jar").unwrap();
        assert_eq!(bound.filename, "fixture.jar");
        assert_eq!(bound.size, 7);
        assert_eq!(bound.source, "modrinth");
        assert_eq!(bound.kind, "mod");
        assert!(bound_modrinth_file(&file, Some(url), "other.jar").is_err());
        assert!(official_download_url("https://downloads.example.invalid/fixture.jar", "modrinth").is_err());
        assert_eq!(modrinth_version_from_url(&Url::parse(url).unwrap()).unwrap(), "v1");

        let cf_url = "https://edge.forgecdn.net/files/1234/567/fixture.jar";
        assert_eq!(curseforge_file_id_from_url(&Url::parse(cf_url).unwrap()).unwrap(), 1_234_567);
        let project = json!({"id":12,"classId":6,"allowModDistribution":true});
        let cf_file = json!({"id":1234567,"modId":12,"classId":6,"fileName":"fixture.jar","fileLength":7,"downloadUrl":cf_url,"isAvailable":true,"hashes":[{"algo":1,"value":"c".repeat(40)}]});
        let bound = bound_curseforge_file(&cf_file, &project, cf_url, "fixture.jar", "mod").unwrap();
        assert_eq!(bound.source, "curseforge");
        assert!(bound_curseforge_file(&cf_file, &json!({"allowModDistribution":false}), cf_url, "fixture.jar", "mod").is_err());
    }

    #[test]
    fn install_binding_rejects_invalid_hash_lengths_and_sizes() {
        let url = "https://cdn.modrinth.com/data/fixture/versions/v1/fixture.jar";
        let invalid_hashes = json!({
            "filename":"fixture.jar",
            "url":url,
            "size":7,
            "hashes":{"sha1":"a".repeat(39),"sha512":"b".repeat(127)}
        });
        assert!(normalize_hash(&"a".repeat(39), 40).is_none(), "SHA-1 必须严格为 40 个十六进制字符");
        assert!(normalize_hash(&"b".repeat(127), 128).is_none(), "SHA-512 必须严格为 128 个十六进制字符");
        assert!(normalize_hash(&"a".repeat(128), 40).is_none());
        assert!(normalize_hash(&"b".repeat(40), 128).is_none());
        assert_eq!(normalize_hash(&"A".repeat(40), 40).as_deref(), Some("a".repeat(40).as_str()));
        assert!(bound_modrinth_file(&invalid_hashes, Some(url), "fixture.jar").is_err(), "官方哈希长度无效时必须拒绝安装");
        let zero_size = json!({"filename":"fixture.jar","url":url,"size":0,"hashes":{"sha1":"a".repeat(40)}});
        assert!(bound_modrinth_file(&zero_size, Some(url), "fixture.jar").is_err());
    }

    #[test]
    fn install_hashes_real_temp_file_and_no_overwrite() {
        let fixture = Fixture::new("hash");
        let source = fixture.0.join("source.jar");
        let target = fixture.0.join("target.jar");
        let bytes = b"catalog-install-fixture";
        fs::write(&source, bytes).unwrap();
        let expected = BoundDownload {
            source: "modrinth", kind: "mod",
            url: "https://cdn.modrinth.com/data/fixture/versions/v1/source.jar".into(),
            filename: "source.jar".into(),
            size: bytes.len() as u64,
            sha1: Some(format!("{:x}", Sha1::digest(bytes))),
            sha512: Some(format!("{:x}", Sha512::digest(bytes))),
        };
        hash_matches(&source, &expected).unwrap();
        let mut wrong = expected.clone();
        wrong.size += 1;
        assert!(hash_matches(&source, &wrong).is_err());

        fs::write(&target, b"existing-winner").unwrap();
        assert!(move_new(&source, &target).is_err());
        assert_eq!(fs::read(&source).unwrap(), bytes);
        assert_eq!(fs::read(&target).unwrap(), b"existing-winner");
    }

    #[test]
    fn install_scope_uses_registered_canonical_root_and_shared_lock() {
        let fixture = Fixture::new("root");
        let root_text = fixture.0.to_str().unwrap();
        let settings = json!({"versionDirs":[{"id":"custom","path":root_text}]});
        let root = root_for(&settings, Path::new("relative-placeholder"), "custom").unwrap();
        assert_eq!(root, fixture.0);
        let guard = acquire_blocking(&root).unwrap();
        assert!(root.join(".hcmcl-install.lock").is_file());
        drop(guard);
        assert!(root_for(&settings, Path::new("relative-placeholder"), "missing").is_err());
    }

    fn export_fixture_bound(bytes: &[u8]) -> BoundDownload {
        BoundDownload {
            source: "modrinth", kind: "mod", url: "https://cdn.modrinth.com/data/fixture/versions/v1/official.jar".into(),
            filename: "official.jar".into(), size: bytes.len() as u64,
            sha1: Some(format!("{:x}", Sha1::digest(bytes))), sha512: Some(format!("{:x}", Sha512::digest(bytes))),
        }
    }
    fn export_fixture_file(path: &Path) -> File {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(path).unwrap()
    }

    #[test]
    fn export_binding_uses_official_class_original_name_and_exact_size() {
        let url = "https://edge.forgecdn.net/files/1234/567/official.zip";
        for (class, kind) in [(6, "mod"), (12, "resourcepack"), (6552, "shader"), (4471, "modpack")] {
            let project = json!({"id":12,"gameId":432,"classId":class,"allowModDistribution":true});
            let file = json!({"id":1234567,"modId":12,"fileName":"official.zip","downloadUrl":url,"fileLength":7,"hashes":[{"algo":1,"value":"a".repeat(40)}]});
            assert_eq!(curseforge_export_kind(&project).unwrap(), kind);
            let bound = bound_curseforge_export(&file, &project, url, "official.zip").unwrap();
            assert_eq!(bound.kind, kind);
            validate_export_bound(&bound, Some(7)).unwrap();
            assert!(validate_export_bound(&bound, Some(0)).is_err());
            assert!(validate_export_bound(&bound, Some(FILE_CAP + 1)).is_err());
            assert!(validate_export_bound(&bound, Some(8)).is_err());
            assert!(bound_curseforge_export(&file, &project, url, "user-renamed.zip").is_err());
            let mut denied = project.clone(); denied["allowModDistribution"] = json!(false);
            assert!(bound_curseforge_export(&file, &denied, url, "official.zip").is_err());
            let mut wrong = file.clone(); wrong["modId"] = json!(13);
            assert!(bound_curseforge_export(&wrong, &project, url, "official.zip").is_err());
        }
        assert!(curseforge_export_kind(&json!({"classId":999})).is_err());
        let mut bound = export_fixture_bound(b"valid");
        bound.url = "https://cdn.modrinth.com:8443/data/fixture/versions/v1/official.jar".into();
        assert!(validate_export_bound(&bound, None).is_err());
        bound.url = "https://arbitrary.invalid/official.jar".into();
        assert!(validate_export_bound(&bound, None).is_err());
    }

    fn pack_curseforge_fixture() -> (Value, Value) {
        let project = json!({"id":12,"gameId":432,"classId":6,"allowModDistribution":true});
        let file = json!({"id":1234567,"modId":12,"fileName":"official.jar","downloadUrl":"https://edge.forgecdn.net/files/1234/567/official.jar","fileLength":7,"isAvailable":true,"hashes":[{"algo":1,"value":"a".repeat(40)}]});
        (file, project)
    }

    #[test]
    fn pack_curseforge_binding_preserves_official_metadata_without_url() {
        for (class, expected_kind) in [(6, "mod"), (12, "resourcepack"), (6552, "shader")] {
            let (file, mut project) = pack_curseforge_fixture();
            project["classId"] = json!(class);
            let bound = bound_pack_curseforge(&file, &project, 12, 1_234_567).unwrap();
            let PackBoundMetadata { kind, filename, size, sha1, sha512 } = pack_bound_metadata(&bound);
            assert_eq!(kind, expected_kind);
            assert_eq!(bound.kind, expected_kind);
            assert_eq!(filename, "official.jar");
            assert_eq!(size, 7);
            assert_eq!(sha1.as_deref(), Some("a".repeat(40).as_str()));
            assert_eq!(sha512, None);
            assert_eq!(bound.url, file["downloadUrl"].as_str().unwrap());
            validate_export_bound(&bound, Some(7)).unwrap();
        }
        let (mut file, project) = pack_curseforge_fixture();
        file["classId"] = json!(6);
        file["hashes"] = json!([{"algo":1,"value":"A".repeat(40)},{"algo":1,"value":"a".repeat(40)}]);
        assert!(bound_pack_curseforge(&file, &project, 12, 1_234_567).is_ok());
        assert!(pack_curseforge_ids(i32::MAX as u64, i32::MAX as u64).is_ok());
    }

    #[test]
    fn pack_curseforge_binding_rejects_ids_games_and_member_classes() {
        let (file, project) = pack_curseforge_fixture();
        for (project_id, file_id) in [(0, 1_234_567), (12, 0), (i32::MAX as u64 + 1, 1_234_567), (12, i32::MAX as u64 + 1), (13, 1_234_567), (12, 1_234_568)] {
            assert!(bound_pack_curseforge(&file, &project, project_id, file_id).is_err());
        }
        for (field, value) in [("id", json!(13)), ("gameId", json!(1)), ("classId", json!(4471)), ("classId", json!(999)), ("classId", Value::Null)] {
            let mut wrong = project.clone(); wrong[field] = value;
            assert!(bound_pack_curseforge(&file, &wrong, 12, 1_234_567).is_err(), "{field}");
        }
        for (field, value) in [("id", json!(1_234_568)), ("modId", json!(13)), ("classId", json!(12)), ("classId", Value::Null)] {
            let mut wrong = file.clone(); wrong[field] = value;
            assert!(bound_pack_curseforge(&wrong, &project, 12, 1_234_567).is_err(), "{field}");
        }
        let mut no_game = project.clone(); no_game.as_object_mut().unwrap().remove("gameId");
        assert!(bound_pack_curseforge(&file, &no_game, 12, 1_234_567).is_err());
    }

    #[test]
    fn pack_curseforge_binding_requires_explicit_distribution_and_safe_official_file() {
        let (file, project) = pack_curseforge_fixture();
        for state in [Value::Null, json!("true")] {
            let mut unknown = project.clone(); unknown["allowModDistribution"] = state.clone();
            assert!(bound_pack_curseforge(&file, &unknown, 12, 1_234_567).unwrap_err().contains("未明确确认分发状态"));
            let mut unavailable = file.clone(); unavailable["isAvailable"] = state;
            assert!(bound_pack_curseforge(&unavailable, &project, 12, 1_234_567).unwrap_err().contains("未明确确认可用状态"));
        }
        let mut unknown = project.clone(); unknown.as_object_mut().unwrap().remove("allowModDistribution");
        assert!(bound_pack_curseforge(&file, &unknown, 12, 1_234_567).unwrap_err().contains("未明确确认分发状态"));
        let mut unavailable = file.clone(); unavailable.as_object_mut().unwrap().remove("isAvailable");
        assert!(bound_pack_curseforge(&unavailable, &project, 12, 1_234_567).unwrap_err().contains("未明确确认可用状态"));
        unknown["allowModDistribution"] = json!(false);
        assert!(bound_pack_curseforge(&file, &unknown, 12, 1_234_567).unwrap_err().contains("禁止分发"));
        unavailable["isAvailable"] = json!(false);
        assert!(bound_pack_curseforge(&unavailable, &project, 12, 1_234_567).unwrap_err().contains("不可下载"));
        for url in ["", "http://edge.forgecdn.net/files/1234/567/official.jar", "https://invalid.example/files/1234/567/official.jar", "https://edge.forgecdn.net/files/1234/568/official.jar", "https://edge.forgecdn.net:8443/files/1234/567/official.jar", "https://user@edge.forgecdn.net/files/1234/567/official.jar", "https://edge.forgecdn.net/files/1234/567/official.jar#fragment"] {
            let mut wrong = file.clone(); wrong["downloadUrl"] = json!(url);
            assert!(bound_pack_curseforge(&wrong, &project, 12, 1_234_567).is_err(), "{url}");
        }
        for name in ["", "../official.jar", "sub/official.jar"] {
            let mut wrong = file.clone(); wrong["fileName"] = json!(name);
            assert!(bound_pack_curseforge(&wrong, &project, 12, 1_234_567).is_err());
        }
        for size in [0, FILE_CAP + 1] {
            let mut wrong = file.clone(); wrong["fileLength"] = json!(size);
            assert!(bound_pack_curseforge(&wrong, &project, 12, 1_234_567).is_err());
        }
        for hashes in [json!([]), json!([{"algo":2,"value":"b".repeat(32)}]), json!([{"algo":1,"value":"a".repeat(39)}]), json!([{"algo":1,"value":"z".repeat(40)}]), json!([{"algo":1,"value":"a".repeat(40)},{"algo":1,"value":"b".repeat(40)}]), json!([{"algo":1,"value":"invalid"},{"algo":1,"value":"a".repeat(40)}])] {
            let mut wrong = file.clone(); wrong["hashes"] = hashes;
            assert!(bound_pack_curseforge(&wrong, &project, 12, 1_234_567).is_err());
        }
    }

    #[test]
    fn pack_modrinth_binding_checks_every_declared_hash() {
        let bound = export_fixture_bound(b"valid");
        let sha1 = bound.sha1.as_deref().unwrap();
        let sha512 = bound.sha512.as_deref().unwrap();
        validate_pack_modrinth_declared(&bound, 5, Some(sha1), Some(sha512)).unwrap();
        validate_pack_modrinth_declared(&bound, 5, Some(&sha1.to_ascii_uppercase()), None).unwrap();
        validate_pack_modrinth_declared(&bound, 5, None, Some(sha512)).unwrap();
        assert!(validate_pack_modrinth_declared(&bound, 5, Some(sha1), Some(&"0".repeat(128))).is_err());
        assert!(validate_pack_modrinth_declared(&bound, 5, Some(&"0".repeat(40)), Some(sha512)).is_err());
        let mut missing_sha1 = bound.clone(); missing_sha1.sha1 = None;
        assert!(validate_pack_modrinth_declared(&missing_sha1, 5, Some(sha1), Some(sha512)).is_err());
        let mut missing_sha512 = bound.clone(); missing_sha512.sha512 = None;
        assert!(validate_pack_modrinth_declared(&missing_sha512, 5, Some(sha1), Some(sha512)).is_err());
        let metadata = pack_bound_metadata(&bound);
        assert_eq!(metadata.kind, "mod");
        assert_eq!(metadata.filename, "official.jar");
        assert_eq!(metadata.sha1, bound.sha1);
        assert_eq!(metadata.sha512, bound.sha512);
    }

    #[test]
    fn pack_modrinth_binding_rejects_size_hash_format_and_nonofficial_source() {
        let bound = export_fixture_bound(b"valid");
        for size in [0, 4, 6, FILE_CAP + 1] {
            assert!(validate_pack_modrinth_declared(&bound, size, bound.sha1.as_deref(), bound.sha512.as_deref()).is_err());
        }
        assert!(validate_pack_modrinth_declared(&bound, 5, None, None).is_err());
        for sha1 in ["".to_owned(), "a".repeat(39), "z".repeat(40), format!(" {}", "a".repeat(40))] {
            assert!(validate_pack_modrinth_declared(&bound, 5, Some(&sha1), bound.sha512.as_deref()).is_err());
        }
        for sha512 in ["".to_owned(), "b".repeat(127), "z".repeat(128)] {
            assert!(validate_pack_modrinth_declared(&bound, 5, bound.sha1.as_deref(), Some(&sha512)).is_err());
        }
        let mut foreign = bound.clone(); foreign.source = "curseforge";
        assert!(validate_pack_modrinth_declared(&foreign, 5, bound.sha1.as_deref(), bound.sha512.as_deref()).is_err());
        let mut foreign = bound.clone(); foreign.url = "https://invalid.example/official.jar".into();
        assert!(validate_pack_modrinth_declared(&foreign, 5, bound.sha1.as_deref(), bound.sha512.as_deref()).is_err());
    }

    #[tokio::test]
    async fn pack_prepare_guards_and_untrusted_inputs_return_before_network() {
        for (settings, expected) in [(json!({"mode":"local","metadataOnlyMods":true}), "本地模式"), (json!({"metadataOnlyMods":true}), "仅元数据")] {
            assert!(prepare_pack_curseforge(0, 0, &settings).await.unwrap_err().contains(expected));
            assert!(prepare_pack_modrinth("invalid", "../invalid", 0, None, None, &settings).await.unwrap_err().contains(expected));
        }
        for (project_id, file_id) in [(0, 1), (1, 0), (i32::MAX as u64 + 1, 1), (1, i32::MAX as u64 + 1)] {
            assert!(prepare_pack_curseforge(project_id, file_id, &json!({})).await.is_err());
        }
        let url = "https://cdn.modrinth.com/data/fixture/versions/v1/official.jar";
        let sha1 = "a".repeat(40);
        for bad_url in ["invalid", "https://invalid.example/official.jar", "https://edge.forgecdn.net/files/1234/567/official.jar", "https://cdn.modrinth.com:8443/data/fixture/versions/v1/official.jar"] {
            assert!(prepare_pack_modrinth(bad_url, "official.jar", 7, Some(&sha1), None, &json!({})).await.is_err());
        }
        assert!(prepare_pack_modrinth(url, "official.jar", 0, Some(&sha1), None, &json!({})).await.is_err());
        assert!(prepare_pack_modrinth(url, "official.jar", 7, Some("invalid"), None, &json!({})).await.is_err());
        assert!(prepare_pack_modrinth(url, "official.jar", 7, Some(&sha1), Some("invalid"), &json!({})).await.is_err());
        assert!(prepare_pack_modrinth(url, "official.jar", 7, None, None, &json!({})).await.is_err());
        assert!(prepare_pack_modrinth(url, "../official.jar", 7, Some(&sha1), None, &json!({})).await.is_err());
    }

    #[test]
    fn export_writer_preserves_existing_inode_and_verifies_all_bytes() {
        let fixture = Fixture::new("export-writer");
        let path = fixture.0.join("user-selected-name.zip");
        let file = export_fixture_file(&path);
        let before = file.metadata().unwrap();
        let bytes = b"export-download-fixture";
        let bound = export_fixture_bound(bytes);
        let (sender, receiver) = tokio::sync::mpsc::channel(2);
        sender.try_send(ExportChunk::Data(bytes.to_vec())).unwrap();
        sender.try_send(ExportChunk::Finish).unwrap();
        drop(sender);
        assert_eq!(export_writer(file, bound, receiver, Arc::new(crate::downloads::Cancel::default()), Arc::new(|_, _| {})).unwrap(), bytes.len() as u64);
        assert_eq!(fs::read(&path).unwrap(), bytes);
        let after = fs::metadata(&path).unwrap();
        #[cfg(unix)] {
            use std::os::unix::fs::MetadataExt;
            assert_eq!((before.dev(), before.ino()), (after.dev(), after.ino()));
        }
        #[cfg(not(unix))] { let _ = (before, after); }

        for (label, size, hash) in [("size", bytes.len() as u64 + 1, None), ("hash", bytes.len() as u64, Some("0".repeat(40)))] {
            let mut bound = export_fixture_bound(bytes); bound.size = size;
            if let Some(hash) = hash { bound.sha1 = Some(hash); }
            let (sender, receiver) = tokio::sync::mpsc::channel(2);
            sender.try_send(ExportChunk::Data(bytes.to_vec())).unwrap();
            sender.try_send(ExportChunk::Finish).unwrap(); drop(sender);
            assert!(export_writer(export_fixture_file(&fixture.0.join(label)), bound, receiver, Arc::new(crate::downloads::Cancel::default()), Arc::new(|_, _| {})).is_err());
        }
    }

    #[tokio::test]
    async fn export_prepare_rejects_policy_hint_and_untrusted_inputs_without_network() {
        let url = "https://cdn.modrinth.com/data/fixture/versions/v1/official.jar";
        assert!(prepare_export_download(url, "official.jar", Some(0), &json!({})).await.is_err());
        assert!(prepare_export_download(url, "official.jar", Some(FILE_CAP + 1), &json!({})).await.is_err());
        assert!(prepare_export_download(url, "../renamed.jar", None, &json!({})).await.is_err());
        assert!(prepare_export_download(url, "official.jar", None, &json!({"mode":"local"})).await.is_err());
        assert!(prepare_export_download(url, "official.jar", None, &json!({"metadataOnlyMods":true})).await.is_err());
        assert!(prepare_export_download("https://arbitrary.invalid/file", "official.jar", None, &json!({})).await.is_err());
    }

    #[tokio::test]
    async fn export_writer_cancellation_waits_for_inflight_write_and_close() {
        use std::sync::{atomic::{AtomicBool, Ordering}, mpsc, Condvar, Mutex};
        struct SlowSink {
            entered: Option<mpsc::Sender<()>>, gate: Arc<(Mutex<bool>, Condvar)>, closed: Arc<AtomicBool>,
        }
        impl Write for SlowSink {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                if let Some(entered) = self.entered.take() { entered.send(()).unwrap(); }
                let (lock, ready) = &*self.gate;
                let mut released = lock.lock().unwrap();
                while !*released { released = ready.wait(released).unwrap(); }
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
        }
        impl ExportSink for SlowSink {
            fn prepare(&mut self) -> Result<()> { Ok(()) }
            fn sync_export(&mut self) -> Result<()> { Ok(()) }
        }
        impl Drop for SlowSink { fn drop(&mut self) { self.closed.store(true, Ordering::Release); } }
        let (entered, entered_rx) = mpsc::channel();
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let closed = Arc::new(AtomicBool::new(false));
        let sink = SlowSink { entered: Some(entered), gate: gate.clone(), closed: closed.clone() };
        let cancel = Arc::new(crate::downloads::Cancel::default());
        let writer_cancel = cancel.clone();
        let (sender, receiver) = tokio::sync::mpsc::channel(2);
        sender.try_send(ExportChunk::Data(b"write".to_vec())).unwrap();
        let worker = tokio::task::spawn_blocking(move || export_writer(sink, export_fixture_bound(b"write"), receiver, writer_cancel, Arc::new(|_, _| {})));
        let entered_result = tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(3))).await.unwrap();
        cancel.stop(); drop(sender);
        let waiting_for_write = !worker.is_finished();
        let still_open = !closed.load(Ordering::Acquire);
        // 即使断言条件不满足也先释放屏障，避免失败夹具遗留阻塞线程。
        { let (lock, ready) = &*gate; *lock.lock().unwrap() = true; ready.notify_all(); }
        let result = worker.await.unwrap();
        assert!(entered_result.is_ok());
        assert!(waiting_for_write && still_open);
        assert!(result.is_err());
        assert!(closed.load(Ordering::Acquire));
    }
}


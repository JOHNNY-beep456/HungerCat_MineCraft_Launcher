//! 桌面运行时：启动前通过后台认证刷新固定账号，逐次登记取消并复核派发快照。
//! Android 走另一条路径：JVM 在应用进程内创建，画面由 `GameHost` 的 Surface 承载，
//! 绝不在 Android spawn 桌面 Java。平台边界集中在 `native_game_supported` /
//! `launch_supported`，前端据此决定是否允许点击。桌面与移动端的共同部分
//! （认证、资源校验、参数拼装、取消与日志）在本模块内复用。
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha1::{Digest, Sha1};
use std::{collections::{BTreeMap, BTreeSet}, fs::{self, File, OpenOptions}, io::{Read, Write}, path::{Component, Path, PathBuf}, process::{Child, Command, Stdio}, sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, mpsc, Arc, Mutex, OnceLock}, thread, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use tauri::{Emitter, Manager};
use crate::{downloads, install_lock};
#[path = "game_window_size.rs"]
mod game_window_size;

type Result<T> = std::result::Result<T, String>;
const JSON_LIMIT: u64 = 32 * 1024 * 1024;

/// 是否由本进程按桌面方式拉起 Java 子进程。
///
/// 移动端无法使用桌面 JRE：Adoptium Temurin 是 glibc 二进制，而 Android 只有 bionic；
/// 且 targetSdk >= 29 的应用既不能 exec 也不能 dlopen 应用私有目录中的可执行文件。
/// 因此这条路径只在桌面成立，Android 改走 `start_in_process`。
pub(crate) fn native_game_supported() -> bool { !cfg!(any(target_os = "android", target_os = "ios")) }
/// 平台是否允许发起启动。Android 已有随包的 JVM 与图形层，iOS 没有。
pub(crate) fn launch_supported() -> bool { !cfg!(target_os = "ios") }
/// 移动端启动游戏的统一兜底说明；前端有对应本地化文案，这里只保证后端也不会静默失败。
pub(crate) const MOBILE_RUNTIME_BOUNDARY: &str = "当前平台无法使用桌面 Java 运行时（Temurin 依赖 glibc），请在桌面版启动游戏";
/// 移动端安装/检测桌面 JRE 的统一兜底说明。
pub(crate) const MOBILE_JAVA_BOUNDARY: &str = "移动端使用随安装包分发的内置 Java 运行时，不支持安装桌面 Java（Temurin 依赖 glibc，无法在 Android 上运行）";
fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
fn text<'a>(v: &'a Value, key: &str) -> &'a str { v.get(key).and_then(Value::as_str).unwrap_or("") }
fn bool_field(v: &Value, key: &str, default: bool) -> Result<bool> { match v.get(key) { None | Some(Value::Null) => Ok(default), Some(Value::Bool(b)) => Ok(*b), _ => Err(format!("{key} 必须是布尔值")) } }
fn integer(v: &Value, key: &str, default: u64, min: u64, max: u64) -> Result<u64> { let n = match v.get(key) { None | Some(Value::Null) => default, Some(n) => n.as_u64().ok_or_else(|| format!("{key} 必须是非负整数"))? }; if !(min..=max).contains(&n) { return Err(format!("{key} 超出合法范围")); } Ok(n) }
fn string_arg(args: &[Value], index: usize) -> Result<&str> { args.get(index).and_then(Value::as_str).filter(|s| !s.is_empty() && !s.contains('\0')).ok_or_else(|| "调用参数必须是非空字符串".into()) }
fn count(args: &[Value], n: usize) -> Result<()> { if args.len() == n { Ok(()) } else { Err("调用参数数量不符".into()) } }
fn identifier(s: &str) -> Result<&str> {
    if s.is_empty() || s.len() > 240 || s == "." || s == ".." || (s.ends_with('.') || s.ends_with(' ')) || s.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c)) { return Err("实例标识包含不安全字符".into()); }
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && matches!(stem.as_bytes()[3], b'1'..=b'9')) { return Err("实例标识是系统保留名称".into()); }
    Ok(s)
}
fn no_link(path: &Path) -> Result<()> { no_link_component(path, true) }
/// Android 的应用私有目录祖先是系统维护的别名（`/data/user/0` ↔ `/data/data`），
/// 只对末级严格拒绝链接；桌面平台仍逐级拒绝。见 `crate::path_alias`。
fn no_link_component(path: &Path, final_segment: bool) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) => {
            if m.file_type().is_symlink() && crate::path_alias::link_is_fatal(final_segment) { return Err("拒绝通过符号链接访问游戏文件".into()); }
            #[cfg(windows)] { use std::os::windows::fs::MetadataExt; if m.file_attributes() & 0x400 != 0 { return Err("拒绝通过重解析点访问游戏文件".into()); } }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("无法核验游戏文件路径".into()),
    }
}
fn absolute(path: &Path) -> Result<PathBuf> {
    walk_absolute(path).or_else(|error| match crate::path_alias::resolved_alias(path) {
        // 别名落在末级时，规范化一次再复核；仍然失败则保留原始错误。
        Some(canonical) => walk_absolute(&canonical).map_err(|_| error),
        None => Err(error),
    })
}
fn walk_absolute(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() || path.as_os_str().is_empty() { return Err("游戏目录必须是绝对路径".into()); }
    let mut current = PathBuf::new();
    let mut parts = path.components().peekable();
    while let Some(c) = parts.next() {
        let final_segment = parts.peek().is_none();
        match c {
            Component::Prefix(prefix)=>{current.push(prefix.as_os_str());continue;},
            Component::RootDir=>{current.push(c.as_os_str());no_link_component(&current, final_segment)?;continue;},
            Component::ParentDir | Component::CurDir => return Err("路径不能含相对跳转".into()),
            _ => current.push(c.as_os_str()),
        }
        no_link_component(&current, final_segment)?;
    }
    Ok(current)
}
fn inside(root: &Path, relative: impl AsRef<Path>) -> Result<PathBuf> {
    let mut result = absolute(root)?;
    let rel = relative.as_ref();
    if rel.as_os_str().is_empty() { return Err("相对文件路径为空".into()); }
    for c in rel.components() { if let Component::Normal(n) = c { let s = n.to_str().ok_or("路径不是 UTF-8")?; if identifier(s).is_err() { return Err("文件路径包含不安全字符".into()); } result.push(n); no_link(&result)?; } else { return Err("文件路径越界".into()); } }
    Ok(result)
}
fn make_dir(path: &Path) -> Result<()> { absolute(path)?; fs::create_dir_all(path).map_err(|_| "无法创建游戏目录")?; absolute(path)?; Ok(()) }
fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>> { no_link(path)?; let m = fs::metadata(path).map_err(|_| "缺少本地文件")?; if !m.is_file() || m.len() > limit { return Err("本地文件不是普通文件或超过大小上限".into()); } let mut b = Vec::new(); File::open(path).map_err(|_| "无法读取本地文件")?.take(limit + 1).read_to_end(&mut b).map_err(|_| "读取本地文件失败")?; if b.len() as u64 > limit { return Err("本地文件超过大小上限".into()); } Ok(b) }
fn read_json(path: &Path) -> Result<Value> { let v: Value = serde_json::from_slice(&read_bounded(path, JSON_LIMIT)?).map_err(|_| "本地 JSON 格式无效")?; if !v.is_object() { return Err("本地 JSON 必须是对象".into()); } Ok(v) }
fn roots(settings: &Value) -> Result<Vec<(String, PathBuf)>> {
    let default = text(settings, "gameDirAbs"); let default = if default.is_empty() { text(settings, "gameDir") } else { default };
    let mut result = vec![("default".into(), absolute(Path::new(default))?)];
    if let Some(dirs) = settings.get("versionDirs").and_then(Value::as_array) { if dirs.len() > 100 { return Err("版本目录数量超过上限".into()); } for d in dirs { let id = text(d, "id"); identifier(id)?; if id == "default" || result.iter().any(|(old, _)| old == id) { return Err("版本目录标识重复".into()); } result.push((id.into(), absolute(Path::new(text(d, "path")))?)); } }
    Ok(result)
}
fn active_root(settings: &Value) -> Result<PathBuf> { let dirs = roots(settings)?; Ok(dirs.iter().find(|(id, _)| id == text(settings, "selectedVersionDirId")).unwrap_or(&dirs[0]).1.clone()) }
fn run_dir(settings: &Value, root: &Path, id: &str) -> Result<PathBuf> { if crate::modpack::instance_isolated(root, id, settings)? { inside(root, Path::new("versions").join(identifier(id)?)) } else { absolute(root) } }
fn version_path(root: &Path, id: &str) -> Result<PathBuf> { inside(root, Path::new("versions").join(identifier(id)?).join(format!("{id}.json"))) }
fn merge(parent: &Value, child: &Value) -> Result<Value> {
    let mut out = parent.as_object().ok_or("父版本元数据无效")?.clone(); for (k, v) in child.as_object().ok_or("子版本元数据无效")? { out.insert(k.clone(), v.clone()); }
    for k in ["mainClass", "assetIndex", "assets", "javaVersion", "logging"] { if child.get(k).map_or(true, |v| v.is_null() || v.as_str() == Some("")) { if let Some(v) = parent.get(k) { out.insert(k.into(), v.clone()); } } }
    let mut downloads = parent["downloads"].as_object().cloned().unwrap_or_default(); if let Some(d) = child["downloads"].as_object() { downloads.extend(d.clone()); } out.insert("downloads".into(), Value::Object(downloads));
    let mut libs = parent["libraries"].as_array().cloned().unwrap_or_default(); libs.extend(child["libraries"].as_array().cloned().unwrap_or_default()); out.insert("libraries".into(), Value::Array(libs));
    if parent.get("arguments").is_some() || child.get("arguments").is_some() { let mut args = Map::new(); for k in ["jvm", "game"] { let mut a = parent["arguments"][k].as_array().cloned().unwrap_or_default(); if k == "game" && parent["arguments"].get("game").is_none() && !text(parent,"minecraftArguments").is_empty() { a = split_legacy(text(parent,"minecraftArguments"))?.into_iter().map(Value::String).collect(); } a.extend(child["arguments"][k].as_array().cloned().unwrap_or_default()); args.insert(k.into(), Value::Array(a)); } out.insert("arguments".into(), Value::Object(args)); }
    let base = if !text(parent, "clientVersion").is_empty() { text(parent, "clientVersion") } else { text(parent, "id") }; out.insert("clientVersion".into(), json!(base)); out.remove("inheritsFrom"); Ok(Value::Object(out))
}
async fn resolve(id: &str, root: &Path, settings: &Value) -> Result<Value> {
    let cancel = downloads::Cancel::default();
    downloads::resolve_runtime_version(id, root, settings, &cancel, merge).await
}

// 启动方已持有游戏目录锁；共用解析器只使用自己的元数据缓存门，不重取根锁。
async fn resolve_for_launch(id: &str, root: &Path, settings: &Value, ticket: &StartTicket) -> Result<Value> {
    let result = tokio::select! {
        biased;
        _ = ticket.cancel.cancelled() => return Err("游戏启动已取消".into()),
        result = downloads::resolve_runtime_version(id, root, settings, &ticket.cancel, merge) => result,
    };
    ticket.check()?;
    result
}
fn validate_sha1(s: &str) -> Result<()> { if s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()) { Ok(()) } else { Err("SHA-1 元数据格式无效".into()) } }
fn hex_sha1(b: &[u8]) -> String { format!("{:x}", Sha1::digest(b)) }
fn file_sha1(path: &Path) -> Result<String> { let mut f = File::open(path).map_err(|_| "无法打开待校验文件")?; let mut hash = Sha1::new(); let mut buf = [0u8; 65536]; loop { let n = f.read(&mut buf).map_err(|_| "读取待校验文件失败")?; if n == 0 { break; } hash.update(&buf[..n]); } Ok(format!("{:x}", hash.finalize())) }
fn verify_file(path: &Path, info: &Value, label: &str) -> Result<()> {
    no_link(path)?; let m = fs::metadata(path).map_err(|_| format!("缺少{label}，此阶段尚不自动下载安装依赖"))?; if !m.is_file() || m.len() == 0 { return Err(format!("{label}不是有效的普通文件")); }
    if let Some(size) = info.get("size") { let n = size.as_u64().ok_or("文件大小元数据无效")?; if m.len() != n { return Err(format!("{label}大小校验失败，请重新安装实例")); } }
    if let Some(sha) = info.get("sha1").and_then(Value::as_str) { validate_sha1(sha)?; if file_sha1(path)? != sha.to_ascii_lowercase() { return Err(format!("{label} SHA-1 校验失败，请重新安装实例")); } } Ok(())
}

fn os_name() -> &'static str { if cfg!(target_os = "windows") { "windows" } else if cfg!(target_os = "macos") { "osx" } else if cfg!(target_os = "android") { "android" } else { "linux" } }
fn native_arch() -> &'static str { if cfg!(target_arch = "aarch64") { "arm64" } else if cfg!(target_arch = "x86") { "32" } else { "64" } }
fn os_version() -> String {
    #[cfg(windows)] { #[repr(C)] struct Version { size: u32, major: u32, minor: u32, build: u32, platform: u32, name: [u16; 128] } #[link(name = "ntdll")] extern "system" { fn RtlGetVersion(v: *mut Version) -> i32; } let mut v = Version { size: std::mem::size_of::<Version>() as u32, major: 0, minor: 0, build: 0, platform: 0, name: [0; 128] }; if unsafe { RtlGetVersion(&mut v) } == 0 { return format!("{}.{}.{}", v.major, v.minor, v.build); } }
    #[cfg(not(windows))] { let mut cmd = if cfg!(target_os = "macos") { let mut c = Command::new("/usr/sbin/sysctl"); c.args(["-n", "kern.osproductversion"]); c } else { let mut c = Command::new("/usr/bin/uname"); c.arg("-r"); c }; if let Ok(o) = cmd.output() { if o.status.success() { return String::from_utf8_lossy(&o.stdout).trim().into(); } } }
    String::new()
}
fn rules_allow(rules: Option<&Value>, features: &BTreeMap<String, bool>) -> Result<bool> {
    let Some(rules) = rules else { return Ok(true) }; let rules = rules.as_array().ok_or("启动规则必须是数组")?; if rules.is_empty() { return Ok(true); } let mut allow = false;
    for rule in rules {
        if !rule.is_object() { return Err("启动规则格式无效".into()); }
        let os = &rule["os"]; if os.is_object() {
            let name = text(os, "name"); if !name.is_empty() && name != os_name() { continue; }
            let arch = text(os, "arch"); let actual = std::env::consts::ARCH; let matches_arch = arch == actual || (actual == "x86" && arch == "i386") || (actual == "aarch64" && arch == "arm64") || (actual == "x86_64" && matches!(arch, "amd64" | "x64")); if !arch.is_empty() && !matches_arch { continue; }
            let pattern = text(os, "version"); if !pattern.is_empty() { if pattern.len() > 1024 { return Err("系统版本规则过长".into()); } if !regex::Regex::new(pattern).map_err(|_| "系统版本规则正则无效")?.is_match(&os_version()) { continue; } }
        }
        if let Some(expected) = rule.get("features") { let expected = expected.as_object().ok_or("功能规则格式无效")?; let mut matched = true; for (name, v) in expected { let b = v.as_bool().ok_or("功能规则必须为布尔值")?; if features.get(name).copied().unwrap_or(false) != b { matched = false; } } if !matched { continue; } }
        allow = match text(rule, "action") { "allow" => true, "disallow" => false, _ => return Err("未知启动规则动作".into()) };
    }
    Ok(allow)
}
fn maven_path(coordinate: &str, classifier: Option<&str>) -> Result<PathBuf> {
    let (coordinate, ext) = coordinate.split_once('@').unwrap_or((coordinate, "jar")); let parts = coordinate.split(':').collect::<Vec<_>>(); if !(3..=4).contains(&parts.len()) { return Err("Maven 坐标格式无效".into()); }
    for s in &parts { identifier(s)?; } identifier(ext)?; let class = classifier.or(parts.get(3).copied()); if let Some(c) = class { identifier(c)?; }
    let group = parts[0].split('.').collect::<Vec<_>>(); if group.iter().any(|x| x.is_empty() || *x == "." || *x == "..") { return Err("Maven group 无效".into()); }
    let mut path = PathBuf::new(); for g in group { path.push(g); } path.push(parts[1]); path.push(parts[2]); path.push(format!("{}-{}{}.{}", parts[1], parts[2], class.map(|c| format!("-{c}")).unwrap_or_default(), ext)); Ok(path)
}
#[derive(Clone)] struct NativeArchive { path: PathBuf, excludes: Vec<String> }
struct Dependencies { classpath: Vec<PathBuf>, natives: Vec<NativeArchive>, client: PathBuf, asset_index: String }
fn dependencies(version: &Value, root: &Path, features: &BTreeMap<String, bool>) -> Result<Dependencies> {
    let mut selected = BTreeMap::<String, Value>::new(); let mut ordered = Vec::new();
    if let Some(libs) = version.get("libraries") { let libs = libs.as_array().ok_or("libraries 必须为数组")?; if libs.len() > 20_000 { return Err("依赖库数量超过上限".into()); }
        for lib in libs { if !rules_allow(lib.get("rules"), features)? { continue; } let name = text(lib, "name"); let bare = name.split('@').next().unwrap_or(name).split(':').collect::<Vec<_>>(); if !(3..=4).contains(&bare.len()) { return Err("依赖库坐标无效".into()); } let key = format!("{}:{}:{}", bare[0], bare[1], bare.get(3).unwrap_or(&"")); if !selected.contains_key(&key) { ordered.push(key.clone()); } selected.insert(key, lib.clone()); }
    }
    let mut cp = Vec::new(); let mut natives = Vec::new();
    for key in ordered { let lib = selected.get(&key).ok_or("依赖库选择异常")?; if !rules_allow(lib.get("rules"), features)? { continue; }
        let excludes = lib["extract"]["exclude"].as_array().map(|a| a.iter().map(|v| v.as_str().map(str::to_string).ok_or("原生排除项必须为字符串")).collect::<std::result::Result<Vec<_>, _>>()).transpose()?.unwrap_or_default();
        let artifact = lib["downloads"].get("artifact"); let classifier_only = lib["downloads"].get("classifiers").is_some() && artifact.is_none();
        if !classifier_only { let info = artifact.cloned().unwrap_or_else(|| json!({})); let rel = if !text(&info, "path").is_empty() { PathBuf::from(text(&info, "path")) } else { maven_path(text(lib, "name"), None)? }; let path = inside(root, Path::new("libraries").join(rel))?; verify_file(&path, &info, "依赖库")?; let is_native = text(lib, "name").split(':').nth(3).is_some_and(|c| c.starts_with("natives-")); if is_native { natives.push(NativeArchive { path: path.clone(), excludes: excludes.clone() }); } cp.push(path); }
        let class = text(&lib["natives"], os_name()).replace("${arch}", native_arch());
        if !class.is_empty() { let info = lib["downloads"]["classifiers"].get(&class).cloned().unwrap_or_else(|| json!({})); let rel = if !text(&info, "path").is_empty() { PathBuf::from(text(&info, "path")) } else { maven_path(text(lib, "name"), Some(&class))? }; let path = inside(root, Path::new("libraries").join(rel))?; verify_file(&path, &info, "平台原生依赖")?; natives.push(NativeArchive { path, excludes }); }
    }
    let client_id = if text(version, "jar").is_empty() { text(version, "id") } else { text(version, "jar") }; identifier(client_id)?;
    let primary = inside(root, Path::new("versions").join(client_id).join(format!("{client_id}.jar")))?; let base = text(version, "clientVersion");
    let client = if primary.is_file() { primary } else if !base.is_empty() { inside(root, Path::new("versions").join(identifier(base)?).join(format!("{base}.jar")))? } else { primary };
    verify_file(&client, &version["downloads"]["client"], "客户端 JAR")?; cp.push(client.clone()); let mut uniq = BTreeSet::new(); cp.retain(|p| uniq.insert(p.clone()));
    let index = if text(&version["assetIndex"], "id").is_empty() { text(version, "assets") } else { text(&version["assetIndex"], "id") }; if !index.is_empty() { identifier(index)?; }
    Ok(Dependencies { classpath: cp, natives, client, asset_index: index.into() })
}
fn native_outputs(target: &Path) -> Result<Vec<Value>> {
    let mut stack = vec![target.to_path_buf()]; let mut out = Vec::new(); let mut total = 0u64; let mut entries = 0usize;
    while let Some(dir) = stack.pop() { no_link(&dir)?; for e in fs::read_dir(&dir).map_err(|_| "无法枚举原生库输出")? { let p = e.map_err(|_| "无法读取原生库输出")?.path(); entries += 1; if entries > 30_000 { return Err("原生库输出条目超过上限".into()); } no_link(&p)?; let rel = p.strip_prefix(target).map_err(|_| "原生输出越界")?; let _ = inside(target, rel)?; let m = fs::symlink_metadata(&p).map_err(|_| "无法读取原生库输出属性")?; if m.is_dir() { stack.push(p); } else if m.is_file() { if rel == Path::new(".extract-stamp") { continue; } total = total.saturating_add(m.len()); if out.len() >= 30_000 || total > 1024 * 1024 * 1024 { return Err("原生库输出超过安全上限".into()); } out.push(json!({"path":rel.to_str().ok_or("原生输出路径不是 UTF-8")?.replace('\\',"/"),"size":m.len(),"sha1":file_sha1(&p)?})); } else { return Err("原生输出包含特殊文件".into()); } } }
    out.sort_by(|a, b| text(a, "path").cmp(text(b, "path"))); Ok(out)
}
fn extract_natives(root: &Path, id: &str, archives: &[NativeArchive]) -> Result<PathBuf> {
    let target = inside(root, Path::new("versions").join(identifier(id)?).join("natives"))?; let parent = target.parent().ok_or("原生目录无父目录")?; make_dir(parent)?;
    let source = archives.iter().map(|a| Ok(json!({"path":a.path.to_str().ok_or("原生归档路径不是 UTF-8")?,"sha1":file_sha1(&a.path)?,"exclude":a.excludes}))).collect::<Result<Vec<_>>>()?;
    let key = hex_sha1(&serde_json::to_vec(&source).map_err(|_| "原生指纹序列化失败")?);
    if target.is_dir() { if let Ok(stamp) = read_json(&inside(&target, ".extract-stamp")?) { if text(&stamp, "key") == key { if let Ok(outputs) = native_outputs(&target) { if stamp["outputs"] == json!(outputs) { return Ok(target); } } } } }
    let tag = uuid::Uuid::new_v4(); let staging = inside(parent, format!("natives.staging-{tag}"))?; let backup = inside(parent, format!("natives.backup-{tag}"))?; make_dir(&staging)?; let mut moved = false;
    let result = (|| -> Result<()> {
        let mut count = 0usize; let mut size = 0u64;
        for archive in archives { let f = File::open(&archive.path).map_err(|_| "无法读取原生归档")?; let mut zip = zip::ZipArchive::new(f).map_err(|_| "原生依赖不是有效 ZIP")?; if zip.len() > 30_000 { return Err("原生归档条目过多".into()); }
            for i in 0..zip.len() { let mut entry = zip.by_index(i).map_err(|_| "读取原生归档条目失败")?; count += 1; if count > 30_000 { return Err("原生归档条目总数超过上限".into()); } let name = entry.name().to_string(); if !name.trim_end_matches('/').is_empty() { let _ = inside(&staging, name.trim_end_matches('/'))?; } if name.is_empty() || name.starts_with("META-INF/") || archive.excludes.iter().any(|p| name.starts_with(p)) { continue; } if entry.unix_mode().is_some_and(|mode| !matches!(mode & 0o170000, 0 | 0o100000 | 0o040000)) { return Err("原生归档包含链接或特殊文件".into()); }
                let rel = name.trim_end_matches('/'); if rel.is_empty() { continue; } let p = inside(&staging, rel)?; if entry.is_dir() { make_dir(&p)?; continue; } size = size.saturating_add(entry.size()); if count > 30_000 || size > 1024 * 1024 * 1024 || entry.size() > 256 * 1024 * 1024 { return Err("原生解压超过安全上限".into()); } make_dir(p.parent().ok_or("原生条目无父路径")?)?; let mut output = OpenOptions::new().write(true).create(true).truncate(true).open(&p).map_err(|_| "无法写入原生条目")?; let written = std::io::copy(&mut (&mut entry).take(256 * 1024 * 1024 + 1), &mut output).map_err(|_| "原生条目解压或 CRC 校验失败")?; if written != entry.size() { return Err("原生条目大小不匹配".into()); } output.sync_all().map_err(|_| "无法提交原生条目")?;
            }
        }
        let stamp = json!({"schema":1,"key":key,"outputs":native_outputs(&staging)?}); let bytes = serde_json::to_vec(&stamp).map_err(|_| "原生指纹序列化失败")?; fs::write(inside(&staging, ".extract-stamp")?, bytes).map_err(|_| "无法写入原生指纹")?;
        no_link(&target)?; if target.exists() { fs::rename(&target, &backup).map_err(|_| "无法备份旧原生输出")?; moved = true; } if let Err(_) = fs::rename(&staging, &target) { if moved { let _ = fs::rename(&backup, &target); } return Err("无法原子提交原生输出，旧输出备份已尽量恢复".into()); } if moved { let _ = fs::remove_dir_all(&backup); } Ok(())
    })(); if result.is_err() { let _ = fs::remove_dir_all(&staging); if moved && !target.exists() { let _ = fs::rename(&backup, &target); } } result?; Ok(target)
}
fn validate_assets(version: &Value, root: &Path, run: &Path, index: &str) -> Result<()> {
    if index.is_empty() { return Ok(()); } let path = inside(root, Path::new("assets/indexes").join(format!("{index}.json")))?; verify_file(&path, &version["assetIndex"], "资源索引")?; let value = read_json(&path)?; let objects = value["objects"].as_object().ok_or("资源索引缺少 objects")?; if objects.len() > 500_000 { return Err("资源数量超过上限".into()); }
    for (name, info) in objects { let hash = text(info, "hash"); validate_sha1(hash)?; let p = inside(root, Path::new("assets/objects").join(&hash[..2]).join(hash))?; let check = json!({"sha1":hash,"size":info.get("size").and_then(Value::as_u64).ok_or("资源大小无效")?}); verify_file(&p, &check, "资源对象")?; if value["virtual"].as_bool().unwrap_or(false) { let virtual_path = inside(root, Path::new("assets/virtual").join(index).join(name))?; verify_file(&virtual_path, &check, "旧版映射资源")?; } if value["map_to_resources"].as_bool().unwrap_or(false) { verify_file(&inside(run, Path::new("resources").join(name))?, &check, "resources 映射资源")?; } }
    Ok(())
}

// 进程归属只在本模块内登记；停止不会接受外部任意 PID。
#[cfg(windows)] mod win_job {
    use std::{ffi::c_void, os::windows::io::AsRawHandle, process::Child};
    #[repr(C)] #[derive(Default)] struct Basic { per_process_time: i64, per_job_time: i64, flags: u32, minimum_working_set: usize, maximum_working_set: usize, active_process_limit: u32, affinity: usize, priority: u32, scheduling: u32 }
    #[repr(C)] #[derive(Default)] struct IoCounters { read_ops: u64, write_ops: u64, other_ops: u64, read_bytes: u64, write_bytes: u64, other_bytes: u64 }
    #[repr(C)] #[derive(Default)] struct Extended { basic: Basic, io: IoCounters, process_memory: usize, job_memory: usize, peak_process_memory: usize, peak_job_memory: usize }
    #[link(name = "kernel32")] extern "system" { fn CreateJobObjectW(attrs: *const c_void, name: *const u16) -> *mut c_void; fn SetInformationJobObject(job: *mut c_void, class: i32, info: *const c_void, size: u32) -> i32; fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32; fn TerminateJobObject(job: *mut c_void, code: u32) -> i32; fn CloseHandle(handle: *mut c_void) -> i32; }
    #[repr(C)] struct ThreadEntry { size: u32, usage: u32, id: u32, owner: u32, base_priority: i32, delta_priority: i32, flags: u32 }
    #[link(name = "kernel32")] extern "system" { fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut c_void; fn Thread32First(snapshot: *mut c_void, entry: *mut ThreadEntry) -> i32; fn Thread32Next(snapshot: *mut c_void, entry: *mut ThreadEntry) -> i32; fn OpenThread(access: u32, inherit: i32, id: u32) -> *mut c_void; fn ResumeThread(thread: *mut c_void) -> u32; }
    fn resume(child: &Child) -> bool { unsafe { let snapshot = CreateToolhelp32Snapshot(4, 0); if snapshot as isize == -1 { return false; } let mut entry = ThreadEntry { size: std::mem::size_of::<ThreadEntry>() as u32, usage: 0, id: 0, owner: 0, base_priority: 0, delta_priority: 0, flags: 0 }; let mut more = Thread32First(snapshot, &mut entry); let mut resumed = false; while more != 0 { if entry.owner == child.id() { let thread = OpenThread(2, 0, entry.id); if !thread.is_null() { resumed = ResumeThread(thread) != u32::MAX; CloseHandle(thread); if resumed { break; } } } more = Thread32Next(snapshot, &mut entry); } CloseHandle(snapshot); resumed } }
    pub fn attach(child: &Child) -> super::Result<isize> { unsafe { let job = CreateJobObjectW(std::ptr::null(), std::ptr::null()); if job.is_null() { return Err("无法创建游戏进程 Job".into()); } let mut limits = Extended::default(); limits.basic.flags = 0x2000; if SetInformationJobObject(job, 9, &limits as *const _ as *const c_void, std::mem::size_of::<Extended>() as u32) == 0 || AssignProcessToJobObject(job, child.as_raw_handle() as *mut c_void) == 0 { CloseHandle(job); return Err("无法隔离游戏进程树，已拒绝继续启动".into()); } if !resume(child) { CloseHandle(job); return Err("无法恢复隔离后的游戏进程".into()); } Ok(job as isize) } }
    pub fn kill(job: isize) { unsafe { TerminateJobObject(job as *mut c_void, 0); } }
    pub fn wait_empty(job: isize) -> super::Result<()> {
        #[repr(C)] #[derive(Default)] struct Accounting { user_time: i64, kernel_time: i64, period_user: i64, period_kernel: i64, page_faults: u32, total: u32, active: u32, terminated: u32 }
        #[link(name = "kernel32")] extern "system" { fn QueryInformationJobObject(job: *mut c_void, class: i32, info: *mut c_void, size: u32, returned: *mut u32) -> i32; }
        loop {
            let mut info = Accounting::default();
            if unsafe { QueryInformationJobObject(job as *mut c_void, 1, (&mut info as *mut Accounting).cast(), std::mem::size_of::<Accounting>() as u32, std::ptr::null_mut()) } == 0 { return Err("无法确认安装器 Job 进程树已完全退出".into()); }
            if info.active == 0 { return Ok(()); }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    pub fn close(job: isize) { unsafe { CloseHandle(job as *mut c_void); } }
}
struct ProcessGroup { pid: u32, terminated: AtomicBool, #[cfg(windows)] job: isize }
impl ProcessGroup {
    fn attach(child: &Child) -> Result<Self> { Ok(Self { pid: child.id(), terminated: AtomicBool::new(false), #[cfg(windows)] job: win_job::attach(child)? }) }
    fn kill(&self) { if self.terminated.swap(true, Ordering::AcqRel) { return; } #[cfg(windows)] win_job::kill(self.job); #[cfg(unix)] unsafe { extern "C" { fn kill(pid: i32, signal: i32) -> i32; } let _ = kill(-(self.pid as i32), 9); } }
}
impl Drop for ProcessGroup { fn drop(&mut self) { self.kill(); #[cfg(windows)] win_job::close(self.job); } }
struct OwnedChild { child: Child, group: ProcessGroup }
impl Drop for OwnedChild { fn drop(&mut self) { self.group.kill(); let _ = self.child.kill(); let _ = self.child.wait(); } }
fn spawn_process(program: &Path, args: &[String], cwd: Option<&Path>) -> Result<(Child, ProcessGroup)> {
    if !native_game_supported() { return Err(MOBILE_RUNTIME_BOUNDARY.into()); }
    if !program.is_absolute() || args.len() > 32_768 || args.iter().any(|a| a.contains('\0') || a.len() > 1024 * 1024) || args.iter().map(String::len).sum::<usize>() > 4 * 1024 * 1024 { return Err("Java 可执行路径或进程参数无效".into()); }
    let mut command = Command::new(program); command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()); if let Some(dir) = cwd { command.current_dir(dir); }
    #[cfg(unix)] { use std::os::unix::process::CommandExt; command.process_group(0); }
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000004); }
    let mut child = command.spawn().map_err(|_| "Java 进程创建失败，请核验可执行文件和权限")?;
    match ProcessGroup::attach(&child) { Ok(group) => Ok((child, group)), Err(e) => { let _ = child.kill(); let _ = child.wait(); Err(e) } }
}
fn collect_pipe<R: Read + Send + 'static>(mut pipe: R, tx: mpsc::Sender<Vec<u8>>, cap: usize) -> thread::JoinHandle<()> {
    thread::spawn(move || { let mut buf = [0u8; 8192]; let mut sent = 0usize; loop { match pipe.read(&mut buf) { Ok(0) | Err(_) => break, Ok(n) => { let count = n.min(cap.saturating_sub(sent)); if count != 0 && tx.send(buf[..count].to_vec()).is_err() { break; } sent += count; } } } })
}
/// 仅供可信宿主的本地文件选择器复用真实 Java 探测，不创建额外启动路径。
pub(crate) fn inspect_picked_java(path: &Path) -> Option<Value> { probe_java(path) }

fn probe_java(path: &Path) -> Option<Value> {
    if cfg!(target_os = "android") || cfg!(target_os = "ios") { return None; }
    if !path.is_absolute() { return None; } let path = fs::canonicalize(path).ok()?; if !path.is_file() { return None; }
    let (child, group) = spawn_process(&path, &["-version".into()], None).ok()?;
    let mut owned = OwnedChild { child, group };
    let (tx, rx) = mpsc::channel(); let stdout = owned.child.stdout.take()?; let stderr = owned.child.stderr.take()?; let a = collect_pipe(stdout, tx.clone(), 256 * 1024); let b = collect_pipe(stderr, tx.clone(), 256 * 1024); drop(tx);
    let start = Instant::now(); let success = loop { match owned.child.try_wait() { Ok(Some(status)) => break status.success(), Ok(None) if start.elapsed() < Duration::from_secs(8) => thread::sleep(Duration::from_millis(20)), _ => break false } };
    owned.group.kill(); if !success { let _ = owned.child.kill(); } let _ = owned.child.wait();
    let _ = a.join(); let _ = b.join(); if !success { return None; } let bytes = rx.try_iter().flatten().collect::<Vec<_>>(); let output = String::from_utf8_lossy(&bytes);
    let regex = regex::Regex::new(r#"(?:openjdk|java)\s+version\s+"([^"\r\n]+)""#).ok()?; let raw = regex.captures(&output)?.get(1)?.as_str(); let parts = raw.split('.').collect::<Vec<_>>(); let token = if parts.first() == Some(&"1") { *parts.get(1)? } else { *parts.first()? }; let digits = token.chars().take_while(char::is_ascii_digit).collect::<String>(); let major = digits.parse::<u32>().ok()?; if !(1..=99).contains(&major) { return None; }
    let lower = output.to_ascii_lowercase(); let vendor = if lower.contains("temurin") || lower.contains("adoptium") { Some("Eclipse Temurin") } else if lower.contains("zulu") { Some("Azul Zulu") } else if lower.contains("microsoft") { Some("Microsoft") } else if lower.contains("openjdk") { Some("OpenJDK") } else if lower.contains("java(tm)") { Some("Oracle") } else { None };
    let mut value = json!({"path":path.to_str()?,"version":raw,"major":major,"is64Bit":lower.contains("64-bit") || lower.contains("aarch64")}); if let Some(v) = vendor { value["vendor"] = json!(v); } Some(value)
}
fn java_executable(dir: &Path) -> PathBuf { dir.join("bin").join(if cfg!(windows) { "java.exe" } else { "java" }) }
fn scan_java(dir: &Path, depth: usize, budget: &mut usize, out: &mut BTreeSet<PathBuf>) {
    if *budget == 0 || depth > 5 || fs::symlink_metadata(dir).map(|m| m.file_type().is_symlink()).unwrap_or(true) { return; } *budget -= 1;
    for home in [dir.to_path_buf(), dir.join("Contents/Home")] { let p = java_executable(&home); if p.is_file() { if let Ok(p) = fs::canonicalize(p) { out.insert(p); } } }
    if let Ok(entries) = fs::read_dir(dir) { for entry in entries.take(512).flatten() { if entry.file_type().is_ok_and(|t| t.is_dir() && !t.is_symlink()) { scan_java(&entry.path(), depth + 1, budget, out); } } }
}
#[derive(Clone)] struct JavaCache { at: Instant, key: String, generation: usize, list: Vec<Value> }
static JAVA_CACHE: OnceLock<Mutex<Option<JavaCache>>> = OnceLock::new();
static JAVA_CACHE_GENERATION: AtomicUsize = AtomicUsize::new(0);
/// 安装完成后清除检测缓存；代际校验阻止先前仍在运行的扫描重新发布旧结果。
pub(crate) fn invalidate_java_cache_for_backend() {
    JAVA_CACHE_GENERATION.fetch_add(1, Ordering::AcqRel);
    if let Ok(mut cache) = JAVA_CACHE.get_or_init(|| Mutex::new(None)).lock() { *cache = None; }
}
fn detect_java(settings: &Value) -> Result<Vec<Value>> {
    if !native_game_supported() { return Err(MOBILE_JAVA_BOUNDARY.into()); }
    let generation = JAVA_CACHE_GENERATION.load(Ordering::Acquire);
    let dirs = roots(settings)?; let key = format!("{:?}|{:?}|{:?}", dirs, std::env::var_os("JAVA_HOME"), std::env::var_os("PATH"));
    { let guard = JAVA_CACHE.get_or_init(|| Mutex::new(None)).lock().map_err(|_| "Java 缓存不可用")?; if let Some(c) = &*guard { if c.key == key && c.generation == generation && JAVA_CACHE_GENERATION.load(Ordering::Acquire) == generation && c.at.elapsed() < Duration::from_secs(30) { return Ok(c.list.clone()); } } }
    let mut candidates = BTreeSet::new(); if let Some(home) = std::env::var_os("JAVA_HOME") { candidates.insert(java_executable(Path::new(&home))); } if let Some(paths) = std::env::var_os("PATH") { for p in std::env::split_paths(&paths) { let java = p.join(if cfg!(windows) { "java.exe" } else { "java" }); if java.is_file() { candidates.insert(java); } } }
    let mut scans = dirs.iter().map(|(_, p)| p.join("java")).collect::<Vec<_>>();
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) { scans.push(PathBuf::from(home).join(".jdks")); }
    #[cfg(windows)] for var in ["ProgramFiles", "ProgramFiles(x86)"] { if let Some(base) = std::env::var_os(var) { for vendor in ["Java", "Eclipse Adoptium", "Microsoft", "Zulu", "BellSoft", "Amazon Corretto"] { scans.push(PathBuf::from(&base).join(vendor)); } } }
    #[cfg(target_os = "linux")] { scans.push(PathBuf::from("/usr/lib/jvm")); scans.push(PathBuf::from("/opt/java")); }
    #[cfg(target_os = "macos")] scans.push(PathBuf::from("/Library/Java/JavaVirtualMachines"));
    let mut budget = 3000; for dir in scans { scan_java(&dir, 0, &mut budget, &mut candidates); } if candidates.len() > 128 { return Err("Java 候选路径过多，请清理无效运行时目录".into()); }
    let candidates = candidates.into_iter().collect::<Vec<_>>(); let cursor = AtomicUsize::new(0); let found = Mutex::new(Vec::new());
    thread::scope(|scope| { for _ in 0..4 { let candidates = &candidates; let cursor = &cursor; let found = &found; scope.spawn(move || loop { let i = cursor.fetch_add(1, Ordering::Relaxed); let Some(p) = candidates.get(i) else { break }; if let Some(v) = probe_java(p) { if let Ok(mut values) = found.lock() { values.push(v); } } }); } });
    let mut list = found.into_inner().map_err(|_| "Java 检测状态异常")?; list.sort_by(|a, b| b["major"].as_u64().cmp(&a["major"].as_u64()).then_with(|| b["is64Bit"].as_bool().cmp(&a["is64Bit"].as_bool())).then_with(|| text(a, "path").cmp(text(b, "path")))); let mut seen = BTreeSet::new(); list.retain(|v| seen.insert(text(v, "path").to_string()));
    publish_java_cache(JAVA_CACHE.get_or_init(|| Mutex::new(None)), &JAVA_CACHE_GENERATION, generation, key, &list)?;
    Ok(list)
}
fn publish_java_cache(cache: &Mutex<Option<JavaCache>>, current: &AtomicUsize, generation: usize, key: String, list: &[Value]) -> Result<()> {
    let mut cache = cache.lock().map_err(|_| "Java 缓存不可用")?;
    if current.load(Ordering::Acquire) == generation {
        *cache = Some(JavaCache { at: Instant::now(), key, generation, list: list.to_vec() });
    }
    Ok(())
}
/// 版本清单声明需要哪个 Java 主版本；Android 用它在启动前选定运行时。
pub(crate) fn required_java(version: &Value) -> Result<u64> { if let Some(v) = version.get("javaVersion") { return integer(v, "majorVersion", 8, 8, 99); } Ok(8) }fn suitable(java: &Value, required: u64) -> bool { java["major"].as_u64().is_some_and(|major| major == required || (required >= 16 && major > required)) }
fn choose_java(settings: &Value, id: &str, options: &Value, required: u64) -> Result<Value> {
    if let Some(value) = options.get("javaPath") { let path = value.as_str().ok_or("javaPath 必须是字符串")?; if !path.trim().is_empty() { let java = probe_java(Path::new(path)).ok_or("指定的 Java 无法读取版本，请重新选择")?; if !suitable(&java, required) { return Err(format!("指定的 Java 不兼容，需要 Java {required}")); } return Ok(java); } }
    if let Some(pin) = settings["versionJava"].get(id).and_then(Value::as_str).filter(|s| !s.trim().is_empty()) { if let Some(java) = probe_java(Path::new(pin)) { if !suitable(&java, required) { return Err(format!("实例指定的 Java 不兼容，需要 Java {required}")); } return Ok(java); } }
    if !bool_field(settings, "javaAutoDetect", true)? && !text(settings, "javaPath").trim().is_empty() { let java = probe_java(Path::new(text(settings, "javaPath"))).ok_or("全局指定的 Java 无法读取版本")?; if !suitable(&java, required) { return Err(format!("全局指定的 Java 不兼容，需要 Java {required}")); } return Ok(java); }
    let all = detect_java(settings)?; let eligible = all.iter().filter(|v| suitable(v, required)); eligible.clone().find(|v| v["major"].as_u64() == Some(required) && v["is64Bit"].as_bool() == Some(true)).or_else(|| eligible.clone().find(|v| v["major"].as_u64() == Some(required))).or_else(|| eligible.clone().find(|v| v["is64Bit"].as_bool() == Some(true))).or_else(|| eligible.into_iter().next()).cloned().ok_or_else(|| format!("未找到合适的 Java {required}；此阶段不会下载或运行未经验证的 Java"))
}

/// 可信 Forge 编排专用：不接受 IPC 命令，不重新获取安装根锁，调用方在阻塞 worker 中使用。
pub(crate) fn pick_installer_java(settings: &Value, version_id: &str, required_major: u64) -> Result<PathBuf> {
    installer_desktop()?; identifier(version_id)?;
    if !(8..=99).contains(&required_major) { return Err("安装器所需 Java 主版本无效".into()); }
    let selected = choose_java(settings, version_id, &json!({}), required_major)?;
    // 检测缓存只用于候选排序；选中的程序必须再次实际执行 -version，失败不伪兼容。
    let measured = probe_java(Path::new(text(&selected, "path"))).ok_or("安装器 Java 版本复核失败")?;
    if !suitable(&measured, required_major) { return Err(format!("安装器 Java 不兼容，需要 Java {required_major}")); }
    Ok(PathBuf::from(text(&measured, "path")))
}
fn installer_desktop() -> Result<()> {
    if !native_game_supported() { return Err(MOBILE_JAVA_BOUNDARY.into()); }
    Ok(())
}
fn installer_paths(java: &Path, jar: &Path, staging: &Path) -> Result<(PathBuf, Vec<String>, PathBuf)> {
    installer_desktop()?;
    if !java.is_absolute() { return Err("安装器 Java 必须使用已探测的绝对路径".into()); }
    let java = fs::canonicalize(java).map_err(|_| "安装器 Java 不存在")?;
    if !java.is_file() { return Err("安装器 Java 不是普通文件".into()); }
    let staging = absolute(staging)?;
    if !staging.is_dir() { return Err("安装器 staging 目录不存在".into()); }
    let jar = absolute(jar)?;
    if jar.parent() != Some(staging.as_path()) || jar.file_name().and_then(|v| v.to_str()) != Some("installer.jar") { return Err("安装器 JAR 必须是本任务 staging 中的 installer.jar".into()); }
    let metadata = fs::symlink_metadata(&jar).map_err(|_| "安装器 JAR 不存在")?;
    if !metadata.is_file() || !(4..=512 * 1024 * 1024).contains(&metadata.len()) { return Err("安装器 JAR 不是有效大小的普通文件".into()); }
    let mut magic = [0u8; 4]; File::open(&jar).and_then(|mut f| f.read_exact(&mut magic)).map_err(|_| "无法读取安装器 JAR")?;
    if magic != [b'P', b'K', 3, 4] { return Err("安装器 JAR 不是 ZIP/JAR 文件".into()); }
    let args = vec!["-jar".into(), jar.to_str().ok_or("安装器路径不是 UTF-8")?.into(), "--installClient".into(), staging.to_str().ok_or("安装器 staging 路径不是 UTF-8")?.into()];
    Ok((java, args, staging))
}
/// 调用方先验证官方摘要并拥有 staging；仅固定 -jar / --installClient，不接收任意 argv。
/// cancel 只发信号，返回前杀归属进程树、wait 并 join 两条输出管道，之后才可清理 staging。
/// log 必须是快速、非阻塞的宿主回调；它只收到有界脱敏正文，不允许回调内等待此 runner。
/// Unix 进程组不是安全沙箱，不能约束恶意安装器主动 setsid/脱组；这里只运行宿主已校验的官方 JAR。
pub(crate) fn run_installer(java: &Path, installer_jar: &Path, staging: &Path, cancel: Arc<crate::downloads::Cancel>, log: Arc<dyn Fn(String) + Send + Sync>) -> Result<()> {
    installer_desktop()?; cancel.check()?;
    let (java, args, staging) = installer_paths(java, installer_jar, staging)?;
    run_installer_process(&java, &args, &staging, cancel, log, InstallerLimits { quiet: Duration::from_secs(120), total: Duration::from_secs(600) })
}
#[derive(Clone, Copy)] struct InstallerLimits { quiet: Duration, total: Duration }
const INSTALLER_LINE: usize = 16 * 1024;
const INSTALLER_TAIL: usize = 16 * 1024;
const INSTALLER_LOG_LIMIT: usize = 2 * 1024 * 1024;
struct InstallerOutput {
    activity: Instant, tail: std::collections::VecDeque<String>, tail_bytes: usize,
    pending: std::collections::VecDeque<String>, pending_bytes: usize, skipped: bool, read_failed: bool,
}
impl InstallerOutput {
    fn new() -> Self { Self { activity: Instant::now(), tail: Default::default(), tail_bytes: 0, pending: Default::default(), pending_bytes: 0, skipped: false, read_failed: false } }
    fn line(&mut self, raw: &[u8], oversized: bool) {
        let line = if oversized { "[安装器过长日志行已省略]".into() } else { installer_redact(&String::from_utf8_lossy(raw)) };
        if line.is_empty() { return; }
        self.tail_bytes += line.len(); self.tail.push_back(line.clone());
        while self.tail.len() > 64 || self.tail_bytes > INSTALLER_TAIL { if let Some(old) = self.tail.pop_front() { self.tail_bytes -= old.len(); } }
        if self.pending.len() < 32 && self.pending_bytes + line.len() <= 16 * 1024 { self.pending_bytes += line.len(); self.pending.push_back(line); } else { self.skipped = true; }
    }
    fn take_log(&mut self) -> String {
        let mut batch = String::new();
        while self.pending.front().is_some_and(|line| batch.len() + line.len() + 1 <= 8192) { let line = self.pending.pop_front().unwrap(); self.pending_bytes -= line.len(); batch.push_str(&line); batch.push('\n'); }
        if self.skipped { batch.push_str("[安装器日志过密，部分正文未推送]\n"); self.skipped = false; }
        batch
    }
    fn tail(&self) -> String { self.tail.iter().cloned().collect::<Vec<_>>().join("\n") }
}
fn installer_redact(raw: &str) -> String {
    // 先整行抑制敏感字段，再去掉 URL/长凭据与终端控制字符；原文从不进入 tail 或事件队列。
    static SENSITIVE: OnceLock<regex::Regex> = OnceLock::new();
    static URLS: OnceLock<regex::Regex> = OnceLock::new();
    static LONG_VALUE: OnceLock<regex::Regex> = OnceLock::new();
    let sensitive = SENSITIVE.get_or_init(|| regex::Regex::new(r"(?i)(?:token|password|passwd|authorization|cookie|credential|client[_-]?secret|api[_-]?key|bearer\s|basic\s)").expect("常量正则"));
    if raw.contains('\u{1b}') { return "[安装器终端控制日志已省略]".into(); }
    let urls = URLS.get_or_init(|| regex::Regex::new(r#"(?i)https?://[^\s<>"']+"#).expect("常量正则"));
    let long_value = LONG_VALUE.get_or_init(|| regex::Regex::new(r"[A-Za-z0-9_+/=.-]{40,}").expect("常量正则"));
    let filtered = raw.chars().filter(|c| !c.is_control() || *c == '\t').collect::<String>();
    if sensitive.is_match(&filtered) { return "[安装器敏感日志已省略]".into(); }
    let clean = urls.replace_all(&filtered, "[网络地址已省略]"); let clean = long_value.replace_all(&clean, "[长标识已省略]");
    let mut out = String::new(); for character in clean.trim().chars() { if out.len() + character.len_utf8() > 4000 { out.push_str("[后文已省略]"); break; } out.push(character); } out
}
fn installer_pipe<R: Read + Send + 'static>(mut pipe: R, output: Arc<Mutex<InstallerOutput>>) -> std::io::Result<thread::JoinHandle<()>> {
    thread::Builder::new().name("hcmcl-installer-output".into()).spawn(move || {
        let mut buffer = [0u8; 4096]; let mut line = Vec::new(); let mut oversized = false;
        loop {
            let size = match pipe.read(&mut buffer) { Ok(0) => break, Ok(n) => n, Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue, Err(_) => { output.lock().unwrap_or_else(|e| e.into_inner()).read_failed = true; break; } };
            // 每次 read 都更新，包括无换行、超长行、正文达到留存上限之后的字节。
            output.lock().unwrap_or_else(|e| e.into_inner()).activity = Instant::now();
            for byte in &buffer[..size] {
                if *byte == b'\n' || *byte == b'\r' {
                    if !line.is_empty() || oversized { output.lock().unwrap_or_else(|e| e.into_inner()).line(&line, oversized); }
                    line.clear(); oversized = false;
                } else if !oversized { if line.len() < INSTALLER_LINE { line.push(*byte); } else { line.clear(); oversized = true; } }
            }
        }
        if !line.is_empty() || oversized { output.lock().unwrap_or_else(|e| e.into_inner()).line(&line, oversized); }
    })
}
fn installer_emit(output: &Arc<Mutex<InstallerOutput>>, log: &Arc<dyn Fn(String) + Send + Sync>, sent: &mut usize, last: &mut Instant) -> Result<()> {
    if last.elapsed() < Duration::from_millis(100) { return Ok(()); }
    let batch = output.lock().unwrap_or_else(|e| e.into_inner()).take_log();
    if batch.is_empty() || *sent >= INSTALLER_LOG_LIMIT { return Ok(()); }
    *last = Instant::now();
    let batch = if sent.saturating_add(batch.len()) > INSTALLER_LOG_LIMIT { "[安装器本次日志已达到 2 MiB 留存上限，后续正文不再推送]\n".into() } else { batch };
    *sent = sent.saturating_add(batch.len());
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| log(batch))).map_err(|_| "安装器日志接收器异常，已停止安装器".into())
}
fn run_installer_process(program: &Path, args: &[String], cwd: &Path, cancel: Arc<crate::downloads::Cancel>, log: Arc<dyn Fn(String) + Send + Sync>, limits: InstallerLimits) -> Result<()> {
    installer_desktop()?; cancel.check()?;
    let (child, group) = spawn_process(program, args, Some(cwd))?; let mut owned = OwnedChild { child, group };
    let output = Arc::new(Mutex::new(InstallerOutput::new()));
    let mut readers = Vec::new(); let mut failure = None;
    match owned.child.stdout.take() { Some(pipe) => match installer_pipe(pipe, output.clone()) { Ok(reader) => readers.push(reader), Err(_) => failure = Some("无法创建安装器输出读取线程".to_string()) }, None => failure = Some("无法捕获安装器标准输出".into()) }
    match owned.child.stderr.take() { Some(pipe) => match installer_pipe(pipe, output.clone()) { Ok(reader) => readers.push(reader), Err(_) => failure = Some("无法创建安装器错误读取线程".to_string()) }, None => failure = Some("无法捕获安装器错误输出".into()) }
    let start = Instant::now(); let mut sent = 0usize; let mut last_log = Instant::now() - Duration::from_millis(100); let mut terminal = None;
    while failure.is_none() {
        if cancel.check().is_err() { failure = Some("安装器已取消".into()); break; }
        if start.elapsed() >= limits.total { failure = Some("安装器达到总执行时限，已终止进程树".into()); break; }
        let (activity, read_failed) = { let state = output.lock().unwrap_or_else(|e| e.into_inner()); (state.activity, state.read_failed) };
        if read_failed { failure = Some("安装器输出管道读取失败，已终止进程树".into()); break; }
        if activity.elapsed() >= limits.quiet { failure = Some("安装器长时间未产生任何输出字节，已终止进程树".into()); break; }
        if let Err(error) = installer_emit(&output, &log, &mut sent, &mut last_log) { failure = Some(error); break; }
        match owned.child.try_wait() { Ok(Some(status)) => { terminal = Some(status); break; }, Ok(None) => {}, Err(_) => { failure = Some("无法读取安装器退出状态".into()); break; } }
        thread::sleep(Duration::from_millis(20));
    }
    // 即使父进程成功退出，也先清掉仍占有管道的归属子进程。绝不超时 detach 读取线程。
    owned.group.kill(); if terminal.is_none() { let _ = owned.child.kill(); }
    match owned.child.wait() { Ok(status) => { if terminal.is_none() { terminal = Some(status); } }, Err(_) => { failure.get_or_insert_with(|| "安装器进程回收失败".into()); } }
    #[cfg(windows)] if let Err(error) = win_job::wait_empty(owned.group.job) { failure.get_or_insert(error); }
    for reader in readers { if reader.join().is_err() { failure.get_or_insert_with(|| "安装器输出读取线程异常".into()); } }
    if output.lock().unwrap_or_else(|e| e.into_inner()).read_failed { failure.get_or_insert_with(|| "安装器输出管道读取失败".into()); }
    if failure.is_none() {
        // 收尾最多清空 16 KiB 待推送队列，仍保持每 100ms 一批；不会让短命进程的最后输出丢失。
        for _ in 0..4 {
            if output.lock().unwrap_or_else(|e| e.into_inner()).pending.is_empty() { break; }
            if let Some(delay) = Duration::from_millis(100).checked_sub(last_log.elapsed()) { thread::sleep(delay); }
            if let Err(error) = installer_emit(&output, &log, &mut sent, &mut last_log) { failure = Some(error); break; }
        }
    }
    if cancel.check().is_err() { failure.get_or_insert_with(|| "安装器已取消".into()); }
    if failure.is_none() && !terminal.is_some_and(|status| status.success()) { failure = Some(format!("安装器退出码为 {}", terminal.and_then(|status| status.code()).map(|code| code.to_string()).unwrap_or_else(|| "未知（可能被信号终止）".into()))); }
    if let Some(error) = failure { let tail = output.lock().unwrap_or_else(|e| e.into_inner()).tail(); return Err(if tail.is_empty() { error } else { format!("{error}\n最近安装器输出（已脱敏）：\n{tail}") }); }
    Ok(())
}

fn server_list(path: &Path) -> Vec<Value> {
    use crate::instance_servers::{decode_server_list, RAW_CAP};
    read_bounded(path, RAW_CAP as u64)
        .and_then(|raw| decode_server_list(&raw))
        .unwrap_or_default()
}
/// 编译一次、终身复用的常量正则：实例列表等热路径不得每次调用重新编译。
fn static_regex(pattern: &'static str) -> &'static regex::Regex {
    static CACHE: OnceLock<Mutex<BTreeMap<&'static str, &'static regex::Regex>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(BTreeMap::new()));
    let mut cache = cache.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(hit) = cache.get(pattern) { return hit; }
    let leaked: &'static str = Box::leak(pattern.to_owned().into_boxed_str());
    let compiled: &'static regex::Regex = Box::leak(Box::new(regex::Regex::new(leaked).expect("常量正则")));
    cache.insert(leaked, compiled);
    compiled
}

fn version_type(id: &str) -> &'static str {
    let lower = id.trim().to_ascii_lowercase(); let fools = ["2.0", "15w14a", "1.rv-pre1", "3d shareware v1.34", "20w14infinite", "22w13oneblockatatime", "23w13a_or_b", "24w14potato", "25w14craftmine"];
    if fools.contains(&lower.as_str()) { return "aprilfools"; }
    if static_regex(r"^\d{2}w\d{2}[a-z]$").is_match(&lower) || static_regex(r"^\d+\.\d+-snapshot-\d+$").is_match(&lower) { return "snapshot"; }
    if static_regex(r"^\d{2}w\d{2}[a-z]?.+$").is_match(&lower) { return "aprilfools"; } "release"
}
fn local_meta(version: &Value, id: &str) -> (String, Option<&'static str>) {
    let libs = version["libraries"].as_array().cloned().unwrap_or_default(); let names = libs.iter().map(|v| text(v,"name")).collect::<Vec<_>>(); let all = names.join(" ").to_ascii_lowercase(); let main = text(version,"mainClass").to_ascii_lowercase(); let lower = id.to_ascii_lowercase();
    let loader = if all.contains("net.neoforged") { Some("neoforge") } else if all.contains("net.minecraftforge") { Some("forge") } else if all.contains("net.fabricmc") { Some("fabric") } else if all.contains("org.quiltmc") { Some("quilt") } else if main.contains("fabricmc") || lower.contains("fabric") { Some("fabric") } else if main.contains("quiltmc") || lower.contains("quilt") { Some("quilt") } else if lower.contains("neoforge") { Some("neoforge") } else if main.contains("minecraftforge") || main.contains("modlauncher") || main.contains("launchwrapper") || lower.contains("forge") { Some("forge") } else { None };
    let derived = static_regex(r"(?i)^(?:net\.fabricmc:(?:intermediary|hashed)|org\.quiltmc:hashed):([0-9][0-9a-z.+-]*)$"); let forge = static_regex(r"^net\.(?:minecraftforge:(?:forge|fmlloader)|neoforged:neoforge):([0-9]+\.[0-9]+(?:\.[0-9]+)?)-");
    for name in names { if let Some(c) = derived.captures(name).or_else(|| forge.captures(name)) { return (c[1].to_string(), loader); } }
    for key in ["inheritsFrom", "clientVersion"] { if !text(version,key).is_empty() { return (text(version,key).into(),loader); } }
    let source = if text(version,"id").is_empty() { id } else { text(version,"id") }; let strip = static_regex(r"(?i)^(\d+\.\d+(?:\.\d+)?)[-_](?:forge|fabric|quilt|neoforge|optifine)"); (strip.captures(source).map(|c| c[1].to_string()).unwrap_or_else(|| source.into()), loader)
}
fn installed(settings: &Value, all: bool) -> Result<Value> {
    let dirs = if all { roots(settings)? } else { vec![(String::new(), active_root(settings)?)] }; let mut result = Vec::new();
    for (dir_id, root) in dirs { let versions = inside(&root,"versions")?; if !versions.exists() { continue; } let mut entries = fs::read_dir(&versions).map_err(|_| "无法读取版本目录")?.take(20_001).collect::<std::result::Result<Vec<_>,_>>().map_err(|_| "读取版本目录失败")?; if entries.len()>20_000 { return Err("版本目录条目过多".into()); } entries.sort_by_key(|e| e.file_name());
        // 各实例的读取（版本 JSON、存档目录、servers.dat NBT）互不依赖；并行计算后按
        // 原目录顺序回填，避免实例数多时串行累积几百到上千毫秒（真实测量 70 实例约 1.8s）。
        let rows = std::thread::scope(|scope| {
            let settings_ref = settings; let root_ref = &root; let dir_id_ref = &dir_id;
            let mut handles = Vec::with_capacity(entries.len());
            for entry in &entries {
                handles.push(scope.spawn(move || -> Result<Option<Value>> {
                    if !entry.file_type().map_err(|_| "无法核验版本目录")?.is_dir() { return Ok(None); }
                    let name=entry.file_name(); let Some(id)=name.to_str() else { return Ok(None) }; if identifier(id).is_err() { return Ok(None); }
                    let path=version_path(root_ref,id)?; if !path.is_file() { return Ok(None); }
                    let meta=read_json(&path).unwrap_or_else(|_|json!({})); let(mc,loader)=local_meta(&meta,id);
                    let run=run_dir(settings_ref,root_ref,id)?; let saves=inside(&run,"saves")?; let mut worlds=Vec::new();
                    if saves.exists() { for e in fs::read_dir(&saves).map_err(|_| "无法读取存档目录")?.take(20_000).flatten() { if e.file_type().is_ok_and(|t|t.is_dir()) { let n=e.file_name(); if let Some(n)=n.to_str() { if identifier(n).is_ok() && inside(&saves,Path::new(n).join("level.dat"))?.is_file() { worlds.push(n.to_string()); } } } } } worlds.sort();
                    let mut row=json!({"id":id,"mcVersion":mc,"loader":loader,"versionType":version_type(&mc),"worlds":worlds,"servers":server_list(&inside(&run,"servers.dat")?)}); if all { row["dirId"]=json!(dir_id_ref); }
                    Ok(Some(row))
                }));
            }
            handles.into_iter().map(|handle| handle.join().unwrap_or_else(|_| Err("实例扫描线程异常".into()))).collect::<Result<Vec<Option<Value>>>>()
        })?;
        result.extend(rows.into_iter().flatten());
    }
    Ok(Value::Array(result))
}
fn substitute(s: &str, vars: &BTreeMap<String,String>) -> Result<String> {
    let re=regex::Regex::new(r"\$\{([^}]+)\}").expect("常量正则"); let mut out=String::new(); let mut cursor=0;
    for c in re.captures_iter(s) { let whole=c.get(0).ok_or("参数占位符无效")?; out.push_str(&s[cursor..whole.start()]); out.push_str(vars.get(&c[1]).ok_or_else(||format!("不支持的启动参数占位符：{}",&c[1]))?); cursor=whole.end(); } out.push_str(&s[cursor..]); if out.contains('\0') { return Err("启动参数含 NUL".into()); } Ok(out)
}
fn arguments(value: Option<&Value>, features: &BTreeMap<String,bool>, vars: &BTreeMap<String,String>) -> Result<Vec<String>> {
    let Some(value)=value else { return Ok(Vec::new()) }; let values=value.as_array().ok_or("启动参数必须是数组")?; if values.len()>16_384 { return Err("启动参数过多".into()); } let mut out=Vec::new();
    for item in values { if let Some(s)=item.as_str() { out.push(substitute(s,vars)?); } else if item.is_object() { if rules_allow(item.get("rules"),features)? { if let Some(s)=item["value"].as_str() { out.push(substitute(s,vars)?); } else { for v in item["value"].as_array().ok_or("条件启动参数值无效")? { out.push(substitute(v.as_str().ok_or("启动参数值必须是字符串")?,vars)?); } } } } else { return Err("启动参数条目格式无效".into()); } }
    Ok(out)
}
fn split_legacy(s:&str)->Result<Vec<String>> { let mut out=Vec::new();let mut word=String::new();let mut quote=None;let mut active=false;for c in s.chars(){if let Some(q)=quote {if c==q {quote=None;} else {word.push(c);}active=true;}else if c=='"'||c=='\'' {quote=Some(c);active=true;}else if c.is_whitespace(){if active {out.push(std::mem::take(&mut word));active=false;}}else {word.push(c);active=true;}}if quote.is_some(){return Err("旧版启动参数引号未闭合".into());}if active{out.push(word);}Ok(out)}
fn extra_args(options:&Value,key:&str)->Result<Vec<String>> { match options.get(key) { None|Some(Value::Null)=>Ok(Vec::new()),Some(Value::Array(a)) if a.len()<=1024=>a.iter().map(|v|v.as_str().filter(|s|!s.contains('\0')&&s.len()<=65_536).map(str::to_string).ok_or_else(||format!("{key} 参数无效"))).collect(),_=>Err(format!("{key} 必须是字符串数组")) } }

fn free_memory_mb()->Result<u64>{
    #[cfg(windows)] { #[repr(C)] struct Memory {length:u32,load:u32,total:u64,free:u64,total_page:u64,free_page:u64,total_virtual:u64,free_virtual:u64,extended:u64} #[link(name="kernel32")]extern "system"{fn GlobalMemoryStatusEx(memory:*mut Memory)->i32;}let mut m=Memory{length:std::mem::size_of::<Memory>()as u32,load:0,total:0,free:0,total_page:0,free_page:0,total_virtual:0,free_virtual:0,extended:0};if unsafe{GlobalMemoryStatusEx(&mut m)}!=0{return Ok(m.free/1048576);}}
    #[cfg(any(target_os="linux", target_os="android"))] {let raw=fs::read_to_string("/proc/meminfo").map_err(|_|"无法读取内核剩余内存")?;let read=|key:&str|raw.lines().find_map(|l|{let(k,v)=l.split_once(':')?;if k!=key{return None;}v.split_whitespace().next()?.parse::<u64>().ok()});if let Some(kb)=read("MemAvailable").or_else(||read("MemFree")){return Ok(kb/1024);}}
    #[cfg(target_os="macos")] {use std::{ffi::c_void,os::raw::c_char};extern "C"{fn sysctlbyname(name:*const c_char,old:*mut c_void,length:*mut usize,new:*mut c_void,new_len:usize)->i32;fn mach_host_self()->u32;fn host_statistics(host:u32,flavor:i32,info:*mut i32,count:*mut u32)->i32;fn mach_port_deallocate(task:u32,name:u32)->i32;static mach_task_self_:u32;}let mut page=0u32;let mut len=std::mem::size_of::<u32>();let host=unsafe{mach_host_self()};let mut stats=[0i32;15];let mut count=15u32;let p=unsafe{sysctlbyname(b"hw.pagesize\0".as_ptr().cast(),(&mut page as *mut u32).cast(),&mut len,std::ptr::null_mut(),0)};let r=unsafe{host_statistics(host,2,stats.as_mut_ptr(),&mut count)};unsafe{mach_port_deallocate(mach_task_self_,host);}if p==0&&r==0&&count>=4&&page!=0{return Ok((stats[0]as u32 as u64+stats[2]as u32 as u64).saturating_mul(page as u64)/1048576);}}
    Err("当前平台无法测量剩余内存，未猜测 JVM 内存上限".into())
}
/// Android 只保留与平台无关的游戏依赖。
///
/// LWJGL 必须整体替换：桌面版的 Java 绑定虽然平台无关，但它会去找 glibc 编译的原生库与
/// 桌面图形后端，在 bionic 上无法加载；对应的 `-natives-` 归档同样是桌面二进制。
fn classpath_allowed(path: &Path) -> bool {
    if !cfg!(target_os = "android") { return true; }
    let name = path.file_name().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    !name.starts_with("lwjgl") && !name.contains("-natives-")
}

fn prepare_arguments(version:&Value,settings:&Value,options:&Value,account:&Value,root:&Path,run:&Path,natives:&Path,deps:&Dependencies,app_version:&str,head:&[PathBuf])->Result<(Vec<String>,Vec<String>)>{
    let main=text(version,"mainClass");if main.is_empty()||main.len()>512||!main.chars().all(|c|c.is_ascii_alphanumeric()||"_.$".contains(c)){return Err("版本入口 mainClass 无效".into());}
    let offline=bool_field(account,"offline",false)?||text(account,"authType")=="offline";let auth=if text(account,"authType").is_empty(){if offline{"offline"}else{"microsoft"}}else{text(account,"authType")};let token=if offline{"0"}else{text(account,"accessToken")};let player=text(account,"name");let uuid=text(account,"id").replace('-',"");
    if player.is_empty()||player.len()>256||player.chars().any(char::is_control)||uuid.len()!=32||!uuid.bytes().all(|c|c.is_ascii_hexdigit()){return Err("账号名称或 UUID 无效".into());}
    if !offline {if !matches!(auth,"microsoft"|"yggdrasil")||token.is_empty()||token.len()>32_768||token.chars().any(char::is_control){return Err("在线账号缓存凭据无效，请重新登录".into());}if account["expiresAt"].as_u64().unwrap_or(0)<=now_ms().saturating_add(60_000){return Err("账号令牌已过期、即将过期或缺少有效期；此阶段未接入刷新，请联网重新登录".into());}}
    let requested_memory=integer(options,"memoryMb",integer(settings,"memoryMb",4096,256,262_144)?,256,262_144)?;let free=free_memory_mb()?;if free<256{return Err("系统剩余内存不足 256 MiB，已拒绝启动".into());}let memory=requested_memory.min(free);
    // 原生显示采样已在根目录锁之前完成；阻塞工作中只消费确定的内容区尺寸。
    let(width,height,fullscreen)=game_window_size::launch_arguments(options)?;
    let mut features=BTreeMap::from([("is_demo_user".into(),bool_field(options,"demo",false)?),("has_custom_resolution".into(),true)]);let targets=[("quickPlaySingleplayer","is_quick_play_singleplayer"),("quickPlayMultiplayer","is_quick_play_multiplayer"),("quickPlayRealms","is_quick_play_realms")];let mut requested=0;for(key,feature)in targets {if let Some(v)=options.get(key){let v=v.as_str().ok_or("QuickPlay 必须是字符串")?;if v.len()>4096||v.chars().any(char::is_control){return Err("QuickPlay 参数无效".into());}if !v.is_empty(){requested+=1;features.insert(feature.into(),true);}}}if requested>1{return Err("一次只能指定一个 QuickPlay 目标".into());}if requested>0{let base=if text(version,"clientVersion").is_empty(){text(version,"id")}else{text(version,"clientVersion")};let captures=regex::Regex::new(r"^(\d+)\.(\d+)(?:\.(\d+))?(?:$|[-+_])").expect("常量正则");let c=captures.captures(base).ok_or("无法确认此版本支持 QuickPlay")?;let a=c[1].parse::<u32>().unwrap_or(0);let b=c[2].parse::<u32>().unwrap_or(0);if a<1||(a==1&&b<20){return Err("QuickPlay 需要 Minecraft 1.20+".into());}features.insert("has_quick_plays_support".into(),true);}
    let sep=if cfg!(windows){";"}else{":"};let mut entries=head.to_vec();entries.extend(deps.classpath.iter().filter(|path|classpath_allowed(path)).cloned());let classpath=entries.iter().map(|p|p.to_str().ok_or("类路径不是 UTF-8")).collect::<std::result::Result<Vec<_>,_>>()?.join(sep);let path_string=|p:PathBuf|p.to_str().map(str::to_string).ok_or_else(||"游戏路径不是 UTF-8".to_string());
    let asset_path=if !deps.asset_index.is_empty(){let index=read_json(&inside(root,Path::new("assets/indexes").join(format!("{}.json",deps.asset_index)))?)?;if index["virtual"].as_bool().unwrap_or(false){inside(root,Path::new("assets/virtual").join(&deps.asset_index))?}else{inside(root,"assets")?}}else{inside(root,"assets")?};
    let mut vars=BTreeMap::from([("auth_player_name".into(),player.into()),("version_name".into(),text(version,"id").into()),("game_directory".into(),path_string(run.to_path_buf())?),("assets_root".into(),path_string(inside(root,"assets")?)?),("game_assets".into(),path_string(asset_path)?),("assets_index_name".into(),deps.asset_index.clone()),("auth_uuid".into(),uuid),("auth_access_token".into(),token.into()),("auth_session".into(),if offline{"0".into()}else{format!("token:{token}")}), ("user_type".into(),if offline||auth=="yggdrasil"{"legacy"}else{"msa"}.into()),("version_type".into(),if text(version,"type").is_empty(){"release"}else{text(version,"type")}.into()),("clientid".into(),"0".into()),("auth_xuid".into(),"0".into()),("user_properties".into(),"{}".into()),("natives_directory".into(),path_string(natives.to_path_buf())?),("launcher_name".into(),"HungerCatLauncher".into()),("launcher_version".into(),app_version.into()),("classpath".into(),classpath.clone()),("classpath_separator".into(),sep.into()),("library_directory".into(),path_string(inside(root,"libraries")?)?),("resolution_width".into(),width.to_string()),("resolution_height".into(),height.to_string()),("language".into(),"zh_cn".into())]);
    let quick=inside(root,Path::new("launcher-quickplay").join(format!("{}.json",uuid::Uuid::new_v4())))?;vars.insert("quickPlayPath".into(),path_string(quick)?);for(key,_)in targets {vars.insert(key.into(),text(options,key).into());}
    let mut jvm=if version["arguments"].get("jvm").is_some(){arguments(version["arguments"].get("jvm"),&features,&vars)?}else{vec![format!("-Djava.library.path={}",natives.to_string_lossy()),"-cp".into(),classpath.clone()]};let mut game=if version["arguments"].get("game").is_some(){arguments(version["arguments"].get("game"),&features,&vars)?}else{split_legacy(text(version,"minecraftArguments"))?.iter().map(|s|substitute(s,&vars)).collect::<Result<Vec<_>>>()?};
    for arg in &mut jvm {if let Some(value)=arg.strip_prefix("-DFabricMcEmu="){*arg=format!("-DFabricMcEmu={}",value.trim());}}
    if !jvm.iter().any(|s|matches!(s.as_str(),"-cp"|"-classpath"|"--class-path")){jvm.push("-cp".into());jvm.push(classpath);}if !jvm.iter().any(|s|s.starts_with("-Djava.library.path=")){jvm.push(format!("-Djava.library.path={}",natives.to_string_lossy()));}
    #[cfg(target_os="macos")]if !jvm.iter().any(|s|s=="-XstartOnFirstThread"){jvm.insert(0,"-XstartOnFirstThread".into());}
    let log=&version["logging"]["client"];if log.is_object(){let file=&log["file"];let path=inside(root,Path::new("assets/log_configs").join(identifier(text(file,"id"))?))?;verify_file(&path,file,"日志配置")?;let argument=text(log,"argument");if argument.is_empty(){return Err("日志配置缺少 JVM 参数".into());}jvm.push(argument.replace("${path}",path.to_str().ok_or("日志路径不是 UTF-8")?));}
    let mut all=vec![format!("-Xmx{memory}M")];all.extend(extra_args(options,"extraJvmArgs")?);all.extend(jvm);let mut secrets=Vec::new();if !offline{secrets.push(token.to_string());}for key in ["refreshToken","clientToken"]{if !text(account,key).is_empty(){secrets.push(text(account,key).to_string());}}
    secrets.sort_by_key(|s|std::cmp::Reverse(s.len()));secrets.dedup();if auth=="yggdrasil"&&!offline{let injector=inside(root,"libraries/authlib-injector.jar")?;verify_file(&injector,&json!({}),"authlib-injector")?;let server=text(account,"yggdrasilServer");let url=reqwest::Url::parse(server).map_err(|_|"第三方认证地址无效")?;if url.scheme()!="https"||url.host_str().is_none()||!url.username().is_empty()||url.password().is_some()||server.chars().any(char::is_control){return Err("第三方认证必须使用无凭据的 HTTPS 地址".into());}all.insert(0,format!("-javaagent:{}={server}",injector.to_string_lossy()));}
    all.push(main.into());for(key,_)in targets {let value=text(options,key);let flag=format!("--{key}");if !value.is_empty()&&!game.iter().any(|s|s==&flag){game.push(flag);game.push(value.into());}}if fullscreen&&!game.iter().any(|s|s=="--fullscreen"){game.push("--fullscreen".into());}all.extend(game);all.extend(extra_args(options,"extraGameArgs")?);if all.iter().any(|s|s.contains('\0')){return Err("启动参数含 NUL".into());}Ok((all,secrets))
}

#[derive(Clone,Serialize)] struct RuntimeEvent { channel: &'static str, payload: Value }
fn emit(app:&tauri::AppHandle,payload:Value){let _=app.emit_to("main","launcher:event",RuntimeEvent{channel:"launch:event",payload});}
/// 阶段进度：只写日志、不改状态，前端会追加到启动控制台。
///
/// 启动流程有几步在手机上可能慢到几十秒（资源 SHA-1 校验、实例目录锁、进程内 JVM 创建），
/// 没有阶段提示时用户只能看到一直转圈。这里每进入一个阶段先落一行，卡住时最后一行就是现场。
pub(crate) fn stage(app:&tauri::AppHandle,text:&str){ emit(app,json!({"log":format!("[启动] {text}")})); }
struct GameControl { pid:u32, session:String, stop:AtomicBool, done:AtomicBool }
impl GameControl {
    fn new(pid:u32, stopping:bool)->Self {
        Self {pid,session:uuid::Uuid::new_v4().to_string(),stop:AtomicBool::new(stopping),done:AtomicBool::new(false)}
    }
}
static GAME:OnceLock<Mutex<Option<Arc<GameControl>>>>=OnceLock::new();

fn hud_game_session_from(slot:&Mutex<Option<Arc<GameControl>>>)->Result<Option<String>> {
    let current=slot.lock().map_err(|_|"无法确认游戏运行状态 / 無法確認遊戲執行狀態 / Cannot confirm the game runtime state".to_string())?;
    Ok(current.as_ref().filter(|game|!game.done.load(Ordering::Acquire)).map(|game|game.session.clone()))
}
/// 只返回实际派发并登记的游戏会话；停止信号不能冒充进程已经结束。
pub(crate) fn hud_game_session()->Result<Option<String>> {
    match GAME.get() {Some(slot)=>hud_game_session_from(slot),None=>Ok(None)}
}
/// HUD 读取顺序是 HUD -> GAME；所有退出路径必须先完成权威表更新并释放 GAME，再回调 HUD。
fn complete_game_from(slot:&Mutex<Option<Arc<GameControl>>>,control:&Arc<GameControl>,stopped:impl FnOnce(&str)) {
    control.done.store(true,Ordering::Release);
    if let Ok(mut current)=slot.lock() {
        if current.as_ref().is_some_and(|game|Arc::ptr_eq(game,control)) {*current=None;}
    }
    stopped(&control.session);
}

pub(crate) fn game_is_running() -> bool {
    GAME.get().and_then(|slot| slot.lock().ok()).and_then(|state| state.as_ref().map(|game| !game.done.load(Ordering::Acquire))).unwrap_or(false)
}
#[derive(Default)]
struct StartTicket {
    cancel: Arc<crate::downloads::Cancel>,
    // 0 准备、1 取消先赢、2 已进入固定 spawn 派发。派发后取消由 GameControl 负责停止。
    phase: std::sync::atomic::AtomicU8,
    done: AtomicBool,
    uncertain: AtomicBool,
    completion: tokio::sync::Notify,
}
impl StartTicket {
    fn stop(&self) { let _=self.phase.compare_exchange(0,1,Ordering::AcqRel,Ordering::Acquire);self.cancel.stop(); }
    fn check(&self)->Result<()> {self.cancel.check().map_err(|_|"游戏启动已取消".into())}
    fn begin_dispatch(&self)->Result<()> {
        self.check()?;
        self.phase.compare_exchange(0,2,Ordering::AcqRel,Ordering::Acquire).map(|_|()).map_err(|_|"游戏启动已取消或重复派发".into())
    }
    fn finish(&self) {self.done.store(true,Ordering::Release);self.completion.notify_waiters();}
    async fn wait(&self) {loop{let notified=self.completion.notified();tokio::pin!(notified);notified.as_mut().enable();if self.done.load(Ordering::Acquire){return;}notified.await;}}
}
#[derive(Default)]
struct StartState {closed:bool,stopping:usize,generation:u64,active:Option<Arc<StartTicket>>,update_lease:Option<Arc<()>>}
impl StartState {
    fn capture(&self)->Result<LaunchRequest>{if self.closed||self.stopping!=0{return Err("窗口已关闭或停止仍在收尾".into());}if self.update_lease.is_some(){return Err("资源更新仍在写入或恢复，不能启动游戏".into());}Ok(LaunchRequest{generation:self.generation})}
    fn reserve_request(&mut self,request:LaunchRequest)->Result<Arc<StartTicket>>{if request.generation!=self.generation{return Err("启动请求已被较新的停止操作取消".into());}self.reserve()}
    fn begin_stop(&mut self)->Result<Option<Arc<StartTicket>>>{
        let next_stopping=self.stopping.checked_add(1).ok_or("停止任务过多")?;
        self.generation=match self.generation.checked_add(1){Some(next)=>next,None=>{self.close();return Err("启动请求序号已耗尽，请重启启动器".into());}};
        self.stopping=next_stopping;
        if let Some(ticket)=&self.active{ticket.stop();}Ok(self.active.clone())
    }
    fn end_stop(&mut self){self.stopping=self.stopping.saturating_sub(1);}
    fn reserve(&mut self)->Result<Arc<StartTicket>> {
        if self.closed {return Err("主窗口已关闭，不能开始新的游戏启动".into());}
        if self.active.is_some()||self.stopping!=0 {return Err("游戏启动仍在准备或收尾，请稍候".into());}
        if self.update_lease.is_some(){return Err("资源更新仍在写入或恢复，不能启动游戏".into());}
        let ticket=Arc::new(StartTicket::default());self.active=Some(ticket.clone());Ok(ticket)
    }
    fn complete(&mut self,ticket:&Arc<StartTicket>) {if self.active.as_ref().is_some_and(|current|Arc::ptr_eq(current,ticket)){self.active=None;}ticket.finish();}
    fn close(&mut self) {self.closed=true;if let Some(ticket)=&self.active{ticket.stop();}}
}
/// 仅组合根持有的请求纪元；在首次 await 前捕获，WebView 不能自行提供。
#[derive(Clone,Copy)]
pub(crate) struct LaunchRequest{generation:u64}
static STARTS:OnceLock<Arc<Mutex<StartState>>>=OnceLock::new();
fn starts()->&'static Arc<Mutex<StartState>>{STARTS.get_or_init(||Arc::new(Mutex::new(StartState::default())))}

/// 宿主取得游戏根锁后申请，并由实际写入/恢复的所有者持有到真实收尾。
/// 不可复制；未知收尾不得提前 Drop，异常展开或状态锁损坏时保留占用以失败关闭。
#[must_use = "资源更新期间必须持有租约，直到写入和恢复真正结束"]
pub(crate) struct ResourceUpdateLease {
    state: Arc<Mutex<StartState>>,
    token: Arc<()>,
}
impl ResourceUpdateLease {
    /// 写入或恢复结果未知时永久保留租约；不能用普通 Drop 伪装已安全收尾。
    pub(crate) fn quarantine(self) { std::mem::forget(self); }
}
impl Drop for ResourceUpdateLease {
    fn drop(&mut self) {
        if thread::panicking() { return; }
        if let Ok(mut state) = self.state.lock() {
            if state.update_lease.as_ref().is_some_and(|current| Arc::ptr_eq(current, &self.token)) {
                state.update_lease = None;
            }
        }
    }
}
/// 与启动预留共用同一状态锁；不以 game_is_running 的失败开放结果判定空闲。
pub(crate) fn acquire_resource_update_lease() -> Result<ResourceUpdateLease> {
    acquire_resource_update_lease_from(starts().clone(), || GAME.get())
}
fn acquire_resource_update_lease_from<'a>(
    start_state: Arc<Mutex<StartState>>,
    game_slot: impl FnOnce() -> Option<&'a Mutex<Option<Arc<GameControl>>>>,
) -> Result<ResourceUpdateLease> {
    let mut state = start_state.try_lock().map_err(|_| "启动任务状态忙碌或不可用，不能更新资源".to_string())?;
    if state.closed || state.stopping != 0 || state.active.is_some() || state.update_lease.is_some() {
        return Err("游戏启动、停止或资源更新仍未收尾，不能更新资源".into());
    }
    if let Some(slot) = game_slot() {
        let game = slot.try_lock().map_err(|_| "游戏进程状态忙碌或不可用，不能更新资源".to_string())?;
        if game.as_ref().is_some_and(|control| !control.done.load(Ordering::Acquire)) {
            return Err("游戏进程仍未退出，不能更新资源".into());
        }
    }
    // 持有启动锁完成检查及登记；任何新派发必须先取得该锁并登记 active。
    let token = Arc::new(());
    state.update_lease = Some(token.clone());
    drop(state);
    Ok(ResourceUpdateLease { state: start_state, token })
}
/// 仅本次启动可携带的恢复授权；根目录与私有启动票据均不能由 IPC 调用方提供。
pub(crate) struct LaunchRecoveryPermit {
    root: PathBuf,
    ticket: Arc<StartTicket>,
}
impl LaunchRecoveryPermit {
    fn new(root: &Path, ticket: Arc<StartTicket>) -> Result<Self> {
        ticket.check()?;
        let checked = absolute(root)?;
        let canonical = fs::canonicalize(&checked).map_err(|_| "无法规范化启动恢复根目录")?;
        let root = absolute(&canonical)?;
        if !fs::metadata(&root).map_err(|_| "无法核验启动恢复根目录")?.is_dir() {
            return Err("启动恢复根目录不是目录".into());
        }
        ticket.check()?;
        Ok(Self { root, ticket })
    }
    /// 调用方已持有此 canonical 根的真实根锁；这里只在短状态锁内核验授权并登记租约。
    pub(crate) fn acquire_lease(&self, canonical_root: &Path) -> Result<ResourceUpdateLease> {
        acquire_launch_recovery_lease_from(self, canonical_root, starts().clone(), || GAME.get())
    }
    /// 仅恢复所有者用于记录未知结果；不取消、不释放票据或伪报完成。
    pub(crate) fn mark_uncertain(&self) { self.ticket.uncertain.store(true, Ordering::Release); }
    fn ready(&self, state: &StartState) -> bool {
        !state.closed && state.stopping == 0 && state.update_lease.is_none()
            && state.active.as_ref().is_some_and(|active| Arc::ptr_eq(active, &self.ticket))
            && self.ticket.phase.load(Ordering::Acquire) == 0
            && !self.ticket.done.load(Ordering::Acquire)
            && !self.ticket.uncertain.load(Ordering::Acquire)
            && self.ticket.cancel.check().is_ok()
    }
}
fn acquire_launch_recovery_lease_from<'a>(
    permit: &LaunchRecoveryPermit,
    canonical_root: &Path,
    start_state: Arc<Mutex<StartState>>,
    game_slot: impl FnOnce() -> Option<&'a Mutex<Option<Arc<GameControl>>>>,
) -> Result<ResourceUpdateLease> {
    if canonical_root != permit.root.as_path() {
        return Err("启动恢复授权与已持锁的游戏根目录不一致".into());
    }
    let mut state = start_state.try_lock().map_err(|_| "启动任务状态忙碌或不可用，不能恢复资源".to_string())?;
    if !permit.ready(&state) { return Err("启动恢复授权已取消、失效或仍有其他资源任务".into()); }
    if let Some(slot) = game_slot() {
        let game = slot.try_lock().map_err(|_| "游戏进程状态忙碌或不可用，不能恢复资源".to_string())?;
        if game.as_ref().is_some_and(|control| !control.done.load(Ordering::Acquire)) {
            return Err("游戏进程仍未退出，不能恢复资源".into());
        }
    }
    // 等待 GAME 短锁期间调用方可能直接发出取消信号；登记前再核对票据原子状态。
    if !permit.ready(&state) { return Err("启动恢复授权已取消、失效或仍有其他资源任务".into()); }
    let token = Arc::new(());
    state.update_lease = Some(token.clone());
    drop(state);
    Ok(ResourceUpdateLease { state: start_state, token })
}
/// 组合根持有重启 IPC 门禁时调用；只读检查，不等待锁或请求停止游戏。
pub(crate) fn relaunch_ready() -> Result<()> { relaunch_ready_from(starts(),||GAME.get()) }
fn relaunch_ready_from<'a>(start_state:&Mutex<StartState>,game_slot:impl FnOnce()->Option<&'a Mutex<Option<Arc<GameControl>>>>)->Result<()> {
    let state=start_state.try_lock().map_err(|_|"启动任务状态忙碌或不可用，不能安全重启".to_string())?;
    if state.closed||state.stopping!=0||state.active.is_some()||state.update_lease.is_some(){return Err("游戏启动、停止或资源更新仍未收尾，不能安全重启".into());}
    if let Some(slot)=game_slot() {
        let game=slot.try_lock().map_err(|_|"游戏进程状态忙碌或不可用，不能安全重启".to_string())?;
        if game.as_ref().is_some_and(|control|!control.done.load(Ordering::Acquire)){return Err("游戏进程仍未退出，不能安全重启".into());}
    }
    Ok(())
}
struct StartWaiter {ticket:Arc<StartTicket>,armed:bool}
impl Drop for StartWaiter{fn drop(&mut self){if self.armed{self.ticket.stop();}}}
pub(crate) fn capture_launch_request()->Result<LaunchRequest>{starts().lock().map_err(|_|"启动任务状态不可用")?.capture()}
fn reserve_start(request:LaunchRequest)->Result<Arc<StartTicket>> {starts().lock().map_err(|_|"启动任务状态不可用")?.reserve_request(request)}
pub(crate) async fn launch_request(options:&Value,settings:&Value,account:Option<&Value>,app:&tauri::AppHandle,request:LaunchRequest)->Result<Value>{launch_start(options,settings,account,app,request).await}
fn complete_start(ticket:&Arc<StartTicket>){if let Ok(mut state)=starts().lock(){state.complete(ticket);}}
async fn retain_start_work<T>(ticket:Arc<StartTicket>,work:impl std::future::Future<Output=Result<T>>,finish:impl FnOnce(&Arc<StartTicket>))->Result<T>{
    let result=work.await;
    if !ticket.uncertain.load(Ordering::Acquire){finish(&ticket);}
    result
}
struct StopWaiter{armed:bool}
impl Drop for StopWaiter{fn drop(&mut self){if self.armed{if let Ok(mut state)=starts().lock(){state.end_stop();}}}}
fn check_start_cancel(ticket:&StartTicket)->Result<()>{ticket.check()}
/// 关闭回调只操作原子信号和短任务锁，不等待认证、磁盘或游戏退出。
pub(crate) fn cancel_for_window(){
    if let Ok(mut state)=starts().lock(){state.close();}
    if let Some(slot)=GAME.get(){if let Ok(slot)=slot.lock(){if let Some(game)=slot.as_ref(){game.stop.store(true,Ordering::Release);}}}
}
fn redact(line:&str,secrets:&[String])->String{let mut out=line.to_string();for secret in secrets{if !secret.is_empty(){out=out.replace(secret,"[已脱敏]");}}let re=regex::Regex::new(r#"(?i)((?:access_token|refresh_token|client_token|authorization)\s*[=:]\s*["']?)([^\s"',;]+)"#).expect("常量正则");re.replace_all(&out,"$1[已脱敏]").into_owned()}
fn log_pipe<R:Read+Send+'static>(mut pipe:R,tx:mpsc::SyncSender<String>){thread::spawn(move||{let mut buffer=[0u8;4096];let mut line=Vec::new();let mut dropped=false;loop{let n=match pipe.read(&mut buffer){Ok(0)|Err(_)=>break,Ok(n)=>n};for b in &buffer[..n]{if *b==b'\n'{let message=if dropped{"[过长的游戏日志行已省略]".to_string()}else{String::from_utf8_lossy(&line).trim_end_matches('\r').to_string()};if tx.send(message).is_err(){return;}line.clear();dropped=false;}else if line.len()<65_536&&!dropped{line.push(*b);}else{line.clear();dropped=true;}}}if dropped{let _=tx.send("[过长的游戏日志行已省略]".into());}else if !line.is_empty(){let _=tx.send(String::from_utf8_lossy(&line).into_owned());}});}
fn start_owned(program:PathBuf,argv:Vec<String>,cwd:PathBuf,root:PathBuf,id:String,secrets:Vec<String>,account:Value,isolation:crate::modpack::InstanceIsolation,ticket:Arc<StartTicket>,app:tauri::AppHandle)->Result<Value>{
    check_start_cancel(&ticket)?;let logs=inside(&root,"launcher-logs")?;make_dir(&logs)?;let log_path=inside(&logs,format!("{}-{}-{}.log",id,now_ms(),uuid::Uuid::new_v4()))?;let mut log=OpenOptions::new().write(true).create_new(true).open(&log_path).map_err(|_|"无法创建游戏日志文件")?;
    emit(&app,json!({"state":"launching"}));
    // 只有此固定闭包在 Storage 锁内：账号删除/新登录与进程派发在这里确定先后。
    let(child,group)=app.state::<crate::storage::Storage>().with_unchanged_account_for_launch(&account,||{
        isolation.verify()?;ticket.begin_dispatch()?;spawn_process(&program,&argv,Some(&cwd))
    })?;
    let mut owned=OwnedChild{child,group};let pid=owned.child.id();let control=Arc::new(GameControl::new(pid,ticket.cancel.check().is_err()));let stdout=owned.child.stdout.take().ok_or("无法捕获游戏标准输出")?;let stderr=owned.child.stderr.take().ok_or("无法捕获游戏错误输出")?;
    let(tx,rx)=mpsc::sync_channel(128);log_pipe(stdout,tx.clone());log_pipe(stderr,tx.clone());drop(tx);
    {let mut slot=GAME.get_or_init(||Mutex::new(None)).lock().map_err(|_|"游戏进程状态不可用")?;if ticket.cancel.check().is_err(){control.stop.store(true,Ordering::Release);}*slot=Some(control.clone());}
    emit(&app,json!({"state":"running","pid":pid}));let monitor_control=control.clone();let monitor_app=app.clone();let monitor_ticket=ticket.clone();
    let spawn=thread::Builder::new().name("hcmcl-game-monitor".into()).spawn(move||{
        let mut bytes=0usize;let mut suppressed=false;let mut terminal=None;let mut finished_at=None;let mut killed=false;
        loop{
            if (monitor_control.stop.load(Ordering::Acquire)||monitor_ticket.cancel.check().is_err())&&!killed{owned.group.kill();let _=owned.child.kill();killed=true;}
            if terminal.is_none(){match owned.child.try_wait(){Ok(Some(status))=>{terminal=Some(status.code().unwrap_or(if killed{0}else{-1}));finished_at=Some(Instant::now());owned.group.kill();},Err(_)=>{owned.group.kill();let _=owned.child.kill();let _=owned.child.wait();terminal=Some(-1);finished_at=Some(Instant::now());},Ok(None)=>{}}}
            match rx.recv_timeout(Duration::from_millis(30)){
                Ok(line)=>{
                    let clean=redact(&line,&secrets);
                    if bytes.saturating_add(clean.len()+1)<=8*1024*1024{
                        bytes=bytes.saturating_add(clean.len()+1);
                        let _=writeln!(log,"{clean}");
                        emit(&monitor_app,json!({"log":format!("{clean}\n")}));
                        // 复用同一条受管输出；共享诊断失败不能阻断游戏或原启动事件。
                        let _=crate::debug::append_game(&monitor_app,&clean,&secrets);
                    }else if !suppressed{
                        suppressed=true;
                        let notice="[游戏日志达到本次 8 MiB 上限，后续正文未留存]";
                        let _=writeln!(log,"{notice}");
                        emit(&monitor_app,json!({"log":format!("{notice}\n")}));
                        let _=crate::debug::append_game(&monitor_app,notice,&secrets);
                    }
                },
                Err(mpsc::RecvTimeoutError::Disconnected)=>{if terminal.is_some(){break;}thread::sleep(Duration::from_millis(30));},Err(mpsc::RecvTimeoutError::Timeout)=>{}
            }
            if finished_at.is_some_and(|at|at.elapsed()>Duration::from_secs(2)){break;}
        }
        let _=log.flush();let code=if killed{0}else{terminal.unwrap_or(-1)};
        complete_game_from(GAME.get_or_init(||Mutex::new(None)),&monitor_control,|session|{
            crate::ai_hud::game_stopped(&monitor_app,session);
        });
        emit(&monitor_app,json!({"state":"exited","exitCode":code,"pid":pid}));
    });
    if spawn.is_err(){
        control.stop.store(true,Ordering::Release);
        // 创建线程失败也已经登记过会话；闭包丢弃并回收进程后必须通知 HUD 撤销该会话。
        complete_game_from(GAME.get_or_init(||Mutex::new(None)),&control,|session|crate::ai_hud::game_stopped(&app,session));
        return Err("无法创建游戏进程监控线程".into());
    }
    crate::ai_hud::game_started(&app,&control.session);
    Ok(json!({"pid":pid}))
}
async fn launch_start(options:&Value,settings:&Value,account:Option<&Value>,app:&tauri::AppHandle,request:LaunchRequest)->Result<Value>{
    if !launch_supported() { return Err(MOBILE_RUNTIME_BOUNDARY.into()); }
    let object=options.as_object().ok_or("启动选项必须是对象")?;let allowed=["versionId","accountId","gameDir","memoryMb","javaPath","extraJvmArgs","extraGameArgs","fullscreen","demo","resolution","quickPlaySingleplayer","quickPlayMultiplayer","quickPlayRealms"];
    if object.keys().any(|key|!allowed.contains(&key.as_str())){return Err("启动选项包含未支持字段".into());}
    for key in ["versionId","accountId","gameDir","javaPath"] {if let Some(value)=object.get(key){if !value.is_null()&&!value.is_string(){return Err("启动路径或标识必须是字符串".into());}}}
    let id=identifier(text(options,"versionId"))?.to_string();if settings["disabledVersions"].as_array().is_some_and(|items|items.iter().any(|value|value.as_str()==Some(id.as_str()))){return Err("该版本已禁用，请在版本管理中启用后再启动".into());}
    let initial=account.ok_or("请先登录一个账号")?;let account_id=text(initial,"id").to_string();
    if !text(options,"accountId").is_empty()&&text(options,"accountId")!=account_id{return Err("所选账号与后台传入账号不一致，请刷新账号选择".into());}
    let root=active_root(settings)?;
    if let Some(dir)=options.get("gameDir").filter(|value|!value.is_null()){let dir=dir.as_str().ok_or("gameDir 必须为字符串")?;if !dir.is_empty()&&absolute(Path::new(dir))?!=root{return Err("启动目录与当前已选版本目录不一致".into());}}
    {let slot=GAME.get_or_init(||Mutex::new(None)).lock().map_err(|_|"游戏进程状态不可用")?;if slot.as_ref().is_some_and(|game|!game.done.load(Ordering::Acquire)){return Err("已有游戏进程运行，请先停止当前游戏".into());}}
    // 首个 await 之前登记；不排队后清除全局取消标志，第二个启动也不能覆盖第一个票据。
    let ticket=reserve_start(request)?;let mut waiter=StartWaiter{ticket:ticket.clone(),armed:true};
    let worker_ticket=ticket.clone();let worker_app=app.clone();let settings=settings.clone();let options=options.clone();
    let worker=tauri::async_runtime::spawn(async move{
        // 登记之后再检查一次：前一游戏可能恰在最初检查与登记之间完成派发。
        let work=async{
            {let slot=GAME.get_or_init(||Mutex::new(None)).lock().map_err(|_|"游戏进程状态不可用")?;if slot.as_ref().is_some_and(|game|!game.done.load(Ordering::Acquire)){return Err("已有游戏进程运行，请先停止当前游戏".into());}}
            launch_prepared(options,settings,account_id,root,worker_ticket.clone(),worker_app.clone()).await
        };
        // 完整工作（含阻塞探针/存档/解压/派发）实际收尾后才让新启动进入。
        let result=retain_start_work(worker_ticket.clone(),work,complete_start).await;
        if let Err(error)=&result{emit(&worker_app,json!({"state":"error","error":error}));}
        result
    });
    let result=worker.await.map_err(|_|"游戏启动任务结果未知，仍保持忙碌；请核对进程后重启启动器".to_string())?;
    waiter.armed=false;result
}
async fn launch_prepared(options:Value,settings:Value,account_id:String,root:PathBuf,ticket:Arc<StartTicket>,app:tauri::AppHandle)->Result<Value>{
    ticket.check()?;
    stage(&app,"校验启动票据与实例目录");
    let permit=LaunchRecoveryPermit::new(&root,ticket.clone())?;
    let root=permit.root.clone();
    // 网络刷新在取得游戏目录锁之前；固定最初选定的 UUID，不重新选择全局 selected。
    stage(&app,"确认账号凭据");
    let account=crate::auth::account_for_launch(&app,&account_id,ticket.cancel.clone()).await?;
    ticket.check()?;
    // 主 UI 只采样/弹非阻塞警告；await 属于现有启动 owner，且此时尚未持有根目录锁。
    stage(&app,"计算游戏画面尺寸");
    let options=game_window_size::resolve_options(&app,&settings,options,ticket.cancel.clone()).await?;
    ticket.check()?;
    stage(&app,"等待实例目录锁");
    let root_guard=install_lock::acquire_for_launch(&root,||ticket.cancel.check().is_err(),permit).await?;
    ticket.check()?;
    stage(&app,"解析版本清单");
    let id=text(&options,"versionId").to_string();
    let version=resolve_for_launch(&id,&root,&settings,&ticket).await?;
    ticket.check()?;let version_string=app.package_info().version.to_string();
    // Android 按版本清单声明的主版本选 Java：17 用随包内置的，21/25 首次启动时下载，
    // 当前架构拿不到运行时就明确报错——绝不能让游戏跑在不匹配的 JVM 上。
    #[cfg(target_os = "android")]
    let java_runtime={stage(&app,"检查 Java 运行时");crate::android_runtime::prepare(&app,&version,ticket.cancel.clone()).await?};
    // await 不与取消竞速：任务已派发后让根锁、探针和解压的真实所有者收尾。
    let failure_ticket=ticket.clone();
    tauri::async_runtime::spawn_blocking(move||{
        let _root_guard=root_guard;
        check_start_cancel(&ticket)?;
        #[cfg(not(target_os = "android"))]
        let required=required_java(&version)?;
        stage(&app,"校验依赖与游戏资源");
        let isolation=crate::modpack::instance_isolation(&root,&id,&settings)?;let run=if isolation.isolated{inside(&root,Path::new("versions").join(&id))?}else{absolute(&root)?};check_start_cancel(&ticket)?;make_dir(&run)?;
        let mut features=BTreeMap::new();features.insert("is_demo_user".into(),bool_field(&options,"demo",false)?);features.insert("has_custom_resolution".into(),true);let deps=dependencies(&version,&root,&features)?;check_start_cancel(&ticket)?;validate_assets(&version,&root,&run,&deps.asset_index)?;check_start_cancel(&ticket)?;
        // Android 的原生库就在 APK 的 lib/<abi>/ 里：既不需要解压桌面 natives，也不能让
        // `java.library.path` 指向那些 glibc 二进制，否则 LWJGL 会加载到错误架构的库。
        #[cfg(target_os = "android")]
        let natives=crate::android_jvm::native_dir().ok_or("Android 原生库目录尚未就绪，请重新打开应用")?;
        #[cfg(not(target_os = "android"))]
        let natives=extract_natives(&root,&id,&deps.natives)?;
        // 随包的 LWJGL for Android 排在类路径最前，桌面 LWJGL 由 `classpath_allowed` 剔除。
        #[cfg(target_os = "android")]
        let head:Vec<PathBuf>=vec![crate::android_jvm::lwjgl_jar().ok_or("Android 图形层类库缺失，请重新安装应用")?];
        #[cfg(not(target_os = "android"))]
        let head:Vec<PathBuf>=Vec::new();
        check_start_cancel(&ticket)?;
        stage(&app,"组装启动参数");
        let(argv,secrets)=prepare_arguments(&version,&settings,&options,&account,&root,&run,&natives,&deps,&version_string,&head)?;
        #[cfg(target_os = "android")]
        return start_in_process(argv,run,root,id,secrets,account,isolation,ticket,app,java_runtime);
        #[cfg(not(target_os = "android"))]
        {let java=choose_java(&settings,&id,&options,required)?;start_owned(PathBuf::from(text(&java,"path")),argv,run,root,id,secrets,account,isolation,ticket,app)}
    }).await.map_err(|_|{failure_ticket.uncertain.store(true,Ordering::Release);"游戏启动后台任务结果未知，请核对进程后重启启动器".to_string()})?
}
/// Android 的 Java 适配检查：内置 JVM 由 APK 自带，不存在「装哪个桌面 Java」的问题。
/// 首次调用会真正创建 JVM（进程内只创建一次），因此放到阻塞线程池执行。
#[cfg(target_os = "android")]
async fn android_java_check(_app: &tauri::AppHandle) -> Result<Option<Value>> {
    let text = tauri::async_runtime::spawn_blocking(crate::android_jvm::probe)
        .await
        .map_err(|_| "Android 运行时探测后台任务异常")??;
    let major = text
        .split('|')
        .next()
        .and_then(|value| value.split('.').next())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    Ok(Some(json!({
        "required": 0,
        "compatible": true,
        "available": [{"name": text, "path": "", "major": major, "source": "builtin"}],
        "supported": true
    })))
}
/// 已装 Java 运行时清单（Android 专属；其它平台返回空列表，前端据此不渲染管理入口）。
#[cfg(target_os = "android")]
async fn android_runtimes() -> Result<Value> {
    let list = tauri::async_runtime::spawn_blocking(crate::android_runtime::inventory)
        .await
        .map_err(|_| "运行时清单后台任务异常")??;
    Ok(json!({ "runtimes": list }))
}

#[cfg(not(target_os = "android"))]
async fn android_runtimes() -> Result<Value> {
    Ok(json!({ "runtimes": [] }))
}

/// 删除一个下载来的运行时。内置 17 与「本次会话正在用的那套」由底层拒绝。
#[cfg(target_os = "android")]
async fn android_remove_runtime(major: u64) -> Result<Value> {
    tauri::async_runtime::spawn_blocking(move || crate::android_runtime::remove(major))
        .await
        .map_err(|_| "删除运行时后台任务异常")??;
    Ok(json!({ "removed": major }))
}

#[cfg(not(target_os = "android"))]
async fn android_remove_runtime(_major: u64) -> Result<Value> {
    Err("当前平台没有可管理的 Android 运行时".into())
}

/// 进程内游戏主方法的退出码；`android_game_finished` 写入，日志线程读出。
#[cfg(target_os = "android")]
static ANDROID_EXIT: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

/// 游戏主方法返回时由 JNI 侧回调：登记会话结束，让界面与监控线程收尾。
#[cfg(target_os = "android")]
pub(crate) fn android_game_finished(code: i32) {
    ANDROID_EXIT.store(code, Ordering::Release);
    if let Some(slot) = GAME.get() {
        if let Ok(state) = slot.lock() {
            if let Some(control) = state.as_ref() {
                control.done.store(true, Ordering::Release);
            }
        }
    }
}

/// 拆参数时要把「选项与取值分开写」的 JVM 参数整体跳过。
///
/// 否则 `--add-opens java.base/java.lang=ALL-UNNAMED` 里的取值会被当成主类名，
/// Forge / NeoForge 的启动参数正是这个形状。
const TWO_TOKEN_JVM_FLAGS: [&str; 6] = [
    "-p", "--module-path", "--add-opens", "--add-exports", "--add-modules", "--patch-module",
];

/// 把 `-cp <类路径> 主类 参数…` 拆成 Android 侧需要的启动规格。
///
/// 主类之后的全部内容都是游戏参数，因此分界点就是第一个不以 `-` 开头的项。
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn android_launch_spec(argv:&[String],run:&Path,log:&Path,java_home:&Path,java_major:u64,java_custom:bool)->Result<Value>{
    let mut jvm=Vec::new();let mut classpath=String::new();let mut heap=2048u64;let mut index=0;
    while index<argv.len(){
        let value=&argv[index];
        if matches!(value.as_str(),"-cp"|"-classpath"|"--class-path"){
            classpath=argv.get(index+1).cloned().ok_or("启动参数缺少类路径")?;index+=2;continue;
        }
        if TWO_TOKEN_JVM_FLAGS.contains(&value.as_str()){
            let taken=argv.get(index+1).ok_or("JVM 参数缺少取值")?;
            jvm.push(value.clone());jvm.push(taken.clone());index+=2;continue;
        }
        if let Some(rest)=value.strip_prefix("-Xmx"){
            let scale=if rest.ends_with(['g','G']){1024}else{1};
            if let Ok(size)=rest.trim_end_matches(['m','M','g','G']).parse::<u64>(){heap=size*scale;}
        }
        jvm.push(value.clone());index+=1;
    }
    if classpath.is_empty(){return Err("启动参数缺少类路径".into());}
    let edge=jvm.iter().position(|value|!value.starts_with('-')).ok_or("启动参数缺少主类")?;
    let mut tail=jvm.split_off(edge);let main=tail.remove(0);
    Ok(json!({
        "classpath":classpath,
        "jvm":jvm,
        "main":main,
        "args":tail,
        "log":log.to_string_lossy(),
        "cwd":run.to_string_lossy(),
        "heap":heap,
        // 运行时目录与主版本由启动前的选择决定：进程内只能建一个 JVM，进了 launch 就不能再改。
        "runtime":java_home.to_string_lossy(),
        "major":java_major,
        "custom":java_custom,
    }))
}

/// Android 的启动：JVM 在本进程内，画面由 `GameHost` 铺开，日志靠尾随文件。
///
/// 与 `start_owned` 的差别在于「进程」换成「线程」：没有 `Child` 可等，也没有标准输出
/// 可读，退出只在主方法返回时才有信号。
#[cfg(target_os = "android")]
fn start_in_process(argv:Vec<String>,run:PathBuf,root:PathBuf,id:String,secrets:Vec<String>,_account:Value,isolation:crate::modpack::InstanceIsolation,ticket:Arc<StartTicket>,app:tauri::AppHandle,java_runtime:crate::android_runtime::Runtime)->Result<Value>{
    check_start_cancel(&ticket)?;
    isolation.verify()?;
    let logs=inside(&root,"launcher-logs")?;make_dir(&logs)?;
    let log_path=inside(&logs,format!("{}-{}-{}.log",id,now_ms(),uuid::Uuid::new_v4()))?;
    File::create(&log_path).map_err(|_|"无法创建游戏日志文件")?;
    let spec=android_launch_spec(&argv,&run,&log_path,&java_runtime.home,java_runtime.major,java_runtime.custom)?;
    emit(&app,json!({"state":"launching"}));
    let pid=std::process::id();
    let control=Arc::new(GameControl::new(pid,ticket.cancel.check().is_err()));
    {let mut slot=GAME.get_or_init(||Mutex::new(None)).lock().map_err(|_|"游戏进程状态不可用")?;if ticket.cancel.check().is_err(){control.stop.store(true,Ordering::Release);}*slot=Some(control.clone());}
    ticket.begin_dispatch()?;
    // 铺开画面必须回到主线程；失败就地把会话收回，不留下「运行中」的假状态。
    stage(&app,"准备游戏画面（切横屏、建 Surface）");
    if let Err(error)=crate::android_host::show_game(&app,serde_json::to_string(&spec).map_err(|_|"启动规格序列化失败")?){
        control.stop.store(true,Ordering::Release);
        complete_game_from(GAME.get_or_init(||Mutex::new(None)),&control,|session|crate::ai_hud::game_stopped(&app,session));
        return Err(error);
    }
    emit(&app,json!({"state":"running","pid":pid}));
    crate::ai_hud::game_started(&app,&control.session);
    let tail=log_path.clone();let monitor=control.clone();let monitor_app=app.clone();
    let spawned=thread::Builder::new().name("hcmcl-android-game".into()).spawn(move||{
        let mut reader=File::open(&tail).ok();let mut pending=String::new();let mut bytes=0usize;let mut suppressed=false;
        // 黑屏最难受的是「不知道在等什么」：进程内 JVM 与图形层起不来时游戏一个字都不输出，
        // 这里在完全没有日志的情况下按时间补提示，而不是让用户对着黑屏猜。
        let mut silent_since=std::time::Instant::now();let mut hints=0u8;
        loop{
            if let Some(file)=reader.as_mut(){
                let mut chunk=Vec::new();
                if file.read_to_end(&mut chunk).is_ok()&&!chunk.is_empty(){
                    pending.push_str(&String::from_utf8_lossy(&chunk));
                    while let Some(cut)=pending.find('\n'){
                        let line=pending[..cut].trim_end_matches('\r').to_string();pending.drain(..=cut);
                        let clean=redact(&line,&secrets);
                        if bytes.saturating_add(clean.len()+1)<=8*1024*1024{
                            bytes=bytes.saturating_add(clean.len()+1);
                            emit(&monitor_app,json!({"log":format!("{clean}\n")}));
                            let _=crate::debug::append_game(&monitor_app,&clean,&secrets);
                        }else if !suppressed{
                            suppressed=true;
                            let notice="[游戏日志达到本次 8 MiB 上限，后续正文未留存]";
                            emit(&monitor_app,json!({"log":format!("{notice}\n")}));
                            let _=crate::debug::append_game(&monitor_app,notice,&secrets);
                        }
                    }
                }
            }
            if monitor.done.load(Ordering::Acquire){break;}
            if bytes==0{
                if hints==0&&silent_since.elapsed()>Duration::from_secs(20){
                    hints=1;let notice="[启动] 游戏尚未输出任何日志，正在等待进程内 JVM 与图形层…\n";
                    emit(&monitor_app,json!({"log":notice}));let _=crate::debug::append_game(&monitor_app,notice,&secrets);
                }else if hints==1&&silent_since.elapsed()>Duration::from_secs(60){
                    hints=2;let notice="[启动] 已等待 60 秒仍无输出：多半卡在 JVM 创建或图形层初始化，可先在游戏内退出后重试\n";
                    emit(&monitor_app,json!({"log":notice}));let _=crate::debug::append_game(&monitor_app,notice,&secrets);
                }
            }
            thread::sleep(Duration::from_millis(150));
        }
        complete_game_from(GAME.get_or_init(||Mutex::new(None)),&monitor,|session|crate::ai_hud::game_stopped(&monitor_app,session));
        emit(&monitor_app,json!({"state":"exited","exitCode":ANDROID_EXIT.load(Ordering::Acquire),"pid":pid}));
    });
    if spawned.is_err(){
        control.stop.store(true,Ordering::Release);
        complete_game_from(GAME.get_or_init(||Mutex::new(None)),&control,|session|crate::ai_hud::game_stopped(&app,session));
        return Err("无法创建游戏日志线程".into());
    }
    Ok(json!({"pid":pid}))
}

async fn launch_stop()->Result<Value>{
    // 进程内 JVM 不能像子进程那样按信号终止：`System.exit` 会把启动器一起带走，
    // 强行 `kill` 则是整个应用消失。这一版明确不支持中途停止。
    if cfg!(target_os = "android") { return Err("Android 版暂不支持中途停止游戏，请使用游戏内的退出按钮".into()); }
    let pending={let mut state=starts().lock().map_err(|_|"启动任务状态不可用")?;state.begin_stop()?};
    let _stopping=StopWaiter{armed:true};
    let wait=async{
        if let Some(ticket)=pending{ticket.wait().await;}
        let control={let slot=GAME.get_or_init(||Mutex::new(None)).lock().map_err(|_|"游戏进程状态不可用")?;if let Some(control)=slot.as_ref(){control.stop.store(true,Ordering::Release);}slot.clone()};
        if let Some(control)=control{while !control.done.load(Ordering::Acquire){tokio::time::sleep(Duration::from_millis(40)).await;}}
        Ok::<_,String>(json!(true))
    };
    tokio::time::timeout(Duration::from_secs(12),wait).await.map_err(|_|"已请求停止，任务或进程仍在收尾；不能确认已停止".to_string())?
}
/// 桥接将缺省的位置参数编码为 null；仅缺省、null 和布尔值属于此合同。
fn manifest_force(args:&[Value])->Result<bool>{
    if args.len()>1{return Err("版本清单 force 参数必须为布尔值".into());}
    match args.first(){None|Some(Value::Null)=>Ok(false),Some(Value::Bool(force))=>Ok(*force),_=>Err("版本清单 force 参数必须为布尔值".into())}
}
/// 根 Tauri IPC 的有限运行时映射；未移植通道返回 None，由宿主给出明确未适配错误。
pub async fn call(channel:&str,args:&[Value],settings:&Value,account:Option<&Value>,app:&tauri::AppHandle)->Result<Option<Value>>{
    let value=match channel{
        "versions:list"=>{let force=manifest_force(args)?;let root=active_root(settings)?;downloads::version_list(force,&root,settings).await?},
        "versions:get"=>{count(args,1)?;let id=string_arg(args,0)?;let root=active_root(settings)?;resolve(id,&root,settings).await?},
        "installed:list"|"installed:listAll"=>{count(args,0)?;let settings=settings.clone();let all=channel=="installed:listAll";tauri::async_runtime::spawn_blocking(move||installed(&settings,all)).await.map_err(|_|"实例扫描后台任务异常")??},
        "java:detect"=>{count(args,0)?;let settings=settings.clone();json!(tauri::async_runtime::spawn_blocking(move||detect_java(&settings)).await.map_err(|_|"Java 检测后台任务异常")??)},
        "java:check"=>{count(args,1)?;let id=string_arg(args,0)?.to_string();
            // Android 使用随 APK 分发、在进程内创建的 bionic JVM，不参与桌面 Java 探测。
            #[cfg(target_os = "android")]
            { let _ = id; return android_java_check(&app).await; }
            // 其它移动端没有可执行的 JRE：直接声明平台不支持，既不解析游戏目录，也不触发安装引导。
            #[cfg(not(target_os = "android"))]
            {
                if !native_game_supported(){return Ok(Some(json!({"required":0,"compatible":false,"available":[],"supported":false})));}
                let version=resolve(&id,&active_root(settings)?,settings).await?;let required=required_java(&version)?;let settings=settings.clone();tauri::async_runtime::spawn_blocking(move||{let available=detect_java(&settings)?;let compatible=choose_java(&settings,&id,&json!({}),required).is_ok();Ok::<_,String>(json!({"required":required,"compatible":compatible,"available":available,"supported":true}))}).await.map_err(|_|"Java 适配检查后台任务异常")??
            }
        },
        // Android 运行时管理：内置 17 之外的 21/25 可以下载，也应该能删——每个约 100 MB。
        "android:runtimes"=>{count(args,0)?;android_runtimes().await?},
        "android:removeRuntime"=>{count(args,1)?;let major=args[0].as_u64().ok_or("Java 主版本必须是数字")?;android_remove_runtime(major).await?},
        "launch:start"=>{count(args,1)?;let request=capture_launch_request()?;launch_start(&args[0],settings,account,app,request).await?},
        "launch:stop"=>{count(args,0)?;launch_stop().await?},
        _=>return Ok(None),
    };Ok(Some(value))
}

#[cfg(test)] mod tests{
    use super::*;
    #[test]
    fn hud_session_tracks_registered_process_completion_and_pid_reuse() {
        let slot=Mutex::new(None);
        assert!(hud_game_session_from(&slot).unwrap().is_none());
        let first=Arc::new(GameControl::new(42,false));
        *slot.lock().unwrap()=Some(first.clone());
        let session=hud_game_session_from(&slot).unwrap().unwrap();
        first.stop.store(true,Ordering::Release);
        assert_eq!(hud_game_session_from(&slot).unwrap(),Some(session.clone()));
        first.done.store(true,Ordering::Release);
        assert!(hud_game_session_from(&slot).unwrap().is_none());
        let replacement=Arc::new(GameControl::new(42,false));
        assert_ne!(replacement.session,session,"复用 PID 仍须拥有不同的后台会话");
        *slot.lock().unwrap()=Some(replacement.clone());
        assert_eq!(hud_game_session_from(&slot).unwrap(),Some(replacement.session.clone()));
    }
    #[test]
    fn game_completion_marks_done_clears_exact_slot_and_releases_lock_before_hud() {
        let control=Arc::new(GameControl::new(42,false));
        let slot=Mutex::new(Some(control.clone()));
        let hud=crate::ai_hud::State::default();
        assert!(crate::ai_hud::fixture::game_started(&hud,&control.session,||hud_game_session_from(&slot)).unwrap());
        assert_eq!(crate::ai_hud::fixture::snapshot(&hud)["active"],true);
        complete_game_from(&slot,&control,|session|{
            assert_eq!(session,control.session);
            assert!(control.done.load(Ordering::Acquire),"HUD 回调前必须先标记真实收尾");
            let current=slot.try_lock().expect("HUD 回调前必须释放 GAME 锁");
            assert!(current.is_none(),"精确 Arc 槽须在 HUD 回调前清理");
            drop(current);
            assert!(crate::ai_hud::fixture::game_stopped(&hud,session,||hud_game_session_from(&slot)).unwrap());
        });
        assert!(hud_game_session_from(&slot).unwrap().is_none());
        assert_eq!(crate::ai_hud::fixture::snapshot(&hud)["active"],false);
    }
    #[test]
    fn late_game_completion_preserves_replacement_even_with_same_pid_and_session_text() {
        let old=Arc::new(GameControl::new(42,false));
        // 相同文本也不能代替 Arc 身份；生产退出逻辑不可用 PID/session 猜测 owner。
        let replacement=Arc::new(GameControl{pid:42,session:old.session.clone(),stop:AtomicBool::new(false),done:AtomicBool::new(false)});
        let slot=Mutex::new(Some(replacement.clone()));
        complete_game_from(&slot,&old,|_|{
            assert!(old.done.load(Ordering::Acquire));
            let current=slot.try_lock().expect("旧退出回调也必须释放 GAME 锁");
            assert!(Arc::ptr_eq(current.as_ref().unwrap(),&replacement));
            assert!(!replacement.done.load(Ordering::Acquire));
        });
        assert_eq!(hud_game_session_from(&slot).unwrap(),Some(replacement.session.clone()));
    }
    #[test]
    fn stale_game_exit_adopts_replacement_and_completed_session_cannot_restart_hud() {
        let old=Arc::new(GameControl::new(42,false));
        let replacement=Arc::new(GameControl::new(42,false));
        let slot=Mutex::new(Some(old.clone()));
        let hud=crate::ai_hud::State::default();
        assert!(crate::ai_hud::fixture::game_started(&hud,&old.session,||hud_game_session_from(&slot)).unwrap());
        let old_chat=crate::ai_hud::fixture::begin(&hud,"old question").unwrap();
        *slot.lock().unwrap()=Some(replacement.clone());
        complete_game_from(&slot,&old,|session|{
            assert!(Arc::ptr_eq(slot.try_lock().unwrap().as_ref().unwrap(),&replacement));
            assert!(crate::ai_hud::fixture::game_stopped(&hud,session,||hud_game_session_from(&slot)).unwrap());
        });
        assert_eq!(crate::ai_hud::fixture::snapshot(&hud)["active"],true);
        assert!(!crate::ai_hud::fixture::finish(&hud,old_chat,Some("old answer")).unwrap());
        assert!(!crate::ai_hud::fixture::game_started(&hud,&old.session,||hud_game_session_from(&slot)).unwrap());
        let live_chat=crate::ai_hud::fixture::begin(&hud,"new question").unwrap();
        assert!(!crate::ai_hud::fixture::game_stopped(&hud,&old.session,||hud_game_session_from(&slot)).unwrap());
        assert!(crate::ai_hud::fixture::finish(&hud,live_chat,None).unwrap(),"旧退出通知不可失效新会话聊天");
        complete_game_from(&slot,&replacement,|session|{
            assert!(crate::ai_hud::fixture::game_stopped(&hud,session,||hud_game_session_from(&slot)).unwrap());
        });
        assert_eq!(crate::ai_hud::fixture::snapshot(&hud)["active"],false);
        assert!(!crate::ai_hud::fixture::game_started(&hud,&replacement.session,||hud_game_session_from(&slot)).unwrap(),"进程收尾后到达的 start 不可复活 HUD");
        assert!(!crate::ai_hud::fixture::finish(&hud,live_chat,Some("late answer")).unwrap());
    }
    #[test]
    fn hud_session_does_not_guess_when_the_process_registry_is_unavailable() {
        let slot=Mutex::new(None);
        let _=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||{
            let _held=slot.lock().unwrap();panic!("夹具模拟进程表异常");
        }));
        assert!(hud_game_session_from(&slot).is_err());
    }
    #[test]
    fn manifest_force_accepts_bridge_null_and_preserves_explicit_booleans(){
        assert!(!manifest_force(&[]).unwrap());
        assert!(!manifest_force(&[Value::Null]).unwrap());
        assert!(!manifest_force(&[json!(false)]).unwrap());
        assert!(manifest_force(&[json!(true)]).unwrap());
        for value in [json!(0),json!(1),json!("false"),json!([]),json!({})]{assert!(manifest_force(&[value]).is_err());}
        assert!(manifest_force(&[Value::Null,json!(true)]).is_err());
    }
    #[test]
    fn relaunch_readiness_rejects_active_stopping_closed_and_unfinished_game_without_signalling() {
        let state=Mutex::new(StartState::default());let game=Mutex::new(None);
        assert!(relaunch_ready_from(&state,||None).is_ok());
        assert!(relaunch_ready_from(&state,||{assert!(state.try_lock().is_err(),"必须先持有启动状态锁再查找游戏表");Some(&game)}).is_ok());
        let ticket=state.lock().unwrap().reserve().unwrap();
        assert!(relaunch_ready_from(&state,||Some(&game)).is_err());assert!(ticket.check().is_ok());
        ticket.done.store(true,Ordering::Release);
        assert!(relaunch_ready_from(&state,||Some(&game)).is_err(),"完成信号不能替代 owner 归还");
        {let mut value=state.lock().unwrap();assert!(value.active.as_ref().is_some_and(|active|Arc::ptr_eq(active,&ticket)));value.active=None;value.stopping=1;}
        assert!(relaunch_ready_from(&state,||Some(&game)).is_err());assert_eq!(state.lock().unwrap().stopping,1);
        {let mut value=state.lock().unwrap();value.stopping=0;value.closed=true;}
        assert!(relaunch_ready_from(&state,||Some(&game)).is_err());assert!(state.lock().unwrap().closed);
        state.lock().unwrap().closed=false;
        let control=Arc::new(GameControl::new(1,false));*game.lock().unwrap()=Some(control.clone());
        assert!(relaunch_ready_from(&state,||Some(&game)).is_err());assert!(!control.stop.load(Ordering::Acquire));
        control.stop.store(true,Ordering::Release);assert!(relaunch_ready_from(&state,||Some(&game)).is_err());
        control.done.store(true,Ordering::Release);assert!(relaunch_ready_from(&state,||Some(&game)).is_ok());
        assert!(game.lock().unwrap().as_ref().is_some_and(|active|Arc::ptr_eq(active,&control)));
    }
    #[test]
    fn relaunch_readiness_fails_closed_for_busy_or_poisoned_runtime_locks() {
        let state=Mutex::new(StartState::default());let game=Mutex::new(None);
        let held=state.lock().unwrap();assert!(relaunch_ready_from(&state,||Some(&game)).is_err());drop(held);
        let held=game.lock().unwrap();assert!(relaunch_ready_from(&state,||Some(&game)).is_err());drop(held);
        let poisoned_state=Mutex::new(StartState::default());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||{let _held=poisoned_state.lock().unwrap();panic!("夹具模拟启动状态损坏");})).is_err());
        assert!(relaunch_ready_from(&poisoned_state,||Some(&game)).is_err());
        let poisoned_game=Mutex::new(None);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||{let _held=poisoned_game.lock().unwrap();panic!("夹具模拟游戏状态损坏");})).is_err());
        assert!(relaunch_ready_from(&state,||Some(&poisoned_game)).is_err());
        assert!(relaunch_ready_from(&state,||Some(&game)).is_ok());
    }
    #[test]
    fn resource_update_lease_blocks_captured_and_new_launch_requests_until_drop() {
        fn assert_send<T: Send>() {} assert_send::<ResourceUpdateLease>();
        let state=Arc::new(Mutex::new(StartState::default()));
        let captured=state.lock().unwrap().capture().unwrap();
        let lease=acquire_resource_update_lease_from(state.clone(),||{
            assert!(state.try_lock().is_err(),"查询 GAME 时必须仍持有启动状态锁");None
        }).unwrap();
        assert!(acquire_resource_update_lease_from(state.clone(),||None).is_err());
        {let mut current=state.lock().unwrap();assert!(current.capture().is_err());assert!(current.reserve_request(captured).is_err());assert!(current.active.is_none());}
        assert!(relaunch_ready_from(&state,||None).is_err());
        drop(lease);
        assert!(relaunch_ready_from(&state,||None).is_ok());
        let ticket=state.lock().unwrap().reserve_request(captured).unwrap();
        state.lock().unwrap().complete(&ticket);
        assert!(state.lock().unwrap().capture().is_ok());
    }
    #[test]
    fn resource_update_lease_rejects_active_stopping_closed_and_unfinished_game() {
        let state=Arc::new(Mutex::new(StartState::default()));let game=Mutex::new(None);
        let ticket=state.lock().unwrap().reserve().unwrap();
        assert!(acquire_resource_update_lease_from(state.clone(),||Some(&game)).is_err());assert!(ticket.check().is_ok());
        ticket.done.store(true,Ordering::Release);
        assert!(acquire_resource_update_lease_from(state.clone(),||Some(&game)).is_err(),"完成信号不能替代启动 owner 归还");
        {let mut current=state.lock().unwrap();current.complete(&ticket);current.begin_stop().unwrap();}
        assert!(acquire_resource_update_lease_from(state.clone(),||Some(&game)).is_err());
        state.lock().unwrap().end_stop();state.lock().unwrap().close();
        assert!(acquire_resource_update_lease_from(state.clone(),||Some(&game)).is_err());
        let state=Arc::new(Mutex::new(StartState::default()));
        let control=Arc::new(GameControl::new(1,false));*game.lock().unwrap()=Some(control.clone());
        assert!(acquire_resource_update_lease_from(state.clone(),||Some(&game)).is_err());assert!(!control.stop.load(Ordering::Acquire));
        control.stop.store(true,Ordering::Release);
        assert!(acquire_resource_update_lease_from(state.clone(),||Some(&game)).is_err(),"发出停止信号不代表游戏已退出");
        control.done.store(true,Ordering::Release);
        let lease=acquire_resource_update_lease_from(state.clone(),||Some(&game)).unwrap();
        assert!(game.lock().unwrap().as_ref().is_some_and(|active|Arc::ptr_eq(active,&control)));drop(lease);
    }
    #[test]
    fn resource_update_lease_fails_closed_for_busy_or_poisoned_locks() {
        let state=Arc::new(Mutex::new(StartState::default()));let game=Mutex::new(None);
        let held=state.lock().unwrap();
        assert!(acquire_resource_update_lease_from(state.clone(),||panic!("启动锁未取得时不可查询 GAME")).is_err());drop(held);
        let held=game.lock().unwrap();assert!(acquire_resource_update_lease_from(state.clone(),||Some(&game)).is_err());drop(held);
        assert!(state.lock().unwrap().update_lease.is_none());
        let poisoned=Arc::new(Mutex::new(StartState::default()));
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||{let _held=poisoned.lock().unwrap();panic!("夹具模拟启动锁损坏");})).is_err());
        assert!(acquire_resource_update_lease_from(poisoned,||Some(&game)).is_err());
        let poisoned_game=Mutex::new(None);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||{let _held=poisoned_game.lock().unwrap();panic!("夹具模拟 GAME 锁损坏");})).is_err());
        assert!(acquire_resource_update_lease_from(state.clone(),||Some(&poisoned_game)).is_err());
        assert!(state.lock().unwrap().update_lease.is_none());
        let lease=acquire_resource_update_lease_from(state.clone(),||Some(&game)).unwrap();let token=lease.token.clone();
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||{let _held=state.lock().unwrap();panic!("夹具模拟租约持有期间锁损坏");})).is_err());
        drop(lease);
        let poisoned=match state.lock(){Err(error)=>error.into_inner(),Ok(_)=>panic!("夹具应保留损坏的启动锁")};assert!(poisoned.update_lease.as_ref().is_some_and(|current|Arc::ptr_eq(current,&token)));
    }
    #[test]
    fn resource_update_lease_stop_close_and_stale_drop_preserve_current_token() {
        let state=Arc::new(Mutex::new(StartState::default()));
        let lease=acquire_resource_update_lease_from(state.clone(),||None).unwrap();let token=lease.token.clone();
        {let mut current=state.lock().unwrap();assert!(current.begin_stop().unwrap().is_none());current.end_stop();current.close();assert!(current.update_lease.as_ref().is_some_and(|active|Arc::ptr_eq(active,&token)));}
        assert!(relaunch_ready_from(&state,||None).is_err());drop(lease);
        {let current=state.lock().unwrap();assert!(current.update_lease.is_none());assert!(current.closed);}
        let state=Arc::new(Mutex::new(StartState::default()));let stale=acquire_resource_update_lease_from(state.clone(),||None).unwrap();
        // 仅夹具替换内部 token，证明旧 owner 的 Drop 不会清掉后来者。
        let replacement=Arc::new(());state.lock().unwrap().update_lease=Some(replacement.clone());drop(stale);
        assert!(state.lock().unwrap().update_lease.as_ref().is_some_and(|current|Arc::ptr_eq(current,&replacement)));
        assert!(state.lock().unwrap().capture().is_err());
    }
    #[test]
    fn resource_update_lease_panic_retains_unknown_ownership() {
        let state=Arc::new(Mutex::new(StartState::default()));let lease=acquire_resource_update_lease_from(state.clone(),||None).unwrap();let token=lease.token.clone();
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(move||{let _lease=lease;panic!("夹具模拟资源写入 owner 异常退出");})).is_err());
        assert!(state.lock().unwrap().update_lease.as_ref().is_some_and(|current|Arc::ptr_eq(current,&token)));
        assert!(acquire_resource_update_lease_from(state.clone(),||None).is_err());assert!(relaunch_ready_from(&state,||None).is_err());
    }
    #[test]
    fn resource_update_lease_and_launch_reservation_serialize_both_winners() {
        let state=Arc::new(Mutex::new(StartState::default()));let worker_state=state.clone();
        let (entered_tx,entered_rx)=mpsc::channel();let (release_tx,release_rx)=mpsc::channel();
        let update=thread::spawn(move||{let _lease=acquire_resource_update_lease_from(worker_state,||None).unwrap();entered_tx.send(()).unwrap();let _=release_rx.recv();});
        entered_rx.recv().unwrap();
        {let mut current=state.lock().unwrap();assert!(current.capture().is_err());assert!(current.reserve().is_err());}
        release_tx.send(()).unwrap();update.join().unwrap();
        let request=state.lock().unwrap().capture().unwrap();let worker_state=state.clone();
        let (entered_tx,entered_rx)=mpsc::channel();let (release_tx,release_rx)=mpsc::channel();
        let launch=thread::spawn(move||{let ticket=worker_state.lock().unwrap().reserve_request(request).unwrap();entered_tx.send(ticket.clone()).unwrap();let _=release_rx.recv();worker_state.lock().unwrap().complete(&ticket);});
        let ticket=entered_rx.recv().unwrap();
        assert!(acquire_resource_update_lease_from(state.clone(),||None).is_err());ticket.stop();
        assert!(acquire_resource_update_lease_from(state.clone(),||None).is_err(),"启动取消后仍须等待 owner 收尾");
        release_tx.send(()).unwrap();launch.join().unwrap();
        let lease=acquire_resource_update_lease_from(state.clone(),||None).unwrap();drop(lease);
        assert!(state.lock().unwrap().capture().is_ok());
    }
    #[test]
    fn launch_recovery_permit_authorizes_only_its_preparing_launch_and_releases_only_the_lease() {
        fn assert_send<T: Send>() {} assert_send::<LaunchRecoveryPermit>();
        let root=TempRoot::new();let state=Arc::new(Mutex::new(StartState::default()));
        let ticket=state.lock().unwrap().reserve().unwrap();
        let permit=LaunchRecoveryPermit::new(&root.0,ticket.clone()).unwrap();
        assert_eq!(permit.root,root.0);assert!(Arc::ptr_eq(&permit.ticket,&ticket));
        assert!(acquire_resource_update_lease_from(state.clone(),||None).is_err(),"普通更新仍然不能借用 active 启动");
        let lease=acquire_launch_recovery_lease_from(&permit,&root.0,state.clone(),||{
            assert!(state.try_lock().is_err(),"GAME 检查与精确启动票据登记必须共用状态锁");None
        }).unwrap();
        assert!(state.lock().unwrap().capture().is_err());assert!(relaunch_ready_from(&state,||None).is_err());
        assert!(acquire_launch_recovery_lease_from(&permit,&root.0,state.clone(),||None).is_err());
        assert!(ticket.check().is_ok());assert!(!ticket.done.load(Ordering::Acquire));
        drop(lease);
        {let current=state.lock().unwrap();assert!(current.update_lease.is_none());assert!(current.active.as_ref().is_some_and(|active|Arc::ptr_eq(active,&ticket)));}
        assert!(acquire_resource_update_lease_from(state.clone(),||None).is_err());
        ticket.begin_dispatch().unwrap();assert!(acquire_launch_recovery_lease_from(&permit,&root.0,state.clone(),||None).is_err());
        state.lock().unwrap().complete(&ticket);assert!(relaunch_ready_from(&state,||None).is_ok());
    }
    #[test]
    fn launch_recovery_permit_binds_the_canonical_root_and_exact_current_ticket() {
        let root=TempRoot::new();let other=TempRoot::new();let state=Arc::new(Mutex::new(StartState::default()));
        let first=state.lock().unwrap().reserve().unwrap();let permit=LaunchRecoveryPermit::new(&root.0,first.clone()).unwrap();
        assert!(LaunchRecoveryPermit::new(&root.0.join("missing"),first.clone()).is_err());
        let file=root.0.join("ordinary-file");fs::write(&file,b"fixture").unwrap();
        assert!(LaunchRecoveryPermit::new(&file,first.clone()).is_err());
        assert!(acquire_launch_recovery_lease_from(&permit,&other.0,state.clone(),||panic!("不同根授权不能读取 GAME")).is_err());
        state.lock().unwrap().complete(&first);
        let second=state.lock().unwrap().reserve().unwrap();
        assert!(acquire_launch_recovery_lease_from(&permit,&root.0,state.clone(),||None).is_err());
        assert!(state.lock().unwrap().active.as_ref().is_some_and(|active|Arc::ptr_eq(active,&second)));
        let current=LaunchRecoveryPermit::new(&root.0,second.clone()).unwrap();
        let lease=acquire_launch_recovery_lease_from(&current,&root.0,state.clone(),||None).unwrap();drop(lease);
        assert!(second.check().is_ok());assert!(!second.uncertain.load(Ordering::Acquire));
        state.lock().unwrap().complete(&second);
    }
    #[test]
    fn launch_recovery_permit_rejects_cancelled_finished_uncertain_and_closed_preparation() {
        let root=TempRoot::new();
        for condition in ["cancelled","cancel_phase","dispatched","done","uncertain","closed","stopping"] {
            let state=Arc::new(Mutex::new(StartState::default()));let ticket=state.lock().unwrap().reserve().unwrap();
            let permit=LaunchRecoveryPermit::new(&root.0,ticket.clone()).unwrap();
            match condition {
                "cancelled"=>ticket.cancel.stop(),
                "cancel_phase"=>ticket.phase.store(1,Ordering::Release),
                "dispatched"=>ticket.begin_dispatch().unwrap(),
                "done"=>ticket.done.store(true,Ordering::Release),
                "uncertain"=>permit.mark_uncertain(),
                "closed"=>state.lock().unwrap().close(),
                "stopping"=>{state.lock().unwrap().begin_stop().unwrap();},
                _=>unreachable!(),
            }
            assert!(acquire_launch_recovery_lease_from(&permit,&root.0,state.clone(),||None).is_err(),"{condition}");
            assert!(state.lock().unwrap().update_lease.is_none(),"{condition}");
        }
        let state=Arc::new(Mutex::new(StartState::default()));let ticket=state.lock().unwrap().reserve().unwrap();
        let permit=LaunchRecoveryPermit::new(&root.0,ticket.clone()).unwrap();
        assert!(acquire_launch_recovery_lease_from(&permit,&root.0,state.clone(),||{ticket.cancel.stop();None}).is_err(),"检查 GAME 期间的取消必须在登记前再次核验");
        assert!(state.lock().unwrap().update_lease.is_none());
        assert!(LaunchRecoveryPermit::new(&root.0,ticket).is_err());
    }
    #[test]
    fn launch_recovery_permit_requires_idle_game_and_available_short_locks() {
        let root=TempRoot::new();let state=Arc::new(Mutex::new(StartState::default()));
        let ticket=state.lock().unwrap().reserve().unwrap();let permit=LaunchRecoveryPermit::new(&root.0,ticket.clone()).unwrap();
        let game=Mutex::new(None);
        let held=state.lock().unwrap();
        assert!(acquire_launch_recovery_lease_from(&permit,&root.0,state.clone(),||panic!("启动锁忙时不能读取 GAME")).is_err());drop(held);
        let held=game.lock().unwrap();assert!(acquire_launch_recovery_lease_from(&permit,&root.0,state.clone(),||Some(&game)).is_err());drop(held);
        let control=Arc::new(GameControl::new(1,false));*game.lock().unwrap()=Some(control.clone());
        assert!(acquire_launch_recovery_lease_from(&permit,&root.0,state.clone(),||Some(&game)).is_err());
        control.stop.store(true,Ordering::Release);
        assert!(acquire_launch_recovery_lease_from(&permit,&root.0,state.clone(),||Some(&game)).is_err(),"停止信号不能替代实际进程退出");
        assert!(ticket.check().is_ok());assert!(!ticket.uncertain.load(Ordering::Acquire));
        control.done.store(true,Ordering::Release);
        let lease=acquire_launch_recovery_lease_from(&permit,&root.0,state.clone(),||Some(&game)).unwrap();drop(lease);
        assert!(state.lock().unwrap().update_lease.is_none());
    }
    #[test]
    fn launch_recovery_permit_uncertainty_marks_only_its_ticket_without_completing_or_cancelling() {
        let root=TempRoot::new();let state=Arc::new(Mutex::new(StartState::default()));
        let ticket=state.lock().unwrap().reserve().unwrap();let permit=LaunchRecoveryPermit::new(&root.0,ticket.clone()).unwrap();
        let lease=acquire_launch_recovery_lease_from(&permit,&root.0,state.clone(),||None).unwrap();let token=lease.token.clone();
        permit.mark_uncertain();permit.mark_uncertain();
        assert!(ticket.uncertain.load(Ordering::Acquire));assert!(ticket.check().is_ok());assert_eq!(ticket.phase.load(Ordering::Acquire),0);assert!(!ticket.done.load(Ordering::Acquire));
        assert!(state.lock().unwrap().update_lease.as_ref().is_some_and(|current|Arc::ptr_eq(current,&token)));
        drop(lease);
        assert!(state.lock().unwrap().active.as_ref().is_some_and(|active|Arc::ptr_eq(active,&ticket)));
        assert!(acquire_launch_recovery_lease_from(&permit,&root.0,state.clone(),||None).is_err());
    }
    #[tokio::test]
    async fn launch_recovery_lease_survives_cancellation_until_the_actual_recovery_owner_returns() {
        struct Release(Option<mpsc::Sender<()>>);
        impl Drop for Release {fn drop(&mut self){if let Some(sender)=self.0.take(){let _=sender.send(());}}}
        let root=TempRoot::new();let state=Arc::new(Mutex::new(StartState::default()));
        let ticket=state.lock().unwrap().reserve().unwrap();let permit=LaunchRecoveryPermit::new(&root.0,ticket.clone()).unwrap();
        let (entered_tx,entered_rx)=tokio::sync::oneshot::channel();let (release_tx,release_rx)=mpsc::channel();let release=Release(Some(release_tx));
        let worker_state=state.clone();let worker_ticket=ticket.clone();let worker_root=root.0.clone();
        let worker=tokio::spawn(async move{
            let finish_state=worker_state.clone();
            let work=async move{
                tokio::task::spawn_blocking(move||{
                    let lease=acquire_launch_recovery_lease_from(&permit,&worker_root,worker_state,||None)?;
                    let _=entered_tx.send(());let _=release_rx.recv();
                    drop(lease);permit.ticket.check()
                }).await.map_err(|_|"夹具恢复线程异常".to_string())?
            };
            retain_start_work(worker_ticket,work,move|ticket|finish_state.lock().unwrap().complete(ticket)).await
        });
        entered_rx.await.unwrap();ticket.stop();
        {let current=state.lock().unwrap();assert!(current.update_lease.is_some());assert!(current.active.as_ref().is_some_and(|active|Arc::ptr_eq(active,&ticket)));}
        assert!(acquire_resource_update_lease_from(state.clone(),||None).is_err());assert!(!ticket.done.load(Ordering::Acquire));
        drop(release);assert!(worker.await.unwrap().is_err());
        assert!(ticket.done.load(Ordering::Acquire));assert!(!ticket.uncertain.load(Ordering::Acquire));
        {let current=state.lock().unwrap();assert!(current.update_lease.is_none());assert!(current.active.is_none());}
        let lease=acquire_resource_update_lease_from(state.clone(),||None).unwrap();drop(lease);
    }
    #[tokio::test]
    async fn first_launch_recovers_real_pending_resource_journal_before_dispatch() {
        use crate::resource_updates::transaction::{self, Change, NewFile, UpdateStage};
        use sha2::Sha512;
        struct Finish(Arc<StartTicket>);
        impl Drop for Finish { fn drop(&mut self) { complete_start(&self.0); } }
        // 这是唯一使用真实全局启动登记的夹具；其它租约夹具均使用局部 StartState。
        // 只执行真实临时目录事务和启动准备授权，不创建游戏进程。
        for committed in [false, true] {
            let temp = TempRoot::new(); let directory = temp.0.join("mods");
            fs::create_dir(&directory).unwrap();
            let bytes = b"fixture resource bytes";
            let initial_guard = crate::install_lock::acquire(&temp.0, || false).await.unwrap();
            let mut stage = UpdateStage::create(&temp.0, &directory, vec![Change::Install { new: NewFile {
                leaf: "dependency.jar".into(), size: bytes.len() as u64,
                sha1: Some(format!("{:x}", Sha1::digest(bytes))), sha512: Some(format!("{:x}", Sha512::digest(bytes))),
            }}], &AtomicBool::new(false)).unwrap();
            let mut output = stage.take_file(0).unwrap(); output.write_all(bytes).unwrap(); drop(output);
            if committed { stage.seal(0, &AtomicBool::new(false)).unwrap(); stage.commit(&AtomicBool::new(false)).unwrap(); }
            drop(stage); drop(initial_guard);
            assert!(transaction::pending_under_guard(&temp.0).unwrap());
            let request = capture_launch_request().unwrap(); let ticket = reserve_start(request).unwrap();
            let _finish = Finish(ticket.clone());
            // 普通更新不能借用启动授权；拒绝本次恢复不改变真实 journal。
            assert!(crate::install_lock::acquire(&temp.0, || false).await.is_err());
            assert!(transaction::pending_under_guard(&temp.0).unwrap());
            let permit = LaunchRecoveryPermit::new(&temp.0, ticket.clone()).unwrap();
            let guard = crate::install_lock::acquire_for_launch(&temp.0, || ticket.cancel.check().is_err(), permit).await.unwrap();
            ticket.check().unwrap();
            assert!(!transaction::pending_under_guard(&temp.0).unwrap());
            assert_eq!(directory.join("dependency.jar").exists(), committed);
            if committed { assert_eq!(fs::read(directory.join("dependency.jar")).unwrap(), bytes); }
            { let state = starts().lock().unwrap(); assert!(state.update_lease.is_none());
                assert!(state.active.as_ref().is_some_and(|active| Arc::ptr_eq(active, &ticket))); }
            ticket.begin_dispatch().unwrap(); drop(guard);
        }
        assert!(relaunch_ready().is_ok());
    }
    #[test]
    fn launch_tickets_serialize_close_and_cancel_before_dispatch() {
        let mut state=StartState::default();let first=state.reserve().unwrap();
        assert!(state.reserve().is_err());first.stop();assert!(first.begin_dispatch().is_err());
        assert!(state.reserve().is_err(),"取消信号不能提前释放仍在收尾的启动");
        state.complete(&first);let second=state.reserve().unwrap();
        state.complete(&first);assert!(state.active.as_ref().is_some_and(|active|Arc::ptr_eq(active,&second)));
        state.close();assert!(second.check().is_err());state.complete(&second);assert!(state.reserve().is_err());
        for _ in 0..32 {
            let ticket=Arc::new(StartTicket::default());let barrier=Arc::new(std::sync::Barrier::new(3));
            let dispatch_ticket=ticket.clone();let dispatch_barrier=barrier.clone();
            let dispatch=thread::spawn(move||{dispatch_barrier.wait();dispatch_ticket.begin_dispatch()});
            let cancel_ticket=ticket.clone();let cancel_barrier=barrier.clone();
            let cancel=thread::spawn(move||{cancel_barrier.wait();cancel_ticket.stop();});
            barrier.wait();let dispatched=dispatch.join().unwrap().is_ok();cancel.join().unwrap();
            assert_eq!(ticket.phase.load(Ordering::Acquire),if dispatched{2}else{1});
            assert!(ticket.check().is_err());assert!(ticket.begin_dispatch().is_err());
        }
    }
    #[test]
    fn launch_close_refuses_a_request_resumed_after_snapshot() {
        let state=Arc::new(Mutex::new(StartState::default()));let (ready,entered)=mpsc::channel();let (resume,resumed)=mpsc::channel();
        let late_state=state.clone();let late=thread::spawn(move||{ready.send(()).unwrap();resumed.recv().unwrap();late_state.lock().unwrap().reserve().is_err()});
        entered.recv().unwrap();state.lock().unwrap().close();resume.send(()).unwrap();assert!(late.join().unwrap());
        let mut stopping=StartState::default();stopping.stopping=1;assert!(stopping.reserve().is_err());stopping.stopping=0;assert!(stopping.reserve().is_ok());
    }
    #[test]
    fn overlapping_stop_requests_keep_the_counter_until_every_waiter_finishes() {
        let mut state=StartState::default();
        let first=state.begin_stop().unwrap();let second=state.begin_stop().unwrap();
        assert!(first.is_none()&&second.is_none());assert_eq!(state.stopping,2);
        assert!(state.capture().is_err());assert!(state.reserve().is_err());
        state.end_stop();assert_eq!(state.stopping,1);assert!(state.capture().is_err());assert!(state.reserve().is_err());
        state.end_stop();assert_eq!(state.stopping,0);assert!(state.capture().is_ok());assert!(state.reserve().is_ok());
    }
    #[tokio::test]
    async fn launch_waiter_drop_signals_but_retains_registration_until_real_blocking_completion() {
        let state=Arc::new(Mutex::new(StartState::default()));let ticket=state.lock().unwrap().reserve().unwrap();
        let (entered_tx,entered_rx)=tokio::sync::oneshot::channel();let (release,released)=mpsc::channel();
        let worker_state=state.clone();let worker_ticket=ticket.clone();
        let worker=tokio::spawn(async move{
            let work=async move{tokio::task::spawn_blocking(move||{let _=entered_tx.send(());released.recv().unwrap();Ok::<_,String>(())}).await.map_err(|_|"测试阻塞任务异常".to_string())?};
            retain_start_work(worker_ticket,work,move|ticket|worker_state.lock().unwrap().complete(ticket)).await
        });
        let (waiting_tx,waiting_rx)=tokio::sync::oneshot::channel();
        let waiter_ticket=ticket.clone();let waiter=tokio::spawn(async move{let _guard=StartWaiter{ticket:waiter_ticket,armed:true};let _=waiting_tx.send(());let _=worker.await;});
        entered_rx.await.unwrap();waiting_rx.await.unwrap();waiter.abort();assert!(waiter.await.unwrap_err().is_cancelled());
        assert!(ticket.check().is_err());assert!(!ticket.done.load(Ordering::Acquire));assert!(state.lock().unwrap().reserve().is_err());
        release.send(()).unwrap();tokio::time::timeout(Duration::from_secs(2),ticket.wait()).await.unwrap();
        assert!(state.lock().unwrap().reserve().is_ok());
    }
    #[tokio::test]
    async fn launch_uncertain_result_does_not_clear_busy_or_signal_completion() {
        let state=Arc::new(Mutex::new(StartState::default()));let ticket=state.lock().unwrap().reserve().unwrap();
        ticket.uncertain.store(true,Ordering::Release);let completed=AtomicBool::new(false);
        assert!(retain_start_work(ticket.clone(),async{Err::<(),String>("结果未知".into())},|_|completed.store(true,Ordering::Release)).await.is_err());
        assert!(!completed.load(Ordering::Acquire));assert!(!ticket.done.load(Ordering::Acquire));assert!(state.lock().unwrap().reserve().is_err());
    }
    #[test]fn paths_and_identifiers_reject_traversal(){for id in ["","..","a/b","a\\b","x:","CON","LPT1.txt","tail."]{assert!(identifier(id).is_err(),"{id}");}assert!(identifier("我的实例-1.20.1").is_ok());}
    #[test]fn inheritance_keeps_parent_arguments_and_base(){let p=json!({"id":"1.20.1","mainClass":"Main","arguments":{"jvm":["-cp","${classpath}"],"game":["--username","${auth_player_name}"]},"libraries":[{"name":"g:a:1"}],"downloads":{"client":{"sha1":"abc"}}});let c=json!({"id":"named","inheritsFrom":"1.20.1","arguments":{"jvm":["-Dloader=true"],"game":[]},"libraries":[{"name":"g:b:1"}]});let m=merge(&p,&c).unwrap();assert_eq!(m["arguments"]["jvm"].as_array().unwrap().len(),3);assert_eq!(m["clientVersion"],"1.20.1");assert_eq!(m["libraries"].as_array().unwrap().len(),2);assert!(m.get("inheritsFrom").is_none());}
    #[test]fn ordered_rules_and_feature_gates(){let features=BTreeMap::from([("is_demo_user".into(),true)]);assert!(rules_allow(Some(&json!([{"action":"allow","features":{"is_demo_user":true}}])),&features).unwrap());assert!(!rules_allow(Some(&json!([{"action":"allow"},{"action":"disallow"}])),&features).unwrap());}
    #[test]fn maven_and_arguments_are_not_shell_commands(){assert_eq!(maven_path("net.test:thing:1:natives-linux",None).unwrap(),PathBuf::from("net/test/thing/1/thing-1-natives-linux.jar"));assert!(maven_path("../:thing:1",None).is_err());let vars=BTreeMap::from([("name".into(),"hello & $(bad) 世界".into())]);assert_eq!(substitute("${name}",&vars).unwrap(),"hello & $(bad) 世界");assert!(substitute("${unknown}",&vars).is_err());}
    #[test]fn java_compatibility_and_redaction(){assert!(suitable(&json!({"major":21}),17));assert!(!suitable(&json!({"major":21}),8));assert_eq!(redact("token=abc-secret",&["abc-secret".into()]),"token=[已脱敏]");assert_eq!(version_type("26.4-snapshot-1"),"snapshot");assert_eq!(version_type("24w14potato"),"aprilfools");}
    // 可控子进程仅运行当前测试程序；不会联网，也不会执行 Java 或真实 installer。
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    fn installer_fixture_args() -> Vec<String> { vec!["--exact".into(), "runtime::tests::installer_fixture_child".into(), "--nocapture".into(), "--test-threads=1".into()] }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    fn installer_fixture(root: &Path, mode: &str) { fs::write(root.join("hcmcl-installer-fixture.json"), serde_json::to_vec(&json!({"mode":mode})).unwrap()).unwrap(); }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    fn fixture_limits(quiet_ms: u64, total_ms: u64) -> InstallerLimits { InstallerLimits { quiet: Duration::from_millis(quiet_ms), total: Duration::from_millis(total_ms) } }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn installer_fixture_child() {
        let root = std::env::current_dir().unwrap(); let path = root.join("hcmcl-installer-fixture.json");
        if !path.is_file() { return; }
        let value: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        match text(&value, "mode") {
            "eof" => { let mut bytes = Vec::new(); std::io::stdin().read_to_end(&mut bytes).unwrap(); assert!(bytes.is_empty()); println!("STDIN_EOF_CONFIRMED"); eprintln!("STDERR_DRAIN_CONFIRMED"); },
            "quiet" => { println!("CHILD_STARTED"); std::io::stdout().flush().unwrap(); thread::sleep(Duration::from_secs(15)); },
            "bytes" => { for _ in 0..12 { print!("x"); std::io::stdout().flush().unwrap(); thread::sleep(Duration::from_millis(200)); } println!("\nBYTE_ACTIVITY_CONFIRMED"); },
            "active" => { for _ in 0..150 { print!("x"); std::io::stdout().flush().unwrap(); thread::sleep(Duration::from_millis(60)); } },
            "failure" => { println!("OUTPUT_BEFORE_FAILURE"); eprintln!("accessToken=FAKE_ONLY_SECRET_DO_NOT_RETURN"); eprintln!("https://name:FAKE_PASSWORD@example.invalid/file?key=FAKE_ONLY_KEY"); std::io::stdout().flush().unwrap(); std::io::stderr().flush().unwrap(); std::process::exit(23); },
            "flood" => { let mut stdout = std::io::stdout(); for _ in 0..20000 { stdout.write_all(b"small-safe-output\n").unwrap(); } stdout.write_all(&vec![b'x'; 40000]).unwrap(); stdout.write_all(b"\nFLOOD_COMPLETE\n").unwrap(); stdout.flush().unwrap(); },
            "tree" => {
                let child_root = root.join("child"); fs::create_dir(&child_root).unwrap(); installer_fixture(&child_root, "heartbeat");
                let mut child = Command::new(std::env::current_exe().unwrap()).args(installer_fixture_args()).current_dir(&child_root).stdin(Stdio::null()).stdout(Stdio::inherit()).stderr(Stdio::inherit()).spawn().unwrap();
                println!("DESCENDANT_STARTED"); std::io::stdout().flush().unwrap(); let _ = child.wait();
            },
            "heartbeat" => { for index in 0..150 { fs::write(root.join("heartbeat"), index.to_string()).unwrap(); thread::sleep(Duration::from_millis(60)); } },
            _ => panic!("未知本地安装器测试模式"),
        }
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn installer_null_stdin_drains_both_pipes_before_success() {
        let temp = TempRoot::new(); installer_fixture(&temp.0, "eof"); let logs = Arc::new(Mutex::new(Vec::new())); let captured = logs.clone();
        let result = run_installer_process(&std::env::current_exe().unwrap(), &installer_fixture_args(), &temp.0, Arc::new(crate::downloads::Cancel::default()), Arc::new(move |line| captured.lock().unwrap().push(line)), fixture_limits(3000, 6000));
        assert!(result.is_ok(), "{result:?}"); let logs = logs.lock().unwrap().join(""); assert!(logs.contains("STDIN_EOF_CONFIRMED")); assert!(logs.contains("STDERR_DRAIN_CONFIRMED"));
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn installer_silent_child_times_out_and_returns_sanitized_tail() {
        let temp = TempRoot::new(); installer_fixture(&temp.0, "quiet"); let started = Instant::now();
        let error = run_installer_process(&std::env::current_exe().unwrap(), &installer_fixture_args(), &temp.0, Arc::new(crate::downloads::Cancel::default()), Arc::new(|_| {}), fixture_limits(1000, 6000)).unwrap_err();
        assert!(error.contains("未产生任何输出字节"), "{error}"); assert!(error.contains("CHILD_STARTED")); assert!(started.elapsed() < Duration::from_secs(8));
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn installer_no_newline_bytes_reset_watchdog_but_total_is_bounded() {
        let temp = TempRoot::new(); installer_fixture(&temp.0, "bytes");
        assert!(run_installer_process(&std::env::current_exe().unwrap(), &installer_fixture_args(), &temp.0, Arc::new(crate::downloads::Cancel::default()), Arc::new(|_| {}), fixture_limits(1200, 7000)).is_ok());
        installer_fixture(&temp.0, "active"); let started = Instant::now();
        let error = run_installer_process(&std::env::current_exe().unwrap(), &installer_fixture_args(), &temp.0, Arc::new(crate::downloads::Cancel::default()), Arc::new(|_| {}), fixture_limits(1500, 2000)).unwrap_err();
        assert!(error.contains("总执行时限"), "{error}"); assert!(started.elapsed() < Duration::from_secs(8));
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn installer_cancel_waits_for_process_tree_and_drain() {
        let temp = TempRoot::new(); installer_fixture(&temp.0, "tree"); let cancel = Arc::new(crate::downloads::Cancel::default()); let stopped = cancel.clone(); let heartbeat = temp.0.join("child/heartbeat"); let watched = heartbeat.clone();
        let stopper = thread::spawn(move || { let start = Instant::now(); while !watched.is_file() && start.elapsed() < Duration::from_secs(4) { thread::sleep(Duration::from_millis(20)); } stopped.stop(); });
        let result = run_installer_process(&std::env::current_exe().unwrap(), &installer_fixture_args(), &temp.0, cancel, Arc::new(|_| {}), fixture_limits(3000, 7000)); stopper.join().unwrap();
        assert!(result.unwrap_err().contains("已取消")); assert!(heartbeat.is_file(), "测试子进程尚未产生心跳");
        let before = fs::read(&heartbeat).unwrap(); thread::sleep(Duration::from_millis(240)); assert_eq!(fs::read(&heartbeat).unwrap(), before, "runner 返回后归属后代仍在运行");
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn installer_failure_tail_and_logs_never_return_fixture_secrets() {
        let temp = TempRoot::new(); installer_fixture(&temp.0, "failure"); let logs = Arc::new(Mutex::new(String::new())); let captured = logs.clone();
        let error = run_installer_process(&std::env::current_exe().unwrap(), &installer_fixture_args(), &temp.0, Arc::new(crate::downloads::Cancel::default()), Arc::new(move |line| captured.lock().unwrap().push_str(&line)), fixture_limits(3000, 6000)).unwrap_err();
        assert!(error.contains("23")); assert!(error.contains("OUTPUT_BEFORE_FAILURE"));
        for secret in ["FAKE_ONLY_SECRET_DO_NOT_RETURN", "FAKE_PASSWORD", "FAKE_ONLY_KEY", "name:"] { assert!(!error.contains(secret)); assert!(!logs.lock().unwrap().contains(secret)); }
        assert!(error.len() < INSTALLER_TAIL + 1024);
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn installer_flood_is_bounded_and_callback_panic_still_reaps() {
        let temp = TempRoot::new(); installer_fixture(&temp.0, "flood"); let logs = Arc::new(Mutex::new(Vec::new())); let captured = logs.clone();
        assert!(run_installer_process(&std::env::current_exe().unwrap(), &installer_fixture_args(), &temp.0, Arc::new(crate::downloads::Cancel::default()), Arc::new(move |line| captured.lock().unwrap().push((Instant::now(), line))), fixture_limits(3000, 10000)).is_ok());
        let logs = logs.lock().unwrap(); assert!(logs.iter().map(|(_, line)| line.len()).sum::<usize>() <= INSTALLER_LOG_LIMIT + 256); assert!(logs.windows(2).all(|pair| pair[1].0.duration_since(pair[0].0) >= Duration::from_millis(90))); drop(logs);
        installer_fixture(&temp.0, "quiet"); let started = Instant::now();
        let error = run_installer_process(&std::env::current_exe().unwrap(), &installer_fixture_args(), &temp.0, Arc::new(crate::downloads::Cancel::default()), Arc::new(|_| panic!("本地日志接收器测试故障")), fixture_limits(3000, 6000)).unwrap_err();
        assert!(error.contains("日志接收器异常")); assert!(started.elapsed() < Duration::from_secs(8));
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn installer_ipc_drop_signals_but_worker_owns_staging_until_reaped() {
        struct Signal(Arc<crate::downloads::Cancel>); impl Drop for Signal { fn drop(&mut self) { self.0.stop(); } }
        let temp = TempRoot::new(); installer_fixture(&temp.0, "tree"); let heartbeat = temp.0.join("child/heartbeat");
        let cancel = Arc::new(crate::downloads::Cancel::default()); let worker_cancel = cancel.clone(); let root = temp.0.clone();
        let (completed, finished) = tokio::sync::oneshot::channel();
        let worker = tokio::task::spawn_blocking(move || { let result = run_installer_process(&std::env::current_exe().unwrap(), &installer_fixture_args(), &root, worker_cancel, Arc::new(|_| {}), fixture_limits(4000, 10000)); let _ = completed.send(result); });
        let (started, entered) = tokio::sync::oneshot::channel();
        let waiter_cancel = cancel.clone(); let waiter = tokio::spawn(async move { let _signal = Signal(waiter_cancel); let _ = started.send(()); std::future::pending::<()>().await; });
        entered.await.unwrap(); let start = Instant::now();
        while !heartbeat.is_file() && start.elapsed() < Duration::from_secs(5) { tokio::time::sleep(Duration::from_millis(20)).await; }
        waiter.abort(); let _ = waiter.await;
        let result = tokio::time::timeout(Duration::from_secs(8), finished).await;
        // 即使等待断言超时，也先发取消并 join 真正拥有进程的 worker，不能让失败夹具脱离后台清理 staging。
        cancel.stop(); let joined = worker.await; joined.unwrap(); let result = result.unwrap().unwrap();
        assert!(result.unwrap_err().contains("已取消")); assert!(heartbeat.is_file());
        let before = fs::read(&heartbeat).unwrap(); tokio::time::sleep(Duration::from_millis(240)).await; assert_eq!(fs::read(&heartbeat).unwrap(), before);
        // 等真实 worker 回收后才让 TempRoot 删除 staging；丢弃 IPC 等待者本身不删除工作目录。
    }
    #[test]
    fn installer_output_bounds_and_redacts_before_enqueue() {
        let mut state = InstallerOutput::new(); for _ in 0..10000 { state.line(b"safe status", false); }
        state.line(b"authorization: Bearer FAKE_ONLY_SECRET", false); state.line(b"open https://user:FAKE_PASSWORD@example.invalid?key=FAKE_KEY", false); state.line(&vec![b'x'; INSTALLER_LINE], true);
        assert!(state.tail.len() <= 64 && state.tail_bytes <= INSTALLER_TAIL); assert!(state.pending.len() <= 32 && state.pending_bytes <= 16 * 1024);
        let tail = state.tail(); assert!(!tail.contains("FAKE_ONLY_SECRET") && !tail.contains("FAKE_PASSWORD") && !tail.contains("FAKE_KEY")); assert!(tail.contains("过长日志行"));
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn installer_paths_fix_argv_and_reject_foreign_jar_before_spawn() {
        let temp = TempRoot::new(); let java = std::env::current_exe().unwrap(); let jar = temp.0.join("installer.jar"); fs::write(&jar, b"PK\x03\x04FAKE_NOT_A_REAL_INSTALLER").unwrap();
        let (_, args, cwd) = installer_paths(&java, &jar, &temp.0).unwrap(); assert_eq!(cwd, temp.0); assert_eq!(args, vec!["-jar".to_string(), jar.to_str().unwrap().into(), "--installClient".into(), temp.0.to_str().unwrap().into()]);
        let other = temp.0.join("foreign.jar"); fs::write(&other, b"PK\x03\x04FAKE").unwrap(); assert!(installer_paths(&java, &other, &temp.0).is_err()); fs::write(&jar, b"notjar").unwrap(); assert!(installer_paths(&java, &jar, &temp.0).is_err());
        let cancel = Arc::new(crate::downloads::Cancel::default()); cancel.stop(); assert!(run_installer(&java, &jar, &temp.0, cancel, Arc::new(|_| {})).is_err()); assert!(pick_installer_java(&json!({}), "target", 7).is_err());
        assert!(probe_java(&java).is_none(), "非 Java 测试程序退出非零，不能因为存在输出就当作成功探测");
    }
    #[cfg(all(unix, not(any(target_os = "android", target_os = "ios"))))]
    #[test]
    fn installer_java_pick_probes_version_and_enforces_exact_java8() {
        use std::os::unix::fs::PermissionsExt;
        let temp = TempRoot::new(); let java = temp.0.join("controlled-java");
        fs::write(&java, b"#!/bin/sh\nprintf 'openjdk version \"17.0.1\"\\nOpenJDK 64-Bit Server VM\\n' >&2\nexit 0\n").unwrap(); fs::set_permissions(&java, fs::Permissions::from_mode(0o700)).unwrap();
        let settings = json!({"gameDirAbs":temp.0,"javaAutoDetect":false,"javaPath":java});
        assert_eq!(pick_installer_java(&settings, "target", 17).unwrap(), java); assert!(pick_installer_java(&settings, "target", 8).is_err());
        fs::write(&java, b"#!/bin/sh\nprintf 'openjdk version \"17.0.1\"\\n' >&2\nexit 9\n").unwrap(); assert!(pick_installer_java(&settings, "target", 17).is_err());
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    #[test]
    fn installer_mobile_rejects_before_paths_or_spawn() {
        // 移动端的拒绝必须发生在任何路径/进程动作之前，并说明内置运行时的既有能力。
        assert!(pick_installer_java(&json!({}), "target", 17).unwrap_err().contains("内置 Java"));
        assert!(run_installer(Path::new("not-a-path"), Path::new("not-a-jar"), Path::new("not-a-directory"), Arc::new(crate::downloads::Cancel::default()), Arc::new(|_| {})).unwrap_err().contains("内置 Java"));
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn desktop_platform_reports_game_runtime_supported() {
        assert!(native_game_supported(), "桌面平台必须具备游戏运行时能力");
        // 移动端兜底文案必须指向可执行的动作，否则用户无法据此采取行动。
        assert!(MOBILE_RUNTIME_BOUNDARY.contains("桌面版"));
        assert!(MOBILE_JAVA_BOUNDARY.contains("内置 Java"));
        // Android 已有随包的 JVM 与图形层，只有 iOS 仍然被平台边界挡住。
        assert!(launch_supported());
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn android_launch_spec_splits_classpath_main_and_args() {
        // 主类之前全是 JVM 参数；`--add-opens` 这类「选项与取值分开写」的形状不能被误判成主类。
        let argv: Vec<String> = [
            "-Xmx2G", "-Djava.library.path=/native", "--add-opens", "java.base/java.lang=ALL-UNNAMED",
            "-cp", "/a.jar:/b.jar", "net.minecraft.client.main.Main", "--username", "Steve",
        ].iter().map(|value| (*value).to_string()).collect();
        let spec = android_launch_spec(&argv, Path::new("/run"), Path::new("/log.txt"), Path::new("/jre"), 21, true).expect("解析启动参数");
        assert_eq!(spec["main"].as_str(), Some("net.minecraft.client.main.Main"));
        assert_eq!(spec["classpath"].as_str(), Some("/a.jar:/b.jar"));
        assert_eq!(spec["heap"].as_u64(), Some(2048));
        // 运行时选择随 spec 一起下发：进了 launch 就不能再换 JVM。
        assert_eq!(spec["runtime"].as_str(), Some("/jre"));
        assert_eq!(spec["major"].as_u64(), Some(21));
        assert_eq!(spec["custom"].as_bool(), Some(true));
        let args: Vec<&str> = spec["args"].as_array().expect("游戏参数").iter().filter_map(Value::as_str).collect();
        assert_eq!(args, vec!["--username", "Steve"]);
        let jvm: Vec<&str> = spec["jvm"].as_array().expect("JVM 参数").iter().filter_map(Value::as_str).collect();
        assert!(jvm.contains(&"--add-opens"));
        assert!(jvm.contains(&"java.base/java.lang=ALL-UNNAMED"));
        assert!(!jvm.iter().any(|value| value.starts_with("-cp")));
    }
    struct TempRoot(PathBuf);
    impl TempRoot{fn new()->Self{let p=std::env::temp_dir().join(format!("hcmcl-runtime-{}",uuid::Uuid::new_v4()));fs::create_dir_all(&p).unwrap();Self(fs::canonicalize(p).unwrap())}}
    impl Drop for TempRoot{fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}
    fn write_version(root:&Path,id:&str,v:&Value){let p=version_path(root,id).unwrap();make_dir(p.parent().unwrap()).unwrap();fs::write(p,serde_json::to_vec(v).unwrap()).unwrap();}
    fn native_zip(path:&Path,name:&str,body:&[u8]){let f=File::create(path).unwrap();let mut zip=zip::ZipWriter::new(f);zip.start_file(name,zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored)).unwrap();zip.write_all(body).unwrap();zip.finish().unwrap();}
    #[test]
    fn java_cache_drops_stale_scan_after_installation_invalidation() {
        let cache = Mutex::new(None);
        let generation = AtomicUsize::new(0);
        publish_java_cache(&cache, &generation, 0, "same-roots".into(), &[json!({"path":"old-java"})]).unwrap();
        assert_eq!(cache.lock().unwrap().as_ref().unwrap().list[0]["path"], "old-java");
        let (started, entered) = mpsc::channel();
        let (release, released) = mpsc::channel();
        thread::scope(|scope| {
            let cache_ref = &cache;
            let generation_ref = &generation;
            let blocked = scope.spawn(move || {
                started.send(()).unwrap();
                released.recv().unwrap();
                publish_java_cache(cache_ref, generation_ref, 0, "same-roots".into(), &[json!({"path":"stale-scan"})]).unwrap();
            });
            entered.recv().unwrap();
            generation.fetch_add(1, Ordering::AcqRel);
            *cache.lock().unwrap() = None;
            publish_java_cache(&cache, &generation, 1, "same-roots".into(), &[json!({"path":"installed-java"})]).unwrap();
            release.send(()).unwrap();
            blocked.join().unwrap();
        });
        let actual = cache.lock().unwrap();
        assert_eq!(actual.as_ref().unwrap().generation, 1);
        assert_eq!(actual.as_ref().unwrap().list[0]["path"], "installed-java");
    }
    #[test]
    fn legacy_resource_mapping_uses_the_actual_instance_directory() {
        let temp = TempRoot::new();
        let run = temp.0.join("versions/isolated");
        let bytes = b"instance-owned legacy resource";
        let hash = format!("{:x}", Sha1::digest(bytes));
        let object = temp.0.join("assets/objects").join(&hash[..2]).join(&hash);
        make_dir(object.parent().unwrap()).unwrap();
        fs::write(&object, bytes).unwrap();
        let mapped = run.join("resources/sounds/test.ogg");
        make_dir(mapped.parent().unwrap()).unwrap();
        fs::write(&mapped, bytes).unwrap();
        let index = json!({"map_to_resources":true,"objects":{"sounds/test.ogg":{"hash":hash,"size":bytes.len()}}});
        let encoded = serde_json::to_vec(&index).unwrap();
        let index_path = temp.0.join("assets/indexes/legacy.json");
        make_dir(index_path.parent().unwrap()).unwrap();
        fs::write(&index_path, &encoded).unwrap();
        let version = json!({"assetIndex":{"sha1":format!("{:x}", Sha1::digest(&encoded)),"size":encoded.len()}});
        validate_assets(&version, &temp.0, &run, "legacy").unwrap();
        assert!(!temp.0.join("resources").exists());
        let shared = temp.0.join("resources/sounds/test.ogg");
        make_dir(shared.parent().unwrap()).unwrap();
        fs::write(&shared, bytes).unwrap();
        fs::write(&mapped, b"corrupt").unwrap();
        assert!(validate_assets(&version, &temp.0, &run, "legacy").is_err());
        validate_assets(&version, &temp.0, &temp.0, "legacy").unwrap();
        let virtual_path = temp.0.join("assets/virtual/legacy/sounds/test.ogg");
        make_dir(virtual_path.parent().unwrap()).unwrap();
        fs::write(&virtual_path, bytes).unwrap();
        let virtual_index = json!({"virtual":true,"objects":{"sounds/test.ogg":{"hash":hash,"size":bytes.len()}}});
        let encoded = serde_json::to_vec(&virtual_index).unwrap();
        fs::write(&index_path, &encoded).unwrap();
        let version = json!({"assetIndex":{"sha1":format!("{:x}", Sha1::digest(&encoded)),"size":encoded.len()}});
        validate_assets(&version, &temp.0, &run, "legacy").unwrap();
    }
    #[test]fn natives_cache_recovers_corruption_and_rolls_back_failure(){let temp=TempRoot::new();let jar=temp.0.join("native.jar");native_zip(&jar,"native/test.bin",b"original");let archive=NativeArchive{path:jar.clone(),excludes:vec![]};let target=extract_natives(&temp.0,"sample",&[archive.clone()]).unwrap();assert_eq!(fs::read(target.join("native/test.bin")).unwrap(),b"original");fs::write(target.join("native/test.bin"),b"corrupt").unwrap();fs::write(target.join("stale.bin"),b"stale").unwrap();extract_natives(&temp.0,"sample",&[archive.clone()]).unwrap();assert_eq!(fs::read(target.join("native/test.bin")).unwrap(),b"original");assert!(!target.join("stale.bin").exists());native_zip(&jar,"../escape.bin",b"bad");assert!(extract_natives(&temp.0,"sample",&[archive]).is_err());assert_eq!(fs::read(target.join("native/test.bin")).unwrap(),b"original");assert!(!temp.0.join("escape.bin").exists());}
    #[tokio::test]async fn local_resolver_merges_and_detects_cycles_without_network(){let temp=TempRoot::new();let settings=json!({"gameDirAbs":temp.0,"mode":"local"});write_version(&temp.0,"base",&json!({"id":"base","mainClass":"Main","minecraftArguments":"--username ${auth_player_name}","libraries":[]}));write_version(&temp.0,"child",&json!({"id":"child","inheritsFrom":"base","arguments":{"jvm":["-Dloader=true"],"game":["--loader"]}}));let merged=resolve("child",&temp.0,&settings).await.unwrap();assert_eq!(merged["clientVersion"],"base");assert_eq!(merged["arguments"]["game"][0],"--username");assert!(resolve("absent-local-fixture",&temp.0,&settings).await.is_err());write_version(&temp.0,"cycleA",&json!({"id":"cycleA","inheritsFrom":"cycleB"}));write_version(&temp.0,"cycleB",&json!({"id":"cycleB","inheritsFrom":"cycleA"}));assert!(resolve("cycleA",&temp.0,&settings).await.is_err());}
    #[test]
    fn raw_and_gzip_server_lists_have_same_contract() {
        let temp = TempRoot::new();
        write_version(&temp.0, "fixture", &json!({"id": "fixture"}));
        let settings = json!({"gameDirAbs": temp.0});
        let path = temp.0.join("servers.dat");
        let read = || installed(&settings, false).unwrap()[0]["servers"].clone();
        assert_eq!(read(), json!([]));
        assert!(!path.exists());

        let mut raw = b"\x0a\0\0\x09\0\x07servers\x0a\0\0\0\x03".to_vec();
        // 旧写入的标准 UTF-8 与 Java MUTF-8 字符串可出现在同一个列表中。
        raw.extend_from_slice(b"\x08\0\x04name\0\x04\xf0\x9f\x98\x80\x08\0\x02ip\0\x09localhost\x01\0\x06hidden\x01\0");
        raw.extend_from_slice(b"\x08\0\x04name\0\x08\xc0\x80\xed\xa0\xbd\xed\xb8\x80\x08\0\x02ip\0\x09localhost\0");
        raw.extend_from_slice(b"\x08\0\x04name\0\x01X\x08\0\x02ip\0\0\0\0");
        let expected = json!([{"name": "😀", "address": "localhost"}, {"name": "\0😀", "address": "localhost"}]);
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&raw).unwrap();
        let gzip = encoder.finish().unwrap();
        for bytes in [&raw, &gzip] {
            fs::write(&path, bytes).unwrap();
            assert_eq!(read(), expected);
            assert_eq!(fs::read(&path).unwrap().as_slice(), bytes.as_slice());
        }
        // 尾随数据和损坏的 gzip 均不输出部分结果，也不修写原文件。
        raw.push(0);
        let mut invalid_gzip = gzip;
        let crc = invalid_gzip.len() - 8;
        invalid_gzip[crc] ^= 0xff;
        for bytes in [raw, invalid_gzip] {
            fs::write(&path, &bytes).unwrap();
            assert_eq!(read(), json!([]));
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
    }

}

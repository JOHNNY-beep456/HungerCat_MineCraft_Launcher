//! 本地资源证据扫描。只读、有限额，不取得安装锁，也不创建目录。
use super::{
    access::{Directory, DirectoryMark, Source},
    model::{LocalQuery, ResourceKind},
    Result,
};
use serde_json::Value;
use sha1::Sha1;
use sha2::{Digest, Sha512};
use std::{
    collections::BTreeSet,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

const MAX_FILES: usize = 4096;
const MAX_DEPTH: usize = 32;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_PROFILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PROFILES_BYTES: u64 = 128 * 1024 * 1024;
// 真实大型模组的压缩包条目远超 4096（机械动力：汽鸣铁道 24k+、机械动力 13k+），
// 上限取 64k；单项/展开大小/元数据限额仍然生效，实际只读元数据一项。
const MAX_ZIP_ENTRIES: usize = 65536;
const MAX_ZIP_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ZIP_BYTES: u64 = 128 * 1024 * 1024;
const MAX_METADATA_BYTES: u64 = 4 * 1024 * 1024;
const CHUNK: usize = 64 * 1024;

fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Acquire) { Err("资源扫描已取消".into()) } else { Ok(()) }
}

// 分块读取配置和压缩包元数据，在每次实际读取前后响应取消。
// JSON/TOML 解析仍是有大小上限的同步操作，解析完成后再次检查取消。
fn read_bounded(reader: &mut impl Read, limit: u64, cancel: &AtomicBool) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; CHUNK];
    loop {
        cancelled(cancel)?;
        let remaining = limit.saturating_sub(bytes.len() as u64);
        let capacity = remaining.saturating_add(1).min(CHUNK as u64) as usize;
        let count = reader.read(&mut buffer[..capacity]).map_err(|_| "读取本地资源证据失败")?;
        cancelled(cancel)?;
        if count == 0 { return Ok(bytes); }
        if count as u64 > remaining { return Err("本地资源证据超过大小上限".into()); }
        bytes.extend_from_slice(&buffer[..count]);
    }
}

fn resource_budget(total: u64, size: u64) -> Result<u64> {
    if size > MAX_FILE_BYTES { return Err("资源文件超过大小上限".into()); }
    let next = total.checked_add(size).ok_or("资源总大小溢出")?;
    if next > MAX_TOTAL_BYTES { return Err("资源总大小超过上限".into()); }
    Ok(next)
}

fn safe_name(name: &str) -> Result<()> {
    super::access::leaf(name).map(|_| ())
}

fn lower_ext(name: &str) -> Option<&str> {
    name.rsplit_once('.').map(|(_, ext)| ext)
}

fn enabled_name(name: &str) -> (&str, bool) {
    name.strip_suffix(".disabled").map_or((name, true), |v| (v, false))
}

#[derive(Clone, Debug)]
struct Hashes {
    size: u64,
    sha1: String,
    sha512: String,
    fingerprint: u32,
}

struct Murmur2 {
    hash: u32,
    tail: [u8; 4],
    tail_len: usize,
}
impl Murmur2 {
    fn new(filtered_len: u32) -> Self { Self { hash: 1 ^ filtered_len, tail: [0; 4], tail_len: 0 } }
    fn block(&mut self, bytes: &[u8]) {
        let mut k = u32::from_le_bytes(bytes.try_into().expect("murmur block"));
        k = k.wrapping_mul(0x5bd1e995);
        k ^= k >> 24;
        k = k.wrapping_mul(0x5bd1e995);
        self.hash = self.hash.wrapping_mul(0x5bd1e995) ^ k;
    }
    fn update(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            if matches!(byte, 9 | 10 | 13 | 32) { continue; }
            self.tail[self.tail_len] = byte;
            self.tail_len += 1;
            if self.tail_len == 4 {
                let block = self.tail;
                self.block(&block);
                self.tail_len = 0;
            }
        }
    }
    fn finish(mut self) -> u32 {
        if self.tail_len == 3 { self.hash ^= (self.tail[2] as u32) << 16; }
        if self.tail_len >= 2 { self.hash ^= (self.tail[1] as u32) << 8; }
        if self.tail_len >= 1 { self.hash ^= self.tail[0] as u32; self.hash = self.hash.wrapping_mul(0x5bd1e995); }
        self.hash ^= self.hash >> 13;
        self.hash = self.hash.wrapping_mul(0x5bd1e995);
        self.hash ^ (self.hash >> 15)
    }
}

fn digest_file(file: &mut File, cancel: &AtomicBool, expected_size: Option<u64>) -> Result<(u64, String, String, u64)> {
    file.seek(SeekFrom::Start(0)).map_err(|_| "无法定位资源文件")?;
    let mut sha1 = Sha1::new();
    let mut sha512 = Sha512::new();
    let mut filtered_len = 0u64;
    let mut size = 0u64;
    let mut buf = [0u8; CHUNK];
    loop {
        cancelled(cancel)?;
        let read = file.read(&mut buf).map_err(|_| "读取资源文件失败")?;
        if read == 0 { break; }
        size = size.checked_add(read as u64).ok_or("资源文件大小溢出")?;
        if size > MAX_FILE_BYTES || expected_size.is_some_and(|expected| size > expected) { return Err("资源文件超过大小上限".into()); }
        sha1.update(&buf[..read]);
        sha512.update(&buf[..read]);
        filtered_len = filtered_len.checked_add(buf[..read].iter().filter(|byte| !matches!(**byte, 9 | 10 | 13 | 32)).count() as u64).ok_or("资源指纹大小溢出")?;
    }
    if expected_size.is_some_and(|expected| expected != size) { return Err("资源文件大小在扫描期间改变".into()); }
    if filtered_len > u32::MAX as u64 { return Err("资源指纹输入超过上限".into()); }
    Ok((size, format!("{:x}", sha1.finalize()), format!("{:x}", sha512.finalize()), filtered_len))
}

fn murmur_file(file: &mut File, cancel: &AtomicBool, expected_size: u64, filtered_len: u32) -> Result<u32> {
    file.seek(SeekFrom::Start(0)).map_err(|_| "无法重新定位资源文件")?;
    let mut murmur = Murmur2::new(filtered_len);
    let mut size = 0u64;
    let mut actual_filtered = 0u64;
    let mut buf = [0u8; CHUNK];
    loop {
        cancelled(cancel)?;
        let read = file.read(&mut buf).map_err(|_| "读取资源文件失败")?;
        if read == 0 { break; }
        size = size.checked_add(read as u64).ok_or("资源文件大小溢出")?;
        if size > expected_size { return Err("资源文件大小在指纹计算期间改变".into()); }
        actual_filtered = actual_filtered.checked_add(buf[..read].iter().filter(|byte| !matches!(**byte, 9 | 10 | 13 | 32)).count() as u64).ok_or("资源指纹大小溢出")?;
        murmur.update(&buf[..read]);
    }
    if size != expected_size || actual_filtered != filtered_len as u64 { return Err("资源文件大小在指纹计算期间改变".into()); }
    Ok(murmur.finish())
}

fn hash_source(source: &Source, cancel: &AtomicBool, expected_size: Option<u64>) -> Result<Hashes> {
    let mut opened = source.open()?;
    let (size, sha1, sha512, filtered_len) = digest_file(&mut opened.file, cancel, expected_size)?;
    opened.verify()?;
    let fingerprint = murmur_file(&mut opened.file, cancel, size, filtered_len as u32)?;
    opened.verify()?;
    Ok(Hashes { size, sha1, sha512, fingerprint })
}

#[derive(Clone)]
struct DirectoryEvidence {
    parent: DirectoryMark,
    name: String,
    present: bool,
    directory: Option<Directory>,
    names: Vec<String>,
}
impl DirectoryEvidence {
    fn verify(&self, cancel: &AtomicBool) -> Result<()> {
        cancelled(cancel)?;
        let parent = self.parent.open()?;
        let current = parent.child(&self.name)?;
        match (self.present, current) {
            (false, None) => {}
            (false, Some(_)) => return Err("资源目录在扫描期间出现".into()),
            (true, Some(node)) => {
                let directory = parent.directory(node)?;
                let old = self.directory.as_ref().ok_or("资源目录证据缺失")?;
                old.verify()?;
                if old.path() != directory.path() { return Err("资源目录证据已改变".into()); }
                let mut budget = MAX_FILES;
                if directory.names(&mut budget)? != self.names { return Err("资源目录成员在扫描期间改变".into()); }
                directory.verify()?;
            }
            (true, None) => return Err("资源目录在扫描期间消失".into()),
        }
        Ok(())
    }
}

#[derive(Clone)]
struct ProfileEvidence { source: Source, size: u64, sha512: String, runtimes: BTreeSet<String> }

pub(super) struct LocalItem {
    pub(super) query: LocalQuery,
    source: Source,
    hashes: Hashes,
}
impl LocalItem {
    pub(super) fn verify(&self, cancel: &AtomicBool) -> Result<()> {
        let hashes = hash_source(&self.source, cancel, Some(self.query.size))?;
        if hashes.size != self.hashes.size || hashes.sha1 != self.query.sha1 || hashes.sha512 != self.query.sha512
            || hashes.fingerprint != self.query.fingerprint {
            return Err("本地资源文件校验值已改变".into());
        }
        Ok(())
    }
}

pub(super) struct Inventory {
    pub(super) items: Vec<LocalItem>,
    root: Directory,
    root_path: PathBuf,
    id: String,
    isolation: crate::modpack::InstanceIsolation,
    directories: Vec<DirectoryEvidence>,
    profiles: Vec<ProfileEvidence>,
    settings_isolated: bool,
    mc_version: String,
    loader: Option<String>,
    shader_runtimes: BTreeSet<String>,
    profile_runtimes: BTreeSet<String>,
}
impl Inventory {
    /// 事件前的轻量上下文复核；资源文件摘要留给对应 LocalItem::verify。
    pub(super) fn verify_context(&self, settings: &Value, cancel: &AtomicBool) -> Result<()> {
        cancelled(cancel)?;
        self.root.verify()?;
        let current = crate::modpack::instance_isolation(&self.root_path, &self.id, settings)?;
        if current.isolated != self.settings_isolated || current.isolated != self.isolation.isolated {
            return Err("资源扫描的隔离设置已改变".into());
        }
        self.isolation.verify()?;
        for directory in &self.directories { directory.verify(cancel)?; }
        let mut profile_runtimes = BTreeSet::new();
        for profile in &self.profiles {
            cancelled(cancel)?;
            profile.source.verify()?;
            profile_runtimes.extend(profile.runtimes.iter().cloned());
        }
        if profile_runtimes != self.profile_runtimes { return Err("版本配置的着色运行时证据已改变".into()); }
        Ok(())
    }

    pub(super) fn verify(&self, settings: &Value, cancel: &AtomicBool) -> Result<()> {
        self.verify_context(settings, cancel)?;
        for profile in &self.profiles {
            let hashes = hash_source(&profile.source, cancel, Some(profile.size))?;
            if hashes.sha512 != profile.sha512 { return Err("版本配置在资源检测期间改变".into()); }
        }
        for item in &self.items { cancelled(cancel)?; item.verify(cancel)?; }
        Ok(())
    }
}

struct ProfileState {
    mc_version: String,
    loader: Option<String>,
    runtimes: BTreeSet<String>,
    profile_runtimes: BTreeSet<String>,
    files: Vec<ProfileEvidence>,
    total_bytes: u64,
}

/// 普通模组安装只需要版本继承链，不扫描或散列整个 mods 目录。
pub(crate) struct InstallProfile {
    root: Directory,
    pub(crate) mc_version: String,
    pub(crate) loader: Option<String>,
    profiles: Vec<ProfileEvidence>,
}
impl InstallProfile {
    pub(crate) fn verify(&self, cancel: &AtomicBool) -> Result<()> {
        cancelled(cancel)?;
        self.root.verify()?;
        for profile in &self.profiles {
            let hashes = hash_source(&profile.source, cancel, Some(profile.size))?;
            if hashes.sha512 != profile.sha512 {
                return Err("安装目标的版本配置已改变，请重新安装 / 安裝目標的版本設定已變更，請重新安裝 / Target instance profile changed; retry installation".into());
            }
        }
        cancelled(cancel)
    }
}
pub(crate) fn capture_install_profile(root: &Path, id: &str, cancel: &AtomicBool) -> Result<InstallProfile> {
    cancelled(cancel)?;
    let root = Directory::open(root)?;
    let mut state = ProfileState { mc_version: String::new(), loader: None, runtimes: BTreeSet::new(), profile_runtimes: BTreeSet::new(), files: Vec::new(), total_bytes: 0 };
    let (mc, loader) = load_profile(&root, id, cancel, 0, &mut BTreeSet::new(), &mut state)?;
    let profile = InstallProfile {
        root, mc_version: mc.ok_or("无法从实例配置确认 Minecraft 版本 / 無法從實例設定確認 Minecraft 版本 / Cannot identify the instance Minecraft version")?,
        loader, profiles: state.files,
    };
    profile.verify(cancel)?;
    Ok(profile)
}

fn ascii_digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn numeric_mc(value: &str) -> bool {
    let mut parts = value.split('.');
    ascii_digits(parts.next().unwrap_or(""))
        && ascii_digits(parts.next().unwrap_or(""))
        && parts.all(ascii_digits)
}

fn known_mc(value: &str) -> bool {
    if numeric_mc(value) { return true; }
    for suffix in ["-pre", "-rc"] {
        if let Some((base, serial)) = value.split_once(suffix) {
            if numeric_mc(base) && ascii_digits(serial) { return true; }
        }
    }
    // 新式快照使用两段数字基版本和数字序号，如 26.4-snapshot-1。
    if value.split_once("-snapshot-").is_some_and(|(base, serial)| {
        base.split_once('.').is_some_and(|(year, release)| ascii_digits(year) && ascii_digits(release))
            && ascii_digits(serial)
    }) { return true; }
    let bytes = value.as_bytes();
    bytes.len() >= 6 && bytes[0..2].iter().all(u8::is_ascii_digit)
        && bytes[2] == b'w' && bytes[3..5].iter().all(u8::is_ascii_digit)
        && bytes[5..].iter().all(|byte| byte.is_ascii_alphanumeric() || *byte == b'.' || *byte == b'-')
}

fn explicit_mc(object: &serde_json::Map<String, Value>) -> Result<Option<String>> {
    match object.get("clientVersion") {
        Some(Value::String(value)) if known_mc(value) => Ok(Some(value.to_owned())),
        Some(Value::String(_)) => Err("版本配置声明了未知的 Minecraft 版本".into()),
        Some(Value::Null) | None => Ok(None),
        Some(_) => Err("版本配置的 Minecraft 版本字段无效".into()),
    }
}

fn vanilla_shape(object: &serde_json::Map<String, Value>) -> Option<String> {
    let id = object.get("id").and_then(Value::as_str).filter(|value| known_mc(value))?;
    let downloads = object.get("downloads")?.as_object()?;
    let client = downloads.get("client")?.as_object()?;
    let asset_index = object.get("assetIndex")?.as_object()?;
    let _main_class = object.get("mainClass").and_then(Value::as_str).filter(|value| !value.is_empty())?;
    if client.get("url").and_then(Value::as_str).is_some()
        && client.get("sha1").and_then(Value::as_str).is_some()
        && client.get("size").and_then(Value::as_u64).is_some()
        && asset_index.get("id").and_then(Value::as_str).is_some()
        && asset_index.get("sha1").and_then(Value::as_str).is_some()
        && asset_index.get("size").and_then(Value::as_u64).is_some()
    { Some(id.to_owned()) } else { None }
}

fn coordinate(name: &str) -> Option<(&str, &str)> {
    let mut parts = name.split(':');
    Some((parts.next()?, parts.next()?))
}

fn exact_runtime_coordinate(name: &str) -> Option<&'static str> {
    match coordinate(name) {
        Some(("net.irisshaders", "iris")) => Some("iris"),
        Some(("org.embeddedt", "oculus")) => Some("oculus"),
        Some(("io.github.cottonmc", "canvas")) => Some("canvas"),
        Some(("optifine", "OptiFine")) | Some(("optifine", "optifine")) => Some("optifine"),
        _ => None,
    }
}

fn exact_loader_coordinate(name: &str) -> Option<&'static str> {
    match coordinate(name) {
        Some(("net.fabricmc", "fabric-loader")) => Some("fabric"),
        Some(("org.quiltmc", "quilt-loader")) => Some("quilt"),
        Some(("net.minecraftforge", "forge")) | Some(("net.minecraftforge", "fmlloader")) => Some("forge"),
        Some(("net.neoforged", "neoforge")) | Some(("net.neoforged", "fmlcore")) => Some("neoforge"),
        _ => None,
    }
}

fn profile_loader(value: &Value) -> Result<(Option<String>, BTreeSet<String>)> {
    let mut loaders = BTreeSet::new();
    let mut runtimes = BTreeSet::new();
    if let Some(libraries) = value.get("libraries").and_then(Value::as_array) {
        for library in libraries {
            if let Some(name) = library.get("name").and_then(Value::as_str) {
                if let Some(loader) = exact_loader_coordinate(name) { loaders.insert(loader.to_owned()); }
                if let Some(runtime) = exact_runtime_coordinate(name) { runtimes.insert(runtime.to_owned()); }
            }
        }
    }
    let main = value.get("mainClass").and_then(Value::as_str).unwrap_or("");
    if main.starts_with("net.fabricmc.loader.") { loaders.insert("fabric".to_owned()); }
    if main.starts_with("org.quiltmc.loader.") { loaders.insert("quilt".to_owned()); }
    if loaders.len() > 1 { return Err("版本配置同时声明了互相矛盾的加载器".into()); }
    Ok((loaders.into_iter().next(), runtimes))
}

fn runtime_id(name: &str) -> Option<&'static str> {
    match name.to_ascii_lowercase().as_str() {
        "iris" | "irisshaders" => Some("iris"),
        "oculus" => Some("oculus"),
        "canvas" => Some("canvas"),
        "optifine" => Some("optifine"),
        _ => None,
    }
}

fn load_profile(root: &Directory, id: &str, cancel: &AtomicBool, depth: usize, seen: &mut BTreeSet<String>, state: &mut ProfileState) -> Result<(Option<String>, Option<String>)> {
    cancelled(cancel)?;
    if depth > MAX_DEPTH { return Err("版本配置继承层数超过上限".into()); }
    safe_name(id)?;
    if !seen.insert(id.to_owned()) { return Err("版本配置继承存在循环".into()); }
    let versions = root.directory(root.child("versions")?.ok_or("实例版本目录不存在")?)?;
    let version = versions.directory(versions.child(id)?.ok_or("版本配置目录不存在")?)?;
    let profile_name = format!("{id}.json");
    let source = version.source(&profile_name)?;
    if source.len() > MAX_PROFILE_BYTES { return Err("版本配置文件超过大小上限".into()); }
    state.total_bytes = state.total_bytes.checked_add(source.len()).ok_or("版本配置总大小溢出")?;
    if state.total_bytes > MAX_PROFILES_BYTES { return Err("版本配置总大小超过上限".into()); }
    let hashes = hash_source(&source, cancel, Some(source.len()))?;
    let mut opened = source.open()?;
    let bytes = read_bounded(&mut opened.file, MAX_PROFILE_BYTES, cancel)?;
    opened.verify()?;
    cancelled(cancel)?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "版本配置不是有效 JSON")?;
    cancelled(cancel)?;
    let object = value.as_object().ok_or("版本配置必须为对象")?;
    let direct_mc = explicit_mc(object)?.or_else(|| vanilla_shape(object));
    let (own_loader, own_runtimes) = profile_loader(&value)?;
    state.files.push(ProfileEvidence { source: source.clone(), size: hashes.size, sha512: hashes.sha512, runtimes: own_runtimes.clone() });
    state.profile_runtimes.extend(own_runtimes.iter().cloned());
    state.runtimes.extend(own_runtimes);
    let parent = object.get("inheritsFrom").and_then(Value::as_str).filter(|v| !v.is_empty());
    let parent_state = if let Some(parent) = parent { Some(load_profile(root, parent, cancel, depth + 1, seen, state)?) } else { None };
    let parent_mc = parent_state.as_ref().and_then(|(mc, _)| mc.clone());
    let mc = match (direct_mc, parent_mc) {
        (Some(child), Some(parent)) if child != parent => return Err("版本配置继承的 Minecraft 版本互相矛盾".into()),
        (Some(value), _) | (None, Some(value)) => Some(value),
        (None, None) => None,
    };
    let parent_loader = parent_state.and_then(|(_, loader)| loader);
    let loader = match (own_loader, parent_loader) {
        (Some(child), Some(parent)) if child != parent => return Err("版本配置继承的加载器互相矛盾".into()),
        (Some(value), _) | (None, Some(value)) => Some(value),
        (None, None) => None,
    };
    seen.remove(id);
    Ok((mc, loader))
}

fn open_resource_parent(root: &Directory, isolation: &crate::modpack::InstanceIsolation, id: &str) -> Result<Directory> {
    if isolation.isolated {
        let versions = root.directory(root.child("versions")?.ok_or("实例版本目录不存在")?)?;
        versions.directory(versions.child(id)?.ok_or("实例目录不存在")?)
    } else { Ok(root.clone()) }
}

fn scan_dir(dir: &Directory, absolute_dir: &Path, kind: ResourceKind, profile_loader: Option<&str>, runtimes: &mut BTreeSet<String>, items: &mut Vec<LocalItem>, total: &mut u64, cancel: &AtomicBool) -> Result<()> {
    cancelled(cancel)?;
    if kind == ResourceKind::Mod && profile_loader.is_none() { return Ok(()); }
    let mut budget = MAX_FILES.saturating_sub(items.len());
    let names = dir.names(&mut budget)?;
    for name in &names {
        cancelled(cancel)?;
        let node = dir.child(name)?.ok_or("资源目录在扫描期间消失")?;
        if node.meta.is_dir() { continue; }
        let (filename, enabled) = enabled_name(name);
        let expected_ext = match kind {
            ResourceKind::Mod => "jar",
            ResourceKind::ResourcePack | ResourceKind::Shader => "zip",
        };
        if !lower_ext(filename).is_some_and(|ext| ext.eq_ignore_ascii_case(expected_ext)) { continue; }
        if items.len() >= MAX_FILES { return Err("资源文件数量超过上限".into()); }
        let source = dir.source(name)?;
        safe_name(filename)?;
        // 在读取候选内容前预检逻辑资源大小；摘要/指纹与最终复验仍会多次读取。
        let next_total = resource_budget(*total, source.len())?;
        let hashes = hash_source(&source, cancel, Some(source.len()))?;
        *total = next_total;
        // 单个 jar 的元数据异常（条目超限、非严格 JSON 等）只影响该 jar 的着色运行时
        // 提示，不应让整个实例的资源读取与更新检测失败；取消除外。
        let metadata = if kind == ResourceKind::Mod && enabled {
            match jar_metadata(&source, cancel, profile_loader) {
                Ok(hints) => hints,
                Err(error) if error.contains("已取消") => return Err(error),
                Err(_) => MetadataHints::default(),
            }
        } else { MetadataHints::default() };
        runtimes.extend(metadata.runtimes.iter().cloned());
        let shader_runtimes = runtimes.iter().cloned().collect::<Vec<_>>();
        items.push(LocalItem { query: LocalQuery { kind, path: absolute_dir.join(name), filename: filename.to_owned(), enabled, size: hashes.size, sha1: hashes.sha1.clone(), sha512: hashes.sha512.clone(), fingerprint: hashes.fingerprint, mc_version: String::new(), loader: profile_loader.map(str::to_owned), shader_runtimes }, source, hashes });
    }
    Ok(())
}

#[derive(Default)]
struct MetadataHints { runtimes: BTreeSet<String> }

impl MetadataHints {
    fn insert(&mut self, runtime: &str) -> Result<()> {
        if self.runtimes.iter().any(|existing| existing != runtime) {
            return Err("资源元数据声明了相互冲突的着色运行时".into());
        }
        self.runtimes.insert(runtime.to_owned());
        Ok(())
    }
}

fn json_runtime(value: &Value, key: &str, hints: &mut MetadataHints) -> Result<()> {
    if let Some(id) = value.get(key).and_then(Value::as_str).and_then(runtime_id) { hints.insert(id)?; }
    Ok(())
}

fn toml_mods_runtime(value: &toml::Value, hints: &mut MetadataHints) -> Result<()> {
    let Some(mods) = value.get("mods").and_then(toml::Value::as_array) else { return Ok(()); };
    for entry in mods {
        if let Some(id) = entry.get("modId").and_then(toml::Value::as_str).and_then(runtime_id) { hints.insert(id)?; }
    }
    Ok(())
}

fn mcmod_json_runtime(value: &Value, hints: &mut MetadataHints) -> Result<()> {
    let entries = value.as_array().or_else(|| value.get("modList").and_then(Value::as_array));
    if let Some(entries) = entries {
        for entry in entries {
            json_runtime(entry, "modid", hints)?;
            json_runtime(entry, "modId", hints)?;
        }
    }
    Ok(())
}

fn jar_metadata(source: &Source, cancel: &AtomicBool, profile_loader: Option<&str>) -> Result<MetadataHints> {
    let mut opened = source.open()?;
    let mut archive = zip::ZipArchive::new(&mut opened.file).map_err(|_| "资源 JAR/ZIP 格式无效")?;
    if archive.len() > MAX_ZIP_ENTRIES { return Err("资源压缩包条目超过上限".into()); }
    let mut names = BTreeSet::new();
    let mut declared = 0u64;
    let mut hints = MetadataHints::default();
    for index in 0..archive.len() {
        cancelled(cancel)?;
        let mut entry = archive.by_index(index).map_err(|_| "读取资源压缩包条目失败")?;
        let name = entry.name().to_owned();
        if !names.insert(name.to_ascii_lowercase()) { return Err("资源压缩包存在重复条目".into()); }
        if name.len() > 4096 || name.starts_with('/') || name.contains("../") || name.contains("\\") { return Err("资源压缩包路径不安全".into()); }
        let size = entry.size();
        if size > MAX_ZIP_ENTRY_BYTES { return Err("资源压缩包单项超过上限".into()); }
        declared = declared.checked_add(size).ok_or("资源压缩包大小溢出")?;
        if declared > MAX_ZIP_BYTES { return Err("资源压缩包展开大小超过上限".into()); }
        let lower = name.to_ascii_lowercase();
        let wanted = match profile_loader {
            Some("fabric") => lower == "fabric.mod.json",
            Some("quilt") => matches!(lower.as_str(), "fabric.mod.json" | "quilt.mod.json"),
            Some("forge") => matches!(lower.as_str(), "meta-inf/mods.toml" | "mcmod.info"),
            Some("neoforge") => matches!(lower.as_str(), "meta-inf/mods.toml" | "meta-inf/neoforge.mods.toml"),
            _ => false,
        };
        if wanted {
            if size > MAX_METADATA_BYTES { return Err("资源元数据超过上限".into()); }
            let bytes = read_bounded(&mut entry, MAX_METADATA_BYTES, cancel)?;
            if bytes.len() as u64 != size { return Err("资源元数据大小与声明不一致".into()); }
            cancelled(cancel)?;
            if lower == "mcmod.info" || lower == "fabric.mod.json" || lower == "quilt.mod.json" {
                // 部分模组（如 macos-input-fixes）的 fabric.mod.json 带 UTF-8 BOM，
                // Fabric 加载器容忍，这里同样剥掉再解析。
                let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
                let value: Value = serde_json::from_slice(&bytes).map_err(|_| "资源 JSON 元数据无效")?;
                if lower == "fabric.mod.json" && matches!(profile_loader, Some("fabric" | "quilt")) { json_runtime(&value, "id", &mut hints)?; }
                else if lower == "quilt.mod.json" && matches!(profile_loader, Some("quilt")) { json_runtime(value.get("quilt_loader").unwrap_or(&Value::Null), "id", &mut hints)?; }
                else if lower == "mcmod.info" && matches!(profile_loader, Some("forge" | "neoforge")) { mcmod_json_runtime(&value, &mut hints)?; }
            } else {
                let text = std::str::from_utf8(&bytes).map_err(|_| "资源 TOML 元数据无效")?;
                let value = toml::from_str::<toml::Value>(text).map_err(|_| "资源 TOML 元数据无效")?;
                if matches!(profile_loader, Some("forge" | "neoforge")) { toml_mods_runtime(&value, &mut hints)?; }
            }
            cancelled(cancel)?;
        }
    }
    drop(archive);
    opened.verify()?;
    Ok(hints)
}

pub(super) fn scan(root: &Path, id: &str, settings: &Value, cancel: &AtomicBool) -> Result<Inventory> {
    cancelled(cancel)?;
    if !root.is_absolute() { return Err("游戏目录必须为绝对路径".into()); }
    let root_dir = Directory::open(root)?;
    let isolation = crate::modpack::instance_isolation(root, id, settings)?;
    let parent = open_resource_parent(&root_dir, &isolation, id)?;
    let mut profile_state = ProfileState { mc_version: String::new(), loader: None, runtimes: BTreeSet::new(), profile_runtimes: BTreeSet::new(), files: Vec::new(), total_bytes: 0 };
    let mut seen = BTreeSet::new();
    let (mc, loader) = load_profile(&root_dir, id, cancel, 0, &mut seen, &mut profile_state)?;
    let mc_version = mc.ok_or("无法从版本配置准确确认 Minecraft 版本")?;
    profile_state.mc_version = mc_version.clone();
    profile_state.loader = loader.clone();
    let mut directories = Vec::new();
    let mut items = Vec::new();
    let mut total = 0u64;
    for (name, kind) in [("mods", ResourceKind::Mod), ("resourcepacks", ResourceKind::ResourcePack), ("shaderpacks", ResourceKind::Shader)] {
        cancelled(cancel)?;
        let node = parent.child(name)?;
        let Some(node) = node else { directories.push(DirectoryEvidence { parent: parent.mark(), name: name.into(), present: false, directory: None, names: Vec::new() }); continue; };
        if !node.meta.is_dir() { return Err("资源目录不是目录".into()); }
        let directory = parent.directory(node)?;
        let mut budget = MAX_FILES;
        let names = directory.names(&mut budget)?;
        directories.push(DirectoryEvidence { parent: parent.mark(), name: name.into(), present: true, directory: Some(directory.clone()), names: names.clone() });
        scan_dir(&directory, &parent.path().join(name), kind, loader.as_deref(), &mut profile_state.runtimes, &mut items, &mut total, cancel)?;
    }
    for item in &mut items {
        item.query.mc_version = mc_version.clone();
        item.query.shader_runtimes = profile_state.runtimes.iter().cloned().collect();
    }
    let mut inventory = Inventory {
        items,
        root: root_dir,
        root_path: root.to_owned(),
        id: id.to_owned(),
        isolation,
        directories,
        profiles: profile_state.files,
        settings_isolated: false,
        mc_version: mc_version.clone(),
        loader: loader.clone(),
        shader_runtimes: profile_state.runtimes.clone(),
        profile_runtimes: profile_state.profile_runtimes.clone(),
    };
    inventory.settings_isolated = inventory.isolation.isolated;
    inventory.verify(settings, cancel)?;
    Ok(inventory)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{fs, io::Write};
    use zip::{write::FileOptions, ZipWriter};

    struct Fixture { root: PathBuf, isolated: bool }
    impl Fixture {
        fn new(isolated: bool) -> Self {
            let root = std::env::temp_dir().join(format!("hcmcl-resource-local-{}", uuid::Uuid::new_v4()));
            let version = root.join("versions/fixture");
            fs::create_dir_all(&version).unwrap();
            let profile = json!({"id":"1.20.1","clientVersion":"1.20.1","mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient","libraries":[{"name":"net.fabricmc:fabric-loader:0.16.0"},{"name":"net.irisshaders:iris:1.7.0"}]});
            fs::write(version.join("fixture.json"), serde_json::to_vec(&profile).unwrap()).unwrap();
            if isolated { fs::write(version.join("instance.json"), br#"{"isolation":true}"#).unwrap(); }
            let parent = if isolated { version } else { root.clone() };
            for name in ["mods", "resourcepacks", "shaderpacks"] { fs::create_dir_all(parent.join(name)).unwrap(); }
            Self::archive(&parent.join("mods/fabric.jar"), "fabric.mod.json", br#"{"id":"iris"}"#);
            Self::archive(&parent.join("mods/quilt.jar"), "quilt.mod.json", br#"{"quilt_loader":{"id":"oculus"}}"#);
            Self::archive(&parent.join("mods/forge.jar"), "META-INF/mods.toml", br#"[[mods]]
modId = "canvas""#);
            Self::archive(&parent.join("mods/neo.jar.disabled"), "META-INF/neoforge.mods.toml", br#"[[mods]]
modId = "optifine""#);
            Self::archive(&parent.join("resourcepacks/pack.zip"), "pack.mcmeta", br#"{}"#);
            Self::archive(&parent.join("shaderpacks/shader.zip.disabled"), "shader.properties", b"");
            fs::write(parent.join("mods/ignored.txt"), b"ignored").unwrap();
            fs::create_dir_all(parent.join("mods/child")).unwrap();
            fs::write(parent.join("mods/child/nested.jar"), b"nested").unwrap();
            Self { root, isolated }
        }
        fn archive(path: &Path, name: &str, bytes: &[u8]) {
            let file = File::create(path).unwrap();
            let mut zip = ZipWriter::new(file);
            zip.start_file(name, FileOptions::default()).unwrap();
            zip.write_all(bytes).unwrap();
            zip.finish().unwrap();
        }
        fn settings(&self) -> Value { json!({}) }
        fn parent(&self) -> PathBuf { if self.isolated { self.root.join("versions/fixture") } else { self.root.clone() } }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); } }

    #[test]
    fn self_contained_forge_profile_detects_loader_via_fmlloader_coordinate() {
        // 就地合并安装产出的自包含 Forge JSON 没有 net.minecraftforge:forge 坐标，
        // 只有 fmlloader/fmlearlydisplay 等坐标；必须仍能识别 forge 加载器（真实回归：
        // 1.20.1-forge 实例装 1.20.1+forge 模组被误判「不适配」）。
        let root = std::env::temp_dir().join(format!("hcmcl-resource-forge-{}", uuid::Uuid::new_v4()));
        let version = root.join("versions/1.20.1-forge");
        fs::create_dir_all(&version).unwrap();
        fs::create_dir_all(root.join("mods")).unwrap();
        let profile = json!({"id":"1.20.1-forge","clientVersion":"1.20.1","mainClass":"cpw.mods.bootstraplauncher.BootstrapLauncher","libraries":[{"name":"net.minecraftforge:fmlloader:1.20.1-47.4.28"},{"name":"net.minecraftforge:fmlearlydisplay:1.20.1-47.4.28"},{"name":"net.minecraftforge:forgespi:7.0.1"}]});
        fs::write(version.join("1.20.1-forge.json"), serde_json::to_vec(&profile).unwrap()).unwrap();
        let inventory = scan(&root, "1.20.1-forge", &json!({}), &AtomicBool::new(false)).unwrap();
        assert_eq!(inventory.mc_version, "1.20.1");
        assert_eq!(inventory.loader.as_deref(), Some("forge"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn metadata_reads_stop_after_cancellation_and_reject_oversize_input() {
        struct CancelAfterRead<'a> { cancel: &'a AtomicBool, read: usize }
        impl Read for CancelAfterRead<'_> {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                self.read += bytes.len();
                bytes.fill(b'x');
                self.cancel.store(true, Ordering::Release);
                Ok(bytes.len())
            }
        }
        let cancel = AtomicBool::new(false);
        let mut reader = CancelAfterRead { cancel: &cancel, read: 0 };
        assert!(read_bounded(&mut reader, MAX_PROFILE_BYTES, &cancel).unwrap_err().contains("取消"));
        assert_eq!(reader.read, CHUNK);
        cancel.store(false, Ordering::Release);
        assert!(read_bounded(&mut b"12345".as_slice(), 4, &cancel).is_err());
        assert_eq!(read_bounded(&mut b"1234".as_slice(), 4, &cancel).unwrap(), b"1234");
    }

    #[test]
    fn resource_budget_rejects_before_scanning_the_next_candidate() {
        assert_eq!(resource_budget(MAX_TOTAL_BYTES - 4, 4).unwrap(), MAX_TOTAL_BYTES);
        assert!(resource_budget(MAX_TOTAL_BYTES - 4, 5).is_err());
        assert!(resource_budget(0, MAX_FILE_BYTES + 1).is_err());
        let fixture = Fixture::new(false);
        let mods = Directory::open(&fixture.parent().join("mods")).unwrap();
        let mut total = MAX_TOTAL_BYTES;
        let mut items = Vec::new();
        let error = scan_dir(&mods, &mods.path(), ResourceKind::Mod, Some("fabric"), &mut BTreeSet::new(), &mut items, &mut total, &AtomicBool::new(false)).unwrap_err();
        assert_eq!(error, "资源总大小超过上限");
        assert!(items.is_empty());
        assert_eq!(total, MAX_TOTAL_BYTES);
    }

    #[test]
    fn murmur2_filters_only_the_documented_whitespace() {
        let mut first = Murmur2::new(2); first.update(&[32, 97, 10, 32, 98, 13, 9]);
        let mut second = Murmur2::new(2); second.update(b"ab");
        assert_eq!(first.finish(), second.finish());
    }

    #[test]
    fn local_scan_covers_shared_and_marker_isolated_roots() {
        for isolated in [false, true] {
            let fixture = Fixture::new(isolated);
            let cancel = AtomicBool::new(false);
            let settings = fixture.settings();
            let inventory = scan(&fixture.root, "fixture", &settings, &cancel).unwrap();
            assert_eq!(inventory.isolation.isolated, isolated);
            assert_eq!(inventory.items.len(), 6);
            let disabled_runtime_only = inventory.items.iter().find(|item| item.query.filename == "neo.jar").unwrap();
            assert!(!disabled_runtime_only.query.shader_runtimes.contains(&"optifine".to_owned()));
            assert_eq!(inventory.mc_version, "1.20.1");
            assert_eq!(inventory.loader.as_deref(), Some("fabric"));
            assert_eq!(inventory.shader_runtimes, BTreeSet::from(["iris".to_owned()]));
            let disabled = inventory.items.iter().find(|item| item.query.filename == "neo.jar").unwrap();
            assert!(!disabled.query.enabled);
            assert_eq!(disabled.query.path, fixture.parent().join("mods/neo.jar.disabled"));
            assert!(disabled.query.path.is_absolute() && disabled.query.path.exists());
            assert!(inventory.items.iter().all(|item| item.query.path.is_absolute()));
            assert!(inventory.items.iter().all(|item| !item.query.path.to_string_lossy().contains("child")));
            inventory.verify(&settings, &cancel).unwrap();
        }
    }

    #[test]
    fn vanilla_profile_skips_mod_inventory_but_keeps_packs_and_shaders() {
        let fixture = Fixture::new(false);
        let profile_path = fixture.root.join("versions/fixture/fixture.json");
        let profile = json!({"id":"1.20.1","clientVersion":"1.20.1","mainClass":"net.minecraft.client.main.Main","libraries":[]});
        fs::write(profile_path, serde_json::to_vec(&profile).unwrap()).unwrap();
        let cancel = AtomicBool::new(false);
        let inventory = scan(&fixture.root, "fixture", &fixture.settings(), &cancel).unwrap();
        assert_eq!(inventory.loader, None);
        assert_eq!(inventory.items.len(), 2);
        assert!(inventory.items.iter().all(|item| item.query.kind != ResourceKind::Mod));
    }

    #[cfg(unix)]
    #[test]
    fn local_scan_fails_closed_on_ancestor_link_and_file_mutation() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new(false);
        let outside = fixture.root.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::remove_dir_all(fixture.root.join("mods")).unwrap();
        symlink(&outside, fixture.root.join("mods")).unwrap();
        let cancel = AtomicBool::new(false);
        assert!(scan(&fixture.root, "fixture", &fixture.settings(), &cancel).is_err());

        let fixture = Fixture::new(false);
        let settings = fixture.settings();
        let inventory = scan(&fixture.root, "fixture", &settings, &cancel).unwrap();
        fs::write(fixture.root.join("mods/fabric.jar"), b"changed").unwrap();
        assert!(inventory.verify(&settings, &cancel).is_err());
    }

    #[test]
    fn runtime_metadata_uses_declared_module_identity_and_actual_loader() {
        let fixture = Fixture::new(false);
        let cancel = AtomicBool::new(false);
        let mods = Directory::open(&fixture.parent().join("mods")).unwrap();
        for (name, loader, runtime) in [("fabric.jar", "fabric", "iris"), ("quilt.jar", "quilt", "oculus"), ("forge.jar", "forge", "canvas")] {
            let source = mods.source(name).unwrap();
            assert_eq!(jar_metadata(&source, &cancel, Some(loader)).unwrap().runtimes, BTreeSet::from([runtime.to_owned()]));
            let other = if loader == "fabric" { "forge" } else { "fabric" };
            assert!(jar_metadata(&source, &cancel, Some(other)).unwrap().runtimes.is_empty());
        }
        Fixture::archive(&fixture.parent().join("mods/dependencies.jar"), "fabric.mod.json", br#"{"id":"ordinary","depends":{"iris":"*"},"suggests":[{"id":"oculus"}]}"#);
        assert!(jar_metadata(&mods.source("dependencies.jar").unwrap(), &cancel, Some("fabric")).unwrap().runtimes.is_empty());
        for metadata in [br#"[{"modid":"oculus"}]"#.as_slice(), br#"{"modList":[{"modid":"oculus"}]}"#.as_slice()] {
            Fixture::archive(&fixture.parent().join("mods/legacy.jar"), "mcmod.info", metadata);
            assert!(jar_metadata(&mods.source("legacy.jar").unwrap(), &cancel, Some("forge")).unwrap().runtimes.contains("oculus"));
        }
    }

    #[test]
    fn jar_metadata_accepts_utf8_bom_prefixed_fabric_mod_json() {
        let fixture = Fixture::new(false);
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(br#"{"id":"iris"}"#);
        Fixture::archive(&fixture.parent().join("mods/bom.jar"), "fabric.mod.json", &bytes);
        let mods = Directory::open(&fixture.parent().join("mods")).unwrap();
        let hints = jar_metadata(&mods.source("bom.jar").unwrap(), &AtomicBool::new(false), Some("fabric")).unwrap();
        assert_eq!(hints.runtimes, BTreeSet::from(["iris".to_owned()]));
    }

    #[test]
    fn scan_tolerates_individual_corrupt_or_oversize_mod_jars_but_not_cancellation() {
        let fixture = Fixture::new(false);
        let parent = fixture.parent();
        // 字符串内含裸换行的非严格 JSON：Fabric 加载器（Gson）容忍，serde_json 严格拒绝。
        Fixture::archive(&parent.join("mods/lenient.jar"), "fabric.mod.json", b"{\"id\":\"a\",\"name\":\"x\ny\"}");
        // 根本不是 zip。
        fs::write(parent.join("mods/notajar.jar"), b"definitely not a zip").unwrap();
        // 超过旧 4096 上限、也超过新上限的大型压缩包（真实回归：汽鸣铁道 24k+ 条目）。
        let big = File::create(parent.join("mods/big.jar")).unwrap();
        let mut zip = ZipWriter::new(big);
        for index in 0..(MAX_ZIP_ENTRIES as u32 + 1) {
            zip.start_file(format!("assets/{index}.json"), FileOptions::default()).unwrap();
        }
        zip.finish().unwrap();
        let settings = fixture.settings();
        let inventory = scan(&fixture.root, "fixture", &settings, &AtomicBool::new(false)).unwrap();
        let names: BTreeSet<&str> = inventory.items.iter().map(|item| item.query.filename.as_str()).collect();
        assert!(names.contains("lenient.jar") && names.contains("notajar.jar") && names.contains("big.jar"));
        // 取消仍然让整个扫描失败，不被单 jar 降级逻辑吞掉。
        let cancel = AtomicBool::new(true);
        assert!(scan(&fixture.root, "fixture", &settings, &cancel).is_err());
    }

    #[test]
    fn local_evidence_rejects_cancellation_profile_mutation_and_new_directory_members() {
        let fixture = Fixture::new(false);
        let cancel = AtomicBool::new(false);
        let settings = fixture.settings();
        let inventory = scan(&fixture.root, "fixture", &settings, &cancel).unwrap();
        cancel.store(true, Ordering::Release);
        assert!(inventory.verify(&settings, &cancel).is_err());
        assert!(scan(&fixture.root, "fixture", &settings, &cancel).is_err());
        cancel.store(false, Ordering::Release);
        fs::write(fixture.root.join("versions/fixture/fixture.json"), b"{}").unwrap();
        assert!(inventory.verify_context(&settings, &cancel).is_err());
        let fixture = Fixture::new(false);
        let inventory = scan(&fixture.root, "fixture", &fixture.settings(), &cancel).unwrap();
        fs::write(fixture.parent().join("resourcepacks/new.zip"), b"new").unwrap();
        assert!(inventory.verify(&fixture.settings(), &cancel).is_err());
    }

    #[test]
    fn bare_official_snapshot_profile_supplies_resource_query_version() {
        let fixture = Fixture::new(false);
        let id = "26.4-snapshot-1";
        let version = fixture.root.join("versions").join(id);
        fs::create_dir(&version).unwrap();
        let path = version.join(format!("{id}.json"));
        let mut profile = json!({
            "id": id,
            "type": "snapshot",
            "mainClass": "net.minecraft.client.main.Main",
            "libraries": [],
            "downloads": {"client": {"url": "https://example.invalid/client.jar", "sha1": "0".repeat(40), "size": 123}},
            "assetIndex": {"id": "26", "sha1": "0".repeat(40), "size": 45}
        });
        fs::write(&path, serde_json::to_vec(&profile).unwrap()).unwrap();
        let settings = fixture.settings();
        let cancel = AtomicBool::new(false);
        let inventory = scan(&fixture.root, id, &settings, &cancel).unwrap();
        assert_eq!(inventory.mc_version, id);
        assert_eq!(inventory.loader, None);
        assert_eq!(inventory.items.len(), 2);
        assert!(inventory.items.iter().all(|item| item.query.mc_version == id));

        // 仅有合法目录名和 id 不构成原版配置证据。
        profile.as_object_mut().unwrap().remove("downloads");
        fs::write(&path, serde_json::to_vec(&profile).unwrap()).unwrap();
        assert!(scan(&fixture.root, id, &settings, &cancel).is_err());
    }

    #[test]
    fn minecraft_version_evidence_accepts_snapshots_and_pre_releases_without_id_guessing() {
        for version in ["1.20.1", "1.21-pre1", "1.21-rc1", "24w14a", "26.4-snapshot-1", "27.1-snapshot-12"] { assert!(known_mc(version), "{version}"); }
        for version in ["fixture", "fabric-1.20.1", "1.21-pre1-pre2", "1.21-rc", "24w", "26.4-snapshot-", "26.4-snapshot-1-fabric", "26.4.1-snapshot-1", "26.4-snapshot-１"] { assert!(!known_mc(version), "{version}"); }
        let fixture = Fixture::new(false);
        let path = fixture.root.join("versions/fixture/fixture.json");
        let profile = json!({"id":"custom-label","inheritsFrom":"base","libraries":[{"name":"net.fabricmc:fabric-loader:0.16.0"}]});
        fs::write(&path, serde_json::to_vec(&profile).unwrap()).unwrap();
        fs::create_dir(fixture.root.join("versions/base")).unwrap();
        fs::write(fixture.root.join("versions/base/base.json"), serde_json::to_vec(&json!({"id":"base","clientVersion":"1.21-rc1","libraries":[]})).unwrap()).unwrap();
        let inventory = scan(&fixture.root, "fixture", &fixture.settings(), &AtomicBool::new(false)).unwrap();
        assert_eq!(inventory.mc_version, "1.21-rc1");
        assert_eq!(inventory.loader.as_deref(), Some("fabric"));
    }

    #[test]
    fn resource_names_keep_disabled_suffix_out_of_query_filename() {
        assert_eq!(enabled_name("iris.jar.disabled"), ("iris.jar", false));
        assert_eq!(enabled_name("iris.jar"), ("iris.jar", true));
    }
}

//! 版本清单与原始版本 JSON 共用一套按目录和来源隔离的缓存。
use super::{
    absolute, atomic_bytes, checksum, hex_sha1, identifier, inside, local, parse_json,
    path_key, read_bounded, strategy, text, version_path, Cancel, Network, Result,
    JSON_LIMIT, MIRROR,
};
use serde_json::{json, Value};
use std::{
    collections::{hash_map::DefaultHasher, BTreeSet},
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};

const OFFICIAL_MANIFEST: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const MIRROR_MANIFEST: &str = "https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json";
const MANIFEST_TTL: Duration = Duration::from_secs(300);
const REQUEST_LIMIT: Duration = Duration::from_secs(10);
const INHERITANCE_LIMIT: usize = 32;
const INHERITANCE_BYTES: u64 = 64 * 1024 * 1024;

type Merge = fn(&Value, &Value) -> Result<Value>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Source {
    Official,
    Mirror,
}

impl Source {
    fn name(self) -> &'static str {
        match self {
            Self::Official => "official",
            Self::Mirror => "mirror",
        }
    }
}

struct Policy {
    key: &'static str,
    order: &'static [Source],
}

impl Policy {
    fn from_settings(settings: &Value) -> Result<Self> {
        use Source::{Mirror, Official};
        let key = strategy(settings, "versionListSource")?;
        // 只调整顺序，不砍候选：官方优先在官方 404 / 堵塞时还要能落回镜像。
        let order: &'static [Source] = match key {
            "mirror-first" => &[Mirror, Official],
            _ => &[Official, Mirror],
        };
        Ok(Self { key, order })
    }
}

struct Endpoints<'a> {
    official_manifest: &'a str,
    mirror_manifest: &'a str,
    mirror_origin: &'a str,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum LocalId {
    Required,
    LegacyOptional,
}

pub(super) struct Metadata<'a> {
    network: &'a Network,
    root: &'a Path,
    settings: &'a Value,
    cancel: &'a Cancel,
    endpoints: Endpoints<'a>,
}

fn fresh(path: &Path) -> bool {
    fs::metadata(path).ok().and_then(|m| m.modified().ok())
        .and_then(|mtime| mtime.elapsed().ok()).is_some_and(|age| age < MANIFEST_TTL)
}

/// 来源轮空后的短暂停顿；取消优先于等待。
async fn retry_pause(cancel: &Cancel) -> Result<()> {
    tokio::select! {
        _ = cancel.cancelled() => Err("下载已取消".into()),
        _ = tokio::time::sleep(Duration::from_millis(1200)) => cancel.check(),
    }
}

// 同根的在线缓存事务使用同一分桶门；从不取得安装根锁，也不持有同步锁跨 await。
// 固定数量的锁避免进程内保留所有访问过的目录；离线只读原子发布的磁盘文件。
async fn cache_gate(root: &Path, cancel: &Cancel) -> Result<tokio::sync::MutexGuard<'static, ()>> {
    static GATES: OnceLock<[tokio::sync::Mutex<()>; 32]> = OnceLock::new();
    let root = absolute(root)?;
    let canonical = fs::canonicalize(&root).unwrap_or(root);
    let mut hash = DefaultHasher::new();
    path_key(&canonical).hash(&mut hash);
    let gates = GATES.get_or_init(|| std::array::from_fn(|_| tokio::sync::Mutex::new(())));
    let gate = &gates[(hash.finish() % gates.len() as u64) as usize];
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("下载已取消".into()),
        guard = gate.lock() => { cancel.check()?; Ok(guard) }
    }
}

impl<'a> Metadata<'a> {
    pub(super) fn new(network: &'a Network, root: &'a Path, settings: &'a Value, cancel: &'a Cancel) -> Self {
        Self { network, root, settings, cancel, endpoints: Endpoints {
            official_manifest: OFFICIAL_MANIFEST, mirror_manifest: MIRROR_MANIFEST, mirror_origin: MIRROR,
        } }
    }

    #[cfg(test)]
    pub(super) fn with_test_endpoints(mut self, official_manifest: &'a str, mirror_manifest: &'a str, mirror_origin: &'a str) -> Self {
        self.endpoints = Endpoints { official_manifest, mirror_manifest, mirror_origin };
        self
    }

    fn url(&self, source: Source, manifest: bool, raw: &str) -> Result<reqwest::Url> {
        let url = self.network.url(raw)?;
        #[cfg(test)]
        if self.network.loopback {
            return if url.scheme() == "http" { Ok(url) } else { Err("元数据夹具只允许回环地址".into()) };
        }
        let host = url.host_str();
        let official = matches!(host, Some("piston-meta.mojang.com" | "launchermeta.mojang.com"));
        let allowed = match source {
            Source::Official => official,
            // 镜像清单可以引用官方包，但镜像清单请求本身不串到官方来源。
            Source::Mirror => host == Some("bmclapi2.bangbang93.com") || (!manifest && official),
        };
        if !allowed { return Err("地址不在版本元数据来源白名单".into()); }
        Ok(url)
    }

    async fn fetch(&self, source: Source, manifest: bool, url: &str) -> Result<Vec<u8>> {
        self.cancel.check()?;
        if local(self.settings) { return Err("本地模式未发起版本元数据网络请求".into()); }
        // 单次候选请求（含全部重定向与响应体）限时；失败交给来源策略继续处理。
        tokio::time::timeout(REQUEST_LIMIT, async {
            let mut response = self.network.request_checked(url, None, self.cancel,
                |url| self.url(source, manifest, url)).await.map_err(|error| error.message)?;
            if !response.status().is_success() {
                return Err(format!("版本元数据 HTTP {}", response.status().as_u16()));
            }
            if response.content_length().is_some_and(|len| len > JSON_LIMIT) {
                return Err("版本元数据响应超过大小上限".into());
            }
            let mut bytes = Vec::new();
            loop {
                let next = tokio::select! {
                    biased;
                    _ = self.cancel.cancelled() => return Err("下载已取消".into()),
                    result = response.chunk() => result.map_err(|_| "读取版本元数据失败")?,
                };
                let Some(chunk) = next else { break };
                if bytes.len() as u64 + chunk.len() as u64 > JSON_LIMIT {
                    return Err("版本元数据响应超过大小上限".into());
                }
                bytes.extend_from_slice(&chunk);
            }
            self.cancel.check()?;
            Ok(bytes)
        }).await.map_err(|_| "获取版本元数据超时".to_string())?
    }

    fn manifest_path(&self, source: Source) -> Result<PathBuf> {
        inside(self.root, format!(".hcmcl-cache/manifest-{}.json", source.name()))
    }

    fn decode_manifest(&self, bytes: &[u8], source: Source, for_list: bool) -> Result<Value> {
        let value = parse_json(bytes)?;
        let entries = value["versions"].as_array().ok_or("版本清单缺少 versions 数组")?;
        if entries.is_empty() || entries.len() > 20_000 {
            return Err("版本清单为空或超过条目上限".into());
        }
        let mut ids = BTreeSet::new();
        for entry in entries {
            self.cancel.check()?;
            // 列表与 Electron 一样隐藏旧 alpha/beta；这些条目不应阻塞正常列表的投影。
            if for_list && matches!(text(entry, "type"), "old_alpha" | "old_beta") {
                continue;
            }
            let id = identifier(text(entry, "id"))?;
            if !ids.insert(id) { return Err("版本清单出现重复标识".into()); }
            checksum(text(entry, "sha1"), 40)?;
            self.url(source, false, text(entry, "url"))?;
        }
        if for_list { project_list(&value, entries) } else { Ok(value) }
    }

    fn cached_manifest(&self, path: &Path, source: Source, for_list: bool) -> Result<Value> {
        self.decode_manifest(&read_bounded(path, JSON_LIMIT)?, source, for_list)
    }

    async fn manifest(&self, source: Source, force: bool, for_list: bool) -> Result<Value> {
        self.cancel.check()?;
        let path = self.manifest_path(source)?;
        if local(self.settings) {
            return self.cached_manifest(&path, source, for_list)
                .map_err(|err| format!("本地模式缺少有效版本清单缓存：{err}"));
        }
        if !force && fresh(&path) {
            if let Ok(value) = self.cached_manifest(&path, source, for_list) { return Ok(value); }
            self.cancel.check()?;
        }
        let url = match source {
            Source::Official => self.endpoints.official_manifest,
            Source::Mirror => self.endpoints.mirror_manifest,
        };
        let bytes = self.fetch(source, true, url).await?;
        let value = self.decode_manifest(&bytes, source, for_list)?;
        // 保留原始清单以支持旧版本查询；UI 投影绝不写回清单。
        atomic_bytes(&path, &bytes, self.cancel)?;
        Ok(value)
    }

    pub(super) async fn list(&self, force: bool) -> Result<Value> {
        let policy = Policy::from_settings(self.settings)?;
        let offline = local(self.settings);
        let _gate = if offline { None } else { Some(cache_gate(self.root, self.cancel).await?) };
        // 仅记录最近成功的来源；普通读取可复用有效回退，force 重新按策略尝试来源。
        let selection = if offline { None } else {
            inside(self.root, format!(".hcmcl-cache/version-list-{}.source", policy.key)).ok()
        };
        if !force {
            if let Some(path) = selection.as_ref().filter(|path| fresh(path)) {
                if let Ok(name) = read_bounded(path, 16) {
                    if let Some(&source) = policy.order.iter().find(|source| source.name().as_bytes() == name.as_slice()) {
                        if let Ok(path) = self.manifest_path(source) {
                            if fresh(&path) {
                                if let Ok(value) = self.cached_manifest(&path, source, true) {
                                    self.cancel.check()?;
                                    return Ok(value);
                                }
                            }
                        }
                    }
                }
            }
        }
        let mut error = "未取得有效版本清单".to_owned();
        // 一轮把全部来源试完，再整体重试一轮：单次 DNS / 连接抖动不足以判定失败。
        for pass in 0..2u32 {
            for &source in policy.order {
                match self.manifest(source, force, true).await {
                    Ok(value) => {
                        if let Some(path) = &selection {
                            // 清单本体已落盘；丢失此可选提示只影响下次是否重新尝试优先来源。
                            let _ = atomic_bytes(path, source.name().as_bytes(), self.cancel);
                        }
                        self.cancel.check()?;
                        return Ok(value);
                    }
                    Err(err) => { self.cancel.check()?; error = err; }
                }
            }
            if pass == 0 { retry_pause(self.cancel).await?; }
        }
        Err(error)
    }

    fn installed(&self, id: &str, id_policy: LocalId) -> Result<Option<(Value, u64)>> {
        let path = version_path(self.root, id)?;
        match fs::metadata(&path) {
            Ok(_) => {},
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("无法读取本地版本 JSON 属性".into()),
        }
        let bytes = read_bounded(&path, JSON_LIMIT)?;
        let value = parse_json(&bytes)?;
        let valid = match value.get("id") {
            Some(Value::String(value)) => value == id || (value.is_empty() && id_policy == LocalId::LegacyOptional),
            None | Some(Value::Null) => id_policy == LocalId::LegacyOptional,
            _ => false,
        };
        if !valid { return Err("版本 JSON 的 id 与目录不一致".into()); }
        Ok(Some((value, bytes.len() as u64)))
    }

    fn legacy_cached(&self, id: &str, policy: &Policy, digest: &str) -> Result<(Value, u64)> {
        // 旧策略目录的自带 SHA-1 不证明来源。只在内容与当前来源清单的摘要一致时兼容。
        let path = inside(self.root, Path::new(".hcmcl-cache/versions").join(policy.key).join(format!("{id}.json")))?;
        let record = parse_json(&read_bounded(&path, JSON_LIMIT)?)?;
        if record["schema"] != 1 || text(&record, "id") != id || checksum(text(&record, "sha1"), 40)? != digest {
            return Err("旧版本缓存与当前来源清单不匹配".into());
        }
        verified_version(text(&record, "json").as_bytes(), id, digest)
    }

    async fn source_version(&self, id: &str, source: Source, policy: &Policy) -> Result<(Value, u64)> {
        let list = self.manifest(source, false, false).await?;
        let item = list["versions"].as_array().and_then(|entries| entries.iter().find(|item| text(item, "id") == id))
            .ok_or("来源清单中没有目标版本")?;
        let url = text(item, "url");
        let digest = checksum(text(item, "sha1"), 40)?;
        let path = inside(self.root, Path::new(".hcmcl-cache/versions").join(source.name()).join(format!("{id}.json")))?;
        if let Ok(bytes) = read_bounded(&path, JSON_LIMIT) {
            if let Ok(value) = verified_version(&bytes, id, &digest) { return Ok(value); }
        }
        if let Ok(value) = self.legacy_cached(id, policy, &digest) { return Ok(value); }
        if local(self.settings) { return Err("本地模式缺少与来源清单摘要匹配的版本 JSON 缓存".into()); }

        let mut urls = Vec::new();
        if source == Source::Mirror {
            let mut direct = self.url(source, false, self.endpoints.mirror_origin)?;
            direct.path_segments_mut().map_err(|_| "镜像版本地址无效")?.pop_if_empty().push("version").push(id).push("json");
            if direct.as_str() != url { urls.push(direct.to_string()); }
        }
        urls.push(url.to_owned());
        let mut error = "未取得有效版本 JSON".to_owned();
        // 同一来源的多个候选地址轮完后，再整体重试一轮；单个地址抖动不再直接判定失败。
        for pass in 0..2u32 {
            for url in &urls {
                self.cancel.check()?;
                match self.fetch(source, false, url).await.and_then(|bytes| {
                    let value = verified_version(&bytes, id, &digest)?;
                    atomic_bytes(&path, &bytes, self.cancel)?;
                    Ok(value)
                }) {
                    Ok(value) => return Ok(value),
                    Err(err) => { self.cancel.check()?; error = err; }
                }
            }
            if pass == 0 { retry_pause(self.cancel).await?; }
        }
        Err(error)
    }

    async fn raw(&self, id: &str, id_policy: LocalId) -> Result<(Value, u64)> {
        self.cancel.check()?;
        identifier(id)?;
        if let Some(value) = self.installed(id, id_policy)? {
            self.cancel.check()?;
            return Ok(value);
        }
        let policy = Policy::from_settings(self.settings)?;
        let _gate = if local(self.settings) { None } else { Some(cache_gate(self.root, self.cancel).await?) };
        // 在线等待缓存门期间，同根的安装任务可能已经发布实例文件。
        if let Some(value) = self.installed(id, id_policy)? {
            self.cancel.check()?;
            return Ok(value);
        }
        let mut error = "清单中没有目标版本".to_owned();
        for &source in policy.order {
            match self.source_version(id, source, &policy).await {
                Ok(value) => { self.cancel.check()?; return Ok(value); }
                Err(err) => { self.cancel.check()?; error = err; }
            }
        }
        Err(error)
    }

    pub(super) async fn resolve(&self, id: &str, id_policy: LocalId, merge: Merge) -> Result<Value> {
        let mut stack = Vec::new();
        let mut seen = BTreeSet::new();
        let mut bytes = 0;
        let mut current = identifier(id)?.to_string();
        loop {
            if stack.len() >= INHERITANCE_LIMIT || !seen.insert(current.clone()) {
                return Err("版本继承出现循环或超过 32 层".into());
            }
            let (value, len) = self.raw(&current, id_policy).await?;
            account_bytes(&mut bytes, len)?;
            let parent = text(&value, "inheritsFrom").to_string();
            stack.push(value);
            if parent.is_empty() { break; }
            current = identifier(&parent)?.to_owned();
        }
        let mut out = stack.pop().ok_or("缺少版本元数据")?;
        while let Some(child) = stack.pop() {
            self.cancel.check()?;
            out = merge(&out, &child)?;
        }
        // 旧自包含加载器只修复父级启动参数，保留其他安装字段。
        let base = text(&out, "clientVersion").to_string();
        let stale = |key: &str, marker: &str| !out["arguments"][key].as_array().is_some_and(|args|
            args.iter().any(|arg| arg.as_str().is_some_and(|s| s.contains(marker))));
        if !base.is_empty() && base != id && !seen.contains(&base)
            && (stale("jvm", "${classpath}") || stale("game", "${auth_player_name}")) {
            let (value, len) = self.raw(&base, id_policy).await?;
            account_bytes(&mut bytes, len)?;
            if value.get("inheritsFrom").is_some() { return Err("旧加载器参数修复需要完整基础版本".into()); }
            out["arguments"] = merge(&value, &out)?["arguments"].clone();
        }
        self.cancel.check()?;
        Ok(out)
    }
}

fn account_bytes(total: &mut u64, len: u64) -> Result<()> {
    *total = total.saturating_add(len);
    if *total > INHERITANCE_BYTES { return Err("版本继承元数据总量超过上限".into()); }
    Ok(())
}

fn verified_version(bytes: &[u8], id: &str, digest: &str) -> Result<(Value, u64)> {
    if bytes.len() as u64 > JSON_LIMIT { return Err("版本 JSON 超过大小上限".into()); }
    if hex_sha1(bytes) != digest { return Err("版本 JSON 的 SHA-1 校验失败".into()); }
    let value = parse_json(bytes)?;
    if text(&value, "id") != id { return Err("远程版本 JSON 的 id 不匹配".into()); }
    Ok((value, bytes.len() as u64))
}

fn project_list(value: &Value, entries: &[Value]) -> Result<Value> {
    let release = text(&value["latest"], "release");
    let snapshot = text(&value["latest"], "snapshot");
    let mut release_valid = false;
    let mut snapshot_valid = false;
    let mut versions = Vec::new();
    for entry in entries {
        let kind = text(entry, "type");
        if !matches!(kind, "release" | "snapshot") { continue; }
        let id = text(entry, "id");
        let release_time = text(entry, "releaseTime");
        if release_time.is_empty() || release_time.len() > 128 {
            return Err("版本清单缺少有效的发布时间".into());
        }
        release_valid |= kind == "release" && id == release;
        // 发布正式版时，官方 latest.snapshot 也可能指向该正式版。
        snapshot_valid |= id == snapshot;
        versions.push(json!({"id":id,"type":kind,"releaseTime":release_time,"url":text(entry,"url")}));
    }
    if !release_valid || !snapshot_valid { return Err("版本清单 latest 未指向有效的可见版本".into()); }
    Ok(json!({"latest":{"release":release,"snapshot":snapshot},"versions":versions}))
}

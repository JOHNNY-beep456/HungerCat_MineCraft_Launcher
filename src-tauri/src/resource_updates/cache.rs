//! 检测答案只在内存中保存；每次命中前仍须重新取得和验证文件证据。
use super::{model::{DetectedUpdate, LocalQuery}, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Mutex, time::{Duration, Instant}};

const TTL: Duration = Duration::from_secs(600);
const CAP: usize = 512;

#[derive(Clone)]
struct Entry { at: Instant, value: Option<DetectedUpdate> }
#[derive(Default)]
pub(super) struct Cache(Mutex<HashMap<String, Entry>>);

/// 密钥只进入内存摘要；不保留明文，不随候选 DTO 或错误输出。
pub(super) fn policy_key(settings: &Value) -> Result<String> {
    let projection = json!({
        "mode": settings.get("mode"),
        "metadataOnlyMods": settings.get("metadataOnlyMods"),
        "selectedVersionDirId": settings.get("selectedVersionDirId"),
        "gameDirAbs": settings.get("gameDirAbs"),
        "versionDirs": settings.get("versionDirs"),
        "versionIsolation": settings.get("versionIsolation"),
        "isolatedVersions": settings.get("isolatedVersions"),
        "curseforgeApiKey": settings.get("curseforgeApiKey"),
    });
    let bytes = serde_json::to_vec(&projection).map_err(|_| "资源检测配置无法序列化")?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

pub(super) fn key(policy: &str, item: &LocalQuery) -> String {
    // Source 身份和时间由当前 scan 重新读取并验证；答案只依赖完整内容摘要和兼容配置。
    let data = json!([policy, item.kind, item.path, item.filename, item.enabled, item.size,
        item.sha1, item.sha512, item.fingerprint, item.mc_version, item.loader, item.shader_runtimes]);
    format!("{:x}", Sha256::digest(data.to_string().as_bytes()))
}

impl Cache {
    /// 真实更新提交或恢复后，使所有旧答案失效；缓存故障不应触发文件回滚。
    pub(super) fn clear(&self) -> Result<()> {
        self.0.lock().map_err(|_| "资源检测缓存状态不可用")?.clear();
        Ok(())
    }
    pub(super) fn get(&self, key: &str) -> Result<Option<Option<DetectedUpdate>>> {
        self.get_at(key, Instant::now())
    }
    fn get_at(&self, key: &str, now: Instant) -> Result<Option<Option<DetectedUpdate>>> {
        let mut cache = self.0.lock().map_err(|_| "资源检测缓存状态不可用")?;
        cache.retain(|_, entry| now.saturating_duration_since(entry.at) < TTL);
        Ok(cache.get(key).map(|entry| entry.value.clone()))
    }
    pub(super) fn insert(&self, key: String, value: Option<DetectedUpdate>) -> Result<()> {
        let mut cache = self.0.lock().map_err(|_| "资源检测缓存状态不可用")?;
        let now = Instant::now();
        cache.retain(|_, entry| now.saturating_duration_since(entry.at) < TTL);
        if !cache.contains_key(&key) && cache.len() >= CAP {
            if let Some(oldest) = cache.iter().min_by_key(|(_, entry)| entry.at).map(|(key, _)| key.clone()) {
                cache.remove(&oldest);
            }
        }
        cache.insert(key, Entry { at: now, value });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resource_updates::model::ResourceKind;
    use std::path::PathBuf;

    fn item() -> LocalQuery { LocalQuery {
        kind: ResourceKind::Mod, path: PathBuf::from("/fixture/example.jar"), filename: "example.jar".into(),
        enabled: true, size: 4, sha1: "a".repeat(40), sha512: "b".repeat(128), fingerprint: 12,
        mc_version: "1.20.1".into(), loader: Some("fabric".into()), shader_runtimes: Vec::new(),
    } }
    #[test]
    fn cache_key_binds_content_compatibility_mode_root_and_provider() {
        let settings = json!({"mode":"normal","gameDirAbs":"/fixture","curseforgeApiKey":"fixture-key"});
        let policy = policy_key(&settings).unwrap(); let base = key(&policy, &item());
        for field in ["mode", "gameDirAbs", "curseforgeApiKey", "versionIsolation", "metadataOnlyMods", "selectedVersionDirId"] {
            let mut next = settings.clone(); next[field] = json!("changed");
            assert_ne!(key(&policy_key(&next).unwrap(), &item()), base);
        }
        let mut changed = item(); changed.sha512 = "c".repeat(128); assert_ne!(key(&policy, &changed), base);
        changed = item(); changed.mc_version = "1.21".into(); assert_ne!(key(&policy, &changed), base);
        changed = item(); changed.loader = Some("quilt".into()); assert_ne!(key(&policy, &changed), base);
        changed = item(); changed.enabled = false; assert_ne!(key(&policy, &changed), base);
        assert!(!policy.contains("fixture-key"));
    }
    #[test]
    fn negative_answers_expire_and_storage_is_bounded() {
        let cache = Cache::default(); cache.insert("negative".into(), None).unwrap();
        assert!(matches!(cache.get("negative").unwrap(), Some(None)));
        assert!(cache.get_at("negative", Instant::now() + TTL).unwrap().is_none());
        for i in 0..CAP + 20 { cache.insert(i.to_string(), None).unwrap(); }
        assert_eq!(cache.0.lock().unwrap().len(), CAP);
        assert!(cache.get("absent-error").unwrap().is_none());
        cache.clear().unwrap();
        assert!(cache.0.lock().unwrap().is_empty());
        assert!(cache.get("negative").unwrap().is_none());
    }
}

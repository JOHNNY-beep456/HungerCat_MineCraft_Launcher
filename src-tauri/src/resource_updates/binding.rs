//! 更新应用的本地选择绑定；界面路径仅匹配只读清单，不用于推导目标目录。
use super::{access, cache, local, model::{LocalQuery, ResourceKind, UpdateInfo}, Result, CHANGED};
use serde_json::Value;
use std::{path::{Component, Path, PathBuf}, sync::{Arc, atomic::AtomicBool}};

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const INVALID: &str = "资源更新参数无效 / 資源更新參數無效 / Invalid resource update arguments";

#[derive(Clone, Debug)]
pub(super) struct ApplyRequest {
    pub(super) instance_id: String,
    pub(super) update: UpdateInfo,
    pub(super) enabled: bool,
}

impl ApplyRequest {
    pub(super) fn parse(args: &[Value]) -> Result<Self> {
        if args.len() != 3 { return Err(INVALID.into()); }
        let instance_id = args[0].as_str().ok_or(INVALID)?;
        access::leaf(instance_id).map_err(|_| INVALID.to_owned())?;
        let update: UpdateInfo = serde_json::from_value(args[1].clone()).map_err(|_| INVALID)?;
        let enabled = args[2].as_bool().ok_or(INVALID)?;
        if update.kind != ResourceKind::Mod && !enabled { return Err(INVALID.into()); }
        validate_info(&update)?;
        Ok(Self { instance_id: instance_id.into(), update, enabled })
    }
}

fn bounded_label(value: &str, limit: usize, empty_allowed: bool) -> bool {
    (empty_allowed || !value.is_empty()) && value.len() <= limit && !value.chars().any(char::is_control)
}

fn validate_info(info: &UpdateInfo) -> Result<()> {
    if !bounded_label(&info.path, 32768, false) || !bounded_label(&info.file_url, 8192, false)
        || !bounded_label(&info.current_version, 1024, true) || !bounded_label(&info.latest_version, 1024, false)
        || !bounded_label(&info.slug, 1024, false) || !bounded_label(&info.title, 1024, false)
        || info.size == 0 || info.size > MAX_FILE_BYTES {
        return Err(INVALID.into());
    }
    access::leaf(&info.filename).map_err(|_| INVALID.to_owned())?;
    let path = Path::new(&info.path);
    if !path.is_absolute() || path.components().any(|part| matches!(part, Component::CurDir | Component::ParentDir)) {
        return Err(INVALID.into());
    }
    // 不在此处创建 URL 下载能力；地址、名称及所有其余字段均须随后与新取的官方候选逐项相等。
    Ok(())
}

fn choose<'a>(request: &ApplyRequest, items: impl IntoIterator<Item = (usize, &'a LocalQuery)>) -> Result<usize> {
    let mut selected = None;
    for (index, query) in items {
        if query.kind != request.update.kind || query.path.to_str() != Some(request.update.path.as_str()) { continue; }
        if selected.is_some() { return Err(CHANGED.into()); }
        if query.kind == ResourceKind::Mod {
            if query.enabled != request.enabled { return Err(CHANGED.into()); }
        } else if !query.enabled {
            // 非模组合同没有启停参数；不隐式启用带 .disabled 的资源。
            return Err(CHANGED.into());
        }
        selected = Some(index);
    }
    selected.ok_or_else(|| CHANGED.into())
}

/// 持有扫描得到的目录、版本、隔离及所有本地资源证据。
/// 此结构不是写入能力；提交层仍须取得根锁、运行租约并按当前配置重新验证。
pub(super) struct Selection {
    pub(super) request: ApplyRequest,
    pub(super) inventory: Arc<local::Inventory>,
    root: PathBuf,
    policy: String,
    index: usize,
}

impl Selection {
    pub(super) fn scan(root: &Path, request: ApplyRequest, settings: &Value, cancel: &AtomicBool) -> Result<Self> {
        super::check(cancel)?;
        if !super::network_allowed(settings) { return Err(CHANGED.into()); }
        let current = crate::operation_game_dir("resources:applyUpdate", &[], settings)?;
        if current != root { return Err(CHANGED.into()); }
        let policy = cache::policy_key(settings)?;
        let inventory = Arc::new(local::scan(root, &request.instance_id, settings, cancel)?);
        let index = choose(&request, inventory.items.iter().enumerate().map(|(index, item)| (index, &item.query)))?;
        inventory.verify(settings, cancel)?;
        Ok(Self { request, inventory, root: root.to_owned(), policy, index })
    }

    pub(super) fn query(&self) -> &LocalQuery { &self.inventory.items[self.index].query }
    pub(super) fn root(&self) -> &Path { &self.root }
    pub(super) fn policy(&self) -> &str { &self.policy }
    pub(super) fn installed(&self) -> Vec<LocalQuery> { self.inventory.items.iter().map(|item| item.query.clone()).collect() }
    pub(super) fn directory(&self) -> Result<&Path> { self.query().path.parent().ok_or_else(|| INVALID.into()) }

    /// 不读取资源内容；可在同一个 Storage 短闭包内核对配置和受控证据。
    pub(super) fn verify_context(&self, settings: &Value, cancel: &AtomicBool) -> Result<()> {
        super::check(cancel)?;
        if !super::network_allowed(settings) || cache::policy_key(settings)? != self.policy
            || crate::operation_game_dir("resources:applyUpdate", &[], settings)? != self.root {
            return Err(CHANGED.into());
        }
        self.inventory.verify_context(settings, cancel)?;
        if choose(&self.request, self.inventory.items.iter().enumerate().map(|(index, item)| (index, &item.query)))? != self.index {
            return Err(CHANGED.into());
        }
        super::check(cancel)
    }

    /// 内容摘要复核应在 Storage 锁之外执行；随后短闭包复核策略和文件身份再提交。
    pub(super) fn verify(&self, settings: &Value, cancel: &AtomicBool) -> Result<()> {
        self.verify_context(settings, cancel)?;
        self.inventory.verify(settings, cancel)?;
        super::check(cancel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn query(kind: ResourceKind, enabled: bool) -> LocalQuery {
        LocalQuery { kind, path: std::env::temp_dir().join(if enabled { "example.jar" } else { "example.jar.disabled" }),
            filename: "example.jar".into(), enabled, size: 4, sha1: "a".repeat(40), sha512: "b".repeat(128),
            fingerprint: 1, mc_version: "1.20.1".into(), loader: Some("fabric".into()), shader_runtimes: Vec::new() }
    }
    fn args(item: &LocalQuery) -> Vec<Value> {
        vec![json!("fixture"), json!({"path":item.path,"kind":item.kind,"currentVersion":"1", "latestVersion":"2",
            "fileUrl":"https://cdn.modrinth.com/data/project/versions/next/example.jar", "filename":"example.jar",
            "size":8,"slug":"example","title":"示例"}), json!(item.enabled)]
    }

    #[test]
    fn apply_contract_preserves_exact_three_arguments_and_original_dto() {
        let item = query(ResourceKind::Mod, true);
        let original = args(&item);
        assert_eq!(ApplyRequest::parse(&original).unwrap().instance_id, "fixture");
        assert!(ApplyRequest::parse(&original[..2]).is_err());
        let mut extra = original.clone(); extra.push(json!(true));
        assert!(ApplyRequest::parse(&extra).is_err());
        let mut bad_bool = original.clone(); bad_bool[2] = json!("true");
        assert!(ApplyRequest::parse(&bad_bool).is_err());
        let mut extra_field = original.clone(); extra_field[1]["confirmed"] = json!(true);
        assert!(ApplyRequest::parse(&extra_field).is_err());
        let mut missing = original.clone(); missing[1].as_object_mut().unwrap().remove("filename");
        assert!(ApplyRequest::parse(&missing).is_err());
    }

    #[test]
    fn only_current_inventory_member_and_actual_enabled_state_can_be_selected() {
        let item = query(ResourceKind::Mod, true);
        let request = ApplyRequest::parse(&args(&item)).unwrap();
        assert_eq!(choose(&request, [(7, &item)]).unwrap(), 7);
        assert!(choose(&request, std::iter::empty()).is_err());
        assert!(choose(&request, [(0, &item), (1, &item)]).is_err());
        let mut other = item.clone(); other.path = std::env::temp_dir().join("another.jar");
        assert!(choose(&request, [(0, &other)]).is_err());
        let mut disabled = request.clone(); disabled.enabled = false;
        assert!(choose(&disabled, [(0, &item)]).is_err());
        let disabled_item = query(ResourceKind::Mod, false);
        let disabled_request = ApplyRequest::parse(&args(&disabled_item)).unwrap();
        assert_eq!(choose(&disabled_request, [(0, &disabled_item)]).unwrap(), 0);
        let pack = query(ResourceKind::ResourcePack, false);
        assert!(ApplyRequest::parse(&args(&pack)).is_err());
    }

    #[test]
    fn local_selection_does_not_accept_relative_paths_or_unbounded_metadata() {
        let item = query(ResourceKind::Mod, true);
        let mut value = args(&item); value[1]["path"] = json!("mods/example.jar");
        assert!(ApplyRequest::parse(&value).is_err());
        value = args(&item); value[1]["size"] = json!(0);
        assert!(ApplyRequest::parse(&value).is_err());
        value = args(&item); value[1]["title"] = json!("x".repeat(1025));
        assert!(ApplyRequest::parse(&value).is_err());
        value = args(&item); value[0] = json!("../fixture");
        assert!(ApplyRequest::parse(&value).is_err());
    }
}

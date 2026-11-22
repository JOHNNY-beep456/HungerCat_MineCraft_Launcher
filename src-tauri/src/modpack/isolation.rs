use super::{access::{leaf, Directory, DirectoryMark, Source}, Result};
use serde_json::Value;
use std::{io::Read, path::Path};

const MARKER: &str = "instance.json";
const MARKER_CAP: u64 = 64 * 1024;

pub(super) fn legacy(settings: &Value, id: &str) -> bool {
    settings.get("versionIsolation").and_then(Value::as_bool).unwrap_or(false)
        || settings.get("isolatedVersions").and_then(Value::as_array)
            .is_some_and(|ids| ids.iter().any(|value| value.as_str() == Some(id)))
}

pub(crate) struct Snapshot {
    pub(crate) isolated: bool,
    directory: DirectoryMark,
    marker: Option<Source>,
}

impl Snapshot {
    pub(crate) fn verify(&self) -> Result<()> {
        let directory = self.directory.open()?;
        match &self.marker {
            Some(source) => source.verify()?,
            None if directory.child(MARKER)?.is_some() => return Err("实例隔离标记在操作期间已出现，请重试".into()),
            None => {}
        }
        directory.verify()
    }
}

pub(super) fn read(root: &Path, id: &str, settings: &Value) -> Result<Snapshot> {
    leaf(id)?;
    let root = Directory::open(root)?;
    let versions = root.directory(root.child("versions")?.ok_or("实例版本目录不存在")?)?;
    let directory = versions.directory(versions.child(id)?.ok_or("实例目录不存在")?)?;
    let marker = match directory.child(MARKER)? {
        None => None,
        Some(node) if node.meta.is_file() => Some(directory.source(MARKER)?),
        Some(_) => return Err("实例隔离标记不是普通文件".into()),
    };
    let marked = if let Some(source) = &marker {
        if source.len() > MARKER_CAP { return Err("实例隔离标记超过大小上限".into()); }
        let mut opened = source.open()?;
        let mut bytes = Vec::new();
        (&mut opened.file).take(MARKER_CAP + 1).read_to_end(&mut bytes).map_err(|_| "无法读取实例隔离标记")?;
        opened.verify()?;
        if bytes.len() as u64 != source.len() || bytes.len() as u64 > MARKER_CAP { return Err("实例隔离标记大小已改变".into()); }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "实例隔离标记不是有效 JSON")?;
        let object = value.as_object().ok_or("实例隔离标记必须为对象")?;
        match object.get("isolation") {
            None | Some(Value::Null) => false,
            Some(Value::Bool(value)) => *value,
            Some(_) => return Err("实例隔离标记的 isolation 必须为布尔值".into()),
        }
    } else { false };
    // PCL / HMCL 式隔离实例没有 instance.json 标记、设置里也没登记（换机或迁移后
    // isolatedVersions 丢失很常见）：物理布局上「实例 mods 非空而根 mods 为空」时按隔离处理，
    // 否则这类实例的模组 / 存档列表会回落到空的游戏根目录，直接显示为空。
    // 保守规则：根 mods 也有内容时不抢判定，仍按设置走共享根，避免误伤刻意共享 mods 的用户。
    let legacy_flag = legacy(settings, id);
    let physical = !legacy_flag && !marked && instance_has_content_but_root_not(&root, &directory)?;
    let snapshot = Snapshot { isolated: legacy_flag || marked || physical, directory: directory.mark(), marker };
    snapshot.verify()?;
    Ok(snapshot)
}

/// 目录名对应的内容目录存在且至少有一个条目。
/// names() 的预算是硬上限：预算耗尽即证明条目数超过预算，同样视为「非空」。
fn dir_has_entries(directory: &Directory, name: &str) -> Result<bool> {
    let Some(node) = directory.child(name)? else { return Ok(false) };
    if !node.meta.is_dir() { return Ok(false); }
    let open = directory.directory(node)?;
    let mut budget = 1usize;
    match open.names(&mut budget) {
        Ok(names) => Ok(!names.is_empty()),
        Err(error) if error.contains("遍历预算") => Ok(true),
        Err(error) => Err(error),
    }
}

/// 物理布局自动识别的判据：实例目录有 mods 内容，而游戏根目录的 mods 缺失或为空。
fn instance_has_content_but_root_not(root: &Directory, instance: &Directory) -> Result<bool> {
    Ok(dir_has_entries(instance, "mods")? && !dir_has_entries(root, "mods")?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{fs, path::PathBuf};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("hcmcl-instance-isolation-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(root.join("versions/same" )).unwrap();
            Self(fs::canonicalize(root).unwrap())
        }
        fn marker(&self, bytes: &[u8]) { fs::write(self.0.join("versions/same/instance.json"), bytes).unwrap(); }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[test]
    fn per_instance_marker_is_root_scoped_and_legacy_flags_remain_compatible() {
        let first = Fixture::new();
        let second = Fixture::new();
        first.marker(br#"{"isolation":true}"#);
        assert!(read(&first.0, "same", &json!({})).unwrap().isolated);
        assert!(!read(&second.0, "same", &json!({})).unwrap().isolated);
        first.marker(br#"{"isolation":false,"name":"same"}"#);
        for settings in [json!({"versionIsolation":true}), json!({"isolatedVersions":["same"]})] {
            assert!(read(&first.0, "same", &settings).unwrap().isolated);
        }
        assert!(!read(&first.0, "same", &json!({"isolatedVersions":["other"]})).unwrap().isolated);
        assert!(!first.0.join(".hcmcl-install.lock").exists());
    }

    #[test]
    fn invalid_marker_never_silently_falls_back_to_shared_game_root() {
        let fixture = Fixture::new();
        for bytes in [b"invalid".as_slice(), b"[]", br#"{"isolation":"true"}"#] {
            fixture.marker(bytes);
            assert!(read(&fixture.0, "same", &json!({"versionIsolation":true})).is_err());
        }
        fixture.marker(&vec![b' '; MARKER_CAP as usize + 1]);
        assert!(read(&fixture.0, "same", &json!({})).is_err());
        fs::remove_file(fixture.0.join("versions/same/instance.json")).unwrap();
        fs::create_dir(fixture.0.join("versions/same/instance.json")).unwrap();
        assert!(read(&fixture.0, "same", &json!({})).is_err());
        assert!(read(&fixture.0.join("missing"), "same", &json!({})).is_err());
        assert!(!fixture.0.join("missing").exists());
        assert!(read(&fixture.0, "../same", &json!({})).is_err());
    }

    #[test]
    fn marker_changes_and_late_marker_creation_invalidate_the_selection() {
        let fixture = Fixture::new();
        let absent = read(&fixture.0, "same", &json!({})).unwrap();
        fixture.marker(br#"{"isolation":true}"#);
        assert!(absent.verify().is_err());
        let present = read(&fixture.0, "same", &json!({})).unwrap();
        fixture.marker(br#"{"isolation":false}"#);
        assert!(present.verify().is_err());
    }

    #[test]
    fn hardlinked_marker_is_rejected_without_modifying_the_source() {
        let fixture = Fixture::new();
        let outside = fixture.0.join("outside.json");
        fs::write(&outside, br#"{"isolation":true}"#).unwrap();
        fs::hard_link(&outside, fixture.0.join("versions/same/instance.json")).unwrap();
        assert!(read(&fixture.0, "same", &json!({})).is_err());
        assert_eq!(fs::read(&outside).unwrap(), br#"{"isolation":true}"#);
    }

    #[test]
    fn physical_layout_detects_unmarked_pcl_style_isolation() {
        let fixture = Fixture::new();
        // 实例 mods 非空、根 mods 缺失 → 自动隔离（PCL/HMCL 式无标记实例）。
        fs::create_dir_all(fixture.0.join("versions/same/mods")).unwrap();
        fs::write(fixture.0.join("versions/same/mods/a.jar"), b"x").unwrap();
        assert!(read(&fixture.0, "same", &json!({})).unwrap().isolated);
        // 根 mods 也有内容 → 不抢判定，仍走共享根（避免误伤刻意共享 mods 的用户）。
        fs::create_dir_all(fixture.0.join("mods")).unwrap();
        fs::write(fixture.0.join("mods/shared.jar"), b"x").unwrap();
        assert!(!read(&fixture.0, "same", &json!({})).unwrap().isolated);
        // 显式登记优先：即使根 mods 为空，isolatedVersions 里有的实例保持隔离。
        assert!(read(&fixture.0, "same", &json!({"isolatedVersions":["same"]})).unwrap().isolated);
        // 根 mods 存在但为空 → 仍按自动隔离（PCL 常见：根 mods 是空壳目录）。
        fs::remove_file(fixture.0.join("mods/shared.jar")).unwrap();
        assert!(read(&fixture.0, "same", &json!({})).unwrap().isolated);
        // 实例 mods 为空目录 → 不视为隔离。
        fs::remove_file(fixture.0.join("versions/same/mods/a.jar")).unwrap();
        assert!(!read(&fixture.0, "same", &json!({})).unwrap().isolated);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_marker_is_rejected_without_following_it() {
        let fixture = Fixture::new();
        let outside = fixture.0.join("outside.json");
        fs::write(&outside, br#"{"isolation":true}"#).unwrap();
        std::os::unix::fs::symlink(&outside, fixture.0.join("versions/same/instance.json")).unwrap();
        assert!(read(&fixture.0, "same", &json!({})).is_err());
    }
}

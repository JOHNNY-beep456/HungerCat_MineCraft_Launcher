//! 资源更新的内部证据与既有界面 DTO；官方身份和依赖不作为前端修改授权。
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub(crate) enum ResourceKind {
    #[serde(rename = "mod")]
    Mod,
    #[serde(rename = "resourcepack")]
    ResourcePack,
    #[serde(rename = "shader")]
    Shader,
}

impl ResourceKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Mod => "mod",
            Self::ResourcePack => "resourcepack",
            Self::Shader => "shader",
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct LocalQuery {
    pub(crate) kind: ResourceKind,
    pub(crate) path: PathBuf,
    pub(crate) filename: String,
    pub(crate) enabled: bool,
    pub(crate) size: u64,
    pub(crate) sha1: String,
    pub(crate) sha512: String,
    pub(crate) fingerprint: u32,
    pub(crate) mc_version: String,
    pub(crate) loader: Option<String>,
    pub(crate) shader_runtimes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateInfo {
    pub(crate) path: String,
    pub(crate) kind: ResourceKind,
    pub(crate) current_version: String,
    pub(crate) latest_version: String,
    pub(crate) file_url: String,
    pub(crate) filename: String,
    pub(crate) size: u64,
    pub(crate) slug: String,
    pub(crate) title: String,
}

#[derive(Clone, Debug)]
pub(crate) struct DetectedUpdate {
    pub(crate) info: UpdateInfo,
    pub(crate) source: String,
    pub(crate) project_id: String,
    pub(crate) version_id: String,
    pub(crate) sha1: Option<String>,
    pub(crate) sha512: Option<String>,
    pub(crate) dependencies: Vec<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn update_projection_preserves_original_contract_without_internal_authority() {
        let value = UpdateInfo {
            path: "/fixture/mods/example.jar.disabled".into(), kind: ResourceKind::Mod,
            current_version: "1.0".into(), latest_version: "2.0".into(),
            file_url: "https://cdn.modrinth.com/fixture/example.jar".into(),
            filename: "example.jar".into(), size: 12, slug: "example".into(), title: "示例".into(),
        };
        let projected = serde_json::to_value(&value).unwrap();
        assert_eq!(projected, json!({"path":"/fixture/mods/example.jar.disabled","kind":"mod",
            "currentVersion":"1.0","latestVersion":"2.0","fileUrl":"https://cdn.modrinth.com/fixture/example.jar",
            "filename":"example.jar","size":12,"slug":"example","title":"示例"}));
        assert_eq!(serde_json::from_value::<UpdateInfo>(projected.clone()).unwrap(), value);
        let mut forged = projected;
        forged["authorized"] = json!(true);
        assert!(serde_json::from_value::<UpdateInfo>(forged).is_err());
        assert!(serde_json::from_value::<ResourceKind>(json!("resourcepacks")).is_err());
    }
}

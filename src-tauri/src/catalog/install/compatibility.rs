//! 官方模组版本标签与已确认的实例版本比较；不选择或下载额外依赖。
//!
//! 错误以 `HC_COMPAT|<KIND>|...` 机器可读码返回，前端按所选语言翻译；
//! 多语言展示文案不要写在这里（用户语言只有界面知道）。
use serde_json::Value;
type Result<T> = std::result::Result<T, String>;
/// 官方元数据缺失或结构无效。
const INVALID: &str = "HC_COMPAT|METADATA";

/// 列出文件侧声明的值（至多 8 个 + 省略号），用于错误参数。
fn summarize(values: &[String]) -> String {
    const MAX: usize = 8;
    let mut joined = values.iter().take(MAX).map(String::as_str).collect::<Vec<_>>().join(",");
    if values.len() > MAX { joined.push_str(",…"); }
    joined
}

#[derive(Clone, Debug)]
pub(super) struct Tags { games: Vec<String>, loaders: Vec<String> }
fn strings(value: &Value, key: &str) -> Result<Vec<String>> {
    let rows = value.get(key).and_then(Value::as_array).filter(|rows| !rows.is_empty() && rows.len() <= 1024).ok_or(INVALID)?;
    rows.iter().map(|row| row.as_str().filter(|text| !text.is_empty() && text.len() <= 256 && !text.chars().any(char::is_control))
        .map(str::to_owned).ok_or_else(|| INVALID.into())).collect()
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str { value.get(key).and_then(Value::as_str).unwrap_or("") }
impl Tags {
    pub(super) fn modrinth(version: &Value, project: &Value) -> Result<Self> {
        let id = text(project, "id");
        if id.is_empty() || text(version, "project_id") != id || text(project, "project_type") != "mod"
            || text(project, "client_side") == "unsupported" { return Err(INVALID.into()); }
        Ok(Self { games: strings(version, "game_versions")?, loaders: strings(version, "loaders")? })
    }
    pub(super) fn curseforge(file: &Value, project: &Value) -> Result<Self> {
        let id = project.get("id").and_then(Value::as_u64).filter(|id| *id > 0).ok_or(INVALID)?;
        if file.get("modId").and_then(Value::as_u64) != Some(id)
            || project.get("gameId").and_then(Value::as_u64) != Some(432)
            || project.get("classId").and_then(Value::as_u64) != Some(6) { return Err(INVALID.into()); }
        let tags = strings(file, "gameVersions")?;
        let loaders = tags.iter().map(|tag| tag.to_ascii_lowercase())
            .filter(|tag| matches!(tag.as_str(), "fabric" | "quilt" | "forge" | "neoforge")).collect();
        Ok(Self { games: tags, loaders })
    }
    // 仅供固定 Fabric API 查询返回的、已核验 game_versions/loaders 的文件使用。
    pub(super) fn fabric(game: &str) -> Self { Self { games: vec![game.into()], loaders: vec!["fabric".into()] } }
    pub(super) fn check(&self, game: &str, loader: Option<&str>) -> Result<()> {
        let loader = loader.filter(|loader| matches!(*loader, "fabric" | "quilt" | "forge" | "neoforge"))
            .ok_or_else(|| "HC_COMPAT|NO_LOADER".to_owned())?;
        if !self.games.iter().any(|tag| tag == game) {
            return Err(format!("HC_COMPAT|GAME|{game}|{}", summarize(&self.games)));
        }
        if !self.loaders.iter().any(|tag| tag.eq_ignore_ascii_case(loader)) {
            return Err(format!("HC_COMPAT|LOADER|{loader}|{}", summarize(&self.loaders)));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn modrinth_tags_match_exact_game_and_actual_loader() {
        let project = json!({"id":"project","project_type":"mod","client_side":"required"});
        let version = json!({"project_id":"project","game_versions":["1.21.1","26.4-snapshot-1"],"loaders":["fabric"]});
        let tags = Tags::modrinth(&version, &project).unwrap();
        assert!(tags.check("1.21.1", Some("fabric")).is_ok());
        assert!(tags.check("26.4-snapshot-1", Some("fabric")).is_ok());
        assert!(tags.check("1.21", Some("fabric")).is_err());
        assert!(tags.check("1.21.1", Some("forge")).is_err());
        assert!(tags.check("1.21.1", None).is_err());
        let mut server = project; server["client_side"] = json!("unsupported");
        assert!(Tags::modrinth(&version, &server).is_err());
    }
    #[test]
    fn curseforge_neoforge_and_forge_remain_distinct() {
        let project = json!({"id":12,"gameId":432,"classId":6});
        let file = json!({"modId":12,"gameVersions":["1.21.1","NeoForge"]});
        let tags = Tags::curseforge(&file, &project).unwrap();
        assert!(tags.check("1.21.1", Some("neoforge")).is_ok());
        assert!(tags.check("1.21.1", Some("forge")).is_err());
        assert!(tags.check("1.20.1", Some("neoforge")).is_err());
    }
    #[test]
    fn fabric_api_requires_the_same_instance_game_and_fabric() {
        let tags = Tags::fabric("1.21.1");
        assert!(tags.check("1.21.1", Some("fabric")).is_ok());
        assert!(tags.check("1.21.1", Some("quilt")).is_err());
        assert!(tags.check("1.20.1", Some("fabric")).is_err());
    }
    #[test]
    fn errors_are_machine_readable_codes_with_bounded_details() {
        let tags = Tags { games: vec!["1.21.1".into()], loaders: vec!["fabric".into(), "quilt".into()] };
        assert_eq!(tags.check("1.20.1", Some("fabric")).unwrap_err(), "HC_COMPAT|GAME|1.20.1|1.21.1");
        assert_eq!(tags.check("1.21.1", Some("forge")).unwrap_err(), "HC_COMPAT|LOADER|forge|fabric,quilt");
        assert_eq!(tags.check("1.21.1", None).unwrap_err(), "HC_COMPAT|NO_LOADER");
        let many: Vec<String> = (0..20).map(|index| format!("1.21.{index}")).collect();
        let tags = Tags { games: many.clone(), loaders: vec!["fabric".into()] };
        let error = tags.check("1.20.1", Some("fabric")).unwrap_err();
        assert!(error.starts_with("HC_COMPAT|GAME|1.20.1|"));
        assert!(error.ends_with(",…"));
        assert!(error.len() < 128);
    }
}

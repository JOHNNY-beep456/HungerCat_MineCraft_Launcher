//! 共享 HUD 只取得三项公开状态，不承接大厅参数、聊天或路由地址。
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Preferences { pub enabled: bool, pub opacity: f64 }
impl Default for Preferences { fn default() -> Self { Self { enabled: false, opacity: 0.8 } } }
impl Preferences {
    pub(super) fn read(settings: &Value) -> Self {
        Self {
            enabled: settings.get("hudEnabled").and_then(Value::as_bool) == Some(true)
                && settings.get("hudShowMultiplayer").and_then(Value::as_bool) == Some(true),
            opacity: settings.get("hudOpacity").and_then(Value::as_f64)
                .filter(|n| n.is_finite() && (0.0..=1.0).contains(n)).unwrap_or(0.8),
        }
    }
}

pub(super) fn project(preferences: &Preferences, live: bool, players: &[Value]) -> Value {
    let enabled = preferences.enabled && live;
    let rows = if enabled { players.iter().take(129).filter_map(|player| {
        let id = player.get("id")?.as_str().filter(|s| !s.is_empty() && s.len() <= 512)?;
        let name = player.get("name")?.as_str().filter(|s| !s.is_empty() && s.len() <= 128)?;
        let own = player.get("isSelf")?.as_bool()?;
        let mut row = json!({"id":id,"name":name,"isSelf":own});
        if let Some(ip) = player.get("virtualIp").and_then(Value::as_str).filter(|s| s.len() <= 64) {
            row["virtualIp"] = json!(ip);
        }
        Some(row)
    }).collect::<Vec<_>>() } else { Vec::new() };
    json!({"enabled":enabled,"opacity":preferences.opacity,"players":rows})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hud_uses_both_switches_and_live_session_without_private_fields() {
        let preferences = Preferences::read(&json!({"hudEnabled":true,"hudShowMultiplayer":true,"hudOpacity":0.65,"password":"secret"}));
        let players = vec![json!({"id":"self","name":"玩家","isSelf":true,"virtualIp":"10.126.126.1","joinedAt":"private","password":"secret","virtualDomain":"private.mct.net"})];
        let view = project(&preferences, true, &players);
        assert_eq!(view.as_object().unwrap().len(), 3);
        assert_eq!(view["players"][0], json!({"id":"self","name":"玩家","isSelf":true,"virtualIp":"10.126.126.1"}));
        assert_eq!(view["opacity"], 0.65);
        for (settings, live) in [(json!({"hudEnabled":false,"hudShowMultiplayer":true}), true), (json!({"hudEnabled":true,"hudShowMultiplayer":false}), true), (json!({"hudEnabled":true,"hudShowMultiplayer":true}), false)] {
            assert_eq!(project(&Preferences::read(&settings), live, &players)["enabled"], false);
        }
    }
    #[test]
    fn hud_bounds_rows_and_does_not_coerce_invalid_player_or_opacity() {
        let preferences = Preferences::read(&json!({"hudEnabled":true,"hudShowMultiplayer":true,"hudOpacity":2}));
        let players = (0..140).map(|id| json!({"id":id.to_string(),"name":"p","isSelf":false})).collect::<Vec<_>>();
        let view = project(&preferences, true, &players);
        assert_eq!(view["opacity"], 0.8); assert_eq!(view["players"].as_array().unwrap().len(), 129);
        assert_eq!(project(&preferences, true, &[json!({"id":1,"name":"p","isSelf":true}), json!({"id":"1","name":"p","isSelf":"true"})])["players"], json!([]));
        assert_eq!(project(&preferences, false, &players)["players"], json!([]));
    }
}
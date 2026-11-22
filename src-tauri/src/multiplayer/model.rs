//! 联机诊断的纯投影；不查询账号、网络或运行进程。
use serde_json::{json, Value};
use std::sync::OnceLock;

pub(super) const MAX_OUTPUT: usize = 1024 * 1024;

/// 保留 Electron 的首个合法匹配和原始文本，包括前导零；只识别约定虚拟网段。
pub(super) fn virtual_ip(output: &str) -> Option<String> {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| regex::Regex::new(r"10\.126\.126\.[0-9]{1,3}").expect("固定虚拟网段表达式"));
    pattern.find_iter(output).find_map(|item| {
        let last = item.as_str().rsplit('.').next()?.parse::<u16>().ok()?;
        (1..=254).contains(&last).then(|| item.as_str().to_owned())
    })
}

pub(super) fn danmaku_config(settings: &Value) -> Value {
    let integer = |key: &str, fallback: u64| settings.get(key).and_then(Value::as_f64)
        .filter(|n| n.is_finite() && (1.0..=256.0).contains(n) && n.fract() == 0.0)
        .map(|n| n as u64).unwrap_or(fallback);
    let number = |key: &str, min: f64, max: f64, fallback: f64| settings.get(key).and_then(Value::as_f64)
        .filter(|n| n.is_finite() && (min..=max).contains(n)).unwrap_or(fallback);
    json!({
        "enabled": settings.get("multiplayerDanmakuEnabled").and_then(Value::as_bool).unwrap_or(true),
        "fontSize": integer("multiplayerDanmakuFontSize", 16),
        "speed": number("multiplayerDanmakuSpeed", 0.1, 3600.0, 8.0),
        "opacity": number("multiplayerDanmakuOpacity", 0.0, 1.0, 0.85),
        "tracks": integer("multiplayerDanmakuTracks", 4),
    })
}

pub(super) fn tr(language: &str, cn: &str, tw: &str, en: &str) -> String {
    match language {
        "en" => en.into(),
        "zh-TW" => tw.into(),
        _ => cn.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn virtual_ip_keeps_the_existing_first_match_and_network_range() {
        assert_eq!(virtual_ip("route 192.168.1.1; 10.126.126.0 10.126.126.255; lease 10.126.126.254"), Some("10.126.126.254".into()));
        assert_eq!(virtual_ip("10.126.126.001 then 10.126.126.2"), Some("10.126.126.001".into()));
        assert_eq!(virtual_ip("10.127.126.1 / 10.126.126.999"), None);
        assert_eq!(virtual_ip("10.126.126.１２"), None);
    }

    #[test]
    fn danmaku_projection_has_only_the_existing_five_public_fields() {
        let input = json!({"multiplayerDanmakuEnabled": false, "multiplayerDanmakuFontSize": 22,
            "multiplayerDanmakuSpeed": 12.5, "multiplayerDanmakuOpacity": 0.7, "multiplayerDanmakuTracks": 7,
            "multiplayerLobbyPassword": "fixture-private", "accounts": [{"fixture": true}], "aiApiKey": "fixture-key"});
        assert_eq!(danmaku_config(&input), json!({"enabled": false,"fontSize":22,"speed":12.5,"opacity":0.7,"tracks":7}));
        assert_eq!(danmaku_config(&json!({"multiplayerDanmakuFontSize": 22.0, "multiplayerDanmakuTracks": 7.0}))["fontSize"], 22);
        assert_eq!(danmaku_config(&json!({"multiplayerDanmakuFontSize": 22.5}))["fontSize"], 16);
        assert_eq!(danmaku_config(&json!({"multiplayerDanmakuFontSize": 0, "multiplayerDanmakuSpeed": -1,
            "multiplayerDanmakuOpacity": 2, "multiplayerDanmakuTracks": "4"})), danmaku_config(&json!({})));
    }
}

//! 真实会话的参数与代次模型；就绪必须来自当前 core，停止必须收到真实收尾。
use serde_json::{json, Value};

type Result<T> = std::result::Result<T, String>;
fn invalid() -> String { "大厅参数无效 / 大廳參數無效 / Invalid lobby parameters".into() }
fn text(value: &Value, key: &str, max: usize) -> Result<String> {
    let raw = value.get(key).and_then(Value::as_str).ok_or_else(invalid)?;
    if raw.len() > max * 4 || raw.chars().any(char::is_control) { return Err(invalid()); }
    let text = raw.trim();
    if text.encode_utf16().count() > max { return Err(invalid()); }
    Ok(text.into())
}
#[derive(Clone)]
pub(super) struct Params {
    pub name: String, pub password: String, pub player_name: String, pub player_id: String,
    pub server_node: String, pub signaling_server: String, pub use_domain: bool,
}
impl Params {
    pub fn parse(value: &Value) -> Result<Self> {
        let object = value.as_object().ok_or_else(invalid)?;
        if object.keys().any(|key| !matches!(key.as_str(), "name"|"password"|"playerName"|"playerId"|"serverNode"|"signalingServer"|"useDomain")) { return Err(invalid()); }
        let name = text(value, "name", 32)?;
        if name.encode_utf16().count() < 4 || !name.chars().all(|c| c.is_ascii_alphanumeric() || ('\u{4e00}'..='\u{9fa5}').contains(&c) || matches!(c, '_'|'-') || c.is_whitespace()) { return Err(invalid()); }
        let password = text(value, "password", 32)?;
        if !password.is_empty() && (password.encode_utf16().count() < 8 || !password.chars().any(|c| c.is_ascii_alphabetic()) || !password.chars().any(|c| c.is_ascii_digit())) { return Err(invalid()); }
        let player_name = text(value, "playerName", 8)?;
        let player_id = text(value, "playerId", 128)?;
        if player_name.is_empty() || player_id.is_empty() { return Err(invalid()); }
        let node = text(value, "serverNode", 2048)?;
        let server_node = if node.is_empty() { "udp://us01.225284.xyz:11010".into() } else { node };
        validate_node(&server_node)?;
        let signal = text(value, "signalingServer", 2048)?;
        let signaling_server = if signal.is_empty() { "wss://mctier.pmhs.top/signaling".into() } else { signal };
        let url = url::Url::parse(&signaling_server).map_err(|_| invalid())?;
        if !matches!(url.scheme(), "ws"|"wss") || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() { return Err(invalid()); }
        let use_domain = match value.get("useDomain") { None => false, Some(v) => v.as_bool().ok_or_else(invalid)? };
        Ok(Self { name, password, player_name, player_id, server_node, signaling_server, use_domain })
    }
    pub fn hostname(&self) -> String {
        let value: String = self.player_name.chars().filter(|c| c.is_alphanumeric() || matches!(c, '_'|'-')).flat_map(char::to_lowercase).collect();
        if value.is_empty() { "player".into() } else { value }
    }
    pub fn lobby(&self, ip: &str, host: bool, at: &str) -> Value {
        json!({"name":self.name,"password":self.password,"serverNode":self.server_node,"signalingServer":self.signaling_server,
            "virtualIp":ip,"useDomain":self.use_domain,"isHost":host,"createdAt":at})
    }
    pub fn self_player(&self, ip: &str, at: &str) -> Value {
        let mut player = self.peer_player(&self.player_id, &self.player_name, ip, at);
        player["isSelf"] = json!(true); player
    }
    pub fn peer_player(&self, id: &str, name: &str, ip: &str, at: &str) -> Value {
        let mut player = json!({"id":id,"name":name,"useDomain":self.use_domain,"joinedAt":at,"isSelf":false});
        if !ip.is_empty() { player["virtualIp"] = json!(ip); }
        if self.use_domain { player["virtualDomain"] = json!(format!("{}.{}.mct.net", domain_label(name, true, 32, "player"), domain_label(&self.name, false, 24, "lobby"))); }
        player
    }
}
fn domain_label(value: &str, unicode: bool, limit: usize, fallback: &str) -> String {
    let mut out = String::new(); let mut gap = false;
    for c in value.trim().to_lowercase().chars() {
        if if unicode { c.is_alphanumeric() } else { c.is_ascii_alphanumeric() } {
            if gap && !out.is_empty() { out.push('-'); } out.push(c); gap = false;
        } else { gap = true; }
    }
    let out: String = out.chars().take(limit).collect();
    if out.is_empty() { fallback.into() } else { out }
}
fn validate_node(value: &str) -> Result<()> {
    let url = url::Url::parse(value).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "tcp"|"udp"|"ws"|"wss"|"txt") || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() { return Err(invalid()); }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Phase { Idle, Connecting, Live, Stopping, Uncertain }
impl Phase {
    pub fn public(self) -> &'static str { match self { Self::Idle => "idle", Self::Live => "in-lobby", _ => "connecting" } }
}
pub(super) struct Model { pub generation: u64, pub phase: Phase }
impl Default for Model { fn default() -> Self { Self { generation: 0, phase: Phase::Idle } } }
impl Model {
    pub fn begin(&mut self) -> Result<u64> {
        if self.phase != Phase::Idle { return Err("联机会话仍在运行或收尾 / 連線工作階段仍在執行或收尾 / Multiplayer session is still active or stopping".into()); }
        self.generation = self.generation.checked_add(1).ok_or_else(invalid)?;
        self.phase = Phase::Connecting; Ok(self.generation)
    }
    pub fn ready(&mut self, generation: u64) -> bool {
        if generation != self.generation || self.phase != Phase::Connecting { return false; }
        self.phase = Phase::Live; true
    }
    pub fn stop(&mut self) { if matches!(self.phase, Phase::Connecting | Phase::Live) { self.phase = Phase::Stopping; } }
    pub fn unknown(&mut self, generation: u64) { if generation == self.generation && self.phase != Phase::Idle { self.phase = Phase::Uncertain; } }
    pub fn reaped(&mut self, generation: u64) -> bool {
        if generation != self.generation || !matches!(self.phase, Phase::Stopping | Phase::Uncertain) { return false; }
        self.phase = Phase::Idle; true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn params() -> Value { json!({"name":"测试大厅","password":"abc12345","playerName":"玩家_A","playerId":"fixture-id","serverNode":"","signalingServer":"","useDomain":true}) }
    #[test] fn parameters_preserve_fixed_launch_contract_and_reject_command_overrides() {
        let p = Params::parse(&params()).unwrap(); assert_eq!(p.hostname(), "玩家_a");
        assert_eq!(p.server_node, "udp://us01.225284.xyz:11010"); assert_eq!(p.password,"abc12345");
        let mut v=params(); v["advancedArgs"]=json!(["--config-file","elsewhere"]); assert!(Params::parse(&v).is_err());
        for key in ["serverNode", "signalingServer"] { let mut v=params(); v[key]=json!("file:///fixture"); assert!(Params::parse(&v).is_err()); }
        let mut v=params(); v["password"]=json!("onlyletters"); assert!(Params::parse(&v).is_err());
    }
    #[test] fn published_lobby_and_self_player_keep_the_existing_dto_without_fake_peers() {
        let p=Params::parse(&params()).unwrap();let at="2026-11-12T03:20:00.000Z";
        let lobby=p.lobby("10.126.126.7",true,at);
        assert_eq!(lobby.as_object().unwrap().len(),8);assert_eq!(lobby["name"],"测试大厅");
        assert_eq!(lobby["virtualIp"],"10.126.126.7");assert_eq!(lobby["isHost"],true);assert_eq!(lobby["createdAt"],at);
        let own=p.self_player("10.126.126.7",at);assert_eq!(own["id"],"fixture-id");assert_eq!(own["isSelf"],true);
        assert_eq!(own["virtualDomain"],"玩家-a.lobby.mct.net");assert_eq!(own.as_object().unwrap().len(),7);
        let mut value=params();value["useDomain"]=json!(false);let no_domain=Params::parse(&value).unwrap();
        assert!(no_domain.self_player("10.126.126.8",at).get("virtualDomain").is_none());
        assert_eq!(no_domain.lobby("10.126.126.8",false,at)["isHost"],false);
    }
    #[test] fn stopped_or_old_generation_can_never_publish_ready_or_idle() {
        let mut m=Model::default(); let first=m.begin().unwrap(); m.stop(); assert!(!m.ready(first));
        m.unknown(first); assert_eq!(m.phase.public(),"connecting"); assert!(m.begin().is_err());
        assert!(!m.reaped(first+1)); assert!(m.reaped(first)); let next=m.begin().unwrap();
        assert!(!m.ready(first)); assert!(!m.reaped(first)); assert!(!m.reaped(next));assert!(m.ready(next));
        assert!(!m.reaped(next));m.stop();m.unknown(next);m.stop();assert_eq!(m.phase,Phase::Uncertain);
        assert_eq!(m.phase.public(),"connecting");assert!(m.begin().is_err());assert!(m.reaped(next));assert_eq!(m.phase.public(),"idle");
    }
}
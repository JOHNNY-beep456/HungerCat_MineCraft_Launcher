//! 与 Electron 兼容的 UDP 消息模型。报文不是大厅身份认证，不信任任意 JSON 字段。
use serde_json::{json, Value};
use std::{collections::BTreeMap, net::{Ipv4Addr, SocketAddrV4}};

pub(super) const MAX_PACKET: usize = 8192;
pub(super) const MAX_PEERS: usize = 128;
const MAX_HISTORY: usize = 300;
const MAX_DEDUP: usize = 1024;
const MAX_LEFT: usize = 512;
const LEFT_MS: u64 = 6_000;
const DEDUP_MS: u64 = 30_000;
const PEER_MS: u64 = 90_000;

fn text<'a>(v: &'a Value, key: &str, bytes: usize, units: usize) -> Option<&'a str> {
    let s = v.get(key)?.as_str()?;
    (s.len() <= bytes && s.encode_utf16().count() <= units && !s.chars().any(char::is_control)).then_some(s)
}
fn player_id(v: &Value) -> Option<String> { text(v, "playerId", 512, 128).filter(|s| !s.trim().is_empty()).map(str::to_owned) }
fn name(v: &Value) -> Option<String> { text(v, "playerName", 64, 8).filter(|s| !s.trim().is_empty()).map(str::to_owned) }
fn timestamp(v: &Value) -> Option<u64> { v.get("timestamp")?.as_u64().filter(|v| *v <= 9_007_199_254_740_991) }
fn virtual_ip(v: &Value) -> Option<String> {
    match v.get("virtualIp") {
        None => Some(String::new()),
        Some(Value::String(s)) if s.is_empty() => Some(String::new()),
        Some(Value::String(s)) => {
            let ip = s.parse::<Ipv4Addr>().ok()?; let o = ip.octets();
            (o[0..3] == [10,126,126] && (1..=254).contains(&o[3])).then(|| ip.to_string())
        }, _ => None,
    }
}
pub(super) fn chat_text(raw: &str) -> Option<String> {
    let s = raw.trim();
    (raw.len() <= 4096 && raw.encode_utf16().count() <= 2000
        && !raw.chars().any(|c| c.is_control() && !matches!(c, '\n'|'\r'|'\t'))).then(|| s.to_owned())
}
#[derive(Clone)]
pub(super) struct Peer {
    pub id: String, pub name: String, pub virtual_ip: String,
    pub address: SocketAddrV4, pub port: u16, pub joined_at: String, last_seen: u64,
}
#[derive(Default)]
pub(super) struct Effect { pub changed: bool, pub chat: Option<Value>, pub reply: Option<Value> }
pub(super) struct Protocol {
    pub id: String, pub name: String, pub ip: String, pub port: u16,
    peers: BTreeMap<String,Peer>, left: BTreeMap<String,u64>, seen: BTreeMap<String,u64>,
    messages: Vec<Value>, next_message: u64,
}
impl Protocol {
    pub fn new(id: String, name: String, ip: String, port: u16) -> Self {
        Self { id,name,ip,port,peers:BTreeMap::new(),left:BTreeMap::new(),seen:BTreeMap::new(),messages:Vec::new(),next_message:0 }
    }
    pub fn peers(&self) -> impl Iterator<Item=&Peer> { self.peers.values() }
    pub fn messages(&self) -> Vec<Value> { self.messages.clone() }
    pub fn discovery(&self, response: bool) -> Value {
        json!({"type":if response {"player-discovery-response"} else {"player-discovery"},"playerId":self.id,"playerName":self.name,"port":self.port,"virtualIp":self.ip})
    }
    pub fn heartbeat(&self, timestamp: u64) -> Value { json!({"type":"heartbeat","playerId":self.id,"timestamp":timestamp,"virtualIp":self.ip}) }
    pub fn leave(&self) -> Value { json!({"type":"player-left","playerId":self.id}) }
    fn prune(&mut self, now: u64) {
        self.left.retain(|_,at| now.saturating_sub(*at) < LEFT_MS);
        self.seen.retain(|_,at| now.saturating_sub(*at) < DEDUP_MS);
    }
    fn push(&mut self, value: Value) -> bool {
        if self.messages.iter().any(|old| old["id"] == value["id"]) { return false; }
        self.messages.push(value); if self.messages.len() > MAX_HISTORY { self.messages.remove(0); } true
    }
    pub fn local_chat(&mut self, content: &str, timestamp: u64, now: u64) -> Option<(Value,Value)> {
        let content = chat_text(content)?; if content.is_empty() { return None; }
        self.prune(now); self.next_message = self.next_message.checked_add(1)?;
        // 同毫秒多次发送仍有独立稳定 id；旧端按不透明 msgId 接收。
        let id = format!("{}-{}-{}",self.id,timestamp,self.next_message);
        let wire = json!({"type":"chat","playerId":self.id,"playerName":self.name,"content":content,"timestamp":timestamp,"msgId":id});
        let public = json!({"id":id,"playerId":self.id,"playerName":self.name,"content":content,"timestamp":timestamp,"isSelf":true});
        self.push(public.clone()); Some((wire,public))
    }
    pub fn sweep(&mut self, now: u64) -> bool {
        self.prune(now); let before = self.peers.len();
        self.peers.retain(|_,peer| now.saturating_sub(peer.last_seen) <= PEER_MS); before != self.peers.len()
    }
    pub fn receive(&mut self, bytes: &[u8], address: SocketAddrV4, now: u64, at: &str) -> Effect {
        let mut out=Effect::default();
        if bytes.len()>MAX_PACKET || address.port()==0 || address.ip().is_unspecified() || address.ip().is_multicast() || address.ip().is_broadcast() { return out; }
        let v: Value=match serde_json::from_slice(bytes){Ok(v)=>v,Err(_)=>return out};
        let kind=match v.get("type").and_then(Value::as_str){Some(k @ ("player-discovery"|"player-discovery-response"|"heartbeat"|"player-left"|"chat"))=>k,_=>return out};
        let id=match player_id(&v){Some(id) if id!=self.id=>id,_=>return out};
        self.prune(now);
        if kind=="player-left" {
            if self.left.len()<MAX_LEFT || self.left.contains_key(&id) { self.left.insert(id.clone(),now); }
            out.changed=self.peers.remove(&id).is_some(); return out;
        }
        if self.left.contains_key(&id) { return out; }
        let (display,ip,port)=match kind {
            "player-discovery"|"player-discovery-response"=>{
                let n=match name(&v){Some(v)=>v,None=>return out}; let ip=match virtual_ip(&v){Some(v)=>v,None=>return out};
                let port=match v.get("port").and_then(Value::as_u64).filter(|p| *p>0 && *p<=65535){Some(p)=>p as u16,None=>return out}; (n,ip,port)
            },
            "heartbeat"=>{if timestamp(&v).is_none(){return out;}let ip=match virtual_ip(&v){Some(v)=>v,None=>return out};(String::new(),ip,address.port())},
            "chat"=>{
                if timestamp(&v).is_none() || v.get("content").and_then(Value::as_str).and_then(chat_text).filter(|s|!s.is_empty()).is_none() { return out; }
                if v.get("msgId").is_some() && text(&v,"msgId",1024,512).filter(|s|!s.is_empty()).is_none() { return out; }
                let n=match name(&v){Some(v)=>v,None=>return out}; (n,String::new(),address.port())
            },_=>return out,
        };
        if !self.peers.contains_key(&id) && self.peers.len()>=MAX_PEERS { return out; }
        match self.peers.get_mut(&id) {
            Some(peer)=>{peer.last_seen=now;peer.address=address; if matches!(kind,"player-discovery"|"player-discovery-response"){peer.port=port;}
                if !display.is_empty() && peer.name!=display {peer.name=display.clone();out.changed=true;}
                if !ip.is_empty() && peer.virtual_ip!=ip {peer.virtual_ip=ip.clone();out.changed=true;}
            },
            None=>{self.peers.insert(id.clone(),Peer{id:id.clone(),name:if display.is_empty(){id.chars().take(8).collect()}else{display.clone()},virtual_ip:ip,address,port,joined_at:at.to_owned(),last_seen:now});out.changed=true;},
        }
        if kind=="player-discovery" {out.reply=Some(self.discovery(true));}
        if kind=="chat" {
            let timestamp=timestamp(&v).unwrap();let content=v["content"].as_str().unwrap();
            let key=v.get("msgId").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(||format!("{id}-{timestamp}-{content}"));
            if self.seen.contains_key(&key) || self.seen.len()>=MAX_DEDUP {return out;}
            self.seen.insert(key.clone(),now);
            let public_id=v.get("msgId").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(||format!("chat-{id}-{timestamp}"));
            let message=json!({"id":public_id,"playerId":id,"playerName":display,"content":content,"timestamp":timestamp,"isSelf":false});
            if self.push(message.clone()){out.chat=Some(message);}
        }
        out
    }
}

#[cfg(test)] mod tests {
    use super::*;
    fn model()->Protocol{Protocol::new("self".into(),"自己".into(),"10.126.126.1".into(),47777)}
    fn address()->SocketAddrV4{"192.168.1.2:47778".parse().unwrap()}
    fn discovery()->Value{json!({"type":"player-discovery","playerId":"peer","playerName":"玩家","port":47778,"virtualIp":"10.126.126.2"})}
    fn receive(p:&mut Protocol,v:Value,now:u64)->Effect{p.receive(&serde_json::to_vec(&v).unwrap(),address(),now,"fixture-at")}
    #[test] fn discovery_reply_real_peer_update_leave_suppression_and_timeout(){
        let mut p=model();let e=receive(&mut p,discovery(),0);assert!(e.changed);assert_eq!(e.reply.unwrap()["type"],"player-discovery-response");assert_eq!(p.peers().count(),1);
        let e=receive(&mut p,json!({"type":"heartbeat","playerId":"peer","timestamp":100,"virtualIp":"10.126.126.3"}),100);assert!(e.changed);assert_eq!(p.peers().next().unwrap().virtual_ip,"10.126.126.3");
        assert!(receive(&mut p,json!({"type":"player-left","playerId":"peer"}),200).changed);assert!(!receive(&mut p,discovery(),6199).changed);assert!(receive(&mut p,discovery(),6200).changed);
        assert!(!p.sweep(96200));assert!(p.sweep(96201));assert_eq!(p.peers().count(),0);
    }
    #[test] fn chat_is_one_public_message_per_wire_id_and_history_is_bounded(){
        let mut p=model();let v=json!({"type":"chat","playerId":"peer","playerName":"玩家","content":"你好","timestamp":7,"msgId":"stable"});
        assert!(receive(&mut p,v.clone(),0).chat.is_some());assert!(receive(&mut p,v,1).chat.is_none());assert_eq!(p.messages().len(),1);
        let legacy=json!({"type":"chat","playerId":"peer","playerName":"玩家","content":"首行\n次行\t","timestamp":8});
        assert_eq!(receive(&mut p,legacy.clone(),2).chat.unwrap()["content"],"首行\n次行\t");assert!(receive(&mut p,legacy,3).chat.is_none());
        assert!(receive(&mut p,json!({"type":"chat","playerId":"peer","playerName":"玩家","content":"bad\u{0000}","timestamp":9}),4).chat.is_none());
        let (wire,public)=p.local_chat("  本地  ",9,1).unwrap();assert_eq!(wire["msgId"],public["id"]);assert_eq!(public["content"],"本地");
        for _ in 0..MAX_HISTORY+1 {p.local_chat("x",9,2).unwrap();}assert_eq!(p.messages().len(),MAX_HISTORY);assert!(p.messages().last().unwrap()["isSelf"].as_bool().unwrap());
    }
    #[test] fn malformed_self_legacy_and_oversized_datagrams_never_make_ghost_peers(){
        let mut p=model();for v in [json!({"type":"offer","playerId":"peer"}),json!({"type":"heartbeat","playerId":"peer"}),json!({"type":"chat","playerId":"peer","playerName":"玩家","content":{},"timestamp":1}),json!({"type":"player-discovery","playerId":"self","playerName":"自己","port":1}),json!({"type":"player-discovery","playerId":"peer","playerName":"玩家","port":0}),json!({"type":"player-discovery","playerId":"peer","playerName":"玩家","port":47777,"virtualIp":"https://invalid"})] {assert!(!receive(&mut p,v,0).changed);}
        assert!(!p.receive(&vec![b' ';MAX_PACKET+1],address(),0,"at").changed);assert_eq!(p.peers().count(),0);assert!(chat_text(&"x".repeat(4097)).is_none());
    }
    #[test] fn peer_dedup_and_leave_maps_do_not_grow_without_bound(){
        let mut p=model();for n in 0..MAX_PEERS+10 {let mut v=discovery();v["playerId"]=json!(format!("peer-{n}"));receive(&mut p,v,0);}assert_eq!(p.peers().count(),MAX_PEERS);
        for n in 0..MAX_LEFT+10{receive(&mut p,json!({"type":"player-left","playerId":format!("left-{n}")}),0);}assert!(p.left.len()<=MAX_LEFT);
        for n in 0..MAX_DEDUP+10{receive(&mut p,json!({"type":"chat","playerId":"peer-0","playerName":"玩家","content":"x","timestamp":n,"msgId":format!("message-{n}")}),0);}
        assert_eq!(p.seen.len(),MAX_DEDUP);assert_eq!(p.messages().len(),MAX_HISTORY);
        p.sweep(100_000);assert!(p.left.is_empty());assert!(p.seen.is_empty());assert_eq!(p.peers().count(),0);
    }
}
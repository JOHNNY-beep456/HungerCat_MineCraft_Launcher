//! 弹幕只使用当前消息与五字段显示配置；邮箱不跨会话、也不无限缓存。
use serde_json::{json,Value};
use std::collections::VecDeque;

#[derive(Clone)]
pub(super) struct Preferences { pub config:Value, language:String }
impl Default for Preferences { fn default()->Self { Self::read(&json!({})) } }
impl Preferences {
    pub fn read(settings:&Value)->Self { Self { config:super::model::danmaku_config(settings),
        language:match settings["language"].as_str(){Some("en")=>"en",Some("zh-TW")=>"zh-TW",_=>"zh-CN"}.into() } }
    pub fn enabled(&self)->bool { self.config["enabled"].as_bool()==Some(true) }
    pub fn payload(&self,chat:&Value)->Option<Value> {
        if !self.enabled(){return None;}
        let id=chat["id"].as_str().filter(|s|!s.is_empty()&&s.len()<=1024&&!s.chars().any(char::is_control))?;
        let content=chat["content"].as_str().filter(|s|!s.is_empty()&&s.len()<=4096&&s.encode_utf16().count()<=2000
            &&!s.chars().any(|c|c.is_control()&&!matches!(c,'\n'|'\r'|'\t')))?;
        let own=chat["isSelf"].as_bool()?;
        let name=if own { if self.language=="en" {"Me"} else {"我"} }
            else {chat["playerName"].as_str().filter(|s|!s.is_empty()&&s.encode_utf16().count()<=8&&!s.chars().any(char::is_control))?};
        Some(json!({"id":id,"text":format!("{name}：{content}"),"fontSize":self.config["fontSize"],"speed":self.config["speed"],
            "opacity":self.config["opacity"],"tracks":self.config["tracks"]}))
    }
}
#[derive(Default)]
pub(super) struct Mailbox(VecDeque<(u64,Value)>);
impl Mailbox {
    pub fn push(&mut self,generation:u64,payload:Value){
        // 旧代次不能占用新窗口的配额。与原卡片一致，最多保留最近 60 条。
        self.0.retain(|(id,_)|*id==generation);
        if self.0.len()==60 {self.0.pop_front();}
        self.0.push_back((generation,payload));
    }
    pub fn take(&mut self,generation:u64)->Vec<Value>{self.0.drain(..).filter_map(|(id,payload)|(id==generation).then_some(payload)).collect()}
    pub fn clear(&mut self){self.0.clear();}
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn payload_keeps_only_display_fields_and_validates_the_existing_limits(){
        let p=Preferences::read(&json!({"language":"en","multiplayerDanmakuFontSize":22,"multiplayerDanmakuSpeed":20,
            "multiplayerDanmakuOpacity":0.6,"multiplayerDanmakuTracks":5,"password":"not-for-display"}));
        let chat=json!({"id":"opaque","content":"line1\nline2","isSelf":true,"playerName":"Alice","virtualIp":"10.126.126.1"});
        assert_eq!(p.payload(&chat).unwrap(),json!({"id":"opaque","text":"Me：line1\nline2","fontSize":22,"speed":20.0,"opacity":0.6,"tracks":5}));
        let mut bad=chat.clone();bad["content"]=json!("bad\u{0001}");assert!(p.payload(&bad).is_none());
        bad=chat.clone();bad["isSelf"]=json!("true");assert!(p.payload(&bad).is_none());
        assert!(Preferences::read(&json!({"multiplayerDanmakuEnabled":false})).payload(&chat).is_none());
    }
    #[test] fn mailbox_is_bounded_and_does_not_replay_old_generations(){
        let mut box_=Mailbox::default();for id in 0..100{box_.push(1,json!({"id":id}));}
        let messages=box_.take(1);assert_eq!(messages.len(),60);assert_eq!(messages[0]["id"],40);
        box_.push(1,json!(1));box_.push(2,json!(2));assert_eq!(box_.take(2),vec![json!(2)]);
        box_.push(2,json!(3));assert!(box_.take(3).is_empty());box_.push(3,json!(4));box_.clear();assert!(box_.take(3).is_empty());
    }
}

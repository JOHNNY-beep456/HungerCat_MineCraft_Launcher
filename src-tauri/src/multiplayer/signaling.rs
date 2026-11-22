//! 套接字随 core 的同一后台 owner 生灭；本轮只提供物理 UDP，不伪造 no-tun 转发。
use super::signaling_model::{Protocol,MAX_PACKET};
use serde_json::Value;
use std::{collections::BTreeSet,net::{Ipv4Addr,SocketAddr,SocketAddrV4,UdpSocket},io::ErrorKind};
type Result<T> = std::result::Result<T,String>;
const DISCOVERY_PORT:u16=47777;
const MAX_SENDS_PER_SECOND:usize=256;
pub(super) struct Transport {
    socket:UdpSocket,pub model:Protocol,next_discovery:u64,broadcasts:u32,next_heartbeat:u64,next_sweep:u64,
    send_window:u64,remaining:usize,
}
impl Transport {
    pub fn bind(id:String,name:String,ip:String)->Result<Self>{
        for port in DISCOVERY_PORT..DISCOVERY_PORT+100 {
            match UdpSocket::bind((Ipv4Addr::UNSPECIFIED,port)) {
                Ok(socket)=>{
                    socket.set_nonblocking(true).map_err(|_|unavailable())?;
                    socket.set_broadcast(true).map_err(|_|unavailable())?;
                    return Ok(Self{socket,model:Protocol::new(id,name,ip,port),next_discovery:0,broadcasts:0,next_heartbeat:30_000,next_sweep:10_000,send_window:0,remaining:MAX_SENDS_PER_SECOND});
                },Err(error) if error.kind()==ErrorKind::AddrInUse=>continue,Err(_)=>return Err(unavailable()),
            }
        }Err(unavailable())
    }
    fn budget(&mut self,now:u64){if now.saturating_sub(self.send_window)>=1000{self.send_window=now;self.remaining=MAX_SENDS_PER_SECOND;}}
    fn send(&mut self,message:&Value,address:SocketAddrV4,now:u64)->bool{
        self.budget(now);if self.remaining==0{return false;}
        let bytes=match serde_json::to_vec(message){Ok(v) if v.len()<=MAX_PACKET=>v,_=>return false};
        self.remaining-=1;self.socket.send_to(&bytes,address).map(|n|n==bytes.len()).unwrap_or(false)
    }
    fn targets(&self,peers:bool)->BTreeSet<SocketAddrV4>{
        let mut targets=BTreeSet::new();targets.insert(SocketAddrV4::new(Ipv4Addr::BROADCAST,DISCOVERY_PORT));
        if self.model.port!=DISCOVERY_PORT{targets.insert(SocketAddrV4::new(Ipv4Addr::BROADCAST,self.model.port));}
        if peers{for peer in self.model.peers(){targets.insert(SocketAddrV4::new(*peer.address.ip(),peer.port));}}
        targets
    }
    fn all(&mut self,message:&Value,peers:bool,now:u64)->bool{
        let mut queued=false;for target in self.targets(peers){queued=self.send(message,target,now)||queued;}queued
    }
    pub fn tick(&mut self,now:u64,timestamp:u64,at:&str)->(bool,Vec<Value>){
        let mut changed=false;let mut chats=Vec::new();
        if now>=self.next_discovery{let v=self.model.discovery(false);self.all(&v,false,now);self.broadcasts=self.broadcasts.saturating_add(1);self.next_discovery=now.saturating_add(if self.broadcasts<10{1000}else{5000});}
        if now>=self.next_heartbeat{let v=self.model.heartbeat(timestamp);self.all(&v,false,now);self.next_heartbeat=now.saturating_add(30_000);}
        if now>=self.next_sweep{changed=self.model.sweep(now);self.next_sweep=now.saturating_add(10_000);}
        let mut bytes=[0_u8;MAX_PACKET+1];
        // 单次回合最多 32 报文；无日志正文、无阻塞接收，也不为任意报文创建任务。
        for _ in 0..32 {
            match self.socket.recv_from(&mut bytes){
                Ok((length,SocketAddr::V4(address)))=>{
                    let effect=self.model.receive(&bytes[..length],address,now,at);changed|=effect.changed;
                    if let Some(reply)=effect.reply{self.send(&reply,address,now);}
                    if let Some(chat)=effect.chat{chats.push(chat);}
                },Ok(_)=>{},Err(error) if error.kind()==ErrorKind::WouldBlock=>break,Err(_)=>break,
            }
        }(changed,chats)
    }
    pub fn send_chat(&mut self,text:&str,timestamp:u64,now:u64)->Result<Value>{
        // UDP send 成功只代表交给本机网络栈，不是远端投递或认证回执。
        let text=super::signaling_model::chat_text(text).ok_or_else(unavailable)?;
        if text.is_empty(){return Ok(Value::Null);}
        self.budget(now);if self.remaining==0{return Err(unavailable());}
        let (wire,public)=self.model.local_chat(&text,timestamp,now).ok_or_else(unavailable)?;
        // 与 Electron 保持本地回显语义；UDP 丢包不会伪造远端响应。
        self.all(&wire,true,now);Ok(public)
    }
    pub fn stop(mut self,now:u64){
        let message=self.model.leave();
        // 退出报文最多一轮，未发送成功也不延迟真实 socket drop；不是远端离开确认。
        self.remaining=MAX_SENDS_PER_SECOND;self.all(&message,true,now);
        // 消费所有权，返回前真实 UdpSocket 已释放；不再有任务持有其 clone。
    }
}
fn unavailable()->String{"UDP 发现或消息服务不可用 / UDP 探索或訊息服務無法使用 / UDP discovery or messaging is unavailable".into()}
//! Windows core 会话：后台真实启动 / 回收，不以网络 IP 输出冒充 Minecraft 可连接。
use super::session_model::{Model,Params,Phase};
use serde_json::{json,Value};
use std::{sync::{Arc,Mutex,atomic::{AtomicBool,AtomicU64,Ordering}},time::{Duration,Instant}};
use tauri::{AppHandle,Manager,Emitter};
type Result<T> = std::result::Result<T,String>;
const STOP_WAIT:Duration=Duration::from_secs(5);
#[cfg(windows)]
struct ChatCommand { generation:u64,text:String,reply:tokio::sync::oneshot::Sender<Result<()>>,request:crate::lifecycle::Request }
struct Inner { model:Model,lobby:Value,players:Vec<Value>,messages:Vec<Value>,cancel:Option<Arc<AtomicBool>>,
    #[cfg(windows)] commands:Option<std::sync::mpsc::SyncSender<ChatCommand>>,
}
impl Default for Inner {fn default()->Self{Self{model:Model::default(),lobby:Value::Null,players:Vec::new(),messages:Vec::new(),cancel:None,
    #[cfg(windows)] commands:None,
}}}
struct State { inner:Mutex<Inner>, hud:Mutex<super::hud::Preferences>, danmaku:Mutex<super::danmaku_model::Preferences>, hud_refresh:Mutex<()>, hud_revision:AtomicU64, operations:tokio::sync::Mutex<()>,closed:AtomicBool,stop_revision:AtomicU64, changed:tokio::sync::watch::Sender<u64> }
impl Default for State {fn default()->Self{let(changed,_)=tokio::sync::watch::channel(0);Self{inner:Mutex::new(Inner::default()),hud:Mutex::new(super::hud::Preferences::default()),danmaku:Mutex::new(super::danmaku_model::Preferences::default()),hud_refresh:Mutex::new(()),hud_revision:AtomicU64::new(0),operations:tokio::sync::Mutex::new(()),closed:AtomicBool::new(false),stop_revision:AtomicU64::new(0),changed}}}
fn failure()->String{"联机会话状态不可用 / 連線工作階段狀態無法使用 / Multiplayer session state is unavailable".into()}
fn cancelled()->String{"联机启动已取消 / 連線啟動已取消 / Multiplayer startup cancelled".into()}
fn unsupported()->String{"当前平台尚未接入受管 EasyTier 会话 / 目前平台尚未接入受管 EasyTier 工作階段 / Managed EasyTier sessions are not implemented on this platform".into()}
fn state(app:&AppHandle)->Result<Arc<State>>{app.try_state::<Arc<State>>().map(|v|v.inner().clone()).ok_or_else(failure)}
fn notify(_app:&AppHandle,state:&State){state.changed.send_modify(|v|*v=v.wrapping_add(1));}
fn publish_lobby(app:&AppHandle,state:&State){notify(app,state);let _=app.emit_to("main","launcher:event",json!({"channel":"mp:lobbyChanged","payload":null}));hud_changed(app,state);super::danmaku::request_sync(app);super::mini::publish_state(app);}
/// 小窗只取显示字段；大厅密码和服务端端点仍留在会话内。
pub(super) fn mini_snapshot(app:&AppHandle)->Result<Value>{
    let state=state(app)?;let inner=state.inner.lock().map_err(|_|failure())?;
    let lobby=if inner.lobby.is_null(){Value::Null}else{json!({
        "name":inner.lobby["name"],"virtualIp":inner.lobby["virtualIp"],
        "password":"","serverNode":"","signalingServer":"",
        "useDomain":inner.lobby["useDomain"],"isHost":inner.lobby["isHost"],"createdAt":inner.lobby["createdAt"]
    })};
    Ok(json!({"lobby":lobby,"players":inner.players,"appState":inner.model.phase.public()}))
}
pub(super) fn mini_generation_is_live(app:&AppHandle,generation:u64)->Result<bool>{
    let state=state(app)?;let inner=state.inner.lock().map_err(|_|failure())?;
    Ok(!state.closed.load(Ordering::Acquire)&&inner.model.generation==generation&&inner.model.phase==Phase::Live
        &&inner.cancel.as_ref().is_some_and(|cancel|!cancel.load(Ordering::Acquire)))
}
pub(super) struct DanmakuView { pub live:bool, pub generation:u64, pub preferences:super::danmaku_model::Preferences }
pub(super) fn danmaku_view(app:&AppHandle)->Result<DanmakuView>{
    let state=state(app)?;
    let preferences=state.danmaku.lock().map_err(|_|failure())?.clone();
    let inner=state.inner.lock().map_err(|_|failure())?;
    let live=!state.closed.load(Ordering::Acquire)&&inner.model.phase==Phase::Live&&!inner.lobby.is_null()
        &&inner.cancel.as_ref().map(|v|!v.load(Ordering::Acquire)).unwrap_or(false);
    Ok(DanmakuView{live,generation:inner.model.generation,preferences})
}
pub(crate) struct HudView { pub snapshot:Value, pub revision:u64 }
pub(super) fn hud_view(app:&AppHandle)->Result<HudView> {
    let state=state(app)?;
    let preferences=state.hud.lock().map_err(|_|failure())?;
    let inner=state.inner.lock().map_err(|_|failure())?;
    let live=!state.closed.load(Ordering::Acquire)&&inner.model.phase==Phase::Live
        &&!inner.lobby.is_null()&&inner.cancel.as_ref().map(|v|!v.load(Ordering::Acquire)).unwrap_or(false);
    Ok(HudView{snapshot:super::hud::project(&preferences,live,&inner.players),revision:state.hud_revision.load(Ordering::Acquire)})
}
fn hud_changed(app:&AppHandle,state:&State) {
    state.hud_revision.fetch_add(1,Ordering::AcqRel);
    // 与原生 Electron 基线一致：成员显示投影只交付共享 HUD，不广播完整状态到其它页面。
    // 回调只排队，实际投递时在同一个短 UI 回合读取最新状态并核验精确自有实例。
    crate::ai_hud_window::publish_multiplayer(app);
    crate::ai_hud_window::request_sync(app);
}
pub(super) fn refresh_hud_settings(app:&AppHandle)->Result<()> {
    let state=state(app)?;
    let refresh=state.hud_refresh.lock().map_err(|_|failure())?;
    let (preferences,danmaku)=app.state::<crate::storage::Storage>().with_settings_for_backend(|settings|
        (super::hud::Preferences::read(settings),super::danmaku_model::Preferences::read(settings)))?;
    {let mut stored=state.hud.lock().map_err(|_|failure())?;*stored=preferences;}
    {let mut stored=state.danmaku.lock().map_err(|_|failure())?;*stored=danmaku;}
    drop(refresh);
    hud_changed(app,&state);super::danmaku::request_sync(app);Ok(())
}
pub(super) fn init(app:&AppHandle){app.manage(Arc::new(State::default()));}
pub(super) fn close(app:&AppHandle){if let Ok(state)=state(app){state.closed.store(true,Ordering::Release);request_stop(app,&state);}}
fn request_stop(app:&AppHandle,state:&State)->u64{
    let revision=if let Ok(mut inner)=state.inner.lock(){
        let revision=state.stop_revision.fetch_add(1,Ordering::AcqRel).wrapping_add(1);
        inner.model.stop();if let Some(cancel)=&inner.cancel{cancel.store(true,Ordering::Release);}revision
    }else{state.closed.store(true,Ordering::Release);state.stop_revision.fetch_add(1,Ordering::AcqRel).wrapping_add(1)};
    notify(app,state);hud_changed(app,state);super::danmaku::request_sync(app);revision
}
async fn wait_idle(state:&State)->Result<()> {
    let mut changes=state.changed.subscribe();
    let wait=async{loop{if state.inner.lock().map_err(|_|failure())?.model.phase==Phase::Idle{return Ok(());}changes.changed().await.map_err(|_|failure())?;}};
    tokio::time::timeout(STOP_WAIT,wait).await.map_err(|_|"EasyTier 收尾尚未确认，进程保持运行 / EasyTier 收尾尚未確認，程序保持執行 / EasyTier cleanup is not confirmed; launcher remains running".to_owned())?
}
pub(super) async fn shutdown(app:&AppHandle)->Result<()>{let state=state(app)?;state.closed.store(true,Ordering::Release);request_stop(app,&state);wait_idle(&state).await}
pub(super) fn relaunch_ready(app:&AppHandle)->Result<()>{let state=state(app)?;if state.inner.lock().map_err(|_|failure())?.model.phase!=Phase::Idle{return Err(failure());}Ok(())}
fn snapshot(state:&State,channel:&str)->Result<Value>{let inner=state.inner.lock().map_err(|_|failure())?;match channel{"mp:getAppState"=>Ok(json!(inner.model.phase.public())),"mp:getLobby"=>Ok(inner.lobby.clone()),"mp:getPlayers"=>Ok(json!(inner.players)),"mp:getMessages"=>Ok(json!(inner.messages)),_=>Err(failure())}}
pub(super) async fn call(app:&AppHandle,channel:&str,args:&[Value])->Result<Option<Value>> {
    match channel {
        "mp:getAppState"|"mp:getLobby"|"mp:getPlayers"|"mp:getMessages"=>{if !args.is_empty(){return Err(failure());}let state=state(app)?;Ok(Some(snapshot(state.as_ref(),channel)?))},
        "mp:sendChat"=>{
            if args.len()!=1{return Err(failure());}
            let text=super::signaling_model::chat_text(args[0].as_str().ok_or_else(failure)?).ok_or_else(failure)?;
            if text.is_empty(){return Ok(Some(Value::Null));}
            #[cfg(not(windows))] {let _=text;return Err(unsupported());}
            #[cfg(windows)] {
                let state=state(app)?;let request=app.state::<crate::lifecycle::Gate>().enter()?;
                let (reply,wait)=tokio::sync::oneshot::channel();
                let queued={
                    let inner=match state.inner.lock(){Ok(inner)=>inner,Err(_)=>{request.finish();return Err(failure());}};
                    if state.closed.load(Ordering::Acquire)||inner.model.phase!=Phase::Live||inner.cancel.as_ref().map(|v|v.load(Ordering::Acquire)).unwrap_or(true){request.finish();return Err(failure());}
                    let sender=match &inner.commands{Some(sender)=>sender,None=>{request.finish();return Err("UDP 消息服务不可用 / UDP 訊息服務無法使用 / UDP messaging is unavailable".into());}};
                    sender.try_send(ChatCommand{generation:inner.model.generation,text,reply,request})
                };
                if let Err(error)=queued{let command=match error{std::sync::mpsc::TrySendError::Full(v)|std::sync::mpsc::TrySendError::Disconnected(v)=>v};command.request.finish();return Err(failure());}
                wait.await.map_err(|_|failure())??;Ok(Some(Value::Null))
            }
        },
        "mp:leaveLobby"|"mp:forceStop"=>{
            if !args.is_empty(){return Err(failure());}let state=state(app)?;request_stop(app,&state);wait_idle(&state).await?;Ok(Some(Value::Null))
        },
        "mp:createLobby"|"mp:joinLobby"=>{
            if args.len()!=1{return Err(failure());}let params=Params::parse(&args[0])?;
            #[cfg(not(windows))] {let _=params;return Err(unsupported());}
            #[cfg(windows)] {
                let state=state(app)?;let intent=state.stop_revision.load(Ordering::Acquire);
                let _operation=state.operations.lock().await;
                if state.closed.load(Ordering::Acquire)||state.stop_revision.load(Ordering::Acquire)!=intent{return Err(cancelled());}
                let revision=request_stop(app,&state);wait_idle(&state).await?;
                let source=super::resource_directory(app)?;
                let root=app.path().app_local_data_dir().map_err(|_|failure())?.join("easytier-runtime");
                let request=app.state::<crate::lifecycle::Gate>().enter()?;
                let cancel=Arc::new(AtomicBool::new(false));
                let (commands,command_receiver)=std::sync::mpsc::sync_channel(32);
                let generation={
                    let mut inner=match state.inner.lock(){Ok(inner)=>inner,Err(_)=>{request.finish();return Err(failure());}};
                    if state.closed.load(Ordering::Acquire)||state.stop_revision.load(Ordering::Acquire)!=revision{request.finish();return Err(cancelled());}
                    let generation=match inner.model.begin(){Ok(id)=>id,Err(error)=>{request.finish();return Err(error);}};
                    inner.lobby=Value::Null;inner.players.clear();inner.messages.clear();inner.commands=Some(commands);inner.cancel=Some(cancel.clone());generation
                };
                // waiter 被移除时发出取消，但 worker / Job / Gate 仍由后台所有者持有。
                struct CancelOnDrop(Arc<AtomicBool>,bool);impl Drop for CancelOnDrop{fn drop(&mut self){if !self.1{self.0.store(true,Ordering::Release);}}}
                let mut on_drop=CancelOnDrop(cancel.clone(),false);
                notify(app,&state);
                let (sender,receiver)=tokio::sync::oneshot::channel();let handle=app.clone();let owned=state.clone();let host=channel=="mp:createLobby";
                tauri::async_runtime::spawn_blocking(move||{run(handle,owned,generation,params,host,source,root,cancel,sender,request,command_receiver);});
                let result=receiver.await.map_err(|_|failure())?;on_drop.1=true;result.map(Some)
            }
        },_=>Ok(None),
    }
}

#[cfg(windows)]
fn args(params:&Params,directory:&std::path::Path,rpc:u16,listener:u16)->Vec<String>{
    let ws=params.server_node.starts_with("ws://")||params.server_node.starts_with("wss://");
    let mut args=vec!["--network-name".into(),format!("MCTier-{}",params.name),"--network-secret".into(),params.password.clone(),
        "--peers".into(),params.server_node.clone(),"--hostname".into(),params.hostname(),"--instance-name".into(),format!("hungercat-{}",uuid::Uuid::new_v4()),
        "--config-dir".into(),directory.to_string_lossy().into_owned(),"--rpc-portal".into(),format!("127.0.0.1:{rpc}"),
        "--listeners".into(),if ws{format!("ws://0.0.0.0:{listener}/")}else{format!("udp://0.0.0.0:{listener}")},
        "--default-protocol".into(),if ws{"ws".into()}else{"udp".into()},"--no-tun".into(),"--dhcp".into(),"true".into(),"--encryption-algorithm".into(),"aes-256-gcm".into()];
    if params.use_domain{args.extend(["--tld-dns-zone".into(),"mct.net".into()]);}args
}
#[cfg(windows)]
fn clock()->(u64,String){let now=std::time::SystemTime::now();let timestamp=now.duration_since(std::time::UNIX_EPOCH).map(|v|v.as_millis().min(9_007_199_254_740_991) as u64).unwrap_or(0);(timestamp,chrono::DateTime::<chrono::Utc>::from(now).to_rfc3339_opts(chrono::SecondsFormat::Millis,true))}
#[cfg(windows)]
fn publish_signals(app:&AppHandle,state:&State,generation:u64,params:&Params,signal:&super::signaling::Transport,chats:Vec<Value>)->Result<()> {
    let mut players=Vec::new();
    let changed={
        let mut inner=state.inner.lock().map_err(|_|failure())?;
        if inner.model.generation!=generation||inner.model.phase!=Phase::Live||state.closed.load(Ordering::Acquire)||inner.cancel.as_ref().map(|v|v.load(Ordering::Acquire)).unwrap_or(true){return Err(cancelled());}
        if let Some(own)=inner.players.iter().find(|p|p["isSelf"]==true){players.push(own.clone());}
        // 与既有大厅一样按 id、非空虚拟 IP、归一化名字合并，但不能覆盖真实自己。
        for peer in signal.model.peers(){
            let key:String=peer.name.chars().filter(|c|c.is_alphanumeric()).flat_map(char::to_lowercase).collect();
            if players.iter().any(|p|p["id"]==peer.id||(!peer.virtual_ip.is_empty()&&p["virtualIp"]==peer.virtual_ip)||p["name"].as_str().map(|s|s.chars().filter(|c|c.is_alphanumeric()).flat_map(char::to_lowercase).collect::<String>()==key).unwrap_or(false)){continue;}
            players.push(params.peer_player(&peer.id,&peer.name,&peer.virtual_ip,&peer.joined_at));
        }
        let changed=inner.players!=players;inner.players=players;inner.messages=signal.model.messages();changed
    };
    if changed{publish_lobby(app,state);}
    for chat in chats {
        let live={let inner=state.inner.lock().map_err(|_|failure())?;
            inner.model.generation==generation&&inner.model.phase==Phase::Live&&!state.closed.load(Ordering::Acquire)
                &&inner.cancel.as_ref().map(|v|!v.load(Ordering::Acquire)).unwrap_or(false)};
        if !live{return Err(cancelled());}
        // 只转发当前真实会话消息；弹幕宿主再次校验代次和显示开关。
        super::danmaku::enqueue(app,generation,&chat);
        super::mini::publish_chat(app,generation,&chat);
        let _=app.emit_to("main","launcher:event",json!({"channel":"mp:chat","payload":chat}));
    }Ok(())
}
#[cfg(windows)]
fn run(app:AppHandle,state:Arc<State>,generation:u64,params:Params,host:bool,source:std::path::PathBuf,root:std::path::PathBuf,cancel:Arc<AtomicBool>,sender:tokio::sync::oneshot::Sender<Result<Value>>,request:crate::lifecycle::Request,commands:std::sync::mpsc::Receiver<ChatCommand>){
    use super::{process::OwnedProcess,session_files::Files,signaling::Transport};
    let mut files=None;let mut process=None;let mut signal=None;let mut sender=Some(sender);let mut signal_start=Instant::now();
    let result=(||->Result<()> {
        if cancel.load(Ordering::Acquire){return Err(cancelled());}
        files=Some(Files::create(&root)?);let files=files.as_mut().ok_or_else(failure)?;files.copy_core(&source,&cancel)?;
        if cancel.load(Ordering::Acquire){return Err(cancelled());}
        // 只挑选回环临时端口；释放后的系统竞争仍可能导致 core 失败，不承诺原子保留。
        let rpc=std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST,0)).map_err(|_|failure())?;
        let rpc_port=rpc.local_addr().map_err(|_|failure())?.port();
        let listener=std::net::UdpSocket::bind((std::net::Ipv4Addr::LOCALHOST,0)).map_err(|_|failure())?;
        let listener_port=listener.local_addr().map_err(|_|failure())?.port();drop(rpc);drop(listener);
        files.verify()?;
        if cancel.load(Ordering::Acquire){return Err(cancelled());}
        process=Some(OwnedProcess::spawn(&files.program,&args(&params,&files.directory,rpc_port,listener_port),&files.directory)?);
        let process=process.as_mut().ok_or_else(failure)?;let start=Instant::now();let mut tail=Vec::new();let mut ready=false;
        loop {
            if cancel.load(Ordering::Acquire){return Err(cancelled());}
            if process.has_exited(){return Err("EasyTier core 已退出 / EasyTier core 已結束 / EasyTier core exited".into());}
            // 避免持续 core 输出饿死取消和 UDP 处理。
            for _ in 0..64 {let chunk=match process.output.try_recv(){Ok(chunk)=>chunk,Err(_)=>break};
                tail.extend_from_slice(&chunk);if tail.len()>65536{tail.drain(..tail.len()-65536);}
                if !ready {let text=String::from_utf8_lossy(&tail);if let Some(ip)=super::model::virtual_ip(&text){
                    let (_,at)=clock();let lobby=params.lobby(&ip,host,&at);signal_start=Instant::now();
                    signal=match Transport::bind(params.player_id.clone(),params.player_name.clone(),ip.clone()){
                        Ok(value)=>Some(value),Err(_)=>{let _=crate::debug::append(&app,"warn","multiplayer","UDP 成员发现未启动；core 会话仍保留 / UDP 成員探索未啟動；core 工作階段仍保留 / UDP peer discovery did not start; core session is retained");None}
                    };
                    let publish={let mut inner=state.inner.lock().map_err(|_|failure())?;if !cancel.load(Ordering::Acquire)&&!state.closed.load(Ordering::Acquire)&&inner.model.ready(generation){inner.lobby=lobby.clone();inner.players=vec![params.self_player(&ip,&at)];if signal.is_none(){inner.commands=None;}true}else{false}};
                    if !publish{return Err(cancelled());}publish_lobby(&app,&state);ready=true;
                    if let Some(sender)=sender.take(){if sender.send(Ok(lobby)).is_err(){cancel.store(true,Ordering::Release);}}
                }}
            }
            if cancel.load(Ordering::Acquire){return Err(cancelled());}
            if let Some(signal)=signal.as_mut(){
                let now=signal_start.elapsed().as_millis().min(u64::MAX as u128) as u64;let (timestamp,at)=clock();
                let (changed,chats)=signal.tick(now,timestamp,&at);
                if changed||!chats.is_empty(){publish_signals(&app,&state,generation,&params,signal,chats)?;}
                for _ in 0..8 {let command=match commands.try_recv(){Ok(command)=>command,Err(_)=>break};
                    let live=state.inner.lock().map(|inner|inner.model.generation==command.generation&&command.generation==generation&&inner.model.phase==Phase::Live).unwrap_or(false);
                    let result=if !live||cancel.load(Ordering::Acquire)||state.closed.load(Ordering::Acquire){Err(cancelled())}else{
                        signal.send_chat(&command.text,clock().0,now).and_then(|chat|if chat.is_null(){Ok(())}else{publish_signals(&app,&state,generation,&params,signal,vec![chat])})
                    };
                    command.request.finish();let _=command.reply.send(result);
                }
            }
            if !ready && start.elapsed()>=Duration::from_secs(10){return Err("EasyTier 十秒内未分配虚拟 IP，请检查节点 / EasyTier 十秒內未分配虛擬 IP，請檢查節點 / EasyTier did not assign a virtual IP within ten seconds; check the peer".into());}
            std::thread::sleep(Duration::from_millis(25));
        }
    })();
    {let mut inner=state.inner.lock().unwrap_or_else(|e|e.into_inner());if inner.model.generation==generation{inner.model.stop();inner.commands=None;}}
    notify(&app,&state);hud_changed(&app,&state);super::danmaku::request_sync(&app);
    // 同一线程消费 socket 所有权并释放，不留 clone / 异步 send task；随后拒绝所有已排队命令。
    if let Some(signal)=signal.take(){signal.stop(signal_start.elapsed().as_millis().min(u64::MAX as u128) as u64);}
    while let Ok(command)=commands.try_recv(){command.request.finish();let _=command.reply.send(Err(cancelled()));}drop(commands);
    // 无论就绪、失败或 waiter 离开，都由同一 worker 持有进程直到 Job 空、child 回收、管道线程结束。
    if let Some(process)=process.as_mut(){process.terminate();let began=Instant::now();while !process.confirm_reaped(){
        if began.elapsed()>STOP_WAIT{let mut inner=state.inner.lock().unwrap_or_else(|e|e.into_inner());inner.model.unknown(generation);drop(inner);notify(&app,&state);}
        process.terminate();std::thread::sleep(Duration::from_millis(100));
    }}
    drop(process);
    if let Some(files)=files.as_mut(){let began=Instant::now();loop{if files.cleanup().is_ok(){break;}if began.elapsed()>STOP_WAIT{let mut inner=state.inner.lock().unwrap_or_else(|e|e.into_inner());inner.model.unknown(generation);drop(inner);notify(&app,&state);}std::thread::sleep(Duration::from_millis(250));}}
    request.finish();
    {let mut inner=state.inner.lock().unwrap_or_else(|e|e.into_inner());if inner.model.reaped(generation){inner.lobby=Value::Null;inner.players.clear();inner.messages.clear();inner.cancel=None;inner.commands=None;}}
    publish_lobby(&app,&state);
    if let Some(sender)=sender.take(){let _=sender.send(result.and_then(|_|Err(failure())));}
}
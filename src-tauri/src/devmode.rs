//! 固定官方开发授权接口；令牌只在后台流转，原生工具按授权代次回收。
#[cfg(desktop)]
#[path = "devmode_tools.rs"]
mod tools;
use crate::storage::{DevModeChange, DevModeSnapshot, Storage};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

type Result<T> = std::result::Result<T, String>;
const ORIGIN: &str = "https://hcmcl.johnnyblog.top/api.php";
const DAY_MS: u64 = 86_400_000;
const BUSY: &str = "开发授权仍在运行或收尾状态未确认 / 開發授權仍在執行或收尾狀態未確認 / Development authorization is busy or unconfirmed";
const STALE: &str = "开发授权已取消或状态改变，请重试 / 開發授權已取消或狀態變更，請重試 / Authorization was cancelled or changed; retry";
const NETWORK: &str = "开发授权网络请求失败，服务端可能已收到；没有自动重试 / 開發授權網路請求失敗，伺服器可能已收到；沒有自動重試 / Authorization request failed; the server may have received it and no retry was made";
fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|v| v.as_millis().min(9_007_199_254_740_991) as u64).unwrap_or(0) }

#[derive(Default)]
struct Stop { stopped: AtomicBool, notify: Notify }
impl Stop {
    fn cancel(&self) { self.stopped.store(true, Ordering::Release); self.notify.notify_waiters(); }
    fn check(&self) -> Result<()> { if self.stopped.load(Ordering::Acquire) { Err(STALE.into()) } else { Ok(()) } }
    async fn wait(&self) {
        loop {
            let future = self.notify.notified(); tokio::pin!(future); future.as_mut().enable();
            if self.stopped.load(Ordering::Acquire) { return; }
            future.await;
        }
    }
}
#[derive(Default)]
struct Epoch { generation: u64, closed: bool, trusted: Option<DevModeSnapshot>, cached: Option<DevModeSnapshot>, last_event: Option<Value> }
/// 与原子 JSON 发布共用纪元锁；取消先发生则禁止发布，发布先发生则随后立即失去有效投影。
#[derive(Clone, Default)]
struct OriginPermit {
    #[cfg(desktop)] tools: Option<tools::Origin>,
}
impl OriginPermit {
    fn check(&self) -> Result<()> {
        #[cfg(desktop)]
        if let Some(origin) = &self.tools { origin.check(now_ms())?; }
        Ok(())
    }
}
#[derive(Clone)]
pub(crate) struct Permit { epoch: Arc<Mutex<Epoch>>, generation: u64, stop: Arc<Stop>, origin: OriginPermit }
impl Permit {
    fn current(epoch: &Arc<Mutex<Epoch>>, stop: Arc<Stop>) -> Result<Self> {
        let generation = { let state = epoch.lock().map_err(|_| BUSY)?; if state.closed { return Err(STALE.into()); } state.generation };
        Ok(Self { epoch: epoch.clone(), generation, stop, origin: OriginPermit::default() })
    }
    pub(crate) fn commit<T>(&self, publish: impl FnOnce() -> Result<T>) -> Result<T> {
        let epoch = self.epoch.lock().map_err(|_| BUSY)?;
        self.stop.check()?;
        if epoch.closed || epoch.generation != self.generation { return Err(STALE.into()); }
        #[cfg(desktop)]
        if let Some(origin) = &self.origin.tools { return origin.commit(now_ms(), publish); }
        publish()
    }
    fn check(&self) -> Result<()> { self.commit(|| Ok(())) }
}
#[derive(Default)]
struct Registry { next: u64, active: HashMap<u64, Arc<Stop>>, closed: bool, uncertain: bool }
#[derive(Default)]
pub(crate) struct State {
    epoch: Arc<Mutex<Epoch>>, registry: Arc<Mutex<Registry>>, serial: Arc<tokio::sync::Mutex<()>>, shutdown: Arc<Stop>,
    #[cfg(desktop)] tools: Arc<tools::Authority>,
}
struct Owner { registry: Arc<Mutex<Registry>>, epoch: Arc<Mutex<Epoch>>, id: u64, request: Option<crate::lifecycle::Request>, finished: bool,
    #[cfg(desktop)] tools: Arc<tools::Authority>,
}
impl Owner {
    fn finish(mut self) {
        let removed = self.registry.lock().map(|mut s| s.active.remove(&self.id).is_some()).unwrap_or(false);
        if removed { if let Some(request) = self.request.take() { request.finish(); } }
        self.finished = true;
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        if !self.finished {
            if let Ok(mut state) = self.registry.lock() { state.uncertain = true; if let Some(stop) = state.active.get(&self.id) { stop.cancel(); } }
            if let Ok(mut epoch) = self.epoch.lock() {
                epoch.trusted = None; epoch.generation = epoch.generation.saturating_add(1);
                #[cfg(desktop)] self.tools.publish(&epoch, now_ms());
            }
        }
    }
}
struct Caller(Arc<Stop>);
impl Drop for Caller { fn drop(&mut self) { self.0.cancel(); } }
fn reserve(state: &State, request: Option<crate::lifecycle::Request>) -> Result<(Owner, Arc<Stop>)> {
    let mut registry = match state.registry.lock() { Ok(v) => v, Err(_) => { if let Some(v) = request { v.finish(); } return Err(BUSY.into()); } };
    if registry.closed || registry.uncertain || registry.active.len() >= 16 { if let Some(v) = request { v.finish(); } return Err(BUSY.into()); }
    registry.next = match registry.next.checked_add(1) { Some(v) => v, None => { if let Some(v) = request { v.finish(); } return Err(BUSY.into()); } };
    let id = registry.next; let stop = Arc::new(Stop::default()); registry.active.insert(id, stop.clone());
    Ok((Owner { registry: state.registry.clone(), epoch: state.epoch.clone(), id, request, finished: false,
        #[cfg(desktop)] tools: state.tools.clone(),
    }, stop))
}
fn invalidate(state: &State, closed: bool) -> Result<()> {
    let mut epoch = state.epoch.lock().map_err(|_| BUSY)?;
    epoch.generation = epoch.generation.checked_add(1).ok_or(BUSY)?;
    epoch.trusted = None; epoch.closed |= closed;
    #[cfg(desktop)] state.tools.publish(&epoch, now_ms());
    Ok(())
}
// 关闭开关只承接本进程当前已验证的授权，不从磁盘快照建立新信任。
struct RetainedGrant { generation: u64, snapshot: DevModeSnapshot }
fn begin_control(state: &State, operation: &Operation) -> Result<Option<RetainedGrant>> {
    let mut epoch = state.epoch.lock().map_err(|_| BUSY)?;
    if epoch.closed { return Err(STALE.into()); }
    let generation = epoch.generation.checked_add(1).ok_or(BUSY)?;
    let previous = epoch.trusted.take();
    let retained = previous.filter(|saved| matches!(operation, Operation::Enable(false))
        && epoch.cached.as_ref() == Some(saved));
    epoch.generation = generation;
    #[cfg(desktop)] state.tools.publish(&epoch, now_ms());
    Ok(retained.map(|snapshot| RetainedGrant { generation, snapshot }))
}
fn retained_disable_matches(
    retained: Option<&RetainedGrant>, permit: &Permit,
    before: &DevModeSnapshot, after: &DevModeSnapshot, now: u64,
) -> bool {
    let Some(retained) = retained else { return false; };
    if retained.generation != permit.generation || retained.snapshot != *before { return false; }
    let Some(revision) = before.revision.checked_add(1) else { return false; };
    let mut expected = before.clone(); expected.revision = revision; expected.enabled = false;
    *after == expected && online(after).is_ok()
        && validate_grant(&after.token, after.expires_at, &after.email_masked, now).is_ok()
}
fn projection(snapshot: Option<&DevModeSnapshot>, trusted: Option<&DevModeSnapshot>, now: u64) -> Value {
    let granted = snapshot.zip(trusted).is_some_and(|(s,t)| s == t && s.mode != "local" && s.expires_at > now && valid_token(&s.token));
    let security = snapshot.map(|s| s.security_mode.as_str()).filter(|s| matches!(*s,"full"|"warn"|"off")).unwrap_or("full");
    let (expires_at, enabled, email_masked) = match (granted, snapshot) {
        (true, Some(value)) => (value.expires_at, value.enabled, value.email_masked.as_str()),
        _ => (0, false, ""),
    };
    json!({"granted":granted,"expiresAt":expires_at,
        "enabled":enabled,"emailMasked":email_masked,
        "securityMode":security,"effectiveSecurityMode":if granted && enabled {security} else {"full"}})
}
fn event(app: &AppHandle, state: &State) -> Result<Value> {
    let (value, changed) = {
        let mut epoch = state.epoch.lock().map_err(|_| BUSY)?;
        let value = projection(epoch.cached.as_ref(), epoch.trusted.as_ref(), now_ms());
        let changed = epoch.last_event.as_ref() != Some(&value);
        epoch.last_event = Some(value.clone());
        (value, changed)
    };
    if changed {
        // 仅发脱敏状态投影给主窗口和固定工具页；原生发送不持有授权/存储发布锁。
        let payload = json!({"channel":"devmode:changed","payload":value});
        let _ = app.emit_to("main", "launcher:event", payload.clone());
        let _ = app.emit_to("devtools", "launcher:event", payload);
    }
    Ok(value)
}
fn observe(state: &State, permit: &Permit, snapshot: DevModeSnapshot, trust: bool) -> Result<()> {
    let mut epoch = state.epoch.lock().map_err(|_| BUSY)?;
    permit.stop.check()?;
    if epoch.closed || epoch.generation != permit.generation { return Err(STALE.into()); }
    if trust { epoch.trusted = Some(snapshot.clone()); }
    else if epoch.trusted.as_ref().is_some_and(|old| old != &snapshot) { epoch.trusted = None; }
    epoch.cached = Some(snapshot);
    #[cfg(desktop)] state.tools.publish(&epoch, now_ms());
    Ok(())
}
fn trusted(state: &State, snapshot: &DevModeSnapshot) -> bool {
    state.epoch.lock().map(|e| e.trusted.as_ref() == Some(snapshot)).unwrap_or(false)
}
fn valid_token(token: &str) -> bool { token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()) }
fn valid_masked_email(value:&str)->bool {
    let Some((prefix,domain))=value.split_once("***@") else{return false};
    prefix.chars().count()==1 && !prefix.chars().any(|c|c.is_control()||c.is_whitespace()||c=='@')
        && !domain.is_empty() && domain.contains('.') && value.len()<=320
        && domain.bytes().all(|b|b.is_ascii_alphanumeric()||matches!(b,b'.'|b'-'))
}
pub(crate) fn validate_grant(token: &str, expires: u64, masked: &str, now: u64) -> Result<()> {
    if !valid_token(token) || expires <= now || expires > now.checked_add(DAY_MS).ok_or(STALE)?
        || !valid_masked_email(masked) {
        return Err("开发授权响应无效 / 開發授權回應無效 / Invalid development authorization response".into());
    }
    Ok(())
}
#[derive(Clone)]
enum Operation { Status, SendCode(String), Verify(String,String), Enable(bool), Revoke, Security(String) }
fn email(value: &Value) -> Result<String> {
    let s = value.as_str().ok_or("邮箱必须为字符串 / 郵箱必須為字串 / Email must be a string")?.trim().to_ascii_lowercase();
    let parts: Vec<_> = s.split('@').collect();
    if s.len() > 254 || parts.len()!=2 || parts.iter().any(|s|s.is_empty()) || !parts[1].contains('.') || !parts[1].bytes().all(|b|b.is_ascii_alphanumeric()||matches!(b,b'.'|b'-')) || s.chars().any(|c|c.is_whitespace()||c.is_control()) { return Err("邮箱格式无效 / 郵箱格式無效 / Invalid email".into()); }
    Ok(s)
}
fn parse(channel: &str, args: &[Value]) -> Result<Option<Operation>> {
    let count = match channel { "devmode:status"|"devmode:revoke"=>0,"devmode:sendCode"|"devmode:setEnabled"|"devmode:setSecurityMode"=>1,"devmode:verify"=>2,_=>return Ok(None) };
    if args.len()!=count { return Err("开发模式参数数量无效 / 開發模式參數數量無效 / Invalid development-mode argument count".into()); }
    Ok(Some(match channel {
        "devmode:status"=>Operation::Status,"devmode:revoke"=>Operation::Revoke,
        "devmode:sendCode"=>Operation::SendCode(email(&args[0])?),
        "devmode:verify"=>{let e=email(&args[0])?; let code=args[1].as_str().ok_or("验证码必须为字符串")?.trim(); if code.len()!=6 || !code.bytes().all(|b|b.is_ascii_digit()){return Err("验证码必须为六位数字 / 驗證碼必須為六位數字 / Code must contain six digits".into());} Operation::Verify(e,code.into())},
        "devmode:setEnabled"=>Operation::Enable(args[0].as_bool().ok_or("开发模式开关必须为布尔值 / 開發模式開關必須為布林值 / Enabled must be boolean")?),
        "devmode:setSecurityMode"=>{let s=args[0].as_str().filter(|s|matches!(*s,"full"|"warn"|"off")).ok_or("开发模式防护偏好无效 / 開發模式防護偏好無效 / Invalid security preference")?;Operation::Security(s.into())},_=>unreachable!(),
    }))
}
fn endpoint(action: &str) -> Result<reqwest::Url> {
    if !matches!(action,"dev_send_code"|"dev_verify"|"dev_status"|"dev_revoke") { return Err("未公开的开发授权操作".into()); }
    let mut url=reqwest::Url::parse(ORIGIN).map_err(|_|NETWORK)?; url.query_pairs_mut().append_pair("action",action); Ok(url)
}
fn online(snapshot: &DevModeSnapshot) -> Result<()> {
    if !matches!(snapshot.mode.as_str(),"normal"|"minimal") { return Err("本地模式不发送开发授权请求 / 本機模式不傳送開發授權請求 / Development requests are disabled in local mode".into()); } Ok(())
}
async fn post(action:&str, body:Value, stop:&Stop) -> Result<Value> {
    stop.check()?;
    if serde_json::to_vec(&body).map_err(|_|NETWORK)?.len()>2048 {return Err(NETWORK.into());}
    let client=reqwest::Client::builder().use_rustls_tls().no_proxy().redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never()).timeout(Duration::from_secs(30)).connect_timeout(Duration::from_secs(10))
        .user_agent("HCMCL-Tauri/1").build().map_err(|_|NETWORK)?;
    let url=endpoint(action)?;
    let request=async {
        let mut response=client.post(url).json(&body).send().await.map_err(|_|NETWORK)?;
        if !response.status().is_success() || response.content_length().is_some_and(|n|n>16*1024){return Err(NETWORK.into());}
        let mut bytes=Vec::new();
        while let Some(part)=response.chunk().await.map_err(|_|NETWORK)? {if bytes.len().saturating_add(part.len())>16*1024{return Err(NETWORK.into());}bytes.extend_from_slice(&part);}
        let value:Value=serde_json::from_slice(&bytes).map_err(|_|NETWORK)?;
        if value.get("ok").and_then(Value::as_bool)!=Some(true){return Err(NETWORK.into());} Ok(value)
    };
    tokio::select! { biased; _=stop.wait()=>Err(STALE.into()), value=request=>{stop.check()?;value} }
}
fn code_reply(value:&Value)->Result<Value>{
    let ttl=value.get("ttl").and_then(Value::as_u64).filter(|v|*v>0&&*v<=86_400).ok_or(NETWORK)?;
    let cooldown=value.get("cooldown").and_then(Value::as_u64).filter(|v|*v<=86_400).ok_or(NETWORK)?;
    Ok(json!({"ok":true,"ttl":ttl,"cooldown":cooldown}))
}
fn mask_email(email:&str)->String { let (name,domain)=email.split_once('@').unwrap_or(("",""));format!("{}***@{}",name.chars().next().unwrap_or('*'),domain) }
fn grant_reply(value:&Value, token:Option<&str>, masked:Option<&str>, now:u64)->Result<(String,u64,String)>{
    let token=token.or_else(||value.get("token").and_then(Value::as_str)).ok_or(NETWORK)?.to_owned();
    let expires=value.get("expiresAt").and_then(Value::as_u64).ok_or(NETWORK)?;
    // 掩码只在本机从已校验邮箱产生，远端字符串不能注入明文邮箱或其它秘密。
    let masked=masked.ok_or(NETWORK)?.to_owned();validate_grant(&token,expires,&masked,now)?;Ok((token,expires,masked))
}
fn status_reply(value:&Value, token:&str, expected_masked:&str, now:u64)->Result<(bool,u64,String)> {
    if value.get("ok").and_then(Value::as_bool)!=Some(true) { return Err(NETWORK.into()); }
    let active=value.get("active").and_then(Value::as_bool).ok_or(NETWORK)?;
    let expires=value.get("expiresAt").and_then(Value::as_u64).ok_or(NETWORK)?;
    let masked=value.get("emailMasked").and_then(Value::as_str).ok_or(NETWORK)?;
    if active {
        validate_grant(token,expires,masked,now)?;
        if masked != expected_masked { return Err(NETWORK.into()); }
        Ok((true,expires,masked.to_owned()))
    } else {
        if expires != 0 || !masked.is_empty() { return Err(NETWORK.into()); }
        Ok((false,0,String::new()))
    }
}
struct Failure { text:String, uncertain:bool }
impl From<String> for Failure {fn from(text:String)->Self{Self{text,uncertain:false}}}
async fn blocking<T:Send+'static>(work:impl FnOnce()->Result<T>+Send+'static)->std::result::Result<T,Failure>{
    // 不对 blocking JoinHandle 做取消 select：持久化真实返回前 owner 仍登记为忙。
    match tauri::async_runtime::spawn_blocking(work).await {Ok(result)=>result.map_err(Into::into),Err(_)=>Err(Failure{text:BUSY.into(),uncertain:true})}
}
async fn snapshot(app:&AppHandle)->std::result::Result<DevModeSnapshot,Failure>{
    let app=app.clone();blocking(move||app.try_state::<Storage>().ok_or(BUSY)?.devmode_snapshot_for_backend()).await
}
async fn update(app:&AppHandle, expected:DevModeSnapshot, change:DevModeChange, permit:Permit)->std::result::Result<DevModeSnapshot,Failure>{
    let app=app.clone();blocking(move||app.try_state::<Storage>().ok_or(BUSY)?.devmode_update_for_backend(&expected,change,&permit)).await
}
async fn checked_post(app:&AppHandle,expected:&DevModeSnapshot,permit:&Permit,action:&str,body:Value)->std::result::Result<Value,Failure>{
    let current=snapshot(app).await?;
    if &current!=expected{return Err(STALE.to_owned().into());}online(&current)?;permit.check()?;
    Ok(post(action,body,&permit.stop).await?)
}
async fn perform(app:&AppHandle,state:&State,operation:Operation,stop:Arc<Stop>,retained:Option<RetainedGrant>,origin:OriginPermit)->std::result::Result<Value,Failure>{
    let _serial=state.serial.lock().await;
    stop.check()?;
    origin.check()?;
    let mut permit=Permit::current(&state.epoch,stop.clone())?;
    permit.origin=origin.clone();
    let mut saved=snapshot(app).await?;permit.check()?;
    // 所有入口即时检查到期；watcher 另有每分钟兜底。清理只能发生一次，随后时间字段为零。
    if saved.expires_at!=0 && saved.expires_at<=now_ms(){
        invalidate(state,false)?;event(app,state)?;permit=Permit::current(&state.epoch,stop.clone())?;
        permit.origin=origin;
        saved=update(app,saved,DevModeChange::Clear,permit.clone()).await?;
         #[cfg(desktop)] close_tools(app);
    }
    observe(state,&permit,saved.clone(),false)?;
    match operation {
        Operation::Status=>{},
        Operation::SendCode(email)=>{online(&saved)?;permit.check()?;let result=checked_post(app,&saved,&permit,"dev_send_code",json!({"email":email})).await?;return Ok(code_reply(&result)?);},
        Operation::Verify(email,code)=>{
            online(&saved)?;permit.check()?;let result=checked_post(app,&saved,&permit,"dev_verify",json!({"email":email,"code":code})).await?;
            let masked=mask_email(&email);
            let (token,expires_at,email_masked)=grant_reply(&result,None,Some(&masked),now_ms())?;
            saved=update(app,saved,DevModeChange::Grant{token,expires_at,email_masked},permit.clone()).await?;
            observe(state,&permit,saved.clone(),true)?;event(app,state)?;return Ok(json!({"ok":true,"expiresAt":saved.expires_at}));
        },
        Operation::Enable(true)=>{
            online(&saved)?;if !valid_token(&saved.token){return Err("开发授权已失效，请验证邮箱 / 開發授權已失效，請驗證郵箱 / Authorization expired; verify your email".to_string().into());}
            permit.check()?;let result=checked_post(app,&saved,&permit,"dev_status",json!({"token":saved.token})).await?;
            let (active,expires_at,email_masked)=status_reply(&result,&saved.token,&saved.email_masked,now_ms())?;
            if active {
                saved=update(app,saved,DevModeChange::Enable{expires_at,email_masked},permit.clone()).await?;observe(state,&permit,saved.clone(),true)?;
            } else {
                saved=update(app,saved,DevModeChange::Clear,permit.clone()).await?;
         #[cfg(desktop)] close_tools(app);observe(state,&permit,saved.clone(),false)?;event(app,state)?;return Err("服务端开发授权已失效 / 伺服器開發授權已失效 / Server authorization is inactive".to_string().into());
            }
        },
        Operation::Enable(false)=>{
            let before=saved.clone();
            saved=update(app,saved,DevModeChange::Disable,permit.clone()).await?;
            #[cfg(desktop)] close_tools(app);
            let keep=retained_disable_matches(retained.as_ref(),&permit,&before,&saved,now_ms());
            observe(state,&permit,saved.clone(),keep)?;
        },
        Operation::Revoke=>{
            let token=saved.token.clone();let allowed=online(&saved).is_ok();
            saved=update(app,saved,DevModeChange::Clear,permit.clone()).await?;
         #[cfg(desktop)] close_tools(app);observe(state,&permit,saved.clone(),false)?;event(app,state)?;
            if !token.is_empty(){
                if !allowed || checked_post(app,&saved,&permit,"dev_revoke",json!({"token":token})).await.is_err(){return Err("本地开发模式已关闭；服务端撤销未确认，没有自动重试 / 本機開發模式已關閉；伺服器撤銷未確認，沒有自動重試 / Local development mode is disabled; server revocation is unconfirmed and was not retried".to_string().into());}
            }
        },
        Operation::Security(mode)=>{let keep=trusted(state,&saved);saved=update(app,saved,DevModeChange::Security(mode),permit.clone()).await?;observe(state,&permit,saved.clone(),keep)?;},
    }
    Ok(event(app,state)?)
}
fn is_control(operation:&Operation)->bool {matches!(operation,Operation::Verify(..)|Operation::Enable(_)|Operation::Revoke)}
fn expire_cached(state:&State,now:u64)->Result<bool>{
    let mut epoch=state.epoch.lock().map_err(|_|BUSY)?;
    if epoch.closed || epoch.trusted.is_none() || !epoch.cached.as_ref().is_some_and(|s|s.expires_at!=0&&s.expires_at<=now){return Ok(false);}
    epoch.generation=epoch.generation.checked_add(1).ok_or(BUSY)?;epoch.trusted=None;
    #[cfg(desktop)] state.tools.publish(&epoch, now);
    Ok(true)
}
#[cfg(test)]
pub(crate) fn fixture_permit()->Permit { Permit::current(&Arc::new(Mutex::new(Epoch::default())),Arc::new(Stop::default())).unwrap() }
#[cfg(test)]
pub(crate) fn fixture_invalidate(permit:&Permit){let mut state=permit.epoch.lock().unwrap();state.generation+=1;state.trusted=None;}
async fn run(app:&AppHandle,operation:Operation,caller_signal:bool,origin:OriginPermit)->Result<Value>{
    origin.check()?;
    let state=app.try_state::<State>().ok_or(BUSY)?;
    let request=app.try_state::<crate::lifecycle::Gate>().ok_or(BUSY)?.enter()?;
    let (owner,stop)=reserve(state.inner(),Some(request))?;
    let retained=if is_control(&operation){
        let retained=match begin_control(state.inner(),&operation){Ok(value)=>value,Err(error)=>{owner.finish();return Err(error);}};
        // 仅取消其它已登记请求；真实 worker 仍保有票据直到返回。
        if let Ok(registry)=state.registry.lock(){for task in registry.active.values(){if !Arc::ptr_eq(task,&stop){task.cancel();}}}
        // 关闭开关的最终事件等真实保存后再发，不将短暂失效误报为用户撤权。
        if !matches!(&operation,Operation::Enable(false)){let _=event(app,state.inner());}
        retained
    }else{None};
    let caller=if caller_signal {Some(Caller(stop.clone()))}else{None};
    let app=app.clone();
    let result=tokio::spawn(async move{
        let state=app.state::<State>();
        let result=perform(&app,state.inner(),operation,stop,retained,origin).await;
        let uncertain=result.as_ref().err().is_some_and(|e|e.uncertain);
        let result=result.map_err(|e|e.text);
        if !uncertain{owner.finish();}result
    }).await.map_err(|_|BUSY.to_string())?;
    drop(caller);result
}
#[cfg(desktop)]
fn close_tools(app: &AppHandle) { tools::close_all(app); }

#[cfg(desktop)]
pub(crate) fn authorize_tools_window(app: &AppHandle, window: &tauri::WebviewWindow) -> Result<()> {
    tools::authorize(app, window)
}
#[cfg(desktop)]
pub(crate) fn emit_tools_log(app: &AppHandle, payload: &Value) {
    if let Some(window) = tools::log_target(app) { let _ = window.emit("launcher:event", payload); }
}

pub(crate) async fn call(app:&AppHandle,window:&tauri::WebviewWindow,channel:&str,args:&[Value])->Result<Option<Value>>{
    let Some(operation)=parse(channel,args)? else{return Ok(None)};
    let origin=if window.label()=="devtools" {
        #[cfg(desktop)]
        { if !matches!(operation,Operation::Status|Operation::Security(_)){return Err(STALE.into());} OriginPermit { tools:Some(tools::origin(app,window)?) } }
        #[cfg(not(desktop))]
        { return Err(STALE.into()); }
    }else{crate::trusted_main(window)?;OriginPermit::default()};
    Ok(Some(run(app,operation,true,origin).await?))
}
pub(crate) async fn tools_call(app: &AppHandle, window: &tauri::WebviewWindow, channel: &str, args: &[Value]) -> Result<Option<Value>> {
    if !matches!(channel, "devmode:openTools" | "devmode:closeTools" | "devmode:openDevTools" | "devmode:closeDevTools") { return Ok(None); }
    #[cfg(not(desktop))]
    { let _ = (app, window, args); Err("移动端不支持开发工具窗口 / 行動端不支援開發工具視窗 / Developer tools are unavailable on mobile".into()) }
    #[cfg(desktop)]
    { tools::call(app, window, channel, args).await }
}

pub(crate) fn init(app:&AppHandle){
    if !app.manage(State::default()){return;}
    #[cfg(desktop)] tools::init(app);
    let app=app.clone();
    tauri::async_runtime::spawn(async move{
        loop{
            let state=app.state::<State>();
            tokio::select!{_ = state.shutdown.wait()=>break,_=tokio::time::sleep(Duration::from_secs(60))=>{}}
            if state.shutdown.check().is_err(){break;}
            // 即使旧请求仍在等待网络，也先回收进程内有效授权，再排队持久化清理。
            if expire_cached(state.inner(),now_ms()).unwrap_or(false){
                 #[cfg(desktop)] close_tools(&app);
                if let Ok(registry)=state.registry.lock(){for stop in registry.active.values(){stop.cancel();}}
                let _=event(&app,state.inner());
            }
            if app.try_state::<Storage>().is_some(){let _=run(&app,Operation::Status,false,OriginPermit::default()).await;}
        }
    });
}
pub(crate) fn invalidate_for_settings_change(app:&AppHandle)->Result<()> {
    let state=app.try_state::<State>().ok_or(BUSY)?;
    {
        let mut epoch=state.epoch.lock().map_err(|_|BUSY)?;
        epoch.generation=epoch.generation.checked_add(1).ok_or(BUSY)?;
        epoch.trusted=None;
        epoch.cached=None;
        epoch.last_event=None;
        #[cfg(desktop)] state.tools.publish(&epoch,now_ms());
    }
    #[cfg(desktop)] close_tools(app);
    let registry=state.registry.lock().map_err(|_|BUSY)?;
    for stop in registry.active.values(){stop.cancel();}
    drop(registry);
    let _=event(app,state.inner());
    Ok(())
}
pub(crate) fn cancel_for_window(app:&AppHandle){
    if let Some(state)=app.try_state::<State>(){
        let _=invalidate(state.inner(),true);
        #[cfg(mobile)] state.shutdown.cancel();
        if let Ok(mut registry)=state.registry.lock(){registry.closed=true;for stop in registry.active.values(){stop.cancel();}}
    }
    #[cfg(desktop)] close_tools(app);
}
#[cfg(desktop)]
pub(crate) async fn shutdown_tools(app:&AppHandle)->Result<()> {
    // 先确认原生窗口实际收尾，再停维护；失败仍保留记录和维护，允许原生退出按钮重试。
    tools::shutdown(app).await?;
    if let Some(state)=app.try_state::<State>() { state.shutdown.cancel(); }
    Ok(())
}
pub(crate) fn relaunch_ready(app:&AppHandle)->Result<()>{
    let state=app.try_state::<State>().ok_or(BUSY)?;
    {
        let registry=state.registry.try_lock().map_err(|_|BUSY)?;
        if registry.closed||registry.uncertain||!registry.active.is_empty(){return Err(BUSY.into());}
    }
    #[cfg(desktop)] tools::relaunch_ready(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token() -> String { "AbC123456789abcdef0123456789ABCDEF0123456789abcdef0123456789ABCD".into() }

    #[test]
    fn parse_rejects_wrong_shape_and_accepts_fixed_inputs() {
        assert!(parse("devmode:sendCode", &[]).is_err());
        assert!(parse("devmode:sendCode", &[json!("a@b.example")]).is_ok());
        assert!(parse("devmode:verify", &[json!("a@b.example"), json!("123456")]).is_ok());
        assert!(parse("devmode:verify", &[json!("a@b.example"), json!("12345")]).is_err());
        assert!(parse("devmode:setSecurityMode", &[json!("off")]).is_ok());
        assert!(parse("devmode:setSecurityMode", &[json!("unsafe")]).is_err());
    }

    #[test]
    fn endpoint_is_fixed_and_never_carries_product() {
        let url = endpoint("dev_status").unwrap();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("hcmcl.johnnyblog.top"));
        assert_eq!(url.path(), "/api.php");
        assert_eq!(url.query(), Some("action=dev_status"));
        assert!(endpoint("dev_status&product=hcmcl").is_err());
    }

    #[test]
    fn grant_preserves_token_case_and_bounds_expiry() {
        let now = 1_000_000;
        let original = token();
        let value = json!({"ok":true,"token":original,"expiresAt":now + DAY_MS});
        let (received, expires, masked) = grant_reply(&value, None, Some("a***@b.example"), now).unwrap();
        assert_eq!(received, original);
        assert_eq!(expires, now + DAY_MS);
        assert_eq!(masked, "a***@b.example");
        assert!(validate_grant(&received, now, "a***@b.example", now).is_err());
        assert!(validate_grant(&received, now + DAY_MS + 1, "a***@b.example", now).is_err());
    }

    #[test]
    fn status_requires_strict_active_projection() {
        let now = 2_000_000;
        let original = token();
        let active = json!({"ok":true,"active":true,"expiresAt":now + 1,"emailMasked":"a***@b.example"});
        assert_eq!(status_reply(&active, &original, "a***@b.example", now).unwrap(), (true, now + 1, "a***@b.example".into()));
        let inactive = json!({"ok":true,"active":false,"expiresAt":0,"emailMasked":""});
        assert_eq!(status_reply(&inactive, &original, "a***@b.example", now).unwrap(), (false, 0, String::new()));
        assert!(status_reply(&json!({"ok":true,"active":false,"expiresAt":0,"emailMasked":"bad"}), &original, "a***@b.example", now).is_err());
        assert!(status_reply(&json!({"ok":true,"active":true,"expiresAt":now + 1,"emailMasked":""}), &original, "a***@b.example", now).is_err());
        assert!(status_reply(&json!({"ok":true,"active":true,"expiresAt":now + 1,"emailMasked":"b***@b.example"}), &original, "a***@b.example", now).is_err());
    }

    #[test]
    fn projection_fails_closed_without_trusted_snapshot() {
        let snapshot = DevModeSnapshot { revision: 1, mode: "normal".into(), token: token(), expires_at: 10_000, email_masked: "a***@b.example".into(), enabled: true, security_mode: "off".into() };
        assert_eq!(projection(Some(&snapshot), None, 1_000)["granted"], false);
        assert_eq!(projection(Some(&snapshot), Some(&snapshot), 1_000)["granted"], true);
        let mut local = snapshot.clone(); local.mode = "local".into();
        assert_eq!(projection(Some(&local), Some(&local), 1_000)["granted"], false);
        assert_eq!(projection(None, None, 1_000)["enabled"], false);
    }

    fn saved_grant(now:u64)->DevModeSnapshot {
        DevModeSnapshot { revision:1,mode:"normal".into(),token:token(),expires_at:now+60_000,
            email_masked:"a***@b.example".into(),enabled:true,security_mode:"off".into() }
    }

    #[test]
    fn verified_grant_survives_disable_status_and_online_reenable_projection() {
        let now=1_000_000;let state=State::default();let before=saved_grant(now);
        let first=Permit::current(&state.epoch,Arc::new(Stop::default())).unwrap();
        observe(&state,&first,before.clone(),true).unwrap();
        let retained=begin_control(&state,&Operation::Enable(false)).unwrap();
        let permit=Permit::current(&state.epoch,Arc::new(Stop::default())).unwrap();
        let mut disabled=before.clone();disabled.revision+=1;disabled.enabled=false;
        let keep=retained_disable_matches(retained.as_ref(),&permit,&before,&disabled,now);
        assert!(keep);observe(&state,&permit,disabled.clone(),keep).unwrap();
        // Status 观察相同快照不应丢失已验证的授权；有效防护仍强制 full。
        observe(&state,&permit,disabled.clone(),false).unwrap();
        let epoch=state.epoch.lock().unwrap();
        let status=projection(epoch.cached.as_ref(),epoch.trusted.as_ref(),now);
        assert_eq!(status["granted"],true);assert_eq!(status["enabled"],false);
        assert_eq!(status["expiresAt"],before.expires_at);assert_eq!(status["emailMasked"],before.email_masked);
        assert_eq!(status["effectiveSecurityMode"],"full");drop(epoch);
        assert!(begin_control(&state,&Operation::Enable(true)).unwrap().is_none());
        let permit=Permit::current(&state.epoch,Arc::new(Stop::default())).unwrap();
        let reply=json!({"ok":true,"active":true,"expiresAt":before.expires_at,"emailMasked":before.email_masked});
        let (active,expires,masked)=status_reply(&reply,&disabled.token,&disabled.email_masked,now).unwrap();
        assert!(active);let mut enabled=disabled;enabled.revision+=1;enabled.enabled=true;enabled.expires_at=expires;enabled.email_masked=masked;
        observe(&state,&permit,enabled.clone(),true).unwrap();
        assert_eq!(projection(Some(&enabled),Some(&enabled),now)["enabled"],true);
    }

    #[test]
    fn disable_never_trusts_unverified_changed_expired_or_old_epoch_grants() {
        let now=1_000_000;let before=saved_grant(now);let state=State::default();
        let permit=Permit::current(&state.epoch,Arc::new(Stop::default())).unwrap();
        observe(&state,&permit,before.clone(),false).unwrap();
        assert!(begin_control(&state,&Operation::Enable(false)).unwrap().is_none());
        let permit=Permit::current(&state.epoch,Arc::new(Stop::default())).unwrap();
        observe(&state,&permit,before.clone(),true).unwrap();
        let retained=begin_control(&state,&Operation::Enable(false)).unwrap();
        let permit=Permit::current(&state.epoch,Arc::new(Stop::default())).unwrap();
        let mut after=before.clone();after.revision+=1;after.enabled=false;
        assert!(retained_disable_matches(retained.as_ref(),&permit,&before,&after,now));
        assert!(!retained_disable_matches(retained.as_ref(),&permit,&before,&after,before.expires_at));
        let mut changed=after.clone();changed.mode="local".into();
        assert!(!retained_disable_matches(retained.as_ref(),&permit,&before,&changed,now));
        changed=after.clone();changed.token="b".repeat(64);
        assert!(!retained_disable_matches(retained.as_ref(),&permit,&before,&changed,now));
        invalidate(&state,false).unwrap();
        let fresh=Permit::current(&state.epoch,Arc::new(Stop::default())).unwrap();
        assert!(!retained_disable_matches(retained.as_ref(),&fresh,&before,&after,now));
        assert!(observe(&state,&permit,after,true).is_err());
    }

    #[test]
    fn permit_is_invalid_after_epoch_change() {
        let permit = fixture_permit();
        assert!(permit.check().is_ok());
        fixture_invalidate(&permit);
        assert!(permit.check().is_err());
    }
}

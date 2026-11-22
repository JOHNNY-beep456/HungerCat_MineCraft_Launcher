//! Tauri 认证域：微软设备代码流与 Yggdrasil；原始凭据只在 Rust 内存和 Storage 中流转。
//! 接线：dispatcher 调用 call；主窗口关闭时可调用 cancel_for_window（首次调用也注册关闭清理）。
//! auth:begin 返回的 deviceCode 是随机会话引用，真实设备代码与 Cookie 不进入 WebView。
use crate::storage::Storage;
use reqwest::{Client, Url};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};
use tokio::sync::Notify;
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;
const CLIENT_ID: &str = "00000000441cc96b";
const SCOPE: &str = "service::user.auth.xboxlive.com::MBI_SSL";
const DEVICE: &str = "https://login.live.com/oauth20_connect.srf";
const TOKEN: &str = "https://login.live.com/oauth20_token.srf";
const CONSUMERS: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const XBL: &str = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS: &str = "https://xsts.auth.xboxlive.com/xsts/authorize";
const MC_LOGIN: &str = "https://api.minecraftservices.com/authentication/login_with_xbox";
const MC_PROFILE: &str = "https://api.minecraftservices.com/minecraft/profile";
const MAX_RESPONSE: usize = 1024 * 1024;
const YGG_TTL_MS: u64 = 10 * 60 * 1000;

#[derive(Default)]
struct Cancellation { flag: AtomicBool, notify: Notify }
impl Cancellation {
    fn cancel(&self) { self.flag.store(true, Ordering::SeqCst); self.notify.notify_waiters(); }
    fn check(&self) -> Result<()> {
        if self.flag.load(Ordering::SeqCst) { Err("认证操作已取消".into()) } else { Ok(()) }
    }
    async fn cancelled(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.flag.load(Ordering::SeqCst) { return; }
            notified.await;
        }
    }
}
#[derive(Clone)]
struct Ticket { id: Uuid, cancel: Arc<Cancellation> }
impl Ticket { fn new() -> Self { Self { id: Uuid::new_v4(), cancel: Arc::new(Cancellation::default()) } } }
#[derive(Clone, Copy)]
enum Kind { Microsoft, Yggdrasil }
struct PendingYgg { ticket: Ticket, expires_at: u64, base: String, data: Value, client_token: String, site: Option<String> }
#[derive(Default)]
struct Sessions {
    microsoft: Option<Ticket>, yggdrasil: Option<Ticket>, pending: Option<PendingYgg>,
    refresh: HashMap<String, Ticket>, generation: u64,
}
#[derive(Default)]
struct Shared {
    sessions: Mutex<Sessions>, refresh_gate: tokio::sync::Mutex<()>,
    closed: AtomicBool, close_notify: Notify,
    background_workers: AtomicUsize, background_unknown: AtomicBool,
}
impl Shared {
    fn check_open(&self) -> Result<()> {
        if self.closed.load(Ordering::SeqCst) { Err("认证窗口已关闭".into()) } else { Ok(()) }
    }
    async fn closed(&self) {
        loop {
            let notified=self.close_notify.notified();tokio::pin!(notified);notified.as_mut().enable();
            if self.closed.load(Ordering::SeqCst) {return;}
            notified.await;
        }
    }
}
#[derive(Clone)]
struct AuthState(Arc<Shared>);

struct BackgroundWorker { shared: Arc<Shared>, completed: bool }
impl BackgroundWorker {
    fn begin(shared: Arc<Shared>) -> Self {
        shared.background_workers.fetch_add(1, Ordering::SeqCst);
        Self { shared, completed: false }
    }
    fn complete(mut self) {
        self.shared.background_workers.fetch_sub(1, Ordering::SeqCst);
        self.completed = true;
    }
}
impl Drop for BackgroundWorker {
    fn drop(&mut self) {
        // 未到实际拥有者末尾的 Drop 不能证明存档/事件已结束；保留计数并拒绝重启。
        if !self.completed { self.shared.background_unknown.store(true, Ordering::SeqCst); }
    }
}
fn spawn_background(background: BackgroundWorker, work: impl Future<Output = ()> + Send + 'static) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move { work.await; background.complete(); })
}
fn relaunch_ready_shared(shared: &Shared) -> Result<()> {
    shared.check_open()?;
    if shared.background_unknown.load(Ordering::SeqCst) { return Err("认证后台收尾状态未知，不能重启".into()); }
    if shared.background_workers.load(Ordering::SeqCst) != 0 { return Err("认证后台任务仍在运行，不能重启".into()); }
    let sessions = shared.sessions.try_lock().map_err(|_| "认证状态忙碌或不可用，不能重启")?;
    if sessions.microsoft.is_some() || sessions.yggdrasil.is_some() || sessions.pending.is_some() || !sessions.refresh.is_empty() {
        return Err("认证或账号刷新尚未结束，不能重启".into());
    }
    let _refresh = shared.refresh_gate.try_lock().map_err(|_| "账号刷新仍在运行，不能重启")?;
    shared.check_open()?;
    if shared.background_unknown.load(Ordering::SeqCst) || shared.background_workers.load(Ordering::SeqCst) != 0 {
        return Err("认证后台尚未确认结束，不能重启".into());
    }
    Ok(())
}
/// 仅观察已存在的认证域；全 IPC 重启排他门由调用方持有，本函数不初始化、取消或清理。
pub(crate) fn relaunch_ready(app: &tauri::AppHandle) -> Result<()> {
    match app.try_state::<AuthState>() { Some(state) => relaunch_ready_shared(&state.0), None => Ok(()) }
}

fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
fn shared(app: &tauri::AppHandle) -> Arc<Shared> {
    if let Some(state) = app.try_state::<AuthState>() { return state.0.clone(); }
    let state = Arc::new(Shared::default());
    if app.manage(AuthState(state.clone())) {
        if let Some(window) = app.get_webview_window("main") {
            let state = state.clone();
            window.on_window_event(move |event| {
                if crate::invalidates_main_window(event) {
                    cancel_window_shared(state.clone());
                }
            });
        }
    }
    app.state::<AuthState>().0.clone()
}
fn cancel_sessions(sessions: &mut Sessions) {
    sessions.generation = sessions.generation.wrapping_add(1);
    if let Some(ticket) = sessions.microsoft.take() { ticket.cancel.cancel(); }
    if let Some(ticket) = sessions.yggdrasil.take() { ticket.cancel.cancel(); }
    sessions.pending = None;
    for (_, ticket) in sessions.refresh.drain() { ticket.cancel.cancel(); }
}
fn cancel_shared(shared: &Shared) {
    // 后台和纯测试可同步使用；毒化状态仍必须取消并推进 generation。
    let mut sessions = shared.sessions.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    cancel_sessions(&mut sessions);
}
fn try_cancel_shared(shared: &Shared) -> bool {
    match shared.sessions.try_lock() {
        Ok(mut sessions) => { cancel_sessions(&mut sessions); true },
        Err(std::sync::TryLockError::Poisoned(poisoned)) => {
            cancel_sessions(&mut poisoned.into_inner()); true
        },
        Err(std::sync::TryLockError::WouldBlock) => false,
    }
}
fn cancel_window_shared(shared: Arc<Shared>) {
    // 原子关闭先于锁：UI 不等待存档，关闭之后迟到的入口也不能再登记票据。
    shared.closed.store(true,Ordering::SeqCst);shared.close_notify.notify_waiters();
    if !try_cancel_shared(&shared) {
        // Storage 的 Android Keystore 桥可能持锁等待 UI 调度；窗口回调绝不能在此等锁。
        // 后台确实拿锁后才推进 generation 并取消全部 ticket，不把排队误认为取消完成。
        tauri::async_runtime::spawn_blocking(move || cancel_shared(&shared));
    }
}
/// 主窗口生命周期钩子；UI 不等 sessions 锁，不发送事件或触碰账号存档。
pub fn cancel_for_window(app: &tauri::AppHandle) {
    // 尚未进行过登录也要留下关闭标记，阻止旧 IPC 在关闭后首次初始化认证域。
    cancel_window_shared(shared(app));
}
fn replace_ticket(shared: &Shared, kind: Kind) -> Result<Ticket> {
    let mut sessions = shared.sessions.lock().map_err(|_| "认证状态不可用")?;
    shared.check_open()?;
    let slot = match kind { Kind::Microsoft => &mut sessions.microsoft, Kind::Yggdrasil => &mut sessions.yggdrasil };
    if let Some(old) = slot.take() { old.cancel.cancel(); }
    let ticket = Ticket::new(); *slot = Some(ticket.clone());
    if matches!(kind, Kind::Yggdrasil) { sessions.pending = None; }
    Ok(ticket)
}
fn active(sessions: &Sessions, kind: Kind, ticket: &Ticket) -> bool {
    let slot = match kind { Kind::Microsoft => &sessions.microsoft, Kind::Yggdrasil => &sessions.yggdrasil };
    !ticket.cancel.flag.load(Ordering::SeqCst) && slot.as_ref().map(|t| t.id) == Some(ticket.id)
}
fn finish(shared: &Shared, kind: Kind, ticket: &Ticket) {
    if let Ok(mut sessions) = shared.sessions.lock() {
        let owned = match kind { Kind::Microsoft => &sessions.microsoft, Kind::Yggdrasil => &sessions.yggdrasil }.as_ref().map(|t|t.id)==Some(ticket.id);
        if owned {
            ticket.cancel.cancel();
            match kind { Kind::Microsoft => sessions.microsoft = None, Kind::Yggdrasil => { sessions.yggdrasil = None; sessions.pending = None; } }
        }
    }
}
fn trusted_main(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("main").and_then(|w| w.url().ok()).map(|url| {
        (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
            || (cfg!(debug_assertions) && url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1")) && url.port() == Some(1420))
    }).unwrap_or(false)
}
fn emit_status(app: &tauri::AppHandle, shared: &Shared, ticket: &Ticket, payload: Value) {
    if !trusted_main(app) { return; }
    if let Ok(sessions) = shared.sessions.lock() {
        if shared.check_open().is_ok() && active(&sessions, Kind::Microsoft, ticket) {
            let _ = app.emit_to("main", "launcher:event", json!({"channel":"auth:status", "payload":payload}));
        }
    }
}
async fn cancellable<T>(cancel: &Cancellation, future: impl Future<Output = Result<T>>) -> Result<T> {
    cancel.check()?;
    tokio::select! { biased; _ = cancel.cancelled() => Err("认证操作已取消".into()), result = future => result }
}
async fn wait(cancel: &Cancellation, seconds: u64) -> Result<()> {
    cancellable(cancel, async { tokio::time::sleep(Duration::from_secs(seconds)).await; Ok(()) }).await
}
fn client() -> Result<Client> {
    Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(10))
        .user_agent("HungerCatLauncher/Tauri").build().map_err(|_| "无法初始化认证网络".into())
}
struct Reply { status: u16, data: Value, cookies: String }
enum Body { None, Json(Value), Form(Vec<(String, String)>) }
async fn request(client: &Client, cancel: &Cancellation, url: &str, body: Body, bearer: Option<&str>, timeout: u64) -> Result<Reply> {
    cancellable(cancel, async {
        let mut request = match body {
            Body::None => client.get(url), Body::Json(value) => client.post(url).json(&value),
            Body::Form(value) => client.post(url).form(&value),
        }.timeout(Duration::from_secs(timeout)).header("Accept", "application/json");
        if let Some(token) = bearer { request = request.bearer_auth(token); }
        read_reply(request.send().await.map_err(|_| "认证网络请求失败或超时")?).await
    }).await
}
async fn read_reply(mut response: reqwest::Response) -> Result<Reply> {
    let status = response.status().as_u16();
    if response.content_length().unwrap_or(0) > MAX_RESPONSE as u64 { return Err("认证响应过大".into()); }
    let cookies = response.headers().get_all(reqwest::header::SET_COOKIE).iter()
        .filter_map(|v| v.to_str().ok()).filter_map(|v| v.split(';').next()).filter(|v| {
            v.len() <= 4096 && v.contains('=') && !v.chars().any(char::is_control)
        }).collect::<Vec<_>>().join("; ");
    if cookies.len() > 16384 { return Err("认证 Cookie 过大".into()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "认证响应读取失败")? {
        if bytes.len() + chunk.len() > MAX_RESPONSE { return Err("认证响应过大".into()); }
        bytes.extend_from_slice(&chunk);
    }
    let data = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
    if (200..300).contains(&status) && !data.is_object() { return Err("认证服务返回无效数据".into()); }
    Ok(Reply { status, data, cookies })
}
fn success(reply: Reply, message: &str) -> Result<Value> {
    if (200..300).contains(&reply.status) { Ok(reply.data) }
    else { Err(format!("{message}（HTTP {}）", reply.status)) }
}
fn text<'a>(value: &'a Value, field: &str) -> &'a str { value.get(field).and_then(Value::as_str).unwrap_or("") }
fn token(raw: &str) -> Result<String> {
    if raw.is_empty() || raw.len() > 32768 || raw.chars().any(|c| c.is_control() || c.is_whitespace()) { Err("认证令牌无效".into()) }
    else { Ok(raw.to_owned()) }
}
fn uuid(raw: &str) -> Result<String> {
    if !matches!(raw.len(), 32 | 36) { return Err("角色 UUID 无效".into()); }
    Uuid::parse_str(raw).map(|id| id.simple().to_string()).map_err(|_| "角色 UUID 无效".into())
}
fn name(raw: &str) -> Result<String> {
    if raw.trim().is_empty() || raw.encode_utf16().count() > 64 || raw.chars().any(char::is_control) { Err("角色名称无效".into()) } else { Ok(raw.into()) }
}
fn arg_count(args: &[Value], count: usize) -> Result<()> { if args.len() == count { Ok(()) } else { Err("认证参数数量无效".into()) } }
fn arg<'a>(args: &'a [Value], index: usize) -> Result<&'a str> { args.get(index).and_then(Value::as_str).ok_or_else(|| "认证参数类型无效".into()) }
fn public_account(account: &Value) -> Value {
    let mut public = Map::new();
    for key in ["id","name","expiresAt","skinUrl","capeUrl","skinModel","addedAt","offline","authType","yggdrasilServer","siteName"] {
        if let Some(value) = account.get(key) { public.insert(key.into(), value.clone()); }
    }
    Value::Object(public)
}
#[derive(Clone)]
struct MicrosoftAuth { client: String, scope: String, endpoint: String }
impl MicrosoftAuth {
    fn local() -> Self { Self { client: CLIENT_ID.into(), scope: SCOPE.into(), endpoint: "live".into() } }
    fn from_account(account: &Value) -> Result<Self> {
        let value = match account.get("microsoftAuth") { None => return Ok(Self::local()), Some(value) => value };
        let client = text(value, "clientId");
        let valid = (client.len() == 16 && client.bytes().all(|c| c.is_ascii_hexdigit())) || (client.len() == 36 && Uuid::parse_str(client).is_ok());
        let scope = text(value, "scope"); let endpoint = text(value, "endpoint");
        if !valid || scope.is_empty() || scope.len() > 1024 || scope.chars().any(char::is_control) || !matches!(endpoint, "live" | "consumers") {
            return Err("该账号的微软授权来源缺失或无效，请重新登录".into());
        }
        Ok(Self { client: client.into(), scope: scope.into(), endpoint: endpoint.into() })
    }
    // 外来账号必须显式携带来源；不能沿用普通登录的本地 clientId 兜底。
    fn from_import(account: &Value) -> Result<Self> {
        if !account.get("microsoftAuth").is_some_and(Value::is_object) {
            return Err("该导入账号缺少可信微软授权来源，请重新登录".into());
        }
        Self::from_account(account)
    }
    fn value(&self) -> Value { json!({"clientId":self.client,"scope":self.scope,"endpoint":self.endpoint}) }
    fn token_url(&self) -> &'static str { if self.endpoint == "consumers" { CONSUMERS } else { TOKEN } }
    fn prefix(&self) -> &'static str { if self.scope.to_ascii_lowercase().contains("xboxlive.signin") { "d" } else { "t" } }
}
struct Device { code: String, cookie: String, expires: u64, interval: u64, started: u64, auth: MicrosoftAuth }
fn device_info(data: &Value, ticket: &Ticket) -> Result<(Value, String, u64, u64)> {
    let code = token(text(data,"device_code"))?;
    let user = text(data,"user_code");
    if user.is_empty() || user.len() > 128 || user.chars().any(char::is_control) { return Err("登录代码无效".into()); }
    let expires = data["expires_in"].as_u64().filter(|n| *n > 0 && *n <= 86400).ok_or("登录代码有效期无效")?;
    let interval = data["interval"].as_u64().unwrap_or(5).clamp(1,60);
    let uri = data.get("verification_uri_complete").or_else(|| data.get("verification_uri")).and_then(Value::as_str)
        .map(str::to_string).unwrap_or_else(|| format!("https://microsoft.com/link?otc={}", url_component(user)));
    let parsed = Url::parse(&uri).map_err(|_| "登录验证地址无效")?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() || !matches!(parsed.host_str(), Some("microsoft.com" | "www.microsoft.com" | "login.live.com" | "login.microsoftonline.com")) || parsed.port_or_known_default() != Some(443) {
        return Err("登录验证地址不可信".into());
    }
    Ok((json!({"userCode":user,"deviceCode":ticket.id.to_string(),"verificationUri":uri,"message":"请在微软授权页面输入登录代码", "expiresIn":expires,"interval":interval}),code,expires,interval))
}
fn url_component(value: &str) -> String {
    value.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}
async fn begin(app: &tauri::AppHandle, shared: Arc<Shared>) -> Result<Value> {
    let ticket = replace_ticket(&shared, Kind::Microsoft)?;
    let result = async {
        let client = client()?; let auth = MicrosoftAuth::local();
        let reply = request(&client,&ticket.cancel,DEVICE,Body::Form(vec![("client_id".into(),auth.client.clone()),("scope".into(),auth.scope.clone()),("response_type".into(),"device_code".into())]),None,10).await?;
        let cookie = reply.cookies.clone(); let data = success(reply,"获取登录代码失败")?;
        let (info, code, expires, interval) = device_info(&data,&ticket)?;
        if !trusted_main(app) {return Err("认证操作已取消".into());}
        let background = {
            let sessions = shared.sessions.lock().map_err(|_| "认证状态不可用")?;
            if shared.check_open().is_err() || !active(&sessions,Kind::Microsoft,&ticket) { return Err("认证操作已取消".into()); }
            // 仍持会话锁且尚未 spawn 时登记；清票取消不代表后台存档和事件已退出。
            BackgroundWorker::begin(shared.clone())
        };
        let device = Device { code,cookie,expires,interval,started:now_ms(),auth };
        let app = app.clone(); let shared = shared.clone(); let background_ticket = ticket.clone();
        spawn_background(background, async move {
            let result = poll(&app,&shared,&client,&background_ticket,&device).await;
            match result {
                Ok(account) => {
                    match save_guarded(&app,shared.clone(),Kind::Microsoft,background_ticket.clone(),vec![account],false).await {
                        Ok(accounts) => emit_status(&app,&shared,&background_ticket,json!({"state":"success","account":accounts[0]})),
                        Err(error) => emit_status(&app,&shared,&background_ticket,json!({"state":"error","error":error})),
                    }
                }
                Err(error) => emit_status(&app,&shared,&background_ticket,json!({"state":"error","error":error})),
            }
            finish(&shared,Kind::Microsoft,&background_ticket);
        });
        Ok(info)
    }.await;
    if result.is_err() { finish(&shared,Kind::Microsoft,&ticket); }
    result
}
async fn poll(app: &tauri::AppHandle,shared: &Shared,client: &Client, ticket: &Ticket, device: &Device) -> Result<Value> {
    let mut interval = device.interval;
    loop {
        wait(&ticket.cancel,interval).await?;
        if now_ms().saturating_sub(device.started) >= device.expires * 1000 { return Err("登录代码已过期，请重新发起".into()); }
        let reply = cancellable(&ticket.cancel,async {
            let mut request = client.post(format!("{TOKEN}?client_id={}",url_component(&device.auth.client)))
                .form(&[("grant_type","urn:ietf:params:oauth:grant-type:device_code"),("client_id",&device.auth.client),("device_code",&device.code)]);
            if !device.cookie.is_empty() { request = request.header(reqwest::header::COOKIE,&device.cookie); }
            read_reply(request.send().await.map_err(|_| "微软登录轮询失败或超时")?).await
        }).await?;
        if (200..300).contains(&reply.status) {
            return microsoft_chain(client,&ticket.cancel,&device.auth,token(text(&reply.data,"access_token"))?,token(text(&reply.data,"refresh_token"))?,None,None).await;
        }
        match poll_error(&reply,interval)? {
            Some(next) => interval=next,
            None => emit_status(app,shared,ticket,json!({"state":"waiting","elapsed":now_ms().saturating_sub(device.started)/1000,"expiresIn":device.expires})),
        }
        // 只发经过结构化构造的状态，不回显远端错误正文。
    }
}
fn poll_error(reply:&Reply,interval:u64)->Result<Option<u64>> {
    match text(&reply.data,"error") {
        "authorization_pending"=>Ok(None),"slow_down"=>Ok(Some(interval.saturating_add(5).min(120))),
        "authorization_declined"|"access_denied"=>Err("你取消了本次登录授权".into()),
        "expired_token"=>Err("登录代码已过期，请重新发起".into()),"bad_verification_code"=>Err("登录代码无效".into()),
        _=>Err(format!("微软登录轮询失败（HTTP {}），请重新登录",reply.status)),
    }
}
fn xsts_error(data: &Value) -> Option<String> {
    let code = data.get("XErr").and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))?;
    match code {
        0 => None, 2148916233 => Some("该微软账号没有 Xbox 档案，请先在 xbox.com 创建".into()),
        2148916238 => Some("该账号是儿童账号，需要家长授权".into()),2148916235 => Some("Xbox Live 在该地区不可用".into()),
        _ => Some(format!("XSTS 认证失败（XErr {code}）")),
    }
}
async fn microsoft_chain(client: &Client,cancel: &Cancellation,auth: &MicrosoftAuth,ms_token: String,refresh: String,added_at: Option<u64>,expected: Option<&str>) -> Result<Value> {
    microsoft_chain_at(client,cancel,auth,ms_token,refresh,added_at,expected,[XBL,XSTS,MC_LOGIN,MC_PROFILE]).await
}
// 私有端点参数仅供模块内链路复用和本地夹具；IPC 永远使用上面的固定微软地址。
async fn microsoft_chain_at(client: &Client,cancel: &Cancellation,auth: &MicrosoftAuth,ms_token: String,refresh: String,added_at: Option<u64>,expected: Option<&str>,endpoints:[&str;4]) -> Result<Value> {
    let xbl = success(request(client,cancel,endpoints[0],Body::Json(json!({"Properties":{"AuthMethod":"RPS","SiteName":"user.auth.xboxlive.com","RpsTicket":format!("{}={ms_token}",auth.prefix())},"RelyingParty":"http://auth.xboxlive.com","TokenType":"JWT"})),None,10).await?,"Xbox Live 认证失败")?;
    let xbl_token = token(text(&xbl,"Token"))?;
    let uhs = token(xbl.pointer("/DisplayClaims/xui/0/uhs").and_then(Value::as_str).unwrap_or(""))?;
    let reply = request(client,cancel,endpoints[1],Body::Json(json!({"Properties":{"SandboxId":"RETAIL","UserTokens":[xbl_token]},"RelyingParty":"rp://api.minecraftservices.com/","TokenType":"JWT"})),None,10).await?;
    if let Some(error) = xsts_error(&reply.data) { return Err(error); }
    let xsts = success(reply,"XSTS 认证失败")?; let xsts_token = token(text(&xsts,"Token"))?;
    let mc = success(request(client,cancel,endpoints[2],Body::Json(json!({"identityToken":format!("XBL3.0 x={uhs};{xsts_token}")})),None,10).await?,"Minecraft 服务登录失败")?;
    let access = token(text(&mc,"access_token"))?;
    let expires = mc.get("expires_in").and_then(Value::as_u64).unwrap_or(86400);
    if expires == 0 || expires > 31 * 86400 { return Err("Minecraft 令牌有效期无效".into()); }
    let reply = request(client,cancel,endpoints[3],Body::None,Some(&access),10).await?;
    if reply.status == 404 { return Err("该账号没有 Minecraft Java 玩家档案，请确认已购买并创建角色".into()); }
    let profile = success(reply,"获取 Minecraft 玩家档案失败")?;
    microsoft_account(&profile,access,refresh,now_ms()+expires*1000,added_at,expected,auth)
}
fn microsoft_account(profile: &Value,access: String,refresh: String,expires: u64,added_at: Option<u64>,expected: Option<&str>,auth: &MicrosoftAuth) -> Result<Value> {
    let id = uuid(text(profile,"id"))?;
    if expected.is_some_and(|expected| expected != id) { return Err("微软账号角色 UUID 与原账号不匹配，未覆盖存档".into()); }
    let mut account = json!({"id":id,"name":name(text(profile,"name"))?,"accessToken":access,"refreshToken":refresh,"expiresAt":expires,"addedAt":added_at.unwrap_or_else(now_ms),"offline":false,"authType":"microsoft","microsoftAuth":auth.value()});
    for (field,list) in [("skinUrl","skins"),("capeUrl","capes")] {
        if let Some(items) = profile.get(list).and_then(Value::as_array) {
            if let Some(item) = items.iter().find(|p| text(p,"state")=="ACTIVE") {
                if let Some(url) = texture_url(text(item,"url")) { account[field] = json!(url); }
                if list=="skins" { account["skinModel"] = json!(if text(item,"variant").eq_ignore_ascii_case("slim") {"slim"} else {"classic"}); }
            }
        }
    }
    Ok(account)
}
async fn save_guarded(app: &tauri::AppHandle, shared: Arc<Shared>,kind: Kind,ticket: Ticket,accounts: Vec<Value>,select: bool) -> Result<Vec<Value>> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !trusted_main(&app) {return Err("认证操作已取消".into());}
        let sessions = shared.sessions.lock().map_err(|_| "认证状态不可用")?;
        if shared.check_open().is_err() || !active(&sessions,kind,&ticket) { return Err("认证操作已取消".into()); }
        let storage = app.state::<Storage>();
        // 与取消/新一代登录共用这把提交锁；取消返回后旧任务不能再次写入。
        storage.save_accounts_for_backend(accounts.clone())?;
        if select && !accounts.is_empty() { storage.call("accounts:select",&[accounts[0]["id"].clone()])?; }
        Ok(accounts.iter().map(public_account).collect())
    }).await.map_err(|_| "账号存档任务异常")?
}

pub(crate) fn ygg_base(raw: &str) -> Result<String> {
    let raw = raw.trim().trim_end_matches('/');
    if raw.is_empty() || raw.len()>2048 || raw.chars().any(|c| c.is_control() || c.is_whitespace()) { return Err("认证服务器地址无效".into()); }
    let lower = raw.to_ascii_lowercase();
    let explicit = lower.starts_with("https://") || lower.starts_with("http://");
    if !explicit {
        // 只给裸主机补 HTTPS；file:/// 等其它 URI 不能被重解释成主机名和路径。
        if raw.contains("://") || raw.starts_with('/') || raw.contains('\\') {
            return Err("认证服务器地址无效".into());
        }
        let authority = raw.split('/').next().unwrap_or("");
        let port = if authority.starts_with('[') {
            authority.split_once(']').map(|(_, suffix)| suffix)
        } else {
            authority.find(':').map(|index| &authority[index..])
        };
        if let Some(port) = port.filter(|port| !port.is_empty()) {
            if !port.strip_prefix(':').map(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())).unwrap_or(false) {
                return Err("认证服务器地址无效".into());
            }
        }
    }
    let candidate = if explicit { raw.to_owned() } else { format!("https://{raw}") };
    let mut url = Url::parse(&candidate).map_err(|_| "认证服务器地址无效")?;
    if !matches!(url.scheme(),"https"|"http") || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("认证服务器地址无效".into());
    }
    if !explicit && !url.path().trim_end_matches('/').to_ascii_lowercase().ends_with("/api/yggdrasil") {
        let path = format!("{}/api/yggdrasil",url.path().trim_end_matches('/')); url.set_path(&path);
    }
    Ok(url.as_str().trim_end_matches('/').into())
}
fn texture_url(raw: &str) -> Option<String> {
    if raw.is_empty() || raw.len()>8192 || raw.chars().any(char::is_control) { return None; }
    let url = Url::parse(raw).ok()?;
    if !matches!(url.scheme(),"http"|"https") || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() { return None; }
    Some(url.into())
}
// 仅解析大小有界的 textures 文本，不下载远端贴图，也不添加新依赖。
fn base64(raw: &str) -> Result<Vec<u8>> {
    if raw.len()>256*1024 || raw.is_empty() || raw.len()%4!=0 { return Err("贴图编码无效".into()); }
    let bytes = raw.as_bytes(); let mut out = Vec::with_capacity(raw.len()/4*3);
    let digit = |b| -> Result<u32> { match b { b'A'..=b'Z'=>Ok((b-b'A') as u32), b'a'..=b'z'=>Ok((b-b'a'+26) as u32), b'0'..=b'9'=>Ok((b-b'0'+52) as u32), b'+'=>Ok(62), b'/'=>Ok(63), _=>Err("贴图编码无效".into()) } };
    for (index,part) in bytes.chunks_exact(4).enumerate() {
        let last = index+1==bytes.len()/4; let a=digit(part[0])?;let b=digit(part[1])?;
        let c=if part[2]==b'=' {0} else {digit(part[2])?};let d=if part[3]==b'=' {0} else {digit(part[3])?};
        if (part[2]==b'=' && (part[3]!=b'=' || b&15!=0)) || (part[3]==b'=' && part[2]!=b'=' && c&3!=0) || (!last && (part[2]==b'=' || part[3]==b'=')) { return Err("贴图编码无效".into()); }
        let word=(a<<18)|(b<<12)|(c<<6)|d;out.push((word>>16) as u8);
        if part[2]!=b'=' {out.push((word>>8) as u8);}if part[3]!=b'=' {out.push(word as u8);}
    }
    Ok(out)
}
fn textures(profile: &Value,expected: &str) -> Value {
    let mut output=json!({});
    if uuid(text(profile,"id")).ok().as_deref()!=Some(expected) { return output; }
    let raw=profile.get("properties").and_then(Value::as_array).and_then(|p|p.iter().find(|p|text(p,"name")=="textures")).map(|p|text(p,"value")).unwrap_or("");
    let decoded=match base64(raw).ok().and_then(|b|serde_json::from_slice::<Value>(&b).ok()) {Some(value)=>value,None=>return output};
    if let Some(id)=decoded.get("profileId") {
        if id.as_str().and_then(|s|uuid(s).ok()).as_deref()!=Some(expected) {return output;}
    }
    if let Some(url)=decoded.pointer("/textures/SKIN/url").and_then(Value::as_str).and_then(texture_url) {
        output["skinUrl"]=json!(url);
        output["skinModel"]=json!(if decoded.pointer("/textures/SKIN/metadata/model").and_then(Value::as_str)==Some("slim") {"slim"} else {"classic"});
    }
    if let Some(url)=decoded.pointer("/textures/CAPE/url").and_then(Value::as_str).and_then(texture_url) {output["capeUrl"]=json!(url);}
    output
}
fn ygg_profiles(data: &Value) -> Result<Vec<Value>> {
    let mut candidates=data.get("availableProfiles").and_then(Value::as_array).cloned().unwrap_or_default();
    if candidates.is_empty() {if let Some(profile)=data.get("selectedProfile").filter(|p|p.is_object()) {candidates.push(profile.clone());}}
    if candidates.is_empty() || candidates.len()>500 {return Err("该账号没有可用角色或角色数量过多".into());}
    let mut ids=HashSet::new();let mut profiles=Vec::new();
    for profile in candidates {
        let id=uuid(text(&profile,"id"))?;name(text(&profile,"name"))?;
        if ids.insert(id.clone()) {
            let mut clean=json!({"id":id,"name":name(text(&profile,"name"))?});
            let raw=profile.get("properties").and_then(Value::as_array).and_then(|p|p.iter().find(|p|text(p,"name")=="textures")).map(|p|text(p,"value")).unwrap_or("");
            if !raw.is_empty() && raw.len()<=256*1024 {clean["properties"]=json!([{"name":"textures","value":raw}]);}
            profiles.push(clean);
        }
    }
    Ok(profiles)
}
fn profile_options(profiles: &[Value]) -> Vec<Value> {
    profiles.iter().map(|profile| {
        let mut option=json!({"id":profile["id"],"name":profile["name"]});
        let texture=textures(profile,text(profile,"id"));
        for key in ["skinUrl","skinModel"] {if let Some(value)=texture.get(key) {option[key]=value.clone();}}
        option
    }).collect()
}
async fn site_name(client:&Client,cancel:&Cancellation,base:&str)->Option<String> {
    let data=success(request(client,cancel,base,Body::None,None,5).await.ok()?,"站点元数据获取失败").ok()?;
    let value=data.pointer("/meta/serverName")?.as_str()?.trim();
    if value.is_empty() || value.chars().any(char::is_control) || value.encode_utf16().count()>128 {None} else {Some(value.into())}
}
async fn skin(client:&Client,cancel:&Cancellation,base:&str,id:&str)->Option<Value> {
    let data=success(request(client,cancel,&format!("{base}/sessionserver/session/minecraft/profile/{id}"),Body::None,None,5).await.ok()?,"角色贴图获取失败").ok()?;
    let value=textures(&data,id);
    if value.get("skinUrl").is_some() || value.get("capeUrl").is_some() {Some(value)} else {None}
}
async fn ygg_account(client:&Client,cancel:&Cancellation,profile:&Value,data:&Value,base:&str,fallback_client:&str,site:Option<&str>,old:Option<&Value>)->Result<Value> {
    let id=uuid(text(profile,"id"))?;
    let access=if text(data,"accessToken").is_empty() {old.map(|a|text(a,"accessToken")).unwrap_or("")} else {text(data,"accessToken")};
    let client_token=if text(data,"clientToken").is_empty() {fallback_client} else {text(data,"clientToken")};
    let mut account=json!({"id":id,"name":name(text(profile,"name"))?,"accessToken":token(access)?,"clientToken":token(client_token)?,"refreshToken":"","expiresAt":now_ms()+23*3600*1000,"addedAt":old.and_then(|a|a["addedAt"].as_u64()).unwrap_or_else(now_ms),"offline":false,"authType":"yggdrasil","yggdrasilServer":base});
    if let Some(site)=site {account["siteName"]=json!(site);}
    for key in ["skinUrl","capeUrl","skinModel"] {if let Some(value)=old.and_then(|a|a.get(key)) {account[key]=value.clone();}}
    if let Some(fields)=textures(profile,&id).as_object() {for (key,value) in fields {account[key]=value.clone();}}
    if account.get("skinUrl").is_none() {
        if let Some(value)=skin(client,cancel,base,&id).await {for (key,value) in value.as_object().unwrap() {account[key]=value.clone();}}
    }
    cancel.check()?;Ok(account)
}
fn validate_ygg_batch(accounts:&[Value])->Result<()> {
    if accounts.is_empty() || accounts.len()>500 {return Err("角色提交数量无效".into());}
    let mut ids=HashSet::new();
    for account in accounts {
        if !ids.insert(uuid(text(account,"id"))?) {return Err("提交的角色 UUID 重复".into());}
        name(text(account,"name"))?;token(text(account,"accessToken"))?;token(text(account,"clientToken"))?;
        ygg_base(text(account,"yggdrasilServer"))?;
        if text(account,"authType")!="yggdrasil" || account.get("offline").and_then(Value::as_bool)!=Some(false) || text(account,"refreshToken")!="" {
            return Err("第三方角色账号类型无效".into());
        }
        for key in ["addedAt","expiresAt"] {
            if account.get(key).and_then(Value::as_u64).filter(|value|*value<=9_007_199_254_740_991).is_none() {return Err("角色有效期或创建时间无效".into());}
        }
        if let Some(model)=account.get("skinModel") {if !matches!(model.as_str(),Some("slim"|"classic")){return Err("角色皮肤模型无效".into());}}
    }Ok(())
}
fn ygg_commit_batch(profiles:&[Value],accounts:Vec<Value>)->Result<Vec<Value>> {
    validate_ygg_batch(&accounts)?;
    if profiles.len()!=accounts.len() {return Err("角色提交不完整".into());}
    for (profile,account) in profiles.iter().zip(&accounts) {
        if uuid(text(profile,"id"))?!=text(account,"id") || name(text(profile,"name"))?!=text(account,"name") {
            return Err("提交的角色与本次选择不匹配".into());
        }
        if ["accessToken","clientToken","yggdrasilServer"].iter().any(|key|account.get(*key)!=accounts[0].get(*key)) {
            return Err("角色不属于同一次登录".into());
        }
    }Ok(accounts)
}
fn ygg_refresh_batch(old:&Value,updated:Value,siblings:Vec<Value>)->Result<Vec<Value>> {
    if uuid(text(old,"id"))?!=uuid(text(&updated,"id"))? {return Err("刷新角色 UUID 与原账号不匹配".into());}
    let mut accounts=vec![updated.clone()];
    for mut sibling in siblings {
        if text(&sibling,"id")==text(old,"id") {continue;}
        if text(&sibling,"authType")=="yggdrasil" && sibling.get("yggdrasilServer")==old.get("yggdrasilServer")
            && sibling.get("clientToken")==old.get("clientToken") && sibling.get("accessToken")==old.get("accessToken") {
            for key in ["accessToken","clientToken","expiresAt"] {sibling[key]=updated[key].clone();}
            accounts.push(sibling);
        }
    }
    validate_ygg_batch(&accounts)?;Ok(accounts)
}
async fn login_ygg(app:&tauri::AppHandle,shared:Arc<Shared>,server:&str,email:&str,password:&str)->Result<Value> {
    let base=ygg_base(server)?;
    if email.trim().is_empty() || email.len()>4096 || email.chars().any(char::is_control) || password.is_empty() || password.len()>32768 || password.contains('\0') {return Err("第三方账号或密码格式无效".into());}
    let ticket=replace_ticket(&shared,Kind::Yggdrasil)?;
    let result=async {
        let client=client()?;let client_token=Uuid::new_v4().simple().to_string();
        // password 仅在本次 authenticate 请求体中使用，不写入待选上下文或任何存档。
        let data=success(request(&client,&ticket.cancel,&format!("{base}/authserver/authenticate"),Body::Json(json!({"agent":{"name":"Minecraft","version":1},"username":email.trim(),"password":password,"clientToken":client_token,"requestUser":true})),None,10).await?,"第三方登录失败，请检查账号与密码")?;
        token(text(&data,"accessToken"))?;let profiles=ygg_profiles(&data)?;
        let site=site_name(&client,&ticket.cancel,&base).await;ticket.cancel.check()?;
        if profiles.len()>1 {
            let options=profile_options(&profiles);
            if !trusted_main(app) {return Err("认证操作已取消".into());}
            let mut sessions=shared.sessions.lock().map_err(|_|"认证状态不可用")?;
            if shared.check_open().is_err() || !active(&sessions,Kind::Yggdrasil,&ticket) {return Err("认证操作已取消".into());}
            // 只保留认证令牌与已校验角色，不保留服务端可能回显的密码/邮箱等任意字段。
            let context=json!({"accessToken":token(text(&data,"accessToken"))?,"clientToken":token(if text(&data,"clientToken").is_empty(){&client_token}else{text(&data,"clientToken")})?,"availableProfiles":profiles});
            sessions.pending=Some(PendingYgg {ticket:ticket.clone(),expires_at:now_ms()+YGG_TTL_MS,base,data:context,client_token,site});
            let expiry_shared=shared.clone();let expiry_ticket=ticket.clone();
            tauri::async_runtime::spawn(async move {
                if wait(&expiry_ticket.cancel,YGG_TTL_MS/1000).await.is_ok() {
                    if let Ok(mut sessions)=expiry_shared.sessions.lock() {
                        if sessions.yggdrasil.as_ref().map(|p|p.id)==Some(expiry_ticket.id) {
                            expiry_ticket.cancel.cancel();sessions.pending=None;sessions.yggdrasil=None;
                        }
                    }
                }
            });
            return Ok(json!({"profiles":options}));
        }
        let account=ygg_account(&client,&ticket.cancel,&profiles[0],&data,&base,&client_token,site.as_deref(),None).await?;
        let batch=ygg_commit_batch(&profiles,vec![account])?;
        let accounts=save_guarded(app,shared.clone(),Kind::Yggdrasil,ticket.clone(),batch,true).await?;
        Ok(json!({"account":accounts[0]}))
    }.await;
    let keep=shared.sessions.lock().map(|s|s.pending.as_ref().map(|p|p.ticket.id)==Some(ticket.id)).unwrap_or(false);
    if !keep {finish(&shared,Kind::Yggdrasil,&ticket);}result
}
fn take_pending(sessions:&mut Sessions,now:u64)->Result<PendingYgg> {
    let context=sessions.pending.take().ok_or("登录会话已失效，请重新登录")?;
    if context.expires_at<=now || !active(sessions,Kind::Yggdrasil,&context.ticket) {
        context.ticket.cancel.cancel();
        if sessions.yggdrasil.as_ref().map(|t|t.id)==Some(context.ticket.id){sessions.yggdrasil=None;}
        return Err("登录会话已失效，请重新登录".into());
    }Ok(context)
}
async fn commit_ygg(app:&tauri::AppHandle,shared:Arc<Shared>,ids:&Value)->Result<Value> {
    let ids=ids.as_array().filter(|v|v.len()<=500).ok_or("角色选择参数无效")?;
    let mut wanted=HashSet::new();for value in ids {wanted.insert(uuid(value.as_str().ok_or("角色选择参数无效")?)?);}
    if wanted.is_empty() {
        let shared=shared.clone();
        tauri::async_runtime::spawn_blocking(move||->Result<()> {
            let mut sessions=shared.sessions.lock().map_err(|_|"认证状态不可用")?;
            if let Some(ticket)=sessions.yggdrasil.take(){ticket.cancel.cancel();}sessions.pending=None;Ok(())
        }).await.map_err(|_|"取消角色选择任务异常")??;
        return Ok(json!([]));
    }
    let context={
        let mut sessions=shared.sessions.lock().map_err(|_|"认证状态不可用")?;
        shared.check_open()?;take_pending(&mut sessions,now_ms())?
    };
    let result=async {
        let profiles=ygg_profiles(&context.data)?;
        if wanted.iter().any(|id|!profiles.iter().any(|p|text(p,"id")==id)) {return Err("所选角色不属于本次登录会话".into());}
        let selected:Vec<Value>=profiles.into_iter().filter(|p|wanted.contains(text(p,"id"))).collect();
        let client=client()?;let mut accounts=Vec::with_capacity(selected.len());
        for profile in &selected {
            accounts.push(ygg_account(&client,&context.ticket.cancel,profile,&context.data,&context.base,&context.client_token,context.site.as_deref(),None).await?);
        }
        // 最后一个角色也构造并校验成功后，才允许整批交给 Storage 的单次事务。
        let batch=ygg_commit_batch(&selected,accounts)?;
        Ok(json!(save_guarded(app,shared.clone(),Kind::Yggdrasil,context.ticket.clone(),batch,true).await?))
    }.await;
    finish(&shared,Kind::Yggdrasil,&context.ticket);result
}

// 导入专用验证没有 AppHandle、Storage 或事件；只返回 Rust 内部候选，交调用者单独提交。
// 私有端点仅支持模块内回环夹具，生产调用始终使用固定微软服务地址。
#[derive(Clone, Copy)]
struct ImportEndpoints<'a> { live: &'a str, consumers: &'a str, chain: [&'a str; 4] }
impl ImportEndpoints<'static> {
    fn production() -> Self { Self { live: TOKEN, consumers: CONSUMERS, chain: [XBL,XSTS,MC_LOGIN,MC_PROFILE] } }
}
fn import_time(account: &Value, field: &str) -> Result<u64> {
    account.get(field).and_then(Value::as_u64).filter(|v| *v <= 9_007_199_254_740_991)
        .ok_or_else(|| "导入账号时间字段无效".into())
}
fn import_offline(account: &Value) -> Result<Value> {
    let id=uuid(text(account,"id"))?;let player=name(text(account,"name"))?;
    let mut bytes=md5::compute(format!("OfflinePlayer:{player}").as_bytes()).0;
    bytes[6]=(bytes[6]&0x0f)|0x30;bytes[8]=(bytes[8]&0x3f)|0x80;
    if id!=Uuid::from_bytes(bytes).simple().to_string() || account.get("offline").and_then(Value::as_bool)!=Some(true)
        || text(account,"accessToken")!="0" || !text(account,"refreshToken").is_empty() || !text(account,"clientToken").is_empty()
        || account.get("microsoftAuth").is_some() {
        return Err("离线导入账号 UUID 或凭据与名称不匹配".into());
    }
    Ok(json!({"id":id,"name":player,"authType":"offline","offline":true,"accessToken":"0","refreshToken":"","clientToken":"",
        "expiresAt":import_time(account,"expiresAt")?,"addedAt":import_time(account,"addedAt")?}))
}
async fn import_microsoft(client: &Client, cancel: &Cancellation, account: &Value, endpoints: ImportEndpoints<'_>) -> Result<Value> {
    let id=uuid(text(account,"id"))?;let added=import_time(account,"addedAt")?;
    let expires=import_time(account,"expiresAt")?;
    if account.get("offline").and_then(Value::as_bool)!=Some(false) {return Err("导入账号认证类型无效".into());}
    if expires<=now_ms().saturating_add(60_000) {
        let auth=MicrosoftAuth::from_import(account)?;
        let refresh=token(text(account,"refreshToken")).map_err(|_| "该导入账号需要重新登录微软账号")?;
        let url=if auth.endpoint=="consumers" {endpoints.consumers} else {endpoints.live};
        let reply=request(client,cancel,url,Body::Form(vec![("client_id".into(),auth.client.clone()),("scope".into(),auth.scope.clone()),
            ("grant_type".into(),"refresh_token".into()),("refresh_token".into(),refresh.clone())]),None,10).await?;
        let data=success(reply,"导入微软账号刷新失败，请重新登录")?;
        let rotated=match data.get("refresh_token") {None=>refresh,Some(value)=>token(value.as_str().unwrap_or(""))?};
        // 刷新可能已经轮换来源令牌；后续失败或取消不代表能撤销该远端变化。
        microsoft_chain_at(client,cancel,&auth,token(text(&data,"access_token"))?,rotated,Some(added),Some(&id),endpoints.chain).await
    } else {
        let access=token(text(account,"accessToken"))?;
        let data=success(request(client,cancel,endpoints.chain[3],Body::None,Some(&access),10).await?,"导入微软账号档案验证失败")?;
        if uuid(text(&data,"id"))?!=id {return Err("导入微软账号角色 UUID 不匹配".into());}
        // 没有可信来源的有效访问令牌只能临时使用，绝不补成本地授权来源。
        let auth=MicrosoftAuth::from_import(account).ok();
        let refresh=if auth.is_some() && !text(account,"refreshToken").is_empty() {token(text(account,"refreshToken"))?} else {String::new()};
        let mut output=json!({"id":id,"name":name(text(&data,"name"))?,"authType":"microsoft","offline":false,
            "accessToken":access,"refreshToken":refresh,"expiresAt":expires,"addedAt":added});
        if let Some(auth)=auth {output["microsoftAuth"]=auth.value();}
        for (field,list) in [("skinUrl","skins"),("capeUrl","capes")] {
            if let Some(item)=data.get(list).and_then(Value::as_array).and_then(|items|items.iter().find(|item|text(item,"state")=="ACTIVE")) {
                if let Some(url)=texture_url(text(item,"url")) {output[field]=json!(url);}
                if list=="skins" {output["skinModel"]=json!(if text(item,"variant").eq_ignore_ascii_case("slim") {"slim"} else {"classic"});}
            }
        }
        Ok(output)
    }
}
#[derive(Clone, PartialEq, Eq, Hash)]
struct ImportYggKey { base: String, access: String, client: String }
fn import_ygg_key(account: &Value) -> Result<ImportYggKey> {
    uuid(text(account,"id"))?;import_time(account,"addedAt")?;import_time(account,"expiresAt")?;
    if account.get("offline").and_then(Value::as_bool)!=Some(false) {return Err("导入账号认证类型无效".into());}
    Ok(ImportYggKey {base:ygg_base(text(account,"yggdrasilServer"))?,access:token(text(account,"accessToken"))?,client:token(text(account,"clientToken"))?})
}
fn import_ygg_profiles(data: &Value) -> Result<HashMap<String,Value>> {
    let mut raw=Vec::new();
    if let Some(selected)=data.get("selectedProfile").filter(|v|!v.is_null()) {raw.push(selected);}
    if let Some(available)=data.get("availableProfiles").filter(|v|!v.is_null()) {
        let available=available.as_array().filter(|items|items.len()<=500).ok_or("导入角色列表无效或数量过多")?;
        raw.extend(available.iter());
    }
    if raw.is_empty() || raw.len()>501 {return Err("来源服务器没有返回可验证角色".into());}
    let mut profiles=HashMap::new();
    for profile in raw {
        let id=uuid(text(profile,"id"))?;let player=name(text(profile,"name"))?;
        if let Some(previous)=profiles.get(&id) {
            if text(previous,"name")!=player {return Err("来源服务器返回了冲突的角色身份".into());}
            continue;
        }
        let mut clean=json!({"id":id,"name":player});
        let fields=textures(profile,text(&clean,"id"));
        for field in ["skinUrl","capeUrl","skinModel"] {if let Some(value)=fields.get(field) {clean[field]=value.clone();}}
        profiles.insert(id,clean);
    }
    Ok(profiles)
}
struct ImportYggReply { profiles: HashMap<String,Value>, access: String, client: String, expires: u64 }
async fn import_ygg_refresh(client: &Client, cancel: &Cancellation, key: &ImportYggKey) -> Result<ImportYggReply> {
    let data=success(request(client,cancel,&format!("{}/authserver/refresh",key.base),Body::Json(json!({"accessToken":key.access,
        "clientToken":key.client,"requestUser":true})),None,10).await?,"导入第三方账号刷新失败，请重新登录")?;
    // accessToken 必须来自本次响应；不能用旧访问令牌伪造刷新成功。
    let access=token(text(&data,"accessToken"))?;
    let rotated=match data.get("clientToken") {None=>key.client.clone(),Some(value)=>token(value.as_str().unwrap_or(""))?};
    Ok(ImportYggReply {profiles:import_ygg_profiles(&data)?,access,client:rotated,expires:now_ms()+23*3600*1000})
}
fn import_ygg_account(old: &Value, key: &ImportYggKey, reply: &ImportYggReply) -> Result<Value> {
    let id=uuid(text(old,"id"))?;let profile=reply.profiles.get(&id).ok_or("来源服务器未返回该角色，导入身份未通过验证")?;
    let mut output=json!({"id":id,"name":profile["name"],"authType":"yggdrasil","offline":false,"accessToken":reply.access,
        "clientToken":reply.client,"refreshToken":"","expiresAt":reply.expires,"addedAt":import_time(old,"addedAt")?,"yggdrasilServer":key.base});
    let site=text(old,"siteName");
    if !site.is_empty() && site.encode_utf16().count()<=128 && !site.chars().any(char::is_control) {output["siteName"]=json!(site);}
    for field in ["skinUrl","capeUrl"] {
        if let Some(url)=texture_url(text(old,field)) {output[field]=json!(url);}
    }
    if matches!(text(old,"skinModel"),"slim"|"classic") {output["skinModel"]=old["skinModel"].clone();}
    for field in ["skinUrl","capeUrl","skinModel"] {if let Some(value)=profile.get(field) {output[field]=value.clone();}}
    Ok(output)
}
enum ImportWork { Single(usize), Ygg(ImportYggKey,Vec<usize>) }
async fn verify_import_at(accounts: Vec<Value>, cancel: &crate::downloads::Cancel, endpoints: ImportEndpoints<'_>) -> Result<Vec<Result<Value>>> {
    cancel.check().map_err(|_| "账号导入已取消")?;
    if accounts.len()>500 {return Err("一次最多验证五百个导入账号".into());}
    if accounts.is_empty() {return Ok(Vec::new());}
    let mut results:Vec<Result<Value>>=vec![Err("导入账号格式或认证类型无效".into());accounts.len()];
    let mut groups:HashMap<ImportYggKey,usize>=HashMap::new();let mut work=Vec::new();
    for (index,account) in accounts.iter().enumerate() {
        if text(account,"authType")=="yggdrasil" {
            match import_ygg_key(account) {
                Ok(key)=>{
                    if let Some(position)=groups.get(&key).copied() {
                        if let ImportWork::Ygg(_,indices)=&mut work[position] {indices.push(index);}
                    } else {
                        groups.insert(key.clone(),work.len());work.push(ImportWork::Ygg(key,vec![index]));
                    }
                },
                Err(error)=>results[index]=Err(error),
            }
        } else {work.push(ImportWork::Single(index));}
    }
    let network=client()?;let internal=Cancellation::default();
    // 全部工作只有可丢弃的 reqwest future，无 spawn/存档；取消先返回整体错误并丢弃在途请求。
    let verifying=async {
        for item in work {
            cancel.check().map_err(|_| "账号导入已取消")?;
            match item {
                ImportWork::Single(index)=>{
                    results[index]=match text(&accounts[index],"authType") {
                        "offline"=>import_offline(&accounts[index]),
                        "microsoft"=>import_microsoft(&network,&internal,&accounts[index],endpoints).await,
                        _=>Err("导入账号认证类型无效".into()),
                    };
                },
                ImportWork::Ygg(key,indices)=>{
                    match import_ygg_refresh(&network,&internal,&key).await {
                        Ok(reply)=>for index in indices {results[index]=import_ygg_account(&accounts[index],&key,&reply);},
                        Err(error)=>for index in indices {results[index]=Err(error.clone());},
                    }
                },
            }
        }
        cancel.check().map_err(|_| "账号导入已取消")?;Ok(results)
    };
    tokio::select! {biased; _=cancel.cancelled()=>Err("账号导入已取消".into()), result=verifying=>result}
}
/// 仅供账户导入模块：输入与输出严格同序，逐项失败不暴露远端正文；取消为整体错误。
/// 不落盘、不发事件；微软刷新或 Yggdrasil 令牌轮换已经发生时，取消不能回滚来源服务。
pub(crate) async fn verify_import_candidates(accounts: Vec<Value>, cancel: Arc<crate::downloads::Cancel>) -> Result<Vec<Result<Value>>> {
    verify_import_at(accounts,&cancel,ImportEndpoints::production()).await
}

// 启动准备只消费固定 UUID。原始返回值不得进入 IPC、事件或日志。
fn launch_check(shared:&Shared,ticket:&Ticket,cancel:&crate::downloads::Cancel)->Result<()> {
    shared.check_open()?;ticket.cancel.check()?;
    cancel.check().map_err(|_|"启动认证已取消".into())
}
async fn launch_cancellable<T>(shared:&Shared,ticket:&Ticket,cancel:&crate::downloads::Cancel,future:impl Future<Output=Result<T>>)->Result<T> {
    launch_check(shared,ticket,cancel)?;
    tokio::select! {biased;
        _=shared.closed()=>Err("认证窗口已关闭".into()),
        _=cancel.cancelled()=>Err("启动认证已取消".into()),
        _=ticket.cancel.cancelled()=>Err("认证操作已取消".into()),
        result=future=>{launch_check(shared,ticket,cancel)?;result},
    }
}
fn launch_needs_refresh(account:&Value)->Result<bool> {
    match text(account,"authType") {
        "offline" if account["offline"]==true=>{import_offline(account).map_err(|_|"离线账号信息无效，请重新添加")?;Ok(false)},
        "microsoft"|"yggdrasil" if account["offline"]==false=>{
            let expires=import_time(account,"expiresAt").map_err(|_|"账号有效期无效，请重新登录")?;
            // 有效期尚长但访问令牌缺失，也必须经过一次真实刷新。
            Ok(expires<=now_ms().saturating_add(60_000) || token(text(account,"accessToken")).is_err())
        },
        _=>Err("账号认证类型无效，请重新登录".into()),
    }
}
fn launch_ygg_group(old:&Value,accounts:Vec<Value>)->Result<Vec<Value>> {
    let key=import_ygg_key(old).map_err(|_|"第三方账号凭据或服务器无效，请重新登录")?;
    let mut group=vec![old.clone()];let mut ids=HashSet::from([uuid(text(old,"id"))?]);
    for account in accounts {
        if text(&account,"id")==text(old,"id") || text(&account,"authType")!="yggdrasil" {continue;}
        // 凭据相同且规范服务器相同的全部角色必须一起验证、一起 CAS；不可跳过坏角色。
        if text(&account,"accessToken")!=key.access || text(&account,"clientToken")!=key.client {continue;}
        if ygg_base(text(&account,"yggdrasilServer")).ok().as_deref()!=Some(key.base.as_str()) {continue;}
        if import_ygg_key(&account).map_err(|_|"第三方账号角色组无效，请重新登录")?!=key || !ids.insert(uuid(text(&account,"id"))?) {return Err("第三方账号角色组无效，请重新登录".into());}
        group.push(account);
        if group.len()>500 {return Err("第三方账号角色数量超过上限".into());}
    }
    Ok(group)
}
async fn launch_refresh_at(expected:&[Value],ticket:&Ticket,endpoints:ImportEndpoints<'_>)->Result<Vec<Value>> {
    let old=expected.first().ok_or("启动账号不存在")?;let network=client()?;
    match text(old,"authType") {
        "microsoft"=>{
            if expected.len()!=1 {return Err("微软账号刷新组无效".into());}
            let auth=MicrosoftAuth::from_import(old).map_err(|_|"该账号缺少可信微软授权来源，请重新登录")?;
            let refresh=token(text(old,"refreshToken")).map_err(|_|"该账号缺少有效刷新令牌，请重新登录微软账号")?;
            let id=uuid(text(old,"id"))?;let added=import_time(old,"addedAt").map_err(|_|"账号时间字段无效")?;
            let url=if auth.endpoint=="consumers" {endpoints.consumers} else {endpoints.live};
            let reply=request(&network,&ticket.cancel,url,Body::Form(vec![("client_id".into(),auth.client.clone()),("scope".into(),auth.scope.clone()),
                ("grant_type".into(),"refresh_token".into()),("refresh_token".into(),refresh.clone())]),None,10).await?;
            let data=success(reply,"微软账号刷新失败，请重新登录")?;
            let rotated=match data.get("refresh_token") {None=>refresh,Some(value)=>token(value.as_str().unwrap_or(""))?};
            Ok(vec![microsoft_chain_at(&network,&ticket.cancel,&auth,token(text(&data,"access_token"))?,rotated,Some(added),Some(&id),endpoints.chain).await?])
        },
        "yggdrasil"=>{
            let key=import_ygg_key(old).map_err(|_|"第三方账号凭据或服务器无效，请重新登录")?;
            if expected.is_empty() || expected.len()>500 || expected.iter().any(|account|text(account,"authType")!="yggdrasil" || import_ygg_key(account).ok().as_ref()!=Some(&key)) {
                return Err("第三方账号刷新组无效，请重新登录".into());
            }
            let reply=import_ygg_refresh(&network,&ticket.cancel,&key).await.map_err(|_|"第三方账号刷新失败，请重新登录")?;
            expected.iter().map(|account|import_ygg_account(account,&key,&reply).map_err(|_|"第三方服务器未返回完整角色身份，请重新登录".into())).collect()
        },
        _=>Err("账号认证类型无效，请重新登录".into()),
    }
}
fn launch_ticket_current(shared:&Shared,sessions:&Sessions,id:&str,ticket:&Ticket,generation:u64,cancel:&crate::downloads::Cancel)->Result<()> {
    launch_check(shared,ticket,cancel)?;
    if sessions.generation!=generation || sessions.refresh.get(id).map(|value|value.id)!=Some(ticket.id) {return Err("认证操作已取消".into());}
    Ok(())
}
fn finish_launch_ticket(shared:&Shared,id:&str,ticket:&Ticket) {
    let mut sessions=shared.sessions.lock().unwrap_or_else(|poisoned|poisoned.into_inner());
    if sessions.refresh.get(id).map(|value|value.id)==Some(ticket.id) {sessions.refresh.remove(id);}
    ticket.cancel.cancel();
}
struct LaunchCaller { cancel:Arc<crate::downloads::Cancel>, completed:bool }
impl Drop for LaunchCaller {fn drop(&mut self) {if !self.completed {self.cancel.stop();}}}
async fn launch_account_owned(app:tauri::AppHandle,shared:Arc<Shared>,id:String,cancel:Arc<crate::downloads::Cancel>)->Result<Value> {
    let ticket=Ticket::new();
    // sessions/Storage 可能等待 Android Keystore，整个读取与登记均放在阻塞线程。
    let generation={let shared=shared.clone();let ticket=ticket.clone();let cancel=cancel.clone();
        tauri::async_runtime::spawn_blocking(move||->Result<u64>{let sessions=shared.sessions.lock().map_err(|_|"认证状态不可用")?;
            launch_check(&shared,&ticket,&cancel)?;Ok(sessions.generation)}).await.map_err(|_|"启动认证读取任务异常")??};
    let _gate=launch_cancellable(&shared,&ticket,&cancel,async {Ok(shared.refresh_gate.lock().await)}).await?;
    let loaded={let app=app.clone();let shared=shared.clone();let ticket=ticket.clone();let cancel=cancel.clone();let id=id.clone();
        tauri::async_runtime::spawn_blocking(move||->Result<(Value,Vec<Value>)>{
            if !trusted_main(&app) {return Err("认证操作已取消".into());}
            let mut sessions=shared.sessions.lock().map_err(|_|"认证状态不可用")?;launch_check(&shared,&ticket,&cancel)?;
            if sessions.generation!=generation {return Err("认证操作已取消".into());}
            let storage=app.state::<Storage>();let old=storage.account_for_backend(Some(&id))?.ok_or("该账号不存在或已被移除")?;
            if !launch_needs_refresh(&old)? {return Ok((old,Vec::new()));}
            let expected=if text(&old,"authType")=="yggdrasil" {
                let list=storage.call("accounts:list",&[])?.and_then(|value|value.as_array().cloned()).ok_or("账号列表不可用")?;
                let mut accounts=Vec::new();
                for safe in list {if let Some(account)=storage.account_for_backend(Some(text(&safe,"id")))? {accounts.push(account);}}
                launch_ygg_group(&old,accounts)?
            } else {vec![old.clone()]};
            launch_check(&shared,&ticket,&cancel)?;
            if let Some(previous)=sessions.refresh.insert(id,ticket.clone()) {previous.cancel.cancel();}
            Ok((old,expected))
        }).await.map_err(|_|"启动认证读取任务异常")?};
    let (old,expected)=loaded?;
    if expected.is_empty() {launch_check(&shared,&ticket,&cancel)?;return Ok(old);}
    let result=async {
        let updated=launch_cancellable(&shared,&ticket,&cancel,launch_refresh_at(&expected,&ticket,ImportEndpoints::production())).await?;
        let app=app.clone();let shared=shared.clone();let ticket=ticket.clone();let cancel=cancel.clone();let id=id.clone();
        // 此 await 不参与 select：存档已经派发后，必须等真实 CAS/Keystore 完成才释放 refresh_gate。
        let saved=tauri::async_runtime::spawn_blocking(move||->Result<Value>{
            if !trusted_main(&app) {return Err("认证操作已取消".into());}
            let sessions=shared.sessions.lock().map_err(|_|"认证状态不可用")?;
            launch_ticket_current(&shared,&sessions,&id,&ticket,generation,&cancel)?;
            let saved=app.state::<Storage>().replace_refreshed_accounts_for_backend(expected,updated)?;
            // 提交中取消不能回滚已轮换的远端令牌或已完成的本地存档；禁止继续启动即可。
            launch_check(&shared,&ticket,&cancel)?;
            saved.into_iter().find(|account|text(account,"id")==id).ok_or_else(||"刷新结果缺少启动账号".into())
        }).await.map_err(|_|"启动认证存档任务异常")?;
        saved
    }.await;
    let cleanup={let shared=shared.clone();let ticket=ticket.clone();let id=id.clone();
        tauri::async_runtime::spawn_blocking(move||finish_launch_ticket(&shared,&id,&ticket)).await};
    cleanup.map_err(|_|"启动认证清理任务异常")?;result
}
async fn launch_owned<T:Send+'static>(cancel:Arc<crate::downloads::Cancel>,future:impl Future<Output=Result<T>>+Send+'static)->Result<T> {
    let mut caller=LaunchCaller {cancel,completed:false};
    let worker=tauri::async_runtime::spawn(future);
    let result=worker.await.map_err(|_|"启动认证任务异常")?;caller.completed=true;result
}
/// 仅供 runtime 的后台启动准备；固定 UUID 重读、严格刷新、整组 CAS，不返回任何公开 DTO/事件。
/// 调用方丢弃 future 只发取消；独立拥有者仍等待已派发的阻塞存档和票据清理真正结束。
pub(crate) async fn account_for_launch(app:&tauri::AppHandle,account_id:&str,cancel:Arc<crate::downloads::Cancel>)->Result<Value> {
    let id=uuid(account_id)?;let shared=shared(app);shared.check_open()?;
    launch_owned(cancel.clone(),launch_account_owned(app.clone(),shared,id,cancel)).await
}

async fn load_account(app:&tauri::AppHandle,id:String)->Result<Value> {
    let app=app.clone();tauri::async_runtime::spawn_blocking(move||->Result<Value>{app.state::<Storage>().account_for_backend(Some(&id))?.ok_or_else(||"该账号不存在或已被移除".into())}).await.map_err(|_|"账号读取任务异常")?
}
async fn refresh(app:&tauri::AppHandle,shared:Arc<Shared>,raw:&Value)->Result<Value> {
    // 前端账号仅提供 UUID；拒绝前端注入的令牌、服务器、clientId 或授权来源。
    let id=uuid(text(raw,"id"))?;
    let generation=shared.sessions.lock().map_err(|_|"认证状态不可用")?.generation;
    let before=load_account(app,id.clone()).await?;
    let _gate=shared.refresh_gate.lock().await;
    let old=load_account(app,id.clone()).await?;
    if old["offline"]==true || text(&old,"authType")=="offline" {return Ok(public_account(&old));}
    if old.get("accessToken")!=before.get("accessToken") || old.get("refreshToken")!=before.get("refreshToken") {return Ok(public_account(&old));}
    let ticket=Ticket::new();
    if !trusted_main(app){return Err("认证操作已取消".into());}
    {
        let mut sessions=shared.sessions.lock().map_err(|_|"认证状态不可用")?;
        shared.check_open()?;
        if sessions.generation!=generation {return Err("认证操作已取消".into());}
        sessions.refresh.insert(id.clone(),ticket.clone());
    }
    let result=async {
        let client=client()?;
        let updated=if text(&old,"authType")=="yggdrasil" {
            let base=ygg_base(text(&old,"yggdrasilServer"))?;
            let client_token=if text(&old,"clientToken").trim().is_empty(){id.as_str()}else{text(&old,"clientToken")};
            let data=success(request(&client,&ticket.cancel,&format!("{base}/authserver/refresh"),Body::Json(json!({"accessToken":token(text(&old,"accessToken"))?,"clientToken":token(client_token)?,"requestUser":true})),None,10).await?,"第三方账号凭据已失效，请重新登录")?;
            let profile=data.get("selectedProfile").into_iter().chain(data.get("availableProfiles").and_then(Value::as_array).into_iter().flatten()).find(|p|uuid(text(p,"id")).ok().as_deref()==Some(id.as_str())).cloned().unwrap_or_else(||json!({"id":id,"name":old["name"]}));
            let site=if !text(&old,"siteName").is_empty(){Some(text(&old,"siteName").to_owned())}else{site_name(&client,&ticket.cancel,&base).await};
            ygg_account(&client,&ticket.cancel,&profile,&data,&base,client_token,site.as_deref(),Some(&old)).await?
        } else {
            let auth=MicrosoftAuth::from_account(&old)?;
            let refresh_token=token(text(&old,"refreshToken")).map_err(|_|"该账号缺少有效刷新令牌，请重新登录微软账号")?;
            let reply=request(&client,&ticket.cancel,auth.token_url(),Body::Form(vec![("client_id".into(),auth.client.clone()),("scope".into(),auth.scope.clone()),("grant_type".into(),"refresh_token".into()),("refresh_token".into(),refresh_token.clone())]),None,10).await?;
            if !(200..300).contains(&reply.status) {return Err(format!("微软刷新失败（HTTP {}），请重新登录",reply.status));}
            let rotated=if text(&reply.data,"refresh_token").is_empty(){refresh_token}else{token(text(&reply.data,"refresh_token"))?};
            microsoft_chain(&client,&ticket.cancel,&auth,token(text(&reply.data,"access_token"))?,rotated,old["addedAt"].as_u64(),Some(&id)).await?
        };
        save_refresh(app,shared.clone(),ticket.clone(),old.clone(),updated).await
    }.await;
    if let Ok(mut sessions)=shared.sessions.lock() {if sessions.refresh.get(&id).map(|t|t.id)==Some(ticket.id){sessions.refresh.remove(&id);}}
    result
}
async fn save_refresh(app:&tauri::AppHandle,shared:Arc<Shared>,ticket:Ticket,old:Value,updated:Value)->Result<Value> {
    let app=app.clone();tauri::async_runtime::spawn_blocking(move|| {
        if !trusted_main(&app){return Err("认证操作已取消".into());}
        let sessions=shared.sessions.lock().map_err(|_|"认证状态不可用")?;shared.check_open()?;
        let id=text(&old,"id");ticket.cancel.check()?;
        if sessions.refresh.get(id).map(|t|t.id)!=Some(ticket.id){return Err("认证操作已取消".into());}
        let storage=app.state::<Storage>();let current=storage.account_for_backend(Some(id))?.ok_or("该账号已被移除，未写入刷新结果")?;
        if current.get("accessToken")!=old.get("accessToken") || current.get("refreshToken")!=old.get("refreshToken") || current.get("clientToken")!=old.get("clientToken") || current.get("microsoftAuth")!=old.get("microsoftAuth") {return Err("账号凭据已变化，请重试刷新".into());}
        // 同一 Yggdrasil 登录下多角色共用令牌：完整收集后单事务轮换，角色名称/贴图保持各自的值。
        if text(&old,"authType")=="yggdrasil" {
            let list=storage.call("accounts:list",&[])?.and_then(|v|v.as_array().cloned()).ok_or("账号列表不可用")?;
            let mut siblings=Vec::new();
            for safe in list {
                let other_id=text(&safe,"id");if other_id==id {continue;}
                if let Some(sibling)=storage.account_for_backend(Some(other_id))? {siblings.push(sibling);}
            }
            let batch=ygg_refresh_batch(&old,updated.clone(),siblings)?;
            storage.save_accounts_for_backend(batch)?;
        } else {
            storage.save_account(updated.clone())?;
        }
        Ok(public_account(&updated))
    }).await.map_err(|_|"账号刷新存档任务异常")?
}
async fn refresh_sites(app:&tauri::AppHandle,shared:Arc<Shared>)->Result<Value> {
    let ticket=Ticket::new();let operation=format!("sites:{}",ticket.id);
    {let mut sessions=shared.sessions.lock().map_err(|_|"认证状态不可用")?;shared.check_open()?;
        sessions.refresh.insert(operation.clone(),ticket.clone());}
    let result=async {
        let list={let app=app.clone();tauri::async_runtime::spawn_blocking(move||->Result<Value>{app.state::<Storage>().call("accounts:list",&[])?.ok_or_else(||"账号列表不可用".into())}).await.map_err(|_|"账号读取任务异常")??};
        let client=client()?;
        for safe in list.as_array().ok_or("账号列表无效")? {
            if text(safe,"authType")!="yggdrasil" || !text(safe,"siteName").is_empty(){continue;}
            let base=match ygg_base(text(safe,"yggdrasilServer")){Ok(base)=>base,Err(_)=>continue};
            if let Some(site)=site_name(&client,&ticket.cancel,&base).await {
                let app=app.clone();let shared=shared.clone();let ticket=ticket.clone();let operation=operation.clone();let id=uuid(text(safe,"id"))?;let server=text(safe,"yggdrasilServer").to_owned();
                tauri::async_runtime::spawn_blocking(move||->Result<()> {
                    if !trusted_main(&app){return Err("认证操作已取消".into());}
                    let sessions=shared.sessions.lock().map_err(|_|"认证状态不可用")?;shared.check_open()?;ticket.cancel.check()?;
                    if sessions.refresh.get(&operation).map(|t|t.id)!=Some(ticket.id){return Err("认证操作已取消".into());}
                    let storage=app.state::<Storage>();
                    if let Some(mut current)=storage.account_for_backend(Some(&id))? {
                        if text(&current,"authType")=="yggdrasil" && text(&current,"yggdrasilServer")==server && text(&current,"siteName").is_empty(){current["siteName"]=json!(site);storage.save_account(current)?;}
                    }Ok(())
                }).await.map_err(|_|"站点信息存档任务异常")??;
            }
            ticket.cancel.check()?;
        }
        let app=app.clone();tauri::async_runtime::spawn_blocking(move||->Result<Value>{app.state::<Storage>().call("accounts:list",&[])?.ok_or_else(||"账号列表不可用".into())}).await.map_err(|_|"账号读取任务异常")?
    }.await;
    if let Ok(mut sessions)=shared.sessions.lock(){sessions.refresh.remove(&operation);}result
}

/// 必须在通用 storage.call 之前分派；与认证提交共用锁，防止账号删除后被迟到刷新复活。
/// 无须入口 manage 自定义 State：本模块首次调用自动安装 AuthState。
pub async fn storage_account_call(app:&tauri::AppHandle,channel:&str,args:&[Value])->Result<Option<Value>> {
    if channel!="accounts:remove" {return Ok(None);}
    arg_count(args,1)?;let id=uuid(arg(args,0)?)?;
    if !trusted_main(app){return Err("主窗口不可用或来源不可信".into());}
    let shared=shared(app);let app=app.clone();
    tauri::async_runtime::spawn_blocking(move|| {
        let mut sessions=shared.sessions.lock().map_err(|_|"认证状态不可用")?;
        // 删除属于用户的终止意图；使排队中的刷新和待选角色一并失效。
        cancel_sessions(&mut sessions);
        // 锁顺序为认证会话 → 导入提交门 → Storage；后台等已进入的导入存档真正收尾。
        crate::account_import::with_account_removal(&app, || {
            app.state::<Storage>().call("accounts:remove",&[json!(id)])
        })
    }).await.map_err(|_|"账号删除任务异常")?
}

/// 原通道契约，非认证域返回 None。同步 Storage 操作一律转到阻塞线程。
pub async fn call(app:&tauri::AppHandle,channel:&str,args:&[Value],_storage:&Storage)->Result<Option<Value>> {
    if !matches!(channel,"auth:begin"|"auth:cancel"|"auth:refresh"|"accounts:addYggdrasil"|"accounts:addYggdrasilProfiles"|"accounts:refreshSiteNames"|"yggdrasil:skin") {return Ok(None);}
    if !trusted_main(app){return Err("主窗口不可用或来源不可信".into());}
    let shared=shared(app);shared.check_open()?;
    let value=match channel {
        "auth:begin"=>{arg_count(args,0)?;begin(app,shared).await?},
        "auth:cancel"=>{
            arg_count(args,0)?;let shared=shared.clone();
            tauri::async_runtime::spawn_blocking(move||->Result<()> {let mut sessions=shared.sessions.lock().map_err(|_|"认证状态不可用")?;if let Some(ticket)=sessions.microsoft.take(){ticket.cancel.cancel();}Ok(())}).await.map_err(|_|"取消认证任务异常")??;Value::Null
        },
        "auth:refresh"=>{arg_count(args,1)?;refresh(app,shared,&args[0]).await?},
        "accounts:addYggdrasil"=>{arg_count(args,3)?;login_ygg(app,shared,arg(args,0)?,arg(args,1)?,arg(args,2)?).await?},
        "accounts:addYggdrasilProfiles"=>{arg_count(args,1)?;commit_ygg(app,shared,&args[0]).await?},
        "accounts:refreshSiteNames"=>{arg_count(args,0)?;refresh_sites(app,shared).await?},
        "yggdrasil:skin"=>{arg_count(args,2)?;let base=ygg_base(arg(args,0)?)?;let id=uuid(arg(args,1)?)?;skin(&client()?,&Cancellation::default(),&base,&id).await.unwrap_or(Value::Null)},
        _=>unreachable!(),
    };Ok(Some(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read,Write};
    use std::net::{TcpListener,TcpStream};
    use std::thread::{self,JoinHandle};
    use std::time::Instant;
    const ID:&str="0123456789abcdef0123456789abcdef";
    #[test]
    fn relaunch_checks_are_read_only_and_reject_every_active_auth_state() {
        let shared=Arc::new(Shared::default());assert!(relaunch_ready_shared(&shared).is_ok());
        let microsoft=replace_ticket(&shared,Kind::Microsoft).unwrap();
        assert!(relaunch_ready_shared(&shared).is_err());assert!(microsoft.cancel.check().is_ok());
        cancel_shared(&shared);assert!(relaunch_ready_shared(&shared).is_ok());
        let ygg=replace_ticket(&shared,Kind::Yggdrasil).unwrap();
        assert!(relaunch_ready_shared(&shared).is_err());finish(&shared,Kind::Yggdrasil,&ygg);
        {
            let mut sessions=shared.sessions.lock().unwrap();
            sessions.pending=Some(PendingYgg{ticket:Ticket::new(),expires_at:0,base:String::new(),data:Value::Null,client_token:String::new(),site:None});
            assert!(relaunch_ready_shared(&shared).is_err());
        }
        // 即使待选角色已过期，观察函数也不能替调用方清理或默认为空闲。
        assert!(relaunch_ready_shared(&shared).is_err());assert!(shared.sessions.lock().unwrap().pending.is_some());
        cancel_shared(&shared);
        shared.sessions.lock().unwrap().refresh.insert("fixture".into(),Ticket::new());
        assert!(relaunch_ready_shared(&shared).is_err());cancel_shared(&shared);
        let gate=shared.refresh_gate.try_lock().unwrap();assert!(relaunch_ready_shared(&shared).is_err());drop(gate);
        let sessions=shared.sessions.lock().unwrap();assert!(relaunch_ready_shared(&shared).is_err());drop(sessions);
        assert!(relaunch_ready_shared(&shared).is_ok());shared.closed.store(true,Ordering::SeqCst);
        assert!(relaunch_ready_shared(&shared).is_err());
        let poisoned=Arc::new(Shared::default());let worker=poisoned.clone();
        assert!(std::thread::spawn(move|| {let _sessions=worker.sessions.lock().unwrap();panic!("夹具认证锁毒化");}).join().is_err());
        assert!(relaunch_ready_shared(&poisoned).is_err());
    }
    #[tokio::test]
    async fn cancelled_ticket_does_not_release_background_until_storage_join_and_final_emit() {
        struct Release(Option<std::sync::mpsc::Sender<()>>);
        impl Drop for Release {fn drop(&mut self){if let Some(sender)=self.0.take(){let _=sender.send(());}}}
        let shared=Arc::new(Shared::default());let ticket=replace_ticket(&shared,Kind::Microsoft).unwrap();
        let background={let _sessions=shared.sessions.lock().unwrap();BackgroundWorker::begin(shared.clone())};
        let (entered,entered_rx)=tokio::sync::oneshot::channel();let (release,release_rx)=std::sync::mpsc::channel();let release=Release(Some(release));
        let (stored,stored_rx)=tokio::sync::oneshot::channel();let (emit,emit_rx)=tokio::sync::oneshot::channel();let owner=shared.clone();
        let worker=spawn_background(background,async move {
            // 模拟真正阻塞存档；退出此工作之前不能把 await 丢弃当作完成。
            tauri::async_runtime::spawn_blocking(move|| {let _=entered.send(());release_rx.recv_timeout(Duration::from_secs(5)).unwrap();}).await.unwrap();
            let _=stored.send(());emit_rx.await.unwrap();
            finish(&owner,Kind::Microsoft,&ticket);
        });
        tokio::time::timeout(Duration::from_secs(2),entered_rx).await.unwrap().unwrap();
        cancel_shared(&shared);assert!(shared.sessions.lock().unwrap().microsoft.is_none());
        let before_join=relaunch_ready_shared(&shared).is_err();drop(release);
        tokio::time::timeout(Duration::from_secs(2),stored_rx).await.unwrap().unwrap();
        let before_emit=relaunch_ready_shared(&shared).is_err();emit.send(()).unwrap();worker.await.unwrap();
        assert!(before_join && before_emit);assert!(relaunch_ready_shared(&shared).is_ok());
        assert_eq!(shared.background_workers.load(Ordering::SeqCst),0);
        assert!(!shared.background_unknown.load(Ordering::SeqCst));
    }
    #[tokio::test]
    async fn abnormal_background_drop_and_panic_keep_relaunch_sticky() {
        let shared=Arc::new(Shared::default());drop(BackgroundWorker::begin(shared.clone()));
        cancel_shared(&shared);assert!(relaunch_ready_shared(&shared).is_err());
        assert_eq!(shared.background_workers.load(Ordering::SeqCst),1);assert!(shared.background_unknown.load(Ordering::SeqCst));
        let shared=Arc::new(Shared::default());
        let worker=spawn_background(BackgroundWorker::begin(shared.clone()),async {panic!("夹具后台认证异常");});
        assert!(worker.await.is_err());cancel_shared(&shared);
        assert!(relaunch_ready_shared(&shared).is_err());assert_eq!(shared.background_workers.load(Ordering::SeqCst),1);
        assert!(shared.background_unknown.load(Ordering::SeqCst));
    }
    struct Fixture {
        address:String, stop:Arc<AtomicBool>, requests:Arc<Mutex<Vec<String>>>, worker:Option<JoinHandle<()>>,
    }
    impl Fixture {
        fn new(responses:Vec<(u16,Value,Vec<(String,String)>)>)->Self {
            let listener=TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();
            let address=format!("http://{}",listener.local_addr().unwrap());let stop=Arc::new(AtomicBool::new(false));let requests=Arc::new(Mutex::new(Vec::new()));
            let worker_stop=stop.clone();let seen=requests.clone();
            let worker=thread::spawn(move|| {
                for (status,body,headers) in responses {
                    let deadline=Instant::now()+Duration::from_secs(5);
                    let mut stream=loop {
                        if worker_stop.load(Ordering::SeqCst) || Instant::now()>=deadline {return;}
                        match listener.accept(){Ok((stream,_))=>break stream,Err(error) if error.kind()==std::io::ErrorKind::WouldBlock=>thread::sleep(Duration::from_millis(5)),Err(_)=>return}
                    };
                    // 监听端是 nonblocking；显式恢复已接受连接的阻塞读取，不依赖平台继承行为。
                    stream.set_nonblocking(false).unwrap();
                    stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();stream.set_write_timeout(Some(Duration::from_secs(2))).unwrap();
                    let raw=read_request(&mut stream).expect("认证回环夹具未收到完整请求，禁止发送伪成功响应");
                    seen.lock().unwrap().push(raw);
                    let bytes=body.to_string();let mut response=format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n",bytes.len());
                    for (key,value) in headers {response.push_str(&format!("{key}: {value}\r\n"));}response.push_str("\r\n");response.push_str(&bytes);let _=stream.write_all(response.as_bytes());
                }
            });Self {address,stop,requests,worker:Some(worker)}
        }
        fn url(&self,path:&str)->String {format!("{}{path}",self.address)}
    }
    impl Drop for Fixture {fn drop(&mut self){self.stop.store(true,Ordering::SeqCst);if let Some(worker)=self.worker.take(){let _=worker.join();}}}
    fn read_request(stream:&mut TcpStream)->Option<String> {
        let mut bytes=Vec::new();let mut chunk=[0u8;4096];
        loop {
            let count=stream.read(&mut chunk).ok()?;if count==0{return None;}bytes.extend_from_slice(&chunk[..count]);if bytes.len()>1024*1024{return None;}
            if let Some(end)=bytes.windows(4).position(|w|w==b"\r\n\r\n") {
                let head=String::from_utf8_lossy(&bytes[..end]);let length=head.lines().find_map(|line|line.split_once(':').filter(|(key,_)|key.eq_ignore_ascii_case("Content-Length")).and_then(|(_,v)|v.trim().parse::<usize>().ok())).unwrap_or(0);
                if bytes.len()>=end+4+length{return String::from_utf8(bytes).ok();}
            }
        }
    }
    fn encode(bytes:&[u8])->String {
        let alphabet=b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";let mut out=String::new();
        for part in bytes.chunks(3){let a=part[0] as u32;let b=part.get(1).copied().unwrap_or(0) as u32;let c=part.get(2).copied().unwrap_or(0) as u32;let word=(a<<16)|(b<<8)|c;
            out.push(alphabet[((word>>18)&63) as usize] as char);out.push(alphabet[((word>>12)&63) as usize] as char);out.push(if part.len()>1{alphabet[((word>>6)&63) as usize] as char}else{'='});out.push(if part.len()>2{alphabet[(word&63) as usize] as char}else{'='});}out
    }
    fn textured(id:&str,texture_id:&str)->Value {
        json!({"id":id,"name":"Player","properties":[{"name":"textures","value":encode(json!({"profileId":texture_id,"textures":{"SKIN":{"url":"https://textures.example/skin","metadata":{"model":"slim"}},"CAPE":{"url":"https://textures.example/cape"}}}).to_string().as_bytes())}]})
    }
    fn import_urls(fixture: &Fixture) -> [String;6] {
        [fixture.url("/live"),fixture.url("/consumers"),fixture.url("/xbl"),fixture.url("/xsts"),fixture.url("/mc"),fixture.url("/profile")]
    }
    fn import_endpoints(urls: &[String;6]) -> ImportEndpoints<'_> {
        ImportEndpoints {live:&urls[0],consumers:&urls[1],chain:[&urls[2],&urls[3],&urls[4],&urls[5]]}
    }
    fn microsoft_candidate(id: &str, expires: u64) -> Value {
        json!({"id":id,"name":"OldName","authType":"microsoft","offline":false,"accessToken":"FAKE_OLD_MC",
            "refreshToken":"FAKE_OLD_REFRESH","expiresAt":expires,"addedAt":42})
    }
    fn import_ygg_candidate(id: &str, server: &str) -> Value {
        let mut account=batch_account(id,"OldRole");account["yggdrasilServer"]=json!(server);account
    }
    #[test]
    fn launch_refresh_policy_validates_offline_and_access_expiry() {
        let offline=json!({"id":"b50ad385829d3141a2167e7d7539ba7f","name":"Notch","authType":"offline","offline":true,
            "accessToken":"0","refreshToken":"","clientToken":"","addedAt":42,"expiresAt":0});
        assert!(!launch_needs_refresh(&offline).unwrap());
        let mut bad=offline;bad["id"]=json!(ID);assert!(launch_needs_refresh(&bad).is_err());
        let mut online=microsoft_candidate(ID,now_ms()+3600_000);assert!(!launch_needs_refresh(&online).unwrap());
        online["expiresAt"]=json!(now_ms()+30_000);assert!(launch_needs_refresh(&online).unwrap());
        online["expiresAt"]=json!(now_ms()+3600_000);online["accessToken"]=json!("");assert!(launch_needs_refresh(&online).unwrap());
        online["authType"]=json!("unknown");assert!(launch_needs_refresh(&online).is_err());
    }
    #[test]
    fn launch_ygg_group_normalizes_server_and_keeps_exact_session_only() {
        let second="1123456789abcdef0123456789abcdef";
        let old=import_ygg_candidate(ID,"https://AUTH.example/api/");let same=import_ygg_candidate(second,"https://auth.example/api");
        let mut other_access=same.clone();other_access["accessToken"]=json!("FAKE_OTHER");
        let mut other_client=same.clone();other_client["clientToken"]=json!("FAKE_OTHER");
        let other_server=import_ygg_candidate(second,"https://other.example/api");
        let group=launch_ygg_group(&old,vec![old.clone(),same.clone(),other_access,other_client,other_server]).unwrap();
        assert_eq!(group,vec![old.clone(),same.clone()]);
        let mut malformed=same;malformed["addedAt"]=Value::Null;
        assert!(launch_ygg_group(&old,vec![malformed]).is_err());
    }
    #[tokio::test]
    async fn launch_ygg_refresh_requires_all_actual_roles_and_rotates_once() {
        let second="1123456789abcdef0123456789abcdef";
        let fixture=Fixture::new(vec![(200,json!({"accessToken":"FAKE_ROTATED","clientToken":"FAKE_ROTATED_CLIENT",
            "selectedProfile":{"id":ID,"name":"First"},"availableProfiles":[{"id":second,"name":"Second"}]}),vec![])]);
        let urls=import_urls(&fixture);let expected=vec![import_ygg_candidate(second,&fixture.address),import_ygg_candidate(ID,&fixture.address)];
        let output=launch_refresh_at(&expected,&Ticket::new(),import_endpoints(&urls)).await.unwrap();
        assert_eq!(output.len(),2);assert_eq!(output[0]["id"],second);assert_eq!(output[1]["id"],ID);
        for account in output {assert_eq!(account["accessToken"],"FAKE_ROTATED");assert_eq!(account["clientToken"],"FAKE_ROTATED_CLIENT");assert_eq!(account["addedAt"],42);}
        assert_eq!(fixture.requests.lock().unwrap().len(),1);
        let missing=Fixture::new(vec![(200,json!({"accessToken":"FAKE_ROTATED","selectedProfile":{"id":ID,"name":"First"}}),vec![])]);
        let urls=import_urls(&missing);let expected=vec![import_ygg_candidate(ID,&missing.address),import_ygg_candidate(second,&missing.address)];
        let error=launch_refresh_at(&expected,&Ticket::new(),import_endpoints(&urls)).await.unwrap_err();
        assert!(!error.contains("导入"));assert!(!error.contains("FAKE_"));assert_eq!(missing.requests.lock().unwrap().len(),1);
    }
    #[tokio::test]
    async fn launch_microsoft_requires_source_and_uses_source_full_chain() {
        let fixture=Fixture::new(vec![]);let urls=import_urls(&fixture);let old=microsoft_candidate(ID,0);
        assert!(launch_refresh_at(&[old.clone()],&Ticket::new(),import_endpoints(&urls)).await.unwrap_err().contains("可信微软授权来源"));
        assert!(fixture.requests.lock().unwrap().is_empty());
        for (endpoint,scope,prefix) in [("live",SCOPE,"t"),("consumers","XboxLive.signin offline_access","d")] {
            let fixture=Fixture::new(vec![(200,json!({"access_token":"FAKE_MS","refresh_token":"FAKE_ROTATED"}),vec![]),
                (200,json!({"Token":"FAKE_XBL","DisplayClaims":{"xui":[{"uhs":"FAKE_UHS"}]}}),vec![]),
                (200,json!({"Token":"FAKE_XSTS","DisplayClaims":{"xui":[{"uhs":"FAKE_UHS"}]}}),vec![]),
                (200,json!({"access_token":"FAKE_MC","expires_in":3600}),vec![]),
                (200,json!({"id":ID,"name":"Fresh"}),vec![])]);
            let urls=import_urls(&fixture);let mut old=old.clone();old["microsoftAuth"]=json!({"clientId":"1234567890abcdef","scope":scope,"endpoint":endpoint});
            let account=launch_refresh_at(&[old],&Ticket::new(),import_endpoints(&urls)).await.unwrap().remove(0);
            assert_eq!(account["id"],ID);assert_eq!(account["refreshToken"],"FAKE_ROTATED");assert_eq!(account["microsoftAuth"]["endpoint"],endpoint);
            let requests=fixture.requests.lock().unwrap();assert_eq!(requests.len(),5);
            assert!(requests[0].starts_with(&format!("POST /{endpoint} ")));assert!(requests[0].contains("1234567890abcdef"));
            assert!(requests[1].contains(&format!("{prefix}=FAKE_MS")));
        }
    }
    #[tokio::test]
    async fn launch_cancel_interrupts_gate_wait_and_close_without_sessions_lock() {
        let shared=Arc::new(Shared::default());let ticket=Ticket::new();let cancel=Arc::new(crate::downloads::Cancel::default());
        let _gate=shared.refresh_gate.lock().await;
        let waiting={let shared=shared.clone();let ticket=ticket.clone();let cancel=cancel.clone();tokio::spawn(async move {
            launch_cancellable(&shared,&ticket,&cancel,async {Ok(shared.refresh_gate.lock().await)}).await.map(|_|())
        })};
        cancel.stop();assert!(tokio::time::timeout(Duration::from_secs(1),waiting).await.unwrap().unwrap().is_err());
        let sessions=shared.sessions.lock().unwrap();
        // 实际窗口入口在存档仍持 sessions 时也必须立即发布 closed。
        cancel_window_shared(shared.clone());
        assert!(shared.check_open().is_err());
        assert!(launch_cancellable(&shared,&ticket,&crate::downloads::Cancel::default(),async {Ok(())}).await.is_err());drop(sessions);
        assert!(replace_ticket(&shared,Kind::Microsoft).is_err());
    }
    #[tokio::test]
    async fn launch_caller_drop_keeps_gate_until_dispatched_blocking_work_really_joins() {
        let shared=Arc::new(Shared::default());let cancel=Arc::new(crate::downloads::Cancel::default());
        let (entered_tx,entered_rx)=tokio::sync::oneshot::channel();let (release_tx,release_rx)=std::sync::mpsc::channel();
        let owner=shared.clone();let task_cancel=cancel.clone();
        let caller=tokio::spawn(async move {launch_owned(task_cancel,async move {
            let _gate=owner.refresh_gate.lock().await;
            tauri::async_runtime::spawn_blocking(move|| {entered_tx.send(()).unwrap();release_rx.recv().unwrap();}).await.map_err(|_|"夹具存档线程异常")?;
            Ok(())
        }).await});
        tokio::time::timeout(Duration::from_secs(2),entered_rx).await.unwrap().unwrap();caller.abort();assert!(caller.await.unwrap_err().is_cancelled());
        assert!(cancel.check().is_err());assert!(shared.refresh_gate.try_lock().is_err());
        release_tx.send(()).unwrap();
        let _finished=tokio::time::timeout(Duration::from_secs(2),shared.refresh_gate.lock()).await.unwrap();
    }
    #[tokio::test]
    async fn launch_inflight_cancel_drops_http_without_echoing_credentials() {
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();let address=listener.local_addr().unwrap();
        let (seen_tx,seen_rx)=tokio::sync::oneshot::channel();
        let server=thread::spawn(move|| {
            let deadline=Instant::now()+Duration::from_secs(4);
            let mut stream=loop {assert!(Instant::now()<deadline,"启动刷新未发起回环请求");
                match listener.accept(){Ok((stream,_))=>break stream,Err(error) if error.kind()==std::io::ErrorKind::WouldBlock=>thread::sleep(Duration::from_millis(5)),Err(error)=>panic!("回环监听失败: {error}")}
            };
            stream.set_nonblocking(false).unwrap();stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            assert!(read_request(&mut stream).unwrap().starts_with("POST /authserver/refresh "));seen_tx.send(()).unwrap();
            let mut byte=[0u8;1];match stream.read(&mut byte){Ok(0)=>true,Err(error)=>matches!(error.kind(),std::io::ErrorKind::ConnectionReset|std::io::ErrorKind::ConnectionAborted),_=>false}
        });
        let shared=Arc::new(Shared::default());let cancel=Arc::new(crate::downloads::Cancel::default());let task_cancel=cancel.clone();
        let task=tokio::spawn(async move {
            let urls=[String::new(),String::new(),String::new(),String::new(),String::new(),String::new()];
            let expected=vec![import_ygg_candidate(ID,&format!("http://{address}"))];let ticket=Ticket::new();
            launch_cancellable(&shared,&ticket,&task_cancel,launch_refresh_at(&expected,&ticket,import_endpoints(&urls))).await
        });
        tokio::time::timeout(Duration::from_secs(3),seen_rx).await.unwrap().unwrap();cancel.stop();
        let error=tokio::time::timeout(Duration::from_secs(1),task).await.unwrap().unwrap().unwrap_err();assert!(!error.contains("FAKE_"));
        assert!(server.join().unwrap(),"取消必须关闭在途连接，超时不是取消证据");
    }
    #[test]
    fn launch_ticket_generation_and_caller_drop_cancel_without_removing_new_ticket() {
        let shared=Shared::default();let ticket=Ticket::new();let cancel=Arc::new(crate::downloads::Cancel::default());
        let mut sessions=shared.sessions.lock().unwrap();sessions.refresh.insert(ID.into(),ticket.clone());let generation=sessions.generation;
        assert!(launch_ticket_current(&shared,&sessions,ID,&ticket,generation,&cancel).is_ok());
        sessions.generation+=1;assert!(launch_ticket_current(&shared,&sessions,ID,&ticket,generation,&cancel).is_err());
        let replacement=Ticket::new();sessions.refresh.insert(ID.into(),replacement.clone());drop(sessions);
        finish_launch_ticket(&shared,ID,&ticket);assert_eq!(shared.sessions.lock().unwrap().refresh.get(ID).unwrap().id,replacement.id);
        let caller=LaunchCaller {cancel:cancel.clone(),completed:false};drop(caller);assert!(cancel.check().is_err());
    }
    #[tokio::test]
    async fn import_ygg_group_rotates_once_matches_each_role_and_preserves_input_order() {
        let second="1123456789abcdef0123456789abcdef";let missing="2123456789abcdef0123456789abcdef";
        let fixture=Fixture::new(vec![(200,json!({"accessToken":"FAKE_ROTATED_ACCESS","clientToken":"FAKE_ROTATED_CLIENT",
            "selectedProfile":{"id":ID,"name":"First"},"availableProfiles":[{"id":second,"name":"Second"}]}),vec![]),
            (200,json!({"id":ID,"name":"MicrosoftPlayer"}),vec![])]);
        let urls=import_urls(&fixture);let cancel=crate::downloads::Cancel::default();
        let first=import_ygg_candidate(second,&format!("{}/auth/",fixture.address));
        let mut same=import_ygg_candidate(ID,&format!("{}/auth",fixture.address));same["password"]=json!("FAKE_PASSWORD");
        let absent=import_ygg_candidate(missing,&format!("{}/auth",fixture.address));
        let output=verify_import_at(vec![first,microsoft_candidate(ID,now_ms()+3600_000),same,absent],&cancel,import_endpoints(&urls)).await.unwrap();
        assert_eq!(output.len(),4);
        for (index,id,player) in [(0,second,"Second"),(2,ID,"First")] {
            let account=output[index].as_ref().unwrap();assert_eq!(account["id"],id);assert_eq!(account["name"],player);
            assert_eq!(account["accessToken"],"FAKE_ROTATED_ACCESS");assert_eq!(account["clientToken"],"FAKE_ROTATED_CLIENT");
            assert_eq!(account["addedAt"],42);assert!(account.get("password").is_none());
        }
        assert_eq!(output[1].as_ref().unwrap()["name"],"MicrosoftPlayer");assert!(output[3].is_err());
        let requests=fixture.requests.lock().unwrap();assert_eq!(requests.len(),2);
        assert!(requests[0].starts_with("POST /auth/authserver/refresh "));assert!(requests[1].starts_with("GET /profile "));
        assert!(requests[0].contains("FAKE_SHARED_ACCESS"));assert!(!requests[0].contains("FAKE_PASSWORD"));
    }
    #[tokio::test]
    async fn import_ygg_groups_distinct_sessions_without_reusing_rotated_credentials() {
        let second="1123456789abcdef0123456789abcdef";
        let replies=(0..4).map(|i|(200,json!({"accessToken":format!("FAKE_ROTATED_{i}"),"selectedProfile":{"id":ID,"name":"First"},
            "availableProfiles":[{"id":second,"name":"Second"}]}),vec![])).collect();
        let fixture=Fixture::new(replies);let urls=import_urls(&fixture);let base=format!("{}/one",fixture.address);
        let first=import_ygg_candidate(ID,&base);let same=import_ygg_candidate(second,&base);
        let mut client_changed=first.clone();client_changed["clientToken"]=json!("FAKE_DISTINCT_CLIENT");
        let mut access_changed=first.clone();access_changed["accessToken"]=json!("FAKE_DISTINCT_ACCESS");
        let mut server_changed=first.clone();server_changed["yggdrasilServer"]=json!(format!("{}/two",fixture.address));
        let output=verify_import_at(vec![first,client_changed,same,access_changed,server_changed],&crate::downloads::Cancel::default(),import_endpoints(&urls)).await.unwrap();
        for (index,group) in [(0,0),(1,1),(2,0),(3,2),(4,3)] {
            assert_eq!(output[index].as_ref().unwrap()["accessToken"],format!("FAKE_ROTATED_{group}"));
        }
        assert_eq!(output[1].as_ref().unwrap()["clientToken"],"FAKE_DISTINCT_CLIENT");
        let requests=fixture.requests.lock().unwrap();assert_eq!(requests.len(),4);
        assert!(requests[1].contains("FAKE_DISTINCT_CLIENT"));assert!(requests[2].contains("FAKE_DISTINCT_ACCESS"));
        assert!(requests[3].starts_with("POST /two/authserver/refresh "));
        for request in requests.iter() {assert!(!request.contains("FAKE_ROTATED_"));}
    }
    #[tokio::test]
    async fn import_ygg_missing_profiles_access_and_bad_rotations_fail_without_old_identity_fallback() {
        for data in [json!({"accessToken":"FAKE_NEW"}),json!({"selectedProfile":{"id":ID,"name":"First"}}),
            json!({"accessToken":"FAKE_NEW","clientToken":"","selectedProfile":{"id":ID,"name":"First"}}),
            json!({"accessToken":"FAKE_NEW","selectedProfile":{"id":ID,"name":"First"},"availableProfiles":[{"id":ID,"name":"Conflict"}]})] {
            let fixture=Fixture::new(vec![(200,data,vec![])]);let urls=import_urls(&fixture);
            let output=verify_import_at(vec![import_ygg_candidate(ID,&fixture.address)],&crate::downloads::Cancel::default(),import_endpoints(&urls)).await.unwrap();
            assert!(output[0].is_err());assert_eq!(fixture.requests.lock().unwrap().len(),1);
        }
        assert!(import_ygg_profiles(&json!({"availableProfiles":vec![json!({"id":ID,"name":"First"});501]})).is_err());
    }
    #[tokio::test]
    async fn import_valid_microsoft_access_uses_profile_only_and_drops_unknown_source_refresh() {
        let fixture=Fixture::new(vec![(200,json!({"id":ID,"name":"Verified","skins":[{"state":"ACTIVE","variant":"SLIM","url":"https://textures.example/verified"}]}),vec![]),
            (200,json!({"id":ID,"name":"VerifiedAgain"}),vec![])]);
        let urls=import_urls(&fixture);let mut account=microsoft_candidate(ID,now_ms()+3600_000);
        account["microsoftAuth"]=json!({"clientId":"unknown","scope":"secret","endpoint":"evil"});account["password"]=json!("FAKE_PASSWORD");
        let mut known=account.clone();known["microsoftAuth"]=json!({"clientId":CLIENT_ID,"scope":SCOPE,"endpoint":"live"});
        let output=verify_import_at(vec![account,known],&crate::downloads::Cancel::default(),import_endpoints(&urls)).await.unwrap();
        let temporary=output[0].as_ref().unwrap();assert_eq!(temporary["name"],"Verified");assert_eq!(temporary["skinModel"],"slim");
        assert_eq!(temporary["refreshToken"],"");assert!(temporary.get("microsoftAuth").is_none());assert!(temporary.get("password").is_none());
        let refreshable=output[1].as_ref().unwrap();assert_eq!(refreshable["refreshToken"],"FAKE_OLD_REFRESH");assert_eq!(refreshable["microsoftAuth"]["clientId"],CLIENT_ID);
        let requests=fixture.requests.lock().unwrap();assert_eq!(requests.len(),2);
        for request in requests.iter() {assert!(request.starts_with("GET /profile "));assert!(request.to_ascii_lowercase().contains("authorization: bearer fake_old_mc"));assert!(!request.contains("FAKE_OLD_REFRESH"));}
    }
    #[tokio::test]
    async fn import_expiring_microsoft_requires_source_and_does_not_guess_local_client() {
        let fixture=Fixture::new(vec![]);let urls=import_urls(&fixture);let mut candidates=Vec::new();
        candidates.push(microsoft_candidate(ID,now_ms()+60_000));
        for source in [Value::Null,json!({"clientId":"not-a-client","scope":SCOPE,"endpoint":"live"}),
            json!({"clientId":CLIENT_ID,"scope":SCOPE,"endpoint":"https://evil.example/token"}),
            json!({"clientId":CLIENT_ID,"scope":"","endpoint":"live"})] {
            let mut account=microsoft_candidate(ID,0);account["microsoftAuth"]=source;candidates.push(account);
        }
        let output=verify_import_at(candidates,&crate::downloads::Cancel::default(),import_endpoints(&urls)).await.unwrap();
        assert!(output.iter().all(Result::is_err));assert!(fixture.requests.lock().unwrap().is_empty());
        assert!(MicrosoftAuth::from_import(&json!({})).is_err());
    }
    #[tokio::test]
    async fn import_microsoft_refresh_preserves_source_endpoint_scope_prefix_and_new_tokens() {
        for (endpoint,scope,prefix) in [("live",SCOPE,"t"),("consumers","XboxLive.signin offline_access","d")] {
            let fixture=Fixture::new(vec![(200,json!({"access_token":"FAKE_SOURCE_ACCESS","refresh_token":"FAKE_SOURCE_ROTATED"}),vec![]),
                (200,json!({"Token":"FAKE_XBL","DisplayClaims":{"xui":[{"uhs":"12345"}]}}),vec![]),
                (200,json!({"Token":"FAKE_XSTS"}),vec![]),(200,json!({"access_token":"FAKE_MC_ROTATED","expires_in":3600}),vec![]),
                (200,json!({"id":ID,"name":"VerifiedSourcePlayer"}),vec![])]);
            let urls=import_urls(&fixture);let mut account=microsoft_candidate(ID,0);
            let source=json!({"clientId":"12345678-1234-1234-1234-123456789abc","scope":scope,"endpoint":endpoint});account["microsoftAuth"]=source.clone();
            let output=verify_import_at(vec![account],&crate::downloads::Cancel::default(),import_endpoints(&urls)).await.unwrap();let account=output[0].as_ref().unwrap();
            assert_eq!(account["id"],ID);assert_eq!(account["name"],"VerifiedSourcePlayer");assert_eq!(account["microsoftAuth"],source);
            assert_eq!(account["refreshToken"],"FAKE_SOURCE_ROTATED");assert_eq!(account["accessToken"],"FAKE_MC_ROTATED");assert_eq!(account["addedAt"],42);
            let requests=fixture.requests.lock().unwrap();assert_eq!(requests.len(),5);assert!(requests[0].starts_with(&format!("POST /{endpoint} ")));
            assert!(requests[0].contains("client_id=12345678-1234-1234-1234-123456789abc"));assert!(!requests[0].contains(CLIENT_ID));
            assert!(requests[0].contains(&format!("scope={}",scope.replace(':',"%3A").replace(' ',"+"))));
            assert!(requests[1].contains(&format!("{prefix}=FAKE_SOURCE_ACCESS")));assert!(requests[3].contains("XBL3.0 x=12345;FAKE_XSTS"));
            assert!(requests[4].to_ascii_lowercase().contains("authorization: bearer fake_mc_rotated"));
        }
    }
    #[tokio::test]
    async fn import_microsoft_checks_exact_uuid_on_both_fresh_and_refreshed_tokens() {
        let other="ffffffffffffffffffffffffffffffff";
        let fixture=Fixture::new(vec![(200,json!({"id":other,"name":"WrongPlayer"}),vec![]),
            (200,json!({"access_token":"FAKE_SOURCE_ACCESS"}),vec![]),(200,json!({"Token":"FAKE_XBL","DisplayClaims":{"xui":[{"uhs":"12345"}]}}),vec![]),
            (200,json!({"Token":"FAKE_XSTS"}),vec![]),(200,json!({"access_token":"FAKE_MC_ROTATED","expires_in":3600}),vec![]),
            (200,json!({"id":other,"name":"WrongPlayer"}),vec![])]);
        let urls=import_urls(&fixture);let mut expiring=microsoft_candidate(ID,0);expiring["microsoftAuth"]=MicrosoftAuth::local().value();
        let output=verify_import_at(vec![microsoft_candidate(ID,now_ms()+3600_000),expiring],&crate::downloads::Cancel::default(),import_endpoints(&urls)).await.unwrap();
        assert!(output.iter().all(Result::is_err));assert_eq!(fixture.requests.lock().unwrap().len(),6);
    }
    #[tokio::test]
    async fn import_failures_are_item_local_and_never_echo_remote_secrets() {
        let fixture=Fixture::new(vec![(401,json!({"error":"invalid_grant","error_description":"FAKE_REMOTE_SECRET","accessToken":"FAKE_RESPONSE_ACCESS"}),vec![]),
            (200,json!({"id":ID,"name":"GoodPlayer"}),vec![])]);
        let urls=import_urls(&fixture);
        let output=verify_import_at(vec![import_ygg_candidate(ID,&fixture.address),json!({"authType":"evil","password":"FAKE_PASSWORD"}),
            microsoft_candidate(ID,now_ms()+3600_000)],&crate::downloads::Cancel::default(),import_endpoints(&urls)).await.unwrap();
        assert_eq!(output.len(),3);assert!(output[0].is_err());assert!(output[1].is_err());assert_eq!(output[2].as_ref().unwrap()["name"],"GoodPlayer");
        for error in output.iter().filter_map(|item|item.as_ref().err()) {
            for secret in ["FAKE_REMOTE_SECRET","FAKE_RESPONSE_ACCESS","FAKE_PASSWORD","FAKE_SHARED_ACCESS"] {assert!(!error.contains(secret));}
        }
    }
    #[tokio::test]
    async fn import_batch_offline_uuid_limits_and_pre_cancel_are_checked_without_http() {
        let mut offline=json!({"id":"b50ad385829d3141a2167e7d7539ba7f","name":"Notch","authType":"offline","offline":true,
            "accessToken":"0","refreshToken":"","clientToken":"","expiresAt":9_007_199_254_740_991u64,"addedAt":42});
        assert!(import_offline(&offline).is_ok());offline["name"]=json!("ChangedName");assert!(import_offline(&offline).is_err());
        offline["name"]=json!("Notch");offline["refreshToken"]=json!("FAKE_BAD_REFRESH");assert!(import_offline(&offline).is_err());
        let cancel=Arc::new(crate::downloads::Cancel::default());assert!(verify_import_candidates(Vec::new(),cancel.clone()).await.unwrap().is_empty());
        assert!(verify_import_candidates(vec![Value::Null;501],cancel.clone()).await.is_err());
        let fixture=Fixture::new(vec![]);let urls=import_urls(&fixture);cancel.stop();
        assert!(verify_import_at(vec![microsoft_candidate(ID,0)],&cancel,import_endpoints(&urls)).await.is_err());
        assert!(fixture.requests.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn import_inflight_cancel_drops_http_and_returns_whole_error() {
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();let address=listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();let cancel=Arc::new(crate::downloads::Cancel::default());
        let (seen_tx,seen_rx)=tokio::sync::oneshot::channel();
        let worker=thread::spawn(move|| {
            let deadline=Instant::now()+Duration::from_secs(4);
            let mut stream=loop {
                assert!(Instant::now()<deadline,"回环认证未发起请求");
                match listener.accept() {Ok((stream,_))=>break stream,Err(error) if error.kind()==std::io::ErrorKind::WouldBlock=>thread::sleep(Duration::from_millis(5)),Err(error)=>panic!("回环监听失败: {error}")}
            };
            stream.set_nonblocking(false).unwrap();stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            assert!(read_request(&mut stream).unwrap().starts_with("GET /profile "));seen_tx.send(()).unwrap();
            let mut byte=[0u8;1];
            match stream.read(&mut byte) {
                Ok(0)=>true,
                Err(error)=>matches!(error.kind(),std::io::ErrorKind::ConnectionReset|std::io::ErrorKind::ConnectionAborted),
                _=>false,
            }
        });
        let task_cancel=cancel.clone();let task=tokio::spawn(async move {
            let base=format!("http://{address}");let urls=[format!("{base}/live"),format!("{base}/consumers"),format!("{base}/xbl"),format!("{base}/xsts"),format!("{base}/mc"),format!("{base}/profile")];
            verify_import_at(vec![microsoft_candidate(ID,now_ms()+3600_000)],&task_cancel,import_endpoints(&urls)).await
        });
        tokio::time::timeout(Duration::from_secs(3),seen_rx).await.unwrap().unwrap();cancel.stop();
        let output=tokio::time::timeout(Duration::from_secs(1),task).await.unwrap().unwrap();assert!(output.is_err());
        assert!(worker.join().unwrap());
    }
    #[test]
    fn device_contract_hides_secrets_and_checks_uri() {
        let ticket=Ticket::new();let mut data=json!({"device_code":"FAKE_DEVICE_SECRET","user_code":"ABCD-EFGH","expires_in":900,"interval":5,"verification_uri_complete":"https://microsoft.com/link?otc=ABCD-EFGH","message":"FAKE_REMOTE_BODY"});
        let (info,code,expiry,interval)=device_info(&data,&ticket).unwrap();assert_eq!(code,"FAKE_DEVICE_SECRET");assert_eq!((expiry,interval),(900,5));assert_eq!(info["deviceCode"],ticket.id.to_string());assert_eq!(info.as_object().unwrap().len(),6);
        assert!(!info.to_string().contains("FAKE_DEVICE_SECRET"));assert!(!info.to_string().contains("FAKE_REMOTE_BODY"));
        for uri in ["http://microsoft.com/link","https://microsoft.com.evil.test/link","https://user:secret@microsoft.com/link","https://microsoft.com:444/link"]{data["verification_uri_complete"]=json!(uri);assert!(device_info(&data,&ticket).is_err());}
        data.as_object_mut().unwrap().remove("verification_uri_complete");assert!(device_info(&data,&ticket).unwrap().0["verificationUri"].as_str().unwrap().starts_with("https://microsoft.com/link?otc="));
        data["expires_in"]=json!(0);assert!(device_info(&data,&ticket).is_err());
    }
    #[test]
    fn poll_errors_are_bounded_and_sanitized() {
        let reply=|code:&str|Reply{status:400,data:json!({"error":code,"error_description":"FAKE_SECRET"}),cookies:String::new()};
        assert_eq!(poll_error(&reply("authorization_pending"),5).unwrap(),None);assert_eq!(poll_error(&reply("slow_down"),5).unwrap(),Some(10));assert_eq!(poll_error(&reply("slow_down"),120).unwrap(),Some(120));
        for code in ["authorization_declined","access_denied","expired_token","bad_verification_code","invalid_grant"]{assert!(!poll_error(&reply(code),5).unwrap_err().contains("FAKE_SECRET"));}
        assert!(xsts_error(&json!({"XErr":2148916238u64,"Message":"FAKE_SECRET"})).unwrap().contains("儿童"));assert!(xsts_error(&json!({"XErr":0})).is_none());
    }
    #[test]
    fn oauth_source_and_profile_identity_are_preserved() {
        let account=json!({"microsoftAuth":{"clientId":"12345678-1234-1234-1234-123456789abc","scope":"XboxLive.signin offline_access","endpoint":"consumers"}});let auth=MicrosoftAuth::from_account(&account).unwrap();
        assert_eq!(auth.token_url(),CONSUMERS);assert_eq!(auth.prefix(),"d");assert_eq!(auth.value(),account["microsoftAuth"]);
        let profile=json!({"id":ID,"name":"Player","skins":[{"state":"ACTIVE","url":"https://textures.example/skin","variant":"SLIM"}]});
        let result=microsoft_account(&profile,"FAKE_ACCESS".into(),"FAKE_REFRESH".into(),99,Some(42),Some(ID),&auth).unwrap();assert_eq!(result["addedAt"],42);assert_eq!(result["skinModel"],"slim");
        let safe=public_account(&result);for field in ["accessToken","refreshToken","clientToken","microsoftAuth"]{assert!(safe.get(field).is_none());}
        assert!(microsoft_account(&profile,"a".into(),"r".into(),99,None,Some("ffffffffffffffffffffffffffffffff"),&auth).is_err());
        assert!(MicrosoftAuth::from_account(&json!({"microsoftAuth":{"clientId":"unknown"}})).is_err());assert_eq!(MicrosoftAuth::from_account(&json!({})).unwrap().client,CLIENT_ID);
    }
    #[test]
    fn ygg_server_profiles_and_texture_identity() {
        assert_eq!(ygg_base("littleskin.cn").unwrap(),"https://littleskin.cn/api/yggdrasil");assert_eq!(ygg_base("https://host.test/custom/").unwrap(),"https://host.test/custom");assert_eq!(ygg_base("host.test/api/yggdrasil").unwrap(),"https://host.test/api/yggdrasil");
        assert_eq!(ygg_base("host.test:8443/custom").unwrap(),"https://host.test:8443/custom/api/yggdrasil");
        assert_eq!(ygg_base("[::1]:8443/custom").unwrap(),"https://[::1]:8443/custom/api/yggdrasil");
        assert_eq!(ygg_base("http://127.0.0.1:8080/custom/").unwrap(),"http://127.0.0.1:8080/custom");
        for input in ["https://user:password@host.test","https://host.test/?token=x","file:///tmp/auth","https://host.test/#fragment",
            "ftp://host.test/auth","FILE:///tmp/auth","javascript:alert(1)","https:/host.test","//host.test/auth","host.test\\\\auth"] {
            assert!(ygg_base(input).is_err(), "不应接受认证服务器地址：{input}");
        }
        let mut profile=textured(ID,ID);profile["password"]=json!("FAKE_PASSWORD");let profiles=ygg_profiles(&json!({"availableProfiles":[profile, textured(ID,ID)]})).unwrap();assert_eq!(profiles.len(),1);assert!(profiles[0].get("password").is_none());
        let options=profile_options(&profiles);assert_eq!(options[0]["skinModel"],"slim");assert!(options[0].get("properties").is_none());assert_eq!(textures(&textured(ID,"ffffffffffffffffffffffffffffffff"),ID),json!({}));
        assert!(ygg_profiles(&json!({"availableProfiles":[{"id":"bad","name":"Player"}]})).is_err());
    }
    fn batch_account(id:&str,player:&str)->Value {
        json!({"id":id,"name":player,"authType":"yggdrasil","offline":false,
            "accessToken":"FAKE_SHARED_ACCESS","clientToken":"FAKE_SHARED_CLIENT","refreshToken":"",
            "yggdrasilServer":"https://skin.example/api/yggdrasil","siteName":"夹具站点",
            "expiresAt":123456789,"addedAt":42,"skinUrl":format!("https://textures.example/{player}"),"skinModel":"slim"})
    }
    #[test]
    fn multi_role_commit_assembles_one_complete_ordered_batch_and_redacts_output() {
        let second_id="1123456789abcdef0123456789abcdef";
        let profiles=vec![json!({"id":ID,"name":"First"}),json!({"id":second_id,"name":"Second"})];
        let first=batch_account(ID,"First");let second=batch_account(second_id,"Second");
        let batch=ygg_commit_batch(&profiles,vec![first.clone(),second.clone()]).unwrap();
        assert_eq!(batch,vec![first,second]);
        assert_eq!(batch[0]["id"],ID);assert_eq!(batch[1]["id"],second_id);
        let safe:Vec<Value>=batch.iter().map(public_account).collect();
        for account in safe {
            for key in ["accessToken","clientToken","refreshToken","microsoftAuth"] {assert!(account.get(key).is_none());}
            assert_eq!(account["siteName"],"夹具站点");
        }
    }
    #[test]
    fn multi_role_commit_rejects_bad_late_role_incomplete_or_mixed_session_batch() {
        let second_id="1123456789abcdef0123456789abcdef";
        let profiles=vec![json!({"id":ID,"name":"First"}),json!({"id":second_id,"name":"Second"})];
        let first=batch_account(ID,"First");let second=batch_account(second_id,"Second");
        assert!(ygg_commit_batch(&profiles,vec![first.clone()]).is_err());
        for (key,value) in [
            ("accessToken",json!("")),("name",json!("UnselectedName")),("clientToken",json!("FAKE_OTHER_SESSION")),
            ("id",json!(ID)),("skinModel",json!("invalid")),("expiresAt",json!(-1)),
        ] {
            let mut bad=second.clone();bad[key]=value;
            assert!(ygg_commit_batch(&profiles,vec![first.clone(),bad]).is_err());
        }
        assert!(ygg_commit_batch(&[],vec![]).is_err());
        assert_eq!(second["accessToken"],"FAKE_SHARED_ACCESS");
    }
    #[test]
    fn shared_ygg_refresh_assembles_matching_roles_before_one_atomic_save() {
        let second_id="1123456789abcdef0123456789abcdef";
        let old=batch_account(ID,"First");let sibling=batch_account(second_id,"Second");
        let mut updated=old.clone();updated["accessToken"]=json!("FAKE_ROTATED_ACCESS");
        updated["clientToken"]=json!("FAKE_ROTATED_CLIENT");updated["expiresAt"]=json!(987654321);
        let mut other_server=batch_account("2123456789abcdef0123456789abcdef","OtherServer");other_server["yggdrasilServer"]=json!("https://other.example/auth");
        let mut other_client=batch_account("3123456789abcdef0123456789abcdef","OtherClient");other_client["clientToken"]=json!("FAKE_OTHER_CLIENT");
        let mut other_access=batch_account("4123456789abcdef0123456789abcdef","OtherAccess");other_access["accessToken"]=json!("FAKE_OTHER_ACCESS");
        let batch=ygg_refresh_batch(&old,updated.clone(),vec![old.clone(),sibling.clone(),other_server,other_client,other_access]).unwrap();
        assert_eq!(batch.len(),2);assert_eq!(batch[0],updated);
        assert_eq!(batch[1]["id"],second_id);
        for key in ["accessToken","clientToken","expiresAt"] {assert_eq!(batch[1][key],batch[0][key]);}
        for key in ["name","siteName","skinUrl","skinModel","addedAt","yggdrasilServer"] {assert_eq!(batch[1][key],sibling[key]);}
        assert_eq!(sibling["accessToken"],"FAKE_SHARED_ACCESS");
        let mut bad=sibling.clone();bad["name"]=json!("");
        assert!(ygg_refresh_batch(&old,updated,vec![sibling,bad]).is_err());
    }
    #[test]
    fn strict_base64_and_safe_texture_urls() {
        for data in [b"a".as_slice(),b"ab".as_slice(),b"abc".as_slice(),b"abcdef".as_slice()]{assert_eq!(base64(&encode(data)).unwrap(),data);}
        for invalid in ["","A===","AA=A","AB==","AAB=","AAAA====","====","Y Q=="]{assert!(base64(invalid).is_err());}
        assert!(texture_url("javascript:alert(1)").is_none());assert!(texture_url("https://user:password@host.test/skin").is_none());
    }
    #[test]
    fn generation_and_cancellation_invalidate_old_work() {
        let shared=Shared::default();let first=replace_ticket(&shared,Kind::Microsoft).unwrap();let second=replace_ticket(&shared,Kind::Microsoft).unwrap();assert!(first.cancel.check().is_err());
        {let sessions=shared.sessions.lock().unwrap();assert!(!active(&sessions,Kind::Microsoft,&first));assert!(active(&sessions,Kind::Microsoft,&second));}
        finish(&shared,Kind::Microsoft,&first);assert!(shared.sessions.lock().unwrap().microsoft.is_some());
        let ygg=replace_ticket(&shared,Kind::Yggdrasil).unwrap();let generation=shared.sessions.lock().unwrap().generation;cancel_shared(&shared);
        assert!(ygg.cancel.check().is_err());assert!(second.cancel.check().is_err());let sessions=shared.sessions.lock().unwrap();assert_ne!(generation,sessions.generation);assert!(sessions.pending.is_none());
    }
    #[tokio::test]
    async fn window_cancel_returns_under_contention_then_cancels_every_ticket() {
        let shared=Arc::new(Shared::default());
        let microsoft=replace_ticket(&shared,Kind::Microsoft).unwrap();
        let yggdrasil=replace_ticket(&shared,Kind::Yggdrasil).unwrap();
        let refresh=Ticket::new();
        let mut sessions=shared.sessions.lock().unwrap();
        sessions.pending=Some(PendingYgg{ticket:yggdrasil.clone(),expires_at:u64::MAX,base:"https://fixture.invalid/auth".into(),data:json!({}),client_token:"FAKE_CLIENT".into(),site:None});
        sessions.refresh.insert("fixture".into(),refresh.clone());
        let generation=sessions.generation;
        // 同一线程仍持锁；若窗口路径改成 lock()，这里会直接死锁。
        cancel_window_shared(shared.clone());
        assert_eq!(sessions.generation,generation);
        assert!(microsoft.cancel.check().is_ok());
        drop(sessions);
        tokio::time::timeout(Duration::from_secs(2),async {
            loop {
                let completed={let sessions=shared.sessions.lock().unwrap();sessions.generation!=generation};
                if completed {break;}
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
        for ticket in [&microsoft,&yggdrasil,&refresh] {assert!(ticket.cancel.check().is_err());}
        let sessions=shared.sessions.lock().unwrap();
        assert!(sessions.microsoft.is_none() && sessions.yggdrasil.is_none() && sessions.pending.is_none() && sessions.refresh.is_empty());
    }
    #[test]
    fn window_cancel_recovers_poisoned_mutex_and_advances_generation() {
        let shared=Arc::new(Shared::default());
        let ticket=replace_ticket(&shared,Kind::Microsoft).unwrap();
        let other=shared.clone();
        assert!(std::thread::spawn(move|| {let _sessions=other.sessions.lock().unwrap();panic!("fixture poison");}).join().is_err());
        assert!(try_cancel_shared(&shared));
        assert!(ticket.cancel.check().is_err());
        let sessions=match shared.sessions.lock() {Err(poisoned)=>poisoned.into_inner(),Ok(_)=>panic!("fixture must remain poisoned")};
        assert_eq!(sessions.generation,1);assert!(sessions.microsoft.is_none());
    }
    #[test]
    fn pending_roles_are_single_use_expiring_and_cancelled() {
        let shared=Shared::default();let ticket=replace_ticket(&shared,Kind::Yggdrasil).unwrap();
        let context=|ticket:Ticket|PendingYgg{ticket,expires_at:200,base:"https://host.test/auth".into(),data:json!({"accessToken":"FAKE_ACCESS"}),client_token:"FAKE_CLIENT".into(),site:None};
        let mut sessions=shared.sessions.lock().unwrap();sessions.pending=Some(context(ticket.clone()));assert!(take_pending(&mut sessions,199).is_ok());assert!(take_pending(&mut sessions,199).is_err());
        sessions.pending=Some(context(ticket.clone()));assert!(take_pending(&mut sessions,200).is_err());assert!(sessions.yggdrasil.is_none());assert!(ticket.cancel.check().is_err());
    }
    #[tokio::test]
    async fn local_microsoft_chain_and_cookie_fixture() {
        let fixture=Fixture::new(vec![(200,json!({"Token":"FAKE_XBL","DisplayClaims":{"xui":[{"uhs":"12345"}]}}),vec![]),(200,json!({"Token":"FAKE_XSTS"}),vec![]),(200,json!({"access_token":"FAKE_MC","expires_in":3600}),vec![]),(200,json!({"id":ID,"name":"Player"}),vec![])]);
        let urls=[fixture.url("/xbl"),fixture.url("/xsts"),fixture.url("/mc"),fixture.url("/profile")];
        let account=microsoft_chain_at(&client().unwrap(),&Cancellation::default(),&MicrosoftAuth::local(),"FAKE_MS".into(),"FAKE_REFRESH".into(),Some(42),Some(ID),[&urls[0],&urls[1],&urls[2],&urls[3]]).await.unwrap();
        assert_eq!(account["accessToken"],"FAKE_MC");assert_eq!(account["refreshToken"],"FAKE_REFRESH");let requests=fixture.requests.lock().unwrap();assert_eq!(requests.len(),4);assert!(requests[0].contains("t=FAKE_MS"));assert!(requests[2].contains("XBL3.0 x=12345;FAKE_XSTS"));assert!(requests[3].to_ascii_lowercase().contains("authorization: bearer fake_mc"));drop(requests);
        let cookie=Fixture::new(vec![(200,json!({"ok":true}),vec![("Set-Cookie".into(),"one=FAKE_ONE; HttpOnly".into()),("Set-Cookie".into(),"two=FAKE_TWO; Secure".into())])]);
        let reply=request(&client().unwrap(),&Cancellation::default(),&cookie.url("/cookie"),Body::None,None,1).await.unwrap();assert_eq!(reply.cookies,"one=FAKE_ONE; two=FAKE_TWO");
    }
    #[tokio::test]
    async fn local_redirect_body_limit_and_cancel() {
        let target=Fixture::new(vec![]);let fixture=Fixture::new(vec![(307,json!({}),vec![("Location".into(),target.url("/must-not-receive"))])]);
        let reply=request(&client().unwrap(),&Cancellation::default(),&fixture.url("/redirect"),Body::Json(json!({"password":"FAKE_PASSWORD"})),None,1).await.unwrap();assert_eq!(reply.status,307);assert!(target.requests.lock().unwrap().is_empty());
        let large=Fixture::new(vec![(200,json!({"large":"x".repeat(MAX_RESPONSE+1)}),vec![])]);assert!(request(&client().unwrap(),&Cancellation::default(),&large.url("/large"),Body::None,None,2).await.is_err());
        let cancel=Arc::new(Cancellation::default());let other=cancel.clone();let task=tokio::spawn(async move {wait(&other,60).await});tokio::task::yield_now().await;cancel.cancel();assert!(tokio::time::timeout(Duration::from_secs(1),task).await.unwrap().unwrap().is_err());
        let already=Cancellation::default();already.cancel();assert!(cancellable(&already,async{Ok(())}).await.is_err());
    }
    #[tokio::test]
    async fn in_flight_http_cancel_drops_request() {
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();let url=format!("http://{}/stall",listener.local_addr().unwrap());
        let stop=Arc::new(AtomicBool::new(false));let accepted=Arc::new(AtomicBool::new(false));let worker_stop=stop.clone();let worker_accepted=accepted.clone();
        let worker=thread::spawn(move|| {
            let deadline=Instant::now()+Duration::from_secs(3);
            loop {
                if worker_stop.load(Ordering::SeqCst) || Instant::now()>=deadline{return;}
                match listener.accept() {
                    Ok((stream,_))=>{worker_accepted.store(true,Ordering::SeqCst);while !worker_stop.load(Ordering::SeqCst) && Instant::now()<deadline {thread::sleep(Duration::from_millis(5));}drop(stream);return;},
                    Err(error) if error.kind()==std::io::ErrorKind::WouldBlock=>thread::sleep(Duration::from_millis(5)),Err(_)=>return,
                }
            }
        });
        let cancel=Arc::new(Cancellation::default());let other=cancel.clone();let task=tokio::spawn(async move {request(&client().unwrap(),&other,&url,Body::None,None,10).await});
        let deadline=Instant::now()+Duration::from_secs(2);while !accepted.load(Ordering::SeqCst) && Instant::now()<deadline {tokio::time::sleep(Duration::from_millis(5)).await;}
        let saw_request=accepted.load(Ordering::SeqCst);cancel.cancel();let result=tokio::time::timeout(Duration::from_secs(1),task).await;
        stop.store(true,Ordering::SeqCst);worker.join().unwrap();assert!(saw_request);assert!(result.unwrap().unwrap().is_err());
    }
    #[tokio::test]
    async fn local_ygg_skin_and_refresh_preserves_old_fields() {
        let profile=textured(ID,ID);let fixture=Fixture::new(vec![(200,profile,vec![])]);let client=client().unwrap();let cancel=Cancellation::default();let found=skin(&client,&cancel,&fixture.address,ID).await.unwrap();assert_eq!(found["skinModel"],"slim");
        let old=json!({"id":ID,"name":"Player","accessToken":"FAKE_OLD","addedAt":42,"skinUrl":"https://textures.example/old","capeUrl":"https://textures.example/cape","skinModel":"slim"});
        let updated=ygg_account(&client,&cancel,&json!({"id":ID,"name":"Player"}),&json!({}),"https://unused.invalid","FAKE_CLIENT",Some("Site"),Some(&old)).await.unwrap();assert_eq!(updated["accessToken"],"FAKE_OLD");assert_eq!(updated["addedAt"],42);assert_eq!(updated["skinUrl"],old["skinUrl"]);assert_eq!(updated["siteName"],"Site");
    }
}

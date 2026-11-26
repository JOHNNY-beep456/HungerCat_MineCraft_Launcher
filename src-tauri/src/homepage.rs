//! 主页仓库入口。文件操作在串行后台 worker 中，主页脚本只得到受控 SDK 与一次性文档地址。
use serde_json::{json, Value};
use std::{path::PathBuf, sync::{atomic::{AtomicBool, Ordering}, Mutex}};
use tauri::{AppHandle, Manager, WebviewWindow};

pub(super) type Result<T> = std::result::Result<T, String>;
const MAX_LOCAL_SIZE: u64 = 2 * 1024 * 1024;
const MAX_MARKET_SIZE: u64 = 512 * 1024;
#[path = "modpack/access.rs"] mod access;
mod analyzer;
mod native;
mod repository;
mod protocol;
mod remote;
pub(crate) use protocol::{plugin, protocol_response};

fn tr(cn: &str, tw: &str, en: &str) -> String { format!("{cn} / {tw} / {en}") }
fn unavailable() -> String { tr("主页状态不可用", "主頁狀態無法使用", "Homepage state unavailable") }
fn cancelled() -> String { tr("主页操作已取消", "主頁操作已取消", "Homepage operation cancelled") }
fn invalid() -> String { tr("主页参数无效", "主頁參數無效", "Invalid homepage arguments") }
pub(crate) fn valid_id(id: &str) -> bool { repository::valid_id(id) }
#[derive(Default)]
struct State {
    closed: AtomicBool,
    serial: Mutex<()>,
    frames: Mutex<protocol::Frames>,
    guard_ready: AtomicBool,
    /// 正在运行的主页文件句柄：活着期间内容不能被替换（见 `Repository::hold`）。
    held: Mutex<Option<(String, std::fs::File)>>,
}
impl State {
    fn check(&self) -> Result<()> { if self.closed.load(Ordering::Acquire) { Err(cancelled()) } else { Ok(()) } }
    /// 丢弃句柄即解除占用；旧主页卸下、新版发布前都要调它。
    fn release_hold(&self) { if let Ok(mut held) = self.held.lock() { held.take(); } }
}
pub(crate) fn init(app: &AppHandle) { if app.try_state::<State>().is_none() { app.manage(State::default()); } }
pub(crate) fn cancel_for_window(app: &AppHandle) {
    if let Some(state) = app.try_state::<State>() {
        state.closed.store(true, Ordering::Release);
        if let Ok(mut frames) = state.frames.lock() { frames.clear(); }
    }
}
fn active(settings: &Value) -> &str { settings["homepageId"].as_str().unwrap_or("") }
fn text(args: &[Value], index: usize, cap: usize) -> Result<&str> {
    args.get(index).and_then(Value::as_str).filter(|s| s.len() <= cap && !s.contains('\0')).ok_or_else(invalid)
}
fn count(args: &[Value], min: usize, max: usize) -> Result<()> { if (min..=max).contains(&args.len()) { Ok(()) } else { Err(invalid()) } }
fn sha(value: &str) -> bool { value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()) }
fn clear_frames(state: &State) -> Result<()> { state.frames.lock().map_err(|_| unavailable())?.clear(); Ok(()) }

/// 实际 writer 保留生命周期登记；IPC 等待方取消不会提前释放它。
async fn in_repository<T: Send + 'static>(app: &AppHandle, operation: impl FnOnce(&AppHandle, &State, &mut repository::Repository, &Value) -> Result<T> + Send + 'static) -> Result<T> {
    let request = app.state::<crate::lifecycle::Gate>().enter()?;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cleanup_unconfirmed = false;
        let result = (|| {
            let state = handle.state::<State>();
            let _serial = state.serial.lock().map_err(|_| unavailable())?;
            state.check()?;
            let storage = handle.state::<crate::storage::Storage>();
            let settings = storage.settings_for_backend()?;
            let mut repo = repository::Repository::open(&storage.data_root_for_backend())?;
            let result = operation(&handle, &state, &mut repo, &settings);
            cleanup_unconfirmed = repo.cleanup_unconfirmed();
            result
        })();
        // 由仓库的真实发布/清理状态决定，错误文案和语言不参与生命周期判定。
        if !cleanup_unconfirmed { request.finish(); }
        result
    }).await.map_err(|_| unavailable())?
}
async fn source(app: &AppHandle, id: String) -> Result<Value> {
    in_repository(app, move |_, _, repo, settings| repo.source(&id, active(settings))).await
}
async fn settings(app: &AppHandle) -> Result<Value> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || handle.state::<crate::storage::Storage>().settings_for_backend()).await.map_err(|_| unavailable())?
}
async fn verify(app: &AppHandle, id: String) -> Result<Value> {
    let initial = source(app, id.clone()).await?;
    let hash = initial["sha256"].as_str().ok_or_else(invalid)?.to_owned();
    if initial["blocked"].is_object() || initial["risk"]["level"] == "reject" {
        return Ok(json!({"entry":repository::without_content(initial),"reachable":true,"message":tr("主页未通过安全检查", "主頁未通過安全檢查", "Homepage failed the safety check")}));
    }
    let number = initial["meta"]["id"].as_str().unwrap_or("").to_owned();
    if number.is_empty() {
        return Ok(json!({"entry":repository::without_content(initial),"reachable":true,"message":tr("无编号主页：首次运行需确认", "無編號主頁：首次執行需確認", "Local homepage: confirmation is required before first use")}));
    }
    let response = async {
        let client = remote::Client::new(&settings(app).await?)?;
        let checked = client.verify(&number, &hash).await?;
        let verified = checked["verified"].as_bool().ok_or_else(invalid)?;
        let not_found = !verified && checked["ok"] == true && checked["script"].is_null();
        let market = if !verified && !not_found { client.market().await? } else { json!([]) };
        let row = market.as_array().and_then(|items| items.iter().find(|item| item["id"].as_str() == Some(&number))).cloned();
        Ok::<_, String>((verified, not_found, row))
    }.await;
    let (verified, not_found, market) = match response {
        Ok(result) => result,
        Err(_) => return Ok(json!({"entry":repository::without_content(initial),"reachable":false,"message":tr("验证服务不可达或响应未通过校验，将使用本地确认流程", "驗證服務無法連線或回應未通過校驗，將使用本機確認流程", "Verification is unavailable or invalid; local confirmation is required")})),
    };
    let status = if verified { "verified" } else { "mismatch" };
    let entry = in_repository(app, move |_, _, repo, settings| repo.set_verification(&id, &hash, status, active(settings))).await?;
    let newer = market.as_ref().is_some_and(|row| compare_version(row["version"].as_str().unwrap_or(""), entry["meta"]["version"].as_str().unwrap_or("")) == std::cmp::Ordering::Greater);
    let edited = !verified && !not_found && market.is_some() && !newer;
    Ok(json!({"entry":entry,"reachable":true,"notFound":not_found,"outdated":newer,"locallyEdited":edited,
        "localVersion":initial["meta"]["version"],"latestVersion":market.as_ref().map(|r| &r["version"]),"marketVersion":market.as_ref().map(|r| &r["version"]),
        "message":if verified {tr("编号与内容哈希校验通过", "編號與內容雜湊校驗通過", "Number and content hash verified")}
        else if not_found {tr("服务端查无此编号，请核对来源", "伺服器查無此編號，請核對來源", "Number not found; check the source")}
        else if newer {tr("线上已有新版本，请先更新", "線上已有新版本，請先更新", "A newer version is available; update first")}
        else if edited {tr("本地内容与线上不同，确认自己的修改后可继续", "本機內容與線上不同，確認自己的修改後可繼續", "Local content differs; confirm your own changes before continuing")}
        else {tr("内容哈希不一致，未通过校验", "內容雜湊不一致，未通過校驗", "Content hash mismatch; verification failed")}}))
}
fn compare_version(left: &str, right: &str) -> std::cmp::Ordering {
    let parts = |s: &str| s.split(['.', '-', '+']).take(32).map(|p| p.chars().take_while(char::is_ascii_digit).collect::<String>().parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let (a,b) = (parts(left),parts(right));
    (0..a.len().max(b.len())).map(|i| a.get(i).copied().unwrap_or(0).cmp(&b.get(i).copied().unwrap_or(0))).find(|o| !o.is_eq()).unwrap_or(std::cmp::Ordering::Equal)
}

pub(crate) async fn call(app: &AppHandle, window: &WebviewWindow, channel: &str, args: &[Value]) -> Result<Option<Value>> {
    if !channel.starts_with("homepage:") { return Ok(None); }
    crate::trusted_main(window)?;
    // 会改写主页文件的通道必须先松开占用：Windows 上持有只读共享句柄时，
    // 改名 / 写入 / 删除都会被系统拒绝，导入与更新会莫名其妙地失败。
    if matches!(channel, "homepage:importFile" | "homepage:download" | "homepage:installNumbered" | "homepage:update" | "homepage:remove") {
        if let Some(state) = app.try_state::<State>() { state.release_hold(); }
    }
    let result = match channel {
        "homepage:securityEngine" => { count(args,0,0)?; json!({"native":true}) },
        "homepage:list" => { count(args,0,0)?; in_repository(app, |_,_,repo,s| repo.list(active(s))).await? },
        "homepage:read" => { count(args,1,1)?; source(app,text(args,0,64)?.to_owned()).await? },
        "homepage:verify" => { count(args,1,1)?; verify(app,text(args,0,64)?.to_owned()).await? },
        // 运行期占用：核对哈希后才把句柄留住，之后该文件不能再被改写（Windows 强制，Unix 仅一致性）。
        "homepage:hold" => {
            count(args,2,2)?; let id=text(args,0,64)?.to_owned();
            let expected=args[1].as_str().filter(|s|sha(s)).ok_or_else(invalid)?.to_owned();
            in_repository(app,move |_,state,repo,_| {
                let file=repo.hold(&id,&expected)?;
                let mut held=state.held.lock().map_err(|_| unavailable())?;
                *held=Some((id,file));
                Ok(Value::Null)
            }).await?
        },
        "homepage:release" => { count(args,0,0)?; if let Some(state)=app.try_state::<State>(){state.release_hold();} Value::Null },
        "homepage:openDir" => { count(args,0,0)?; in_repository(app, |_,_,repo,_| Ok(json!(repo.path().to_str().ok_or_else(invalid)?))).await? },
        "homepage:confirm" => {
            count(args,2,3)?; let id=text(args,0,64)?.to_owned(); let network=args[1].as_bool().ok_or_else(invalid)?;
            let expected=args.get(2).and_then(Value::as_str).filter(|s|sha(s)).ok_or_else(||tr("请重新读取主页后确认", "請重新讀取主頁後確認", "Read the homepage again before confirming"))?.to_owned();
            in_repository(app,move |_,state,repo,s| { clear_frames(state)?; repo.confirm(&id,network,&expected,active(s)) }).await?
        },
        "homepage:setActive" => {
            count(args,1,1)?; let id=text(args,0,64)?.to_owned();
            in_repository(app,move |app,state,repo,s| { if !id.is_empty(){repository::allow(&repo.source(&id,active(s))?)?;} clear_frames(state)?; app.state::<crate::storage::Storage>().compare_set_homepage_for_backend(active(s),&id)?; Ok(Value::Null) }).await?
        },
        "homepage:remove" | "homepage:block" => {
            let block=channel=="homepage:block"; count(args,if block{2}else{1},if block{2}else{1})?;
            let id=text(args,0,64)?.to_owned(); let reason=if block{text(args,1,1600)?.to_owned()}else{String::new()};
            in_repository(app,move |app,state,repo,s| {
                clear_frames(state)?;
                if block {repo.block(&id,&reason)?;} else {repo.remove(&id)?;}
                if active(s)==id {app.state::<crate::storage::Storage>().compare_set_homepage_for_backend(&id,"")?;}
                Ok(Value::Null)
            }).await?
        },
        "homepage:importFile" => {
            count(args,0,0)?;
            let filters=json!([{"name":"HTML 主页 / HTML 主頁 / HTML homepage","extensions":["html","htm"]}]);
            #[cfg(desktop)] let selected=crate::desktop::call(app,window,"shell:pickFile",&[filters]).await?;
            #[cfg(mobile)] let selected=crate::mobile_files::call(app,window,"shell:pickFile",&[filters]).await?;
            let Some(Value::String(path))=selected else {return Ok(Some(Value::Null));};
            let path=PathBuf::from(path);
            in_repository(app,move |app,_,repo,s| {
                #[cfg(desktop)] crate::desktop::require_picked_file(app,&path)?;
                #[cfg(target_os="android")] crate::mobile_files::require_imported_file(app,&path)?;
                let bytes=repository::read_import(&path)?;
                #[cfg(desktop)] crate::desktop::require_picked_file(app,&path)?;
                repo.import(path.file_name().and_then(|s|s.to_str()).ok_or_else(invalid)?,&bytes,active(s))
            }).await?
        },
        "homepage:market" => {count(args,0,0)?; remote::Client::new(&settings(app).await?)?.market().await?},
        "homepage:send-email-code" => {count(args,1,1)?; remote::Client::new(&settings(app).await?)?.email_code(text(args,0,320)?).await?},
        "homepage:submit" => {count(args,1,1)?; remote::Client::new(&settings(app).await?)?.submit(&args[0]).await?},
        "homepage:download" => {
            count(args,2,3)?; let url=text(args,0,4096)?.to_owned(); let name=text(args,1,240)?.to_owned();
            if args.get(2).is_some_and(|v|!v.is_null() && v.as_u64().is_none_or(|n|n>MAX_MARKET_SIZE)){return Err(invalid());}
            let bytes=remote::Client::new(&settings(app).await?)?.download(&url,None).await?;
            in_repository(app,move |_,_,repo,s| repo.import(&name,&bytes,active(s))).await?
        },
        "homepage:installNumbered" => {
            use base64::Engine;
            count(args,1,1)?; let obj=args[0].as_object().ok_or_else(invalid)?;
            if obj.keys().any(|k| !["filename","contentBase64","replaceId"].contains(&k.as_str())){return Err(invalid());}
            let name=obj.get("filename").and_then(Value::as_str).filter(|s|s.len()<=240).ok_or_else(invalid)?.to_owned();
            let encoded=obj.get("contentBase64").and_then(Value::as_str).filter(|s|s.len()<=((MAX_MARKET_SIZE+2)/3*4)as usize).ok_or_else(invalid)?;
            let bytes=base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_|invalid())?;
            if bytes.len() as u64>MAX_MARKET_SIZE{return Err(invalid());} let content=repository::validate_html(&bytes)?;
            if analyzer::parse_meta(content,&name)["id"].as_str().unwrap_or("").is_empty(){return Err(invalid());}
            let replace=obj.get("replaceId").filter(|v|!v.is_null()).map(|v|v.as_str().filter(|s|valid_id(s)).ok_or_else(invalid)).transpose()?.map(str::to_owned);
            in_repository(app,move |_,state,repo,s| { clear_frames(state)?; if let Some(id)=replace{let old=repo.source(&id,active(s))?;repo.replace(&id,old["sha256"].as_str().ok_or_else(invalid)?,&bytes,active(s))}else{repo.import(&name,&bytes,active(s))} }).await?
        },
        "homepage:checkUpdates" => {count(args,0,0)?; check_updates(app).await?},
        "homepage:update" => {count(args,1,1)?; update(app,&args[0]).await?},
        "homepage:log" => {
            count(args,2,2)?; let level=text(args,0,5)?; if !["info","warn","error"].contains(&level){return Err(invalid());}
            let message=text(args,1,16_000)?;
            if settings(app).await?["debugMode"]==true {crate::debug::append(app,level,"homepage",&message.chars().filter(|c|!c.is_control()||*c=='\n').take(4000).collect::<String>())?;}
            Value::Null
        },
        _ => return Err(invalid()),
    };
    Ok(Some(result))
}
async fn check_updates(app:&AppHandle)->Result<Value>{
    let entries=in_repository(app,|_,_,repo,s|repo.list(active(s))).await?;
    let numbered=entries.as_array().ok_or_else(invalid)?.iter().any(|e|e["meta"]["id"].as_str().is_some_and(|s|!s.is_empty()));
    if !numbered{return Ok(json!([]));}
    let settings=settings(app).await?; if settings["mode"]=="local"{return Ok(json!([]));}
    let market=remote::Client::new(&settings)?.market().await?;
    let mut updates=Vec::new();
    for local in entries.as_array().ok_or_else(invalid)?{
        if let Some(row)=market.as_array().and_then(|a|a.iter().find(|r|r["id"]==local["meta"]["id"])){
            let hash=row["sha256"].as_str().unwrap_or("");
            if (!hash.is_empty()&&row["sha256"]!=local["sha256"])||(hash.is_empty()&&compare_version(row["version"].as_str().unwrap_or(""),local["meta"]["version"].as_str().unwrap_or(""))==std::cmp::Ordering::Greater){
                updates.push(json!({"localId":local["id"],"id":row["id"],"name":row["name"],"author":row["author"],"localVersion":local["meta"]["version"],"latestVersion":row["version"],"latestSha256":row["sha256"],"url":row["url"],"size":row["size"],"updatedAt":row["updatedAt"]}));
            }
        }
    }
    Ok(json!(updates))
}
async fn update(app:&AppHandle,input:&Value)->Result<Value>{
    let id=input["localId"].as_str().filter(|s|valid_id(s)).ok_or_else(invalid)?.to_owned();
    let initial=source(app,id.clone()).await?; let expected=initial["sha256"].as_str().ok_or_else(invalid)?.to_owned();
    let client=remote::Client::new(&settings(app).await?)?; let market=client.market().await?;
    let row=market.as_array().and_then(|a|a.iter().find(|r|r["id"]==initial["meta"]["id"]&&r["id"]==input["id"]&&r["url"]==input["url"]&&r["sha256"]==input["latestSha256"])).ok_or_else(invalid)?;
    let digest=row["sha256"].as_str().filter(|s|!s.is_empty());
    if digest.is_some_and(|s|!sha(s)){return Err(invalid());}
    let bytes=client.download(row["url"].as_str().ok_or_else(invalid)?,digest).await?;
    let meta=analyzer::parse_meta(repository::validate_html(&bytes)?,&id);
    if meta["id"]!=initial["meta"]["id"]{return Err(invalid());}
    in_repository(app,move |_,state,repo,s|{clear_frames(state)?;repo.replace(&id,&expected,&bytes,active(s))}).await
}
pub(crate) async fn frame(app:&AppHandle,id:String,expected:String,generation:String,avatar:String,skin:String)->Result<Value>{
    if !valid_id(&id)||!sha(&expected)||generation.len()!=32||!generation.bytes().all(|b|b.is_ascii_hexdigit()){return Err(invalid());}
    in_repository(app,move |_,state,repo,s|protocol::issue(state,repo,s,&id,&expected,&generation,&avatar,&skin)).await
}
pub(crate) fn revoke(app: &AppHandle, generation: &str) -> Result<()> {
    if generation.len() != 32 || !generation.bytes().all(|b| b.is_ascii_hexdigit()) { return Err(invalid()); }
    // 不等待仓库磁盘锁；只撤回匹配代次，旧页面不能撤回后来签发的文档。
    app.state::<State>().frames.lock().map_err(|_| unavailable())?.revoke(generation);
    Ok(())
}
#[cfg(test)] mod tests{
    use super::*;
    #[test]fn version_comparison_and_sha_validation_keep_update_and_verification_distinct(){assert!(compare_version("1.2","1.1").is_gt());assert!(compare_version("1.2.0","1.2").is_eq());assert!(sha(&"a".repeat(64)));assert!(!sha("abc"));}
}

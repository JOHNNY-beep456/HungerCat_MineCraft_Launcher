//! 一次性主页文档。正文来自仓库当前字节，CSP 通过响应头执行，不继承主应用的脚本权限。
use super::{active, repository, State, Result, invalid, unavailable, tr};
use serde_json::{json, Value};
use std::{collections::BTreeSet, sync::atomic::Ordering, time::{Duration, Instant}};
use tauri::{Emitter, Manager};
use url::Url;

const SDK: &str = include_str!(concat!(env!("OUT_DIR"), "/homepage_sdk.js"));
#[derive(Default)]
pub(super) struct Frames { current: Option<Ticket> }
struct Ticket { token: String, id: String, sha: String, generation: String, avatar: String, skin: String, issued: Instant, navigating: bool, consumed: bool }
impl Frames {
    pub(super) fn clear(&mut self) { self.current = None; }
    pub(super) fn revoke(&mut self, generation: &str) {
        if self.current.as_ref().is_some_and(|ticket| ticket.generation == generation) { self.clear(); }
    }
    fn permits_navigation(&self, token: &str) -> bool {
        self.current.as_ref().is_some_and(|ticket| ticket.token == token && !ticket.consumed && ticket.issued.elapsed() <= Duration::from_secs(30))
    }
    fn generation(&self, token: &str) -> Option<String> {
        self.current.as_ref().filter(|ticket| ticket.token == token).map(|ticket| ticket.generation.clone())
    }
    fn navigation(&mut self, token: &str) -> bool {
        let Some(ticket) = self.current.as_mut() else {return false;};
        if ticket.token != token || ticket.issued.elapsed() > Duration::from_secs(30) || ticket.navigating || ticket.consumed {return false;}
        ticket.navigating = true; true
    }
    fn take(&mut self, token: &str) -> Result<(String,String,String,String,String)> {
        let ticket = self.current.as_mut().ok_or_else(invalid)?;
        if ticket.token != token || ticket.consumed || !ticket.navigating || ticket.issued.elapsed() > Duration::from_secs(30) {return Err(invalid());}
        ticket.consumed = true;
        Ok((ticket.id.clone(),ticket.sha.clone(),ticket.generation.clone(),ticket.avatar.clone(),ticket.skin.clone()))
    }
}
/// 每个原生 iframe 仅能取得一次文档授权；旧 frame 永远不能改绑新票据。
#[derive(Default)]
struct FrameBinding { generation: Option<String> }
impl FrameBinding {
    fn navigation(&mut self, frames: &mut Frames, url: Option<&Url>) -> bool {
        if self.generation.is_some() { return false; }
        if url.is_some_and(|url| url.as_str() == "about:blank") { return true; }
        let Some(token) = url.and_then(ticket_token) else { return false; };
        let Some(generation) = frames.generation(token) else { return false; };
        if !frames.navigation(token) { return false; }
        self.generation = Some(generation);
        true
    }
}
fn origin(raw: &str) -> Option<String> {
    if raw.is_empty() {return None;}
    let url=Url::parse(raw).ok()?;
    if !matches!(url.scheme(),"https"|"http") || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {return None;}
    Some(url.origin().ascii_serialization())
}
fn ticket_token(url: &Url) -> Option<&str> {
    let correct=matches!(url.scheme(),"http"|"https") && url.host_str()==Some("hc-homepage.localhost") && url.port().is_none()
        || url.scheme()=="hc-homepage" && url.host_str()==Some("localhost");
    if !correct || url.query().is_some() || url.fragment().is_some() || !url.username().is_empty() || url.password().is_some() {return None;}
    url.path().strip_prefix("/frame/").filter(|s|s.len()==64 && s.bytes().all(|b|b.is_ascii_hexdigit()))
}
pub(super) fn issue(state:&State,repo:&repository::Repository,settings:&Value,id:&str,expected:&str,generation:&str,avatar:&str,skin:&str)->Result<Value>{
    state.check()?;
    if !state.guard_ready.load(Ordering::Acquire){return Err(tr("当前平台尚未具备主页子框架导航保护", "目前平台尚未具備主頁子框架導覽保護", "Homepage frame navigation protection is unavailable on this platform"));}
    let source=repo.source(id,active(settings))?;
    authorize(&source,active(settings),id,expected)?;
    if avatar.len()>2048||skin.len()>2048{return Err(invalid());}
    let token=format!("{}{}",uuid::Uuid::new_v4().simple(),uuid::Uuid::new_v4().simple());
    let avatar=if avatar.is_empty(){String::new()}else{origin(avatar).ok_or_else(invalid)?};
    let skin=if skin.is_empty(){String::new()}else{origin(skin).ok_or_else(invalid)?};
    state.frames.lock().map_err(|_|unavailable())?.current=Some(Ticket{token:token.clone(),id:id.to_owned(),sha:expected.to_owned(),generation:generation.to_owned(),avatar,skin,issued:Instant::now(),navigating:false,consumed:false});
    #[cfg(any(target_os="windows",target_os="android"))]let base="http://hc-homepage.localhost";
    #[cfg(not(any(target_os="windows",target_os="android")))]let base="hc-homepage://localhost";
    Ok(json!({"url":format!("{base}/frame/{token}"),"sha256":expected,"generation":generation}))
}
fn authorize(source:&Value,selected:&str,id:&str,expected:&str)->Result<()> {
    repository::allow(source)?;
    if selected!=id||source["sha256"].as_str()!=Some(expected)||!(source["confirmed"]==true||source["verify"]=="verified")
        || (source["risk"]["level"]=="warn"&&source["networkApproved"]!=true){
        return Err(tr("主页内容或授权已改变，请重新确认", "主頁內容或授權已變更，請重新確認", "Homepage content or approval changed; confirm again"));
    }
    Ok(())
}
fn csp(source:&Value,avatar:&str,skin:&str)->String {
    let mut approved=BTreeSet::new();
    if source["networkApproved"]==true {
        if let Some(items)=source["risk"]["externals"].as_array(){for item in items{if let Some(value)=item["url"].as_str().and_then(|s|if s.starts_with("//"){origin(&format!("https:{s}"))}else{origin(s)}){approved.insert(value);}}}
    }
    let sources=approved.iter().cloned().collect::<Vec<_>>().join(" ");
    let net=if sources.is_empty(){"'none'"}else{sources.as_str()};
    let mut images=BTreeSet::from(["data:".to_owned(),"blob:".to_owned()]);
    images.extend(approved.iter().cloned()); for host in [avatar,skin]{if let Some(host)=origin(host){images.insert(host);}}
    // 外链脚本尚无固定依赖字节，所有 script-src 外部源都拒绝；内联 SDK 与主页代码保持原合同。
    format!("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' {sources}; img-src {}; font-src data: {sources}; media-src data: {sources}; connect-src {net}; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors tauri://localhost http://tauri.localhost https://tauri.localhost http://localhost:1420 http://127.0.0.1:1420; sandbox allow-scripts",images.into_iter().collect::<Vec<_>>().join(" "))
}
// sandbox 与 frame-ancestors 仅在响应头生效，不重复放入 meta 产生误导性警告。
fn meta_csp(policy: &str) -> String {
    policy.split(';').map(str::trim).filter(|part| !part.starts_with("frame-ancestors ") && !part.starts_with("sandbox ")).collect::<Vec<_>>().join("; ")
}
fn escape_attribute(text:&str)->String{text.replace('&',"&amp;").replace('"',"&quot;").replace('<',"&lt;").replace('>',"&gt;")}
fn document(source:&Value,generation:&str,policy:&str)->Result<String>{
    let raw=source["content"].as_str().ok_or_else(invalid)?;
    // 注入在任何作者字节之前，HTML 解析器会隐式建立 head。原正文仍按原次序解析。
    // 此处不依赖正文里可能被注释、脚本字符串伪造的 head 标签。
    let bootstrap=format!("Object.defineProperty(window,'__HC_FRAME_GENERATION__',{{value:{}}});\n{}",serde_json::to_string(generation).map_err(|_|invalid())?,SDK).replace("</script","<\\/script");
    Ok(format!(r#"<!doctype html><meta id="hc-csp" http-equiv="Content-Security-Policy" content="{}"><style id="hc-base">:root{{color-scheme:light dark;--hc-radius-control:12px;--hc-radius-card:24px;--hc-radius-full:999px;--hc-surface-material:solid;--hc-surface-blur:none;--hc-surface-border-width:1px}}html,body{{margin:0;padding:0;min-height:100%;background:transparent}}body{{font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:var(--hc-text-primary,#111)}}.hc-surface{{border-radius:var(--hc-radius-card);border:var(--hc-surface-border-width,1px) solid var(--hc-glass-border,transparent);background:var(--hc-glass-bg,transparent);backdrop-filter:var(--hc-surface-blur)}}</style><script id="hc-sdk">{bootstrap}</script>{raw}"#,escape_attribute(&meta_csp(policy))))
}
fn response(result:Result<(String,String)>)->tauri::http::Response<Vec<u8>>{
    match result{
        Ok((html,policy))=>tauri::http::Response::builder().status(200).header("Content-Type","text/html; charset=utf-8").header("Content-Security-Policy",policy).header("Cache-Control","no-store").header("Referrer-Policy","no-referrer").header("X-Content-Type-Options","nosniff").body(html.into_bytes()).expect("固定响应头"),
        Err(_)=>tauri::http::Response::builder().status(403).header("Content-Type","text/plain; charset=utf-8").header("Content-Security-Policy","default-src 'none'; sandbox").header("Cache-Control","no-store").body(b"Homepage document is unavailable; confirm again.".to_vec()).expect("固定响应头"),
    }
}
pub(crate) fn protocol_response(context:tauri::UriSchemeContext<'_,tauri::Wry>,request:tauri::http::Request<Vec<u8>>,responder:tauri::UriSchemeResponder){
    let app=context.app_handle().clone(); let main=context.webview_label()=="main";
    tauri::async_runtime::spawn_blocking(move||{
        let result=(||{
            if !main||request.method()!=tauri::http::Method::GET||!request.body().is_empty(){return Err(invalid());}
            let url=Url::parse(&request.uri().to_string()).map_err(|_|invalid())?;
            let token=ticket_token(&url).ok_or_else(invalid)?;
            let request_guard=app.state::<crate::lifecycle::Gate>().enter()?;
            let result=(||{
                let state=app.state::<State>(); let _serial=state.serial.lock().map_err(|_|unavailable())?;state.check()?;
                let(id,expected,generation,avatar,skin)=state.frames.lock().map_err(|_|unavailable())?.take(token)?;
                let storage=app.state::<crate::storage::Storage>();let settings=storage.settings_for_backend()?;
                let repo=repository::Repository::open(&storage.data_root_for_backend())?;let source=repo.source(&id,active(&settings))?;
                authorize(&source,active(&settings),&id,&expected)?;let policy=csp(&source,&avatar,&skin);let html=document(&source,&generation,&policy)?;state.check()?;Ok((html,policy))
            })();request_guard.finish();result
        })();responder.respond(response(result));
    });
}
fn app_url(url:&Url)->bool{
    (url.scheme()=="tauri"&&url.host_str()==Some("localhost")||matches!(url.scheme(),"http"|"https")&&url.host_str()==Some("tauri.localhost"))
        &&url.username().is_empty()&&url.password().is_none()&&url.port().is_none()
        || cfg!(debug_assertions)&&url.scheme()=="http"&&matches!(url.host_str(),Some("localhost"|"127.0.0.1"))&&url.port()==Some(1420)
}
pub(crate) fn plugin()->tauri::plugin::TauriPlugin<tauri::Wry>{
    tauri::plugin::Builder::new("homepage-host")
        .setup(|app,_|{super::init(app);Ok(())})
        .on_navigation(|webview,url| if webview.label()=="main"{app_url(url)}else{true})
        .on_webview_ready(|webview|{
            if webview.label()!="main"{return;}
            #[cfg(windows)]{
                let app=webview.app_handle().clone();let state_app=app.clone();
                let _=webview.with_webview(move|platform|{
                    use webview2_com::{CoTaskMemPWSTR, FrameCreatedEventHandler, FrameNavigationStartingEventHandler, NavigationStartingEventHandler};
                    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_4, ICoreWebView2Frame2};
                    use windows_core::Interface;
                    let result=(||unsafe{
                        let core=platform.controller().CoreWebView2()?;
                        let created_app=app.clone();
                        let created=FrameCreatedEventHandler::create(Box::new(move|_,args|{
                            let install=(||{
                                let Some(args)=args else {return Err(windows_core::Error::from_hresult(windows_core::HRESULT(0x80004005u32 as i32)));};
                                let frame=args.Frame()?.cast::<ICoreWebView2Frame2>()?;
                                let frame_app=created_app.clone();
                                let mut binding=FrameBinding::default();
                                let mut reported=false;
                                let starting=FrameNavigationStartingEventHandler::create(Box::new(move|_,args|{
                                    if let Some(args)=args {
                                        let mut raw=Default::default();
                                        let parsed=args.Uri(&mut raw).map(|_|CoTaskMemPWSTR::from(raw).to_string()).ok().and_then(|u|Url::parse(&u).ok());
                                        let allowed={
                                            let state=frame_app.state::<State>();
                                            !state.closed.load(Ordering::Acquire) && state.guard_ready.load(Ordering::Acquire)
                                                && state.frames.lock().map(|mut frames|binding.navigation(&mut frames,parsed.as_ref())).unwrap_or(false)
                                        };
                                        if !allowed {
                                            args.SetCancel(true)?;
                                            // 身份来自发起导航的原生 frame；绝不借用此时可能已换代的全局票据。
                                            if !reported {
                                                reported=true;
                                                if let Some(generation)=binding.generation.as_ref() {
                                                    let _=frame_app.emit_to("main","homepage-frame-blocked",json!({"generation":generation,"message":tr("主页尝试离开已授权文档", "主頁嘗試離開已授權文件", "Homepage attempted to leave the authorized document")}));
                                                }
                                            }
                                        }
                                    }
                                    Ok(())
                                }));
                                let mut token=0;frame.add_NavigationStarting(&starting,&mut token)?;
                                Ok::<_,windows_core::Error>(())
                            })();
                            if install.is_err(){created_app.state::<State>().guard_ready.store(false,Ordering::Release);}
                            install
                        }));
                        let mut created_token=0;core.cast::<ICoreWebView2_4>()?.add_FrameCreated(&created,&mut created_token)?;
                        // 全局兜底只筛选 URL，不消费票据，也不把旧 frame 的事件归给新页面。
                        let handler=NavigationStartingEventHandler::create(Box::new(move|_,args|{
                            if let Some(args)=args{
                                let mut raw=Default::default();let parsed=args.Uri(&mut raw).map(|_|CoTaskMemPWSTR::from(raw).to_string()).ok().and_then(|u|Url::parse(&u).ok());
                                let state=app.state::<State>();
                                let allowed=!state.closed.load(Ordering::Acquire) && state.guard_ready.load(Ordering::Acquire)
                                    && parsed.as_ref().is_some_and(|url|url.as_str()=="about:blank" || ticket_token(url).is_some_and(|token|state.frames.lock().map(|frames|frames.permits_navigation(token)).unwrap_or(false)));
                                if !allowed {args.SetCancel(true)?;}
                            }
                            Ok(())
                        }));let mut token=0;core.add_FrameNavigationStarting(&handler,&mut token)?;Ok::<_,webview2_com::Error>(())
                    })();
                    state_app.state::<State>().guard_ready.store(result.is_ok(),Ordering::Release);
                });
            }
        }).build()
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn ticket_origin_and_single_use_are_bound_to_exact_path(){
        let token="a".repeat(64);let valid=Url::parse(&format!("http://hc-homepage.localhost/frame/{token}")).unwrap();assert_eq!(ticket_token(&valid),Some(token.as_str()));
        for url in [format!("https://example.com/frame/{token}"),format!("http://hc-homepage.localhost/frame/{token}?x"),format!("http://hc-homepage.localhost/frame/{token}%2f")]{assert!(ticket_token(&Url::parse(&url).unwrap()).is_none());}
        let mut frames=Frames{current:Some(Ticket{token:token.clone(),id:"x".into(),sha:"b".repeat(64),generation:"c".repeat(32),avatar:String::new(),skin:String::new(),issued:Instant::now(),navigating:false,consumed:false})};
        assert!(frames.take(&token).is_err());assert!(frames.navigation(&token));assert!(!frames.navigation(&token));assert!(frames.take(&token).is_ok());assert!(frames.take(&token).is_err());frames.clear();assert!(!frames.navigation(&token));
    }
    #[test]fn old_frame_cannot_consume_replacement_ticket_or_report_its_generation(){
        let first="a".repeat(64);let second="b".repeat(64);
        let ticket=|token:String,generation:&str|Ticket{token,id:"x".into(),sha:"d".repeat(64),generation:generation.into(),avatar:String::new(),skin:String::new(),issued:Instant::now(),navigating:false,consumed:false};
        let first_url=Url::parse(&format!("http://hc-homepage.localhost/frame/{first}")).unwrap();
        let second_url=Url::parse(&format!("http://hc-homepage.localhost/frame/{second}")).unwrap();
        let blank=Url::parse("about:blank").unwrap();
        let mut frames=Frames{current:Some(ticket(first.clone(),"old"))};
        let mut old=FrameBinding::default();
        assert!(old.navigation(&mut frames,Some(&blank)));assert!(old.generation.is_none());
        assert!(old.navigation(&mut frames,Some(&first_url)));assert_eq!(old.generation.as_deref(),Some("old"));
        assert!(frames.take(&first).is_ok());frames.current=Some(ticket(second.clone(),"new"));
        assert!(!old.navigation(&mut frames,Some(&second_url)));assert_eq!(old.generation.as_deref(),Some("old"));
        assert!(!frames.current.as_ref().unwrap().navigating);
        let mut new=FrameBinding::default();assert!(new.navigation(&mut frames,Some(&second_url)));
        assert_eq!(new.generation.as_deref(),Some("new"));frames.revoke("old");assert!(frames.take(&second).is_ok());
        frames.revoke("new");assert!(!frames.permits_navigation(&second));
        assert!(!new.navigation(&mut frames,Some(&blank)));
    }
    #[test]fn revoked_ticket_cannot_be_replayed_or_reauthorized_after_replacement(){
         let first="a".repeat(64);let second="b".repeat(64);
         let ticket=|token:String,generation:&str|Ticket{token,id:"x".into(),sha:"d".repeat(64),generation:generation.into(),avatar:String::new(),skin:String::new(),issued:Instant::now(),navigating:false,consumed:false};
         let first_url=Url::parse(&format!("http://hc-homepage.localhost/frame/{first}")).unwrap();
         let second_url=Url::parse(&format!("http://hc-homepage.localhost/frame/{second}")).unwrap();
         let mut frames=Frames{current:Some(ticket(first.clone(),"old"))};
         assert!(frames.navigation(&first));
         frames.revoke("old");
         assert!(!frames.permits_navigation(&first));
         assert!(frames.take(&first).is_err());
         frames.current=Some(ticket(second.clone(),"new"));
         let mut old=FrameBinding::default();
         assert!(!old.navigation(&mut frames,Some(&first_url)));
         assert!(!frames.current.as_ref().unwrap().navigating);
         assert!(frames.navigation(&second));
         assert!(frames.take(&second).is_ok());
         assert!(!frames.permits_navigation(&second));
         assert!(ticket_token(&second_url).is_some());
     }
     #[test]fn content_confirmation_and_network_approval_are_rechecked(){
        let mut source=json!({"risk":{"level":"safe","externals":[]},"confirmed":true,"sha256":"a","content":"<html><body>fixture</body></html>"});
        assert!(authorize(&source,"x","x","a").is_ok());assert!(authorize(&source,"y","x","a").is_err());assert!(authorize(&source,"x","x","b").is_err());source["risk"]["level"]=json!("warn");assert!(authorize(&source,"x","x","a").is_err());source["networkApproved"]=json!(true);assert!(authorize(&source,"x","x","a").is_ok());
        let policy=csp(&source,"","");assert!(policy.contains("connect-src 'none'"));
        assert!(!policy.contains("'unsafe-inline' 'none'"));assert!(!policy.contains("data: 'none'"));
        assert!(policy.contains("frame-ancestors "));assert!(policy.contains("sandbox allow-scripts"));
        let meta=meta_csp(&policy);assert!(!meta.contains("frame-ancestors"));assert!(!meta.contains("sandbox"));assert!(meta.contains("frame-src 'none'"));
        let html=document(&source,&"a".repeat(32),&policy).unwrap();assert!(html.find("id=\"hc-sdk\"").unwrap()<html.find("<html>").unwrap());assert!(html.contains("e.source !== parent"));
    }
}

//! Windows 只读弹幕宿主。排队 destroy 不释放 owner；必须精确回执且双表为空。
use super::{danmaku_model::Mailbox, session};
use serde_json::Value;
use std::sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}};
use std::time::{Duration,Instant};
use tauri::{AppHandle,Manager,WebviewWindow};
#[path="../ai_hud_window/lifecycle.rs"] mod lifecycle;
use lifecycle::{Action,Desired,Model,Registry};
type Result<T> = std::result::Result<T,String>;
const LABEL:&str="danmaku";
const ENTRY:&str="index.html?window=danmaku";
#[derive(Default)]
struct Signals { destroyed:AtomicBool, close_requested:AtomicBool, ready:AtomicBool }
struct Binding { id:u64, stamp:Option<String>, window:WebviewWindow, signals:Arc<Signals> }
#[derive(Default)]
struct Inner {
    pending:bool, busy:bool, retry:bool, model:Model, binding:Option<Binding>,
    lease:Option<crate::lifecycle::Request>, error:Option<String>, recoverable_error:bool, manual:Option<bool>, control_intent:u64, mailbox:Mailbox,
}
struct State { closed:AtomicBool, started:Instant, inner:Mutex<Inner> }
impl Default for State {fn default()->Self{Self{closed:AtomicBool::new(false),started:Instant::now(),inner:Mutex::new(Inner::default())}}}
impl State {fn now(&self)->u64{self.started.elapsed().as_millis().min(u64::MAX as u128) as u64}}
fn failure()->String{"弹幕窗口状态不可用 / 彈幕視窗狀態無法使用 / Danmaku window state is unavailable".into()}
fn state(app:&AppHandle)->Result<Arc<State>>{app.try_state::<Arc<State>>().map(|s|s.inner().clone()).ok_or_else(failure)}
pub(super) fn init(app:&AppHandle){let _=app.manage(Arc::new(State::default()));}
fn allowed_url(label:&str,url:&url::Url)->bool {
    if label!=LABEL||!url.username().is_empty()||url.password().is_some()||url.fragment().is_some(){return false;}
    let bundled=url.port().is_none()&&((url.scheme()=="tauri"&&url.host_str()==Some("localhost"))
        ||(matches!(url.scheme(),"http"|"https")&&url.host_str()==Some("tauri.localhost")));
    let dev=cfg!(debug_assertions)&&url.scheme()=="http"&&matches!(url.host_str(),Some("localhost")|Some("127.0.0.1"))&&url.port()==Some(1420);
    (bundled||dev)&&matches!(url.path(),"/"|"/index.html")&&url.query()==Some("window=danmaku")
}
async fn on_ui<T:Send+'static>(app:&AppHandle,work:impl FnOnce()->Result<T>+Send+'static)->Result<T>{
    let(tx,rx)=tokio::sync::oneshot::channel();app.run_on_main_thread(move||{let _=tx.send(work());}).map_err(|_|failure())?;
    rx.await.map_err(|_|failure())?
}
fn mark(state:&State,manual:Option<bool>,terminal:bool,force_intent:bool)->Option<(bool,u64)> {
    let Ok(mut inner)=state.inner.lock()else{return None;};
    if !terminal && state.closed.load(Ordering::Acquire){return None;}
    // 显式命令总会 supersede；自动同步仅在清除手动覆盖时 supersede。
    if force_intent||terminal||(manual.is_none()&&inner.manual.is_some()) {
        inner.control_intent=inner.control_intent.wrapping_add(1);
    }
    let intent=inner.control_intent;
    if terminal{inner.model.terminate();inner.manual=None;inner.mailbox.clear();}
    else {inner.manual=manual;inner.model.request();if manual==Some(false){inner.mailbox.clear();}}
    inner.pending=true;if inner.busy{Some((false,intent))}else{inner.busy=true;Some((true,intent))}
}
pub(super) fn request_sync(app:&AppHandle){
    #[cfg(windows)] if let Ok(state)=state(app){
        if let Some((start,_intent))=mark(&state,None,false,false){if start{spawn(app,state);}}
    }
    #[cfg(not(windows))] {let _=app;}
}
fn close_intent(app:&AppHandle)->Option<u64>{
    let state=state(app).ok()?;
    state.closed.store(true,Ordering::Release);
    #[cfg(windows)] {
        let (start,intent)=mark(&state,None,true,false)?;
        if start{spawn(app,state);}
        Some(intent)
    }
    #[cfg(not(windows))] {let _=state;None}
}
pub(super) fn close(app:&AppHandle){let _=close_intent(app);}
fn retry(app:&AppHandle,state:&Arc<State>){
    let schedule=if let Ok(mut inner)=state.inner.lock(){if inner.pending&&!inner.busy&&!inner.retry{inner.retry=true;true}else{false}}else{false};
    if !schedule{return;}
    let handle=app.clone();let state=state.clone();tauri::async_runtime::spawn(async move{
        tokio::time::sleep(Duration::from_millis(100)).await;
        let start=if let Ok(mut inner)=state.inner.lock(){inner.retry=false;if inner.pending&&!inner.busy{inner.busy=true;true}else{false}}else{false};
        if start{spawn(&handle,state);}
    });
}
fn wake(app:&AppHandle,id:u64){
    let handle=app.clone();tauri::async_runtime::spawn(async move{
        let Ok(state)=state(&handle)else{return;};
        let start=if let Ok(mut inner)=state.inner.lock(){if inner.model.instance()!=Some(id){return;}inner.pending=true;if inner.busy{false}else{inner.busy=true;true}}else{false};
        if start{spawn(&handle,state);}
    });
}
#[derive(Clone,Copy)] enum Step{Again,Wait,Visible,Idle,Retained}
fn finish(inner:&mut Inner){if let Some(lease)=inner.lease.take(){lease.finish();}}
fn spawn(app:&AppHandle,state:Arc<State>){
    let handle=app.clone();let monitor=handle.clone();let retained=state.clone();
    let task=tauri::async_runtime::spawn(async move{worker(&handle,&state).await;});
    tauri::async_runtime::spawn(async move{if task.await.is_err(){
        let needs_retry=if let Ok(mut inner)=retained.inner.lock(){inner.model.fault();inner.error=Some(failure());inner.busy=false;
            if inner.binding.is_some(){inner.pending=true;true}else{false}}else{false};
        if needs_retry{retry(&monitor,&retained);}
    }});
}
async fn worker(app:&AppHandle,state:&Arc<State>){
    loop {
        {let Ok(mut inner)=state.inner.lock()else{return;};if !inner.pending{inner.busy=false;return;}inner.pending=false;}
        let needs=state.inner.lock().map(|i|i.lease.is_none()).unwrap_or(false);
        if needs&&!state.closed.load(Ordering::Acquire){
            match app.state::<crate::lifecycle::Gate>().enter_classified(){
                Ok(lease)=>{let Ok(mut inner)=state.inner.lock()else{return;};inner.lease=Some(lease);},
                Err(crate::lifecycle::EnterFailure::Closed)=>{state.closed.store(true,Ordering::Release);if let Ok(mut inner)=state.inner.lock(){inner.model.terminate();}},
                Err(crate::lifecycle::EnterFailure::Restarting)=>{if let Ok(mut inner)=state.inner.lock(){inner.pending=true;inner.busy=false;}retry(app,state);return;},
                Err(_)=>{if let Ok(mut inner)=state.inner.lock(){inner.error=Some(failure());inner.busy=false;}return;},
            }
        }
        let handle=app.clone();let owned=state.clone();let result=on_ui(app,move||sync_on_ui(&handle,&owned)).await;
        let mut again=false;let mut wait=false;
        if let Ok(mut inner)=state.inner.lock(){match result{
            Ok(Step::Again)=>{inner.pending=true;again=true;},
            Ok(Step::Wait)=>{inner.pending=true;inner.busy=false;wait=true;},
            // 原生窗口可见时仍保留 Gate 票据，直到明确 close + Destroyed + 双表清空。
            Ok(Step::Visible)=>{
                // show() 已经 flush 了就绪邮箱；若页面尚未握手，邮箱必须保留到 ready()。
                inner.error=None;
                inner.recoverable_error=false;
                if inner.pending { again=true; } else { inner.busy=false; }
            },
            Ok(Step::Idle)=>{
                // sync_on_ui already confirmed the exact idle/empty state outside this lock.
                if inner.model.instance().is_none() && !inner.model.busy_resource() && inner.binding.is_none() {
                    if inner.recoverable_error {
                        inner.error=None;
                        inner.recoverable_error=false;
                        inner.model.clear_recoverable_prebuild();
                    }
                    finish(&mut inner);
                } else {
                    inner.error=Some(failure());
                    inner.recoverable_error=false;
                }
                if inner.pending{again=true;}else{inner.busy=false;}
            },
            Ok(Step::Retained)=>{
                inner.error=Some(failure());
                inner.recoverable_error=false;
                if inner.pending{again=true;}else{inner.busy=false;}
            },
            Err(error)=>{
                inner.error=Some(error);
                inner.recoverable_error=false;
                inner.mailbox.clear();
                if let Some(id)=inner.model.instance(){
                    if inner.binding.is_some(){
                        inner.model.native_failed(id,state.now());
                        inner.pending=true;
                        again=true;
                    } else {
                        inner.model.creation_failed(id);
                        inner.busy=false;
                    }
                } else {
                    // Only pre-builder preparation failures are recoverable. Do not infer this
                    // from a missing instance: a failed builder may have native side effects.
                    inner.recoverable_error=inner.model.recoverable_prebuild_failure();
                    if inner.recoverable_error {
                        inner.pending=true;
                        again=true;
                    } else {
                        // A post-builder/unknown failure keeps its Gate owner until shutdown
                        // or an explicit lifecycle receipt resolves it.
                        inner.busy=false;
                    }
                }
            },
        }}
        if wait{retry(app,state);}if !again{return;}
    }
}
#[cfg(windows)]
fn stamp(window:&WebviewWindow)->Result<String>{use raw_window_handle::HasWindowHandle;Ok(format!("{:?}",window.window_handle().map_err(|_|failure())?.as_raw()))}
#[cfg(windows)]
fn registry(app:&AppHandle,binding:Option<&(u64,Option<String>,Arc<Signals>)>)->Registry{
    let native=app.get_window(LABEL).is_some();let webview=app.get_webview(LABEL).is_some();
    let destroyed=binding.is_some_and(|(_,_,s)|s.destroyed.load(Ordering::Acquire));
    let identity=if native&&webview&&!destroyed{binding.and_then(|(_,s,_)|s.as_ref())
        .zip(app.get_webview_window(LABEL).and_then(|w|stamp(&w).ok())).map(|(a,b)|a==&b)}else{None};
    Registry::observe(native,webview,binding.is_some(),destroyed,identity)
}
fn desired(app:&AppHandle,state:&State)->Result<Desired>{
    if state.closed.load(Ordering::Acquire){return Ok(Desired{enabled:false,revision:0,language:"zh-CN".into()});}
    let view=session::danmaku_view(app)?;let manual=state.inner.lock().map_err(|_|failure())?.manual;
    Ok(Desired{enabled:manual.unwrap_or(view.live&&view.preferences.enabled()),revision:view.generation,language:"zh-CN".into()})
}
#[cfg(windows)]
fn current(app:&AppHandle,state:&State)->Result<WebviewWindow>{
    let expected={let inner=state.inner.lock().map_err(|_|failure())?;
        if state.closed.load(Ordering::Acquire)||inner.model.closing()||inner.model.uncertain()||inner.error.is_some(){return Err(failure());}
        let b=inner.binding.as_ref().filter(|b|!b.signals.destroyed.load(Ordering::Acquire)&&!b.signals.close_requested.load(Ordering::Acquire)).ok_or_else(failure)?;
        (b.id,b.stamp.clone().ok_or_else(failure)?,b.window.clone())};
    if app.get_window(LABEL).is_none()||app.get_webview(LABEL).is_none(){return Err(failure());}
    let window=app.get_webview_window(LABEL).ok_or_else(failure)?;
    if stamp(&window)?!=expected.1||stamp(&expected.2)?!=expected.1||!allowed_url(window.label(),&window.url().map_err(|_|failure())?){return Err(failure());}
    let inner=state.inner.lock().map_err(|_|failure())?;
    if state.closed.load(Ordering::Acquire)||inner.model.closing()||inner.model.uncertain()
        ||!inner.binding.as_ref().is_some_and(|b|b.id==expected.0&&b.stamp.as_ref()==Some(&expected.1)
            &&!b.signals.destroyed.load(Ordering::Acquire)&&!b.signals.close_requested.load(Ordering::Acquire)){return Err(failure());}
    Ok(window)
}
/// 只读配置是唯一弹幕页调用。就绪回执在消费者已订阅后到达，不借此开放任何主窗业务。
pub(super) async fn authorize(app:&AppHandle,window:&WebviewWindow)->Result<()>{
    #[cfg(not(windows))] {let _=(app,window);Err(failure())}
    #[cfg(windows)] {let handle=app.clone();let caller=window.clone();let state=state(app)?;
        on_ui(app,move||{let owned=current(&handle,&state)?;if stamp(&caller)?!=stamp(&owned)?{return Err(failure());}Ok(())}).await}
}
pub(super) async fn ready(app:&AppHandle,window:&WebviewWindow,args:&[Value])->Result<Value>{
    if !args.is_empty(){return Err(failure());}
    #[cfg(not(windows))] {let _=(app,window);Err(failure())}
    #[cfg(windows)] {
        let handle=app.clone();let caller=window.clone();let owned=state(app)?;
        on_ui(app,move||{
            let window=current(&handle,&owned)?;if stamp(&caller)?!=stamp(&window)?{return Err(failure());}
            let id={let inner=owned.inner.lock().map_err(|_|failure())?;let b=inner.binding.as_ref().ok_or_else(failure)?;
                b.signals.ready.store(true,Ordering::Release);b.id};
            let value=session::danmaku_view(&handle)?.preferences.config;
            wake(&handle,id);Ok(value)
        }).await
    }
}
/// 调用方已经核验真实聊天代次。没有窗口时和 Electron 一样丢弃，不回放历史聊天。
pub(super) fn enqueue(app:&AppHandle,generation:u64,chat:&Value){
    #[cfg(windows)] {let Ok(view)=session::danmaku_view(app)else{return;};
        if !view.live||view.generation!=generation{return;}
        let Some(payload)=view.preferences.payload(chat)else{return;};let Ok(state)=state(app)else{return;};
        let id={let Ok(mut inner)=state.inner.lock()else{return;};
            if state.closed.load(Ordering::Acquire)||inner.manual==Some(false)||inner.model.closing()||inner.model.uncertain(){return;}
            let Some(b)=inner.binding.as_ref().filter(|b|!b.signals.destroyed.load(Ordering::Acquire)&&!b.signals.close_requested.load(Ordering::Acquire))else{return;};let id=b.id;
            inner.mailbox.push(generation,payload);id};wake(app,id);
    }
    #[cfg(not(windows))] {let _=(app,generation,chat);}
}
#[cfg(windows)]
fn bounds(app:&AppHandle)->Result<(tauri::PhysicalSize<u32>,tauri::PhysicalPosition<i32>)>{
    let main=app.get_webview_window("main").ok_or_else(failure)?;let monitor=main.primary_monitor().map_err(|_|failure())?.ok_or_else(failure)?;
    let area=monitor.work_area();if area.size.width==0||area.size.height==0{return Err(failure());}Ok((area.size,area.position))
}
#[cfg(windows)]
fn sync_on_ui(app:&AppHandle,state:&Arc<State>)->Result<Step>{
    let latest=desired(app,state)?;
    let observed={let mut inner=state.inner.lock().map_err(|_|failure())?;
        if state.closed.load(Ordering::Acquire){inner.model.terminate();}
        if let Some(b)=&inner.binding {let id=b.id;if b.signals.destroyed.load(Ordering::Acquire){inner.model.destroyed(id,state.now());}
            else if b.signals.close_requested.load(Ordering::Acquire){inner.model.begin_close(id,state.now());}}
        inner.binding.as_ref().map(|b|(b.id,b.stamp.clone(),b.signals.clone()))};
    let registered=registry(app,observed.as_ref());
    let action={let mut inner=state.inner.lock().map_err(|_|failure())?;
        if inner.binding.as_ref().map(|b|b.id)!=observed.map(|b|b.0){return Ok(Step::Again);}inner.model.plan(&latest,registered,state.now())};
    match action{
        Action::Idle=>{state.inner.lock().map_err(|_|failure())?.mailbox.clear();Ok(Step::Idle)},
        Action::Wait=>Ok(Step::Wait),Action::Retained=>Ok(Step::Retained),
        Action::Released(id)=>{let mut inner=state.inner.lock().map_err(|_|failure())?;if inner.binding.as_ref().is_some_and(|b|b.id==id){inner.binding=None;}
            inner.error=None;inner.mailbox.clear();finish(&mut inner);Ok(Step::Again)},
        Action::Destroy{id}=>{let window={let mut inner=state.inner.lock().map_err(|_|failure())?;inner.mailbox.clear();
            inner.binding.as_ref().filter(|b|b.id==id&&!b.signals.destroyed.load(Ordering::Acquire)).map(|b|b.window.clone()).ok_or_else(failure)?};
            if window.destroy().is_err(){let mut inner=state.inner.lock().map_err(|_|failure())?;inner.model.queue_failed(id);inner.error=Some(failure());}Ok(Step::Wait)},
        Action::Create{id,generation}=>create(app,state,id,generation,&latest),
        Action::Show{id,generation}=>show(app,state,id,generation,&latest),
    }
}
#[cfg(not(windows))] fn sync_on_ui(_app:&AppHandle,_state:&Arc<State>)->Result<Step>{Err(failure())}
#[cfg(windows)]
fn create(app:&AppHandle,state:&Arc<State>,id:u64,generation:u64,expected:&Desired)->Result<Step>{
    use tauri::{WebviewUrl,WebviewWindowBuilder};
    let (size,position)=match bounds(app){Ok(v)=>v,Err(error)=>{state.inner.lock().map_err(|_|failure())?.model.cancel_creation(id);return Err(error);}};
    let latest=desired(app,state)?;
    {let mut inner=state.inner.lock().map_err(|_|failure())?;if !inner.model.can_create(id,generation)||!latest.enabled||latest.revision!=expected.revision{inner.model.defer_creation(id);return Ok(Step::Again);}}
    let window=WebviewWindowBuilder::new(app,LABEL,WebviewUrl::App(ENTRY.into()))
        .inner_size(600.0,400.0).visible(false).focused(false).focusable(false).decorations(false).transparent(true)
        .shadow(false).always_on_top(true).skip_taskbar(true).resizable(false).maximizable(false).devtools(false)
        .on_navigation(|url|allowed_url(LABEL,url)).on_new_window(|_,_|tauri::webview::NewWindowResponse::Deny)
        .build().map_err(|_|failure())?;
    let signals=Arc::new(Signals::default());let event_signals=signals.clone();let handle=app.clone();
    window.on_window_event(move|event|{match event{
        tauri::WindowEvent::Destroyed=>{event_signals.destroyed.store(true,Ordering::Release);},
        tauri::WindowEvent::CloseRequested{api,..}=>{api.prevent_close();event_signals.close_requested.store(true,Ordering::Release);},_=>return,
    }wake(&handle,id);});
    let identity=stamp(&window);
    {let mut inner=state.inner.lock().map_err(|_|failure())?;inner.binding=Some(Binding{id,stamp:identity.as_ref().ok().cloned(),window:window.clone(),signals});
        if !inner.model.created(id,"zh-CN".into()){return Err(failure());}}
    identity?;window.set_size(size).map_err(|_|failure())?;window.set_position(position).map_err(|_|failure())?;
    show(app,state,id,generation,expected)
}
#[cfg(windows)]
fn show(app:&AppHandle,state:&Arc<State>,id:u64,generation:u64,expected:&Desired)->Result<Step>{
    let latest=desired(app,state)?;
    let window={let mut inner=state.inner.lock().map_err(|_|failure())?;
        if !inner.model.can_show(id,generation)||!latest.enabled||latest.revision!=expected.revision{inner.model.request();return Ok(Step::Again);}
        inner.binding.as_ref().filter(|b|b.id==id&&!b.signals.destroyed.load(Ordering::Acquire)&&!b.signals.close_requested.load(Ordering::Acquire)).map(|b|b.window.clone()).ok_or_else(failure)?};
    window.set_focusable(false).map_err(|_|failure())?;window.set_always_on_top(true).map_err(|_|failure())?;
    window.set_skip_taskbar(true).map_err(|_|failure())?;window.set_ignore_cursor_events(true).map_err(|_|failure())?;
    let(size,position)=bounds(app)?;if window.inner_size().map_err(|_|failure())?!=size{window.set_size(size).map_err(|_|failure())?;}
    if window.inner_position().map_err(|_|failure())?!=position{window.set_position(position).map_err(|_|failure())?;}
    let before=desired(app,state)?;
    {let mut inner=state.inner.lock().map_err(|_|failure())?;
        if state.closed.load(Ordering::Acquire)||!inner.model.can_show(id,generation)||!before.enabled||before.revision!=expected.revision
            ||!inner.binding.as_ref().is_some_and(|b|b.id==id&&!b.signals.destroyed.load(Ordering::Acquire)&&!b.signals.close_requested.load(Ordering::Acquire)){
            inner.model.request();return Ok(Step::Again);}}
    window.show().map_err(|_|failure())?;
    let after=desired(app,state)?;
    {let mut inner=state.inner.lock().map_err(|_|failure())?;
        if !inner.model.can_show(id,generation)||!after.enabled||after.revision!=expected.revision{inner.model.request();return Ok(Step::Again);}inner.error=None;}
    flush(app,state,id)?;Ok(Step::Visible)
}
#[cfg(windows)]
fn flush(app:&AppHandle,state:&State,id:u64)->Result<()>{
    use tauri::Emitter;
    let view=session::danmaku_view(app)?;
    if !view.live||!view.preferences.enabled(){state.inner.lock().map_err(|_|failure())?.mailbox.clear();return Ok(());}
    let window=current(app,state)?;
    let messages={let mut inner=state.inner.lock().map_err(|_|failure())?;
        let Some(b)=inner.binding.as_ref().filter(|b|b.id==id&&b.signals.ready.load(Ordering::Acquire))else{return Ok(());};let _=b;
        inner.mailbox.take(view.generation)};
    for payload in messages {
        let latest=session::danmaku_view(app)?;if !latest.live||latest.generation!=view.generation||!latest.preferences.enabled(){break;}
        current(app,state)?;if !window.is_visible().map_err(|_|failure())?{break;}
        app.emit_to(LABEL,"launcher:event",serde_json::json!({"channel":"mp:danmaku","payload":payload})).map_err(|_|failure())?;
    }Ok(())
}
fn superseded()->String{"弹幕控制请求已被更新 / 彈幕控制請求已被更新 / Danmaku control request was superseded".into()}
async fn wait_settled(app:&AppHandle,expected:u64)->Result<()>{
    let state=state(app)?;let deadline=tokio::time::Instant::now()+Duration::from_secs(4);
    loop{
        let stable={let inner=state.inner.lock().map_err(|_|failure())?;
            if inner.control_intent!=expected{return Err(superseded());}
            !inner.busy&&!inner.pending&&!inner.retry&&!inner.model.uncertain()&&inner.error.is_none()};
        if stable{
            let handle=app.clone();let owned=state.clone();
            let check=on_ui(app,move||{
                let current_intent={owned.inner.lock().map_err(|_|failure())?.control_intent};
                if current_intent!=expected{return Ok(false);}
                #[cfg(windows)] {let wanted=desired(&handle,&owned)?.enabled;if wanted{let w=current(&handle,&owned)?;return w.is_visible().map_err(|_|failure());}
                    let empty={let inner=owned.inner.lock().map_err(|_|failure())?;inner.binding.is_none()&&!inner.model.busy_resource()&&inner.lease.is_none()};
                    Ok(empty&&handle.get_window(LABEL).is_none()&&handle.get_webview(LABEL).is_none())}
                #[cfg(not(windows))] {let _=(handle,owned);Ok(true)}
            });
            let settled=tokio::time::timeout_at(deadline,check).await.map_err(|_|failure())??;
            if settled {
                let still={state.inner.lock().map_err(|_|failure())?.control_intent==expected};
                if still{return Ok(());}
                return Err(superseded());
            }
            let still={state.inner.lock().map_err(|_|failure())?.control_intent==expected};
            if !still{return Err(superseded());}
        }
        if tokio::time::Instant::now()>=deadline{return Err(failure());}tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
/// 显式 open/close 仅改变弹幕窗本次要求；下一次设置/大厅同步恢复自动条件。
pub(super) async fn control(app:&AppHandle,open:Option<bool>)->Result<()>{
    if !cfg!(windows){return Err(failure());}let state=state(app)?;
    if state.closed.load(Ordering::Acquire){return Err(failure());}
    let Some((start,intent))=mark(&state,open,false,true)else{return Err(failure());};
    if start{spawn(app,state);}wait_settled(app,intent).await
}
pub(super) async fn shutdown(app:&AppHandle)->Result<()>{
    let Some(intent)=close_intent(app)else{return if cfg!(windows){Err(failure())}else{Ok(())};};
    if !cfg!(windows){return Ok(());}wait_settled(app,intent).await
}
pub(super) fn relaunch_ready(app:&AppHandle)->Result<()>{
    let state=state(app)?;let inner=state.inner.try_lock().map_err(|_|failure())?;
    if state.closed.load(Ordering::Acquire)||inner.busy||inner.pending||inner.retry||inner.model.busy_resource()||inner.model.uncertain()||inner.lease.is_some(){Err(failure())}else{Ok(())}
}
#[cfg(test)] mod tests{
    use super::*;
    #[test]fn only_fixed_danmaku_origin_and_query_are_accepted(){
        assert!(allowed_url(LABEL,&url::Url::parse("tauri://localhost/index.html?window=danmaku").unwrap()));
        for raw in ["tauri://localhost/index.html?window=danmaku&x=1","tauri://localhost/index.html?window=danmaku#x","tauri://user@localhost/index.html?window=danmaku","https://evil.invalid/?window=danmaku","tauri://localhost/other?window=danmaku"]{assert!(!allowed_url(LABEL,&url::Url::parse(raw).unwrap()));}
        assert!(!allowed_url("main",&url::Url::parse("tauri://localhost/index.html?window=danmaku").unwrap()));
    }
}

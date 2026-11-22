//! 用户主动发起的三来源账号导入。凭据只留 Rust 内存，公开合同沿用现有三个通道。
mod files;
mod parser;
mod session;

use serde_json::{json, Value};
use session::{Entry, Sessions, Ticket};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

type Result<T> = std::result::Result<T, String>;

pub(crate) fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("hcmcl-account-import")
        .setup(|app, _| { app.manage(Arc::new(Sessions::default())); Ok(()) })
        .on_event(|app, event| {
            let close = matches!(event, tauri::RunEvent::Exit)
                || matches!(event, tauri::RunEvent::WindowEvent { label, event, .. }
                    if label == "main" && crate::invalidates_main_window(event));
            if close {
                if let Some(state) = app.try_state::<Arc<Sessions>>() { state.invalidate(true); }
            }
        })
        .on_drop(|app| { if let Some(state) = app.try_state::<Arc<Sessions>>() { state.invalidate(true); } })
        .build()
}

pub(crate) fn cancel_for_window(app: &AppHandle) {
    if let Some(state) = app.try_state::<Arc<Sessions>>() { state.invalidate(true); }
}

fn sessions(app: &AppHandle) -> Result<Arc<Sessions>> {
    app.try_state::<Arc<Sessions>>().map(|state| state.inner().clone()).ok_or_else(|| "账号导入尚未初始化".into())
}

/// 由 auth 的后台删除事务调用。只等已经进入存储的导入收尾，不持锁等待网络。
pub(crate) fn cancel_for_account_removal(app: &AppHandle) -> Result<()> {
    with_account_removal(app, || Ok(()))
}

pub(crate) fn with_account_removal<T>(app: &AppHandle, operation: impl FnOnce() -> Result<T>) -> Result<T> {
    let sessions = sessions(app)?;
    sessions.begin_removal()?;
    struct Removal(Arc<Sessions>);
    impl Drop for Removal {fn drop(&mut self){self.0.end_removal();}}
    let _removal=Removal(sessions.clone());
    let _gate = sessions.commit_gate.lock().map_err(|_| "账号导入提交状态不可用")?;
    // 闸门覆盖真正删除的存储事务；期间拒绝新预览，不让删除开始前的迟到工作重新入库。
    operation()
}

struct WaiterCancel { ticket: Arc<Ticket>, armed: bool }
impl WaiterCancel {
    fn new(ticket: Arc<Ticket>) -> Self { Self { ticket, armed:true } }
    fn disarm(&mut self) { self.armed=false; }
}
impl Drop for WaiterCancel { fn drop(&mut self) { if self.armed { self.ticket.cancel(); } } }

struct CommitLease { sessions:Arc<Sessions>, ticket:Arc<Ticket>, finished:bool }
impl CommitLease { fn finish(&mut self) { if !self.ticket.uncertain.load(std::sync::atomic::Ordering::Acquire) {self.sessions.finish(&self.ticket);self.finished=true;} } }
impl Drop for CommitLease {
    fn drop(&mut self) {
        // panic/异常退出不释放仍可能有副作用的租约；普通返回必须显式 finish。
        if !self.finished { self.ticket.uncertain.store(true,std::sync::atomic::Ordering::Release);self.ticket.cancel(); }
    }
}

fn preview_entries(candidates:Vec<parser::Candidate>,saved:&std::collections::HashSet<String>) -> Vec<Entry> {
    let mut preferred=std::collections::HashMap::<String,(usize,u8)>::new();
    for (index,candidate) in candidates.iter().enumerate() {
        let Some(id)=candidate.account["id"].as_str().filter(|id|!id.is_empty()) else {continue;};
        let rank=match candidate.status.as_str(){"ready"|"refresh"=>3,"temporary"=>2,_=>1};
        let best=preferred.entry(id.to_owned()).or_insert((index,rank));
        if rank>best.1 {*best=(index,rank);}
    }
    candidates.into_iter().enumerate().map(|(index,candidate)| {
        let duplicate=candidate.account["id"].as_str().is_some_and(|id| saved.contains(id)||preferred.get(id).is_some_and(|best|best.0!=index));
        Entry{key:uuid::Uuid::new_v4().to_string(),account:candidate.account,status:if duplicate{"duplicate".into()}else{candidate.status}}
    }).collect()
}

async fn preview(app:&AppHandle,window:&WebviewWindow,args:&[Value]) -> Result<Value> {
    if !(1..=2).contains(&args.len()) { return Err("账号导入参数数量无效".into()); }
    let source=args[0].as_str().filter(|value| matches!(*value,"pcl2"|"hmcl"|"official")).ok_or("未知账号来源")?;
    let local=match args.get(1) {None|Some(Value::Null)=>false,Some(Value::Bool(value))=>*value,_=>return Err("本地导入选项必须为布尔值".into())};
    if local && source!="pcl2" { return Err("此来源不支持本地配置读取".into()); }
    let sessions=sessions(app)?;
    // 在第一个 await 前占位；窗口关闭在同一把状态锁内使迟到请求无法再次 reserve。
    let ticket=sessions.reserve(window.label())?;
    let mut waiter=WaiterCancel::new(ticket.clone());
    let timer_sessions=Arc::downgrade(&sessions); let timer_ticket=Arc::downgrade(&ticket);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(600)).await;
        if let (Some(sessions),Some(ticket))=(timer_sessions.upgrade(),timer_ticket.upgrade()) {sessions.expire(&ticket);}
    });
    let documents=match files::pick_documents(app,window,source,local,ticket.cancel.clone()).await {
        Ok(Some(documents))=>documents,
        Ok(None)=>{sessions.finish(&ticket);waiter.disarm();return Ok(Value::Null);},
        Err(_)=>{sessions.finish(&ticket);return Err("无法读取所选账号来源，请重新选择受支持的文件".into());},
    };
    sessions.check(&ticket)?;
    let source=source.to_string();let handle=app.clone();
    let parsed=tauri::async_runtime::spawn_blocking(move|| {
        let now=SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(9_007_199_254_740_991) as u64;
        let parsed=parser::parse(&source,documents,now)?;
        let accounts=handle.state::<crate::storage::Storage>().call("accounts:list",&[])?.ok_or("账号列表不可用")?;
        let ids=saved_account_ids(&accounts)?;
        let entries=preview_entries(parsed.candidates,&ids);
        Ok::<_,String>((entries,parsed.warnings))
    }).await.map_err(|_|"账号来源解析任务异常")?;
    let (entries,warnings)=match parsed {Ok(parsed)=>parsed,Err(_)=>{sessions.finish(&ticket);return Err("账号来源格式无效或超过安全限制".into());}};
    let result=sessions.publish(&ticket,entries,warnings);
    if result.is_ok() {waiter.disarm();} else {sessions.finish(&ticket);}
    result
}

async fn commit(app:&AppHandle,window:&WebviewWindow,args:&[Value]) -> Result<Value> {
    if args.len()!=2 {return Err("账号导入提交参数无效".into());}
    let id=args[0].as_str().filter(|id|id.len()<=128).ok_or("导入会话标识无效")?;
    let keys=args[1].as_array().filter(|keys|keys.len()<=500).ok_or("导入选择无效")?.iter()
        .map(|value|value.as_str().filter(|key|key.len()<=128).map(str::to_owned).ok_or_else(||"导入选择无效".to_string())).collect::<Result<Vec<_>>>()?;
    let sessions=sessions(app)?;
    let (ticket,entries)=sessions.begin_commit(window.label(),id,&keys)?;
    let mut waiter=WaiterCancel::new(ticket.clone());
    let handle=app.clone(); let owned_sessions=sessions.clone(); let owned_ticket=ticket.clone();
    let worker=tauri::async_runtime::spawn(async move {
        let work=run_commit(handle,owned_sessions.clone(),owned_ticket.clone(),entries);
        retain_commit(owned_sessions,owned_ticket,work).await
    });
    let result=worker.await.map_err(|_|"账号导入任务异常，会话保持忙碌，请重启后核对已保存账号")?;
    waiter.disarm();result
}

async fn retain_commit<T>(sessions:Arc<Sessions>,ticket:Arc<Ticket>,work:impl std::future::Future<Output=Result<T>>) -> Result<T> {
    let mut lease=CommitLease {sessions,ticket,finished:false};
    let result=work.await;
    lease.finish();result
}

fn saved_account_ids(accounts:&Value) -> Result<std::collections::HashSet<String>> {
    Ok(accounts.as_array().ok_or("账号列表无效")?.iter().filter_map(|account|account["id"].as_str().map(str::to_owned)).collect())
}

fn commit_candidates(entries:Vec<Entry>,saved:&std::collections::HashSet<String>) -> (Vec<Value>,usize) {
    let mut skipped=0;
    let mut seen=std::collections::HashSet::new();
    let accounts=entries.into_iter().filter_map(|entry| {
        let id=entry.account["id"].as_str().unwrap_or("");
        if matches!(entry.status.as_str(),"relogin"|"duplicate") || saved.contains(id) || (!id.is_empty()&&!seen.insert(id.to_owned())) {
            skipped+=1;None
        } else {Some(entry.account)}
    }).collect();
    (accounts,skipped)
}

async fn run_commit(app:AppHandle,sessions:Arc<Sessions>,ticket:Arc<Ticket>,entries:Vec<Entry>) -> Result<Value> {
    sessions.check(&ticket)?;
    // 预览之后可能有其它合法入口写入相同账号；刷新令牌前再过滤一次，避免无用的令牌轮换。
    // 最终 Store 仍在同锁内 insert-only，覆盖网络期间新增同 UUID 的竞争。
    let handle=app.clone();
    let saved=tauri::async_runtime::spawn_blocking(move|| {
        let accounts=handle.state::<crate::storage::Storage>().call("accounts:list",&[])?.ok_or("账号列表不可用")?;
        saved_account_ids(&accounts)
    }).await.map_err(|_|"无法核对当前账号列表")??;
    sessions.check(&ticket)?;
    let (accounts,skipped)=commit_candidates(entries,&saved);
    let count=accounts.len();
    let verified=crate::auth::verify_import_candidates(accounts,ticket.cancel.clone()).await.map_err(|_|"账号导入已取消或验证未完成")?;
    if verified.len()!=count {return Err("账号导入验证结果无效".into());}
    let failed=verified.iter().filter(|result|result.is_err()).count();
    let valid:Vec<Value>=verified.into_iter().filter_map(std::result::Result::ok).collect();
    // join 不做 select：已经进入系统凭据存储的工作必须真实结束，再释放会话与提交租约。
    let valid_count=valid.len();
    let completion_ticket=ticket.clone();
    let stored=tauri::async_runtime::spawn_blocking(move|| {
        let _gate=sessions.commit_gate.lock().map_err(|_|"账号导入提交状态不可用")?;
        sessions.start_saving(&ticket)?;
        // 存储错误只转计数，不把系统凭据后端或来源的细节回传给页面。
        Ok::<_,String>(app.state::<crate::storage::Storage>().insert_import_accounts_for_backend(valid))
    }).await.map_err(|_| {
        completion_ticket.uncertain.store(true,std::sync::atomic::Ordering::Release);
        "账号导入保存任务异常，会话保持忙碌，请重启后核对已保存账号".to_string()
    })??;
    match stored {
        Ok(inserted)=>Ok(json!({"imported":inserted.inserted,"skipped":skipped+inserted.skipped,"failed":failed})),
        Err(_)=>Ok(json!({"imported":0,"skipped":skipped,"failed":failed+valid_count})),
    }
}

pub(crate) async fn call(app:&AppHandle,window:&WebviewWindow,channel:&str,args:&[Value]) -> Result<Option<Value>> {
    if !matches!(channel,"accounts:importPreview"|"accounts:importCommit"|"accounts:importCancel") {return Ok(None);}
    if window.label()!="main" {return Err("此窗口不能导入账号".into());}
    match channel {
        "accounts:importPreview"=>preview(app,window,args).await.map(Some),
        "accounts:importCommit"=>commit(app,window,args).await.map(Some),
        "accounts:importCancel"=>{
            if args.len()!=1 {return Err("取消账号导入参数无效".into());}
            let id=args[0].as_str().filter(|id|id.len()<=128).ok_or("导入会话标识无效")?;
            sessions(app)?.cancel(window.label(),id)?;Ok(Some(Value::Null))
        },
        _=>unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_preview_keeps_one_best_candidate_and_never_reenables_saved_identity() {
        let candidate=|id:&str,status:&str|parser::Candidate{account:json!({"id":id,"name":"Fixture","authType":"microsoft"}),status:status.into()};
        let saved=std::collections::HashSet::from(["saved".to_owned()]);
        let entries=preview_entries(vec![candidate("one","relogin"),candidate("one","temporary"),candidate("one","refresh"),candidate("one","ready"),candidate("saved","ready"),candidate("two","ready")],&saved);
        assert_eq!(entries.iter().map(|entry|entry.status.as_str()).collect::<Vec<_>>(),vec!["duplicate","duplicate","refresh","duplicate","duplicate","ready"]);
        assert_eq!(entries.iter().filter(|entry|entry.status!="duplicate").count(),2);
    }

    #[test]
    fn commit_filters_newly_saved_ids_before_any_refresh_and_retains_valid_selection() {
        let saved=saved_account_ids(&json!([{"id":"already"}])).unwrap();
        let entry=|key:&str,id:&str,status:&str|Entry{key:key.into(),account:json!({"id":id,"accessToken":"FAKE"}),status:status.into()};
        let (accounts,skipped)=commit_candidates(vec![entry("a","already","refresh"),entry("b","new","ready"),entry("c","new","refresh"),entry("d","old","relogin"),entry("e","other","duplicate")],&saved);
        assert_eq!(skipped,4);assert_eq!(accounts.len(),1);assert_eq!(accounts[0]["id"],"new");
        assert!(saved_account_ids(&Value::Null).is_err());
        let candidates=["A","B"].map(|name|parser::Candidate{account:json!({"id":"","name":name,"authType":"microsoft"}),status:"relogin".into()});
        assert!(preview_entries(candidates.into(),&saved).iter().all(|entry|entry.status=="relogin"));
    }

    #[tokio::test]
    async fn failed_owned_worker_keeps_uncertain_lease_without_releasing_for_retry() {
        let sessions=Arc::new(Sessions::default());let ticket=sessions.reserve("main").unwrap();
        sessions.publish(&ticket,vec![],vec![]).unwrap();sessions.begin_commit("main",&ticket.id,&[]).unwrap();
        let child=sessions.clone();let owned=ticket.clone();
        let worker=tokio::spawn(async move {retain_commit::<()>(child,owned,async {panic!("synthetic worker failure")}).await});
        assert!(worker.await.is_err());assert!(ticket.uncertain.load(std::sync::atomic::Ordering::Acquire));
        assert!(sessions.reserve("main").is_err());sessions.cancel("main",&ticket.id).unwrap();assert!(sessions.reserve("main").is_err());
    }

    #[tokio::test(flavor="multi_thread", worker_threads=2)]
    async fn aborting_waiter_signals_cancel_but_keeps_commit_lease_until_real_blocking_finish() {
        let sessions=Arc::new(Sessions::default());let ticket=sessions.reserve("main").unwrap();
        sessions.publish(&ticket,vec![],vec![]).unwrap();sessions.begin_commit("main",&ticket.id,&[]).unwrap();
        let (started_tx,started_rx)=tokio::sync::oneshot::channel();
        let (release_tx,release_rx)=std::sync::mpsc::channel();
        let owned_sessions=sessions.clone();let owned_ticket=ticket.clone();
        let worker=tokio::spawn(async move {
            let work=async move {
                tokio::task::spawn_blocking(move||{let _=started_tx.send(());release_rx.recv().unwrap();}).await.map_err(|_|"夹具后台异常".to_string())?;
                Ok(())
            };
            retain_commit(owned_sessions,owned_ticket,work).await
        });
        let waiter_ticket=ticket.clone();
        let waiter=tokio::spawn(async move {
            let mut guard=WaiterCancel::new(waiter_ticket);
            let result=worker.await;guard.disarm();result
        });
        started_rx.await.unwrap();waiter.abort();let _=waiter.await;
        assert!(ticket.cancel.check().is_err());assert!(sessions.reserve("main").is_err());
        release_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(2),async {
            loop {if sessions.reserve("main").is_ok(){break;}tokio::task::yield_now().await;}
        }).await.unwrap();
    }

    #[test]
    fn removal_waits_for_current_store_and_rejects_late_import_until_deletion_returns() {
        let sessions=Arc::new(Sessions::default());let ticket=sessions.reserve("main").unwrap();
        sessions.publish(&ticket,vec![],vec![]).unwrap();sessions.begin_commit("main",&ticket.id,&[]).unwrap();
        let gate=sessions.commit_gate.lock().unwrap();
        let (invalidated_tx,invalidated_rx)=std::sync::mpsc::channel();
        let (remove_tx,remove_rx)=std::sync::mpsc::channel();
        let child=sessions.clone();let worker=std::thread::spawn(move||{
            child.begin_removal().unwrap();invalidated_tx.send(()).unwrap();
            let _gate=child.commit_gate.lock().unwrap();remove_rx.recv().unwrap();child.end_removal();
        });
        invalidated_rx.recv().unwrap();assert!(ticket.cancel.check().is_err());assert!(sessions.reserve("main").is_err());
        sessions.finish(&ticket);drop(gate);assert!(sessions.reserve("main").is_err());
        remove_tx.send(()).unwrap();worker.join().unwrap();assert!(sessions.reserve("main").is_ok());
    }
}

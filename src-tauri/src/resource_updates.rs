//! 资源更新检测与 owned 应用事务；检测缓存和界面 DTO 不作为文件写入授权。
#[path = "modpack/access.rs"]
mod access;
mod apply;
mod approval;
mod binding;
mod cache;
mod control;
mod local;
pub(crate) use local::{capture_install_profile, InstallProfile};
pub(crate) mod model;
mod recovery;
pub(crate) mod transaction;

pub(crate) fn recover_under_guard(root: &std::path::Path, guard: crate::install_lock::RootOperationGuard) -> Result<crate::install_lock::RootOperationGuard> {
    recovery::under_guard(root, guard)
}

pub(crate) fn recover_for_launch_under_guard(root: &std::path::Path, guard: crate::install_lock::RootOperationGuard, permit: &crate::runtime::LaunchRecoveryPermit) -> Result<crate::install_lock::RootOperationGuard> {
    recovery::for_launch(root, guard, permit)
}

use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, Ordering}}, time::Duration};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Semaphore;
use crate::{lifecycle, storage::Storage};
use model::{DetectedUpdate, UpdateInfo};
type Result<T> = std::result::Result<T, String>;

const CANCELLED: &str = "资源更新检测已取消 / 資源更新檢查已取消 / Resource update check cancelled";
const CHANGED: &str = "资源文件或检测配置已改变，请重新检测 / 資源檔案或檢查設定已變更，請重新檢查 / Resources or check settings changed; check again";
static ANSWERS: OnceLock<cache::Cache> = OnceLock::new();
static FLIGHTS: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
static UPDATES: OnceLock<control::Registry> = OnceLock::new();

#[derive(Default)]
struct ScanState { closed: bool, uncertain: bool, active: HashMap<String, Arc<AtomicBool>> }
static SCANS: OnceLock<Arc<Mutex<ScanState>>> = OnceLock::new();
struct ScanGuard { state: Arc<Mutex<ScanState>>, id: String, finished: bool }
impl ScanGuard {
    fn register() -> Result<(Self, Arc<AtomicBool>)> {
        Self::register_in(SCANS.get_or_init(|| Arc::new(Mutex::new(ScanState::default()))).clone())
    }
    fn register_in(state: Arc<Mutex<ScanState>>) -> Result<(Self, Arc<AtomicBool>)> {
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut table = state.lock().map_err(|_| "资源检测状态不可用")?;
            if table.closed || table.uncertain { return Err("资源检测正在关闭或状态未确认".into()); }
            if table.active.len() >= 8 { return Err("资源检测请求过多，请稍后重试".into()); }
            table.active.insert(id.clone(), cancel.clone());
        }
        Ok((Self { state, id, finished: false }, cancel))
    }
    fn finish(mut self) { self.finished = true; }
}
impl Drop for ScanGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.active.remove(&self.id);
            if !self.finished { state.uncertain = true; }
        }
    }
}
struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop { fn drop(&mut self) { self.0.store(true, Ordering::Release); } }
fn check(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Acquire) { Err(CANCELLED.into()) } else { Ok(()) }
}
fn network_allowed(settings: &Value) -> bool {
    settings.get("mode").and_then(Value::as_str) != Some("local")
        && settings.get("metadataOnlyMods").and_then(Value::as_bool) != Some(true)
}
fn request_id(args: &[Value]) -> Result<String> {
    if args.len() != 1 { return Err("资源更新检测需要一个实例标识".into()); }
    let id = args[0].as_str().ok_or("实例标识必须为字符串")?;
    access::leaf(id)?;
    Ok(id.to_owned())
}
fn ready_from(state: Option<&Arc<Mutex<ScanState>>>) -> Result<()> {
    let Some(state) = state else { return Ok(()); };
    let state = state.try_lock().map_err(|_| "资源检测状态忙碌或不可用")?;
    if state.uncertain || !state.active.is_empty() { return Err("资源检测仍在运行或收尾未确认".into()); }
    Ok(())
}
pub(crate) fn relaunch_ready() -> Result<()> {
    ready_from(SCANS.get())?;
    if let Some(updates) = UPDATES.get() { updates.ready()?; }
    Ok(())
}
pub(crate) fn cancel_for_window() {
    // 同步关闭门限，防止窗口销毁后登记新的写入；取消不移除活跃票据。
    UPDATES.get_or_init(control::Registry::default).close();
    if let Some(state) = SCANS.get() {
        if let Ok(mut state) = state.lock() {
            state.closed = true;
            for cancel in state.active.values() { cancel.store(true, Ordering::Release); }
        }
    }
}
/// 检测没有下载 taskId；明确票据只取消对应更新，全局取消同时通知只读检测。
pub(crate) fn cancel_download(task_id: Option<&str>) -> Result<()> {
    if let Some(updates) = UPDATES.get() { updates.cancel(task_id)?; }
    if task_id.is_some() { return Ok(()); }
    if let Some(state) = SCANS.get() {
        let state = state.lock().map_err(|_| "资源检测状态不可用")?;
        for cancel in state.active.values() { cancel.store(true, Ordering::Release); }
    }
    Ok(())
}

async fn blocking<T, Operation>(gate: lifecycle::Gate, operation: Operation) -> Result<T>
where T: Send + 'static, Operation: FnOnce() -> Result<T> + Send + 'static {
    let registration = gate.enter()?;
    tokio::task::spawn_blocking(move || {
        let result = operation();
        registration.finish();
        result
    }).await.map_err(|_| "资源检测工作线程异常，收尾状态未确认".to_owned())?
}

async fn scan_local(app: &AppHandle, root: PathBuf, id: String, settings: Value, cancel: Arc<AtomicBool>) -> Result<Arc<local::Inventory>> {
    blocking(app.state::<lifecycle::Gate>().inner().clone(), move || {
        local::scan(&root, &id, &settings, &cancel).map(Arc::new)
    }).await
}
async fn verify_context(app: AppHandle, inventory: Arc<local::Inventory>, policy: String, cancel: Arc<AtomicBool>, index: Option<usize>, full: bool) -> Result<()> {
    blocking(app.state::<lifecycle::Gate>().inner().clone(), move || {
        check(&cancel)?;
        let settings = app.state::<Storage>().settings_for_backend()?;
        if !network_allowed(&settings) || cache::policy_key(&settings)? != policy { return Err(CHANGED.into()); }
        if full { inventory.verify(&settings, &cancel)?; } else {
            inventory.verify_context(&settings, &cancel)?;
            if let Some(index) = index { inventory.items.get(index).ok_or("资源索引无效")?.verify(&cancel)?; }
        }
        check(&cancel)
    }).await
}

async fn run_check(app: &AppHandle, root: PathBuf, id: String, settings: Value, cancel: Arc<AtomicBool>) -> Result<Value> {
    check(&cancel)?;
    let policy = cache::policy_key(&settings)?;
    let inventory = scan_local(app, root.clone(), id.clone(), settings.clone(), cancel.clone()).await?;
    // 单个请求最多四个官方查询。并发请求按同一门限顺序进入，避免重复请求同一官方文件。
    let mut workers = tokio::task::JoinSet::new();
    let permits = Arc::new(Semaphore::new(4));
    for index in 0..inventory.items.len() {
        let permits = permits.clone(); let inventory = inventory.clone(); let app = app.clone();
        let settings = settings.clone(); let cancel = cancel.clone(); let policy = policy.clone();
        let event_id = id.clone(); let event_root = root.clone();
        workers.spawn(async move {
            let registration = app.state::<lifecycle::Gate>().enter()?;
            let result = async {
            let _permit = permits.acquire_owned().await.map_err(|_| "资源检测并发门限不可用")?;
            check(&cancel)?;
            let query = &inventory.items[index].query;
            let key = cache::key(&policy, query);
            let cached = ANSWERS.get_or_init(cache::Cache::default).get(&key)?;
            let detected = match cached {
                Some(value) => value,
                None => {
                    let policy_app = app.clone();
                    let expected_policy = policy.clone();
                    let policy_check: Arc<dyn Fn() -> std::result::Result<(), String> + Send + Sync> = Arc::new(move || {
                        let current = policy_app.state::<Storage>().settings_for_backend()?;
                        if !network_allowed(&current) || cache::policy_key(&current)? != expected_policy { Err(CHANGED.into()) } else { Ok(()) }
                    });
                    let value = crate::catalog::update::detect_guarded(query, &settings, &cancel, policy_check).await?;
                    // HTTP 失败或取消不写负缓存。仅真实完成的官方判定可缓存正/负结果。
                    check(&cancel)?;
                    ANSWERS.get_or_init(cache::Cache::default).insert(key, value.clone())?;
                    value
                }
            };
            verify_context(app.clone(), inventory.clone(), policy, cancel.clone(), Some(index), false).await?;
            let update: Option<UpdateInfo> = detected.as_ref().map(|item| item.info.clone());
            let event = json!({"channel":"resources:update-checked","payload":{
                "versionId": event_id, "path":query.path, "kind":query.kind,
                "update":update, "scopeRoot":event_root
            }});
            Ok::<(Option<DetectedUpdate>, Value), String>((detected, event))
            }.await;
            registration.finish();
            result
        });
    }
    let mut found = Vec::new(); let mut events = Vec::new(); let mut first_error = None;
    while let Some(result) = workers.join_next().await {
        match result {
            Ok(Ok((Some(update), event))) => { found.push(update.info); events.push(event); },
            Ok(Ok((None, event))) => events.push(event),
            Ok(Err(error)) => { if first_error.is_none() { first_error = Some(error); cancel.store(true, Ordering::Release); } },
            Err(_) => { if first_error.is_none() { first_error = Some("资源检测后台任务异常".into()); cancel.store(true, Ordering::Release); } },
        }
    }
    if let Some(error) = first_error { return Err(error); }
    verify_context(app.clone(), inventory, policy, cancel.clone(), None, true).await?;
    // 整批查询和最终证据复核成功后才开始发送逐项事件；事件派发本身仍可能被取消或失败。
    for event in events {
        check(&cancel)?;
        app.emit_to("main", "launcher:event", event).map_err(|_| "资源更新检测事件发送失败")?;
    }
    found.sort_by(|a,b| a.path.cmp(&b.path));
    serde_json::to_value(found).map_err(|_| "资源更新检测结果无法序列化".into())
}

struct Deadline(tokio::task::JoinHandle<()>);
impl Drop for Deadline { fn drop(&mut self) { self.0.abort(); } }

fn retain_check<T, Operation, Work>(scan_guard: ScanGuard, registration: lifecycle::Request, cancel: Arc<AtomicBool>, operation: Operation) -> tokio::task::JoinHandle<Result<T>>
where T: Send + 'static, Operation: FnOnce(Arc<AtomicBool>) -> Work + Send + 'static,
      Work: std::future::Future<Output = Result<T>> + Send + 'static {
    tokio::spawn(async move {
        let deadline_cancel = cancel.clone();
        let _deadline = Deadline(tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(240)).await;
            deadline_cancel.store(true, Ordering::Release);
        }));
        let result = operation(cancel).await;
        scan_guard.finish();
        registration.finish();
        result
    })
}

pub(crate) async fn call(app: &AppHandle, channel: &str, args: &[Value], settings: &Value) -> Result<Option<Value>> {
    if channel == "resources:applyUpdate" { return apply::call(app, args, settings).await.map(Some); }
    if channel != "resources:checkUpdates" { return Ok(None); }
    let id = request_id(args)?;
    // 与 Electron 原策略一致；在任何扫描、登记或联网之前返回空数组。
    if !network_allowed(settings) { return Ok(Some(json!([]))); }
    let root = crate::operation_game_dir(channel, args, settings)?;
    let settings = settings.clone(); let app = app.clone();
    let registration = app.state::<lifecycle::Gate>().enter()?;
    let (scan_guard, cancel) = match ScanGuard::register() {
        Ok(value) => value,
        Err(error) => { registration.finish(); return Err(error); }
    };
    let _cancel_on_drop = CancelOnDrop(cancel.clone());
    let worker = retain_check(scan_guard, registration, cancel, move |cancel| async move {
        let queue = FLIGHTS.get_or_init(|| tokio::sync::Mutex::new(()));
        let _serial = loop {
            check(&cancel)?;
            tokio::select! {
                guard = queue.lock() => break guard,
                _ = tokio::time::sleep(Duration::from_millis(50)) => {}
            }
        };
        run_check(&app, root, id, settings, cancel).await
    });
    worker.await.map_err(|_| "资源更新检测后台任务异常".to_string())?.map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_contract_and_network_policy_are_exact() {
        assert_eq!(request_id(&[json!("example")]).unwrap(), "example");
        for args in [vec![], vec![Value::Null], vec![json!("../bad")], vec![json!("ok"), json!("extra")]] {
            assert!(request_id(&args).is_err());
        }
        assert!(!network_allowed(&json!({"mode":"local"})));
        assert!(!network_allowed(&json!({"metadataOnlyMods":true})));
        assert!(network_allowed(&json!({"mode":"minimal"})));
    }

    #[test]
    fn scan_registry_never_releases_busy_before_real_completion() {
        let state = Arc::new(Mutex::new(ScanState::default()));
        let (guard, cancel) = ScanGuard::register_in(state.clone()).unwrap();
        assert!(ready_from(Some(&state)).is_err());
        cancel.store(true, Ordering::Release);
        assert!(check(&cancel).is_err());
        assert!(ready_from(Some(&state)).is_err());
        assert_eq!(state.lock().unwrap().active.len(), 1);
        guard.finish();
        assert!(ready_from(Some(&state)).is_ok());
        let (abnormal, _) = ScanGuard::register_in(state.clone()).unwrap();
        drop(abnormal);
        assert!(ready_from(Some(&state)).is_err());
        assert!(ScanGuard::register_in(state).is_err());
    }

    #[tokio::test]
    async fn dropped_caller_cancels_but_owned_check_holds_gate_until_real_finish() {
        let gate = lifecycle::Gate::default();
        let registration = gate.enter().unwrap();
        let state = Arc::new(Mutex::new(ScanState::default()));
        let (scan_guard, cancel) = ScanGuard::register_in(state.clone()).unwrap();
        let cancel_on_drop = CancelOnDrop(cancel.clone());
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
        let worker = retain_check(scan_guard, registration, cancel.clone(), move |cancel| async move {
            let _ = started_tx.send(());
            let _ = release_rx.await;
            assert!(cancel.load(Ordering::Acquire));
            let _ = finished_tx.send(());
            Ok(())
        });
        let caller = tokio::spawn(async move {
            let _cancel_on_drop = cancel_on_drop;
            worker.await.unwrap().unwrap();
        });
        started_rx.await.unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        assert!(tokio::time::timeout(Duration::from_millis(20), finished_rx).await.is_err());
        assert!(cancel.load(Ordering::Acquire));
        assert!(ready_from(Some(&state)).is_err());
        assert!(gate.begin_restart().is_err());
        let _ = release_tx.send(());
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Ok(restart) = gate.begin_restart() { drop(restart); break; }
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
        assert!(ready_from(Some(&state)).is_ok());
        gate.enter().unwrap().finish();
    }

    #[test]
    fn bounded_registry_rejects_closed_overloaded_or_poisoned_state() {
        let state = Arc::new(Mutex::new(ScanState::default()));
        let mut active = Vec::new();
        for _ in 0..8 { active.push(ScanGuard::register_in(state.clone()).unwrap().0); }
        assert!(ScanGuard::register_in(state.clone()).is_err());
        for guard in active { guard.finish(); }
        state.lock().unwrap().closed = true;
        assert!(ScanGuard::register_in(state.clone()).is_err());
        let poison = state.clone();
        assert!(std::thread::spawn(move || {
            let _lock = poison.lock().unwrap(); panic!("fixture poison");
        }).join().is_err());
        assert!(ready_from(Some(&state)).is_err());
    }
}


//! 更新应用的 owned 宿主编排。IPC 取消只发信号，文件事务与实际工作线程始终收尾后才释放门禁。
use super::{approval, binding::{ApplyRequest, Selection}, cache, check, control, transaction::{self, Change, NewFile, OldFile, UpdateStage}, Result, ANSWERS, CHANGED};
use crate::{catalog::{self, update::{PlannedChange, PreparedUpdate, VerifiedFile}}, downloads::JobGuard, install_lock::{self, RootOperationGuard}, lifecycle, runtime::{self, ResourceUpdateLease}, storage::Storage};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, path::{Path, PathBuf}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(test)]
mod tests;

type Holder = Arc<Mutex<WriteOwner>>;
struct WriteOwner {
    root: Option<RootOperationGuard>,
    lease: Option<ResourceUpdateLease>,
    job: Option<JobGuard>,
    stage: Option<UpdateStage>,
    pending: bool,
}
impl WriteOwner {
    fn new() -> Self { Self { root: None, lease: None, job: None, stage: None, pending: false } }
    fn settled(&self) -> bool { !self.pending && self.stage.as_ref().map_or(true, UpdateStage::settled) }
    fn stage(&mut self) -> Result<&mut UpdateStage> { self.stage.as_mut().ok_or_else(|| "更新事务尚未建立".into()) }
}
impl Drop for WriteOwner {
    fn drop(&mut self) {
        if std::thread::panicking() || !self.settled() {
            // 未确认现场及持锁者一起保留；不能只留下一个 busy 标志却释放跨进程锁。
            if let Some(value) = self.stage.take() { std::mem::forget(value); }
            if let Some(value) = self.root.take() { value.quarantine(); }
            if let Some(value) = self.lease.take() { value.quarantine(); }
            if let Some(value) = self.job.take() { std::mem::forget(value); }
        }
    }
}
fn owner_lock(owner: &Holder) -> Result<std::sync::MutexGuard<'_, WriteOwner>> { owner.lock().map_err(|_| "资源更新台账状态未确认".into()) }

struct Plan { changes: Vec<Change>, downloads: Vec<(usize, VerifiedFile)>, destination: PathBuf, digest: String }
fn leaf(path: &Path) -> Result<String> {
    let name = path.file_name().and_then(|name| name.to_str()).ok_or("资源文件名不是 UTF-8")?;
    super::access::leaf(name)?;
    Ok(name.into())
}
fn old(selection: &Selection, query: &super::model::LocalQuery) -> Result<OldFile> {
    if query.kind != selection.query().kind || query.path.parent() != Some(selection.directory()?)
        || !selection.inventory.items.iter().any(|item| same_query(&item.query, query)) {
        return Err(CHANGED.into());
    }
    Ok(OldFile { leaf: leaf(&query.path)?, size: query.size, sha512: query.sha512.clone() })
}
fn same_query(left: &super::model::LocalQuery, right: &super::model::LocalQuery) -> bool {
    left.kind == right.kind && left.path == right.path && left.filename == right.filename && left.enabled == right.enabled
        && left.size == right.size && left.sha1 == right.sha1 && left.sha512 == right.sha512 && left.fingerprint == right.fingerprint
        && left.mc_version == right.mc_version && left.loader == right.loader && left.shader_runtimes == right.shader_runtimes
}
fn new_file(selection: &Selection, file: &VerifiedFile, enabled: bool) -> Result<NewFile> {
    let meta = catalog::pack_bound_metadata(&file.download);
    if meta.kind != selection.query().kind.as_str() { return Err("此更新含跨资源类型依赖，尚不能由单目录事务应用；未更改文件".into()); }
    let name = if meta.kind == "mod" && !enabled { format!("{}.disabled", meta.filename) } else { meta.filename };
    super::access::leaf(&name)?;
    Ok(NewFile { leaf: name, size: meta.size, sha1: meta.sha1, sha512: meta.sha512 })
}
fn plan(selection: &Selection, prepared: &PreparedUpdate, task: &str) -> Result<Plan> {
    if prepared.requested != selection.request.update || prepared.changes.is_empty() || prepared.changes.len() > 32 { return Err(CHANGED.into()); }
    let mut changes = Vec::new(); let mut downloads = Vec::new(); let mut identities = Vec::new(); let mut names = BTreeSet::new();
    for (index, change) in prepared.changes.iter().enumerate() {
        let (change, identity) = match change {
            PlannedChange::Replace { old: query, file } => {
                if index == 0 && !same_query(query, selection.query()) { return Err(CHANGED.into()); }
                let old = old(selection, query)?; let new = new_file(selection, file, query.enabled)?;
                downloads.push((index, file.clone()));
                (Change::Replace { old, new }, json!({"source":file.source,"project":file.project_id,"version":file.version_id,"title":file.title,"label":file.version}))
            }
            PlannedChange::Install { file } => {
                if index == 0 { return Err(CHANGED.into()); }
                let new = new_file(selection, file, true)?; downloads.push((index, file.clone()));
                (Change::Install { new }, json!({"source":file.source,"project":file.project_id,"version":file.version_id,"title":file.title,"label":file.version}))
            }
            PlannedChange::Enable { old: query } => {
                if index == 0 || query.enabled || !leaf(&query.path)?.ends_with(".disabled") { return Err(CHANGED.into()); }
                let old = old(selection, query)?; let target_leaf = query.filename.clone(); super::access::leaf(&target_leaf)?;
                (Change::Enable { old, target_leaf }, json!({"source":"local","sha1":query.sha1,"sha512":query.sha512,"mc":query.mc_version,"loader":query.loader}))
            }
        };
        let target = match &change { Change::Replace { new, .. } | Change::Install { new } => &new.leaf, Change::Enable { target_leaf, .. } => target_leaf };
        if !names.insert(target.to_lowercase()) { return Err("更新计划含重复目标文件".into()); }
        changes.push(change); identities.push(identity);
    }
    let destination = match &changes[0] { Change::Replace { new, .. } => selection.directory()?.join(&new.leaf), _ => return Err(CHANGED.into()) };
    let bytes = serde_json::to_vec(&json!({"task":task,"root":selection.root(),"directory":selection.directory()?,"policy":selection.policy(),
        "requested":prepared.requested,"changes":changes,"identities":identities})).map_err(|_| "无法绑定更新计划")?;
    Ok(Plan { changes, downloads, destination, digest: format!("{:x}", Sha256::digest(bytes)) })
}
fn emit(app: &AppHandle, task: &str, title: &str, phase: &str, current: u64, total: u64, success: bool) {
    let percent = if success { 100.0 } else if total != 0 { ((current as f64 / total as f64) * 95.0).min(99.0) } else { 0.0 };
    let _ = app.emit_to("main", "launcher:event", json!({"channel":"download:progress","payload":{
        "taskId":task,"jobTitle":title,"task":title,"phase":phase,"current":0,"total":1,
        "currentBytes":current,"totalBytes":total,"percent":percent,"speed":0}}));
}
fn verify_policy(app: &AppHandle, selection: &Selection, cancel: &AtomicBool) -> Result<()> {
    check(cancel)?;
    let settings = app.state::<Storage>().settings_for_backend()?;
    if !super::network_allowed(&settings) || cache::policy_key(&settings)? != selection.policy()
        || crate::operation_game_dir("resources:applyUpdate", &[], &settings)? != selection.root() {
        return Err(CHANGED.into());
    }
    // 监视器只检查设置；提交期间自身移动文件会改变成员集合，不能因此撤销已经批准的固定事务。
    check(cancel)
}
async fn stage_work<T, Operation>(_app: &AppHandle, operation: Operation) -> Result<T>
where T: Send + 'static, Operation: FnOnce() -> Result<T> + Send + 'static {
    // 外层 owned worker 已持有 Request；关闭后仍必须允许已登记事务完成 cleanup。
    tokio::task::spawn_blocking(operation).await.map_err(|_| "资源更新工作线程异常，收尾状态未确认".to_owned())?
}

async fn run(app: &AppHandle, request: ApplyRequest, root: PathBuf, cancel: Arc<AtomicBool>, task: &str, owner: &Holder) -> Result<String> {
    check(&cancel)?;
    let guard = install_lock::acquire(&root, || cancel.load(Ordering::Acquire)).await?;
    let settings = app.state::<Storage>().settings_for_backend()?;
    let scan_cancel = cancel.clone(); let scan_root = root.clone();
    let selection = stage_work(app, move || {
        let _guard = guard;
        Selection::scan(&scan_root, request, &settings, &scan_cancel).map(Arc::new)
    }).await?;
    let policy_app = app.clone(); let policy_selection = selection.clone(); let policy_cancel = cancel.clone();
    let policy: Arc<dyn Fn() -> Result<()> + Send + Sync> = Arc::new(move || verify_policy(&policy_app, &policy_selection, &policy_cancel));
    let settings = app.state::<Storage>().settings_for_backend()?;
    let prepared = catalog::update::prepare_apply_guarded(selection.query(), &selection.request.update, &selection.installed(), &settings, &cancel, policy.clone()).await?;
    let plan = plan(&selection, &prepared, task)?;
    let approved = approval::approve(app, &prepared, &plan.digest, cancel.clone()).await?;
    policy()?;
    let guard = install_lock::acquire(&root, || cancel.load(Ordering::Acquire)).await?;
    { let mut holder = owner_lock(owner)?; holder.root = Some(guard); holder.lease = Some(runtime::acquire_resource_update_lease()?); holder.job = Some(JobGuard::register(&root, task)?); }
    let init_owner = owner.clone(); let init_selection = selection.clone(); let init_cancel = cancel.clone(); let init_app = app.clone(); let changes = plan.changes.clone();
    stage_work(app, move || {
        let current = init_app.state::<Storage>().settings_for_backend()?;
        init_selection.verify(&current, &init_cancel)?;
        let mut holder = owner_lock(&init_owner)?;
        // create 可能在建立 journal 后异常；先登记不确定性，再由正常返回明确清除。
        holder.pending = true;
        match UpdateStage::create(init_selection.root(), init_selection.directory()?, changes, &init_cancel) {
            Ok(stage) => { holder.stage = Some(stage); holder.pending = true; Ok(()) }
            Err(error) => { holder.pending = transaction::pending_under_guard(init_selection.root()).unwrap_or(true); Err(error) }
        }
    }).await?;
    let job_cancel = owner_lock(owner)?.job.as_ref().ok_or("下载登记丢失")?.cancel();
    let watch_cancel = cancel.clone(); let watch_download = job_cancel.clone(); let watch_policy = policy.clone();
    let watcher = tokio::spawn(async move {
        loop {
            if watch_cancel.load(Ordering::Acquire) || watch_policy().is_err() { watch_cancel.store(true, Ordering::Release); watch_download.stop(); return; }
            if watch_download.check().is_err() { watch_cancel.store(true, Ordering::Release); return; }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    });
    let _watcher = super::Deadline(watcher);
    let total = plan.downloads.iter().map(|(_, file)| catalog::pack_bound_metadata(&file.download).size).sum::<u64>();
    let mut completed = 0u64;
    for (index, file) in &plan.downloads {
        policy()?;
        let take_owner = owner.clone(); let index = *index;
        let output = stage_work(app, move || owner_lock(&take_owner)?.stage()?.take_file(index)).await?;
        let progress_app = app.clone(); let progress_task = task.to_owned(); let title = prepared.requested.title.clone(); let previous = completed;
        let progress = Arc::new(move |bytes, _| emit(&progress_app, &progress_task, &title, "download", previous + bytes, total, false));
        let received = catalog::write_export_download(file.download.clone(), output, job_cancel.clone(), progress).await?;
        completed = completed.checked_add(received).ok_or("更新下载字节总数溢出")?;
        let seal_owner = owner.clone(); let seal_cancel = cancel.clone();
        stage_work(app, move || owner_lock(&seal_owner)?.stage()?.seal(index, &seal_cancel)).await?;
    }
    policy()?;
    let commit_owner = owner.clone(); let commit_selection = selection.clone(); let commit_cancel = cancel.clone(); let commit_app = app.clone(); let digest = plan.digest.clone();
    stage_work(app, move || {
        let current = commit_app.state::<Storage>().settings_for_backend()?;
        commit_selection.verify(&current, &commit_cancel)?;
        commit_app.state::<Storage>().with_settings_for_backend(|settings| {
            commit_selection.verify_context(settings, &commit_cancel)?;
            approved.consume(&digest, &commit_cancel)
        })??;
        // 固定计划与 held-parent 事务不再读取可切换的设置，不长时间持有 Storage 锁。
        owner_lock(&commit_owner)?.stage()?.commit(&commit_cancel)
    }).await?;
    Ok(plan.destination.to_string_lossy().into_owned())
}

async fn finish(app: &AppHandle, owner: &Holder) -> Result<()> {
    let cleanup_owner = owner.clone();
    stage_work(app, move || {
        let mut holder = owner_lock(&cleanup_owner)?;
        if let Some(stage) = holder.stage.as_mut() { stage.cleanup()?; let pending = !stage.settled(); holder.pending = pending; }
        else if holder.pending { return Err("更新初始化留下未确认现场，保持目录占用".into()); }
        if !holder.settled() { return Err("更新收尾未确认，保持目录占用".into()); }
        Ok(())
    }).await
}

pub(super) async fn call(app: &AppHandle, args: &[Value], settings: &Value) -> Result<Value> {
    let request = ApplyRequest::parse(args)?;
    if !super::network_allowed(settings) { return Err("当前模式不允许下载更新 / 目前模式不允許下載更新 / Current mode does not allow updates".into()); }
    let root = crate::operation_game_dir("resources:applyUpdate", args, settings)?;
    let task = format!("resource-update:{}", uuid::Uuid::new_v4());
    let mut scope = root.to_string_lossy().replace('\\', "/"); if cfg!(windows) { scope = scope.to_lowercase(); }
    let gate = app.state::<lifecycle::Gate>().enter()?;
    let registered = match super::UPDATES.get_or_init(control::Registry::default).begin(&task, &scope) {
        Ok(value) => value, Err(error) => { gate.finish(); return Err(error); }
    };
    let cancel = registered.cancel(); let _cancel_on_drop = super::CancelOnDrop(cancel.clone()); let app = app.clone();
    let worker = tokio::spawn(async move {
        let owner = Arc::new(Mutex::new(WriteOwner::new()));
        emit(&app, &task, &request.update.title, "prepare", 0, 0, false);
        let result = run(&app, request, root, cancel, &task, &owner).await;
        let cleanup = finish(&app, &owner).await;
        // 成功与失败都清理检测缓存；UI 也必须重新加载，不能把旧计划当作重试授权。
        let invalidated = ANSWERS.get_or_init(cache::Cache::default).clear();
        let result = match (result, cleanup, invalidated) {
            (Ok(path), Ok(()), Ok(())) => Ok(path),
            (Err(error), Ok(()), Ok(())) => Err(error),
            (original, cleanup, invalidated) => Err(format!("{}；{}", original.err().unwrap_or_else(|| "更新文件可能已提交".into()),
                cleanup.err().or_else(|| invalidated.err()).unwrap_or_else(|| "更新收尾状态未确认".into()))),
        };
        let settled = owner.lock().map(|holder| holder.settled()).unwrap_or(false);
        if settled {
            if let Ok(holder) = owner.lock() { if let Some(job) = &holder.job { job.complete(result.as_ref().map(|_| ()).map_err(Clone::clone)); } }
            drop(owner);
            emit(&app, &task, if result.is_ok() { "完成" } else { "更新未完成" }, "done", 0, 0, result.is_ok());
            registered.finish(); gate.finish();
        }
        result.map(Value::String)
    });
    worker.await.map_err(|_| "资源更新后台任务异常，收尾状态未确认".to_owned())?
}

//! 本地与 URL 整合包导入：一个 owned supervisor 持有来源、根锁和实例台账直到实际收尾。
//! IPC 等待方被丢弃只发取消信号；未知状态留在注册表，不能用 Drop 冒充清理。
use super::{access::{leaf, Directory}, import_source::Source, install_stage::{GeneratedReceipt, Stage}, materialize, plan::{self, ApplyPhase, FullPackPlan}, remote, Result};
use crate::{downloads::{self, Cancel, JobGuard, Progress}, install_lock::RootOperationGuard};
use serde_json::{json, Value};
use std::{collections::BTreeMap, future::Future, path::{Path, PathBuf}, sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, Ordering}}};
use tauri::{AppHandle, Emitter};

mod input;
use input::Input;

const JSON_CAP: usize = 4 * 1024 * 1024;
type Holder = Arc<Mutex<Option<Stage>>>;
type Sink = Arc<dyn Fn(Value) + Send + Sync>;

#[derive(Default)]
struct Gate { attempted: bool, committed: bool, sticky: bool }
struct Operation {
    cancel: Arc<Cancel>,
    job_cancel: Mutex<Option<Arc<Cancel>>>,
    gate: Mutex<Gate>,
}
impl Operation {
    fn new() -> Self { Self { cancel: Arc::new(Cancel::default()), job_cancel: Mutex::new(None), gate: Mutex::new(Gate::default()) } }
    fn signal(&self) {
        self.cancel.stop();
        if let Ok(token) = self.job_cancel.lock() { if let Some(token) = &*token { token.stop(); } }
    }
    fn attach(&self, token: Arc<Cancel>) -> Result<()> {
        let mut slot = self.job_cancel.lock().map_err(|_| "整合包取消状态不可用")?;
        if self.cancel.check().is_err() { token.stop(); }
        *slot = Some(token);
        Ok(())
    }
    fn token(&self) -> Result<Arc<Cancel>> {
        Ok(self.job_cancel.lock().map_err(|_| "整合包取消状态不可用")?.clone().unwrap_or_else(|| self.cancel.clone()))
    }
    fn check(&self) -> Result<()> { self.cancel.check()?; self.token()?.check() }
    fn request_cancel(&self) -> Result<()> {
        match self.gate.try_lock() {
            Ok(gate) => {
                if gate.committed { return Err("实例已发布，取消不能撤销导入".into()); }
                self.signal();
                if gate.attempted || gate.sticky { Err("导入提交或收尾状态未确认，已发送停止信号但不能保证撤销".into()) } else { Ok(()) }
            }
            Err(std::sync::TryLockError::WouldBlock) => { self.signal(); Err("实例正在提交，取消不能保证撤销".into()) }
            Err(std::sync::TryLockError::Poisoned(_)) => { self.signal(); Err("导入提交状态未知，已发送停止信号".into()) }
        }
    }
}

/// 即使某个 child panic，注册表仍持有这份台账，不会随 JoinError 释放根锁。
struct Ledger {
    source: Mutex<Option<Arc<Input>>>,
    stage: Holder,
    root: Mutex<Option<RootOperationGuard>>,
    job: Mutex<Option<JobGuard>>,
    anchor: Mutex<Option<Arc<Directory>>>,
    remote: remote::Session,
    generated: Mutex<Option<downloads::InstanceBuild>>,
    unknown: AtomicBool,
    published: AtomicBool,
}
impl Ledger {
    fn new() -> Self { Self { source: Mutex::new(None), stage: Arc::new(Mutex::new(None)), root: Mutex::new(None), job: Mutex::new(None), anchor: Mutex::new(None), remote: remote::Session::new(), generated: Mutex::new(None), unknown: AtomicBool::new(false), published: AtomicBool::new(false) } }
    fn source(&self) -> Result<Arc<Input>> { self.source.lock().map_err(|_| "导入来源台账不可用")?.clone().ok_or_else(|| "导入来源尚未建立".into()) }
    fn stage_path(&self) -> Result<PathBuf> { Ok(self.stage.lock().map_err(|_| "实例台账不可用")?.as_ref().ok_or("实例暂存尚未建立")?.path().to_path_buf()) }
    fn verify_root(&self) -> Result<()> { self.anchor.lock().map_err(|_| "导入根目录台账不可用")?.as_ref().ok_or("导入根目录未登记")?.verify() }
}
struct Entry { task: String, target: Option<String>, operation: Arc<Operation>, _ledger: Arc<Ledger> }
#[derive(Default)]
struct Window { closed: bool, entries: BTreeMap<String, Entry> }
static WINDOW: OnceLock<Mutex<Window>> = OnceLock::new();
fn window() -> &'static Mutex<Window> { WINDOW.get_or_init(|| Mutex::new(Window::default())) }
fn register(operation: Arc<Operation>, ledger: Arc<Ledger>) -> Result<String> {
    let mut state = window().lock().map_err(|_| "整合包窗口登记不可用")?;
    if state.closed { return Err("主窗口已关闭，不能建立导入任务".into()); }
    if state.entries.len() >= 128 { return Err("整合包导入任务超过上限".into()); }
    let key = uuid::Uuid::new_v4().to_string();
    state.entries.insert(key.clone(), Entry { task: format!("modpack-import:{key}"), target: None, operation, _ledger: ledger });
    Ok(key)
}
fn set_target(key: &str, target: &str) -> Result<()> {
    let mut state = window().lock().map_err(|_| "整合包窗口登记不可用")?;
    if state.closed { return Err("主窗口已关闭，导入已取消".into()); }
    let entry = state.entries.get_mut(key).ok_or("整合包导入登记丢失")?;
    entry.target = Some(target.into()); Ok(())
}
pub(super) fn cancel_for_window() {
    if let Ok(mut state) = window().lock() { state.closed = true; for entry in state.entries.values() { entry.operation.signal(); } }
}
pub(super) fn cancel_download(id: Option<&str>) -> Result<()> {
    let state = window().lock().map_err(|_| "整合包导入登记不可用")?;
    let mut errors = Vec::new();
    for entry in state.entries.values() {
        if id.map_or(true, |id| id == entry.task || entry.target.as_deref() == Some(id)) {
            if let Err(error) = entry.operation.request_cancel() { errors.push(error); }
        }
    }
    if errors.is_empty() { Ok(()) } else { Err(errors.join("；")) }
}

pub(super) fn relaunch_ready() -> Result<()> {
    let state = match window().try_lock() {
        Ok(state) => state,
        Err(std::sync::TryLockError::WouldBlock) => return Err("整合包导入状态正忙，无法确认可以重启".into()),
        Err(std::sync::TryLockError::Poisoned(_)) => return Err("整合包导入状态未知，无法确认可以重启".into()),
    };
    for entry in state.entries.values() {
        if entry._ledger.unknown.load(Ordering::Acquire) {
            return Err("整合包导入收尾状态未知，目录保持忙碌，无法重启".into());
        }
        let gate = match entry.operation.gate.try_lock() {
            Ok(gate) => gate,
            Err(std::sync::TryLockError::WouldBlock) => return Err("整合包导入提交状态正忙，无法确认可以重启".into()),
            Err(std::sync::TryLockError::Poisoned(_)) => return Err("整合包导入提交状态未知，无法确认可以重启".into()),
        };
        if gate.sticky {
            return Err("整合包导入收尾状态未知，目录保持忙碌，无法重启".into());
        }
        return Err("整合包导入仍在进行或收尾，无法重启".into());
    }
    Ok(())
}

struct Waiting { operation: Arc<Operation>, armed: bool }
impl Drop for Waiting { fn drop(&mut self) { if self.armed { self.operation.signal(); } } }

fn allowed(settings: &Value) -> Result<()> {
    if settings.get("mode").and_then(Value::as_str) == Some("local") { return Err("本地模式暂不执行整合包安装；未创建导入任务或发起网络请求".into()); }
    if settings.get("metadataOnlyMods").and_then(Value::as_bool) == Some(true) { return Err("仅元数据模式禁止安装整合包成员；未创建导入任务".into()); }
    Ok(())
}
fn validate_plan(plan: &FullPackPlan) -> Result<()> {
    leaf(&plan.target_id)?; downloads::identifier(&plan.target_id)?; downloads::identifier(&plan.mc_version)?;
    if plan.target_id == plan.mc_version { return Err("整包实例 ID 不能占用基础 Minecraft ID，请指定独立名称".into()); }
    if let Some(loader) = &plan.loader {
        if !matches!(loader.kind.as_str(), "fabric" | "quilt" | "forge" | "neoforge") { return Err("整合包加载器不受支持".into()); }
        downloads::identifier(&loader.version)?;
        if loader.version == "*" || loader.version.eq_ignore_ascii_case("latest") { return Err("整合包必须声明精确加载器版本，不能替换为最新版".into()); }
        if cfg!(any(target_os = "android", target_os = "ios")) && matches!(loader.kind.as_str(), "forge" | "neoforge") { return Err("移动平台不能执行 Forge/NeoForge 安装器，未下载依赖".into()); }
    }
    Ok(())
}
fn reporter(app: &AppHandle) -> Sink {
    let app = app.clone();
    Arc::new(move |payload| { for channel in ["modpack:progress", "download:progress"] { let _ = app.emit_to("main", "launcher:event", json!({"channel": channel, "payload": payload})); } })
}
fn status(sink: &Sink, task: &str, target: &str, name: &str, done: Option<bool>) {
    (sink)(json!({"taskId":task,"jobTitle":format!("导入整合包 {target}"),"task":name,"current":0,"total":0,"currentBytes":0,"totalBytes":0,"phase":if done.is_some(){"done"}else{"mod"},"percent":if done==Some(true){100.0}else{0.0},"speed":0}));
}
async fn blocking<T: Send + 'static>(ledger: &Arc<Ledger>, work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    match tokio::task::spawn_blocking(work).await {
        Ok(result) => result,
        Err(_) => { ledger.unknown.store(true, Ordering::Release); Err("导入阻塞任务异常，后台状态未确认".into()) }
    }
}

enum Request { Existing(String), Url { url: String, filename: String } }

fn check_request(request: &Request, custom_name: Option<&str>, settings: &Value) -> Result<Option<String>> {
    allowed(settings)?;
    match request {
        Request::Existing(value) => {
            if value.is_empty() || value.len() > 32768 || value.chars().any(char::is_control) { return Err("导入来源参数无效".into()); }
        }
        Request::Url { url, filename } => {
            super::network::validate_url(url).map_err(|_| "整合包来源地址无效或不受支持")?;
            leaf(filename).map_err(|_| "整合包归档文件名无效")?;
        }
    }
    let custom = custom_name.map(str::trim).filter(|name| !name.is_empty()).map(str::to_owned);
    if let Some(name) = &custom { leaf(name)?; }
    Ok(custom)
}

/// 不透传来源地址或下载器的任务文本；来源下载不能提前发导入完成事件。
fn source_reporter(sink: Sink, task: String, title: String) -> Sink {
    Arc::new(move |payload| {
        let number = |key: &str| payload.get(key).filter(|value| value.is_number()).cloned().unwrap_or(json!(0));
        let percent = payload.get("percent").and_then(Value::as_f64).filter(|value| value.is_finite()).unwrap_or(0.0).clamp(0.0, 99.9);
        (sink)(json!({"taskId":task,"jobTitle":format!("导入整合包 {title}"),"task":"下载整合包来源","phase":"mod","percent":percent,"current":number("current"),"total":number("total"),"currentBytes":number("currentBytes"),"totalBytes":number("totalBytes"),"speed":number("speed")}));
    })
}

/// 同一个 poll 内同步入账；失败才把来源交给显式 finish，不随锁错误丢弃租约。
fn record_source(ledger: &Arc<Ledger>, input: Input) -> Option<Arc<Input>> {
    let source = Arc::new(input);
    let stored = match ledger.source.lock() {
        Ok(mut slot) if slot.is_none() => { *slot = Some(source.clone()); true }
        _ => false,
    };
    if stored { None } else { Some(source) }
}
async fn finish_rejected_source(ledger: &Arc<Ledger>, rejected: Option<Arc<Input>>) -> Result<()> {
    if let Some(source) = rejected {
        return match source.finish().await {
            Ok(()) => Err("导入来源登记失败，来源已显式关闭".into()),
            Err(_) => { ledger.unknown.store(true, Ordering::Release); Err("导入来源登记失败且收尾状态未知".into()) }
        };
    }
    Ok(())
}

/// 成功 Claim 必须在首次挂起前同步包装并入账；生产和串联夹具都走这一交接。
async fn record_url_result(ledger: &Arc<Ledger>, operation: &Arc<Operation>, result: Result<super::download::ArchiveClaim>) -> Result<()> {
    let input = match result {
        Ok(claim) => Input::controlled(Source::from_claim(claim)),
        Err(error) => {
            if error.contains("未知") || error.contains("未确认") || error.contains("异常") || error.contains("仍保留") {
                ledger.unknown.store(true, Ordering::Release);
                return Err("整合包来源下载未完成，后台收尾状态未知".into());
            }
            return Err(if operation.check().is_err() { "整合包来源下载已取消" } else { "整合包来源下载失败，请检查网络后重试" }.into());
        }
    };
    let rejected = record_source(ledger, input);
    finish_rejected_source(ledger, rejected).await
}
async fn open_source(app: AppHandle, request: Request, operation: Arc<Operation>, ledger: Arc<Ledger>, sink: Sink) -> Result<()> {
    match request {
        Request::Existing(value) => {
            let input = Input::controlled(Source::open(&app, &value).await?);
            let rejected = record_source(&ledger, input);
            finish_rejected_source(&ledger, rejected).await
        }
        Request::Url { url, filename } => {
            let result = super::download::claim_from_url(&app, &url, &filename, operation.cancel.clone(), sink).await;
            record_url_result(&ledger, &operation, result).await
        }
    }
}

/// picker、已有能力与 URL 共用此调度器；测试只替换来源打开，不替换生产编排或收尾。
async fn start_with_opener<F, Fut>(root: &Path, request: Request, custom_name: Option<&str>, settings: &Value, sink: Sink, opener: F) -> Result<Value>
where F: FnOnce(Request, Arc<Operation>, Arc<Ledger>, Sink) -> Fut + Send + 'static,
      Fut: Future<Output = Result<()>> + Send + 'static {
    let custom = check_request(&request, custom_name, settings)?;
    let title = custom.clone().unwrap_or_else(|| match &request {
        Request::Existing(_) => "本地整合包".into(), Request::Url { filename, .. } => filename.clone(),
    });
    let operation = Arc::new(Operation::new()); let ledger = Arc::new(Ledger::new());
    let key = register(operation.clone(), ledger.clone())?;
    let source_sink = source_reporter(sink.clone(), format!("modpack-import:{key}"), title);
    let mut waiting = Waiting { operation: operation.clone(), armed: true };
    let root = root.to_path_buf(); let settings = settings.clone();
    let supervisor = tokio::spawn(async move {
        let child_ledger = ledger.clone(); let child_operation = operation.clone(); let child_key = key.clone(); let child_sink = sink.clone();
        let child = tokio::spawn(async move {
            child_operation.check()?;
            opener(request, child_operation.clone(), child_ledger.clone(), source_sink).await?;
            child_operation.check()?;
            run(&root, custom, &settings, &child_key, &child_operation, &child_ledger, &child_sink).await
        });
        supervise(child, key, operation, ledger, sink).await
    });
    let result = supervisor.await.map_err(|_| "导入 supervisor 异常，状态未确认且登记仍保留".to_owned())?;
    waiting.armed = false;
    result
}

/// 已授权 picker 或已存在下载能力的本地入口。
pub(super) async fn start(app: &AppHandle, root: &Path, value: &str, custom_name: Option<&str>, settings: &Value) -> Result<Value> {
    let app = app.clone();
    start_with_opener(root, Request::Existing(value.into()), custom_name, settings, reporter(&app), move |request, operation, ledger, sink| open_source(app, request, operation, ledger, sink)).await
}
/// URL 来源直接取得独占 Claim，复用唯一 supervisor；不调用公共 download/start。
pub(super) async fn start_from_url(app: &AppHandle, root: &Path, url: &str, filename: &str, custom_name: Option<&str>, settings: &Value) -> Result<Value> {
    let app = app.clone();
    start_with_opener(root, Request::Url { url: url.into(), filename: filename.into() }, custom_name, settings, reporter(&app), move |request, operation, ledger, sink| open_source(app, request, operation, ledger, sink)).await
}

async fn supervise(child: tokio::task::JoinHandle<Result<Value>>, key: String, operation: Arc<Operation>, ledger: Arc<Ledger>, sink: Sink) -> Result<Value> {
    let mut result = match child.await { Ok(result) => result, Err(_) => { ledger.unknown.store(true, Ordering::Release); Err("导入 worker 异常，状态未确认".into()) } };
    let cleanup = cleanup(&ledger).await;
    if let Err(error) = cleanup { result = Err(format!("{}；{error}", result.err().unwrap_or_else(|| "实例已发布".into()))); }
    if ledger.unknown.load(Ordering::Acquire) {
        if let Ok(mut gate) = operation.gate.lock() { gate.sticky = true; }
        if let Ok(job) = ledger.job.lock() { if let Some(job) = &*job { job.complete(Err(result.as_ref().err().cloned().unwrap_or_else(|| "导入收尾未确认".into()))); } }
        result = Err(format!("{}；收尾未确认，目录保持忙碌", result.err().unwrap_or_else(|| "实例已发布".into())));
    } else {
        if let Ok(mut job) = ledger.job.lock() { if let Some(job) = job.take() { job.complete(result.as_ref().map(|_| ()).map_err(Clone::clone)); drop(job); } }
        if let Ok(mut guard) = ledger.root.lock() { guard.take(); }
        if let Ok(mut anchor) = ledger.anchor.lock() { anchor.take(); }
        if let Ok(mut state) = window().lock() { state.entries.remove(&key); }
    }
    status(&sink, &format!("modpack-import:{key}"), "", if result.is_ok() { "整合包导入完成" } else { "整合包导入中断" }, Some(result.is_ok()));
    result
}

// 来源读取只传回普通 plan 或 ()；所有有副作用的台账始终在 ledger 中。
async fn run(root: &Path, custom: Option<String>, settings: &Value, key: &str, operation: &Arc<Operation>, ledger: &Arc<Ledger>, sink: &Sink) -> Result<Value> {
    let source = ledger.source()?;
    let planned_custom = custom.clone();
    let plan = source.read(operation.cancel.clone(), move |file, name, cancel| {
        cancel.check()?; plan::plan(file, name, planned_custom.as_deref())
    }).await?;
    validate_plan(&plan)?; allowed(settings)?; operation.check()?;
    set_target(key, &plan.target_id)?;
    let root_path = root.to_path_buf(); let book = ledger.clone();
    let root = blocking(ledger, move || {
        let anchor = Arc::new(Directory::open(&root_path)?); anchor.verify()?;
        let path = anchor.path().to_path_buf();
        *book.anchor.lock().map_err(|_| "根目录台账不可用")? = Some(anchor);
        Ok(path)
    }).await?;
    let job = JobGuard::register(&root, &plan.target_id)?;
    let token = job.cancel();
    *ledger.job.lock().map_err(|_| "安装任务台账不可用")? = Some(job);
    operation.attach(token.clone())?;
    let guard = linked(operation, &source, crate::install_lock::acquire(&root, || operation.check().is_err())).await?;
    *ledger.root.lock().map_err(|_| "根锁台账不可用")? = Some(guard);
    ledger.verify_root()?; operation.check()?; source.check(&token)?;
    let book = ledger.clone(); let create_root = root.clone(); let target = plan.target_id.clone(); let c = token.clone();
    blocking(ledger, move || create_stage(&book, &create_root, &target, &c)).await?;
    let task = format!("modpack-import:{key}");
    let progress = Progress::new(task.clone(), format!("导入整合包 {}", plan.name), sink.clone());
    status(sink, &task, &plan.target_id, "构建基础版本与精确加载器", None);
    let profile = if let Some(loader) = &plan.loader {
        if matches!(loader.kind.as_str(), "fabric" | "quilt") {
            linked(operation, &source, crate::loaders::compose_profile_under_guard(&loader.kind, &plan.mc_version, &loader.version, &plan.target_id, &root, settings, &token)).await?
        } else {
            let log_sink = sink.clone(); let log_task = task.clone(); let log_title = plan.name.clone();
            let log = Arc::new(move |_line: String| { status(&log_sink, &log_task, &log_title, "正在运行加载器安装器", None); });
            linked(operation, &source, crate::forge::build_profile_under_guard(&loader.kind, &plan.mc_version, &loader.version, &plan.target_id, &root, settings, token.clone(), &progress, log)).await?
        }
    } else {
        let mut base = linked(operation, &source, downloads::resolve_version_under_guard(&plan.mc_version, &root, settings, &token)).await?;
        base["id"] = json!(plan.target_id); base["clientVersion"] = json!(plan.mc_version); base["jar"] = json!(plan.mc_version); base
    };
    let staging = ledger.stage_path()?;
    let profile = build_and_register(ledger, operation, &source, downloads::build_instance_with_files_under_guard(profile, &root, &staging, settings, token.clone(), &progress)).await?;
    status(sink, &task, &plan.target_id, "绑定并安装整合包成员", None);
    let prepared = linked(operation, &source, remote::prepare(&plan, settings, token.clone())).await?;
    let cache = downloads::inside_path(&root, ".hcmcl-cache/modpack-members")?;
    for (index, member) in prepared.iter().enumerate() {
        let event_sink = sink.clone(); let event_task = task.clone(); let title = plan.name.clone(); let total = prepared.len();
        let member_progress = Arc::new(move |bytes: u64, size: Option<u64>| { (event_sink)(json!({"taskId":event_task,"jobTitle":format!("导入整合包 {title}"),"task":"安装整合包成员","current":index,"total":total,"currentBytes":bytes,"totalBytes":size.unwrap_or(0),"phase":"mod","percent":0.0,"speed":0})); });
        linked(operation, &source, ledger.remote.apply(member, &cache, ledger.stage.clone(), token.clone(), member_progress)).await?;
    }
    for phase in [ApplyPhase::Overrides, ApplyPhase::ClientOverrides] {
        operation.check()?;
        let expected = plan.clone(); let holder = ledger.stage.clone(); let custom = custom.clone();
        source.read(token.clone(), move |file, name, cancel| {
            let mut stage = holder.lock().map_err(|_| "实例台账不可用")?;
            materialize::apply(file, name, custom.as_deref(), &expected, phase, stage.as_mut().ok_or("实例暂存丢失")?, cancel)
        }).await?;
    }
    let book = ledger.clone(); let op = operation.clone(); let c = token.clone(); let target = plan.target_id.clone(); let name = plan.name.clone();
    blocking(ledger, move || {
        op.check()?; book.verify_root()?; downloads::reject_profile_path(&profile, &staging)?;
        if profile.get("id").and_then(Value::as_str) != Some(target.as_str()) || profile.get("clientVersion").and_then(Value::as_str) != profile.get("jar").and_then(Value::as_str) { return Err("整包 profile 与目标不一致".into()); }
        let bytes = serde_json::to_vec_pretty(&profile).map_err(|_| "版本配置序列化失败")?;
        if bytes.len() > JSON_CAP { return Err("版本配置超过 4 MiB".into()); }
        let marker = serde_json::to_vec(&json!({"isolation":true,"name":name})).map_err(|_| "实例隔离标记序列化失败")?;
        let mut slot = book.stage.lock().map_err(|_| "实例台账不可用")?; let stage = slot.as_mut().ok_or("实例暂存丢失")?;
        stage.host_write(&format!("{target}.json"), bytes.as_slice(), bytes.len() as u64, false, &c)?;
        stage.host_write("instance.json", marker.as_slice(), marker.len() as u64, false, &c)?;
        Ok(())
    }).await?;
    let book = ledger.clone(); let op = operation.clone(); let commit_source = source.clone();
    blocking(ledger, move || commit(&book, &op, &commit_source)).await?;
    Ok(json!({"versionId":plan.target_id,"name":plan.name}))
}

/// Stage::create 当前没有部分创建回执；短创建完成并入账后才响应并发取消。
/// 任意不能证明无残留的建立错误都保留根锁，不能把没有返回 Stage 当作没有副作用。
fn create_stage(ledger: &Arc<Ledger>, root: &Path, target: &str, cancel: &Cancel) -> Result<()> {
    cancel.check()?; ledger.verify_root()?;
    let mut slot = ledger.stage.lock().map_err(|_| "实例台账不可用")?;
    if slot.is_some() { return Err("实例暂存已建立".into()); }
    match Stage::create(root, target, &Cancel::default()) {
        Ok(stage) => { *slot = Some(stage); cancel.check() }
        Err(error) => {
            if !error.starts_with("整合包实例目标已存在") { ledger.unknown.store(true, Ordering::Release); }
            Err(error)
        }
    }
}

/// 等待真实结果并单独携带延后取消；有副作用的成功回执不能被后验检查丢弃。
async fn linked_join<T>(operation: &Arc<Operation>, source: &Arc<Input>, future: impl Future<Output = Result<T>>) -> Result<(Result<T>, Option<String>)> {
    let token = operation.token()?; operation.check()?; source.check(&token)?;
    tokio::pin!(future);
    let mut error = None;
    let result = loop {
        tokio::select! {
            result = &mut future => break result,
            _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => {
                if error.is_none() {
                    if let Err(reason) = operation.check().and_then(|_| source.check(&token)) { operation.signal(); error = Some(reason); }
                }
            }
        }
    };
    Ok((result, error))
}

/// 成功 build 必须先交接实际返回的清单，再响应取消或来源撤销。
/// 生成器内部失败不产生回执；未知输出仍由严格 cleanup 拒绝并保留现场。
async fn build_and_register(ledger: &Arc<Ledger>, operation: &Arc<Operation>, source: &Arc<Input>, future: impl Future<Output = Result<downloads::InstanceBuild>>) -> Result<Value> {
    let (result, deferred) = linked_join(operation, source, future).await?;
    let built = result?;
    {
        let mut pending = ledger.generated.lock().map_err(|_| "生成回执台账不可用")?;
        if pending.is_some() { ledger.unknown.store(true, Ordering::Release); return Err("生成回执尚未交接，拒绝覆盖".into()); }
        *pending = Some(built);
    }
    let book = ledger.clone();
    let profile = blocking(ledger, move || {
        let mut pending = book.generated.lock().map_err(|_| "生成回执台账不可用")?;
        let built = pending.as_ref().ok_or("生成回执丢失")?;
        let receipts = built.files.iter().map(|file| GeneratedReceipt { path: file.path.clone(), size: file.size, sha256: file.sha256.clone() }).collect::<Vec<_>>();
        // 只登记成功生成器明确返回的路径；短交接不能被入口取消截断，不枚举收养未知节点。
        book.stage.lock().map_err(|_| "实例台账不可用")?.as_mut().ok_or("实例暂存丢失")?.register_generated(&receipts, &built.directories, &Cancel::default())?;
        Ok(pending.take().ok_or("生成回执丢失")?.profile)
    }).await?;
    if let Some(error) = deferred { return Err(error); }
    operation.check()?; let token = operation.token()?; source.check(&token)?;
    Ok(profile)
}

/// 在异步网络/子进程等待期间联动窗口、公共 download cancel 与来源撤销；
/// 取消后仍真实等待 future，不把写入任务丢给后台后就释放根锁。
async fn linked<T>(operation: &Arc<Operation>, source: &Arc<Input>, future: impl Future<Output = Result<T>>) -> Result<T> {
    let (result, error) = linked_join(operation, source, future).await?;
    if let Some(error) = error { return Err(error); }
    let result = result?; operation.check()?; let token = operation.token()?; source.check(&token)?; Ok(result)
}

fn commit(ledger: &Arc<Ledger>, operation: &Arc<Operation>, source: &Arc<Input>) -> Result<()> {
    let mut gate = operation.gate.lock().map_err(|_| "导入提交门不可用")?;
    operation.check()?; let token = operation.token()?; source.check(&token)?; ledger.verify_root()?;
    let mut slot = ledger.stage.lock().map_err(|_| "实例台账不可用")?; let stage = slot.as_mut().ok_or("实例暂存丢失")?;
    stage.finish(&token)?;
    operation.check()?; source.check(&token)?; ledger.verify_root()?;
    gate.attempted = true;
    match stage.publish(&token) {
        Ok(_) => { gate.committed = true; ledger.published.store(true, Ordering::Release); Ok(()) }
        Err(error) => {
            if error.starts_with("实例已发布") { gate.committed = true; ledger.published.store(true, Ordering::Release); }
            Err(error)
        }
    }
}

async fn cleanup(ledger: &Arc<Ledger>) -> Result<()> {
    let mut errors = Vec::new();
    if let Err(error) = ledger.remote.cleanup().await { ledger.unknown.store(true, Ordering::Release); errors.push(format!("成员缓存收尾未确认：{error}")); }
    let book = ledger.clone();
    if let Err(error) = blocking(ledger, move || {
        let mut slot = book.stage.lock().map_err(|_| "实例台账不可用")?;
        if let Some(stage) = slot.as_mut() { stage.cleanup()?; }
        if !book.unknown.load(Ordering::Acquire) { slot.take(); }
        Ok(())
    }).await { ledger.unknown.store(true, Ordering::Release); errors.push(format!("实例暂存清理未确认：{error}")); }
    let source = match ledger.source.lock() { Ok(slot) => Ok(slot.clone()), Err(_) => Err("来源台账不可用".to_owned()) };
    match source {
        Ok(Some(source)) => match source.finish().await {
            Ok(()) => { if let Ok(mut slot) = ledger.source.lock() { slot.take(); } }
            Err(error) => { ledger.unknown.store(true, Ordering::Release); errors.push(format!("来源收尾未确认：{error}")); }
        },
        Ok(None) => {},
        Err(error) => { ledger.unknown.store(true, Ordering::Release); errors.push(error); }
    }
    if errors.is_empty() { Ok(()) } else { Err(errors.join("；")) }
}

#[cfg(test)]
mod tests;

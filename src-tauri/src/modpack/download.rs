//! 整合包下载只产生进程内的只读归档能力，不把临时路径授予渲染层。
//! 取消只发信号；owned worker 必须等文件写入、关闭和显式清理真正完成。
use super::{access::leaf, download_store::Stage, Result};
use crate::downloads::{Cancel, JobGuard};
use serde_json::{json, Value};
use std::{collections::BTreeMap, future::Future, path::PathBuf, pin::Pin, sync::{atomic::{AtomicBool, AtomicU8, Ordering}, Arc, Mutex, OnceLock, Weak}, task::{Context, Poll}, time::{Duration, Instant}};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

mod direct;
pub(super) use direct::claim_from_url;
#[cfg(test)]
pub(super) use direct::LocalClaimFixture;

const PREFIX: &str = "hcmcl-pack-download:";
const TASK_ID: &str = "modpack";
const TTL: Duration = Duration::from_secs(600);
const FILE_CAP: u64 = 2 * 1024 * 1024 * 1024;
const CACHE_CAP: u64 = 4 * 1024 * 1024 * 1024;
const TICKET_CAP: usize = 8;
type Holder = Arc<Mutex<Option<Stage>>>;

struct Operation {
    cancel: Arc<Cancel>,
    // 0=下载准备；1=取消先赢；2=归档能力已发布。发布后取消不假称撤销。
    phase: AtomicU8,
    uncertain: AtomicBool,
    holder: Holder,
}
impl Operation {
    fn new() -> Self { Self { cancel: Arc::new(Cancel::default()), phase: AtomicU8::new(0), uncertain: AtomicBool::new(false), holder: Arc::new(Mutex::new(None)) } }
    fn stop(&self) -> Result<()> {
        match self.phase.compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) | Err(1) => { self.cancel.stop(); Ok(()) }
            _ => Err("整合包已下载，取消不能撤销已发布的归档能力".into()),
        }
    }
    fn ready(&self) -> Result<()> {
        self.phase.compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ()).map_err(|_| "整合包下载已取消，未授予归档能力".into())
    }
}
struct Capability { id: String, filename: String, created: Instant, bytes: u64, holder: Holder, cancel: Arc<Cancel>, reader_gate: Arc<tokio::sync::Mutex<()>> }
#[derive(Default)]
struct State {
    closed: bool,
    poisoned: bool,
    active: Option<Arc<Operation>>,
    ready: BTreeMap<String, Arc<Capability>>,
    // 已被导入独占的票据仍计入预算；TTL 不得回收正在使用的源文件。
    in_use: BTreeMap<String, Arc<Capability>>,
    // 清理中的字节和票据仍计入预算；失败保留登记，不假装已经删除。
    cleaning: BTreeMap<String, Arc<Capability>>,
}
impl State {
    fn reserve(&mut self, operation: Arc<Operation>) -> Result<()> {
        if self.closed { return Err("主窗口已关闭，不能登记整合包下载".into()); }
        if self.poisoned { return Err("归档清理结果未知，请重启并核对缓存后重试".into()); }
        if self.active.is_some() { return Err("已有整合包下载仍在收尾，请稍后重试".into()); }
        let count = self.ready.len() + self.in_use.len() + self.cleaning.len();
        let bytes = self.ready.values().chain(self.in_use.values()).chain(self.cleaning.values()).try_fold(0u64, |sum, row| sum.checked_add(row.bytes)).ok_or("下载缓存预算溢出")?;
        if count >= TICKET_CAP || bytes.checked_add(FILE_CAP).filter(|sum| *sum <= CACHE_CAP).is_none() {
            return Err("整合包临时归档已达容量限制，请等待过期清理后重试".into());
        }
        self.active = Some(operation); Ok(())
    }
    fn publish(&mut self, operation: &Arc<Operation>, bytes: u64, filename: &str) -> Result<Arc<Capability>> {
        if self.closed || self.poisoned || !self.active.as_ref().map(|row| Arc::ptr_eq(row, operation)).unwrap_or(false) {
            return Err("下载会话已失效，未授予归档能力".into());
        }
        if bytes == 0 || bytes > FILE_CAP { return Err("下载归档大小无效".into()); }
        operation.ready()?;
        let cap = Arc::new(Capability { id: uuid::Uuid::new_v4().to_string(), filename: filename.to_owned(), created: Instant::now(), bytes, holder: operation.holder.clone(), cancel: Arc::new(Cancel::default()), reader_gate: Arc::new(tokio::sync::Mutex::new(())) });
        self.ready.insert(cap.id.clone(), cap.clone()); Ok(cap)
    }
    fn finish(&mut self, operation: &Arc<Operation>, certain: bool) {
        if !certain { self.poisoned = true; return; }
        if self.active.as_ref().map(|row| Arc::ptr_eq(row, operation)).unwrap_or(false) { self.active = None; }
    }
    fn check_probe(&self, cap: &Arc<Capability>) -> Result<()> {
        if self.closed || self.poisoned || cap.created.elapsed() >= TTL
            || !self.ready.get(&cap.id).map(|row| Arc::ptr_eq(row, cap)).unwrap_or(false) {
            return Err("下载归档在探测期间失效或清理状态未知，请重新下载".into());
        }
        cap.cancel.check()
    }
    fn check_claim(&self, cap: &Arc<Capability>, parent: &Cancel) -> Result<()> {
        if self.closed || self.poisoned
            || !self.in_use.get(&cap.id).map(|row| Arc::ptr_eq(row, cap)).unwrap_or(false) {
            return Err("整合包归档租约已关闭或状态未知".into());
        }
        parent.check()?;
        cap.cancel.check()
    }
    fn claim(&mut self, id: &str) -> Result<Arc<Capability>> {
        if self.closed || self.poisoned { return Err("整合包归档会话已关闭或状态未知".into()); }
        let cap = self.ready.get(id).cloned().ok_or("下载归档已过期或不属于当前会话，请重新下载")?;
        if cap.created.elapsed() >= TTL { return Err("下载归档已过期，请重新下载".into()); }
        cap.cancel.check()?;
        self.ready.remove(id);
        self.in_use.insert(id.to_owned(), cap.clone());
        Ok(cap)
    }
    fn revoke(&mut self, id: &str) -> Option<Arc<Capability>> {
        let cap = self.ready.remove(id)?; cap.cancel.stop(); self.cleaning.insert(id.to_owned(), cap.clone()); Some(cap)
    }
    fn expired(&mut self) -> Vec<Arc<Capability>> {
        let ids = self.ready.values().filter(|row| row.created.elapsed() >= TTL).map(|row| row.id.clone()).collect::<Vec<_>>();
        ids.into_iter().filter_map(|id| self.revoke(&id)).collect()
    }
    fn close(&mut self) -> Vec<Arc<Capability>> {
        self.closed = true;
        if let Some(operation) = &self.active { let _ = operation.stop(); }
        // 只发信号；导入 owned worker 必须归还读句柄并显式 finish 后才能清理。
        self.cancel_in_use();
        let ids = self.ready.keys().cloned().collect::<Vec<_>>();
        ids.into_iter().filter_map(|id| self.revoke(&id)).collect()
    }
    fn cancel_download(&mut self, task_id: Option<&str>) -> Result<()> {
        if task_id.is_some() && task_id != Some(TASK_ID) { return Ok(()); }
        let active = self.active.as_ref().map(|operation| operation.stop()).unwrap_or(Ok(()));
        self.cancel_in_use();
        active
    }
    fn cancel_in_use(&self) { for cap in self.in_use.values() { cap.cancel.stop(); } }
}
#[derive(Default)] struct Registry(Mutex<State>);
static REGISTRY: OnceLock<Arc<Registry>> = OnceLock::new();
fn registry() -> Arc<Registry> { REGISTRY.get_or_init(|| Arc::new(Registry::default())).clone() }
fn lock_error() -> String { "整合包下载会话状态不可用".into() }
fn holder_cleanup(holder: &Holder) -> Result<()> {
    let mut guard = holder.lock().map_err(|_| "归档暂存状态未知，拒绝盲目清理")?;
    if let Some(stage) = guard.as_mut() { stage.cleanup()?; }
    guard.take(); Ok(())
}
async fn cleanup(registry: Arc<Registry>, cap: Arc<Capability>) {
    let holder = cap.holder.clone();
    let result = tauri::async_runtime::spawn_blocking(move || holder_cleanup(&holder)).await;
    if let Ok(mut state) = registry.0.lock() {
        if matches!(result, Ok(Ok(()))) { state.cleaning.remove(&cap.id); }
        else { state.poisoned = true; }
    }
}
fn schedule_cleanup(registry: &Arc<Registry>, caps: Vec<Arc<Capability>>) {
    for cap in caps { let registry = registry.clone(); tauri::async_runtime::spawn(async move { cleanup(registry, cap).await; }); }
}
fn reap(registry: &Arc<Registry>) -> Result<()> {
    let caps = registry.0.lock().map_err(|_| lock_error())?.expired();
    schedule_cleanup(registry, caps); Ok(())
}
fn expire_later(registry: &Arc<Registry>, cap: &Arc<Capability>) {
    let registry = Arc::downgrade(registry); let cap = Arc::downgrade(cap);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(TTL).await;
        let (Some(registry), Some(cap)) = (Weak::upgrade(&registry), Weak::upgrade(&cap)) else { return; };
        let expired = registry.0.lock().ok().and_then(|mut state| {
            if state.ready.get(&cap.id).map(|row| Arc::ptr_eq(row, &cap)).unwrap_or(false) { state.revoke(&cap.id) } else { None }
        });
        if let Some(cap) = expired { cleanup(registry, cap).await; }
    });
}
pub(super) fn cancel_for_window() {
    let registry = registry();
    let caps = match registry.0.lock() { Ok(mut state) => state.close(), Err(_) => return };
    // GUI 线程不等文件锁、网络、磁盘或正在解析归档的同步线程。
    schedule_cleanup(&registry, caps);
}
pub(super) fn cancel_download(task_id: Option<&str>) -> Result<()> {
    registry().0.lock().map_err(|_| lock_error())?.cancel_download(task_id)
}

pub(super) fn relaunch_ready() -> Result<()> {
    let registry = registry();
    let state = match registry.0.try_lock() {
        Ok(state) => state,
        Err(std::sync::TryLockError::WouldBlock) => return Err("整合包下载状态正忙，无法确认可以重启".into()),
        Err(std::sync::TryLockError::Poisoned(_)) => return Err("整合包下载状态未知，无法确认可以重启".into()),
    };
    if state.closed { return Err("整合包下载窗口已关闭，无法确认可以重启".into()); }
    if state.poisoned { return Err("整合包下载清理状态未知，无法确认可以重启".into()); }
    if state.active.is_some() { return Err("整合包下载仍在进行或收尾，无法重启".into()); }
    if !state.cleaning.is_empty() { return Err("整合包下载缓存仍在清理，无法重启".into()); }
    if !state.in_use.is_empty() { return Err("整合包归档仍被读取或导入，无法重启".into()); }
    if !state.ready.is_empty() { return Err("整合包下载缓存仍有待读取归档，无法重启".into()); }
    Ok(())
}

struct Waiter(Option<Arc<Operation>>);
impl Drop for Waiter { fn drop(&mut self) { if let Some(operation) = &self.0 { let _ = operation.stop(); } } }
struct Lease { registry: Arc<Registry>, operation: Arc<Operation>, finished: bool }
impl Lease {
    fn finish(&mut self, certain: bool) {
        if let Ok(mut state) = self.registry.0.lock() { state.finish(&self.operation, certain); self.finished = true; }
    }
}
impl Drop for Lease {
    fn drop(&mut self) { if !self.finished { let _ = self.operation.stop(); if let Ok(mut state) = self.registry.0.lock() { state.finish(&self.operation, false); } } }
}
#[derive(Clone)]
struct Reporter { sink: Arc<dyn Fn(Value) + Send + Sync>, filename: String, last: Arc<Mutex<Instant>> }
impl Reporter {
    fn emit(&self, bytes: u64, total: Option<u64>, done: Option<bool>) {
        if done.is_none() {
            if let Ok(mut last) = self.last.lock() { if last.elapsed() < Duration::from_millis(100) { return; } *last = Instant::now(); }
        }
        let success = done == Some(true);
        let percent = if done.is_some() { if success { 100.0 } else { 0.0 } } else { total.filter(|size| *size > 0).map(|size| (bytes as f64 / size as f64 * 99.0).min(99.0)).unwrap_or(0.0) };
        (self.sink)(json!({"taskId":TASK_ID,"jobTitle":"整合包下载","task":format!("{} {}",if done.is_some(){if success{"下载完成"}else{"下载中断"}}else{"下载"},self.filename),"current":if success{1}else{0},"total":1,"currentBytes":bytes,"totalBytes":total.unwrap_or(0),"phase":if done.is_some(){"done"}else{"mod"},"percent":percent,"speed":0}));
    }
}
async fn transfer(cache: PathBuf, url: String, operation: Arc<Operation>, report: Reporter) -> Result<(u64, String)> {
    operation.cancel.check()?;
    let holder = operation.holder.clone();
    let created = tauri::async_runtime::spawn_blocking(move || -> Result<_> {
        let stage = Stage::create(&cache)?;
        let mut guard = holder.lock().map_err(|_| "归档暂存会话不可用")?;
        *guard = Some(stage);
        guard.as_mut().ok_or("归档暂存尚未登记")?.take_file()
    }).await;
    let raw = match created {
        Ok(Ok(file)) => file,
        Ok(Err(error)) => {
            if error.contains("暂存清理未确认") { operation.uncertain.store(true, Ordering::Release); }
            return Err(error);
        }
        Err(_) => { operation.uncertain.store(true, Ordering::Release); return Err("建立下载暂存的后台任务异常，清理结果未知".into()); }
    };
    let mut file = tokio::fs::File::from_std(raw);
    let reporter = report.clone();
    let sink: Arc<dyn Fn(u64, Option<u64>) + Send + Sync> = Arc::new(move |bytes, total| reporter.emit(bytes, total, None));
    let result = super::network::download(&url, &mut file, operation.cancel.clone(), sink).await;
    finish_transfer(file, operation, result).await
}
async fn finish_transfer(mut file: tokio::fs::File, operation: Arc<Operation>, result: Result<(u64, String)>) -> Result<(u64, String)> {
    // 即使网络失败也先等所有后台写完成，再真正关闭；这里不得 select/abort 文件 IO。
    let flushed = file.flush().await.map_err(|_| "下载归档刷新失败".to_owned());
    let synced = if result.is_ok() && flushed.is_ok() { file.sync_all().await.map_err(|_| "下载归档同步失败".to_owned()) } else { Ok(()) };
    drop(file.into_std().await);
    let (bytes, digest) = result?; flushed?; synced?; operation.cancel.check()?;
    let holder = operation.holder.clone(); let cancel = operation.cancel.clone(); let seal_digest = digest.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<()> {
        cancel.check()?;
        holder.lock().map_err(|_| "归档暂存状态不可用")?.as_mut().ok_or("下载暂存已失效")?.seal(bytes, &seal_digest)?;
        cancel.check()
    }).await.map_err(|_| {
        operation.uncertain.store(true, Ordering::Release);
        "下载归档校验后台异常，结果未知".to_owned()
    })??;
    Ok((bytes, digest))
}
async fn retain_download_work<T>(registry: Arc<Registry>, operation: Arc<Operation>, work: impl std::future::Future<Output=(Result<T>, bool)>) -> Result<T> {
    let mut lease = Lease { registry, operation, finished: false };
    let (result,certain)=work.await;
    lease.finish(certain);
    result
}
async fn owned_download(registry: Arc<Registry>, operation: Arc<Operation>, registration: JobGuard, cache: PathBuf, url: String, report: Reporter) -> Result<Value> {
    let owner_registry=registry.clone(); let owner_operation=operation.clone();
    let work=async move {
    let result = transfer(cache, url, operation.clone(), report.clone()).await;
    let mut certain = !operation.uncertain.load(Ordering::Acquire);
    let outcome = match result {
        Ok((bytes, _digest)) => {
            let published = registry.0.lock().map_err(|_| lock_error()).and_then(|mut state| state.publish(&operation, bytes, &report.filename));
            match published {
                Ok(cap) => { expire_later(&registry, &cap); Ok((json!(format!("{PREFIX}{}", cap.id)), bytes)) }
                Err(error) => {
                    let holder = operation.holder.clone();
                    let cleaned = tauri::async_runtime::spawn_blocking(move || holder_cleanup(&holder)).await;
                    if !matches!(cleaned, Ok(Ok(()))) { certain = false; }
                    Err(error)
                }
            }
        }
        Err(error) => {
            let holder = operation.holder.clone();
            let cleaned = tauri::async_runtime::spawn_blocking(move || holder_cleanup(&holder)).await;
            if !matches!(cleaned, Ok(Ok(()))) { certain = false; }
            Err(error)
        }
    };
    let successful_bytes = outcome.as_ref().ok().map(|(_, bytes)| *bytes);
    let final_result = if !certain { Err("下载已停止，但临时归档清理结果未知；请重启并核对缓存".to_owned()) } else { outcome.map(|(value, _)| value) };
    registration.complete(final_result.as_ref().map(|_| ()).map_err(Clone::clone));
    report.emit(successful_bytes.unwrap_or(0), successful_bytes, Some(final_result.is_ok()));
    (final_result,certain)
    };
    retain_download_work(owner_registry,owner_operation,work).await
}
fn emit_progress(value: Value, mut emit: impl FnMut(&str, Value)) {
    for channel in ["modpack:progress", "download:progress"] {
        emit("launcher:event", json!({"channel":channel,"payload":value}));
    }
}
pub(super) async fn start(app: &AppHandle, url: &str, filename: &str) -> Result<Value> {
    let filename = leaf(filename)?.to_owned();
    super::network::validate_url(url)?;
    let cache = app.path().app_cache_dir().map_err(|_| "无法定位应用私有缓存目录")?;
    if !cache.is_absolute() { return Err("应用缓存目录不是可信绝对路径".into()); }
    let registry = registry(); reap(&registry)?;
    let operation = Arc::new(Operation::new());
    registry.0.lock().map_err(|_| lock_error())?.reserve(operation.clone())?;
    let registration = match JobGuard::register(&cache, TASK_ID) {
        Ok(value) => value,
        Err(error) => { registry.0.lock().map_err(|_| lock_error())?.finish(&operation, true); return Err(error); }
    };
    let mut waiter = Waiter(Some(operation.clone()));
    let event_app = app.clone();
    let report = Reporter { sink: Arc::new(move |value| emit_progress(value, |event, payload| { let _ = event_app.emit_to("main", event, payload); })), filename, last: Arc::new(Mutex::new(Instant::now() - Duration::from_secs(1))) };
    let worker = tauri::async_runtime::spawn(owned_download(registry, operation, registration, cache, url.to_owned(), report));
    let result = worker.await.map_err(|_| "整合包下载后台异常，结果未知；请重启并核对缓存".to_owned())?;
    waiter.0.take(); result
}
fn token(value: &str) -> Result<Option<String>> {
    let Some(id) = value.strip_prefix(PREFIX) else { return Ok(None); };
    let parsed = uuid::Uuid::parse_str(id).map_err(|_| "下载归档标识无效")?;
    if parsed.to_string() != id { return Err("下载归档标识无效".into()); }
    Ok(Some(id.to_owned()))
}
/// 一次性、独占的归档租约。必须由导入 owned worker 显式 finish；Drop 不能确认清理。
/// read_archive 仅交出借用文件，不授予缓存路径；目标发布仍由上层事务线性化。
pub(super) struct ArchiveClaim { registry: Arc<Registry>, cap: Arc<Capability>, finished: bool }
impl ArchiveClaim {
    pub(super) fn cancel(&self) -> Arc<Cancel> { self.cap.cancel.clone() }
    /// 不核 TTL：已认领的长事务不因时间经过而失败；发布前上层必须再调用本检查。
    pub(super) fn check(&self, parent: &Cancel) -> Result<()> { check_claim(&self.registry, &self.cap, parent) }
    pub(super) fn read_archive<T: Send + 'static>(&self, parent: Arc<Cancel>, read: impl FnOnce(&mut std::fs::File, &str, &Cancel) -> Result<T> + Send + 'static) -> ClaimReadFuture<T> {
        let registry = self.registry.clone();
        let cap = self.cap.clone();
        let signals = Some((cap.cancel.clone(), parent.clone()));
        let owner = ClaimReadOwner { registry: registry.clone(), cap: cap.clone(), parent: parent.clone(), finished: false };
        // 创建即启动独立拥有者；返回的 future 即使从未 poll 就 Drop，也只发取消信号。
        let child = tauri::async_runtime::spawn(async move {
            let mut owner = owner;
            let result = run_claim_read(registry, cap, parent, read).await;
            owner.finished = true;
            result
        });
        let worker = Box::pin(async move { child.await.map_err(|_| "下载归档读取拥有者异常，租约状态未知".to_owned())? });
        ClaimReadFuture { worker, signals }
    }
    pub(super) fn finish(self) -> ArchiveFinishFuture {
        let cancel = Some(self.cap.cancel.clone());
        let child = tauri::async_runtime::spawn(finish_claim(self));
        let worker = Box::pin(async move { child.await.map_err(|_| "下载归档清理后台异常，结果未知；租约仍保留".to_owned())? });
        ArchiveFinishFuture { worker, cancel }
    }
}
impl Drop for ArchiveClaim {
    fn drop(&mut self) {
        if self.finished { return; }
        self.cap.cancel.stop();
        // 没有显式 finish 就无法证明所有副作用已收尾；保留票据和 Stage，绝不假删。
        if let Ok(mut state) = self.registry.0.lock() { state.poisoned = true; }
    }
}
struct ClaimReadOwner { registry: Arc<Registry>, cap: Arc<Capability>, parent: Arc<Cancel>, finished: bool }
impl Drop for ClaimReadOwner {
    fn drop(&mut self) {
        if self.finished { return; }
        self.cap.cancel.stop();
        self.parent.stop();
        if let Ok(mut state) = self.registry.0.lock() { state.poisoned = true; }
    }
}
type ClaimWorker<T> = Pin<Box<dyn Future<Output = Result<T>> + Send>>;
pub(super) struct ClaimReadFuture<T> { worker: ClaimWorker<T>, signals: Option<(Arc<Cancel>, Arc<Cancel>)> }
impl<T> Unpin for ClaimReadFuture<T> {}
impl<T> Future for ClaimReadFuture<T> {
    type Output = Result<T>;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        match this.worker.as_mut().poll(cx) {
            Poll::Ready(result) => { this.signals.take(); Poll::Ready(result) },
            Poll::Pending => Poll::Pending,
        }
    }
}
impl<T> Drop for ClaimReadFuture<T> {
    fn drop(&mut self) { if let Some((cap, parent)) = &self.signals { cap.stop(); parent.stop(); } }
}
pub(super) struct ArchiveFinishFuture { worker: ClaimWorker<()>, cancel: Option<Arc<Cancel>> }
impl Future for ArchiveFinishFuture {
    type Output = Result<()>;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        match this.worker.as_mut().poll(cx) {
            Poll::Ready(result) => { this.cancel.take(); Poll::Ready(result) },
            Poll::Pending => Poll::Pending,
        }
    }
}
impl Drop for ArchiveFinishFuture { fn drop(&mut self) { if let Some(cancel) = &self.cancel { cancel.stop(); } } }
fn check_claim(registry: &Registry, cap: &Arc<Capability>, parent: &Cancel) -> Result<()> {
    if parent.check().is_err() { cap.cancel.stop(); }
    if cap.cancel.check().is_err() { parent.stop(); }
    registry.0.lock().map_err(|_| lock_error())?.check_claim(cap, parent)
}
async fn run_claim_read<T: Send + 'static>(registry: Arc<Registry>, cap: Arc<Capability>, parent: Arc<Cancel>, read: impl FnOnce(&mut std::fs::File, &str, &Cancel) -> Result<T> + Send + 'static) -> Result<T> {
    check_claim(&registry,&cap,&parent)?;
    let gate=tokio::select! {biased; _=parent.cancelled()=>{cap.cancel.stop();return Err("整合包导入已取消".into())}, _=cap.cancel.cancelled()=>{parent.stop();return Err("整合包归档已取消".into())}, gate=cap.reader_gate.clone().lock_owned()=>gate};
    check_claim(&registry,&cap,&parent)?;
    let read_registry=registry.clone();let read_cap=cap.clone();let read_parent=parent.clone();
    let mut child=tauri::async_runtime::spawn_blocking(move || -> Result<T> {
        let _gate=gate;
        check_claim(&read_registry,&read_cap,&read_parent)?;
        let holder=read_cap.holder.lock().map_err(|_| "下载归档状态不可用")?;
        let stage=holder.as_ref().ok_or("下载归档已清理")?;
        stage.read_claimed_archive(&read_cap.cancel,&read_parent,|file|read(file,&read_cap.filename,&read_cap.cancel))
    });
    let joined=tokio::select! {biased; _=parent.cancelled()=>{cap.cancel.stop();child.await}, _=cap.cancel.cancelled()=>{parent.stop();child.await}, result=&mut child=>result};
    match joined {
        Ok(result)=>{check_claim(&registry,&cap,&parent)?;result},
        Err(_)=>{cap.cancel.stop();parent.stop();if let Ok(mut state)=registry.0.lock(){state.poisoned=true;}Err("下载归档读取后台异常，租约状态未知".into())}
    }
}
async fn finish_claim(mut claim: ArchiveClaim) -> Result<()> {
    claim.cap.cancel.stop();
    let _reader = claim.cap.reader_gate.clone().lock_owned().await;
    {
        let state = claim.registry.0.lock().map_err(|_| lock_error())?;
        let same = state.in_use.get(&claim.cap.id).map(|row| Arc::ptr_eq(row, &claim.cap)).unwrap_or(false);
        if !same || state.poisoned {
            return Err("下载归档清理状态未知；租约仍占用，请重启并核对缓存".into());
        }
    }
    let holder = claim.cap.holder.clone();
    let cleaned = tauri::async_runtime::spawn_blocking(move || holder_cleanup(&holder)).await;
    let mut state = claim.registry.0.lock().map_err(|_| lock_error())?;
    let same = state.in_use.get(&claim.cap.id).map(|row| Arc::ptr_eq(row, &claim.cap)).unwrap_or(false);
    if !same || !matches!(cleaned, Ok(Ok(()))) {
        state.poisoned = true;
        return Err("下载归档清理结果未知；租约仍占用，请重启并核对缓存".into());
    }
    state.in_use.remove(&claim.cap.id);
    claim.finished = true;
    Ok(())
}
fn claim_in(registry: Arc<Registry>, id: &str) -> Result<ArchiveClaim> {
    let cap = {
        let state = registry.0.lock().map_err(|_| lock_error())?;
        let cap = state.ready.get(id).cloned().ok_or("下载归档已过期或不属于当前会话，请重新下载")?;
        state.check_probe(&cap)?;
        cap
    };
    // 与普通 probe 共用读者门；claim 只有在先前 probe 真正归还文件后才可独占。
    let gate = cap.reader_gate.clone().try_lock_owned().map_err(|_| "下载归档探测仍在读取，请稍后重试")?;
    let claimed = {
        let mut state = registry.0.lock().map_err(|_| lock_error())?;
        state.check_probe(&cap)?;
        let moved = state.claim(id)?;
        if !Arc::ptr_eq(&moved, &cap) { state.poisoned = true; return Err("下载归档租约身份发生变化".into()); }
        moved
    };
    drop(gate);
    Ok(ArchiveClaim { registry, cap: claimed, finished: false })
}
/// 仅识别进程内 opaque 下载能力；普通 picker 路径不在此授予任何新权限。
pub(super) async fn claim_archive(value: &str) -> Result<Option<ArchiveClaim>> {
    let Some(id) = token(value)? else { return Ok(None); };
    let registry = registry();
    reap(&registry)?;
    claim_in(registry, &id).map(Some)
}

/// 只向后台读取回调授予已封存归档，既不外借缓存路径，也不扩大 picker 授权。
/// 回调应限于读取/生成计划；有副作用的导入必须另持 owned 事务并在发布前验证自身状态。
pub(super) async fn read_archive<T: Send + 'static>(value: &str, read: impl FnOnce(&mut std::fs::File, &str, &Cancel) -> Result<T> + Send + 'static) -> Result<Option<T>> {
    let Some(id) = token(value)? else { return Ok(None); };
    let registry = registry(); reap(&registry)?;
    let cap = {
        let state = registry.0.lock().map_err(|_| lock_error())?;
        let cap=state.ready.get(&id).cloned().ok_or("下载归档已过期或不属于当前会话，请重新下载")?;
        state.check_probe(&cap)?;
        cap
    };
    let reader = cap.reader_gate.clone().lock_owned().await;
    {
        let state = registry.0.lock().map_err(|_| lock_error())?;
        state.check_probe(&cap)?;
    }
    let read_cap = cap.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<T> {
        let _reader = reader;
        read_cap.cancel.check()?;
        let holder = read_cap.holder.lock().map_err(|_| "下载归档状态不可用")?;
        holder.as_ref().ok_or("下载归档已清理")?.read_archive(&read_cap.cancel, |file| read(file, &read_cap.filename, &read_cap.cancel))
    }).await.map_err(|_| "下载归档读取后台异常")??;
    reap(&registry)?;
    let state = registry.0.lock().map_err(|_| lock_error())?;
    state.check_probe(&cap)?;
    Ok(Some(result))
}
pub(super) async fn probe(value: &str) -> Result<Option<Value>> {
    read_archive(value, |file, filename, _| super::parser::probe(file, std::path::Path::new(filename))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn capability(bytes: u64) -> Arc<Capability> { Arc::new(Capability { id: uuid::Uuid::new_v4().to_string(), filename: "fixture.zip".into(), created: Instant::now(), bytes, holder: Arc::new(Mutex::new(None)), cancel: Arc::new(Cancel::default()), reader_gate: Arc::new(tokio::sync::Mutex::new(())) }) }
    struct ClaimFixture(PathBuf);
    impl ClaimFixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("hcmcl-archive-claim-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).unwrap();
            Self(std::fs::canonicalize(path).unwrap())
        }
        fn sealed(&self) -> (Arc<Capability>, PathBuf) {
            use std::io::{Cursor, Write};
            use sha2::{Digest, Sha256};
            use zip::{write::FileOptions, CompressionMethod, ZipWriter};
            let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
            let options = FileOptions::default().compression_method(CompressionMethod::Stored);
            zip.start_file("launcher.packmeta", options).unwrap();
            zip.write_all(br#"{"name":"claim fixture","game_version":"1.21.1","mod_loader":"vanilla"}"#).unwrap();
            zip.start_file("overrides/config/example.txt", options).unwrap();
            zip.write_all(b"fixture data").unwrap();
            let bytes = zip.finish().unwrap().into_inner();
            let mut stage = Stage::create(&self.0.join("missing/cache")).unwrap();
            let path = stage.test_directory_path().unwrap();
            let mut file = stage.take_file().unwrap();
            file.write_all(&bytes).unwrap(); file.flush().unwrap(); file.sync_all().unwrap(); drop(file);
            stage.seal(bytes.len() as u64, &format!("{:x}", Sha256::digest(&bytes))).unwrap();
            let holder: Holder = Arc::new(Mutex::new(Some(stage)));
            (Arc::new(Capability { id: uuid::Uuid::new_v4().to_string(), filename: "source.zip".into(), created: Instant::now(), bytes: bytes.len() as u64, holder, cancel: Arc::new(Cancel::default()), reader_gate: Arc::new(tokio::sync::Mutex::new(())) }), path)
        }
    }
    impl Drop for ClaimFixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    fn fixture_registry(cap: Arc<Capability>) -> Arc<Registry> {
        let registry = Arc::new(Registry::default());
        registry.0.lock().unwrap().ready.insert(cap.id.clone(), cap);
        registry
    }
    fn fill_ticket_budget(registry: &Registry) {
        let mut state = registry.0.lock().unwrap();
        while state.ready.len() + state.in_use.len() + state.cleaning.len() < TICKET_CAP {
            let cap = capability(1);
            state.ready.insert(cap.id.clone(), cap);
        }
    }
    fn read_fixture(file: &mut std::fs::File, name: &str, _: &Cancel) -> Result<Value> {
        assert_eq!(name, "source.zip");
        super::super::parser::probe(file, std::path::Path::new(name))
    }
    #[tokio::test]
    async fn claim_is_single_use_and_rejects_probe_and_second_claim() {
        let fixture = ClaimFixture::new(); let (cap, path) = fixture.sealed();
        let registry = fixture_registry(cap.clone());
        let reader = cap.reader_gate.clone().lock_owned().await;
        assert!(claim_in(registry.clone(), &cap.id).is_err());
        assert!(registry.0.lock().unwrap().ready.contains_key(&cap.id));
        drop(reader);
        let claim = claim_in(registry.clone(), &cap.id).unwrap();
        assert!(registry.0.lock().unwrap().ready.is_empty());
        assert!(registry.0.lock().unwrap().check_probe(&cap).is_err());
        assert!(claim_in(registry.clone(), &cap.id).is_err());
        let value = claim.read_archive(Arc::new(Cancel::default()), read_fixture).await.unwrap();
        assert_eq!(value["name"], "claim fixture"); assert_eq!(value["format"], "native");
        assert!(!value.to_string().contains(&fixture.0.to_string_lossy().to_string()));
        claim.finish().await.unwrap();
        assert!(!path.exists()); assert!(registry.0.lock().unwrap().in_use.is_empty());
    }
    #[tokio::test]
    async fn claimed_ttl_is_ignored_and_close_only_signals_until_explicit_finish() {
        let fixture = ClaimFixture::new(); let (mut cap, path) = fixture.sealed();
        // 构造已过 TTL 的在用票据，不真实等待十分钟，也不绕过生产 claim 的 TTL 校验。
        Arc::get_mut(&mut cap).unwrap().created = Instant::now() - TTL - Duration::from_secs(1);
        let registry = fixture_registry(cap.clone());
        assert!(claim_in(registry.clone(), &cap.id).is_err());
        {
            let mut state = registry.0.lock().unwrap();
            state.ready.remove(&cap.id); state.in_use.insert(cap.id.clone(), cap.clone());
        }
        let claim = ArchiveClaim { registry: registry.clone(), cap: cap.clone(), finished: false };
        reap(&registry).unwrap(); assert!(path.exists());
        claim.check(&Cancel::default()).unwrap();
        assert_eq!(claim.read_archive(Arc::new(Cancel::default()), read_fixture).await.unwrap()["name"], "claim fixture");
        assert!(registry.0.lock().unwrap().close().is_empty());
        assert!(cap.cancel.check().is_err());
        assert!(path.exists()); assert!(registry.0.lock().unwrap().in_use.contains_key(&cap.id));
        claim.finish().await.unwrap();
        assert!(!path.exists()); assert!(registry.0.lock().unwrap().in_use.is_empty());
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dropped_read_waiter_signals_but_keeps_busy_until_child_really_returns() {
        use std::sync::mpsc;
        let fixture = ClaimFixture::new(); let (cap, path) = fixture.sealed();
        let registry = fixture_registry(cap.clone()); fill_ticket_budget(&registry);
        let claim = claim_in(registry.clone(), &cap.id).unwrap(); let parent = Arc::new(Cancel::default());
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let read = claim.read_archive(parent.clone(), move |file, name, cancel| {
            let value = read_fixture(file, name, cancel)?;
            entered_tx.send(()).unwrap(); release_rx.recv_timeout(Duration::from_secs(5)).unwrap(); Ok(value)
        });
        let caller = tokio::spawn(read); entered_rx.await.unwrap(); caller.abort(); let _ = caller.await;
        assert!(cap.cancel.check().is_err()); assert!(parent.check().is_err());
        assert!(cap.reader_gate.clone().try_lock_owned().is_err());
        assert!(path.exists()); assert!(registry.0.lock().unwrap().in_use.contains_key(&cap.id));
        assert!(registry.0.lock().unwrap().reserve(Arc::new(Operation::new())).is_err());
        release_tx.send(()).unwrap();
        let reader = tokio::time::timeout(Duration::from_secs(5), cap.reader_gate.clone().lock_owned()).await.unwrap();
        drop(reader); claim.finish().await.unwrap();
        assert!(!path.exists()); assert!(registry.0.lock().unwrap().in_use.is_empty());
        registry.0.lock().unwrap().reserve(Arc::new(Operation::new())).unwrap();
    }
    #[tokio::test]
    async fn unfinished_claim_drop_is_sticky_and_keeps_budget() {
        let fixture = ClaimFixture::new(); let (cap, path) = fixture.sealed();
        let registry = fixture_registry(cap.clone());
        drop(claim_in(registry.clone(), &cap.id).unwrap());
        let mut state = registry.0.lock().unwrap();
        assert!(state.poisoned); assert!(state.in_use.contains_key(&cap.id));
        assert!(state.reserve(Arc::new(Operation::new())).is_err());
        assert!(cap.cancel.check().is_err()); assert!(path.exists());
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn finish_waits_for_reader_then_releases_actual_stage_and_budget() {
        use std::sync::mpsc;
        let fixture = ClaimFixture::new(); let (cap, path) = fixture.sealed();
        let registry = fixture_registry(cap.clone()); fill_ticket_budget(&registry);
        let claim = claim_in(registry.clone(), &cap.id).unwrap();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let read = tokio::spawn(claim.read_archive(Arc::new(Cancel::default()), move |file, name, cancel| {
            let value = read_fixture(file, name, cancel)?;
            entered_tx.send(()).unwrap(); release_rx.recv_timeout(Duration::from_secs(5)).unwrap(); Ok(value)
        }));
        entered_rx.await.unwrap();
        let mut finish = Box::pin(claim.finish());
        // 手动 poll 一次证明真正的 finish 仍 Pending，不用固定睡眠猜测 worker 时序。
        std::future::poll_fn(|cx| { assert!(finish.as_mut().poll(cx).is_pending()); Poll::Ready(()) }).await;
        assert!(path.exists()); assert!(registry.0.lock().unwrap().in_use.contains_key(&cap.id));
        assert!(registry.0.lock().unwrap().reserve(Arc::new(Operation::new())).is_err());
        release_tx.send(()).unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(5), read).await.unwrap().unwrap().is_err());
        tokio::time::timeout(Duration::from_secs(5), finish).await.unwrap().unwrap();
        assert!(!path.exists()); assert!(cap.holder.lock().unwrap().is_none());
        let mut state = registry.0.lock().unwrap(); assert!(state.in_use.is_empty()); assert!(!state.poisoned);
        state.reserve(Arc::new(Operation::new())).unwrap();
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn read_cancellation_links_parent_and_capability_in_both_directions() {
        use std::sync::mpsc;
        for cancel_parent in [true, false] {
            let fixture = ClaimFixture::new(); let (cap, path) = fixture.sealed(); let registry = fixture_registry(cap.clone());
            let claim = claim_in(registry.clone(), &cap.id).unwrap(); let parent = Arc::new(Cancel::default());
            let (entered_tx, entered_rx) = tokio::sync::oneshot::channel(); let (release_tx, release_rx) = mpsc::channel();
            let callback_parent = parent.clone();
            let read = tokio::spawn(claim.read_archive(parent.clone(), move |file, name, cancel| {
                let value = read_fixture(file, name, cancel)?; entered_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                assert!(cancel.check().is_err()); assert!(callback_parent.check().is_err()); Ok(value)
            }));
            entered_rx.await.unwrap();
            if cancel_parent { parent.stop(); } else { assert!(registry.0.lock().unwrap().close().is_empty()); }
            tokio::time::timeout(Duration::from_secs(5), async { tokio::join!(parent.cancelled(), cap.cancel.cancelled()); }).await.unwrap();
            assert!(path.exists()); assert!(cap.reader_gate.clone().try_lock_owned().is_err());
            release_tx.send(()).unwrap();
            assert!(tokio::time::timeout(Duration::from_secs(5), read).await.unwrap().unwrap().is_err());
            assert!(claim.check(&parent).is_err()); claim.finish().await.unwrap(); assert!(!path.exists());
        }
    }
    #[tokio::test]
    async fn failed_explicit_cleanup_is_sticky_and_never_releases_lease() {
        let fixture = ClaimFixture::new(); let (cap, path) = fixture.sealed(); let registry = fixture_registry(cap.clone());
        let claim = claim_in(registry.clone(), &cap.id).unwrap();
        std::fs::write(path.join("unexpected"), b"keep").unwrap();
        assert!(claim.finish().await.is_err());
        let mut state = registry.0.lock().unwrap(); assert!(state.poisoned); assert!(state.in_use.contains_key(&cap.id));
        assert!(cap.holder.lock().unwrap().is_some());
        assert!(state.reserve(Arc::new(Operation::new())).is_err());
        assert_eq!(std::fs::read(path.join("unexpected")).unwrap(), b"keep");
        assert!(path.join("payload").exists());
    }
    #[tokio::test]
    async fn panic_in_claim_reader_keeps_unknown_lease_and_stage() {
        let fixture = ClaimFixture::new(); let (cap, path) = fixture.sealed(); let registry = fixture_registry(cap.clone());
        let claim = claim_in(registry.clone(), &cap.id).unwrap();
        assert!(claim.read_archive(Arc::new(Cancel::default()), |_, _, _| -> Result<()> { panic!("synthetic claim reader panic") }).await.is_err());
        assert!(registry.0.lock().unwrap().poisoned); assert!(registry.0.lock().unwrap().in_use.contains_key(&cap.id));
        assert!(path.exists()); assert!(claim.finish().await.is_err());
    }
    #[test]
    fn in_use_tickets_and_bytes_remain_in_the_reservation_budget() {
        let mut state = State::default();
        for _ in 0..TICKET_CAP { let cap = capability(1); state.in_use.insert(cap.id.clone(), cap); }
        assert!(state.reserve(Arc::new(Operation::new())).is_err());
        let mut state = State::default(); let cap = capability(CACHE_CAP - FILE_CAP + 1);
        state.in_use.insert(cap.id.clone(), cap); assert!(state.reserve(Arc::new(Operation::new())).is_err());
        let mut state = State::default(); let cap = capability(CACHE_CAP - FILE_CAP);
        state.in_use.insert(cap.id.clone(), cap); state.reserve(Arc::new(Operation::new())).unwrap();
    }
    #[tokio::test]
    async fn cancel_download_signals_claim_without_cleanup_or_budget_release() {
        let fixture = ClaimFixture::new(); let (cap, path) = fixture.sealed();
        let registry = fixture_registry(cap.clone()); fill_ticket_budget(&registry);
        let claim = claim_in(registry.clone(), &cap.id).unwrap();
        assert!(registry.0.lock().unwrap().cancel_download(Some("other")).is_ok());
        assert!(cap.cancel.check().is_ok());
        assert!(registry.0.lock().unwrap().cancel_download(Some(TASK_ID)).is_ok());
        assert!(cap.cancel.check().is_err()); assert!(path.exists());
        assert!(registry.0.lock().unwrap().in_use.contains_key(&cap.id));
        assert!(registry.0.lock().unwrap().reserve(Arc::new(Operation::new())).is_err());
        assert!(claim.check(&Cancel::default()).is_err());
        assert!(claim.read_archive(Arc::new(Cancel::default()), read_fixture).await.is_err());
        assert!(path.exists()); assert!(registry.0.lock().unwrap().in_use.contains_key(&cap.id));
        claim.finish().await.unwrap(); assert!(!path.exists());
        assert!(registry.0.lock().unwrap().in_use.is_empty());
        registry.0.lock().unwrap().reserve(Arc::new(Operation::new())).unwrap();
    }
    #[test]
    fn progress_uses_the_native_envelope_consumed_by_the_existing_bridge() {
        let payload=json!({"taskId":"modpack","phase":"mod","percent":42.0});
        let mut delivered=Vec::new();
        emit_progress(payload.clone(), |event, envelope| delivered.push((event.to_owned(),envelope)));
        assert_eq!(delivered.len(),2);
        for ((event,envelope),channel) in delivered.iter().zip(["modpack:progress","download:progress"]) {
            assert_eq!(event,"launcher:event");
            assert_eq!(envelope,&json!({"channel":channel,"payload":payload}));
        }
    }
    #[test]
    fn capabilities_are_opaque_bounded_and_closed_requests_never_register() {
        assert!(token("/tmp/selected.zip").unwrap().is_none());
        assert!(token("hcmcl-pack-download:not-a-uuid").is_err());
        let id = uuid::Uuid::new_v4().to_string(); assert_eq!(token(&format!("{PREFIX}{id}")).unwrap(), Some(id));
        let mut state = State::default(); let operation = Arc::new(Operation::new());
        state.reserve(operation.clone()).unwrap(); assert!(state.reserve(Arc::new(Operation::new())).is_err());
        let cap = state.publish(&operation, 42, "fixture.zip").unwrap(); state.finish(&operation, true);
        assert_eq!(state.ready.len(), 1); assert_eq!(state.close().len(), 1); assert!(cap.cancel.check().is_err());
        assert!(state.ready.is_empty()); assert_eq!(state.cleaning.len(), 1); assert!(state.reserve(Arc::new(Operation::new())).is_err());
    }
    #[test]
    fn cancelled_publication_unknown_cleanup_and_quota_fail_closed() {
        let mut state = State::default(); let op = Arc::new(Operation::new()); state.reserve(op.clone()).unwrap(); op.stop().unwrap();
        assert!(state.publish(&op, 12, "fixture.zip").is_err()); state.finish(&op, false); assert!(state.poisoned); assert!(state.active.is_some());
        let mut state = State::default(); let cap = capability(CACHE_CAP); state.ready.insert(cap.id.clone(), cap);
        assert!(state.reserve(Arc::new(Operation::new())).is_err());
        let mut state = State::default(); for _ in 0..TICKET_CAP { let cap = capability(1); state.cleaning.insert(cap.id.clone(), cap); }
        assert!(state.reserve(Arc::new(Operation::new())).is_err());
    }
    #[test]
    fn expiry_and_old_waiters_do_not_clear_a_new_operation() {
        let mut state = State::default(); let first = Arc::new(Operation::new()); state.reserve(first.clone()).unwrap(); state.finish(&first, true);
        let second = Arc::new(Operation::new()); state.reserve(second.clone()).unwrap(); state.finish(&first, true);
        assert!(Arc::ptr_eq(state.active.as_ref().unwrap(), &second));
        let mut cap = capability(1); Arc::get_mut(&mut cap).unwrap().created = Instant::now() - TTL - Duration::from_secs(1);
        state.ready.insert(cap.id.clone(), cap.clone()); assert_eq!(state.expired().len(), 1); assert!(state.ready.is_empty()); assert!(cap.cancel.check().is_err());
    }
    #[test]
    fn cleanup_failure_of_another_capability_blocks_probe_return() {
        let mut state=State::default();
        let first=capability(1);let second=capability(2);
        state.ready.insert(first.id.clone(),first.clone());
        state.ready.insert(second.id.clone(),second.clone());
        state.check_probe(&first).unwrap();
        let revoked=state.revoke(&second.id).unwrap();
        assert!(Arc::ptr_eq(&revoked,&second));
        assert!(state.ready.contains_key(&first.id));
        // 等价于另一归档的显式清理返回 Err；终检必须失败，不能仅看当前票据仍存在。
        state.poisoned=true;
        assert!(state.check_probe(&first).is_err());
        state.poisoned=false;first.cancel.stop();
        assert!(state.check_probe(&first).is_err());
    }
    #[tokio::test(flavor="multi_thread",worker_threads=2)]
    async fn aborting_caller_only_signals_and_waits_for_real_writer_before_releasing_lease() {
        use std::{fs,io::Write,sync::mpsc};
        let path=std::env::temp_dir().join(format!("hcmcl-download-owned-test-{}",uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();let path=fs::canonicalize(path).unwrap();
        let registry=Arc::new(Registry::default());let operation=Arc::new(Operation::new());
        registry.0.lock().unwrap().reserve(operation.clone()).unwrap();
        let registration=JobGuard::register(&path,"modpack").unwrap();
        let (entered_tx,entered_rx)=tokio::sync::oneshot::channel();
        let (release_tx,release_rx)=mpsc::channel();let output=path.join("writer");let writer_path=output.clone();
        let owner_registry=registry.clone();let owner_operation=operation.clone();
        let worker=tokio::spawn(async move {
            retain_download_work(owner_registry,owner_operation,async move {
                tokio::task::spawn_blocking(move || {
                    let mut file=fs::OpenOptions::new().write(true).create_new(true).open(writer_path).unwrap();
                    entered_tx.send(()).unwrap();release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                    file.write_all(b"actually closed before completion").unwrap();file.sync_all().unwrap();drop(file);
                }).await.unwrap();
                registration.complete(Err("fixture cancelled".into()));
                (Err::<(),String>("fixture cancelled".into()),true)
            }).await
        });
        let (finished_tx,finished_rx)=tokio::sync::oneshot::channel();
        let monitor=tokio::spawn(async move {finished_tx.send(worker.await).ok();});
        let waiter_operation=operation.clone();
        let (waiter_ready_tx,waiter_ready_rx)=tokio::sync::oneshot::channel();
        let caller=tokio::spawn(async move {
            let _waiter=Waiter(Some(waiter_operation));
            waiter_ready_tx.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        entered_rx.await.unwrap();waiter_ready_rx.await.unwrap();
        caller.abort();let _=caller.await;
        assert!(operation.cancel.check().is_err());
        assert!(registry.0.lock().unwrap().active.is_some());
        assert!(registry.0.lock().unwrap().reserve(Arc::new(Operation::new())).is_err());
        assert!(JobGuard::register(&path,"modpack").is_err());
        release_tx.send(()).unwrap();
        let result=tokio::time::timeout(Duration::from_secs(5),finished_rx).await.unwrap().unwrap().unwrap();
        assert!(result.is_err());monitor.await.unwrap();
        assert!(registry.0.lock().unwrap().active.is_none());
        assert_eq!(fs::read(&output).unwrap(),b"actually closed before completion");
        drop(JobGuard::register(&path,"modpack").unwrap());fs::remove_dir_all(path).unwrap();
    }
    #[tokio::test]
    async fn panic_in_owned_work_keeps_unknown_state_busy() {
        let registry=Arc::new(Registry::default());let operation=Arc::new(Operation::new());
        registry.0.lock().unwrap().reserve(operation.clone()).unwrap();
        let check=registry.clone();
        assert!(tokio::spawn(async move {
            retain_download_work::<()>(registry,operation,async {
                panic!("synthetic worker panic");
                #[allow(unreachable_code)] (Ok(()),true)
            }).await
        }).await.is_err());
        let mut state=check.0.lock().unwrap();
        assert!(state.poisoned);assert!(state.active.is_some());
        assert!(state.reserve(Arc::new(Operation::new())).is_err());
    }
    #[test]
    fn reporter_never_says_installed_and_failed_cleanup_is_not_success() {
        let events = Arc::new(Mutex::new(Vec::new())); let sink = events.clone();
        let report = Reporter { sink: Arc::new(move |event| sink.lock().unwrap().push(event)), filename: "fixture.zip".into(), last: Arc::new(Mutex::new(Instant::now() - Duration::from_secs(1))) };
        report.emit(9, Some(10), None); report.emit(0, None, Some(false));
        let events = events.lock().unwrap(); assert_eq!(events[0]["taskId"], "modpack"); assert!((events[0]["percent"].as_f64().unwrap() - 89.1).abs() < 1e-10);
        assert_eq!(events[1]["phase"], "done"); assert_eq!(events[1]["percent"], 0.0); assert!(!events[1]["task"].as_str().unwrap().contains("安装"));
    }
}
//! URL 导入的内部桥；下载拥有者负责真正收尾，只有受控交接才移出归档租约。
use super::*;
use tokio::sync::oneshot;

type Sink = Arc<dyn Fn(Value) + Send + Sync>;

// 通知只携带状态，不把 ArchiveClaim 放进可能无人接收的 JoinHandle/oneshot 结果。
struct Handoff { claim: Mutex<Option<ArchiveClaim>> }
struct ReceiverGuard { parent: Arc<Cancel>, armed: bool }
impl Drop for ReceiverGuard { fn drop(&mut self) { if self.armed { self.parent.stop(); } } }

impl State {
    fn publish_claim(&mut self, registry: &Arc<Registry>, operation: &Arc<Operation>, bytes: u64, filename: &str) -> Result<ArchiveClaim> {
        if self.closed || self.poisoned || !self.active.as_ref().is_some_and(|row| Arc::ptr_eq(row, operation)) {
            return Err("URL 导入下载会话已失效，未建立归档租约".into());
        }
        if bytes == 0 || bytes > FILE_CAP { return Err("下载归档大小无效".into()); }
        // op.cancel 与导入 parent 是同一 Arc；Claim 使用独立读者取消令牌，
        // 防止显式 finish 清理来源时反向取消已完成发布的导入。CAS 后不再做后验。
        operation.cancel.check()?;
        let cap = Arc::new(Capability {
            id: uuid::Uuid::new_v4().to_string(), filename: filename.to_owned(), created: Instant::now(), bytes,
            holder: operation.holder.clone(), cancel: Arc::new(Cancel::default()), reader_gate: Arc::new(tokio::sync::Mutex::new(())),
        });
        operation.ready()?;
        self.in_use.insert(cap.id.clone(), cap.clone());
        Ok(ArchiveClaim { registry: registry.clone(), cap, finished: false })
    }
}

fn sticky(registry: &Registry) {
    // 锁已 poison 时状态本来就不可继续；取回 inner 只为保留 fail-closed 标记。
    let mut state = registry.0.lock().unwrap_or_else(|error| error.into_inner());
    state.poisoned = true;
}
fn take_handoff(handoff: &Handoff) -> Result<ArchiveClaim> {
    handoff.claim.lock().map_err(|_| "URL 导入归档交接状态未知".to_owned())?
        .take().ok_or_else(|| "URL 导入归档交接结果丢失".into())
}

async fn cleanup_operation(operation: &Arc<Operation>) -> bool {
    let holder = operation.holder.clone();
    matches!(tauri::async_runtime::spawn_blocking(move || holder_cleanup(&holder)).await, Ok(Ok(())))
        && !operation.uncertain.load(Ordering::Acquire)
}

// worker 先建 Lease 再 spawn，因此未来即使尚未 poll 就异常丢弃，也会保留 active+poison。
async fn own_transfer<F>(
    mut lease: Lease, filename: String, handoff: Arc<Handoff>, notify: oneshot::Sender<Result<()>>,
    accepted: oneshot::Receiver<()>, work: F,
) where F: Future<Output = Result<(u64, String)>> + Send {
    let registry = lease.registry.clone(); let operation = lease.operation.clone();
    let result = work.await;
    let published = match result {
        Ok((bytes, _)) if !operation.uncertain.load(Ordering::Acquire) => {
            // 先锁交接槽再做线性化；成功 Claim 无需经过另一个可失败的锁操作。
            match handoff.claim.lock() {
                Ok(mut slot) => {
                    let result = registry.0.lock().map_err(|_| lock_error())
                        .and_then(|mut state| state.publish_claim(&registry, &operation, bytes, &filename));
                    match result { Ok(claim) => { *slot = Some(claim); Ok(()) }, Err(error) => Err(error) }
                }
                Err(_) => Err("URL 导入归档交接状态未知".into()),
            }
        }
        Ok(_) => Err("URL 导入归档后台状态未知".into()),
        Err(error) => Err(error),
    };
    if let Err(error) = published {
        let certain = cleanup_operation(&operation).await;
        lease.finish(certain);
        let error = if certain { error } else { "URL 导入下载已停止，但归档清理结果未知；仍保留下载登记".into() };
        let _ = notify.send(Err(error));
        return;
    }

    // 调用者只能同步取走槽中的 Claim，然后发送 ACK；取消不能 abort worker。
    if notify.send(Ok(())).is_ok() { let _ = accepted.await; }
    let (unclaimed, poisoned) = match handoff.claim.lock() {
        Ok(mut slot) => (slot.take(), false),
        Err(error) => { let mut slot = error.into_inner(); (slot.take(), true) },
    };
    if poisoned { sticky(&registry); }
    if let Some(claim) = unclaimed {
        // 成功但无人接收也必须显式真 await 清理；不能 Drop 后假称释放缓存。
        let cleaned = claim.finish().await;
        lease.finish(cleaned.is_ok() && !poisoned);
    } else {
        // 接收者已经拥有 Claim；in_use 是从此到显式 finish 的预算台账。
        let certain = !poisoned && registry.0.lock().map(|state| !state.poisoned).unwrap_or(false);
        lease.finish(certain);
    }
}

async fn receive(
    notified: oneshot::Receiver<Result<()>>, accepted: oneshot::Sender<()>, handoff: Arc<Handoff>,
    worker: tauri::async_runtime::JoinHandle<()>, mut receiver: ReceiverGuard,
) -> Result<ArchiveClaim> {
    let result = match notified.await {
        Ok(Ok(())) => match take_handoff(&handoff) {
            Ok(claim) => {
                // 此后没有 await / ? 后验：Claim 立即归外层 supervisor 台账。
                receiver.armed = false;
                let _ = accepted.send(());
                return Ok(claim);
            }
            Err(error) => Err(error),
        },
        Ok(Err(error)) => Err(error),
        Err(_) => Err("URL 导入下载拥有者异常，归档状态未知".into()),
    };
    receiver.parent.stop();
    drop(accepted);
    // 错误返回前真等 owned worker；IPCdrop 时该 JoinHandle 被 detach，worker 不 abort。
    let joined = worker.await;
    receiver.armed = false;
    if joined.is_err() { return Err("URL 导入下载后台异常，登记仍保留且状态未知".into()); }
    result
}

/// 生产与本地归档夹具共用同一套登记、owned worker 和 ACK 交接。
struct TransferSession {
    notified: oneshot::Receiver<Result<()>>,
    accepted: oneshot::Sender<()>,
    handoff: Arc<Handoff>,
    worker: tauri::async_runtime::JoinHandle<()>,
    receiver: ReceiverGuard,
}
impl TransferSession {
    async fn receive(self) -> Result<ArchiveClaim> {
        receive(self.notified, self.accepted, self.handoff, self.worker, self.receiver).await
    }
}
fn start_transfer<F, Fut>(registry: Arc<Registry>, filename: String, parent: Arc<Cancel>, make_work: F) -> Result<TransferSession>
where F: FnOnce(Arc<Operation>) -> Fut,
      Fut: Future<Output = Result<(u64, String)>> + Send + 'static {
    let operation = Arc::new(Operation { cancel: parent.clone(), phase: AtomicU8::new(0), uncertain: AtomicBool::new(false), holder: Arc::new(Mutex::new(None)) });
    let handoff = Arc::new(Handoff { claim: Mutex::new(None) });
    let (notify, notified) = oneshot::channel(); let (accepted, acknowledgment) = oneshot::channel();
    let receiver = ReceiverGuard { parent, armed: true };
    registry.0.lock().map_err(|_| lock_error())?.reserve(operation.clone())?;
    let lease = Lease { registry, operation: operation.clone(), finished: false };
    let worker = tauri::async_runtime::spawn(own_transfer(lease, filename, handoff.clone(), notify, acknowledgment, make_work(operation)));
    Ok(TransferSession { notified, accepted, handoff, worker, receiver })
}

/// 仅供已经登记的导入 owned supervisor 使用，不注册另一个 JobGuard，也不发下载完成。
/// 成功直接产生独占 in_use 归档；不会产生 ready token、TTL 回收窗口或缓存路径。
pub(in crate::modpack) async fn claim_from_url(
    app: &AppHandle, url: &str, filename: &str, parent: Arc<Cancel>, sink: Sink,
) -> Result<ArchiveClaim> {
    parent.check()?;
    let filename = leaf(filename)?.to_owned();
    super::super::network::validate_url(url)?;
    let cache = app.path().app_cache_dir().map_err(|_| "无法定位应用私有缓存目录")?;
    if !cache.is_absolute() { return Err("应用缓存目录不是可信绝对路径".into()); }
    let registry = registry(); reap(&registry)?;
    let report = Reporter { sink, filename: filename.clone(), last: Arc::new(Mutex::new(Instant::now() - Duration::from_secs(1))) };
    let url = url.to_owned();
    start_transfer(registry, filename, parent, move |operation| transfer(cache, url, operation, report))?.receive().await
}

/// 只替换网络字节来源；状态转换、封存、交接及 cleanup 仍调用生产实现。
#[cfg(test)]
#[derive(Clone)]
pub(in crate::modpack) struct LocalClaimFixture {
    cache: PathBuf,
    filename: String,
    bytes: Arc<Vec<u8>>,
    registry: Arc<Registry>,
    operation: Arc<Mutex<Option<Arc<Operation>>>>,
    stage_path: Arc<Mutex<Option<PathBuf>>>,
    completion: tokio::sync::watch::Sender<Option<Result<()>>>,
}
#[cfg(test)]
#[derive(Debug)]
pub(in crate::modpack) struct ClaimSnapshot {
    pub(in crate::modpack) active: bool,
    pub(in crate::modpack) ready: usize,
    pub(in crate::modpack) in_use: usize,
    pub(in crate::modpack) cleaning: usize,
    pub(in crate::modpack) poisoned: bool,
    pub(in crate::modpack) holder_present: bool,
    pub(in crate::modpack) stage_exists: bool,
}
#[cfg(test)]
impl LocalClaimFixture {
    pub(in crate::modpack) fn new(cache: PathBuf, filename: String, bytes: Vec<u8>) -> Self {
        let (completion, _) = tokio::sync::watch::channel(None);
        Self { cache, filename, bytes: Arc::new(bytes), registry: Arc::new(Registry::default()), operation: Arc::new(Mutex::new(None)), stage_path: Arc::new(Mutex::new(None)), completion }
    }
    pub(in crate::modpack) async fn claim<F>(&self, parent: Arc<Cancel>, before_close: F) -> Result<ArchiveClaim>
    where F: FnOnce() -> Result<()> + Send + 'static {
        use std::io::Write;
        use sha2::{Digest, Sha256};
        parent.check()?;
        let filename = leaf(&self.filename)?.to_owned();
        let cache = self.cache.clone(); let bytes = self.bytes.clone(); let observed = self.operation.clone(); let stage_path = self.stage_path.clone();
        {
            let slot = self.operation.lock().map_err(|_| "本地来源夹具登记不可用")?;
            if slot.is_some() { return Err("本地来源夹具只能启动一次".into()); }
        }
        let session = start_transfer(self.registry.clone(), filename, parent, move |operation| {
            *observed.lock().expect("本地来源夹具登记锁") = Some(operation.clone());
            async move {
                let writer = operation.clone();
                let (file, result) = tauri::async_runtime::spawn_blocking(move || -> Result<_> {
                    let mut stage = Stage::create(&cache)?;
                    let mut file = stage.take_file()?;
                    *stage_path.lock().map_err(|_| "本地来源夹具路径观察不可用")? = Some(stage.test_directory_path()?);
                    *writer.holder.lock().map_err(|_| "本地来源夹具暂存登记不可用")? = Some(stage);
                    file.write_all(bytes.as_slice()).map_err(|_| "本地来源夹具写入失败")?;
                    // 屏障位于真实 writer 持有文件期间；取消后仍交给生产 flush/close。
                    before_close()?;
                    let digest = format!("{:x}", Sha256::digest(bytes.as_slice()));
                    Ok((file, (bytes.len() as u64, digest)))
                }).await.map_err(|_| "本地来源夹具 writer 异常".to_owned())??;
                finish_transfer(tokio::fs::File::from_std(file), operation, Ok(result)).await
            }
        })?;
        let TransferSession { notified, accepted, handoff, worker, receiver } = session;
        let completion = self.completion.clone();
        // 观察实际原 worker 的退出；不把 receive 返回或 ACK 当作真实 join。
        let monitor = tauri::async_runtime::spawn(async move {
            let result = worker.await.map_err(|_| "本地来源夹具 transfer worker 异常".to_owned());
            completion.send_replace(Some(result));
        });
        receive(notified, accepted, handoff, monitor, receiver).await
    }
    pub(in crate::modpack) fn snapshot(&self) -> Result<ClaimSnapshot> {
        let (active, ready, in_use, cleaning, poisoned) = {
            let state = self.registry.0.lock().map_err(|_| "本地来源夹具状态不可用")?;
            (state.active.is_some(), state.ready.len(), state.in_use.len(), state.cleaning.len(), state.poisoned)
        };
        let operation = self.operation.lock().map_err(|_| "本地来源夹具登记不可用")?.clone();
        let holder_present = match operation {
            Some(operation) => operation.holder.lock().map_err(|_| "本地来源夹具暂存状态不可用")?.is_some(),
            None => false,
        };
        // 即使 holder 已 take，也检查先前真实创建的目录是否确实消失。
        let stage_exists = self.stage_path.lock().map_err(|_| "本地来源夹具路径观察不可用")?.as_ref().is_some_and(|path| path.exists());
        Ok(ClaimSnapshot { active, ready, in_use, cleaning, poisoned, holder_present, stage_exists })
    }
    pub(in crate::modpack) async fn joined(&self) -> Result<()> {
        let mut completion = self.completion.subscribe();
        loop {
            if let Some(result) = completion.borrow().clone() { return result; }
            completion.changed().await.map_err(|_| "本地来源夹具 join 观察已关闭")?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::{fs, io::{Cursor, Write}, path::Path, sync::mpsc};
    use zip::{write::FileOptions, CompressionMethod, ZipWriter};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("hcmcl-url-claim-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap(); Self(fs::canonicalize(path).unwrap())
        }
        fn cache(&self) -> PathBuf { self.0.join("private/cache") }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    fn bytes() -> Vec<u8> {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        let options = FileOptions::default().compression_method(CompressionMethod::Stored);
        zip.start_file("launcher.packmeta", options).unwrap();
        zip.write_all(br#"{"name":"url-source","game_version":"1.21.1","mod_loader":"vanilla"}"#).unwrap();
        zip.start_file("overrides/config/example.txt", options).unwrap(); zip.write_all(b"source").unwrap();
        zip.finish().unwrap().into_inner()
    }
    fn operation(parent: &Arc<Cancel>) -> Arc<Operation> {
        Arc::new(Operation { cancel: parent.clone(), phase: AtomicU8::new(0), uncertain: AtomicBool::new(false), holder: Arc::new(Mutex::new(None)) })
    }
    fn store(cache: &Path, operation: &Arc<Operation>, before_close: impl FnOnce()) -> Result<(std::fs::File, (u64, String))> {
        let mut stage = Stage::create(cache)?;
        let mut file = stage.take_file()?;
        *operation.holder.lock().unwrap() = Some(stage);
        let bytes = bytes(); file.write_all(&bytes).unwrap();
        before_close();
        let digest = format!("{:x}", Sha256::digest(&bytes));
        // 真正的刷新、同步、into_std 关闭及 Stage.seal 只走生产 finish_transfer。
        Ok((file, (bytes.len() as u64, digest)))
    }
    struct Session {
        registry: Arc<Registry>, operation: Arc<Operation>, handoff: Arc<Handoff>,
        notified: oneshot::Receiver<Result<()>>, accepted: oneshot::Sender<()>, worker: tauri::async_runtime::JoinHandle<()>,
    }
    impl Session {
        fn spawn<F>(registry: Arc<Registry>, operation: Arc<Operation>, work: F) -> Self
        where F: Future<Output = Result<(u64, String)>> + Send + 'static {
            registry.0.lock().unwrap().reserve(operation.clone()).unwrap();
            let handoff = Arc::new(Handoff { claim: Mutex::new(None) });
            let (notify, notified) = oneshot::channel(); let (accepted, acknowledgment) = oneshot::channel();
            let lease = Lease { registry: registry.clone(), operation: operation.clone(), finished: false };
            let worker = tauri::async_runtime::spawn(own_transfer(lease, "source.zip".into(), handoff.clone(), notify, acknowledgment, work));
            Self { registry, operation, handoff, notified, accepted, worker }
        }
        async fn receive(self) -> Result<ArchiveClaim> {
            receive(self.notified, self.accepted, self.handoff, self.worker, ReceiverGuard { parent: self.operation.cancel.clone(), armed: true }).await
        }
    }
    fn stage_path(operation: &Arc<Operation>) -> PathBuf {
        operation.holder.lock().unwrap().as_ref().unwrap().test_directory_path().unwrap()
    }
    async fn sealed(cache: PathBuf, operation: Arc<Operation>) -> Result<(u64, String)> {
        let writer = operation.clone();
        let (file, result) = tauri::async_runtime::spawn_blocking(move || store(&cache, &writer, || {})).await.map_err(|_| "fixture store panic".to_owned())??;
        finish_transfer(tokio::fs::File::from_std(file), operation, Ok(result)).await
    }

    #[tokio::test]
    async fn direct_claim_enters_in_use_without_ready_ttl_or_token_and_reads_real_archive() {
        let fixture = Fixture::new(); let registry = Arc::new(Registry::default()); let parent = Arc::new(Cancel::default()); let operation = operation(&parent);
        let session = Session::spawn(registry.clone(), operation.clone(), sealed(fixture.cache(), operation.clone()));
        let claim = session.receive().await.unwrap(); let path = stage_path(&operation);
        {
            let state = registry.0.lock().unwrap();
            assert!(state.ready.is_empty()); assert!(state.cleaning.is_empty()); assert_eq!(state.in_use.len(), 1);
            assert!(state.check_probe(&claim.cap).is_err());
        }
        assert!(claim_in(registry.clone(), &claim.cap.id).is_err());
        let value = claim.read_archive(parent.clone(), |file, filename, cancel| { assert_eq!(filename, "source.zip"); cancel.check()?; super::super::super::parser::probe(file, Path::new(filename)) }).await.unwrap();
        assert_eq!(value["name"], "url-source"); assert!(!value.to_string().contains(&fixture.0.to_string_lossy().to_string()));
        claim.finish().await.unwrap(); assert!(!path.exists()); assert!(registry.0.lock().unwrap().in_use.is_empty());
        assert!(parent.check().is_ok());
    }

    #[tokio::test]
    async fn unreceived_success_is_explicitly_finished_before_active_and_budget_release() {
        let fixture = Fixture::new(); let registry = Arc::new(Registry::default()); let parent = Arc::new(Cancel::default()); let operation = operation(&parent);
        let session = Session::spawn(registry.clone(), operation.clone(), sealed(fixture.cache(), operation.clone()));
        let Session { mut notified, accepted, worker, .. } = session;
        (&mut notified).await.unwrap().unwrap();
        let path = stage_path(&operation);
        { let state = registry.0.lock().unwrap(); assert!(state.ready.is_empty()); assert_eq!(state.in_use.len(), 1); assert!(state.active.is_some()); }
        drop(accepted); drop(notified);
        worker.await.unwrap();
        let state = registry.0.lock().unwrap(); assert!(state.in_use.is_empty()); assert!(state.active.is_none()); assert!(!state.poisoned); assert!(!path.exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn parent_cancel_and_dropped_receiver_keep_active_until_writer_really_closes() {
        for drop_receiver in [false, true] {
            let fixture = Fixture::new(); let registry = Arc::new(Registry::default()); let parent = Arc::new(Cancel::default()); let operation = operation(&parent);
            let (entered, entered_rx) = oneshot::channel(); let (release, release_rx) = mpsc::channel();
            let cache = fixture.cache(); let write_operation = operation.clone();
            let work = async move {
                let finish_operation = write_operation.clone();
                let (file, result) = tauri::async_runtime::spawn_blocking(move || store(&cache, &write_operation, || { let _ = entered.send(()); release_rx.recv_timeout(Duration::from_secs(5)).unwrap(); })).await.map_err(|_| "fixture writer panic".to_owned())??;
                finish_transfer(tokio::fs::File::from_std(file), finish_operation, Ok(result)).await
            };
            let session = Session::spawn(registry.clone(), operation.clone(), work);
            let worker = session.worker;
            let (finished, finished_rx) = oneshot::channel();
            let monitor = tokio::spawn(async move { let _ = finished.send(worker.await); });
            let receive_worker = tauri::async_runtime::spawn(async move { let _ = finished_rx.await; });
            let handoff = session.handoff; let notified = session.notified; let accepted = session.accepted;
            let waiting_parent = parent.clone();
            let waiter = Some(tokio::spawn(receive(notified, accepted, handoff, receive_worker,
                ReceiverGuard { parent: waiting_parent, armed: true })));
            entered_rx.await.unwrap(); let path = stage_path(&operation);
            let remaining_waiter = if drop_receiver { let waiter = waiter.unwrap(); waiter.abort(); let _ = waiter.await; None } else { parent.stop(); waiter };
            let (busy, held) = { let mut state = registry.0.lock().unwrap(); (state.reserve(Arc::new(Operation::new())).is_err(), state.active.is_some()) };
            let stopped = parent.check().is_err(); let exists = path.exists();
            // 无论断言是否通过都先解除真实 writer 的屏障。
            release.send(()).unwrap();
            monitor.await.unwrap();
            if let Some(waiter) = remaining_waiter { let _ = waiter.await; }
            assert!(busy && held && stopped && exists);
            let state = registry.0.lock().unwrap(); assert!(state.active.is_none()); assert!(state.in_use.is_empty()); assert!(!path.exists());
        }
    }

    #[tokio::test]
    async fn unknown_cleanup_keeps_real_stage_active_and_blocks_new_reservations() {
        let fixture = Fixture::new(); let registry = Arc::new(Registry::default()); let parent = Arc::new(Cancel::default()); let operation = operation(&parent);
        let cache = fixture.cache(); let transfer_operation = operation.clone();
        let work = async move {
            let result = sealed(cache, transfer_operation.clone()).await?;
            fs::write(stage_path(&transfer_operation).join("unknown"), b"winner").unwrap();
            transfer_operation.cancel.stop(); Ok(result)
        };
        let session = Session::spawn(registry.clone(), operation.clone(), work);
        assert!(session.receive().await.is_err()); let path = stage_path(&operation);
        let mut state = registry.0.lock().unwrap(); assert!(state.poisoned); assert!(state.active.is_some()); assert!(state.in_use.is_empty());
        assert!(state.reserve(Arc::new(Operation::new())).is_err()); assert_eq!(fs::read(path.join("unknown")).unwrap(), b"winner"); assert!(path.join("payload").exists());
    }

    #[tokio::test]
    async fn returned_but_unfinished_claim_and_panicked_worker_never_release_unknown_budget() {
        let fixture = Fixture::new(); let registry = Arc::new(Registry::default()); let parent = Arc::new(Cancel::default()); let operation = operation(&parent);
        let session = Session::spawn(registry.clone(), operation.clone(), sealed(fixture.cache(), operation.clone()));
        let claim = session.receive().await.unwrap(); let path = stage_path(&operation); drop(claim);
        { let mut state = registry.0.lock().unwrap(); assert!(state.poisoned); assert_eq!(state.in_use.len(), 1); assert!(state.reserve(Arc::new(Operation::new())).is_err()); }
        assert!(path.exists());
        let registry = Arc::new(Registry::default()); let operation = Arc::new(Operation::new());
        let session = Session::spawn(registry.clone(), operation, async { panic!("synthetic direct transfer panic"); #[allow(unreachable_code)] Ok((1, String::new())) });
        assert!(session.receive().await.is_err());
        let mut state = registry.0.lock().unwrap(); assert!(state.poisoned); assert!(state.active.is_some()); assert!(state.reserve(Arc::new(Operation::new())).is_err());
    }

    #[tokio::test]
    async fn failed_transport_uses_real_flush_close_before_owned_cleanup() {
        let fixture = Fixture::new(); let registry = Arc::new(Registry::default()); let parent = Arc::new(Cancel::default()); let operation = operation(&parent);
        let cache = fixture.cache(); let writer = operation.clone();
        let (file, _) = tauri::async_runtime::spawn_blocking(move || store(&cache, &writer, || {})).await.unwrap().unwrap();
        let path = stage_path(&operation); let transfer_operation = operation.clone();
        let work = async move {
            let mut file = tokio::fs::File::from_std(file);
            file.write_all(b"unfinished transport bytes").await.map_err(|error| error.to_string())?;
            finish_transfer(file, transfer_operation, Err("fixture transport failed".into())).await
        };
        let session = Session::spawn(registry.clone(), operation, work);
        assert_eq!(session.receive().await.err().unwrap(), "fixture transport failed");
        let state = registry.0.lock().unwrap();
        assert!(state.active.is_none()); assert!(state.in_use.is_empty()); assert!(state.ready.is_empty()); assert!(!state.poisoned); assert!(!path.exists());
    }

    #[test]
    fn direct_reservation_uses_existing_global_count_and_byte_budget() {
        let registry = Arc::new(Registry::default());
        for _ in 0..TICKET_CAP {
            let cap = Arc::new(Capability { id: uuid::Uuid::new_v4().to_string(), filename: "old.zip".into(), created: Instant::now(), bytes: 1, holder: Arc::new(Mutex::new(None)), cancel: Arc::new(Cancel::default()), reader_gate: Arc::new(tokio::sync::Mutex::new(())) });
            registry.0.lock().unwrap().in_use.insert(cap.id.clone(), cap);
        }
        assert!(registry.0.lock().unwrap().reserve(Arc::new(Operation::new())).is_err());
        let mut state = State::default();
        let cap = Arc::new(Capability { id: uuid::Uuid::new_v4().to_string(), filename: "large.zip".into(), created: Instant::now(), bytes: CACHE_CAP - FILE_CAP + 1, holder: Arc::new(Mutex::new(None)), cancel: Arc::new(Cancel::default()), reader_gate: Arc::new(tokio::sync::Mutex::new(())) });
        state.in_use.insert(cap.id.clone(), cap); assert!(state.reserve(Arc::new(Operation::new())).is_err());
        let mut state = State::default(); state.closed = true; assert!(state.reserve(Arc::new(Operation::new())).is_err());
    }
}

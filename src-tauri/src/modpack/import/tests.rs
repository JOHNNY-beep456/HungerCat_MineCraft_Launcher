//! 仅使用合成临时文件与本地缓存；不启动 Java、不连接外网、不冒充游戏端到端。
use super::*;
use super::super::access::OpenedFile;
use sha1::{Digest, Sha1};
use std::{fs, io::Write, sync::Condvar, time::Duration};
use tokio::sync::oneshot;
use zip::{write::FileOptions, CompressionMethod, ZipWriter};

struct Fixture { root: PathBuf, archive: PathBuf }
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("hcmcl-pack-import-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let archive = root.join("source.mrpack");
        let mut archive_file = ZipWriter::new(fs::File::create(&archive).unwrap());
        let options = FileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, bytes) in [
            ("bundle/modrinth.index.json", br#"{"name":"fixture-pack","dependencies":{"minecraft":"1.20.1"},"files":[]}"#.as_slice()),
            ("bundle/overrides/config/options.txt", b"override".as_slice()),
            ("bundle/client-overrides/config/options.txt", b"client".as_slice()),
        ] {
            archive_file.start_file(name, options).unwrap(); archive_file.write_all(bytes).unwrap();
        }
        drop(archive_file.finish().unwrap());
        let result = Self { root, archive };
        let client = b"cached client fixture";
        result.file("versions/1.20.1/1.20.1.jar", client);
        result.file("versions/1.20.1/1.20.1.json", &serde_json::to_vec(&json!({
            "id":"1.20.1", "type":"release", "mainClass":"net.minecraft.client.main.Main", "libraries":[],
            "arguments":{"jvm":["-cp","${classpath}"],"game":["--gameDir","${game_directory}"]},
            "downloads":{"client":{"size":client.len(),"sha1":format!("{:x}",Sha1::digest(client))}}
        })).unwrap());
        result
    }
    fn file(&self, relative: &str, bytes: &[u8]) {
        let path = self.root.join(relative); fs::create_dir_all(path.parent().unwrap()).unwrap(); fs::write(path, bytes).unwrap();
    }
    fn raw_input(&self) -> (Input, Arc<AtomicBool>) {
        let allowed = Arc::new(AtomicBool::new(true));
        let input = Input::Fixture { opened: Arc::new(Mutex::new(Some(OpenedFile::open(&self.archive).unwrap()))), name: "source.mrpack".into(), allowed: allowed.clone() };
        (input, allowed)
    }
    fn input(&self) -> (Arc<Input>, Arc<AtomicBool>) {
        let (input, allowed) = self.raw_input(); (Arc::new(input), allowed)
    }
    fn active(&self, target: &str) -> (String, Arc<Operation>, Arc<Ledger>, Arc<Input>, Arc<AtomicBool>) {
        let operation = Arc::new(Operation::new()); let ledger = Arc::new(Ledger::new());
        let (source, allowed) = self.input(); *ledger.source.lock().unwrap() = Some(source.clone());
        let key = register(operation.clone(), ledger.clone()).unwrap(); set_target(&key, target).unwrap();
        (key, operation, ledger, source, allowed)
    }
    async fn prepared(&self, target: &str) -> (String, Arc<Operation>, Arc<Ledger>, Arc<Input>, Arc<AtomicBool>) {
        let (key, operation, ledger, source, allowed) = self.active(target);
        let anchor = Arc::new(Directory::open(&self.root).unwrap());
        *ledger.anchor.lock().unwrap() = Some(anchor);
        let job = JobGuard::register(&self.root, target).unwrap(); operation.attach(job.cancel()).unwrap();
        *ledger.job.lock().unwrap() = Some(job);
        let guard = crate::install_lock::acquire(&self.root, || false).await.unwrap();
        *ledger.root.lock().unwrap() = Some(guard);
        create_stage(&ledger, &self.root, target, &operation.token().unwrap()).unwrap();
        (key, operation, ledger, source, allowed)
    }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); } }
fn sink() -> Sink { Arc::new(|_| {}) }
fn hidden_stages(root: &Path) -> Vec<PathBuf> {
    fs::read_dir(root.join("versions")).unwrap().map(|entry| entry.unwrap().path()).filter(|path| path.file_name().unwrap().to_string_lossy().starts_with(".hcmcl-modpack-stage-")).collect()
}
async fn finish_run(fixture: &Fixture, custom: Option<String>, sink: Sink) -> (Result<Value>, Arc<Ledger>, Arc<Operation>, Arc<Input>) {
    let target = custom.clone().unwrap_or_else(|| "fixture-pack".into());
    let (key, operation, ledger, source, _) = fixture.active(&target);
    let child_operation = operation.clone(); let child_ledger = ledger.clone(); let child_key = key.clone(); let child_sink = sink.clone(); let root = fixture.root.clone();
    let child = tokio::spawn(async move { run(&root, custom, &json!({"mode":"normal"}), &child_key, &child_operation, &child_ledger, &child_sink).await });
    let result = supervise(child, key, operation.clone(), ledger.clone(), sink).await;
    (result, ledger, operation, source)
}

#[tokio::test]
async fn cached_vanilla_import_uses_real_receipts_phases_marker_and_object_result() {
    let fixture = Fixture::new();
    let (result, ledger, operation, source) = finish_run(&fixture, Some("定制实例".into()), sink()).await;
    assert_eq!(result.unwrap(), json!({"versionId":"定制实例","name":"定制实例"}));
    let target = fixture.root.join("versions/定制实例");
    assert_eq!(fs::read(target.join("config/options.txt")).unwrap(), b"client");
    let profile: Value = serde_json::from_slice(&fs::read(target.join("定制实例.json")).unwrap()).unwrap();
    assert_eq!(profile["id"], "定制实例"); assert_eq!(profile["jar"], "1.20.1"); assert_eq!(profile["clientVersion"], "1.20.1"); assert!(profile.get("inheritsFrom").is_none());
    let marker: Value = serde_json::from_slice(&fs::read(target.join("instance.json")).unwrap()).unwrap();
    assert_eq!(marker, json!({"isolation":true,"name":"定制实例"}));
    assert!(target.join("natives/.extract-stamp").is_file()); assert!(!target.join(".hcmcl-modpack-stage-owner").exists());
    assert!(hidden_stages(&fixture.root).is_empty()); assert!(ledger.published.load(Ordering::Acquire));
    assert!(ledger.root.lock().unwrap().is_none()); assert!(ledger.job.lock().unwrap().is_none());
    assert!(source.check(&Cancel::default()).is_err()); assert!(operation.request_cancel().unwrap_err().contains("已发布"));
    let probe = JobGuard::register(&fixture.root, "定制实例").unwrap(); drop(probe);
    drop(crate::install_lock::acquire(&fixture.root, || false).await.unwrap());
}

#[tokio::test]
async fn cached_import_preserves_existing_target_and_closes_source_without_sticky_state() {
    let fixture = Fixture::new(); fixture.file("versions/fixture-pack/keep.txt", b"existing world");
    let (result, ledger, _, source) = finish_run(&fixture, None, sink()).await;
    assert!(result.unwrap_err().contains("目标已存在"));
    assert_eq!(fs::read(fixture.root.join("versions/fixture-pack/keep.txt")).unwrap(), b"existing world");
    assert!(!fixture.root.join("versions/fixture-pack/fixture-pack.json").exists()); assert!(hidden_stages(&fixture.root).is_empty());
    assert!(!ledger.unknown.load(Ordering::Acquire)); assert!(ledger.root.lock().unwrap().is_none()); assert!(source.check(&Cancel::default()).is_err());
}

#[tokio::test]
async fn source_revocation_after_build_cleans_registered_outputs_and_never_publishes() {
    let fixture = Fixture::new();
    let (key, operation, ledger, source, allowed) = fixture.active("fixture-pack");
    let revoke = allowed.clone(); let report: Sink = Arc::new(move |event| { if event["task"].as_str() == Some("绑定并安装整合包成员") { revoke.store(false, Ordering::Release); } });
    let op = operation.clone(); let book = ledger.clone(); let task = key.clone(); let root = fixture.root.clone(); let output = report.clone();
    let child = tokio::spawn(async move { run(&root, None, &json!({"mode":"normal"}), &task, &op, &book, &output).await });
    let error = supervise(child, key, operation, ledger.clone(), report).await.unwrap_err();
    assert!(error.contains("授权已撤销")); assert!(!fixture.root.join("versions/fixture-pack").exists()); assert!(hidden_stages(&fixture.root).is_empty());
    assert!(!ledger.unknown.load(Ordering::Acquire)); assert!(ledger.root.lock().unwrap().is_none()); assert!(source.check(&Cancel::default()).is_err());
}

/// 屏障超时只防止断言失败时拖死测试进程；正常路径用显式通知，不靠 sleep 猜测调度。
struct Barrier { entered: Mutex<Option<oneshot::Sender<()>>>, released: Mutex<bool>, wake: Condvar }
impl Barrier {
    fn new() -> (Arc<Self>, oneshot::Receiver<()>) { let (sender, receiver) = oneshot::channel(); (Arc::new(Self { entered: Mutex::new(Some(sender)), released: Mutex::new(false), wake: Condvar::new() }), receiver) }
    fn wait(&self) -> Result<()> {
        if let Some(sender) = self.entered.lock().map_err(|_| "夹具屏障通知不可用")?.take() { let _ = sender.send(()); }
        let lock = self.released.lock().map_err(|_| "夹具屏障不可用")?;
        let (lock, result) = self.wake.wait_timeout_while(lock, Duration::from_secs(5), |released| !*released).map_err(|_| "夹具屏障等待失败")?;
        if result.timed_out() && !*lock { Err("夹具屏障超时".into()) } else { Ok(()) }
    }
    fn release(&self) { *self.released.lock().unwrap() = true; self.wake.notify_all(); }
}

#[tokio::test]
async fn ipc_drop_only_signals_and_supervisor_keeps_job_and_root_until_real_writer_returns() {
    let fixture = Fixture::new(); let (key, operation, ledger, source, _) = fixture.prepared("blocked").await;
    let path = ledger.stage_path().unwrap();
    let (barrier, entered) = Barrier::new(); let child_barrier = barrier.clone(); let book = ledger.clone(); let op = operation.clone();
    let child = tokio::spawn(async move {
        let work_book = book.clone();
        blocking(&book, move || {
            child_barrier.wait()?;
            // 模拟已在执行的同步 writer 返回前仍有一次合法写入；台账由外层保留。
            work_book.stage.lock().map_err(|_| "夹具实例台账不可用")?.as_mut().ok_or("夹具实例丢失")?.write("config/late.txt", &b"joined"[..], 6, false, &Cancel::default())?;
            op.check()?; Ok(json!({"unexpected":true}))
        }).await
    });
    let supervisor = tokio::spawn(supervise(child, key.clone(), operation.clone(), ledger.clone(), sink()));
    tokio::time::timeout(Duration::from_secs(5), entered).await.unwrap().unwrap();
    drop(Waiting { operation: operation.clone(), armed: true });
    assert!(operation.check().is_err()); assert!(!supervisor.is_finished()); assert!(path.is_dir());
    assert!(JobGuard::register(&fixture.root, "blocked").is_err()); assert!(ledger.root.lock().unwrap().is_some());
    assert!(window().lock().unwrap().entries.contains_key(&key)); assert!(source.check(&Cancel::default()).is_ok());
    barrier.release(); assert!(supervisor.await.unwrap().is_err());
    assert!(!path.exists()); assert!(!fixture.root.join("versions/blocked").exists()); assert!(ledger.root.lock().unwrap().is_none());
    assert!(!window().lock().unwrap().entries.contains_key(&key)); assert!(source.check(&Cancel::default()).is_err());
    drop(JobGuard::register(&fixture.root, "blocked").unwrap()); drop(crate::install_lock::acquire(&fixture.root, || false).await.unwrap());
}

async fn successful_build_handoff_after_stop(revoke: bool) {
    let fixture = Fixture::new();
    let target = if revoke { "receipt-revoked" } else { "receipt-cancelled" };
    let (key, operation, ledger, source, allowed) = fixture.prepared(target).await;
    let staging = ledger.stage_path().unwrap();
    let asset = b"handoff legacy resource"; let asset_hash = format!("{:x}", Sha1::digest(asset));
    fixture.file(&format!("assets/objects/{}/{asset_hash}", &asset_hash[..2]), asset);
    let index = serde_json::to_vec(&json!({"map_to_resources":true,"objects":{"dir/fixture.txt":{"hash":asset_hash,"size":asset.len()}}})).unwrap();
    fixture.file("assets/indexes/handoff.json", &index);
    let native_path = "libraries/fixture/native/1/native-1-natives-fixture.jar";
    let native_file = fixture.root.join(native_path); fs::create_dir_all(native_file.parent().unwrap()).unwrap();
    let mut archive = ZipWriter::new(fs::File::create(&native_file).unwrap());
    archive.start_file("dir/native.bin", FileOptions::default().compression_method(CompressionMethod::Stored)).unwrap();
    archive.write_all(b"handoff native").unwrap(); drop(archive.finish().unwrap());
    let native = fs::read(&native_file).unwrap();
    let mut profile: Value = serde_json::from_slice(&fs::read(fixture.root.join("versions/1.20.1/1.20.1.json")).unwrap()).unwrap();
    profile["id"] = json!(target); profile["clientVersion"] = json!("1.20.1"); profile["jar"] = json!("1.20.1");
    profile["assetIndex"] = json!({"id":"handoff","sha1":format!("{:x}",Sha1::digest(&index)),"size":index.len()});
    profile["libraries"] = json!([{"name":"fixture:native:1:natives-fixture","downloads":{"artifact":{"path":"fixture/native/1/native-1-natives-fixture.jar","url":"","size":native.len(),"sha1":format!("{:x}",Sha1::digest(&native))}}}]);
    let (barrier, entered) = Barrier::new();
    let child_barrier = barrier.clone(); let root = fixture.root.clone(); let stage = staging.clone();
    let book = ledger.clone(); let op = operation.clone(); let child_source = source.clone();
    let child = tokio::spawn(async move {
        let token = op.token()?;
        let progress = Progress::new("receipt-handoff".into(), "合成回执交接".into(), sink());
        let settings = json!({"mode":"normal"});
        let future = async {
            // 真实生成器已成功返回完整回执；屏障只暂停交接，绝不重新生成或扫描收养路径。
            let built = downloads::build_instance_with_files_under_guard(profile, &root, &stage, &settings, token, &progress).await?;
            assert!(built.files.iter().any(|file| file.path == "natives/.extract-stamp"));
            assert!(built.files.iter().any(|file| file.path == "resources/dir/fixture.txt"));
            tokio::task::spawn_blocking(move || child_barrier.wait()).await.map_err(|_| "夹具交接屏障异常".to_owned())??;
            Ok(built)
        };
        build_and_register(&book, &op, &child_source, future).await
    });
    let supervisor = tokio::spawn(supervise(child, key.clone(), operation.clone(), ledger.clone(), sink()));
    tokio::time::timeout(Duration::from_secs(5), entered).await.unwrap().unwrap();
    assert!(staging.join("natives/.extract-stamp").is_file());
    assert_eq!(fs::read(staging.join("resources/dir/fixture.txt")).unwrap(), asset);
    if !cfg!(target_os="android") { assert_eq!(fs::read(staging.join("natives/dir/native.bin")).unwrap(), b"handoff native"); }
    assert!(ledger.generated.lock().unwrap().is_none());
    if revoke { allowed.store(false, Ordering::Release); } else { operation.request_cancel().unwrap(); }
    assert!(!supervisor.is_finished()); assert!(JobGuard::register(&fixture.root, target).is_err());
    barrier.release();
    let error = supervisor.await.unwrap().unwrap_err();
    if revoke { assert!(error.contains("授权已撤销")); }
    assert!(!error.contains("收尾未确认")); assert!(!error.contains("保持忙碌"));
    assert!(!ledger.unknown.load(Ordering::Acquire)); assert!(ledger.generated.lock().unwrap().is_none());
    assert!(hidden_stages(&fixture.root).is_empty()); assert!(!fixture.root.join("versions").join(target).exists());
    assert!(ledger.stage.lock().unwrap().is_none()); assert!(ledger.root.lock().unwrap().is_none()); assert!(ledger.job.lock().unwrap().is_none());
    assert!(!window().lock().unwrap().entries.contains_key(&key)); assert!(source.check(&Cancel::default()).is_err());
    drop(JobGuard::register(&fixture.root, target).unwrap()); drop(crate::install_lock::acquire(&fixture.root, || false).await.unwrap());
}

#[tokio::test]
async fn successful_build_receipts_register_before_terminal_cancellation() { successful_build_handoff_after_stop(false).await; }
#[tokio::test]
async fn successful_build_receipts_register_before_terminal_source_revocation() { successful_build_handoff_after_stop(true).await; }

#[tokio::test]
async fn cancellation_and_source_revocation_are_checked_at_the_actual_commit_gate() {
    let fixture = Fixture::new(); let (key, operation, ledger, source, allowed) = fixture.prepared("gate").await;
    ledger.stage.lock().unwrap().as_mut().unwrap().write("config/a", &b"a"[..], 1, false, &Cancel::default()).unwrap();
    allowed.store(false, Ordering::Release);
    assert!(commit(&ledger, &operation, &source).unwrap_err().contains("授权已撤销")); assert!(!fixture.root.join("versions/gate").exists());
    allowed.store(true, Ordering::Release); cancel_download(Some("gate")).unwrap();
    assert!(commit(&ledger, &operation, &source).is_err()); assert!(!fixture.root.join("versions/gate").exists());
    let child = tokio::spawn(async { Err("夹具已取消".into()) });
    assert!(supervise(child, key, operation, ledger.clone(), sink()).await.is_err()); assert!(!ledger.unknown.load(Ordering::Acquire));
}

#[tokio::test]
async fn unresolved_cleanup_keeps_real_stage_job_root_and_cancel_entry_busy() {
    let fixture = Fixture::new(); let (key, operation, ledger, source, _) = fixture.prepared("sticky").await;
    let path = ledger.stage_path().unwrap(); fs::write(path.join("unknown.txt"), b"unregistered").unwrap();
    let child = tokio::spawn(async { Err("夹具工作失败".into()) });
    let error = supervise(child, key.clone(), operation.clone(), ledger.clone(), sink()).await.unwrap_err();
    assert!(error.contains("暂存清理未确认")); assert!(error.contains("保持忙碌")); assert!(ledger.unknown.load(Ordering::Acquire));
    assert!(path.join("unknown.txt").is_file()); assert!(!fixture.root.join("versions/sticky").exists()); assert!(JobGuard::register(&fixture.root, "sticky").is_err());
    assert!(ledger.root.lock().unwrap().is_some()); assert!(window().lock().unwrap().entries.contains_key(&key));
    assert!(operation.request_cancel().unwrap_err().contains("收尾状态未确认")); assert!(source.check(&Cancel::default()).is_err());
    // 只清除此测试自己制造的未知文件；生产不得扫描收养或强删未知树。
    fs::remove_file(path.join("unknown.txt")).unwrap(); ledger.stage.lock().unwrap().as_mut().unwrap().cleanup().unwrap(); ledger.stage.lock().unwrap().take();
    ledger.root.lock().unwrap().take(); ledger.job.lock().unwrap().take(); ledger.anchor.lock().unwrap().take(); window().lock().unwrap().entries.remove(&key);
}

#[tokio::test]
async fn panic_is_retained_as_unknown_even_when_known_stage_cleanup_succeeds() {
    let fixture = Fixture::new(); let (key, operation, ledger, _, _) = fixture.prepared("panic").await;
    let child = tokio::spawn(async { panic!("合成导入工作任务异常"); #[allow(unreachable_code)] Ok(Value::Null) });
    assert!(supervise(child, key.clone(), operation, ledger.clone(), sink()).await.unwrap_err().contains("状态未确认"));
    assert!(ledger.unknown.load(Ordering::Acquire)); assert!(ledger.root.lock().unwrap().is_some()); assert!(JobGuard::register(&fixture.root, "panic").is_err());
    ledger.stage.lock().unwrap().take(); ledger.root.lock().unwrap().take(); ledger.job.lock().unwrap().take(); ledger.anchor.lock().unwrap().take(); window().lock().unwrap().entries.remove(&key);
}

#[tokio::test]
async fn both_source_entries_share_the_real_scheduler_and_complete_only_after_source_finish() {
    let fixture = Fixture::new();
    for (index, request) in [Request::Existing("authorized-fixture".into()), Request::Url { url:"https://example.com/pack?private=fixture".into(), filename:"source.mrpack".into() }].into_iter().enumerate() {
        let target = format!("shared-entry-{index}"); let (input, _) = fixture.raw_input();
        let observed = Arc::new(Mutex::new(None::<Arc<Ledger>>)); let captured = observed.clone();
        let events = Arc::new(Mutex::new(Vec::new())); let captured_events = events.clone(); let callback_ledger = observed.clone();
        let sink: Sink = Arc::new(move |value| {
            if value["percent"].as_f64() == Some(100.0) {
                let ledger = callback_ledger.lock().unwrap().clone().unwrap();
                assert!(ledger.source.lock().unwrap().is_none()); assert!(ledger.root.lock().unwrap().is_none()); assert!(ledger.job.lock().unwrap().is_none());
            }
            captured_events.lock().unwrap().push(value);
        });
        let custom = format!("  {target}  ");
        let result = start_with_opener(&fixture.root, request, Some(&custom), &json!({"mode":"normal"}), sink, move |request, operation, ledger, report| async move {
            assert!(operation.check().is_ok()); assert!(ledger.job.lock().unwrap().is_none()); assert!(ledger.root.lock().unwrap().is_none());
            *captured.lock().unwrap() = Some(ledger.clone());
            if matches!(request, Request::Url { .. }) {
                // 真调度入口只注入来源打开；恶意上游文本不会穿过生产进度适配器。
                report(json!({"taskId":"wrong-download-job","jobTitle":"https://example.com/?secret=fixture","task":"https://example.com/private","phase":"done","percent":100.0,"currentBytes":99,"totalBytes":99,"url":"https://example.com/private"}));
            }
            let rejected = record_source(&ledger, input);
            finish_rejected_source(&ledger, rejected).await
        }).await.unwrap();
        assert_eq!(result, json!({"versionId":target,"name":target}));
        let events = events.lock().unwrap();
        assert_eq!(events.iter().filter(|value| value["percent"].as_f64() == Some(100.0)).count(), 1);
        let id = events[0]["taskId"].as_str().unwrap(); assert!(id.starts_with("modpack-import:"));
        assert!(events.iter().all(|value| value["taskId"].as_str() == Some(id)));
        if index == 1 {
            assert_eq!(events[0]["jobTitle"], format!("导入整合包 {target}")); assert_eq!(events[0]["phase"], "mod");
            assert_eq!(events[0]["percent"], 99.9); assert_eq!(events[0]["currentBytes"], 99);
            assert!(!events[0].to_string().contains("secret")); assert!(!events[0].to_string().contains("https://"));
        }
    }
}

async fn source_download_stop_joins_before_closing_late_source(drop_waiter: bool) {
    let fixture = Fixture::new(); let (input, _) = fixture.raw_input();
    let (barrier, entered) = Barrier::new(); let child_barrier = barrier.clone();
    let observed = Arc::new(Mutex::new(None::<(Arc<Operation>, Arc<Ledger>)>)); let captured = observed.clone();
    let events = Arc::new(Mutex::new(Vec::new())); let captured_events = events.clone();
    let (done, completed) = oneshot::channel(); let done = Arc::new(Mutex::new(Some(done))); let done_state = observed.clone();
    let sink: Sink = Arc::new(move |value| {
        if value["phase"] == "done" {
            let (_, ledger) = done_state.lock().unwrap().clone().unwrap();
            assert!(ledger.source.lock().unwrap().is_none());
            captured_events.lock().unwrap().push(value);
            if let Some(done) = done.lock().unwrap().take() { let _ = done.send(()); }
        } else { captured_events.lock().unwrap().push(value); }
    });
    let root = fixture.root.clone();
    let waiter = tokio::spawn(async move {
        start_with_opener(&root, Request::Url { url:"https://example.com/fixture?private=1".into(), filename:"source.mrpack".into() }, None, &json!({"mode":"normal"}), sink, move |_, operation, ledger, report| async move {
            report(json!({"percent":1})); *captured.lock().unwrap() = Some((operation.clone(), ledger.clone()));
            tokio::task::spawn_blocking(move || child_barrier.wait()).await.map_err(|_| "夹具来源下载屏障异常".to_owned())??;
            // 模拟下载已返回成功 Claim：即使入口已取消也必须先入账，之后才检查。
            let rejected = record_source(&ledger, input);
            finish_rejected_source(&ledger, rejected).await
        }).await
    });
    tokio::time::timeout(Duration::from_secs(5), entered).await.unwrap().unwrap();
    let (operation, ledger) = observed.lock().unwrap().clone().unwrap();
    let task = events.lock().unwrap()[0]["taskId"].as_str().unwrap().to_owned();
    let waiter = if drop_waiter {
        // 不预先调用公共取消；由真实入口 Future 的 Waiting::drop 独立发停止信号。
        waiter.abort(); assert!(waiter.await.unwrap_err().is_cancelled()); None
    } else { cancel_download(Some(&task)).unwrap(); Some(waiter) };
    assert!(operation.cancel.check().is_err()); assert!(ledger.source.lock().unwrap().is_none());
    assert!(ledger.job.lock().unwrap().is_none()); assert!(ledger.root.lock().unwrap().is_none());
    let key = task.strip_prefix("modpack-import:").unwrap();
    assert!(window().lock().unwrap().entries.contains_key(key));
    // 同一个生产 sink 的终态通知发生在来源关闭、登记移除之后。
    barrier.release(); tokio::time::timeout(Duration::from_secs(5), completed).await.unwrap().unwrap();
    if let Some(waiter) = waiter { assert!(waiter.await.unwrap().is_err()); }
    assert!(!window().lock().unwrap().entries.contains_key(key));
    assert!(!ledger.unknown.load(Ordering::Acquire)); assert!(!fixture.root.join("versions/source").exists());
    assert!(!events.lock().unwrap().iter().any(|value| value["percent"].as_f64() == Some(100.0)));
}

#[tokio::test]
async fn source_download_cancel_joins_before_closing_late_source() { source_download_stop_joins_before_closing_late_source(false).await; }
#[tokio::test]
async fn source_download_drop_signals_parent_and_supervisor_joins_before_closing_late_source() { source_download_stop_joins_before_closing_late_source(true).await; }

#[tokio::test]
async fn rejected_source_registration_explicitly_finishes_even_with_poisoned_ledger() {
    let fixture = Fixture::new();
    for poison in [false, true] {
        let ledger = Arc::new(Ledger::new());
        if poison {
            let poisoned = ledger.clone();
            assert!(std::thread::spawn(move || { let _slot = poisoned.source.lock().unwrap(); panic!("合成来源台账故障"); }).join().is_err());
        } else {
            let (existing, _) = fixture.raw_input(); assert!(record_source(&ledger, existing).is_none());
        }
        let (late, _) = fixture.raw_input();
        let opened = match &late { Input::Fixture { opened, .. } => opened.clone(), _ => unreachable!() };
        let rejected = record_source(&ledger, late); assert!(rejected.is_some()); assert!(opened.lock().unwrap().is_some());
        assert!(finish_rejected_source(&ledger, rejected).await.unwrap_err().contains("来源已显式关闭"));
        assert!(opened.lock().unwrap().is_none()); assert!(!ledger.unknown.load(Ordering::Acquire));
        if poison { assert!(cleanup(&ledger).await.is_err()); assert!(ledger.unknown.load(Ordering::Acquire)); }
        else { cleanup(&ledger).await.unwrap(); assert!(ledger.source.lock().unwrap().is_none()); }
    }
}

#[tokio::test]
async fn invalid_source_arguments_return_before_registration_or_opener() {
    let fixture = Fixture::new();
    let cases = vec![
        (Request::Url { url:"http://example.com/private?secret=1".into(), filename:"source.zip".into() }, None, json!({})),
        (Request::Url { url:"https://127.0.0.1/private?secret=1".into(), filename:"source.zip".into() }, None, json!({})),
        (Request::Url { url:"https://example.com/pack".into(), filename:"../escape.zip".into() }, None, json!({})),
        (Request::Url { url:"https://example.com/pack".into(), filename:"source.zip".into() }, Some("../escape"), json!({})),
        (Request::Url { url:"https://example.com/pack".into(), filename:"source.zip".into() }, None, json!({"mode":"local"})),
        (Request::Existing(String::new()), None, json!({})),
        (Request::Existing("fixture".into()), None, json!({"metadataOnlyMods":true})),
    ];
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    for (request, custom, settings) in cases {
        let called = calls.clone();
        let error = start_with_opener(&fixture.root, request, custom, &settings, sink(), move |_, _, _, _| async move {
            called.fetch_add(1, Ordering::AcqRel); Err("不应调用夹具来源打开器".into())
        }).await.unwrap_err();
        assert!(!error.contains("secret")); assert!(!error.contains("https://")); assert!(!error.contains("http://"));
    }
    assert_eq!(calls.load(Ordering::Acquire), 0);
}

/// 组合夹具只替换网络字节；Claim、Source/Input、run 和 supervisor 都使用生产实现。
type DirectObserved = Arc<Mutex<Option<(Arc<Operation>, Arc<Ledger>)>>>;
struct ReleaseBarrier(Arc<Barrier>);
impl Drop for ReleaseBarrier { fn drop(&mut self) { self.0.release(); } }
fn local_claim(fixture: &Fixture) -> super::super::download::LocalClaimFixture {
    super::super::download::LocalClaimFixture::new(fixture.root.join("private/url-cache"), "source.mrpack".into(), fs::read(&fixture.archive).unwrap())
}
async fn start_direct_fixture<F>(root: PathBuf, target: String, transfer: super::super::download::LocalClaimFixture, observed: DirectObserved, sink: Sink, before_close: F) -> Result<Value>
where F: FnOnce() -> Result<()> + Send + 'static {
    start_with_opener(&root, Request::Url { url: "https://example.com/fixture?private=local".into(), filename: "source.mrpack".into() }, Some(&target), &json!({"mode":"normal"}), sink,
        move |request, operation, ledger, _report| async move {
            assert!(matches!(request, Request::Url { .. }));
            *observed.lock().unwrap() = Some((operation.clone(), ledger.clone()));
            let result = transfer.claim(operation.cancel.clone(), before_close).await;
            // 成功结果不经任何检查或挂起，直接进入同一个生产入账 helper。
            record_url_result(&ledger, &operation, result).await
        }).await
}
fn assert_direct_released(transfer: &super::super::download::LocalClaimFixture) {
    let state = transfer.snapshot().unwrap();
    assert!(!state.active && !state.poisoned && !state.holder_present && !state.stage_exists, "{state:?}");
    assert_eq!((state.ready, state.in_use, state.cleaning), (0, 0, 0));
}
fn assert_import_released(ledger: &Arc<Ledger>, task: &str) {
    assert!(!ledger.unknown.load(Ordering::Acquire));
    assert!(ledger.source.lock().unwrap().is_none()); assert!(ledger.stage.lock().unwrap().is_none());
    assert!(ledger.root.lock().unwrap().is_none()); assert!(ledger.job.lock().unwrap().is_none());
    assert!(ledger.generated.lock().unwrap().is_none());
    assert!(!window().lock().unwrap().entries.contains_key(task.strip_prefix("modpack-import:").unwrap()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn direct_claim_to_controlled_source_runs_and_finishes_real_import() {
    let fixture = Fixture::new(); let transfer = local_claim(&fixture); let observed: DirectObserved = Arc::new(Mutex::new(None));
    let events = Arc::new(Mutex::new(Vec::<Value>::new())); let captured_events = events.clone();
    let checkpoint = Arc::new(Mutex::new(None)); let captured_checkpoint = checkpoint.clone();
    let books = observed.clone(); let cache = transfer.clone();
    let sink: Sink = Arc::new(move |event| {
        let (_, ledger) = books.lock().unwrap().clone().unwrap();
        if event["task"] == "绑定并安装整合包成员" {
            let controlled = matches!(ledger.source.lock().unwrap().as_deref(), Some(Input::Controlled(_)));
            let held = ledger.job.lock().unwrap().is_some() && ledger.root.lock().unwrap().is_some();
            let state = cache.snapshot().unwrap();
            *captured_checkpoint.lock().unwrap() = Some((controlled, held, state.in_use == 1 && state.ready == 0 && state.holder_present && state.stage_exists));
        }
        if event["phase"] == "done" {
            assert!(ledger.source.lock().unwrap().is_none()); assert!(ledger.job.lock().unwrap().is_none()); assert!(ledger.root.lock().unwrap().is_none());
            let state = cache.snapshot().unwrap();
            assert!(!state.poisoned && !state.holder_present && !state.stage_exists);
            assert_eq!((state.ready, state.in_use, state.cleaning), (0, 0, 0));
        }
        captured_events.lock().unwrap().push(event);
    });
    let result = start_direct_fixture(fixture.root.clone(), "direct-success".into(), transfer.clone(), observed.clone(), sink, || Ok(())).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), transfer.joined()).await.unwrap().unwrap();
    assert_eq!(result, json!({"versionId":"direct-success","name":"direct-success"}));
    assert_eq!(*checkpoint.lock().unwrap(), Some((true, true, true)));
    let target = fixture.root.join("versions/direct-success");
    assert_eq!(fs::read(target.join("config/options.txt")).unwrap(), b"client");
    let profile: Value = serde_json::from_slice(&fs::read(target.join("direct-success.json")).unwrap()).unwrap();
    assert_eq!(profile["id"], "direct-success"); assert_eq!(profile["clientVersion"], "1.20.1"); assert_eq!(profile["jar"], "1.20.1");
    let marker: Value = serde_json::from_slice(&fs::read(target.join("instance.json")).unwrap()).unwrap();
    assert_eq!(marker, json!({"isolation":true,"name":"direct-success"})); assert!(target.join("natives/.extract-stamp").is_file());
    assert!(!target.join(".hcmcl-modpack-stage-owner").exists()); assert!(hidden_stages(&fixture.root).is_empty());
    let (_, ledger) = observed.lock().unwrap().clone().unwrap(); let events = events.lock().unwrap().clone();
    let task = events[0]["taskId"].as_str().unwrap(); assert_import_released(&ledger, task); assert_direct_released(&transfer);
    assert_eq!(events.iter().filter(|event| event["percent"].as_f64() == Some(100.0)).count(), 1);
    assert!(events.iter().all(|event| event["taskId"].as_str() == Some(task)));
    drop(JobGuard::register(&fixture.root, "direct-success").unwrap());
    drop(crate::install_lock::acquire(&fixture.root, || false).await.unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn direct_source_writer_ipc_abort_waits_for_real_close_and_cleanup() {
    let fixture = Fixture::new(); let transfer = local_claim(&fixture); let observed: DirectObserved = Arc::new(Mutex::new(None));
    let (barrier, entered) = Barrier::new(); let release = ReleaseBarrier(barrier.clone()); let writer_barrier = barrier.clone();
    let events = Arc::new(Mutex::new(Vec::<Value>::new())); let captured = events.clone();
    let (done, completed) = oneshot::channel(); let done = Arc::new(Mutex::new(Some(done)));
    let sink: Sink = Arc::new(move |event| {
        let terminal = event["phase"] == "done";
        captured.lock().unwrap().push(event);
        if terminal { if let Some(done) = done.lock().unwrap().take() { let _ = done.send(()); } }
    });
    let root = fixture.root.clone(); let cache = transfer.clone(); let books = observed.clone();
    let waiter = tokio::spawn(start_direct_fixture(root, "direct-writer-abort".into(), cache, books, sink, move || writer_barrier.wait()));
    tokio::time::timeout(Duration::from_secs(5), entered).await.unwrap().unwrap();
    let (operation, ledger) = observed.lock().unwrap().clone().unwrap();
    waiter.abort(); assert!(waiter.await.unwrap_err().is_cancelled());
    let state = transfer.snapshot().unwrap();
    let stopped = operation.cancel.check().is_err();
    let no_early_resources = ledger.source.lock().unwrap().is_none() && ledger.job.lock().unwrap().is_none() && ledger.root.lock().unwrap().is_none();
    let registered = window().lock().unwrap().entries.values().any(|entry| Arc::ptr_eq(&entry.operation, &operation));
    let no_terminal = !events.lock().unwrap().iter().any(|event| event["phase"] == "done");
    // 先释放真实 writer，再断言；RAII 同时覆盖之前的 panic/超时路径。
    drop(release);
    tokio::time::timeout(Duration::from_secs(5), transfer.joined()).await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(5), completed).await.unwrap().unwrap();
    assert!(stopped && no_early_resources && registered && no_terminal);
    assert!(state.active && state.holder_present && state.stage_exists && !state.poisoned); assert_eq!(state.in_use, 0);
    let events = events.lock().unwrap().clone(); let task = events.last().unwrap()["taskId"].as_str().unwrap();
    assert_import_released(&ledger, task); assert_direct_released(&transfer);
    assert!(!fixture.root.join("versions/direct-writer-abort").exists()); assert!(hidden_stages(&fixture.root).is_empty());
    assert!(!events.iter().any(|event| event["percent"].as_f64() == Some(100.0)));
    drop(JobGuard::register(&fixture.root, "direct-writer-abort").unwrap());
    drop(crate::install_lock::acquire(&fixture.root, || false).await.unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn direct_controlled_source_ipc_abort_keeps_job_root_and_claim_until_run_returns() {
    let fixture = Fixture::new(); let transfer = local_claim(&fixture); let observed: DirectObserved = Arc::new(Mutex::new(None));
    let (barrier, entered) = Barrier::new(); let release = ReleaseBarrier(barrier.clone()); let run_barrier = barrier.clone();
    let events = Arc::new(Mutex::new(Vec::<Value>::new())); let captured = events.clone();
    let (done, completed) = oneshot::channel(); let done = Arc::new(Mutex::new(Some(done)));
    let sink: Sink = Arc::new(move |event| {
        if event["task"] == "绑定并安装整合包成员" { run_barrier.wait().expect("真实 run 屏障"); }
        let terminal = event["phase"] == "done";
        captured.lock().unwrap().push(event);
        if terminal { if let Some(done) = done.lock().unwrap().take() { let _ = done.send(()); } }
    });
    let root = fixture.root.clone(); let cache = transfer.clone(); let books = observed.clone();
    let waiter = tokio::spawn(start_direct_fixture(root, "direct-run-abort".into(), cache, books, sink, || Ok(())));
    tokio::time::timeout(Duration::from_secs(5), entered).await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(5), transfer.joined()).await.unwrap().unwrap();
    let (operation, ledger) = observed.lock().unwrap().clone().unwrap();
    waiter.abort(); assert!(waiter.await.unwrap_err().is_cancelled());
    let state = transfer.snapshot().unwrap();
    let held = ledger.root.lock().unwrap().is_some() && ledger.job.lock().unwrap().is_some();
    let controlled = matches!(ledger.source.lock().unwrap().as_deref(), Some(Input::Controlled(_)));
    let busy = JobGuard::register(&fixture.root, "direct-run-abort").is_err();
    let known_stage = ledger.stage_path().unwrap().join("natives/.extract-stamp").is_file();
    let no_terminal = !events.lock().unwrap().iter().any(|event| event["phase"] == "done");
    let no_publish = !fixture.root.join("versions/direct-run-abort").exists();
    drop(release);
    tokio::time::timeout(Duration::from_secs(5), completed).await.unwrap().unwrap();
    assert!(operation.cancel.check().is_err() && held && controlled && busy && known_stage && no_terminal && no_publish);
    assert!(state.in_use == 1 && state.ready == 0 && state.holder_present && state.stage_exists && !state.poisoned);
    let events = events.lock().unwrap().clone(); let task = events.last().unwrap()["taskId"].as_str().unwrap();
    assert_import_released(&ledger, task); assert_direct_released(&transfer);
    assert!(!fixture.root.join("versions/direct-run-abort").exists()); assert!(hidden_stages(&fixture.root).is_empty());
    assert!(!events.iter().any(|event| event["percent"].as_f64() == Some(100.0)));
    drop(JobGuard::register(&fixture.root, "direct-run-abort").unwrap());
    drop(crate::install_lock::acquire(&fixture.root, || false).await.unwrap());
}

#[test]
fn early_mode_guards_and_exact_loader_validation_are_shared_production_checks() {
    assert!(allowed(&json!({"mode":"local"})).unwrap_err().contains("本地模式"));
    assert!(allowed(&json!({"metadataOnlyMods":true})).unwrap_err().contains("仅元数据")); assert!(allowed(&json!({"mode":"normal"})).is_ok());
    let fixture = Fixture::new(); let mut archive = fs::File::open(&fixture.archive).unwrap(); let mut planned = plan::plan(&mut archive, "source.mrpack", None).unwrap();
    validate_plan(&planned).unwrap();
    planned.loader = Some(plan::LoaderSpec { kind:"fabric".into(),version:"latest".into(),source_key:"fixture".into() }); assert!(validate_plan(&planned).is_err());
    planned.loader.as_mut().unwrap().version = "*".into(); assert!(validate_plan(&planned).is_err());
    planned.loader.as_mut().unwrap().version = "0.16.9".into(); assert!(validate_plan(&planned).is_ok());
    for kind in ["forge", "neoforge"] { planned.loader.as_mut().unwrap().kind = kind.into(); let result = validate_plan(&planned); if cfg!(any(target_os="android",target_os="ios")) { assert!(result.unwrap_err().contains("移动平台")); } else { result.unwrap(); } }
    planned.target_id = planned.mc_version.clone(); assert!(validate_plan(&planned).is_err());
}

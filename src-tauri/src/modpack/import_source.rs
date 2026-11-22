//! 导入使用的稳定只读源；不把路径或临时缓存句柄交给调用方。
//! Source 的读取和收尾都由独立 owned worker 持有；等待方取消只发信号，
//! 不会丢弃仍在运行的阻塞读取或归档清理。

use super::{access::OpenedFile, download::ArchiveClaim, Result};
use crate::downloads::Cancel;
use std::{
    fs::File,
    future::Future,
    io::{Seek, SeekFrom},
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
};
use tauri::AppHandle;

/// 归档能力或用户在文件选择器中明确授权的普通文件。
///
/// `Source` 不实现 Clone：同一来源只有一个显式 finish 所有者。读取期间真正的
/// Stage/导入账本必须由上层 owned worker 持有，不能藏在 callback 返回值里。
pub(super) struct Source {
    inner: Arc<SourceInner>,
}

struct SourceInner {
    cancel: Arc<Cancel>,
    reader_gate: Arc<tokio::sync::Mutex<()>>,
    kind: SourceKind,
}

enum SourceKind {
    Archive {
        claim: Arc<tokio::sync::Mutex<Option<ArchiveClaim>>>,
    },
    Picker {
        require_grant: Arc<dyn Fn() -> Result<()> + Send + Sync>,
        name: String,
        opened: Arc<Mutex<Option<OpenedFile>>>,
    },
}

impl Source {
    /// 打开一个进程内下载归档能力或当前窗口已选择的文件。
    ///
    /// 归档由 opaque token 单次 claim；普通路径必须先通过 picker grant，再由
    /// `OpenedFile` 保存同一份已核验句柄，绝不按文件名重新授权。
    pub(super) async fn open(app: &AppHandle, value: &str) -> Result<Self> {
        if let Some(claim) = super::download::claim_archive(value).await? {
            return Ok(Self::from_claim(claim));
        }

        let app = app.clone();
        let path = PathBuf::from(value);
        let opened = tauri::async_runtime::spawn_blocking({
            let app = app.clone();
            let path = path.clone();
            move || open_picked(&app, &path)
        })
        .await
        .map_err(|_| "导入文件打开后台任务异常")??;
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or("导入文件名无效")?
            .to_owned();
        Ok(Self {
            inner: Arc::new(SourceInner {
                cancel: Arc::new(Cancel::default()),
                reader_gate: Arc::new(tokio::sync::Mutex::new(())),
                kind: SourceKind::Picker {
                    require_grant: Arc::new(move || crate::desktop::require_picked_file(&app, &path)),
                    name,
                    opened: Arc::new(Mutex::new(Some(opened))),
                },
            }),
        })
    }

    /// 同步终检；不核 TTL，但要求来源仍属于同一能力/同一 picker 授权。
    /// 调用方应在最终提交前调用，且不得把 callback 的 T 当作唯一账本。
    pub(super) fn check(&self, parent: &Cancel) -> Result<()> {
        self.inner.check(parent)
    }

    pub(super) fn from_claim(claim: ArchiveClaim) -> Self {
        Self {
            inner: Arc::new(SourceInner {
                cancel: claim.cancel(),
                reader_gate: Arc::new(tokio::sync::Mutex::new(())),
                kind: SourceKind::Archive {
                    claim: Arc::new(tokio::sync::Mutex::new(Some(claim))),
                },
            }),
        }
    }

    /// 由独立 owned worker 读取。Future 被丢弃时只发取消信号，后台 worker 仍会
    /// 真正等待阻塞读取结束；callback 的返回值只作计划/解析结果，不拥有 Stage。
    pub(super) fn read<T: Send + 'static>(
        &self,
        parent: Arc<Cancel>,
        read: impl FnOnce(&mut File, &str, &Cancel) -> Result<T> + Send + 'static,
    ) -> SourceReadFuture<T> {
        let inner = self.inner.clone();
        let cancel = inner.cancel.clone();
        let caller_parent = parent.clone();
        let child = tauri::async_runtime::spawn(async move { read_owned(inner, parent, read).await });
        let worker = Box::pin(async move {
            child
                .await
                .map_err(|_| "导入来源读取后台异常，来源状态未知".to_owned())?
        });
        SourceReadFuture {
            worker,
            cancel: Some(cancel),
            parent: Some(caller_parent),
        }
    }

    /// 显式收尾。创建 Future 即启动 owned worker；等待方 abort 不会提前关闭
    /// 文件或释放归档租约，worker 会等待读取 gate 后完成真实 close/finish。
    pub(super) fn finish(self) -> SourceFinishFuture {
        let inner = self.inner.clone();
        let cancel = inner.cancel.clone();
        let child = tauri::async_runtime::spawn(async move { finish_owned(inner).await });
        let worker = Box::pin(async move {
            child
                .await
                .map_err(|_| "导入来源收尾后台异常，来源状态未知".to_owned())?
        });
        SourceFinishFuture {
            worker,
            cancel: Some(cancel),
        }
    }
}

impl Drop for Source {
    fn drop(&mut self) {
        // 未显式 finish 的 Source 不假称成功；归档 claim 的 Drop 会保留票据并 poison。
        self.inner.cancel.stop();
    }
}

impl SourceInner {
    fn check(&self, parent: &Cancel) -> Result<()> {
        linked_check(&self.cancel, parent)?;
        let _reader = self
            .reader_gate
            .try_lock()
            .map_err(|_| "导入来源仍在读取，请等待后台任务结束")?;
        match &self.kind {
            SourceKind::Archive { claim } => {
                let guard = claim
                    .try_lock()
                    .map_err(|_| "导入归档租约仍在读取，请等待后台任务结束")?;
                guard
                    .as_ref()
                    .ok_or("导入归档租约已收尾")?
                    .check(parent)
            }
            SourceKind::Picker { require_grant, opened, .. } => {
                require_grant()?;
                let guard = opened.lock().map_err(|_| "导入文件状态不可用")?;
                let file = guard.as_ref().ok_or("导入文件已关闭")?;
                file.verify()?;
                require_grant()?;
                linked_check(&self.cancel, parent)
            }
        }
    }
}

/// 已拥有后台读取任务的 Future。Drop 不 abort worker，只通知双方取消。
pub(super) struct SourceReadFuture<T> {
    worker: Pin<Box<dyn Future<Output = Result<T>> + Send>>,
    cancel: Option<Arc<Cancel>>,
    parent: Option<Arc<Cancel>>,
}
impl<T> Unpin for SourceReadFuture<T> {}
impl<T> Future for SourceReadFuture<T> {
    type Output = Result<T>;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        match this.worker.as_mut().poll(cx) {
            Poll::Ready(result) => {
                this.cancel.take();
                this.parent.take();
                Poll::Ready(result)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}
impl<T> Drop for SourceReadFuture<T> {
    fn drop(&mut self) {
        if let Some(cancel) = &self.cancel {
            cancel.stop();
        }
        if let Some(parent) = &self.parent {
            parent.stop();
        }
    }
}

/// 显式 finish 的 owned worker。Future 被丢弃后仍继续运行。
pub(super) struct SourceFinishFuture {
    worker: Pin<Box<dyn Future<Output = Result<()>> + Send>>,
    cancel: Option<Arc<Cancel>>,
}
impl Unpin for SourceFinishFuture {}
impl Future for SourceFinishFuture {
    type Output = Result<()>;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        match this.worker.as_mut().poll(cx) {
            Poll::Ready(result) => {
                this.cancel.take();
                Poll::Ready(result)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}
impl Drop for SourceFinishFuture {
    fn drop(&mut self) {
        // finish_owned 不用这个取消信号决定是否清理；这里只唤醒仍在读的任务。
        if let Some(cancel) = &self.cancel {
            cancel.stop();
        }
    }
}

async fn read_owned<T: Send + 'static>(
    inner: Arc<SourceInner>,
    parent: Arc<Cancel>,
    read: impl FnOnce(&mut File, &str, &Cancel) -> Result<T> + Send + 'static,
) -> Result<T> {
    linked_check(&inner.cancel, &parent)?;
    let _reader = tokio::select! {
        biased;
        _ = parent.cancelled() => { inner.cancel.stop(); return Err("导入来源已取消".into()); }
        _ = inner.cancel.cancelled() => { parent.stop(); return Err("导入来源已取消".into()); }
        gate = inner.reader_gate.clone().lock_owned() => gate,
    };
    linked_check(&inner.cancel, &parent)?;

    let result = match &inner.kind {
        SourceKind::Archive { claim } => {
            let guard = claim.lock().await;
            let claim = guard.as_ref().ok_or("导入归档租约已收尾")?;
            claim.read_archive(parent.clone(), read).await
        }
        SourceKind::Picker {
            require_grant,
            name,
            opened,
        } => {
            let require_grant = require_grant.clone();
            let name = name.clone();
            let opened = opened.clone();
            let capability_cancel = inner.cancel.clone();
            let parent_cancel = parent.clone();
            let mut child = tauri::async_runtime::spawn_blocking(move || {
                read_opened(
                    &opened,
                    &name,
                    &capability_cancel,
                    &parent_cancel,
                    || require_grant(),
                    read,
                )
            });
            // 取消只联动信号；三个分支都等真实 child，不能 select 后丢弃句柄。
            let joined = tokio::select! {
                biased;
                _ = parent.cancelled() => { inner.cancel.stop(); child.await }
                _ = inner.cancel.cancelled() => { parent.stop(); child.await }
                result = &mut child => result,
            };
            joined.map_err(|_| "导入文件读取后台异常，来源状态未知".to_owned())?
        }
    };
    // 读回调成功后仍可能在终检失败；此时 T 会被正常丢弃，但外层台账不受影响。
    linked_check(&inner.cancel, &parent)?;
    result
}

async fn finish_owned(inner: Arc<SourceInner>) -> Result<()> {
    let _reader = inner.reader_gate.clone().lock_owned().await;
    match &inner.kind {
        SourceKind::Archive { claim } => {
            let claim = claim
                .lock()
                .await
                .take()
                .ok_or("导入归档租约已收尾")?;
            // ArchiveClaim::finish 自己拥有清理 worker；即使本 Future 被丢弃，
            // 它的 worker 仍会等待真实 Stage cleanup。
            claim.finish().await
        }
        SourceKind::Picker { opened, .. } => {
            let opened = opened.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let mut file = opened.lock().map_err(|_| "导入文件状态不可用")?;
                let opened_file = file.take().ok_or("导入文件已收尾")?;
                // finish 只确认句柄已归还，不重新授权读取。关闭窗口或取消后的
                // picker grant 已失效，也必须能真实 close；提交终检由 check 执行。
                drop(opened_file);
                Ok(())
            })
            .await
            .map_err(|_| "导入文件收尾后台异常".to_owned())?
        }
    }
}

fn open_picked(app: &AppHandle, path: &Path) -> Result<OpenedFile> {
    crate::desktop::require_picked_file(app, path)?;
    let opened = OpenedFile::open(path)?;
    // 授权与打开之间可能发生换绑；同一句柄必须仍对应 picker grant。
    crate::desktop::require_picked_file(app, path)?;
    opened.verify()?;
    Ok(opened)
}

fn linked_check(capability_cancel: &Cancel, parent_cancel: &Cancel) -> Result<()> {
    if parent_cancel.check().is_err() { capability_cancel.stop(); }
    if capability_cancel.check().is_err() { parent_cancel.stop(); }
    parent_cancel.check()?;
    capability_cancel.check()
}

// 私有同步内核便于用真实临时文件验证；生产唯一入口始终检查宿主 picker grant。
fn read_opened<T>(
    opened: &Arc<Mutex<Option<OpenedFile>>>,
    name: &str,
    capability_cancel: &Cancel,
    parent_cancel: &Cancel,
    require_grant: impl Fn() -> Result<()>,
    read: impl FnOnce(&mut File, &str, &Cancel) -> Result<T>,
) -> Result<T> {
    linked_check(capability_cancel, parent_cancel)?;
    require_grant()?;
    let mut guard = opened.lock().map_err(|_| "导入文件状态不可用")?;
    let file = guard.as_mut().ok_or("导入文件已收尾")?;
    file.verify()?;
    file.file.seek(SeekFrom::Start(0)).map_err(|_| "导入文件定位失败")?;
    let result = read(&mut file.file, name, capability_cancel);
    linked_check(capability_cancel, parent_cancel)?;
    file.verify()?;
    require_grant()?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Read, sync::atomic::{AtomicBool, AtomicUsize, Ordering}, time::Duration};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("hcmcl-import-source-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
        fn source(&self, allowed: Arc<AtomicBool>, checks: Arc<AtomicUsize>) -> (Source, Arc<Mutex<Option<OpenedFile>>>) {
            let path = self.0.join("chosen.zip");
            fs::write(&path, b"stable picker fixture").unwrap();
            let opened = Arc::new(Mutex::new(Some(OpenedFile::open(&path).unwrap())));
            let source = Source { inner: Arc::new(SourceInner {
                cancel: Arc::new(Cancel::default()),
                reader_gate: Arc::new(tokio::sync::Mutex::new(())),
                kind: SourceKind::Picker {
                    // 仅夹具注入授权状态；生产唯一构造器仍调用 require_picked_file。
                    require_grant: Arc::new(move || {
                        checks.fetch_add(1, Ordering::AcqRel);
                        if allowed.load(Ordering::Acquire) { Ok(()) } else { Err("夹具授权已取消".into()) }
                    }),
                    name: "chosen.zip".into(), opened: opened.clone(),
                },
            }) };
            (source, opened)
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    fn read_bytes(file: &mut File, name: &str, _: &Cancel) -> Result<Vec<u8>> {
        assert_eq!(name, "chosen.zip");
        let mut bytes = Vec::new(); file.read_to_end(&mut bytes).map_err(|_| "夹具读取失败".to_owned())?; Ok(bytes)
    }

    #[tokio::test]
    async fn picker_reads_reuse_one_opened_file_and_rewind_between_reads() {
        let fixture = Fixture::new(); let checks = Arc::new(AtomicUsize::new(0));
        let (source, opened) = fixture.source(Arc::new(AtomicBool::new(true)), checks.clone());
        let parent = Arc::new(Cancel::default());
        assert_eq!(source.read(parent.clone(), read_bytes).await.unwrap(), b"stable picker fixture");
        assert_eq!(source.read(parent.clone(), read_bytes).await.unwrap(), b"stable picker fixture");
        assert_eq!(checks.load(Ordering::Acquire), 4);
        source.check(&parent).unwrap();
        source.finish().await.unwrap(); assert!(opened.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn grant_revocation_rejects_late_result_but_finish_still_closes() {
        let fixture = Fixture::new(); let allowed = Arc::new(AtomicBool::new(true));
        let (source, opened) = fixture.source(allowed.clone(), Arc::new(AtomicUsize::new(0)));
        let parent = Arc::new(Cancel::default());
        assert!(source.read(parent.clone(), move |file, name, cancel| {
            let value = read_bytes(file, name, cancel)?;
            allowed.store(false, Ordering::Release); Ok(value)
        }).await.is_err());
        assert!(source.check(&parent).is_err()); assert!(opened.lock().unwrap().is_some());
        source.finish().await.unwrap(); assert!(opened.lock().unwrap().is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn aborted_read_and_unpolled_finish_wait_for_actual_blocking_reader() {
        let fixture = Fixture::new();
        let (source, opened) = fixture.source(Arc::new(AtomicBool::new(true)), Arc::new(AtomicUsize::new(0)));
        let parent = Arc::new(Cancel::default());
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let read = source.read(parent.clone(), move |file, name, cancel| {
            let bytes = read_bytes(file, name, cancel)?;
            entered_tx.send(()).unwrap(); release_rx.recv_timeout(Duration::from_secs(5)).unwrap(); Ok(bytes)
        });
        let caller = tokio::spawn(read); entered_rx.await.unwrap(); caller.abort(); let _ = caller.await;
        assert!(parent.check().is_err()); assert!(opened.try_lock().is_err());
        let inner = source.inner.clone();
        let mut finish = Box::pin(source.finish());
        std::future::poll_fn(|cx| { assert!(finish.as_mut().poll(cx).is_pending()); Poll::Ready(()) }).await;
        // 不再 poll/直接丢等待方，owned finisher 也必须等读者真实归还句柄。
        drop(finish); assert!(inner.reader_gate.clone().try_lock_owned().is_err());
        release_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(guard) = opened.try_lock() { if guard.is_none() { break; } }
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
    }
}


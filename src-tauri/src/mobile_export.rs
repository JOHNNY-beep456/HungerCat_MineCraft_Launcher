//! Android 文档导出的纯状态机：一个槽覆盖 picker、待用能力、下载和不可伪撤销的提交。
//! 本模块不持有 URI、路径或原生票据；宿主必须在实际 worker/清理退出后才调用 finish。
use std::{sync::Arc, time::{Duration, Instant}};

pub(crate) const SAVE_TTL: Duration = Duration::from_secs(10 * 60);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Phase { Picking, Pending, Downloading, Committing, Cleaning }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StateError { Busy, Denied, CommitStarted }
// 原生失败可能已丢失 cleanupIncomplete，后续空取消成功不能证明旧目标已被删除。
#[derive(Default)]
pub(crate) struct CleanupStatus { unconfirmed: bool }
impl CleanupStatus {
    pub(crate) fn native_result<T, E>(&mut self, result: Result<T, E>) -> Result<T, ()> {
        result.map_err(|_| { self.unconfirmed = true; })
    }
    pub(crate) fn record_cleanup(&mut self, incomplete: bool) { self.unconfirmed |= incomplete; }
    pub(crate) fn is_unconfirmed(&self) -> bool { self.unconfirmed }
}
#[derive(Clone, Debug)]
struct Active { id: String, epoch: u64, phase: Phase, expires: Instant, cancelled: bool, commit_started: bool }
#[derive(Default)]
pub(crate) struct Lifecycle { epoch: u64, destroyed: bool, active: Option<Active> }
impl Lifecycle {
    pub(crate) fn reserve(&mut self, id: String, now: Instant) -> Result<u64, StateError> {
        if self.destroyed { return Err(StateError::Denied); }
        if self.active.is_some() { return Err(StateError::Busy); }
        let epoch = self.epoch;
        self.active = Some(Active { id, epoch, phase: Phase::Picking, expires: now + SAVE_TTL, cancelled: false, commit_started: false });
        Ok(epoch)
    }
    pub(crate) fn phase(&self) -> Option<Phase> { self.active.as_ref().map(|active| active.phase) }
    pub(crate) fn id(&self) -> Option<&str> { self.active.as_ref().map(|active| active.id.as_str()) }
    fn current(&self, id: &str, epoch: u64) -> Result<&Active, StateError> {
        self.active.as_ref().filter(|active| active.id == id && active.epoch == epoch && epoch == self.epoch && !self.destroyed).ok_or(StateError::Denied)
    }
    pub(crate) fn publish(&mut self, id: &str, epoch: u64, now: Instant) -> Result<(), StateError> {
        let active = self.current(id, epoch)?;
        if active.phase != Phase::Picking || active.cancelled || now >= active.expires { return Err(StateError::Denied); }
        self.active.as_mut().unwrap().phase = Phase::Pending;
        Ok(())
    }
    pub(crate) fn consume(&mut self, id: &str, epoch: u64, now: Instant) -> Result<(), StateError> {
        let active = self.current(id, epoch)?;
        if active.phase != Phase::Pending || active.cancelled || now >= active.expires { return Err(StateError::Denied); }
        self.active.as_mut().unwrap().phase = Phase::Downloading;
        Ok(())
    }
    // cancel 与提交边界必须由宿主同一把锁串行化；不能先检查再在另一个临界区换阶段。
    pub(crate) fn commit(&mut self, id: &str, epoch: u64) -> Result<(), StateError> {
        let active = self.current(id, epoch)?;
        if active.phase != Phase::Downloading || active.cancelled { return Err(StateError::Denied); }
        let active = self.active.as_mut().unwrap(); active.phase = Phase::Committing; active.commit_started = true;
        Ok(())
    }
    pub(crate) fn cancel(&mut self, id: Option<&str>) -> Result<bool, StateError> {
        let Some(active) = self.active.as_mut().filter(|active| id.map_or(true, |id| id == active.id)) else { return Ok(false); };
        if active.commit_started { return Err(StateError::CommitStarted); }
        active.cancelled = true;
        Ok(true)
    }
    // 只有未消费票据/picker 到期；下载已消费能力，不得被 TTL 清理线程提前释放。
    pub(crate) fn expire(&mut self, id: &str, now: Instant) -> bool {
        let Some(active) = self.active.as_mut().filter(|active| active.id == id) else { return false; };
        if !matches!(active.phase, Phase::Picking | Phase::Pending) || now < active.expires { return false; }
        active.cancelled = true;
        true
    }
    pub(crate) fn cleaning(&mut self, id: &str) {
        if let Some(active) = self.active.as_mut().filter(|active| active.id == id) { active.phase = Phase::Cleaning; active.cancelled = true; }
    }
    pub(crate) fn invalidate(&mut self, destroyed: bool) {
        self.epoch = self.epoch.wrapping_add(1);
        self.destroyed |= destroyed;
        if let Some(active) = self.active.as_mut() { active.cancelled = true; }
    }
    // 旧清理任务不得把之后的槽清掉；调用者还要确保所有 File/后台工作均已退出。
    pub(crate) fn finish(&mut self, id: &str) -> bool {
        if self.active.as_ref().is_some_and(|active| active.id == id) { self.active = None; true } else { false }
    }
}

// IPC future 的 Drop 只发送信号；绝不在这里 abort worker 或释放生命周期槽。
pub(crate) struct SignalOnDrop { signal: Option<Arc<dyn Fn() + Send + Sync>> }
impl SignalOnDrop {
    pub(crate) fn new(signal: Arc<dyn Fn() + Send + Sync>) -> Self { Self { signal: Some(signal) } }
    pub(crate) fn disarm(&mut self) { self.signal = None; }
}
impl Drop for SignalOnDrop { fn drop(&mut self) { if let Some(signal) = self.signal.take() { signal(); } } }

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};
    #[test]
    fn native_create_and_commit_failures_survive_empty_cancel_and_finish() {
        let now = Instant::now();
        for committing in [false, true] {
            let mut lifecycle = Lifecycle::default(); let mut cleanup = CleanupStatus::default();
            let epoch = lifecycle.reserve("old".into(), now).unwrap();
            if committing { lifecycle.publish("old", epoch, now).unwrap(); lifecycle.consume("old", epoch, now).unwrap(); lifecycle.commit("old", epoch).unwrap(); }
            assert_eq!(cleanup.native_result(Err::<bool, _>("native rejected after dropping its operation")), Err(()));
            // 原生已不持有旧 operation，空 cancelRequest 的成功不能证明旧 URI 删除成功。
            cleanup.record_cleanup(false); lifecycle.cleaning("old"); assert!(lifecycle.finish("old"));
            assert!(cleanup.is_unconfirmed()); // 宿主 reserve 前以此拒绝新导出。
            assert_eq!(cleanup.native_result(Ok::<_, &str>(true)), Ok(true));
            cleanup.record_cleanup(false); assert!(cleanup.is_unconfirmed());
        }
    }
    #[test]
    fn native_success_and_explicit_complete_cancel_do_not_poison_cleanup() {
        let now = Instant::now();
        for saved in [false, true] {
            let mut lifecycle = Lifecycle::default(); let mut cleanup = CleanupStatus::default();
            let epoch = lifecycle.reserve("old".into(), now).unwrap();
            assert_eq!(cleanup.native_result(Ok::<_, &str>(saved)), Ok(saved));
            if saved { lifecycle.publish("old", epoch, now).unwrap(); lifecycle.consume("old", epoch, now).unwrap(); lifecycle.commit("old", epoch).unwrap(); }
            else { assert_eq!(lifecycle.cancel(Some("old")), Ok(true)); }
            cleanup.record_cleanup(false); lifecycle.cleaning("old"); assert!(lifecycle.finish("old"));
            assert!(!cleanup.is_unconfirmed()); assert!(lifecycle.reserve("new".into(), now).is_ok());
        }
    }
    #[test]
    fn explicit_incomplete_cleanup_is_sticky_across_later_success() {
        let mut cleanup = CleanupStatus::default();
        assert_eq!(cleanup.native_result(Ok::<_, &str>(false)), Ok(false));
        cleanup.record_cleanup(true); cleanup.record_cleanup(false);
        assert!(cleanup.is_unconfirmed());
    }
    #[test]
    fn slot_spans_picker_pending_worker_and_cleanup() {
        let now = Instant::now(); let mut state = Lifecycle::default();
        let epoch = state.reserve("one".into(), now).unwrap();
        for phase in [Phase::Picking, Phase::Pending, Phase::Downloading, Phase::Cleaning] {
            assert_eq!(state.phase(), Some(phase));
            assert_eq!(state.reserve("two".into(), now), Err(StateError::Busy));
            match phase { Phase::Picking => state.publish("one", epoch, now).unwrap(), Phase::Pending => state.consume("one", epoch, now).unwrap(), Phase::Downloading => state.cleaning("one"), _ => {} }
        }
        assert!(!state.finish("stale")); assert!(state.finish("one"));
        assert!(state.reserve("two".into(), now).is_ok());
    }
    #[test]
    fn capabilities_are_owned_single_use_and_ttl_does_not_free_worker() {
        let now = Instant::now(); let mut state = Lifecycle::default(); let epoch = state.reserve("one".into(), now).unwrap();
        assert_eq!(state.publish("forged", epoch, now), Err(StateError::Denied));
        state.publish("one", epoch, now).unwrap();
        assert_eq!(state.consume("one", epoch + 1, now), Err(StateError::Denied));
        state.consume("one", epoch, now).unwrap();
        assert_eq!(state.consume("one", epoch, now), Err(StateError::Denied));
        assert!(!state.expire("one", now + SAVE_TTL));
        assert_eq!(state.phase(), Some(Phase::Downloading));
    }
    #[test]
    fn ttl_and_late_picker_never_publish_or_reuse_before_cleanup() {
        let now = Instant::now(); let mut state = Lifecycle::default(); let epoch = state.reserve("one".into(), now).unwrap();
        assert!(!state.expire("one", now + SAVE_TTL - Duration::from_millis(1)));
        assert!(state.expire("one", now + SAVE_TTL));
        assert_eq!(state.publish("one", epoch, now + SAVE_TTL), Err(StateError::Denied));
        assert_eq!(state.reserve("two".into(), now), Err(StateError::Busy));
        state.cleaning("one"); state.finish("one");
        let next = state.reserve("two".into(), now).unwrap(); state.publish("two", next, now).unwrap();
        assert!(state.expire("two", now + SAVE_TTL));
        assert_eq!(state.consume("two", next, now + SAVE_TTL), Err(StateError::Denied));
    }
    #[test]
    fn cancel_and_commit_are_atomic_in_both_orders() {
        let now = Instant::now();
        for cancel_first in [true, false] {
            let mut state = Lifecycle::default(); let epoch = state.reserve("one".into(), now).unwrap(); state.publish("one", epoch, now).unwrap(); state.consume("one", epoch, now).unwrap();
            assert_eq!(state.cancel(Some("other")), Ok(false));
            if cancel_first { assert_eq!(state.cancel(Some("one")), Ok(true)); assert_eq!(state.commit("one", epoch), Err(StateError::Denied)); }
            else { state.commit("one", epoch).unwrap(); assert_eq!(state.cancel(Some("one")), Err(StateError::CommitStarted)); assert_eq!(state.cancel(None), Err(StateError::CommitStarted)); state.cleaning("one"); assert_eq!(state.cancel(None), Err(StateError::CommitStarted)); }
        }
    }
    #[test]
    fn lifecycle_invalidation_rejects_late_callbacks_and_old_cleanup() {
        let now = Instant::now(); let mut state = Lifecycle::default(); let epoch = state.reserve("one".into(), now).unwrap(); state.invalidate(false);
        assert_eq!(state.publish("one", epoch, now), Err(StateError::Denied));
        assert_eq!(state.reserve("two".into(), now), Err(StateError::Busy)); state.finish("one");
        let next = state.reserve("two".into(), now).unwrap(); assert_ne!(next, epoch); assert!(!state.finish("one"));
        state.invalidate(true); state.finish("two"); assert_eq!(state.reserve("three".into(), now), Err(StateError::Denied));
    }
    #[test]
    fn ipc_drop_only_signals_while_worker_owns_slot() {
        let now = Instant::now(); let state = Arc::new(Mutex::new(Lifecycle::default())); let epoch = state.lock().unwrap().reserve("one".into(), now).unwrap();
        state.lock().unwrap().publish("one", epoch, now).unwrap(); state.lock().unwrap().consume("one", epoch, now).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false)); let signal = cancelled.clone(); let guard = SignalOnDrop::new(Arc::new(move || { signal.store(true, Ordering::Release); }));
        let (release, waiting) = std::sync::mpsc::channel(); let worker_state = state.clone();
        let worker = std::thread::spawn(move || { waiting.recv().unwrap(); worker_state.lock().unwrap().finish("one"); });
        drop(guard); assert!(cancelled.load(Ordering::Acquire));
        assert_eq!(state.lock().unwrap().reserve("two".into(), now), Err(StateError::Busy));
        release.send(()).unwrap(); worker.join().unwrap(); assert!(state.lock().unwrap().reserve("two".into(), now).is_ok());
    }
    #[tokio::test]
    async fn aborting_actual_waiter_detaches_worker_until_blocking_barrier_returns() {
        let now = Instant::now(); let state = Arc::new(Mutex::new(Lifecycle::default()));
        let epoch = state.lock().unwrap().reserve("one".into(), now).unwrap(); state.lock().unwrap().publish("one", epoch, now).unwrap(); state.lock().unwrap().consume("one", epoch, now).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false)); let worker_state = state.clone(); let (release, wait) = std::sync::mpsc::channel();
        let (started, ready) = tokio::sync::oneshot::channel(); let (finished, done) = tokio::sync::oneshot::channel();
        let worker = tokio::spawn(async move {
            tokio::task::spawn_blocking(move || { let _ = started.send(()); wait.recv_timeout(Duration::from_secs(3)).unwrap(); }).await.unwrap();
            worker_state.lock().unwrap().finish("one"); let _ = finished.send(());
        });
        let signal = cancelled.clone(); let (entered, waiting) = tokio::sync::oneshot::channel();
        let waiter = tokio::spawn(async move {
            let _guard = SignalOnDrop::new(Arc::new(move || { signal.store(true, Ordering::Release); })); let _ = entered.send(());
            let _ = worker.await;
        });
        tokio::time::timeout(Duration::from_secs(2), waiting).await.unwrap().unwrap(); tokio::time::timeout(Duration::from_secs(2), ready).await.unwrap().unwrap();
        waiter.abort(); assert!(waiter.await.unwrap_err().is_cancelled());
        let signalled = cancelled.load(Ordering::Acquire); let still_busy = state.lock().unwrap().reserve("two".into(), now) == Err(StateError::Busy);
        release.send(()).unwrap(); tokio::time::timeout(Duration::from_secs(2), done).await.unwrap().unwrap();
        assert!(signalled); assert!(still_busy); assert!(state.lock().unwrap().reserve("two".into(), now).is_ok());
    }
    #[test]
    fn completed_ipc_guard_does_not_cancel_future_work() {
        let called = Arc::new(AtomicBool::new(false)); let signal = called.clone(); let mut guard = SignalOnDrop::new(Arc::new(move || { signal.store(true, Ordering::Release); })); guard.disarm(); drop(guard); assert!(!called.load(Ordering::Acquire));
    }
}

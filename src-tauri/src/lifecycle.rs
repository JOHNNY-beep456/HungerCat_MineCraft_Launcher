use std::{collections::BTreeSet, sync::{Arc, Mutex}};

type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EnterFailure {
    Closed,
    Restarting,
    Unavailable,
    Overflow,
}

impl EnterFailure {
    pub(crate) fn message(self) -> &'static str {
        match self {
            Self::Closed => "启动器正在关闭 / 啟動器正在關閉 / Launcher is closing",
            Self::Restarting => "启动器正在重启 / 啟動器正在重新啟動 / Launcher is restarting",
            Self::Unavailable => "生命周期状态不可用 / 生命週期狀態無法使用 / Lifecycle state unavailable",
            Self::Overflow => "生命周期请求计数溢出 / 生命週期請求計數溢出 / Lifecycle request count overflow",
        }
    }
}

#[derive(Default)]
struct State {
    active: usize,
    // 显示资源与执行中业务分开登记；资源仍由精确 owner 持有，不能靠计数抵消。
    resources: BTreeSet<u64>,
    next_resource: u64,
    restarting: bool,
    closed: bool,
    uncertain: bool,
}

/// 业务入口与重启共用同一把登记锁；检查失败不取消任务，也不清理票据。
#[derive(Clone, Default)]
pub(crate) struct Gate(Arc<Mutex<State>>);

impl Gate {
    pub(crate) fn enter_classified(&self) -> std::result::Result<Request, EnterFailure> {
        let mut state = self.0.lock().map_err(|_| EnterFailure::Unavailable)?;
        if state.closed { return Err(EnterFailure::Closed); }
        if state.restarting { return Err(EnterFailure::Restarting); }
        state.active = state.active.checked_add(1).ok_or(EnterFailure::Overflow)?;
        Ok(Request { gate: self.clone(), completed: false })
    }

    pub(crate) fn enter(&self) -> Result<Request> {
        self.enter_classified().map_err(|error| error.message().into())
    }

    pub(crate) fn begin_restart(&self) -> Result<Restart> {
        self.begin_restart_with_resources(&[])
    }

    /// 仅为可在既有退出链中确认销毁的显示资源登记；不能用于业务 writer / 任务。
    pub(crate) fn enter_resource_classified(&self) -> std::result::Result<Resource, EnterFailure> {
        let mut state = self.0.lock().map_err(|_| EnterFailure::Unavailable)?;
        if state.closed { return Err(EnterFailure::Closed); }
        if state.restarting { return Err(EnterFailure::Restarting); }
        let id = state.next_resource.checked_add(1).ok_or(EnterFailure::Overflow)?;
        state.next_resource = id;
        if !state.resources.insert(id) { return Err(EnterFailure::Unavailable); }
        Ok(Resource { gate: self.clone(), id, completed: false })
    }

    /// 先由所属显示域证明精确资源可收尾，再以同一登记锁封闭入口；普通请求必须仍为零。
    /// 许可只匹配当前 Gate 的同一个存活资源，不释放 owner，也不表示 native 已销毁。
    pub(crate) fn begin_restart_with_resources(&self, resources: &[ResourcePermit]) -> Result<Restart> {
        let mut state = self.0.try_lock().map_err(|_| "生命周期状态忙碌或不可用 / 生命週期狀態忙碌或無法使用 / Lifecycle state busy or unavailable")?;
        let permitted: BTreeSet<_> = resources.iter().map(|resource| resource.id).collect();
        if state.closed || state.restarting || state.uncertain || state.active != 0
            || resources.iter().any(|resource| !Arc::ptr_eq(&self.0, &resource.gate.0))
            || permitted.len() != resources.len() || state.resources != permitted {
            return Err("仍有请求运行或收尾状态未确认，请稍后重试 / 仍有請求執行或收尾狀態未確認，請稍後重試 / Requests are running or completion is unconfirmed; retry later".into());
        }
        state.restarting = true;
        Ok(Restart { gate: self.clone(), committed: false })
    }

    pub(crate) fn close_once(&self) -> bool {
        // 即使锁中毒也只能封闭一次；普通登记仍拒绝中毒状态。
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let first = !state.closed;
        state.closed = true;
        first
    }

    pub(crate) fn close(&self) { let _ = self.close_once(); }
}

pub(crate) struct Request {
    gate: Gate,
    completed: bool,
}
impl Request {
    /// 只在整个入口或被登记的后台任务真实返回后调用。
    pub(crate) fn finish(mut self) { self.completed = true; }
}
impl Drop for Request {
    fn drop(&mut self) {
        if let Ok(mut state) = self.gate.0.lock() {
            if !self.completed { state.uncertain = true; }
            match state.active.checked_sub(1) {
                Some(active) => state.active = active,
                None => state.uncertain = true,
            }
        }
    }
}

/// 资源票据从登记一直保留到精确销毁回执；Drop 未 finish 仍污染重启为未知。
pub(crate) struct Resource {
    gate: Gate,
    id: u64,
    completed: bool,
}
pub(crate) struct ResourcePermit { gate: Gate, id: u64 }
impl Resource {
    pub(crate) fn permit(&self) -> ResourcePermit { ResourcePermit { gate: self.gate.clone(), id: self.id } }
    pub(crate) fn finish(mut self) { self.completed = true; }
}
impl ResourcePermit {
    pub(crate) fn same_resource(&self, other: &Self) -> bool {
        self.id == other.id && Arc::ptr_eq(&self.gate.0, &other.gate.0)
    }
}
impl Drop for Resource {
    fn drop(&mut self) {
        if let Ok(mut state) = self.gate.0.lock() {
            let removed = state.resources.remove(&self.id);
            if !self.completed || !removed { state.uncertain = true; }
        }
    }
}

pub(crate) struct Restart {
    gate: Gate,
    committed: bool,
}
impl Restart {
    /// 从此保持封闭，直到当前进程退出；不能因响应发送或局部变量析构重新开放。
    pub(crate) fn commit(mut self) { self.committed = true; }
}
impl Drop for Restart {
    fn drop(&mut self) {
        if !self.committed {
            if let Ok(mut state) = self.gate.0.lock() { state.restarting = false; }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_rejects_inflight_requests_and_failed_check_reopens_without_side_effects() {
        let gate = Gate::default();
        let request = gate.enter().unwrap();
        assert!(gate.begin_restart().is_err());
        request.finish();
        let restart = gate.begin_restart().unwrap();
        assert!(gate.enter().is_err());
        assert!(gate.begin_restart().is_err());
        drop(restart);
        gate.enter().unwrap().finish();
        gate.begin_restart().unwrap().commit();
        assert!(gate.enter().is_err());
        assert!(gate.begin_restart().is_err());
    }

    #[test]
    fn dropped_request_is_sticky_and_close_is_not_undone_by_failed_restart() {
        let gate = Gate::default();
        drop(gate.enter().unwrap());
        assert!(gate.begin_restart().is_err());
        // 未确认只阻止重启；普通业务仍可继续查询或主动取消。
        gate.enter().unwrap().finish();
        assert!(gate.begin_restart().is_err());
        let other = Gate::default();
        let restart = other.begin_restart().unwrap();
        other.close();
        drop(restart);
        assert!(other.enter().is_err());
        assert!(other.begin_restart().is_err());
    }

    #[test]
    fn request_and_restart_have_one_atomic_registration_order() {
        for _ in 0..32 {
            let gate = Gate::default();
            let start = Arc::new(std::sync::Barrier::new(3));
            let hold = Arc::new(std::sync::Barrier::new(3));
            let request_gate = gate.clone(); let request_start = start.clone(); let request_hold = hold.clone();
            let request = std::thread::spawn(move || {
                request_start.wait();
                let entered = request_gate.enter();
                let accepted = entered.is_ok();
                request_hold.wait();
                if let Ok(guard) = entered { guard.finish(); }
                accepted
            });
            let restart_gate = gate.clone(); let restart_start = start.clone(); let restart_hold = hold.clone();
            let restart = std::thread::spawn(move || {
                restart_start.wait();
                let entered = restart_gate.begin_restart();
                let accepted = entered.is_ok();
                restart_hold.wait();
                drop(entered);
                accepted
            });
            start.wait(); hold.wait();
            assert_ne!(request.join().unwrap(), restart.join().unwrap());
        }
    }

    #[tokio::test]
    async fn aborted_caller_keeps_restart_unconfirmed_until_and_after_real_writer_closes() {
        use std::io::Write;
        let gate = Gate::default();
        let request = gate.enter().unwrap();
        let path = std::env::temp_dir().join(format!("hcmcl-restart-{}.tmp", uuid::Uuid::new_v4()));
        let writer_path = path.clone();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let caller = tokio::spawn(async move {
            let writer = tokio::task::spawn_blocking(move || {
                let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(writer_path).unwrap();
                let _ = entered_tx.send(());
                release_rx.recv().unwrap();
                file.write_all(b"owned write").unwrap(); file.flush().unwrap(); file.sync_all().unwrap(); drop(file);
                let _ = done_tx.send(());
            });
            writer.await.unwrap();
            request.finish();
        });
        entered_rx.await.unwrap();
        assert!(gate.begin_restart().is_err());
        caller.abort(); assert!(caller.await.unwrap_err().is_cancelled());
        assert!(gate.begin_restart().is_err());
        release_tx.send(()).unwrap(); done_rx.await.unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"owned write");
        std::fs::remove_file(path).unwrap();
        assert!(gate.begin_restart().is_err());
    }

    #[test]
    fn display_resource_allows_restart_only_with_its_exact_permit_and_no_business() {
        let gate = Gate::default();
        let resource = gate.enter_resource_classified().unwrap();
        let permit = resource.permit();
        assert!(gate.begin_restart().is_err());
        let request = gate.enter().unwrap();
        assert!(gate.begin_restart_with_resources(std::slice::from_ref(&permit)).is_err());
        request.finish();
        let restart = gate.begin_restart_with_resources(std::slice::from_ref(&permit)).unwrap();
        assert!(gate.enter().is_err());
        assert!(gate.enter_resource_classified().is_err());
        // 允许重启不等于资源已消失；精确登记仍存在，退出链必须自行确认收尾。
        assert_eq!(gate.0.lock().unwrap().resources.len(), 1);
        drop(restart);
        assert!(gate.begin_restart().is_err());
        resource.finish();
        gate.begin_restart().unwrap().commit();
    }

    #[test]
    fn display_resource_rejects_stale_foreign_duplicate_and_missing_permits() {
        let gate = Gate::default();
        let first = gate.enter_resource_classified().unwrap();
        let stale = first.permit(); first.finish();
        let live = gate.enter_resource_classified().unwrap();
        let other = Gate::default(); let foreign = other.enter_resource_classified().unwrap();
        assert!(gate.begin_restart_with_resources(&[stale]).is_err());
        assert!(gate.begin_restart_with_resources(&[foreign.permit()]).is_err());
        assert!(gate.begin_restart_with_resources(&[live.permit(), live.permit()]).is_err());
        let second = gate.enter_resource_classified().unwrap();
        assert!(gate.begin_restart_with_resources(&[live.permit()]).is_err());
        let restart = gate.begin_restart_with_resources(&[live.permit(), second.permit()]).unwrap();
        drop(restart); second.finish(); live.finish(); foreign.finish();
        gate.begin_restart().unwrap().commit();
    }

    #[test]
    fn display_resource_unknown_drop_or_business_drop_never_becomes_ready() {
        let gate = Gate::default();
        let resource = gate.enter_resource_classified().unwrap();
        drop(gate.enter().unwrap());
        assert!(gate.begin_restart_with_resources(&[resource.permit()]).is_err());
        resource.finish(); assert!(gate.begin_restart().is_err());
        let other = Gate::default(); let resource = other.enter_resource_classified().unwrap();
        let permit = resource.permit(); drop(resource);
        assert!(other.begin_restart_with_resources(&[permit]).is_err());
        assert!(other.begin_restart().is_err());
        let closed = Gate::default(); let resource = closed.enter_resource_classified().unwrap();
        closed.close();
        assert!(closed.begin_restart_with_resources(&[resource.permit()]).is_err());
        resource.finish(); assert!(closed.begin_restart().is_err());
    }

    #[test]
    fn poisoned_gate_never_reports_restart_ready() {
        let gate = Gate::default(); let other = gate.clone();
        assert!(std::thread::spawn(move || { let _lock = other.0.lock().unwrap(); panic!("fixture poison"); }).join().is_err());
        assert!(gate.enter().is_err()); assert!(gate.begin_restart().is_err());
    }
}

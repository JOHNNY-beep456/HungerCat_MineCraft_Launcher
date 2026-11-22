//! 更新应用的任务登记；仅管理生命周期，不授予任何目录或文件写入权限。
use std::{collections::HashMap, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}};

type Result<T> = std::result::Result<T, String>;
const MAX_ACTIVE: usize = 8;
const UNAVAILABLE: &str = "资源更新任务状态无法确认 / 資源更新工作狀態無法確認 / Resource update task state is unconfirmed";

#[derive(Default)]
struct State {
    closed: bool,
    uncertain: bool,
    active: HashMap<String, Arc<Operation>>,
}

struct Operation {
    scope: String,
    cancel: Arc<AtomicBool>,
}

/// scope 只是宿主提供的互斥键，绝不作为文件系统路径使用。
/// 实际目录授权、规范化和恢复由更新编排及事务层独立执行。
#[derive(Clone, Default)]
pub(super) struct Registry(Arc<Mutex<State>>);

pub(super) struct Registration {
    registry: Registry,
    task_id: String,
    operation: Arc<Operation>,
    finished: bool,
}

impl Registry {
    pub(super) fn begin(&self, task_id: &str, scope: &str) -> Result<Registration> {
        if task_id.is_empty() || task_id.len() > 128 || scope.is_empty() || scope.len() > 32768
            || task_id.chars().any(char::is_control) || scope.chars().any(char::is_control) {
            return Err("更新任务标识无效 / 更新工作識別碼無效 / Invalid update task identity".into());
        }
        let mut state = self.0.lock().map_err(|_| UNAVAILABLE)?;
        if state.closed || state.uncertain { return Err(UNAVAILABLE.into()); }
        if state.active.len() >= MAX_ACTIVE { return Err("资源更新任务过多 / 資源更新工作過多 / Too many resource updates".into()); }
        if state.active.contains_key(task_id) || state.active.values().any(|entry| entry.scope == scope) {
            return Err("此游戏目录已有更新任务 / 此遊戲目錄已有更新工作 / An update already owns this game directory".into());
        }
        let operation = Arc::new(Operation { scope: scope.into(), cancel: Arc::new(AtomicBool::new(false)) });
        state.active.insert(task_id.into(), operation.clone());
        Ok(Registration { registry: self.clone(), task_id: task_id.into(), operation, finished: false })
    }

    /// 请求停止不会清除登记；只有实际工作及其收尾完成才能 finish。
    pub(super) fn cancel(&self, task_id: Option<&str>) -> Result<()> {
        let state = self.0.lock().map_err(|_| UNAVAILABLE)?;
        for (id, operation) in &state.active {
            if task_id.map_or(true, |wanted| wanted == id) { operation.cancel.store(true, Ordering::Release); }
        }
        Ok(())
    }

    pub(super) fn close(&self) {
        if let Ok(mut state) = self.0.lock() {
            state.closed = true;
            for operation in state.active.values() { operation.cancel.store(true, Ordering::Release); }
        }
    }

    pub(super) fn ready(&self) -> Result<()> {
        let state = self.0.try_lock().map_err(|_| UNAVAILABLE)?;
        if state.uncertain || !state.active.is_empty() { return Err(UNAVAILABLE.into()); }
        Ok(())
    }
}

impl Registration {
    pub(super) fn cancel(&self) -> Arc<AtomicBool> { self.operation.cancel.clone() }
    pub(super) fn task_id(&self) -> &str { &self.task_id }
    /// 调用方必须已等候所有工作线程、文件关闭和事务恢复；错误返回不自动等于已收尾。
    pub(super) fn finish(mut self) { self.finished = true; }
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.operation.cancel.store(true, Ordering::Release);
        if let Ok(mut state) = self.registry.0.lock() {
            let owns = state.active.get(&self.task_id).is_some_and(|entry| Arc::ptr_eq(entry, &self.operation));
            if self.finished && owns {
                state.active.remove(&self.task_id);
            } else {
                // 未确认收尾时保留原登记并封闭新更新，不以析构假装取消成功。
                state.uncertain = true;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_preserves_scope_until_actual_completion() {
        let registry = Registry::default();
        let first = registry.begin("resource-update:first", "root-a").unwrap();
        assert_eq!(first.task_id(), "resource-update:first");
        let stop = first.cancel();
        registry.cancel(Some("unrelated-download")).unwrap();
        assert!(!stop.load(Ordering::Acquire));
        registry.cancel(Some(first.task_id())).unwrap();
        assert!(stop.load(Ordering::Acquire));
        assert!(registry.ready().is_err());
        assert!(registry.begin("resource-update:second", "root-a").is_err());
        first.finish();
        assert!(registry.ready().is_ok());
        registry.begin("resource-update:second", "root-a").unwrap().finish();
    }

    #[test]
    fn owned_worker_retains_registration_after_caller_cancels() {
        let registry = Registry::default();
        let registration = registry.begin("resource-update:worker", "root-a").unwrap();
        let stop = registration.cancel();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            assert!(stop.load(Ordering::Acquire));
            registration.finish();
        });
        started_rx.recv().unwrap();
        registry.cancel(None).unwrap();
        assert!(registry.ready().is_err());
        assert!(registry.begin("resource-update:pending", "root-a").is_err());
        release_tx.send(()).unwrap();
        worker.join().unwrap();
        assert!(registry.ready().is_ok());
    }

    #[test]
    fn abnormal_completion_stays_unconfirmed_and_close_does_not_release_owner() {
        let registry = Registry::default();
        drop(registry.begin("resource-update:unknown", "root-a").unwrap());
        assert!(registry.ready().is_err());
        assert!(registry.begin("resource-update:new", "root-b").is_err());
        registry.cancel(None).unwrap();
        let other = Registry::default();
        let active = other.begin("resource-update:active", "root-a").unwrap();
        let stop = active.cancel();
        other.close();
        assert!(stop.load(Ordering::Acquire));
        assert!(other.ready().is_err());
        assert!(other.begin("resource-update:new", "root-b").is_err());
        active.finish();
        assert!(other.ready().is_ok());
        assert!(other.begin("resource-update:new", "root-b").is_err());
    }

    #[test]
    fn registry_bounds_work_and_rejects_unavailable_state() {
        let registry = Registry::default();
        let mut registrations = Vec::new();
        for index in 0..MAX_ACTIVE {
            registrations.push(registry.begin(&format!("resource-update:{index}"), &format!("root-{index}")).unwrap());
        }
        assert!(registry.begin("resource-update:overflow", "root-extra").is_err());
        for registration in registrations { registration.finish(); }
        assert!(registry.ready().is_ok());
        assert!(registry.begin("", "root").is_err());
        assert!(registry.begin("task", "").is_err());
        let locked = registry.0.lock().unwrap();
        assert!(registry.ready().is_err());
        drop(locked);
        let poison = registry.clone();
        assert!(std::thread::spawn(move || {
            let _lock = poison.0.lock().unwrap();
            panic!("fixture unavailable state");
        }).join().is_err());
        assert!(registry.ready().is_err());
        assert!(registry.cancel(None).is_err());
        assert!(registry.begin("resource-update:new", "root-new").is_err());
    }
}

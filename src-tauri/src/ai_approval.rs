use crate::ai_tool_runtime::{ApprovalSnapshot, ApprovalState, ToolIntent};
use std::{collections::HashMap, path::Path, sync::Mutex};
use tokio::sync::oneshot;

#[derive(Default)]
struct QueueState {
    approvals: ApprovalState,
    senders: HashMap<String, oneshot::Sender<bool>>,
    decisions: HashMap<String, bool>,
}

/// 投递、消费和清理共用同一把锁，不能在取消后重新留下已批准记录。
#[derive(Default)]
pub(crate) struct ApprovalQueue { inner: Mutex<QueueState> }

impl ApprovalQueue {
    pub(crate) fn register(&self, snapshot: ApprovalSnapshot, now_ms: u64) -> Result<oneshot::Receiver<bool>, String> {
        let mut state=self.inner.lock().map_err(|_|"工具确认队列不可用")?;
        let id=snapshot.request_id().to_owned();
        state.approvals.insert(snapshot,now_ms)?;
        let (sender,receiver)=oneshot::channel();
        state.senders.insert(id,sender);
        Ok(receiver)
    }

    pub(crate) fn notify(&self, id: &str, approved: bool) -> Result<(), String> {
        let mut state=self.inner.lock().map_err(|_|"工具确认队列不可用")?;
        let sender=state.senders.remove(id).ok_or("工具确认已结束、已取消或不存在")?;
        state.decisions.insert(id.to_owned(),approved);
        if sender.send(approved).is_err(){
            state.decisions.remove(id);
            state.approvals.cancel(id)?;
            return Err("工具确认等待已结束".into());
        }
        Ok(())
    }

    pub(crate) fn finish(&self, id: &str, approved: bool, chat_id: &str, intent: &ToolIntent, root: &Path, selected_dir_id: &str, now_ms: u64) -> Result<bool, String> {
        let mut state=self.inner.lock().map_err(|_|"工具确认队列不可用")?;
        let decision=state.decisions.remove(id);
        state.senders.remove(id);
        if decision!=Some(approved){
            state.approvals.cancel(id)?;
            return Err("工具确认未投递或状态不一致".into());
        }
        state.approvals.decide(id,approved,chat_id,intent,root,selected_dir_id,now_ms).map(|snapshot|snapshot.is_some())
    }

    pub(crate) fn cancel(&self, id: &str) -> Result<(), String> {
        let mut state=self.inner.lock().map_err(|_|"工具确认队列不可用")?;
        state.senders.remove(id);state.decisions.remove(id);
        state.approvals.cancel(id)?;
        Ok(())
    }

    pub(crate) fn clear(&self) -> Result<(), String> {
        let mut state=self.inner.lock().map_err(|_|"工具确认队列不可用")?;
        for (_,sender) in state.senders.drain(){let _=sender.send(false);}
        state.decisions.clear();
        state.approvals.clear()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn root() -> std::path::PathBuf { std::env::temp_dir().join("hcmcl-approval-fixture") }
    fn intent() -> ToolIntent { crate::ai_tool_runtime::validate_intent("provider-call", "launcher_delete_version", &json!({"versionId":"fixture"})).unwrap() }
    fn snapshot(id: &str) -> ApprovalSnapshot { ApprovalSnapshot::new(id, "chat", &intent(), &root(), "default", 10).unwrap() }

    #[tokio::test]
    async fn notification_is_single_use_and_does_not_bypass_snapshot_binding() {
        let queue = ApprovalQueue::default();
        let receiver = queue.register(snapshot("request"), 10).unwrap();
        queue.notify("request", true).unwrap();
        assert!(queue.notify("request", true).is_err());
        assert!(receiver.await.unwrap());
        assert!(queue.finish("request", true, "chat", &intent(), &root().join("different"), "default", 11).is_err());
        assert!(queue.finish("request", true, "chat", &intent(), &root(), "default", 11).is_err());
    }

    #[tokio::test]
    async fn approved_and_denied_decisions_consume_their_records() {
        let queue = ApprovalQueue::default();
        for (id, approved) in [("yes", true), ("no", false)] {
            let receiver = queue.register(snapshot(id), 10).unwrap();
            queue.notify(id, approved).unwrap();
            assert_eq!(receiver.await.unwrap(), approved);
            assert_eq!(queue.finish(id, approved, "chat", &intent(), &root(), "default", 11).unwrap(), approved);
            assert!(queue.finish(id, true, "chat", &intent(), &root(), "default", 12).is_err());
        }
    }

    #[tokio::test]
    async fn cancellation_and_clear_release_waiters_without_restoring_old_ids() {
        let queue = ApprovalQueue::default();
        let receiver = queue.register(snapshot("cancelled"), 10).unwrap();
        queue.cancel("cancelled").unwrap();
        assert!(receiver.await.is_err());
        assert!(queue.register(snapshot("cancelled"), 10).is_err());
        let receiver = queue.register(snapshot("cleared"), 10).unwrap();
        queue.clear().unwrap();
        assert!(!receiver.await.unwrap());
        assert!(queue.finish("cleared", true, "chat", &intent(), &root(), "default", 11).is_err());
        assert!(queue.register(snapshot("cleared"), 10).is_err());
    }

    #[tokio::test]
    async fn finish_requires_the_exact_delivered_user_decision_and_clear_revokes_approval() {
        let queue=ApprovalQueue::default();
        let receiver=queue.register(snapshot("not-delivered"),10).unwrap();
        assert!(queue.finish("not-delivered",true,"chat",&intent(),&root(),"default",11).is_err());
        assert!(receiver.await.is_err());
        let receiver=queue.register(snapshot("denied-not-approved"),10).unwrap();
        queue.notify("denied-not-approved",false).unwrap();assert!(!receiver.await.unwrap());
        assert!(queue.finish("denied-not-approved",true,"chat",&intent(),&root(),"default",11).is_err());
        let receiver=queue.register(snapshot("approved-then-cleared"),10).unwrap();
        queue.notify("approved-then-cleared",true).unwrap();assert!(receiver.await.unwrap());queue.clear().unwrap();
        assert!(queue.finish("approved-then-cleared",true,"chat",&intent(),&root(),"default",11).is_err());
    }

    #[test]
    fn concurrent_notify_and_clear_never_leave_an_executable_approval() {
        for index in 0..32 {
            let queue=std::sync::Arc::new(ApprovalQueue::default());
            let id=format!("race-{index}");
            let _receiver=queue.register(snapshot(&id),10).unwrap();
            let barrier=std::sync::Arc::new(std::sync::Barrier::new(3));
            let notifying={let queue=queue.clone();let barrier=barrier.clone();let id=id.clone();std::thread::spawn(move||{barrier.wait();let _=queue.notify(&id,true);})};
            let clearing={let queue=queue.clone();let barrier=barrier.clone();std::thread::spawn(move||{barrier.wait();queue.clear().unwrap();})};
            barrier.wait();notifying.join().unwrap();clearing.join().unwrap();
            assert!(queue.finish(&id,true,"chat",&intent(),&root(),"default",11).is_err());
            assert!(queue.notify(&id,true).is_err());
        }
    }

    #[tokio::test]
    async fn dropped_waiter_and_expired_snapshot_cannot_be_approved() {
        let queue = ApprovalQueue::default();
        drop(queue.register(snapshot("dropped"), 10).unwrap());
        assert!(queue.notify("dropped", true).is_err());
        assert!(queue.finish("dropped", true, "chat", &intent(), &root(), "default", 11).is_err());
        let receiver = queue.register(snapshot("expired"), 10).unwrap();
        queue.notify("expired", true).unwrap();
        assert!(receiver.await.unwrap());
        assert!(queue.finish("expired", true, "chat", &intent(), &root(), "default", 180_010).is_err());
    }
}

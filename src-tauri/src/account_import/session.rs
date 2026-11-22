//! 仅内存的账号导入会话。秘密不实现 Debug/Serialize，预览由白名单手工投影。
use crate::downloads::Cancel;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU8, Ordering}};
use std::time::{Duration, Instant};

const TTL: Duration = Duration::from_secs(600);

pub(super) struct Entry {
    pub(super) key: String,
    pub(super) account: Value,
    pub(super) status: String,
}

pub(super) struct Ticket {
    pub(super) id: String,
    pub(super) owner: String,
    pub(super) cancel: Arc<Cancel>,
    pub(super) uncertain: AtomicBool,
    // 0=可取消的准备；1=已取消；2=已经进入不可分割的保存事务。
    phase: AtomicU8,
    created: Instant,
}

impl Ticket {
    pub(super) fn cancel(&self) {
        let _=self.phase.compare_exchange(0,1,Ordering::AcqRel,Ordering::Acquire);
        self.cancel.stop();
    }
    fn start_saving(&self) -> Result<(),String> {
        self.phase.compare_exchange(0,2,Ordering::AcqRel,Ordering::Acquire)
            .map(|_|()).map_err(|_|"账号导入已取消或已经进入保存事务".into())
    }
}

struct Slot {
    ticket: Arc<Ticket>,
    committing: bool,
    ready: bool,
    entries: Vec<Entry>,
}

#[derive(Default)]
struct State { closed: bool, removals: usize, slot: Option<Slot> }

#[derive(Default)]
pub(super) struct Sessions {
    state: Mutex<State>,
    /// 只在后台入库或删除账号时持有；窗口关闭/取消绝不等待此锁。
    pub(super) commit_gate: Mutex<()>,
}

impl Sessions {
    pub(super) fn reserve(&self, owner: &str) -> Result<Arc<Ticket>, String> {
        let mut state = self.state.lock().map_err(|_| "导入状态不可用")?;
        if state.closed { return Err("窗口已经关闭".into()); }
        if state.removals != 0 { return Err("账号删除仍在提交，请稍后导入".into()); }
        if state.slot.as_ref().is_some_and(|slot| slot.committing) { return Err("账号导入仍在提交，请等待完成".into()); }
        if let Some(previous) = state.slot.take() { previous.ticket.cancel(); }
        let ticket = Arc::new(Ticket { id: uuid::Uuid::new_v4().to_string(), owner: owner.into(), cancel: Arc::new(Cancel::default()), uncertain: AtomicBool::new(false), phase: AtomicU8::new(0), created: Instant::now() });
        state.slot = Some(Slot { ticket: ticket.clone(), committing: false, ready: false, entries: Vec::new() });
        Ok(ticket)
    }

    fn matches(slot: &Slot, ticket: &Arc<Ticket>) -> bool { Arc::ptr_eq(&slot.ticket, ticket) }

    fn live(slot: &Slot, ticket: &Arc<Ticket>) -> Result<(), String> {
        if !Self::matches(slot, ticket) { return Err("导入会话已失效".into()); }
        if ticket.created.elapsed() >= TTL { ticket.cancel(); return Err("导入会话已过期，请重新预览".into()); }
        ticket.cancel.check().map_err(|_| "账号导入已取消".into())
    }

    pub(super) fn check(&self, ticket: &Arc<Ticket>) -> Result<(), String> {
        let state = self.state.lock().map_err(|_| "导入状态不可用")?;
        if state.closed { return Err("窗口已经关闭".into()); }
        Self::live(state.slot.as_ref().ok_or("导入会话已失效")?, ticket)
    }

    /// 与所有取消来源竞争唯一的提交时点；调用者已经持后台 commit_gate。
    /// 状态锁只保护检查和 phase 切换，绝不跨磁盘或系统凭据存储调用。
    pub(super) fn start_saving(&self, ticket: &Arc<Ticket>) -> Result<(),String> {
        let state=self.state.lock().map_err(|_|"导入状态不可用")?;
        if state.closed || state.removals!=0 {return Err("账号导入已经失效".into());}
        let slot=state.slot.as_ref().ok_or("导入会话已失效")?;
        Self::live(slot,ticket)?;
        if !slot.committing {return Err("账号导入尚未提交".into());}
        ticket.start_saving()
    }

    pub(super) fn publish(&self, ticket: &Arc<Ticket>, entries: Vec<Entry>, warnings: Vec<String>) -> Result<Value, String> {
        if entries.len() > 500 || entries.iter().any(|entry| !matches!(entry.status.as_str(), "ready" | "temporary" | "refresh" | "relogin" | "duplicate")) {
            return Err("导入条目无效".into());
        }
        let mut state = self.state.lock().map_err(|_| "导入状态不可用")?;
        let slot = state.slot.as_mut().ok_or("导入会话已失效")?;
        Self::live(slot, ticket)?;
        if slot.committing { return Err("导入会话正在提交".into()); }
        let preview: Vec<Value> = entries.iter().map(|entry| json!({
            "key":entry.key,"name":entry.account.get("name").and_then(Value::as_str).unwrap_or(""),
            "type":entry.account.get("authType").and_then(Value::as_str).unwrap_or("microsoft"),"status":entry.status,
        })).collect();
        slot.entries = entries;
        slot.ready = true;
        let warnings: Vec<String> = warnings.into_iter().filter(|warning| matches!(warning.as_str(), "protected" | "unsupported" | "invalid")).collect();
        Ok(json!({"sessionId":ticket.id,"entries":preview,"warnings":warnings}))
    }

    pub(super) fn begin_commit(&self, owner: &str, id: &str, keys: &[String]) -> Result<(Arc<Ticket>, Vec<Entry>), String> {
        if keys.len() > 500 || keys.iter().any(|key| key.len() > 128) { return Err("导入选择无效".into()); }
        let mut state = self.state.lock().map_err(|_| "导入状态不可用")?;
        if state.closed { return Err("窗口已经关闭".into()); }
        let slot = state.slot.as_mut().ok_or("导入会话已失效")?;
        let ticket = slot.ticket.clone();
        if ticket.owner != owner || ticket.id != id { return Err("导入会话无权访问".into()); }
        Self::live(slot, &ticket)?;
        if slot.committing { return Err("账号导入仍在提交".into()); }
        if !slot.ready { return Err("账号来源仍在读取，请等待预览完成".into()); }
        let keys: HashSet<&str> = keys.iter().map(String::as_str).collect();
        if keys.iter().any(|key| !slot.entries.iter().any(|entry| entry.key == *key)) { return Err("导入选择已失效".into()); }
        let mut selected = Vec::with_capacity(keys.len());
        for entry in std::mem::take(&mut slot.entries) {
            if keys.contains(entry.key.as_str()) { selected.push(entry); }
        }
        slot.committing = true;
        Ok((ticket, selected))
    }

    pub(super) fn cancel(&self, owner: &str, id: &str) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "导入状态不可用")?;
        if let Some(slot) = state.slot.as_mut() {
            if slot.ticket.owner != owner || slot.ticket.id != id { return Err("导入会话无权访问".into()); }
            slot.ticket.cancel();
            slot.entries.clear();
            if !slot.committing { state.slot = None; }
        }
        Ok(())
    }

    /// 计时器只清未提交会话；提交保留租约，直至真实存储任务返回。
    pub(super) fn expire(&self, ticket: &Arc<Ticket>) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(slot) = state.slot.as_mut().filter(|slot| Self::matches(slot, ticket)) {
                ticket.cancel(); slot.entries.clear();
                if !slot.committing { state.slot = None; }
            }
        }
    }

    pub(super) fn finish(&self, ticket: &Arc<Ticket>) {
        if let Ok(mut state) = self.state.lock() {
            if state.slot.as_ref().is_some_and(|slot| Self::matches(slot, ticket)) { state.slot = None; }
        }
    }

    pub(super) fn begin_removal(&self) -> Result<(), String> {
        let mut state=self.state.lock().map_err(|_|"导入状态不可用")?;
        state.removals=state.removals.checked_add(1).ok_or("账号删除状态超过上限")?;
        if let Some(slot)=state.slot.as_mut() {
            slot.ticket.cancel();slot.entries.clear();
            if !slot.committing {state.slot=None;}
        }
        Ok(())
    }

    pub(super) fn end_removal(&self) {
        if let Ok(mut state)=self.state.lock() {state.removals=state.removals.saturating_sub(1);}
    }

    pub(super) fn invalidate(&self, close: bool) {
        if let Ok(mut state) = self.state.lock() {
            state.closed |= close;
            if let Some(slot) = state.slot.as_mut() {
                slot.ticket.cancel(); slot.entries.clear();
                if !slot.committing { state.slot = None; }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(key: &str, status: &str) -> Entry { Entry { key:key.into(),status:status.into(),account:json!({"id":"SECRET-UUID","name":"Fixture","authType":"microsoft","accessToken":"SECRET-TOKEN","refreshToken":"SECRET-REFRESH","microsoftAuth":{"clientId":"SECRET-CLIENT"}}) } }
    #[test]
    fn preview_is_a_strict_four_field_projection_and_owner_and_keys_are_bound() {
        let sessions = Sessions::default(); let ticket = sessions.reserve("main").unwrap();
        let preview = sessions.publish(&ticket, vec![entry("one","ready")],vec!["protected".into(),"SECRET".into()]).unwrap();
        let text = preview.to_string(); assert!(!text.contains("SECRET"));
        assert_eq!(preview["entries"][0].as_object().unwrap().len(),4);
        assert!(sessions.begin_commit("other",&ticket.id,&["one".into()]).is_err());
        assert!(sessions.begin_commit("main",&ticket.id,&["unknown".into()]).is_err());
        let (_, selected) = sessions.begin_commit("main",&ticket.id,&["one".into(),"one".into()]).unwrap(); assert_eq!(selected.len(),1);
        assert!(sessions.reserve("main").is_err()); assert!(sessions.begin_commit("main",&ticket.id,&[]).is_err());
        sessions.finish(&ticket); assert!(sessions.begin_commit("main",&ticket.id,&[]).is_err());
    }
    #[test]
    fn old_picker_timer_and_finish_cannot_destroy_new_session() {
        let sessions = Sessions::default(); let old = sessions.reserve("main").unwrap(); let new = sessions.reserve("main").unwrap();
        assert!(old.cancel.check().is_err()); assert!(sessions.publish(&old,vec![],vec![]).is_err());
        sessions.expire(&old); sessions.finish(&old); assert!(sessions.check(&new).is_ok());
        sessions.cancel("main",&new.id).unwrap(); assert!(sessions.check(&new).is_err());
    }
    #[test]
    fn cancellation_retains_commit_lease_and_close_prevents_late_reserve() {
        let sessions = Arc::new(Sessions::default()); let ticket = sessions.reserve("main").unwrap();
        sessions.publish(&ticket,vec![entry("key","temporary")],vec![]).unwrap();
        sessions.begin_commit("main",&ticket.id,&["key".into()]).unwrap();
        sessions.cancel("main",&ticket.id).unwrap(); assert!(sessions.reserve("main").is_err());
        sessions.expire(&ticket); assert!(sessions.reserve("main").is_err());
        sessions.finish(&ticket); assert!(sessions.reserve("main").is_ok());
        let barrier = Arc::new(std::sync::Barrier::new(2)); let child = sessions.clone(); let ready = barrier.clone();
        let worker=std::thread::spawn(move||{ready.wait();child.reserve("main").is_err()});
        sessions.invalidate(true); barrier.wait(); assert!(worker.join().unwrap()); assert!(sessions.reserve("main").is_err());
    }
    #[test]
    fn picking_cannot_commit_and_removal_blocks_new_sessions_until_real_store_returns() {
        let sessions=Sessions::default();let ticket=sessions.reserve("main").unwrap();
        assert!(sessions.begin_commit("main",&ticket.id,&[]).is_err());
        sessions.begin_removal().unwrap();assert!(sessions.check(&ticket).is_err());assert!(sessions.reserve("main").is_err());
        sessions.begin_removal().unwrap();sessions.end_removal();assert!(sessions.reserve("main").is_err());
        sessions.end_removal();assert!(sessions.reserve("main").is_ok());
    }
    #[test]
    fn cancellation_and_saving_have_one_atomic_commit_boundary() {
        let sessions=Sessions::default();let cancelled=sessions.reserve("main").unwrap();
        sessions.publish(&cancelled,vec![],vec![]).unwrap();sessions.begin_commit("main",&cancelled.id,&[]).unwrap();
        cancelled.cancel();assert!(sessions.start_saving(&cancelled).is_err());assert_eq!(cancelled.phase.load(Ordering::Acquire),1);
        sessions.finish(&cancelled);
        let saving=sessions.reserve("main").unwrap();sessions.publish(&saving,vec![],vec![]).unwrap();sessions.begin_commit("main",&saving.id,&[]).unwrap();
        sessions.start_saving(&saving).unwrap();sessions.cancel("main",&saving.id).unwrap();sessions.expire(&saving);
        assert_eq!(saving.phase.load(Ordering::Acquire),2);assert!(saving.cancel.check().is_err());assert!(sessions.reserve("main").is_err());
        sessions.finish(&saving);assert!(sessions.reserve("main").is_ok());
    }
    #[test]
    fn concurrent_waiter_cancel_and_save_never_both_win() {
        for _ in 0..32 {
            let sessions=Arc::new(Sessions::default());let ticket=sessions.reserve("main").unwrap();
            sessions.publish(&ticket,vec![],vec![]).unwrap();sessions.begin_commit("main",&ticket.id,&[]).unwrap();
            let barrier=Arc::new(std::sync::Barrier::new(2));let child=barrier.clone();let cancelled=ticket.clone();
            let worker=std::thread::spawn(move||{child.wait();cancelled.cancel();});
            barrier.wait();let saved=sessions.start_saving(&ticket).is_ok();worker.join().unwrap();
            assert_eq!(saved,ticket.phase.load(Ordering::Acquire)==2);assert!(ticket.cancel.check().is_err());
        }
    }
    #[test]
    fn expiration_is_checked_without_relying_on_timer_delivery() {
        let mut sessions = Sessions::default(); let ticket = Arc::new(Ticket {id:"expired".into(),owner:"main".into(),cancel:Arc::new(Cancel::default()),uncertain:AtomicBool::new(false),phase:AtomicU8::new(0),created:Instant::now()-TTL});
        sessions.state.get_mut().unwrap().slot=Some(Slot {ticket:ticket.clone(),committing:false,ready:true,entries:vec![entry("x","ready")]});
        assert!(sessions.check(&ticket).is_err()); assert!(sessions.begin_commit("main",&ticket.id,&["x".into()]).is_err());
    }
}

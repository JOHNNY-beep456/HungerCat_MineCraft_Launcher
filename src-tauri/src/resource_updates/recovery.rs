//! 每次取得游戏根锁后先恢复未完成的资源更新；无 journal 时不申请运行租约。
use super::{transaction, Result};
use crate::{install_lock::RootOperationGuard, runtime::{self, ResourceUpdateLease}};
use std::path::Path;

struct RecoveryOwner {
    root: Option<RootOperationGuard>,
    lease: Option<ResourceUpdateLease>,
    armed: bool,
}
impl RecoveryOwner {
    fn quarantine(&mut self) {
        if let Some(root) = self.root.take() { root.quarantine(); }
        if let Some(lease) = self.lease.take() { lease.quarantine(); }
    }
}
impl Drop for RecoveryOwner {
    fn drop(&mut self) {
        // panic、错误或未知恢复结果均不能通过析构释放写入作用域。
        if self.armed { self.quarantine(); }
    }
}

pub(super) fn under_guard(root: &Path, guard: RootOperationGuard) -> Result<RootOperationGuard> {
    recover(root, guard, None)
}

pub(super) fn for_launch(root: &Path, guard: RootOperationGuard, permit: &runtime::LaunchRecoveryPermit) -> Result<RootOperationGuard> {
    recover(root, guard, Some(permit))
}

fn recover(root: &Path, guard: RootOperationGuard, permit: Option<&runtime::LaunchRecoveryPermit>) -> Result<RootOperationGuard> {
    let mut owner = RecoveryOwner { root: Some(guard), lease: None, armed: true };
    match transaction::pending_under_guard(root) {
        Ok(false) => { owner.armed = false; return Ok(owner.root.take().expect("恢复根锁仍由当前所有者持有")); }
        Ok(true) => {}
        Err(error) => {
            if let Some(permit) = permit { permit.mark_uncertain(); }
            return Err(format!("资源更新现场无法确认，游戏目录保持封闭：{error}"));
        }
    }
    // 此处尚未开始恢复；游戏忙时仅拒绝本次操作，不取消游戏或改动 journal。
    let lease = match permit { Some(permit) => permit.acquire_lease(root), None => runtime::acquire_resource_update_lease() };
    match lease {
        Ok(lease) => owner.lease = Some(lease),
        Err(error) => { owner.armed = false; return Err(error); }
    }
    let result = transaction::recover_under_guard(root).and_then(|()| {
        if transaction::pending_under_guard(root)? { return Err("资源更新恢复后仍有未清理现场，游戏目录保持封闭".into()); }
        Ok(())
    });
    if let Err(error) = result {
        if let Some(permit) = permit { permit.mark_uncertain(); }
        return Err(format!("资源更新恢复未确认，游戏目录保持封闭：{error}"));
    }
    owner.armed = false;
    drop(owner.lease.take());
    Ok(owner.root.take().expect("恢复根锁仍由当前所有者持有"))
}

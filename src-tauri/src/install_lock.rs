//! 原版下载、目录事务与游戏启动准备共用的根锁。
//! 锁域按规范化根目录统一；该模块不依赖业务 Cancel，调用方通过闭包提供取消状态。
use std::{collections::HashMap, fs::{self, File, OpenOptions}, path::{Component, Path, PathBuf}, sync::{Arc, Mutex, OnceLock, Weak}, time::Duration};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

type Result<T> = std::result::Result<T, String>;

fn reject_link(path: &Path) -> Result<()> { reject_link_component(path, true) }
/// 祖先级软链接只在桌面平台拒绝（Android 私有目录前缀是系统别名）。
fn reject_link_component(path: &Path, final_segment: bool) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() && crate::path_alias::link_is_fatal(final_segment) { return Err("拒绝符号链接锁路径".into()); }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 { return Err("拒绝重解析点锁路径".into()); }
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("无法校验游戏目录锁路径".into()),
    }
}

fn absolute_components(path: &Path) -> Result<PathBuf> {
    walk_components(path).or_else(|error| match crate::path_alias::resolved_alias(path) {
        // 系统别名落在末级时，规范化一次再复核；仍然失败则保留原始错误。
        Some(canonical) => walk_components(&canonical).map_err(|_| error),
        None => Err(error),
    })
}
fn walk_components(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() || path.as_os_str().is_empty() { return Err("游戏目录锁路径必须是绝对路径".into()); }
    let mut current = PathBuf::new();
    let mut parts = path.components().peekable();
    while let Some(component) = parts.next() {
        // 锁作用域本身与启动器创建的后代必须无链接；Android 私有目录的祖先前缀由系统
        // 维护成别名软链接（见 `crate::path_alias`），只在桌面平台逐级拒绝。
        let final_segment = parts.peek().is_none();
        match component {
            // Windows 的 Prefix（例如 C:）本身是 drive-relative，不能在 RootDir 前做磁盘检查。
            Component::Prefix(prefix) => { current.push(prefix.as_os_str()); continue; },
            Component::RootDir => { current.push(component.as_os_str()); reject_link_component(&current, final_segment)?; continue; },
            Component::Normal(name) => current.push(name),
            Component::CurDir | Component::ParentDir => return Err("游戏目录锁路径不能含相对跳转".into()),
        }
        reject_link_component(&current, final_segment)?;
    }
    Ok(current)
}

fn canonical_root(input: &Path) -> Result<PathBuf> {
    let absolute = absolute_components(input)?;
    // 先检查现有父链，再创建缺失目录；避免 create_dir_all 沿着已存在链接写入。
    if !absolute.exists() {
        let mut parent = absolute.parent();
        while let Some(path) = parent {
            reject_link(path)?;
            if path.exists() { break; }
            parent = path.parent();
        }
        fs::create_dir_all(&absolute).map_err(|_| "无法创建游戏目录锁作用域")?;
    }
    let checked = absolute_components(&absolute)?;
    let canonical = fs::canonicalize(&checked).map_err(|_| "无法规范化游戏目录锁作用域")?;
    let canonical = absolute_components(&canonical)?;
    if !fs::metadata(&canonical).map_err(|_| "无法读取游戏目录锁作用域")?.is_dir() {
        return Err("游戏目录锁作用域不是目录".into());
    }
    Ok(canonical)
}

fn key(root: &Path) -> String {
    let mut value = root.to_string_lossy().replace('\\', "/");
    #[cfg(windows)] { value = value.to_lowercase(); }
    value
}

static REGISTRY: OnceLock<Mutex<HashMap<String, Weak<AsyncMutex<()>>>>> = OnceLock::new();
fn local_mutex(root: &Path) -> Result<Arc<AsyncMutex<()>>> {
    let mut registry = REGISTRY.get_or_init(|| Mutex::new(HashMap::new())).lock().map_err(|_| "目录锁登记不可用")?;
    registry.retain(|_, weak| weak.strong_count() != 0);
    let slot = registry.entry(key(root)).or_default();
    if let Some(existing) = slot.upgrade() { return Ok(existing); }
    let mutex = Arc::new(AsyncMutex::new(()));
    *slot = Arc::downgrade(&mutex);
    Ok(mutex)
}

struct ProcessLock { file: File }

// O_NOFOLLOW 在 macOS、Linux 泛 Unix 与 Android 的 arm/aarch64 ABI 数值不同。
// 不能用 cfg!(unix) 统一写死，否则 Android arm 会把不同的 fcntl 标志当成 no-follow。
#[cfg(target_os = "macos")]
const NO_FOLLOW_FLAG: i32 = 0x100;
#[cfg(all(target_os = "android", any(target_arch = "arm", target_arch = "aarch64")))]
const NO_FOLLOW_FLAG: i32 = 0x8000;
#[cfg(all(target_os = "android", not(any(target_arch = "arm", target_arch = "aarch64"))))]
const NO_FOLLOW_FLAG: i32 = 0x20000;
#[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
const NO_FOLLOW_FLAG: i32 = 0x20000;

#[cfg(windows)]
mod os_lock {
    use std::{ffi::c_void, fs::File, os::windows::io::AsRawHandle};
    #[repr(C)] struct Overlapped { internal: usize, internal_high: usize, offset: u32, offset_high: u32, event: *mut c_void }
    #[link(name = "kernel32")] extern "system" {
        fn LockFileEx(file: *mut c_void, flags: u32, reserved: u32, low: u32, high: u32, overlapped: *mut Overlapped) -> i32;
        fn UnlockFileEx(file: *mut c_void, reserved: u32, low: u32, high: u32, overlapped: *mut Overlapped) -> i32;
    }
    pub fn try_lock(file: &File) -> std::io::Result<bool> {
        let mut overlapped = Overlapped { internal: 0, internal_high: 0, offset: 0, offset_high: 0, event: std::ptr::null_mut() };
        if unsafe { LockFileEx(file.as_raw_handle() as *mut c_void, 3, 0, 1, 0, &mut overlapped) } != 0 { return Ok(true); }
        let error = std::io::Error::last_os_error();
        match error.raw_os_error() { Some(32) | Some(33) => Ok(false), _ => Err(error) }
    }
    pub fn unlock(file: &File) {
        let mut overlapped = Overlapped { internal: 0, internal_high: 0, offset: 0, offset_high: 0, event: std::ptr::null_mut() };
        unsafe { let _ = UnlockFileEx(file.as_raw_handle() as *mut c_void, 0, 1, 0, &mut overlapped); }
    }
}

#[cfg(unix)]
mod os_lock {
    use std::{fs::File, os::unix::io::AsRawFd};
    extern "C" { fn flock(fd: i32, operation: i32) -> i32; }
    pub fn try_lock(file: &File) -> std::io::Result<bool> {
        if unsafe { flock(file.as_raw_fd(), 2 | 4) } == 0 { return Ok(true); }
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::WouldBlock { Ok(false) } else { Err(error) }
    }
    pub fn unlock(file: &File) { unsafe { let _ = flock(file.as_raw_fd(), 8); } }
}

impl ProcessLock {
    fn open(root: &Path) -> Result<Self> {
        let path = root.join(".hcmcl-install.lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(NO_FOLLOW_FLAG);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x00200000);
        }
        let file = options.open(&path).map_err(|_| "无法打开跨进程安装锁")?;
        reject_link(&path)?;
        if !file.metadata().map_err(|_| "无法校验跨进程安装锁")?.is_file() { return Err("跨进程安装锁不是普通文件".into()); }
        Ok(Self { file })
    }
    fn try_lock(&self) -> Result<bool> { os_lock::try_lock(&self.file).map_err(|_| "取得跨进程安装锁失败".into()) }
}
impl Drop for ProcessLock { fn drop(&mut self) { os_lock::unlock(&self.file); } }

/// 持有整个目录文件事务；非重入，必须在同一操作完成后才销毁。
pub(crate) struct RootOperationGuard { process: ProcessLock, local: OwnedMutexGuard<()> }
impl RootOperationGuard {
    /// 未确认的事务不能通过析构放开本地或跨进程锁；仅进程退出后才由系统释放。
    pub(crate) fn quarantine(self) { std::mem::forget(self); }
}

/// 只取得真实根锁，恢复由相应业务入口在 owned 工作线程中完成。
async fn acquire_raw<F>(root: &Path, cancelled: F) -> Result<(PathBuf, RootOperationGuard)>
where F: Fn() -> bool
{
    // 等锁必须有上限：真正的持锁者只会在一次目录事务里出现（安装/更新/启动准备），
    // 若锁被别的进程长期占住，界面只会一直停在「启动中」，不如到点明确报错。
    const WAIT_LIMIT: Duration = Duration::from_secs(120);
    let canonical = canonical_root(root)?;
    if cancelled() { return Err("操作已取消".into()); }
    let started = std::time::Instant::now();
    let mutex = local_mutex(&canonical)?;
    let local = loop {
        if cancelled() { return Err("操作已取消".into()); }
        if started.elapsed() > WAIT_LIMIT { return Err("实例目录被其他任务占用超过 120 秒，已放弃本次操作".into()); }
        match Arc::clone(&mutex).try_lock_owned() {
            Ok(guard) => break guard,
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    };
    let process = ProcessLock::open(&canonical)?;
    loop {
        if cancelled() { return Err("操作已取消".into()); }
        if started.elapsed() > WAIT_LIMIT { return Err("实例目录被其他进程占用超过 120 秒，已放弃本次操作".into()); }
        if process.try_lock()? { break; }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Ok((canonical, RootOperationGuard { process, local }))
}

/// 异步取得同根目录锁。取消闭包在每次等待轮询前检查。
pub(crate) async fn acquire<F>(root: &Path, cancelled: F) -> Result<RootOperationGuard>
where F: Fn() -> bool {
    let (canonical, guard) = acquire_raw(root, cancelled).await?;
    // 通过 owned 同步工作线程恢复；调用方被丢弃也不提前释放正在恢复的根锁。
    tokio::task::spawn_blocking(move || crate::resource_updates::recover_under_guard(&canonical, guard))
        .await.map_err(|_| "资源更新恢复线程异常，目录锁状态未确认".to_owned())?
}

/// 唯一启动票据的恢复通道；不放宽普通资源更新对 active 启动的拒绝。
pub(crate) async fn acquire_for_launch<F>(root: &Path, cancelled: F, permit: crate::runtime::LaunchRecoveryPermit) -> Result<RootOperationGuard>
where F: Fn() -> bool {
    let (canonical, guard) = acquire_raw(root, cancelled).await?;
    tokio::task::spawn_blocking(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            crate::resource_updates::recover_for_launch_under_guard(&canonical, guard, &permit)
        }));
        match result {
            Ok(result) => result,
            Err(payload) => { permit.mark_uncertain(); std::panic::resume_unwind(payload) }
        }
    }).await.map_err(|_| "启动前资源恢复线程异常，目录锁状态未确认".to_owned())?
}

/// 同步取得同根目录锁。使用 try_lock_owned + 短暂休眠，不阻塞 Tokio executor。
pub(crate) fn acquire_blocking(root: &Path) -> Result<RootOperationGuard> {
    let canonical = canonical_root(root)?;
    let mutex = local_mutex(&canonical)?;
    let local = loop {
        match Arc::clone(&mutex).try_lock_owned() {
            Ok(guard) => break guard,
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    };
    let process = ProcessLock::open(&canonical)?;
    loop {
        if process.try_lock()? { break; }
        std::thread::sleep(Duration::from_millis(50));
    }
    crate::resource_updates::recover_under_guard(&canonical, RootOperationGuard { process, local })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocking_guard_serializes_same_root() {
        let root = std::env::temp_dir().join(format!("hcmcl-install-lock-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let guard = acquire_blocking(&root).unwrap();
        assert!(root.join(".hcmcl-install.lock").is_file());
        drop(guard);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(any(target_os = "macos", target_os = "android", all(unix, not(target_os = "macos"), not(target_os = "android"))))]
    #[test]
    fn no_follow_flag_matches_target_abi() {
        #[cfg(target_os = "macos")]
        assert_eq!(NO_FOLLOW_FLAG, 0x100);
        #[cfg(all(target_os = "android", any(target_arch = "arm", target_arch = "aarch64")))]
        assert_eq!(NO_FOLLOW_FLAG, 0x8000);
        #[cfg(all(target_os = "android", not(any(target_arch = "arm", target_arch = "aarch64"))))]
        assert_eq!(NO_FOLLOW_FLAG, 0x20000);
        #[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
        assert_eq!(NO_FOLLOW_FLAG, 0x20000);
    }

    #[cfg(windows)]
    #[test]
    fn windows_drive_root_is_checked_after_prefix() {
        let current = std::env::current_dir().unwrap();
        let prefix = current.components().find_map(|component| match component {
            Component::Prefix(prefix) => Some(prefix.as_os_str().to_owned()),
            _ => None,
        }).expect("Windows fixture must have a drive prefix");
        let mut drive_root = PathBuf::from(prefix);
        drive_root.push("\\");
        assert!(drive_root.is_absolute());
        assert!(absolute_components(&drive_root).is_ok());
    }

    #[tokio::test]
    async fn async_wait_is_exclusive_and_cancelable() {
        let root = std::env::temp_dir().join(format!("hcmcl-install-lock-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let first = acquire(&root, || false).await.unwrap();
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = Arc::clone(&cancelled);
        let path = root.clone();
        let waiter = tokio::spawn(async move { acquire(&path, move || flag.load(std::sync::atomic::Ordering::Acquire)).await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        cancelled.store(true, std::sync::atomic::Ordering::Release);
        let result = waiter.await.unwrap();
        assert!(result.is_err());
        drop(first);
        let second = acquire(&root, || false).await.unwrap();
        drop(second);
        fs::remove_dir_all(root).unwrap();
    }
}

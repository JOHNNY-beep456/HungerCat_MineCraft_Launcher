//! 受控实例目录创建入口；保留 `manage:openDir` 与 `resources:open` 各自的两参数路径契约。
//! 该模块只创建并返回经过锚定校验的目录路径，不调用系统文件管理器。

use serde_json::Value;
use std::{
    fs::{self, File},
    io,
    path::{Component, Path, PathBuf},
    sync::Arc,
};
use tauri::{AppHandle, Manager};

#[path = "modpack/access.rs"]
mod access;

type Result<T> = std::result::Result<T, Failure>;

const CHANNEL: &str = "manage:openDir";
const RESOURCE_CHANNEL: &str = "resources:open";
const KIND_NAMES: [&str; 6] = ["mods", "saves", "shaderpacks", "schematics", "version", "run"];
const RESOURCE_KIND_NAMES: [&str; 2] = ["resourcepacks", "shaderpacks"];

#[derive(Clone, Copy, Debug)]
enum DirectoryRequest {
    Manage,
    Resources,
}

impl DirectoryRequest {
    fn from_channel(channel: &str) -> Option<Self> {
        match channel {
            CHANNEL => Some(Self::Manage),
            RESOURCE_CHANNEL => Some(Self::Resources),
            _ => None,
        }
    }

    fn channel(self) -> &'static str {
        match self {
            Self::Manage => CHANNEL,
            Self::Resources => RESOURCE_CHANNEL,
        }
    }

    fn permits(self, kind: &str) -> bool {
        match self {
            Self::Manage => KIND_NAMES.contains(&kind),
            Self::Resources => RESOURCE_KIND_NAMES.contains(&kind),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Failure {
    InvalidArguments,
    Unsupported,
    Root,
    Instance,
    Create,
    Changed,
    Cancelled,
    Lock,
    Lifecycle,
    Unknown,
}

// access.rs 是以父模块 Result 的错误类型为边界复用的；把它的只读
// 诊断收敛为本模块的类别，最终仍由 message() 统一输出三语文本。
impl From<&str> for Failure {
    fn from(_: &str) -> Self {
        Failure::Changed
    }
}
impl From<String> for Failure {
    fn from(_: String) -> Self {
        Failure::Changed
    }
}

fn language(settings: &Value) -> &str {
    settings.get("language").and_then(Value::as_str).unwrap_or("zh-CN")
}

fn message(failure: Failure, language: &str) -> String {
    let (cn, tw, en) = match failure {
        Failure::InvalidArguments => (
            "打开实例目录的参数无效",
            "開啟實例目錄的參數無效",
            "Invalid instance-directory arguments",
        ),
        Failure::Unsupported => (
            "当前移动平台没有安全的实例目录访问能力",
            "目前行動平台沒有安全的實例目錄存取能力",
            "This mobile platform has no safe instance-directory access",
        ),
        Failure::Root => (
            "当前游戏目录不是可信的已登记绝对目录",
            "目前遊戲目錄不是可信的已登記絕對目錄",
            "The current game directory is not a trusted registered absolute directory",
        ),
        Failure::Instance => (
            "指定实例不存在或实例目录无效",
            "指定實例不存在或實例目錄無效",
            "The requested instance does not exist or is invalid",
        ),
        Failure::Create => (
            "实例目录无法安全创建，请检查目录权限",
            "實例目錄無法安全建立，請檢查目錄權限",
            "The instance directory could not be created safely; check directory permissions",
        ),
        Failure::Changed => (
            "实例目录或隔离设置在操作期间发生改变，请重试",
            "實例目錄或隔離設定在操作期間發生變更，請重試",
            "The instance directory or isolation settings changed during the operation; retry",
        ),
        Failure::Cancelled => (
            "打开实例目录操作已取消",
            "開啟實例目錄操作已取消",
            "Opening the instance directory was cancelled",
        ),
        Failure::Lock => (
            "无法取得实例目录操作锁",
            "無法取得實例目錄操作鎖",
            "Unable to acquire the instance-directory operation lock",
        ),
        Failure::Lifecycle => (
            "启动器生命周期状态不可用",
            "啟動器生命週期狀態無法使用",
            "Launcher lifecycle state is unavailable",
        ),
        Failure::Unknown => (
            "实例目录操作收尾状态未确认，请检查后重试",
            "實例目錄操作收尾狀態未確認，請檢查後重試",
            "Instance-directory completion is unconfirmed; inspect the state and retry",
        ),
    };
    if language == "zh-TW" || language.starts_with("zh_TW") || language.starts_with("zh-HK") {
        tw.to_owned()
    } else if language == "en" || language.starts_with("en-") || language.starts_with("en_") {
        en.to_owned()
    } else {
        cn.to_owned()
    }
}

fn check_cancel(cancel: &crate::downloads::Cancel) -> Result<()> {
    cancel.check().map_err(|_| Failure::Cancelled)
}

fn valid_root(root: &Path) -> Result<()> {
    if !root.is_absolute()
        || root
            .components()
            .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
        || root.parent().is_none()
        || root.file_name().is_none()
    {
        return Err(Failure::Root);
    }
    Ok(())
}

fn same_root(left: &Path, right: &Path) -> bool {
    let normalize = |path: &Path| {
        let mut value = path.to_string_lossy().replace('\\', "/");
        while value.len() > 1 && value.ends_with('/') {
            value.pop();
        }
        if cfg!(windows) {
            value.to_ascii_lowercase()
        } else {
            value
        }
    };
    normalize(left) == normalize(right)
}

fn verify_current_root(request: DirectoryRequest, root: &Path, current: &Value) -> Result<()> {
    let current_root = crate::operation_game_dir(request.channel(), &[], current).map_err(|_| Failure::Root)?;
    if !same_root(&current_root, root) {
        return Err(Failure::Changed);
    }
    Ok(())
}

fn parse_args(request: DirectoryRequest, args: &[Value]) -> Result<(&str, &str)> {
    if args.len() != 2 {
        return Err(Failure::InvalidArguments);
    }
    let id = args[0]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or(Failure::InvalidArguments)?;
    access::leaf(id).map_err(|_| Failure::InvalidArguments)?;
    let kind = args[1]
        .as_str()
        .filter(|value| request.permits(value))
        .ok_or(Failure::InvalidArguments)?;
    Ok((id, kind))
}

fn existing_directory(parent: &access::Directory, name: &str) -> Result<access::Directory> {
    let node = parent
        .child(name)
        .map_err(|_| Failure::Create)?
        .ok_or(Failure::Instance)?;
    if !node.meta.is_dir() {
        return Err(Failure::Instance);
    }
    parent.directory(node).map_err(|_| Failure::Changed)
}

fn create_child(parent: &access::Directory, name: &str, cancel: &crate::downloads::Cancel) -> Result<access::Directory> {
    check_cancel(cancel)?;
    access::leaf(name).map_err(|_| Failure::Create)?;
    if let Some(node) = parent.child(name).map_err(|_| Failure::Create)? {
        if !node.meta.is_dir() {
            return Err(Failure::Create);
        }
        return parent.directory(node).map_err(|_| Failure::Changed);
    }

    match native::mkdir_child(parent.handle(), parent.path(), name) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(_) => {
            // 可信写入方可能已在读取和创建之间建好目录，仍须经锚定读取器重验。
            if parent.child(name).map_err(|_| Failure::Create)?.is_none() {
                return Err(Failure::Create);
            }
        }
    }
    check_cancel(cancel)?;
    let node = parent
        .child(name)
        .map_err(|_| Failure::Changed)?
        .ok_or(Failure::Changed)?;
    if !node.meta.is_dir() {
        return Err(Failure::Changed);
    }
    parent.directory(node).map_err(|_| Failure::Changed)
}

fn ensure_target(
    request: DirectoryRequest,
    root: &Path,
    id: &str,
    kind: &str,
    settings: &Value,
    cancel: &crate::downloads::Cancel,
) -> Result<PathBuf> {
    valid_root(root)?;
    access::leaf(id).map_err(|_| Failure::InvalidArguments)?;
    if !request.permits(kind) {
        return Err(Failure::InvalidArguments);
    }
    check_cancel(cancel)?;

    let isolation = crate::modpack::instance_isolation(root, id, settings).map_err(|_| Failure::Instance)?;
    let root_directory = access::Directory::open(root).map_err(|_| Failure::Root)?;
    root_directory.verify().map_err(|_| Failure::Changed)?;

    // versions 和实例本身必须已登记存在；这里只创建经通道白名单确认的目标子目录。
    let versions = existing_directory(&root_directory, "versions")?;
    let version = existing_directory(&versions, id)?;
    let run = if isolation.isolated { version.clone() } else { root_directory.clone() };
    let target = match kind {
        "version" => version,
        "run" => run,
        "mods" | "saves" | "shaderpacks" | "schematics" | "resourcepacks" => create_child(&run, kind, cancel)?,
        _ => return Err(Failure::InvalidArguments),
    };

    check_cancel(cancel)?;
    isolation.verify().map_err(|_| Failure::Changed)?;
    target.verify().map_err(|_| Failure::Changed)?;
    Ok(target.path().to_path_buf())
}

async fn owned(
    app: AppHandle,
    request: DirectoryRequest,
    root: PathBuf,
    id: String,
    kind: String,
    cancel: Arc<crate::downloads::Cancel>,
    registration: crate::lifecycle::Request,
) -> Result<PathBuf> {
    let guard = match crate::install_lock::acquire(&root, || cancel.check().is_err()).await {
        Ok(guard) => guard,
        Err(_) => {
            registration.finish();
            return Err(if cancel.check().is_err() { Failure::Cancelled } else { Failure::Lock });
        }
    };
    let work = tokio::task::spawn_blocking(move || {
        // Storage 的闭包在 data mutex 内执行，root lock 已先取得；因此不会用旧快照
        // 解析出另一版本目录，也不会在校验和 mkdir 之间允许设置切换。
        let result = match app.try_state::<crate::storage::Storage>() {
            None => Err(Failure::Lifecycle),
            Some(storage) => storage
                .with_settings_for_backend(|current| {
                    verify_current_root(request, &root, current)?;
                    ensure_target(request, &root, &id, &kind, current, &cancel)
                })
                .map_err(|_| Failure::Changed)
                .and_then(|result| result),
        };
        (result, false)
    });
    match work.await {
        Ok((result, _unknown)) => {
            drop(guard);
            registration.finish();
            result
        }
        Err(_) => {
            // JoinError 后无法确认系统操作收尾，保留生命周期和根锁所有权。
            std::mem::forget((registration, guard));
            Err(Failure::Unknown)
        }
    }
}

struct Waiting(Arc<crate::downloads::Cancel>);
impl Drop for Waiting {
    fn drop(&mut self) {
        self.0.stop();
    }
}

/// 两个通道分别校验各自的 kind 白名单，返回路径供渲染层打开，不调用系统文件管理器。
pub(crate) async fn call(
    app: &AppHandle,
    channel: &str,
    args: &[Value],
    settings: &Value,
    game_dir: &Path,
) -> std::result::Result<Option<Value>, String> {
    let request = match DirectoryRequest::from_channel(channel) {
        Some(request) => request,
        None => return Ok(None),
    };
    let language = language(settings).to_owned();
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (app, request, args, settings, game_dir);
        return Err(message(Failure::Unsupported, &language));
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let (id, kind) = parse_args(request, args).map_err(|failure| message(failure, &language))?;
        valid_root(game_dir).map_err(|failure| message(failure, &language))?;
        let registration = app
            .try_state::<crate::lifecycle::Gate>()
            .ok_or_else(|| message(Failure::Lifecycle, &language))?
            .enter()
            .map_err(|_| message(Failure::Lifecycle, &language))?;
        let cancel = Arc::new(crate::downloads::Cancel::default());
        let _waiting = Waiting(cancel.clone());
        let root = game_dir.to_path_buf();
        let app = app.clone();
        let result = tokio::spawn(owned(app, request, root, id.to_owned(), kind.to_owned(), cancel, registration))
            .await
            .map_err(|_| message(Failure::Unknown, &language))?;
        result
            .map(|path| Some(Value::String(path.to_string_lossy().into_owned())))
            .map_err(|failure| message(failure, &language))
    }
}

#[cfg(unix)]
mod native {
    use super::*;
    use std::{ffi::CString, os::fd::AsRawFd};

    extern "C" {
        fn mkdirat(dirfd: i32, pathname: *const std::os::raw::c_char, mode: u32) -> i32;
    }

    pub(super) fn mkdir_child(parent: &File, _path: &Path, name: &str) -> io::Result<()> {
        let name = CString::new(name).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid directory name"))?;
        let result = unsafe { mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) };
        if result == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::{ffi::c_void, os::windows::io::{AsRawHandle, FromRawHandle}};

    type Handle = *mut c_void;
    #[repr(C)] struct UnicodeString { length: u16, maximum: u16, buffer: *mut u16 }
    #[repr(C)] struct ObjectAttributes { length: u32, root: Handle, name: *mut UnicodeString, flags: u32, security: *mut c_void, qos: *mut c_void }
    #[repr(C)] struct IoStatus { status: isize, information: usize }
    #[link(name = "ntdll")]
    extern "system" {
        fn NtCreateFile(file: *mut Handle, access: u32, attrs: *mut ObjectAttributes, status: *mut IoStatus,
            allocation: *const i64, attributes: u32, share: u32, disposition: u32, options: u32,
            ea: *mut c_void, ea_len: u32) -> i32;
        fn RtlNtStatusToDosError(status: i32) -> u32;
    }

    pub(super) fn mkdir_child(parent: &File, _path: &Path, name: &str) -> io::Result<()> {
        access::leaf(name).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        let mut wide = name.encode_utf16().collect::<Vec<_>>();
        let bytes = u16::try_from(wide.len().checked_mul(2).ok_or(io::ErrorKind::InvalidInput)?)
            .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        let mut unicode = UnicodeString { length: bytes, maximum: bytes, buffer: wide.as_mut_ptr() };
        // RootDirectory 使用已持有的父句柄，不经完整路径重开或 create_dir 跳转重解析点。
        let mut attrs = ObjectAttributes {
            length: std::mem::size_of::<ObjectAttributes>() as u32,
            root: parent.as_raw_handle(), name: &mut unicode, flags: 0x40,
            security: std::ptr::null_mut(), qos: std::ptr::null_mut(),
        };
        let mut status = IoStatus { status: 0, information: 0 };
        let mut raw: Handle = std::ptr::null_mut();
        let result = unsafe {
            NtCreateFile(
                &mut raw, 0x8000_0000 | 0x0010_0000, &mut attrs, &mut status,
                std::ptr::null(), 0, 3, 2, 0x20 | 0x0020_0000 | 0x1,
                std::ptr::null_mut(), 0,
            )
        };
        if result < 0 {
            return Err(io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(result) } as i32));
        }
        // 关闭新句柄后仍须由 access::Directory 锚定重开，核验身份和重解析属性。
        unsafe { drop(File::from_raw_handle(raw)); }
        Ok(())
    }
}

#[cfg(not(any(unix, windows)))]
mod native {
    use super::*;
    pub(super) fn mkdir_child(_parent: &File, _path: &Path, _name: &str) -> io::Result<()> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "directory creation is unsupported"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("hcmcl-open-dir-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(root.join("versions/demo")).unwrap();
            Self(fs::canonicalize(root).unwrap())
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn parser_keeps_two_argument_contract_and_rejects_null_or_unknown_kind() {
        assert_eq!(parse_args(DirectoryRequest::Manage, &[json!("demo"), json!("run")]).unwrap(), ("demo", "run"));
        for args in [
            vec![json!("demo")],
            vec![json!("demo"), Value::Null],
            vec![json!("demo"), json!("resourcepacks")],
            vec![json!("../demo"), json!("run")],
            vec![json!("demo"), json!("../run")],
        ] {
            assert!(parse_args(DirectoryRequest::Manage, &args).is_err());
        }
    }

    #[test]
    fn each_legacy_kind_is_created_under_the_correct_instance_root() {
        let fixture = Fixture::new();
        let settings = json!({});
        let cancel = crate::downloads::Cancel::default();
        // 默认设置未启用隔离：旧版 runDir 将内容目录放在共享游戏根。
        for kind in ["mods", "saves", "shaderpacks", "schematics"] {
            let target = ensure_target(DirectoryRequest::Manage, &fixture.0, "demo", kind, &settings, &cancel).unwrap();
            assert_eq!(target, fixture.0.join(kind));
        }
        assert_eq!(ensure_target(DirectoryRequest::Manage, &fixture.0, "demo", "version", &settings, &cancel).unwrap(), fixture.0.join("versions/demo"));
        assert_eq!(ensure_target(DirectoryRequest::Manage, &fixture.0, "demo", "run", &settings, &cancel).unwrap(), fixture.0);
    }

    #[test]
    fn isolation_marker_moves_run_content_without_leaving_registered_root() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("versions/demo/instance.json"), br#"{"isolation":true}"#).unwrap();
        let current = json!({"gameDirAbs": fixture.0.to_string_lossy()});
        verify_current_root(DirectoryRequest::Manage, &fixture.0, &current).unwrap();
        let target = ensure_target(DirectoryRequest::Manage, &fixture.0, "demo", "mods", &current, &crate::downloads::Cancel::default()).unwrap();
        assert_eq!(target, fixture.0.join("versions/demo/mods"));
        assert!(!target.starts_with(fixture.0.join("outside")));
    }

    #[test]
    fn changed_registered_root_is_rejected_before_target_creation() {
        let fixture = Fixture::new();
        let other = std::env::temp_dir().join(format!("hcmcl-open-dir-other-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&other).unwrap();
        let other = fs::canonicalize(other).unwrap();
        let current = json!({"gameDirAbs": other.to_string_lossy()});
        assert!(verify_current_root(DirectoryRequest::Manage, &fixture.0, &current).is_err());
        assert!(!fixture.0.join("mods").exists());
        let _ = fs::remove_dir_all(other);
    }

    #[test]
    fn shared_root_latest_isolation_decision_is_used_by_same_validation_path() {
        let fixture = Fixture::new();
        let current = json!({"gameDirAbs": fixture.0.to_string_lossy(), "versionIsolation": true});
        verify_current_root(DirectoryRequest::Manage, &fixture.0, &current).unwrap();
        let target = ensure_target(DirectoryRequest::Manage, &fixture.0, "demo", "mods", &current, &crate::downloads::Cancel::default()).unwrap();
        assert_eq!(target, fixture.0.join("versions/demo/mods"));
    }

    #[test]
    fn missing_instance_and_uncreatable_path_fail_without_fabricating_another_root() {
        let fixture = Fixture::new();
        let cancel = crate::downloads::Cancel::default();
        assert!(ensure_target(DirectoryRequest::Manage, &fixture.0, "missing", "mods", &json!({}), &cancel).is_err());
        assert!(ensure_target(DirectoryRequest::Manage, &fixture.0, "demo", "resourcepacks", &json!({}), &cancel).is_err());
        assert!(!fixture.0.join("versions/missing/mods").exists());
    }

    #[test]
    fn resource_channels_keep_separate_whitelists_and_strict_arguments() {
        let manage = DirectoryRequest::from_channel(CHANNEL).unwrap();
        let resources = DirectoryRequest::from_channel(RESOURCE_CHANNEL).unwrap();
        assert!(DirectoryRequest::from_channel("resources:openOther").is_none());
        for kind in RESOURCE_KIND_NAMES {
            assert_eq!(parse_args(resources, &[json!("demo"), json!(kind)]).unwrap(), ("demo", kind));
        }
        assert!(parse_args(manage, &[json!("demo"), json!("resourcepacks")]).is_err());
        for kind in ["mods", "saves", "schematics", "version", "run"] {
            assert!(parse_args(resources, &[json!("demo"), json!(kind)]).is_err());
        }
        for request in [manage, resources] {
            let valid_kind = if matches!(request, DirectoryRequest::Manage) { "mods" } else { "resourcepacks" };
            for args in [
                vec![],
                vec![json!("demo")],
                vec![json!("demo"), json!(valid_kind), Value::Null],
                vec![json!("demo"), Value::Null],
                vec![json!("demo"), json!(7)],
                vec![Value::Null, json!(valid_kind)],
                vec![json!(7), json!(valid_kind)],
                vec![json!("demo"), json!("../resourcepacks")],
                vec![json!("demo"), json!("Resourcepacks")],
            ] {
                assert!(parse_args(request, &args).is_err());
            }
            for id in ["", "../demo", "/demo", "C:demo", "demo/child", "demo.. ", "NUL", "demo:stream"] {
                assert!(parse_args(request, &[json!(id), json!(valid_kind)]).is_err());
            }
        }
    }

    #[test]
    fn resource_kinds_are_created_in_shared_and_isolated_roots() {
        for isolated in [false, true] {
            let fixture = Fixture::new();
            let current = json!({"gameDirAbs": fixture.0.to_string_lossy(), "versionIsolation": isolated});
            let request = DirectoryRequest::from_channel(RESOURCE_CHANNEL).unwrap();
            let cancel = crate::downloads::Cancel::default();
            verify_current_root(request, &fixture.0, &current).unwrap();
            for kind in RESOURCE_KIND_NAMES {
                let args = [json!("demo"), json!(kind)];
                let (id, kind) = parse_args(request, &args).unwrap();
                let target = ensure_target(request, &fixture.0, id, kind, &current, &cancel).unwrap();
                let expected = if isolated { fixture.0.join("versions/demo").join(kind) } else { fixture.0.join(kind) };
                assert_eq!(target, expected);
                assert!(target.is_dir());
                assert_eq!(ensure_target(request, &fixture.0, id, kind, &current, &cancel).unwrap(), expected);
                let unused = if isolated { fixture.0.join(kind) } else { fixture.0.join("versions/demo").join(kind) };
                assert!(!unused.exists());
            }
        }
    }

    #[test]
    fn resource_root_changes_and_cross_channel_kinds_fail_before_creation() {
        let fixture = Fixture::new();
        let other = Fixture::new();
        let current = json!({"gameDirAbs": other.0.to_string_lossy(), "versionIsolation": true});
        let request = DirectoryRequest::Resources;
        assert!(verify_current_root(request, &fixture.0, &current).is_err());
        let cancel = crate::downloads::Cancel::default();
        for kind in RESOURCE_KIND_NAMES {
            assert!(!fixture.0.join(kind).exists());
            assert!(!fixture.0.join("versions/demo").join(kind).exists());
        }
        assert!(ensure_target(DirectoryRequest::Manage, &fixture.0, "demo", "resourcepacks", &json!({}), &cancel).is_err());
        for kind in ["mods", "saves", "schematics", "version", "run"] {
            assert!(ensure_target(request, &fixture.0, "demo", kind, &json!({}), &cancel).is_err());
        }
        assert!(!fixture.0.join("mods").exists());
        assert!(!fixture.0.join("resourcepacks").exists());
        assert!(ensure_target(request, &fixture.0, "missing", "resourcepacks", &json!({}), &cancel).is_err());
        assert!(!fixture.0.join("versions/missing").exists());
    }

    #[test]
    fn resource_targets_reject_files_and_hardlinks_without_modifying_sources() {
        for isolated in [false, true] {
            for kind in RESOURCE_KIND_NAMES {
                let fixture = Fixture::new();
                let run = if isolated { fixture.0.join("versions/demo") } else { fixture.0.clone() };
                let target = run.join(kind);
                let original = fixture.0.join("source.dat");
                fs::write(&original, b"keep source").unwrap();
                fs::hard_link(&original, &target).unwrap();
                let settings = json!({"versionIsolation": isolated});
                let cancel = crate::downloads::Cancel::default();
                assert!(ensure_target(DirectoryRequest::Resources, &fixture.0, "demo", kind, &settings, &cancel).is_err());
                assert_eq!(fs::read(&original).unwrap(), b"keep source");
                assert_eq!(fs::read(&target).unwrap(), b"keep source");
                fs::remove_file(&target).unwrap();
                fs::write(&target, b"keep target").unwrap();
                assert!(ensure_target(DirectoryRequest::Resources, &fixture.0, "demo", kind, &settings, &cancel).is_err());
                assert_eq!(fs::read(&target).unwrap(), b"keep target");
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn resource_targets_reject_symlinks_in_shared_and_isolated_roots() {
        use std::os::unix::fs::symlink;
        for isolated in [false, true] {
            for kind in RESOURCE_KIND_NAMES {
                let fixture = Fixture::new();
                let outside = fixture.0.join("outside");
                fs::create_dir(&outside).unwrap();
                let run = if isolated { fixture.0.join("versions/demo") } else { fixture.0.clone() };
                let target = run.join(kind);
                symlink(&outside, &target).unwrap();
                let settings = json!({"versionIsolation": isolated});
                assert!(ensure_target(DirectoryRequest::Resources, &fixture.0, "demo", kind, &settings, &crate::downloads::Cancel::default()).is_err());
                assert!(fs::symlink_metadata(&target).unwrap().file_type().is_symlink());
                assert!(fs::read_dir(&outside).unwrap().next().is_none());
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_target_is_rejected_without_following_outside_directory() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let outside = fixture.0.join("outside");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, fixture.0.join("versions/demo/mods")).unwrap();
        let settings = json!({"versionIsolation": true});
        assert!(ensure_target(DirectoryRequest::Manage, &fixture.0, "demo", "mods", &settings, &crate::downloads::Cancel::default()).is_err());
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
    }
}

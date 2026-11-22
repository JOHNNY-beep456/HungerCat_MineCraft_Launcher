//! 主窗口的原生桌面能力。仅由宿主已校验来源的 IPC 分发器调用。
//! 不读取或修改设置文件；耗时文件操作及原生阻塞对话框均在线程池执行。

use serde_json::{json, Value};
use std::{
    cell::RefCell,
    cmp::Ordering,
    collections::BTreeMap,
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use tauri_plugin_opener::OpenerExt;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[path = "desktop_export.rs"]
mod desktop_export;
#[path = "desktop_hardware.rs"]
mod desktop_hardware;
#[path = "picked_directory.rs"]
mod picked_directory;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[path = "desktop_window_modes.rs"]
mod desktop_window_modes;

/// 仅消费原生 saveFile 返回的一次保存能力，不能传入任意磁盘路径。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) async fn export_download(app: &AppHandle, window: &WebviewWindow, args: &[Value], settings: &Value) -> Result<Option<Value>, String> {
    desktop_export::export_download(app, window, args, settings).await
}
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn cancel_download(app: &AppHandle, task_id: Option<&str>) -> Result<(), String> { desktop_export::cancel_download(app, task_id) }
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn init(app: &AppHandle) {
    // 预先登记能力槽，避免已经入场但尚未初始化的旧 IPC 在退出取消后重新创建它。
    app.manage(PickedFiles::default());
    desktop_export::init(app);
}
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn cancel_for_window(app: &AppHandle) {
    desktop_window_modes::cancel_for_window(app);
    desktop_export::cancel_for_window(app);
    if let Some(state) = app.try_state::<PickedFiles>() {
        if let Ok(mut grants) = state.0.lock() { grants.clear(true); }
    }
}
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn relaunch_ready(app: &AppHandle) -> Result<(), String> { desktop_window_modes::relaunch_ready(app)?; desktop_export::relaunch_ready(app) }
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri_plugin_dialog::{DialogExt, FilePath, MessageDialogButtons, MessageDialogKind};

const MAX_TEXT: usize = 2 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000;
static FILE_WRITES: Mutex<()> = Mutex::new(());
thread_local! { static LANGUAGE: RefCell<String> = RefCell::new("zh-CN".into()); }

// 每次调用从 Storage 读取语言。作用域只同步包裹无 await 的工作，避免并发调用互相改写语言。
fn with_language<T>(language: &str, work: impl FnOnce() -> T) -> T {
    struct Restore(String);
    impl Drop for Restore { fn drop(&mut self) { LANGUAGE.with(|value| *value.borrow_mut() = std::mem::take(&mut self.0)); } }
    let _restore = Restore(LANGUAGE.with(|value| value.replace(language.to_owned())));
    work()
}
fn tr(cn: &str, tw: &str, en: &str) -> String {
    LANGUAGE.with(|value| {
        let language = value.borrow();
        if language.as_str() == "en" || language.starts_with("en_") || language.starts_with("en-") { en.into() }
        else if language.as_str() == "zh-TW" || language.starts_with("zh_TW") || language.starts_with("zh-HK") { tw.into() }
        else { cn.into() }
    })
}
fn storage_language<R: Runtime>(app: &AppHandle<R>) -> String {
    app.try_state::<crate::storage::Storage>()
        .and_then(|storage| storage.call("settings:get", &[]).ok().flatten())
        .and_then(|settings| settings.get("language").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_else(|| "zh-CN".into())
}
async fn blocking<T, F>(language: &str, work: F) -> Result<T, String>
where T: Send + 'static, F: FnOnce() -> Result<T, String> + Send + 'static {
    let task_language = language.to_owned();
    tauri::async_runtime::spawn_blocking(move || with_language(&task_language, work)).await
        .map_err(|_| with_language(language, || tr("后台桌面任务异常", "背景桌面工作異常", "The background desktop operation failed")))?
}
fn invalid() -> String { tr("参数无效", "參數無效", "Invalid arguments") }
fn platform_unsupported() -> String {
    tr("当前平台不支持此桌面能力", "目前平台不支援此桌面能力", "This desktop operation is unavailable on this platform")
}

/// 仅供用户主动提交的诊断报告读取；不返回型号、用户名、路径、IP 或设置。
pub(crate) fn diagnostic_system() -> Value {
    let hardware = desktop_hardware::hardware_info().unwrap_or(Value::Null);
    json!({
        "osRelease": os_release().unwrap_or_else(|| std::env::consts::OS.to_owned()),
        "cpuCores": hardware.get("cpuCores").and_then(Value::as_u64).unwrap_or(0),
        "totalMemMb": hardware.get("totalMemMb").and_then(Value::as_u64).unwrap_or(0)
    })
}

#[cfg(windows)]
fn os_release() -> Option<String> {
    #[repr(C)]
    struct VersionInfo { size: u32, major: u32, minor: u32, build: u32, platform: u32, service_pack: [u16; 128] }
    #[link(name = "ntdll")]
    extern "system" { fn RtlGetVersion(info: *mut VersionInfo) -> i32; }
    let mut info = VersionInfo { size: std::mem::size_of::<VersionInfo>() as u32, major: 0, minor: 0, build: 0, platform: 0, service_pack: [0; 128] };
    if unsafe { RtlGetVersion(&mut info) } != 0 || info.major == 0 { return None; }
    Some(format!("{}.{}.{}", info.major, info.minor, info.build))
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn os_release() -> Option<String> {
    let mut bytes = Vec::new();
    std::fs::File::open("/proc/sys/kernel/osrelease").ok()?.take(257).read_to_end(&mut bytes).ok()?;
    if bytes.len() > 256 { return None; }
    let value = std::str::from_utf8(&bytes).ok()?.trim();
    (!value.is_empty() && !value.chars().any(char::is_control)).then(|| value.to_owned())
}

#[cfg(target_os = "macos")]
fn os_release() -> Option<String> {
    use std::{ffi::c_void, os::raw::c_char, ptr};
    extern "C" { fn sysctlbyname(name: *const c_char, old: *mut c_void, old_len: *mut usize, new: *mut c_void, new_len: usize) -> i32; }
    let mut bytes = [0u8; 257]; let mut len = bytes.len();
    if unsafe { sysctlbyname(b"kern.osrelease\0".as_ptr().cast(), bytes.as_mut_ptr().cast(), &mut len, ptr::null_mut(), 0) } != 0 || len == 0 || len > 256 { return None; }
    if bytes[len - 1] == 0 { len -= 1; }
    let value = std::str::from_utf8(&bytes[..len]).ok()?;
    (!value.is_empty() && !value.chars().any(char::is_control)).then(|| value.to_owned())
}

#[cfg(not(any(windows, target_os = "linux", target_os = "android", target_os = "macos")))]
fn os_release() -> Option<String> { None }
fn fs_error(error: io::Error) -> String {
    match error.kind() {
        io::ErrorKind::NotFound => tr("路径不存在或已被移动", "路徑不存在或已移動", "The path does not exist or was moved"),
        io::ErrorKind::PermissionDenied => tr("没有权限访问此位置", "沒有權限存取此位置", "Permission to access this location was denied"),
        io::ErrorKind::AlreadyExists => tr("同级下已存在同名项目", "同層已有同名項目", "An item with that name already exists"),
        _ => tr("文件操作失败，请检查权限或文件占用", "檔案操作失敗，請檢查權限或檔案占用", "File operation failed; check permissions and whether the file is in use"),
    }
}
fn arg_string(args: &[Value], index: usize) -> Result<String, String> {
    args.get(index).and_then(Value::as_str).map(str::to_owned).ok_or_else(invalid)
}
fn path_text(path: &Path) -> Result<String, String> {
    path.to_str().map(str::to_owned).ok_or_else(|| tr("此路径不是有效的 UTF-8，无法安全显示", "此路徑不是有效 UTF-8，無法安全顯示", "This path is not valid UTF-8 and cannot be displayed safely"))
}
fn too_large() -> String {
    tr("文件超过 2 MiB，无法用内置编辑器打开或保存", "檔案超過 2 MiB，無法以內建編輯器開啟或儲存", "Files larger than 2 MiB cannot be opened or saved in the built-in editor")
}
fn binary_error() -> String {
    tr("此文件不是有效 UTF-8 文本或包含二进制内容", "此檔案不是有效 UTF-8 文字或包含二進位內容", "This file is not valid UTF-8 text or contains binary data")
}
fn link_error() -> String {
    tr("此操作不接受符号链接或重解析路径，请选择实际位置", "此操作不接受符號連結或重新解析路徑，請選取實際位置", "Symbolic links and reparse paths are not accepted; choose the actual location")
}
fn root_error() -> String {
    tr("不能修改或删除驱动器根目录或系统位置", "無法修改或刪除磁碟根目錄或系統位置", "Drive roots and system locations cannot be modified or removed")
}
fn is_link(meta: &Metadata) -> bool {
    if meta.file_type().is_symlink() { return true; }
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 { return true; }
    }
    false
}
fn is_root(path: &Path) -> bool { path.parent().is_none() || path.file_name().is_none() }

// 相对路径固定在启动器目录解析，避免便携/开发启动时 cwd 改变造成文件错位。
fn absolute_path(raw: &str) -> Result<PathBuf, String> {
    if raw != raw.trim() || raw.is_empty() || raw.len() > 32768 || raw.chars().any(char::is_control) { return Err(invalid()); }
    #[cfg(windows)]
    if raw.starts_with("\\\\?\\") || raw.starts_with("\\\\.\\") || raw.contains(':') && !(raw.as_bytes().get(1) == Some(&b':') && !raw[2..].contains(':')) {
        return Err(invalid());
    }
    let mut path = PathBuf::from(raw);
    #[cfg(windows)] {
        if raw.len() == 2 && raw.as_bytes()[0].is_ascii_alphabetic() && raw.as_bytes()[1] == b':' { path.push("\\"); }
        if path.has_root() && !path.is_absolute() || path.components().any(|c| matches!(c, Component::Prefix(_))) && !path.has_root() { return Err(invalid()); }
        // Windows 会折叠尾随点/空格与设备名；先拒绝这些别名，避免预检和实际目标不一致。
        for component in path.components() {
            if let Component::Normal(name) = component { valid_name(name.to_str().ok_or_else(invalid)?)?; }
        }
    }
    // 不在校验前折叠 ParentDir，防止 link/../file 掩盖需要拒绝的链接。
    if path.components().any(|c| matches!(c, Component::ParentDir)) { return Err(invalid()); }
    if !path.is_absolute() {
        let base = std::env::var_os("PORTABLE_EXECUTABLE_DIR").map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)))
            .ok_or_else(invalid)?;
        path = base.join(path);
    }
    let mut normal = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {},
            Component::ParentDir => { if !normal.pop() { return Err(invalid()); } },
            _ => normal.push(component.as_os_str()),
        }
    }
    if !normal.is_absolute() { return Err(invalid()); }
    Ok(normal)
}
fn reject_link_ancestors(path: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if matches!(component, Component::Prefix(_)) { continue; }
        match fs::symlink_metadata(&current) {
            Ok(meta) if is_link(&meta) => return Err(link_error()),
            Ok(_) => {},
            Err(error) => return Err(fs_error(error)),
        }
    }
    Ok(())
}
fn existing(raw: &str) -> Result<PathBuf, String> {
    let path = absolute_path(raw)?;
    reject_link_ancestors(&path)?;
    Ok(path)
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct FileStamp {
    size: u64,
    modified: SystemTime,
    identity: (u64, u64),
}
#[cfg(windows)]
fn file_identity(file: &File, _: &Metadata) -> Result<(u64, u64), String> {
    use std::{ffi::c_void, os::windows::io::AsRawHandle};
    #[repr(C)] struct FileInformation {
        attributes: u32, created: [u32; 2], accessed: [u32; 2], modified: [u32; 2],
        volume: u32, size_high: u32, size_low: u32, links: u32, index_high: u32, index_low: u32,
    }
    #[link(name = "kernel32")] extern "system" {
        fn GetFileInformationByHandle(handle: *mut c_void, information: *mut FileInformation) -> i32;
    }
    let mut information: FileInformation = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 { return Err(fs_error(io::Error::last_os_error())); }
    Ok((information.volume as u64, (information.index_high as u64) << 32 | information.index_low as u64))
}
#[cfg(unix)]
fn file_identity(_: &File, metadata: &Metadata) -> Result<(u64, u64), String> {
    use std::os::unix::fs::MetadataExt;
    Ok((metadata.dev(), metadata.ino()))
}
#[cfg(not(any(windows, unix)))]
fn file_identity(_: &File, _: &Metadata) -> Result<(u64, u64), String> { Err(platform_unsupported()) }
fn file_stamp(file: &File) -> Result<FileStamp, String> {
    let metadata = file.metadata().map_err(fs_error)?;
    if !metadata.is_file() || is_link(&metadata) { return Err(link_error()); }
    Ok(FileStamp { size: metadata.len(), modified: metadata.modified().map_err(fs_error)?, identity: file_identity(file, &metadata)? })
}
fn picked_snapshot(path: &Path) -> Result<(PathBuf, FileStamp), String> {
    if !path.is_absolute() { return Err(pick_required()); }
    let path = picker_path(path.to_path_buf())?;
    let path = existing(&path_text(&path)?)?;
    if !fs::symlink_metadata(&path).map_err(fs_error)?.is_file() { return Err(pick_required()); }
    let canonical = fs::canonicalize(&path).map_err(fs_error)?;
    let file = File::open(&path).map_err(fs_error)?;
    let stamp = file_stamp(&file)?;
    reject_link_ancestors(&path)?;
    let check = File::open(&path).map_err(fs_error)?;
    if fs::canonicalize(&path).map_err(fs_error)? != canonical || file_stamp(&check)? != stamp { return Err(pick_required()); }
    Ok((canonical, stamp))
}
fn pick_required() -> String {
    tr("请使用文件选择器重新选择这个文件；仅文件名相同不能授予访问权限", "請使用檔案選擇器重新選取此檔案；只有檔名相同不能授予存取權限", "Select this file again using the file picker; a matching filename does not grant access")
}
#[derive(Default)]
struct PickedState { generation: u64, destroyed: bool, files: BTreeMap<PathBuf, FileStamp>, directories: BTreeMap<PathBuf, picked_directory::Grant> }
impl PickedState {
    fn clear(&mut self, destroyed: bool) { self.generation = self.generation.wrapping_add(1); self.destroyed |= destroyed; self.files.clear(); self.directories.clear(); }
    fn register(&mut self, generation: u64, files: Vec<(PathBuf, FileStamp)>) -> Result<(), String> {
        if self.destroyed || generation != self.generation || self.files.len().saturating_add(self.directories.len()).saturating_add(files.len()) > 4096 { return Err(pick_required()); }
        self.files.extend(files); Ok(())
    }
    fn require(&self, path: &Path, stamp: &FileStamp) -> Result<(), String> {
        if !self.destroyed && self.files.get(path) == Some(stamp) { Ok(()) } else { Err(pick_required()) }
    }
    fn register_directory(&mut self, generation: u64, path: PathBuf, grant: picked_directory::Grant) -> Result<(), String> {
        if self.destroyed || generation != self.generation || self.files.len().saturating_add(self.directories.len()) >= 4096 { return Err(pick_required()); }
        grant.verify().map_err(|_| directory_pick_required())?;
        self.directories.insert(path, grant); Ok(())
    }
    fn require_directory(&self, path: &Path) -> Result<(), String> {
        if self.destroyed { return Err(directory_pick_required()); }
        self.directories.get(path).ok_or_else(directory_pick_required)?.verify().map_err(|_| directory_pick_required())
    }
}
#[derive(Clone, Default)]
struct PickedFiles(Arc<Mutex<PickedState>>);
struct PickTicket { state: PickedFiles, generation: u64 }
impl PickTicket {
    fn check(&self) -> Result<(), String> {
        let state = self.state.0.lock().map_err(|_| pick_required())?;
        if state.destroyed || state.generation != self.generation { Err(pick_required()) } else { Ok(()) }
    }
    fn register(&self, files: Vec<(PathBuf, FileStamp)>) -> Result<(), String> {
        self.state.0.lock().map_err(|_| pick_required())?.register(self.generation, files)
    }
    fn register_directory(&self, path: &Path) -> Result<(), String> {
        let (path, grant) = picked_directory::Grant::capture(path).map_err(|_| directory_pick_required())?;
        self.state.0.lock().map_err(|_| directory_pick_required())?.register_directory(self.generation, path, grant)
    }
}
fn picked_files<R: Runtime>(app: &AppHandle<R>) -> Result<PickedFiles, String> {
    // 只绑定唯一的主窗口；实际退出由统一后台清理作废授权。
    app.try_state::<PickedFiles>().map(|state| state.inner().clone()).ok_or_else(pick_required)
}
/// 仅供 Rust 本地导入宿主调用：验证当前主窗口通过 pickFile(s) 选择的同一普通文件。
/// 不接受文件名匹配、目录选择、保存路径或 Android content URI。调用方应在后台验证后立即使用文件。
pub fn require_picked_file<R: Runtime>(app: &AppHandle<R>, path: &Path) -> Result<(), String> {
    let language = storage_language(app);
    with_language(&language, || {
        #[cfg(target_os = "android")]
        { return crate::mobile_files::require_imported_file(app, path); }
        #[cfg(target_os = "ios")]
        { let _ = path; return Err(platform_unsupported()); }
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            let state = app.try_state::<PickedFiles>().ok_or_else(pick_required)?;
            let (canonical, stamp) = picked_snapshot(path)?;
            let result = state.inner().0.lock().map_err(|_| pick_required())?.require(&canonical, &stamp);
            result
        }
    })
}
fn directory_pick_required() -> String {
    tr("请用目录选择器重新选择实际来源目录", "請用目錄選擇器重新選取實際來源目錄", "Select the actual source directory again using the directory picker")
}
/// 只验证当前窗口真实选择的同一目录与祖先身份；不接受文件权限或移动端 URI。
pub(crate) fn require_picked_directory<R: Runtime>(app: &AppHandle<R>, path: &Path) -> Result<(), String> {
    let language = storage_language(app);
    with_language(&language, || {
        #[cfg(any(target_os = "android", target_os = "ios"))]
        { let _ = path; Err(platform_unsupported()) }
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            let path = picker_path(path.to_path_buf())?;
            let state = app.try_state::<PickedFiles>().ok_or_else(directory_pick_required)?;
            let result = state.inner().0.lock().map_err(|_| directory_pick_required())?.require_directory(&path);
            result
        }
    })
}
fn valid_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if raw.ends_with('.') || raw.ends_with(' ') || name.is_empty() || name == "." || name == ".." || name.len() > 255 || name.ends_with('.') || name.ends_with(' ')
        || name.chars().any(|c| c.is_control() || "\\/<>:\"|?*".contains(c)) { return Err(invalid()); }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && matches!(stem.as_bytes()[3], b'1'..=b'9')) { return Err(invalid()); }
    Ok(name.into())
}
fn mtime(meta: &Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis().min(u64::MAX as u128) as u64).unwrap_or(0)
}
fn natural_cmp(left: &str, right: &str) -> Ordering {
    let a = left.to_lowercase(); let b = right.to_lowercase();
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        if a[i].is_ascii_digit() && b[j].is_ascii_digit() {
            let (start_a, start_b) = (i, j);
            while i < a.len() && a[i].is_ascii_digit() { i += 1; }
            while j < b.len() && b[j].is_ascii_digit() { j += 1; }
            let mut aa = &a[start_a..i]; let mut bb = &b[start_b..j];
            while aa.len() > 1 && aa[0] == b'0' { aa = &aa[1..]; }
            while bb.len() > 1 && bb[0] == b'0' { bb = &bb[1..]; }
            let order = aa.len().cmp(&bb.len()).then_with(|| aa.cmp(bb));
            if order != Ordering::Equal { return order; }
        } else {
            let order = a[i].cmp(&b[j]); if order != Ordering::Equal { return order; }
            i += 1; j += 1;
        }
    }
    a.len().cmp(&b.len()).then_with(|| left.cmp(right))
}
fn list_dir(raw: &str) -> Result<Value, String> {
    let dir = existing(raw)?;
    if !fs::metadata(&dir).map_err(fs_error)?.is_dir() { return Err(tr("这不是一个目录", "這不是目錄", "The path is not a directory")); }
    let mut entries = Vec::new();
    for entry in fs::read_dir(&dir).map_err(fs_error)? {
        let entry = entry.map_err(fs_error)?;
        if entries.len() >= MAX_ENTRIES { return Err(tr("目录项目过多，请选择更具体的目录", "目錄項目過多，請選取更具體的目錄", "The directory contains too many items; choose a more specific directory")); }
        let path = entry.path();
        let meta = match fs::symlink_metadata(&path) { Ok(m) => m, Err(_) => continue };
        // 不沿目录内链接遍历；链接本身仍列出，后续操作会给出明确错误。
        let name = match entry.file_name().into_string() { Ok(n) => n, Err(_) => continue };
        entries.push(json!({"name":name,"path":path_text(&path)?,"isDir":meta.is_dir() && !is_link(&meta),"size":if meta.is_file() { meta.len() } else { 0 },"mtime":mtime(&meta)}));
    }
    entries.sort_by(|a,b| b["isDir"].as_bool().cmp(&a["isDir"].as_bool()).then_with(|| natural_cmp(a["name"].as_str().unwrap_or(""), b["name"].as_str().unwrap_or(""))));
    Ok(Value::Array(entries))
}
fn read_text(raw: &str) -> Result<Value, String> {
    let path = existing(raw)?;
    // 打开前先拒绝设备/FIFO，避免打开非普通文件时阻塞工作线程。
    if !fs::symlink_metadata(&path).map_err(fs_error)?.is_file() { return Err(binary_error()); }
    let file = File::open(&path).map_err(fs_error)?;
    let meta = file.metadata().map_err(fs_error)?;
    if !meta.is_file() { return Err(binary_error()); }
    if meta.len() > MAX_TEXT as u64 { return Err(too_large()); }
    let mut bytes = Vec::new();
    file.take(MAX_TEXT as u64 + 1).read_to_end(&mut bytes).map_err(fs_error)?;
    if bytes.len() > MAX_TEXT { return Err(too_large()); }
    if bytes.contains(&0) { return Err(binary_error()); }
    let content = String::from_utf8(bytes).map_err(|_| binary_error())?;
    Ok(json!({"size":content.len(),"content":content,"mtime":mtime(&meta)}))
}
fn file_action(channel: &str, args: &[Value]) -> Result<Value, String> {
    let raw = arg_string(args, 0)?;
    if channel == "files:list" { return list_dir(&raw); }
    if channel == "files:readText" { return read_text(&raw); }
    let _guard = FILE_WRITES.lock().map_err(|_| tr("文件操作正在恢复，请重启后再试", "檔案操作正在復原，請重新啟動後再試", "File operations are recovering; restart and try again"))?;
    let path = existing(&raw)?;
    match channel {
        "files:rename" => {
            if is_root(&path) { return Err(root_error()); }
            let new_path = path.parent().ok_or_else(root_error)?.join(valid_name(&arg_string(args, 1)?)?);
            if new_path == path { return Ok(Value::String(path_text(&path)?)); }
            match fs::symlink_metadata(&new_path) {
                Ok(_) => return Err(tr("同级下已存在同名项目", "同層已有同名項目", "An item with that name already exists")),
                Err(e) if e.kind() == io::ErrorKind::NotFound => {},
                Err(e) => return Err(fs_error(e)),
            }
            // 同级原子不覆盖；进程外并发创建目标时也不会被重命名覆盖。
            rename_without_replace(&path, &new_path)?;
            Ok(Value::String(path_text(&new_path)?))
        },
        "files:createFile" => {
            if !fs::metadata(&path).map_err(fs_error)?.is_dir() { return Err(invalid()); }
            let destination = path.join(valid_name(&arg_string(args, 1)?)?);
            OpenOptions::new().write(true).create_new(true).open(&destination).map_err(fs_error)?.sync_all().map_err(fs_error)?;
            Ok(Value::String(path_text(&destination)?))
        },
        "files:writeText" => {
            let content = arg_string(args, 1)?;
            if content.len() > MAX_TEXT { return Err(too_large()); }
            if content.contains('\0') { return Err(binary_error()); }
            // 编辑器只覆盖已经存在、可作为 UTF-8 文本读取的普通文件，不通过写接口绕过预检。
            read_text(&raw)?;
            reject_link_ancestors(&path)?;
            write_text_atomic(&path, &content)?;
            Ok(Value::Null)
        },
        _ => Err(invalid()),
    }
}

// 临时文件与目标同级；失败由 RAII 删除临时文件，原文件在成功替换前保持不变。
struct PendingWrite { path: PathBuf, committed: bool }
impl Drop for PendingWrite {
    fn drop(&mut self) { if !self.committed { let _ = fs::remove_file(&self.path); } }
}
fn write_text_atomic(path: &Path, content: &str) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
    static NEXT_WRITE: AtomicU64 = AtomicU64::new(0);
    let before = fs::metadata(path).map_err(fs_error)?;
    if !before.is_file() { return Err(binary_error()); }
    let parent = path.parent().ok_or_else(invalid)?;
    let mut staged = None;
    for _ in 0..32 {
        let name = format!(".hcmcl-edit-{}-{}.tmp", std::process::id(), NEXT_WRITE.fetch_add(1, AtomicOrdering::Relaxed));
        let temp = parent.join(name);
        let mut options = OpenOptions::new(); options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        match options.open(&temp) {
            Ok(file) => { staged = Some((PendingWrite { path:temp, committed:false }, file)); break; },
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(fs_error(e)),
        }
    }
    let (mut temp, mut file) = staged.ok_or_else(invalid)?;
    file.write_all(content.as_bytes()).map_err(fs_error)?;
    // 尽量保持原文件权限；Windows ReplaceFileW 另会保留原目标安全描述符。
    file.set_permissions(before.permissions()).map_err(fs_error)?;
    file.sync_all().map_err(fs_error)?;
    drop(file);
    reject_link_ancestors(path)?;
    let after = fs::metadata(path).map_err(fs_error)?;
    if !after.is_file() || before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        return Err(tr("文件已被其他程序修改，请重新打开后保存", "檔案已被其他程式修改，請重新開啟後儲存", "The file was modified by another program; reopen it before saving"));
    }
    reject_link_ancestors(&temp.path)?;
    let staged_meta = fs::symlink_metadata(&temp.path).map_err(fs_error)?;
    if !staged_meta.is_file() || staged_meta.len() != content.len() as u64 { return Err(binary_error()); }
    replace_file(&temp.path, path)?;
    temp.committed = true;
    Ok(())
}
#[cfg(windows)]
fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    use std::{os::windows::ffi::OsStrExt, ptr};
    #[link(name = "kernel32")]
    extern "system" { fn ReplaceFileW(replaced: *const u16, replacement: *const u16, backup: *const u16, flags: u32, exclude: *mut std::ffi::c_void, reserved: *mut std::ffi::c_void) -> i32; }
    let from = from.as_os_str().encode_wide().chain(std::iter::once(0)).collect::<Vec<_>>();
    let to = to.as_os_str().encode_wide().chain(std::iter::once(0)).collect::<Vec<_>>();
    if unsafe { ReplaceFileW(to.as_ptr(), from.as_ptr(), ptr::null(), 0, ptr::null_mut(), ptr::null_mut()) } == 0 { return Err(fs_error(io::Error::last_os_error())); }
    Ok(())
}
#[cfg(not(windows))]
fn replace_file(from: &Path, to: &Path) -> Result<(), String> { fs::rename(from, to).map_err(fs_error) }

#[cfg(windows)]
fn rename_without_replace(from: &Path, to: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" { fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32; }
    let from = from.as_os_str().encode_wide().chain(std::iter::once(0)).collect::<Vec<_>>();
    let to = to.as_os_str().encode_wide().chain(std::iter::once(0)).collect::<Vec<_>>();
    // 不指定 MOVEFILE_REPLACE_EXISTING，系统原子拒绝覆盖。
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } == 0 { return Err(fs_error(io::Error::last_os_error())); }
    Ok(())
}
#[cfg(target_os = "linux")]
fn rename_without_replace(from: &Path, to: &Path) -> Result<(), String> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    extern "C" { fn renameat2(olddir: i32, old: *const std::os::raw::c_char, newdir: i32, new: *const std::os::raw::c_char, flags: u32) -> i32; }
    let from = CString::new(from.as_os_str().as_bytes()).map_err(|_| invalid())?;
    let to = CString::new(to.as_os_str().as_bytes()).map_err(|_| invalid())?;
    // AT_FDCWD=-100，RENAME_NOREPLACE=1。旧内核/文件系统不支持时明确失败。
    if unsafe { renameat2(-100, from.as_ptr(), -100, to.as_ptr(), 1) } != 0 { return Err(fs_error(io::Error::last_os_error())); }
    Ok(())
}
#[cfg(target_os = "macos")]
fn rename_without_replace(from: &Path, to: &Path) -> Result<(), String> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    extern "C" { fn renamex_np(from: *const std::os::raw::c_char, to: *const std::os::raw::c_char, flags: u32) -> i32; }
    let from = CString::new(from.as_os_str().as_bytes()).map_err(|_| invalid())?;
    let to = CString::new(to.as_os_str().as_bytes()).map_err(|_| invalid())?;
    // RENAME_EXCL=0x4，保留系统对目标存在的原子判断。
    if unsafe { renamex_np(from.as_ptr(), to.as_ptr(), 0x4) } != 0 { return Err(fs_error(io::Error::last_os_error())); }
    Ok(())
}
#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn rename_without_replace(_: &Path, _: &Path) -> Result<(), String> { Err(platform_unsupported()) }

fn validate_arguments(channel: &str, args: &[Value]) -> Result<(), String> {
    let valid = match channel {
        "shell:pickFile" | "shell:pickFiles" => args.len() <= 1,
        "files:writeText" | "files:rename" | "files:createFile" => args.len() == 2,
        "window:setFullscreen" | "window:setAlwaysOnTop" | "window:setDesktopMode" | "window:securityFullscreen" => args.len() == 1 && args[0].is_boolean(),
        "shell:openExternal" | "shell:openPath" | "shell:saveFile" | "files:list" | "files:readText" | "files:remove" | "files:reveal" | "files:open" => args.len() == 1 && args[0].is_string(),
        _ => args.is_empty(),
    };
    if valid { Ok(()) } else { Err(invalid()) }
}
// 共享纯门禁让离线测试覆盖 Android/iOS 的拒绝路径；必须在原生窗口调用前执行。
fn validate_platform(channel: &str, mobile: bool) -> Result<(), String> {
    if mobile && !matches!(channel, "shell:openExternal" | "system:memory" | "system:hardware") { Err(platform_unsupported()) } else { Ok(()) }
}
pub(crate) fn is_native_window_channel(channel: &str) -> bool {
    matches!(channel,
        "window:minimize" | "window:maximize" | "window:close" | "window:isMaximized" | "window:setFullscreen" | "window:setAlwaysOnTop" |
        "window:setDesktopMode" | "window:securityFullscreen" | "display:primary")
}

fn shell_language<R: Runtime>(app: &AppHandle<R>) -> String {
    app.try_state::<crate::storage::Storage>()
        .and_then(|storage| storage.try_shell_language())
        .unwrap_or_else(|| "zh-CN".into())
}

#[cfg(desktop)]
pub(crate) async fn start_titlebar_drag(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    desktop_window_modes::start_titlebar_drag(app, window, &shell_language(app)).await
}

fn known_channel(channel: &str) -> bool {
    is_native_window_channel(channel) || matches!(channel,
        "system:memory" | "system:hardware" | "shell:openExternal" | "shell:openPath" | "shell:chooseDirectory" | "shell:pickFile" | "shell:pickFiles" | "shell:saveFile" |
        "files:list" | "files:readText" | "files:writeText" | "files:rename" | "files:createFile" | "files:remove" | "files:reveal" | "files:open" | "files:places" | "java:pick")
}
/// 返回 None 表示频道不属于本模块；支持频道失败时返回脱敏错误。
/// 宿主必须同时限制 main label、源 URL 和自定义主页的 IPC 能力。
pub async fn call<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>, channel: &str, args: &[Value]) -> Result<Option<Value>, String> {
    if !known_channel(channel) { return Ok(None); }
    let language = if is_native_window_channel(channel) { shell_language(app) } else { storage_language(app) };
    with_language(&language, || {
        if window.label() != "main" { return Err(tr("此接口仅允许主窗口调用", "此介面僅允許主視窗呼叫", "This operation is only available to the main window")); }
        validate_arguments(channel, args)?;
        // Android 下一步需单独实现 SAF 文档授权/读取桥；content:// 不能转成普通 Path 假装支持。
        validate_platform(channel, cfg!(any(target_os = "android", target_os = "ios")))?;
        Ok(())
    })?;

    match channel {
        "shell:openExternal" => {
            let raw = with_language(&language, || {
                let raw = arg_string(args, 0)?;
                let url = tauri::Url::parse(&raw).map_err(|_| invalid())?;
                if raw.len() > 8192 || raw.chars().any(char::is_control) || !matches!(url.scheme(), "http" | "https" | "mailto") || !url.username().is_empty() || url.password().is_some()
                    || (matches!(url.scheme(), "http" | "https") && url.host_str().is_none()) { return Err(invalid()); }
                Ok(raw)
            })?;
            let handle = app.clone();
            blocking(&language, move || handle.opener().open_url(raw, None::<&str>).map_err(|_| tr("无法用系统浏览器打开链接", "無法以系統瀏覽器開啟連結", "Unable to open the link using the system browser"))).await?;
            Ok(Some(Value::Null))
        },
        "system:memory" => Ok(Some(blocking(&language, memory_info).await?)),
        "system:hardware" => Ok(Some(blocking(&language, desktop_hardware::hardware_info).await?)),
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        _ => desktop_call(app, window, channel, args, &language).await,
        #[cfg(any(target_os = "android", target_os = "ios"))]
        _ => Err(platform_unsupported()),
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn window_call<R: Runtime>(window: &WebviewWindow<R>, channel: &str, _args: &[Value]) -> Result<Option<Value>, String> {
    let value = match channel {
        "display:primary" => {
            let monitor = window.primary_monitor().map_err(|_| platform_unsupported())?.ok_or_else(platform_unsupported)?;
            let scale = monitor.scale_factor();
            if !scale.is_finite() || scale <= 0.0 { return Err(platform_unsupported()); }
            let area = monitor.work_area();
            json!({"width":(monitor.size().width as f64/scale).round(),"height":(monitor.size().height as f64/scale).round(),"workWidth":(area.size.width as f64/scale).round(),"workHeight":(area.size.height as f64/scale).round(),"scaleFactor":scale})
        },
        _ => return Ok(None),
    };
    Ok(Some(value))
}
#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn desktop_call<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>, channel: &str, args: &[Value], language: &str) -> Result<Option<Value>, String> {
    if channel.starts_with("window:") {
        return desktop_window_modes::call(app, window, channel, args, language).await;
    }
    if channel == "display:primary" {
        return with_language(language, || window_call(window, channel, args));
    }
    match channel {
        "shell:saveFile" => Ok(Some(desktop_export::save_capability(app, window, &arg_string(args, 0)?).await?)),
        "shell:chooseDirectory" | "shell:pickFile" | "shell:pickFiles" | "java:pick" => {
            let ticket = with_language(language, || {
                let state = picked_files(app)?;
                let generation = state.0.lock().map_err(|_| pick_required())?.generation;
                Ok::<_, String>(PickTicket { state, generation })
            })?;
            let handle = app.clone(); let owner = window.clone(); let channel = channel.to_owned(); let args = args.to_vec();
            Ok(Some(blocking(language, move || pick(&handle, &owner, &channel, &args, &ticket)).await?))
        },
        "shell:openPath" | "files:open" | "files:reveal" => {
            let raw = with_language(language, || arg_string(args, 0))?; let handle = app.clone(); let reveal = channel == "files:reveal";
            Ok(Some(blocking(language, move || {
                let path = existing(&raw)?;
                if reveal { handle.opener().reveal_item_in_dir(&path).map_err(|_| tr("无法在系统文件管理器定位项目", "無法在系統檔案管理員定位項目", "Unable to reveal the item in the system file manager"))?; Ok(Value::Null) }
                else { handle.opener().open_path(path_text(&path)?, None::<&str>).map(|_| Value::String(String::new())).map_err(|_| tr("无法用系统默认程序打开项目", "無法以系統預設程式開啟項目", "Unable to open the item using the system default application")) }
            }).await?))
        },
        "files:places" => {
            let handle = app.clone();
            Ok(Some(blocking(language, move || {
                let home = handle.path().home_dir().map_err(|_| platform_unsupported())?;
                let downloads = handle.path().download_dir().ok();
                let data = handle.path().app_data_dir().map_err(|_| platform_unsupported())?;
                let game_dirs = handle.try_state::<crate::storage::Storage>()
                    .ok_or_else(|| tr("启动器存储尚未就绪", "啟動器儲存尚未就緒", "Launcher storage is not ready"))?
                    .call("versionDirs:list", &[]).map_err(|_| tr("无法读取版本目录设置", "無法讀取版本目錄設定", "Unable to read configured game directories"))?
                    .ok_or_else(invalid)?;
                places(home, downloads, data, &game_dirs)
            }).await?))
        },
        "files:remove" => {
            let raw = with_language(language, || arg_string(args, 0))?; let handle = app.clone(); let owner = window.clone();
            let protected = [app.path().home_dir().ok(), app.path().app_data_dir().ok(), app.path().app_config_dir().ok(), app.path().desktop_dir().ok(), app.path().document_dir().ok(), app.path().download_dir().ok()].into_iter().flatten().collect::<Vec<_>>();
            Ok(Some(blocking(language, move || remove(&handle, &owner, &raw, &protected)).await?))
        },
        "files:list" | "files:readText" | "files:writeText" | "files:rename" | "files:createFile" => {
            let channel = channel.to_owned(); let args = args.to_vec();
            Ok(Some(blocking(language, move || file_action(&channel, &args)).await?))
        },
        _ => Ok(None),
    }
}

// 原生 Windows picker / canonicalize 可能返回 \\?\ 前缀；只接受等价普通盘符/UNC 路径，拒设备和 URI。
fn picker_path(path: PathBuf) -> Result<PathBuf, String> {
    #[cfg(windows)]
    let path = {
        let text = path_text(&path)?;
        if let Some(unc) = text.strip_prefix("\\\\?\\UNC\\") { PathBuf::from(format!("\\\\{unc}")) }
        else if let Some(disk) = text.strip_prefix("\\\\?\\") {
            if disk.as_bytes().get(1) != Some(&b':') || !disk.as_bytes().first().map_or(false, u8::is_ascii_alphabetic) { return Err(invalid()); }
            PathBuf::from(disk)
        } else { path }
    };
    if !path.is_absolute() { return Err(platform_unsupported()); }
    absolute_path(&path_text(&path)?)
}
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn selected_path(file: FilePath, allow_new: bool) -> Result<Value, String> {
    let path = picker_path(file.into_path().map_err(|_| platform_unsupported())?)?;
    if allow_new && !path.exists() {
        reject_link_ancestors(path.parent().ok_or_else(invalid)?)?;
        valid_name(path.file_name().and_then(|n| n.to_str()).ok_or_else(invalid)?)?;
    } else { reject_link_ancestors(&path)?; }
    Ok(Value::String(path_text(&path)?))
}
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn pick<R: Runtime>(app: &AppHandle<R>, owner: &WebviewWindow<R>, channel: &str, args: &[Value], ticket: &PickTicket) -> Result<Value, String> {
    ticket.check()?;
    let mut dialog = app.dialog().file().set_parent(owner);
    if channel == "java:pick" {
        dialog = dialog.set_title(tr("选择 Java 可执行文件", "選擇 Java 執行檔", "Choose a Java executable"));
        #[cfg(windows)] { dialog = dialog.add_filter(tr("Java 可执行文件", "Java 執行檔", "Java executable"), &["exe"]); }
        #[cfg(not(windows))] { dialog = dialog.add_filter(tr("所有文件", "所有檔案", "All files"), &["*"]); }
        let Some(selected) = dialog.blocking_pick_file() else { ticket.check()?; return Ok(Value::Null); };
        let selected = selected_path(selected, false)?;
        let path = PathBuf::from(selected.as_str().ok_or_else(invalid)?);
        let before = picked_snapshot(&path)?;
        ticket.check()?;
        let runtime = crate::runtime::inspect_picked_java(&path).ok_or_else(|| tr("无法识别该文件，请选择 java.exe（Windows）或 bin/java（macOS / Linux）", "無法辨識此檔案，請選取 java.exe（Windows）或 bin/java（macOS / Linux）", "Unable to recognize this file; choose java.exe on Windows or bin/java on macOS / Linux"))?;
        if picked_snapshot(&path)? != before { return Err(pick_required()); }
        ticket.check()?;
        return Ok(runtime);
    }
    if matches!(channel, "shell:pickFile" | "shell:pickFiles") {
        if let Some(filters) = args.first().filter(|v| !v.is_null()) {
            let filters = filters.as_array().ok_or_else(invalid)?;
            if filters.len() > 32 { return Err(invalid()); }
            for filter in filters {
                let name = filter.get("name").and_then(Value::as_str).filter(|n| n.len() <= 120).ok_or_else(invalid)?;
                let extensions = filter.get("extensions").and_then(Value::as_array).ok_or_else(invalid)?;
                if extensions.is_empty() || extensions.len() > 32 { return Err(invalid()); }
                let mut values = Vec::new();
                for extension in extensions {
                    let ext = extension.as_str().ok_or_else(invalid)?;
                    if ext.len() > 32 || ext.is_empty() || !(ext == "*" || ext.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')) { return Err(invalid()); }
                    values.push(ext);
                }
                dialog = dialog.add_filter(name, &values);
            }
        }
    }
    if channel == "shell:pickFiles" {
        let picked = dialog.blocking_pick_files().unwrap_or_default();
        if picked.len() > 4096 { return Err(invalid()); }
        let values = picked.into_iter().map(|p| selected_path(p, false)).collect::<Result<Vec<_>, _>>()?;
        let files = values.iter().map(|value| picked_snapshot(Path::new(value.as_str().ok_or_else(invalid)?))).collect::<Result<Vec<_>, _>>()?;
        ticket.register(files)?;
        return Ok(Value::Array(values));
    }
    let picked = if channel == "shell:chooseDirectory" { dialog.blocking_pick_folder() } else { dialog.blocking_pick_file() };
    let value = picked.map(|p| selected_path(p, false)).transpose()?.unwrap_or(Value::Null);
    if channel == "shell:pickFile" {
        let files = match value.as_str() { Some(path) => vec![picked_snapshot(Path::new(path))?], None => Vec::new() };
        ticket.register(files)?;
    } else if channel == "shell:chooseDirectory" {
        if let Some(path) = value.as_str() { ticket.register_directory(Path::new(path))?; }
        else { ticket.check()?; }
    } else { ticket.check()?; }
    Ok(value)
}

fn game_places(game_dirs: &Value) -> Result<Vec<Value>, String> {
    let directories = game_dirs.as_array().ok_or_else(invalid)?;
    if directories.len() > 257 { return Err(invalid()); }
    let mut values = Vec::new(); let mut seen = std::collections::BTreeSet::new();
    for directory in directories {
        let raw = directory.get("path").and_then(Value::as_str).ok_or_else(invalid)?;
        let requested = Path::new(raw);
        if !requested.is_absolute() { return Err(invalid()); }
        // 只显示确实存在且可解析的目录；不创建默认目录，也不将 Storage 路径登记成导入授权。
        let Ok(path) = existing(raw) else { continue; };
        if !fs::metadata(&path).map(|value| value.is_dir()).unwrap_or(false) { continue; }
        let Ok(canonical) = fs::canonicalize(&path) else { continue; };
        if !seen.insert(canonical) { continue; }
        let alias = directory.get("alias").and_then(Value::as_str).unwrap_or("").trim();
        let name = if directory.get("isDefault").and_then(Value::as_bool) == Some(true) {
            tr("默认", "預設", "Default")
        } else if !alias.is_empty() { alias.to_owned() }
        else { path.file_name().and_then(|name| name.to_str()).unwrap_or(raw).to_owned() };
        values.push(json!({"name":name,"path":path_text(&path)?,"kind":"place"}));
    }
    Ok(values)
}
fn places(home: PathBuf, downloads: Option<PathBuf>, data: PathBuf, game_dirs: &Value) -> Result<Value, String> {
    let mut values = game_places(game_dirs)?;
    if let Some(downloads) = downloads { values.push(json!({"name":tr("下载", "下載", "Downloads"),"path":path_text(&downloads)?,"kind":"place"})); }
    values.push(json!({"name":tr("用户目录", "使用者目錄", "Home"),"path":path_text(&home)?,"kind":"place"}));
    #[cfg(windows)]
    for drive in b'A'..=b'Z' {
        let root = format!("{}:\\", drive as char);
        if fs::metadata(&root).map(|m| m.is_dir()).unwrap_or(false) { values.push(json!({"name":format!("{}:", drive as char),"path":root,"kind":"drive"})); }
    }
    #[cfg(not(windows))]
    values.push(json!({"name":tr("根目录", "根目錄", "Root"),"path":"/","kind":"drive"}));
    values.push(json!({"name":tr("启动器数据", "啟動器資料", "Launcher data"),"path":path_text(&data)?,"kind":"place"}));
    Ok(Value::Array(values))
}

// 递归前预检整棵目录，不穿透链接或特殊文件。额外计数限制防止误删巨大树。
fn validate_tree(root: &Path) -> Result<(), String> {
    let mut stack = vec![root.to_path_buf()]; let mut count = 0;
    while let Some(dir) = stack.pop() {
        reject_link_ancestors(&dir)?;
        for entry in fs::read_dir(&dir).map_err(fs_error)? {
            let path = entry.map_err(fs_error)?.path();
            let meta = fs::symlink_metadata(&path).map_err(fs_error)?;
            count += 1;
            if count > MAX_ENTRIES { return Err(tr("目录过大，请使用系统文件管理器处理", "目錄過大，請使用系統檔案管理員處理", "This directory is too large; use the system file manager")); }
            if is_link(&meta) { return Err(link_error()); }
            if meta.is_dir() { stack.push(path); } else if !meta.is_file() { return Err(invalid()); }
        }
    }
    Ok(())
}
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn remove<R: Runtime>(app: &AppHandle<R>, owner: &WebviewWindow<R>, raw: &str, protected: &[PathBuf]) -> Result<Value, String> {
    let path = existing(raw)?;
    let canonical = fs::canonicalize(&path).map_err(fs_error)?;
    if is_root(&path) || is_root(&canonical) || protected.iter().filter_map(|p| fs::canonicalize(p).ok()).any(|p| canonical == p || p.starts_with(&canonical)) { return Err(root_error()); }
    let meta = fs::symlink_metadata(&path).map_err(fs_error)?;
    if !meta.is_file() && !meta.is_dir() { return Err(invalid()); }
    let confirmed = app.dialog().message(tr("永久删除此项目及其全部内容？此操作无法撤销。", "永久刪除此項目及所有內容？此操作無法復原。", "Permanently delete this item and all its contents? This cannot be undone.") + "\n\n" + &path_text(&path)?)
        .title(tr("确认删除", "確認刪除", "Confirm deletion")).parent(owner).kind(MessageDialogKind::Warning).buttons(MessageDialogButtons::OkCancel).blocking_show();
    if !confirmed { return Err(tr("已取消删除", "已取消刪除", "Deletion cancelled")); }
    let _guard = FILE_WRITES.lock().map_err(|_| invalid())?;
    reject_link_ancestors(&path)?;
    let current = fs::symlink_metadata(&path).map_err(fs_error)?;
    if current.is_dir() != meta.is_dir() || fs::canonicalize(&path).map_err(fs_error)? != canonical { return Err(tr("项目在确认期间发生变化，请重试", "項目在確認期間變更，請重試", "The item changed during confirmation; try again")); }
    if current.is_dir() { validate_tree(&path)?; fs::remove_dir_all(&path).map_err(fs_error)?; } else { fs::remove_file(&path).map_err(fs_error)?; }
    Ok(Value::Null)
}

fn memory_value(total: u64, available: u64) -> Result<Value, String> {
    if total == 0 || available > total { return Err(platform_unsupported()); }
    let total = total.saturating_add(524288) / 1048576; let free = available.saturating_add(524288) / 1048576;
    Ok(json!({"total":total,"used":total.saturating_sub(free),"free":free}))
}
#[cfg(windows)]
fn memory_info() -> Result<Value, String> {
    #[repr(C)]
    struct MemoryStatus { length: u32, load: u32, total_phys: u64, avail_phys: u64, total_page: u64, avail_page: u64, total_virtual: u64, avail_virtual: u64, avail_extended: u64 }
    #[link(name = "kernel32")]
    extern "system" { fn GlobalMemoryStatusEx(status: *mut MemoryStatus) -> i32; }
    let mut status = MemoryStatus { length: std::mem::size_of::<MemoryStatus>() as u32, load:0,total_phys:0,avail_phys:0,total_page:0,avail_page:0,total_virtual:0,avail_virtual:0,avail_extended:0 };
    // API 仅填充固定布局结构，不接收渲染层指针。
    if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 { return Err(platform_unsupported()); }
    memory_value(status.total_phys, status.avail_phys)
}
#[cfg(any(target_os = "linux", target_os = "android"))]
fn memory_info() -> Result<Value, String> {
    let raw = fs::read_to_string("/proc/meminfo").map_err(fs_error)?;
    let read = |name: &str| -> Option<u64> { raw.lines().find_map(|line| { let (key,value) = line.split_once(':')?; if key != name { return None; } value.split_whitespace().next()?.parse::<u64>().ok()?.checked_mul(1024) }) };
    let total = read("MemTotal").ok_or_else(platform_unsupported)?;
    // 只使用内核实测字段，缺 MemAvailable 时采用真实 MemFree，不猜缓存可回收量。
    memory_value(total, read("MemAvailable").or_else(|| read("MemFree")).ok_or_else(platform_unsupported)?)
}
#[cfg(target_os = "macos")]
fn memory_info() -> Result<Value, String> {
    use std::{ffi::c_void, os::raw::c_char, ptr};
    extern "C" {
        fn sysctlbyname(name: *const c_char, old: *mut c_void, old_len: *mut usize, new: *mut c_void, new_len: usize) -> i32;
        fn mach_host_self() -> u32;
        fn host_statistics(host: u32, flavor: i32, info: *mut i32, count: *mut u32) -> i32;
        fn mach_port_deallocate(task: u32, name: u32) -> i32;
        static mach_task_self_: u32;
    }
    let mut total = 0u64; let mut length = std::mem::size_of::<u64>();
    if unsafe { sysctlbyname(b"hw.memsize\0".as_ptr().cast(), (&mut total as *mut u64).cast(), &mut length, ptr::null_mut(), 0) } != 0 || length != std::mem::size_of::<u64>() { return Err(platform_unsupported()); }
    let host = unsafe { mach_host_self() };
    if host == 0 { return Err(platform_unsupported()); }
    let mut page_size = 0u32; length = std::mem::size_of::<u32>();
    let page_result = unsafe { sysctlbyname(b"hw.pagesize\0".as_ptr().cast(), (&mut page_size as *mut u32).cast(), &mut length, ptr::null_mut(), 0) };
    let mut statistics = [0i32; 15]; let mut count = 15u32;
    // HOST_VM_INFO=2；固定 ABI 的前四项为 free/active/inactive/wired 页数。
    let stat_result = unsafe { host_statistics(host, 2, statistics.as_mut_ptr(), &mut count) };
    unsafe { mach_port_deallocate(mach_task_self_, host); }
    if page_result != 0 || length != std::mem::size_of::<u32>() || stat_result != 0 || count < 4 || page_size == 0 { return Err(platform_unsupported()); }
    let pages = (statistics[0] as u32 as u64).checked_add(statistics[2] as u32 as u64).ok_or_else(platform_unsupported)?;
    memory_value(total, pages.checked_mul(page_size as u64).ok_or_else(platform_unsupported)?)
}
#[cfg(not(any(windows, target_os = "linux", target_os = "android", target_os = "macos")))]
fn memory_info() -> Result<Value, String> { Err(platform_unsupported()) }

#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
    struct Temporary(PathBuf);
    impl Temporary {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let path = std::env::temp_dir().join(format!("hcmcl-desktop-{}-{stamp}-{}", std::process::id(), NEXT.fetch_add(1, AtomicOrdering::Relaxed)));
            fs::create_dir(&path).unwrap();
            Self(picker_path(fs::canonicalize(path).unwrap()).unwrap())
        }
        fn file(&self, relative: &str, bytes: &[u8]) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap(); fs::write(&path, bytes).unwrap(); path
        }
    }
    impl Drop for Temporary { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    #[test]
    fn picked_permission_binds_full_path_and_metadata() {
        let temp = Temporary::new();
        let selected = temp.file("chosen/same.jar", b"chosen");
        let other = temp.file("other/same.jar", b"chosen");
        let (canonical, stamp) = picked_snapshot(&selected).unwrap();
        let mut grants = PickedState::default();
        grants.register(0, vec![(canonical.clone(), stamp.clone())]).unwrap();
        assert!(grants.require(&canonical, &stamp).is_ok());
        let (other, other_stamp) = picked_snapshot(&other).unwrap();
        assert!(grants.require(&other, &other_stamp).is_err());
        fs::write(&selected, b"changed length").unwrap();
        let (canonical, changed) = picked_snapshot(&selected).unwrap();
        assert!(grants.require(&canonical, &changed).is_err());
    }
    #[test]
    fn same_path_replacement_loses_picked_permission() {
        let temp = Temporary::new(); let path = temp.file("resource.jar", b"same");
        let (canonical, stamp) = picked_snapshot(&path).unwrap();
        let mut grants = PickedState::default(); grants.register(0, vec![(canonical.clone(), stamp.clone())]).unwrap();
        fs::rename(&path, temp.0.join("original.jar")).unwrap();
        fs::write(&path, b"same").unwrap();
        let (_, replacement) = picked_snapshot(&path).unwrap();
        assert_ne!(stamp.identity, replacement.identity);
        assert!(grants.require(&canonical, &replacement).is_err());
    }
    #[test]
    fn main_close_clears_permissions_and_rejects_late_picker() {
        let temp = Temporary::new(); let path = temp.file("resource.jar", b"data");
        let snapshot = picked_snapshot(&path).unwrap(); let mut grants = PickedState::default();
        grants.register(0, vec![snapshot.clone()]).unwrap(); grants.clear(false);
        assert!(grants.require(&snapshot.0, &snapshot.1).is_err());
        assert!(grants.register(0, vec![snapshot.clone()]).is_err());
        assert!(grants.register(1, vec![snapshot.clone()]).is_ok());
        grants.clear(true); assert!(grants.register(2, vec![snapshot]).is_err());
    }
    #[test]
    fn picker_rejects_directory_relative_uri_and_unselected_metadata() {
        let temp = Temporary::new();
        assert!(picked_snapshot(&temp.0).is_err());
        assert!(picked_snapshot(Path::new("resource.jar")).is_err());
        assert!(picker_path(PathBuf::from("content://documents/tree/resource.jar")).is_err());
        let path = temp.file("resource.jar", b"data"); let snapshot = picked_snapshot(&path).unwrap();
        assert!(PickedState::default().require(&snapshot.0, &snapshot.1).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn picked_permission_rejects_symbolic_links() {
        use std::os::unix::fs::symlink;
        let temp = Temporary::new(); let path = temp.file("resource.jar", b"data");
        let link = temp.0.join("link.jar"); symlink(path, &link).unwrap();
        assert!(picked_snapshot(&link).is_err());
    }
    #[test]
    fn directory_permission_is_separate_and_close_rejects_late_picker() {
        let temp = Temporary::new(); let selected = temp.0.join("selected"); fs::create_dir(&selected).unwrap();
        let (path, grant) = picked_directory::Grant::capture(&selected).unwrap();
        let mut grants = PickedState::default();
        assert!(grants.require_directory(&path).is_err());
        grants.register_directory(0, path.clone(), grant.clone()).unwrap();
        fs::write(selected.join("member"), b"changed").unwrap();
        grants.require_directory(&path).unwrap();
        let file = temp.file("file", b"x"); let (file, stamp) = picked_snapshot(&file).unwrap();
        grants.register(0, vec![(file.clone(), stamp.clone())]).unwrap();
        assert!(grants.require_directory(&file).is_err());
        grants.clear(false);
        assert!(grants.require_directory(&path).is_err());
        assert!(grants.require(&file, &stamp).is_err());
        assert!(grants.register_directory(0, path.clone(), grant.clone()).is_err());
        grants.register_directory(1, path.clone(), grant.clone()).unwrap();
        grants.clear(true);
        assert!(grants.register_directory(2, path, grant).is_err());
    }
    #[test]
    fn locales_change_per_call_and_do_not_leak_between_threads() {
        assert_eq!(with_language("en", invalid), "Invalid arguments");
        assert_eq!(with_language("zh-TW", invalid), "參數無效");
        assert_eq!(with_language("zh-CN", invalid), "参数无效");
        assert_eq!(with_language("en", || { let _ = with_language("zh-TW", invalid); invalid() }), "Invalid arguments");
        let english = std::thread::spawn(|| with_language("en", invalid));
        let traditional = std::thread::spawn(|| with_language("zh-TW", invalid));
        assert_eq!(english.join().unwrap(), "Invalid arguments");
        assert_eq!(traditional.join().unwrap(), "參數無效");
    }
    #[test]
    fn game_places_use_existing_storage_roots_and_keep_aliases() {
        let temp = Temporary::new(); let root = temp.0.join("games"); fs::create_dir(&root).unwrap();
        let values = with_language("en", || game_places(&json!([
            {"path":root,"isDefault":true,"alias":"默认"},
            {"path":root,"alias":"duplicate"},
            {"path":temp.0.join("missing"),"alias":"missing"},
            {"path":temp.0,"alias":"Custom directory"}
        ]))).unwrap();
        assert_eq!(values.len(), 2); assert_eq!(values[0]["name"], "Default");
        assert_eq!(values[1]["name"], "Custom directory");
        assert_eq!(values[0]["kind"], "place");
        assert!(game_places(&json!([{"path":"content://documents/tree"}])).is_err());
    }
    #[test]
    fn hardware_channel_accepts_only_the_existing_no_argument_contract() {
        assert!(known_channel("system:hardware"));
        assert!(validate_arguments("system:hardware", &[]).is_ok());
        for arg in [Value::Null,json!({}),json!("untrusted path"),json!(true)] {
            assert!(validate_arguments("system:hardware", &[arg]).is_err());
        }
    }
    #[test]
    fn window_mode_channels_require_exact_boolean_arguments_in_every_locale() {
        for (language, invalid_text) in [("zh-CN", "参数无效"), ("zh-TW", "參數無效"), ("en", "Invalid arguments")] {
            with_language(language, || {
                for channel in ["window:setDesktopMode", "window:securityFullscreen"] {
                    assert!(known_channel(channel));
                    assert!(validate_arguments(channel, &[json!(true)]).is_ok());
                    assert!(validate_arguments(channel, &[json!(false)]).is_ok());
                    for args in [vec![], vec![Value::Null], vec![json!(1)], vec![json!("true")], vec![json!(true), json!(false)]] {
                        assert_eq!(validate_arguments(channel, &args).unwrap_err(), invalid_text);
                    }
                }
            });
        }
    }
    #[test]
    fn android_and_ios_window_modes_are_denied_before_any_native_dispatch() {
        for language in ["zh-CN", "zh-TW", "en"] {
            with_language(language, || {
                for channel in ["window:setDesktopMode", "window:securityFullscreen", "window:minimize", "window:maximize", "window:close", "window:isMaximized", "window:setFullscreen", "window:setAlwaysOnTop", "display:primary"] {
                    // 两个移动目标共用同一生产门禁；这里只调用纯门禁，不创建窗口或调度器。
                    assert_eq!(validate_platform(channel, true).unwrap_err(), platform_unsupported());
                    assert!(validate_platform(channel, false).is_ok());
                }
                for channel in ["shell:openExternal", "system:memory", "system:hardware"] {
                    assert!(validate_platform(channel, true).is_ok());
                }
            });
        }
    }
    #[test]
    fn java_picker_contract_accepts_no_path_or_filter_arguments() {
        assert!(known_channel("java:pick")); assert!(validate_arguments("java:pick", &[]).is_ok());
        assert!(validate_arguments("java:pick", &[json!("/unselected/java")]).is_err());
        assert!(validate_arguments("shell:pickFile", &[Value::Null]).is_ok());
        assert!(validate_arguments("shell:pickFiles", &[json!([])]).is_ok());
        assert!(validate_arguments("files:places", &[json!("untrusted path")]).is_err());
        assert!(!known_channel("remote:proxy"));
    }
}

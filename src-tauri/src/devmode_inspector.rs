//! Windows Inspector 的保守 HWND 记录；不持有 WebView，不处理授权或网络。
//!
//! WebView2 没有公开 Inspector HWND/关闭接口。下面的 PID、窗口差集及标题规则
//! 只是首次归属的必要条件；调用方必须串行 Inspector 打开操作、禁用所有自动入口，
//! 并先在隔离 profile 验证当前 Runtime 的 class/title。未知布局不会放宽匹配。
//! SetProp cookie 用于记录后的身份复核，不能把首次窗口关联升级为 WebView2 的保证。
#![cfg(windows)]

use std::{collections::BTreeSet, ffi::c_void, sync::Arc, time::{Duration, Instant}};

type Handle = *mut c_void;
type Hwnd = isize;
pub(super) type Result<T> = std::result::Result<T, String>;

const CLASS: &str = "Chrome_WidgetWin_1";
const MAX_WINDOWS: usize = 512;
const MAX_ENUMERATED: usize = 16_384;
const MAX_TITLE: usize = 2_048;
const ENUM_BUDGET: Duration = Duration::from_millis(200);
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const SYNCHRONIZE: u32 = 0x0010_0000;
const WAIT_TIMEOUT: u32 = 258;
const GA_ROOT: u32 = 2;
const WM_CLOSE: u32 = 0x0010;
const SW_RESTORE: i32 = 9;

#[repr(C)]
#[derive(Default)]
struct FileTime { low: u32, high: u32 }

#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
    fn CloseHandle(handle: Handle) -> i32;
    fn GetCurrentProcessId() -> u32;
    fn GetProcessId(handle: Handle) -> u32;
    fn GetProcessTimes(handle: Handle, created: *mut FileTime, exited: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
    fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    fn SetLastError(code: u32);
    fn GetLastError() -> u32;
}

#[link(name = "user32")]
extern "system" {
    fn EnumWindows(callback: Option<unsafe extern "system" fn(Hwnd, isize) -> i32>, data: isize) -> i32;
    fn IsWindow(hwnd: Hwnd) -> i32;
    fn GetAncestor(hwnd: Hwnd, flags: u32) -> Hwnd;
    fn GetWindowThreadProcessId(hwnd: Hwnd, pid: *mut u32) -> u32;
    fn GetClassNameW(hwnd: Hwnd, output: *mut u16, capacity: i32) -> i32;
    fn GetWindowTextLengthW(hwnd: Hwnd) -> i32;
    fn GetWindowTextW(hwnd: Hwnd, output: *mut u16, capacity: i32) -> i32;
    fn SetPropW(hwnd: Hwnd, name: *const u16, value: Handle) -> i32;
    fn GetPropW(hwnd: Hwnd, name: *const u16) -> Handle;
    fn RemovePropW(hwnd: Hwnd, name: *const u16) -> Handle;
    fn IsIconic(hwnd: Hwnd) -> i32;
    fn ShowWindowAsync(hwnd: Hwnd, command: i32) -> i32;
    fn SetForegroundWindow(hwnd: Hwnd) -> i32;
    fn PostMessageW(hwnd: Hwnd, message: u32, wparam: usize, lparam: isize) -> i32;
}

fn error(cn: &str, tw: &str, en: &str) -> String { format!("{cn} / {tw} / {en}") }
fn native_error(cn: &str, tw: &str, en: &str) -> String {
    let code = unsafe { GetLastError() };
    format!("{} ({code})", error(cn, tw, en))
}
fn uncertain() -> String {
    error("Inspector 窗口归属未确认，已保留现场", "Inspector 視窗歸屬未確認，已保留現場", "Inspector ownership is unconfirmed; the window was left untouched")
}

#[derive(Debug)]
struct Process { handle: Handle, pid: u32, created: u64 }
// 仅持查询/SYNCHRONIZE 权限的进程句柄，无线程亲和性；所有访问只读。
// Arc 的最后一个持有者才会在 Drop 释放，不传递 WebView/COM 对象。
unsafe impl Send for Process {}
unsafe impl Sync for Process {}
impl Drop for Process {
    fn drop(&mut self) { unsafe { CloseHandle(self.handle); } }
}
impl Process {
    fn open(pid: u32) -> Result<Self> {
        if pid == 0 || pid == unsafe { GetCurrentProcessId() } { return Err(uncertain()); }
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid) };
        if handle.is_null() {
            return Err(native_error("无法查询指定的 WebView2 浏览器进程", "無法查詢指定的 WebView2 瀏覽器處理程序", "Cannot query the specified WebView2 browser process"));
        }
        let mut process = Self { handle, pid, created: 0 };
        process.created = process.creation_time().ok_or_else(uncertain)?;
        if !process.current() { return Err(uncertain()); }
        Ok(process)
    }
    fn creation_time(&self) -> Option<u64> {
        let (mut created, mut exited, mut kernel, mut user) = (FileTime::default(), FileTime::default(), FileTime::default(), FileTime::default());
        if unsafe { GetProcessTimes(self.handle, &mut created, &mut exited, &mut kernel, &mut user) } == 0 { return None; }
        Some((u64::from(created.high) << 32) | u64::from(created.low))
    }
    fn current(&self) -> bool {
        (unsafe { WaitForSingleObject(self.handle, 0) == WAIT_TIMEOUT && GetProcessId(self.handle) == self.pid })
            && self.creation_time() == Some(self.created)
    }
}

struct Enumeration { pid: u32, windows: Vec<usize>, visited: usize, exceeded: bool, started: Instant }
unsafe extern "system" fn enumerate(hwnd: Hwnd, data: isize) -> i32 {
    let state = &mut *(data as *mut Enumeration);
    state.visited += 1;
    if state.visited > MAX_ENUMERATED || state.started.elapsed() >= ENUM_BUDGET {
        state.exceeded = true; return 0;
    }
    let mut pid = 0;
    let thread = GetWindowThreadProcessId(hwnd, &mut pid);
    // EnumWindows 必须遍历桌面窗口；对其他 PID 不读标题/class，也不打开进程。
    if pid == state.pid && thread != 0 && GetAncestor(hwnd, GA_ROOT) == hwnd {
        if state.windows.len() == MAX_WINDOWS { state.exceeded = true; return 0; }
        state.windows.push(hwnd as usize);
    }
    1
}
fn windows(process: &Process) -> Result<Vec<usize>> {
    if !process.current() { return Err(uncertain()); }
    let mut state = Enumeration { pid: process.pid, windows: Vec::new(), visited: 0, exceeded: false, started: Instant::now() };
    unsafe { SetLastError(0); }
    let completed = unsafe { EnumWindows(Some(enumerate), &mut state as *mut Enumeration as isize) };
    if state.exceeded {
        return Err(error("Inspector 窗口枚举超出有界范围", "Inspector 視窗列舉超出有界範圍", "Inspector window enumeration exceeded its bounded limits"));
    }
    if completed == 0 {
        return Err(native_error("无法枚举指定进程的窗口", "無法列舉指定處理程序的視窗", "Cannot enumerate windows for the specified process"));
    }
    if !process.current() { return Err(uncertain()); }
    state.windows.sort_unstable(); state.windows.dedup();
    Ok(state.windows)
}

/// 打开前的进程代次及 HWND 快照；capture 重试和已归属窗口共享同一查询句柄。
#[derive(Debug)]
pub(super) struct Snapshot { process: Arc<Process>, before: Vec<usize> }
impl Snapshot {
    pub(super) fn browser_pid(&self) -> u32 { self.process.pid }
    pub(super) fn current(&self) -> bool { self.process.current() }
}
/// 打开 Inspector 前调用。这里只记录该 browser PID 的顶层 HWND，不读取其他进程内容。
pub(super) fn snapshot(browser_pid: u32) -> Result<Snapshot> {
    let process = Arc::new(Process::open(browser_pid)?);
    let before = windows(&process)?;
    Ok(Snapshot { process, before })
}

fn origin_text(value: &str) -> Result<String> {
    // 调用方给明确的 host[:port] token；不接受路径、用户信息、scheme 或模糊子串。
    if value.is_empty() || value.len() > 512 || !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b".-:[]".contains(&byte)) {
        return Err(uncertain());
    }
    let value = value.to_ascii_lowercase();
    let parsed = url::Url::parse(&format!("tauri://{value}/")).map_err(|_| uncertain())?;
    if parsed.host_str().is_none() || parsed.as_str() != format!("tauri://{value}/") { return Err(uncertain()); }
    Ok(value)
}
fn title_separator(value: char) -> bool {
    // '-'、'.'、':'、'/' 是 host/URL 的组成部分，不能当作主机 token 的分隔符。
    value.is_whitespace() || matches!(value, '–' | '—' | '|' | '(' | ')' | '{' | '}' | '<' | '>' | '\'' | '"')
}
fn matches_title(title: &str, expected: &str) -> bool {
    let title = title.to_ascii_lowercase();
    let expected = expected.to_ascii_lowercase();
    let mut devtools = false;
    let mut origin = false;
    for part in title.split(title_separator) {
        devtools |= part == "devtools";
        let part = part.strip_suffix('/').unwrap_or(part);
        let part = ["http://", "https://", "tauri://"].into_iter().find_map(|scheme| part.strip_prefix(scheme)).unwrap_or(part);
        origin |= part == expected;
    }
    devtools && origin
}
fn class_matches(hwnd: Hwnd) -> bool {
    let mut text = [0u16; 128];
    let length = unsafe { GetClassNameW(hwnd, text.as_mut_ptr(), text.len() as i32) };
    length > 0 && String::from_utf16(&text[..length as usize]).is_ok_and(|value| value == CLASS)
}
fn title(hwnd: Hwnd) -> Result<String> {
    unsafe { SetLastError(0); }
    let length = unsafe { GetWindowTextLengthW(hwnd) };
    if length == 0 && unsafe { GetLastError() } != 0 { return Err(uncertain()); }
    if length < 0 || length as usize > MAX_TITLE { return Err(uncertain()); }
    let mut text = vec![0u16; MAX_TITLE + 1];
    unsafe { SetLastError(0); }
    let written = unsafe { GetWindowTextW(hwnd, text.as_mut_ptr(), text.len() as i32) };
    if written == 0 && unsafe { GetLastError() } != 0 { return Err(uncertain()); }
    if written < 0 || written as usize >= MAX_TITLE { return Err(uncertain()); }
    String::from_utf16(&text[..written as usize]).map_err(|_| uncertain())
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Candidate { hwnd: usize, thread: u32 }
fn candidate(process: &Process, hwnd: usize, expected: &str) -> Result<Option<Candidate>> {
    let hwnd = hwnd as Hwnd;
    let mut pid = 0;
    let thread = unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    if thread == 0 || pid != process.pid || unsafe { GetAncestor(hwnd, GA_ROOT) } != hwnd || !class_matches(hwnd) { return Ok(None); }
    if !matches_title(&title(hwnd)?, expected) { return Ok(None); }
    Ok(Some(Candidate { hwnd: hwnd as usize, thread }))
}
fn unique(candidates: &[Candidate]) -> Result<Option<Candidate>> {
    match candidates { [] => Ok(None), [value] => Ok(Some(*value)), _ => Err(uncertain()) }
}
fn candidates(process: &Process, before: &BTreeSet<usize>, expected: &str) -> Result<Vec<Candidate>> {
    let mut result = Vec::new();
    for hwnd in windows(process)? {
        if !before.contains(&hwnd) {
            if let Some(found) = candidate(process, hwnd, expected)? { result.push(found); }
        }
    }
    Ok(result)
}

/// 首次唯一关联后保留进程句柄、创建时间、线程和随机窗口属性。Drop 不发送关闭消息。
#[derive(Debug)]
pub(super) struct OwnedInspector { process: Arc<Process>, hwnd: usize, thread: u32, property: Vec<u16>, cookie: usize }

/// 调用方可按 250ms/总计 2s 重试。None 只表示没有可归属的新窗口，不表示 Inspector 已关闭。
/// 已存在窗口、跨 PID 窗口、标题未知或多窗口竞争均不会被“领养”。
pub(super) fn capture(snapshot: &Snapshot, expected_origin: &str) -> Result<Option<OwnedInspector>> {
    if snapshot.before.len() > MAX_WINDOWS || !snapshot.current() { return Err(uncertain()); }
    let expected = origin_text(expected_origin)?;
    // 不能按 PID 重开：原进程退出后即使 PID 复用，快照及重试仍只引用原内核对象。
    let process = Arc::clone(&snapshot.process);
    let before = snapshot.before.iter().copied().collect::<BTreeSet<_>>();
    let Some(found) = unique(&candidates(&process, &before, &expected)?)? else { return Ok(None); };
    // 重新枚举，拒绝观察期间发生的歧义；这仍不是 OS 提供的原子窗口归属事务。
    if unique(&candidates(&process, &before, &expected)?)? != Some(found) { return Err(uncertain()); }
    let property = format!("HCMCL.OwnedInspector.{}", uuid::Uuid::new_v4()).encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let cookie = (uuid::Uuid::new_v4().as_u128() as usize) | 1;
    if unsafe { GetPropW(found.hwnd as Hwnd, property.as_ptr()) } != std::ptr::null_mut() { return Err(uncertain()); }
    if candidate(&process, found.hwnd, &expected)? != Some(found) || !process.current() { return Err(uncertain()); }
    if unsafe { SetPropW(found.hwnd as Hwnd, property.as_ptr(), cookie as Handle) } == 0 {
        return Err(native_error("无法标记自有 Inspector 窗口", "無法標記自有 Inspector 視窗", "Cannot mark the owned Inspector window"));
    }
    let owned = OwnedInspector { process, hwnd: found.hwnd, thread: found.thread, property, cookie };
    if !owned.alive() || candidate(&owned.process, found.hwnd, &expected)? != Some(found) { return Err(uncertain()); }
    Ok(Some(owned))
}
impl OwnedInspector {
    /// false 包含窗口已消失和身份无法验证；不能把 false 一律当成成功关闭。
    pub(super) fn alive(&self) -> bool {
        if !self.process.current() { return false; }
        let hwnd = self.hwnd as Hwnd;
        let mut pid = 0;
        let thread = unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        thread == self.thread && pid == self.process.pid && unsafe { IsWindow(hwnd) } != 0
            && unsafe { GetAncestor(hwnd, GA_ROOT) } == hwnd && class_matches(hwnd)
            && unsafe { GetPropW(hwnd, self.property.as_ptr()) } == self.cookie as Handle
    }
    /// 仅对进程退出、HWND 消失或 PID/TID 已确定改变作“原窗口已不在”判断。
    /// 单纯 cookie/class 校验失败仍为未知；调用方必须同时确认主 WebView 仍存活。
    pub(super) fn gone(&self) -> bool {
        if unsafe { WaitForSingleObject(self.process.handle, 0) } == 0 { return true; }
        let hwnd = self.hwnd as Hwnd;
        if unsafe { IsWindow(hwnd) } == 0 { return true; }
        let mut pid = 0;
        let thread = unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        thread != 0 && (pid != self.process.pid || thread != self.thread)
    }
    pub(super) fn focus(&self) -> Result<()> {
        if !self.alive() { return Err(uncertain()); }
        let hwnd = self.hwnd as Hwnd;
        if unsafe { IsIconic(hwnd) } != 0 && unsafe { ShowWindowAsync(hwnd, SW_RESTORE) } == 0 {
            return Err(native_error("无法还原自有 Inspector 窗口", "無法還原自有 Inspector 視窗", "Cannot restore the owned Inspector window"));
        }
        if !self.alive() { return Err(uncertain()); }
        if unsafe { SetForegroundWindow(hwnd) } == 0 {
            return Err(error("系统未允许聚焦自有 Inspector 窗口", "系統未允許聚焦自有 Inspector 視窗", "The system did not allow focusing the owned Inspector window"));
        }
        Ok(())
    }
    /// Ok 仅表示 WM_CLOSE 已排队；调用方必须保留记录并异步复核，不能据此确认关闭。
    /// 复核与 PostMessage 之间没有 HWND CAS；任何身份不明情形均不发送消息。
    pub(super) fn close(&self) -> Result<()> {
        if !self.alive() { return Err(uncertain()); }
        if unsafe { PostMessageW(self.hwnd as Hwnd, WM_CLOSE, 0, 0) } == 0 {
            return Err(native_error("无法向自有 Inspector 发送关闭请求", "無法向自有 Inspector 傳送關閉要求", "Cannot queue a close request for the owned Inspector"));
        }
        Ok(())
    }
}
impl Drop for OwnedInspector {
    fn drop(&mut self) {
        // 只清除仍能验证的自有属性；不在 Drop 中聚焦、关闭或触碰未知窗口。
        if self.alive() { unsafe { RemovePropW(self.hwnd as Hwnd, self.property.as_ptr()); } }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inspector_title_requires_exact_origin_and_devtools_tokens() {
        for text in ["DevTools - tauri.localhost", "DevTools - http://tauri.localhost", "DevTools - http://tauri.localhost/", "DevTools (tauri.localhost/)", "DEVTOOLS - HTTP://TAURI.LOCALHOST/"] {
            assert!(matches_title(text, "tauri.localhost"));
        }
        for text in ["HungerCat - tauri.localhost", "DevTools - tauri.localhost.evil", "DevTools - evil-tauri.localhost", "DevTools - tauri.localhost.evil/", "DevTools - tauri.localhost:1420", "DevTools - http://tauri.localhost/other", "DevTools - ftp://tauri.localhost", "DevTools - http://u@tauri.localhost", "FakeDevTools - tauri.localhost", "DevTools - tauri.localhost//", "DevTools - tauri.localhost?x=1", "DevTools - tauri.localhost#frame"] {
            assert!(!matches_title(text, "tauri.localhost"));
        }
        assert!(matches_title("DevTools - http://localhost:1420/", "localhost:1420"));
        assert!(matches_title("DevTools - http://[::1]:1420/", "[::1]:1420"));
        assert!(!matches_title("DevTools - http://localhost:14200/", "localhost:1420"));
    }
    #[test]
    fn inspector_origin_rejects_non_origin_inputs() {
        assert_eq!(origin_text("TAURI.LOCALHOST").unwrap(), "tauri.localhost");
        assert_eq!(origin_text("localhost:1420").unwrap(), "localhost:1420");
        assert_eq!(origin_text("[::1]:1420").unwrap(), "[::1]:1420");
        for value in ["", "http://tauri.localhost", "tauri.localhost/", "file:///index.html", "u@tauri.localhost", "tauri.localhost/path", "tauri.localhost?x=1", "tauri.localhost#frame", "tauri.localhost\n", "tauri.localhost:65536", "tauri.localhost:invalid"] {
            assert!(origin_text(value).is_err());
        }
    }
    #[test]
    fn inspector_capture_requires_a_unique_candidate() {
        let first = Candidate { hwnd: 1, thread: 2 };
        let second = Candidate { hwnd: 3, thread: 2 };
        assert_eq!(unique(&[]).unwrap(), None);
        assert_eq!(unique(&[first]).unwrap(), Some(first));
        assert!(unique(&[first, second]).is_err());
        assert!(unique(&[first, first]).is_err());
    }
    #[test]
    fn inspector_record_is_send_without_com_objects() {
        fn send_sync<T: Send + Sync>() {}
        send_sync::<Process>();
        send_sync::<Snapshot>();
        send_sync::<OwnedInspector>();
    }
    #[test]
    fn inspector_snapshot_generation_api_does_not_reopen_by_pid() {
        let _: fn(u32) -> Result<Snapshot> = snapshot;
        let _: fn(&Snapshot, &str) -> Result<Option<OwnedInspector>> = capture;
    }
}

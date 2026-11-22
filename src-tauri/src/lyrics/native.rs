//! 自有后台线程读取公开 SMTC；仅登记 Ctrl+Alt+[ / ]，不读取普通按键或进程内存。
use super::*;
use std::{ffi::c_void, thread::JoinHandle};
use windows::Media::Control::{GlobalSystemMediaTransportControlsSessionManager as MediaManager, GlobalSystemMediaTransportControlsSessionPlaybackStatus as Playback};
use windows::ApplicationModel::AppInfo;
const MODIFIERS: u32 = 0x0001 | 0x0002;
const NO_REPEAT: u32 = 0x4000;
const KEYS: [(i32, u32, i32); 2] = [(0x4c31, 0xdb, -1), (0x4c32, 0xdd, 1)];
#[repr(C)]
struct Point { x: i32, y: i32 }
#[repr(C)]
struct Message { hwnd: *mut c_void, message: u32, wparam: usize, lparam: isize, time: u32, point: Point, private: u32 }
#[link(name = "combase")]
extern "system" { fn RoInitialize(kind: u32) -> i32; fn RoUninitialize(); }
#[link(name = "user32")]
extern "system" {
    fn RegisterHotKey(hwnd: *mut c_void, id: i32, modifiers: u32, key: u32) -> i32;
    fn UnregisterHotKey(hwnd: *mut c_void, id: i32) -> i32;
    fn PeekMessageW(message: *mut Message, hwnd: *mut c_void, first: u32, last: u32, remove: u32) -> i32;
}
macro_rules! wait_operation {
    ($operation:expr, $control:expr, $revision:expr) => {{
        let operation = $operation.map_err(|_| ())?;
        let deadline = std::time::Instant::now() + Duration::from_millis(2500);
        let mut cancelled = false;
        loop {
            if !cancelled && (!$control.current($revision) || std::time::Instant::now() >= deadline) {
                let _ = operation.Cancel(); cancelled = true;
            }
            match operation.Status() {
                Ok(status) if status.0 == 0 => {
                    // Cancel 只是请求。操作和当前业务票由同一线程继续持有到终态；
                    // 外层 shutdown 有界等待，超时保留线程所有者供稍后重试。
                    std::thread::sleep(Duration::from_millis(25));
                }
                Ok(status) if status.0 == 1 => {
                    let value = operation.GetResults().map_err(|_| ())?;
                    let _ = operation.Close();
                    if cancelled || !$control.current($revision) { return Err(()); }
                    break value;
                }
                Ok(_) => { let _ = operation.Close(); return Err(()); }
                Err(_) => {
                    // 连状态都未能确认时继续持有 operation / Gate，不把 Cancel 当作终态。
                    if !cancelled { let _ = operation.Cancel(); cancelled = true; }
                    std::thread::sleep(Duration::from_millis(25));
                }
            }
        }
    }};
}
fn make_manager(control: &Control, revision: u64) -> std::result::Result<MediaManager, ()> {
    Ok(wait_operation!(MediaManager::RequestAsync(), control, revision))
}
fn clean(value: String) -> String {
    if value.len() > model::MAX_TEXT { String::new() }
    else { value.chars().filter(|c| !c.is_control()).collect::<String>().trim().to_owned() }
}
fn matches_source(value: &str) -> bool {
    let value = value.to_lowercase(); ["cloudmusic", "netease", "wangyiyun"].iter().any(|key| value.contains(key))
}
fn sample(manager: &MediaManager, control: &Control, revision: u64) -> std::result::Result<Option<Session>, ()> {
    let sessions = manager.GetSessions().map_err(|_| ())?; let count = sessions.Size().map_err(|_| ())?.min(64);
    let mut fallback = None; let mut chosen = None;
    for index in 0..count {
        if !control.current(revision) { return Err(()); }
        let Ok(session) = sessions.GetAt(index) else { continue; };
        let Ok(source) = session.SourceAppUserModelId() else { continue; };
        if source.len() > model::MAX_TEXT || !matches_source(&source.to_string_lossy()) { continue; }
        let playing = session.GetPlaybackInfo().and_then(|info| info.PlaybackStatus()).ok().map(|status| status == Playback::Playing);
        if fallback.is_none() { fallback = Some((session.clone(), source.clone(), playing)); }
        if playing == Some(true) { chosen = Some((session, source, playing)); break; }
    }
    let Some((session, source_id, playing)) = chosen.or(fallback) else { return Ok(None); };
    let properties = wait_operation!(session.TryGetMediaPropertiesAsync(), control, revision);
    let title = clean(properties.Title().map_err(|_| ())?.to_string_lossy());
    if title.is_empty() { return Ok(None); }
    let artist = clean(properties.Artist().map(|s| s.to_string_lossy()).unwrap_or_default());
    let source = AppInfo::GetFromAppUserModelId(&source_id).and_then(|app| app.DisplayInfo()).and_then(|info| info.DisplayName())
        .map(|s| clean(s.to_string_lossy())).ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "SMTC".into());
    let mut value = Session { title, artist, source, playing, ..Session::default() };
    if let Ok(timeline) = session.GetTimelineProperties() {
        value.start = timeline.StartTime().map(|v| v.Duration as f64 / 10_000_000.0).unwrap_or(0.0).max(0.0);
        value.end = timeline.EndTime().map(|v| v.Duration as f64 / 10_000_000.0).unwrap_or(0.0).max(0.0);
        value.pos = timeline.Position().map(|v| v.Duration as f64 / 10_000_000.0).unwrap_or(0.0).max(0.0);
        value.updated = timeline.LastUpdatedTime().map(|v| v.UniversalTime as f64 / 10_000.0 - 11_644_473_600_000.0).unwrap_or(0.0);
        if value.updated < 946_684_800_000.0 { value.updated = 0.0; }
    }
    Ok(Some(value))
}
struct Hotkeys { registered: [bool; 2], attempted: Option<u64> }
impl Hotkeys {
    fn new() -> Self { Self { registered: [false; 2], attempted: None } }
    fn sync(&mut self, app: &AppHandle, wanted: bool, revision: u64) -> bool {
        if !wanted {
            for (index, (id, _, _)) in KEYS.iter().enumerate() {
                if self.registered[index] {
                    if unsafe { UnregisterHotKey(std::ptr::null_mut(), *id) } == 0 { return false; }
                    self.registered[index] = false;
                }
            }
            self.attempted = None;
        } else if self.attempted != Some(revision) {
            self.attempted = Some(revision);
            for (index, (id, key, _)) in KEYS.iter().enumerate() {
                if !self.registered[index] {
                    self.registered[index] = unsafe { RegisterHotKey(std::ptr::null_mut(), *id, MODIFIERS | NO_REPEAT, *key) } != 0;
                    if !self.registered[index] { let _ = crate::debug::append(app, "warn", "lyrics", "歌词校准热键注册失败 / 歌詞校準快速鍵登記失敗 / Lyrics adjustment hotkey registration failed"); }
                }
            }
        }
        true
    }
    fn messages(&self, app: &AppHandle) {
        let mut message: Message = unsafe { std::mem::zeroed() };
        for _ in 0..32 {
            if unsafe { PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, 1) } == 0 { break; }
            if message.message != 0x0312 || (message.lparam as usize & 0xffff) as u32 != MODIFIERS { continue; }
            for (index, (id, key, direction)) in KEYS.iter().enumerate() {
                if self.registered[index] && message.wparam == *id as usize && ((message.lparam as usize >> 16) & 0xffff) as u32 == *key { dispatch_nudge(app, *direction); }
            }
        }
    }
}
impl Drop for Hotkeys {
    fn drop(&mut self) { for (index, (id, _, _)) in KEYS.iter().enumerate() { if self.registered[index] { unsafe { UnregisterHotKey(std::ptr::null_mut(), *id); } } } }
}
pub(super) struct Worker { thread: Option<JoinHandle<()>>, done: tokio::sync::watch::Sender<bool> }
impl Worker {
    pub(super) fn start(app: AppHandle, state: Arc<State>) -> Result<Self> {
        let done = tokio::sync::watch::channel(false).0; let finished = done.clone();
        let thread = std::thread::Builder::new().name("hc-lyrics-media".into()).spawn(move || {
            struct Finished(tokio::sync::watch::Sender<bool>);
            impl Drop for Finished { fn drop(&mut self) { self.0.send_replace(true); } }
            let _finished = Finished(finished);
            if unsafe { RoInitialize(1) } < 0 { return; }
            struct Apartment; impl Drop for Apartment { fn drop(&mut self) { unsafe { RoUninitialize(); } } }
            let _apartment = Apartment; let mut manager = None; let mut hotkeys = Hotkeys::new();
            let mut next = std::time::Instant::now(); let mut manager_retry = next;
            while !state.control.closed.load(Ordering::Acquire) {
                let revision = state.control.revision.load(Ordering::Acquire); let wanted = state.control.current(revision);
                if !hotkeys.sync(&app, wanted, revision) { return; }
                hotkeys.messages(&app);
                if !wanted { manager = None; }
                else if std::time::Instant::now() >= next {
                    let request = match app.state::<crate::lifecycle::Gate>().enter_classified() {
                        Ok(value) => Some(value), Err(_) => None,
                    };
                    if let Some(request) = request {
                        if manager.is_none() && std::time::Instant::now() >= manager_retry {
                            manager = make_manager(&state.control, revision).ok(); manager_retry = std::time::Instant::now() + Duration::from_secs(30);
                        }
                        if let Some(current) = manager.as_ref() {
                            match sample(current, &state.control, revision) {
                                Ok(value) => sampled(&app, &state, revision, value),
                                Err(()) => { if state.control.current(revision) { manager = None; } }
                            }
                        }
                        request.finish();
                    }
                    next = std::time::Instant::now() + Duration::from_millis(400);
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            // 先释放注册和所有 COM 对象，再发线程结束回执；join 方仍须核对 panic。
            drop(hotkeys); drop(manager);
        }).map_err(|_| unavailable())?;
        Ok(Self { thread: Some(thread), done })
    }
    pub(super) fn subscribe(&self) -> tokio::sync::watch::Receiver<bool> { self.done.subscribe() }
    pub(super) fn join(mut self) -> Result<()> { self.thread.take().ok_or_else(unavailable)?.join().map_err(|_| unavailable()) }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn source_filter_and_fixed_shortcuts_only_match_the_known_contract() {
        for source in ["cloudmusic.exe","com.netease.cloudmusic","WangYiYunMusic"] { assert!(matches_source(source)); }
        assert!(!matches_source("other-player")); assert_eq!(KEYS, [(0x4c31,0xdb,-1),(0x4c32,0xdd,1)]);
    }
}

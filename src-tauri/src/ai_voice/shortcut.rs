//! 一个专用消息线程，只注册固定 Ctrl+Alt+V；不装钩子、不使用 SendInput。
use super::*;
use std::{ffi::c_void, sync::atomic::AtomicU32, thread::JoinHandle};

const ID: i32 = 0x4843;
const MODIFIERS: u32 = 0x0001 | 0x0002; // MOD_ALT | MOD_CONTROL
const NO_REPEAT: u32 = 0x4000;
const KEY: u32 = b'V' as u32;
const HOTKEY: u32 = 0x0312;
const WAKE: u32 = 0x8000 + 0x43;
const TIMER: u32 = 0x0113;
#[repr(C)]
#[derive(Default)]
struct Point { x: i32, y: i32 }
#[repr(C)]
struct Message { hwnd: *mut c_void, message: u32, wparam: usize, lparam: isize, time: u32, point: Point, private: u32 }
#[link(name = "user32")]
extern "system" {
    fn RegisterHotKey(hwnd: *mut c_void, id: i32, modifiers: u32, key: u32) -> i32;
    fn UnregisterHotKey(hwnd: *mut c_void, id: i32) -> i32;
    fn PeekMessageW(message: *mut Message, hwnd: *mut c_void, first: u32, last: u32, remove: u32) -> i32;
    fn GetMessageW(message: *mut Message, hwnd: *mut c_void, first: u32, last: u32) -> i32;
    fn PostThreadMessageW(thread: u32, message: u32, wparam: usize, lparam: isize) -> i32;
    fn SetTimer(hwnd: *mut c_void, id: usize, milliseconds: u32, callback: Option<unsafe extern "system" fn(*mut c_void, u32, usize, u32)>) -> usize;
    fn KillTimer(hwnd: *mut c_void, id: usize) -> i32;
}
#[link(name = "kernel32")]
extern "system" { fn GetCurrentThreadId() -> u32; }

pub(super) struct Worker {
    thread: Option<JoinHandle<()>>,
    id: Arc<AtomicU32>,
    done: tokio::sync::watch::Sender<bool>,
}
impl Worker {
    pub fn start(app: AppHandle, control: Arc<Control>) -> Result<Self> {
        let id = Arc::new(AtomicU32::new(0)); let native_id = id.clone();
        let done = tokio::sync::watch::channel(false).0; let finished = done.clone();
        let thread = std::thread::Builder::new().name("hc-ai-voice-hotkey".into()).spawn(move || {
            // 即使消息线程异常也通知 join 方；panic 不表示 native 热键已验证成功。
            struct Finished(tokio::sync::watch::Sender<bool>);
            impl Drop for Finished { fn drop(&mut self) { self.0.send_replace(true); } }
            let _finished = Finished(finished);
            let mut message: Message = unsafe { std::mem::zeroed() };
            unsafe { PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, 0); }
            native_id.store(unsafe { GetCurrentThreadId() }, Ordering::Release);
            // 定时消息只是有限频率的开关/退出兜底；从不读取键盘状态。
            let timer = unsafe { SetTimer(std::ptr::null_mut(), 0, 100, None) };
            if timer == 0 {
                warning(&app, "AI 语音热键消息线程不可用 / AI 語音快速鍵訊息執行緒無法使用 / AI voice hotkey message loop is unavailable");
                native_id.store(0, Ordering::Release); return;
            }
            let mut registered = false;
            let mut attempted = None;
            loop {
                if control.closed.load(Ordering::Acquire) { break; }
                let enabled = control.enabled();
                let revision = control.revision.load(Ordering::Acquire);
                if !enabled && registered {
                    if unsafe { UnregisterHotKey(std::ptr::null_mut(), ID) } == 0 {
                        warning(&app, "AI 语音热键注销未确认，将结束自有线程 / AI 語音快速鍵取消登記未確認，將結束自有執行緒 / AI hotkey unregistration is unconfirmed; its owned thread will exit");
                        break;
                    }
                    registered = false;
                }
                if !enabled { attempted = None; }
                if enabled && !registered && attempted != Some(revision) {
                    attempted = Some(revision);
                    registered = unsafe { RegisterHotKey(std::ptr::null_mut(), ID, MODIFIERS | NO_REPEAT, KEY) } != 0;
                    if !registered {
                        warning(&app, "Ctrl+Alt+V 注册失败，可能已被其它程序占用 / Ctrl+Alt+V 登記失敗，可能已由其他程式使用 / Ctrl+Alt+V registration failed; another application may own it");
                    }
                }
                let result = unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) };
                if result <= 0 { break; }
                if message.message == HOTKEY && message.wparam == ID as usize && registered
                    && (message.lparam as usize & 0xffff) as u32 == MODIFIERS
                    && ((message.lparam as usize >> 16) & 0xffff) as u32 == KEY {
                    dispatch(&app, &control);
                } else if message.message != WAKE && message.message != TIMER {
                    // 此线程没有窗口；其它消息不被解释为任何业务动作。
                }
            }
            if registered && unsafe { UnregisterHotKey(std::ptr::null_mut(), ID) } == 0 {
                warning(&app, "AI 语音热键显式注销未确认，等待线程结束 / AI 語音快速鍵明確取消登記未確認，等待執行緒結束 / AI hotkey explicit unregistration is unconfirmed; waiting for thread exit");
            }
            unsafe { KillTimer(std::ptr::null_mut(), timer); }
            native_id.store(0, Ordering::Release);
        }).map_err(|_| unavailable())?;
        Ok(Self { thread: Some(thread), id, done })
    }
    pub fn wake(&self) {
        let thread = self.id.load(Ordering::Acquire);
        if thread != 0 { unsafe { PostThreadMessageW(thread, WAKE, 0, 0); } }
    }
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<bool> { self.done.subscribe() }
    pub fn join(mut self) -> Result<()> {
        self.thread.take().ok_or_else(unavailable)?.join().map_err(|_| unavailable())
    }
}

//! 当前进程权限查询。只读令牌，不申请提权，不启动外部命令。
#[cfg(windows)]
pub(super) fn is_elevated() -> Result<bool, String> {
    use std::{ffi::c_void, mem::size_of};
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    #[link(name = "advapi32")]
    extern "system" {
        fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
        fn GetTokenInformation(token: *mut c_void, class: i32, information: *mut c_void, length: u32, returned: *mut u32) -> i32;
    }
    struct Token(*mut c_void);
    impl Drop for Token { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
    #[repr(C)]
    struct Elevation { elevated: u32 }
    let failure = || "无法读取当前进程权限 / 無法讀取目前程序權限 / Unable to read current process privileges".to_owned();
    let mut token = std::ptr::null_mut();
    // TOKEN_QUERY = 0x0008；GetCurrentProcess 返回的伪句柄不应 CloseHandle。
    if unsafe { OpenProcessToken(GetCurrentProcess(), 0x0008, &mut token) } == 0 { return Err(failure()); }
    let token = Token(token);
    let mut elevation = Elevation { elevated: 0 };
    let mut returned = 0;
    // TokenElevation = 20，只取得一个 DWORD，不读取身份、组或其它令牌信息。
    if unsafe { GetTokenInformation(token.0, 20, (&mut elevation as *mut Elevation).cast(), size_of::<Elevation>() as u32, &mut returned) } == 0
        || returned != size_of::<Elevation>() as u32 { return Err(failure()); }
    Ok(elevation.elevated != 0)
}

#[cfg(all(unix, not(any(target_os = "android", target_os = "ios"))))]
pub(super) fn is_elevated() -> Result<bool, String> {
    extern "C" { fn geteuid() -> u32; }
    Ok(unsafe { geteuid() } == 0)
}

#[cfg(not(any(windows, all(unix, not(any(target_os = "android", target_os = "ios"))))))]
pub(super) fn is_elevated() -> Result<bool, String> {
    Err("当前平台不支持此联机权限查询 / 目前平台不支援此連線權限查詢 / Multiplayer privilege queries are unavailable on this platform".into())
}

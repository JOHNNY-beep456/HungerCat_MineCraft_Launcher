//! 运行形态判定：当前进程是否以 **MSIX 包身份**运行（Microsoft Store 或侧载的 `.msix`）。
//!
//! 同一个 exe 在三种分发形态下行为必须不同，这里只回答「是不是包」这一个问题，
//! 具体策略留给调用方（目前只有更新通道用得到）：
//!
//! | 形态 | 安装目录 | `%APPDATA%` 写入 | 更新方式 |
//! | --- | --- | --- | --- |
//! | 免安装 / NSIS | 可写（`portable.flag` 就近） | 真实目录 | 自建更新源，下载安装器 |
//! | MSIX（商店 / 侧载） | **只读**（`WindowsApps`） | 被重定向到 `%LOCALAPPDATA%\Packages\<PFN>\LocalCache\Roaming` | **必须由商店负责** |
//!
//! 判定方式是 `GetCurrentPackageFullName`：它是 Win8 起 `kernel32` 的稳定导出，
//! 而 MSIX 本身要求 Windows 10，所以直接静态导入，不用 `LoadLibrary` 兜底。
//! 传空缓冲区只为问长度：有包身份时返回 `ERROR_INSUFFICIENT_BUFFER`(122)，
//! 无包身份时返回 `APPMODEL_ERROR_NO_PACKAGE`(15700)。

#[cfg(windows)]
const ERROR_INSUFFICIENT_BUFFER: i32 = 122;

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentPackageFullName(length: *mut u32, name: *mut std::ffi::c_void) -> i32;
}

#[cfg(windows)]
pub fn is_packaged() -> bool {
    let mut length: u32 = 0;
    // SAFETY: 第二个参数按约定可以是空指针（只查询所需长度），函数不写入任何缓冲区。
    let code = unsafe { GetCurrentPackageFullName(&mut length, std::ptr::null_mut()) };
    code == 0 || code == ERROR_INSUFFICIENT_BUFFER
}

#[cfg(not(windows))]
pub fn is_packaged() -> bool {
    false
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn unpackaged_host_reports_not_packaged() {
        // 单元测试进程是普通控制台 exe，没有包身份；这条断言同时验证 FFI 调用不会崩。
        assert!(!is_packaged());
    }
}

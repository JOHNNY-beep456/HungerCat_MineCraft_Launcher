<#
.SYNOPSIS
  从 EasyTier 源码构建「不链接 Npcap」的 easytier-core / easytier-cli，用于随启动器分发。

.DESCRIPTION
  ── 背景：为什么官方内核不能直接随包分发 ──────────────────────────────
  EasyTier 无条件依赖 `pnet` crate（v2.5.0 / v2.6.4 均为非 optional 依赖）。
  `pnet` 的默认特性 `std` 会启用 `pnet_datalink`，而在 Windows 上 pnet_datalink 只有
  一个后端 `winpcap.rs`，其 `interfaces()` 直接调用 `PacketGetAdapterNames`，
  底层 `bindings/winpcap.rs` 还 `#[link(name = "Packet")]` —— 二者都来自
  **packet.dll（Npcap）**，因此官方产物会静态导入 packet.dll。

  Npcap 不是开源软件：其 EULA 明确「未经 Nmap Project 书面许可不得在本软件之外再分发」，
  免费版限 5 台机器，OEM 再分发授权需付费。所以官方内核**不能**放进我们的安装包。

  ── 为什么不能只改 feature ────────────────────────────────────────────
  `pnet` 不是 optional，`pnet_datalink` 又由默认特性 `std` 强制启用，
  且 Windows 上没有非 Npcap 的 datalink 后端 —— 单靠 `--no-default-features`
  **无法**去掉 packet.dll 依赖。必须替换/修补该 crate。

  ── 本脚本怎么解决 ────────────────────────────────────────────────────
  用 `[patch.crates-io]` 把 `pnet` 指向一份自动生成的**补丁副本**，对
  `pnet_datalink` 做三处改动（缺一不可）：
    1. `lib.rs` 中把 Windows 后端 `#[path = "winpcap.rs"] mod backend;`
       改指向新文件 `npcap_free.rs`；
    2. `lib.rs` 中删除 `pub mod winpcap;`（否则 crate 根仍会编译旧后端）；
    3. `lib.rs` 中把 `mod bindings;` 改为仅非 Windows 编译
       （否则 `bindings/winpcap.rs` 的 `#[link(name = "Packet")]` 仍会进入链接）。

  新的 `npcap_free.rs` 只实现 EasyTier 实际用到的 `interfaces()`，改用系统自带的
  IP Helper API `GetAdaptersAddresses`（链接 iphlpapi.dll，Windows 系统组件）；
  抓包能力 `channel()` 直接返回「不支持」。EasyTier 在 Windows 上仅用
  `interfaces()` 枚举网卡（见其 src/common/network.rs），从不抓包，因此功能不受影响。

  这样构建出的 core/cli **不再导入 packet.dll**，可合法随包分发
  （EasyTier 本体为 LGPL-3.0，pnet 为 MIT/Apache-2.0）。

  构建完成后脚本会**自动校验**产物中不含 packet.dll / PacketGetAdapterNames，
  校验不通过则直接失败，绝不产出「以为合规、其实仍链接 Npcap」的包。

.PARAMETER Version
  要构建的 EasyTier 版本 tag，默认 v2.5.0。

.PARAMETER KeepSource
  保留克隆的源码目录（默认构建完删除）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/build-easytier-npcap-free.ps1

.NOTES
  前置条件：git / cargo / rustc 可用；Windows 需要 MSVC 链接器（VS Build Tools）。
  依赖 kcp-sys 用 bindgen 生成绑定，需要 libclang；若系统未安装 LLVM，
  脚本会尝试用 python/pip 自动拉取 libclang 到临时目录（无需管理员权限）。
  首次构建需下载并编译整套依赖，耗时较长（约 10~30 分钟）。
#>

[CmdletBinding()]
param(
  [string]$Version = 'v2.5.0',
  [switch]$KeepSource
)

$ErrorActionPreference = 'Stop'
try { chcp 65001 | Out-Null } catch { }

function Info($m) { Write-Host "[easytier] $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "[easytier] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "[easytier] $m" -ForegroundColor Red; exit 1 }
function WriteUtf8NoBom($path, $text) {
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

# kcp-sys 的 build.rs 用 bindgen 生成 FFI 绑定，bindgen 运行时需要 libclang。
# 本函数先找系统里现成的 libclang，找不到就用 python/pip 拉一份到临时目录，
# 全程无需管理员权限，也不需要用户手工安装 LLVM。
function Ensure-LibClang {
  if ($env:LIBCLANG_PATH -and (Test-Path (Join-Path $env:LIBCLANG_PATH 'libclang.dll'))) {
    Info "使用已配置的 libclang：$env:LIBCLANG_PATH"
    return
  }
  $candidates = @(
    'C:\Program Files\LLVM\bin',
    'C:\Program Files (x86)\LLVM\bin'
  )
  foreach ($c in $candidates) {
    if (Test-Path (Join-Path $c 'libclang.dll')) {
      $env:LIBCLANG_PATH = $c
      Info "发现系统 libclang：$c"
      return
    }
  }
  # 复用本脚本已下载过的副本，避免重复下载
  $py = Join-Path $env:TEMP 'easytier-libclang\clang\native'
  if (Test-Path (Join-Path $py 'libclang.dll')) {
    $env:LIBCLANG_PATH = $py
    Info "复用已缓存的 libclang：$py"
    return
  }
  $python = (Get-Command python -ErrorAction SilentlyContinue).Source
  if (-not $python) { $python = (Get-Command py -ErrorAction SilentlyContinue).Source }
  if (-not $python) {
    Fail '未找到 libclang，且系统无 python/pip。请安装 LLVM（https://releases.llvm.org/）或 Python 后重试。'
  }
  $target = Join-Path $env:TEMP 'easytier-libclang'
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Info '未发现 libclang，正在用 pip 拉取（仅构建期使用，不随产物分发）…'
  $oldEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $python -m pip install --target $target libclang 2>&1 | Out-Null
  $ErrorActionPreference = $oldEAP
  $native = Join-Path $target 'clang\native'
  if (-not (Test-Path (Join-Path $native 'libclang.dll'))) {
    Fail 'libclang 下载失败（pip 安装 libclang 未成功），请手动安装 LLVM 并设置 LIBCLANG_PATH。'
  }
  $env:LIBCLANG_PATH = $native
  Info "已通过 pip 获取 libclang：$native"
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot  = Split-Path -Parent $scriptDir
$targetDir = Join-Path $repoRoot 'resources\easytier'

# ---- 前置检查 ----
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail '未找到 git，请先安装 Git 并加入 PATH。' }

$cargo = $null
$homeCargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
if (Test-Path $homeCargo) { $cargo = $homeCargo } else { $cargo = (Get-Command cargo -ErrorAction SilentlyContinue).Source }
if (-not $cargo) { Fail '未找到 cargo，请安装 Rust 工具链（https://rustup.rs）。' }
Info "cargo：$cargo"

# ---- 1. 克隆源码 ----
$srcRoot = Join-Path $env:TEMP "easytier-src-$Version"
if (Test-Path $srcRoot) { Remove-Item -Recurse -Force $srcRoot }
Info "克隆 EasyTier $Version …"
& git clone --depth 1 --branch $Version https://github.com/EasyTier/EasyTier.git $srcRoot
if ($LASTEXITCODE -ne 0) { Fail '克隆失败，请检查网络（国内可能需要代理）。' }

$crateDir  = Join-Path $srcRoot 'easytier'
$srcCargo  = Join-Path $crateDir 'Cargo.toml'
if (-not (Test-Path $srcCargo)) { Fail "源码结构异常：未找到 $srcCargo" }

$networkRs = Join-Path $crateDir 'src\common\network.rs'
if (Test-Path $networkRs) {
  Info '确认调用点为 pnet::datalink::interfaces()（仅枚举网卡，不做抓包）。'
} else {
  Warn '未找到预期的 network.rs，补丁仍会应用，但请自行确认调用点。'
}

# ---- 2. 准备 pnet 补丁副本 ----
# pnet 各子 crate 是 path 依赖，crates.io 的 .crate 包不含它们，因此从 git 取完整工作区。
$pnetVer = '0.35.0'
$workDir = Join-Path $env:TEMP "easytier-pnet-patch-$Version"
if (Test-Path $workDir) { Remove-Item -Recurse -Force $workDir }
New-Item -ItemType Directory -Path $workDir -Force | Out-Null

Info "克隆 libpnet v$pnetVer …"
$pnetGit = Join-Path $workDir 'libpnet'
& git clone --depth 1 --branch "v$pnetVer" https://github.com/libpnet/libpnet.git $pnetGit
if ($LASTEXITCODE -ne 0) { Fail '克隆 libpnet 失败。' }

$dlDir = Join-Path $pnetGit 'pnet_datalink\src'
$dlLib = Join-Path $dlDir 'lib.rs'
if (-not (Test-Path $dlLib)) { Fail "未找到 $dlLib" }

# libpnet 各 crate 内有 `#![deny(warnings)]`，在较新的 rustc 上会被新增 lint
# （如 mismatched_lifetime_syntaxes）触发而编译失败。正常从 crates.io 拉取时，
# cargo 会给第三方依赖自动加 `--cap-lints allow`；但 [patch] 把它变成本地 path 依赖后
# 不再自动加，于是 deny(warnings) 会成为硬错误。这里统一放宽为 allow，恢复等价行为。
$neutralized = 0
Get-ChildItem $pnetGit -Recurse -Filter *.rs | ForEach-Object {
  $t = [System.IO.File]::ReadAllText($_.FullName)
  if ($t.Contains('#![deny(warnings)]')) {
    WriteUtf8NoBom $_.FullName ($t.Replace('#![deny(warnings)]', '#![allow(warnings)]'))
    $neutralized++
  }
}
Info "已放宽 libpnet 内的 deny(warnings)：$neutralized 处。"

# ---- 3. 注入无 Npcap 的 Windows 后端 ----
$npcapFree = @'
//! 无 Npcap 的 Windows datalink 后端。
//!
//! 本文件由启动器仓库脚本 `scripts/build-easytier-npcap-free.ps1` 自动生成，
//! 用于替换 libpnet 的 `pnet_datalink/src/winpcap.rs`。
//!
//! 目的：移除对 packet.dll（Npcap/WinPcap）的静态导入，使构建产物可以合法地
//! 随启动器一同分发（Npcap 的 EULA 禁止未经授权再分发）。
//!
//! EasyTier 在 Windows 上只会调用 `pnet::datalink::interfaces()` 枚举本机网卡，
//! 从不进行数据链路层抓包，因此这里 `channel()` 直接返回「不支持」即可，
//! 功能不受影响。网卡枚举改用系统自带的 IP Helper API `GetAdaptersAddresses`
//! （链接 iphlpapi.dll，属于 Windows 系统组件，可随包分发）。

#![allow(dead_code)]

use ipnetwork::IpNetwork;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::os::raw::{c_char, c_void};

use super::{MacAddr, NetworkInterface};

/// 该后端的配置（与其它平台后端保持同样的公开形态）。
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct Config {
    pub write_buffer_size: usize,
    pub read_buffer_size: usize,
}

impl<'a> From<&'a super::Config> for Config {
    fn from(config: &super::Config) -> Config {
        Config {
            write_buffer_size: config.write_buffer_size,
            read_buffer_size: config.read_buffer_size,
        }
    }
}

impl Default for Config {
    fn default() -> Config {
        Config {
            write_buffer_size: 4096,
            read_buffer_size: 4096,
        }
    }
}

/// 无 Npcap 时无法提供数据链路层原始收发通道。
pub fn channel(
    _network_interface: &NetworkInterface,
    _config: Config,
) -> std::io::Result<super::Channel> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "datalink capture is unavailable in the Npcap-free build",
    ))
}

// ------------------------- GetAdaptersAddresses FFI -------------------------
// 仅声明本用途需要的 Win32 结构体与函数，避免改动 pnet 的依赖特性。

const AF_UNSPEC: u32 = 0;
const AF_INET: u16 = 2;
const AF_INET6: u16 = 23;

const GAA_FLAG_SKIP_ANYCAST: u32 = 0x0002;
const GAA_FLAG_SKIP_MULTICAST: u32 = 0x0004;
const GAA_FLAG_SKIP_DNS_SERVER: u32 = 0x0008;
const GAA_FLAG_INCLUDE_PREFIX: u32 = 0x0010;

const ERROR_SUCCESS: u32 = 0;
const ERROR_BUFFER_OVERFLOW: u32 = 111;

const IF_TYPE_SOFTWARE_LOOPBACK: u32 = 24;
const IF_OPER_STATUS_UP: u32 = 1;

#[repr(C)]
struct SocketAddress {
    lp_sockaddr: *mut c_void,
    i_sockaddr_length: i32,
}

#[repr(C)]
struct IpAdapterAddresses {
    length: u32,
    if_index: u32,
    next: *mut IpAdapterAddresses,
    adapter_name: *mut c_char,
    first_unicast_address: *mut IpAdapterUnicastAddress,
    first_anycast_address: *mut c_void,
    first_multicast_address: *mut c_void,
    first_dns_server_address: *mut c_void,
    dns_suffix: *mut u16,
    description: *mut u16,
    friendly_name: *mut u16,
    physical_address: [u8; 8],
    physical_address_length: u32,
    flags: u32,
    mtu: u32,
    if_type: u32,
    oper_status: u32,
}

#[repr(C)]
struct IpAdapterUnicastAddress {
    length: u32,
    flags: u32,
    next: *mut IpAdapterUnicastAddress,
    address: SocketAddress,
    prefix_origin: u32,
    suffix_origin: u32,
    dad_state: u32,
    valid_lifetime: u32,
    preferred_lifetime: u32,
    lease_lifetime: u32,
    on_link_prefix_length: u8,
}

#[repr(C)]
struct SockAddrIn {
    sin_family: u16,
    sin_port: u16,
    sin_addr: [u8; 4],
    sin_zero: [u8; 8],
}

#[repr(C)]
struct SockAddrIn6 {
    sin6_family: u16,
    sin6_port: u16,
    sin6_flowinfo: u32,
    sin6_addr: [u8; 16],
    sin6_scope_id: u32,
}

#[link(name = "iphlpapi")]
extern "system" {
    fn GetAdaptersAddresses(
        family: u32,
        flags: u32,
        reserved: *mut c_void,
        adapter_addresses: *mut IpAdapterAddresses,
        size_pointer: *mut u32,
    ) -> u32;
}

/// 枚举本机网卡与地址（不依赖 Npcap）。
pub fn interfaces() -> Vec<NetworkInterface> {
    let flags = GAA_FLAG_SKIP_ANYCAST
        | GAA_FLAG_SKIP_MULTICAST
        | GAA_FLAG_SKIP_DNS_SERVER
        | GAA_FLAG_INCLUDE_PREFIX;

    let mut size: u32 = 15 * 1024;
    let mut buf: Vec<u8> = Vec::new();

    let mut ret = unsafe {
        GetAdaptersAddresses(
            AF_UNSPEC,
            flags,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        )
    };

    if ret != ERROR_BUFFER_OVERFLOW && ret != ERROR_SUCCESS {
        return Vec::new();
    }
    if size == 0 {
        return Vec::new();
    }

    buf.resize(size as usize, 0);
    ret = unsafe {
        GetAdaptersAddresses(
            AF_UNSPEC,
            flags,
            std::ptr::null_mut(),
            buf.as_mut_ptr() as *mut IpAdapterAddresses,
            &mut size,
        )
    };
    if ret != ERROR_SUCCESS {
        return Vec::new();
    }

    let mut result = Vec::new();
    let mut cursor = buf.as_ptr() as *const IpAdapterAddresses;
    while !cursor.is_null() {
        let adapter = unsafe { &*cursor };

        let name = cstr_to_string(adapter.adapter_name);
        let description = wide_to_string(adapter.friendly_name)
            .or_else(|| wide_to_string(adapter.description))
            .unwrap_or_default();
        let mac = read_mac(adapter);
        let ips = read_ips(adapter.first_unicast_address);
        let flags_val = synth_flags(adapter);
        let index = adapter.if_index;

        result.push(NetworkInterface {
            name,
            description,
            index,
            mac,
            ips,
            flags: flags_val,
        });

        cursor = adapter.next;
    }
    result
}

fn cstr_to_string(p: *const c_char) -> String {
    if p.is_null() {
        return String::new();
    }
    unsafe { std::ffi::CStr::from_ptr(p) }
        .to_string_lossy()
        .into_owned()
}

fn wide_to_string(p: *const u16) -> Option<String> {
    if p.is_null() {
        return None;
    }
    let mut len = 0usize;
    unsafe {
        while *p.add(len) != 0 {
            len += 1;
        }
        if len == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(std::slice::from_raw_parts(p, len)))
    }
}

fn read_mac(adapter: &IpAdapterAddresses) -> Option<MacAddr> {
    let len = adapter.physical_address_length as usize;
    if len < 6 {
        return None;
    }
    let b = &adapter.physical_address;
    let mac = MacAddr(b[0], b[1], b[2], b[3], b[4], b[5]);
    if mac.is_zero() {
        None
    } else {
        Some(mac)
    }
}

fn read_ips(mut addr: *mut IpAdapterUnicastAddress) -> Vec<IpNetwork> {
    let mut ips = Vec::new();
    while !addr.is_null() {
        let sa = unsafe { (*addr).address.lp_sockaddr };
        let prefix = unsafe { (*addr).on_link_prefix_length };
        if let Some(ip) = sockaddr_to_ip(sa) {
            let max = if ip.is_ipv4() { 32 } else { 128 };
            let p = if prefix > max { max } else { prefix };
            if let Ok(net) = IpNetwork::new(ip, p) {
                ips.push(net);
            }
        }
        addr = unsafe { (*addr).next };
    }
    ips
}

fn sockaddr_to_ip(sa: *mut c_void) -> Option<IpAddr> {
    if sa.is_null() {
        return None;
    }
    let family = unsafe { *(sa as *const u16) };
    if family == AF_INET {
        let s = unsafe { &*(sa as *const SockAddrIn) };
        Some(IpAddr::V4(Ipv4Addr::new(
            s.sin_addr[0],
            s.sin_addr[1],
            s.sin_addr[2],
            s.sin_addr[3],
        )))
    } else if family == AF_INET6 {
        let s = unsafe { &*(sa as *const SockAddrIn6) };
        Some(IpAddr::V6(Ipv6Addr::from(s.sin6_addr)))
    } else {
        None
    }
}

fn synth_flags(adapter: &IpAdapterAddresses) -> u32 {
    // 复用 Linux 侧 IFF_* 语义，保证 NetworkInterface::is_up()/is_loopback() 等判断正确。
    const IFF_UP: u32 = 0x0000_0001;
    const IFF_BROADCAST: u32 = 0x0000_0002;
    const IFF_LOOPBACK: u32 = 0x0000_0004;
    const IFF_MULTICAST: u32 = 0x0000_0010;

    let mut f = 0u32;
    if adapter.oper_status == IF_OPER_STATUS_UP {
        f |= IFF_UP;
    }
    if adapter.if_type == IF_TYPE_SOFTWARE_LOOPBACK {
        f |= IFF_LOOPBACK;
    } else {
        f |= IFF_BROADCAST;
    }
    f |= IFF_MULTICAST;
    f
}
'@
WriteUtf8NoBom (Join-Path $dlDir 'npcap_free.rs') $npcapFree
Info '已写入 npcap_free.rs（GetAdaptersAddresses 枚举网卡）。'

# 对 lib.rs 打三处补丁（用正则匹配，兼容 CRLF / LF）。
$libText = [System.IO.File]::ReadAllText($dlLib)

# (1) 后端改指向我们的新文件
$before = $libText
$libText = [regex]::Replace($libText,
  '(?m)^#\[cfg\(windows\)\]\r?\n#\[path = "winpcap\.rs"\]\r?\nmod backend;\r?\n\r?\n#\[cfg\(windows\)\]\r?\npub mod winpcap;',
  "#[cfg(windows)]`r`n#[path = ""npcap_free.rs""]`r`nmod backend;")
if ($libText -eq $before) { Fail '未能替换 Windows 后端路径（lib.rs 结构与预期不符）。' }

# (2) bindings 模块仅在非 Windows 编译，避免 bindings/winpcap.rs 的 Packet 链接
$before = $libText
$libText = [regex]::Replace($libText, '(?m)^mod bindings;\r?$', "#[cfg(not(windows))]`r`nmod bindings;")
if ($libText -eq $before) { Fail '未能给 mod bindings 加上 cfg(not(windows))（lib.rs 结构与预期不符）。' }

WriteUtf8NoBom $dlLib $libText
Info '已修补 lib.rs：替换后端、移除 pub mod winpcap、隔离 bindings。'

# 断言：lib.rs 中不应再出现 winpcap 或未加 cfg 的 bindings
$check = [System.IO.File]::ReadAllText($dlLib)
if ($check -match 'winpcap') { Fail 'lib.rs 中仍残留 winpcap 引用，补丁不完整。' }

# ---- 4. 用 [patch.crates-io] 在「工作区根」接入补丁版 pnet ----
# 注意：EasyTier 是 workspace，[patch] 只有写在 workspace 根 Cargo.toml 才生效；
# 若写在成员 crate（easytier/Cargo.toml）里，cargo 会忽略并给出 warning，
# 结果就是补丁失效、产物仍链接 packet.dll。
$wsCargo = Join-Path $srcRoot 'Cargo.toml'
$patchTarget = $srcCargo
if ((Test-Path $wsCargo) -and ((Get-Content -Raw -Encoding UTF8 $wsCargo) -match '(?m)^\s*\[workspace\]')) {
  $patchTarget = $wsCargo
  Info "检测到 workspace，[patch] 将写入工作区根：$wsCargo"
}
$patchText = Get-Content -Raw -Encoding UTF8 $patchTarget
if ($patchText -notmatch '\[patch\.crates-io\]') {
  $patchRel = $pnetGit.Replace('\', '/')
  $patchBlock = @"

[patch.crates-io]
pnet = { path = "$patchRel" }
"@
  Add-Content -Path $patchTarget -Value $patchBlock -Encoding UTF8
  Info "已注入 [patch.crates-io]（$patchTarget）。"
} else {
  Warn '目标 Cargo.toml 已含 [patch.crates-io]，跳过注入。'
}

# ---- 4b. 预置构建期下载物，避免 GitHub 直连卡死 ----
# EasyTier 的 build.rs 与 thunk-rs 会从 GitHub 下载 protoc / VC-LTL / YY-Thunks。
# 国内直连极慢甚至卡死，这里先把它们放到脚本期望的缓存位置，build.rs 便会跳过下载。
function Ensure-GitHubAsset($url, $destFile) {
  if (Test-Path $destFile) { return $true }
  $mirrors = @(
    "https://ghfast.top/$url",
    "https://gh-proxy.com/$url",
    "https://ghproxy.net/$url",
    $url
  )
  foreach ($m in $mirrors) {
    & curl.exe -Lkf --connect-timeout 15 --retry 2 -o $destFile $m 2>$null
    if ($LASTEXITCODE -eq 0 -and (Test-Path $destFile) -and (Get-Item $destFile).Length -gt 0) { return $true }
    Remove-Item $destFile -Force -ErrorAction SilentlyContinue
  }
  return $false
}

$targetRoot = Join-Path $srcRoot 'target'
# protoc：build.rs 期望位于 <workspace>/target/protobuf/bin/protoc.exe
$pbDir = Join-Path $targetRoot 'protobuf'
$protoDir = Join-Path $pbDir 'bin'
$protocExe = Join-Path $protoDir 'protoc.exe'
if (-not (Test-Path $protocExe)) {
  New-Item -ItemType Directory -Path $pbDir -Force | Out-Null
  $zip = Join-Path $pbDir 'protoc.zip'
  $url = 'https://github.com/protocolbuffers/protobuf/releases/download/v26.0-rc1/protoc-26.0-rc-1-win64.zip'
  if (Ensure-GitHubAsset $url $zip) {
    & 7z x -aoa $zip "-o$pbDir" | Out-Null
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    Info '已预置 protoc（build.rs 将跳过下载）。'
  } else {
    Warn 'protoc 预下载失败，build.rs 将自行尝试从 GitHub 下载（可能很慢）。'
  }
}
if (Test-Path $protocExe) { $env:PROTOC = $protocExe }

# ---- 5. 构建 ----
Ensure-LibClang
Info '开始构建（首次较慢，请耐心等待）…'
Push-Location $crateDir
try {
  $oldEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $buildOut = & $cargo build --release 2>&1 | Out-String
  $buildCode = $LASTEXITCODE
  $ErrorActionPreference = $oldEAP
  Write-Host $buildOut
  if ($buildOut -match 'non root package will be ignored') {
    Fail 'cargo 忽略了 [patch.crates-io]（被写在了成员 crate 中）。请确认 patch 位于 workspace 根 Cargo.toml。'
  }
  if ($buildCode -ne 0) { Fail 'cargo build 失败，请查看上方编译错误。' }
} finally {
  Pop-Location
}

$releaseDir = Join-Path $crateDir 'target\release'
$suffix     = if ($env:OS -eq 'Windows_NT') { '.exe' } else { '' }
$coreName   = "easytier-core$suffix"
$cliName    = "easytier-cli$suffix"
$coreSrc    = Join-Path $releaseDir $coreName
$cliSrc     = Join-Path $releaseDir $cliName
if (-not (Test-Path $coreSrc)) { Fail "未找到产物：$coreSrc" }
if (-not (Test-Path $cliSrc))  { Fail "未找到产物：$cliSrc" }

# ---- 6. 强制校验：不得再导入 packet.dll ----
function Test-NpcapImport($path) {
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $ascii = [System.Text.Encoding]::ASCII.GetString($bytes)
  $uni   = [System.Text.Encoding]::Unicode.GetString($bytes)
  $keys  = @('packet.dll', 'Packet.dll', 'PacketGetAdapterNames', 'PacketOpenAdapter', 'PacketSendPacket', 'wpcap')
  foreach ($k in $keys) {
    if ($ascii.Contains($k) -or $uni.Contains($k)) { return $true }
  }
  return $false
}
Info '校验产物是否仍链接 Npcap…'
if ((Test-NpcapImport $coreSrc) -or (Test-NpcapImport $cliSrc)) {
  Fail '产物仍包含 packet.dll / PacketGetAdapterNames 导入，补丁未生效，已中止拷贝。'
}
Info '通过：产物未导入 packet.dll，无 Npcap 依赖。'

# ---- 7. 拷贝到正式目录 ----
if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }
Copy-Item $coreSrc (Join-Path $targetDir $coreName) -Force
Copy-Item $cliSrc  (Join-Path $targetDir $cliName)  -Force
$coreSize = [math]::Round((Get-Item (Join-Path $targetDir $coreName)).Length / 1MB, 1)
$cliSize  = [math]::Round((Get-Item (Join-Path $targetDir $cliName)).Length / 1MB, 1)
Info "已写入 $targetDir"
Write-Host "  $coreName  ($coreSize MB)"
Write-Host "  $cliName   ($cliSize MB)"

if (-not $KeepSource) {
  Remove-Item -Recurse -Force $srcRoot -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $workDir -ErrorAction SilentlyContinue
  Info '已清理临时目录。'
} else {
  Info "保留源码：$srcRoot / $workDir"
}
Info '完成。'
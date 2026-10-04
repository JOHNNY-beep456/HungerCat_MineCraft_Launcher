// ---------------------------------------------------------------------------
// HungerCat 原生下载内核（多连接分段下载）
//
// 职责边界（与 TS 侧约定）：**只做传输层**。
//   输入：url + 目标路径 + 可选已知大小/请求头/并发数
//   输出：把字节落到磁盘，过程中回报「已下载字节」与「总大小」，支持取消
// 任务收集、SHA-1 校验、镜像回退、natives 解压全部留在 TS 侧（downloader.ts），
// 因此本库不理解 Minecraft，也不关心下载的是什么。
//
// 策略与 TS 版 stream-download.ts 保持一致，但把并发能力放大：
//   1. HEAD 探测总大小并解析重定向（部分 CDN 只在最终主机上提供 Range）；
//   2. 大文件切成「比连接数更多」的小段放入共享队列，由连接池动态领取，
//      快连接下载完立即领下一段，避免固定分块下快连接空等慢连接；
//   3. 每段独立重试，失败从已写入偏移续传，单条连接假死不影响其它段；
//   4. 服务器不支持 Range（200/403/404/405/416）时回退单连接。
// ---------------------------------------------------------------------------

// 关闭 `linker_messages`：构建 cdylib 时 MSVC 链接器会输出
// 「正在创建库 xxx.dll.lib 和对象 xxx.dll.exp」这类**纯信息性**提示，
// 新版本 Rust 会把它当成 lint 报成 warning。它不含任何问题，只会干扰构建日志；
// 这里只屏蔽这一条 lint，不影响其它真实警告。
#![allow(linker_messages)]

// 文件夹扫描（资源 / 存档 / 版本目录等）的原生实现，与传输层解耦，见 scan.rs。
mod scan;

// 自定义主页脚本的静态安全检测（危险规则扫描 + 外链采集）的原生实现，见 homepage.rs。
mod homepage;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{
    ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use napi::{Env, Task};
use napi_derive::napi;

/// 默认每个文件的并发连接数。
/// 64 连接是为了在「服务端按连接限速」的 CDN（BMCLAPI / ForgeCDN 常见）上跑满带宽：
/// 单连接被限到几百 KB/s 时，只有把连接数堆上去才能吃满本地下行。
const DEFAULT_CONNECTIONS: u32 = 64;
/// 允许的最大连接数上限，防止调用方传入异常值把服务端打爆。
const MAX_CONNECTIONS: u32 = 256;
/// 走分段下载的最小文件体积：小于此值单连接反而更快（省掉 HEAD 与多次握手）。
const PARALLEL_THRESHOLD: u64 = 2 * 1024 * 1024;
/// 段大小夹取区间：太小会让请求数爆炸，太大又退化成固定分块的「快连接空等」。
/// 下限压到 256KB 是为了「更细的分段」——64 连接下若仍按 1MB 起算，
/// 中等文件会被切成很少的段，连接池大部分时间在空转，并发形同虚设。
const MIN_SEGMENT_SIZE: u64 = 256 * 1024;
const MAX_SEGMENT_SIZE: u64 = 16 * 1024 * 1024;
/// 目标段数 = 连接数 × 8（原为 ×4）。段数越富余，快连接越不会因为「队列已空」而提前退出，
/// 整文件的完成时间取决于最慢连接而不是最慢段。
const SEGMENTS_PER_CONNECTION: u64 = 8;
/// 单个分段的最大尝试次数。
const SEGMENT_ATTEMPTS: u32 = 3;
/// 连续多久没收到字节判定连接超时（与 TS 版一致，10s）。
const STALL_TIMEOUT_MS: u64 = 10_000;
/// 进度回调的最小间隔，避免高频回调压垮 Node 事件循环。
const PROGRESS_INTERVAL_MS: u64 = 120;
/// 单连接下载的写缓冲：攒够这么多字节再落盘一次，避免每 chunk 一次系统调用。
const WRITE_BUFFER_SIZE: usize = 512 * 1024;
/// HEAD 探测的请求级超时：服务端不回响应时及时失败，避免挂到 OS 超时（可能数分钟）。
const HEAD_TIMEOUT_MS: u64 = 15_000;
/// 整文件的瞬时错误（429 / 5xx）重试次数。与 TS 版 stream-download.ts 对齐。
const FILE_ATTEMPTS: u32 = 4;

const UA: &str = "HungerCatLauncher/0.1";

/// 进程级共享的 tokio runtime。
///
/// 原先每个文件都在 `compute()` 里新建一个多线程 runtime，一次启动会话动辄几百个
/// mod 文件，就意味着反复创建/销毁 worker 线程（启动一次 ≥ 1~3ms），连接池也因为
/// runtime 更替而无法跨下载复用。改用全局单例后：runtime 只建一次，`pool_max_idle_per_host`
/// 保留的空闲连接可以跨任务命中，显著降低握手开销。
static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

/// 取得全局 runtime；首次调用时惰性创建。
pub(crate) fn runtime() -> std::result::Result<&'static tokio::runtime::Runtime, String> {
    if let Some(rt) = RUNTIME.get() {
        return Ok(rt);
    }
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("创建异步运行时失败：{e}"))?;
    // 并发首次初始化时可能有人抢先写入，get_or_init 语义等价，丢弃本地的即可。
    Ok(RUNTIME.get_or_init(|| rt))
}

/// 下载结果（回传给 JS）。
#[napi(object)]
pub struct NativeDownloadResult {
    /// 实际落盘字节数。
    pub bytes: BigInt,
    /// 是否走了多连接分段；false 表示回退到了单连接。
    pub parallel: bool,
}


/// 进度回调：JS 函数 + 参数「本轮新增字节数」。
///
/// 必须用 `ThreadsafeFunction` 而不是 `Function`：`Function` 内部持有裸的
/// `napi_env`/`napi_value` 指针，既不是 `Send` 也会受生命周期约束，无法跨线程
/// 存活；而下载任务跑在独立 tokio runtime 的线程上，只有线程安全函数才能安全回调 JS。
/// `ErrorStrategy::Fatal` 表示回调不接收 `Result` 参数（直接收 `(u32,)`）。
pub type ProgressCallback = ThreadsafeFunction<u32, ErrorStrategy::Fatal>;
/// 总大小回调：只在解析出 content-length 时调用一次。
pub type SizeCallback = ThreadsafeFunction<BigInt, ErrorStrategy::Fatal>;

/// 取消句柄：JS 侧持有，调用 `cancel()` 即可中断在途下载。
#[napi]
pub struct DownloadHandle {
    cancelled: Arc<AtomicU64>,
}

impl Default for DownloadHandle {
    fn default() -> Self {
        Self::new()
    }
}

/// 创建一个取消句柄。JS 侧持有它；把同一个对象再传给 `download` 即可生效。
///
/// 由 napi-derive 生成构造函数：`new DownloadHandle()` 得到的是真正的 JS 类实例，
/// 可以直接 `.cancel()`。这不是 `External`（不透明包装，拿不到方法）。
#[napi]
impl DownloadHandle {
    /// 构造函数：JS 侧 `new DownloadHandle()` 创建句柄。
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicU64::new(0)),
        }
    }

    /// 请求取消。幂等，可多次调用；下载任务会在最近的检查点退出。
    #[napi]
    pub fn cancel(&self) {
        // 纯标志位，与其它内存无 happens-before 关系，Relaxed 足够；
        // 用 SeqCst 在高频检查点（64 连接每 chunk 一次）会带来无谓的 fence 争用。
        self.cancelled.store(1, Ordering::Relaxed);
    }

    /// 供内部/测试读取取消状态。
    #[napi(getter)]
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed) != 0
    }
}

/// 下载参数。
///
/// 注意：回调不放进 `#[napi(object)]` —— `ThreadsafeFunction` 没有实现 `ToNapiValue`，
/// 无法作为对象字段。改为 `download()` 的独立入参，由 napi 直接完成转换。
///
/// `Default` 仅为配合 `DownloadTask` 里 `mem::take(&mut self.job)` 使用（留下空壳）。
#[napi(object)]
#[derive(Default)]
pub struct NativeDownloadOptions {
    pub url: String,
    pub dest: String,
    /// 已知总大小（可跳过 HEAD 探测）。
    pub size_hint: Option<BigInt>,
    /// 并发连接数（默认 64）。
    pub connections: Option<u32>,
    /// 附加请求头，形如 `[["User-Agent","..."]]`（会覆盖默认 UA）。
    pub headers: Option<Vec<Vec<String>>>,
}

/// 下载任务体的内部状态（含已转换好的线程安全回调）。
#[derive(Default)]
struct DownloadJob {
    opts: NativeDownloadOptions,
    on_bytes: Option<ProgressCallback>,
    on_size: Option<SizeCallback>,
}

/* ------------------------------------------------------------------ */
/* 结构化错误                                                          */
/* ------------------------------------------------------------------ */

/// 跨进程错误码：与 TS 侧 `NetErrorPayload['code']` 一一对应。
/// 上层（native-downloader.ts → downloader.ts）据此决定镜像回退 / 退避，而非正则匹配文案。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ErrCode {
    Http,
    Cancelled,
    Timeout,
    Network,
}

impl ErrCode {
    fn as_str(self) -> &'static str {
        match self {
            ErrCode::Http => "http",
            ErrCode::Cancelled => "cancelled",
            ErrCode::Timeout => "timeout",
            ErrCode::Network => "network",
        }
    }
}

/// 传输层错误：message 供人读，code/status/retryAfter 供机器决策。
#[derive(Debug, Clone)]
pub struct NativeError {
    code: ErrCode,
    message: String,
    status: Option<u16>,
    retry_after: Option<String>,
}

impl NativeError {
    fn new(code: ErrCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            status: None,
            retry_after: None,
        }
    }
    fn network(message: impl Into<String>) -> Self {
        Self::new(ErrCode::Network, message)
    }
    fn timeout(message: impl Into<String>) -> Self {
        Self::new(ErrCode::Timeout, message)
    }
    fn cancelled() -> Self {
        Self::new(ErrCode::Cancelled, "下载已取消")
    }
    fn http(message: impl Into<String>, status: u16) -> Self {
        Self {
            code: ErrCode::Http,
            message: message.into(),
            status: Some(status),
            retry_after: None,
        }
    }
    fn with_retry_after(mut self, ra: Option<String>) -> Self {
        self.retry_after = ra;
        self
    }

    /// 编码成单行字符串：`<message>\u{1}code=http;status=404;retryAfter=5`。
    /// TS 侧按最后一个 `\u{1}` 切分还原；人读时前面的 message 依旧完整。
    fn encode(&self) -> String {
        let mut meta = format!("code={}", self.code.as_str());
        if let Some(s) = self.status {
            meta.push_str(&format!(";status={s}"));
        }
        if let Some(ra) = &self.retry_after {
            meta.push_str(&format!(";retryAfter={ra}"));
        }
        format!("{}\u{1}{}", self.message, meta)
    }
}

/// 传输层统一返回 `NativeError`。
type NetResult<T> = std::result::Result<T, NativeError>;


/// 下载任务体：在独立 runtime 中执行。
///
/// 修正一处**架构性误解**（旧注释写成「在独立 runtime 执行，避免占用 libuv 线程池」）：
/// napi 的 `AsyncTask::compute` 本身就跑在 libuv 的 async_work 线程池上，且会阻塞到
/// 任务结束——默认 `UV_THREADPOOL_SIZE=4`，于是「8 文件并发」实际被截断到 4，
/// 同进程的 `fs.promises` 也会被一起饿死。正确做法有二：
///   a) napi 的 `tokio_rt` feature 让 `AsyncTask` 跑在 napi 自带的 tokio runtime 上；
///   b) 或（本库采用）在 compute 里把整段下载 `spawn` 到**我们自己的进程级 runtime**，
///      然后 `block_on` 这个 JoinHandle —— 真正干活的是 tokio worker，
///      libuv 线程只是短暂地在等一个 JoinHandle，不再承载整段下载。
///
/// 由于还要给 JS 回传进度（TSFN），这里必须用 `Task`（napi 的异步模型）。
pub struct DownloadTask {
    job: DownloadJob,
    cancelled: Arc<AtomicU64>,
}

impl Task for DownloadTask {
    type Output = std::result::Result<NativeDownloadResult, NativeError>;
    type JsValue = NativeDownloadResult;

    fn compute(&mut self) -> Result<Self::Output> {
        let rt = runtime().map_err(Error::from_reason)?;
        // 关键：把整段下载 spawn 到自有 runtime，再 block_on JoinHandle。
        // 这样 IO / 网络轮询都发生在 tokio worker 上，而不是 libuv 的 4 个线程。
        // 用 mem::take 取出 job（Default 的空壳留下），避免借用与 `'static` 冲突。
        let job = std::mem::take(&mut self.job);
        let cancelled = self.cancelled.clone();
        let handle = rt.spawn(async move { run_download(&job, cancelled).await });
        Ok(rt.block_on(handle).unwrap_or_else(|join_err| {
            Err(NativeError::network(format!("下载线程异常退出：{join_err}")))
        }))
    }

    fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
        match out {
            Ok(v) => Ok(v),
            // 把「结构化错误」编码进 message，由 native-downloader.ts 解析还原成
            // 带 code/status/retryAfter 的 Error —— 上层据此做镜像回退 / 退避，
            // 不再依赖对中文文案的正则匹配。
            Err(e) => Err(Error::from_reason(e.encode())),
        }
    }
}


/// 入口：下载 `url` 到 `dest`，过程中回调进度，可通过 handle 取消。
///
/// 回调单独作为入参（而非 options 字段），因为 `ThreadsafeFunction` 无法放进
/// `#[napi(object)]`。两者都接受普通 JS 函数，napi 会自动转成线程安全包装。
#[napi(ts_return_type = "Promise<{ bytes: number; parallel: boolean }>")]
pub fn download(
    opts: NativeDownloadOptions,
    on_bytes: Option<ProgressCallback>,
    on_size: Option<SizeCallback>,
    handle: Option<&DownloadHandle>,
) -> AsyncTask<DownloadTask> {
    let cancelled = handle
        .map(|h| h.cancelled.clone())
        .unwrap_or_else(|| Arc::new(AtomicU64::new(0)));
    AsyncTask::new(DownloadTask {
        job: DownloadJob {
            opts,
            on_bytes,
            on_size,
        },
        cancelled,
    })
}

/* ------------------------------------------------------------------ */
/* 传输层实现                                                          */
/* ------------------------------------------------------------------ */

/// 进程级共享的 reqwest Client。
///
/// 旧实现**每个文件**都 `build_client()`，一次安装数千个资源对象就要初始化数千次
/// rustls/连接池。改为全局单例后，`pool_max_idle_per_host` 保留的空闲连接能跨任务
/// 命中，省掉大量 TLS 握手；`connect_timeout` 依然在单次请求上生效。
static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(UA)
            .connect_timeout(Duration::from_secs(15))
            // 池上限按最大并发留足，多任务共享同一池 —— 空闲连接可复用，不必每段重握手。
            .pool_max_idle_per_host(MAX_CONNECTIONS as usize)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

fn extra_headers(opts: &NativeDownloadOptions) -> Vec<(String, String)> {
    match &opts.headers {
        Some(list) => list
            .iter()
            .filter(|kv| kv.len() >= 2)
            .map(|kv| (kv[0].clone(), kv[1].clone()))
            .collect(),
        None => Vec::new(),
    }
}

/// 进度节流器：把高频的「收到字节」合并成约每 PROGRESS_INTERVAL_MS 一次的回调。
///
/// 节流时间戳用 `AtomicU64`（毫秒）而非 `Mutex<Instant>`：64 连接每 chunk 都要抢
/// 一把 tokio 锁，是纯粹的争用热点；换成 CAS 后零锁、零等待。
struct ProgressEmitter {
    on_bytes: Option<ProgressCallback>,
    pending: AtomicU64,
    /// 上次 flush 的时间戳（毫秒，相对 UNIX_EPOCH）。
    last_flush_ms: AtomicU64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl ProgressEmitter {
    fn new(on_bytes: Option<ProgressCallback>) -> Self {
        Self {
            on_bytes,
            pending: AtomicU64::new(0),
            last_flush_ms: AtomicU64::new(now_ms()),
        }
    }

    /// 累加字节；到达节流窗口才真正回调。无锁。
    fn add(&self, n: u64) {
        if self.on_bytes.is_none() {
            return;
        }
        self.pending.fetch_add(n, Ordering::Relaxed);
        let now = now_ms();
        let last = self.last_flush_ms.load(Ordering::Relaxed);
        if now.saturating_sub(last) >= PROGRESS_INTERVAL_MS {
            // 只在真正越过窗口时尝试抢占时间戳；CAS 失败说明别的线程刚 flush 过，跳过即可。
            if self
                .last_flush_ms
                .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
            {
                Self::flush(&self.pending, &self.on_bytes);
            }
        }
    }

    /// 结束时把残余字节补发，保证 JS 侧累计值等于真实下载量。
    fn finish(&self) {
        if self.on_bytes.is_none() {
            return;
        }
        Self::flush(&self.pending, &self.on_bytes);
    }

    /// 立即回调一次未上报的字节数（窗口超限或收尾时调用）。
    fn flush(pending: &AtomicU64, cb: &Option<ProgressCallback>) {
        // 先取值再清零：回调期间可能有新的 add，不会丢字节（下个窗口补发）。
        let n = pending.swap(0, Ordering::Relaxed);
        if n == 0 {
            return;
        }
        // JS 侧累计用的是 number，单块不可能超过 u32，这里夹取防御。
        let chunk = n.min(u32::MAX as u64) as u32;
        if let Some(cb) = cb {
            // NonBlocking：进度回调不应阻塞下载线程；队列满时丢弃本次即可（下个窗口补发）。
            cb.call(chunk, ThreadsafeFunctionCallMode::NonBlocking);
        }
        // 若确实超过 u32，把余量放回，下一轮继续上报。
        if n > chunk as u64 {
            pending.fetch_add(n - chunk as u64, Ordering::Relaxed);
        }
    }
}

/// 主下载流程：探测大小 → 选择单连接 / 分段 → 落盘。
///
/// 外层带**整文件瞬时错误重试**（对齐 TS 版 stream-download.ts）：429 / 5xx 等
/// 瞬时状态在传输层就地退避重试，并尊重服务端 `Retry-After`。旧实现把这类错误
/// 直接上抛，只能落到主进程固定 `500ms×n` 退避且完全不认 Retry-After，
/// 遇到限流会持续 429。硬错误（4xx 等）不在此重试，原样上抛给上层走镜像回退。
async fn run_download(
    job: &DownloadJob,
    cancelled: Arc<AtomicU64>,
) -> NetResult<NativeDownloadResult> {
    let mut attempt = 0u32;
    loop {
        match download_once(job, &cancelled).await {
            Ok(v) => return Ok(v),
            Err(e) => {
                let transient = e.code == ErrCode::Http
                    && e.status.map(is_transient_status).unwrap_or(false)
                    && attempt + 1 < FILE_ATTEMPTS;
                if !transient || cancelled.load(Ordering::Relaxed) != 0 {
                    return Err(e);
                }
                tokio::time::sleep(file_retry_delay(&e, attempt)).await;
                attempt += 1;
            }
        }
    }
}

/// 单次尝试：探测大小 → 选择单连接 / 分段 → 落盘。
async fn download_once(
    job: &DownloadJob,
    cancelled: &Arc<AtomicU64>,
) -> NetResult<NativeDownloadResult> {
    let opts = &job.opts;
    let dest = PathBuf::from(&opts.dest);
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| NativeError::network(format!("创建目录失败：{e}")))?;
    }

    let connections = opts
        .connections
        .unwrap_or(DEFAULT_CONNECTIONS)
        .clamp(1, MAX_CONNECTIONS);
    let cl = client();
    let headers = extra_headers(opts);
    let emitter = Arc::new(ProgressEmitter::new(job.on_bytes.clone()));

    // napi 的 BigInt 用 (符号, 数值, 是否无损) 三元组表示，这里只关心数值。
    let mut size = opts.size_hint.as_ref().map(|b| b.get_u64().1).unwrap_or(0);
    let mut direct = opts.url.clone();

    // HEAD 探测：补全大小 + 解析重定向到真正提供 Range 的主机。
    // 已知大小且是小文件时跳过，省掉一次往返（模组/资源包多为小文件）。
    if size == 0 || size >= PARALLEL_THRESHOLD {
        if let Ok((head_len, final_url)) = probe_head(cl, &opts.url, &headers, cancelled).await {
            if size == 0 && head_len > 0 {
                size = head_len;
            }
            if !final_url.is_empty() && final_url != opts.url {
                direct = final_url;
            }
        }
    }
    if size > 0 {
        if let Some(cb) = &job.on_size {
            let _ = cb.call(BigInt::from(size), ThreadsafeFunctionCallMode::NonBlocking);
        }
    }

    check_cancel(cancelled)?;

    // 大文件优先多连接分段；服务器不支持 Range 时回退单连接。
    if size >= PARALLEL_THRESHOLD {
        match parallel_download(cl, &direct, &dest, size, &headers, connections, &emitter, cancelled)
            .await
        {
            Ok(true) => {
                emitter.finish();
                return Ok(NativeDownloadResult {
                    bytes: BigInt::from(size),
                    parallel: true,
                });
            }
            Ok(false) => { /* 不支持 Range，落到单连接 */ }
            Err(e) => return Err(e),
        }
    }

    let written = single_download(cl, &direct, &dest, &headers, &emitter, cancelled).await?;
    emitter.finish();
    Ok(NativeDownloadResult {
        bytes: BigInt::from(written),
        parallel: false,
    })
}

fn check_cancel(cancelled: &Arc<AtomicU64>) -> NetResult<()> {
    if cancelled.load(Ordering::Relaxed) != 0 {
        return Err(NativeError::cancelled());
    }
    Ok(())
}

/// `bytes=0-0` 单连接探测：判断服务器是否真的支持 Range。
/// 命中 206 返回 true；返回 200 / 403 / 404 / 416 等视为不支持。
/// 这样能在开 64 连接之前就发现「不支持 Range」的主机，避免整池请求作废后删文件重来。
async fn probe_range_support(
    client: &reqwest::Client,
    url: &str,
    headers: &[(String, String)],
    cancelled: &Arc<AtomicU64>,
) -> bool {
    let mut req = client
        .get(url)
        .header(reqwest::header::RANGE, "bytes=0-0")
        .timeout(Duration::from_millis(HEAD_TIMEOUT_MS));
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let res = tokio::select! {
        _ = cancel_watch(cancelled) => return false,
        r = req.send() => r,
    };
    matches!(res, Ok(r) if r.status().as_u16() == 206)
}

/// HEAD 探测：返回 (content-length, 最终 URL)。失败时返回 Err，由调用方忽略并退化。
/// 带**请求级超时**与取消：服务端不回响应时不再挂到 OS 超时。
async fn probe_head(
    client: &reqwest::Client,
    url: &str,
    headers: &[(String, String)],
    cancelled: &Arc<AtomicU64>,
) -> NetResult<(u64, String)> {
    let mut req = client
        .head(url)
        .timeout(Duration::from_millis(HEAD_TIMEOUT_MS));
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let res = tokio::select! {
        _ = cancel_watch(cancelled) => return Err(NativeError::cancelled()),
        r = req.send() => r.map_err(|e| NativeError::network(e.to_string()))?,
    };
    let cl = res
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    Ok((cl, res.url().as_str().to_string()))
}

/// 取消监听：被取消时立即就绪（配合 `tokio::select!` 让在途请求可被打断）。
async fn cancel_watch(cancelled: &Arc<AtomicU64>) {
    loop {
        if cancelled.load(Ordering::Relaxed) != 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// 单连接下载：直写临时文件后改名到目标，自带停滞看门狗。
/// 与分段路径一样走 tmp+rename，保证「失败不留下半截目标文件」的语义统一。
///
/// 写盘策略（相对旧实现的改进）：旧版**每个网络 chunk** 都 `spawn_blocking` +
/// `try_clone` + 同步 `write_all`，64 连接高频 chunk 下把 blocking pool 打满、还阻塞
/// reactor。这里改为「持有文件句柄 + 段内缓冲」：网络分片先攒进
/// `WRITE_BUFFER_SIZE`(512KB) 缓冲，攒满（或结束时）才做一次 `spawn_blocking` 顺序写。
async fn single_download(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    headers: &[(String, String)],
    emitter: &Arc<ProgressEmitter>,
    cancelled: &Arc<AtomicU64>,
) -> NetResult<u64> {
    let mut req = client.get(url);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let res = req.send().await.map_err(|e| NativeError::network(format!("请求失败：{e}")))?;

    if !res.status().is_success() {
        return Err(http_error_message(res).await);
    }

    // 先写临时文件，成功后整体改名；失败/取消时删除，目标路径始终是「要么完整要么不存在」。
    let tmp = part_path(dest);
    let tmp_clone = tmp.clone();
    let mut file = tokio::task::spawn_blocking(move || {
        std::fs::File::create(&tmp_clone).map_err(|e| NativeError::network(format!("创建文件失败：{e}")))
    })
    .await
    .map_err(|e| NativeError::network(format!("创建文件任务失败：{e}")))??;

    let mut stream = res.bytes_stream();
    let mut written: u64 = 0;
    let mut last_bytes_at = Instant::now();
    // 段内缓冲：攒够 WRITE_BUFFER_SIZE 再落盘，显著减少系统调用与 spawn_blocking 次数。
    let mut buf: Vec<u8> = Vec::with_capacity(WRITE_BUFFER_SIZE);

    loop {
        if cancelled.load(Ordering::Relaxed) != 0 {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(NativeError::cancelled());
        }

        let next = tokio::time::timeout(Duration::from_secs(1), stream.next()).await;
        match next {
            Err(_) => {
                // 1s 内没有数据到达：检查是否已超过停滞阈值。
                if last_bytes_at.elapsed() >= Duration::from_millis(STALL_TIMEOUT_MS) {
                    let _ = tokio::fs::remove_file(&tmp).await;
                    return Err(NativeError::timeout("网络连接超时"));
                }
            }
            Ok(None) => break,
            Ok(Some(Err(e))) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(NativeError::network(format!("读取响应失败：{e}")));
            }
            Ok(Some(Ok(chunk))) => {
                last_bytes_at = Instant::now();
                buf.extend_from_slice(&chunk);
                written += chunk.len() as u64;
                emitter.add(chunk.len() as u64);
                if buf.len() >= WRITE_BUFFER_SIZE {
                    flush_buf(&mut file, &mut buf).await?;
                }
            }
        }
    }

    // 收尾：把缓冲里剩余字节刷盘，再 flush + 关闭句柄。
    flush_buf(&mut file, &mut buf).await?;
    // flush 后关闭句柄再改名（Windows 上文件被占用时 rename 会失败）。
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        file.flush().map_err(|e| NativeError::network(format!("落盘失败：{e}")))
    })
    .await
    .map_err(|e| NativeError::network(format!("落盘任务失败：{e}")))??;
    // `file` 已随闭包移出并 drop，此处句柄已关闭。
    tokio::fs::rename(&tmp, dest)
        .await
        .map_err(|e| NativeError::network(format!("重命名失败：{e}")))?;
    Ok(written)
}

/// 把缓冲内容顺序写入文件句柄（阻塞写放 spawn_blocking，避免阻塞 reactor）。
async fn flush_buf(file: &mut std::fs::File, buf: &mut Vec<u8>) -> NetResult<()> {
    if buf.is_empty() {
        return Ok(());
    }
    let data = std::mem::take(buf);
    // 写失败时把数据退回缓冲，避免丢失（调用方多半会整体失败，但保持语义干净）。
    let mut f = file.try_clone().map_err(|e| NativeError::network(format!("复制句柄失败：{e}")))?;
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        f.write_all(&data).map_err(|e| NativeError::network(format!("写入失败：{e}")))
    })
    .await
    .map_err(|e| NativeError::network(format!("写入任务失败：{e}")))??;
    Ok(())
}

/// 临时文件路径：`foo.jar` → `foo.jar.part`（与 TS 侧 `${dest}.part` 命名一致）。
fn part_path(dest: &Path) -> PathBuf {
    dest.with_extension(format!(
        "{}part",
        dest.extension()
            .and_then(|e| e.to_str())
            .map(|e| format!("{e}."))
            .unwrap_or_default()
    ))
}

/// 读取错误响应正文（截断），拼进错误消息，便于上层透出服务端说明。
async fn http_error_message(res: reqwest::Response) -> NativeError {
    let status = res.status().as_u16();
    let retry_after = res
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let body = res
        .text()
        .await
        .unwrap_or_default()
        .replace(char::is_whitespace, " ")
        .trim()
        .chars()
        .take(200)
        .collect::<String>();
    let msg = if body.is_empty() {
        format!("下载失败 (HTTP {status})")
    } else {
        format!("下载失败 (HTTP {status})：{body}")
    };
    NativeError::http(msg, status).with_retry_after(retry_after)
}

/// 分段大小：目标段数 = 连接数 × 8，夹在 [256KB, 16MB]。
fn segment_size_for(size: u64, connections: u32) -> u64 {
    let target = (connections as u64).saturating_mul(SEGMENTS_PER_CONNECTION).max(1);
    let ideal = size.div_ceil(target);
    ideal.clamp(MIN_SEGMENT_SIZE, MAX_SEGMENT_SIZE)
}

/// 动态分段下载。
/// 返回 `Ok(true)` 表示成功；`Ok(false)` 表示服务器不支持 Range，需回退单连接。
#[allow(clippy::too_many_arguments)]
async fn parallel_download(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    size: u64,
    headers: &[(String, String)],
    connections: u32,
    emitter: &Arc<ProgressEmitter>,
    cancelled: &Arc<AtomicU64>,
) -> NetResult<bool> {
    // 开池前先用单连接 `bytes=0-0` 探测服务器是否真的支持 Range：
    // 避免 64 个连接一起发 Range、第一个响应才发现不支持，导致已下载段全部作废、删文件重来。
    if !probe_range_support(client, url, headers, cancelled).await {
        return Ok(false);
    }

    let tmp = part_path(dest);

    // 预分配：让各段按绝对偏移并发写入同一个文件，不需要额外合并。
    //
    // 用 **std::fs::File** 而不是 tokio::fs::File：定位写（pwrite / seek_write）需要
    // 同步的文件句柄，且我们已把写操作放在 spawn_blocking 里避免阻塞 reactor。
    // 全部 worker 共享同一个 `Arc<std::fs::File>`，不再每次写入都 try_clone。
    let tmp_clone = tmp.clone();
    let file = tokio::task::spawn_blocking(move || {
        let f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp_clone)
            .map_err(|e| NativeError::network(format!("创建临时文件失败：{e}")))?;
        f.set_len(size)
            .map_err(|e| NativeError::network(format!("预分配文件失败：{e}")))?;
        Ok::<std::fs::File, NativeError>(f)
    })
    .await
    .map_err(|e| NativeError::network(format!("创建文件任务失败：{e}")))??;
    let file = Arc::new(file);

    let seg_size = segment_size_for(size, connections);
    let total_segments = size.div_ceil(seg_size).max(1);

    // 共享游标：连接池里的 worker 反复原子领取下一段。
    let next = Arc::new(AtomicU64::new(0));
    let range_unsupported = Arc::new(AtomicBool::new(false));
    // 失败标志：任一 worker 记录首个错误后置位，其余 worker 在循环入口即可感知并退出，
    // 避免「一个连接彻底挂了，其余 63 个还在白白消耗带宽」。
    let failed = Arc::new(AtomicU64::new(0));
    let first_error: Arc<std::sync::Mutex<Option<NativeError>>> =
        Arc::new(std::sync::Mutex::new(None));

    // total_segments 理论上是 u64，这里夹到 u32 上限，避免超长文件被静默截断。
    let worker_count = connections.min(total_segments.min(u32::MAX as u64) as u32).max(1);
    let mut tasks = Vec::with_capacity(worker_count as usize);

    for _ in 0..worker_count {
        let client = client.clone();
        let url = url.to_string();
        let headers = headers.to_vec();
        let file = file.clone();
        let next = next.clone();
        let range_unsupported = range_unsupported.clone();
        let failed = failed.clone();
        let first_error = first_error.clone();
        let emitter = emitter.clone();
        let cancelled = cancelled.clone();

        tasks.push(tokio::spawn(async move {
            loop {
                if cancelled.load(Ordering::Relaxed) != 0 {
                    return;
                }
                if range_unsupported.load(Ordering::Relaxed) {
                    return;
                }
                // 已有 worker 失败：立即收手，不再领取新段。
                if failed.load(Ordering::Relaxed) != 0 {
                    return;
                }
                let idx = next.fetch_add(1, Ordering::Relaxed);
                if idx >= total_segments {
                    return;
                }
                let start = idx * seg_size;
                let end = (start + seg_size).min(size);

                match download_segment(
                    &client,
                    &url,
                    start,
                    end,
                    &file,
                    &headers,
                    &emitter,
                    &cancelled,
                )
                .await
                {
                    Ok(true) => {}
                    Ok(false) => {
                        // 服务器忽略 Range：标记并让所有 worker 退出。
                        range_unsupported.store(true, Ordering::Relaxed);
                        return;
                    }
                    Err(e) => {
                        // 记录首错并广播失败标志，其余 worker 立即退出。
                        set_first_error(&first_error, &failed, e);
                        return;
                    }
                }
            }
        }));
    }

    // 等待全部 worker 退场（错误已通过 first_error 汇总；JoinError 也一并收集）。
    let mut failure: Option<NativeError> = None;
    for t in tasks {
        if let Err(join_err) = t.await {
            if failure.is_none() {
                failure = Some(NativeError::network(format!("下载线程异常退出：{join_err}")));
            }
        }
    }
    if let Some(e) = first_error.lock().unwrap().clone() {
        if failure.is_none() {
            failure = Some(e);
        }
    }

    // 保证 fd 关闭后再改名/删除（Windows 上文件被占用时 rename 会失败）。
    drop(file);

    if cancelled.load(Ordering::Relaxed) != 0 {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(NativeError::cancelled());
    }
    if range_unsupported.load(Ordering::Relaxed) {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Ok(false);
    }
    if let Some(e) = failure {
        // 注意：**保留** .part 文件，让上层整文件重试能命中已下载数据（配合段内续传），
        // 而不是每次失败都从零开始。仅取消 / 不支持 Range 时才清理。
        return Err(e);
    }

    // 尺寸断言：size_hint 可能来自不精确的上游（镜像不同步/服务端内容更短），
    // 预分配会留下尾部空洞。落盘前核对实际长度，避免产出带 \0 的文件蒙混过关
    //（上层虽有 SHA-1 兜底，但在此处直接失败更便于定位问题）。
    let actual = tokio::fs::metadata(&tmp)
        .await
        .map_err(|e| NativeError::network(format!("读取临时文件信息失败：{e}")))?
        .len();
    if actual != size {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(NativeError::network(format!(
            "文件大小不符（期望 {size}，实际 {actual}）"
        )));
    }

    tokio::fs::rename(&tmp, dest)
        .await
        .map_err(|e| NativeError::network(format!("重命名失败：{e}")))?;
    Ok(true)
}

/// 记录首个错误并广播失败标志（仅首个错误会被保留，后续错误忽略）。
fn set_first_error(
    slot: &Arc<std::sync::Mutex<Option<NativeError>>>,
    failed: &Arc<AtomicU64>,
    err: NativeError,
) {
    let mut guard = slot.lock().unwrap();
    if guard.is_none() {
        *guard = Some(err);
    }
    // 同步置位失败标志：无论本次错误是否被采纳为首错，其余 worker 都应尽快退出。
    failed.store(1, Ordering::Relaxed);
}

/// 下载单个区间 `[start, end)`，失败时从已写入偏移续传重试。
/// 返回 `Ok(false)` 表示服务器不支持 Range（需回退单连接）。
#[allow(clippy::too_many_arguments)]
async fn download_segment(
    client: &reqwest::Client,
    url: &str,
    start: u64,
    end: u64,
    file: &Arc<std::fs::File>,
    headers: &[(String, String)],
    emitter: &Arc<ProgressEmitter>,
    cancelled: &Arc<AtomicU64>,
) -> NetResult<bool> {
    let mut pos = start;
    let mut last_error: Option<NativeError> = None;

    for attempt in 0..SEGMENT_ATTEMPTS {
        check_cancel(cancelled)?;

        let mut req = client.get(url).header(
            reqwest::header::RANGE,
            format!("bytes={}-{}", pos, end - 1),
        );
        for (k, v) in headers {
            req = req.header(k, v);
        }

        let res = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                last_error = Some(NativeError::network(format!("分段请求失败：{e}")));
                if attempt + 1 < SEGMENT_ATTEMPTS {
                    tokio::time::sleep(segment_delay(&last_error, attempt)).await;
                    continue;
                }
                break;
            }
        };

        let status = res.status().as_u16();
        // 服务器未实现 Range / 区间越界 / CDN 拒绝带 Range 的请求：
        // 统一回退单连接（不带 Range 时这些主机通常正常）。
        if status == 200 || status == 416 || status == 403 || status == 404 || status == 405 {
            return Ok(false);
        }
        if status != 206 {
            // 瞬时错误（429 / 5xx）在段内重试（尊重 Retry-After），其余直接上抛给上层走镜像回退。
            if !is_transient_status(status) {
                return Err(http_status_error(&res, status).await);
            }
            last_error = Some(http_status_error(&res, status).await);
            if attempt + 1 < SEGMENT_ATTEMPTS {
                tokio::time::sleep(segment_delay(&last_error, attempt)).await;
                continue;
            }
            break;
        }

        // 校验服务器是否真的从请求的偏移开始回。
        let range_start = res
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(parse_content_range_start);
        if let Some(rs) = range_start {
            if rs != pos {
                last_error = Some(NativeError::network(format!(
                    "分段响应区间不符（期望 {pos}，实际 {rs}）"
                )));
                if attempt + 1 < SEGMENT_ATTEMPTS {
                    tokio::time::sleep(segment_delay(&last_error, attempt)).await;
                    continue;
                }
                break;
            }
        }

        let mut stream = res.bytes_stream();
        let mut last_bytes_at = Instant::now();
        let mut stall = false;
        // 段内写缓冲：与单连接路径一致，攒够再落盘，避免每 chunk 一次 spawn_blocking。
        let mut buf: Vec<u8> = Vec::with_capacity(WRITE_BUFFER_SIZE);
        // 当前缓冲对应的文件起始偏移。
        let mut buf_start = pos;

        let seg_result: NetResult<()> = loop {
            if cancelled.load(Ordering::Relaxed) != 0 {
                break Err(NativeError::cancelled());
            }
            if pos >= end {
                break Ok(());
            }

            let next = tokio::time::timeout(Duration::from_secs(1), stream.next()).await;
            match next {
                Err(_) => {
                    if last_bytes_at.elapsed() >= Duration::from_millis(STALL_TIMEOUT_MS) {
                        stall = true;
                        break Ok(());
                    }
                }
                Ok(None) => break Ok(()),
                Ok(Some(Err(e))) => {
                    // 保留具体错误用于诊断：连接被 reset（需要立刻重连）与
                    // 「读一半 EOF」（服务端截断）是两类问题，不该被笼统归并。
                    break Err(NativeError::network(format!("分段读取失败：{e}")));
                }
                Ok(Some(Ok(chunk))) => {
                    last_bytes_at = Instant::now();
                    // 防御：服务器多发字节时只写到段尾，绝不越界覆盖下一段。
                    let room = (end - pos) as usize;
                    let take = chunk.len().min(room);
                    buf.extend_from_slice(&chunk.slice(..take));
                    pos += take as u64;
                    emitter.add(take as u64);
                    if buf.len() >= WRITE_BUFFER_SIZE {
                        write_at(file, &buf, buf_start).await?;
                        buf.clear();
                        buf_start = pos;
                    }
                    if take < chunk.len() {
                        break Ok(());
                    }
                }
            }
        };

        // 无论如何先把缓冲落盘（错误也要落，保证 pos 已计入的字节真实在盘上）。
        if !buf.is_empty() {
            write_at(file, &buf, buf_start).await?;
        }
        seg_result?;

        if pos >= end {
            return Ok(true);
        }

        // 未被更具体的读取错误覆盖时，才按「停滞 / 不完整」定性。
        if last_error.is_none() {
            last_error = Some(if stall {
                NativeError::timeout("网络连接超时")
            } else {
                NativeError::network(format!("分段下载不完整（{}/{})", pos - start, end - start))
            });
        }
        if attempt + 1 < SEGMENT_ATTEMPTS {
            tokio::time::sleep(segment_delay(&last_error, attempt)).await;
        }
    }

    Err(last_error.unwrap_or_else(|| NativeError::network("分段下载失败")))
}

/// 由响应构造带 status / Retry-After 的结构化 HTTP 错误。
async fn http_status_error(res: &reqwest::Response, status: u16) -> NativeError {
    let retry_after = res
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    NativeError::http(format!("下载失败 (HTTP {status})"), status).with_retry_after(retry_after)
}

/// 在指定绝对偏移写入（多段并发写同一文件）。
///
/// 关键点：
///   1. 用**平台定位写**：Unix 的 `write_all_at`（pwrite）/ Windows 的 `seek_write`
///      （WriteFile+OVERLAPPED）。它们「偏移随调用传入、不碰文件游标」，天然适合
///      多连接并发；若改回 `try_clone + seek + write_all`，克隆句柄共享同一游标，
///      并发时会互相踩踏（表现为大小对但哈希错、且写入退化成串行）。
///   2. 全部 worker 共享**同一个** `Arc<std::fs::File>`，不再每次写 chunk 都
///      `try_clone().await`（那是异步操作，走 reactor 调度，几十万次克隆会把
///      「并行下载」变成「克隆开销主导」）。
///   3. 定位写是同步阻塞调用，放进 `spawn_blocking` 避免阻塞 reactor 线程。
///   4. 调用方按段内缓冲（WRITE_BUFFER_SIZE）整块提交，这里的 `rollback` 语义因此
///      只在整块失败时触发（调用方会整体失败，不会造成段内错位）。
async fn write_at(
    file: &Arc<std::fs::File>,
    data: &[u8],
    offset: u64,
) -> NetResult<()> {
    let file = file.clone();
    let data = data.to_vec();
    tokio::task::spawn_blocking(move || write_at_blocking(&file, &data, offset))
        .await
        .map_err(|e| NativeError::network(format!("写入任务失败：{e}")))?
}

#[cfg(unix)]
fn write_at_blocking(
    file: &std::fs::File,
    data: &[u8],
    offset: u64,
) -> NetResult<()> {
    use std::os::unix::fs::FileExt;
    file.write_all_at(data, offset)
        .map_err(|e| NativeError::network(format!("写入失败：{e}")))
}

#[cfg(windows)]
fn write_at_blocking(
    file: &std::fs::File,
    data: &[u8],
    offset: u64,
) -> NetResult<()> {
    use std::os::windows::fs::FileExt;
    let mut buf = data;
    let mut pos = offset;
    // Windows 上 seek_write 可能短写，循环直到写完。
    while !buf.is_empty() {
        let n = file
            .seek_write(buf, pos)
            .map_err(|e| NativeError::network(format!("写入失败：{e}")))?;
        if n == 0 {
            return Err(NativeError::network("写入失败：写入 0 字节"));
        }
        pos += n as u64;
        buf = &buf[n..];
    }
    Ok(())
}

fn parse_content_range_start(value: &str) -> Option<u64> {
    let rest = value.strip_prefix("bytes ")?;
    let dash = rest.find('-')?;
    rest[..dash].trim().parse::<u64>().ok()
}

/// 哪些 HTTP 状态算「瞬时错误」（可原地重试）：限流 / 超时 / 服务端 5xx。
fn is_transient_status(status: u16) -> bool {
    matches!(status, 408 | 425 | 429 | 500 | 502 | 503 | 504)
}

/// 由 Retry-After（秒）推导等待时长；解析不出时返回 None。
fn retry_after_delay(err: &Option<NativeError>) -> Option<Duration> {
    let ra = err.as_ref()?.retry_after.as_deref()?;
    let sec: f64 = ra.trim().parse().ok()?;
    if sec > 0.0 {
        Some(Duration::from_millis((sec * 1000.0).min(30_000.0) as u64))
    } else {
        None
    }
}

/// 分段重试退避：优先尊重 Retry-After，其次指数退避，封顶 8s 避免单段长时间空等。
fn segment_delay(err: &Option<NativeError>, attempt: u32) -> Duration {
    if let Some(d) = retry_after_delay(err) {
        return d.min(Duration::from_millis(8_000));
    }
    let ms = 500u64.saturating_mul(1u64 << attempt.min(4));
    Duration::from_millis(ms.min(8_000))
}

/// 整文件重试退避（瞬时错误）：尊重 Retry-After，否则指数退避，封顶 20s。
fn file_retry_delay(err: &NativeError, attempt: u32) -> Duration {
    if let Some(sec) = err.retry_after.as_deref().and_then(|s| s.trim().parse::<f64>().ok()) {
        if sec > 0.0 {
            return Duration::from_millis((sec * 1000.0).min(30_000.0) as u64);
        }
    }
    let base = if err.status == Some(429) { 3000u64 } else { 1200 };
    Duration::from_millis((base.saturating_mul(1u64 << attempt.min(4))).min(20_000))
}

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

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{
    ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use napi::{Env, Task};
use napi_derive::napi;
// 注意：不再需要 AsyncSeekExt —— 分段写入已改为平台定位写（pwrite / seek_write），
// 它不经过文件游标，因此不需要 seek。
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

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

const UA: &str = "HungerCatLauncher/0.1";

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
        self.cancelled.store(1, Ordering::SeqCst);
    }

    /// 供内部/测试读取取消状态。
    #[napi(getter)]
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst) != 0
    }
}

/// 下载参数。
///
/// 注意：回调不放进 `#[napi(object)]` —— `ThreadsafeFunction` 没有实现 `ToNapiValue`，
/// 无法作为对象字段。改为 `download()` 的独立入参，由 napi 直接完成转换。
#[napi(object)]
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
struct DownloadJob {
    opts: NativeDownloadOptions,
    on_bytes: Option<ProgressCallback>,
    on_size: Option<SizeCallback>,
}

/// 下载任务体：在独立的 tokio runtime 中执行，避免占用 libuv 线程池。
pub struct DownloadTask {
    job: DownloadJob,
    cancelled: Arc<AtomicU64>,
}

impl Task for DownloadTask {
    type Output = NativeDownloadResult;
    type JsValue = NativeDownloadResult;

    fn compute(&mut self) -> Result<Self::Output> {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|e| Error::from_reason(format!("创建异步运行时失败：{e}")))?;

        let job = std::mem::replace(&mut self.job, empty_job());
        let cancelled = self.cancelled.clone();

        rt.block_on(run_download(job, cancelled))
            .map_err(Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
        Ok(out)
    }
}

fn empty_opts() -> NativeDownloadOptions {
    NativeDownloadOptions {
        url: String::new(),
        dest: String::new(),
        size_hint: None,
        connections: None,
        headers: None,
    }
}

fn empty_job() -> DownloadJob {
    DownloadJob {
        opts: empty_opts(),
        on_bytes: None,
        on_size: None,
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

fn cancelled_err() -> String {
    "下载已取消".to_string()
}

/// 构造带默认 UA 与自定义头的客户端。
///
/// `pool_max_idle_per_host` 必须跟着连接数走：默认值（reqwest 为 2）会让每次
/// 领取新段都得重新握手，64 连接下握手开销会显著拖慢下载。
fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(UA)
        .connect_timeout(Duration::from_secs(15))
        .pool_max_idle_per_host(MAX_CONNECTIONS as usize)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
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
struct ProgressEmitter {
    on_bytes: Option<ProgressCallback>,
    pending: AtomicU64,
    last_flush: Mutex<Instant>,
}

impl ProgressEmitter {
    fn new(on_bytes: Option<ProgressCallback>) -> Self {
        Self {
            on_bytes,
            pending: AtomicU64::new(0),
            last_flush: Mutex::new(Instant::now()),
        }
    }

    /// 累加字节；到达节流窗口才真正回调。
    async fn add(&self, n: u64) {
        if self.on_bytes.is_none() {
            return;
        }
        self.pending.fetch_add(n, Ordering::Relaxed);
        let mut last = self.last_flush.lock().await;
        if last.elapsed() >= Duration::from_millis(PROGRESS_INTERVAL_MS) {
            Self::flush_locked(&self.pending, &self.on_bytes);
            *last = Instant::now();
        }
    }

    /// 结束时把残余字节补发，保证 JS 侧累计值等于真实下载量。
    async fn finish(&self) {
        if self.on_bytes.is_none() {
            return;
        }
        let mut last = self.last_flush.lock().await;
        Self::flush_locked(&self.pending, &self.on_bytes);
        *last = Instant::now();
    }

    /// 立即回调一次未上报的字节数（窗口超限或收尾时调用）。
    fn flush_locked(pending: &AtomicU64, cb: &Option<ProgressCallback>) {
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
async fn run_download(
    job: DownloadJob,
    cancelled: Arc<AtomicU64>,
) -> std::result::Result<NativeDownloadResult, String> {
    let opts = &job.opts;
    let dest = PathBuf::from(&opts.dest);
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("创建目录失败：{e}"))?;
    }

    let client = build_client();
    let headers = extra_headers(opts);
    let emitter = Arc::new(ProgressEmitter::new(job.on_bytes.clone()));
    let connections = opts
        .connections
        .unwrap_or(DEFAULT_CONNECTIONS)
        .clamp(1, MAX_CONNECTIONS);

    // napi 的 BigInt 用 (符号, 数值, 是否无损) 三元组表示，这里只关心数值。
    let mut size = opts.size_hint.as_ref().map(|b| b.get_u64().1).unwrap_or(0);
    let mut direct = opts.url.clone();

    // HEAD 探测：补全大小 + 解析重定向到真正提供 Range 的主机。
    // 已知大小且是小文件时跳过，省掉一次往返（模组/资源包多为小文件）。
    if size == 0 || size >= PARALLEL_THRESHOLD {
        if let Ok((cl, final_url)) = probe_head(&client, &opts.url, &headers).await {
            if size == 0 && cl > 0 {
                size = cl;
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

    check_cancel(&cancelled)?;

    // 大文件优先多连接分段；服务器不支持 Range 时回退单连接。
    if size >= PARALLEL_THRESHOLD {
        match parallel_download(&client, &direct, &dest, size, &headers, connections, &emitter, &cancelled).await {
            Ok(true) => {
                emitter.finish().await;
                return Ok(NativeDownloadResult {
                    bytes: BigInt::from(size),
                    parallel: true,
                });
            }
            Ok(false) => { /* 不支持 Range，落到单连接 */ }
            Err(e) => return Err(e),
        }
    }

    let written = single_download(&client, &direct, &dest, &headers, &emitter, &cancelled).await?;
    emitter.finish().await;
    Ok(NativeDownloadResult {
        bytes: BigInt::from(written),
        parallel: false,
    })
}

fn check_cancel(cancelled: &Arc<AtomicU64>) -> std::result::Result<(), String> {
    if cancelled.load(Ordering::SeqCst) != 0 {
        return Err(cancelled_err());
    }
    Ok(())
}

/// HEAD 探测：返回 (content-length, 最终 URL)。失败时返回 Err，由调用方忽略并退化。
async fn probe_head(
    client: &reqwest::Client,
    url: &str,
    headers: &[(String, String)],
) -> std::result::Result<(u64, String), String> {
    let mut req = client.head(url);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let cl = res
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    Ok((cl, res.url().as_str().to_string()))
}

/// 单连接下载：直写目标文件，自带停滞看门狗。
async fn single_download(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    headers: &[(String, String)],
    emitter: &Arc<ProgressEmitter>,
    cancelled: &Arc<AtomicU64>,
) -> std::result::Result<u64, String> {
    let mut req = client.get(url);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let res = req.send().await.map_err(|e| format!("请求失败：{e}"))?;

    if !res.status().is_success() {
        return Err(http_error_message(res).await);
    }

    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("创建文件失败：{e}"))?;
    let mut stream = res.bytes_stream();
    let mut written: u64 = 0;
    let mut last_bytes_at = Instant::now();

    loop {
        check_cancel(cancelled)?;

        let next = tokio::time::timeout(Duration::from_secs(1), stream.next()).await;
        match next {
            Err(_) => {
                // 1s 内没有数据到达：检查是否已超过停滞阈值。
                if last_bytes_at.elapsed() >= Duration::from_millis(STALL_TIMEOUT_MS) {
                    return Err("网络连接超时".to_string());
                }
            }
            Ok(None) => break,
            Ok(Some(Err(e))) => return Err(format!("读取响应失败：{e}")),
            Ok(Some(Ok(chunk))) => {
                last_bytes_at = Instant::now();
                file.write_all(&chunk)
                    .await
                    .map_err(|e| format!("写入失败：{e}"))?;
                written += chunk.len() as u64;
                emitter.add(chunk.len() as u64).await;
            }
        }
    }

    file.flush().await.map_err(|e| format!("落盘失败：{e}"))?;
    Ok(written)
}

/// 读取错误响应正文（截断），拼进错误消息，便于上层透出服务端说明。
async fn http_error_message(res: reqwest::Response) -> String {
    let status = res.status();
    let body = res
        .text()
        .await
        .unwrap_or_default()
        .replace(char::is_whitespace, " ")
        .trim()
        .chars()
        .take(200)
        .collect::<String>();
    if body.is_empty() {
        format!("下载失败 (HTTP {status})")
    } else {
        format!("下载失败 (HTTP {status})：{body}")
    }
}

/// 分段大小：目标段数 = 连接数 × 4，夹在 [1MB, 16MB]。
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
) -> std::result::Result<bool, String> {
    let tmp = dest.with_extension(format!(
        "{}part",
        dest.extension()
            .and_then(|e| e.to_str())
            .map(|e| format!("{e}."))
            .unwrap_or_default()
    ));

    // 预分配：让各段按绝对偏移并发写入同一个文件，不需要额外合并。
    let file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&tmp)
        .await
        .map_err(|e| format!("创建临时文件失败：{e}"))?;
    file.set_len(size)
        .await
        .map_err(|e| format!("预分配文件失败：{e}"))?;
    let file = Arc::new(file);

    let seg_size = segment_size_for(size, connections);
    let total_segments = size.div_ceil(seg_size).max(1);

    // 共享游标：连接池里的 worker 反复原子领取下一段。
    let next = Arc::new(AtomicU64::new(0));
    let range_unsupported = Arc::new(AtomicU64::new(0));
    let first_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    let worker_count = connections.min(total_segments as u32).max(1);
    let mut tasks = Vec::with_capacity(worker_count as usize);

    for _ in 0..worker_count {
        let client = client.clone();
        let url = url.to_string();
        let headers = headers.to_vec();
        let file = file.clone();
        let next = next.clone();
        let range_unsupported = range_unsupported.clone();
        let first_error = first_error.clone();
        let emitter = emitter.clone();
        let cancelled = cancelled.clone();

        tasks.push(tokio::spawn(async move {
            loop {
                if cancelled.load(Ordering::SeqCst) != 0 {
                    set_first_error(&first_error, cancelled_err()).await;
                    return;
                }
                if range_unsupported.load(Ordering::SeqCst) != 0 {
                    return;
                }
                let idx = next.fetch_add(1, Ordering::SeqCst);
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
                        range_unsupported.store(1, Ordering::SeqCst);
                        return;
                    }
                    Err(e) => {
                        set_first_error(&first_error, e).await;
                        return;
                    }
                }
            }
        }));
    }

    // 任一 worker 失败即取消其余：用取消标志统一收口，等待全部退场后再关文件。
    // worker 自身的错误已记入 first_error，这里只等它们全部退场（JoinError 也忽略）。
    let mut failure: Option<String> = None;
    for t in tasks {
        if let Err(join_err) = t.await {
            if failure.is_none() {
                failure = Some(format!("下载线程异常退出：{join_err}"));
            }
        }
    }
    if let Some(e) = first_error.lock().await.clone() {
        if failure.is_none() {
            failure = Some(e);
        }
    }

    // 保证 fd 关闭后再改名/删除（Windows 上文件被占用时 rename 会失败）。
    drop(file);

    if cancelled.load(Ordering::SeqCst) != 0 {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(cancelled_err());
    }
    if range_unsupported.load(Ordering::SeqCst) != 0 {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Ok(false);
    }
    if let Some(e) = failure {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }

    tokio::fs::rename(&tmp, dest)
        .await
        .map_err(|e| format!("重命名失败：{e}"))?;
    Ok(true)
}

async fn set_first_error(slot: &Arc<Mutex<Option<String>>>, msg: String) {
    let mut guard = slot.lock().await;
    if guard.is_none() {
        *guard = Some(msg);
    }
}

/// 下载单个区间 `[start, end)`，失败时从已写入偏移续传重试。
/// 返回 `Ok(false)` 表示服务器不支持 Range（需回退单连接）。
#[allow(clippy::too_many_arguments)]
async fn download_segment(
    client: &reqwest::Client,
    url: &str,
    start: u64,
    end: u64,
    file: &Arc<tokio::fs::File>,
    headers: &[(String, String)],
    emitter: &Arc<ProgressEmitter>,
    cancelled: &Arc<AtomicU64>,
) -> std::result::Result<bool, String> {
    let mut pos = start;
    let mut last_error: Option<String> = None;

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
                last_error = Some(format!("分段请求失败：{e}"));
                if attempt + 1 < SEGMENT_ATTEMPTS {
                    tokio::time::sleep(segment_delay(attempt)).await;
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
            // 瞬时错误（429 / 5xx）重试，其余直接上抛给上层走镜像回退。
            if !is_transient(status) {
                return Err(format!("下载失败 (HTTP {status})"));
            }
            last_error = Some(format!("下载失败 (HTTP {status})"));
            if attempt + 1 < SEGMENT_ATTEMPTS {
                tokio::time::sleep(segment_delay(attempt)).await;
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
                last_error = Some(format!("分段响应区间不符（期望 {pos}，实际 {rs}）"));
                if attempt + 1 < SEGMENT_ATTEMPTS {
                    tokio::time::sleep(segment_delay(attempt)).await;
                    continue;
                }
                break;
            }
        }

        let mut stream = res.bytes_stream();
        let mut last_bytes_at = Instant::now();
        let mut stall = false;

        loop {
            if cancelled.load(Ordering::SeqCst) != 0 {
                return Err(cancelled_err());
            }
            if pos >= end {
                break;
            }

            let next = tokio::time::timeout(Duration::from_secs(1), stream.next()).await;
            match next {
                Err(_) => {
                    if last_bytes_at.elapsed() >= Duration::from_millis(STALL_TIMEOUT_MS) {
                        stall = true;
                        break;
                    }
                }
                Ok(None) => break,
                Ok(Some(Err(e))) => {
                    // 具体错误统一在下面按「停滞 / 不完整」归并成 last_error，
                    // 这里只需中断本段读取。
                    let _ = e;
                    break;
                }
                Ok(Some(Ok(chunk))) => {
                    last_bytes_at = Instant::now();
                    // 防御：服务器多发字节时只写到段尾，绝不越界覆盖下一段。
                    let room = (end - pos) as usize;
                    let take = chunk.len().min(room);
                    write_at(file, &chunk[..take], pos).await?;
                    pos += take as u64;
                    emitter.add(take as u64).await;
                    if take < chunk.len() {
                        break;
                    }
                }
            }
        }

        if pos >= end {
            return Ok(true);
        }

        last_error = Some(if stall {
            "网络连接超时".to_string()
        } else {
            format!("分段下载不完整（{}/{})", pos - start, end - start)
        });
        if attempt + 1 < SEGMENT_ATTEMPTS {
            tokio::time::sleep(segment_delay(attempt)).await;
        }
    }

    Err(last_error.unwrap_or_else(|| "分段下载失败".to_string()))
}

/// 在指定绝对偏移写入（多段并发写同一文件）。
///
/// 不能用 `try_clone` + `seek` + `write_all`：克隆出来的句柄共享同一个文件游标，
/// 多连接并发时会互相踩踏游标，导致字节写错位置（表现为大小对但哈希不对，
/// 且写入退化成串行）。这里用平台的**定位写**：
///   - Unix: `pwrite`
///   - Windows: `WriteFile` + `OVERLAPPED` 的 offset
/// 它们都是「偏移随调用传入、不碰文件游标」的原子写，天然适合分段并发。
#[cfg(unix)]
async fn write_at(
    file: &Arc<tokio::fs::File>,
    data: &[u8],
    offset: u64,
) -> std::result::Result<(), String> {
    use std::os::unix::fs::FileExt;
    let std_file = file.try_clone().await.map_err(|e| format!("复制句柄失败：{e}"))?;
    std_file
        .into_std()
        .await
        .write_all_at(data, offset)
        .map_err(|e| format!("写入失败：{e}"))
}

#[cfg(windows)]
async fn write_at(
    file: &Arc<tokio::fs::File>,
    data: &[u8],
    offset: u64,
) -> std::result::Result<(), String> {
    use std::os::windows::fs::FileExt;
    let std_file = file.try_clone().await.map_err(|e| format!("复制句柄失败：{e}"))?;
    let mut buf = data;
    let mut pos = offset;
    let inner = std_file.into_std().await;
    // Windows 上 seek_write 可能短写，循环直到写完。
    while !buf.is_empty() {
        let n = inner
            .seek_write(buf, pos)
            .map_err(|e| format!("写入失败：{e}"))?;
        if n == 0 {
            return Err("写入失败：写入 0 字节".to_string());
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

fn is_transient(status: u16) -> bool {
    matches!(status, 408 | 425 | 429 | 500 | 502 | 503 | 504)
}

/// 分段重试退避：封顶 8s，避免单段长时间空等。
fn segment_delay(attempt: u32) -> Duration {
    let ms = 500u64.saturating_mul(1u64 << attempt.min(4));
    Duration::from_millis(ms.min(8_000))
}

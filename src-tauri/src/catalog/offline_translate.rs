//! 离线翻译模组的专用固定源；不扩大普通资源下载的域名或参数权限。
//! 先有界缓冲再事务写入。这里自算的摘要只证明本次提交字节一致，不认证发布者或模组版本。
use super::{BoundDownload, ExportChunk, ExportSink, Result};
use crate::downloads::Cancel;
use reqwest::{header, Client, StatusCode, Url};
use sha2::{Digest, Sha512};
use std::{future::Future, io::Cursor, pin::Pin, sync::{Arc, OnceLock}, time::Duration};
use tokio::{sync::{OwnedSemaphorePermit, Semaphore}, time::Instant};

pub(super) const FILENAME: &str = "MCAutoTranslationTool-1.4-beta3-fabric-all.jar";
// 与 Electron 的固定分发地址一致；签名不进入任务、DTO、日志、journal 或错误。
const FIXED_URL: &str = "https://pan.johnnyblog.top/d/%E6%88%91%E7%9A%84%E4%B8%96%E7%95%8C%E8%B5%84%E6%BA%90/MCAutoTranslationTool-1.4-beta3-fabric-all.jar?sign=or8QTnwiokGb-7HBIDuGoZOGzMniH9XUFaUCpckgM5I=:0";
pub(super) const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 16_384;
const MAX_CENTRAL_BYTES: usize = 4 * 1024 * 1024;
const TOTAL_TIMEOUT: Duration = Duration::from_secs(120);
const SOURCE_ERROR: &str = "离线翻译模组下载失败，请检查网络与证书 / 離線翻譯模組下載失敗，請檢查網路與憑證 / Offline translation download failed; check the network and certificates";
const INVALID: &str = "离线翻译模组响应无效或不是受支持的 JAR / 離線翻譯模組回應無效或不是支援的 JAR / Offline translation response is invalid or is not a supported JAR";
const TOO_LARGE: &str = "离线翻译模组超过 64 MiB 上限 / 離線翻譯模組超過 64 MiB 上限 / Offline translation package exceeds the 64 MiB limit";
const TRUNCATED: &str = "离线翻译模组响应长度不符 / 離線翻譯模組回應長度不符 / Offline translation response length mismatch";
const TIMED_OUT: &str = "离线翻译模组下载超时 / 離線翻譯模組下載逾時 / Offline translation download timed out";
const CANCELLED: &str = "离线翻译模组安装已取消 / 離線翻譯模組安裝已取消 / Offline translation installation cancelled";
static BUFFERS: OnceLock<Arc<Semaphore>> = OnceLock::new();

pub(super) type Progress = Arc<dyn Fn(u64, u64) + Send + Sync>;
type SourceFuture = Pin<Box<dyn Future<Output = Result<Package>> + Send>>;
pub(super) type Source = Arc<dyn Fn(Arc<Cancel>, Progress) -> SourceFuture + Send + Sync>;
pub(super) fn source() -> Source { Arc::new(|cancel, progress| Box::pin(fetch(cancel, progress))) }

// 不派生 Debug，避免把下载正文或固定地址写进异常诊断。permit 始终与缓冲字节一同持有。
pub(super) struct Package {
    // 字段按声明顺序 drop：先释放正文，最后归还 permit。
    bytes: Vec<u8>, bound: BoundDownload, permit: OwnedSemaphorePermit,
    #[cfg(test)] before_write: Option<Arc<dyn Fn() + Send + Sync>>,
}
#[cfg(test)]
struct FixtureSink<S> { inner: S, before_write: Option<Arc<dyn Fn() + Send + Sync>> }
#[cfg(test)]
impl<S: ExportSink> std::io::Write for FixtureSink<S> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if let Some(before) = &self.before_write { before(); }
        self.inner.write(bytes)
    }
    fn flush(&mut self) -> std::io::Result<()> { self.inner.flush() }
}
#[cfg(test)]
impl<S: ExportSink> ExportSink for FixtureSink<S> {
    fn prepare(&mut self) -> Result<()> { self.inner.prepare() }
    fn sync_export(&mut self) -> Result<()> { self.inner.sync_export() }
}
impl Package {
    pub(super) fn bound(&self) -> &BoundDownload { &self.bound }
    #[cfg(test)]
    pub(super) fn with_write_fixture(mut self, before: Arc<dyn Fn() + Send + Sync>) -> Self {
        self.before_write = Some(before); self
    }

    pub(super) async fn write<S: ExportSink + Send + 'static>(self, output: S, cancel: Arc<Cancel>, progress: Progress) -> Result<u64> {
        cancel.check().map_err(|_| CANCELLED)?;
        let writer = tokio::task::spawn_blocking(move || {
            // 字节与 permit 一起移入 worker；异步发送失败也不会把大缓冲留在许可之外。
            let Self { bytes, bound, permit, #[cfg(test)] before_write } = self;
            #[cfg(test)] let output = FixtureSink { inner: output, before_write };
            let size = bound.size;
            let result = (move || {
                let (sender, receiver) = tokio::sync::mpsc::channel(2);
                // 空的双槽通道只放这两个项；全部入队后再运行同步 writer，不需要另起发送任务。
                sender.try_send(ExportChunk::Data(bytes)).map_err(|_| INVALID.to_owned())?;
                sender.try_send(ExportChunk::Finish).map_err(|_| INVALID.to_owned())?;
                drop(sender);
                // 网络已完成；本地写入保持 99%，仅真实事务发布成功后才发 100%。
                let writing: Progress = Arc::new(move |_, _| progress(size, size));
                super::export_writer(output, bound, receiver, cancel, writing)
            })();
            // output/通道/正文均已关闭或释放，最后归还缓冲槽。
            drop(permit);
            result
        });
        // 不 select/abort writer；错误、取消也必须等真实写入与 File drop 收尾。
        writer.await.map_err(|_| "离线翻译写入任务异常 / 離線翻譯寫入工作異常 / Offline translation writer failed".to_owned())?
    }
}

fn fixed_url(raw: &str) -> Result<Url> {
    if raw != FIXED_URL { return Err(INVALID.into()); }
    let url = Url::parse(raw).map_err(|_| INVALID)?;
    if url.scheme() != "https" || url.host_str() != Some("pan.johnnyblog.top") || url.port_or_known_default() != Some(443)
        || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(INVALID.into());
    }
    Ok(url)
}

async fn bounded<T>(cancel: &Cancel, deadline: Instant, work: impl Future<Output = Result<T>>) -> Result<T> {
    cancel.check().map_err(|_| CANCELLED)?;
    if Instant::now() >= deadline { return Err(TIMED_OUT.into()); }
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(CANCELLED.into()),
        result = tokio::time::timeout_at(deadline, work) => result.map_err(|_| TIMED_OUT.to_owned())?,
    }
}
async fn acquire(pool: Arc<Semaphore>, cancel: &Cancel, deadline: Instant) -> Result<OwnedSemaphorePermit> {
    bounded(cancel, deadline, async move { pool.acquire_owned().await.map_err(|_| SOURCE_ERROR.to_owned()) }).await
}

struct Head { length: Option<u64> }
impl Head {
    fn parse(status: StatusCode, headers: &header::HeaderMap) -> Result<Self> {
        // 包括 3xx 在内一律拒绝；不读取 Location 或服务端错误正文，也不把它们拼进错误。
        if status != StatusCode::OK { return Err(SOURCE_ERROR.into()); }
        if let Some(value) = headers.get(header::CONTENT_ENCODING) {
            if !value.to_str().map(|v| v.trim().eq_ignore_ascii_case("identity")).unwrap_or(false) { return Err(INVALID.into()); }
        }
        if let Some(value) = headers.get(header::CONTENT_TYPE) {
            let value = value.to_str().map_err(|_| INVALID)?;
            if value.len() > 256 { return Err(INVALID.into()); }
            let mime = value.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
            if mime.starts_with("text/") || mime.contains("json") || mime.contains("xml") { return Err(INVALID.into()); }
        }
        let all_lengths = headers.get_all(header::CONTENT_LENGTH);
        let mut lengths = all_lengths.iter();
        let length = lengths.next().map(|value| value.to_str().ok().and_then(|v| v.parse::<u64>().ok()).ok_or_else(|| INVALID.to_owned())).transpose()?;
        if lengths.next().is_some() { return Err(INVALID.into()); }
        if length == Some(0) { return Err(INVALID.into()); }
        if length.is_some_and(|n| n > MAX_BYTES as u64) { return Err(TOO_LARGE.into()); }
        Ok(Self { length })
    }
}

type Next<'a> = Pin<Box<dyn Future<Output = Result<Option<Vec<u8>>>> + Send + 'a>>;
trait Body: Send { fn next(&mut self, remaining: usize) -> Next<'_>; }
struct HttpBody(reqwest::Response);
impl Body for HttpBody {
    fn next(&mut self, remaining: usize) -> Next<'_> {
        Box::pin(async move {
            let chunk = self.0.chunk().await.map_err(|_| SOURCE_ERROR)?;
            match chunk {
                Some(bytes) if bytes.len() > remaining => Err(TOO_LARGE.into()),
                Some(bytes) => Ok(Some(bytes.to_vec())),
                None => Ok(None),
            }
        })
    }
}

async fn collect<B: Body>(head: Head, mut body: B, cancel: &Cancel, progress: &Progress, deadline: Instant, limit: usize) -> Result<Vec<u8>> {
    // limit 是内部预算；生产固定为 64 MiB，测试可缩小以验证流式越界而不分配大块内存。
    let limit = limit.min(MAX_BYTES);
    if head.length.is_some_and(|n| n > limit as u64) { return Err(TOO_LARGE.into()); }
    let mut bytes = Vec::new();
    progress(0, head.length.unwrap_or(0));
    loop {
        // 底层与收集器分别限制 chunk/累计大小，未知 Content-Length 也不能突破预算。
        let remaining = limit.saturating_sub(bytes.len());
        let chunk = bounded(cancel, deadline, body.next(remaining)).await?;
        let Some(chunk) = chunk else { break; };
        let len = bytes.len().checked_add(chunk.len()).ok_or(TOO_LARGE)?;
        if len > limit { return Err(TOO_LARGE.into()); }
        if head.length.is_some_and(|n| len as u64 > n) { return Err(TRUNCATED.into()); }
        bytes.try_reserve_exact(chunk.len()).map_err(|_| TOO_LARGE)?;
        bytes.extend_from_slice(&chunk);
        progress(bytes.len() as u64, head.length.unwrap_or(0));
    }
    cancel.check().map_err(|_| CANCELLED)?;
    if bytes.is_empty() { return Err(INVALID.into()); }
    if head.length.is_some_and(|n| bytes.len() as u64 != n) { return Err(TRUNCATED.into()); }
    Ok(bytes)
}

// 在 zip 库分配目录对象前限制普通单卷 ZIP 的 count/目录预算。
// 本专用源保守拒绝 ZIP64、自解压偏移和尾部歧义；不解压任何成员。
fn bounded_directory(bytes: &[u8], cancel: &Cancel) -> Result<usize> {
    if bytes.len() < 22 || bytes.len() > MAX_BYTES { return Err(INVALID.into()); }
    let tail_start = bytes.len().saturating_sub(65_557);
    let tail = &bytes[tail_start..]; let mut footer = None;
    for (at, magic) in tail.windows(4).enumerate() {
        if magic == b"PK\x06\x07" || magic == b"PK\x06\x06" { return Err(INVALID.into()); }
        if magic == b"PK\x05\x06" { if footer.replace(tail_start + at).is_some() { return Err(INVALID.into()); } }
    }
    let at = footer.ok_or(INVALID)?;
    if at > bytes.len() - 22 { return Err(INVALID.into()); }
    let word = |n: usize| u16::from_le_bytes([bytes[at+n], bytes[at+n+1]]) as usize;
    let dword = |n: usize| u32::from_le_bytes([bytes[at+n], bytes[at+n+1], bytes[at+n+2], bytes[at+n+3]]) as usize;
    let count = word(10); let size = dword(12); let offset = dword(16);
    if word(4) != 0 || word(6) != 0 || word(8) != count || count == 0 || count > MAX_ENTRIES
        || size > MAX_CENTRAL_BYTES || at + 22 + word(20) != bytes.len() || offset.checked_add(size) != Some(at) {
        return Err(INVALID.into());
    }
    let central = &bytes[offset..at]; let mut cursor = 0usize;
    for _ in 0..count {
        cancel.check().map_err(|_| CANCELLED)?;
        if cursor.checked_add(46).filter(|end| *end <= central.len()).is_none() || &central[cursor..cursor+4] != b"PK\x01\x02" { return Err(INVALID.into()); }
        let word = |n: usize| u16::from_le_bytes([central[cursor+n], central[cursor+n+1]]) as usize;
        let dword = |n: usize| u32::from_le_bytes([central[cursor+n], central[cursor+n+1], central[cursor+n+2], central[cursor+n+3]]);
        let name = word(28); let extra = word(30); let comment = word(32);
        if name == 0 || name > 4096 || word(34) != 0 || word(8) & 1 != 0 || !matches!(word(10), 0 | 8)
            || dword(20) == u32::MAX || dword(24) == u32::MAX || dword(42) == u32::MAX { return Err(INVALID.into()); }
        let end = cursor.checked_add(46 + name + extra + comment).filter(|end| *end <= central.len()).ok_or(INVALID)?;
        let mut position = cursor + 46 + name; let extra_end = position + extra;
        while position < extra_end {
            if position + 4 > extra_end { return Err(INVALID.into()); }
            let id = u16::from_le_bytes([central[position], central[position+1]]);
            let length = u16::from_le_bytes([central[position+2], central[position+3]]) as usize;
            if id == 1 { return Err(INVALID.into()); }
            position = position.checked_add(4 + length).filter(|end| *end <= extra_end).ok_or(INVALID)?;
        }
        cursor = end;
    }
    if cursor != central.len() { return Err(INVALID.into()); }
    Ok(count)
}

// 参数按逆序 drop：解析失败时也先释放 bytes，再归还缓冲许可。
fn package(permit: OwnedSemaphorePermit, bytes: Vec<u8>, cancel: &Cancel) -> Result<Package> {
    cancel.check().map_err(|_| CANCELLED)?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES || !bytes.starts_with(b"PK\x03\x04") { return Err(INVALID.into()); }
    let entries = bounded_directory(&bytes, cancel)?;
    {
        // 只读 ZIP 目录，不解压、不写盘、不加载 class。结构检查不是特定发行版的真实性证明。
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes.as_slice())).map_err(|_| INVALID)?;
        if archive.len() == 0 || archive.len() != entries { return Err(INVALID.into()); }
        let mut fabric = false;
        let mut code = false;
        for index in 0..archive.len() {
            cancel.check().map_err(|_| CANCELLED)?;
            let file = archive.by_index(index).map_err(|_| INVALID)?;
            if file.is_dir() { continue; }
            if file.name() == "fabric.mod.json" && file.size() > 0 && file.size() <= 256 * 1024 { fabric = true; }
            if file.name().ends_with(".class") && file.size() > 0 { code = true; }
        }
        if !fabric || !code { return Err(INVALID.into()); }
    }
    let size = bytes.len() as u64;
    let mut digest = Sha512::new();
    for part in bytes.chunks(64 * 1024) { cancel.check().map_err(|_| CANCELLED)?; digest.update(part); }
    // 不把固定地址写入通用 BoundDownload；该 source 不会通过通用官方源验证器。
    let bound = BoundDownload { source: "offline-translate", kind: "mod", url: String::new(), filename: FILENAME.into(), size,
        sha1: None, sha512: Some(format!("{:x}", digest.finalize())) };
    Ok(Package { bytes, bound, permit, #[cfg(test)] before_write: None })
}

async fn fetch(cancel: Arc<Cancel>, progress: Progress) -> Result<Package> {
    // 整体期限包含等待缓冲槽；网络 future 没有独立 spawn，取消会直接释放请求与内存。
    let deadline = Instant::now() + TOTAL_TIMEOUT;
    let pool = BUFFERS.get_or_init(|| Arc::new(Semaphore::new(2))).clone();
    let permit = acquire(pool, &cancel, deadline).await?;
    let url = fixed_url(FIXED_URL)?;
    let client = Client::builder().use_rustls_tls().https_only(true).no_proxy()
        .redirect(reqwest::redirect::Policy::none()).retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(5)).timeout(Duration::from_secs(90))
        .build().map_err(|_| SOURCE_ERROR)?;
    let response = bounded(&cancel, deadline, async {
        client.get(url).header(header::ACCEPT_ENCODING, "identity")
            .header(header::ACCEPT, "application/java-archive, application/zip, application/octet-stream")
            .send().await.map_err(|_| SOURCE_ERROR.to_owned())
    }).await?;
    let head = Head::parse(response.status(), response.headers())?;
    let bytes = collect(head, HttpBody(response), &cancel, &progress, deadline, MAX_BYTES).await?;
    let package = package(permit, bytes, &cancel)?;
    cancel.check().map_err(|_| CANCELLED)?;
    if Instant::now() >= deadline { return Err(TIMED_OUT.into()); }
    Ok(package)
}

#[cfg(test)]
pub(super) fn jar_fixture() -> Vec<u8> {
    use std::io::Write;
    let mut jar = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored).last_modified_time(zip::DateTime::default());
    jar.start_file("fabric.mod.json", options).unwrap();
    jar.write_all(br#"{"schemaVersion":1,"id":"synthetic-offline-translation","version":"fixture"}"#).unwrap();
    jar.start_file("fixture/NotExecutable.class", options).unwrap();
    jar.write_all(b"isolated synthetic fixture; not Java bytecode").unwrap();
    jar.finish().unwrap().into_inner()
}

#[cfg(test)]
pub(super) async fn fixture_package(bytes: Vec<u8>, cancel: Arc<Cancel>, progress: Progress, pool: Arc<Semaphore>) -> Result<Package> {
    struct One(Option<Vec<u8>>);
    impl Body for One { fn next(&mut self, _: usize) -> Next<'_> { Box::pin(std::future::ready(Ok(self.0.take()))) } }
    let deadline = Instant::now() + TOTAL_TIMEOUT;
    let permit = acquire(pool, &cancel, deadline).await?;
    let head = Head { length: Some(bytes.len() as u64) };
    let bytes = collect(head, One(Some(bytes)), &cancel, &progress, deadline, MAX_BYTES).await?;
    package(permit, bytes, &cancel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::VecDeque, io::{self, Write}, sync::{Mutex, atomic::{AtomicBool, Ordering}}};

    fn noop() -> Progress { Arc::new(|_, _| {}) }
    fn pool() -> Arc<Semaphore> { Arc::new(Semaphore::new(1)) }
    fn headers(length: Option<u64>) -> header::HeaderMap {
        let mut headers = header::HeaderMap::new();
        if let Some(length) = length { headers.insert(header::CONTENT_LENGTH, header::HeaderValue::from_str(&length.to_string()).unwrap()); }
        headers
    }
    struct Chunks(VecDeque<Result<Vec<u8>>>);
    impl Body for Chunks {
        fn next(&mut self, _: usize) -> Next<'_> { Box::pin(std::future::ready(self.0.pop_front().transpose())) }
    }
    fn chunks(values: &[&[u8]]) -> Chunks { Chunks(values.iter().map(|v| Ok(v.to_vec())).collect()) }

    #[test]
    fn offline_translate_fixed_source_and_filename_do_not_expand_official_sources() {
        let url = fixed_url(FIXED_URL).unwrap();
        assert!(url.scheme() == "https" && url.host_str() == Some("pan.johnnyblog.top"));
        assert_eq!(url.path().rsplit('/').next().unwrap(), FILENAME);
        for alternate in ["http://pan.johnnyblog.top/package.jar", "https://example.invalid/package.jar", "https://pan.johnnyblog.top/package.jar?sign=synthetic"] {
            let error = fixed_url(alternate).err().unwrap();
            assert!(!error.contains(alternate) && !error.contains("sign=") && !error.contains("https://"));
        }
        assert!(super::super::official_download_url(FIXED_URL, "modrinth").is_err());
        assert!(super::super::official_download_url(FIXED_URL, "curseforge").is_err());
    }

    #[test]
    fn offline_translate_headers_reject_redirects_error_bodies_and_large_lengths() {
        for status in [StatusCode::MOVED_PERMANENTLY, StatusCode::FOUND, StatusCode::TEMPORARY_REDIRECT, StatusCode::FORBIDDEN, StatusCode::NOT_FOUND, StatusCode::PARTIAL_CONTENT] {
            let mut value = headers(Some(4));
            value.insert(header::LOCATION, header::HeaderValue::from_static("https://example.invalid/?sign=synthetic"));
            let error = Head::parse(status, &value).err().unwrap();
            assert_eq!(error, SOURCE_ERROR); assert!(!error.contains("sign=") && !error.contains("https://"));
        }
        for size in [0, MAX_BYTES as u64 + 1, u64::MAX] { assert!(Head::parse(StatusCode::OK, &headers(Some(size))).is_err()); }
        for mime in ["text/html; charset=utf-8", "application/json", "application/problem+json", "application/xml"] {
            let mut value = headers(None); value.insert(header::CONTENT_TYPE, header::HeaderValue::from_static(mime));
            assert!(Head::parse(StatusCode::OK, &value).is_err());
        }
        let mut value = headers(Some(4)); value.append(header::CONTENT_LENGTH, header::HeaderValue::from_static("4"));
        assert!(Head::parse(StatusCode::OK, &value).is_err());
        let mut value = headers(None); value.insert(header::CONTENT_ENCODING, header::HeaderValue::from_static("gzip"));
        assert!(Head::parse(StatusCode::OK, &value).is_err());
        for mime in ["application/java-archive", "application/zip", "application/octet-stream"] {
            let mut value = headers(Some(4)); value.insert(header::CONTENT_TYPE, header::HeaderValue::from_static(mime));
            assert_eq!(Head::parse(StatusCode::OK, &value).unwrap().length, Some(4));
        }
    }

    #[tokio::test]
    async fn offline_translate_body_budget_checks_known_unknown_and_truncated_lengths() {
        let cancel = Cancel::default(); let progress = noop(); let deadline = Instant::now() + Duration::from_secs(2);
        for length in [Some(8), None] {
            let value = collect(Head { length }, chunks(&[b"123", b"45678"]), &cancel, &progress, deadline, 8).await.unwrap();
            assert_eq!(value, b"12345678");
        }
        for length in [Some(7), Some(9)] {
            assert_eq!(collect(Head { length }, chunks(&[b"12345678"]), &cancel, &progress, deadline, 16).await.unwrap_err(), TRUNCATED);
        }
        assert_eq!(collect(Head { length: None }, chunks(&[b"12345", b"6789"]), &cancel, &progress, deadline, 8).await.unwrap_err(), TOO_LARGE);
        assert_eq!(collect(Head { length: Some(9) }, chunks(&[b"unused"]), &cancel, &progress, deadline, 8).await.unwrap_err(), TOO_LARGE);
        assert_eq!(collect(Head { length: None }, chunks(&[]), &cancel, &progress, deadline, 8).await.unwrap_err(), INVALID);
        let failure = Chunks([Err(SOURCE_ERROR.to_owned())].into_iter().collect());
        assert_eq!(collect(Head { length: None }, failure, &cancel, &progress, deadline, 8).await.unwrap_err(), SOURCE_ERROR);
    }

    #[tokio::test]
    async fn offline_translate_jar_shape_and_self_hash_only_attest_current_bytes() {
        let pool = pool(); let cancel = Arc::new(Cancel::default()); let bytes = jar_fixture();
        let package = fixture_package(bytes.clone(), cancel.clone(), noop(), pool.clone()).await.unwrap();
        assert_eq!(pool.available_permits(), 0);
        assert_eq!(package.bound.filename, FILENAME); assert_eq!(package.bound.size, bytes.len() as u64);
        assert_eq!(package.bound.sha512.as_deref(), Some(format!("{:x}", Sha512::digest(&bytes)).as_str()));
        assert!(package.bound.url.is_empty() && package.bound.sha1.is_none());
        assert!(super::super::validate_export_bound(package.bound(), None).is_err());
        drop(package); assert_eq!(pool.available_permits(), 1);
        let mut jar = zip::ZipWriter::new(Cursor::new(Vec::new()));
        jar.start_file("ordinary.txt", zip::write::FileOptions::default()).unwrap(); jar.write_all(b"isolated synthetic ordinary archive").unwrap();
        let ordinary = jar.finish().unwrap().into_inner();
        for invalid in [Vec::new(), b"<!doctype html><html>synthetic error</html>".to_vec(), b"{\"error\":\"synthetic\"}".to_vec(), ordinary] {
            let error = fixture_package(invalid, cancel.clone(), noop(), pool.clone()).await.err().unwrap();
            assert_eq!(error, INVALID); assert_eq!(pool.available_permits(), 1);
        }
    }

    #[tokio::test]
    async fn offline_translate_buffer_wait_cancels_without_stealing_a_slot() {
        let pool = pool(); let package = fixture_package(jar_fixture(), Arc::new(Cancel::default()), noop(), pool.clone()).await.unwrap();
        let cancel = Cancel::default(); let mut wait = Box::pin(acquire(pool.clone(), &cancel, Instant::now() + Duration::from_secs(2)));
        tokio::select! { biased; _ = &mut wait => panic!("buffer wait did not remain queued"), _ = std::future::ready(()) => {} }
        cancel.stop(); let error = tokio::time::timeout(Duration::from_secs(1), wait).await.unwrap().err().unwrap();
        assert_eq!(error, CANCELLED); assert_eq!(pool.available_permits(), 0);
        drop(package); assert_eq!(pool.available_permits(), 1);
        assert_eq!(acquire(pool.clone(), &Cancel::default(), Instant::now() - Duration::from_millis(1)).await.err().unwrap(), TIMED_OUT);
        assert_eq!(pool.available_permits(), 1);
    }

    struct PendingBody { entered: Option<tokio::sync::oneshot::Sender<()>>, dropped: Arc<AtomicBool> }
    impl Body for PendingBody {
        fn next(&mut self, _: usize) -> Next<'_> {
            if let Some(entered) = self.entered.take() { let _ = entered.send(()); }
            Box::pin(std::future::pending())
        }
    }
    impl Drop for PendingBody { fn drop(&mut self) { self.dropped.store(true, Ordering::Release); } }

    #[tokio::test]
    async fn offline_translate_pending_body_cancel_or_drop_releases_its_buffer() {
        for stopped in [true, false] {
            let pool = pool(); let cancel = Arc::new(Cancel::default()); let dropped = Arc::new(AtomicBool::new(false));
            let (entered, seen) = tokio::sync::oneshot::channel(); let body = PendingBody { entered: Some(entered), dropped: dropped.clone() };
            let work_pool = pool.clone(); let work_cancel = cancel.clone();
            let mut waiting = Box::pin(async move {
                let _permit = acquire(work_pool, &work_cancel, Instant::now() + Duration::from_secs(2)).await?;
                collect(Head { length: None }, body, &work_cancel, &noop(), Instant::now() + Duration::from_secs(2), 16).await
            });
            tokio::select! { biased; _ = &mut waiting => panic!("pending body unexpectedly completed"), value = seen => value.unwrap() }
            assert_eq!(pool.available_permits(), 0);
            if stopped { cancel.stop(); assert_eq!(tokio::time::timeout(Duration::from_secs(1), waiting).await.unwrap().unwrap_err(), CANCELLED); }
            else { drop(waiting); }
            assert!(dropped.load(Ordering::Acquire)); assert_eq!(pool.available_permits(), 1);
        }
    }

    struct MemorySink { bytes: Arc<Mutex<Vec<u8>>>, closed: Arc<AtomicBool>, fail_write: bool, fail_sync: bool }
    impl Write for MemorySink {
        fn write(&mut self, value: &[u8]) -> io::Result<usize> {
            if self.fail_write { return Err(io::Error::from(io::ErrorKind::Other)); }
            self.bytes.lock().unwrap().extend_from_slice(value); Ok(value.len())
        }
        fn flush(&mut self) -> io::Result<()> { Ok(()) }
    }
    impl ExportSink for MemorySink {
        fn prepare(&mut self) -> Result<()> { Ok(()) }
        fn sync_export(&mut self) -> Result<()> { if self.fail_sync { Err("synthetic sync failure".into()) } else { Ok(()) } }
    }
    impl Drop for MemorySink { fn drop(&mut self) { self.closed.store(true, Ordering::Release); } }

    #[tokio::test]
    async fn offline_translate_writer_rechecks_size_hash_and_closes_before_return() {
        for mode in 0..6 {
            let pool = pool(); let cancel = Arc::new(Cancel::default()); let bytes = jar_fixture();
            let mut package = fixture_package(bytes.clone(), cancel.clone(), noop(), pool.clone()).await.unwrap();
            if mode == 1 { package.bound.sha512 = Some("0".repeat(128)); }
            if mode == 2 { package.bound.size += 1; }
            if mode == 5 { cancel.stop(); }
            let written = Arc::new(Mutex::new(Vec::new())); let closed = Arc::new(AtomicBool::new(false));
            let sink = MemorySink { bytes: written.clone(), closed: closed.clone(), fail_write: mode == 3, fail_sync: mode == 4 };
            let result = package.write(sink, cancel, noop()).await;
            assert!(closed.load(Ordering::Acquire)); assert_eq!(pool.available_permits(), 1);
            if mode == 0 { assert_eq!(result.unwrap(), bytes.len() as u64); assert_eq!(*written.lock().unwrap(), bytes); }
            else { assert!(result.is_err()); }
        }
    }
}

//! 整合包归档下载：逐跳校验 HTTPS 与 DNS，禁用代理和自动重定向。
use crate::downloads::{buffer_download_chunk, flush_download_buffer, DOWNLOAD_CHUNK_BUFFER, Cancel};
use sha2::{Digest, Sha256};
use std::{net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr}, sync::Arc, time::Duration};
use tokio::time::{Instant, timeout, timeout_at};

type Result<T> = std::result::Result<T, String>;
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_URL_BYTES: usize = 32 * 1024;
const MAX_DNS_ANSWERS: usize = 128;
const MAX_REDIRECTS: usize = 5;
const TOTAL_TIMEOUT: Duration = Duration::from_secs(180);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DNS_TIMEOUT: Duration = Duration::from_secs(10);
const READ_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Debug)]
struct ValidatedAddresses(Vec<SocketAddr>);

#[derive(Clone, Default)]
struct Resolver {
    #[cfg(test)]
    test_dialer: Option<TestDialer>,
}

#[cfg(test)]
#[derive(Clone)]
struct TestDialer {
    host: String,
    addresses: Vec<SocketAddr>,
    resolutions: Arc<std::sync::atomic::AtomicUsize>,
}

impl Resolver {
    fn production() -> Self {
        Self::default()
    }

    fn test_http_for(&self, host: &str) -> bool {
        #[cfg(test)]
        if let Some(dialer) = &self.test_dialer {
            return dialer.host == host && dialer.addresses.iter().all(|address| address.ip().is_loopback());
        }
        let _ = host;
        false
    }

    async fn resolve(&self, host: &str, port: u16) -> Result<ValidatedAddresses> {
        #[cfg(test)]
        if let Some(dialer) = &self.test_dialer {
            if dialer.host != host || !dialer.addresses.iter().all(|address| address.ip().is_loopback()) {
                return Err("测试拨号目标不匹配".into());
            }
            dialer.resolutions.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            return Ok(ValidatedAddresses(dialer.addresses.clone()));
        }
        resolve_public(host, port).await
    }
}

fn ipv4_in(ip: Ipv4Addr, network: Ipv4Addr, prefix: u32) -> bool {
    let value = u32::from(ip);
    let base = u32::from(network);
    let mask = if prefix == 0 { 0 } else { u32::MAX << (32 - prefix) };
    value & mask == base & mask
}

fn public_ipv4(ip: Ipv4Addr) -> bool {
    // IANA 特殊用途、私网、链路本地、文档、基准测试、组播和保留地址均不出站。
    [
        (Ipv4Addr::new(0, 0, 0, 0), 8),
        (Ipv4Addr::new(10, 0, 0, 0), 8),
        (Ipv4Addr::new(100, 64, 0, 0), 10),
        (Ipv4Addr::new(127, 0, 0, 0), 8),
        (Ipv4Addr::new(169, 254, 0, 0), 16),
        (Ipv4Addr::new(172, 16, 0, 0), 12),
        (Ipv4Addr::new(192, 0, 0, 0), 24),
        (Ipv4Addr::new(192, 0, 2, 0), 24),
        (Ipv4Addr::new(192, 88, 99, 0), 24),
        (Ipv4Addr::new(192, 168, 0, 0), 16),
        (Ipv4Addr::new(198, 18, 0, 0), 15),
        (Ipv4Addr::new(198, 51, 100, 0), 24),
        (Ipv4Addr::new(203, 0, 113, 0), 24),
        (Ipv4Addr::new(224, 0, 0, 0), 4),
        (Ipv4Addr::new(240, 0, 0, 0), 4),
    ].iter().all(|(network, prefix)| !ipv4_in(ip, *network, *prefix))
}

fn ipv6_in(ip: Ipv6Addr, network: Ipv6Addr, prefix: u32) -> bool {
    let value = u128::from(ip);
    let base = u128::from(network);
    let mask = if prefix == 0 { 0 } else { u128::MAX << (128 - prefix) };
    value & mask == base & mask
}

fn public_ipv6(ip: Ipv6Addr) -> bool {
    // 只接收全局单播 2000::/3，并拒绝协议分配、文档及 6to4/隧道前缀。
    ipv6_in(ip, Ipv6Addr::new(0x2000, 0, 0, 0, 0, 0, 0, 0), 3)
        && !ipv6_in(ip, Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0), 23)
        && !ipv6_in(ip, Ipv6Addr::new(0x2001, 0x0db8, 0, 0, 0, 0, 0, 0), 32)
        && !ipv6_in(ip, Ipv6Addr::new(0x2002, 0, 0, 0, 0, 0, 0, 0), 16)
        && !ipv6_in(ip, Ipv6Addr::new(0x3fff, 0, 0, 0, 0, 0, 0, 0), 20)
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(address) => public_ipv4(address),
        IpAddr::V6(address) => public_ipv6(address),
    }
}

fn parse_url(raw: &str, test_http: bool) -> Result<reqwest::Url> {
    if raw.is_empty() || raw.len() > MAX_URL_BYTES || raw.chars().any(char::is_control) || raw.bytes().any(|byte| byte <= 0x20 || byte == 0x7f) || raw.contains('\\') {
        return Err("整合包下载地址格式无效".into());
    }
    let url = reqwest::Url::parse(raw).map_err(|_| "整合包下载地址格式无效")?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("整合包下载地址包含禁止字段".into());
    }
    if url.host_str().is_none() {
        return Err("整合包下载地址缺少主机".into());
    }
    if test_http {
        #[cfg(test)]
        {
            let host = url.host_str().unwrap_or_default();
            let port = url.port();
            if url.scheme() == "http" && host == "fixture.invalid" && port.is_some() {
                return Ok(url);
            }
        }
    }
    if url.scheme() != "https" || url.port().is_some_and(|port| port != 443) {
        return Err("整合包下载只允许 HTTPS 标准端口".into());
    }
    Ok(url)
}

fn literal_ip(host: &str) -> Option<IpAddr> {
    host.strip_prefix('[').and_then(|value| value.strip_suffix(']')).unwrap_or(host).parse().ok()
}
/// 同步预检不发起 DNS；每一跳的实际 DNS 仍必须经过完整公网校验。
pub(super) fn validate_url(raw: &str) -> Result<()> {
    let url = parse_url(raw, false)?;
    let authority = raw.split_once("://").map(|(_, rest)| rest.split('/').next().unwrap_or("").split('?').next().unwrap_or("")).unwrap_or("");
    if authority.contains('@') { return Err("整合包下载地址包含禁止字段".into()); }
    if url.host_str().and_then(literal_ip).is_some_and(|ip| !public_ip(ip)) {
        return Err("下载主机不是可用公网地址".into());
    }
    Ok(())
}
async fn resolve_public(host: &str, port: u16) -> Result<ValidatedAddresses> {
    if host.is_empty() || host.len() > 253 || host.contains('%') {
        return Err("下载主机名无效".into());
    }
    let mut addresses = if let Some(ip) = literal_ip(host) {
        vec![SocketAddr::new(ip, port)]
    } else {
        let resolved = timeout(DNS_TIMEOUT, tokio::net::lookup_host((host, port)))
            .await.map_err(|_| "下载主机 DNS 查询超时")?
            .map_err(|_| "无法解析下载主机")?;
        let mut values = Vec::new();
        for address in resolved {
            if values.len() >= MAX_DNS_ANSWERS {
                return Err("下载主机 DNS 答案过多".into());
            }
            let address = SocketAddr::new(address.ip(), port);
            if !values.contains(&address) { values.push(address); }
        }
        values
    };
    if addresses.is_empty() {
        return Err("下载主机没有 DNS 地址".into());
    }
    if addresses.iter().any(|address| !public_ip(address.ip())) {
        return Err("下载主机解析到非公网或特殊用途地址".into());
    }
    addresses.sort();
    Ok(ValidatedAddresses(addresses))
}

async fn resolve_with_limits(resolver: &Resolver, host: &str, port: u16, deadline: Instant, cancel: &Cancel) -> Result<ValidatedAddresses> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() { return Err("整合包下载总时限已到".into()); }
    let limit = DNS_TIMEOUT.min(remaining);
    tokio::select! {
        _ = cancel.cancelled() => Err("整合包下载已取消".into()),
        _ = tokio::time::sleep(limit) => Err("下载主机 DNS 查询超时".into()),
        result = resolver.resolve(host, port) => result,
    }
}

fn build_client(url: &reqwest::Url, addresses: &ValidatedAddresses, remaining: Duration) -> Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT.min(remaining))
        .timeout(remaining.max(Duration::from_millis(1)))
        .user_agent("HCMCL-Tauri/0.7.6");
    if url.host_str().and_then(literal_ip).is_none() {
        let host = url.host_str().ok_or("下载地址缺少主机")?;
        builder = builder.resolve_to_addrs(host, &addresses.0);
    }
    builder.build().map_err(|_| "无法初始化整合包下载网络".to_owned())
}

async fn send_with_deadline(client: &reqwest::Client, url: reqwest::Url, deadline: Instant, cancel: &Cancel) -> Result<reqwest::Response> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() { return Err("整合包下载总时限已到".into()); }
    let request = client.get(url);
    tokio::select! {
        _ = cancel.cancelled() => Err("整合包下载已取消".into()),
        _ = timeout_at(deadline, std::future::pending::<()>()) => Err("整合包下载总时限已到".into()),
        result = request.send() => result.map_err(|error| if error.is_timeout() { "整合包下载连接超时".into() } else { "整合包下载连接失败".into() }),
    }
}

async fn download_with_resolver(
    raw_url: &str,
    file: &mut tokio::fs::File,
    cancel: Arc<Cancel>,
    progress: Arc<dyn Fn(u64, Option<u64>) + Send + Sync>,
    resolver: Resolver,
    max_bytes: u64,
) -> Result<(u64, String)> {
    if max_bytes == 0 || max_bytes > MAX_BYTES { return Err("整合包下载大小上限必须在 1 字节到 2 GiB 之间".into()); }
    let max_bytes = MAX_BYTES.min(max_bytes);
    let started = Instant::now();
    let deadline = started + TOTAL_TIMEOUT;
    let mut current = parse_url(raw_url, resolver.test_http_for("fixture.invalid"))?;
    let mut response = None;
    for hop in 0..=MAX_REDIRECTS {
        cancel.check()?;
        let test_http = resolver.test_http_for(current.host_str().unwrap_or_default());
        // URL 按每一跳重验；测试拨号器的 HTTP 例外仅在 cfg(test) 内可构造。
        current = parse_url(current.as_str(), test_http)?;
        let host = current.host_str().ok_or("下载地址缺少主机")?.to_string();
        let port = current.port_or_known_default().ok_or("下载端口无效")?;
        let addresses = resolve_with_limits(&resolver, &host, port, deadline, &cancel).await?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() { return Err("整合包下载总时限已到".into()); }
        let client = build_client(&current, &addresses, remaining)?;
        let reply = send_with_deadline(&client, current.clone(), deadline, &cancel).await?;
        if reply.status().is_redirection() {
            if hop == MAX_REDIRECTS { return Err("整合包下载重定向次数超过上限".into()); }
            let location = reply.headers().get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok()).ok_or("整合包重定向缺少有效地址")?;
            let next = current.join(location).map_err(|_| "整合包重定向地址无效")?;
            // 禁止 HTTPS 降级；下一轮会重新验证 DNS 并固定新地址。
            if next.scheme() != "https" && !(resolver.test_http_for(next.host_str().unwrap_or_default()) && next.scheme() == "http") {
                return Err("整合包重定向不得降级到非 HTTPS".into());
            }
            current = parse_url(next.as_str(), resolver.test_http_for(next.host_str().unwrap_or_default()))?;
            drop(reply);
            continue;
        }
        if reply.status().as_u16() != 200 {
            return Err(format!("整合包下载 HTTP {}", reply.status().as_u16()));
        }
        response = Some(reply);
        break;
    }
    let mut response = response.ok_or("整合包下载没有成功响应")?;
    let declared = response.content_length();
    if declared.is_some_and(|length| length > max_bytes) {
        return Err(if max_bytes == MAX_BYTES { "整合包下载超过 2 GiB 上限".into() } else { format!("整合包下载超过 {max_bytes} 字节上限") });
    }
    progress(0, declared);
    let mut received = 0u64;
    let mut digest = Sha256::new();
    let mut pending: Vec<u8> = Vec::with_capacity(DOWNLOAD_CHUNK_BUFFER);
    loop {
        cancel.check()?;
        if Instant::now() >= deadline { return Err("整合包下载总时限已到".into()); }
        let chunk = tokio::select! {
            _ = cancel.cancelled() => return Err("整合包下载已取消".into()),
            _ = timeout_at(deadline, std::future::pending::<()>()) => return Err("整合包下载总时限已到".into()),
            result = timeout(READ_TIMEOUT, response.chunk()) => result
                .map_err(|_| "整合包下载读取超过 20 秒")?
                .map_err(|_| "整合包下载读取失败")?,
        };
        let Some(chunk) = chunk else { break; };
        let next = received.checked_add(chunk.len() as u64).ok_or("整合包下载大小溢出")?;
        if next > max_bytes || declared.is_some_and(|length| next > length) {
            return Err(if max_bytes == MAX_BYTES { "整合包实际下载超过声明大小或 2 GiB 上限".into() } else { format!("整合包实际下载超过声明大小或 {max_bytes} 字节上限") });
        }
        cancel.check()?;
        // 写入期间不 select 取消/超时：先等 Tokio File 的后台写和 flush 真正结束。
        buffer_download_chunk(file, &mut pending, &chunk).await.map_err(|_| "整合包下载写入失败")?;
        digest.update(&chunk);
        received = next;
        progress(received, declared);
        cancel.check()?;
        if Instant::now() >= deadline { return Err("整合包下载总时限已到".into()); }
    }
    flush_download_buffer(file, &mut pending).await.map_err(|_| "整合包下载刷新落盘失败")?;
    if declared.is_some_and(|length| length != received) {
        return Err("整合包实际下载长度与 Content-Length 不符".into());
    }
    // 等待底层文件句柄同步收尾，不让调用方在写操作仍 pending 时删除临时文件。
    file.sync_all().await.map_err(|_| "整合包下载文件同步失败")?;
    cancel.check()?;
    if Instant::now() >= deadline { return Err("整合包下载总时限已到".into()); }
    let sha256 = format!("{:x}", digest.finalize());
    Ok((received, sha256))
}

/// 每一跳重新解析并验证全部 DNS 答案，再将 reqwest 的连接固定到已验证地址。
pub(super) async fn download(
    url: &str,
    file: &mut tokio::fs::File,
    cancel: Arc<Cancel>,
    progress: Arc<dyn Fn(u64, Option<u64>) + Send + Sync>,
) -> Result<(u64, String)> {
    download_limited(url, file, cancel, progress, MAX_BYTES).await
}

/// 整合包成员可使用更小上限；上限无效时不解析地址、不联网也不写文件。
pub(super) async fn download_limited(
    url: &str,
    file: &mut tokio::fs::File,
    cancel: Arc<Cancel>,
    progress: Arc<dyn Fn(u64, Option<u64>) + Send + Sync>,
    max_bytes: u64,
) -> Result<(u64, String)> {
    download_with_resolver(url, file, cancel, progress, Resolver::production(), max_bytes).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::{Read, Write}, net::TcpListener, sync::atomic::AtomicUsize, thread};

    #[test]
    fn https_url_validation_rejects_credentials_fragments_controls_and_nonstandard_ports() {
        assert!(parse_url("https://example.invalid/archive.zip?sig=x", false).is_ok());
        for raw in [
            "http://example.invalid/a", "https://user@example.invalid/a", "https://user:pass@example.invalid/a",
            "https://example.invalid/a#fragment", "https://example.invalid:444/a", "https://example.invalid/a\n",
        ] { assert!(parse_url(raw, false).is_err(), "{raw:?}"); }
        assert!(parse_url(&format!("https://example.invalid/{}", "x".repeat(MAX_URL_BYTES)), false).is_err());
    }

    #[test]
    fn public_address_filter_rejects_private_reserved_and_transition_ranges() {
        for ip in ["0.0.0.1", "10.2.3.4", "100.64.1.1", "127.0.0.1", "169.254.1.2", "172.16.0.1", "192.0.0.1", "192.0.2.1", "192.168.1.2", "198.18.0.1", "198.51.100.1", "203.0.113.2", "224.0.0.1", "240.0.0.1", "::", "::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "fc00::1", "fe80::1", "2001::1", "2001:db8::1", "2002:0808:0808::1", "3fff::1"] {
            assert!(!public_ip(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"] {
            assert!(public_ip(ip.parse().unwrap()), "{ip}");
        }
    }

    #[tokio::test]
    async fn dns_validation_rejects_all_answers_if_any_answer_is_not_public() {
        let good: Vec<SocketAddr> = vec!["8.8.8.8:443".parse().unwrap(), "1.1.1.1:443".parse().unwrap()];
        assert!(good.iter().all(|addr| public_ip(addr.ip())));
        let mixed = [good[0], "127.0.0.1:443".parse().unwrap()];
        assert!(mixed.iter().any(|addr| !public_ip(addr.ip())), "DNS 答案必须整体拒绝，不能只挑公网地址");
        assert!(resolve_public("127.0.0.1", 443).await.is_err());
    }

    fn local_server(responses: Vec<(u16, Vec<(String, String)>, Vec<u8>)>) -> (u16, thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let worker = thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, headers, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                stream.set_write_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut request = Vec::new();
                let mut byte = [0u8; 1];
                while !request.ends_with(b"\r\n\r\n") && request.len() < 32 * 1024 {
                    if stream.read_exact(&mut byte).is_err() { break; }
                    request.push(byte[0]);
                }
                requests.push(String::from_utf8_lossy(&request).lines().next().unwrap_or("").to_string());
                let reason = if status == 302 { "Found" } else { "OK" };
                let chunked = headers.iter().any(|(key, value)| key.eq_ignore_ascii_case("transfer-encoding") && value.eq_ignore_ascii_case("chunked"));
                let mut response = format!("HTTP/1.1 {status} {reason}\r\nConnection: close\r\n");
                if !chunked { response.push_str(&format!("Content-Length: {}\r\n", body.len())); }
                for (key, value) in headers { response.push_str(&format!("{key}: {value}\r\n")); }
                response.push_str("\r\n");
                let mut response = response.into_bytes();
                response.extend_from_slice(&body);
                stream.write_all(&response).unwrap();
                stream.flush().unwrap();
            }
            requests
        });
        (port, worker)
    }

    #[tokio::test]
    async fn loopback_redirect_re_resolves_and_download_hashes_written_bytes() {
        let body = b"fixture archive only".to_vec();
        let (port, server) = local_server(vec![
            (302, vec![("Location".into(), "/final".into())], Vec::new()),
            (200, vec![], body.clone()),
        ]);
        let resolutions = Arc::new(AtomicUsize::new(0));
        let resolver = Resolver { test_dialer: Some(TestDialer {
            host: "fixture.invalid".into(), addresses: vec![SocketAddr::from(([127, 0, 0, 1], port))], resolutions: resolutions.clone(),
        }) };
        let path = std::env::temp_dir().join(format!("hcmcl-network-{}.part", uuid::Uuid::new_v4()));
        let mut file = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&path).await.unwrap();
        let updates = Arc::new(std::sync::Mutex::new(Vec::new()));
        let capture = updates.clone();
        let result = download_with_resolver(
            &format!("http://fixture.invalid:{port}/start"), &mut file, Arc::new(Cancel::default()),
            Arc::new(move |bytes, total| capture.lock().unwrap().push((bytes, total))), resolver, MAX_BYTES,
        ).await.unwrap();
        drop(file);
        let requests = server.join().unwrap();
        let _ = std::fs::remove_file(path);
        assert_eq!(requests, ["GET /start HTTP/1.1", "GET /final HTTP/1.1"]);
        assert_eq!(resolutions.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(result.0, body.len() as u64);
        assert_eq!(result.1, format!("{:x}", Sha256::digest(&body)));
        assert!(updates.lock().unwrap().iter().any(|(count, total)| *count == body.len() as u64 && *total == Some(body.len() as u64)));
    }

    #[tokio::test]
    async fn loopback_limited_download_rejects_declared_and_chunked_bodies_over_limit() {
        for chunked in [false, true] {
            let body = if chunked { b"3\r\nabc\r\n3\r\ndef\r\n0\r\n\r\n".to_vec() } else { b"abcdef".to_vec() };
            let headers = if chunked { vec![("Transfer-Encoding".into(), "chunked".into())] } else { vec![] };
            let (port, server) = local_server(vec![(200, headers, body)]);
            let resolutions = Arc::new(AtomicUsize::new(0));
            let resolver = Resolver { test_dialer: Some(TestDialer {
                host: "fixture.invalid".into(), addresses: vec![SocketAddr::from(([127, 0, 0, 1], port))], resolutions: resolutions.clone(),
            }) };
            let path = std::env::temp_dir().join(format!("hcmcl-network-limited-{}.part", uuid::Uuid::new_v4()));
            let mut file = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&path).await.unwrap();
            let updates = Arc::new(std::sync::Mutex::new(Vec::new()));
            let capture = updates.clone();
            let result = download_with_resolver(
                &format!("http://fixture.invalid:{port}/limited"), &mut file, Arc::new(Cancel::default()),
                Arc::new(move |bytes, total| capture.lock().unwrap().push((bytes, total))), resolver, 4,
            ).await;
            drop(file);
            let requests = server.join().unwrap();
            let written = std::fs::read(&path).unwrap();
            std::fs::remove_file(&path).unwrap();
            assert_eq!(requests, ["GET /limited HTTP/1.1"]);
            assert_eq!(resolutions.load(std::sync::atomic::Ordering::SeqCst), 1);
            assert!(result.unwrap_err().contains("4 字节上限"), "chunked={chunked}");
            assert!(written.len() <= 4, "超限块不得写入文件");
            let updates = updates.lock().unwrap();
            assert!(updates.iter().all(|(bytes, _)| *bytes <= 4));
            if chunked {
                assert!(updates.iter().all(|(_, total)| total.is_none()));
                assert!(!updates.is_empty(), "chunked 响应应通过声明长度预检后才由逐块上限拒绝");
            } else {
                assert!(written.is_empty());
                assert!(updates.is_empty(), "Content-Length 超限应在下载进度和写入前拒绝");
            }
        }
    }

    #[tokio::test]
    async fn limited_download_invalid_limits_return_before_resolve_progress_or_file_io() {
        let path = std::env::temp_dir().join(format!("hcmcl-network-invalid-limit-{}.part", uuid::Uuid::new_v4()));
        let mut file = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&path).await.unwrap();
        let resolutions = Arc::new(AtomicUsize::new(0));
        let updates = Arc::new(AtomicUsize::new(0));
        let resolver = Resolver { test_dialer: Some(TestDialer {
            host: "fixture.invalid".into(), addresses: vec![SocketAddr::from(([127, 0, 0, 1], 1))], resolutions: resolutions.clone(),
        }) };
        for limit in [0, MAX_BYTES + 1] {
            let capture = updates.clone();
            let result = download_with_resolver(
                "http://fixture.invalid:1/unused", &mut file, Arc::new(Cancel::default()),
                Arc::new(move |_, _| { capture.fetch_add(1, std::sync::atomic::Ordering::SeqCst); }), resolver.clone(), limit,
            ).await;
            assert!(result.unwrap_err().contains("大小上限必须"));
            let result = download_limited(
                "地址不应被解析", &mut file, Arc::new(Cancel::default()),
                Arc::new(|_, _| panic!("无效上限不得产生进度")), limit,
            ).await;
            assert!(result.unwrap_err().contains("大小上限必须"));
        }
        drop(file);
        let written = std::fs::read(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(written.is_empty());
        assert_eq!(resolutions.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(updates.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[test]
    fn production_path_never_accepts_test_http_exception() {
        let resolver = Resolver::production();
        assert!(!resolver.test_http_for("fixture.invalid"));
        assert!(parse_url("http://fixture.invalid:12345/archive", false).is_err());
        assert_eq!(MAX_REDIRECTS, 5);
        assert_eq!(MAX_BYTES, 2 * 1024 * 1024 * 1024);
    }
}

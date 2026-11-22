//! 主页市场的固定业务客户端；构造时不联网，不接触本地仓库。
use super::{tr, Result, MAX_MARKET_SIZE};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::{header::CONTENT_TYPE, RequestBuilder, Url};
use serde::{de::DeserializeOwned, Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, future::Future, time::Duration};
use tokio::time::Instant;
use url::Host;

const DEFAULT_SERVER: &str = "https://hcmcl.johnnyblog.top";
const MAX_URL_BYTES: usize = 4096;
const MAX_MARKET_ROWS: usize = 1024;
const MAX_MARKET_JSON: usize = 8 * 1024 * 1024;
const MAX_SMALL_JSON: usize = 16 * 1024;
const MAX_SUBMIT_BYTES: usize = 2 * 1024 * 1024;
const MAX_SUBMIT_REQUEST: usize = base64_cap(MAX_SUBMIT_BYTES) + 32 * 1024;
const MAX_NAME: usize = 512;
const MAX_DESCRIPTION: usize = 4096;
const MAX_VERSION: usize = 128;
const MAX_JS_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_CODE_SECONDS: u64 = 86_400;
const ACTION_TIMEOUT: Duration = Duration::from_secs(20);

pub(super) struct Client {
    http: reqwest::Client,
    api: Url,
    action_timeout: Duration,
}

impl Client {
    pub(super) fn new(settings: &Value) -> Result<Self> {
        match settings.get("mode").and_then(Value::as_str) {
            Some("normal" | "minimal") => {}
            Some("local") => return Err(tr(
                "本地模式已关闭主页联网功能",
                "本機模式已關閉主頁連線功能",
                "Homepage networking is disabled in local mode",
            )),
            _ => return Err(tr("主页联网模式无效", "主頁連線模式無效", "Invalid homepage network mode")),
        }
        let api = service_endpoint(settings)?;
        let http = reqwest::Client::builder()
            .use_rustls_tls()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .user_agent("HCMCL-Tauri/1")
            .build()
            .map_err(|_| tr("无法初始化主页网络", "無法初始化主頁網路", "Could not initialize homepage networking"))?;
        Ok(Self { http, api, action_timeout: ACTION_TIMEOUT })
    }

    // 直接在调用方的 future 中执行。丢弃等待方或到达时限即丢弃在途请求，
    // 不会另起任务继续后续请求；已被服务端受理的 POST 无法撤回。
    async fn within_action<T, F: Future<Output = Result<T>>>(&self, work: impl FnOnce(Instant) -> F) -> Result<T> {
        let deadline = Instant::now() + self.action_timeout;
        let result = tokio::time::timeout_at(deadline, work(deadline)).await.map_err(|_| timeout_error())?;
        check_deadline(deadline)?;
        result
    }

    fn endpoint(&self, action: &'static str) -> Url {
        let mut url = self.api.clone();
        url.query_pairs_mut().append_pair("action", action);
        url
    }

    fn post(&self, action: &'static str, body: &impl Serialize, cap: usize) -> Result<RequestBuilder> {
        let bytes = serde_json::to_vec(body).map_err(|_| submit_input_error())?;
        if bytes.len() > cap {
            return Err(tr("主页请求体过大", "主頁請求內容過大", "Homepage request body is too large"));
        }
        Ok(self.http.post(self.endpoint(action)).header(CONTENT_TYPE, "application/json").body(bytes))
    }

    async fn market_entries(&self) -> Result<Vec<MarketScript>> {
        let list = read_json(self.http.get(self.endpoint("market_list")), MAX_MARKET_JSON).await?;
        normalize_market(list, &self.api)
    }

    pub(super) async fn market(&self) -> Result<Value> {
        self.within_action(|_| async {
            serde_json::to_value(self.market_entries().await?).map_err(|_| response_error())
        }).await
    }

    pub(super) async fn verify(&self, id: &str, sha: &str) -> Result<Value> {
        self.within_action(|_| async {
            if !valid_id(id) {
                return Err(tr("主页编号格式无效", "主頁編號格式無效", "Invalid homepage script identifier"));
            }
            let sha = normalize_sha(sha).ok_or_else(hash_error)?;
            let mut url = self.endpoint("script_verify");
            url.query_pairs_mut().append_pair("id", id).append_pair("sha256", &sha);
            let reply = read_json(self.http.get(url), MAX_SMALL_JSON).await?;
            normalize_verify(reply, id)
        }).await
    }

    pub(super) async fn download(&self, url: &str, expected_sha: Option<&str>) -> Result<Vec<u8>> {
        self.within_action(|deadline| async move {
            let url = market_url(url, &self.api).ok_or_else(download_url_error)?;
            let expected = expected_sha.map(|sha| normalize_sha(sha).ok_or_else(hash_error)).transpose()?;
            // 每次重新读取同一规范化清单；仅用实际出现在清单中的完整地址（包括查询串）。
            let item = self.market_entries().await?.into_iter()
                .find(|item| item.url == url.as_str())
                .ok_or_else(download_url_error)?;
            let market_sha = (!item.sha256.is_empty()).then_some(item.sha256.as_str());
            if matches!((expected.as_deref(), market_sha), (Some(a), Some(b)) if a != b) {
                return Err(tr(
                    "主页市场记录已变更，请刷新后重试",
                    "主頁市場記錄已變更，請重新整理後再試",
                    "The homepage market record changed; refresh and try again",
                ));
            }
            check_deadline(deadline)?;
            let bytes = read_bounded(self.http.get(item.url), MAX_MARKET_SIZE as usize, market_size_error).await?;
            if let Some(sha) = expected.as_deref().or(market_sha) {
                if !hash_matches(&bytes, sha) { return Err(hash_error()); }
            }
            if !looks_like_html(&bytes) { return Err(html_error()); }
            Ok(bytes)
        }).await
    }

    pub(super) async fn email_code(&self, email: &str) -> Result<Value> {
        self.within_action(|_| async {
            let email = checked_email(email)?;
            let request = self.post("email_send_code", &json!({"email": email}), 1024)?;
            normalize_email_reply(read_json(request, MAX_SMALL_JSON).await?)
        }).await
    }

    pub(super) async fn submit(&self, payload: &Value) -> Result<Value> {
        self.within_action(|deadline| async move {
            // 在首次联网之前验证所有本地参数，避免无效参数触发请求。
            let (body, size) = submit_body(payload)?;
            check_deadline(deadline)?;
            let limits: Limits = read_json(self.http.get(self.endpoint("limits")), MAX_SMALL_JSON).await?;
            let cap = submission_limit(limits)?;
            if size > cap {
                return Err(submit_size_error());
            }
            let request = self.post("market_submit", &body, MAX_SUBMIT_REQUEST)?;
            check_deadline(deadline)?;
            // limits 约束投稿原文；服务端注入编号后可能增加正文长度，回包另用本地上限。
            // PHP 的 JSON 可把 Base64 内的斜杠转义，解码前仍按原 Base64 预算验证。
            let bytes = read_bounded(request, 2 * base64_cap(MAX_SUBMIT_BYTES) + MAX_SMALL_JSON, response_size_error).await?;
            let reply = serde_json::from_slice(&bytes).map_err(|_| submit_reply_error())?;
            normalize_submit_reply(reply, body.visibility, MAX_SUBMIT_BYTES)
        }).await
    }
}

fn service_endpoint(settings: &Value) -> Result<Url> {
    let raw = match settings.get("serverUrl") {
        None | Some(Value::Null) => DEFAULT_SERVER,
        Some(Value::String(raw)) if raw.len() <= MAX_URL_BYTES && !raw.chars().any(char::is_control) => {
            if raw.trim().is_empty() { DEFAULT_SERVER } else { raw.trim() }
        }
        _ => return Err(server_url_error()),
    };
    let mut url = parse_http_url(raw).filter(|url| {
        url.query().is_none() && (url.scheme() == "https" || is_loopback(url))
    }).ok_or_else(server_url_error)?;
    url.path_segments_mut().map_err(|_| server_url_error())?.pop_if_empty().push("api.php");
    if url.as_str().len() > MAX_URL_BYTES { return Err(server_url_error()); }
    Ok(url)
}

fn parse_http_url(raw: &str) -> Option<Url> {
    if raw.len() > MAX_URL_BYTES || raw.chars().any(|c| c == '\\' || c.is_whitespace() || c.is_control()) {
        return None;
    }
    let (scheme, rest) = raw.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("https") && !scheme.eq_ignore_ascii_case("http") { return None; }
    let authority = rest.split(['/', '?', '#']).next()?;
    // 即使没有填写账号或密码，也不接受带 @ 的用户信息段。
    if authority.is_empty() || authority.contains('@') { return None; }
    let url = Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "https" | "http") || url.host().is_none()
        || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some()
        || url.as_str().len() > MAX_URL_BYTES
    {
        return None;
    }
    Some(url)
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        Some(Host::Domain(host)) => host == "localhost",
        None => false,
    }
}

fn market_url(raw: &str, api: &Url) -> Option<Url> {
    let url = parse_http_url(raw)?;
    (url.scheme() == "https" || (is_loopback(&url) && url.origin() == api.origin())).then_some(url)
}

fn server_url_error() -> String {
    tr(
        "主页服务地址须使用 HTTPS 或回环 HTTP，且不能包含账号、密码、查询参数或片段",
        "主頁服務位址須使用 HTTPS 或回環 HTTP，且不得包含帳號、密碼、查詢參數或片段",
        "The homepage service URL must use HTTPS or loopback HTTP, with no credentials, query or fragment",
    )
}

fn download_url_error() -> String {
    tr(
        "该下载地址不在当前主页市场清单中，请刷新后重试",
        "此下載位址不在目前主頁市場清單中，請重新整理後再試",
        "The download URL is not in the current homepage market; refresh and try again",
    )
}

fn response_error() -> String {
    tr("主页服务响应格式无效", "主頁服務回應格式無效", "Invalid homepage service response")
}

fn response_size_error() -> String {
    tr("主页服务响应体过大", "主頁服務回應內容過大", "Homepage service response is too large")
}

fn market_size_error() -> String {
    tr("市场脚本超过 512 KiB 上限", "市場指令碼超過 512 KiB 上限", "Market script exceeds the 512 KiB limit")
}

fn submit_size_error() -> String {
    tr("投稿脚本超过当前大小上限", "投稿指令碼超過目前大小上限", "Submitted script exceeds the current size limit")
}

fn submit_input_error() -> String {
    tr("主页投稿参数格式无效或超限", "主頁投稿參數格式無效或超限", "Invalid or oversized homepage submission fields")
}

fn submit_reply_error() -> String {
    tr(
        "无法核对投稿结果，请先确认服务端是否已受理再重试",
        "無法核對投稿結果，請先確認服務端是否已受理再試",
        "Could not validate the submission result; check whether the server accepted it before retrying",
    )
}

fn html_error() -> String {
    tr("主页脚本必须是非空的 UTF-8 HTML", "主頁指令碼必須是非空的 UTF-8 HTML", "A homepage script must be nonempty UTF-8 HTML")
}

fn hash_error() -> String {
    tr("主页脚本 SHA-256 无效或不匹配", "主頁指令碼 SHA-256 無效或不相符", "The homepage script SHA-256 is invalid or does not match")
}

fn timeout_error() -> String {
    tr("主页网络请求超时", "主頁網路請求逾時", "Homepage network request timed out")
}

fn check_deadline(deadline: Instant) -> Result<()> {
    if Instant::now() >= deadline { Err(timeout_error()) } else { Ok(()) }
}

fn network_error(error: reqwest::Error) -> String {
    // reqwest 错误可能带请求 URL；服务端错误正文也不能回显。
    if error.is_timeout() {
        timeout_error()
    } else {
        tr("主页网络请求失败，请检查网络或稍后重试", "主頁網路請求失敗，請檢查網路或稍後再試", "Homepage network request failed; check your connection or try again later")
    }
}

async fn read_bounded(request: RequestBuilder, cap: usize, too_large: fn() -> String) -> Result<Vec<u8>> {
    let mut response = request.send().await.map_err(network_error)?;
    let status = response.status();
    if status.is_redirection() {
        return Err(tr("主页服务重定向已拒绝", "已拒絕主頁服務重新導向", "Homepage service redirect was refused"));
    }
    if status != reqwest::StatusCode::OK && status != reqwest::StatusCode::CREATED {
        let status = status.as_u16();
        return Err(tr(
            &format!("主页服务请求失败（HTTP {status}）"),
            &format!("主頁服務請求失敗（HTTP {status}）"),
            &format!("Homepage service request failed (HTTP {status})"),
        ));
    }
    if response.content_length().is_some_and(|len| len > cap as u64) { return Err(too_large()); }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if chunk.len() > cap - body.len() { return Err(too_large()); }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn read_json<T: DeserializeOwned>(request: RequestBuilder, cap: usize) -> Result<T> {
    let bytes = read_bounded(request, cap, response_size_error).await?;
    serde_json::from_slice(&bytes).map_err(|_| response_error())
}

// 与 Electron 的生产校验一致：兼容历史编号，另限制总长；六位大写是常用展示格式。
fn valid_id(id: &str) -> bool {
    id.len() <= 64 && id.strip_prefix("HC-")
        .is_some_and(|tail| tail.len() >= 4 && tail.bytes().all(|b| b.is_ascii_alphanumeric()))
}

fn normalize_sha(sha: &str) -> Option<String> {
    (sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_hexdigit())).then(|| sha.to_ascii_lowercase())
}

fn hash_matches(bytes: &[u8], sha: &str) -> bool {
    format!("{:x}", Sha256::digest(bytes)) == sha
}

fn valid_text(text: &str, cap: usize, multiline: bool) -> bool {
    text.len() <= cap && !text.chars().any(|c| c.is_control() && !(multiline && matches!(c, '\n' | '\r' | '\t')))
}

#[derive(Deserialize)]
struct MarketList {
    #[serde(default)]
    ok: Option<bool>,
    scripts: Vec<MarketScript>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MarketScript {
    id: String,
    name: String,
    author: String,
    description: String,
    version: String,
    #[serde(default, deserialize_with = "empty_legacy_sha")]
    sha256: String,
    size: u64,
    downloads: u64,
    updated_at: u64,
    url: String,
}

fn empty_legacy_sha<'de, D: Deserializer<'de>>(deserializer: D) -> std::result::Result<String, D::Error> {
    Ok(Option::<String>::deserialize(deserializer)?.unwrap_or_default())
}

fn normalize_market(mut list: MarketList, api: &Url) -> Result<Vec<MarketScript>> {
    if list.ok == Some(false) { return Err(response_error()); }
    if list.scripts.len() > MAX_MARKET_ROWS { return Err(response_size_error()); }
    let mut ids = HashSet::with_capacity(list.scripts.len());
    let mut urls = HashSet::with_capacity(list.scripts.len());
    for item in &mut list.scripts {
        if !valid_id(&item.id) || !valid_text(&item.name, MAX_NAME, false)
            || !valid_text(&item.author, MAX_NAME, false) || !valid_text(&item.description, MAX_DESCRIPTION, true)
            || !valid_text(&item.version, MAX_VERSION, false) || item.size > MAX_MARKET_SIZE
            || item.downloads > MAX_JS_INTEGER || item.updated_at > MAX_JS_INTEGER
        {
            return Err(response_error());
        }
        if !item.sha256.is_empty() { item.sha256 = normalize_sha(&item.sha256).ok_or_else(response_error)?; }
        item.url = market_url(&item.url, api).ok_or_else(response_error)?.to_string();
        // 同一编号或同一地址的多条记录会使校验/下载歧义，不能用于授权。
        if !ids.insert(item.id.as_str()) || !urls.insert(item.url.as_str()) { return Err(response_error()); }
    }
    Ok(list.scripts)
}

#[derive(Deserialize)]
struct VerifyReply {
    ok: bool,
    verified: bool,
    // Value 的默认缺字段行为等同 null；这里要求服务端明确给出该字段。
    #[serde(deserialize_with = "required_json_value")]
    script: Value,
}

fn required_json_value<'de, D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Value, D::Error> {
    Value::deserialize(deserializer)
}

fn normalize_verify(reply: VerifyReply, id: &str) -> Result<Value> {
    let script = match reply.script {
        Value::Null if !reply.verified => Value::Null,
        Value::Object(script) if script.get("id").and_then(Value::as_str) == Some(id) => json!({"id": id}),
        _ => return Err(response_error()),
    };
    if reply.verified && !reply.ok { return Err(response_error()); }
    Ok(json!({"ok": reply.ok, "verified": reply.verified, "script": script}))
}

fn checked_email(raw: &str) -> Result<&str> {
    let error = || tr("邮箱格式无效", "電子郵件格式無效", "Invalid email address");
    if !valid_text(raw, 254, false) { return Err(error()); }
    let email = raw.trim();
    let (name, domain) = email.split_once('@').ok_or_else(error)?;
    if name.is_empty() || name.len() > 64 || name.starts_with('.') || name.ends_with('.') || name.contains("..")
        || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b".!#$%&'*+/=?^_`{|}~-".contains(&b))
        || !domain.contains('.') || !domain.split('.').all(|label| {
            let bytes = label.as_bytes();
            !bytes.is_empty() && bytes.len() <= 63 && bytes[0].is_ascii_alphanumeric()
                && bytes[bytes.len() - 1].is_ascii_alphanumeric()
                && bytes.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'-')
        })
    {
        return Err(error());
    }
    Ok(email)
}

fn seconds(value: Option<&Value>) -> u64 {
    value.and_then(|v| v.as_u64().or_else(|| {
        let s = v.as_str()?.trim();
        (s.len() <= 10 && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse::<u64>().ok()).flatten()
    })).unwrap_or(0).min(MAX_CODE_SECONDS)
}

fn normalize_email_reply(reply: Value) -> Result<Value> {
    let reply = reply.as_object().ok_or_else(response_error)?;
    Ok(json!({
        "ok": reply.get("ok").and_then(Value::as_bool) == Some(true),
        "ttl": seconds(reply.get("ttl")),
        "cooldown": seconds(reply.get("cooldown")),
    }))
}

const fn base64_cap(bytes: usize) -> usize { 4 * ((bytes + 2) / 3) }

fn looks_like_html(bytes: &[u8]) -> bool {
    if bytes.is_empty() || bytes.contains(&0) || std::str::from_utf8(bytes).is_err() { return false; }
    // 与既有导入相同，仅用前 4 KiB 判断 HTML 外观；不执行、不重编码正文。
    let head = &bytes[..bytes.len().min(4096)];
    head.windows(2).any(|pair| pair[0] == b'<' && (pair[1].is_ascii_alphabetic() || pair[1] == b'!'))
        || head.windows(b"@hcpage".len()).any(|part| part == b"@hcpage")
}

fn decode_html(content: &str, cap: usize) -> Result<Vec<u8>> {
    if content.len() > base64_cap(cap) { return Err(submit_size_error()); }
    let bytes = STANDARD.decode(content).map_err(|_| html_error())?;
    if bytes.len() > cap { return Err(submit_size_error()); }
    if !looks_like_html(&bytes) { return Err(html_error()); }
    Ok(bytes)
}

fn valid_filename(filename: &str) -> bool {
    valid_text(filename, 255, false) && !filename.contains(['/', '\\', ':', '<', '>', '"', '|', '?', '*'])
        && filename.rsplit_once('.').is_some_and(|(name, ext)| {
            !matches!(name.trim(), "" | "." | "..") && (ext.eq_ignore_ascii_case("html") || ext.eq_ignore_ascii_case("htm"))
        })
}

fn valid_visibility(visibility: &str) -> bool { matches!(visibility, "public" | "private") }

#[derive(Serialize)]
struct SubmitBody<'a> {
    filename: &'a str,
    content_base64: &'a str,
    name: &'a str,
    author: &'a str,
    description: &'a str,
    version: &'a str,
    visibility: &'a str,
    email: &'a str,
    code: &'a str,
}

fn submit_body(payload: &Value) -> Result<(SubmitBody<'_>, usize)> {
    let fields = payload.as_object().filter(|fields| fields.len() == 9).ok_or_else(submit_input_error)?;
    let field = |key: &str| fields.get(key).and_then(Value::as_str).ok_or_else(submit_input_error);
    let body = SubmitBody {
        filename: field("filename")?, content_base64: field("contentBase64")?, name: field("name")?,
        author: field("author")?, description: field("description")?, version: field("version")?,
        visibility: field("visibility")?, email: checked_email(field("email")?)?, code: field("code")?,
    };
    if !valid_filename(body.filename) || !valid_text(body.name, MAX_NAME, false) || body.name.trim().is_empty()
        || !valid_text(body.author, MAX_NAME, false) || !valid_text(body.description, MAX_DESCRIPTION, true)
        || !valid_text(body.version, MAX_VERSION, false) || !valid_visibility(body.visibility)
        || body.code.len() != 6 || !body.code.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(submit_input_error());
    }
    let size = decode_html(body.content_base64, MAX_SUBMIT_BYTES)?.len();
    Ok((body, size))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Limits {
    script_max_bytes: u64,
}

fn submission_limit(limits: Limits) -> Result<usize> {
    if limits.script_max_bytes == 0 { return Err(response_error()); }
    Ok(limits.script_max_bytes.min(MAX_SUBMIT_BYTES as u64) as usize)
}

#[derive(Deserialize)]
struct SubmitReply {
    ok: Option<bool>,
    id: String,
    sha256: String,
    visibility: Option<String>,
    #[serde(rename = "contentBase64")]
    content_camel: Option<String>,
    content_base64: Option<String>,
    size: Option<u64>,
}

fn normalize_submit_reply(reply: SubmitReply, requested_visibility: &str, cap: usize) -> Result<Value> {
    let visibility = reply.visibility.as_deref().unwrap_or(requested_visibility);
    if reply.ok == Some(false) || !valid_id(&reply.id) || !valid_visibility(visibility) {
        return Err(submit_reply_error());
    }
    let sha = normalize_sha(&reply.sha256).ok_or_else(submit_reply_error)?;
    let encoded = match (reply.content_camel, reply.content_base64) {
        (Some(a), Some(b)) if a != b => return Err(submit_reply_error()),
        (Some(encoded), _) | (_, Some(encoded)) => encoded,
        _ => return Err(submit_reply_error()),
    };
    let bytes = decode_html(&encoded, cap).map_err(|_| submit_reply_error())?;
    if reply.size.is_some_and(|size| size != bytes.len() as u64) || !hash_matches(&bytes, &sha) {
        return Err(submit_reply_error());
    }
    Ok(json!({"id": reply.id, "sha256": sha, "visibility": visibility, "contentBase64": encoded}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        sync::oneshot,
        task::JoinHandle,
        time::timeout,
    };

    const ID: &str = "HC-ab12";
    const PAGE: &[u8] = br#"<!--@hcpage {"id":"HC-ab12"} --><p>Fixture</p>"#;

    fn settings(server: &str) -> Value { json!({"mode":"normal", "serverUrl":server}) }
    fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
    fn parse<T: DeserializeOwned>(value: Value) -> T { serde_json::from_value(value).unwrap() }

    fn row(url: &str, sha: &str) -> Value {
        json!({"id":ID,"name":"主页","author":"示例","description":"两行\n说明","version":"1.0.1",
            "sha256":sha,"size":PAGE.len(),"downloads":0,"updatedAt":1730000000000_u64,"url":url})
    }

    fn payload(encoded: &str) -> Value {
        json!({"filename":"主页.html","contentBase64":encoded,"name":"主页","author":"",
            "description":"两行\n说明","version":"1.0.0","visibility":"private","email":"author@example.invalid","code":"012345"})
    }

    #[test]
    fn homepage_remote_base_urls_and_modes() {
        assert_eq!(service_endpoint(&json!({})).unwrap().as_str(), format!("{DEFAULT_SERVER}/api.php"));
        let api = service_endpoint(&settings("http://[::1]:4123/fixtures%20base")).unwrap();
        assert_eq!(api.as_str(), "http://[::1]:4123/fixtures%20base/api.php");
        assert!(market_url("http://[::1]:4123/script.php?id=HC-ab12", &api).is_some());
        assert!(market_url("http://[::1]:4124/script.php", &api).is_none());
        assert!(market_url("http://localhost:4123/script.php", &api).is_none());
        assert!(market_url("https://cdn.example.invalid/script.php?id=HC-ab12", &api).is_some());
        for raw in ["http://example.invalid", "https://example.invalid?", "https://example.invalid/#",
            "https://u:p@example.invalid", "https://@example.invalid", "https:///example.invalid",
            "https://example.invalid\\path", "https://exam\tple.invalid", "file:///fixtures"] {
            assert!(service_endpoint(&settings(raw)).is_err(), "{raw}");
        }
        assert!(Client::new(&json!({"mode":"local", "serverUrl":42})).is_err());
        assert!(Client::new(&json!({"mode":"unknown"})).is_err());
    }

    #[test]
    fn homepage_remote_market_normalizes_and_rejects_ambiguous_rows() {
        let api = service_endpoint(&settings("http://127.0.0.1:4123/dev/")).unwrap();
        let mut item = row("HTTPS://CDN.EXAMPLE.INVALID:443/script.php?id=HC-ab12", &"A".repeat(64));
        item["unknown"] = json!("discarded");
        let list = normalize_market(parse(json!({"ok":true,"scripts":[item.clone()]})), &api).unwrap();
        let list = serde_json::to_value(list).unwrap();
        assert_eq!(list[0]["url"], "https://cdn.example.invalid/script.php?id=HC-ab12");
        assert_eq!(list[0]["sha256"].as_str().unwrap(), "a".repeat(64));
        assert!(list[0].get("unknown").is_none());

        let mut legacy = item.clone();
        legacy.as_object_mut().unwrap().remove("sha256");
        let rows = normalize_market(parse(json!({"scripts":[legacy]})), &api).unwrap();
        assert_eq!(rows[0].sha256, "");
        for (field, value) in [
            ("id", json!("HC-a_b1")), ("id", json!(format!("HC-{}", "A".repeat(62)))),
            ("sha256", json!("z".repeat(64))), ("url", json!("http://127.0.0.1:4124/file")),
            ("size", json!(MAX_MARKET_SIZE + 1)), ("description", json!("x".repeat(MAX_DESCRIPTION + 1))),
        ] {
            let mut invalid = item.clone();
            invalid[field] = value;
            assert!(normalize_market(parse(json!({"scripts":[invalid]})), &api).is_err(), "{field}");
        }
        let mut duplicate = item.clone();
        duplicate["id"] = json!("HC-OTHER1");
        assert!(normalize_market(parse(json!({"scripts":[item.clone(), duplicate]})), &api).is_err());
        let too_many = vec![item; MAX_MARKET_ROWS + 1];
        assert!(normalize_market(parse(json!({"scripts":too_many})), &api).is_err());
    }

    #[test]
    fn homepage_remote_verify_and_submission_parsers_reject_malformed_data() {
        assert_eq!(normalize_verify(parse(json!({"ok":true,"verified":false,"script":null})), ID).unwrap(),
            json!({"ok":true,"verified":false,"script":null}));
        assert!(serde_json::from_value::<VerifyReply>(json!({"ok":true,"verified":"true","script":null})).is_err());
        assert!(serde_json::from_value::<VerifyReply>(json!({"ok":true,"verified":false})).is_err());
        assert!(normalize_verify(parse(json!({"ok":true,"verified":true,"script":null})), ID).is_err());
        assert!(normalize_verify(parse(json!({"ok":true,"verified":true,"script":{"id":"HC-OTHER1"}})), ID).is_err());
        assert_eq!(submission_limit(parse(json!({"scriptMaxBytes":9,"scriptMaxBytesCap":1}))).unwrap(), 9);
        assert_eq!(submission_limit(parse(json!({"scriptMaxBytes":u64::MAX}))).unwrap(), MAX_SUBMIT_BYTES);
        assert!(submission_limit(parse(json!({"scriptMaxBytes":0}))).is_err());
        let encoded = STANDARD.encode(PAGE);
        let mut input = payload(&encoded);
        assert_eq!(submit_body(&input).unwrap().1, PAGE.len());
        input["extra"] = json!(true);
        assert!(submit_body(&input).is_err());
        for bad in ["PHA+PC9wPg".to_owned(), "PHA+PC9wPh==".to_owned(), "PHA+\nPC9wPg==".to_owned(),
            STANDARD.encode(b"<p>\xff</p>"), STANDARD.encode(b"<p>\0</p>"), STANDARD.encode(b"not html")] {
            assert!(submit_body(&payload(&bad)).is_err());
        }
        let mut reply = json!({"id":ID,"sha256":digest(PAGE),"contentBase64":encoded});
        let result = normalize_submit_reply(parse(reply.clone()), "private", PAGE.len()).unwrap();
        assert_eq!(result["visibility"], "private");
        assert!(normalize_submit_reply(parse(reply.clone()), "private", PAGE.len() - 1).is_err());
        reply["sha256"] = json!("0".repeat(64));
        assert!(normalize_submit_reply(parse(reply), "private", PAGE.len()).is_err());
    }

    // 固定回环地址、一连接一请求；最后拒收任何计划外连接（例如重定向的后续请求）。
    type Requests = Vec<(String, Vec<u8>)>;

    async fn fixture(responses: impl FnOnce(&str) -> Vec<Vec<u8>>) -> (String, JoinHandle<Requests>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let responses = responses(&base);
        let task = tokio::spawn(async move {
            let mut requests = Vec::new();
            for reply in responses {
                let (mut socket, peer) = timeout(Duration::from_secs(4), listener.accept()).await.unwrap().unwrap();
                assert!(peer.ip().is_loopback());
                requests.push(timeout(Duration::from_secs(4), read_request(&mut socket)).await.unwrap());
                // 超限响应可能在正文未写完时被客户端中止。
                let _ = timeout(Duration::from_secs(4), socket.write_all(&reply)).await;
            }
            assert!(timeout(Duration::from_millis(150), listener.accept()).await.is_err(), "出现计划外请求");
            requests
        });
        (base, task)
    }

    // 读到一条请求后只发响应头，不发 Content-Length 声明的正文；客户端应在动作时限
    // 或调用方取消时丢弃在途请求，并且不会继续执行后续业务请求。
    async fn stalled_fixture() -> (String, JoinHandle<Requests>, oneshot::Receiver<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (seen_tx, seen_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            let (mut socket, peer) = timeout(Duration::from_secs(4), listener.accept()).await.unwrap().unwrap();
            assert!(peer.ip().is_loopback());
            let request = timeout(Duration::from_secs(4), read_request(&mut socket)).await.unwrap();
            let requests = vec![request];
            let _ = seen_tx.send(());
            let headers = b"HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nContent-Type: application/json\r\nContent-Length: 64\r\n\r\n";
            let _ = timeout(Duration::from_secs(4), socket.write_all(headers)).await;
            let mut probe = [0u8; 1];
            let _ = timeout(Duration::from_secs(4), socket.read(&mut probe)).await;
            assert!(timeout(Duration::from_millis(150), listener.accept()).await.is_err(), "出现未授权的后续请求");
            requests
        });
        (base, task, seen_rx)
    }

    async fn read_request(socket: &mut TcpStream) -> (String, Vec<u8>) {
        let mut raw = Vec::new();
        let mut chunk = [0; 4096];
        let (header_end, line, len) = loop {
            let n = socket.read(&mut chunk).await.unwrap();
            assert!(n > 0);
            raw.extend_from_slice(&chunk[..n]);
            if let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = std::str::from_utf8(&raw[..end]).unwrap();
                let line = head.lines().next().unwrap().to_owned();
                let len = head.lines().filter_map(|s| s.split_once(':'))
                    .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                    .map(|(_, value)| value.trim().parse::<usize>().unwrap()).unwrap_or(0);
                break (end + 4, line, len);
            }
            assert!(raw.len() < MAX_SMALL_JSON);
        };
        assert!(len <= MAX_SUBMIT_REQUEST);
        while raw.len() < header_end + len {
            let n = socket.read(&mut chunk).await.unwrap();
            assert!(n > 0);
            raw.extend_from_slice(&chunk[..n]);
        }
        (line, raw[header_end..header_end + len].to_vec())
    }

    fn reply(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
        let mut bytes = format!("HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n", body.len()).into_bytes();
        bytes.extend_from_slice(body);
        bytes
    }

    fn reply_json(value: Value) -> Vec<u8> {
        reply("200 OK", "Content-Type: application/json\r\n", &serde_json::to_vec(&value).unwrap())
    }

    #[tokio::test]
    async fn homepage_remote_loopback_verifies_and_posts_fixed_dtos() {
        let encoded = STANDARD.encode(PAGE);
        let sha = digest(PAGE);
        let (base, requests) = fixture(|_| vec![
            reply_json(json!({"ok":true,"verified":true,"script":{"id":ID,"unneeded":"discarded"}})),
            reply_json(json!({"ok":true,"ttl":"600","cooldown":60,"email":"author@example.invalid"})),
            reply_json(json!({"scriptMaxBytes":MAX_MARKET_SIZE,"scriptMaxBytesCap":MAX_MARKET_SIZE})),
            reply_json(json!({"ok":true,"id":ID,"sha256":sha.to_uppercase(),"content_base64":encoded,"email":"author@example.invalid","code":"012345"})),
        ]).await;
        let client = Client::new(&settings(&format!("{base}/php"))).unwrap();
        assert_eq!(client.verify(ID, &sha.to_uppercase()).await.unwrap(), json!({"ok":true,"verified":true,"script":{"id":ID}}));
        assert_eq!(client.email_code(" author@example.invalid ").await.unwrap(), json!({"ok":true,"ttl":600,"cooldown":60}));
        let payload = payload(&encoded);
        assert_eq!(client.submit(&payload).await.unwrap(), json!({"id":ID,"sha256":sha,"visibility":"private","contentBase64":encoded}));
        let requests = requests.await.unwrap();
        assert_eq!(requests[0].0, format!("GET /php/api.php?action=script_verify&id={ID}&sha256={sha} HTTP/1.1"));
        assert_eq!(requests[1].0, "POST /php/api.php?action=email_send_code HTTP/1.1");
        assert_eq!(serde_json::from_slice::<Value>(&requests[1].1).unwrap(), json!({"email":"author@example.invalid"}));
        assert_eq!(requests[2].0, "GET /php/api.php?action=limits HTTP/1.1");
        assert_eq!(requests[3].0, "POST /php/api.php?action=market_submit HTTP/1.1");
        let mut expected = payload.as_object().unwrap().clone();
        let content = expected.remove("contentBase64").unwrap();
        expected.insert("content_base64".into(), content);
        assert_eq!(serde_json::from_slice::<Value>(&requests[3].1).unwrap(), Value::Object(expected));
    }

    #[tokio::test]
    async fn homepage_remote_loopback_download_authorization_and_integrity() {
        let sha = digest(PAGE);
        let path = "/script.php?id=HC-ab12";
        let (base, requests) = fixture(|base| {
            let listed = row(&format!("{base}{path}"), &sha);
            vec![
                reply_json(json!({"scripts":[listed.clone()]})),
                reply_json(json!({"scripts":[listed.clone()]})),
                reply_json(json!({"scripts":[listed.clone()]})),
                reply("200 OK", "", b"<p>Different</p>"),
                reply_json(json!({"scripts":[listed]})),
                reply("200 OK", "", PAGE),
            ]
        }).await;
        let client = Client::new(&settings(&base)).unwrap();
        let url = format!("{base}{path}");
        assert_eq!(client.download(&format!("{url}&extra=1"), None).await.unwrap_err(), download_url_error());
        assert!(client.download(&url, Some(&"0".repeat(64))).await.is_err());
        assert_eq!(client.download(&url, None).await.unwrap_err(), hash_error());
        assert_eq!(client.download(&url, Some(&sha)).await.unwrap().as_slice(), PAGE);
        let request_lines: Vec<_> = requests.await.unwrap().into_iter().map(|(line, _)| line).collect();
        assert_eq!(request_lines, ["GET /api.php?action=market_list HTTP/1.1", "GET /api.php?action=market_list HTTP/1.1",
            "GET /api.php?action=market_list HTTP/1.1", "GET /script.php?id=HC-ab12 HTTP/1.1",
            "GET /api.php?action=market_list HTTP/1.1", "GET /script.php?id=HC-ab12 HTTP/1.1"]);
    }

    #[tokio::test]
    async fn homepage_remote_loopback_refuses_redirects_and_chunked_oversize() {
        let mut chunked = b"HTTP/1.1 200 OK\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
        chunked.extend_from_slice(format!("{:x}\r\n", MAX_MARKET_SIZE).as_bytes());
        chunked.extend_from_slice(&vec![b'x'; MAX_MARKET_SIZE as usize]);
        chunked.extend_from_slice(b"\r\n1\r\nx\r\n0\r\n\r\n");
        let (base, requests) = fixture(move |base| {
            let market = reply_json(json!({"scripts":[row(&format!("{base}/page.html"), "")]}));
            vec![market.clone(), reply("302 Found", "Location: /landing\r\n", b""), market, chunked]
        }).await;
        let client = Client::new(&settings(&base)).unwrap();
        let url = format!("{base}/page.html");
        assert!(client.download(&url, None).await.is_err());
        assert_eq!(client.download(&url, None).await.unwrap_err(), market_size_error());
        let requests = requests.await.unwrap();
        assert_eq!(requests.len(), 4);
        assert_eq!(requests[1].0, "GET /page.html HTTP/1.1");
        assert_eq!(requests[3].0, "GET /page.html HTTP/1.1");
    }

    #[tokio::test]
    async fn homepage_remote_stalled_response_is_bounded_by_action_deadline() {
        let (base, requests, _seen) = stalled_fixture().await;
        let mut client = Client::new(&settings(&base)).unwrap();
        client.action_timeout = Duration::from_millis(500);
        let input = payload(&STANDARD.encode(PAGE));
        let error = timeout(Duration::from_secs(2), client.submit(&input)).await.unwrap().unwrap_err();
        assert_eq!(error, timeout_error());
        let requests = timeout(Duration::from_secs(5), requests).await.unwrap().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, "GET /api.php?action=limits HTTP/1.1");
    }

    #[tokio::test]
    async fn homepage_remote_dropping_waiter_does_not_continue_submission() {
        let (base, requests, seen) = stalled_fixture().await;
        let client = Client::new(&settings(&base)).unwrap();
        let input = payload(&STANDARD.encode(PAGE));
        let mut pending = Box::pin(client.submit(&input));
        tokio::select! {
            received = seen => received.unwrap(),
            result = &mut pending => panic!("滞留响应不应返回结果：{result:?}"),
            _ = tokio::time::sleep(Duration::from_secs(2)) => panic!("未收到回环 limits 请求"),
        }
        drop(pending);
        let requests = timeout(Duration::from_secs(5), requests).await.unwrap().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, "GET /api.php?action=limits HTTP/1.1");
    }

    #[tokio::test]
    async fn homepage_remote_loopback_limits_before_post_and_does_not_echo_errors() {
        let (base, requests) = fixture(|_| vec![
            reply_json(json!({"scriptMaxBytes":1})),
            reply("429 Too Many Requests", "", br#"{"error":"author@example.invalid 012345 <html> raw-fixture"}"#),
        ]).await;
        let client = Client::new(&settings(&base)).unwrap();
        assert_eq!(client.submit(&payload(&STANDARD.encode(PAGE))).await.unwrap_err(), submit_size_error());
        let error = client.email_code("author@example.invalid").await.unwrap_err();
        assert!(error.contains("429"));
        assert!(["author@example.invalid", "012345", "<html>", "raw-fixture", base.as_str()].iter().all(|secret| !error.contains(*secret)));
        let requests = requests.await.unwrap();
        assert_eq!(requests[0].0, "GET /api.php?action=limits HTTP/1.1");
        assert_eq!(requests[1].0, "POST /api.php?action=email_send_code HTTP/1.1");
    }
}

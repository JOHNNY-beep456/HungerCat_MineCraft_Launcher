//! Minecraft 只读查询。固定 HTTPS API；现代 SLP 仅用于失败/缺 MOTD 补全，不启动游戏。
use reqwest::{header::{HeaderMap, HeaderValue, AUTHORIZATION}, Client, Url};
use serde_json::{json, Value};
use std::{net::{IpAddr, Ipv6Addr}, time::Duration};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpStream, time::{timeout_at, Instant}};

type Result<T> = std::result::Result<T, String>;
const USERINFO_URL: &str = "https://uapis.cn/api/v1/game/minecraft/userinfo";
const STATUS_URL: &str = "https://uapis.cn/api/v1/game/minecraft/serverstatus";
const JSON_LIMIT: usize = 1024 * 1024;
const FRAME_LIMIT: usize = 1024 * 1024;
const TEXT_LIMIT: usize = 16 * 1024;
const HTML_LIMIT: usize = 128 * 1024;
const ICON_LIMIT: usize = 64 * 1024;

#[derive(Clone, Copy)]
struct Budgets { http: Duration, slp: Duration }
impl Default for Budgets { fn default() -> Self { Self { http: Duration::from_secs(12), slp: Duration::from_secs(8) } } }
struct Queries { client: Client, userinfo: Url, status: Url, budgets: Budgets }
impl Queries {
    fn new() -> Result<Self> {
        Self::with_urls(Url::parse(USERINFO_URL).map_err(|_| "玩家信息服务配置错误")?, Url::parse(STATUS_URL).map_err(|_| "服务器信息服务配置错误")?, Budgets::default())
    }
    fn with_urls(userinfo: Url, status: Url, budgets: Budgets) -> Result<Self> {
        let client = Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(budgets.http)
            .connect_timeout(budgets.http.min(Duration::from_secs(5))).user_agent("HCMCL/0.7.6 Minecraft-query")
            .build().map_err(|_| "无法初始化 Minecraft 查询服务")?;
        Ok(Self { client, userinfo, status, budgets })
    }
    #[cfg(test)]
    fn loopback(base: &str, budgets: Budgets) -> Self {
        let base = Url::parse(base).unwrap();
        assert_eq!(base.scheme(), "http");
        assert!(base.host_str().unwrap().parse::<IpAddr>().unwrap().is_loopback());
        Self::with_urls(base.join("userinfo").unwrap(), base.join("serverstatus").unwrap(), budgets).unwrap()
    }
    async fn json(&self, mut url: Url, query: &[(&str, &str)], settings: &Value) -> Result<Value> {
        online(settings)?;
        for (key, value) in query { url.query_pairs_mut().append_pair(key, value); }
        let headers = auth_headers(settings)?;
        let operation = async {
            // 不透传 reqwest 错误、URL、服务端正文或鉴权头，以免泄露内部 API KEY。
            let mut response = self.client.get(url).headers(headers).send().await.map_err(|e| if e.is_timeout() { "Minecraft 查询接口超时" } else { "Minecraft 查询网络连接失败" })?;
            if !response.status().is_success() { return Err(format!("Minecraft 查询接口返回 HTTP {}", response.status().as_u16())); }
            if response.content_length().is_some_and(|n| n > JSON_LIMIT as u64) { return Err("Minecraft 查询响应过大".into()); }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|e| if e.is_timeout() { "Minecraft 查询接口超时" } else { "Minecraft 查询响应读取失败" })? {
                if bytes.len().saturating_add(chunk.len()) > JSON_LIMIT { return Err("Minecraft 查询响应过大".into()); }
                bytes.extend_from_slice(&chunk);
            }
            let text = std::str::from_utf8(&bytes).map_err(|_| "Minecraft 查询响应不是 UTF-8")?;
            let value: Value = serde_json::from_str(text).map_err(|_| "Minecraft 查询响应不是有效 JSON")?;
            if !value.is_object() { return Err("Minecraft 查询响应不是对象".into()); }
            Ok(value)
        };
        timeout_at(Instant::now() + self.budgets.http, operation).await.map_err(|_| "Minecraft 查询接口超时".to_string())?
    }
    async fn userinfo(&self, name: &str, settings: &Value) -> Result<Value> {
        online(settings)?;
        let name = username(name.trim())?;
        map_userinfo(&self.json(self.userinfo.clone(), &[("username", name)], settings).await?, name)
    }
    async fn serverstatus(&self, address: &str, settings: &Value) -> Result<Value> {
        online(settings)?;
        auth_headers(settings)?;
        let address = parse_address(address)?;
        let port_text = address.port.to_string();
        let mut query = vec![("server", address.host.as_str())];
        if address.explicit_port { query.push(("port", port_text.as_str())); }
        let api = self.json(self.status.clone(), &query, settings).await.and_then(|v| map_api_status(&v)).ok();
        if let Some(api) = api.as_ref().filter(|s| s.motd.present()) { return Ok(api.dto(&address)); }
        match ping(&address, self.budgets.slp).await {
            Ok(direct) => Ok(api.map_or(direct.clone(), |api| api.fill_from(direct)).dto(&address)),
            Err(_) => api.map(|api| api.dto(&address)).ok_or_else(|| "服务器状态查询失败：接口与直连均未取得有效状态".into()),
        }
    }
}
fn online(settings: &Value) -> Result<()> {
    if settings.get("mode").and_then(Value::as_str) == Some("local") { Err("本地模式禁止 Minecraft 联网查询".into()) } else { Ok(()) }
}
fn auth_headers(settings: &Value) -> Result<HeaderMap> {
    let key = match settings.get("uapisApiKey") { None | Some(Value::Null) => "", Some(Value::String(s)) => s.trim(), _ => return Err("Minecraft 查询密钥配置无效".into()) };
    let mut headers = HeaderMap::new();
    if !key.is_empty() {
        if key.len() > 4096 || key.chars().any(char::is_control) { return Err("Minecraft 查询密钥配置无效".into()); }
        let mut value = HeaderValue::from_str(&format!("Bearer {key}")).map_err(|_| "Minecraft 查询密钥配置无效")?;
        value.set_sensitive(true); headers.insert(AUTHORIZATION, value);
    }
    Ok(headers)
}
fn username(value: &str) -> Result<&str> {
    if !(1..=16).contains(&value.len()) || !value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') { return Err("玩家名须为 1–16 位英文字母、数字或下划线".into()); }
    Ok(value)
}
fn optional_string<'a>(value: &'a Value, key: &str, limit: usize) -> Result<&'a str> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(""),
        Some(Value::String(s)) if s.len() <= limit && !s.chars().any(|c| c.is_control() && c != '\n' && c != '\t') => Ok(s),
        _ => Err("Minecraft 查询响应字段类型或长度无效".into()),
    }
}
fn canonical_uuid(raw: &str) -> Result<String> {
    if raw.is_empty() { return Ok(String::new()); }
    if raw.len() == 36 && [8, 13, 18, 23].into_iter().all(|i| raw.as_bytes()[i] == b'-') {
        if raw.bytes().enumerate().any(|(i, b)| ![8, 13, 18, 23].contains(&i) && !b.is_ascii_hexdigit()) { return Err("玩家 UUID 格式无效".into()); }
    } else if raw.len() != 32 || !raw.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("玩家 UUID 格式无效".into()); }
    Ok(raw.replace('-', "").to_ascii_lowercase())
}
fn texture_url(raw: &str) -> Result<String> {
    if raw.is_empty() { return Ok(String::new()); }
    let mut url = Url::parse(raw).map_err(|_| "玩家贴图地址无效")?;
    if !matches!(url.scheme(), "https" | "http") || url.host_str() != Some("textures.minecraft.net") || url.port().is_some()
        || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("玩家贴图地址不属于 Minecraft 官方贴图库".into());
    }
    let hash = url.path().strip_prefix("/texture/").ok_or("玩家贴图路径无效")?;
    if !(1..=64).contains(&hash.len()) || !hash.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("玩家贴图路径无效".into()); }
    url.set_scheme("https").map_err(|_| "玩家贴图协议无效")?;
    Ok(url.to_string())
}
fn map_userinfo(value: &Value, requested: &str) -> Result<Value> {
    let returned = optional_string(value, "username", 16)?;
    let name = username(if returned.is_empty() { requested } else { returned })?;
    if !name.eq_ignore_ascii_case(requested) { return Err("玩家查询回显名称不匹配".into()); }
    let uuid = canonical_uuid(optional_string(value, "uuid", 36)?)?;
    let skin = texture_url(optional_string(value, "skin_url", 2048)?)?;
    let cape = texture_url(optional_string(value, "cape_url", 2048)?)?;
    if uuid.is_empty() && skin.is_empty() { return Err("未查询到该玩家".into()); }
    Ok(json!({"username":name,"uuid":uuid,"skinUrl":skin,"capeUrl":cape}))
}

#[derive(Clone, Debug)]
struct Address { host: String, port: u16, explicit_port: bool }
fn parse_port(raw: &str) -> Result<u16> {
    if raw.is_empty() || raw.len() > 5 || !raw.bytes().all(|b| b.is_ascii_digit()) { return Err("服务器端口须为 1–65535 的整数".into()); }
    raw.parse::<u16>().ok().filter(|n| *n > 0).ok_or_else(|| "服务器端口须为 1–65535 的整数".into())
}
fn parse_address(raw: &str) -> Result<Address> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 320 || raw.chars().any(|c| c.is_whitespace() || c.is_control()) || raw.chars().any(|c| matches!(c, '/' | '\\' | '@' | '?' | '#' | '%')) { return Err("服务器地址格式无效".into()); }
    let (host, port, explicit_port) = if let Some(rest) = raw.strip_prefix('[') {
        let (host, suffix) = rest.split_once(']').ok_or("IPv6 服务器地址缺少右括号")?;
        let ip = host.parse::<Ipv6Addr>().map_err(|_| "IPv6 服务器地址无效")?;
        let (port, explicit) = if suffix.is_empty() { (25565, false) } else { (parse_port(suffix.strip_prefix(':').ok_or("IPv6 服务器端口格式无效")?)?, true) };
        (ip.to_string(), port, explicit)
    } else {
        if raw.chars().any(|c| matches!(c, '[' | ']')) || raw.matches(':').count() > 1 { return Err("IPv6 地址须使用 [地址]:端口 格式".into()); }
        let (host, port, explicit) = if let Some((host, port)) = raw.split_once(':') { (host, parse_port(port)?, true) } else { (raw, 25565, false) };
        if host.is_empty() || host.len() > 253 { return Err("服务器主机名长度无效".into()); }
        let host = if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() { ip.to_string() } else {
            if host.bytes().all(|b| b.is_ascii_digit() || b == b'.') { return Err("IPv4 地址无效".into()); }
            let host = host.strip_suffix('.').unwrap_or(host);
            if host.is_empty() || !host.is_ascii() || host.split('.').any(|p| p.is_empty() || p.len() > 63 || p.starts_with('-') || p.ends_with('-') || !p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')) { return Err("服务器主机名无效".into()); }
            host.to_ascii_lowercase()
        };
        (host, port, explicit)
    };
    Ok(Address { host, port, explicit_port })
}

#[derive(Clone, Default)]
struct Style { color: Option<String>, bold: bool, italic: bool, underline: bool, strike: bool }
fn color(raw: &str) -> Option<String> {
    let value = raw.to_ascii_lowercase();
    let named = match value.as_str() {
        "black" => "#000000", "dark_blue" => "#0000aa", "dark_green" => "#00aa00", "dark_aqua" => "#00aaaa", "dark_red" => "#aa0000", "dark_purple" => "#aa00aa", "gold" => "#ffaa00", "gray" => "#aaaaaa", "dark_gray" => "#555555", "blue" => "#5555ff", "green" => "#55ff55", "aqua" => "#55ffff", "red" => "#ff5555", "light_purple" => "#ff55ff", "yellow" => "#ffff55", "white" => "#ffffff", _ => "",
    };
    if !named.is_empty() { return Some(named.into()); }
    let hex = value.strip_prefix('#')?;
    if matches!(hex.len(), 3 | 6) && hex.bytes().all(|b| b.is_ascii_hexdigit()) { Some(value) } else { None }
}
fn escape(text: &str) -> String {
    let mut result = String::new();
    for c in text.chars() { match c { '&' => result.push_str("&amp;"), '<' => result.push_str("&lt;"), '>' => result.push_str("&gt;"), '"' => result.push_str("&quot;"), '\'' => result.push_str("&#39;"), '\n' => result.push_str("<br />"), c if c.is_control() && c != '\t' => {}, c => result.push(c) } }
    result
}
#[derive(Clone, Debug, Default)]
struct Motd { clean: String, html: String }
impl Motd {
    fn present(&self) -> bool { !self.clean.trim().is_empty() || !self.html.trim().is_empty() }
    fn segment(&mut self, text: &str, style: &Style) -> Result<()> {
        let clean = text.chars().filter(|c| !c.is_control() || matches!(*c, '\n' | '\t')).collect::<String>();
        if self.clean.len().saturating_add(clean.len()) > TEXT_LIMIT { return Err("服务器 MOTD 过长".into()); }
        self.clean.push_str(&clean);
        let mut css = Vec::new();
        if let Some(color) = &style.color { css.push(format!("color:{color}")); }
        if style.bold { css.push("font-weight:700".into()); } if style.italic { css.push("font-style:italic".into()); }
        if style.underline || style.strike { css.push(format!("text-decoration:{}{}", if style.underline { "underline" } else { "" }, if style.strike { " line-through" } else { "" }).trim().to_string()); }
        let escaped = escape(&clean);
        if css.is_empty() { self.html.push_str(&escaped); } else if !escaped.is_empty() { self.html.push_str(&format!("<span style=\"{}\">{escaped}</span>", css.join(";"))); }
        if self.html.len() > HTML_LIMIT { return Err("服务器 MOTD 样式过长".into()); }
        Ok(())
    }
    fn legacy(&mut self, text: &str, base: &Style) -> Result<()> {
        let palette = ["#000000", "#0000aa", "#00aa00", "#00aaaa", "#aa0000", "#aa00aa", "#ffaa00", "#aaaaaa", "#555555", "#5555ff", "#55ff55", "#55ffff", "#ff5555", "#ff55ff", "#ffff55", "#ffffff"];
        let mut style = base.clone(); let mut buffer = String::new(); let mut chars = text.chars().peekable();
        while let Some(c) = chars.next() {
            if matches!(c, '§' | '&') {
                if let Some(code) = chars.peek().copied().map(|c| c.to_ascii_lowercase()) {
                    if code.is_ascii_hexdigit() || matches!(code, 'k' | 'l' | 'm' | 'n' | 'o' | 'r') {
                        self.segment(&buffer, &style)?; buffer.clear(); chars.next();
                        match code { '0'..='9' | 'a'..='f' => { style = Style::default(); style.color = Some(palette[code.to_digit(16).unwrap() as usize].into()); }, 'l' => style.bold = true, 'm' => style.strike = true, 'n' => style.underline = true, 'o' => style.italic = true, 'r' => style = Style::default(), _ => {} }
                        continue;
                    }
                }
            }
            buffer.push(c);
        }
        self.segment(&buffer, &style)
    }
}
fn rich_motd(value: &Value) -> Result<Motd> {
    fn walk(value: &Value, style: &Style, result: &mut Motd, depth: usize, nodes: &mut usize) -> Result<()> {
        *nodes += 1; if depth > 16 || *nodes > 1024 { return Err("服务器 MOTD 组件过多".into()); }
        match value {
            Value::Null => Ok(()), Value::String(s) => result.legacy(s, style),
            Value::Array(items) => { for item in items { walk(item, style, result, depth + 1, nodes)?; } Ok(()) },
            Value::Object(map) => {
                let mut style = style.clone();
                if let Some(raw) = map.get("color") { style.color = Some(color(raw.as_str().ok_or("MOTD 颜色类型无效")?).ok_or("MOTD 颜色无效")?); }
                for (key, flag) in [("bold", &mut style.bold), ("italic", &mut style.italic), ("underlined", &mut style.underline), ("strikethrough", &mut style.strike)] { if let Some(value) = map.get(key) { *flag = value.as_bool().ok_or("MOTD 样式类型无效")?; } }
                if let Some(text) = map.get("text") { result.legacy(text.as_str().ok_or("MOTD 文本类型无效")?, &style)?; }
                else if let Some(text) = map.get("translate") { result.legacy(text.as_str().ok_or("MOTD 翻译键类型无效")?, &style)?; }
                if let Some(extra) = map.get("extra") { if !extra.is_array() { return Err("MOTD extra 类型无效".into()); } walk(extra, &style, result, depth + 1, nodes)?; }
                Ok(())
            }, _ => Err("服务器 MOTD 类型无效".into()),
        }
    }
    let mut result = Motd::default(); walk(value, &Style::default(), &mut result, 0, &mut 0)?; Ok(result)
}
fn entities(text: &str) -> String {
    let mut out = String::new(); let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]); rest = &rest[at..];
        let entity = rest.find(';').filter(|n| *n <= 12).and_then(|n| {
            let raw = &rest[1..n]; let ch = match raw { "amp" => Some('&'), "lt" => Some('<'), "gt" => Some('>'), "quot" => Some('"'), "apos" | "#39" => Some('\''), "nbsp" => Some(' '), _ => raw.strip_prefix("#x").or_else(|| raw.strip_prefix("#X")).and_then(|s| u32::from_str_radix(s, 16).ok()).or_else(|| raw.strip_prefix('#').and_then(|s| s.parse::<u32>().ok())).and_then(char::from_u32) };
            ch.map(|ch| (n + 1, ch))
        });
        if let Some((n, ch)) = entity { out.push(ch); rest = &rest[n..]; } else { out.push('&'); rest = &rest[1..]; }
    }
    out.push_str(rest); out
}
fn html_style(raw: &str, base: &Style) -> Style {
    let mut style = base.clone();
    for property in raw.split(';').take(32) {
        let Some((key, value)) = property.split_once(':') else { continue; };
        let value = value.trim().to_ascii_lowercase();
        match key.trim().to_ascii_lowercase().as_str() { "color" => { if let Some(c) = color(&value) { style.color = Some(c); } }, "font-weight" if matches!(value.as_str(), "700" | "bold") => style.bold = true, "font-style" if value == "italic" => style.italic = true, "text-decoration" => { style.underline = value.split_whitespace().any(|v| v == "underline"); style.strike = value.split_whitespace().any(|v| v == "line-through"); }, _ => {} }
    }
    style
}
fn style_attribute(raw: &str) -> Option<&str> {
    let mut rest = raw.trim();
    for _ in 0..32 {
        if rest.is_empty() { return None; }
        let end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_')))?;
        let name = &rest[..end]; rest = rest[end..].trim_start();
        rest = rest.strip_prefix('=')?.trim_start(); let quote = rest.chars().next()?;
        if !matches!(quote, '\'' | '"') { return None; } rest = &rest[1..]; let end = rest.find(quote)?;
        let value = &rest[..end]; rest = rest[end + 1..].trim_start();
        if name.eq_ignore_ascii_case("style") { return Some(value); }
    }
    None
}
fn api_html(raw: &str) -> Result<Motd> {
    if raw.len() > 32 * 1024 { return Err("服务器 HTML MOTD 过长".into()); }
    let mut result = Motd::default(); let mut rest = raw; let mut stack = vec![(String::new(), Style::default())]; let mut tags = 0usize;
    while let Some(at) = rest.find('<') {
        result.legacy(&entities(&rest[..at]), &stack.last().unwrap().1)?; rest = &rest[at..];
        let Some(end) = rest.find('>').filter(|n| *n <= 1024) else { result.legacy("<", &stack.last().unwrap().1)?; rest = &rest[1..]; continue; };
        let tag = rest[1..end].trim(); rest = &rest[end + 1..]; tags += 1; if tags > 1024 { return Err("服务器 HTML MOTD 标签过多".into()); }
        let closing = tag.starts_with('/'); let inner = tag.trim_start_matches('/').trim(); let split = inner.find(|c: char| c.is_ascii_whitespace() || c == '/').unwrap_or(inner.len()); let name = inner[..split].to_ascii_lowercase();
        if !closing && matches!(name.as_str(), "script" | "style" | "iframe" | "object") {
            if let Some(at) = rest.to_ascii_lowercase().find(&format!("</{name}")) { rest = &rest[at..]; } else { rest = ""; }
            continue;
        }
        if closing { if let Some(position) = stack.iter().rposition(|(n, _)| n == &name).filter(|i| *i > 0) { stack.truncate(position); } continue; }
        if name == "br" { result.legacy("\n", &stack.last().unwrap().1)?; continue; }
        if !matches!(name.as_str(), "span" | "b" | "strong" | "i" | "em" | "u" | "s" | "del") { continue; }
        if stack.len() > 16 { return Err("服务器 HTML MOTD 嵌套过深".into()); }
        let mut style = stack.last().unwrap().1.clone(); if let Some(css) = style_attribute(inner[split..].trim()) { style = html_style(css, &style); }
        match name.as_str() { "b" | "strong" => style.bold = true, "i" | "em" => style.italic = true, "u" => style.underline = true, "s" | "del" => style.strike = true, _ => {} }
        stack.push((name, style));
    }
    result.legacy(&entities(rest), &stack.last().unwrap().1)?; Ok(result)
}

fn base64_decode(raw: &str) -> Option<Vec<u8>> {
    if raw.is_empty() || raw.len() % 4 != 0 || raw.len() > (ICON_LIMIT + 2) / 3 * 4 { return None; }
    fn val(b: u8) -> Option<u8> { match b { b'A'..=b'Z' => Some(b - b'A'), b'a'..=b'z' => Some(b - b'a' + 26), b'0'..=b'9' => Some(b - b'0' + 52), b'+' => Some(62), b'/' => Some(63), _ => None } }
    let mut out = Vec::new(); let chunks = raw.as_bytes().chunks_exact(4); let count = chunks.len();
    for (i, s) in chunks.enumerate() {
        let a = val(s[0])?; let b = val(s[1])?; out.push((a << 2) | (b >> 4));
        if s[2] == b'=' { if i + 1 != count || s[3] != b'=' || b & 15 != 0 { return None; } }
        else { let c = val(s[2])?; out.push((b << 4) | (c >> 2)); if s[3] == b'=' { if i + 1 != count || c & 3 != 0 { return None; } } else { let d = val(s[3])?; out.push((c << 6) | d); } }
    }
    (out.len() <= ICON_LIMIT).then_some(out)
}
fn crc32(bytes: &[u8]) -> u32 { let mut crc = !0u32; for &b in bytes { crc ^= b as u32; for _ in 0..8 { crc = (crc >> 1) ^ (0xedb88320u32 & (0u32.wrapping_sub(crc & 1))); } } !crc }
fn favicon(raw: &str) -> String {
    fn valid(raw: &str) -> Option<()> {
        let bytes = base64_decode(raw.strip_prefix("data:image/png;base64,")?)?;
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") { return None; }
        let mut at = 8; let mut count = 0; let mut image_data = Vec::new(); let mut depth = 0u8; let mut channels = 0usize; let mut indexed = false; let mut palette = false;
        while at < bytes.len() {
            count += 1; if count > 128 || bytes.len() - at < 12 { return None; }
            let n = u32::from_be_bytes(bytes[at..at + 4].try_into().ok()?) as usize; if n > ICON_LIMIT || n + 12 > bytes.len() - at { return None; }
            let kind = &bytes[at + 4..at + 8]; let data = &bytes[at + 8..at + 8 + n];
            if !kind.iter().all(u8::is_ascii_alphabetic) || crc32(&bytes[at + 4..at + 8 + n]) != u32::from_be_bytes(bytes[at + 8 + n..at + 12 + n].try_into().ok()?) { return None; }
            if count == 1 {
                if kind != b"IHDR" || n != 13 || u32::from_be_bytes(data[..4].try_into().ok()?) != 64 || u32::from_be_bytes(data[4..8].try_into().ok()?) != 64 || !matches!((data[8], data[9]), (1 | 2 | 4 | 8 | 16, 0) | (8 | 16, 2) | (1 | 2 | 4 | 8, 3) | (8 | 16, 4 | 6)) || data[10] != 0 || data[11] != 0 || data[12] != 0 { return None; }
                depth = data[8]; channels = match data[9] { 0 | 3 => 1, 2 => 3, 4 => 2, 6 => 4, _ => return None }; indexed = data[9] == 3;
            } else if kind == b"IHDR" { return None; }
            if kind == b"PLTE" { if palette || !image_data.is_empty() || n == 0 || n % 3 != 0 || n > 768 { return None; } palette = true; }
            if kind == b"IDAT" { if image_data.len().saturating_add(n) > ICON_LIMIT || indexed && !palette { return None; } image_data.extend_from_slice(data); }
            if kind == b"IEND" {
                if n != 0 || image_data.is_empty() || at + 12 != bytes.len() { return None; }
                let row = (64 * channels * depth as usize + 7) / 8; let expected = (row + 1) * 64;
                let mut decoder = flate2::read::ZlibDecoder::new(image_data.as_slice()); let mut decoded = Vec::new();
                std::io::Read::read_to_end(&mut std::io::Read::take(&mut decoder, expected as u64 + 1), &mut decoded).ok()?;
                if decoded.len() != expected || decoder.total_in() != image_data.len() as u64 || decoded.chunks_exact(row + 1).any(|line| line[0] > 4) { return None; }
                return Some(());
            }
            if kind[0].is_ascii_uppercase() && kind != b"IHDR" && kind != b"PLTE" && kind != b"IDAT" { return None; }
            at += n + 12;
        }
        None
    }
    if raw.len() > 90 * 1024 || valid(raw).is_none() { String::new() } else { raw.to_string() }
}

#[derive(Clone, Debug, Default)]
struct Status { online: Option<bool>, players: Option<u32>, maximum: Option<u32>, motd: Motd, favicon: String, ip: String, port: Option<u16>, version: String }
impl Status {
    fn dto(&self, address: &Address) -> Value { json!({"online":self.online.unwrap_or(false),"players":self.players.unwrap_or(0),"maxPlayers":self.maximum.unwrap_or(0),"motdClean":self.motd.clean,"motdHtml":self.motd.html,"faviconUrl":self.favicon,"ip":self.ip,"port":self.port.unwrap_or(address.port),"version":self.version}) }
    fn fill_from(mut self, direct: Self) -> Self {
        // 仅缺 MOTD 的补全路径进入此处；一次有效 SLP 应答可以确认当前在线。
        self.online = direct.online.or(self.online); self.players = self.players.or(direct.players); self.maximum = self.maximum.or(direct.maximum);
        if !self.motd.present() { self.motd = direct.motd; } if self.favicon.is_empty() { self.favicon = direct.favicon; }
        if self.ip.is_empty() { self.ip = direct.ip; } if self.port.is_none() { self.port = direct.port; } if self.version.is_empty() { self.version = direct.version; } self
    }
}
fn count(value: Option<&Value>) -> Result<Option<u32>> { match value { None | Some(Value::Null) => Ok(None), Some(v) => v.as_u64().filter(|n| *n <= i32::MAX as u64).map(|n| Some(n as u32)).ok_or_else(|| "服务器人数不是有效非负整数".into()) } }
fn map_api_status(value: &Value) -> Result<Status> {
    let online = value.get("online").and_then(Value::as_bool).ok_or("服务器接口缺少有效在线状态")?;
    let clean = optional_string(value, "motd_clean", TEXT_LIMIT)?; let html = optional_string(value, "motd_html", 32 * 1024)?;
    let mut motd = if html.is_empty() { let mut m = Motd::default(); m.legacy(clean, &Style::default())?; m } else { api_html(html)? };
    if !clean.is_empty() { let mut text = Motd::default(); text.legacy(clean, &Style::default())?; motd.clean = text.clean; }
    let ip = optional_string(value, "ip", 64)?; if !ip.is_empty() && ip.parse::<IpAddr>().is_err() { return Err("服务器接口 IP 格式无效".into()); }
    let port = match value.get("port") { None | Some(Value::Null) => None, Some(v) => { let n = v.as_u64().filter(|n| *n <= u16::MAX as u64).ok_or("服务器接口端口无效")?; (n > 0).then_some(n as u16) } };
    Ok(Status { online: Some(online), players: count(value.get("players"))?, maximum: count(value.get("max_players"))?, motd, favicon: favicon(optional_string(value, "favicon_url", 90 * 1024)?), ip: ip.into(), port, version: optional_string(value, "version", 512)?.to_string() })
}
fn map_slp_status(value: &Value, address: &Address, ip: String) -> Result<Status> {
    if !value.is_object() { return Err("服务器状态 JSON 不是对象".into()); }
    let players = value.get("players"); if players.is_some_and(|v| !v.is_object()) { return Err("服务器人数对象无效".into()); }
    let version_value = value.get("version"); if version_value.is_some_and(|v| !v.is_object()) { return Err("服务器版本对象无效".into()); }
    let version = match version_value { Some(v) => optional_string(v, "name", 512)?, None => "" };
    if let Some(protocol) = version_value.and_then(|v| v.get("protocol")) { protocol.as_i64().filter(|n| (i32::MIN as i64..=i32::MAX as i64).contains(n)).ok_or("服务器协议号无效")?; }
    let motd = match value.get("description") { Some(v) if v.is_string() || v.is_object() || v.is_array() => rich_motd(v)?, None => Motd::default(), _ => return Err("服务器 MOTD 组件类型无效".into()) };
    let online = count(players.and_then(|v| v.get("online")))?; let maximum = count(players.and_then(|v| v.get("max")))?;
    if !motd.present() && !(online.is_some() && maximum.is_some() && !version.is_empty()) { return Err("SLP 响应缺少有效 Minecraft 状态字段".into()); }
    Ok(Status { online: Some(true), players: online, maximum, motd, favicon: favicon(optional_string(value, "favicon", 90 * 1024)?), ip, port: Some(address.port), version: version.into() })
}

fn varint(mut number: u32, bytes: &mut Vec<u8>) { loop { let byte = (number & 127) as u8; number >>= 7; bytes.push(byte | if number > 0 { 128 } else { 0 }); if number == 0 { break; } } }
fn handshake(address: &Address) -> Result<Vec<u8>> {
    if address.host.len() > 255 { return Err("SLP 主机名过长".into()); }
    let mut body = Vec::new(); varint(0, &mut body); varint(763, &mut body); varint(address.host.len() as u32, &mut body); body.extend_from_slice(address.host.as_bytes()); body.extend_from_slice(&address.port.to_be_bytes()); varint(1, &mut body);
    let mut frame = Vec::new(); varint(body.len() as u32, &mut frame); frame.extend(body); frame.extend_from_slice(&[1, 0]); Ok(frame)
}
fn number_in(bytes: &[u8], at: &mut usize) -> Result<u32> {
    let start = *at; let mut result = 0u32;
    for i in 0..5 { let byte = *bytes.get(*at).ok_or("SLP VarInt 截断")?; *at += 1; if i == 4 && byte & 0xf0 != 0 { return Err("SLP VarInt 超出 32 位".into()); } result |= ((byte & 127) as u32) << (i * 7); if byte & 128 == 0 { let mut canonical = Vec::new(); varint(result, &mut canonical); if canonical.len() != *at - start { return Err("SLP VarInt 不是最短编码".into()); } return Ok(result); } }
    Err("SLP VarInt 过长".into())
}
async fn read_number(stream: &mut TcpStream) -> Result<u32> {
    let mut bytes = Vec::new();
    for _ in 0..5 { let byte = stream.read_u8().await.map_err(|_| "SLP 长度字段读取失败")?; bytes.push(byte); if byte & 128 == 0 { return number_in(&bytes, &mut 0); } }
    Err("SLP VarInt 过长".into())
}
fn parse_frame(frame: &[u8]) -> Result<Value> {
    let mut at = 0; if number_in(frame, &mut at)? != 0 { return Err("SLP 响应包 ID 错误".into()); }
    let length = number_in(frame, &mut at)? as usize;
    if length == 0 || length > FRAME_LIMIT || length != frame.len().saturating_sub(at) { return Err("SLP JSON 长度与帧不一致".into()); }
    let text = std::str::from_utf8(&frame[at..]).map_err(|_| "SLP JSON 不是 UTF-8")?;
    let value: Value = serde_json::from_str(text).map_err(|_| "SLP JSON 无效")?;
    if !value.is_object() { return Err("SLP JSON 不是对象".into()); } Ok(value)
}
async fn ping(address: &Address, budget: Duration) -> Result<Status> {
    let operation = async {
        let mut stream = TcpStream::connect((address.host.as_str(), address.port)).await.map_err(|_| "无法连接服务器状态端口")?;
        let ip = stream.peer_addr().map_err(|_| "无法读取服务器状态地址")?.ip().to_string();
        stream.write_all(&handshake(address)?).await.map_err(|_| "SLP 握手发送失败")?;
        let length = read_number(&mut stream).await? as usize; if length == 0 || length > FRAME_LIMIT { return Err("SLP 状态帧过大或为空".into()); }
        let mut bytes = vec![0; length]; stream.read_exact(&mut bytes).await.map_err(|_| "SLP 状态帧截断")?;
        map_slp_status(&parse_frame(&bytes)?, address, ip)
    };
    timeout_at(Instant::now() + budget, operation).await.map_err(|_| "直连服务器状态查询超时".to_string())?
}

pub(crate) async fn call(channel: &str, args: &[Value], settings: &Value) -> Result<Option<Value>> {
    if !matches!(channel, "minecraft:userinfo" | "minecraft:serverstatus") { return Ok(None); }
    online(settings)?;
    if args.len() != 1 { return Err("Minecraft 查询需要一个字符串参数".into()); }
    let argument = args[0].as_str().filter(|s| s.len() <= 320 && !s.chars().any(char::is_control)).ok_or("Minecraft 查询参数类型或长度无效")?;
    let queries = Queries::new()?;
    let result = if channel == "minecraft:userinfo" { queries.userinfo(argument, settings).await? } else { queries.serverstatus(argument, settings).await? };
    Ok(Some(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{net::TcpListener, task::JoinHandle, time::{sleep, timeout}};
    fn budgets() -> Budgets { Budgets { http: Duration::from_secs(2), slp: Duration::from_secs(2) } }
    struct HttpReply { status: u16, headers: String, body: Vec<u8>, delay: Duration, fragment: bool }
    impl HttpReply { fn json(value: Value) -> Self { Self { status: 200, headers: String::new(), body: serde_json::to_vec(&value).unwrap(), delay: Duration::ZERO, fragment: false } } }
    async fn http_fixture(reply: HttpReply) -> (String, JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap(); let base = format!("http://{}/", listener.local_addr().unwrap());
        let worker = tokio::spawn(async move {
            let (mut socket, _) = timeout(Duration::from_secs(3), listener.accept()).await.expect("HTTP fixture 未收到请求").unwrap();
            let mut request = Vec::new();
            // 请求头必须真实读完后才返回；任何未接收/提前 EOF 均使夹具失败。
            loop { let byte = timeout(Duration::from_secs(2), socket.read_u8()).await.expect("HTTP fixture 请求未读完").expect("HTTP fixture 请求提前结束"); request.push(byte); assert!(request.len() <= 16384); if request.ends_with(b"\r\n\r\n") { break; } }
            let request = String::from_utf8(request).unwrap(); assert!(request.starts_with("GET /")); assert!(request.contains(" HTTP/1.1\r\n"));
            sleep(reply.delay).await;
            let headers = format!("HTTP/1.1 {} Fixture\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n{}\r\n", reply.status, reply.body.len(), reply.headers);
            if socket.write_all(headers.as_bytes()).await.is_ok() {
                if reply.fragment { for chunk in reply.body.chunks(3) { if socket.write_all(chunk).await.is_err() { break; } tokio::task::yield_now().await; } }
                else { let _ = socket.write_all(&reply.body).await; }
            }
            request
        }); (base, worker)
    }
    fn status_frame(value: Value) -> Vec<u8> { let text = serde_json::to_vec(&value).unwrap(); let mut body = vec![0]; varint(text.len() as u32, &mut body); body.extend(text); let mut frame = Vec::new(); varint(body.len() as u32, &mut frame); frame.extend(body); frame }
    async fn slp_fixture(response: Vec<u8>, delay: Duration, fragmented: bool) -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap(); let port = listener.local_addr().unwrap().port();
        let worker = tokio::spawn(async move {
            let (mut stream, _) = timeout(Duration::from_secs(3), listener.accept()).await.expect("SLP fixture 未收到连接").unwrap();
            // 独立常量：packetId=0, protocol=763(fb05), hostLen=9, host, big-endian port, nextState=1；再 status(01 00)。
            let mut expected = vec![16, 0, 0xfb, 0x05, 9]; expected.extend_from_slice(b"127.0.0.1"); expected.extend_from_slice(&port.to_be_bytes()); expected.extend_from_slice(&[1, 1, 0]);
            let mut actual = vec![0; expected.len()]; timeout(Duration::from_secs(2), stream.read_exact(&mut actual)).await.expect("SLP fixture 握手未读完").unwrap(); assert_eq!(actual, expected, "现代 SLP 握手字节顺序错误");
            sleep(delay).await;
            if fragmented { for chunk in response.chunks(1) { if stream.write_all(chunk).await.is_err() { break; } tokio::task::yield_now().await; } }
            else { let _ = stream.write_all(&response).await; }
        }); (format!("127.0.0.1:{port}"), worker)
    }
    fn direct_status() -> Value { json!({"version":{"name":"fixture 1.21.1","protocol":767},"players":{"online":7,"max":40},"description":{"text":"<safe>","color":"green","bold":true,"extra":[{"text":"\n第二行","italic":true}]}}) }
    fn base64(bytes: &[u8]) -> String { let alphabet=b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";let mut out=String::new();for chunk in bytes.chunks(3){let a=chunk[0];let b=chunk.get(1).copied().unwrap_or(0);let c=chunk.get(2).copied().unwrap_or(0);out.push(alphabet[(a>>2)as usize]as char);out.push(alphabet[(((a&3)<<4)|(b>>4))as usize]as char);out.push(if chunk.len()>1{alphabet[(((b&15)<<2)|(c>>6))as usize]as char}else{'='});out.push(if chunk.len()>2{alphabet[(c&63)as usize]as char}else{'='});}out }
    fn icon() -> String {
        use std::io::Write;
        fn chunk(out:&mut Vec<u8>,kind:&[u8;4],data:&[u8]){out.extend_from_slice(&(data.len()as u32).to_be_bytes());let start=out.len();out.extend_from_slice(kind);out.extend_from_slice(data);out.extend_from_slice(&crc32(&out[start..]).to_be_bytes());}
        let mut image=vec![0u8;(64*4+1)*64];for row in image.chunks_exact_mut(257){row[0]=0;for pixel in row[1..].chunks_exact_mut(4){pixel.copy_from_slice(&[64,128,255,255]);}}
        let mut z=flate2::write::ZlibEncoder::new(Vec::new(),flate2::Compression::default());z.write_all(&image).unwrap();let compressed=z.finish().unwrap();let mut bytes=b"\x89PNG\r\n\x1a\n".to_vec();let mut ihdr=Vec::new();ihdr.extend_from_slice(&64u32.to_be_bytes());ihdr.extend_from_slice(&64u32.to_be_bytes());ihdr.extend_from_slice(&[8,6,0,0,0]);chunk(&mut bytes,b"IHDR",&ihdr);chunk(&mut bytes,b"IDAT",&compressed);chunk(&mut bytes,b"IEND",&[]);format!("data:image/png;base64,{}",base64(&bytes))
    }
    #[test]
    fn address_contract_covers_ipv4_dns_ipv6_and_rejects_url_or_bad_ports() {
        for (raw, host, port, explicit) in [("mc.example.com", "mc.example.com", 25565, false), ("MC.Example.com:25566", "mc.example.com", 25566, true), ("127.0.0.1:1", "127.0.0.1", 1, true), ("[::1]:65535", "::1", 65535, true), ("[2001:db8::1]", "2001:db8::1", 25565, false)] { let value = parse_address(raw).unwrap(); assert_eq!((value.host.as_str(), value.port, value.explicit_port), (host, port, explicit)); }
        for bad in ["", "host:0", "host:65536", "host:-1", "host:1.5", "host:", ":25565", "::1", "[::1]oops", "[::1]:", "[bad]:80", "user@host", "https://host", "host/path", "host?secret=x", "ho st", "host\0", "256.1.2.3", "-bad.example", "host%scope"] { assert!(parse_address(bad).is_err(), "接受了无效地址 {bad:?}"); }
    }
    #[test]
    fn userinfo_validates_historical_names_uuid_and_official_texture_only() {
        for name in ["a", "AB", "player_123456789"] { assert!(username(name).is_ok()); }
        for name in ["", "中文", "space name", "abcdefghijklmnopq", "x/y"] { assert!(username(name).is_err()); }
        let value=map_userinfo(&json!({"username":"Steve","uuid":"12345678-1234-1234-1234-1234567890ab","skin_url":"http://textures.minecraft.net/texture/abc123","cape_url":"https://textures.minecraft.net/texture/f"}),"steve").unwrap();assert_eq!(value,json!({"username":"Steve","uuid":"123456781234123412341234567890ab","skinUrl":"https://textures.minecraft.net/texture/abc123","capeUrl":"https://textures.minecraft.net/texture/f"}));
        for bad in [json!({"username":"other","uuid":"123456781234123412341234567890ab"}),json!({"uuid":"bad"}),json!({"skin_url":"https://evil.invalid/texture/abc"}),json!({"skin_url":"https://textures.minecraft.net/texture/../abc"}),json!({"skin_url":"https://user:secret@textures.minecraft.net/texture/a"}),json!({"skin_url":"https://textures.minecraft.net/texture/xyz"}),json!({"uuid":12}),json!({})] { assert!(map_userinfo(&bad,"Steve").is_err()); }
    }
    #[tokio::test]
    async fn userinfo_real_http_reads_request_maps_four_fields_and_keeps_secret_in_header() {
        let (base,worker)=http_fixture(HttpReply::json(json!({"username":"AB","uuid":"123456781234123412341234567890ab","skin_url":"https://textures.minecraft.net/texture/a"}))).await;
        let q=Queries::loopback(&base,budgets());let value=q.userinfo("AB",&json!({"uapisApiKey":"FAKE_QUERY_SECRET"})).await.unwrap();assert_eq!(value.as_object().unwrap().len(),4);assert_eq!(value["capeUrl"],"");assert_eq!(value["username"],"AB");let request=worker.await.unwrap();assert!(request.starts_with("GET /userinfo?username=AB HTTP/1.1\r\n"));assert!(request.to_ascii_lowercase().contains("authorization: bearer fake_query_secret\r\n"));assert!(!request.lines().next().unwrap().contains("FAKE_QUERY_SECRET"));
    }
    #[tokio::test]
    async fn local_mode_and_invalid_inputs_never_open_http_or_tcp() {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let base=format!("http://{}/",listener.local_addr().unwrap());let q=Queries::loopback(&base,budgets());
        assert!(q.userinfo("Steve",&json!({"mode":"local"})).await.is_err());assert!(q.serverstatus("127.0.0.1:1",&json!({"mode":"local"})).await.is_err());assert!(q.userinfo("bad/name",&json!({})).await.is_err());assert!(q.serverstatus("host:0",&json!({})).await.is_err());assert!(timeout(Duration::from_millis(30),listener.accept()).await.is_err());assert!(call("minecraft:userinfo",&[json!("a")],&json!({"mode":"local"})).await.is_err());assert!(call("unrelated",&[],&json!({})).await.unwrap().is_none());
    }
    #[tokio::test]
    async fn api_http_errors_redirects_json_limits_and_deadline_are_redacted() {
        for reply in [HttpReply{status:401,headers:String::new(),body:b"FAKE_QUERY_SECRET https://secret.invalid/?token=FAKE_QUERY_SECRET".to_vec(),delay:Duration::ZERO,fragment:false},HttpReply{status:302,headers:"Location: http://127.0.0.1:1/FAKE_QUERY_SECRET\r\n".into(),body:Vec::new(),delay:Duration::ZERO,fragment:false},HttpReply{status:200,headers:String::new(),body:b"{invalid FAKE_QUERY_SECRET}".to_vec(),delay:Duration::ZERO,fragment:false},HttpReply{status:200,headers:String::new(),body:vec![b'x';JSON_LIMIT+1],delay:Duration::ZERO,fragment:false},HttpReply::json(json!([]))] {
            let(base,worker)=http_fixture(reply).await;let q=Queries::loopback(&base,budgets());let error=q.userinfo("Steve",&json!({"uapisApiKey":"FAKE_QUERY_SECRET"})).await.unwrap_err();assert!(!error.contains("FAKE_QUERY_SECRET")&&!error.contains("secret.invalid")&&!error.contains("127.0.0.1"));assert!(!worker.await.unwrap().is_empty());
        }
        let mut slow=HttpReply::json(json!({}));slow.delay=Duration::from_millis(180);let(base,worker)=http_fixture(slow).await;let q=Queries::loopback(&base,Budgets{http:Duration::from_millis(60),slp:Duration::from_millis(60)});assert!(q.userinfo("Steve",&json!({})).await.unwrap_err().contains("超时"));worker.await.unwrap();
    }
    #[test]
    fn motd_escapes_html_restricts_styles_and_bounds_components() {
        let rich=rich_motd(&json!({"text":"§a<hello>&","color":"red","bold":true,"extra":[{"text":"\n\"世界\"","italic":true,"clickEvent":{"action":"open_url","value":"javascript:bad"}}]})).unwrap();assert_eq!(rich.clean,"<hello>&\n\"世界\"");assert!(rich.html.contains("&lt;hello&gt;&amp;")&&rich.html.contains("<br />")&&rich.html.contains("font-style:italic"));assert!(!rich.html.contains("javascript")&&!rich.html.contains("clickEvent"));
        let html=api_html("<script>alert(1)</script><span style=\"color:#ff0000;background:url(javascript:bad);font-weight:bold\" onclick=\"bad()\">&lt;b&gt;hi&amp;</span><img src=x onerror=bad><br><i>tail</i>").unwrap();assert_eq!(html.clean,"<b>hi&\ntail");assert!(html.html.contains("color:#ff0000")&&html.html.contains("font-weight:700"));for forbidden in ["onclick","onerror","script","background","url(","<img","alert(1)"]{assert!(!html.html.contains(forbidden));}
        assert!(rich_motd(&json!("x".repeat(TEXT_LIMIT+1))).is_err());assert!(rich_motd(&json!({"text":"x","color":"red;position:fixed"})).is_err());assert!(rich_motd(&json!({"text":"x","bold":"true"})).is_err());let mut deep=json!("x");for _ in 0..20{deep=json!({"extra":[deep]});}assert!(rich_motd(&deep).is_err());
    }
    #[test]
    fn favicon_requires_bounded_real_png_and_rejects_crc_and_compressed_garbage() {
        let png=icon();assert_eq!(favicon(&png),png);assert!(favicon("https://example.invalid/icon.png").is_empty());assert!(favicon("data:image/svg+xml;base64,PHN2Zz4=").is_empty());assert!(favicon("data:image/png;base64,AAAA").is_empty());assert!(favicon(&format!("data:image/png;base64,{}","A".repeat(100000))).is_empty());let mut bytes=base64_decode(png.strip_prefix("data:image/png;base64,").unwrap()).unwrap();bytes[20]^=1;assert!(favicon(&format!("data:image/png;base64,{}",base64(&bytes))).is_empty());assert!(base64_decode("AA=A").is_none());
    }
    #[test]
    fn strict_frame_parser_rejects_overlong_varint_wrong_id_trailing_and_utf8() {
        for bytes in [vec![0x80,0],vec![0xff,0xff,0xff,0xff,0x10],vec![0x80;6],vec![0x80]]{assert!(number_in(&bytes,&mut 0).is_err());}
        for frame in [vec![1,2,b'{',b'}'],vec![0,3,b'{',b'}'],vec![0,2,0xff,0xff],vec![0,2,b'[',b']'],vec![0,2,b'{',b'}',0]]{assert!(parse_frame(&frame).is_err());}
    }
    #[tokio::test]
    async fn direct_slp_exact_handshake_fragmented_utf8_rich_motd_and_real_peer() {
        let(address,worker)=slp_fixture(status_frame(direct_status()),Duration::ZERO,true).await;let endpoint=parse_address(&address).unwrap();let value=ping(&endpoint,Duration::from_secs(2)).await.unwrap().dto(&endpoint);worker.await.unwrap();assert_eq!(value["online"],true);assert_eq!(value["players"],7);assert_eq!(value["maxPlayers"],40);assert_eq!(value["motdClean"],"<safe>\n第二行");assert!(value["motdHtml"].as_str().unwrap().contains("&lt;safe&gt;"));assert_eq!(value["ip"],"127.0.0.1");assert_eq!(value["port"],endpoint.port);
    }
    #[tokio::test]
    async fn api_missing_motd_uses_slp_but_retains_explicit_zero_and_fills_missing_fields() {
        let(address,slp)=slp_fixture(status_frame(direct_status()),Duration::ZERO,true).await;let(base,http)=http_fixture(HttpReply::json(json!({"online":false,"players":0,"max_players":0}))).await;let q=Queries::loopback(&base,budgets());let result=q.serverstatus(&address,&json!({})).await.unwrap();assert_eq!(result["online"],true);assert_eq!(result["players"],0);assert_eq!(result["maxPlayers"],0);assert_eq!(result["version"],"fixture 1.21.1");assert_eq!(result["motdClean"],"<safe>\n第二行");assert_eq!(result.as_object().unwrap().len(),9);let request=http.await.unwrap();assert!(request.starts_with("GET /serverstatus?server=127.0.0.1&port="));slp.await.unwrap();
        let mut reply=HttpReply::json(json!({"online":true}));reply.fragment=true;let(address,slp)=slp_fixture(status_frame(direct_status()),Duration::ZERO,false).await;let(base,http)=http_fixture(reply).await;let result=Queries::loopback(&base,budgets()).serverstatus(&address,&json!({})).await.unwrap();assert_eq!(result["players"],7);assert_eq!(result["maxPlayers"],40);http.await.unwrap();slp.await.unwrap();
    }
    #[tokio::test]
    async fn api_offline_with_motd_does_not_probe_or_claim_online() {
        let unused=TcpListener::bind("127.0.0.1:0").await.unwrap();let address=unused.local_addr().unwrap().to_string();let(base,http)=http_fixture(HttpReply::json(json!({"online":false,"players":0,"max_players":0,"motd_clean":"服务器离线","motd_html":"<b>服务器离线</b>","version":"cached","port":0}))).await;let result=Queries::loopback(&base,budgets()).serverstatus(&address,&json!({})).await.unwrap();assert_eq!(result["online"],false);assert_eq!(result["motdClean"],"服务器离线");assert!(timeout(Duration::from_millis(30),unused.accept()).await.is_err());http.await.unwrap();
    }
    #[tokio::test]
    async fn failed_api_falls_back_and_two_failed_paths_do_not_fake_online() {
        let(address,slp)=slp_fixture(status_frame(direct_status()),Duration::ZERO,false).await;let(base,http)=http_fixture(HttpReply{status:503,headers:String::new(),body:b"FAKE_QUERY_SECRET".to_vec(),delay:Duration::ZERO,fragment:false}).await;let result=Queries::loopback(&base,budgets()).serverstatus(&address,&json!({"uapisApiKey":"FAKE_QUERY_SECRET"})).await.unwrap();assert_eq!(result["online"],true);http.await.unwrap();slp.await.unwrap();
        let reserved=TcpListener::bind("127.0.0.1:0").await.unwrap();let address=reserved.local_addr().unwrap().to_string();drop(reserved);let(base,http)=http_fixture(HttpReply::json(json!({"online":false,"players":0}))).await;let result=Queries::loopback(&base,budgets()).serverstatus(&address,&json!({})).await.unwrap();assert_eq!(result["online"],false);http.await.unwrap();let(base,http)=http_fixture(HttpReply::json(json!({"error":"FAKE_QUERY_SECRET"}))).await;let error=Queries::loopback(&base,budgets()).serverstatus(&address,&json!({})).await.unwrap_err();assert!(!error.contains("FAKE_QUERY_SECRET")&&!error.contains("127.0.0.1"));http.await.unwrap();
    }
    #[tokio::test]
    async fn tcp_bad_frames_empty_object_oversize_and_absolute_deadline_are_rejected() {
        let mut too_large=Vec::new();varint((FRAME_LIMIT+1)as u32,&mut too_large);
        for response in [vec![0x80;6],too_large,vec![5,0,5,b'{'],status_frame(json!({})),vec![4,0,2,0xff,0xff]]{let(address,worker)=slp_fixture(response,Duration::ZERO,true).await;assert!(ping(&parse_address(&address).unwrap(),Duration::from_secs(1)).await.is_err());worker.await.unwrap();}
        let(address,worker)=slp_fixture(status_frame(json!({"version":{"name":"fixture","protocol":763},"players":{"online":0,"max":0}})),Duration::ZERO,true).await;let value=ping(&parse_address(&address).unwrap(),Duration::from_secs(1)).await.unwrap();assert_eq!(value.online,Some(true));assert_eq!(value.players,Some(0));assert!(!value.motd.present());worker.await.unwrap();
        let(address,worker)=slp_fixture(status_frame(direct_status()),Duration::from_millis(180),true).await;let started=Instant::now();assert!(ping(&parse_address(&address).unwrap(),Duration::from_millis(60)).await.unwrap_err().contains("超时"));assert!(started.elapsed()<Duration::from_secs(1));worker.await.unwrap();
    }
}

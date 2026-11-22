//! 三来源账户导入的纯解析层。
//! 本模块只处理调用方传入的字节/JSON，不访问文件、注册表、网络或凭据存储。

use base64::{engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD}, Engine as _};
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use chrono::DateTime;
use chacha20poly1305::{aead::{Aead, KeyInit, Payload}, ChaCha20Poly1305, Nonce};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

pub(super) struct Candidate {
    pub(super) account: Value,
    pub(super) status: String,
}

pub(super) struct Parsed {
    pub(super) candidates: Vec<Candidate>,
    pub(super) warnings: Vec<String>,
}

type Result<T> = std::result::Result<T, String>;
type Obj = Map<String, Value>;
type TdesDecryptor = cbc::Decryptor<des::TdesEde3>;

const MAX_DOCUMENT_BYTES: usize = 32 * 1024 * 1024;
const MAX_TOKEN_BYTES: usize = 32 * 1024;
const MAX_NAME_BYTES: usize = 64;
const MAX_FIELDS: usize = 500;
const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const HMCL_KEY: [u8; 32] = [
    0x3c, 0xd8, 0xa2, 0x22, 0x11, 0xd2, 0x8d, 0x89,
    0xb4, 0xf7, 0xd9, 0xb0, 0x65, 0xbc, 0x14, 0x8a,
    0x6e, 0xb0, 0xa9, 0x4d, 0xeb, 0x93, 0x99, 0x6f,
    0x84, 0x07, 0x5a, 0x9e, 0xbd, 0xc8, 0xd1, 0xeb,
];

fn object_or_empty(value: &Value) -> Obj {
    value.as_object().cloned().unwrap_or_default()
}

fn string(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or("").trim().to_owned()
}

fn safe_name(value: Option<&Value>) -> String {
    let value = string(value);
    if value.is_empty() || value.len() > MAX_NAME_BYTES || value.chars().any(char::is_control) { String::new() } else { value }
}

fn safe_token(value: Option<&Value>) -> String {
    let value = value.and_then(Value::as_str).unwrap_or("").trim().to_owned();
    if value.len() > MAX_TOKEN_BYTES || value.chars().any(|c| c.is_control() || c == ' ') { String::new() } else { value }
}

fn canonical_uuid(value: &str) -> Option<String> {
    let valid = if value.len() == 32 {
        value.bytes().all(|c| c.is_ascii_hexdigit())
    } else if value.len() == 36 {
        value.chars().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() })
    } else { false };
    if !valid { return None; }
    Some(value.chars().filter(|c| *c != '-').collect::<String>().to_ascii_lowercase())
}

fn offline_uuid(name: &str) -> String {
    let mut digest = md5::compute(format!("OfflinePlayer:{name}").as_bytes()).0;
    digest[6] = (digest[6] & 0x0f) | 0x30;
    digest[8] = (digest[8] & 0x3f) | 0x80;
    digest.iter().map(|v| format!("{v:02x}")).collect()
}

fn jwt_expiry(token: &str) -> u64 {
    let Some(part) = token.split('.').nth(1) else { return 0 };
    if part.is_empty() || part.len() > 16_384 { return 0; }
    let decoded = URL_SAFE_NO_PAD.decode(part).or_else(|_| URL_SAFE.decode(part)).ok();
    let Some(decoded) = decoded else { return 0 };
    let Ok(value) = serde_json::from_slice::<Value>(&decoded) else { return 0 };
    value.get("exp").and_then(Value::as_f64).filter(|v| v.is_finite() && *v > 0.0).map(|v| (v * 1000.0) as u64).unwrap_or(0)
}

fn expiry(value: Option<&Value>, token: &str) -> u64 {
    if let Some(number) = value.and_then(Value::as_u64) {
        return if number < 1_000_000_000_000 { number.saturating_mul(1000) } else { number };
    }
    if let Some(number) = value.and_then(Value::as_f64).filter(|v| v.is_finite() && *v > 0.0) {
        return if number < 1e12 { (number * 1000.0) as u64 } else { number as u64 };
    }
    if let Some(raw) = value.and_then(Value::as_str) {
        if let Ok(parsed) = DateTime::parse_from_rfc3339(raw) { return parsed.timestamp_millis().max(0) as u64; }
        if let Ok(parsed) = raw.parse::<u64>() { return if parsed < 1_000_000_000_000 { parsed.saturating_mul(1000) } else { parsed }; }
    }
    jwt_expiry(token)
}

fn microsoft_auth(value: Option<&Value>) -> Option<Value> {
    let value = value?.as_object()?;
    let client_id = string(value.get("clientId").or_else(|| value.get("client_id")));
    if client_id.is_empty() || client_id.len() > 128 || client_id.chars().any(|c| c.is_control()) { return None; }
    let valid_client = (client_id.len() == 16 && client_id.bytes().all(|c| c.is_ascii_alphanumeric()))
        || (client_id.len() == 36 && client_id.chars().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() }));
    if !valid_client { return None; }
    let scope = string(value.get("scope"));
    if scope.len() > 1024 || scope.chars().any(char::is_control) { return None; }
    let endpoint = match value.get("endpoint").and_then(Value::as_str).or_else(|| value.get("tokenEndpoint").and_then(Value::as_str)) {
        Some("consumers") | Some("https://login.microsoftonline.com/consumers/oauth2/v2.0/token") => "consumers",
        Some("live") | Some("https://login.live.com/oauth20_token.srf") => "live",
        Some(_) => return None,
        None => "consumers",
    };
    Some(json!({"clientId": client_id, "scope": if scope.is_empty() { "XboxLive.signin offline_access" } else { &scope }, "endpoint": endpoint}))
}

fn server_url(value: Option<&Value>) -> Option<String> {
    let raw = string(value);
    if raw.is_empty() || raw.len() > 2048 || raw.chars().any(char::is_control) { return None; }
    let parsed = reqwest::Url::parse(&raw).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.username() != "" || parsed.password().is_some() || parsed.query().is_some() || parsed.fragment().is_some() { return None; }
    Some(parsed.as_str().trim_end_matches('/').to_owned())
}

fn warning(parsed: &mut Parsed, value: &str) {
    if !parsed.warnings.iter().any(|item| item == value) { parsed.warnings.push(value.to_owned()); }
}

fn candidate(kind: &str, data: &Obj, now: u64) -> Option<Candidate> {
    let name = safe_name(data.get("name"));
    if name.is_empty() { return None; }
    let raw_id = string(data.get("id"));
    let id = if raw_id.is_empty() { None } else { canonical_uuid(&raw_id) };
    if kind == "offline" {
        if !raw_id.is_empty() {
            let expected_id = offline_uuid(&name);
            if id.as_deref() != Some(expected_id.as_str()) { return None; }
        }
    } else if kind != "microsoft" && id.is_none() {
        return None;
    }
    let id = id.unwrap_or_else(|| if kind == "offline" { offline_uuid(&name) } else { String::new() });
    let offline = kind == "offline";
    let access_token = if offline { String::new() } else { safe_token(data.get("accessToken")) };
    if !offline && data.get("accessToken").is_some() && !string(data.get("accessToken")).is_empty() && access_token.is_empty() { return None; }
    let auth = if kind == "microsoft" { microsoft_auth(data.get("microsoftAuth")) } else { None };
    let refresh_token = if auth.is_some() { safe_token(data.get("refreshToken")) } else { String::new() };
    let expires_at = if offline { JS_MAX_SAFE_INTEGER } else { expiry(data.get("expiresAt"), &access_token) };
    let server = if kind == "yggdrasil" { server_url(data.get("server"))? } else { String::new() };
    let client_token = if kind == "yggdrasil" { safe_token(data.get("clientToken")) } else { String::new() };
    let status = if offline { "ready" }
        else if id.is_empty() { "relogin" }
        else if kind == "yggdrasil" && !access_token.is_empty() && !client_token.is_empty() { "refresh" }
        else if !access_token.is_empty() && expires_at > now.saturating_add(60_000) { if !refresh_token.is_empty() { "ready" } else { "temporary" } }
        else if !refresh_token.is_empty() { "refresh" } else { "relogin" };
    let mut account = json!({"id": id, "name": name, "accessToken": if offline { "0" } else { &access_token }, "refreshToken": refresh_token, "expiresAt": expires_at, "addedAt": now, "authType": kind, "offline": offline});
    if let Some(auth) = auth { account["microsoftAuth"] = auth; }
    if !server.is_empty() {
        account["yggdrasilServer"] = Value::String(server);
        account["clientToken"] = Value::String(client_token);
        let site = safe_name(data.get("siteName"));
        if !site.is_empty() { account["siteName"] = Value::String(site); }
    }
    Some(Candidate { account, status: status.to_owned() })
}

fn add(parsed: &mut Parsed, kind: &str, data: Obj, now: u64) {
    let Some(entry) = candidate(kind, &data, now) else { warning(parsed, "invalid"); return };
    let id = entry.account.get("id").and_then(Value::as_str).unwrap_or("");
    let name = entry.account.get("name").and_then(Value::as_str).unwrap_or("");
    if let Some(existing) = parsed.candidates.iter().position(|item| {
        let existing_id = item.account.get("id").and_then(Value::as_str).unwrap_or("");
        if !id.is_empty() && !existing_id.is_empty() { id == existing_id } else { existing_id.is_empty() && item.account.get("name").and_then(Value::as_str) == Some(name) }
    }) {
        let rank = |status: &str| match status { "ready" | "refresh" => 3, "temporary" => 2, _ => 1 };
        if rank(&entry.status) > rank(&parsed.candidates[existing].status) { parsed.candidates[existing] = entry; }
    } else if parsed.candidates.len() < MAX_FIELDS { parsed.candidates.push(entry); } else { warning(parsed, "unsupported"); }
}

fn decode_b64(value: &str) -> Result<Vec<u8>> {
    STANDARD.decode(value).map_err(|_| "凭据封装不是有效 Base64".into())
}

fn hmcl_private(document: &Obj) -> Result<Vec<Value>> {
    let payload = document.get("payload").and_then(Value::as_array).ok_or("HMCL 凭据 payload 无效")?;
    match document.get("protection").and_then(Value::as_str) {
        Some("plain") => Ok(payload.clone()),
        Some("hmcl-obfuscated-v1") => {
            let nonce = decode_b64(&string(document.get("nonce")))?;
            if nonce.len() != 12 || payload.len() < 4 || payload.len() > 16_384 { return Err("HMCL 凭据封装范围无效".into()); }
            let mut size = 1usize; while size.saturating_mul(2) <= payload.len() { size *= 2; }
            if size < 4 || size > 16_384 { return Err("HMCL 凭据封装长度无效".into()); }
            let lanes = (1..=4).map(|i| payload[i * size / 4 - 1].as_str().ok_or_else(|| "HMCL 凭据片段不是字符串".to_owned())).collect::<Result<Vec<_>>>()?;
            let encoded = lanes.concat();
            if encoded.len() > MAX_DOCUMENT_BYTES || !encoded.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'=')) { return Err("HMCL 凭据片段格式无效".into()); }
            let bytes = decode_b64(&encoded)?;
            if bytes.len() < 16 { return Err("HMCL 凭据缺少 Poly1305 标签".into()); }
            let cipher = ChaCha20Poly1305::new_from_slice(&HMCL_KEY).map_err(|_| "HMCL 凭据密钥无效")?;
            let plain = cipher.decrypt(Nonce::from_slice(&nonce), Payload { msg: &bytes, aad: &[] }).map_err(|_| "HMCL 凭据认证标签校验失败")?;
            let value: Value = serde_json::from_slice(&plain).map_err(|_| "HMCL 凭据明文 JSON 无效")?;
            value.as_array().cloned().ok_or_else(|| "HMCL 凭据明文不是数组".into())
        }
        _ => Err("不支持的 HMCL 凭据封装".into()),
    }
}

fn decrypt_pcl(value: &str, identify: &str) -> Result<String> {
    let mut hash = 5381u64;
    let source = format!("PCL{identify}");
    for unit in source.encode_utf16() {
        let previous = hash;
        hash = previous.wrapping_shl(5) ^ previous ^ u64::from(unit);
    }
    hash ^= 0xA98F501BC684032F;
    let decimal = hash.to_string();
    let key_text = if decimal.len() < 8 { format!("{}{}", "X".repeat(8 - decimal.len()), decimal) } else { decimal[..8].to_owned() };
    let mut key = Vec::with_capacity(24); key.extend_from_slice(key_text.as_bytes()); key.extend_from_slice(key_text.as_bytes()); key.extend_from_slice(key_text.as_bytes());
    let mut ciphertext = decode_b64(value)?;
    let decryptor = TdesDecryptor::new_from_slices(&key, b"95168702").map_err(|_| "PCL DES 密钥无效")?;
    let plain = decryptor.decrypt_padded_mut::<Pkcs7>(&mut ciphertext).map_err(|_| "PCL 凭据解密失败")?;
    String::from_utf8(plain.to_vec()).map_err(|_| "PCL 凭据明文不是 UTF-8".into())
}

fn unescape_registry(value: &str) -> String {
    let mut out = String::new(); let mut chars = value.chars();
    while let Some(c) = chars.next() { if c == '\\' { if let Some(next) = chars.next() { if next == '\\' || next == '"' { out.push(next); } else { out.push('\\'); out.push(next); } } else { out.push('\\'); } } else { out.push(c); } }
    out
}

const PCL_FIELDS: &[&str] = &[
    "Identify", "LoginLegacyName", "LoginMsJson", "CacheMsUuid", "CacheMsName", "CacheMsAccess", "CacheMsOAuthRefresh",
    "CacheMsV2Uuid", "CacheMsV2Name", "CacheMsV2Access", "CacheMsV2OAuthRefresh", "CacheMsV2Expires", "CacheAuthUuid",
    "CacheAuthName", "CacheAuthAccess", "CacheAuthClient", "CacheAuthServerServer", "CacheAuthServerName",
];

pub(super) fn parse_registry(content: &str) -> Result<Vec<Value>> {
    if content.len() > MAX_DOCUMENT_BYTES { return Err("PCL 注册表导出超过大小上限".into()); }
    let mut lines = Vec::<String>::new();
    let mut carry = String::new();
    for raw in content.lines() {
        let line = raw.trim_end();
        let continued = line.ends_with('\\');
        let part = if continued { &line[..line.len() - 1] } else { line };
        carry.push_str(part);
        if !continued { lines.push(std::mem::take(&mut carry)); }
    }
    if !carry.is_empty() { lines.push(carry); }
    let mut output = Vec::new(); let mut current: Option<Obj> = None;
    for line in lines {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            if let Some(section) = current.take() { output.push(Value::Object(section)); }
            let lower = line.to_ascii_lowercase();
            let allowed = matches!(lower.as_str(), "[hkey_current_user\\software\\pcl]" | "[hkey_current_user\\software\\pcl2]" | "[hkey_current_user\\software\\pcldebug]");
            if allowed { let mut section = Obj::new(); section.insert("_pclDebug".into(), json!(lower.ends_with("\\pcldebug]"))); current = Some(section); }
            continue;
        }
        let Some(section) = current.as_mut() else { continue };
        let Some(rest) = line.strip_prefix('"') else { continue };
        let Some((key, raw)) = rest.split_once("\"=") else { continue };
        if key.is_empty() || key.len() > 128 || !key.bytes().all(|c| c.is_ascii_alphanumeric()) || !PCL_FIELDS.iter().any(|known| *known == key) { continue; }
        let raw = raw.trim();
        let value = if raw.starts_with('"') && raw.ends_with('"') && raw.len() >= 2 { Some(Value::String(unescape_registry(&raw[1..raw.len() - 1]))) }
            else if raw.to_ascii_lowercase().starts_with("hex(2):") { let hex: String = raw[7..].chars().filter(|c| *c != ',').collect(); if hex.len() % 2 != 0 || !hex.bytes().all(|c| c.is_ascii_hexdigit()) { None } else { let bytes = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect::<Vec<_>>(); if bytes.len() % 2 != 0 { None } else { let units = bytes.chunks_exact(2).map(|x| u16::from_le_bytes([x[0], x[1]])).take_while(|u| *u != 0).collect::<Vec<_>>(); String::from_utf16(&units).ok().map(Value::String) } } }
            else { None };
        if let Some(value) = value { section.insert(key.to_owned(), value); }
    }
    if let Some(section) = current { output.push(Value::Object(section)); }
    Ok(output)
}

pub(super) fn decode_file(bytes: &[u8]) -> Result<String> {
    if bytes.len() > MAX_DOCUMENT_BYTES { return Err("账户文件超过大小上限".into()); }
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { return String::from_utf8(bytes[3..].to_vec()).map_err(|_| "账户文件不是有效 UTF-8".into()); }
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        let little = bytes[0] == 0xFF; let body = &bytes[2..]; if body.len() % 2 != 0 { return Err("UTF-16 账户文件长度无效".into()); }
        let units = body.chunks_exact(2).map(|x| if little { u16::from_le_bytes([x[0], x[1]]) } else { u16::from_be_bytes([x[0], x[1]]) }).collect::<Vec<_>>();
        let text = String::from_utf16(&units).map_err(|_| "UTF-16 账户文件无效".to_string())?;
        return Ok(text.trim_end_matches('\0').to_owned());
    }
    String::from_utf8(bytes.to_vec()).map(|text| text.trim_start_matches('\u{feff}').to_owned()).map_err(|_| "账户文件不是有效 UTF-8".into())
}

fn as_entries(value: Option<&Value>) -> Vec<Value> {
    match value { Some(Value::Array(items)) => items.clone(), Some(Value::Object(items)) => items.values().cloned().collect(), _ => Vec::new() }
}

fn parse_official(parsed: &mut Parsed, documents: &[Value], now: u64) {
    for root in documents {
        for raw in as_entries(root.get("accounts")) {
            let item = object_or_empty(&raw); let typ = string(item.get("type"));
            if !matches!(typ.as_str(), "Xbox" | "MSA" | "Microsoft") { warning(parsed, "unsupported"); continue; }
            let profile = object_or_empty(item.get("minecraftProfile").unwrap_or(&Value::Null));
            let mut data = Obj::new(); data.insert("id".into(), profile.get("id").cloned().unwrap_or(Value::Null)); data.insert("name".into(), profile.get("name").cloned().unwrap_or(Value::Null)); data.insert("accessToken".into(), item.get("accessToken").cloned().unwrap_or(Value::Null)); data.insert("expiresAt".into(), item.get("expiresAt").cloned().unwrap_or(Value::Null)); add(parsed, "microsoft", data, now);
        }
        if let Some(database) = root.get("authenticationDatabase").and_then(Value::as_object) {
            for raw in database.values() { for (id, profile) in object_or_empty(raw.get("profiles").unwrap_or(&Value::Null)).into_iter() { let mut data = Obj::new(); data.insert("id".into(), Value::String(id)); data.insert("name".into(), Value::String(safe_name(profile.as_object().and_then(|p| p.get("displayName"))).to_string())); add(parsed, "microsoft", data, now); } }
        }
    }
    warning(parsed, "protected");
}

fn parse_hmcl(parsed: &mut Parsed, documents: &[Value], now: u64) {
    let mut private_data = HashMap::<String, Obj>::new();
    for doc in documents {
        let map = object_or_empty(doc); if !map.contains_key("protection") { continue; }
        match hmcl_private(&map) { Ok(items) => for raw in items { let item = object_or_empty(&raw); let id = string(item.get("accountID")); if !id.is_empty() { private_data.insert(id, object_or_empty(item.get("privateData").unwrap_or(&Value::Null))); } }, Err(_) => warning(parsed, "protected") }
    }
    for root in documents {
        for raw in as_entries(root.get("accounts")) {
            let item = object_or_empty(&raw); let account_id = string(item.get("accountID")); let split = !account_id.is_empty(); let secret = if split { private_data.get(&account_id).cloned().unwrap_or_default() } else { item.clone() };
            let typ = string(item.get("type")).to_ascii_lowercase(); let mut data = Obj::new();
            if typ == "offline" { data.insert("id".into(), item.get("profileID").cloned().or_else(|| item.get("uuid").cloned()).unwrap_or(Value::Null)); data.insert("name".into(), item.get("profileName").cloned().or_else(|| item.get("username").cloned()).unwrap_or(Value::Null)); add(parsed, "offline", data, now); }
            else if typ == "microsoft" {
                if split && !private_data.contains_key(&account_id) { warning(parsed, "protected"); continue; }
                data.insert("id".into(), item.get("profileID").cloned().or_else(|| item.get("uuid").cloned()).unwrap_or(Value::Null)); data.insert("name".into(), secret.get("profileName").cloned().or_else(|| item.get("displayName").cloned()).unwrap_or(Value::Null)); data.insert("accessToken".into(), secret.get("accessToken").cloned().unwrap_or(Value::Null)); data.insert("refreshToken".into(), secret.get("refreshToken").cloned().unwrap_or(Value::Null)); data.insert("expiresAt".into(), secret.get("notAfter").cloned().unwrap_or(Value::Null)); let mut auth = object_or_empty(item.get("microsoftAuth").unwrap_or(&Value::Null)); auth.extend(object_or_empty(secret.get("microsoftAuth").unwrap_or(&Value::Null))); for key in ["clientId", "client_id", "scope", "endpoint", "tokenEndpoint"] { if !auth.contains_key(key) { if let Some(value) = item.get(key) { auth.insert(key.to_owned(), value.clone()); } } } if !auth.is_empty() { data.insert("microsoftAuth".into(), Value::Object(auth)); } add(parsed, "microsoft", data, now);
            } else if matches!(typ.as_str(), "authlibinjector" | "authlib-injector" | "yggdrasil") {
                if split && !private_data.contains_key(&account_id) { warning(parsed, "protected"); continue; }
                data.insert("id".into(), item.get("profileID").cloned().or_else(|| item.get("uuid").cloned()).unwrap_or(Value::Null)); data.insert("name".into(), secret.get("profileName").cloned().or_else(|| item.get("displayName").cloned()).unwrap_or(Value::Null)); data.insert("accessToken".into(), secret.get("accessToken").cloned().unwrap_or(Value::Null)); data.insert("clientToken".into(), secret.get("clientToken").cloned().unwrap_or(Value::Null)); data.insert("server".into(), item.get("serverBaseURL").cloned().unwrap_or(Value::Null)); data.insert("siteName".into(), item.get("serverName").cloned().unwrap_or(Value::Null)); add(parsed, "yggdrasil", data, now);
            } else if !typ.is_empty() { warning(parsed, "unsupported"); }
        }
    }
}

fn parse_pcl(parsed: &mut Parsed, documents: &[Value], now: u64) {
    const KEYS: &[&str] = &["LoginLegacyName", "LoginMsJson", "CacheMsUuid", "CacheMsName", "CacheMsAccess", "CacheMsOAuthRefresh", "CacheMsV2Uuid", "CacheMsV2Name", "CacheMsV2Access", "CacheMsV2OAuthRefresh", "CacheMsV2Expires", "CacheAuthUuid", "CacheAuthName", "CacheAuthAccess", "CacheAuthClient", "CacheAuthServerServer", "CacheAuthServerName"];
    for section in documents {
        let map = object_or_empty(section); let identify = { let value = string(map.get("Identify")); if value.is_empty() { if map.get("_pclDebug").and_then(Value::as_bool) == Some(true) { Some("0000-0000-0000-0000".to_owned()) } else { None } } else { Some(value) } }; let plaintext = map.get("_pclPlaintext").and_then(Value::as_bool) == Some(true); let mut decoded = Obj::new();
        for key in KEYS { let raw = string(map.get(*key)); if raw.is_empty() { continue; } if plaintext { decoded.insert((*key).into(), Value::String(raw)); } else if let Some(id) = identify.as_deref() { match decrypt_pcl(&raw, id) { Ok(value) => { decoded.insert((*key).into(), Value::String(value)); }, Err(_) => warning(parsed, "protected") } } else { warning(parsed, "protected"); } }
        let legacy_names = string(decoded.get("LoginLegacyName"));
        for player in legacy_names.split('¨').filter(|v| !v.is_empty()).take(MAX_FIELDS) { let mut data=Obj::new(); data.insert("name".into(),Value::String(player.to_owned())); add(parsed,"offline",data,now); }
        for prefix in ["CacheMsV2", "CacheMs"] { if let Some(name)=decoded.get(&format!("{prefix}Name")) { let mut data=Obj::new(); data.insert("id".into(),decoded.get(&format!("{prefix}Uuid")).cloned().unwrap_or(Value::Null)); data.insert("name".into(),name.clone()); data.insert("accessToken".into(),decoded.get(&format!("{prefix}Access")).cloned().unwrap_or(Value::Null)); data.insert("refreshToken".into(),decoded.get(&format!("{prefix}OAuthRefresh")).cloned().unwrap_or(Value::Null)); data.insert("expiresAt".into(),decoded.get(&format!("{prefix}Expires")).cloned().unwrap_or(Value::Null)); if let Some(auth) = map.get("microsoftAuth") { data.insert("microsoftAuth".into(),auth.clone()); } add(parsed,"microsoft",data,now); } }
        if decoded.get("CacheAuthName").is_some() { let mut data=Obj::new(); for (from,to) in [("CacheAuthUuid","id"),("CacheAuthName","name"),("CacheAuthAccess","accessToken"),("CacheAuthClient","clientToken"),("CacheAuthServerServer","server"),("CacheAuthServerName","siteName")] { data.insert(to.into(),decoded.get(from).cloned().unwrap_or(Value::Null)); } add(parsed,"yggdrasil",data,now); }
        if let Some(raw) = decoded.get("LoginMsJson").and_then(Value::as_str) { if let Ok(value)=serde_json::from_str::<Value>(raw) { let accounts = object_or_empty(&value); for player in accounts.keys().take(MAX_FIELDS) { if !parsed.candidates.iter().any(|entry| entry.account.get("name").and_then(Value::as_str)==Some(player)&&entry.account.get("authType").and_then(Value::as_str)==Some("microsoft")) { let mut data=Obj::new();data.insert("name".into(),Value::String(player.clone()));add(parsed,"microsoft",data,now); } } } else { warning(parsed,"invalid"); } }
    }
}

pub(super) fn parse(source: &str, documents: Vec<Value>, now: u64) -> Result<Parsed> {
    if documents.len() > MAX_FIELDS { return Err("账户文档数量超过上限".into()); }
    let mut parsed=Parsed{candidates:Vec::new(),warnings:Vec::new()};
    match source { "official"=>parse_official(&mut parsed,&documents,now), "hmcl"=>parse_hmcl(&mut parsed,&documents,now), "pcl2"=>parse_pcl(&mut parsed,&documents,now), _=>return Err("不支持的账户来源".into()) }
    if parsed.candidates.is_empty() && parsed.warnings.is_empty() { warning(&mut parsed,"unsupported"); }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn offline_id_and_strict_uuid() { assert_eq!(offline_uuid("Notch"),"b50ad385829d3141a2167e7d7539ba7f"); assert!(canonical_uuid("bad").is_none()); }
    #[test] fn registry_and_encoding_are_bounded() { let docs=parse_registry("Windows Registry Editor Version 5.00\n[HKEY_CURRENT_USER\\Software\\PCL2]\n\"LoginLegacyName\"=\"Steve\"\n").unwrap(); assert_eq!(docs.len(),1); assert_eq!(docs[0]["LoginLegacyName"],"Steve"); assert_eq!(decode_file(&[0xff,0xfe,b'S',0]).unwrap(),"S"); }
    #[test] fn official_without_oauth_does_not_guess_client() { let parsed=parse("official",vec![json!({"accounts":{"a":{"type":"Microsoft","minecraftProfile":{"id":"12345678-1234-1234-1234-1234567890ab","name":"A"}}}})],100).unwrap(); assert_eq!(parsed.candidates.len(),1); assert!(parsed.candidates[0].account.get("microsoftAuth").is_none()); assert_eq!(parsed.candidates[0].status,"relogin"); }
    #[test] fn preview_status_respects_identity_and_canonical_offline_contract() {
        let without_id=json!({"name":"Fixture","accessToken":"FAKE_ACCESS","expiresAt":2_000_000_000_000u64,"refreshToken":"FAKE_REFRESH","microsoftAuth":{"clientId":"00000000441cc96b"}});
        assert_eq!(candidate("microsoft",without_id.as_object().unwrap(),1_900_000_000_000).unwrap().status,"relogin");
        let wrong_id=json!({"name":"Notch","id":"123456781234123412341234567890ab"});
        assert!(candidate("offline",wrong_id.as_object().unwrap(),100).is_none());
        let right_id=json!({"name":"Notch","id":"b50ad385-829d-3141-a216-7e7d7539ba7f"});
        let account=candidate("offline",right_id.as_object().unwrap(),100).unwrap();
        assert_eq!(account.account["id"],offline_uuid("Notch"));assert_eq!(account.status,"ready");
    }
    #[test] fn registry_selection_and_unknown_protection_do_not_expose_arbitrary_values() {
        let documents=parse_registry("[HKEY_CURRENT_USER\\Software\\Other]\n\"LoginLegacyName\"=\"Other\"\n[HKEY_CURRENT_USER\\Software\\PCL]\n\"Password\"=\"FAKE_PASSWORD\"\n\"LoginLegacyName\"=\"unknowncipher\"\n").unwrap();
        assert_eq!(documents.len(),1);assert!(documents[0].get("Password").is_none());
        let parsed=parse("pcl2",documents,100).unwrap();assert!(parsed.candidates.is_empty());assert_eq!(parsed.warnings,vec!["protected"]);
        assert!(decode_file(&[0xff,0xfe,0x41]).is_err());assert!(decode_file(&[0xfe,0xff,0xd8,0x00]).is_err());
    }
    #[test] fn hmcl_plain_source_metadata_keeps_exact_oauth_and_tamper_is_not_decrypted() {
        let id="123456781234123412341234567890ab";
        let metadata=json!({"accounts":[{"accountID":"meta-id","type":"microsoft","profileID":id,"clientId":"00000000441cc96b","scope":"XboxLive.signin offline_access"}]});
        let private=json!({"protection":"plain","payload":[{"accountID":"meta-id","privateData":{"profileName":"Fixture","accessToken":"FAKE_ACCESS","refreshToken":"FAKE_REFRESH","notAfter":1_800_000_000_000u64}}]});
        let parsed=parse("hmcl",vec![metadata.clone(),private],1_900_000_000_000).unwrap();
        assert_eq!(parsed.candidates.len(),1);assert_eq!(parsed.candidates[0].account["id"],id);assert_eq!(parsed.candidates[0].status,"refresh");assert_eq!(parsed.candidates[0].account["microsoftAuth"]["endpoint"],"consumers");
        let protected=json!({"protection":"hmcl-obfuscated-v1","nonce":"AAECAwQFBgcICQoL","payload":["AAAA","AAAA","AAAA","AAAA"]});
        let parsed=parse("hmcl",vec![metadata,protected],100).unwrap();assert!(parsed.candidates.is_empty());assert!(parsed.warnings.contains(&"protected".into()));
    }
    #[test] fn pcl_external_vector_uses_utf16_wrapping_hash() {
        let parsed = parse("pcl2", vec![json!({"Identify":"测试😀-identify","LoginLegacyName":"FB52cMcnsWL5fHfdTBFYpA=="})], 100).unwrap();
        let names: Vec<_> = parsed.candidates.iter().filter_map(|candidate| candidate.account.get("name").and_then(Value::as_str)).collect();
        assert_eq!(names, vec!["Steve", "Alex"]);
        assert!(parsed.warnings.is_empty());
        assert_eq!(parsed.candidates[0].account["accessToken"], "0");
        assert_eq!(parsed.candidates[0].account["expiresAt"], JS_MAX_SAFE_INTEGER);
    }
    #[test] fn hmcl_external_vector_merges_private_data_without_guessing_oauth() {
        let encoded = "b7DMXz79ryUZa0ATZFsWHiCYtunj0GPV70fT5qb7XtN7JSRnQbWHA3DqBiJHySa5FjHF+/CiTtH4T/VzwzvF0YldJ94em7qLUmfEXzCvPbRHtzeTFfp9i4EPOE8A0j10nINe2tsk7B9Cmys6e7dCjhtB5WPQ2UPPWPHjsJqB8/eh+syjwucddV7Ul0WZsVEL0sp/shhZNqzFMOplCRnaEjgdjtzswviDm03Whw==";
        assert_eq!(encoded.len() % 4, 0);
        let lane_len = encoded.len() / 4;
        let payload: Vec<Value> = encoded.as_bytes().chunks(lane_len).map(|chunk| Value::String(String::from_utf8(chunk.to_vec()).unwrap())).collect();
        let documents = vec![
            json!({"accounts":[{"accountID":"fixture-account","type":"microsoft","profileID":"12345678-1234-1234-1234-1234567890ab","displayName":"Fixture"}]}),
            json!({"protection":"hmcl-obfuscated-v1","nonce":"AAECAwQFBgcICQoL","payload":payload}),
        ];
        let parsed = parse("hmcl", documents, 1_900_000_000_000).unwrap();
        assert_eq!(parsed.candidates.len(), 1);
        let account = &parsed.candidates[0].account;
        assert_eq!(account["name"], "Fixture");
        assert_eq!(account["accessToken"], "FAKE_ACCESS");
        assert_eq!(account["refreshToken"], "");
        assert_eq!(parsed.candidates[0].status, "temporary");
        assert!(!parsed.warnings.iter().any(|warning| warning == "protected"));
    }
}

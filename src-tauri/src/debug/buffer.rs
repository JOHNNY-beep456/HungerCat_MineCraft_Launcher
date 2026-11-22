//! 有界、只驻内存的诊断日志；在入账前处理已知凭据及常见秘密结构。
//! 结构识别不能保证发现任意未标注的秘密；调用者仍须只传入允许记录的正文，
//! 渲染层继续使用上层的「正文不留存」策略，不应以本模块替代来源白名单。
use regex::Regex;
use serde_json::{json, Value};
use std::{collections::VecDeque, sync::OnceLock};

const MAX_ENTRIES: usize = 2000;
const MAX_BUFFER_BYTES: usize = 8 * 1024 * 1024;
const MAX_MESSAGE_BYTES: usize = 8000;
const MAX_SOURCE_BYTES: usize = 128;
const MAX_DIAGNOSTIC_ENTRIES: usize = 800;
const MAX_DIAGNOSTIC_BYTES: usize = 400 * 1024;
const HIDDEN: &str = "[已隐藏]";

#[derive(Clone, Debug, serde::Serialize)]
pub(super) struct Entry {
    pub ts: u64,
    pub level: String,
    pub message: String,
}

#[derive(Default)]
pub(super) struct Buffer {
    // 字节数包含完整 Entry 的 JSON 结构与一个分隔符，另预留数组的两个括号。
    entries: VecDeque<(Entry, usize)>,
    bytes: usize,
}

impl Buffer {
    pub fn push(&mut self, ts: u64, level: &str, source: &str, message: &str, secrets: &[String]) -> Result<Entry, String> {
        if !matches!(level, "info" | "warn" | "error") {
            return Err("日志级别无效".into());
        }
        let source = truncate_utf8(sanitize(source, secrets), MAX_SOURCE_BYTES);
        let message = sanitize(message, secrets);
        let message = if source.is_empty() { message } else { format!("[{source}] {message}") };
        let mut entry = Entry { ts, level: level.into(), message: truncate_utf8(message, MAX_MESSAGE_BYTES) };
        // 单条连同 JSON 字段也不超过 8000 字节；引号/反斜杠的转义扩张同样计费。
        let mut encoded = serde_json::to_vec(&entry).map_err(|_| "日志编码失败".to_string())?;
        if encoded.len() > MAX_MESSAGE_BYTES {
            let empty = Entry { ts, level: level.into(), message: String::new() };
            let overhead = serde_json::to_vec(&empty).map_err(|_| "日志编码失败".to_string())?.len();
            entry.message = truncate_json_message(&entry.message, MAX_MESSAGE_BYTES - overhead);
            encoded = serde_json::to_vec(&entry).map_err(|_| "日志编码失败".to_string())?;
        }
        let size = encoded.len() + 1;
        if size.saturating_add(2) > MAX_BUFFER_BYTES { return Err("日志条目过大".into()); }
        while self.entries.len() >= MAX_ENTRIES || self.bytes.saturating_add(size).saturating_add(2) > MAX_BUFFER_BYTES {
            match self.entries.pop_front() {
                Some((_, removed)) => self.bytes -= removed,
                None => break,
            }
        }
        self.bytes += size;
        self.entries.push_back((entry.clone(), size));
        Ok(entry)
    }

    pub fn snapshot(&self) -> Vec<Entry> {
        self.entries.iter().map(|(entry, _)| entry.clone()).collect()
    }

    pub fn diagnostic(&self) -> Value {
        // 只选连续的最新后缀；不跳过大条目再拼入更早的记录，也不按不可信 ts 重排。
        let mut logs = Vec::new();
        let mut bytes = 2usize;
        for (entry, size) in self.entries.iter().rev() {
            let encoded = *size - 1;
            let next = bytes + encoded + usize::from(!logs.is_empty());
            if logs.len() >= MAX_DIAGNOSTIC_ENTRIES || next > MAX_DIAGNOSTIC_BYTES { break; }
            logs.push(entry.clone());
            bytes = next;
        }
        logs.reverse();
        let errors = self.entries.iter().filter(|(entry, _)| entry.level == "error").count();
        let warnings = self.entries.iter().filter(|(entry, _)| entry.level == "warn").count();
        json!({
            "stats": { "total": self.entries.len(), "sent": logs.len(), "errorCount": errors, "warnCount": warnings },
            "logs": logs,
        })
    }
}

struct Rules {
    url: Regex,
    bearer: Regex,
    assignment: Regex,
    jwt: Regex,
    opaque: Regex,
}
fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| Rules {
        // 包括普通及 JSON 反斜杠转义后的 scheme://，整条 URL 丢弃而非仅删查询值。
        url: Regex::new(r#"(?i)(?:[a-z][a-z0-9+.-]{0,31}:(?://|\\/\\/)|www\.)[^\s<>"'`]+"#).expect("常量 URL 正则"),
        bearer: Regex::new(r"(?i)(?-u:\b)(?:bearer|basic)\s+[a-z0-9._~+/=-]+").expect("常量鉴权正则"),
        assignment: Regex::new(concat!(
            r#"(?i)(?:(?-u:\b)(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?token|"#,
            r#"authorization|proxy[_-]?authorization|password|passwd|pwd|secret|secret[_-]?key|"#,
            r#"api[_-]?key|debug[_-]?key|client[_-]?secret|device[_-]?code|user[_-]?code|"#,
            r#"cookie|set[_-]?cookie|token|key|code|credentials?|accounts?|microsoft[_-]?auth)(?-u:\b)(?:\\?["'])?\s*[:=]\s*"#,
            r#"|--(?:access[_-]?token|refresh[_-]?token|client[_-]?token|password|secret|api[_-]?key)\s+)"#,
        )).expect("常量秘密字段正则"),
        jwt: Regex::new(r"(?-u:\b)(?:eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+|[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,})(?-u:\b)").expect("常量 JWT 正则"),
        opaque: Regex::new(r"(?i)[a-z0-9_+/-]{40,}={0,2}|[0-9a-f]{32,}").expect("常量不透明凭据正则"),
    })
}

fn sanitize(raw: &str, secrets: &[String]) -> String {
    // 先替换原始值，防止折行或截断把已知秘密变成无法匹配的前缀。
    let mut value = raw.to_owned();
    let mut known: Vec<&str> = secrets.iter().map(String::as_str).filter(|secret| !secret.is_empty()).collect();
    known.sort_unstable_by_key(|secret| std::cmp::Reverse(secret.len()));
    known.dedup();
    for secret in known {
        // 日志可能已把字符串 JSON 转义；同时遮住已知值的转义表示，而非只匹配原始换行。
        if let Ok(encoded) = serde_json::to_string(secret) {
            let escaped = &encoded[1..encoded.len() - 1];
            if !escaped.is_empty() { value = value.replace(escaped, HIDDEN); }
        }
        value = value.replace(secret, HIDDEN);
    }
    // 先移除可插进字段名/URL/鉴权方案的不可见字符，避免脱敏之后才清理而重新拼出秘密。
    // 换行与制表仍交给规则匹配，最后再折叠为单条可见日志。
    value.retain(|character| !invisible(character));
    // 完整 JSON 先按实际字段名投影，覆盖 Unicode 转义键和嵌套的命名秘密对象。
    if let Ok(mut structured) = serde_json::from_str::<Value>(&value) {
        if structured.is_object() || structured.is_array() {
            redact_json(&mut structured);
            if let Ok(encoded) = serde_json::to_string(&structured) { value = encoded; }
        }
    }
    // JSON 解码也可能把 Unicode 转义还原为不可见字符，因此在规则匹配前再次清理。
    value.retain(|character| !invisible(character));
    let rules = rules();
    value = rules.url.replace_all(&value, HIDDEN).into_owned();
    value = rules.bearer.replace_all(&value, HIDDEN).into_owned();
    value = redact_assignments(&value, &rules.assignment);
    value = rules.jwt.replace_all(&value, HIDDEN).into_owned();
    value = rules.opaque.replace_all(&value, HIDDEN).into_owned();
    fold(&value)
}

fn redact_json(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            for (key, value) in fields {
                let normalized: String = key.chars().filter(|character| character.is_ascii_alphanumeric()).map(|character| character.to_ascii_lowercase()).collect();
                if matches!(normalized.as_str(), "accesstoken" | "refreshtoken" | "idtoken" | "clienttoken" | "authorization" | "proxyauthorization" | "password" | "passwd" | "pwd" | "secret" | "secretkey" | "apikey" | "debugkey" | "clientsecret" | "devicecode" | "usercode" | "cookie" | "setcookie" | "token" | "key" | "code" | "credential" | "credentials" | "account" | "accounts" | "microsoftauth") {
                    *value = json!(HIDDEN);
                } else { redact_json(value); }
            }
        }
        Value::Array(items) => { for item in items { redact_json(item); } }
        _ => {}
    }
}
fn redact_assignments(raw: &str, pattern: &Regex) -> String {
    let mut output = String::with_capacity(raw.len());
    let mut cursor = 0;
    while let Some(found) = pattern.find_at(raw, cursor) {
        output.push_str(&raw[cursor..found.end()]);
        output.push_str(HIDDEN);
        cursor = secret_value_end(raw, found.end());
    }
    output.push_str(&raw[cursor..]);
    output
}

/// 秘密字段若是对象/数组，消费完整容器；不能仅遮住第一个字符串而漏出其余子项。
fn secret_value_end(raw: &str, start: usize) -> usize {
    let bytes = raw.as_bytes();
    if start == bytes.len() { return start; }
    let first = bytes[start];
    // 外层日志可能是再次 JSON 编码的字符串；无法证明转义引号的层级时保守隐藏余下正文。
    if first == b'\\' { return bytes.len(); }
    if matches!(first, b'\'' | b'"') { return quoted_end(bytes, start, first); }
    if matches!(first, b'{' | b'[') {
        let mut stack = vec![if first == b'{' { b'}' } else { b']' }];
        let mut cursor = start + 1;
        while cursor < bytes.len() {
            match bytes[cursor] {
                quote @ (b'\'' | b'"') => { cursor = quoted_end(bytes, cursor, quote); continue; }
                b'{' | b'[' => {
                    if stack.len() >= 64 { return bytes.len(); }
                    stack.push(if bytes[cursor] == b'{' { b'}' } else { b']' });
                }
                closing @ (b'}' | b']') => {
                    if stack.pop() != Some(closing) { return bytes.len(); }
                    if stack.is_empty() { return cursor + 1; }
                }
                _ => {}
            }
            cursor += 1;
        }
        return bytes.len();
    }
    // 未加引号的秘密也可能含空格；保守消费到结构/行边界，而不是只遮第一个单词。
    let mut cursor = start;
    while cursor < bytes.len() && !matches!(bytes[cursor], b',' | b';' | b'&' | b'\r' | b'\n' | b'}' | b']') { cursor += 1; }
    cursor
}
fn quoted_end(bytes: &[u8], start: usize, quote: u8) -> usize {
    let mut cursor = start + 1;
    while cursor < bytes.len() {
        if bytes[cursor] == b'\\' { cursor = (cursor + 2).min(bytes.len()); continue; }
        if bytes[cursor] == quote { return cursor + 1; }
        cursor += 1;
    }
    bytes.len()
}
fn invisible(character: char) -> bool {
    (character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
        || matches!(character, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}')
}
fn fold(raw: &str) -> String {
    let mut result = String::with_capacity(raw.len());
    for character in raw.chars() {
        match character {
            '\n' | '\r' | '\u{2028}' | '\u{2029}' => result.push_str(" ⏎ "),
            '\t' => result.push(' '),
            value if value.is_control() || matches!(value, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}') => {}
            value => result.push(value),
        }
    }
    result
}
fn truncate_json_message(value: &str, max: usize) -> String {
    const SUFFIX: &str = "…[截断]";
    let mut bytes = 0usize;
    let mut end = 0;
    for (index, character) in value.char_indices() {
        let cost = if matches!(character, '"' | '\\') { 2 } else { character.len_utf8() };
        if bytes + cost + SUFFIX.len() > max { break; }
        bytes += cost;
        end = index + character.len_utf8();
    }
    format!("{}{SUFFIX}", &value[..end])
}
fn truncate_utf8(mut value: String, max: usize) -> String {
    if value.len() <= max { return value; }
    const SUFFIX: &str = "…[截断]";
    let target = max.saturating_sub(SUFFIX.len());
    let mut end = target;
    while !value.is_char_boundary(end) { end -= 1; }
    value.truncate(end);
    value.push_str(SUFFIX);
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_logs_keep_contract_and_snapshot_is_independent() {
        let mut buffer = Buffer::default();
        let entry = buffer.push(20, "info", "启动器", "已读取 3 个实例，Java 17", &[]).unwrap();
        assert_eq!(entry.message, "[启动器] 已读取 3 个实例，Java 17");
        let mut snapshot = buffer.snapshot();
        snapshot[0].message.clear();
        assert_eq!(buffer.snapshot()[0].message, entry.message);
        buffer.push(10, "warn", "", "缺少可选图标", &[]).unwrap();
        buffer.push(30, "error", "", "下载未完成", &[]).unwrap();
        assert!(buffer.push(40, "debug", "", "拒绝未知级别", &[]).is_err());
        let diagnostic = buffer.diagnostic();
        assert_eq!(diagnostic["stats"], json!({"total":3,"sent":3,"errorCount":1,"warnCount":1}));
        assert_eq!(diagnostic["logs"][0], json!({"ts":20,"level":"info","message":entry.message}));
        assert_eq!(diagnostic["logs"][1]["ts"], 10);
    }

    #[test]
    fn utf8_byte_limits_include_source_and_fold_controls_before_storage() {
        let mut buffer = Buffer::default();
        let entry = buffer.push(0, "info", &"源".repeat(100), &format!("第一行\n第二行\r\t\0\u{001b}\u{0085}\u{202e}{}", "🙂中".repeat(2000)), &[]).unwrap();
        assert!(entry.message.len() <= MAX_MESSAGE_BYTES);
        assert!(entry.message.ends_with("…[截断]"));
        assert!(entry.message.contains("第一行 ⏎ 第二行"));
        assert!(!entry.message.chars().any(char::is_control));
        assert!(!entry.message.contains('\u{202e}'));
        assert!(serde_json::to_vec(&entry).unwrap().len() <= MAX_MESSAGE_BYTES);
        let secret = "首行\n跨行秘密🙂".to_owned();
        let entry = buffer.push(1, "info", "", &secret, &[secret.clone()]).unwrap();
        assert_eq!(entry.message, HIDDEN);
        let entry = buffer.push(2, "info", "", &"\"".repeat(8000), &[]).unwrap();
        assert!(serde_json::to_vec(&entry).unwrap().len() <= MAX_MESSAGE_BYTES);
        assert!(entry.message.ends_with("…[截断]"));
    }

    #[test]
    fn rolling_limits_account_for_serialized_utf8_bytes_and_evict_oldest() {
        let mut buffer = Buffer::default();
        for ts in 0..2100 { buffer.push(ts, "info", "", "正常短消息", &[]).unwrap(); }
        let snapshot = buffer.snapshot();
        assert_eq!(snapshot.len(), MAX_ENTRIES);
        assert_eq!(snapshot[0].ts, 100);
        assert_eq!(snapshot.last().unwrap().ts, 2099);
        // 引号在 JSON 中需要额外转义；仅按 message.len() 记账会突破总预算。
        for ts in 2100..4200 { buffer.push(ts, "info", "", &"\"".repeat(8000), &[]).unwrap(); }
        let snapshot = buffer.snapshot();
        assert!(snapshot.len() < MAX_ENTRIES);
        assert!(serde_json::to_vec(&snapshot).unwrap().len() <= MAX_BUFFER_BYTES);
        assert!(buffer.bytes + 2 <= MAX_BUFFER_BYTES);
        assert_eq!(snapshot.last().unwrap().ts, 4199);
    }

    #[test]
    fn diagnostics_use_latest_suffix_and_bound_the_serialized_array() {
        let mut buffer = Buffer::default();
        for ts in 0..1000 { buffer.push(ts, "info", "", "普通事件", &[]).unwrap(); }
        let diagnostic = buffer.diagnostic();
        let logs = diagnostic["logs"].as_array().unwrap();
        assert_eq!(logs.len(), 800);
        assert_eq!(logs[0]["ts"], 200);
        assert_eq!(logs.last().unwrap()["ts"], 999);
        for ts in 1000..1800 { buffer.push(ts, "warn", "", &"\"".repeat(8000), &[]).unwrap(); }
        let diagnostic = buffer.diagnostic();
        let logs = diagnostic["logs"].as_array().unwrap();
        assert!(logs.len() < 800);
        assert!(serde_json::to_vec(logs).unwrap().len() <= MAX_DIAGNOSTIC_BYTES);
        assert_eq!(logs.last().unwrap()["ts"], 1799);
        assert_eq!(diagnostic["stats"]["sent"].as_u64().unwrap() as usize, logs.len());
    }

    #[test]
    fn known_secrets_urls_authorization_jwt_and_opaque_values_are_hidden() {
        let mut buffer = Buffer::default();
        let known = "FAKE_ONLY_KNOWN_VALUE".to_owned();
        let raw = concat!(
            "已连接 https://user:FAKE_PASSWORD@example.invalid/a?key=FAKE_QUERY ",
            "https:\\/\\/example.invalid/FAKE_ESCAPED_URL www.example.invalid/FAKE_WWW ",
            "Bearer FAKE_BEARER_VALUE Basic RkFLRV9CQVNJQw== ",
            "eyJhbGciOiJub25lIn0.eyJzdWIiOiJGQUtFIn0.RkFLRV9TSUc ",
            "0123456789ABCDEF0123456789ABCDEF ",
            "FAKE_OPAQUE_abcdefghijklmnopqrstuvwxyz_0123456789 ",
            "FAKE_ONLY_KNOWN_VALUE 正常结尾",
        );
        let entry = buffer.push(0, "info", &known, raw, &[known.clone()]).unwrap();
        for forbidden in ["FAKE_PASSWORD", "example.invalid", "FAKE_QUERY", "FAKE_ESCAPED_URL", "FAKE_WWW", "FAKE_BEARER_VALUE", "RkFLRV9CQVNJQw", "eyJhbG", "0123456789ABCDEF", "FAKE_OPAQUE", known.as_str()] {
            assert!(!entry.message.contains(forbidden), "不应残留：{forbidden}");
        }
        assert!(entry.message.contains("正常结尾"));
    }

    #[test]
    fn named_secret_values_cover_json_nested_containers_quotes_and_commands() {
        let mut buffer = Buffer::default();
        let raw = r#"{"accessToken":"FAKE_ACCESS","refresh_token":"FAKE_REFRESH","password":"FAKE_\"QUOTED","accounts":[{"name":"FAKE_NAME","value":"FAKE_NESTED"}],"credentials":{"nested":{"value":"FAKE_CREDENTIAL"}},"ok":"保留"} --clientToken FAKE_COMMAND; debugKey=FAKE_DEBUG; cookie: FAKE_COOKIE=1; api-key='FAKE_API';"#;
        let entry = buffer.push(0, "info", "", raw, &[]).unwrap();
        for forbidden in ["FAKE_ACCESS", "FAKE_REFRESH", "FAKE_", "FAKE_NAME", "FAKE_NESTED", "FAKE_CREDENTIAL", "FAKE_COMMAND", "FAKE_DEBUG", "FAKE_COOKIE", "FAKE_API"] {
            assert!(!entry.message.contains(forbidden), "不应残留：{forbidden}");
        }
        assert!(entry.message.contains("保留"));
        let entry = buffer.push(1, "warn", "", "password=含 空格 秘密\n正常后续", &[]).unwrap();
        assert!(!entry.message.contains("秘密"));
        assert!(entry.message.contains("正常后续"));
        for structured in [
            r#"{"access\u0054oken":"FAKE_UNICODE_KEY","nested":{"client_secret":{"first":"FAKE_CONTAINER","second":"FAKE_SECOND"}}}"#,
            r#"{\"accessToken\":\"FAKE_DOUBLE_ENCODED\",\"tail\":\"FAKE_REMAINDER\"}"#,
            "access\0Token=FAKE_CONTROL; https\u{200b}://example.invalid/FAKE_URL; Bear\u{202e}er FAKE_BIDI",
        ] {
            let entry = buffer.push(2, "warn", "", structured, &[]).unwrap();
            assert!(!entry.message.contains("FAKE_"));
            assert!(!entry.message.contains("example.invalid"));
        }
        for malformed in ["accounts={broken FAKE_UNCLOSED", "password=\"FAKE_UNCLOSED", "credentials=[{\"value\":\"FAKE_VALUE\"}"] {
            let entry = buffer.push(2, "warn", "", malformed, &[]).unwrap();
            assert!(!entry.message.contains("FAKE_"));
        }
    }
}

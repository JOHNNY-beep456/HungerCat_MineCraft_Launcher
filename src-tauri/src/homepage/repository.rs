//! 主页私有仓库：单一调用者串行化，内容与确认按同一次持有句柄读取绑定。
use super::{access::{Directory, OpenedFile}, analyzer, native, Result, MAX_LOCAL_SIZE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{cell::Cell, collections::BTreeMap, fs::File, io::{Read, Seek, SeekFrom, Write}, path::Path, time::{SystemTime, UNIX_EPOCH}};

const STATE_LIMIT: u64 = 1024 * 1024;
const ENTRY_LIMIT: usize = 1024;
fn file_error() -> String { "主页文件操作失败 / 主頁檔案操作失敗 / Homepage file operation failed".into() }
fn changed() -> String { "主页内容已改变，请重新确认 / 主頁內容已變更，請重新確認 / Homepage content changed; confirm it again".into() }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stored {
    #[serde(default)] confirmed_sha: String,
    #[serde(default)] network_sha: String,
    #[serde(default = "unchecked")] verify: String,
    #[serde(default)] verified_sha: String,
    #[serde(default, skip_serializing_if = "Option::is_none")] blocked: Option<Block>,
}
impl Default for Stored {
    fn default() -> Self { Self { confirmed_sha: String::new(), network_sha: String::new(), verify: unchecked(), verified_sha: String::new(), blocked: None } }
}
fn unchecked() -> String { "unchecked".into() }
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Block { at: u64, reason: String }
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct State { state: BTreeMap<String, Stored> }

pub(super) fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.as_bytes()[0].is_ascii_alphanumeric()
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && super::access::leaf(&format!("{id}.html")).is_ok()
}
fn checked_id(id: &str) -> Result<()> {
    if valid_id(id) { Ok(()) } else { Err("主页标识无效 / 主頁標識無效 / Invalid homepage identifier".into()) }
}
pub(super) fn hash(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
pub(super) fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64 }
fn read(mut held: OpenedFile, cap: u64) -> Result<Vec<u8>> {
    held.verify()?;
    let size = held.file.metadata().map_err(|_| file_error())?.len();
    if size > cap { return Err("主页文件超过大小限制 / 主頁檔案超過大小限制 / Homepage file exceeds the size limit".into()); }
    let mut bytes = Vec::new();
    (&mut held.file).take(cap + 1).read_to_end(&mut bytes).map_err(|_| file_error())?;
    held.verify()?;
    if bytes.len() as u64 != size || bytes.len() as u64 > cap { return Err(changed()); }
    Ok(bytes)
}
pub(super) fn read_import(path: &Path) -> Result<Vec<u8>> {
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
    if !ext.eq_ignore_ascii_case("html") && !ext.eq_ignore_ascii_case("htm") { return Err("请选择 HTML 文件 / 請選取 HTML 檔案 / Choose an HTML file".into()); }
    let bytes = read(OpenedFile::open(path)?, MAX_LOCAL_SIZE)?;
    validate_html(&bytes)?;
    Ok(bytes)
}
pub(super) fn validate_html(bytes: &[u8]) -> Result<&str> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_LOCAL_SIZE { return Err(file_error()); }
    let text = std::str::from_utf8(bytes).map_err(|_| "主页必须使用 UTF-8 / 主頁必須使用 UTF-8 / Homepage must use UTF-8".to_owned())?;
    let mut end = text.len().min(4096);
    while !text.is_char_boundary(end) { end -= 1; }
    let head = &text[..end];
    if text.contains('\0') || !(head.contains("@hcpage") || regex::Regex::new("(?i)<[a-z!]").expect("内置表达式").is_match(head)) { return Err("文件不是有效 HTML / 檔案不是有效 HTML / The file is not valid HTML".into()); }
    Ok(text)
}

pub(super) struct Repository { root: Directory, dir: Directory, state: State, unconfirmed: Cell<bool> }
impl Repository {
    pub(super) fn open(root: &Path) -> Result<Self> {
        let root = Directory::open(root)?;
        if root.child("homepages")?.is_none() {
            match native::mkdir(root.handle(), "homepages") { Ok(()) => {}, Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}, Err(_) => return Err(file_error()) }
        }
        let dir = root.directory(root.child("homepages")?.ok_or_else(file_error)?)?;
        let state = if root.child("homepages.json")?.is_some() {
            let bytes = read(root.source("homepages.json")?.open()?, STATE_LIMIT)?;
            let value: State = serde_json::from_slice(&bytes).map_err(|_| "主页授权记录损坏，已拒绝覆盖 / 主頁授權紀錄損壞，已拒絕覆寫 / Homepage approval records are corrupt; refusing to overwrite them".to_owned())?;
            if value.state.len() > ENTRY_LIMIT || value.state.iter().any(|(id, s)| !valid_id(id)
                || [&s.confirmed_sha, &s.network_sha, &s.verified_sha].iter().any(|sha| !sha.is_empty() && (sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit())))
                || !["local", "unchecked", "verified", "mismatch"].contains(&s.verify.as_str())
                || s.blocked.as_ref().is_some_and(|b| b.reason.len() > 1600)) { return Err(file_error()); }
            value
        } else { State::default() };
        Ok(Self { root, dir, state, unconfirmed: Cell::new(false) })
    }
    pub(super) fn cleanup_unconfirmed(&self) -> bool { self.unconfirmed.get() }
    pub(super) fn path(&self) -> &Path { self.dir.path() }
    fn save(&mut self, next: State) -> Result<()> {
        if next.state.len() > ENTRY_LIMIT { return Err(file_error()); }
        let bytes = serde_json::to_vec(&next).map_err(|_| file_error())?;
        if bytes.len() as u64 > STATE_LIMIT { return Err(file_error()); }
        // 已有状态必须仍是普通单硬链接文件；发布相对根句柄，替换只用于固定状态名称。
        if self.root.child("homepages.json")?.is_some() { drop(self.root.source("homepages.json")?.open()?); }
        publish_bytes(&self.root, "homepages.json", &bytes, true, &self.unconfirmed)?;
        self.state = next;
        Ok(())
    }
    pub(super) fn source(&self, id: &str, active: &str) -> Result<Value> {
        checked_id(id)?;
        let source = self.dir.source(&format!("{id}.html"))?;
        let installed = source.modified().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64;
        let bytes = read(source.open()?, MAX_LOCAL_SIZE)?;
        let text = validate_html(&bytes)?;
        let sha = hash(&bytes);
        let state = self.state.state.get(id).cloned().unwrap_or_default();
        let mut risk = analyzer::analyze(text, false);
        // 外部可执行代码尚无不可变依赖快照；读操作不隐式联网，也不把未扫描字节交给脚本。
        if risk["externals"].as_array().is_some_and(|a| a.iter().any(|e| e["code"].as_bool().unwrap_or(false))) {
            risk["level"] = json!("reject");
            risk["blocks"].as_array_mut().ok_or_else(file_error)?.push(json!("外链脚本尚未完成字节固定，暂不执行 / 外連腳本尚未完成位元組固定，暫不執行 / External script bytes are not pinned; execution is unavailable"));
        }
        if let Some(blocked) = &state.blocked {
            risk["level"] = json!("reject");
            risk["blocks"].as_array_mut().ok_or_else(file_error)?.insert(0, json!(blocked.reason));
        }
        let meta = analyzer::parse_meta(text, id);
        let verify = if meta["id"].as_str().unwrap_or("").is_empty() { "local" }
            else if state.verified_sha == sha { &state.verify } else { "unchecked" };
        let mut result = json!({"id":id,"meta":meta,"sha256":sha,"size":bytes.len(),"installedAt":installed,
            "risk":risk,"verify":verify,"confirmed":state.confirmed_sha == sha,"networkApproved":state.network_sha == sha,
            "active":active == id,"content":text});
        if let Some(blocked) = &state.blocked { result["blocked"] = serde_json::to_value(blocked).map_err(|_| file_error())?; }
        Ok(result)
    }
    /// 占用正在运行的主页文件并核对内容哈希。
    ///
    /// 返回的句柄必须由调用方一直持有：Windows 上仓库打开文件时只授予
    /// `FILE_SHARE_READ`，句柄活着期间同目录的写入、改名、删除都会失败，
    /// 这就是「运行时主页文件不能被替换」。Unix 没有等价的强制共享语义，
    /// 句柄只能保证我们读到的是同一份 inode，不阻止其它进程改写。
    pub(super) fn hold(&self, id: &str, expected: &str) -> Result<File> {
        checked_id(id)?;
        let mut held = self.dir.source(&format!("{id}.html"))?.open()?;
        held.verify()?;
        let mut bytes = Vec::new();
        (&mut held.file).take(MAX_LOCAL_SIZE + 1).read_to_end(&mut bytes).map_err(|_| file_error())?;
        held.verify()?;
        if bytes.len() as u64 > MAX_LOCAL_SIZE || hash(&bytes) != expected { return Err(changed()); }
        held.file.seek(SeekFrom::Start(0)).map_err(|_| file_error())?;
        Ok(held.file)
    }
    pub(super) fn list(&self, active: &str) -> Result<Value> {
        let mut budget = ENTRY_LIMIT * 2;
        let names = self.dir.names(&mut budget)?;
        let mut items = Vec::new();
        for name in names {
            let Some(id) = name.strip_suffix(".html").filter(|id| valid_id(id)) else { continue };
            if let Ok(mut value) = self.source(id, active) { value.as_object_mut().expect("已构造对象").remove("content"); items.push(value); }
        }
        items.sort_by_key(|v| std::cmp::Reverse(v["installedAt"].as_u64().unwrap_or(0)));
        Ok(json!(items))
    }
    pub(super) fn import(&mut self, filename: &str, bytes: &[u8], active: &str) -> Result<Value> {
        validate_html(bytes)?;
        let stem = filename.rsplit(['/', '\\']).next().unwrap_or("homepage");
        let stem = stem.rsplit_once('.').map(|(s, _)| s).unwrap_or(stem);
        let base: String = stem.chars().map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '-' }).skip_while(|c| "._-".contains(*c)).take(48).collect();
        let base = if base.is_empty() { format!("homepage-{}", now()) } else { base };
        let mut id = base.clone();
        for i in 1..=ENTRY_LIMIT {
            if !valid_id(&id) { return Err(file_error()); }
            if self.dir.child(&format!("{id}.html"))?.is_none() {
                publish_bytes(&self.dir, &format!("{id}.html"), bytes, false, &self.unconfirmed)?;
                return self.source(&id, active).map(without_content);
            }
            id = format!("{base}-{}", i + 1);
        }
        Err("主页数量超过限制 / 主頁數量超過限制 / Too many homepages".into())
    }
    pub(super) fn confirm(&mut self, id: &str, network: bool, expected: &str, active: &str) -> Result<Value> {
        let source = self.source(id, active)?;
        allow(&source)?;
        if source["sha256"].as_str() != Some(expected) { return Err(changed()); }
        let mut next = self.state.clone();
        let row = next.state.entry(id.to_owned()).or_default();
        row.confirmed_sha = source["sha256"].as_str().ok_or_else(file_error)?.to_owned();
        row.network_sha = if network { row.confirmed_sha.clone() } else { String::new() };
        self.save(next)?;
        self.source(id, active).map(without_content)
    }
    pub(super) fn block(&mut self, id: &str, reason: &str) -> Result<()> {
        checked_id(id)?;
        let mut next = self.state.clone();
        let row = next.state.entry(id.to_owned()).or_default();
        row.blocked.get_or_insert_with(|| Block { at: now(), reason: reason.chars().filter(|c| !c.is_control()).take(300).collect() });
        row.confirmed_sha.clear(); row.network_sha.clear(); self.save(next)
    }
    pub(super) fn remove(&mut self, id: &str) -> Result<()> {
        checked_id(id)?;
        let name = format!("{id}.html");
        let file = native::open(self.dir.handle(), &name, true).map_err(|_| file_error())?;
        let identity = native::identity(&file)?;
        // 删除正文和撤回记录构成一次操作；中途失败不能把部分提交说成已完整收尾。
        let previous = self.unconfirmed.replace(true);
        native::remove_open(self.dir.handle(), &name, file, &identity)?;
        self.dir.verify()?;
        if self.dir.child(&name)?.is_some() { return Err(file_error()); }
        let mut next = self.state.clone(); next.state.remove(id); self.save(next)?;
        self.unconfirmed.set(previous);
        Ok(())
    }
    pub(super) fn replace(&mut self, id: &str, expected: &str, bytes: &[u8], active: &str) -> Result<Value> {
        validate_html(bytes)?;
        let current = self.source(id, active)?;
        if current["sha256"].as_str() != Some(expected) { return Err(changed()); }
        let mut next = self.state.clone();
        let state = next.state.entry(id.to_owned()).or_default();
        state.confirmed_sha.clear(); state.network_sha.clear(); state.verify = unchecked();
        // 先撤回旧确认，发布失败时旧文件仍可重新确认；永久 blocked 保留。
        self.save(next)?;
        publish_bytes(&self.dir, &format!("{id}.html"), bytes, true, &self.unconfirmed)?;
        self.source(id, active).map(without_content)
    }
    pub(super) fn set_verification(&mut self, id: &str, expected: &str, status: &str, active: &str) -> Result<Value> {
        let source = self.source(id, active)?;
        if source["sha256"].as_str() != Some(expected) || !["local", "unchecked", "verified", "mismatch"].contains(&status) { return Err(changed()); }
        let mut next = self.state.clone();
        let row = next.state.entry(id.to_owned()).or_default();
        row.verify = status.into(); row.verified_sha = expected.into(); self.save(next)?;
        self.source(id, active).map(without_content)
    }
}
pub(super) fn without_content(mut value: Value) -> Value { value.as_object_mut().expect("主页对象").remove("content"); value }
pub(super) fn allow(source: &Value) -> Result<()> {
    if source["blocked"].is_object() || source["risk"]["level"] == "reject" {
        Err("主页未通过安全检查，禁止运行 / 主頁未通過安全檢查，禁止執行 / Homepage failed the safety check and cannot run".into())
    } else { Ok(()) }
}

fn publish_bytes(dir: &Directory, target: &str, bytes: &[u8], replace: bool, unconfirmed: &Cell<bool>) -> Result<()> {
    dir.verify()?;
    let name = format!(".homepage-{}.part", uuid::Uuid::new_v4().simple());
    let mut file = native::create(dir.handle(), &name).map_err(|_| file_error())?;
    let previous = unconfirmed.replace(true);
    let id = native::identity(&file)?;
    let result = (|| {
        file.write_all(bytes).map_err(|_| file_error())?;
        file.sync_all().map_err(|_| file_error())?;
        dir.verify()?;
        native::publish(dir.handle(), &file, &name, target, replace, &id)
    })();
    if let Err(error) = result {
        native::remove_open(dir.handle(), &name, file, &id).map_err(|_| "主页暂存收尾未确认，请保留现场 / 主頁暫存收尾未確認，請保留現場 / Homepage staging cleanup is unconfirmed; retain files".to_owned())?;
        unconfirmed.set(previous);
        return Err(error);
    }
    drop(file);
    dir.verify().map_err(|_| "主页已发布，但目录后验未确认，请保留现场且勿重试 / 主頁已發佈，但目錄後驗未確認，請保留現場且勿重試 / Homepage was published but directory verification is unconfirmed; retain files and do not retry".to_owned())?;
    unconfirmed.set(previous);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(std::path::PathBuf);
    impl Fixture { fn new() -> Self { let p = std::env::temp_dir().join(format!("hcmcl-homepage-{}", uuid::Uuid::new_v4())); std::fs::create_dir(&p).unwrap(); Self(std::fs::canonicalize(p).unwrap()) } fn repo(&self) -> Repository { Repository::open(&self.0).unwrap() } }
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    #[test] fn confirmation_uses_current_bytes_and_permanent_block_survives_edits() {
        let f = Fixture::new(); let mut r = f.repo(); let e = r.import("sample.html", b"<!doctype html><title>sample</title><p>Hello</p>", "").unwrap(); let id = e["id"].as_str().unwrap();
        let old = r.source(id, "").unwrap()["sha256"].as_str().unwrap().to_owned();
        assert!(r.confirm(id, false, &"0".repeat(64), "").is_err());
        assert_eq!(r.confirm(id, false, &old, "").unwrap()["confirmed"], true);
        r.replace(id, &old, b"<html><p>changed</p></html>", "").unwrap(); assert_eq!(r.source(id, "").unwrap()["confirmed"], false);
        r.block(id, "fixture").unwrap(); let new = r.source(id, "").unwrap()["sha256"].as_str().unwrap().to_owned(); r.replace(id, &new, b"<html><p>edited</p></html>", "").unwrap();
        assert!(r.confirm(id, true, &new, "").is_err()); drop(r); assert!(f.repo().source(id, "").unwrap()["blocked"].is_object());
    }
    /// 运行期占用只接受「当前字节」的哈希；占用期间 Windows 上不能再写入。
    #[test] fn hold_pins_current_bytes_and_denies_rewrites_while_open() {
        let f = Fixture::new(); let mut r = f.repo();
        let e = r.import("pinned.html", b"<!doctype html><title>pinned</title><p>body</p>", "").unwrap();
        let id = e["id"].as_str().unwrap().to_owned();
        let sha = r.source(&id, "").unwrap()["sha256"].as_str().unwrap().to_owned();
        // 旧哈希（内容已变）必须被拒绝：否则占用下来的就是未经核对的文件。
        assert!(r.hold(&id, &"0".repeat(64)).is_err());
        let file = r.hold(&id, &sha).unwrap();
        #[cfg(windows)]
        {
            let path = f.0.join("homepages").join(format!("{id}.html"));
            assert!(std::fs::OpenOptions::new().write(true).open(&path).is_err());
            assert!(std::fs::rename(&path, f.0.join("homepages").join("moved.html")).is_err());
        }
        drop(file);
        assert!(r.hold(&id, &sha).is_ok());
    }
    #[test] fn traversal_corrupt_state_oversize_and_remote_code_are_not_silently_approved() {
        assert!(!valid_id("../x")); assert!(!valid_id("CON")); let f = Fixture::new(); let mut r = f.repo();
        assert!(r.import("x", &[b'a'; 32], "").is_err());
        let e = r.import("remote.html", b"<html><script src='https://example.com/main.js'></script></html>", "").unwrap(); assert_eq!(e["risk"]["level"], "reject");
        std::fs::write(f.0.join("homepages.json"), b"broken").unwrap(); assert!(Repository::open(&f.0).is_err());
    }
}

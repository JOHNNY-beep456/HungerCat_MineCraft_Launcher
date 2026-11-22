//! 实例服务器列表编辑：保留原 NBT 标签字节；真实 owned worker 持有根锁和生命周期登记。
//! 根锁约束协作写入；最终路径复验不是对同权限外部进程的目标 inode CAS。
use serde_json::{json, Value};
use std::{fs::{self, File, OpenOptions}, io::{self, Read, Write}, path::{Path, PathBuf}, sync::Arc};
use tauri::{AppHandle, Manager};
use crate::{downloads::Cancel, lifecycle, storage::Storage};
type Result<T> = std::result::Result<T, String>;
#[path = "modpack/access.rs"]
mod access;
use access::{Directory, DirectoryMark};

const FILE: &str = "servers.dat";
pub(crate) const RAW_CAP: usize = 8 * 1024 * 1024;
const NBT_CAP: usize = 16 * 1024 * 1024;
const NODE_CAP: usize = 100_000;
const SERVER_CAP: usize = 10_000;
const ARGS: &str = "servers:args";
const PATH: &str = "servers:path";
const LIMIT: &str = "servers:limit";
const NBT: &str = "servers:nbt";
const GZIP: &str = "servers:gzip";
const CHANGED: &str = "servers:changed";
const IO: &str = "servers:io";
const CANCELLED: &str = "servers:cancel";
const UNKNOWN: &str = "servers:unknown";
const PLATFORM: &str = "servers:platform";
const POSTCOMMIT: &str = "servers:postcommit";
fn error(code: &str) -> String { code.into() }
fn check(cancel: &Cancel) -> Result<()> { cancel.check().map_err(|_| error(CANCELLED)) }
fn fallback(code: &str) -> String { format!("{} / {} / {}", localized("zh-CN", code), localized("zh-TW", code), localized("en", code)) }
fn localized(language: &str, code: &str) -> String {
    let (cn, tw, en) = match code {
        ARGS => ("实例、服务器名称或地址参数无效", "實例、伺服器名稱或位址參數無效", "Invalid instance, server name or address"),
        LIMIT => ("服务器列表超过大小、深度或条目上限，未写入", "伺服器清單超過大小、深度或項目上限，未寫入", "Server list exceeds size, depth or entry limits; no changes written"),
        NBT => ("已有服务器列表的 NBT 无效或结构含歧义，原文件已保留", "現有伺服器清單的 NBT 無效或結構有歧義，原檔案已保留", "Existing server-list NBT is invalid or ambiguous; original file preserved"),
        GZIP => ("服务器列表 gzip 无效，原文件已保留", "伺服器清單 gzip 無效，原檔案已保留", "Invalid server-list gzip; original file preserved"),
        CHANGED => ("服务器列表、隔离标记或目录已改变，未覆盖，请重试", "伺服器清單、隔離標記或目錄已變更，未覆寫，請重試", "Server list, isolation marker or directory changed; not overwritten; retry"),
        CANCELLED => ("服务器列表操作已取消，未发布更新", "伺服器清單操作已取消，未發佈更新", "Server-list operation cancelled; update not published"),
        UNKNOWN => ("服务器列表收尾未确认，目录保持忙碌，请检查暂存文件", "伺服器清單收尾未確認，目錄保持忙碌，請檢查暫存檔案", "Server-list cleanup unconfirmed; directory remains busy; inspect staging files"),
        PLATFORM => ("当前平台不支持安全的服务器列表原子发布，未写入", "目前平台不支援安全的伺服器清單原子發佈，未寫入", "This platform cannot safely publish the server list atomically; no update written"),
        POSTCOMMIT => ("服务器列表已更新，但目录同步失败；未撤销已发布内容", "伺服器清單已更新，但目錄同步失敗；未撤銷已發佈內容", "Server list updated, but directory synchronization failed; published update was not reverted"),
        IO => ("服务器列表文件操作失败，未完成发布", "伺服器清單檔案操作失敗，未完成發佈", "Server-list file operation failed; publication did not complete"),
        _ => ("实例目录不可用或包含链接、硬链接、别名或特殊文件，未写入", "實例目錄無法使用或含連結、硬連結、別名或特殊檔案，未寫入", "Instance path is unavailable or contains links, hardlinks, aliases or special files; no update written"),
    };
    if language.starts_with("en") { en } else if language == "zh-TW" || language.starts_with("zh-HK") || language.starts_with("zh_TW") { tw } else { cn }.into()
}
#[derive(Clone)]
struct Request { id: String, name: String, address: String }
impl Request {
    fn parse(args: &[Value]) -> Result<Self> {
        if args.len() != 3 { return Err(error(ARGS)); }
        let text = |index: usize, cap: usize| -> Result<String> {
            let value = args[index].as_str().ok_or_else(|| error(ARGS))?;
            if value.len() > cap || value.chars().any(char::is_control) { return Err(error(ARGS)); }
            Ok(value.trim().to_owned())
        };
        let id = text(0, 240)?;
        access::leaf(&id).map_err(|_| error(ARGS))?;
        let address = text(2, 4096)?;
        if address.is_empty() { return Err(error(ARGS)); }
        let name = text(1, 4096)?;
        let name = if name.is_empty() { address.clone() } else { name };
        Ok(Self { id, name, address })
    }
}

// Java NBT 使用 modified UTF-8；保留旧字节，并正确处理 NUL、补充平面和未配对 UTF-16。
fn decode_string(bytes: &[u8]) -> Result<String> {
    // 兼容旧启动器直接写入的标准 UTF-8；新字符串使用 Java modified UTF-8。
    if let Ok(value) = std::str::from_utf8(bytes) { return Ok(value.to_owned()); }
    let mut units = Vec::new(); let mut i = 0;
    while i < bytes.len() {
        let first = bytes[i]; i += 1;
        let unit = if (1..=0x7f).contains(&first) { first as u16 }
        else if first & 0xe0 == 0xc0 {
            let next = *bytes.get(i).ok_or_else(|| error(NBT))?; i += 1;
            if next & 0xc0 != 0x80 { return Err(error(NBT)); }
            let value = ((first as u16 & 31) << 6) | (next as u16 & 63);
            if value < 0x80 && !(first == 0xc0 && next == 0x80) { return Err(error(NBT)); } value
        } else if first & 0xf0 == 0xe0 {
            let second = *bytes.get(i).ok_or_else(|| error(NBT))?;
            let third = *bytes.get(i + 1).ok_or_else(|| error(NBT))?; i += 2;
            if second & 0xc0 != 0x80 || third & 0xc0 != 0x80 { return Err(error(NBT)); }
            let value = ((first as u16 & 15) << 12) | ((second as u16 & 63) << 6) | (third as u16 & 63);
            if value < 0x800 { return Err(error(NBT)); } value
        } else { return Err(error(NBT)); };
        units.push(unit);
    }
    // 无配对代理项仍保持原 NBT 字节；UI 投影用替代字符，不重写该字符串。
    Ok(String::from_utf16_lossy(&units))
}
fn string_bytes(value: &str) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    for unit in value.encode_utf16() {
        if (1..=0x7f).contains(&unit) { out.push(unit as u8); }
        else if unit <= 0x7ff { out.extend_from_slice(&[0xc0 | (unit >> 6) as u8, 0x80 | (unit & 63) as u8]); }
        else { out.extend_from_slice(&[0xe0 | (unit >> 12) as u8, 0x80 | ((unit >> 6) & 63) as u8, 0x80 | (unit & 63) as u8]); }
    }
    let n = u16::try_from(out.len()).map_err(|_| error(LIMIT))?;
    let mut result = n.to_be_bytes().to_vec(); result.extend(out); Ok(result)
}
struct Reader<'a> { data: &'a [u8], pos: usize, nodes: usize }
impl<'a> Reader<'a> {
    fn take(&mut self, size: usize) -> Result<&'a [u8]> {
        let end = self.pos.checked_add(size).filter(|end| *end <= self.data.len()).ok_or_else(|| error(NBT))?;
        let value = &self.data[self.pos..end]; self.pos = end; Ok(value)
    }
    fn byte(&mut self) -> Result<u8> { Ok(self.take(1)?[0]) }
    fn length(&mut self) -> Result<usize> {
        let count = i32::from_be_bytes(self.take(4)?.try_into().map_err(|_| error(NBT))?);
        if count < 0 || count as usize > NODE_CAP { return Err(error(LIMIT)); } Ok(count as usize)
    }
    fn string(&mut self) -> Result<String> {
        let length = u16::from_be_bytes(self.take(2)?.try_into().map_err(|_| error(NBT))?) as usize;
        decode_string(self.take(length)?)
    }
    fn value(&mut self, kind: u8, depth: usize) -> Result<()> {
        self.nodes += 1;
        if depth > 32 || self.nodes > NODE_CAP { return Err(error(LIMIT)); }
        match kind {
            1 => { self.take(1)?; }, 2 => { self.take(2)?; }, 3 | 5 => { self.take(4)?; }, 4 | 6 => { self.take(8)?; },
            7 | 11 | 12 => { let count = self.length()?; self.take(count.checked_mul(match kind { 11 => 4, 12 => 8, _ => 1 }).ok_or_else(|| error(LIMIT))?)?; },
            8 => { self.string()?; },
            9 => { let child = self.byte()?; let count = self.length()?; if child > 12 || (child == 0 && count != 0) { return Err(error(NBT)); } for _ in 0..count { self.value(child, depth + 1)?; } },
            10 => { loop { let child = self.byte()?; if child == 0 { break; } self.string()?; self.value(child, depth + 1)?; } },
            _ => return Err(error(NBT)),
        } Ok(())
    }
    fn server(&mut self) -> Result<Option<Value>> {
        self.nodes += 1; if self.nodes > NODE_CAP { return Err(error(LIMIT)); }
        let mut name = None; let mut address = None;
        loop {
            let kind = self.byte()?; if kind == 0 { break; }
            let key = self.string()?;
            if key == "name" || key == "ip" {
                self.nodes += 1; if self.nodes > NODE_CAP { return Err(error(LIMIT)); }
                if kind != 8 { return Err(error(NBT)); }
                let value = self.string()?;
                let slot = if key == "name" { &mut name } else { &mut address };
                if slot.replace(value).is_some() { return Err(error(NBT)); }
            } else { self.value(kind, 2)?; }
        }
        Ok(address.filter(|v| !v.is_empty()).map(|address| json!({"name": name.unwrap_or_default(), "address": address})))
    }
}
struct Parsed { count_pos: Option<usize>, type_pos: Option<usize>, insert: usize, count: usize, items: Vec<Value> }
fn parse(data: &[u8]) -> Result<Parsed> {
    if data.len() > NBT_CAP { return Err(error(LIMIT)); }
    let mut reader = Reader { data, pos: 0, nodes: 0 };
    if reader.byte()? != 10 { return Err(error(NBT)); } reader.string()?;
    let mut result = None;
    loop {
        let start = reader.pos; let kind = reader.byte()?;
        if kind == 0 {
            if reader.pos != data.len() { return Err(error(NBT)); }
            return Ok(result.unwrap_or(Parsed { count_pos: None, type_pos: None, insert: start, count: 0, items: Vec::new() }));
        }
        let name = reader.string()?;
        if name == "servers" {
            if result.is_some() || kind != 9 { return Err(error(NBT)); }
            let type_pos = reader.pos; let child = reader.byte()?;
            let count_pos = reader.pos; let count = reader.length()?;
            if count > SERVER_CAP { return Err(error(LIMIT)); }
            if child != 10 && !(child == 0 && count == 0) { return Err(error(NBT)); }
            let mut items = Vec::new();
            for _ in 0..count { if let Some(item) = reader.server()? { items.push(item); } }
            result = Some(Parsed { count_pos: Some(count_pos), type_pos: Some(type_pos), insert: reader.pos, count, items });
        } else { reader.value(kind, 1)?; }
    }
}
fn unpack(raw: &[u8]) -> Result<Vec<u8>> {
    if raw.len() > RAW_CAP { return Err(error(LIMIT)); }
    if !raw.starts_with(&[0x1f, 0x8b]) { return Ok(raw.to_vec()); }
    let cursor = io::Cursor::new(raw);
    let mut decoder = flate2::bufread::GzDecoder::new(cursor);
    let mut data = Vec::new();
    Read::by_ref(&mut decoder).take(NBT_CAP as u64 + 1).read_to_end(&mut data).map_err(|_| error(GZIP))?;
    if data.len() > NBT_CAP { return Err(error(LIMIT)); }
    if decoder.get_ref().position() != raw.len() as u64 { return Err(error(GZIP)); }
    Ok(data)
}

/// 与追加操作共用解包和校验，只返回服务器列表投影，不触碰文件。
pub(crate) fn decode_server_list(raw: &[u8]) -> Result<Vec<Value>> {
    let data = unpack(raw)?;
    Ok(parse(&data)?.items)
}

fn append(raw: Option<&[u8]>, request: &Request) -> Result<(Vec<u8>, Value)> {
    let data = match raw { Some(raw) => unpack(raw)?, None => vec![10, 0, 0, 0] };
    let parsed = parse(&data)?;
    if parsed.count >= SERVER_CAP { return Err(error(LIMIT)); }
    let mut entry = vec![8]; entry.extend(string_bytes("name")?); entry.extend(string_bytes(&request.name)?);
    entry.push(8); entry.extend(string_bytes("ip")?); entry.extend(string_bytes(&request.address)?); entry.push(0);
    let mut output = data[..parsed.insert].to_vec();
    if let Some(position) = parsed.count_pos {
        output[position..position + 4].copy_from_slice(&((parsed.count + 1) as i32).to_be_bytes());
        output[parsed.type_pos.ok_or_else(|| error(NBT))?] = 10;
    } else { output.push(9); output.extend(string_bytes("servers")?); output.push(10); output.extend(1i32.to_be_bytes()); }
    output.extend(entry); output.extend_from_slice(&data[parsed.insert..]);
    if output.len() > NBT_CAP { return Err(error(LIMIT)); }
    // 新增标签也受同一读取预算约束，不发布本模块自身无法再次读取的结果。
    parse(&output)?;
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gzip.write_all(&output).map_err(|_| error(IO))?;
    let compressed = gzip.finish().map_err(|_| error(IO))?;
    if compressed.len() > RAW_CAP { return Err(error(LIMIT)); }
    let mut items = parsed.items; items.push(json!({"name": request.name, "address": request.address}));
    Ok((compressed, Value::Array(items)))
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Identity(u64, u64);
#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp { identity: Identity, length: u64, modified: std::time::SystemTime, change: (i64, i64) }
#[cfg(unix)]
fn stamp(file: &File, linked_after_publish: bool) -> Result<Stamp> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata().map_err(|_| error(IO))?;
    let links = if linked_after_publish { 2 } else { 1 };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.nlink() == 0 || meta.nlink() > links { return Err(error(PATH)); }
    Ok(Stamp { identity: Identity(meta.dev(), meta.ino()), length: meta.len(), modified: meta.modified().map_err(|_| error(IO))?, change: (meta.ctime(), meta.ctime_nsec()) })
}
#[cfg(windows)]
fn stamp(file: &File, _: bool) -> Result<Stamp> {
    use std::{ffi::c_void, os::windows::io::AsRawHandle};
    #[repr(C)] struct Info { attributes: u32, created: [u32; 2], accessed: [u32; 2], modified: [u32; 2], volume: u32, high: u32, low: u32, links: u32, index_high: u32, index_low: u32 }
    #[repr(C)] struct Basic { creation: i64, access: i64, write: i64, change: i64, attributes: u32 }
    #[link(name = "kernel32")] extern "system" {
        fn GetFileInformationByHandle(file: *mut c_void, info: *mut Info) -> i32;
        fn GetFileInformationByHandleEx(file: *mut c_void, class: i32, info: *mut c_void, size: u32) -> i32;
    }
    let meta = file.metadata().map_err(|_| error(IO))?;
    let mut info: Info = unsafe { std::mem::zeroed() };
    let mut basic: Basic = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0
        || unsafe { GetFileInformationByHandleEx(file.as_raw_handle(), 0, (&mut basic as *mut Basic).cast(), std::mem::size_of::<Basic>() as u32) } == 0 { return Err(error(IO)); }
    if !meta.is_file() || info.attributes & 0x400 != 0 || info.links != 1 { return Err(error(PATH)); }
    Ok(Stamp { identity: Identity(info.volume as u64, (info.index_high as u64) << 32 | info.index_low as u64), length: meta.len(), modified: meta.modified().map_err(|_| error(IO))?, change: (basic.change, 0) })
}
#[cfg(not(any(unix, windows)))]
fn stamp(_: &File, _: bool) -> Result<Stamp> { Err(error(PLATFORM)) }

struct Existing { file: File, stamp: Stamp }
fn verify_name(directory: &Directory) -> Result<()> {
    let mut budget = NODE_CAP;
    if directory.names(&mut budget).map_err(|_| error(PATH))?.iter().any(|name| name.to_lowercase() == FILE && name != FILE) { return Err(error(PATH)); }
    Ok(())
}
fn read_existing(directory: &Directory, cancel: &Cancel) -> Result<(Option<Existing>, Option<Vec<u8>>)> {
    directory.verify().map_err(|_| error(CHANGED))?;
    verify_name(directory)?;
    let Some(mut file) = native::locked_existing(directory, FILE)? else { return Ok((None, None)); };
    let initial = stamp(&file, false)?;
    if initial.length > RAW_CAP as u64 { return Err(error(LIMIT)); }
    let mut raw = Vec::new(); let mut chunk = [0; 65536];
    loop {
        check(cancel)?;
        let count = file.read(&mut chunk).map_err(|_| error(IO))?;
        if count == 0 { break; }
        if raw.len() + count > RAW_CAP { return Err(error(LIMIT)); } raw.extend_from_slice(&chunk[..count]);
    }
    let result = Existing { file, stamp: initial };
    verify_existing(directory, Some(&result))?;
    if raw.len() as u64 != result.stamp.length { return Err(error(CHANGED)); }
    Ok((Some(result), Some(raw)))
}
fn verify_existing(directory: &Directory, expected: Option<&Existing>) -> Result<()> {
    directory.verify().map_err(|_| error(CHANGED))?;
    verify_name(directory)?;
    let current = native::existing(directory, FILE)?;
    match (expected, current) {
        (None, None) => Ok(()),
        (Some(expected), Some(current)) if stamp(&expected.file, false)? == expected.stamp && stamp(&current, false)? == expected.stamp => Ok(()),
        _ => Err(error(CHANGED)),
    }
}
struct Temp { directory: Directory, name: String, file: Option<File>, identity: Identity, moved: bool, published: bool }
impl Temp {
    fn create(directory: &Directory) -> Result<Self> {
        directory.verify().map_err(|_| error(CHANGED))?;
        let name = format!(".hcmcl-servers-{}.tmp", uuid::Uuid::new_v4());
        let file = native::create(directory, &name)?;
        let identity = match stamp(&file, false) { Ok(stamp) => stamp.identity, Err(_) => { std::mem::forget(file); return Err(error(UNKNOWN)); } };
        Ok(Self { directory: directory.clone(), name, file: Some(file), identity, moved: false, published: false })
    }
    fn verify(&self) -> Result<()> {
        self.directory.verify().map_err(|_| error(CHANGED))?;
        let held = self.file.as_ref().ok_or_else(|| error(UNKNOWN))?;
        if stamp(held, self.published)?.identity != self.identity { return Err(error(CHANGED)); }
        let current = native::existing(&self.directory, &self.name)?.ok_or_else(|| error(CHANGED))?;
        if stamp(&current, self.published)?.identity != self.identity { return Err(error(CHANGED)); }
        Ok(())
    }
    fn cleanup(&mut self) -> Result<()> {
        if self.moved { self.file.take(); return Ok(()); }
        self.verify()?;
        native::unlink(&self.directory, &self.name, self.file.as_ref().ok_or_else(|| error(UNKNOWN))?)?;
        self.file.take();
        self.moved = true;
        Ok(())
    }
}
fn write_chunks(writer: &mut impl Write, bytes: &[u8], cancel: &Cancel) -> Result<()> {
    for chunk in bytes.chunks(65536) { check(cancel)?; writer.write_all(chunk).map_err(|_| error(IO))?; }
    writer.flush().map_err(|_| error(IO))
}
fn perform(root: &Directory, request: &Request, settings: &Value, cancel: &Cancel, temp: &mut Option<Temp>, write: impl FnOnce(&mut File, &[u8], &Cancel) -> Result<()>) -> Result<Value> {
    check(cancel)?; root.verify().map_err(|_| error(CHANGED))?;
    let isolation = crate::modpack::instance_isolation(root.path(), &request.id, settings).map_err(|_| error(PATH))?;
    let versions = root.directory(root.child("versions").map_err(|_| error(PATH))?.ok_or_else(|| error(PATH))?).map_err(|_| error(PATH))?;
    let version = versions.directory(versions.child(&request.id).map_err(|_| error(PATH))?.ok_or_else(|| error(PATH))?).map_err(|_| error(PATH))?;
    let profile = version.source(&format!("{}.json", request.id)).map_err(|_| error(PATH))?;
    if profile.len() > 4 * 1024 * 1024 { return Err(error(LIMIT)); }
    let directory = if isolation.isolated { version } else { root.clone() };
    let (existing, raw) = read_existing(&directory, cancel)?;
    let (bytes, items) = append(raw.as_deref(), request)?; check(cancel)?;
    *temp = Some(Temp::create(&directory)?);
    let staging = temp.as_mut().ok_or_else(|| error(UNKNOWN))?;
    let writer = staging.file.as_mut().ok_or_else(|| error(UNKNOWN))?;
    write(writer, &bytes, cancel)?;
    writer.sync_all().map_err(|_| error(IO))?;
    staging.verify()?;
    let written = stamp(staging.file.as_ref().ok_or_else(|| error(UNKNOWN))?, false)?;
    if written.length != bytes.len() as u64 { return Err(error(CHANGED)); }
    isolation.verify().map_err(|_| error(CHANGED))?; profile.verify().map_err(|_| error(CHANGED))?;
    verify_existing(&directory, existing.as_ref())?; check(cancel)?;
    staging.moved = native::publish(staging, existing.is_some())?;
    staging.published = true;
    // 发布完成后取消不回滚；目录同步失败也不能谎称原文件未改变。
    native::sync(&directory).map_err(|_| error(POSTCOMMIT))?;
    Ok(items)
}
fn worker(root: Directory, request: Request, settings: Value, cancel: Arc<Cancel>) -> (Result<Value>, bool) {
    worker_with(root, request, settings, cancel, write_chunks)
}
fn worker_with(root: Directory, request: Request, settings: Value, cancel: Arc<Cancel>, write: impl FnOnce(&mut File, &[u8], &Cancel) -> Result<()>) -> (Result<Value>, bool) {
    let mut temp = None;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| perform(&root, &request, &settings, &cancel, &mut temp, write))).unwrap_or_else(|_| Err(error(UNKNOWN)));
    let cleanup = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| temp.as_mut().map(Temp::cleanup).unwrap_or(Ok(())))).unwrap_or_else(|_| Err(error(UNKNOWN)));
    let unknown = cleanup.is_err() || result.as_ref().err().is_some_and(|value| value == UNKNOWN);
    if unknown { std::mem::forget(temp); (Err(error(UNKNOWN)), true) } else { (result, false) }
}
struct Waiting(Arc<Cancel>);
impl Drop for Waiting { fn drop(&mut self) { self.0.stop(); } }
async fn owned(app: AppHandle, root: PathBuf, request: Request, cancel: Arc<Cancel>, registration: lifecycle::Request, expected: DirectoryMark) -> Result<Value> {
    let guard = match crate::install_lock::acquire(&root, || cancel.check().is_err()).await { Ok(guard) => guard, Err(_) => { let code = if cancel.check().is_err() { CANCELLED } else { PATH }; registration.finish(); return Err(error(code)); } };
    let work = tokio::task::spawn_blocking(move || {
        let directory = match expected.open() { Ok(directory) => directory, Err(_) => return (Err(error(CHANGED)), false) };
        // 等待根锁期间可能修改隔离设置；在锁内读取当前值，且不把 Storage 暴露给文件写入器。
        let settings = match app.try_state::<Storage>().ok_or_else(|| error(IO)).and_then(|storage| storage.settings_for_backend().map_err(|_| error(IO))) {
            Ok(settings) => settings, Err(code) => return (Err(code), false),
        };
        worker(directory, request, settings, cancel)
    });
    retain(work, registration, guard).await
}
async fn retain(work: tokio::task::JoinHandle<(Result<Value>, bool)>, registration: lifecycle::Request, guard: crate::install_lock::RootOperationGuard) -> Result<Value> {
    let (result, unknown) = work.await.unwrap_or_else(|_| (Err(error(UNKNOWN)), true));
    if unknown { std::mem::forget((registration, guard)); } else { drop(guard); registration.finish(); }
    result
}
pub(crate) async fn call(app: &AppHandle, channel: &str, args: &[Value], game_dir: &Path) -> Result<Option<Value>> {
    if channel != "installed:addServer" { return Ok(None); }
    let registration = app.try_state::<lifecycle::Gate>().ok_or_else(|| fallback(IO))?.enter()?;
    let request = match Request::parse(args) { Ok(request) => request, Err(code) => { registration.finish(); return Err(fallback(&code)); } };
    let root = game_dir.to_path_buf(); let app = app.clone(); let cancel = Arc::new(Cancel::default());
    let waiting = Waiting(cancel.clone());
    let work = tokio::spawn(async move {
        let prepare_app = app.clone();
        let prepare = tokio::task::spawn_blocking(move || {
            let settings = prepare_app.try_state::<Storage>().ok_or_else(|| error(IO))?.settings_for_backend().map_err(|_| error(IO))?;
            let directory = Directory::open(&root).map_err(|_| error(PATH))?;
            Ok::<_, String>((settings, directory))
        }).await;
        let (settings, anchor) = match prepare { Ok(Ok(prepared)) => prepared, Ok(Err(code)) => { registration.finish(); return Err(fallback(&code)); }, Err(_) => { std::mem::forget(registration); return Err(fallback(UNKNOWN)); } };
        let language = settings.get("language").and_then(Value::as_str).unwrap_or("zh-CN").to_owned();
        let result = owned(app, anchor.path().to_path_buf(), request, cancel, registration, anchor.mark()).await;
        drop(anchor);
        result.map_err(|code| localized(&language, &code))
    });
    let result = work.await.map_err(|_| fallback(UNKNOWN))?;
    drop(waiting); result.map(Some)
}

#[cfg(unix)]
mod native {
    use super::*;
    use std::{ffi::CString, os::fd::{AsRawFd, FromRawFd}};
    #[cfg(any(target_os = "macos", target_os = "ios"))] const NOFOLLOW: i32 = 0x100;
    #[cfg(all(target_os = "android", any(target_arch = "arm", target_arch = "aarch64")))] const NOFOLLOW: i32 = 0x8000;
    #[cfg(not(any(target_os = "macos", target_os = "ios", all(target_os = "android", any(target_arch = "arm", target_arch = "aarch64")))))] const NOFOLLOW: i32 = 0x20000;
    #[cfg(any(target_os = "macos", target_os = "ios"))] const CLOEXEC: i32 = 0x1000000;
    #[cfg(not(any(target_os = "macos", target_os = "ios")))] const CLOEXEC: i32 = 0x80000;
    #[cfg(any(target_os = "macos", target_os = "ios"))] const NONBLOCK: i32 = 0x4;
    #[cfg(not(any(target_os = "macos", target_os = "ios")))] const NONBLOCK: i32 = 0x800;
    #[cfg(any(target_os = "macos", target_os = "ios"))] const CREATE_EXCL: i32 = 0x200 | 0x800;
    #[cfg(not(any(target_os = "macos", target_os = "ios")))] const CREATE_EXCL: i32 = 0x40 | 0x80;
    extern "C" {
        fn openat(dir: i32, name: *const std::os::raw::c_char, flags: i32, ...) -> i32;
        fn unlinkat(dir: i32, name: *const std::os::raw::c_char, flags: i32) -> i32;
        fn renameat(from: i32, old: *const std::os::raw::c_char, to: i32, new: *const std::os::raw::c_char) -> i32;
    }
    fn name(value: &str) -> Result<CString> { access::leaf(value).map_err(|_| error(PATH))?; CString::new(value).map_err(|_| error(PATH)) }
    pub(super) fn existing(directory: &Directory, leaf: &str) -> Result<Option<File>> {
        let name = name(leaf)?;
        let fd = unsafe { openat(directory.handle().as_raw_fd(), name.as_ptr(), NOFOLLOW | CLOEXEC | NONBLOCK) };
        if fd >= 0 { return Ok(Some(unsafe { File::from_raw_fd(fd) })); }
        if io::Error::last_os_error().kind() == io::ErrorKind::NotFound { Ok(None) } else { Err(error(PATH)) }
    }
    pub(super) fn locked_existing(directory: &Directory, leaf: &str) -> Result<Option<File>> { existing(directory, leaf) }
    pub(super) fn create(directory: &Directory, leaf: &str) -> Result<File> {
        let name = name(leaf)?;
        let fd = unsafe { openat(directory.handle().as_raw_fd(), name.as_ptr(), 2 | CREATE_EXCL | NOFOLLOW | CLOEXEC, 0o600 as std::os::raw::c_uint) };
        if fd < 0 { Err(error(IO)) } else { Ok(unsafe { File::from_raw_fd(fd) }) }
    }
    pub(super) fn unlink(directory: &Directory, leaf: &str, _: &File) -> Result<()> {
        if unsafe { unlinkat(directory.handle().as_raw_fd(), name(leaf)?.as_ptr(), 0) } == 0 { Ok(()) } else { Err(error(IO)) }
    }
    pub(super) fn publish(temp: &Temp, replace: bool) -> Result<bool> {
        let dir = temp.directory.handle().as_raw_fd(); let old = name(&temp.name)?; let new = name(FILE)?;
        if replace {
            if unsafe { renameat(dir, old.as_ptr(), dir, new.as_ptr()) } == 0 { return Ok(true); }
            return Err(error(IO));
        }
        #[cfg(any(target_os = "linux", target_os = "android"))]
        {
            extern "C" { fn linkat(from: i32, old: *const std::os::raw::c_char, to: i32, new: *const std::os::raw::c_char, flags: i32) -> i32; }
            let fd = temp.file.as_ref().ok_or_else(|| error(UNKNOWN))?.as_raw_fd();
            let source = CString::new(format!("/proc/self/fd/{fd}")).map_err(|_| error(PATH))?;
            if unsafe { linkat(-100, source.as_ptr(), dir, new.as_ptr(), 0x400) } == 0 { return Ok(false); }
            let code = io::Error::last_os_error();
            Err(error(if code.kind() == io::ErrorKind::AlreadyExists { CHANGED } else { PLATFORM }))
        }
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        {
            extern "C" { fn renameatx_np(from: i32, old: *const std::os::raw::c_char, to: i32, new: *const std::os::raw::c_char, flags: u32) -> i32; }
            if unsafe { renameatx_np(dir, old.as_ptr(), dir, new.as_ptr(), 4) } == 0 { Ok(true) }
            else { let code = io::Error::last_os_error(); Err(error(if code.kind() == io::ErrorKind::AlreadyExists { CHANGED } else { PLATFORM })) }
        }
        #[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos", target_os = "ios")))]
        { Err(error(PLATFORM)) }
    }
    pub(super) fn sync(directory: &Directory) -> Result<()> { directory.handle().sync_all().map_err(|_| error(IO)) }
}
#[cfg(windows)]
mod native {
    use super::*;
    use std::{ffi::c_void, os::windows::{fs::OpenOptionsExt, io::AsRawHandle}};
    fn open(directory: &Directory, leaf: &str, share: u32) -> Result<Option<File>> {
        access::leaf(leaf).map_err(|_| error(PATH))?;
        match OpenOptions::new().read(true).share_mode(share).custom_flags(0x00200000 | 0x02000000).open(directory.path().join(leaf)) {
            Ok(file) => Ok(Some(file)), Err(code) if code.kind() == io::ErrorKind::NotFound => Ok(None), Err(_) => Err(error(PATH)),
        }
    }
    pub(super) fn existing(directory: &Directory, leaf: &str) -> Result<Option<File>> { open(directory, leaf, 7) }
    pub(super) fn locked_existing(directory: &Directory, leaf: &str) -> Result<Option<File>> { open(directory, leaf, 5) }
    pub(super) fn create(directory: &Directory, leaf: &str) -> Result<File> {
        access::leaf(leaf).map_err(|_| error(PATH))?;
        OpenOptions::new().read(true).write(true).create_new(true).access_mode(0x80000000 | 0x40000000 | 0x00010000).share_mode(1).custom_flags(0x00200000).open(directory.path().join(leaf)).map_err(|_| error(IO))
    }
    #[link(name = "kernel32")] extern "system" { fn SetFileInformationByHandle(file: *mut c_void, class: i32, info: *mut c_void, size: u32) -> i32; }
    #[repr(C)] struct IoStatus { status: isize, information: usize }
    #[link(name = "ntdll")] extern "system" {
        fn NtSetInformationFile(file: *mut c_void, status: *mut IoStatus, info: *mut c_void, length: u32, class: i32) -> i32;
        fn RtlNtStatusToDosError(status: i32) -> u32;
    }
    pub(super) fn unlink(_: &Directory, _: &str, file: &File) -> Result<()> {
        let mut delete: u8 = 1;
        if unsafe { SetFileInformationByHandle(file.as_raw_handle(), 4, (&mut delete as *mut u8).cast(), 1) } == 0 { Err(error(IO)) } else { Ok(()) }
    }
    pub(super) fn publish(temp: &Temp, replace: bool) -> Result<bool> {
        #[repr(C)] struct RenameInfo { flags: u32, root: *mut c_void, length: u32, name: [u16; 1] }
        let file = temp.file.as_ref().ok_or_else(|| error(UNKNOWN))?;
        let wide = FILE.encode_utf16().collect::<Vec<_>>();
        let offset = std::mem::offset_of!(RenameInfo, name);
        let size = (offset + wide.len() * 2).max(std::mem::size_of::<RenameInfo>());
        let mut storage = vec![0usize; (size + std::mem::size_of::<usize>() - 1) / std::mem::size_of::<usize>()];
        let info = storage.as_mut_ptr().cast::<RenameInfo>();
        // 使用已锚定父目录的相对叶名，避免 Win32 全路径转换和目标目录重开。
        // 已有文件的身份句柄保留到提交：Ex + POSIX 允许替换仍打开且共享 DELETE 的目标。
        // 新建仍为无覆盖提交；不支持 Ex 的系统明确拒绝，不关闭旧句柄降级重试。
        let class = if replace { 65 } else { 10 }; // FileRenameInformation[Ex]，不是 Win32 的 3/22。
        let flags = if replace { 0x00000001 | 0x00000002 } else { 0 };
        unsafe { (*info).flags = flags; (*info).root = temp.directory.handle().as_raw_handle(); (*info).length = (wide.len() * 2) as u32; std::ptr::copy_nonoverlapping(wide.as_ptr(), storage.as_mut_ptr().cast::<u8>().add(offset).cast::<u16>(), wide.len()); }
        let mut status = IoStatus { status: 0, information: 0 };
        let result = unsafe { NtSetInformationFile(file.as_raw_handle(), &mut status, info.cast(), size as u32, class) };
        if result < 0 {
            let code = unsafe { RtlNtStatusToDosError(result) };
            #[cfg(test)] eprintln!("servers.dat 原子发布失败：replace={replace}, class={class}, NTSTATUS=0x{:08X}, Win32={code}", result as u32);
            return Err(error(if matches!(code, 1 | 50 | 87) { PLATFORM } else { IO }));
        }
        Ok(true)
    }
    // 文件内容在 rename 之前已 sync_all；Win32 没有可用于只读目录句柄的 POSIX fsync。
    pub(super) fn sync(_: &Directory) -> Result<()> { Ok(()) }
}
#[cfg(not(any(unix, windows)))]
mod native {
    use super::*;
    pub(super) fn existing(_: &Directory, _: &str) -> Result<Option<File>> { Err(error(PLATFORM)) }
    pub(super) fn locked_existing(directory: &Directory, leaf: &str) -> Result<Option<File>> { existing(directory, leaf) }
    pub(super) fn create(_: &Directory, _: &str) -> Result<File> { Err(error(PLATFORM)) }
    pub(super) fn unlink(_: &Directory, _: &str, _: &File) -> Result<()> { Err(error(PLATFORM)) }
    pub(super) fn publish(_: &Temp, _: bool) -> Result<bool> { Err(error(PLATFORM)) }
    pub(super) fn sync(_: &Directory) -> Result<()> { Err(error(PLATFORM)) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::{Condvar, Mutex, mpsc}, time::Duration};
    #[derive(Default)]
    struct WriteGate { released: Mutex<bool>, wake: Condvar }
    impl WriteGate {
        fn wait(&self) { let mut released = self.released.lock().unwrap(); while !*released { released = self.wake.wait(released).unwrap(); } }
        fn release(&self) { *self.released.lock().unwrap() = true; self.wake.notify_all(); }
    }
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("hcmcl-instance-servers-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(path.join("versions/pack")).unwrap();
            fs::write(path.join("versions/pack/pack.json"), br#"{"id":"pack"}"#).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
        fn directory(&self) -> Directory { Directory::open(&self.0).unwrap() }
        fn edit(&self, settings: Value) -> (Result<Value>, bool) { worker(self.directory(), request(), settings, Arc::new(Cancel::default())) }
        fn temps(&self) -> Vec<PathBuf> { fs::read_dir(&self.0).unwrap().map(|item| item.unwrap().path()).filter(|path| path.file_name().unwrap().to_string_lossy().starts_with(".hcmcl-servers-")).collect() }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    fn request() -> Request { Request::parse(&[json!("pack"), json!(" 服务器😀 "), json!(" example.org:25565 ")]).unwrap() }
    fn named(kind: u8, name: &str, value: &[u8]) -> Vec<u8> { let mut data = vec![kind]; data.extend(string_bytes(name).unwrap()); data.extend(value); data }
    fn compound(tags: &[Vec<u8>]) -> Vec<u8> { let mut data = tags.concat(); data.push(0); data }
    fn root(tags: &[Vec<u8>]) -> Vec<u8> { let mut data = vec![10]; data.extend(string_bytes("自定义根😀").unwrap()); data.extend(compound(tags)); data }
    fn server(name: &str, ip: &str, extra: &[Vec<u8>]) -> Vec<u8> {
        let mut tags = vec![named(8, "name", &string_bytes(name).unwrap()), named(8, "ip", &string_bytes(ip).unwrap())]; tags.extend_from_slice(extra); compound(&tags)
    }
    fn servers(entries: &[Vec<u8>]) -> Vec<u8> { let mut data = vec![10]; data.extend((entries.len() as i32).to_be_bytes()); data.extend(entries.concat()); named(9, "servers", &data) }
    fn gzip(bytes: &[u8]) -> Vec<u8> { let mut out = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default()); out.write_all(bytes).unwrap(); out.finish().unwrap() }
    fn rich_root() -> Vec<u8> {
        let extra = vec![named(8, "icon", &string_bytes("data:image/png;base64,fixture").unwrap()), named(1, "hidden", &[1]), named(1, "acceptTextures", &[0]), named(10, "unknown", &compound(&[named(4, "counter", &123i64.to_be_bytes())]))];
        let all = vec![
            named(1, "byte", &[255]), named(2, "short", &(-3i16).to_be_bytes()), named(3, "int", &123i32.to_be_bytes()), named(4, "long", &(-456i64).to_be_bytes()),
            named(5, "float", &f32::NAN.to_be_bytes()), named(6, "double", &f64::INFINITY.to_be_bytes()),
            named(7, "bytes", &[0, 0, 0, 3, 8, 9, 10]), named(8, "string", &string_bytes("包含\0和😀").unwrap()),
            named(9, "intsList", &[3, 0, 0, 0, 1, 0, 0, 0, 12]), named(10, "nested", &compound(&[named(8, "key", &string_bytes("原样").unwrap())])),
            named(11, "ints", &[0, 0, 0, 1, 0, 0, 0, 42]), named(12, "longs", &[0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 21]),
            servers(&[server("旧服务器", "example.org:25565", &extra)]), named(8, "tail", &string_bytes("根尾部保留").unwrap()),
        ];
        root(&all)
    }
    #[test]
    fn raw_and_gzip_append_preserve_all_nbt_bytes_and_duplicate_order() {
        let original = rich_root(); let before = parse(&original).unwrap();
        for input in [original.clone(), gzip(&original)] {
            let (written, items) = append(Some(&input), &request()).unwrap();
            assert_eq!(&written[..2], &[0x1f, 0x8b]);
            let decoded = unpack(&written).unwrap(); let after = parse(&decoded).unwrap();
            let mut patched = original[..before.insert].to_vec();
            let count = before.count_pos.unwrap(); patched[count..count + 4].copy_from_slice(&2i32.to_be_bytes());
            assert_eq!(&decoded[..before.insert], patched);
            assert_eq!(&decoded[after.insert..], &original[before.insert..]);
            assert_eq!(after.count, 2);
            assert_eq!(items, json!([{"name":"旧服务器","address":"example.org:25565"},{"name":"服务器😀","address":"example.org:25565"}]));
            assert_eq!(after.items, items.as_array().unwrap().clone());
            assert_eq!(decode_server_list(&written).unwrap(), after.items);
        }
    }
    #[test]
    fn missing_and_empty_server_list_created_without_losing_root_tags() {
        let req = Request::parse(&[json!(" pack "), json!("   "), json!(" [::1]:25565 ")]).unwrap();
        assert_eq!(req.name, "[::1]:25565");
        for original in [root(&[named(3, "DataVersion", &4000i32.to_be_bytes())]), root(&[named(9, "servers", &[0, 0, 0, 0, 0])])] {
            let (out, items) = append(Some(&original), &req).unwrap(); assert_eq!(parse(&unpack(&out).unwrap()).unwrap().count, 1); assert_eq!(items[0]["name"], "[::1]:25565");
        }
        assert_eq!(append(None, &req).unwrap().1.as_array().unwrap().len(), 1);
    }
    #[test]
    fn modified_utf8_and_legacy_utf8_preserve_unicode_and_reject_bad_sequences() {
        for value in ["", "中文", "\0", "a😀𠮷"] { let bytes = string_bytes(value).unwrap(); assert_eq!(decode_string(&bytes[2..]).unwrap(), value); }
        assert_eq!(decode_string("旧写入😀".as_bytes()).unwrap(), "旧写入😀");
        for bytes in [vec![0xc0, 0x81], vec![0xe0, 0x80, 0x80], vec![0xed], vec![0xff], vec![0x80]] { assert!(decode_string(&bytes).is_err()); }
        assert_eq!(decode_string(&[0xed, 0xa0, 0x80]).unwrap(), "�");
    }
    #[test]
    fn invalid_types_ambiguous_lists_lengths_and_depth_are_rejected() {
        let req = request();
        let invalid = vec![vec![], vec![0], vec![10, 0, 0], root(&[named(8, "servers", &string_bytes("wrong").unwrap())]), root(&[servers(&[]), servers(&[])]), root(&[named(9, "servers", &[10, 255, 255, 255, 255])]), root(&[named(9, "servers", &[8, 0, 0, 0, 1, 0, 0])]), root(&[servers(&[compound(&[named(3, "ip", &1i32.to_be_bytes())])])]), root(&[servers(&[compound(&[named(8, "ip", &string_bytes("one").unwrap()), named(8, "ip", &string_bytes("two").unwrap())])])])];
        for data in invalid { assert!(append(Some(&data), &req).is_err()); }
        let mut nested = vec![0]; for _ in 0..34 { nested = compound(&[named(10, "deep", &nested)]); }
        assert!(append(Some(&root(&[named(10, "tree", &nested)])), &req).is_err());
        let mut capped_payload = vec![10]; capped_payload.extend((SERVER_CAP as i32).to_be_bytes()); capped_payload.resize(capped_payload.len() + SERVER_CAP, 0);
        let capped = root(&[named(9, "servers", &capped_payload)]);
        assert_eq!(parse(&capped).unwrap().count, SERVER_CAP);
        assert_eq!(append(Some(&capped), &req).err().unwrap(), LIMIT);
        let mut negative = vec![7]; negative.extend(string_bytes("array").unwrap()); negative.extend((-1i32).to_be_bytes());
        assert!(append(Some(&root(&[negative])), &req).is_err());
        assert!(unpack(&vec![0; RAW_CAP + 1]).is_err());
    }
    #[test]
    fn gzip_crc_truncation_trailing_and_decompression_bomb_rejected() {
        let original = gzip(&rich_root());
        let mut crc = original.clone(); let index = crc.len() - 8; crc[index] ^= 0xff;
        assert!(append(Some(&crc), &request()).is_err());
        assert!(append(Some(&original[..original.len() - 1]), &request()).is_err());
        let mut trailing = original.clone(); trailing.push(0); assert!(append(Some(&trailing), &request()).is_err());
        assert!(append(Some(&[original.clone(), original].concat()), &request()).is_err());
        assert_eq!(unpack(&gzip(&vec![0; NBT_CAP + 1])).err().unwrap(), LIMIT);
    }
    #[test]
    fn arguments_and_three_language_errors_are_strict() {
        for args in [vec![], vec![json!("pack"), json!("name")], vec![json!("../pack"), json!("name"), json!("host")], vec![json!("pack"), Value::Null, json!("host")], vec![json!("pack"), json!("name"), json!("  ")], vec![json!("CON"), json!("name"), json!("host")], vec![json!("pack"), json!("name"), json!(format!("host{}", char::from(10)))], vec![json!("pack"), json!("name"), json!("x".repeat(4097))]] { assert!(Request::parse(&args).is_err()); }
        assert!(localized("en", NBT).contains("original file preserved")); assert!(localized("zh-TW", NBT).contains("原檔案")); assert!(fallback(UNKNOWN).contains("directory remains busy"));
    }
    #[test]
    fn real_files_append_atomically_and_respect_root_scoped_isolation() {
        let fixture = Fixture::new();
        let (first, unknown) = fixture.edit(json!({})); assert!(!unknown); assert_eq!(first.unwrap().as_array().unwrap().len(), 1);
        let original = fs::read(fixture.0.join(FILE)).unwrap();
        let (second, unknown) = fixture.edit(json!({})); assert!(!unknown); assert_eq!(second.unwrap().as_array().unwrap().len(), 2);
        assert!(fixture.temps().is_empty());
        let (isolated, unknown) = fixture.edit(json!({"versionIsolation":true})); assert!(!unknown); assert_eq!(isolated.unwrap().as_array().unwrap().len(), 1);
        assert_ne!(fs::read(fixture.0.join(FILE)).unwrap(), original);
        let global = fs::read(fixture.0.join(FILE)).unwrap();
        fs::write(fixture.0.join("versions/pack/instance.json"), br#"{"isolation":true}"#).unwrap();
        let (marked, unknown) = fixture.edit(json!({})); assert!(!unknown); assert_eq!(marked.unwrap().as_array().unwrap().len(), 2);
        assert_eq!(fs::read(fixture.0.join(FILE)).unwrap(), global);
        let other = Fixture::new(); let (separate, unknown) = other.edit(json!({})); assert!(!unknown); assert_eq!(separate.unwrap().as_array().unwrap().len(), 1);
    }
    #[cfg(windows)]
    #[test]
    fn windows_parent_relative_publish_keeps_open_target_identity_and_no_replace_conflicts() {
        let fixture = Fixture::new(); let directory = fixture.directory();
        let old_bytes = gzip(&rich_root());
        let mut first = Temp::create(&directory).unwrap();
        write_chunks(first.file.as_mut().unwrap(), &old_bytes, &Cancel::default()).unwrap(); first.file.as_ref().unwrap().sync_all().unwrap(); first.verify().unwrap();
        first.moved = native::publish(&first, false).unwrap(); first.published = true; first.cleanup().unwrap();
        let (existing, actual) = read_existing(&directory, &Cancel::default()).unwrap(); assert_eq!(actual.unwrap(), old_bytes);
        let mut existing = existing.unwrap();
        let (new_bytes, _) = append(Some(&old_bytes), &request()).unwrap();
        let mut next = Temp::create(&directory).unwrap();
        write_chunks(next.file.as_mut().unwrap(), &new_bytes, &Cancel::default()).unwrap(); next.file.as_ref().unwrap().sync_all().unwrap(); next.verify().unwrap();
        assert!(native::publish(&next, false).is_err()); assert_eq!(fs::read(fixture.0.join(FILE)).unwrap(), old_bytes);
        verify_existing(&directory, Some(&existing)).unwrap();
        next.moved = native::publish(&next, true).unwrap(); next.published = true; next.cleanup().unwrap();
        std::io::Seek::seek(&mut existing.file, std::io::SeekFrom::Start(0)).unwrap(); let mut still_old = Vec::new(); existing.file.read_to_end(&mut still_old).unwrap(); assert_eq!(still_old, old_bytes);
        let current = native::existing(&directory, FILE).unwrap().unwrap(); assert_ne!(stamp(&current, false).unwrap().identity, existing.stamp.identity);
        assert_eq!(fs::read(fixture.0.join(FILE)).unwrap(), new_bytes); assert!(fixture.temps().is_empty());
    }
    #[test]
    fn corrupt_original_and_failed_or_cancelled_writes_keep_exact_old_bytes() {
        let fixture = Fixture::new();
        for original in [b"bad nbt".to_vec(), vec![], vec![0x1f, 0x8b, 0x00]] {
            fs::write(fixture.0.join(FILE), &original).unwrap(); let (result, unknown) = fixture.edit(json!({})); assert!(result.is_err()); assert!(!unknown); assert_eq!(fs::read(fixture.0.join(FILE)).unwrap(), original); assert!(fixture.temps().is_empty());
        }
        let original = gzip(&rich_root()); fs::write(fixture.0.join(FILE), &original).unwrap();
        let (failed, unknown) = worker_with(fixture.directory(), request(), json!({}), Arc::new(Cancel::default()), |writer, _, _| { writer.write_all(b"partial").unwrap(); Err(error(IO)) });
        assert_eq!(failed.err().unwrap(), IO); assert!(!unknown); assert_eq!(fs::read(fixture.0.join(FILE)).unwrap(), original); assert!(fixture.temps().is_empty());
        let cancel = Arc::new(Cancel::default()); cancel.stop(); let (cancelled, unknown) = worker(fixture.directory(), request(), json!({}), cancel); assert_eq!(cancelled.err().unwrap(), CANCELLED); assert!(!unknown); assert_eq!(fs::read(fixture.0.join(FILE)).unwrap(), original);
    }
    #[test]
    fn concurrent_winner_and_changed_marker_are_not_overwritten() {
        let fixture = Fixture::new();
        let winner = gzip(&rich_root()); let installed = fixture.0.join(FILE);
        let (result, unknown) = worker_with(fixture.directory(), request(), json!({}), Arc::new(Cancel::default()), |writer, bytes, cancel| { fs::write(&installed, &winner).unwrap(); write_chunks(writer, bytes, cancel) });
        assert!(result.is_err()); assert!(!unknown); assert_eq!(fs::read(installed).unwrap(), winner); assert!(fixture.temps().is_empty());
        let (result, unknown) = worker_with(fixture.directory(), request(), json!({}), Arc::new(Cancel::default()), |writer, bytes, cancel| { fs::write(fixture.0.join("versions/pack/instance.json"), br#"{"isolation":true}"#).unwrap(); write_chunks(writer, bytes, cancel) });
        assert!(result.is_err()); assert!(!unknown); assert_eq!(fs::read(fixture.0.join(FILE)).unwrap(), winner); assert!(fixture.temps().is_empty());
    }
    #[test]
    fn hardlink_special_file_alias_and_wrong_instance_never_change_sources() {
        let fixture = Fixture::new(); let original = gzip(&rich_root()); let source = fixture.0.join("source"); fs::write(&source, &original).unwrap();
        fs::hard_link(&source, fixture.0.join(FILE)).unwrap(); let (result, unknown) = fixture.edit(json!({})); assert!(result.is_err()); assert!(!unknown); assert_eq!(fs::read(&source).unwrap(), original);
        fs::remove_file(fixture.0.join(FILE)).unwrap(); fs::create_dir(fixture.0.join(FILE)).unwrap(); assert!(fixture.edit(json!({})).0.is_err()); fs::remove_dir(fixture.0.join(FILE)).unwrap();
        fs::write(fixture.0.join("Servers.dat"), &original).unwrap(); assert!(fixture.edit(json!({})).0.is_err()); assert_eq!(fs::read(fixture.0.join("Servers.dat")).unwrap(), original); fs::remove_file(fixture.0.join("Servers.dat")).unwrap();
        fs::remove_file(fixture.0.join("versions/pack/pack.json")).unwrap(); assert!(fixture.edit(json!({})).0.is_err()); assert!(!fixture.0.join(FILE).exists());
    }
    #[test]
    fn temp_cleanup_refuses_replaced_identity_without_deleting_the_winner() {
        let fixture = Fixture::new(); let mut temp = Temp::create(&fixture.directory()).unwrap();
        let old = fixture.0.join(&temp.name); let moved = fixture.0.join("old-temp");
        #[cfg(unix)] { fs::rename(&old, &moved).unwrap(); fs::write(&old, b"winner").unwrap(); assert!(temp.cleanup().is_err()); assert_eq!(fs::read(&old).unwrap(), b"winner"); }
        #[cfg(windows)] { assert!(fs::rename(&old, &moved).is_err()); temp.cleanup().unwrap(); assert!(!old.exists()); }
    }
    #[cfg(unix)]
    #[test]
    fn symlink_and_rebound_ancestor_preserve_outside_and_replacement_files() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new(); let source = fixture.0.join("outside"); fs::write(&source, b"outside").unwrap(); symlink(&source, fixture.0.join(FILE)).unwrap();
        assert!(fixture.edit(json!({})).0.is_err()); assert_eq!(fs::read(&source).unwrap(), b"outside"); fs::remove_file(fixture.0.join(FILE)).unwrap();
        let held = fixture.directory(); let old = fixture.0.with_extension("moved"); fs::rename(&fixture.0, &old).unwrap(); fs::create_dir(&fixture.0).unwrap(); fs::write(fixture.0.join(FILE), b"replacement").unwrap();
        let (result, unknown) = worker(held, request(), json!({}), Arc::new(Cancel::default())); assert!(result.is_err()); assert!(!unknown); assert_eq!(fs::read(fixture.0.join(FILE)).unwrap(), b"replacement"); fs::remove_dir_all(old).unwrap();
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dropped_ipc_waiter_keeps_actual_writer_root_lock_and_gate_until_cleanup() {
        for drop_waiter in [false, true] {
            let fixture = Fixture::new(); let original = gzip(&rich_root()); fs::write(fixture.0.join(FILE), &original).unwrap();
            let gate = lifecycle::Gate::default(); let registration = gate.enter().unwrap(); let cancel = Arc::new(Cancel::default());
            let guard = crate::install_lock::acquire(&fixture.0, || false).await.unwrap(); let directory = fixture.directory();
            let block = Arc::new(WriteGate::default()); let writer_block = block.clone(); let (started_tx, started_rx) = mpsc::channel(); let worker_cancel = cancel.clone();
            let work = tokio::task::spawn_blocking(move || worker_with(directory, request(), json!({}), worker_cancel, |file, bytes, cancel| { file.write_all(&bytes[..bytes.len().min(12)]).unwrap(); let _ = started_tx.send(()); writer_block.wait(); check(cancel)?; write_chunks(file, &bytes[bytes.len().min(12)..], cancel) }));
            let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
            let supervisor = tokio::spawn(async move { let result = retain(work, registration, guard).await; let _ = finished_tx.send(()); result });
            let waiting = Waiting(cancel.clone()); let waiter = tokio::spawn(async move { let _waiting = waiting; supervisor.await.unwrap() });
            let started = started_rx.recv_timeout(Duration::from_secs(5)).is_ok();
            if drop_waiter { waiter.abort(); } else { cancel.stop(); }
            let blocked = gate.begin_restart().is_err(); let stage_present = !fixture.temps().is_empty(); let old_unchanged = fs::read(fixture.0.join(FILE)).map(|bytes| bytes == original).unwrap_or(false);
            let next_cancel = Arc::new(Cancel::default()); let next_root = fixture.0.clone(); let next_gate = next_cancel.clone();
            let mut next = tokio::spawn(async move { crate::install_lock::acquire(&next_root, || next_gate.check().is_err()).await });
            let lock_still_held = tokio::time::timeout(Duration::from_millis(80), &mut next).await.is_err(); next_cancel.stop();
            block.release(); let _ = next.await;
            let finished = tokio::time::timeout(Duration::from_secs(5), finished_rx).await.is_ok();
            let completed = if drop_waiter { let _ = waiter.await; None } else { Some(waiter.await.unwrap()) };
            assert!(started && blocked && stage_present && old_unchanged && lock_still_held && finished && gate.begin_restart().is_ok());
            if let Some(result) = completed { assert_eq!(result.err().unwrap(), CANCELLED); }
            assert_eq!(fs::read(fixture.0.join(FILE)).unwrap(), original); assert!(fixture.temps().is_empty());
        }
    }
}

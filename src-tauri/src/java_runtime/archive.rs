//! Java JRE ZIP/tar.gz 安全解包。先完整预检，再只写入调用方提供的空 payload。
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions, Permissions},
    io::{self, BufReader, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
};
use zip::{CompressionMethod, ZipArchive};

const ARCHIVE_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
const ENTRY_LIMIT: u64 = 256 * 1024 * 1024;
const TOTAL_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
const TAR_STREAM_LIMIT: u64 = TOTAL_LIMIT + 512 * 1024 * 1024;
const ENTRY_COUNT_LIMIT: usize = 100_000;
const PATH_LIMIT: usize = 32_768;
const PATH_DEPTH_LIMIT: usize = 64;
const LINK_DEPTH_LIMIT: usize = 32;
const ZIP_CENTRAL_LIMIT: u64 = 64 * 1024 * 1024;
const TAR_METADATA_LIMIT: usize = 1024 * 1024;
const TAR_METADATA_TOTAL_LIMIT: usize = 16 * 1024 * 1024;
const IO_CHUNK: usize = 64 * 1024;

type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind { File, Dir, Link }

#[derive(Clone, Debug)]
struct EntryPlan {
    path: PathBuf,
    key: String,
    kind: Kind,
    size: u64,
    mode: u32,
    data_offset: u64,
    link_target: Option<String>,
    zip_index: Option<usize>,
}

#[derive(Default)]
struct Registry {
    nodes: BTreeMap<String, (String, Kind, bool)>,
    explicit: BTreeSet<String>,
}

impl Registry {
    fn add(&mut self, path: &Path, directory: bool) -> Result<String> {
        let text = path.to_str().ok_or("Java 归档路径不是 UTF-8")?.replace('\\', "/");
        let key = text.to_lowercase();
        let parts: Vec<&str> = text.split('/').collect();
        let mut prefix = String::new();
        for (index, part) in parts.iter().enumerate() {
            if !prefix.is_empty() { prefix.push('/'); }
            prefix.push_str(part);
            let node_key = prefix.to_lowercase();
            let last = index + 1 == parts.len();
            let expected = if !last || directory { Kind::Dir } else { Kind::File };
            match self.nodes.get_mut(&node_key) {
                Some((existing, kind, is_explicit)) => {
                    if *existing != prefix || *kind == Kind::File || (last && expected == Kind::File) {
                        return Err("Java 归档含路径别名或文件/目录冲突".into());
                    }
                    if last {
                        if *is_explicit { return Err("Java 归档含重复路径".into()); }
                        *is_explicit = true;
                        self.explicit.insert(node_key);
                    }
                }
                None => {
                    let is_explicit = last;
                    self.nodes.insert(node_key.clone(), (prefix.clone(), expected, is_explicit));
                    if is_explicit { self.explicit.insert(node_key); }
                }
            }
            if self.nodes.len() > ENTRY_COUNT_LIMIT {
                return Err("Java 归档路径节点超过预算".into());
            }
        }
        Ok(key)
    }
}

fn cancel(cancel: &crate::downloads::Cancel) -> Result<()> { cancel.check() }

fn checked_archive(path: &Path) -> Result<File> {
    let absolute = if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().map_err(|_| "无法定位 Java 归档")?.join(path) };
    let mut current = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => { current.push(prefix.as_os_str()); continue; }
            Component::RootDir | Component::Normal(_) => current.push(component.as_os_str()),
            Component::CurDir | Component::ParentDir => return Err("Java 归档路径含跳转".into()),
        }
        let meta = fs::symlink_metadata(&current).map_err(|_| "无法验证 Java 归档路径")?;
        reject_reparse(&meta)?;
        if current != absolute && !meta.is_dir() { return Err("Java 归档父路径不是目录".into()); }
    }
    let meta = fs::symlink_metadata(&absolute).map_err(|_| "Java 归档不存在")?;
    if !meta.is_file() { return Err("Java 归档不是普通文件".into()); }
    if meta.len() < 2 || meta.len() > ARCHIVE_LIMIT { return Err("Java 归档大小无效或超过 2 GiB".into()); }
    File::open(absolute).map_err(|_| "无法打开 Java 归档".into())
}

fn reject_reparse(meta: &fs::Metadata) -> Result<()> {
    if meta.file_type().is_symlink() { return Err("Java 归档路径含符号链接".into()); }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 { return Err("Java 归档路径含重解析点".into()); }
    }
    Ok(())
}

fn payload_root(payload: &Path) -> Result<PathBuf> {
    if !payload.is_absolute() { return Err("Java payload 必须是绝对路径".into()); }
    let mut current = PathBuf::new();
    for component in payload.components() {
        match component {
            Component::Prefix(p) => current.push(p.as_os_str()),
            Component::RootDir => current.push(component.as_os_str()),
            Component::Normal(n) => {
                current.push(n);
                let meta = fs::symlink_metadata(&current).map_err(|_| "Java payload 路径不存在")?;
                reject_reparse(&meta)?;
                if !meta.is_dir() { return Err("Java payload 必须是普通目录".into()); }
            }
            Component::CurDir | Component::ParentDir => return Err("Java payload 路径无效".into()),
        }
    }
    let root = payload.to_path_buf();
    let mut entries = fs::read_dir(&root).map_err(|_| "无法读取 Java payload")?;
    if entries.next().is_some() { return Err("Java payload 必须是新建的空目录".into()); }
    Ok(root)
}

fn relative(raw: &str, directory: bool) -> Result<PathBuf> {
    if raw.is_empty() || raw.len() > PATH_LIMIT || raw.starts_with('/') || raw.contains('\\') || raw.contains('\0') || raw.chars().any(char::is_control) {
        return Err("Java 归档含绝对路径、反斜杠或无效路径".into());
    }
    let raw = if directory { raw.strip_suffix('/').unwrap_or(raw) } else { raw };
    if raw.is_empty() || raw.len() > PATH_LIMIT || raw.split('/').count() > PATH_DEPTH_LIMIT { return Err("Java 归档路径层级或长度超过上限".into()); }
    let mut out = PathBuf::new();
    for part in raw.split('/') {
        if part == "." { continue; }
        if part.is_empty() || part == ".." || part.len() > 255 || part.ends_with('.') || part.ends_with(' ') || part.contains(':') || part.chars().any(|c| "<>\"|?*".contains(c)) {
            return Err("Java 归档含不安全路径段".into());
        }
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && matches!(stem.as_bytes()[3], b'1'..=b'9')) {
            return Err("Java 归档含系统保留名称".into());
        }
        out.push(part);
    }
    if out.as_os_str().is_empty() { return Err("Java 归档路径为空".into()); }
    Ok(out)
}

fn normalized_target(base: &Path, target: &str) -> Result<PathBuf> {
    if target.is_empty() || target.len() > PATH_LIMIT || target.starts_with('/') || target.contains('\\') || target.contains('\0') || target.chars().any(char::is_control) {
        return Err("Java 内部链接目标无效".into());
    }
    let mut parts: Vec<String> = base.iter().map(|p| p.to_str().unwrap_or("").to_owned()).collect();
    for part in target.split('/') {
        match part {
            "" | "." => continue,
            ".." => { if parts.pop().is_none() { return Err("Java 内部链接越界".into()); } }
            value => {
                if value.len() > 255 || value.contains(':') || value.chars().any(|c| "<>\"|?*".contains(c)) { return Err("Java 内部链接目标含无效路径段".into()); }
                parts.push(value.to_owned());
            }
        }
        if parts.len() > PATH_DEPTH_LIMIT { return Err("Java 内部链接目标过深".into()); }
    }
    if parts.is_empty() { return Err("Java 内部链接目标为空".into()); }
    relative(&parts.join("/"), false)
}

fn ensure_extra_fields(extra: &[u8]) -> Result<()> {
    let mut at = 0usize;
    while at < extra.len() {
        let end = at.checked_add(4).filter(|n| *n <= extra.len()).ok_or("ZIP 扩展字段损坏")?;
        let id = u16::from_le_bytes([extra[at], extra[at + 1]]);
        let len = u16::from_le_bytes([extra[at + 2], extra[at + 3]]) as usize;
        if matches!(id, 0x0001 | 0x000d | 0x9901) { return Err("Java ZIP 使用 ZIP64、Unix 链接或加密扩展".into()); }
        at = end.checked_add(len).filter(|n| *n <= extra.len()).ok_or("ZIP 扩展字段越界")?;
    }
    Ok(())
}

#[derive(Clone)]
struct ZipMeta { name: String, path: PathBuf, key: String, kind: Kind, size: u64, compressed: u64, crc: u32, mode: u32, flags: u16, method: u16, local: u64 }

fn read_exact_cancel(file: &mut File, out: &mut [u8], cancel_token: &crate::downloads::Cancel) -> Result<()> {
    let mut at = 0;
    while at < out.len() {
        cancel(cancel_token)?;
        let n = (out.len() - at).min(IO_CHUNK);
        file.read_exact(&mut out[at..at + n]).map_err(|_| "Java 归档被截断")?;
        at += n;
    }
    Ok(())
}

fn bounded_zip(file: &mut File, cancel_token: &crate::downloads::Cancel) -> Result<Vec<ZipMeta>> {
    let length = file.metadata().map_err(|_| "无法读取 Java ZIP 大小")?.len();
    if length < 22 || length > ARCHIVE_LIMIT { return Err("Java ZIP 大小无效".into()); }
    let tail_len = length.min(65_557) as usize;
    file.seek(SeekFrom::End(-(tail_len as i64))).map_err(|_| "无法定位 Java ZIP 结束目录")?;
    let mut tail = vec![0; tail_len];
    read_exact_cancel(file, &mut tail, cancel_token)?;
    let footers: Vec<usize> = tail.windows(4).enumerate().filter_map(|(i, b)| (b == b"PK\x05\x06").then_some(i)).collect();
    if footers.len() != 1 || tail.windows(4).any(|b| b == b"PK\x06\x06" || b == b"PK\x06\x07") { return Err("Java ZIP 含歧义 EOCD 或 ZIP64 记录".into()); }
    let at = footers[0];
    if at.checked_add(22).filter(|end| *end <= tail.len()).is_none() { return Err("Java ZIP EOCD 损坏".into()); }
    let word = |n: usize| u16::from_le_bytes([tail[at + n], tail[at + n + 1]]);
    let dword = |n: usize| u32::from_le_bytes([tail[at + n], tail[at + n + 1], tail[at + n + 2], tail[at + n + 3]]);
    if at + 22 + word(20) as usize != tail.len() { return Err("Java ZIP comment 长度异常".into()); }
    let eocd = length - tail_len as u64 + at as u64;
    if eocd >= 20 {
        file.seek(SeekFrom::Start(eocd - 20)).map_err(|_| "无法检查 ZIP64 locator")?;
        let mut locator = [0; 20]; read_exact_cancel(file, &mut locator, cancel_token)?;
        if &locator[..4] == b"PK\x06\x07" { return Err("Java ZIP 不支持 ZIP64".into()); }
    }
    let count = word(10) as usize;
    let central_size = dword(12) as u64;
    let central_offset = dword(16) as u64;
    if word(4) != 0 || word(6) != 0 || word(8) != word(10) || count == 0 || count > ENTRY_COUNT_LIMIT || central_size > ZIP_CENTRAL_LIMIT || dword(12) == u32::MAX || dword(16) == u32::MAX || central_offset.checked_add(central_size) != Some(eocd) {
        return Err("Java ZIP 中央目录超过预算，或使用多卷/ZIP64".into());
    }
    file.seek(SeekFrom::Start(central_offset)).map_err(|_| "无法定位 Java ZIP 中央目录")?;
    let mut central = vec![0u8; central_size as usize]; read_exact_cancel(file, &mut central, cancel_token)?;
    let mut cursor = 0usize;
    let mut registry = Registry::default();
    let mut entries = Vec::with_capacity(count);
    let mut local_ranges = Vec::with_capacity(count);
    for _ in 0..count {
        cancel(cancel_token)?;
        if cursor.checked_add(46).filter(|n| *n <= central.len()).is_none() || &central[cursor..cursor + 4] != b"PK\x01\x02" { return Err("Java ZIP 中央目录格式异常".into()); }
        let get16 = |n: usize| u16::from_le_bytes([central[cursor + n], central[cursor + n + 1]]);
        let get32 = |n: usize| u32::from_le_bytes([central[cursor + n], central[cursor + n + 1], central[cursor + n + 2], central[cursor + n + 3]]);
        let name_len = get16(28) as usize; let extra_len = get16(30) as usize; let comment_len = get16(32) as usize;
        let record_end = cursor.checked_add(46).and_then(|n| n.checked_add(name_len)).and_then(|n| n.checked_add(extra_len)).and_then(|n| n.checked_add(comment_len)).filter(|n| *n <= central.len()).ok_or("Java ZIP 中央条目长度异常")?;
        if name_len == 0 || name_len > PATH_LIMIT || get16(34) != 0 { return Err("Java ZIP 名称或磁盘编号无效".into()); }
        let flags = get16(8); let method = get16(10);
        if flags & !0x080e != 0 || flags & (1 | 0x40 | 0x2000) != 0 { return Err("Java ZIP 加密或标志位不受支持".into()); }
        if !matches!(method, 0 | 8) { return Err("Java ZIP 压缩方式不受支持".into()); }
        if method == 0 && flags & 0x0006 != 0 { return Err("Java ZIP stored 条目含无效压缩标志".into()); }
        let raw_name = &central[cursor + 46..cursor + 46 + name_len];
        let name = std::str::from_utf8(raw_name).map_err(|_| "Java ZIP 路径必须为 UTF-8")?;
        if flags & 0x0800 == 0 && !raw_name.is_ascii() { return Err("Java ZIP 非 ASCII 路径必须标记 UTF-8".into()); }
        let directory = name.ends_with('/');
        let path = relative(name, directory)?;
        ensure_extra_fields(&central[cursor + 46 + name_len..cursor + 46 + name_len + extra_len])?;
        let creator = central[cursor + 5];
        let ext_attr = get32(38);
        if ext_attr & 0x400 != 0 { return Err("Java ZIP 含 Windows 重解析点属性".into()); }
        let mode = if creator == 3 || creator == 19 { (ext_attr >> 16) & 0xffff } else { 0 };
        let file_type = mode & 0o170000;
        let kind = if file_type == 0o120000 { Kind::Link } else if directory || file_type == 0o040000 { Kind::Dir } else if file_type == 0 || file_type == 0o100000 { Kind::File } else { return Err("Java ZIP 含设备或特殊文件".into()); };
        if (directory && kind != Kind::Dir) || (kind == Kind::Dir && get32(24) != 0) { return Err("Java ZIP 目录元数据不一致".into()); }
        if kind == Kind::Link && !(creator == 3 || creator == 19) { return Err("Java ZIP 链接没有可信 Unix 类型标记".into()); }
        let key = registry.add(&path, kind == Kind::Dir)?;
        let size = get32(24) as u64; let compressed = get32(20) as u64;
        if size > ENTRY_LIMIT || compressed > ARCHIVE_LIMIT || (size > 0 && compressed == 0) { return Err("Java ZIP 条目大小无效".into()); }
        if kind == Kind::Link && size > 4096 { return Err("Java ZIP 链接目标超过 4096 字节".into()); }
        let local = get32(42) as u64;
        if get32(20) == u32::MAX || get32(24) == u32::MAX || get32(42) == u32::MAX { return Err("Java ZIP 不支持 ZIP64 条目".into()); }
        let mut header = [0u8; 30];
        file.seek(SeekFrom::Start(local)).map_err(|_| "Java ZIP 本地头偏移无效")?;
        read_exact_cancel(file, &mut header, cancel_token)?;
        if &header[..4] != b"PK\x03\x04" { return Err("Java ZIP 本地头签名无效".into()); }
        let local_flags = u16::from_le_bytes([header[6], header[7]]);
        let local_method = u16::from_le_bytes([header[8], header[9]]);
        let local_name_len = u16::from_le_bytes([header[26], header[27]]) as usize;
        let local_extra_len = u16::from_le_bytes([header[28], header[29]]) as usize;
        if local_flags != flags || local_method != method || local_name_len != name_len { return Err("Java ZIP 本地头与中央目录不一致".into()); }
        let mut local_name = vec![0u8; local_name_len]; read_exact_cancel(file, &mut local_name, cancel_token)?;
        if local_name != raw_name { return Err("Java ZIP 本地路径与中央目录不一致".into()); }
        let mut local_extra = vec![0u8; local_extra_len]; read_exact_cancel(file, &mut local_extra, cancel_token)?; ensure_extra_fields(&local_extra)?;
        let data_start = local.checked_add(30).and_then(|n| n.checked_add(local_name_len as u64)).and_then(|n| n.checked_add(local_extra_len as u64)).ok_or("Java ZIP 数据偏移溢出")?;
        let data_end = data_start.checked_add(compressed).filter(|n| *n <= central_offset).ok_or("Java ZIP 数据超出归档区域")?;
        local_ranges.push((local, data_end));
        entries.push(ZipMeta { name: name.to_owned(), path, key, kind, size, compressed, crc: get32(16), mode, flags, method, local });
        cursor = record_end;
    }
    if cursor != central.len() { return Err("Java ZIP 中央目录有尾随数据".into()); }
    local_ranges.sort_unstable();
    if local_ranges.windows(2).any(|w| w[0].1 > w[1].0) { return Err("Java ZIP 条目数据区域重叠".into()); }
    Ok(entries)
}

fn zip_mode(meta: &ZipMeta) -> u32 {
    if meta.mode != 0 { meta.mode & 0o777 }
    else if meta.kind == Kind::Dir { 0o755 }
    else { 0o644 }
}

fn validate_zip_content<R: Read + Seek>(archive: &mut ZipArchive<R>, entries: &[ZipMeta], cancel_token: &crate::downloads::Cancel) -> Result<Vec<EntryPlan>> {
    if archive.len() != entries.len() { return Err("Java ZIP 条目数量在解析时改变".into()); }
    let mut total = 0u64;
    let mut plans = Vec::with_capacity(entries.len());
    for (index, meta) in entries.iter().enumerate() {
        cancel(cancel_token)?;
        let mut item = archive.by_index(index).map_err(|_| "无法读取 Java ZIP 条目")?;
        if item.name_raw() != meta.name.as_bytes() || item.size() != meta.size || item.compressed_size() != meta.compressed || item.crc32() != meta.crc || item.compression() != if meta.method == 0 { CompressionMethod::Stored } else { CompressionMethod::Deflated } || item.header_start() != meta.local {
            return Err("Java ZIP 条目元数据前后不一致".into());
        }
        let mut link_target = None;
        let mut remaining = meta.size;
        let mut link_bytes = Vec::with_capacity(if meta.kind == Kind::Link { meta.size as usize } else { 0 });
        let mut buffer = [0u8; IO_CHUNK];
        let mut read_size = 0u64;
        while remaining > 0 {
            cancel(cancel_token)?;
            let want = buffer.len().min(remaining as usize);
            let n = item.read(&mut buffer[..want]).map_err(|_| "Java ZIP 解压或 CRC 校验失败")?;
            if n == 0 { return Err("Java ZIP 条目实际长度短于声明".into()); }
            read_size = read_size.checked_add(n as u64).ok_or("Java ZIP 条目长度溢出")?;
            remaining -= n as u64;
            if meta.kind == Kind::Link { link_bytes.extend_from_slice(&buffer[..n]); }
        }
        let mut extra = [0u8; 1];
        if item.read(&mut extra).map_err(|_| "Java ZIP 解压或 CRC 校验失败")? != 0 { return Err("Java ZIP 条目实际长度超过声明".into()); }
        if read_size != meta.size { return Err("Java ZIP 条目长度与声明不符".into()); }
        if meta.kind == Kind::Dir && meta.size != 0 { return Err("Java ZIP 目录携带数据".into()); }
        if meta.kind == Kind::Link {
            let target = String::from_utf8(link_bytes).map_err(|_| "Java ZIP 链接目标不是 UTF-8")?;
            if target.is_empty() || target.contains('\0') { return Err("Java ZIP 链接目标无效".into()); }
            link_target = Some(target);
        } else if meta.kind == Kind::File {
            total = total.checked_add(meta.size).filter(|n| *n <= TOTAL_LIMIT).ok_or("Java JRE 解包总量超过 2 GiB")?;
        }
        plans.push(EntryPlan { path: meta.path.clone(), key: meta.key.clone(), kind: meta.kind, size: meta.size, mode: zip_mode(meta), data_offset: 0, link_target, zip_index: Some(index) });
    }
    resolve_links(&mut plans, total)?;
    Ok(plans)
}

fn checked_tar_number(raw: &[u8]) -> Result<u64> {
    if raw.is_empty() { return Ok(0); }
    if raw[0] & 0x80 != 0 {
        if raw[0] & 0x40 != 0 { return Err("tar 使用负数大小或权限".into()); }
        let mut value = (raw[0] & 0x3f) as u64;
        for b in &raw[1..] { value = value.checked_mul(256).and_then(|v| v.checked_add(*b as u64)).ok_or("tar 数值溢出")?; }
        return Ok(value);
    }
    let trimmed = raw.iter().copied().skip_while(|b| *b == b' ' || *b == 0).collect::<Vec<_>>();
    let trimmed = trimmed.iter().copied().take_while(|b| *b != 0 && *b != b' ').collect::<Vec<_>>();
    if trimmed.is_empty() { return Ok(0); }
    let mut value = 0u64;
    for b in trimmed { if !(b'0'..=b'7').contains(&b) { return Err("tar 八进制字段无效".into()); } value = value.checked_mul(8).and_then(|v| v.checked_add((b - b'0') as u64)).ok_or("tar 数值溢出")?; }
    Ok(value)
}

fn tar_field(raw: &[u8]) -> Result<String> {
    let end = raw.iter().position(|b| *b == 0).unwrap_or(raw.len());
    if raw[end..].iter().any(|b| *b != 0) { return Err("tar 字段含 NUL 后数据".into()); }
    let text = std::str::from_utf8(&raw[..end]).map_err(|_| "tar 路径不是 UTF-8")?;
    Ok(text.to_owned())
}

fn tar_checksum(header: &[u8; 512]) -> Result<()> {
    let expected = checked_tar_number(&header[148..156])?;
    let unsigned: u64 = header.iter().enumerate().map(|(i, b)| if (148..156).contains(&i) { 32 } else { *b as u64 }).sum();
    let signed: i64 = header.iter().enumerate().map(|(i, b)| if (148..156).contains(&i) { 32 } else { *b as i8 as i64 }).sum();
    if expected != unsigned && (signed < 0 || expected != signed as u64) { return Err("tar 头校验和不匹配".into()); }
    Ok(())
}

#[derive(Default, Clone)]
struct Pax { path: Option<String>, linkpath: Option<String>, size: Option<u64> }

fn parse_pax(bytes: &[u8], aggregate: &mut usize) -> Result<Pax> {
    *aggregate = aggregate.checked_add(bytes.len()).ok_or("tar PAX 元数据溢出")?;
    if bytes.len() > TAR_METADATA_LIMIT || *aggregate > TAR_METADATA_TOTAL_LIMIT { return Err("tar PAX 元数据超过上限".into()); }
    let mut at = 0usize; let mut out = Pax::default();
    while at < bytes.len() {
        let space = bytes[at..].iter().position(|b| *b == b' ').map(|n| at + n).ok_or("tar PAX 记录长度无效")?;
        if space == at || !bytes[at..space].iter().all(u8::is_ascii_digit) { return Err("tar PAX 记录长度无效".into()); }
        let length: usize = std::str::from_utf8(&bytes[at..space]).map_err(|_| "tar PAX 长度无效")?.parse().map_err(|_| "tar PAX 长度溢出")?;
        let end = at.checked_add(length).filter(|n| *n <= bytes.len()).ok_or("tar PAX 记录越界")?;
        if end <= space + 2 || bytes[end - 1] != b'\n' { return Err("tar PAX 记录缺少换行".into()); }
        let body = &bytes[space + 1..end - 1];
        let equal = body.iter().position(|b| *b == b'=').ok_or("tar PAX 键值无效")?;
        let key = std::str::from_utf8(&body[..equal]).map_err(|_| "tar PAX 键不是 UTF-8")?;
        let value = std::str::from_utf8(&body[equal + 1..]).map_err(|_| "tar PAX 值不是 UTF-8")?;
        if key.starts_with("GNU.sparse") || key == "SCHILY.realsize" { return Err("tar 稀疏文件不受支持".into()); }
        match key {
            "path" => out.path = Some(value.to_owned()),
            "linkpath" => out.linkpath = Some(value.to_owned()),
            "size" => out.size = Some(value.parse().map_err(|_| "tar PAX size 无效")?),
            _ => {}
        }
        at = end;
    }
    Ok(out)
}

fn read_spool_at(file: &mut File, offset: u64, bytes: &mut [u8], cancel_token: &crate::downloads::Cancel) -> Result<()> {
    cancel(cancel_token)?;
    file.seek(SeekFrom::Start(offset)).map_err(|_| "无法定位 tar 数据")?;
    read_exact_cancel(file, bytes, cancel_token)
}

fn padded_tar(size: u64) -> Result<u64> { size.checked_add(511).map(|n| n & !511).ok_or_else(|| "tar 条目偏移溢出".into()) }

fn parse_tar(file: &mut File, length: u64, cancel_token: &crate::downloads::Cancel) -> Result<Vec<EntryPlan>> {
    let mut at = 0u64; let mut count = 0usize; let mut metadata_total = 0usize;
    let mut global = Pax::default(); let mut local = Pax::default(); let mut long_name: Option<String> = None; let mut long_link: Option<String> = None;
    let mut registry = Registry::default(); let mut plans = Vec::new(); let mut saw_end = false;
    while at.checked_add(512).filter(|n| *n <= length).is_some() {
        cancel(cancel_token)?;
        let mut header = [0u8; 512]; read_spool_at(file, at, &mut header, cancel_token)?;
        if header.iter().all(|b| *b == 0) {
            if at + 1024 > length { return Err("tar 结束标记不完整".into()); }
            let mut tail = vec![0u8; IO_CHUNK]; let mut pos = at;
            while pos < length {
                cancel(cancel_token)?; let n = (length - pos).min(tail.len() as u64) as usize;
                read_spool_at(file, pos, &mut tail[..n], cancel_token)?;
                if tail[..n].iter().any(|b| *b != 0) { return Err("tar 结束块后含非零数据".into()); }
                pos += n as u64;
            }
            saw_end = true; break;
        }
        tar_checksum(&header)?;
        count += 1; if count > ENTRY_COUNT_LIMIT { return Err("tar 条目超过 100000 项".into()); }
        let raw_size = checked_tar_number(&header[124..136])?;
        let mode = checked_tar_number(&header[100..108])? as u32;
        let typeflag = header[156];
        let mut body_path = tar_field(&header[..100])?;
        // GNU 头的相同区域是 atime/ctime 等字段，只有 POSIX ustar 才有 prefix。
        if &header[257..263] == b"ustar\0" {
            let prefix = tar_field(&header[345..500])?;
            if !prefix.is_empty() { body_path = format!("{prefix}/{body_path}"); }
        }
        let body_link = tar_field(&header[157..257])?;
        let data_start = at.checked_add(512).ok_or("tar 数据偏移溢出")?;
        let raw_end = data_start.checked_add(padded_tar(raw_size)?).filter(|n| *n <= length).ok_or("tar 条目数据越界")?;
        match typeflag {
            b'x' | b'g' | b'L' | b'K' => {
                if raw_size as usize > TAR_METADATA_LIMIT { return Err("tar 扩展元数据超过 1 MiB".into()); }
                let mut body = vec![0u8; raw_size as usize]; read_spool_at(file, data_start, &mut body, cancel_token)?;
                match typeflag {
                    b'x' => { local = parse_pax(&body, &mut metadata_total)?; }
                    b'g' => { global = parse_pax(&body, &mut metadata_total)?; }
                    b'L' | b'K' => {
                        metadata_total = metadata_total.checked_add(body.len()).ok_or("tar GNU 元数据溢出")?;
                        if metadata_total > TAR_METADATA_TOTAL_LIMIT { return Err("tar GNU 元数据超过上限".into()); }
                        if body.last() == Some(&0) { body.pop(); }
                        if body.contains(&0) { return Err("tar GNU 长名称含 NUL".into()); }
                        let value = std::str::from_utf8(&body).map_err(|_| "tar GNU 长名称不是 UTF-8")?.to_owned();
                        if value.len() > PATH_LIMIT { return Err("tar GNU 长名称过长".into()); }
                        if typeflag == b'L' { long_name = Some(value); } else { long_link = Some(value); }
                    }
                    _ => unreachable!(),
                }
                at = raw_end; continue;
            }
            _ => {}
        }
        let path_text = local.path.as_deref().or(global.path.as_deref()).or(long_name.as_deref()).unwrap_or(&body_path).to_owned();
        let link_text = local.linkpath.as_deref().or(global.linkpath.as_deref()).or(long_link.as_deref()).unwrap_or(&body_link).to_owned();
        let size = local.size.or(global.size).unwrap_or(raw_size);
        if size > ENTRY_LIMIT { return Err("tar 单条目超过 256 MiB".into()); }
        let kind = match typeflag {
            0 | b'0' => Kind::File,
            b'5' => Kind::Dir,
            b'2' => Kind::Link,
            b'1' => return Err("tar 硬链接不受支持".into()),
            _ => return Err("tar 含设备、稀疏或其他特殊条目".into()),
        };
        if kind == Kind::Dir && size != 0 { return Err("tar 目录携带数据".into()); }
        let path = relative(&path_text, kind == Kind::Dir)?;
        let key = registry.add(&path, kind == Kind::Dir)?;
        let link_target = if kind == Kind::Link {
            if link_text.is_empty() || link_text.len() > PATH_LIMIT { return Err("tar 符号链接目标无效".into()); }
            Some(link_text)
        } else { None };
        if kind == Kind::Link && size != 0 { return Err("tar 符号链接携带文件数据".into()); }
        if kind == Kind::File {
            let end = data_start.checked_add(padded_tar(size)?).filter(|n| *n <= length).ok_or("tar PAX size 数据越界")?;
            plans.push(EntryPlan { path, key, kind, size, mode: mode & 0o777, data_offset: data_start, link_target, zip_index: None });
            at = end;
        } else {
            plans.push(EntryPlan { path, key, kind, size: 0, mode: mode & 0o777, data_offset: data_start, link_target, zip_index: None });
            at = raw_end;
        }
        local = Pax::default(); long_name = None; long_link = None;
    }
    if !saw_end { return Err("tar 缺少结束标记或被截断".into()); }
    let regular_total = plans.iter().filter(|p| p.kind == Kind::File).try_fold(0u64, |sum, p| sum.checked_add(p.size).filter(|n| *n <= TOTAL_LIMIT).ok_or("Java tar 普通文件总量超过 2 GiB"))?;
    resolve_links(&mut plans, regular_total)?;
    Ok(plans)
}

fn resolve_links(plans: &mut [EntryPlan], initial_total: u64) -> Result<()> {
    let files: BTreeMap<String, usize> = plans.iter().enumerate().filter(|(_, p)| p.kind == Kind::File).map(|(i, p)| (p.key.clone(), i)).collect();
    let links: BTreeMap<String, usize> = plans.iter().enumerate().filter(|(_, p)| p.kind == Kind::Link).map(|(i, p)| (p.key.clone(), i)).collect();
    fn resolve(index: usize, plans: &[EntryPlan], files: &BTreeMap<String, usize>, links: &BTreeMap<String, usize>, stack: &mut BTreeSet<usize>, depth: usize) -> Result<usize> {
        if depth > LINK_DEPTH_LIMIT { return Err("Java 符号链接深度超过 32".into()); }
        if !stack.insert(index) { return Err("Java 符号链接形成循环".into()); }
        let target = plans[index].link_target.as_deref().ok_or("Java 符号链接缺少目标")?;
        let normalized = normalized_target(plans[index].path.parent().unwrap_or(Path::new("")), target)?;
        let key = normalized.to_str().ok_or("Java 链接目标不是 UTF-8")?.replace('\\', "/").to_lowercase();
        let found = if let Some(&target_index) = files.get(&key) { target_index }
        else if let Some(&link_index) = links.get(&key) { resolve(link_index, plans, files, links, stack, depth + 1)? }
        else { return Err("Java 符号链接必须指向归档内的普通文件".into()); };
        stack.remove(&index);
        Ok(found)
    }
    let mut total = initial_total;
    for index in 0..plans.len() {
        if plans[index].kind == Kind::Link {
            let target = resolve(index, plans, &files, &links, &mut BTreeSet::new(), 0)?;
            plans[index].data_offset = plans[target].data_offset;
            plans[index].size = plans[target].size;
            plans[index].mode = plans[target].mode & 0o777;
            plans[index].zip_index = plans[target].zip_index;
            total = total.checked_add(plans[index].size).filter(|n| *n <= TOTAL_LIMIT).ok_or("Java 链接物化后总量超过 2 GiB")?;
        }
    }
    if total > TOTAL_LIMIT { return Err("Java JRE 解包总量超过 2 GiB".into()); }
    Ok(())
}

struct CancelReader<'a> { file: File, token: &'a crate::downloads::Cancel }
impl Read for CancelReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.token.check().map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
        let length = buffer.len().min(IO_CHUNK);
        self.file.read(&mut buffer[..length])
    }
}

#[derive(PartialEq, Eq)]
struct FileIdentity(u64, u64);

#[cfg(unix)]
fn file_identity(file: &File) -> io::Result<FileIdentity> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata()?;
    Ok(FileIdentity(meta.dev(), meta.ino()))
}

#[cfg(windows)]
fn file_identity(file: &File) -> io::Result<FileIdentity> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    #[derive(Default)]
    struct Information {
        attributes: u32, created: [u32; 2], accessed: [u32; 2], written: [u32; 2],
        volume: u32, size_high: u32, size_low: u32, links: u32, index_high: u32, index_low: u32,
    }
    #[link(name = "kernel32")]
    extern "system" { fn GetFileInformationByHandle(handle: *mut std::ffi::c_void, information: *mut Information) -> i32; }
    let mut information = Information::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(FileIdentity(information.volume as u64, ((information.index_high as u64) << 32) | information.index_low as u64))
}

#[cfg(not(any(unix, windows)))]
fn file_identity(_: &File) -> io::Result<FileIdentity> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "此平台不能确认临时文件身份"))
}

struct Spool { path: PathBuf, file: Option<File>, identity: FileIdentity }
impl Spool {
    fn file(&self) -> &File { self.file.as_ref().expect("spool file open") }
    fn file_mut(&mut self) -> &mut File { self.file.as_mut().expect("spool file open") }
    fn new() -> Result<Self> {
        for _ in 0..16 {
            let path = std::env::temp_dir().join(format!("hcmcl-java-tar-{}.tmp", uuid::Uuid::new_v4()));
            let mut options = OpenOptions::new(); options.write(true).read(true).create_new(true);
            #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
            match options.open(&path) {
                Ok(file) => {
                    let identity = file_identity(&file).map_err(|_| "无法确认 Java tar 临时文件身份")?;
                    return Ok(Self { path, file: Some(file), identity });
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err("无法创建 Java tar 临时文件".into()),
            }
        }
        Err("无法占用 Java tar 临时文件名".into())
    }
}
impl Drop for Spool {
    fn drop(&mut self) {
        // Windows 必须先关闭创建句柄；同名文件已被替换时绝不删除替代物。
        self.file.take();
        let owned = fs::symlink_metadata(&self.path).ok()
            .filter(|meta| meta.is_file() && reject_reparse(meta).is_ok())
            .and_then(|_| File::open(&self.path).ok())
            .and_then(|file| file_identity(&file).ok())
            .map(|identity| identity == self.identity).unwrap_or(false);
        if owned { let _ = fs::remove_file(&self.path); }
    }
}

fn spool_tar(path: &Path, token: &crate::downloads::Cancel) -> Result<Spool> {
    let input = checked_archive(path)?;
    let reader = CancelReader { file: input, token };
    let mut decoder = flate2::read::MultiGzDecoder::new(BufReader::new(reader)).take(TAR_STREAM_LIMIT + 1);
    let mut spool = Spool::new()?; let mut total = 0u64; let mut buf = [0u8; IO_CHUNK];
    loop {
        cancel(token)?;
        let n = decoder.read(&mut buf).map_err(|_| "Java tar.gz 解压、gzip 头或校验和无效")?;
        if n == 0 { break; }
        total = total.checked_add(n as u64).filter(|v| *v <= TAR_STREAM_LIMIT).ok_or("Java tar.gz 解压流超过预算")?;
        spool.file_mut().write_all(&buf[..n]).map_err(|_| "写入 Java tar 临时文件失败")?;
    }
    cancel(token)?;
    spool.file_mut().flush().map_err(|_| "刷新 Java tar 临时文件失败")?;
    spool.file_mut().seek(SeekFrom::Start(0)).map_err(|_| "无法重读 Java tar 临时文件")?;
    Ok(spool)
}

fn ensure_output_parent(root: &Path, relative: &Path) -> Result<PathBuf> {
    let mut current = root.to_path_buf();
    let parent = relative.parent().ok_or("Java 输出路径没有父目录")?;
    for component in parent.components() {
        let Component::Normal(part) = component else { return Err("Java 输出路径含跳转".into()); };
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(meta) => { reject_reparse(&meta)?; if !meta.is_dir() { return Err("Java 输出父路径不是目录".into()); } }
            Err(e) if e.kind() == io::ErrorKind::NotFound => fs::create_dir(&current).map_err(|_| "无法创建 Java 输出目录")?,
            Err(_) => return Err("无法验证 Java 输出路径".into()),
        }
    }
    Ok(root.join(relative))
}

fn set_mode(path: &Path, mode: u32) -> Result<()> {
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, Permissions::from_mode(mode & 0o777)).map_err(|_| "无法设置 Java 文件权限")?;
    }
    #[cfg(not(unix))] { let _ = (path, mode); }
    Ok(())
}

fn write_plan<R: Read + Seek>(mut archive: Option<&mut ZipArchive<R>>, mut spool: Option<&mut File>, root: &Path, plans: &[EntryPlan], token: &crate::downloads::Cancel) -> Result<()> {
    let mut directories: BTreeMap<PathBuf, u32> = BTreeMap::new();
    for plan in plans {
        cancel(token)?;
        if plan.kind == Kind::Dir {
            let target = ensure_output_parent(root, &plan.path)?;
            match fs::symlink_metadata(&target) {
                Ok(meta) => { reject_reparse(&meta)?; if !meta.is_dir() { return Err("Java 目录条目与现有文件冲突".into()); } }
                Err(e) if e.kind() == io::ErrorKind::NotFound => fs::create_dir(&target).map_err(|_| "无法创建 Java 归档目录")?,
                Err(_) => return Err("无法验证 Java 归档目录".into()),
            }
            directories.insert(plan.path.clone(), plan.mode & 0o777);
            continue;
        }
        let target = ensure_output_parent(root, &plan.path)?;
        let mut options = OpenOptions::new(); options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut output = options.open(&target).map_err(|_| "无法创建 Java 归档文件")?;
        let mut remaining = plan.size;
        let mut buffer = [0u8; IO_CHUNK];
        let mut zip_item = if let Some(archive) = archive.as_deref_mut() {
            Some(archive.by_index(plan.zip_index.ok_or("ZIP 计划索引丢失")?).map_err(|_| "无法重读 Java ZIP 条目")?)
        } else { None };
        if let (Some(file), None) = (spool.as_deref_mut(), zip_item.as_mut()) {
            file.seek(SeekFrom::Start(plan.data_offset)).map_err(|_| "无法定位 Java tar 文件内容")?;
        }
        while remaining > 0 {
            cancel(token)?;
            let wanted = buffer.len().min(remaining as usize);
            let n = if let Some(item) = zip_item.as_mut() { item.read(&mut buffer[..wanted]).map_err(|_| "Java ZIP 解压或 CRC 校验失败")? }
                else { spool.as_deref_mut().ok_or("Java tar 数据源丢失")?.read(&mut buffer[..wanted]).map_err(|_| "读取 Java tar 文件内容失败")? };
            if n == 0 { return Err("Java 归档文件内容短于声明".into()); }
            output.write_all(&buffer[..n]).map_err(|_| "写入 Java payload 失败")?;
            remaining -= n as u64;
        }
        if let Some(item) = zip_item.as_mut() {
            let mut extra = [0u8; 1];
            if item.read(&mut extra).map_err(|_| "Java ZIP CRC 校验失败")? != 0 { return Err("Java ZIP 文件内容超过声明".into()); }
        }
        output.sync_all().map_err(|_| "提交 Java payload 文件失败")?;
        set_mode(&target, plan.mode & 0o777)?;
    }
    let mut dirs: Vec<_> = directories.into_iter().collect(); dirs.sort_by_key(|(path, _)| std::cmp::Reverse(path.components().count()));
    // staging 的拥有者保留遍历与清理能力，归档不能把目录锁成不可清理。
    for (relative, mode) in dirs { cancel(token)?; set_mode(&root.join(relative), mode | 0o700)?; }
    Ok(())
}

/// 完整验证归档后，将普通文件及指向普通文件的内部 symlink 物化到空 payload。
pub(super) fn extract(path: &Path, payload: &Path, cancel_token: &crate::downloads::Cancel) -> std::result::Result<(), String> {
    cancel(cancel_token)?;
    let root = payload_root(payload)?;
    let name = path.file_name().and_then(|v| v.to_str()).ok_or("Java 归档文件名不是 UTF-8")?.to_ascii_lowercase();
    if name.ends_with(".zip") {
        let mut file = checked_archive(path)?;
        let entries = bounded_zip(&mut file, cancel_token)?;
        file.seek(SeekFrom::Start(0)).map_err(|_| "无法重置 Java ZIP")?;
        let mut archive = ZipArchive::new(file).map_err(|_| "Java ZIP 目录无效")?;
        let plans = validate_zip_content(&mut archive, &entries, cancel_token)?;
        cancel(cancel_token)?;
        write_plan(Some(&mut archive), None, &root, &plans, cancel_token)
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        let mut spool = spool_tar(path, cancel_token)?;
        let length = spool.file().metadata().map_err(|_| "无法读取 Java tar 临时文件")?.len();
        let plans = parse_tar(spool.file_mut(), length, cancel_token)?;
        cancel(cancel_token)?;
        write_plan::<File>(None, Some(spool.file_mut()), &root, &plans, cancel_token)
    } else {
        Err("Java 归档格式只支持 ZIP、tar.gz 与 tgz".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use zip::{write::FileOptions, ZipWriter};

    struct Fixture { root: PathBuf }
    impl Fixture {
        fn new() -> Self {
            let base = fs::canonicalize(std::env::temp_dir()).unwrap();
            let root = base.join(format!("hcmcl-java-archive-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            Self { root }
        }
        fn payload(&self, name: &str) -> PathBuf {
            let root = self.root.join(name); fs::create_dir(&root).unwrap(); root
        }
        fn archive(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let path = self.root.join(name); fs::write(&path, bytes).unwrap(); path
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); } }

    fn options(mode: u32) -> FileOptions {
        FileOptions::default().compression_method(CompressionMethod::Deflated).unix_permissions(mode)
    }
    fn zip_bytes(rows: &[(&str, &[u8], u32)], links: &[(&str, &str)]) -> Vec<u8> {
        let mut writer = ZipWriter::new(io::Cursor::new(Vec::new()));
        for &(name, bytes, mode) in rows {
            if name.ends_with('/') { writer.add_directory(name, options(mode)).unwrap(); }
            else { writer.start_file(name, options(mode)).unwrap(); writer.write_all(bytes).unwrap(); }
        }
        for &(name, target) in links { writer.add_symlink(name, target, options(0o777)).unwrap(); }
        writer.finish().unwrap().into_inner()
    }
    // 用真实 tar 头构造任意名称，使恶意路径夹具不会被 Builder 提前拒绝。
    fn tar_entry(bytes: &mut Vec<u8>, name: &str, data: &[u8], kind: u8, target: &str, mode: u32) {
        assert!(name.len() <= 100 && target.len() <= 100);
        let mut header = tar::Header::new_gnu();
        header.set_size(data.len() as u64); header.set_mode(mode);
        header.set_uid(0); header.set_gid(0); header.set_mtime(0);
        header.set_entry_type(tar::EntryType::new(kind));
        header.as_mut_bytes()[..100].fill(0);
        header.as_mut_bytes()[..name.len()].copy_from_slice(name.as_bytes());
        header.as_mut_bytes()[157..257].fill(0);
        header.as_mut_bytes()[157..157 + target.len()].copy_from_slice(target.as_bytes());
        header.set_cksum(); bytes.extend_from_slice(header.as_bytes()); bytes.extend_from_slice(data);
        bytes.resize((bytes.len() + 511) & !511, 0);
    }
    fn gzip(mut tar: Vec<u8>) -> Vec<u8> {
        tar.extend_from_slice(&[0; 1024]);
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&tar).unwrap(); encoder.finish().unwrap()
    }
    fn empty(path: &Path) { assert_eq!(fs::read_dir(path).unwrap().count(), 0); }
    fn rejected(fixture: &Fixture, name: &str, bytes: &[u8]) {
        let archive = fixture.archive(name, bytes);
        let payload = fixture.payload(&format!("out-{}", uuid::Uuid::new_v4()));
        assert!(extract(&archive, &payload, &crate::downloads::Cancel::default()).is_err());
        empty(&payload);
    }
    #[cfg(unix)]
    fn executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(path).unwrap().permissions().mode();
        assert_ne!(mode & 0o111, 0); assert_eq!(mode & 0o7000, 0);
    }
    #[cfg(not(unix))]
    fn executable(_: &Path) {}

    #[test]
    fn zip_regular_unicode_and_internal_file_link() {
        let fixture = Fixture::new();
        let archive = fixture.archive("jre.zip", &zip_bytes(&[("jre/", b"", 0o755), ("jre/bin/java", b"java fixture", 0o755), ("jre/说明.txt", b"utf8", 0o644)], &[("jre/bin/java-copy", "java")]));
        let payload = fixture.payload("payload");
        extract(&archive, &payload, &crate::downloads::Cancel::default()).unwrap();
        assert_eq!(fs::read(payload.join("jre/bin/java-copy")).unwrap(), b"java fixture");
        assert!(!fs::symlink_metadata(payload.join("jre/bin/java-copy")).unwrap().file_type().is_symlink());
        assert_eq!(fs::read(payload.join("jre/说明.txt")).unwrap(), b"utf8");
        executable(&payload.join("jre/bin/java")); executable(&payload.join("jre/bin/java-copy"));
    }

    #[test]
    fn gzip_tar_regular_forward_file_link_and_execute_mode() {
        let fixture = Fixture::new(); let mut tar = Vec::new();
        tar_entry(&mut tar, "jre/bin/copy", b"", b'2', "java", 0o777);
        tar_entry(&mut tar, "jre/bin/java", b"java fixture", b'0', "", 0o6755);
        tar_entry(&mut tar, "jre/empty/", b"", b'5', "", 0);
        let archive = fixture.archive("jre.tar.gz", &gzip(tar)); let payload = fixture.payload("payload");
        extract(&archive, &payload, &crate::downloads::Cancel::default()).unwrap();
        assert_eq!(fs::read(payload.join("jre/bin/copy")).unwrap(), b"java fixture");
        assert!(!fs::symlink_metadata(payload.join("jre/bin/copy")).unwrap().file_type().is_symlink());
        assert!(payload.join("jre/empty").is_dir());
        executable(&payload.join("jre/bin/java")); executable(&payload.join("jre/bin/copy"));
    }

    #[test]
    fn late_unsafe_entries_leave_payload_empty() {
        let fixture = Fixture::new();
        for (index, bad) in ["../outside", "/absolute", "C:/drive", "jre/file:ads", "jre/CON", "jre\\alias"].iter().enumerate() {
            rejected(&fixture, &format!("bad-{index}.zip"), &zip_bytes(&[("jre/good", b"first", 0o644), (bad, b"bad", 0o644)], &[]));
            let mut tar = Vec::new(); tar_entry(&mut tar, "jre/good", b"first", b'0', "", 0o644);
            tar_entry(&mut tar, bad, b"bad", b'0', "", 0o644);
            rejected(&fixture, &format!("bad-{index}.tgz"), &gzip(tar));
        }
        assert!(!fixture.root.join("outside").exists());
    }

    #[test]
    fn link_cycles_escape_missing_and_directory_links_are_rejected() {
        let fixture = Fixture::new();
        rejected(&fixture, "cycle.zip", &zip_bytes(&[("jre/good", b"good", 0o644)], &[("jre/a", "b"), ("jre/b", "a")]));
        for (index, target) in ["b", "../../outside", "missing", "dir"].iter().enumerate() {
            let mut tar = Vec::new(); tar_entry(&mut tar, "jre/good", b"good", b'0', "", 0o644);
            tar_entry(&mut tar, "jre/dir/", b"", b'5', "", 0o755);
            tar_entry(&mut tar, "jre/a", b"", b'2', target, 0o777);
            if *target == "b" { tar_entry(&mut tar, "jre/b", b"", b'2', "a", 0o777); }
            rejected(&fixture, &format!("links-{index}.tgz"), &gzip(tar));
        }
        for kind in [b'1', b'3', b'4', b'6'] {
            let mut tar = Vec::new(); tar_entry(&mut tar, "jre/good", b"good", b'0', "", 0o644);
            tar_entry(&mut tar, "jre/special", b"", kind, "jre/good", 0o644);
            rejected(&fixture, &format!("special-{kind}.tgz"), &gzip(tar));
        }
    }

    #[test]
    fn gnu_long_path_and_pax_path_are_bounded_and_supported() {
        let fixture = Fixture::new(); let mut tar = Vec::new();
        let long = format!("jre/{}libjava.so", "segment/".repeat(14));
        let mut long_bytes = long.as_bytes().to_vec(); long_bytes.push(0);
        tar_entry(&mut tar, "././@LongLink", &long_bytes, b'L', "", 0o644);
        tar_entry(&mut tar, "placeholder", b"gnu", b'0', "", 0o755);
        let body = "path=jre/pax.txt\n";
        let mut length = body.len() + 2;
        loop { let next = length.to_string().len() + 1 + body.len(); if next == length { break; } length = next; }
        let record = format!("{length} {body}");
        tar_entry(&mut tar, "PaxHeader", record.as_bytes(), b'x', "", 0o644);
        tar_entry(&mut tar, "placeholder2", b"pax", b'0', "", 0o644);
        let archive = fixture.archive("extensions.tgz", &gzip(tar)); let payload = fixture.payload("payload");
        extract(&archive, &payload, &crate::downloads::Cancel::default()).unwrap();
        assert_eq!(fs::read(payload.join(long)).unwrap(), b"gnu");
        assert_eq!(fs::read(payload.join("jre/pax.txt")).unwrap(), b"pax");
    }

    #[test]
    fn gzip_corruption_and_header_bomb_are_rejected_before_output() {
        let fixture = Fixture::new(); let mut tar = Vec::new();
        tar_entry(&mut tar, "jre/bin/java", b"fixture", b'0', "", 0o755);
        let valid = gzip(tar);
        let mut bad_crc = valid.clone(); let crc_at = bad_crc.len() - 8; bad_crc[crc_at] ^= 1;
        rejected(&fixture, "crc.tgz", &bad_crc);
        rejected(&fixture, "truncated.tgz", &valid[..valid.len() - 4]);
        let mut name_bomb = vec![0x1f, 0x8b, 8, 8, 0, 0, 0, 0, 0, 255];
        name_bomb.extend(std::iter::repeat(b'x').take(65_536));
        rejected(&fixture, "header.tgz", &name_bomb);
        let mut central_bomb = zip_bytes(&[("jre/good", b"good", 0o644)], &[]);
        let end = central_bomb.len() - 22;
        central_bomb[end + 12..end + 16].copy_from_slice(&((ZIP_CENTRAL_LIMIT + 1) as u32).to_le_bytes());
        rejected(&fixture, "central.zip", &central_bomb);
    }

    #[test]
    fn pre_cancel_and_nonempty_payload_preserve_existing_files() {
        let fixture = Fixture::new();
        let archive = fixture.archive("jre.zip", &zip_bytes(&[("jre/java", b"fixture", 0o755)], &[]));
        let payload = fixture.payload("cancelled"); let stopped = crate::downloads::Cancel::default(); stopped.stop();
        assert!(extract(&archive, &payload, &stopped).is_err()); empty(&payload);
        let occupied = fixture.payload("occupied"); fs::write(occupied.join("owned"), b"keep").unwrap();
        assert!(extract(&archive, &occupied, &crate::downloads::Cancel::default()).is_err());
        assert_eq!(fs::read(occupied.join("owned")).unwrap(), b"keep");
    }

    #[test]
    fn spool_drop_closes_handle_and_preserves_replaced_file() {
        let mut spool = Spool::new().unwrap(); let path = spool.path.clone();
        spool.file_mut().write_all(b"spool").unwrap(); drop(spool); assert!(!path.exists());
        let fixture = Fixture::new(); let spool = Spool::new().unwrap(); let path = spool.path.clone();
        let displaced = fixture.root.join("original-spool"); fs::rename(&path, &displaced).unwrap();
        fs::write(&path, b"replacement").unwrap(); drop(spool);
        assert_eq!(fs::read(&path).unwrap(), b"replacement"); fs::remove_file(path).unwrap();
    }
}

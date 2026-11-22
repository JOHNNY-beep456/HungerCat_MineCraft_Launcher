//! 本地模组名称：只读有界 ZIP 目录与元数据，不提取其它文件。
use super::Result;
use flate2::{Crc, Decompress, FlushDecompress, Status};
use serde_json::Value;
use std::collections::BTreeSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

#[allow(dead_code)]
#[path = "../modpack/access.rs"]
mod access;

const EOCD_BYTES: usize = 22;
const CENTRAL_HEADER_BYTES: usize = 46;
const LOCAL_HEADER_BYTES: usize = 30;
const MAX_CENTRAL_BYTES: usize = 8 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 50_000;
const MAX_ENTRY_NAME_BYTES: usize = 1024;
const MAX_METADATA_ENTRIES: usize = 16;
const MAX_METADATA_BYTES: usize = 256 * 1024;
const MAX_COMPRESSED_METADATA_BYTES: usize = 512 * 1024;
const MAX_TOML_MODS: usize = 64;
const MAX_NAME_CHARS: usize = 256;
const DATA_DESCRIPTOR: u16 = 1 << 3;
// 仅允许 deflate 压缩级别提示、数据描述符和 UTF-8 标志，不支持加密等扩展。
const ALLOWED_FLAGS: u16 = 0x080e;

#[derive(Clone, Copy)]
enum Format {
    Fabric,
    Quilt,
    Forge,
}

struct Member {
    name: Vec<u8>,
    offset: u64,
    flags: u16,
    method: u16,
    crc: u32,
    compressed: u32,
    size: u32,
}

fn word(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn dword(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn read_at(reader: &mut (impl Read + Seek), offset: u64, size: usize) -> Option<Vec<u8>> {
    reader.seek(SeekFrom::Start(offset)).ok()?;
    let mut bytes = vec![0; size];
    reader.read_exact(&mut bytes).ok()?;
    Some(bytes)
}

fn candidate(raw: &[u8]) -> Option<(Format, &str)> {
    if raw.len() > MAX_ENTRY_NAME_BYTES {
        return None;
    }
    let name = std::str::from_utf8(raw).ok()?;
    let name = name.strip_prefix("./").unwrap_or(name);
    let basename = name.rsplit('/').next()?;
    let format = match basename {
        "fabric.mod.json" => Format::Fabric,
        "quilt.mod.json" => Format::Quilt,
        _ if basename.eq_ignore_ascii_case("mods.toml")
            || basename.eq_ignore_ascii_case("neoforge.mods.toml") =>
        {
            Format::Forge
        }
        _ => return None,
    };
    if name
        .chars()
        .any(|c| c.is_control() || matches!(c, '\\' | ':'))
        || name.split('/').any(|part| matches!(part, "" | "." | ".."))
    {
        return None;
    }
    Some((format, name))
}

fn safe_extra(mut bytes: &[u8]) -> bool {
    while !bytes.is_empty() {
        let Some(header) = bytes.get(..4) else {
            return false;
        };
        // 不处理 ZIP64、Unix 链接或 AES 扩展。
        if matches!(word(header, 0), 0x0001 | 0x000d | 0x756e | 0x9901) {
            return false;
        }
        let Some(rest) = bytes.get(4 + word(header, 2) as usize..) else {
            return false;
        };
        bytes = rest;
    }
    true
}

fn metadata_directory(
    reader: &mut (impl Read + Seek),
    len: u64,
) -> Option<(u64, [Option<Member>; 3])> {
    if !(EOCD_BYTES as u64..=super::FILE_CAP).contains(&len) {
        return None;
    }
    // zip 0.6 会在返回条目数前分配整个目录。这里直接读取有界 ZIP32 目录，
    // 不把 ZIP64、多卷或长度不自洽的目录交给解压器。
    let tail_start = len.saturating_sub((EOCD_BYTES + u16::MAX as usize) as u64);
    let tail = read_at(reader, tail_start, (len - tail_start) as usize)?;
    let mut endings = (0..=tail.len() - EOCD_BYTES).rev().filter(|&at| {
        tail[at..].starts_with(b"PK\x05\x06")
            && at + EOCD_BYTES + word(&tail[at..], 20) as usize == tail.len()
    });
    let at = endings.next()?;
    if endings.next().is_some() {
        return None;
    }
    let end = &tail[at..];
    let count = word(end, 10) as usize;
    let size = dword(end, 12) as usize;
    let start = u64::from(dword(end, 16));
    if word(end, 4) != 0
        || word(end, 6) != 0
        || word(end, 8) as usize != count
        || count == 0
        || count > MAX_ARCHIVE_ENTRIES
        || size > MAX_CENTRAL_BYTES
        || size < count * CENTRAL_HEADER_BYTES
        || start + size as u64 != tail_start + at as u64
    {
        return None;
    }
    let central = read_at(reader, start, size)?;
    let mut rest = central.as_slice();
    let mut names = BTreeSet::new();
    let mut members: [Option<Member>; 3] = [None, None, None];
    let mut seen_format = [false; 3];
    for _ in 0..count {
        let header = rest.get(..CENTRAL_HEADER_BYTES)?;
        if !header.starts_with(b"PK\x01\x02") {
            return None;
        }
        let name_end = CENTRAL_HEADER_BYTES + word(header, 28) as usize;
        let extra_end = name_end + word(header, 30) as usize;
        let raw = rest.get(CENTRAL_HEADER_BYTES..name_end)?;
        let extra = rest.get(name_end..extra_end)?;
        rest = rest.get(extra_end + word(header, 32) as usize..)?;
        let Some((format, normalized)) = candidate(raw) else {
            continue;
        };
        if names.len() >= MAX_METADATA_ENTRIES || !names.insert(normalized.to_ascii_lowercase()) {
            return None;
        }
        let slot = format as usize;
        if seen_format[slot] {
            continue;
        }
        // 同类元数据沿用 Electron 的目录顺序，只尝试第一个匹配项。
        seen_format[slot] = true;
        let flags = word(header, 8);
        let method = word(header, 10);
        let attrs = dword(header, 38);
        let compressed = dword(header, 20);
        let size = dword(header, 24);
        let offset = u64::from(dword(header, 42));
        if word(header, 34) != 0
            || flags & !ALLOWED_FLAGS != 0
            || !matches!(method, 0 | 8)
            || attrs & 0x410 != 0
            || !matches!((attrs >> 16) & 0o170000, 0 | 0o100000)
            || !safe_extra(extra)
            || compressed as usize > MAX_COMPRESSED_METADATA_BYTES
            || size as usize > MAX_METADATA_BYTES
            || (method == 0 && compressed != size)
            || offset + LOCAL_HEADER_BYTES as u64 > start
        {
            continue;
        }
        members[slot] = Some(Member {
            name: raw.to_vec(),
            offset,
            flags,
            method,
            crc: dword(header, 16),
            compressed,
            size,
        });
    }
    rest.is_empty().then_some((start, members))
}

fn metadata_bytes(
    reader: &mut (impl Read + Seek),
    directory_start: u64,
    member: &Member,
) -> Option<Vec<u8>> {
    let local = read_at(reader, member.offset, LOCAL_HEADER_BYTES)?;
    if !local.starts_with(b"PK\x03\x04")
        || word(&local, 6) != member.flags
        || word(&local, 8) != member.method
        || word(&local, 26) as usize != member.name.len()
    {
        return None;
    }
    // Java 的 ZIP 输出可将本地 CRC 和长度留空，实际数值以中央目录为准。
    for (at, expected) in [(14, member.crc), (18, member.compressed), (22, member.size)] {
        let declared = dword(&local, at);
        if declared != expected && !(declared == 0 && member.flags & DATA_DESCRIPTOR != 0) {
            return None;
        }
    }
    let header_end = member.offset + LOCAL_HEADER_BYTES as u64;
    let extra_len = word(&local, 28) as usize;
    let payload = header_end + (member.name.len() + extra_len) as u64;
    let payload_end = payload + u64::from(member.compressed);
    if payload_end > directory_start {
        return None;
    }
    let name_and_extra = read_at(reader, header_end, member.name.len() + extra_len)?;
    if !name_and_extra.starts_with(&member.name)
        || !safe_extra(&name_and_extra[member.name.len()..])
    {
        return None;
    }
    if member.flags & DATA_DESCRIPTOR != 0 {
        let descriptor = read_at(
            reader,
            payload_end,
            (directory_start - payload_end).min(16) as usize,
        )?;
        let matches_member = |bytes: &[u8]| {
            bytes.len() >= 12
                && [dword(bytes, 0), dword(bytes, 4), dword(bytes, 8)]
                    == [member.crc, member.compressed, member.size]
        };
        if !matches_member(&descriptor)
            && !descriptor
                .strip_prefix(b"PK\x07\x08")
                .is_some_and(matches_member)
        {
            return None;
        }
    }
    let compressed = read_at(reader, payload, member.compressed as usize)?;
    let bytes = if member.method == 0 {
        compressed
    } else {
        // 输入与输出均受限；多给一个字节，能识别比声明长度更大的解压结果。
        let mut decoder = Decompress::new(false);
        let mut output = vec![0; member.size as usize + 1];
        if decoder
            .decompress(&compressed, &mut output, FlushDecompress::Finish)
            .ok()?
            != Status::StreamEnd
            || decoder.total_in() != u64::from(member.compressed)
            || decoder.total_out() != u64::from(member.size)
        {
            return None;
        }
        output.truncate(member.size as usize);
        output
    };
    let mut crc = Crc::new();
    crc.update(&bytes);
    (crc.sum() == member.crc).then_some(bytes)
}

fn safe_name(raw: &str) -> Option<String> {
    if raw.len() > MAX_NAME_CHARS * 4
        || raw.trim().is_empty()
        || raw.chars().count() > MAX_NAME_CHARS
        || raw
            .chars()
            .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
    {
        return None;
    }
    Some(raw.to_owned())
}

fn json_name(text: &str, format: Format) -> Option<Option<String>> {
    let value = serde_json::from_str::<Value>(text).ok()?;
    let loader = if matches!(format, Format::Quilt) {
        value.get("quilt_loader")?
    } else {
        &value
    };
    let name = loader
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| loader.get("metadata")?.get("name").and_then(Value::as_str))
        .unwrap_or("");
    let has_id = loader
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty());
    // 有 ID 但无可用名称时用文件名；不把 ID 或更低优先级的元数据当成名称。
    (has_id || !name.is_empty()).then(|| safe_name(name))
}

fn toml_name(text: &str) -> Option<String> {
    let value = toml::from_str::<toml::Value>(text).ok()?;
    let mods = value.get("mods")?.as_array()?;
    if mods.len() > MAX_TOML_MODS {
        return None;
    }
    let first = mods.iter().find_map(|item| {
        item.get("displayName")?
            .as_str()
            .filter(|name| !name.is_empty())
    })?;
    safe_name(first)
}

fn read_name(reader: &mut (impl Read + Seek), len: u64) -> Option<String> {
    let (directory_start, members) = metadata_directory(reader, len)?;
    for (format, member) in [Format::Fabric, Format::Quilt, Format::Forge]
        .into_iter()
        .zip(members)
    {
        let Some(bytes) =
            member.and_then(|member| metadata_bytes(reader, directory_start, &member))
        else {
            continue;
        };
        let Ok(text) = std::str::from_utf8(&bytes) else {
            continue;
        };
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        match format {
            Format::Forge => return toml_name(text),
            _ => {
                if let Some(name) = json_name(text, format) {
                    return name;
                }
            }
        }
    }
    None
}

fn identity_text(raw: &str, max_chars: usize) -> Option<&str> {
    if raw.len() > max_chars * 4 || raw.chars().count() > max_chars || raw.chars().any(char::is_control) { return None; }
    Some(raw)
}

fn json_identity(text: &str, format: Format) -> Option<(String, String)> {
    let value = serde_json::from_str::<Value>(text).ok()?;
    let loader = if matches!(format, Format::Quilt) { value.get("quilt_loader")? } else { &value };
    let id = loader.get("id").and_then(Value::as_str).filter(|id| !id.is_empty())?;
    let id = identity_text(id, 128)?.to_owned();
    let name = loader.get("name").and_then(Value::as_str)
        .or_else(|| loader.get("metadata")?.get("name").and_then(Value::as_str))
        .unwrap_or("");
    let name = identity_text(name, MAX_NAME_CHARS).unwrap_or("").to_owned();
    Some((id, name))
}

fn toml_identity(text: &str) -> Option<(String, String)> {
    let value = toml::from_str::<toml::Value>(text).ok()?;
    let mods = value.get("mods")?.as_array()?;
    if mods.len() > MAX_TOML_MODS { return None; }
    let first = mods.first()?;
    let id = first.get("modId").and_then(toml::Value::as_str).filter(|id| !id.is_empty())?;
    let id = identity_text(id, 128)?.to_owned();
    let name = first.get("displayName").and_then(toml::Value::as_str).unwrap_or("");
    let name = identity_text(name, MAX_NAME_CHARS).unwrap_or("").to_owned();
    Some((id, name))
}

fn read_identity(reader: &mut (impl Read + Seek), len: u64) -> Option<(String, String)> {
    let (directory_start, members) = metadata_directory(reader, len)?;
    for (format, member) in [Format::Fabric, Format::Quilt, Format::Forge]
        .into_iter()
        .zip(members)
    {
        let Some(bytes) =
            member.and_then(|member| metadata_bytes(reader, directory_start, &member))
        else {
            continue;
        };
        let Ok(text) = std::str::from_utf8(&bytes) else {
            continue;
        };
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        let found = match format {
            Format::Forge => toml_identity(text),
            other => json_identity(text, other),
        };
        if found.is_some() { return found; }
    }
    None
}

/// 联网补齐用的模组身份：(id, name)。id 来自 fabric/quilt 的 id 或 forge 的 modId。
pub(super) fn mod_identity(path: &Path, len: u64) -> Option<(String, String)> {
    if !(EOCD_BYTES as u64..=super::FILE_CAP).contains(&len) {
        return None;
    }
    let mut opened = access::OpenedFile::open(path).ok()?;
    if opened.file.metadata().ok()?.len() != len {
        return None;
    }
    let identity = read_identity(&mut opened.file, len)?;
    opened.verify().ok()?;
    Some(identity)
}

pub(super) fn display_name(path: &Path, len: u64) -> Option<String> {
    if !(EOCD_BYTES as u64..=super::FILE_CAP).contains(&len) {
        return None;
    }
    let mut opened = access::OpenedFile::open(path).ok()?;
    if opened.file.metadata().ok()?.len() != len {
        return None;
    }
    let name = read_name(&mut opened.file, len)?;
    opened.verify().ok()?;
    Some(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use zip::{write::FileOptions, CompressionMethod, ZipWriter};

    const FABRIC: &[u8] = br#"{"id":"fabric-example","name":"Fabric Name"}"#;
    const QUILT: &[u8] =
        br#"{"quilt_loader":{"id":"quilt-example","metadata":{"name":"Quilt Name"}}}"#;
    const FORGE: &[u8] = r#"
# displayName = "注释"
[[dependencies.example]]
modId = "dependency"
displayName = "依赖"
[[mods]]
modId = "example"
displayName = 'Forge Name'
[[mods]]
modId = "other"
displayName = "Other"
"#
    .as_bytes();

    fn archive(compression: CompressionMethod, entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        for &(name, bytes) in entries {
            zip.start_file(name, FileOptions::default().compression_method(compression))
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    fn name_of(bytes: &[u8]) -> Option<String> {
        read_name(&mut Cursor::new(bytes), bytes.len() as u64)
    }

    fn central_offset(bytes: &[u8]) -> usize {
        dword(bytes, bytes.len() - EOCD_BYTES + 16) as usize
    }

    #[test]
    fn mod_metadata_reads_fabric_quilt_forge_and_neoforge() {
        let fabric_bom = "\u{feff}{\"name\":\"中文模组 🐱\"}";
        let neo = br#"[[mods]]
modId = "example"
displayName = "NeoForge \"Name\""
"#;
        for (path, bytes, expected) in [
            ("fabric.mod.json", fabric_bom.as_bytes(), "中文模组 🐱"),
            ("./bundle/quilt.mod.json", QUILT, "Quilt Name"),
            ("META-INF/mods.toml", FORGE, "Forge Name"),
            (
                "META-INF/NeoForge.Mods.TOML",
                neo.as_slice(),
                "NeoForge \"Name\"",
            ),
        ] {
            for compression in [CompressionMethod::Stored, CompressionMethod::Deflated] {
                assert_eq!(
                    name_of(&archive(compression, &[(path, bytes)])).as_deref(),
                    Some(expected),
                    "{path}"
                );
            }
        }
    }

    #[test]
    fn mod_metadata_keeps_loader_precedence_and_does_not_use_ids_as_names() {
        let name = |fabric| {
            name_of(&archive(
                CompressionMethod::Stored,
                &[
                    ("META-INF/mods.toml", FORGE),
                    ("quilt.mod.json", QUILT),
                    ("fabric.mod.json", fabric),
                ],
            ))
        };
        assert_eq!(name(FABRIC).as_deref(), Some("Fabric Name"));
        assert_eq!(name(b"broken JSON").as_deref(), Some("Quilt Name"));
        assert_eq!(name(br#"{"id":"only-an-id"}"#), None);
        let malformed = archive(
            CompressionMethod::Stored,
            &[(
                "META-INF/mods.toml",
                b"[[mods]]\ndisplayName = \"Decoy\"\ninvalid",
            )],
        );
        assert_eq!(name_of(&malformed), None);
    }

    #[test]
    fn mod_metadata_skips_unsafe_members_and_rejects_duplicate_candidates() {
        for path in [
            "../fabric.mod.json",
            "nested/../fabric.mod.json",
            "/fabric.mod.json",
            "C:/fabric.mod.json",
            "unsafe\\path/fabric.mod.json",
        ] {
            let bytes = archive(
                CompressionMethod::Stored,
                &[(path, FABRIC), ("quilt.mod.json", QUILT)],
            );
            assert_eq!(name_of(&bytes).as_deref(), Some("Quilt Name"), "{path}");
        }
        let duplicate = archive(
            CompressionMethod::Stored,
            &[("fabric.mod.json", FABRIC), ("./fabric.mod.json", FABRIC)],
        );
        assert_eq!(name_of(&duplicate), None);
        let mut link = archive(CompressionMethod::Stored, &[("fabric.mod.json", FABRIC)]);
        let central = central_offset(&link);
        link[central + 38..central + 42].copy_from_slice(&(0o120777_u32 << 16).to_le_bytes());
        assert_eq!(name_of(&link), None);
    }

    #[test]
    fn mod_metadata_checks_zip32_data_descriptors() {
        let bytes = archive(CompressionMethod::Deflated, &[("fabric.mod.json", FABRIC)]);
        let central = central_offset(&bytes);
        for signature in [false, true] {
            let mut patched = bytes[..central].to_vec();
            patched[6..8].copy_from_slice(&(word(&bytes, 6) | DATA_DESCRIPTOR).to_le_bytes());
            patched[14..26].fill(0);
            if signature {
                patched.extend_from_slice(b"PK\x07\x08");
            }
            let descriptor = patched.len();
            patched.extend_from_slice(&bytes[central + 16..central + 28]);
            let new_central = patched.len();
            patched.extend_from_slice(&bytes[central..]);
            patched[new_central + 8..new_central + 10]
                .copy_from_slice(&(word(&bytes, central + 8) | DATA_DESCRIPTOR).to_le_bytes());
            let end = patched.len() - EOCD_BYTES;
            patched[end + 16..end + 20].copy_from_slice(&(new_central as u32).to_le_bytes());
            assert_eq!(name_of(&patched).as_deref(), Some("Fabric Name"));
            patched[descriptor] ^= 1;
            assert_eq!(name_of(&patched), None);
        }
    }

    #[test]
    fn mod_metadata_rejects_bad_crc_local_name_and_forged_deflate_size() {
        let stored = archive(CompressionMethod::Stored, &[("fabric.mod.json", FABRIC)]);
        let mut bad_crc = stored.clone();
        bad_crc[LOCAL_HEADER_BYTES + "fabric.mod.json".len() + 2] ^= 1;
        assert_eq!(name_of(&bad_crc), None);
        let mut bad_local_name = stored;
        bad_local_name[LOCAL_HEADER_BYTES] = b'X';
        assert_eq!(name_of(&bad_local_name), None);

        let expanded = [FABRIC, &vec![b' '; MAX_METADATA_BYTES / 2]].concat();
        let mut forged = archive(
            CompressionMethod::Deflated,
            &[("fabric.mod.json", &expanded)],
        );
        let central = central_offset(&forged);
        for offset in [22, central + 24] {
            forged[offset..offset + 4].copy_from_slice(&(FABRIC.len() as u32).to_le_bytes());
        }
        assert_eq!(name_of(&forged), None);
    }

    #[test]
    fn mod_metadata_caps_archive_directory_candidate_and_display_name_sizes() {
        let valid = archive(CompressionMethod::Stored, &[("fabric.mod.json", FABRIC)]);
        assert_eq!(
            read_name(&mut Cursor::new(&valid), super::super::FILE_CAP + 1),
            None
        );
        let mut directory = valid.clone();
        let end = directory.len() - EOCD_BYTES;
        directory[end + 12..end + 16]
            .copy_from_slice(&((MAX_CENTRAL_BYTES + 1) as u32).to_le_bytes());
        assert_eq!(name_of(&directory), None);
        let mut many_entries: Vec<(&str, &[u8])> = vec![("ignored", b""); MAX_ARCHIVE_ENTRIES];
        many_entries.insert(0, ("fabric.mod.json", FABRIC));
        assert_eq!(
            name_of(&archive(CompressionMethod::Stored, &many_entries)),
            None
        );

        let paths: Vec<_> = (0..=MAX_METADATA_ENTRIES)
            .map(|i| format!("dir{i}/fabric.mod.json"))
            .collect();
        let entries: Vec<_> = paths.iter().map(|path| (path.as_str(), FABRIC)).collect();
        assert_eq!(
            name_of(&archive(
                CompressionMethod::Stored,
                &entries[..MAX_METADATA_ENTRIES]
            ))
            .as_deref(),
            Some("Fabric Name")
        );
        assert_eq!(name_of(&archive(CompressionMethod::Stored, &entries)), None);

        let oversized = [FABRIC, &vec![b' '; MAX_METADATA_BYTES]].concat();
        let entries = [
            ("fabric.mod.json", oversized.as_slice()),
            ("quilt.mod.json", QUILT),
        ];
        assert_eq!(
            name_of(&archive(CompressionMethod::Deflated, &entries)).as_deref(),
            Some("Quilt Name")
        );
        let too_many_mods = "[[mods]]\ndisplayName = 'Test'\n".repeat(MAX_TOML_MODS + 1);
        let bytes = archive(
            CompressionMethod::Stored,
            &[("mods.toml", too_many_mods.as_bytes())],
        );
        assert_eq!(name_of(&bytes), None);

        let boundary = "猫".repeat(MAX_NAME_CHARS);
        for (raw, valid) in [
            (boundary.clone(), true),
            (format!("{boundary}猫"), false),
            ("  ".into(), false),
            ("line\nbreak".into(), false),
        ] {
            let json = serde_json::to_vec(&serde_json::json!({"name":raw})).unwrap();
            let bytes = archive(CompressionMethod::Stored, &[("fabric.mod.json", &json)]);
            assert_eq!(name_of(&bytes), valid.then_some(raw));
        }
    }
}

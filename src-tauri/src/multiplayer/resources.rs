//! 固定包资源的即时可用性检查，不执行二进制，也不把格式检查当作来源验证。
use serde_json::{json, Map, Value};
use std::{fs::{self, File, Metadata, OpenOptions}, io::{Read, Seek, SeekFrom}, path::Path};
use super::model::tr;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Probe { Missing, Present, Invalid }

fn is_link(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() { return true; }
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 { return true; }
    }
    false
}

fn directory_probe(directory: &Path) -> Probe {
    if !directory.is_absolute() { return Probe::Invalid; }
    for path in directory.ancestors() {
        match fs::symlink_metadata(path) {
            Ok(metadata) if is_link(&metadata) || !metadata.is_dir() => return Probe::Invalid,
            Ok(_) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Probe::Missing,
            Err(_) => return Probe::Invalid,
        }
    }
    Probe::Present
}

pub(super) fn check_directory(directory: &Path) -> Result<(), ()> {
    if directory_probe(directory) == Probe::Present { Ok(()) } else { Err(()) }
}

fn pe_header(file: &mut File, length: u64, architecture: &str) -> bool {
    let expected = match architecture { "x86_64" => 0x8664u16, "x86" => 0x14c, "aarch64" => 0xaa64, _ => return false };
    let mut dos = [0u8; 64];
    if file.read_exact(&mut dos).is_err() || &dos[..2] != b"MZ" { return false; }
    let offset = u32::from_le_bytes(dos[60..64].try_into().expect("固定字段长度")) as u64;
    if offset < 64 || offset > 1024 * 1024 || offset.saturating_add(24) > length { return false; }
    let mut pe = [0u8; 24];
    if file.seek(SeekFrom::Start(offset)).is_err() || file.read_exact(&mut pe).is_err() { return false; }
    let characteristics = u16::from_le_bytes([pe[22], pe[23]]);
    &pe[..4] == b"PE\0\0" && u16::from_le_bytes([pe[4], pe[5]]) == expected
        && characteristics & 2 != 0 && characteristics & 0x2000 == 0
}

fn file_probe(path: &Path, windows: bool, architecture: &str) -> Probe {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Probe::Missing,
        Err(_) => return Probe::Invalid,
    };
    if is_link(&metadata) || !metadata.is_file() || metadata.len() == 0 || metadata.len() > 512 * 1024 * 1024 { return Probe::Invalid; }
    let mut options = OpenOptions::new(); options.read(true);
    #[cfg(windows)] {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // OPEN_REPARSE_POINT，不跟随最后一项重新解析路径。
    }
    let mut file = match options.open(path) { Ok(file) => file, Err(_) => return Probe::Invalid };
    let opened = match file.metadata() { Ok(metadata) => metadata, Err(_) => return Probe::Invalid };
    if is_link(&opened) || !opened.is_file() || opened.len() != metadata.len() { return Probe::Invalid; }
    if windows && !pe_header(&mut file, opened.len(), architecture) { return Probe::Invalid; }
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        if !windows && opened.permissions().mode() & 0o111 == 0 { return Probe::Invalid; }
    }
    Probe::Present
}

/// 启动专用：持有正式 core 的只读句柄；不是签名或发行来源认证。
#[cfg(windows)]
pub(super) fn open_core(directory: &Path) -> Result<File, String> {
    use std::os::windows::fs::OpenOptionsExt;
    let failure = || "正式 EasyTier core 不可读取或架构不符 / 正式 EasyTier core 無法讀取或架構不符 / Packaged EasyTier core is unreadable or incompatible".to_owned();
    check_directory(directory).map_err(|_| failure())?;
    let path = directory.join("easytier-core.exe");
    if file_probe(&path, true, std::env::consts::ARCH) != Probe::Present { return Err(failure()); }
    let mut file = OpenOptions::new().read(true).share_mode(1).custom_flags(0x00200000).open(path).map_err(|_| failure())?;
    let metadata = file.metadata().map_err(|_| failure())?;
    if is_link(&metadata) || !metadata.is_file() || metadata.len() > 512 * 1024 * 1024
        || !pe_header(&mut file, metadata.len(), std::env::consts::ARCH) { return Err(failure()); }
    file.seek(SeekFrom::Start(0)).map_err(|_| failure())?;
    Ok(file)
}
pub(super) fn status(directory: &Path, language: &str) -> Value {
    status_for(directory, std::env::consts::OS == "windows", std::env::consts::ARCH, language)
}

fn status_for(directory: &Path, windows: bool, architecture: &str, language: &str) -> Value {
    let names = if windows { ["easytier-core.exe", "easytier-cli.exe"] } else { ["easytier-core", "easytier-cli"] };
    let directory_state = directory_probe(directory);
    let mut present = Map::new(); let mut missing = Vec::new(); let mut corrupted = Vec::new();
    for name in names {
        let observed = if directory_state == Probe::Present { file_probe(&directory.join(name), windows, architecture) } else { directory_state };
        present.insert(name.into(), json!(observed == Probe::Present));
        match observed { Probe::Missing => missing.push(name), Probe::Invalid => corrupted.push(name), Probe::Present => {} }
    }
    let ready = missing.is_empty() && corrupted.is_empty();
    let reason = if ready { String::new() }
        else if !corrupted.is_empty() { tr(language,
            &format!("联机文件不可用或与当前架构不符：{}。请重新准备正式 EasyTier 资源。", corrupted.join("、")),
            &format!("連線檔案無法使用或與目前架構不符：{}。請重新準備正式 EasyTier 資源。", corrupted.join("、")),
            &format!("Multiplayer files are unusable or incompatible with this architecture: {}. Prepare the official application resources again.", corrupted.join(", "))) }
        else { tr(language,
            &format!("缺少联机所需文件：{}。请准备当前平台的 EasyTier core / cli 后重试。", missing.join("、")),
            &format!("缺少連線所需檔案：{}。請準備目前平台的 EasyTier core / cli 後重試。", missing.join("、")),
            &format!("Required multiplayer files are missing: {}. Prepare EasyTier core / cli for this platform and retry.", missing.join(", "))) };
    json!({"present": present, "missing": missing, "corrupted": corrupted, "dir": directory.to_string_lossy(), "ready": ready, "reason": reason})
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(std::path::PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("hcmcl-mp-resources-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap(); Self(fs::canonicalize(path).unwrap())
        }
    }
    impl Drop for Temp { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    fn synthetic_pe() -> Vec<u8> {
        let mut bytes = vec![0u8; 128]; bytes[..2].copy_from_slice(b"MZ"); bytes[60..64].copy_from_slice(&64u32.to_le_bytes());
        bytes[64..68].copy_from_slice(b"PE\0\0"); bytes[68..70].copy_from_slice(&0x8664u16.to_le_bytes()); bytes[86..88].copy_from_slice(&2u16.to_le_bytes()); bytes
    }
    #[test]
    fn missing_and_basic_usable_files_follow_the_existing_status_contract() {
        let temp = Temp::new(); let directory = temp.0.join("easytier");
        let absent = status_for(&directory, true, "x86_64", "en");
        assert_eq!(absent["missing"], json!(["easytier-core.exe", "easytier-cli.exe"])); assert_eq!(absent["ready"], false);
        fs::create_dir(&directory).unwrap();
        for name in ["easytier-core.exe", "easytier-cli.exe"] { fs::write(directory.join(name), synthetic_pe()).unwrap(); }
        let present = status_for(&directory, true, "x86_64", "en");
        assert_eq!(present["ready"], true); assert_eq!(present["missing"], json!([])); assert_eq!(present["corrupted"], json!([]));
        assert_eq!(present.as_object().unwrap().len(), 6);
    }
    #[test]
    fn unreadable_format_and_wrong_architecture_are_not_reported_ready() {
        let temp = Temp::new(); fs::write(temp.0.join("easytier-core.exe"), b"ordinary text").unwrap();
        fs::write(temp.0.join("easytier-cli.exe"), synthetic_pe()).unwrap();
        let value = status_for(&temp.0, true, "x86_64", "zh-TW");
        assert_eq!(value["missing"], json!([])); assert_eq!(value["corrupted"], json!(["easytier-core.exe"])); assert_eq!(value["ready"], false);
        assert_eq!(status_for(&temp.0, true, "aarch64", "en")["corrupted"], json!(["easytier-core.exe", "easytier-cli.exe"]));
    }
}

//! 整合包完整实例的独占暂存与无覆盖发布。
//!
//! Stage 自身的变更锚定父 Directory；path 只保留兼容宿主生成器的用途。
//! 宿主仍以 path 写入的生成器不因此自动获得句柄安全。Unix *at 不提供叶 inode CAS，
//! 同 UID 恶意进程在最终核验后替换叶名的边界仍存在；这不是文件系统沙箱。
use crate::downloads::Cancel;
use super::access::{Directory, OpenedFile};
use sha2::{Digest, Sha256};
use std::{collections::{BTreeMap, BTreeSet}, fs::{File, Metadata}, io::{self, Read, Write}, path::{Path, PathBuf}};
#[path = "install_stage/native.rs"]
mod native;

const MAX_FILE: u64 = 256 * 1024 * 1024;
const MAX_TOTAL: u64 = 2 * 1024 * 1024 * 1024;
const MAX_DEPTH: usize = 64;
const MAX_PATH_BYTES: usize = 4096;
const MAX_NODES: usize = 100_000;
const OWNER_FILE: &str = ".hcmcl-modpack-stage-owner";
const TEMP_PREFIX: &str = ".hcmcl-modpack-write-";
type Result<T> = std::result::Result<T, String>;
fn io_error(_: io::Error) -> String { "整合包实例暂存文件操作失败".into() }
fn conflict() -> String { "整合包实例目标已存在；本次安装未覆盖现有实例".into() }
fn unsupported() -> String { "当前平台不支持安全的原子无覆盖目录发布".into() }
#[derive(Clone, Debug, PartialEq, Eq)]
struct Identity { volume: u64, number: u64 }
#[cfg(unix)]
fn identity(_: &File, metadata: &Metadata) -> Result<Identity> {
    use std::os::unix::fs::MetadataExt;
    Ok(Identity { volume: metadata.dev(), number: metadata.ino() })
}
#[cfg(unix)]
fn link_count(_: &File, metadata: &Metadata) -> Result<u64> { use std::os::unix::fs::MetadataExt; Ok(metadata.nlink()) }
#[cfg(windows)]
#[repr(C)]
struct FileInformation { attributes: u32, created: [u32; 2], accessed: [u32; 2], modified: [u32; 2], volume: u32, size_high: u32, size_low: u32, links: u32, index_high: u32, index_low: u32 }
#[cfg(windows)]
fn windows_file_information(file: &File) -> Result<FileInformation> {
    use std::{ffi::c_void, os::windows::io::AsRawHandle};
    #[link(name = "kernel32")] extern "system" { fn GetFileInformationByHandle(handle: *mut c_void, info: *mut FileInformation) -> i32; }
    let mut info: FileInformation = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 { return Err("无法确认暂存文件身份或链接数".into()); }
    Ok(info)
}
#[cfg(windows)]
fn identity(file: &File, _: &Metadata) -> Result<Identity> { let info = windows_file_information(file)?; Ok(Identity { volume: info.volume as u64, number: (info.index_high as u64) << 32 | info.index_low as u64 }) }
#[cfg(windows)]
fn link_count(file: &File, _: &Metadata) -> Result<u64> { Ok(windows_file_information(file)?.links as u64) }
#[cfg(not(any(unix, windows)))]
fn identity(_: &File, _: &Metadata) -> Result<Identity> { Err(unsupported()) }
#[cfg(not(any(unix, windows)))]
fn link_count(_: &File, _: &Metadata) -> Result<u64> { Err(unsupported()) }
fn linked(meta: &Metadata) -> bool { super::access::linked(meta) }
fn file_identity(file: &File, directory: bool) -> Result<Identity> {
    let meta = file.metadata().map_err(io_error)?;
    if linked(&meta) || if directory { !meta.is_dir() } else { !meta.is_file() } { return Err("暂存句柄不是预期类型".into()); }
    if !directory && link_count(file, &meta)? != 1 { return Err("暂存文件不是唯一硬链接".into()); }
    identity(file, &meta)
}
fn directory_identity(directory: &Directory) -> Result<Identity> { directory.verify()?; file_identity(directory.handle(), true) }
fn hash_open_file(file: &mut File, expected_size: u64, cancel: Option<&Cancel>) -> Result<(String, Identity)> {
    let before = file.metadata().map_err(io_error)?;
    let before_id = file_identity(file, false)?;
    if before.len() != expected_size || expected_size > MAX_FILE { return Err("暂存文件大小与台账不符".into()); }
    let mut hash = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if let Some(cancel) = cancel { cancel.check()?; }
        let count = file.read(&mut buffer).map_err(io_error)?;
        if count == 0 { break; }
        total = total.checked_add(count as u64).ok_or("暂存文件大小溢出")?;
        if total > expected_size { return Err("暂存文件在校验中变大".into()); }
        hash.update(&buffer[..count]);
    }
    let after = file.metadata().map_err(io_error)?;
    if total != expected_size || after.len() != expected_size || file_identity(file, false)? != before_id { return Err("暂存文件在校验中改变".into()); }
    Ok((format!("{:x}", hash.finalize()), before_id))
}
fn hash_opened(opened: &mut OpenedFile, expected_size: u64, cancel: Option<&Cancel>) -> Result<(String, Identity)> {
    // 不能移出 File 后丢掉 OpenedFile：其祖先 Directory 必须在整个读取/复核期间活着。
    opened.verify()?;
    let result = hash_open_file(&mut opened.file, expected_size, cancel)?;
    opened.verify()?;
    Ok(result)
}
fn validate_root(root: &Path) -> Result<()> { Directory::open(root)?.verify() }
fn validate_segment(segment: &str) -> Result<()> {
    super::access::leaf(segment)?;
    if segment.ends_with(' ') { return Err("暂存名称不能以空格结尾".into()); }
    Ok(())
}
fn split_relative(relative: &str) -> Result<(PathBuf, String, Vec<String>)> {
    if relative.is_empty() || relative.len() > MAX_PATH_BYTES || relative.starts_with('/') || relative.ends_with('/') || relative.contains('\\') || relative.contains(':') || relative.contains('\0') { return Err("整合包相对路径无效".into()); }
    let parts = relative.split('/').map(|name| { validate_segment(name)?; Ok(name.to_owned()) }).collect::<Result<Vec<_>>>()?;
    if parts.len() > MAX_DEPTH { return Err("整合包路径层数超过限制".into()); }
    let key = parts.iter().map(|name| name.to_lowercase()).collect::<Vec<_>>().join("/");
    let path = parts.iter().collect::<PathBuf>();
    Ok((path, key, parts))
}
fn normalized_relative(relative: &str, target: &str, host_write: bool) -> Result<(PathBuf, String, Vec<String>)> {
    let (path, key, parts) = split_relative(relative)?;
    let first = parts.first().ok_or("整合包路径为空")?.to_ascii_lowercase();
    let basename = parts.last().ok_or("整合包路径为空")?.to_ascii_lowercase();
    let host = parts.len() == 1 && (basename == "instance.json" || basename == format!("{target}.json").to_ascii_lowercase());
    if basename == OWNER_FILE || basename.starts_with(TEMP_PREFIX) || first == "natives" || (host && !host_write) || (host_write && !host) { return Err("该路径只能由宿主专用 API 写入".into()); }
    Ok((path, key, parts))
}
fn generated_relative(relative: &str) -> Result<(PathBuf, String, Vec<String>)> {
    let result = split_relative(relative)?;
    if !matches!(result.2.first().map(String::as_str), Some("natives") | Some("resources")) { return Err("生成路径只能位于 natives 或 resources 下".into()); }
    Ok(result)
}
fn key(parts: &[String]) -> String { parts.iter().map(|part| part.to_lowercase()).collect::<Vec<_>>().join("/") }
fn relative_parts(path: &Path) -> Result<Vec<String>> {
    path.components().map(|part| match part { std::path::Component::Normal(name) => { let name = name.to_str().ok_or("暂存路径不是 UTF-8")?; validate_segment(name)?; Ok(name.to_owned()) }, _ => Err("暂存路径台账无效".into()) }).collect()
}
#[derive(Clone)]
struct OwnedFile { size: u64, identity: Identity, sha256: String }
pub(super) struct GeneratedReceipt { pub(super) path: String, pub(super) size: u64, pub(super) sha256: String }
#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase { Open, Finished, Published, Cleaned, Stuck }
/// Directory 活对象只保留根至 stage；操作子项期间的子目录链用局部活对象持有。
/// 因而 publish 可明确释放所有 stage 及子孙的 deny-DELETE 句柄，仍保留 versions 链。
pub(super) struct Stage {
    versions: Directory,
    versions_identity: Identity,
    staging: PathBuf,
    staging_name: String,
    staging_identity: Identity,
    directory: Option<Directory>,
    target: PathBuf,
    target_name: String,
    owner: OwnedFile,
    files: BTreeMap<String, OwnedFile>,
    directories: BTreeMap<String, Identity>,
    paths: BTreeMap<String, PathBuf>,
    total: u64,
    owner_removed: bool,
    phase: Phase,
}
impl Stage {
    pub(super) fn create(game_root: &Path, target: &str, cancel: &Cancel) -> Result<Self> {
        cancel.check()?;
        validate_segment(target)?;
        let root = Directory::open(game_root)?;
        let versions = match root.child("versions")? {
            Some(node) => root.directory(node)?,
            None => {
                let created = native::mkdir(&root, "versions")?;
                let expected = file_identity(&created, true)?;
                drop(created);
                let node = root.child("versions")?.ok_or("versions 建立后丢失")?;
                let directory = root.directory(node)?;
                if directory_identity(&directory)? != expected { return Err("versions 建立后身份改变".into()); }
                directory
            }
        };
        if versions.child(target)?.is_some() { return Err(conflict()); }
        let versions_identity = directory_identity(&versions)?;
        cancel.check()?;
        let staging_name = format!(".hcmcl-modpack-stage-{}", uuid::Uuid::new_v4());
        let created = native::mkdir(&versions, &staging_name)?;
        let staging_identity = file_identity(&created, true)?;
        drop(created);
        let node = versions.child(&staging_name)?.ok_or("独占暂存目录建立后丢失")?;
        let directory = versions.directory(node)?;
        if directory_identity(&directory)? != staging_identity { return Err("独占暂存目录身份改变".into()); }
        let staging = directory.path().to_path_buf();
        let owner_text = format!("hcmcl-modpack-stage-v1\n{}\n", uuid::Uuid::new_v4());
        let mut owner_file = native::new_file(&directory, OWNER_FILE)?;
        owner_file.write_all(owner_text.as_bytes()).map_err(io_error)?;
        owner_file.sync_all().map_err(io_error)?;
        let owner = OwnedFile { size: owner_text.len() as u64, identity: file_identity(&owner_file, false)?, sha256: format!("{:x}", Sha256::digest(owner_text.as_bytes())) };
        drop(owner_file);
        let mut directories = BTreeMap::new();
        directories.insert(String::new(), staging_identity.clone());
        let result = Self { target: versions.path().join(target), target_name: target.into(), versions, versions_identity, staging, staging_name, staging_identity, directory: Some(directory), owner, files: BTreeMap::new(), directories, paths: BTreeMap::new(), total: 0, owner_removed: false, phase: Phase::Open };
        result.verify_open()?;
        cancel.check()?;
        Ok(result)
    }
    pub(super) fn path(&self) -> &Path { &self.staging }
    fn verify_roots(&self) -> Result<()> {
        if directory_identity(&self.versions)? != self.versions_identity { return Err("versions 目录身份改变".into()); }
        Ok(())
    }
    fn stage_dir(&self) -> Result<&Directory> {
        self.verify_roots()?;
        let directory = self.directory.as_ref().ok_or("暂存目录句柄已释放")?;
        if directory_identity(directory)? != self.staging_identity { return Err("暂存目录身份改变".into()); }
        Ok(directory)
    }
    fn verify_open(&self) -> Result<()> {
        if matches!(self.phase, Phase::Published | Phase::Cleaned | Phase::Stuck) { return Err("暂存已提交、清理或处于保留现场状态".into()); }
        let directory = self.stage_dir()?;
        if !self.owner_removed { self.verify_file(directory, OWNER_FILE, &self.owner, None)?; }
        Ok(())
    }
    fn verify_file(&self, parent: &Directory, name: &str, owned: &OwnedFile, cancel: Option<&Cancel>) -> Result<()> {
        let mut opened = parent.source(name)?.open()?;
        let (hash, id) = hash_opened(&mut opened, owned.size, cancel)?;
        if hash != owned.sha256 || id != owned.identity { return Err("暂存文件身份或内容已改变".into()); }
        Ok(())
    }
    fn open_directory(&self, parts: &[String], registered: bool) -> Result<Directory> {
        self.open_directory_receipts(parts, registered, &BTreeMap::new(), &BTreeMap::new())
    }
    fn open_directory_receipts(&self, parts: &[String], registered: bool, local_dirs: &BTreeMap<String, Identity>, local_paths: &BTreeMap<String, PathBuf>) -> Result<Directory> {
        let mut directory = self.stage_dir()?.clone();
        for index in 0..parts.len() {
            let part = &parts[index];
            let node = directory.child(part)?.ok_or("暂存父目录丢失")?;
            directory = directory.directory(node)?;
            let current_key = key(&parts[..=index]);
            if let Some(expected) = self.directories.get(&current_key).or_else(|| local_dirs.get(&current_key)) {
                let expected_path = self.paths.get(&current_key).or_else(|| local_paths.get(&current_key));
                if expected != &directory_identity(&directory)? || expected_path.map(PathBuf::as_path) != Some(directory.path()) { return Err("暂存父目录身份或大小写路径改变".into()); }
            } else if registered {
                return Err("暂存父目录没有显式回执".into());
            }
        }
        Ok(directory)
    }
    fn ensure_parent_dirs(&mut self, parts: &[String]) -> Result<Directory> {
        let mut directory = self.stage_dir()?.clone();
        for index in 0..parts.len() {
            let name = &parts[index];
            let current_key = key(&parts[..=index]);
            directory = match directory.child(name)? {
                Some(node) => {
                    let child = directory.directory(node)?;
                    if self.directories.get(&current_key) != Some(&directory_identity(&child)?) || self.paths.get(&current_key).map(PathBuf::as_path) != Some(child.path()) { return Err("暂存父目录未知或身份改变".into()); }
                    child
                }
                None => {
                    if self.directories.contains_key(&current_key) || self.paths.contains_key(&current_key) { return Err("已登记暂存目录丢失".into()); }
                    if self.directories.len() + self.files.len() >= MAX_NODES { return Err("暂存节点超过限制".into()); }
                    let file = native::mkdir(&directory, name)?;
                    let expected = file_identity(&file, true)?;
                    drop(file);
                    let node = directory.child(name)?.ok_or("新建暂存目录丢失")?;
                    let child = directory.directory(node)?;
                    if directory_identity(&child)? != expected { return Err("新建暂存目录被替换".into()); }
                    self.directories.insert(current_key.clone(), expected);
                    self.paths.insert(current_key, child.path().to_path_buf());
                    child
                }
            };
        }
        Ok(directory)
    }
    pub(super) fn write<R: Read>(&mut self, relative: &str, reader: R, size: u64, allow_owned_replace: bool, cancel: &Cancel) -> Result<()> { self.write_internal(relative, reader, size, allow_owned_replace, false, cancel) }
    pub(super) fn host_write<R: Read>(&mut self, relative: &str, reader: R, size: u64, allow_owned_replace: bool, cancel: &Cancel) -> Result<()> { self.write_internal(relative, reader, size, allow_owned_replace, true, cancel) }
    fn discard_temp(&mut self, parent: &Directory, name: &str, output: File, expected: &Identity) -> Result<()> {
        if let Err(error) = native::remove_open(parent, name, output, expected) { self.phase = Phase::Stuck; return Err(error); }
        Ok(())
    }
    fn write_internal<R: Read>(&mut self, relative: &str, mut reader: R, size: u64, allow_owned_replace: bool, host_write: bool, cancel: &Cancel) -> Result<()> {
        cancel.check()?;
        if self.phase != Phase::Open { return Err("暂存已经封存或发布".into()); }
        self.verify_open()?;
        if size > MAX_FILE { return Err("整合包单文件超过 256 MiB 限制".into()); }
        let (_, current_key, parts) = normalized_relative(relative, &self.target_name, host_write)?;
        let name = parts.last().ok_or("整合包路径为空")?;
        let old = self.files.get(&current_key).cloned();
        if old.is_some() && !allow_owned_replace { return Err("整合包文件重复，未允许覆盖".into()); }
        if old.is_none() && self.directories.len() + self.files.len() >= MAX_NODES { return Err("暂存节点超过限制".into()); }
        let new_total = self.total.checked_sub(old.as_ref().map(|file| file.size).unwrap_or(0)).and_then(|value| value.checked_add(size)).ok_or("展开总量溢出")?;
        if new_total > MAX_TOTAL { return Err("整合包展开总量超过 2 GiB 限制".into()); }
        let parent = self.ensure_parent_dirs(&parts[..parts.len()-1])?;
        let target_path = parent.path().join(name);
        if self.paths.get(&current_key).map(|path| path != &target_path).unwrap_or(false) { return Err("暂存路径大小写别名冲突".into()); }
        match (&old, parent.child(name)?) {
            (Some(owned), Some(node)) => { drop(node); self.verify_file(&parent, name, owned, Some(cancel))?; },
            (None, None) => {},
            _ => return Err("暂存目标存在未知内容或已登记文件丢失".into()),
        }
        let temporary = format!("{}{}", TEMP_PREFIX, uuid::Uuid::new_v4());
        let mut output = native::new_file(&parent, &temporary)?;
        let temporary_id = file_identity(&output, false)?;
        let mut hash = Sha256::new();
        let work = (|| -> Result<()> {
            let mut remaining = size;
            let mut buffer = [0u8; 64 * 1024];
            while remaining != 0 {
                cancel.check()?;
                let wanted = std::cmp::min(buffer.len() as u64, remaining) as usize;
                let count = reader.read(&mut buffer[..wanted]).map_err(|_| "读取整合包文件失败")?;
                if count == 0 { return Err("整合包文件提前结束".into()); }
                output.write_all(&buffer[..count]).map_err(io_error)?;
                hash.update(&buffer[..count]);
                remaining -= count as u64;
            }
            cancel.check()?;
            if reader.read(&mut [0u8; 1]).map_err(|_| "读取整合包文件失败")? != 0 { return Err("整合包文件大小与声明不一致".into()); }
            output.flush().map_err(io_error)?;
            output.sync_all().map_err(io_error)?;
            cancel.check()?;
            parent.verify()?;
            Ok(())
        })();
        if let Err(error) = work { self.discard_temp(&parent, &temporary, output, &temporary_id)?; return Err(error); }
        let digest = format!("{:x}", hash.finalize());
        if let Some(owned) = &old {
            if let Err(error) = self.verify_file(&parent, name, owned, Some(cancel)) { self.discard_temp(&parent, &temporary, output, &temporary_id)?; return Err(error); }
            if let Err(error) = native::remove(&parent, name, &owned.identity, false) { self.discard_temp(&parent, &temporary, output, &temporary_id)?; return Err(error); }
            // 不按名称盲替换：旧项删后只做内核 no-replace；抢占者保留，失败为 sticky。
            if let Err(error) = native::rename_file_noreplace(&parent, &output, &temporary, name, &temporary_id) { self.phase = Phase::Stuck; return Err(error); }
        } else if let Err(error) = native::rename_file_noreplace(&parent, &output, &temporary, name, &temporary_id) {
            self.discard_temp(&parent, &temporary, output, &temporary_id)?;
            return Err(error);
        }
        self.total = new_total;
        self.paths.insert(current_key.clone(), target_path);
        self.files.insert(current_key, OwnedFile { size, identity: temporary_id, sha256: digest });
        drop(output);
        parent.verify()?;
        Ok(())
    }
    pub(super) fn register_generated(&mut self, files: &[GeneratedReceipt], directories: &[String], cancel: &Cancel) -> Result<()> {
        cancel.check()?;
        if self.phase != Phase::Open { return Err("暂存已经封存或发布".into()); }
        self.verify_open()?;
        if self.files.len() + self.directories.len() + files.len() + directories.len() > MAX_NODES { return Err("暂存节点超过限制".into()); }
        let mut declarations = directories.iter().map(|path| generated_relative(path)).collect::<Result<Vec<_>>>()?;
        declarations.sort_by_key(|(_, _, parts)| parts.len());
        let mut local_dirs = BTreeMap::new();
        let mut local_paths = BTreeMap::new();
        for (_, current_key, parts) in declarations {
            cancel.check()?;
            if self.paths.contains_key(&current_key) || local_paths.contains_key(&current_key) { return Err("生成目录回执重复或冲突".into()); }
            if parts.len() > 1 { let parent_key = key(&parts[..parts.len()-1]); if !self.directories.contains_key(&parent_key) && !local_dirs.contains_key(&parent_key) { return Err("生成目录回执缺少显式父目录".into()); } }
            let directory = self.open_directory_receipts(&parts, false, &local_dirs, &local_paths)?;
            local_dirs.insert(current_key.clone(), directory_identity(&directory)?);
            local_paths.insert(current_key, directory.path().to_path_buf());
        }
        let mut local_files = BTreeMap::new();
        let mut total_add = 0u64;
        for file in files {
            cancel.check()?;
            let (_, current_key, parts) = generated_relative(&file.path)?;
            if parts.len() < 2 || file.size > MAX_FILE || file.sha256.len() != 64 || !file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err("生成文件回执无效".into()); }
            if self.paths.contains_key(&current_key) || local_paths.contains_key(&current_key) || local_files.contains_key(&current_key) { return Err("生成文件回执重复或冲突".into()); }
            let parent_key = key(&parts[..parts.len()-1]);
            if !self.directories.contains_key(&parent_key) && !local_dirs.contains_key(&parent_key) { return Err("生成文件回执缺少显式父目录".into()); }
            let prospective = self.total.checked_add(total_add).and_then(|value| value.checked_add(file.size)).ok_or("展开总量溢出")?;
            if prospective > MAX_TOTAL { return Err("整合包展开总量超过 2 GiB 限制".into()); }
            let parent = self.open_directory_receipts(&parts[..parts.len()-1], true, &local_dirs, &local_paths)?;
            let name = parts.last().ok_or("生成文件回执路径为空")?;
            let mut opened = parent.source(name)?.open()?;
            let (actual, id) = hash_opened(&mut opened, file.size, Some(cancel))?;
            if !actual.eq_ignore_ascii_case(&file.sha256) { return Err("生成文件摘要不符".into()); }
            total_add = total_add.checked_add(file.size).ok_or("展开总量溢出")?;
            local_paths.insert(current_key.clone(), parent.path().join(name));
            local_files.insert(current_key, OwnedFile { size: file.size, identity: id, sha256: actual });
        }
        let total = self.total.checked_add(total_add).ok_or("展开总量溢出")?;
        if total > MAX_TOTAL { return Err("整合包展开总量超过 2 GiB 限制".into()); }
        cancel.check()?;
        self.verify_open()?;
        // 提交台账前复核本批目录链与文件，不能以先前一次散列收养后来替换的节点。
        let mut checked_dirs = BTreeMap::new();
        for (current_key, expected) in &local_dirs {
            let path = local_paths.get(current_key).ok_or("生成目录路径回执丢失")?;
            let parts = relative_parts(path.strip_prefix(&self.staging).map_err(|_| "生成目录回执越界")?)?;
            let directory = self.open_directory_receipts(&parts, true, &local_dirs, &local_paths)?;
            if &directory_identity(&directory)? != expected { return Err("生成目录在登记前改变".into()); }
            checked_dirs.insert(current_key.clone(), directory);
        }
        for (current_key, owned) in &local_files {
            cancel.check()?;
            let path = local_paths.get(current_key).ok_or("生成文件路径回执丢失")?;
            let parts = relative_parts(path.strip_prefix(&self.staging).map_err(|_| "生成文件回执越界")?)?;
            let parent = self.open_directory_receipts(&parts[..parts.len()-1], true, &local_dirs, &local_paths)?;
            self.verify_file(&parent, parts.last().ok_or("生成文件回执为空")?, owned, Some(cancel))?;
        }
        drop(checked_dirs);
        self.paths.extend(local_paths);
        self.directories.extend(local_dirs);
        self.files.extend(local_files);
        self.total = total;
        Ok(())
    }
    fn walk(&self, cancel: Option<&Cancel>) -> Result<()> {
        self.verify_open()?;
        let mut budget = MAX_NODES;
        let mut files = BTreeSet::new();
        let mut directories = BTreeSet::new();
        directories.insert(String::new());
        self.walk_node(self.stage_dir()?.clone(), Vec::new(), &mut budget, &mut files, &mut directories, cancel)?;
        if self.files.keys().any(|name| !files.contains(name)) || self.directories.keys().any(|name| !directories.contains(name)) { return Err("已登记暂存节点丢失".into()); }
        if !self.owner_removed && !files.contains(OWNER_FILE) { return Err("暂存 owner 标记丢失".into()); }
        Ok(())
    }
    fn walk_node(&self, directory: Directory, prefix: Vec<String>, budget: &mut usize, files: &mut BTreeSet<String>, directories: &mut BTreeSet<String>, cancel: Option<&Cancel>) -> Result<()> {
        for name in directory.names(budget)? {
            if let Some(cancel) = cancel { cancel.check()?; }
            let mut parts = prefix.clone(); parts.push(name.clone());
            let current_key = key(&parts);
            let node = directory.child(&name)?.ok_or("暂存节点在枚举中丢失")?;
            if node.meta.is_dir() {
                let child = directory.directory(node)?;
                if self.directories.get(&current_key) != Some(&directory_identity(&child)?) || self.paths.get(&current_key).map(PathBuf::as_path) != Some(child.path()) { return Err("暂存树含未知或已换绑目录".into()); }
                directories.insert(current_key);
                self.walk_node(child, parts, budget, files, directories, cancel)?;
            } else {
                drop(node);
                let owned = if parts.len() == 1 && name == OWNER_FILE {
                    if self.owner_removed { return Err("已移除的 owner 标记重新出现".into()); }
                    &self.owner
                } else {
                    if self.paths.get(&current_key) != Some(&directory.path().join(&name)) { return Err("暂存文件路径未知或大小写别名冲突".into()); }
                    self.files.get(&current_key).ok_or("暂存树包含未登记文件")?
                };
                self.verify_file(&directory, &name, owned, cancel)?;
                files.insert(current_key);
            }
        }
        Ok(())
    }
    pub(super) fn finish(&mut self, cancel: &Cancel) -> Result<()> {
        cancel.check()?;
        if self.phase != Phase::Open { return Err("暂存已经封存或发布".into()); }
        self.walk(Some(cancel))?;
        cancel.check()?;
        self.phase = Phase::Finished;
        Ok(())
    }
    fn reopen_stage(&mut self) -> Result<()> {
        let node = self.versions.child(&self.staging_name)?.ok_or("暂存目录丢失")?;
        let directory = self.versions.directory(node)?;
        if directory_identity(&directory)? != self.staging_identity { return Err("暂存目录身份改变".into()); }
        self.directory = Some(directory);
        Ok(())
    }
    pub(super) fn publish(&mut self, cancel: &Cancel) -> Result<PathBuf> {
        if self.phase == Phase::Published { return Ok(self.target.clone()); }
        cancel.check()?;
        if self.phase != Phase::Finished { self.finish(cancel)?; }
        // finish 与 publish 之间宿主可能仍持 path；必须重验整树。
        self.walk(Some(cancel))?;
        if self.versions.child(&self.target_name)?.is_some() { return Err(conflict()); }
        if !self.owner_removed {
            native::remove(self.stage_dir()?, OWNER_FILE, &self.owner.identity, false)?;
            self.owner_removed = true;
        }
        cancel.check()?;
        self.verify_roots()?;
        // 所有子目录/Source/OpenedFile 都只存在于已返回的局部调用中；这里释放最后 stage Arc。
        drop(self.directory.take());
        match native::publish_dir_noreplace(&self.versions, &self.staging_name, &self.target_name, &self.staging_identity) {
            Ok(()) => {
                // 系统成功即终态；以下验证失败也绝不允许 cleanup 删除已发布目标。
                self.phase = Phase::Published;
                let verify = (|| -> Result<()> {
                    let node = self.versions.child(&self.target_name)?.ok_or("已发布目标无法重新打开")?;
                    let directory = self.versions.directory(node)?;
                    if directory_identity(&directory)? != self.staging_identity { return Err("已发布目标身份不符".into()); }
                    self.directory = Some(directory);
                    Ok(())
                })();
                if verify.is_err() { return Err("实例已发布，但发布后身份核验失败；保留目标且不回滚删除".into()); }
                Ok(self.target.clone())
            }
            Err(error) => {
                if error.starts_with("整合包实例目标已存在") && self.reopen_stage().is_ok() { return Err(error); }
                self.phase = Phase::Stuck;
                Err(error)
            }
        }
    }
    pub(super) fn cleanup(&mut self) -> Result<()> {
        if matches!(self.phase, Phase::Published | Phase::Cleaned) { return Ok(()); }
        if self.phase == Phase::Stuck { return Err("暂存状态不明，保留现场而不按名字清理".into()); }
        self.walk(None)?;
        let files = self.files.keys().cloned().collect::<Vec<_>>();
        for current_key in files {
            let owned = self.files.get(&current_key).ok_or("文件台账丢失")?.clone();
            let path = self.paths.get(&current_key).ok_or("文件路径台账丢失")?;
            let relative = path.strip_prefix(&self.staging).map_err(|_| "暂存路径台账越界")?;
            let parts = relative_parts(relative)?;
            let parent = self.open_directory(&parts[..parts.len()-1], true)?;
            let name = parts.last().ok_or("文件路径台账为空")?;
            self.verify_file(&parent, name, &owned, None)?;
            native::remove(&parent, name, &owned.identity, false)?;
            self.files.remove(&current_key);
            self.paths.remove(&current_key);
            self.total -= owned.size;
        }
        let mut directories = self.directories.keys().filter(|name| !name.is_empty()).cloned().collect::<Vec<_>>();
        directories.sort_by_key(|name| std::cmp::Reverse(name.matches('/').count()));
        for current_key in directories {
            let path = self.paths.get(&current_key).ok_or("目录路径台账丢失")?;
            let parts = relative_parts(path.strip_prefix(&self.staging).map_err(|_| "目录路径台账越界")?)?;
            let parent = self.open_directory(&parts[..parts.len()-1], true)?;
            let child = self.open_directory(&parts, true)?;
            let mut budget = 1;
            if !child.names(&mut budget)?.is_empty() { return Err("暂存子目录出现未知孩子，保留现场".into()); }
            let expected = self.directories.get(&current_key).ok_or("目录台账丢失")?.clone();
            drop(child); // Windows 删除前释放自身 deny-DELETE 句柄，父目录仍活着。
            native::remove(&parent, parts.last().ok_or("目录台账为空")?, &expected, true)?;
            self.directories.remove(&current_key);
            self.paths.remove(&current_key);
        }
        if !self.owner_removed {
            self.verify_file(self.stage_dir()?, OWNER_FILE, &self.owner, None)?;
            native::remove(self.stage_dir()?, OWNER_FILE, &self.owner.identity, false)?;
            self.owner_removed = true;
        }
        let mut budget = 1;
        if !self.stage_dir()?.names(&mut budget)?.is_empty() { return Err("暂存目录出现未知孩子，保留现场".into()); }
        drop(self.directory.take());
        if let Err(error) = native::remove(&self.versions, &self.staging_name, &self.staging_identity, true) { self.phase = Phase::Stuck; return Err(error); }
        self.phase = Phase::Cleaned;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, sync::Arc};
    struct Fixture { root: PathBuf }
    impl Fixture { fn new() -> Self { let root = std::env::temp_dir().join(format!("hcmcl-install-stage-{}", uuid::Uuid::new_v4())); fs::create_dir(&root).unwrap(); Self { root: fs::canonicalize(root).unwrap() } } }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); } }
    fn cancel() -> Cancel { Cancel::default() }
    fn make_stage(fixture: &Fixture, name: &str) -> Stage { Stage::create(&fixture.root, name, &cancel()).unwrap() }
    #[cfg(windows)]
    #[test]
    fn validates_rooted_drive_paths_without_inspecting_a_bare_prefix() {
        let fixture = Fixture::new(); validate_root(&fixture.root).unwrap();
        let text = fixture.root.to_str().unwrap(); validate_root(Path::new(text.strip_prefix(r"\\?\").unwrap_or(text))).unwrap();
        for invalid in [r"C:relative", r"relative\root", r"\\server\share\root", r"\\?\UNC\server\share\root", r"\\.\C:\root"] { assert!(validate_root(Path::new(invalid)).is_err()); }
    }
    #[test]
    fn creates_writes_finishes_and_publishes_without_owner_marker() {
        let fixture = Fixture::new(); let mut stage = make_stage(&fixture, "instance");
        stage.write("config/options.txt", &b"ok"[..], 2, false, &cancel()).unwrap(); stage.finish(&cancel()).unwrap();
        let target = stage.publish(&cancel()).unwrap(); assert_eq!(fs::read(target.join("config/options.txt")).unwrap(), b"ok"); assert!(!target.join(OWNER_FILE).exists()); stage.cleanup().unwrap();
    }
    #[test]
    fn existing_and_concurrent_empty_targets_are_preserved() {
        let fixture = Fixture::new(); fs::create_dir(fixture.root.join("versions")).unwrap(); fs::create_dir(fixture.root.join("versions/keep")).unwrap();
        assert!(Stage::create(&fixture.root, "keep", &cancel()).is_err());
        let mut stage = make_stage(&fixture, "race"); fs::create_dir(fixture.root.join("versions/race")).unwrap(); assert!(stage.publish(&cancel()).is_err()); stage.cleanup().unwrap(); assert!(fixture.root.join("versions/race").is_dir());
    }
    #[test]
    fn pre_cancel_and_late_cancel_do_not_publish_or_remove_published() {
        let fixture = Fixture::new(); let token = Cancel::default(); token.stop(); assert!(Stage::create(&fixture.root, "cancelled", &token).is_err());
        let token = Cancel::default(); let mut stage = make_stage(&fixture, "late-cancel"); stage.write("a.txt", &b"a"[..], 1, false, &token).unwrap(); stage.finish(&token).unwrap(); token.stop(); assert!(stage.publish(&token).is_err()); stage.cleanup().unwrap();
        let mut stage = make_stage(&fixture, "committed"); stage.write("a.txt", &b"a"[..], 1, false, &cancel()).unwrap(); let target = stage.publish(&cancel()).unwrap(); let token = cancel(); token.stop(); assert_eq!(stage.publish(&token).unwrap(), target); stage.cleanup().unwrap(); assert_eq!(fs::read(target.join("a.txt")).unwrap(), b"a");
    }
    struct FailingReader { remaining: usize }
    impl Read for FailingReader { fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> { if self.remaining == 0 { return Err(io::Error::new(io::ErrorKind::Other, "fixture failure")); } let count = self.remaining.min(buffer.len()); buffer[..count].fill(b'x'); self.remaining -= count; Ok(count) } }
    #[test]
    fn reader_errors_and_size_mismatch_leave_no_published_target() {
        let fixture = Fixture::new(); let mut stage = make_stage(&fixture, "bad"); assert!(stage.write("a.txt", FailingReader { remaining: 2 }, 4, false, &cancel()).is_err()); stage.cleanup().unwrap();
        let mut stage = make_stage(&fixture, "size"); assert!(stage.write("a.txt", &b"extra"[..], 2, false, &cancel()).is_err()); stage.cleanup().unwrap(); assert!(!fixture.root.join("versions/size").exists());
    }
    #[test]
    fn unknown_children_and_rebound_parent_are_sticky() {
        let fixture = Fixture::new(); let mut stage = make_stage(&fixture, "unknown"); stage.write("a.txt", &b"a"[..], 1, false, &cancel()).unwrap(); fs::write(stage.path().join("unknown"), b"keep").unwrap(); assert!(stage.finish(&cancel()).is_err()); assert!(stage.cleanup().is_err()); assert_eq!(fs::read(stage.path().join("unknown")).unwrap(), b"keep");
        let mut rebound = make_stage(&fixture, "rebound"); rebound.write("a.txt", &b"a"[..], 1, false, &cancel()).unwrap();
        let old = fixture.root.join("versions"); let moved = fixture.root.join("versions.moved");
        #[cfg(windows)] { assert!(fs::rename(&old, &moved).is_err()); }
        #[cfg(unix)] { fs::rename(&old, &moved).unwrap(); fs::create_dir(&old).unwrap(); assert!(rebound.publish(&cancel()).is_err()); assert!(rebound.cleanup().is_err()); assert!(!old.join("rebound").exists()); }
    }
    #[test]
    fn owned_override_is_allowed_but_protected_files_are_not() {
        let fixture = Fixture::new(); let mut stage = make_stage(&fixture, "override"); stage.write("a.txt", &b"old"[..], 3, false, &cancel()).unwrap(); assert!(stage.write("a.txt", &b"new"[..], 3, false, &cancel()).is_err()); stage.write("a.txt", &b"new"[..], 3, true, &cancel()).unwrap(); assert_eq!(fs::read(stage.path().join("a.txt")).unwrap(), b"new");
        for path in ["instance.json", "natives/x", "override.json"] { assert!(stage.write(path, &b"x"[..], 1, false, &cancel()).is_err()); } stage.cleanup().unwrap();
    }
    #[test]
    fn host_write_and_generated_receipt_require_explicit_owned_paths() {
        let fixture = Fixture::new(); let mut stage = make_stage(&fixture, "receipt"); assert!(stage.write("instance.json", &b"{}"[..], 2, false, &cancel()).is_err()); stage.host_write("instance.json", &b"{}"[..], 2, false, &cancel()).unwrap(); fs::create_dir(stage.path().join("natives")).unwrap(); fs::write(stage.path().join("natives/libx.so"), b"jni").unwrap();
        stage.register_generated(&[GeneratedReceipt { path: "natives/libx.so".into(), size: 3, sha256: format!("{:X}", Sha256::digest(b"jni")) }], &["natives".into()], &cancel()).unwrap(); stage.finish(&cancel()).unwrap(); let target = stage.publish(&cancel()).unwrap(); assert_eq!(fs::read(target.join("natives/libx.so")).unwrap(), b"jni"); stage.cleanup().unwrap();
    }
    #[test]
    fn generated_receipts_reject_hardlinked_payloads() {
        let fixture = Fixture::new(); let mut stage = make_stage(&fixture, "hardlink"); fs::create_dir(stage.path().join("natives")).unwrap(); let payload = stage.path().join("natives/libx.so"); fs::write(&payload, b"jni").unwrap(); let alias = fixture.root.join("alias.so"); fs::hard_link(&payload, &alias).unwrap(); let receipt = GeneratedReceipt { path: "natives/libx.so".into(), size: 3, sha256: format!("{:x}", Sha256::digest(b"jni")) }; assert!(stage.register_generated(&[receipt], &["natives".into()], &cancel()).is_err()); assert_eq!(fs::read(alias).unwrap(), b"jni");
    }
    #[test]
    fn equal_length_changes_and_symlink_children_are_never_adopted_or_deleted() {
        let fixture = Fixture::new(); let mut stage = make_stage(&fixture, "tamper"); stage.write("a.txt", &b"old"[..], 3, false, &cancel()).unwrap(); fs::write(stage.path().join("a.txt"), b"new").unwrap(); assert!(stage.finish(&cancel()).is_err()); assert!(stage.cleanup().is_err()); assert_eq!(fs::read(stage.path().join("a.txt")).unwrap(), b"new");
        #[cfg(unix)] { use std::os::unix::fs::symlink; let mut linked = make_stage(&fixture, "linked"); symlink(&fixture.root, linked.path().join("escape")).unwrap(); assert!(linked.finish(&cancel()).is_err()); assert!(linked.cleanup().is_err()); }
    }
    #[test]
    fn native_no_replace_preserves_a_concurrent_file_and_deletes_only_the_owned_handle() {
        let fixture = Fixture::new();
        let mut stage = make_stage(&fixture, "native");
        let parent = stage.stage_dir().unwrap().clone();
        let mut file = native::new_file(&parent, "source").unwrap();
        file.write_all(b"owned").unwrap(); file.sync_all().unwrap();
        let id = file_identity(&file, false).unwrap();
        fs::write(stage.path().join("winner"), b"winner").unwrap();
        assert!(native::rename_file_noreplace(&parent, &file, "source", "winner", &id).unwrap_err().contains("已存在"));
        native::remove_open(&parent, "source", file, &id).unwrap();
        assert_eq!(fs::read(stage.path().join("winner")).unwrap(), b"winner");
        assert!(!stage.path().join("source").exists());
        assert!(stage.cleanup().is_err()); // winner 不在台账，不能被清理。
    }
    #[cfg(unix)]
    #[test]
    fn held_parent_cannot_redirect_native_creation_into_a_replacement_tree() {
        let fixture = Fixture::new(); let mut stage = make_stage(&fixture, "parent");
        stage.write("config/a", &b"a"[..], 1, false, &cancel()).unwrap();
        let parent = stage.open_directory(&["config".into()], true).unwrap();
        let original = stage.path().join("config"); let moved = stage.path().join("moved");
        fs::rename(&original, &moved).unwrap(); fs::create_dir(&original).unwrap();
        assert!(native::new_file(&parent, "escaped").is_err());
        assert!(!original.join("escaped").exists());
        assert!(stage.cleanup().is_err());
    }
    #[test]
    fn fixture_cancel_type_is_shareable_without_stage_global_state() { let token = Arc::new(Cancel::default()); let other = token.clone(); other.stop(); assert!(token.check().is_err()); }
}

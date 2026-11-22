//! 将本地 ZIP 整合包的覆盖层物化到调用者持有的安装暂存。
//!
//! 这个模块只负责 `overrides` 与 `client-overrides` 两个本地阶段。它不联网，
//! 不解压到宿主目录，也不封存、清理或发布 `install_stage::Stage`；调用方必须在
//! 成功或失败后继续持有同一个 Stage，并自行决定 finish/publish/cleanup。

use super::{
    access::leaf,
    install_stage::Stage,
    parser::open_validated,
    plan::{plan, ApplyPhase, ArchivePhase, DeclaredHash, EnvironmentStatus, FullPackPlan, SourceFormat},
    Result,
};
use crate::downloads::Cancel;
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::Read,
};
use zip::ZipArchive;

const MAX_PHASE_FILES: usize = 50_000;
const MAX_PHASE_FILE: u64 = 256 * 1024 * 1024;
const MAX_PHASE_TOTAL: u64 = 2 * 1024 * 1024 * 1024;
const MAX_PATH_BYTES: usize = 4096;
const MAX_DEPTH: usize = 64;
const MAX_PHASE_NODES: usize = 100_000;

// 与 Stage 的普通内容路径约束相同；Stage.write 仍独立复核。这里提前检查整个阶段，
// 避免最后一个条目含 host/natives 路径时才在前面已写入后发现。
fn preflight_target(
    target: &str,
    target_id: &str,
    nodes: &mut BTreeMap<String, (String, bool)>,
) -> Result<()> {
    if target.is_empty() || target.len() > MAX_PATH_BYTES || target.starts_with('/')
        || target.ends_with('/') || target.contains('\\') {
        return Err("整合包覆盖目标不是安全的相对路径".into());
    }
    let parts: Vec<_> = target.split('/').collect();
    if parts.len() > MAX_DEPTH { return Err("整合包覆盖目标路径过深".into()); }
    for part in &parts { leaf(part)?; }
    let first = parts[0].to_ascii_lowercase();
    let basename = parts[parts.len() - 1].to_ascii_lowercase();
    let host = parts.len() == 1
        && (basename == "instance.json" || basename == format!("{target_id}.json").to_ascii_lowercase());
    if first == "natives" || host || basename == ".hcmcl-modpack-stage-owner"
        || basename.starts_with(".hcmcl-modpack-write-") {
        return Err("整合包覆盖目标属于宿主专用路径".into());
    }
    let mut prefix = String::new();
    for (index, part) in parts.iter().enumerate() {
        if !prefix.is_empty() { prefix.push('/'); }
        prefix.push_str(part);
        let directory = index + 1 < parts.len();
        let key = prefix.to_lowercase();
        if let Some((prior_path, prior_directory)) = nodes.get(&key) {
            if prior_path != &prefix || !*prior_directory || !directory {
                return Err("整合包覆盖阶段存在别名或文件目录冲突".into());
            }
        } else {
            if nodes.len() >= MAX_PHASE_NODES { return Err("整合包覆盖阶段路径节点超过预算".into()); }
            nodes.insert(key, (prefix.clone(), directory));
        }
    }
    Ok(())
}

#[derive(Clone)]
struct Selected {
    archive_path: String,
    target_path: String,
    size: u64,
}

fn select_phase(expected: &FullPackPlan, phase: &ApplyPhase, cancel: &Cancel) -> Result<Vec<Selected>> {
    if phase == &ApplyPhase::Remote {
        return Err("整合包远程文件必须由上层绑定并安装，不能由本地物化阶段处理".into());
    }
    if expected.apply_order != [ApplyPhase::Remote, ApplyPhase::Overrides, ApplyPhase::ClientOverrides] {
        return Err("整合包阶段顺序与当前物化协议不一致".into());
    }
    if expected.members.len() > MAX_PHASE_FILES { return Err("整合包成员总数超过预算".into()); }

    let mut selected = Vec::new();
    let mut archive_paths = BTreeSet::new();
    let mut target_paths = BTreeSet::new();
    let mut nodes = BTreeMap::new();
    let mut total = 0u64;
    for member in &expected.members {
        cancel.check()?;
        let wanted = match phase {
            ApplyPhase::Overrides => member.phase == ArchivePhase::Overrides,
            ApplyPhase::ClientOverrides => member.phase == ArchivePhase::ClientOverrides,
            ApplyPhase::Remote => false,
        };
        if !wanted {
            continue;
        }
        let target = member.target_path.as_ref().ok_or("覆盖阶段成员缺少目标路径")?;
        if member.archive_path.is_empty()
            || member.archive_path.len() > MAX_PATH_BYTES
            || target.is_empty()
            || target.len() > MAX_PATH_BYTES
            || target.split('/').count() > MAX_DEPTH
            || member.size > MAX_PHASE_FILE
        {
            return Err("整合包覆盖阶段路径或文件大小超过预算".into());
        }
        if !archive_paths.insert(member.archive_path.clone()) {
            return Err("整合包覆盖阶段归档路径重复".into());
        }
        preflight_target(target, &expected.target_id, &mut nodes)?;
        if !target_paths.insert(target.to_lowercase()) {
            return Err("整合包覆盖阶段目标存在大小写别名冲突".into());
        }
        total = total.checked_add(member.size).ok_or("整合包覆盖阶段大小溢出")?;
        if total > MAX_PHASE_TOTAL {
            return Err("整合包覆盖阶段总大小超过 2 GiB 限制".into());
        }
        selected.push(Selected {
            archive_path: member.archive_path.clone(),
            target_path: target.clone(),
            size: member.size,
        });
        if selected.len() > MAX_PHASE_FILES {
            return Err("整合包覆盖阶段文件数量超过预算".into());
        }
    }
    Ok(selected)
}

struct LocalCheck {
    size: u64,
    hashes: BTreeMap<String, String>,
}

fn local_hashes(values: &[DeclaredHash]) -> Result<BTreeMap<String, String>> {
    let mut hashes = BTreeMap::new();
    for value in values {
        let length = match value.algorithm.as_str() {
            "sha1" => 40, "sha256" => 64, "sha512" => 128, "md5" => 32,
            _ => return Err("MCBBS 本地成员声明未知摘要算法".into()),
        };
        if value.value.len() != length || !value.value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("MCBBS 本地成员摘要格式无效".into());
        }
        let normalized = value.value.to_ascii_lowercase();
        if hashes.insert(value.algorithm.clone(), normalized.clone()).is_some_and(|old| old != normalized) {
            return Err("MCBBS 本地成员同一摘要算法存在冲突".into());
        }
    }
    Ok(hashes)
}

// remote.prepare 留给本地覆盖层的 MCBBS addon 仍须履行清单中的每一项声明。
// 同名 overrides 是原 addon；有它时不拿主动 client-overrides 覆盖的内容比原摘要。
fn local_checks(expected: &FullPackPlan, phase: &ApplyPhase, cancel: &Cancel) -> Result<BTreeMap<String, LocalCheck>> {
    let mut checks: BTreeMap<String, LocalCheck> = BTreeMap::new();
    if expected.format != SourceFormat::Mcbbs { return Ok(checks); }
    if expected.remote_files.len() > MAX_PHASE_FILES { return Err("MCBBS 本地声明数量超过预算".into()); }
    let mut overrides = BTreeMap::new();
    let mut clients = BTreeMap::new();
    for member in &expected.members {
        cancel.check()?;
        if let Some(path) = &member.target_path {
            match member.phase {
                ArchivePhase::Overrides => { overrides.insert(path.as_str(), member); },
                ArchivePhase::ClientOverrides => { clients.insert(path.as_str(), member); },
                _ => {},
            }
        }
    }
    for file in &expected.remote_files {
        cancel.check()?;
        if file.environment.client == EnvironmentStatus::Unsupported || !file.urls.is_empty()
            || file.file_api_template.is_some() || file.curse_project_id.is_some() || file.curse_file_id.is_some()
            || file.file_type.as_deref().is_some_and(|kind| kind.eq_ignore_ascii_case("curse")) {
            continue;
        }
        let path = file.path.as_deref().ok_or("MCBBS 本地成员缺少相对路径")?;
        let member = overrides.get(path).or_else(|| clients.get(path)).ok_or("MCBBS 本地成员缺少同名覆盖文件")?;
        let hashes = local_hashes(&file.hashes)?;
        if member.size > MAX_PHASE_FILE || file.size.is_some_and(|size| size != member.size) {
            return Err("MCBBS 本地成员大小与声明不一致或超过预算".into());
        }
        let wanted = match phase {
            ApplyPhase::Overrides => member.phase == ArchivePhase::Overrides,
            ApplyPhase::ClientOverrides => member.phase == ArchivePhase::ClientOverrides,
            ApplyPhase::Remote => false,
        };
        if !wanted { continue; }
        let check = checks.entry(member.archive_path.clone()).or_insert_with(|| LocalCheck { size: member.size, hashes: BTreeMap::new() });
        for (algorithm, value) in hashes {
            if check.hashes.insert(algorithm, value.clone()).is_some_and(|old| old != value) {
                return Err("MCBBS 同名本地成员摘要声明冲突".into());
            }
        }
    }
    Ok(checks)
}

fn verify_local_checks(
    archive: &mut ZipArchive<&mut File>, indices: &BTreeMap<String, (usize, u64)>,
    checks: BTreeMap<String, LocalCheck>, cancel: &Cancel,
) -> Result<()> {
    let mut total = 0u64;
    for (path, check) in checks {
        cancel.check()?;
        total = total.checked_add(check.size).ok_or("MCBBS 本地校验大小溢出")?;
        if total > MAX_PHASE_TOTAL { return Err("MCBBS 本地校验总量超过预算".into()); }
        let index = indices.get(&path).map(|(index, _)| *index).ok_or("MCBBS 本地覆盖条目丢失")?;
        let mut entry = archive.by_index(index).map_err(|_| "无法读取 MCBBS 本地覆盖文件")?;
        if entry.name() != path || entry.size() != check.size { return Err("MCBBS 本地覆盖条目与计划不一致".into()); }
        let mut sha1 = Sha1::new(); let mut sha256 = Sha256::new(); let mut sha512 = Sha512::new(); let mut md5 = md5::Context::new();
        let mut bytes = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            cancel.check()?;
            // 即使大小恰好用尽也读一次真实 EOF，让 ZipFile 传播 CRC 错误。
            let count = entry.read(&mut buffer).map_err(|_| "MCBBS 本地覆盖文件读取或 CRC 校验失败")?;
            if count == 0 { break; }
            bytes = bytes.checked_add(count as u64).ok_or("MCBBS 本地覆盖文件大小溢出")?;
            if bytes > check.size || bytes > MAX_PHASE_FILE { return Err("MCBBS 本地覆盖文件超过声明大小".into()); }
            sha1.update(&buffer[..count]); sha256.update(&buffer[..count]); sha512.update(&buffer[..count]); md5.consume(&buffer[..count]);
        }
        if bytes != check.size { return Err("MCBBS 本地覆盖文件提前结束".into()); }
        let actual = BTreeMap::from([
            ("sha1", format!("{:x}", sha1.finalize())), ("sha256", format!("{:x}", sha256.finalize())),
            ("sha512", format!("{:x}", sha512.finalize())), ("md5", format!("{:x}", md5.compute())),
        ]);
        for (algorithm, declared) in check.hashes {
            if actual.get(algorithm.as_str()) != Some(&declared) { return Err(format!("MCBBS 本地成员 {algorithm} 摘要不符")); }
        }
        cancel.check()?;
    }
    Ok(())
}

/// 将一个已授权 ZIP 的一个本地覆盖阶段写入调用者持有的安装暂存。
///
/// `expected` 必须来自同一文件的 `plan`，Stage 应以 `expected.target_id` 创建。
/// 调用方负责保留文件授权与句柄身份核验，并按 Remote → Overrides → ClientOverrides
/// 顺序调用；这个无状态回调不会记录哪个阶段已运行。函数重新进行有界解析并要求
/// 完整计划相等，然后再次打开已验证的 ZIP；计划不一致、条目缺失、CRC/大小错误或
/// 取消时，不会发布 Stage，且由调用方保留 Stage 处理失败事务。
/// 阶段预算在首次写入前检查，Stage 内已有内容与本阶段的合计仍由 Stage.write 复核。
///
/// `Remote` 阶段明确拒绝：远程文件需要上层自己的官方绑定、下载和回执流程。
/// 本函数成功只返回 `()`，绝不会调用 `finish`、`publish` 或 `cleanup`。
pub(super) fn apply(
    file: &mut File,
    source_name: &str,
    custom_name: Option<&str>,
    expected: &FullPackPlan,
    phase: ApplyPhase,
    stage: &mut Stage,
    cancel: &Cancel,
) -> Result<()> {
    cancel.check()?;
    let selected = select_phase(expected, &phase, cancel)?;

    // plan() 自身使用 parser::open_validated；同一 File 句柄被重新定位并完整复核，
    // 因而不能只相信调用方先前保存的六字段 probe 或成员列表。
    let actual = plan(file, source_name, custom_name)?;
    if actual != *expected {
        return Err("整合包计划与当前已授权文件不一致，拒绝物化".into());
    }
    cancel.check()?;
    let local_checks = local_checks(expected, &phase, cancel)?;
    let (mut archive, manifest) = open_validated(file)?;
    if manifest.prefix != expected.manifest_prefix {
        return Err("整合包清单前缀与计划不一致，拒绝物化".into());
    }

    // 先为所有普通成员建立有界索引并核对全成员清单。不能写了若干项后，才发现
    // 后面的条目缺失或大小改变；这里尚未向 Stage 写入任何数据。
    let mut indices = BTreeMap::new();
    for index in 0..archive.len() {
        cancel.check()?;
        let entry = archive.by_index(index).map_err(|_| "无法检查整合包覆盖文件")?;
        if entry.is_dir() { continue; }
        if indices.insert(entry.name().to_owned(), (index, entry.size())).is_some() {
            return Err("整合包覆盖归档路径重复".into());
        }
    }
    if indices.len() != expected.members.len() { return Err("整合包归档成员数量与计划不一致".into()); }
    for member in &expected.members {
        cancel.check()?;
        if indices.get(&member.archive_path).map(|(_, size)| *size) != Some(member.size) {
            return Err("整合包归档成员路径或大小与计划不一致".into());
        }
    }
    // 在任何 Stage.write 之前流式验证所有本阶段的本地 fallback 声明；不把
    // 错误摘要、大小或 CRC 留到已替换前面的文件后才发现。
    verify_local_checks(&mut archive, &indices, local_checks, cancel)?;
    for item in selected {
        cancel.check()?;
        let index = indices.get(&item.archive_path).map(|(index, _)| *index).ok_or("整合包缺少计划中的覆盖文件")?;
        let mut entry = archive.by_index(index).map_err(|_| "无法读取整合包覆盖文件")?;
        if entry.name() != item.archive_path || entry.size() != item.size {
            return Err("整合包覆盖文件路径或大小与计划不一致".into());
        }
        // 两种覆盖阶段都允许替换先前已由远程/覆盖阶段登记的同一路径；Stage
        // 仍会拒绝未知内容、宿主保留文件、链接和大小写别名。write 会读至 EOF，
        // 包括最终一次空读，从而传播 ZipFile 的 CRC 错误，不会提前截断校验。
        stage.write(&item.target_path, &mut entry, item.size, true, cancel)?;
    }
    cancel.check()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::{Seek, SeekFrom, Write}, path::PathBuf};
    use zip::{write::FileOptions, CompressionMethod, ZipWriter};

    struct Fixture {
        root: PathBuf,
        archive: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("hcmcl-materialize-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            let root = fs::canonicalize(root).unwrap();
            let archive = root.join("pack.zip");
            let manifest = br#"{"name":"pack","dependencies":{"minecraft":"1.20.1"},"files":[]}"#;
            let mut zip = ZipWriter::new(fs::File::create(&archive).unwrap());
            let options = FileOptions::default().compression_method(CompressionMethod::Stored);
            zip.start_file("bundle/modrinth.index.json", options).unwrap();
            zip.write_all(manifest).unwrap();
            zip.start_file("bundle/overrides/config/options.txt", options).unwrap();
            zip.write_all(b"override").unwrap();
            zip.start_file("bundle/client-overrides/config/options.txt", options).unwrap();
            zip.write_all(b"client").unwrap();
            zip.finish().unwrap();
            Self { root, archive }
        }

        fn rewrite(&self, entries: &[(&str, &[u8])]) {
            let mut zip = ZipWriter::new(File::create(&self.archive).unwrap());
            for (name, bytes) in entries {
                zip.start_file(*name, FileOptions::default().compression_method(CompressionMethod::Stored)).unwrap();
                zip.write_all(bytes).unwrap();
            }
            drop(zip.finish().unwrap());
        }

        fn apply(&self, expected: &FullPackPlan, phase: ApplyPhase, stage: &mut Stage, token: &Cancel) -> Result<()> {
            let mut file = File::open(&self.archive).unwrap();
            apply(&mut file, self.archive.to_str().unwrap(), None, expected, phase, stage, token)
        }

        fn stage(&self, _scenario: &str) -> Stage {
            // 每个场景都有独立 root；目标名严格取计划，和生产调用约定相同。
            Stage::create(&self.root, &self.plan().target_id, &Cancel::default()).unwrap()
        }

        fn plan(&self) -> FullPackPlan {
            let mut file = File::open(&self.archive).unwrap();
            plan(&mut file, self.archive.to_str().unwrap(), None).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn nested_overrides_are_streamed_and_client_phase_replaces_owned_file() {
        let fixture = Fixture::new();
        let expected = fixture.plan();
        let token = Cancel::default();
        let mut stage = fixture.stage("instance");
        let mut file = File::open(&fixture.archive).unwrap();
        apply(&mut file, fixture.archive.to_str().unwrap(), None, &expected, ApplyPhase::Overrides, &mut stage, &token).unwrap();
        let mut file = File::open(&fixture.archive).unwrap();
        apply(&mut file, fixture.archive.to_str().unwrap(), None, &expected, ApplyPhase::ClientOverrides, &mut stage, &token).unwrap();
        assert_eq!(fs::read(stage.path().join("config/options.txt")).unwrap(), b"client");
        stage.cleanup().unwrap();
    }

    #[test]
    fn pre_cancel_and_plan_change_leave_stage_unpublished() {
        let fixture = Fixture::new();
        let expected = fixture.plan();
        let token = Cancel::default();
        token.stop();
        let mut stage = fixture.stage("cancelled");
        let mut file = File::open(&fixture.archive).unwrap();
        assert!(apply(&mut file, fixture.archive.to_str().unwrap(), None, &expected, ApplyPhase::Overrides, &mut stage, &token).is_err());
        assert!(!fixture.root.join("versions/pack/config/options.txt").exists());
        stage.cleanup().unwrap();
    }

    #[test]
    fn remote_phase_is_never_materialized() {
        let fixture = Fixture::new();
        let expected = fixture.plan();
        let token = Cancel::default();
        let mut stage = fixture.stage("remote");
        let mut file = File::open(&fixture.archive).unwrap();
        assert!(apply(&mut file, fixture.archive.to_str().unwrap(), None, &expected, ApplyPhase::Remote, &mut stage, &token).is_err());
        stage.cleanup().unwrap();
    }

    #[test]
    fn corrupt_archive_or_missing_plan_member_is_rejected_before_publish() {
        let fixture = Fixture::new();
        let mut expected = fixture.plan();
        expected.members.retain(|member| member.target_path.is_none());
        let token = Cancel::default();
        let mut stage = fixture.stage("invalid");
        let mut file = File::open(&fixture.archive).unwrap();
        assert!(apply(&mut file, fixture.archive.to_str().unwrap(), None, &expected, ApplyPhase::Overrides, &mut stage, &token).is_err());
        stage.cleanup().unwrap();
    }

    #[test]
    fn four_manifest_sources_materialize_only_nested_expected_members() {
        let definitions: [(&str, &[u8]); 4] = [
            ("modrinth.index.json", br#"{"name":"pack","dependencies":{"minecraft":"1.20.1"},"files":[]}"#),
            ("manifest.json", br#"{"name":"pack","minecraft":{"version":"1.20.1"},"files":[]}"#),
            ("mcbbs.packmeta", br#"{"name":"pack","addons":{"game":"1.20.1"},"files":[]}"#),
            ("launcher.packmeta", br#"{"name":"pack","game_version":"1.20.1"}"#),
        ];
        for (manifest_name, manifest) in definitions {
            let fixture = Fixture::new();
            let nested = format!("bundle/{manifest_name}");
            fixture.rewrite(&[
                (&nested, manifest),
                ("bundle/overrides/config/selected.txt", b"chosen"),
                ("bundle/client-overrides/config/client.txt", b"later"),
                ("overrides/config/outside-prefix.txt", b"excluded"),
                ("bundle/unscoped.txt", b"metadata"),
            ]);
            let expected = fixture.plan();
            let mut stage = fixture.stage("format");
            fixture.apply(&expected, ApplyPhase::Overrides, &mut stage, &Cancel::default()).unwrap();
            assert_eq!(fs::read(stage.path().join("config/selected.txt")).unwrap(), b"chosen");
            assert!(!stage.path().join("config/client.txt").exists());
            assert!(!stage.path().join("config/outside-prefix.txt").exists());
            assert!(!stage.path().join("unscoped.txt").exists());
            assert!(!fixture.root.join("versions/pack").exists());
            stage.cleanup().unwrap();
        }
    }

    #[test]
    fn remote_then_override_then_client_precedence_does_not_publish() {
        let fixture = Fixture::new();
        let expected = fixture.plan();
        let token = Cancel::default();
        let mut stage = fixture.stage("precedence");
        stage.write("config/options.txt", &b"remote"[..], 6, false, &token).unwrap();
        fixture.apply(&expected, ApplyPhase::Overrides, &mut stage, &token).unwrap();
        assert_eq!(fs::read(stage.path().join("config/options.txt")).unwrap(), b"override");
        fixture.apply(&expected, ApplyPhase::ClientOverrides, &mut stage, &token).unwrap();
        assert_eq!(fs::read(stage.path().join("config/options.txt")).unwrap(), b"client");
        assert!(!fixture.root.join("versions/pack").exists());
        // apply 没有擅自 finish；调用方仍可继续登记自己的普通文件。
        stage.write("after.txt", &b"ok"[..], 2, false, &token).unwrap();
        stage.cleanup().unwrap();
    }

    #[test]
    fn corrupt_member_crc_is_reported_without_replacing_prior_owned_content() {
        let fixture = Fixture::new();
        let expected = fixture.plan();
        let offset = {
            let mut archive = zip::ZipArchive::new(File::open(&fixture.archive).unwrap()).unwrap();
            let entry = archive.by_name("bundle/overrides/config/options.txt").unwrap();
            entry.data_start()
        };
        // 只改 Stored 数据，不更改 size/清单或 CRC，因此同一计划仍可解析，实际读取必须失败。
        let mut file = fs::OpenOptions::new().write(true).open(&fixture.archive).unwrap();
        file.seek(SeekFrom::Start(offset)).unwrap();
        file.write_all(b"X").unwrap();
        file.sync_all().unwrap();
        drop(file);
        assert_eq!(fixture.plan(), expected);
        let mut stage = fixture.stage("crc");
        let token = Cancel::default();
        stage.write("config/options.txt", &b"original"[..], 8, false, &token).unwrap();
        assert!(fixture.apply(&expected, ApplyPhase::Overrides, &mut stage, &token).is_err());
        assert_eq!(fs::read(stage.path().join("config/options.txt")).unwrap(), b"original");
        assert!(!fixture.root.join("versions/pack").exists());
        stage.cleanup().unwrap();
    }

    #[test]
    fn deflated_multichunk_and_empty_entries_reach_stage_without_buffering_archive() {
        let fixture = Fixture::new();
        let bytes: Vec<u8> = (0..(192 * 1024)).map(|index| (index % 251) as u8).collect();
        let mut zip = ZipWriter::new(File::create(&fixture.archive).unwrap());
        let options = FileOptions::default().compression_method(CompressionMethod::Deflated);
        zip.start_file("bundle/launcher.packmeta", options).unwrap();
        zip.write_all(br#"{"name":"pack","game_version":"1.20.1"}"#).unwrap();
        zip.start_file("bundle/overrides/config/large.bin", options).unwrap();
        zip.write_all(&bytes).unwrap();
        zip.start_file("bundle/overrides/config/empty.txt", options).unwrap();
        drop(zip.finish().unwrap());
        let expected = fixture.plan();
        let mut stage = fixture.stage("deflated");
        fixture.apply(&expected, ApplyPhase::Overrides, &mut stage, &Cancel::default()).unwrap();
        assert_eq!(fs::read(stage.path().join("config/large.bin")).unwrap(), bytes);
        assert_eq!(fs::metadata(stage.path().join("config/empty.txt")).unwrap().len(), 0);
        stage.cleanup().unwrap();
    }

    #[test]
    fn all_host_paths_are_rejected_before_any_phase_write() {
        let manifest = br#"{"name":"pack","game_version":"1.20.1"}"#;
        for forbidden in ["instance.json", "pack.json", "natives/lib.so", ".hcmcl-modpack-stage-owner", "config/.hcmcl-modpack-write-evil"] {
            let fixture = Fixture::new();
            let bad = format!("bundle/overrides/{forbidden}");
            fixture.rewrite(&[("bundle/launcher.packmeta", manifest), ("bundle/overrides/config/first.txt", b"first"), (&bad, b"bad")]);
            let expected = fixture.plan();
            let mut stage = fixture.stage("host");
            assert!(fixture.apply(&expected, ApplyPhase::Overrides, &mut stage, &Cancel::default()).is_err(), "{forbidden}");
            assert!(!stage.path().join("config/first.txt").exists());
            stage.cleanup().unwrap();
        }
    }

    #[test]
    fn invalid_paths_aliases_and_file_directory_conflicts_are_rejected() {
        let manifest = br#"{"name":"pack","game_version":"1.20.1"}"#;
        let fixture = Fixture::new();
        for bad in ["bundle/overrides/../escape", "bundle/overrides/C:/escape", "bundle/overrides/CON.txt"] {
            fixture.rewrite(&[("bundle/launcher.packmeta", manifest), (bad, b"bad")]);
            assert!(plan(&mut File::open(&fixture.archive).unwrap(), "pack.zip", None).is_err());
        }
        fixture.rewrite(&[("bundle/launcher.packmeta", manifest), ("bundle/overrides/config/base", b"base")]);
        let expected = fixture.plan();
        let base = expected.members.iter().find(|member| member.phase == ArchivePhase::Overrides).unwrap().clone();
        for targets in [vec!["config/A", "config/a"], vec!["config/a", "config/a/b"], vec!["Config/a", "config/b"]] {
            let mut changed = expected.clone();
            changed.members.retain(|member| member.phase != ArchivePhase::Overrides);
            for (index, target) in targets.iter().enumerate() {
                let mut item = base.clone(); item.archive_path = format!("bundle/overrides/test{index}"); item.target_path = Some((*target).into()); changed.members.push(item);
            }
            assert!(select_phase(&changed, &ApplyPhase::Overrides, &Cancel::default()).is_err());
        }
    }

    #[test]
    fn real_archive_changes_are_rejected_before_first_write() {
        let fixture = Fixture::new();
        let expected = fixture.plan();
        let manifest = br#"{"name":"pack","dependencies":{"minecraft":"1.20.1"},"files":[]}"#;
        fixture.rewrite(&[("bundle/modrinth.index.json", manifest), ("bundle/overrides/config/options.txt", b"changed-size")]);
        let mut stage = fixture.stage("changed");
        assert!(fixture.apply(&expected, ApplyPhase::Overrides, &mut stage, &Cancel::default()).is_err());
        assert!(!stage.path().join("config").exists());
        assert!(!fixture.root.join("versions/pack").exists());
        stage.cleanup().unwrap();
    }

    #[test]
    fn cross_phase_case_alias_and_existing_file_directory_conflict_keep_prior_file() {
        let fixture = Fixture::new();
        let manifest = br#"{"name":"pack","game_version":"1.20.1"}"#;
        fixture.rewrite(&[
            ("bundle/launcher.packmeta", manifest),
            ("bundle/overrides/config/a.txt", b"first"),
            ("bundle/client-overrides/config/A.txt", b"second"),
        ]);
        let expected = fixture.plan();
        let token = Cancel::default();
        let mut stage = fixture.stage("alias");
        fixture.apply(&expected, ApplyPhase::Overrides, &mut stage, &token).unwrap();
        assert!(fixture.apply(&expected, ApplyPhase::ClientOverrides, &mut stage, &token).is_err());
        assert_eq!(fs::read(stage.path().join("config/a.txt")).unwrap(), b"first");
        stage.cleanup().unwrap();

        let fixture = Fixture::new();
        let expected = fixture.plan();
        let mut stage = fixture.stage("directory-conflict");
        stage.write("config", &b"prior"[..], 5, false, &token).unwrap();
        assert!(fixture.apply(&expected, ApplyPhase::Overrides, &mut stage, &token).is_err());
        assert_eq!(fs::read(stage.path().join("config")).unwrap(), b"prior");
        stage.cleanup().unwrap();
    }

    #[test]
    fn phase_budgets_and_order_are_preflighted_without_allocating_payloads() {
        let fixture = Fixture::new();
        let expected = fixture.plan();
        let base = expected.members.iter().find(|member| member.phase == ArchivePhase::Overrides).unwrap().clone();
        let mut changed = expected.clone();
        changed.members.iter_mut().find(|member| member.phase == ArchivePhase::Overrides).unwrap().size = MAX_PHASE_FILE + 1;
        assert!(select_phase(&changed, &ApplyPhase::Overrides, &Cancel::default()).is_err());
        changed = expected.clone(); changed.members.retain(|member| member.phase != ArchivePhase::Overrides);
        for index in 0..9 {
            let mut item = base.clone(); item.archive_path = format!("bundle/overrides/f{index}"); item.target_path = Some(format!("config/f{index}")); item.size = MAX_PHASE_FILE; changed.members.push(item);
        }
        assert!(select_phase(&changed, &ApplyPhase::Overrides, &Cancel::default()).is_err());
        changed = expected.clone(); changed.apply_order.reverse();
        assert!(select_phase(&changed, &ApplyPhase::Overrides, &Cancel::default()).is_err());
    }

    #[test]
    fn mcbbs_local_fallback_checks_all_hashes_and_keeps_client_override_priority() {
        let bytes = b"addon";
        let manifest = serde_json::to_vec(&serde_json::json!({
            "name":"pack", "addons":{"game":"1.20.1"}, "files":[{
                "type":"addon", "path":"config/addon.bin", "size":bytes.len(),
                "hashes":{
                    "sha1":format!("{:x}", Sha1::digest(bytes)).to_ascii_uppercase(),
                    "sha256":format!("{:x}", Sha256::digest(bytes)),
                    "sha512":format!("{:x}", Sha512::digest(bytes)),
                    "md5":format!("{:x}", md5::compute(bytes))
                }
            }]
        })).unwrap();
        let fixture = Fixture::new();
        fixture.rewrite(&[
            ("bundle/mcbbs.packmeta", &manifest),
            ("bundle/overrides/config/addon.bin", bytes),
            ("bundle/client-overrides/config/addon.bin", b"client-custom"),
        ]);
        let expected = fixture.plan(); let token = Cancel::default(); let mut stage = fixture.stage("mcbbs-hashes");
        fixture.apply(&expected, ApplyPhase::Overrides, &mut stage, &token).unwrap();
        fixture.apply(&expected, ApplyPhase::ClientOverrides, &mut stage, &token).unwrap();
        assert_eq!(fs::read(stage.path().join("config/addon.bin")).unwrap(), b"client-custom");
        stage.cleanup().unwrap();

        // 只有没有 overrides 时才校验 client-overrides；无摘要的历史本地项仍可用。
        let fixture = Fixture::new();
        let manifest = br#"{"name":"pack","addons":{"game":"1.20.1"},"files":[{"type":"addon","path":"config/empty.txt","size":0}]}"#;
        fixture.rewrite(&[("bundle/mcbbs.packmeta", manifest), ("bundle/client-overrides/config/empty.txt", b"")]);
        let expected = fixture.plan(); let mut stage = fixture.stage("mcbbs-client");
        fixture.apply(&expected, ApplyPhase::Overrides, &mut stage, &token).unwrap();
        fixture.apply(&expected, ApplyPhase::ClientOverrides, &mut stage, &token).unwrap();
        assert_eq!(fs::metadata(stage.path().join("config/empty.txt")).unwrap().len(), 0);
        stage.cleanup().unwrap();
    }

    #[test]
    fn mcbbs_bad_hash_algorithm_format_size_or_any_digest_rejects_before_first_write() {
        let bytes = b"addon";
        let sha1 = format!("{:x}", Sha1::digest(bytes));
        let sha256 = format!("{:x}", Sha256::digest(bytes));
        for (hashes, size) in [
            (serde_json::json!({"sha1":sha1,"sha256":"0".repeat(64)}), 5),
            (serde_json::json!({"sha1":"0".repeat(40),"sha256":sha256}), 5),
            (serde_json::json!({"sha512":"0".repeat(128)}), 5),
            (serde_json::json!({"md5":"0".repeat(32)}), 5),
            (serde_json::json!({"sha3":"0".repeat(64)}), 5),
            (serde_json::json!({"sha1":"xyz"}), 5),
            (serde_json::json!({"sha1":sha1}), 6),
        ] {
            let fixture = Fixture::new();
            let manifest = serde_json::to_vec(&serde_json::json!({"name":"pack","addons":{"game":"1.20.1"},"files":[{"type":"addon","path":"config/addon.bin","size":size,"hashes":hashes}]})).unwrap();
            fixture.rewrite(&[
                ("bundle/mcbbs.packmeta", &manifest),
                ("bundle/overrides/config/first.txt", b"first"),
                ("bundle/overrides/config/addon.bin", bytes),
            ]);
            let expected = fixture.plan(); let mut stage = fixture.stage("mcbbs-invalid"); let token = Cancel::default();
            stage.write("config/addon.bin", &b"prior"[..], 5, false, &token).unwrap();
            assert!(fixture.apply(&expected, ApplyPhase::Overrides, &mut stage, &token).is_err());
            assert!(!stage.path().join("config/first.txt").exists());
            assert_eq!(fs::read(stage.path().join("config/addon.bin")).unwrap(), b"prior");
            stage.cleanup().unwrap();
        }
    }

    #[test]
    fn mcbbs_local_crc_failure_rejects_before_first_write_even_without_hashes() {
        let fixture = Fixture::new();
        let manifest = br#"{"name":"pack","addons":{"game":"1.20.1"},"files":[{"type":"addon","path":"config/addon.bin"}]}"#;
        fixture.rewrite(&[
            ("bundle/mcbbs.packmeta", manifest),
            ("bundle/overrides/config/first.txt", b"first"),
            ("bundle/overrides/config/addon.bin", b"addon"),
        ]);
        let expected = fixture.plan();
        let offset = {
            let mut zip = zip::ZipArchive::new(File::open(&fixture.archive).unwrap()).unwrap();
            let entry = zip.by_name("bundle/overrides/config/addon.bin").unwrap(); entry.data_start()
        };
        let mut file = fs::OpenOptions::new().write(true).open(&fixture.archive).unwrap();
        file.seek(SeekFrom::Start(offset)).unwrap(); file.write_all(b"X").unwrap(); file.sync_all().unwrap(); drop(file);
        let mut stage = fixture.stage("mcbbs-crc");
        assert!(fixture.apply(&expected, ApplyPhase::Overrides, &mut stage, &Cancel::default()).is_err());
        assert!(!stage.path().join("config/first.txt").exists());
        assert!(!stage.path().join("config/addon.bin").exists());
        stage.cleanup().unwrap();
    }

    #[test]
    fn unknown_stage_child_is_preserved_on_write_refusal() {
        let fixture = Fixture::new();
        let expected = fixture.plan();
        let mut stage = fixture.stage("unknown");
        fs::create_dir(stage.path().join("config")).unwrap();
        fs::write(stage.path().join("config/options.txt"), b"winner").unwrap();
        assert!(fixture.apply(&expected, ApplyPhase::Overrides, &mut stage, &Cancel::default()).is_err());
        assert_eq!(fs::read(stage.path().join("config/options.txt")).unwrap(), b"winner");
        // 未知文件不归 Stage 所有；夹具自己撤回该文件后，调用者才可以继续清理自有暂存。
        fs::remove_file(stage.path().join("config/options.txt")).unwrap();
        fs::remove_dir(stage.path().join("config")).unwrap();
        stage.cleanup().unwrap();
    }
}

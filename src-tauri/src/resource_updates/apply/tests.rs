//! 正常业务计划夹具：真实本地清单与纯计划转换，不执行下载、批准或文件事务。
use super::*;
use crate::resource_updates::model::{LocalQuery, ResourceKind, UpdateInfo};
use sha1::Sha1;
use sha2::{Digest, Sha512};
use std::{fs, io::Write};
use zip::{write::FileOptions, ZipWriter};

struct Fixture {
    root: PathBuf,
    isolated: bool,
}

impl Fixture {
    fn new(isolated: bool, main_enabled: bool) -> Self {
        let path = std::env::temp_dir().join(format!("hcmcl-update-plan-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(path.join("versions/fixture")).unwrap();
        let root = fs::canonicalize(path).unwrap();
        let version = root.join("versions/fixture");
        let profile = json!({
            "id": "fixture", "clientVersion": "1.20.1",
            "mainClass": "net.fabricmc.loader.impl.launch.knot.KnotClient",
            "libraries": [{"name": "net.fabricmc:fabric-loader:0.16.0"}]
        });
        fs::write(version.join("fixture.json"), serde_json::to_vec(&profile).unwrap()).unwrap();
        if isolated {
            fs::write(version.join("instance.json"), br#"{"isolation":true}"#).unwrap();
        }
        let fixture = Self { root, isolated };
        for kind in [ResourceKind::Mod, ResourceKind::ResourcePack, ResourceKind::Shader] {
            fs::create_dir_all(fixture.directory(kind)).unwrap();
        }
        let main = if main_enabled { "primary.jar" } else { "primary.jar.disabled" };
        fixture.archive(ResourceKind::Mod, main, "fabric.mod.json", br#"{"id":"primary","version":"1.0"}"#);
        fixture.archive(ResourceKind::Mod, "secondary.jar", "fabric.mod.json", br#"{"id":"secondary","version":"1.0"}"#);
        fixture.archive(ResourceKind::Mod, "library.jar.disabled", "fabric.mod.json", br#"{"id":"library","version":"1.0"}"#);
        for kind in [ResourceKind::ResourcePack, ResourceKind::Shader] {
            let metadata = if kind == ResourceKind::ResourcePack { "pack.mcmeta" } else { "shaders/shaders.properties" };
            fixture.archive(kind, "primary.zip", metadata, b"{}");
            fixture.archive(kind, "secondary.zip", metadata, b"{}");
        }
        fixture
    }

    fn directory(&self, kind: ResourceKind) -> PathBuf {
        let parent = if self.isolated { self.root.join("versions/fixture") } else { self.root.clone() };
        parent.join(match kind {
            ResourceKind::Mod => "mods",
            ResourceKind::ResourcePack => "resourcepacks",
            ResourceKind::Shader => "shaderpacks",
        })
    }

    fn archive(&self, kind: ResourceKind, filename: &str, entry: &str, bytes: &[u8]) {
        let mut archive = ZipWriter::new(fs::File::create(self.directory(kind).join(filename)).unwrap());
        archive.start_file(entry, FileOptions::default()).unwrap();
        archive.write_all(bytes).unwrap();
        archive.finish().unwrap();
    }

    fn settings(&self) -> Value {
        json!({"gameDirAbs": self.root, "selectedVersionDirId": "default", "mode": "normal"})
    }

    fn selection(&self, kind: ResourceKind, filename: &str) -> Selection {
        self.selection_with_settings(kind, filename, &self.settings())
    }

    fn selection_with_settings(&self, kind: ResourceKind, filename: &str, settings: &Value) -> Selection {
        let next_filename = if kind == ResourceKind::Mod { "primary-2.jar" } else { "primary-2.zip" };
        let update = UpdateInfo {
            path: self.directory(kind).join(filename).to_str().unwrap().to_owned(), kind,
            current_version: "1.0".into(), latest_version: "2.0".into(),
            file_url: remote_url(next_filename), filename: next_filename.into(),
            size: NEXT_BYTES.len() as u64, slug: "fixture-project".into(), title: "示例资源".into(),
        };
        let request = ApplyRequest::parse(&[json!("fixture"), json!(update), json!(!filename.ends_with(".disabled"))]).unwrap();
        Selection::scan(&self.root, request, settings, &AtomicBool::new(false)).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

const NEXT_BYTES: &[u8] = b"next-version-content";

fn remote_url(filename: &str) -> String {
    format!("https://cdn.modrinth.com/data/fixture/versions/next/{filename}")
}

fn remote_file(kind: ResourceKind, filename: &str, version: &str, bytes: &[u8]) -> VerifiedFile {
    let sha1 = format!("{:x}", Sha1::digest(bytes));
    let sha512 = format!("{:x}", Sha512::digest(bytes));
    VerifiedFile {
        source: "modrinth".into(), project_id: "fixture-project".into(), version_id: version.into(),
        title: "示例资源".into(), version: "2.0".into(),
        download: catalog::resource_update_test_download(kind.as_str(), filename, bytes.len() as u64, &sha1, &sha512),
    }
}

fn prepared(selection: &Selection) -> PreparedUpdate {
    PreparedUpdate {
        requested: selection.request.update.clone(),
        changes: vec![PlannedChange::Replace {
            old: selection.query().clone(),
            file: remote_file(selection.query().kind, &selection.request.update.filename, "next", NEXT_BYTES),
        }],
    }
}

fn member(selection: &Selection, kind: ResourceKind, filename: &str) -> LocalQuery {
    selection.inventory.items.iter().find(|item| {
        item.query.kind == kind && item.query.path.file_name().and_then(|name| name.to_str()) == Some(filename)
    }).expect("真实扫描中存在指定本地成员").query.clone()
}

fn expected_old(query: &LocalQuery) -> OldFile {
    OldFile { leaf: query.path.file_name().unwrap().to_str().unwrap().into(), size: query.size, sha512: query.sha512.clone() }
}

fn expected_new(file: &VerifiedFile, filename: &str) -> NewFile {
    let metadata = catalog::pack_bound_metadata(&file.download);
    NewFile { leaf: filename.into(), size: metadata.size, sha1: metadata.sha1, sha512: metadata.sha512 }
}

#[test]
fn enabled_primary_replace_uses_scanned_old_and_verified_new_in_shared_or_isolated_directory() {
    for isolated in [false, true] {
        let fixture = Fixture::new(isolated, true);
        let selection = fixture.selection(ResourceKind::Mod, "primary.jar");
        let original = fs::read(&selection.query().path).unwrap();
        let prepared = prepared(&selection);
        let primary = match &prepared.changes[0] { PlannedChange::Replace { file, .. } => file, _ => unreachable!() };
        let plan = super::plan(&selection, &prepared, "primary-update").unwrap();
        assert_eq!(plan.changes, vec![Change::Replace {
            old: expected_old(selection.query()), new: expected_new(primary, "primary-2.jar"),
        }]);
        assert_eq!(plan.destination, fixture.directory(ResourceKind::Mod).join("primary-2.jar"));
        assert_eq!(plan.downloads.len(), 1);
        assert_eq!(plan.downloads[0].0, 0);
        assert_eq!(plan.downloads[0].1.version_id, "next");
        assert_eq!(catalog::pack_bound_metadata(&plan.downloads[0].1.download), catalog::pack_bound_metadata(&primary.download));
        assert_eq!(fs::read(&selection.query().path).unwrap(), original);
        assert!(!plan.destination.exists());
        selection.verify(&fixture.settings(), &AtomicBool::new(false)).unwrap();
    }
}

#[test]
fn disabled_mod_replacements_keep_disabled_suffix_while_new_dependency_is_enabled() {
    let fixture = Fixture::new(false, false);
    let selection = fixture.selection(ResourceKind::Mod, "primary.jar.disabled");
    let disabled = member(&selection, ResourceKind::Mod, "library.jar.disabled");
    let replacement = remote_file(ResourceKind::Mod, "library-2.jar", "library-next", b"library next");
    let install = remote_file(ResourceKind::Mod, "added.jar", "added", b"new dependency");
    let mut prepared = prepared(&selection);
    prepared.changes.push(PlannedChange::Replace { old: disabled.clone(), file: replacement.clone() });
    prepared.changes.push(PlannedChange::Install { file: install.clone() });
    let plan = super::plan(&selection, &prepared, "disabled-update").unwrap();
    assert_eq!(plan.destination, fixture.directory(ResourceKind::Mod).join("primary-2.jar.disabled"));
    assert!(matches!(&plan.changes[0], Change::Replace { new, .. } if new.leaf == "primary-2.jar.disabled"));
    assert_eq!(plan.changes[1], Change::Replace {
        old: expected_old(&disabled), new: expected_new(&replacement, "library-2.jar.disabled"),
    });
    assert_eq!(plan.changes[2], Change::Install { new: expected_new(&install, "added.jar") });
    assert_eq!(plan.downloads.iter().map(|(index, _)| *index).collect::<Vec<_>>(), vec![0, 1, 2]);
}

#[test]
fn pack_and_shader_plans_keep_all_changes_in_the_selected_kind_and_directory() {
    let fixture = Fixture::new(false, true);
    for kind in [ResourceKind::ResourcePack, ResourceKind::Shader] {
        let selection = fixture.selection(kind, "primary.zip");
        let secondary = member(&selection, kind, "secondary.zip");
        let replacement = remote_file(kind, "secondary-2.zip", "secondary-next", b"secondary next");
        let install = remote_file(kind, "added.zip", "added", b"new pack");
        let mut prepared = prepared(&selection);
        prepared.changes.push(PlannedChange::Replace { old: secondary.clone(), file: replacement.clone() });
        prepared.changes.push(PlannedChange::Install { file: install.clone() });
        let plan = super::plan(&selection, &prepared, "pack-update").unwrap();
        assert_eq!(plan.destination, fixture.directory(kind).join("primary-2.zip"));
        assert_eq!(plan.changes[1], Change::Replace { old: expected_old(&secondary), new: expected_new(&replacement, "secondary-2.zip") });
        assert_eq!(plan.changes[2], Change::Install { new: expected_new(&install, "added.zip") });
        assert_eq!(plan.downloads.iter().map(|(index, _)| *index).collect::<Vec<_>>(), vec![0, 1, 2]);
        assert!(plan.downloads.iter().all(|(_, file)| catalog::pack_bound_metadata(&file.download).kind == kind.as_str()));

        let mut other_kind = prepared.clone();
        other_kind.changes.push(PlannedChange::Install {
            file: remote_file(ResourceKind::Mod, "unrelated.jar", "unrelated", b"other kind"),
        });
        assert!(super::plan(&selection, &other_kind, "pack-update").is_err());
    }
}

#[test]
fn existing_disabled_dependency_is_enabled_without_adding_a_download_slot() {
    let fixture = Fixture::new(false, true);
    let selection = fixture.selection(ResourceKind::Mod, "primary.jar");
    let disabled = member(&selection, ResourceKind::Mod, "library.jar.disabled");
    let original = fs::read(&disabled.path).unwrap();
    let mut prepared = prepared(&selection);
    prepared.changes.push(PlannedChange::Enable { old: disabled.clone() });
    let plan = super::plan(&selection, &prepared, "enable-local").unwrap();
    assert_eq!(plan.changes[1], Change::Enable { old: expected_old(&disabled), target_leaf: "library.jar".into() });
    assert_eq!(plan.downloads.len(), 1);
    assert_eq!(plan.downloads[0].0, 0);
    assert_eq!(fs::read(&disabled.path).unwrap(), original);
    assert!(!fixture.directory(ResourceKind::Mod).join("library.jar").exists());
}

#[test]
fn the_first_replace_must_target_the_selected_inventory_member_and_requested_update() {
    let fixture = Fixture::new(false, true);
    let selection = fixture.selection(ResourceKind::Mod, "primary.jar");
    let mut prepared = prepared(&selection);
    assert!(super::plan(&selection, &prepared, "main-replace").is_ok());
    let secondary = member(&selection, ResourceKind::Mod, "secondary.jar");
    if let PlannedChange::Replace { old, .. } = &mut prepared.changes[0] { *old = secondary; }
    assert_eq!(super::plan(&selection, &prepared, "main-replace").err().unwrap(), CHANGED);

    let mut changed_request = self::prepared(&selection);
    changed_request.requested.latest_version = "3.0".into();
    assert_eq!(super::plan(&selection, &changed_request, "main-replace").err().unwrap(), CHANGED);
}

#[test]
fn plan_digest_is_repeatable_and_binds_task_order_remote_identity_and_content() {
    let fixture = Fixture::new(false, true);
    let selection = fixture.selection(ResourceKind::Mod, "primary.jar");
    let mut prepared = prepared(&selection);
    prepared.changes.push(PlannedChange::Install {
        file: remote_file(ResourceKind::Mod, "alpha.jar", "alpha", b"dependency alpha"),
    });
    prepared.changes.push(PlannedChange::Install {
        file: remote_file(ResourceKind::Mod, "beta.jar", "beta", b"dependency beta"),
    });
    let baseline = super::plan(&selection, &prepared, "digest-task").unwrap();
    assert_eq!(baseline.digest.len(), 64);
    assert!(baseline.digest.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_eq!(super::plan(&selection, &prepared, "digest-task").unwrap().digest, baseline.digest);
    assert_ne!(super::plan(&selection, &prepared, "another-task").unwrap().digest, baseline.digest);

    let mut reordered = prepared.clone();
    reordered.changes.swap(1, 2);
    let reordered = super::plan(&selection, &reordered, "digest-task").unwrap();
    assert_eq!(reordered.downloads[1].1.version_id, "beta");
    assert_ne!(reordered.digest, baseline.digest);

    for field in ["project", "version", "title", "label"] {
        let mut changed = prepared.clone();
        if let PlannedChange::Replace { file, .. } = &mut changed.changes[0] {
            match field {
                "project" => file.project_id = "another-project".into(),
                "version" => file.version_id = "another-version".into(),
                "title" => file.title = "更新后的资源标题".into(),
                "label" => file.version = "2.0.1".into(),
                _ => unreachable!(),
            }
        }
        assert_ne!(super::plan(&selection, &changed, "digest-task").unwrap().digest, baseline.digest, "{field}");
    }

    let mut changed_content = prepared.clone();
    if let PlannedChange::Install { file } = &mut changed_content.changes[1] {
        // 等长内容仅改变摘要，文件名、大小和官方身份均保持原样。
        *file = remote_file(ResourceKind::Mod, "alpha.jar", "alpha", b"dependency ALPHA");
    }
    let changed_content = super::plan(&selection, &changed_content, "digest-task").unwrap();
    assert_eq!(catalog::pack_bound_metadata(&changed_content.downloads[1].1.download).size,
        catalog::pack_bound_metadata(&baseline.downloads[1].1.download).size);
    assert_ne!(changed_content.digest, baseline.digest);
}

#[test]
fn plan_digest_binds_selected_root_and_policy_even_when_file_changes_are_identical() {
    let fixture = Fixture::new(false, true);
    let selection = fixture.selection(ResourceKind::Mod, "primary.jar");
    let baseline = super::plan(&selection, &prepared(&selection), "scope-task").unwrap();
    let mut settings = fixture.settings();
    settings["selectedVersionDirId"] = json!("same-root-alias");
    settings["versionDirs"] = json!([{"id": "same-root-alias", "path": fixture.root}]);
    let alias = fixture.selection_with_settings(ResourceKind::Mod, "primary.jar", &settings);
    let alias_plan = super::plan(&alias, &prepared(&alias), "scope-task").unwrap();
    assert_eq!(alias.root(), selection.root());
    assert_eq!(alias_plan.changes, baseline.changes);
    assert_eq!(alias_plan.destination, baseline.destination);
    assert_ne!(alias.policy(), selection.policy());
    assert_ne!(alias_plan.digest, baseline.digest);

    let other_fixture = Fixture::new(false, true);
    let other = other_fixture.selection(ResourceKind::Mod, "primary.jar");
    let other_plan = super::plan(&other, &prepared(&other), "scope-task").unwrap();
    assert_ne!(other.root(), selection.root());
    assert_ne!(other_plan.destination, baseline.destination);
    assert_ne!(other_plan.digest, baseline.digest);
}

#[test]
fn scanned_plan_applies_real_multi_file_transaction_and_cleans_after_commit_or_cancel() {
    // 此夹具串联真实清单、计划与文件事务；官方 HTTP 和原生批准分别由各自夹具覆盖。
    for isolated in [false, true] {
        for cancelled in [false, true] {
            let fixture = Fixture::new(isolated, false);
            let _guard = install_lock::acquire_blocking(&fixture.root).unwrap();
            let selection = fixture.selection(ResourceKind::Mod, "primary.jar.disabled");
            let disabled = member(&selection, ResourceKind::Mod, "library.jar.disabled");
            let primary_old = fs::read(&selection.query().path).unwrap();
            let local_old = fs::read(&disabled.path).unwrap();
            let mut prepared = prepared(&selection);
            prepared.changes.push(PlannedChange::Install {
                file: remote_file(ResourceKind::Mod, "added.jar", "added", b"added resource"),
            });
            prepared.changes.push(PlannedChange::Enable { old: disabled.clone() });
            let plan = super::plan(&selection, &prepared, "real-plan-transaction").unwrap();
            let mut stage = UpdateStage::create(&fixture.root, selection.directory().unwrap(), plan.changes, &AtomicBool::new(false)).unwrap();
            for (index, file) in &plan.downloads {
                let metadata = catalog::pack_bound_metadata(&file.download);
                let bytes = if metadata.filename == "added.jar" { b"added resource".as_slice() } else { NEXT_BYTES };
                let mut output = stage.take_file(*index).unwrap();
                output.write_all(bytes).unwrap(); output.sync_all().unwrap(); drop(output);
                stage.seal(*index, &AtomicBool::new(false)).unwrap();
            }
            selection.verify(&fixture.settings(), &AtomicBool::new(false)).unwrap();
            let outcome = stage.commit(&AtomicBool::new(cancelled));
            assert_eq!(outcome.is_err(), cancelled);
            assert!(!stage.settled()); stage.cleanup().unwrap(); assert!(stage.settled());
            assert!(!transaction::pending_under_guard(&fixture.root).unwrap());
            let directory = fixture.directory(ResourceKind::Mod);
            if cancelled {
                assert_eq!(fs::read(selection.query().path.clone()).unwrap(), primary_old);
                assert_eq!(fs::read(disabled.path.clone()).unwrap(), local_old);
                assert!(!plan.destination.exists()); assert!(!directory.join("added.jar").exists());
                assert!(!directory.join("library.jar").exists());
            } else {
                assert_eq!(fs::read(plan.destination).unwrap(), NEXT_BYTES);
                assert_eq!(fs::read(directory.join("added.jar")).unwrap(), b"added resource");
                assert_eq!(fs::read(directory.join("library.jar")).unwrap(), local_old);
                assert!(!selection.query().path.exists()); assert!(!disabled.path.exists());
            }
        }
    }
}

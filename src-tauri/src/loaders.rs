use serde_json::{json, Map, Value};
use std::{fs, path::{Path, PathBuf}, sync::Arc};
use tauri::Emitter;

use crate::{downloads::{self, Cancel, JobGuard, Progress}, install_lock};

type Result<T> = std::result::Result<T, String>;

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn kind(value: &str) -> Result<&str> {
    match value {
        "fabric" | "quilt" => Ok(value),
        "forge" | "neoforge" => Err("Forge / NeoForge 安装器尚未完成 Tauri 适配".into()),
        _ => Err("未知加载器类型".into()),
    }
}

fn text_arg(args: &[Value], index: usize, label: &str, required: bool) -> Result<String> {
    match args.get(index) {
        Some(Value::String(value)) if value.len() <= 240 && !value.chars().any(char::is_control) && (!required || !value.is_empty()) => Ok(value.clone()),
        Some(Value::Null) | None if !required => Ok(String::new()),
        _ => Err(format!("{label}参数无效")),
    }
}

fn versions(value: Value) -> Result<Vec<String>> {
    let list = value.as_array().ok_or("加载器版本响应不是数组")?;
    if list.len() > 2000 { return Err("加载器版本数量过多".into()); }
    let mut out = Vec::with_capacity(list.len());
    for entry in list {
        let version = entry.get("loader").and_then(|v| v.get("version")).and_then(Value::as_str)
            .or_else(|| entry.get("version").and_then(Value::as_str)).ok_or("加载器版本响应缺少版本号")?;
        downloads::identifier(version)?;
        if !out.iter().any(|old| old == version) { out.push(version.to_owned()); }
    }
    Ok(out)
}

fn checked_profile(value: Value, kind_name: &str, mc: &str, loader: &str) -> Result<Value> {
    let object = value.as_object().ok_or("加载器 profile 不是对象")?;
    downloads::identifier(text(&value, "id"))?;
    if text(&value, "inheritsFrom") != mc { return Err("加载器 profile 的 Minecraft 版本不匹配".into()); }
    let main = text(&value, "mainClass");
    let prefix = if kind_name == "fabric" { "net.fabricmc.loader." } else { "org.quiltmc.loader." };
    if !main.starts_with(prefix) || !main.ends_with(".KnotClient") { return Err("加载器 profile 启动类不匹配".into()); }
    let libraries = value["libraries"].as_array().ok_or("加载器 profile 缺少依赖库")?;
    let coordinate = if kind_name == "fabric" { format!("net.fabricmc:fabric-loader:{loader}") } else { format!("org.quiltmc:quilt-loader:{loader}") };
    if libraries.len() > 20000 || !libraries.iter().any(|lib| text(lib, "name") == coordinate) {
        return Err("加载器 profile 的加载器版本不匹配".into());
    }
    for key in ["downloads", "jar", "clientVersion", "assetIndex", "assets", "logging"] {
        if object.contains_key(key) { return Err("加载器 profile 包含不允许覆盖的原版字段".into()); }
    }
    let mut clean = Map::new();
    for key in ["id", "inheritsFrom", "mainClass", "arguments", "minecraftArguments", "libraries", "javaVersion", "minimumLauncherVersion", "type", "time", "releaseTime"] {
        if let Some(value) = object.get(key) { clean.insert(key.into(), value.clone()); }
    }
    Ok(Value::Object(clean))
}

fn compose(base: &Value, mut profile: Value, target: &str, mc: &str, root: &Path) -> Result<Value> {
    let base_id = text(base, "id");
    downloads::identifier(base_id)?;
    let client_version = if text(base, "clientVersion").is_empty() { base_id } else { text(base, "clientVersion") };
    if client_version != mc { return Err("目标实例的 Minecraft 版本与加载器不匹配".into()); }
    let main = text(base, "mainClass");
    if !main.is_empty() && !main.contains("net.minecraft.client.main.Main") {
        return Err("该实例已有加载器或使用未知启动类，拒绝重复安装".into());
    }
    let client_id = if !text(base, "jar").is_empty() {
        text(base, "jar")
    } else {
        let own = downloads::inside_path(root, Path::new("versions").join(base_id).join(format!("{base_id}.jar")))?;
        if own.is_file() { base_id } else { client_version }
    };
    downloads::identifier(client_id)?;
    profile["id"] = json!(target);
    let mut merged = downloads::merge_version(base, &profile)?;
    merged["id"] = json!(target);
    merged["clientVersion"] = json!(client_version);
    merged["jar"] = json!(client_id);
    if let Some(object) = merged.as_object_mut() { object.remove("inheritsFrom"); }
    Ok(merged)
}

/// 精确版本构建；调用方持有 root 锁。仅元数据缓存可写，不占真实实例或发布 natives/JSON。
pub(crate) async fn compose_profile_under_guard(kind_name:&str,mc:&str,loader:&str,target:&str,root:&Path,settings:&Value,cancel:&Cancel)->Result<Value>{
    kind(kind_name)?;for value in [mc,loader,target]{downloads::identifier(value)?;}if target==mc{return Err("整包实例 ID 不能占用基础 Minecraft ID".into());}cancel.check()?;
    let raw=downloads::fetch_loader_json(kind_name,mc,Some(loader),root,settings,cancel).await?;
    let profile=checked_profile(raw,kind_name,mc,loader)?;let base=downloads::resolve_version_under_guard(mc,root,settings,cancel).await?;
    let mut merged=compose(&base,profile,target,mc,root)?;merged["jar"]=json!(mc);merged["clientVersion"]=json!(mc);cancel.check()?;Ok(merged)
}

fn remove_owned_tree(root: &Path, path: &Path) -> Result<()> {
    let relative = path.strip_prefix(root).map_err(|_| "清理路径越界")?;
    let checked = downloads::inside_path(root, relative)?;
    if !checked.exists() { return Ok(()); }
    if fs::symlink_metadata(&checked).map_err(|_| "无法校验清理路径")?.is_dir() {
        for entry in fs::read_dir(&checked).map_err(|_| "无法枚举临时目录")? {
            remove_owned_tree(root, &entry.map_err(|_| "无法读取临时目录条目")?.path())?;
        }
        fs::remove_dir(&checked).map_err(|_| "无法移除临时目录".into())
    } else {
        fs::remove_file(&checked).map_err(|_| "无法移除临时文件".into())
    }
}

struct TargetReservation { root: PathBuf, directory: PathBuf, marker: PathBuf, token: String, committed: bool }
impl TargetReservation {
    fn new(root: &Path, id: &str, cancel: &Cancel) -> Result<Self> {
        let directory = downloads::version_path(root, id)?.parent().ok_or("实例目录无效")?.to_path_buf();
        let parent = directory.parent().ok_or("实例目录无效")?;
        fs::create_dir_all(parent).map_err(|_| "无法创建 versions 目录")?;
        downloads::inside_path(root, Path::new("versions").join(id))?;
        fs::create_dir(&directory).map_err(|_| "目标实例目录已存在或无法创建")?;
        let marker = directory.join(".hcmcl-loader-owner");
        let token = uuid::Uuid::new_v4().to_string();
        let reservation = Self { root: root.to_path_buf(), directory, marker, token, committed: false };
        if let Err(error) = downloads::write_new_bytes(&reservation.marker, reservation.token.as_bytes(), cancel) {
            let _ = fs::remove_dir(&reservation.directory);
            return Err(error);
        }
        Ok(reservation)
    }
    fn commit(&mut self) { self.committed = true; let _ = fs::remove_file(&self.marker); }
}
impl Drop for TargetReservation {
    fn drop(&mut self) {
        if self.committed || downloads::read_bytes(&self.marker).ok().as_deref() != Some(self.token.as_bytes()) { return; }
        let known = fs::read_dir(&self.directory).ok().is_some_and(|entries| entries.into_iter().all(|entry| {
            entry.ok().is_some_and(|entry| matches!(entry.file_name().to_str(), Some(".hcmcl-loader-owner") | Some("natives")))
        }));
        if known { let _ = remove_owned_tree(&self.root, &self.directory); }
        else { let _ = fs::remove_file(&self.marker); }
    }
}

struct NativeTransaction { root: PathBuf, target: PathBuf, backup: Option<PathBuf>, committed: bool }
impl NativeTransaction {
    fn begin(root: &Path, id: &str) -> Result<Self> {
        let target = downloads::inside_path(root, Path::new("versions").join(id).join("natives"))?;
        let backup = if target.exists() {
            if !target.is_dir() { return Err("实例 natives 不是目录".into()); }
            let backup = downloads::inside_path(root, Path::new("versions").join(id).join(format!("natives.loader-backup-{}", uuid::Uuid::new_v4())))?;
            fs::rename(&target, &backup).map_err(|_| "无法暂存原生库以供回滚")?;
            Some(backup)
        } else { None };
        Ok(Self { root: root.to_path_buf(), target, backup, committed: false })
    }
    fn rollback(&mut self) -> Result<()> {
        if self.committed { return Ok(()); }
        if self.target.exists() { remove_owned_tree(&self.root, &self.target)?; }
        if let Some(backup) = self.backup.as_ref() {
            downloads::inside_path(&self.root, backup.strip_prefix(&self.root).map_err(|_| "原生库备份越界")?)?;
            fs::rename(backup, &self.target).map_err(|_| "无法恢复原生库，原备份已保留")?;
        }
        self.backup = None;
        self.committed = true;
        Ok(())
    }
    fn commit(&mut self) {
        self.committed = true;
        if let Some(backup) = self.backup.take() { let _ = remove_owned_tree(&self.root, &backup); }
    }
}
impl Drop for NativeTransaction { fn drop(&mut self) { if !self.committed { let _ = self.rollback(); } } }

fn original_backup(root: &Path, id: &str, expected: &[u8], cancel: &Cancel) -> Result<()> {
    let file = downloads::version_path(root, id)?;
    if downloads::read_bytes(&file)? != expected { return Err("安装期间实例版本 JSON 已变化，拒绝覆盖".into()); }
    let backup = downloads::inside_path(root, Path::new("versions").join(id).join(format!("{id}.json.vanilla.bak")))?;
    if backup.exists() { downloads::read_bytes(&backup)?; return Ok(()); }
    downloads::write_new_bytes(&backup, expected, cancel)
}

#[derive(Clone)]
struct InstallRequest { kind: String, mc: String, loader: String, target: Option<String>, in_place: bool }

async fn install_profile(root: &Path, request: &InstallRequest, settings: &Value, cancel: Arc<Cancel>, progress: &Progress) -> Result<String> {
    let raw = downloads::fetch_loader_json(&request.kind, &request.mc, Some(&request.loader), root, settings, &cancel).await?;
    let profile = checked_profile(raw, &request.kind, &request.mc, &request.loader)?;
    let target = request.target.as_deref().unwrap_or_else(|| text(&profile, "id")).to_string();
    downloads::identifier(&target)?;
    let path = downloads::version_path(root, &target)?;
    let original = if request.in_place { Some(downloads::read_bytes(&path)?) } else { None };
    let base_id = if request.in_place { &target } else { &request.mc };
    let base = downloads::resolve_version_under_guard(base_id, root, settings, &cancel).await?;
    publish_profile_under_guard(root, &base, profile, &target, &request.mc, original.as_deref(), settings, cancel, progress).await
}

/// 调用方持有唯一根锁；原版快照和受控生成 profile 校验完成后才进入发布事务。
pub(crate) async fn publish_profile_under_guard(root: &Path, base: &Value, profile: Value, target: &str, mc: &str, original: Option<&[u8]>, settings: &Value, cancel: Arc<Cancel>, progress: &Progress) -> Result<String> {
    let path = downloads::version_path(root, target)?;
    let merged = compose(base, profile, target, mc, root)?;
    let bytes = serde_json::to_vec_pretty(&merged).map_err(|_| "加载器 profile 序列化失败")?;
    cancel.check()?;
    let mut reservation = if original.is_some() { None } else { Some(TargetReservation::new(root, target, &cancel)?) };
    let mut native = NativeTransaction::begin(root, &target)?;
    let result: Result<()> = async {
        downloads::install_version_value_under_guard(merged, root, settings, cancel.clone(), progress, false).await?;
        cancel.check()?;
        if let Some(original) = original.as_ref() {
            original_backup(root, &target, original, &cancel)?;
            downloads::write_bytes(&path, &bytes, &cancel)?;
        } else {
            downloads::write_new_bytes(&path, &bytes, &cancel)?;
        }
        Ok(())
    }.await;
    if let Err(error) = result {
        if let Err(recovery) = native.rollback() { return Err(format!("{error}；{recovery}")); }
        return Err(error);
    }
    native.commit();
    if let Some(reservation) = reservation.as_mut() { reservation.commit(); }
    Ok(target.to_string())
}

struct CancelOnDrop(Arc<Cancel>);
impl Drop for CancelOnDrop { fn drop(&mut self) { self.0.stop(); } }

fn parse_install(channel: &str, args: &[Value]) -> Result<InstallRequest> {
    let in_place = channel == "loaders:installInPlace";
    let minimum = if in_place { 4 } else { 3 };
    if args.len() < minimum || args.len() > 5 { return Err("加载器安装参数数量不符".into()); }
    let kind_name = kind(&text_arg(args, 0, "加载器类型", true)?)?.to_owned();
    let mc = text_arg(args, 1, "Minecraft 版本", true)?;
    let loader = text_arg(args, 2, "加载器版本", true)?;
    let target = text_arg(args, 3, "实例名称", in_place)?;
    for value in [&mc, &loader] { downloads::identifier(value)?; }
    if !target.is_empty() { downloads::identifier(&target)?; }
    text_arg(args, 4, "版本目录", false)?;
    Ok(InstallRequest { kind: kind_name, mc, loader, target: if target.is_empty() { None } else { Some(target) }, in_place })
}

pub async fn call(app: &tauri::AppHandle, channel: &str, args: &[Value], settings: &Value, game_dir: &Path) -> Result<Option<Value>> {
    if matches!(channel, "forge:versions" | "forge:install") || (channel == "loaders:installInPlace" && args.first().and_then(Value::as_str).is_some_and(|kind| matches!(kind, "forge" | "neoforge"))) {
        return crate::forge::call(app, channel, args, settings, game_dir).await;
    }
    if !matches!(channel, "loaders:versions" | "loaders:install" | "loaders:installInPlace") { return Ok(None); }
    if channel == "loaders:versions" {
        if args.len() != 2 { return Err("loaders:versions 参数数量不符".into()); }
        let kind_name = kind(&text_arg(args, 0, "加载器类型", true)?)?.to_owned();
        let mc = text_arg(args, 1, "Minecraft 版本", true)?;
        downloads::identifier(&mc)?;
        let root = downloads::operation_root(game_dir)?;
        let cancel = Cancel::default();
        let _guard = install_lock::acquire(&root, || cancel.check().is_err()).await?;
        let value = downloads::fetch_loader_json(&kind_name, &mc, None, &root, settings, &cancel).await?;
        return Ok(Some(json!(versions(value)?)));
    }
    let request = parse_install(channel, args)?;
    let root = downloads::operation_root(game_dir)?;
    let task_id = if request.in_place { format!("loader-inplace-{}", request.target.as_deref().unwrap_or("")) } else { format!("loader-{}-{}-{}", request.kind, request.mc, request.loader) };
    let registration = JobGuard::register(&root, &task_id)?;
    let cancel = registration.cancel();
    let _cancel_on_drop = CancelOnDrop(cancel.clone());
    let event_app = app.clone();
    let progress = Progress::new(task_id, format!("安装 {} {}", request.kind, request.loader), Arc::new(move |payload| {
        let _ = event_app.emit_to("main", "launcher:event", json!({"channel":"download:progress","payload":payload}));
    }));
    let settings = settings.clone();
    tokio::spawn(async move {
        let _registration = registration;
        let result = async {
            let _guard = install_lock::acquire(&root, || cancel.check().is_err()).await?;
            install_profile(&root, &request, &settings, cancel, &progress).await
        }.await;
        progress.finish(result.is_ok());
        result.map(|id| Some(json!(id)))
    }).await.map_err(|_| "加载器安装后台任务异常结束".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha1::{Digest, Sha1};

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("hcmcl-loader-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
    }
    impl Drop for Temp { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    fn progress() -> Progress { Progress::new("test".into(), "test".into(), Arc::new(|_| {})) }
    fn profile(kind_name: &str) -> Value {
        let (main, coordinate) = if kind_name == "fabric" {
            ("net.fabricmc.loader.impl.launch.knot.KnotClient", "net.fabricmc:fabric-loader:0.16.9")
        } else { ("org.quiltmc.loader.impl.launch.knot.KnotClient", "org.quiltmc:quilt-loader:0.16.9") };
        json!({"id":"loader-profile","inheritsFrom":"base","mainClass":main,"arguments":{"jvm":[],"game":[]},"libraries":[{"name":coordinate,"downloads":{"artifact":{"url":"","sha1":format!("{:x}",Sha1::digest(b"loader")),"size":6}}}]})
    }
    fn fixture(root: &Path, kind_name: &str) {
        let cancel = Cancel::default();
        let client = b"client";
        downloads::write_bytes(&root.join("versions/base/base.jar"), client, &cancel).unwrap();
        downloads::write_json(&downloads::version_path(root, "base").unwrap(), &json!({"id":"base","mainClass":"net.minecraft.client.main.Main","libraries":[],"downloads":{"client":{"size":client.len(),"sha1":format!("{:x}",Sha1::digest(client))}},"arguments":{"jvm":["-cp","${classpath}"],"game":["--username","${auth_player_name}"]}}), &cancel).unwrap();
        let relative = if kind_name == "fabric" { "libraries/net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar" } else { "libraries/org/quiltmc/quilt-loader/0.16.9/quilt-loader-0.16.9.jar" };
        downloads::write_bytes(&root.join(relative), b"loader", &cancel).unwrap();
        downloads::write_json(&root.join(format!(".hcmcl-cache/loaders/{kind_name}/base/0.16.9.profile.json")), &profile(kind_name), &cancel).unwrap();
    }
    fn request(in_place: bool) -> InstallRequest { InstallRequest {kind:"fabric".into(),mc:"base".into(),loader:"0.16.9".into(),target:Some("named".into()),in_place} }

    #[test]
    fn versions_and_protocol_validation() {
        assert_eq!(versions(json!([{"loader":{"version":"0.16.9"}},{"version":"0.27.0"},{"version":"0.16.9"}])).unwrap(), vec!["0.16.9", "0.27.0"]);
        assert!(versions(json!([{"loader":{}}])).is_err());
        assert!(kind("forge").is_err());
        assert!(parse_install("loaders:install", &[json!("fabric"),json!("base"),json!("0.16.9"),Value::Null,json!(false)]).is_err());
        assert!(parse_install("loaders:installInPlace", &[json!("fabric"),json!("base"),json!("0.16.9"),json!("../bad")]).is_err());
    }

    #[test]
    fn profile_binding_rejects_wrong_loader_game_and_original_overrides() {
        assert!(checked_profile(profile("fabric"), "fabric", "base", "0.16.9").is_ok());
        assert!(checked_profile(profile("quilt"), "quilt", "base", "0.16.9").is_ok());
        assert!(checked_profile(profile("fabric"), "fabric", "other", "0.16.9").is_err());
        assert!(checked_profile(profile("fabric"), "fabric", "base", "other").is_err());
        let mut wrong = profile("fabric"); wrong["downloads"] = json!({});
        assert!(checked_profile(wrong, "fabric", "base", "0.16.9").is_err());
    }

    #[tokio::test]
    async fn cached_pack_composition_is_exact_and_never_publishes_target(){
        for kind_name in ["fabric","quilt"]{
            let temp=Temp::new();fixture(&temp.0,kind_name);let settings=json!({"mode":"local"});let cancel=Cancel::default();let result=compose_profile_under_guard(kind_name,"base","0.16.9","pack",&temp.0,&settings,&cancel).await.unwrap();
            assert_eq!(result["id"],"pack");assert_eq!(result["clientVersion"],"base");assert_eq!(result["jar"],"base");assert!(result.get("inheritsFrom").is_none());assert!(!temp.0.join("versions/pack").exists());assert!(!temp.0.join("versions/base/natives").exists());
            assert!(compose_profile_under_guard(kind_name,"base","0.16.8","pack",&temp.0,&settings,&cancel).await.is_err());assert!(!temp.0.join("versions/pack").exists());
            let mut wrong=profile(kind_name);wrong["libraries"][0]["name"]=json!(if kind_name=="fabric"{"net.fabricmc:fabric-loader:0.16.8"}else{"org.quiltmc:quilt-loader:0.16.8"});downloads::write_json(&temp.0.join(format!(".hcmcl-cache/loaders/{kind_name}/base/0.16.9.profile.json")),&wrong,&cancel).unwrap();assert!(compose_profile_under_guard(kind_name,"base","0.16.9","pack",&temp.0,&settings,&cancel).await.is_err());
            let stopped=Cancel::default();stopped.stop();assert!(compose_profile_under_guard(kind_name,"base","0.16.9","cancelled",&temp.0,&settings,&stopped).await.is_err());assert!(!temp.0.join("versions/cancelled").exists());assert!(compose_profile_under_guard(kind_name,"base","0.16.9","base",&temp.0,&settings,&cancel).await.is_err());
        }
    }
    #[tokio::test]
    async fn cached_fabric_and_quilt_install_publish_only_after_dependencies() {
        for kind_name in ["fabric", "quilt"] {
            let temp = Temp::new(); fixture(&temp.0, kind_name);
            let mut input = request(false); input.kind = kind_name.into();
            assert_eq!(install_profile(&temp.0,&input,&json!({"mode":"local"}),Arc::new(Cancel::default()),&progress()).await.unwrap(),"named");
            let version = downloads::read_json(&downloads::version_path(&temp.0,"named").unwrap()).unwrap();
            assert_eq!(version["id"],"named"); assert_eq!(version["clientVersion"],"base"); assert_eq!(version["jar"],"base");
            assert!(version.get("inheritsFrom").is_none());
            assert!(!temp.0.join("versions/named/.hcmcl-loader-owner").exists());
            assert!(install_profile(&temp.0,&input,&json!({"mode":"local"}),Arc::new(Cancel::default()),&progress()).await.is_err());
        }
    }

    #[tokio::test]
    async fn in_place_preserves_identity_content_and_original_backup() {
        let temp=Temp::new();fixture(&temp.0,"fabric");let cancel=Cancel::default();
        let path=downloads::version_path(&temp.0,"named").unwrap();
        let original=b"{\"id\":\"named\",\"inheritsFrom\":\"base\"}";
        downloads::write_bytes(&path,original,&cancel).unwrap();
        downloads::write_bytes(&temp.0.join("versions/named/saves/world/level.dat"),b"world",&cancel).unwrap();
        install_profile(&temp.0,&request(true),&json!({"mode":"local"}),Arc::new(Cancel::default()),&progress()).await.unwrap();
        assert_eq!(fs::read(temp.0.join("versions/named/named.json.vanilla.bak")).unwrap(),original);
        assert_eq!(fs::read(temp.0.join("versions/named/saves/world/level.dat")).unwrap(),b"world");
        let published=fs::read(&path).unwrap();
        assert!(install_profile(&temp.0,&request(true),&json!({"mode":"local"}),Arc::new(Cancel::default()),&progress()).await.is_err());
        assert_eq!(fs::read(&path).unwrap(),published);
        assert_eq!(fs::read(temp.0.join("versions/named/named.json.vanilla.bak")).unwrap(),original);
    }

    #[tokio::test]
    async fn missing_dependency_and_cancel_preserve_old_profile_and_natives() {
        let temp=Temp::new();fixture(&temp.0,"fabric");let cancel=Cancel::default();
        let path=downloads::version_path(&temp.0,"named").unwrap();let original=b"{\"id\":\"named\",\"inheritsFrom\":\"base\"}";
        downloads::write_bytes(&path,original,&cancel).unwrap();
        downloads::write_bytes(&temp.0.join("versions/named/natives/old.bin"),b"old",&cancel).unwrap();
        fs::remove_file(temp.0.join("libraries/net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar")).unwrap();
        assert!(install_profile(&temp.0,&request(true),&json!({"mode":"local"}),Arc::new(Cancel::default()),&progress()).await.is_err());
        assert_eq!(fs::read(&path).unwrap(),original);
        assert_eq!(fs::read(temp.0.join("versions/named/natives/old.bin")).unwrap(),b"old");
        assert!(!temp.0.join("versions/named/named.json.vanilla.bak").exists());
        let stopped=Arc::new(Cancel::default());stopped.stop();
        assert!(install_profile(&temp.0,&request(false),&json!({"mode":"local"}),stopped,&progress()).await.is_err());
        assert_eq!(fs::read(&path).unwrap(),original);
    }

    #[test]
    fn cancelled_reservation_removes_only_the_empty_directory_it_created() {
        let temp = Temp::new();
        let stopped = Cancel::default(); stopped.stop();
        assert!(TargetReservation::new(&temp.0, "cancelled", &stopped).is_err());
        assert!(!temp.0.join("versions/cancelled").exists());
        fs::create_dir_all(temp.0.join("versions/existing")).unwrap();
        fs::write(temp.0.join("versions/existing/user.txt"), b"keep").unwrap();
        assert!(TargetReservation::new(&temp.0, "existing", &stopped).is_err());
        assert_eq!(fs::read(temp.0.join("versions/existing/user.txt")).unwrap(), b"keep");
    }

    #[tokio::test]
    async fn failed_final_backup_restores_profile_and_native_output_after_dependency_success() {
        let temp = Temp::new(); fixture(&temp.0, "fabric");
        let cancel = Cancel::default();
        let path = downloads::version_path(&temp.0, "named").unwrap();
        let original = b"{\"id\":\"named\",\"inheritsFrom\":\"base\"}";
        downloads::write_bytes(&path, original, &cancel).unwrap();
        downloads::write_bytes(&temp.0.join("versions/named/natives/old.bin"), b"old", &cancel).unwrap();
        fs::create_dir(temp.0.join("versions/named/named.json.vanilla.bak")).unwrap();
        assert!(install_profile(&temp.0, &request(true), &json!({"mode":"local"}), Arc::new(Cancel::default()), &progress()).await.is_err());
        assert_eq!(fs::read(path).unwrap(), original);
        assert_eq!(fs::read(temp.0.join("versions/named/natives/old.bin")).unwrap(), b"old");
        assert!(!temp.0.join("versions/named/natives/.extract-stamp").exists());
        assert!(!fs::read_dir(temp.0.join("versions/named")).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with("natives.loader-backup-")));
    }

    #[tokio::test]
    async fn concurrent_new_profile_is_preserved_when_publication_loses() {
        let temp = Temp::new(); fixture(&temp.0, "fabric");
        let path = temp.0.join("versions/named/named.json");
        let external = path.clone();
        let once = std::sync::atomic::AtomicBool::new(false);
        let observer = Progress::new("conflict".into(), "conflict".into(), Arc::new(move |_| {
            if !once.swap(true, std::sync::atomic::Ordering::SeqCst) { fs::write(&external, b"external-profile").unwrap(); }
        }));
        assert!(install_profile(&temp.0, &request(false), &json!({"mode":"local"}), Arc::new(Cancel::default()), &observer).await.is_err());
        assert_eq!(fs::read(path).unwrap(), b"external-profile");
        assert!(!temp.0.join("versions/named/natives").exists());
        assert!(!temp.0.join("versions/named/.hcmcl-loader-owner").exists());
    }

    #[test]
    fn new_file_publication_and_backup_do_not_overwrite_existing_files() {
        let temp=Temp::new();let path=temp.0.join("profile.json");let cancel=Cancel::default();
        downloads::write_new_bytes(&path,b"old",&cancel).unwrap();
        assert!(downloads::write_new_bytes(&path,b"new",&cancel).is_err());
        assert_eq!(fs::read(path).unwrap(),b"old");
        assert!(!fs::read_dir(&temp.0).unwrap().any(|entry|entry.unwrap().file_name().to_string_lossy().ends_with(".part")));
    }
}

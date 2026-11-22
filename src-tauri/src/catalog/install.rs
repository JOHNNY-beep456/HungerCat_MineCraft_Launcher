//! 普通资源的受控单文件安装；普通模组核验实例 MC/loader，额外依赖仍由共享界面确认。
//! HTTP 与实际写入属于独立 worker，IPC 丢弃仅停止信号；现场未知时保留根锁及任务。
use super::{BoundDownload, Result};
use crate::{downloads::{Cancel, JobGuard}, install_lock::{self, RootOperationGuard}, lifecycle, storage::Storage};
use crate::resource_updates::transaction::{self, Change, NewFile, UpdateStage};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs::File, future::Future, io, path::{Path, PathBuf}, pin::Pin,
    sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, Ordering}}, time::Duration};
use tauri::{AppHandle, Emitter, Manager, Runtime};
#[path = "../modpack/access.rs"]
mod access;
mod compatibility;

const INSTALL: &str = "mods:install";
const FABRIC: &str = "mods:installFabricApi";
const OFFLINE_TRANSLATE: &str = "mods:installOfflineTranslate";
const CHANGED: &str = "资源安装目录或设置已改变，请重试 / 資源安裝目錄或設定已變更，請重試 / Install directory or settings changed; retry";
const UNKNOWN: &str = "资源安装收尾未确认，目录保持占用 / 資源安裝收尾未確認，目錄保持佔用 / Install cleanup unconfirmed; directory remains busy";
#[derive(Clone, Debug)]
enum Request {
    File { url: String, filename: String, instance: String, kind: String, hint: Option<u64>, dir_id: String },
    Fabric { game: String, instance: String },
    OfflineTranslate { instance: String },
}
impl Request {
    fn parse(channel: &str, args: &[Value]) -> Result<Self> {
        if channel == INSTALL {
            super::count(args, 3, 6)?;
            let url = super::string_arg(args, 0, 8192, true)?;
            let filename = super::string_arg(args, 1, 240, true)?; access::leaf(&filename)?;
            let instance = super::string_arg(args, 2, 240, true)?; access::leaf(&instance)?;
            let raw = super::string_arg(args, 3, 32, false)?;
            let kind = super::resource_type(&raw)?.to_owned(); super::install_folder(&kind)?;
            let hint = super::size_hint(args, 4)?;
            let dir_id = super::string_arg(args, 5, 128, false)?;
            let parsed = reqwest::Url::parse(&url).map_err(|_| "资源下载地址无效")?;
            let source = source(&parsed)?; super::official_download_url(&url, source)?;
            Ok(Self::File { url, filename, instance, kind, hint, dir_id })
        } else if channel == FABRIC {
            super::count(args, 2, 2)?;
            let game = super::string_arg(args, 0, 128, true)?;
            let instance = super::string_arg(args, 1, 240, true)?; access::leaf(&instance)?;
            Ok(Self::Fabric { game, instance })
        } else if channel == OFFLINE_TRANSLATE {
            super::count(args, 1, 1)?;
            let instance = super::string_arg(args, 0, 240, true)?; access::leaf(&instance)?;
            Ok(Self::OfflineTranslate { instance })
        } else { Err("未知普通安装通道".into()) }
    }
    fn instance(&self) -> &str { match self { Self::File { instance, .. } | Self::Fabric { instance, .. } | Self::OfflineTranslate { instance } => instance } }
    fn kind(&self) -> &str { match self { Self::File { kind, .. } => kind, Self::Fabric { .. } | Self::OfflineTranslate { .. } => "mod" } }
    fn needs_profile(&self) -> bool { matches!(self, Self::File { kind, .. } if kind == "mod") || matches!(self, Self::Fabric { .. }) }
    fn initial_task(&self) -> String { match self { Self::File { filename, .. } => filename.clone(), Self::Fabric { instance, .. } => format!("fabric-api:{instance}"), Self::OfflineTranslate { .. } => super::offline_translate::FILENAME.into() } }
    fn directory_id(&self, settings: &Value) -> String {
        let specified = match self { Self::File { dir_id, .. } => dir_id.as_str(), _ => "" };
        let value = if specified.is_empty() { super::text(settings, "selectedVersionDirId") } else { specified };
        if value.is_empty() { "default".into() } else { value.into() }
    }
    fn explicit_args(&self, id: &str) -> Vec<Value> {
        // 固定模组入口也共用原 mods:install 的第六参数解析器；这是后台捕获的目录标识。
        vec![Value::Null, Value::Null, Value::Null, Value::Null, Value::Null, json!(id)]
    }
}
fn source(url: &reqwest::Url) -> Result<&'static str> {
    match url.host_str().unwrap_or("") {
        "cdn.modrinth.com" | "api.modrinth.com" => Ok("modrinth"),
        "edge.forgecdn.net" | "mediafilez.forgecdn.net" | "media.forgecdn.net" | "www.curseforge.com" => Ok("curseforge"),
        _ => Err("资源下载地址不属于允许的官方来源".into()),
    }
}
fn allowed(settings: &Value) -> Result<()> {
    super::online(settings)?;
    if settings.get("metadataOnlyMods").and_then(Value::as_bool) == Some(true) { return Err("仅元数据模式不安装资源".into()); }
    Ok(())
}
fn root_key(root: &Path) -> String {
    let value = root.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_owned();
    if cfg!(windows) { value.to_lowercase() } else { value }
}
#[derive(Clone)]
struct Scope { root: PathBuf, dir_id: String, root_mark: access::DirectoryMark, implicit: bool }
impl Scope {
    fn capture(request: &Request, settings: &Value, trusted: &Path) -> Result<Self> {
        allowed(settings)?;
        let dir_id = request.directory_id(settings);
        let root = crate::operation_game_dir(INSTALL, &request.explicit_args(&dir_id), settings)?;
        if root_key(&root) != root_key(trusted) { return Err(CHANGED.into()); }
        let root_mark = access::Directory::open(&root)?.mark();
        let implicit = !matches!(request, Request::File { dir_id, .. } if !dir_id.is_empty());
        Ok(Self { root, dir_id, root_mark, implicit })
    }
    fn policy(&self, request: &Request, settings: &Value) -> Result<()> {
        allowed(settings)?;
        if self.implicit && request.directory_id(settings) != self.dir_id { return Err(CHANGED.into()); }
        let root = crate::operation_game_dir(INSTALL, &request.explicit_args(&self.dir_id), settings)?;
        if root_key(&root) != root_key(&self.root) { return Err(CHANGED.into()); }
        Ok(())
    }
    fn current(&self, request: &Request, settings: &Value) -> Result<()> {
        self.policy(request, settings)?;
        self.root_mark.verify()
    }
}
struct Context { directory: access::DirectoryMark, isolation: crate::modpack::InstanceIsolation, isolated: bool, settings: Value, profile: Option<crate::resource_updates::InstallProfile> }
fn context(scope: &Scope, request: &Request, settings: &Value, cancel: &AtomicBool) -> Result<Context> {
    scope.current(request, settings)?;
    let profile = if request.needs_profile() {
        let profile = crate::resource_updates::capture_install_profile(&scope.root, request.instance(), cancel)?;
        if let Request::Fabric { game, .. } = request { compatibility::Tags::fabric(game).check(&profile.mc_version, profile.loader.as_deref())?; }
        Some(profile)
    } else { None };
    let isolation = crate::modpack::instance_isolation(&scope.root, request.instance(), settings)?;
    let root = scope.root_mark.open()?;
    let run = if isolation.isolated {
        let versions = root.directory(root.child("versions")?.ok_or("实例版本目录不存在")?)?;
        versions.directory(versions.child(request.instance())?.ok_or("实例不存在")?)?
    } else { root };
    isolation.verify()?; run.verify()?;
    Ok(Context { directory: run.mark(), isolated: isolation.isolated, isolation, settings: settings.clone(), profile })
}
impl Context {
    fn policy(&self, scope: &Scope, request: &Request, settings: &Value) -> Result<()> {
        scope.policy(request, settings)?;
        let isolation = |value: &Value| value.get("versionIsolation").cloned().unwrap_or(Value::Null);
        if isolation(settings) != isolation(&self.settings) || settings.get("isolatedVersions") != self.settings.get("isolatedVersions")
            || settings.get("curseforgeApiKey") != self.settings.get("curseforgeApiKey") { return Err(CHANGED.into()); }
        Ok(())
    }
    fn verify(&self, scope: &Scope, request: &Request, settings: &Value, cancel: &AtomicBool) -> Result<()> {
        self.policy(scope, request, settings)?; self.isolation.verify()?; self.directory.verify()?;
        if crate::modpack::instance_isolation(&scope.root, request.instance(), settings)?.isolated != self.isolated { return Err(CHANGED.into()); }
        if let Some(profile) = &self.profile { profile.verify(cancel)?; }
        Ok(())
    }
    fn compatible(&self, prepared: &Prepared) -> Result<()> {
        if let Some(profile) = &self.profile {
            match prepared {
                Prepared::Compatible(_, tags) => tags.check(&profile.mc_version, profile.loader.as_deref()),
                _ => Err("HC_COMPAT|EVIDENCE".into()),
            }
        } else { Ok(()) }
    }
}

struct Operation { cancel: Arc<Cancel>, token: Arc<AtomicBool>, task: String, committing: AtomicBool, published: AtomicBool, done: AtomicBool }
impl Operation {
    fn new(task: String, cancel: Arc<Cancel>) -> Arc<Self> { Arc::new(Self { cancel, token: Arc::new(AtomicBool::new(false)), task, committing: AtomicBool::new(false), published: AtomicBool::new(false), done: AtomicBool::new(false) }) }
    fn stop(&self) { self.token.store(true, Ordering::Release); self.cancel.stop(); }
    fn check(&self) -> Result<()> { self.cancel.check()?; if self.token.load(Ordering::Acquire) { Err("资源安装已取消".into()) } else { Ok(()) } }
    fn request_stop(&self) -> Result<()> {
        self.stop();
        if self.published.load(Ordering::Acquire) { Err("资源已发布，取消不能撤销安装".into()) }
        else if self.committing.load(Ordering::Acquire) { Err("资源正在提交，已请求停止但不能保证撤回".into()) } else { Ok(()) }
    }
}
#[derive(Default)]
struct State { closed: bool, unknown: bool, active: BTreeMap<String, Arc<Operation>> }
#[derive(Clone, Default)]
struct Registry(Arc<Mutex<State>>);
static TASKS: OnceLock<Registry> = OnceLock::new();
struct Registration { registry: Registry, id: String, operation: Arc<Operation>, finished: bool }
impl Registry {
    fn begin(&self, operation: Arc<Operation>) -> Result<Registration> {
        let mut state = self.0.lock().map_err(|_| UNKNOWN)?;
        if state.closed || state.unknown || state.active.len() >= 128 { return Err("普通资源安装已关闭、忙碌或收尾未确认".into()); }
        let id = uuid::Uuid::new_v4().to_string(); state.active.insert(id.clone(), operation.clone());
        Ok(Registration { registry: self.clone(), id, operation, finished: false })
    }
    fn close(&self) { if let Ok(mut state) = self.0.lock() { state.closed = true; for operation in state.active.values() { operation.stop(); } } }
    fn cancel(&self, task: Option<&str>) -> Result<()> {
        let state = self.0.lock().map_err(|_| UNKNOWN)?; let mut errors = Vec::new();
        for operation in state.active.values() {
            let matches = task.map_or(true, |task| operation.task == task);
            if matches { if let Err(error) = operation.request_stop() { errors.push(error); } }
        }
        if errors.is_empty() { Ok(()) } else { Err(errors.join("；")) }
    }
    fn ready(&self) -> Result<()> { let state = self.0.try_lock().map_err(|_| UNKNOWN)?; if state.unknown || !state.active.is_empty() { Err(UNKNOWN.into()) } else { Ok(()) } }
}
impl Registration { fn finish(mut self) { self.finished = true; } }
impl Drop for Registration {
    fn drop(&mut self) {
        if let Ok(mut state) = self.registry.0.lock() {
            if self.finished { state.active.remove(&self.id); }
            else { self.operation.stop(); state.unknown = true; }
        }
    }
}
pub(crate) fn cancel_for_window() { TASKS.get_or_init(Registry::default).close(); }
pub(crate) fn cancel_download(task: Option<&str>) -> Result<()> { if let Some(registry) = TASKS.get() { registry.cancel(task) } else { Ok(()) } }
pub(crate) fn relaunch_ready() -> Result<()> { if let Some(registry) = TASKS.get() { registry.ready() } else { Ok(()) } }
struct Waiting(Arc<Operation>);
impl Drop for Waiting { fn drop(&mut self) { self.0.stop(); } }

struct Owner { root: Option<RootOperationGuard>, anchor: Option<access::Directory>, job: Option<JobGuard>, stage: Option<UpdateStage>, pending: bool, uncertain: bool }
impl Owner {
    fn settled(&self) -> bool { !self.uncertain && !self.pending && self.stage.as_ref().map_or(true, UpdateStage::settled) }
}
impl Drop for Owner {
    fn drop(&mut self) {
        if std::thread::panicking() || !self.settled() {
            if let Some(stage) = self.stage.take() { std::mem::forget(stage); }
            if let Some(root) = self.root.take() { root.quarantine(); }
            if let Some(anchor) = self.anchor.take() { std::mem::forget(anchor); }
            if let Some(job) = self.job.take() { std::mem::forget(job); }
        }
    }
}
type Holder = Arc<Mutex<Owner>>;
fn owner(holder: &Holder) -> Result<std::sync::MutexGuard<'_, Owner>> { holder.lock().map_err(|_| UNKNOWN.into()) }
async fn blocking<T: Send + 'static>(holder: &Holder, work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    match tokio::task::spawn_blocking(work).await {
        Ok(result) => result,
        Err(_) => { if let Ok(mut owner) = holder.lock() { owner.uncertain = true; } Err(UNKNOWN.into()) }
    }
}
#[derive(Clone)]
struct Report { sink: Arc<dyn Fn(Value) + Send + Sync>, operation: Arc<Operation> }
impl Report {
    fn emit(&self, bytes: u64, total: u64, terminal: Option<bool>) {
        let task = &self.operation.task;
        let percent = match terminal { Some(true) => 100.0, Some(false) => 0.0, None if total > 0 => (bytes as f64 / total as f64 * 100.0).min(99.0), _ => 0.0 };
        (self.sink)(json!({"taskId":task,"jobTitle":task,"task":task,"current":if terminal==Some(true){1}else{0},"total":1,
            "currentBytes":bytes,"totalBytes":total,"phase":if terminal.is_some(){"done"}else{"mod"},"percent":percent,"speed":0}));
    }
}
type TransferFuture = Pin<Box<dyn Future<Output = Result<u64>> + Send>>;
type Transfer = Arc<dyn Fn(BoundDownload, File, Arc<Cancel>, Arc<dyn Fn(u64,u64) + Send + Sync>) -> TransferFuture + Send + Sync>;
fn transport() -> Transfer { Arc::new(|bound, file, cancel, progress| Box::pin(super::write_export_download(bound, file, cancel, progress))) }
type Host = Arc<dyn Fn(&mut dyn FnMut(&Value) -> Result<()>) -> Result<()> + Send + Sync>;
fn with_current<T>(host: &Host, work: impl FnOnce(&Value) -> Result<T>) -> Result<T> {
    let mut work = Some(work); let mut result = None;
    host(&mut |settings| { result = Some(work.take().ok_or(CHANGED)?(settings)?); Ok(()) })?;
    result.ok_or_else(|| CHANGED.into())
}
// 固定包只有内存字节和本次摘要，不伪造官方 CDN 元数据，也不进入通用网络 Transfer。
enum Prepared { Official(BoundDownload), Compatible(BoundDownload, compatibility::Tags), OfflineTranslate(super::offline_translate::Package) }
impl Prepared {
    fn bound(&self) -> &BoundDownload { match self { Self::Official(bound) | Self::Compatible(bound, _) => bound, Self::OfflineTranslate(package) => package.bound() } }
}
type BindFuture = Pin<Box<dyn Future<Output = Result<Prepared>> + Send>>;
type Binder = Arc<dyn Fn(Request, Value, Arc<Operation>, super::offline_translate::Progress) -> BindFuture + Send + Sync>;
fn binder() -> Binder { binder_with_source(super::offline_translate::source()) }
fn binder_with_source(source: super::offline_translate::Source) -> Binder {
    Arc::new(move |request, settings, operation, progress| {
        let source = source.clone();
        Box::pin(async move {
            operation.check()?;
            allowed(&settings)?;
            if matches!(&request, Request::OfflineTranslate { .. }) {
                let package = source(operation.cancel.clone(), progress).await?;
                operation.check()?;
                Ok(Prepared::OfflineTranslate(package))
            } else { bind(&request, &settings, &operation).await }
        })
    })
}

async fn bind(request: &Request, settings: &Value, operation: &Operation) -> Result<Prepared> {
    operation.check()?;
    let future = async {
        match request {
            Request::File { url, filename, kind, hint, .. } => {
                if kind == "mod" { return bind_mod(url, filename, *hint, settings).await; }
                let parsed = reqwest::Url::parse(url).map_err(|_| "资源下载地址无效")?;
                let bound = match source(&parsed)? {
                    "modrinth" => super::bind_modrinth_download(url, filename, settings).await?,
                    _ => super::bind_curseforge_download(url, filename, kind, settings).await?,
                };
                super::validate_export_bound(&bound, *hint)?; Ok(Prepared::Official(bound))
            }
            Request::Fabric { game, .. } => {
                let rows = super::versions(&[json!("fabric-api"),json!(["fabric"]),json!([game]),json!("modrinth"),json!("mod")], settings).await?;
                let bound = fabric_bound(&rows, game)?;
                // 重新绑定同一个官方版本/文件，兼容标签与哈希来自同一次响应。
                bind_mod(&bound.url, &bound.filename, Some(bound.size), settings).await
            }
            Request::OfflineTranslate { .. } => Err("固定模组不能经通用官方源下载 / 固定模組不能經通用官方來源下載 / Fixed package cannot use the generic official-source downloader".into()),
        }
    };
    // 这里只取消只读 HTTP，不丢弃任何文件写入 future。
    let bound = tokio::select! { biased; _ = operation.cancel.cancelled() => return Err("资源安装已取消".into()), result = future => result? };
    operation.check()?; Ok(bound)
}
async fn bind_mod(url: &str, filename: &str, hint: Option<u64>, settings: &Value) -> Result<Prepared> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "资源下载地址无效")?;
    let (bound, tags) = if source(&parsed)? == "modrinth" {
        super::official_download_url(url, "modrinth")?;
        let version = super::modrinth_version_from_url(&parsed)?;
        let raw = super::remote(super::endpoint(super::MR, &["version", &version])?, settings, false).await?;
        if super::text(&raw, "id") != version { return Err("Modrinth 官方版本 id 不匹配".into()); }
        let project_id = super::text(&raw, "project_id");
        let project = super::remote(super::endpoint(super::MR, &["project", project_id])?, settings, false).await?;
        let tags = compatibility::Tags::modrinth(&raw, &project)?;
        let file = raw.get("files").and_then(Value::as_array).ok_or("Modrinth 官方版本缺少文件列表")?.iter()
            .find(|file| super::text(file, "filename") == filename && super::text(file, "url") == url)
            .ok_or("用户下载文件未在官方 Modrinth 版本中找到")?;
        (super::bound_modrinth_file(file, Some(url), filename)?, tags)
    } else {
        super::official_download_url(url, "curseforge")?;
        let file_id = super::curseforge_file_id_from_url(&parsed)?;
        let raw = super::remote_request(super::endpoint(super::CF, &["mods", "files"])?, settings, true, super::Method::POST, Some(json!({"fileIds":[file_id]}))).await?;
        let file = raw.get("data").and_then(Value::as_array).ok_or("CurseForge 文件查询响应缺少 data")?.iter()
            .find(|file| file.get("id").and_then(Value::as_u64) == Some(file_id)).ok_or("CurseForge 官方文件不存在")?;
        let project_id = file.get("modId").and_then(Value::as_u64).ok_or("CurseForge 文件缺少项目 id")?;
        let project = super::cf_project(&project_id.to_string(), settings).await?;
        (super::bound_curseforge_file(file, &project, url, filename, "mod")?, compatibility::Tags::curseforge(file, &project)?)
    };
    super::validate_export_bound(&bound, hint)?;
    Ok(Prepared::Compatible(bound, tags))
}
fn fabric_bound(rows: &Value, game: &str) -> Result<BoundDownload> {
    for version in rows.as_array().ok_or("Fabric API 版本响应无效")? {
        if !version.get("game_versions").and_then(Value::as_array).is_some_and(|list| list.iter().any(|v| v.as_str()==Some(game)))
            || !version.get("loaders").and_then(Value::as_array).is_some_and(|list| list.iter().any(|v| v.as_str()==Some("fabric"))) { continue; }
        let files = version.get("files").and_then(Value::as_array).ok_or("Fabric API 缺少文件")?;
        if let Some(file) = files.iter().find(|v| v.get("primary").and_then(Value::as_bool)==Some(true)).or_else(||files.first()) {
            let bound = super::bound_modrinth_file(file, None, super::text(file,"filename"))?;
            super::validate_export_bound(&bound,None)?; return Ok(bound);
        }
    }
    Err(format!("未在 Modrinth 找到适配 {game} 的 Fabric API"))
}

fn ensure_folder(context: &Context, folder: &str) -> Result<access::Directory> {
    let run = context.directory.open()?;
    if run.child(folder)?.is_none() {
        match native::mkdir(run.handle(), folder) { Ok(()) => {}, Err(error) if error.kind()==io::ErrorKind::AlreadyExists => {}, Err(_) => return Err("无法建立资源目录".into()) }
    }
    let directory = run.directory(run.child(folder)?.ok_or("资源目录创建后消失")?)?;
    directory.verify()?; Ok(directory)
}
fn initialize(holder: &Holder, scope: &Scope, context: &Context, request: &Request, bound: &BoundDownload, token: &AtomicBool) -> Result<PathBuf> {
    let directory = ensure_folder(context, super::install_folder(request.kind())?)?;
    let mut budget=100000;
    if directory.names(&mut budget)?.iter().any(|name| name.to_lowercase() == bound.filename.to_lowercase()) { return Err("同名资源已存在，拒绝覆盖".into()); }
    let destination=directory.path().join(&bound.filename);
    let mut holder=owner(holder)?; holder.pending=true;
    let change=Change::Install{new:NewFile{leaf:bound.filename.clone(),size:bound.size,sha1:bound.sha1.clone(),sha512:bound.sha512.clone()}};
    match UpdateStage::create(&scope.root,directory.path(),vec![change],token) {
        Ok(stage)=>{holder.stage=Some(stage);Ok(destination)},
        Err(error)=>{holder.pending=transaction::pending_under_guard(&scope.root).unwrap_or(true);Err(error)}
    }
}
async fn cleanup(holder: &Holder) -> Result<()> {
    let cleanup=holder.clone();
    blocking(holder,move||{let mut holder=owner(&cleanup)?;if let Some(stage)=holder.stage.as_mut(){stage.cleanup()?;holder.pending=!stage.settled();}
        if !holder.settled(){return Err(UNKNOWN.into());}Ok(())}).await
}

pub(super) async fn call<R: Runtime>(app: &AppHandle<R>, channel: &str, args: &[Value], settings: &Value, root: &Path) -> Result<Value> {
    let request=Request::parse(channel,args)?;let scope=Scope::capture(&request,settings,root)?;
    #[cfg(target_os="ios")] {let _=(app,request,scope);return Err("当前平台不支持资源安装 / 目前平台不支援資源安裝 / Resource installation unsupported".into());}
    #[cfg(target_os="android")] {
        let private=app.path().app_data_dir().map_err(|_|"无法确认 Android 应用目录")?;
        access::Directory::open(&private)?;
        if !scope.root.starts_with(&private)||scope.root==private {return Err("Android 资源安装仅允许已授权的应用内部游戏目录".into());}
    }
    let gate=app.try_state::<lifecycle::Gate>().ok_or("资源安装生命周期不可用")?.enter()?;
    let job=match JobGuard::register(&scope.root,&request.initial_task()){Ok(job)=>job,Err(error)=>{gate.finish();return Err(error)}};
    let operation=Operation::new(request.initial_task(),job.cancel());
    let registered=match TASKS.get_or_init(Registry::default).begin(operation.clone()){Ok(value)=>value,Err(error)=>{job.complete(Err(error.clone()));drop(job);gate.finish();return Err(error)}};
    let waiting=Waiting(operation.clone());
    let progress_app=app.clone();let sink:Arc<dyn Fn(Value)+Send+Sync>=Arc::new(move|payload|{let _=progress_app.emit_to("main","launcher:event",json!({"channel":"download:progress","payload":payload}));});
    let report=Report{sink,operation:operation.clone()};
    let holder=Arc::new(Mutex::new(Owner{root:None,anchor:None,job:Some(job),stage:None,pending:false,uncertain:false}));
    let host_app=app.clone();
    let host:Host=Arc::new(move|work|{let storage=host_app.try_state::<Storage>().ok_or("资源安装存储不可用")?;storage.with_settings_for_backend(|current|work(current))?});
    let worker=tokio::spawn(supervise(request,scope,operation,report,holder,registered,gate,host,binder(),transport()));
    let result=worker.await.map_err(|_|UNKNOWN.to_owned())?;drop(waiting);result.map(Value::String)
}

async fn supervise(request:Request,scope:Scope,operation:Arc<Operation>,report:Report,holder:Holder,registered:Registration,gate:lifecycle::Request,host:Host,binder:Binder,transfer:Transfer)->Result<String> {
    let result=run(&request,&scope,&operation,&report,&holder,host,binder,transfer).await;
    let cleaned=cleanup(&holder).await;
    let result=match(result,cleaned){(Ok(path),Ok(()))=>Ok(path),(Err(error),Ok(()))=>Err(error),(result,Err(error))=>Err(format!("{}；{error}",result.err().unwrap_or_else(||"资源可能已经发布".into())))};
    let settled=holder.lock().map(|holder|holder.settled()).unwrap_or(false);
    operation.done.store(true,Ordering::Release);
    if settled {if let Ok(holder)=holder.lock(){if let Some(job)=&holder.job{job.complete(result.as_ref().map(|_|()).map_err(Clone::clone));}}
        report.emit(0,0,Some(result.is_ok()));drop(holder);registered.finish();gate.finish();}
    else {std::mem::forget((holder,registered,gate));}
    result
}
async fn run(request:&Request,scope:&Scope,operation:&Arc<Operation>,report:&Report,holder:&Holder,host:Host,binder:Binder,transfer:Transfer)->Result<String> {
    operation.check()?;
    let anchor=scope.root_mark.open()?;owner(holder)?.anchor=Some(anchor);
    let guard=install_lock::acquire(&scope.root,||operation.check().is_err()).await?;owner(holder)?.root=Some(guard);
    let context_scope=scope.clone();let context_request=request.clone();let context_host=host.clone();let context_operation=operation.clone();
    let selected=blocking(holder,move||with_current(&context_host,|current|context(&context_scope,&context_request,current,&context_operation.token))).await?;
    let context=Arc::new(selected);
    let watch_scope=scope.clone();let watch_request=request.clone();let watch_context=context.clone();let watch_operation=operation.clone();let watch_host=host.clone();
    let watcher=tokio::spawn(async move {loop {
        if watch_operation.done.load(Ordering::Acquire){return;}
        let state=with_current(&watch_host,|current|watch_context.policy(&watch_scope,&watch_request,current));
        if state.is_err()||watch_operation.cancel.check().is_err(){watch_operation.stop();return;}
        tokio::time::sleep(Duration::from_millis(50)).await;
    }});
    struct Watch(tokio::task::JoinHandle<()>);impl Drop for Watch{fn drop(&mut self){self.0.abort();}}
    let _watch=Watch(watcher);
    let source_report=report.clone();
    let source_progress:super::offline_translate::Progress=Arc::new(move|bytes,total|source_report.emit(bytes,total,None));
    let prepared=binder(request.clone(),context.settings.clone(),operation.clone(),source_progress).await?;
    context.compatible(&prepared)?;
    let bound=prepared.bound().clone();
    if !matches!(&prepared,Prepared::OfflineTranslate(_)){report.emit(0,bound.size,None);}
    operation.check()?;
    let init_holder=holder.clone();let init_scope=scope.clone();let init_request=request.clone();let init_context=context.clone();let init_host=host.clone();let init_bound=bound.clone();let init_operation=operation.clone();
    let destination=blocking(holder,move||with_current(&init_host,|current|{init_operation.check()?;init_context.verify(&init_scope,&init_request,current,&init_operation.token)?;initialize(&init_holder,&init_scope,&init_context,&init_request,&init_bound,&init_operation.token)})).await?;
    let take_holder=holder.clone();let file=blocking(holder,move||owner(&take_holder)?.stage.as_mut().ok_or(UNKNOWN)?.take_file(0)).await?;
    let progress_report=report.clone();let progress=Arc::new(move|bytes,total|progress_report.emit(bytes,total,None));
    // 不以 select 丢弃任何写入；其返回前实际 File 写入、sync 与关闭必须完成。
    match prepared {
        Prepared::Official(bound) | Prepared::Compatible(bound, _) =>{transfer(bound,file,operation.cancel.clone(),progress).await?;},
        Prepared::OfflineTranslate(package)=>{package.write(file,operation.cancel.clone(),progress).await?;},
    }
    operation.check()?;
    let seal_holder=holder.clone();let seal_operation=operation.clone();blocking(holder,move||owner(&seal_holder)?.stage.as_mut().ok_or(UNKNOWN)?.seal(0,&seal_operation.token)).await?;
    let commit_holder=holder.clone();let commit_scope=scope.clone();let commit_request=request.clone();let commit_context=context.clone();let commit_host=host.clone();let commit_operation=operation.clone();
    blocking(holder,move||{
        with_current(&commit_host,|current|{commit_operation.check()?;commit_context.verify(&commit_scope,&commit_request,current,&commit_operation.token)})?;
        commit_operation.committing.store(true,Ordering::Release);
        let result=owner(&commit_holder)?.stage.as_mut().ok_or(UNKNOWN)?.commit(&commit_operation.token);
        if result.is_ok(){commit_operation.published.store(true,Ordering::Release);}commit_operation.committing.store(false,Ordering::Release);result
    }).await?;
    Ok(destination.to_string_lossy().into_owned())
}

#[cfg(unix)]
mod native {
    use super::*;use std::{ffi::CString,os::fd::AsRawFd};
    extern "C"{fn mkdirat(fd:i32,name:*const std::os::raw::c_char,mode:u32)->i32;}
    pub(super) fn mkdir(parent:&File,name:&str)->io::Result<()> {let name=CString::new(name).map_err(|_|io::ErrorKind::InvalidInput)?;
        if unsafe{mkdirat(parent.as_raw_fd(),name.as_ptr(),0o700)}==0{Ok(())}else{Err(io::Error::last_os_error())}}
}
#[cfg(windows)]
mod native {
    use super::*;use std::{ffi::c_void,os::windows::io::{AsRawHandle,FromRawHandle}};
    #[repr(C)]struct Text{length:u16,maximum:u16,buffer:*mut u16}
    #[repr(C)]struct Attr{length:u32,root:*mut c_void,name:*mut Text,flags:u32,security:*mut c_void,qos:*mut c_void}
    #[repr(C)]struct Status{status:isize,information:usize}
    #[link(name="ntdll")]extern "system"{fn NtCreateFile(file:*mut *mut c_void,access:u32,attrs:*mut Attr,status:*mut Status,allocation:*const i64,attributes:u32,share:u32,disposition:u32,options:u32,ea:*mut c_void,ea_len:u32)->i32;fn RtlNtStatusToDosError(status:i32)->u32;}
    pub(super)fn mkdir(parent:&File,name:&str)->io::Result<()>{access::leaf(name).map_err(io::Error::other)?;let mut wide:Vec<u16>=name.encode_utf16().collect();let size=u16::try_from(wide.len()*2).map_err(|_|io::ErrorKind::InvalidInput)?;
        let mut text=Text{length:size,maximum:size,buffer:wide.as_mut_ptr()};let mut attr=Attr{length:std::mem::size_of::<Attr>()as u32,root:parent.as_raw_handle(),name:&mut text,flags:0x40,security:std::ptr::null_mut(),qos:std::ptr::null_mut()};let mut status=Status{status:0,information:0};let mut file=std::ptr::null_mut();
        let result=unsafe{NtCreateFile(&mut file,0x80000000|0x00100000,&mut attr,&mut status,std::ptr::null(),0,3,2,0x20|0x00200000|1,std::ptr::null_mut(),0)};
        if result<0{Err(io::Error::from_raw_os_error(unsafe{RtlNtStatusToDosError(result)}as i32))}else{unsafe{drop(File::from_raw_handle(file))};Ok(())}}
}
#[cfg(not(any(unix,windows)))]
mod native {use super::*;pub(super)fn mkdir(_:&File,_:&str)->io::Result<()>{Err(io::Error::from(io::ErrorKind::Unsupported))}}

#[cfg(test)]
mod tests {
    use super::*;
    use sha1::{Digest, Sha1};
    use sha2::Sha512;
    use std::{fs, io::{Read, Write}, sync::Condvar};

    struct Fixture { root:PathBuf, settings:Arc<Mutex<Value>> }
    impl Fixture {
        fn new()->Self {
            let path=std::env::temp_dir().join(format!("hcmcl-catalog-install-{}",uuid::Uuid::new_v4()));
            fs::create_dir_all(path.join("versions/demo")).unwrap();
            fs::write(path.join("versions/demo/demo.json"),serde_json::to_vec(&json!({"id":"demo","clientVersion":"1.21.1","mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient","libraries":[{"name":"net.fabricmc:fabric-loader:0.16.9"}]})).unwrap()).unwrap();
            let root=fs::canonicalize(path).unwrap();
            Self { settings:Arc::new(Mutex::new(json!({"gameDirAbs":root,"mode":"normal","selectedVersionDirId":"default","versionIsolation":false}))),root }
        }
        fn request(&self)->Request {Request::parse(INSTALL,&[json!("https://cdn.modrinth.com/data/project/versions/ver/sample.jar"),json!("sample.jar"),json!("demo")]).unwrap()}
        fn scope(&self,request:&Request)->Scope {Scope::capture(request,&self.settings.lock().unwrap(),&self.root).unwrap()}
        fn host(&self)->Host {let settings=self.settings.clone();Arc::new(move|work|{let current=settings.lock().map_err(|_|CHANGED)?.clone();work(&current)})}
    }
    impl Drop for Fixture {fn drop(&mut self){let _=fs::remove_dir_all(&self.root);}}
    fn bound(bytes:&[u8])->BoundDownload {
        let raw=json!({"filename":"sample.jar","url":"https://cdn.modrinth.com/data/project/versions/ver/sample.jar","size":bytes.len(),
            "hashes":{"sha1":format!("{:x}",Sha1::digest(bytes)),"sha512":format!("{:x}",Sha512::digest(bytes))}});
        super::super::bound_modrinth_file(&raw,None,"sample.jar").unwrap()
    }
    fn fixed(value:BoundDownload)->Binder {Arc::new(move|_,_,operation,_|{let value=value.clone();Box::pin(async move{operation.check()?;Ok(Prepared::Compatible(value,compatibility::Tags::fabric("1.21.1")))})})}
    fn bytes_transfer(bytes:Vec<u8>, failure:bool)->Transfer {
        Arc::new(move|bound,file,cancel,progress|{let bytes=bytes.clone();Box::pin(async move {
            let(tx,rx)=tokio::sync::mpsc::channel(2);let work_cancel=cancel.clone();
            let writer=tokio::task::spawn_blocking(move||super::super::export_writer(file,bound,rx,work_cancel,progress));
            let sent=tx.send(super::super::ExportChunk::Data(bytes)).await;
            if !failure&&sent.is_ok(){let _=tx.send(super::super::ExportChunk::Finish).await;}
            drop(tx);let result=writer.await.map_err(|_|UNKNOWN.to_owned())?;
            if failure{Err("受控网络失败".into())}else{result}
        })})
    }
    struct Session {waiting:Waiting,work:tokio::task::JoinHandle<Result<String>>,operation:Arc<Operation>,holder:Holder,registry:Registry,gate:lifecycle::Gate,events:Arc<Mutex<Vec<Value>>>}
    fn start(fixture:&Fixture,request:Request,binder:Binder,transfer:Transfer)->Session {
        let scope=fixture.scope(&request);let gate=lifecycle::Gate::default();let request_gate=gate.enter().unwrap();
        let job=JobGuard::register(&scope.root,&request.initial_task()).unwrap();let operation=Operation::new(request.initial_task(),job.cancel());
        let registry=Registry::default();let registration=registry.begin(operation.clone()).unwrap();let waiting=Waiting(operation.clone());
        let holder=Arc::new(Mutex::new(Owner{root:None,anchor:None,job:Some(job),stage:None,pending:false,uncertain:false}));
        let events=Arc::new(Mutex::new(Vec::new()));let recorded=events.clone();let report=Report{operation:operation.clone(),sink:Arc::new(move|value|recorded.lock().unwrap().push(value))};
        let work=tokio::spawn(supervise(request,scope,operation.clone(),report,holder.clone(),registration,request_gate,fixture.host(),binder,transfer));
        Session{waiting,work,operation,holder,registry,gate,events}
    }
    async fn finish(session:Session)->(Result<String>,Vec<Value>){let result=session.work.await.unwrap();drop(session.waiting);let events=session.events.lock().unwrap().clone();(result,events)}
    fn offline_request()->Request {Request::parse(OFFLINE_TRANSLATE,&[json!("demo")]).unwrap()}
    fn offline_source(pool:Arc<tokio::sync::Semaphore>,before:Option<Arc<dyn Fn()+Send+Sync>>)->super::super::offline_translate::Source {
        Arc::new(move|cancel,progress|{let pool=pool.clone();let before=before.clone();Box::pin(async move {
            let package=super::super::offline_translate::fixture_package(super::super::offline_translate::jar_fixture(),cancel,progress,pool).await?;
            Ok(if let Some(before)=before{package.with_write_fixture(before)}else{package})
        })})
    }
    fn no_generic_transfer()->Transfer {Arc::new(|_,_,_,_|Box::pin(async{panic!("固定源不应进入通用下载器")}))}

    #[test]
    fn original_request_contracts_and_fabric_file_selection_remain_exact() {
        let f=Fixture::new();let request=f.request();assert!(matches!(request,Request::File{hint:None,..}));
        for args in [vec![],vec![json!("1.21.1")],vec![json!("1.21.1"),json!("../escape")],vec![json!("1.21.1"),json!("demo"),json!("extra")]]{assert!(Request::parse(FABRIC,&args).is_err());}
        assert!(Request::parse(FABRIC,&[json!("1.21.1"),json!("demo")]).is_ok());
        assert!(Request::parse(INSTALL,&[json!("https://example.org/a.jar"),json!("a.jar"),json!("demo")]).is_err());
        let good=bound(b"valid");let raw=json!([{"game_versions":["1.20"],"loaders":["fabric"],"files":[]},
            {"game_versions":["1.21.1"],"loaders":["fabric"],"files":[{"filename":good.filename,"url":good.url,"size":good.size,"primary":true,"hashes":{"sha1":good.sha1,"sha512":good.sha512}}]}]);
        assert_eq!(fabric_bound(&raw,"1.21.1").unwrap().filename,"sample.jar");assert!(fabric_bound(&raw,"1.19").is_err());
    }

    #[test]
    fn offline_translate_entry_is_fixed_and_rejects_unsupported_settings() {
        let request=offline_request();assert!(matches!(&request,Request::OfflineTranslate{instance} if instance=="demo"));
        assert_eq!(request.initial_task(),super::super::offline_translate::FILENAME);assert_eq!(request.kind(),"mod");
        for args in [vec![],vec![Value::Null],vec![json!("../demo")],vec![json!("demo"),json!("caller.jar")]] {
            assert!(Request::parse(OFFLINE_TRANSLATE,&args).is_err());
        }
        assert!(allowed(&json!({"mode":"local"})).is_err());
        assert!(allowed(&json!({"mode":"normal","metadataOnlyMods":true})).is_err());
        assert_eq!(request.directory_id(&json!({"selectedVersionDirId":"selected"})),"selected");
    }

    #[tokio::test]
    async fn offline_translate_worker_publishes_shared_or_isolated_path_before_done_100() {
        for isolated in [false,true] {
            let f=Fixture::new();f.settings.lock().unwrap()["versionIsolation"]=json!(isolated);
            let pool=Arc::new(tokio::sync::Semaphore::new(1));let name=super::super::offline_translate::FILENAME;
            let session=start(&f,offline_request(),binder_with_source(offline_source(pool.clone(),None)),no_generic_transfer());
            let(result,events)=finish(session).await;let path=PathBuf::from(result.unwrap());
            assert_eq!(path,if isolated{f.root.join("versions/demo/mods").join(name)}else{f.root.join("mods").join(name)});
            assert_eq!(fs::read(path).unwrap(),super::super::offline_translate::jar_fixture());assert_eq!(pool.available_permits(),1);
            assert!(events.iter().all(|v|v["taskId"]==name));
            assert!(events.iter().filter(|v|v["phase"]=="mod").all(|v|v["percent"].as_f64().unwrap()<100.0));
            assert_eq!(events.last().unwrap()["phase"],"done");assert_eq!(events.last().unwrap()["percent"],100.0);
            assert!(!serde_json::to_string(&events).unwrap().contains("sign="));
        }
    }

    #[tokio::test]
    async fn offline_translate_existing_target_and_changed_mode_never_publish() {
        for changed in [false,true] {
            let f=Fixture::new();let name=super::super::offline_translate::FILENAME;
            if !changed{fs::create_dir(f.root.join("mods")).unwrap();fs::write(f.root.join("mods").join(name),b"existing winner").unwrap();}
            let pool=Arc::new(tokio::sync::Semaphore::new(1));let work_pool=pool.clone();let settings=f.settings.clone();
            let source:super::super::offline_translate::Source=Arc::new(move|cancel,progress|{let pool=work_pool.clone();let settings=settings.clone();Box::pin(async move {
                let package=super::super::offline_translate::fixture_package(super::super::offline_translate::jar_fixture(),cancel,progress,pool).await?;
                if changed{settings.lock().unwrap()["mode"]=json!("local");}Ok(package)
            })});
            let session=start(&f,offline_request(),binder_with_source(source),no_generic_transfer());let registry=session.registry.clone();let gate=session.gate.clone();
            let(result,events)=finish(session).await;assert!(result.is_err());assert_eq!(pool.available_permits(),1);
            if changed{assert!(!f.root.join("mods").join(name).exists());}else{assert_eq!(fs::read(f.root.join("mods").join(name)).unwrap(),b"existing winner");}
            assert!(!events.iter().any(|v|v["percent"]==100.0));assert!(registry.ready().is_ok());assert!(gate.begin_restart().is_ok());
        }
    }

    #[tokio::test]
    async fn both_existing_entries_publish_real_files_and_only_then_emit_done_100() {
        for fabric in [false,true] {
            let f=Fixture::new();let bytes=b"official fixture contents".to_vec();
            let request=if fabric{Request::parse(FABRIC,&[json!("1.21.1"),json!("demo")]).unwrap()}else{f.request()};
            let task=request.initial_task();
            let session=start(&f,request,fixed(bound(&bytes)),bytes_transfer(bytes.clone(),false));
            let (result,events)=finish(session).await;let path=PathBuf::from(result.unwrap());assert_eq!(fs::read(&path).unwrap(),bytes);
            assert_eq!(path,f.root.join("mods/sample.jar"));
            assert_eq!(task,if fabric{"fabric-api:demo"}else{"sample.jar"});
            assert!(events.iter().all(|v|v["taskId"].as_str()==Some(task.as_str())));
            assert!(events.iter().filter(|v|v["phase"]=="mod").all(|v|v["percent"].as_f64().unwrap()<100.0));
            assert_eq!(events.last().unwrap()["percent"],100.0);assert_eq!(events.last().unwrap()["phase"],"done");
        }
    }

    #[tokio::test]
    async fn incompatible_mod_or_fabric_target_never_starts_the_file_transfer() {
        for wrong_fabric_game in [false,true] {
            let f=Fixture::new();
            let request=if wrong_fabric_game {Request::parse(FABRIC,&[json!("1.20.1"),json!("demo")]).unwrap()}else{f.request()};
            let incompatible:Binder=Arc::new(|_,_,_,_|Box::pin(async{Ok(Prepared::Compatible(bound(b"mod"),compatibility::Tags::fabric("1.20.1")))}));
            let (result,events)=finish(start(&f,request,incompatible,no_generic_transfer())).await;
            assert!(result.is_err());assert!(!f.root.join("mods").exists());
            assert!(!events.iter().any(|v|v["percent"]==100.0));
        }
    }

    #[tokio::test]
    async fn instance_profile_changed_during_transfer_prevents_publication() {
        let f=Fixture::new();let profile=f.root.join("versions/demo/demo.json");
        let transfer:Transfer=Arc::new(move|bound,file,cancel,progress|{let profile=profile.clone();Box::pin(async move{
            let bytes=bytes_transfer(b"mod".to_vec(),false)(bound,file,cancel,progress).await?;
            fs::write(profile,serde_json::to_vec(&json!({"id":"demo","clientVersion":"1.20.1","libraries":[{"name":"net.fabricmc:fabric-loader:0.16.9"}]})).unwrap()).unwrap();
            Ok(bytes)
        })});
        let session=start(&f,f.request(),fixed(bound(b"mod")),transfer);let registry=session.registry.clone();let gate=session.gate.clone();
        let (result,events)=finish(session).await;
        assert!(result.is_err());assert!(!f.root.join("mods/sample.jar").exists());
        assert!(!events.iter().any(|v|v["percent"]==100.0));assert!(registry.ready().is_ok());assert!(gate.begin_restart().is_ok());
    }

    #[tokio::test]
    async fn existing_or_concurrent_targets_are_never_overwritten() {
        let f=Fixture::new();fs::create_dir(f.root.join("mods")).unwrap();fs::write(f.root.join("mods/sample.jar"),b"winner").unwrap();
        let (result,events)=finish(start(&f,f.request(),fixed(bound(b"new")),bytes_transfer(b"new".to_vec(),false))).await;
        assert!(result.is_err());assert_eq!(fs::read(f.root.join("mods/sample.jar")).unwrap(),b"winner");assert!(!events.iter().any(|v|v["percent"]==100.0));
        fs::remove_file(f.root.join("mods/sample.jar")).unwrap();let target=f.root.join("mods/sample.jar");
        let transfer:Transfer=Arc::new(move|bound,file,cancel,progress|{let target=target.clone();Box::pin(async move{
            let result=bytes_transfer(b"new".to_vec(),false)(bound,file,cancel,progress).await?;fs::write(target,b"late winner").unwrap();Ok(result)
        })});
        let (result,_)=finish(start(&f,f.request(),fixed(bound(b"new")),transfer)).await;assert!(result.is_err());assert_eq!(fs::read(f.root.join("mods/sample.jar")).unwrap(),b"late winner");
    }

    #[tokio::test]
    async fn wrong_hash_size_or_transport_failure_never_publishes() {
        for mode in 0..3 {
            let f=Fixture::new();let expected=bound(b"expected");let bytes=if mode==0{b"different".to_vec()}else if mode==1{b"short".to_vec()}else{b"expected".to_vec()};
            let session=start(&f,f.request(),fixed(expected),bytes_transfer(bytes,mode==2));let registry=session.registry.clone();let gate=session.gate.clone();
            let(result,events)=finish(session).await;assert!(result.is_err());assert!(!f.root.join("mods/sample.jar").exists());
            assert!(!events.iter().any(|v|v["percent"]==100.0));assert!(registry.ready().is_ok());assert!(gate.begin_restart().is_ok());
        }
    }

    #[tokio::test]
    async fn lock_wait_rechecks_root_mode_metadata_and_uses_latest_isolation() {
        for mode in 0..5 {
            let f=Fixture::new();let guard=install_lock::acquire(&f.root,||false).await.unwrap();
            let session=start(&f,f.request(),fixed(bound(b"file")),bytes_transfer(b"file".to_vec(),false));
            {let mut settings=f.settings.lock().unwrap();match mode{
                0=>settings["gameDirAbs"]=json!(f.root.join("other")),1=>settings["mode"]=json!("local"),
                2=>settings["metadataOnlyMods"]=json!(true),3=>settings["versionIsolation"]=json!(true),
                _=>{settings["selectedVersionDirId"]=json!("missing");}
            }}
            drop(guard);let(result,_)=finish(session).await;
            if mode==3{assert_eq!(PathBuf::from(result.unwrap()),f.root.join("versions/demo/mods/sample.jar"));assert!(!f.root.join("mods").exists());}
            else{assert!(result.is_err());assert!(!f.root.join("mods").exists());}
        }
    }

    #[test]
    fn close_cancel_and_readiness_only_signal_and_reject_late_registration() {
        let registry=Registry::default();let operation=Operation::new("sample.jar".into(),Arc::new(Cancel::default()));let registration=registry.begin(operation.clone()).unwrap();
        assert!(registry.ready().is_err());assert!(operation.check().is_ok());assert!(registry.ready().is_err());assert!(operation.check().is_ok());
        registry.cancel(Some("different.jar")).unwrap();assert!(operation.check().is_ok());registry.close();assert!(operation.check().is_err());
        assert_eq!(registry.0.lock().unwrap().active.len(),1);assert!(registry.begin(Operation::new("late".into(),Arc::new(Cancel::default()))).is_err());
        registration.finish();assert!(registry.ready().is_ok());
        let committed=Operation::new("done".into(),Arc::new(Cancel::default()));committed.published.store(true,Ordering::Release);assert!(committed.request_stop().unwrap_err().contains("不能撤销"));
    }

    #[test]
    fn fabric_initial_task_matches_cancel_and_does_not_follow_download_filename() {
        let request=Request::parse(FABRIC,&[json!("1.21.1"),json!("demo")]).unwrap();
        let task=request.initial_task();assert_eq!(task,"fabric-api:demo");
        let registry=Registry::default();let operation=Operation::new(task.clone(),Arc::new(Cancel::default()));
        let registration=registry.begin(operation.clone()).unwrap();
        registry.cancel(Some("sample.jar")).unwrap();assert!(operation.check().is_ok());
        registry.cancel(Some(&task)).unwrap();assert!(operation.check().is_err());
        assert_eq!(operation.task,"fabric-api:demo");registration.finish();
    }

    struct WriteBarrier {state:Mutex<(bool,bool)>,signal:Condvar}
    impl WriteBarrier {
        fn new()->Arc<Self>{Arc::new(Self{state:Mutex::new((false,false)),signal:Condvar::new()})}
        fn enter(&self){let mut state=self.state.lock().unwrap();state.0=true;self.signal.notify_all();while !state.1{state=self.signal.wait(state).unwrap();}}
        fn release(&self){self.state.lock().unwrap().1=true;self.signal.notify_all();}
        fn entered(&self)->bool{let state=self.state.lock().unwrap();let(state,_)=self.signal.wait_timeout_while(state,Duration::from_secs(5),|v|!v.0).unwrap();state.0}
    }
    struct BlockingFile {file:File,barrier:Arc<WriteBarrier>}
    impl Write for BlockingFile {
        fn write(&mut self,bytes:&[u8])->io::Result<usize>{self.barrier.enter();self.file.write(bytes)}
        fn flush(&mut self)->io::Result<()>{self.file.flush()}
    }
    impl super::super::ExportSink for BlockingFile {
        fn prepare(&mut self)->Result<()>{super::super::ExportSink::prepare(&mut self.file)}
        fn sync_export(&mut self)->Result<()>{self.file.sync_all().map_err(|_|"fixture sync".into())}
    }
    fn gated_transfer(barrier:Arc<WriteBarrier>,unknown:Option<PathBuf>)->Transfer {
        Arc::new(move|bound,file,cancel,progress|{let barrier=barrier.clone();let unknown=unknown.clone();Box::pin(async move{
            let(tx,rx)=tokio::sync::mpsc::channel(2);let work_cancel=cancel.clone();
            let writer=tokio::task::spawn_blocking(move||super::super::export_writer(BlockingFile{file,barrier},bound,rx,work_cancel,progress));
            let _=tx.send(super::super::ExportChunk::Data(b"blocked".to_vec())).await;
            let _=tx.send(super::super::ExportChunk::Finish).await;drop(tx);
            let result=writer.await.map_err(|_|UNKNOWN.to_owned())?;
            if let Some(path)=unknown{fs::write(path,b"unknown child").unwrap();}
            result
        })})
    }

    #[tokio::test(flavor="multi_thread",worker_threads=2)]
    async fn offline_translate_cancel_or_ipc_drop_joins_real_writer_before_releasing_owners() {
        for explicit_cancel in [true,false] {
            let f=Fixture::new();let name=super::super::offline_translate::FILENAME;
            let pool=Arc::new(tokio::sync::Semaphore::new(1));let barrier=WriteBarrier::new();let blocked=barrier.clone();
            let before:Arc<dyn Fn()+Send+Sync>=Arc::new(move||blocked.enter());
            let session=start(&f,offline_request(),binder_with_source(offline_source(pool.clone(),Some(before))),no_generic_transfer());
            let entered={let wait=barrier.clone();tokio::task::spawn_blocking(move||wait.entered()).await.unwrap()};
            let Session{waiting,work,operation,holder,registry,gate,events}=session;
            if explicit_cancel{registry.cancel(Some(name)).unwrap();}drop(waiting);
            let retained=!work.is_finished()&&pool.available_permits()==0&&registry.ready().is_err()&&gate.begin_restart().is_err()
                &&JobGuard::register(&f.root,name).is_err()&&holder.lock().unwrap().root.is_some();
            barrier.release();let result=tokio::time::timeout(Duration::from_secs(5),work).await.unwrap().unwrap();
            assert!(entered&&retained);assert!(result.is_err());assert!(!f.root.join("mods").join(name).exists());
            assert_eq!(pool.available_permits(),1);assert!(registry.ready().is_ok());assert!(gate.begin_restart().is_ok());
            assert!(holder.lock().unwrap().settled());assert!(operation.done.load(Ordering::Acquire));
            assert!(!events.lock().unwrap().iter().any(|v|v["percent"]==100.0));
        }
    }

    #[tokio::test(flavor="multi_thread",worker_threads=2)]
    async fn real_writer_cancel_ipc_drop_and_close_keep_all_owners_until_join() {
        for mode in 0..3 {
            let f=Fixture::new();let barrier=WriteBarrier::new();let session=start(&f,f.request(),fixed(bound(b"blocked")),gated_transfer(barrier.clone(),None));
            let entered={let wait=barrier.clone();tokio::task::spawn_blocking(move||wait.entered()).await.unwrap()};
            let busy=!session.work.is_finished()&&session.registry.ready().is_err()&&session.gate.begin_restart().is_err()&&JobGuard::register(&f.root,"sample.jar").is_err();
            let journal=f.root.join(".hcmcl-resource-updates");let staged=journal.is_dir();
            let Session{waiting,work,operation,holder,registry,gate,events}=session;
            match mode{0=>{registry.cancel(Some("sample.jar")).unwrap();drop(waiting);},1=>drop(waiting),_=>{registry.close();drop(waiting);}}
            let retained=!work.is_finished()&&registry.ready().is_err();barrier.release();let result=work.await.unwrap();
            assert!(entered&&busy&&staged&&retained);assert!(result.is_err());assert!(!f.root.join("mods/sample.jar").exists());
            assert!(registry.ready().is_ok());assert!(gate.begin_restart().is_ok());assert!(holder.lock().unwrap().settled());
            assert!(!events.lock().unwrap().iter().any(|v|v["percent"]==100.0));drop(operation);drop(holder);
        }
    }

    #[tokio::test]
    async fn unknown_cleanup_retains_owned_stage_job_gate_and_root() {
        let f=Fixture::new();let stage_root=f.root.join(".hcmcl-resource-updates");let holder_slot:Arc<Mutex<Option<Holder>>>=Arc::new(Mutex::new(None));let slot=holder_slot.clone();
        let transfer:Transfer=Arc::new(move|bound,file,cancel,progress|{let stage_root=stage_root.clone();let slot=slot.clone();Box::pin(async move {
            let bytes=bytes_transfer(b"file".to_vec(),false)(bound,file,cancel,progress).await?;
            let journal=fs::read_dir(&stage_root).unwrap().filter_map(|v|v.ok()).map(|v|v.path()).find(|v|v.is_dir()).unwrap();
            fs::write(journal.join("unknown"),b"keep").unwrap();let _=&slot;Ok(bytes)
        })});
        let session=start(&f,f.request(),fixed(bound(b"file")),transfer);let registry=session.registry.clone();let gate=session.gate.clone();
        let(result,events)=finish(session).await;assert!(result.is_err());assert!(registry.ready().is_err());assert!(gate.begin_restart().is_err());
        assert!(JobGuard::register(&f.root,"sample.jar").is_err());assert!(!events.iter().any(|v|v["percent"]==100.0));
    }

    #[cfg(unix)]
    #[test]
    fn linked_or_external_roots_and_resource_folders_are_rejected() {
        use std::os::unix::fs::symlink;
        let f=Fixture::new();let outside=Fixture::new();symlink(&outside.root,f.root.join("mods")).unwrap();
        let request=f.request();let scope=f.scope(&request);let ctx=context(&scope,&request,&f.settings.lock().unwrap(),&AtomicBool::new(false)).unwrap();
        assert!(ensure_folder(&ctx,"mods").is_err());assert!(!outside.root.join("sample.jar").exists());
        let linked=f.root.with_file_name(format!("linked-{}",uuid::Uuid::new_v4()));symlink(&f.root,&linked).unwrap();
        let settings=json!({"gameDirAbs":linked});assert!(Scope::capture(&request,&settings,&linked).is_err());fs::remove_file(linked).unwrap();
    }
}

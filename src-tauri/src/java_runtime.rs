//! 受控安装 Adoptium Temurin JRE。
//! 该模块只接管 `java:install`；检测、启动和安装器 Java 选择仍由 runtime.rs 负责。
//! 下载、解包、探测和存储 CAS 都在一个拥有 JobGuard/根锁的 worker 内完成。

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tauri::{Emitter, Manager};

mod archive;
mod binary;

use crate::{downloads, install_lock};

pub(crate) type Result<T> = std::result::Result<T, String>;

const JSON_LIMIT: usize = 32 * 1024 * 1024;
const ARCHIVE_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_SECS: u64 = 180;
const CHUNK_TIMEOUT_SECS: u64 = 20;
const PACKAGE_HOST: &str = "github.com";
const RELEASE_HOSTS: &[&str] = &[
    "github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
    "github-releases.githubusercontent.com",
];

#[derive(Default)]
struct WindowInstalls { closed: bool, active: HashMap<String, Arc<downloads::Cancel>> }
impl WindowInstalls {
    fn insert(&mut self,id:String,cancel:Arc<downloads::Cancel>)->Result<()> {
        if self.closed { return Err("主窗口已关闭，不能登记新的 Java 安装任务".into()); }
        if self.active.len()>=128 { return Err("Java 安装任务过多".into()); }
        self.active.insert(id,cancel);Ok(())
    }
    fn close(&mut self) { self.closed=true;for cancel in self.active.values(){cancel.stop();} }
}
static ACTIVE_CANCELS: OnceLock<Mutex<WindowInstalls>> = OnceLock::new();

pub(crate) fn cancel_for_window() {
    // 主窗口关闭后本进程不重新开放 Java 安装；同一互斥锁阻止关闭前暂停的 IPC 迟到登记。
    if let Ok(mut active)=ACTIVE_CANCELS.get_or_init(||Mutex::new(WindowInstalls::default())).lock(){active.close();}
}

fn installs_relaunch_ready(installs:&Mutex<WindowInstalls>)->Result<()> {
    let state=installs.try_lock().map_err(|_|"Java 安装状态忙碌或不可用，不能确认已收尾，暂不能重启")?;
    if state.closed {return Err("主窗口已关闭，不能确认 Java 安装状态，暂不能重启".into());}
    if !state.active.is_empty() {return Err("Java 安装任务仍在运行或收尾，暂不能重启".into());}
    Ok(())
}
/// 仅查看登记，不取消任务；worker 真正释放登记前始终拒绝重启。
pub(crate) fn relaunch_ready()->std::result::Result<(),String> {
    installs_relaunch_ready(ACTIVE_CANCELS.get_or_init(||Mutex::new(WindowInstalls::default())))
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn cancelled(cancel: &downloads::Cancel) -> Result<()> {
    cancel.check()
}

fn desktop_only() -> Result<()> {
    // 与 runtime 的平台边界保持同一句话：移动端不登记任务、不发起网络请求。
    if !crate::runtime::native_game_supported() {
        return Err(crate::runtime::MOBILE_JAVA_BOUNDARY.into());
    }
    Ok(())
}

fn target_platform() -> Result<(&'static str, &'static str)> {
    desktop_only()?;
    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "mac"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        return Err("当前平台没有受支持的 Temurin JRE 安装包".into());
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        return Err("当前 CPU 架构没有受支持的 Temurin JRE 安装包".into());
    };
    Ok((os, arch))
}

fn valid_major(value: &Value) -> Result<u64> {
    let major = value
        .as_u64()
        .ok_or("java:install 参数必须是一个 JSON 整数")?;
    if !(8..=99).contains(&major) {
        return Err("Java 主版本必须在 8..99 之间".into());
    }
    Ok(major)
}

fn safe_component(value: &str) -> Result<&str> {
    downloads::identifier(value)?;
    if value.contains('+') || value.contains('%') || value.contains('#') {
        // 这些字符在包名中可能出现，但不能让其改变路径或 URL 语义；包名仍会经过
        // 官方元数据的精确匹配，故这里只拒绝会产生额外 URL 语义的字符。
        if value.contains('%') || value.contains('#') {
            return Err("Java 归档文件名包含不安全字符".into());
        }
    }
    Ok(value)
}

fn package_url(url: &str, major: u64, redirect: bool) -> Result<reqwest::Url> {
    if url.len() > 32_768 || url.chars().any(char::is_control) {
        return Err("Java 下载地址无效".into());
    }
    let parsed = reqwest::Url::parse(url).map_err(|_| "Java 下载地址无效")?;
    if parsed.scheme() != "https"
        || parsed.port().is_some_and(|port| port != 443)
        || parsed.username() != ""
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Java 下载地址必须是无凭据的 HTTPS".into());
    }
    let host = parsed.host_str().ok_or("Java 下载地址缺少主机")?;
    if redirect {
        if !RELEASE_HOSTS.contains(&host) {
            return Err("Java 下载重定向超出官方发布域名".into());
        }
        return Ok(parsed);
    }
    if host != PACKAGE_HOST {
        return Err("Java 包地址必须来自 Temurin 官方仓库".into());
    }
    let path = parsed.path();
    let prefix = format!("/adoptium/temurin{major}-binaries/releases/download/");
    if !path.starts_with(&prefix)
        || !(path.ends_with(".zip") || path.ends_with(".tar.gz"))
        || parsed.query().is_some()
    {
        return Err("Java 包地址不是受支持的 Temurin 发布路径".into());
    }
    Ok(parsed)
}

fn metadata_url(major: u64, os: &str, arch: &str) -> Result<reqwest::Url> {
    let raw = format!(
        "https://api.adoptium.net/v3/assets/latest/{major}/hotspot?os={os}&architecture={arch}&image_type=jre"
    );
    let url = reqwest::Url::parse(&raw).map_err(|_| "Java 元数据地址无效")?;
    if url.host_str() != Some("api.adoptium.net") || url.scheme() != "https" {
        return Err("Java 元数据地址不是官方 API".into());
    }
    Ok(url)
}

#[derive(Clone)]
struct Package {
    major: u64,
    name: String,
    url: String,
    sha256: String,
    size: u64,
    os: String,
    arch: String,
}

fn digest(value: &str) -> Result<String> {
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Adoptium 包缺少有效 SHA-256 摘要".into());
    }
    Ok(value.to_ascii_lowercase())
}

fn package_from_metadata(bytes: &[u8], major: u64, os: &str, arch: &str) -> Result<Package> {
    if bytes.len() > JSON_LIMIT { return Err("Java 元数据超过大小上限".into()); }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "Adoptium 元数据不是有效 JSON")?;
    let assets = value.as_array().ok_or("Adoptium 元数据不是数组")?;
    if assets.len() > 512 { return Err("Adoptium Java 候选过多".into()); }
    let mut found = None;
    for asset in assets {
        let binary = asset.get("binary").ok_or("Adoptium 元数据缺少 binary")?;
        let actual_major = asset.get("version").and_then(|v| v.get("major")).and_then(Value::as_u64);
        if actual_major != Some(major) { continue; }
        let vendor = text(asset, "vendor").to_ascii_lowercase();
        if vendor != "eclipse" { continue; }
        if text(binary, "os") != os || text(binary, "architecture") != arch
            || text(binary, "image_type") != "jre" || text(binary, "jvm_impl") != "hotspot" { continue; }
        let package = binary.get("package").ok_or("Adoptium 元数据缺少 package")?;
        let name = safe_component(text(package, "name"))?.to_string();
        if !(name.ends_with(".zip") || name.ends_with(".tar.gz")) { return Err("Adoptium JRE 归档格式不受支持".into()); }
        let sha256 = digest(text(package, "checksum"))?;
        let size = package.get("size").and_then(Value::as_u64).filter(|n| *n > 0 && *n <= ARCHIVE_LIMIT).ok_or("Adoptium JRE 包大小无效")?;
        let url = text(package, "link").to_string();
        let parsed = package_url(&url, major, false)?;
        let basename = parsed.path().rsplit('/').next().unwrap_or("").replace("%2B", "+").replace("%2b", "+");
        if basename != name { return Err("Adoptium 包 URL 文件名与元数据不一致".into()); }
        found = Some(Package { major, name, url, sha256, size, os: os.into(), arch: arch.into() });
        break;
    }
    found.ok_or_else(|| format!("Adoptium 未提供 Java {major} 的 {os}/{arch} JRE"))
}

fn safe_metadata_path(root: &Path, major: u64) -> Result<PathBuf> {
    downloads::inside_path(root, Path::new(".hcmcl-cache").join("java").join(major.to_string()).join("metadata.json"))
}

fn safe_archive_path(root: &Path, major: u64, name: &str) -> Result<PathBuf> {
    safe_component(name)?;
    downloads::inside_path(root, Path::new(".hcmcl-cache").join("java").join(major.to_string()).join(name))
}

fn bounded_read(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let file = OpenOptions::new().read(true).open(path).map_err(|_| "本地模式缺少 Java 元数据缓存，未发起网络请求")?;
    let meta = file.metadata().map_err(|_| "无法读取 Java 元数据缓存属性")?;
    if !meta.is_file() || meta.len() > limit as u64 { return Err("Java 元数据缓存超过大小上限".into()); }
    let mut out = Vec::with_capacity(meta.len() as usize);
    file.take(limit as u64 + 1).read_to_end(&mut out).map_err(|_| "读取 Java 元数据缓存失败")?;
    if out.len() > limit { return Err("Java 元数据缓存超过大小上限".into()); }
    Ok(out)
}

fn read_cached_package(root: &Path, major: u64, os: &str, arch: &str) -> Result<Package> {
    let metadata = safe_metadata_path(root, major)?;
    let bytes = bounded_read(&metadata, JSON_LIMIT)?;
    let package = package_from_metadata(&bytes, major, os, arch)?;
    let archive = safe_archive_path(root, major, &package.name)?;
    let meta = fs::metadata(&archive).map_err(|_| "本地模式缺少 Java 归档缓存，未发起网络请求")?;
    if !meta.is_file() || meta.len() != package.size { return Err("本地模式 Java 归档缓存大小不符，未发起网络请求".into()); }
    Ok(package)
}

async fn read_metadata_response(mut response: reqwest::Response, limit: usize, cancel: &downloads::Cancel) -> Result<Vec<u8>> {
    if !response.status().is_success() { return Err("Adoptium Java 元数据请求失败".into()); }
    if response.content_length().is_some_and(|size| size > limit as u64) { return Err("Adoptium Java 元数据超过大小上限".into()); }
    let mut bytes = Vec::new();
    loop {
        let chunk = tokio::select! {
            _ = cancel.cancelled() => return Err("Java 下载已取消".into()),
            result = tokio::time::timeout(Duration::from_secs(CHUNK_TIMEOUT_SECS), response.chunk()) => result
                .map_err(|_| "Adoptium Java 元数据读取停滞超时")?.map_err(|_| "读取 Adoptium Java 元数据失败")?,
        };
        let Some(chunk) = chunk else { break; };
        if chunk.len() > limit.saturating_sub(bytes.len()) { return Err("Adoptium Java 元数据超过大小上限".into()); }
        bytes.extend_from_slice(&chunk);
    }
    cancelled(cancel)?;
    Ok(bytes)
}

struct Client {
    client: reqwest::Client,
}

impl Client {
    /// 进程内复用连接池：连续安装或重试 Java 时不必每次重新握手 TLS。
    fn shared() -> Result<reqwest::Client> {
        static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
        CLIENT.get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(12))
                .timeout(Duration::from_secs(DOWNLOAD_TIMEOUT_SECS))
                .user_agent("HCMCL-Tauri/0.7.6")
                .pool_max_idle_per_host(8)
                .build().ok()
        }).clone().ok_or_else(|| "无法初始化 Java 下载网络".to_owned())
    }
    fn new() -> Result<Self> {
        Ok(Self { client: Self::shared()? })
    }

    async fn metadata(&self, url: reqwest::Url, cancel: &downloads::Cancel) -> Result<Vec<u8>> {
        cancelled(cancel)?;
        let response = tokio::select! {
            _ = cancel.cancelled() => return Err("Java 下载已取消".into()),
            result = self.client.get(url).send() => result.map_err(|_| "无法获取 Adoptium Java 元数据")?,
        };
        read_metadata_response(response, JSON_LIMIT, cancel).await
    }

    async fn package(&self, package: &Package, target: &Path, cancel: &downloads::Cancel, progress: &ProgressSink) -> Result<()> {
        let mut url = package_url(&package.url, package.major, false)?;
        let mut response = None;
        for hop in 0..=5 {
            cancelled(cancel)?;
            let candidate = package_url(url.as_str(), package.major, hop > 0)?;
            let result = tokio::select! {
                _ = cancel.cancelled() => return Err("Java 下载已取消".into()),
                result = self.client.get(candidate.clone()).send() => result.map_err(|_| "Java JRE 下载连接失败")?,
            };
            if result.status().is_redirection() {
                if hop == 5 {
                    return Err("Java JRE 下载重定向次数过多".into());
                }
                let location = result
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or("Java JRE 下载重定向缺少地址")?;
                let next = candidate.join(location).map_err(|_| "Java JRE 下载重定向地址无效")?;
                package_url(next.as_str(), package.major, true)?;
                url = next;
                continue;
            }
            if !result.status().is_success() {
                return Err("Java JRE 下载请求失败".into());
            }
            response = Some(result);
            break;
        }
        let mut response = response.ok_or("Java JRE 下载没有响应")?;
        if response.content_length().is_some_and(|size| size > package.size) {
            return Err("Java JRE 下载超过元数据声明大小".into());
        }
        let parent = target.parent().ok_or("Java JRE 临时文件没有父目录")?;
        fs::create_dir_all(parent).map_err(|_| "无法创建 Java 下载目录")?;
        let mut file = tokio::fs::OpenOptions::new().write(true).create_new(true).open(target).await.map_err(|_| "无法独占创建 Java 临时归档")?;
        let mut received = 0u64;
        let mut pending: Vec<u8> = Vec::with_capacity(downloads::DOWNLOAD_CHUNK_BUFFER);
        loop {
            let chunk = tokio::select! {
                _ = cancel.cancelled() => return Err("Java 下载已取消".into()),
                result = tokio::time::timeout(Duration::from_secs(CHUNK_TIMEOUT_SECS), response.chunk()) => result
                    .map_err(|_| "Java JRE 下载读取停滞超时")?.map_err(|_| "读取 Java JRE 归档失败")?,
            };
            let Some(chunk) = chunk else { break };
            received = received.checked_add(chunk.len() as u64).ok_or("Java JRE 下载大小溢出")?;
            if received > package.size || received > ARCHIVE_LIMIT {
                return Err("Java JRE 下载超过安全大小上限".into());
            }
            cancelled(cancel)?;
            // 即使写失败也等 Tokio 后台写入 flush 完毕，禁止在 pending IO 时清理 staging。
            downloads::buffer_download_chunk(&mut file, &mut pending, &chunk).await.map_err(|_| "写入 Java JRE 临时归档失败")?;
            cancelled(cancel)?;
            progress.bytes(received, package.size, "下载 Java JRE");
        }
        downloads::flush_download_buffer(&mut file, &mut pending).await.map_err(|_| "刷新 Java JRE 临时归档失败")?;
        file.sync_all().await.map_err(|_| "提交 Java JRE 临时归档失败")?;
        if received != package.size {
            return Err("Java JRE 下载大小与元数据不符".into());
        }
        cancelled(cancel)
    }
}

struct ProgressSink {
    app: tauri::AppHandle,
    task_id: String,
    last: std::sync::Mutex<std::time::Instant>,
}

impl ProgressSink {
    fn new(app: tauri::AppHandle, task_id: String) -> Self {
        Self { app, task_id, last: std::sync::Mutex::new(std::time::Instant::now() - Duration::from_secs(1)) }
    }
    fn emit(&self, phase: &str, task: &str, current: u64, total: u64, percent: u64) {
        if let Ok(mut last) = self.last.lock() {
            if phase != "done" && last.elapsed() < Duration::from_millis(80) { return; }
            *last = std::time::Instant::now();
        }
        let payload = json!({"taskId":self.task_id,"jobTitle":format!("安装 Java {}",self.task_id.trim_start_matches("java-")),"task":task,"currentBytes":current,"totalBytes":total,"phase":phase,"percent":percent.min(100),"current":percent.min(100),"total":100,"speed":0});
        let _ = self.app.emit_to("main", "launcher:event", json!({"channel":"download:progress","payload":payload}));
    }
    fn bytes(&self, current: u64, total: u64, task: &str) {
        let percent = if total == 0 { 0 } else { current.saturating_mul(85) / total };
        self.emit("java", task, current, total, percent.max(1));
    }
    fn done(&self, success: bool) { self.emit("done", if success { "Java 安装完成" } else { "Java 安装失败" }, 0, 0, if success { 100 } else { 0 }); }
}

#[derive(PartialEq,Eq)]
struct DirectoryIdentity(u64,u64);
fn directory_identity(path:&Path)->Result<DirectoryIdentity> {
    let metadata=fs::symlink_metadata(path).map_err(|_|"无法确认 Java 目录身份")?;
    if !metadata.is_dir()||metadata.file_type().is_symlink(){return Err("Java 所有权目录不是普通目录".into());}
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        Ok(DirectoryIdentity(metadata.dev(),metadata.ino()))
    }
    #[cfg(windows)] {
        use std::os::windows::{fs::{MetadataExt,OpenOptionsExt},io::AsRawHandle};
        if metadata.file_attributes()&0x400!=0{return Err("Java 所有权目录不能是重解析点".into());}
        let file=OpenOptions::new().read(true).custom_flags(0x02000000|0x00200000).open(path).map_err(|_|"无法打开 Java 目录身份句柄")?;
        #[repr(C)] #[derive(Default)] struct Info {attributes:u32,created:[u32;2],accessed:[u32;2],written:[u32;2],volume:u32,size_high:u32,size_low:u32,links:u32,index_high:u32,index_low:u32}
        #[link(name="kernel32")] extern "system" {fn GetFileInformationByHandle(handle:*mut std::ffi::c_void,info:*mut Info)->i32;}
        let mut info=Info::default();
        if unsafe{GetFileInformationByHandle(file.as_raw_handle(),&mut info)}==0{return Err("无法读取 Java 目录身份".into());}
        Ok(DirectoryIdentity(info.volume as u64,((info.index_high as u64)<<32)|info.index_low as u64))
    }
    #[cfg(not(any(unix,windows)))] {Err("当前平台不能核验 Java 目录身份".into())}
}
/// 仅持有本次独占新建的目录；交给 Stage 或原子发布成功后立即解除清理责任。
struct Reservation {root:PathBuf,identity:DirectoryIdentity,marker:PathBuf,token:String,armed:bool}
impl Reservation {
    fn new(root:PathBuf)->Result<Self> {
        fs::create_dir(&root).map_err(|_|"Java 目录已被占用，拒绝覆盖")?;
        let identity=directory_identity(&root)?;
        let marker=root.join(".hcmcl-owner");let token=uuid::Uuid::new_v4().to_string();
        let guard=Self{root,identity,marker,token,armed:true};
        let mut file=OpenOptions::new().write(true).create_new(true).open(&guard.marker).map_err(|_|"无法写入 Java 目录所有权标记")?;
        file.write_all(guard.token.as_bytes()).map_err(|_|"无法写入 Java 目录所有权标记")?;
        file.sync_all().map_err(|_|"无法提交 Java 目录所有权标记")?;
        Ok(guard)
    }
    fn disarm(&mut self){self.armed=false;}
}
impl Drop for Reservation {
    fn drop(&mut self){
        if !self.armed||directory_identity(&self.root).ok().as_ref()!=Some(&self.identity){return;}
        // 构造阶段尚未发布任何 payload；仅删除本次标记及空目录，不递归删除他人条目。
        let _=fs::remove_file(&self.marker);let _=fs::remove_dir(&self.root);
    }
}

struct Stage {
    root: PathBuf,
    marker: PathBuf,
    token: String,
    archive: Option<PathBuf>,
    committed: bool,
}

impl Stage {
    fn new(root: &Path, major: u64) -> Result<Self> {
        let base = downloads::inside_path(root, ".hcmcl-java-staging")?;
        fs::create_dir_all(&base).map_err(|_| "无法创建 Java 安装 staging")?;
        let root = downloads::inside_path(&base, format!("java-{major}-{}", uuid::Uuid::new_v4()))?;
        let mut reservation=Reservation::new(root.clone())?;
        let stage=Self{root,marker:reservation.marker.clone(),token:reservation.token.clone(),archive:None,committed:false};
        reservation.disarm();Ok(stage)
    }
    fn verify_owner(&self) -> Result<()> {
        let bytes = bounded_read(&self.marker, 256)?;
        if bytes != self.token.as_bytes() { return Err("Java staging 所有权标记不匹配".into()); }
        Ok(())
    }
    fn payload(&self) -> Result<PathBuf> {
        self.verify_owner()?;
        let p = downloads::inside_path(&self.root, "payload")?;
        fs::create_dir(&p).map_err(|_| "无法创建 Java 解包目录")?;
        Ok(p)
    }
    fn archive(&mut self, name: &str) -> Result<PathBuf> {
        self.verify_owner()?;
        let path = downloads::inside_path(&self.root, name)?;
        self.archive = Some(path.clone());
        Ok(path)
    }
    fn finish(&mut self) -> Result<()> {
        self.verify_owner()?;
        if let Some(archive)=self.archive.as_ref() {
            match fs::remove_file(archive) { Ok(())=>{}, Err(error) if error.kind()==std::io::ErrorKind::NotFound=>{}, Err(_)=>return Err("Java 已安装，但暂存归档清理失败；保留所有权标记".into()) }
        }
        self.archive=None;
        // 先确认只剩所有权标记，清理失败不能先丢失后续 Drop 所需的授权。
        for entry in fs::read_dir(&self.root).map_err(|_|"Java 已安装，但暂存目录无法检查")? {
            if entry.map_err(|_|"Java 已安装，但暂存条目无法检查")?.path()!=self.marker {
                return Err("Java 已安装，但暂存目录仍有未清理条目；保留所有权标记".into());
            }
        }
        fs::remove_file(&self.marker).map_err(|_|"Java 已安装，但所有权标记清理失败")?;
        if fs::remove_dir(&self.root).is_err() {
            // 普通文件系统失败时恢复标记；同权限恶意替换不是这个私有 staging 的沙箱保证。
            if let Ok(mut marker)=OpenOptions::new().write(true).create_new(true).open(&self.marker) {
                let _=marker.write_all(self.token.as_bytes());let _=marker.sync_all();
            }
            return Err("Java staging 清理失败，已发布运行时仍保留".into());
        }
        self.committed=true;Ok(())
    }
}
impl Drop for Stage {
    fn drop(&mut self) {
        if !self.committed && self.verify_owner().is_ok() { let _ = fs::remove_dir_all(&self.root); }
    }
}

fn sha256_file(path: &Path, cancel: &downloads::Cancel) -> Result<(String, u64)> {
    let mut file = File::open(path).map_err(|_| "无法读取 Java 归档摘要")?;
    let mut hash = Sha256::new(); let mut size = 0u64; let mut buffer = [0u8; 65_536];
    loop { cancelled(cancel)?; let n = file.read(&mut buffer).map_err(|_| "读取 Java 归档失败")?; if n == 0 { break; } size = size.checked_add(n as u64).ok_or("Java 归档大小溢出")?; if size > ARCHIVE_LIMIT { return Err("Java 归档超过大小上限".into()); } hash.update(&buffer[..n]); }
    Ok((format!("{:x}", hash.finalize()), size))
}

fn cache_archive(root: &Path, major: u64, package: &Package, source: &Path, cancel: &downloads::Cancel) -> Result<()> {
    let target = safe_archive_path(root, major, &package.name)?;
    if let Ok(meta) = fs::metadata(&target) {
        if !meta.is_file() || meta.len() != package.size { return Err("Java 归档缓存已存在但大小不符，拒绝覆盖".into()); }
        let (hash, size) = sha256_file(&target, cancel)?;
        if hash != package.sha256 || size != package.size { return Err("Java 归档缓存已损坏，拒绝覆盖旧缓存".into()); }
        return Ok(());
    }
    let parent = target.parent().ok_or("Java 归档缓存没有父目录")?;
    fs::create_dir_all(parent).map_err(|_| "无法创建 Java 归档缓存目录")?;
    let mut out = match OpenOptions::new().write(true).create_new(true).open(&target) {
        Ok(file) => file,
        Err(_) => return Err("Java 归档缓存目标已被占用，拒绝覆盖".into()),
    };
    let result = (|| {
        let mut input = File::open(source).map_err(|_| "无法读取已校验 Java 归档")?;
        let mut buf = [0u8; 65_536];
        loop { cancelled(cancel)?; let n = input.read(&mut buf).map_err(|_| "读取 Java 归档缓存失败")?; if n == 0 { break; } out.write_all(&buf[..n]).map_err(|_| "写入 Java 归档缓存失败")?; }
        out.sync_all().map_err(|_| "提交 Java 归档缓存失败")?;
        Ok::<(), String>(())
    })();
    drop(out);
    if result.is_err() { let _ = fs::remove_file(&target); }
    result
}

fn rename_new(source: &Path, target: &Path) -> Result<()> {
    #[cfg(windows)] {
        use std::os::windows::ffi::OsStrExt;
        #[link(name="kernel32")] extern "system" { fn MoveFileExW(source:*const u16,target:*const u16,flags:u32)->i32; }
        let from=source.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
        let to=target.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
        // 不设置 MOVEFILE_REPLACE_EXISTING；std::fs::rename 会替换空目录，不能用作此边界。
        if unsafe {MoveFileExW(from.as_ptr(),to.as_ptr(),8)}==0 {return Err("Java 发布目标冲突或文件系统不支持，未覆盖目标".into());}
        Ok(())
    }
    #[cfg(any(target_os="linux",target_os="android"))] {
        use std::os::unix::ffi::OsStrExt;
        extern "C" { fn renameat2(oldfd:i32, old:*const std::os::raw::c_char, newfd:i32, new:*const std::os::raw::c_char, flags:u32)->i32; }
        let from=std::ffi::CString::new(source.as_os_str().as_bytes()).map_err(|_|"Java 发布路径无效")?;
        let to=std::ffi::CString::new(target.as_os_str().as_bytes()).map_err(|_|"Java 发布路径无效")?;
        if unsafe { renameat2(-100,from.as_ptr(),-100,to.as_ptr(),1) }!=0 { return Err("Java 发布目标冲突或文件系统不支持原子无覆盖发布".into()); }
        Ok(())
    }
    #[cfg(target_os="macos")] {
        use std::os::unix::ffi::OsStrExt;
        extern "C" { fn renamex_np(old:*const std::os::raw::c_char,new:*const std::os::raw::c_char,flags:u32)->i32; }
        let from=std::ffi::CString::new(source.as_os_str().as_bytes()).map_err(|_|"Java 发布路径无效")?;
        let to=std::ffi::CString::new(target.as_os_str().as_bytes()).map_err(|_|"Java 发布路径无效")?;
        if unsafe { renamex_np(from.as_ptr(),to.as_ptr(),4) }!=0 { return Err("Java 发布目标冲突或文件系统不支持原子无覆盖发布".into()); }
        Ok(())
    }
    #[cfg(not(any(windows,target_os="linux",target_os="android",target_os="macos")))] {
        let _=(source,target);Err("当前文件系统平台未提供原子无覆盖发布".into())
    }
}

fn publish(stage: &mut Stage, payload: &Path, root: &Path, major: u64, os: &str, arch: &str, digest: &str, java_rel: &Path) -> Result<(PathBuf, PathBuf)> {
    stage.verify_owner()?;
    if payload.parent() != Some(stage.root.as_path()) { return Err("Java staging 路径无效".into()); }
    let parent = downloads::inside_path(root, Path::new("java").join(major.to_string()))?;
    fs::create_dir_all(&parent).map_err(|_| "无法创建 Java 最终目录")?;
    let final_name = format!("temurin-{os}-{arch}-{digest}-{}", uuid::Uuid::new_v4());
    safe_component(&final_name)?;
    let final_root = downloads::inside_path(&parent, &final_name)?;
    let mut reservation=Reservation::new(final_root.clone())?;
    let marker=reservation.marker.clone();let token=reservation.token.clone();
    if payload.parent() != Some(stage.root.as_path()) { return Err("Java staging 路径在发布前改变".into()); }
    let runtime_root = downloads::inside_path(&final_root, "runtime")?;
    rename_new(payload, &runtime_root)?;
    reservation.disarm();
    // 从这一刻起运行时真实存在；后续失败保留它，并立即使旧 Java 扫描缓存失效。
    crate::runtime::invalidate_java_cache_for_backend();
    let finish = (|| {
        let marker_bytes = bounded_read(&marker, 256)?;
        if marker_bytes != token.as_bytes() { return Err("最终目录所有权标记不匹配".into()); }
        fs::remove_file(&marker).map_err(|_| "无法清理最终目录所有权标记")?;
        let detected = binary::find_java(&runtime_root, os, arch)?;
        let relative = detected.strip_prefix(&runtime_root).map_err(|_| "发布后路径不在运行时目录")?;
        if relative != java_rel { return Err("发布后路径与预检结果不一致".into()); }
        Ok((final_root, downloads::inside_path(&runtime_root, java_rel)?))
    })();
    finish.map_err(|error: String| format!("Java 已安装，但发布后复核失败：{error}"))
}

fn verify_package(path: &Path, package: &Package, cancel: &downloads::Cancel) -> Result<()> {
    let (actual, size) = sha256_file(path, cancel)?;
    if actual != package.sha256 || size != package.size { return Err("Java JRE 官方 SHA-256 或大小校验失败".into()); }
    Ok(())
}

struct ActiveInstall { id: String, cancel: Arc<downloads::Cancel> }
impl ActiveInstall {
    fn register(cancel: Arc<downloads::Cancel>) -> Result<Self> {
        let mut active=ACTIVE_CANCELS.get_or_init(||Mutex::new(WindowInstalls::default())).lock().map_err(|_|"Java 任务取消状态不可用")?;
        let id=uuid::Uuid::new_v4().to_string();active.insert(id.clone(),cancel.clone())?;Ok(Self{id,cancel})
    }
}
impl Drop for ActiveInstall {
    fn drop(&mut self) {
        if let Ok(mut active)=ACTIVE_CANCELS.get_or_init(||Mutex::new(WindowInstalls::default())).lock() {
            if active.active.get(&self.id).is_some_and(|cancel|Arc::ptr_eq(cancel,&self.cancel)){active.active.remove(&self.id);}
        }
    }
}

async fn install_worker(app: tauri::AppHandle, root: PathBuf, snapshot: Value, major: u64,
    cancel: Arc<downloads::Cancel>, progress: Arc<ProgressSink>) -> Result<String> {
    let (os,arch)=target_platform()?;
    let local=text(&snapshot,"mode")=="local";
    let package=if local {
        let r=root.clone();tokio::task::spawn_blocking(move||read_cached_package(&r,major,os,arch)).await.map_err(|_|"Java 缓存读取任务异常结束")??
    } else {
        let metadata=Client::new()?.metadata(metadata_url(major,os,arch)?,&cancel).await?;
        let package=package_from_metadata(&metadata,major,os,arch)?;
        let r=root.clone();let c=cancel.clone();
        tokio::task::spawn_blocking(move||downloads::write_bytes(&safe_metadata_path(&r,major)?,&metadata,&c)).await.map_err(|_|"Java 元数据保存任务异常结束")??;
        package
    };
    cancelled(&cancel)?;
    let r=root.clone();let name=package.name.clone();
    let (stage,archive)=tokio::task::spawn_blocking(move||{
        let mut stage=Stage::new(&r,major)?;let path=stage.archive(&name)?;Ok::<_,String>((stage,path))
    }).await.map_err(|_|"Java staging 创建任务异常结束")??;
    if local {
        let r=root.clone();let p=package.clone();let a=archive.clone();let c=cancel.clone();
        tokio::task::spawn_blocking(move||{
            cancelled(&c)?;let cached=safe_archive_path(&r,major,&p.name)?;verify_package(&cached,&p,&c)?;
            fs::copy(&cached,&a).map_err(|_|"无法复制本地 Java 归档缓存")?;cancelled(&c)
        }).await.map_err(|_|"Java 缓存复制任务异常结束")??;
    } else {
        progress.emit("java","下载 Java JRE",0,package.size,2);
        Client::new()?.package(&package,&archive,&cancel,&progress).await?;
    }
    // 唯一 blocking owner 持有 Stage，直到校验、解包、探测、发布、存储及清理全部真实收尾。
    tokio::task::spawn_blocking(move||{
        let mut stage=stage;
        verify_package(&archive,&package,&cancel)?;
        if !local { cache_archive(&root,major,&package,&archive,&cancel)?; }
        cancelled(&cancel)?;
        let payload=stage.payload()?;
        progress.emit("java","安全解压 Java JRE",package.size,package.size,88);
        archive::extract(&archive,&payload,&cancel)?;
        cancelled(&cancel)?;
        let java=binary::find_java(&payload,os,arch)?;
        let java_rel=java.strip_prefix(&payload).map_err(|_|"Java 预检路径越界")?.to_owned();
        let probe=crate::runtime::inspect_picked_java(&java).ok_or("Java JRE -version 探测失败")?;
        if probe.get("major").and_then(Value::as_u64)!=Some(major) { return Err("Java JRE 探测主版本与请求不一致".into()); }
        cancelled(&cancel)?;
        let (_,final_java)=publish(&mut stage,&payload,&root,major,os,arch,&package.sha256,&java_rel)?;
        let final_probe=crate::runtime::inspect_picked_java(&final_java).ok_or("Java 已安装，但发布后探测失败")?;
        if final_probe.get("major").and_then(Value::as_u64)!=Some(major) { return Err("Java 已安装，但发布后主版本复核失败".into()); }
        if cancel.check().is_err() { return Err("Java 已安装，但收到取消信号，未改变全局 Java 选择".into()); }
        app.state::<crate::storage::Storage>().select_installed_java_for_backend(&snapshot,&final_java)
            .map_err(|error|format!("Java 已安装，但设置未保存：{error}"))?;
        stage.finish()?;
        final_java.to_str().map(str::to_owned).ok_or_else(||"Java 已安装，但路径不是 Unicode".into())
    }).await.map_err(|_|"Java 安装文件任务异常结束；已发布运行时可能仍存在".to_owned())?
}

/// 文件工作不接受 select/abort；此层持锁和任务登记直到 work 实际返回。
async fn retain_registered_work<T>(root:PathBuf,registration:downloads::JobGuard,active:ActiveInstall,
    work:impl std::future::Future<Output=Result<T>>)->Result<T> {
    let cancel=registration.cancel();
    let result=async {
        let _root_guard=install_lock::acquire(&root,||cancel.check().is_err()).await?;
        work.await
    }.await;
    registration.complete(result.as_ref().map(|_|()).map_err(Clone::clone));
    drop(active);drop(registration);
    result
}

/// caller 丢弃时仅取消；独立 worker 继续拥有根锁、登记和真实 blocking 工作。
async fn owned_install(app: tauri::AppHandle,root: PathBuf,snapshot: Value,major: u64,
    registration: downloads::JobGuard,active: ActiveInstall)->Result<String> {
    let cancel=registration.cancel();let progress=Arc::new(ProgressSink::new(app.clone(),format!("java-{major}")));
    let p=progress.clone();let r=root.clone();
    let work=async move {
        p.emit("java","准备 Java 安装",0,0,1);
        install_worker(app,r,snapshot,major,cancel,p).await
    };
    let result=retain_registered_work(root,registration,active,work).await;
    progress.done(result.is_ok());
    result
}

pub async fn call(app:&tauri::AppHandle,channel:&str,args:&[Value],settings:&Value,game_dir:&Path)->Result<Option<Value>> {
    if channel!="java:install" { return Ok(None); }
    desktop_only()?;target_platform()?;
    if args.len()!=1 { return Err("java:install 需要一个 Java 主版本整数参数".into()); }
    let major=valid_major(&args[0])?;let root=downloads::operation_root(game_dir)?;
    let registration=downloads::JobGuard::register(&root,&format!("java-{major}"))?;
    let cancel=registration.cancel();let active=ActiveInstall::register(cancel.clone())?;
    let _cancel_on_drop=CancelOnDrop(cancel);
    let app=app.clone();let snapshot=settings.clone();
    let worker=tokio::spawn(owned_install(app,root,snapshot,major,registration,active));
    worker.await.map_err(|_|"Java 安装后台任务异常结束")?.map(|path|Some(Value::String(path)))
}
struct CancelOnDrop(Arc<downloads::Cancel>);
impl Drop for CancelOnDrop{fn drop(&mut self){self.0.stop();}}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relaunch_gate_rejects_active_cancelled_closed_busy_and_poisoned_installs() {
        let installs=Mutex::new(WindowInstalls::default());
        assert!(installs_relaunch_ready(&installs).is_ok());
        let cancel=Arc::new(downloads::Cancel::default());
        installs.lock().unwrap().insert("fixture".into(),cancel.clone()).unwrap();
        assert!(installs_relaunch_ready(&installs).is_err());assert!(cancel.check().is_ok());cancel.stop();
        assert!(installs_relaunch_ready(&installs).is_err());
        assert!(installs.lock().unwrap().active.contains_key("fixture"));
        installs.lock().unwrap().active.remove("fixture");
        assert!(installs_relaunch_ready(&installs).is_ok());
        {let _held=installs.lock().unwrap();assert!(installs_relaunch_ready(&installs).is_err());}
        installs.lock().unwrap().close();assert!(installs_relaunch_ready(&installs).is_err());
        let poisoned=Mutex::new(WindowInstalls::default());
        let _=std::panic::catch_unwind(||{let _held=poisoned.lock().unwrap();panic!("纯状态夹具：Java 安装锁中毒");});
        assert!(installs_relaunch_ready(&poisoned).is_err());
    }
    #[test]
    fn major_is_one_integer_and_rejects_strings() {
        assert_eq!(valid_major(&json!(21)).unwrap(), 21);
        assert!(valid_major(&json!("21")).is_err());
        assert!(valid_major(&json!(21.5)).is_err());
        assert!(valid_major(&json!(7)).is_err());
        assert!(valid_major(&json!(100)).is_err());
    }
    #[test]
    fn official_package_path_is_strict() {
        let u = "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.1%2B12/OpenJDK21U-jre_x64_linux_hotspot_21.0.1_12.tar.gz";
        assert!(package_url(u, 21, false).is_ok());
        assert!(package_url("https://example.invalid/adoptium/temurin21-binaries/releases/download/x/a.zip", 21, false).is_err());
        assert!(package_url("https://github.com/evil/temurin21-binaries/releases/download/x/a.zip", 21, false).is_err());
    }
    struct TempRoot(PathBuf);
    impl TempRoot {
        fn new()->Self {
            let root=fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("hcmcl-java-install-{}",uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();Self(root)
        }
    }
    impl Drop for TempRoot {fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}
    fn metadata()->Value {
        json!([{"vendor":"eclipse","version":{"major":17},"binary":{
            "os":"windows","architecture":"x64","image_type":"jre","jvm_impl":"hotspot","project":"jdk",
            "package":{"name":"OpenJDK17U-jre_x64_windows_hotspot_17.0.21_9.zip","size":7,"checksum":"a".repeat(64),
                "link":"https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.21%2B9/OpenJDK17U-jre_x64_windows_hotspot_17.0.21_9.zip"}}}])
    }
    #[test]
    fn official_metadata_matches_top_level_vendor_major_jre_os_arch_and_filename() {
        let value=metadata();let bytes=serde_json::to_vec(&value).unwrap();
        let package=package_from_metadata(&bytes,17,"windows","x64").unwrap();
        assert_eq!((package.major,package.os.as_str(),package.arch.as_str()),(17,"windows","x64"));
        for pointer in ["/0/vendor","/0/version/major","/0/binary/os","/0/binary/architecture","/0/binary/image_type","/0/binary/jvm_impl","/0/binary/package/name"] {
            let mut bad=value.clone();*bad.pointer_mut(pointer).unwrap()=json!("wrong");
            assert!(package_from_metadata(&serde_json::to_vec(&bad).unwrap(),17,"windows","x64").is_err(),"{pointer}");
        }
        let mut mixed=metadata().as_array().unwrap().clone();
        let mut wrong=mixed[0].clone();wrong["binary"]["architecture"]=json!("aarch64");mixed.insert(0,wrong);
        assert_eq!(package_from_metadata(&serde_json::to_vec(&mixed).unwrap(),17,"windows","x64").unwrap().arch,"x64");
        assert!(package_from_metadata(&bytes,21,"windows","x64").is_err());
        assert!(package_url("https://github.com/adoptium/temurin17-binaries/releases/download/x/a.zip",21,false).is_err());
        for url in ["http://github.com/a.zip","https://user:secret@github.com/a.zip","https://github.com:444/a.zip","https://evil.invalid/a.zip","https://release-assets.githubusercontent.com/a.zip#fragment"] {
            assert!(package_url(url,17,true).is_err());
        }
    }
    #[test]
    fn local_cache_checks_real_sha_and_size_and_never_overwrites_conflict() {
        let root=TempRoot::new();let source=root.0.join("source.zip");fs::write(&source,b"fixture").unwrap();
        let mut value=metadata();value[0]["binary"]["package"]["checksum"]=json!(format!("{:x}",Sha256::digest(b"fixture")));
        let bytes=serde_json::to_vec(&value).unwrap();let package=package_from_metadata(&bytes,17,"windows","x64").unwrap();
        let path=safe_metadata_path(&root.0,17).unwrap();fs::create_dir_all(path.parent().unwrap()).unwrap();fs::write(path,&bytes).unwrap();
        assert!(read_cached_package(&root.0,17,"windows","x64").is_err());
        let cancel=downloads::Cancel::default();cache_archive(&root.0,17,&package,&source,&cancel).unwrap();
        let cached=safe_archive_path(&root.0,17,&package.name).unwrap();verify_package(&cached,&package,&cancel).unwrap();
        assert_eq!(read_cached_package(&root.0,17,"windows","x64").unwrap().sha256,package.sha256);
        fs::write(&cached,b"damaged").unwrap();assert!(cache_archive(&root.0,17,&package,&source,&cancel).is_err());
        assert_eq!(fs::read(&cached).unwrap(),b"damaged");assert!(verify_package(&cached,&package,&cancel).is_err());
        cancel.stop();assert!(verify_package(&source,&package,&cancel).is_err());
    }
    #[test]
    fn stage_cleans_owned_paths_but_never_removes_replaced_owner() {
        let root=TempRoot::new();let owned;
        {let mut stage=Stage::new(&root.0,17).unwrap();owned=stage.root.clone();let path=stage.archive("archive.zip").unwrap();fs::write(path,b"data").unwrap();stage.payload().unwrap();}
        assert!(!owned.exists());
        let replaced;
        {let stage=Stage::new(&root.0,17).unwrap();replaced=stage.root.clone();fs::write(&stage.marker,b"different owner").unwrap();}
        assert!(replaced.is_dir());
    }
    #[test]
    fn staging_cleanup_failure_keeps_marker_and_reservation_releases_only_owned_empty_directory() {
        let root=TempRoot::new();let stage_root;
        {
            let mut stage=Stage::new(&root.0,17).unwrap();stage_root=stage.root.clone();
            let archive=stage.archive("blocked.zip").unwrap();fs::create_dir(&archive).unwrap();
            assert!(stage.finish().is_err());assert!(stage.verify_owner().is_ok());
        }
        assert!(!stage_root.exists());
        let reserved=root.0.join("reserved");{let _guard=Reservation::new(reserved.clone()).unwrap();}assert!(!reserved.exists());
        let occupied=root.0.join("occupied-reservation");fs::create_dir(&occupied).unwrap();fs::write(occupied.join("keep"),b"existing").unwrap();
        assert!(Reservation::new(occupied.clone()).is_err());assert_eq!(fs::read(occupied.join("keep")).unwrap(),b"existing");
    }
    #[test]
    fn closing_window_cancels_existing_work_and_rejects_late_registration_after_snapshot_pause() {
        let state=Arc::new(Mutex::new(WindowInstalls::default()));
        let existing=Arc::new(downloads::Cancel::default());state.lock().unwrap().insert("existing".into(),existing.clone()).unwrap();
        let (paused_tx,paused_rx)=std::sync::mpsc::channel();let (resume_tx,resume_rx)=std::sync::mpsc::channel();
        let late_state=state.clone();let late=std::thread::spawn(move||{
            paused_tx.send(()).unwrap();resume_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            late_state.lock().unwrap().insert("late".into(),Arc::new(downloads::Cancel::default()))
        });
        paused_rx.recv_timeout(Duration::from_secs(5)).unwrap();state.lock().unwrap().close();
        assert!(existing.check().is_err());resume_tx.send(()).unwrap();assert!(late.join().unwrap().is_err());
        let state=state.lock().unwrap();assert!(state.closed);assert!(!state.active.contains_key("late"));
    }
    #[test]
    fn native_publish_refuses_existing_empty_directory_and_retains_published_bytes_on_late_error() {
        let root=TempRoot::new();let source=root.0.join("from");let target=root.0.join("occupied");
        fs::create_dir(&source).unwrap();fs::write(source.join("owned"),b"source").unwrap();fs::create_dir(&target).unwrap();
        assert!(rename_new(&source,&target).is_err());assert!(source.join("owned").exists());assert_eq!(fs::read_dir(&target).unwrap().count(),0);
        let new=root.0.join("new");rename_new(&source,&new).unwrap();assert!(!source.exists());assert_eq!(fs::read(new.join("owned")).unwrap(),b"source");
        let mut stage=Stage::new(&root.0,17).unwrap();let payload=stage.payload().unwrap();fs::write(payload.join("invalid-header"),b"not a JVM").unwrap();
        let error=publish(&mut stage,&payload,&root.0,17,"windows","x64",&"a".repeat(64),Path::new("bin/java.exe")).unwrap_err();
        assert!(error.contains("Java 已安装"));drop(stage);
        let parent=root.0.join("java/17");let published=fs::read_dir(parent).unwrap().next().unwrap().unwrap().path();
        assert_eq!(fs::read(published.join("runtime/invalid-header")).unwrap(),b"not a JVM");
    }
    #[tokio::test(flavor="multi_thread",worker_threads=2)]
    async fn dropped_caller_cancels_but_owned_work_keeps_job_and_root_until_blocking_exit() {
        let root=TempRoot::new();let id="java-retention-fixture";
        let registration=downloads::JobGuard::register(&root.0,id).unwrap();let cancel=registration.cancel();let active=ActiveInstall::register(cancel.clone()).unwrap();
        let (started_tx,started_rx)=tokio::sync::oneshot::channel();let (release_tx,release_rx)=std::sync::mpsc::channel();let (done_tx,done_rx)=tokio::sync::oneshot::channel();
        struct Release(Option<std::sync::mpsc::Sender<()>>);impl Drop for Release {fn drop(&mut self){if let Some(sender)=self.0.take(){let _=sender.send(());}}}
        let release=Release(Some(release_tx));let r=root.0.clone();let c=cancel.clone();
        let work=async move {
            tokio::task::spawn_blocking(move||{let _=started_tx.send(());release_rx.recv_timeout(Duration::from_secs(10)).map_err(|_|"夹具屏障超时")?;Ok::<_,String>(())}).await.map_err(|_|"夹具线程失败")??;
            c.check()
        };
        let worker=tokio::spawn(async move {let result=retain_registered_work(r,registration,active,work).await;let _=done_tx.send(result);});
        let c=cancel.clone();let caller=tokio::spawn(async move {let _guard=CancelOnDrop(c);worker.await.unwrap();});
        tokio::time::timeout(Duration::from_secs(5),started_rx).await.unwrap().unwrap();caller.abort();let _=caller.await;
        tokio::time::timeout(Duration::from_secs(2),cancel.cancelled()).await.unwrap();
        assert!(downloads::JobGuard::register(&root.0,id).is_err());
        assert!(tokio::time::timeout(Duration::from_millis(120),install_lock::acquire(&root.0,||false)).await.is_err());
        drop(release);assert!(tokio::time::timeout(Duration::from_secs(5),done_rx).await.unwrap().unwrap().is_err());
        let new=downloads::JobGuard::register(&root.0,id).unwrap();drop(new);
        let guard=tokio::time::timeout(Duration::from_secs(2),install_lock::acquire(&root.0,||false)).await.unwrap().unwrap();drop(guard);
    }
    #[tokio::test]
    async fn metadata_stream_is_bounded_without_content_length_and_observes_cancel() {
        use std::net::TcpListener;
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();let address=listener.local_addr().unwrap();
        let server=std::thread::spawn(move||{let (mut socket,_)=listener.accept().unwrap();socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();let mut request=Vec::new();let mut byte=[0];
            while !request.ends_with(b"\r\n\r\n")&&request.len()<8192 {if socket.read(&mut byte).unwrap_or(0)==0{break;}request.push(byte[0]);}
            let _=socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\n1234\r\n4\r\n5678\r\n0\r\n\r\n");});
        let response=reqwest::Client::new().get(format!("http://{address}")).send().await.unwrap();
        assert!(read_metadata_response(response,6,&downloads::Cancel::default()).await.unwrap_err().contains("大小上限"));server.join().unwrap();
        let cancel=downloads::Cancel::default();cancel.stop();assert!(cancelled(&cancel).is_err());
    }
}

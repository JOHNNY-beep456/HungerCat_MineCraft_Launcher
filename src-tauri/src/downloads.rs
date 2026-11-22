//! 原版安装器。只接管 download:install/cancel 与 versions:createVanilla；加载器另行迁移。
//! 下载可在 Android 私有目录工作；绝不在此启动 Java，也不声称已接入 Android 游戏栈。
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use sha2::Sha256;
use std::{collections::{BTreeMap, BTreeSet, HashMap}, fs::{self, File, OpenOptions}, io::{Read, Write}, path::{Component, Path, PathBuf}, sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc, Mutex, OnceLock}, time::{Duration, Instant}};
use tauri::Emitter;
use tokio::{io::AsyncWriteExt, sync::Notify, task::JoinSet};
use crate::install_lock;
#[path = "version_metadata.rs"]
mod version_metadata;

pub(crate) type Result<T> = std::result::Result<T, String>;
const JSON_LIMIT: u64 = 32 * 1024 * 1024;
const FILE_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
const MIRROR: &str = "https://bmclapi2.bangbang93.com";
/// 版本依赖下载的可信主机。
///
/// Mojang 的 CDN 子域会随版本调整（例如新的 libraries / piston 变体），逐个枚举具体主机
/// 会让新版本直接装不上。这里按**官方域后缀**放行，仍严格限定在 Mojang 自有域内：
/// 要求前导点，`evilmojang.com` 这类仿冒域不会命中。第三方 maven 仓库与镜像域单独精确约束。
/// BMCLAPI 的分发节点。镜像清单会把下载地址改写成为用户就近分配的节点
/// （实测 `bmclapi17.sakura.sld.tw`），这些节点与主站同样提供 `/maven`、`/assets`、
/// `/objects` 路径，用它们能拿到更快的速度。只认「bmclapi 前缀 + 已知赞助域」的组合，
/// 避免放行任意第三方子域。
fn mirror_node_host(host: &str) -> bool {
    host.starts_with("bmclapi") && (host.ends_with(".bangbang93.com") || host.ends_with(".sakura.sld.tw"))
}
/// 把镜像节点地址映射回官方等价地址，供下载失败或策略要求官方源时回退。
fn official_equivalent(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    if !mirror_node_host(parsed.host_str()?) { return None; }
    let path = parsed.path();
    if let Some(rest) = path.strip_prefix("/maven/") { return Some(format!("https://libraries.minecraft.net/{rest}")); }
    if let Some(rest) = path.strip_prefix("/v1/packages/") { return Some(format!("https://piston-meta.mojang.com/v1/packages/{rest}")); }
    if let Some(rest) = path.strip_prefix("/v1/objects/") { return Some(format!("https://piston-data.mojang.com/v1/objects/{rest}")); }
    if let Some(hash) = path.strip_prefix("/assets/") {
        if checksum(hash, 40).is_ok() { return Some(format!("https://resources.download.minecraft.net/{}/{}", &hash[..2], hash)); }
    }
    if let Some(hash) = path.strip_prefix("/objects/") {
        if checksum(hash, 40).is_ok() { return Some(format!("https://piston-data.mojang.com/v1/objects/{hash}")); }
    }
    None
}
fn allowed_download_host(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 || !host.is_ascii() { return false; }
    let official = host.ends_with(".mojang.com") || host.ends_with(".minecraft.net");
    let mirror = host == "bangbang93.com" || mirror_node_host(host);
    let repository = matches!(host,
        "maven.fabricmc.net" | "maven.quiltmc.org" | "meta.fabricmc.net" | "meta.quiltmc.org"
        | "maven.minecraftforge.net" | "maven.neoforged.net"
        | "repo.maven.apache.org" | "repo1.maven.org");
    official || mirror || repository
}
fn text<'a>(v: &'a Value, key: &str) -> &'a str { v.get(key).and_then(Value::as_str).unwrap_or("") }
fn local(settings: &Value) -> bool { text(settings, "mode") == "local" }
pub(crate) fn identifier(s: &str) -> Result<&str> {
    if s.is_empty() || s.len() > 240 || matches!(s,"."|"..") || s.ends_with('.') || s.ends_with(' ') || s.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c)) { return Err("实例标识或文件名包含不安全字符".into()); }
    let stem=s.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(stem.as_str(),"CON"|"PRN"|"AUX"|"NUL") || (stem.len()==4 && (stem.starts_with("COM")||stem.starts_with("LPT")) && matches!(stem.as_bytes()[3],b'1'..=b'9')) { return Err("拒绝系统保留名称".into()); } Ok(s)
}
fn no_link(path: &Path) -> Result<()> { match fs::symlink_metadata(path) { Ok(m) => { if m.file_type().is_symlink() { return Err("拒绝符号链接路径".into()); } #[cfg(windows)] { use std::os::windows::fs::MetadataExt; if m.file_attributes() & 0x400 != 0 { return Err("拒绝重解析点路径".into()); } } Ok(()) }, Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(()), Err(_)=>Err("无法验证文件路径".into()) } }
fn absolute(path: &Path) -> Result<PathBuf> { if !path.is_absolute() || path.as_os_str().is_empty() { return Err("游戏目录必须为绝对路径".into()); } let mut out=PathBuf::new(); for c in path.components() { match c { Component::Prefix(prefix)=>{out.push(prefix.as_os_str());continue;}, Component::RootDir=>{out.push(c.as_os_str());no_link(&out)?;continue;}, Component::ParentDir|Component::CurDir=>return Err("目录不能含相对跳转".into()), _=>out.push(c.as_os_str()) } no_link(&out)?; } Ok(out) }
fn inside(root:&Path,relative:impl AsRef<Path>)->Result<PathBuf> { let mut out=absolute(root)?; let rel=relative.as_ref(); if rel.as_os_str().is_empty(){return Err("文件路径为空".into());} for c in rel.components(){if let Component::Normal(n)=c { let s=n.to_str().ok_or("文件路径不是 UTF-8")?; identifier(s)?;out.push(n);no_link(&out)?;}else{return Err("文件路径越界".into());}}Ok(out) }
fn mkdir(path:&Path)->Result<()> {absolute(path)?;fs::create_dir_all(path).map_err(|_|"无法创建安装目录")?;absolute(path)?;Ok(())}
fn read_bounded(path:&Path,limit:u64)->Result<Vec<u8>>{absolute(path)?;let m=fs::metadata(path).map_err(|_|"本地文件不存在")?;if !m.is_file()||m.len()>limit{return Err("本地文件不是普通文件或超过大小上限".into());}let mut out=Vec::new();File::open(path).map_err(|_|"无法读取本地文件")?.take(limit+1).read_to_end(&mut out).map_err(|_|"读取本地文件失败")?;if out.len()as u64>limit{return Err("本地文件超过大小上限".into());}Ok(out)}
pub(crate) fn read_value(path:&Path)->Result<Value>{serde_json::from_slice(&read_bounded(path,JSON_LIMIT)?).map_err(|_|"JSON 格式无效".into())}
pub(crate) fn read_json(path:&Path)->Result<Value>{let v=read_value(path)?;if !v.is_object(){return Err("JSON 必须为对象".into());}Ok(v)}
pub(crate) fn version_path(root:&Path,id:&str)->Result<PathBuf>{inside(root,Path::new("versions").join(identifier(id)?).join(format!("{id}.json")))}
#[derive(Clone, Default)] pub(crate) struct Cancel { stopped: Arc<AtomicBool>, notify: Arc<Notify> }
impl Cancel { pub(crate) fn check(&self)->Result<()> {if self.stopped.load(Ordering::Acquire){Err("下载已取消".into())}else{Ok(())}} pub(crate) fn stop(&self){self.stopped.store(true,Ordering::Release);self.notify.notify_waiters();} pub(crate) async fn cancelled(&self){loop{if self.stopped.load(Ordering::Acquire){return;}tokio::select!{_ = self.notify.notified()=>{},_ = tokio::time::sleep(Duration::from_millis(50))=>{}}}} }
struct TempPath {path:PathBuf, committed:bool}
impl Drop for TempPath{fn drop(&mut self){if !self.committed{let _=fs::remove_file(&self.path);}}}
fn atomic_bytes(path:&Path,bytes:&[u8],cancel:&Cancel)->Result<()> {cancel.check()?;absolute(path)?;let parent=path.parent().ok_or("文件没有父目录")?;mkdir(parent)?;let mut temp=TempPath{path:inside(parent,format!(".hcmcl-write-{}.part",uuid::Uuid::new_v4()))?,committed:false};let mut file=OpenOptions::new().write(true).create_new(true).open(&temp.path).map_err(|_|"无法创建临时文件")?;file.write_all(bytes).map_err(|_|"写入临时文件失败")?;file.sync_all().map_err(|_|"提交临时文件失败")?;drop(file);cancel.check()?;absolute(path)?;replace_file(&temp.path,path)?;temp.committed=true;Ok(())}
fn atomic_json(path:&Path,value:&Value,cancel:&Cancel)->Result<()>{let bytes=serde_json::to_vec_pretty(value).map_err(|_|"JSON 序列化失败")?;atomic_bytes(path,&bytes,cancel)}
fn hex_sha1(bytes:&[u8])->String{format!("{:x}",Sha1::digest(bytes))}
pub(crate) fn checksum(s:&str,n:usize)->Result<String>{if s.len()!=n||!s.bytes().all(|b|b.is_ascii_hexdigit()){return Err("下载校验值格式无效".into());}Ok(s.to_ascii_lowercase())}
fn file_hashes(path:&Path,cancel:&Cancel)->Result<(String,String,u64)>{absolute(path)?;let mut f=File::open(path).map_err(|_|"无法校验本地文件")?;let mut a=Sha1::new();let mut b=Sha256::new();let mut size=0;let mut buf=[0u8;65536];loop{cancel.check()?;let n=f.read(&mut buf).map_err(|_|"读取校验文件失败")?;if n==0{break;}size+=n as u64;if size>FILE_LIMIT{return Err("下载文件超过安全上限".into());}a.update(&buf[..n]);b.update(&buf[..n]);}Ok((format!("{:x}",a.finalize()),format!("{:x}",b.finalize()),size))}
#[derive(Clone,Debug)] struct FileTask{urls:Vec<String>,path:PathBuf,sha1:Option<String>,sha256:Option<String>,size:Option<u64>,label:String,phase:&'static str,sidecar:bool,local_only:bool}
impl FileTask{fn info(urls:Vec<String>,path:PathBuf,info:&Value,label:String,phase:&'static str)->Result<Self>{let digest=|key,n|->Result<Option<String>>{match info.get(key){None|Some(Value::Null)=>Ok(None),Some(Value::String(s))=>Ok(Some(checksum(s,n)?)),_=>Err("下载校验值必须为字符串".into())}};let size=match info.get("size"){None|Some(Value::Null)=>None,Some(v)=>Some(v.as_u64().filter(|n|*n<=FILE_LIMIT).ok_or("下载大小元数据无效")?)};Ok(Self{urls,path,sha1:digest("sha1",40)?,sha256:digest("sha256",64)?,size,label,phase,sidecar:false,local_only:false})}}
fn satisfied(task:&FileTask,cancel:&Cancel)->Result<bool>{cancel.check()?;absolute(&task.path)?;let m=match fs::metadata(&task.path){Ok(m)=>m,Err(e)if e.kind()==std::io::ErrorKind::NotFound=>return Ok(false),Err(_)=>return Err("无法读取下载目标属性".into())};if !m.is_file()||m.len()>FILE_LIMIT||task.size.is_some_and(|n|n!=m.len()){return Ok(false);}if task.sha1.is_some()||task.sha256.is_some(){let(a,b,_)=file_hashes(&task.path,cancel)?;if task.sha1.as_ref().is_some_and(|h|*h!=a)||task.sha256.as_ref().is_some_and(|h|*h!=b){return Ok(false);}}else if task.size.is_none()&&m.len()==0{return Ok(false);}Ok(true)}
/// 异步侧的 satisfied：带摘要校验时是同步全文件读取，必须移出 tokio worker。
/// 否则数十个并发下载里夹着数百 MB 的哈希计算，会把网络任务挤在同一批工作线程上。
/// 没有摘要（只比尺寸/存在性）时仍就地判定，避免为纯 stat 付调度开销。
async fn satisfied_in_context(task:&FileTask,cancel:&Cancel)->Result<bool>{
    if task.sha1.is_none()&&task.sha256.is_none(){return satisfied(task,cancel);}
    let task=task.clone();let cancel=cancel.clone();
    tokio::task::spawn_blocking(move||satisfied(&task,&cancel)).await.map_err(|_|"下载校验任务异常结束".to_string())?
}
#[derive(Clone)] struct Network{client:reqwest::Client,#[cfg(test)] loopback:bool}
impl Network{fn production()->Result<Self>{Ok(Self{client:reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(180)).pool_max_idle_per_host(64).no_gzip().no_brotli().no_deflate().user_agent("HCMCL-Tauri/0.8.0").build().map_err(|_|"无法初始化下载网络")?,#[cfg(test)]loopback:false})} fn url(&self,raw:&str)->Result<reqwest::Url>{let u=reqwest::Url::parse(raw).map_err(|_|"下载地址无效")?;if raw.len()>32768||raw.chars().any(char::is_control)||!u.username().is_empty()||u.password().is_some()||u.fragment().is_some(){return Err("下载地址包含不安全字段".into());}#[cfg(test)]if self.loopback&&u.scheme()=="http"&&u.host_str().and_then(|h|h.parse::<std::net::IpAddr>().ok()).is_some_and(|ip|ip.is_loopback()){return Ok(u);}if u.scheme()!="https"||u.port().is_some_and(|p|p!=443){return Err("正式下载只允许标准 HTTPS".into());}let host=u.host_str().ok_or("下载地址缺少主机")?;if !allowed_download_host(host){return Err(format!("下载地址不在版本依赖白名单（{host}）"));}Ok(u)}
async fn request(&self,raw:&str,range:Option<(u64,Option<&str>)>,cancel:&Cancel)->std::result::Result<reqwest::Response,TransferError>{self.request_checked(raw,range.map(|(offset,validator)|(offset,None,validator)),cancel,|raw|self.url(raw)).await}
async fn request_end(&self,raw:&str,start:u64,end:u64,cancel:&Cancel)->std::result::Result<reqwest::Response,TransferError>{if end<start{return Err(TransferError::fatal("分段范围无效"));}self.request_checked(raw,Some((start,Some(end),None)),cancel,|raw|self.url(raw)).await}
async fn request_checked(&self,raw:&str,range:Option<(u64,Option<u64>,Option<&str>)>,cancel:&Cancel,validate:impl Fn(&str)->Result<reqwest::Url>)->std::result::Result<reqwest::Response,TransferError>{let mut url=validate(raw).map_err(TransferError::fatal)?;for hop in 0..=5{cancel.check().map_err(TransferError::fatal)?;let mut req=self.client.get(url.clone());if let Some((offset,end,validator))=range{req=req.header(reqwest::header::RANGE,if let Some(end)=end{format!("bytes={offset}-{end}")}else{format!("bytes={offset}-")});if let Some(v)=validator{req=req.header(reqwest::header::IF_RANGE,v);}}let response=tokio::select!{_ = cancel.cancelled()=>return Err(TransferError::fatal("下载已取消")),r=req.send()=>r.map_err(|e|TransferError{status:None,retry:None,slow:e.is_timeout(),message:"下载网络连接失败".into(),fatal:false})?};if !response.status().is_redirection(){return Ok(response);}if hop==5{return Err(TransferError::fatal("下载重定向次数过多"));}let next=response.headers().get(reqwest::header::LOCATION).and_then(|s|s.to_str().ok()).ok_or_else(||TransferError::fatal("下载重定向缺少地址"))?;if next.chars().any(char::is_control){return Err(TransferError::fatal("下载重定向地址无效"));}let resolved=url.join(next).map_err(|_|TransferError::fatal("下载重定向地址无效"))?;url=validate(resolved.as_str()).map_err(TransferError::fatal)?;}Err(TransferError::fatal("下载重定向失败"))}
}
#[derive(Debug)]struct TransferError{status:Option<u16>,retry:Option<Duration>,slow:bool,message:String,fatal:bool}
impl TransferError{fn fatal(s:impl Into<String>)->Self{Self{status:None,retry:None,slow:false,message:s.into(),fatal:true}} fn status(response:&reqwest::Response)->Self{let code=response.status().as_u16();let retry=response.headers().get(reqwest::header::RETRY_AFTER).and_then(|v|v.to_str().ok()).and_then(|s|s.parse::<u64>().ok()).map(|n|Duration::from_secs(n.min(30)));Self{status:Some(code),retry,slow:code==408,message:format!("下载 HTTP {code}"),fatal:matches!(code,400|401|403)}} fn delay(&self,attempt:u32)->Duration{self.retry.unwrap_or_else(||Duration::from_millis(((if self.status==Some(429){3000}else{500})*(1u64<<attempt.min(5))).min(20000)))}}
async fn sleep_cancel(delay:Duration,cancel:&Cancel)->Result<()>{tokio::select!{_ = cancel.cancelled()=>Err("下载已取消".into()),_ = tokio::time::sleep(delay)=>cancel.check()}}
#[derive(Clone)] pub(crate) struct Progress {sink:Arc<dyn Fn(Value)+Send+Sync>,task_id:String,title:String,data:Arc<Mutex<ProgressData>>}
struct ProgressData{bytes:BTreeMap<String,u64>,sizes:BTreeMap<String,u64>,done:BTreeSet<String>,total:usize,last:Instant,sample:Instant,sample_bytes:u64,finished:bool,sum_bytes:u64,sum_sizes:u64}
impl Progress{pub(crate) fn new(task_id:String,title:String,sink:Arc<dyn Fn(Value)+Send+Sync>)->Self{let now=Instant::now();Self{sink,task_id,title,data:Arc::new(Mutex::new(ProgressData{bytes:BTreeMap::new(),sizes:BTreeMap::new(),done:BTreeSet::new(),total:0,last:now-Duration::from_secs(1),sample:now,sample_bytes:0,finished:false,sum_bytes:0,sum_sizes:0}))}}fn register(&self,tasks:&[FileTask]){if let Ok(mut d)=self.data.lock(){for t in tasks{let k=path_key(&t.path);d.bytes.entry(k.clone()).or_default();if let Some(s)=t.size{let previous=d.sizes.insert(k,s).unwrap_or(0);d.sum_sizes=d.sum_sizes-previous+s;}}d.total=d.bytes.len();}}fn update(&self,task:&FileTask,bytes:u64,size:Option<u64>,done:bool){let payload={let Ok(mut d)=self.data.lock()else{return};if d.finished{return;}let k=path_key(&task.path);let previous=d.bytes.insert(k.clone(),bytes).unwrap_or(0);d.sum_bytes=d.sum_bytes-previous+bytes;if let Some(n)=size{let previous=d.sizes.insert(k.clone(),n).unwrap_or(0);d.sum_sizes=d.sum_sizes-previous+n;}if done{d.done.insert(k);}
        // 逐个文件完成就立刻发事件，会让数千个小文件产生同量级 IPC 与前端重渲染，
        // 通道被打满后下载线程反被拖慢。完成事件与普通进度共用同一节流窗口，
        // 仅在「全部完成」时强制立即发送，避免进度条停在 99.x%。
        if (!done||d.done.len()<d.total)&&d.last.elapsed()<Duration::from_millis(80){return;}
        d.last=Instant::now();let current_bytes=d.sum_bytes;let total_bytes=d.sum_sizes;let elapsed=d.sample.elapsed().as_secs_f64();let speed=if elapsed>=0.15{let n=current_bytes.saturating_sub(d.sample_bytes)as f64/elapsed;d.sample=Instant::now();d.sample_bytes=current_bytes;n}else{0.0};let percent=if d.total>0{(d.done.len()as f64/d.total as f64*100.0).min(99.9)}else{0.0};json!({"taskId":self.task_id,"jobTitle":self.title,"task":task.label,"current":d.done.len(),"total":d.total,"currentBytes":current_bytes,"totalBytes":total_bytes,"phase":task.phase,"percent":percent,"speed":speed})};(self.sink)(payload);}pub(crate) fn finish(&self,success:bool){let payload={let Ok(mut d)=self.data.lock()else{return};if d.finished{return;}d.finished=true;json!({"taskId":self.task_id,"jobTitle":self.title,"task":if success{"完成"}else{"下载中断"},"current":d.done.len(),"total":d.total,"currentBytes":d.sum_bytes,"totalBytes":d.sum_sizes,"phase":"done","percent":if success{100}else{0},"speed":0})};(self.sink)(payload);}}
fn path_key(path:&Path)->String{let s=path.to_string_lossy().replace('\\',"/");if cfg!(windows){s.to_lowercase()}else{s}}
struct Job{cancel:Arc<Cancel>,id:String,completion:tokio::sync::watch::Sender<Option<Result<()>>>}
static JOBS:OnceLock<Mutex<HashMap<String,Arc<Job>>>>=OnceLock::new();
/// 组合根持有重启 IPC 门禁时调用；表内即使已发完成信号，owner 未归还仍拒绝重启。
pub(crate) fn relaunch_ready()->Result<()> { relaunch_ready_from(JOBS.get()) }
fn relaunch_ready_from(registry:Option<&Mutex<HashMap<String,Arc<Job>>>>)->Result<()> {
    if let Some(registry)=registry {
        let jobs=registry.try_lock().map_err(|_|"下载任务状态忙碌或不可用，不能安全重启".to_string())?;
        if !jobs.is_empty(){return Err("下载或安装任务仍未收尾，不能安全重启".into());}
    }
    Ok(())
}
pub(crate) struct JobGuard{key:String,job:Arc<Job>}
// IPC future 被丢弃时只发取消信号；后台 worker 持有任务与根锁直到所有解压工作真正退出。
struct CancelOnDrop(Arc<Cancel>);
impl Drop for CancelOnDrop{fn drop(&mut self){self.0.stop();}}
impl JobGuard{pub(crate) fn register(root:&Path,id:&str)->Result<Self>{let key=format!("{}|{id}",path_key(root));let mut jobs=JOBS.get_or_init(||Mutex::new(HashMap::new())).lock().map_err(|_|"任务登记不可用")?;if jobs.len()>=128{return Err("下载任务数量超过上限".into());}if jobs.contains_key(&key){return Err("同目录同版本的安装任务已在进行中".into());}let (completion,_)=tokio::sync::watch::channel(None);let job=Arc::new(Job{cancel:Arc::new(Cancel::default()),id:id.into(),completion});jobs.insert(key.clone(),job.clone());Ok(Self{key,job})}}
impl JobGuard{ pub(crate) fn cancel(&self)->Arc<Cancel>{self.job.cancel.clone()} pub(crate) fn complete(&self,result:Result<()>){self.job.completion.send_replace(Some(result));} }
/// 先订阅任务完成，再取得根锁；未登记时返回 false，由调用方在锁内验证原版文件。
pub(crate) async fn wait_for_install(root:&Path,id:&str,cancel:&Cancel)->Result<bool>{identifier(id)?;let key=format!("{}|{id}",path_key(root));let receiver={let jobs=JOBS.get_or_init(||Mutex::new(HashMap::new())).lock().map_err(|_|"任务登记不可用")?;jobs.get(&key).map(|job|job.completion.subscribe())};let Some(mut receiver)=receiver else{return Ok(false)};loop{cancel.check()?;if let Some(result)=receiver.borrow().clone(){result?;return Ok(true);}tokio::select!{_ = cancel.cancelled()=>return Err("下载已取消".into()),changed=receiver.changed()=>{changed.map_err(|_|"原版安装未正常完成")?;}}}}
impl Drop for JobGuard{fn drop(&mut self){let incomplete={self.job.completion.borrow().is_none()};if incomplete{self.job.completion.send_replace(Some(Err("安装任务异常结束或已取消".into())));}self.job.cancel.stop();if let Ok(mut jobs)=JOBS.get_or_init(||Mutex::new(HashMap::new())).lock(){if jobs.get(&self.key).is_some_and(|j|Arc::ptr_eq(j,&self.job)){jobs.remove(&self.key);}}}}
fn cancel_jobs(id:Option<&str>)->Result<()>{let jobs=JOBS.get_or_init(||Mutex::new(HashMap::new())).lock().map_err(|_|"任务登记不可用")?;for j in jobs.values(){if id.map_or(true,|id|id==j.id){j.cancel.stop();}}Ok(())}
fn cancel_id(args:&[Value])->Result<Option<&str>> {
    if args.len()>1 { return Err("download:cancel 参数数量不符".into()); }
    match args.first() {
        None|Some(Value::Null)=>Ok(None),
        Some(Value::String(id)) if id.is_empty()=>Ok(None),
        Some(Value::String(id)) if id.len()<=512&&!id.chars().any(char::is_control)=>Ok(Some(id)),
        _=>Err("任务标识必须是有效字符串".into()),
    }
}
fn strategy(settings:&Value,key:&str)->Result<&'static str>{match settings.get(key){None|Some(Value::Null)=>Ok("auto"),Some(Value::String(s))=>match s.as_str(){"auto"=>Ok("auto"),"official-first"=>Ok("official-first"),"mirror-first"=>Ok("mirror-first"),_=>Err("下载源策略无效".into())},_=>Err("下载源策略必须为字符串".into())}}
fn ordered(official:&str,mirror:&str,strategy:&str)->Vec<String>{let values=match strategy{"official-first"=>vec![official],"mirror-first"=>vec![mirror,official],_=>vec![official,mirror]};let mut out=Vec::new();for v in values{if !v.is_empty()&&!out.iter().any(|s|s==v){out.push(v.to_string());}}out}
fn mirror_url(url:&str)->String{if let Some(rel)=url.strip_prefix("https://libraries.minecraft.net/"){return format!("{MIRROR}/maven/{rel}");}if url.starts_with("https://resources.download.minecraft.net/"){if let Some(hash)=url.rsplit('/').next(){if checksum(hash,40).is_ok(){return format!("{MIRROR}/assets/{hash}");}}}if url.starts_with("https://piston-data.mojang.com/"){for piece in url.split('/'){if checksum(piece,40).is_ok(){return format!("{MIRROR}/objects/{piece}");}}}url.into()}
fn file_urls(url:&str,settings:&Value)->Result<Vec<String>>{
    // 镜像节点地址直接作为「镜像」候选、官方等价地址作为回退；普通地址维持原有语义。
    let strategy=strategy(settings,"downloadSource")?;
    if let Some(official)=official_equivalent(url){return Ok(ordered(&official,url,strategy));}
    Ok(ordered(url,&mirror_url(url),strategy))
}
fn client_urls(url:&str,base:&str,settings:&Value)->Result<Vec<String>>{identifier(base)?;Ok(ordered(url,&format!("{MIRROR}/version/{base}/client"),strategy(settings,"downloadSource")?))}
fn concurrency(settings:&Value)->Result<usize>{let base=match settings.get("maxDownloadConcurrency"){Some(Value::Null)|None=>8,Some(v)=>v.as_u64().filter(|n|*n>=1&&*n<=128).ok_or("下载并发必须为1..128的整数")?};let factor=match text(settings,"downloadAcceleration"){"balanced"=>0.5,"turbo"=>2.0,""|"auto"=>1.0,_=>return Err("下载加速档位无效".into())};Ok(((base as f64*factor).round()as usize).clamp(1,48))}

// Windows rename 不覆盖已有文件；使用同卷原子替换，不先删除旧的有效目标。
fn replace_file(source:&Path,target:&Path)->Result<()> {absolute(source)?;absolute(target)?;#[cfg(windows)]{use std::os::windows::ffi::OsStrExt;#[link(name="kernel32")]extern "system"{fn MoveFileExW(from:*const u16,to:*const u16,flags:u32)->i32;}let a=source.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();let b=target.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();if unsafe{MoveFileExW(a.as_ptr(),b.as_ptr(),1|8)}==0{return Err("无法原子替换下载文件".into());}Ok(())}#[cfg(not(windows))]{fs::rename(source,target).map_err(|_|"无法原子替换下载文件".into())}}
async fn fetch_bytes(network:&Network,urls:&[String],sha:Option<&str>,limit:u64,cancel:&Cancel)->Result<Vec<u8>> {let mut last="元数据下载地址为空".to_string();for url in urls{for attempt in 0..3u32{cancel.check()?;let result=async{let mut r=network.request(url,None,cancel).await?;if !r.status().is_success(){return Err(TransferError::status(&r));}if r.content_length().is_some_and(|n|n>limit){return Err(TransferError::fatal("元数据响应超过大小上限"));}let mut out=Vec::new();loop{let next=tokio::select!{_ = cancel.cancelled()=>return Err(TransferError::fatal("下载已取消")),r=tokio::time::timeout(Duration::from_secs(20),r.chunk())=>r.map_err(|_|TransferError{status:None,retry:None,slow:true,message:"元数据读取停滞超时".into(),fatal:false})?.map_err(|_|TransferError{status:None,retry:None,slow:false,message:"元数据读取失败".into(),fatal:false})?};let Some(chunk)=next else{break};if out.len()as u64+chunk.len()as u64>limit{return Err(TransferError::fatal("元数据响应超过大小上限"));}out.extend_from_slice(&chunk);}if let Some(expected)=sha{if hex_sha1(&out)!=checksum(expected,40).map_err(TransferError::fatal)?{return Err(TransferError{status:None,retry:None,slow:false,message:"元数据 SHA-1 校验失败".into(),fatal:false});}}Ok(out)}.await;match result{Ok(bytes)=>return Ok(bytes),Err(e)=>{cancel.check()?;last=e.message.clone();if e.fatal||e.slow||matches!(e.status,Some(404)|Some(410)){break;}if attempt<2{sleep_cancel(e.delay(attempt),cancel).await?;}}}}}Err(last)}
fn parse_json(bytes:&[u8])->Result<Value>{let v:Value=serde_json::from_slice(bytes).map_err(|_|"远程元数据不是有效 JSON")?;if !v.is_object(){return Err("元数据必须是对象".into());}Ok(v)}
#[derive(Clone)]struct PartState{source:String,validator:Option<String>}
fn response_validator(r:&reqwest::Response)->Option<String>{r.headers().get(reqwest::header::ETAG).and_then(|v|v.to_str().ok()).filter(|s|!s.starts_with("W/")).or_else(||r.headers().get(reqwest::header::LAST_MODIFIED).and_then(|v|v.to_str().ok())).map(str::to_string)}
fn content_range(s:&str,offset:u64,expected:Option<u64>)->Result<u64>{let body=s.strip_prefix("bytes ").ok_or("续传响应缺少合法 Content-Range")?;let(range,total)=body.split_once('/').ok_or("续传范围格式无效")?;let(start,end)=range.split_once('-').ok_or("续传范围格式无效")?;let start=start.parse::<u64>().map_err(|_|"续传起点无效")?;let end=end.parse::<u64>().map_err(|_|"续传终点无效")?;let total=total.parse::<u64>().map_err(|_|"续传总大小无效")?;if start!=offset||end<start||end>=total||total>FILE_LIMIT||expected.is_some_and(|n|n!=total){return Err("服务器返回了不一致的续传范围".into());}Ok(total)}
// Tokio File 的 write_all 可能只把字节交给后台阻塞任务。包括写失败路径，也要等 flush
// 真正收尾后才允许观察取消、重试或删除临时文件；调用方不能 select/drop 此 future。
pub(crate) async fn write_download_chunk<W: tokio::io::AsyncWrite + Unpin>(file:&mut W,chunk:&[u8])->std::io::Result<()> {
    let written=file.write_all(chunk).await;
    let flushed=file.flush().await;
    written?;
    flushed
}
/// 下载流攒批阈值。流式 chunk 通常只有 8–64KB，逐块 write+flush 会为每一块派发一次
/// 后台阻塞写；攒到 1 MiB 再落盘对吞吐影响明显。所有下载入口共用同一阈值。
pub(crate) const DOWNLOAD_CHUNK_BUFFER: usize = 1024 * 1024;
pub(crate) async fn buffer_download_chunk<W: tokio::io::AsyncWrite + Unpin>(file:&mut W,pending:&mut Vec<u8>,chunk:&[u8])->std::io::Result<()> {
    pending.extend_from_slice(chunk);
    if pending.len()>=DOWNLOAD_CHUNK_BUFFER {
        file.write_all(pending).await?;
        pending.clear();
    }
    Ok(())
}
pub(crate) async fn flush_download_buffer<W: tokio::io::AsyncWrite + Unpin>(file:&mut W,pending:&mut Vec<u8>)->std::io::Result<()> {
    let written=if pending.is_empty(){Ok(())}else{let result=file.write_all(pending).await;pending.clear();result};
    written?;
    file.flush().await
}
async fn transfer_task(network:&Network,task:&FileTask,temp:&Path,state:&mut Option<PartState>,source:&str,cancel:&Cancel,progress:&Progress)->std::result::Result<(),TransferError>{
    cancel.check().map_err(TransferError::fatal)?;let length=tokio::fs::metadata(temp).await.map(|m|m.len()).unwrap_or(0);let resume=state.as_ref().filter(|s|s.source==source&&s.validator.is_some()&&length>0&&length<FILE_LIMIT);let offset=if resume.is_some(){length}else{0};let mut response=network.request(source,resume.map(|s|(offset,s.validator.as_deref())),cancel).await?;if response.status().as_u16()==416{return Err(TransferError{status:Some(416),retry:None,slow:false,message:"服务器拒绝续传范围".into(),fatal:false});}if !response.status().is_success(){return Err(TransferError::status(&response));}
    let append=response.status().as_u16()==206;if append&&offset==0{return Err(TransferError::fatal("服务器返回了未请求的部分内容"));}let mut total=if append{Some(content_range(response.headers().get(reqwest::header::CONTENT_RANGE).and_then(|v|v.to_str().ok()).unwrap_or(""),offset,task.size).map_err(TransferError::fatal)?)}else{response.content_length()};if total.is_some_and(|n|n>FILE_LIMIT){return Err(TransferError::fatal("下载文件超过安全上限"));}if let(Some(expected),Some(actual))=(task.size,total){if actual!=expected{return Err(TransferError{status:None,retry:None,slow:false,message:"下载响应大小与元数据不符".into(),fatal:false});}}if total.is_none(){total=task.size;}
    let validator=response_validator(&response);if append&&resume.and_then(|s|s.validator.as_ref()).zip(validator.as_ref()).is_some_and(|(a,b)|a!=b){return Err(TransferError::fatal("续传期间服务端文件已变化"));}*state=Some(PartState{source:source.into(),validator});let mut options=tokio::fs::OpenOptions::new();options.write(true).create(true);if append{options.append(true);}else{options.truncate(true);}let mut file=options.open(temp).await.map_err(|_|TransferError::fatal("无法写入下载临时文件"))?;let mut received=if append{offset}else{0};progress.update(task,received,total,false);
    // 16KB 的流式 chunk 逐块写盘会让每次写都派发一次后台阻塞任务；攒到约 1 MiB 再落盘，
    // 块大小对下载吞吐影响明显（尤其镜像单连接本来就快时）。
    let mut pending:Vec<u8>=Vec::with_capacity(1024*1024);
    loop{let next=tokio::select!{_ = cancel.cancelled()=>{if !pending.is_empty(){write_download_chunk(&mut file,&pending).await.map_err(|_|TransferError::fatal("写入或刷新下载文件失败"))?;}return Err(TransferError::fatal("下载已取消"))},r=tokio::time::timeout(Duration::from_secs(20),response.chunk())=>r};let chunk=match next{Ok(Ok(Some(chunk)))=>chunk,Ok(Ok(None))=>break,Ok(Err(e))=>{if !pending.is_empty(){write_download_chunk(&mut file,&pending).await.map_err(|_|TransferError::fatal("写入或刷新下载文件失败"))?;}return Err(TransferError{status:None,retry:None,slow:e.is_timeout(),message:"读取下载数据失败".into(),fatal:false})},Err(_)=>{if !pending.is_empty(){write_download_chunk(&mut file,&pending).await.map_err(|_|TransferError::fatal("写入或刷新下载文件失败"))?;}return Err(TransferError{status:None,retry:None,slow:true,message:"下载读取停滞超时".into(),fatal:false})}};received=received.checked_add(chunk.len()as u64).ok_or_else(||TransferError::fatal("下载大小溢出"))?;if received>FILE_LIMIT||task.size.is_some_and(|n|received>n){return Err(TransferError::fatal("实际下载超过声明大小"));}cancel.check().map_err(TransferError::fatal)?;pending.extend_from_slice(&chunk);if pending.len()>=1024*1024{write_download_chunk(&mut file,&pending).await.map_err(|_|TransferError::fatal("写入或刷新下载文件失败"))?;pending.clear();}cancel.check().map_err(TransferError::fatal)?;progress.update(task,received,total,false);}
    if !pending.is_empty(){write_download_chunk(&mut file,&pending).await.map_err(|_|TransferError::fatal("写入或刷新下载文件失败"))?;}
    finalize_download(task,temp,cancel,progress,received,total).await
}
/// 下载临时文件收尾：尺寸 / 摘要复核、sidecar 落盘、原子替换、完成进度。单流与分段共用。
async fn finalize_download(task:&FileTask,temp:&Path,cancel:&Cancel,progress:&Progress,received:u64,total:Option<u64>)->std::result::Result<(),TransferError>{
    if task.size.or(total).is_some_and(|n|n!=received){return Err(TransferError{status:None,retry:None,slow:false,message:"下载文件未完整传输".into(),fatal:false});}
    let mut file=tokio::fs::OpenOptions::new().append(true).open(temp).await.map_err(|_|TransferError::fatal("无法刷新下载临时文件"))?;file.sync_all().await.map_err(|_|TransferError::fatal("提交下载文件失败"))?;drop(file);cancel.check().map_err(TransferError::fatal)?;
    let temporary=FileTask{path:temp.into(),..task.clone()};if !satisfied_in_context(&temporary,cancel).await.map_err(TransferError::fatal)?{let _=tokio::fs::remove_file(temp).await;return Err(TransferError{status:None,retry:None,slow:false,message:"下载文件大小或摘要校验失败".into(),fatal:false});}if task.sidecar{if let Some(d)=&task.sha1{let cache=task.path.with_extension(format!("{}.hc-sha1",task.path.extension().and_then(|s|s.to_str()).unwrap_or("")));atomic_json(&cache,&json!({"sha1":d}),cancel).map_err(TransferError::fatal)?;}}cancel.check().map_err(TransferError::fatal)?;replace_file(temp,&task.path).map_err(TransferError::fatal)?;progress.update(task,received,Some(received),true);Ok(())
}
/// 分段下载阈值与上限：过小文件分段收益抵不过额外连接；单文件分段数有硬顶。
const SEGMENT_MIN_BYTES:u64=16*1024*1024;
const SEGMENT_MAX_CONN:usize=16;
fn download_connections(settings:&Value)->usize{match settings.get("downloadConnections"){Some(v)=>v.as_u64().filter(|n|*n>=1&&*n<=256).map(|n|n as usize).unwrap_or(8),None|Some(Value::Null)=>8}}
/// 单个分段：请求明确的 [start,end] 字节区间写入独立暂存文件；进度用全局原子计数聚合（区间不相交，总和单调）。
async fn transfer_segment(network:&Network,source:&str,seg:&Path,start:u64,end:u64,total:u64,written:&Arc<AtomicU64>,cancel:&Cancel,progress:&Progress,task:&FileTask)->std::result::Result<(),TransferError>{
    cancel.check().map_err(TransferError::fatal)?;let mut response=network.request_end(source,start,end,cancel).await?;if response.status().as_u16()!=206{return Err(TransferError{status:Some(response.status().as_u16()),retry:None,slow:false,message:"分段下载未获得部分内容响应".into(),fatal:false});}
    let header=response.headers().get(reqwest::header::CONTENT_RANGE).and_then(|v|v.to_str().ok()).unwrap_or("");let body=header.strip_prefix("bytes ").ok_or_else(||TransferError::fatal("分段响应缺少 Content-Range"))?;let(range,range_total)=body.split_once('/').ok_or_else(||TransferError::fatal("分段范围格式无效"))?;let(hs,he)=range.split_once('-').ok_or_else(||TransferError::fatal("分段范围格式无效"))?;let hs=hs.parse::<u64>().map_err(|_|TransferError::fatal("分段起点无效"))?;let he=he.parse::<u64>().map_err(|_|TransferError::fatal("分段终点无效"))?;let range_total=range_total.parse::<u64>().map_err(|_|TransferError::fatal("分段总大小无效"))?;if hs!=start||he!=end||range_total!=total||total>FILE_LIMIT{return Err(TransferError::fatal("服务器返回了不一致的分段范围"));}
    let mut file=tokio::fs::OpenOptions::new().write(true).create(true).truncate(true).open(seg).await.map_err(|_|TransferError::fatal("无法写入分段暂存文件"))?;
    let expected=end-start+1;let mut received=0u64;let mut pending:Vec<u8>=Vec::with_capacity(1024*1024);
    loop{let next=tokio::select!{_ = cancel.cancelled()=>return Err(TransferError::fatal("下载已取消")),r=tokio::time::timeout(Duration::from_secs(20),response.chunk())=>r};let chunk=match next{Ok(Ok(Some(chunk)))=>chunk,Ok(Ok(None))=>break,Ok(Err(e))=>{if !pending.is_empty(){file.write_all(&pending).await.map_err(|_|TransferError::fatal("写入分段暂存文件失败"))?;}return Err(TransferError{status:None,retry:None,slow:e.is_timeout(),message:"读取分段数据失败".into(),fatal:false})},Err(_)=>{if !pending.is_empty(){file.write_all(&pending).await.map_err(|_|TransferError::fatal("写入分段暂存文件失败"))?;}return Err(TransferError{status:None,retry:None,slow:true,message:"分段读取停滞超时".into(),fatal:false})}};received=received.checked_add(chunk.len()as u64).ok_or_else(||TransferError::fatal("分段大小溢出"))?;if received>expected{return Err(TransferError::fatal("分段数据超过请求边界"));}cancel.check().map_err(TransferError::fatal)?;pending.extend_from_slice(&chunk);if pending.len()>=1024*1024{file.write_all(&pending).await.map_err(|_|TransferError::fatal("写入分段暂存文件失败"))?;pending.clear();}written.fetch_add(chunk.len()as u64,Ordering::Relaxed);progress.update(task,written.load(Ordering::Relaxed),Some(total),false);}
    if !pending.is_empty(){file.write_all(&pending).await.map_err(|_|TransferError::fatal("写入分段暂存文件失败"))?;}file.flush().await.map_err(|_|TransferError::fatal("刷新分段暂存文件失败"))?;file.sync_all().await.map_err(|_|TransferError::fatal("提交分段暂存文件失败"))?;drop(file);
    if received!=expected{return Err(TransferError{status:None,retry:None,slow:false,message:"分段未完整传输".into(),fatal:false});}cancel.check().map_err(TransferError::fatal)?;Ok(())
}
struct SegmentCleanup(Vec<PathBuf>);
impl Drop for SegmentCleanup{fn drop(&mut self){for path in &self.0{let _=fs::remove_file(path);}}}
/// 多连接分段下载：仅用于已知大小且 ≥16 MiB 的大文件。任一前置条件不满足或服务器不按边界
/// 返回 206 时返回错误，由调用方回退到既有单流（支持续传）路径。
async fn segmented_transfer(network:&Network,task:&FileTask,temp:&Path,source:&str,settings:&Value,cancel:&Cancel,progress:&Progress)->std::result::Result<(),TransferError>{
    let total=task.size.ok_or_else(||TransferError::fatal("分段下载缺少大小元数据"))?;if total<SEGMENT_MIN_BYTES||total>FILE_LIMIT{return Err(TransferError::fatal("文件大小不适合分段下载"));}
    let conns=download_connections(settings).clamp(2,SEGMENT_MAX_CONN);let seg_len=total.div_ceil(conns as u64);if seg_len==0{return Err(TransferError::fatal("分段长度无效"));}
    let parent=temp.parent().ok_or_else(||TransferError::fatal("下载路径无父目录"))?;
    let mut segments=Vec::new();for index in 0..conns as u64{let start=index*seg_len;if start>=total{break;}let end=((start+seg_len).min(total))-1;let path=parent.join(format!(".hcmcl-seg-{}-{index}.part",uuid::Uuid::new_v4().simple()));segments.push((start,end,path));}
    let _cleanup=SegmentCleanup(segments.iter().map(|(_,_,path)|path.clone()).collect());
    let written=Arc::new(AtomicU64::new(0));let mut workers=JoinSet::new();
    for (start,end,path) in &segments{let start=*start;let end=*end;let path=path.clone();let network=network.clone();let source=source.to_owned();let task=task.clone();let cancel=cancel.clone();let progress=progress.clone();let written=written.clone();workers.spawn(async move{transfer_segment(&network,&source,&path,start,end,total,&written,&cancel,&progress,&task).await});}
    while let Some(joined)=workers.join_next().await{match joined{Ok(Ok(()))=>{},Ok(Err(error))=>return Err(error),Err(_)=>return Err(TransferError::fatal("分段下载任务异常结束"))}cancel.check().map_err(TransferError::fatal)?;}
    // 串接各分段到主临时文件；逐个核对长度，写穿后清理分段暂存。
    let mut output=tokio::fs::OpenOptions::new().write(true).create(true).truncate(true).open(temp).await.map_err(|_|TransferError::fatal("无法写入下载临时文件"))?;
    for (start,end,path) in &segments{let expected=end-start+1;let mut input=tokio::fs::File::open(path).await.map_err(|_|TransferError::fatal("无法读取分段暂存文件"))?;let copied=tokio::io::copy(&mut input,&mut output).await.map_err(|_|TransferError::fatal("串接分段暂存文件失败"))?;if copied!=expected{return Err(TransferError::fatal("分段暂存文件长度不一致"));}cancel.check().map_err(TransferError::fatal)?;}
    output.flush().await.map_err(|_|TransferError::fatal("刷新下载临时文件失败"))?;output.sync_all().await.map_err(|_|TransferError::fatal("提交下载临时文件失败"))?;drop(output);
    for (_,_,path) in &segments{let _=tokio::fs::remove_file(path).await;}
    finalize_download(task,temp,cancel,progress,total,Some(total)).await
}
/// 单流与分段的统一入口：满足条件先尝试分段，失败回退单流（保留既有续传语义）。
async fn transfer_any(network:&Network,task:&FileTask,temp:&Path,state:&mut Option<PartState>,source:&str,settings:&Value,cancel:&Cancel,progress:&Progress)->std::result::Result<(),TransferError>{
    if task.size.is_some_and(|size|size>=SEGMENT_MIN_BYTES)&&download_connections(settings)>=2{
        if let Ok(())=segmented_transfer(network,task,temp,source,settings,cancel,progress).await{return Ok(());}
        let _=tokio::fs::remove_file(temp).await;*state=None;
    }
    transfer_task(network,task,temp,state,source,cancel,progress).await
}
async fn download_one(network:&Network,mut task:FileTask,settings:&Value,cancel:&Cancel,progress:&Progress)->Result<()> {
    if task.sha1.is_none()&&task.sha256.is_none(){let cache=task.path.with_extension(format!("{}.hc-sha1",task.path.extension().and_then(|s|s.to_str()).unwrap_or("")));if cache.is_file(){if let Ok(v)=read_json(&cache){if let Ok(d)=checksum(text(&v,"sha1"),40){task.sha1=Some(d);}}}}
    if satisfied_in_context(&task,cancel).await?{let size=fs::metadata(&task.path).map_err(|_|"读取缓存大小失败")?.len();progress.update(&task,size,Some(size),true);return Ok(());}if local(settings){return Err(format!("本地模式缺少已校验文件：{}；未发起网络请求",task.label));}if task.local_only{return Err(format!("缺少安装器生成的本地依赖：{}",task.label));}if task.urls.is_empty(){return Err(format!("{}缺少下载地址",task.label));}for url in &task.urls{network.url(url)?;}
    if task.sha1.is_none()&&task.sha256.is_none()&&task.sidecar{let sidecars=task.urls.iter().map(|u|format!("{u}.sha1")).collect::<Vec<_>>();if let Ok(bytes)=fetch_bytes(network,&sidecars,None,1024,cancel).await{if let Ok(s)=std::str::from_utf8(&bytes){if let Some(value)=s.split_whitespace().next(){if let Ok(hash)=checksum(value,40){task.sha1=Some(hash);}}}}cancel.check()?;if satisfied_in_context(&task,cancel).await?{let size=fs::metadata(&task.path).map_err(|_|"读取缓存大小失败")?.len();progress.update(&task,size,Some(size),true);return Ok(());}}
    mkdir(task.path.parent().ok_or("下载路径没有父目录")?)?;let mut temp=TempPath{path:inside(task.path.parent().ok_or("下载路径无父目录")?,format!(".hcmcl-{}.part",uuid::Uuid::new_v4()))?,committed:false};let mut state=None;let mut last=String::new();for source in &task.urls{for attempt in 0..3u32{cancel.check()?;match transfer_any(network,&task,&temp.path,&mut state,source,settings,cancel,progress).await{Ok(())=>{temp.committed=true;return Ok(());},Err(e)=>{cancel.check()?;last=e.message.clone();if e.fatal{return Err(format!("{}：{}",task.label,last));}if e.status==Some(416){let _=tokio::fs::remove_file(&temp.path).await;state=None;}if e.slow||matches!(e.status,Some(404)|Some(410)){break;}if attempt<2{sleep_cancel(e.delay(attempt),cancel).await?;}}}}let _=tokio::fs::remove_file(&temp.path).await;state=None;progress.update(&task,0,task.size,false);}Err(format!("缺少必需文件「{}」：{}",task.label,last))
}
fn unique_tasks(tasks:Vec<FileTask>)->Result<Vec<FileTask>>{let mut map=BTreeMap::<String,FileTask>::new();for t in tasks{let key=path_key(&t.path);if let Some(old)=map.get_mut(&key){if old.sha1!=t.sha1||old.sha256!=t.sha256||old.size!=t.size{return Err("同一下载目标出现冲突校验元数据".into());}for u in t.urls{if !old.urls.contains(&u){old.urls.push(u);}}}else{map.insert(key,t);}}Ok(map.into_values().collect())}
async fn batch(network:&Network,tasks:Vec<FileTask>,settings:&Value,cancel:Arc<Cancel>,progress:&Progress)->Result<()> {let tasks=unique_tasks(tasks)?;progress.register(&tasks);let width=concurrency(settings)?;let mut iter=tasks.into_iter();let mut running=JoinSet::new();loop{while running.len()<width{let Some(task)=iter.next()else{break};let n=network.clone();let s=settings.clone();let c=cancel.clone();let p=progress.clone();running.spawn(async move{download_one(&n,task,&s,&c,&p).await});}if running.is_empty(){break;}match running.join_next().await{Some(Ok(Ok(())))=>{},Some(Ok(Err(e)))=>{cancel.stop();while running.join_next().await.is_some(){}return Err(e);},Some(Err(_))=>{cancel.stop();while running.join_next().await.is_some(){}return Err("下载工作任务异常结束".into());},None=>break}}cancel.check()}
pub(crate) async fn version_list(force: bool, root: &Path, settings: &Value) -> Result<Value> {
    let cancel = Cancel::default();
    let network = Network::production()?;
    version_metadata::Metadata::new(&network, root, settings, &cancel).list(force).await
}
fn merge(parent:&Value,child:&Value)->Result<Value>{let mut out=parent.as_object().ok_or("父版本 JSON 无效")?.clone();for(k,v)in child.as_object().ok_or("子版本 JSON 无效")?{out.insert(k.clone(),v.clone());}for k in["mainClass","assetIndex","assets","javaVersion","logging"]{if child.get(k).map_or(true,|v|v.is_null()||v.as_str()==Some("")){if let Some(v)=parent.get(k){out.insert(k.into(),v.clone());}}}let mut d=parent["downloads"].as_object().cloned().unwrap_or_default();if let Some(v)=child["downloads"].as_object(){d.extend(v.clone());}out.insert("downloads".into(),Value::Object(d));let mut l=parent["libraries"].as_array().cloned().unwrap_or_default();l.extend(child["libraries"].as_array().cloned().unwrap_or_default());out.insert("libraries".into(),json!(l));if parent.get("arguments").is_some()||child.get("arguments").is_some(){let mut args=serde_json::Map::new();for key in["jvm","game"]{let mut a=parent["arguments"][key].as_array().cloned().unwrap_or_default();if key=="game"&&a.is_empty()&&!text(parent,"minecraftArguments").is_empty(){a=split_arguments(text(parent,"minecraftArguments"))?.into_iter().map(Value::String).collect();}a.extend(child["arguments"][key].as_array().cloned().unwrap_or_default());args.insert(key.into(),json!(a));}out.insert("arguments".into(),Value::Object(args));}out.insert("clientVersion".into(),json!(if text(parent,"clientVersion").is_empty(){text(parent,"id")}else{text(parent,"clientVersion")}));out.remove("inheritsFrom");Ok(Value::Object(out))}
pub(crate) fn merge_version(parent:&Value,child:&Value)->Result<Value>{merge(parent,child)}

fn split_arguments(s:&str)->Result<Vec<String>>{let mut a=Vec::new();let mut current=String::new();let mut quote=None;let mut escaped=false;let mut active=false;for ch in s.chars(){if escaped{current.push(ch);escaped=false;active=true;continue;}if ch=='\\'{escaped=true;continue;}if let Some(q)=quote{if ch==q{quote=None;}else{current.push(ch);}active=true;continue;}if ch=='\''||ch=='"'{quote=Some(ch);active=true;}else if ch.is_whitespace(){if active{a.push(std::mem::take(&mut current));active=false;}}else{current.push(ch);active=true;}}if quote.is_some(){return Err("旧版参数引号不闭合".into());}if escaped{current.push('\\');}if active{a.push(current);}Ok(a)}
async fn resolve(network:&Network,id:&str,root:&Path,settings:&Value,cancel:&Cancel)->Result<Value>{
    version_metadata::Metadata::new(network,root,settings,cancel)
        .resolve(id,version_metadata::LocalId::Required,merge).await
}

/// 仅解析版本元数据。调用方可已持有安装根锁，本入口不会重新取锁。
pub(crate) async fn resolve_runtime_version(id:&str,root:&Path,settings:&Value,cancel:&Cancel,merge:fn(&Value,&Value)->Result<Value>)->Result<Value>{
    let network=Network::production()?;
    version_metadata::Metadata::new(&network,root,settings,cancel)
        .resolve(id,version_metadata::LocalId::LegacyOptional,merge).await
}

pub(crate) async fn fetch_loader_json(kind:&str,mc:&str,loader:Option<&str>,root:&Path,settings:&Value,cancel:&Cancel)->Result<Value>{
    if !matches!(kind,"fabric"|"quilt"){return Err("仅支持 Fabric 或 Quilt 加载器".into());}
    identifier(mc)?; if let Some(v)=loader{identifier(v)?;}
    let base=if kind=="fabric"{"https://meta.fabricmc.net/v2/versions/loader"}else{"https://meta.quiltmc.org/v3/versions/loader"};
    let mut url=reqwest::Url::parse(base).map_err(|_|"加载器元数据地址无效")?;
    { let mut segments=url.path_segments_mut().map_err(|_|"加载器元数据路径无效")?;segments.push(mc);if let Some(version)=loader{segments.push(version).push("profile").push("json");} }
    let url=url.to_string();
    let cache_name=loader.map(|version|format!("{version}.profile.json")).unwrap_or_else(||"versions.json".into());
    let cache_rel=Path::new(".hcmcl-cache").join("loaders").join(kind).join(mc).join(cache_name);
    let cache=inside(root,&cache_rel)?;
    if cache.is_file(){let fresh=fs::metadata(&cache).ok().and_then(|m|m.modified().ok()).and_then(|t|t.elapsed().ok()).is_some_and(|t|t<Duration::from_secs(300));if local(settings)||fresh{return read_value(&cache);}}
    if local(settings){return Err("本地模式缺少加载器元数据缓存，未发起网络请求".into());}
    let network=Network::production()?;let bytes=fetch_bytes(&network,&[url],None,JSON_LIMIT,cancel).await?;let value:Value=serde_json::from_slice(&bytes).map_err(|_|"加载器元数据不是有效 JSON")?;
    if !value.is_object()&&!value.is_array(){return Err("加载器元数据格式无效".into());} atomic_json(&cache,&value,cancel)?;Ok(value)
}

pub(crate) async fn install_version_value_under_guard(version:Value,root:&Path,settings:&Value,cancel:Arc<Cancel>,progress:&Progress,publish:bool)->Result<Value>{let network=Network::production()?;install_with_publish(&network,version,root,settings,cancel,progress,publish).await}
pub(crate) async fn resolve_version_under_guard(id:&str,root:&Path,settings:&Value,cancel:&Cancel)->Result<Value>{resolve(&Network::production()?,id,root,settings,cancel).await}

/// 仅登记本轮写点声明的相对路径；上层 Stage 必须逐项复核摘要和身份后登记。
#[derive(Debug)] pub(crate) struct GeneratedFile { pub(crate) path:String, pub(crate) size:u64, pub(crate) sha256:String }
#[derive(Debug)] pub(crate) struct InstanceBuild { pub(crate) profile:Value, pub(crate) files:Vec<GeneratedFile>, pub(crate) directories:Vec<String> }
/// 调用方持有 cache_root 的唯一根锁及 instance_dir 的独占 Stage；不发布 JSON 或任务完成事件。
pub(crate) async fn build_instance_under_guard(version:Value,cache_root:&Path,instance_dir:&Path,settings:&Value,cancel:Arc<Cancel>,progress:&Progress)->Result<Value>{Ok(build_instance_with_files_under_guard(version,cache_root,instance_dir,settings,cancel,progress).await?.profile)}
pub(crate) async fn build_instance_with_files_under_guard(version:Value,cache_root:&Path,instance_dir:&Path,settings:&Value,cancel:Arc<Cancel>,progress:&Progress)->Result<InstanceBuild>{let network=Network::production()?;build_instance(&network,version,cache_root,instance_dir,settings,cancel,progress).await}
fn instance_build_paths(cache_root:&Path,instance_dir:&Path)->Result<(PathBuf,PathBuf)>{
    let root=absolute(cache_root)?;let run=absolute(instance_dir)?;
    if !fs::metadata(&root).map_err(|_|"共享缓存根不存在")?.is_dir()||!fs::metadata(&run).map_err(|_|"实例 Stage 不存在")?.is_dir(){return Err("构建目录必须为已存在的真实目录".into());}
    let root=fs::canonicalize(root).map_err(|_|"无法规范化缓存根")?;let run=fs::canonicalize(run).map_err(|_|"无法规范化实例 Stage")?;absolute(&root)?;absolute(&run)?;
    let relative=run.strip_prefix(&root).map_err(|_|"实例 Stage 必须在可信共享根内")?;
    let first=relative.components().next().and_then(|part|part.as_os_str().to_str()).ok_or("实例 Stage 不能等于缓存根")?.to_ascii_lowercase();
    if first=="versions"{let parts=relative.components().collect::<Vec<_>>();let name=parts.get(1).and_then(|p|p.as_os_str().to_str()).unwrap_or("");let valid=parts.len()==2&&name.strip_prefix(".hcmcl-modpack-stage-").and_then(|v|uuid::Uuid::parse_str(v).ok().filter(|id|id.to_string()==v)).is_some();if !valid{return Err("仅允许受控整合包 Stage，不能写入真实 versions 实例".into());}}else if matches!(first.as_str(),"libraries"|"assets"|"resources"|".installers"|".hcmcl-cache"){return Err("不能把共享缓存作为构建 Stage".into());}
    #[cfg(unix)]{use std::os::unix::fs::MetadataExt;if fs::metadata(&root).map_err(|_|"无法读取缓存卷")?.dev()!=fs::metadata(&run).map_err(|_|"无法读取 Stage 卷")?.dev(){return Err("实例 Stage 必须与共享根同卷".into());}}
    #[cfg(windows)]{if build_volume(&root)?!=build_volume(&run)?{return Err("实例 Stage 必须与共享根同卷".into());}}
    for reserved in ["natives","resources"]{let p=inside(&run,reserved)?;match fs::symlink_metadata(p){Err(e)if e.kind()==std::io::ErrorKind::NotFound=>{},_=>return Err("实例 Stage 的 natives/resources 命名空间必须尚不存在".into())}}
    Ok((root,run))
}
#[cfg(windows)] fn build_volume(path:&Path)->Result<u32>{
    use std::{os::windows::{fs::OpenOptionsExt,io::AsRawHandle},ffi::c_void};
    #[link(name="kernel32")]extern "system"{fn GetVolumeInformationByHandleW(file:*mut c_void,name:*mut u16,name_len:u32,serial:*mut u32,max_component:*mut u32,flags:*mut u32,fs_name:*mut u16,fs_name_len:u32)->i32;}
    let file=OpenOptions::new().read(true).custom_flags(0x02000000).open(path).map_err(|_|"无法持有构建目录卷句柄")?;let mut serial=0;let mut max_component=0;let mut flags=0;
    if unsafe{GetVolumeInformationByHandleW(file.as_raw_handle(),std::ptr::null_mut(),0,&mut serial,&mut max_component,&mut flags,std::ptr::null_mut(),0)}==0{return Err("无法验证构建目录同卷".into());}Ok(serial)
}
fn instance_profile(mut version:Value)->Result<Value>{
    if !version.is_object()||version.get("inheritsFrom").is_some(){return Err("实例构建需要已解析的自包含版本".into());}
    let target=identifier(text(&version,"id"))?.to_owned();let mc=identifier(if text(&version,"clientVersion").is_empty(){&target}else{text(&version,"clientVersion")})?.to_owned();
    if target==mc{return Err("整包实例 ID 不能占用基础 Minecraft ID".into());}
    if !text(&version,"jar").is_empty()&&text(&version,"jar")!=mc{return Err("整包客户端 JAR 必须绑定基础 Minecraft 版本".into());}
    version["clientVersion"]=json!(mc);version["jar"]=version["clientVersion"].clone();Ok(version)
}
pub(crate) fn reject_profile_path(value:&Value,temporary:&Path)->Result<()>{let prefix=temporary.to_str().ok_or("临时路径不是 UTF-8")?.replace('\\',"/").to_lowercase();fn check(value:&Value,prefix:&str)->bool{match value{Value::String(s)=>s.replace('\\',"/").to_lowercase().contains(prefix),Value::Array(a)=>a.iter().any(|v|check(v,prefix)),Value::Object(o)=>o.values().any(|v|check(v,prefix)),_=>false}}if check(value,&prefix){Err("生成 profile 含临时目录路径，不能发布".into())}else{Ok(())}}
async fn build_instance(network:&Network,version:Value,cache_root:&Path,instance_dir:&Path,settings:&Value,cancel:Arc<Cancel>,progress:&Progress)->Result<InstanceBuild>{
    cancel.check()?;let version=instance_profile(version)?;let(root,run)=instance_build_paths(cache_root,instance_dir)?;reject_profile_path(&version,&run)?;let mut plan=collect_plan(&version,&root,settings)?;let mut index_json=None;
    if !plan.index.is_empty(){let info=&version["assetIndex"];let path=inside(&root,Path::new("assets/indexes").join(format!("{}.json",plan.index)))?;let mut task=FileTask::info(if text(info,"url").is_empty(){Vec::new()}else{file_urls(text(info,"url"),settings)?},path.clone(),info,format!("资源索引 {}",plan.index),"assets")?;task.local_only=task.urls.is_empty();progress.register(&[task.clone()]);download_one(network,task,settings,&cancel,progress).await?;let data=read_json(&path)?;plan.tasks.extend(asset_tasks(&data,&root,settings)?);index_json=Some(data);}
    batch(network,plan.tasks,settings,cancel.clone(),progress).await?;cancel.check()?;
    let worker_run=run.clone();let worker_root=root.clone();let c=cancel.clone();let index=plan.index;let archives=plan.natives;
    tokio::task::spawn_blocking(move||{
        // 只认本轮写点的清单，不从整棵实例树推导所有权。
        instance_build_paths(&worker_root,&worker_run)?;let mut records=BTreeMap::new();let native=inside(&worker_run,"natives")?;let mut native_records=BTreeMap::new();
        extract_natives_recorded(&native,&archives,&c,Some(&mut native_records))?;record_generated(&mut records,Path::new("natives"),true)?;
        for(_, (path,directory))in native_records{record_generated(&mut records,&Path::new("natives").join(path),directory)?;}
        if let Some(data)=index_json{map_assets_to(&data,&index,&worker_root,&worker_run,&c)?;if data["map_to_resources"].as_bool()==Some(true){for(name,_)in data["objects"].as_object().ok_or("资源索引缺少 objects")?{record_generated(&mut records,&Path::new("resources").join(name),false)?;}}}
        let mut files=Vec::new();let mut directories=Vec::new();for(_, (path,directory))in records{c.check()?;let full=inside(&worker_run,&path)?;let metadata=fs::symlink_metadata(&full).map_err(|_|"已登记生成路径不存在")?;if directory{if !metadata.is_dir(){return Err("已登记生成目录类型变化".into());}directories.push(path);}else{if !metadata.is_file(){return Err("已登记生成文件类型变化".into());}let(_,sha256,size)=file_hashes(&full,&c)?;if size!=metadata.len(){return Err("生成文件在登记时变化".into());}files.push(GeneratedFile{path,size,sha256});}}
        c.check()?;Ok(InstanceBuild{profile:version,files,directories})
    }).await.map_err(|_|"实例暂存构建工作异常")?
}
pub(crate) fn inside_path(root:&Path,relative:impl AsRef<Path>)->Result<PathBuf>{inside(root,relative)}
pub(crate) fn read_bytes(path:&Path)->Result<Vec<u8>>{read_bounded(path,JSON_LIMIT)}
pub(crate) fn write_new_bytes(path:&Path,bytes:&[u8],cancel:&Cancel)->Result<()>{
    cancel.check()?;absolute(path)?;let parent=path.parent().ok_or("文件没有父目录")?;mkdir(parent)?;
    let temp=TempPath{path:inside(parent,format!(".hcmcl-new-{}.part",uuid::Uuid::new_v4()))?,committed:false};
    let mut file=OpenOptions::new().write(true).create_new(true).open(&temp.path).map_err(|_|"无法创建临时文件")?;
    file.write_all(bytes).map_err(|_|"写入临时文件失败")?;file.sync_all().map_err(|_|"提交临时文件失败")?;drop(file);
    cancel.check()?;absolute(path)?;fs::hard_link(&temp.path,path).map_err(|_|"无法发布新文件，目标可能已存在或文件系统不支持原子新建")?;Ok(())
}

fn os_name()->&'static str{if cfg!(target_os="windows"){"windows"}else if cfg!(target_os="macos"){"osx"}else if cfg!(target_os="android"){"android"}else{"linux"}}
fn os_version()->String{#[cfg(windows)]{#[repr(C)]struct Version{size:u32,major:u32,minor:u32,build:u32,platform:u32,name:[u16;128]}#[link(name="ntdll")]extern "system"{fn RtlGetVersion(v:*mut Version)->i32;}let mut v=Version{size:std::mem::size_of::<Version>()as u32,major:0,minor:0,build:0,platform:0,name:[0;128]};if unsafe{RtlGetVersion(&mut v)}==0{return format!("{}.{}.{}",v.major,v.minor,v.build);}}#[cfg(target_os="macos")]{use std::ffi::c_void;extern "C"{fn sysctlbyname(name:*const i8,old:*mut c_void,len:*mut usize,new:*mut c_void,newlen:usize)->i32;}let mut buffer=[0u8;256];let mut len=buffer.len();if unsafe{sysctlbyname(b"kern.osproductversion\0".as_ptr()as *const i8,buffer.as_mut_ptr()as *mut c_void,&mut len,std::ptr::null_mut(),0)}==0{return String::from_utf8_lossy(&buffer[..len.min(buffer.len())]).trim_end_matches('\0').into();}}#[cfg(any(target_os="linux",target_os="android"))]{return fs::read_to_string("/proc/sys/kernel/osrelease").unwrap_or_default().trim().into();}#[allow(unreachable_code)]String::new()}
fn rules_allow(rules:Option<&Value>)->Result<bool>{let Some(rules)=rules else{return Ok(true)};let a=rules.as_array().ok_or("依赖规则必须为数组")?;if a.is_empty(){return Ok(true);}let mut allow=false;for r in a{if !r.is_object(){return Err("依赖规则无效".into());}if let Some(os)=r.get("os"){if !os.is_object(){return Err("系统规则必须为对象".into());}let name=text(os,"name");if !name.is_empty()&&name!=os_name(){continue;}let arch=text(os,"arch");let actual=std::env::consts::ARCH;let matched=arch.is_empty()||arch==actual||(actual=="aarch64"&&arch=="arm64")||(actual=="x86"&&arch=="i386")||(actual=="x86_64"&&matches!(arch,"x64"|"amd64"));if !matched{continue;}let pattern=text(os,"version");if !pattern.is_empty(){if pattern.len()>1024{return Err("系统版本规则过长".into());}if !regex::Regex::new(pattern).map_err(|_|"系统版本规则无效")?.is_match(&os_version()){continue;}}}if let Some(features)=r.get("features"){let f=features.as_object().ok_or("功能规则必须是对象")?;let mut matched=true;for(_,v)in f{let expected=v.as_bool().ok_or("功能规则值必须是布尔值")?;if expected{matched=false;}}if !matched{continue;}}allow=match text(r,"action"){"allow"=>true,"disallow"=>false,_=>return Err("依赖规则动作无效".into())};}Ok(allow)}
fn maven_path(coordinate:&str,classifier:Option<&str>)->Result<PathBuf>{let(coord,ext)=coordinate.split_once('@').unwrap_or((coordinate,"jar"));let p=coord.split(':').collect::<Vec<_>>();if !(3..=4).contains(&p.len()){return Err("Maven 坐标格式无效".into());}for s in &p{identifier(s)?;}identifier(ext)?;let class=classifier.or(p.get(3).copied());if let Some(c)=class{identifier(c)?;}let mut out=PathBuf::new();for g in p[0].split('.'){identifier(g)?;out.push(g);}out.push(p[1]);out.push(p[2]);out.push(format!("{}-{}{}.{}",p[1],p[2],class.map(|s|format!("-{s}")).unwrap_or_default(),ext));Ok(out)}
#[derive(Clone)]struct NativeArchive{path:PathBuf,excludes:Vec<String>}
struct InstallPlan{tasks:Vec<FileTask>,natives:Vec<NativeArchive>,index:String,android_natives_skipped:bool}
fn library_task(root:&Path,settings:&Value,lib:&Value,info:&Value,class:Option<&str>,phase:&'static str)->Result<FileTask>{
    let rel=if text(info,"path").is_empty(){maven_path(text(lib,"name"),class)?}else{PathBuf::from(text(info,"path"))};
    let path=inside(root,Path::new("libraries").join(&rel))?;
    let local_only=info.get("url").is_some()&&text(info,"url").is_empty();
    // 镜像清单会把依赖地址改写成自己的分发节点（实测 bmclapi17.sakura.sld.tw），这类节点
    // 不该进入版本依赖信任边界。依赖坐标与 sha1 已由版本 JSON 确定，因此把非白名单主机
    // 归一到官方仓库；下载时再由 file_urls 按用户策略改写回镜像入口，既不扩大信任边界，
    // 也保留镜像加速。
    let host_ok=|raw:&str|reqwest::Url::parse(raw).ok().and_then(|u|u.host_str().map(str::to_string)).is_some_and(|h|allowed_download_host(&h));
    let rel_text=rel.to_str().ok_or("依赖路径不是 UTF-8")?.replace('\\',"/");
    let custom=text(info,"url");
    let url=if !custom.is_empty()&&host_ok(custom){custom.to_string()}else{
        let declared=text(lib,"url").trim_end_matches('/');
        let repo=if !declared.is_empty()&&host_ok(&format!("{declared}/")){declared}else{"https://libraries.minecraft.net"};
        format!("{repo}/{rel_text}")
    };
    let mut enriched=info.clone();
    if !enriched.is_object(){enriched=json!({});}
    if enriched.get("sha1").is_none(){if let Some(h)=lib.get("sha1"){enriched["sha1"]=h.clone();}}
    let mut task=FileTask::info(if local_only{Vec::new()}else{file_urls(&url,settings)?},path,&enriched,text(lib,"name").into(),phase)?;
    task.local_only=local_only;
    task.sidecar=task.sha1.is_none()&&task.sha256.is_none();
    Ok(task)
}
fn collect_plan(v:&Value,root:&Path,settings:&Value)->Result<InstallPlan>{let libs=match v.get("libraries"){None=>Vec::new(),Some(a)=>a.as_array().ok_or("libraries 必须为数组")?.clone()};if libs.len()>20000{return Err("依赖库数量过多".into());}let mut selected=BTreeMap::new();let mut order=Vec::new();for lib in libs{if !rules_allow(lib.get("rules"))?{continue;}let coordinate=text(&lib,"name");maven_path(coordinate,None)?;let bare=coordinate.split('@').next().unwrap_or(coordinate).split(':').collect::<Vec<_>>();let key=format!("{}:{}:{}",bare[0],bare[1],bare.get(3).unwrap_or(&""));if !selected.contains_key(&key){order.push(key.clone());}selected.insert(key,lib);}let mut tasks=Vec::new();let mut natives=Vec::new();let mut skipped=false;for key in order{let lib=selected.get(&key).ok_or("依赖选择异常")?;let excludes=lib["extract"]["exclude"].as_array().map(|a|a.iter().map(|v|v.as_str().map(str::to_string).ok_or("原生排除项必须是字符串")).collect::<std::result::Result<Vec<_>,_>>()).transpose()?.unwrap_or_default();if excludes.len()>100||excludes.iter().any(|s|s.len()>1024){return Err("原生排除项过多或过长".into());}let artifact=lib["downloads"].get("artifact");let classifier_only=lib["downloads"].get("classifiers").is_some()&&artifact.is_none();if !classifier_only{let info=artifact.cloned().unwrap_or_else(||json!({}));let native=text(lib,"name").split(':').nth(3).is_some_and(|s|s.starts_with("natives-"));if native&&cfg!(target_os="android"){skipped=true;}else{let task=library_task(root,settings,lib,&info,None,"libraries")?;if native{natives.push(NativeArchive{path:task.path.clone(),excludes:excludes.clone()});}tasks.push(task);}}let arch=if cfg!(target_arch="aarch64"){"arm64"}else if cfg!(target_arch="x86"){"32"}else{"64"};let class=text(&lib["natives"],os_name()).replace("${arch}",arch);if !class.is_empty(){if cfg!(target_os="android"){skipped=true;}else{let info=lib["downloads"]["classifiers"].get(&class).cloned().unwrap_or_else(||json!({}));let task=library_task(root,settings,lib,&info,Some(&class),"libraries")?;natives.push(NativeArchive{path:task.path.clone(),excludes});tasks.push(task);}}else if cfg!(target_os="android")&&lib.get("natives").is_some(){skipped=true;}}
    let id=identifier(text(v,"id"))?;let client_id=if text(v,"jar").is_empty(){id}else{identifier(text(v,"jar"))?};let client=inside(root,Path::new("versions").join(client_id).join(format!("{client_id}.jar")))?;let info=&v["downloads"]["client"];let base=if text(v,"clientVersion").is_empty(){id}else{text(v,"clientVersion")};if text(info,"url").is_empty(){if !client.is_file(){return Err("版本缺少客户端 JAR 下载信息".into());}let mut task=FileTask::info(Vec::new(),client.clone(),info,"客户端 JAR".into(),"client")?;task.local_only=true;tasks.push(task);}else{tasks.push(FileTask::info(client_urls(text(info,"url"),base,settings)?,client,info,"客户端 JAR".into(),"client")?);}
    let index=if text(&v["assetIndex"],"id").is_empty(){text(v,"assets")}else{text(&v["assetIndex"],"id")};if !index.is_empty(){identifier(index)?;}let logging=&v["logging"]["client"]["file"];if !text(logging,"url").is_empty(){let name=identifier(text(logging,"id"))?;tasks.push(FileTask::info(file_urls(text(logging,"url"),settings)?,inside(root,Path::new("assets/log_configs").join(name))?,logging,"日志配置".into(),"logging")?);}Ok(InstallPlan{tasks,natives,index:index.into(),android_natives_skipped:skipped})}

fn native_outputs(target:&Path,cancel:&Cancel)->Result<Vec<Value>>{let mut stack=vec![target.to_path_buf()];let mut out=Vec::new();let mut total=0u64;let mut entries=0;while let Some(dir)=stack.pop(){cancel.check()?;absolute(&dir)?;for e in fs::read_dir(&dir).map_err(|_|"无法枚举原生输出")?{cancel.check()?;let p=e.map_err(|_|"读取原生输出失败")?.path();entries+=1;if entries>30000{return Err("原生输出条目过多".into());}let rel=p.strip_prefix(target).map_err(|_|"原生输出越界")?;inside(target,rel)?;let m=fs::symlink_metadata(&p).map_err(|_|"无法读取原生输出属性")?;if m.is_dir(){stack.push(p);}else if m.is_file(){if rel==Path::new(".extract-stamp"){continue;}total=total.saturating_add(m.len());if total>1024*1024*1024{return Err("原生输出过大".into());}out.push(json!({"path":rel.to_str().ok_or("原生输出路径不是 UTF-8")?.replace('\\',"/"),"size":m.len(),"sha1":file_hashes(&p,cancel)?.0}));}else{return Err("原生输出包含特殊文件".into());}}}out.sort_by(|a,b|text(a,"path").cmp(text(b,"path")));Ok(out)}
// 与 runtime.rs 使用相同 versions/<id>/natives、key/outputs 格式；失败不覆盖旧输出。
fn extract_natives(root:&Path,id:&str,archives:&[NativeArchive],cancel:&Cancel)->Result<PathBuf>{let target=inside(root,Path::new("versions").join(identifier(id)?).join("natives"))?;extract_natives_at(&target,archives,cancel)}
fn extract_natives_at(target:&Path,archives:&[NativeArchive],cancel:&Cancel)->Result<PathBuf>{extract_natives_recorded(target,archives,cancel,None)}
fn extract_natives_recorded(target:&Path,archives:&[NativeArchive],cancel:&Cancel,mut generated:Option<&mut GeneratedPaths>)->Result<PathBuf>{let target=absolute(target)?;let parent=target.parent().ok_or("原生输出没有父目录")?;mkdir(parent)?;let source=archives.iter().map(|a|Ok(json!({"path":a.path.to_str().ok_or("原生归档路径不是 UTF-8")?,"sha1":file_hashes(&a.path,cancel)?.0,"exclude":a.excludes}))).collect::<Result<Vec<_>>>()?;let key=hex_sha1(&serde_json::to_vec(&source).map_err(|_|"原生指纹序列化失败")?);if generated.is_none()&&target.is_dir(){if let Ok(stamp)=read_json(&inside(&target,".extract-stamp")?){if text(&stamp,"key")==key{if let Ok(outputs)=native_outputs(&target,cancel){if stamp["outputs"]==json!(outputs){return Ok(target);}}}}}let tag=uuid::Uuid::new_v4();let staging=inside(parent,format!("natives.staging-{tag}"))?;let backup=inside(parent,format!("natives.backup-{tag}"))?;mkdir(&staging)?;let mut moved=false;let result=(||->Result<()>{let mut entries=0;let mut total=0u64;for a in archives{cancel.check()?;absolute(&a.path)?;let f=File::open(&a.path).map_err(|_|"无法打开原生归档")?;let mut zip=zip::ZipArchive::new(f).map_err(|_|"原生归档不是有效 ZIP")?;if zip.len()>30000{return Err("原生归档条目过多".into());}for i in 0..zip.len(){cancel.check()?;let mut entry=zip.by_index(i).map_err(|_|"读取原生条目失败")?;entries+=1;if entries>30000{return Err("原生归档总条目过多".into());}let name=entry.name().to_string();let relative=name.trim_end_matches('/');if relative.is_empty(){continue;}let p=inside(&staging,relative)?;if entry.unix_mode().is_some_and(|m|!matches!(m&0o170000,0|0o100000|0o040000)){return Err("原生归档包含链接或特殊文件".into());}if name.starts_with("META-INF/")||a.excludes.iter().any(|s|name.starts_with(s)){continue;}if let Some(records)=generated.as_deref_mut(){if relative.eq_ignore_ascii_case(".extract-stamp"){return Err("原生归档不能覆盖受控提取标记".into());}record_generated(records,Path::new(relative),entry.is_dir())?;}if entry.is_dir(){mkdir(&p)?;if let Some(records)=generated.as_deref_mut(){record_generated(records,Path::new(relative),true)?;}continue;}total=total.saturating_add(entry.size());if entry.size()>256*1024*1024||total>1024*1024*1024{return Err("原生解压超过大小上限".into());}mkdir(p.parent().ok_or("原生条目没有父目录")?)?;let mut f=OpenOptions::new().write(true).create(true).truncate(true).open(&p).map_err(|_|"无法写入原生条目")?;let expected=entry.size();let mut written=0u64;let mut buffer=[0u8;65536];loop{cancel.check()?;let n=entry.read(&mut buffer).map_err(|_|"原生条目解压或 CRC 校验失败")?;if n==0{break;}written+=n as u64;if written>expected{return Err("原生条目大小不一致".into());}f.write_all(&buffer[..n]).map_err(|_|"写入原生条目失败")?;}if written!=expected{return Err("原生条目不完整".into());}f.sync_all().map_err(|_|"提交原生条目失败")?;if let Some(records)=generated.as_deref_mut(){record_generated(records,Path::new(relative),false)?;}}}let outputs=native_outputs(&staging,cancel)?;if let Some(records)=generated.as_deref_mut(){if outputs.len()!=records.values().filter(|(_,directory)|!*directory).count()||outputs.iter().any(|row|records.get(&text(row,"path").to_lowercase()).map(|(path,directory)|(path.as_str(),*directory))!=Some((text(row,"path"),false))){return Err("原生目录出现本轮未登记的文件".into());}}let stamp=json!({"schema":1,"key":key,"outputs":outputs});atomic_json(&inside(&staging,".extract-stamp")?,&stamp,cancel)?;if let Some(records)=generated.as_deref_mut(){record_generated(records,Path::new(".extract-stamp"),false)?;}cancel.check()?;no_link(&target)?;if target.exists(){fs::rename(&target,&backup).map_err(|_|"无法备份旧原生输出")?;moved=true;}cancel.check()?;fs::rename(&staging,&target).map_err(|_|"无法提交新原生输出，旧输出备份保留")?;if moved{let _=fs::remove_dir_all(&backup);}Ok(())})();if result.is_err(){let _=fs::remove_dir_all(&staging);if moved&&!target.exists(){let _=fs::rename(&backup,&target);}}result?;Ok(target)}
// true 为目录；路径由写入点登记，不能扫描并接受未声明的第三方目录树。
type GeneratedPaths=BTreeMap<String,(String,bool)>;
fn record_generated(records:&mut GeneratedPaths,relative:&Path,directory:bool)->Result<()>{let mut prefix=PathBuf::new();let parts=relative.components().collect::<Vec<_>>();if parts.is_empty(){return Err("生成文件路径为空".into());}for (index,part) in parts.iter().enumerate(){let Component::Normal(name)=part else{return Err("生成文件路径越界".into());};identifier(name.to_str().ok_or("生成文件路径不是 UTF-8")?)?;prefix.push(name);let path=prefix.to_str().ok_or("生成文件路径不是 UTF-8")?.replace('\\',"/");let is_dir=index+1<parts.len()||directory;let key=path.to_lowercase();if records.get(&key).is_some_and(|(old,kind)|old!=&path||*kind!=is_dir){return Err("生成文件存在大小写或类型冲突".into());}records.insert(key,(path,is_dir));if records.len()>1_000_000{return Err("生成路径数量超过预算".into());}}Ok(())}
fn asset_tasks(index:&Value,root:&Path,settings:&Value)->Result<Vec<FileTask>>{let objects=index["objects"].as_object().ok_or("资源索引缺少 objects")?;if objects.len()>500000{return Err("资源对象数量超过上限".into());}let mut tasks=Vec::new();for(name,info)in objects{inside(root,Path::new("resources").join(name))?;let hash=checksum(text(info,"hash"),40)?;let size=info["size"].as_u64().filter(|n|*n<=FILE_LIMIT).ok_or("资源大小无效")?;let url=format!("https://resources.download.minecraft.net/{}/{}",&hash[..2],hash);tasks.push(FileTask::info(file_urls(&url,settings)?,inside(root,Path::new("assets/objects").join(&hash[..2]).join(&hash))?,&json!({"size":size,"sha1":hash}),format!("资源 {name}"),"assets")?);}Ok(tasks)}
fn map_assets(index:&Value,index_id:&str,root:&Path,cancel:&Cancel)->Result<()>{map_assets_to(index,index_id,root,root,cancel)}
fn map_assets_to(index:&Value,index_id:&str,root:&Path,run:&Path,cancel:&Cancel)->Result<()>{let virtual_assets=index["virtual"].as_bool().unwrap_or(false);let resources=index["map_to_resources"].as_bool().unwrap_or(false);if !virtual_assets&&!resources{return Ok(());}let objects=index["objects"].as_object().ok_or("资源索引缺少 objects")?;for(name,info)in objects{cancel.check()?;let hash=checksum(text(info,"hash"),40)?;let source=inside(root,Path::new("assets/objects").join(&hash[..2]).join(&hash))?;for relative in[virtual_assets.then(||Path::new("assets/virtual").join(index_id).join(name)),resources.then(||Path::new("resources").join(name))].into_iter().flatten(){let target=inside(if relative.starts_with("resources"){run}else{root},relative)?;let t=FileTask::info(Vec::new(),target.clone(),&json!({"size":info["size"],"sha1":hash}),name.into(),"assets")?;if satisfied(&t,cancel)?{continue;}let expected=FileTask::info(Vec::new(),source.clone(),&json!({"size":info["size"],"sha1":hash}),name.into(),"assets")?;if !satisfied(&expected,cancel)?{return Err("资源映射源文件校验失败".into());}copy_checked(&source,&target,cancel)?;if !satisfied(&t,cancel)?{return Err("资源映射目标校验失败".into());}}}Ok(())}
async fn install_with_publish(network:&Network,mut version:Value,root:&Path,settings:&Value,cancel:Arc<Cancel>,progress:&Progress,publish:bool)->Result<Value>{let id=identifier(text(&version,"id"))?.to_string();let mut plan=collect_plan(&version,root,settings)?;let mut index_json=None;if !plan.index.is_empty(){let info=&version["assetIndex"];let path=inside(root,Path::new("assets/indexes").join(format!("{}.json",plan.index)))?;let urls=if text(info,"url").is_empty(){Vec::new()}else{file_urls(text(info,"url"),settings)?};let mut t=FileTask::info(urls,path.clone(),info,format!("资源索引 {}",plan.index),"assets")?;t.local_only=t.urls.is_empty();progress.register(&[t.clone()]);download_one(network,t,settings,&cancel,progress).await?;let data=read_json(&path)?;plan.tasks.extend(asset_tasks(&data,root,settings)?);index_json=Some(data);}batch(network,plan.tasks,settings,cancel.clone(),progress).await?;cancel.check()?;let native_root=root.to_path_buf();let native_id=id.clone();let native_files=plan.natives.clone();let c=cancel.clone();tokio::task::spawn_blocking(move||extract_natives(&native_root,&native_id,&native_files,&c)).await.map_err(|_|"原生解压工作异常")??;if let Some(data)=index_json{let root=root.to_path_buf();let index=plan.index.clone();let c=cancel.clone();tokio::task::spawn_blocking(move||map_assets(&data,&index,&root,&c)).await.map_err(|_|"资源映射工作异常")??;}cancel.check()?;let base=if text(&version,"clientVersion").is_empty(){id.clone()}else{text(&version,"clientVersion").to_string()};version["clientVersion"]=json!(base);if let Some(map)=version.as_object_mut(){map.remove("inheritsFrom");}if publish { atomic_json(&version_path(root,&id)?,&version,&cancel)?; } Ok(json!({"versionId":id,"assetIndex":plan.index,"nativePlatform":if cfg!(target_os="android"){"android-unadapted"}else{os_name()},"desktopNativesSkipped":plan.android_natives_skipped}))}
async fn install(network:&Network,version:Value,root:&Path,settings:&Value,cancel:Arc<Cancel>,progress:&Progress)->Result<Value>{ install_with_publish(network,version,root,settings,cancel,progress,true).await }

pub(crate) fn operation_root(game_dir:&Path)->Result<PathBuf>{checked_root(game_dir)}

fn forge_repository(kind:&str)->Result<(&'static str,&'static str)>{match kind{"forge"=>Ok(("https://maven.minecraftforge.net/net/minecraftforge/forge","forge")),"neoforge"=>Ok(("https://maven.neoforged.net/releases/net/neoforged/neoforge","neoforge")),_=>Err("未知 Forge 加载器类型".into())}}
/// 仅可构造官方 Forge Maven 地址，不接收页面 URL。
pub(crate) async fn forge_metadata(kind:&str,root:&Path,settings:&Value,cancel:&Cancel)->Result<String>{let(base,_)=forge_repository(kind)?;let path=inside(root,Path::new(".hcmcl-cache/forge").join(kind).join("maven-metadata.xml"))?;if path.is_file(){let fresh=fs::metadata(&path).ok().and_then(|m|m.modified().ok()).and_then(|t|t.elapsed().ok()).is_some_and(|d|d<Duration::from_secs(300));if local(settings)||fresh{return String::from_utf8(read_bounded(&path,JSON_LIMIT)?).map_err(|_|"Maven XML 不是 UTF-8".into());}}if local(settings){return Err("本地模式没有 Forge 版本清单缓存".into());}let bytes=fetch_bytes(&Network::production()?,&[format!("{base}/maven-metadata.xml")],None,JSON_LIMIT,cancel).await?;let text=String::from_utf8(bytes.clone()).map_err(|_|"Maven XML 不是 UTF-8")?;atomic_bytes(&path,&bytes,cancel)?;Ok(text)}
pub(crate) async fn forge_installer(kind:&str,version:&str,root:&Path,settings:&Value,cancel:&Cancel,progress:&Progress)->Result<(PathBuf,String)>{identifier(version)?;let(base,artifact)=forge_repository(kind)?;let url=format!("{base}/{version}/{artifact}-{version}-installer.jar");let path=inside(root,Path::new(".installers").join(format!("{kind}-{version}-installer.jar")))?;let record=inside(root,Path::new(".hcmcl-cache/forge").join(kind).join(format!("{version}.installer-sha1.json")))?;verified_installer_download(&Network::production()?,&url,&path,&record,settings,cancel,progress).await}
async fn verified_installer_download(network:&Network,url:&str,path:&Path,record:&Path,settings:&Value,cancel:&Cancel,progress:&Progress)->Result<(PathBuf,String)>{network.url(url)?;absolute(path)?;absolute(record)?;let digest=if local(settings){let v=read_json(&record)?;if text(&v,"url")!=url{return Err("安装器缓存摘要来源不匹配".into());}checksum(text(&v,"sha1"),40)?}else{let bytes=fetch_bytes(&network,&[format!("{url}.sha1")],None,1024,cancel).await?;let value=std::str::from_utf8(&bytes).map_err(|_|"官方安装器摘要不是 UTF-8")?.split_whitespace().next().ok_or("官方安装器摘要为空")?;let digest=checksum(value,40)?;atomic_json(&record,&json!({"url":url,"sha1":digest}),cancel)?;digest};let task=FileTask::info(vec![url.to_string()],path.to_path_buf(),&json!({"sha1":digest}),"下载安装器（官方摘要）".into(),"mod")?;progress.register(&[task.clone()]);download_one(network,task,settings,cancel,progress).await?;verify_installer(path,&digest,cancel)?;Ok((path.to_path_buf(),digest))}
pub(crate) fn verify_installer(path:&Path,digest:&str,cancel:&Cancel)->Result<()>{let expected=checksum(digest,40)?;let(actual,_,size)=file_hashes(path,cancel)?;if actual!=expected||size==0||size>512*1024*1024{return Err("安装器大小或官方摘要校验失败".into());}Ok(())}
/// 分块复制到同卷临时文件并重算源/目标摘要；不创建硬链接，以免安装器修改真实依赖。
pub(crate) fn copy_checked(source:&Path,target:&Path,cancel:&Cancel)->Result<()>{absolute(source)?;absolute(target)?;let before=file_hashes(source,cancel)?;if !fs::metadata(source).map_err(|_|"复制源不存在")?.is_file(){return Err("复制源不是普通文件".into());}if target.is_file()&&file_hashes(target,cancel)?==before{return Ok(());}let parent=target.parent().ok_or("复制目标缺少父目录")?;mkdir(parent)?;let mut temporary=TempPath{path:inside(parent,format!(".hcmcl-copy-{}.part",uuid::Uuid::new_v4()))?,committed:false};let mut input=File::open(source).map_err(|_|"无法打开复制源")?;let mut output=OpenOptions::new().write(true).create_new(true).open(&temporary.path).map_err(|_|"无法创建复制临时文件")?;let mut buf=[0u8;65536];loop{cancel.check()?;let n=input.read(&mut buf).map_err(|_|"读取复制源失败")?;if n==0{break;}output.write_all(&buf[..n]).map_err(|_|"写入复制目标失败")?;}output.sync_all().map_err(|_|"提交复制文件失败")?;drop(output);if file_hashes(&temporary.path,cancel)?!=before||file_hashes(source,cancel)?!=before{return Err("复制期间源文件变化或目标摘要错误".into());}cancel.check()?;replace_file(&temporary.path,target)?;temporary.committed=true;Ok(())}
/// 原版文件可写入共享下载缓存；不提前改写目标 JSON 或 natives，保留就地安装回滚边界。
pub(crate) async fn prepare_installer_base_under_guard(base:&Value,root:&Path,settings:&Value,cancel:Arc<Cancel>,progress:&Progress)->Result<()>{prepare_installer_base(base,root,settings,cancel,progress,true).await}
/// 整包只准备共享内容；旧 resources 必须在实例 Stage 中映射。
pub(crate) async fn prepare_pack_base_under_guard(base:&Value,root:&Path,settings:&Value,cancel:Arc<Cancel>,progress:&Progress)->Result<()>{prepare_installer_base(base,root,settings,cancel,progress,false).await}
async fn prepare_installer_base(base:&Value,root:&Path,settings:&Value,cancel:Arc<Cancel>,progress:&Progress,resources:bool)->Result<()>{let network=Network::production()?;let mut plan=collect_plan(base,root,settings)?;let mut mapping=None;if !plan.index.is_empty(){let info=&base["assetIndex"];let path=inside(root,Path::new("assets/indexes").join(format!("{}.json",plan.index)))?;let mut task=FileTask::info(if text(info,"url").is_empty(){Vec::new()}else{file_urls(text(info,"url"),settings)?},path.clone(),info,"准备原版资源索引".into(),"assets")?;task.local_only=task.urls.is_empty();progress.register(&[task.clone()]);download_one(&network,task,settings,&cancel,progress).await?;let index=read_json(&path)?;plan.tasks.extend(asset_tasks(&index,root,settings)?);mapping=Some(index);}batch(&network,plan.tasks,settings,cancel.clone(),progress).await?;if let Some(index)=mapping{let root=root.to_path_buf();let id=plan.index;let c=cancel.clone();tokio::task::spawn_blocking(move||{let mut index=index;if !resources{index["map_to_resources"]=json!(false);}map_assets(&index,&id,&root,&c)}).await.map_err(|_|"原版资源映射任务异常")??;}cancel.check()}
pub(crate) async fn complete_staged_libraries_under_guard(profile:&Value,staging:&Path,settings:&Value,cancel:Arc<Cancel>,progress:&Progress)->Result<()>{let plan=collect_plan(profile,staging,settings)?;let tasks=plan.tasks.into_iter().filter(|task|task.path.strip_prefix(staging).is_ok_and(|relative|relative.starts_with("libraries"))).collect();batch(&Network::production()?,tasks,settings,cancel,progress).await}
pub(crate) fn seed_installer_base(base:&Value,root:&Path,staging:&Path,settings:&Value,cancel:&Cancel)->Result<()>{let plan=collect_plan(base,root,settings)?;for task in plan.tasks{cancel.check()?;if !satisfied(&task,cancel)?{return Err(format!("安装器前置依赖未就绪：{}",task.label));}let relative=task.path.strip_prefix(root).map_err(|_|"安装器前置路径越界")?;copy_checked(&task.path,&inside(staging,relative)?,cancel)?;}let id=identifier(text(base,"id"))?;atomic_json(&version_path(staging,id)?,base,cancel)?;atomic_json(&inside(staging,"launcher_profiles.json")?,&json!({"profiles":{}}),cancel)}
pub(crate) async fn prefetch_forge_mappings(base:&Value,coordinate:Option<&str>,staging:&Path,settings:&Value,cancel:&Cancel,progress:&Progress)->Result<bool>{let info=&base["downloads"]["client_mappings"];if text(info,"url").is_empty(){return Ok(false);}let relative=if !text(info,"path").is_empty(){PathBuf::from(text(info,"path"))}else if let Some(coordinate)=coordinate{maven_path(coordinate,None)?}else{return Ok(false)};let path=inside(staging,Path::new("libraries").join(relative))?;let task=FileTask::info(file_urls(text(info,"url"),settings)?,path,info,"预置 Mojang mappings".into(),"mod")?;progress.register(&[task.clone()]);download_one(&Network::production()?,task,settings,cancel,progress).await?;Ok(true)}
pub(crate) fn promote_staged_libraries(profile:&Value,staging:&Path,root:&Path,settings:&Value,cancel:&Cancel)->Result<()>{let plan=collect_plan(profile,staging,settings)?;for task in plan.tasks{let relative=task.path.strip_prefix(staging).map_err(|_|"安装器依赖路径越界")?;if !relative.starts_with("libraries"){continue;}if !satisfied(&task,cancel)?{return Err(format!("安装器生成依赖未通过校验：{}",task.label));}copy_checked(&task.path,&inside(root,relative)?,cancel)?;}Ok(())}
pub(crate) fn write_json(path:&Path,value:&Value,cancel:&Cancel)->Result<()>{atomic_json(path,value,cancel)}
pub(crate) fn write_bytes(path:&Path,bytes:&[u8],cancel:&Cancel)->Result<()>{atomic_bytes(path,bytes,cancel)}

fn checked_root(game_dir:&Path)->Result<PathBuf>{let root=absolute(game_dir)?;mkdir(&root)?;let canonical=fs::canonicalize(&root).map_err(|_|"无法规范化游戏目录")?;absolute(&canonical)}
fn optional_directory(args:&[Value],index:usize,settings:&Value,root:&Path)->Result<()> {let Some(value)=args.get(index).filter(|v|!v.is_null())else{return Ok(())};let id=value.as_str().ok_or("版本目录标识必须是字符串")?;if id.is_empty(){return Ok(());}identifier(id)?;let expected=if id=="default"{let configured=if text(settings,"gameDirAbs").is_empty(){text(settings,"gameDir")}else{text(settings,"gameDirAbs")};let path=PathBuf::from(configured);if !path.is_absolute(){return Err("默认游戏目录必须是可信绝对路径".into());}path}else{let d=settings["versionDirs"].as_array().and_then(|a|a.iter().find(|d|text(d,"id")==id)).ok_or("版本目录不存在")?;PathBuf::from(text(d,"path"))};if fs::canonicalize(absolute(&expected)?).map_err(|_|"版本目录不存在")?!=checked_root(root)?{return Err("宿主传入的可信游戏目录与 dirId 不匹配".into());}Ok(())}
/// 返回当前 Tauri 下载后端的兼容状态；不探测网络、设置或可选原生模块。
/// `available` 与 `path` 保留 Electron 可选 `.node` 引擎语义，Rust 后端通过
/// `backend` 单独标识，避免把内置传输误报为可加载的 Node 原生模块。
pub(crate) fn engine_call(channel:&str,args:&[Value])->Result<Option<Value>> {
    if channel != "download:engine" { return Ok(None); }
    if !args.is_empty() {
        return Err("download:engine 参数数量不符 / download:engine 參數數量不符 / download:engine expects no arguments".into());
    }
    Ok(Some(json!({
        "available": false,
        "path": null,
        "backend": "tauri-rust",
        "platform": engine_platform(),
    })))
}

fn engine_platform()->String {
    // 必须按 Rust 编译目标报告平台；Android/iOS 不是 Linux/桌面目标的别名。
    let os = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        "android" => "android",
        "ios" => "ios",
        "linux" => "linux",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86" => "ia32",
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "arm" => "arm",
        other => other,
    };
    format!("{os}-{arch}")
}

/// 宿主先根据 dirId 解析可信绝对目录；事件必须只发送给可信 main 窗口。
/// 返回 None 仅表示未接管（例如加载器）；不能据此宣称安装成功。
pub async fn call(app:&tauri::AppHandle,channel:&str,args:&[Value],settings:&Value,game_dir:&Path)->Result<Option<Value>>{
    if channel=="download:cancel"{let id=cancel_id(args)?;#[cfg(target_os="android")]let export_result=crate::mobile_files::cancel_download(app,id);#[cfg(not(any(target_os="android",target_os="ios")))]let export_result=crate::desktop::cancel_download(app,id);let modpack_result=crate::modpack::cancel_download(id);let external_result=crate::external_versions::cancel_download(id);let resource_result=crate::resource_updates::cancel_download(id);let catalog_result=crate::catalog::install::cancel_download(id);cancel_jobs(id)?;modpack_result?;external_result?;resource_result?;catalog_result?;#[cfg(not(target_os="ios"))]export_result?;return Ok(Some(json!(true)));}
    if channel!="download:install"&&channel!="versions:createVanilla"{return Ok(None);}let create=channel=="versions:createVanilla";let min=if create{2}else{1};if args.len()<min||args.len()>min+1{return Err("原版安装调用参数数量不符".into());}let id=args.first().and_then(Value::as_str).ok_or("版本标识必须为字符串")?;identifier(id)?;let root=checked_root(game_dir)?;optional_directory(args,min,settings,&root)?;
    if create{let name=args.get(1).and_then(Value::as_str).ok_or("自定义实例名必须为字符串")?;identifier(name)?;if name==id{return Ok(Some(Value::Null));}let cancel=Cancel::default();let _guard=install_lock::acquire(&root,||cancel.stopped.load(Ordering::Acquire)).await?;let path=version_path(&root,name)?;if path.exists(){return Err(format!("版本名「{name}」已存在"));}atomic_json(&path,&json!({"id":name,"inheritsFrom":id}),&cancel)?;return Ok(Some(Value::Null));}
    let registration=JobGuard::register(&root,id)?;let cancel=registration.job.cancel.clone();let app=app.clone();let sink:Arc<dyn Fn(Value)+Send+Sync>=Arc::new(move|payload|{let _=app.emit_to("main","launcher:event",json!({"channel":"download:progress","payload":payload}));});let progress=Progress::new(id.into(),id.into(),sink);let id=id.to_string();let settings=settings.clone();let _cancel_on_drop=CancelOnDrop(cancel.clone());let worker=tokio::spawn(async move{let result=async{let _guard=install_lock::acquire(&root,||cancel.stopped.load(Ordering::Acquire)).await?;let network=Network::production()?;let version=resolve(&network,&id,&root,&settings,&cancel).await?;install(&network,version,&root,&settings,cancel.clone(),&progress).await}.await;registration.complete(result.as_ref().map(|_|()).map_err(Clone::clone));progress.finish(result.is_ok());result});worker.await.map_err(|_|"原版安装后台任务异常结束".to_string())?.map(Some)
}

#[cfg(test)]mod tests{
    use super::*;
    use std::{net::{TcpListener,TcpStream},sync::atomic::{AtomicUsize,Ordering},thread};
    #[test]
    fn relaunch_readiness_requires_an_empty_owned_job_table_without_cancelling_or_clearing() {
        let registry=Mutex::new(HashMap::new());
        assert!(relaunch_ready_from(None).is_ok());assert!(relaunch_ready_from(Some(&registry)).is_ok());
        let (completion,_)=tokio::sync::watch::channel(None);let job=Arc::new(Job{cancel:Arc::new(Cancel::default()),id:"fixture".into(),completion});
        registry.lock().unwrap().insert("root|fixture".into(),job.clone());
        assert!(relaunch_ready_from(Some(&registry)).is_err());assert!(job.cancel.check().is_ok());
        job.completion.send_replace(Some(Ok(())));
        assert!(relaunch_ready_from(Some(&registry)).is_err(),"完成信号不能替代 owner 归还");
        assert!(job.cancel.check().is_ok());assert_eq!(registry.lock().unwrap().len(),1);
        registry.lock().unwrap().clear();assert!(relaunch_ready_from(Some(&registry)).is_ok());
    }
    #[test]
    fn relaunch_readiness_fails_closed_for_busy_or_poisoned_job_registry() {
        let registry=Mutex::new(HashMap::new());let held=registry.lock().unwrap();
        assert!(relaunch_ready_from(Some(&registry)).is_err());drop(held);
        assert!(relaunch_ready_from(Some(&registry)).is_ok());
        let poisoned=Mutex::new(HashMap::new());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||{let _held=poisoned.lock().unwrap();panic!("夹具模拟下载状态损坏");})).is_err());
        assert!(relaunch_ready_from(Some(&poisoned)).is_err());
    }
    #[test]
    fn engine_status_preserves_node_contract_without_probe() {
        let value = engine_call("download:engine", &[]).unwrap().unwrap();
        assert_eq!(value["available"], Value::Bool(false));
        assert!(value["path"].is_null());
        assert_eq!(value["backend"], "tauri-rust");
        let platform = value["platform"].as_str().unwrap();
        let expected_os = match std::env::consts::OS {
            "windows" => "win32",
            "macos" => "darwin",
            "android" => "android",
            "ios" => "ios",
            "linux" => "linux",
            other => other,
        };
        let expected_arch = match std::env::consts::ARCH {
            "x86" => "ia32",
            "x86_64" => "x64",
            "aarch64" => "arm64",
            "arm" => "arm",
            other => other,
        };
        assert_eq!(platform, format!("{expected_os}-{expected_arch}"));
    }
    #[test]
    fn engine_status_rejects_arguments_and_ignores_other_channels() {
        assert!(engine_call("download:engine", &[json!("unexpected")]).is_err());
        assert!(engine_call("download:engine", &[Value::Null]).is_err());
        assert_eq!(engine_call("download:install", &[]).unwrap(), None);
        assert_eq!(engine_call("versions:createVanilla", &[json!("id")]).unwrap(), None);
    }
    struct Temp{root:PathBuf}
    impl Temp{fn new()->Self{let root=std::env::temp_dir().join(format!("hcmcl-download-fixture-{}",uuid::Uuid::new_v4()));fs::create_dir_all(&root).unwrap();Self{root:fs::canonicalize(root).unwrap()}}}
    impl Drop for Temp{fn drop(&mut self){let _=fs::remove_dir_all(&self.root);}}
    fn network()->Network{Network{client:reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(2)).timeout(Duration::from_secs(5)).build().unwrap(),loopback:true}}
    fn progress()->(Progress,Arc<Mutex<Vec<Value>>>){let events=Arc::new(Mutex::new(Vec::new()));let sink=events.clone();(Progress::new("fixture".into(),"fixture".into(),Arc::new(move|v|sink.lock().unwrap().push(v))),events)}
    struct HttpFixture{address:String,stopped:Arc<AtomicBool>,requests:Arc<AtomicUsize>,active:Arc<AtomicUsize>,peak:Arc<AtomicUsize>,ranges:Arc<AtomicUsize>,worker:Option<thread::JoinHandle<()>>}
    fn answer(mut stream:TcpStream,bodies:Arc<BTreeMap<String,Vec<u8>>>,requests:Arc<AtomicUsize>,active:Arc<AtomicUsize>,peak:Arc<AtomicUsize>,ranges:Arc<AtomicUsize>){stream.set_nonblocking(false).unwrap();stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();let mut req=Vec::new();let mut b=[0u8;1024];while req.len()<16384{match stream.read(&mut b){Ok(0)|Err(_)=>return,Ok(n)=>{req.extend_from_slice(&b[..n]);if req.windows(4).any(|w|w==b"\r\n\r\n"){break;}}}}let raw=String::from_utf8_lossy(&req);let path=raw.lines().next().and_then(|l|l.split_whitespace().nth(1)).unwrap_or("/");let count=requests.fetch_add(1,Ordering::SeqCst)+1;let current=active.fetch_add(1,Ordering::SeqCst)+1;peak.fetch_max(current,Ordering::SeqCst);thread::sleep(Duration::from_millis(70));let bytes=bodies.get(path).cloned().unwrap_or_default();let mut offset=0usize;let mut end_bound:Option<usize>=None;let mut has_range=false;for line in raw.lines(){if let Some(range)=line.to_ascii_lowercase().strip_prefix("range: bytes="){has_range=true;let mut parts=range.split('-');offset=parts.next().unwrap_or("0").parse().unwrap_or(0);end_bound=parts.next().and_then(|v|if v.is_empty(){None}else{v.parse().ok()});ranges.fetch_add(1,Ordering::SeqCst);}}let partial=path=="/resume"&&count==1;let status=if !bodies.contains_key(path){404}else if has_range{206}else{200};let full=bytes.len();let start=offset.min(full);let body=if partial{&bytes[..full/2]}else if start>=full{&bytes[..0]}else{&bytes[start..=end_bound.map(|end|end.min(full-1)).unwrap_or(full-1)]};let range=if offset>0{format!("Content-Range: bytes {}-{}/{}
",start,start+body.len().saturating_sub(1),full)}else{String::new()};let header=format!("HTTP/1.1 {status} fixture\r\nContent-Length: {}\r\nETag: \"fixture-stable\"\r\n{range}Connection: close\r\n\r\n",if partial{full}else{body.len()});let _=stream.write_all(header.as_bytes());let _=stream.write_all(body);let _=stream.flush();active.fetch_sub(1,Ordering::SeqCst);}
    impl HttpFixture {
        fn new(bodies: BTreeMap<String, Vec<u8>>) -> Self { Self::with_bodies(|_| bodies) }
        fn with_bodies(make: impl FnOnce(&str) -> BTreeMap<String, Vec<u8>>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let address = format!("http://{}", listener.local_addr().unwrap());
            let bodies = Arc::new(make(&address));
            let stopped = Arc::new(AtomicBool::new(false));
            let requests = Arc::new(AtomicUsize::new(0));
            let active = Arc::new(AtomicUsize::new(0));
            let peak = Arc::new(AtomicUsize::new(0));
            let ranges = Arc::new(AtomicUsize::new(0));
            let (stop, req, act, pk, rg) = (stopped.clone(), requests.clone(), active.clone(), peak.clone(), ranges.clone());
            let worker = thread::spawn(move || {
                let mut clients = Vec::new();
                while !stop.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((s, _)) => {
                            let (b, r, a, p, g) = (bodies.clone(), req.clone(), act.clone(), pk.clone(), rg.clone());
                            clients.push(thread::spawn(move || answer(s, b, r, a, p, g)));
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(2)),
                        Err(_) => break,
                    }
                }
                for c in clients { let _ = c.join(); }
            });
            Self { address, stopped, requests, active, peak, ranges, worker: Some(worker) }
        }
        fn url(&self, path: &str) -> String { format!("{}{path}", self.address) }
        fn request_count(&self) -> usize { self.requests.load(Ordering::SeqCst) }
    }
    impl Drop for HttpFixture{fn drop(&mut self){self.stopped.store(true,Ordering::SeqCst);if let Some(w)=self.worker.take(){w.join().unwrap();}}}
    fn task(server:&HttpFixture,root:&Path,name:&str,body:&[u8])->FileTask{FileTask::info(vec![server.url(&format!("/{name}"))],root.join(name),&json!({"sha1":hex_sha1(body),"size":body.len()}),name.into(),"libraries").unwrap()}
    fn zip(path:&Path,entries:&[(&str,&[u8])]){let mut z=zip::ZipWriter::new(File::create(path).unwrap());for(name,body)in entries{z.start_file(*name,zip::write::FileOptions::default()).unwrap();z.write_all(body).unwrap();}z.finish().unwrap();}
    #[tokio::test]
    async fn pack_build_stages_natives_and_legacy_resources_with_exact_receipts(){
        let t=Temp::new();let stage=t.root.join("versions").join(format!(".hcmcl-modpack-stage-{}",uuid::Uuid::new_v4()));mkdir(&stage).unwrap();fs::write(stage.join(".hcmcl-modpack-stage-owner"),b"owned").unwrap();let c=Cancel::default();let client=b"base-client";atomic_bytes(&t.root.join("versions/base/base.jar"),client,&c).unwrap();
        let jar=t.root.join("libraries/x/native/1/native-1-natives-fixture.jar");mkdir(jar.parent().unwrap()).unwrap();zip(&jar,&[("dir/native.bin",b"native"),("META-INF/no",b"skip")]);let(native_sha,_,native_size)=file_hashes(&jar,&c).unwrap();
        let asset=b"legacy-asset";let hash=hex_sha1(asset);atomic_bytes(&t.root.join(format!("assets/objects/{}/{hash}",&hash[..2])),asset,&c).unwrap();let index=json!({"virtual":true,"map_to_resources":true,"objects":{"dir/file":{"hash":hash,"size":asset.len()}}});let index_bytes=serde_json::to_vec(&index).unwrap();atomic_bytes(&t.root.join("assets/indexes/legacy.json"),&index_bytes,&c).unwrap();
        let version=json!({"id":"named","clientVersion":"base","mainClass":"net.minecraft.client.main.Main","arguments":{"jvm":["-cp","${classpath}"],"game":["--gameDir","${game_directory}"]},"libraries":[{"name":"x:native:1:natives-fixture","downloads":{"artifact":{"path":"x/native/1/native-1-natives-fixture.jar","url":"","sha1":native_sha,"size":native_size}}}],"downloads":{"client":{"sha1":hex_sha1(client),"size":client.len()}},"assetIndex":{"id":"legacy","sha1":hex_sha1(&index_bytes),"size":index_bytes.len()}});
        let(p,events)=progress();let result=build_instance(&network(),version,&t.root,&stage,&json!({"mode":"local"}),Arc::new(Cancel::default()),&p).await.unwrap();
        assert_eq!(result.profile["id"],"named");assert_eq!(result.profile["jar"],"base");assert_eq!(result.profile["clientVersion"],"base");assert!(result.profile.get("inheritsFrom").is_none());assert!(!t.root.join("versions/named").exists());assert!(!stage.join("named.json").exists());assert!(!t.root.join("resources").exists());assert_eq!(fs::read(stage.join("resources/dir/file")).unwrap(),asset);assert_eq!(fs::read(t.root.join("assets/virtual/legacy/dir/file")).unwrap(),asset);
        let expected=if cfg!(target_os="android"){vec!["natives/.extract-stamp","resources/dir/file"]}else{vec!["natives/.extract-stamp","natives/dir/native.bin","resources/dir/file"]};let names=result.files.iter().map(|f|f.path.as_str()).collect::<Vec<_>>();assert_eq!(names,expected);assert!(result.directories.contains(&"natives".into()));assert!(!result.files.iter().any(|f|f.path.contains("owner")));
        for file in &result.files{let(_,hash,size)=file_hashes(&stage.join(&file.path),&c).unwrap();assert_eq!((file.sha256.as_str(),file.size),(hash.as_str(),size));}assert!(events.lock().unwrap().iter().all(|event|event["phase"]!="done"&&event["percent"].as_f64().unwrap_or(0.0)<100.0));reject_profile_path(&result.profile,&stage).unwrap();
    }
    #[tokio::test]
    async fn pack_build_rejects_real_target_bad_jar_and_reserved_output_before_writes(){
        let t=Temp::new();let stage=t.root.join("versions").join(format!(".hcmcl-modpack-stage-{}",uuid::Uuid::new_v4()));mkdir(&stage).unwrap();let target=t.root.join("versions/named");mkdir(&target).unwrap();assert!(instance_build_paths(&t.root,&target).is_err());assert!(instance_build_paths(&t.root,&t.root).is_err());assert!(instance_build_paths(&t.root,&stage).is_ok());
        let profile=json!({"id":"named","clientVersion":"base","jar":"other","libraries":[]});let(p,_)=progress();assert!(build_instance(&network(),profile,&t.root,&stage,&json!({"mode":"local"}),Arc::new(Cancel::default()),&p).await.is_err());assert!(!stage.join("natives").exists());assert!(instance_profile(json!({"id":"base","clientVersion":"base"})).is_err());assert!(instance_profile(json!({"id":"named","inheritsFrom":"base"})).is_err());
        let stopped=Arc::new(Cancel::default());stopped.stop();assert!(build_instance(&network(),json!({"id":"named","clientVersion":"base"}),&t.root,&stage,&json!({"mode":"local"}),stopped,&p).await.is_err());assert!(!stage.join("natives").exists());mkdir(&stage.join("resources")).unwrap();assert!(instance_build_paths(&t.root,&stage).is_err());
        let unsafe_profile=json!({"arguments":{"jvm":[format!("-Dnative={}",stage.display())]}});assert!(reject_profile_path(&unsafe_profile,&stage).is_err());
    }
    #[test]
    fn pack_native_receipts_reject_aliases_and_host_stamp(){
        let t=Temp::new();let jar=t.root.join("bad-native.jar");zip(&jar,&[("Native.bin",b"a"),("native.bin",b"b")]);let c=Cancel::default();let mut records=BTreeMap::new();let archives=[NativeArchive{path:jar.clone(),excludes:Vec::new()}];assert!(extract_natives_recorded(&t.root.join("output"),&archives,&c,Some(&mut records)).is_err());assert!(!t.root.join("output").exists());
        zip(&jar,&[(".extract-stamp",b"forged")]);assert!(extract_natives_recorded(&t.root.join("output"),&archives,&c,Some(&mut BTreeMap::new())).is_err());assert!(!t.root.join("output").exists());
        let mut records=BTreeMap::new();record_generated(&mut records,Path::new("resources/a"),false).unwrap();assert!(record_generated(&mut records,Path::new("resources/a/b"),false).is_err());assert!(record_generated(&mut records,Path::new("Resources/B"),false).is_err());
    }
    #[test]
    fn cancel_arguments_and_registration_remain_strict_until_worker_finishes() {
        assert_eq!(cancel_id(&[]).unwrap(), None);
        assert_eq!(cancel_id(&[Value::Null]).unwrap(), None);
        assert_eq!(cancel_id(&[json!("")]).unwrap(), None);
        let capability = format!("hcmcl-save:{}", uuid::Uuid::new_v4());
        let args = [json!(capability)];
        assert_eq!(cancel_id(&args).unwrap(), Some(capability.as_str()));
        for args in [vec![json!(true)], vec![json!(1)], vec![json!("bad\n")], vec![json!("x".repeat(513))], vec![json!("id"), Value::Null]] {
            assert!(cancel_id(&args).is_err());
        }
        let temporary = Temp::new();
        let first_id = format!("cancel-fixture-{}", uuid::Uuid::new_v4());
        let second_id = format!("cancel-fixture-{}", uuid::Uuid::new_v4());
        let first = JobGuard::register(&temporary.root, &first_id).unwrap();
        let second = JobGuard::register(&temporary.root, &second_id).unwrap();
        cancel_jobs(Some(&first_id)).unwrap();
        assert!(first.cancel().check().is_err());
        assert!(second.cancel().check().is_ok());
        assert!(JobGuard::register(&temporary.root, &first_id).is_err());
        drop(first);
        assert!(JobGuard::register(&temporary.root, &first_id).is_ok());
    }
    #[tokio::test]
    async fn chunk_write_waits_for_pending_flush_even_after_cancel_or_write_error() {
        struct DeferredWrite {
            worker: Option<tokio::task::JoinHandle<std::io::Result<()>>>,
            fail_write: bool,
        }
        impl tokio::io::AsyncWrite for DeferredWrite {
            fn poll_write(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>, bytes: &[u8]) -> std::task::Poll<std::io::Result<usize>> {
                std::task::Poll::Ready(if self.fail_write { Err(std::io::Error::other("fixture write failure")) } else { Ok(bytes.len()) })
            }
            fn poll_flush(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
                use std::future::Future;
                let Some(worker)=self.worker.as_mut() else { return std::task::Poll::Ready(Ok(())); };
                match std::pin::Pin::new(worker).poll(cx) {
                    std::task::Poll::Pending=>std::task::Poll::Pending,
                    std::task::Poll::Ready(result)=>{self.worker=None; std::task::Poll::Ready(result.unwrap())},
                }
            }
            fn poll_shutdown(self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> { self.poll_flush(cx) }
        }
        for fail_write in [false,true] {
            let temporary=Temp::new(); let path=temporary.root.join("flush-owned"); let mut file=File::create(&path).unwrap();
            let (release,wait)=std::sync::mpsc::channel(); let (started,ready)=tokio::sync::oneshot::channel();
            let worker=tokio::task::spawn_blocking(move || { let _=started.send(()); wait.recv_timeout(Duration::from_secs(3)).unwrap(); file.write_all(b"owned bytes")?; file.flush()?; file.sync_all() });
            let cancel=Arc::new(Cancel::default()); let observed=cancel.clone();
            let task=tokio::spawn(async move {
                let mut writer=DeferredWrite{worker:Some(worker),fail_write};
                let result=write_download_chunk(&mut writer,b"owned bytes").await;
                (result,observed.check())
            });
            tokio::time::timeout(Duration::from_secs(2),ready).await.unwrap().unwrap();
            cancel.stop(); tokio::task::yield_now().await;
            let pending_before_release=!task.is_finished();
            release.send(()).unwrap();
            let (written,cancelled)=tokio::time::timeout(Duration::from_secs(2),task).await.unwrap().unwrap();
            assert!(pending_before_release,"取消或 write_all 错误不能跳过正在进行的 flush");
            assert_eq!(written.is_err(),fail_write); assert!(cancelled.is_err());
            assert_eq!(fs::read(path).unwrap(),b"owned bytes");
        }
    }
    #[tokio::test]
    async fn completion_watch_waits_for_real_outcome_before_root_lock() {
        let t=Temp::new();let guard=install_lock::acquire(&t.root,||false).await.unwrap();
        let registration=JobGuard::register(&t.root,"vanilla-watch").unwrap();let root=t.root.clone();let cancel=Arc::new(Cancel::default());let c=cancel.clone();
        let waiter=tokio::spawn(async move{wait_for_install(&root,"vanilla-watch",&c).await});
        tokio::time::sleep(Duration::from_millis(30)).await;assert!(!waiter.is_finished());
        registration.complete(Ok(()));assert!(tokio::time::timeout(Duration::from_secs(1),waiter).await.unwrap().unwrap().unwrap());drop(registration);drop(guard);
        let registration=JobGuard::register(&t.root,"failed-watch").unwrap();registration.complete(Err("vanilla failure".into()));
        assert_eq!(wait_for_install(&t.root,"failed-watch",&Cancel::default()).await.unwrap_err(),"vanilla failure");drop(registration);
        let registration=JobGuard::register(&t.root,"cancel-watch").unwrap();let stopped=Cancel::default();stopped.stop();assert!(wait_for_install(&t.root,"cancel-watch",&stopped).await.is_err());drop(registration);
        assert!(!wait_for_install(&t.root,"absent-watch",&Cancel::default()).await.unwrap());
    }
    #[tokio::test]
    async fn executable_installer_requires_official_digest_and_rechecks_cache() {
        let t=Temp::new();let bytes=b"PK\x03\x04trusted-installer";let hash=hex_sha1(bytes);let server=HttpFixture::new(BTreeMap::from([("/installer.jar".into(),bytes.to_vec()),("/installer.jar.sha1".into(),hash.as_bytes().to_vec())]));
        let path=t.root.join("installer.jar");let record=t.root.join("installer-sha.json");let(p,_)=progress();let cancel=Cancel::default();
        let (saved,digest)=verified_installer_download(&network(),&server.url("/installer.jar"),&path,&record,&json!({}),&cancel,&p).await.unwrap();assert_eq!(saved,path);assert_eq!(digest,hash);assert_eq!(fs::read(&path).unwrap(),bytes);
        fs::write(&path,vec![b'x';bytes.len()]).unwrap();assert!(verified_installer_download(&network(),&server.url("/installer.jar"),&path,&record,&json!({"mode":"local"}),&cancel,&p).await.is_err());
        verified_installer_download(&network(),&server.url("/installer.jar"),&path,&record,&json!({}),&cancel,&p).await.unwrap();assert_eq!(fs::read(&path).unwrap(),bytes);
        let no_hash=server.url("/missing.jar");assert!(verified_installer_download(&network(),&no_hash,&t.root.join("missing.jar"),&t.root.join("missing-sha.json"),&json!({}),&cancel,&p).await.is_err());assert!(!t.root.join("missing.jar").exists());
    }
    #[test]
    fn staging_inputs_are_copies_and_promotes_only_bound_libraries() {
        let t=Temp::new();let stage=t.root.join("staging");mkdir(&stage).unwrap();let c=Cancel::default();let client=b"client";let lib=b"library";
        let version=json!({"id":"base","jar":"base","downloads":{"client":{"sha1":hex_sha1(client),"size":client.len()}},"libraries":[{"name":"x:y:1","downloads":{"artifact":{"path":"x/y/1/y-1.jar","url":"","sha1":hex_sha1(lib),"size":lib.len()}}}]});
        atomic_bytes(&t.root.join("versions/base/base.jar"),client,&c).unwrap();atomic_bytes(&t.root.join("libraries/x/y/1/y-1.jar"),lib,&c).unwrap();
        seed_installer_base(&version,&t.root,&stage,&json!({"mode":"local"}),&c).unwrap();fs::write(stage.join("libraries/x/y/1/y-1.jar"),b"changed").unwrap();assert_eq!(fs::read(t.root.join("libraries/x/y/1/y-1.jar")).unwrap(),lib);
        assert!(promote_staged_libraries(&version,&stage,&t.root,&json!({}),&c).is_err());assert_eq!(fs::read(t.root.join("libraries/x/y/1/y-1.jar")).unwrap(),lib);
        fs::write(stage.join("libraries/x/y/1/y-1.jar"),lib).unwrap();fs::create_dir_all(stage.join("libraries/unbound")).unwrap();fs::write(stage.join("libraries/unbound/extra.jar"),b"unbound").unwrap();promote_staged_libraries(&version,&stage,&t.root,&json!({}),&c).unwrap();assert!(!t.root.join("libraries/unbound/extra.jar").exists());
        let stopped=Cancel::default();stopped.stop();assert!(copy_checked(&t.root.join("versions/base/base.jar"),&stage.join("cancelled.jar"),&stopped).is_err());assert!(!stage.join("cancelled.jar").exists());
    }
    #[test]fn paths_and_source_order(){let t=Temp::new();for id in["../x","a/b","a\\b","NUL","COM1.txt","bad:","x.",""]{assert!(identifier(id).is_err(),"{id}");}assert!(inside(&t.root,"../x").is_err());let official="https://libraries.minecraft.net/org/x.jar";assert_eq!(file_urls(official,&json!({"downloadSource":"official-first"})).unwrap(),vec![official]);assert_eq!(file_urls(official,&json!({"downloadSource":"mirror-first"})).unwrap()[0],format!("{MIRROR}/maven/org/x.jar"));assert_eq!(client_urls("https://piston-data.mojang.com/x","1.20.5",&json!({"downloadSource":"auto"})).unwrap()[1],format!("{MIRROR}/version/1.20.5/client"));assert!(Network::production().unwrap().url("http://127.0.0.1:123/x").is_err());}
    #[test]fn inheritance_rules_maven_and_conflicts(){let parent=json!({"id":"1.20.5","arguments":{"jvm":["-cp","CLASSPATH"],"game":["--username","USER"]},"libraries":[{"name":"x:y:1"}],"downloads":{"client":{"sha1":"abc"}}});let child=json!({"id":"named","inheritsFrom":"1.20.5","arguments":{"game":["--child"]},"libraries":[{"name":"x:y:2"}]});let v=merge(&parent,&child).unwrap();assert_eq!(v["clientVersion"],"1.20.5");assert_eq!(v["arguments"]["game"].as_array().unwrap().len(),3);assert!(v.get("inheritsFrom").is_none());assert!(!rules_allow(Some(&json!([{"action":"allow"},{"action":"disallow"}]))).unwrap());assert!(!rules_allow(Some(&json!([{"action":"allow","features":{"some_launch_flag":true}}]))).unwrap());assert_eq!(maven_path("org.x:y:1:natives-test@zip",None).unwrap(),Path::new("org/x/y/1/y-1-natives-test.zip"));assert_eq!(concurrency(&json!({"downloadAcceleration":"balanced","maxDownloadConcurrency":8})).unwrap(),4);assert_eq!(concurrency(&json!({"downloadAcceleration":"turbo","maxDownloadConcurrency":100})).unwrap(),48);}
    #[test]fn hash_rejects_same_size_corruption(){let t=Temp::new();let p=t.root.join("payload");fs::write(&p,b"bad!").unwrap();let task=FileTask::info(Vec::new(),p,&json!({"size":4,"sha1":hex_sha1(b"good")}),"x".into(),"client").unwrap();assert!(!satisfied(&task,&Cancel::default()).unwrap());assert!(FileTask::info(Vec::new(),t.root.join("a"),&json!({"sha1":"invalid"}),"a".into(),"client").is_err());}
    #[tokio::test]async fn bounded_concurrency_dedup_and_cache(){let t=Temp::new();let bodies=(0..6).map(|i|(format!("/f{i}"),format!("body-{i}").into_bytes())).collect::<BTreeMap<_,_>>();let server=HttpFixture::new(bodies.clone());let mut tasks=(0..6).map(|i|task(&server,&t.root,&format!("f{i}"),bodies.get(&format!("/f{i}")).unwrap())).collect::<Vec<_>>();tasks.push(tasks[0].clone());let(p,events)=progress();let c=Arc::new(Cancel::default());batch(&network(),tasks.clone(),&json!({"maxDownloadConcurrency":3}),c,&p).await.unwrap();assert_eq!(server.requests.load(Ordering::SeqCst),6);assert!(server.peak.load(Ordering::SeqCst)<=3);assert!(server.peak.load(Ordering::SeqCst)>=2);let c=Arc::new(Cancel::default());batch(&network(),tasks,&json!({"mode":"local","maxDownloadConcurrency":3}),c,&p).await.unwrap();assert_eq!(server.requests.load(Ordering::SeqCst),6);p.finish(true);let e=events.lock().unwrap();assert_eq!(e.last().unwrap()["phase"],"done");assert_eq!(e.last().unwrap()["percent"],100);}
    #[test]fn download_host_allowlist_covers_official_subdomains_and_rejects_lookalikes(){for ok in["piston-meta.mojang.com","piston-data.mojang.com","libraries.minecraft.net","resources.download.minecraft.net","maven.minecraft.net","bmclapi2.bangbang93.com","bmclapi.bangbang93.com","bmclapi17.sakura.sld.tw","maven.fabricmc.net","repo1.maven.org"]{assert!(allowed_download_host(ok),"{ok} 应被允许");}for bad in["evilmojang.com","evilminecraft.net","mojang.com.evil.cn","download.mcbbs.net","bmclapi.evil.com","bmclapi17.sakura.sld.tw.evil.com","libraries.minecraft.net.attacker.io",""]{assert!(!allowed_download_host(bad),"{bad} 应被拒绝");}let error=network().url("https://evilmojang.com/x.jar").unwrap_err();assert!(error.contains("evilmojang.com"),"错误信息应回显主机名：{error}");}
    #[test]fn mirror_node_urls_are_preferred_with_official_fallback(){let t=Temp::new();let lib=json!({"name":"com.mojang:authlib:12.0.82","url":"https://bmclapi17.sakura.sld.tw/maven","downloads":{"artifact":{"path":"com/mojang/authlib/12.0.82/authlib-12.0.82.jar","sha1":"93399b2668d84d171c07b8eb99bd118823285fc2","size":167403,"url":"https://bmclapi17.sakura.sld.tw/maven/com/mojang/authlib/12.0.82/authlib-12.0.82.jar"}}});let task=library_task(&t.root,&json!({"downloadSource":"mirror-first"}),&lib,&lib["downloads"]["artifact"],None,"libraries").unwrap();assert_eq!(task.urls[0],"https://bmclapi17.sakura.sld.tw/maven/com/mojang/authlib/12.0.82/authlib-12.0.82.jar","镜像节点应作为首选以获取速度");assert!(task.urls.iter().any(|u|u.starts_with("https://libraries.minecraft.net/")),"镜像节点之外必须保留官方回退");assert!(task.urls.iter().all(|u|network().url(u).is_ok()));}
    #[tokio::test]async fn unregistered_hosts_are_rejected_with_host_name(){let t=Temp::new();let body=b"strict-host";let server=HttpFixture::new(BTreeMap::from([("/ok".into(),body.to_vec())]));let mut x=task(&server,&t.root,"ok",body);x.urls.insert(0,"https://mirror.example.com/maven/x.jar".into());let(p,_)=progress();let error=download_one(&network(),x,&json!({}),&Cancel::default(),&p).await.unwrap_err();assert!(error.contains("mirror.example.com"),"错误应回显未登记主机：{error}");assert_eq!(server.requests.load(Ordering::SeqCst),0);}
    /// 小文件大批量下载：进度事件必须限流，但聚合字节数不能因增量化而漂移。
    #[tokio::test]async fn many_small_files_throttle_events_without_losing_totals(){let t=Temp::new();let bodies=(0..200).map(|i|(format!("/s{i}"),format!("small-body-{i}").into_bytes())).collect::<BTreeMap<_,_>>();let server=HttpFixture::new(bodies.clone());let tasks=(0..200).map(|i|task(&server,&t.root,&format!("s{i}"),bodies.get(&format!("/s{i}")).unwrap())).collect::<Vec<_>>();let(p,events)=progress();batch(&network(),tasks,&json!({"maxDownloadConcurrency":8}),Arc::new(Cancel::default()),&p).await.unwrap();p.finish(true);let e=events.lock().unwrap();let expected=bodies.values().map(|b|b.len()as u64).sum::<u64>();assert!(e.len()<400,"200 个文件共产生 {} 条事件，逐个完成即发送时至少 400 条",e.len());let last=e.last().unwrap();assert_eq!(last["percent"],100);assert_eq!(last["currentBytes"].as_u64(),Some(expected));assert_eq!(last["totalBytes"].as_u64(),Some(expected));}
    #[tokio::test]async fn fallback_sha256_and_inflight_cancel(){let t=Temp::new();let server=HttpFixture::new(BTreeMap::from([("/data".into(),b"correct".to_vec())]));let mut x=FileTask::info(vec![server.url("/missing"),server.url("/data")],t.root.join("data"),&json!({"sha256":format!("{:x}",Sha256::digest(b"correct")),"size":7}),"data".into(),"client").unwrap();fs::write(&x.path,b"corrupt").unwrap();let(p,_)=progress();download_one(&network(),x.clone(),&json!({}),&Cancel::default(),&p).await.unwrap();assert_eq!(fs::read(&x.path).unwrap(),b"correct");assert_eq!(server.requests.load(Ordering::SeqCst),2);x.path=t.root.join("cancelled");x.urls=vec![server.url("/data")];let c=Arc::new(Cancel::default());let stop=c.clone();let count=server.requests.clone();let trigger=thread::spawn(move||{for _ in 0..200{if count.load(Ordering::SeqCst)>=3{stop.stop();return;}thread::sleep(Duration::from_millis(2));}stop.stop();});let result=download_one(&network(),x,&json!({}),&c,&p).await;trigger.join().unwrap();assert!(result.is_err());assert!(!t.root.join("cancelled").exists());assert!(!fs::read_dir(&t.root).unwrap().any(|e|e.unwrap().file_name().to_string_lossy().ends_with(".part")));}
    #[tokio::test]
    async fn local_mode_never_issues_request() {
        let t = Temp::new();
        let server = HttpFixture::new(BTreeMap::from([("/x".into(), b"x".to_vec())]));
        let (progress, _) = progress();
        let settings = json!({"mode":"local"});
        let cancel = Cancel::default();
        let network = network();
        assert!(download_one(&network, task(&server, &t.root, "x", b"x"), &settings, &cancel, &progress).await.is_err());
        let url = server.url("/x");
        let metadata = version_metadata::Metadata::new(&network, &t.root, &settings, &cancel)
            .with_test_endpoints(&url, &url, &server.address);
        for force in [false, true] {
            assert!(metadata.list(force).await.is_err());
        }
        assert!(metadata.resolve("missing", version_metadata::LocalId::Required, merge).await.is_err());
        assert_eq!(server.requests.load(Ordering::SeqCst), 0);
        assert!(!t.root.join(".hcmcl-cache").exists());
    }
    #[tokio::test]async fn segmented_download_assembles_large_file_with_bounded_ranges(){let t=Temp::new();let bytes:Vec<u8>=(0..20*1024*1024u32).map(|i|(i%251)as u8).collect();let server=HttpFixture::new(BTreeMap::from([("/big".into(),bytes.clone())]));let x=task(&server,&t.root,"big",&bytes);let(p,_)=progress();download_one(&network(),x,&json!({"downloadConnections":4}),&Cancel::default(),&p).await.unwrap();assert_eq!(fs::read(t.root.join("big")).unwrap(),bytes);assert!(server.ranges.load(Ordering::SeqCst)>=4);}
    #[tokio::test]async fn segmented_download_uses_single_stream_below_threshold(){let t=Temp::new();let bytes:Vec<u8>=(0..1024u32).map(|i|(i%253)as u8).collect();let server=HttpFixture::new(BTreeMap::from([("/small".into(),bytes.clone())]));let x=task(&server,&t.root,"small",&bytes);let(p,_)=progress();download_one(&network(),x,&json!({"downloadConnections":8}),&Cancel::default(),&p).await.unwrap();assert_eq!(fs::read(t.root.join("small")).unwrap(),bytes);assert_eq!(server.ranges.load(Ordering::SeqCst),0);}
    #[tokio::test]async fn validator_backed_resume(){let t=Temp::new();let bytes=b"resume-integrity-fixture";let server=HttpFixture::new(BTreeMap::from([("/resume".into(),bytes.to_vec())]));let mut x=task(&server,&t.root,"resume",bytes);x.urls=vec![server.url("/resume")];let(p,_)=progress();download_one(&network(),x,&json!({}),&Cancel::default(),&p).await.unwrap();assert_eq!(fs::read(t.root.join("resume")).unwrap(),bytes);assert!(server.ranges.load(Ordering::SeqCst)>=1);}
    #[tokio::test]
    async fn version_list_uses_source_order_and_filters_legacy_entries() {
        let t = Temp::new();
        let server = HttpFixture::with_bodies(|base| {
            let entry = |id: &str, kind: &str| json!({
                "id": id,
                "type": kind,
                "releaseTime": "2024-01-01T00:00:00Z",
                "url": format!("{base}/{id}.json"),
                "sha1": "0000000000000000000000000000000000000000",
            });
            let valid = json!({
                "latest": {"release": "1.0.0", "snapshot": "24w01a"},
                "versions": [entry("1.0.0", "release"), entry("24w01a", "snapshot"), entry("old", "old_alpha")],
            });
            BTreeMap::from([
                ("/official".into(), br#"{"latest":{"release":"missing"},"versions":[]}"#.to_vec()),
                ("/mirror".into(), serde_json::to_vec(&valid).unwrap()),
                ("/1.0.0.json".into(), br#"{"id":"1.0.0"}"#.to_vec()),
                ("/24w01a.json".into(), br#"{"id":"24w01a"}"#.to_vec()),
            ])
        });
        let settings = json!({"mode": "online", "versionListSource": "auto"});
        let cancel = Cancel::default();
        let network = network();
        let official = server.url("/official");
        let mirror = server.url("/mirror");
        let metadata = version_metadata::Metadata::new(&network, &t.root, &settings, &cancel)
            .with_test_endpoints(&official, &mirror, &server.address);
        let list = metadata.list(true).await.unwrap();
        assert_eq!(list["latest"]["release"], "1.0.0");
        assert_eq!(list["latest"]["snapshot"], "24w01a");
        let versions = list["versions"].as_array().unwrap();
        assert_eq!(versions.len(), 2);
        assert!(versions.iter().all(|entry| entry["type"] != "old_alpha"));
        assert_eq!(server.request_count(), 2, "auto 策略应先尝试官方再回退镜像");
        let cached = metadata.list(false).await.unwrap();
        assert_eq!(cached["latest"], list["latest"]);
        assert_eq!(server.request_count(), 2, "非 force 应复用成功来源的有效清单缓存");
        let forced = metadata.list(true).await.unwrap();
        assert_eq!(forced["latest"], list["latest"]);
        assert_eq!(server.request_count(), 4, "force 应按策略重新尝试来源");
    }
    #[test]fn native_staging_cache_and_rollback(){let t=Temp::new();let jar=t.root.join("native.jar");zip(&jar,&[("native.bin",b"native-good"),("META-INF/no",b"skip")]);let files=vec![NativeArchive{path:jar.clone(),excludes:Vec::new()}];let c=Cancel::default();let out=extract_natives(&t.root,"fixture",&files,&c).unwrap();assert_eq!(fs::read(out.join("native.bin")).unwrap(),b"native-good");assert!(!out.join("META-INF").exists());fs::write(out.join("native.bin"),b"corrupt").unwrap();fs::write(out.join("stale.bin"),b"stale").unwrap();extract_natives(&t.root,"fixture",&files,&c).unwrap();assert!(!out.join("stale.bin").exists());let bad=t.root.join("bad.jar");fs::write(&bad,b"not-zip").unwrap();let mut both=files.clone();both.push(NativeArchive{path:bad,excludes:Vec::new()});assert!(extract_natives(&t.root,"fixture",&both,&c).is_err());assert_eq!(fs::read(out.join("native.bin")).unwrap(),b"native-good");let stopped=Cancel::default();stopped.stop();assert!(extract_natives(&t.root,"cancelled",&files,&stopped).is_err());assert!(!t.root.join("versions/cancelled/natives/.extract-stamp").exists());}
    #[tokio::test]async fn atomic_final_profile_and_legacy_asset_mapping(){let t=Temp::new();let n=network();let(p,_)=progress();let client=b"fixture-client";let asset=b"fixture-asset";let hash=hex_sha1(asset);let object=inside(&t.root,format!("assets/objects/{}/{hash}",&hash[..2])).unwrap();mkdir(object.parent().unwrap()).unwrap();fs::write(&object,asset).unwrap();mkdir(&t.root.join("versions/base")).unwrap();fs::write(t.root.join("versions/base/base.jar"),client).unwrap();let index=json!({"virtual":true,"map_to_resources":true,"objects":{"dir/file":{"hash":hash,"size":asset.len()}}});let bytes=serde_json::to_vec(&index).unwrap();mkdir(&t.root.join("assets/indexes")).unwrap();fs::write(t.root.join("assets/indexes/legacy.json"),&bytes).unwrap();let v=json!({"id":"named","clientVersion":"base","jar":"base","mainClass":"net.minecraft.client.main.Main","libraries":[],"assetIndex":{"id":"legacy","sha1":hex_sha1(&bytes),"size":bytes.len()},"downloads":{"client":{"sha1":hex_sha1(client),"size":client.len()}}});let r=install(&n,v.clone(),&t.root,&json!({"mode":"local"}),Arc::new(Cancel::default()),&p).await.unwrap();assert_eq!(r["versionId"],"named");assert_eq!(fs::read(t.root.join("resources/dir/file")).unwrap(),asset);assert_eq!(fs::read(t.root.join("assets/virtual/legacy/dir/file")).unwrap(),asset);assert!(version_path(&t.root,"named").unwrap().exists());let mut broken=v;broken["id"]=json!("broken");broken["libraries"]=json!([{"name":"x:missing:1","downloads":{"artifact":{"path":"x/missing/1/missing-1.jar","url":"","sha1":hex_sha1(b"missing")}}}]);assert!(install(&n,broken,&t.root,&json!({"mode":"local"}),Arc::new(Cancel::default()),&p).await.is_err());assert!(!version_path(&t.root,"broken").unwrap().exists());}
    #[tokio::test]
    async fn metadata_cache_rechecks_current_manifest_digest() {
        let t = Temp::new();
        let raw = b"{\"id\":\"fixture\",\"mainClass\":\"Main\"}";
        let changed = b"{\"id\":\"fixture\",\"mainClass\":\"Changed\"}";
        let entry = |digest: String| json!({"id":"fixture","type":"release","releaseTime":"2024-01-01T00:00:00Z","url":"http://127.0.0.1:1/version/fixture.json","sha1":digest});
        let manifest = |digest: String| json!({"latest":{"release":"fixture","snapshot":"fixture"},"versions":[entry(digest)]});
        let cancel = Cancel::default();
        atomic_json(&inside(&t.root, ".hcmcl-cache/manifest-official.json").unwrap(), &manifest(hex_sha1(raw)), &cancel).unwrap();
        atomic_bytes(&inside(&t.root, ".hcmcl-cache/versions/official/fixture.json").unwrap(), raw, &cancel).unwrap();
        let settings = json!({"mode":"local","versionListSource":"official-first"});
        let network = network();
        let metadata = version_metadata::Metadata::new(&network, &t.root, &settings, &cancel);
        assert_eq!(metadata.resolve("fixture", version_metadata::LocalId::Required, merge).await.unwrap()["mainClass"], "Main");
        let changed_manifest = serde_json::to_vec(&manifest(hex_sha1(changed))).unwrap();
        atomic_bytes(&inside(&t.root, ".hcmcl-cache/manifest-official.json").unwrap(), &changed_manifest, &cancel).unwrap();
        assert!(metadata.resolve("fixture", version_metadata::LocalId::Required, merge).await.is_err());
        let stopped = Arc::new(Cancel::default());
        { let _guard = CancelOnDrop(stopped.clone()); }
        assert!(stopped.check().is_err());
    }
    #[tokio::test]async fn root_lock_job_ownership_and_cancel_wait(){let t=Temp::new();let c=Cancel::default();let first=install_lock::acquire(&t.root,||c.stopped.load(Ordering::Acquire)).await.unwrap();let stop=Arc::new(Cancel::default());let s=stop.clone();let root=t.root.clone();let waiting=tokio::spawn(async move{install_lock::acquire(&root,||s.stopped.load(Ordering::Acquire)).await.is_err()});tokio::time::sleep(Duration::from_millis(50)).await;stop.stop();assert!(waiting.await.unwrap());drop(first);let one=JobGuard::register(&t.root,"id").unwrap();assert!(JobGuard::register(&t.root,"id").is_err());cancel_jobs(Some("id")).unwrap();assert!(one.job.cancel.check().is_err());drop(one);assert!(JobGuard::register(&t.root,"id").is_ok());}
}

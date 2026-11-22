//! 本地整合包导出：用户源只读；单个 owned worker 持有根锁、任务与发布暂存直到实际收尾。
use super::{access::{leaf, Directory, DirectoryMark, Source}, output::Stage, Result};
use crate::{downloads::{Cancel, JobGuard}, install_lock::RootOperationGuard};
use serde_json::{json, Value};
use std::{collections::{BTreeMap, BTreeSet}, io::{Read, Seek, Write}, path::{Path, PathBuf}, sync::{Arc, Mutex, OnceLock}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Emitter};
use zip::{write::FileOptions, CompressionMethod, ZipWriter};

const FILE_CAP:u64=2*1024*1024*1024;
const TOTAL_CAP:u64=16*1024*1024*1024;
const ENTRY_CAP:usize=100_000;
const JSON_CAP:u64=4*1024*1024;
const JSON_TOTAL:u64=16*1024*1024;
#[derive(Debug,Clone)]
pub(super) struct Options {format:String,game:bool,configs:bool,servers:bool,jei:bool,disabled:bool,worlds:Vec<String>,packs:Vec<String>,guns:Vec<String>,schematics:Vec<String>}
impl Options {
    pub(super) fn parse(value:&Value)->Result<Self>{
        let object=value.as_object().ok_or("导出选项必须为对象")?;
        const KEYS:[&str;10]=["format","includeGameSettings","includeModConfigs","includeServersList","includeJei","includeDisabledMods","worlds","resourcePacks","gunPacks","schematics"];
        if object.len()!=KEYS.len()||object.keys().any(|key|!KEYS.contains(&key.as_str())){return Err("导出选项缺失或包含未知字段".into());}
        let format=object["format"].as_str().filter(|v|matches!(*v,"modrinth"|"mcbbs"|"native")).ok_or("整合包导出格式无效")?.to_owned();
        let flag=|key:&str|object[key].as_bool().ok_or_else(||format!("导出选项 {key} 必须为布尔值"));
        let list=|key:&str|->Result<Vec<String>>{let rows=object[key].as_array().filter(|v|v.len()<=ENTRY_CAP).ok_or("导出选择必须为有界名称数组")?;let mut seen=BTreeSet::new();let mut names=Vec::new();for row in rows{let name=leaf(row.as_str().ok_or("导出选择必须为文本")?)?;if !seen.insert(name.to_lowercase()){return Err("导出选择含重复或大小写冲突".into());}names.push(name.to_owned());}names.sort();Ok(names)};
        Ok(Self{format,game:flag("includeGameSettings")?,configs:flag("includeModConfigs")?,servers:flag("includeServersList")?,jei:flag("includeJei")?,disabled:flag("includeDisabledMods")?,worlds:list("worlds")?,packs:list("resourcePacks")?,guns:list("gunPacks")?,schematics:list("schematics")?})
    }
    fn filename(&self,id:&str)->String{format!("{id}.{}",if self.format=="modrinth"{"mrpack"}else{"zip"})}
}

#[derive(Default)] struct Gate {committed:bool,sticky:bool}
struct Operation {cancel:Arc<Cancel>,gate:Mutex<Gate>}
impl Operation {
    fn cancel(&self)->Result<()>{
        match self.gate.try_lock(){
            Ok(gate)=>{if gate.committed{return Err("整合包已完成发布，取消不能撤销导出".into());}self.cancel.stop();Ok(())}
            Err(std::sync::TryLockError::WouldBlock)=>{self.cancel.stop();Err("发布正在提交，取消不能保证撤销".into())}
            Err(std::sync::TryLockError::Poisoned(_))=>{self.cancel.stop();Err("整合包取消状态不可用，已发送停止信号但无法确认发布状态".into())}
        }
    }
}
#[derive(Default)] struct Window {closed:bool,active:BTreeMap<String,(String,Arc<Operation>)>}
impl Window {
    fn register(&mut self,id:String,operation:Arc<Operation>)->Result<String>{if self.closed{return Err("主窗口已关闭，不能登记整合包导出".into());}if self.active.len()>=128{return Err("整合包导出任务过多".into());}let token=uuid::Uuid::new_v4().to_string();self.active.insert(token.clone(),(id,operation));Ok(token)}
    fn close(&mut self){self.closed=true;for (_,op) in self.active.values(){op.cancel.stop();}}
}
static WINDOW:OnceLock<Mutex<Window>>=OnceLock::new();
fn window()->&'static Mutex<Window>{WINDOW.get_or_init(||Mutex::new(Window::default()))}
pub(super) fn cancel_for_window(){if let Ok(mut state)=window().lock(){state.close();}}
pub(super) fn cancel_download(id:Option<&str>)->Result<()>{let state=window().lock().map_err(|_|"整合包任务登记不可用")?;let mut error=None;for (task,op) in state.active.values(){if id.map_or(true,|id|id==task){if let Err(e)=op.cancel(){error=Some(e);}}}error.map_or(Ok(()),Err)}

pub(super) fn relaunch_ready() -> Result<()> {
    let state = match window().try_lock() {
        Ok(state) => state,
        Err(std::sync::TryLockError::WouldBlock) => return Err("整合包导出状态正忙，无法确认可以重启".into()),
        Err(std::sync::TryLockError::Poisoned(_)) => return Err("整合包导出状态未知，无法确认可以重启".into()),
    };
    if !state.active.is_empty() { return Err("整合包导出仍在进行或收尾，无法重启".into()); }
    Ok(())
}

struct Active(String);
impl Drop for Active{fn drop(&mut self){if let Ok(mut state)=window().lock(){state.active.remove(&self.0);}}}
struct CancelOnDrop(Arc<Operation>);
impl Drop for CancelOnDrop{fn drop(&mut self){self.0.cancel.stop();}}

#[derive(Clone)] struct Reporter {sink:Arc<dyn Fn(Value)+Send+Sync>,task:String,title:String}
impl Reporter {
    fn update(&self,name:&str,current:usize,total:usize,bytes:u64,size:u64,done:Option<bool>){let success=done==Some(true);(self.sink)(json!({"taskId":self.task,"jobTitle":self.title,"task":name,"current":current,"total":total,"currentBytes":bytes,"totalBytes":size,"phase":if done.is_some(){"done"}else{"mod"},"percent":if done.is_some(){if success{100.0}else{0.0}}else if size>0{(bytes as f64/size as f64*99.0).min(99.0)}else{0.0},"speed":0}));}
}

struct DirectorySnapshot {directory:DirectoryMark,names:Vec<String>}
struct Entry {name:String,source:Source}
struct Plan {root:Directory,isolation:super::isolation::Snapshot,files:Vec<Entry>,directories:Vec<DirectorySnapshot>,metadata:Vec<Source>,absent:Vec<(DirectoryMark,String)>,total:u64,manifest_name:String,manifest:Vec<u8>}
struct Planner {files:Vec<Entry>,directories:Vec<DirectorySnapshot>,remaining:usize,total:u64,names:BTreeSet<String>,absent:Vec<(DirectoryMark,String)>}
impl Planner {
    fn new()->Self{Self{files:Vec::new(),directories:Vec::new(),remaining:ENTRY_CAP,total:0,names:BTreeSet::new(),absent:Vec::new()}}
    fn names(&mut self,directory:&Directory,cancel:&Cancel)->Result<Vec<String>>{cancel.check()?;let names=directory.names(&mut self.remaining)?;self.directories.push(DirectorySnapshot{directory:directory.mark(),names:names.clone()});Ok(names)}
    fn file(&mut self,parent:&Directory,name:&str,target:String,cancel:&Cancel)->Result<()>{cancel.check()?;if target.len()>4096||target.split('/').count()>64{return Err("导出 ZIP 路径过长或层级过深".into());}let source=parent.source(name)?;if source.len()>FILE_CAP{return Err("导出源单文件超过 2 GiB".into());}self.total=self.total.checked_add(source.len()).filter(|v|*v<=TOTAL_CAP).ok_or("导出源总量超过 16 GiB")?;if self.files.len()>=ENTRY_CAP||!self.names.insert(target.to_lowercase()){return Err("导出文件过多或 ZIP 路径冲突".into());}self.files.push(Entry{name:target,source});Ok(())}
    fn tree(&mut self,directory:Directory,target:&str,depth:usize,cancel:&Cancel)->Result<()>{if depth>64{return Err("导出源目录层级超过 64".into());}for name in self.names(&directory,cancel)?{cancel.check()?;let node=directory.child(&name)?.ok_or("导出源条目已消失")?;let output=format!("{target}/{name}");if node.meta.is_dir(){self.tree(directory.directory(node)?,&output,depth+1,cancel)?;}else{drop(node);self.file(&directory,&name,output,cancel)?;}}directory.verify()}
    fn optional(&mut self,run:&Directory,name:&str,recursive:bool,cancel:&Cancel)->Result<()>{cancel.check()?;let Some(node)=run.child(name)?else{self.absent.push((run.mark(),name.into()));return Ok(())};if recursive{self.tree(run.directory(node)?,&format!("overrides/{name}"),1,cancel)}else if node.meta.is_file(){drop(node);self.file(run,name,format!("overrides/{name}"),cancel)}else{Err("导出文件位置不是普通文件".into())}}
    fn selected(&mut self,run:&Directory,kind:&str,names:&[String],cancel:&Cancel)->Result<()>{if names.is_empty(){return Ok(())}let dir=required(run,kind)?;for name in names{cancel.check()?;let node=dir.child(name)?.ok_or("选中的导出内容已移除，请重新选择")?;let target=format!("overrides/{kind}/{name}");if node.meta.is_dir(){self.tree(dir.directory(node)?,&target,2,cancel)?;}else{drop(node);self.file(&dir,name,target,cancel)?;}}Ok(())}
}
fn required(parent:&Directory,name:&str)->Result<Directory>{parent.directory(parent.child(name)?.ok_or("本地实例目录不存在")?)}
fn local_json(directory:&Directory,name:&str,budget:&mut u64,cancel:&Cancel)->Result<(Value,Source)>{cancel.check()?;let source=directory.source(name)?;if source.len()>JSON_CAP{return Err("本地版本 JSON 超过 4 MiB".into());}*budget=budget.checked_sub(source.len()).ok_or("本地继承 JSON 总量超过 16 MiB")?;let mut opened=source.open()?;let mut bytes=Vec::new();let mut chunk=[0u8;65536];loop{cancel.check()?;let n=opened.file.read(&mut chunk).map_err(|_|"读取本地版本 JSON 失败")?;if n==0{break;}if bytes.len()+n>JSON_CAP as usize{return Err("本地版本 JSON 读取超过预算".into());}bytes.extend_from_slice(&chunk[..n]);}opened.verify()?;if bytes.len() as u64!=source.len(){return Err("本地版本 JSON 大小已改变".into());}let value:Value=serde_json::from_slice(&bytes).map_err(|_|"本地版本 JSON 无效")?;if !value.is_object(){return Err("本地版本 JSON 必须为对象".into());}Ok((value,source))}
fn text(value:&Value,key:&str)->Result<Option<String>>{match value.get(key){None|Some(Value::Null)=>Ok(None),Some(Value::String(v)) if !v.is_empty()&&v.len()<=240&&!v.chars().any(char::is_control)=>Ok(Some(v.clone())),_=>Err(format!("本地版本字段 {key} 无效"))}}
fn metadata(versions:&Directory,id:&str,cancel:&Cancel)->Result<(String,Option<&'static str>,Vec<Source>)>{
    let mut current=id.to_owned();let mut visited=BTreeSet::new();let mut json_budget=JSON_TOTAL;let mut sources=Vec::new();let mut libraries=Vec::new();let mut mc=None;
    for depth in 0..32{cancel.check()?;leaf(&current)?;if !visited.insert(current.clone()){return Err("本地版本继承循环".into());}let dir=required(versions,&current)?;let (profile,source)=local_json(&dir,&format!("{current}.json"),&mut json_budget,cancel)?;sources.push(source);
        if let Some(libs)=profile.get("libraries"){let libs=libs.as_array().ok_or("本地版本 libraries 必须为数组")?;if libraries.len()+libs.len()>ENTRY_CAP{return Err("本地版本依赖条目过多".into());}for lib in libs{if let Some(name)=lib.get("name").and_then(Value::as_str){if name.len()>8192{return Err("本地版本依赖名称过长".into());}libraries.push(name.to_owned());}}}
        if mc.is_none(){mc=text(&profile,"clientVersion")?;}
        if let Some(parent)=text(&profile,"inheritsFrom")?{current=parent;if depth==31{return Err("本地版本继承超过 32 层".into());}}else{
            if mc.is_none(){
                let base=text(&profile,"id")?.ok_or("本地原版配置缺少 id，无法确定 Minecraft 版本")?;
                let kind=profile.get("type").and_then(Value::as_str);
                // 保留新式快照的完整原版 ID，不将其截为数字基版本。
                let syntax=regex::Regex::new(r"^(?:[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:-(?:pre|rc)[0-9]+)?|[0-9]{2}w[0-9]{2}[a-z]|[0-9]+\.[0-9]+-snapshot-[0-9]+)$").expect("固定版本表达式");
                let modern=matches!(kind,Some("release"|"snapshot"))&&syntax.is_match(&base);
                let historical=matches!(kind,Some("old_alpha"|"old_beta"))&&base.bytes().all(|v|v.is_ascii_alphanumeric()||b"._-".contains(&v))&&(base.starts_with('a')||base.starts_with('b')||base.starts_with('c')||base.starts_with("rd-"));
                if !modern&&!historical{return Err("本地版本缺少可确认的 Minecraft 版本，请补齐 clientVersion 或原版配置".into());}
                mc=Some(base);
            }
            break;
        }
    }
    let mc=mc.ok_or("无法从本地配置确定 Minecraft 版本")?;leaf(&mc)?;
    let loader=[("net.neoforged","neoforge"),("net.minecraftforge","forge"),("net.fabricmc","fabric"),("org.quiltmc","quilt")].into_iter().find_map(|(prefix,kind)|libraries.iter().any(|name|name.to_ascii_lowercase().contains(prefix)).then_some(kind));
    Ok((mc,loader,sources))
}
fn manifest(id:&str,options:&Options,mc:&str,loader:Option<&str>)->Result<(String,Vec<u8>)>{let (name,value)=if options.format=="modrinth"{let mut deps=json!({"minecraft":mc});if let Some(loader)=loader{deps[match loader{"fabric"=>"fabric-loader","quilt"=>"quilt-loader",other=>other}]=json!("*");}("modrinth.index.json",json!({"formatVersion":1,"game":"minecraft","versionId":mc,"name":id,"summary":"","files":[],"dependencies":deps}))}else{let mut value=json!({"name":id,"version":"1.0.0","game_version":mc,"mod_loader":loader.unwrap_or("vanilla"),"mod_loader_version":"*","description":""});if options.format=="native"{value["format"]=json!("hunger-cat");}(if options.format=="native"{"launcher.packmeta"}else{"mcbbs.packmeta"},value)};Ok((name.into(),serde_json::to_vec_pretty(&value).map_err(|_|"整合包元数据序列化失败")?))}
fn plan(root_path:&Path,id:&str,settings:&Value,options:&Options,cancel:&Cancel)->Result<Plan>{
    leaf(id)?;cancel.check()?;let root=Directory::open(root_path)?;let versions=required(&root,"versions")?;let version=required(&versions,id)?;
    let isolation=super::isolation::read(root_path,id,settings)?;
    let run=if isolation.isolated{&version}else{&root};let (mc,loader,metadata)=metadata(&versions,id,cancel)?;let (manifest_name,manifest)=manifest(id,options,&mc,loader)?;let mut p=Planner::new();
    if let Some(node)=run.child("mods")?{let mods=run.directory(node)?;for name in p.names(&mods,cancel)?{let node=mods.child(&name)?.ok_or("模组内容已改变")?;if node.meta.is_file()&&(!name.ends_with(".disabled")||options.disabled){drop(node);p.file(&mods,&name,format!("overrides/mods/{name}"),cancel)?;}}}else{p.absent.push((run.mark(),"mods".into()));}
    if options.game{p.optional(run,"options.txt",false,cancel)?;}if options.configs{p.optional(run,"config",true,cancel)?;}if options.servers{p.optional(run,"servers.dat",false,cancel)?;}p.optional(run,"shaderpacks",true,cancel)?;
    p.selected(run,"saves",&options.worlds,cancel)?;p.selected(run,"resourcepacks",&options.packs,cancel)?;if options.jei{p.optional(run,"jei",true,cancel)?;}p.selected(run,"tacz",&options.guns,cancel)?;p.selected(run,"schematics",&options.schematics,cancel)?;
    p.files.sort_by(|a,b|a.name.cmp(&b.name));Ok(Plan{root,isolation,files:p.files,directories:p.directories,metadata,absent:p.absent,total:p.total,manifest_name,manifest})
}
impl Plan {fn verify(&self,cancel:&Cancel)->Result<()>{self.root.verify()?;self.isolation.verify()?;for (parent,name) in &self.absent{cancel.check()?;if parent.open()?.child(name)?.is_some(){return Err("导出源中原先缺失的内容已出现，请重新导出".into());}}for row in &self.directories{cancel.check()?;let mut budget=ENTRY_CAP;if row.directory.open()?.names(&mut budget)?!=row.names{return Err("导出源目录内容在打包期间改变".into());}}for file in &self.files{cancel.check()?;file.source.verify()?;}for source in &self.metadata{cancel.check()?;source.verify()?;}Ok(())}}

// DOS 时间按 UTC 分解；不调用平台时区 API，跨平台保持稳定，超界钳制至 ZIP 可表示年份。
fn zip_time(time:SystemTime)->zip::DateTime{let secs=time.duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO).as_secs();let days=(secs/86400) as i64;let z=days+719468;let era=if z>=0{z}else{z-146096}/146097;let doe=z-era*146097;let yoe=(doe-doe/1460+doe/36524-doe/146096)/365;let mut year=yoe+era*400;let doy=doe-(365*yoe+yoe/4-yoe/100);let mp=(5*doy+2)/153;let day=doy-(153*mp+2)/5+1;let month=mp+if mp<10{3}else{-9};year+=if month<=2{1}else{0};if !(1980..=2107).contains(&year){return zip::DateTime::default();}zip::DateTime::from_date_and_time(year as u16,month as u8,day as u8,((secs%86400)/3600) as u8,((secs%3600)/60) as u8,(secs%60) as u8).unwrap_or_default()}
struct Classic<W>{inner:W,position:u64}
impl<W:Write>Write for Classic<W>{fn write(&mut self,bytes:&[u8])->std::io::Result<usize>{if self.position.checked_add(bytes.len()as u64).filter(|n|*n<=FILE_CAP).is_none(){return Err(std::io::Error::new(std::io::ErrorKind::InvalidData,"当前整合包 reader 仅支持不超过 2 GiB 的 classic ZIP"));}let n=self.inner.write(bytes)?;self.position+=n as u64;Ok(n)}fn flush(&mut self)->std::io::Result<()>{self.inner.flush()}}
impl<W:Seek>Seek for Classic<W>{fn seek(&mut self,pos:std::io::SeekFrom)->std::io::Result<u64>{self.position=self.inner.seek(pos)?;if self.position>FILE_CAP{return Err(std::io::Error::new(std::io::ErrorKind::InvalidData,"classic ZIP 位置超过安全上限"));}Ok(self.position)}}
fn write_archive<W:Write+Seek>(writer:W,plan:&Plan,cancel:&Cancel,report:&Reporter)->Result<W>{
    if plan.files.len()+1>50_000{return Err("当前整合包 reader 最多支持 50000 个 ZIP 文件条目；本次未发布也未删减内容".into());}
    let central=plan.files.iter().try_fold(46+plan.manifest_name.len(),|n,row|n.checked_add(46+row.name.len()).ok_or("导出中央目录大小溢出"))?;
    if central>16*1024*1024{return Err("导出中央目录超过当前 reader 的 16 MiB 预算".into());}
    let mut zip=ZipWriter::new(Classic{inner:writer,position:0});let options=FileOptions::default().compression_method(CompressionMethod::Deflated).compression_level(Some(6)).unix_permissions(0o644);
    cancel.check()?;zip.start_file(&plan.manifest_name,options).map_err(|_|"无法写入整合包清单")?;zip.write_all(&plan.manifest).map_err(|_|"整合包清单写入失败")?;
    let mut bytes=0u64;let mut last=Instant::now()-Duration::from_secs(1);let mut buffer=[0u8;65536];
    for (index,row) in plan.files.iter().enumerate(){cancel.check()?;let mut source=row.source.open()?;zip.start_file(&row.name,options.last_modified_time(zip_time(row.source.modified()))).map_err(|_|"无法写入 ZIP 文件条目")?;let mut count=0u64;loop{cancel.check()?;let n=source.file.read(&mut buffer).map_err(|_|"读取导出源失败")?;if n==0{break;}count=count.checked_add(n as u64).filter(|v|*v<=row.source.len()).ok_or("导出源文件大小已改变")?;zip.write_all(&buffer[..n]).map_err(|_|"写入整合包 ZIP 失败")?;bytes+=n as u64;if last.elapsed()>=Duration::from_millis(100){source.verify()?;report.update(&row.name,index,plan.files.len(),bytes,plan.total,None);last=Instant::now();}}
        if count!=row.source.len(){return Err("导出源文件被截断".into());}source.verify()?;report.update(&row.name,index+1,plan.files.len(),bytes,plan.total,None);
    }
    cancel.check()?;plan.verify(cancel)?;zip.finish().map(|writer|writer.inner).map_err(|_|"整合包 ZIP 写入失败或超过当前 reader 的 2 GiB/classic ZIP 预算".into())
}
fn work(root:&Path,id:&str,settings:&Value,options:&Options,op:&Operation,report:&Reporter,stage:&mut Option<Stage>)->Result<String>{
    report.update("正在检查本地导出内容",0,0,0,0,None);let p=plan(root,id,settings,options,&op.cancel)?;p.verify(&op.cancel)?;op.cancel.check()?;
    *stage=Some(Stage::new(&p.root,&options.filename(id))?);let output=stage.as_mut().ok_or("整合包暂存未建立")?;output.initialize()?;let file=output.take_file()?;
    // write_archive 的 File 始终由此同步 worker 拥有；错误返回也先真正关闭后才能清理。
    let mut file=write_archive(file,&p,&op.cancel,report)?;file.flush().map_err(|_|"整合包 ZIP 刷新失败")?;file.sync_all().map_err(|_|"整合包 ZIP 同步失败")?;drop(file);output.validate(&op.cancel)?;p.verify(&op.cancel)?;
    let mut gate=op.gate.lock().map_err(|_|"整合包发布状态不可用")?;op.cancel.check()?;let path=output.publish()?;gate.committed=true;Ok(path.to_string_lossy().into_owned())
}
fn worker(root:PathBuf,id:String,settings:Value,options:Options,operation:Arc<Operation>,report:Reporter)->(Result<String>,bool){
    let mut stage=None;let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||work(&root,&id,&settings,&options,&operation,&report,&mut stage))).unwrap_or_else(|_|Err("整合包导出后台任务异常，已停止发布".into()));
    let cleanup=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||stage.as_mut().map(Stage::cleanup).unwrap_or(Ok(())))).unwrap_or_else(|_|Err("清理任务异常".into()));
    let unknown=cleanup.is_err();let result=match cleanup{Ok(())=>result,Err(e)=>Err(format!("{}；暂存清理未确认：{e}，目录保持忙碌",result.err().unwrap_or_else(||"整合包已发布".into())))};
    if unknown{std::mem::forget(stage);} (result,unknown)
}
async fn retain_worker(work:tokio::task::JoinHandle<(Result<String>,bool)>,registration:JobGuard,active:Active,guard:RootOperationGuard,operation:Arc<Operation>,report:Reporter)->Result<String>{
    // JoinHandle 不放进 select；IPC drop 仅取消，持有者始终等到真实 worker 收尾。
    let (result,unknown)=work.await.unwrap_or_else(|_|(Err("整合包导出 worker 异常，暂存清理未确认，目录保持忙碌".into()),true));
    report.update(if result.is_ok(){"整合包导出完成"}else{"整合包导出中断"},0,0,0,0,Some(result.is_ok()));registration.complete(result.as_ref().map(|_|()).map_err(Clone::clone));
    if unknown{if let Ok(mut gate)=operation.gate.lock(){gate.sticky=true;}std::mem::forget((registration,active,guard));}else{drop(guard);drop(active);drop(registration);}result
}
pub(super) async fn start(app:&AppHandle,root:&Path,id:&str,options:Options,settings:&Value)->Result<Value>{
    leaf(id)?;let checked=Directory::open(root)?;checked.verify()?;let expected_root=checked.mark();let root=checked.path().to_path_buf();
    let task=format!("modpack-export:{id}");let registration=JobGuard::register(&root,&task)?;let operation=Arc::new(Operation{cancel:registration.cancel(),gate:Mutex::new(Gate::default())});let active=Active(window().lock().map_err(|_|"整合包窗口状态不可用")?.register(task.clone(),operation.clone())?);
    let drop_cancel=CancelOnDrop(operation.clone());let app=app.clone();let report=Reporter{task,title:format!("导出整合包 {id}"),sink:Arc::new(move|payload|{let _=app.emit_to("main","launcher:event",json!({"channel":"modpack:progress","payload":payload}));let _=app.emit_to("main","launcher:event",json!({"channel":"download:progress","payload":payload}));})};let id=id.to_owned();let settings=settings.clone();
    let work=tokio::spawn(async move{let _root_anchor=checked;let cancel=operation.cancel.clone();let guard=match crate::install_lock::acquire(&root,||cancel.check().is_err()).await{Ok(guard)=>guard,Err(e)=>{registration.complete(Err(e.clone()));report.update("整合包导出已取消或无法取得根锁",0,0,0,0,Some(false));return Err(e)}};let worker_operation=operation.clone();let worker_report=report.clone();let handle=tokio::task::spawn_blocking(move||{if let Err(e)=expected_root.verify(){return(Err(e),false);}worker(root,id,settings,options,worker_operation,worker_report)});retain_worker(handle,registration,active,guard,operation,report).await});
    let result=work.await.map_err(|_|"整合包导出调度异常".to_owned())?;drop(drop_cancel);result.map(Value::String)
}

#[cfg(test)] mod tests {
    use super::*;
    use std::{fs,io::{Cursor,SeekFrom},sync::Condvar};
    use zip::ZipArchive;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new()->Self{let root=std::env::temp_dir().join(format!("hcmcl-pack-export-{}",uuid::Uuid::new_v4()));fs::create_dir(&root).unwrap();Self(fs::canonicalize(root).unwrap())}
        fn file(&self,name:&str,data:&[u8]){let path=self.0.join(name);fs::create_dir_all(path.parent().unwrap()).unwrap();fs::write(path,data).unwrap();}
        fn json(&self,id:&str,value:Value){self.file(&format!("versions/{id}/{id}.json"),&serde_json::to_vec(&value).unwrap());}
        fn base(&self){self.json("中文实例",json!({"id":"中文实例","inheritsFrom":"1.21.1","libraries":[{"name":"net.fabricmc:fabric-loader:0.16.9"}]}));self.json("1.21.1",json!({"id":"1.21.1","type":"release","libraries":[]}));}
    }
    impl Drop for Fixture{fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}
    fn options(format:&str)->Value{json!({"format":format,"includeGameSettings":true,"includeModConfigs":true,"includeServersList":true,"worlds":["世界"],"resourcePacks":["Folder","Pack.ZIP"],"includeJei":true,"gunPacks":["Guns.zip"],"includeDisabledMods":true,"schematics":["House.schem"]})}
    fn empty_options(format:&str)->Value{json!({"format":format,"includeGameSettings":false,"includeModConfigs":false,"includeServersList":false,"worlds":[],"resourcePacks":[],"includeJei":false,"gunPacks":[],"includeDisabledMods":false,"schematics":[]})}
    fn reporter()->Reporter{Reporter{sink:Arc::new(|_|{}),task:"fixture".into(),title:"fixture".into()}}
    fn operation()->Arc<Operation>{Arc::new(Operation{cancel:Arc::new(Cancel::default()),gate:Mutex::new(Gate::default())})}
    #[test]fn options_are_exact_and_selection_names_remain_safe(){
        assert!(Options::parse(&options("modrinth")).is_ok());assert!(Options::parse(&empty_options("native")).is_ok());
        for change in [json!({"worlds":["../secret"]}),json!({"resourcePacks":["Pack.zip","pack.zip"]}),json!({"gunPacks":["CON.zip"]}),json!({"format":"curseforge"}),json!({"includeJei":"true"})]{let mut value=options("mcbbs");for (k,v) in change.as_object().unwrap(){value[k]=v.clone();}assert!(Options::parse(&value).is_err());}
        let mut value=options("native");value["confirmed"]=json!(true);assert!(Options::parse(&value).is_err());value.as_object_mut().unwrap().remove("confirmed");value.as_object_mut().unwrap().remove("schematics");assert!(Options::parse(&value).is_err());
    }
    #[test]fn complete_three_format_zip_contains_all_selected_content_and_preserves_source(){
        let f=Fixture::new();f.base();for (name,data) in [("mods/active.jar",b"active".as_slice()),("mods/off.jar.disabled",b"disabled".as_slice()),("mods/sub/ignored.jar",b"skip".as_slice()),("shaderpacks/shader.zip",b"shader".as_slice()),("options.txt",b"settings".as_slice()),("config/sub/test.toml",b"config".as_slice()),("servers.dat",b"servers".as_slice()),("saves/世界/level.dat",b"world".as_slice()),("saves/世界/region/a.mca",b"region".as_slice()),("resourcepacks/Folder/pack.mcmeta",b"{}".as_slice()),("resourcepacks/Pack.ZIP",b"pack".as_slice()),("jei/bookmarks.ini",b"jei".as_slice()),("tacz/Guns.zip",b"guns".as_slice()),("schematics/House.schem",b"schematic".as_slice()),("accounts.dat",b"private-not-exported".as_slice())]{f.file(name,data);}
        let before=fs::metadata(f.0.join("mods/active.jar")).unwrap();
        for format in ["modrinth","mcbbs","native"]{let cancel=Cancel::default();let p=plan(&f.0,"中文实例",&json!({}),&Options::parse(&options(format)).unwrap(),&cancel).unwrap();let bytes=write_archive(Cursor::new(Vec::new()),&p,&cancel,&reporter()).unwrap().into_inner();let mut zip=ZipArchive::new(Cursor::new(bytes)).unwrap();let mut names=Vec::new();for i in 0..zip.len(){names.push(zip.by_index(i).unwrap().name().to_owned());}assert_eq!(names.len(),14);for name in ["overrides/mods/active.jar","overrides/mods/off.jar.disabled","overrides/shaderpacks/shader.zip","overrides/config/sub/test.toml","overrides/options.txt","overrides/servers.dat","overrides/saves/世界/level.dat","overrides/saves/世界/region/a.mca","overrides/resourcepacks/Folder/pack.mcmeta","overrides/resourcepacks/Pack.ZIP","overrides/jei/bookmarks.ini","overrides/tacz/Guns.zip","overrides/schematics/House.schem"]{assert!(names.contains(&name.to_owned()),"{name}");}assert!(!names.iter().any(|name|name.contains("accounts")||name.contains("ignored")));let mut data=String::new();zip.by_name(&p.manifest_name).unwrap().read_to_string(&mut data).unwrap();let manifest:Value=serde_json::from_str(&data).unwrap();if format=="modrinth"{assert_eq!(manifest["dependencies"],json!({"minecraft":"1.21.1","fabric-loader":"*"}));assert_eq!(manifest["files"],json!([]));}else{assert_eq!(manifest["game_version"],"1.21.1");assert_eq!(manifest["mod_loader"],"fabric");if format=="native"{assert_eq!(manifest["format"],"hunger-cat");}}p.verify(&cancel).unwrap();}
        let after=fs::metadata(f.0.join("mods/active.jar")).unwrap();assert_eq!(before.len(),after.len());assert_eq!(before.modified().unwrap(),after.modified().unwrap());assert!(!f.0.join("modpacks").exists());
    }
    #[test]fn real_export_publish_roundtrips_through_current_probe_in_all_three_formats(){
        let f=Fixture::new();f.base();f.file("mods/测试.jar",b"mod content");f.file("shaderpacks/shader.zip",b"shader content");
        for format in ["modrinth","mcbbs","native"]{let op=operation();let mut stage=None;let path=work(&f.0,"中文实例",&json!({}),&Options::parse(&empty_options(format)).unwrap(),&op,&reporter(),&mut stage).unwrap();stage.as_mut().unwrap().cleanup().unwrap();drop(stage);let mut file=fs::File::open(&path).unwrap();let dto=super::super::parser::probe(&mut file,Path::new(&path)).unwrap();assert_eq!(dto["format"],format);assert_eq!(dto["mcVersion"],"1.21.1");assert_eq!(dto["loader"],"fabric");assert!(op.cancel().unwrap_err().contains("不能撤销"));let prior=fs::read(&path).unwrap();let op=operation();let mut second=None;assert!(work(&f.0,"中文实例",&json!({}),&Options::parse(&empty_options(format)).unwrap(),&op,&reporter(),&mut second).is_err());assert_eq!(fs::read(&path).unwrap(),prior);drop(file);drop(second);
            // mcbbs/native 使用同一 .zip 输出名，下一种格式先显式清理本测试自有成品。
            fs::remove_file(&path).unwrap();
        }
    }
    #[test]
    fn bare_official_snapshot_exports_full_version_in_all_three_formats() {
        let f = Fixture::new();
        let id = "26.4-snapshot-1";
        f.json(id, json!({"id": id, "type": "snapshot", "libraries": []}));
        let cancel = Cancel::default();
        let settings = json!({});
        for (format, manifest_name) in [("modrinth", "modrinth.index.json"), ("mcbbs", "mcbbs.packmeta"), ("native", "launcher.packmeta")] {
            let options = Options::parse(&empty_options(format)).unwrap();
            let p = plan(&f.0, id, &settings, &options, &cancel).unwrap();
            let bytes = write_archive(Cursor::new(Vec::new()), &p, &cancel, &reporter()).unwrap();
            let mut zip = ZipArchive::new(bytes).unwrap();
            let manifest: Value = serde_json::from_reader(zip.by_name(manifest_name).unwrap()).unwrap();
            if format == "modrinth" {
                assert_eq!(manifest["versionId"], id);
                assert_eq!(manifest["dependencies"], json!({"minecraft": id}));
            } else {
                assert_eq!(manifest["game_version"], id);
                assert_eq!(manifest["mod_loader"], "vanilla");
            }
            p.verify(&cancel).unwrap();
        }
        let options = Options::parse(&empty_options("native")).unwrap();
        f.json(id, json!({"id": id, "libraries": []}));
        assert!(plan(&f.0, id, &settings, &options, &cancel).is_err());
        let invalid = "26.4-snapshot-1-fabric";
        f.json(invalid, json!({"id": invalid, "type": "snapshot"}));
        assert!(plan(&f.0, invalid, &settings, &options, &cancel).is_err());
        assert!(!f.0.join("modpacks").exists());
    }
    #[test]fn classic_output_capacity_and_entry_budget_fail_instead_of_truncating(){let f=Fixture::new();f.base();let cancel=Cancel::default();let mut p=plan(&f.0,"中文实例",&json!({}),&Options::parse(&empty_options("native")).unwrap(),&cancel).unwrap();let mut writer=Classic{inner:Cursor::new(Vec::new()),position:FILE_CAP};assert!(writer.write(b"x").is_err());let source=p.metadata[0].clone();p.files=(0..50_000).map(|i|Entry{name:format!("overrides/{i}"),source:source.clone()}).collect();assert!(write_archive(Cursor::new(Vec::new()),&p,&cancel,&reporter()).unwrap_err().contains("50000"));}
    #[test]fn isolation_defaults_and_local_metadata_failures_are_real(){
        let f=Fixture::new();f.base();f.file("mods/shared.jar",b"shared");f.file("shaderpacks/shared.zip",b"shared");f.file("versions/中文实例/mods/own.jar",b"own");let cancel=Cancel::default();let options=Options::parse(&empty_options("native")).unwrap();
        let p=plan(&f.0,"中文实例",&json!({}),&options,&cancel).unwrap();assert_eq!(p.files.len(),2);
        for settings in [json!({"versionIsolation":true}),json!({"isolatedVersions":["中文实例"]})]{let p=plan(&f.0,"中文实例",&settings,&options,&cancel).unwrap();assert_eq!(p.files.len(),1);assert_eq!(p.files[0].name,"overrides/mods/own.jar");}
        f.json("bad",json!({"id":"bad"}));assert!(plan(&f.0,"bad",&json!({}),&options,&cancel).is_err());f.json("named",json!({"id":"named","type":"release"}));assert!(plan(&f.0,"named",&json!({}),&options,&cancel).is_err());f.json("explicit",json!({"id":"explicit","clientVersion":"1.20.1","libraries":[{"name":"net.neoforged:neoforge:21.1"},{"name":"net.fabricmc:fabric-loader:0.16"}]}));let explicit=plan(&f.0,"explicit",&json!({}),&options,&cancel).unwrap();let meta:Value=serde_json::from_slice(&explicit.manifest).unwrap();assert_eq!(meta["game_version"],"1.20.1");assert_eq!(meta["mod_loader"],"neoforge");f.json("missing",json!({"id":"missing","inheritsFrom":"not-installed"}));assert!(plan(&f.0,"missing",&json!({}),&options,&cancel).is_err());f.json("cycle",json!({"id":"cycle","inheritsFrom":"cycle"}));assert!(plan(&f.0,"cycle",&json!({}),&options,&cancel).is_err());
        let p=plan(&f.0,"中文实例",&json!({}),&options,&cancel).unwrap();f.file("mods/added.jar",b"new");assert!(p.verify(&cancel).is_err());
    }
    #[test]fn instance_marker_selects_owned_content_and_changes_invalidate_export(){
        let f=Fixture::new();f.base();f.file("mods/shared.jar",b"shared");f.file("versions/中文实例/mods/own.jar",b"own");
        f.file("versions/中文实例/instance.json",br#"{"isolation":true}"#);
        let cancel=Cancel::default();let options=Options::parse(&empty_options("native")).unwrap();
        let p=plan(&f.0,"中文实例",&json!({}),&options,&cancel).unwrap();assert_eq!(p.files.len(),1);assert_eq!(p.files[0].name,"overrides/mods/own.jar");
        f.file("versions/中文实例/instance.json",br#"{"isolation":false}"#);assert!(p.verify(&cancel).is_err());
        let p=plan(&f.0,"中文实例",&json!({}),&options,&cancel).unwrap();assert_eq!(p.files[0].name,"overrides/mods/shared.jar");
    }
    #[test]fn changed_sources_missing_optional_and_budgets_abort_before_publish(){
        let f=Fixture::new();f.base();f.file("mods/a.jar",b"one");let cancel=Cancel::default();let o=Options::parse(&empty_options("modrinth")).unwrap();let p=plan(&f.0,"中文实例",&json!({}),&o,&cancel).unwrap();f.file("mods/a.jar",b"changed");assert!(write_archive(Cursor::new(Vec::new()),&p,&cancel,&reporter()).is_err());
        let p=plan(&f.0,"中文实例",&json!({}),&o,&cancel).unwrap();f.file("shaderpacks/new.zip",b"new");assert!(p.verify(&cancel).is_err());
        let root=Directory::open(&f.0).unwrap();let mods=required(&root,"mods").unwrap();let mut planner=Planner::new();planner.remaining=0;assert!(planner.names(&mods,&cancel).is_err());planner.total=TOTAL_CAP;assert!(planner.file(&mods,"a.jar","overrides/mods/a.jar".into(),&cancel).is_err());
        cancel.stop();assert!(plan(&f.0,"中文实例",&json!({}),&o,&cancel).is_err());assert!(!f.0.join("modpacks").exists());
    }
    struct BlockingSink{inner:Cursor<Vec<u8>>,gate:Arc<(Mutex<(bool,bool)>,Condvar)>}
    impl Write for BlockingSink{fn write(&mut self,bytes:&[u8])->std::io::Result<usize>{let (lock,condition)=&*self.gate;let mut state=lock.lock().unwrap();if !state.0{state.0=true;condition.notify_all();while !state.1{state=condition.wait(state).unwrap();}}drop(state);self.inner.write(bytes)}fn flush(&mut self)->std::io::Result<()>{self.inner.flush()}}
    impl Seek for BlockingSink{fn seek(&mut self,pos:SeekFrom)->std::io::Result<u64>{self.inner.seek(pos)}}
    #[tokio::test]async fn ipc_drop_cancels_but_busy_and_root_guard_survive_until_worker_really_joins(){
        let f=Fixture::new();f.base();f.file("mods/a.jar",b"fixture");let task=format!("fixture-export-{}",uuid::Uuid::new_v4());let registration=JobGuard::register(&f.0,&task).unwrap();let op=Arc::new(Operation{cancel:registration.cancel(),gate:Mutex::new(Gate::default())});let active=Active(window().lock().unwrap().register(task.clone(),op.clone()).unwrap());let guard=crate::install_lock::acquire(&f.0,||false).await.unwrap();let p=plan(&f.0,"中文实例",&json!({}),&Options::parse(&empty_options("native")).unwrap(),&op.cancel).unwrap();let barrier=Arc::new((Mutex::new((false,false)),Condvar::new()));let sink=BlockingSink{inner:Cursor::new(Vec::new()),gate:barrier.clone()};let worker_op=op.clone();let handle=tokio::task::spawn_blocking(move||{let result=write_archive(sink,&p,&worker_op.cancel,&reporter()).map(|_|"fixture".into());(result,false)});let holder=tokio::spawn(retain_worker(handle,registration,active,guard,op.clone(),reporter()));
        // 屏障只在 blocking worker 上等；本测试不靠 sleep 或网络速度猜测写入状态。
        let wait=barrier.clone();tokio::task::spawn_blocking(move||{let(lock,cv)=&*wait;let mut state=lock.lock().unwrap();while !state.0{state=cv.wait(state).unwrap();}}).await.unwrap();drop(CancelOnDrop(op.clone()));let busy=JobGuard::register(&f.0,&task).is_err();let unfinished=!holder.is_finished();let (lock,cv)=&*barrier;lock.lock().unwrap().1=true;cv.notify_all();let result=holder.await.unwrap();assert!(busy);assert!(unfinished);assert!(result.is_err());assert!(JobGuard::register(&f.0,&task).is_ok());assert!(!f.0.join("modpacks").exists());
    }
    struct BlockingFile{inner:std::fs::File,gate:Arc<(Mutex<(bool,bool)>,Condvar)>}
    impl Write for BlockingFile{fn write(&mut self,bytes:&[u8])->std::io::Result<usize>{let(lock,cv)=&*self.gate;let mut state=lock.lock().unwrap();if !state.0{state.0=true;cv.notify_all();while !state.1{state=cv.wait(state).unwrap();}}drop(state);self.inner.write(bytes)}fn flush(&mut self)->std::io::Result<()>{self.inner.flush()}}
    impl Seek for BlockingFile{fn seek(&mut self,pos:SeekFrom)->std::io::Result<u64>{self.inner.seek(pos)}}
    #[tokio::test]async fn real_stage_remains_owned_during_blocked_io_then_cancel_cleanup_finishes(){
        let f=Fixture::new();f.base();f.file("mods/a.jar",b"fixture");let task=format!("real-stage-export-{}",uuid::Uuid::new_v4());let registration=JobGuard::register(&f.0,&task).unwrap();let op=Arc::new(Operation{cancel:registration.cancel(),gate:Mutex::new(Gate::default())});let active=Active(window().lock().unwrap().register(task.clone(),op.clone()).unwrap());let guard=crate::install_lock::acquire(&f.0,||false).await.unwrap();let p=plan(&f.0,"中文实例",&json!({}),&Options::parse(&empty_options("native")).unwrap(),&op.cancel).unwrap();let mut stage=Stage::new(&p.root,"cancelled.zip").unwrap();stage.initialize().unwrap();let barrier=Arc::new((Mutex::new((false,false)),Condvar::new()));let file=BlockingFile{inner:stage.take_file().unwrap(),gate:barrier.clone()};let worker_op=op.clone();let handle=tokio::task::spawn_blocking(move||{let result=write_archive(file,&p,&worker_op.cancel,&reporter()).map(|_|"unpublished".into());let cleanup=stage.cleanup();match cleanup{Ok(())=>(result,false),Err(e)=>(Err(e),true)}});let holder=tokio::spawn(retain_worker(handle,registration,active,guard,op.clone(),reporter()));let wait=barrier.clone();tokio::task::spawn_blocking(move||{let(lock,cv)=&*wait;let mut state=lock.lock().unwrap();while !state.0{state=cv.wait(state).unwrap();}}).await.unwrap();drop(CancelOnDrop(op.clone()));let busy=JobGuard::register(&f.0,&task).is_err();let staged=fs::read_dir(f.0.join("modpacks")).unwrap().count()==1;let unfinished=!holder.is_finished();let(lock,cv)=&*barrier;lock.lock().unwrap().1=true;cv.notify_all();let result=holder.await.unwrap();assert!(busy&&staged&&unfinished);assert!(result.is_err());assert!(JobGuard::register(&f.0,&task).is_ok());assert_eq!(fs::read_dir(f.0.join("modpacks")).unwrap().count(),0);assert!(!f.0.join("modpacks/cancelled.zip").exists());
    }
    #[test]fn close_drop_and_explicit_cancel_never_wait_for_a_held_publish_gate(){
        use std::sync::{Barrier,mpsc};
        let op=operation();let mut state=Window::default();state.register("held".into(),op.clone()).unwrap();
        let entered=Arc::new(Barrier::new(2));let release=Arc::new(Barrier::new(2));let held=op.clone();let ready=entered.clone();let finish=release.clone();
        let holder=std::thread::spawn(move||{let _gate=held.gate.lock().unwrap();ready.wait();finish.wait();});entered.wait();
        let (tx,rx)=mpsc::channel();let cancel=op.clone();let caller=std::thread::spawn(move||{state.close();drop(CancelOnDrop(cancel.clone()));let result=cancel.cancel();let late_rejected=state.register("late".into(),operation()).is_err();let _=tx.send((state.closed,late_rejected,result));});
        // 即使旧实现回归为阻塞，也先释放屏障并 join，避免失败夹具遗留挂起线程。
        let before_release=rx.recv_timeout(Duration::from_secs(2));let signalled=op.cancel.check().is_err();release.wait();holder.join().unwrap();caller.join().unwrap();
        let (closed,late_rejected,result)=before_release.expect("close/drop/显式取消必须在发布门释放前返回");assert!(closed&&late_rejected&&signalled);assert_eq!(result.unwrap_err(),"发布正在提交，取消不能保证撤销");
    }
    #[test]fn window_close_rejects_late_registration_and_postcommit_cancel_is_honest(){let mut state=Window::default();let first=operation();state.register("first".into(),first.clone()).unwrap();state.close();assert!(first.cancel.check().is_err());assert!(state.register("late".into(),operation()).is_err());let committed=operation();committed.gate.lock().unwrap().committed=true;assert!(committed.cancel().unwrap_err().contains("不能撤销"));}
    #[cfg(unix)]#[test]fn source_links_and_renamed_ancestors_are_never_followed(){use std::os::unix::fs::symlink;let f=Fixture::new();f.base();f.file("secret",b"private");fs::create_dir(f.0.join("mods")).unwrap();symlink(f.0.join("secret"),f.0.join("mods/link.jar")).unwrap();let cancel=Cancel::default();let o=Options::parse(&empty_options("native")).unwrap();assert!(plan(&f.0,"中文实例",&json!({}),&o,&cancel).is_err());fs::remove_file(f.0.join("mods/link.jar")).unwrap();f.file("mods/a.jar",b"one");let p=plan(&f.0,"中文实例",&json!({}),&o,&cancel).unwrap();fs::rename(f.0.join("mods"),f.0.join("moved")).unwrap();f.file("mods/a.jar",b"replacement");assert!(p.verify(&cancel).is_err());assert_eq!(fs::read(f.0.join("secret")).unwrap(),b"private");}
}

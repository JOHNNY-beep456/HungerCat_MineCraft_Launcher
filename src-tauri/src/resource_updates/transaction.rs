//! 资源文件的有界持久事务。调用者持有 install_lock；本模块不再次取锁。
//! 所有变更使用父目录句柄和单个 leaf。不是多文件原子提交，也不是同 UID 叶 inode CAS。
//! Err 后 journal 可能仍存在：host 必须保留 root/Gate，直到恢复与 cleanup 真正完成。
use super::access;
use access::Directory;
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Digest, Sha512};
use std::{cell::Cell, collections::BTreeSet, fs::File, io::{Read, Seek, SeekFrom, Write}, path::{Component, Path}, sync::atomic::{AtomicBool, Ordering}};
mod native;
type Result<T> = std::result::Result<T, String>;
const JOURNAL_ROOT:&str=".hcmcl-resource-updates";
const INTENT:&str="intent.json";
const WAL:&str="wal.jsonl";
const MAX_JOURNALS:usize=64;
const MAX_CHANGES:usize=4096;
const MAX_FILE:u64=2*1024*1024*1024;
const MAX_TOTAL:u64=16*1024*1024*1024;
const MAX_INTENT:u64=8*1024*1024;
const MAX_WAL:u64=64*1024*1024;
const MAX_RECORDS:usize=MAX_CHANGES*16+8;

#[derive(Clone,Debug,Serialize,Deserialize,PartialEq,Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct OldFile {pub(crate) leaf:String,pub(crate) size:u64,pub(crate) sha512:String}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq,Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct NewFile {pub(crate) leaf:String,pub(crate) size:u64,pub(crate) sha1:Option<String>,pub(crate) sha512:Option<String>}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq,Eq)]
pub(crate) enum Change {Replace{old:OldFile,new:NewFile},Install{new:NewFile},Enable{old:OldFile,target_leaf:String}}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq,Eq)]
#[serde(deny_unknown_fields)]
struct Identity {volume:u64,number:u64}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq,Eq)]
#[serde(deny_unknown_fields)]
struct Evidence {id:Identity,size:u64,sha1:String,sha512:String}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct Slot {old:Option<Evidence>,part:Option<Identity>}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {version:u32,uuid:String,root:Identity,directory:String,directory_id:Identity,journal_root:Identity,journal:Identity,wal:Identity,changes:Vec<Change>,slots:Vec<Slot>}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq,Eq)]
#[serde(deny_unknown_fields)]
struct Location {journal:bool,leaf:String}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq,Eq)]
#[serde(deny_unknown_fields)]
struct Move {id:usize,from:Location,to:Location,evidence:Evidence}
#[derive(Clone,Debug,Serialize,Deserialize)]
enum Record {Seal{index:usize,evidence:Evidence},Intent(Move),Applied{ id:usize },UndoIntent{id:usize},Undone{id:usize},Committed,RolledBack,ClosingPrepared{file:Identity}}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct Line {seq:usize,record:Record}
#[derive(Clone,Copy,PartialEq,Eq)]
enum Phase {Open,Committed,RolledBack,Unknown,Cleaned}
struct State {sealed:Vec<Option<Evidence>>,moves:Vec<Move>,applied:BTreeSet<usize>,undone:BTreeSet<usize>,undoing:BTreeSet<usize>,committed:bool,rolled_back:bool,records:usize,closing:Option<Identity>}
pub(crate) struct UpdateStage {root:Directory,directory:Directory,journal_root:Directory,journal:Option<Directory>,intent:Intent,taken:BTreeSet<usize>,phase:Phase,wal_seq:Cell<usize>,wal_len:Cell<u64>}
#[derive(Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct Closing {intent:Intent,sealed:Vec<Option<Evidence>>,committed:bool,intent_file:Evidence,wal_file:Evidence}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct Creation {version:u32,uuid:String,root:Identity,directory:String,directory_id:Identity,journal_root:Identity,journal:Option<Identity>,changes:Vec<Change>}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct CreationBound {version:u32,uuid:String,journal:Identity}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct CreationPart {version:u32,uuid:String,index:usize,journal:Identity,part:Identity}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct CreationWal {version:u32,uuid:String,journal:Identity,wal:Identity}
fn closing_name(uuid:&str)->String{format!("done-{uuid}.json")}
fn closing_temp_name(uuid:&str)->String{format!("done-tmp-{uuid}.json")}
fn creation_name(uuid:&str)->String{format!("create-{uuid}.json")}
fn creation_bound_name(uuid:&str)->String{format!("create-bound-{uuid}.json")}
fn creation_bound_temp_name(uuid:&str)->String{format!("create-bound-tmp-{uuid}.json")}
fn creation_part_name(index:usize)->String{format!("create-part-{index:08}.json")}
fn creation_part_temp_name(index:usize)->String{format!("create-part-tmp-{index:08}.json")}
fn creation_temp_name(uuid:&str)->String{format!("create-tmp-{uuid}.json")}
fn creation_wal_name()->&'static str{"create-wal.json"}

fn cancelled(token:&AtomicBool)->Result<()> {if token.load(Ordering::Acquire){Err("资源更新事务已取消".into())}else{Ok(())}}
fn digest(value:&str,len:usize)->bool{value.len()==len&&value.bytes().all(|v|v.is_ascii_hexdigit())}
fn part(index:usize)->String{format!("part-{index:08}.bin")}
fn backup(index:usize)->String{format!("backup-{index:08}.bin")}
fn identity(file:&File,directory:bool)->Result<Identity>{
    let meta=file.metadata().map_err(|_|"事务文件状态读取失败")?;
    if access::linked(&meta)||(if directory{!meta.is_dir()}else{!meta.is_file()}){return Err("事务项类型或链接状态改变".into());}
    #[cfg(unix)]{use std::os::unix::fs::MetadataExt;if !directory&&meta.nlink()!=1{return Err("事务不接受多硬链接文件".into());}Ok(Identity{volume:meta.dev(),number:meta.ino()})}
    #[cfg(windows)]{use std::{ffi::c_void,os::windows::io::AsRawHandle};
        #[repr(C)]struct Info{attrs:u32,created:[u32;2],accessed:[u32;2],modified:[u32;2],volume:u32,high_size:u32,low_size:u32,links:u32,high:u32,low:u32}
        #[link(name="kernel32")]extern "system"{fn GetFileInformationByHandle(file:*mut c_void,info:*mut Info)->i32;}
        let mut info:Info=unsafe{std::mem::zeroed()};
        if unsafe{GetFileInformationByHandle(file.as_raw_handle(),&mut info)}==0||(!directory&&info.links!=1){return Err("无法确认事务文件身份或硬链接数量".into());}
        Ok(Identity{volume:info.volume as u64,number:((info.high as u64)<<32)|info.low as u64})}
    #[cfg(not(any(unix,windows)))]{Err("当前平台缺少事务文件身份支持".into())}
}
fn check_directory(directory:&Directory,expected:&Identity)->Result<()>{directory.verify()?;if identity(directory.handle(),true)?!=*expected{return Err("事务目录身份改变，保留现场".into());}Ok(())}
fn hash(file:&mut File,size:u64,token:Option<&AtomicBool>)->Result<Evidence>{
    if size>MAX_FILE{return Err("事务文件超过 2 GiB".into());}
    let id=identity(file,false)?;let before=file.metadata().map_err(|_|"事务文件状态读取失败")?;
    if before.len()!=size{return Err("事务文件大小不符".into());}
    let before_modified=before.modified().map_err(|_|"事务文件修改时间不可用")?;
    file.seek(SeekFrom::Start(0)).map_err(|_|"事务文件无法定位")?;
    let mut sha1=Sha1::new();let mut sha512=Sha512::new();let mut count=0u64;let mut bytes=[0u8;65536];
    loop{if let Some(token)=token{cancelled(token)?;}let n=file.read(&mut bytes).map_err(|_|"事务文件读取失败")?;if n==0{break;}count=count.checked_add(n as u64).ok_or("事务文件大小溢出")?;if count>size{return Err("事务文件校验时增大".into());}sha1.update(&bytes[..n]);sha512.update(&bytes[..n]);}
    let after=file.metadata().map_err(|_|"事务文件状态复核失败")?;
    if count!=size||after.len()!=size||identity(file,false)?!=id||before_modified!=after.modified().map_err(|_|"事务文件修改时间不可用")?{return Err("事务文件校验期间改变".into());}
    Ok(Evidence{id,size,sha1:format!("{:x}",sha1.finalize()),sha512:format!("{:x}",sha512.finalize())})
}
fn opened(parent:&Directory,leaf:&str,writable:bool,delete:bool)->Result<File>{native::open(parent,leaf,false,writable,delete).map_err(|e|format!("无法安全打开事务文件：{e}"))}
fn evidence(parent:&Directory,leaf:&str,size:u64,token:Option<&AtomicBool>)->Result<Evidence>{let mut file=opened(parent,leaf,false,false)?;hash(&mut file,size,token)}
fn matches(parent:&Directory,leaf:&str,expected:&Evidence)->Result<bool>{
    match native::open(parent,leaf,false,false,false){Ok(mut file)=>Ok(hash(&mut file,expected.size,None)?==*expected),Err(e)if e.kind()==std::io::ErrorKind::NotFound=>Ok(false),Err(e)=>Err(format!("无法复核事务项：{e}"))}
}
fn absent(parent:&Directory,leaf:&str)->Result<bool>{Ok(parent.child(leaf)?.is_none())}
fn new_file(change:&Change)->Option<&NewFile>{match change{Change::Replace{new,..}|Change::Install{new}=>Some(new),_=>None}}
fn old_file(change:&Change)->Option<&OldFile>{match change{Change::Replace{old,..}|Change::Enable{old,..}=>Some(old),_=>None}}
fn target(change:&Change)->&str{match change{Change::Replace{new,..}|Change::Install{new}=>&new.leaf,Change::Enable{target_leaf,..}=>target_leaf}}
fn validate_changes(changes:&[Change])->Result<()> {
    if changes.is_empty()||changes.len()>MAX_CHANGES{return Err("事务变更数量无效".into());}
    let mut used=BTreeSet::new();let mut total=0u64;let mut old_total=0u64;
    for change in changes{
        let output=target(change);access::leaf(output)?;
        if !used.insert(output.to_lowercase()){return Err("事务含重复文件或交叉目标".into());}
        if let Some(old)=old_file(change){access::leaf(&old.leaf)?;if old.size>MAX_FILE||!digest(&old.sha512,128){return Err("旧文件证据无效".into());}old_total=old_total.checked_add(old.size).ok_or("旧资源总量溢出")?;if old_total>MAX_TOTAL{return Err("旧资源总量超过 16 GiB".into());}if old.leaf!=output&&!used.insert(old.leaf.to_lowercase()){return Err("事务旧文件与其它变更冲突".into());}if old.leaf!=output&&old.leaf.eq_ignore_ascii_case(output){return Err("事务文件大小写别名冲突".into());}}
        if let Some(new)=new_file(change){if new.size>MAX_FILE||new.sha1.as_ref().is_some_and(|v|!digest(v,40))||new.sha512.as_ref().is_some_and(|v|!digest(v,128))||(new.sha1.is_none()&&new.sha512.is_none()){return Err("新文件大小或摘要无效".into());}total=total.checked_add(new.size).ok_or("事务总量溢出")?;}
    }if total>MAX_TOTAL{return Err("事务下载总量超过 16 GiB".into());}Ok(())
}
fn resource_parts(relative:&str)->Result<Vec<&str>>{
    if relative.len()>4096{return Err("事务路径过长".into());}let parts=relative.split('/').collect::<Vec<_>>();for name in &parts{access::leaf(name)?;}
    if !(parts.len()==1&&["mods","resourcepacks","shaderpacks"].contains(&parts[0])||parts.len()==3&&parts[0]=="versions"&&["mods","resourcepacks","shaderpacks"].contains(&parts[2])){return Err("事务目录不是允许的实例资源目录".into());}Ok(parts)
}
fn relative(root:&Path,directory:&Path)->Result<String>{
    let path=directory.strip_prefix(root).map_err(|_|"事务目录不在游戏根目录")?;let mut parts=Vec::new();
    for item in path.components(){match item{Component::Normal(v)=>parts.push(v.to_str().ok_or("事务路径不是 UTF-8")?),_=>return Err("事务路径含相对跳转".into())}}
    let text=parts.join("/");resource_parts(&text)?;Ok(text)
}
fn descend(root:&Directory,relative:&str)->Result<Directory>{let mut directory=root.clone();for leaf in resource_parts(relative)?{let node=directory.child(leaf)?.ok_or("事务资源目录不存在")?;directory=directory.directory(node)?;}Ok(directory)}
fn child_directory(parent:&Directory,leaf:&str)->Result<Option<Directory>>{match parent.child(leaf)?{Some(node)=>Ok(Some(parent.directory(node)?)),None=>Ok(None)}}
fn ensure_directory(parent:&Directory,leaf:&str)->Result<Directory>{if let Some(directory)=child_directory(parent,leaf)?{return Ok(directory);}let file=native::mkdir(parent,leaf)?;let expected=identity(&file,true)?;drop(file);native::sync(parent)?;let directory=child_directory(parent,leaf)?.ok_or("事务目录创建后消失")?;check_directory(&directory,&expected)?;Ok(directory)}
fn read_bounded(parent:&Directory,leaf:&str,limit:u64)->Result<Vec<u8>>{
    let mut file=opened(parent,leaf,false,false)?;let id=identity(&file,false)?;let size=file.metadata().map_err(|_|"journal 状态读取失败")?.len();if size>limit{return Err("journal 超过读取预算".into());}
    let mut data=Vec::with_capacity(size as usize);Read::by_ref(&mut file).take(limit+1).read_to_end(&mut data).map_err(|_|"journal 读取失败")?;
    if data.len()as u64!=size||identity(&file,false)?!=id{return Err("journal 读取期间改变".into());}Ok(data)
}
fn write_synced(parent:&Directory,leaf:&str,bytes:&[u8])->Result<Identity>{let mut file=native::create(parent,leaf)?;let id=identity(&file,false)?;file.write_all(bytes).map_err(|_|"journal 写入失败")?;file.sync_all().map_err(|_|"journal 文件同步失败")?;drop(file);native::sync(parent)?;Ok(id)}
fn write_atomic_marker(parent:&Directory,temp:&str,final_name:&str,bytes:&[u8])->Result<Identity>{
    let mut file=native::create(parent,temp)?;file.write_all(bytes).map_err(|_|"事务临时标记写入失败")?;file.sync_all().map_err(|_|"事务临时标记同步失败")?;drop(file);native::sync(parent)?;
    let source=opened(parent,temp,false,true)?;let id=identity(&source,false)?;native::rename(parent,temp,&source,parent,final_name)?;drop(source);native::sync(parent)?;Ok(id)
}
fn remove_verified(parent:&Directory,leaf:&str,expected:&Evidence)->Result<()> {
    let mut file=opened(parent,leaf,false,true)?;if hash(&mut file,expected.size,None)?!=*expected{return Err("初始化凭据身份或内容改变".into());}
    native::remove_file(parent,leaf,file)?;native::sync(parent)
}
fn json_marker<T:serde::de::DeserializeOwned>(parent:&Directory,name:&str)->Result<(T,Evidence)> {
    let raw=read_bounded(parent,name,MAX_INTENT)?;let evidence=evidence(parent,name,raw.len()as u64,None)?;
    let value=serde_json::from_slice(&raw).map_err(|_|"初始化凭据不完整，保留现场")?;Ok((value,evidence))
}
/// 只有持久凭据指向的目录与文件才可清理；未绑定的创建窗口保持封闭。
fn clear_creation(root:&Directory,journal_root:&Directory,uuid:&str)->Result<()> {
    if uuid::Uuid::parse_str(uuid).is_err(){return Err("初始化 UUID 无效".into());}
    let name=creation_name(uuid);let (creation,proof):(Creation,Evidence)=json_marker(journal_root,&name)?;
    if creation.version!=1||creation.uuid!=uuid||creation.journal.is_some(){return Err("初始化凭据版本无效".into());}
    validate_changes(&creation.changes)?;check_directory(root,&creation.root)?;check_directory(journal_root,&creation.journal_root)?;
    let directory=descend(root,&creation.directory)?;check_directory(&directory,&creation.directory_id)?;
    let bound_name=creation_bound_name(uuid);
    let bound=if absent(journal_root,&bound_name)?{None}else{let(value,e):(CreationBound,Evidence)=json_marker(journal_root,&bound_name)?;if value.version!=1||value.uuid!=uuid{return Err("初始化目录绑定不符".into());}Some((value,e))};
    let Some(journal)=child_directory(journal_root,uuid)?else{
        if let Some((_,e))=bound{remove_verified(journal_root,&bound_name,&e)?;}return remove_verified(journal_root,&name,&proof);
    };
    let initialized=if absent(&journal,INTENT)?{None}else{let(value,_):(Intent,Evidence)=json_marker(&journal,INTENT)?;validate_intent(&value)?;
        if value.uuid!=uuid||value.root!=creation.root||value.directory!=creation.directory||value.directory_id!=creation.directory_id||value.journal_root!=creation.journal_root||value.changes!=creation.changes{return Err("完整意图与初始化凭据不符".into());}Some(value)};
    let journal_id=initialized.as_ref().map(|i|&i.journal).or_else(||bound.as_ref().map(|(b,_)|&b.journal)).ok_or("初始化目录尚无身份绑定，保留现场")?;
    check_directory(&journal,journal_id)?;
    if bound.as_ref().is_some_and(|(b,_)|b.journal!=*journal_id){return Err("初始化目录绑定改变".into());}
    let mut receipts=Vec::<(String,Evidence)>::new();let mut owned=Vec::<(String,Evidence)>::new();let mut allowed=BTreeSet::new();
    if initialized.is_some(){allowed.insert(INTENT.to_owned());}
    for(index,change)in creation.changes.iter().enumerate(){if new_file(change).is_some(){
        let part_name=part(index);let receipt_name=creation_part_name(index);allowed.insert(part_name.clone());allowed.insert(receipt_name.clone());
        let receipt=if absent(&journal,&receipt_name)?{None}else{let(value,e):(CreationPart,Evidence)=json_marker(&journal,&receipt_name)?;
            if value.version!=1||value.uuid!=uuid||value.index!=index||value.journal!=*journal_id{return Err("初始化下载槽凭据不符".into());}receipts.push((receipt_name,e));Some(value.part)};
        let expected=initialized.as_ref().and_then(|i|i.slots[index].part.as_ref()).or(receipt.as_ref());
        if !absent(&journal,&part_name)?{let expected=expected.ok_or("初始化下载槽尚无身份绑定，保留现场")?;
            let e=evidence(&journal,&part_name,0,None)?;if e.id!=*expected{return Err("初始化下载槽身份改变".into());}if initialized.is_none(){owned.push((part_name,e));}}
        else if initialized.is_some(){return Err("完整意图缺少初始化下载槽".into());}
    }}
    allowed.insert(WAL.to_owned());allowed.insert(creation_wal_name().to_owned());
    let wal_receipt=if absent(&journal,creation_wal_name())?{None}else{let(value,e):(CreationWal,Evidence)=json_marker(&journal,creation_wal_name())?;
        if value.version!=1||value.uuid!=uuid||value.journal!=*journal_id{return Err("初始化 WAL 凭据不符".into());}receipts.push((creation_wal_name().into(),e));Some(value.wal)};
    if !absent(&journal,WAL)?{let expected=initialized.as_ref().map(|i|&i.wal).or(wal_receipt.as_ref()).ok_or("初始化 WAL 尚无身份绑定，保留现场")?;
        let e=evidence(&journal,WAL,0,None)?;if e.id!=*expected{return Err("初始化 WAL 身份改变".into());}if initialized.is_none(){owned.push((WAL.into(),e));}}
    else if initialized.is_some(){return Err("完整意图缺少初始化 WAL".into());}
    let mut budget=MAX_CHANGES*2+4;for leaf in journal.names(&mut budget)?{if !allowed.contains(&leaf){return Err("初始化目录含未绑定项目，保留现场".into());}}
    // 完整预检后才开始清理；完整意图已发布时保留空槽，交正常事务恢复。
    for(leaf,e)in owned{remove_verified(&journal,&leaf,&e)?;}for(leaf,e)in receipts{remove_verified(&journal,&leaf,&e)?;}
    if initialized.is_none(){let expected=journal_id.clone();drop(journal);native::remove_dir(journal_root,uuid,&expected)?;native::sync(journal_root)?;}
    if let Some((_,e))=bound{remove_verified(journal_root,&bound_name,&e)?;}remove_verified(journal_root,&name,&proof)
}
fn location(journal:bool,leaf:String)->Location{Location{journal,leaf}}
fn planned_moves(intent:&Intent,sealed:&[Option<Evidence>])->Result<Vec<Move>>{
    let mut moves=Vec::new();
    for(index,change)in intent.changes.iter().enumerate(){
        if let Some(old)=old_file(change){let item=intent.slots[index].old.clone().ok_or("journal 缺少旧文件身份")?;moves.push(Move{id:moves.len(),from:location(false,old.leaf.clone()),to:location(true,backup(index)),evidence:item});}
        match change{
            Change::Replace{new,..}|Change::Install{new}=>{let item=sealed[index].clone().ok_or("事务下载未封存")?;moves.push(Move{id:moves.len(),from:location(true,part(index)),to:location(false,new.leaf.clone()),evidence:item});}
            Change::Enable{target_leaf,..}=>{let item=intent.slots[index].old.clone().ok_or("journal 缺少启用文件")?;moves.push(Move{id:moves.len(),from:location(true,backup(index)),to:location(false,target_leaf.clone()),evidence:item});}
        }
    }Ok(moves)
}
fn validate_intent(intent:&Intent)->Result<()> {
    if intent.version!=2||uuid::Uuid::parse_str(&intent.uuid).is_err()||intent.slots.len()!=intent.changes.len()||intent.directory_id.volume!=intent.journal.volume{return Err("journal 版本、卷或结构无效".into());}resource_parts(&intent.directory)?;validate_changes(&intent.changes)?;
    for(index,change)in intent.changes.iter().enumerate(){let slot=&intent.slots[index];if slot.old.is_some()!=old_file(change).is_some()||slot.part.is_some()!=new_file(change).is_some(){return Err("journal 槽结构无效".into());}if let(Some(old),Some(e))=(old_file(change),&slot.old){if e.size!=old.size||!e.sha512.eq_ignore_ascii_case(&old.sha512)||!digest(&e.sha1,40){return Err("journal 旧文件证据不符".into());}}}Ok(())
}
fn wal_prefix(bytes:&[u8])->Result<usize>{
    let valid=bytes.iter().rposition(|b|*b==b'\n').map_or(0,|at|at+1);
    if bytes.len()-valid>16384{return Err("WAL 尾部超过单记录预算".into());}Ok(valid)
}
fn validate_sealed(intent:&Intent,sealed:&[Option<Evidence>],complete:bool)->Result<()> {
    if sealed.len()!=intent.changes.len(){return Err("封存证据数量无效".into());}
    for(index,change)in intent.changes.iter().enumerate(){match(new_file(change),&sealed[index]){
        (Some(new),Some(e))=>{if Some(&e.id)!=intent.slots[index].part.as_ref()||e.size!=new.size||!digest(&e.sha1,40)||!digest(&e.sha512,128)||new.sha1.as_ref().is_some_and(|v|!v.eq_ignore_ascii_case(&e.sha1))||new.sha512.as_ref().is_some_and(|v|!v.eq_ignore_ascii_case(&e.sha512)){return Err("封存证据与固定计划不符".into());}},
        (Some(_),None)if complete=>return Err("提交终态缺少封存文件".into()),
        (None,Some(_))=>return Err("启用操作不能有下载槽".into()),_=>{},
    }}Ok(())
}
fn read_state(journal:&Directory,intent:&Intent)->Result<State>{
    let bytes=read_bounded(journal,WAL,MAX_WAL)?;
    let file=opened(journal,WAL,false,false)?;if identity(&file,false)?!=intent.wal{return Err("WAL 身份改变".into());}drop(file);
    let valid=wal_prefix(&bytes)?;
    let mut planned:Option<Vec<Move>>=None;
    let mut state=State{sealed:vec![None;intent.changes.len()],moves:Vec::new(),applied:BTreeSet::new(),undone:BTreeSet::new(),undoing:BTreeSet::new(),committed:false,rolled_back:false,records:0,closing:None};
    for line in bytes[..valid].split(|b|*b==b'\n').filter(|v|!v.is_empty()){
        if line.len()>16384||state.records>=MAX_RECORDS{return Err("WAL 记录超过预算".into());}let line:Line=serde_json::from_slice(line).map_err(|_|"WAL 记录格式无效")?;if line.seq!=state.records{return Err("WAL 顺序无效".into());}state.records+=1;
        if let Record::ClosingPrepared{file}=&line.record {
            if !(state.committed||state.rolled_back)||state.closing.is_some(){return Err("WAL 清理准备顺序无效".into());}
            state.closing=Some(file.clone());continue;
        }
        if state.committed||state.rolled_back{return Err("WAL 终态后仍有操作".into());}
        match line.record{
            Record::Seal{index,evidence}=>{let new=intent.changes.get(index).and_then(new_file).ok_or("WAL 封存索引无效")?;if !state.moves.is_empty()||state.sealed[index].is_some()||Some(&evidence.id)!=intent.slots[index].part.as_ref()||evidence.size!=new.size||!digest(&evidence.sha1,40)||!digest(&evidence.sha512,128)||new.sha1.as_ref().is_some_and(|v|!v.eq_ignore_ascii_case(&evidence.sha1))||new.sha512.as_ref().is_some_and(|v|!v.eq_ignore_ascii_case(&evidence.sha512)){return Err("WAL 封存证据无效".into());}state.sealed[index]=Some(evidence);}
            Record::Intent(movement)=>{if planned.is_none(){planned=Some(planned_moves(intent,&state.sealed)?);}let expected=planned.as_ref().ok_or("WAL 计划缺失")?;if !state.undoing.is_empty()||expected.get(state.moves.len())!=Some(&movement)||(state.moves.len()>0&&!state.applied.contains(&(state.moves.len()-1))){return Err("WAL 移动意图无效".into());}state.moves.push(movement);}
            Record::Applied{id}=>{if state.moves.last().map(|m|m.id)!=Some(id)||!state.applied.insert(id)||!state.undoing.is_empty(){return Err("WAL applied 顺序无效".into());}}
            Record::UndoIntent{id}=>{if id>=state.moves.len()||state.undone.contains(&id)||!state.undoing.insert(id)||((id+1)..state.moves.len()).any(|i|!state.undone.contains(&i)){return Err("WAL 回滚顺序无效".into());}}
            Record::Undone{id}=>{if !state.undoing.contains(&id)||!state.undone.insert(id){return Err("WAL 回滚完成记录无效".into());}}
            Record::Committed=>{let count=planned.as_ref().ok_or("WAL 尚无移动计划")?.len();if state.moves.len()!=count||state.applied.len()!=count||!state.undoing.is_empty(){return Err("WAL 提交记录不完整".into());}state.committed=true;}
            Record::RolledBack=>{if state.undone.len()!=state.moves.len(){return Err("WAL 回滚记录不完整".into());}state.rolled_back=true;}
            Record::ClosingPrepared{..}=>unreachable!(),
        }
    }Ok(state)
}

impl UpdateStage{
    pub(crate) fn create(root:&Path,directory:&Path,changes:Vec<Change>,token:&AtomicBool)->Result<Self>{
        cancelled(token)?;validate_changes(&changes)?;let relative=relative(root,directory)?;
        let root=Directory::open(root)?;let directory=descend(&root,&relative)?;
        let mut slots=Vec::new();
        for change in &changes{cancelled(token)?;let old=if let Some(old)=old_file(change){let e=evidence(&directory,&old.leaf,old.size,Some(token))?;if !e.sha512.eq_ignore_ascii_case(&old.sha512){return Err("旧资源摘要改变，请重新检测".into());}Some(e)}else{None};
            if old_file(change).map(|old|old.leaf.as_str())!=Some(target(change))&&!absent(&directory,target(change))?{return Err("资源更新目标已经存在".into());}slots.push(Slot{old,part:None});}
        let journal_root=ensure_directory(&root,JOURNAL_ROOT)?;
        let mut budget=MAX_JOURNALS*2;let names=journal_root.names(&mut budget)?;if !names.is_empty(){return Err("存在待恢复事务，请先恢复".into());}
        let uuid=uuid::Uuid::new_v4().to_string();
        let creation=Creation{version:1,uuid:uuid.clone(),root:identity(root.handle(),true)?,directory:relative.clone(),directory_id:identity(directory.handle(),true)?,journal_root:identity(journal_root.handle(),true)?,journal:None,changes:changes.clone()};
        write_atomic_marker(&journal_root,&creation_temp_name(&uuid),&creation_name(&uuid),&serde_json::to_vec(&creation).map_err(|_|"创建凭据编码失败")?)?;
        let created=native::mkdir(&journal_root,&uuid)?;let journal_id=identity(&created,true)?;drop(created);
        let bound=CreationBound{version:1,uuid:uuid.clone(),journal:journal_id.clone()};
        write_atomic_marker(&journal_root,&creation_bound_temp_name(&uuid),&creation_bound_name(&uuid),&serde_json::to_vec(&bound).map_err(|_|"创建目录凭据编码失败")?)?;
        // 初始化中延后取消，先完成可恢复意图；普通 I/O 失败保留逐槽身份凭据。
        #[cfg(test)] test_init_fault()?;
        native::sync(&journal_root)?;let journal=child_directory(&journal_root,&uuid)?.ok_or("新事务目录消失，状态未确认")?;check_directory(&journal,&journal_id)?;
        let mut stage=Self{root,directory,journal_root,journal:Some(journal),intent:Intent{version:2,uuid,directory:relative,root:Identity{volume:0,number:0},directory_id:Identity{volume:0,number:0},journal_root:Identity{volume:0,number:0},journal:journal_id,wal:Identity{volume:0,number:0},changes,slots},taken:BTreeSet::new(),phase:Phase::Open,wal_seq:Cell::new(0),wal_len:Cell::new(0)};
        stage.intent.root=identity(stage.root.handle(),true)?;stage.intent.directory_id=identity(stage.directory.handle(),true)?;stage.intent.journal_root=identity(stage.journal_root.handle(),true)?;
        if stage.intent.directory_id.volume!=stage.intent.journal.volume{return Err("事务 journal 与资源目录必须在同一卷".into());}
        for index in 0..stage.intent.changes.len(){if new_file(&stage.intent.changes[index]).is_some(){let file=native::create(stage.journal()?,&part(index))?;let id=identity(&file,false)?;file.sync_all().map_err(|_|"下载槽同步失败")?;drop(file);
            let receipt=CreationPart{version:1,uuid:stage.intent.uuid.clone(),index,journal:stage.intent.journal.clone(),part:id.clone()};
            write_atomic_marker(stage.journal()?,&creation_part_temp_name(index),&creation_part_name(index),&serde_json::to_vec(&receipt).map_err(|_|"下载槽凭据编码失败")?)?;
            stage.intent.slots[index].part=Some(id);#[cfg(test)] test_init_fault()?;}}
        stage.intent.wal=write_synced(stage.journal()?,WAL,b"")?;
        let receipt=CreationWal{version:1,uuid:stage.intent.uuid.clone(),journal:stage.intent.journal.clone(),wal:stage.intent.wal.clone()};
        write_synced(stage.journal()?,creation_wal_name(),&serde_json::to_vec(&receipt).map_err(|_|"WAL 凭据编码失败")?)?;
        #[cfg(test)] test_init_fault()?;
        let encoded=serde_json::to_vec(&stage.intent).map_err(|_|"事务意图编码失败")?;if encoded.len()as u64>MAX_INTENT{return Err("事务意图超过预算".into());}
        write_atomic_marker(stage.journal()?,"intent-tmp.json",INTENT,&encoded)?;
        stage.verify()?;clear_creation(&stage.root,&stage.journal_root,&stage.intent.uuid)?;Ok(stage)
    }
    fn journal(&self)->Result<&Directory>{self.journal.as_ref().ok_or("事务目录已关闭".into())}
    fn verify(&self)->Result<()>{check_directory(&self.root,&self.intent.root)?;check_directory(&self.directory,&self.intent.directory_id)?;check_directory(&self.journal_root,&self.intent.journal_root)?;check_directory(self.journal()?,&self.intent.journal)}
    fn append(&self,record:Record)->Result<()> {
        self.verify()?;let seq=self.wal_seq.get();if seq>=MAX_RECORDS{return Err("WAL 记录超过预算".into());}
        let mut bytes=serde_json::to_vec(&Line{seq,record}).map_err(|_|"WAL 编码失败")?;bytes.push(b'\n');if bytes.len()>16384{return Err("WAL 单记录过大".into());}
        let mut file=opened(self.journal()?,WAL,true,false)?;if identity(&file,false)?!=self.intent.wal{return Err("WAL 身份改变".into());}let length=file.seek(SeekFrom::End(0)).map_err(|_|"WAL 无法定位")?;if length!=self.wal_len.get()||length+bytes.len()as u64>MAX_WAL{return Err("WAL 长度改变或超过预算".into());}
        file.write_all(&bytes).map_err(|_|"WAL 写入失败，状态未确认")?;self.wal_seq.set(seq+1);self.wal_len.set(length+bytes.len()as u64);file.sync_all().map_err(|_|"WAL 同步失败，状态未确认")?;drop(file);native::sync(self.journal()?)
    }
    pub(crate) fn take_file(&mut self,index:usize)->Result<File>{
        if self.phase!=Phase::Open{return Err("事务状态不允许下载".into());}self.verify()?;let slot=self.intent.slots.get(index).ok_or("下载槽索引无效")?;let expected=slot.part.as_ref().ok_or("启用操作没有下载槽")?;
        let state=read_state(self.journal()?,&self.intent)?;if self.taken.contains(&index)||state.sealed[index].is_some()||!state.moves.is_empty(){return Err("下载槽已使用或事务已开始移动".into());}
        let file=opened(self.journal()?,&part(index),true,false)?;if identity(&file,false)?!=*expected||file.metadata().map_err(|_|"下载槽状态读取失败")?.len()!=0{return Err("下载槽身份或内容改变".into());}self.taken.insert(index);Ok(file)
    }
    pub(crate) fn seal(&mut self,index:usize,token:&AtomicBool)->Result<()> {
        if self.phase!=Phase::Open{return Err("事务状态不允许封存".into());}cancelled(token)?;self.verify()?;
        let new=self.intent.changes.get(index).and_then(new_file).ok_or("下载槽索引无效")?;if !self.taken.contains(&index){return Err("下载槽尚未取得".into());}let state=read_state(self.journal()?,&self.intent)?;if state.sealed[index].is_some()||!state.moves.is_empty(){return Err("下载槽重复封存".into());}
        // Windows 的新可写句柄要求下载者已关闭句柄；sync/hash 均在这一句柄完成。
        let mut file=opened(self.journal()?,&part(index),true,false)?;file.sync_all().map_err(|_|"下载文件同步失败")?;let e=hash(&mut file,new.size,Some(token))?;if Some(&e.id)!=self.intent.slots[index].part.as_ref()||new.sha1.as_ref().is_some_and(|v|!v.eq_ignore_ascii_case(&e.sha1))||new.sha512.as_ref().is_some_and(|v|!v.eq_ignore_ascii_case(&e.sha512)){return Err("下载文件身份或摘要不符".into());}drop(file);self.append(Record::Seal{index,evidence:e})
    }
    fn repair_tail(&self)->Result<()> {
        let bytes=read_bounded(self.journal()?,WAL,MAX_WAL)?;let valid=wal_prefix(&bytes)?;
        if valid!=bytes.len(){let file=opened(self.journal()?,WAL,true,false)?;if identity(&file,false)?!=self.intent.wal{return Err("WAL 身份改变".into());}file.set_len(valid as u64).map_err(|_|"无法截去未完成 WAL 尾记录")?;file.sync_all().map_err(|_|"WAL 尾部修复同步失败")?;drop(file);native::sync(self.journal()?)?;}
        self.wal_len.set(valid as u64);Ok(())
    }
    fn at(&self,place:&Location)->Result<&Directory>{if place.journal{self.journal()}else{Ok(&self.directory)}}
    fn move_checked(&self,movement:&Move,reverse:bool)->Result<()> {
        self.verify()?;let(from,to)=if reverse{(&movement.to,&movement.from)}else{(&movement.from,&movement.to)};
        let mut file=opened(self.at(from)?,&from.leaf,false,true)?;
        if hash(&mut file,movement.evidence.size,None)?!=movement.evidence{return Err("事务移动源不再是已验证文件".into());}
        if !absent(self.at(to)?,&to.leaf)?{return Err("事务移动目标已有文件，保留现场".into());}
        #[cfg(test)] test_move_fault()?;
        native::rename(self.at(from)?,&from.leaf,&file,self.at(to)?,&to.leaf)?;drop(file);
        native::sync(self.at(from)?)?;native::sync(self.at(to)?)?;Ok(())
    }
    fn rollback(&mut self)->Result<()> {
        let mut state=read_state(self.journal()?,&self.intent)?;
        self.repair_tail()?;self.wal_seq.set(state.records);
        if state.committed{self.phase=Phase::Committed;return Ok(());}if state.rolled_back{self.phase=Phase::RolledBack;return Ok(());}
        for movement in state.moves.clone().iter().rev(){
            if state.undone.contains(&movement.id){continue;}
            if !state.undoing.contains(&movement.id){self.append(Record::UndoIntent{id:movement.id})?;}
            let from_exists=matches(self.at(&movement.from)?,&movement.from.leaf,&movement.evidence)?;
            let to_exists=matches(self.at(&movement.to)?,&movement.to.leaf,&movement.evidence)?;
            if from_exists&&!to_exists{if !absent(self.at(&movement.to)?,&movement.to.leaf)?{return Err("回滚发现未知目标，保留现场".into());}native::sync(self.at(&movement.from)?)?;native::sync(self.at(&movement.to)?)?;}
            else if !from_exists&&to_exists{if !absent(self.at(&movement.from)?,&movement.from.leaf)?{return Err("回滚原名被占用，保留现场".into());}self.move_checked(movement,true)?;}
            else{return Err("回滚文件位置不明确，保留现场".into());}
            self.append(Record::Undone{id:movement.id})?;state.undone.insert(movement.id);
        }
        self.append(Record::RolledBack)?;self.phase=Phase::RolledBack;Ok(())
    }
    pub(crate) fn commit(&mut self,token:&AtomicBool)->Result<()> {
        if self.phase!=Phase::Open{return Err("事务状态不允许提交".into());}
        let result:Result<()>=(||{
            cancelled(token)?;self.verify()?;let state=read_state(self.journal()?,&self.intent)?;if !state.moves.is_empty(){return Err("事务已部分执行，必须先恢复".into());}let movements=planned_moves(&self.intent,&state.sealed)?;
            // 在任何旧文件移动前，重新校验所有下载及旧文件，并检查目标。
            for(index,change)in self.intent.changes.iter().enumerate(){cancelled(token)?;if let Some(expected)=&self.intent.slots[index].old{let old=old_file(change).ok_or("旧文件槽无效")?;if !matches(&self.directory,&old.leaf,expected)?{return Err("旧资源文件已改变".into());}}if let Some(new)=new_file(change){let expected=state.sealed[index].as_ref().ok_or("文件尚未封存")?;if !matches(self.journal()?,&part(index),expected)?{return Err("封存文件已改变".into());}if old_file(change).map(|o|o.leaf.as_str())!=Some(new.leaf.as_str())&&!absent(&self.directory,&new.leaf)?{return Err("新资源目标已有文件".into());}}else if !absent(&self.directory,target(change))?{return Err("启用目标已有文件".into());}}
            for movement in movements{cancelled(token)?;self.append(Record::Intent(movement.clone()))?;self.move_checked(&movement,false)?;self.append(Record::Applied{id:movement.id})?;}
            cancelled(token)?;
            // 此记录失败时绝不主动回滚：文件可能已持久化，只能按 WAL 恢复判定。
            self.phase=Phase::Unknown;self.append(Record::Committed)?;self.phase=Phase::Committed;Ok(())
        })();
        if let Err(error)=result{
            if self.phase==Phase::Unknown{return Err(format!("提交终态未确认，保留 journal：{error}"));}
            if let Err(rollback)=self.rollback(){self.phase=Phase::Unknown;return Err(format!("事务失败且恢复未确认：{error}；{rollback}"));}
            return Err(format!("资源更新未提交，已回滚：{error}"));
        }Ok(())
    }
    pub(crate) fn settled(&self)->bool{self.phase==Phase::Cleaned}
    pub(crate) fn cleanup(&mut self)->Result<()> {
        if self.phase==Phase::Cleaned{return Ok(());}if self.phase==Phase::Unknown{return Err("事务状态未确认，必须先恢复".into());}
        let state=read_state(self.journal()?,&self.intent)?;
        if !state.committed&&!state.rolled_back{self.rollback()?;}
        self.cleanup_terminal()
    }
    fn cleanup_terminal(&mut self)->Result<()> {
        self.verify()?;let mut state=read_state(self.journal()?,&self.intent)?;if !state.committed&&!state.rolled_back{return Err("事务尚未达到终态".into());}
        // 完整白名单先审计，再逐个复核身份与内容。未知文件绝不删除。
        let mut allowed=BTreeSet::from([INTENT.to_owned(),WAL.to_owned()]);for(index,slot)in self.intent.slots.iter().enumerate(){if slot.part.is_some(){allowed.insert(part(index));}if slot.old.is_some(){allowed.insert(backup(index));}}
        let mut budget=MAX_CHANGES*2+3;for name in self.journal()?.names(&mut budget)?{if !allowed.contains(&name){return Err("journal 包含未知文件，保留现场".into());}}
        for(index,slot)in self.intent.slots.iter().enumerate(){
            for(name,id,expected)in [(part(index),slot.part.as_ref(),state.sealed[index].as_ref()),(backup(index),slot.old.as_ref().map(|e|&e.id),slot.old.as_ref())]{
                if let Some(id)=id{match native::open(self.journal()?,&name,false,false,true){Ok(mut file)=>{if identity(&file,false)?!=*id{return Err("待清理文件身份改变".into());}if let Some(expected)=expected{if hash(&mut file,expected.size,None)?!=*expected{return Err("待清理文件内容改变".into());}}native::remove_file(self.journal()?,&name,file)?;native::sync(self.journal()?)?;},Err(e)if e.kind()==std::io::ErrorKind::NotFound=>{},Err(e)=>return Err(format!("待清理文件无法打开：{e}"))}}
            }
        }
        // 先记录临时文件身份，恢复可安全重写尚未完整写出的标记。
        let temp=closing_temp_name(&self.intent.uuid);
        if state.closing.is_none(){let file=native::create(&self.journal_root,&temp)?;let id=identity(&file,false)?;file.sync_all().map_err(|_|"清理临时文件同步失败")?;drop(file);native::sync(&self.journal_root)?;self.append(Record::ClosingPrepared{file:id.clone()})?;state.closing=Some(id);}
        let intent_size=opened(self.journal()?,INTENT,false,false)?.metadata().map_err(|_|"意图状态读取失败")?.len();
        let wal_size=opened(self.journal()?,WAL,false,false)?.metadata().map_err(|_|"WAL 状态读取失败")?.len();
        let closing=Closing{intent:self.intent.clone(),sealed:state.sealed,committed:state.committed,intent_file:evidence(self.journal()?,INTENT,intent_size,None)?,wal_file:evidence(self.journal()?,WAL,wal_size,None)?};
        let encoded=serde_json::to_vec(&closing).map_err(|_|"终态清理证据编码失败")?;
        if encoded.len()as u64>MAX_INTENT*2{return Err("终态清理证据超过预算".into());}
        let marker=closing_name(&self.intent.uuid);
        if !absent(&self.journal_root,&marker)?{return Err("终态清理证据已存在，请执行恢复".into());}
        let mut file=opened(&self.journal_root,&temp,true,true)?;
        if Some(&identity(&file,false)?)!=state.closing.as_ref(){return Err("清理临时文件身份改变".into());}
        file.set_len(0).map_err(|_|"清理标记无法复位")?;file.write_all(&encoded).map_err(|_|"清理标记写入失败")?;file.sync_all().map_err(|_|"清理标记同步失败")?;
        native::rename(&self.journal_root,&temp,&file,&self.journal_root,&marker)?;drop(file);native::sync(&self.journal_root)?;
        let journal=self.journal.take().ok_or("事务目录已关闭")?;drop(journal);
        if let Err(error)=finish_closing(&self.root,&self.journal_root,&marker){self.phase=Phase::Unknown;return Err(error);}self.phase=Phase::Cleaned;Ok(())
    }
}
fn finish_closing(root:&Directory,journal_root:&Directory,marker:&str)->Result<()> {
    let raw=read_bounded(journal_root,marker,MAX_INTENT*2)?;
    let marker_evidence=evidence(journal_root,marker,raw.len()as u64,None)?;
    let closing:Closing=serde_json::from_slice(&raw).map_err(|_|"终态清理证据不完整，保留现场")?;
    validate_intent(&closing.intent)?;
    let intent=&closing.intent;
    if marker!=closing_name(&intent.uuid)||closing.sealed.len()!=intent.changes.len()||closing.intent_file.size>MAX_INTENT||closing.wal_file.size>MAX_WAL||closing.wal_file.id!=intent.wal{return Err("终态清理证据不符".into());}
    check_directory(root,&intent.root)?;check_directory(journal_root,&intent.journal_root)?;
    validate_sealed(intent,&closing.sealed,closing.committed)?;
    if let Some(journal)=child_directory(journal_root,&intent.uuid)?{
        check_directory(&journal,&intent.journal)?;
        let mut budget=3;let names=journal.names(&mut budget)?;
        if names.iter().any(|name|name!=INTENT&&name!=WAL){return Err("终态清理目录含未知文件，保留现场".into());}
        for(name,expected)in [(WAL,&closing.wal_file),(INTENT,&closing.intent_file)]{
            match native::open(&journal,name,false,false,true){
                Ok(mut file)=>{if hash(&mut file,expected.size,None)?!=*expected{return Err("终态清理元数据改变".into());}native::remove_file(&journal,name,file)?;native::sync(&journal)?;}
                Err(error)if error.kind()==std::io::ErrorKind::NotFound=>{},
                Err(error)=>return Err(format!("无法打开终态清理元数据：{error}")),
            }
        }
        drop(journal);native::remove_dir(journal_root,&intent.uuid,&intent.journal)?;native::sync(journal_root)?;
    }
    let mut file=opened(journal_root,marker,false,true)?;
    if hash(&mut file,marker_evidence.size,None)?!=marker_evidence{return Err("终态清理凭据改变".into());}
    native::remove_file(journal_root,marker,file)?;native::sync(journal_root)
}
/// 只读有界探测；没有 journal 根时不创建文件或申请租约。调用者已持 root guard。
pub(crate) fn pending_under_guard(root:&Path)->Result<bool>{
    let root=Directory::open(root)?;let Some(journal_root)=child_directory(&root,JOURNAL_ROOT)?else{return Ok(false);};let mut budget=MAX_JOURNALS*2;Ok(!journal_root.names(&mut budget)?.is_empty())
}
/// 持有全局 install_lock 的调用者执行；本模块不自动释放 host 的 Gate/root lease。
pub(crate) fn recover_under_guard(root:&Path)->Result<()> {
    let root=Directory::open(root)?;let Some(journal_root)=child_directory(&root,JOURNAL_ROOT)?else{return Ok(());};let mut budget=MAX_JOURNALS*2;let names=journal_root.names(&mut budget)?;
    for name in names.iter().filter(|name|name.starts_with("create-")&&!name.starts_with("create-tmp-")&&!name.starts_with("create-bound-")){let uuid=name.strip_prefix("create-").and_then(|s|s.strip_suffix(".json")).ok_or("创建凭据名称无效")?;clear_creation(&root,&journal_root,uuid)?;}
    let mut budget=MAX_JOURNALS*2;let names=journal_root.names(&mut budget)?;
    for name in names.iter().filter(|name|name.starts_with("done-")&&!name.starts_with("done-tmp-")){finish_closing(&root,&journal_root,name)?;}
    let mut budget=MAX_JOURNALS*2;let names=journal_root.names(&mut budget)?;
    for name in names{
        if name.starts_with("done-tmp-"){continue;}
        if uuid::Uuid::parse_str(&name).is_err(){return Err("journal 根含未知项目，保留现场".into());}
        let journal=child_directory(&journal_root,&name)?.ok_or("journal 恢复时消失")?;
        let bytes=read_bounded(&journal,INTENT,MAX_INTENT)?;let intent:Intent=serde_json::from_slice(&bytes).map_err(|_|"事务意图不完整，保留现场")?;validate_intent(&intent)?;
        if intent.uuid!=name{return Err("事务 UUID 不符".into());}let directory=descend(&root,&intent.directory)?;
        let mut stage=UpdateStage{root:root.clone(),directory,journal_root:journal_root.clone(),journal:Some(journal),intent,taken:BTreeSet::new(),phase:Phase::Open,wal_seq:Cell::new(0),wal_len:Cell::new(0)};stage.verify()?;
        let state=read_state(stage.journal()?,&stage.intent)?;stage.wal_seq.set(state.records);stage.wal_len.set(read_bounded(stage.journal()?,WAL,MAX_WAL)?.len()as u64);if state.committed{stage.phase=Phase::Committed;}else{stage.rollback()?;}stage.cleanup()?;
    }Ok(())
}

#[cfg(test)]
thread_local! {static MOVE_FAULT:Cell<Option<usize>>=const{Cell::new(None)};static INIT_FAULT:Cell<Option<usize>>=const{Cell::new(None)};}
#[cfg(test)]
fn test_init_fault()->Result<()> {INIT_FAULT.with(|value|match value.get(){Some(0)=>{value.set(None);Err("普通初始化 I/O 故障夹具".into())},Some(n)=>{value.set(Some(n-1));Ok(())},None=>Ok(())})}
#[cfg(test)]
fn test_move_fault()->Result<()> {MOVE_FAULT.with(|value|match value.get(){Some(0)=>{value.set(None);Err("普通移动 I/O 故障夹具".into())},Some(n)=>{value.set(Some(n-1));Ok(())},None=>Ok(())})}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs,path::PathBuf};
    struct Temp {root:PathBuf}
    impl Temp {
        fn new()->Self{let base=fs::canonicalize(std::env::temp_dir()).unwrap();let root=base.join(format!("hcmcl-resource-wal-{}",uuid::Uuid::new_v4()));fs::create_dir(&root).unwrap();fs::create_dir(root.join("mods")).unwrap();Self{root}}
        fn directory(&self)->PathBuf{self.root.join("mods")}
        fn put(&self,name:&str,bytes:&[u8]){fs::write(self.directory().join(name),bytes).unwrap();}
        fn get(&self,name:&str)->Vec<u8>{fs::read(self.directory().join(name)).unwrap()}
    }
    impl Drop for Temp{fn drop(&mut self){let _=fs::remove_dir_all(&self.root);}}
    fn old(name:&str,bytes:&[u8])->OldFile{OldFile{leaf:name.into(),size:bytes.len()as u64,sha512:format!("{:x}",Sha512::digest(bytes))}}
    fn new(name:&str,bytes:&[u8])->NewFile{NewFile{leaf:name.into(),size:bytes.len()as u64,sha1:Some(format!("{:x}",Sha1::digest(bytes))),sha512:Some(format!("{:x}",Sha512::digest(bytes)))}}
    fn token()->AtomicBool{AtomicBool::new(false)}
    fn stage(temp:&Temp,changes:Vec<Change>)->UpdateStage{UpdateStage::create(&temp.root,&temp.directory(),changes,&token()).unwrap()}
    fn download(stage:&mut UpdateStage,index:usize,bytes:&[u8]){let mut file=stage.take_file(index).unwrap();file.write_all(bytes).unwrap();drop(file);stage.seal(index,&token()).unwrap();}
    fn interrupted(stage:&UpdateStage,completed:usize,last_applied:bool){let state=read_state(stage.journal().unwrap(),&stage.intent).unwrap();let moves=planned_moves(&stage.intent,&state.sealed).unwrap();for movement in moves.iter().take(completed){stage.append(Record::Intent(movement.clone())).unwrap();stage.move_checked(movement,false).unwrap();if last_applied||movement.id+1<completed{stage.append(Record::Applied{id:movement.id}).unwrap();}}}

    #[test]
    fn same_name_replace_commit_and_cleanup(){let temp=Temp::new();temp.put("a.jar",b"old");let mut value=stage(&temp,vec![Change::Replace{old:old("a.jar",b"old"),new:new("a.jar",b"new")}]);download(&mut value,0,b"new");assert!(!value.settled());value.commit(&token()).unwrap();assert_eq!(temp.get("a.jar"),b"new");assert!(!value.settled());value.cleanup().unwrap();assert!(value.settled());value.cleanup().unwrap();assert!(!pending_under_guard(&temp.root).unwrap());}
    #[test]
    fn renamed_disabled_install_and_enable(){let temp=Temp::new();temp.put("old.jar.disabled",b"old");temp.put("dependency.jar.disabled",b"dep");let mut value=stage(&temp,vec![Change::Replace{old:old("old.jar.disabled",b"old"),new:new("new.jar.disabled",b"new")},Change::Install{new:new("install.jar",b"install")},Change::Enable{old:old("dependency.jar.disabled",b"dep"),target_leaf:"dependency.jar".into()}]);download(&mut value,0,b"new");download(&mut value,1,b"install");value.commit(&token()).unwrap();assert_eq!(temp.get("new.jar.disabled"),b"new");assert_eq!(temp.get("install.jar"),b"install");assert_eq!(temp.get("dependency.jar"),b"dep");assert!(!temp.directory().join("old.jar.disabled").exists());assert!(!temp.directory().join("dependency.jar.disabled").exists());value.cleanup().unwrap();assert!(value.settled());}
    #[test]
    fn pre_cancel_bad_seal_and_download_cleanup(){let temp=Temp::new();let cancel=AtomicBool::new(true);assert!(UpdateStage::create(&temp.root,&temp.directory(),vec![Change::Install{new:new("a.jar",b"new")}],&cancel).is_err());assert!(!temp.root.join(JOURNAL_ROOT).exists());let mut value=stage(&temp,vec![Change::Install{new:new("a.jar",b"new")}]);let mut file=value.take_file(0).unwrap();file.write_all(b"bad").unwrap();drop(file);assert!(value.seal(0,&token()).is_err());value.cleanup().unwrap();assert!(value.settled());assert!(!temp.directory().join("a.jar").exists());}
    #[test]
    fn ordinary_move_error_reverses_current_backup(){let temp=Temp::new();temp.put("old.jar",b"old");let mut value=stage(&temp,vec![Change::Replace{old:old("old.jar",b"old"),new:new("new.jar",b"new")}]);download(&mut value,0,b"new");MOVE_FAULT.with(|v|v.set(Some(1)));assert!(value.commit(&token()).is_err());assert_eq!(temp.get("old.jar"),b"old");assert!(!temp.directory().join("new.jar").exists());value.cleanup().unwrap();assert!(value.settled());}
    #[test]
    fn recovery_after_backup_before_and_after_publish(){for completed in [1,2]{let temp=Temp::new();temp.put("old.jar",b"old");let mut value=stage(&temp,vec![Change::Replace{old:old("old.jar",b"old"),new:new("new.jar",b"new")}]);download(&mut value,0,b"new");interrupted(&value,completed,false);drop(value);assert!(pending_under_guard(&temp.root).unwrap());recover_under_guard(&temp.root).unwrap();assert_eq!(temp.get("old.jar"),b"old");assert!(!temp.directory().join("new.jar").exists());assert!(!pending_under_guard(&temp.root).unwrap());}}
    #[test]
    fn committed_recovery_only_cleans_and_enable_rolls_back(){let temp=Temp::new();temp.put("a.jar",b"old");let mut value=stage(&temp,vec![Change::Replace{old:old("a.jar",b"old"),new:new("a.jar",b"new")}]);download(&mut value,0,b"new");value.commit(&token()).unwrap();drop(value);recover_under_guard(&temp.root).unwrap();assert_eq!(temp.get("a.jar"),b"new");temp.put("dep.jar.disabled",b"dep");let value=stage(&temp,vec![Change::Enable{old:old("dep.jar.disabled",b"dep"),target_leaf:"dep.jar".into()}]);interrupted(&value,2,false);drop(value);recover_under_guard(&temp.root).unwrap();assert_eq!(temp.get("dep.jar.disabled"),b"dep");assert!(!temp.directory().join("dep.jar").exists());}
    #[test]
    fn unfinished_wal_tail_and_reverse_progress_recover(){let temp=Temp::new();temp.put("a.jar",b"old");let mut value=stage(&temp,vec![Change::Replace{old:old("a.jar",b"old"),new:new("a.jar",b"new")}]);download(&mut value,0,b"new");interrupted(&value,2,true);let state=read_state(value.journal().unwrap(),&value.intent).unwrap();let movement=state.moves.last().unwrap();value.append(Record::UndoIntent{id:movement.id}).unwrap();value.move_checked(movement,true).unwrap();let mut file=opened(value.journal().unwrap(),WAL,true,false).unwrap();file.seek(SeekFrom::End(0)).unwrap();file.write_all(b"{\"seq\":").unwrap();file.sync_all().unwrap();drop(file);drop(value);recover_under_guard(&temp.root).unwrap();assert_eq!(temp.get("a.jar"),b"old");assert!(!pending_under_guard(&temp.root).unwrap());}
    #[test]
    fn cancellation_before_moves_and_unsealed_restart_cleanup(){let temp=Temp::new();temp.put("a.jar",b"old");let mut value=stage(&temp,vec![Change::Replace{old:old("a.jar",b"old"),new:new("a.jar",b"new")}]);download(&mut value,0,b"new");assert!(value.commit(&AtomicBool::new(true)).is_err());assert_eq!(temp.get("a.jar"),b"old");value.cleanup().unwrap();drop(value);let mut value=stage(&temp,vec![Change::Install{new:new("dep.jar",b"download")}]);let mut file=value.take_file(0).unwrap();file.write_all(b"half").unwrap();drop(file);drop(value);recover_under_guard(&temp.root).unwrap();assert!(!temp.directory().join("dep.jar").exists());assert!(!pending_under_guard(&temp.root).unwrap());}
    #[test]
    fn durable_closing_marker_resumes_after_metadata_removal(){for remove_directory in [false,true]{let temp=Temp::new();let mut value=stage(&temp,vec![Change::Install{new:new("a.jar",b"new")}]);download(&mut value,0,b"new");value.commit(&token()).unwrap();let state=read_state(value.journal().unwrap(),&value.intent).unwrap();let raw=read_bounded(value.journal().unwrap(),INTENT,MAX_INTENT).unwrap();let wal=read_bounded(value.journal().unwrap(),WAL,MAX_WAL).unwrap();let closing=Closing{intent:value.intent.clone(),sealed:state.sealed,committed:true,intent_file:evidence(value.journal().unwrap(),INTENT,raw.len()as u64,None).unwrap(),wal_file:evidence(value.journal().unwrap(),WAL,wal.len()as u64,None).unwrap()};write_synced(&value.journal_root,&closing_name(&value.intent.uuid),&serde_json::to_vec(&closing).unwrap()).unwrap();for name in [WAL,INTENT]{let file=opened(value.journal().unwrap(),name,false,true).unwrap();native::remove_file(value.journal().unwrap(),name,file).unwrap();native::sync(value.journal().unwrap()).unwrap();}if remove_directory{let journal=value.journal.take().unwrap();drop(journal);native::remove_dir(&value.journal_root,&value.intent.uuid,&value.intent.journal).unwrap();native::sync(&value.journal_root).unwrap();}drop(value);recover_under_guard(&temp.root).unwrap();assert_eq!(temp.get("a.jar"),b"new");assert!(!pending_under_guard(&temp.root).unwrap());}}
    #[test]
    fn initialization_io_failure_recovers_only_recorded_empty_slots(){
        for checkpoint in 0..3{let temp=Temp::new();temp.put("old.jar",b"old");INIT_FAULT.with(|v|v.set(Some(checkpoint)));
            assert!(UpdateStage::create(&temp.root,&temp.directory(),vec![Change::Replace{old:old("old.jar",b"old"),new:new("new.jar",b"new")}],&token()).is_err());
            assert!(pending_under_guard(&temp.root).unwrap());recover_under_guard(&temp.root).unwrap();
            assert_eq!(temp.get("old.jar"),b"old");assert!(!temp.directory().join("new.jar").exists());assert!(!pending_under_guard(&temp.root).unwrap());}
    }
    #[test]
    fn interrupted_closing_temp_is_rebuilt_from_wal_bound_identity(){
        for partial in [false,true]{let temp=Temp::new();let mut value=stage(&temp,vec![Change::Install{new:new("a.jar",b"new")}]);download(&mut value,0,b"new");value.commit(&token()).unwrap();
            let name=closing_temp_name(&value.intent.uuid);let file=native::create(&value.journal_root,&name).unwrap();let id=identity(&file,false).unwrap();file.sync_all().unwrap();drop(file);native::sync(&value.journal_root).unwrap();value.append(Record::ClosingPrepared{file:id}).unwrap();
            if partial{let mut file=opened(&value.journal_root,&name,true,false).unwrap();file.write_all(b"{\"intent\":").unwrap();file.sync_all().unwrap();drop(file);}
            drop(value);recover_under_guard(&temp.root).unwrap();assert_eq!(temp.get("a.jar"),b"new");assert!(!pending_under_guard(&temp.root).unwrap());}
    }
    #[test]
    fn no_journal_probe_is_read_only_and_context_is_fixed(){let temp=Temp::new();assert!(!pending_under_guard(&temp.root).unwrap());recover_under_guard(&temp.root).unwrap();assert!(!temp.root.join(JOURNAL_ROOT).exists());let versions=temp.root.join("versions");fs::create_dir(&versions).unwrap();let instance=versions.join("example");fs::create_dir(&instance).unwrap();let packs=instance.join("resourcepacks");fs::create_dir(&packs).unwrap();let mut value=UpdateStage::create(&temp.root,&packs,vec![Change::Install{new:new("资源包.zip",b"pack")}],&token()).unwrap();download(&mut value,0,b"pack");value.commit(&token()).unwrap();value.cleanup().unwrap();assert_eq!(fs::read(packs.join("资源包.zip")).unwrap(),b"pack");}
}


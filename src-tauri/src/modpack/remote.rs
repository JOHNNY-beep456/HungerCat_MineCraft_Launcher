//! 整合包远程成员：先绑定完整计划，再通过有界私有暂存写入未发布实例。
//! 调用者必须在整个 apply 期间持有实例 Stage；本模块不发布实例，也不输出下载路径。
use super::{access::leaf, download_store, install_stage, network, plan::{ArchivePhase, DeclaredHash, EnvironmentStatus, FullPackPlan, RemoteFile, SourceFormat}, Result};
use crate::{catalog::{self, BoundDownload, PackBoundMetadata}, downloads::Cancel};
use serde_json::Value;
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};
use std::{collections::{BTreeMap, BTreeSet}, fs::File, io::{Read, Seek, SeekFrom}, path::Path, sync::{Arc, Mutex}};
use tokio::io::AsyncWriteExt;

const MAX_FILE: u64 = 256 * 1024 * 1024;
const MAX_TOTAL: u64 = 2 * 1024 * 1024 * 1024;
const MAX_FILES: usize = 50_000;
type Holder = Arc<Mutex<Option<install_stage::Stage>>>;

#[derive(Clone)]
enum Transport { Official(BoundDownload), Mirrors(Vec<String>) }
#[derive(Clone)]
pub(super) struct Prepared {
    target: String,
    size: Option<u64>,
    hashes: Vec<DeclaredHash>,
    transport: Transport,
}

fn checked_path(path: &str, target_id: &str) -> Result<String> {
    if path.is_empty() || path.len() > 4096 || path.split('/').count() > 64 { return Err("整合包远程目标路径超过限制".into()); }
    let parts = path.split('/').collect::<Vec<_>>();
    for part in &parts { leaf(part)?; }
    let first = parts[0].to_ascii_lowercase();
    if first == "natives" || parts.iter().any(|part| part.eq_ignore_ascii_case(".hcmcl-modpack-stage-owner") || part.to_ascii_lowercase().starts_with(".hcmcl-modpack-write-"))
        || parts.len() == 1 && (parts[0].eq_ignore_ascii_case("instance.json") || parts[0].eq_ignore_ascii_case(&format!("{target_id}.json"))) {
        return Err("远程成员不能写入宿主保留路径".into());
    }
    Ok(path.to_owned())
}
fn checked_hashes(values: &[DeclaredHash]) -> Result<Vec<DeclaredHash>> {
    let mut hashes = BTreeMap::new();
    for value in values {
        let len = match value.algorithm.as_str() { "sha1" => 40, "sha256" => 64, "sha512" => 128, "md5" => 32, _ => return Err("整合包声明未知摘要算法".into()) };
        if value.value.len() != len || !value.value.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err("整合包成员摘要格式无效".into()); }
        let normalized = value.value.to_ascii_lowercase();
        if hashes.insert(value.algorithm.clone(), normalized.clone()).is_some_and(|old| old != normalized) { return Err("整合包成员同一摘要算法存在冲突".into()); }
    }
    Ok(hashes.into_iter().map(|(algorithm,value)| DeclaredHash { algorithm,value }).collect())
}
fn with_official_hashes(file: &RemoteFile, meta: &PackBoundMetadata) -> Result<Vec<DeclaredHash>> {
    if file.size.is_some_and(|size| size != meta.size) { return Err("整合包大小与官方成员元数据不一致".into()); }
    let mut all = file.hashes.clone();
    for (algorithm,value) in [("sha1",&meta.sha1),("sha512",&meta.sha512)] { if let Some(value)=value { all.push(DeclaredHash { algorithm:algorithm.into(),value:value.clone() }); } }
    checked_hashes(&all)
}
fn curse_target(file: &RemoteFile, meta: &PackBoundMetadata, target: &str) -> Result<String> {
    let folder = match meta.kind { "mod" => "mods", "resourcepack" => "resourcepacks", "shader" => "shaderpacks", _ => return Err("整合包不支持该官方成员类型".into()) };
    leaf(&meta.filename)?;
    let path = file.path.as_deref().or(file.filename.as_deref());
    let path = match path {
        Some(path) if path.contains('/') => path.to_owned(),
        Some(name) => { if name != meta.filename { return Err("整合包声明文件名与官方不一致".into()); } format!("{folder}/{name}") },
        None => format!("{folder}/{}",meta.filename),
    };
    if path.split('/').next() != Some(folder) || path.rsplit('/').next() != Some(meta.filename.as_str()) { return Err("官方成员类型、文件名与目标目录不一致".into()); }
    checked_path(&path,target)
}
fn member_urls(file: &RemoteFile, path: &str) -> Result<Vec<String>> {
    let mut values = file.urls.clone();
    if values.is_empty() {
        if let Some(base)=&file.file_api_template {
            // MCBBS 的固定 fileApi/overrides/path 协议；不执行模板或脚本。
            if base.contains('{') || base.contains('}') { return Err("fileApi 不支持动态模板".into()); }
            network::validate_url(base)?;
            let mut url=reqwest::Url::parse(base).map_err(|_| "fileApi 地址无效")?;
            if url.query().is_some() { return Err("fileApi 基址不能带查询参数".into()); }
            { let mut segments=url.path_segments_mut().map_err(|_| "fileApi 基址无效")?; segments.pop_if_empty().push("overrides"); for part in path.split('/') { segments.push(part); } }
            values.push(url.to_string());
        }
    }
    if values.len()>32 { return Err("整合包成员备用地址超过限制".into()); }
    for value in &values { network::validate_url(value)?; }
    Ok(values)
}

fn reserve_path(nodes: &mut BTreeMap<String,(String,bool)>, path: &str) -> Result<()> {
    let parts=path.split('/').collect::<Vec<_>>();
    for index in 0..parts.len() {
        let current=parts[..=index].join("/"); let directory=index+1<parts.len(); let key=current.to_lowercase();
        if let Some((prior,is_dir))=nodes.get(&key) {
            if prior!=&current || *is_dir!=directory || !directory { return Err("整合包远程目标有父目录大小写别名或文件目录冲突".into()); }
        } else { nodes.insert(key,(current,directory)); }
    }
    Ok(())
}

/// 先完成所有成员的类型、路径、摘要、大小和官方 ID 绑定；此阶段不创建实例或缓存文件。
pub(super) async fn prepare(plan: &FullPackPlan, settings: &Value, cancel: Arc<Cancel>) -> Result<Vec<Prepared>> {
    if plan.remote_files.len()>MAX_FILES { return Err("整合包远程成员数量超过限制".into()); }
    let mut prepared=Vec::new(); let mut paths=BTreeSet::new(); let mut nodes=BTreeMap::new(); let mut total=0u64;
    for file in &plan.remote_files {
        cancel.check()?;
        if file.environment.client==EnvironmentStatus::Unsupported { continue; }
        if settings.get("mode").and_then(Value::as_str)==Some("local") || settings.get("metadataOnlyMods").and_then(Value::as_bool)==Some(true) { return Err("当前模式禁止下载整合包成员".into()); }
        let (target,size,hashes,transport)=if file.curse_project_id.is_some() || file.curse_file_id.is_some() || plan.format==SourceFormat::CurseForge || file.file_type.as_deref().is_some_and(|kind| kind.eq_ignore_ascii_case("curse")) {
            let project=file.curse_project_id.ok_or("CurseForge 成员缺少项目 ID")?; let id=file.curse_file_id.ok_or("CurseForge 成员缺少文件 ID")?;
            let bound=catalog::prepare_pack_curseforge(project,id,settings).await?; cancel.check()?;
            let meta=catalog::pack_bound_metadata(&bound); let target=curse_target(file,&meta,&plan.target_id)?;
            (target,Some(meta.size),with_official_hashes(file,&meta)?,Transport::Official(bound))
        } else {
            let path=file.path.as_deref().ok_or("整合包远程成员缺少路径")?;
            let target=checked_path(path,&plan.target_id)?; let hashes=checked_hashes(&file.hashes)?;
            let urls=member_urls(file,path)?;
            if urls.is_empty() {
                // 没有远程地址的 MCBBS addon 只能由清单中同名本地覆盖成员提供。
                if plan.format==SourceFormat::Mcbbs && plan.members.iter().any(|member| member.target_path.as_deref()==Some(path) && matches!(member.phase,ArchivePhase::Overrides|ArchivePhase::ClientOverrides)) { continue; }
                return Err("整合包成员没有可用下载地址或本地覆盖文件".into());
            }
            if !hashes.iter().any(|hash| matches!(hash.algorithm.as_str(),"sha1"|"sha256"|"sha512")) { return Err("远程成员缺少可校验摘要".into()); }
            if plan.format==SourceFormat::Modrinth && (file.size.is_none() || !hashes.iter().any(|hash| matches!(hash.algorithm.as_str(),"sha1"|"sha512"))) { return Err("Modrinth 成员必须声明大小和 SHA-1 或 SHA-512".into()); }
            // 对明确的官方 Modrinth URL 额外绑定官方版本元数据；第三方镜像仍按清单逐摘要验证。
            let mut transport=Transport::Mirrors(urls.clone());
            if plan.format==SourceFormat::Modrinth {
                let sha1=hashes.iter().find(|hash|hash.algorithm=="sha1").map(|hash|hash.value.as_str());
                let sha512=hashes.iter().find(|hash|hash.algorithm=="sha512").map(|hash|hash.value.as_str());
                for url in &urls {
                    let parsed=reqwest::Url::parse(url).map_err(|_| "Modrinth 成员地址无效")?;
                    if matches!(parsed.host_str(),Some("cdn.modrinth.com"|"api.modrinth.com")) {
                        let filename=path.rsplit('/').next().ok_or("Modrinth 成员文件名无效")?;
                        let bound=catalog::prepare_pack_modrinth(url,filename,file.size.ok_or("Modrinth 缺少文件大小")?,sha1,sha512,settings).await?;
                        cancel.check()?;
                        transport=Transport::Official(bound);
                        break;
                    }
                }
            }
            (target,file.size,hashes,transport)
        };
        if size.is_some_and(|size| size==0 || size>MAX_FILE) { return Err("整合包成员大小超过 256 MiB 或为零".into()); }
        total=total.checked_add(size.unwrap_or(MAX_FILE)).ok_or("整合包远程预算溢出")?;
        if total>MAX_TOTAL { return Err("整合包远程成员预留容量超过 2 GiB".into()); }
        if !paths.insert(target.to_lowercase()) { return Err("整合包远程成员目标重复或大小写冲突".into()); }
        reserve_path(&mut nodes,&target)?;
        prepared.push(Prepared { target,size,hashes,transport });
    }
    cancel.check()?; Ok(prepared)
}

fn verify_payload(file: &mut File, prepared: &Prepared, bytes: u64, cancel: &Cancel) -> Result<()> {
    if bytes==0 || bytes>MAX_FILE || prepared.size.is_some_and(|size| size!=bytes) { return Err("整合包成员实际大小不匹配".into()); }
    file.seek(SeekFrom::Start(0)).map_err(|_| "无法定位成员暂存")?;
    let mut h1=Sha1::new(); let mut h256=Sha256::new(); let mut h512=Sha512::new(); let mut md5=md5::Context::new(); let mut count=0u64; let mut buffer=[0u8;64*1024];
    loop { cancel.check()?; let n=file.read(&mut buffer).map_err(|_| "读取成员暂存失败")?; if n==0 { break; } count=count.checked_add(n as u64).filter(|value| *value<=bytes).ok_or("成员暂存在校验期间增大")?; h1.update(&buffer[..n]); h256.update(&buffer[..n]); h512.update(&buffer[..n]); md5.consume(&buffer[..n]); }
    if count!=bytes { return Err("成员暂存大小改变".into()); }
    let actual=BTreeMap::from([("sha1",format!("{:x}",h1.finalize())),("sha256",format!("{:x}",h256.finalize())),("sha512",format!("{:x}",h512.finalize())),("md5",format!("{:x}",md5.compute()))]);
    for hash in &prepared.hashes { if actual.get(hash.algorithm.as_str())!=Some(&hash.value) { return Err(format!("整合包成员 {} 校验失败",hash.algorithm)); } }
    file.seek(SeekFrom::Start(0)).map_err(|_| "无法重新定位成员暂存")?; cancel.check()
}

pub(super) struct Session { spool: Arc<Mutex<Option<download_store::Stage>>> }
impl Session {
    pub(super) fn new() -> Self { Self { spool:Arc::new(Mutex::new(None)) } }
    pub(super) async fn cleanup(&self) -> Result<()> {
        let holder=self.spool.clone(); tokio::task::spawn_blocking(move || {
            let mut guard=holder.lock().map_err(|_| "成员暂存状态不可用")?;
            if let Some(stage)=guard.as_mut() { stage.cleanup()?; } *guard=None; Ok(())
        }).await.map_err(|_| "成员暂存清理后台异常".to_owned())?
    }
    async fn open_writer(&self, cache:&Path) -> Result<File> {
        let holder=self.spool.clone(); let cache=cache.to_path_buf(); tokio::task::spawn_blocking(move || {
            let mut guard=holder.lock().map_err(|_| "成员暂存状态不可用")?;
            if guard.is_some() { return Err("上个成员暂存尚未清理".into()); }
            *guard=Some(download_store::Stage::create(&cache)?);
            guard.as_mut().ok_or("成员暂存未登记")?.take_file()
        }).await.map_err(|_| "成员暂存建立后台异常".to_owned())?
    }
    /// 必须由不被 IPC drop 中断的 owned import worker 调用；取消也等 writer/校验/清理真正结束。
    pub(super) async fn apply(&self, prepared:&Prepared, cache:&Path, instance:Holder, cancel:Arc<Cancel>, progress:Arc<dyn Fn(u64,Option<u64>)+Send+Sync>) -> Result<()> {
        cancel.check()?;
        let raw=self.open_writer(cache).await?;
        let outcome=async {
            let (bytes,digest)=match &prepared.transport {
                Transport::Official(bound)=>{
                    let reporter=progress.clone(); let count=catalog::write_export_download(bound.clone(),raw,cancel.clone(),Arc::new(move |bytes,total| reporter(bytes,Some(total)))).await?;
                    (count,None)
                },
                Transport::Mirrors(urls)=>{
                    let mut file=tokio::fs::File::from_std(raw);
                    let outcome: Result<(u64,String)>=async {
                        let mut outcome=Err("成员没有备用下载地址".to_owned());
                        for url in urls {
                            cancel.check()?;
                            file.set_len(0).await.map_err(|_| "无法重置成员暂存")?;
                            tokio::io::AsyncSeekExt::seek(&mut file,SeekFrom::Start(0)).await.map_err(|_| "无法定位成员暂存")?;
                            outcome=network::download_limited(url,&mut file,cancel.clone(),progress.clone(),prepared.size.unwrap_or(MAX_FILE)).await;
                            if outcome.is_ok() || cancel.check().is_err() { break; }
                        }
                        outcome
                    }.await;
                    // 包括取消、set_len 和 seek 的失败也必须先等待文件后台操作真正结束。
                    let flushed=file.flush().await.map_err(|_| "成员暂存刷新失败".to_owned());
                    drop(file.into_std().await);
                    flushed?;
                    let (bytes,digest)=outcome?; (bytes,Some(digest))
                }
            };
            cancel.check()?;
            let holder=self.spool.clone(); let expected=prepared.clone(); let token=cancel.clone();
            tokio::task::spawn_blocking(move || {
                let mut guard=holder.lock().map_err(|_| "成员暂存状态不可用")?; let stage=guard.as_mut().ok_or("成员暂存丢失")?;
                // 官方 writer 只提供已校验长度；为统一封存仍由同一宿主暂存重算 SHA-256。
                let digest=match digest { Some(value)=>value, None=>stage.payload_sha256(&token)? };
                stage.seal(bytes,&digest)?;
                stage.read_archive(&token,|file| { verify_payload(file,&expected,bytes,&token)?; instance.lock().map_err(|_| "实例暂存状态不可用")?.as_mut().ok_or("实例暂存丢失")?.write(&expected.target,file,bytes,false,&token) })
            }).await.map_err(|_| "成员校验物化后台异常".to_owned())??;
            Ok(())
        }.await;
        // 无论下载或校验是否成功，先等待所有工作返回，再清理仍由 Session 持有的唯一台账。
        let cleanup=self.cleanup().await;
        match (outcome,cleanup) {
            (Ok(()),Ok(()))=>Ok(()),
            (Err(error),Ok(()))=>Err(error),
            (Ok(()),Err(cleanup))=>Err(format!("成员已写入未发布实例，但成员缓存清理失败：{cleanup}")),
            (Err(error),Err(cleanup))=>Err(format!("{error}；成员缓存清理失败：{cleanup}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs,io::Write,path::PathBuf};
    struct Fixture(PathBuf);
    impl Fixture { fn new()->Self { let path=std::env::temp_dir().join(format!("hcmcl-pack-remote-{}",uuid::Uuid::new_v4()));fs::create_dir(&path).unwrap();Self(fs::canonicalize(path).unwrap()) } }
    impl Drop for Fixture { fn drop(&mut self){let _=fs::remove_dir_all(&self.0);} }
    fn hash(algorithm:&str,value:String)->DeclaredHash { DeclaredHash{algorithm:algorithm.into(),value} }
    #[test] fn all_declared_hashes_are_required_and_conflicts_rejected() {
        let bytes=b"verified payload"; let fixture=Fixture::new(); let path=fixture.0.join("payload");fs::write(&path,bytes).unwrap();
        let mut prepared=Prepared{target:"mods/a.jar".into(),size:Some(bytes.len()as u64),hashes:vec![hash("sha1",format!("{:x}",Sha1::digest(bytes))),hash("sha512",format!("{:x}",Sha512::digest(bytes)))],transport:Transport::Mirrors(vec![])};
        verify_payload(&mut File::open(&path).unwrap(),&prepared,bytes.len()as u64,&Cancel::default()).unwrap();
        prepared.hashes[1].value="0".repeat(128);assert!(verify_payload(&mut File::open(&path).unwrap(),&prepared,bytes.len()as u64,&Cancel::default()).is_err());
        assert!(checked_hashes(&[hash("sha1","a".repeat(40)),hash("sha1","b".repeat(40))]).is_err());
        assert!(checked_hashes(&[hash("md5","x".repeat(32))]).is_err());
    }
    #[test] fn remote_paths_reject_host_files_aliases_and_untrusted_file_api() {
        for path in ["../x","/x","mods//x","natives/a.dll","instance.json","pack.json","mods/a:b","mods/CON"] { assert!(checked_path(path,"pack").is_err(),"{path}"); }
        assert_eq!(checked_path("config/你好.txt","pack").unwrap(),"config/你好.txt");
        let file=RemoteFile{path:Some("config/a b.txt".into()),filename:None,file_type:Some("addon".into()),size:None,hashes:vec![],urls:vec![],file_api_template:Some("https://example.invalid/base".into()),curse_project_id:None,curse_file_id:None,required:true,environment:super::super::plan::Environment{client:EnvironmentStatus::Unspecified,server:EnvironmentStatus::Unspecified},source_index:0};
        assert_eq!(member_urls(&file,"config/a b.txt").unwrap(),vec!["https://example.invalid/base/overrides/config/a%20b.txt"]);
        let mut bad=file;bad.file_api_template=Some("https://127.0.0.1/base".into());assert!(member_urls(&bad,"config/x").is_err());
    }
    #[test] fn remote_preflight_rejects_parent_alias_and_file_directory_conflicts() {
        let mut nodes=BTreeMap::new();reserve_path(&mut nodes,"config/a").unwrap();
        assert!(reserve_path(&mut nodes,"CONFIG/b").is_err());
        assert!(reserve_path(&mut nodes,"config/a/b").is_err());
        let mut nodes=BTreeMap::new();reserve_path(&mut nodes,"config/a").unwrap();reserve_path(&mut nodes,"config/b").unwrap();
        assert!(reserve_path(&mut nodes,"config").is_err());
    }
    #[test] fn curse_targets_follow_official_category_and_filename() {
        let file=RemoteFile{path:None,filename:None,file_type:Some("curse".into()),size:None,hashes:vec![],urls:vec![],file_api_template:None,curse_project_id:Some(1),curse_file_id:Some(2),required:true,environment:super::super::plan::Environment{client:EnvironmentStatus::Unspecified,server:EnvironmentStatus::Unspecified},source_index:0};
        for (kind,folder) in [("mod","mods"),("resourcepack","resourcepacks"),("shader","shaderpacks")] {
            let metadata=PackBoundMetadata{kind,filename:"official.zip".into(),size:3,sha1:Some("a".repeat(40)),sha512:None};
            assert_eq!(curse_target(&file,&metadata,"pack").unwrap(),format!("{folder}/official.zip"));
            let mut bad=file.clone();bad.path=Some("mods/other.zip".into());assert!(curse_target(&bad,&metadata,"pack").is_err());
        }
    }
    #[tokio::test] async fn curse_type_case_variants_cannot_bypass_official_ids_via_local_fallback() {
        use super::super::plan::{ArchiveMember, ApplyPhase, Environment};
        for kind in ["curse", "CURSE", "Curse"] {
            let plan=FullPackPlan {
                format:SourceFormat::Mcbbs,name:"pack".into(),mc_version:"1.20.1".into(),target_id:"pack".into(),loader:None,summary:String::new(),manifest_prefix:String::new(),sources:vec![],declarations:vec![],
                remote_files:vec![RemoteFile { path:Some("config/addon.bin".into()),filename:None,file_type:Some(kind.into()),size:Some(99),hashes:vec![hash("sha1","0".repeat(40))],urls:vec![],file_api_template:None,curse_project_id:None,curse_file_id:None,required:true,environment:Environment { client:EnvironmentStatus::Unspecified,server:EnvironmentStatus::Unspecified },source_index:0 }],
                members:vec![ArchiveMember { archive_path:"overrides/config/addon.bin".into(),target_path:Some("config/addon.bin".into()),size:5,phase:ArchivePhase::Overrides }],
                apply_order:vec![ApplyPhase::Remote,ApplyPhase::Overrides,ApplyPhase::ClientOverrides],
            };
            let error=prepare(&plan,&serde_json::json!({"mode":"normal"}),Arc::new(Cancel::default())).await.err().expect("缺少官方 ID 必须拒绝");
            assert!(error.contains("项目 ID"),"{kind}: {error}");
        }
    }
    #[test] fn private_spool_verifies_before_unpublished_instance_write() {
        let fixture=Fixture::new();let bytes=b"remote configuration";let mut spool=download_store::Stage::create(&fixture.0.join("cache")).unwrap();
        let mut writer=spool.take_file().unwrap();writer.write_all(bytes).unwrap();writer.sync_all().unwrap();drop(writer);spool.seal(bytes.len()as u64,&format!("{:x}",Sha256::digest(bytes))).unwrap();
        let mut instance=install_stage::Stage::create(&fixture.0,"instance",&Cancel::default()).unwrap();
        let expected=Prepared{target:"config/a.txt".into(),size:Some(bytes.len()as u64),hashes:vec![hash("sha256",format!("{:x}",Sha256::digest(bytes)))],transport:Transport::Mirrors(vec![])};
        spool.read_archive(&Cancel::default(),|file|{verify_payload(file,&expected,bytes.len()as u64,&Cancel::default())?;instance.write(&expected.target,file,bytes.len()as u64,false,&Cancel::default())}).unwrap();
        assert!(!fixture.0.join("versions/instance").exists());instance.finish(&Cancel::default()).unwrap();instance.publish(&Cancel::default()).unwrap();assert_eq!(fs::read(fixture.0.join("versions/instance/config/a.txt")).unwrap(),bytes);spool.cleanup().unwrap();
    }
}

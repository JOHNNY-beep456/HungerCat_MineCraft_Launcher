//! 有界 ZIP 检查与纯清单解析。probe 不解压文件，也不向 UI 返回清单原文。
use super::{access::leaf, Result};
use serde_json::{json, Value};
use std::{collections::{BTreeMap, BTreeSet}, fs::File, io::{Read, Seek, SeekFrom}, path::Path};
use zip::{CompressionMethod, ZipArchive};

const ARCHIVE_CAP:u64=2*1024*1024*1024;
const JSON_CAP:u64=4*1024*1024;
const TOTAL_CAP:u64=16*1024*1024*1024;
const ENTRIES_CAP:usize=50_000;
const CENTRAL_CAP:u64=16*1024*1024;
const RATIO_CAP:u64=1000;

fn relative(raw:&str, directory:bool)->Result<String> {
    if raw.is_empty() || raw.len()>4096 || raw.starts_with('/') || raw.contains('\\') || raw.chars().any(char::is_control) {
        return Err("归档含绝对路径、反斜杠或无效路径".into());
    }
    let raw=if directory { raw.strip_suffix('/').unwrap_or(raw) } else { raw };
    if raw.is_empty() || raw.split('/').count()>64 { return Err("归档路径层级过深".into()); }
    for part in raw.split('/') { leaf(part)?; }
    Ok(raw.to_owned())
}

// 在 ZipArchive 分配中央目录对象前先限制 EOCD；本批明确不支持多卷与 ZIP64。
fn bounded_directory(file:&mut File)->Result<()> {
    let length=file.metadata().map_err(|_| "无法读取归档大小")?.len();
    if length<22 || length>ARCHIVE_CAP { return Err("整合包归档大小无效或超过 2 GiB".into()); }
    let read=length.min(65_557) as usize;
    file.seek(SeekFrom::End(-(read as i64))).map_err(|_| "无法定位归档目录")?;
    let mut tail=vec![0;read]; file.read_exact(&mut tail).map_err(|_| "无法读取归档目录")?;
    // zip 0.6 从 EOF-22 向前取第一个签名，不先验证 comment 长度。
    // 拒绝整个搜索尾部内的多 EOCD/ZIP64 签名，使库与本检查只能选中同一个 footer。
    let footers:Vec<usize>=tail.windows(4).enumerate().filter_map(|(at,magic)|if magic==b"PK\x05\x06"{Some(at)}else{None}).collect();
    if footers.len()!=1 || tail.windows(4).any(|magic|magic==b"PK\x06\x07"||magic==b"PK\x06\x06") {return Err("归档尾部含歧义 EOCD 或 ZIP64 记录".into());}
    let at=footers[0];
    if at>tail.len()-22 || at+22+u16::from_le_bytes([tail[at+20],tail[at+21]]) as usize!=tail.len(){return Err("ZIP 结束目录损坏".into());}
    let eocd_position=length-read as u64+at as u64;
    if eocd_position>=20 {
        file.seek(SeekFrom::Start(eocd_position-20)).map_err(|_| "无法检查 ZIP64 locator")?;
        let mut locator=[0u8;20];file.read_exact(&mut locator).map_err(|_| "无法读取 ZIP64 locator 检查区域")?;
        if locator[..4]==*b"PK\x06\x07" {return Err("EOCD 前存在不支持的 ZIP64 locator".into());}
    }
    let u16_at=|n:usize|u16::from_le_bytes([tail[at+n],tail[at+n+1]]);
    let u32_at=|n:usize|u32::from_le_bytes([tail[at+n],tail[at+n+1],tail[at+n+2],tail[at+n+3]]);
    let count=u16_at(10) as usize; let size=u32_at(12) as u64; let offset=u32_at(16) as u64;
    if u16_at(4)!=0 || u16_at(6)!=0 || u16_at(8)!=u16_at(10) || count==0 || count>ENTRIES_CAP
        || size>CENTRAL_CAP || size==u32::MAX as u64 || offset==u32::MAX as u64
        || offset.checked_add(size).filter(|end| *end<=length-read as u64+at as u64).is_none() {
        return Err("归档目录超过预算，或使用不支持的多卷/ZIP64 格式".into());
    }
    // 不允许 ZIP64 定位记录覆盖上面的有界 EOCD 值，也不接受自解压偏移。
    let eocd=length-read as u64+at as u64;
    if offset.checked_add(size)!=Some(eocd) {return Err("归档中央目录位置异常或使用 ZIP64 扩展".into());}
    file.seek(SeekFrom::Start(offset)).map_err(|_| "无法定位中央目录")?;
    let mut central=vec![0;size as usize];file.read_exact(&mut central).map_err(|_| "中央目录被截断")?;
    let mut cursor=0usize;let mut central_names=BTreeSet::new();
    for _ in 0..count {
        if cursor.checked_add(46).filter(|end|*end<=central.len()).is_none() || central[cursor..cursor+4]!=[0x50,0x4b,0x01,0x02] {return Err("中央目录条目数或格式不符".into());}
        let word=|n:usize|u16::from_le_bytes([central[cursor+n],central[cursor+n+1]]) as usize;
        let dword=|n:usize|u32::from_le_bytes([central[cursor+n],central[cursor+n+1],central[cursor+n+2],central[cursor+n+3]]);
        let name=word(28);let extra=word(30);let comment=word(32);let flags=word(8);
        if name==0 || name>4096 || word(34)!=0 || flags&1!=0 || dword(20)==u32::MAX || dword(24)==u32::MAX || dword(42)==u32::MAX {return Err("归档使用加密、多卷、ZIP64 或无效名称".into());}
        let end=cursor.checked_add(46+name+extra+comment).filter(|end|*end<=central.len()).ok_or("中央目录长度异常")?;
        let raw=std::str::from_utf8(&central[cursor+46..cursor+46+name]).map_err(|_| "归档名称必须为 UTF-8")?;
        let normalized=relative(raw,raw.ends_with('/'))?;
        if !central_names.insert(normalized.to_lowercase()){return Err("中央目录含重复或大小写别名路径".into());}
        let mut position=cursor+46+name;let extra_end=position+extra;
        while position<extra_end {
            if position+4>extra_end {return Err("中央目录扩展损坏".into());}
            let id=u16::from_le_bytes([central[position],central[position+1]]);let length=u16::from_le_bytes([central[position+2],central[position+3]]) as usize;
            if id==1 || id==0x000d {return Err("归档含 ZIP64 或 Unix 链接扩展".into());}
            position=position.checked_add(4+length).filter(|end|*end<=extra_end).ok_or("中央目录扩展长度异常")?;
        }
        cursor=end;
    }
    if cursor!=central.len(){return Err("中央目录含多余条目或扩展记录".into());}
    file.seek(SeekFrom::Start(0)).map_err(|_| "无法重置归档位置")?;
    Ok(())
}

#[derive(Debug)]
pub(super) struct ArchiveManifest { pub(super) index:usize, pub(super) name:String, pub(super) prefix:String }
fn preflight(archive:&mut ZipArchive<&mut File>)->Result<ArchiveManifest> {
    if archive.len()==0 || archive.len()>ENTRIES_CAP { return Err("归档条目数超过预算".into()); }
    let mut total=0u64; let mut compressed=0u64;
    let mut nodes:BTreeMap<String,(String,bool,bool)>=BTreeMap::new();
    let mut manifests=Vec::new();
    for index in 0..archive.len() {
        let item=archive.by_index(index).map_err(|_| "归档条目损坏、加密或压缩格式不受支持")?;
        let name=std::str::from_utf8(item.name_raw()).map_err(|_| "归档名称必须为 UTF-8")?;
        let directory=item.is_dir();
        let path=relative(name,directory)?;
        if !matches!(item.compression(),CompressionMethod::Stored|CompressionMethod::Deflated) { return Err("归档含不支持的压缩方式".into()); }
        if let Some(mode)=item.unix_mode() {
            let kind=mode&0o170000;
            let expected=if directory {0o040000} else {0o100000};
            if kind!=0 && kind!=expected { return Err("归档含链接、设备或特殊文件".into()); }
        }
        if directory && item.size()!=0 { return Err("归档目录携带文件数据".into()); }
        total=total.checked_add(item.size()).ok_or("归档解压大小溢出")?;
        compressed=compressed.checked_add(item.compressed_size()).ok_or("归档压缩大小溢出")?;
        if item.size()>ARCHIVE_CAP || total>TOTAL_CAP || (item.size()>1024*1024 && item.size()>item.compressed_size().max(1).saturating_mul(RATIO_CAP)) {
            return Err("归档解压大小或压缩比超过预算".into());
        }
        let parts:Vec<_>=path.split('/').collect(); let mut prefix=String::new();
        for (position,part) in parts.iter().enumerate() {
            if !prefix.is_empty() {prefix.push('/');} prefix.push_str(part);
            let last=position+1==parts.len(); let is_dir=!last||directory; let key=prefix.to_lowercase();
            if let Some((prior,prior_dir,explicit))=nodes.get_mut(&key) {
                if *prior!=prefix || !*prior_dir || !is_dir || (last&&*explicit) { return Err("归档含重复路径、大小写别名或文件目录冲突".into()); }
                if last {*explicit=true;}
            } else {nodes.insert(key,(prefix.clone(),is_dir,last));}
            if nodes.len()>100_000 {return Err("归档路径节点总数超过预算".into());}
        }
        if !directory {
            let basename=parts.last().copied().unwrap_or("");
            if ["modrinth.index.json","mcbbs.packmeta","launcher.packmeta","manifest.json"].contains(&basename) {
                manifests.push(ArchiveManifest {index,name:basename.to_owned(),prefix:path.rsplit_once('/').map(|(base,_)|format!("{base}/")).unwrap_or_default()});
            }
        }
    }
    if total>1024*1024 && total>compressed.max(1).saturating_mul(RATIO_CAP) {return Err("归档整体压缩比超过预算".into());}
    let mut recognized=Vec::new();let mut json_budget=16*1024*1024u64;
    for manifest in manifests {
        // manifest.json 也常用于 overrides 中的普通配置；仅结构匹配的对象属于整合包清单。
        if manifest.name!="manifest.json" || recognizable_manifest(archive,manifest.index,&mut json_budget)? {recognized.push(manifest);}
    }
    if recognized.len()!=1 { return Err(if recognized.is_empty() {"无法识别的整合包格式"} else {"归档存在多个或歧义整合包清单"}.into()); }
    Ok(recognized.remove(0))
}

fn recognizable_manifest(archive:&mut ZipArchive<&mut File>,index:usize,budget:&mut u64)->Result<bool> {
    let mut entry=archive.by_index(index).map_err(|_| "无法检查 manifest.json")?;
    if entry.size()>JSON_CAP {return Ok(false);}
    *budget=budget.checked_sub(entry.size()).ok_or("候选清单读取总量超过预算")?;
    let mut bytes=Vec::new();entry.by_ref().take(JSON_CAP+1).read_to_end(&mut bytes).map_err(|_| "候选清单损坏或 CRC 校验失败")?;
    if bytes.len() as u64>JSON_CAP || bytes.len() as u64!=entry.size(){return Err("候选清单大小不符".into());}
    let bytes=bytes.strip_prefix(&[0xef,0xbb,0xbf]).unwrap_or(&bytes);
    let Ok(value)=serde_json::from_slice::<Value>(bytes) else{return Ok(false);};
    Ok(value.is_object()&&["addons","mcbbs","minecraft"].iter().any(|key|value.get(key).is_some()))
}

fn scalar(value:Option<&Value>)->Result<String> {
    match value {None|Some(Value::Null)=>Ok(String::new()),Some(Value::String(s)) if s.len()<=8192&&!s.chars().any(|c|c=='\0')=>Ok(s.clone()),Some(Value::Number(n))=>Ok(n.to_string()),_=>Err("整合包元数据字段类型无效".into())}
}
fn field(value:&Value,key:&str)->Result<String> {scalar(value.get(key))}
fn alternate(value:&Value,first:&str,second:&str)->Result<String> {let a=field(value,first)?;if a.is_empty(){field(value,second)}else{Ok(a)}}
fn normalized_loader(raw:&str)->Option<&'static str> {
    let lower=raw.to_lowercase();
    if lower.contains("fabric"){Some("fabric")}else if lower.contains("quilt"){Some("quilt")}else if lower.contains("neoforge")||lower.contains("neo-forge"){Some("neoforge")}else if lower.contains("forge"){Some("forge")}else{None}
}
fn mcbbs_meta(value:&Value)->Result<(String,Option<String>,String)> {
    let mut mc=String::new();let mut loader=None;let mut version=String::new();
    if let Some(addons)=value.get("addons") {
        match addons {
            Value::Array(rows)=>for row in rows {if !row.is_object(){return Err("addons 条目必须为对象".into());}let id=field(row,"id")?.to_lowercase();let v=field(row,"version")?;
                if matches!(id.as_str(),"game"|"minecraft"){if mc.is_empty(){mc=v;}}else if matches!(id.as_str(),"fabric"|"quilt"|"forge"|"neoforge"){loader=Some(id);version=v;}
            },
            Value::Object(map)=>{mc=scalar(map.get("game").or_else(||map.get("minecraft")))?;for name in ["fabric","quilt","neoforge","forge"] {let v=scalar(map.get(name))?;if !v.is_empty(){loader=Some(name.to_owned());version=v;break;}}},
            Value::Null=>{},_=>return Err("addons 必须为数组或对象".into()),
        }
    }
    let minecraft=value.get("minecraft");
    if mc.is_empty(){mc=match minecraft {Some(Value::Object(_))=>alternate(minecraft.unwrap(),"version","id")?,_=>scalar(minecraft)?};}
    if loader.is_none(){if let Some(rows)=minecraft.and_then(|m|m.get("modLoaders")).and_then(Value::as_array){for row in rows {let id=field(row,"id")?.to_lowercase();for name in ["neoforge","forge","fabric","quilt"] {if let Some(tail)=id.strip_prefix(name){let tail=tail.strip_prefix('-').unwrap_or(tail);if !tail.is_empty(){loader=Some(name.to_owned());version=tail.to_owned();break;}}}if loader.is_some(){break;}}}}
    if mc.is_empty(){for key in ["gameVersion","mcVersion","minecraftVersion","game_version","mc_version"] {let candidate=field(value,key)?;let s=candidate.trim();let mut parts=s.split('.');if parts.next().map(|p|!p.is_empty()&&p.chars().all(|c|c.is_ascii_digit())).unwrap_or(false)&&parts.next().and_then(|p|p.chars().next()).map(|c|c.is_ascii_digit()).unwrap_or(false){mc=s.to_owned();break;}}}
    if loader.is_none(){let raw=scalar(value.get("mod_loader").or_else(||value.get("loader")))?;loader=normalized_loader(&raw).map(str::to_owned);version=scalar(value.get("mod_loader_version").or_else(||value.get("loader_version")))?;}
    Ok((mc,loader,version))
}

#[derive(Debug,PartialEq,Eq)]
enum Reference { Curse { project:u64,file:u64,required:bool }, Path(String) }
fn references(value:&Value,mr:bool)->Result<Vec<Reference>> {
    let Some(files)=value.get("files") else{return Ok(Vec::new());};
    let files=files.as_array().ok_or("清单 files 必须为数组")?;
    if files.len()>ENTRIES_CAP {return Err("清单文件数量超过预算".into());}
    let mut refs=Vec::new();let mut paths=BTreeSet::new();let mut ids=BTreeSet::new();
    for row in files {
        if !row.is_object(){return Err("清单文件条目必须为对象".into());}
        let kind=field(row,"type")?.to_lowercase();
        let project=row.get("projectID").or_else(||row.get("projectId"));let file=row.get("fileID").or_else(||row.get("fileId"));
        // 标准 CF 无 type/path：按 ID 引用识别，绝不落入旧版 Addon 分支后静默丢弃。
        if !mr&&(kind=="curse"||project.is_some()||file.is_some()) {
            let id=|v:Option<&Value>|v.and_then(|v|v.as_u64().or_else(||v.as_str().and_then(|s|s.parse::<u64>().ok()))).filter(|id|*id>0).ok_or("CurseForge 引用缺少有效项目或文件 ID");
            let project=id(project)?;let file=id(file)?;
            let required=match row.get("required"){None=>true,Some(Value::Bool(v))=>*v,_=>return Err("CurseForge required 必须为布尔值".into())};
            if !ids.insert((project,file)){return Err("清单含重复 CurseForge 文件引用".into());}
            let filename=field(row,"fileName")?;if !filename.is_empty(){relative(&filename,false)?;}
            refs.push(Reference::Curse {project,file,required});
        } else {
            if !mr&&!matches!(kind.as_str(),""|"addon"){return Err("清单文件类型不受支持".into());}
            let path=field(row,"path")?;if path.is_empty(){return Err("清单文件缺少路径或 CurseForge ID".into());}
            let path=relative(&path,false)?;
            if !paths.insert(path.to_lowercase()){return Err("清单文件存在重复或大小写路径冲突".into());}
            refs.push(Reference::Path(path));
        }
    }
    Ok(refs)
}

fn parse_manifest(value:&Value,name:&str,fallback:&str)->Result<Value> {
    if !value.is_object(){return Err("整合包清单必须为 JSON 对象".into());}
    let (format,pack_name,mc,loader,version,summary)=if name=="modrinth.index.json" {
        let deps=value.get("dependencies").filter(|d|d.is_object()).ok_or("Modrinth 清单缺少 dependencies 对象")?;
        let mut loader=None;let mut version=String::new();
        for (key,kind) in [("fabric-loader","fabric"),("quilt-loader","quilt"),("forge","forge"),("neoforge","neoforge"),("neo-forge","neoforge")] {let v=field(deps,key)?;if !v.is_empty(){if loader.is_some(){return Err("整合包声明多个加载器，无法确定客户端配置".into());}loader=Some(kind.to_owned());version=v;}}
        references(value,true)?;
        ("modrinth",field(value,"name")?,field(deps,"minecraft")?,loader,version,field(value,"summary")?)
    } else {
        if name=="manifest.json"&&!["addons","mcbbs","minecraft"].iter().any(|key|value.get(key).is_some()){return Err("manifest.json 不是受支持的整合包清单".into());}
        let native=name=="launcher.packmeta";
        let (mc,loader,version)=mcbbs_meta(value)?;
        if !native {references(value,false)?;}
        (if native{"native"}else{"mcbbs"},alternate(value,"name","title")?,mc,loader,version,alternate(value,"description","summary")?)
    };
    Ok(json!({"format":format,"name":if pack_name.is_empty(){fallback}else{&pack_name},"mcVersion":mc,"loader":loader,"loaderVersion":version,"summary":summary}))
}

/// 在返回条目读取器之前完成全部目录、路径、预算和唯一清单检查。
/// 调用方仍须在读取前后复核外部文件句柄身份，不可把此接口当作路径授权。
pub(super) fn open_validated(file:&mut File)->Result<(ZipArchive<&mut File>,ArchiveManifest)> {
    bounded_directory(file)?;
    let mut archive=ZipArchive::new(file).map_err(|_| "无法读取 ZIP 整合包")?;
    let manifest=preflight(&mut archive)?;
    Ok((archive,manifest))
}

pub(super) fn probe(file:&mut File,path:&Path)->Result<Value> {
    let (mut archive,manifest)=open_validated(file)?;
    // 保留清单所在 base：嵌套包只能有一个清单；未来导入应从同一 prefix 取 overrides。
    let _prefix=&manifest.prefix;
    let mut entry=archive.by_index(manifest.index).map_err(|_| "无法读取整合包清单")?;
    if entry.size()>JSON_CAP {return Err("整合包清单超过 4 MiB".into());}
    let mut bytes=Vec::new();entry.by_ref().take(JSON_CAP+1).read_to_end(&mut bytes).map_err(|_| "清单损坏或 CRC 校验失败")?;
    if bytes.len() as u64>JSON_CAP || bytes.len() as u64!=entry.size(){return Err("整合包清单大小不符".into());}
    let bytes=bytes.strip_prefix(&[0xef,0xbb,0xbf]).unwrap_or(&bytes);
    let value:Value=serde_json::from_slice(bytes).map_err(|_| "整合包清单不是有效 JSON")?;
    let filename=path.file_name().and_then(|p|p.to_str()).unwrap_or("整合包");
    let fallback=filename.rsplit_once('.').filter(|(_,ext)|ext.eq_ignore_ascii_case("zip")||ext.eq_ignore_ascii_case("mrpack")).map(|(stem,_)|stem).unwrap_or(filename);
    parse_manifest(&value,&manifest.name,fallback)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::{write::FileOptions,ZipWriter};
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn zip(entries:&[(&str,&[u8])])->Self {let p=std::env::temp_dir().join(format!("hcmcl-pack-probe-{}.zip",uuid::Uuid::new_v4()));let f=File::create(&p).unwrap();let mut zip=ZipWriter::new(f);for (name,data) in entries {zip.start_file(*name,FileOptions::default().compression_method(CompressionMethod::Stored)).unwrap();zip.write_all(data).unwrap();}zip.finish().unwrap();Self(p)}
        fn probe(&self)->Result<Value>{probe(&mut File::open(&self.0).unwrap(),&self.0)}
    }
    impl Drop for Fixture {fn drop(&mut self){let _=std::fs::remove_file(&self.0);}}
    #[test] fn three_formats_cf_and_mc_dependency_are_normalized(){
        let mr=json!({"name":"包","versionId":"pack-version","summary":"说明","dependencies":{"minecraft":"1.21.1","fabric-loader":"0.16.9"},"files":[]});
        let dto=parse_manifest(&mr,"modrinth.index.json","fallback").unwrap();assert_eq!(dto,json!({"format":"modrinth","name":"包","mcVersion":"1.21.1","loader":"fabric","loaderVersion":"0.16.9","summary":"说明"}));
        let mcbbs=json!({"title":"旧包","addons":{"game":"1.20.1","forge":"47.2.0"},"description":"简介"});
        assert_eq!(parse_manifest(&mcbbs,"mcbbs.packmeta","x").unwrap()["loaderVersion"],"47.2.0");
        let native=json!({"game_version":"1.20.4","mod_loader":"quilt","mod_loader_version":"0.26.0"});
        let dto=parse_manifest(&native,"launcher.packmeta","native-name").unwrap();assert_eq!(dto["format"],"native");assert_eq!(dto["name"],"native-name");assert_eq!(dto["loader"],"quilt");
        let cf=json!({"name":"CF","minecraft":{"version":"1.20.1","modLoaders":[{"id":"forge-47.3.0","primary":true}]},"files":[{"projectID":12,"fileID":34,"required":false}]});
        assert_eq!(references(&cf,false).unwrap(),vec![Reference::Curse{project:12,file:34,required:false}]);let dto=parse_manifest(&cf,"manifest.json","x").unwrap();assert_eq!(dto["format"],"mcbbs");assert_eq!(dto["mcVersion"],"1.20.1");assert_eq!(dto["loaderVersion"],"47.3.0");
        assert!(references(&json!({"files":[{"projectID":12,"fileID":0}]}),false).is_err());
        for (name,value) in [("modrinth.index.json",mr),("mcbbs.packmeta",mcbbs),("launcher.packmeta",native),("manifest.json",cf)] {let bytes=serde_json::to_vec(&value).unwrap();let dto=Fixture::zip(&[(name,&bytes)]).probe().unwrap();assert_eq!(dto.as_object().unwrap().len(),6);}
    }
    #[test] fn real_nested_zip_is_read_without_extracting(){
        let raw=br#"{"name":"nested","dependencies":{"minecraft":"1.21.1"},"files":[]}"#;
        let fixture=Fixture::zip(&[("bundle/modrinth.index.json",raw),("bundle/overrides/config/example.txt",b"fixture")]);
        let before=std::fs::metadata(&fixture.0).unwrap();let dto=fixture.probe().unwrap();let after=std::fs::metadata(&fixture.0).unwrap();assert_eq!(dto["name"],"nested");assert_eq!(before.len(),after.len());assert_eq!(before.modified().unwrap(),after.modified().unwrap());
        let mut file=File::open(&fixture.0).unwrap();bounded_directory(&mut file).unwrap();let mut archive=ZipArchive::new(&mut file).unwrap();assert_eq!(preflight(&mut archive).unwrap().prefix,"bundle/");
    }
    #[test] fn real_archives_reject_traversal_case_collisions_and_manifest_ambiguity(){
        let raw=br#"{"dependencies":{"minecraft":"1.21"}}"#;
        for bad in ["../outside","/absolute","C:/drive","x\\..\\bad","x/CON.txt","x/a:stream","x/name.","x/name ","a//b"] {let f=Fixture::zip(&[("modrinth.index.json",raw),(bad,b"x")]);assert!(f.probe().is_err(),"{bad}");}
        for entries in [vec![("modrinth.index.json",raw.as_slice()),("Mods/a.jar",b"a".as_slice()),("mods/b.jar",b"b".as_slice())],vec![("modrinth.index.json",raw.as_slice()),("other/manifest.json",br#"{"minecraft":{"version":"1.20.1"}}"#.as_slice())],vec![("modrinth.index.json",raw.as_slice()),("a",b"x".as_slice()),("a/b",b"y".as_slice())]] {assert!(Fixture::zip(&entries).probe().is_err());}
    }
    #[test] fn ordinary_manifests_do_not_conflict_but_two_cf_packs_do(){
        let mr=br#"{"name":"pack","dependencies":{"minecraft":"1.21.1"}}"#;
        for config in [b"{}".as_slice(),br#"{"configVersion":3,"setting":true}"#.as_slice(),b"ordinary non-json configuration".as_slice()] {
            let fixture=Fixture::zip(&[("modrinth.index.json",mr),("overrides/manifest.json",config)]);
            assert_eq!(fixture.probe().unwrap()["format"],"modrinth");
        }
        let cf=br#"{"name":"CF","minecraft":{"version":"1.20.1"},"files":[{"projectID":12,"fileID":34,"required":true}]}"#;
        let fixture=Fixture::zip(&[("bundle/manifest.json",cf),("bundle/overrides/manifest.json",b"{}")]);assert_eq!(fixture.probe().unwrap()["name"],"CF");
        let fixture=Fixture::zip(&[("first/manifest.json",cf),("second/manifest.json",cf)]);assert!(fixture.probe().unwrap_err().contains("歧义"));
    }
    #[test] fn locator_in_central_comment_and_fake_eocd_in_footer_comment_are_rejected(){
        let fixture=Fixture::zip(&[("launcher.packmeta",b"{}")]);let original=std::fs::read(&fixture.0).unwrap();
        let central=original.windows(4).position(|magic|magic==b"PK\x01\x02").unwrap();let end=original.len()-22;
        // central comment = 伪 ZIP64 footer（巨大 count）+ locator。EOCD 仍是普通有界 count。
        let mut comment=vec![0u8;76];comment[..4].copy_from_slice(b"PK\x06\x06");comment[4..12].copy_from_slice(&44u64.to_le_bytes());
        comment[24..32].copy_from_slice(&u64::MAX.to_le_bytes());comment[32..40].copy_from_slice(&u64::MAX.to_le_bytes());
        comment[56..60].copy_from_slice(b"PK\x06\x07");comment[64..72].copy_from_slice(&(end as u64).to_le_bytes());comment[72..76].copy_from_slice(&1u32.to_le_bytes());
        let mut bytes=original.clone();bytes[central+32..central+34].copy_from_slice(&(comment.len() as u16).to_le_bytes());bytes.splice(end..end,comment.iter().copied());
        let new_end=end+comment.len();let old_size=u32::from_le_bytes(original[end+12..end+16].try_into().unwrap());bytes[new_end+12..new_end+16].copy_from_slice(&(old_size+comment.len() as u32).to_le_bytes());
        std::fs::write(&fixture.0,&bytes).unwrap();let error=bounded_directory(&mut File::open(&fixture.0).unwrap()).unwrap_err();assert!(error.contains("ZIP64"));
        // 最大 comment 使 locator 落在尾部扫描窗口外，仍须直接检查 EOCD 前 20 字节。
        bytes[new_end+20..new_end+22].copy_from_slice(&u16::MAX.to_le_bytes());bytes.extend(std::iter::repeat(b'x').take(u16::MAX as usize));
        std::fs::write(&fixture.0,&bytes).unwrap();let error=bounded_directory(&mut File::open(&fixture.0).unwrap()).unwrap_err();assert!(error.contains("EOCD 前"));
        // 真 footer 的 comment 内放一个更靠后的假 EOCD；依赖原先会选择假 footer。
        let mut bytes=original.clone();let mut comment=vec![b'x';8];comment.extend_from_slice(&original[end..]);bytes[end+20..end+22].copy_from_slice(&(comment.len() as u16).to_le_bytes());bytes.extend_from_slice(&comment);
        std::fs::write(&fixture.0,&bytes).unwrap();let error=bounded_directory(&mut File::open(&fixture.0).unwrap()).unwrap_err();assert!(error.contains("EOCD"));
        // 正常不含签名的 EOCD comment 保持兼容。
        let mut bytes=original;let comment=b"ordinary archive comment";bytes[end+20..end+22].copy_from_slice(&(comment.len() as u16).to_le_bytes());bytes.extend_from_slice(comment);std::fs::write(&fixture.0,&bytes).unwrap();assert_eq!(fixture.probe().unwrap()["format"],"native");
    }
    #[test] fn actual_duplicate_paths_and_eocd_budget_are_rejected_before_allocation(){
        let fixture=Fixture::zip(&[("launcher.packmeta",b"{}"),("a.txt",b"a"),("b.txt",b"b")]);
        let mut bytes=std::fs::read(&fixture.0).unwrap();
        for at in 0..bytes.len().saturating_sub(5) {if &bytes[at..at+5]==b"b.txt" {bytes[at]=b'a';}}
        std::fs::write(&fixture.0,&bytes).unwrap();assert!(fixture.probe().is_err());
        let fixture=Fixture::zip(&[("launcher.packmeta",b"{}")]);let original=std::fs::read(&fixture.0).unwrap();
        let end=original.len()-22;
        for offset in [8usize,10usize] {let mut bytes=original.clone();bytes[end+offset..end+offset+2].copy_from_slice(&50_001u16.to_le_bytes());std::fs::write(&fixture.0,&bytes).unwrap();assert!(fixture.probe().is_err());}
        let mut bytes=original;bytes[end+12..end+16].copy_from_slice(&u32::MAX.to_le_bytes());std::fs::write(&fixture.0,&bytes).unwrap();assert!(fixture.probe().is_err());
    }
    #[test] fn malformed_json_size_ratio_and_symlink_modes_are_rejected(){
        assert!(Fixture::zip(&[("manifest.json",b"not json")]).probe().is_err());
        assert!(Fixture::zip(&[("manifest.json",b"{}")]).probe().is_err());
        let oversized=vec![b' ';JSON_CAP as usize+1];assert!(Fixture::zip(&[("mcbbs.packmeta",&oversized)]).probe().is_err());
        let fixture=Fixture::zip(&[("launcher.packmeta",b"{}")]);let mut bytes=std::fs::read(&fixture.0).unwrap();let at=bytes.windows(4).position(|w|w==b"PK\x01\x02").unwrap();bytes[at+5]=3;bytes[at+38..at+42].copy_from_slice(&(0o120777u32<<16).to_le_bytes());std::fs::write(&fixture.0,bytes).unwrap();assert!(fixture.probe().is_err());
        let fixture=Fixture::zip(&[("launcher.packmeta",b"{}")]);let mut zip=ZipWriter::new(File::create(&fixture.0).unwrap());zip.start_file("launcher.packmeta",FileOptions::default()).unwrap();zip.write_all(b"{}").unwrap();zip.start_file("overrides/bomb",FileOptions::default().compression_method(CompressionMethod::Deflated)).unwrap();zip.write_all(&vec![0;4*1024*1024]).unwrap();zip.finish().unwrap();assert!(fixture.probe().is_err());
    }
}

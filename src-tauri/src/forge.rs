//! Forge/NeoForge 安装器仅在本任务拥有的独立目录运行；不把真实游戏根交给 Java。
use serde_json::{json, Map, Value};
use std::{cmp::Ordering, collections::BTreeMap, fs, io::Read, path::{Path, PathBuf}, sync::Arc, time::SystemTime};
use tauri::Emitter;
use crate::{downloads::{self, Cancel, JobGuard, Progress}, install_lock, loaders, runtime};
type Result<T> = std::result::Result<T, String>;
fn text<'a>(v: &'a Value, key: &str) -> &'a str { v.get(key).and_then(Value::as_str).unwrap_or("") }
fn forge_kind(value: &str) -> Result<&str> { match value { "forge"|"neoforge" => Ok(value), _ => Err("未知 Forge 加载器类型".into()) } }
fn string_arg(args: &[Value], index: usize, label: &str, required: bool) -> Result<String> {
    match args.get(index) {
        Some(Value::String(s)) if s.len()<=240 && !s.chars().any(char::is_control) && (!required||!s.is_empty()) => Ok(s.clone()),
        None|Some(Value::Null) if !required => Ok(String::new()), _ => Err(format!("{label}必须是有效字符串")),
    }
}
fn mobile_guard() -> Result<()> { if cfg!(any(target_os="android",target_os="ios")) { Err("Android/iOS 尚未接入 Forge/NeoForge 安装器 JVM，不能执行桌面 Java".into()) } else { Ok(()) } }
fn local_guard(settings: &Value) -> Result<()> { if text(settings,"mode")=="local" { Err("本地模式禁止运行可能自行联网的 Forge/NeoForge 安装器".into()) } else { Ok(()) } }
fn matches_mc(version: &str, mc: &str, kind: &str) -> bool {
    if version.starts_with(&format!("{mc}-")) { return true; }
    if kind=="neoforge" { let p=mc.split('.').collect::<Vec<_>>(); if p.len()>=2&&p[0]=="1" { let prefix=if p.len()>=3 { format!("{}.{}.",p[1],p[2]) } else { format!("{}.0.",p[1]) }; return version.starts_with(&prefix); } }
    false
}
fn natural_cmp(a: &str, b: &str) -> Ordering {
    let parts=|s:&str| -> Vec<String> { let mut out=Vec::new();let mut current=String::new();let mut digit=None;for c in s.chars(){let d=c.is_ascii_digit();if digit.is_some_and(|old|old!=d){out.push(std::mem::take(&mut current));}digit=Some(d);current.push(c);}out.push(current);out };
    let aa=parts(a);let bb=parts(b);for i in 0..aa.len().max(bb.len()){let a=aa.get(i).map(String::as_str).unwrap_or("");let b=bb.get(i).map(String::as_str).unwrap_or("");let order=if a.bytes().all(|c|c.is_ascii_digit())&&b.bytes().all(|c|c.is_ascii_digit())&&!a.is_empty()&&!b.is_empty(){let a=a.trim_start_matches('0');let b=b.trim_start_matches('0');a.len().cmp(&b.len()).then_with(||a.cmp(b))}else{a.cmp(b)};if order!=Ordering::Equal{return order;}}Ordering::Equal
}
fn parse_versions(xml: &str, kind: &str, mc: &str) -> Result<Vec<String>> {
    forge_kind(kind)?;downloads::identifier(mc)?;
    if xml.len()>32*1024*1024 || xml.contains("<!DOCTYPE") || xml.contains("<!ENTITY") { return Err("Maven XML 过大或含实体声明".into()); }
    let re=regex::Regex::new(r"<version>\s*([^<]{1,240})\s*</version>").map_err(|_|"版本解析规则无效")?;
    let unstable=regex::Regex::new(r"(?i)-(?:pre|rc|beta|alpha|snapshot)").map_err(|_|"版本排序规则无效")?;
    let mut out=Vec::new();for cap in re.captures_iter(xml).take(100001){if out.len()>100000{return Err("Maven 版本数量过多".into());}let v=cap[1].trim();downloads::identifier(v)?;if matches_mc(v,mc,kind)&&!out.iter().any(|old|old==v){out.push(v.to_string());}}
    out.sort_by(|a,b|unstable.is_match(a).cmp(&unstable.is_match(b)).then_with(||natural_cmp(b,a)));out.truncate(200);Ok(out)
}
#[derive(Clone)] struct Request { kind:String,mc:String,version:String,target:Option<String>,wait:Option<String>,in_place:bool }
fn parse_request(channel: &str, args: &[Value]) -> Result<Request> {
    let in_place=channel=="loaders:installInPlace";let max=if in_place{5}else{6};let min=if in_place{4}else{3};if args.len()<min||args.len()>max{return Err("Forge 安装参数数量不符".into());}
    let kind=forge_kind(&string_arg(args,0,"加载器类型",true)?)?.to_string();let mc=string_arg(args,1,"Minecraft 版本",true)?;let version=string_arg(args,2,"加载器版本",true)?;let target=string_arg(args,3,"实例名称",in_place)?;let wait=if in_place{String::new()}else{string_arg(args,4,"等待原版版本",false)?};let _=string_arg(args,if in_place{4}else{5},"版本目录",false)?;
    for v in [&mc,&version,&target,&wait].into_iter().filter(|v|!v.is_empty()){downloads::identifier(v)?;}if kind=="neoforge"&&mc=="1.20.1"{return Err("NeoForge 1.20.1 的旧 net.neoforged:forge 安装协议尚未适配".into());}if !matches_mc(&version,&mc,&kind){return Err("Forge/NeoForge 版本号与 Minecraft 版本不匹配".into());}if !wait.is_empty()&&wait!=mc{return Err("等待的原版版本必须与安装 Minecraft 版本一致".into());}
    Ok(Request{kind,mc,version,target:(!target.is_empty()).then_some(target),wait:(!wait.is_empty()).then_some(wait),in_place})
}
struct Staging { root:PathBuf,path:PathBuf,token:String }
impl Staging {
    fn new(root: &Path,cancel: &Cancel) -> Result<Self> {
        cancel.check()?;let parent=downloads::inside_path(root,".installers")?;fs::create_dir_all(&parent).map_err(|_|"无法创建安装器工作目录")?;let token=uuid::Uuid::new_v4().to_string();let path=downloads::inside_path(root,Path::new(".installers").join(format!("staging-{token}")))?;fs::create_dir(&path).map_err(|_|"无法独占创建安装器 staging")?;
        let staging=Self{root:root.to_path_buf(),path,token};if let Err(e)=downloads::write_new_bytes(&staging.path.join(".hcmcl-forge-owner"),staging.token.as_bytes(),cancel){let _=fs::remove_dir(&staging.path);return Err(e);}Ok(staging)
    }
    fn clean(&self) -> Result<()> { if !self.path.exists(){return Ok(());}let marker=self.path.join(".hcmcl-forge-owner");if downloads::read_bytes(&marker)?!=self.token.as_bytes(){return Err("安装器 staging 所有权变化，已保留目录".into());}for entry in fs::read_dir(&self.path).map_err(|_|"无法枚举 staging 清理目录")?{let path=entry.map_err(|_|"无法读取 staging 清理条目")?.path();if path!=marker{remove_owned(&self.root,&path)?;}}if downloads::read_bytes(&marker)?!=self.token.as_bytes(){return Err("清理期间 staging 所有权变化".into());}fs::remove_file(marker).map_err(|_|"无法清理 staging 标记")?;fs::remove_dir(&self.path).map_err(|_|"无法清理 staging 空目录".into()) }
}
fn remove_owned(root:&Path,path:&Path)->Result<()> {let relative=path.strip_prefix(root).map_err(|_|"staging 清理越界")?;let path=downloads::inside_path(root,relative)?;if !path.exists(){return Ok(());}let m=fs::symlink_metadata(&path).map_err(|_|"无法校验 staging 清理路径")?;if m.is_dir(){for e in fs::read_dir(&path).map_err(|_|"无法枚举 staging")?{remove_owned(root,&e.map_err(|_|"无法读取 staging 条目")?.path())?;}fs::remove_dir(path).map_err(|_|"无法清理 staging".into())}else if m.is_file(){fs::remove_file(path).map_err(|_|"无法清理 staging 文件".into())}else{Err("staging 含特殊文件，已保留".into())}}
impl Drop for Staging { fn drop(&mut self){let _=self.clean();} }
fn jar_json(jar:&Path,name:&str)->Result<Option<Value>> {
    let file=fs::File::open(jar).map_err(|_|"无法读取安装器 JAR")?;let mut zip=zip::ZipArchive::new(file).map_err(|_|"安装器不是有效 ZIP/JAR")?;if zip.len()>100000{return Err("安装器归档条目过多".into());}
    let entry=zip.by_name(name);let mut entry=match entry{Ok(entry)=>entry,Err(zip::result::ZipError::FileNotFound)=>return Ok(None),Err(_)=>return Err("无法读取安装器元数据".into())};if entry.size()>8*1024*1024||entry.unix_mode().is_some_and(|m|!matches!(m&0o170000,0|0o100000)){return Err("安装器元数据过大或不是普通文件".into());}let mut data=Vec::new();entry.by_ref().take(8*1024*1024+1).read_to_end(&mut data).map_err(|_|"安装器元数据读取失败")?;if data.len()>8*1024*1024{return Err("安装器元数据过大".into());}let value:Value=serde_json::from_slice(&data).map_err(|_|"安装器元数据不是有效 JSON")?;if !value.is_object(){return Err("安装器元数据不是对象".into());}Ok(Some(value))
}
fn binding_coordinate(request:&Request)->String {if request.kind=="forge"{format!("net.minecraftforge:forge:{}",request.version)}else{format!("net.neoforged:neoforge:{}",request.version)}}
fn checked_profile(profile:Value,request:&Request,installer_mc:bool)->Result<Value>{
    let id=text(&profile,"id");downloads::identifier(id)?;let inherited=text(&profile,"inheritsFrom");if inherited!=request.mc&&!(inherited.is_empty()&&installer_mc){return Err("安装器 profile Minecraft 绑定不匹配".into());}
    let main=text(&profile,"mainClass");let expected_main=if request.kind=="neoforge"{main.starts_with("net.neoforged.")||main=="cpw.mods.bootstraplauncher.BootstrapLauncher"}else{main.starts_with("net.minecraftforge.")||main=="cpw.mods.bootstraplauncher.BootstrapLauncher"||main=="cpw.mods.modlauncher.Launcher"||main=="net.minecraft.launchwrapper.Launch"};if !expected_main{return Err("Forge profile 启动类不匹配".into());}
    let libs=profile["libraries"].as_array().ok_or("Forge profile 缺少 libraries")?;if libs.len()>20000{return Err("Forge profile 依赖过多".into());}let binding=binding_coordinate(request);if request.kind=="neoforge"{validate_neo_profile(&profile,request)?;}else if !libs.iter().any(|lib|{let n=text(lib,"name");n==binding||n.starts_with(&format!("{binding}:"))||n.starts_with(&format!("{binding}@"))}){return Err("Forge profile 加载器坐标与请求版本不符".into());}
    if let Some(v)=profile.get("clientVersion"){if v.as_str()!=Some(request.mc.as_str()){return Err("Forge profile clientVersion 不匹配".into());}}if let Some(v)=profile.get("jar"){if v.as_str()!=Some(request.mc.as_str())&&v.as_str()!=Some(id){return Err("Forge profile jar 绑定不匹配".into());}}
    let mut clean=Map::new();for key in ["id","inheritsFrom","mainClass","arguments","minecraftArguments","libraries","javaVersion","minimumLauncherVersion","type","time","releaseTime"]{if let Some(v)=profile.get(key){clean.insert(key.into(),v.clone());}}clean.insert("inheritsFrom".into(),json!(request.mc));Ok(Value::Object(clean))
}
#[derive(Clone)] struct NeoArguments { fml:String,neo_form:String }
fn neo_argument(profile:&Value,key:&str)->Result<String>{
    let game=profile["arguments"]["game"].as_array().ok_or("NeoForge profile 缺少游戏参数数组")?;
    if game.len()>8192||game.iter().any(|v|v.as_str().map_or(true,|s|s.len()>32768||s.chars().any(char::is_control))){return Err("NeoForge 绑定参数必须为有界纯字符串数组".into());}
    if game.iter().any(|v|v.as_str().is_some_and(|s|s.starts_with(&format!("{key}=")))){return Err(format!("NeoForge 绑定参数 {key} 不接受另一种赋值形式"));}
    let positions=game.iter().enumerate().filter(|(_,v)|v.as_str()==Some(key)).map(|(i,_)|i).collect::<Vec<_>>();
    if positions.len()!=1{return Err(format!("NeoForge 绑定参数 {key} 缺少或重复"));}
    let value=game.get(positions[0]+1).and_then(Value::as_str).filter(|s|!s.is_empty()&&!s.starts_with("--")).ok_or("NeoForge 绑定参数缺值")?;
    downloads::identifier(value)?;Ok(value.to_string())
}
// 官方 NeoForge 1.21.1 的 version.json 只有 runtime libraries，不包含项目自身坐标。
// 绑定必须联合 install_profile、纯字符串启动参数和处理器产物；Forge 原坐标验证保持独立。
fn validate_neo_profile(profile:&Value,request:&Request)->Result<NeoArguments>{
    if request.mc=="1.20.1"{return Err("不支持旧 net.neoforged:forge 安装协议".into());}
    if text(profile,"id")!=format!("neoforge-{}",request.version)||text(profile,"inheritsFrom")!=request.mc||text(profile,"mainClass")!="cpw.mods.bootstraplauncher.BootstrapLauncher"{return Err("NeoForge profile 身份、Minecraft 或启动类绑定不匹配".into());}
    if neo_argument(profile,"--fml.neoForgeVersion")?!=request.version||neo_argument(profile,"--fml.mcVersion")?!=request.mc||neo_argument(profile,"--launchTarget")?!="forgeclient"{return Err("NeoForge profile 启动参数绑定不匹配".into());}
    let result=NeoArguments{fml:neo_argument(profile,"--fml.fmlVersion")?,neo_form:neo_argument(profile,"--fml.neoFormVersion")?};
    for library in profile["libraries"].as_array().ok_or("NeoForge profile 缺少 libraries")?{
        let name=text(library,"name");let p=name.split('@').next().unwrap_or(name).split(':').collect::<Vec<_>>();
        if p.len()>=2&&((p[0]=="net.minecraftforge"&&p[1]=="forge")||(p[0]=="net.neoforged"&&matches!(p[1],"neoforge"|"forge")&&(p[1]!="neoforge"||p.get(2).copied()!=Some(request.version.as_str())))){return Err("NeoForge profile 含矛盾的项目库坐标".into());}
    }Ok(result)
}
#[derive(Clone)] struct NeoProduct { key:&'static str,coordinate:String,path:PathBuf,sha1:Option<String>,size:Option<u64> }
struct NeoMetadata { arguments:NeoArguments,products:Vec<NeoProduct> }
struct InstallerMetadata { expected_id:Option<String>,mc_bound:bool,mappings:Option<String>,neo:Option<NeoMetadata> }
fn neo_product_path(group:&str,artifact:&str,version:&str,classifier:&str)->Result<PathBuf>{
    for value in [artifact,version,classifier]{downloads::identifier(value)?;}let mut path=PathBuf::new();for p in group.split('.'){downloads::identifier(p)?;path.push(p);}path.push(artifact);path.push(version);path.push(format!("{artifact}-{version}-{classifier}.jar"));Ok(path)
}
fn neo_metadata(install:&Value,embedded:&Value,request:&Request)->Result<NeoMetadata>{
    if install["spec"].as_u64()!=Some(1)||text(install,"profile")!="NeoForge"||text(install,"minecraft")!=request.mc||text(install,"version")!=format!("neoforge-{}",request.version)||text(install,"json")!="/version.json"{return Err("NeoForge 安装器元数据绑定不匹配".into());}
    let arguments=validate_neo_profile(embedded,request)?;let mc_form=format!("{}-{}",request.mc,arguments.neo_form);if install["data"]["MOJMAPS"]["client"].as_str()!=Some(format!("[net.minecraft:client:{mc_form}:mappings@txt]").as_str()){return Err("NeoForge Mojang mappings 坐标绑定不匹配".into());}let mut products=Vec::new();
    for(key,group,artifact,version,classifier)in[("PATCHED","net.neoforged","neoforge",request.version.as_str(),"client"),("MC_SRG","net.minecraft","client",mc_form.as_str(),"srg"),("MC_EXTRA","net.minecraft","client",mc_form.as_str(),"extra")]{
        let coordinate=format!("{group}:{artifact}:{version}:{classifier}");if install["data"][key]["client"].as_str()!=Some(format!("[{coordinate}]").as_str()){return Err(format!("NeoForge {key}.client 产物绑定不匹配"));}
        products.push(NeoProduct{key,coordinate,path:neo_product_path(group,artifact,version,classifier)?,sha1:None,size:None});
    }
    let coordinate=format!("net.neoforged:neoforge:{}:universal",request.version);let libraries=install["libraries"].as_array().ok_or("NeoForge 安装器缺少库元数据")?;
    let universal=libraries.iter().filter(|v|text(v,"name")==coordinate).collect::<Vec<_>>();if universal.len()!=1{return Err("NeoForge universal 库绑定缺少或重复".into());}
    let path=neo_product_path("net.neoforged","neoforge",&request.version,"universal")?;let info=&universal[0]["downloads"]["artifact"];
    if text(info,"path")!=path.to_str().ok_or("NeoForge 产物路径不是 UTF-8")?.replace('\\',"/"){return Err("NeoForge universal 下载路径绑定不匹配".into());}
    let sha1=downloads::checksum(text(info,"sha1"),40)?;let size=info["size"].as_u64().filter(|n|*n>0&&*n<=512*1024*1024).ok_or("NeoForge universal 大小无效")?;
    products.push(NeoProduct{key:"UNIVERSAL",coordinate,path,sha1:Some(sha1),size:Some(size)});
    if let Some(processors)=install.get("processors"){let processors=processors.as_array().ok_or("安装器 processors 不是数组")?;if processors.len()>20000{return Err("安装器处理器过多".into());}for processor in processors{
        if let Some(sides)=processor.get("sides").filter(|v|!v.is_null()){let sides=sides.as_array().ok_or("处理器 sides 不是数组")?;if sides.iter().any(|v|v.as_str().is_none()){return Err("处理器 sides 含非字符串".into());}if !sides.iter().any(|v|v.as_str()==Some("client")){continue;}}
        if let Some(outputs)=processor.get("outputs"){let outputs=outputs.as_object().ok_or("处理器 outputs 不是对象")?;if outputs.len()>20000{return Err("处理器输出过多".into());}for(key,value)in outputs{for product in &mut products{let path=product.path.to_str().ok_or("产物路径不是 UTF-8")?.replace('\\',"/");if key==&format!("{{{}}}",product.key)||key==&format!("[{}]",product.coordinate)||key==&format!("{{ROOT}}/libraries/{path}")||key==&format!("{{LIBRARY_DIR}}/{path}"){let mut raw=value.as_str().ok_or("产物摘要不是字符串")?;let mut resolved=false;for _ in 0..8{raw=raw.strip_prefix('\'').and_then(|v|v.strip_suffix('\'')).unwrap_or(raw);if let Some(token)=raw.strip_prefix('{').and_then(|v|v.strip_suffix('}')){raw=install["data"][token]["client"].as_str().ok_or("产物摘要变量缺少客户端值")?;}else{resolved=true;break;}}if !resolved{return Err("产物摘要变量递归过深".into());}let hash=downloads::checksum(raw,40)?;if product.sha1.as_ref().is_some_and(|old|old!=&hash){return Err("处理器产物摘要相互矛盾".into());}product.sha1=Some(hash);}}}}
    }}Ok(NeoMetadata{arguments,products})
}
fn neo_product_digest(root:&Path,product:&NeoProduct,cancel:&Cancel)->Result<(String,u64)>{
    use sha1::{Digest,Sha1};cancel.check()?;let path=downloads::inside_path(root,Path::new("libraries").join(&product.path))?;
    let metadata=fs::symlink_metadata(&path).map_err(|_|format!("NeoForge {} 运行产物缺失",product.key))?;
    if !metadata.is_file()||metadata.file_type().is_symlink()||metadata.len()==0||metadata.len()>512*1024*1024||product.size.is_some_and(|expected|expected!=metadata.len()){return Err(format!("NeoForge {} 运行产物类型或大小错误",product.key));}
    let mut file=fs::File::open(&path).map_err(|_|"无法读取 NeoForge 运行产物")?;let mut hash=Sha1::new();let mut size=0u64;let mut buf=[0u8;65536];loop{cancel.check()?;let n=file.read(&mut buf).map_err(|_|"读取 NeoForge 运行产物失败")?;if n==0{break;}size+=n as u64;if size>512*1024*1024{return Err("NeoForge 运行产物过大".into());}hash.update(&buf[..n]);}
    let hash=format!("{:x}",hash.finalize());if size!=metadata.len()||product.sha1.as_ref().is_some_and(|expected|expected!=&hash){return Err(format!("NeoForge {} 运行产物摘要错误",product.key));}
    let file=fs::File::open(path).map_err(|_|"无法核验 NeoForge 运行 JAR")?;let mut jar=zip::ZipArchive::new(file).map_err(|_|format!("NeoForge {} 运行产物不是有效 JAR",product.key))?;
    if jar.len()==0||jar.len()>100000{return Err("NeoForge 运行 JAR 条目数量无效".into());}let mut expanded=0u64;
    for i in 0..jar.len(){cancel.check()?;let mut entry=jar.by_index(i).map_err(|_|"NeoForge 运行 JAR 条目错误")?;if entry.is_dir(){continue;}if entry.unix_mode().is_some_and(|m|!matches!(m&0o170000,0|0o100000))||entry.size()>256*1024*1024{return Err("NeoForge 运行 JAR 含特殊或过大条目".into());}expanded=expanded.checked_add(entry.size()).ok_or("NeoForge JAR 大小溢出")?;if expanded>1024*1024*1024{return Err("NeoForge 运行 JAR 解压大小过大".into());}let expected=entry.size();let mut observed=0u64;loop{cancel.check()?;let n=entry.read(&mut buf).map_err(|_|"NeoForge 运行 JAR 内容损坏")?;if n==0{break;}observed+=n as u64;if observed>expected{return Err("NeoForge 运行 JAR 条目大小错误".into());}}if observed!=expected{return Err("NeoForge 运行 JAR 条目截断".into());}}
    Ok((hash,size))
}
fn validate_neo_products(meta:&InstallerMetadata,staging:&Path,cancel:&Cancel)->Result<Vec<(NeoProduct,String,u64)>>{
    let Some(neo)=&meta.neo else{return Ok(Vec::new());};let mut validated=Vec::new();for product in &neo.products{let(hash,size)=neo_product_digest(staging,product,cancel)?;validated.push((product.clone(),hash,size));}Ok(validated)
}
fn promote_neo_products(validated:&[(NeoProduct,String,u64)],staging:&Path,root:&Path,cancel:&Cancel)->Result<()>{
    for(product,hash,size)in validated{cancel.check()?;let mut verified=product.clone();verified.sha1=Some(hash.clone());verified.size=Some(*size);neo_product_digest(staging,&verified,cancel)?;let relative=Path::new("libraries").join(&product.path);downloads::copy_checked(&downloads::inside_path(staging,&relative)?,&downloads::inside_path(root,&relative)?,cancel)?;neo_product_digest(root,&verified,cancel)?;}Ok(())
}
fn installer_metadata(jar:&Path,request:&Request)->Result<InstallerMetadata>{
    let install=jar_json(jar,"install_profile.json")?.ok_or("安装器缺少 install_profile.json")?;let declared=text(&install,"minecraft");let legacy_mc=text(&install["install"],"minecraft");let mc_bound=declared==request.mc||legacy_mc==request.mc;if !declared.is_empty()&&declared!=request.mc||!legacy_mc.is_empty()&&legacy_mc!=request.mc{return Err("安装器 Minecraft 版本与请求不匹配".into());}
    let embedded=jar_json(jar,"version.json")?.or_else(||install.get("versionInfo").filter(|v|v.is_object()).cloned());
    let neo=if request.kind=="neoforge"{Some(neo_metadata(&install,embedded.as_ref().ok_or("NeoForge 安装器缺少 version.json")?,request)?)}else{None};
    let expected_id=if let Some(profile)=embedded{let clean=checked_profile(profile,request,mc_bound)?;Some(text(&clean,"id").to_string())}else{None};if !mc_bound&&expected_id.is_none(){return Err("安装器没有可核验的 Minecraft/加载器绑定".into());}
    let mappings=install["data"]["MOJMAPS"]["client"].as_str().filter(|s|s.starts_with('[')&&s.ends_with(']')).map(|s|s[1..s.len()-1].to_string());Ok(InstallerMetadata{expected_id,mc_bound,mappings,neo})
}
#[derive(Clone)] struct Stamp {mtime:Option<SystemTime>,sha1:String}
fn version_stamps(staging:&Path,cancel:&Cancel)->Result<BTreeMap<String,Stamp>>{
    use sha1::{Digest,Sha1};let versions=downloads::inside_path(staging,"versions")?;let mut out=BTreeMap::new();if !versions.exists(){return Ok(out);}for e in fs::read_dir(versions).map_err(|_|"无法枚举安装器版本目录")?.take(20001){cancel.check()?;let e=e.map_err(|_|"读取安装器版本目录失败")?;if out.len()>20000{return Err("安装器生成版本过多".into());}let id=e.file_name().to_str().ok_or("安装器版本 ID 不是 UTF-8")?.to_string();downloads::identifier(&id)?;let path=downloads::version_path(staging,&id)?;if !path.is_file(){continue;}let bytes=downloads::read_bytes(&path)?;out.insert(id,Stamp{mtime:fs::metadata(path).ok().and_then(|m|m.modified().ok()),sha1:format!("{:x}",Sha1::digest(bytes))});}Ok(out)
}
fn generated_profile(staging:&Path,request:&Request,meta:&InstallerMetadata,before:&BTreeMap<String,Stamp>,cancel:&Cancel)->Result<Value>{
    let after=version_stamps(staging,cancel)?;let mut candidates=Vec::new();for(id,stamp)in after{if id==request.mc{continue;}let changed=before.get(&id).map_or(true,|old|old.sha1!=stamp.sha1||stamp.mtime>old.mtime);let expected=meta.expected_id.as_deref()==Some(id.as_str());let tail=request.version.rsplit('-').next().unwrap_or(&request.version);let named=id.to_ascii_lowercase().contains(&request.kind)&&(id.contains(&request.version)||id.contains(tail));if !changed&&!expected&&!named{continue;}let raw=downloads::read_json(&downloads::version_path(staging,&id)?)?;if text(&raw,"id")!=id{continue;}let clean=match checked_profile(raw,request,meta.mc_bound){Ok(v)=>v,Err(_)=>continue};if let Some(neo)=&meta.neo{let arguments=match validate_neo_profile(&clean,request){Ok(v)=>v,Err(_)=>continue};if arguments.fml!=neo.arguments.fml||arguments.neo_form!=neo.arguments.neo_form{continue;}}candidates.push((expected,changed,stamp.mtime,clean));}
    candidates.sort_by(|a,b|b.0.cmp(&a.0).then_with(||b.1.cmp(&a.1)).then_with(||b.2.cmp(&a.2)));if candidates.len()>1&&candidates[0].0==candidates[1].0&&candidates[0].1==candidates[1].1&&candidates[0].2==candidates[1].2{return Err("安装器生成多个同等优先级 profile，拒绝猜测".into());}candidates.into_iter().next().map(|v|v.3).ok_or("安装器未生成绑定正确的版本配置文件".into())
}
fn required_java(base:&Value,mc:&str)->Result<u64>{if let Some(v)=base.get("javaVersion"){return v["majorVersion"].as_u64().filter(|v|(8..=99).contains(v)).ok_or("Minecraft Java 版本元数据无效".into());}let p=mc.split('.').map(|s|s.parse::<u32>().unwrap_or(0)).collect::<Vec<_>>();Ok(if p.first().copied().unwrap_or(0)>1||p.first()==Some(&1)&&(p.get(1).copied().unwrap_or(0)>20||p.get(1)==Some(&20)&&p.get(2).copied().unwrap_or(0)>=5){21}else if p.first()==Some(&1)&&p.get(1).copied().unwrap_or(0)>=18{17}else if p.first()==Some(&1)&&p.get(1)==Some(&17){16}else{8})}
struct CancelOnDrop(Arc<Cancel>);impl Drop for CancelOnDrop{fn drop(&mut self){self.0.stop();}}
struct PreparedProfile { stage:Staging, base:Value, profile:Value, target:String }
// 两种入口共享安装器绑定、watchdog 和产物验证；pack 仅改变共享资源准备与最终发布位置。
async fn prepare_profile_under_guard(root:&Path,request:&Request,settings:&Value,cancel:Arc<Cancel>,progress:&Progress,log:Arc<dyn Fn(String)+Send+Sync>,pack:bool)->Result<PreparedProfile>{
    let target=request.target.as_deref();
    let base=downloads::resolve_version_under_guard(if request.in_place{target.unwrap_or(&request.mc)}else{&request.mc},root,settings,&cancel).await?;
    let client=if text(&base,"clientVersion").is_empty(){text(&base,"id")}else{text(&base,"clientVersion")};if client!=request.mc{return Err("目标实例 Minecraft 版本不匹配".into());}let main=text(&base,"mainClass");if !main.is_empty()&&!main.contains("net.minecraft.client.main.Main"){return Err("该实例已有加载器，拒绝重复安装".into());}
    let required=required_java(&base,&request.mc)?;let s=settings.clone();let java_id=target.unwrap_or(&request.mc).to_string();let java=tokio::task::spawn_blocking(move||runtime::pick_installer_java(&s,&java_id,required)).await.map_err(|_|"安装器 Java 检测任务异常")??;cancel.check()?;
    // 完整原版在真实根补齐一次，随后仅复制校验后的必要输入到本任务目录。
    let mut vanilla=downloads::resolve_version_under_guard(&request.mc,root,settings,&cancel).await?;if pack{vanilla["jar"]=json!(request.mc);vanilla["clientVersion"]=json!(request.mc);downloads::prepare_pack_base_under_guard(&vanilla,root,settings,cancel.clone(),progress).await?;}else{downloads::prepare_installer_base_under_guard(&vanilla,root,settings,cancel.clone(),progress).await?;}
    let(installer,digest)=downloads::forge_installer(&request.kind,&request.version,root,settings,&cancel,progress).await?;let stage=Staging::new(root,&cancel)?;let jar=downloads::inside_path(&stage.path,"installer.jar")?;downloads::copy_checked(&installer,&jar,&cancel)?;downloads::verify_installer(&jar,&digest,&cancel)?;let meta=installer_metadata(&jar,request)?;if !pack&&!request.in_place{if let Some(target)=request.target.as_deref().or(meta.expected_id.as_deref()){if downloads::version_path(root,target)?.parent().is_some_and(Path::exists){return Err("安装器目标实例已存在，拒绝运行或覆盖".into());}}}
    downloads::seed_installer_base(&vanilla,root,&stage.path,settings,&cancel)?;match downloads::prefetch_forge_mappings(&vanilla,meta.mappings.as_deref(),&stage.path,settings,&cancel,progress).await{Ok(true)=>log("Mojang mappings 已预置\n".into()),Ok(false)=>log("此安装器未声明可预置 mappings 路径；仍受静默看门狗约束\n".into()),Err(e)=>{cancel.check()?;log(format!("mappings 预置失败：{e}；安装器可能自行重试\n"));}}
    let before=version_stamps(&stage.path,&cancel)?;let worker_stage=stage.path.clone();let c=cancel.clone();let worker_log=log.clone();let result=tokio::task::spawn_blocking(move||runtime::run_installer(&java,&jar,&worker_stage,c,worker_log)).await.map_err(|_|"Forge 安装器工作任务异常")?;result?;cancel.check()?;
    let profile=generated_profile(&stage.path,request,&meta,&before,&cancel)?;let target=target.unwrap_or_else(||text(&profile,"id")).to_string();downloads::identifier(&target)?;if !pack&&!request.in_place&&downloads::version_path(root,&target)?.parent().is_some_and(Path::exists){return Err("安装器目标实例已存在，拒绝覆盖".into());}
    let staged=downloads::merge_version(&vanilla,&profile)?;let mut staged=staged;staged["jar"]=json!(request.mc);staged["clientVersion"]=json!(request.mc);
    // NeoForge 的 FML 会直接寻找 PATCHED/universal/MC_SRG/MC_EXTRA；它们不全在 version.json libraries。
    // 先验证固定四项完整闭包，再按原路径复制；不把处理器工具库或虚构 classpath 注入 profile。
    let neo_products=validate_neo_products(&meta,&stage.path,&cancel)?;
    downloads::complete_staged_libraries_under_guard(&staged,&stage.path,settings,cancel.clone(),progress).await?;
    downloads::promote_staged_libraries(&staged,&stage.path,root,settings,&cancel)?;promote_neo_products(&neo_products,&stage.path,root,&cancel)?;
    if pack{downloads::reject_profile_path(&profile,&stage.path)?;}Ok(PreparedProfile{stage,base,profile,target})
}
async fn install_under_guard(root:&Path,request:&Request,settings:&Value,cancel:Arc<Cancel>,progress:&Progress,log:Arc<dyn Fn(String)+Send+Sync>)->Result<String>{
    let target=request.target.as_deref();if let Some(target)=target{let path=downloads::version_path(root,target)?;if !request.in_place&&path.parent().is_some_and(Path::exists){return Err("目标实例目录已存在，拒绝覆盖".into());}}
    let original=if request.in_place{Some(downloads::read_bytes(&downloads::version_path(root,target.ok_or("缺少就地实例 ID")?)?)?)}else{None};
    let prepared=prepare_profile_under_guard(root,request,settings,cancel.clone(),progress,log.clone(),false).await?;
    let id=loaders::publish_profile_under_guard(root,&prepared.base,prepared.profile,&prepared.target,&request.mc,original.as_deref(),settings,cancel,progress).await?;
    if let Err(e)=prepared.stage.clean(){log(format!("已完成安装，受控 staging 清理未完成：{e}\n"));}Ok(id)
}
fn pack_profile(base:&Value,profile:&Value,target:&str,mc:&str,staging:&Path)->Result<Value>{let mut merged=downloads::merge_version(base,profile)?;merged["id"]=json!(target);merged["jar"]=json!(mc);merged["clientVersion"]=json!(mc);downloads::reject_profile_path(&merged,staging)?;Ok(merged)}
/// 调用方已持有唯一根锁。移动平台在任何下载、Stage 或进程动作前明确拒绝。
pub(crate) async fn build_profile_under_guard(kind:&str,mc:&str,loader:&str,target:&str,cache_root:&Path,settings:&Value,cancel:Arc<Cancel>,progress:&Progress,log:Arc<dyn Fn(String)+Send+Sync>)->Result<Value>{
    mobile_guard()?;local_guard(settings)?;let request=parse_request("forge:install",&[json!(kind),json!(mc),json!(loader),json!(target)])?;
    if target.is_empty()||target==mc{return Err("整包实例 ID 必须与基础 Minecraft ID 不同".into());}cancel.check()?;
    let prepared=prepare_profile_under_guard(cache_root,&request,settings,cancel.clone(),progress,log,true).await?;
    let merged=pack_profile(&prepared.base,&prepared.profile,target,mc,&prepared.stage.path)?;
    cancel.check()?;prepared.stage.clean().map_err(|e|format!("加载器已构建，但安装器 staging 清理未完成：{e}"))?;Ok(merged)
}
pub async fn call(app:&tauri::AppHandle,channel:&str,args:&[Value],settings:&Value,game_dir:&Path)->Result<Option<Value>>{
    let inplace=channel=="loaders:installInPlace"&&args.first().and_then(Value::as_str).is_some_and(|k|matches!(k,"forge"|"neoforge"));if !matches!(channel,"forge:versions"|"forge:install")&&!inplace{return Ok(None);}
    if channel=="forge:versions"{if args.len()!=2{return Err("forge:versions 参数数量不符".into());}let k=forge_kind(&string_arg(args,0,"加载器类型",true)?)?.to_string();let mc=string_arg(args,1,"Minecraft 版本",true)?;downloads::identifier(&mc)?;let root=downloads::operation_root(game_dir)?;let cancel=Cancel::default();let _guard=install_lock::acquire(&root,||cancel.check().is_err()).await?;return Ok(Some(json!(parse_versions(&downloads::forge_metadata(&k,&root,settings,&cancel).await?,&k,&mc)?)));}
    mobile_guard()?;local_guard(settings)?;let request=parse_request(channel,args)?;let root=downloads::operation_root(game_dir)?;let task=if request.in_place{format!("forge-inplace-{}",request.target.as_deref().unwrap_or(""))}else{request.target.clone().unwrap_or_else(||format!("{}-{}-{}",request.kind,request.mc,request.version))};if request.wait.as_deref()==Some(task.as_str()){return Err("安装目标不能与正在等待的原版任务标识相同".into());}let registration=JobGuard::register(&root,&task)?;let cancel=registration.cancel();let _on_drop=CancelOnDrop(cancel.clone());let event_app=app.clone();let log:Arc<dyn Fn(String)+Send+Sync>=Arc::new(move|line|{let _=event_app.emit_to("main","launcher:event",json!({"channel":"forge:log","payload":line}));});let event_app=app.clone();let progress=Progress::new(task,format!("安装 {} {}",request.kind,request.version),Arc::new(move|payload|{let _=event_app.emit_to("main","launcher:event",json!({"channel":"download:progress","payload":payload}));}));let settings=settings.clone();
    tokio::spawn(async move{let result=async{if let Some(wait)=&request.wait{if !downloads::wait_for_install(&root,wait,&cancel).await?{log("原版任务未在运行，将在取得根锁后重新验证并补齐原版\n".into());}}let _guard=install_lock::acquire(&root,||cancel.check().is_err()).await?;install_under_guard(&root,&request,&settings,cancel.clone(),&progress,log).await}.await;registration.complete(result.as_ref().map(|_|()).map_err(Clone::clone));progress.finish(result.is_ok());result.map(|id|Some(json!(id)))}).await.map_err(|_|"Forge 安装后台任务异常结束".to_string())?
}

#[cfg(test)] mod tests {
    use super::*;use std::io::Write;
    struct Temp(PathBuf);impl Temp{fn new()->Self{let p=std::env::temp_dir().join(format!("hcmcl-forge-test-{}",uuid::Uuid::new_v4()));fs::create_dir_all(&p).unwrap();Self(fs::canonicalize(p).unwrap())}}impl Drop for Temp{fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}
    fn request()->Request{Request{kind:"forge".into(),mc:"1.20.1".into(),version:"1.20.1-47.2.0".into(),target:None,wait:None,in_place:false}}
    fn profile()->Value{json!({"id":"1.20.1-forge-47.2.0","inheritsFrom":"1.20.1","mainClass":"cpw.mods.bootstraplauncher.BootstrapLauncher","libraries":[{"name":"net.minecraftforge:forge:1.20.1-47.2.0:universal"}],"arguments":{"game":["--launchTarget","forgeclient"]}})}
    #[tokio::test]
    async fn staged_forge_publication_preserves_instance_identity_and_backup() {
        use sha1::{Digest,Sha1};let t=Temp::new();let c=Cancel::default();let client=b"client";let library=b"forge-library";
        let base=json!({"id":"1.20.1","mainClass":"net.minecraft.client.main.Main","libraries":[],"arguments":{"jvm":["-cp","${classpath}"],"game":["--username","${auth_player_name}"]},"downloads":{"client":{"sha1":format!("{:x}",Sha1::digest(client)),"size":client.len()}}});
        downloads::write_bytes(&t.0.join("versions/1.20.1/1.20.1.jar"),client,&c).unwrap();downloads::write_json(&downloads::version_path(&t.0,"1.20.1").unwrap(),&base,&c).unwrap();
        let original=b"{\"id\":\"named\",\"inheritsFrom\":\"1.20.1\"}";let target=downloads::version_path(&t.0,"named").unwrap();downloads::write_bytes(&target,original,&c).unwrap();downloads::write_bytes(&t.0.join("versions/named/saves/world/level.dat"),b"world",&c).unwrap();
        let stage=Staging::new(&t.0,&c).unwrap();let mut p=profile();p["libraries"][0]["downloads"]=json!({"artifact":{"path":"net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-universal.jar","url":"","sha1":format!("{:x}",Sha1::digest(library)),"size":library.len()}});
        let relative="libraries/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-universal.jar";downloads::seed_installer_base(&base,&t.0,&stage.path,&json!({"mode":"local"}),&c).unwrap();downloads::write_bytes(&stage.path.join(relative),library,&c).unwrap();let mut staged=downloads::merge_version(&base,&p).unwrap();staged["jar"]=json!("1.20.1");downloads::promote_staged_libraries(&staged,&stage.path,&t.0,&json!({"mode":"local"}),&c).unwrap();
        let resolved=downloads::resolve_version_under_guard("named",&t.0,&json!({"mode":"local"}),&c).await.unwrap();let progress=Progress::new("fixture".into(),"fixture".into(),Arc::new(|_|{}));
        assert_eq!(loaders::publish_profile_under_guard(&t.0,&resolved,p,"named","1.20.1",Some(original),&json!({"mode":"local"}),Arc::new(Cancel::default()),&progress).await.unwrap(),"named");
        let saved=downloads::read_json(&target).unwrap();assert_eq!(saved["id"],"named");assert_eq!(saved["clientVersion"],"1.20.1");assert_eq!(saved["jar"],"1.20.1");assert!(saved.get("inheritsFrom").is_none());assert_eq!(saved["arguments"]["jvm"].as_array().unwrap().len(),2);assert_eq!(fs::read(t.0.join("versions/named/named.json.vanilla.bak")).unwrap(),original);assert_eq!(fs::read(t.0.join("versions/named/saves/world/level.dat")).unwrap(),b"world");
    }
    #[tokio::test]
    async fn failed_forge_publication_preserves_old_json_world_and_natives() {
        use sha1::{Digest,Sha1};let t=Temp::new();let c=Cancel::default();let client=b"client";let base=json!({"id":"1.20.1","mainClass":"net.minecraft.client.main.Main","libraries":[],"downloads":{"client":{"sha1":format!("{:x}",Sha1::digest(client)),"size":client.len()}}});
        downloads::write_bytes(&t.0.join("versions/1.20.1/1.20.1.jar"),client,&c).unwrap();let original=b"{\"id\":\"named\",\"inheritsFrom\":\"1.20.1\"}";let target=downloads::version_path(&t.0,"named").unwrap();downloads::write_bytes(&target,original,&c).unwrap();downloads::write_bytes(&t.0.join("versions/named/natives/old.bin"),b"old-native",&c).unwrap();downloads::write_bytes(&t.0.join("versions/named/saves/world/level.dat"),b"world",&c).unwrap();
        let progress=Progress::new("failed-fixture".into(),"fixture".into(),Arc::new(|_|{}));let mut p=profile();p["libraries"][0]["downloads"]=json!({"artifact":{"path":"net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-universal.jar","url":"","sha1":format!("{:x}",Sha1::digest(b"missing"))}});
        assert!(loaders::publish_profile_under_guard(&t.0,&base,p,"named","1.20.1",Some(original),&json!({"mode":"local"}),Arc::new(Cancel::default()),&progress).await.is_err());
        assert_eq!(fs::read(&target).unwrap(),original);assert_eq!(fs::read(t.0.join("versions/named/natives/old.bin")).unwrap(),b"old-native");assert_eq!(fs::read(t.0.join("versions/named/saves/world/level.dat")).unwrap(),b"world");assert!(!t.0.join("versions/named/named.json.vanilla.bak").exists());
        let stopped=Arc::new(Cancel::default());stopped.stop();assert!(loaders::publish_profile_under_guard(&t.0,&base,profile(),"named","1.20.1",Some(original),&json!({"mode":"local"}),stopped,&progress).await.is_err());assert_eq!(fs::read(&target).unwrap(),original);assert_eq!(fs::read(t.0.join("versions/named/natives/old.bin")).unwrap(),b"old-native");
    }
    fn neo_request()->Request{Request{kind:"neoforge".into(),mc:"1.21.1".into(),version:"21.1.190".into(),target:None,wait:None,in_place:false}}
    // 按固定官方 CreateLauncherProfile/InstallerProfile 的字段形状构造，不伪装为发布 JAR 样本。
    fn neo_profile()->Value{json!({"id":"neoforge-21.1.190","inheritsFrom":"1.21.1","mainClass":"cpw.mods.bootstraplauncher.BootstrapLauncher","libraries":[{"name":"cpw.mods:bootstraplauncher:2.0.2"}],"arguments":{"game":["--fml.neoForgeVersion","21.1.190","--fml.fmlVersion","4.0.45","--fml.mcVersion","1.21.1","--fml.neoFormVersion","20240808.144430","--launchTarget","forgeclient"]}})}
    fn jar_bytes()->Vec<u8>{let mut z=zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));z.start_file("fixture.bin",zip::write::FileOptions::default()).unwrap();z.write_all(b"fixture-class-data").unwrap();z.finish().unwrap().into_inner()}
    fn neo_install(universal:&[u8])->Value{use sha1::{Digest,Sha1};json!({"spec":1,"profile":"NeoForge","version":"neoforge-21.1.190","minecraft":"1.21.1","json":"/version.json","data":{"PATCHED":{"client":"[net.neoforged:neoforge:21.1.190:client]"},"MC_SRG":{"client":"[net.minecraft:client:1.21.1-20240808.144430:srg]"},"MC_EXTRA":{"client":"[net.minecraft:client:1.21.1-20240808.144430:extra]"},"MOJMAPS":{"client":"[net.minecraft:client:1.21.1-20240808.144430:mappings@txt]"}},"libraries":[{"name":"net.neoforged:neoforge:21.1.190:universal","downloads":{"artifact":{"path":"net/neoforged/neoforge/21.1.190/neoforge-21.1.190-universal.jar","url":"https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.190/neoforge-21.1.190-universal.jar","sha1":format!("{:x}",Sha1::digest(universal)),"size":universal.len()}}}],"processors":[{"sides":["client"],"jar":"fixture:processor:1","classpath":[],"args":["--output","{PATCHED}"]}]})}
    fn metadata_jar(path:&Path,install:&Value,embedded:&Value){let mut z=zip::ZipWriter::new(fs::File::create(path).unwrap());for(name,value)in[("install_profile.json",install),("version.json",embedded)]{z.start_file(name,zip::write::FileOptions::default()).unwrap();z.write_all(&serde_json::to_vec(value).unwrap()).unwrap();}z.finish().unwrap();}
    #[test]
    fn neo_profile_binding_and_unrelated_generated_profile_are_rejected() {
        let r=neo_request();let p=neo_profile();assert!(checked_profile(p.clone(),&r,true).is_ok());assert!(!p["libraries"].as_array().unwrap().iter().any(|v|text(v,"name").starts_with("net.neoforged:neoforge:")));
        for(key,value)in[("--fml.neoForgeVersion","21.1.191"),("--fml.mcVersion","1.21"),("--launchTarget","forgeserver")]{let mut wrong=p.clone();let a=wrong["arguments"]["game"].as_array_mut().unwrap();let i=a.iter().position(|v|v.as_str()==Some(key)).unwrap();a[i+1]=json!(value);assert!(checked_profile(wrong,&r,true).is_err());}
        for bad in [json!(["--fml.neoForgeVersion","21.1.190"]),json!(["--fml.neoForgeVersion=21.1.190"]),json!([{"rules":[],"value":"--fml.mcVersion"}])]{let mut wrong=p.clone();wrong["arguments"]["game"].as_array_mut().unwrap().extend(bad.as_array().unwrap().iter().cloned());assert!(checked_profile(wrong,&r,true).is_err());}
        let mut wrong=p.clone();wrong["libraries"].as_array_mut().unwrap().push(json!({"name":"net.neoforged:neoforge:21.1.191:client"}));assert!(checked_profile(wrong,&r,true).is_err());
        let mut wrong=p.clone();wrong["id"]=json!("some-neoforge-21.1.190");assert!(checked_profile(wrong,&r,true).is_err());
        assert!(parse_request("forge:install",&[json!("neoforge"),json!("1.20.1"),json!("1.20.1-47.1.0")]).is_err());
        let t=Temp::new();let c=Cancel::default();downloads::write_json(&downloads::version_path(&t.0,"unrelated").unwrap(),&json!({"id":"unrelated","inheritsFrom":"1.20.1","mainClass":"other.Main","libraries":[]}),&c).unwrap();let meta=InstallerMetadata{expected_id:None,mc_bound:true,mappings:None,neo:None};assert!(generated_profile(&t.0,&request(),&meta,&BTreeMap::new(),&c).is_err());
        assert!(local_guard(&json!({"mode":"local"})).is_err());#[cfg(any(target_os="android",target_os="ios"))]assert!(mobile_guard().is_err());
    }
    #[test]
    fn official_shaped_neo_installer_and_generated_profile_bind_all_layers(){
        let t=Temp::new();let c=Cancel::default();let r=neo_request();let p=neo_profile();let install=neo_install(&jar_bytes());let jar=t.0.join("installer.jar");metadata_jar(&jar,&install,&p);let meta=installer_metadata(&jar,&r).unwrap();assert_eq!(meta.expected_id.as_deref(),Some("neoforge-21.1.190"));assert_eq!(meta.neo.as_ref().unwrap().products.len(),4);
        let target=downloads::version_path(&t.0,"neoforge-21.1.190").unwrap();downloads::write_json(&target,&p,&c).unwrap();assert_eq!(generated_profile(&t.0,&r,&meta,&BTreeMap::new(),&c).unwrap()["libraries"],p["libraries"]);
        for i in [3usize,7usize]{let mut wrong=p.clone();wrong["arguments"]["game"][i]=json!("other-version");downloads::write_json(&target,&wrong,&c).unwrap();assert!(generated_profile(&t.0,&r,&meta,&BTreeMap::new(),&c).is_err());}
        for(key,value)in[("minecraft",json!("1.21")),("version",json!("neoforge-21.1.191")),("json",json!("/other.json"))]{let mut wrong=install.clone();wrong[key]=value;metadata_jar(&jar,&wrong,&p);assert!(installer_metadata(&jar,&r).is_err());}
        for key in ["PATCHED","MC_SRG","MC_EXTRA","MOJMAPS"]{let mut wrong=install.clone();wrong["data"][key]["client"]=json!("[net.neoforged:neoforge:wrong:client]");metadata_jar(&jar,&wrong,&p);assert!(installer_metadata(&jar,&r).is_err());}
        let mut wrong=install.clone();wrong["libraries"][0]["downloads"]["artifact"]["path"]=json!("../wrong.jar");metadata_jar(&jar,&wrong,&p);assert!(installer_metadata(&jar,&r).is_err());
    }
    #[test]
    fn neo_runtime_products_validate_before_precise_promotion(){
        use sha1::{Digest,Sha1};let t=Temp::new();let stage=t.0.join("stage");let root=t.0.join("game");fs::create_dir_all(&stage).unwrap();fs::create_dir_all(&root).unwrap();let c=Cancel::default();let bytes=jar_bytes();let mut install=neo_install(&bytes);install["data"]["PATCHED_HASH"]=json!({"client":format!("'{:x}'",Sha1::digest(&bytes))});install["processors"][0]["outputs"]=json!({"{PATCHED}":"{PATCHED_HASH}"});
        let meta=InstallerMetadata{expected_id:Some("neoforge-21.1.190".into()),mc_bound:true,mappings:None,neo:Some(neo_metadata(&install,&neo_profile(),&neo_request()).unwrap())};
        for product in &meta.neo.as_ref().unwrap().products{downloads::write_bytes(&stage.join("libraries").join(&product.path),&bytes,&c).unwrap();}
        downloads::write_bytes(&stage.join("libraries/processor/unbound.jar"),b"unbound-processor",&c).unwrap();let verified=validate_neo_products(&meta,&stage,&c).unwrap();promote_neo_products(&verified,&stage,&root,&c).unwrap();assert_eq!(verified.len(),4);for product in &meta.neo.as_ref().unwrap().products{assert_eq!(fs::read(root.join("libraries").join(&product.path)).unwrap(),bytes);}assert!(!root.join("libraries/processor/unbound.jar").exists());
        let patched=&meta.neo.as_ref().unwrap().products[0];downloads::write_bytes(&stage.join("libraries").join(&patched.path),b"broken-jar",&c).unwrap();assert!(validate_neo_products(&meta,&stage,&c).is_err());downloads::write_bytes(&stage.join("libraries").join(&patched.path),&bytes,&c).unwrap();
        let universal=&meta.neo.as_ref().unwrap().products[3];let universal_path=stage.join("libraries").join(&universal.path);let mut wrong_digest=bytes.clone();let end=wrong_digest.len()-1;wrong_digest[end]^=1;downloads::write_bytes(&universal_path,&wrong_digest,&c).unwrap();assert!(validate_neo_products(&meta,&stage,&c).is_err());downloads::write_bytes(&universal_path,&bytes,&c).unwrap();
        let extra=&meta.neo.as_ref().unwrap().products[2];let extra_path=stage.join("libraries").join(&extra.path);downloads::write_bytes(&extra_path,b"not-a-zip-without-published-digest",&c).unwrap();assert!(validate_neo_products(&meta,&stage,&c).is_err());fs::remove_file(&extra_path).unwrap();assert!(validate_neo_products(&meta,&stage,&c).is_err());downloads::write_bytes(&extra_path,&bytes,&c).unwrap();
        let stopped=Cancel::default();stopped.stop();assert!(validate_neo_products(&meta,&stage,&stopped).is_err());assert!(promote_neo_products(&verified,&stage,&root,&stopped).is_err());assert_eq!(fs::read(root.join("libraries").join(&patched.path)).unwrap(),bytes);
        let mut wrong=install.clone();wrong["processors"][0]["outputs"]["{PATCHED}"]=json!("invalid-sha1");assert!(neo_metadata(&wrong,&neo_profile(),&neo_request()).is_err());
    }
    #[tokio::test]
    async fn official_shaped_neo_publication_keeps_identity_without_inventing_project_library(){
        use sha1::{Digest,Sha1};let t=Temp::new();let c=Cancel::default();let bytes=jar_bytes();let client=b"cached-vanilla-client";
        let base=json!({"id":"1.21.1","mainClass":"net.minecraft.client.main.Main","libraries":[],"arguments":{"jvm":["-cp","${classpath}"],"game":["--username","${auth_player_name}"]},"downloads":{"client":{"sha1":format!("{:x}",Sha1::digest(client)),"size":client.len()}}});
        downloads::write_bytes(&t.0.join("versions/1.21.1/1.21.1.jar"),client,&c).unwrap();downloads::write_json(&downloads::version_path(&t.0,"1.21.1").unwrap(),&base,&c).unwrap();let original=b"{\"id\":\"named\",\"inheritsFrom\":\"1.21.1\"}";let target=downloads::version_path(&t.0,"named").unwrap();downloads::write_bytes(&target,original,&c).unwrap();downloads::write_bytes(&t.0.join("versions/named/saves/world/level.dat"),b"world",&c).unwrap();
        let mut p=neo_profile();p["libraries"][0]["downloads"]=json!({"artifact":{"path":"cpw/mods/bootstraplauncher/2.0.2/bootstraplauncher-2.0.2.jar","url":"","sha1":format!("{:x}",Sha1::digest(&bytes)),"size":bytes.len()}});downloads::write_bytes(&t.0.join("libraries/cpw/mods/bootstraplauncher/2.0.2/bootstraplauncher-2.0.2.jar"),&bytes,&c).unwrap();
        let stage=Staging::new(&t.0,&c).unwrap();let meta=InstallerMetadata{expected_id:Some("neoforge-21.1.190".into()),mc_bound:true,mappings:None,neo:Some(neo_metadata(&neo_install(&bytes),&p,&neo_request()).unwrap())};for product in &meta.neo.as_ref().unwrap().products{downloads::write_bytes(&stage.path.join("libraries").join(&product.path),&bytes,&c).unwrap();}let products=validate_neo_products(&meta,&stage.path,&c).unwrap();promote_neo_products(&products,&stage.path,&t.0,&c).unwrap();
        let resolved=downloads::resolve_version_under_guard("named",&t.0,&json!({"mode":"local"}),&c).await.unwrap();let progress=Progress::new("neo-publication".into(),"fixture".into(),Arc::new(|_|{}));assert_eq!(loaders::publish_profile_under_guard(&t.0,&resolved,p,"named","1.21.1",Some(original),&json!({"mode":"local"}),Arc::new(Cancel::default()),&progress).await.unwrap(),"named");let saved=downloads::read_json(&target).unwrap();assert_eq!(saved["id"],"named");assert_eq!(saved["clientVersion"],"1.21.1");assert_eq!(saved["jar"],"1.21.1");assert!(!saved["libraries"].as_array().unwrap().iter().any(|v|text(v,"name").starts_with("net.neoforged:neoforge:")));assert_eq!(fs::read(t.0.join("versions/named/named.json.vanilla.bak")).unwrap(),original);assert_eq!(fs::read(t.0.join("versions/named/saves/world/level.dat")).unwrap(),b"world");
    }
    #[test]
    fn pack_forge_profile_binds_base_jar_without_publishing_or_staging_arguments(){
        for neo in [false,true]{let t=Temp::new();let c=Cancel::default();let stage=Staging::new(&t.0,&c).unwrap();let request=if neo{neo_request()}else{request()};let profile=if neo{neo_profile()}else{profile()};let profile=checked_profile(profile,&request,true).unwrap();let base=json!({"id":request.mc,"mainClass":"net.minecraft.client.main.Main","libraries":[],"downloads":{"client":{"sha1":"0123456789012345678901234567890123456789","size":1}},"arguments":{"jvm":["-cp","${classpath}"],"game":["--username","${auth_player_name}"]}});
            let result=pack_profile(&base,&profile,"pack",&request.mc,&stage.path).unwrap();assert_eq!(result["id"],"pack");assert_eq!(result["jar"],request.mc);assert_eq!(result["clientVersion"],request.mc);assert!(result.get("inheritsFrom").is_none());assert!(!t.0.join("versions/pack").exists());assert_eq!(result["downloads"],base["downloads"]);
            let mut unsafe_profile=profile;unsafe_profile["arguments"]["jvm"]=json!([format!("-Dnative={}",stage.path.display())]);assert!(pack_profile(&base,&unsafe_profile,"pack",&request.mc,&stage.path).is_err());stage.clean().unwrap();
        }
    }
    #[tokio::test]
    async fn pack_forge_rejects_mobile_local_invalid_and_cancelled_before_side_effects(){
        let t=Temp::new();let p=Progress::new("fixture".into(),"fixture".into(),Arc::new(|_|{}));let log:Arc<dyn Fn(String)+Send+Sync>=Arc::new(|_|{});
        assert!(build_profile_under_guard("forge","1.20.1","1.20.1-47.2.0","pack",&t.0,&json!({"mode":"local"}),Arc::new(Cancel::default()),&p,log.clone()).await.is_err());
        assert!(build_profile_under_guard("forge","1.20.1","1.19.4-45.0.0","pack",&t.0,&json!({}),Arc::new(Cancel::default()),&p,log.clone()).await.is_err());let stopped=Arc::new(Cancel::default());stopped.stop();assert!(build_profile_under_guard("forge","1.20.1","1.20.1-47.2.0","pack",&t.0,&json!({}),stopped,&p,log.clone()).await.is_err());
        #[cfg(any(target_os="android",target_os="ios"))]assert!(build_profile_under_guard("neoforge","1.21.1","21.1.190","pack",&t.0,&json!({}),Arc::new(Cancel::default()),&p,log).await.unwrap_err().contains("Android/iOS"));
        assert_eq!(fs::read_dir(&t.0).unwrap().count(),0);
    }
    #[test]fn protocol_sorting_and_version_binding(){let xml="<metadata><version>1.20.1-47.2.9</version><version>1.20.1-47.2.10</version><version>1.20.1-47.3.0-beta</version><version>1.19.4-45.0.0</version></metadata>";assert_eq!(parse_versions(xml,"forge","1.20.1").unwrap(),vec!["1.20.1-47.2.10","1.20.1-47.2.9","1.20.1-47.3.0-beta"]);assert!(parse_versions("<!DOCTYPE bad>","forge","1.20.1").is_err());assert!(parse_request("forge:install",&[json!("forge"),json!("1.20.1"),json!("1.20.1-47.2.0"),Value::Null,json!("1.19.4")]).is_err());assert!(matches_mc("21.1.190","1.21.1","neoforge"));assert_eq!(required_java(&json!({}),"1.17.1").unwrap(),16);assert_eq!(required_java(&json!({}),"1.20.5").unwrap(),21);}
    #[test]fn forged_profiles_reject_wrong_mc_coordinate_and_main(){assert!(checked_profile(profile(),&request(),true).is_ok());let mut p=profile();p["inheritsFrom"]=json!("1.19.4");assert!(checked_profile(p,&request(),true).is_err());let mut p=profile();p["libraries"]=json!([{"name":"net.minecraftforge:forge:1.20.1-47.2.1"}]);assert!(checked_profile(p,&request(),true).is_err());let mut p=profile();p["mainClass"]=json!("evil.Main");assert!(checked_profile(p,&request(),true).is_err());}
    #[test]fn owned_staging_cleans_only_its_tree_and_rejects_changed_owner(){let t=Temp::new();let c=Cancel::default();let stage=Staging::new(&t.0,&c).unwrap();let p=stage.path.clone();fs::write(p.join("data"),b"stage").unwrap();drop(stage);assert!(!p.exists());let stage=Staging::new(&t.0,&c).unwrap();let p=stage.path.clone();fs::write(p.join(".hcmcl-forge-owner"),b"other").unwrap();drop(stage);assert!(p.exists());}
    #[test]fn installer_metadata_and_generated_stamps_are_bound(){let t=Temp::new();let c=Cancel::default();let jar=t.0.join("installer.jar");let mut z=zip::ZipWriter::new(fs::File::create(&jar).unwrap());z.start_file("install_profile.json",zip::write::FileOptions::default()).unwrap();z.write_all(br#"{"minecraft":"1.20.1","data":{"MOJMAPS":{"client":"[net.minecraft:client:1.20.1:mappings@txt]"}}}"#).unwrap();z.start_file("version.json",zip::write::FileOptions::default()).unwrap();z.write_all(&serde_json::to_vec(&profile()).unwrap()).unwrap();z.finish().unwrap();let meta=installer_metadata(&jar,&request()).unwrap();assert_eq!(meta.mappings.as_deref(),Some("net.minecraft:client:1.20.1:mappings@txt"));let before=version_stamps(&t.0,&c).unwrap();downloads::write_json(&downloads::version_path(&t.0,"1.20.1-forge-47.2.0").unwrap(),&profile(),&c).unwrap();assert_eq!(generated_profile(&t.0,&request(),&meta,&before,&c).unwrap()["id"],"1.20.1-forge-47.2.0");}
}

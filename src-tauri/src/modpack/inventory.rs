//! 完整的导出选择清单。只查看元数据，不打开账号、设置或内容文件进行读取。
use super::{access::{leaf, Directory, Node}, Result};
use serde_json::{json, Value};
use std::{collections::BTreeSet, path::Path};

const ENTRIES_CAP:usize=100_000;
const DEPTH_CAP:usize=64;
struct Budget { remaining:usize }
impl Budget {fn new()->Self{Self{remaining:ENTRIES_CAP}}}

fn required_directory(parent:&Directory,name:&str)->Result<Directory> {
    let node=parent.child(name)?.ok_or("实例目录不存在")?;
    parent.directory(node)
}
fn optional_directory(parent:&Directory,name:&str)->Result<Option<Directory>> {
    match parent.child(name)? {Some(node)=>parent.directory(node).map(Some),None=>Ok(None)}
}
fn entries(directory:&Directory,budget:&mut Budget)->Result<Vec<String>> {
    // 只暂存有界名称；逐个打开条目，避免大目录同时耗尽系统文件句柄。
    directory.names(&mut budget.remaining)
}
fn entry(directory:&Directory,name:&str)->Result<Node> {
    directory.child(name)?.ok_or_else(|| "实例内容在扫描期间已移除".into())
}
fn inspect_tree(directory:&Directory,budget:&mut Budget,depth:usize)->Result<()> {
    if depth>DEPTH_CAP {return Err("实例导出内容层级过深".into());}
    for name in entries(directory,budget)? {
        let node=entry(directory,&name)?;
        if node.meta.is_dir(){inspect_tree(&directory.directory(node)?,budget,depth+1)?;}
    }
    directory.verify()
}
fn has_file(directory:&Directory,name:&str)->Result<bool> {
    match directory.child(name)? {None=>Ok(false),Some(node) if node.meta.is_file()=>Ok(true),Some(_)=>Err("导出文件位置不是普通文件".into())}
}
fn has_directory(directory:&Directory,name:&str,budget:&mut Budget)->Result<bool> {
    match optional_directory(directory,name)? {None=>Ok(false),Some(dir)=>{inspect_tree(&dir,budget,0)?;Ok(true)}}
}
fn extension(name:&str,extensions:&[&str])->bool {
    name.rsplit_once('.').map(|(_,ext)|extensions.iter().any(|allowed|ext.eq_ignore_ascii_case(allowed))).unwrap_or(false)
}
fn resource_packs(run:&Directory,budget:&mut Budget)->Result<Vec<Value>> {
    let Some(dir)=optional_directory(run,"resourcepacks")? else{return Ok(Vec::new());};
    let mut rows=Vec::new();
    for name in entries(&dir,budget)? {
        let node=entry(&dir,&name)?;
        if node.meta.is_dir(){inspect_tree(&dir.directory(node)?,budget,0)?;rows.push(json!({"name":name,"size":0}));}
        else if extension(&name,&["zip","jar","mcpack","mctemplate"]){rows.push(json!({"name":name,"size":node.meta.len()}));}
    }
    dir.verify()?;Ok(rows)
}
fn file_list(run:&Directory,kind:&str,extensions:&[&str],disabled:bool,budget:&mut Budget)->Result<Vec<Value>> {
    let Some(dir)=optional_directory(run,kind)? else{return Ok(Vec::new());};
    let mut rows=Vec::new();let mut output_names=BTreeSet::new();
    for name in entries(&dir,budget)? {
        let node=entry(&dir,&name)?;
        if !node.meta.is_file(){continue;}
        let selected=if disabled {name.ends_with(".disabled")}else{extension(&name,extensions)};
        if selected {
            let shown=if disabled {name.strip_suffix(".disabled").unwrap_or(&name)}else{&name};
            leaf(shown)?;
            if !output_names.insert(shown.to_lowercase()){return Err("导出清单存在重复内容名称".into());}
            rows.push(json!({"name":shown,"size":node.meta.len()}));
        }
    }
    dir.verify()?;Ok(rows)
}
fn worlds(run:&Directory,budget:&mut Budget)->Result<Vec<Value>> {
    let Some(dir)=optional_directory(run,"saves")? else{return Ok(Vec::new());};
    let mut rows=Vec::new();
    for name in entries(&dir,budget)? {
        let node=entry(&dir,&name)?;
        if !node.meta.is_dir(){continue;}
        let world=dir.directory(node)?;
        if has_file(&world,"level.dat")? {inspect_tree(&world,budget,0)?;rows.push(json!({"name":name,"size":0}));}
    }
    dir.verify()?;Ok(rows)
}

pub(super) fn collect(game_dir:&Path,id:&str,settings:&Value)->Result<Value> {
    leaf(id)?;
    let root=Directory::open(game_dir)?;
    let versions=required_directory(&root,"versions")?;
    let version=required_directory(&versions,id)?;
    let isolation=super::isolation::read(game_dir,id,settings)?;
    let run=if isolation.isolated {&version}else{&root};
    let mut budget=Budget::new();
    let has_game_settings=has_file(run,"options.txt")?;
    let has_mod_configs=has_directory(run,"config",&mut budget)?;
    let has_servers_list=has_file(run,"servers.dat")?;
    let worlds=worlds(run,&mut budget)?;
    let resource_packs=resource_packs(run,&mut budget)?;
    let has_jei=has_directory(run,"jei",&mut budget)?;
    let gun_packs=file_list(run,"tacz",&["zip"],false,&mut budget)?;
    let disabled_mods=file_list(run,"mods",&[],true,&mut budget)?;
    let schematics=file_list(run,"schematics",&["litematic","schem","schematic"],false,&mut budget)?;
    // 此接口不读取 shaderpacks：原清单无该字段，实际导出会始终包含该目录。
    root.verify()?;version.verify()?;isolation.verify()?;
    Ok(json!({"hasGameSettings":has_game_settings,"hasModConfigs":has_mod_configs,"hasServersList":has_servers_list,
        "worlds":worlds,"resourcePacks":resource_packs,"hasJei":has_jei,"gunPacks":gun_packs,"disabledMods":disabled_mods,"schematics":schematics}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};
    struct Fixture(PathBuf);
    impl Fixture {
        fn new()->Self {let p=std::env::temp_dir().join(format!("hcmcl-pack-inventory-{}",uuid::Uuid::new_v4()));fs::create_dir(&p).unwrap();Self(fs::canonicalize(p).unwrap())}
        fn file(&self,path:&str,bytes:&[u8]){let target=self.0.join(path);fs::create_dir_all(target.parent().unwrap()).unwrap();fs::write(target,bytes).unwrap();}
        fn dir(&self,path:&str){fs::create_dir_all(self.0.join(path)).unwrap();}
    }
    impl Drop for Fixture {fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}
    fn settings(isolated:bool)->Value {json!({"versionIsolation":isolated,"isolatedVersions":[]})}
    #[test] fn complete_inventory_preserves_all_original_fields_without_writes(){
        let f=Fixture::new();f.dir("versions/demo");
        for (name,data) in [("options.txt",b"options".as_slice()),("servers.dat",b"servers".as_slice()),("saves/World/level.dat",b"world".as_slice()),("saves/not-a-world/note.txt",b"note".as_slice()),("resourcepacks/A.ZIP",b"zip".as_slice()),("resourcepacks/B.jar",b"jar".as_slice()),("resourcepacks/C.mcpack",b"mcpack".as_slice()),("resourcepacks/D.mctemplate",b"template".as_slice()),("resourcepacks/ignored.txt",b"ignored".as_slice()),("resourcepacks/Folder/pack.mcmeta",b"{}".as_slice()),("config/sub/mod.toml",b"config".as_slice()),("jei/bookmarks.ini",b"jei".as_slice()),("tacz/Guns.ZIP",b"guns".as_slice()),("tacz/no.jar",b"skip".as_slice()),("mods/a.jar.disabled",b"mod".as_slice()),("mods/active.jar",b"active".as_slice()),("schematics/a.litematic",b"one".as_slice()),("schematics/b.schem",b"two".as_slice()),("schematics/c.SCHEMATIC",b"three".as_slice()),("schematics/no.txt",b"skip".as_slice())]{f.file(name,data);}
        // 根部私密文件不会被打开读取，也不出现在 DTO 中。
        f.file("accounts.dat",b"private fixture");
        let before=fs::read_dir(&f.0).unwrap().count();let dto=collect(&f.0,"demo",&settings(false)).unwrap();
        assert_eq!(dto.as_object().unwrap().len(),9);assert_eq!(dto["hasGameSettings"],true);assert_eq!(dto["hasModConfigs"],true);assert_eq!(dto["hasServersList"],true);assert_eq!(dto["hasJei"],true);
        assert_eq!(dto["worlds"],json!([{"name":"World","size":0}]));assert_eq!(dto["resourcePacks"].as_array().unwrap().len(),5);
        assert_eq!(dto["resourcePacks"][4],json!({"name":"Folder","size":0}));assert_eq!(dto["gunPacks"],json!([{"name":"Guns.ZIP","size":4}]));
        assert_eq!(dto["disabledMods"],json!([{"name":"a.jar","size":3}]));assert_eq!(dto["schematics"].as_array().unwrap().len(),3);
        assert_eq!(fs::read_dir(&f.0).unwrap().count(),before);assert!(!f.0.join(".hcmcl-install.lock").exists());assert!(!dto.to_string().contains("private fixture"));
    }
    #[test] fn isolation_flags_select_existing_instance_and_missing_root_never_created(){
        let f=Fixture::new();f.dir("versions/demo");f.file("options.txt",b"root");f.file("versions/demo/servers.dat",b"instance");
        let shared=collect(&f.0,"demo",&settings(false)).unwrap();assert_eq!(shared["hasGameSettings"],true);assert_eq!(shared["hasServersList"],false);
        for s in [settings(true),json!({"versionIsolation":false,"isolatedVersions":["demo"]})] {let isolated=collect(&f.0,"demo",&s).unwrap();assert_eq!(isolated["hasGameSettings"],false);assert_eq!(isolated["hasServersList"],true);assert_eq!(isolated["resourcePacks"],json!([]));}
        assert!(collect(&f.0.join("missing"),"demo",&settings(false)).is_err());assert!(!f.0.join("missing").exists());assert!(collect(&f.0,"../outside",&settings(false)).is_err());assert!(collect(&f.0,"unknown",&settings(false)).is_err());
        assert!(!f.0.join("resourcepacks").exists());assert!(!f.0.join("config").exists());
    }
    #[test] fn instance_marker_selects_inventory_without_using_shared_content(){
        let f=Fixture::new();f.dir("versions/demo");f.file("options.txt",b"shared");f.file("versions/demo/servers.dat",b"private");
        f.file("versions/demo/instance.json",br#"{"isolation":true}"#);
        let inventory=collect(&f.0,"demo",&settings(false)).unwrap();assert_eq!(inventory["hasGameSettings"],false);assert_eq!(inventory["hasServersList"],true);
        f.file("versions/demo/instance.json",b"invalid");assert!(collect(&f.0,"demo",&settings(false)).is_err());
    }
    #[test] fn recursive_budget_and_wrong_content_kinds_fail_explicitly(){
        let f=Fixture::new();f.dir("versions/demo");f.file("config/sub/ordinary.txt",b"fixture");let root=Directory::open(&f.0).unwrap();let dir=optional_directory(&root,"config").unwrap().unwrap();assert!(inspect_tree(&dir,&mut Budget{remaining:0},0).is_err());
        assert!(inspect_tree(&dir,&mut Budget::new(),DEPTH_CAP+1).is_err());f.file("servers.dat/child",b"x");assert!(collect(&f.0,"demo",&settings(false)).is_err());
    }
    #[cfg(unix)]
    #[test] fn symlinks_and_hardlinks_are_rejected_without_reading_targets(){
        use std::os::unix::fs::symlink;
        let f=Fixture::new();f.dir("versions/demo");f.file("outside-secret",b"private");f.dir("resourcepacks/Folder");symlink(f.0.join("outside-secret"),f.0.join("resourcepacks/Folder/link")).unwrap();assert!(collect(&f.0,"demo",&settings(false)).is_err());fs::remove_file(f.0.join("resourcepacks/Folder/link")).unwrap();
        fs::hard_link(f.0.join("outside-secret"),f.0.join("resourcepacks/hard.zip")).unwrap();assert!(collect(&f.0,"demo",&settings(false)).is_err());
        assert_eq!(fs::read(f.0.join("outside-secret")).unwrap(),b"private");
    }
}

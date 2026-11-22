//! 只供已通过策略与逐次审批的聊天编排器调用；不注册为 WebView command。
use crate::{ai_tool_runtime::{ToolExecution, ToolIntent}, storage::Storage};
use serde_json::{json, Value};
use std::{fs, path::{Component, Path, PathBuf}, sync::{atomic::{AtomicBool, Ordering}, Arc}};
use tauri::{Emitter, Manager};

type Result<T> = std::result::Result<T, String>;
fn text<'a>(value: &'a Value, key: &str) -> &'a str { value.get(key).and_then(Value::as_str).unwrap_or("") }
fn check_cancel(cancel: &Arc<AtomicBool>) -> Result<()> {
    if cancel.load(Ordering::Acquire) { Err("工具执行已取消".into()) } else { Ok(()) }
}
fn selected_dir_id(settings: &Value) -> String { text(settings, "selectedVersionDirId").to_owned() }
fn sensitive_component(raw: &str) -> bool {
    let value = raw.split(':').next().unwrap_or(raw).to_ascii_lowercase();
    value.starts_with('.') || value.contains("token") || value.contains("secret") || value.contains("account")
        || value.contains("credential") || value.contains("password") || value.contains("auth")
        || value.contains("setting") || value.contains("config") || value.contains("launcher_profiles")
        || value.contains("launcher_accounts") || value.contains("storage-state")
        || matches!(value.as_str(), "accounts.dat" | "account.dat" | "accounts.json" | "account.json"
            | "settings.dat" | "settings.json" | "auth.json" | "credentials.dat")
}

async fn storage_call(app: &tauri::AppHandle, channel: &'static str, args: Vec<Value>) -> Result<Value> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || app.state::<Storage>().call(channel, &args)?.ok_or("账号接口不可用".into()))
        .await.map_err(|_| "账号操作任务异常".to_owned())?
}
async fn runtime_call(app: &tauri::AppHandle, channel: &str, args: &[Value], settings: &Value) -> Result<Value> {
    crate::runtime::call(channel, args, settings, None, app).await?.ok_or("运行时接口不可用".into())
}
async fn catalog_call(app: &tauri::AppHandle, channel: &str, args: &[Value], settings: &Value, root: &Path) -> Result<Value> {
    crate::catalog::call(app, channel, args, settings, root).await?.ok_or("资源管理接口不可用".into())
}
fn brief_accounts(accounts: &Value, selected: &Value) -> Value {
    json!(accounts.as_array().into_iter().flatten().take(500).map(|account| json!({
        "id":account.get("id"), "name":account.get("name"), "type":account.get("authType"),
        "selected":account.get("id").is_some() && account.get("id") == selected.get("id")
    })).collect::<Vec<_>>())
}
async fn installed(app: &tauri::AppHandle, settings: &Value) -> Result<Value> {
    runtime_call(app, "installed:list", &[], settings).await
}
async fn installed_all(app: &tauri::AppHandle, settings: &Value) -> Result<Value> {
    runtime_call(app, "installed:listAll", &[], settings).await
}
fn require_version<'a>(versions: &'a Value, id: &str) -> Result<&'a Value> {
    versions.as_array().into_iter().flatten().find(|item| text(item, "id") == id).ok_or("目标实例不存在，请先查询已安装实例".into())
}
fn known_loader(loader: &str) -> bool { matches!(loader.to_ascii_lowercase().as_str(), "fabric" | "forge" | "neoforge" | "quilt") }
fn required_dependencies(version: &Value) -> Vec<Value> {
    version.get("dependencies").and_then(Value::as_array).into_iter().flatten()
        .filter(|dependency| text(dependency, "dependency_type") == "required")
        .cloned().collect()
}
fn selected_file(versions: &Value, mc: &str, loader: &str, kind: &str) -> Option<(String, String, u64, Vec<Value>)> {
    versions.as_array()?.iter().filter(|version| {
        let loader_matches = if matches!(kind, "mod" | "modpack") {
            known_loader(loader) && version["loaders"].as_array().is_some_and(|loaders| {
                loaders.iter().any(|item| item.as_str().is_some_and(|name| name.eq_ignore_ascii_case(loader)))
            })
        } else { true };
        version.get("downloadable").and_then(Value::as_bool) != Some(false)
            && version["game_versions"].as_array().is_some_and(|games| games.iter().any(|game| game.as_str() == Some(mc)))
            && loader_matches
    }).find_map(|version| {
        let files = version["files"].as_array()?;
        let file = files.iter().find(|file| file["primary"] == true).or_else(|| files.first())?;
        let size = file["size"].as_u64().filter(|size| *size > 0)?;
        let url = file["url"].as_str().filter(|value| !value.is_empty())?;
        let name = file["filename"].as_str().filter(|value| !value.is_empty())?;
        Some((url.into(), name.into(), size, required_dependencies(version)))
    })
}

fn reject_links(path: &Path) -> Result<()> {
    if !path.is_absolute() { return Err("必须提供绝对路径".into()); }
    let mut current = PathBuf::new();
    for part in path.components() {
        match part {
            Component::Prefix(_) => { current.push(part.as_os_str()); continue; }
            Component::RootDir | Component::Normal(_) => current.push(part.as_os_str()),
            _ => return Err("路径包含相对跳转".into()),
        }
        let metadata = fs::symlink_metadata(&current).map_err(|_| "路径不存在或无法核验")?;
        if metadata.file_type().is_symlink() { return Err("拒绝操作符号链接".into()); }
        #[cfg(windows)] {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 { return Err("拒绝操作重解析路径".into()); }
        }
    }
    Ok(())
}
fn deletable(root: &Path, target: &Path) -> Result<PathBuf> {
    reject_links(root)?; reject_links(target)?;
    let root = fs::canonicalize(root).map_err(|_| "游戏目录不可用")?;
    let target = fs::canonicalize(target).map_err(|_| "删除目标不可用")?;
    let relative = target.strip_prefix(&root).map_err(|_| "目标不在当前游戏目录内")?;
    if relative.as_os_str().is_empty() { return Err("不能删除游戏目录本身".into()); }
    for component in relative.components() {
        let value = component.as_os_str().to_str().ok_or("路径不是有效文本")?;
        if sensitive_component(value) { return Err("不能通过 AI 删除内部状态、隐藏文件或凭据文件".into()); }
    }
    // 实例目录和设置引用必须经专门事务删除，不能绕过实例管理直接移除。
    if relative.components().next().is_some_and(|part| part.as_os_str().to_string_lossy().eq_ignore_ascii_case("versions")) {
        return Err("实例目录请使用删除实例工具，避免绕过配置事务".into());
    }
    Ok(target)
}
fn preflight_tree(path: &Path, budget: &mut usize, depth: usize, cancel: &Arc<AtomicBool>) -> Result<()> {
    check_cancel(cancel)?;
    if *budget == 0 || depth > 64 { return Err("删除目标文件数或目录层级超过上限".into()); }
    *budget -= 1;
    reject_links(path)?;
    let relative_name = path.file_name().and_then(|value| value.to_str()).ok_or("删除路径不是有效文本")?;
    if sensitive_component(relative_name) { return Err("删除树包含内部状态、隐藏文件或凭据文件，已拒绝".into()); }
    let metadata = fs::symlink_metadata(path).map_err(|_| "无法核验删除目标")?;
    if metadata.is_dir() {
        for entry in fs::read_dir(path).map_err(|_| "无法读取删除目录")? {
            preflight_tree(&entry.map_err(|_| "无法读取删除条目")?.path(), budget, depth + 1, cancel)?;
        }
    } else if !metadata.is_file() { return Err("只允许删除普通文件或目录".into()); }
    Ok(())
}
fn remove_path(root: &Path, target: &Path, cancel: &Arc<AtomicBool>) -> Result<()> {
    check_cancel(cancel)?;
    let _guard = crate::install_lock::acquire_blocking(root)?;
    check_cancel(cancel)?;
    let target = deletable(root, target)?;
    preflight_tree(&target, &mut 200_000, 0, cancel)?;
    check_cancel(cancel)?;
    // 同卷隔离后才删除；失败保留隔离副本，并明确报告没有完整完成。
    let trash = root.join(format!(".hcmcl-ai-trash-{}", uuid::Uuid::new_v4()));
    fs::rename(&target, &trash).map_err(|_| "无法隔离删除目标，原目标未删除")?;
    let result = if trash.is_dir() { fs::remove_dir_all(&trash) } else { fs::remove_file(&trash) };
    result.map_err(|_| format!("目标已隔离，但删除未完成；保留副本：{}", trash.to_string_lossy()))
}

async fn action(app: &tauri::AppHandle, intent: &ToolIntent, settings: &Value, root: &Path, cancel: Arc<AtomicBool>) -> Result<String> {
    check_cancel(&cancel)?;
    let args = &intent.args;
    match intent.name.as_str() {
        "launcher_list_versions" => {
            let versions = installed_all(app, settings).await?;
            Ok(json!(versions.as_array().into_iter().flatten().take(2000).map(|version| json!({"versionId":version["id"],"mcVersion":version["mcVersion"],"loader":version["loader"],"worlds":version["worlds"].as_array().map(Vec::len).unwrap_or(0)})).collect::<Vec<_>>()).to_string())
        }
        "launcher_list_accounts" => {
            let accounts = storage_call(app, "accounts:list", vec![]).await?;
            let selected = storage_call(app, "accounts:selected", vec![]).await?;
            Ok(brief_accounts(&accounts, &selected).to_string())
        }
        "launcher_get_status" => {
            let selected = storage_call(app, "accounts:selected", vec![]).await?;
            Ok(json!({"gameRunning":crate::runtime::game_is_running(),"gameDir":root,"versionIsolation":settings["versionIsolation"],"selectedAccount":selected.get("name")}).to_string())
        }
        "launcher_create_offline_account" => {
            check_cancel(&cancel)?;
            let app = app.clone(); let name = text(args, "name").to_owned(); let cancel = Arc::clone(&cancel);
            tauri::async_runtime::spawn_blocking(move || {
                check_cancel(&cancel)?;
                let state = app.state::<Storage>();
                let list = state.call("accounts:list", &[])?.ok_or("账号列表不可用")?;
                if list.as_array().into_iter().flatten().any(|account| text(account,"name").eq_ignore_ascii_case(&name)) { return Err("已存在同名账号，未重复创建".into()); }
                check_cancel(&cancel)?;
                let created = state.call("accounts:addOffline", &[json!(name)])?.ok_or("离线账号创建失败")?;
                Ok(format!("已创建离线账号 {}，并设为当前账号。", text(&created,"name")))
            }).await.map_err(|_| "创建账号任务异常".to_owned())?
        }
        "launcher_delete_account" => {
            check_cancel(&cancel)?;
            let accounts = storage_call(app, "accounts:list", vec![]).await?;
            let key = text(args,"account");
            let target = accounts.as_array().into_iter().flatten().find(|account| text(account,"id") == key)
                .or_else(|| accounts.as_array().into_iter().flatten().find(|account| text(account,"name").eq_ignore_ascii_case(key))).ok_or("目标账号不存在")?;
            check_cancel(&cancel)?;
            crate::auth::storage_account_call(app, "accounts:remove", &[target["id"].clone()]).await?.ok_or("账号删除接口不可用")?;
            Ok(format!("已移除本地账号 {}。", text(target,"name")))
        }
        "launcher_launch_version" => {
            let versions = installed(app, settings).await?; let id = text(args,"versionId"); require_version(&versions,id)?;
            check_cancel(&cancel)?;
            app.emit_to("main", "launcher:event", json!({"channel":"ai:launchRequest","payload":id})).map_err(|_| "主界面启动请求发送失败")?;
            Ok(format!("已请求主界面启动 {id}，请以主界面的实际启动进度为准。"))
        }
        "launcher_stop_game" => { runtime_call(app,"launch:stop",&[],settings).await?; Ok("停止请求已完成。".into()) }
        "launcher_delete_version" | "launcher_rename_version" => {
            let id = text(args,"versionId"); let versions = installed(app,settings).await?; require_version(&versions,id)?;
            check_cancel(&cancel)?;
            if intent.name == "launcher_delete_version" { catalog_call(app,"manage:deleteVersion",&[json!(id)],settings,root).await?; Ok(format!("已删除实例 {id}。")) }
            else { let next=text(args,"newName"); catalog_call(app,"manage:renameVersion",&[json!(id),json!(next)],settings,root).await?; Ok(format!("实例已重命名：{id} → {next}")) }
        }
        "launcher_list_mods" => {
            let mods = catalog_call(app,"manage:mods",&[args["versionId"].clone(),json!(selected_dir_id(settings))],settings,root).await?;
            Ok(json!(mods.as_array().into_iter().flatten().take(200).map(|item| json!({"file":item.get("name").or_else(||item.get("filename")),"enabled":item.get("enabled")})).collect::<Vec<_>>()).to_string())
        }
        "launcher_search_resources" => {
            let result=catalog_call(app,"mods:search",&[args["query"].clone(),args["type"].clone(),json!(""),json!(text(args,"gameVersion")),json!(text(args,"loader")),json!(0),json!("all")],settings,root).await?;
            Ok(json!(result["hits"].as_array().into_iter().flatten().take(8).map(|item|json!({"project":item.get("slug").or_else(||item.get("id")),"title":item["title"],"source":item["source"],"downloads":item["downloads"],"downloadable":item.get("downloadable").and_then(Value::as_bool).unwrap_or(true),"summary":text(item,"description").chars().take(120).collect::<String>()})).collect::<Vec<_>>()).to_string())
        }
        "launcher_install_resource" => {
            let versions=installed(app,settings).await?; let id=text(args,"versionId"); let version=require_version(&versions,id)?;
            let mc=text(version,"mcVersion"); if mc.is_empty(){return Err("目标实例的 Minecraft 版本未知，未猜测兼容文件".into());}
            let kind=text(args,"type"); let loader=if kind=="mod"{text(version,"loader")}else{""};
            if kind == "mod" && !known_loader(loader) { return Err("目标实例加载器未知或为 vanilla，拒绝安装需要加载器的模组".into()); }
            let loaders=if kind=="mod"{json!([loader])}else{json!([])};
            let sources:Vec<&str>=match text(args,"source"){""=>vec!["modrinth","curseforge"],source=>vec![source]};
            let dir_id = json!(selected_dir_id(settings));
            for source in sources {
                check_cancel(&cancel)?;
                let list = match catalog_call(app,"mods:versions",&[args["project"].clone(),loaders.clone(),json!([mc]),json!(source),json!(kind)],settings,root).await {
                    Ok(value) => value,
                    Err(error) if text(args, "source").is_empty() => { let _ = error; continue; }
                    Err(error) => return Err(error),
                };
                if let Some((url,name,size,deps))=selected_file(&list,mc,loader,kind) {
                    if !deps.is_empty() { return Err("该资源有必需前置依赖；AI 工具没有绑定的依赖安装授权，未安装主文件".into()); }
                    check_cancel(&cancel)?;
                    catalog_call(app,"mods:install",&[json!(url),json!(name),json!(id),json!(kind),json!(size),dir_id.clone()],settings,root).await?;
                    return Ok(format!("已将 {name} 安装到实例 {id}。"));
                }
            }
            Err("没有找到允许分发且精确适配当前 Minecraft/加载器的文件".into())
        }
        "launcher_delete_path" => {
            let root=root.to_path_buf(); let target=PathBuf::from(text(args,"path")); let cancel=Arc::clone(&cancel);
            tauri::async_runtime::spawn_blocking(move||remove_path(&root,&target,&cancel)).await.map_err(|_|"删除任务异常".to_owned())??;
            Ok("目标删除已完成。".into())
        }
        _ => Err("未知工具，未执行".into()),
    }
}

pub(crate) async fn execute(app: &tauri::AppHandle, intent: &ToolIntent, settings: &Value, game_dir: &Path, cancel: Arc<AtomicBool>) -> ToolExecution {
    if crate::ai_tool_runtime::validate_intent(&intent.provider_call_id,&intent.name,&intent.args).as_ref()!=Ok(intent) {
        return ToolExecution::failure("工具参数未通过严格校验，未执行");
    }
    if let Err(error) = check_cancel(&cancel) { return ToolExecution::failure(error); }
    match action(app,intent,settings,game_dir,cancel).await { Ok(text)=>ToolExecution::success(text),Err(error)=>ToolExecution::failure(error) }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp { fn new()->Self {let root=std::env::temp_dir().join(format!("hcmcl-ai-action-{}",uuid::Uuid::new_v4()));fs::create_dir(&root).unwrap();Self(fs::canonicalize(root).unwrap())} }
    impl Drop for Temp {fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}
    #[test] fn account_projection_never_copies_tokens_or_extra_fields() {
        let value=brief_accounts(&json!([{"id":"one","name":"A","authType":"microsoft","accessToken":"secret","password":"hidden"}]),&json!({"id":"one"}));
        assert_eq!(value[0]["selected"],true);assert!(!value.to_string().contains("secret"));assert!(!value.to_string().contains("password"));
    }
    #[test] fn exact_compatibility_and_distribution_control_file_selection() {
        let v=json!([{"game_versions":["1.21"],"loaders":["forge"],"files":[{"url":"https://example.invalid/a","filename":"a.jar","size":10}]}]);
        assert!(selected_file(&v,"1.20","forge","mod").is_none());assert!(selected_file(&v,"1.21","fabric","mod").is_none());assert!(selected_file(&v,"1.21","forge","mod").is_some());
        assert!(selected_file(&v,"1.21","","mod").is_none());assert!(selected_file(&v,"1.21","vanilla","mod").is_none());
        let with_dependency=json!([{"game_versions":["1.21"],"loaders":["forge"],"dependencies":[{"project_id":"dep","dependency_type":"required"}],"files":[{"url":"https://example.invalid/a","filename":"a.jar","size":10}]}]);
        assert_eq!(selected_file(&with_dependency,"1.21","forge","mod").unwrap().3.len(),1);
        let mut denied=v;denied[0]["downloadable"]=json!(false);assert!(selected_file(&denied,"1.21","forge","mod").is_none());
    }
    #[test] fn deletion_refuses_root_metadata_instance_bypass_and_escape() {
        let temp=Temp::new();fs::create_dir_all(temp.0.join("versions/one")).unwrap();fs::write(temp.0.join("versions/one/a"),b"keep").unwrap();fs::write(temp.0.join(".hcmcl-state"),b"keep").unwrap();
        assert!(deletable(&temp.0,&temp.0).is_err());assert!(deletable(&temp.0,&temp.0.join("versions/one")).is_err());assert!(deletable(&temp.0,&temp.0.join(".hcmcl-state")).is_err());assert!(deletable(&temp.0,&temp.0.join("../outside")).is_err());
    }
    #[test] fn isolated_deletion_removes_only_selected_regular_tree() {
        let temp=Temp::new();fs::create_dir_all(temp.0.join("saves/world")).unwrap();fs::write(temp.0.join("saves/world/level.dat"),b"fixture").unwrap();fs::write(temp.0.join("keep.txt"),b"keep").unwrap();
        let cancel=Arc::new(AtomicBool::new(false));
        remove_path(&temp.0,&temp.0.join("saves/world"),&cancel).unwrap();assert!(!temp.0.join("saves/world").exists());assert_eq!(fs::read(temp.0.join("keep.txt")).unwrap(),b"keep");
    }
    #[test] fn deletion_preflights_private_descendants_and_cancellation() {
        let temp=Temp::new();fs::create_dir_all(temp.0.join("saves/world")).unwrap();fs::write(temp.0.join("saves/world/settings.json"),b"private").unwrap();
        let cancel=Arc::new(AtomicBool::new(false));
        assert!(remove_path(&temp.0,&temp.0.join("saves/world"),&cancel).is_err());
        assert!(temp.0.join("saves/world/settings.json").exists());
        fs::remove_file(temp.0.join("saves/world/settings.json")).unwrap();
        fs::write(temp.0.join("saves/world/level.dat"),b"keep").unwrap();
        cancel.store(true, Ordering::Release);
        assert!(remove_path(&temp.0,&temp.0.join("saves/world"),&cancel).is_err());
        assert_eq!(fs::read(temp.0.join("saves/world/level.dat")).unwrap(),b"keep");
    }
}

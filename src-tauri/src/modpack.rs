//! 整合包受控下载、探测、清单、导出与单任务导入。
//! 探测和清单只读；导出源也只读，输出由 owned worker 无覆盖发布。

use serde_json::Value;
use std::path::Path;
use tauri::AppHandle;

mod access;
mod inventory;
mod parser;
mod export;
mod output;
mod download;
mod download_store;
mod network;
mod isolation;
mod plan;
mod install_stage;
mod materialize;
mod import_source;
mod remote;
mod import;

pub(crate) use isolation::Snapshot as InstanceIsolation;

pub(crate) fn instance_isolation(root: &Path, id: &str, settings: &Value) -> Result<InstanceIsolation> {
    isolation::read(root, id, settings)
}

pub(crate) fn instance_isolated(root: &Path, id: &str, settings: &Value) -> Result<bool> {
    Ok(instance_isolation(root, id, settings)?.isolated)
}

pub(crate) fn cancel_for_window() { download::cancel_for_window(); export::cancel_for_window(); import::cancel_for_window(); }
pub(crate) fn cancel_download(task_id:Option<&str>)->std::result::Result<(),String> { let download_result=download::cancel_download(task_id); let export_result=export::cancel_download(task_id); let import_result=import::cancel_download(task_id); download_result?; export_result?; import_result }
pub(crate) fn relaunch_ready() -> std::result::Result<(), String> {
    download::relaunch_ready()?;
    export::relaunch_ready()?;
    import::relaunch_ready()
}

type Result<T> = std::result::Result<T, String>;

fn one_string(args: &[Value]) -> Result<&str> {
    if args.len() != 1 { return Err("整合包操作需要一个参数".into()); }
    args[0].as_str().filter(|value| !value.is_empty() && value.len() <= 32768 && !value.chars().any(char::is_control))
        .ok_or_else(|| "整合包参数必须是有效文本".into())
}

fn download_arguments<'a>(args: &'a [Value], settings: &Value) -> Result<(&'a str, &'a str)> {
    // 模式守卫必须先于任务登记、缓存目录创建、DNS 和 HTTP 请求。
    if settings.get("mode").and_then(Value::as_str) == Some("local") {
        return Err("本地模式禁止联网下载整合包；未创建下载任务".into());
    }
    if args.len()!=2 { return Err("整合包下载需要地址和文件名两个参数".into()); }
    Ok((one_string(&args[..1])?, one_string(&args[1..])?))
}

fn import_arguments(args: &[Value]) -> Result<(&str, Option<&str>)> {
    if args.is_empty() || args.len() > 3 { return Err("整合包导入需要来源以及可选的实例名、目录标识".into()); }
    let source = one_string(&args[..1])?;
    let custom = match args.get(1) {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if value.len() <= 32768 && !value.chars().any(char::is_control) => Some(value.as_str()),
        _ => return Err("整合包实例名必须是有效文本".into()),
    };
    if args.get(2).is_some_and(|value| !value.is_null() && !value.is_string()) { return Err("版本目录标识必须是字符串".into()); }
    Ok((source, custom))
}

fn import_url_arguments(args: &[Value]) -> Result<(&str, &str, Option<&str>)> {
    if args.len() < 2 || args.len() > 4 { return Err("URL 导入需要地址、文件名以及可选的实例名、目录标识".into()); }
    let url = one_string(&args[..1])?;
    let (filename, custom) = import_arguments(&args[1..])?;
    Ok((url, filename, custom))
}

pub(crate) async fn call(app: &AppHandle, channel: &str, args: &[Value], settings: &Value, game_dir: &Path) -> Result<Option<Value>> {
    match channel {
        "modpack:import" => {
            let (source, custom) = import_arguments(args)?;
            import::start(app, game_dir, source, custom, settings).await.map(Some)
        }
        "modpack:importFromUrl" => {
            let (url, filename, custom) = import_url_arguments(args)?;
            import::start_from_url(app, game_dir, url, filename, custom, settings).await.map(Some)
        }
        "modpack:download" => {
            let (url, filename)=download_arguments(args,settings)?;
            download::start(app,url,filename).await.map(Some)
        }
        "modpack:export" => {
            if args.len()!=2 { return Err("整合包导出需要实例名和完整选项两个参数".into()); }
            let id=one_string(&args[..1])?;
            let options=export::Options::parse(&args[1])?;
            export::start(app,game_dir,id,options,settings).await.map(Some)
        }
        "modpack:probe" => {
            let path = one_string(args)?.to_owned();
            if let Some(value)=download::probe(&path).await? { return Ok(Some(value)); }
            let app = app.clone();
            tokio::task::spawn_blocking(move || {
                let path = Path::new(&path);
                crate::desktop::require_picked_file(&app, path)?;
                let mut opened = access::OpenedFile::open(path)?;
                // 授权检查与实际打开之间可能被换绑，持有句柄必须仍是获准文件。
                crate::desktop::require_picked_file(&app, path)?;
                opened.verify()?;
                let result = parser::probe(&mut opened.file, path)?;
                opened.verify()?;
                crate::desktop::require_picked_file(&app, path)?;
                Ok(Some(result))
            }).await.map_err(|_| "整合包探测后台任务异常".to_owned())?
        }
        "modpack:exportInventory" => {
            let id = one_string(args)?.to_owned();
            let root = game_dir.to_path_buf();
            let settings = settings.clone();
            tokio::task::spawn_blocking(move || inventory::collect(&root, &id, &settings).map(Some))
                .await.map_err(|_| "整合包清单后台任务异常".to_owned())?
        }
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn local_download_is_rejected_before_url_validation_or_task_registration() {
        let args=vec![json!("https://fixture.invalid/archive.zip"),json!("archive.zip")];
        let error=download_arguments(&args,&json!({"mode":"local"})).unwrap_err();
        assert!(error.contains("本地模式"));
        assert!(download_arguments(&[],&json!({"mode":"local"})).unwrap_err().contains("本地模式"));
        assert_eq!(download_arguments(&args,&json!({"mode":"normal"})).unwrap(),("https://fixture.invalid/archive.zip","archive.zip"));
        assert!(download_arguments(&args,&json!({"mode":"minimal","metadataOnlyMods":true})).is_ok());
        for args in [vec![],vec![json!("url")],vec![json!("url"),Value::Null],vec![json!("url"),json!("")],vec![json!("url"),json!("a"),json!("extra")]] {
            assert!(download_arguments(&args,&json!({"mode":"normal"})).is_err());
        }
    }
    #[test]
    fn import_preserves_optional_name_and_directory_positions_without_coercion() {
        assert_eq!(import_arguments(&[json!("source.zip")]).unwrap(), ("source.zip", None));
        assert_eq!(import_arguments(&[json!("source.zip"), Value::Null, json!("default")]).unwrap(), ("source.zip", None));
        assert_eq!(import_arguments(&[json!("source.zip"), json!(" 名称 "), json!("other")]).unwrap(), ("source.zip", Some(" 名称 ")));
        assert_eq!(import_arguments(&[json!("source.zip"), json!("")]).unwrap(), ("source.zip", Some("")));
        for args in [vec![], vec![Value::Null], vec![json!("source.zip"), json!(false)], vec![json!("source.zip"), json!("bad\nname")], vec![json!("source.zip"), Value::Null, json!(1)], vec![json!("source.zip"), Value::Null, Value::Null, json!("extra")]] {
            assert!(import_arguments(&args).is_err());
        }
    }

    #[test]
    fn url_import_preserves_filename_name_and_directory_without_coercion() {
        let url = "https://fixture.invalid/source.mrpack";
        assert_eq!(import_url_arguments(&[json!(url), json!("source.mrpack")]).unwrap(), (url, "source.mrpack", None));
        assert_eq!(import_url_arguments(&[json!(url), json!("source.mrpack"), Value::Null, json!("other")]).unwrap(), (url, "source.mrpack", None));
        assert_eq!(import_url_arguments(&[json!(url), json!("source.mrpack"), json!("自定义"), json!("default")]).unwrap(), (url, "source.mrpack", Some("自定义")));
        for args in [vec![], vec![json!(url)], vec![json!(url), Value::Null], vec![json!(url), json!("source.mrpack"), json!(false)], vec![json!(url), json!("source.mrpack"), Value::Null, json!(5)], vec![json!(url), json!("source.mrpack"), Value::Null, Value::Null, json!("extra")]] {
            assert!(import_url_arguments(&args).is_err());
        }
    }

    #[test]
    fn original_single_argument_contract_is_strict() {
        assert_eq!(one_string(&[json!("fixture.zip")]).unwrap(), "fixture.zip");
        for args in [vec![], vec![Value::Null], vec![json!("")], vec![json!(1)], vec![json!("x"), json!("y")], vec![json!("x\ny")]] {
            assert!(one_string(&args).is_err());
        }
    }
}

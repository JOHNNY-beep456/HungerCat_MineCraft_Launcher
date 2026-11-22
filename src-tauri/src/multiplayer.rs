//! 联机诊断、Windows core 会话、有界物理 UDP 信令与独立浮层；no-tun 转发和 LAN 另行接入。
mod model;
mod signaling_model;
#[cfg(windows)] mod signaling;
mod platform;
mod resources;
mod session_model;
mod session;
mod hud;
mod danmaku_model;
mod danmaku;
mod mini;
pub(crate) fn hud_view(app:&AppHandle)->Result<session::HudView>{session::hud_view(app)}
/// 调用者位于 Storage 初始化 / 成功提交后的后台路径；不在 UI 读取 Data 或密钥。
pub(crate) fn refresh_hud_settings(app:&AppHandle)->Result<()>{session::refresh_hud_settings(app)}
#[cfg(windows)] mod process;
#[cfg(windows)] mod session_files;
#[cfg(windows)] #[path = "modpack/access.rs"] mod access;
pub(crate) fn init(app: &AppHandle) { session::init(app); danmaku::init(app); mini::init(app); }
pub(crate) fn close(app: &AppHandle) { session::close(app); danmaku::close(app); mini::close(app); }
pub(crate) async fn shutdown(app: &AppHandle) -> Result<()> {
    // 每个域都必须尝试真实收尾；前一项失败不能跳过其它 owner。
    let mut errors = Vec::new();
    for result in [session::shutdown(app).await, danmaku::shutdown(app).await, mini::shutdown(app).await] {
        if let Err(error) = result { errors.push(error); }
    }
    if errors.is_empty() { Ok(()) } else { Err(errors.join("；")) }
}
pub(crate) fn relaunch_ready(app: &AppHandle) -> Result<()> { session::relaunch_ready(app)?; danmaku::relaunch_ready(app)?; mini::relaunch_ready(app) }
pub(crate) async fn authorize_danmaku(app: &AppHandle, window: &tauri::WebviewWindow) -> Result<()> { danmaku::authorize(app, window).await }
pub(crate) async fn danmaku_ready(app: &AppHandle, window: &tauri::WebviewWindow, args: &[Value]) -> Result<Value> { danmaku::ready(app, window, args).await }
pub(crate) async fn authorize_mini(app: &AppHandle, window: &tauri::WebviewWindow) -> Result<()> { mini::authorize(app, window).await }
pub(crate) fn mini_channel_allowed(channel: &str) -> bool {
    matches!(channel, "settings:get" | "mp:miniState" | "mp:miniResize" | "mp:miniDrag" | "mp:hasMainWindow"
        | "mp:closeMiniWindow" | "mp:leaveLobby" | "mp:sendChat" | "mp:getMessages"
        | "mp:getAppState" | "mp:getLobby" | "mp:getPlayers")
}
/// 小窗只需要共享 Provider 的外观字段；目录、账号和秘密标记不得进入独立页面。
pub(crate) fn mini_settings(settings: &Value) -> Value {
    let mut projection = serde_json::Map::new();
    for key in ["language", "theme", "reducedMotion", "mode", "experimental", "materialStyle",
        "githubStyle", "accentColor", "background", "autoThemeFromWallpaper"] {
        if let Some(value) = settings.get(key) { projection.insert(key.into(), value.clone()); }
    }
    Value::Object(projection)
}

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

type Result<T> = std::result::Result<T, String>;

fn invalid() -> String {
    "联机诊断参数无效 / 連線診斷參數無效 / Invalid multiplayer diagnostic arguments".into()
}
fn unavailable() -> String {
    "联机诊断任务异常 / 連線診斷工作異常 / Multiplayer diagnostic task failed".into()
}
fn unsupported() -> String {
    "当前平台不支持此桌面联机诊断 / 目前平台不支援此桌面連線診斷 / This desktop multiplayer diagnostic is unavailable on this platform".into()
}
fn resource_directory(app: &AppHandle) -> Result<std::path::PathBuf> {
    app.path().resource_dir().map(|directory| directory.join("easytier"))
        .map_err(|_| "应用资源目录不可用 / 應用程式資源目錄無法使用 / Application resource directory is unavailable".into())
}
fn external_url(raw: &str) -> Result<String> {
    let url = tauri::Url::parse(raw).map_err(|_| invalid())?;
    if raw.len() > 8192 || raw.chars().any(char::is_control)
        || !matches!(url.scheme(), "http" | "https" | "mailto") || !url.username().is_empty() || url.password().is_some()
        || (matches!(url.scheme(), "http" | "https") && url.host_str().is_none()) { return Err(invalid()); }
    Ok(raw.to_owned())
}

/// IPC 等待者离开后，后台读取 / 系统交接仍持有自己的 Gate 票直至真实返回。
async fn blocking<T, F>(app: &AppHandle, work: F) -> Result<T>
where T: Send + 'static, F: FnOnce() -> Result<T> + Send + 'static {
    let request = app.state::<crate::lifecycle::Gate>().enter()?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = work();
        request.finish();
        result
    }).await.map_err(|_| unavailable())?
}

pub(crate) async fn call(app: &AppHandle, window: &tauri::WebviewWindow, channel: &str, args: &[Value]) -> Result<Option<Value>> {
    match channel {
        "mp:openMiniWindow" => {
            if !args.is_empty() { return Err(invalid()); }
            mini::open(app)?;
            return Ok(Some(Value::Null));
        },
        "mp:closeMiniWindow" => {
            if !args.is_empty() { return Err(invalid()); }
            mini::request_close(app)?;
            return Ok(Some(Value::Null));
        },
        "mp:miniState" => {
            if !args.is_empty() { return Err(invalid()); }
            return Ok(Some(session::mini_snapshot(app)?));
        },
        "mp:miniResize" => {
            if args.len() != 2 { return Err(invalid()); }
            let width = args[0].as_f64().ok_or_else(invalid)?;
            let height = args[1].as_f64().ok_or_else(invalid)?;
            mini::resize(app, width, height).await?;
            return Ok(Some(Value::Null));
        },
        "mp:miniDrag" => {
            if !args.is_empty() { return Err(invalid()); }
            mini::drag(app).await?;
            return Ok(Some(Value::Null));
        },
        "mp:hasMainWindow" => {
            if !args.is_empty() { return Err(invalid()); }
            return Ok(Some(json!(mini::has_main(app, window).await?)));
        },
        "mp:hudState" => {
            if !args.is_empty() { return Err(invalid()); }
            return Ok(Some(hud_view(app)?.snapshot));
        },
        "mp:openHudWindow" | "mp:closeHudWindow" | "mp:openDanmakuWindow" | "mp:closeDanmakuWindow" | "mp:syncOverlays" => {
            if !args.is_empty() { return Err(invalid()); }
            if !cfg!(windows) { return Err(unsupported()); }
            crate::wait_for_storage(app).await?;
            // HUD 和弹幕都使用已提交设置的小快照，文件访问不占用 UI 线程。
            let handle=app.clone();
            blocking(app,move || { refresh_hud_settings(&handle)?; Ok(()) }).await?;
            // closeHudWindow 是重算共享内容，不能关闭仍承载 AI / 歌词的 owner。
            match channel {
                "mp:openDanmakuWindow" => danmaku::control(app,Some(true)).await?,
                "mp:closeDanmakuWindow" => danmaku::control(app,Some(false)).await?,
                "mp:syncOverlays" => danmaku::control(app,None).await?,
                _ => {}
            }
            return Ok(Some(Value::Null));
        },
        _=>{}
    }
    if let Some(value) = session::call(app, channel, args).await? { return Ok(Some(value)); }
    match channel {
        "mp:parseVirtualIp" => {
            if args.len() != 1 { return Err(invalid()); }
            let text = args[0].as_str().filter(|text| text.len() <= model::MAX_OUTPUT).ok_or_else(invalid)?;
            let text = text.to_owned();
            blocking(app, move || Ok(Some(json!(model::virtual_ip(&text))))).await
        },
        "mp:danmakuConfig" => {
            if !args.is_empty() { return Err(invalid()); }
            crate::wait_for_storage(app).await?;
            let handle = app.clone();
            blocking(app, move || {
                handle.state::<crate::storage::Storage>().with_settings_for_backend(|settings| Some(model::danmaku_config(settings)))
            }).await
        },
        "mp:binariesStatus" | "mp:openResourceDir" => {
            if !args.is_empty() { return Err(invalid()); }
            if cfg!(any(target_os = "android", target_os = "ios")) { return Err(unsupported()); }
            let directory = resource_directory(app)?;
            let handle = app.clone();
            let open = channel == "mp:openResourceDir";
            let language = app.try_state::<crate::storage::Storage>()
                .and_then(|storage| storage.try_shell_language()).unwrap_or_else(|| "zh-CN".into());
            blocking(app, move || {
                if !open { return Ok(Some(resources::status(&directory, &language))); }
                // 只打开官方资源目录。不创建目录，也不接收调用方路径。
                resources::check_directory(&directory).map_err(|_| model::tr(&language,
                    "联机资源目录不存在或不可用", "連線資源目錄不存在或無法使用", "The multiplayer resource directory is missing or unusable"))?;
                let path = directory.to_str().ok_or_else(invalid)?;
                handle.opener().open_path(path, None::<&str>).map_err(|_| model::tr(&language,
                    "无法打开联机资源目录", "無法開啟連線資源目錄", "Unable to open the multiplayer resource directory"))?;
                Ok(Some(json!("")))
            }).await
        },
        "mp:isElevated" => {
            if !args.is_empty() { return Err(invalid()); }
            blocking(app, || platform::is_elevated().map(|elevated| Some(json!(elevated)))).await
        },
        "mp:openExternal" => {
            if args.len() != 1 { return Err(invalid()); }
            if cfg!(any(target_os = "android", target_os = "ios")) { return Err(unsupported()); }
            let raw = external_url(args[0].as_str().ok_or_else(invalid)?)?;
            let handle = app.clone();
            blocking(app, move || {
                handle.opener().open_url(raw, None::<&str>).map_err(|_| "无法用系统浏览器打开链接 / 無法以系統瀏覽器開啟連結 / Unable to open the link using the system browser".to_owned())?;
                Ok(Some(Value::Null))
            }).await
        },
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mini_projection_contains_only_shared_appearance_fields() {
        let settings = json!({"language":"zh-TW","theme":"dark","experimental":"material","materialStyle":"expressive",
            "githubStyle":"dark","accentColor":"#123456","background":"midnight","reducedMotion":true,"mode":"normal",
            "autoThemeFromWallpaper":false,"gameDirAbs":"secret-path","aiApiKey":"secret","backgroundImage":"private.png"});
        assert_eq!(mini_settings(&settings), json!({"language":"zh-TW","theme":"dark","experimental":"material",
            "materialStyle":"expressive","githubStyle":"dark","accentColor":"#123456","background":"midnight",
            "reducedMotion":true,"mode":"normal","autoThemeFromWallpaper":false}));
    }

    #[test]
    fn mini_business_whitelist_is_narrow_and_excludes_main_window_controls() {
        for channel in ["settings:get", "mp:miniState", "mp:miniResize", "mp:miniDrag", "mp:hasMainWindow",
            "mp:closeMiniWindow", "mp:leaveLobby", "mp:sendChat", "mp:getMessages", "mp:getAppState", "mp:getLobby", "mp:getPlayers"] {
            assert!(mini_channel_allowed(channel), "{channel}");
        }
        for channel in ["settings:set", "settings:wallpaperData", "mp:createLobby", "mp:joinLobby", "mp:forceStop",
            "mp:openMiniWindow", "mp:openResourceDir", "accounts:list", "app:relaunch", "debug:rendererLog"] {
            assert!(!mini_channel_allowed(channel), "{channel}");
        }
    }
}

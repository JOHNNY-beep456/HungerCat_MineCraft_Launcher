mod ai_tool_runtime;
mod ai_approval;
mod ai_protocol;
mod ai_actions;
mod ai_hud;
mod ai_hud_window;
mod ai_ball;
mod ai_voice;
mod lyrics;
mod multiplayer;
mod account_import;
mod auth;
mod catalog;
mod desktop;
mod document_access;
mod homepage;
mod hardware_accel;
mod debug;
mod devmode;
mod downloads;
mod external_versions;
mod instance_servers;
mod manage_open_dir;
mod resource_updates;
mod wallpaper;
mod forge;
mod install_lock;
mod java_runtime;
mod lifecycle;
#[cfg(desktop)]
mod desktop_shell;
mod mobile_files;
mod mobile_export;
mod mobile_security;
mod loaders;
mod minecraft;
mod modpack;
mod path_alias;
mod runtime;
mod services;
#[cfg(target_os = "android")]
mod android_jvm;
#[cfg(target_os = "android")]
mod android_host;
#[cfg(target_os = "android")]
mod android_runtime;
mod storage;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

// 与共享前端的通道表在构建时逐项生成，拒绝任意命令名。
include!(concat!(env!("OUT_DIR"), "/launcher_channels.rs"));

struct StorageReadiness {
    started: std::sync::atomic::AtomicBool,
    result: tokio::sync::watch::Sender<Option<Result<(), String>>>,
}

impl Default for StorageReadiness {
    fn default() -> Self {
        Self {
            started: std::sync::atomic::AtomicBool::new(false),
            result: tokio::sync::watch::channel(None).0,
        }
    }
}

impl StorageReadiness {
    fn relaunch_ready(&self) -> Result<(), String> {
        match self.result.borrow().as_ref() {
            Some(Ok(())) => Ok(()),
            _ => Err("存储初始化尚未确认完成 / 儲存初始化尚未確認完成 / Storage initialization is not confirmed complete".into()),
        }
    }

    async fn wait(&self, timeout: std::time::Duration) -> Result<(), String> {
        let mut receiver = self.result.subscribe();
        let ready = async {
            loop {
                let status = receiver.borrow_and_update().clone();
                if let Some(status) = status { return status; }
                receiver.changed().await.map_err(|_| "存储初始化状态不可用".to_string())?;
            }
        };
        tokio::time::timeout(timeout, ready)
            .await.map_err(|_| "存储初始化尚未完成，请稍后重试".to_string())?
    }
}

async fn wait_for_storage(app: &tauri::AppHandle) -> Result<(), String> {
    app.state::<StorageReadiness>().wait(std::time::Duration::from_secs(60)).await
}

fn start_storage(app: &tauri::AppHandle) {
    let state = app.state::<StorageReadiness>();
    if state.started.swap(true, std::sync::atomic::Ordering::AcqRel) { return; }
    let initialization = match app.state::<lifecycle::Gate>().enter() {
        Ok(guard) => guard,
        Err(error) => { state.result.send_replace(Some(Err(error))); return; }
    };
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let worker_handle = handle.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            let storage = storage::Storage::from_app(&worker_handle)?;
            if !worker_handle.manage(storage) { return Err("存储重复初始化".to_string()); }
            ai_hud::refresh_settings(&worker_handle)?;
            ai_ball::request_sync(&worker_handle);
            ai_voice::refresh_settings(&worker_handle);
            lyrics::refresh_settings(&worker_handle);
            multiplayer::refresh_hud_settings(&worker_handle)?;
            #[cfg(desktop)]
            desktop_shell::sync_preferences(&worker_handle);
            Ok(())
        }).await;
        match result {
            Ok(result) => {
                handle.state::<StorageReadiness>().result.send_replace(Some(result));
                initialization.finish();
            }
            Err(_) => {
                handle.state::<StorageReadiness>().result.send_replace(Some(Err("存储初始化任务异常".into())));
                // 未正常返回的登记保留“收尾未知”，不允许自动重启。
            }
        }
    });
}

#[derive(Clone, Serialize)]
struct LauncherEvent<'a> {
    channel: &'a str,
    payload: Value,
}

fn trusted_main<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    if window.label() != "main" { return Err("此窗口无权调用启动器业务接口".into()); }
    let url = window.url().map_err(|_| "无法核验窗口来源")?;
    let bundled = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"));
    let development = cfg!(debug_assertions) && url.scheme() == "http"
        && matches!(url.host_str(), Some("localhost") | Some("127.0.0.1")) && url.port() == Some(1420);
    if !bundled && !development { return Err("当前页面来源无权调用原生业务".into()); }
    Ok(())
}

fn validate_request(channel: &str, args: &[Value], allowed: &[&str]) -> Result<(), String> {
    if !allowed.contains(&channel) { return Err("未公开的启动器通道".into()); }
    if args.len() > 64 || serde_json::to_vec(args).map_err(|_| "调用参数无效")?.len() > 64 * 1024 * 1024 {
        return Err("调用参数过大".into());
    }
    Ok(())
}

async fn relaunch_application(app: &tauri::AppHandle) -> Result<Value, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = app;
        return Err("移动端暂不支持安全重启启动器 / 行動端暫不支援安全重新啟動啟動器 / Safe launcher restart is not supported on mobile yet".into());
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        // 仅稳定且精确自有的显示资源可留给既有退出链；普通业务请求仍须为零。
        let ball_resource = ai_ball::restart_resource(app).await?;
        let restart = app.state::<lifecycle::Gate>().begin_restart_with_resources(ball_resource.as_slice())?;
        app.state::<StorageReadiness>().relaunch_ready()?;
        runtime::relaunch_ready()?;
        downloads::relaunch_ready()?;
        auth::relaunch_ready(app)?;
        services::relaunch_ready()?;
        ai_hud_window::relaunch_ready(app)?;
        // 封闭新入口后再核验同一张资源票与 native 身份；失败回滚门禁而不销毁资源。
        ai_ball::relaunch_ready(app, ball_resource.as_ref()).await?;
        java_runtime::relaunch_ready()?;
        modpack::relaunch_ready()?;
        external_versions::relaunch_ready()?;
        resource_updates::relaunch_ready()?;
        catalog::install::relaunch_ready()?;
        debug::relaunch_ready(app)?;
        multiplayer::relaunch_ready(app)?;
        devmode::relaunch_ready(app)?;
        desktop::relaunch_ready(app)?;
        restart.commit();
        // 此时业务已确认空闲；与原生退出共用唯一清理所有者，避免重复关闭或过早重启。
        desktop_shell::restart(app)?;
        Ok(Value::Null)
    }
}

fn operation_game_dir(channel: &str, args: &[Value], settings: &Value) -> Result<std::path::PathBuf, String> {
    let optional_index = match channel {
        "download:install" => Some(1),
        "versions:createVanilla" | "modpack:import" => Some(2),
        "modpack:importFromUrl" => Some(3),
        "loaders:install" | "loaders:installInPlace" => Some(4),
        "forge:install" | "mods:install" => Some(5),
        _ => None,
    };
    let requested = optional_index.and_then(|index| args.get(index));
    let selected = settings.get("selectedVersionDirId").and_then(Value::as_str).unwrap_or("");
    let id = match requested {
        None | Some(Value::Null) => selected,
        Some(Value::String(value)) if value.is_empty() => selected,
        Some(Value::String(value)) => value,
        _ => return Err("版本目录标识必须是字符串".into()),
    };
    let raw = if id.is_empty() || id == "default" {
        settings.get("gameDirAbs").and_then(Value::as_str).ok_or("默认版本目录不可用")?
    } else {
        settings.get("versionDirs").and_then(Value::as_array)
            .and_then(|dirs| dirs.iter().find(|dir| dir.get("id").and_then(Value::as_str) == Some(id)))
            .and_then(|dir| dir.get("path")).and_then(Value::as_str).ok_or("指定版本目录不存在")?
    };
    let path = std::path::PathBuf::from(raw);
    if !path.is_absolute() || path.components().any(|component| matches!(component, std::path::Component::ParentDir | std::path::Component::CurDir)) {
        return Err("后台版本目录不是可信绝对路径".into());
    }
    Ok(path)
}

// 存储提交与模式失效必须留在同一后台任务，不能依赖可被丢弃的 IPC 续体。
fn complete_storage_call(
    channel: &str, args: &[Value], result: Result<Option<Value>, String>,
    invalidate: impl FnOnce() -> Result<(), String>,
) -> Result<Option<Value>, String> {
    let value = result?;
    if value.is_some() && channel == "settings:set"
        && args.first().and_then(Value::as_object).is_some_and(|patch| patch.contains_key("mode")) {
        invalidate()?;
    }
    Ok(value)
}

/// 悬浮球只消费自身几何、两项显示设置和既有聊天能力，不继承主窗口的业务权限。
fn ai_ball_channel_allowed(channel: &str) -> bool {
    matches!(channel, "settings:get" | "ai:chat" | "ai:cancel" | "ai:reset" | "ai:decideTool"
        | "ai:transcribe" | "ai:setHudStatus" | "ai:voiceState" | "ai:ball:sync" | "ai:ball:expand"
        | "ai:ball:move" | "ai:ball:position")
}

fn ai_ball_settings(settings: &Value) -> Value {
    let language = match settings.get("language").and_then(Value::as_str) {
        Some("zh-TW") => "zh-TW", Some("en") => "en", _ => "zh-CN",
    };
    json!({"language": language, "aiVoiceEnabled": settings.get("aiVoiceEnabled").and_then(Value::as_bool).unwrap_or(false)})
}

/// 设置提交后的显示同步与实际存储 worker 同寿命，不依赖 IPC 等待方仍然存在。
fn complete_hud_settings_call(
    channel: &str, result: Result<Option<Value>, String>, refresh: impl FnOnce() -> Result<(), String>,
) -> Result<Option<Value>, String> {
    let value = result?;
    if value.is_some() && channel == "settings:set" { refresh()?; }
    Ok(value)
}

#[tauri::command]
async fn launcher_call(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    channel: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    validate_request(&channel, &args, CALL_CHANNELS)?;
    if channel == "debug:getLogs" {
        debug::authorize_log_read(&window)?;
    } else if window.label() == "devtools" && matches!(channel.as_str(), "devmode:status" | "devmode:setSecurityMode") {
        // 开发工具页只读状态并切换安全档位；邮箱验证、启用、撤销等控制只能由主窗口发起。
        #[cfg(desktop)]
        devmode::authorize_tools_window(&app,&window)?;
        #[cfg(mobile)]
        return Err("移动端开发工具页面不可用 / 行動端開發工具頁面無法使用 / Developer-tools page is unavailable on mobile".into());
    } else if channel == "ai:hudState" && window.label() == "ai-hud" {
        // HUD 是固定只读显示页；其他调用仍须通过主窗口来源校验。
        ai_hud_window::authorize_snapshot_read(&window)?;
    } else if channel == "mp:hudState" && window.label() == "ai-hud" {
        // 固定无参成员投影；该窗口不得借此读取完整大厅、聊天或修改设置。
        ai_hud_window::authorize_multiplayer(&app, &window).await?;
    } else if window.label() == "ai-hud" && lyrics::channel_allowed(&channel) {
        // 歌词只公开无参快照与逐句校准；不依赖 AI 语音开关或主窗口业务权限。
        ai_hud_window::authorize_lyrics(&app, &window, channel == "music:lyricsState").await?;
    } else if window.label() == "ai-hud" && ai_voice::hud_channel_allowed(&channel) {
        // 只有精确自有的桌面 HUD 能调用语音所需四个入口；嵌入/移动消费者仍只读。
        ai_hud_window::authorize_voice(&app, &window, channel == "ai:voiceState").await?;
        if channel != "ai:voiceState" { ai_voice::require_enabled(&app)?; }
    } else if window.label() == "danmaku" {
        // 弹幕页只接受无参配置/就绪握手，并须属于当前精确原生实例。
        if channel != "mp:danmakuConfig" { return Err("弹幕窗口无权调用此接口 / 彈幕視窗無權呼叫此介面 / This command is not available to the danmaku window".into()); }
        multiplayer::authorize_danmaku(&app, &window).await?;
    } else if window.label() == "mini" {
        if !multiplayer::mini_channel_allowed(&channel) { return Err("联机小窗无权调用此接口 / 連線小視窗無權呼叫此介面 / This command is not available to the multiplayer mini window".into()); }
        multiplayer::authorize_mini(&app, &window).await?;
    } else if window.label() == "ai-ball" {
        if !ai_ball_channel_allowed(&channel) { return Err("悬浮球无权调用此接口 / 懸浮球無權呼叫此介面 / This command is not available to the AI ball".into()); }
        ai_ball::authorize(&app, &window)?;
    } else {
        trusted_main(&window)?;
    }
    if channel == "app:relaunch" { return relaunch_application(&app).await; }
    let request = app.state::<lifecycle::Gate>().enter()?;
    let result = launcher_call_inner(app, window, channel, args).await;
    request.finish();
    result
}

async fn launcher_call_inner(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    channel: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    // 在任何存储等待之前捕获启动纪元；停止使尚未登记的旧 IPC 也失效。
    let launch_request = if channel == "launch:start" { Some(runtime::capture_launch_request()?) } else { None };
    // 下载后端状态不依赖存储、凭据或游戏目录，直接报告当前内置传输实现。
    if let Some(value) = downloads::engine_call(&channel, &args)? { return Ok(value); }
    match channel.as_str() {
        "app:version" => return Ok(json!(app.package_info().version.to_string())),
        // 停止仅按后台票据发信号，不等待存储初始化、密钥库或目录快照。
        "launch:stop" => return runtime::call(&channel, &args, &json!({}), None, &app).await?.ok_or_else(|| "游戏停止通道不可用".to_string()),
        // 取消仅查找后台任务，不等待存储初始化、读取无关密钥或解析游戏目录。
        "download:cancel" => return downloads::call(&app, &channel, &args, &json!({}), std::path::Path::new("")).await?.ok_or_else(|| "下载取消通道不可用 / 下載取消通道無法使用 / Download cancellation is unavailable".to_string()),
        "app:hardwareAccelerationBooted" => return hardware_accel::booted(&app, &args),
        "ai:voiceState" => return ai_voice::snapshot(&app, &args),
        _ => {}
    }
    // 歌词只消费自己有界的内存快照，不读取通用账号、密钥或游戏目录。
    if let Some(value) = lyrics::call(&app, &channel, &args)? { return Ok(value); }
    // 弹幕页仅在监听器注册后读取小型配置，并登记当前实例已准备接收消息。
    if window.label() == "danmaku" && channel == "mp:danmakuConfig" {
        return multiplayer::danmaku_ready(&app, &window, &args).await;
    }
    // 联机诊断、会话和小窗只使用固定资源、专用快照与窄权限；不读取通用账号、密钥或游戏目录。
    if let Some(value) = multiplayer::call(&app, &window, &channel, &args).await? { return Ok(value); }
    // 纯窗口与显示器操作不等待存储；入口的主窗口来源校验与生命周期门禁保持不变。
    if desktop::is_native_window_channel(&channel) {
        return desktop::call(&app, &window, &channel, &args).await?
            .ok_or_else(|| "窗口通道不可用 / 視窗通道無法使用 / Window command unavailable".into());
    }
    // 日志窗口只有独立受限读取接口；调试设置、日志上传仍由主窗口调用。
    if let Some(value) = debug::call(&app, &window, &channel, &args).await? { return Ok(value); }
    // AI 取消与重置只操作当前会话登记；密钥库或目录故障不能挡住停止信号。
    if let Some(value) = services::task_control_with_hud(&app, &channel) { return Ok(value); }
    // 开发授权与工具只使用专用快照，不经过通用密钥或游戏目录处理。
    if matches!(channel.as_str(), "devmode:openTools" | "devmode:closeTools" | "devmode:openDevTools" | "devmode:closeDevTools") {
        return devmode::tools_call(&app, &window, &channel, &args).await?.ok_or_else(|| "开发工具通道不可用 / 開發工具通道無法使用 / Developer-tools channel is unavailable".to_string());
    }
    if matches!(channel.as_str(), "devmode:status" | "devmode:sendCode" | "devmode:verify" | "devmode:setEnabled" | "devmode:revoke" | "devmode:setSecurityMode") {
        wait_for_storage(&app).await?;
        return devmode::call(&app, &window, &channel, &args).await?.ok_or_else(|| "开发模式通道不可用 / 開發模式通道無法使用 / Development-mode channel is unavailable".to_string());
    }
    wait_for_storage(&app).await?;
    // 小窗只接收共享 Provider 的外观字段；后台读取也持有自己的生命周期票。
    if channel == "settings:get" && window.label() == "mini" {
        if !args.is_empty() { return Err("小窗外观参数无效 / 小視窗外觀參數無效 / Invalid mini window appearance arguments".into()); }
        let handle = app.clone();
        let request = app.state::<lifecycle::Gate>().enter()?;
        return tauri::async_runtime::spawn_blocking(move || {
            let result = handle.state::<storage::Storage>().with_settings_for_backend(multiplayer::mini_settings);
            request.finish();
            result
        }).await.map_err(|_| "小窗外观读取任务异常 / 小視窗外觀讀取工作異常 / Mini window appearance task failed".to_string())?;
    }
    // 悬浮球不经过通用 settings:get，避免向独立页面交付目录、账号或密钥标记。
    if channel == "settings:get" && window.label() == "ai-ball" {
        if !args.is_empty() { return Err("悬浮球设置读取参数无效 / 懸浮球設定讀取參數無效 / Invalid AI ball settings arguments".into()); }
        let handle = app.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let settings = handle.state::<storage::Storage>().settings_for_backend()?;
            Ok(ai_ball_settings(&settings))
        }).await.map_err(|_| "悬浮球设置读取任务异常 / 懸浮球設定讀取工作異常 / AI ball settings task failed".to_string())?;
    }
    if let Some(value) = ai_ball::call(&app, &channel, &args).await? { return Ok(value); }
    // 只读 HUD 不依赖游戏目录、账号或 AI 密钥；仅从专用状态取得投影。
    if let Some(value) = ai_hud::call(&app, &channel, &args).await? { return Ok(value); }
    // 导入在通用设置/密钥和游戏目录快照之前接管，秘密只留在专用 Rust 会话。
    if let Some(value) = account_import::call(&app, &window, &channel, &args).await? { return Ok(value); }
    if let Some(value) = auth::storage_account_call(&app, &channel, &args).await? { return Ok(value); }
    // 壁纸只使用应用私有目录与主动选图权限，不依赖游戏目录或 API 密钥。
    if let Some(value) = wallpaper::call(&app, &window, &channel, &args).await? { return Ok(value); }
    // 主页仓库/市场只取自己的设置，不经过通用账号、API 密钥或游戏目录快照。
    if let Some(value) = homepage::call(&app, &window, &channel, &args).await? { return Ok(value); }
    // 密钥库和文件原子提交在工作线程执行，不阻塞 WebView 事件循环。
    let handle = app.clone();
    let storage_channel = channel.clone();
    let storage_args = args.clone();
    if let Some(value) = tauri::async_runtime::spawn_blocking(move || {
        let result = handle.state::<storage::Storage>().call(&storage_channel, &storage_args);
        let result = complete_storage_call(&storage_channel, &storage_args, result,
            || devmode::invalidate_for_settings_change(&handle));
        complete_hud_settings_call(&storage_channel, result, || {
            let hud = ai_hud::refresh_settings(&handle);
            ai_ball::request_sync(&handle);
            ai_voice::refresh_settings(&handle);
            lyrics::refresh_settings(&handle);
            let multiplayer_hud = multiplayer::refresh_hud_settings(&handle);
            #[cfg(desktop)]
            desktop_shell::sync_preferences(&handle);
            hud.and(multiplayer_hud)
        })
    }).await.map_err(|_| "存储任务异常")?? {
        return Ok(value);
    }
    let state = app.state::<storage::Storage>();
    if let Some(value) = auth::call(&app, &channel, &args, &state).await? { return Ok(value); }
    #[cfg(target_os = "android")]
    if let Some(value) = mobile_files::call(&app, &window, &channel, &args).await? { return Ok(value); }
    if let Some(value) = desktop::call(&app, &window, &channel, &args).await? { return Ok(value); }
    let handle = app.clone();
    let snapshot_channel = channel.clone();
    let snapshot_args = args.clone();
    let (settings, account) = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let state = handle.state::<storage::Storage>();
        let mut settings = state.settings_for_backend()?;
        if let Some(object) = settings.as_object_mut() {
            if let Some(key) = state.api_key_for_backend("ai")? { object.insert("aiApiKey".into(), json!(key)); }
            if let Some(key) = state.api_key_for_backend("uapis")? { object.insert("uapisApiKey".into(), json!(key)); }
        }
        let account = if snapshot_channel == "launch:start" {
            let id = snapshot_args.first().and_then(|value| value.get("accountId")).and_then(Value::as_str).filter(|value| !value.is_empty());
            state.account_for_backend(id)?
        } else { None };
        Ok((settings, account))
    }).await.map_err(|_| "后台状态读取任务异常")??;
    // 文档导出只消费当前窗口的一次性能力，不依赖实例目录是否可用。
    if channel == "mods:downloadTo" {
        #[cfg(target_os = "android")]
        if let Some(value) = mobile_files::export_download(&app, &window, &args, &settings).await? { return Ok(value); }
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        if let Some(value) = desktop::export_download(&app, &window, &args, &settings).await? { return Ok(value); }
    }
    // 反馈附件仅交接已绑定服务的浏览器地址，不依赖游戏目录。
    if channel == "feedback:open-file" {
        if let Some(value) = services::call(&app, &channel, &args, &settings, std::path::Path::new("")).await? { return Ok(value); }
    }
    // 玩家与服务器只读查询不依赖本地游戏目录，配置失效时仍可使用。
    if let Some(value) = minecraft::call(&channel, &args, &settings).await? { return Ok(value); }
    // 下载/探测只使用应用缓存或用户选择的归档，不依赖游戏目录。
    if matches!(channel.as_str(), "modpack:probe" | "modpack:download") {
        if let Some(value) = modpack::call(&app, &channel, &args, &settings, std::path::Path::new("")).await? { return Ok(value); }
    }
    // 移动端先返回明确的桌面 JRE 平台边界，不创建游戏目录或登记下载任务。
    #[cfg(any(target_os = "android", target_os = "ios"))]
    if channel == "java:install" {
        if let Some(value) = java_runtime::call(&app, &channel, &args, &settings, std::path::Path::new("")).await? { return Ok(value); }
    }
    if let Some(request) = launch_request {
        if args.len() != 1 { return Err("启动参数数量不符".into()); }
        return runtime::launch_request(&args[0], &settings, account.as_ref(), &app, request).await;
    }
    if let Some(value) = resource_updates::call(&app, &channel, &args, &settings).await? { return Ok(value); }
    let game_dir = operation_game_dir(&channel, &args, &settings)?;
    if let Some(value) = external_versions::call(&app, &channel, &args, &settings, &game_dir).await? { return Ok(value); }
    if let Some(value) = instance_servers::call(&app, &channel, &args, &game_dir).await? { return Ok(value); }
    if let Some(value) = manage_open_dir::call(&app, &channel, &args, &settings, &game_dir).await? { return Ok(value); }
    if let Some(value) = java_runtime::call(&app, &channel, &args, &settings, &game_dir).await? { return Ok(value); }
    if let Some(value) = modpack::call(&app, &channel, &args, &settings, &game_dir).await? { return Ok(value); }
    if let Some(value) = loaders::call(&app, &channel, &args, &settings, &game_dir).await? { return Ok(value); }
    if let Some(value) = downloads::call(&app, &channel, &args, &settings, &game_dir).await? { return Ok(value); }
    if let Some(value) = runtime::call(&channel, &args, &settings, account.as_ref(), &app).await? { return Ok(value); }
    if let Some(value) = catalog::call(&app, &channel, &args, &settings, &game_dir).await? { return Ok(value); }
    if let Some(value) = services::call(&app, &channel, &args, &settings, &game_dir).await? { return Ok(value); }
    Err(format!("该功能尚未完成 Tauri 平台适配：{channel}"))
}

#[tauri::command]
async fn launcher_send(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    channel: String,
    args: Vec<Value>,
) -> Result<(), String> {
    validate_request(&channel, &args, SEND_CHANNELS)?;
    if channel == "hud:setInteractive" {
        ai_hud_window::authorize_lyrics(&app, &window, args.first() == Some(&Value::Bool(false))).await?;
    } else {
        trusted_main(&window)?;
    }
    let request = app.state::<lifecycle::Gate>().enter()?;
    let result = if channel == "hud:setInteractive" {
        ai_hud_window::set_interactive(&app, &window, &args).await
    } else { launcher_send_inner(app, window, channel, args) };
    request.finish();
    result
}

fn launcher_send_inner(app: tauri::AppHandle, window: tauri::WebviewWindow, channel: String, args: Vec<Value>) -> Result<(), String> {
    if debug::send(&app, &window, &channel, &args)? { return Ok(()); }
    Err("未公开的发送通道".into())
}

// 标题栏手势只操作发起调用的主窗口，不接受目标标签或坐标。
#[tauri::command]
async fn launcher_start_titlebar_drag(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    trusted_main(&window)?;
    #[cfg(desktop)]
    { desktop::start_titlebar_drag(&app, &window).await }
    #[cfg(mobile)]
    {
        let _ = app;
        Err("移动端不支持桌面拖动 / 行動端不支援桌面拖曳 / Desktop window dragging is unavailable on mobile".into())
    }
}

// 固定主页文档签发；只能由可信主文档调用，不接受 HTML 或任意文件路径。
#[tauri::command]
async fn launcher_homepage_frame(app: tauri::AppHandle, window: tauri::WebviewWindow, id: String, expected: String, generation: String, avatar: String, skin: String) -> Result<Value, String> {
    trusted_main(&window)?;
    wait_for_storage(&app).await?;
    homepage::frame(&app, id, expected, generation, avatar, skin).await
}

// 撤销只匹配页面代次，不访问仓库、文件或网络。
#[tauri::command]
fn launcher_homepage_revoke(app: tauri::AppHandle, window: tauri::WebviewWindow, generation: String) -> Result<(), String> {
    trusted_main(&window)?;
    homepage::revoke(&app, &generation)
}

/// 桌面 CloseRequested 只是意图；移动端沿用原来的销毁门限。
pub(crate) fn invalidates_main_window(event: &tauri::WindowEvent) -> bool {
    main_window_boundary(matches!(event, tauri::WindowEvent::Destroyed),
        matches!(event, tauri::WindowEvent::CloseRequested { .. }), cfg!(mobile))
}
fn main_window_boundary(destroyed: bool, close_requested: bool, mobile: bool) -> bool {
    destroyed || (mobile && close_requested)
}

fn cancel_main_domains(app: &tauri::AppHandle) {
    homepage::cancel_for_window(app);
    account_import::cancel_for_window(app);
    ai_voice::close(app);
    lyrics::close(app);
    multiplayer::close(app);
    ai_hud::close(app);
    ai_hud_window::close(app);
    ai_ball::close(app);
    runtime::cancel_for_window();
    auth::cancel_for_window(app);
    services::cancel_for_window();
    java_runtime::cancel_for_window();
    modpack::cancel_for_window();
    external_versions::cancel_for_window();
    resource_updates::cancel_for_window();
    catalog::install::cancel_for_window();
    debug::cancel_for_window(app);
    devmode::cancel_for_window(app);
    #[cfg(desktop)]
    desktop::cancel_for_window(app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    #[cfg(desktop)]
    let context = {
        let mut context = context;
        // 对齐 Electron 主窗口的逻辑尺寸；移动端继续使用自己的基线配置。
        if let Some(main) = context.config_mut().app.windows.iter_mut().find(|window| window.label == "main") {
            main.width = 1200.0;
            main.height = 800.0;
            main.min_width = Some(960.0);
            main.min_height = Some(640.0);
            // Inspector 只由开发授权入口打开，禁用 WebView 默认快捷键与菜单入口。
            main.devtools = Some(false);
        }
        context
    };
    let document_access = document_access::DocumentAccess::new();
    let document_script = document_access.script();
    tauri::Builder::default()
        .manage(document_access)
        .append_invoke_initialization_script(document_script)
        // 第一个插件在配置窗口创建之前冻结 WebView2 策略；不能移到应用 setup 回调。
        .plugin(hardware_accel::init())
        .plugin(homepage::plugin())
        .register_asynchronous_uri_scheme_protocol("hc-homepage", homepage::protocol_response)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(mobile_security::init())
        .plugin(mobile_files::init())
        .plugin(account_import::init())
        .setup(|app| {
            app.manage(lifecycle::Gate::default());
            app.manage(StorageReadiness::default());
            #[cfg(desktop)]
            {
                desktop::init(app.handle());
                desktop_shell::init(app.handle());
            }
            debug::init(app);
            devmode::init(app.handle());
            ai_hud::init(app.handle());
            ai_hud_window::init(app.handle());
            ai_ball::init(app.handle());
            ai_voice::init(app.handle());
            lyrics::init(app.handle());
            multiplayer::init(app.handle());
            homepage::init(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" { return; }
            #[cfg(desktop)]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 所有模块都把桌面 CloseRequested 当作意图，不在框架广播阶段提前清理。
                api.prevent_close();
                desktop_shell::request_close(window.app_handle());
                return;
            }
            if invalidates_main_window(event) {
                #[cfg(desktop)]
                desktop_shell::exit(window.app_handle());
                #[cfg(mobile)]
                if window.app_handle().state::<lifecycle::Gate>().close_once() {
                    cancel_main_domains(window.app_handle());
                }
            }
        })
        .invoke_handler({
            // 给宏生成的闭包明确的期望类型，避免立即调用时参数缺少推断上下文。
            let business: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> = Box::new(
                tauri::generate_handler![launcher_call, launcher_send, launcher_start_titlebar_drag, launcher_homepage_frame, launcher_homepage_revoke]
            );
            move |invoke: tauri::ipc::Invoke<tauri::Wry>| {
                // 框架的 WebviewWindow 代表整个原生容器；还需证明请求由可信主文档发出。
                if !invoke.message.webview().state::<document_access::DocumentAccess>().authorize(&invoke) {
                    invoke.resolver.reject("当前文档无权调用原生业务 / 目前文件無權呼叫原生業務 / This document cannot invoke native business commands");
                    return true;
                }
                business(invoke)
            }
        })
        .build(context)
        .expect("Tauri 启动失败")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Ready) { start_storage(app); }
            #[cfg(desktop)]
            match event {
                tauri::RunEvent::ExitRequested { code, api, .. } => desktop_shell::on_exit_requested(app, code, &api),
                tauri::RunEvent::Exit => desktop_shell::on_exit(app),
                _ => {}
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ai_ball_settings_projection_preserves_only_the_two_consumed_fields() {
        let settings = json!({"language":"en", "aiVoiceEnabled":true,
            "gameDirAbs":"fixture-only", "accounts":["fixture"], "aiApiKey":"synthetic-not-a-key"});
        assert_eq!(ai_ball_settings(&settings), json!({"language":"en", "aiVoiceEnabled":true}));
        assert_eq!(ai_ball_settings(&json!({})), json!({"language":"zh-CN", "aiVoiceEnabled":false}));
        assert_eq!(ai_ball_settings(&json!({"language":"zh-TW", "aiVoiceEnabled":false})),
            json!({"language":"zh-TW", "aiVoiceEnabled":false}));
    }

    #[test]
    fn ai_ball_channels_match_the_shared_component_contract() {
        for channel in ["settings:get", "ai:chat", "ai:cancel", "ai:reset", "ai:decideTool",
            "ai:transcribe", "ai:setHudStatus", "ai:voiceState", "ai:ball:sync", "ai:ball:expand", "ai:ball:move", "ai:ball:position"] {
            assert!(ai_ball_channel_allowed(channel));
        }
        for channel in ["settings:set", "accounts:list", "ai:setKey", "app:relaunch", "debug:rendererLog"] {
            assert!(!ai_ball_channel_allowed(channel));
        }
    }

    #[test]
    fn desktop_close_intent_does_not_invalidate_and_real_exit_closes_gate_once() {
        let gate = lifecycle::Gate::default();
        for _ in 0..3 {
            assert!(!main_window_boundary(false, true, false));
            gate.enter().unwrap().finish();
        }
        assert!(main_window_boundary(false, true, true));
        assert!(main_window_boundary(true, false, false));
        assert!(gate.close_once());
        assert!(!gate.close_once());
        assert!(gate.enter().is_err());
        assert!(gate.begin_restart().is_err());
    }

    #[tokio::test]
    async fn mode_commit_invalidates_even_after_waiting_caller_is_dropped() {
        use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
        let invalidated = Arc::new(AtomicBool::new(false));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
        let marker = invalidated.clone();
        let caller = tokio::spawn(async move {
            tokio::task::spawn_blocking(move || {
                let _ = started_tx.send(());
                release_rx.recv().unwrap();
                // 屏障后代表存储已提交；失效回调与提交的结果处理同属该 worker。
                let result = complete_storage_call("settings:set", &[json!({"mode":"local"})],
                    Ok(Some(json!({"mode":"local"}))), || { marker.store(true, Ordering::Release); Ok(()) });
                let _ = finished_tx.send(result);
            }).await.unwrap();
        });
        started_rx.await.unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        assert!(!invalidated.load(Ordering::Acquire));
        release_tx.send(()).unwrap();
        assert!(finished_rx.await.unwrap().unwrap().is_some());
        assert!(invalidated.load(Ordering::Acquire));
    }

    #[test]
    fn mode_invalidation_only_follows_successful_handled_settings_commit() {
        let patch = [json!({"mode":"local"})];
        assert!(complete_storage_call("settings:set", &patch, Err("未提交".into()), || panic!("失败不得失效")).is_err());
        assert!(complete_storage_call("settings:set", &patch, Ok(None), || panic!("未处理不得失效")).unwrap().is_none());
        assert!(complete_storage_call("settings:get", &patch, Ok(Some(json!({}))), || panic!("读取不得失效")).is_ok());
        assert!(complete_storage_call("settings:set", &[json!({"theme":"dark"})], Ok(Some(json!({}))), || panic!("无模式补丁不得失效")).is_ok());
        assert_eq!(complete_storage_call("settings:set", &patch, Ok(Some(json!({}))), || Err("失效未确认".into())).unwrap_err(), "失效未确认");
    }

    #[test]
    fn hud_settings_sync_follows_only_successful_settings_commit() {
        let value = json!({"aiEnabled":false,"hudEnabled":false});
        let result = complete_hud_settings_call("settings:set", Ok(Some(value.clone())), || Ok(()));
        assert_eq!(result.unwrap(), Some(value));
        assert!(complete_hud_settings_call("settings:get", Ok(Some(json!({}))), || panic!("读取不发布设置变更")).is_ok());
        assert!(complete_hud_settings_call("settings:set", Ok(None), || panic!("未处理不得发布")).unwrap().is_none());
        assert!(complete_hud_settings_call("settings:set", Err("未提交".into()), || panic!("失败不得发布")).is_err());
        assert_eq!(complete_hud_settings_call("settings:set", Ok(Some(json!({}))), || Err("显示同步失败".into())).unwrap_err(), "显示同步失败");
    }

    #[tokio::test]
    async fn hud_settings_sync_survives_dropped_ipc_waiter() {
        use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
        let synced = Arc::new(AtomicBool::new(false));
        let marker = synced.clone();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
        let caller = tokio::spawn(async move {
            tokio::task::spawn_blocking(move || {
                let _ = started_tx.send(());
                release_rx.recv().unwrap();
                let value = complete_hud_settings_call("settings:set", Ok(Some(json!({}))), || {
                    marker.store(true, Ordering::Release); Ok(())
                });
                let _ = finished_tx.send(value);
            }).await.unwrap();
        });
        started_rx.await.unwrap(); caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        assert!(!synced.load(Ordering::Acquire));
        release_tx.send(()).unwrap();
        assert!(finished_rx.await.unwrap().unwrap().is_some());
        assert!(synced.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn storage_readiness_wakes_all_waiters_and_retains_completion() {
        let readiness = StorageReadiness::default();
        let completion = async {
            tokio::task::yield_now().await;
            readiness.result.send_replace(Some(Ok(())));
        };
        let (first, second, _) = tokio::join!(
            readiness.wait(std::time::Duration::from_secs(1)),
            readiness.wait(std::time::Duration::from_secs(1)),
            completion,
        );
        assert!(first.is_ok());
        assert!(second.is_ok());
        assert!(readiness.wait(std::time::Duration::from_secs(1)).await.is_ok());
    }

    #[tokio::test]
    async fn storage_readiness_preserves_failure_without_reporting_ready() {
        let readiness = StorageReadiness::default();
        readiness.result.send_replace(Some(Err("存储初始化失败".into())));
        assert_eq!(readiness.wait(std::time::Duration::from_secs(1)).await.unwrap_err(), "存储初始化失败");
        assert_eq!(readiness.wait(std::time::Duration::from_secs(1)).await.unwrap_err(), "存储初始化失败");
    }

    #[tokio::test]
    async fn storage_readiness_timeout_does_not_cancel_initialization() {
        let readiness = StorageReadiness::default();
        assert!(readiness.wait(std::time::Duration::from_millis(1)).await.is_err());
        assert!(readiness.result.borrow().is_none());
        readiness.result.send_replace(Some(Ok(())));
        assert!(readiness.wait(std::time::Duration::from_secs(1)).await.is_ok());
    }

    #[test]
    fn operation_roots_keep_default_selected_and_explicit_scopes_separate() {
        let root = std::env::temp_dir();
        let default = root.join("hcmcl-default-fixture");
        let selected = root.join("hcmcl-selected-fixture");
        let settings = json!({"gameDirAbs":default,"selectedVersionDirId":"other","versionDirs":[{"id":"other","path":selected}]});
        assert_eq!(operation_game_dir("versions:get", &[], &settings).unwrap(), selected);
        assert_eq!(operation_game_dir("download:install", &[json!("1.21.1")], &settings).unwrap(), selected);
        assert_eq!(operation_game_dir("download:install", &[json!("1.21.1"),json!("default")], &settings).unwrap(), default);
        assert_eq!(operation_game_dir("versions:createVanilla", &[json!("1.21.1"),json!("named"),json!("other")], &settings).unwrap(), selected);
        assert_eq!(operation_game_dir("modpack:import", &[json!("source.zip"), Value::Null, json!("default")], &settings).unwrap(), default);
        assert_eq!(operation_game_dir("modpack:import", &[json!("source.zip"), json!("named"), json!("other")], &settings).unwrap(), selected);
        assert_eq!(operation_game_dir("modpack:importFromUrl", &[json!("https://example.invalid/a.zip"), json!("a.zip"), Value::Null, json!("default")], &settings).unwrap(), default);
        assert!(operation_game_dir("modpack:import", &[json!("source.zip"), Value::Null, json!("missing")], &settings).is_err());
        assert!(operation_game_dir("modpack:importFromUrl", &[json!("https://example.invalid/a.zip"), json!("a.zip"), Value::Null, json!(true)], &settings).is_err());
        assert_eq!(operation_game_dir("loaders:install", &[json!("fabric"),json!("1.21.1"),json!("0.16.9"),Value::Null,json!("default")], &settings).unwrap(), default);
        assert_eq!(operation_game_dir("forge:install", &[json!("forge"),json!("1.21.1"),json!("52.0.0"),json!("named"),json!(true),json!("default")], &settings).unwrap(), default);
        assert!(operation_game_dir("forge:install", &[Value::Null,Value::Null,Value::Null,Value::Null,Value::Null,json!("missing")], &settings).is_err());
        assert!(operation_game_dir("forge:install", &[Value::Null,Value::Null,Value::Null,Value::Null,Value::Null,json!(true)], &settings).is_err());
        assert_eq!(operation_game_dir("mods:install", &[json!("https://cdn.modrinth.com/data/project/versions/version/mod.jar"),json!("mod.jar"),json!("named"),json!("mod"),json!(10),json!("default")], &settings).unwrap(), default);
        assert!(operation_game_dir("mods:install", &[Value::Null,Value::Null,Value::Null,Value::Null,Value::Null,json!("missing")], &settings).is_err());
        assert!(operation_game_dir("download:install", &[json!("1.21.1"),json!("missing")], &settings).is_err());
        assert!(operation_game_dir("download:install", &[json!("1.21.1"),json!(true)], &settings).is_err());
        let bad = json!({"gameDirAbs":"relative","selectedVersionDirId":"","versionDirs":[]});
        assert!(operation_game_dir("download:install", &[], &bad).is_err());
    }

    #[test]
    fn channels_are_exact_and_separated() {
        // types.ts 全量 217 = 公开 214 + 3 个内部通道（ai:voiceState / mp:hudState / mp:miniDrag）。
        assert_eq!(CALL_CHANNELS.len(), 217);
        assert_eq!(CALL_CHANNELS.iter().filter(|channel| !["ai:voiceState", "mp:hudState", "mp:miniDrag"].contains(channel)).count(), 214);
        assert_eq!(SEND_CHANNELS.len(), 2);
        assert!(validate_request("settings:get", &[], CALL_CHANNELS).is_ok());
        assert!(validate_request("arbitrary:exec", &[], CALL_CHANNELS).is_err());
        assert!(validate_request("debug:rendererLog", &[], CALL_CHANNELS).is_err());
    }
}

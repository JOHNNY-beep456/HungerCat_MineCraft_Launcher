//! 官方资源更新计划的原生确认；票据只留在宿主工作任务内，不增加 IPC 授权字段。
use crate::catalog::{pack_bound_metadata, update::{PlannedChange, PreparedUpdate, VerifiedFile}};
use std::{sync::{atomic::{AtomicBool, Ordering}, Arc}, time::{Duration, Instant}};
use tauri::{AppHandle, Manager, WebviewWindow};
use tokio::sync::oneshot;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use raw_window_handle::{DisplayHandle, HandleError, HasDisplayHandle, HasWindowHandle, WindowHandle};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

type Result<T> = std::result::Result<T, String>;
const MAX_CHANGES: usize = 32;
const MAX_LABEL_BYTES: usize = 1024;
const MAX_PATH_BYTES: usize = 32768;
const MAX_MESSAGE_BYTES: usize = 24000;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const APPROVAL_TTL: Duration = Duration::from_secs(180);

#[derive(Clone, Copy)]
enum Locale { Cn, Tw, En }
impl Locale {
    fn text(self, cn: &str, tw: &str, en: &str) -> String {
        match self { Self::Cn => cn, Self::Tw => tw, Self::En => en }.into()
    }
    fn invalid(self) -> String { self.text("更新确认计划无效、字段缺失或超出完整显示限制", "更新確認計畫無效、欄位缺失或超出完整顯示限制", "The update approval plan is invalid, incomplete, or too large to display in full") }
    fn stopped(self) -> String { self.text("更新确认已取消或主窗口已失效", "更新確認已取消或主視窗已失效", "Update approval was cancelled or the main window is no longer valid") }
    fn refused(self) -> String { self.text("未批准此资源更新计划", "未批准此資源更新計畫", "The resource update plan was not approved") }
    fn expired(self) -> String { self.text("资源更新确认已过期，请重新检查更新并确认", "資源更新確認已過期，請重新檢查更新並確認", "Resource update approval has expired; check for updates again and confirm") }
}
fn locale(app: &AppHandle) -> Locale {
    let language = app.try_state::<crate::storage::Storage>()
        .and_then(|storage| storage.call("settings:get", &[]).ok().flatten())
        .and_then(|settings| settings.get("language").and_then(serde_json::Value::as_str).map(str::to_owned))
        .unwrap_or_else(|| "zh-CN".into());
    if language == "en" || language.starts_with("en-") || language.starts_with("en_") { Locale::En }
    else if language == "zh-TW" || language.starts_with("zh_TW") || language.starts_with("zh-HK") { Locale::Tw }
    else { Locale::Cn }
}

fn binding_digest(binding: &str, language: Locale) -> Result<[u8; 32]> {
    if binding.len() != 64 || !binding.bytes().all(|v| v.is_ascii_hexdigit()) { return Err(language.invalid()); }
    let mut digest = [0; 32];
    for (index, pair) in binding.as_bytes().chunks_exact(2).enumerate() {
        let digit = |v: u8| match v { b'0'..=b'9' => v-b'0', b'a'..=b'f' => v-b'a'+10, b'A'..=b'F' => v-b'A'+10, _ => unreachable!() };
        digest[index] = digit(pair[0]) * 16 + digit(pair[1]);
    }
    Ok(digest)
}
fn check(cancel: &AtomicBool, alive: &AtomicBool, language: Locale) -> Result<()> {
    if cancel.load(Ordering::Acquire) || !alive.load(Ordering::Acquire) { Err(language.stopped()) } else { Ok(()) }
}

/// 不实现 Clone、序列化或外部构造；consume 按值取得票据，单个票据不能重复使用。
pub(super) struct Approval { digest: [u8; 32], alive: Arc<AtomicBool>, language: Locale, approved_at: Instant }
impl Approval {
    pub(super) fn consume(self, binding: &str, cancel: &AtomicBool) -> Result<()> {
        self.consume_at(binding, cancel, Instant::now())
    }
    fn consume_at(self, binding: &str, cancel: &AtomicBool, now: Instant) -> Result<()> {
        check(cancel, &self.alive, self.language)?;
        if self.digest != binding_digest(binding, self.language)? { return Err(self.language.invalid()); }
        // 只在提交前判定确认后的单调时效；不限制用户阅读对话框，也不为慢下载续期。
        let elapsed = now.checked_duration_since(self.approved_at).ok_or_else(|| self.language.expired())?;
        if elapsed >= APPROVAL_TTL { return Err(self.language.expired()); }
        check(cancel, &self.alive, self.language)
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
struct CheckedParent<'a> { window: WindowHandle<'a>, display: DisplayHandle<'a> }
#[cfg(not(any(target_os = "android", target_os = "ios")))]
impl HasWindowHandle for CheckedParent<'_> {
    fn window_handle(&self) -> std::result::Result<WindowHandle<'_>, HandleError> { Ok(self.window) }
}
#[cfg(not(any(target_os = "android", target_os = "ios")))]
impl HasDisplayHandle for CheckedParent<'_> {
    fn display_handle(&self) -> std::result::Result<DisplayHandle<'_>, HandleError> { Ok(self.display) }
}

struct MainWindow { app: AppHandle, window: WebviewWindow, alive: Arc<AtomicBool> }
impl MainWindow {
    fn capture(app: &AppHandle, cancel: &AtomicBool, language: Locale) -> Result<Self> {
        let window = app.get_webview_window("main").ok_or_else(|| language.stopped())?;
        let alive = Arc::new(AtomicBool::new(true));
        let weak = Arc::downgrade(&alive);
        // 事件钩子不强持有任务、票据或窗口；旧窗口关闭后，同名新窗口不能复活旧票据。
        window.on_window_event(move |event| {
            if crate::invalidates_main_window(event) {
                if let Some(alive) = weak.upgrade() { alive.store(false, Ordering::Release); }
            }
        });
        let guard = Self { app: app.clone(), window, alive };
        guard.verify(cancel, language)?;
        Ok(guard)
    }
    fn verify(&self, cancel: &AtomicBool, language: Locale) -> Result<()> {
        check(cancel, &self.alive, language)?;
        if self.app.get_webview_window("main").is_none() || self.window.is_visible().is_err() { return Err(language.stopped()); }
        check(cancel, &self.alive, language)
    }
}

fn label(value: &str, limit: usize, language: Locale) -> Result<String> {
    // 原生对话框只显示经过核验的字段，不允许控制字符或方向覆盖伪造下一行动作。
    if value.is_empty() || value.len() > limit || value.chars().any(|c| c.is_control()
        || matches!(c, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{2028}' | '\u{2029}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')) {
        return Err(language.invalid());
    }
    Ok(value.into())
}
fn filename(value: &str, language: Locale) -> Result<String> {
    let name = label(value, MAX_LABEL_BYTES, language)?;
    if name == "." || name == ".." || name.contains(['/', '\\']) { return Err(language.invalid()); }
    Ok(name)
}
fn size(value: u64, language: Locale) -> Result<u64> {
    if value == 0 || value > MAX_FILE_BYTES { Err(language.invalid()) } else { Ok(value) }
}
fn kind(value: &str, language: Locale) -> Result<String> {
    match value {
        "mod" => Ok(language.text("模组", "模組", "Mod")),
        "resourcepack" => Ok(language.text("资源包", "資源包", "Resource pack")),
        "shader" => Ok(language.text("光影", "光影", "Shader")),
        _ => Err(language.invalid()),
    }
}
struct FileRow { kind: String, source: String, title: String, version: String, filename: String, size: u64 }
fn official(file: &VerifiedFile, language: Locale) -> Result<FileRow> {
    let meta = pack_bound_metadata(&file.download);
    let source = match file.source.as_str() { "modrinth" => "Modrinth", "curseforge" => "CurseForge", _ => return Err(language.invalid()) };
    label(&file.project_id, MAX_LABEL_BYTES, language)?;
    label(&file.version_id, MAX_LABEL_BYTES, language)?;
    Ok(FileRow { kind: kind(meta.kind, language)?, source: source.into(), title: label(&file.title, MAX_LABEL_BYTES, language)?,
        version: label(&file.version, MAX_LABEL_BYTES, language)?, filename: filename(&meta.filename, language)?, size: size(meta.size, language)? })
}
struct OldRow { kind: String, path: String, filename: String, size: u64 }
fn local(old: &super::model::LocalQuery, language: Locale) -> Result<OldRow> {
    Ok(OldRow { kind: kind(old.kind.as_str(), language)?, path: label(old.path.to_str().ok_or_else(|| language.invalid())?, MAX_PATH_BYTES, language)?,
        filename: filename(&old.filename, language)?, size: size(old.size, language)? })
}
enum Row { Install(FileRow), Replace(OldRow, FileRow), Enable(OldRow) }
struct MainRow { old_version: String, old: OldRow, new: FileRow }
fn project(prepared: &PreparedUpdate, language: Locale) -> Result<(MainRow, Vec<Row>)> {
    if prepared.changes.is_empty() || prepared.changes.len() > MAX_CHANGES { return Err(language.invalid()); }
    let PlannedChange::Replace { old, file } = &prepared.changes[0] else { return Err(language.invalid()); };
    let meta = pack_bound_metadata(&file.download);
    let requested = &prepared.requested;
    if old.path.to_str() != Some(requested.path.as_str()) || old.kind != requested.kind || meta.kind != requested.kind.as_str()
        || file.title != requested.title || file.version != requested.latest_version || meta.filename != requested.filename || meta.size != requested.size {
        return Err(language.invalid());
    }
    let main = MainRow { old_version: label(&requested.current_version, MAX_LABEL_BYTES, language)?, old: local(old, language)?, new: official(file, language)? };
    let mut rows = Vec::with_capacity(prepared.changes.len()-1);
    for change in &prepared.changes[1..] {
        rows.push(match change {
            PlannedChange::Install { file } => Row::Install(official(file, language)?),
            PlannedChange::Replace { old, file } => {
                if old.kind.as_str() != pack_bound_metadata(&file.download).kind { return Err(language.invalid()); }
                Row::Replace(local(old, language)?, official(file, language)?)
            }
            PlannedChange::Enable { old } => {
                if old.enabled { return Err(language.invalid()); }
                Row::Enable(local(old, language)?)
            }
        });
    }
    Ok((main, rows))
}
fn file_text(file: &FileRow, language: Locale) -> String {
    format!("{} | {} | {}\n{}: {}\n{}: {} | {} {}", file.kind, file.source, file.title,
        language.text("版本", "版本", "Version"), file.version, language.text("文件", "檔案", "File"), file.filename, file.size,
        language.text("字节", "位元組", "bytes"))
}
fn old_text(old: &OldRow, language: Locale) -> String {
    format!("{} | {} | {} {}\n{}: {}", old.kind, old.filename, old.size, language.text("字节", "位元組", "bytes"),
        language.text("本地路径", "本機路徑", "Local path"), old.path)
}
fn render(main: &MainRow, rows: &[Row], language: Locale) -> Result<String> {
    if rows.len() + 1 > MAX_CHANGES { return Err(language.invalid()); }
    let mut message = format!("{}\n\n{}: {} → {}\n{}\n{}\n\n{} ({})",
        language.text("主资源更新会同时应用下列全部变更。仅在同意整份计划时确认。", "主資源更新會同時套用下列全部變更。僅在同意整份計畫時確認。", "The main resource update will apply every change below. Confirm only if you approve the entire plan."),
        language.text("主项替换", "主項替換", "Main replacement"), main.old_version, main.new.version, old_text(&main.old, language), file_text(&main.new, language),
        language.text("额外变更", "額外變更", "Additional changes"), rows.len());
    for (index, row) in rows.iter().enumerate() {
        let text = match row {
            Row::Install(file) => format!("{}\n{}", language.text("安装", "安裝", "Install"), file_text(file, language)),
            Row::Replace(old, file) => format!("{}\n{}\n→ {}", language.text("替换", "替換", "Replace"), old_text(old, language), file_text(file, language)),
            Row::Enable(old) => format!("{} | local\n{}: {}\n{}: {}\n{}\n{}: {}",
                language.text("启用", "啟用", "Enable"), language.text("标题", "標題", "Title"), old.filename,
                language.text("版本", "版本", "Version"), language.text("未知（仅本地已安装身份）", "未知（僅本機已安裝身分）", "Unknown (local installed identity only)"),
                old_text(old, language), language.text("来源", "來源", "Source"), "local"),
        };
        message.push_str(&format!("\n\n{}. {}", index+1, text));
        // 超限拒绝整份计划，不省略或截断任何动作。
        if message.len() > MAX_MESSAGE_BYTES { return Err(language.invalid()); }
    }
    if message.len() > MAX_MESSAGE_BYTES { Err(language.invalid()) } else { Ok(message) }
}

async fn callback_result(receiver: oneshot::Receiver<(bool, Instant)>, cancel: &AtomicBool, alive: &AtomicBool, language: Locale) -> Result<Instant> {
    // 不使用超时、select 或取消分支提前丢弃 receiver；宿主须持有生命周期 Request 等待真实回调收尾。
    let (approved, approved_at) = receiver.await.map_err(|_| language.refused())?;
    check(cancel, alive, language)?;
    if !approved { return Err(language.refused()); }
    // 使用原生回调时刻，不能以异步任务恢复时刻延长有效期。
    Ok(approved_at)
}

/// binding 由宿主在工作任务内计算，覆盖完整计划、根、策略、来源和本次主窗口身份。
/// 无额外动作沿用原有主项批准；任何额外动作必须取得整份计划的原生批准。
pub(super) async fn approve(app: &AppHandle, prepared: &PreparedUpdate, binding: &str, cancel: Arc<AtomicBool>) -> Result<Approval> {
    let language = locale(app);
    let digest = binding_digest(binding, language)?;
    let (main_row, rows) = project(prepared, language)?;
    let message = render(&main_row, &rows, language)?;
    let main = MainWindow::capture(app, &cancel, language)?;
    let approved_at = if !rows.is_empty() {
        #[cfg(any(target_os = "android", target_os = "ios"))]
        {
            let _ = message;
            return Err(language.text("此移动端暂不支持有主窗口亲本的依赖更新确认，未应用任何变更", "此行動端暫不支援以主視窗為親本的相依更新確認，未套用任何變更", "This mobile platform does not support a main-window-parented dependency approval; no changes were applied"));
        }
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            // 插件 parent() 遇到句柄错误会静默忽略；提前核验两者，失败时禁止无亲本继续。
            let (sender, receiver) = oneshot::channel();
            {
                let parent = CheckedParent {
                    window: main.window.window_handle().map_err(|_| language.stopped())?,
                    display: main.window.display_handle().map_err(|_| language.stopped())?,
                };
                main.verify(&cancel, language)?;
                // parent() 从同一份已检查借用句柄复制亲本，不再次查询可能失败的运行时句柄。
                app.dialog().message(message)
                    .title(language.text("确认资源更新计划", "確認資源更新計畫", "Approve resource update plan"))
                    .kind(MessageDialogKind::Warning).buttons(MessageDialogButtons::OkCancel)
                    .parent(&parent).show(move |yes| { let approved_at = Instant::now(); let _ = sender.send((yes, approved_at)); });
            }
            callback_result(receiver, &cancel, &main.alive, language).await?
        }
    } else {
        // 无额外动作沿用主项批准，从本次票据签发计时，不假定原始点击时刻。
        main.verify(&cancel, language)?;
        Instant::now()
    };
    main.verify(&cancel, language)?;
    Ok(Approval { digest, alive: main.alive, language, approved_at })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn alive() -> Arc<AtomicBool> { Arc::new(AtomicBool::new(true)) }
    fn ticket_at(binding: &str, alive: Arc<AtomicBool>, approved_at: Instant) -> Approval { Approval { digest: binding_digest(binding, Locale::En).unwrap(), alive, language: Locale::En, approved_at } }
    fn ticket(binding: &str, alive: Arc<AtomicBool>) -> Approval { ticket_at(binding, alive, Instant::now()) }
    fn old(name: &str) -> OldRow { OldRow { kind: "Mod".into(), path: format!("/fixture/mods/{name}"), filename: name.into(), size: 12 } }
    fn file(name: &str) -> FileRow { FileRow { kind: "Mod".into(), source: "Modrinth".into(), title: "Fixture".into(), version: "2.0".into(), filename: name.into(), size: 24 } }
    fn main_row() -> MainRow { MainRow { old_version: "1.0".into(), old: old("main-old.jar"), new: file("main-new.jar") } }

    #[test]
    fn ticket_accepts_only_exact_sha256_binding_and_consumes_by_value() {
        let cancel = AtomicBool::new(false);
        ticket(&"a".repeat(64), alive()).consume(&"A".repeat(64), &cancel).unwrap();
        assert!(ticket(&"a".repeat(64), alive()).consume(&"b".repeat(64), &cancel).is_err());
        for malformed in ["", "abcd", &"g".repeat(64), &"a".repeat(65)] { assert!(binding_digest(malformed, Locale::En).is_err()); }
    }
    #[test]
    fn ticket_rejects_cancellation_or_window_close_after_approval() {
        let cancel = AtomicBool::new(false);
        let live = alive(); let approved = ticket(&"1".repeat(64), live.clone());
        live.store(false, Ordering::Release);
        assert!(approved.consume(&"1".repeat(64), &cancel).is_err());
        let approved = ticket(&"1".repeat(64), alive());
        cancel.store(true, Ordering::Release);
        assert!(approved.consume(&"1".repeat(64), &cancel).is_err());
    }
    #[test]
    fn approval_ttl_accepts_only_strictly_less_than_180_seconds() {
        let at = Instant::now() + APPROVAL_TTL;
        let cancel = AtomicBool::new(false); let binding = "a".repeat(64);
        ticket_at(&binding, alive(), at).consume_at(&binding, &cancel, at).unwrap();
        // Windows 单调时钟不保证表达 1 ns 差值；用可表示间隔验证边界两侧。
        ticket_at(&binding, alive(), at).consume_at(&binding, &cancel, at + APPROVAL_TTL - Duration::from_millis(1)).unwrap();
        for now in [at + APPROVAL_TTL, at + APPROVAL_TTL + Duration::from_millis(1), at - Duration::from_millis(1)] {
            assert_eq!(ticket_at(&binding, alive(), at).consume_at(&binding, &cancel, now).unwrap_err(), Locale::En.expired());
        }
    }
    #[test]
    fn expired_approval_requires_recheck_and_confirmation_in_each_locale() {
        let at = Instant::now(); let cancel = AtomicBool::new(false); let binding = "b".repeat(64);
        for language in [Locale::Cn, Locale::Tw, Locale::En] {
            let approved = Approval { digest: binding_digest(&binding, language).unwrap(), alive: alive(), language, approved_at: at };
            assert_eq!(approved.consume_at(&binding, &cancel, at + APPROVAL_TTL).unwrap_err(), language.expired());
        }
    }
    #[tokio::test]
    async fn callback_timestamp_excludes_reading_time_and_never_renews_on_resume() {
        let cancel = AtomicBool::new(false); let live = alive(); let binding = "c".repeat(64);
        let shown_at = Instant::now();
        let confirmed_at = shown_at + APPROVAL_TTL + Duration::from_secs(600);
        let (sender, receiver) = oneshot::channel(); sender.send((true, confirmed_at)).unwrap();
        let approved_at = callback_result(receiver, &cancel, &live, Locale::En).await.unwrap();
        assert_eq!(approved_at, confirmed_at);
        ticket_at(&binding, live.clone(), approved_at).consume_at(&binding, &cancel, confirmed_at + Duration::from_secs(1)).unwrap();
        // 即使异步任务在确认很久后才恢复，也保留回调时间，不能重新签发延寿。
        let (sender, receiver) = oneshot::channel(); sender.send((true, confirmed_at)).unwrap();
        let resumed_at = confirmed_at + APPROVAL_TTL;
        let approved_at = callback_result(receiver, &cancel, &live, Locale::En).await.unwrap();
        assert!(ticket_at(&binding, live, approved_at).consume_at(&binding, &cancel, resumed_at).is_err());
    }
    #[test]
    fn full_plan_shows_every_action_and_does_not_guess_enable_metadata() {
        let rows = vec![Row::Install(file("add.jar")), Row::Replace(old("replace-old.jar"), file("replace-new.jar")), Row::Enable(old("local.jar.disabled"))];
        for language in [Locale::Cn, Locale::Tw, Locale::En] {
            let text = render(&main_row(), &rows, language).unwrap();
            for name in ["main-old.jar", "main-new.jar", "add.jar", "replace-old.jar", "replace-new.jar", "local.jar.disabled", "local", "12", "24", "1.0", "2.0"] { assert!(text.contains(name), "{name}"); }
            assert!(text.contains(&language.text("未知（仅本地已安装身份）", "未知（僅本機已安裝身分）", "Unknown (local installed identity only)")));
        }
    }
    #[test]
    fn oversized_or_spoofed_fields_fail_without_truncating_actions() {
        for text in ["", "line\nnext", "\u{202e}spoof", "\u{2066}spoof"] { assert!(label(text, MAX_LABEL_BYTES, Locale::En).is_err()); }
        assert!(label(&"x".repeat(MAX_LABEL_BYTES+1), MAX_LABEL_BYTES, Locale::En).is_err());
        assert!(filename("../outside.jar", Locale::En).is_err());
        let too_many: Vec<_> = (0..MAX_CHANGES).map(|_| Row::Install(file("add.jar"))).collect();
        assert!(render(&main_row(), &too_many, Locale::En).is_err());
        let mut long_main = main_row(); long_main.old.path = "x".repeat(MAX_MESSAGE_BYTES);
        assert!(render(&long_main, &[], Locale::En).is_err());
    }
    #[tokio::test]
    async fn cancelled_dialog_waits_for_real_callback_then_rejects_late_yes() {
        let cancel = Arc::new(AtomicBool::new(false)); let live = alive();
        let (sender, receiver) = oneshot::channel(); let (started_tx, started_rx) = oneshot::channel();
        let task_cancel = cancel.clone(); let task_live = live.clone();
        let task = tokio::spawn(async move { started_tx.send(()).unwrap(); callback_result(receiver, &task_cancel, &task_live, Locale::En).await });
        started_rx.await.unwrap(); cancel.store(true, Ordering::Release);
        tokio::task::yield_now().await; assert!(!task.is_finished());
        sender.send((true, Instant::now())).unwrap(); assert!(task.await.unwrap().is_err());
    }
    #[tokio::test]
    async fn callback_drop_refusal_and_closed_window_never_authorize() {
        let cancel = AtomicBool::new(false); let live = alive();
        let (sender, receiver) = oneshot::channel(); drop(sender);
        assert!(callback_result(receiver, &cancel, &live, Locale::En).await.is_err());
        let (sender, receiver) = oneshot::channel(); sender.send((false, Instant::now())).unwrap();
        assert!(callback_result(receiver, &cancel, &live, Locale::En).await.is_err());
        let (sender, receiver) = oneshot::channel(); live.store(false, Ordering::Release); sender.send((true, Instant::now())).unwrap();
        assert!(callback_result(receiver, &cancel, &live, Locale::En).await.is_err());
        let live = alive(); let (sender, receiver) = oneshot::channel(); sender.send((true, Instant::now())).unwrap();
        callback_result(receiver, &cancel, &live, Locale::En).await.unwrap();
    }
}

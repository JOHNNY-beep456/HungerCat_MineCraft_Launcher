//! 业务命令还需主文档持有的随机标记；不透明主页 iframe 不继承此标记。
use tauri::ipc::Invoke;
pub(crate) struct DocumentAccess { token: String }
impl DocumentAccess {
    pub(crate) fn new() -> Self { Self { token: format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()) } }
    pub(crate) fn script(&self) -> String {
        // Tauri 将 invoke 初始化限定为主 frame；再核验固定应用源，远端错误页不能得到标记。
        let token = serde_json::to_string(&self.token).expect("随机十六进制标记");
        format!(r#";(function(){{if(window!==window.top)return;var u=new URL(location.href);var app=(u.protocol==='tauri:'&&u.hostname==='localhost')||((u.protocol==='http:'||u.protocol==='https:')&&u.hostname==='tauri.localhost');var dev={}&&u.protocol==='http:'&&(u.hostname==='localhost'||u.hostname==='127.0.0.1')&&u.port==='1420';if(app||dev)Object.defineProperty(window,'__HC_NATIVE_DOCUMENT__',{{value:{token}}});}})();"#, cfg!(debug_assertions))
    }
    fn accepts(&self, value: Option<&str>) -> bool { value == Some(self.token.as_str()) }
    pub(crate) fn authorize(&self, invoke: &Invoke) -> bool {
        self.accepts(invoke.message.headers().get("x-hcmcl-document").and_then(|v| v.to_str().ok()))
    }
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn subframe_cannot_reuse_missing_wrong_or_previous_process_marker() {
        let first=DocumentAccess::new(); let second=DocumentAccess::new();
        assert!(!first.accepts(None)); assert!(!first.accepts(Some(""))); assert!(!first.accepts(Some(&second.token)));
        assert!(first.accepts(Some(&first.token))); assert!(first.script().contains("window!==window.top"));
    }
}

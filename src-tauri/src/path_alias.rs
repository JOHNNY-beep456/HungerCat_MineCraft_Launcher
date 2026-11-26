//! Android 应用私有存储的祖先别名策略。
//!
//! Android 的私有目录由系统维护：`/data/user/0`、`/data/data`、`/storage/emulated/0`
//! 之间存在系统级软链接（同一目录的多种写法），并且 `/data` 这类祖先只有执行权限、
//! 没有读权限。启动器只对自己创建的后代负责，因此在这些平台上只对「路径末级」
//! 保持禁止链接的严格校验；桌面平台仍然逐级拒绝。

/// 祖先前缀里的软链接是否可容忍（只为当前移动平台放开）。
pub(crate) fn ancestor_alias_allowed() -> bool {
    cfg!(target_os = "android")
}

/// 逐级校验时，当前组件是否必须严格拒绝软链接。
///
/// `final_segment` 为真表示这是被校验路径的最后一级（启动器自己创建的文件/目录），
/// 任何平台都拒绝；祖先级只在桌面平台拒绝。
pub(crate) fn link_is_fatal(final_segment: bool) -> bool {
    final_segment || !ancestor_alias_allowed()
}

/// 逐级校验失败后的兜底：把整条路径规范化一次再复核。
///
/// 系统别名也可能落在被校验路径的末级（例如应用目录本身就以软链接形式给出），
/// 只在本平台允许别名且规范化确实改变了写法时返回，桌面平台始终返回 `None`。
pub(crate) fn resolved_alias(path: &std::path::Path) -> Option<std::path::PathBuf> {
    if !ancestor_alias_allowed() { return None; }
    let canonical = std::fs::canonicalize(path).ok()?;
    if canonical.is_absolute() && canonical != path { Some(canonical) } else { None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    // 桌面平台的安全语义不能因为移动端放宽而被稀释。
    #[test]
    fn desktop_rejects_links_on_every_segment_and_never_resolves_aliases() {
        if cfg!(target_os = "android") { return; }
        assert!(!ancestor_alias_allowed());
        assert!(link_is_fatal(true));
        assert!(link_is_fatal(false));
        assert!(resolved_alias(Path::new("/tmp")).is_none());
    }
}

//! 目录选择权限只绑定已打开的目录身份，不把路径文本当成授权。
use std::path::{Path, PathBuf};
type Result<T> = std::result::Result<T, String>;
#[path = "modpack/access.rs"]
mod access;

#[derive(Clone)]
pub(super) struct Grant(access::DirectoryMark);
impl Grant {
    pub(super) fn capture(path: &Path) -> Result<(PathBuf, Self)> {
        let directory = access::Directory::open(path)?;
        let path = directory.path().to_path_buf();
        Ok((path, Self(directory.mark())))
    }
    pub(super) fn verify(&self) -> Result<()> { self.0.verify() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    struct Temporary(PathBuf);
    impl Temporary {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("hcmcl-directory-grant-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            // 目录锚支持 Windows 的绝对盘符与 verbatim 盘符，不支持 UNC。
            Self(fs::canonicalize(path).unwrap())
        }
    }
    impl Drop for Temporary { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    #[test]
    fn grant_accepts_member_changes_but_rejects_directory_replacement() {
        let temp = Temporary::new(); let selected = temp.0.join("selected");
        fs::create_dir(&selected).unwrap();
        let (_, grant) = Grant::capture(&selected).unwrap();
        fs::write(selected.join("new.json"), b"{}").unwrap();
        grant.verify().unwrap();
        fs::rename(&selected, temp.0.join("original")).unwrap();
        fs::create_dir(&selected).unwrap();
        assert!(grant.verify().is_err());
    }
    #[test]
    fn grant_rejects_ancestor_replacement_and_non_directory_inputs() {
        let temp = Temporary::new(); let ancestor = temp.0.join("ancestor");
        let selected = ancestor.join("selected"); fs::create_dir_all(&selected).unwrap();
        let (_, grant) = Grant::capture(&selected).unwrap();
        fs::rename(&ancestor, temp.0.join("original")).unwrap();
        fs::create_dir_all(&selected).unwrap();
        assert!(grant.verify().is_err());
        assert!(Grant::capture(Path::new("relative")).is_err());
        fs::write(temp.0.join("file"), b"x").unwrap();
        assert!(Grant::capture(&temp.0.join("file")).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn grant_rejects_symbolic_directory_links() {
        use std::os::unix::fs::symlink;
        let temp = Temporary::new(); fs::create_dir(temp.0.join("target")).unwrap();
        symlink(temp.0.join("target"), temp.0.join("link")).unwrap();
        assert!(Grant::capture(&temp.0.join("link")).is_err());
    }
}

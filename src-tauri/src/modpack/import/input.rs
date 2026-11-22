//! 生产只包装受控 Source；测试入口只在 cfg(test) 下接受合成临时文件。
use super::{Result, Source, Cancel};
use std::{fs::File, sync::{Arc, Mutex}};

pub(super) enum Input {
    Controlled(Mutex<Option<Source>>),
    #[cfg(test)]
    Fixture { opened: Arc<Mutex<Option<super::super::access::OpenedFile>>>, name: String, allowed: Arc<std::sync::atomic::AtomicBool> },
}
impl Input {
    pub(super) fn controlled(source: Source) -> Self { Self::Controlled(Mutex::new(Some(source))) }
    pub(super) fn check(&self, cancel: &Cancel) -> Result<()> {
        cancel.check()?;
        match self {
            Self::Controlled(slot) => slot.lock().map_err(|_| "来源状态不可用")?.as_ref().ok_or("来源已收尾")?.check(cancel),
            #[cfg(test)]
            Self::Fixture { opened, allowed, .. } => {
                if !allowed.load(std::sync::atomic::Ordering::Acquire) { return Err("夹具来源授权已撤销".into()); }
                opened.lock().map_err(|_| "夹具来源不可用")?.as_ref().ok_or("夹具来源已关闭")?.verify()
            }
        }
    }
    pub(super) async fn read<T: Send + 'static>(&self, cancel: Arc<Cancel>, read: impl FnOnce(&mut File, &str, &Cancel) -> Result<T> + Send + 'static) -> Result<T> {
        match self {
            Self::Controlled(slot) => {
                let future = slot.lock().map_err(|_| "来源状态不可用")?.as_ref().ok_or("来源已收尾")?.read(cancel, read);
                future.await
            }
            #[cfg(test)]
            Self::Fixture { opened, name, allowed } => {
                let opened = opened.clone(); let name = name.clone(); let allowed = allowed.clone();
                tokio::task::spawn_blocking(move || {
                    use std::io::{Seek, SeekFrom};
                    cancel.check()?;
                    if !allowed.load(std::sync::atomic::Ordering::Acquire) { return Err("夹具来源授权已撤销".into()); }
                    let mut slot = opened.lock().map_err(|_| "夹具来源不可用")?;
                    let opened = slot.as_mut().ok_or("夹具来源已关闭")?;
                    opened.verify()?; opened.file.seek(SeekFrom::Start(0)).map_err(|_| "夹具来源定位失败")?;
                    let result = read(&mut opened.file, &name, &cancel);
                    cancel.check()?; opened.verify()?;
                    if !allowed.load(std::sync::atomic::Ordering::Acquire) { return Err("夹具来源授权已撤销".into()); }
                    result
                }).await.map_err(|_| "夹具来源后台异常，状态未知".to_owned())?
            }
        }
    }
    pub(super) async fn finish(&self) -> Result<()> {
        match self {
            Self::Controlled(slot) => {
                let source = slot.lock().map_err(|_| "来源状态不可用")?.take().ok_or("来源已收尾")?;
                source.finish().await
            }
            #[cfg(test)]
            Self::Fixture { opened, .. } => {
                let opened = opened.clone();
                tokio::task::spawn_blocking(move || {
                    let file = opened.lock().map_err(|_| "夹具来源不可用")?.take().ok_or("夹具来源已关闭")?;
                    drop(file); Ok(())
                }).await.map_err(|_| "夹具来源收尾后台异常".to_owned())?
            }
        }
    }
}

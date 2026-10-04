// ---------------------------------------------------------------------------
// 文件夹扫描（原生加速）
//
// 与传输层的边界：这里只做**通用文件系统扫描**，不理解 Minecraft 语义。
//   * `scan_files`：列出一个目录下的文件（可选按扩展名过滤、可识别 `.disabled` 后缀），
//     并**并行**读取每个文件的大小；
//   * `scan_dirs` ：列出一个目录下的子目录，但只保留「内部存在指定标记文件」的那些
//     （例如存档须有 `level.dat`、版本目录须有 `<目录名>.json`）。
//
// 为什么下沉到 Rust：TS 侧的 `readdir + 逐文件 stat` 受 libuv 线程池（默认 4 线程）
// 限制，几百上千个文件时会串成瓶颈；原生侧用 tokio 的文件 IO + `buffer_unordered`
// 并行取元数据，且不占用 Node 事件循环。
//
// 排序刻意**留在 TS 侧**：JS 的 `Array.prototype.sort` 按 UTF-16 码元比较，而 Rust
// 按 UTF-8 字节比较，对中文等非 ASCII 名称结果不同；由 TS 统一排序可保证与旧版本
// 完全一致的展示顺序（兼容性要求）。
// ---------------------------------------------------------------------------

use std::path::PathBuf;

use futures_util::StreamExt;
use napi::bindgen_prelude::{AsyncTask, BigInt, Error, Result};
use napi::{Env, Task};
use napi_derive::napi;

use crate::runtime;

/// 单个并行取元数据的最大并发。太高会打爆文件句柄，太低又退化成串行。
const STAT_CONCURRENCY: usize = 64;

/// 扫描到的一个文件条目（字段名经 napi 自动转为 camelCase）。
#[napi(object)]
pub struct ScannedFile {
    /// 文件显示名（识别 `.disabled` 时已去掉该后缀）。
    pub name: String,
    /// 文件绝对路径。
    pub path: String,
    /// 文件大小（字节）。用 BigInt 避免 >4GB 文件溢出。
    pub size: BigInt,
    /// 是否启用（`handle_disabled=true` 且原名以 `.disabled` 结尾时为 false）。
    pub enabled: bool,
}

/// `scan_files` 的异步任务。
pub struct ScanFilesTask {
    dir: String,
    extensions: Vec<String>,
    handle_disabled: bool,
}

impl Task for ScanFilesTask {
    type Output = Vec<ScannedFile>;
    type JsValue = Vec<ScannedFile>;

    fn compute(&mut self) -> Result<Self::Output> {
        let rt = runtime().map_err(Error::from_reason)?;
        // 取出参数，避免借用 self 与 'static 冲突（与下载任务同一手法）。
        let dir = std::mem::take(&mut self.dir);
        let extensions = std::mem::take(&mut self.extensions);
        let handle_disabled = self.handle_disabled;
        // 目录不存在 / 无权限等一律视为「空结果」，与 TS 侧 `catch → []` 语义一致，
        // 不会因为一个坏目录把上层调用打断。
        Ok(rt.block_on(scan_files_async(&dir, &extensions, handle_disabled)))
    }

    fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
        Ok(out)
    }
}

/// `scan_dirs` 的异步任务。
pub struct ScanDirsTask {
    parent: String,
    marker: String,
}

impl Task for ScanDirsTask {
    type Output = Vec<String>;
    type JsValue = Vec<String>;

    fn compute(&mut self) -> Result<Self::Output> {
        let rt = runtime().map_err(Error::from_reason)?;
        let parent = std::mem::take(&mut self.parent);
        let marker = std::mem::take(&mut self.marker);
        Ok(rt.block_on(scan_dirs_async(&parent, &marker)))
    }

    fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
        Ok(out)
    }
}

/// 列出一个目录下的文件并并行取大小。
///
/// * `extensions`：允许的扩展名（不含点，大小写不敏感）。空数组表示不过滤。
/// * `handle_disabled`：为 true 时，`xxx.jar.disabled` 被识别为「已停用的 xxx.jar」。
#[napi(ts_return_type = "Promise<Array<ScannedFile>>")]
pub fn scan_files(
    dir: String,
    extensions: Vec<String>,
    handle_disabled: bool,
) -> AsyncTask<ScanFilesTask> {
    AsyncTask::new(ScanFilesTask {
        dir,
        extensions,
        handle_disabled,
    })
}

/// 列出 `parent` 下的子目录，只保留内部存在标记文件的那些。
///
/// `marker` 支持占位符 `{name}`（替换为子目录名），用于「版本目录须有 `<目录名>.json`」；
/// 不含占位符时按固定文件名匹配（用于「存档须有 `level.dat`」）。
#[napi(ts_return_type = "Promise<Array<string>>")]
pub fn scan_dirs(parent: String, marker: String) -> AsyncTask<ScanDirsTask> {
    AsyncTask::new(ScanDirsTask { parent, marker })
}

/* ------------------------------ 内部实现 ------------------------------ */

/// 扩展名匹配（大小写不敏感，允许入参带或不带前导点）。
fn matches_ext(name: &str, extensions: &[String]) -> bool {
    let lower = name.to_ascii_lowercase();
    extensions.iter().any(|e| {
        let e = e.trim().trim_start_matches('.').to_ascii_lowercase();
        !e.is_empty() && lower.ends_with(&format!(".{e}"))
    })
}

async fn scan_files_async(
    dir: &str,
    extensions: &[String],
    handle_disabled: bool,
) -> Vec<ScannedFile> {
    let mut rd = match tokio::fs::read_dir(dir).await {
        Ok(rd) => rd,
        Err(_) => return Vec::new(),
    };

    // 先同步收集（目录遍历本身是顺序流），把元数据读取留到下面并行做。
    let mut pending: Vec<(String, PathBuf, bool)> = Vec::new();
    loop {
        let entry = match rd.next_entry().await {
            Ok(Some(e)) => e,
            Ok(None) => break,
            Err(_) => break,
        };
        // 只处理常规文件；目录 / 符号链接等跳过（与 TS 的 `isFile()` 判定一致）。
        match entry.file_type().await {
            Ok(ft) if ft.is_file() => {}
            _ => continue,
        }
        let raw = entry.file_name().to_string_lossy().into_owned();
        let (name, enabled) = if handle_disabled && raw.ends_with(".disabled") {
            (raw[..raw.len() - ".disabled".len()].to_string(), false)
        } else {
            (raw, true)
        };
        if !extensions.is_empty() && !matches_ext(&name, extensions) {
            continue;
        }
        pending.push((name, entry.path(), enabled));
    }

    // 并行取各文件大小；单个失败按 0 处理（与 TS 的 `catch { ignore }` 等价，但这里
    // 保留条目而不是丢弃——TS 是丢弃，改为保留 0 更利于排查；条目集与 TS 一致）。
    //
    // 用 `buffered`（**保序**）而非 `buffer_unordered`：输出顺序因此等于目录遍历顺序，
    // 与 TS 侧 `readdir` 一致，避免界面每次刷新条目乱跳（兼容性要求）。
    futures_util::stream::iter(pending.into_iter().map(|(name, path, enabled)| async move {
        let size = tokio::fs::metadata(&path).await.map(|m| m.len()).unwrap_or(0);
        ScannedFile {
            name,
            path: path.to_string_lossy().into_owned(),
            size: BigInt::from(size),
            enabled,
        }
    }))
    .buffered(STAT_CONCURRENCY)
    .collect()
    .await
}

async fn scan_dirs_async(parent: &str, marker: &str) -> Vec<String> {
    let mut rd = match tokio::fs::read_dir(parent).await {
        Ok(rd) => rd,
        Err(_) => return Vec::new(),
    };

    let has_placeholder = marker.contains("{name}");
    let mut candidates: Vec<(String, PathBuf)> = Vec::new();
    loop {
        let entry = match rd.next_entry().await {
            Ok(Some(e)) => e,
            Ok(None) => break,
            Err(_) => break,
        };
        match entry.file_type().await {
            Ok(ft) if ft.is_dir() => {}
            _ => continue,
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let marker_name = if has_placeholder {
            marker.replace("{name}", &name)
        } else {
            marker.to_string()
        };
        candidates.push((name, entry.path().join(marker_name)));
    }

    // 并行检查标记文件是否存在（与 TS 的 `existsSync` 语义一致：存在即可，不论类型）。
    // 同样用保序的 `buffered`，输出顺序与目录遍历一致。
    futures_util::stream::iter(candidates.into_iter().map(|(name, marker_path)| async move {
        if tokio::fs::metadata(&marker_path).await.is_ok() {
            Some(name)
        } else {
            None
        }
    }))
    .buffered(STAT_CONCURRENCY)
    .filter_map(|x| async move { x })
    .collect()
    .await
}

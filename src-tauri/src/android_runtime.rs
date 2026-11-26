//! Android 的 Java 运行时目录：内置 17 之外，按版本需求下载 21 / 25。
//!
//! 为什么需要它：Minecraft 1.20.5 起要求 Java 21，老版本要求 Java 8，而一个 JRE 只有在
//! 建 VM 之前选定——`JNI_CreateJavaVM` 不可重入，`libjvm.so` 一进进程就出不去。
//!
//! 三个硬约束决定了这里的形状：
//! 1. **目录自包含**：下载的 JRE 必须自带 `lib/server/libjvm.so`，否则只能和 APK 里那份
//!    版本固定的 `libjvm.so` 搭配，等于换不了版本。
//! 2. **校验不可省**：这些包来自个人维护者的 GitHub Release，只能靠 sha256 认。
//! 3. **没有源的架构要明说**：32 位 x86 与 Java 8 目前没有公开可直链的 Android 构建，
//!    宁可报一句明确的「没有」，也不要让人对着转圈猜。

use crate::downloads::Cancel;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// 一个可下载的运行时来源。
struct Source {
    major: u64,
    abi: &'static str,
    /// 展示名，进日志用。
    name: &'static str,
    url: &'static str,
    size: u64,
    sha256: &'static str,
    note: &'static str,
}

// 只登记「下载过、哈希核对过、包内自带 lib/server/libjvm.so + lib/modules」的来源。
// 目录变了要先在本机重新下载核验，再改这里的 size/sha256——它们就是唯一的信任锚。
const SOURCES: &[Source] = &[
    Source {
        major: 21,
        abi: "arm64",
        name: "Java 21（JBR 21.0.11）",
        url: "https://github.com/I-hope1/AndroidJBR/releases/download/v21.0.11-r3/jre21-jbr-android-arm64-20261110-final-r3.tar.xz",
        size: 31_101_864,
        sha256: "55d63d754453778373e2bfa3f464c3333bd1f267d09cab8c7a68f98da1d13ae3",
        note: "",
    },
    Source {
        major: 25,
        abi: "arm64",
        name: "Java 25（JBR 25.0.5）",
        url: "https://github.com/I-hope1/AndroidJBR/releases/download/v25.0.5-r1/jre25-jbr-android-arm64-20261114.tar.xz",
        size: 31_366_984,
        sha256: "8e6253303c321ebb260bc7712242416de3f6fad2c7ee23fea6c6db6d7c0e4b7d",
        note: "上游标注 experimental",
    },
];

/// 内置运行时的主版本：APK 的 `assets/runtime` 与 `jniLibs` 就是这套。
pub(crate) const BUNDLED_MAJOR: u64 = 17;

/// 当前 APK 的架构标签，与 `SOURCES` 的 `abi` 同一套写法。
fn abi() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "x86") {
        "x86"
    } else {
        "arm"
    }
}

fn source_for(major: u64) -> Option<&'static Source> {
    SOURCES
        .iter()
        .find(|source| source.major == major && source.abi == abi())
}

/// 本次启动使用哪个 JRE。
pub(crate) struct Runtime {
    pub(crate) major: u64,
    /// JRE 根目录（含 `lib/` 与 `conf/`）。内置 17 时指向 `filesDir/runtime/jre`。
    pub(crate) home: PathBuf,
    /// 是否为本模块下载的运行时：决定 `libjvm.so` 是从 APK 里找还是从 `home` 里 `dlopen`。
    pub(crate) custom: bool,
}

fn base() -> Result<PathBuf, String> {
    let files = crate::android_jvm::files_dir()
        .ok_or_else(|| "Android 运行时目录尚未下发，请重新打开应用".to_string())?;
    Ok(files.join("runtimes"))
}

fn home_of(major: u64) -> Result<PathBuf, String> {
    Ok(base()?.join(format!("jre{major}")))
}

/// 下载来的运行时必须同时具备 JVM 原生库与类库镜像，缺一个都起不来。
fn installed(home: &Path) -> bool {
    home.join("lib").join("server").join("libjvm.so").is_file()
        && home.join("lib").join("modules").is_file()
        && home.join("release").is_file()
}

fn stage(app: &tauri::AppHandle, text: &str) {
    crate::runtime::stage(app, text);
}

/// 按版本清单决定这次用哪个 JRE，必要时把它下下来。
///
/// 返回 Err 的场合都意味着「这个版本在当前架构上确实跑不了」，而不是让流程继续挂住。
pub(crate) async fn prepare(
    app: &tauri::AppHandle,
    version: &Value,
    cancel: Arc<Cancel>,
) -> Result<Runtime, String> {
    let major = crate::runtime::required_java(version)?;
    if major == BUNDLED_MAJOR {
        return Ok(bundled()?);
    }
    let home = home_of(major)?;
    if installed(&home) {
        stage(app, &format!("使用已下载的 Java {major}"));
        return Ok(Runtime { major, home, custom: true });
    }
    let Some(source) = source_for(major) else {
        // Java 8 没有任何公开可直链的 Android 构建（Pojav 的 jre8 只发 iOS 包，
        // Android 版只在需要登录的 Actions 产物里）。与其假装支持，不如按 17 继续，
        // 并把事实写进控制台——1.16 及更早版本能否跑起来取决于这一句。
        if major < BUNDLED_MAJOR {
            stage(
                app,
                &format!("此版本声明需要 Java {major}；当前没有 Android 版 Java {major}，将按 Java {BUNDLED_MAJOR} 启动"),
            );
            return Ok(bundled()?);
        }
        return Err(format!(
            "此版本需要 Java {major}，但架构 {} 没有可下载的运行时；请换用 arm64 安装包或改用较低的游戏版本",
            abi()
        ));
    };
    stage(
        app,
        &format!(
            "下载 {}（{:.1} MiB）{}",
            source.name,
            source.size as f64 / 1_048_576.0,
            if source.note.is_empty() { String::new() } else { format!("，{}", source.note) }
        ),
    );
    download(app, source, &home, &cancel).await?;
    stage(app, &format!("解压 {}", source.name));
    let target = home.clone();
    tauri::async_runtime::spawn_blocking(move || unpack(&target))
        .await
        .map_err(|_| "运行时解压任务异常".to_string())??;
    if !installed(&home) {
        return Err(format!("Java {major} 运行时解压结果不完整，请删除后重试"));
    }
    stage(app, &format!("Java {major} 已就绪"));
    Ok(Runtime { major, home, custom: true })
}

fn bundled() -> Result<Runtime, String> {
    let home = crate::android_jvm::bundled_home()
        .ok_or_else(|| "Android 运行时目录尚未下发，请重新打开应用".to_string())?;
    Ok(Runtime { major: BUNDLED_MAJOR, home, custom: false })
}

/// 目录占用的字节数（有界遍历）。
///
/// 一个运行时解压后约 100 MB、上千个文件；这里只用于给用户一个「删掉能省多少」的量级，
/// 因此对条目数与深度都设上限，遇到异常目录直接停，绝不为了统计把界面卡住。
fn dir_size(root: &Path) -> u64 {
    fn walk(path: &Path, budget: &mut u32, depth: u32) -> u64 {
        if *budget == 0 || depth > 8 {
            return 0;
        }
        let Ok(entries) = std::fs::read_dir(path) else { return 0 };
        let mut total = 0u64;
        for entry in entries.flatten() {
            if *budget == 0 {
                break;
            }
            *budget -= 1;
            let meta = match entry.metadata() {
                Ok(meta) => meta,
                Err(_) => continue,
            };
            if meta.is_dir() {
                total += walk(&entry.path(), budget, depth + 1);
            } else {
                total += meta.len();
            }
        }
        total
    }
    let mut budget = 20_000u32;
    walk(root, &mut budget, 0)
}

fn release_of(home: &Path) -> String {
    std::fs::read_to_string(home.join("release"))
        .ok()
        .and_then(|text| {
            text.lines()
                .find_map(|line| line.strip_prefix("JAVA_VERSION")?.strip_prefix('=').map(|v| v.trim().trim_matches('"').to_string()))
        })
        .unwrap_or_else(|| "?".into())
}

/// 已装运行时清单。
///
/// 内置 17 也列出来但标 `builtin`：用户需要知道「删不掉的那一套」占了多少空间，
/// 否则删除 21/25 之后体积看起来没有任何变化。
pub(crate) fn inventory() -> Result<Vec<Value>, String> {
    let mut items: Vec<Value> = Vec::new();
    if let Some(home) = crate::android_jvm::bundled_home().filter(|home| installed(home)) {
        items.push(serde_json::json!({
            "major": BUNDLED_MAJOR,
            "builtin": true,
            "version": release_of(&home),
            "size": dir_size(&home),
        }));
    }
    let base = base()?;
    let Ok(entries) = std::fs::read_dir(&base) else { return Ok(items) };
    let mut found: Vec<(u64, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(rest) = name.strip_prefix("jre") else { continue };
        let Ok(major) = rest.parse::<u64>() else { continue };
        let home = entry.path();
        if installed(&home) {
            found.push((major, home));
        }
    }
    found.sort_by_key(|(major, _)| *major);
    for (major, home) in found {
        items.push(serde_json::json!({
            "major": major,
            "builtin": false,
            "version": release_of(&home),
            "size": dir_size(&home),
        }));
    }
    Ok(items)
}

/// 删除一个下载来的运行时。
///
/// 两条拒绝：内置 17 是 APK 的一部分（删了应用就没有运行时），
/// 本次会话正在使用的那个删掉之后 `libjvm.so` 仍在进程里，下次启动会拿到残缺目录。
pub(crate) fn remove(major: u64) -> Result<(), String> {
    if major == BUNDLED_MAJOR {
        return Err("内置运行时随安装包分发，不能删除".into());
    }
    if crate::android_jvm::active_major() == Some(major) {
        return Err("本次会话正在使用这个运行时，请重启应用后再删除".into());
    }
    let home = home_of(major)?;
    if !home.is_dir() {
        return Err(format!("没有找到 Java {major} 运行时"));
    }
    std::fs::remove_dir_all(&home).map_err(|_| format!("删除 Java {major} 运行时失败，请检查存储权限"))?;
    // 下载中途留下的 .part / .tar.xz 一并清掉，否则下次会以为是残留的完整包。
    let _ = std::fs::remove_file(home.with_extension("tar.xz"));
    let _ = std::fs::remove_file(home.with_extension("tar.xz.part"));
    let _ = std::fs::remove_file(home.with_extension("tar"));
    Ok(())
}

/// 流式下载 + 长度与 sha256 双校验；任何一步不符都删掉半成品，不给下次留坏档。
async fn download(
    app: &tauri::AppHandle,
    source: &Source,
    home: &Path,
    cancel: &Cancel,
) -> Result<(), String> {
    let archive = home.with_extension("tar.xz");
    std::fs::create_dir_all(home).map_err(|_| "无法创建运行时目录")?;
    let part = home.with_extension("tar.xz.part");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|_| "无法创建下载客户端")?;
    let mut response = client
        .get(source.url)
        .send()
        .await
        .map_err(|_| format!("下载 {} 失败：网络不可达（可稍后重试）", source.name))?;
    if !response.status().is_success() {
        return Err(format!("下载 {} 失败：服务器返回 {}", source.name, response.status()));
    }
    let mut file = tokio::fs::File::create(&part)
        .await
        .map_err(|_| "无法创建运行时临时文件")?;
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    let mut reported = 0u64;
    let mut buffer: Vec<u8> = Vec::with_capacity(1024 * 1024);
    loop {
        if cancel.check().is_err() {
            let _ = tokio::fs::remove_file(&part).await;
            return Err("运行时下载已取消".into());
        }
        let next = tokio::time::timeout(std::time::Duration::from_secs(30), response.chunk()).await;
        let chunk = match next {
            Ok(Ok(Some(chunk))) => chunk,
            Ok(Ok(None)) => break,
            Ok(Err(_)) => {
                let _ = tokio::fs::remove_file(&part).await;
                return Err(format!("下载 {} 中断，请重试", source.name));
            }
            Err(_) => {
                let _ = tokio::fs::remove_file(&part).await;
                return Err(format!("下载 {} 停滞超时，请重试", source.name));
            }
        };
        received = received
            .checked_add(chunk.len() as u64)
            .ok_or("下载大小溢出")?;
        if received > source.size {
            let _ = tokio::fs::remove_file(&part).await;
            return Err("实际下载超过声明大小，已放弃".into());
        }
        hasher.update(&chunk);
        buffer.extend_from_slice(&chunk);
        if buffer.len() >= 1024 * 1024 {
            use tokio::io::AsyncWriteExt;
            file.write_all(&buffer)
                .await
                .map_err(|_| "写入运行时文件失败")?;
            buffer.clear();
        }
        // 每 10% 报一次，别让 30 MiB 的下载把控制台刷满。
        let percent = received.saturating_mul(100) / source.size.max(1);
        if percent >= reported + 10 {
            reported = percent - percent % 10;
            stage(app, &format!("下载 {}：{percent}%", source.name));
        }
    }
    if !buffer.is_empty() {
        use tokio::io::AsyncWriteExt;
        file.write_all(&buffer).await.map_err(|_| "写入运行时文件失败")?;
    }
    file.sync_all().await.map_err(|_| "提交运行时文件失败")?;
    drop(file);
    if received != source.size {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(format!(
            "下载不完整：{received}/{} 字节，请重试",
            source.size
        ));
    }
    let digest = format!("{:x}", hasher.finalize());
    if digest != source.sha256 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err("运行时 SHA-256 校验失败，已丢弃下载内容".into());
    }
    std::fs::rename(&part, &archive).map_err(|_| "无法提交运行时下载文件")?;
    stage(app, &format!("{} 下载完成并校验通过", source.name));
    Ok(())
}

/// 解压 `.tar.xz` 到运行时目录。
///
/// 上游包是 xz 压缩的 tar，且根成员就是 `./bin`、`./lib` 这些——直接解到目标目录即可。
/// 先解成中间 tar 再展开：`lzma-rs` 只提供「读全部、写全部」的入口，串流适配不值得为它写。
fn unpack(home: &Path) -> Result<(), String> {
    let archive = home.with_extension("tar.xz");
    let tar_path = home.with_extension("tar");
    std::fs::create_dir_all(home).map_err(|_| "无法创建运行时目录")?;
    {
        let input = std::fs::File::open(&archive).map_err(|_| "无法读取运行时压缩包")?;
        let mut input = BufReader::new(input);
        let output = std::fs::File::create(&tar_path).map_err(|_| "无法写入运行时临时文件")?;
        let mut output = BufWriter::new(output);
        lzma_rs::xz_decompress(&mut input, &mut output).map_err(|_| "运行时压缩包解压失败")?;
        output.flush().map_err(|_| "写入运行时临时文件失败")?;
    }
    {
        let tar = std::fs::File::open(&tar_path).map_err(|_| "无法读取运行时临时文件")?;
        let mut archive = tar::Archive::new(BufReader::new(tar));
        archive
            .unpack(home)
            .map_err(|_| "运行时压缩包展开失败")?;
    }
    // 上游包里的 .so 是 0644：`dlopen` 需要可执行映射，补上执行位（都在本应用私有目录里）。
    use std::os::unix::fs::PermissionsExt;
    for dir in [home.join("lib"), home.join("lib").join("server"), home.join("bin")] {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let executable = path.extension().and_then(|value| value.to_str()) == Some("so")
                || path.parent().is_some_and(|parent| parent.ends_with("bin"));
            if executable {
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
            }
        }
    }
    let _ = std::fs::remove_file(&tar_path);
    let _ = std::fs::remove_file(&archive);
    Ok(())
}

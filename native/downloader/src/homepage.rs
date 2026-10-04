// ---------------------------------------------------------------------------
// 自定义主页脚本的静态安全检测（原生实现）。
//
// 与 TS 侧 src/main/homepage-analyzer.ts + src/shared/homepage-runtime.ts 的规则表
// 一一对应：本模块把「危险代码规则扫描」与「外链地址采集」搬到 Rust，用 regex crate
// 一次性扫完整份脚本（不再像 JS 那样分片让出事件循环），把主进程从长任务里解放出来。
//
// 判定结果必须与旧 TS 实现完全一致（规则集、变体生成、去重、级别判定、外链分类），
// 否则同一份脚本在「有原生 / 无原生」两条路径上会得出不同结论。因此：
//   - 规则顺序、reasons 文案、skipInLibrary 标记逐条对照 TS 规则表；
//   - 变体 = [折叠内联 base64 的原文, 折叠内联 base64 的「合并相邻字面量」文本]；
//   - 外链先按「原始地址」去重并保持首次出现顺序，再交给 TS 侧按 localeCompare 排序
//     （Rust 的字节序排序与 JS 的 localeCompare 不同，故排序留在 TS）。
// ---------------------------------------------------------------------------

use std::collections::HashSet;
use std::sync::OnceLock;

use napi::bindgen_prelude::{AsyncTask, Result};
use napi::{Env, Task};
use napi_derive::napi;
use regex::Regex;

/// 命中即「拒绝运行」的一条危险规则。
struct Rule {
    re: Regex,
    reason: &'static str,
    /// 分析第三方脚本库正文时跳过：UMD 包装普遍含 require / module.exports / process.env。
    skip_in_library: bool,
}

fn r(pattern: &str) -> Regex {
    Regex::new(pattern).expect("内置正则必须可编译")
}

/// 危险规则表：顺序、文案与 TS 的 HOMEPAGE_BLOCK_RULES 保持一致。
///
/// 注意：TS 里用到了 lookbehind `(?<![-\w])` 与 lookahead `(?=…)`，Rust 的 regex crate
/// 不支持零宽断言，故改写为等价形态：
///   - `(?<![-\w])X`        → `(?:^|[^-\w])X`（只判断「是否存在」，多消费一个前置字符无影响）；
///   - `X(?=[?#…]|$)`       → `X(?:[?#…]|$)`。
fn block_rules() -> &'static Vec<Rule> {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        vec![
            // --- 删除文件 / 格式化 ---
            Rule { re: r(r"(?i)\brm\s+-[a-z]*[rf][a-z]*\s"), reason: "包含删除文件的 shell 命令（rm -rf）", skip_in_library: false },
            Rule { re: r(r#"(?i)\balias\s+[A-Za-z0-9_.-]+\s*=\s*["']?\s*(?:rm|del|erase|rmdir|rd|Remove-Item)\b"#), reason: "定义指向删除命令的 shell 别名（疑似规避检测的伪装代码）", skip_in_library: false },
            Rule { re: r(r#"(?i)(?:^|\s)-[a-z]*[rf][a-z]*[rf][a-z]*\s+/(?:\s|$|["'`])"#), reason: "包含递归强制删除根目录的命令参数", skip_in_library: false },
            Rule { re: r(r"(?i)\b(?:rmdir|rd\s+/s)\s|\bdel\s+/[a-z]|\berase\s+[a-z]:"), reason: "包含删除文件或目录的命令", skip_in_library: false },
            Rule { re: r(r"(?i)\bformat\s+[a-z]:|diskpart|\bmkfs(?:\.\w+)?\b|diskutil\s+erase|Clear-Disk|Format-Volume|shutdown\s+/|\bwipefs\b"), reason: "包含格式化磁盘或破坏系统的命令", skip_in_library: false },
            Rule { re: r(r"Remove-Item|shutil\.rmtree|os\.remove|os\.unlink|os\.rmdir|subprocess|child_process|execSync|spawnSync|execFileSync"), reason: "包含删除文件或执行系统命令的代码", skip_in_library: false },
            Rule { re: r(r"fs\.(?:unlink|rm|rmdir|truncate)(?:Sync)?\s*\(|(?:unlink|rmdir|rm)Sync\s*\(|deleteFile\s*\("), reason: "包含删除文件的文件系统调用", skip_in_library: false },
            // --- 修改 / 写入文件 ---
            Rule { re: r(r"(?i)(?:\b(?:fs|fsp|fsPromises|gracefulFs|nodeFs)\s*\.\s*)(?:writeFile|appendFile|rename|copyFile|cp|chmod|chown|mkdir|truncate|createWriteStream)(?:Sync)?\s*\("), reason: "包含写入 / 修改本地文件的文件系统调用", skip_in_library: false },
            Rule { re: r(r"\b(?:writeFile|appendFile|rename|copyFile|chmod|chown|mkdir|truncate|open|close|write)Sync\s*\("), reason: "包含写入 / 修改本地文件的同步调用", skip_in_library: false },
            Rule { re: r(r"\bcreateWriteStream\s*\("), reason: "包含写入本地文件的流式调用", skip_in_library: false },
            Rule { re: r(r"(?i)\b(?:Set-Content|Add-Content|Out-File|New-Item|Move-Item|Copy-Item|Rename-Item|Set-ItemProperty|Clear-Content)\b"), reason: "包含修改本地文件的 PowerShell 命令", skip_in_library: false },
            Rule { re: r(r#"(?i)(?:^|[^-\w])(?:mv|cp|move|copy|xcopy|robocopy)\s+["']?[a-z]:[\\/]"#), reason: "包含移动 / 复制本地文件的命令", skip_in_library: false },
            Rule { re: r(r"FileSystemFileHandle|createWritable\s*\(|showDirectoryPicker|requestFileSystem|\bFileWriter\b"), reason: "尝试直接读写本地文件", skip_in_library: false },
            // --- Node / 进程能力 ---
            Rule { re: r(r#"\brequire\s*\(\s*['"]|\bmodule\.exports\b|process\.binding|globalThis\.process|process\.env\b|process\.mainModule"#), reason: "尝试访问 Node 运行时能力", skip_in_library: true },
            // --- 动态执行 / 混淆伪装 ---
            Rule { re: r(r#"(?i)\beval\s*\(|new\s+Function\s*\(|\bFunction\s*\(\s*['"`]"#), reason: "包含动态执行代码（eval / new Function），属疑似伪装代码", skip_in_library: false },
            Rule { re: r(r#"(?i)\[\s*["'`]\s*(?:eval|atob|btoa|write|writeln|Function|constructor|fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|execScript)\s*["'`]\s*\]"#), reason: "以字符串下标访问敏感 API（疑似规避检测的伪装代码）", skip_in_library: false },
            Rule { re: r(r#"(?i)constructor\s*\.\s*constructor|__proto__\s*\[|Object\.getPrototypeOf\s*\(\s*function|\}\s*\)\s*\.\s*constructor|\)\s*\.\s*constructor\s*\(\s*["'`]"#), reason: "包含绕过沙箱的构造器链访问（疑似伪装代码）", skip_in_library: false },
            Rule { re: r(r#"(?i)document\s*(?:\.\s*write(?:ln)?\s*\(|\[\s*["'`]\s*write(?:ln)?\s*["'`]\s*\]\s*\()"#), reason: "使用 document.write / writeln 重写页面并注入内容（疑似伪装代码）", skip_in_library: false },
            Rule { re: r(r"(?i)(?:atob|unescape|decodeURIComponent)\s*\([\s\S]{0,120}?(?:eval|Function|document\.write|innerHTML|outerHTML)"), reason: "对编码字符串做动态执行（疑似混淆代码）", skip_in_library: false },
            Rule { re: r(r#"setTimeout\s*\(\s*['"`]|setInterval\s*\(\s*['"`]"#), reason: "以字符串形式延迟执行代码（疑似混淆代码）", skip_in_library: false },
            Rule { re: r(r"[A-Za-z0-9+/]{400,}={0,2}"), reason: "包含超长的疑似混淆编码块（Base64）", skip_in_library: false },
            Rule { re: r(r"(?i)(?:\\x[0-9a-f]{2}){6,}"), reason: "包含大量十六进制转义（疑似混淆代码）", skip_in_library: false },
            Rule { re: r(r"(?i)(?:\\u[0-9a-f]{4}){6,}"), reason: "包含大量 Unicode 转义（疑似混淆代码）", skip_in_library: false },
            Rule { re: r(r"String\.fromCharCode\s*\((?:\s*\d+\s*,){4,}"), reason: "拼接字符编码还原字符串（疑似混淆代码）", skip_in_library: false },
            Rule { re: r(r"(?i)CreateTextFile|OpenTextFile|ActiveXObject|WScript\.|FileSystemObject"), reason: "包含脚本宿主（WScript / ActiveX）的文件操作（疑似伪装代码）", skip_in_library: false },
            // --- 伪装界面 / 隐藏真实行为 ---
            Rule { re: r(r"(?i)<iframe\b"), reason: "包含页面嵌套（iframe），常用于伪装界面", skip_in_library: false },
            Rule { re: r(r#"(?i)<script[^>]*\bsrc\s*=\s*["']?\s*data:"#), reason: "以内联 data: 形式加载脚本（疑似伪装代码）", skip_in_library: false },
            Rule { re: r(r#"(?i)new\s+Image\s*\(\s*\)\s*\.\s*src\s*=\s*['"`]?https?:"#), reason: "通过图片对象隐蔽发起外部请求（疑似伪装行为）", skip_in_library: false },
            // --- 触发文件下载 ---
            Rule { re: r(r#"(?i)URL\.createObjectURL|\.download\s*=\s*['"`]|createElement\s*\(\s*['"`]a['"`]\s*\)[\s\S]{0,120}?\.click\s*\("#), reason: "包含触发文件下载的代码", skip_in_library: false },
            Rule { re: r(r"(?i)showSaveFilePicker|webkitRequestFileSystem|\bIndexedDB\b[\s\S]{0,60}?open\s*\("), reason: "尝试直接读写本地文件", skip_in_library: false },
        ]
    })
}

/// 折叠内联的 base64 data URI（脚本里嵌的图片等），否则会被「超长编码块」规则误判。
fn collapse_inline_base64(source: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| r(r#"(?i)data:[^"'`)\s]*base64,[A-Za-z0-9+/=\s]*"#));
    re.replace_all(source, "data:…").into_owned()
}

/// 把相邻的字符串字面量拼接合并成一个（`'r' + 'm'` → `'rm'`），还原拆字绕过。
fn merge_adjacent_literals(source: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| r(r#"["'`]\s*\+\s*["'`]"#));
    let mut out = source.to_string();
    for _ in 0..3 {
        let next = re.replace_all(&out, "").into_owned();
        if next == out {
            break;
        }
        out = next;
    }
    out
}

/// 生成要扫描的文本变体：原文 + 合并相邻字面量后的文本，各自再折叠内联 base64。
fn scan_variants(source: &str) -> Vec<String> {
    let merged = merge_adjacent_literals(source);
    vec![collapse_inline_base64(source), collapse_inline_base64(&merged)]
}

/// 用规则表扫描，返回命中的中文原因（按规则顺序去重）。
fn scan_blocks(source: &str, library: bool) -> Vec<String> {
    let variants = scan_variants(source);
    let mut blocks: Vec<String> = Vec::new();
    for rule in block_rules() {
        if library && rule.skip_in_library {
            continue;
        }
        if variants.iter().any(|v| rule.re.is_match(v)) && !blocks.iter().any(|b| b == rule.reason) {
            blocks.push(rule.reason.to_string());
        }
    }
    blocks
}

/* ------------------------------------------------------------------ */
/* 外链地址采集                                                        */
/* ------------------------------------------------------------------ */

/// 外链地址的用途说明（中文）。
fn attributed_kind(tag: &str) -> &'static str {
    match tag {
        "script" => "脚本",
        "link" => "样式",
        "img" | "source" | "image" | "video" | "audio" => "图片/媒体",
        "iframe" => "页面嵌套",
        "form" => "表单提交",
        _ => "链接",
    }
}

/// 是否指向外部服务（排除 data: / blob: / file: / 相对路径）。
fn is_external(u0: &str) -> bool {
    let u = u0.trim();
    if u.is_empty() {
        return false;
    }
    static SCHEME_RE: OnceLock<Regex> = OnceLock::new();
    static HTTP_RE: OnceLock<Regex> = OnceLock::new();
    let scheme = SCHEME_RE.get_or_init(|| r(r"(?i)^(?:data|blob|file|about|javascript|mailto|tel):"));
    if scheme.is_match(u) {
        return false;
    }
    if u.starts_with("//") {
        return true;
    }
    let http = HTTP_RE.get_or_init(|| r(r"(?i)^https?:"));
    http.is_match(u)
}

/// 归一化地址用于展示与去重。
fn normalize_url(u: &str) -> String {
    let t = u.trim();
    let t = t.trim_end_matches(|c| c == '"' || c == '\'' || c == '`' || c == ',' || c == ';');
    if t.starts_with("//") {
        format!("https:{}", t)
    } else {
        t.to_string()
    }
}

/// 取 URL 的「路径 + 查询」部分（去掉协议与主机）；不成形的返回空串。
fn url_path(url: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| r(r"^[a-z]+://[^/?#]*(/[\s\S]*)?" ));
    re.captures(url)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .unwrap_or_default()
}

/// 采集器共享的一张「原始地址 → 用途」表：按首次出现顺序去重。
struct Found {
    order: Vec<(String, String)>,
    seen: HashSet<String>,
}

impl Found {
    fn new() -> Self {
        Found { order: Vec::new(), seen: HashSet::new() }
    }
    fn insert(&mut self, url: String, kind: String) {
        if self.seen.insert(url.clone()) {
            self.order.push((url, kind));
        }
    }
}

/// 抓取带用途的外部地址（属性写法）。
fn collect_attributed(source: &str, out: &mut Found) {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        r(r#"(?i)<(script|link|img|iframe|a|area|form|source|video|audio|embed|object|use|image)\b[^>]*?\b(href|src|action|data|poster|xlink:href|ping)\s*=\s*["']([^"']+)["']"#)
    });
    for caps in re.captures_iter(source) {
        let tag = caps.get(1).map(|m| m.as_str().to_lowercase()).unwrap_or_default();
        let attr = caps.get(2).map(|m| m.as_str().to_lowercase()).unwrap_or_default();
        let raw = caps.get(3).map(|m| m.as_str()).unwrap_or("");
        // `ping` 的值可能是空格分隔的多个地址，逐个拆开。
        let urls: Vec<String> = if attr == "ping" {
            raw.split_whitespace().map(|s| s.to_string()).collect()
        } else {
            vec![raw.trim().to_string()]
        };
        for u in urls {
            let url = u.trim().to_string();
            if !is_external(&url) {
                continue;
            }
            out.insert(url, attributed_kind(&tag).to_string());
        }
    }
}

/// 抓取 JS 里发起的外部请求（fetch / XHR / WebSocket / 事件源 / 信标）。
fn collect_requests(source: &str, out: &mut Found) {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        r(r#"(?i)(?:fetch|open|sendBeacon|WebSocket|EventSource|importScripts|import)\s*\(\s*["'`]([^"'`]+)["'`]"#)
    });
    for caps in re.captures_iter(source) {
        let url = caps.get(1).map(|m| m.as_str().trim().to_string()).unwrap_or_default();
        if !is_external(&url) {
            continue;
        }
        out.insert(url, "接口请求".to_string());
    }
}

/// 抓取 CSS 里的外部引用与剩余的裸地址。
fn collect_bare(source: &str, out: &mut Found) {
    static RE: OnceLock<Regex> = OnceLock::new();
    static NAMESPACE_RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        r(r#"(?i)(?:https?:)?//(?:[a-z0-9][a-z0-9.-]*\.[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#][^\s"'`<>()\\]*)?"#)
    });
    let ns = NAMESPACE_RE.get_or_init(|| r(r"(?i)^(?:https?:)?//(?:www\.)?(?:w3\.org|purl\.org)/"));
    for m in re.find_iter(source) {
        let url = m.as_str().trim().to_string();
        if ns.is_match(&url) {
            continue;
        }
        if !is_external(&url) {
            continue;
        }
        out.insert(url, "外部地址".to_string());
    }
}

/// 判定为「危险下载」的路径后缀：可执行文件、压缩包、矢量图。
fn dangerous_ext(base: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        r(r#"(?i)\.(?:exe|msi|msp|dll|com|scr|sys|bat|cmd|ps1|psm1|vbs|vbe|wsf|wsh|sh|bash|zsh|jar|class|apk|app|dmg|pkg|deb|rpm|iso|img|zip|rar|7z|tar|gz|tgz|bz2|xz|svg)(?:[?#"'`\s<>)]|$)"#)
    });
    re.is_match(base)
}

/// 判定为「外链脚本」的路径后缀：内容需取回后按同一套规则判断。
fn script_ext(base: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| r(r#"(?i)\.(?:js|mjs|jse)(?:[?#"'`\s<>)]|$)"#));
    re.is_match(base)
}

/* ------------------------------------------------------------------ */
/* napi 导出：对外的检测入口                                            */
/* ------------------------------------------------------------------ */

/// 外链地址条目。
#[napi(object)]
pub struct ScannedExternal {
    pub url: String,
    pub kind: String,
    /// 是否为「外链脚本」（内容需上层取回后再核对）。
    pub code: bool,
}

/// 静态检测结果。
#[napi(object)]
pub struct ScannedRisk {
    /// safe | warn | reject
    pub level: String,
    pub blocks: Vec<String>,
    pub externals: Vec<ScannedExternal>,
}

/// 检测任务：CPU 密集，放 AsyncTask 在 libuv 线程池执行，避免阻塞 Node 主线程。
pub struct AnalyzeHomepageTask {
    source: String,
    library: bool,
}

impl Task for AnalyzeHomepageTask {
    type Output = ScannedRisk;
    type JsValue = ScannedRisk;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(analyze(&self.source, self.library))
    }

    fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
        Ok(out)
    }
}

/// 对脚本正文做静态安全检测。`library=true` 表示分析的是取回的第三方脚本库正文。
#[napi(ts_return_type = "Promise<ScannedRisk>")]
pub fn analyze_homepage(source: String, library: bool) -> AsyncTask<AnalyzeHomepageTask> {
    AsyncTask::new(AnalyzeHomepageTask { source, library })
}

/// 真实检测流程（与 TS 的 analyzeScriptUncached 逐字对应）。
fn analyze(source: &str, library: bool) -> ScannedRisk {
    let mut blocks = scan_blocks(source, library);

    // 拼接 / 模板字面量构造出的地址在原文里看不出来，再看一份「合并相邻字面量」的文本。
    let merged = merge_adjacent_literals(source);

    let mut found = Found::new();
    collect_attributed(source, &mut found);
    collect_requests(source, &mut found);
    collect_requests(&merged, &mut found);
    collect_bare(source, &mut found);
    collect_bare(&merged, &mut found);

    let mut externals: Vec<ScannedExternal> = Vec::new();
    for (raw, kind) in found.order.iter() {
        let url = normalize_url(raw);
        // 只看路径：末尾的分隔符先剥掉，`.../payload.exe/` 才能按可执行文件拦下，
        // 而主机名里的 `.com` / `.sh` / `.app` 不会被误当成危险后缀。
        let path = url_path(&url);
        let base = path
            .split(|c| c == '?' || c == '#')
            .next()
            .unwrap_or("")
            .trim_end_matches(|c| c == '/' || c == '\\')
            .to_string();
        if dangerous_ext(&base) {
            let reason = format!("包含对外的可执行文件 / 压缩包 / 矢量图下载：{}", url);
            if !blocks.iter().any(|b| b == &reason) {
                blocks.push(reason);
            }
            continue;
        }
        let code = script_ext(&base);
        // 脚本库正文里的普通地址只是代码中的字符串，不代表页面链接了外部服务，不列入清单。
        if library && !code {
            continue;
        }
        externals.push(ScannedExternal { url, kind: kind.clone(), code });
    }

    let level = if !blocks.is_empty() {
        "reject"
    } else if !externals.is_empty() {
        "warn"
    } else {
        "safe"
    };

    ScannedRisk {
        level: level.to_string(),
        blocks,
        externals,
    }
}
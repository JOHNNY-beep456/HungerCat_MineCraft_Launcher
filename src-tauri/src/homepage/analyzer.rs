//! 自定义主页静态分析。规则沿用 Electron 的原生分析器和 TS 回退实现。
//! 宿主限制读入体积；这里不截断正文或外链清单，只标记待复核的外链脚本。
//! 本模块不读取文件、不发请求、不执行脚本；隔离与运行时拦截由宿主负责。

use regex::Regex;
use serde_json::{json, Value};
use std::{borrow::Cow, collections::HashSet, sync::OnceLock};

struct Rule {
    re: Regex,
    reason: &'static str,
    skip_in_library: bool,
}

fn r(pattern: &str) -> Regex {
    Regex::new(pattern).expect("内置正则必须可编译")
}

/// 顺序和中文原因与 HOMEPAGE_BLOCK_RULES 对齐。只判断是否命中，Rust 正则以
/// `(?:^|[^-\w])` 代替命令规则的后顾断言，多消费一个前置字符不改变判定。
fn block_rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let rule = |pattern: &str, reason| Rule { re: r(pattern), reason, skip_in_library: false };
        vec![
            // 删除文件、格式化和执行命令。
            rule(r"(?i)\brm\s+-[a-z]*[rf][a-z]*\s", "包含删除文件的 shell 命令（rm -rf）"),
            rule(r#"(?i)\balias\s+[A-Za-z0-9_.-]+\s*=\s*["']?\s*(?:rm|del|erase|rmdir|rd|Remove-Item)\b"#, "定义指向删除命令的 shell 别名（疑似规避检测的伪装代码）"),
            rule(r#"(?i)(?:^|\s)-[a-z]*[rf][a-z]*[rf][a-z]*\s+/(?:\s|$|["'`])"#, "包含递归强制删除根目录的命令参数"),
            rule(r"(?i)\b(?:rmdir|rd\s+/s)\s|\bdel\s+/[a-z]|\berase\s+[a-z]:", "包含删除文件或目录的命令"),
            rule(r"(?i)\bformat\s+[a-z]:|diskpart|\bmkfs(?:\.\w+)?\b|diskutil\s+erase|Clear-Disk|Format-Volume|shutdown\s+/|\bwipefs\b", "包含格式化磁盘或破坏系统的命令"),
            // TS 回退中此规则不区分大小写，避免大写变体漏检。
            rule(r"(?i)Remove-Item|shutil\.rmtree|os\.remove|os\.unlink|os\.rmdir|subprocess|child_process|execSync|spawnSync|execFileSync", "包含删除文件或执行系统命令的代码"),
            rule(r"fs\.(?:unlink|rm|rmdir|truncate)(?:Sync)?\s*\(|(?:unlink|rmdir|rm)Sync\s*\(|deleteFile\s*\(", "包含删除文件的文件系统调用"),
            // 修改或写入本地文件。
            rule(r"(?i)(?:\b(?:fs|fsp|fsPromises|gracefulFs|nodeFs)\s*\.\s*)(?:writeFile|appendFile|rename|copyFile|cp|chmod|chown|mkdir|truncate|createWriteStream)(?:Sync)?\s*\(", "包含写入 / 修改本地文件的文件系统调用"),
            rule(r"\b(?:writeFile|appendFile|rename|copyFile|chmod|chown|mkdir|truncate|open|close|write)Sync\s*\(", "包含写入 / 修改本地文件的同步调用"),
            rule(r"\bcreateWriteStream\s*\(", "包含写入本地文件的流式调用"),
            rule(r"(?i)\b(?:Set-Content|Add-Content|Out-File|New-Item|Move-Item|Copy-Item|Rename-Item|Set-ItemProperty|Clear-Content)\b", "包含修改本地文件的 PowerShell 命令"),
            rule(r#"(?i)(?:^|[^-\w])(?:mv|cp|move|copy|xcopy|robocopy)\s+["']?[a-z]:[\\/]"#, "包含移动 / 复制本地文件的命令"),
            rule(r"FileSystemFileHandle|createWritable\s*\(|showDirectoryPicker|requestFileSystem|\bFileWriter\b", "尝试直接读写本地文件"),
            // 取回的脚本库可包含 UMD 包装，只有这条规则在库模式跳过。
            Rule { re: r(r#"\brequire\s*\(\s*['"]|\bmodule\.exports\b|process\.binding|globalThis\.process|process\.env\b|process\.mainModule"#), reason: "尝试访问 Node 运行时能力", skip_in_library: true },
            // 动态执行与编码伪装。
            rule(r#"(?i)\beval\s*\(|new\s+Function\s*\(|\bFunction\s*\(\s*['"`]"#, "包含动态执行代码（eval / new Function），属疑似伪装代码"),
            rule(r#"(?i)\[\s*["'`]\s*(?:eval|atob|btoa|write|writeln|Function|constructor|fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|execScript)\s*["'`]\s*\]"#, "以字符串下标访问敏感 API（疑似规避检测的伪装代码）"),
            rule(r#"(?i)constructor\s*\.\s*constructor|__proto__\s*\[|Object\.getPrototypeOf\s*\(\s*function|\}\s*\)\s*\.\s*constructor|\)\s*\.\s*constructor\s*\(\s*["'`]"#, "包含绕过沙箱的构造器链访问（疑似伪装代码）"),
            rule(r#"(?i)document\s*(?:\.\s*write(?:ln)?\s*\(|\[\s*["'`]\s*write(?:ln)?\s*["'`]\s*\]\s*\()"#, "使用 document.write / writeln 重写页面并注入内容（疑似伪装代码）"),
            rule(r"(?i)(?:atob|unescape|decodeURIComponent)\s*\([\s\S]{0,120}?(?:eval|Function|document\.write|innerHTML|outerHTML)", "对编码字符串做动态执行（疑似混淆代码）"),
            rule(r#"setTimeout\s*\(\s*['"`]|setInterval\s*\(\s*['"`]"#, "以字符串形式延迟执行代码（疑似混淆代码）"),
            rule(r"[A-Za-z0-9+/]{400,}={0,2}", "包含超长的疑似混淆编码块（Base64）"),
            rule(r"(?i)(?:\\x[0-9a-f]{2}){6,}", "包含大量十六进制转义（疑似混淆代码）"),
            rule(r"(?i)(?:\\u[0-9a-f]{4}){6,}", "包含大量 Unicode 转义（疑似混淆代码）"),
            rule(r"String\.fromCharCode\s*\((?:\s*\d+\s*,){4,}", "拼接字符编码还原字符串（疑似混淆代码）"),
            rule(r"(?i)CreateTextFile|OpenTextFile|ActiveXObject|WScript\.|FileSystemObject", "包含脚本宿主（WScript / ActiveX）的文件操作（疑似伪装代码）"),
            // 页面伪装、外部请求和下载。
            rule(r"(?i)<iframe\b", "包含页面嵌套（iframe），常用于伪装界面"),
            rule(r#"(?i)<script[^>]*\bsrc\s*=\s*["']?\s*data:"#, "以内联 data: 形式加载脚本（疑似伪装代码）"),
            rule(r#"(?i)new\s+Image\s*\(\s*\)\s*\.\s*src\s*=\s*['"`]?https?:"#, "通过图片对象隐蔽发起外部请求（疑似伪装行为）"),
            rule(r#"(?i)URL\.createObjectURL|\.download\s*=\s*['"`]|createElement\s*\(\s*['"`]a['"`]\s*\)[\s\S]{0,120}?\.click\s*\("#, "包含触发文件下载的代码"),
            rule(r"(?i)showSaveFilePicker|webkitRequestFileSystem|\bIndexedDB\b[\s\S]{0,60}?open\s*\(", "尝试直接读写本地文件"),
        ]
    })
}

/// 折叠内联图片等 Base64 数据；`<script src="data:…">` 仍会命中单独的规则。
fn collapse_inline_base64(source: &str) -> Cow<'_, str> {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| r(r#"(?i)data:[^"'`)\s]*base64,[A-Za-z0-9+/=\s]*"#))
        .replace_all(source, "data:…")
}

/// 与原生实现相同，最多合并三轮相邻字符串字面量，还原常见的拆字绕过。
fn merge_adjacent_literals(source: &str) -> Cow<'_, str> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| r(r#"["'`]\s*\+\s*["'`]"#));
    let mut merged = Cow::Borrowed(source);
    for _ in 0..3 {
        let Cow::Owned(next) = re.replace_all(&merged, "") else { break };
        merged = Cow::Owned(next);
    }
    merged
}

fn scan_blocks(source: &str, merged: &str, library: bool) -> Vec<String> {
    let variants = [collapse_inline_base64(source), collapse_inline_base64(merged)];
    let mut blocks = Vec::new();
    for rule in block_rules() {
        if library && rule.skip_in_library {
            continue;
        }
        if variants.iter().any(|variant| rule.re.is_match(variant))
            && !blocks.iter().any(|reason| reason == rule.reason)
        {
            blocks.push(rule.reason.to_owned());
        }
    }
    blocks
}

fn is_http_scheme(scheme: &str) -> bool {
    scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")
}

/// 相对路径和非 HTTP(S) 地址不属于外链；保留原生对 `//` 地址的采集。
fn is_external(raw: &str) -> bool {
    raw.starts_with("//") || raw.split_once(':').is_some_and(|(scheme, _)| is_http_scheme(scheme))
}

fn normalize_url(raw: &str) -> Cow<'_, str> {
    let url = raw.trim_end_matches(['"', '\'', '`', ',', ';']);
    if url.starts_with("//") {
        Cow::Owned(format!("https:{url}"))
    } else {
        Cow::Borrowed(url)
    }
}

/// 只取路径，忽略主机名、查询串和片段。去掉末尾分隔符，使 `payload.exe/` 也能命中。
/// 这里与 TS 一样对协议名忽略大小写，保留原始地址用于展示和复核。
fn url_base(url: &str) -> &str {
    let Some((scheme, address)) = url.split_once("://") else { return "" };
    if !is_http_scheme(scheme) {
        return "";
    }
    let Some(start) = address.find(['/', '?', '#']) else { return "" };
    let path = &address[start..];
    if !path.starts_with('/') {
        return "";
    }
    path.split(['?', '#']).next().unwrap_or("").trim_end_matches(['/', '\\'])
}

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

/// 与原生实现一样，先按原始地址去重并保留首次命中的用途，再规范化展示地址。
#[derive(Default)]
struct Found<'a> {
    order: Vec<(&'a str, &'static str)>,
    seen: HashSet<&'a str>,
}

impl<'a> Found<'a> {
    fn insert(&mut self, raw: &'a str, kind: &'static str) {
        let url = raw.trim();
        if is_external(url) && self.seen.insert(url) {
            self.order.push((url, kind));
        }
    }
}

fn collect_attributed<'a>(source: &'a str, out: &mut Found<'a>) {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| r(r#"(?i)<(script|link|img|iframe|a|area|form|source|video|audio|embed|object|use|image)\b[^>]*?\b(href|src|action|data|poster|xlink:href|ping)\s*=\s*["']([^"']+)["']"#));
    for caps in re.captures_iter(source) {
        let kind = attributed_kind(&caps[1].to_ascii_lowercase());
        let Some(raw) = caps.get(3).map(|m| m.as_str()) else { continue };
        if caps[2].eq_ignore_ascii_case("ping") {
            for url in raw.split_whitespace() {
                out.insert(url, kind);
            }
        } else {
            out.insert(raw, kind);
        }
    }
}

fn collect_requests<'a>(source: &'a str, out: &mut Found<'a>) {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| r(r#"(?i)(?:fetch|open|sendBeacon|WebSocket|EventSource|importScripts|import)\s*\(\s*["'`]([^"'`]+)["'`]"#));
    for caps in re.captures_iter(source) {
        if let Some(url) = caps.get(1) {
            out.insert(url.as_str(), "接口请求");
        }
    }
}

fn collect_bare<'a>(source: &'a str, out: &mut Found<'a>) {
    static RE: OnceLock<Regex> = OnceLock::new();
    static NAMESPACE_RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| r(r#"(?i)(?:https?:)?//(?:[a-z0-9][a-z0-9.-]*\.[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#][^\s"'`<>()\\]*)?"#));
    let namespace = NAMESPACE_RE.get_or_init(|| r(r"(?i)^(?:https?:)?//(?:www\.)?(?:w3\.org|purl\.org)/"));
    for hit in re.find_iter(source) {
        if !namespace.is_match(hit.as_str()) {
            out.insert(hit.as_str(), "外部地址");
        }
    }
}

fn dangerous_ext(base: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| r(r#"(?i)\.(?:exe|msi|msp|dll|com|scr|sys|bat|cmd|ps1|psm1|vbs|vbe|wsf|wsh|sh|bash|zsh|jar|class|apk|app|dmg|pkg|deb|rpm|iso|img|zip|rar|7z|tar|gz|tgz|bz2|xz|svg)(?:[?#"'`\s<>)]|$)"#)).is_match(base)
}

fn script_ext(base: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| r(r#"(?i)\.(?:js|mjs|jse)(?:[?#"'`\s<>)]|$)"#)).is_match(base)
}

/// 分析完整正文。库模式仍拦截危险规则和下载，仅跳过 UMD 规则、过滤普通外链。
pub(super) fn analyze(source: &str, library: bool) -> Value {
    let merged = merge_adjacent_literals(source);
    let mut blocks = scan_blocks(source, &merged, library);
    let mut found = Found::default();
    collect_attributed(source, &mut found);
    collect_requests(source, &mut found);
    collect_requests(&merged, &mut found);
    collect_bare(source, &mut found);
    collect_bare(&merged, &mut found);

    let mut downloads = HashSet::new();
    let mut externals = Vec::new();
    for (raw, kind) in found.order {
        let url = normalize_url(raw);
        let base = url_base(&url);
        if dangerous_ext(base) {
            if downloads.insert(url.clone()) {
                blocks.push(format!("包含对外的可执行文件 / 压缩包 / 矢量图下载：{url}"));
            }
            continue;
        }
        let code = script_ext(base);
        if !library || code {
            externals.push((url, kind, code));
        }
    }

    // 按 UTF-8 字节序稳定排序；与 JS localeCompare 的区域排序不同。同地址保留采集顺序。
    externals.sort_by(|a, b| a.0.cmp(&b.0));
    let level = if !blocks.is_empty() { "reject" } else if !externals.is_empty() { "warn" } else { "safe" };
    let externals: Vec<Value> = externals.into_iter().map(|(url, kind, code)| {
        if code { json!({"url": url, "kind": kind, "code": true}) }
        else { json!({"url": url, "kind": kind}) }
    }).collect();
    json!({"level": level, "blocks": blocks, "externals": externals})
}

/// 元信息匹配和字段 trim 使用 JS 的空白定义（含 BOM，不含 NEL）。
fn meta_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// 取首个 `<!--@hcpage … -->`；仅解析公开的六个字符串字段，损坏时按无元信息处理。
pub(super) fn parse_meta(source: &str, fallback_name: &str) -> Value {
    let raw = source.match_indices("<!--")
        .find_map(|(at, start)| source[at + start.len()..].trim_start_matches(meta_whitespace).strip_prefix("@hcpage"))
        .and_then(|rest| rest.split_once("-->"))
        .and_then(|(body, _)| serde_json::from_str::<Value>(body.trim_matches(meta_whitespace)).ok());
    let pick = |key: &str| raw.as_ref().and_then(|data| data.get(key)).and_then(Value::as_str)
        .unwrap_or("").trim_matches(meta_whitespace);
    let name = pick("name");
    json!({
        "id": pick("id"),
        "name": if name.is_empty() { fallback_name } else { name },
        "author": pick("author"),
        "version": pick("version"),
        "description": pick("description"),
        "minLauncher": pick("minLauncher"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fmt::Write as _;

    #[test]
    fn homepage_analyzer_scans_tail_and_keeps_all_externals() {
        let mut source = "<!-- local placeholder -->\n".repeat(4096);
        for index in 0..120 {
            writeln!(source, r#"<img src="https://media.invalid/{index:03}.png">"#).unwrap();
        }
        source.push_str(r#"<script>eval('tail')</script><a href="https://download.invalid/tail.zip">尾部</a>"#);

        let risk = analyze(&source, false);
        assert_eq!(risk["level"], "reject");
        assert_eq!(risk["blocks"], json!([
            "包含动态执行代码（eval / new Function），属疑似伪装代码",
            "包含对外的可执行文件 / 压缩包 / 矢量图下载：https://download.invalid/tail.zip"
        ]));
        let externals = risk["externals"].as_array().unwrap();
        assert_eq!(externals.len(), 120);
        assert_eq!(externals[119]["url"], "https://media.invalid/119.png");
    }

    #[test]
    fn homepage_analyzer_classifies_downloads_by_path_not_host_or_query() {
        let page = r#"
            <img src="https://site.com/icons/logo.png?filename=setup.exe">
            <a href="https://sample.sh#file.apk">主机</a>
            <a href="https://sample.app/">主机</a>
        "#;
        let risk = analyze(page, false);
        assert_eq!(risk["level"], "warn");
        assert_eq!(risk["blocks"], json!([]));
        assert_eq!(risk["externals"].as_array().unwrap().len(), 3);

        let downloads = r#"
            <a href="HTTPS://download.invalid/payload.ExE/?source=ref#section">下载</a>
            <a href="//download.invalid/archive.zip">归档</a>
            <a href="https://download.invalid/archive.zip">重复归档</a>
            <img src="https://download.invalid/image.svg#figure">
            <a href="https://download.invalid/program.com">程序</a>
        "#;
        let risk = analyze(downloads, false);
        assert_eq!(risk["level"], "reject");
        assert_eq!(risk["externals"], json!([]));
        assert_eq!(risk["blocks"], json!([
            "包含对外的可执行文件 / 压缩包 / 矢量图下载：HTTPS://download.invalid/payload.ExE/?source=ref#section",
            "包含对外的可执行文件 / 压缩包 / 矢量图下载：https://download.invalid/archive.zip",
            "包含对外的可执行文件 / 压缩包 / 矢量图下载：https://download.invalid/image.svg#figure",
            "包含对外的可执行文件 / 压缩包 / 矢量图下载：https://download.invalid/program.com"
        ]));
    }

    #[test]
    fn homepage_analyzer_keeps_rule_order_and_deduplicates_reasons() {
        let risk = analyze(r#"
            showSaveFilePicker();
            document['wri' + 'te']('伪装');
            createWritable();
            const command = 'SUBPROCESS';
        "#, false);
        assert_eq!(risk["blocks"], json!([
            "包含删除文件或执行系统命令的代码",
            "尝试直接读写本地文件",
            "以字符串下标访问敏感 API（疑似规避检测的伪装代码）",
            "使用 document.write / writeln 重写页面并注入内容（疑似伪装代码）"
        ]));
        let classpath = r#"<pre>java -cp "C:\games\libraries" Main</pre>"#;
        assert_eq!(analyze(classpath, false)["level"], "safe");
    }

    #[test]
    fn homepage_analyzer_distinguishes_encoded_code_from_inline_image_data() {
        let encoded = "A".repeat(410);
        let fixture = format!(r#"
            const c = atob('aW5pdA=='); document.body.innerHTML = c;
            const first = '\x65\x76\x61\x6c\x28\x29';
            const second = '\u0065\u0076\u0061\u006c\u0028\u0029';
            const third = '{encoded}';
            String.fromCharCode(101,118,97,108,40,41);
        "#);
        let risk = analyze(&fixture, false);
        assert_eq!(risk["level"], "reject");
        assert_eq!(risk["blocks"], json!([
            "对编码字符串做动态执行（疑似混淆代码）",
            "包含超长的疑似混淆编码块（Base64）",
            "包含大量十六进制转义（疑似混淆代码）",
            "包含大量 Unicode 转义（疑似混淆代码）",
            "拼接字符编码还原字符串（疑似混淆代码）"
        ]));

        let image = format!(r#"<img src="data:image/png;base64,{encoded}">"#);
        assert_eq!(analyze(&image, false), json!({"level":"safe", "blocks":[], "externals":[]}));
        let script = format!(r#"<script src="data:text/javascript;base64,{encoded}"></script>"#);
        assert_eq!(analyze(&script, false)["blocks"], json!([
            "以内联 data: 形式加载脚本（疑似伪装代码）"
        ]));
    }

    #[test]
    fn homepage_analyzer_normalizes_externals_preserving_kind_and_fixed_order() {
        let page = r#"
            <IMG SRC="https://b.invalid/logo.png">
            <LINK HREF="https://a.invalid/style.css">
            <SCRIPT SRC="//CDN.invalid/lib.mjs?v=2#cache"></SCRIPT>
            <a ping="//beacon.invalid/one https://beacon.invalid/two">链接</a>
            <svg xmlns="http://www.w3.org/2000/svg"></svg>
            <img src="./local.png">
            <script>
                fetch('https://b.invalid/logo.png');
                fetch('h' + 'ttps:/' + '/api.invalid/list');
            </script>
        "#;
        assert_eq!(analyze(page, false), json!({"level":"warn", "blocks":[], "externals":[
            {"url":"https://CDN.invalid/lib.mjs?v=2#cache","kind":"脚本","code":true},
            {"url":"https://a.invalid/style.css","kind":"样式"},
            {"url":"https://api.invalid/list","kind":"接口请求"},
            {"url":"https://b.invalid/logo.png","kind":"图片/媒体"},
            {"url":"https://beacon.invalid/one","kind":"链接"},
            {"url":"https://beacon.invalid/two","kind":"链接"}
        ]}));
    }

    #[test]
    fn homepage_analyzer_library_skips_umd_but_checks_scripts_and_danger() {
        let umd = "if (module.exports) { require('fixture'); process.env.MODE; }";
        assert_eq!(analyze(umd, false)["blocks"], json!(["尝试访问 Node 运行时能力"]));
        assert_eq!(analyze(umd, true), json!({"level":"safe", "blocks":[], "externals":[]}));

        let library = format!("{umd}\nfetch('https://api.invalid/status'); importScripts('https://cdn.invalid/nested.jse');");
        assert_eq!(analyze(&library, true), json!({"level":"warn", "blocks":[], "externals":[
            {"url":"https://cdn.invalid/nested.jse","kind":"接口请求","code":true}
        ]}));
        let dangerous = format!("{umd}\neval('fixture'); fetch('https://cdn.invalid/payload.exe/');");
        let risk = analyze(&dangerous, true);
        assert_eq!(risk["level"], "reject");
        assert_eq!(risk["blocks"], json!([
            "包含动态执行代码（eval / new Function），属疑似伪装代码",
            "包含对外的可执行文件 / 压缩包 / 矢量图下载：https://cdn.invalid/payload.exe/"
        ]));
    }

    #[test]
    fn homepage_meta_matches_first_comment_and_public_string_fields() {
        let source = concat!(
            "<!-- 无关注释 --><!-- \u{feff}@hcpage \n",
            r#"{"id":" HC-123456 ","name":"\uFEFF示例\u00A0","author":" 作者 ","version":" 1.2.3 ","description":" 说明 ","minLauncher":" 0.7.5 ","extra":true}"#,
            " -->",
            r#"<!--@hcpage {"name":"后续块"} -->"#,
        );
        assert_eq!(parse_meta(source, "本地文件"), json!({
            "id":"HC-123456", "name":"示例", "author":"作者", "version":"1.2.3",
            "description":"说明", "minLauncher":"0.7.5"
        }));
    }

    #[test]
    fn homepage_meta_defaults_for_missing_invalid_or_non_string_metadata() {
        let fallback = " 本地文件 ";
        let defaults = json!({"id":"", "name":fallback, "author":"", "version":"", "description":"", "minLauncher":""});
        for source in [
            "<h1>无元信息</h1>",
            r#"<!--@HCPAGE {"id":"ignored"} -->"#,
            r#"<!--@hcpage {broken} --><!--@hcpage {"name":"后续块"} -->"#,
            "<!--@hcpage null -->",
            r#"<!--@hcpage {"id":42,"name":"  ","author":false,"version":["1"],"description":null,"minLauncher":{}} -->"#,
        ] {
            assert_eq!(parse_meta(source, fallback), defaults, "{source}");
        }
    }
}

use std::{env, fs, path::PathBuf};

// 前后端共用同一份公开通道表，避免新增接口时扩大原生命令范围。
fn channel_array(source: &str, name: &str) -> Vec<String> {
    let marker = format!("export const {name} = [");
    let rest = source.split_once(&marker).expect("缺少前端通道表").1;
    let body = rest.split_once("] as const").expect("通道表格式无效").0;
    body.split('\'').enumerate().filter_map(|(index, value)| {
        if index % 2 == 1 { Some(value.to_string()) } else { None }
    }).collect()
}

// SDK 只允许逐行字符串字面量。构建期读取同一份源码，避免 Rust 宿主另存一份 SDK。
fn homepage_sdk() -> String {
    let path = "../src/renderer/src/pages/customhome/sdk.ts";
    println!("cargo:rerun-if-changed={path}");
    let source = fs::read_to_string(path).expect("无法读取主页 SDK");
    let body = source.split_once("export const SDK = [").expect("缺少 SDK 数组").1
        .split_once("].join('\\n')").expect("SDK 数组必须按行合并").0;
    let mut lines = Vec::new();
    for line in body.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let line = line.strip_suffix(',').unwrap_or(line);
        let quote = line.chars().next().expect("SDK 字符串为空");
        assert!((quote == '\'' || quote == '"') && line.ends_with(quote), "SDK 只接受字符串字面量");
        let mut text = String::new();
        let mut chars = line[1..line.len()-1].chars();
        while let Some(c) = chars.next() {
            if c != '\\' { text.push(c); continue; }
            text.push(match chars.next().expect("SDK 转义不完整") {
                '\\' => '\\', '\'' => '\'', '"' => '"', 'n' => '\n', 'r' => '\r', 't' => '\t',
                'b' => '\u{0008}', 'f' => '\u{000c}', _ => panic!("SDK 含尚未支持的转义，拒绝生成不同内容"),
            });
        }
        lines.push(text);
    }
    lines.join("\n")
}

fn main() {
    let path = PathBuf::from("../src/tauri/types.ts");
    println!("cargo:rerun-if-changed={}", path.display());
    let source = fs::read_to_string(path).expect("无法读取通道表");
    let mut generated = String::new();
    for (input, output) in [("launcherCallChannels", "CALL_CHANNELS"), ("launcherSendChannels", "SEND_CHANNELS")] {
        let channels = channel_array(&source, input);
        let mut unique = std::collections::BTreeSet::new();
        for channel in &channels { assert!(unique.insert(channel), "通道重复"); }
        generated.push_str(&format!("const {output}: &[&str] = &{:?};\n", channels));
    }
    fs::write(PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("launcher_channels.rs"), generated).expect("无法生成通道表");
    fs::write(PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("homepage_sdk.js"), homepage_sdk()).expect("无法生成主页 SDK");
    // 测试可执行文件不经过 tauri_build 的清单嵌入，缺少 comctl32 v6 依赖时
    // Windows 加载器会因 TaskDialogIndirect 解析不到而拒绝启动（0xc0000139）。
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
    }
    tauri_build::build()
}

//! 安装包内 Java 的只读路径与机器架构校验；不执行程序，也不依据宿主 cfg 猜测包架构。
//! 调用方须持有私有 staging/安装根锁；头部通过不替代可信来源、摘要或实际 JVM 探测。
use std::{
    collections::BTreeSet,
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
};

type Result<T> = std::result::Result<T, String>;
const ENTRY_CAP: usize = 100_000;
const DEPTH_CAP: usize = 64;
const PATH_CAP: usize = 32_768;
const FILE_CAP: u64 = 256 * 1024 * 1024;
const TOTAL_CAP: u64 = 2 * 1024 * 1024 * 1024;
const HEADER_CAP: u64 = 1024 * 1024;
const FAT_CAP: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Machine { X64, Arm64 }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Os { Windows, Linux, Mac }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role { Launcher, Library }

fn target(os: &str, arch: &str) -> Result<(Os, Machine)> {
    let os = match os { "windows" => Os::Windows, "linux" => Os::Linux, "mac" => Os::Mac,
        _ => return Err("Java 包的操作系统不受支持".into()) };
    let machine = match arch { "x64" => Machine::X64, "aarch64" => Machine::Arm64,
        _ => return Err("Java 包的 CPU 架构不受支持".into()) };
    Ok((os, machine))
}

fn linked(meta: &Metadata) -> bool {
    if meta.file_type().is_symlink() { return true; }
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 { return true; }
    }
    false
}

fn checked_path(path: &Path) -> Result<()> {
    if !path.is_absolute() || path.as_os_str().len() > PATH_CAP { return Err("Java 路径必须为有界绝对路径".into()); }
    let mut current = PathBuf::new();
    for part in path.components() {
        match part {
            Component::Prefix(prefix) => { current.push(prefix.as_os_str()); continue; }
            Component::RootDir => current.push(part.as_os_str()),
            Component::Normal(name) => {
                let text = name.to_str().ok_or("Java 路径不是有效 UTF-8")?;
                if text.is_empty() || text.len() > 1024 || text.chars().any(char::is_control)
                    || text.contains([':', '\\']) || text.ends_with(['.', ' ']) {
                    return Err("Java 路径含不安全名称".into());
                }
                current.push(name);
            }
            Component::CurDir | Component::ParentDir => return Err("Java 路径不能含相对跳转".into()),
        }
        let meta = fs::symlink_metadata(&current).map_err(|_| "Java 路径不可访问")?;
        if linked(&meta) { return Err("Java 路径含链接或重解析点".into()); }
    }
    Ok(())
}

#[cfg(unix)]
fn same_file(a: &Metadata, b: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev() && a.ino() == b.ino() && a.len() == b.len()
        && a.mtime() == b.mtime() && a.mtime_nsec() == b.mtime_nsec()
}
#[cfg(windows)]
fn same_file(a: &Metadata, b: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    a.file_attributes() == b.file_attributes() && a.file_size() == b.file_size()
        && a.creation_time() == b.creation_time() && a.last_write_time() == b.last_write_time()
}
#[cfg(not(any(unix, windows)))]
fn same_file(_a: &Metadata, _b: &Metadata) -> bool { false }

fn regular(file: &File) -> Result<Metadata> {
    let meta = file.metadata().map_err(|_| "无法核验 Java 文件句柄")?;
    if !meta.is_file() || linked(&meta) || meta.len() > FILE_CAP { return Err("Java 文件不是有界普通文件".into()); }
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() != 1 { return Err("Java 文件含硬链接".into()); }
    }
    #[cfg(windows)] {
        use std::{ffi::c_void, os::windows::io::AsRawHandle};
        #[repr(C)] struct Info { attributes: u32, creation: [u32; 2], access: [u32; 2], write: [u32; 2], volume: u32, high_size: u32, low_size: u32, links: u32, high_id: u32, low_id: u32 }
        #[link(name="kernel32")] extern "system" { fn GetFileInformationByHandle(file: *mut c_void, info: *mut Info) -> i32; }
        let mut info: Info = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut info) } == 0 || info.links != 1 || info.attributes & 0x400 != 0 {
            return Err("Java 文件身份无效或含硬链接".into());
        }
    }
    Ok(meta)
}

fn open_checked(path: &Path) -> Result<File> {
    checked_path(path)?;
    let before = fs::symlink_metadata(path).map_err(|_| "无法读取 Java 文件属性")?;
    if !before.is_file() || linked(&before) { return Err("Java 输入不是普通文件".into()); }
    let mut options = OpenOptions::new(); options.read(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(target_os="macos")] let flag = 0x100;
        #[cfg(all(target_os="android", any(target_arch="arm",target_arch="aarch64")))] let flag = 0x8000;
        #[cfg(all(unix, not(target_os="macos"), not(all(target_os="android", any(target_arch="arm",target_arch="aarch64")))))] let flag = 0x20000;
        // 即便普通文件在打开前被换成 FIFO，也不能让校验线程阻塞等待写端。
        #[cfg(target_os="macos")] let nonblock = 0x4;
        #[cfg(not(target_os="macos"))] let nonblock = 0x800;
        options.custom_flags(flag | nonblock);
    }
    #[cfg(windows)] {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1).custom_flags(0x00200000);
    }
    let file = options.open(path).map_err(|_| "无法只读打开 Java 文件")?;
    let opened = regular(&file)?;
    checked_path(path)?;
    let after = fs::symlink_metadata(path).map_err(|_| "Java 文件在校验时消失")?;
    if !same_file(&before, &opened) || !same_file(&opened, &after) { return Err("Java 文件在校验时改变".into()); }
    Ok(file)
}

struct Inventory { files: Vec<PathBuf>, entries: usize, bytes: u64 }
fn walk(path: &Path, depth: usize, inventory: &mut Inventory) -> Result<()> {
    if depth > DEPTH_CAP { return Err("Java 目录层级超过上限".into()); }
    checked_path(path)?;
    let before = fs::symlink_metadata(path).map_err(|_| "无法读取 Java 目录")?;
    if !before.is_dir() || linked(&before) { return Err("Java 目录无效或含链接".into()); }
    for row in fs::read_dir(path).map_err(|_| "无法枚举 Java 目录")? {
        inventory.entries += 1;
        if inventory.entries > ENTRY_CAP { return Err("Java 目录条目超过上限".into()); }
        let path = row.map_err(|_| "无法读取 Java 目录条目")?.path();
        checked_path(&path)?;
        let meta = fs::symlink_metadata(&path).map_err(|_| "无法读取 Java 条目属性")?;
        if linked(&meta) { return Err("Java 目录仍含链接或重解析点".into()); }
        if meta.is_dir() { walk(&path, depth + 1, inventory)?; }
        else if meta.is_file() {
            let file = open_checked(&path)?;
            let meta = regular(&file)?;
            inventory.bytes = inventory.bytes.checked_add(meta.len()).ok_or("Java 目录大小溢出")?;
            if inventory.bytes > TOTAL_CAP { return Err("Java 目录大小超过上限".into()); }
            inventory.files.push(path);
        } else { return Err("Java 目录含设备或特殊文件".into()); }
    }
    checked_path(path)?;
    let after = fs::symlink_metadata(path).map_err(|_| "Java 目录在检查时消失")?;
    if !same_file(&before, &after) { return Err("Java 目录在检查时改变".into()); }
    Ok(())
}

fn read_at(file: &mut File, base: u64, span: u64, offset: u64, length: usize) -> Result<Vec<u8>> {
    offset.checked_add(length as u64).filter(|end| *end <= span).ok_or("Java 文件头越界")?;
    let start = base.checked_add(offset).ok_or("Java 文件偏移溢出")?;
    file.seek(SeekFrom::Start(start)).map_err(|_| "无法定位 Java 文件头")?;
    let mut bytes = vec![0; length];
    file.read_exact(&mut bytes).map_err(|_| "Java 文件头被截断")?;
    Ok(bytes)
}
fn u16_at(bytes: &[u8], offset: usize, little: bool) -> Result<u16> {
    let a: [u8;2] = bytes.get(offset..offset+2).ok_or("Java 文件头被截断")?.try_into().map_err(|_| "Java 文件头被截断")?;
    Ok(if little { u16::from_le_bytes(a) } else { u16::from_be_bytes(a) })
}
fn u32_at(bytes: &[u8], offset: usize, little: bool) -> Result<u32> {
    let a: [u8;4] = bytes.get(offset..offset+4).ok_or("Java 文件头被截断")?.try_into().map_err(|_| "Java 文件头被截断")?;
    Ok(if little { u32::from_le_bytes(a) } else { u32::from_be_bytes(a) })
}
fn u64_at(bytes: &[u8], offset: usize, little: bool) -> Result<u64> {
    let a: [u8;8] = bytes.get(offset..offset+8).ok_or("Java 文件头被截断")?.try_into().map_err(|_| "Java 文件头被截断")?;
    Ok(if little { u64::from_le_bytes(a) } else { u64::from_be_bytes(a) })
}

fn pe(file: &mut File, size: u64, expected: Machine, role: Role) -> Result<()> {
    let dos = read_at(file, 0, size, 0, 64)?;
    if &dos[..2] != b"MZ" { return Err("Windows Java 必须为 PE 文件".into()); }
    let offset = u32_at(&dos, 60, true)? as u64;
    if offset < 64 || offset > HEADER_CAP { return Err("PE 头部位置无效".into()); }
    let head = read_at(file, 0, size, offset, 24)?;
    let machine = match u16_at(&head, 4, true)? { 0x8664 => Machine::X64, 0xaa64 => Machine::Arm64, _ => return Err("PE 架构不受支持".into()) };
    let sections = u16_at(&head, 6, true)? as usize;
    let optional = u16_at(&head, 20, true)? as usize;
    let flags = u16_at(&head, 22, true)?;
    if &head[..4] != b"PE\0\0" || machine != expected || sections == 0 || sections > 96
        || optional < 112 || optional > 4096 || flags & 2 == 0 || (flags & 0x2000 != 0) != (role == Role::Library) {
        return Err("PE 操作系统、架构或文件类型不匹配".into());
    }
    let opt = read_at(file, 0, size, offset+24, optional)?;
    if u16_at(&opt, 0, true)? != 0x20b { return Err("Java PE 必须为匹配的 PE32+ 文件".into()); }
    let subsystem = u16_at(&opt, 68, true)?;
    if !matches!(subsystem, 2 | 3) { return Err("Java PE 子系统不受支持".into()); }
    let table = read_at(file, 0, size, offset+24+optional as u64, sections*40)?;
    for section in table.chunks_exact(40) {
        let length = u32_at(section, 16, true)? as u64;
        let start = u32_at(section, 20, true)? as u64;
        if length != 0 && (start == 0 || start.checked_add(length).filter(|end| *end <= size).is_none()) {
            return Err("PE 节数据越界".into());
        }
    }
    Ok(())
}

fn elf(file: &mut File, size: u64, expected: Machine, role: Role) -> Result<()> {
    let head = read_at(file, 0, size, 0, 64)?;
    if &head[..4] != b"\x7fELF" || head[4] != 2 || head[5] != 1 || head[6] != 1 || !matches!(head[7],0|3) || head[8] != 0 {
        return Err("Linux Java 必须为有效小端 ELF64 Linux/SYSV 文件".into());
    }
    let machine = match u16_at(&head,18,true)? {62 => Machine::X64,183 => Machine::Arm64,_ => return Err("ELF CPU 不受支持".into())};
    let kind = u16_at(&head,16,true)?;
    if machine != expected || u32_at(&head,20,true)? != 1 || u16_at(&head,52,true)? != 64
        || !(kind == 3 || (role == Role::Launcher && kind == 2)) { return Err("ELF 架构或文件类型不匹配".into()); }
    let offset = u64_at(&head,32,true)?;
    let count = u16_at(&head,56,true)? as usize;
    if count == 0 || count > 1024 || u16_at(&head,54,true)? != 56 || offset < 64 || offset > HEADER_CAP { return Err("ELF 程序头无效".into()); }
    let headers = read_at(file,0,size,offset,count*56)?;
    let mut load = false;
    let mut interpreter = false;
    for item in headers.chunks_exact(56) {
        let kind = u32_at(item,0,true)?;
        let start = u64_at(item,8,true)?;
        let length = u64_at(item,32,true)?;
        let memory = u64_at(item,40,true)?;
        if length != 0 && start.checked_add(length).filter(|end| *end <= size).is_none() { return Err("ELF 段数据越界".into()); }
        if kind == 1 { if memory < length { return Err("ELF LOAD 段大小无效".into()); } load = true; }
        if kind == 3 {
            if interpreter || length < 2 || length > 512 { return Err("ELF 解释器声明无效".into()); }
            let bytes = read_at(file,0,size,start,length as usize)?;
            if bytes.last() != Some(&0) { return Err("ELF 解释器路径未终止".into()); }
            let text = std::str::from_utf8(&bytes[..bytes.len()-1]).map_err(|_|"ELF 解释器路径无效")?;
            let valid = match expected {
                Machine::X64 => matches!(text,"/lib64/ld-linux-x86-64.so.2"|"/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"|"/lib/ld-musl-x86_64.so.1"),
                Machine::Arm64 => matches!(text,"/lib/ld-linux-aarch64.so.1"|"/lib64/ld-linux-aarch64.so.1"|"/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1"|"/lib/ld-musl-aarch64.so.1"),
            };
            if !valid { return Err("ELF 解释器与 Linux 目标架构不匹配".into()); }
            interpreter = true;
        }
    }
    // SYSV OSABI 同样可能出现在 Android：启动器必须另有 Linux 动态加载器证据。
    if !load || (role == Role::Launcher && !interpreter) { return Err("ELF 缺少 LOAD 段或 Linux 启动器解释器".into()); }
    Ok(())
}

fn cpu(raw: u32) -> Result<Machine> {
    match raw {0x01000007 => Ok(Machine::X64),0x0100000c => Ok(Machine::Arm64),_ => Err("Mach-O CPU 不受支持".into())}
}
fn macho_thin(file:&mut File, base:u64, size:u64, expected:Machine, role:Role) -> Result<()> {
    let head = read_at(file,base,size,0,32)?;
    // 64 位小端 MH_MAGIC_64 的磁盘字节是 CF FA ED FE；大端是 FE ED FA CF。
    let little = match &head[..4] {b"\xcf\xfa\xed\xfe" => true,b"\xfe\xed\xfa\xcf" => false,_ => return Err("Java Mach-O 必须为 64 位 thin slice".into())};
    // 当前支持的 x86_64/arm64 macOS ABI 都是小端；不能把伪造的大端 slice 当作可运行包。
    if !little || cpu(u32_at(&head,4,little)?)? != expected { return Err("Mach-O slice 架构或字节序不匹配".into()); }
    let subtype = u32_at(&head,8,little)?;
    if subtype != match expected {Machine::X64=>3,Machine::Arm64=>0} { return Err("Mach-O CPU 子类型需要额外能力，不能作为通用目标 Java".into()); }
    let kind = u32_at(&head,12,little)?;
    if (role == Role::Launcher && kind != 2) || (role == Role::Library && !matches!(kind,6|8)) { return Err("Mach-O 文件类型不匹配".into()); }
    let count = u32_at(&head,16,little)? as usize;
    let length = u32_at(&head,20,little)? as usize;
    if count == 0 || count > 4096 || length > HEADER_CAP as usize || length < count*8 { return Err("Mach-O load command 数量无效".into()); }
    let commands = read_at(file,base,size,32,length)?;
    let mut offset = 0usize;
    let mut seen_platform = false;
    for _ in 0..count {
        if offset+8 > commands.len() { return Err("Mach-O load command 被截断".into()); }
        let command = u32_at(&commands,offset,little)?;
        let length = u32_at(&commands,offset+4,little)? as usize;
        let end = offset.checked_add(length).filter(|end| *end <= commands.len()).ok_or("Mach-O load command 越界")?;
        if length < 8 || length%8 != 0 { return Err("Mach-O load command 长度无效".into()); }
        let data = &commands[offset..end];
        if command == 0x32 {
            if seen_platform || length < 24 || u32_at(data,8,little)? != 1 { return Err("Mach-O 不是唯一的 macOS 平台声明".into()); }
            let tools = u32_at(data,20,little)? as usize;
            if tools > 128 || 24+tools*8 != length { return Err("Mach-O 构建版本命令无效".into()); }
            seen_platform = true;
        } else if matches!(command,0x25|0x2f|0x30) { return Err("Mach-O 移动平台不受支持".into()); }
        else if command == 0x24 {
            if seen_platform || length != 16 { return Err("Mach-O macOS 最低版本命令无效或重复".into()); }
            seen_platform = true;
        } else if command == 0x19 {
            // LC_SEGMENT_64 的文件段与节声明也必须在当前 slice 内。
            if length < 72 { return Err("Mach-O SEGMENT_64 被截断".into()); }
            let start = u64_at(data,40,little)?;
            let bytes = u64_at(data,48,little)?;
            let sections = u32_at(data,64,little)? as usize;
            if sections > 4096 || 72+sections*80 != length || start.checked_add(bytes).filter(|end|*end<=size).is_none() {
                return Err("Mach-O SEGMENT_64 越界".into());
            }
        }
        offset=end;
    }
    if offset != commands.len() || !seen_platform { return Err("Mach-O 缺少 macOS 平台声明或 load command 有多余数据".into()); }
    Ok(())
}
fn macho(file:&mut File,size:u64,expected:Machine,role:Role)->Result<()> {
    let magic = read_at(file,0,size,0,8)?;
    let (little, wide) = match &magic[..4] {
        b"\xca\xfe\xba\xbe" => (false,false),b"\xbe\xba\xfe\xca" => (true,false),
        b"\xca\xfe\xba\xbf" => (false,true),b"\xbf\xba\xfe\xca" => (true,true),
        _ => return macho_thin(file,0,size,expected,role),
    };
    let count = u32_at(&magic,4,little)? as usize;
    if count == 0 || count > FAT_CAP { return Err("Mach-O fat slice 数量无效".into()); }
    let width = if wide {32} else {20};
    let table = read_at(file,0,size,8,count*width)?;
    let lower = 8+(count*width) as u64;
    let mut ranges = Vec::new(); let mut selected = None; let mut seen = BTreeSet::new();
    for row in table.chunks_exact(width) {
        let raw_cpu = u32_at(row,0,little)?;
        if !seen.insert(raw_cpu) { return Err("Mach-O fat 含重复 CPU slice".into()); }
        let start = if wide {u64_at(row,8,little)?} else {u32_at(row,8,little)? as u64};
        let length = if wide {u64_at(row,16,little)?} else {u32_at(row,12,little)? as u64};
        let align = u32_at(row,if wide {24} else {16},little)?;
        if align > 31 || (wide && u32_at(row,28,little)? != 0) || start < lower || length < 32
            || start%(1u64<<align) != 0 || start.checked_add(length).filter(|end| *end <= size).is_none() { return Err("Mach-O fat slice 越界或对齐无效".into()); }
        if ranges.iter().any(|(a,b)|start<*b && start+length>*a) { return Err("Mach-O fat slice 相互覆盖".into()); }
        ranges.push((start,start+length));
        if cpu(raw_cpu).ok() == Some(expected) {
            let thin = read_at(file,start,length,0,12)?;
            if &thin[..4] != b"\xcf\xfa\xed\xfe" || u32_at(&thin,4,true)? != raw_cpu || u32_at(&thin,8,true)? != u32_at(row,4,little)? {
                return Err("Mach-O fat 表与目标 thin slice 不一致".into());
            }
            selected=Some((start,length));
        }
    }
    let (start,length) = selected.ok_or("Mach-O fat 缺少目标 CPU slice")?;
    macho_thin(file,start,length,expected,role)
}

fn verify(path:&Path,os:Os,machine:Machine,role:Role)->Result<()> {
    let mut file=open_checked(path)?;
    let before=regular(&file)?;
    match os {Os::Windows=>pe(&mut file,before.len(),machine,role)?,Os::Linux=>elf(&mut file,before.len(),machine,role)?,Os::Mac=>macho(&mut file,before.len(),machine,role)?,}
    let after=regular(&file)?;
    checked_path(path)?;
    if !same_file(&before,&after) || !same_file(&after,&fs::symlink_metadata(path).map_err(|_|"Java 文件在校验后消失")?) {return Err("Java 二进制在检查时改变".into());}
    Ok(())
}

fn native_name(name:&str,os:Os)->bool {
    match os {Os::Windows=>name.to_ascii_lowercase().ends_with(".dll"),Os::Linux=>name.ends_with(".so")||name.contains(".so."),Os::Mac=>name.ends_with(".dylib")||name.ends_with(".jnilib")}
}
fn expected_native(name:&str,os:Os,stem:&str)->bool {
    match os {Os::Windows=>name.eq_ignore_ascii_case(&format!("{stem}.dll")),Os::Linux=>name==format!("lib{stem}.so"),Os::Mac=>name==format!("lib{stem}.dylib")}
}
fn runtime_library(path:&Path,home:&Path,os:Os)->bool {
    let Ok(relative)=path.strip_prefix(home) else {return false;};
    let parts:Vec<_>=relative.components().filter_map(|part|part.as_os_str().to_str()).collect();
    let prefix=if os==Os::Windows {"bin"} else {"lib"};
    let equal=|left:&str,right:&str|if os==Os::Windows {left.eq_ignore_ascii_case(right)} else {left==right};
    parts.len()>=2 && (equal(parts[0],prefix) || (parts.len()>=3 && equal(parts[0],"jre") && equal(parts[1],prefix)))
}

/// 返回私有 payload 内唯一且核心库匹配的 bin/java；os/arch 必须来自可信包元数据。
pub(super) fn find_java(payload:&Path,os:&str,arch:&str)->Result<PathBuf> {
    let (os,machine)=target(os,arch)?;
    checked_path(payload)?;
    let payload=fs::canonicalize(payload).map_err(|_|"Java payload 无法规范化")?;
    checked_path(&payload)?;
    let mut inventory=Inventory {files:Vec::new(),entries:0,bytes:0};
    walk(&payload,0,&mut inventory)?;
    let java_name=if os==Os::Windows {"java.exe"} else {"java"};
    let candidates:Vec<_>=inventory.files.iter().filter(|path|path.file_name().and_then(|s|s.to_str())==Some(java_name)
        && path.parent().and_then(Path::file_name).and_then(|s|s.to_str())==Some("bin")).collect();
    // 两个入口即拒绝，不能随枚举顺序挑一个、或跳过损坏入口后悄悄改选另一个。
    if candidates.len()!=1 {return Err("Java 包必须包含唯一的 bin/java 启动器".into());}
    let java=candidates[0];
    let home=java.parent().and_then(Path::parent).ok_or("Java 主目录无效")?;
    verify(java,os,machine,Role::Launcher)?;
    let mut jvm=0usize;let mut core=BTreeSet::new();
    for path in &inventory.files {
        let name=path.file_name().and_then(|s|s.to_str()).ok_or("Java 文件名无效")?;
        if !native_name(name,os) {continue;}
        verify(path,os,machine,Role::Library)?;
        for stem in ["jvm","java","jli","net","nio","zip"] {
            if expected_native(name,os,stem) && runtime_library(path,home,os) {
                core.insert(stem); if stem=="jvm" {jvm+=1;}
            }
        }
    }
    // Windows 的 JLI 可静态链接到 java.exe；Linux/macOS 发行版由 libjli 动态启动。
    if jvm==0 || !["java","net","nio","zip"].iter().all(|stem|core.contains(stem)) || (os!=Os::Windows && !core.contains("jli")) {
        return Err("Java 包缺少目标运行根中的 libjvm 或核心本机库".into());
    }
    // macOS Contents/Home 会由相同 bin/java 规则定位，不把包外其它 Home 当作可选入口。
    checked_path(&payload)?;
    Ok(java.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 全部程序头与目录都是合成数据：不下载官方包，不调用 Command，也不执行 Java。
    struct TempRoot(PathBuf);
    impl TempRoot {
        fn new() -> Self {
            let base=fs::canonicalize(std::env::temp_dir()).expect("规范化夹具临时目录");
            let path=base.join(format!("hcmcl-java-binary-{}",uuid::Uuid::new_v4()));
            fs::create_dir(&path).expect("创建独立夹具目录"); Self(path)
        }
        fn put(&self,name:&str,bytes:&[u8])->PathBuf {
            let path=self.0.join(name); fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path,bytes).unwrap(); path
        }
    }
    impl Drop for TempRoot { fn drop(&mut self) { let _=fs::remove_dir_all(&self.0); } }
    fn put16(bytes:&mut [u8],offset:usize,value:u16,little:bool) {bytes[offset..offset+2].copy_from_slice(&if little {value.to_le_bytes()} else {value.to_be_bytes()});}
    fn put32(bytes:&mut [u8],offset:usize,value:u32,little:bool) {bytes[offset..offset+4].copy_from_slice(&if little {value.to_le_bytes()} else {value.to_be_bytes()});}
    fn put64(bytes:&mut [u8],offset:usize,value:u64,little:bool) {bytes[offset..offset+8].copy_from_slice(&if little {value.to_le_bytes()} else {value.to_be_bytes()});}
    fn machine_name(machine:Machine)->&'static str {match machine {Machine::X64=>"x64",Machine::Arm64=>"aarch64"}}
    fn pe_bytes(machine:Machine,role:Role)->Vec<u8> {
        let mut bytes=vec![0;512]; bytes[..2].copy_from_slice(b"MZ"); put32(&mut bytes,60,64,true);
        bytes[64..68].copy_from_slice(b"PE\0\0"); put16(&mut bytes,68,match machine {Machine::X64=>0x8664,Machine::Arm64=>0xaa64},true);
        put16(&mut bytes,70,1,true); put16(&mut bytes,84,112,true); put16(&mut bytes,86,2|if role==Role::Library {0x2000} else {0},true);
        put16(&mut bytes,88,0x20b,true); put16(&mut bytes,156,3,true);
        bytes[200..205].copy_from_slice(b".text"); put32(&mut bytes,216,256,true); put32(&mut bytes,220,256,true);
        bytes
    }
    fn interpreter(machine:Machine)->&'static str {match machine {Machine::X64=>"/lib64/ld-linux-x86-64.so.2",Machine::Arm64=>"/lib/ld-linux-aarch64.so.1"}}
    fn elf_bytes(machine:Machine,role:Role)->Vec<u8> {
        let mut bytes=vec![0;512]; bytes[..4].copy_from_slice(b"\x7fELF"); bytes[4]=2;bytes[5]=1;bytes[6]=1;
        put16(&mut bytes,16,3,true);put16(&mut bytes,18,match machine {Machine::X64=>62,Machine::Arm64=>183},true);
        put32(&mut bytes,20,1,true);put64(&mut bytes,32,64,true);put16(&mut bytes,52,64,true);
        put16(&mut bytes,54,56,true);put16(&mut bytes,56,if role==Role::Launcher {2} else {1},true);
        put32(&mut bytes,64,1,true);put64(&mut bytes,96,512,true);put64(&mut bytes,104,512,true);
        if role==Role::Launcher {
            let text=interpreter(machine).as_bytes();put32(&mut bytes,120,3,true);put64(&mut bytes,128,256,true);
            put64(&mut bytes,152,(text.len()+1) as u64,true);put64(&mut bytes,160,(text.len()+1) as u64,true);
            bytes[256..256+text.len()].copy_from_slice(text);
        }
        bytes
    }
    fn raw_cpu(machine:Machine)->u32 {match machine {Machine::X64=>0x01000007,Machine::Arm64=>0x0100000c}}
    fn raw_subtype(machine:Machine)->u32 {match machine {Machine::X64=>3,Machine::Arm64=>0}}
    fn macho_bytes(machine:Machine,role:Role,old:bool)->Vec<u8> {
        let mut bytes=vec![0;512];bytes[..4].copy_from_slice(b"\xcf\xfa\xed\xfe");
        put32(&mut bytes,4,raw_cpu(machine),true);put32(&mut bytes,8,raw_subtype(machine),true);
        put32(&mut bytes,12,if role==Role::Launcher {2} else {6},true);put32(&mut bytes,16,1,true);
        let length=if old {16} else {24};put32(&mut bytes,20,length,true);
        put32(&mut bytes,32,if old {0x24} else {0x32},true);put32(&mut bytes,36,length,true);
        put32(&mut bytes,40,if old {0x000a0900} else {1},true);bytes
    }
    fn fat_bytes(role:Role,wide:bool,little:bool)->Vec<u8> {
        let mut bytes=vec![0;1536];
        bytes[..4].copy_from_slice(match (wide,little) {(false,false)=>b"\xca\xfe\xba\xbe",(false,true)=>b"\xbe\xba\xfe\xca",(true,false)=>b"\xca\xfe\xba\xbf",(true,true)=>b"\xbf\xba\xfe\xca"});
        put32(&mut bytes,4,2,little); let width=if wide {32} else {20};
        for (index,machine) in [Machine::X64,Machine::Arm64].into_iter().enumerate() {
            let row=8+index*width; let start=512+index*512;
            put32(&mut bytes,row,raw_cpu(machine),little);put32(&mut bytes,row+4,raw_subtype(machine),little);
            if wide {put64(&mut bytes,row+8,start as u64,little);put64(&mut bytes,row+16,512,little);put32(&mut bytes,row+24,9,little);}
            else {put32(&mut bytes,row+8,start as u32,little);put32(&mut bytes,row+12,512,little);put32(&mut bytes,row+16,9,little);}
            bytes[start..start+512].copy_from_slice(&macho_bytes(machine,role,false));
        }
        bytes
    }
    fn header(bytes:&[u8],os:Os,machine:Machine,role:Role)->Result<()> {
        let root=TempRoot::new();let path=root.put("header",bytes);verify(&path,os,machine,role)
    }
    fn runtime(root:&TempRoot,os:Os,machine:Machine,old:bool,fat:bool)->PathBuf {
        let home=if os==Os::Mac {"package/Contents/Home"} else {"package"};
        let java=root.put(&format!("{home}/bin/{}",if os==Os::Windows {"java.exe"} else {"java"}),
            &match os {Os::Windows=>pe_bytes(machine,Role::Launcher),Os::Linux=>elf_bytes(machine,Role::Launcher),Os::Mac=>if fat {fat_bytes(Role::Launcher,false,false)} else {macho_bytes(machine,Role::Launcher,old)}});
        let directory=match (os,old) {(Os::Windows,_)=>format!("{home}/bin"),(Os::Linux,true)=>format!("{home}/lib/{}",if machine==Machine::X64 {"amd64"} else {"aarch64"}),_=>format!("{home}/lib")};
        for stem in ["jvm","java","net","nio","zip","jli"] {
            if os==Os::Windows && stem=="jli" {continue;}
            let name=match os {Os::Windows=>format!("{stem}.dll"),Os::Linux=>format!("lib{stem}.so"),Os::Mac=>format!("lib{stem}.dylib")};
            let sub=if stem=="jvm" {"server/"} else if stem=="jli" && old {"jli/"} else {""};
            let bytes=match os {Os::Windows=>pe_bytes(machine,Role::Library),Os::Linux=>elf_bytes(machine,Role::Library),Os::Mac=>if fat {fat_bytes(Role::Library,true,false)} else {macho_bytes(machine,Role::Library,old)}};
            root.put(&format!("{directory}/{sub}{name}"),&bytes);
        }
        java
    }

    #[test] fn target_metadata_is_explicit_and_never_inferred_from_host() {
        assert_eq!(target("windows","x64").unwrap(),(Os::Windows,Machine::X64));
        assert_eq!(target("mac","aarch64").unwrap(),(Os::Mac,Machine::Arm64));
        for (os,arch) in [("android","aarch64"),("linux","arm64"),("darwin","x64"),("windows","x86")] {assert!(target(os,arch).is_err());}
    }
    #[test] fn pe_launcher_and_dll_headers_match_cpu_and_role() {
        for machine in [Machine::X64,Machine::Arm64] {for role in [Role::Launcher,Role::Library] {
            let bytes=pe_bytes(machine,role);header(&bytes,Os::Windows,machine,role).unwrap();
            assert!(header(&bytes,Os::Linux,machine,role).is_err());assert!(header(&bytes,Os::Windows,machine,if role==Role::Launcher {Role::Library} else {Role::Launcher}).is_err());
            assert!(header(&bytes,Os::Windows,if machine==Machine::X64 {Machine::Arm64} else {Machine::X64},role).is_err());
        }}
    }
    #[test] fn pe_rejects_truncated_optional_headers_sections_and_dos_offsets() {
        let base=pe_bytes(Machine::X64,Role::Launcher);
        for length in [0,63,87,199,239,511] {assert!(header(&base[..length],Os::Windows,Machine::X64,Role::Launcher).is_err(),"length={length}");}
        for (offset,value) in [(60,u32::MAX),(220,500),(216,u32::MAX)] {
            let mut bytes=base.clone();put32(&mut bytes,offset,value,true);assert!(header(&bytes,Os::Windows,Machine::X64,Role::Launcher).is_err());
        }
        let mut bytes=base;put16(&mut bytes,88,0x10b,true);assert!(header(&bytes,Os::Windows,Machine::X64,Role::Launcher).is_err());
    }
    #[test] fn linux_elf_requires_exact_class_endian_cpu_and_linux_interpreter() {
        for machine in [Machine::X64,Machine::Arm64] {
            header(&elf_bytes(machine,Role::Launcher),Os::Linux,machine,Role::Launcher).unwrap();
            header(&elf_bytes(machine,Role::Library),Os::Linux,machine,Role::Library).unwrap();
            assert!(header(&elf_bytes(machine,Role::Library),Os::Linux,machine,Role::Launcher).is_err());
        }
        let base=elf_bytes(Machine::X64,Role::Launcher);
        for (offset,value) in [(4,1),(5,0),(5,2),(6,0),(7,9),(8,1)] {let mut bytes=base.clone();bytes[offset]=value;assert!(header(&bytes,Os::Linux,Machine::X64,Role::Launcher).is_err());}
        let mut bytes=base.clone();bytes[256..320].fill(0);let linker=b"/system/bin/linker64\0";bytes[256..256+linker.len()].copy_from_slice(linker);put64(&mut bytes,152,linker.len() as u64,true);
        assert!(header(&bytes,Os::Linux,Machine::X64,Role::Launcher).is_err());
        let mut bytes=base;put16(&mut bytes,18,183,true);assert!(header(&bytes,Os::Linux,Machine::X64,Role::Launcher).is_err());
    }
    #[test] fn elf_program_ranges_and_truncation_are_bounded() {
        let base=elf_bytes(Machine::Arm64,Role::Launcher);
        for length in [0,63,119,175,270,511] {assert!(header(&base[..length],Os::Linux,Machine::Arm64,Role::Launcher).is_err());}
        for (offset,value) in [(32,u64::MAX),(96,u64::MAX),(128,510),(152,1024)] {let mut bytes=base.clone();put64(&mut bytes,offset,value,true);assert!(header(&bytes,Os::Linux,Machine::Arm64,Role::Launcher).is_err());}
        let mut bytes=base;put16(&mut bytes,56,65535,true);assert!(header(&bytes,Os::Linux,Machine::Arm64,Role::Launcher).is_err());
    }
    #[test] fn mac_thin_requires_unique_macos_platform_and_expected_role() {
        for machine in [Machine::X64,Machine::Arm64] {for old in [false,true] {for role in [Role::Launcher,Role::Library] {
            header(&macho_bytes(machine,role,old),Os::Mac,machine,role).unwrap();
        }}}
        let base=macho_bytes(Machine::Arm64,Role::Launcher,false);
        let mut bytes=base.clone();put32(&mut bytes,40,2,true);assert!(header(&bytes,Os::Mac,Machine::Arm64,Role::Launcher).is_err());
        let mut bytes=base.clone();put32(&mut bytes,32,0x19,true);assert!(header(&bytes,Os::Mac,Machine::Arm64,Role::Launcher).is_err());
        let mut bytes=base.clone();put32(&mut bytes,16,2,true);put32(&mut bytes,20,48,true);bytes[56..80].copy_from_slice(&base[32..56]);assert!(header(&bytes,Os::Mac,Machine::Arm64,Role::Launcher).is_err());
        let mut bytes=base.clone();put32(&mut bytes,8,2,true);assert!(header(&bytes,Os::Mac,Machine::Arm64,Role::Launcher).is_err());
        let mut bytes=base.clone();bytes[..4].copy_from_slice(b"\xfe\xed\xfa\xcf");assert!(header(&bytes,Os::Mac,Machine::Arm64,Role::Launcher).is_err());
        assert!(header(&base,Os::Mac,Machine::X64,Role::Launcher).is_err());assert!(header(&base,Os::Mac,Machine::Arm64,Role::Library).is_err());
    }
    #[test] fn mac_load_commands_and_segments_reject_out_of_slice_ranges() {
        let base=macho_bytes(Machine::X64,Role::Library,false);
        for length in [0,31,55] {assert!(header(&base[..length],Os::Mac,Machine::X64,Role::Library).is_err());}
        for value in [0,7,9,u32::MAX] {let mut bytes=base.clone();put32(&mut bytes,36,value,true);assert!(header(&bytes,Os::Mac,Machine::X64,Role::Library).is_err());}
        let mut bytes=base;put32(&mut bytes,16,2,true);put32(&mut bytes,20,96,true);put32(&mut bytes,56,0x19,true);put32(&mut bytes,60,72,true);put64(&mut bytes,96,500,true);put64(&mut bytes,104,50,true);
        assert!(header(&bytes,Os::Mac,Machine::X64,Role::Library).is_err());
    }
    #[test] fn mac_fat_selects_target_after_first_slice_for_both_table_formats_and_orders() {
        for wide in [false,true] {for little in [false,true] {for role in [Role::Launcher,Role::Library] {
            let bytes=fat_bytes(role,wide,little);
            header(&bytes,Os::Mac,Machine::X64,role).unwrap();header(&bytes,Os::Mac,Machine::Arm64,role).unwrap();
        }}}
    }
    #[test] fn mac_fat_rejects_missing_duplicate_overlap_bounds_and_table_mismatch() {
        let base=fat_bytes(Role::Launcher,false,false);
        let mut bytes=base.clone();put32(&mut bytes,4,1,false);assert!(header(&bytes,Os::Mac,Machine::Arm64,Role::Launcher).is_err());
        let mut bytes=base.clone();put32(&mut bytes,28,raw_cpu(Machine::X64),false);assert!(header(&bytes,Os::Mac,Machine::Arm64,Role::Launcher).is_err());
        for (offset,value) in [(36,512),(36,u32::MAX),(40,u32::MAX),(44,32),(4,65)] {let mut bytes=base.clone();put32(&mut bytes,offset,value,false);assert!(header(&bytes,Os::Mac,Machine::Arm64,Role::Launcher).is_err());}
        let mut bytes=base.clone();put32(&mut bytes,1032,3,true);assert!(header(&bytes,Os::Mac,Machine::Arm64,Role::Launcher).is_err());
        let mut bytes=base.clone();put32(&mut bytes,1064,2,true);assert!(header(&bytes,Os::Mac,Machine::Arm64,Role::Launcher).is_err());
        assert!(header(&base[..1200],Os::Mac,Machine::Arm64,Role::Launcher).is_err());
        let mut bytes=fat_bytes(Role::Library,true,false);put64(&mut bytes,48,u64::MAX,false);assert!(header(&bytes,Os::Mac,Machine::Arm64,Role::Library).is_err());
    }
    #[test] fn synthetic_jre8_and_jre17_trees_have_verified_launcher_and_all_core_libraries() {
        for os in [Os::Windows,Os::Linux,Os::Mac] {for old in [false,true] {for machine in [Machine::X64,Machine::Arm64] {
            let root=TempRoot::new();let java=runtime(&root,os,machine,old,false);
            let name=match os {Os::Windows=>"windows",Os::Linux=>"linux",Os::Mac=>"mac"};
            assert_eq!(find_java(&root.0,name,machine_name(machine)).unwrap(),java);
        }}}
    }
    #[test] fn mac_contents_home_and_fat_core_libraries_use_target_slice_not_first_slice() {
        let root=TempRoot::new();let java=runtime(&root,Os::Mac,Machine::Arm64,false,true);
        assert_eq!(find_java(&root.0,"mac","aarch64").unwrap(),java);
        root.put("package/Contents/Home/lib/libzip.dylib",&macho_bytes(Machine::X64,Role::Library,false));
        assert!(find_java(&root.0,"mac","aarch64").is_err());
    }
    #[test] fn missing_mismatched_or_unrelated_core_libraries_never_complete_a_runtime() {
        for stem in ["jvm","java","net","nio","zip","jli"] {
            let root=TempRoot::new();runtime(&root,Os::Linux,Machine::X64,false,false);
            let relative=if stem=="jvm" {"package/lib/server/libjvm.so".to_string()} else {format!("package/lib/lib{stem}.so")};
            fs::remove_file(root.0.join(&relative)).unwrap();root.put(&format!("unrelated/lib/lib{stem}.so"),&elf_bytes(Machine::X64,Role::Library));
            assert!(find_java(&root.0,"linux","x64").is_err(),"stem={stem}");
        }
        let root=TempRoot::new();runtime(&root,Os::Windows,Machine::X64,false,false);
        root.put("package/bin/net.dll",&pe_bytes(Machine::Arm64,Role::Library));assert!(find_java(&root.0,"windows","x64").is_err());
        root.put("package/bin/net.dll",&elf_bytes(Machine::X64,Role::Library));assert!(find_java(&root.0,"windows","x64").is_err());
        let root=TempRoot::new();runtime(&root,Os::Linux,Machine::X64,false,false);
        root.put("package/lib/server/libjvm.so",&elf_bytes(Machine::Arm64,Role::Library));assert!(find_java(&root.0,"linux","x64").is_err());
        let root=TempRoot::new();runtime(&root,Os::Mac,Machine::Arm64,true,false);
        root.put("package/Contents/Home/lib/server/libjvm.dylib",&macho_bytes(Machine::X64,Role::Library,true));assert!(find_java(&root.0,"mac","aarch64").is_err());
    }
    #[test] fn every_discovered_native_is_checked_and_multiple_launchers_are_rejected() {
        let root=TempRoot::new();runtime(&root,Os::Windows,Machine::X64,false,false);
        root.put("package/bin/extra.dll",&pe_bytes(Machine::Arm64,Role::Library));assert!(find_java(&root.0,"windows","x64").is_err());
        fs::remove_file(root.0.join("package/bin/extra.dll")).unwrap();root.put("other/bin/java.exe",b"not executable");
        assert!(find_java(&root.0,"windows","x64").is_err());
        assert!(find_java(&root.0,"linux","x64").is_err());
    }
    #[test] fn hardlinks_anywhere_in_payload_are_rejected_before_header_selection() {
        let root=TempRoot::new();runtime(&root,Os::Windows,Machine::X64,false,false);
        let original=root.put("readme",b"synthetic");fs::hard_link(original,root.0.join("readme-copy")).unwrap();
        assert!(find_java(&root.0,"windows","x64").is_err());
    }
    #[cfg(unix)]
    #[test] fn symlink_file_directory_and_ancestor_are_rejected() {
        use std::os::unix::fs::symlink;
        let root=TempRoot::new();runtime(&root,Os::Linux,Machine::X64,false,false);
        symlink("package/lib",root.0.join("alias")).unwrap();assert!(find_java(&root.0,"linux","x64").is_err());fs::remove_file(root.0.join("alias")).unwrap();
        symlink("package/bin/java",root.0.join("alias")).unwrap();assert!(find_java(&root.0,"linux","x64").is_err());fs::remove_file(root.0.join("alias")).unwrap();
        let outer=TempRoot::new();symlink(&root.0,outer.0.join("link")).unwrap();assert!(find_java(&outer.0.join("link"),"linux","x64").is_err());
    }
    #[test] fn depth_entry_file_size_and_total_budgets_are_enforced_without_loading_payload() {
        let root=TempRoot::new();root.put("one",b"x");
        let inventory=||Inventory {files:vec![],entries:0,bytes:0};
        assert!(walk(&root.0,DEPTH_CAP+1,&mut inventory()).is_err());
        let mut entries=inventory();entries.entries=ENTRY_CAP;assert!(walk(&root.0,0,&mut entries).is_err());
        let mut total=inventory();total.bytes=TOTAL_CAP;assert!(walk(&root.0,0,&mut total).is_err());
        let file=File::create(root.0.join("sparse")).unwrap();file.set_len(FILE_CAP+1).unwrap();drop(file);
        assert!(walk(&root.0,0,&mut inventory()).is_err());
        assert!(checked_path(Path::new("relative/bin/java")).is_err());assert!(find_java(&root.0.join(".."),"linux","x64").is_err());
    }
}

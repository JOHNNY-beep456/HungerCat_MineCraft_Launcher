//! 只读硬件快照；型号年份与虚拟化特征沿用 Electron 合同，不参与设置决策。
use serde_json::{json, Value};
use std::sync::OnceLock;

struct Snapshot { cores: u32, model: String, total_bytes: u64 }

fn unavailable() -> String {
    super::tr("无法取得有效的处理器数量或物理内存总量", "無法取得有效的處理器數量或實體記憶體總量", "Unable to read a valid processor count or total physical memory")
}

fn snapshot_value(snapshot: Snapshot) -> Result<Value, String> {
    let total_mb = snapshot.total_bytes.checked_add(524_288).ok_or_else(unavailable)? / 1_048_576;
    if snapshot.cores == 0 || snapshot.total_bytes == 0 || total_mb == 0 { return Err(unavailable()); }
    let model = checked_model(&snapshot.model).unwrap_or_default();
    let lower = model.to_lowercase();
    // false 仅代表型号未命中特征；不能据此证明是物理机。
    let virtual_machine = VM_MARKERS.iter().any(|marker| lower.contains(*marker));
    Ok(json!({"cpuCores":snapshot.cores,"cpuModel":model,"cpuYear":estimate_year(&lower),"isVirtualMachine":virtual_machine,"totalMemMb":total_mb}))
}

fn checked_model(value: &str) -> Option<String> {
    let model = value.trim();
    if model.len() > 4096 || model.chars().any(char::is_control) { return None; }
    Some(model.to_owned())
}

const VM_MARKERS: [&str; 17] = [
    "virtual", "qemu", "vmware", "virtualbox", "vbox", "kvm", "hyper-v", "hyperv", "microsoft hv",
    "xen", "bochs", "parallels", "bhyve", "openstack", "amazon ec2", "google compute", "droplet",
];

fn estimate_year(model: &str) -> u32 {
    static PATTERNS: OnceLock<[regex::Regex; 4]> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| [
        regex::Regex::new(r"i[3579][-_ ]?([0-9]{4,5})").expect("固定 Core 正则无效"),
        regex::Regex::new(r"ryzen\s*(?:[3579]\s*)?([0-9])([0-9]{3})").expect("固定 Ryzen 正则无效"),
        regex::Regex::new(r"fx|phenom|athlon|a[0-9]{1,2}-[0-9]|sempron|opteron").expect("固定 AMD 正则无效"),
        regex::Regex::new(r"v([0-9])(?-u:\b)").expect("固定 Xeon 正则无效"),
    ]);
    if let Some(found) = patterns[0].captures(model) {
        let digits = &found[1];
        let generation = digits[..if digits.len() >= 5 { 2 } else { 1 }].parse::<usize>().unwrap_or(0);
        const YEARS: [u32; 15] = [0,2008,2011,2012,2013,2014,2015,2016,2017,2018,2020,2021,2021,2022,2023];
        if let Some(year) = YEARS.get(generation).filter(|year| **year != 0) { return *year; }
    }
    if let Some(found) = patterns[1].captures(model) {
        let series = found[1].parse::<usize>().unwrap_or(0);
        const YEARS: [u32; 10] = [0,2017,2018,2019,2020,2020,2021,2022,2024,2024];
        if let Some(year) = YEARS.get(series).filter(|year| **year != 0) { return *year; }
    }
    if patterns[2].is_match(model) { return 2014; }
    if model.contains("xeon") {
        return patterns[3].captures(model).map(|found| 2013 + found[1].parse::<u32>().unwrap_or(0).saturating_sub(3)).unwrap_or(2013);
    }
    0
}

pub(super) fn hardware_info() -> Result<Value, String> { snapshot_value(platform_snapshot()?) }

#[cfg(any(windows, test))]
fn registry_model(status: i32, kind: u32, units: &[u16], byte_count: u32) -> Option<String> {
    let count = usize::try_from(byte_count).ok()?;
    if status != 0 || kind != 1 || count < 2 || count % 2 != 0 || count / 2 > units.len() { return None; }
    let units = &units[..count / 2];
    if units.last() != Some(&0) || units[..units.len() - 1].contains(&0) { return None; }
    checked_model(&String::from_utf16(&units[..units.len() - 1]).ok()?)
}

#[cfg(any(windows, test))]
fn windows_snapshot(cores: u32, memory_status: i32, total_bytes: u64, model: Option<String>) -> Result<Snapshot, String> {
    if cores == 0 || memory_status == 0 || total_bytes == 0 { return Err(unavailable()); }
    Ok(Snapshot { cores,model:model.unwrap_or_default(),total_bytes })
}

#[cfg(windows)]
fn platform_snapshot() -> Result<Snapshot, String> {
    use std::ffi::c_void;
    #[repr(C)]
    struct MemoryStatus { length: u32, load: u32, total_phys: u64, avail_phys: u64, total_page: u64, avail_page: u64, total_virtual: u64, avail_virtual: u64, avail_extended: u64 }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetActiveProcessorCount(group: u16) -> u32;
        fn GlobalMemoryStatusEx(status: *mut MemoryStatus) -> i32;
    }
    #[link(name = "advapi32")]
    extern "system" {
        fn RegGetValueW(key: *mut c_void, subkey: *const u16, name: *const u16, flags: u32, kind: *mut u32, data: *mut c_void, bytes: *mut u32) -> i32;
    }
    // ALL_PROCESSOR_GROUPS，不能只统计调用线程所在的 Windows 处理器组。
    let cores = unsafe { GetActiveProcessorCount(0xffff) };
    let mut memory = MemoryStatus { length: std::mem::size_of::<MemoryStatus>() as u32,load:0,total_phys:0,avail_phys:0,total_page:0,avail_page:0,total_virtual:0,avail_virtual:0,avail_extended:0 };
    let memory_status = unsafe { GlobalMemoryStatusEx(&mut memory) };
    if cores == 0 || memory_status == 0 || memory.total_phys == 0 { return Err(unavailable()); }
    let subkey = "HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0".encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let name = "ProcessorNameString".encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let mut units = [0u16; 2048]; let mut bytes = (units.len() * 2) as u32; let mut kind = 0u32;
    // HKLM 固定只读 REG_SZ；只在指定子键使用 64 位视图，没有枚举或写注册表。
    let hklm = 0x80000002u32 as i32 as isize as *mut c_void;
    let status = unsafe { RegGetValueW(hklm,subkey.as_ptr(),name.as_ptr(),0x00010002,&mut kind,units.as_mut_ptr().cast(),&mut bytes) };
    windows_snapshot(cores,memory_status,memory.total_phys,registry_model(status,kind,&units,bytes))
}

#[cfg(any(target_os = "macos", test))]
fn sysctl_number(bytes: &[u8], signed: bool) -> Option<u64> {
    // hw.logicalcpu 是 int，hw.memsize 是 uint64_t；只接受预期的固定 ABI 大小。
    if signed {
        let value = i32::from_ne_bytes(bytes.try_into().ok()?);
        (value > 0).then_some(value as u64)
    } else {
        let value = u64::from_ne_bytes(bytes.try_into().ok()?);
        (value > 0).then_some(value)
    }
}

#[cfg(any(target_os = "macos", test))]
fn sysctl_model(bytes: &[u8]) -> Option<String> {
    if bytes.len() > 4097 || bytes.last() != Some(&0) || bytes[..bytes.len() - 1].contains(&0) { return None; }
    checked_model(std::str::from_utf8(&bytes[..bytes.len() - 1]).ok()?)
}

#[cfg(target_os = "macos")]
fn platform_snapshot() -> Result<Snapshot, String> {
    use std::{ffi::c_void, os::raw::c_char, ptr};
    extern "C" {
        fn sysctlbyname(name: *const c_char, old: *mut c_void, old_len: *mut usize, new: *mut c_void, new_len: usize) -> i32;
    }
    fn read(name: &[u8], limit: usize) -> Option<Vec<u8>> {
        let mut bytes = vec![0u8; limit]; let mut length = limit;
        // 名称为本模块固定 NUL 结尾常量；单次有界调用，不使用外部命令。
        if unsafe { sysctlbyname(name.as_ptr().cast(),bytes.as_mut_ptr().cast(),&mut length,ptr::null_mut(),0) } != 0 || length > limit { return None; }
        bytes.truncate(length); Some(bytes)
    }
    let cores = read(b"hw.logicalcpu\0",4).and_then(|bytes| sysctl_number(&bytes,true)).and_then(|value| u32::try_from(value).ok()).ok_or_else(unavailable)?;
    let total_bytes = read(b"hw.memsize\0",8).and_then(|bytes| sysctl_number(&bytes,false)).ok_or_else(unavailable)?;
    let model = read(b"machdep.cpu.brand_string\0",4097).and_then(|bytes| sysctl_model(&bytes)).unwrap_or_default();
    Ok(Snapshot { cores,model,total_bytes })
}

#[cfg(not(any(windows, target_os = "linux", target_os = "android", target_os = "macos")))]
fn platform_snapshot() -> Result<Snapshot, String> { Err(super::platform_unsupported()) }

#[cfg(any(target_os = "linux", target_os = "android", test))]
fn bounded_text(reader: impl std::io::Read, limit: usize) -> Result<String, String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    reader.take((limit as u64).checked_add(1).ok_or_else(unavailable)?).read_to_end(&mut bytes).map_err(|_| unavailable())?;
    if bytes.len() > limit { return Err(unavailable()); }
    String::from_utf8(bytes).map_err(|_| unavailable())
}

#[cfg(any(target_os = "linux", target_os = "android", test))]
fn online_cores(raw: &str) -> Result<u32, String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 65_536 { return Err(unavailable()); }
    let mut previous = None; let mut count = 0u32;
    let number = |value: &str| -> Result<u32, String> {
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) { return Err(unavailable()); }
        value.parse().map_err(|_| unavailable())
    };
    for part in raw.split(',') {
        let (first, last) = match part.split_once('-') {
            Some((first,last)) => (number(first)?, number(last)?),
            None => { let index = number(part)?; (index,index) },
        };
        // 内核 cpulist 有序且不重叠；限制 CPU 索引而不按范围分配内存。
        if first > last || last >= 1_048_576 || previous.is_some_and(|value| first <= value) { return Err(unavailable()); }
        count = count.checked_add(last - first + 1).ok_or_else(unavailable)?; previous = Some(last);
    }
    if count == 0 { return Err(unavailable()); } Ok(count)
}

#[cfg(any(target_os = "linux", target_os = "android", test))]
fn mem_total(raw: &str) -> Result<u64, String> {
    let mut total = None;
    for line in raw.lines() {
        let Some((key,value)) = line.split_once(':') else { continue; };
        if key != "MemTotal" { continue; }
        if total.is_some() { return Err(unavailable()); }
        let fields = value.split_whitespace().collect::<Vec<_>>();
        if fields.len() != 2 || fields[1] != "kB" || !fields[0].bytes().all(|byte| byte.is_ascii_digit()) { return Err(unavailable()); }
        let bytes = fields[0].parse::<u64>().ok().and_then(|value| value.checked_mul(1024)).filter(|value| *value > 0).ok_or_else(unavailable)?;
        total = Some(bytes);
    }
    total.ok_or_else(unavailable)
}

#[cfg(any(target_os = "linux", target_os = "android", test))]
fn cpu_model(raw: &str) -> String {
    // ARM 的 Hardware、Processor、implementer 是板名/类别，不能充当 SoC 型号。
    raw.lines().find_map(|line| {
        let (key,value) = line.split_once(':')?;
        if key.trim() != "model name" { return None; }
        checked_model(value).filter(|value| !value.is_empty())
    }).unwrap_or_default()
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn platform_snapshot() -> Result<Snapshot, String> {
    fn read(path: &str, limit: usize) -> Result<String, String> {
        bounded_text(std::fs::File::open(path).map_err(|_| unavailable())?,limit)
    }
    let cores = online_cores(&read("/sys/devices/system/cpu/online",65_536)?)?;
    let total_bytes = mem_total(&read("/proc/meminfo",262_144)?)?;
    let model = read("/proc/cpuinfo",4 * 1024 * 1024).ok().map(|raw| cpu_model(&raw)).unwrap_or_default();
    Ok(Snapshot { cores,model,total_bytes })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value(cores: u32, model: &str, total_bytes: u64) -> Result<Value, String> {
        snapshot_value(Snapshot { cores,model:model.into(),total_bytes })
    }

    fn assert_contract(value: &Value) {
        let object = value.as_object().expect("硬件结果必须是对象");
        assert_eq!(object.len(),5,"硬件结果必须保持原五字段");
        assert!(value["cpuCores"].as_u64().is_some_and(|count| count > 0));
        assert!(value["totalMemMb"].as_u64().is_some_and(|total| total > 0));
        assert!(value["cpuModel"].is_string());
        assert!(value["isVirtualMachine"].is_boolean());
        assert!(value["cpuYear"].as_u64().is_some_and(|year| year == 0 || (2008..=2024).contains(&year)));
    }

    #[test]
    fn five_field_contract_rounds_mib_and_keeps_unknown_model_explicit() {
        let result = value(12,"  Intel Core i7-10700  ",16 * 1024 * 1024 * 1024).unwrap();
        assert_contract(&result);
        assert_eq!(result["cpuCores"],12); assert_eq!(result["totalMemMb"],16_384);
        assert_eq!(result["cpuModel"],"Intel Core i7-10700"); assert_eq!(result["cpuYear"],2020);
        let unknown = value(8,"",1_048_576).unwrap(); assert_contract(&unknown);
        assert_eq!(unknown["cpuModel"],""); assert_eq!(unknown["cpuYear"],0); assert_eq!(unknown["isVirtualMachine"],false);
        assert_eq!(value(1,"",1_572_863).unwrap()["totalMemMb"],1);
        assert_eq!(value(1,"",1_572_864).unwrap()["totalMemMb"],2);
        assert_eq!(value(1,"CPU\0伪造",1_048_576).unwrap()["cpuModel"],"");
        assert!(value(0,"",1_048_576).is_err()); assert!(value(1,"",0).is_err());
        assert!(value(1,"",1).is_err()); assert!(value(1,"",u64::MAX).is_err());
    }

    #[test]
    fn cpu_year_heuristics_match_the_existing_generation_tables() {
        let intel = [2008,2011,2012,2013,2014,2015,2016,2017,2018,2020,2021,2021,2022,2023];
        for (index,year) in intel.into_iter().enumerate() {
            let model = format!("intel core i7-{}700",index + 1);
            assert_eq!(estimate_year(&model),year);
        }
        let amd = [2017,2018,2019,2020,2020,2021,2022,2024,2024];
        for (index,year) in amd.into_iter().enumerate() {
            assert_eq!(estimate_year(&format!("amd ryzen 7 {}800x",index + 1)),year);
        }
        for model in ["amd fx-8350","phenom ii","athlon","a10-7800","sempron","opteron"] { assert_eq!(estimate_year(model),2014); }
        assert_eq!(estimate_year("intel xeon e5-2670 v2"),2013);
        assert_eq!(estimate_year("intel xeon e5-2690 v4"),2014);
        assert_eq!(estimate_year("intel xeon v9"),2019);
        assert_eq!(estimate_year("intel xeon v10"),2013);
        for model in ["","apple m4","intel core ultra 9 285k","arm cortex-a78","intel core i7-15700"] { assert_eq!(estimate_year(model),0); }
    }

    #[test]
    fn vm_flag_uses_only_all_seventeen_case_insensitive_model_markers() {
        for marker in VM_MARKERS {
            let result = value(4,&format!("CPU {} Model",marker.to_uppercase()),1_048_576).unwrap();
            assert_eq!(result["isVirtualMachine"],true);
        }
        for model in ["","Intel Core i5-12400","AMD Ryzen 9 7950X","Apple M3","ARMv8 Processor"] {
            assert_eq!(value(4,model,1_048_576).unwrap()["isVirtualMachine"],false);
        }
    }

    #[test]
    fn cpu_online_ranges_count_sparse_ids_and_reject_invalid_or_overlapping_lists() {
        assert_eq!(online_cores("0\n").unwrap(),1);
        assert_eq!(online_cores("0-3,8,10-11\n").unwrap(),7);
        assert_eq!(online_cores("0-1048575").unwrap(),1_048_576);
        for raw in ["","0,","-1","1-0","0-1,1-3","3,2","0,0","0-2-3","0, 2","0:2","+1","1048576","4294967296","0-4294967295"] {
            assert!(online_cores(raw).is_err(),"无效 cpulist 被接受");
        }
    }

    #[test]
    fn mem_total_requires_one_positive_kernel_kib_value_without_fabricated_free_memory() {
        assert_eq!(mem_total("MemTotal:       16384 kB\nMemFree: 5 kB\n").unwrap(),16_777_216);
        for raw in ["","MemAvailable: 10 kB","MemTotal: 0 kB","MemTotal: -1 kB","MemTotal: 12 MB","MemTotal: 12","MemTotal: 12 kB extra","MemTotal: 18446744073709551615 kB","MemTotal: 1 kB\nMemTotal: 2 kB"] {
            assert!(mem_total(raw).is_err());
        }
    }

    #[test]
    fn cpuinfo_does_not_substitute_arm_board_names_abis_or_implementers_for_models() {
        assert_eq!(cpu_model("processor : 0\nmodel name : Intel Core i5-12400\nprocessor : 1\nmodel name : Other\n"),"Intel Core i5-12400");
        assert_eq!(cpu_model("Processor : AArch64 Processor rev 1\nHardware : board\nCPU implementer : 0x41\nmodel : 123\n"),"");
        assert_eq!(cpu_model("model name : bad\0model\n"),"");
        assert_eq!(cpu_model(&format!("model name : {}", "x".repeat(4097))),"");
    }

    #[test]
    fn bounded_kernel_reads_propagate_io_utf8_and_size_failures() {
        use std::io::{self,Cursor,Read};
        struct Failure;
        impl Read for Failure { fn read(&mut self,_: &mut [u8]) -> io::Result<usize> { Err(io::Error::new(io::ErrorKind::PermissionDenied,"夹具拒绝读取")) } }
        assert_eq!(bounded_text(Cursor::new(b"abcd"),4).unwrap(),"abcd");
        assert!(bounded_text(Cursor::new(b"abcde"),4).is_err());
        assert!(bounded_text(Cursor::new([0xff]),4).is_err());
        assert!(bounded_text(Failure,4).is_err());
    }

    #[test]
    fn windows_utf16_registry_and_api_failures_are_not_successful_zero_snapshots() {
        let units = " Intel CPU ".encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        let bytes = (units.len() * 2) as u32;
        assert_eq!(registry_model(0,1,&units,bytes).as_deref(),Some("Intel CPU"));
        assert!(registry_model(2,1,&units,bytes).is_none());
        assert!(registry_model(0,2,&units,bytes).is_none());
        for count in [0,1,bytes-1,bytes+2] { assert!(registry_model(0,1,&units,count).is_none()); }
        assert!(registry_model(0,1,&[0xd800,0],4).is_none());
        assert!(registry_model(0,1,&[65,0,66,0],8).is_none());
        assert!(registry_model(0,1,&[65,66],4).is_none());
        assert!(windows_snapshot(0,1,1_048_576,None).is_err());
        assert!(windows_snapshot(4,0,1_048_576,None).is_err());
        assert!(windows_snapshot(4,1,0,None).is_err());
        assert_contract(&snapshot_value(windows_snapshot(4,1,1_048_576,None).unwrap()).unwrap());
    }

    #[test]
    fn mac_sysctl_decoding_checks_abi_lengths_positive_values_and_optional_brand() {
        assert_eq!(sysctl_number(&8i32.to_ne_bytes(),true),Some(8));
        assert_eq!(sysctl_number(&16_777_216u64.to_ne_bytes(),false),Some(16_777_216));
        assert_eq!(sysctl_number(&0i32.to_ne_bytes(),true),None);
        assert_eq!(sysctl_number(&(-1i32).to_ne_bytes(),true),None);
        assert_eq!(sysctl_number(&0u64.to_ne_bytes(),false),None);
        assert_eq!(sysctl_number(&[1,2],true),None); assert_eq!(sysctl_number(&[1,2,3,4],false),None);
        assert_eq!(sysctl_model(b"Intel Core i7-10700\0").as_deref(),Some("Intel Core i7-10700"));
        for bytes in [&b""[..],&b"model"[..],&b"a\0b\0"[..],&[0xff,0][..]] { assert!(sysctl_model(bytes).is_none()); }
    }

    #[test]
    fn hardware_failure_messages_follow_the_call_language() {
        assert_eq!(super::super::with_language("en",unavailable),"Unable to read a valid processor count or total physical memory");
        assert_eq!(super::super::with_language("zh-TW",unavailable),"無法取得有效的處理器數量或實體記憶體總量");
        assert_eq!(super::super::with_language("zh-CN",unavailable),"无法取得有效的处理器数量或物理内存总量");
    }

    // 由 Lead 在统一 Win/Linux run 中真实采样；不打印设备字段，也不写入设置。
    #[cfg(any(windows,target_os = "linux"))]
    #[test]
    fn host_hardware_snapshot_has_five_valid_fields() {
        let result = hardware_info().expect("宿主硬件采集必须成功");
        assert_contract(&result);
    }
}

//! 只管理本次创建的 Windows 子进程与 Job；不按镜像名、外部 PID 清理。
use std::{ffi::c_void, io::Read, os::windows::{io::AsRawHandle, process::CommandExt}, path::Path,
    process::{Child, Command, Stdio}, sync::mpsc::{self, Receiver, SyncSender}, thread::JoinHandle};
type Result<T> = std::result::Result<T, String>;
#[repr(C)] #[derive(Default)] struct Basic { per_process_time:i64, per_job_time:i64, flags:u32, minimum:usize, maximum:usize, active_limit:u32, affinity:usize, priority:u32, scheduling:u32 }
#[repr(C)] #[derive(Default)] struct IoCounters { read_ops:u64,write_ops:u64,other_ops:u64,read_bytes:u64,write_bytes:u64,other_bytes:u64 }
#[repr(C)] #[derive(Default)] struct Extended { basic:Basic,io:IoCounters,process_memory:usize,job_memory:usize,peak_process_memory:usize,peak_job_memory:usize }
#[repr(C)] #[derive(Default)] struct Accounting { user:i64,kernel:i64,period_user:i64,period_kernel:i64,faults:u32,total:u32,active:u32,terminated:u32 }
#[repr(C)] struct ThreadEntry { size:u32,usage:u32,id:u32,owner:u32,base:i32,delta:i32,flags:u32 }
#[link(name="kernel32")] extern "system" {
    fn CreateJobObjectW(attrs:*const c_void,name:*const u16)->*mut c_void;
    fn SetInformationJobObject(job:*mut c_void,class:i32,info:*const c_void,size:u32)->i32;
    fn AssignProcessToJobObject(job:*mut c_void,process:*mut c_void)->i32;
    fn TerminateJobObject(job:*mut c_void,code:u32)->i32;
    fn QueryInformationJobObject(job:*mut c_void,class:i32,info:*mut c_void,size:u32,returned:*mut u32)->i32;
    fn CloseHandle(handle:*mut c_void)->i32;
    fn CreateToolhelp32Snapshot(flags:u32,pid:u32)->*mut c_void;
    fn Thread32First(snapshot:*mut c_void,entry:*mut ThreadEntry)->i32;
    fn Thread32Next(snapshot:*mut c_void,entry:*mut ThreadEntry)->i32;
    fn OpenThread(access:u32,inherit:i32,id:u32)->*mut c_void;
    fn ResumeThread(thread:*mut c_void)->u32;
}
struct Handle(*mut c_void);
unsafe impl Send for Handle {}
impl Drop for Handle { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
fn failure()->String { "无法隔离或管理 EasyTier 进程 / 無法隔離或管理 EasyTier 程序 / Unable to isolate or manage the EasyTier process".into() }
fn resume(child:&Child)->bool {
    unsafe {
        let raw=CreateToolhelp32Snapshot(4,0); if raw as isize == -1 { return false; }
        let snapshot=Handle(raw); let mut entry=ThreadEntry {size:std::mem::size_of::<ThreadEntry>() as u32,usage:0,id:0,owner:0,base:0,delta:0,flags:0};
        let mut more=Thread32First(snapshot.0,&mut entry);
        while more!=0 { if entry.owner==child.id() { let thread=OpenThread(2,0,entry.id); if !thread.is_null() { let thread=Handle(thread); return ResumeThread(thread.0)==1; } } more=Thread32Next(snapshot.0,&mut entry); }
        false
    }
}
fn job_empty(job:&Handle)->bool {
    let mut count=Accounting::default();
    unsafe { QueryInformationJobObject(job.0,1,(&mut count as *mut Accounting).cast(),std::mem::size_of::<Accounting>() as u32,std::ptr::null_mut())!=0 && count.active==0 }
}
fn reader<R:Read+Send+'static>(mut input:R,tx:SyncSender<Vec<u8>>)->std::io::Result<JoinHandle<()>> {
    std::thread::Builder::new().name("hc-easytier-output".into()).spawn(move || { let mut bytes=[0u8;8192]; let mut observed=0usize;
        loop { match input.read(&mut bytes) { Ok(0)|Err(_)=>break,Ok(n)=>{
            // 持续排空，启动识别最多消费每管道 1 MiB；绝不转发原始正文到日志。
            let count=n.min((1024*1024usize).saturating_sub(observed)); observed=observed.saturating_add(n);
            if count>0 { match tx.try_send(bytes[..count].to_vec()) { Ok(())|Err(mpsc::TrySendError::Full(_))=>{},Err(mpsc::TrySendError::Disconnected(_))=>break } }
        } } }
    })
}
pub(super) struct OwnedProcess { child:Child, job:Handle, readers:Vec<JoinHandle<()>>, pub output:Receiver<Vec<u8>>, reaped:bool }
impl OwnedProcess {
    pub fn spawn(program:&Path,args:&[String],cwd:&Path)->Result<Self> {
        if !program.is_absolute() || !cwd.is_absolute() || args.len()>48 || args.iter().any(|v|v.len()>8192 || v.contains('\0')) { return Err(failure()); }
        let raw=unsafe { CreateJobObjectW(std::ptr::null(),std::ptr::null()) }; if raw.is_null() { return Err(failure()); }
        let job=Handle(raw); let mut limits=Extended::default(); limits.basic.flags=0x2000;
        if unsafe { SetInformationJobObject(job.0,9,(&limits as *const Extended).cast(),std::mem::size_of::<Extended>() as u32) }==0 { return Err(failure()); }
        let mut command=Command::new(program); command.args(args).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).creation_flags(0x08000004);
        let mut child=command.spawn().map_err(|_| "无法启动正式 EasyTier core / 無法啟動正式 EasyTier core / Unable to start packaged EasyTier core".to_owned())?;
        if unsafe { AssignProcessToJobObject(job.0,child.as_raw_handle().cast()) }==0 || !resume(&child) {
            unsafe { TerminateJobObject(job.0,1); } let _=child.kill();
            // 进程尚未放行时也必须等待真实退出，不能把失败的 spawn 当作没有副作用。
            loop {
                if matches!(child.try_wait(),Ok(Some(_))) && job_empty(&job) { break; }
                unsafe { TerminateJobObject(job.0,1); } let _=child.kill();
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            return Err(failure());
        }
        let (tx,output)=mpsc::sync_channel(64);
        let mut owned=Self {child,job,readers:Vec::new(),output,reaped:false};
        let readers=(||->Result<()> {
            let stdout=owned.child.stdout.take().ok_or_else(failure)?;
            owned.readers.push(reader(stdout,tx.clone()).map_err(|_|failure())?);
            let stderr=owned.child.stderr.take().ok_or_else(failure)?;
            owned.readers.push(reader(stderr,tx.clone()).map_err(|_|failure())?);Ok(())
        })();
        drop(tx);
        if readers.is_err() {
            owned.terminate();
            while !owned.confirm_reaped() { owned.terminate();std::thread::sleep(std::time::Duration::from_millis(25)); }
            return Err(failure());
        }
        Ok(owned)
    }
    pub fn has_exited(&mut self)->bool { matches!(self.child.try_wait(),Ok(Some(_))) }
    pub fn terminate(&mut self) { unsafe { TerminateJobObject(self.job.0,1); } let _=self.child.kill(); }
    pub fn confirm_reaped(&mut self)->bool {
        if !job_empty(&self.job) || !self.has_exited() || self.readers.iter().any(|reader|!reader.is_finished()) { return false; }
        for reader in self.readers.drain(..) { let _=reader.join(); }
        self.reaped=true; true
    }
}
impl Drop for OwnedProcess {
    fn drop(&mut self) { if !self.reaped { self.terminate(); } }
}
import json, subprocess, threading, time
from pathlib import Path
exe = Path(__file__).parent / 'src/artifacts/win-x64/PCCL2.Native.exe'
state = {'settings': {'selectedVersionId':'NativeTest-1.20.1','memoryMb':4096}, 'accounts':[{'id':'test-account','name':'NativeTest','authType':'offline','offline':True,'uuid':'test-uuid'}], 'selectedAccountId':'test-account','installed':[{'id':'NativeTest-1.20.1','mcVersion':'1.20.1','loader':'fabric'}], 'gameDir':'F:/native-verification-only', 'versionDirs':[]}
proc = subprocess.Popen([str(exe.resolve()), '--bridge-stdio'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding='utf-8', text=True, bufsize=1)
print('native verification PID:', proc.pid, flush=True)
stop = threading.Event()
def read():
    for line in proc.stdout:
        try: req=json.loads(line)
        except ValueError: continue
        if 'event' in req:
            print('EVENT',req['event'],flush=True)
            continue
        method=req.get('method'); params=req.get('params',{}); print('RPC',method,flush=True)
        result=True; error=None
        if method=='state.get': result=state
        elif method=='downloads.list': result=[{'id':'verification-task','title':'测试数据：下载 1.20.1','state':'running','cancellable':True}]
        elif method=='auth.status': result={'state':'idle'}
        elif method=='accounts.select': state['selectedAccountId']=params['accountId']
        elif method=='settings.set': state['settings'].update(params['patch'])
        elif method=='versions.manifest': result={'latest':{'release':'1.20.1','snapshot':'24w14a'},'versions':[{'id':'1.20.1','type':'release','url':'https://example.invalid/version.json','releaseTime':'2023-06-12T00:00:00Z'},{'id':'24w14a','type':'snapshot','url':'https://example.invalid/snapshot.json','releaseTime':'2024-04-03T00:00:00Z'}]}
        elif method in ('accounts.addOffline','accounts.remove','launch','downloads.cancel'): print('ACTION',method,flush=True)
        else: error='verification host does not implement this method'
        frame={'id':req.get('id')}
        frame['error' if error else 'result']=error if error else result
        try: proc.stdin.write(json.dumps(frame)+'\n'); proc.stdin.flush()
        except (BrokenPipeError, OSError): break
threading.Thread(target=read,daemon=True).start()
try:
    stop.wait(480)
finally:
    if proc.poll() is None: proc.terminate()
    try: proc.wait(timeout=5)
    except subprocess.TimeoutExpired: proc.kill();proc.wait()

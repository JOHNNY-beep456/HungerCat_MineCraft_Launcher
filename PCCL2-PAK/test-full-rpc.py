import subprocess,time,json,threading
p='PCCL2-PAK/src/PclFrontend/upstream/Plain Craft Launcher 2/bin/Plain Craft Launcher 2.exe'
proc=subprocess.Popen([p,'--bridge-stdio'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',errors='replace',bufsize=1)
seen=[]
def answer():
 while proc.poll() is None:
  line=proc.stdout.readline()
  if not line:break
  try:q=json.loads(line)
  except:continue
  method=q.get('method');seen.append(method);print('RPC',method,flush=True)
  if method=='ui.ready':continue
  if method=='state.get':r={'settings':{'memoryMb':4096,'language':'zh-CN','downloadSource':'auto','versionIsolation':False,'selectedVersionId':'1.20.1'},'accounts':[{'id':'acct-1','name':'TestPlayer','uuid':'uuid-1','offline':True,'authType':'offline'}],'selectedAccountId':'acct-1','installed':[{'id':'1.20.1','mcVersion':'1.20.1','loader':None,'versionType':'release','worlds':[],'servers':[]}], 'versionDirs':[], 'gameDir':'F:/test-mc'}
  elif method=='versions.manifest':r={'latest':{'release':'1.20.1','snapshot':'24w14a'},'versions':[{'id':'1.20.1','type':'release','releaseTime':'2023-06-12T00:00:00Z'}]}
  elif method=='resources.search':r={'hits':[],'totalHits':0}
  elif method in ('resources.project','resources.versions'):r=[]
  elif method=='launch':r={'pid':12345}
  elif method=='versions.install':r={'ok':True}
  elif method=='resources.install':r={'ok':True}
  elif method=='accounts.select':r={'ok':True}
  elif method in ('downloads.manage','instances.manage','accounts.manage'):r={'handledByHost':True}
  else:r=True
  proc.stdin.write(json.dumps({'id':q.get('id'),'result':r})+'\n');proc.stdin.flush()
t=threading.Thread(target=answer,daemon=True);t.start();time.sleep(20)
proc.terminate()
try:proc.wait(timeout=4)
except:proc.kill()
print('seen',seen)

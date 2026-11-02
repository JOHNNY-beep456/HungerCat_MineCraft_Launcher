from pathlib import Path
import re, subprocess, sys
root=Path.cwd()
raw=subprocess.check_output(['git','ls-files','-z','--cached','--others','--exclude-standard'])
files=sorted(set(p.decode('utf-8') for p in raw.split(b'\0') if p))
old=subprocess.check_output(['git','show','HEAD:src/main/curseforge-key.ts']).decode('utf-8')
parts=re.findall(r"^  '([^']+)'",old,re.M)
secret=''.join(parts)
local_key=root/'.local/curseforge-api-key.txt'
private_key=local_key.read_text(encoding='utf-8').strip() if local_key.exists() else ''
patterns=[('private-key',re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')),('github-token',re.compile(r'\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})')),('aws-key',re.compile(r'\bAKIA[0-9A-Z]{16}\b'))]
issues=[];big=[];total=0
for name in files:
 p=root/name
 if not p.is_file():continue
 if name=='server' or name.startswith('server/'):issues.append((name,'server must not be published'));continue
 n=p.stat().st_size;total+=n
 if n>50*1024*1024:big.append((name,n))
 data=p.read_bytes()
 if private_key and private_key.encode() in data:issues.append((name,'local private build key'))
 if secret and secret.encode() in data:issues.append((name,'previous built-in CurseForge key'))
 for fragment in parts:
  if len(fragment)>10 and fragment.encode() in data:issues.append((name,'previous CurseForge key fragment'))
 if b'\0' in data[:8192]:continue
 try:text=data.decode('utf-8-sig')
 except UnicodeError:continue
 for label,pattern in patterns:
  for match in pattern.finditer(text):issues.append((name+':'+str(text.count('\n',0,match.start())+1),label))
print('Candidate files:',len(files),'total bytes:',total)
print('Potential secret locations:',issues)
print('Files over 50 MiB:',big)
sys.exit(1 if issues or big else 0)

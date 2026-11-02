import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const tests=readdirSync('scripts').filter(n=>/^test-.*\.mjs$/.test(n)&&!n.startsWith('test-smtc-live'))
let failed=[]
for(const name of tests){
 const r=spawnSync(process.execPath,['scripts/'+name],{encoding:'utf8',maxBuffer:8*1024*1024})
 const lines=(r.stdout||'').split(/\r?\n/).filter(l=>l.startsWith('结果'))
 console.log(`${name}: exit=${r.status} ${lines.at(-1)||''}`)
 if(r.status!==0){failed.push(name);console.log((r.stdout||'').slice(-4000));console.log((r.stderr||'').slice(-4000))}
}
console.log('Failed:',JSON.stringify(failed));process.exitCode=failed.length?1:0

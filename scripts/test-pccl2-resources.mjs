import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const scratch = await fs.mkdtemp(join(tmpdir(), 'pccl2-resource-test-'))
const output = join(scratch, 'resource.cjs')
globalThis.__pccl2ResourceCalls = {};
const modules = new Map([
 ['../store', `export const settings = globalThis.__pccl2Settings; export const activeGameDir = () => '/game';`],
 ['../installed', `export const listInstalled = async () => [{id:'fabric',mcVersion:'1.20.1',loader:'fabric'},{id:'vanilla',mcVersion:'1.20.1',loader:null}];`],
 ['../modrinth', `export const installMod = async (...args) => { globalThis.__pccl2ResourceCalls.install=args; return '/game/versions/fabric/mods/ok.jar'; };`],
 ['../sources', `export const resolveProjectDetail = async (id) => {globalThis.__pccl2ResourceCalls.project=id; return {slug:'demo',source:'modrinth',project_type:'mod'};}; export const resolveVersionsFor = async (...args) => {globalThis.__pccl2ResourceCalls.versions=args; return [{id:'v1',game_versions:['1.20.1'],loaders:['fabric'],files:[{primary:true,url:'https://example.com/a.jar',filename:'a.jar',size:5}],dependencies:[]}];};`],
 ['../curseforge', `export const cfProject = async () => ({id:100,classId:6,allowModDistribution:true}); export const cfFileById = async () => ({dependencies:[]});`],
 ['../curseforge-key', `export const defaultCurseforgeKey = () => 'test';`],
 ['../resources', `export const listResources = async () => [];`],
 ['@shared/types', `export {};`],
 ['../handlers/context', `export {};`]
])
await build({
 stdin:{contents:await fs.readFile('src/main/pccl2/resources.ts','utf8'),resolveDir:join(process.cwd(),'src/main/pccl2'),loader:'ts'},
 outfile:output,bundle:true,platform:'node',format:'cjs',logLevel:'silent',
 plugins:[{name:'resource-mocks',setup(b){b.onResolve({filter:/.*/},({path})=>modules.has(path)?({path,namespace:'mock'}):undefined);b.onLoad({filter:/.*/,namespace:'mock'},({path})=>({contents:modules.get(path),loader:'js'}))}}]
})
globalThis.__pccl2Settings={get:()=>({versionIsolation:false,isolatedVersions:[]})}
const {nativeInstallResource}=createRequire(import.meta.url)(output)
const ctx={downloadAborts:new Map(),installedCache:{invalidateAll(){this.invalidated=true}},isIsolated:()=>false}
let passed=0
const test=async(name,fn)=>{await fn();passed++;console.log(`通过：${name}`)}
try {
 await test('真实安装使用服务端元数据和目标实例',async()=>{
  globalThis.__pccl2ResourceCalls = {};const progress=[];const result=await nativeInstallResource(ctx,{projectId:'project-1',versionId:'v1',instanceId:'fabric'},x=>progress.push(x))
  console.log('调用参数：',JSON.stringify(globalThis.__pccl2ResourceCalls));assert.equal(result.type,'mod');assert.equal(result.destination,'/game/versions/fabric/mods/ok.jar')
  assert.equal(globalThis.__pccl2ResourceCalls.project,'project-1');assert.equal(globalThis.__pccl2ResourceCalls.versions[0],'demo');assert.equal(globalThis.__pccl2ResourceCalls.install[3],'fabric');assert.equal(globalThis.__pccl2ResourceCalls.install[4],false);assert.equal(globalThis.__pccl2ResourceCalls.install[5],'mod');assert.equal(progress.at(-1).percent,100)
  assert.equal(ctx.installedCache.invalidated,true);assert.equal(ctx.downloadAborts.size,0)
 })
 await test('必需依赖不会被静默遗漏',async()=>{
  const previous=modules.get('../sources')
  modules.set('../sources',previous.replace('dependencies:[]',"dependencies:[{project_id:'dep',version_id:null,file_name:null,dependency_type:'required'}]"))
  await build({stdin:{contents:await fs.readFile('src/main/pccl2/resources.ts','utf8'),resolveDir:join(process.cwd(),'src/main/pccl2'),loader:'ts'},outfile:output,bundle:true,platform:'node',format:'cjs',logLevel:'silent',plugins:[{name:'resource-mocks',setup(b){b.onResolve({filter:/.*/},({path})=>modules.has(path)?({path,namespace:'mock'}):undefined);b.onLoad({filter:/.*/,namespace:'mock'},({path})=>({contents:modules.get(path),loader:'js'}))}}]})
  delete createRequire(import.meta.url).cache[output]
  const {nativeInstallResource:install}=createRequire(import.meta.url)(output)
  await assert.rejects(()=>install(ctx,{projectId:'p',versionId:'v1',instanceId:'fabric'},()=>{}),/required dependencies/)
  modules.set('../sources',previous)
 })
 await test('未知实例拒绝下载',async()=>{
  await assert.rejects(()=>nativeInstallResource(ctx,{projectId:'p',versionId:'v1',instanceId:'missing'},()=>{}),/does not exist/)
 })
 console.log(`结果：${passed} 通过 / 0 失败`)
} finally { await fs.rm(scratch,{recursive:true,force:true}) }

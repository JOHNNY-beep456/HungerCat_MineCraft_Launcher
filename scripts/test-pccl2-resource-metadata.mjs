import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const dir=await fs.mkdtemp(join(tmpdir(),'pccl2-metadata-'))
let passed=0
const test=async(name,fn)=>{await fn();passed++;console.log(`通过：${name}`)}
globalThis.__metadataCalls=[]
globalThis.__metadataKey='TEST_KEY_ONLY'
try {
 const out=join(dir,'metadata.cjs')
 await build({entryPoints:['src/main/pccl2/resource-metadata.ts'],outfile:out,bundle:true,platform:'node',format:'cjs',plugins:[{name:'mock-services',setup(b){
 b.onResolve({filter:/^\.\.\/(curseforge|curseforge-key|broker)$/},args=>({path:args.path,namespace:'test'}))
 b.onLoad({filter:/.*/,namespace:'test'},args=>({contents:args.path.endsWith('curseforge-key')?'export const defaultCurseforgeKey=()=>globalThis.__metadataKey;':args.path.endsWith('curseforge')?'export const cfFetch=async(key,path,init)=>{globalThis.__metadataCalls.push({key,path,init});return {data:[],pagination:{totalCount:0}}}':'export const netRequest=async(method,params)=>{globalThis.__metadataCalls.push({method,params});return {hits:[],total_hits:0}}',loader:'js'}))
 }}]})
 const {nativeResourceMetadata:request}=createRequire(import.meta.url)(out)
 await test('CurseForge 搜索不再被识别成项目 search',async()=>{
 const r=await request({url:'https://api.curseforge.com/v1/mods/search?gameId=432&classId=6&index=24'})
 assert.deepEqual(r,{data:[],pagination:{totalCount:0}})
 assert.equal(globalThis.__metadataCalls.at(-1).path,'/mods/search?gameId=432&classId=6&index=24')
 })
 await test('全部社区分类保持查询参数和原始返回结构',async()=>{
 for(const id of [6,4471,6945,12,6552])await request({url:`https://api.curseforge.com/v1/mods/search?gameId=432&classId=${id}`})
 const r=await request({url:'https://api.modrinth.com/v2/search?query=&facets=%5B%5B%22project_type%3Ashader%22%5D%5D&offset=24'})
 assert.equal(r.total_hits,0);assert.ok(globalThis.__metadataCalls.at(-1).params.url.includes('offset=24'))
 })
 await test('CF 项目、文件列表与批量元数据均走宿主',async()=>{
 for(const path of ['/mods/123','/mods/123/files','/mods/123/files/456'])await request({url:'https://api.curseforge.com/v1'+path})
 await request({url:'https://api.curseforge.com/v1/mods',method:'POST',content:'{"modIds":[123]}'})
 assert.deepEqual(globalThis.__metadataCalls.at(-1).init.body,{modIds:[123]})
 })
 await test('拒绝非白名单域名、凭据 URL、降级及不支持的方法',async()=>{
 for(const url of ['http://api.modrinth.com/v2/search','https://evil.test/v2/search','https://x:y@api.modrinth.com/v2/search','https://api.curseforge.com/v1/mods/searching','https://api.modrinth.com/v2/user/test'])await assert.rejects(request({url}))
 await assert.rejects(request({url:'https://api.modrinth.com/v2/search',method:'DELETE'}))
 })
 await test('缺少 CurseForge Key 明确提示且不误报项目不存在',async()=>{
 globalThis.__metadataKey=''
 await assert.rejects(request({url:'https://api.curseforge.com/v1/mods/search'}),/尚未配置 CurseForge/)
 await request({url:'https://api.modrinth.com/v2/search'})
 })
 if(process.env.PCCL2_LIVE_METADATA==='1') await test('Modrinth 五个社区分类在线搜索返回真实 API 格式',async()=>{
  for(const type of ['mod','modpack','datapack','resourcepack','shader']){
   const u=new URL('https://api.modrinth.com/v2/search');u.searchParams.set('limit','1');u.searchParams.set('facets',JSON.stringify([[`project_type:${type}`]]))
   const response=await fetch(u,{signal:AbortSignal.timeout(20000),headers:{'User-Agent':'HCMCL-native-verification/0.7.5'}})
   assert.ok(response.ok,`${type}: HTTP ${response.status}`)
   const value=await response.json();assert.ok(Array.isArray(value.hits));assert.equal(typeof value.total_hits,'number');console.log(`  ${type}: ${value.hits.length} hits / ${value.total_hits}`)
  }
 })
 console.log(`结果：${passed} 通过 / 0 失败`)
}finally{await fs.rm(dir,{recursive:true,force:true});delete globalThis.__metadataCalls;delete globalThis.__metadataKey}

/**
 * 「为原版实例就地安装模组加载器」的回归测试（离线，纯源码 / 文案断言）。
 *
 * 这个功能的语义是**就地安装**：加载器 profile 合并进实例自己的版本 JSON，
 * 实例 id、版本目录、存档、资源包、实例级设置全部不变。相比「新建一个加载器实例」，
 * 这里有三个非常容易退化的点，测试就锁这三点：
 *
 *   1. **不能改变实例 id**：下载与写盘都必须用传入的 instanceId；
 *      一旦某处又用加载器的自动命名（如 `1.20.1-fabric-0.15.x`），
 *      存档就跑到另一个目录去了 —— 用户会觉得「装完存档全没了」。
 *
 *   2. **必须是两步**：先合并 profile，再 `installVersion` 下载依赖库。
 *      只做第一步会得到「界面显示装好、启动即崩」的实例。
 *
 *   3. **原版 JSON 只能备份一次**：重复安装（换加载器）时当前文件已是合并结果，
 *      若再拿它覆盖备份，唯一的原版副本就没了。
 *
 * 另外锁住 Forge 家族的额外步骤：它必须跑安装器，再把安装器生成的 profile
 * 合并进来、并清理掉安装器留下的临时版本目录。
 *
 * 运行：node scripts/test-loader-install.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8')

let pass = 0
let fail = 0
function ok(label, condition, detail) {
  if (condition) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${detail === undefined ? '' : `\n       ${detail}`}`)
  }
}

const CARD = 'src/renderer/src/pages/instance-manage/LoaderInstallCard.tsx'
const VERSIONS = 'src/main/versions.ts'
const FORGE = 'src/main/forge.ts'
const HANDLER = 'src/main/handlers/versions.ts'

console.log('就地安装入口（实现已迁到 store，语义不变）')
ok('LoaderInstallCard.tsx 存在', existsSync(resolve(ROOT, CARD)))
const card = read(CARD)
const STORE = 'src/renderer/src/pages/instance-manage/loader-install-store.ts'
ok('loader-install-store.ts 存在', existsSync(resolve(ROOT, STORE)))
const store = existsSync(resolve(ROOT, STORE)) ? read(STORE) : ''
const forge = read(FORGE)
ok(
  '调用 installInPlace 并传入 instanceId',
  /window\.api\.loaders\.installInPlace\(\s*args\.kind,\s*args\.mcVersion,\s*args\.loaderVersion,\s*args\.instanceId,\s*args\.dirId\s*\)/.test(
    store
  ),
  '参数顺序必须是 (kind, mc, loaderVersion, instanceId, dirId)'
)
ok(
  '下载目标是同一个 instanceId（不会造出新实例）',
  /await args\.installVersion\(args\.instanceId, args\.dirId\)/.test(store),
  '这里若换成新 id，存档就会落到另一个目录'
)
ok(
  '不再要求输入实例名（就地安装不需要新名字）',
  !/ins\.loader\.namePlaceholder/.test(card) && !/setName\(/.test(card)
)
ok(
  '版本清单仍按加载器分流（forge 走 forge.versions）',
  /isForgeKind\(kind\)[\s\S]{0,120}window\.api\.forge\.versions\(kind, mcVersion\)/.test(card) &&
    /window\.api\.loaders\.versions\(kind, mcVersion\)/.test(card)
)
ok('版本清单有超时兜底', /withTimeout\(/.test(card) && /10_000/.test(card))
ok('快速切换加载器时丢弃陈旧响应', /seq\.current/.test(card))
ok(
  '双击 / 重复点击的互斥由 store 承担',
  /if \(isLoaderJobRunning\(key\)\) return/.test(store),
  '原先用组件内 busyRef，卸载后即失效'
)

console.log('\n主进程：profile 合并进实例（实例 id 不变）')
const versions = read(VERSIONS)
ok(
  '导出 mergeLoaderProfileInPlace',
  /export async function mergeLoaderProfileInPlace\(/.test(versions)
)
ok(
  '合并后把 id 强制回实例 id',
  /merged\.id = instanceId/.test(versions)
)
ok(
  '丢弃 inheritsFrom（写回的是自包含 JSON）',
  /delete \(merged as \{ inheritsFrom\?: string \}\)\.inheritsFrom/.test(versions)
)
ok(
  '原版 JSON 备份只在不存在时写一次',
  /if \(!existsSync\(backup\) && existsSync\(file\)\)/.test(versions),
  '重复安装时用合并结果覆盖备份会丢掉唯一的原版副本'
)
ok(
  '先解析完整原版 JSON 再合并（兼容 {id,inheritsFrom} 包装实例）',
  /const base = await resolveVersionJson\(instanceId, gameDir\)/.test(versions)
)
ok(
  '已装加载器的实例拒绝重复安装',
  /该实例已安装模组加载器/.test(versions)
)

console.log('\n安装器产物识别：不能只看「目录是否新增」')
ok(
  '用版本快照（id → JSON mtime）而非目录集合',
  /async function listVersionStamps\(gameDir: string\): Promise<Map<string, number>>/.test(forge) &&
    /const before = await listVersionStamps\(gameDir\)/.test(forge) &&
    /const after = await listVersionStamps\(gameDir\)/.test(forge)
)
ok(
  '新增或 mtime 变新都算本次写入',
  /if \(prev !== undefined && mtime <= prev\) continue/.test(forge),
  '上次中断会留下目录，靠「新增」永远判不出来'
)
ok(
  '有命名规则兜底（安装器幂等跳过写 JSON 时）',
  /version\.split\('-'\)\.pop\(\)/.test(forge) && /id\.toLowerCase\(\)\.includes\(kind\)/.test(forge)
)
ok(
  '始终排除 mcVersion（安装器会顺带补原版目录）',
  /if \(id === mcVersion\) continue/.test(forge)
)
ok(
  '判定失败时错误里带安装器输出与残留提示',
  /安装器未生成版本配置文件/.test(forge) &&
    /残缺目录/.test(forge) &&
    /最近输出/.test(forge)
)
ok(
  '清理临时目录前校验它是本次写入的（防误删已有实例）',
  /fresh = Date\.now\(\) - st\.mtimeMs < 10 \* 60 \* 1000/.test(forge) &&
    /删除可能误伤已有实例/.test(forge)
)

console.log('\nForge 安装器的 Mojang 依赖：启动器代下（避免安装器静默挂死）')
ok(
  '存在 Mojang 资源预置函数',
  /async function prefetchInstallerMojangFiles\(/.test(forge)
)
ok(
  '目标文件取自版本 JSON 的 client_mappings',
  /json\.downloads\?\.client_mappings/.test(forge),
  '安装器的 DOWNLOAD_MOJMAPS 任务下载的就是这个文件'
)
ok(
  '写入安装器期望的 libraries/<path> 路径',
  /join\(gameDir, 'libraries', mappings\.path\)/.test(forge)
)
ok(
  '走启动器多源下载（候选 URL + streamDownload）',
  /candidateUrls\(mappings\.url\)/.test(forge) && /await streamDownload\(url, dest\)/.test(forge),
  '官方不可达时要能回退到镜像'
)
ok(
  '已存在且大小匹配时跳过下载',
  /st\.size === mappings\.size/.test(forge)
)
ok(
  '预置在「下载安装器」之前执行',
  forge.indexOf('await prefetchInstallerMojangFiles(') > 0 &&
    forge.indexOf('await prefetchInstallerMojangFiles(') < forge.indexOf('onLog(`下载 ${kind} 安装器'),
  '必须在安装器启动前把文件放好，否则它自己会去拉并挂住'
)
ok(
  '预置失败不阻断（只记日志，不抛错）',
  /映射表预下载失败/.test(forge) && !/throw new Error\('映射表/.test(forge)
)

console.log('\nForge 家族：跑安装器 → 合并 → 清理临时目录')
ok('导出 installForgeInPlace', /export async function installForgeInPlace\(/.test(forge))
ok(
  '读取安装器生成的 profile 并合并',
  /mergeLoaderProfileInPlace\(gameDir, instanceId, profile\)/.test(forge)
)
ok(
  '清理安装器留下的临时版本目录（带时效守卫）',
  /await fsp\.rm\(dir, \{ recursive: true, force: true \}\)/.test(forge)
)

console.log('\n安装器子进程：防「无限卡住」')
// 1) stdin 必须是 ignore：默认的管道永不关闭，Java 一旦读 System.in 就永等 EOF。
ok(
  "spawn 显式指定 stdio: ['ignore', 'pipe', 'pipe']",
  /stdio: \['ignore', 'pipe', 'pipe'\]/.test(forge),
  '不写 stdio 时 stdin 是永不关闭的管道，安装器可能永久阻塞在等输入上'
)
ok(
  '存在「无输出看门狗」常量与轮询',
  /const INSTALLER_STALL_MS = 2 \* 60 \* 1000/.test(forge) &&
    /const INSTALLER_STALL_POLL_MS/.test(forge) &&
    /setInterval\(/.test(forge)
)
ok(
  '停滞判定基于「最近一次输出时间」',
  /Date\.now\(\) - lastOutputAt < INSTALLER_STALL_MS/.test(forge) && /lastOutputAt = Date\.now\(\)/.test(forge)
)
ok(
  '保留整轮总超时（10 分钟）',
  /const INSTALLER_HARD_TIMEOUT_MS = 10 \* 60 \* 1000/.test(forge)
)
ok(
  '错误信息附带「最近输出」',
  /function withTail|const withTail = /.test(forge) && /最近输出/.test(forge)
)
ok(
  'Windows 上终止进程树（taskkill /T /F）',
  /spawn\('taskkill', \['\/pid', String\(child\.pid\), '\/T', '\/F'\]/.test(forge),
  'child.kill() 只杀 java.exe，残留进程会占住版本目录导致后续操作失败'
)
ok(
  '日志按时间窗节流后再转发',
  /const LOG_FLUSH_MS = 120/.test(forge) && /setTimeout\(flushLog, LOG_FLUSH_MS\)/.test(forge),
  '安装器输出极密，逐块 IPC 会把渲染层刷成重渲染风暴'
)
ok(
  '收尾只结算一次（settled 守卫）',
  /let settled = false/.test(forge) && /if \(settled\) return/.test(forge)
)

console.log('\n界面可读性：多行错误要能看清')
ok(
  '错误区保留换行（whitespace-pre-wrap）',
  /whitespace-pre-wrap/.test(card),
  '默认 HTML 会把换行折叠，多行日志挤成一坨'
)
ok(
  '安装器实时日志只显示最后一行（避开 \\r 进度条乱码）',
  /log\.split\(\/\\r\?\\n\/\)\.filter\(\(s\) => s\.trim\(\)\)\.pop\(\)/.test(card) ||
    /lastLine/.test(card)
)

console.log('\n任务状态脱离组件生命周期（离开页面再回来仍显示安装状态）')
ok(
  '任务按「版本目录 + 实例」索引',
  /export function loaderJobKey\(dirId: string, instanceId: string\): string \{[\s\S]*?return `\$\{dirId\}\|\$\{instanceId\}`/.test(
    store
  ),
  '键里必须带 dirId：同名实例可能存在于多个版本目录'
)
ok(
  'store 暴露订阅接口给 useSyncExternalStore',
  /export function subscribeLoaderJobs\(/.test(store) && /export function getLoaderJob\(/.test(store)
)
ok(
  '安装任务在 store 里启动（组件卸载不打断）',
  /export function startLoaderInstall\(/.test(store) && /void run\(key, args\)/.test(store),
  '若放在组件里，卸载后就没有任何东西推进状态'
)
ok(
  '互斥锁跟着任务走（重进页面重复点击不会二次合并）',
  /if \(isLoaderJobRunning\(key\)\) return/.test(store)
)
ok(
  'Forge 日志订阅在 store 内（卸载后仍持续记录）',
  /window\.api\.forge\.onLog\(\(line\) => patch\(key, \{ log: line \}\)\)/.test(store)
)
ok(
  '阶段区分「合并」与「下载」',
  /phase: 'merging'/.test(store) && /phase: 'downloading'/.test(store)
)
ok('失败时记录错误信息', /phase: 'error'/.test(store) && /error: err instanceof Error/.test(store))
ok(
  '组件通过 useSyncExternalStore 读回状态',
  /useSyncExternalStore\(/.test(card) && /getLoaderJob\(jobKey\)/.test(card)
)
ok(
  '组件不再自己持有安装状态（busy / log / busyRef 已移除）',
  !/setBusy\(/.test(card) && !/busyRef/.test(card) && !/\[log, setLog\]/.test(card),
  '状态一旦回到组件内，离开页面就又会丢'
)
ok(
  '有任务时按任务里的加载器 / 版本渲染',
  /value=\{job \? job\.kind : kind\}/.test(card) && /value=\{job \? job\.loaderVersion : ver\}/.test(card),
  '重进页面后本地 state 是默认值，照它渲染会显示错误的加载器'
)
ok(
  '完成回调只触发一次（doneRef 守卫）',
  /doneRef/.test(card),
  '父组件传入的是内联箭头，identity 每次都变'
)

console.log('\nIPC 与桥接')
const handler = read(HANDLER)
ok(
  '新增 loaders:installInPlace 处理器',
  /ipcMain\.handle\(\s*'loaders:installInPlace'/.test(handler)
)
ok(
  '按 kind 分流到 forge / 其他',
  /kind === 'forge' \|\| kind === 'neoforge'/.test(handler) &&
    /await installForgeInPlace\(/.test(handler) &&
    /await installLoaderInPlace\(/.test(handler)
)
ok('返回 instanceId 供下载使用', /return instanceId/.test(handler))
ok(
  'preload 暴露 installInPlace',
  /installInPlace: \(/.test(read('src/preload/index.ts')) &&
    /ipcRenderer\.invoke\('loaders:installInPlace'/.test(read('src/preload/index.ts'))
)
ok(
  '类型声明包含 installInPlace',
  /installInPlace: \([\s\S]{0,240}?\) => Promise<string>/.test(read('src/shared/types.ts'))
)

console.log('\n只对原版实例显示入口')
const panel = read('src/renderer/src/pages/instance-manage/VersionPanel.tsx')
ok(
  'VersionPanel 以「原版 + mcVersion 已解析」为条件渲染',
  /\{loader === null && mcVersion !== '' && \(/.test(panel) && /<LoaderInstallCard/.test(panel)
)
ok(
  '透传 instanceId / mcVersion / dirId',
  /instanceId=\{versionId\}/.test(panel) &&
    /mcVersion=\{mcVersion\}/.test(panel) &&
    /dirId=\{dirId\}/.test(panel)
)

console.log('\n安装完成后：刷新元数据而非切换实例')
const page = read('src/renderer/src/pages/InstanceManagePage.tsx')
ok(
  '安装完成后调用 reload()',
  /onLoaderInstalled=\{\(\) => \{[\s\S]*?void reload\(\)/.test(page)
)
ok(
  '不再保留「切换到新实例」的回调（onOpenInstance 已移除）',
  !/onOpenInstance/.test(page)
)
ok('实例页维护 mcVersion 状态', /const \[mcVersion, setMcVersion\] = useState<string>\(''\)/.test(page))
ok('从已安装列表读取 mcVersion', /setMcVersion\(entry\?\.mcVersion \|\| versionId\)/.test(page))
ok(
  '加载器写到实例所属版本目录',
  /const targetDirId = settings\.selectedVersionDirId \|\| 'default'/.test(page) && /dirId=\{targetDirId\}/.test(page)
)

console.log('\n文案：三套语言齐全')
const KEYS = [
  'ins.loader.installTitle',
  'ins.loader.installDesc',
  'ins.loader.version',
  'ins.loader.install',
  'ins.loader.installing',
  'ins.loader.phaseMerge',
  'ins.loader.phaseDownload',
  'ins.loader.loading',
  'ins.loader.timeout',
  'ins.loader.none',
  'ins.loader.done'
]
for (const locale of ['zh-CN', 'zh-TW', 'en']) {
  const dict = JSON.parse(read(`src/renderer/src/i18n/locales/${locale}/instances.json`))
  const missing = KEYS.filter((k) => typeof dict[k] !== 'string' || dict[k] === '')
  ok(`${locale} 的 ${KEYS.length} 个键齐全且非空`, missing.length === 0, missing.join(', '))
  ok(`${locale} 已移除不再使用的实例名文案`, !('ins.loader.nameTaken' in dict))
}
const zh = JSON.parse(read('src/renderer/src/i18n/locales/zh-CN/instances.json'))
ok('installDesc 带 {mc} 占位符', zh['ins.loader.installDesc'].includes('{mc}'))
ok(
  'installDesc 明确「保留存档」语义',
  zh['ins.loader.installDesc'].includes('存档') && zh['ins.loader.installDesc'].includes('保留')
)
ok('none 文案带 {kind} 与 {mc}', zh['ins.loader.none'].includes('{kind}') && zh['ins.loader.none'].includes('{mc}'))
ok('done 文案带 {name}', zh['ins.loader.done'].includes('{name}'))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

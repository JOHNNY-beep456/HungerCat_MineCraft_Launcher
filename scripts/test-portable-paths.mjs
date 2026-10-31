/**
 * 便携版派生字段与资源管理器路径的单测（离线，纯源码断言）。
 *
 * 锁住两个真实 bug，它们的根因是同一个：`settings.set()` 为了「派生字段不落盘」
 * 把 `portable` / `gameDirAbs` 从待写盘对象里删掉了，**却没在内存缓存里补回来**。
 * 缓存是所有 IPC 的读取源，于是：
 *
 *   1. 渲染层 `s.gameDirAbs ?? s.gameDir` 回落到相对写法 `./.minecraft`。
 *      便携版的进程工作目录是解压出来的临时目录，不是 exe 所在目录，于是
 *      `readdir('./.minecraft')` 报 ENOENT ——
 *      界面表现：首次打开自实现的资源管理器，red 报「路径不存在或已被移动：./minecraft」。
 *
 *   2. 渲染层拿到的 `portable` 变成 undefined，「默认版本目录」那一行的置灰条件失效 ——
 *      界面表现：切换一次「版本目录隔离」后默认目录不再置灰，重启启动器又恢复
 *      （重启走 get() 重新归一化，字段回来了）。
 *
 * 两个现象都以「第一次 set() 之后 / 重启之后」分界，正是缓存漏字段的特征。
 * 这里做源码级断言：一旦有人再次删掉那两行补回，测试立刻失败。
 *
 * 运行：node scripts/test-portable-paths.mjs
 */
import { readFileSync } from 'node:fs'
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

console.log('便携版默认版本目录的写法')
const portable = read('src/main/portable.ts')
ok(
  "PORTABLE_GAME_DIR 是相对启动器目录的 './.minecraft'",
  /export const PORTABLE_GAME_DIR = '\.\/\.minecraft'/.test(portable),
  '换目录 / 换机器后相对路径才不会失效'
)
ok(
  'resolvePortablePath 只解析相对路径',
  /if \(!p \|\| !portableDir \|\| isAbsolute\(p\)\) return p/.test(portable),
  '绝对路径与安装版必须原样返回'
)

console.log('\nstore.set()：派生字段必须补回内存缓存')
const store = read('src/main/store.ts')

/** 取出 set() 中给 cachedSettings 赋值的那一段（到 writeJsonAsync 之前）。 */
const setBody = (() => {
  const start = store.indexOf('  set(partial: Partial<LauncherSettings>): LauncherSettings {')
  if (start < 0) return ''
  const end = store.indexOf('writeJsonAsync(', start)
  return end > start ? store.slice(start, end) : ''
})()

ok('找得到 set() 实现', setBody.length > 0)
ok(
  'set() 仍把 portable / gameDirAbs 从落盘对象里剔除',
  /delete \(next as Partial<LauncherSettings>\)\.portable/.test(setBody) &&
    /delete \(next as Partial<LauncherSettings>\)\.gameDirAbs/.test(setBody),
  '派生字段不该写进 settings.json'
)
ok(
  'set() 的 cachedSettings 补回 portable',
  /cachedSettings = \{[\s\S]*?portable: isPortable/.test(setBody),
  '缺了它 → 「默认版本目录」不再置灰'
)
ok(
  'set() 的 cachedSettings 补回 gameDirAbs',
  /cachedSettings = \{[\s\S]*?gameDirAbs: resolvePortablePath\(next\.gameDir\)/.test(setBody),
  '缺了它 → 资源管理器拿到相对路径、报「路径不存在」'
)
ok(
  'set() 的 cachedSettings 仍补 keySet 派生字段',
  /uapisApiKeySet: hasUapisKey\(\)/.test(setBody) && /aiApiKeySet: hasAiKey\(\)/.test(setBody)
)

console.log('\n资源管理器：入口统一解析相对路径')
const filesHandler = read('src/main/handlers/files.ts')
ok(
  'files:list 走 resolvePortablePath',
  /ipcMain\.handle\('files:list', \(_e, path: string\) => listDir\(resolvePortablePath\(path\)\)\)/.test(
    filesHandler
  ),
  '用户手输相对路径时也要能解析'
)
ok('files handler 引入了 resolvePortablePath', /import \{ resolvePortablePath \} from '\.\.\/portable'/.test(filesHandler))

console.log('\n启动时保证默认版本目录存在')
const appSrc = read('src/main/app.ts')
ok(
  'whenReady 里对当前版本目录做递归 mkdir',
  /mkdirSync\(activeGameDir\(settings\.get\(\)\), \{ recursive: true \}\)/.test(appSrc),
  '安装版此前没人创建默认目录，首次打开资源管理器必然 ENOENT'
)
ok(
  '创建目录失败不阻塞启动（有 try/catch 兜底）',
  /try \{\s*\n\s*mkdirSync\(activeGameDir\(settings\.get\(\)\)/.test(appSrc)
)

console.log('\n渲染层：优先使用解析后的绝对路径')
const rendererStore = read('src/renderer/src/store.tsx')
ok(
  'allVersionDirs 用 gameDirAbs 优先',
  /path: s\.gameDirAbs \?\? s\.gameDir/.test(rendererStore)
)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

/**
 * 载入界面「启动检查」闸门的回归测试。
 *
 * 要防的是两类静默故障（都不会在编译期报错）：
 *   1) 登记了步骤却永远不 done → 载入界面被钉住（必须有超时兜底，且超时要真的生效）；
 *   2) 父组件先判定「没有步骤」→ 遮罩提前撤掉 → 检查又变成「界面出来后才显示」，
 *      也就是这次要修的那个问题。
 *
 * 闸门是进程级单例（一次启动只放行一次），所以每个用例用不同的 URL 查询串重新加载
 * 一份模块实例，互不干扰。另外对三处接线做源码断言：漏改任何一处，闸门都不会生效，
 * 但界面看起来「正常工作」。
 *
 * 运行：node scripts/test-boot-gate.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GATE = pathToFileURL(resolve(ROOT, 'src/renderer/src/startup.ts')).href

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

/** 每个用例一份全新模块（进程级状态随实例重建）。 */
let seq = 0
const fresh = () => import(`${GATE}?case=${seq++}`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 在 ms 内是否已经放行。 */
async function settlesWithin(promise, ms) {
  const flag = Symbol('pending')
  const winner = await Promise.race([promise.then(() => 'settled'), sleep(ms).then(() => flag)])
  return winner === 'settled'
}

console.log('\n没有启动步骤：设置就绪即放行（不能白等）')
{
  const g = await fresh()
  const started = Date.now()
  const p = g.waitForBoot(3000)
  g.markBootReady()
  ok('立即放行', await settlesWithin(p, 80))
  ok('耗时可忽略', Date.now() - started < 80, `实际 ${Date.now() - started}ms`)
}

console.log('\n有启动步骤：必须等它完成')
{
  const g = await fresh()
  const done = g.bootStep('正在校验主页安全性…')
  const p = g.waitForBoot(3000)
  g.markBootReady()
  ok('步骤未完成前不放行', !(await settlesWithin(p, 150)))
  done()
  ok('完成后放行', await settlesWithin(p, 150))
}

console.log('\n多个步骤：全部完成才放行')
{
  const g = await fresh()
  const a = g.bootStep('A')
  const b = g.bootStep('B')
  const p = g.waitForBoot(3000)
  g.markBootReady()
  a()
  ok('只完成一个不放行', !(await settlesWithin(p, 120)))
  b()
  ok('两个都完成才放行', await settlesWithin(p, 120))
}

console.log('\n完成回调幂等：重复调用不会让计数变负、也不会提前放行')
{
  const g = await fresh()
  const a = g.bootStep('A')
  const b = g.bootStep('B')
  const p = g.waitForBoot(3000)
  g.markBootReady()
  a()
  a()
  a()
  ok('A 重复 done 不会误放行', !(await settlesWithin(p, 120)))
  b()
  ok('B 完成后放行', await settlesWithin(p, 120))
  a()
  ok('放行后再 done 不抛错', true)
}

console.log('\n超时兜底：网络卡住时不能把载入界面钉住')
{
  const g = await fresh()
  g.bootStep('永远不完成的步骤')
  const started = Date.now()
  const p = g.waitForBoot(600)
  g.markBootReady()
  ok('未完成时仍在等', !(await settlesWithin(p, 200)))
  ok('到上限后放行', await settlesWithin(p, 700))
  const elapsed = Date.now() - started
  ok('放行时间接近上限', elapsed >= 550 && elapsed < 1200, `实际 ${elapsed}ms`)
}

console.log('\n放行之后再登记：不应再把遮罩拉回来')
{
  const g = await fresh()
  const p = g.waitForBoot(3000)
  g.markBootReady()
  await p
  // 放行后才出现的重查（例如用户手动切主页）：返回的函数必须是空操作
  const late = g.bootStep('迟到的检查')
  ok('返回可调用且不抛错', typeof late === 'function' && (late(), true))
}

console.log('\n接线：三处必须同时成立')
{
  const main = readFileSync(resolve(ROOT, 'src/renderer/src/main.tsx'), 'utf8')
  ok('main.tsx 导入 waitForBoot', /import\s*{[^}]*waitForBoot[^}]*}\s*from\s*'\.\/startup'/.test(main))
  ok(
    'main.tsx 在主窗口分支等待后再撤骨架',
    /if \(windowKind === null\) await waitForBoot\(\d+\)\s*\n\s*dismissBootSplash\(\)/.test(main),
    '应当是 `if (windowKind === null) await waitForBoot(...)` 紧跟 dismissBootSplash()'
  )

  const session = readFileSync(resolve(ROOT, 'src/renderer/src/components/HomepageSession.tsx'), 'utf8')
  ok('HomepageSession 登记启动步骤', /bootStep\(t\('boot\.checkingHomepage'\)\)/.test(session))
  ok(
    'HomepageSession 不再用空闲帧推迟核对',
    !/import\s*{[^}]*runWhenIdle/.test(session) && !/runWhenIdle\(/.test(session),
    '注释里提到它没问题，但不能真的导入或调用'
  )
  ok('步骤在核对结束后释放', /finally\([\s\S]{0,80}done\(\)/.test(session) || /\.finally\(/.test(session))

  const app = readFileSync(resolve(ROOT, 'src/renderer/src/App.tsx'), 'utf8')
  ok('App 在 ready 时调用 markBootReady', /if \(ready\) markBootReady\(\)/.test(app))
  ok('markBootReady 来自 startup', /import\s*{\s*markBootReady\s*}\s*from\s*'\.\/startup'/.test(app))

  const html = readFileSync(resolve(ROOT, 'src/renderer/index.html'), 'utf8')
  ok('骨架里有步骤文字节点', /id="hc-boot-task"/.test(html))
  ok('骨架里没有内联脚本（CSP 只允许 self）', !/<script(?![^>]*\bsrc=)/i.test(html))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

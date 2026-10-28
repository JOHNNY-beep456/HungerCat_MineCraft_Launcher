/**
 * 窗口生命周期单测（离线，不需要 Electron）。
 *
 * 复现并锁住一类「关不掉的残留窗口」问题：
 *
 *   悬浮球 / HUD 浮层 / 弹幕 / 迷你窗 / 日志窗 / 开发工具窗都是**独立于主窗口**创建的
 *   置顶窗，主窗口关掉不会带走它们。如果关闭主窗口时不清这些窗，Electron 会认为
 *   「还有窗口」，于是 `window-all-closed` 不触发、`app.quit()` 不执行，
 *   进程连同浮层一起留在桌面上（任务栏能看见，却点不回主界面）。
 *
 * 本测试用一个最小模型模拟 Electron 的窗口集合与事件顺序，断言：
 *   · 关主窗口（含浮层时）→ 浮层全部关闭 → 「窗口清空」事件成立；
 *   · 「放置后台」（hide 而非 close）→ 浮层**不受影响**；
 *   · 托盘「退出程序」→ 兜底路径同样把浮层收干净。
 *
 * 运行：node scripts/test-window-lifecycle.mjs
 */

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

/**
 * 最小窗口模型：只保留本项目关心的语义。
 *
 * - `close()` 会从集合里移除（对应 BrowserWindow 真正关闭）
 * - `hide()` 不移除（对应「放置后台」）
 * - 集合空时触发一次 `window-all-closed`
 */
function createApp() {
  const windows = new Map()
  let idSeq = 0
  let windowAllClosedCount = 0
  let quitCount = 0
  let tray = null
  let isQuitting = false

  function makeWindow(name) {
    const id = ++idSeq
    windows.set(id, name)
    return {
      name,
      isDestroyed: () => !windows.has(id),
      close() {
        if (!windows.has(id)) return
        windows.delete(id)
        if (windows.size === 0 && !tray) {
          windowAllClosedCount++
          // 与真实实现一致：无托盘时 window-all-closed 里直接 quit
          quit()
        }
      },
      hide() {
        // 放置后台：窗口仍在集合里
      }
    }
  }

  function quit() {
    quitCount++
    isQuitting = true
    // will-quit 兜底：把所有附属窗再收一遍（幂等）
    for (const [, w] of staleWindows) w.close()
  }

  /** 模拟「附属窗口也登记在集合里」的引用表，供 quit 兜底使用。 */
  const staleWindows = new Map()

  return {
    windows,
    makeWindow,
    quit,
    get windowAllClosedCount() {
      return windowAllClosedCount
    },
    get quitCount() {
      return quitCount
    },
    get isQuitting() {
      return isQuitting
    },
    setTray(v) {
      tray = v
    },
    registerStale(w) {
      staleWindows.set(w.name, w)
    },
    /** 关主窗口：真实实现里会先触发 closed（应用层收浮层），再由 Electron 判空。 */
    closeMain(main, overlays, { closeOverlaysOnClosed = true } = {}) {
      main.close()
      if (closeOverlaysOnClosed) for (const o of overlays) o.close()
    }
  }
}

console.log('关主窗口时清理附属浮层')

{
  // 场景 A：修复后的行为 —— 主窗口 closed 时主动收掉浮层
  const app = createApp()
  const main = app.makeWindow('main')
  const ball = app.makeWindow('ai-ball')
  const hud = app.makeWindow('hud')
  const danmaku = app.makeWindow('danmaku')
  app.registerStale(ball)
  app.registerStale(hud)
  app.registerStale(danmaku)

  app.closeMain(main, [ball, hud, danmaku])
  ok('浮层窗口全部关闭', [ball, hud, danmaku].every((w) => w.isDestroyed()))
  ok('窗口集合已清空', app.windows.size === 0)
  ok('触发了 window-all-closed', app.windowAllClosedCount === 1)
  ok('进程进入退出流程', app.quitCount >= 1)
}

{
  // 场景 B：回归护栏 —— 若不收浮层（旧行为），窗口永远清不空
  const app = createApp()
  const main = app.makeWindow('main')
  const ball = app.makeWindow('ai-ball')
  const hud = app.makeWindow('hud')

  main.close() // 只关主窗口，不动浮层（旧行为）
  ok('浮层残留 → 集合非空', app.windows.size === 2)
  ok('window-all-closed 未触发', app.windowAllClosedCount === 0)
  ok('进程未退出（就是用户看到的「关不掉」）', app.quitCount === 0)
}

console.log('放置后台不受影响')

{
  // 场景 C：联机中「放置后台」= hide()，浮层应继续保留
  const app = createApp()
  const main = app.makeWindow('main')
  const ball = app.makeWindow('ai-ball')
  const hud = app.makeWindow('hud')
  app.setTray({})

  main.hide() // 放置后台
  ok('放置后台后主窗口仍在', !main.isDestroyed())
  ok('悬浮球与 HUD 都保留', !ball.isDestroyed() && !hud.isDestroyed())
  ok('没有触发退出', app.quitCount === 0)
  ok('没有触发 window-all-closed', app.windowAllClosedCount === 0)
}

console.log('托盘退出兜底')

{
  // 场景 D：放置后台后，从托盘点「退出程序」
  const app = createApp()
  const main = app.makeWindow('main')
  const ball = app.makeWindow('ai-ball')
  const hud = app.makeWindow('hud')
  const mini = app.makeWindow('mini')
  app.setTray({})
  for (const w of [ball, hud, mini]) app.registerStale(w)

  main.hide()
  app.quit() // quitAppCompletely → app.quit → will-quit 兜底
  ok('托盘退出后浮层被兜底关闭', [ball, hud, mini].every((w) => w.isDestroyed()))
  ok('窗口集合清空', app.windows.size === 1) // 主窗口只是 hide，仍在集合里
  ok('进程进入退出流程', app.quitCount === 1)
}

console.log('关闭按钮行为三态')

{
  /*
   * closeBehavior 语义矩阵（与 main/app.ts 的 close 处理器一一对应）：
   *   ask   拦下 + 弹框（用户选完才决定）
   *   tray  拦下 + hide（必须已有托盘，否则隐藏后无处唤回）
   *   quit  不拦，正常 close → closed → 清理浮层 → 窗口清空 → 退出
   */
  function simulateClose(behavior, { overlays = [], inLobby = false, trayAvailable = true } = {}) {
    const app = createApp()
    const main = app.makeWindow('main')
    const wins = overlays.map((n) => app.makeWindow(n))
    for (const w of wins) app.registerStale(w)

    let prevented = false
    let asked = false
    let hidden = false

    // ---- 对应 mainWindow.on('close') ----
    if (behavior === 'quit') {
      // 不拦
    } else if (behavior === 'tray') {
      prevented = true
      if (trayAvailable) {
        app.setTray({})
        main.hide()
        hidden = true
      }
    } else {
      prevented = true
      asked = true
    }

    if (!prevented) {
      // 正常关闭：Electron 关主窗口 → closed 里清理浮层
      main.close()
      for (const w of wins) w.close()
    }
    return { app, main, wins, prevented, asked, hidden, inLobby }
  }

  {
    const r = simulateClose('quit', { overlays: ['ai-ball', 'hud'] })
    ok('quit：不拦截', r.prevented === false)
    ok('quit：不弹框', r.asked === false)
    ok('quit：浮层被清理', r.wins.every((w) => w.isDestroyed()))
    ok('quit：窗口清空并触发退出', r.app.windows.size === 0 && r.app.quitCount >= 1)
  }

  {
    const r = simulateClose('tray', { overlays: ['ai-ball', 'hud'] })
    ok('tray：拦截关窗', r.prevented === true)
    ok('tray：隐藏主窗口', r.hidden === true)
    ok('tray：浮层保留（联机/HUD 继续可用）', r.wins.every((w) => !w.isDestroyed()))
    ok('tray：进程未退出', r.app.quitCount === 0)
  }

  {
    const r = simulateClose('ask', { overlays: ['ai-ball'] })
    ok('ask：拦截关窗并询问', r.prevented === true && r.asked === true)
    ok('ask：用户未作答时窗口保持', !r.main.isDestroyed() && !r.wins[0].isDestroyed())
  }

  {
    // 托盘建不起来（Linux 缺 AppIndicator）：tray 行为必须退化为「不隐藏」
    const r = simulateClose('tray', { trayAvailable: false })
    ok('托盘不可用时不隐藏（否则无处唤回）', r.hidden === false)
  }
}

console.log('幂等性')

{
  // 场景 E：反复关闭不应抛错（closeAllOverlays 会被调用两次：closed + will-quit）
  const app = createApp()
  const main = app.makeWindow('main')
  const ball = app.makeWindow('ai-ball')
  let threw = false
  try {
    ball.close()
    ball.close() // 第二次：已销毁
    main.close()
  } catch {
    threw = true
  }
  ok('重复关闭不抛异常', !threw)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

// 启动域 IPC：启动游戏（预下载 / Java 选择 / 窗口尺寸）与停止游戏。
import { BrowserWindow, dialog, ipcMain, screen } from 'electron'
import { join } from 'path'
import type { LaunchOptions } from '@shared/types'
import { settings, accounts, activeGameDir } from '../store'
import { refreshAccount } from '../auth'
import { refreshYggdrasil, ensureAuthlibInjector } from '../yggdrasil'
import { resolveVersionJson } from '../versions'
import { effectiveConcurrency } from '../network-profile'
import { installVersion } from '../downloader'
import { spawnGame } from '../launcher'
import type { IpcContext } from './context'

export function registerLaunchHandlers(ctx: IpcContext): void {
  // ---- Launch ----

  /** 自定义游戏窗口尺寸的合法范围（逻辑像素）：过小无意义，过大则几乎必然是误输入。 */
  const MIN_WINDOW = 320
  const MAX_WINDOW = 16384

  /**
   * 「最大化」时应使用的游戏窗口**内容区**尺寸。
   *
   * 两个关键点：
   *
   * 1) Minecraft 的 --width/--height 是**内容区**（不含标题栏与边框），而它创建的
   *    是普通带框窗口，不会被系统「最大化」。所以不能直接把工作区尺寸塞进去：
   *    实测（1920×1080 屏、任务栏 48px、窗口装饰 8×57）工作区 1920×1032 作为内容区时，
   *    窗口外框变成 1928×1089 —— 比整屏还高 9px，游戏画面底部约 49px 被任务栏盖住。
   * 2) 因此正确做法是「工作区 − 窗口装饰」：这样窗口外框恰好等于工作区，无论被放在
   *    哪个位置都不会超出、也都不会被任务栏遮挡。
   *
   * 任务栏是否隐藏由系统体现在工作区里（任务栏自动隐藏时工作区 = 整屏），
   * 所以这里不需要自己判断任务栏状态，跨平台也一致。
   *
   * 每次启动都重新测量（不缓存）：用户可能在运行期间改了「自动隐藏任务栏」。
   */
  function getMaximizedContentSize(): { width: number; height: number } {
    const d = screen.getPrimaryDisplay()
    let chromeW = 0
    let chromeH = 0
    let probe: BrowserWindow | null = null
    try {
      // 用同规格的隐藏窗口量出标题栏 + 边框占用的像素（同系统主题下与游戏窗口一致）。
      // 必须带 useContentSize：这样 width/height 才是内容区，getBounds 与 getContentBounds
      // 的差值才等于真实装饰量（实测 8×57）；否则隐藏窗口尚未套用完整装饰，会量成 8×31。
      probe = new BrowserWindow({ show: false, useContentSize: true, width: 400, height: 300 })
      const outer = probe.getBounds()
      const inner = probe.getContentBounds()
      chromeW = Math.max(0, outer.width - inner.width)
      chromeH = Math.max(0, outer.height - inner.height)
    } catch {
      // 无窗口系统 / 测量失败：不退让，仍按工作区尺寸（最多是回到修复前的表现）。
    } finally {
      probe?.destroy()
    }
    return {
      width: Math.max(MIN_WINDOW, d.workAreaSize.width - chromeW),
      height: Math.max(MIN_WINDOW, d.workAreaSize.height - chromeH)
    }
  }

  ipcMain.handle('launch:start', async (event, options: LaunchOptions) => {
    const s = settings.get()
    if (s.disabledVersions.includes(options.versionId)) {
      throw new Error('该版本已被禁用，请在版本管理中启用后再启动')
    }
    let account = accounts.list().find((a) => a.id === options.accountId) ?? accounts.selected()
    if (!account) throw new Error('请先登录一个账号')

    if (account.expiresAt < Date.now() + 60_000) {
      try {
        account =
          account.authType === 'yggdrasil' ? await refreshYggdrasil(account) : await refreshAccount(account)
        accounts.upsert(account)
      } catch (err) {
        throw new Error(`账号令牌已过期且刷新失败：${err instanceof Error ? err.message : err}`)
      }
    }

    const emit = (e: unknown): void => ctx.sendToSender(event.sender, 'launch:event', e)

    emit({ state: 'downloading' })
    const installDir = activeGameDir(s)
    const json = await resolveVersionJson(options.versionId, installDir)
    // 按「下载加速档位」换算实际并发：无线网络下自动收敛连接数，避免拥塞反而更慢。
    const effConcurrency = effectiveConcurrency(
      s.downloadAcceleration,
      s.downloadConnections,
      s.maxDownloadConcurrency
    )
    const runDir = ctx.isIsolated(options.versionId)
      ? join(installDir, 'versions', options.versionId)
      : installDir
    // 以版本 id 作为任务键：与「进度」页手动安装同一版本共用一条任务，
    // 且不再与其它下载互相覆盖控制器（原先单个变量会让并发任务彼此踩踏）。
    const downloadKey = options.versionId
    const controller = new AbortController()
    ctx.downloadAborts.set(downloadKey, controller)
    const result = await installVersion(json, installDir, effConcurrency.fileConcurrency, (p) => {
      ctx.sendToSender(event.sender, 'download:progress', { ...p, taskId: options.versionId })
    }, controller.signal, effConcurrency.connections).finally(() => {
      ctx.downloadAborts.delete(downloadKey)
    })

    // Java 选择优先级：启动前提示里当场选择的路径 >（关闭自动检测时）手动指定的 Java >
    // 按该游戏版本所需大版本自动挑选。开启自动检测时忽略手动指定的路径，
    // 这样 1.12.2（Java 8）与 1.20.5+（Java 21）等不同版本能各自用上对的 Java。
    const requiredJava = json.javaVersion?.majorVersion ?? 8
    let javaPath = options.javaPath
    if (!javaPath && !s.javaAutoDetect) javaPath = s.javaPath || undefined
    if (!javaPath) {
      javaPath = (await ctx.suitableJavaFor(s, requiredJava))?.path
    }
    if (!javaPath) {
      // 正常情况下渲染层已在启动前弹「是否安装 Java {requiredJava}」提示，这里只是兜底。
      throw new Error(`未找到合适的 Java ${requiredJava} 运行时，请先在「设置」中安装或手动指定 Java 路径`)
    }

    if (account.authType === 'yggdrasil') {
      await ensureAuthlibInjector(installDir)
    }

    emit({ state: 'launching' })
    // 游戏窗口尺寸：桌面模式强制全屏；否则按设置解析成具体分辨率 / 全屏。
    const winMode = s.experimental === 'win10' ? 'fullscreen' : s.gameWindowSize
    const primary = screen.getPrimaryDisplay()
    let fullscreen = false
    let resolution: { width: number; height: number }
    if (winMode === 'fullscreen') {
      fullscreen = true
      resolution = { width: primary.size.width, height: primary.size.height }
    } else if (winMode === 'maximized') {
      // 内容区必须扣掉窗口装饰，否则外框会超出工作区（见 getMaximizedContentSize 注释）。
      resolution = getMaximizedContentSize()
    } else if (winMode === 'custom') {
      const width = Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, Math.round(s.gameWindowWidth) || MIN_WINDOW))
      const height = Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, Math.round(s.gameWindowHeight) || MIN_WINDOW))
      resolution = { width, height }
      // 超出屏幕时同样给出警告（与设置页的预览警告一致），但不阻止启动。
      if (width > primary.size.width || height > primary.size.height) {
        const opts: Electron.MessageBoxOptions = {
          type: 'warning',
          title: '游戏窗口尺寸超出屏幕',
          message: `自定义的窗口尺寸 ${width}×${height} 超出了当前屏幕（${primary.size.width}×${primary.size.height}）。`,
          detail: '游戏窗口可能显示不全。可在「设置 → 游戏 → 游戏窗口尺寸」中改用较小的尺寸或选择「最大化」。',
          buttons: ['仍然启动'],
          defaultId: 0,
          noLink: true
        }
        const mw = ctx.mainWindow()
        if (mw && !mw.isDestroyed()) await dialog.showMessageBox(mw, opts)
        else await dialog.showMessageBox(opts)
      }
    } else {
      resolution = winMode === '1080p' ? { width: 1920, height: 1080 } : { width: 1280, height: 720 }
    }
    const launchOptions: LaunchOptions = {
      ...options,
      ...(fullscreen ? { fullscreen: true } : {}),
      resolution
    }
    const proc = spawnGame(
      {
        json,
        installDir,
        runDir,
        javaPath,
        nativesDir: result.nativesDir,
        assetIndexId: result.assetIndexId,
        account,
        options: launchOptions
      },
      emit
    )
    ctx.setGameProcess(proc)

    return { pid: proc.pid ?? 0 }
  })
  ipcMain.handle('launch:stop', () => {
    ctx.gameProcess()?.kill()
    return true
  })
}

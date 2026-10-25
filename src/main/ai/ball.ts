/**
 * AI 悬浮球窗口。
 *
 * 一个**独立于主窗口**的透明置顶小窗：
 *   · 收起时是个 76×76 的圆球，默认贴屏幕右下角；
 *   · 点一下展开成聊天面板（同一窗口变大，不做第二个窗口，避免焦点来回跳）；
 *   · 拖动时由渲染层上报目标坐标，主进程负责夹进工作区并写回设置
 *     （`aiBallX` / `aiBallY`），因此**重启后位置不变**。
 *
 * 为什么不把它做成主窗口里的一个元素：主窗口最小化 / 关闭到后台 / 被游戏全屏盖住时，
 * 悬浮球都要仍然可用，只能靠独立窗口 + `alwaysOnTop('screen-saver')`。
 */
import { BrowserWindow, screen } from 'electron'
import { join, resolve } from 'path'
import { settings } from '../store'

/** 收起 / 展开两种尺寸（逻辑像素）。 */
const COLLAPSED = { width: 76, height: 76 }
const EXPANDED = { width: 400, height: 580 }
/** 距屏幕边缘的默认留白。 */
const MARGIN = 24

/**
 * 渲染层入口（开发态用 devServer，生产态用打包后的 index.html）。
 *
 * 与 app.ts 里 OUT_DIR 的算法保持一致：electron-vite 会把主进程打成
 * `out/main/chunks/*.js`，因此 `__dirname` 落在 `chunks/` 里，向上两级才是 `out/`。
 * 直接用 `__dirname` 拼相对路径会指到 `out/main/chunks/out`，加载必然失败。
 */
const OUT_DIR = resolve(__dirname, '..', '..')

let ballWindow: BrowserWindow | null = null
/** 当前是否处于展开态：同步窗口尺寸、「同步显隐」判断都依赖它。 */
let expanded = false

/** 取主显示器工作区（排除任务栏）。 */
function workArea(): Electron.Rectangle {
  return screen.getPrimaryDisplay().workArea
}

/** 把坐标夹进工作区，保证球不会被拖到屏幕外。 */
function clampToWorkArea(x: number, y: number, size: { width: number; height: number }): { x: number; y: number } {
  const area = workArea()
  const minX = area.x
  const minY = area.y
  const maxX = area.x + area.width - size.width
  const maxY = area.y + area.height - size.height
  return {
    x: Math.min(maxX, Math.max(minX, Math.round(x))),
    y: Math.min(maxY, Math.max(minY, Math.round(y)))
  }
}

/** 默认位置：右下角。 */
function defaultPosition(size: { width: number; height: number }): { x: number; y: number } {
  const area = workArea()
  return clampToWorkArea(
    area.x + area.width - size.width - MARGIN,
    area.y + area.height - size.height - MARGIN,
    size
  )
}

/** 当前应当使用的尺寸。 */
function currentSize(): { width: number; height: number } {
  return expanded ? EXPANDED : COLLAPSED
}

/** 创建悬浮球窗口（已存在则直接返回）。 */
export function createAiBall(): BrowserWindow {
  if (ballWindow && !ballWindow.isDestroyed()) return ballWindow

  const s = settings.get()
  const size = currentSize()
  // 位置来自设置；-1 表示「从没拖过」→ 现算右下角。
  const stored = s.aiBallX >= 0 && s.aiBallY >= 0 ? { x: s.aiBallX, y: s.aiBallY } : defaultPosition(size)
  const pos = clampToWorkArea(stored.x, stored.y, size)

  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: pos.x,
    y: pos.y,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: 'AI 助手',
    webPreferences: {
      preload: join(OUT_DIR, 'preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  // 置顶等级与 HUD 一致：全屏游戏 / 全屏应用之上仍然可见。
  win.setAlwaysOnTop(true, 'screen-saver')
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    ballWindow = null
    expanded = false
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    void win.loadURL(`${rendererUrl}?window=ai-ball`)
  } else {
    void win.loadFile(join(OUT_DIR, 'renderer/index.html'), { query: { window: 'ai-ball' } })
  }

  ballWindow = win
  return win
}

/** 关闭悬浮球窗口。 */
export function closeAiBall(): void {
  if (ballWindow && !ballWindow.isDestroyed()) ballWindow.close()
  ballWindow = null
  expanded = false
}

/** 按设置显示 / 隐藏（幂等，设置变更与启动时都调用）。 */
export function syncAiBall(): void {
  const s = settings.get()
  const should = s.aiEnabled && s.aiBallEnabled
  if (should) {
    if (!ballWindow || ballWindow.isDestroyed()) createAiBall()
  } else if (ballWindow && !ballWindow.isDestroyed()) {
    closeAiBall()
  }
}

/** 展开 / 收起聊天面板。 */
export function expandAiBall(open: boolean): void {
  if (!ballWindow || ballWindow.isDestroyed()) return
  if (expanded === open) return
  expanded = open
  const size = currentSize()
  const bounds = ballWindow.getBounds()
  // 以「右下角为锚点」调整：展开时向左上长，收起时收回右下角，视觉上不会乱跳。
  const anchorX = bounds.x + bounds.width
  const anchorY = bounds.y + bounds.height
  const next = clampToWorkArea(anchorX - size.width, anchorY - size.height, size)
  ballWindow.setBounds({ x: next.x, y: next.y, width: size.width, height: size.height })
  settings.set({ aiBallX: next.x, aiBallY: next.y })
  ballWindow.webContents.send('ai:ballExpanded', open)
}

/**
 * 拖动：把窗口移到目标位置；`persist` 为真时写回设置（松手时用）。
 *
 * 返回**实际应用**的位置：坐标会被夹进工作区，贴着屏幕边缘拖动时
 * 请求值与落点并不相同，渲染层必须用返回值来校正自己的位置缓存，
 * 否则下一次拖动的增量会基于已经过期的起点，出现「越拖越偏」。
 */
export function moveAiBall(x: number, y: number, persist: boolean): { x: number; y: number } | null {
  if (!ballWindow || ballWindow.isDestroyed()) return null
  const pos = clampToWorkArea(x, y, currentSize())
  ballWindow.setPosition(pos.x, pos.y)
  if (persist) settings.set({ aiBallX: pos.x, aiBallY: pos.y })
  return pos
}

/** 当前窗口位置（渲染层拖动时用来算增量）。 */
export function aiBallPosition(): { x: number; y: number } {
  if (!ballWindow || ballWindow.isDestroyed()) return defaultPosition(currentSize())
  const b = ballWindow.getBounds()
  return { x: b.x, y: b.y }
}

/** 窗口实例（广播 / 关闭时用）。 */
export function aiBallWindow(): BrowserWindow | null {
  return ballWindow && !ballWindow.isDestroyed() ? ballWindow : null
}
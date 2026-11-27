import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import { installRendererLogForwarding } from './log-forwarding'
import { waitForBoot } from './startup'

const windowKind = new URLSearchParams(window.location.search).get('window')

/**
 * 只有主窗口显示 index.html 里的启动骨架。
 *
 * 受限窗口（debug / devtools / hud / danmaku / ai-hud / ai-ball / mini）与本文件共用同一份
 * index.html，但它们必须是「立刻可用」的浮层，绝不能在透明窗口里先画一块不透明底板。
 * 这里的判断与 `mount()` 的分支条件同源（都以 `window` 查询参数为准），不另立规则。
 *
 * 宿主没有 `documentElement` 时（源码级测试夹具）静默跳过：骨架纯属观感优化，
 * 不能因为缺少 DOM 就让启动流程抛错。
 */
const rootElement: HTMLElement | undefined = document.documentElement ?? undefined
if (windowKind === null && rootElement) rootElement.dataset['window'] = 'main'

/**
 * 首个界面帧提交后让启动骨架淡出。
 *
 * 用两层 `requestAnimationFrame`：第一层回调时本帧已提交、样式已生效，第二层再置标记，
 * 确保淡出的是「已经画出来的界面」而不是一块还没内容的空壳。没有 rAF 的宿主直接置标记。
 */
function dismissBootSplash(): void {
  const root = document.documentElement
  if (!root) return
  const done = (): void => {
    root.dataset['boot'] = 'ready'
  }
  const raf = window.requestAnimationFrame
  if (typeof raf === 'function') {
    raf(() => raf(done))
    return
  }
  done()
}

/**
 * 渲染层日志 / 错误统一转发到主进程。
 *
 * 此处只把日志交给宿主缓冲，不触发网络上传；诊断上传由用户另行主动提交并确认同意。
 * 这里做三件事：
 *   1) 转发 console 的 warn/error（保留原生行为，仅旁路一份给主进程）；
 *   2) 捕获 window 的 error / unhandledrejection 全局错误；
 *   3) 上报失败的动态 import（挂载失败最常见的原因）。
 * 日志窗口自身不转发，避免噪音。
 */
function installLogForwarding(): void {
  // 独立受限 AI 页同日志页不旁路发送日志，不为日志扩大业务窗口的权限。
  if (windowKind === 'debug' || windowKind === 'devtools' || (windowKind === 'mini' && '__TAURI_INTERNALS__' in window) || ((windowKind === 'ai-hud' || windowKind === 'ai-ball') && '__TAURI_INTERNALS__' in window && ['win32', 'darwin', 'linux'].includes(window.api.platform))) return
  const report = window.api?.debug?.reportLog
  if (typeof report !== 'function') return
  installRendererLogForwarding(window, report)
}

async function mount(preloadedApp?: Promise<{ default: () => JSX.Element }>): Promise<void> {
  const container = document.getElementById('root') as HTMLElement
  if (windowKind === 'mini') {
    // 小窗需要先完成受限原生握手，再由自己的入口创建唯一 React root。
    const { mountMiniWindow } = await import('./mini-bootstrap')
    await mountMiniWindow(new AbortController().signal)
    return
  }
  const root = ReactDOM.createRoot(container)
  if (windowKind === 'debug') {
    // 独立日志窗口：只挂载极简日志视图，不加载完整启动器界面。
    const { DebugLogWindow } = await import('./components/DebugLogWindow')
    root.render(<DebugLogWindow />)
  } else if (windowKind === 'devtools') {
    // 开发模式：独立「开发者工具（F12）」窗口，与主界面分开，避免内容挤乱。
    const { DevToolsWindow } = await import('./components/DevToolsWindow')
    root.render(<DevToolsWindow />)
  } else if (windowKind === 'hud') {
    // 联机板块：游戏内 HUD 浮层（透明穿透，显示成员与说话状态）。
    const { GameHud } = await import('./components/GameHud')
    root.render(<GameHud />)
  } else if (windowKind === 'danmaku') {
    // 联机板块：消息弹幕浮层（透明穿透，滚动显示聊天消息）。
    const { DanmakuOverlay } = await import('./components/DanmakuOverlay')
    root.render(<DanmakuOverlay />)
  } else if (windowKind === 'ai-hud' && '__TAURI_INTERNALS__' in window && ['win32', 'darwin', 'linux'].includes(window.api.platform)) {
    // Windows 独立页额外挂载语音命令消费者，卡片 JSX/CSS 与移动只读消费者不变。
    if (window.api.platform === 'win32') {
      const { TauriAiHudDesktop } = await import('./components/TauriAiHudDesktop')
      root.render(<TauriAiHudDesktop />)
    } else {
      const { TauriAiHud } = await import('./components/TauriAiHud')
      root.render(<TauriAiHud />)
    }
  } else if (windowKind === 'ai-ball') {
    // AI 助手：桌面悬浮球（可拖动的小窗，点开展开成聊天面板）。
    // 刻意不挂 AppProvider：它要能独立于主窗口瞬间出现，不该背上账号 / 主页 / 更新检查的启动开销。
    const { AiBall } = await import('./components/AiBall')
    root.render(<AiBall />)
  } else {
    const { default: App } = preloadedApp ? await preloadedApp : await import('./App')
    const mobileTauri = '__TAURI_INTERNALS__' in window && ['android', 'ios'].includes(window.api.platform)
    const MobileDebugHost = mobileTauri
      ? (await import('./components/TauriMobileDebugHost')).TauriMobileDebugHost
      : null
    const MobileAiHudHost = mobileTauri
      ? (await import('./components/TauriAiHudHost')).TauriAiHudHost
      : null
    root.render(
      <React.StrictMode>
        <App />
        {MobileDebugHost && <MobileDebugHost />}
        {MobileAiHudHost && <MobileAiHudHost />}
      </React.StrictMode>
    )
  }
}

async function bootstrap(): Promise<void> {
  // Electron 继续使用 preload；Tauri 在加载业务组件前安装相同的公开接口。
  if ('__TAURI_INTERNALS__' in window) {
    const { installTauriApi } = await import('../../tauri/bridge')
    // 安装是同步的：返回时 `window.api` 已在位，桥接的异步部分只剩事件注册。
    const installation = installTauriApi()
    // 平台标识写在 <html> 上：样式层据此切换移动端外壳（见 index.css 的 [data-platform] 规则）。
    // 必须在 mount 之前完成，否则首帧会按桌面布局绘制再跳变；这里提前到等事件注册之前。
    document.documentElement.dataset.platform = installation.api.platform
    // 主窗口的业务入口与事件注册并行：`window.api` 已就位，模块求值可以安全地读平台、
    // 也可以随时发起调用（内部会自己等 ready）。串行的话，入口 chunk 的加载与解析要排在
    // 一次 IPC 往返之后，白等一个来回。
    const preloadedApp = windowKind === null ? import('./App') : undefined
    await installation.ready
    installLogForwarding()
    await mount(preloadedApp)
  } else {
    const platform = window.api?.platform ?? 'unknown'
    document.documentElement.dataset.platform = platform
    installLogForwarding()
    await mount()
  }
  // 界面已提交，但先别撤骨架：主页联网核对这类「启动时只做一次」的检查会登记成
  // 启动步骤（见 startup.ts 的 bootStep），要在遮罩背后做完再露界面 ——
  // 否则用户会先看到界面，再看到侧栏图标闪 / 闸门转圈，像是「界面出来了才开始干活」。
  // 只对主窗口等待：受限浮层（HUD / 弹幕 / 小窗 / 日志）不显示骨架，也没有 App 去
  // 调用 markBootReady，干等只会白占 3s。上限 3s 是兜底：网络卡住时先放行。
  if (windowKind === null) await waitForBoot(3000)
  dismissBootSplash()
}

void bootstrap().catch((error: unknown) => {
  console.error('启动器界面初始化失败', error)
  const root = document.getElementById('root')
  if (root) root.textContent = error instanceof Error ? error.message : '启动器初始化失败'
  // 失败时同样让出：错误文字必须可见，不能被骨架盖住而变成「永远转圈」。
  dismissBootSplash()
})
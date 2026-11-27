// ---------------------------------------------------------------------------
// 页面映射表：普通外壳（侧栏切换）与实验性 Win10 桌面（窗口打开）共用同一份，
// 避免两处各写一遍 switch。
//
// 冷启动只解析首屏要用的代码：除首页外，每个页面都是 `React.lazy`，
// 第一次切过去时才下载 + 求值。页面 chunk 走本地 `tauri://` 资源，
// 命中系统页缓存后与静态导入无可感差异，但冷启动少了 1 万行级的解析量。
//
// 三条约定，改这里时别破坏：
//   1. 首页（HomeRoute → 内置主页 / 自定义主页）必须保持静态导入 —— 它就是首屏。
//   2. 懒加载组件沿用原导出名（`AiChatPage` / `SettingsPage` …），switch 分支里的
//      JSX 一字不改：`scripts/test-tauri-ai-chat.mjs` 直接对这些源码文本做断言。
//   3. Suspense 边界收在本文件里（`withSuspense`），调用方不必自己包：
//      漏包的表现是整页白掉，而不是一个受控的占位。
// ---------------------------------------------------------------------------

import { Suspense, lazy, type ReactNode } from 'react'
import type { PageId } from '../components/Sidebar'
import { HomeRoute } from './CustomHomePage'
import type { Tab } from './ResourceDownloadPage'

const HomepagePage = lazy(() => import('./HomepagePage').then((m) => ({ default: m.HomepagePage })))
const ResourceDownloadPage = lazy(() =>
  import('./ResourceDownloadPage').then((m) => ({ default: m.ResourceDownloadPage }))
)
const InstancesPage = lazy(() => import('./InstancesPage').then((m) => ({ default: m.InstancesPage })))
const MultiplayerPage = lazy(() => import('./MultiplayerPage').then((m) => ({ default: m.MultiplayerPage })))
const AiChatPage = lazy(() => import('./AiChatPage').then((m) => ({ default: m.AiChatPage })))
const AccountsPage = lazy(() => import('./AccountsPage').then((m) => ({ default: m.AccountsPage })))
const DownloadsPage = lazy(() => import('./DownloadsPage').then((m) => ({ default: m.DownloadsPage })))
const SettingsPage = lazy(() => import('./SettingsPage').then((m) => ({ default: m.SettingsPage })))
const FeedbackPage = lazy(() => import('./FeedbackPage').then((m) => ({ default: m.FeedbackPage })))
const AboutPage = lazy(() => import('./AboutPage').then((m) => ({ default: m.AboutPage })))

/**
 * 实例管理整页（点「管理」才进入）同样是按需加载。
 *
 * 它不经过 `renderPage`（由 `App` / `Win10Desktop` 用 `managingId` 直接渲染），
 * 所以单独在这里导出，让两个入口共用同一个 chunk 与同一个组件实例。
 */
export const LazyInstanceManagePage = lazy(() =>
  import('./InstanceManagePage').then((m) => ({ default: m.InstanceManagePage }))
)

/** 资源下载页的预置定位（引导安装时使用）。 */
export type ResourcePreset = { tab: Extract<Tab, 'versions'>; search: string } | null

/**
 * 懒加载页面的统一占位。
 *
 * 刻意留空：chunk 是本地文件，正常命中只需几毫秒，画一个「加载中」反而会闪一下。
 * `aria-busy` 让读屏知道这里在加载，`h-full` 保持容器高度，避免布局跳动。
 */
export function PageFallback(): JSX.Element {
  return <div className="h-full" aria-busy="true" />
}

/** 给懒加载内容包一层边界；调用方（Shell / Win10 桌面）不必重复写 Suspense。 */
function withSuspense(node: ReactNode): JSX.Element {
  return <Suspense fallback={<PageFallback />}>{node}</Suspense>
}

export function renderPage(
  page: PageId,
  onManage: (versionId: string) => void,
  resourcePreset: ResourcePreset,
  onNavigate?: (p: PageId) => void,
  /**
   * 是否允许进入「联机」板块（实验性功能，默认关闭）。
   *
   * 侧栏已在未开启时不渲染该入口，但导航状态可能残留（例如用户开着联机页
   * 去设置里把它关掉）。这里做兜底：不允许时直接回落主页，避免出现
   * 「入口没了、页面却还停着」的半死状态。
   */
  multiplayerEnabled = false,
  /**
   * 是否允许进入「对话」板块：仅在设置里开启 AI 助手后出现。
   *
   * 与联机一样做路由兜底，避免用户停在对话页时关闭 AI 开关出现「入口没了、页面还在」。
   */
  aiEnabled = false
): JSX.Element {
  // switch 放在闭包里，返回值统一由 withSuspense 包一层；
  // 这样每个分支仍是原本的 `return <XxxPage />` 形态，源码断言与可读性都不变。
  const view = (): JSX.Element => {
    switch (page) {
      case 'home':
        return <HomeRoute onManage={onManage} onNavigate={onNavigate} />
      case 'homepage':
        return <HomepagePage />
      case 'resources':
        return <ResourceDownloadPage initialTab={resourcePreset?.tab} presetSearch={resourcePreset?.search} />
      case 'instances':
        return <InstancesPage onManage={onManage} />
      case 'multiplayer':
        // 未开启实验性联机：不渲染联机页，回落主页。
        if (!multiplayerEnabled) return <HomeRoute />
        // onExit：拒绝 MCTier 许可协议时返回主界面（onNavigate 缺省时不显示「拒绝」）
        return <MultiplayerPage onExit={onNavigate ? () => onNavigate('home') : undefined} />
      case 'chat':
        // 未开启 AI 助手：不渲染对话页，回落主页。
        if (!aiEnabled) return <HomeRoute />
        return <AiChatPage />
      case 'accounts':
        return <AccountsPage />
      case 'downloads':
        return <DownloadsPage />
      case 'settings':
        return <SettingsPage />
      case 'feedback':
        return <FeedbackPage />
      case 'about':
        return <AboutPage />
    }
  }
  return withSuspense(view())
}

// ---------------------------------------------------------------------------
// 页面映射表：普通外壳（侧栏切换）与实验性 Win10 桌面（窗口打开）共用同一份，
// 避免两处各写一遍 switch。
// ---------------------------------------------------------------------------

import type { PageId } from '../components/Sidebar'
import { HomeRoute } from './CustomHomePage'
import { HomepagePage } from './HomepagePage'
import { ResourceDownloadPage, type Tab } from './ResourceDownloadPage'
import { AccountsPage } from './AccountsPage'
import { DownloadsPage } from './DownloadsPage'
import { SettingsPage } from './SettingsPage'
import { AboutPage } from './AboutPage'
import { InstancesPage } from './InstancesPage'
import { MultiplayerPage } from './MultiplayerPage'

/** 资源下载页的预置定位（引导安装时使用）。 */
export type ResourcePreset = { tab: Extract<Tab, 'versions'>; search: string } | null

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
  multiplayerEnabled = false
): JSX.Element {
  switch (page) {
    case 'home':
      return <HomeRoute />
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
    case 'accounts':
      return <AccountsPage />
    case 'downloads':
      return <DownloadsPage />
    case 'settings':
      return <SettingsPage />
    case 'about':
      return <AboutPage />
  }
}

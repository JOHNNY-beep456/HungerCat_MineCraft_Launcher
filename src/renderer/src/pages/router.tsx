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

/** 资源下载页的预置定位（引导安装时使用）。 */
export type ResourcePreset = { tab: Extract<Tab, 'versions'>; search: string } | null

export function renderPage(
  page: PageId,
  onManage: (versionId: string) => void,
  resourcePreset: ResourcePreset
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

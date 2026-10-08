import { useApp } from '../store'
import { ModeSection } from './settings/ModeSection'
import { AppearanceSection } from './settings/AppearanceSection'
import { ExperimentalSection } from './settings/ExperimentalSection'
import { DeveloperSection } from './settings/DeveloperSection'
import { GameSection } from './settings/GameSection'
import { JavaSection } from './settings/JavaSection'
import { DownloadSection } from './settings/DownloadSection'
import { CommunitySection } from './settings/CommunitySection'
import { NoticeSection } from './settings/NoticeSection'
import { UpdateSection } from './settings/UpdateSection'

/**
 * 设置页组合根：只负责标题与滚动容器，各设置板块拆到 `settings/` 目录下。
 * 导出签名保持 `SettingsPage`（router.tsx 以具名方式引入），行为与原单文件一致。
 */
export function SettingsPage(): JSX.Element {
  const { t } = useApp()

  return (
    <div className="flex h-full flex-col gap-5">
      <div>
        <h1 className="display">{t('settings.title')}</h1>
        <p className="caption mt-1">{t('settings.subtitle')}</p>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        <ModeSection />
        <AppearanceSection />
        <ExperimentalSection />
        <DeveloperSection />
        <GameSection />
        <JavaSection />
        <DownloadSection />
        <CommunitySection />
        <NoticeSection />
        <UpdateSection />
      </div>
    </div>
  )
}

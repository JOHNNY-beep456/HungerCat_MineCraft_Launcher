import { useApp } from '../store'
import { GeneralSection } from './settings/GeneralSection'
import { LanguageSection } from './settings/LanguageSection'
import { GameSection } from './settings/GameSection'
import { AiSection } from './settings/AiSection'
import { DownloadSection } from './settings/DownloadSection'
import { ExperimentalSection } from './settings/ExperimentalSection'
import { DeveloperSection } from './settings/DeveloperSection'
import { UpdateSection } from './settings/UpdateSection'

/**
 * 设置页组合根：只负责标题与滚动容器，各设置板块拆到 `settings/` 目录下。
 * 导出签名保持 `SettingsPage`（router.tsx 以具名方式引入），行为与原单文件一致。
 *
 * 板块顺序（按设置页改版要求固定）：
 *   通用 → 语言 → 游戏 → AI 助手（实验性）→ 下载 → 部分实验性功能
 *   → 开发者选项 → 公告 & 更新
 *
 * 原「模式」「外观」「Java 运行时」「社区资源」「公告」「更新」六个板块已重组：
 *   · 模式 / 外观 → 拆成「通用」（配色、背景、导航栏、运行模式、服务器状态、
 *     关闭行为等）与「语言」（界面语言 + 自动翻译）；
 *   · Java 运行时 → 并入「游戏」板块末尾；
 *   · 社区资源 → 撤销（下层的 communitySource / modTitleStyle 字段保留）；
 *   · 公告 + 更新 → 合并为「公告 & 更新」。
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
        <GeneralSection />
        <LanguageSection />
        <GameSection />
        <AiSection />
        <DownloadSection />
        <ExperimentalSection />
        <DeveloperSection />
        <UpdateSection />
      </div>
    </div>
  )
}

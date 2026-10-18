import { AutoSection } from './AutoSection'
import { Win10DesktopRow } from './rows'

/**
 * 「实验性功能」板块：随壁纸切明暗、导航栏置顶、联机板块、GPU 加速与 Win10 桌面模式。
 *
 * Win10 桌面不是观感皮肤（它是另一套整屏界面），所以不并入「外观 → 主题」下拉，
 * 而是作为板块末尾的一行独立开关；它没有对应的设置字段（读写的是 `experimental`），
 * 故走 `AutoSection` 的 children 而不是注册表。
 */
export function ExperimentalSection(): JSX.Element {
  return (
    <AutoSection section="experimental" titleKey="settings.section.experimental" icon="info">
      <Win10DesktopRow />
    </AutoSection>
  )
}

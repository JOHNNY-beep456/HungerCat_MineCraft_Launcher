import { AutoSection } from './AutoSection'

/** 「外观」板块：语言、明暗模式、界面主题（皮肤）、强调色、背景、壁纸、减少动态效果与自动翻译。 */
export function AppearanceSection(): JSX.Element {
  return <AutoSection section="appearance" titleKey="settings.appearance" icon="palette" />
}

import { AutoSection } from './AutoSection'

/** 「实验性功能」板块：界面皮肤、随壁纸切主题、导航栏置顶与联机板块。 */
export function ExperimentalSection(): JSX.Element {
  return <AutoSection section="experimental" titleKey="settings.section.experimental" icon="info" />
}

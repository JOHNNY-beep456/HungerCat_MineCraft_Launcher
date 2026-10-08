import { AutoSection } from './AutoSection'

/** 「模式」板块：运行模式、服务器状态。字段全部由共享注册表自动渲染。 */
export function ModeSection(): JSX.Element {
  return <AutoSection section="mode" titleKey="settings.section.mode" icon="settings" />
}

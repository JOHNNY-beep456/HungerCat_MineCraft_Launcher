import { AutoSection } from './AutoSection'
import { UapisKeyRow } from './rows'

/** 「模式」板块：运行模式、服务器状态、uapis.cn API KEY。字段由共享注册表自动渲染，
 * uapis.cn 行作为自定义子节点追加（真实 KEY 经主进程加密保存，不落入 settings.json）。 */
export function ModeSection(): JSX.Element {
  return (
    <AutoSection section="mode" titleKey="settings.section.mode" icon="settings">
      <UapisKeyRow />
    </AutoSection>
  )
}

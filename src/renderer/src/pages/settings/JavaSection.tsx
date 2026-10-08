import { AutoSection } from './AutoSection'

/** 「Java」板块：自动检测开关与已检测到的 Java 运行时选择。 */
export function JavaSection(): JSX.Element {
  return <AutoSection section="java" titleKey="settings.section.java" icon="settings" />
}

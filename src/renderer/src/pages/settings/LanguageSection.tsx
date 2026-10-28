import { AutoSection } from './AutoSection'

/**
 * 「语言」板块：界面语言、自动翻译（及子选项「翻译资源名」）。
 *
 * 从原「外观」板块里拆出来单独成节 —— 语言与自动翻译是一组，和配色 / 背景
 * 那些纯外观项放在一起并不合适。
 */
export function LanguageSection(): JSX.Element {
  return <AutoSection section="language" titleKey="settings.section.language" icon="message" />
}

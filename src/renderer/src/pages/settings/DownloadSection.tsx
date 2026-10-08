import { AutoSection } from './AutoSection'

/**
 * 「下载」板块。
 *
 * 全部配置项由共享注册表 `@shared/settings` 中 `section: 'download'` 的字段自动渲染
 * （来源策略、加速档位、并发 / 连接数）。新增下载参数时只需在注册表登记 `ui` 元数据，
 * 本文件与设置页其它代码都无需改动。
 */
export function DownloadSection(): JSX.Element {
  return (
    <AutoSection
      section="download"
      titleKey="settings.section.download"
      icon="download"
      footnotes={['settings.hint.download', 'settings.hint.source']}
    />
  )
}

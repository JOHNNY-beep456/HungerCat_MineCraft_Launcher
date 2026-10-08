import { useApp } from '../../store'
import { AutoSection } from './AutoSection'

/** 「社区资源」板块：模组 / 资源包 / 光影的来源与标题展示样式。 */
export function CommunitySection(): JSX.Element {
  const { t } = useApp()
  return (
    <AutoSection
      section="community"
      titleKey="settings.section.community"
      icon="box"
      // 中文译名已暂时撤销：置顶一条提示，来源选项与样式一并置灰说明，避免用户误以为还能选。
      intro={
        <p className="caption px-1" style={{ color: 'var(--fill-danger)' }}>
          {t('settings.communityDisabled')}
        </p>
      }
    />
  )
}

import { AutoSection } from './AutoSection'

/**
 * 「通用」板块：明暗模式、运行模式、主题（含主题类型 / 主题色）、减少动态效果、
 * uapis.cn API KEY、背景、自定义壁纸、导航栏位置、显示服务器状态、关闭按钮行为。
 *
 * 字段全部由共享注册表的 `section: 'general'` 自动渲染（顺序即注册表声明顺序），
 * 所以这里只需给出板块外壳。
 */
export function GeneralSection(): JSX.Element {
  return <AutoSection section="general" titleKey="settings.section.general" icon="settings" />
}

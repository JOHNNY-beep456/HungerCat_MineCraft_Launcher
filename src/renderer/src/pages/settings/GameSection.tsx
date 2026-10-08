import { AutoSection } from './AutoSection'

/** 「游戏」板块：游戏目录、版本隔离、窗口尺寸、关闭启动器、调试模式与调试密钥。 */
export function GameSection(): JSX.Element {
  return <AutoSection section="game" titleKey="settings.section.game" icon="cube" />
}

import { AutoSection } from './AutoSection'

/**
 * 「游戏」板块：默认版本目录、版本隔离、模组信息仅识别元数据、HUD 显示、
 * 游戏窗口尺寸、启动游戏后关闭启动器，以及末尾的 Java 运行时（原独立板块，已并入）。
 *
 * 所有条目（含 Java 自动检测与版本选择）都由共享注册表 `section: 'game'` 的
 * 声明顺序自动渲染 —— Java 那一组是联动控件，由 `javaAutoDetect` 对应的自定义行
 * `JavaAutoRow` 一并绘制（开关 + 版本下拉 + 手动路径）。
 */
export function GameSection(): JSX.Element {
  return <AutoSection section="game" titleKey="settings.section.game" icon="cube" />
}

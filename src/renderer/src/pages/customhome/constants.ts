// ---------------------------------------------------------------------------
// 自定义主页拆分模块的常量。
// ---------------------------------------------------------------------------

/**
 * 注入 iframe 的设计令牌：宿主变量名 → 暴露给脚本的 --hc-* 变量名。
 *
 * 后六项是「形状 / 材质」一档：宿主各皮肤原本各自用私有变量名表达圆角与材质
 * （--gh-radius-control、--wu3-radius-card、--mc-radius…），名字互不相通，
 * 脚本没法跟随。这里由 index.css 统一成跨皮肤同义名再映射过来，于是脚本只写
 * `border-radius: var(--hc-radius-card)` 就能自动跟随当前皮肤；宿主没给出值时
 * 落到 sandbox.ts 里 --hc-base 的兜底，老脚本与新皮肤都不会开天窗。
 *
 *   --hc-radius-control        控件圆角
 *   --hc-radius-card           卡片 / 浮层圆角
 *   --hc-radius-full           全圆角（药丸 / 开关）
 *   --hc-surface-material      材质关键字：glass / mica / acrylic / solid
 *   --hc-surface-blur          卡片实际模糊值；实色皮肤为 none
 *   --hc-surface-border-width  描边宽度（立体倒角那档为 2px）
 */
export const TOKENS: Array<[string, string]> = [
  ['--hc-text-primary', '--text-primary'],
  ['--hc-text-secondary', '--text-secondary'],
  ['--hc-text-tertiary', '--text-tertiary'],
  ['--hc-fill-primary', '--fill-primary'],
  ['--hc-fill-secondary', '--fill-secondary'],
  ['--hc-fill-danger', '--fill-danger'],
  ['--hc-fill-success', '--fill-success'],
  ['--hc-glass-bg', '--glass-bg'],
  ['--hc-glass-border', '--glass-border'],
  ['--hc-divider', '--divider'],
  ['--hc-scrim', '--scrim'],
  ['--hc-radius-control', '--radius-control'],
  ['--hc-radius-card', '--radius-card'],
  ['--hc-radius-full', '--radius-full'],
  ['--hc-surface-material', '--surface-material'],
  ['--hc-surface-blur', '--surface-blur'],
  ['--hc-surface-border-width', '--surface-border-width']
]

/** 探针队列溢出（脚本在极短时间内插入海量元素）：按规避检查处理。 */
export const FLOOD_WHERE = 'element-flood'

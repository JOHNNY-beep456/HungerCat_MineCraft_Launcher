// ---------------------------------------------------------------------------
// 自定义主页拆分模块的常量。
// ---------------------------------------------------------------------------

/** 注入 iframe 的设计令牌：宿主变量名 → 暴露给脚本的 --hc-* 变量名。 */
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
  ['--hc-scrim', '--scrim']
]

/** 探针队列溢出（脚本在极短时间内插入海量元素）：按规避检查处理。 */
export const FLOOD_WHERE = 'element-flood'

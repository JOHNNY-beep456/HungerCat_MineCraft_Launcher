// ---------------------------------------------------------------------------
// Mod 管理样式：把「原名 / 译名」映射成「标题 + 详情」。
//
// 与设置项「Mod 管理样式」（图：标题显示译名，详情显示文件名 / 标题显示文件名，
// 详情显示译名）一一对应。集中在一处，保证搜索页、实例管理页、详情弹窗三处口径一致。
//
// 约定：`name` 是**原名**（模组为文件名，搜索结果里为官方标题），
// `translatedName` 是 MC百科 提供的中文译名。
// ---------------------------------------------------------------------------

export type ModTitleStyle = 'translated-first' | 'filename-first'

export interface ModTitlePair {
  /** 主标题。 */
  title: string
  /** 副标题（详情）。无意义时省略，避免重复显示同一串文字。 */
  detail?: string
}

export function modTitlePair(
  name: string,
  translatedName: string | undefined,
  style: ModTitleStyle
): ModTitlePair {
  const original = (name ?? '').trim()
  const zh = (translatedName ?? '').trim()
  // 译名缺失或与原名相同：没有可切换的两面，只显示原名。
  if (!zh || zh === original) return { title: original }

  if (style === 'filename-first') return { title: original, detail: zh }
  // translated-first（标题显示译名，详情显示原名）
  return { title: zh, detail: original }
}

/**
 * 已安装资源（模组 / 资源包 / 光影）的标题与详情。
 *
 * 三个可用字符串的优先级：
 *   1. `translatedName`（MC百科 中文译名）
 *   2. `displayName`（Modrinth/CurseForge 官方标题）
 *   3. `name`（文件名，永远存在）
 *
 * 有译名时严格按「Mod 管理样式」在 **译名 ⇄ 文件名** 之间切换（与图一致）；
 * 没译名时退化为「官方标题 + 文件名」，避免信息量下降。
 */
export function modListTitles(
  o: { name: string; displayName?: string; translatedName?: string },
  style: ModTitleStyle
): ModTitlePair {
  const fileName = (o.name ?? '').trim()
  const zh = (o.translatedName ?? '').trim()
  if (zh && zh !== fileName) {
    return style === 'filename-first' ? { title: fileName, detail: zh } : { title: zh, detail: fileName }
  }
  const official = (o.displayName ?? '').trim()
  const title = official || fileName
  const detail = official && official !== fileName ? fileName : undefined
  return detail ? { title, detail } : { title }
}

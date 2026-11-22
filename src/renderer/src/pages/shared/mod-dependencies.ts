import type { ModrinthProjectDetail, ModrinthType, ModrinthVersion } from '@shared/types'

/** 安装到实例时发现的缺失前置。 */
export interface DepMissing {
  projectId: string
  title: string
  version: ModrinthVersion
}

/** 依赖检查 / 安装共用的目标实例最小形状。 */
export interface DepTarget {
  id: string
  dirId?: string
  mcVersion: string
  loader: string | null
}

/**
 * 找出该版本「必需、但目标实例中尚未安装」的前置模组。
 *
 * 判据（两者任一命中即视为已装，避免重复下载）：
 *   1. 实例中已装模组的 Modrinth slug 与依赖项目 slug 相同（最准，但需已富化）；
 *   2. 依赖版本的主文件名与实例 mods 目录中的文件名相同（兜底）。
 * 读不到实例模组列表时直接返回空数组——宁可放行安装，也不误报「缺前置」阻断用户。
 * 资源包 / 光影没有前置概念，直接跳过。
 */
export async function findMissingDependencies(
  version: ModrinthVersion,
  target: DepTarget,
  type: ModrinthType
): Promise<DepMissing[]> {
  if (type !== 'mod' && type !== 'modpack') return []
  const deps = (version.dependencies ?? []).filter((d) => d.dependency_type === 'required' && d.project_id)
  if (deps.length === 0) return []

  let names = new Set<string>()
  let slugs = new Set<string>()
  try {
    const mods = await window.api.manage.mods(target.id, target.dirId)
    names = new Set(mods.map((m) => m.name.toLowerCase()))
    slugs = new Set(
      mods
        .map((m) => m.slug)
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .map((s) => s.toLowerCase())
    )
  } catch {
    return []
  }

  const missing: DepMissing[] = []
  for (const d of deps) {
    const pid = d.project_id
    if (!pid) continue
    let proj: ModrinthProjectDetail | null = null
    try {
      proj = await window.api.mods.project(pid)
    } catch {
      /* 取不到项目信息时用 id 兜底展示 */
    }
    const slug = proj?.slug?.toLowerCase() ?? ''
    if (slug && slugs.has(slug)) continue

    // 取适配当前实例（MC 版本 + 加载器）的依赖版本。
    let pick: ModrinthVersion | null = null
    try {
      const vs = await window.api.mods.versions(pid, target.loader ? [target.loader] : [], [target.mcVersion])
      pick = vs[0] ?? null
    } catch {
      /* 查询失败：无法判断，跳过该项而不误报 */
    }
    if (!pick) continue
    const f = pick.files.find((x) => x.primary) ?? pick.files[0]
    if (f && names.has(f.filename.toLowerCase())) continue

    missing.push({ projectId: pid, title: proj?.title || pid, version: pick })
  }
  return missing
}

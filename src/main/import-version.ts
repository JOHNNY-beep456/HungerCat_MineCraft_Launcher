// ---------------------------------------------------------------------------
// 从其它 .minecraft 目录导入版本。
//
// 扫描来源目录的 versions/，把选定版本复制到当前版本目录，并增量合并来源的
// libraries/（已存在的文件不覆盖），让导入后的版本尽量开箱即用。
// assets/ 体积过大（常达数百 MB ~ 1GB）不复制，交由启动前的补全下载按需处理。
//
// 重名处理：扫描阶段即标记目标目录中是否已有同名版本；导入时按调用方给定的
// 策略处理（rename 自动加后缀 / overwrite 覆盖 / skip 跳过）。
// ---------------------------------------------------------------------------

import { existsSync, promises as fsp } from 'fs'
import { dirname, join } from 'path'
import type { ConflictPolicy, ExternalVersion } from '@shared/types'

export type { ConflictPolicy, ExternalVersion }

/** 目录大小（递归累加文件体积）；失败按 0 计。 */
async function dirSize(dir: string): Promise<number> {
  let total = 0
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) total += await dirSize(p)
    else {
      try {
        total += (await fsp.stat(p)).size
      } catch {
        /* 忽略单个文件 */
      }
    }
  }
  return total
}

/** 从版本 JSON 尽力解析基础 MC 版本。 */
function mcVersionOf(json: Record<string, unknown>, fallbackId: string): string {
  const libs = Array.isArray(json['libraries']) ? (json['libraries'] as Array<{ name?: string }>) : []
  for (const lib of libs) {
    const name = lib?.name ?? ''
    // Fabric/Quilt 的 intermediary/hashed 与 Forge/NeoForge 的 loader 库都带 MC 版本。
    const m =
      name.match(/^net\.fabricmc:(?:intermediary|hashed):([0-9][0-9a-z.+-]*)$/i) ??
      name.match(/^org\.quiltmc:hashed:([0-9][0-9a-z.+-]*)$/i) ??
      name.match(/^net\.(?:minecraftforge:(?:forge|fmlloader)|neoforged:neoforge):([0-9]+\.[0-9]+(?:\.[0-9]+)?)-/)
    if (m) return m[1]
  }
  const direct = json['clientVersion'] ?? json['inheritsFrom']
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  // 形如 1.20.1-forge-47.4.18 → 1.20.1
  const m = fallbackId.match(/^(\d+\.\d+(?:\.\d+)?)[-_](?:forge|fabric|quilt|neoforge|optifine)/i)
  return m ? m[1] : fallbackId
}

/** 从版本 JSON 判断加载器。 */
function loaderOf(json: Record<string, unknown>, id: string): string | null {
  const libs = (Array.isArray(json['libraries']) ? (json['libraries'] as Array<{ name?: string }>) : [])
    .map((l) => l?.name ?? '')
    .join(' ')
  if (/net\.neoforged/i.test(libs)) return 'neoforge'
  if (/net\.minecraftforge/i.test(libs)) return 'forge'
  if (/net\.fabricmc/i.test(libs)) return 'fabric'
  if (/org\.quiltmc/i.test(libs)) return 'quilt'
  if (/neoforge/i.test(id)) return 'neoforge'
  if (/fabric/i.test(id)) return 'fabric'
  if (/quilt/i.test(id)) return 'quilt'
  if (/forge/i.test(id)) return 'forge'
  return null
}

/**
 * 扫描一个 .minecraft 目录，列出其中可导入的版本。
 * 只把「versions/<id>/<id>.json 存在」的目录视为有效版本（与启动器自身的判据一致）。
 */
export async function scanExternalVersions(mcDir: string, targetGameDir: string): Promise<ExternalVersion[]> {
  const versionsDir = join(mcDir, 'versions')
  let entries
  try {
    entries = await fsp.readdir(versionsDir, { withFileTypes: true })
  } catch {
    throw new Error('该目录下没有 versions 文件夹，可能不是有效的 .minecraft 目录')
  }

  const out: ExternalVersion[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const jsonPath = join(versionsDir, e.name, `${e.name}.json`)
    if (!existsSync(jsonPath)) continue
    let json: Record<string, unknown> = {}
    try {
      json = JSON.parse(await fsp.readFile(jsonPath, 'utf-8')) as Record<string, unknown>
    } catch {
      /* JSON 损坏时仍列出，元信息用目录名兜底 */
    }
    out.push({
      id: e.name,
      mcVersion: mcVersionOf(json, e.name),
      loader: loaderOf(json, e.name),
      size: await dirSize(join(versionsDir, e.name)),
      conflict: existsSync(join(targetGameDir, 'versions', e.name))
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/** 在目标目录里找一个不与现有版本冲突的名字：`id-2`、`id-3`…… */
function uniqueVersionId(targetGameDir: string, base: string): string {
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`
    if (!existsSync(join(targetGameDir, 'versions', candidate))) return candidate
  }
  return `${base}-${Date.now()}`
}

/**
 * 把版本目录内的 `<old>.json` 改名为 `<new>.json`，并同步其中的 id 字段。
 * 版本必须「文件名 = 目录名 = json.id」，三者不一致启动器会认不出来。
 */
async function renameVersionInPlace(dir: string, oldId: string, newId: string): Promise<void> {
  const from = join(dir, `${oldId}.json`)
  const to = join(dir, `${newId}.json`)
  try {
    const json = JSON.parse(await fsp.readFile(from, 'utf-8')) as Record<string, unknown>
    json['id'] = newId
    await fsp.writeFile(to, JSON.stringify(json, null, 2), 'utf-8')
    if (from !== to) await fsp.rm(from, { force: true }).catch(() => {})
  } catch {
    // JSON 不可读时退化为纯改名，至少让文件名与目录名一致。
    await fsp.rename(from, to).catch(() => {})
  }
}

/** 增量合并来源 libraries 到目标（已存在的文件不覆盖，避免破坏现有安装）。 */
async function mergeLibraries(srcRoot: string, destRoot: string): Promise<void> {
  if (!existsSync(srcRoot)) return
  const walk = async (rel: string): Promise<void> => {
    const abs = rel ? join(srcRoot, rel) : srcRoot
    let entries
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const childRel = rel ? join(rel, e.name) : e.name
      if (e.isDirectory()) {
        await walk(childRel)
        continue
      }
      const dest = join(destRoot, childRel)
      if (existsSync(dest)) continue
      try {
        await fsp.mkdir(dirname(dest), { recursive: true })
        await fsp.copyFile(join(srcRoot, childRel), dest)
      } catch {
        /* 单个文件失败不影响整体导入 */
      }
    }
  }
  await walk('')
}

/**
 * 从外部 .minecraft 导入指定版本。
 * @returns 实际落地的版本 id 与执行的动作（imported / renamed / skipped）。
 */
export async function importExternalVersion(
  mcDir: string,
  versionId: string,
  targetGameDir: string,
  onConflict: ConflictPolicy
): Promise<{ id: string; action: 'imported' | 'renamed' | 'skipped' }> {
  const src = join(mcDir, 'versions', versionId)
  if (!existsSync(join(src, `${versionId}.json`))) {
    throw new Error(`来源中找不到版本「${versionId}」`)
  }

  let finalId = versionId
  if (existsSync(join(targetGameDir, 'versions', versionId))) {
    if (onConflict === 'skip') return { id: versionId, action: 'skipped' }
    if (onConflict === 'rename') finalId = uniqueVersionId(targetGameDir, versionId)
    // overwrite：沿用原名，稍后先删除旧目录再复制。
  }

  const dest = join(targetGameDir, 'versions', finalId)
  await fsp.mkdir(dirname(dest), { recursive: true })
  if (existsSync(dest)) await fsp.rm(dest, { recursive: true, force: true })
  await fsp.cp(src, dest, { recursive: true })

  // 改名导入时，必须让目录名 / 文件名 / json.id 三者一致。
  if (finalId !== versionId) await renameVersionInPlace(dest, versionId, finalId)

  // 合并库文件，让导入后的版本尽量开箱即用（已有文件不覆盖）。
  await mergeLibraries(join(mcDir, 'libraries'), join(targetGameDir, 'libraries'))

  return { id: finalId, action: finalId === versionId ? 'imported' : 'renamed' }
}

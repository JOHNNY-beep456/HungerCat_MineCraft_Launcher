import { existsSync, promises as fsp } from 'fs'
import { basename, join } from 'path'
import type { ModEntry, ResourceFile, ResourceKind, SchematicEntry, VersionDirKind } from '@shared/types'
import { listArchive, readArchiveText } from './archive'
import { findProject, findProjectByName } from './modrinth'
import { listResources, rememberResourceMeta } from './resources'
import { withLocalTimeout } from './local-timeout'

function runDir(gameDir: string, versionId: string, isolated: boolean): string {
  return isolated ? join(gameDir, 'versions', versionId) : gameDir
}

export function resolveVersionDir(
  gameDir: string,
  versionId: string,
  isolated: boolean,
  kind: VersionDirKind
): string {
  const run = runDir(gameDir, versionId, isolated)
  switch (kind) {
    case 'mods':
      return join(run, 'mods')
    case 'saves':
      return join(run, 'saves')
    case 'shaderpacks':
      return join(run, 'shaderpacks')
    case 'schematics':
      return join(run, 'schematics')
    case 'version':
      return join(gameDir, 'versions', versionId)
    case 'run':
      return run
  }
}

/* ------------------------------------------------------------------ */
/* 模组元数据识别（JAR 内 fabric.mod.json / quilt.mod.json / mods.toml）  */
/* ------------------------------------------------------------------ */

export interface ModMeta {
  id: string
  name: string
  /** JAR 里声明的模组版本号；是构建占位符（`${file.jarVersion}`）或缺失时为空串。 */
  version: string
}

/**
 * 归一化元数据里的版本号：占位符（`${file.jarVersion}` / `${version}`，Forge 开发构建常见）
 * 不是真实版本号，一律当作「未知」，否则会拿它去比对而误判更新。
 */
function cleanVersion(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  return s && !s.includes('$') && !s.includes('{') ? s : ''
}

async function readModMeta(path: string): Promise<ModMeta | null> {
  let entries: string[]
  try {
    entries = await listArchive(path)
  } catch {
    return null
  }

  // Fabric / Quilt 用 JSON 元数据
  for (const fileName of ['fabric.mod.json', 'quilt.mod.json']) {
    const entry = entries.find((e) => e === fileName || e.endsWith(`/${fileName}`))
    if (!entry) continue
    try {
      const data = JSON.parse((await readArchiveText(path, entry)).replace(/^\uFEFF/, ''))
      const loader = fileName === 'quilt.mod.json' ? data?.quilt_loader : data
      const id = typeof loader?.id === 'string' ? loader.id : ''
      const name =
        typeof loader?.name === 'string'
          ? loader.name
          : typeof loader?.metadata?.name === 'string'
            ? loader.metadata.name
            : ''
      const version = cleanVersion(loader?.version ?? loader?.metadata?.version)
      if (id || name) return { id, name, version }
    } catch {
      /* 继续尝试其它元数据 */
    }
  }

  // Forge / NeoForge 用 TOML 元数据（mods.toml / neoforge.mods.toml）
  const toml = entries.find((e) => /(^|\/)(neoforge\.)?mods\.toml$/i.test(e))
  if (toml) {
    try {
      const raw = await readArchiveText(path, toml)
      const id = raw.match(/modId\s*=\s*"([^"]+)"/)?.[1] ?? ''
      const name = raw.match(/displayName\s*=\s*"([^"]+)"/)?.[1] ?? ''
      const version = cleanVersion(raw.match(/\bversion\s*=\s*"([^"]+)"/)?.[1] ?? '')
      if (id || name) return { id, name, version }
    } catch {
      /* ignore */
    }
  }
  return null
}

export interface LoadedMod {
  mod: ModEntry
  meta: ModMeta | null
}

/** 读取模组文件清单并提取 JAR 元数据（本地 tar，不联网）。 */
export async function loadModFiles(dir: string): Promise<LoadedMod[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  const mods: LoadedMod[] = []
  for (const e of entries) {
    if (!e.isFile()) continue
    const enabled = !e.name.endsWith('.disabled')
    const realName = enabled ? e.name : e.name.slice(0, -'.disabled'.length)
    if (!/\.(jar|zip)$/i.test(realName)) continue
    const path = join(dir, e.name)
    try {
      const st = await fsp.stat(path)
      mods.push({ mod: { name: realName, path, enabled, size: st.size }, meta: null })
    } catch {
      /* ignore */
    }
  }
  return mapLimit(mods, 6, async (l) => ({ ...l, meta: await readModMeta(l.mod.path) }))
}

/** 以受控并发（默认上限）映射处理列表。 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * 快速列出模组：仅用 JAR 元数据名回填 displayName（不联网），
 * 让界面先显示元数据名；Modrinth 名称/图标由 enrichMods 在后台补齐。
 */
export async function listMods(gameDir: string, versionId: string, isolated: boolean): Promise<ModEntry[]> {
  const dir = join(runDir(gameDir, versionId, isolated), 'mods')
  try {
    const loaded = await loadModFiles(dir)
    return loaded
      .map(({ mod, meta }) => (meta?.name ? { ...mod, displayName: meta.name } : mod))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

/** 后台联网查询 Modrinth，逐项回传命中结果（替换名称并补充图标）。 */
export async function enrichMods(
  gameDir: string,
  versionId: string,
  isolated: boolean,
  onUpdate: (m: ModEntry) => void
): Promise<void> {
  const dir = join(runDir(gameDir, versionId, isolated), 'mods')
  let loaded: LoadedMod[]
  try {
    loaded = await loadModFiles(dir)
  } catch {
    return
  }
  await mapLimit(loaded, 6, async ({ mod, meta }) => {
            if (!meta) return
            const project = await findProject(meta.id, meta.name)
            if (project)
              onUpdate({
                ...mod,
                displayName: project.title,
                iconUrl: project.icon_url,
                slug: project.slug,
                description: project.description
              })
          })
}

/* ------------------------------------------------------------------ */
/* 光影 / 资源包元数据识别（包里没有可读元数据，只能靠文件名搜 Modrinth）  */
/* ------------------------------------------------------------------ */

/** 把安装文件名收拾成搜索关键词。 */
export function packSearchName(fileName: string): string {
  return (
    fileName
      // 扩展名
      .replace(/\.(zip|jar|mcpack|mctemplate|fsb|shader|glsl)$/i, '')
      // 括号备注，如 (Chocapic13 Shaders edit) / [1.20]，几乎都不是项目名的一部分
      .replace(/[([{][^)\]}]*[)\]}]+/g, ' ')
      // 驼峰拆词：ComplementaryUnbound → Complementary Unbound（Modrinth 搜 "Complementary Unbound"
      // 才有官方项目，搜连写的 ComplementaryUnbound 只有一条同名小项目）
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      // 其余分隔符
      .replace(/[_\-.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      // 结尾的版本号，可能连着一串：Bliss v2 1 2 / Stay True 1 20 / Sildurs v1 29
      .replace(/(?:\s+[a-z]?\d[\d.]*)+$/i, '')
      .trim()
  )
}

/**
 * 后台联网补齐已安装光影 / 资源包的 Modrinth 名称、图标、简介（逐个推送）。
 *
 * 与模组不同，这些压缩包里没有可读的项目名，只能拿文件名去搜（见 findProjectByName：
 * 它会把关键词逐级放宽，并按词覆盖率 + 下载量挑最像的项目）。搜不到就跳过，
 * 界面继续显示文件名。命中结果会记进缓存，刷新时直接带上且不再重复联网。
 */
export async function enrichResources(
  gameDir: string,
  versionId: string,
  isolated: boolean,
  kind: ResourceKind,
  onUpdate: (file: ResourceFile) => void
): Promise<void> {
  const files = await listResources(gameDir, versionId, isolated, kind)
  // 已经有元数据的是命中过缓存的，不必再查
  const pending = files.filter((f) => !f.displayName)
  const type = kind === 'shaderpacks' ? 'shader' : 'resourcepack'
  await mapLimit(pending, 4, async (file) => {
    const project = await findProjectByName(packSearchName(file.name), type)
    if (!project) return
    const enriched: ResourceFile = {
      ...file,
      displayName: project.title,
      iconUrl: project.icon_url,
      slug: project.slug,
      description: project.description
    }
    rememberResourceMeta(enriched)
    onUpdate(enriched)
  })
}

export async function toggleMod(path: string): Promise<void> {
  if (path.endsWith('.disabled')) {
    await withLocalTimeout(fsp.rename(path, path.slice(0, -'.disabled'.length)), `切换模组启用 ${path}`)
    console.info(`[模组] 已启用 ${basename(path.slice(0, -'.disabled'.length))}`)
  } else {
    await withLocalTimeout(fsp.rename(path, `${path}.disabled`), `停用模组 ${path}`)
    console.info(`[模组] 已停用 ${basename(path)}`)
  }
}

export async function deleteMod(path: string): Promise<void> {
  await withLocalTimeout(fsp.rm(path, { force: true }), `删除模组 ${path}`)
  console.info(`[模组] 已删除 ${basename(path)}`)
}

export async function installLocalMod(
  gameDir: string,
  versionId: string,
  isolated: boolean,
  sourcePath: string
): Promise<string> {
  const modsDir = join(runDir(gameDir, versionId, isolated), 'mods')
  await withLocalTimeout(fsp.mkdir(modsDir, { recursive: true }), `创建模组目录 ${modsDir}`)
  const dest = join(modsDir, basename(sourcePath))
  await withLocalTimeout(fsp.copyFile(sourcePath, dest), `导入本地模组 ${basename(sourcePath)}`)
  console.info(`[模组] 已导入本地模组 ${basename(sourcePath)} -> 版本 ${versionId}`)
  return dest
}

export async function deleteWorld(
  gameDir: string,
  versionId: string,
  isolated: boolean,
  worldName: string
): Promise<void> {
  const savesDir = join(runDir(gameDir, versionId, isolated), 'saves')
  const worldDir = join(savesDir, worldName)
  // Safety: worldName must be a single path segment.
  if (basename(worldName) !== worldName) return
  await fsp.rm(worldDir, { recursive: true, force: true })
  console.info(`[版本] 已删除存档 ${worldName}（版本 ${versionId}）`)
}

export async function listSchematics(gameDir: string, versionId: string, isolated: boolean): Promise<SchematicEntry[]> {
  const dir = join(runDir(gameDir, versionId, isolated), 'schematics')
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    const out: SchematicEntry[] = []
    for (const e of entries) {
      if (!e.isFile() || !/\.(litematic|schem|schematic)$/i.test(e.name)) continue
      const path = join(dir, e.name)
      try {
        const st = await fsp.stat(path)
        out.push({ name: e.name, path, size: st.size })
      } catch {
        /* ignore */
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

export async function deleteFile(path: string): Promise<void> {
  await withLocalTimeout(fsp.rm(path, { force: true }), `删除文件 ${path}`)
  console.info(`[版本] 已删除文件 ${basename(path)}`)
}

export async function deleteVersion(gameDir: string, versionId: string): Promise<void> {
  await fsp.rm(join(gameDir, 'versions', versionId), { recursive: true, force: true })
  await fsp.rm(join(gameDir, 'natives', versionId), { recursive: true, force: true })
  console.info(`[版本] 已删除版本 ${versionId}`)
}

/** 重命名已安装实例：同时更新文件夹名、JSON 内 id 与 natives 目录。 */
export async function renameVersion(gameDir: string, versionId: string, newName: string): Promise<string> {
  const name = newName.trim()
  if (!name) throw new Error('实例名不能为空')
  if (/[\\/:*?"<>|]/.test(name)) throw new Error('实例名包含非法字符')
  if (name === versionId) return versionId

  const srcDir = join(gameDir, 'versions', versionId)
  const dstDir = join(gameDir, 'versions', name)
  if (!existsSync(srcDir)) throw new Error(`版本「${versionId}」不存在`)
  if (existsSync(dstDir)) throw new Error(`版本名「${name}」已存在`)

  // 更新 JSON 内的 id 字段（保留 inheritsFrom / clientVersion 等指向基础版本的信息）
  const srcJson = join(srcDir, `${versionId}.json`)
  if (existsSync(srcJson)) {
    try {
      const json = JSON.parse(await fsp.readFile(srcJson, 'utf-8')) as Record<string, unknown>
      if (json && typeof json === 'object') json.id = name
      await fsp.writeFile(srcJson, JSON.stringify(json, null, 2), 'utf-8')
    } catch {
      /* 读取 / 写入失败则保持原样，仍继续重命名目录 */
    }
  }

  await fsp.rename(srcDir, dstDir)

  const oldJson = join(dstDir, `${versionId}.json`)
  if (existsSync(oldJson)) {
    await fsp.rename(oldJson, join(dstDir, `${name}.json`))
  }
  const oldJar = join(dstDir, `${versionId}.jar`)
  if (existsSync(oldJar)) {
    await fsp.rename(oldJar, join(dstDir, `${name}.jar`))
  }

  const srcNatives = join(gameDir, 'natives', versionId)
  if (existsSync(srcNatives)) {
    await fsp.rename(srcNatives, join(gameDir, 'natives', name))
  }

  console.info(`[版本] 已将版本 ${versionId} 重命名为 ${name}`)
  return name
}

export async function openVersionDir(
  gameDir: string,
  versionId: string,
  isolated: boolean,
  kind: VersionDirKind
): Promise<string> {
  const dir = resolveVersionDir(gameDir, versionId, isolated, kind)
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

export function isVersionInstalled(gameDir: string, versionId: string): boolean {
  return existsSync(join(gameDir, 'versions', versionId, `${versionId}.json`))
}

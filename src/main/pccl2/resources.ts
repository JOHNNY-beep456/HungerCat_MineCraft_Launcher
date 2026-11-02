/** PCCL2 native resource installation orchestration.
 *
 * The native host supplies identifiers only. Project metadata and the version
 * file are resolved here so the host cannot make the launcher download an
 * arbitrary URL or place a resource in an arbitrary directory.
 */
import type { ModrinthType, ModrinthVersion } from '@shared/types'
import { activeGameDir, settings } from '../store'
import { listInstalled } from '../installed'
import { installMod } from '../modrinth'
import { resolveProjectDetail, resolveVersionsFor } from '../sources'
import type { IpcContext } from '../handlers/context'
import { cfFileById, cfProject } from '../curseforge'
import { defaultCurseforgeKey } from '../curseforge-key'
import { listResources } from '../resources'

export interface NativeResourceInstallParams {
  projectId: unknown
  versionId?: unknown
  resourceVersionId?: unknown
  instanceId: unknown
  type?: unknown
}

export interface NativeResourceProgress {
  phase: 'download' | 'done'
  received: number
  total: number
  percent: number
  taskId: string
}

export type NativeResourceEmit = (progress: NativeResourceProgress) => void

const RESOURCE_TYPES = new Set<ModrinthType>(['mod', 'resourcepack', 'shader'])
const ID = /^[A-Za-z0-9_.:+-]+$/

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new Error(`invalid ${name}`)
  const result = value.trim()
  if (!ID.test(result)) throw new Error(`invalid ${name}`)
  return result
}

function requestedType(value: unknown): ModrinthType | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !RESOURCE_TYPES.has(value as ModrinthType)) {
    throw new Error('invalid resource type; expected mod, resourcepack, or shader')
  }
  return value as ModrinthType
}

function metadataType(value: unknown): ModrinthType | undefined {
  if (typeof value !== 'string') return undefined
  return RESOURCE_TYPES.has(value as ModrinthType) ? (value as ModrinthType) : undefined
}

function compatible(version: ModrinthVersion, mcVersion: string, loader: string | null, type: ModrinthType): boolean {
  if (!version.game_versions.includes(mcVersion)) return false
  // Resource packs and shaders have no loader dimension. Mods must match the
  // installed loader; a null loader cannot safely receive a mod.
  if (type === 'mod') return !!loader && version.loaders.some((x) => x.toLowerCase() === loader.toLowerCase())
  return true
}

/**
 * Install a server-resolved project version into an installed instance.
 * `emit` is deliberately transport-agnostic so bridge.ts can forward events.
 */
export async function nativeInstallResource(
  ctx: IpcContext,
  params: NativeResourceInstallParams,
  emit: NativeResourceEmit
): Promise<unknown> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('invalid params')
  const projectId = requiredString(params.projectId, 'projectId')
  const versionId = requiredString(params.versionId ?? params.resourceVersionId, 'versionId')
  const instanceId = requiredString(params.instanceId, 'instanceId')
  const explicitType = requestedType(params.type)
  const s = settings.get()
  const gameDir = activeGameDir(s)
  const installed = await listInstalled(gameDir, s.versionIsolation, s.isolatedVersions)
  const instance = installed.find((entry) => entry.id === instanceId)
  if (!instance) throw new Error(`installed instance does not exist: ${instanceId}`)

  // The project detail is the authority for source and project type. Never
  // pass a source chosen by the native client into the version lookup.
  const project = (await resolveProjectDetail(projectId, explicitType ?? 'mod')) as {
    slug?: unknown
    source?: unknown
    project_type?: unknown
    downloadable?: unknown
  } | null
  if (!project || typeof project.slug !== 'string' || !project.slug.trim()) throw new Error('project was not resolved by the configured resource servers')
  const source = project.source === 'curseforge' ? 'curseforge' : project.source === 'modrinth' ? 'modrinth' : undefined
  // CurseForge DTO 会沿用调用方的 type，真正的资源分类以项目 classId 为准。
  const cfProjectData = source === 'curseforge' ? await cfProject(defaultCurseforgeKey(), projectId) : undefined
  const cfModId = cfProjectData?.id
  const cfClassId = cfProjectData?.classId
  const cfClass = cfClassId === 12 ? 'resourcepack' : cfClassId === 6552 ? 'shader' : cfClassId === 6 ? 'mod' : undefined
  if (explicitType && cfClass && explicitType !== cfClass) throw new Error('resource type does not match CurseForge project classId')
  const type = cfClass ?? explicitType ?? metadataType(project.project_type)
  if (!type) throw new Error('resource type is missing or unsupported in project metadata')
  if (cfProjectData?.allowModDistribution === false) throw new Error('CurseForge author does not allow third-party distribution')
  if (project.downloadable === false) throw new Error('resource server does not permit launcher download for this project')

  const versions = await resolveVersionsFor(project.slug, source, type, instance.loader ? [instance.loader] : [], [instance.mcVersion])
  const version = versions.find((candidate) => candidate.id === versionId)
  if (!version) throw new Error('version was not found in server-resolved project metadata')
  if (type === 'mod' && source === 'curseforge' && instance.loader === null) throw new Error('a mod cannot be installed into a vanilla instance')
  if (type === 'mod' && source === 'curseforge' && instance.loader) {
    // CurseForge 仅部分文件标记 Fabric；不能因漏标而错误拒绝可用模组。
    if (!version.game_versions.includes(instance.mcVersion)) throw new Error(`resource version is incompatible with ${instance.mcVersion}`)
    if (version.loaders.length > 0 && !version.loaders.some((x) => x.toLowerCase() === instance.loader!.toLowerCase())) {
      throw new Error(`resource version does not declare the instance loader: ${instance.loader}`)
    }
  } else if (!compatible(version, instance.mcVersion, instance.loader, type)) {
    throw new Error(`resource version is incompatible with instance ${instanceId} (${instance.mcVersion}/${instance.loader ?? 'vanilla'})`)
  }
  const file = version.files.find((candidate) => candidate.primary) ?? version.files[0]
  if (!file || !file.url || !file.filename) throw new Error('selected resource version has no downloadable file')

  const required = (version.dependencies ?? []).filter((dependency) => dependency.dependency_type === 'required' && dependency.project_id)
  if (source === 'curseforge' && /^\d+$/.test(version.id)) {
    const raw = await cfFileById(defaultCurseforgeKey(), Number(cfModId ?? project.slug), Number(version.id))
    required.splice(0, required.length, ...(raw?.dependencies ?? []).filter((d) => d.relationType === 3).map((d) => ({ project_id: String(d.modId), version_id: null, file_name: null, dependency_type: 'required' as const })))
  }
  if (required.length > 0) {
    const ids = required.map((dependency) => dependency.project_id).join(', ')
    throw new Error(`required dependencies need host-assisted installation; refusing to omit: ${ids}`)
  }

  const taskId = `resource:${instanceId}:${version.id}`
  if (ctx.downloadAborts.has(taskId)) throw new Error('resource install already running')
  const controller = new AbortController()
  ctx.downloadAborts.set(taskId, controller)
  try {
    const destination = await installMod(
      file.url,
      file.filename,
      gameDir,
      instanceId,
      ctx.isIsolated(instanceId),
      type,
      (received, total) => emit({ taskId, phase: 'download', received, total, percent: total > 0 ? Math.round((received / total) * 100) : 0 }),
      controller.signal,
      file.size
    )
    // Refresh the resource enumeration and invalidate the installed-version
    // cache used by native state projections. listResources also exercises the
    // resource metadata cache path after a successful write.
    if (type === 'resourcepack') await listResources(gameDir, instanceId, ctx.isIsolated(instanceId), 'resourcepacks')
    if (type === 'shader') await listResources(gameDir, instanceId, ctx.isIsolated(instanceId), 'shaderpacks')
    ctx.installedCache.invalidateAll()
    emit({ taskId, phase: 'done', received: file.size, total: file.size, percent: 100 })
    return { ok: true, destination, projectId, versionId: version.id, instanceId, type }
  } finally {
    ctx.downloadAborts.delete(taskId)
  }
}

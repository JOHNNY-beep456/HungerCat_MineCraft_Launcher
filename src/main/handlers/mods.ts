// 资源域 IPC：Modrinth 搜索 / 安装、整合包导入导出、资源包与光影、实例文件管理。
import { ipcMain } from 'electron'
import type {
  ModrinthType,
  ModpackExportOptions,
  ModSource,
  ResourceKind,
  ResourceUpdateInfo,
  SourceFilter,
  VersionDirKind
} from '@shared/types'
import { settings, activeGameDir } from '../store'
import { listInstalled } from '../installed'
import { installMod, downloadTo, findFabricApi, installOfflineTranslate } from '../modrinth'
import { resolveProjectDetail, resolveVersionsFor, searchResources } from '../sources'
import { listResources, removeResource, openResourceDir } from '../resources'
import { applyResourceUpdate, checkResourceUpdates } from '../resource-updates'
import {
  probeModpack,
  importModpack,
  importModpackFromUrl,
  exportModpack,
  collectExportInventory,
  downloadModpack
} from '../modpack'
import {
  enrichMods,
  enrichResources,
  listMods,
  toggleMod,
  deleteMod,
  installLocalMod,
  installLocalResource,
  deleteWorld,
  listSchematics,
  deleteFile,
  deleteVersion,
  renameVersion,
  openVersionDir
} from '../manage'
import type { IpcContext } from './context'

export function registerModsHandlers(ctx: IpcContext): void {
  // ---- Mods & resources (Modrinth) ----
  // ---- Mods & resources（Modrinth 优先，未命中回落 CurseForge）----
  ipcMain.handle(
    'mods:search',
    (
      _e,
      query: string,
      type?: ModrinthType,
      category?: string,
      gameVersion?: string,
      loader?: string,
      offset?: number,
      source?: SourceFilter
    ) => searchResources({ source: source ?? 'all', query, limit: 24, type: type ?? 'mod', category, gameVersion, loader, offset: offset ?? 0 })
  )
  ipcMain.handle(
    'mods:versions',
    (_e, slug: string, loaders: string[], gameVersions: string[], source?: ModSource, type?: ModrinthType) =>
      resolveVersionsFor(slug, source, type ?? 'mod', loaders, gameVersions)
  )
  // 「完整介绍」弹窗：拉取单个项目的完整信息（含 Markdown 正文 body；CurseForge 无正文）。
  ipcMain.handle('mods:project', (_e, id: string, type?: ModrinthType) =>
    resolveProjectDetail(id, type ?? 'mod')
  )
  ipcMain.handle(
    'mods:install',
    async (event, fileUrl: string, filename: string, versionId: string, type?: ModrinthType, sizeHint?: number, dirId?: string) => {
      const s = settings.get()
      const controller = new AbortController()
      ctx.downloadAborts.set(filename, controller)
      const emit = (received: number, total: number): void =>
        ctx.sendToSender(event.sender, 'download:progress', {
          taskId: filename,
          task: filename,
          current: 0,
          total: 1,
          currentBytes: received,
          totalBytes: total,
          phase: 'mod',
          percent: total > 0 ? Math.round((received / total) * 100) : 0
        })
      try {
        const dest = await installMod(
          fileUrl,
          filename,
          ctx.dirPathById(s, dirId),
          versionId,
          ctx.isIsolated(versionId),
          type,
          emit,
          controller.signal,
          sizeHint
        )
        ctx.sendToSender(event.sender, 'download:progress', {
          taskId: filename,
          task: filename,
          current: 1,
          total: 1,
          currentBytes: 0,
          totalBytes: 0,
          phase: 'done',
          percent: 100
        })
        return dest
      } finally {
        ctx.downloadAborts.delete(filename)
      }
    }
  )
  ipcMain.handle('mods:installFabricApi', async (event, mcVersion: string, versionId: string) => {
    const apiVersion = await findFabricApi(mcVersion)
    if (!apiVersion) throw new Error(`未在 Modrinth 找到适配 ${mcVersion} 的 Fabric API`)
    const file = apiVersion.files.find((f) => f.primary) ?? apiVersion.files[0]
    if (!file) throw new Error('Fabric API 版本缺少可下载文件')

    const s = settings.get()
    const controller = new AbortController()
    ctx.downloadAborts.set(file.filename, controller)
    const emit = (received: number, total: number): void =>
      ctx.sendToSender(event.sender, 'download:progress', {
        taskId: file.filename,
        task: file.filename,
        current: 0,
        total: 1,
        currentBytes: received,
        totalBytes: total,
        phase: 'mod',
        percent: total > 0 ? Math.round((received / total) * 100) : 0
      })
    try {
      const dest = await installMod(file.url, file.filename, activeGameDir(s), versionId, ctx.isIsolated(versionId), 'mod', emit, controller.signal)
      ctx.sendToSender(event.sender, 'download:progress', {
        taskId: file.filename,
        task: file.filename,
        current: 1,
        total: 1,
        currentBytes: 0,
        totalBytes: 0,
        phase: 'done',
        percent: 100
      })
      return dest
    } finally {
      ctx.downloadAborts.delete(file.filename)
    }
  })
  // 游戏内离线翻译模组：固定直链下载到实例 mods 目录（仅 Fabric + 指定 MC 版本区间提供）。
  ipcMain.handle('mods:installOfflineTranslate', async (event, versionId: string) => {
    const filename = 'MCAutoTranslationTool-1.3.11-fabric-all.jar'
    const s = settings.get()
    const controller = new AbortController()
    ctx.downloadAborts.set(filename, controller)
    const emit = (received: number, total: number): void =>
      ctx.sendToSender(event.sender, 'download:progress', {
        taskId: filename,
        task: filename,
        current: 0,
        total: 1,
        currentBytes: received,
        totalBytes: total,
        phase: 'mod',
        percent: total > 0 ? Math.round((received / total) * 100) : 0
      })
    try {
      const dest = await installOfflineTranslate(
        activeGameDir(s),
        versionId,
        ctx.isIsolated(versionId),
        emit,
        controller.signal
      )
      ctx.sendToSender(event.sender, 'download:progress', {
        taskId: filename,
        task: filename,
        current: 1,
        total: 1,
        currentBytes: 0,
        totalBytes: 0,
        phase: 'done',
        percent: 100
      })
      return dest
    } finally {
      ctx.downloadAborts.delete(filename)
    }
  })
  ipcMain.handle('mods:downloadTo', async (event, fileUrl: string, destPath: string, sizeHint?: number) => {
    const filename = destPath.split(/[\\/]/).pop() ?? destPath
    const controller = new AbortController()
    ctx.downloadAborts.set(filename, controller)
    const emit = (received: number, total: number): void =>
      ctx.sendToSender(event.sender, 'download:progress', {
        taskId: filename,
        task: filename,
        current: 0,
        total: 1,
        currentBytes: received,
        totalBytes: total,
        phase: 'mod',
        percent: total > 0 ? Math.round((received / total) * 100) : 0
      })
    try {
      const dest = await downloadTo(fileUrl, destPath, emit, controller.signal, sizeHint)
      ctx.sendToSender(event.sender, 'download:progress', {
        taskId: filename,
        task: filename,
        current: 1,
        total: 1,
        currentBytes: 0,
        totalBytes: 0,
        phase: 'done',
        percent: 100
      })
      return dest
    } finally {
      ctx.downloadAborts.delete(filename)
    }
  })

  // ---- Modpack import / export ----
  ipcMain.handle('modpack:probe', (_e, filePath: string) => probeModpack(filePath))
  ipcMain.handle('modpack:download', async (event, url: string, filename: string) => {
    const controller = new AbortController()
    ctx.downloadAborts.set(filename, controller)
    try {
      return await downloadModpack(url, filename, (p) => {
        ctx.sendToSender(event.sender, 'modpack:progress', p)
        ctx.sendToSender(event.sender, 'download:progress', p)
      }, controller.signal)
    } finally {
      ctx.downloadAborts.delete(filename)
    }
  })
  ipcMain.handle('modpack:import', async (event, filePath: string, customName?: string, dirId?: string) => {
    const s = settings.get()
    const dir = ctx.dirPathById(s, dirId)
    const controller = new AbortController()
    const key = `modpack-import:${filePath}`
    ctx.downloadAborts.set(key, controller)
    try {
      const id = await importModpack(filePath, dir, customName ?? '', (p) => {
        ctx.sendToSender(event.sender, 'modpack:progress', p)
        ctx.sendToSender(event.sender, 'download:progress', p)
      }, (line) => {
        ctx.sendToSender(event.sender, 'forge:log', line)
      }, controller.signal)
      ctx.installedCache.invalidateAll()
      return { versionId: id, name: id }
    } finally {
      ctx.downloadAborts.delete(key)
    }
  })
  ipcMain.handle('modpack:importFromUrl', async (event, url: string, filename: string, customName?: string, dirId?: string) => {
    const s = settings.get()
    const dir = ctx.dirPathById(s, dirId)
    const controller = new AbortController()
    ctx.downloadAborts.set(filename, controller)
    try {
      const id = await importModpackFromUrl(url, filename, dir, customName ?? '', (p) => {
        ctx.sendToSender(event.sender, 'modpack:progress', p)
        ctx.sendToSender(event.sender, 'download:progress', p)
      }, (line) => {
        ctx.sendToSender(event.sender, 'forge:log', line)
      }, controller.signal)
      ctx.installedCache.invalidateAll()
      return { versionId: id, name: id }
    } finally {
      ctx.downloadAborts.delete(filename)
    }
  })
  ipcMain.handle('modpack:exportInventory', (_event, versionId: string) => {
    const s = settings.get()
    return collectExportInventory(activeGameDir(s), versionId, ctx.isIsolated(versionId))
  })
  ipcMain.handle('modpack:export', async (event, versionId: string, options: ModpackExportOptions) => {
    const s = settings.get()
    return exportModpack(versionId, activeGameDir(s), options, (p) => {
      ctx.sendToSender(event.sender, 'modpack:progress', p)
      ctx.sendToSender(event.sender, 'download:progress', p)
    })
  })

  // ---- Resource packs / shaders ----
  ipcMain.handle('resources:list', async (event, versionId: string, kind: ResourceKind) => {
    const s = settings.get()
    const dir = activeGameDir(s)
    const isolated = ctx.isIsolated(versionId)
    const files = await listResources(dir, versionId, isolated, kind)
    // 先返回本地列表，随后后台联网补齐 Modrinth 名称 / 图标并逐个推送。
    // 与 manage:mods 保持一致：「仅获取元数据」与本地模式下完全不联网，只显示本地文件名。
    if (s.mode !== 'local' && !s.metadataOnlyMods) {
      void enrichResources(dir, versionId, isolated, kind, (file) => {
        ctx.sendToSender(event.sender, 'resources:updated', { versionId, kind, file })
      })
    }
    return files
  })
  ipcMain.handle('resources:remove', (_e, path: string) => removeResource(path))
  ipcMain.handle('resources:open', (_e, versionId: string, kind: ResourceKind) => {
    const s = settings.get()
    return openResourceDir(activeGameDir(s), versionId, ctx.isIsolated(versionId), kind)
  })
  // 资源更新检测：进入实例管理时调用。联网关闭（本地模式 / 仅识别元数据）时直接返回空。
  // 返回「已确认可更新」的完整清单，其余项在后台判定完后经 resources:update-checked 逐个推送。
  ipcMain.handle('resources:checkUpdates', async (event, versionId: string) => {
    const s = settings.get()
    if (s.mode === 'local' || s.metadataOnlyMods) return []
    const gameDir = activeGameDir(s)
    // 实例的 MC 版本 / 加载器决定「哪些版本算兼容」，取自已安装列表（带缓存的目录扫描）。
    const installed = await ctx.installedCache.get(ctx.installedCacheKey(s), () =>
      listInstalled(gameDir, s.versionIsolation, s.isolatedVersions)
    )
    const entry = installed.find((v) => v.id === versionId)
    return checkResourceUpdates(
      gameDir,
      versionId,
      ctx.isIsolated(versionId),
      entry?.mcVersion ?? '',
      entry?.loader ?? null,
      {
        onResult: (path, kind, update) =>
          ctx.sendToSender(event.sender, 'resources:update-checked', { versionId, path, kind, update })
      }
    )
  })
  ipcMain.handle(
    'resources:applyUpdate',
    (_e, versionId: string, update: ResourceUpdateInfo, enabled: boolean) => {
      const s = settings.get()
      return applyResourceUpdate(activeGameDir(s), versionId, ctx.isIsolated(versionId), update, enabled)
    }
  )

  // ---- Version management (mods / worlds / schematics / delete) ----
  ipcMain.handle('manage:mods', async (event, versionId: string, dirId?: string) => {
    const s = settings.get()
    const dir = ctx.dirPathById(s, dirId)
    const isolated = ctx.isIsolated(versionId)
    const mods = await listMods(dir, versionId, isolated)
    // 先返回元数据名列表，随后后台联网补齐 Modrinth 名称/图标并逐个推送
    if (s.mode !== 'local' && !s.metadataOnlyMods) {
      void enrichMods(dir, versionId, isolated, (mod) => {
        ctx.sendToSender(event.sender, 'manage:mods-updated', { versionId, mod })
      })
    }
    return mods
  })
  ipcMain.handle('manage:toggleMod', (_e, path: string) => toggleMod(path))
  ipcMain.handle('manage:deleteMod', (_e, path: string) => deleteMod(path))
  ipcMain.handle('manage:installLocalMod', (_e, versionId: string, sourcePath: string) => {
    const s = settings.get()
    return installLocalMod(activeGameDir(s), versionId, ctx.isIsolated(versionId), sourcePath)
  })
  // 资源包 / 光影的本地导入：与模组同一套编排，仅目标目录不同。
  ipcMain.handle(
    'manage:installLocalResource',
    (_e, versionId: string, kind: 'mods' | 'resourcepacks' | 'shaderpacks', sourcePath: string) => {
      const s = settings.get()
      return installLocalResource(activeGameDir(s), versionId, ctx.isIsolated(versionId), kind, sourcePath)
    }
  )
  ipcMain.handle('manage:deleteWorld', (_e, versionId: string, worldName: string) => {
    const s = settings.get()
    return deleteWorld(activeGameDir(s), versionId, ctx.isIsolated(versionId), worldName)
  })
  ipcMain.handle('manage:schematics', (_e, versionId: string) => {
    const s = settings.get()
    return listSchematics(activeGameDir(s), versionId, ctx.isIsolated(versionId))
  })
  ipcMain.handle('manage:deleteFile', (_e, path: string) => deleteFile(path))
  ipcMain.handle('manage:deleteVersion', async (_e, versionId: string) => {
    const s = settings.get()
    await deleteVersion(activeGameDir(s), versionId)
    ctx.installedCache.invalidateAll()
    return true
  })
  ipcMain.handle('manage:renameVersion', async (_e, versionId: string, newName: string) => {
    const s = settings.get()
    const newId = await renameVersion(activeGameDir(s), versionId, newName)
    ctx.installedCache.invalidateAll()
    // 同步更新设置中对旧实例 id 的引用（隔离 / 禁用标记）
    if (newId !== versionId) {
      const needsUpdate =
        s.isolatedVersions.includes(versionId) || s.disabledVersions.includes(versionId)
      if (needsUpdate) {
        settings.set({
          isolatedVersions: s.isolatedVersions.map((id) => (id === versionId ? newId : id)),
          disabledVersions: s.disabledVersions.map((id) => (id === versionId ? newId : id))
        })
      }
    }
    return newId
  })
  ipcMain.handle('manage:openDir', async (_e, versionId: string, kind: VersionDirKind) => {
    const s = settings.get()
    // 只返回目录路径：由渲染层用启动器自实现的资源管理器打开（不再唤起系统资源管理器）
    return await openVersionDir(activeGameDir(s), versionId, ctx.isIsolated(versionId), kind)
  })
}

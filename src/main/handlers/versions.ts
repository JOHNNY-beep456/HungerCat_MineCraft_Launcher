// 版本域 IPC：版本清单 / 实例列表 / 版本目录 / 加载器（Fabric、Forge）/ 下载安装。
import { ipcMain } from 'electron'
import type { ConflictPolicy, ForgeKind, LoaderKind } from '@shared/types'
import { settings, activeGameDir, allVersionDirs } from '../store'
import { fetchVersionManifest, resolveVersionJson, createVanillaInstance } from '../versions'
import { addVersionServer, listInstalled } from '../installed'
import { scanExternalVersions, importExternalVersion } from '../import-version'
import { installVersion } from '../downloader'
import { effectiveConcurrency } from '../network-profile'
import { nativeDownloaderStatus } from '../native-downloader'
import { loaderVersions, installLoader } from '../loaders'
import { forgeVersions, installForge } from '../forge'
import { pickInstallerJava, requiredJavaForMc } from '../java'
import type { IpcContext } from './context'

export function registerVersionsHandlers(ctx: IpcContext): void {
  // ---- Versions ----
  ipcMain.handle('versions:list', () =>
    // 缓存 key 带上「版本列表源」：来源现在由用户可选，切换来源后必须重新拉取，
    // 否则会一直返回旧来源的清单（表现为「改了来源没生效」）。
    ctx.versionsCache.get(`manifest:${settings.get().versionListSource}`, () => fetchVersionManifest())
  )
  ipcMain.handle('versions:get', (_e, id: string) => {
    const s = settings.get()
    return resolveVersionJson(id, activeGameDir(s))
  })
  ipcMain.handle('versions:createVanilla', async (_e, baseVersion: string, customName: string, dirId?: string) => {
    await createVanillaInstance(ctx.dirPathById(settings.get(), dirId), baseVersion, customName)
    ctx.installedCache.invalidateAll()
  })
  // 从其它 .minecraft 导入版本：先扫描列出（标注重名），再按策略导入。
  ipcMain.handle('versions:scanExternal', (_e, mcDir: string) =>
    scanExternalVersions(mcDir, activeGameDir(settings.get()))
  )
  ipcMain.handle(
    'versions:importExternal',
    async (_e, mcDir: string, versionId: string, onConflict: ConflictPolicy) => {
      const r = await importExternalVersion(mcDir, versionId, activeGameDir(settings.get()), onConflict)
      ctx.installedCache.invalidateAll()
      return r
    }
  )

  // ---- Installed versions / worlds / servers ----
  ipcMain.handle('installed:list', () => {
    const s = settings.get()
    return ctx.installedCache.get(ctx.installedCacheKey(s), () =>
      listInstalled(activeGameDir(s), s.versionIsolation, s.isolatedVersions)
    )
  })

  // 跨「所有已添加版本目录」的实例列表（每项带 dirId）：资源下载据此匹配所有目录里的实例。
  ipcMain.handle('installed:listAll', async () => {
    const s = settings.get()
    const perDir = await Promise.all(
      allVersionDirs(s).map(async (d) => {
        const list = await listInstalled(d.path, s.versionIsolation, s.isolatedVersions)
        return list.map((v) => ({ ...v, dirId: d.id }))
      })
    )
    return perDir.flat()
  })

  // 为某个实例的 servers.dat 追加一条服务器（名称 + 地址）。
  ipcMain.handle('installed:addServer', async (_e, versionId: string, name: string, address: string) => {
    const s = settings.get()
    const id = (versionId ?? '').trim()
    const addr = (address ?? '').trim()
    if (!id || !addr) throw new Error('缺少实例或服务器地址')
    const list = await addVersionServer(activeGameDir(s), id, ctx.isIsolated(id), name ?? '', addr)
    ctx.installedCache.invalidateAll()
    return list
  })

  // ---- 版本目录（多版本列表根目录） ----
  //
  // 注意：这四个处理器都不再调 installedCache.invalidateAll()。
  // installedCacheKey 里已经含「当前生效目录 + 隔离策略」，切换 / 增删 / 改目录本身就会落到
  // 另一个 key——失效缓存并不会让新目录更快出结果，反而会把「刚扫过的另一个目录」也一并清掉，
  // 用户来回切目录时每次都要重新全量扫描。这才是「切换版本目录很卡」的直接原因之一。
  ipcMain.handle('versionDirs:list', () => allVersionDirs(settings.get()))
  ipcMain.handle('versionDirs:add', (_e, input: { path: string; alias?: string }) => {
    const s = settings.get()
    const path = (input?.path ?? '').trim()
    if (!path) return allVersionDirs(s)
    if (path === s.gameDir || s.versionDirs.some((d) => d.path === path)) return allVersionDirs(s)
    const id = `dir-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    settings.set({
      versionDirs: [...s.versionDirs, { id, alias: (input.alias ?? '').trim(), path }]
    })
    return allVersionDirs(settings.get())
  })
  ipcMain.handle('versionDirs:update', (_e, id: string, patch: { alias?: string; path?: string }) => {
    const s = settings.get()
    if (id === 'default') {
      // 默认目录只允许改别名（其路径即设置页的 gameDir），此处不改路径。
      return allVersionDirs(s)
    }
    settings.set({
      versionDirs: s.versionDirs.map((d) =>
        d.id === id
          ? {
              ...d,
              alias: patch.alias !== undefined ? patch.alias.trim() : d.alias,
              path: patch.path && patch.path.trim() ? patch.path.trim() : d.path
            }
          : d
      )
    })
    return allVersionDirs(settings.get())
  })
  ipcMain.handle('versionDirs:remove', (_e, id: string) => {
    if (id === 'default') return allVersionDirs(settings.get())
    const s = settings.get()
    settings.set({
      versionDirs: s.versionDirs.filter((d) => d.id !== id),
      selectedVersionDirId: s.selectedVersionDirId === id ? '' : s.selectedVersionDirId
    })
    return allVersionDirs(settings.get())
  })
  ipcMain.handle('versionDirs:select', (_e, id: string) => {
    const s = settings.get()
    const valid = id === 'default' || s.versionDirs.some((d) => d.id === id)
    const next = valid ? (id === 'default' ? '' : id) : ''
    settings.set({ selectedVersionDirId: next })
    return next || 'default'
  })

  // ---- Mod loaders (Fabric / Quilt) ----
  ipcMain.handle('loaders:versions', (_e, kind: LoaderKind, mc: string) => loaderVersions(kind, mc))
  ipcMain.handle('loaders:install', async (_e, kind: LoaderKind, mc: string, loader: string, customId?: string, dirId?: string) => {
    const id = await installLoader(kind, mc, loader, ctx.dirPathById(settings.get(), dirId), customId)
    ctx.installedCache.invalidateAll()
    return id
  })

  // ---- Mod loaders (Forge / NeoForge) ----
  ipcMain.handle('forge:versions', (_e, kind: ForgeKind, mc: string) => forgeVersions(kind, mc))
  ipcMain.handle('forge:install', async (event, kind: ForgeKind, mc: string, version: string, customId?: string, waitForVersion?: string, dirId?: string) => {
    const s = settings.get()
    const dir = ctx.dirPathById(s, dirId)
    const jr = await pickInstallerJava(allVersionDirs(s).map((d) => d.path), s.javaPath, requiredJavaForMc(mc))
    if (!jr) throw new Error('未找到可用的 Java，无法运行安装器（请在「设置」中指定 Java 路径）')
    // 安装器 jar 的下载可与原版下载并发；但运行安装器必须等原版下载完成。
    // 调用方（渲染层）先发起 download:install(mc)，这里取它的 Promise 作为 beforeRun。
    const beforeRun = waitForVersion ? ctx.activeInstalls.get(ctx.installKey(waitForVersion, dirId)) : undefined
    if (waitForVersion && !beforeRun) {
      console.warn(`[下载] forge:install 未找到 ${waitForVersion} 的进行中安装，将直接运行安装器`)
    }
    // 安装器下载的 Java 包同样纳入并发下载管理：登记独立控制器，进度带 taskId，
    // 这样多个下载并行时互不覆盖，也能被「进度」页单独取消。
    const taskId = customId || `${kind}-${mc}-${version}`
    const controller = new AbortController()
    ctx.downloadAborts.set(taskId, controller)
    try {
      const id = await installForge(kind, mc, version, dir, jr.path, (line) => {
        ctx.sendToSender(event.sender, 'forge:log', line)
      }, customId, (p) => {
        ctx.sendToSender(event.sender, 'download:progress', { ...p, taskId })
      }, controller.signal, beforeRun)
      ctx.installedCache.invalidateAll()
      return id
    } finally {
      ctx.downloadAborts.delete(taskId)
    }
  })

  // ---- Download / install ----
  ipcMain.handle('download:install', async (event, id: string, dirId?: string) => {
    const s = settings.get()
    const dir = ctx.dirPathById(s, dirId)
    // 用 IIFE 先把安装 Promise 同步登记进 activeInstalls，再 await —— 这样随后发起的
    // Forge 安装器（forge:install 传 waitForVersion）能立刻拿到「原版下载完成」的等待对象。
    const job = (async () => {
      const json = await resolveVersionJson(id, dir)
      const controller = new AbortController()
      ctx.downloadAborts.set(id, controller)
      try {
        // 按「下载加速档位」换算实际并发：无线网络下自动收敛连接数，避免拥塞反而更慢。
        const eff = effectiveConcurrency(s.downloadAcceleration, s.downloadConnections, s.maxDownloadConcurrency)
        await installVersion(json, dir, eff.fileConcurrency, (p) => {
          ctx.sendToSender(event.sender, 'download:progress', { ...p, taskId: id })
        }, controller.signal, eff.connections)
      } finally {
        ctx.downloadAborts.delete(id)
      }
      ctx.installedCache.invalidateAll()
      return { versionId: json.id, assetIndex: json.assetIndex.id }
    })()
    const key = ctx.installKey(id, dirId)
    ctx.activeInstalls.set(key, job)
    try {
      return await job
    } finally {
      if (ctx.activeInstalls.get(key) === job) ctx.activeInstalls.delete(key)
    }
  })
  // 取消下载：传 taskId 只取消该任务；不传则全部取消。
  ipcMain.handle('download:cancel', (_e, taskId?: string) => {
    if (taskId) {
      ctx.downloadAborts.get(taskId)?.abort()
      return true
    }
    for (const c of ctx.downloadAborts.values()) c.abort()
    ctx.downloadAborts.clear()
    return true
  })
  // 当前实际使用的下载器：原生（Rust）内核是否可用。「进度」页据此展示。
  ipcMain.handle('download:engine', () => nativeDownloaderStatus())
}

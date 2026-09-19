import { app, BrowserWindow, ipcMain, shell, dialog, type WebContents } from 'electron'
import { join } from 'path'
import { totalmem, freemem } from 'os'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import type {
  ForgeKind,
  LaunchOptions,
  LoaderKind,
  MinecraftAccount,
  ModrinthType,
  ModpackExportOptions,
  ResourceKind,
  VersionDirKind,
  LauncherSettings,
  UpdateInfo
} from '@shared/types'
import { accounts, settings, createOfflineAccount } from './store'
import { DeviceCodeSession, refreshAccount } from './auth'
import { loginYggdrasil, refreshYggdrasil, ensureAuthlibInjector } from './yggdrasil'
import { fetchVersionManifest, resolveVersionJson, createVanillaInstance } from './versions'
import { listInstalled } from './installed'
import { installVersion } from './downloader'
import { detectJava, installJava, javaVersionAt, pickJava, pickInstallerJava, requiredJavaForMc } from './java'
import { spawnGame } from './launcher'
import { loaderVersions, installLoader } from './loaders'
import { forgeVersions, installForge } from './forge'
import { searchMods, getVersions as getModVersions, installMod, downloadTo, findFabricApi } from './modrinth'
import { listResources, removeResource, openResourceDir } from './resources'
import { probeModpack, importModpack, importModpackFromUrl, exportModpack, collectExportInventory, downloadModpack } from './modpack'
import { fetchAbout, fetchAgreement, fetchUpdateInfo, downloadUpdate, runUpdate, compareVersions } from './server'
import {
  enrichMods,
  listMods,
  toggleMod,
  deleteMod,
  installLocalMod,
  deleteWorld,
  listSchematics,
  deleteFile,
  deleteVersion,
  renameVersion,
  openVersionDir
} from './manage'

let mainWindow: BrowserWindow | null = null
let authSession: DeviceCodeSession | null = null
let gameProcess: ChildProcessWithoutNullStreams | null = null
let downloadAbort: AbortController | null = null
const modAborts = new Set<AbortController>()

function createWindow(): void {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#0b0d14',
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function sendToSender(sender: WebContents, channel: string, payload: unknown): void {
  if (!sender.isDestroyed()) sender.send(channel, payload)
}

/** 判断某个实例是否隔离（全局隔离或整合包实例强制隔离）。 */
function isIsolated(versionId: string): boolean {
  const s = settings.get()
  return s.versionIsolation || s.isolatedVersions.includes(versionId)
}

function registerIpc(): void {
  // ---- Auth ----
  ipcMain.handle('auth:begin', async (event) => {
    authSession?.cancel()
    authSession = new DeviceCodeSession()
    return authSession.begin((status) => {
      if (status.state === 'success') accounts.upsert(status.account)
      sendToSender(event.sender, 'auth:status', status)
    })
  })
  ipcMain.handle('auth:cancel', () => {
    authSession?.cancel()
    authSession = null
  })
  ipcMain.handle('auth:refresh', async (_e, account: MinecraftAccount) => {
    const updated = await refreshAccount(account)
    accounts.upsert(updated)
    return updated
  })

  // ---- Accounts ----
  ipcMain.handle('accounts:list', () => accounts.list())
  ipcMain.handle('accounts:selected', () => accounts.selected())
  ipcMain.handle('accounts:remove', (_e, id: string) => accounts.remove(id))
  ipcMain.handle('accounts:select', (_e, id: string) => accounts.select(id))
  ipcMain.handle('accounts:addOffline', (_e, name: string) => {
    const acc = createOfflineAccount(name)
    accounts.upsert(acc)
    accounts.select(acc.id)
    return acc
  })
  ipcMain.handle('accounts:addYggdrasil', async (_e, server: string, email: string, password: string) => {
    const acc = await loginYggdrasil(server, email, password)
    accounts.upsert(acc)
    accounts.select(acc.id)
    return acc
  })

  // ---- Versions ----
  ipcMain.handle('versions:list', () => fetchVersionManifest(settings.get().mirror))
  ipcMain.handle('versions:get', (_e, id: string) =>
    resolveVersionJson(id, settings.get().mirror, settings.get().gameDir)
  )
  ipcMain.handle('versions:createVanilla', (_e, baseVersion: string, customName: string) =>
    createVanillaInstance(settings.get().gameDir, baseVersion, customName)
  )

  // ---- Installed versions / worlds / servers ----
  ipcMain.handle('installed:list', () => {
    const s = settings.get()
    return listInstalled(s.gameDir, s.versionIsolation, s.isolatedVersions)
  })

  // ---- Mod loaders (Fabric / Quilt) ----
  ipcMain.handle('loaders:versions', (_e, kind: LoaderKind, mc: string) => loaderVersions(kind, mc))
  ipcMain.handle('loaders:install', (_e, kind: LoaderKind, mc: string, loader: string, customId?: string) =>
    installLoader(kind, mc, loader, settings.get().gameDir, customId)
  )

  // ---- Mod loaders (Forge / NeoForge) ----
  ipcMain.handle('forge:versions', (_e, kind: ForgeKind, mc: string) => forgeVersions(kind, mc))
  ipcMain.handle('forge:install', async (event, kind: ForgeKind, mc: string, version: string, customId?: string) => {
    const s = settings.get()
    const jr = await pickInstallerJava(s.gameDir, s.javaPath, requiredJavaForMc(mc))
    if (!jr) throw new Error('未找到可用的 Java，无法运行安装器（请在「设置」中指定 Java 路径）')
    return installForge(kind, mc, version, s.gameDir, jr.path, (line) => {
      sendToSender(event.sender, 'forge:log', line)
    }, customId, (p) => {
      sendToSender(event.sender, 'download:progress', p)
    })
  })

  // ---- Download / install ----
  ipcMain.handle('download:install', async (event, id: string) => {
    const s = settings.get()
    const json = await resolveVersionJson(id, s.mirror, s.gameDir)
    downloadAbort = new AbortController()
    try {
      await installVersion(json, s.gameDir, s.mirror, s.maxDownloadConcurrency, (p) => {
        sendToSender(event.sender, 'download:progress', { ...p, taskId: id })
      }, downloadAbort.signal)
    } finally {
      downloadAbort = null
    }
    return { versionId: json.id, assetIndex: json.assetIndex.id }
  })
  ipcMain.handle('download:cancel', () => {
    downloadAbort?.abort()
    for (const c of modAborts) c.abort()
    modAborts.clear()
    return true
  })

  // ---- Mods & resources (Modrinth) ----
  ipcMain.handle('mods:search', (_e, query: string, type?: ModrinthType, category?: string, gameVersion?: string, loader?: string, offset?: number) =>
    searchMods(query, 24, type, category, gameVersion, loader, offset ?? 0)
  )
  ipcMain.handle('mods:versions', (_e, slug: string, loaders: string[], gameVersions: string[]) =>
    getModVersions(slug, loaders, gameVersions)
  )
  ipcMain.handle(
    'mods:install',
    async (event, fileUrl: string, filename: string, versionId: string, type?: ModrinthType) => {
      const s = settings.get()
      const controller = new AbortController()
      modAborts.add(controller)
      const emit = (received: number, total: number): void =>
        sendToSender(event.sender, 'download:progress', {
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
        const dest = await installMod(fileUrl, filename, s.gameDir, versionId, isIsolated(versionId), type, emit, controller.signal)
        sendToSender(event.sender, 'download:progress', {
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
        modAborts.delete(controller)
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
    modAborts.add(controller)
    const emit = (received: number, total: number): void =>
      sendToSender(event.sender, 'download:progress', {
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
      const dest = await installMod(file.url, file.filename, s.gameDir, versionId, isIsolated(versionId), 'mod', emit, controller.signal)
      sendToSender(event.sender, 'download:progress', {
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
      modAborts.delete(controller)
    }
  })
  ipcMain.handle('mods:downloadTo', async (event, fileUrl: string, destPath: string) => {
    const filename = destPath.split(/[\\/]/).pop() ?? destPath
    const controller = new AbortController()
    modAborts.add(controller)
    const emit = (received: number, total: number): void =>
      sendToSender(event.sender, 'download:progress', {
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
      const dest = await downloadTo(fileUrl, destPath, emit, controller.signal)
      sendToSender(event.sender, 'download:progress', {
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
      modAborts.delete(controller)
    }
  })

  // ---- Modpack import / export ----
  ipcMain.handle('modpack:probe', (_e, filePath: string) => probeModpack(filePath))
  ipcMain.handle('modpack:download', async (event, url: string, filename: string) => {
    const controller = new AbortController()
    modAborts.add(controller)
    try {
      return await downloadModpack(url, filename, (p) => {
        sendToSender(event.sender, 'modpack:progress', p)
        sendToSender(event.sender, 'download:progress', p)
      }, controller.signal)
    } finally {
      modAborts.delete(controller)
    }
  })
  ipcMain.handle('modpack:import', async (event, filePath: string, customName?: string) => {
    const s = settings.get()
    const controller = new AbortController()
    modAborts.add(controller)
    try {
      const id = await importModpack(filePath, s.gameDir, customName ?? '', (p) => {
        sendToSender(event.sender, 'modpack:progress', p)
        sendToSender(event.sender, 'download:progress', p)
      }, (line) => {
        sendToSender(event.sender, 'forge:log', line)
      }, controller.signal)
      return { versionId: id, name: id }
    } finally {
      modAborts.delete(controller)
    }
  })
  ipcMain.handle('modpack:importFromUrl', async (event, url: string, filename: string, customName?: string) => {
    const s = settings.get()
    const controller = new AbortController()
    modAborts.add(controller)
    try {
      const id = await importModpackFromUrl(url, filename, s.gameDir, customName ?? '', (p) => {
        sendToSender(event.sender, 'modpack:progress', p)
        sendToSender(event.sender, 'download:progress', p)
      }, (line) => {
        sendToSender(event.sender, 'forge:log', line)
      }, controller.signal)
      return { versionId: id, name: id }
    } finally {
      modAborts.delete(controller)
    }
  })
  ipcMain.handle('modpack:exportInventory', (_event, versionId: string) => {
    const s = settings.get()
    return collectExportInventory(s.gameDir, versionId, isIsolated(versionId))
  })
  ipcMain.handle('modpack:export', async (event, versionId: string, options: ModpackExportOptions) => {
    const s = settings.get()
    return exportModpack(versionId, s.gameDir, options, (p) => {
      sendToSender(event.sender, 'modpack:progress', p)
      sendToSender(event.sender, 'download:progress', p)
    })
  })

  // ---- Resource packs / shaders ----
  ipcMain.handle('resources:list', (_e, versionId: string, kind: ResourceKind) => {
    const s = settings.get()
    return listResources(s.gameDir, versionId, isIsolated(versionId), kind)
  })
  ipcMain.handle('resources:remove', (_e, path: string) => removeResource(path))
  ipcMain.handle('resources:open', (_e, versionId: string, kind: ResourceKind) => {
    const s = settings.get()
    return openResourceDir(s.gameDir, versionId, isIsolated(versionId), kind)
  })

  // ---- Version management (mods / worlds / schematics / delete) ----
  ipcMain.handle('manage:mods', async (event, versionId: string) => {
    const s = settings.get()
    const isolated = isIsolated(versionId)
    const mods = await listMods(s.gameDir, versionId, isolated)
    // 先返回元数据名列表，随后后台联网补齐 Modrinth 名称/图标并逐个推送
    if (s.mode !== 'local' && !s.metadataOnlyMods) {
      void enrichMods(s.gameDir, versionId, isolated, (mod) => {
        sendToSender(event.sender, 'manage:mods-updated', { versionId, mod })
      })
    }
    return mods
  })
  ipcMain.handle('manage:toggleMod', (_e, path: string) => toggleMod(path))
  ipcMain.handle('manage:deleteMod', (_e, path: string) => deleteMod(path))
  ipcMain.handle('manage:installLocalMod', (_e, versionId: string, sourcePath: string) => {
    const s = settings.get()
    return installLocalMod(s.gameDir, versionId, isIsolated(versionId), sourcePath)
  })
  ipcMain.handle('manage:deleteWorld', (_e, versionId: string, worldName: string) => {
    const s = settings.get()
    return deleteWorld(s.gameDir, versionId, isIsolated(versionId), worldName)
  })
  ipcMain.handle('manage:schematics', (_e, versionId: string) => {
    const s = settings.get()
    return listSchematics(s.gameDir, versionId, isIsolated(versionId))
  })
  ipcMain.handle('manage:deleteFile', (_e, path: string) => deleteFile(path))
  ipcMain.handle('manage:deleteVersion', async (_e, versionId: string) => {
    const s = settings.get()
    await deleteVersion(s.gameDir, versionId)
    return true
  })
  ipcMain.handle('manage:renameVersion', async (_e, versionId: string, newName: string) => {
    const s = settings.get()
    const newId = await renameVersion(s.gameDir, versionId, newName)
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
    const dir = await openVersionDir(s.gameDir, versionId, isIsolated(versionId), kind)
    void shell.openPath(dir)
    return dir
  })

  // ---- Java ----
  ipcMain.handle('java:detect', () => detectJava(settings.get().gameDir))
  ipcMain.handle('java:check', async (_e, versionId: string) => {
    const s = settings.get()
    const json = await resolveVersionJson(versionId, s.mirror, s.gameDir)
    const required = json.javaVersion?.majorVersion ?? 8
    const available = await detectJava(s.gameDir)
    let compatible = false
    const currentPath = s.javaPath
    if (currentPath) {
      const jr = await javaVersionAt(currentPath)
      if (jr && jr.major >= required) compatible = true
    }
    if (!compatible) {
      compatible = available.some((r) => r.major >= required)
    }
    return { required, compatible, available }
  })
  ipcMain.handle('java:install', async (event, major: number) => {
    const s = settings.get()
    downloadAbort = new AbortController()
    try {
      const path = await installJava(major, s.gameDir, (percent, task, currentBytes, totalBytes, phase) => {
        sendToSender(event.sender, 'download:progress', {
          taskId: `java-${major}`,
          task,
          current: percent,
          total: 100,
          currentBytes,
          totalBytes,
          phase,
          percent
        })
      }, downloadAbort.signal)
      settings.set({ javaPath: path, javaAutoDetect: false })
      return path
    } finally {
      downloadAbort = null
    }
  })

  // ---- Launch ----
  ipcMain.handle('launch:start', async (event, options: LaunchOptions) => {
    const s = settings.get()
    if (s.disabledVersions.includes(options.versionId)) {
      throw new Error('该版本已被禁用，请在版本管理中启用后再启动')
    }
    let account = accounts.list().find((a) => a.id === options.accountId) ?? accounts.selected()
    if (!account) throw new Error('请先登录一个账号')

    if (account.expiresAt < Date.now() + 60_000) {
      try {
        account =
          account.authType === 'yggdrasil' ? await refreshYggdrasil(account) : await refreshAccount(account)
        accounts.upsert(account)
      } catch (err) {
        throw new Error(`账号令牌已过期且刷新失败：${err instanceof Error ? err.message : err}`)
      }
    }

    const emit = (e: unknown): void => sendToSender(event.sender, 'launch:event', e)

    emit({ state: 'downloading' })
    const json = await resolveVersionJson(options.versionId, s.mirror, s.gameDir)
    const installDir = options.gameDir || s.gameDir
    const runDir = isIsolated(options.versionId)
      ? join(installDir, 'versions', options.versionId)
      : installDir
    downloadAbort = new AbortController()
    const result = await installVersion(json, installDir, s.mirror, s.maxDownloadConcurrency, (p) => {
      sendToSender(event.sender, 'download:progress', { ...p, taskId: options.versionId })
    }, downloadAbort.signal).finally(() => {
      downloadAbort = null
    })

    let javaPath = options.javaPath || s.javaPath
    if (!javaPath) {
      const major = json.javaVersion?.majorVersion ?? 8
      const runtimes = await detectJava(s.gameDir)
      const jr = pickJava(runtimes, major)
      if (!jr) {
        throw new Error(`未找到 Java ${major} 运行时，请在「设置」中手动指定 Java 路径`)
      }
      javaPath = jr.path
    }

    if (account.authType === 'yggdrasil') {
      await ensureAuthlibInjector(installDir)
    }

    emit({ state: 'launching' })
    gameProcess = spawnGame(
      {
        json,
        installDir,
        runDir,
        javaPath,
        nativesDir: result.nativesDir,
        assetIndexId: result.assetIndexId,
        account,
        options
      },
      emit
    )

    return { pid: gameProcess.pid ?? 0 }
  })
  ipcMain.handle('launch:stop', () => {
    gameProcess?.kill()
    return true
  })

  // ---- Settings ----
  ipcMain.handle('settings:get', () => settings.get())
  ipcMain.handle('settings:set', (_e, partial: Partial<LauncherSettings>) => settings.set(partial))
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('system:memory', () => {
    const total = Math.round(totalmem() / 1024 / 1024)
    const free = Math.round(freemem() / 1024 / 1024)
    return { total, used: total - free, free }
  })

  // ---- About / agreement / update (remote server) ----
  ipcMain.handle('about:list', () => fetchAbout())
  ipcMain.handle('about:agreement', () => fetchAgreement())
  ipcMain.handle('update:check', async () => {
    const currentVersion = app.getVersion()
    let latest: UpdateInfo | null = null
    try {
      latest = await fetchUpdateInfo()
    } catch {
      latest = null
    }
    return {
      currentVersion,
      latest,
      hasUpdate: latest ? compareVersions(latest.version, currentVersion) > 0 : false
    }
  })
  ipcMain.handle('update:download', async (event, info: UpdateInfo) => {
    const s = settings.get()
    return downloadUpdate(info, s.gameDir, (p) => {
      sendToSender(event.sender, 'update:progress', p)
    })
  })
  ipcMain.handle('update:downloadAndRun', async (event, info: UpdateInfo) => {
    const s = settings.get()
    const path = await downloadUpdate(info, s.gameDir, (p) => {
      sendToSender(event.sender, 'update:progress', p)
    })
    runUpdate(path)
    return path
  })

  // ---- Window controls ----
  ipcMain.handle('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.handle('window:maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  ipcMain.handle('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.handle('window:isMaximized', (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false)

  // ---- Shell ----
  ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url))
  ipcMain.handle('shell:openPath', (_e, p: string) => shell.openPath(p))
  ipcMain.handle('shell:chooseDirectory', async (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    const r = await dialog.showOpenDialog(w!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle(
    'shell:pickFile',
    async (e, filters?: Array<{ name: string; extensions: string[] }>) => {
      const w = BrowserWindow.fromWebContents(e.sender)
      const r = await dialog.showOpenDialog(w!, { properties: ['openFile'], filters })
      return r.canceled ? null : r.filePaths[0]
    }
  )
  ipcMain.handle(
    'shell:pickFiles',
    async (e, filters?: Array<{ name: string; extensions: string[] }>) => {
      const w = BrowserWindow.fromWebContents(e.sender)
      const r = await dialog.showOpenDialog(w!, { properties: ['openFile', 'multiSelections'], filters })
      return r.canceled ? [] : r.filePaths
    }
  )
  ipcMain.handle('shell:saveFile', async (e, defaultName: string) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    const r = await dialog.showSaveDialog(w!, { defaultPath: defaultName })
    return r.canceled || !r.filePath ? null : r.filePath
  })
}

app.setName('HungerCatLauncher')

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

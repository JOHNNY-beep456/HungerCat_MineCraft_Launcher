import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  AuthStatus,
  DownloadProgress,
  ForgeKind,
  LaunchEvent,
  LaunchOptions,
  LauncherApi,
  LauncherSettings,
  LoaderKind,
  MinecraftAccount,
  ModEntry,
  ModrinthType,
  ModpackExportOptions,
  ResourceKind,
  UpdateInfo,
  VersionDirKind
} from '@shared/types'

function subscribe<T>(channel: string): (cb: (payload: T) => void) => () => void {
  return (cb) => {
    const handler = (_e: IpcRendererEvent, payload: T): void => cb(payload)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}

const api: LauncherApi = {
  platform: process.platform,
  getVersion: () => ipcRenderer.invoke('app:version'),
  auth: {
    begin: () => ipcRenderer.invoke('auth:begin'),
    cancel: () => ipcRenderer.invoke('auth:cancel'),
    refresh: (account: MinecraftAccount) => ipcRenderer.invoke('auth:refresh', account),
    onStatus: subscribe<AuthStatus>('auth:status')
  },
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    selected: () => ipcRenderer.invoke('accounts:selected'),
    remove: (id: string) => ipcRenderer.invoke('accounts:remove', id),
    select: (id: string) => ipcRenderer.invoke('accounts:select', id),
    addOffline: (name: string) => ipcRenderer.invoke('accounts:addOffline', name),
    addYggdrasil: (server: string, email: string, password: string) =>
      ipcRenderer.invoke('accounts:addYggdrasil', server, email, password)
  },
  versions: {
    list: () => ipcRenderer.invoke('versions:list'),
    get: (id: string) => ipcRenderer.invoke('versions:get', id),
    createVanilla: (baseVersion: string, customName: string) =>
      ipcRenderer.invoke('versions:createVanilla', baseVersion, customName)
  },
  installed: {
    list: () => ipcRenderer.invoke('installed:list')
  },
  loaders: {
    versions: (kind: LoaderKind, mcVersion: string) => ipcRenderer.invoke('loaders:versions', kind, mcVersion),
    install: (kind: LoaderKind, mcVersion: string, loaderVersion: string, customId?: string) =>
      ipcRenderer.invoke('loaders:install', kind, mcVersion, loaderVersion, customId)
  },
  forge: {
    versions: (kind: ForgeKind, mcVersion: string) => ipcRenderer.invoke('forge:versions', kind, mcVersion),
    install: (kind: ForgeKind, mcVersion: string, version: string, customId?: string) =>
      ipcRenderer.invoke('forge:install', kind, mcVersion, version, customId),
    onLog: subscribe<string>('forge:log')
  },
  resources: {
    list: (versionId: string, kind: ResourceKind) => ipcRenderer.invoke('resources:list', versionId, kind),
    remove: (path: string) => ipcRenderer.invoke('resources:remove', path),
    open: (versionId: string, kind: ResourceKind) => ipcRenderer.invoke('resources:open', versionId, kind)
  },
  download: {
    install: (id: string) => ipcRenderer.invoke('download:install', id),
    cancel: () => ipcRenderer.invoke('download:cancel'),
    onProgress: subscribe<DownloadProgress>('download:progress')
  },
  mods: {
    search: (query: string, type?: ModrinthType, category?: string, gameVersion?: string, loader?: string, offset?: number) =>
      ipcRenderer.invoke('mods:search', query, type, category, gameVersion, loader, offset),
    versions: (slug: string, loaders: string[], gameVersions: string[]) =>
      ipcRenderer.invoke('mods:versions', slug, loaders, gameVersions),
    install: (fileUrl: string, filename: string, versionId: string, type?: ModrinthType) =>
      ipcRenderer.invoke('mods:install', fileUrl, filename, versionId, type),
    downloadTo: (fileUrl: string, destPath: string) => ipcRenderer.invoke('mods:downloadTo', fileUrl, destPath)
  },
  java: {
    detect: () => ipcRenderer.invoke('java:detect'),
    check: (versionId: string) => ipcRenderer.invoke('java:check', versionId),
    install: (major: number) => ipcRenderer.invoke('java:install', major)
  },
  manage: {
    mods: (versionId: string) => ipcRenderer.invoke('manage:mods', versionId),
    onModsUpdated: subscribe<{ versionId: string; mod: ModEntry }>('manage:mods-updated'),
    toggleMod: (path: string) => ipcRenderer.invoke('manage:toggleMod', path),
    deleteMod: (path: string) => ipcRenderer.invoke('manage:deleteMod', path),
    installLocalMod: (versionId: string, sourcePath: string) =>
      ipcRenderer.invoke('manage:installLocalMod', versionId, sourcePath),
    deleteWorld: (versionId: string, worldName: string) => ipcRenderer.invoke('manage:deleteWorld', versionId, worldName),
    schematics: (versionId: string) => ipcRenderer.invoke('manage:schematics', versionId),
    deleteFile: (path: string) => ipcRenderer.invoke('manage:deleteFile', path),
    deleteVersion: (versionId: string) => ipcRenderer.invoke('manage:deleteVersion', versionId),
    renameVersion: (versionId: string, newName: string) =>
      ipcRenderer.invoke('manage:renameVersion', versionId, newName),
    openDir: (versionId: string, kind: VersionDirKind) => ipcRenderer.invoke('manage:openDir', versionId, kind)
  },
  launch: {
    start: (opts: LaunchOptions) => ipcRenderer.invoke('launch:start', opts),
    stop: () => ipcRenderer.invoke('launch:stop'),
    onEvent: subscribe<LaunchEvent>('launch:event')
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (partial: Partial<LauncherSettings>) => ipcRenderer.invoke('settings:set', partial)
  },
  system: {
    memory: () => ipcRenderer.invoke('system:memory')
  },
  modpack: {
    probe: (filePath: string) => ipcRenderer.invoke('modpack:probe', filePath),
    download: (url: string, filename: string) => ipcRenderer.invoke('modpack:download', url, filename),
    import: (filePath: string, customName?: string) => ipcRenderer.invoke('modpack:import', filePath, customName),
    importFromUrl: (url: string, filename: string, customName?: string) => ipcRenderer.invoke('modpack:importFromUrl', url, filename, customName),
    exportInventory: (versionId: string) => ipcRenderer.invoke('modpack:exportInventory', versionId),
    export: (versionId: string, options: ModpackExportOptions) => ipcRenderer.invoke('modpack:export', versionId, options),
    onProgress: subscribe<DownloadProgress>('modpack:progress')
  },
  about: {
    list: () => ipcRenderer.invoke('about:list'),
    agreement: () => ipcRenderer.invoke('about:agreement')
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: (info: UpdateInfo) => ipcRenderer.invoke('update:download', info),
    onProgress: subscribe<DownloadProgress>('update:progress')
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized')
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
    openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
    chooseDirectory: () => ipcRenderer.invoke('shell:chooseDirectory'),
    pickFile: (filters) => ipcRenderer.invoke('shell:pickFile', filters),
    pickFiles: (filters) => ipcRenderer.invoke('shell:pickFiles', filters),
    saveFile: (defaultName: string) => ipcRenderer.invoke('shell:saveFile', defaultName),
    getPathForFile: (file: File) => webUtils.getPathForFile(file)
  }
}

contextBridge.exposeInMainWorld('api', api)

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
  ModSource,
  ResourceKind,
  ResourceUpdated,
  ResourceUpdateEvent,
  ResourceUpdateInfo,
  SourceFilter,
  UpdateInfo,
  VersionDirKind,
  DebugLogEntry,
  DevModeStatus,
  FeedbackSubmitPayload,
  ModrinthProjectDetail,
  ExternalVersion,
  ConflictPolicy,
  JavaRuntime,
  YggdrasilLoginOutcome,
  MpMiniState,
  MpChatMessage,
  MpHudState,
  MpDanmaku
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
  debug: {
    getLogs: () => ipcRenderer.invoke('debug:getLogs'),
    onLog: subscribe<DebugLogEntry>('debug:log'),
    openWindow: () => ipcRenderer.invoke('debug:open'),
    closeWindow: () => ipcRenderer.invoke('debug:close'),
    isEnabled: () => ipcRenderer.invoke('debug:isEnabled'),
    submitLogs: (key: string) => ipcRenderer.invoke('debug:submit', key),
    reportLog: (level: DebugLogEntry['level'], message: string) =>
      ipcRenderer.send('debug:rendererLog', level, message)
  },
  auth: {
    begin: () => ipcRenderer.invoke('auth:begin'),
    cancel: () => ipcRenderer.invoke('auth:cancel'),
    refresh: (account: MinecraftAccount) => ipcRenderer.invoke('auth:refresh', account),
    onStatus: subscribe<AuthStatus>('auth:status')
  },
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    selected: () => ipcRenderer.invoke('accounts:selected'),
    refreshSiteNames: () => ipcRenderer.invoke('accounts:refreshSiteNames'),
    remove: (id: string) => ipcRenderer.invoke('accounts:remove', id),
    select: (id: string) => ipcRenderer.invoke('accounts:select', id),
    addOffline: (name: string) => ipcRenderer.invoke('accounts:addOffline', name),
    addYggdrasil: (server: string, email: string, password: string): Promise<YggdrasilLoginOutcome> =>
      ipcRenderer.invoke('accounts:addYggdrasil', server, email, password),
    addYggdrasilProfiles: (ids: string[]): Promise<MinecraftAccount[]> =>
      ipcRenderer.invoke('accounts:addYggdrasilProfiles', ids),
    yggdrasilSkin: (server: string, uuid: string) => ipcRenderer.invoke('yggdrasil:skin', server, uuid)
  },
  versions: {
    list: () => ipcRenderer.invoke('versions:list'),
    get: (id: string) => ipcRenderer.invoke('versions:get', id),
    createVanilla: (baseVersion: string, customName: string, dirId?: string) =>
      ipcRenderer.invoke('versions:createVanilla', baseVersion, customName, dirId),
    scanExternal: (mcDir: string): Promise<ExternalVersion[]> =>
      ipcRenderer.invoke('versions:scanExternal', mcDir),
    importExternal: (
      mcDir: string,
      versionId: string,
      onConflict: ConflictPolicy
    ): Promise<{ id: string; action: 'imported' | 'renamed' | 'skipped' }> =>
      ipcRenderer.invoke('versions:importExternal', mcDir, versionId, onConflict)
  },
  installed: {
    list: () => ipcRenderer.invoke('installed:list'),
    listAll: () => ipcRenderer.invoke('installed:listAll'),
    addServer: (versionId: string, name: string, address: string) =>
      ipcRenderer.invoke('installed:addServer', versionId, name, address)
  },
  versionDirs: {
    list: () => ipcRenderer.invoke('versionDirs:list'),
    add: (input: { path: string; alias?: string }) => ipcRenderer.invoke('versionDirs:add', input),
    update: (id: string, patch: { alias?: string; path?: string }) =>
      ipcRenderer.invoke('versionDirs:update', id, patch),
    remove: (id: string) => ipcRenderer.invoke('versionDirs:remove', id),
    select: (id: string) => ipcRenderer.invoke('versionDirs:select', id)
  },
  loaders: {
    versions: (kind: LoaderKind, mcVersion: string) => ipcRenderer.invoke('loaders:versions', kind, mcVersion),
    install: (kind: LoaderKind, mcVersion: string, loaderVersion: string, customId?: string, dirId?: string) =>
      ipcRenderer.invoke('loaders:install', kind, mcVersion, loaderVersion, customId, dirId)
  },
  forge: {
    versions: (kind: ForgeKind, mcVersion: string) => ipcRenderer.invoke('forge:versions', kind, mcVersion),
    install: (kind: ForgeKind, mcVersion: string, version: string, customId?: string, waitForVersion?: string, dirId?: string) =>
      ipcRenderer.invoke('forge:install', kind, mcVersion, version, customId, waitForVersion, dirId),
    onLog: subscribe<string>('forge:log')
  },
  resources: {
    list: (versionId: string, kind: ResourceKind) => ipcRenderer.invoke('resources:list', versionId, kind),
    remove: (path: string) => ipcRenderer.invoke('resources:remove', path),
    open: (versionId: string, kind: ResourceKind) => ipcRenderer.invoke('resources:open', versionId, kind),
    onUpdated: subscribe<ResourceUpdated>('resources:updated'),
    checkUpdates: (versionId: string) => ipcRenderer.invoke('resources:checkUpdates', versionId),
    onUpdateChecked: subscribe<ResourceUpdateEvent>('resources:update-checked'),
    applyUpdate: (versionId: string, update: ResourceUpdateInfo, enabled: boolean) =>
      ipcRenderer.invoke('resources:applyUpdate', versionId, update, enabled)
  },
  download: {
    install: (id: string, dirId?: string) => ipcRenderer.invoke('download:install', id, dirId),
    cancel: (taskId?: string) => ipcRenderer.invoke('download:cancel', taskId),
    /** 当前实际使用的下载器（原生 Rust 内核是否可用）。 */
    engine: () => ipcRenderer.invoke('download:engine'),
    onProgress: subscribe<DownloadProgress>('download:progress')
  },
  mods: {
    search: (
      query: string,
      type?: ModrinthType,
      category?: string,
      gameVersion?: string,
      loader?: string,
      offset?: number,
      source?: SourceFilter
    ) => ipcRenderer.invoke('mods:search', query, type, category, gameVersion, loader, offset, source),
    project: (id: string, type?: ModrinthType): Promise<ModrinthProjectDetail> =>
      ipcRenderer.invoke('mods:project', id, type),
    versions: (slug: string, loaders: string[], gameVersions: string[], source?: ModSource, type?: ModrinthType) =>
      ipcRenderer.invoke('mods:versions', slug, loaders, gameVersions, source, type),
    install: (fileUrl: string, filename: string, versionId: string, type?: ModrinthType, sizeHint?: number, dirId?: string) =>
      ipcRenderer.invoke('mods:install', fileUrl, filename, versionId, type, sizeHint, dirId),
    downloadTo: (fileUrl: string, destPath: string, sizeHint?: number) =>
      ipcRenderer.invoke('mods:downloadTo', fileUrl, destPath, sizeHint),
    installFabricApi: (mcVersion: string, versionId: string) =>
      ipcRenderer.invoke('mods:installFabricApi', mcVersion, versionId),
    installOfflineTranslate: (versionId: string) =>
      ipcRenderer.invoke('mods:installOfflineTranslate', versionId)
  },
  java: {
    detect: () => ipcRenderer.invoke('java:detect'),
    check: (versionId: string) => ipcRenderer.invoke('java:check', versionId),
    install: (major: number) => ipcRenderer.invoke('java:install', major),
    pick: (): Promise<JavaRuntime | null> => ipcRenderer.invoke('java:pick')
  },
  manage: {
    mods: (versionId: string, dirId?: string) => ipcRenderer.invoke('manage:mods', versionId, dirId),
    onModsUpdated: subscribe<{ versionId: string; mod: ModEntry }>('manage:mods-updated'),
    toggleMod: (path: string) => ipcRenderer.invoke('manage:toggleMod', path),
    deleteMod: (path: string) => ipcRenderer.invoke('manage:deleteMod', path),
    installLocalMod: (versionId: string, sourcePath: string) =>
      ipcRenderer.invoke('manage:installLocalMod', versionId, sourcePath),
    installLocalResource: (versionId: string, kind: 'mods' | 'resourcepacks' | 'shaderpacks', sourcePath: string) =>
      ipcRenderer.invoke('manage:installLocalResource', versionId, kind, sourcePath),
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
    set: (partial: Partial<LauncherSettings>) => ipcRenderer.invoke('settings:set', partial),
    pickWallpaper: () => ipcRenderer.invoke('settings:pickWallpaper'),
    clearWallpaper: () => ipcRenderer.invoke('settings:clearWallpaper'),
    wallpaperData: () => ipcRenderer.invoke('settings:wallpaperData')
  },
  system: {
    memory: () => ipcRenderer.invoke('system:memory'),
    hardware: () => ipcRenderer.invoke('system:hardware')
  },
  homepage: {
    list: () => ipcRenderer.invoke('homepage:list'),
    read: (id: string) => ipcRenderer.invoke('homepage:read', id),
    importFile: () => ipcRenderer.invoke('homepage:importFile'),
    download: (url: string, filename: string, sizeHint?: number) =>
      ipcRenderer.invoke('homepage:download', url, filename, sizeHint),
    remove: (id: string) => ipcRenderer.invoke('homepage:remove', id),
    verify: (id: string) => ipcRenderer.invoke('homepage:verify', id),
    confirm: (id: string, network: boolean) => ipcRenderer.invoke('homepage:confirm', id, network),
    setActive: (id: string) => ipcRenderer.invoke('homepage:setActive', id),
    block: (id: string, reason: string) => ipcRenderer.invoke('homepage:block', id, reason),
    openDir: () => ipcRenderer.invoke('homepage:openDir'),
    securityEngine: () => ipcRenderer.invoke('homepage:securityEngine'),
    market: () => ipcRenderer.invoke('homepage:market'),
    checkUpdates: () => ipcRenderer.invoke('homepage:checkUpdates'),
    update: (update) => ipcRenderer.invoke('homepage:update', update),
    submit: (payload) => ipcRenderer.invoke('homepage:submit', payload),
    sendEmailCode: (email: string) => ipcRenderer.invoke('homepage:send-email-code', email),
    installNumbered: (input) => ipcRenderer.invoke('homepage:installNumbered', input),
    log: (level, message) => {
      void ipcRenderer.invoke('homepage:log', level, message)
    },
    onNavBlocked: subscribe<string>('homepage:nav-blocked')
  },
  feedback: {
    sendCode: (email: string) => ipcRenderer.invoke('feedback:send-code', email),
    submit: (payload: FeedbackSubmitPayload) => ipcRenderer.invoke('feedback:submit', payload),
    list: (email: string, code: string) => ipcRenderer.invoke('feedback:list', email, code),
    withdraw: (email: string, code: string, id: string) =>
      ipcRenderer.invoke('feedback:withdraw', email, code, id)
  },
  limits: {
    get: () => ipcRenderer.invoke('limits:get')
  },
  devMode: {
    status: () => ipcRenderer.invoke('devmode:status'),
    sendCode: (email: string) => ipcRenderer.invoke('devmode:sendCode', email),
    verify: (email: string, code: string) => ipcRenderer.invoke('devmode:verify', email, code),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke('devmode:setEnabled', enabled),
    revoke: () => ipcRenderer.invoke('devmode:revoke'),
    setSecurityMode: (mode: 'full' | 'warn' | 'off') => ipcRenderer.invoke('devmode:setSecurityMode', mode),
    openTools: () => ipcRenderer.invoke('devmode:openTools'),
    closeTools: () => ipcRenderer.invoke('devmode:closeTools'),
    openDevTools: () => ipcRenderer.invoke('devmode:openDevTools'),
    closeDevTools: () => ipcRenderer.invoke('devmode:closeDevTools'),
    onChanged: subscribe<DevModeStatus>('devmode:changed')
  },
  files: {
    places: () => ipcRenderer.invoke('files:places'),
    list: (path: string) => ipcRenderer.invoke('files:list', path),
    open: (path: string) => ipcRenderer.invoke('files:open', path),
    reveal: (path: string) => ipcRenderer.invoke('files:reveal', path),
    rename: (path: string, name: string) => ipcRenderer.invoke('files:rename', path, name),
    createFile: (dir: string, name: string) => ipcRenderer.invoke('files:createFile', dir, name),
    remove: (path: string) => ipcRenderer.invoke('files:remove', path),
    readText: (path: string) => ipcRenderer.invoke('files:readText', path),
    writeText: (path: string, content: string) => ipcRenderer.invoke('files:writeText', path, content)
  },
  modpack: {
    probe: (filePath: string) => ipcRenderer.invoke('modpack:probe', filePath),
    download: (url: string, filename: string) => ipcRenderer.invoke('modpack:download', url, filename),
    import: (filePath: string, customName?: string, dirId?: string) => ipcRenderer.invoke('modpack:import', filePath, customName, dirId),
    importFromUrl: (url: string, filename: string, customName?: string, dirId?: string) => ipcRenderer.invoke('modpack:importFromUrl', url, filename, customName, dirId),
    exportInventory: (versionId: string) => ipcRenderer.invoke('modpack:exportInventory', versionId),
    export: (versionId: string, options: ModpackExportOptions) => ipcRenderer.invoke('modpack:export', versionId, options),
    onProgress: subscribe<DownloadProgress>('modpack:progress')
  },
  about: {
    list: () => ipcRenderer.invoke('about:list'),
    agreement: () => ipcRenderer.invoke('about:agreement'),
    agreementStatus: () => ipcRenderer.invoke('about:agreementStatus'),
    announcements: () => ipcRenderer.invoke('announcement:list')
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: (info: UpdateInfo) => ipcRenderer.invoke('update:download', info),
    downloadAndRun: (info: UpdateInfo) => ipcRenderer.invoke('update:downloadAndRun', info),
    onProgress: subscribe<DownloadProgress>('update:progress')
  },
  translate: {
    texts: (texts: string[], target: string) => ipcRenderer.invoke('translate:texts', texts, target),
    setKey: (key: string) => ipcRenderer.invoke('translate:setKey', key),
    clearKey: () => ipcRenderer.invoke('translate:clearKey')
  },
  minecraft: {
    userinfo: (name: string) => ipcRenderer.invoke('minecraft:userinfo', name),
    serverStatus: (address: string) => ipcRenderer.invoke('minecraft:serverstatus', address)
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    setFullscreen: (on: boolean) => ipcRenderer.invoke('window:setFullscreen', on),
    setAlwaysOnTop: (on: boolean) => ipcRenderer.invoke('window:setAlwaysOnTop', on),
    setDesktopMode: (on: boolean) => ipcRenderer.invoke('window:setDesktopMode', on),
    securityFullscreen: (on: boolean) => ipcRenderer.invoke('window:securityFullscreen', on)
  },
  display: {
    primary: () => ipcRenderer.invoke('display:primary')
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
    openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
    chooseDirectory: () => ipcRenderer.invoke('shell:chooseDirectory'),
    pickFile: (filters) => ipcRenderer.invoke('shell:pickFile', filters),
    pickFiles: (filters) => ipcRenderer.invoke('shell:pickFiles', filters),
    saveFile: (defaultName: string) => ipcRenderer.invoke('shell:saveFile', defaultName),
    getPathForFile: (file: File) => webUtils.getPathForFile(file)
  },
  // 联机板块（MCTier 移植）：组网内核、大厅生命周期与状态。
  mp: {
    binariesStatus: () => ipcRenderer.invoke('mp:binariesStatus'),
    openResourceDir: () => ipcRenderer.invoke('mp:openResourceDir'),
    isElevated: () => ipcRenderer.invoke('mp:isElevated'),
    createLobby: (params) => ipcRenderer.invoke('mp:createLobby', params),
    joinLobby: (params) => ipcRenderer.invoke('mp:joinLobby', params),
    leaveLobby: () => ipcRenderer.invoke('mp:leaveLobby'),
    forceStop: () => ipcRenderer.invoke('mp:forceStop'),
    getAppState: () => ipcRenderer.invoke('mp:getAppState'),
    getLobby: () => ipcRenderer.invoke('mp:getLobby'),
    getPlayers: () => ipcRenderer.invoke('mp:getPlayers'),
    setMicEnabled: (enabled: boolean) => ipcRenderer.invoke('mp:setMicEnabled', enabled),
    getMicEnabled: () => ipcRenderer.invoke('mp:getMicEnabled'),
    setGlobalMuted: (muted: boolean) => ipcRenderer.invoke('mp:setGlobalMuted', muted),
    getGlobalMuted: () => ipcRenderer.invoke('mp:getGlobalMuted'),
    onGlobalMutedChanged: (cb) => {
      const listener = (_e: unknown, muted: boolean): void => cb(muted)
      ipcRenderer.on('mp:globalMutedChanged', listener)
      return () => ipcRenderer.removeListener('mp:globalMutedChanged', listener)
    },
    mutePlayer: (playerId: string, muted: boolean) => ipcRenderer.invoke('mp:mutePlayer', playerId, muted),
    isPlayerMuted: (playerId: string) => ipcRenderer.invoke('mp:isPlayerMuted', playerId),
    parseVirtualIp: (text: string) => ipcRenderer.invoke('mp:parseVirtualIp', text),
    openExternal: (url: string) => ipcRenderer.invoke('mp:openExternal', url),
    // 局域网桥：扫描 / 注入 MC 世界，解决「看得到人却连不上」。
    scanWorlds: () => ipcRenderer.invoke('mp:scanWorlds'),
    getWorlds: () => ipcRenderer.invoke('mp:getWorlds'),
    getWorldPort: () => ipcRenderer.invoke('mp:getWorldPort'),
    setWorldPort: (port: number) => ipcRenderer.invoke('mp:setWorldPort', port),
    getAutoLan: () => ipcRenderer.invoke('mp:getAutoLan'),
    setAutoLan: (enabled: boolean) => ipcRenderer.invoke('mp:setAutoLan', enabled),
    getLanBroadcastCount: () => ipcRenderer.invoke('mp:getLanBroadcastCount'),
    // 大厅悬浮窗（类似 MCTier 的迷你窗）。
    openMiniWindow: () => ipcRenderer.invoke('mp:openMiniWindow'),
    closeMiniWindow: () => ipcRenderer.invoke('mp:closeMiniWindow'),
    miniState: () => ipcRenderer.invoke('mp:miniState'),
    miniResize: (width: number, height: number) => ipcRenderer.invoke('mp:miniResize', width, height),
    onMiniState: (cb) => {
      const listener = (_e: unknown, state: unknown): void => cb(state as MpMiniState)
      ipcRenderer.on('mp:miniState', listener)
      return () => ipcRenderer.removeListener('mp:miniState', listener)
    },
    // 大厅状态变化（不携带数据，收到后自行重新拉取，保证单一事实来源）。
    onLobbyChanged: (cb: () => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('mp:lobbyChanged', listener)
      return () => ipcRenderer.removeListener('mp:lobbyChanged', listener)
    },
    hasMainWindow: () => ipcRenderer.invoke('mp:hasMainWindow'),
    onMicChanged: (cb: (enabled: boolean) => void) => {
      const listener = (_e: unknown, enabled: boolean): void => cb(enabled)
      ipcRenderer.on('mp:micChanged', listener)
      return () => ipcRenderer.removeListener('mp:micChanged', listener)
    },
    // ---- 消息收发 ----
    sendChat: (content: string) => ipcRenderer.invoke('mp:sendChat', content),
    getMessages: () => ipcRenderer.invoke('mp:getMessages'),
    onChat: (cb) => {
      const listener = (_e: unknown, msg: unknown): void => cb(msg as MpChatMessage)
      ipcRenderer.on('mp:chat', listener)
      return () => ipcRenderer.removeListener('mp:chat', listener)
    },
    // ---- 语音 ----
    setSpeaking: (speaking: boolean) => ipcRenderer.invoke('mp:setSpeaking', speaking),
    /** 上报语音引擎错误（麦克风被拒 / 设备占用等），主进程再广播给界面显示。 */
    reportVoiceError: (message: string) => ipcRenderer.invoke('mp:reportVoiceError', message),
    onVoiceError: (cb) => {
      const listener = (_e: unknown, message: unknown): void => cb(String(message ?? ''))
      ipcRenderer.on('mp:voiceError', listener)
      return () => ipcRenderer.removeListener('mp:voiceError', listener)
    },
    // ---- 语音音频中继（经 EasyTier UDP 端口转发）----
    /** 同步成员：主进程为每个成员建立/回收一条到其虚拟 IP 的 UDP 转发。 */
    voiceRelaySync: (peers: Array<{ id: string; virtualIp: string }>) =>
      ipcRenderer.invoke('mp:voiceRelaySync', peers),
    /** 停止中继（退出大厅）。 */
    voiceRelayStop: () => ipcRenderer.invoke('mp:voiceRelayStop'),
    /** 发送一帧已编码音频给指定成员。 */
    sendVoiceAudio: (peerId: string, data: Uint8Array) =>
      ipcRenderer.invoke('mp:voiceAudio', peerId, data),
    /** 订阅「收到某成员的音频帧」。 */
    onVoiceAudio: (cb: (payload: { from: string; data: Uint8Array }) => void) => {
      const listener = (_e: unknown, payload: unknown): void =>
        cb(payload as { from: string; data: Uint8Array })
      ipcRenderer.on('mp:voiceAudio', listener)
      return () => ipcRenderer.removeListener('mp:voiceAudio', listener)
    },
    // ---- 浮层窗口（HUD / 弹幕）----
    openHudWindow: () => ipcRenderer.invoke('mp:openHudWindow'),
    closeHudWindow: () => ipcRenderer.invoke('mp:closeHudWindow'),
    onHudState: (cb) => {
      const listener = (_e: unknown, state: unknown): void => cb(state as MpHudState)
      ipcRenderer.on('mp:hudState', listener)
      return () => ipcRenderer.removeListener('mp:hudState', listener)
    },
    openDanmakuWindow: () => ipcRenderer.invoke('mp:openDanmakuWindow'),
    closeDanmakuWindow: () => ipcRenderer.invoke('mp:closeDanmakuWindow'),
    syncOverlays: () => ipcRenderer.invoke('mp:syncOverlays'),
    onDanmaku: (cb) => {
      const listener = (_e: unknown, d: unknown): void => cb(d as MpDanmaku)
      ipcRenderer.on('mp:danmaku', listener)
      return () => ipcRenderer.removeListener('mp:danmaku', listener)
    },
    danmakuConfig: () => ipcRenderer.invoke('mp:danmakuConfig')
  }
}

contextBridge.exposeInMainWorld('api', api)

import type { LauncherApi } from '@shared/types'
import { createNativeDropPathCache, createTauriTransport, detectTauriPlatform, isTauriMobile } from './transport'
import { createTauriMobileDebugController, type TauriMobileDebugController, type TauriMobileDebugHost } from './mobile-debug'
import type { TauriApiInstallation, TauriBridgeOptions } from './types'
export { detectTauriPlatform, isTauriMobile } from './transport'
export type { TauriApiInstallation, TauriBridgeError, TauriBridgeOptions } from './types'
export type { TauriMobileDebugHost, TauriMobileDebugRequest } from './mobile-debug'

type BridgeLifecycle = Pick<TauriApiInstallation, 'ready' | 'dispose'> & { mobileDebug?: TauriMobileDebugController }
const lifecycles = new WeakMap<LauncherApi, BridgeLifecycle>()

/**
 * 保留 React 使用的完整 LauncherApi。所有业务调用交由 Rust 白名单分发器实际执行；
 * 后端未实现的原生接口必须 reject，不在此返回假成功或回落到 Electron。
 */
export function createTauriApi(options: TauriBridgeOptions = {}): LauncherApi {
  const transport = createTauriTransport(options)
  const { call, send, subscribe } = transport
  const dropPaths = createNativeDropPathCache(transport.report)
  const platform = options.platform ?? detectTauriPlatform()
  // 平台判断只决定视图形式；日志读取权限仍由 Rust 的本机平台和窗口来源核验。
  const mobileDebug = isTauriMobile(platform) ? createTauriMobileDebugController() : undefined
  const api: LauncherApi = {
    platform,
    getVersion: () => call('app:version'),
    hardwareAccelerationBooted: () => call('app:hardwareAccelerationBooted'),
    relaunch: () => call('app:relaunch'),
    debug: {
      getLogs: () => call('debug:getLogs'),
      onLog: subscribe('debug:log'),
      openWindow: async () => {
        if (!mobileDebug) { await call<void>('debug:open'); return }
        await transport.ready
        await mobileDebug.open()
      },
      closeWindow: async () => {
        if (!mobileDebug) { await call<void>('debug:close'); return }
        await transport.ready
        await mobileDebug.close()
      },
      isEnabled: () => call('debug:isEnabled'),
      submitLogs: (key) => call('debug:submit', key),
      reportLog: (level, message) => send('debug:rendererLog', level, message)
    },
    auth: {
      begin: () => call('auth:begin'),
      cancel: () => call('auth:cancel'),
      refresh: (account) => call('auth:refresh', account),
      onStatus: subscribe('auth:status')
    },
    accounts: {
      list: () => call('accounts:list'),
      selected: () => call('accounts:selected'),
      refreshSiteNames: () => call('accounts:refreshSiteNames'),
      remove: (id) => call('accounts:remove', id),
      select: (id) => call('accounts:select', id),
      addOffline: (name) => call('accounts:addOffline', name),
      previewImport: (source, local) => call('accounts:importPreview', source, local),
      commitImport: (sessionId, keys) => call('accounts:importCommit', sessionId, keys),
      cancelImport: (sessionId) => call('accounts:importCancel', sessionId),
      addYggdrasil: (server, email, password) => call('accounts:addYggdrasil', server, email, password),
      addYggdrasilProfiles: (ids) => call('accounts:addYggdrasilProfiles', ids),
      yggdrasilSkin: (server, uuid) => call('yggdrasil:skin', server, uuid)
    },
    versions: {
      list: (force) => call('versions:list', force),
      get: (id) => call('versions:get', id),
      createVanilla: (baseVersion, customName, dirId) => call('versions:createVanilla', baseVersion, customName, dirId),
      scanExternal: (mcDir) => call('versions:scanExternal', mcDir),
      importExternal: (mcDir, versionId, onConflict) => call('versions:importExternal', mcDir, versionId, onConflict)
    },
    installed: {
      list: () => call('installed:list'),
      listAll: () => call('installed:listAll'),
      addServer: (versionId, name, address) => call('installed:addServer', versionId, name, address)
    },
    versionDirs: {
      list: () => call('versionDirs:list'),
      add: (input) => call('versionDirs:add', input),
      update: (id, patch) => call('versionDirs:update', id, patch),
      remove: (id) => call('versionDirs:remove', id),
      select: (id) => call('versionDirs:select', id)
    },
    loaders: {
      versions: (kind, mcVersion) => call('loaders:versions', kind, mcVersion),
      install: (kind, mcVersion, loaderVersion, customId, dirId) => call('loaders:install', kind, mcVersion, loaderVersion, customId, dirId),
      installInPlace: (kind, mcVersion, loaderVersion, instanceId, dirId) => call('loaders:installInPlace', kind, mcVersion, loaderVersion, instanceId, dirId)
    },
    forge: {
      versions: (kind, mcVersion) => call('forge:versions', kind, mcVersion),
      install: (kind, mcVersion, version, customId, waitForVersion, dirId) => call('forge:install', kind, mcVersion, version, customId, waitForVersion, dirId),
      onLog: subscribe('forge:log')
    },
    resources: {
      list: (versionId, kind) => call('resources:list', versionId, kind),
      remove: (path) => call('resources:remove', path),
      open: (versionId, kind) => call('resources:open', versionId, kind),
      onUpdated: subscribe('resources:updated'),
      checkUpdates: (versionId) => call('resources:checkUpdates', versionId),
      onUpdateChecked: subscribe('resources:update-checked'),
      applyUpdate: (versionId, update, enabled) => call('resources:applyUpdate', versionId, update, enabled)
    },
    download: {
      install: (id, dirId) => call('download:install', id, dirId),
      cancel: (taskId) => call('download:cancel', taskId),
      engine: () => call('download:engine'),
      onProgress: subscribe('download:progress')
    },
    mods: {
      search: (query, type, category, gameVersion, loader, offset, source) => call('mods:search', query, type, category, gameVersion, loader, offset, source),
      project: (id, type) => call('mods:project', id, type),
      versions: (slug, loaders, gameVersions, source, type) => call('mods:versions', slug, loaders, gameVersions, source, type),
      install: (fileUrl, filename, versionId, type, sizeHint, dirId) => call('mods:install', fileUrl, filename, versionId, type, sizeHint, dirId),
      downloadTo: (fileUrl, destPath, sizeHint) => call('mods:downloadTo', fileUrl, destPath, sizeHint),
      installFabricApi: (mcVersion, versionId) => call('mods:installFabricApi', mcVersion, versionId),
      installOfflineTranslate: (versionId) => call('mods:installOfflineTranslate', versionId)
    },
    java: {
      detect: () => call('java:detect'),
      check: (versionId) => call('java:check', versionId),
      install: (major) => call('java:install', major),
      pick: () => call('java:pick'),
      runtimes: () => call('android:runtimes'),
      removeRuntime: (major) => call('android:removeRuntime', major)
    },
    manage: {
      mods: (versionId, dirId) => call('manage:mods', versionId, dirId),
      enrichMods: (versionId, dirId) => call('manage:enrichMods', versionId, dirId),
      enrichResources: (versionId, kind, dirId) => call('manage:enrichResources', versionId, kind, dirId),
      onModsUpdated: subscribe('manage:mods-updated'),
      toggleMod: (path) => call('manage:toggleMod', path),
      deleteMod: (path) => call('manage:deleteMod', path),
      installLocalMod: (versionId, sourcePath) => call('manage:installLocalMod', versionId, sourcePath),
      installLocalResource: (versionId, kind, sourcePath) => call('manage:installLocalResource', versionId, kind, sourcePath),
      deleteWorld: (versionId, worldName) => call('manage:deleteWorld', versionId, worldName),
      schematics: (versionId) => call('manage:schematics', versionId),
      deleteFile: (path) => call('manage:deleteFile', path),
      deleteVersion: (versionId) => call('manage:deleteVersion', versionId),
      renameVersion: (versionId, newName) => call('manage:renameVersion', versionId, newName),
      openDir: (versionId, kind) => call('manage:openDir', versionId, kind)
    },
    launch: {
      start: (opts) => call('launch:start', opts),
      stop: () => call('launch:stop'),
      onEvent: subscribe('launch:event')
    },
    settings: {
      get: () => call('settings:get'),
      set: (partial) => call('settings:set', partial),
      pickWallpaper: () => call('settings:pickWallpaper'),
      clearWallpaper: () => call('settings:clearWallpaper'),
      wallpaperData: () => call('settings:wallpaperData')
    },
    system: {
      memory: () => call('system:memory'),
      hardware: () => call('system:hardware')
    },
    homepage: {
      list: () => call('homepage:list'),
      read: (id) => call('homepage:read', id),
      importFile: () => call('homepage:importFile'),
      download: (url, filename, sizeHint) => call('homepage:download', url, filename, sizeHint),
      remove: (id) => call('homepage:remove', id),
      verify: (id) => call('homepage:verify', id),
      hold: (id, sha256) => call('homepage:hold', id, sha256),
      release: () => call('homepage:release'),
      confirm: (id, network, expectedSha) => call('homepage:confirm', id, network, expectedSha ?? null),
      setActive: (id) => call('homepage:setActive', id),
      block: (id, reason) => call('homepage:block', id, reason),
      openDir: () => call('homepage:openDir'),
      securityEngine: () => call('homepage:securityEngine'),
      market: () => call('homepage:market'),
      checkUpdates: () => call('homepage:checkUpdates'),
      update: (update) => call('homepage:update', update),
      submit: (payload) => call('homepage:submit', payload),
      sendEmailCode: (email) => call('homepage:send-email-code', email),
      installNumbered: (input) => call('homepage:installNumbered', input),
      log: (level, message) => {
        void call<void>('homepage:log', level, message).catch((error: unknown) => transport.report('homepage:log', error))
      },
      onNavBlocked: subscribe('homepage:nav-blocked')
    },
    feedback: {
      sendCode: (email) => call('feedback:send-code', email),
      submit: (payload) => call('feedback:submit', payload),
      list: (email, code) => call('feedback:list', email, code),
      detail: (id, email, code) => call('feedback:detail', id, email, code),
      message: (payload) => call('feedback:message', payload),
      openFile: (id, name) => call('feedback:open-file', id, name),
      withdraw: (email, code, id) => call('feedback:withdraw', email, code, id),
      login: (email, code, ttl) => call('feedback:login', email, code, ttl),
      session: () => call('feedback:session'),
      logout: () => call('feedback:logout')
    },
    limits: { get: () => call('limits:get') },
    devMode: {
      status: () => call('devmode:status'),
      sendCode: (email) => call('devmode:sendCode', email),
      verify: (email, code) => call('devmode:verify', email, code),
      setEnabled: (enabled) => call('devmode:setEnabled', enabled),
      revoke: () => call('devmode:revoke'),
      setSecurityMode: (mode) => call('devmode:setSecurityMode', mode),
      openTools: () => call('devmode:openTools'),
      closeTools: () => call('devmode:closeTools'),
      openDevTools: () => call('devmode:openDevTools'),
      closeDevTools: () => call('devmode:closeDevTools'),
      onChanged: subscribe('devmode:changed')
    },
    files: {
      places: () => call('files:places'),
      list: (path) => call('files:list', path),
      open: (path) => call('files:open', path),
      reveal: (path) => call('files:reveal', path),
      rename: (path, name) => call('files:rename', path, name),
      createFile: (dir, name) => call('files:createFile', dir, name),
      remove: (path) => call('files:remove', path),
      readText: (path) => call('files:readText', path),
      writeText: (path, content) => call('files:writeText', path, content)
    },
    modpack: {
      probe: (filePath) => call('modpack:probe', filePath),
      download: (url, filename) => call('modpack:download', url, filename),
      import: (filePath, customName, dirId) => call('modpack:import', filePath, customName, dirId),
      importFromUrl: (url, filename, customName, dirId) => call('modpack:importFromUrl', url, filename, customName, dirId),
      exportInventory: (versionId) => call('modpack:exportInventory', versionId),
      export: (versionId, options) => call('modpack:export', versionId, options),
      onProgress: subscribe('modpack:progress')
    },
    about: {
      list: () => call('about:list'),
      agreement: () => call('about:agreement'),
      agreementStatus: () => call('about:agreementStatus'),
      announcements: () => call('announcement:list')
    },
    update: {
      check: () => call('update:check'),
      download: (info) => call('update:download', info),
      downloadAndRun: (info) => call('update:downloadAndRun', info),
      onProgress: subscribe('update:progress')
    },
    ai: {
      chat: (text, context) => call('ai:chat', text, context),
      cancel: () => call('ai:cancel'),
      decideTool: (id, approved) => call('ai:decideTool', id, approved),
      onToolRequest: subscribe('ai:toolRequest'),
      analyzeError: (text) => call('ai:analyzeError', text),
      test: () => call('ai:test'),
      setKey: (key) => call('ai:setKey', key),
      clearKey: () => call('ai:clearKey'),
      tools: () => call('ai:tools'),
      reset: () => call('ai:reset'),
      transcribe: (audio, mime) => call('ai:transcribe', audio, mime),
      ball: {
        sync: () => call('ai:ball:sync'),
        expand: (open) => call('ai:ball:expand', open),
        move: (x, y, persist) => call('ai:ball:move', x, y, persist),
        position: () => call('ai:ball:position')
      },
      onHudState: subscribe('ai:hudState'),
      onBallExpanded: subscribe('ai:ballExpanded'),
      hudState: () => call('ai:hudState'),
      onVoiceToggle: subscribe('ai:voiceToggle'),
      onLaunchRequest: subscribe('ai:launchRequest'),
      setHudActive: (active) => call('ai:setHudActive', active),
      setHudStatus: (status) => call('ai:setHudStatus', status)
    },
    translate: {
      texts: (texts, target) => call('translate:texts', texts, target),
      setKey: (key) => call('translate:setKey', key),
      clearKey: () => call('translate:clearKey')
    },
    minecraft: {
      userinfo: (name) => call('minecraft:userinfo', name),
      serverStatus: (address) => call('minecraft:serverstatus', address)
    },
    window: {
      minimize: () => call('window:minimize'),
      maximize: () => call('window:maximize'),
      close: () => call('window:close'),
      isMaximized: () => call('window:isMaximized'),
      setFullscreen: (on) => call('window:setFullscreen', on),
      setAlwaysOnTop: (on) => call('window:setAlwaysOnTop', on),
      setDesktopMode: (on) => call('window:setDesktopMode', on),
      securityFullscreen: (on) => call('window:securityFullscreen', on)
    },
    display: { primary: () => call('display:primary') },
    shell: {
      openExternal: (url) => call('shell:openExternal', url),
      openPath: (path) => call('shell:openPath', path),
      chooseDirectory: () => call('shell:chooseDirectory'),
      pickFile: (filters) => call('shell:pickFile', filters),
      pickFiles: (filters) => call('shell:pickFiles', filters),
      saveFile: (defaultName) => call('shell:saveFile', defaultName),
      getPathForFile: dropPaths.getPathForFile
    },
    mp: {
      binariesStatus: () => call('mp:binariesStatus'),
      openResourceDir: () => call('mp:openResourceDir'),
      isElevated: () => call('mp:isElevated'),
      createLobby: (params) => call('mp:createLobby', params),
      joinLobby: (params) => call('mp:joinLobby', params),
      leaveLobby: () => call('mp:leaveLobby'),
      forceStop: () => call('mp:forceStop'),
      getAppState: () => call('mp:getAppState'),
      getLobby: () => call('mp:getLobby'),
      getPlayers: () => call('mp:getPlayers'),
      parseVirtualIp: (text) => call('mp:parseVirtualIp', text),
      openExternal: (url) => call('mp:openExternal', url),
      scanWorlds: () => call('mp:scanWorlds'),
      getWorlds: () => call('mp:getWorlds'),
      getWorldPort: () => call('mp:getWorldPort'),
      setWorldPort: (port) => call('mp:setWorldPort', port),
      getAutoLan: () => call('mp:getAutoLan'),
      setAutoLan: (enabled) => call('mp:setAutoLan', enabled),
      getLanBroadcastCount: () => call('mp:getLanBroadcastCount'),
      openMiniWindow: () => call('mp:openMiniWindow'),
      closeMiniWindow: () => call('mp:closeMiniWindow'),
      miniState: () => call('mp:miniState'),
      miniResize: (width, height) => call('mp:miniResize', width, height),
      onMiniState: subscribe('mp:miniState'),
      onLobbyChanged: subscribe('mp:lobbyChanged'),
      hasMainWindow: () => call('mp:hasMainWindow'),
      sendChat: (content) => call('mp:sendChat', content),
      getMessages: () => call('mp:getMessages'),
      onChat: subscribe('mp:chat'),
      openHudWindow: () => call('mp:openHudWindow'),
      closeHudWindow: () => call('mp:closeHudWindow'),
      onHudState: subscribe('mp:hudState'),
      openDanmakuWindow: () => call('mp:openDanmakuWindow'),
      closeDanmakuWindow: () => call('mp:closeDanmakuWindow'),
      syncOverlays: () => call('mp:syncOverlays'),
      onDanmaku: subscribe('mp:danmaku'),
      danmakuConfig: () => call('mp:danmakuConfig')
    },
    // 这是根 HCMCL 的既有契约；具体原生实现/平台不支持时由后端明确拒绝。
    music: {
      onLyricsState: subscribe('music:lyricsState'),
      lyricsState: () => call('music:lyricsState'),
      lyricsNudge: (direction) => call('music:lyricsNudge', direction)
    },
    hud: { setInteractive: (interactive) => send('hud:setInteractive', interactive) }
  }
  lifecycles.set(api, {
    ready: transport.ready,
    mobileDebug,
    dispose: () => { mobileDebug?.dispose(); dropPaths.dispose(); transport.dispose() }
  })
  return api
}

/** 对手动 create 的实例显式等待原生事件注册。注册失败会拒绝，不能继续启动业务。 */
export function tauriApiReady(api: LauncherApi): Promise<void> {
  const lifecycle = lifecycles.get(api)
  return lifecycle ? lifecycle.ready : Promise.reject(new Error('不是由 createTauriApi 创建的实例'))
}
export function disposeTauriApi(api: LauncherApi): void { lifecycles.get(api)?.dispose() }

/** 只在当前 API 实例的移动页面注册宿主，不添加全局事件或公开业务能力。 */
export function attachTauriMobileDebugHost(api: LauncherApi, host: TauriMobileDebugHost): () => void {
  const controller = lifecycles.get(api)?.mobileDebug
  if (!controller) throw new Error('当前桥接没有移动日志宿主 / 目前橋接沒有行動日誌宿主 / This bridge has no mobile log host')
  return controller.attach(host)
}

/** 独立安装入口：由 Lead 在 React mount 之前调用，不修改现有 preload 或渲染入口。 */
export function installTauriApi(options: TauriBridgeOptions = {}): TauriApiInstallation {
  if (typeof window === 'undefined') throw new Error('Tauri API 只能安装到 Webview 页面')
  if ('api' in window && window.api !== undefined) throw new Error('window.api 已存在，拒绝覆盖其它桥接')
  const previous = Object.getOwnPropertyDescriptor(window, 'api')
  if (previous && !previous.configurable) throw new Error('window.api 不可配置，拒绝安装桥接')
  const api = createTauriApi(options)
  try {
    Object.defineProperty(window, 'api', { value: api, writable: false, enumerable: true, configurable: true })
  } catch (error: unknown) {
    disposeTauriApi(api)
    throw error
  }
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    window.removeEventListener('pagehide', dispose)
    disposeTauriApi(api)
    const installed = Object.getOwnPropertyDescriptor(window, 'api')
    if (installed?.value === api) {
      if (previous) Object.defineProperty(window, 'api', previous)
      else Reflect.deleteProperty(window, 'api')
    }
  }
  window.addEventListener('pagehide', dispose, { once: true })
  const ready = tauriApiReady(api)
  void ready.catch(dispose)
  return { api, ready, dispose }
}

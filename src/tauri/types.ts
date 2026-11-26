import type {
  AiHudState, AiToolRequest, AuthStatus, DebugLogEntry, DevModeStatus, DownloadProgress,
  LaunchEvent, ModEntry, MpChatMessage, MpDanmaku, MpHudState, MpMiniState,
  NeteaseLyricsState, ResourceUpdated, ResourceUpdateEvent
} from '@shared/types'

/** 既有公开方法与必要的 Tauri 内部快照共用固定白名单；内部快照不增加 LauncherApi 方法。 */
export const launcherCallChannels = [
  'app:version', 'app:hardwareAccelerationBooted', 'app:relaunch',
  'debug:getLogs', 'debug:open', 'debug:close', 'debug:isEnabled', 'debug:submit',
  'auth:begin', 'auth:cancel', 'auth:refresh',
  'accounts:list', 'accounts:selected', 'accounts:refreshSiteNames', 'accounts:remove', 'accounts:select',
  'accounts:addOffline', 'accounts:importPreview', 'accounts:importCommit', 'accounts:importCancel',
  'accounts:addYggdrasil', 'accounts:addYggdrasilProfiles', 'yggdrasil:skin',
  'versions:list', 'versions:get', 'versions:createVanilla', 'versions:scanExternal', 'versions:importExternal',
  'installed:list', 'installed:listAll', 'installed:addServer',
  'versionDirs:list', 'versionDirs:add', 'versionDirs:update', 'versionDirs:remove', 'versionDirs:select',
  'loaders:versions', 'loaders:install', 'loaders:installInPlace', 'forge:versions', 'forge:install',
  'resources:list', 'resources:remove', 'resources:open', 'resources:checkUpdates', 'resources:applyUpdate',
  'download:install', 'download:cancel', 'download:engine',
  'mods:search', 'mods:project', 'mods:versions', 'mods:install', 'mods:downloadTo',
  'mods:installFabricApi', 'mods:installOfflineTranslate', 'java:detect', 'java:check', 'java:install', 'java:pick',
  'android:runtimes', 'android:removeRuntime',
  'manage:mods', 'manage:enrichMods', 'manage:enrichResources', 'manage:toggleMod', 'manage:deleteMod', 'manage:installLocalMod', 'manage:installLocalResource',
  'manage:deleteWorld', 'manage:schematics', 'manage:deleteFile', 'manage:deleteVersion', 'manage:renameVersion', 'manage:openDir',
  'launch:start', 'launch:stop', 'settings:get', 'settings:set', 'settings:pickWallpaper', 'settings:clearWallpaper', 'settings:wallpaperData',
  'system:memory', 'system:hardware',
  'homepage:list', 'homepage:read', 'homepage:importFile', 'homepage:download', 'homepage:remove', 'homepage:verify',
  'homepage:hold', 'homepage:release',
  'homepage:confirm', 'homepage:setActive', 'homepage:block', 'homepage:openDir', 'homepage:securityEngine',
  'homepage:market', 'homepage:checkUpdates', 'homepage:update', 'homepage:submit', 'homepage:send-email-code', 'homepage:installNumbered', 'homepage:log',
  'feedback:send-code', 'feedback:submit', 'feedback:list', 'feedback:detail', 'feedback:message', 'feedback:open-file',
  'feedback:withdraw', 'feedback:login', 'feedback:session', 'feedback:logout', 'limits:get',
  'devmode:status', 'devmode:sendCode', 'devmode:verify', 'devmode:setEnabled', 'devmode:revoke', 'devmode:setSecurityMode',
  'devmode:openTools', 'devmode:closeTools', 'devmode:openDevTools', 'devmode:closeDevTools',
  'files:places', 'files:list', 'files:open', 'files:reveal', 'files:rename', 'files:createFile', 'files:remove', 'files:readText', 'files:writeText',
  'modpack:probe', 'modpack:download', 'modpack:import', 'modpack:importFromUrl', 'modpack:exportInventory', 'modpack:export',
  'about:list', 'about:agreement', 'about:agreementStatus', 'announcement:list', 'update:check', 'update:download', 'update:downloadAndRun',
  'ai:chat', 'ai:cancel', 'ai:decideTool', 'ai:analyzeError', 'ai:test', 'ai:setKey', 'ai:clearKey', 'ai:tools', 'ai:reset', 'ai:transcribe',
  'ai:ball:sync', 'ai:ball:expand', 'ai:ball:move', 'ai:ball:position', 'ai:hudState', 'ai:setHudActive', 'ai:setHudStatus',
  'ai:voiceState', // Tauri 固定语音消费者的内部布尔快照；不增加 LauncherApi 方法。
  'translate:texts', 'translate:setKey', 'translate:clearKey', 'minecraft:userinfo', 'minecraft:serverstatus',
  'window:minimize', 'window:maximize', 'window:close', 'window:isMaximized', 'window:setFullscreen', 'window:setAlwaysOnTop',
  'window:setDesktopMode', 'window:securityFullscreen', 'display:primary',
  'shell:openExternal', 'shell:openPath', 'shell:chooseDirectory', 'shell:pickFile', 'shell:pickFiles', 'shell:saveFile',
  'mp:binariesStatus', 'mp:openResourceDir', 'mp:isElevated', 'mp:createLobby', 'mp:joinLobby', 'mp:leaveLobby', 'mp:forceStop',
  'mp:getAppState', 'mp:getLobby', 'mp:getPlayers', 'mp:parseVirtualIp', 'mp:openExternal', 'mp:scanWorlds', 'mp:getWorlds',
  'mp:getWorldPort', 'mp:setWorldPort', 'mp:getAutoLan', 'mp:setAutoLan', 'mp:getLanBroadcastCount',
  'mp:openMiniWindow', 'mp:closeMiniWindow', 'mp:miniState', 'mp:miniResize', 'mp:hasMainWindow', 'mp:sendChat', 'mp:getMessages',
  'mp:miniDrag', // Tauri 迷你窗内部拖动入口；不增加 LauncherApi 方法。
  'mp:openHudWindow', 'mp:closeHudWindow', 'mp:openDanmakuWindow', 'mp:closeDanmakuWindow', 'mp:syncOverlays', 'mp:danmakuConfig',
  'music:lyricsState', 'music:lyricsNudge',
  'mp:hudState' // Tauri 共享 HUD 内部无参投影；不增加 LauncherApi 方法。
] as const
export type LauncherCallChannel = typeof launcherCallChannels[number]

export const launcherSendChannels = ['debug:rendererLog', 'hud:setInteractive'] as const
export type LauncherSendChannel = typeof launcherSendChannels[number]

export interface LauncherEventMap {
  'debug:log': DebugLogEntry
  'auth:status': AuthStatus
  'forge:log': string
  'resources:updated': ResourceUpdated
  'resources:update-checked': ResourceUpdateEvent
  'download:progress': DownloadProgress
  'manage:mods-updated': { versionId: string; mod: ModEntry }
  'launch:event': LaunchEvent
  'homepage:nav-blocked': string
  'devmode:changed': DevModeStatus
  'modpack:progress': DownloadProgress
  'update:progress': DownloadProgress
  'ai:toolRequest': AiToolRequest
  'ai:hudState': AiHudState
  'ai:ballExpanded': boolean
  'ai:voiceToggle': void
  'ai:voiceState': boolean
  'ai:launchRequest': string
  'mp:miniState': MpMiniState
  'mp:lobbyChanged': void
  'mp:chat': MpChatMessage
  'mp:hudState': MpHudState
  'mp:danmaku': MpDanmaku
  'music:lyricsState': NeteaseLyricsState
}
export const launcherEventChannels = [
  'debug:log', 'auth:status', 'forge:log', 'resources:updated', 'resources:update-checked', 'download:progress',
  'manage:mods-updated', 'launch:event', 'homepage:nav-blocked', 'devmode:changed', 'modpack:progress', 'update:progress',
  'ai:toolRequest', 'ai:hudState', 'ai:ballExpanded', 'ai:voiceToggle', 'ai:voiceState', 'ai:launchRequest',
  'mp:miniState', 'mp:lobbyChanged', 'mp:chat', 'mp:hudState', 'mp:danmaku', 'music:lyricsState'
] as const satisfies readonly (keyof LauncherEventMap)[]
export type LauncherEventChannel = keyof LauncherEventMap
export interface LauncherEventEnvelope { channel: LauncherEventChannel; payload: unknown }
export interface TauriBridgeError { operation: string; error: Error }
export interface TauriBridgeOptions {
  /** 平台由可信启动入口提供；未指定时只从当前 Webview 的 UA 检测。 */
  platform?: string
  onError?: (failure: TauriBridgeError) => void
}
export interface TauriApiInstallation {
  api: import('@shared/types').LauncherApi
  /** 业务事件监听完成后才 resolve；拖放路径提示可选，失败由 onError 报告。 */
  ready: Promise<void>
  /** 同步阻止后续回调；尚未返回的原生 unlisten 会在返回后立即执行。 */
  dispose: () => void
}

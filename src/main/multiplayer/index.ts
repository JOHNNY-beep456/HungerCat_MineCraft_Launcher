import { ipcMain, shell, BrowserWindow } from 'electron'
import { checkBinaries, easytierResourceDir } from './resources'
import { parseVirtualIp, isElevated } from './easytier'
import { settings } from '../store'
import type { MpChatMessage } from '@shared/types'
import {
  forceStop,
  getAppState,
  getLobby,
  getMicEnabled,
  getPlayers,
  isGlobalMuted,
  isPlayerMuted,
  joinLobby,
  leaveLobby,
  setGlobalMuted,
  setMicEnabled,
  setPlayerMuted,
  setLobbyChangeListener,
  setSpeakingListener,
  // 消息收发
  sendChatMessage,
  getChatMessages,
  setChatListener,
  // 语音：说话状态（音频本身走下面的 UDP 中继）
  setLocalSpeaking,
  // 局域网桥（让 Minecraft 真正连得上）
  refreshLanWorlds,
  getLanWorlds,
  getLanWorldPort,
  setLanWorldPort,
  getAutoLanEnabled,
  setAutoLanEnabled,
  getLanBroadcastCount,
  type JoinParams
} from './lobby'
// 语音音频中继（经 EasyTier UDP 端口转发，替代依赖直连的 WebRTC）。
import {
  setVoiceRelayListener,
  syncVoiceRelay,
  sendVoiceAudio,
  stopVoiceRelay
} from './voice-relay'

/**
 * 联机板块的主进程入口。
 *
 * 把 MCTier 的 Tauri 命令层（`tauri_commands/session.rs`、`network.rs` 等）映射为
 * Electron 的 `mp:动作` IPC 通道，命名风格与启动器其它域保持一致。
 *
 * 浮层窗口（HUD / 弹幕）与渲染层广播由主进程提供，通过 `hooks` 回调注入，
 * 避免本模块直接依赖 `main/index.ts` 造成循环引用。
 */
export interface MpHostHooks {
  /** 大厅状态变化（成员增减 / 麦克风开关）时刷新悬浮窗与 HUD。 */
  onLobbyChanged?: () => void
  /**
   * 仅「说话状态」变化时的轻量通知（只刷新 HUD 浮层）。
   *
   * 与 onLobbyChanged 分开的原因：说话开/关在交谈中每秒可切换多次，若走全量
   * 刷新（全窗口广播 + 重建悬浮窗快照 + 同步浮层窗口）会造成明显卡顿。
   * 未提供时退化为调用 onLobbyChanged（保持兼容）。
   */
  onSpeakingChanged?: () => void
  /** 打开 / 关闭 HUD 浮层。 */
  openHudWindow?: () => void
  closeHudWindow?: () => void
  /** 打开 / 关闭弹幕窗口。 */
  openDanmakuWindow?: () => void
  closeDanmakuWindow?: () => void
  /** 按当前设置重新同步两个浮层窗口并补推 HUD 状态（设置变更后调用）。 */
  syncOverlays?: () => void
  /** 把一条新消息广播给所有渲染层（主界面 / 悬浮窗）。 */
  broadcastChat?: (msg: MpChatMessage) => void
  /** 把一帧收到的语音音频（来自某成员的 UDP 中继）推给渲染层播放。 */
  broadcastVoiceAudio?: (peerId: string, data: Buffer) => void
}

export function registerMultiplayerIpc(hooks: MpHostHooks = {}): void {
  // 大厅状态变化（含 P2P 发现的成员加入/离开、麦克风开关）时通知主进程刷新悬浮窗与 HUD。
  setLobbyChangeListener(hooks.onLobbyChanged ?? null)
  // 说话状态单独走轻量通道，只刷新 HUD 浮层；未注入时退化为全量刷新。
  setSpeakingListener(hooks.onSpeakingChanged ?? hooks.onLobbyChanged ?? null)

  // 消息收发：新消息 → 广播给渲染层（悬浮窗/主界面据此提示音 + 弹幕）。
  setChatListener((msg) => hooks.broadcastChat?.(msg))
  // 语音音频中继：把收到的 UDP 音频帧推给渲染层解码播放。
  setVoiceRelayListener((peerId: string, data: Buffer) =>
    hooks.broadcastVoiceAudio?.(peerId, data)
  )

  // ---- 资源自检 ----
  ipcMain.handle('mp:binariesStatus', () => checkBinaries())
  ipcMain.handle('mp:openResourceDir', () => shell.openPath(easytierResourceDir()))
  // 是否以管理员运行：创建虚拟网卡必需，提前告知用户而非等超时。
  ipcMain.handle('mp:isElevated', () => isElevated())

  // ---- 大厅生命周期 ----
  ipcMain.handle('mp:createLobby', (_e, params: JoinParams) => joinLobby(params, true))
  ipcMain.handle('mp:joinLobby', (_e, params: JoinParams) => joinLobby(params, false))
  ipcMain.handle('mp:leaveLobby', () => leaveLobby())
  ipcMain.handle('mp:forceStop', () => forceStop())

  // ---- 状态查询 ----
  ipcMain.handle('mp:getAppState', () => getAppState())
  ipcMain.handle('mp:getLobby', () => getLobby())
  ipcMain.handle('mp:getPlayers', () => getPlayers())

  // ---- 消息收发 ----
  ipcMain.handle('mp:sendChat', (_e, content: string) => {
    sendChatMessage(content)
  })
  ipcMain.handle('mp:getMessages', () => getChatMessages())

  // ---- 语音 ----
  ipcMain.handle('mp:setSpeaking', (_e, speaking: boolean) => {
    setLocalSpeaking(speaking)
  })
  // 语音引擎把失败原因上报到这里，再广播给界面显示。
  // 否则「麦克风被拒 / 设备被占用」这类错误只进控制台，用户只看到「语音没反应」。
  ipcMain.handle('mp:reportVoiceError', (_e, message: string) => {
    broadcast('mp:voiceError', String(message ?? '').slice(0, 300))
  })
  // ---- 语音音频中继（经 EasyTier UDP 端口转发）----
  // 同步成员 → 建立/回收每个成员的 UDP 转发；渲染层每次成员变化都会调。
  ipcMain.handle(
    'mp:voiceRelaySync',
    (_e, peers: Array<{ id: string; virtualIp: string }>) => syncVoiceRelay(peers ?? [])
  )
  ipcMain.handle('mp:voiceRelayStop', () => stopVoiceRelay())
  // 渲染层编码好的一帧音频 → 主进程 UDP 发出（不广播，仅发给目标成员）。
  ipcMain.handle('mp:voiceAudio', (_e, peerId: string, data: Uint8Array) => {
    sendVoiceAudio(peerId, Buffer.from(data))
  })

  // ---- 麦克风 / 静音 ----
  ipcMain.handle('mp:setMicEnabled', (_e, enabled: boolean) => {
    setMicEnabled(enabled)
    broadcast('mp:micChanged', enabled)
  })
  ipcMain.handle('mp:getMicEnabled', () => getMicEnabled())
  ipcMain.handle('mp:setGlobalMuted', (_e, muted: boolean) => {
    setGlobalMuted(muted)
    // 广播给渲染层：语音引擎据此静音 / 恢复所有远端播放。
    broadcast('mp:globalMutedChanged', muted)
  })
  ipcMain.handle('mp:getGlobalMuted', () => isGlobalMuted())
  ipcMain.handle('mp:mutePlayer', (_e, playerId: string, muted: boolean) => {
    setPlayerMuted(playerId, muted)
  })
  ipcMain.handle('mp:isPlayerMuted', (_e, playerId: string) => isPlayerMuted(playerId))

  // ---- 工具：解析虚拟 IP（供诊断 / 手动排查）----
  ipcMain.handle('mp:parseVirtualIp', (_e, text: string) => parseVirtualIp(text))

  // ---- 局域网桥：扫描 / 注入 MC 世界，解决「看得到人却连不上」 ----
  ipcMain.handle('mp:scanWorlds', () => refreshLanWorlds())
  ipcMain.handle('mp:getWorlds', () => getLanWorlds())
  ipcMain.handle('mp:getWorldPort', () => getLanWorldPort())
  ipcMain.handle('mp:setWorldPort', async (_e, port: number) => {
    // 设置后立刻重扫并返回最新世界列表：界面无需等 8 秒定时器，
    // 也能马上看到按新端口刷新的「虚拟 IP:端口」。
    setLanWorldPort(port)
    return refreshLanWorlds()
  })
  ipcMain.handle('mp:getAutoLan', () => getAutoLanEnabled())
  ipcMain.handle('mp:setAutoLan', (_e, enabled: boolean) => {
    setAutoLanEnabled(enabled)
    // 关闭自动注入时立刻撤掉已公告的世界；开启则马上重扫。
    void refreshLanWorlds()
  })
  ipcMain.handle('mp:getLanBroadcastCount', () => getLanBroadcastCount())

  // ---- 浮层窗口（HUD / 弹幕）----
  ipcMain.handle('mp:openHudWindow', () => hooks.openHudWindow?.())
  ipcMain.handle('mp:closeHudWindow', () => hooks.closeHudWindow?.())
  ipcMain.handle('mp:openDanmakuWindow', () => hooks.openDanmakuWindow?.())
  ipcMain.handle('mp:closeDanmakuWindow', () => hooks.closeDanmakuWindow?.())
  // 设置里改了 HUD / 弹幕开关后调用：重新同步窗口并补推 HUD 状态。
  ipcMain.handle('mp:syncOverlays', () => hooks.syncOverlays?.())
  ipcMain.handle('mp:danmakuConfig', () => {
    const s = settings.get()
    return {
      enabled: s.multiplayerDanmakuEnabled,
      fontSize: s.multiplayerDanmakuFontSize,
      speed: s.multiplayerDanmakuSpeed,
      opacity: s.multiplayerDanmakuOpacity,
      tracks: s.multiplayerDanmakuTracks
    }
  })

  // ---- 外部链接（MCTier 官网 / 仓库 / 许可）----
  ipcMain.handle('mp:openExternal', (_e, url: string) => shell.openExternal(url))
}

/** 向所有窗口广播联机事件。 */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** 退出启动器时停掉组网，避免残留虚拟网卡（供 will-quit 调用）。 */
export { forceStop as forceStopMultiplayer } from './lobby'

/** 供主进程（悬浮窗 / HUD）读取的大厅状态访问器。 */
export {
  getAppState as getMultiplayerAppState,
  getLobby as getMultiplayerLobby,
  getPlayers as getMultiplayerPlayers,
  getHudPlayers as getMultiplayerHudPlayers
} from './lobby'

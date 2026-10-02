import { ipcMain, shell, BrowserWindow } from 'electron'
import { checkBinaries, easytierResourceDir } from './resources'
import { parseVirtualIp, isElevated } from './easytier'
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
  type JoinParams
} from './lobby'

/**
 * 联机板块的主进程入口。
 *
 * 把 MCTier 的 Tauri 命令层（`tauri_commands/session.rs`、`network.rs` 等）映射为
 * Electron 的 `mp:动作` IPC 通道，命名风格与启动器其它域保持一致。
 */

export function registerMultiplayerIpc(onLobbyChanged?: () => void): void {
  // 大厅状态变化（含 P2P 发现的成员加入/离开）时通知主进程刷新悬浮窗。
  setLobbyChangeListener(onLobbyChanged ?? null)

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

  // ---- 麦克风 / 静音 ----
  ipcMain.handle('mp:setMicEnabled', (_e, enabled: boolean) => {
    setMicEnabled(enabled)
    broadcast('mp:micChanged', enabled)
  })
  ipcMain.handle('mp:getMicEnabled', () => getMicEnabled())
  ipcMain.handle('mp:setGlobalMuted', (_e, muted: boolean) => {
    setGlobalMuted(muted)
  })
  ipcMain.handle('mp:getGlobalMuted', () => isGlobalMuted())
  ipcMain.handle('mp:mutePlayer', (_e, playerId: string, muted: boolean) => {
    setPlayerMuted(playerId, muted)
  })
  ipcMain.handle('mp:isPlayerMuted', (_e, playerId: string) => isPlayerMuted(playerId))

  // ---- 工具：解析虚拟 IP（供诊断 / 手动排查）----
  ipcMain.handle('mp:parseVirtualIp', (_e, text: string) => parseVirtualIp(text))

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

/** 供主进程（悬浮窗）读取的大厅状态访问器。 */
export {
  getAppState as getMultiplayerAppState,
  getLobby as getMultiplayerLobby,
  getPlayers as getMultiplayerPlayers
} from './lobby'

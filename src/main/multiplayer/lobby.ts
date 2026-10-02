import { startEasytier, stopEasytier, isEasytierRunning, type EasyTierSession } from './easytier'
import { P2PSignaling } from './signaling'

/**
 * 大厅状态机。
 *
 * 移植自 MCTier 的 `modules/lobby_manager.rs` + `tauri_commands/session.rs`：
 * 校验输入 → 启动 EasyTier → 记录大厅与玩家状态 → 退出时清理。
 * 原版的玩家列表 / 语音 / 聊天由 WebRTC 信令驱动，这里先保留状态骨架，
 * 供信令层接入后填充。
 */

export interface LobbyPlayer {
  id: string
  name: string
  virtualIp?: string
  virtualDomain?: string
  useDomain?: boolean
  micEnabled: boolean
  isMuted: boolean
  joinedAt: string
  isSelf: boolean
}

export interface Lobby {
  name: string
  password: string
  serverNode: string
  signalingServer: string
  virtualIp: string
  useDomain: boolean
  isHost: boolean
  createdAt: string
}

export type AppState = 'idle' | 'connecting' | 'in-lobby'

/** 校验结果：`null` 表示通过，否则为可读错误。 */
function validateLobbyName(name: string): string | null {
  const t = name.trim()
  if (t.length < 4 || t.length > 32) return '大厅名称需为 4-32 个字符'
  if (!/^[\u4e00-\u9fa5a-zA-Z0-9_\-\s]+$/.test(t)) {
    return '大厅名称只能含中文、字母、数字、下划线、连字符和空格'
  }
  return null
}

/** 密码留空表示无密码；填了则必须 8-32 位且同时含字母和数字。 */
function validatePassword(pwd: string): string | null {
  const p = pwd.trim()
  if (!p) return null
  if (p.length < 8 || p.length > 32 || !/[a-zA-Z]/.test(p) || !/[0-9]/.test(p)) {
    return '密码需为 8-32 位且同时含字母和数字'
  }
  return null
}

function normalizeServerNode(node: string): string {
  const n = node.trim()
  if (!n) return 'udp://us01.225284.xyz:11010'
  if (!/^(tcp|udp|ws|wss|txt):\/\/.+$/.test(n)) return n
  return n
}

interface LobbyState {
  appState: AppState
  lobby: Lobby | null
  players: LobbyPlayer[]
  session: EasyTierSession | null
  micEnabled: boolean
  globalMuted: boolean
}

const state: LobbyState = {
  appState: 'idle',
  lobby: null,
  players: [],
  session: null,
  micEnabled: false,
  globalMuted: false
}

/** P2P 发现与信令（UDP 广播）。 */
const signaling = new P2PSignaling()

/** 状态变化回调：由主进程注册，用于刷新悬浮窗。 */
let changeListener: (() => void) | null = null

/** 注册状态变化监听（悬浮窗据此刷新）。 */
export function setLobbyChangeListener(fn: (() => void) | null): void {
  changeListener = fn
}

/** 通知状态变化（失败不影响主流程）。 */
function notify(): void {
  try {
    changeListener?.()
  } catch {
    /* 忽略监听器异常 */
  }
}

export interface JoinParams {
  name: string
  password: string
  playerName: string
  playerId: string
  serverNode: string
  signalingServer: string
  useDomain?: boolean
}

function selfPlayer(name: string, id: string, virtualIp: string, useDomain: boolean): LobbyPlayer {
  const domain = useDomain ? `${id.slice(0, 8)}.mct.net` : undefined
  return {
    id,
    name,
    virtualIp,
    virtualDomain: domain,
    useDomain,
    micEnabled: false,
    isMuted: false,
    joinedAt: new Date().toISOString(),
    isSelf: true
  }
}

/**
 * 创建或加入大厅。
 * @param isHost 创建者为房主。
 */
export async function joinLobby(params: JoinParams, isHost: boolean): Promise<Lobby> {
  const nameErr = validateLobbyName(params.name)
  if (nameErr) throw new Error(nameErr)
  const pwdErr = validatePassword(params.password)
  if (pwdErr) throw new Error(pwdErr)
  if (!params.playerName.trim()) throw new Error('请输入玩家名称')
  if (params.playerName.trim().length > 8) throw new Error('玩家名称最多 8 个字符')

  if (state.appState !== 'idle') await leaveLobby()

  state.appState = 'connecting'
  try {
    const session = await startEasytier({
      lobbyName: params.name.trim(),
      password: params.password.trim(),
      serverNode: normalizeServerNode(params.serverNode),
      hostname: params.playerName.trim(),
      useDomain: params.useDomain
    })

    const lobby: Lobby = {
      name: params.name.trim(),
      password: params.password.trim(),
      serverNode: normalizeServerNode(params.serverNode),
      signalingServer: params.signalingServer.trim() || 'wss://mctier.pmhs.top/signaling',
      virtualIp: session.virtualIp,
      useDomain: params.useDomain === true,
      isHost,
      createdAt: new Date().toISOString()
    }

    state.lobby = lobby
    state.session = session
    state.players = [
      selfPlayer(params.playerName.trim(), params.playerId, session.virtualIp, lobby.useDomain)
    ]
    state.appState = 'in-lobby'

    // 组网就绪后启动 P2P 发现：同大厅成员会通过 UDP 广播互相发现，
    // 并各自补全虚拟 IP（无 TUN 模式下虚拟 IP 不在系统网卡上，只能靠信令交换）。
    try {
      await signaling.start(params.playerId, params.playerName.trim(), session.virtualIp, {
        onPlayerJoined: (peer) => {
          // 成员加入：登记其虚拟 IP（发现报文里已带上，无 TUN 模式下只能靠信令交换）。
          state.players.push({
            id: peer.playerId,
            name: peer.playerName,
            virtualIp: peer.virtualIp || undefined,
            micEnabled: false,
            isMuted: false,
            joinedAt: new Date().toISOString(),
            isSelf: false
          })
          notify()
          // 回一次自己的状态，让对方也能同步我的麦克风。
          signaling.broadcastStatus(state.micEnabled)
        },
        onPeerUpdated: (peer) => {
          // 虚拟 IP 后到（例如先收到心跳、后发现报文）：补齐并刷新。
          const p = state.players.find((x) => x.id === peer.playerId)
          if (p && peer.virtualIp && p.virtualIp !== peer.virtualIp) {
            p.virtualIp = peer.virtualIp
            notify()
          }
        },
        onPlayerLeft: (playerId) => {
          state.players = state.players.filter((p) => p.id !== playerId)
          notify()
        },
        onStatusUpdate: (playerId, micEnabled) => {
          const p = state.players.find((x) => x.id === playerId)
          if (p) {
            p.micEnabled = micEnabled
            notify()
          }
        }
      })
    } catch (err) {
      // 发现服务失败不应阻断组网：仍可手动用虚拟 IP 连接。
      console.warn('[联机] P2P 发现服务启动失败：', err)
    }

    notify()
    return lobby
  } catch (err) {
    state.appState = 'idle'
    state.lobby = null
    state.session = null
    state.players = []
    throw err
  }
}

/** 退出大厅并释放组网资源（幂等）。 */
export async function leaveLobby(): Promise<void> {
  state.appState = 'connecting'
  try {
    // 先停信令：它会广播 player-left，让同大厅成员立即移除自己。
    await signaling.stop()
    await stopEasytier()
  } finally {
    state.lobby = null
    state.session = null
    state.players = []
    state.micEnabled = false
    state.appState = 'idle'
    notify()
  }
}

/** 兜底：强制停掉可能残留的组网（应用启动 / 退出时调用）。 */
export async function forceStop(): Promise<void> {
  await signaling.stop().catch(() => undefined)
  if (isEasytierRunning()) await stopEasytier()
  state.lobby = null
  state.session = null
  state.players = []
  state.appState = 'idle'
  notify()
}

export function getAppState(): AppState {
  return state.appState
}

export function getLobby(): Lobby | null {
  return state.lobby
}

export function getPlayers(): LobbyPlayer[] {
  return state.players
}

export function setMicEnabled(enabled: boolean): void {
  state.micEnabled = enabled
  const self = state.players.find((p) => p.isSelf)
  if (self) self.micEnabled = enabled
  // 广播给同大厅成员，让对方的成员列表同步麦克风状态。
  signaling.broadcastStatus(enabled)
  notify()
}

export function getMicEnabled(): boolean {
  return state.micEnabled
}

export function setGlobalMuted(muted: boolean): void {
  state.globalMuted = muted
}

export function isGlobalMuted(): boolean {
  return state.globalMuted
}

export function setPlayerMuted(playerId: string, muted: boolean): void {
  const p = state.players.find((x) => x.id === playerId)
  if (p) p.isMuted = muted
}

export function isPlayerMuted(playerId: string): boolean {
  return state.players.find((p) => p.id === playerId)?.isMuted ?? false
}

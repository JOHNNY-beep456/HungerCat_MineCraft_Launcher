import {
  startEasytier,
  stopEasytier,
  isEasytierRunning,
  listEasyTierPeers,
  ensurePortForward,
  portForwardBindFor,
  retainPortForwards,
  type EasyTierSession
} from './easytier'
import { P2PSignaling, SIGNALING_PORT } from './signaling'
// 语音音频中继（经 EasyTier UDP 端口转发），退出大厅时需一并停止。
import { stopVoiceRelay } from './voice-relay'
import {
  startLanBroadcast,
  stopLanBroadcast,
  scanLanWorlds,
  lanBroadcastCount,
  proxyAddressFor,
  type LanWorld,
  type ScanTarget,
  type BridgeTarget
} from './lan-bridge'
import type { MpChatMessage, MpHudPlayer } from '@shared/types'

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
  /** 当前是否正在说话（本机音量检测 / 他人 voice-state 报文）。 */
  speaking?: boolean
  /**
   * 语音 / 身份的唯一键（由玩家名规整得到，各端结果一致）。
   *
   * 为什么不能直接用 `id`：同一个成员可能经两条路径进入名单 —— 信令发现
   * （`id` = 对方 playerId）与 EasyTier 路由表（`id` = `et-ip:10.126.126.x`），
   * 于是同一个人会带两个互不相干的 `id`。语音建连要求「本端记录的对方 id」
   * 与「对方发来的 from」完全一致，用 `id` 会导致永不匹配、语音打不通；
   * 成员列表也会因此把一个人显示成两个。
   *
   * `voiceId` 取「规整后的玩家名」，是各端都能独立算出、且完全一致的键，
   * 语音寻址与成员去重统一以它为准。
   */
  voiceId?: string
  /**
   * 该成员是否仅由 EasyTier 路由表发现（跨局域网来源，见 syncEasyTierPeers）。
   *
   * 用于区分「谁负责清理」：局域网 UDP 发现的成员由信令层的心跳超时清理；
   * 仅由路由表发现的成员则随路由表消失而移除。内部字段，不参与界面展示。
   */
  viaEasyTier?: boolean
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

/**
 * 「说话状态」变化的轻量回调。
 *
 * 为什么单独拆出来：说话开/关在一次对话里可能每秒切换多次，而 notify() 会触发
 * 全窗口广播 + 重建悬浮窗快照 + 同步浮层窗口（甚至创建/关闭系统窗口），代价很高。
 * 说话状态只影响 HUD 浮层上的小圆点，因此单独走这条轻量通道，只推 HUD 状态。
 */
let speakingListener: (() => void) | null = null

/** 注册状态变化监听（悬浮窗据此刷新）。 */
export function setLobbyChangeListener(fn: (() => void) | null): void {
  changeListener = fn
}

/** 注册「说话状态」轻量监听（只刷新 HUD 浮层）。 */
export function setSpeakingListener(fn: (() => void) | null): void {
  speakingListener = fn
}

/** 通知状态变化（失败不影响主流程）。 */
function notify(): void {
  try {
    changeListener?.()
  } catch {
    /* 忽略监听器异常 */
  }
}

/** 通知「说话状态」变化：只走轻量通道，不触发全窗口广播。 */
function notifySpeaking(): void {
  try {
    speakingListener?.()
  } catch {
    /* 忽略监听器异常 */
  }
}

/* ------------------------------------------------------------------ */
/* 跨局域网成员同步（EasyTier 路由表）                                  */
/* ------------------------------------------------------------------ */

/** 路由表轮询间隔：3 秒，兼顾实时性与 CLI 进程开销。 */
const PEER_POLL_MS = 3_000

/**
 * 刚离开成员的名字键 / 虚拟 IP → 离开时间。
 *
 * 为什么需要：成员退出后，EasyTier 路由表要过几秒才收敛，期间 `syncEasyTierPeers`
 * 仍可能把这个人按路由表重新加回来（表现为「刚退出的成员又冒出来、列表闪一下」）。
 * 用这个抑制窗口挡住「离开后短时间内被重新发现」，窗口过后不再拦截，正常重连不受影响。
 */
const recentlyLeft = new Map<string, number>()
const LEFT_SUPPRESS_MS = 8_000

/** 判断某个名字键 / 虚拟 IP 是否处于「刚离开」的抑制窗口内（过期即顺带清理）。 */
function isRecentlyLeft(key: string, now: number): boolean {
  const at = recentlyLeft.get(key)
  if (at === undefined) return false
  if (now - at > LEFT_SUPPRESS_MS) {
    recentlyLeft.delete(key)
    return false
  }
  return true
}

let peerPollTimer: ReturnType<typeof setInterval> | null = null

/** 归一化名字用于比对：EasyTier 会把 hostname 转小写并去除非字母数字字符。 */
function normName(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/**
 * 语音 / 成员去重的唯一键（各端一致）。
 *
 * 取「规整后的玩家名」并兜底：空名时退回 `anon`，避免空键导致所有匿名成员互相合并。
 * 之所以用它而不是 playerId：playerId 由各端各自生成、互不相同，且同一成员还会
 * 因「信令发现 / 路由表发现」两条来源而带不同 id；只有由玩家名推导的键才能跨端统一。
 */
function voiceKey(name: string): string {
  return normName(name) || 'anon'
}

function stopPeerPolling(): void {
  if (peerPollTimer) {
    clearInterval(peerPollTimer)
    peerPollTimer = null
  }
}

function startPeerPolling(): void {
  stopPeerPolling()
  void syncEasyTierPeers()
  peerPollTimer = setInterval(() => void syncEasyTierPeers(), PEER_POLL_MS)
}

/**
 * 用 EasyTier 路由表同步成员，解决「跨局域网发现不到人」的问题。
 *
 * 局域网 UDP 广播在 `--no-tun` 模式下无法穿过 overlay，因此不在同一物理网络的成员
 * 永远发现不了彼此。EasyTier 的路由表（`easytier-cli route`）由核心自己维护，包含
 * 网络内所有节点，与成员身处哪个网络无关，是跨网络成员发现的权威来源。
 *
 * 与 LAN 发现的关系：两者互为补充、去重合并。
 *   - 已在名单里的成员（无论来源）只补齐缺失的虚拟 IP，不重复添加；
 *   - 仅由路由表发现的成员标记 viaEasyTier，路由表里消失时移除；
 *   - 局域网发现的成员仍由信令层的心跳超时负责清理。
 */
async function syncEasyTierPeers(): Promise<void> {
  const session = state.session
  if (state.appState !== 'in-lobby' || !session) return

  let route: Awaited<ReturnType<typeof listEasyTierPeers>>
  try {
    route = await listEasyTierPeers()
  } catch {
    return // 本轮查询失败（RPC 未就绪 / CLI 缺失），忽略即可
  }
  // 路由表为空说明核心尚未建立拓扑，此时不做任何删除，避免把成员误清空。
  if (route.length === 0) return
  // 会话可能在 await 期间已退出。
  if (state.session !== session) return

  const selfIp = session.virtualIp
  const selfHost = normName(session.hostname)

  // 顺带清理过期的「刚离开」抑制记录，避免 Map 无限增长。
  const now = Date.now()
  for (const [k, t] of recentlyLeft) {
    if (now - t > LEFT_SUPPRESS_MS) recentlyLeft.delete(k)
  }

  const seen = new Set<string>()
  const incoming: Array<{ key: string; name: string; ip?: string }> = []
  for (const p of route) {
    const ip = p.ipv4.trim()
    const host = p.hostname.trim()
    if (!ip && !host) continue
    if (ip && ip === selfIp) continue
    if (host && normName(host) === selfHost) continue
    const key = ip ? `ip:${ip}` : `name:${normName(host)}`
    if (seen.has(key)) continue
    seen.add(key)
    incoming.push({ key, name: host || ip, ip: ip || undefined })
  }

  // 为每个成员建立「本地 UDP 转发 → 其虚拟 IP 的发现端口」，并把本地口注入信令层。
  //
  // 为什么必须转发：`--no-tun` 下系统没有 10.126.126.0/24 的路由，往虚拟 IP 直接
  // 发 UDP 会被静默丢弃。EasyTier 的 port-forward 是官方给定的通达方式：
  //   127.0.0.1:<本地口>  →  <成员虚拟IP>:<发现端口>
  // 信令层随后只需往这些本地口收发，即可经 overlay 送达对端，
  // 发现 / 心跳 / 聊天 / 语音因此恢复可用。
  const targets: string[] = []
  for (const inc of incoming) {
    if (!inc.ip) continue
    const bind = await ensurePortForward('udp', inc.ip, SIGNALING_PORT)
    if (bind) targets.push(bind)
  }
  signaling.setReachableTargets(targets)

  let changed = false

  // 1) 新增缺失成员 / 为已有成员补齐虚拟 IP。
  //
  // 关键：合并判定必须同时看 **虚拟 IP** 与 **voiceId（规整玩家名）**。
  // 同一成员常常先由信令发现（`id` = playerId、name = 显示名），随后又出现在
  // 路由表里（hostname = 规整名）——若只按 name 精确比对，会把同一个人再加一遍，
  // 表现为「房员看到两个房主」。这里的 `existing` 查找覆盖两种来源。
  for (const inc of incoming) {
    const incKey = voiceKey(inc.name)
    // 刚离开（在抑制窗口内）的成员不重新加入：路由表尚未收敛时会把已退出的人再列出来。
    if (isRecentlyLeft(`n:${incKey}`, now) || (inc.ip ? isRecentlyLeft(`i:${inc.ip}`, now) : false)) {
      continue
    }
    const existing = state.players.find(
      (pl) =>
        (inc.ip !== undefined && pl.virtualIp === inc.ip) ||
        (pl.isSelf && pl.virtualIp === inc.ip) ||
        voiceKey(pl.name) === incKey
    )
    if (existing) {
      if (inc.ip && !existing.virtualIp) {
        existing.virtualIp = inc.ip
        changed = true
      }
      // 补齐 voiceId（老成员可能是早期创建、还没写入该字段）。
      if (!existing.voiceId) {
        existing.voiceId = voiceKey(existing.name)
        changed = true
      }
      continue
    }
    state.players.push({
      id: `et-${inc.key}`,
      name: inc.name,
      virtualIp: inc.ip,
      voiceId: incKey,
      micEnabled: false,
      isMuted: false,
      joinedAt: new Date().toISOString(),
      isSelf: false,
      viaEasyTier: true
    })
    changed = true
  }

  // 2) 移除已从路由表消失、且仅由路由表发现的成员（局域网来源交给心跳超时清理）。
  const before = state.players.length
  state.players = state.players.filter((pl) => {
    if (pl.isSelf || !pl.viaEasyTier) return true
    const key = pl.virtualIp ? `ip:${pl.virtualIp}` : `name:${normName(pl.name)}`
    return seen.has(key)
  })
  if (state.players.length !== before) changed = true

  // 3) 兜底去重：按 voiceId 合并重复条目。
  //
  // 万一成员先以「信令发现」和「路由表发现」两条独立路径同时进入，仍可能留下两条
  // voiceId 相同的记录。这里做一次最终合并：保留信息更全的一条（优先有虚拟 IP 的、
  // 非 viaEasyTier 的），从而彻底消除「两个房主 / 同一个人的两条记录」。
  const merged = new Map<string, LobbyPlayer>()
  for (const pl of state.players) {
    if (pl.isSelf) continue
    const key = pl.voiceId || voiceKey(pl.name)
    const prev = merged.get(key)
    if (!prev) {
      merged.set(key, pl)
      continue
    }
    // 选择保留项：有虚拟 IP 优先；其次优先信令来源（信息更全）。
    const preferNew =
      (!prev.virtualIp && pl.virtualIp) ||
      (!!prev.virtualIp === !!pl.virtualIp && prev.viaEasyTier === true && pl.viaEasyTier !== true)
    if (preferNew) merged.set(key, pl)
    changed = true
  }
  if (changed) {
    const selfPlayers = state.players.filter((pl) => pl.isSelf)
    const deduped = [...selfPlayers, ...merged.values()]
    if (deduped.length !== state.players.length) {
      state.players = deduped
    }
  }

  if (changed) notify()
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

/**
 * 虚拟域名根：开启「虚拟域名」后，成员会在局域网内以此后缀互相寻址。
 * 与 EasyTier 的 Magic DNS（--tld-dns-zone）配合使用。
 */
export const VIRTUAL_DOMAIN_SUFFIX = 'mct.net'

/** 把大厅名规整成可作为 DNS 标签的一段：小写、只留字母数字与连字符。 */
export function lobbyDomainLabel(lobbyName: string): string {
  const label = lobbyName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return label || 'lobby'
}

/** 由玩家名生成主机名标签：小写、只留字母数字与连字符（与 EasyTier hostname 规则一致）。 */
export function playerDomainLabel(playerName: string): string {
  const label = playerName
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return label || 'player'
}

/**
 * 计算某个成员在「虚拟域名」下应显示的完整域名，形如 `steve.my-lobby.mct.net`。
 *
 * 设计要点：**主机名 + 大厅名** 组合，而不是随机 id 前缀。这样：
 *   - 所有成员看到的大厅后缀一致，同一大厅内互相寻址可预期；
 *   - 每个成员的主机名取自玩家名，便于在 MC「直接连接」里直接输入；
 *   - 与 EasyTier 的 `--hostname` 保持同源，便于 Magic DNS 解析。
 */
export function playerVirtualDomain(
  playerName: string,
  lobbyName: string,
  enabled: boolean
): string | undefined {
  if (!enabled) return undefined
  return `${playerDomainLabel(playerName)}.${lobbyDomainLabel(lobbyName)}.${VIRTUAL_DOMAIN_SUFFIX}`
}

function selfPlayer(
  name: string,
  id: string,
  virtualIp: string,
  useDomain: boolean,
  lobbyName: string
): LobbyPlayer {
  return {
    id,
    name,
    virtualIp,
    virtualDomain: playerVirtualDomain(name, lobbyName, useDomain),
    useDomain,
    voiceId: voiceKey(name),
    micEnabled: false,
    isMuted: false,
    joinedAt: new Date().toISOString(),
    isSelf: true
  }
}

/* ------------------------------------------------------------------ */
/* 局域网桥：让 Minecraft 真正能连上其他成员                             */
/* ------------------------------------------------------------------ */

/** 作为「世界端口」参与扫描 / 广播的端口。MC 默认 25565，「对局域网开放」常是随机值。 */
let worldPort = 25565
/** 是否自动把扫描到的世界注入本机 MC 的局域网列表。 */
let autoLanEnabled = true

/** 供界面展示的最近一次扫描结果。 */
let lastWorlds: LanWorld[] = []
let worldScanTimer: ReturnType<typeof setInterval> | null = null

/**
 * 修改「世界端口」。
 *
 * 除了记录值，还必须**立刻重扫**：否则界面上的世界列表（含各成员的「虚拟 IP:端口」）
 * 要等下一个 8 秒定时器才刷新，用户会以为「改了端口没生效」。重扫时 `refreshLanWorlds`
 * 会按新端口重建 TCP 转发并清理旧转发（见 retainPortForwards）。
 */
export function setLanWorldPort(port: number): void {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return
  const changed = worldPort !== port
  worldPort = port
  if (changed && state.appState === 'in-lobby') void refreshLanWorlds()
}

export function getLanWorldPort(): number {
  return worldPort
}

export function setAutoLanEnabled(enabled: boolean): void {
  autoLanEnabled = enabled
}

export function getAutoLanEnabled(): boolean {
  return autoLanEnabled
}

/**
 * 待扫描 / 广播的目标：所有成员的虚拟 IP（含自己，自己的世界也要能被别人扫到）。
 */
function collectWorldTargets(): Array<{ ip: string; name: string }> {
  const out: Array<{ ip: string; name: string }> = []
  for (const p of state.players) {
    if (p.virtualIp) out.push({ ip: p.virtualIp, name: p.name })
  }
  return out
}

/**
 * 生成一批候选世界端口。
 *
 * 为什么要扫一批而不是单一端口：Minecraft「对局域网开放」默认会**随机**选一个
 * 端口（每次开世界都可能不同），我们无法预先得知房主用的是哪个。只扫 25565
 * 时，只要房主不是用 25565，就会「暂未发现世界」——这正是用户遇到的问题。
 *
 * 策略（与 MCTier 的端口探测一致）：
 *   1. 用户配置的端口（默认 25565）与 MC 专用服务器默认端口优先；
 *   2. 再覆盖 Minecraft 常见的局域网随机端口段 50000-50020。
 * 端口数量有限（约 25 个），每轮并发 SLP 探测，代价可接受。
 */
function candidateWorldPorts(): number[] {
  const ports = new Set<number>([worldPort, 25565])
  // MC 客户端「对局域网开放」实测多落在 50000 附近的一段随机端口。
  for (let p = 50000; p <= 50020; p++) ports.add(p)
  return [...ports].filter((p) => Number.isInteger(p) && p > 0 && p <= 65535)
}

/**
 * 扫描一次大厅内的 MC 世界并（可选）注入本机局域网列表。
 *
 * 这一步是「能看到名字却联不上机」的修复核心：成员列表只证明**组网通了**，
 * 并不代表 Minecraft 知道对方开没开世界。这里用 SLP 并发探测每个虚拟 IP 的
 * 候选端口，把活着的世界通过本地代理 + 伪组播公告注入，玩家在 MC 里点一下即可进。
 */
export async function refreshLanWorlds(): Promise<LanWorld[]> {
  if (state.appState !== 'in-lobby') return []
  const targets = collectWorldTargets()
  const ports = candidateWorldPorts()
  // 每个成员的虚拟 IP × 每个候选端口，都先建立一条 TCP 转发：
  //   127.0.0.1:<本地口>  →  <成员虚拟IP>:<候选端口>
  // 因为 `--no-tun` 下系统没有虚拟网段路由，直接连虚拟 IP 会被丢弃；
  // 只有经转发的本地口才能真正探测到对方的世界。
  const probes: ScanTarget[] = []
  // 记录本轮需要的 TCP 转发目标，扫描后据此清理旧端口遗留的转发
  // （否则每改一次世界端口就多一批永不回收的规则，表现为改动不生效）。
  const keepDsts = new Set<string>()
  for (const t of targets) {
    for (const port of ports) {
      const bind = await ensurePortForward('tcp', t.ip, port)
      if (!bind) continue
      keepDsts.add(`${t.ip}:${port}`)
      const [host, portStr] = bind.split(':')
      // displayPort 传**真实世界端口**（候选口就是世界口），displayIp 传虚拟 IP：
      // 探测走的是本地转发口，但世界列表与代理必须拿到 `虚拟IP:真实端口`，
      // 否则代理会按 `<虚拟IP>:<本机转发口>` 拨号 —— 这就是连接超时的根因。
      probes.push({ host, port: Number(portStr), displayIp: t.ip, displayPort: port })
    }
  }
  const worlds = await scanLanWorlds(probes, worldPort)
  lastWorlds = worlds
  // 无论是否开启「自动注入」，都为探测到的世界建立本地代理：
  //   - 这样 proxyAddressFor 才能给出**可连接的** 127.0.0.1:代理口；
  //   - 没有代理时，世界列表里的虚拟 IP 直连必然失败（--no-tun 无路由）。
  // 是否打扰本机 MC（发伪组播公告）由 autoLanEnabled 决定。
  const selfIp = state.session?.virtualIp
  const bridgeTargets: BridgeTarget[] = []
  for (const w of worlds) {
    if (w.ip === selfIp) continue
    // 世界连接要经 TCP 转发取一条本地可达口作为代理的上游。
    const bind = await ensurePortForward('tcp', w.ip, w.port)
    if (!bind) continue
    keepDsts.add(`${w.ip}:${w.port}`)
    const [host, portStr] = bind.split(':')
    const worldIp = w.ip
    const targetPort = w.port
    bridgeTargets.push({
      ip: w.ip,
      port: w.port,
      motd: worldNameFor(w.ip) ?? w.motd,
      connectHost: host,
      connectPort: Number(portStr),
      // 每次连接现场解析上游口：转发被重建导致本地口变化时，代理仍能拨到新口，
      // 避免「代理还在、上游口失效」造成的 Connection refused。
      resolveUpstream: () => {
        const current = portForwardBindFor('tcp', worldIp, targetPort)
        if (!current) return null
        const [h, p] = current.split(':')
        const port = Number(p)
        return h && port > 0 ? { host: h, port } : null
      }
    })
  }
  try {
    await startLanBroadcast(bridgeTargets, autoLanEnabled)
  } catch (err) {
    console.warn('[联机] 注入局域网世界失败：', err)
  }
  // 清理本轮不再需要的 TCP 转发（旧端口 / 已离线成员的残留）。
  await retainPortForwards('tcp', keepDsts).catch(() => undefined)
  // 附上「可连接地址」：虚拟 IP 在 --no-tun 下不可路由，只有本地代理口能进世界。
  // 世界列表据此展示 / 复制，否则用户复制 ip:port 直连必然连不上。
  for (const w of lastWorlds) {
    const proxy = proxyAddressFor(w.ip, w.port)
    if (proxy) {
      w.connectHost = proxy.host
      w.connectPort = proxy.port
    }
  }
  notify()
  return worlds
}

/** 用虚拟 IP 反查玩家名（用于世界 MOTD 展示）。 */
function worldNameFor(ip: string): string | undefined {
  return state.players.find((p) => p.virtualIp === ip)?.name
}

export function getLanWorlds(): LanWorld[] {
  return lastWorlds
}

export function getLanBroadcastCount(): number {
  return lanBroadcastCount()
}

function startWorldScanning(): void {
  stopWorldScanning()
  void refreshLanWorlds()
  // 8 秒一轮：与 MCTier 一致。世界可能晚于组网才开放，必须持续发现。
  worldScanTimer = setInterval(() => void refreshLanWorlds(), 8_000)
}

function stopWorldScanning(): void {
  if (worldScanTimer) {
    clearInterval(worldScanTimer)
    worldScanTimer = null
  }
  stopLanBroadcast()
  lastWorlds = []
}

/* ------------------------------------------------------------------ */
/* 消息收发（聊天）                                                     */
/* ------------------------------------------------------------------ */

/** 聊天记录上限：只在内存里保留最近这些条，退出大厅即清空。 */
const MAX_MESSAGES = 300
let messages: MpChatMessage[] = []

/** 新消息回调：由主进程注册，用于推送到各界面与弹幕窗口。 */
let chatListener: ((msg: MpChatMessage) => void) | null = null
export function setChatListener(fn: ((msg: MpChatMessage) => void) | null): void {
  chatListener = fn
}

export function getChatMessages(): MpChatMessage[] {
  return messages
}

/** 追加一条消息（去重 + 截断），并通知监听者。 */
function pushMessage(msg: MpChatMessage): void {
  if (messages.some((m) => m.id === msg.id)) return
  messages.push(msg)
  if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES)
  try {
    chatListener?.(msg)
  } catch {
    /* 监听器异常不影响主流程 */
  }
}

/**
 * 发送一条聊天消息。
 * 空消息直接忽略；本地先回显自己的一条（`isSelf=true`），再广播给所有成员。
 */
export function sendChatMessage(content: string): void {
  const text = content.trim()
  if (!text) return
  if (state.appState !== 'in-lobby') throw new Error('尚未加入大厅')
  const self = state.players.find((p) => p.isSelf)
  const playerId = state.session?.hostname ?? self?.id ?? 'self'
  // 先广播，拿到稳定的 msgId 再据此构造本地回显 —— 本地与远端用同一 id，
  // 语义上是同一条消息，也便于排查重复。
  const msgId = signaling.broadcastChat(text)
  const msg: MpChatMessage = {
    id: msgId,
    playerId: self?.id ?? playerId,
    playerName: self?.name ?? '我',
    content: text,
    timestamp: Date.now(),
    isSelf: true
  }
  pushMessage(msg)
}

/* ------------------------------------------------------------------ */
/* 语音：说话状态                                                        */
/* ------------------------------------------------------------------ */
// 音频传输已改走 EasyTier UDP 端口转发（见 voice-relay.ts），不再有 WebRTC 信令。

/**
 * 上报本机的说话状态（渲染层音量检测得到）并广播。
 *
 * 本机在成员列表里直接更新，无需等回报；他人则通过 voice-state 报文驱动。
 */
export function setLocalSpeaking(speaking: boolean): void {
  const self = state.players.find((p) => p.isSelf)
  if (!self) return
  if (self.speaking === speaking) return
  self.speaking = speaking
  signaling.broadcastVoiceState(state.micEnabled, speaking)
  // 只刷新 HUD 浮层：说话状态不影响成员列表 / 大厅信息，无需全窗口广播。
  notifySpeaking()
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
      selfPlayer(
        params.playerName.trim(),
        params.playerId,
        session.virtualIp,
        lobby.useDomain,
        lobby.name
      )
    ]
    // 新会话：清空上一厅的聊天记录与「刚离开」抑制记录。
    messages = []
    recentlyLeft.clear()
    state.appState = 'in-lobby'

    // 组网就绪后启动 P2P 发现：同大厅成员会通过 UDP 广播互相发现，
    // 并各自补全虚拟 IP（无 TUN 模式下虚拟 IP 不在系统网卡上，只能靠信令交换）。
    try {
      await signaling.start(params.playerId, params.playerName.trim(), session.virtualIp, {
        onPlayerJoined: (peer) => {
          // 成员加入：登记其虚拟 IP（发现报文里已带上，无 TUN 模式下只能靠信令交换）。
          //
          // 该成员可能已由 EasyTier 路由表先一步发现（`et-*` 条目）。此时必须**合并**
          // 而不是再 push 一条，否则同一个人会出现两条记录（房员看房主就变成两个房主）。
          const key = voiceKey(peer.playerName)
          // 该成员（重新）出现：清掉「刚离开」抑制，避免正常重连被误挡。
          recentlyLeft.delete(`n:${key}`)
          if (peer.virtualIp) recentlyLeft.delete(`i:${peer.virtualIp}`)
          const existing = state.players.find(
            (p) =>
              p.id === peer.playerId ||
              (peer.virtualIp && p.virtualIp === peer.virtualIp) ||
              voiceKey(p.name) === key
          )
          if (existing) {
            // 用信令来源补齐信息（信令的 playerName 是原始显示名，更准确）。
            existing.id = peer.playerId
            existing.name = peer.playerName
            if (peer.virtualIp) existing.virtualIp = peer.virtualIp
            existing.voiceId = key
            existing.viaEasyTier = false
            if (!existing.virtualDomain) {
              existing.virtualDomain = playerVirtualDomain(peer.playerName, lobby.name, lobby.useDomain)
            }
          } else {
            state.players.push({
              id: peer.playerId,
              name: peer.playerName,
              virtualIp: peer.virtualIp || undefined,
              // 虚拟域名按「同一大厅规则」由玩家名现算，保证各端一致。
              virtualDomain: playerVirtualDomain(peer.playerName, lobby.name, lobby.useDomain),
              useDomain: lobby.useDomain,
              voiceId: key,
              micEnabled: false,
              isMuted: false,
              joinedAt: new Date().toISOString(),
              isSelf: false
            })
          }
          notify()
          // 回一次自己的状态，让对方也能同步我的麦克风。
          signaling.broadcastStatus(state.micEnabled)
        },
        onPeerUpdated: (peer) => {
          // 虚拟 IP 后到（例如先收到心跳、后发现报文）：补齐并刷新。
          const p = state.players.find((x) => x.id === peer.playerId)
          if (p && peer.virtualIp && p.virtualIp !== peer.virtualIp) {
            p.virtualIp = peer.virtualIp
            if (!p.virtualDomain) {
              p.virtualDomain = playerVirtualDomain(p.name, lobby.name, lobby.useDomain)
            }
            notify()
          }
        },
        onPlayerLeft: (peer) => {
          // 记录「刚离开」，挡住路由表收敛期间把此人重新加回来造成的列表闪烁。
          const nameKey = peer.playerName ? voiceKey(peer.playerName) : ''
          const at = Date.now()
          if (nameKey) recentlyLeft.set(`n:${nameKey}`, at)
          if (peer.virtualIp) recentlyLeft.set(`i:${peer.virtualIp}`, at)
          // 按三种键清理：id（信令来源）、虚拟 IP、名字。同一个人可能同时存在
          // 「信令来源」和「EasyTier 路由表来源」两条记录，只按 id 删会漏掉另一条，
          // 这正是「有人退出后成员列表还留着他」的直接原因。
          const before = state.players.length
          state.players = state.players.filter(
            (p) =>
              p.isSelf ||
              (p.id !== peer.playerId &&
                !(peer.virtualIp && p.virtualIp === peer.virtualIp) &&
                !(nameKey && voiceKey(p.name) === nameKey))
          )
          if (state.players.length !== before) notify()
        },
        onStatusUpdate: (playerId, micEnabled) => {
          const p = state.players.find((x) => x.id === playerId)
          if (p) {
            p.micEnabled = micEnabled
            notify()
          }
        },
        onVoiceState: (playerId, micEnabled, speaking) => {
          const p = state.players.find((x) => x.id === playerId)
          if (!p) return
          const micChanged = p.micEnabled !== micEnabled
          const speakingChanged = p.speaking !== speaking
          if (!micChanged && !speakingChanged) return
          p.micEnabled = micEnabled
          p.speaking = speaking
          // 仅「说话」变化时只刷 HUD 浮层；麦克风开关变化才走全量刷新
          // （成员列表要更新麦克风标记）。这条区分很关键：说话状态在交谈中
          // 每秒可能切换多次，走全量通道会造成持续卡顿。
          if (micChanged) notify()
          else notifySpeaking()
        },
        onChat: (msg) => {
          // 消息收发：他人发来的消息落库并推给各界面。
          // 用发送方的 msgId 作为本地 id：信令层已按它去重，这里再用同一 id 兜底
          // （pushMessage 也会按 id 去重），双重保证只会显示一条。
          const id = msg.msgId || `chat-${msg.playerId}-${msg.timestamp}`
          pushMessage({
            id,
            playerId: msg.playerId,
            playerName: msg.playerName || msg.playerId.slice(0, 8),
            content: msg.content,
            timestamp: msg.timestamp,
            isSelf: false
          })
        }
      })

      // 注入「按虚拟 IP 解析可达目标」：收到来自某虚拟 IP 的发现报文时，
      // 信令层借此即时建立/复用到该 IP 的 EasyTier 转发并回执，
      // 从而在无 TUN 路由的情况下完成双向发现。
      signaling.setTargetResolver((virtualIp, port) => ensurePortForward('udp', virtualIp, port))
    } catch (err) {
      // 发现服务失败不应阻断组网：仍可手动用虚拟 IP 连接。
      console.warn('[联机] P2P 发现服务启动失败：', err)
    }

    // 启动路由表轮询：跨局域网的成员靠它发现（局域网广播穿不过 overlay）。
    startPeerPolling()
    // 启动世界扫描 + 局域网桥：把大厅内的 MC 世界注入本机局域网列表，
    // 这是「能看到成员名字、游戏里却连不上」的修复关键。
    startWorldScanning()

    notify()
    return lobby
  } catch (err) {
    stopPeerPolling()
    stopWorldScanning()
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
    // 先停各定时器，避免退出过程中还在用已失效的 RPC 查询成员。
    stopPeerPolling()
    // 停世界扫描 / 局域网桥：关闭本地代理与伪组播。
    stopWorldScanning()
    // 停信令：它会广播 player-left，让同大厅成员立即移除自己。
    await signaling.stop()
    // 停语音中继：关闭 UDP 套接字并清空转发登记（转发随后随组网一起清空）。
    stopVoiceRelay()
    await stopEasytier()
  } finally {
    state.lobby = null
    state.session = null
    state.players = []
    state.micEnabled = false
    state.appState = 'idle'
    messages = []
    recentlyLeft.clear()
    notify()
  }
}

/** 兜底：强制停掉可能残留的组网（应用启动 / 退出时调用）。 */
export async function forceStop(): Promise<void> {
  stopPeerPolling()
  stopWorldScanning()
  await signaling.stop().catch(() => undefined)
  if (isEasytierRunning()) await stopEasytier()
  state.lobby = null
  state.session = null
  state.players = []
  state.appState = 'idle'
  messages = []
  recentlyLeft.clear()
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

/** HUD 浮层所需的成员快照（只保留展示需要的字段）。 */
export function getHudPlayers(): MpHudPlayer[] {
  return state.players.map((p) => ({
    id: p.id,
    name: p.name,
    speaking: p.speaking === true,
    micEnabled: p.micEnabled,
    isMuted: p.isMuted,
    isSelf: p.isSelf,
    virtualIp: p.virtualIp
  }))
}

export function setMicEnabled(enabled: boolean): void {
  state.micEnabled = enabled
  const self = state.players.find((p) => p.isSelf)
  if (self) self.micEnabled = enabled
  if (!enabled && self) self.speaking = false
  // 广播给同大厅成员，让对方的成员列表同步麦克风（与说话）状态。
  signaling.broadcastVoiceState(enabled, self?.speaking ?? false)
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

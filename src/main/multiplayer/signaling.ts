import dgram from 'dgram'
import { networkInterfaces } from 'os'

/**
 * P2P 信令与玩家发现（UDP 局域网广播）。
 *
 * 移植自 MCTier 的 `modules/p2p_signaling.rs`：不依赖中心服务器，同一虚拟局域网内的
 * 成员通过 UDP 广播互相发现，并用 JSON 消息交换玩家信息与 WebRTC 信令。
 *
 * 关键点（与原版一致）：
 *   - 绑 `0.0.0.0`，端口从 47777 起，占用则 +1（最多 100 次）
 *   - 发现广播：前 10 次每秒 1 次，之后每 5 秒 1 次
 *   - 心跳：每 30 秒一次；超过 90 秒未收到心跳判定离线
 *   - 广播地址用 `255.255.255.255`，因为无 TUN 模式下虚拟 IP 不在系统网卡上
 */

/** 消息类型（kebab-case，与 Rust 的 serde tag 保持一致）。 */
export type P2PMessage =
  | { type: 'player-discovery'; playerId: string; playerName: string; port: number; virtualIp?: string }
  | {
      type: 'player-discovery-response'
      playerId: string
      playerName: string
      port: number
      virtualIp?: string
    }
  | { type: 'offer'; from: string; sdp: string }
  | { type: 'answer'; from: string; sdp: string }
  | { type: 'ice-candidate'; from: string; candidate: string }
  | { type: 'status-update'; playerId: string; micEnabled: boolean }
  | { type: 'heartbeat'; playerId: string; timestamp: number; virtualIp?: string }
  | { type: 'player-left'; playerId: string }

/** 已发现的对等节点。 */
interface PeerInfo {
  playerId: string
  playerName: string
  address: string
  port: number
  /** 对方的虚拟 IP：无 TUN 模式下不在系统网卡上，只能通过信令交换得到。 */
  virtualIp: string
  lastSeen: number
}

export interface Peer {
  playerId: string
  playerName: string
  address: string
  virtualIp: string
}

/** 对外事件回调。 */
export interface SignalingHandlers {
  onPlayerJoined?: (peer: Peer) => void
  onPlayerLeft?: (playerId: string) => void
  /** 已知成员补齐/更新了虚拟 IP。 */
  onPeerUpdated?: (peer: Peer) => void
  onSignal?: (from: string, message: P2PMessage) => void
  onStatusUpdate?: (playerId: string, micEnabled: boolean) => void
}

const DISCOVERY_PORT = 47777
const PORT_TRIES = 100
const HEARTBEAT_INTERVAL_MS = 30_000
/** 90 秒未收到心跳判定离线（原版同值）。 */
const PEER_TIMEOUT_MS = 90_000
const BROADCAST_ADDR = '255.255.255.255'
/** 前若干次发现广播用 1 秒间隔，之后放宽到 5 秒。 */
const FAST_BROADCAST_COUNT = 10
/**
 * 收到 player-left 后的抑制窗口：期间忽略该玩家的发现广播。
 * 否则对方退出时已在途的发现报文会把刚移除的成员又加回来（实测会复现）。
 */
const LEFT_SUPPRESS_MS = 6_000

export class P2PSignaling {
  private socket: dgram.Socket | null = null
  private port = DISCOVERY_PORT
  private peers = new Map<string, PeerInfo>()
  /** 玩家 id → 收到 player-left 的时间；抑制窗口内忽略其发现广播。 */
  private leftAt = new Map<string, number>()
  private playerId = ''
  private playerName = ''
  private virtualIp = ''
  private handlers: SignalingHandlers = {}
  private broadcastTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  /** 启动：绑定端口并开启接收 / 广播 / 心跳 / 超时清理。 */
  async start(
    playerId: string,
    playerName: string,
    virtualIp: string,
    handlers: SignalingHandlers
  ): Promise<{ port: number }> {
    await this.stop()

    this.playerId = playerId
    this.playerName = playerName
    this.virtualIp = virtualIp
    this.handlers = handlers

    const socket = await this.bindSocket()
    this.socket = socket
    // 允许广播（否则 send 到 255.255.255.255 会 EACCES）。
    socket.setBroadcast(true)

    socket.on('message', (buf, rinfo) => this.handleMessage(buf, rinfo))
    socket.on('error', () => {
      /* 单个报文错误不致命，忽略 */
    })

    this.broadcastTimer = setInterval(() => this.broadcastDiscovery(), 1000)
    // 前 10 次用 1 秒间隔，之后切换为 5 秒。
    setTimeout(() => {
      if (this.broadcastTimer) clearInterval(this.broadcastTimer)
      this.broadcastTimer = setInterval(() => this.broadcastDiscovery(), 5000)
    }, FAST_BROADCAST_COUNT * 1000)

    this.heartbeatTimer = setInterval(() => this.broadcastHeartbeat(), HEARTBEAT_INTERVAL_MS)
    this.sweepTimer = setInterval(() => this.sweepPeers(), 10_000)

    // 立即广播一次，加快首次发现。
    this.broadcastDiscovery()

    return { port: this.port }
  }

  /** 依次尝试 47777 起的端口，直到绑定成功。 */
  private bindSocket(): Promise<dgram.Socket> {
    return new Promise((resolve, reject) => {
      let attempt = 0
      const tryBind = (): void => {
        const port = DISCOVERY_PORT + attempt
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
        socket.once('error', () => {
          socket.close()
          attempt += 1
          if (attempt >= PORT_TRIES) {
            reject(new Error(`无法绑定 UDP 端口（已尝试 ${PORT_TRIES} 个）`))
            return
          }
          tryBind()
        })
        socket.bind(port, '0.0.0.0', () => {
          this.port = port
          resolve(socket)
        })
      }
      tryBind()
    })
  }

  /** 停止服务并释放全部定时器与套接字。 */
  async stop(): Promise<void> {
    for (const timer of [this.broadcastTimer, this.heartbeatTimer, this.sweepTimer]) {
      if (timer) clearInterval(timer)
    }
    this.broadcastTimer = null
    this.heartbeatTimer = null
    this.sweepTimer = null

    const socket = this.socket
    this.socket = null
    if (socket) {
      // 离开前广播一次 player-left，让同大厅成员立即移除自己。
      // 必须等 send 回调返回后再关套接字，否则报文可能在发送队列里就被丢弃。
      if (this.playerId) {
        await new Promise<void>((resolve) => {
          const buf = Buffer.from(
            JSON.stringify({ type: 'player-left', playerId: this.playerId } satisfies P2PMessage),
            'utf8'
          )
          socket.send(buf, this.port, BROADCAST_ADDR, () => resolve())
          // 兜底：回调偶发不触发时也不能卡住退出流程。
          setTimeout(resolve, 300)
        })
      }
      await new Promise<void>((resolve) => socket.close(() => resolve()))
    }

    this.peers.clear()
    this.leftAt.clear()
    this.playerId = ''
  }

  /** 当前已发现的成员（不含自己）。 */
  list(): Peer[] {
    return [...this.peers.values()].map((p) => ({
      playerId: p.playerId,
      playerName: p.playerName,
      address: p.address,
      virtualIp: p.virtualIp
    }))
  }

  /** 向指定玩家单播信令消息。 */
  sendTo(playerId: string, message: P2PMessage): boolean {
    const peer = this.peers.get(playerId)
    if (!peer) return false
    return this.sendRaw(message, peer.address, peer.port)
  }

  /** 广播自己的麦克风状态。 */
  broadcastStatus(micEnabled: boolean): void {
    this.sendRaw({ type: 'status-update', playerId: this.playerId, micEnabled })
  }

  /* ---------------- 内部 ---------------- */

  private broadcastDiscovery(): void {
    if (!this.playerId) return
    this.sendRaw(
      {
        type: 'player-discovery',
        playerId: this.playerId,
        playerName: this.playerName,
        port: this.port,
        // 带上虚拟 IP：无 TUN 模式下它不在系统网卡上，对方只能从这里得知。
        virtualIp: this.virtualIp
      },
      BROADCAST_ADDR,
      this.port
    )
  }

  private broadcastHeartbeat(): void {
    if (!this.playerId) return
    this.sendRaw(
      {
        type: 'heartbeat',
        playerId: this.playerId,
        timestamp: Date.now(),
        virtualIp: this.virtualIp
      },
      BROADCAST_ADDR,
      this.port
    )
  }

  private sendRaw(message: P2PMessage, address?: string, port?: number): boolean {
    const socket = this.socket
    if (!socket) return false
    const buf = Buffer.from(JSON.stringify(message), 'utf8')
    const dest = address ?? BROADCAST_ADDR
    const destPort = port ?? this.port
    try {
      socket.send(buf, destPort, dest, () => undefined)
      return true
    } catch {
      return false
    }
  }

  private handleMessage(buf: Buffer, rinfo: dgram.RemoteInfo): void {
    let message: P2PMessage
    try {
      message = JSON.parse(buf.toString('utf8')) as P2PMessage
    } catch {
      return
    }
    if (!message || typeof message.type !== 'string') return

    // 忽略自己的报文（广播会回环到自己）。
    const senderId = 'playerId' in message ? message.playerId : 'from' in message ? message.from : ''
    if (senderId && senderId === this.playerId) return

    switch (message.type) {
      case 'player-discovery': {
        // 新成员广播：立刻回一个响应，让对方尽快发现我（并带上我的虚拟 IP）。
        this.sendRaw(
          {
            type: 'player-discovery-response',
            playerId: this.playerId,
            playerName: this.playerName,
            port: this.port,
            virtualIp: this.virtualIp
          },
          rinfo.address,
          message.port
        )
        break
      }
      case 'player-left': {
        // 主动退出：立即移除，不等 90 秒心跳超时。
        this.leftAt.set(message.playerId, Date.now())
        if (this.peers.delete(message.playerId)) {
          this.handlers.onPlayerLeft?.(message.playerId)
        }
        return
      }
      default:
        break
    }

    this.trackPeer(message, rinfo)

    if (message.type === 'status-update') {
      this.handlers.onStatusUpdate?.(message.playerId, message.micEnabled)
    }
    if (
      message.type === 'offer' ||
      message.type === 'answer' ||
      message.type === 'ice-candidate'
    ) {
      this.handlers.onSignal?.(message.from, message)
    }
  }

  /** 收到任何来自某玩家的消息即记录/刷新该成员。 */
  private trackPeer(message: P2PMessage, rinfo: dgram.RemoteInfo): void {
    let playerId = ''
    let playerName = ''
    let port = rinfo.port
    let virtualIp = ''

    if (message.type === 'player-discovery' || message.type === 'player-discovery-response') {
      playerId = message.playerId
      playerName = message.playerName
      port = message.port
      virtualIp = message.virtualIp ?? ''
    } else if ('playerId' in message) {
      playerId = message.playerId
      // 心跳也会捎带虚拟 IP，用于补齐之前只拿到名字的成员。
      if ('virtualIp' in message) virtualIp = message.virtualIp ?? ''
    } else if ('from' in message) {
      playerId = message.from
    }

    if (!playerId || playerId === this.playerId) return

    // 抑制窗口内不重新加入（对方刚退出，在途报文可能是退出前发出的）。
    const leftTime = this.leftAt.get(playerId)
    if (leftTime !== undefined) {
      if (Date.now() - leftTime < LEFT_SUPPRESS_MS) return
      this.leftAt.delete(playerId)
    }

    const existing = this.peers.get(playerId)
    const address = rinfo.address

    if (existing) {
      existing.lastSeen = Date.now()
      existing.address = address
      existing.port = port
      if (playerName) existing.playerName = playerName
      // 虚拟 IP 可能后到（先靠心跳/发现补齐），变化时通知上层刷新界面。
      if (virtualIp && virtualIp !== existing.virtualIp) {
        existing.virtualIp = virtualIp
        this.handlers.onPeerUpdated?.({
          playerId: existing.playerId,
          playerName: existing.playerName,
          address: existing.address,
          virtualIp: existing.virtualIp
        })
      }
      return
    }

    // 新成员：记录并通知上层。
    const peer: PeerInfo = {
      playerId,
      playerName: playerName || playerId.slice(0, 8),
      address,
      port,
      virtualIp,
      lastSeen: Date.now()
    }
    this.peers.set(playerId, peer)
    this.handlers.onPlayerJoined?.({
      playerId,
      playerName: peer.playerName,
      address,
      virtualIp
    })
  }

  /** 清理超过 90 秒没有心跳的成员。 */
  private sweepPeers(): void {
    const now = Date.now()
    const dead: string[] = []
    for (const [id, peer] of this.peers) {
      if (now - peer.lastSeen > PEER_TIMEOUT_MS) dead.push(id)
    }
    for (const id of dead) {
      this.peers.delete(id)
      this.handlers.onPlayerLeft?.(id)
    }
  }
}

/** 取本机首个非回环 IPv4（用于诊断 / 展示）。 */
export function primaryLocalIpv4(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal) return info.address
    }
  }
  return '127.0.0.1'
}

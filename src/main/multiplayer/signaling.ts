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
  | { type: 'status-update'; playerId: string; micEnabled: boolean }
  /** 语音状态（说话中）：驱动 HUD / 成员列表的说话指示。 */
  | { type: 'voice-state'; playerId: string; micEnabled: boolean; speaking: boolean }
  /**
   * 聊天消息（消息收发）。
   *
   * `msgId` 是发送方生成的稳定标识（`<playerId>-<timestamp>`）。必须带上它：
   * 同一条消息会经「局域网广播 + 逐个单播 + 端口转发目标」多条通道投递，
   * 接收端会收到 2-3 份副本；靠 `msgId` 去重才能保证只显示一条。
   */
  | {
      type: 'chat'
      playerId: string
      playerName: string
      content: string
      timestamp: number
      msgId?: string
    }
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

/**
 * 成员离开时上报的信息。
 *
 * 为什么不只传 playerId：上层（lobby）的成员列表里，同一个人可能同时存在
 * 「信令来源」与「EasyTier 路由表来源」两条记录（id 不同）。只按 playerId 删除
 * 会漏掉另一条，表现为「有人退出后成员列表还留着他」。带上 playerName / virtualIp
 * 后，上层可同时按 id、名字、虚拟 IP 三种键清理。
 */
export interface LeftPeer {
  playerId: string
  playerName: string
  virtualIp: string
}

/** 对外事件回调。 */
export interface SignalingHandlers {
  onPlayerJoined?: (peer: Peer) => void
  onPlayerLeft?: (peer: LeftPeer) => void
  /** 已知成员补齐/更新了虚拟 IP。 */
  onPeerUpdated?: (peer: Peer) => void
  onStatusUpdate?: (playerId: string, micEnabled: boolean) => void
  /** 语音状态（含说话中）：驱动 HUD / 成员列表。 */
  onVoiceState?: (playerId: string, micEnabled: boolean, speaking: boolean) => void
  /** 收到一条聊天消息。 */
  onChat?: (msg: {
    playerId: string
    playerName: string
    content: string
    timestamp: number
    msgId?: string
  }) => void
}

const DISCOVERY_PORT = 47777
/**
 * 发现 / 信令端口（对外导出）。
 *
 * 上层建立 EasyTier 端口转发时需要它作为**远端目标端口**：
 * `127.0.0.1:<本地口>` → `<成员虚拟IP>:DISCOVERY_PORT`。
 */
export const SIGNALING_PORT = DISCOVERY_PORT
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
/** 聊天去重窗口：同一 msgId 在此时间内的重复副本一律丢弃。 */
const CHAT_DEDUP_MS = 30_000

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
  /**
   * 已知成员的**可达单播目标**（`host:port`，通常是 EasyTier 转发的本地回环口）。
   *
   * 为什么不是直接存虚拟 IP：`--no-tun` 下系统没有 10.126.126.0/24 的路由，
   * 往虚拟 IP 发包会被静默丢弃。EasyTier 的 `--port-forward` 会把
   * `127.0.0.1:<本地口>` 映射到 `远端虚拟IP:端口`，因此**唯一的可达地址是本地回环口**。
   * 由上层（lobby）在同步成员时建立转发并注入这些地址。
   */
  private reachableTargets: string[] = []
  /** 按虚拟 IP 解析可达目标（建立/复用转发），由 lobby 注入。 */
  private targetResolver: ((virtualIp: string, port: number) => Promise<string | null>) | null = null
  /**
   * 已处理过的聊天 msgId → 处理时间。
   *
   * 同一条消息会经多条通道（广播 / 单播 / 端口转发）重复到达，必须去重，
   * 否则对方会看到 2-3 条相同消息。超过窗口后清理，避免无限增长。
   */
  private seenChatIds = new Map<string, number>()

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
          // 通道与发现广播一致，缺一不可：
          //   1. 物理局域网广播（发到固定发现端口，并补发自身端口）；
          //   2. **逐个单播到「可达目标」**（EasyTier 转发出来的本地回环口）。
          // 关键修复：以前只做 (1)，跨网络的成员收不到广播（物理广播穿不过 overlay），
          // 只能等 90 秒心跳超时，表现为「对方退出后成员列表迟迟不刷新」。
          const targets: Array<{ host: string; port: number }> = []
          for (const target of this.reachableTargets) {
            const [host, portStr] = target.split(':')
            const port = Number(portStr)
            if (host && Number.isInteger(port) && port > 0) targets.push({ host, port })
          }
          let pending = 1 + (this.port === DISCOVERY_PORT ? 0 : 1) + targets.length
          const done = (): void => {
            pending -= 1
            if (pending <= 0) resolve()
          }
          socket.send(buf, DISCOVERY_PORT, BROADCAST_ADDR, done)
          if (this.port !== DISCOVERY_PORT) {
            socket.send(buf, this.port, BROADCAST_ADDR, done)
          }
          for (const t of targets) socket.send(buf, t.port, t.host, done)
          // 兜底：回调偶发不触发时也不能卡住退出流程。
          setTimeout(resolve, 300)
        })
      }
      await new Promise<void>((resolve) => socket.close(() => resolve()))
    }

    this.peers.clear()
    this.leftAt.clear()
    this.reachableTargets = []
    this.targetResolver = null
    this.seenChatIds.clear()
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

  /**
   * 广播「麦克风 + 说话中」状态。
   *
   * 说话状态用于 HUD / 成员列表的绿点指示；单独走 voice-state 而不是复用
   * status-update，是为了让「开麦但没说话」与「正在说话」可区分。
   */
  broadcastVoiceState(micEnabled: boolean, speaking: boolean): void {
    this.sendToAll({ type: 'voice-state', playerId: this.playerId, micEnabled, speaking })
  }

  /**
   * 广播一条聊天消息（消息收发）。
   *
   * 生成一个稳定 `msgId` 并返回，供发送方本地回显复用同一 id ——
   * 这样「本地回显」与「他人收到」在语义上是同一条消息。
   */
  broadcastChat(content: string): string {
    const timestamp = Date.now()
    const msgId = `${this.playerId}-${timestamp}`
    this.sendToAll({
      type: 'chat',
      playerId: this.playerId,
      playerName: this.playerName,
      content,
      timestamp,
      msgId
    })
    return msgId
  }

  /**
   * 把消息发给所有已知成员。
   *
   * 通道（全部发一遍，接收端按 playerId 去重）：
   *   1. 广播到物理局域网 —— 同路由器下的成员可直达（最快，且无需转发）；
   *   2. **逐个单播到「可达目标」** —— 每个目标是 EasyTier 转发出来的
   *      `127.0.0.1:<本地口>`，经 overlay 投递到对应成员的发现端口。
   *      这是跨网络的唯一可行通道（虚拟 IP 无系统路由，直发会丢包）。
   *   3. 单播到对方物理 address:port —— 兜底（例如对方在同一物理网）。
   */
  private sendToAll(message: P2PMessage): void {
    this.broadcastToDiscovery(message)
    for (const peer of this.peers.values()) {
      this.sendRaw(message, peer.address, peer.port)
    }
    // 可达目标（本地转发口）单独发一轮，覆盖仅由路由表发现的成员。
    for (const target of this.reachableTargets) {
      const [host, portStr] = target.split(':')
      const port = Number(portStr)
      if (host && Number.isInteger(port) && port > 0) this.sendRaw(message, host, port)
    }
  }

  /* ---------------- 内部 ---------------- */

  private broadcastDiscovery(): void {
    if (!this.playerId) return
    this.broadcastToDiscovery({
      type: 'player-discovery',
      playerId: this.playerId,
      playerName: this.playerName,
      port: this.port,
      // 带上虚拟 IP：无 TUN 模式下它不在系统网卡上，对方只能从这里得知。
      virtualIp: this.virtualIp
    })
  }

  private broadcastHeartbeat(): void {
    if (!this.playerId) return
    this.broadcastToDiscovery({
      type: 'heartbeat',
      playerId: this.playerId,
      timestamp: Date.now(),
      virtualIp: this.virtualIp
    })
  }

  /**
   * 把发现 / 心跳广播到**固定发现端口**，而不是自己的监听端口。
   *
   * 关键原因：本机 47777 被占用时会自动回退到 47778 等非标准端口。若各节点都广播到
   * 「自己的端口」，两端发的目的地就不同（A→47777、B→47778），彼此都收不到对方，
   * 只会收到自己的广播回环（又被 playerId 过滤掉），于是**永远发现不了任何成员**
   * ——表现就是「有人加入也不刷新」。
   *
   * 固定端口保证至少一个方向的报文能落在标准端口上；收到的一方会按报文里的 `port`
   * 字段回执到对方真实端口，从而完成双向发现。
   * 另外再补发一份到自身端口，覆盖「双方恰好都回退到同一端口」的情况。
   * 最后对每个「可达目标」再单播一份 —— 跨网络时广播进不了 overlay，
   * 只有单播到 EasyTier 转发出来的本地口才能送达（见 sendToAll）。
   */
  private broadcastToDiscovery(message: P2PMessage): void {
    this.sendRaw(message, BROADCAST_ADDR, DISCOVERY_PORT)
    if (this.port !== DISCOVERY_PORT) {
      this.sendRaw(message, BROADCAST_ADDR, this.port)
    }
    for (const target of this.reachableTargets) {
      const [host, portStr] = target.split(':')
      const port = Number(portStr)
      if (host && Number.isInteger(port) && port > 0) this.sendRaw(message, host, port)
    }
  }

  /**
   * 由上层注入「可达的单播目标」（`host:port`）。
   *
   * 这些地址通常由 lobby 通过 EasyTier 的 `port-forward` 动态建立：
   *   `127.0.0.1:<本地口>` → `<成员虚拟IP>:<发现端口>`
   * 从而在**没有 TUN 路由**的情况下也能把发现 / 聊天 / 语音信令送达对端。
   */
  setReachableTargets(targets: string[]): void {
    this.reachableTargets = targets.filter((t) => {
      const m = /^([^:]+):(\d{1,5})$/.exec(t.trim())
      return !!m && Number(m[2]) > 0 && Number(m[2]) <= 65535
    })
  }

  /**
   * 注册「按虚拟 IP 解析可达目标」的回调（由 lobby 提供）。
   *
   * 为什么需要：收到来自某虚拟 IP 的报文时，`rinfo.address` 是**对端的虚拟 IP**，
   * 而 `--no-tun` 下无法直接回包。此处让上层（lobby）即时建立/复用一个到该 IP
   * 的 EasyTier 转发，返回 `127.0.0.1:<本地口>`，信令据此回执，从而完成双向发现。
   */
  setTargetResolver(fn: ((virtualIp: string, port: number) => Promise<string | null>) | null): void {
    this.targetResolver = fn
  }

  /**
   * 回执一条发现报文：优先经「到对端虚拟 IP 的转发」发出（跨网可用），
   * 失败时退化为直发 rinfo（同物理网可用）。
   */
  private async replyToDiscovery(
    reply: P2PMessage,
    rinfo: dgram.RemoteInfo,
    fallbackPort: number
  ): Promise<void> {
    const resolver = this.targetResolver
    // 仅当来源确实是本网络的虚拟 IP 时才尝试转发（广播回环来源为物理网地址）。
    if (resolver && /^10\.126\.126\.\d{1,3}$/.test(rinfo.address)) {
      try {
        // 回执要送到对端的**信令监听口**；对端若回退过端口，其发现报文里的 port 更准。
        const bind = await resolver(rinfo.address, fallbackPort || DISCOVERY_PORT)
        if (bind) {
          const [host, portStr] = bind.split(':')
          const port = Number(portStr)
          if (host && port > 0) {
            this.sendRaw(reply, host, port)
            return
          }
        }
      } catch {
        /* 转发失败则走下面的兜底 */
      }
    }
    this.sendRaw(reply, rinfo.address, rinfo.port)
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

    // 语音已改走 UDP 中继（见 voice-relay.ts），不再使用 WebRTC 信令。
    // 旧版本对端仍可能发来 offer / answer / ice-candidate：必须在这里直接丢弃，
    // 否则会被下面的 trackPeer 当成成员登记，凭空多出一个幽灵成员。
    // （先赋给 string 再比较：这几个类型已不在联合里，直接比较会被 TS 判为无重叠。）
    const rawType: string = message.type
    if (rawType === 'offer' || rawType === 'answer' || rawType === 'ice-candidate') return

    // 忽略自己的报文（广播会回环到自己）。
    if (message.playerId === this.playerId) return

    switch (message.type) {
      case 'player-discovery': {
        // 新成员广播：立刻回一个响应，让对方尽快发现我（并带上我的虚拟 IP）。
        //
        // 回执地址的选取很关键：`--no-tun` 下无法直接往对端虚拟 IP 回包。
        // 因此用 targetResolver 即时建立/复用一个到该虚拟 IP 的转发，回执到
        // `127.0.0.1:<本地口>`；resolver 不可用时才退化为直发 rinfo（同物理网可用）。
        const reply: P2PMessage = {
          type: 'player-discovery-response',
          playerId: this.playerId,
          playerName: this.playerName,
          port: this.port,
          virtualIp: this.virtualIp
        }
        void this.replyToDiscovery(reply, rinfo, message.port)
        break
      }
      case 'player-left': {
        // 主动退出：立即移除，不等 90 秒心跳超时。
        this.leftAt.set(message.playerId, Date.now())
        const leaving = this.peers.get(message.playerId)
        if (this.peers.delete(message.playerId)) {
          // 带上名字与虚拟 IP：上层据此把「同一人的另一条来源记录」也一并清掉。
          this.handlers.onPlayerLeft?.({
            playerId: message.playerId,
            playerName: leaving?.playerName ?? '',
            virtualIp: leaving?.virtualIp ?? ''
          })
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
    if (message.type === 'voice-state') {
      this.handlers.onVoiceState?.(message.playerId, message.micEnabled, message.speaking)
    }
    if (message.type === 'chat') {
      // 去重：同一条消息会经多条通道重复到达。msgId 优先；老版本无 msgId 时
      // 退化为 `playerId-timestamp-content`，同样能挡住副本。
      const dedupKey =
        message.msgId || `${message.playerId}-${message.timestamp}-${message.content}`
      const now = Date.now()
      const last = this.seenChatIds.get(dedupKey)
      if (last !== undefined && now - last < CHAT_DEDUP_MS) return
      this.seenChatIds.set(dedupKey, now)
      this.pruneChatIds(now)
      this.handlers.onChat?.({
        playerId: message.playerId,
        playerName: message.playerName,
        content: message.content,
        timestamp: message.timestamp,
        msgId: message.msgId
      })
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
    } else {
      // 其余报文（心跳 / 状态 / 聊天 / voice-state / player-left）都带 playerId。
      playerId = message.playerId
      // 心跳也会捎带虚拟 IP，用于补齐之前只拿到名字的成员。
      if ('virtualIp' in message) virtualIp = message.virtualIp ?? ''
      // 聊天消息自带 playerName，可补齐尚未通过发现报文拿到名字的成员。
      if ('playerName' in message && typeof message.playerName === 'string') playerName = message.playerName
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

  /** 清理过期聊天去重记录，避免 Map 无限增长。 */
  private pruneChatIds(now: number): void {
    if (this.seenChatIds.size < 256) return
    for (const [key, at] of this.seenChatIds) {
      if (now - at >= CHAT_DEDUP_MS) this.seenChatIds.delete(key)
    }
  }

  /** 清理超过 90 秒没有心跳的成员。 */
  private sweepPeers(): void {
    const now = Date.now()
    const dead: string[] = []
    for (const [id, peer] of this.peers) {
      if (now - peer.lastSeen > PEER_TIMEOUT_MS) dead.push(id)
    }
    for (const id of dead) {
      const peer = this.peers.get(id)
      this.peers.delete(id)
      this.handlers.onPlayerLeft?.({
        playerId: id,
        playerName: peer?.playerName ?? '',
        virtualIp: peer?.virtualIp ?? ''
      })
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

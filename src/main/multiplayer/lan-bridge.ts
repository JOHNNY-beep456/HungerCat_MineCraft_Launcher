// ---------------------------------------------------------------------------
// Minecraft 局域网桥（LAN Bridge）。
//
// ── 为什么需要它（这是「能看到名字却联不上机」的根因）──────────────────
// 大厅只把成员组进了 EasyTier 虚拟网络（各人拿到 10.126.126.x）。但 Minecraft
// 的「多人游戏 → 局域网」列表只认**本机 UDP 组播公告**（224.0.2.60:4445）：
//   - 物理局域网里广播能到，所以同一路由器下能刷出世界；
//   - 跨局域网时组播根本到不了对方，而虚拟 IP 又不在系统网卡上（--no-tun），
//     于是「名字在成员列表里看得到，游戏里却怎么都连不上」。
//
// ── 移植自 MCTier 的做法（modules/mc_lan_bridge.rs）────────────────────
// 不改动游戏进程，在本机做两层事：
//   1. TCP 代理：`<本机地址>:<随机端口>` → `<房主虚拟IP>:<25565>`，
//      经 EasyTier 虚拟网络转发到房主。
//   2. 伪组播公告：每 1.5s 往 224.0.2.60:4445 发 Minecraft 的 LAN 格式
//      `[MOTD]...[/MOTD][AD]<代理端口>[/AD]`，TTL=1。
//      本机 Minecraft 收到后就把它当成一个「局域网世界」，玩家点一下即连上。
//
// ── 为什么代理要监听 0.0.0.0（而不是只绑回环）──────────────────────
// Minecraft 的局域网列表**不解析公告里的 IP**：它取 UDP 报文的**源地址**作为
// 服务器地址，端口才来自 `[AD]`。公告由绑在 0.0.0.0 的套接字发出，源地址因此是
// 本机网卡 IP（如 192.168.x.x），于是 MC 会去连 `192.168.x.x:<代理口>`。
// 若代理只绑 127.0.0.1，这个连接没有任何监听者 —— MC 报的正是
// `Connection refused: getsockopt`。
// 因此代理改听 0.0.0.0，并在 accept 时**只放行本机来源**（回环 + 本机各网卡 IP）：
// 效果等价于原来「只绑回环」的安全边界（伪组播 TTL=1，端口也不外泄），
// 同时让 MC 无论用哪个本机 IP 都能连上。
//
// 另附 `scanLanWorlds`：用 Minecraft Server List Ping 协议并发探测虚拟 IP:端口，
// 用于「世界列表」展示（版本 / 人数 / 延迟）与手动直连地址。
// ---------------------------------------------------------------------------

import dgram from 'dgram'
import os from 'os'
import { createServer, connect, type Server, type Socket } from 'net'

/** 虚拟网段前缀：与 easytier.ts 一致（MCTier 客户端默认 10.126.126.0/24）。 */
const VIRTUAL_NET_PREFIX = '10.126.126.'
/** Minecraft 局域网组播地址与端口（官方固定值）。 */
const MC_MULTICAST_ADDR = '224.0.2.60'
const MC_MULTICAST_PORT = 4445
/** 组播公告间隔（与 MCTier 一致）。 */
const EMIT_INTERVAL_MS = 1500
/** 连接房主虚拟 IP 的超时。 */
const CONNECT_TIMEOUT_MS = 3000
/** 单次 SLP 探测的超时。 */
const SLP_TIMEOUT_MS = 1500
/**
 * 代理「容忍漏报」的轮数：连续这么多轮没再发现该世界才回收代理。
 * 8 秒一轮 → 3 轮约 24 秒的宽限，足以扛过探测抖动，避免 MC 里点到已关闭的端口。
 */
const PROXY_MISS_GRACE = 3

/** 一个待广播的 MC 世界（房主的虚拟 IP + 端口）。 */
export interface BridgeTarget {
  /** 房主虚拟 IP（必须是 10.126.126.1-254 字面量）。用于展示与去重。 */
  ip: string
  /** 房主开放的端口（「对局域网开放」可能是随机端口）。 */
  port: number
  /** 显示名（展示在 MC 的局域网列表里）。 */
  motd?: string
  /**
   * 实际连接地址（可选）。
   *
   * `--no-tun` 下系统没有虚拟网段路由，直接连 `ip:port` 会被丢弃；
   * 上层会先用 EasyTier 端口转发得到 `127.0.0.1:<本地口>`，并通过这里传入。
   * 缺省时退化为直连 `ip:port`（同物理网可用）。
   */
  connectHost?: string
  connectPort?: number
  /**
   * 动态解析上游地址（可选，优先级高于 connectHost/connectPort）。
   *
   * 为什么需要：EasyTier 的转发本地口在「转发被重建」时**可能变化**。若代理在创建时
   * 就把 `connectHost:connectPort` 固定下来，之后转发口一变，代理仍在拨旧口 →
   * Minecraft 侧表现为 `Connection refused`。改为每次有玩家连接时**现场解析**，
   * 永远拨当前有效的上游口。
   */
  resolveUpstream?: () => { host: string; port: number } | null
}

/** 探测到的世界信息。 */
export interface LanWorld {
  ip: string
  port: number
  motd: string
  version: string
  players: { online: number; max: number }
  latencyMs: number
  /**
   * 可连接的本地代理地址（`127.0.0.1:<代理口>`）。
   *
   * `--no-tun` 下虚拟 IP `ip:port` **没有系统路由**，直接连必然失败；真正能进世界
   * 的只有我们建的本地 TCP 代理。世界列表必须把可连接地址给用户（复制 / 直连），
   * 否则「世界列表里的地址进不去」。缺省时表示代理尚未就绪。
   */
  connectHost?: string
  connectPort?: number
}

/**
 * 校验虚拟主机：只接受 10.126.126.1-254 的字面量 IPv4。
 *
 * 严格校验的原因（与 MCTier `virtual_host` 一致）：代理会把流量转发到该地址，
 * 若允许域名 / 物理网段 / 回环，等于把「访问任意主机」的能力暴露给大厅成员。
 */
function isVirtualHost(ip: string): boolean {
  const m = /^10\.126\.126\.(\d{1,3})$/.exec(ip.trim())
  if (!m) return false
  const last = Number(m[1])
  return last >= 1 && last <= 254
}

/**
 * 校验「探测目标地址」：允许虚拟 IP，也允许回环地址。
 *
 * 回环地址用于 EasyTier 端口转发得到的本地可达口（`127.0.0.1:<本地口>`）——
 * `--no-tun` 下这是访问其他成员世界的唯一方式。这里放宽到回环是安全的：
 * 目标由我们自己建立的转发决定，不接受任意外部输入。
 */
function isProbeHost(host: string): boolean {
  const h = host.trim()
  if (isVirtualHost(h)) return true
  return h === '127.0.0.1' || h === 'localhost'
}

/**
 * 连接来源是否就是本机。
 *
 * 代理监听 0.0.0.0，是为了让 Minecraft 能连上「组播报文源地址」（本机网卡 IP）。
 * 但这样一来物理局域网的人也能连到这条代理，因此 accept 时用它做白名单：
 * 只放行回环与本机各网卡地址，效果等价于原先「只绑回环」的安全边界。
 */
function isSelfAddress(remote?: string): boolean {
  if (!remote) return false
  // IPv4-mapped IPv6（::ffff:192.168.1.5）归一成 IPv4 再比较。
  const addr = remote.startsWith('::ffff:') ? remote.slice(7) : remote
  if (addr === '127.0.0.1' || addr === '::1') return true
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list ?? []) {
      const a = info.address.startsWith('::ffff:') ? info.address.slice(7) : info.address
      if (a === addr) return true
    }
  }
  return false
}

interface ProxyEntry {
  target: BridgeTarget
  localPort: number
  server: Server
  alive: boolean
  /**
   * 连续几次刷新未再发现该世界。
   *
   * SLP 探测会偶发抖动（丢包 / 世界短暂卡顿），若一次没探到就立刻关闭代理，
   * Minecraft 局域网列表里的缓存条目仍指向已关闭的端口，玩家一点就是
   * `Connection refused`。因此允许「漏报若干轮」再回收，保证端口稳定存活。
   */
  misses?: number
}

/** 运行中的桥状态（同一时刻只允许一个大厅）。 */
let proxies = new Map<string, ProxyEntry>()
let emitSocket: dgram.Socket | null = null
let emitTimer: ReturnType<typeof setInterval> | null = null
let running = false
/** 组播发送失败只在首次告警一次，避免刷屏（如沙箱/无组播路由的环境）。 */
let emitWarned = false

/* ------------------------------------------------------------------ */
/* TCP 代理                                                            */
/* ------------------------------------------------------------------ */

/** 双向透明转发：任一方向 EOF / 出错就关闭两端。 */
function pipe(a: Socket, b: Socket): void {
  a.on('data', (chunk) => {
    if (!b.write(chunk)) a.pause()
  })
  b.on('data', (chunk) => {
    if (!a.write(chunk)) b.pause()
  })
  a.on('drain', () => b.resume())
  b.on('drain', () => a.resume())
  const closeBoth = (): void => {
    a.destroy()
    b.destroy()
  }
  a.on('error', closeBoth)
  b.on('error', closeBoth)
  a.on('close', closeBoth)
  b.on('close', closeBoth)
}

/**
 * 为一个世界建立本地 TCP 代理，返回代理监听端口。
 *
 * 关键：**监听 0.0.0.0，但只放行本机来源**（原因见文件顶部说明）——
 * Minecraft 会连「组播报文的源地址」，那是本机网卡 IP，只绑回环必然
 * `Connection refused: getsockopt`。
 */
function startProxy(target: BridgeTarget): Promise<ProxyEntry> {
  return new Promise((resolve, reject) => {
    const server = createServer((client) => {
      // 只接受本机（Minecraft 客户端）的连接：伪组播 TTL=1 不会外泄、端口也无人知晓，
      // 这里再挡掉非本机来源，等价于「只绑回环」的边界，避免物理局域网蹭这条代理。
      if (!isSelfAddress(client.remoteAddress)) {
        client.destroy()
        return
      }
      // 每次连接现场解析上游：转发口变化时也能拨到当前有效地址，
      // 避免「代理还活着但上游口已失效」导致的 Connection refused。
      const upstreamAddr = target.resolveUpstream?.() ?? {
        host: target.connectHost ?? target.ip,
        port: target.connectPort ?? target.port
      }
      const connectHost = upstreamAddr.host
      const connectPort = upstreamAddr.port
      const upstream = connect({ host: connectHost, port: connectPort })
      upstream.setTimeout(CONNECT_TIMEOUT_MS)
      const fail = (): void => {
        upstream.destroy()
        client.destroy()
      }
      upstream.on('error', fail)
      upstream.on('timeout', fail)
      upstream.on('connect', () => {
        upstream.setTimeout(0)
        client.setNoDelay(true)
        upstream.setNoDelay(true)
        pipe(client, upstream)
      })
    })
    server.on('error', reject)
    server.listen(0, '0.0.0.0', () => {
      const addr = server.address()
      const localPort = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ target, localPort, server, alive: true })
    })
  })
}

/** 关闭一组代理。 */
function closeProxy(entry: ProxyEntry): void {
  entry.alive = false
  try {
    entry.server.close()
  } catch {
    /* 已关闭 */
  }
}

/* ------------------------------------------------------------------ */
/* 伪组播公告                                                          */
/* ------------------------------------------------------------------ */

/** 转义 MOTD：把可能提前闭合标签的内容替换掉，防止伪造公告格式。 */
function escapeMotd(motd: string): string {
  const cleaned = (motd || 'MCTier 世界').replace(/\[\/MOTD\]|\[\/AD\]/gi, '')
  return cleaned.slice(0, 1024)
}

/** 向本机 MC 广播一次所有代理的世界（伪 LAN 公告）。 */
function emitOnce(): void {
  const socket = emitSocket
  if (!socket || !running) return
  for (const entry of proxies.values()) {
    if (!entry.alive) continue
    const payload = `[MOTD]${escapeMotd(entry.target.motd ?? '')}[/MOTD][AD]${entry.localPort}[/AD]`
    const buf = Buffer.from(payload, 'utf8')
    try {
      // TTL=1：只在同一台机器（本机 MC）可见，不外泄到物理局域网。
      socket.setMulticastTTL(1)
      socket.send(buf, MC_MULTICAST_PORT, MC_MULTICAST_ADDR, (err) => {
        // 组播不可用（无组播路由 / 被防火墙拦截）：公告失败但本地代理仍在，
        // 用户可改用「世界列表」里的 `虚拟IP:端口` 手动直连。只告警一次。
        if (err && !emitWarned) {
          emitWarned = true
          console.warn(`[联机] 局域网公告发送失败（可改用世界列表手动直连）：${err.message}`)
        }
      })
    } catch (err) {
      if (!emitWarned) {
        emitWarned = true
        console.warn('[联机] 局域网公告发送异常（可改用世界列表手动直连）：', err)
      }
    }
  }
}

function ensureEmit(): void {
  if (emitSocket) return
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  // 必须绑 `0.0.0.0` 而不是 `127.0.0.1`：组播报文要从**真实网卡**发出并在本机回环，
  // 本机 Minecraft 才会在「局域网」列表里收到。绑到回环时组播没有可用出口，
  // 报文发不出去（或不被本机 MC 的 224.0.2.60 监听者接收），
  // 表现就是「启动器里看得到世界，游戏里却探测不到」。
  socket.bind(0, '0.0.0.0', () => {
    try {
      socket.setMulticastTTL(1)
      socket.setMulticastLoopback(true)
    } catch {
      /* 平台差异忽略 */
    }
    emitSocket = socket
    emitOnce()
    emitTimer = setInterval(emitOnce, EMIT_INTERVAL_MS)
  })
}

function stopEmit(): void {
  if (emitTimer) {
    clearInterval(emitTimer)
    emitTimer = null
  }
  const s = emitSocket
  emitSocket = null
  emitWarned = false
  if (s) {
    try {
      s.close()
    } catch {
      /* 已关闭 */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 启动 / 增量更新局域网广播。
 *
 * 传 `[]` 会停掉所有代理与公告。以 `ip:port` 为 key 做差量：
 * 已存在的只更新 MOTD（复用原代理端口，避免 Minecraft 侧世界「跳来跳去」），
 * 消失的关闭代理，新出现的才新建代理。
 */
export async function startLanBroadcast(
  targets: BridgeTarget[],
  /** 是否向本机 MC 发伪组播公告。false 时只建代理（世界列表仍可连），不打扰 MC。 */
  announce = true
): Promise<{ count: number }> {
  running = true
  const wanted = new Map<string, BridgeTarget>()
  for (const t of targets) {
    if (!isVirtualHost(t.ip)) continue
    if (!Number.isInteger(t.port) || t.port <= 0 || t.port > 65535) continue
    wanted.set(`${t.ip}:${t.port}`, t)
  }

  // 1) 移除不再需要的代理（容忍连续漏报，避免探测抖动误杀端口）。
  for (const [key, entry] of [...proxies.entries()]) {
    if (wanted.has(key)) {
      entry.misses = 0
      continue
    }
    entry.misses = (entry.misses ?? 0) + 1
    if (entry.misses >= PROXY_MISS_GRACE) {
      closeProxy(entry)
      proxies.delete(key)
    }
  }

  // 2) 新增缺失的代理；已存在的更新 MOTD（复用端口）。
  for (const [key, target] of wanted.entries()) {
    const existing = proxies.get(key)
    if (existing) {
      existing.target.motd = target.motd
      // 同步最新的上游解析器：转发口变化时，代理要能解析到新口。
      existing.target.resolveUpstream = target.resolveUpstream
      existing.target.connectHost = target.connectHost
      existing.target.connectPort = target.connectPort
      existing.misses = 0
      continue
    }
    try {
      const entry = await startProxy(target)
      proxies.set(key, entry)
    } catch (err) {
      console.warn(`[联机] 建立本地代理失败（${key}）：`, err)
    }
  }

  // 组播公告按开关决定；代理始终保留，保证世界列表里的地址始终可连。
  // 关闭公告时 stopEmit 会清掉发送套接字，emitOnce 自然不再发送。
  if (announce && proxies.size > 0) ensureEmit()
  else stopEmit()
  return { count: proxies.size }
}

/** 停止全部局域网广播并关闭代理（幂等）。 */
export function stopLanBroadcast(): void {
  running = false
  for (const entry of proxies.values()) closeProxy(entry)
  proxies.clear()
  stopEmit()
}

/** 当前代理数量（供界面展示 / 诊断）。 */
export function lanBroadcastCount(): number {
  return proxies.size
}

/**
 * 取某个世界对应的**可连接地址**（本地代理口）。`ip:port` 为世界的虚拟地址。
 *
 * 世界列表拿它作为「复制 / 直连」用地址：只有这个 `127.0.0.1:<代理口>` 能真正进入
 * 世界（虚拟 IP 在 `--no-tun` 下不可路由）。未建立代理时返回 null。
 */
export function proxyAddressFor(ip: string, port: number): { host: string; port: number } | null {
  const entry = proxies.get(`${ip}:${port}`)
  if (!entry || !entry.alive) return null
  return { host: '127.0.0.1', port: entry.localPort }
}

/* ------------------------------------------------------------------ */
/* Minecraft Server List Ping（发现世界 + 展示信息）                     */
/* ------------------------------------------------------------------ */

/** 写 VarInt（MC 协议基础编码）。 */
function writeVarInt(value: number): Buffer {
  const bytes: number[] = []
  let v = value >>> 0
  for (;;) {
    if ((v & ~0x7f) === 0) {
      bytes.push(v)
      break
    }
    bytes.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  return Buffer.from(bytes)
}

function readVarInt(buf: Buffer, offset: number): { value: number; size: number } | null {
  let value = 0
  let size = 0
  for (;;) {
    if (offset + size >= buf.length || size > 5) return null
    const b = buf[offset + size]
    value |= (b & 0x7f) << (7 * size)
    size += 1
    if ((b & 0x80) === 0) return { value, size }
  }
}

/** 从状态 JSON 的 description（可能是字符串或富文本对象）里抽出纯文本 MOTD。 */
function extractMotd(desc: unknown): string {
  if (typeof desc === 'string') return desc
  if (desc && typeof desc === 'object') {
    const d = desc as { text?: unknown; extra?: unknown }
    let out = typeof d.text === 'string' ? d.text : ''
    if (Array.isArray(d.extra)) {
      for (const e of d.extra) out += extractMotd(e)
    }
    return out
  }
  return ''
}

/**
 * 对单个 `host:port` 做 Server List Ping，成功返回世界信息。
 * 失败（超时 / 非 MC 服务 / 协议异常）返回 null。
 *
 * `host` 既可以是虚拟 IP（同物理网），也可以是 EasyTier 转发出来的
 * `127.0.0.1`（跨网络时的实际可达地址）。
 */
export function pingServer(ip: string, port: number): Promise<LanWorld | null> {
  if (!isProbeHost(ip)) return Promise.resolve(null)
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = connect({ host: ip, port })
    let settled = false
    let buffer = Buffer.alloc(0)
    const done = (result: LanWorld | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }
    const timer = setTimeout(() => done(null), SLP_TIMEOUT_MS + 500)

    socket.on('error', () => done(null))
    socket.on('connect', () => {
      socket.setNoDelay(true)
      // Handshake：protocol=-1（仅状态查询）、next state=1。
      const host = Buffer.from(ip, 'utf8')
      const portBuf = Buffer.alloc(2)
      portBuf.writeUInt16BE(port, 0)
      const handshake = Buffer.concat([
        writeVarInt(0x00),
        writeVarInt(-1 & 0xffffffff),
        writeVarInt(host.length),
        host,
        portBuf,
        writeVarInt(1)
      ])
      socket.write(Buffer.concat([writeVarInt(handshake.length), handshake]))
      const req = Buffer.from([0x00])
      socket.write(Buffer.concat([writeVarInt(req.length), req]))
    })
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      // 解析：packetLen → packetId → jsonLen → json
      const lenField = readVarInt(buffer, 0)
      if (!lenField) return
      if (buffer.length < lenField.size + lenField.value) return
      const body = buffer.subarray(lenField.size)
      const idField = readVarInt(body, 0)
      if (!idField) return
      const jsonLen = readVarInt(body, idField.size)
      if (!jsonLen) return
      const start = idField.size + jsonLen.size
      const end = start + jsonLen.value
      if (end > body.length) return
      try {
        const data = JSON.parse(body.subarray(start, end).toString('utf8')) as {
          version?: { name?: unknown }
          players?: { online?: unknown; max?: unknown }
          description?: unknown
        }
        done({
          ip,
          port,
          motd: extractMotd(data.description),
          version: typeof data.version?.name === 'string' ? data.version.name : '',
          players: {
            online: Number(data.players?.online ?? 0) || 0,
            max: Number(data.players?.max ?? 0) || 0
          },
          latencyMs: Date.now() - started
        })
      } catch {
        done(null)
      }
    })
  })
}

/** 探测目标：`host:port` 是实际可达地址，`displayIp` / `displayPort` 是对外展示信息。 */
export interface ScanTarget {
  host: string
  port: number
  /** 展示用虚拟 IP；缺省等于 host。 */
  displayIp?: string
  /**
   * 展示 / 连接用的**真实世界端口**；缺省等于探测端口。
   *
   * 为什么必须单独给：跨网络时探测的是「本地转发口」（`127.0.0.1:<随机口>`），
   * 它只对探测这一刻有效。若把它当成世界端口带出去，世界列表就会显示成
   * `虚拟IP:<本机转发口>`，后续代理也会按这个不存在的端口拨号 —— 表现为
   * 「局域网里能看到世界，点进去却连接超时」。真实端口即房主「对局域网开放」的端口。
   */
  displayPort?: number
}

/** 并发扫描多个目标，返回所有可达的世界（按延迟升序）。 */
export async function scanLanWorlds(
  targets: ScanTarget[],
  defaultPort = 25565
): Promise<LanWorld[]> {
  const seen = new Set<string>()
  const jobs: Array<Promise<LanWorld | null>> = []
  for (const t of targets) {
    const port = Number.isInteger(t.port) && t.port > 0 ? t.port : defaultPort
    if (!isProbeHost(t.host)) continue
    const key = `${t.host}:${port}`
    if (seen.has(key)) continue
    seen.add(key)
    jobs.push(
      pingServer(t.host, port).then((w) => {
        if (!w) return w
        // 用展示信息覆盖探测地址：`host:port` 是本地转发口，对外必须还原成
        // `虚拟IP:真实世界端口`，否则世界列表和代理都会指向打不通的转发口。
        return {
          ...w,
          ip: t.displayIp ?? w.ip,
          port: t.displayPort ?? w.port
        }
      })
    )
  }
  const results = await Promise.all(jobs)
  return results.filter((r): r is LanWorld => r !== null).sort((a, b) => a.latencyMs - b.latencyMs)
}

// ---------------------------------------------------------------------------
// 语音中继（经 EasyTier UDP 端口转发）。
//
// ── 为什么不用 WebRTC ────────────────────────────────────────────────
// 之前语音走 WebRTC mesh，媒体是**点对点 UDP**，靠 ICE 找到双方直达的路径。
// 但本项目的 EasyTier 是 `--no-tun`（不创建虚拟网卡），系统里**没有** 10.126.126.0/24
// 的路由，WebRTC 的 host 候选只有物理网卡地址，于是：
//   - 同一物理局域网：能直连，语音可用；
//   - 跨网络：找不到任何直达路径（又没有 TURN 中继），语音必然不通。
// 这正是「语音聊天无法使用」的架构性根因。
//
// ── 本模块做什么 ────────────────────────────────────────────────────
// 把语音数据改走 EasyTier 已经打通的那条通道 —— **UDP 端口转发**：
//   `easytier-cli port-forward add udp 127.0.0.1:<本地口> <对端虚拟IP>:VOICE_PORT`
// 于是本机只要往 `127.0.0.1:<本地口>` 发 UDP，就等价于经 overlay 发到对端的 VOICE_PORT。
//
// 收发两端的分工（与信令层同一套机制）：
//   - 发送：本模块为每个成员建一条转发，往转发出来的本地口发数据；
//   - 接收：本模块绑定 **0.0.0.0:VOICE_PORT**。`--no-tun` 下 EasyTier 用用户态协议栈
//     终止入站报文并投递给本地同端口套接字（绑 0.0.0.0 覆盖到 127.0.0.1），
//     报文源地址即对端的虚拟 IP —— 据此还原「这条音频来自哪位成员」。
//
// 只做传输：编解码在渲染层（Opus / WebCodecs），本模块不关心音频内容。
// ---------------------------------------------------------------------------

import dgram from 'dgram'
import { ensurePortForward } from './easytier'

/**
 * 语音中继端口（固定值）。
 *
 * 必须固定：对端的转发目标是 `<本机虚拟IP>:VOICE_PORT`，两端要能互相投递就得用同一端口。
 * 取 47800，与信令端口 47777 错开。
 */
export const VOICE_PORT = 47800

/** 成员虚拟 IP 的校验（与 easytier / lan-bridge 一致）。 */
function isVirtualIp(ip: string): boolean {
  const m = /^10\.126\.126\.(\d{1,3})$/.exec((ip ?? '').trim())
  if (!m) return false
  const last = Number(m[1])
  return last >= 1 && last <= 254
}

/** 解析 `127.0.0.1:12345` 形式的转发本地绑定。 */
function parseBind(bind: string): { host: string; port: number } | null {
  const m = /^(.+):(\d{1,5})$/.exec(bind.trim())
  if (!m) return null
  const port = Number(m[2])
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { host: m[1], port }
}

let socket: dgram.Socket | null = null
/** 正在绑定套接字的进行中 Promise（避免并发重复绑定）。 */
let binding: Promise<void> | null = null
/** 收到某成员的音频时回调（peerId = 语音标识 voiceId）。 */
let listener: ((peerId: string, data: Buffer) => void) | null = null

/** peerId → 虚拟 IP。 */
const vipOf = new Map<string, string>()
/** 虚拟 IP → peerId（入站报文靠它还原发送者）。 */
const idOfVip = new Map<string, string>()
/** peerId → 发送用的本地转发口。 */
const sendTargets = new Map<string, { host: string; port: number }>()

/** 注册「收到音频」回调（由主进程转发给渲染层的语音引擎）。 */
export function setVoiceRelayListener(fn: ((peerId: string, data: Buffer) => void) | null): void {
  listener = fn
}

/** 确保中继套接字已绑定（幂等、可并发调用）。 */
function ensureSocket(): Promise<void> {
  if (socket) return Promise.resolve()
  if (binding) return binding
  binding = new Promise<void>((resolve) => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    s.on('message', (buf, rinfo) => {
      const id = idOfVip.get(rinfo.address)
      // 只有已知成员才交给上层：避免任意来源的 UDP 被当成语音。
      if (id) listener?.(id, buf)
    })
    s.on('error', (err) => {
      console.warn('[语音中继] 套接字错误：', err.message)
    })
    s.bind(VOICE_PORT, '0.0.0.0', () => {
      socket = s
      resolve()
    })
  }).finally(() => {
    binding = null
  })
  return binding
}

/**
 * 同步成员列表：为新增成员建立 UDP 转发，移除已离开成员的登记。
 *
 * 成员变化（加入 / 离开 / 虚拟 IP 补齐）时由上层反复调用，这里是增量的。
 */
export async function syncVoiceRelay(peers: Array<{ id: string; virtualIp: string }>): Promise<void> {
  const wanted = new Map<string, string>()
  for (const p of peers ?? []) {
    if (p && p.id && isVirtualIp(p.virtualIp)) wanted.set(p.id, p.virtualIp.trim())
  }
  // 没有任何可中继的成员时不必占用端口。
  if (wanted.size === 0 && !socket) return
  await ensureSocket()

  // 1) 移除已离开 / 虚拟 IP 失效的成员。
  for (const id of [...vipOf.keys()]) {
    if (wanted.get(id) === vipOf.get(id)) continue
    const old = vipOf.get(id)
    if (old) idOfVip.delete(old)
    vipOf.delete(id)
    sendTargets.delete(id)
  }

  // 2) 新增 / 更新转发。
  for (const [id, vip] of wanted) {
    if (vipOf.get(id) === vip && sendTargets.has(id)) continue
    vipOf.set(id, vip)
    idOfVip.set(vip, id)
    const bind = await ensurePortForward('udp', vip, VOICE_PORT)
    if (!bind) continue
    const target = parseBind(bind)
    if (target) sendTargets.set(id, target)
  }
}

/** 向指定成员发送一帧音频（UDP）。未建立转发时静默丢弃。 */
export function sendVoiceAudio(peerId: string, data: Buffer): void {
  const s = socket
  const target = sendTargets.get(peerId)
  if (!s || !target) return
  try {
    s.send(data, target.port, target.host, () => undefined)
  } catch {
    /* 单个包发送失败不致命 */
  }
}

/** 停止中继并清空登记（退出大厅时调用，幂等）。 */
export function stopVoiceRelay(): void {
  const s = socket
  socket = null
  if (s) {
    try {
      s.close()
    } catch {
      /* 已关闭 */
    }
  }
  vipOf.clear()
  idOfVip.clear()
  sendTargets.clear()
}

/** 当前中继是否在运行（供诊断）。 */
export function voiceRelayActive(): boolean {
  return socket !== null
}

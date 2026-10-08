// ---------------------------------------------------------------------------
// 正版 / 第三方玩家信息查询与服务器状态查询（网络进程侧）。
//
// 使用 uapis.cn 的「我的世界」系列接口（免登录，填写 KEY 可提高额度）：
//   玩家信息：GET https://uapis.cn/api/v1/game/minecraft/userinfo?username=<玩家名>
//             返回：{ username, uuid, skin_url, cape_url? }（cape_url 仅当玩家有披风时返回）
//   服务器状态：GET https://uapis.cn/api/v1/game/minecraft/serverstatus?server=<地址>[&port=<端口>]
//             返回：{ online, players, max_players, motd_html, motd_clean, favicon_url, ip, port, version }
//
// 说明：部分服务器接口不返回 MOTD（仅返回 online/players/favicon），此时本模块会退回
//       「直接查询」——自行发起一次 Minecraft Server List Ping（TCP SLP）补全 MOTD 与人数。
//
// 目的：为没有本地 skinUrl 的正版 / 第三方账号补全皮肤地址，供头像本地合成
// （含帽子外层）与 3D 模型使用；并在实例页展示服务器名 / MOTD（彩色）/ 在线人数。
// KEY 走 Authorization 头（与翻译接口一致）。
// ---------------------------------------------------------------------------

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

const UAPI_USERINFO_URL = 'https://uapis.cn/api/v1/game/minecraft/userinfo'
const UAPI_SERVERSTATUS_URL = 'https://uapis.cn/api/v1/game/minecraft/serverstatus'

/** 单次请求超时（毫秒）。 */
const TIMEOUT = 12_000

function log(...args: unknown[]): void {
  console.log('[玩家信息]', ...args)
}

export interface MinecraftUserInfo {
  /** 玩家名（回显，可能与查询名大小写不同）。 */
  username: string
  /** 无连字符的 UUID（查不到时为空串）。 */
  uuid: string
  /** 皮肤贴图地址（textures.minecraft.net/... ；查不到时为空串）。 */
  skinUrl: string
  /** 披风贴图地址（仅当玩家有披风时接口才返回，否则为空串）。 */
  capeUrl: string
}

/**
 * 查询玩家信息：名字 → UUID 与皮肤 / 披风贴图地址。
 * apiKey 为空时使用访客额度；查询失败（玩家不存在 / 网络异常）抛出可读异常。
 */
export async function fetchMinecraftUserinfo(name: string, apiKey?: string): Promise<MinecraftUserInfo> {
  const username = String(name ?? '').trim()
  if (!username) throw new Error('玩家名为空')
  const url = `${UAPI_USERINFO_URL}?username=${encodeURIComponent(username)}`
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    signal: AbortSignal.timeout(TIMEOUT)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as { username?: string; uuid?: string; skin_url?: string; cape_url?: string }
  const uuid = typeof data.uuid === 'string' ? data.uuid.replace(/-/g, '') : ''
  const skinUrl = typeof data.skin_url === 'string' ? data.skin_url : ''
  const capeUrl = typeof data.cape_url === 'string' ? data.cape_url : ''
  if (!uuid && !skinUrl) {
    log(`未查询到玩家：${username}`)
    throw new Error('未查询到该玩家')
  }
  return { username: data.username ?? username, uuid, skinUrl, capeUrl }
}

export interface MinecraftServerStatus {
  /** 服务器是否在线。 */
  online: boolean
  /** 当前在线人数。 */
  players: number
  /** 服务器最大容量。 */
  maxPlayers: number
  /** 纯文本 MOTD（已去除颜色与格式代码）。 */
  motdClean: string
  /** HTML MOTD（保留颜色与样式，渲染层将做白名单净化后再展示）。 */
  motdHtml: string
  /** 服务器图标（Base64 Data URI，可能为空）。 */
  faviconUrl: string
  /** 服务器解析后的 IP。 */
  ip: string
  /** 服务器端口。 */
  port: number
  /** 服务器报告的版本信息。 */
  version: string
}

/**
 * 解析「地址[:端口]」为用户填写的一行服务器地址。
 * 支持形如 `mc.example.com`、`mc.example.com:25565`、`192.168.1.2:25566`。
 */
function splitAddress(raw: string): { host: string; port: string } {
  const address = String(raw ?? '').trim()
  if (!address) return { host: '', port: '' }
  const idx = address.lastIndexOf(':')
  // IPv6 形如 [::1]:25565 不含在此处理范围；仅在形如 host:port 时拆分。
  if (idx > 0 && idx < address.length - 1 && /^\d+$/.test(address.slice(idx + 1))) {
    return { host: address.slice(0, idx), port: address.slice(idx + 1) }
  }
  return { host: address, port: '' }
}

/**
 * 查询服务器状态：地址（可含端口）→ 在线状态 / 在线人数 / MOTD / 图标。
 *
 * 优先走 uapis.cn 接口；若接口返回成功但**缺少 MOTD**（部分服务器接口不返回，
 * 例如仅返回 online/players/favicon），则退回「直接查询」——自行做一次
 * Minecraft Server List Ping（TCP SLP）补全 MOTD 与人数。两条路径都失败才抛出异常。
 * apiKey 为空时使用访客额度。
 */
export async function fetchMinecraftServerStatus(address: string, apiKey?: string): Promise<MinecraftServerStatus> {
  const raw = String(address ?? '').trim()
  if (!raw) throw new Error('服务器地址为空')
  const { host, port } = splitAddress(raw)
  if (!host) throw new Error('服务器地址为空')
  const portNum = port ? Number(port) : 25565
  const query = `server=${encodeURIComponent(host)}${port ? `&port=${encodeURIComponent(port)}` : ''}`

  let api: MinecraftServerStatus | null = null
  try {
    const res = await fetch(`${UAPI_SERVERSTATUS_URL}?${query}`, {
      headers: {
        'User-Agent': UA,
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      signal: AbortSignal.timeout(TIMEOUT)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as {
      online?: boolean
      players?: number
      max_players?: number
      motd_clean?: string
      motd_html?: string
      favicon_url?: string
      ip?: string
      port?: number
      version?: string
    }
    api = {
      online: data.online === true,
      players: typeof data.players === 'number' ? data.players : 0,
      maxPlayers: typeof data.max_players === 'number' ? data.max_players : 0,
      motdClean: typeof data.motd_clean === 'string' ? data.motd_clean : '',
      motdHtml: typeof data.motd_html === 'string' ? data.motd_html : '',
      faviconUrl: typeof data.favicon_url === 'string' ? data.favicon_url : '',
      ip: typeof data.ip === 'string' ? data.ip : '',
      port: typeof data.port === 'number' ? data.port : 0,
      version: typeof data.version === 'string' ? data.version : ''
    }
  } catch (err) {
    log(`接口查询失败，尝试直接查询：${(err as Error)?.message ?? err}`)
  }

  // 接口可用且已带 MOTD：直接返回。
  if (api && (api.motdClean || api.motdHtml)) return api

  // 接口缺 MOTD（或接口失败）：直接 SLP 补全。
  try {
    const direct = await pingServerList(host, portNum)
    if (api) {
      // 合并：接口有的人数 / 图标优先，MOTD 用直连结果补上。
      return {
        ...api,
        motdClean: api.motdClean || direct.motdClean,
        motdHtml: api.motdHtml || direct.motdHtml,
        players: api.players || direct.players,
        maxPlayers: api.maxPlayers || direct.maxPlayers,
        online: api.online || direct.online,
        version: api.version || direct.version
      }
    }
    return direct
  } catch (err) {
    if (api) return api
    throw err
  }
}

/* ------------------------------------------------------------------ */
/* 直连「服务器列表查询」（Minecraft Server List Ping, TCP）            */
/* ------------------------------------------------------------------ */

/** SLP 直连超时（毫秒）。 */
const SLP_TIMEOUT = 8_000

/** 写入 Minecraft VarInt（用于包长度与协议字段）。 */
function writeVarInt(value: number): Buffer {
  const bytes: number[] = []
  let v = value >>> 0
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v !== 0) b |= 0x80
    bytes.push(b)
  } while (v !== 0)
  return Buffer.from(bytes)
}

/** 由 SLP 的 description 构造纯文本与彩色 HTML。 */
function buildMotd(description: unknown): { clean: string; html: string } {
  if (typeof description === 'string') {
    const clean = stripSection(description)
    return { clean, html: legacyMotdToHtml(description) }
  }
  if (description && typeof description === 'object') {
    const parts: string[] = []
    const htmlParts: string[] = []
    const walk = (node: unknown): void => {
      if (typeof node === 'string') {
        parts.push(node)
        htmlParts.push(escapeHtml(node))
        return
      }
      if (Array.isArray(node)) {
        for (const n of node) walk(n)
        return
      }
      if (node && typeof node === 'object') {
        const obj = node as { text?: unknown; color?: unknown; bold?: unknown; italic?: unknown; extra?: unknown }
        const t = typeof obj.text === 'string' ? obj.text : ''
        parts.push(t)
        if (t) {
          const styles: string[] = []
          if (typeof obj.color === 'string' && /^#?[0-9a-f]{3,8}$/i.test(obj.color)) {
            styles.push(`color:${obj.color.startsWith('#') ? obj.color : `#${obj.color}`}`)
          }
          if (obj.bold === true) styles.push('font-weight:700')
          if (obj.italic === true) styles.push('font-style:italic')
          htmlParts.push(styles.length ? `<span style="${styles.join(';')}">${escapeHtml(t)}</span>` : escapeHtml(t))
        }
        if (obj.extra) walk(obj.extra)
      }
    }
    walk(description)
    return { clean: parts.join(''), html: htmlParts.join('') }
  }
  return { clean: '', html: '' }
}

/** 去除 § 颜色/格式代码，得到纯文本。 */
function stripSection(text: string): string {
  return text.replace(/[§&][0-9a-fk-orA-FK-OR]/g, '')
}

/** HTML 转义。 */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 把带 § 代码的旧版 MOTD 文本转换为彩色 HTML（与游戏 16 色对应）。 */
function legacyMotdToHtml(text: string): string {
  const COLORS: Record<string, string> = {
    '0': '#000000', '1': '#0000AA', '2': '#00AA00', '3': '#00AAAA',
    '4': '#AA0000', '5': '#AA00AA', '6': '#FFAA00', '7': '#AAAAAA',
    '8': '#555555', '9': '#5555FF', a: '#55FF55', b: '#55FFFF',
    c: '#FF5555', d: '#FF55FF', e: '#FFFF55', f: '#FFFFFF'
  }
  let color = ''
  let bold = false
  let italic = false
  let out = ''
  const chars = Array.from(text)
  let buf = ''
  const flush = (): void => {
    if (!buf) return
    const style = `${color ? `color:${color};` : ''}${bold ? 'font-weight:700;' : ''}${italic ? 'font-style:italic;' : ''}`
    out += style ? `<span style="${style}">${escapeHtml(buf)}</span>` : escapeHtml(buf)
    buf = ''
  }
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if ((ch === '§' || ch === '&') && i + 1 < chars.length) {
      const code = chars[i + 1].toLowerCase()
      if (code in COLORS) { flush(); color = COLORS[code]; bold = false; italic = false; i++; continue }
      if (code === 'l') { flush(); bold = true; i++; continue }
      if (code === 'o') { flush(); italic = true; i++; continue }
      if (code === 'r') { flush(); color = ''; bold = false; italic = false; i++; continue }
      i++
      continue
    }
    if (ch === '\n') { flush(); out += '<br />'; continue }
    buf += ch
  }
  flush()
  return out
}

/**
 * 直接向服务器发起一次 Server List Ping，取得 MOTD / 在线人数 / 版本。
 *
 * 采用现代（1.7+）协议：Handshake(0x00) → Status Request(0x00) → 读取 JSON 响应。
 * 仅用于接口未返回 MOTD 时补全；超时 / 无法连接时抛出异常，由调用方兜底。
 */
function pingServerList(host: string, port: number): Promise<MinecraftServerStatus> {
  // 动态引入，避免在不需要直连时加载 net 模块。
  const net = require('net') as typeof import('net')
  return new Promise<MinecraftServerStatus>((resolve, reject) => {
    const socket = net.connect({ host, port })
    const chunks: Buffer[] = []
    let settled = false
    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.destroy() } catch { /* ignore */ }
      fn()
    }
    const timer = setTimeout(() => done(() => reject(new Error('直连查询超时'))), SLP_TIMEOUT)

    socket.on('connect', () => {
      const hostBuf = Buffer.from(host, 'utf8')
      const portBuf = Buffer.alloc(2)
      portBuf.writeUInt16BE(port)
      const protocol = writeVarInt(763) // 1.20.1；服务器不校验，仅需合法 varint
      const handshakeBody = Buffer.concat([
        Buffer.from([0x00]),
        writeVarInt(hostBuf.length),
        hostBuf,
        portBuf,
        protocol
      ])
      const handshake = Buffer.concat([writeVarInt(handshakeBody.length), handshakeBody])
      const statusRequest = Buffer.from([0x01, 0x00])
      socket.write(handshake)
      socket.write(statusRequest)
    })

    socket.on('data', (d) => {
      chunks.push(d)
      const text = Buffer.concat(chunks).toString('utf8')
      const start = text.indexOf('{')
      const end = text.lastIndexOf('}')
      if (start < 0 || end <= start) return
      let json: {
        description?: unknown
        players?: { online?: number; max?: number }
        version?: { name?: string }
        favicon?: string
      }
      try {
        json = JSON.parse(text.slice(start, end + 1))
      } catch {
        return // 数据未收全，继续等
      }
      const { clean, html } = buildMotd(json.description)
      done(() =>
        resolve({
          online: true,
          players: typeof json.players?.online === 'number' ? json.players.online : 0,
          maxPlayers: typeof json.players?.max === 'number' ? json.players.max : 0,
          motdClean: clean,
          motdHtml: html,
          faviconUrl: typeof json.favicon === 'string' ? json.favicon : '',
          ip: '',
          port,
          version: typeof json.version?.name === 'string' ? json.version.name : ''
        })
      )
    })

    socket.on('error', (err) => done(() => reject(err)))
    socket.on('close', () => done(() => reject(new Error('连接已关闭'))))
  })
}

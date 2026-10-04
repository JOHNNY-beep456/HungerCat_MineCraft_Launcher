import { spawn, execFile, execFileSync, type ChildProcess } from 'child_process'
import { promises as fsp } from 'fs'
import { join } from 'path'
import { createServer } from 'net'
import dgram from 'dgram'
import { ensureRuntimeCore, easytierRuntimeDir, locateEasytierCli } from './resources'

/**
 * EasyTier 子进程管理。
 *
 * 移植自 MCTier 的 `modules/network_service.rs`（约 2460 行）。原实现最复杂之处在于
 * Windows 提权 helper（runas + loopback 属主认证 + 封闭请求枚举）。Electron 侧
 * 无法等价调用 `ShellExecuteEx(runas)`，因此这里以「直接 spawn」为主：
 *   - 若启动器本身已是管理员，EasyTier 能正常创建虚拟网卡；
 *   - 否则启动会失败并返回可读提示，引导用户以管理员身份运行启动器。
 * 这保留了原版的核心安全姿态（不整体提权、不做任意命令执行）。
 */

/** 虚拟网段：MCTier 客户端默认使用的 10.126.126.0/24。 */
const VIRTUAL_NET_PREFIX = '10.126.126.'
/**
 * 虚拟域名后缀（Magic DNS zone）。
 *
 * 与 lobby.ts 的 `VIRTUAL_DOMAIN_SUFFIX` 必须保持一致；这里独立定义是为了避免
 * mobile/easytier 与 lobby 互相 import 形成循环依赖。
 */
const VIRTUAL_DOMAIN_SUFFIX = 'mct.net'
/** 启动超时：等不到组网就绪就判定失败。 */
const START_TIMEOUT_MS = 10_000

/**
 * 当前进程是否以管理员 / root 运行。
 *
 * 已改用「无 TUN」模式（不创建虚拟网卡），因此组网本身不再需要管理员权限。
 * 该检测仅用于界面提示，便于用户在需要其它特权操作时自行判断。
 */
export function isElevated(): boolean {
  if (process.platform !== 'win32') {
    // 类 Unix：root 的 uid 为 0
    return typeof process.getuid === 'function' ? process.getuid() === 0 : false
  }
  try {
    // Windows：net session 只有管理员权限才能成功执行。
    execFileSync(join(systemRoot(), 'System32', 'net.exe'), ['session'], {
      stdio: 'ignore',
      windowsHide: true
    })
    return true
  } catch {
    return false
  }
}

/** Windows 系统目录（用于定位 System32 下的系统命令）。 */
function systemRoot(): string {
  return process.env['SystemRoot'] ?? 'C:\\Windows'
}

export interface StartOptions {
  /** 大厅名（会拼成 EasyTier 网络名 MCTier-<name>）。 */
  lobbyName: string
  /** 大厅密码（作为 EasyTier network-secret）。 */
  password: string
  /** EasyTier 节点地址，如 udp://us01.225284.xyz:11010。 */
  serverNode: string
  /** 本机在大厅中显示的主机名。 */
  hostname: string
  /** 虚拟域名（可选，配置在 EasyTier 的 --tld-dns-zone 等高级项时使用）。 */
  useDomain?: boolean
  /** 高级配置映射出的额外参数。 */
  advancedArgs?: string[]
}

export interface EasyTierSession {
  pid: number
  virtualIp: string
  rpcPort: number
  /** 本节点在 EasyTier 网络里的主机名（已按 core 规则小写并过滤特殊字符）。 */
  hostname: string
  stop: () => Promise<void>
}

/** 当前会话（同一时刻只允许一个大厅）。 */
let current: { child: ChildProcess; rpcPort: number; configDir: string } | null = null

/** 生成一个空闲的本地端口，用于 EasyTier RPC。 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

/**
 * 从 EasyTier 的输出里解析分配到的虚拟 IP。
 * 只接受 10.126.126.1-254 网段，避免误抓到公网地址（与原版一致）。
 */
export function parseVirtualIp(text: string): string | null {
  const re = /(10\.126\.126\.\d{1,3})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const last = Number(m[1].split('.')[3])
    // .0 是网段地址、.255 是广播地址，都不能用
    if (last >= 1 && last <= 254) return m[1]
  }
  return null
}

/** 把 EasyTier 的退出码 / 输出翻译成可操作的提示。 */
function describeFailure(code: number | null, output: string): string {
  const admin = describeAdminHint(output)
  if (admin) return admin
  if (code === 577 || /577/.test(output)) {
    return '系统组件校验失败（错误 577）。请重启后再试。'
  }
  if (code === 10013 || /10013/.test(output)) {
    return '端口被占用或权限不足（错误 10013）。请关闭冲突程序或以管理员身份运行。'
  }
  if (/network name|network-secret|password/i.test(output)) {
    return '大厅名称或密码不正确，无法加入该网络。'
  }
  if (/timeout|timed out|超时/i.test(output)) {
    return '连接 EasyTier 节点超时，请检查网络或更换节点。'
  }
  return output.trim().split('\n').slice(-4).join('\n') || `EasyTier 异常退出（代码 ${code ?? '未知'}）`
}

/**
 * 判断输出里是否出现「虚拟网卡创建失败 / 权限不足」的迹象。
 *
 * 没有管理员权限时 EasyTier 的网络层仍能连上节点，但创建 tun 网卡会失败，
 * 进程不会退出 —— 表现为「一直不出虚拟 IP」。提前识别可以立刻给出可操作的提示，
 * 而不是让用户干等 60 秒。
 */
function describeAdminHint(output: string): string | null {
  if (/Access is denied|拒绝访问|ERROR_ACCESS_DENIED|os error 5\b/i.test(output)) {
    return '创建虚拟网卡被拒绝。请以管理员身份运行启动器后重试。'
  }
  if (/failed to create.*(tun|adapter|device)|CreateAdapter|WintunCreateAdapter.*fail/i.test(output)) {
    return '创建虚拟网卡失败。请以管理员身份运行启动器后重试。'
  }
  if (/requires? admin|administrator privileges|elevation required|need.*root/i.test(output)) {
    return '组网需要管理员权限。请以管理员身份运行启动器后重试。'
  }
  return null
}

/**
 * 启动 EasyTier 并等待组网就绪。
 *
 * 与 Rust 版一致的关键参数：network-name / network-secret / peers / hostname /
 * rpc-portal / listeners / default-protocol，并强制 aes-256-gcm 加密。
 * 再叠加 `--no-tun` + `--dhcp true`：不创建虚拟网卡（因此不需要管理员权限），
 * 但仍由 DHCP 分配 10.126.126.x 虚拟地址用于寻址。
 */
export async function startEasytier(opts: StartOptions): Promise<EasyTierSession> {
  if (current) await stopEasytier()

  const core = await ensureRuntimeCore()
  const rpcPort = await findFreePort()
  // EasyTier 不会自建 config 目录，目录不存在时会直接以
  // 「Start log filter reloader error: config_dir ... is not a directory」退出，
  // 因此必须先建好再传给 --config-dir。
  const configDir = join(easytierRuntimeDir(), `config_${Date.now()}`)
  await fsp.mkdir(configDir, { recursive: true })

  // 监听器用显式端口：端口 0（系统自动分配）可能落入 Windows(Hyper-V/Docker winnat)
  // 的保留端口段，触发 os error 10013（与原版一致的做法）。
  const listenerPort = await findFreePort().catch(() => 0)
  const isWsPeer = /^wss?:\/\//.test(opts.serverNode)
  const listener = isWsPeer ? `ws://0.0.0.0:${listenerPort}/` : `udp://0.0.0.0:${listenerPort}`
  // hostname 只保留字母数字与 - _，并转小写（原版同样处理，Magic DNS 依赖它）。
  const hostname = opts.hostname.replace(/[^\p{L}\p{N}_-]/gu, '').toLowerCase() || 'player'

  const args = [
    '--network-name',
    `MCTier-${opts.lobbyName}`,
    '--network-secret',
    opts.password,
    '--peers',
    opts.serverNode,
    '--hostname',
    hostname,
    '--instance-name',
    `hungercat-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
    '--config-dir',
    configDir,
    '--rpc-portal',
    `127.0.0.1:${rpcPort}`,
    '--listeners',
    listener,
    '--default-protocol',
    isWsPeer ? 'ws' : 'udp',
    // 不创建 TUN 虚拟网卡：无需管理员权限，也不会改动系统网络配置。
    '--no-tun',
    // DHCP 必须显式开启：EasyTier 默认不会自动分配地址，光有 --no-tun 会拿不到虚拟 IP
    // （实测无 --dhcp 时永远不出现 10.126.126.x，只能等超时）。
    // 与 MCTier 一致，由 EasyTier 自动协商 10.126.126.x 网段地址。
    '--dhcp',
    'true',
    // 强制 AES-256-GCM：与 MCTier 客户端保持一致，避免明文组网。
    '--encryption-algorithm',
    'aes-256-gcm'
  ]
  // 虚拟域名：开启后启用 EasyTier 的 Magic DNS，并为本次会话指定 DNS 后缀。
  // 成员间即可用 `<主机名>.<后缀>` 互相寻址（无 TUN 模式下由 EasyTier 组件提供解析）。
  if (opts.useDomain) {
    args.push('--tld-dns-zone', VIRTUAL_DOMAIN_SUFFIX)
  }
  if (opts.advancedArgs?.length) args.push(...opts.advancedArgs)

  const child = spawn(core, args, {
    cwd: easytierRuntimeDir(),
    windowsHide: true,
    env: { ...process.env }
  })

  return new Promise<EasyTierSession>((resolve, reject) => {
    let settled = false
    let buffered = ''

    const finish = (err: Error | null, session?: EasyTierSession): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) {
        try {
          child.kill()
        } catch {
          /* 已退出 */
        }
        reject(err)
      } else if (session) {
        resolve(session)
      }
    }

    const timer = setTimeout(() => {
      const hint = describeAdminHint(buffered)
      finish(
        new Error(
          `组建虚拟局域网超时（${START_TIMEOUT_MS / 1000} 秒内未连上对等节点）。${
            hint ?? '请检查节点是否可用，或更换「设置 → 联机设置」中的 EasyTier 节点。'
          }`
        )
      )
    }, START_TIMEOUT_MS)

    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString('utf8')
      // 以 DHCP 分配到的虚拟 IP 为准（实测开启 --dhcp 后 1-2 秒内即出现）。
      const ip = parseVirtualIp(buffered)
      if (ip) {
        current = { child, rpcPort, configDir }
        finish(null, {
          pid: child.pid ?? 0,
          virtualIp: ip,
          rpcPort,
          hostname,
          stop: stopEasytier
        })
        return
      }
      // 权限 / 网卡类错误时进程不会退出，提前失败，避免用户干等超时。
      const hint = describeAdminHint(buffered)
      if (hint) finish(new Error(hint))
    }

    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    child.on('error', (err) => {
      finish(new Error(`无法启动 EasyTier 内核：${err.message}`))
    })

    child.on('exit', (code) => {
      if (settled) return
      finish(new Error(describeFailure(code, buffered)))
    })
  })
}

/** 停止当前的 EasyTier 会话（幂等）。 */
export async function stopEasytier(): Promise<void> {
  const c = current
  current = null
  // 核心一停，端口转发随之失效：清空本地登记，避免下次会话复用陈旧绑定。
  clearPortForwards()
  if (!c) return
  try {
    c.child.kill()
  } catch {
    /* 已退出 */
  }
  // 与 Rust 版一致：兜底清理可能残留的 easytier-core 进程。
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/F', '/IM', 'easytier-core.exe'], { windowsHide: true })
      killer.on('exit', () => resolve())
      killer.on('error', () => resolve())
    })
  }
}

/** 当前是否已有正在运行的大厅会话。 */
export function isEasytierRunning(): boolean {
  return current !== null
}

/** EasyTier 虚拟网络里的一个成员（来自路由表）。 */
export interface EasyTierPeer {
  /** 成员主机名（等于该玩家被规范化的名字，仅小写字母数字等）。 */
  hostname: string
  /** 成员虚拟 IPv4（10.126.126.x；尚未分配时为空串）。 */
  ipv4: string
}

/**
 * 判断路由表里的一条记录是否为「真实玩家」。
 *
 * 为什么需要过滤：`easytier-cli route` 返回的是**整个网络的节点表**，
 * 其中既有真实成员，也有 EasyTier 的**基础设施节点**（公共中继 / 服务器，
 * 名字形如 `PublicServer_WIN-JN6PUF54PQR_server`、`EasyTier-*` 等）。
 * 这些节点没有虚拟 IP、也不属于大厅，若一并当成玩家，成员列表就会出现
 * 一堆「不存在的在线成员」（且永远停在「分配中…」）。
 *
 * 判定依据（与其实验室逆向 + 实测一致）：
 *   1. 真实玩家一定持有 10.126.126.x 虚拟 IP；基础设施节点通常没有；
 *   2. 基础设施节点的主机名带明显的服务端特征。
 */
export function isRealPlayerPeer(hostname: string, ipv4: string): boolean {
  const host = hostname.trim()
  // 必须先剥掉可能的 CIDR 后缀（`easytier-cli route -o json` 实测返回
  // `10.126.126.1/24` 而非纯 IP），否则正则匹配不到、**所有真实玩家都会被误过滤**，
  // 表现为「成员列表永远为空 / 看不到加入房间的其他玩家」。
  const ip = stripCidr(ipv4)
  // 必须有本网络虚拟 IP：无 IP 的条目无法用于任何连线，也不可能是玩家。
  if (!/^10\.126\.126\.(\d{1,3})$/.test(ip)) return false
  const last = Number(ip.split('.')[3])
  if (last < 1 || last > 254) return false
  // 主机名带基础设施特征的一律排除。
  if (/publicserver|easytier|_server$|^server$|relay/i.test(host)) return false
  return true
}

/**
 * 去掉 IPv4 的 CIDR 后缀，把 `10.126.126.1/24` 归一化为 `10.126.126.1`。
 *
 * EasyTier 的 route 表把 `ipv4` 字段输出为带掩码的形式（实测 `10.126.126.1/24`），
 * 而后续所有地址比较 / 拼接 / 端口转发都只接受纯 IP。集中在这里归一化，
 * 避免每个调用点各写一遍（漏掉一处就会出现「成员莫名消失」）。
 */
export function stripCidr(value: string): string {
  return value.trim().split('/')[0]?.trim() ?? ''
}

/**
 * 读取 EasyTier 虚拟网络的**全部成员**（跨局域网，不依赖 UDP 广播）。
 *
 * 原理：core 启动时带了 `--rpc-portal 127.0.0.1:<rpcPort>`，`easytier-cli route -o json`
 * 会连上该 RPC 并把路由表（= 网络内所有节点，含各自 hostname 与虚拟 IP）以 JSON 返回。
 * 这是跨网络发现成员最可靠的来源：局域网 UDP 广播在 `--no-tun` 下无法穿过 overlay，
 * 而路由表由 EasyTier 自己维护，无论成员在哪个网络都能看到。
 *
 * 失败（CLI 不存在 / RPC 未就绪 / 输出不可解析）时返回空数组，由调用方忽略本轮。
 */
export async function listEasyTierPeers(): Promise<EasyTierPeer[]> {
  const c = current
  if (!c) return []
  const cli = locateEasytierCli()
  if (!cli) return []

  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      cli,
      ['-p', `127.0.0.1:${c.rpcPort}`, '-o', 'json', 'route'],
      { windowsHide: true, timeout: 4000, maxBuffer: 8 * 1024 * 1024 },
      (err, out) => (err ? reject(err) : resolve(String(out)))
    )
  })

  // 稳妥起见只截取第一个 '[' 到最后一个 ']' 之间的内容，避免日志/ANSI 混入导致解析失败。
  const start = stdout.indexOf('[')
  const end = stdout.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e) => ({
      hostname: String(e['hostname'] ?? '').trim(),
      // 归一化：route 表返回的是 `10.126.126.1/24` 这种带掩码形式，统一剥成纯 IP，
      // 否则后续虚拟 IP 比较 / 端口转发都会因「带 /24」而匹配失败。
      ipv4: stripCidr(String(e['ipv4'] ?? ''))
    }))
    // 过滤掉中继 / 服务器等基础设施节点，只保留真实玩家（见 isRealPlayerPeer）。
    .filter((p) => isRealPlayerPeer(p.hostname, p.ipv4))
}

/* ------------------------------------------------------------------ */
/* 端口转发（--no-tun 下访问虚拟 IP 的唯一途径）                          */
/* ------------------------------------------------------------------ */
//
// ── 为什么必须有它 ──────────────────────────────────────────────────
// `--no-tun` 不创建 TUN 网卡，因此**操作系统路由表里没有 10.126.126.0/24**。
// 任何直接往虚拟 IP 发包 / 连 TCP 的操作都不会被 EasyTier 接管，而是被系统
// 按「无路由」静默丢弃 —— 这正是「成员看不到、聊天/语音无反应、世界检测为空」
// 的共同根因。
//
// EasyTier 对无 TUN 场景给出的官方途径是**端口转发**：把本地的一个端口绑定到
// 「虚拟网络中的某个 远端IP:端口」，由核心内部完成投递。CLI 支持运行时增删：
//   easytier-cli port-forward add <tcp|udp> <本地绑定> <远端虚拟地址>
//
// 因此：本地代码只要往 `127.0.0.1:<本端转发端口>` 收发，就等于经由 overlay
// 与对端通信。信令（UDP）与 MC 世界连接（TCP）都改走这条通道。

/** 转发规则：以 `proto|bind|dst` 为键做去重，重复添加无副作用。 */
const activeForwards = new Map<string, { protocol: 'tcp' | 'udp'; bind: string; dst: string }>()

/** 生成一个本机空闲 UDP/TCP 端口（转发绑定的本地端口）。 */
function freePort(protocol: 'tcp' | 'udp'): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = protocol === 'tcp' ? createServer() : dgram.createSocket('udp4')
    const done = (port: number): void => {
      try {
        if (protocol === 'tcp') (srv as ReturnType<typeof createServer>).close()
        else (srv as dgram.Socket).close()
      } catch {
        /* 已关闭 */
      }
      resolve(port)
    }
    ;(srv as unknown as { on: (e: string, cb: (err: Error) => void) => void }).on('error', reject)
    if (protocol === 'tcp') {
      ;(srv as ReturnType<typeof createServer>).listen(0, '127.0.0.1', () => {
        const a = (srv as ReturnType<typeof createServer>).address()
        done(typeof a === 'object' && a ? a.port : 0)
      })
    } else {
      ;(srv as dgram.Socket).bind(0, '127.0.0.1', () => {
        done((srv as dgram.Socket).address().port)
      })
    }
  })
}

/** 调用 easytier-cli 的 port-forward 子命令。 */
function cliPortForward(args: string[]): Promise<void> {
  const c = current
  const cli = locateEasytierCli()
  if (!c || !cli) return Promise.reject(new Error('EasyTier 未运行或缺少 CLI'))
  return new Promise((resolve, reject) => {
    execFile(
      cli,
      ['-p', `127.0.0.1:${c.rpcPort}`, 'port-forward', ...args],
      { windowsHide: true, timeout: 4000, maxBuffer: 1024 * 1024 },
      (err, out, errOut) => {
        if (err) {
          reject(new Error(String(errOut || out || err.message).trim() || 'port-forward 失败'))
          return
        }
        resolve()
      }
    )
  })
}

/**
 * 建立一条「本地端口 → 虚拟网络远端」的转发，返回本地可用的 `127.0.0.1:端口`。
 *
 * 同一 (proto, dst) 复用已有绑定：成员反复加入/离开时不会不断堆叠转发规则。
 */
export async function ensurePortForward(
  protocol: 'tcp' | 'udp',
  dstIp: string,
  dstPort: number
): Promise<string | null> {
  if (!current) return null
  if (!isVirtualIp(dstIp)) return null
  const dst = `${dstIp}:${dstPort}`

  // 已存在同样的转发：直接复用其本地绑定。
  for (const rule of activeForwards.values()) {
    if (rule.protocol === protocol && rule.dst === dst) return rule.bind
  }

  let localPort: number
  try {
    localPort = await freePort(protocol)
  } catch {
    return null
  }
  const bind = `127.0.0.1:${localPort}`
  try {
    await cliPortForward(['add', protocol, bind, dst])
  } catch (err) {
    console.warn(`[联机] 建立端口转发失败（${protocol} ${bind} → ${dst}）：`, err)
    return null
  }
  activeForwards.set(`${protocol}|${bind}|${dst}`, { protocol, bind, dst })
  return bind
}

/** 移除一条转发（成员离开时调用；失败不影响主流程）。 */
export async function removePortForward(protocol: 'tcp' | 'udp', bind: string, dstIp: string, dstPort: number): Promise<void> {
  const dst = `${dstIp}:${dstPort}`
  const key = `${protocol}|${bind}|${dst}`
  if (!activeForwards.has(key)) return
  activeForwards.delete(key)
  try {
    await cliPortForward(['remove', protocol, bind, dst])
  } catch {
    /* 转发可能已随核心退出而消失，忽略 */
  }
}

/** 清空全部转发登记（停止组网时调用）。 */
export function clearPortForwards(): void {
  activeForwards.clear()
}

/**
 * 查询「已建立的 (协议, 目标) 转发」当前的本地绑定地址。
 *
 * 世界代理在**每次玩家连接时**用它现场解析上游：转发若因任何原因被重建，
 * 本地口可能变化，代理必须拨到最新口，否则会 Connection refused。
 * 未建立时返回 null（调用方可即时 ensurePortForward 后再取）。
 */
export function portForwardBindFor(
  protocol: 'tcp' | 'udp',
  dstIp: string,
  dstPort: number
): string | null {
  const dst = `${dstIp}:${dstPort}`
  for (const rule of activeForwards.values()) {
    if (rule.protocol === protocol && rule.dst === dst) return rule.bind
  }
  return null
}

/**
 * 只保留给定协议下、目标地址在 `keepDsts` 里的转发，删除其余。
 *
 * 用途：世界端口变化后，旧的「TCP → 旧端口」转发不再需要。若不清掉，转发规则
 * 会随每次改端口不断堆积（EasyTier 侧最多几百条），既浪费资源也可能拖慢转发判定，
 * 表现为「改了端口却没生效 / 列表不刷新」。扫描类转发由本函数按当前探测集合收敛。
 */
export async function retainPortForwards(
  protocol: 'tcp' | 'udp',
  keepDsts: Set<string>
): Promise<void> {
  const stale: Array<{ bind: string; dst: string }> = []
  for (const rule of activeForwards.values()) {
    if (rule.protocol !== protocol) continue
    if (keepDsts.has(rule.dst)) continue
    stale.push({ bind: rule.bind, dst: rule.dst })
  }
  for (const s of stale) {
    const key = `${protocol}|${s.bind}|${s.dst}`
    activeForwards.delete(key)
    try {
      await cliPortForward(['remove', protocol, s.bind, s.dst])
    } catch {
      /* 转发可能已随核心退出而消失，忽略 */
    }
  }
}

/** 判断是否为受支持虚拟网段的 IPv4。 */
function isVirtualIp(ip: string): boolean {
  const m = /^10\.126\.126\.(\d{1,3})$/.exec(ip.trim())
  if (!m) return false
  const last = Number(m[1])
  return last >= 1 && last <= 254
}


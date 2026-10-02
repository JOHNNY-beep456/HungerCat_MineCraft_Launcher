import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { promises as fsp } from 'fs'
import { join } from 'path'
import { createServer } from 'net'
import { ensureRuntimeCore, easytierRuntimeDir } from './resources'

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
    return '虚拟网卡驱动签名校验失败（错误 577）。请确认 wintun.dll 完整，或重启后再试。'
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

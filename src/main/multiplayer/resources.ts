import { app } from 'electron'
import { existsSync, promises as fsp } from 'fs'
import { basename, join } from 'path'

/**
 * 联机板块的第三方二进制资源管理。
 *
 * 移植自 MCTier 的 `modules/resource_manager.rs`：原实现会把 easytier-core / easytier-cli
 * 等内嵌进可执行文件，运行时提取并做完整性校验。Electron 侧改为「随 extraResources
 * 打包 + 按路径定位」。
 *
 * 目录约定：
 *   打包后  process.resourcesPath/easytier/
 *   开发时  <repo>/resources/easytier/
 *
 * 只用到两个二进制：easytier-core（组网内核）与 easytier-cli（查询虚拟网络成员）。
 * 组网统一以 `--no-tun` 运行（见 easytier.ts），不创建虚拟网卡，因此**不再需要**
 * wintun.dll / WinDivert64.sys；随包分发的 core/cli 由
 * scripts/build-easytier-npcap-free.ps1 从源码构建（已移除 packet.dll 静态导入，
 * 不依赖 Npcap）。easytier-core.vendor/ 下的官方版仅作本机调试占位，不会被打包。
 */

const isWin = process.platform === 'win32'
const CORE_NAME = isWin ? 'easytier-core.exe' : 'easytier-core'
const CLI_NAME = isWin ? 'easytier-cli.exe' : 'easytier-cli'

/** 资源根目录（打包后 / 开发时）。 */
export function easytierResourceDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'easytier')
    : join(app.getAppPath(), 'resources', 'easytier')
}

/**
 * 运行时可写目录：EasyTier 需要可写的 cwd / config 目录，而安装目录（如 Program Files）
 * 通常不可写，因此把 core 复制到这里再启动。
 */
export function easytierRuntimeDir(): string {
  return join(app.getPath('userData'), 'easytier-runtime')
}

/** 查找某个二进制：优先正式位置，回落 vendor 占位目录（仅开发期调试用）。 */
function locate(name: string): string | null {
  const root = easytierResourceDir()
  const candidates = [join(root, name), join(root, 'easytier-core.vendor', name)]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

/**
 * 定位 easytier-cli（用于查询虚拟网络成员，见 easytier.ts 的 listEasyTierPeers）。
 *
 * CLI 是独立可执行文件，直接返回资源目录里的路径即可，不必复制到运行时可写目录。
 * 找不到时返回 null，由调用方优雅降级（成员列表为空，但不影响组网本身）。
 */
export function locateEasytierCli(): string | null {
  return locate(CLI_NAME)
}

export interface BinaryStatus {
  /** 二进制名 → 是否就绪。 */
  present: Record<string, boolean>
  /** 缺失的二进制名。 */
  missing: string[]
  /** 校验不通过的文件名（当前不启用哈希校验，恒为空，保留字段以兼容界面）。 */
  corrupted: string[]
  /** 资源目录（用于提示用户放文件的位置）。 */
  dir: string
  /** 是否可以启动组网（core 与 cli 均就绪）。 */
  ready: boolean
  /** 不可用时的可读原因。 */
  reason: string
}

/** 检查 core / cli 是否就绪。 */
export async function checkBinaries(): Promise<BinaryStatus> {
  const names = [CORE_NAME, CLI_NAME]
  const present: Record<string, boolean> = {}
  const missing: string[] = []

  for (const name of names) {
    const ok = locate(name) !== null
    present[name] = ok
    if (!ok) missing.push(name)
  }

  const required = [CORE_NAME, CLI_NAME]
  const missingRequired = required.filter((n) => !present[n])
  const ready = missingRequired.length === 0

  const reason = ready
    ? ''
    : `缺少联机所需文件：${missingRequired.join('、')}。请在仓库根目录运行 ` +
      `scripts/build-easytier-npcap-free.ps1 生成无 Npcap 的 EasyTier 内核后重试。`

  return { present, missing, corrupted: [], dir: easytierResourceDir(), ready, reason }
}

/**
 * 把 EasyTier 内核复制到运行时可写目录，返回 core 的可执行路径。
 *
 * 已存在且大小一致时跳过复制；写入用「临时文件 + 重命名」，避免中断留下半个文件。
 */
export async function ensureRuntimeCore(): Promise<string> {
  const coreSrc = locate(CORE_NAME)
  if (!coreSrc) {
    throw new Error(
      `未找到 EasyTier 内核（${CORE_NAME}）。请运行 scripts/build-easytier-npcap-free.ps1 生成后重试。`
    )
  }

  const dir = easytierRuntimeDir()
  await fsp.mkdir(dir, { recursive: true })

  const dst = join(dir, basename(coreSrc))
  let upToDate = false
  if (existsSync(dst)) {
    try {
      const [srcStat, dstStat] = await Promise.all([fsp.stat(coreSrc), fsp.stat(dst)])
      upToDate = srcStat.size === dstStat.size
    } catch {
      upToDate = false
    }
  }
  if (!upToDate) {
    const tmp = `${dst}.tmp-${process.pid}`
    await fsp.copyFile(coreSrc, tmp)
    await fsp.rename(tmp, dst)
  }

  if (!existsSync(dst)) throw new Error('EasyTier 内核复制失败。')
  if (!isWin) await fsp.chmod(dst, 0o755).catch(() => undefined)
  return dst
}
import { app } from 'electron'
import { createHash } from 'crypto'
import { existsSync, promises as fsp } from 'fs'
import { basename, join } from 'path'

/**
 * 联机板块的第三方二进制资源管理。
 *
 * 移植自 MCTier 的 `modules/resource_manager.rs`：原实现用 `include_bytes!` 把
 * easytier-core / easytier-cli / wintun.dll / WinDivert64.sys 内嵌进可执行文件，
 * 运行时提取并做 SHA-256 校验。Electron 侧改为「随 extraResources 打包 + 按路径定位」，
 * 保留同样的完整性校验思路。
 *
 * 目录约定：
 *   打包后  process.resourcesPath/easytier/
 *   开发时  <repo>/resources/easytier/
 * 其中官方版 easytier-core/cli 放在 easytier-core.vendor/ 子目录（含 Npcap 静态导入，
 * 仅作本机调试占位、不随包分发），正式版应放在根目录。
 */

/** 期望的 SHA-256（来自 EasyTier 官方 v2.5.0 windows-x86_64 发布包）。 */
const EXPECTED_SHA256: Record<string, string> = {
  'wintun.dll': 'e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce',
  'WinDivert64.sys': '8da085332782708d8767bcace5327a6ec7283c17cfb85e40b03cd2323a90ddc2',
  'easytier-core.exe': 'a47b63a7763fb4ccf9d56f3a7e936163619c89a1e34c9d1e84022375a7d2711f',
  'easytier-cli.exe': '83a31b18cb92436bfd6d85c4a22b27594fb5a2ec7bb1e46adf9245ebd935667b'
}

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
 * 运行时可写目录：wintun.dll / WinDivert64.sys 必须与 easytier-core.exe 同目录才会被加载，
 * 而安装目录通常不可写，因此把 core 连同驱动一起复制到 userData 下再启动。
 */
export function easytierRuntimeDir(): string {
  return join(app.getPath('userData'), 'easytier-runtime')
}

async function sha256File(p: string): Promise<string> {
  const buf = await fsp.readFile(p)
  return createHash('sha256').update(buf).digest('hex')
}

/** 查找某个二进制：先看正式位置，再回落到 vendor 占位目录。 */
function locate(name: string): string | null {
  const root = easytierResourceDir()
  const candidates = [join(root, name), join(root, 'easytier-core.vendor', name)]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

export interface BinaryStatus {
  /** 二进制名 → 是否就绪。 */
  present: Record<string, boolean>
  /** 缺失的二进制名。 */
  missing: string[]
  /** 校验不通过（哈希不匹配）的二进制名。 */
  corrupted: string[]
  /** 资源目录（用于提示用户放文件的位置）。 */
  dir: string
  /** 是否可以启动组网（core + wintun 必须就绪）。 */
  ready: boolean
  /** 不可用时的可读原因。 */
  reason: string
}

/** 检查全部二进制是否就绪并校验完整性。 */
export async function checkBinaries(): Promise<BinaryStatus> {
  const names = isWin
    ? ['easytier-core.exe', 'easytier-cli.exe', 'wintun.dll', 'WinDivert64.sys']
    : ['easytier-core', 'easytier-cli']
  const present: Record<string, boolean> = {}
  const missing: string[] = []
  const corrupted: string[] = []

  for (const name of names) {
    const p = locate(name)
    if (!p) {
      present[name] = false
      missing.push(name)
      continue
    }
    present[name] = true
    const expected = EXPECTED_SHA256[name]
    if (expected) {
      try {
        const actual = await sha256File(p)
        if (actual !== expected) corrupted.push(name)
      } catch {
        corrupted.push(name)
      }
    }
  }

  const corePath = locate(CORE_NAME)
  const required = isWin ? [CORE_NAME, 'wintun.dll'] : [CORE_NAME]
  const missingRequired = required.filter((n) => !present[n])
  const ready = missingRequired.length === 0 && corrupted.length === 0

  let reason = ''
  if (missingRequired.length > 0) {
    reason = `缺少组网所需文件：${missingRequired.join('、')}。请运行 scripts/prepare-easytier-binaries.mjs 准备。`
  } else if (corrupted.length > 0) {
    reason = `文件校验未通过：${corrupted.join('、')}。请重新准备。`
  } else if (!corePath) {
    reason = '未找到 EasyTier 内核。'
  }

  return { present, missing, corrupted, dir: easytierResourceDir(), ready, reason }
}

/**
 * 把 EasyTier 内核与其依赖的驱动复制到运行时可写目录，返回 core 的可执行路径。
 *
 * 原 Rust 版把内嵌二进制提取到 runtime 目录并原子落盘 + 校验；这里同样复制 + 校验，
 * 只是来源换成了打包资源。已存在且哈希一致时跳过复制。
 */
export async function ensureRuntimeCore(): Promise<string> {
  const coreSrc = locate(CORE_NAME)
  if (!coreSrc) {
    throw new Error(
      `未找到 EasyTier 内核（${CORE_NAME}）。请运行 scripts/prepare-easytier-binaries.mjs 准备后重试。`
    )
  }

  const dir = easytierRuntimeDir()
  await fsp.mkdir(dir, { recursive: true })

  // core 必带；Windows 还需要 wintun.dll（EasyTier 用它创建虚拟网卡）。
  const needed = isWin ? [CORE_NAME, 'wintun.dll'] : [CORE_NAME]
  for (const name of needed) {
    const src = locate(name)
    if (!src) {
      if (name === 'wintun.dll') {
        throw new Error('未找到 wintun.dll，无法创建虚拟网卡。请重新准备 EasyTier 二进制。')
      }
      continue
    }
    const dst = join(dir, basename(src))
    let upToDate = false
    if (existsSync(dst)) {
      const expected = EXPECTED_SHA256[name]
      try {
        const [a, b] = await Promise.all([sha256File(dst), sha256File(src)])
        upToDate = expected ? a === b : a === b
      } catch {
        upToDate = false
      }
    }
    if (!upToDate) {
      // 先写临时文件再重命名：避免复制中途被打断留下半个文件（原 Rust 版同样如此）。
      const tmp = `${dst}.tmp-${process.pid}`
      await fsp.copyFile(src, tmp)
      await fsp.rename(tmp, dst)
    }
  }

  const core = join(dir, CORE_NAME)
  if (!existsSync(core)) throw new Error('EasyTier 内核复制失败。')
  if (!isWin) await fsp.chmod(core, 0o755).catch(() => undefined)
  return core
}

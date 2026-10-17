import { readdir, stat, mkdir, copyFile, readFile, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'

/**
 * 安装期的文件操作。
 *
 * 载荷里含 `resources/app.asar`。Electron 会把**路径中含 `.asar`** 的 fs 调用
 * 拦截、当成 asar 归档去解析，于是对普通文件 `app.asar` 做 stat / 复制会误报
 * `ENOENT`（纯 Node 没有这层拦截，所以同样代码在 Node 下正常）。复制期间临时
 * 设 `process.noAsar = true` 绕开，结束立刻恢复。
 *
 * 这一点在「安装器套在启动器里」之后**更要紧**：载荷从 `resources/payload`
 * （一个子目录）变成了应用自身所在目录，`app.asar` 就是正在运行的这套文件的一部分。
 */

/** 临时关闭 Electron 的 asar 拦截后执行文件系统操作。 */
export async function withNoAsar<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.noAsar
  process.noAsar = true
  try {
    return await fn()
  } finally {
    process.noAsar = prev
  }
}

/** 载荷的文件数量与总字节数（用于进度与 EstimatedSize）。 */
export interface PayloadSize {
  count: number
  bytes: number
}

/** 递归统计目录下的文件数量与总字节数。 */
export async function measure(dir: string): Promise<PayloadSize> {
  return withNoAsar(() => measureRaw(dir))
}

async function measureRaw(dir: string): Promise<PayloadSize> {
  let count = 0
  let bytes = 0
  const entries = await readdir(dir, { withFileTypes: true })
  for (const ent of entries) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) {
      const sub = await measureRaw(p)
      count += sub.count
      bytes += sub.bytes
    } else {
      count += 1
      try {
        bytes += (await stat(p)).size
      } catch {
        /* 单个文件 stat 失败不影响整体统计 */
      }
    }
  }
  return { count, bytes }
}

/**
 * 递归复制目录，按「已复制文件数 / 总数」回报进度。
 *
 * 用 `copyFile` 而非 `fs.cp`，以便逐文件计数上报进度。取消时抛 `CANCELLED`，
 * 由调用方识别（见 install.ts）。
 */
export async function copyTree(
  src: string,
  dest: string,
  onProgress: (name: string) => void,
  isCancelled: () => boolean
): Promise<void> {
  return withNoAsar(() => copyTreeRaw(src, dest, onProgress, isCancelled))
}

/** 判断错误是否为文件被占用（Windows 上的 EBUSY/EPERM/ENOENT）。 */
function isBusyError(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException | undefined
  if (!e?.code) return false
  return e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'ENOENT'
}

/**
 * 复制单个文件，带多重兜底。
 *
 * 便携包（Setup.exe）运行时，其临时解压目录里的部分文件（如 chrome_100_percent.pak、
 * icudtl.dat 等）会被进程自身以 FILE_SHARE_READ 模式锁定，`fs.copyFile` 在 Windows 上
 * 调用 CopyFile API 会因此失败（EBUSY: resource busy or locked）。
 *
 * 兜底策略：
 *   1. 先尝试 `copyFile`（最快，绝大多数文件走此路径）
 *   2. 若失败，尝试 `readFile` + `writeFile`（以流式方式读取，某些被锁定文件仍可复制）
 *   3. 若仍失败，检查目标文件是否已存在且大小相同 —— 若是，说明是覆盖安装且
 *      内容一致，跳过；否则抛出错误
 */
async function copyFileSafe(s: string, d: string): Promise<void> {
  try {
    await copyFile(s, d)
    return
  } catch {
    /* 落到下面的 fallback */
  }

  // fallback 1：二进制读写（对部分被锁定的文件有效）
  try {
    const buf = await readFile(s)
    await writeFile(d, buf)
    return
  } catch {
    /* 落到下面的 fallback */
  }

  // fallback 2：覆盖安装时目标已有同大小文件则跳过
  try {
    const [srcStat, dstStat] = await Promise.all([stat(s), stat(d)])
    if (srcStat.size === dstStat.size) {
      return
    }
  } catch {
    /* 目标不存在，落到最终抛出 */
  }

  // 最终：抛出原始错误，让上层感知
  await copyFile(s, d)
}

async function copyTreeRaw(
  src: string,
  dest: string,
  onProgress: (name: string) => void,
  isCancelled: () => boolean
): Promise<void> {
  await mkdir(dest, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const ent of entries as Dirent[]) {
    if (isCancelled()) throw new Error('CANCELLED')
    const s = join(src, ent.name)
    const d = join(dest, ent.name)
    if (ent.isDirectory()) {
      await copyTreeRaw(s, d, onProgress, isCancelled)
    } else {
      await copyFileSafe(s, d)
      onProgress(ent.name)
    }
  }
}
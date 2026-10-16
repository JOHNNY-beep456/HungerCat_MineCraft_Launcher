import { readdir, stat, mkdir, copyFile } from 'node:fs/promises'
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
      await copyFile(s, d)
      onProgress(ent.name)
    }
  }
}
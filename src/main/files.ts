// ---------------------------------------------------------------------------
// 启动器自实现的资源管理器（只做「浏览 + 打开」）。
//
// 为什么要有它：Win10 桌面模式过去会把 explorer.exe 的窗口搬进启动器桌面，
// 而资源管理器窗口的标题栏画在客户区里（XAML 岛），被搬动 / 遮蔽后必须抖动尺寸
// 才能恢复渲染表面 —— 是「移动窗口崩溃 / 白屏」的主要来源。现在不再捕获它，
// 需要看目录时用这里列出的数据在启动器自己的窗口里呈现。
//
// 这里只提供只读浏览 + 打开（浏览、进目录、打开文件、在系统资源管理器中定位），
// 不做删除 / 重命名 / 移动这类破坏性操作。
// ---------------------------------------------------------------------------

import { app, shell } from 'electron'
import { promises as fs } from 'fs'
import type { Dirent } from 'fs'
import { join } from 'path'
import type { FileEntry, FilePlace } from '@shared/types'

/** Windows 盘符探测范围 */
const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

/** 把 `C:` 这类裸盘符补成 `C:\`（readdir 需要带分隔符才能读到根） */
function normalizeDir(path: string): string {
  const p = (path ?? '').trim()
  if (!p) return p
  if (/^[a-zA-Z]:$/.test(p)) return p + '\\'
  return p
}

/** 把 fs 的错误码翻译成中文说明（渲染层直接展示） */
function describeFsError(err: unknown, path: string): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') return new Error(`路径不存在或已被移动：${path}`)
  if (code === 'EACCES' || code === 'EPERM') return new Error(`没有权限访问：${path}`)
  if (code === 'ENOTDIR') return new Error(`这不是一个目录：${path}`)
  if (code === 'EBUSY') return new Error(`该位置正被占用：${path}`)
  return new Error(`打开失败：${path}${code ? `（${code}）` : ''}`)
}

/** 列出驱动器 + 常用位置（游戏目录等由调用方从设置里取，排在最前） */
export async function listPlaces(extra: FilePlace[] = []): Promise<FilePlace[]> {
  const places: FilePlace[] = extra.filter((p) => !!p.path)
  const home = app.getPath('home')
  const downloads = app.getPath('downloads')
  const userData = app.getPath('userData')
  places.push({ name: '下载', path: downloads, kind: 'place' }, { name: '用户目录', path: home, kind: 'place' })

  if (process.platform === 'win32') {
    const found = await Promise.all(
      DRIVE_LETTERS.map(async (letter): Promise<FilePlace | null> => {
        const root = `${letter}:\\`
        try {
          await fs.access(root)
          return { name: `${letter}: 盘`, path: root, kind: 'drive' }
        } catch {
          return null
        }
      })
    )
    for (const d of found) if (d) places.push(d)
  } else {
    places.push({ name: '根目录', path: '/', kind: 'drive' })
  }

  // 启动器数据目录放最后：排查自定义主页 / 配置时用得上
  places.push({ name: '启动器数据', path: userData, kind: 'place' })
  return places
}

/** 列出一个目录（目录在前，再按名称自然序）。 */
export async function listDir(inputPath: string): Promise<FileEntry[]> {
  const dir = normalizeDir(inputPath)
  let dirents: Dirent[]
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    throw describeFsError(err, dir)
  }

  const entries = await Promise.all(
    dirents.map(async (d): Promise<FileEntry | null> => {
      const full = join(dir, d.name)
      let isDir = d.isDirectory()
      // 符号链接 / junction：跟一次 stat 判断真实类型（MC 的目录里偶尔有链接）
      if (d.isSymbolicLink()) {
        try {
          isDir = (await fs.stat(full)).isDirectory()
        } catch {
          return null
        }
      }
      let size = 0
      let mtime = 0
      try {
        const st = await fs.stat(full)
        size = isDir ? 0 : st.size
        mtime = st.mtimeMs
      } catch {
        // 取不到元信息（权限 / 已被删除）也要列出来，只是没有大小与时间
      }
      return { name: d.name, path: full, isDir, size, mtime }
    })
  )

  return entries
    .filter((e): e is FileEntry => e !== null)
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
    })
}

/** 用系统默认程序打开（返回空串 = 成功，否则为错误说明） */
export async function openPath(path: string): Promise<string> {
  return shell.openPath(path)
}

/** 在系统资源管理器中定位（应急出口；桌面模式下该窗口不会被搬进桌面） */
export function revealPath(path: string): void {
  shell.showItemInFolder(path)
}

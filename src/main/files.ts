// ---------------------------------------------------------------------------
// 启动器自实现的资源管理器。
//
// 为什么要有它：Win10 桌面模式过去会把 explorer.exe 的窗口搬进启动器桌面，
// 而资源管理器窗口的标题栏画在客户区里（XAML 岛），被搬动 / 遮蔽后必须抖动尺寸
// 才能恢复渲染表面 —— 是「移动窗口崩溃 / 白屏」的主要来源。现在不再捕获它，
// 需要看目录时用这里列出的数据在启动器自己的窗口里呈现。
//
// 能力：浏览、进目录、打开文件、在系统资源管理器中定位；以及改名 / 新建空文件 /
// 删除 / 读写文本（内置编辑器）。破坏性操作都由界面二次确认，这里只做校验与执行。
// 不做移动 / 复制 —— 那是跨目录搬运，交给系统资源管理器更稳妥。
// ---------------------------------------------------------------------------

import { app, shell } from 'electron'
import { promises as fs } from 'fs'
import type { Dirent } from 'fs'
import { join } from 'path'
import type { FileEntry, FilePlace } from '@shared/types'

/** Windows 盘符探测范围 */
const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

/** 内置编辑器能打开的文本文件大小上限（再大就不往文本框里塞了） */
const MAX_TEXT_BYTES = 2 * 1024 * 1024

/** 把 `C:` 这类裸盘符补成 `C:\`（readdir 需要带分隔符才能读到根） */
function normalizeDir(path: string): string {
  const p = (path ?? '').trim()
  if (!p) return p
  if (/^[a-zA-Z]:$/.test(p)) return p + '\\'
  return p
}

/** 把 fs 的错误码翻译成中文说明（渲染层直接展示）。verb 是动作词，保证句子读得通。 */
function describeFsError(err: unknown, path: string, verb = '打开'): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') return new Error(`路径不存在或已被移动：${path}`)
  if (code === 'EACCES' || code === 'EPERM') return new Error(`没有权限${verb === '打开' ? '访问' : verb}：${path}`)
  if (code === 'ENOTDIR') return new Error(`这不是一个目录：${path}`)
  if (code === 'EBUSY') return new Error(`该位置正被占用：${path}`)
  if (code === 'ENOTEMPTY') return new Error(`目录不是空的：${path}`)
  return new Error(`${verb}失败：${path}${code ? `（${code}）` : ''}`)
}

/** 校验「名字」部分（改名 / 新建共用），返回去掉首尾空白后的名字。 */
function validateName(rawName: string): string {
  const name = (rawName ?? '').trim()
  if (!name) throw new Error('名称不能为空')
  if (name === '.' || name === '..') throw new Error('名称不合法')
  if (/[\\/]/.test(name)) throw new Error('名称里不能包含路径分隔符')
  if (/[<>:"|?*]/.test(name)) throw new Error('名称里不能包含这些字符：< > : " | ? *')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) throw new Error('名称里不能包含控制字符')
  if (/[. ]$/.test(name)) throw new Error('名称不能以点或空格结尾')
  if (name.length > 255) throw new Error('名称过长')
  return name
}

/** 把「目录 + 名字」拼成完整路径（自动补齐分隔符）。 */
function joinName(dir: string, name: string): string {
  const base = normalizeDir(dir)
  if (!base) throw new Error('目录无效')
  const sep = base.includes('\\') ? '\\' : '/'
  return base.endsWith(sep) ? base + name : base + sep + name
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

/* ------------------------------------------------------------------ */
/* 写操作（右键菜单：改名 / 新建 / 删除 / 编辑）                        */
/* 全部只做校验 + 执行；二次确认由界面负责。                             */
/* ------------------------------------------------------------------ */

/** 改名（只换同一目录下的名字，不移动）。返回新路径。 */
export async function renameEntry(target: string, rawName: string): Promise<string> {
  const name = validateName(rawName)
  const sep = target.includes('\\') ? '\\' : '/'
  const idx = target.lastIndexOf(sep)
  if (idx < 0) throw new Error(`无法解析所在目录：${target}`)
  const full = target.slice(0, idx + 1) + name
  if (full === target) return full

  // Windows 上 fs.rename 不会覆盖已存在的目标，会抛 EPERM —— 先自己给一句人话。
  // 只改大小写（Foo.txt → foo.txt）时同名不算冲突，直接放行。
  if (full.toLowerCase() !== target.toLowerCase()) {
    try {
      await fs.access(full)
      throw new Error(`同级下已存在「${name}」`)
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('同级下已存在')) throw err
      // ENOENT：目标不存在，可以改名
    }
  }

  try {
    await fs.rename(target, full)
  } catch (err) {
    throw describeFsError(err, target, '重命名')
  }
  return full
}

/** 在目录下新建一个空文件。返回新路径。 */
export async function createFile(dir: string, rawName: string): Promise<string> {
  const name = validateName(rawName)
  const full = joinName(dir, name)
  try {
    // wx：已存在同名文件时直接失败，绝不覆盖
    await fs.writeFile(full, '', { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`已存在同名文件：${name}`)
    throw describeFsError(err, full, '新建')
  }
  return full
}

/** 删除文件或目录（目录连同里面的内容一起删）。 */
export async function removeEntry(target: string): Promise<void> {
  if (!target || !target.trim()) throw new Error('路径无效')
  // 兜底：绝不允许把盘符根目录整个删掉
  if (/^[a-zA-Z]:[\\/]?$/.test(target.trim()) || target.trim() === '/') {
    throw new Error('不能删除驱动器根目录')
  }
  // 用 lstat：符号链接 / junction 当作「链接本身」删掉，绝不递归进它指向的位置
  let isDir: boolean
  try {
    isDir = (await fs.lstat(target)).isDirectory()
  } catch (err) {
    throw describeFsError(err, target, '删除')
  }
  try {
    if (isDir) await fs.rm(target, { recursive: true, force: false })
    else await fs.unlink(target)
  } catch (err) {
    throw describeFsError(err, target, '删除')
  }
}

/** 读取文本文件给内置编辑器用；二进制 / 过大的文件会被拒绝。 */
export async function readText(target: string): Promise<{ content: string; size: number; mtime: number }> {
  let st: Awaited<ReturnType<typeof fs.stat>>
  try {
    st = await fs.stat(target)
  } catch (err) {
    throw describeFsError(err, target, '读取')
  }
  if (st.isDirectory()) throw new Error('这是一个目录，不能当文件编辑')
  if (st.size > MAX_TEXT_BYTES) {
    throw new Error(`文件超过 ${MAX_TEXT_BYTES / 1024 / 1024} MB，内置编辑器打不开，请用系统程序打开`)
  }

  let buf: Buffer
  try {
    buf = await fs.readFile(target)
  } catch (err) {
    throw describeFsError(err, target, '读取')
  }
  // 含 NUL 字节基本可以断定是二进制：强行当文本保存会直接损坏文件，先拒绝
  if (buf.subarray(0, 8000).includes(0)) {
    throw new Error('这是二进制文件，无法在启动器内编辑，请用系统程序打开')
  }
  return { content: buf.toString('utf8'), size: st.size, mtime: st.mtimeMs }
}

/** 保存内置编辑器里的文本（会覆盖原文件）。 */
export async function writeText(target: string, content: string): Promise<void> {
  try {
    await fs.writeFile(target, content, 'utf8')
  } catch (err) {
    throw describeFsError(err, target, '保存')
  }
}

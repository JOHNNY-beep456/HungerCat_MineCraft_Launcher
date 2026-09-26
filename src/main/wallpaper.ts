// ---------------------------------------------------------------------------
// 自定义壁纸的选图、存放与读取。
//
// 为什么不直接存用户选择的原路径：原图可能被移动 / 删除 / 拔盘，启动器下次启动
// 就会变成一片空白。所以选图时先把图**复制**进 <userData>/wallpapers/，设置里只
// 记文件名，之后原图随便动都不影响。
//
// 渲染层为什么拿 data URL 而不是 file:// ：渲染页的 CSP 里 img-src 不含 file:，
// 直接引用本地文件会被拦掉。这里读成 data URL 返回，走 img-src 的 data: 放行。
// ---------------------------------------------------------------------------

import { app, dialog } from 'electron'
import { promises as fsp } from 'fs'
import { basename, extname, join } from 'path'
import type { LauncherSettings } from '@shared/types'
import { settings } from './store'

/** 允许的图片扩展名 → data URL 用的 MIME。 */
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}

/** 壁纸体积上限：base64 后还要过一次 IPC，太大没有意义。 */
const MAX_SIZE = 8 * 1024 * 1024

function wallpaperDir(): string {
  return join(app.getPath('userData'), 'wallpapers')
}

/** 取当前壁纸文件的绝对路径（没设置时返回空串）。 */
function currentFile(): string {
  const name = settings.get().backgroundImage
  // 只接受纯文件名，杜绝通过设置注入路径穿越
  if (!name || basename(name) !== name) return ''
  return join(wallpaperDir(), name)
}

/** 删除当前壁纸文件（失败不影响设置清空）。 */
async function removeCurrent(): Promise<void> {
  const file = currentFile()
  if (!file) return
  try {
    await fsp.unlink(file)
  } catch {
    /* 文件已不在就算了 */
  }
}

/**
 * 弹系统选图框，选中的图复制进数据目录并写进设置。
 * 返回最新设置；用户取消时原样返回。
 */
export async function pickWallpaper(): Promise<LauncherSettings> {
  const result = await dialog.showOpenDialog({
    title: '选择壁纸图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: Object.keys(MIME).map((e) => e.slice(1)) }]
  })
  if (result.canceled || result.filePaths.length === 0) return settings.get()

  const src = result.filePaths[0]
  const ext = extname(src).toLowerCase()
  if (!MIME[ext]) throw new Error('不支持的图片格式，请选择 PNG / JPG / WebP / GIF / BMP')
  const stat = await fsp.stat(src)
  if (stat.size > MAX_SIZE) throw new Error('图片过大（上限 8MB），请先压缩后再选择')

  const dir = wallpaperDir()
  await fsp.mkdir(dir, { recursive: true })
  // 先落新文件再删旧文件，中途失败也不会把已有壁纸弄丢
  const prev = currentFile()
  const name = `wallpaper-${Date.now()}${ext}`
  const dest = join(dir, name)
  await fsp.copyFile(src, dest)
  const next = settings.set({ backgroundImage: name })
  if (prev && prev !== dest) {
    try {
      await fsp.unlink(prev)
    } catch {
      /* 旧文件已不在就算了 */
    }
  }
  return next
}

/** 清除壁纸：删文件 + 清设置。 */
export async function clearWallpaper(): Promise<LauncherSettings> {
  await removeCurrent()
  return settings.set({ backgroundImage: '' })
}

/**
 * 读当前壁纸并编码成 data URL（没设置 / 文件丢失 / 格式不认识时返回空串）。
 * 渲染层拿到空串就只画背景预设。
 */
export async function wallpaperData(): Promise<string> {
  const file = currentFile()
  if (!file) return ''
  const mime = MIME[extname(file).toLowerCase()]
  if (!mime) return ''
  try {
    const buf = await fsp.readFile(file)
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return ''
  }
}

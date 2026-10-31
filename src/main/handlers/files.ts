// 文件域 IPC：启动器自实现的资源管理器，以及系统 Shell（打开外链 / 目录 / 文件选择框）。
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { basename } from 'path'
import { settings, allVersionDirs } from '../store'
import { resolvePortablePath } from '../portable'
import {
  createFile,
  listDir,
  listPlaces,
  openPath,
  readText,
  removeEntry,
  renameEntry,
  revealPath,
  writeText
} from '../files'
import type { IpcContext } from './context'

export function registerFilesHandlers(_ctx: IpcContext): void {
  // ---- 自实现的资源管理器（替代系统资源管理器）----
  ipcMain.handle('files:places', () => {
    const s = settings.get()
    // 版本目录排在最前：这是用户最常来的地方（默认目录 + 各别名目录）
    return listPlaces(
      allVersionDirs(s).map((d) => ({
        name: d.isDefault ? '默认' : d.alias || basename(d.path) || d.path,
        path: d.path,
        kind: 'place' as const
      }))
    )
  })
  /*
   * 列目录前先把便携版的相对写法解析成绝对路径。
   *
   * 便携版的默认版本目录在设置里存的是 `./.minecraft`（相对启动器所在目录），
   * 而这里拿到的一律应当是绝对路径。此前若渲染层因设置缓存缺字段而回落到相对写法，
   * `readdir` 会按进程工作目录去找 —— 便携版的工作目录未必是 exe 所在目录，
   * 于是报「路径不存在或已被移动: ./.minecraft」。在入口处统一解析，
   * 用户手输地址栏相对路径时也能正常工作。
   */
  ipcMain.handle('files:list', (_e, path: string) => listDir(resolvePortablePath(path)))
  ipcMain.handle('files:open', (_e, path: string) => openPath(path))
  ipcMain.handle('files:reveal', (_e, path: string) => revealPath(path))
  // 写操作（右键菜单）：改名 / 新建空文件 / 删除 / 读写文本
  ipcMain.handle('files:rename', (_e, path: string, name: string) => renameEntry(path, name))
  ipcMain.handle('files:createFile', (_e, dir: string, name: string) => createFile(dir, name))
  ipcMain.handle('files:remove', (_e, path: string) => removeEntry(path))
  ipcMain.handle('files:readText', (_e, path: string) => readText(path))
  ipcMain.handle('files:writeText', (_e, path: string, content: string) => writeText(path, content))

  // ---- Shell ----
  ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url))
  ipcMain.handle('shell:openPath', (_e, p: string) => shell.openPath(p))
  ipcMain.handle('shell:chooseDirectory', async (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    const r = await dialog.showOpenDialog(w!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle(
    'shell:pickFile',
    async (e, filters?: Array<{ name: string; extensions: string[] }>) => {
      const w = BrowserWindow.fromWebContents(e.sender)
      const r = await dialog.showOpenDialog(w!, { properties: ['openFile'], filters })
      return r.canceled ? null : r.filePaths[0]
    }
  )
  ipcMain.handle(
    'shell:pickFiles',
    async (e, filters?: Array<{ name: string; extensions: string[] }>) => {
      const w = BrowserWindow.fromWebContents(e.sender)
      const r = await dialog.showOpenDialog(w!, { properties: ['openFile', 'multiSelections'], filters })
      return r.canceled ? [] : r.filePaths
    }
  )
  ipcMain.handle('shell:saveFile', async (e, defaultName: string) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    const r = await dialog.showSaveDialog(w!, { defaultPath: defaultName })
    return r.canceled || !r.filePath ? null : r.filePath
  })
}

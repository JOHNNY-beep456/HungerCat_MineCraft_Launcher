// Java 域 IPC：运行时检测 / 版本适配检查 / 自动安装 / 手动指定。
import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { DownloadPhase } from '@shared/types'
import { settings, activeGameDir, allVersionDirs } from '../store'
import { detectJava, installJava, invalidateJavaCache, javaVersionAt } from '../java'
import { resolveVersionJson } from '../versions'
import type { IpcContext } from './context'

export function registerJavaHandlers(ctx: IpcContext): void {
  // ---- Java ----
  // 传入「全部版本目录」而非仅当前目录：Java 可能装在任一版本目录的 java/ 下，
  // 只看当前目录会导致切换版本目录后已装好的 Java 检测不到。
  ipcMain.handle('java:detect', () => detectJava(allVersionDirs(settings.get()).map((d) => d.path)))
  ipcMain.handle('java:check', async (_e, versionId: string) => {
    const s = settings.get()
    const dir = activeGameDir(s)
    const json = await resolveVersionJson(versionId, dir)
    const required = json.javaVersion?.majorVersion ?? 8
    const available = await detectJava(allVersionDirs(s).map((d) => d.path))
    // 「合适的 Java」= isJavaSuitable 判定通过（见 java.ts）。没有合适的就返回 compatible=false，
    // 由渲染层弹「是否安装 Java {required}」提示，而不是静默用不匹配的 Java 去启动。
    const compatible = (await ctx.suitableJavaFor(s, required)) !== null
    return { required, compatible, available }
  })
  ipcMain.handle('java:install', async (event, major: number) => {
    const s = settings.get()
    const taskId = `java-${major}`
    const controller = new AbortController()
    ctx.downloadAborts.set(taskId, controller)
    const emit = (
      percent: number,
      task: string,
      currentBytes: number,
      totalBytes: number,
      phase: DownloadPhase
    ): void => {
      ctx.sendToSender(event.sender, 'download:progress', {
        taskId,
        task,
        current: percent,
        total: 100,
        currentBytes,
        totalBytes,
        phase,
        percent
      })
    }
    try {
      const path = await installJava(major, activeGameDir(s), emit, controller.signal)
      // 只记录路径，不关闭「自动检测」：否则启动器为某个版本自动装好 Java 后，
      // 自动检测会被自己悄悄关掉，之后换版本启动时就不会再按版本切换 Java 了。
      settings.set({ javaPath: path })
      // 新装了一个 Java：让检测缓存失效，设置页下次拉取就能看到它。
      invalidateJavaCache()
      return path
    } catch (err) {
      // 取消 / 失败都必须补发一条 done：渲染层只在收到 done 时才移除任务条目，
      // 否则「获取下载地址」阶段被取消后浮球上的任务会一直挂着，看起来像取消无效。
      emit(0, '', 0, 0, 'done')
      throw err
    } finally {
      ctx.downloadAborts.delete(taskId)
    }
  })
  // 手动指定 Java：选到文件即读取版本信息（自动识别 major / 厂商 / 位数）。
  ipcMain.handle('java:pick', async (event) => {
    const w = BrowserWindow.fromWebContents(event.sender)
    const opts: Electron.OpenDialogOptions = {
      title: '选择 Java 可执行文件',
      properties: ['openFile'],
      filters:
        process.platform === 'win32'
          ? [{ name: 'Java 可执行文件', extensions: ['exe'] }]
          : [{ name: '所有文件', extensions: ['*'] }]
    }
    const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths[0]) return null
    const picked = res.filePaths[0]
    const jr = await javaVersionAt(picked)
    if (!jr) {
      throw new Error('无法识别该文件，请选择 java.exe（Windows）或 bin/java（macOS / Linux）')
    }
    return jr
  })
}

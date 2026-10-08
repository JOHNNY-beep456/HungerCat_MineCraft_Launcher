// 主页域 IPC：自定义主页管理 / 市场 / 投稿，以及用户反馈与服务端限制。
import { ipcMain } from 'electron'
import type {
  DebugLogEntry,
  FeedbackSubmitPayload,
  HomepageSubmitPayload,
  HomepageUpdate
} from '@shared/types'
import { settings } from '../store'
import {
  listHomepages,
  readHomepage,
  importHomepage,
  downloadHomepage,
  removeHomepage,
  verifyHomepage,
  confirmHomepage,
  setActiveHomepage,
  blockHomepage,
  openHomepageDir,
  fetchMarket,
  checkHomepageUpdates,
  updateHomepage,
  submitHomepage,
  sendEmailCode,
  installNumbered
} from '../homepage'
import { homepageSecurityUsesNative } from '../native-downloader'
import { sendFeedbackCode, submitFeedback, fetchServerLimits, listFeedback, withdrawFeedback } from '../feedback'
import type { IpcContext } from './context'

export function registerHomepageHandlers(_ctx: IpcContext): void {
  // ---- 自定义主页（脚本仓管 / 联网校验 / 市场 / 投稿）----
  ipcMain.handle('homepage:list', () => listHomepages())
  ipcMain.handle('homepage:read', (_e, id: string) => readHomepage(id))
  ipcMain.handle('homepage:importFile', () => importHomepage())
  ipcMain.handle('homepage:download', (_e, url: string, filename: string, sizeHint?: number) =>
    downloadHomepage(url, filename, sizeHint)
  )
  ipcMain.handle('homepage:remove', (_e, id: string) => removeHomepage(id))
  ipcMain.handle('homepage:verify', (_e, id: string) => verifyHomepage(id))
  ipcMain.handle('homepage:confirm', (_e, id: string, network: boolean) => confirmHomepage(id, network))
  ipcMain.handle('homepage:setActive', (_e, id: string) => setActiveHomepage(id))
  // 运行时检测到危险代码：封锁脚本并立即停用（渲染层负责弹全屏提示）。
  ipcMain.handle('homepage:block', (_e, id: string, reason: string) => blockHomepage(id, reason))
  ipcMain.handle('homepage:openDir', () => openHomepageDir())
  // 主页安全检测当前是否由原生（Rust）内核承担；供界面在未使用 Rust 时给出顶部提示。
  ipcMain.handle('homepage:securityEngine', () => ({
    native: homepageSecurityUsesNative()
  }))
  ipcMain.handle('homepage:market', () => fetchMarket())
  ipcMain.handle('homepage:checkUpdates', () => checkHomepageUpdates())
  ipcMain.handle('homepage:update', (_e, update: HomepageUpdate) => updateHomepage(update))
  ipcMain.handle('homepage:send-email-code', (_e, email: string) => sendEmailCode(email))
  ipcMain.handle('homepage:submit', (_e, payload: HomepageSubmitPayload) => submitHomepage(payload))
  ipcMain.handle('feedback:send-code', (_e, email: string) => sendFeedbackCode(email))
  ipcMain.handle('feedback:submit', (_e, payload: FeedbackSubmitPayload) => submitFeedback(payload))
  ipcMain.handle('feedback:list', (_e, email: string, code: string) => listFeedback(email, code))
  ipcMain.handle('feedback:withdraw', (_e, email: string, code: string, id: string) =>
    withdrawFeedback(email, code, id)
  )
  ipcMain.handle('limits:get', () => fetchServerLimits())
  ipcMain.handle(
    'homepage:installNumbered',
    (_e, input: { filename: string; contentBase64: string; replaceId?: string }) => installNumbered(input)
  )
  ipcMain.handle('homepage:log', (_e, level: DebugLogEntry['level'], message: string) => {
    // 主页脚本日志只在 Debug 模式落地：非调试时脚本输出不进日志缓冲，避免噪声。
    if (!settings.get().debugMode) return
    // 折叠换行 / 控制字符：一条脚本日志绝不能伪造出多行「启动器日志」（F-14 / D07）。
    const text = String(message)
      .replace(/[\r\n\u2028\u2029]+/g, ' ⏎ ')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .slice(0, 4000)
    const line = `[主页脚本] ${text}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.info(line)
  })
}

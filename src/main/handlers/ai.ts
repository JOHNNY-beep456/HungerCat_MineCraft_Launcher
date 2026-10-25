// AI 助手 IPC 域：对话 / 工具授权 / 报错分析 / 语音 / 悬浮球 / 浮层状态。
//
// 这里的处理器都很薄——真正的状态与编排在 ../ai/service.ts，窗口在 ../ai/ball.ts。
// 保持「只做参数检查 + 调用」的好处是：设置页、悬浮球、主界面三个入口最终走同一套逻辑，
// 不会出现「从悬浮球问和从主界面问，行为不一样」的情况。
import { ipcMain } from 'electron'
import type { AiHudState } from '@shared/types'
import { clearAiKey, setAiKey } from '../secret'
import { invalidateSettingsCache, settings } from '../store'
import { expandAiBall, moveAiBall, aiBallPosition, syncAiBall } from '../ai/ball'
import type { AiService } from '../ai/service'
import type { IpcContext } from './context'

export function registerAiHandlers(_ctx: IpcContext, service: AiService): void {
  ipcMain.handle('ai:chat', (_e, text: string, context?: string) => service.chat(String(text ?? ''), context))

  ipcMain.handle('ai:cancel', () => {
    service.cancel()
  })

  ipcMain.handle('ai:decideTool', (_e, id: string, approved: boolean) => {
    service.decideTool(String(id), approved === true)
  })

  ipcMain.handle('ai:analyzeError', (_e, text: string) => service.analyzeError(String(text ?? '')))

  ipcMain.handle('ai:test', () => service.test())

  ipcMain.handle('ai:tools', () => service.tools())

  ipcMain.handle('ai:reset', () => {
    service.reset()
  })

  ipcMain.handle('ai:transcribe', (_e, audio: Uint8Array, mime: string) => service.transcribe(audio, String(mime || 'audio/webm')))

  /**
   * 保存密钥：先真发一次请求验通，再加密落盘。
   *
   * 必须**先存后测**，否则 service.test() 用的是旧密钥（currentProfile 从安全存储读）。
   * 于是顺序是：写入 → 测 → 失败则回滚删除。成功后让设置缓存失效，界面才会看到
   * 「已设置」翻牌。
   */
  ipcMain.handle('ai:setKey', async (_e, key: string) => {
    const value = String(key ?? '').trim()
    if (!value) return { ok: false, message: '请填写 API 密钥' }
    const reason = setAiKey(value)
    if (reason) return { ok: false, message: reason }
    invalidateSettingsCache()
    const test = await service.test()
    if (!test.ok) {
      // 测不通就别留下一个「看起来配好了、其实用不了」的密钥。
      clearAiKey()
      invalidateSettingsCache()
      return { ok: false, message: `密钥未通过验证：${test.message}` }
    }
    return { ok: true, message: `验证通过，已加密保存到本机（${test.message}）` }
  })

  ipcMain.handle('ai:clearKey', () => {
    clearAiKey()
    invalidateSettingsCache()
    return { ok: true, message: '已删除保存的 API 密钥' }
  })

  /* -------------------- 悬浮球 -------------------- */

  ipcMain.handle('ai:ball:sync', () => {
    syncAiBall()
  })
  ipcMain.handle('ai:ball:expand', (_e, open: boolean) => {
    expandAiBall(open === true)
  })
  ipcMain.handle('ai:ball:move', (_e, x: number, y: number, persist: boolean) => {
    // 返回夹边后的实际位置，渲染层据此校正坐标缓存。
    return moveAiBall(Number(x) || 0, Number(y) || 0, persist === true)
  })
  ipcMain.handle('ai:ball:position', () => aiBallPosition())

  /* -------------------- 浮层 -------------------- */

  ipcMain.handle('ai:setHudActive', (_e, active: boolean) => {
    service.setHudActive(active === true)
  })
  ipcMain.handle('ai:setHudStatus', (_e, status: AiHudState['status']) => {
    service.setHudStatus(status)
  })
  ipcMain.handle('ai:hudState', () => service.hudState())
}
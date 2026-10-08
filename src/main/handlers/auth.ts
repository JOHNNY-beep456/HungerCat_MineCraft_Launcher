// 认证域 IPC：微软设备代码流（登录 / 取消 / 刷新）。
import { ipcMain } from 'electron'
import type { MinecraftAccount } from '@shared/types'
import { accounts } from '../store'
import { DeviceCodeSession, refreshAccount } from '../auth'
import { refreshYggdrasil } from '../yggdrasil'
import type { IpcContext } from './context'

export function registerAuthHandlers(ctx: IpcContext): void {
  // ---- Auth ----
  ipcMain.handle('auth:begin', async (event) => {
    const session = new DeviceCodeSession()
    ctx.authSession()?.cancel()
    ctx.setAuthSession(session)
    return session.begin((status) => {
      if (status.state === 'success') accounts.upsert(status.account)
      ctx.sendToSender(event.sender, 'auth:status', status)
    })
  })
  ipcMain.handle('auth:cancel', () => {
    ctx.authSession()?.cancel()
    ctx.setAuthSession(null)
  })
  ipcMain.handle('auth:refresh', async (_e, account: MinecraftAccount) => {
    // 按认证类型分派，与启动前的刷新逻辑保持一致：第三方（Yggdrasil）账号没有 refreshToken，
    // 必须走 refreshYggdrasil；否则会被微软链路当成「缺少刷新令牌」而刷新失败。
    const updated =
      account.authType === 'yggdrasil' ? await refreshYggdrasil(account) : await refreshAccount(account)
    accounts.upsert(updated)
    return updated
  })
}

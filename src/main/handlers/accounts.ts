// 账号域 IPC：账号列表 / 选择 / 增删，以及第三方（Yggdrasil）账号与皮肤。
import { ipcMain } from 'electron'
import { accounts, createOfflineAccount } from '../store'
import {
  commitYggdrasilProfiles,
  fetchYggdrasilSiteName,
  fetchYggdrasilSkin,
  loginYggdrasil
} from '../yggdrasil'
import type { IpcContext } from './context'

export function registerAccountsHandlers(ctx: IpcContext): void {
  // ---- Accounts ----
  ipcMain.handle('accounts:list', () => accounts.list())
  ipcMain.handle('accounts:selected', () => accounts.selected())
  // 站点名称是后加的字段：进入账号页时一次性补全旧账号（best-effort，失败不影响其它账号）。
  ipcMain.handle('accounts:refreshSiteNames', async () => {
    const targets = accounts.list().filter((a) => a.authType === 'yggdrasil' && !a.siteName && a.yggdrasilServer)
    if (targets.length > 0) {
      const names = await Promise.all(targets.map((a) => fetchYggdrasilSiteName(a.yggdrasilServer as string)))
      targets.forEach((a, i) => {
        const name = names[i]
        if (name) accounts.upsert({ ...a, siteName: name })
      })
    }
    return accounts.list()
  })
  ipcMain.handle('accounts:remove', (_e, id: string) => accounts.remove(id))
  ipcMain.handle('accounts:select', (_e, id: string) => accounts.select(id))
  ipcMain.handle('accounts:addOffline', (_e, name: string) => {
    const acc = createOfflineAccount(name)
    accounts.upsert(acc)
    accounts.select(acc.id)
    return acc
  })
  ipcMain.handle('accounts:addYggdrasil', async (_e, server: string, email: string, password: string) => {
    const result = await loginYggdrasil(server, email, password)
    // 多角色：先不建号，交给界面弹窗选择（可多选）后再提交。
    if (result.kind === 'select') return { profiles: result.profiles }
    accounts.upsert(result.account)
    accounts.select(result.account.id)
    return { account: result.account }
  })
  ipcMain.handle('accounts:addYggdrasilProfiles', (_e, ids: string[]) => {
    const list = commitYggdrasilProfiles(ids)
    for (const acc of list) accounts.upsert(acc)
    if (list[0]) accounts.select(list[0].id)
    return list
  })
  // 第三方账号皮肤：走认证站会话服取皮肤贴图（不查正版 uapis 接口）。
  ipcMain.handle('yggdrasil:skin', (_e, server: string, uuid: string) => fetchYggdrasilSkin(server, uuid))
}

// 网络域 IPC：关于 / 协议 / 公告 / 更新、翻译、Minecraft 玩家与服务器信息。
import { app, ipcMain } from 'electron'
import { join } from 'path'
import type { UpdateInfo } from '@shared/types'
import { clearUapisKey, getUapisKey, setUapisKey } from '../secret'
import { netRequest } from '../broker'
import { settings, invalidateSettingsCache } from '../store'
import {
  fetchAbout,
  fetchAgreement,
  agreementVersion,
  fetchAnnouncements,
  fetchUpdateInfo,
  downloadUpdate,
  runUpdate,
  compareVersions,
  compareMainVersions,
  updateFileExists,
  updateFileName
} from '../server'
import type { IpcContext } from './context'

export function registerNetworkHandlers(ctx: IpcContext): void {
  // ---- About / agreement / update (remote server) ----
  ipcMain.handle('about:list', () => fetchAbout())
  // 实验性：资源名 / 简介自动翻译（在线接口，实现见 network/translate.ts）
  ipcMain.handle('translate:texts', (_e, texts: string[], target: string) =>
    netRequest<Array<[string, string]>>('translate:texts', { texts, target, apiKey: getUapisKey() }, {
      // 逐条请求外部接口，条数较多时耗时较长，给足超时。
      timeoutMs: 120_000
    })
  )
  // 保存 API KEY：先真实请求一次做连通性测试，通过才加密落盘（在主进程完成，
  // 渲染层既拿不到已保存的 KEY，也无法绕过测试直接写入）。
  ipcMain.handle('translate:setKey', async (_e, apiKey: string) => {
    const key = String(apiKey ?? '').trim()
    if (!key) return { ok: false, message: '未填写 API KEY' }
    const test = await netRequest<{ ok: boolean; message: string }>(
      'translate:testKey',
      { apiKey: key },
      { timeoutMs: 20_000 }
    )
    if (!test.ok) return test
    const err = setUapisKey(key)
    if (err) return { ok: false, message: err }
    // uapisApiKeySet 是「由安全存储派生的字段」，不落 settings.json：密钥变了要让设置缓存失效，
    // 否则设置页仍会显示「未设置」。
    invalidateSettingsCache()
    return { ok: true, message: `${test.message}（已加密保存到本机）` }
  })
  ipcMain.handle('translate:clearKey', () => {
    clearUapisKey()
    invalidateSettingsCache()
    return { ok: true, message: '已删除本机保存的 API KEY，已回到访客额度' }
  })
  // 正版 / 第三方玩家信息：名字 → UUID 与皮肤地址（uapis.cn）。用于头像与 3D 模型。
  ipcMain.handle('minecraft:userinfo', (_e, name: string) =>
    netRequest<{ username: string; uuid: string; skinUrl: string; capeUrl: string }>(
      'minecraft:userinfo',
      { name, apiKey: getUapisKey() },
      { timeoutMs: 20_000 }
    )
  )
  ipcMain.handle('minecraft:serverstatus', (_e, address: string) =>
    netRequest<{
      online: boolean
      players: number
      maxPlayers: number
      motdClean: string
      motdHtml: string
      faviconUrl: string
      ip: string
      port: number
      version: string
    }>('minecraft:serverstatus', { address, apiKey: getUapisKey() }, { timeoutMs: 20_000 })
  )
  ipcMain.handle('about:agreement', () => fetchAgreement())
  // 协议版本核对：内容指纹与当前不一致（或从未同意）时需要（重新）同意。
  // 离线 / 不可达时回落本地判断：仅在从未同意过时要求同意，避免断网把老用户拦在门外。
  ipcMain.handle('about:agreementStatus', async () => {
    const s = settings.get()
    // 本地模式不联网：仅按「从未同意」判断，正文留空由界面提示离线。
    if (s.mode === 'local') return { version: '', needsConsent: !s.agreementAcceptedAt, content: null }
    try {
      const content = await fetchAgreement()
      const version = agreementVersion(content)
      let acceptedVersion = s.agreementAcceptedVersion
      // 迁移：老版本用户此前没有记录协议版本，首次核对时把当前版本补记为已同意，
      // 不打断使用；此后协议再变更即会触发重新同意。
      if (version && !acceptedVersion && s.agreementAcceptedAt > 0) {
        settings.set({ agreementAcceptedVersion: version })
        acceptedVersion = version
      }
      const needsConsent = version ? acceptedVersion !== version : !s.agreementAcceptedAt
      return { version, needsConsent, content }
    } catch {
      return { version: '', needsConsent: !s.agreementAcceptedAt, content: null }
    }
  })
  // 公告列表：本地模式不联网，返回空数组。
  ipcMain.handle('announcement:list', () => (settings.get().mode === 'local' ? [] : fetchAnnouncements()))
  ipcMain.handle('update:check', async () => {
    const currentVersion = app.getVersion()
    let latest: UpdateInfo | null = null
    try {
      latest = await fetchUpdateInfo()
    } catch {
      latest = null
    }
    return {
      currentVersion,
      latest,
      hasUpdate: latest ? compareVersions(latest.version, currentVersion) > 0 : false,
      // 是否为预发布版由服务端后台勾选决定：启动自动检查据此静默，避免打扰普通用户。
      latestIsPrerelease: latest ? !!latest.prerelease : false,
      // 是否为「重要版本」：无论是否开启自动更新都要推送（见渲染层启动检查）。
      latestIsImportant: latest ? !!latest.important : false,
      // 重要版本是否对当前启动器生效：仅当「启动器主版本号 <= 重要版本主版本号」时才推送，
      // 避免把一条旧的重要版本推给已升级到更新主版本的用户。
      importantApplies: latest ? compareMainVersions(latest.version, currentVersion) >= 0 : false
    }
  })
  ipcMain.handle('update:download', async (event, info: UpdateInfo) => {
    const s = settings.get()
    return downloadUpdate(info, s.gameDir, (p) => {
      ctx.sendToSender(event.sender, 'update:progress', p)
    })
  })
  ipcMain.handle('update:downloadAndRun', async (event, info: UpdateInfo) => {
    const s = settings.get()
    // 已经下载过同一版本：直接运行，避免重复下载时再次对同名 exe 做覆盖写（Windows 上易 EPERM）。
    const existing = updateFileExists(s.gameDir, info)
    const path = existing
      ? join(s.gameDir, 'updates', updateFileName(info))
      : await downloadUpdate(info, s.gameDir, (p) => {
          ctx.sendToSender(event.sender, 'update:progress', p)
        })
    runUpdate(path)
    return path
  })
}

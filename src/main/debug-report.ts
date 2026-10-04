// ---------------------------------------------------------------------------
// 调试日志上传（调试密钥）
//
// 站长在服务端后台「随机生成」一个调试密钥（可选择可用次数），发给需要排查问题的用户。
// 用户在设置里填入密钥后，启动器**自动收集**当前日志与环境信息并上传到服务端，
// 站长据此在后台查看现场，无需用户手动导出 / 粘贴日志。
//
// 上传的是「诊断快照」：环境头 + 最近若干条日志（主进程 + 渲染层）。数量与字节数都做
// 上限裁剪，避免超大 payload 触发服务端 / 网关限制。
// ---------------------------------------------------------------------------

import { app } from 'electron'
import { arch, cpus, platform, release, totalmem } from 'os'
import type { DebugLogEntry, DebugSubmitResult } from '@shared/types'
import { getLogBuffer } from './logger'
import { settings } from './store'
import { netRequest } from './broker'

/** 单次上传的日志条数上限（取最近的）。 */
const MAX_LOG_ENTRIES = 800
/** 单次上传的日志字节上限（约 400KB，远低于常见 post 上限）。 */
const MAX_LOG_BYTES = 400 * 1024

/** 诊断快照：上传到服务端的结构。 */
export interface Diagnostics {
  generatedAt: number
  launcher: {
    version: string
    platform: string
    arch: string
    electron: string
    chrome: string
    node: string
    locale: string
    mode: string
    gameDir: string
    selectedVersionId: string
    multiplayer: boolean
  }
  system: {
    osRelease: string
    cpuCores: number
    totalMemMb: number
  }
  stats: {
    total: number
    sent: number
    errorCount: number
    warnCount: number
  }
  logs: DebugLogEntry[]
}

/**
 * 采集当前诊断快照。
 *
 * 日志从**最新往前**取，直到条数或字节数超限；最后按时间正序返回，便于阅读。
 * 超限时丢弃的是更早的日志 —— 报错现场通常在末尾。
 */
export function collectDiagnostics(): Diagnostics {
  const s = settings.get()
  const all = getLogBuffer()

  let errorCount = 0
  let warnCount = 0
  for (const e of all) {
    if (e.level === 'error') errorCount++
    else if (e.level === 'warn') warnCount++
  }

  const picked: DebugLogEntry[] = []
  let bytes = 0
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i]
    if (picked.length >= MAX_LOG_ENTRIES) break
    bytes += e.message.length
    if (bytes > MAX_LOG_BYTES) break
    picked.push(e)
  }
  picked.reverse()

  return {
    generatedAt: Date.now(),
    launcher: {
      version: app.getVersion(),
      platform: platform(),
      arch: arch(),
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node ?? '',
      locale: app.getLocale(),
      mode: s.mode,
      gameDir: s.gameDir,
      selectedVersionId: s.selectedVersionId,
      multiplayer: s.enableMultiplayer === true
    },
    system: {
      osRelease: release(),
      cpuCores: cpus()?.length ?? 0,
      totalMemMb: Math.round(totalmem() / 1024 / 1024)
    },
    stats: { total: all.length, sent: picked.length, errorCount, warnCount },
    logs: picked
  }
}

/**
 * 用调试密钥上传诊断快照。
 *
 * 返回服务端处理结果（含剩余可用次数）。网络 / 服务端失败都会抛出可读的中文异常，
 * 由调用方（设置页）展示。
 */
export async function submitDebugLogs(key: string): Promise<DebugSubmitResult> {
  const k = String(key ?? '').trim()
  if (!k) throw new Error('未填写调试密钥')
  const diagnostics = collectDiagnostics()
  const res = await netRequest<{ ok?: boolean; remaining?: number; error?: string }>(
    'server:post',
    { path: 'debug_submit', body: { key: k, diagnostics }, timeoutMs: 60_000 },
    // 主进程侧绝对超时略大于网络进程侧（60s），让网络进程先超时并回传可读错误。
    { timeoutMs: 65_000 }
  )
  if (res?.ok !== true) {
    throw new Error(res?.error || '上传失败')
  }
  return {
    ok: true,
    remaining: Number(res.remaining) || 0,
    message: `日志已上传（剩余可用次数 ${Number(res.remaining) || 0}）`
  }
}

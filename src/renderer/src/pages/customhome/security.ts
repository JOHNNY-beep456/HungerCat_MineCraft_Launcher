// ---------------------------------------------------------------------------
// 安全 / 权限校验。
//
//   - 纯函数：解析外链「源」、汇总授权源清单、组装 iframe 的 CSP；
//   - useSecurityGuard：运行时安全命中的三档处置（完全模拟 / 仅提示 / 完全关闭）
//     与封锁停用逻辑，供能力桥与握手看门狗共用。
// ---------------------------------------------------------------------------

import { useCallback, useMemo, useRef } from 'react'
import type { HomepageExternal, LauncherSettings } from '@shared/types'
import type { SecurityAlert } from '../../store'

/** 取 http(s)（含协议相对 //）地址的「源」；data: / javascript: / 相对路径一律返回空串。 */
export function httpOrigin(raw: unknown): string {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  try {
    if (s.startsWith('//')) return new URL(`https:${s}`).origin
    if (/^https?:\/\//i.test(s)) return new URL(s).origin
  } catch {
    return ''
  }
  return ''
}

/**
 * 授权联网时真正放行的「源」清单（F-04）：只允许安装时静态收集到、且用户在闸门看过的那些源，
 * 而不是整个 https:。CSP 与运行期探针共用这一份清单，任何越界源都视为外泄。
 */
export function homepageOrigins(externals: HomepageExternal[] | undefined, extra: string[] = []): string[] {
  const set = new Set<string>()
  for (const item of externals ?? []) {
    const origin = httpOrigin(item?.url)
    if (origin) set.add(origin)
  }
  for (const e of extra) if (e) set.add(e)
  return [...set]
}

/** 组装 iframe 的 CSP：默认断网；仅在用户授权后，按「安装清单里的源」逐条放行（F-04）。 */
export function buildCsp(sources: string[], avatarHost: string, skinHost: string): string {
  const allow = sources.filter(Boolean)
  const net = allow.length > 0
  const dirs: string[] = []
  const add = (name: string, values: string): void => {
    dirs.push(`${name} ${values}`)
  }
  add('default-src', "'none'")
  add('script-src', net ? `'unsafe-inline' ${allow.join(' ')}` : "'unsafe-inline'")
  add('style-src', net ? `'unsafe-inline' ${allow.join(' ')}` : "'unsafe-inline'")
  const img = ['data:', 'blob:']
  // 头像图来自启动器自身使用的官方/认证站源，与脚本外链无关，单独放行。
  if (avatarHost) img.push(avatarHost)
  // 玩家皮肤贴图（3D 模型）同样来自启动器自身使用的官方 / 认证站源，与脚本外链无关，单独放行。
  if (skinHost) img.push(skinHost)
  if (net) img.push(...allow)
  add('img-src', img.join(' '))
  add('font-src', net ? `data: ${allow.join(' ')}` : 'data:')
  add('media-src', net ? `data: ${allow.join(' ')}` : "'none'")
  add('connect-src', net ? allow.join(' ') : "'none'")
  add('form-action', "'none'")
  add('frame-src', "'none'")
  add('object-src', "'none'")
  add('base-uri', "'none'")
  return dirs.join('; ')
}

export interface SecurityGuardOptions {
  /** 被保护的主页脚本标识。 */
  id: string
  settings: LauncherSettings
  raiseSecurityAlert: (alert: SecurityAlert) => void
  reloadSettings: () => Promise<void>
}

export interface SecurityGuard {
  /** 当前生效的安全档位（开发模式专用）。 */
  securityMode: 'full' | 'warn' | 'off'
  /** 安全命中的处置：返回 true 表示调用方应中止当前动作。 */
  securityHit: (reason: string, detail: string) => boolean
}

/**
 * 运行时安全守卫。
 *
 * 安全命中的三档处置（对应 homepage-debug.html 的 securityHit）：
 *   - off  完全关闭：不检测，直接放行；
 *   - warn 仅提示  ：写一条警告日志后放行，不阻止脚本；
 *   - full 完全模拟：照常封锁并停用该主页（返回 true，调用方应中止当前动作）。
 */
export function useSecurityGuard({
  id,
  settings,
  raiseSecurityAlert,
  reloadSettings
}: SecurityGuardOptions): SecurityGuard {
  /**
   * 当前生效的安全档位（开发模式专用）：
   * 仅在开发模式「已授权且已开启」时才采用用户选择的档位，否则一律为「完全模拟」。
   * 这样档位可以在设置页里保留，但离开开发模式后不会削弱正式环境的安全防护。
   */
  const securityMode = useMemo<'full' | 'warn' | 'off'>(() => {
    const granted = settings.devModeGrantedUntil > Date.now()
    if (!granted || !settings.devModeEnabled) return 'full'
    return settings.devModeSecurityMode
  }, [settings.devModeGrantedUntil, settings.devModeEnabled, settings.devModeSecurityMode])

  /** 已触发过封锁：同一脚本的多次命中只提示一次。 */
  const lockedRef = useRef(false)

  /**
   * 运行时发现「删除 / 修改文件、格式化、伪装代码」时立即处置：
   *   1. 立刻弹出全屏提示（同步执行，先于异步的停用动作）；
   *   2. 封锁该脚本并停用（主进程顺手清空 homepageId）；
   *   3. 刷新设置，让「启动游戏」页退回内置界面 —— 遮罩仍在最上层，脚本不会再跑。
   *
   * 检查点有两处：每条指令运行前、沙箱内每个元素加载后（见 bridge 的 dispatch 与 probe）。
   */
  const lockdown = useCallback(
    (reason: string, detail: string): void => {
      if (lockedRef.current) return
      lockedRef.current = true
      raiseSecurityAlert({ homepageId: id, reason, detail })
      void (async () => {
        try {
          await window.api.homepage.block(id, reason)
        } catch {
          /* 封锁失败也必须继续停用 */
        }
        try {
          await reloadSettings()
        } catch {
          /* 忽略 */
        }
      })()
    },
    [id, raiseSecurityAlert, reloadSettings]
  )

  /**
   * 安全命中的三档处置（对应 homepage-debug.html 的 securityHit）：
   *   - off  完全关闭：不检测，直接放行；
   *   - warn 仅提示  ：写一条警告日志后放行，不阻止脚本；
   *   - full 完全模拟：照常封锁并停用该主页（返回 true，调用方应中止当前动作）。
   */
  const securityHit = useCallback(
    (reason: string, detail: string): boolean => {
      if (securityMode === 'off') return false
      if (securityMode === 'warn') {
        const line = `[安全·仅提示] ${reason}${detail ? ` ｜ ${detail}` : ''}（真实启动器会立即停用该主页）`
        console.warn(line)
        window.api.homepage.log('warn', line)
        return false
      }
      lockdown(reason, detail)
      return true
    },
    [securityMode, lockdown]
  )

  return { securityMode, securityHit }
}

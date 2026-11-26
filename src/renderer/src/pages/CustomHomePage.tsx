// ---------------------------------------------------------------------------
// 自定义主页宿主（组合根）。
//
// 主页脚本是「单文件 HTML」，运行在 sandbox="allow-scripts" 的 iframe 里：
//   - 没有 allow-same-origin ⇒ 不透明 origin，拿不到启动器的 DOM / 存储 / Cookie；
//   - 没有 allow-popups / allow-top-navigation / allow-forms ⇒ 不能开窗、跳转顶层、提交表单；
//   - 注入 Content-Security-Policy：默认 connect-src 'none' 彻底断网，只有用户
//     对外部地址清单逐条确认后才放宽；
//   - 注入 SDK，脚本通过 window.hc 使用宿主能力（postMessage 白名单桥）。
//
// 宿主能力（与需求一一对应）：总内存 / 已用内存 / 分配给游戏的内存（可改）/
// 玩家头像 / 玩家名 / 版本列表 / 选中版本（可改）/ 选中版本的加载器与版本号 /
// 版本目录列表 / 当前版本目录（可改，版本列表随之收敛）/
// 启动器版本号 / 运行日志（仅 Debug 模式）/ 启动游戏（带 Java 检测回退）/
// 结束游戏 / 运行状态 / 明暗模式 / 当前主题。
//
// 本文件只做组合：装载（data）、安全守卫（security）、能力桥（bridge）、
// 脚本执行（sandbox）、渲染容器（frame）分居 customhome/ 下各司其职。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { nativeInvoke } from '../../../tauri/native-invoke'
import type { HomepageEntry } from '@shared/types'

import { useApp } from '../store'
import { useRuntime } from '../runtime'
import { HomePage } from './HomePage'
import type { PageId } from '../components/Sidebar'
import { useHomepageData } from './customhome/data'
import { homepageOrigins, httpOrigin, useSecurityGuard } from './customhome/security'
import { useHostBridge } from './customhome/bridge'
import { buildFrameSrcDoc } from './customhome/sandbox'
import { HomepageFrame } from './customhome/frame'
import { ensureProbe } from './customhome/probe'

// 同一宿主串行签发与撤销；旧请求不能晚于新请求覆盖后端票据。
let nativeFrameQueue: Promise<void> = Promise.resolve()

/** 「启动游戏」板块的替代界面：有自定义主页时顶替内置启动页。 */
export function HomeRoute({
  onManage
}: {
  onManage?: (versionId: string) => void
  onNavigate?: (p: PageId) => void
}): JSX.Element {
  const { settings } = useApp()
  // 用户配置的自定义主页优先，未配置时使用内置主页。
  if (settings.homepageId) return <CustomHomePage key={settings.homepageId} id={settings.homepageId} />
  return <HomePage onManage={onManage} />
}

export function CustomHomePage({ id }: { id: string }): JSX.Element {
  // 传 effectiveTheme 而不是 theme：主页脚本的配色完全由 theme.get().mode 决定，
  // 而 GitHub（Primer）皮肤的配色子主题独立于明暗设置（可以在「主题 = 浅色」下
  // 选 Dark / Dark dimmed / Dark High Contrast）。传 theme 会让深色启动器里嵌进
  // 一块浅色主页（iframe 本身透明，白底全是脚本自己按浅色模式画的）。
  const { settings, selectedAccount, effectiveTheme, updateSettings, reloadSettings, raiseSecurityAlert, t } = useApp()
  const { launchState, launchLog, launchPid, busy, launch, stopLaunch } = useRuntime()

  /** 装载主页条目、启动器版本号、内存、版本目录、选中版本与账号信息。 */
  const data = useHomepageData({ id, selectedAccount, settings, updateSettings, reloadSettings })
  /** 运行时安全命中的三档处置。 */
  const { securityMode, securityHit: reportSecurityHit } = useSecurityGuard({ id, settings, raiseSecurityAlert, reloadSettings })
  const [blocked, setBlocked] = useState(false)
  const securityHit = useCallback((reason: string, detail: string): boolean => {
    const stop = reportSecurityHit(reason, detail)
    if (stop) setBlocked(true)
    return stop
  }, [reportSecurityHit])

  /** 会话授权只属于闸门实际检查过的那份内容。 */
  const [passedSha, setPassedSha] = useState('')
  const nativeDocument = isTauri()
  const aliveRef = useRef(true)
  const approvalSequence = useRef(0)
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false; approvalSequence.current++ }
  }, [id])

  const starting =
    launchState === 'starting' || launchState === 'downloading' || launchState === 'launching'
  const running = launchState === 'running'

  // 授权联网时真正放行的「源」（F-04）：只含安装清单里的源（外加启动器自身的头像源）。
  // CSP、能力桥（openExternal）与运行期探针共用这一份清单，任何清单外的源都视为越权外泄。
  const avatarOrigin = data.accountInfo?.avatarUrl ? httpOrigin(data.accountInfo.avatarUrl) : ''
  // 玩家皮肤贴图来源（供主页 3D 模型加载）：与脚本外链无关，单独放行 CSP img-src 并在探针中豁免。
  // 第三方账号的皮肤多半托管在认证站（与头像接口同源），而 skinUrl 可能要等一次联网补全才落库，
  // 所以皮肤还没到手时也先把该源列为皮肤源——否则要等 skinUrl 落库才放宽 CSP，iframe 会被整体重建。
  const skinOrigin = data.modelSkin
    ? httpOrigin(data.modelSkin.skinUrl)
    : data.accountInfo?.authType === 'yggdrasil'
      ? httpOrigin(avatarOrigin)
      : ''
  const approvedOrigins = useMemo(
    () => homepageOrigins(data.entry?.risk.externals, avatarOrigin ? [avatarOrigin] : []),
    [data.entry, avatarOrigin]
  )

  const frameRef = useRef<HTMLIFrameElement>(null)
  const approved = !blocked && !!data.entry && data.entry.risk.level !== 'reject'
    && (passedSha === data.entry.sha256 || data.entry.confirmed)
    && (data.entry.risk.level !== 'warn' || data.entry.networkApproved)
  const frameGeneration = useMemo(
    () => crypto.randomUUID().replace(/-/g, ''),
    [id, data.entry?.sha256, data.entry?.networkApproved, avatarOrigin, skinOrigin, approved]
  )
  const [nativeFrame, setNativeFrame] = useState<{ generation: string; url: string } | null>(null)
  const frameUrl = nativeFrame?.generation === frameGeneration ? nativeFrame.url : ''
  const frameReady = approved && (!nativeDocument || !!frameUrl) && !data.error

  useEffect(() => {
    if (!nativeDocument || !approved || !data.entry) return
    let alive = true
    const expected = data.entry.sha256
    nativeFrameQueue = nativeFrameQueue.then(async () => {
      if (!alive) return
      try {
        const next = await nativeInvoke<{ url: string; sha256: string; generation: string }>('launcher_homepage_frame', {
          id, expected, generation: frameGeneration, avatar: avatarOrigin, skin: skinOrigin
        })
        if (!alive) return
        if (next.generation !== frameGeneration || next.sha256 !== expected) throw new Error(t('ch.loadFailed'))
        setNativeFrame({ generation: frameGeneration, url: next.url })
      } catch (error) {
        if (alive) data.setError(error instanceof Error ? error.message : t('ch.loadFailed'))
      }
    }).catch(() => undefined)
    return () => {
      alive = false
      nativeFrameQueue = nativeFrameQueue.then(async () => {
        await nativeInvoke('launcher_homepage_revoke', { generation: frameGeneration })
      }).catch(() => undefined)
    }
  }, [nativeDocument, approved, frameGeneration, id, data.entry?.sha256, avatarOrigin, skinOrigin, t])

  /** SDK 桥接：宿主能力分发与 postMessage 消息分发。 */
  const { helloRef, securityHit: frameSecurityHit } = useHostBridge({
    frameRef,
    frameGeneration,
    enabled: frameReady,
    settings,
    securityMode,
    securityHit,
    entry: data.entry,
    memInfo: data.memInfo,
    accountInfo: data.accountInfo,
    modelSkin: data.modelSkin,
    installed: data.installed,
    selectedVersionId: data.selectedVersionId,
    selectedVersion: data.selectedVersion,
    versionDirInfos: data.versionDirInfos,
    activeDirId: data.activeDirId,
    selectVersionDir: data.selectVersionDir,
    launcherVersion: data.launcherVersion,
    launchState,
    launchLog,
    launchPid,
    running,
    starting,
    busy,
    selectedAccount,
    launch,
    stopLaunch,
    updateSettings,
    approvedOrigins,
    avatarOrigin,
    skinOrigin,
    theme: effectiveTheme
  })

  const srcDoc = useMemo(
    () => nativeDocument ? '' : buildFrameSrcDoc(data.entry, approvedOrigins, avatarOrigin, skinOrigin, frameGeneration),
    [nativeDocument, data.entry, approvedOrigins, avatarOrigin, skinOrigin, frameGeneration]
  )

  // 安全组件握手看门狗：SDK 会在解析期同步发一条 hello。迟迟收不到，说明注入点被
  // 注释 / 畸形结构劫持（F-02）——CSP 与 window.hc 都可能没生效。无法确认隔离就一律封锁，
  // 绝不带着未知状态继续跑。
  useEffect(() => {
    if (!frameReady) return
    if (securityMode === 'off') return
    const timer = window.setTimeout(() => {
      if (helloRef.current) return
      frameSecurityHit(
        '主页安全组件未生效，已拒绝运行',
        '未收到沙箱内安全检查 SDK 的握手（window.hc 缺失，CSP 也可能未注入）'
      )
    }, 6000)
    return () => window.clearTimeout(timer)
  }, [frameReady, frameGeneration, securityMode, frameSecurityHit])

  // 主进程在导航发生「前」拦下沙箱主页的对外跳转（F-05 / D01 / D02）：meta refresh 由 SDK
  // 就地摘除、location 赋值由主进程阻断。这类导航不受 connect-src 管辖，命中即视为外泄，
  // 这里负责把全屏封锁遮罩弹出来。
  useEffect(() => {
    if (!nativeDocument) return window.api.homepage.onNavBlocked((url) => {
      frameSecurityHit('沙箱主页尝试跳转到外部地址（导航外泄）', url)
    })
    let alive = true
    const registered = listen<{ generation: string; message: string }>('homepage-frame-blocked', ({ payload }) => {
      if (alive && payload?.generation === frameGeneration && typeof payload.message === 'string') {
        frameSecurityHit('沙箱主页尝试跳转到外部地址（导航外泄）', payload.message)
      }
    })
    void registered.catch(() => { if (alive) data.setError(t('ch.loadFailed')) })
    return () => { alive = false; void registered.then((unlisten) => unlisten(), () => undefined) }
  }, [nativeDocument, frameGeneration, frameSecurityHit, t])

  return (
    <HomepageFrame
      entry={data.entry}
      error={data.error}
      srcDoc={srcDoc}
      frameUrl={frameUrl}
      frameGeneration={frameGeneration}
      loadingDocument={nativeDocument && approved && !frameUrl && !data.error}
      approved={approved}
      frameRef={frameRef}
      inlineGate
      onApproved={(next: HomepageEntry) => {
        const sequence = ++approvalSequence.current
        // 必须重读整份正文，不能把新授权元数据拼到先前加载的旧内容上。
        void window.api.homepage.read(id).then((current) => {
          if (!aliveRef.current || sequence !== approvalSequence.current) return
          // 放行凭据只对「核对时那份字节」有效。会话复用启动时的校验结果之后，
          // 这里就是唯一的兜底：内容变了就重新核对，绝不把旧哈希的授权套到新内容上。
          if (current.sha256 !== next.sha256) {
            void ensureProbe(id, true).catch(() => undefined)
            return
          }
          data.setEntry(current)
          setPassedSha(current.sha256)
        }, (error: unknown) => {
          if (aliveRef.current && sequence === approvalSequence.current) {
            data.setError(error instanceof Error ? error.message : t('ch.loadFailed'))
          }
        })
      }}
      // 关闭 / 取消：停用该主页并刷新设置，让外层 HomeRoute 退回内置「启动游戏」界面
      //（只调 setActive('') 而不刷新，界面会一直停在闸门弹窗上，表现为「关闭无效」）。
      onCancel={() => {
        void window.api.homepage.setActive('').then(reloadSettings)
      }}
    />
  )
}

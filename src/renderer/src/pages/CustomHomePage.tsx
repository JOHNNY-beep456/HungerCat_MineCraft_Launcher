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

import { useEffect, useMemo, useRef, useState } from 'react'
import type { HomepageEntry } from '@shared/types'
import { useApp } from '../store'
import { useRuntime } from '../runtime'
import { HomePage } from './HomePage'
import { useHomepageData } from './customhome/data'
import { homepageOrigins, httpOrigin, useSecurityGuard } from './customhome/security'
import { useHostBridge } from './customhome/bridge'
import { buildFrameSrcDoc } from './customhome/sandbox'
import { HomepageFrame } from './customhome/frame'

/** 「启动游戏」板块的替代界面：有自定义主页时顶替内置启动页。 */
export function HomeRoute(): JSX.Element {
  const { settings } = useApp()
  if (!settings.homepageId) return <HomePage />
  return <CustomHomePage key={settings.homepageId} id={settings.homepageId} />
}

export function CustomHomePage({ id }: { id: string }): JSX.Element {
  const { settings, selectedAccount, theme, updateSettings, reloadSettings, raiseSecurityAlert } = useApp()
  const { launchState, launchLog, launchPid, busy, launch, stopLaunch } = useRuntime()

  /** 装载主页条目、启动器版本号、内存、版本目录、选中版本与账号信息。 */
  const data = useHomepageData({ id, selectedAccount, settings, updateSettings, reloadSettings })
  /** 运行时安全命中的三档处置。 */
  const { securityMode, securityHit } = useSecurityGuard({ id, settings, raiseSecurityAlert, reloadSettings })

  /** 本次会话已通过安全闸门。 */
  const [passed, setPassed] = useState(false)

  const starting =
    launchState === 'starting' || launchState === 'downloading' || launchState === 'launching'
  const running = launchState === 'running'

  // 授权联网时真正放行的「源」（F-04）：只含安装清单里的源（外加启动器自身的头像源）。
  // CSP、能力桥（openExternal）与运行期探针共用这一份清单，任何清单外的源都视为越权外泄。
  const avatarOrigin = data.accountInfo?.avatarUrl ? httpOrigin(data.accountInfo.avatarUrl) : ''
  // 玩家皮肤贴图来源（供主页 3D 模型加载）：与脚本外链无关，单独放行 CSP img-src 并在探针中豁免。
  const skinOrigin = data.modelSkin ? httpOrigin(data.modelSkin.skinUrl) : ''
  const approvedOrigins = useMemo(
    () => homepageOrigins(data.entry?.risk.externals, avatarOrigin ? [avatarOrigin] : []),
    [data.entry, avatarOrigin]
  )

  const frameRef = useRef<HTMLIFrameElement>(null)

  /** SDK 桥接：宿主能力分发与 postMessage 消息分发。 */
  const { helloRef } = useHostBridge({
    frameRef,
    settings,
    theme,
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
    skinOrigin
  })

  const srcDoc = useMemo(
    () => buildFrameSrcDoc(data.entry, approvedOrigins, avatarOrigin, skinOrigin),
    [data.entry, approvedOrigins, avatarOrigin, skinOrigin]
  )

  // 闸门放行的脚本在本会话内直接运行；已验证的联网脚本不写 confirmed，
  // 所以需要单独记住「本次已通过」，否则会在闸门与运行之间来回抖动。
  const approved = !!data.entry && (passed || (data.entry.risk.level !== 'reject' && data.entry.confirmed))

  // 安全组件握手看门狗：SDK 会在解析期同步发一条 hello。迟迟收不到，说明注入点被
  // 注释 / 畸形结构劫持（F-02）——CSP 与 window.hc 都可能没生效。无法确认隔离就一律封锁，
  // 绝不带着未知状态继续跑。
  useEffect(() => {
    helloRef.current = false
  }, [srcDoc])
  useEffect(() => {
    if (!approved || !srcDoc) return
    if (securityMode === 'off') return
    const timer = window.setTimeout(() => {
      if (helloRef.current) return
      securityHit(
        '主页安全组件未生效，已拒绝运行',
        '未收到沙箱内安全检查 SDK 的握手（window.hc 缺失，CSP 也可能未注入）'
      )
    }, 6000)
    return () => window.clearTimeout(timer)
  }, [approved, srcDoc, securityMode, securityHit])

  // 主进程在导航发生「前」拦下沙箱主页的对外跳转（F-05 / D01 / D02）：meta refresh 由 SDK
  // 就地摘除、location 赋值由主进程阻断。这类导航不受 connect-src 管辖，命中即视为外泄，
  // 这里负责把全屏封锁遮罩弹出来。
  useEffect(() => {
    return window.api.homepage.onNavBlocked((url) => {
      securityHit('沙箱主页尝试跳转到外部地址（导航外泄）', url)
    })
  }, [securityHit])

  return (
    <HomepageFrame
      entry={data.entry}
      error={data.error}
      srcDoc={srcDoc}
      approved={approved}
      frameRef={frameRef}
      onApproved={(next: HomepageEntry) => {
        data.setEntry((prev) => (prev ? { ...prev, ...next } : prev))
        setPassed(true)
      }}
      // 关闭 / 取消：停用该主页并刷新设置，让外层 HomeRoute 退回内置「启动游戏」界面
      //（只调 setActive('') 而不刷新，界面会一直停在闸门弹窗上，表现为「关闭无效」）。
      onCancel={() => {
        void window.api.homepage.setActive('').then(reloadSettings)
      }}
    />
  )
}

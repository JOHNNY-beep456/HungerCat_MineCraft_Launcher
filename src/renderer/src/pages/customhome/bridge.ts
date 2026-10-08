// ---------------------------------------------------------------------------
// SDK 桥接：宿主能力分发（hc.* 的实现）与 postMessage 消息分发。
//
// 脚本通过父窗口 postMessage 发来四类消息（call / hello / probe / cursor），
// 本模块负责：
//   - 解析并校验来源（只接受本 iframe）；
//   - hello 时回 init、快照变化时推 update、日志增量推 log、探针命中即封锁；
//   - call 时先做安全检查再调用宿主能力，并把结果 / 错误回写。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { MutableRefObject, RefObject } from 'react'
import type {
  HomepageSource,
  InstalledVersion,
  LaunchOptions,
  LaunchState,
  LauncherSettings,
  MinecraftAccount,
  SystemMemoryInfo
} from '@shared/types'
import { scanHomepageCodeAsync } from '@shared/homepage-runtime'
import { activeGameDir } from '../../store'
import { emitCursor } from '../../cursor'
import { FLOOD_WHERE, TOKENS } from './constants'
import { httpOrigin } from './security'
import type {
  AccountInfo,
  FrameCall,
  FrameCursor,
  FrameHello,
  FrameProbe,
  HostSnapshot,
  ModelSkin,
  SelectedVersionInfo,
  VersionDirInfo
} from './types'

export interface HostBridgeOptions {
  /** 承载脚本的 iframe 元素 ref。 */
  frameRef: RefObject<HTMLIFrameElement>
  settings: LauncherSettings
  /** 当前界面明暗模式。 */
  theme: 'light' | 'dark'
  /** 当前生效的安全档位（开发模式专用）。 */
  securityMode: 'full' | 'warn' | 'off'
  securityHit: (reason: string, detail: string) => boolean
  entry: HomepageSource | null
  memInfo: SystemMemoryInfo | null
  accountInfo: AccountInfo | null
  modelSkin: ModelSkin | null
  installed: InstalledVersion[]
  selectedVersionId: string
  selectedVersion: SelectedVersionInfo | null
  versionDirInfos: VersionDirInfo[]
  activeDirId: string
  selectVersionDir: (next: string) => Promise<string>
  launcherVersion: string
  launchState: LaunchState | null
  launchLog: string[]
  launchPid: number | null
  running: boolean
  starting: boolean
  busy: boolean
  selectedAccount: MinecraftAccount | null
  launch: (opts: LaunchOptions) => Promise<void>
  stopLaunch: () => void
  updateSettings: (p: Partial<LauncherSettings>) => Promise<void>
  /** 授权联网时真正放行的「源」清单。 */
  approvedOrigins: string[]
  /** 宿主自身使用的头像源（探针豁免）。 */
  avatarOrigin: string
  /** 宿主自身使用的皮肤源（探针豁免）。 */
  skinOrigin: string
}

export interface HostBridge {
  /** 沙箱内 SDK 是否已握手（收到 hello）。用于判定 CSP/SDK 注入是否真的生效。 */
  helloRef: MutableRefObject<boolean>
}

/**
 * 组装宿主能力桥与消息分发。返回握手标记 ref，供外层握手看门狗读取。
 */
export function useHostBridge(options: HostBridgeOptions): HostBridge {
  const {
    frameRef,
    settings,
    theme,
    securityMode,
    securityHit,
    entry,
    memInfo,
    accountInfo,
    modelSkin,
    installed,
    selectedVersionId,
    selectedVersion,
    versionDirInfos,
    activeDirId,
    selectVersionDir,
    launcherVersion,
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
  } = options

  const dispatchRef = useRef<(method: string, params: Record<string, unknown>) => Promise<unknown>>(
    async () => null
  )
  const sentLogRef = useRef(0)
  /** 沙箱内 SDK 是否已握手（收到 hello）。用于判定 CSP/SDK 注入是否真的生效。 */
  const helloRef = useRef(false)

  /**
   * 运行时探针批次的串行链：探针扫描已异步化（分片让出事件循环），用一条 Promise 链
   * 保证批次按到达顺序处理——既不会乱序，也不会因为让出事件循环而漏掉任何一批。
   */
  const probeChainRef = useRef<Promise<void>>(Promise.resolve())

  const clampMemory = useCallback(
    (raw: unknown): number => {
      const mb = Math.round(Number(raw))
      const cap = Math.max(1024, Math.floor((memInfo?.free ?? 16384) / 512) * 512)
      if (!Number.isFinite(mb)) {
        if (securityHit('主页脚本传入了非法的内存参数（疑似伪造 / 探测）', `memoryMb=${String(raw)}`)) {
          throw new Error('内存参数非法')
        }
        // 仅提示 / 完全关闭：不阻断，回落到当前设置值。
        return settings.memoryMb
      }
      if (mb < 1024 || mb > cap) {
        if (
          securityHit(
            '主页脚本请求写入超出范围的内存参数（疑似越权篡改启动配置）',
            `memoryMb=${mb}（允许 1024–${cap} MB）`
          )
        ) {
          throw new Error(`内存参数超出允许范围（1024–${cap} MB）`)
        }
        // 仅提示 / 完全关闭：夹到允许范围内，避免真的写入越权值。
        return Math.min(cap, Math.max(1024, mb))
      }
      return mb
    },
    [memInfo, securityHit, settings.memoryMb]
  )

  const dispatch = useCallback(
    async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      // 每条指令运行前都过一遍安全检查：脚本可能把危险代码藏进参数交给宿主执行。
      // 「完全关闭」档位下跳过扫描，便于开发者自由调试。
      if (securityMode !== 'off') {
        let probeText = method
        try {
          probeText = `${method} ${JSON.stringify(params ?? {})}`
        } catch {
          /* 参数不可序列化时只查方法名 */
        }
        // 异步扫描（分片让出事件循环），避免拖长指令响应；判定与同步版完全一致。
        const hits = await scanHomepageCodeAsync(probeText, 'payload')
        if (hits.length > 0) {
          if (securityHit(hits[0], `指令 ${method}：${hits.join('；')}`)) {
            throw new Error('该指令被安全策略拦截，已停用该主页')
          }
        }
      }
      switch (method) {
        case 'system.memory':
          return memInfo
        case 'settings.memory.get':
          return settings.memoryMb
        case 'settings.memory.set': {
          const mb = clampMemory(params['memoryMb'])
          await updateSettings({ memoryMb: mb })
          return mb
        }
        case 'account.current':
          return accountInfo
        case 'account.avatar':
          return accountInfo?.avatarUrl ?? ''
        case 'model3d.skin':
          // 3D 模型所需的皮肤 / 披风贴图与模型类型（离线 / 未设置皮肤为 null）。
          return modelSkin
        case 'versions.list':
          return installed
        case 'versions.selected':
          return selectedVersionId
        case 'versions.select': {
          const next = String(params['id'] ?? '')
          if (!installed.some((v) => v.id === next)) throw new Error(`版本不可用：${next || '(空)'}`)
          await updateSettings({ selectedVersionId: next })
          return next
        }
        case 'versions.info':
          return selectedVersion
        case 'versions.loader':
          // 无选中版本时同样视为「原版」：它没有加载器。
          return selectedVersion?.loaderName ?? '原版'
        case 'versions.number':
          return selectedVersion?.number ?? ''
        case 'versiondirs.list':
          return versionDirInfos
        case 'versiondirs.selected':
          return activeDirId
        case 'versiondirs.select': {
          const next = String(params['id'] ?? '')
          await selectVersionDir(next)
          return next
        }
        case 'launcher.version':
          return launcherVersion
        case 'game.state':
          return {
            state: launchState,
            running,
            starting,
            busy,
            pid: launchPid,
            versionId: selectedVersionId,
            debug: settings.debugMode
          }
        case 'game.launch': {
          // 回退：无账号 / 无已安装版本时给出可读错误；Java 不兼容由运行时的 Java 提示接管。
          if (!selectedAccount) throw new Error('尚未登录账号，请先在「账号」页登录')
          if (!selectedVersionId) throw new Error('没有已安装的游戏版本，请先在「资源下载」页安装')
          // 不传 javaPath：由主进程按「Java 管理 → 自动检测」开关决定用哪个 Java。
          const opts: LaunchOptions = {
            versionId: selectedVersionId,
            accountId: selectedAccount.id,
            gameDir: activeGameDir(settings),
            memoryMb: settings.memoryMb
          }
          await launch(opts)
          return { ok: true, versionId: selectedVersionId }
        }
        case 'game.stop':
          if (!running && !starting && !busy) return { ok: true, stopped: false }
          stopLaunch()
          return { ok: true, stopped: true }
        case 'log.write': {
          const level = params['level']
          // 单条日志必须折叠成一行：换行能让脚本伪造出多条「启动器日志」，
          // 在控制台 / 日志里混淆真实输出（F-14 / D07）。顺带剔除其它控制字符。
          const message = String(params['message'] ?? '')
            .replace(/[\r\n\u2028\u2029]+/g, ' ⏎ ')
            .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
            .slice(0, 4000)
          window.api.homepage.log(
            level === 'warn' || level === 'error' ? level : 'info',
            message
          )
          return null
        }
        case 'theme.get':
          return {
            mode: theme,
            setting: settings.theme,
            accentColor: settings.accentColor,
            background: settings.background,
            reducedMotion: settings.reducedMotion,
            debug: settings.debugMode
          }
        case 'shell.openExternal': {
          if (!entry?.networkApproved) throw new Error('该脚本未获得联网授权，禁止打开外部链接')
          const url = String(params['url'] ?? '')
          if (!/^https?:\/\//i.test(url)) throw new Error('仅允许打开 http/https 链接')
          // 只放行安装清单里声明过的源：拼接 / 运行期生成的地址静态收集不到，多半是诱骗外链（F-13 / D06 / C10③）。
          const origin = httpOrigin(url)
          if (!origin || !approvedOrigins.includes(origin)) {
            // 完全模拟：直接封锁；仅提示 / 完全关闭：放行继续打开。
            if (securityHit('脚本请求打开安装清单之外的链接（疑似诱骗外链）', url)) {
              throw new Error('该链接不在安装时声明的外部地址清单内，已拒绝打开')
            }
          }
          await window.api.shell.openExternal(url)
          return url
        }
        default:
          throw new Error(`不支持的接口：${method}`)
      }
    },
    [
      memInfo,
      clampMemory,
      securityHit,
      updateSettings,
      settings.memoryMb,
      settings.gameDir,
      settings.javaPath,
      settings.debugMode,
      settings.theme,
      settings.accentColor,
      settings.background,
      settings.reducedMotion,
      accountInfo,
      installed,
      selectedVersionId,
      selectedVersion,
      versionDirInfos,
      activeDirId,
      selectVersionDir,
      launcherVersion,
      launchState,
      running,
      starting,
      busy,
      launchPid,
      selectedAccount,
      launch,
      stopLaunch,
      entry?.networkApproved,
      approvedOrigins,
      modelSkin,
      theme
    ]
  )

  // 每次渲染后刷新，保证消息处理器始终调用最新的能力实现。
  useEffect(() => {
    dispatchRef.current = dispatch
  })

  const readTokens = useCallback((): Record<string, string> => {
    const cs = getComputedStyle(document.documentElement)
    const out: Record<string, string> = {}
    for (const [target, source] of TOKENS) {
      const value = cs.getPropertyValue(source).trim()
      if (value) out[target] = value
    }
    out['--hc-accent'] = settings.accentColor
    return out
  }, [settings.accentColor])

  const snapshot: HostSnapshot = useMemo(
    () => ({
      memory: memInfo,
      allocatedMemory: settings.memoryMb,
      account: accountInfo,
      versions: installed,
      selectedVersionId,
      selectedVersion,
      versionDirs: versionDirInfos,
      selectedVersionDirId: activeDirId,
      launcherVersion,
      launch: {
        state: launchState,
        running,
        starting,
        busy,
        pid: launchPid,
        debug: settings.debugMode
      },
      theme: {
        mode: theme,
        setting: settings.theme,
        accentColor: settings.accentColor,
        background: settings.background,
        reducedMotion: settings.reducedMotion
      }
    }),
    [
      memInfo,
      settings.memoryMb,
      settings.debugMode,
      settings.theme,
      settings.accentColor,
      settings.background,
      settings.reducedMotion,
      accountInfo,
      installed,
      selectedVersionId,
      selectedVersion,
      versionDirInfos,
      activeDirId,
      launcherVersion,
      launchState,
      running,
      starting,
      busy,
      launchPid,
      theme
    ]
  )

  const postToFrame = useCallback((payload: unknown): void => {
    frameRef.current?.contentWindow?.postMessage(payload, '*')
  }, [])

  // 宿主 → 脚本：hello 时回 init，之后每次快照变化推 update。令牌在 rAF 里读，
  // 确保主题切换后的计算结果样式已经生效。
  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const handle = requestAnimationFrame(() => {
      frame.contentWindow?.postMessage(
        { hc: 1, kind: 'update', data: { tokens: readTokens(), snapshot } },
        '*'
      )
    })
    return () => cancelAnimationFrame(handle)
  }, [snapshot, readTokens])

  // 脚本 → 宿主：只接受本 iframe 发来的消息。
  useEffect(() => {
    /**
     * 处理一批运行时探针（新增元素 / 动态写入的源码）。
     *
     * 扫描已异步化（scanHomepageCodeAsync 分片让出事件循环），因此调用方把批次串行挂在
     * probeChainRef 上：先到的批次先处理，绝不让任何一批被跳过（漏一批 = 漏一次检测）。
     * 到达这里的元素其实已经进了 DOM，所以这里做的是「发现即封停」，真正的预防由
     * 沙箱 iframe + CSP 承担。
     */
    const handleProbeBatch = async (batch: NonNullable<FrameProbe['batch']>): Promise<void> => {
      for (const item of batch) {
        const where = String(item?.where ?? 'element')
        const text = String(item?.text ?? '')
        if (where === FLOOD_WHERE) {
          if (securityHit('短时间内在页面中插入大量元素，疑似规避安全检查', '运行时探针队列溢出')) return
          continue
        }
        // 绕过 CSP 的隐蔽通道（WebRTC / STUN）：与是否授权联网无关，一律封锁（D08）。
        if (where.startsWith('danger:')) {
          if (securityHit('脚本使用了绕过 CSP 的隐蔽通道（WebRTC，疑似外泄 / 内网探测）', `${where.slice(7)} → ${text}`)) return
          continue
        }
        // 未获准联网的脚本真的发起外部请求时立即封锁：拼接 / 模板构造出的地址静态收集不到（F-08），
        // 这是 CSP 之外的第二道兜底。
        if (where.startsWith('net:')) {
          const origin = httpOrigin(text)
          // 启动器通过 hc.account.avatar() 暴露的头像源属于宿主可信资源，不是脚本外链：
          // 无论脚本是否授权联网都放行，否则只是显示玩家头像的主页会被误判成「非法联网」。
          if (origin && (origin === avatarOrigin || (skinOrigin && origin === skinOrigin))) continue
          if (!entry?.networkApproved) {
            if (securityHit('未获准联网的脚本发起了外部请求（疑似伪装行为）', `${where.slice(4)} → ${text}`)) return
            continue
          }
          // 已授权也要比对「源」：清单只放行安装时看到的那些源，其余一律按越权外泄处理（F-04 / D03 / D04）。
          if (origin && !approvedOrigins.includes(origin)) {
            if (
              securityHit(
                '脚本访问了安装清单之外的外部地址（疑似越权外泄）',
                `${where.slice(4)} → ${text}（不在授权源清单内）`
              )
            ) {
              return
            }
          }
          continue
        }
        // write / writeln 注入脚本，或元素属性写成 javascript: 伪协议：按「伪装代码」处理（F-10 / B06）。
        if (where.includes('#')) {
          const [kind, flags] = where.split('#')
          if (
            securityHit(
              '运行时动态写入了脚本 / 事件处理器 / javascript: 伪协议内容（疑似伪装代码）',
              `${kind} 写入内容含：${flags}`
            )
          ) {
            return
          }
          continue
        }
        // 不截断：截断会让危险关键字落在被砍掉的部分而漏检（F-01 / B01）。
        // 异步扫描（分片让出事件循环）与同步版判定完全一致，只改变何时出结论。
        const hits = await scanHomepageCodeAsync(text, 'code', { maxLength: 0 })
        if (hits.length > 0) {
          if (securityHit(hits[0], `${where}：${hits.join('；')}`)) return
        }
      }
    }

    const onMessage = (e: MessageEvent): void => {
      const frame = frameRef.current
      if (!frame || e.source !== frame.contentWindow) return
      const data = e.data as FrameCall | FrameHello | FrameProbe | FrameCursor | null
      if (!data || typeof data !== 'object' || data.hc !== 1) return

      // 沙箱内鼠标移动：换算成宿主窗口坐标，驱动跟随光标的光晕（iframe 会吞掉 mousemove）。
      if (data.kind === 'cursor') {
        const rect = frame.getBoundingClientRect()
        emitCursor(rect.left + Number(data.x || 0), rect.top + Number(data.y || 0))
        return
      }

      // 沙箱内「每个元素加载」后的探针：把新增元素 / 动态写入的源码再查一遍。
      if (data.kind === 'probe') {
        if (!Array.isArray(data.batch)) return
        const batch = data.batch
        // 串行排队：保证批次顺序，且不让「让出事件循环」影响「每一批迟早都会被检查」。
        probeChainRef.current = probeChainRef.current
          .then(() => handleProbeBatch(batch))
          .catch(() => {
            /* 单批异常不阻断后续批次 */
          })
        return
      }

      if (data.kind === 'hello') {
        helloRef.current = true
        sentLogRef.current = 0
        postToFrame({ hc: 1, kind: 'init', data: { tokens: readTokens(), snapshot } })
        if (settings.debugMode && launchLog.length > 0) {
          const lines = launchLog.slice(-200)
          sentLogRef.current = launchLog.length
          postToFrame({ hc: 1, kind: 'log', data: { lines } })
        }
        return
      }

      if (data.kind !== 'call') return
      const call = data
      void (async () => {
        try {
          const result = await dispatchRef.current(call.method, call.params ?? {})
          postToFrame({ hc: 1, kind: 'result', id: call.id, ok: true, data: result ?? null })
        } catch (err) {
          postToFrame({
            hc: 1,
            kind: 'result',
            id: call.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      })()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [postToFrame, readTokens, snapshot, settings.debugMode, launchLog, securityHit, entry?.networkApproved, approvedOrigins, avatarOrigin, skinOrigin])

  // 运行日志：仅在 Debug 模式推送给脚本，且只推增量。
  useEffect(() => {
    if (!settings.debugMode) {
      sentLogRef.current = launchLog.length
      return
    }
    if (launchLog.length <= sentLogRef.current) return
    const lines = launchLog.slice(sentLogRef.current)
    sentLogRef.current = launchLog.length
    postToFrame({ hc: 1, kind: 'log', data: { lines } })
  }, [launchLog, settings.debugMode, postToFrame])

  return { helloRef }
}

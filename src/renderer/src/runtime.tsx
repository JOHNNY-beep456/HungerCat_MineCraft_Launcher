import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { DownloadProgress, LaunchEvent, LaunchOptions, LaunchState } from '@shared/types'
import { diagnoseLaunch, type LaunchReport } from './launch-diagnosis'
import { useApp } from './store'

interface RuntimeState {
  download: DownloadProgress | null
  /** 并发下载任务列表 */
  downloads: DownloadProgress[]
  launchState: LaunchState | null
  launchLog: string[]
  launchPid: number | null
  /** 启动异常诊断报告：非空时界面弹窗展示（可关闭）。 */
  launchReport: LaunchReport | null
  /** 是否正在分析启动错误：为真时界面以非侵入式方式显示「错误分析中…」。 */
  analyzingReport: boolean
  busy: boolean
  installingId: string | null
  /** Non-null when a Java version mismatch is waiting for the user's decision. */
  javaPrompt: { required: number } | null
  /** 下载光球动画的起点（屏幕坐标） */
  flyFrom: { x: number; y: number; key: number } | null
  triggerFly: (x: number, y: number) => void
  installVersion: (id: string, dirId?: string) => Promise<void>
  cancelDownload: () => void
  /** 只取消单个下载任务（按 taskId），不影响其它并行任务。 */
  cancelTask: (taskId: string) => void
  launch: (opts: LaunchOptions) => Promise<void>
  stopLaunch: () => void
  clearLog: () => void
  installJavaAndLaunch: () => Promise<void>
  cancelJavaPrompt: () => void
  /** 关闭启动异常报告弹窗。 */
  dismissLaunchReport: () => void
}

const RuntimeContext = createContext<RuntimeState | null>(null)

/**
 * 仅包含「稳定」动作回调（引用在正常运行期间不变），供仅需触发动作的大列表页
 * （资源下载 / 实例列表）订阅。这样下载进度的 80ms 级状态刷新不会让这些整页
 * 重新渲染，降低滚动列表的渲染压力。
 */
interface RuntimeActions {
  triggerFly: (x: number, y: number) => void
  installVersion: (id: string, dirId?: string) => Promise<void>
  cancelDownload: () => void
  /** 只取消单个下载任务（按 taskId），不影响其它并行任务。 */
  cancelTask: (taskId: string) => void
  launch: (opts: LaunchOptions) => Promise<void>
  stopLaunch: () => void
  clearLog: () => void
  installJavaAndLaunch: () => Promise<void>
  cancelJavaPrompt: () => void
  /** 关闭启动异常报告弹窗。 */
  dismissLaunchReport: () => void
}

const RuntimeActionsContext = createContext<RuntimeActions | null>(null)

export function RuntimeProvider({ children }: { children: ReactNode }): JSX.Element {
  // 启动游戏后自动跳转到「启动游戏」页：由这里发起全局导航请求，最外层 Shell 消费。
  const { requestNavigate } = useApp()
  const [downloads, setDownloads] = useState<DownloadProgress[]>([])
  const [launchState, setLaunchState] = useState<LaunchState | null>(null)
  const [launchLog, setLaunchLog] = useState<string[]>([])
  const [launchPid, setLaunchPid] = useState<number | null>(null)
  const [launchReport, setLaunchReport] = useState<LaunchReport | null>(null)
  /** 是否正在分析启动错误（用于非侵入式显示「错误分析中…」）。 */
  const [analyzingReport, setAnalyzingReport] = useState(false)
  /** 启动日志的最新快照：onEvent 闭包内需读取最新值做诊断，故用 ref 而非 state。 */
  const launchLogRef = useRef<string[]>([])
  /** 「错误分析中」提示的定时器：延迟一帧再计算报告，让提示先绘制出来。 */
  const analyzeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [busy, setBusy] = useState(false)
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [javaPrompt, setJavaPrompt] = useState<{ required: number } | null>(null)
  const [flyFrom, setFlyFrom] = useState<{ x: number; y: number; key: number } | null>(null)
  const pendingLaunchRef = useRef<LaunchOptions | null>(null)

  const download = useMemo(() => (downloads.length > 0 ? downloads[downloads.length - 1] : null), [downloads])

  useEffect(() => {
    // 下载进度事件频率极高（每个网络分块都会触发），直接逐条 setState 会让整个
    // RuntimeContext 的高频重渲染拖慢 UI。这里把中间进度合并、节流到约 80ms 刷新
    // 一次；done 事件仍即时处理，保证完成状态与光球动画不延迟。
    const pendingProgress = new Map<string, DownloadProgress>()
    let flushTimer: ReturnType<typeof setTimeout> | null = null

    const flushProgress = (): void => {
      flushTimer = null
      if (pendingProgress.size === 0) return
      const batch = new Map(pendingProgress)
      pendingProgress.clear()
      setDownloads((prev) => {
        const keep = prev.filter((t) => !batch.has(t.taskId ?? 'main'))
        return [...keep, ...batch.values()]
      })
    }

    const offDownload = window.api.download.onProgress((p) => {
      const id = p.taskId ?? 'main'
      if (p.phase === 'done') {
        pendingProgress.delete(id)
        // done 即时移除该任务条目（含合并中的批次），保证光球 / 进度条不残留。
        setDownloads((prev) => prev.filter((t) => (t.taskId ?? 'main') !== id))
        if (id === 'main') setInstallingId(null)
        return
      }
      const firstForId = !pendingProgress.has(id)
      pendingProgress.set(id, p)
      if (flushTimer == null) {
        // 首个进度立即落库（firstForId 用 0 延迟的下一个宏任务），让光球几乎无延迟出现；
        // 后续高频进度仍走 80ms 合并节流，避免拖慢高频重渲染。
        flushTimer = setTimeout(flushProgress, firstForId ? 0 : 80)
      }
    })
    const offLaunch = window.api.launch.onEvent((e: LaunchEvent) => {
      // 纯日志事件（只有 log、无 state）不改变状态：状态只由生命周期事件驱动，
      // 避免每来一行游戏输出都把状态刷回「运行中」。
      if (e.state) {
        if (e.state === 'running') {
          if (e.pid) setLaunchPid(e.pid)
          setLaunchState('running')
        } else {
          setLaunchState(e.state)
        }
      }
      const log = e.log
      if (log) {
        launchLogRef.current = [...launchLogRef.current, log]
        setLaunchLog(launchLogRef.current)
      }
      if (e.state === 'exited' || e.state === 'error') {
        setBusy(false)
        setLaunchPid(null)
        // 启动失败 / 非正常退出：先非侵入式提示「错误分析中…」，再按关键词分析日志
        // 生成可读报告；未能识别时报告里仍保留原始错误内容，直接输出给用户。
        if (e.state === 'error' || (e.exitCode !== undefined && e.exitCode !== 0)) {
          const logs = launchLogRef.current
          const error = e.error
          const exitCode = e.exitCode
          setAnalyzingReport(true)
          if (analyzeTimerRef.current != null) clearTimeout(analyzeTimerRef.current)
          // 延后到下一帧再计算：同步计算会与提示同一帧提交，用户看不到「分析中」。
          analyzeTimerRef.current = setTimeout(() => {
            analyzeTimerRef.current = null
            setLaunchReport(diagnoseLaunch(logs, error, exitCode))
            setAnalyzingReport(false)
          }, 0)
        }
      }
    })
    return () => {
      if (flushTimer != null) clearTimeout(flushTimer)
      if (analyzeTimerRef.current != null) clearTimeout(analyzeTimerRef.current)
      offDownload()
      offLaunch()
    }
  }, [])

  const installVersion = useCallback(async (id: string, dirId?: string) => {
    setBusy(true)
    setInstallingId(id)
    try {
      await window.api.download.install(id, dirId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('下载已取消')) {
        setLaunchState('error')
        setLaunchLog([msg])
      }
    } finally {
      setBusy(false)
      setInstallingId(null)
      setDownloads((prev) => prev.filter((t) => (t.taskId ?? 'main') !== id))
    }
  }, [])

  const cancelDownload = useCallback(() => {
    void window.api.download.cancel()
  }, [])

  /** 只取消单个下载任务（按 taskId），不影响其它并行任务。 */
  const cancelTask = useCallback((taskId: string) => {
    void window.api.download.cancel(taskId)
    // 先在 UI 上即时移除；主进程随后也会补一条 done，两者幂等。
    setDownloads((prev) => prev.filter((t) => (t.taskId ?? 'main') !== taskId))
  }, [])

  const doLaunch = useCallback(
    async (opts: LaunchOptions) => {
      // 无论从哪个界面发起启动，都先跳到「启动游戏」页，让用户看到启动进度与结果。
      requestNavigate('home')
      setBusy(true)
      launchLogRef.current = []
      setLaunchReport(null)
      setAnalyzingReport(false)
      setLaunchLog([])
      setLaunchState('starting')
      setLaunchPid(null)
      setDownloads([])
      try {
        const { pid } = await window.api.launch.start(opts)
        setLaunchPid(pid || null)
      } catch (err) {
        setLaunchState('error')
        setLaunchLog([err instanceof Error ? err.message : String(err)])
        setBusy(false)
      } finally {
        // 启动时的补全下载完成后（无论成功、失败还是取消），清理该版本的进度条目，
        // 避免「进度」页 / 控制台在下载结束后仍残留进度条。
        setDownloads((prev) => prev.filter((t) => (t.taskId ?? 'main') !== opts.versionId))
      }
    },
    [requestNavigate]
  )

  const launch = useCallback(
    async (opts: LaunchOptions) => {
      try {
        const check = await window.api.java.check(opts.versionId)
        if (!check.compatible) {
          pendingLaunchRef.current = opts
          setJavaPrompt({ required: check.required })
          return
        }
      } catch {
        /* fall through — the main process will surface any Java error */
      }
      await doLaunch(opts)
    },
    [doLaunch]
  )

  const installJavaAndLaunch = useCallback(async () => {
    const prompt = javaPrompt
    const opts = pendingLaunchRef.current
    if (!prompt || !opts) return
    setJavaPrompt(null)
    pendingLaunchRef.current = null
    setBusy(true)
    launchLogRef.current = []
    setLaunchReport(null)
    setAnalyzingReport(false)
    setLaunchLog([])
    setLaunchState('starting')
    try {
      const path = await window.api.java.install(prompt.required)
      await doLaunch({ ...opts, javaPath: path })
    } catch (err) {
      setLaunchState('error')
      setLaunchLog([err instanceof Error ? err.message : String(err)])
      setBusy(false)
    }
  }, [javaPrompt, doLaunch])

  const cancelJavaPrompt = useCallback(() => {
    pendingLaunchRef.current = null
    setJavaPrompt(null)
  }, [])

  const stopLaunch = useCallback(() => {
    void window.api.launch.stop()
  }, [])

  const clearLog = useCallback(() => setLaunchLog([]), [])
  const dismissLaunchReport = useCallback(() => setLaunchReport(null), [])

  const triggerFly = useCallback((x: number, y: number) => {
    setFlyFrom({ x, y, key: Date.now() })
  }, [])

  const actions = useMemo<RuntimeActions>(
    () => ({
      triggerFly,
      installVersion,
      cancelDownload,
      cancelTask,
      launch,
      stopLaunch,
      clearLog,
      installJavaAndLaunch,
      cancelJavaPrompt,
      dismissLaunchReport
    }),
    [triggerFly, installVersion, cancelDownload, cancelTask, launch, stopLaunch, clearLog, installJavaAndLaunch, cancelJavaPrompt, dismissLaunchReport]
  )

  const value = useMemo<RuntimeState>(
    () => ({
      download,
      downloads,
      launchState,
      launchLog,
      launchPid,
      launchReport,
      analyzingReport,
      busy,
      installingId,
      javaPrompt,
      flyFrom,
      ...actions
    }),
    [download, downloads, launchState, launchLog, launchPid, launchReport, analyzingReport, busy, installingId, javaPrompt, flyFrom, actions]
  )

  return (
    <RuntimeActionsContext.Provider value={actions}>
      <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>
    </RuntimeActionsContext.Provider>
  )
}

export function useRuntime(): RuntimeState {
  const ctx = useContext(RuntimeContext)
  if (!ctx) throw new Error('useRuntime must be used within RuntimeProvider')
  return ctx
}

export function useRuntimeActions(): RuntimeActions {
  const ctx = useContext(RuntimeActionsContext)
  if (!ctx) throw new Error('useRuntimeActions must be used within RuntimeProvider')
  return ctx
}

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

interface RuntimeState {
  download: DownloadProgress | null
  /** 并发下载任务列表 */
  downloads: DownloadProgress[]
  launchState: LaunchState | null
  launchLog: string[]
  launchPid: number | null
  busy: boolean
  installingId: string | null
  /** Non-null when a Java version mismatch is waiting for the user's decision. */
  javaPrompt: { required: number } | null
  /** 下载光球动画的起点（屏幕坐标） */
  flyFrom: { x: number; y: number; key: number } | null
  triggerFly: (x: number, y: number) => void
  installVersion: (id: string) => Promise<void>
  cancelDownload: () => void
  launch: (opts: LaunchOptions) => Promise<void>
  stopLaunch: () => void
  clearLog: () => void
  installJavaAndLaunch: () => Promise<void>
  cancelJavaPrompt: () => void
}

const RuntimeContext = createContext<RuntimeState | null>(null)

/**
 * 仅包含「稳定」动作回调（引用在正常运行期间不变），供仅需触发动作的大列表页
 * （资源下载 / 实例列表）订阅。这样下载进度的 80ms 级状态刷新不会让这些整页
 * 重新渲染，降低滚动列表的渲染压力。
 */
interface RuntimeActions {
  triggerFly: (x: number, y: number) => void
  installVersion: (id: string) => Promise<void>
  cancelDownload: () => void
  launch: (opts: LaunchOptions) => Promise<void>
  stopLaunch: () => void
  clearLog: () => void
  installJavaAndLaunch: () => Promise<void>
  cancelJavaPrompt: () => void
}

const RuntimeActionsContext = createContext<RuntimeActions | null>(null)

export function RuntimeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [downloads, setDownloads] = useState<DownloadProgress[]>([])
  const [launchState, setLaunchState] = useState<LaunchState | null>(null)
  const [launchLog, setLaunchLog] = useState<string[]>([])
  const [launchPid, setLaunchPid] = useState<number | null>(null)
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
      if (e.state === 'running') {
        if (e.pid) setLaunchPid(e.pid)
        setLaunchState('running')
      } else if (e.state === 'downloading') {
        setLaunchState('downloading')
      } else {
        setLaunchState(e.state)
      }
      const log = e.log
      if (log) {
        setLaunchLog((prev) => [...prev, log])
      }
      if (e.state === 'exited' || e.state === 'error') {
        setBusy(false)
        setLaunchPid(null)
      }
    })
    return () => {
      if (flushTimer != null) clearTimeout(flushTimer)
      offDownload()
      offLaunch()
    }
  }, [])

  const installVersion = useCallback(async (id: string) => {
    setBusy(true)
    setInstallingId(id)
    try {
      await window.api.download.install(id)
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

  const doLaunch = useCallback(async (opts: LaunchOptions) => {
    setBusy(true)
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
  }, [])

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

  const triggerFly = useCallback((x: number, y: number) => {
    setFlyFrom({ x, y, key: Date.now() })
  }, [])

  const actions = useMemo<RuntimeActions>(
    () => ({
      triggerFly,
      installVersion,
      cancelDownload,
      launch,
      stopLaunch,
      clearLog,
      installJavaAndLaunch,
      cancelJavaPrompt
    }),
    [triggerFly, installVersion, cancelDownload, launch, stopLaunch, clearLog, installJavaAndLaunch, cancelJavaPrompt]
  )

  const value = useMemo<RuntimeState>(
    () => ({
      download,
      downloads,
      launchState,
      launchLog,
      launchPid,
      busy,
      installingId,
      javaPrompt,
      flyFrom,
      ...actions
    }),
    [download, downloads, launchState, launchLog, launchPid, busy, installingId, javaPrompt, flyFrom, actions]
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

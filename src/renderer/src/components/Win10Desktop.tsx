// ---------------------------------------------------------------------------
// 实验性功能 2：Win10 桌面。
//
// 开启后窗口自动全屏，启动器各功能以「桌面图标」呈现（双击打开），打开的页面
// 落在可拖动的窗口里，底部是任务栏（开始菜单 / 已开窗口 / 时钟）。窗口内部渲染的
// 仍是启动器原有页面，配色由 [data-skin='win10'] 的扁平令牌接管。
//
// 与「仿 Mac 玻璃」皮肤互斥：设置里两者共用一个 experimental 字段。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { NativeWindowInfo } from '@shared/types'
import { NAV, type PageId } from './Sidebar'
import { Avatar, Icon } from './ui'
import { activeGameDir, useApp } from '../store'
import { useRuntime } from '../runtime'
import { renderPage } from '../pages/router'
import { InstanceManagePage } from '../pages/InstanceManagePage'
import { FileManager } from './FileManager'
import logo from '../assets/logo.png'

/** 任务栏高度，窗口拖动与最大化都以此留边。 */
const TASKBAR_H = 48

/** 自实现资源管理器在桌面里只保留一个窗口，用固定 key 标识。 */
const FILES_KEY = 'files'

interface WinState {
  /** 同一页面只保留一个窗口，故 key 即页面 id；实例管理窗口用 manage:<实例id>；外部窗口用 native:<hwnd> */
  key: string
  page: PageId
  title: string
  icon: string
  /** 实例管理窗口正在管理的实例 id */
  managingId?: string
  /** 自实现资源管理器窗口当前显示的目录 */
  filePath?: string
  /** 被摆进桌面的外部窗口（目前只有 MC） */
  native?: { id: string; kind: NativeWindowInfo['kind'] }
  x: number
  y: number
  w: number
  h: number
  z: number
  minimized: boolean
  maximized: boolean
}

/* ---------------- 图标 ---------------- */

function WinLogo(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <rect x="0" y="0" width="6.8" height="6.8" />
      <rect x="9.2" y="0" width="6.8" height="6.8" />
      <rect x="0" y="9.2" width="6.8" height="6.8" />
      <rect x="9.2" y="9.2" width="6.8" height="6.8" />
    </svg>
  )
}

function Glyph({ d, size = 12 }: { d: string; size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      aria-hidden
    >
      <path d={d} />
    </svg>
  )
}

/* ---------------- 外部窗口占位 ---------------- */

/**
 * 被摆进桌面的 MC 窗口对应的占位层。
 *
 * 这里不画任何内容：外部窗口始终是独立顶层窗口，被摆在这块矩形的屏幕位置上，
 * 而启动器窗口在这块矩形上挖了洞（SetWindowRgn），于是它直接从这里透出来。
 * 组件只负责把矩形的**设备像素**位置（相对宿主客户区）持续同步给主进程，
 * 拖动 / 最大化 / 改窗口尺寸后外部窗口才会跟着走。
 */
function NativeView({
  id,
  hidden,
  raise,
  onGone
}: {
  id: string
  hidden: boolean
  raise: boolean
  onGone?: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const lastSent = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  const lastAt = useRef(0)

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return null
    // getBoundingClientRect 是相对视口 = 宿主客户区左上角；乘 dpr 得设备像素
    const r = el.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    return {
      x: Math.round(r.left * dpr),
      y: Math.round(r.top * dpr),
      w: Math.round(r.width * dpr),
      h: Math.round(r.height * dpr)
    }
  }, [])

  const sync = useCallback(
    (force = false) => {
      const r = measure()
      if (!r) return
      const prev = lastSent.current
      if (!force && prev && prev.x === r.x && prev.y === r.y && prev.w === r.w && prev.h === r.h) return
      // 兜底节流：即使矩形一直在变，也不比下面这个间隔更密地下发。
      // 高频 SetWindowPos 会把外部窗口（尤其 MC 的 GL 窗口）拖崩。
      const now = Date.now()
      if (!force && now - lastAt.current < 80) return
      lastSent.current = r
      lastAt.current = now
      void window.api.desktop.place(id, r, raise).then((ok) => {
        if (!ok) {
          // 窗口已经不在（被关掉了）：清掉缓存并通知上层重新扫描
          lastSent.current = null
          onGone?.()
        }
      })
    },
    [id, measure, raise, onGone]
  )

  useEffect(() => {
    if (hidden) {
      // 收起空洞：宿主窗口恢复整块，外部窗口被压在下面，启动器界面完整可见。
      // 用户正在拖动这个桌面窗口时也走这里 —— 拖动期间**一次都不下发 SetWindowPos**，
      // 松手后由下一次 sync(true) 一次性摆到新位置。
      // 清掉去重缓存：拖动时预留矩形变了，但拖动期间不下发，松手时必须**强制**摆一次，
      // 否则会被「矩形看起来没变」的判重挡掉。
      lastSent.current = null
      lastAt.current = 0
      void window.api.desktop.setVisible(id, false)
      return
    }
    sync(true)

    // 位置变化没有可靠的事件源（拖动、最大化、宿主缩放）。
    // 用「变化检测 + 节流」的轻量轮询兜底，静止时 sync() 会在测完矩形后直接返回，
    // 不产生任何 IPC 与 SetWindowPos。
    const timer = setInterval(() => sync(), 100)
    const el = ref.current
    const observer =
      el && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => sync()) : null
    if (el && observer) observer.observe(el)

    return () => {
      clearInterval(timer)
      observer?.disconnect()
    }
  }, [id, hidden, sync])

  return <div ref={ref} className="absolute inset-0" />
}

/* ---------------- 桌面 ---------------- */

export function Win10Desktop(): JSX.Element {
  const { settings, selectedAccount, fileManagerPath, fileManagerSeq, openFileManager, closeFileManager, t } =
    useApp()
  const { downloads } = useRuntime()
  const [wins, setWins] = useState<WinState[]>([])
  // 选中项：侧栏页面 id，或桌面「文件资源管理器」快捷方式（用 FILES_KEY 标识）。
  // 所以是 string 而非 PageId —— 后者只覆盖侧栏页面。
  const [selected, setSelected] = useState<string | null>(null)
  const [startOpen, setStartOpen] = useState(false)
  const [now, setNow] = useState(() => new Date())
  const zRef = useRef(10)
  const dragRef = useRef<{ key: string; dx: number; dy: number; nativeId?: string } | null>(null)
  /**
   * 正在被拖动的桌面窗口 key。
   *
   * 拖动**外部窗口**（MC）的桌面窗口时不能跟着下发布局：两个线程同时移动同一个
   * 窗口会把 MC 的 GL 窗口拖崩。所以拖动期间把它的空洞收起来（外部窗口被启动器
   * 界面盖住），松手后一次性摆到新位置。
   */
  const [dragKey, setDragKey] = useState<string | null>(null)

  // 本地模式隐藏联网相关入口，与侧栏保持一致。
  const nav = useMemo(
    () =>
      settings.mode === 'local'
        ? NAV.filter((n) => n.id !== 'resources' && n.id !== 'downloads' && n.id !== 'about')
        : NAV,
    [settings.mode]
  )

  /* --- 强置顶外壳：进入即全屏 + 最高层级置顶 + 从系统任务栏隐藏，
         让 Windows 的任务栏与开始菜单都盖不进来；退出该模式（组件卸载）时还原， */
  useEffect(() => {
    void window.api.window.setDesktopMode(true)
    return () => {
      void window.api.window.setDesktopMode(false)
      // 外部窗口是宿主窗口的子窗口，会随宿主一起销毁：退出前必须还给系统
      void window.api.desktop.releaseAll()
    }
  }, [])

  /* --- 外部窗口：自动摆放 Minecraft --- */
  const [nativeOk, setNativeOk] = useState(false)
  const [nativeList, setNativeList] = useState<NativeWindowInfo[]>([])

  /**
   * 重新拉取外部窗口列表。
   * 必须是稳定引用：NativeView 的同步回调依赖它，若每次渲染都换新引用，
   * 拖动时每次重渲染都会重建回调并重跑 effect，把 SetWindowPos 打到每秒上百次
   * —— 这正是移动窗口会导致外部窗口崩溃的根源。
   */
  const refreshNative = useCallback((): void => {
    void window.api.desktop.list().then(setNativeList)
  }, [])

  useEffect(() => {
    let alive = true
    void window.api.desktop.supported().then((ok) => {
      if (alive) setNativeOk(ok)
    })
    return () => {
      alive = false
    }
  }, [])

  // MC / 资源管理器窗口随时可能开合，定时扫描
  useEffect(() => {
    if (!nativeOk) return
    let alive = true
    const scan = (): void => {
      void window.api.desktop.list().then((list) => {
        if (!alive) return
        setNativeList(list)
        // 外部窗口被关掉了：移除对应的桌面窗口（主进程会保证列表里包含仍存活的已摆放窗口）
        const ids = new Set(list.map((n) => n.id))
        setWins((ws) => {
          const kept = ws.filter((w) => !w.native || ids.has(w.native.id))
          return kept.length === ws.length ? ws : kept
        })
      })
    }
    scan()
    // 超低占用模式：扫描周期放宽到约 3 倍，并在窗口不可见时暂停（重新可见立即补一次）。
    const period = settings.lowUsageMode ? 8000 : 2500
    const tick = (): void => {
      if (settings.lowUsageMode && document.visibilityState === 'hidden') return
      scan()
    }
    const timer = setInterval(tick, period)
    const onVisible = (): void => {
      if (document.visibilityState !== 'hidden') scan()
    }
    if (settings.lowUsageMode) document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [nativeOk, settings.lowUsageMode])

  // MC 启动后自动摆进桌面（列表里只有 MC），窗口还在就同步标题、没了就等下一轮移除
  useEffect(() => {
    if (!nativeOk || nativeList.length === 0) return
    setWins((ws) => {
      let next = ws
      for (const n of nativeList) {
        if (n.kind !== 'minecraft') continue
        const key = `native:${n.id}`
        const exist = next.find((w) => w.key === key)
        if (exist) {
          // 标题会变（例如 MC 切到存档标题），保持同步
          if (exist.title !== n.title) next = next.map((w) => (w.key === key ? { ...w, title: n.title } : w))
          continue
        }
        const vw = window.innerWidth
        const vh = window.innerHeight
        const idx = next.length
        next = [
          ...next,
          {
            key,
            page: 'home',
            title: n.title,
            icon: n.kind === 'minecraft' ? 'play' : 'folder',
            native: { id: n.id, kind: n.kind },
            x: Math.min(96 + idx * 26, Math.max(0, vw - 560)),
            y: Math.min(56 + idx * 24, Math.max(0, vh - TASKBAR_H - 420)),
            w: Math.min(960, Math.max(560, vw - 200)),
            h: Math.min(640, Math.max(380, vh - TASKBAR_H - 160)),
            z: (zRef.current += 1),
            minimized: false,
            maximized: false
          }
        ]
      }
      return next
    })
  }, [nativeList, nativeOk])

  /* --- 自实现资源管理器：把 store 里的目标目录同步成桌面上唯一的「文件」窗口 --- */
  useEffect(() => {
    if (!fileManagerPath) return
    setWins((ws) => {
      const exist = ws.find((w) => w.key === FILES_KEY)
      if (exist) {
        // 目录没变且窗口没被最小化：只置顶。
        // 目录变了、或窗口正最小化（用户又点了一次入口）：换目录并还原。
        if (exist.filePath === fileManagerPath && !exist.minimized) {
          return ws.map((w) => (w.key === FILES_KEY ? { ...w, z: (zRef.current += 1) } : w))
        }
        return ws.map((w) =>
          w.key === FILES_KEY ? { ...w, filePath: fileManagerPath, minimized: false, z: (zRef.current += 1) } : w
        )
      }
      const vw = window.innerWidth
      const vh = window.innerHeight
      const idx = ws.length
      return [
        ...ws,
        {
          key: FILES_KEY,
          page: 'home',
          title: t('shell.win10.fileExplorer'),
          icon: 'folder',
          filePath: fileManagerPath,
          x: Math.min(96 + idx * 26, Math.max(0, vw - 560)),
          y: Math.min(56 + idx * 24, Math.max(0, vh - TASKBAR_H - 420)),
          w: Math.min(960, Math.max(560, vw - 200)),
          h: Math.min(640, Math.max(380, vh - TASKBAR_H - 160)),
          z: (zRef.current += 1),
          minimized: false,
          maximized: false
        }
      ]
    })
  }, [fileManagerPath, fileManagerSeq, t])

  /* --- 任务栏时钟 --- */
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 20_000)
    return () => clearInterval(timer)
  }, [])

  /* --- 任务栏托盘里的下载进度 --- */
  const activeDownloads = downloads.filter((d) => d.phase !== 'done')
  const downloadTotal = activeDownloads.reduce((s, d) => s + (d.totalBytes || 0), 0)
  const downloadCurrent = activeDownloads.reduce((s, d) => s + (d.currentBytes || 0), 0)
  const downloadPercent = downloadTotal > 0 ? Math.round((downloadCurrent / downloadTotal) * 100) : 0

  /* --- Esc 收起开始菜单 --- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setStartOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const metaOf = useCallback(
    (page: PageId): { title: string; icon: string } => {
      const item = NAV.find((n) => n.id === page)
      return { title: t(`nav.${page}`), icon: item?.icon ?? 'cube' }
    },
    [t]
  )

  /* ---------------- 窗口操作 ---------------- */

  const focusWin = useCallback((key: string) => {
    setWins((ws) => ws.map((w) => (w.key === key ? { ...w, z: (zRef.current += 1), minimized: false } : w)))
  }, [])

  const openPage = useCallback(
    (page: PageId) => {
      setStartOpen(false)
      setWins((ws) => {
        if (ws.some((w) => w.key === page)) {
          return ws.map((w) => (w.key === page ? { ...w, minimized: false, z: (zRef.current += 1) } : w))
        }
        const vw = window.innerWidth
        const vh = window.innerHeight
        const idx = ws.length
        const meta = metaOf(page)
        return [
          ...ws,
          {
            key: page,
            page,
            title: meta.title,
            icon: meta.icon,
            x: Math.min(72 + idx * 26, Math.max(0, vw - 560)),
            y: Math.min(36 + idx * 24, Math.max(0, vh - TASKBAR_H - 420)),
            w: Math.min(1040, Math.max(560, vw - 160)),
            h: Math.min(720, Math.max(420, vh - TASKBAR_H - 120)),
            z: (zRef.current += 1),
            minimized: false,
            maximized: false
          }
        ]
      })
    },
    [metaOf]
  )

  const openManage = useCallback((versionId: string) => {
    const key = `manage:${versionId}`
    setStartOpen(false)
    setWins((ws) => {
      if (ws.some((w) => w.key === key)) {
        return ws.map((w) => (w.key === key ? { ...w, minimized: false, z: (zRef.current += 1) } : w))
      }
      const vw = window.innerWidth
      const vh = window.innerHeight
      const idx = ws.length
      return [
        ...ws,
        {
          key,
          page: 'instances',
          title: t('shell.win10.instanceManage', { id: versionId }),
          icon: 'box',
          managingId: versionId,
          x: Math.min(96 + idx * 26, Math.max(0, vw - 560)),
          y: Math.min(48 + idx * 24, Math.max(0, vh - TASKBAR_H - 420)),
          w: Math.min(1040, Math.max(560, vw - 160)),
          h: Math.min(720, Math.max(420, vh - TASKBAR_H - 120)),
          z: (zRef.current += 1),
          minimized: false,
          maximized: false
        }
      ]
    })
  }, [t])

  const closeWin = useCallback((key: string) => {
    setWins((ws) => ws.filter((w) => w.key !== key))
  }, [])

  /** 关闭自实现资源管理器窗口：同时清掉 store 里的目录，避免被同步逻辑又拉回来。 */
  const closeFiles = useCallback(() => {
    closeFileManager()
    setWins((ws) => ws.filter((w) => w.key !== FILES_KEY))
  }, [closeFileManager])

  const minimizeWin = useCallback((key: string) => {
    setWins((ws) => ws.map((w) => (w.key === key ? { ...w, minimized: true } : w)))
  }, [])

  const toggleMax = useCallback((key: string) => {
    setWins((ws) => ws.map((w) => (w.key === key ? { ...w, maximized: !w.maximized, z: (zRef.current += 1) } : w)))
  }, [])

  /** 任务栏按钮：已聚焦则最小化，否则还原并置顶。 */
  const taskClick = useCallback(
    (key: string) => {
      const top = wins
        .filter((w) => !w.minimized)
        .reduce<WinState | null>((acc, w) => (acc === null || w.z > acc.z ? w : acc), null)
      if (top?.key === key) minimizeWin(key)
      else focusWin(key)
    },
    [wins, minimizeWin, focusWin]
  )

  const renameManage = useCallback(
    (key: string, versionId: string) => {
      setWins((ws) =>
        ws.map((w) =>
          w.key === key
            ? { ...w, managingId: versionId, title: t('shell.win10.instanceManage', { id: versionId }) }
            : w
        )
      )
    },
    [t]
  )

  /* ---------------- 拖动 ---------------- */

  const beginDrag = (e: ReactPointerEvent<HTMLDivElement>, w: WinState): void => {
    if (w.maximized) return
    if ((e.target as HTMLElement).closest('button')) return
    dragRef.current = { key: w.key, dx: e.clientX - w.x, dy: e.clientY - w.y, nativeId: w.native?.id }
    // 立刻同步告诉主进程「开始拖了」：React 的 setState 是异步的，等 hidden 生效再
    // 让主进程停下来，中间这段空窗期里已经在飞的 place() 仍会 SetWindowPos。
    if (w.native) void window.api.desktop.drag(w.native.id, true)
    setDragKey(w.key)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const moveDrag = (e: ReactPointerEvent<HTMLDivElement>, w: WinState): void => {
    const drag = dragRef.current
    if (!drag || drag.key !== w.key) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    const x = Math.min(Math.max(0, e.clientX - drag.dx), Math.max(0, vw - w.w))
    // 整个窗口都留在任务栏之上，避免被任务栏遮住底部
    const y = Math.min(Math.max(0, e.clientY - drag.dy), Math.max(0, vh - TASKBAR_H - w.h))
    setWins((ws) => ws.map((it) => (it.key === w.key ? { ...it, x, y } : it)))
  }

  const endDrag = (): void => {
    const nativeId = dragRef.current?.nativeId
    dragRef.current = null
    // 先解除「拖动中」，松手后 NativeView 的 sync(true) 才允许真正下发一次摆放。
    if (nativeId) void window.api.desktop.drag(nativeId, false)
    setDragKey(null)
  }

  const topKey = wins
    .filter((w) => !w.minimized)
    .reduce<WinState | null>((acc, w) => (acc === null || w.z > acc.z ? w : acc), null)?.key

  /**
   * 外部窗口的矩形是否要留洞。
   * 不留洞的三种情况：最小化、开始菜单打开、被启动器自己的窗口（层级更高且相交）盖住
   * ——此时宿主窗口恢复整块，外部窗口被压在下面，启动器界面完整可见。
   */
  const nativeHoleHidden = (w: WinState): boolean => {
    if (!w.native) return false
    if (w.minimized || startOpen) return true
    return wins.some(
      (o) =>
        !o.native &&
        !o.minimized &&
        o.z > w.z &&
        !(o.x + o.w <= w.x || w.x + w.w <= o.x || o.y + o.h <= w.y || w.y + w.h <= o.y)
    )
  }

  return (
    <div className="win10-desktop">
      {/* 壁纸 */}
      <div className="win10-wallpaper" aria-hidden />
      <img src={logo} alt="" className="win10-wallmark" draggable={false} aria-hidden />

      {/* 桌面空白处：取消选中 + 收起开始菜单 */}
      <div
        className="absolute inset-0"
        onMouseDown={() => {
          setSelected(null)
          setStartOpen(false)
        }}
      />

      {/* 桌面图标：双击打开 */}
      <div className="win10-icons">
        {nav.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`win10-icon${selected === item.id ? ' is-selected' : ''}`}
            aria-label={t(`nav.${item.id}`)}
            onMouseDown={(e) => {
              e.stopPropagation()
              setSelected(item.id)
            }}
            onDoubleClick={() => openPage(item.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') openPage(item.id)
            }}
            title={t('shell.win10.openOnDoubleClick', { name: t(`nav.${item.id}`) })}
          >
            <span className="win10-icon-tile">
              <Icon name={item.icon} size={24} />
            </span>
            <span className="win10-icon-label">{t(`nav.${item.id}`)}</span>
          </button>
        ))}

        {/* 文件资源管理器：不属于侧栏页面，只作为桌面快捷方式存在。
            双击用启动器自实现的资源管理器打开；未设置游戏目录时 store 会回退到
            常用位置的第一项，保证这个入口永远打得开。 */}
        <button
          type="button"
          className={`win10-icon${selected === FILES_KEY ? ' is-selected' : ''}`}
          aria-label={t('shell.win10.fileExplorer')}
          onMouseDown={(e) => {
            e.stopPropagation()
            setSelected(FILES_KEY)
          }}
          onDoubleClick={() => openFileManager(activeGameDir(settings))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') openFileManager(activeGameDir(settings))
          }}
          title={t('shell.win10.openOnDoubleClick', { name: t('shell.win10.fileExplorer') })}
        >
          <span className="win10-icon-tile">
            <Icon name="folder" size={24} />
          </span>
          <span className="win10-icon-label">{t('shell.win10.fileExplorer')}</span>
        </button>
      </div>

      {/* 窗口 */}
      {wins.map((w) => (
        <section
          key={w.key}
          className={`win10-window${w.native ? ' is-native' : ''}`}
          style={{
            left: w.maximized ? 0 : w.x,
            top: w.maximized ? 0 : w.y,
            width: w.maximized ? '100%' : w.w,
            height: w.maximized ? `calc(100% - ${TASKBAR_H}px)` : w.h,
            zIndex: w.z,
            display: w.minimized ? 'none' : 'flex'
          }}
          onMouseDown={() => focusWin(w.key)}
        >
          {/* MC 用它自己系统标题栏：桌面这里不画「桌面模式标题栏」，整块都让给它 */}
          {!w.native && (
            <div
              className="win10-titlebar is-draggable"
              onPointerDown={(e) => beginDrag(e, w)}
              onPointerMove={(e) => moveDrag(e, w)}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onDoubleClick={() => toggleMax(w.key)}
            >
              <span style={{ color: 'var(--fill-primary)', display: 'inline-flex' }}>
                <Icon name={w.icon} size={15} />
              </span>
              <span className="win10-title">{w.title}</span>
              <div className="win10-controls">
                <button
                  className="win10-ctl"
                  title={t('titlebar.minimize')}
                  aria-label={t('titlebar.minimize')}
                  onClick={() => minimizeWin(w.key)}
                >
                  <Glyph d="M2 8h12" />
                </button>
                <button
                  className="win10-ctl"
                  title={w.maximized ? t('titlebar.restore') : t('titlebar.maximize')}
                  aria-label={w.maximized ? t('titlebar.restore') : t('titlebar.maximize')}
                  onClick={() => toggleMax(w.key)}
                >
                  {w.maximized ? (
                    <Glyph d="M4 6h6v6H4zM6 4h6v6" size={13} />
                  ) : (
                    <Glyph d="M3.5 3.5h9v9h-9z" size={13} />
                  )}
                </button>
                <button
                  className="win10-ctl is-close"
                  title={t('titlebar.close')}
                  aria-label={t('titlebar.close')}
                  onClick={() => (w.key === FILES_KEY ? closeFiles() : closeWin(w.key))}
                >
                  <Glyph d="M4 4l8 8M12 4l-8 8" size={13} />
                </button>
              </div>
            </div>
          )}

          <div
            className="win10-body"
            style={w.native ? { position: 'relative', padding: 0 } : w.filePath ? { padding: 0, overflow: 'hidden' } : undefined}
          >
            {w.native ? (
              // 外部窗口被摆在这块矩形的屏幕位置上，宿主窗口在此挖洞透出，
              // 所以这里只留占位；被自己的窗口盖住或菜单打开时收起空洞。
              <NativeView
                id={w.native.id}
                hidden={nativeHoleHidden(w) || dragKey === w.key}
                raise={topKey === w.key}
                onGone={refreshNative}
              />
            ) : w.filePath ? (
              // 自实现资源管理器：key 用当前目录，换目录时整块重挂载，内部状态干净
              <FileManager key={w.filePath} initialPath={w.filePath} editOnDoubleClick />
            ) : w.managingId ? (
              <InstanceManagePage
                versionId={w.managingId}
                onBack={() => closeWin(w.key)}
                onRename={(id) => renameManage(w.key, id)}
              />
            ) : (
              renderPage(w.page, openManage, null)
            )}
          </div>
        </section>
      ))}

      {/* 开始菜单 */}
      {startOpen && (
        <div className="win10-startmenu" role="menu">
          <div className="flex items-center gap-2.5 px-1.5 pt-0.5 pb-3">
            <Avatar
              name={selectedAccount?.name}
              uuid={selectedAccount?.id}
              skinUrl={selectedAccount?.skinUrl}
              authType={selectedAccount?.authType}
              yggdrasilServer={selectedAccount?.yggdrasilServer}
              offline={selectedAccount?.offline}
              size={34}
            />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold leading-tight">
                {selectedAccount?.name ?? t('sidebar.notLoggedIn')}
              </div>
              <div className="caption">
                {settings.mode === 'local'
                  ? t('sidebar.localMode')
                  : settings.mode === 'minimal'
                    ? t('sidebar.minimalMode')
                    : t('shell.win10.modeNormal')}
              </div>
            </div>
          </div>
          {nav.map((item) => (
            <button
              key={item.id}
              type="button"
              className="win10-startitem"
              role="menuitem"
              onClick={() => openPage(item.id)}
            >
              <span style={{ color: 'var(--fill-primary)', display: 'inline-flex' }}>
                <Icon name={item.icon} size={18} />
              </span>
              <span className="text-[13px] font-medium">{t(`nav.${item.id}`)}</span>
            </button>
          ))}
          <div style={{ height: 1, background: 'var(--divider)', margin: '10px 0' }} />
          <button
            type="button"
            className="win10-startitem"
            role="menuitem"
            onClick={() => void window.api.window.close()}
          >
            <span style={{ color: 'var(--fill-danger)', display: 'inline-flex' }}>
              <Icon name="xmark" size={18} />
            </span>
            <span className="text-[13px] font-medium">{t('shell.win10.exitLauncher')}</span>
          </button>
        </div>
      )}

      {/* 任务栏 */}
      <div className="win10-taskbar">
        <button
          type="button"
          className={`win10-task-btn${startOpen ? ' is-active' : ''}`}
          title={t('shell.win10.start')}
          aria-label={t('shell.win10.start')}
          aria-expanded={startOpen}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setStartOpen((v) => !v)}
        >
          <WinLogo />
        </button>

        {wins.map((w) => (
          <button
            key={w.key}
            type="button"
            className={`win10-task-btn${topKey === w.key ? ' is-active' : ''}`}
            title={w.title}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => taskClick(w.key)}
          >
            <Icon name={w.icon} size={16} />
            <span className="win10-task-label">{w.title}</span>
          </button>
        ))}

        <div className="win10-tray">
          {activeDownloads.length > 0 && (
            <button
              type="button"
              className="win10-task-btn"
              title={t('shell.win10.downloadProgress')}
              aria-label={t('shell.win10.downloadProgress')}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => openPage('downloads')}
            >
              <Icon name="download" size={15} />
              <span className="win10-task-label">{downloadPercent}%</span>
            </button>
          )}
          <div>
            <div>{now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>
            <div className="opacity-80">{now.toLocaleDateString('zh-CN')}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

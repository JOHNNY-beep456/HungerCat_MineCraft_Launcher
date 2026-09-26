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
import { useApp } from '../store'
import { useRuntime } from '../runtime'
import { renderPage } from '../pages/router'
import { InstanceManagePage } from '../pages/InstanceManagePage'
import logo from '../assets/logo.png'

/** 任务栏高度，窗口拖动与最大化都以此留边。 */
const TASKBAR_H = 48

interface WinState {
  /** 同一页面只保留一个窗口，故 key 即页面 id；实例管理窗口用 manage:<实例id>；外部窗口用 native:<hwnd> */
  key: string
  page: PageId
  title: string
  icon: string
  /** 实例管理窗口正在管理的实例 id */
  managingId?: string
  /** 被搬进桌面的外部窗口（MC / 资源管理器） */
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
 * 被摆进桌面的 MC / 资源管理器窗口对应的占位层。
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
      // 拖动时限制下发频率：每帧 SetWindowPos 会拖垮外部窗口（MC 会因此崩溃）
      const now = Date.now()
      if (!force && now - lastAt.current < 50) return
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
      // 收起空洞：宿主窗口恢复整块，外部窗口被压在下面，启动器界面完整可见
      void window.api.desktop.setVisible(id, false)
      return
    }
    sync(true)

    // 位置变化没有可靠的事件源（拖动、最大化、宿主缩放）。
    // 用「变化检测 + 50ms 节流」的轻量轮询兜底：拖动时才能跟手，静止时
    // sync() 会在测完矩形后直接返回，不产生任何 IPC 与 SetWindowPos。
    const timer = setInterval(() => sync(), 40)
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
  const { settings, selectedAccount } = useApp()
  const { downloads } = useRuntime()
  const [wins, setWins] = useState<WinState[]>([])
  const [selected, setSelected] = useState<PageId | null>(null)
  const [startOpen, setStartOpen] = useState(false)
  const [now, setNow] = useState(() => new Date())
  const zRef = useRef(10)
  const dragRef = useRef<{ key: string; dx: number; dy: number } | null>(null)

  // 本地模式隐藏联网相关入口，与侧栏保持一致。
  const nav = useMemo(
    () =>
      settings.mode === 'local'
        ? NAV.filter((n) => n.id !== 'resources' && n.id !== 'downloads' && n.id !== 'about')
        : NAV,
    [settings.mode]
  )

  /* --- 自动全屏：进入即全屏，退出该模式（组件卸载）时还原 --- */
  useEffect(() => {
    void window.api.window.setFullscreen(true)
    return () => {
      void window.api.window.setFullscreen(false)
    }
  }, [])

  /* --- 桌面置顶 + 退出时把外部窗口还给系统 --- */
  useEffect(() => {
    void window.api.window.setAlwaysOnTop(true)
    return () => {
      void window.api.window.setAlwaysOnTop(false)
      // 外部窗口是宿主窗口的子窗口，会随宿主一起销毁：退出前必须还给系统
      void window.api.desktop.releaseAll()
    }
  }, [])

  /* --- 外部窗口：自动捕获 MC 与文件资源管理器 --- */
  const [nativeOk, setNativeOk] = useState(false)
  const [nativeList, setNativeList] = useState<NativeWindowInfo[]>([])
  /** 被用户主动移出桌面的窗口，本次会话不再自动搬回（窗口关掉重开是新的句柄，会重新捕获） */
  const dismissed = useRef<Set<string>>(new Set())

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
    const timer = setInterval(scan, 2500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [nativeOk])

  // 新发现的窗口自动搬进桌面（这就是「自动捕获」），已移出的不再自动搬回
  useEffect(() => {
    if (!nativeOk || nativeList.length === 0) return
    const present = new Set(nativeList.map((n) => n.id))
    for (const id of Array.from(dismissed.current)) {
      if (!present.has(id)) dismissed.current.delete(id)
    }
    setWins((ws) => {
      let next = ws
      for (const n of nativeList) {
        if (dismissed.current.has(n.id)) continue
        const key = `native:${n.id}`
        const exist = next.find((w) => w.key === key)
        if (exist) {
          // 标题会变（例如资源管理器切目录），保持同步
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

  const metaOf = useCallback((page: PageId): { title: string; icon: string } => {
    const item = NAV.find((n) => n.id === page)
    return { title: item?.label ?? page, icon: item?.icon ?? 'cube' }
  }, [])

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
          title: `实例管理 · ${versionId}`,
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
  }, [])

  const closeWin = useCallback((key: string) => {
    setWins((ws) => ws.filter((w) => w.key !== key))
  }, [])

  /**
   * 关闭桌面里的外部窗口 = 还给系统（**不会**关掉玩家的 MC / 资源管理器），
   * 并记住本次会话不再自动搬回。
   */
  const closeNative = useCallback((key: string, id: string) => {
    dismissed.current.add(id)
    void window.api.desktop.release(id)
    setWins((ws) => ws.filter((w) => w.key !== key))
  }, [])

  /** 开始菜单里手动把某个外部窗口搬回桌面（解除「已移出」标记后立即重扫） */
  const captureNative = useCallback(
    (n: NativeWindowInfo) => {
      dismissed.current.delete(n.id)
      setStartOpen(false)
      refreshNative()
    },
    [refreshNative]
  )

  /** 把所有外部窗口一次性还给系统 */
  const releaseAllNative = useCallback((list: NativeWindowInfo[]) => {
    for (const n of list) dismissed.current.add(n.id)
    void window.api.desktop.releaseAll()
    setWins((ws) => ws.filter((w) => !w.native))
    setStartOpen(false)
  }, [])

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

  const renameManage = useCallback((key: string, versionId: string) => {
    setWins((ws) =>
      ws.map((w) => (w.key === key ? { ...w, managingId: versionId, title: `实例管理 · ${versionId}` } : w))
    )
  }, [])

  /* ---------------- 拖动 ---------------- */

  const beginDrag = (e: ReactPointerEvent<HTMLDivElement>, w: WinState): void => {
    if (w.maximized) return
    if ((e.target as HTMLElement).closest('button')) return
    dragRef.current = { key: w.key, dx: e.clientX - w.x, dy: e.clientY - w.y }
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
    dragRef.current = null
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
            aria-label={item.label}
            onMouseDown={(e) => {
              e.stopPropagation()
              setSelected(item.id)
            }}
            onDoubleClick={() => openPage(item.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') openPage(item.id)
            }}
            title={`${item.label}（双击打开）`}
          >
            <span className="win10-icon-tile">
              <Icon name={item.icon} size={24} />
            </span>
            <span className="win10-icon-label">{item.label}</span>
          </button>
        ))}
      </div>

      {/* 窗口 */}
      {wins.map((w) => (
        <section
          key={w.key}
          className="win10-window"
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
              <button className="win10-ctl" title="最小化" aria-label="最小化" onClick={() => minimizeWin(w.key)}>
                <Glyph d="M2 8h12" />
              </button>
              <button
                className="win10-ctl"
                title={w.maximized ? '还原' : '最大化'}
                aria-label={w.maximized ? '还原' : '最大化'}
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
                title={w.native ? '从桌面移出（不关闭该窗口）' : '关闭'}
                aria-label={w.native ? '从桌面移出（不关闭该窗口）' : '关闭'}
                onClick={() => (w.native ? closeNative(w.key, w.native.id) : closeWin(w.key))}
              >
                <Glyph d="M4 4l8 8M12 4l-8 8" size={13} />
              </button>
            </div>
          </div>

          <div className="win10-body" style={w.native ? { position: 'relative', padding: 0 } : undefined}>
            {w.native ? (
              // 外部窗口被摆在这块矩形的屏幕位置上，宿主窗口在此挖洞透出，
              // 所以这里只留占位；被自己的窗口盖住或菜单打开时收起空洞。
              <NativeView
                id={w.native.id}
                hidden={nativeHoleHidden(w)}
                raise={topKey === w.key}
                onGone={refreshNative}
              />
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
              size={34}
            />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold leading-tight">
                {selectedAccount?.name ?? '未登录'}
              </div>
              <div className="caption">
                {settings.mode === 'local' ? '本地模式' : settings.mode === 'minimal' ? '极简模式' : '普通模式'}
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
              <span className="text-[13px] font-medium">{item.label}</span>
            </button>
          ))}
          {nativeOk && nativeList.length > 0 && (
            <>
              <div style={{ height: 1, background: 'var(--divider)', margin: '10px 0' }} />
              <div className="caption" style={{ padding: '0 10px 4px' }}>
                自动捕获的外部窗口（点一下搬进桌面）
              </div>
              {nativeList.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  className="win10-startitem"
                  role="menuitem"
                  onClick={() => captureNative(n)}
                  style={{ opacity: dismissed.current.has(n.id) ? 0.55 : 1 }}
                >
                  <span style={{ color: 'var(--fill-primary)', display: 'inline-flex' }}>
                    <Icon name={n.kind === 'minecraft' ? 'play' : 'folder'} size={18} />
                  </span>
                  <span
                    className="text-[13px] font-medium"
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {n.title}
                  </span>
                </button>
              ))}
              <button
                type="button"
                className="win10-startitem"
                role="menuitem"
                onClick={() => releaseAllNative(nativeList)}
              >
                <span style={{ color: 'var(--text-secondary)', display: 'inline-flex' }}>
                  <Icon name="chevronLeft" size={18} />
                </span>
                <span className="text-[13px] font-medium">全部还给系统</span>
              </button>
            </>
          )}
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
            <span className="text-[13px] font-medium">退出启动器</span>
          </button>
        </div>
      )}

      {/* 任务栏 */}
      <div className="win10-taskbar">
        <button
          type="button"
          className={`win10-task-btn${startOpen ? ' is-active' : ''}`}
          title="开始"
          aria-label="开始"
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
              title="下载进度"
              aria-label="下载进度"
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

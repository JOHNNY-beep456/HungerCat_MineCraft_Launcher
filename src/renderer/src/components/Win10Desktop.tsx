// ---------------------------------------------------------------------------
// 实验性功能 2：Win10 桌面。
//
// 开启后窗口自动全屏，启动器各功能以「桌面图标」呈现（双击打开），打开的页面
// 落在可拖动的窗口里，底部是任务栏（开始菜单 / 已开窗口 / 时钟）。窗口内部渲染的
// 仍是启动器原有页面，配色由 [data-skin='win10'] 的扁平令牌接管。
//
// 桌面里只有启动器自己的窗口：不再捕获 / 搬动任何外部窗口（MC 由启动参数强制全屏，
// 就是一个普通的独立全屏窗口），因此不涉及任何 Win32 窗口句柄操作。
//
// 与「仿 Mac 玻璃」皮肤互斥：设置里两者共用一个 experimental 字段。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
// NAV 用于查图标 / 标题元数据（不受可见性影响）；visibleNav 用于实际渲染哪些入口。
import { NAV, visibleNav, type PageId } from './Sidebar'
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
  /** 同一页面只保留一个窗口，故 key 即页面 id；实例管理窗口用 manage:<实例id> */
  key: string
  page: PageId
  title: string
  icon: string
  /** 实例管理窗口正在管理的实例 id */
  managingId?: string
  /** 自实现资源管理器窗口当前显示的目录 */
  filePath?: string
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
  const dragRef = useRef<{ key: string; dx: number; dy: number } | null>(null)

  // 导航项与侧栏共用同一份过滤规则（本地模式隐藏联网入口；联机实验性默认隐藏）。
  const nav = useMemo(() => visibleNav(settings), [settings])

  /* --- 强置顶外壳：进入即全屏 + 最高层级置顶 + 从系统任务栏隐藏，
         让 Windows 的任务栏与开始菜单都盖不进来；退出该模式（组件卸载）时还原， */
  useEffect(() => {
    void window.api.window.setDesktopMode(true)
    return () => {
      void window.api.window.setDesktopMode(false)
    }
  }, [])

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

          <div
            className="win10-body"
            style={w.filePath ? { padding: 0, overflow: 'hidden' } : undefined}
          >
            {w.filePath ? (
              // 自实现资源管理器：key 用当前目录，换目录时整块重挂载，内部状态干净
              <FileManager key={w.filePath} initialPath={w.filePath} editOnDoubleClick />
            ) : w.managingId ? (
              <InstanceManagePage
                versionId={w.managingId}
                onBack={() => closeWin(w.key)}
                onRename={(id) => renameManage(w.key, id)}
              />
            ) : (
              renderPage(w.page, openManage, null, undefined, settings.enableMultiplayer)
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

// ---------------------------------------------------------------------------
// 启动器自实现的资源管理器。
//
// 用途：替代「打开系统资源管理器」。过去 Win10 桌面模式会把 explorer.exe 的窗口
// 搬进启动器桌面，那类窗口的标题栏画在客户区，搬动 / 遮蔽后必须抖动尺寸才能恢复
// 渲染表面，是移动窗口崩溃的主要来源之一。现在改成在启动器自己的窗口里列出目录。
//
// 能力：浏览 / 进目录 / 打开文件 / 在系统资源管理器中定位，以及右键菜单里的
// 重命名、修改文件、删除、新建文件。破坏性操作一律先弹确认框。
// ---------------------------------------------------------------------------

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { FileEntry, FilePlace } from '@shared/types'
import { Button, Icon, Spinner } from './ui'
import { useApp } from '../store'

/** 拆出路径分隔符（Windows 用 \，其它平台用 /）。 */
function separatorOf(p: string): string {
  return p.includes('\\') ? '\\' : '/'
}

/** 把绝对路径拆成「面包屑」（每级的名称 + 该级的绝对路径）。 */
function crumbsOf(p: string): Array<{ label: string; path: string }> {
  const sep = separatorOf(p)
  const parts = p.split(/[\\/]+/).filter(Boolean)
  const out: Array<{ label: string; path: string }> = []
  let acc = ''
  parts.forEach((part, i) => {
    if (i === 0) {
      // 首级是盘符（C:）或根目录（/）
      acc = /^[a-zA-Z]:$/.test(part) ? part + sep : sep === '/' ? `/${part}` : part
    } else {
      acc = acc.endsWith(sep) ? acc + part : acc + sep + part
    }
    out.push({ label: part, path: acc })
  })
  return out
}

/** 上一级目录；已在根目录时返回空串。 */
function parentOf(p: string): string {
  const crumbs = crumbsOf(p)
  return crumbs.length > 1 ? crumbs[crumbs.length - 2].path : ''
}

function formatBytes(n: number): string {
  if (n <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`
}

function formatTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 右键菜单的位置（相对组件根）与目标项；entry 为 null 表示点在了空白处。 */
type MenuState = { x: number; y: number; entry: FileEntry | null }

/** 弹窗：改名 / 新建文件 / 删除确认 / 编辑文本。 */
type DialogState =
  | { kind: 'rename'; entry: FileEntry }
  | { kind: 'create' }
  | { kind: 'delete'; entry: FileEntry }
  | { kind: 'edit'; entry: FileEntry }

/** 右键菜单的估算尺寸：用于把菜单夹取在组件内，避免贴边被切掉 */
const MENU_W = 184
const MENU_H = 4 * 34 + 14

/** 右键菜单的一项（观感对齐 Select 的下拉项） */
function MenuItem({
  label,
  onClick,
  disabled = false,
  danger = false,
  title
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  title?: string
}): JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className="flex w-full items-center rounded-xl px-3 py-2 text-left text-[13px] font-medium no-drag transition-colors disabled:opacity-40"
      style={{ color: danger ? 'var(--fill-danger)' : undefined }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = 'var(--fill-secondary)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
      }}
    >
      <span className="truncate">{label}</span>
    </button>
  )
}

export function FileManager({
  initialPath,
  onClose,
  className = '',
  editOnDoubleClick = false
}: {
  initialPath: string
  /** 有关闭按钮时传（普通模式下是覆盖层；桌面模式里由窗口标题栏负责关闭） */
  onClose?: () => void
  className?: string
  /** 双击文件的行为：true=打开内置「修改文件」编辑器（桌面模式）；false=用系统默认程序打开 */
  editOnDoubleClick?: boolean
}): JSX.Element {
  const { t } = useApp()
  const [places, setPlaces] = useState<FilePlace[]>([])
  const [path, setPath] = useState(initialPath)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [address, setAddress] = useState(initialPath)
  /** 已访问过的目录（后退用的历史栈，不含当前） */
  const history = useRef<string[]>([])
  /** 组件根：右键菜单与弹窗都以它为定位 / 覆盖基准 */
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  /** 改名 / 新建时的名字输入 */
  const [nameInput, setNameInput] = useState('')
  /** 内置编辑器的文本 */
  const [editText, setEditText] = useState('')
  const [editLoading, setEditLoading] = useState(false)
  /** 编辑器读取失败：此时禁止保存，否则会把文件写坏 */
  const [editFailed, setEditFailed] = useState(false)
  /** 有写操作在执行：禁用弹窗按钮，避免重复提交 */
  const [busy, setBusy] = useState(false)
  /** 弹窗内的错误提示（放在弹窗里，免得被弹窗盖住状态栏） */
  const [dialogError, setDialogError] = useState<string | null>(null)

  const crumbs = useMemo(() => crumbsOf(path), [path])

  const load = useCallback(async (dir: string) => {
    setLoading(true)
    setError(null)
    try {
      const list = await window.api.files.list(dir)
      setPath(dir)
      setAddress(dir)
      setEntries(list)
      setSelected(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  /** 前进到某个目录（记录历史） */
  const go = useCallback(
    (dir: string) => {
      history.current.push(path)
      void load(dir)
    },
    [load, path]
  )

  useEffect(() => {
    void window.api.files.places().then(setPlaces).catch(() => setPlaces([]))
  }, [])

  // initialPath 变化（桌面模式下同一个窗口换了目录）时重新加载
  useEffect(() => {
    history.current = []
    void load(initialPath)
  }, [initialPath, load])

  const back = (): void => {
    const prev = history.current.pop()
    if (prev) void load(prev)
  }

  const up = (): void => {
    const parent = parentOf(path)
    if (parent) go(parent)
  }

  const refresh = (): void => {
    void load(path)
  }

  const activate = (entry: FileEntry): void => {
    if (entry.isDir) {
      go(entry.path)
      return
    }
    // 桌面模式：双击文件直接进入内置「修改文件」（文本编辑器），与右键菜单一致。
    // 普通模式：沿用系统默认程序打开（保持原有行为）。
    if (editOnDoubleClick) {
      openEdit(entry)
      return
    }
    void window.api.files.open(entry.path).then((msg) => {
      if (msg) setError(msg)
    })
  }

  /* --- 右键菜单 --- */

  /** 打开右键菜单：视口坐标换算成组件内坐标，并夹取到组件范围内 */
  const openMenu = (ev: ReactMouseEvent, entry: FileEntry | null): void => {
    ev.preventDefault()
    // 挡住冒泡：否则空白处的处理会紧接着把菜单换成「无目标项」
    ev.stopPropagation()
    setSelected(entry ? entry.path : null)
    const r = rootRef.current?.getBoundingClientRect()
    const maxX = Math.max(8, (r?.width ?? 0) - MENU_W - 8)
    const maxY = Math.max(8, (r?.height ?? 0) - MENU_H - 8)
    setMenu({
      x: Math.min(Math.max(8, ev.clientX - (r?.left ?? 0)), maxX),
      y: Math.min(Math.max(8, ev.clientY - (r?.top ?? 0)), maxY),
      entry
    })
  }

  // 点菜单外面 / 按 Esc 关掉菜单（菜单挂在组件根上，不是列表的子节点，得单独判断）
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

  // Esc 关闭弹窗
  useEffect(() => {
    if (!dialog) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDialog(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [dialog])

  /* --- 右键菜单的四个动作 --- */

  const openRename = (entry: FileEntry): void => {
    setMenu(null)
    setNameInput(entry.name)
    setDialogError(null)
    setDialog({ kind: 'rename', entry })
  }

  const openCreate = (): void => {
    setMenu(null)
    setNameInput(t('cmp.fm.newFileNameDefault'))
    setDialogError(null)
    setDialog({ kind: 'create' })
  }

  const openDelete = (entry: FileEntry): void => {
    setMenu(null)
    setDialogError(null)
    setDialog({ kind: 'delete', entry })
  }

  /** 打开内置编辑器：先读文本；二进制 / 过大文件会被主进程拒绝，此时不允许保存 */
  const openEdit = (entry: FileEntry): void => {
    setMenu(null)
    setEditText('')
    setDialogError(null)
    setEditFailed(false)
    setEditLoading(true)
    setDialog({ kind: 'edit', entry })
    void window.api.files
      .readText(entry.path)
      .then((r) => setEditText(r.content))
      .catch((err: unknown) => {
        setEditFailed(true)
        setDialogError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setEditLoading(false))
  }

  /** 执行写操作：成功后关弹窗并重新列目录；失败把中文原因留在弹窗里 */
  const apply = (op: () => Promise<unknown>): void => {
    setBusy(true)
    setDialogError(null)
    void op()
      .then(() => {
        setDialog(null)
        return load(path)
      })
      .catch((err: unknown) => setDialogError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  const applyRename = (): void => {
    if (dialog?.kind !== 'rename') return
    const name = nameInput.trim()
    if (!name) return
    if (name === dialog.entry.name) {
      setDialog(null)
      return
    }
    apply(() => window.api.files.rename(dialog.entry.path, name))
  }

  const applyCreate = (): void => {
    const name = nameInput.trim()
    if (!name) return
    apply(() => window.api.files.createFile(path, name))
  }

  const applyDelete = (): void => {
    if (dialog?.kind !== 'delete') return
    apply(() => window.api.files.remove(dialog.entry.path))
  }

  const applySave = (): void => {
    if (dialog?.kind !== 'edit') return
    apply(() => window.api.files.writeText(dialog.entry.path, editText))
  }

  const selectedEntry = entries.find((e) => e.path === selected) ?? null

  return (
    <div ref={rootRef} className={`relative flex h-full min-h-0 flex-col ${className}`}>
      {/* 工具栏：后退 / 上级 / 刷新 + 地址栏 */}
      <div className="flex shrink-0 items-center gap-2 px-3 pt-3">
        <Button size="sm" icon="chevronLeft" onClick={back} disabled={history.current.length === 0} title={t('cmp.fm.back')}>
          {t('cmp.fm.back')}
        </Button>
        <Button size="sm" icon="chevronRight" onClick={up} disabled={!parentOf(path)} title={t('cmp.fm.up')} />
        <Button size="sm" icon="refresh" onClick={refresh} title={t('cmp.fm.refresh')} />
        <input
          className="input min-w-0 flex-1 no-drag"
          value={address}
          spellCheck={false}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && address.trim()) go(address.trim())
            if (e.key === 'Escape') setAddress(path)
          }}
          title={t('cmp.fm.addressTitle')}
        />
        {onClose && <Button size="sm" icon="xmark" onClick={onClose} title={t('cmp.fm.close')} />}
      </div>

      {/* 面包屑 */}
      {crumbs.length > 0 && (
        <div className="no-scrollbar flex shrink-0 items-center gap-1 overflow-x-auto px-4 pt-2 pb-1 text-[12px]">
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex shrink-0 items-center gap-1">
              {i > 0 && <Icon name="chevronRight" size={11} className="opacity-40" />}
              <button
                type="button"
                className="rounded-md px-1.5 py-0.5 no-drag transition-colors hover:opacity-100"
                style={{ opacity: i === crumbs.length - 1 ? 1 : 0.65 }}
                onClick={() => !(i === crumbs.length - 1) && go(c.path)}
              >
                {c.label}
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* 左栏：快捷入口 */}
        <div className="no-scrollbar w-[176px] shrink-0 overflow-y-auto px-2 py-2">
          {places.map((p) => (
            <button
              key={p.path}
              type="button"
              className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left no-drag transition-colors"
              style={{ background: p.path === path ? 'var(--fill-secondary)' : 'transparent' }}
              title={p.path}
              onClick={() => go(p.path)}
            >
              <Icon name={p.kind === 'drive' ? 'box' : 'folder'} size={15} className="shrink-0 opacity-70" />
              <span className="truncate text-[13px]">{p.name}</span>
            </button>
          ))}
        </div>

        {/* 右栏：列表 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" onContextMenu={(ev) => openMenu(ev, null)}>
            {loading ? (
              <div className="flex h-full items-center justify-center gap-2">
                <Spinner size={20} />
                <span className="caption">{t('cmp.fm.reading')}</span>
              </div>
            ) : entries.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <span className="caption">{t('cmp.fm.empty')}</span>
              </div>
            ) : (
              <div className="selectable">
                {entries.map((e) => (
                  <div
                    key={e.path}
                    className="group flex cursor-default items-center gap-2 rounded-xl px-2.5 py-1.5"
                    style={{ background: selected === e.path ? 'var(--fill-secondary)' : 'transparent' }}
                    onClick={() => setSelected(e.path)}
                    onDoubleClick={() => activate(e)}
                    onContextMenu={(ev) => openMenu(ev, e)}
                    title={e.path}
                  >
                    <Icon
                      name={e.isDir ? 'folder' : 'box'}
                      size={16}
                      className="shrink-0"
                      style={{ color: e.isDir ? 'var(--fill-primary)' : 'var(--text-tertiary)' }}
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{e.name}</span>
                    <span className="shrink-0 text-[12px] opacity-45">{formatBytes(e.size)}</span>
                    <span className="hidden shrink-0 text-[12px] opacity-45 sm:inline">{formatTime(e.mtime)}</span>
                    <button
                      type="button"
                      className="shrink-0 rounded-md p-1 no-drag opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100"
                      title={t('cmp.fm.reveal')}
                      onClick={(ev) => {
                        ev.stopPropagation()
                        void window.api.files.reveal(e.path)
                      }}
                    >
                      <Icon name="link" size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 状态栏 */}
          <div className="flex shrink-0 items-center gap-3 px-3 py-2 text-[12px]">
            {error ? (
              <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--fill-danger)' }} title={error}>
                {error}
              </span>
            ) : (
              <span className="min-w-0 flex-1 truncate opacity-60">
                {selectedEntry
                  ? `${selectedEntry.name}　${formatBytes(selectedEntry.size)}　${formatTime(selectedEntry.mtime)}`
                  : t('cmp.fm.itemCount', { n: entries.length })}
              </span>
            )}
            <button
              type="button"
              className="shrink-0 no-drag opacity-60 hover:opacity-100"
              title={t('cmp.fm.openCurrentTitle')}
              onClick={() => void window.api.files.reveal(path)}
            >
              {t('cmp.fm.openCurrent')}
            </button>
          </div>
        </div>
      </div>

      {/* 右键菜单：重命名 / 修改文件 / 删除 / 新建文件 */}
      <AnimatePresence>
        {menu && (
          <motion.div
            ref={menuRef}
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={{ type: 'spring', bounce: 0.15, duration: 0.28 }}
            className="glass-strong absolute z-50 overflow-hidden rounded-2xl p-1.5"
            style={{ left: menu.x, top: menu.y, width: MENU_W }}
            onContextMenu={(ev) => ev.preventDefault()}
          >
            <MenuItem label={t('cmp.fm.newFile')} onClick={openCreate} />
            <MenuItem label={t('cmp.fm.rename')} disabled={!menu.entry} onClick={() => menu.entry && openRename(menu.entry)} />
            <MenuItem
              label={t('cmp.fm.editFile')}
              disabled={!menu.entry || menu.entry.isDir}
              title={menu.entry?.isDir ? t('cmp.fm.dirCannotEdit') : undefined}
              onClick={() => {
                if (menu.entry && !menu.entry.isDir) openEdit(menu.entry)
              }}
            />
            <MenuItem
              label={t('cmp.fm.delete')}
              danger
              disabled={!menu.entry}
              onClick={() => menu.entry && openDelete(menu.entry)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* 弹窗：改名 / 新建文件 / 编辑文本 / 删除确认 */}
      <AnimatePresence>
        {dialog && (
          <motion.div
            className="absolute inset-0 z-50 flex items-center justify-center p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div
              className="absolute inset-0"
              style={{ background: 'var(--scrim)' }}
              onClick={() => {
                if (!busy) setDialog(null)
              }}
            />
            <motion.div
              className="glass-strong relative z-10 w-full max-w-lg rounded-[28px] p-6"
              initial={{ scale: 0.94, opacity: 0, y: 12 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.94, opacity: 0, y: 12 }}
              transition={{ type: 'spring', bounce: 0.18, duration: 0.4 }}
            >
              {dialog.kind === 'rename' && (
                <>
                  <h2 className="title mb-1">{t('cmp.fm.rename')}</h2>
                  <p className="caption mb-4 truncate" title={dialog.entry.path}>
                    {t('cmp.fm.renameTo', { n: dialog.entry.name })}
                  </p>
                  <input
                    autoFocus
                    value={nameInput}
                    spellCheck={false}
                    className="input no-drag mb-5 w-full"
                    onChange={(e) => setNameInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') applyRename()
                    }}
                  />
                  {dialogError && (
                    <p className="mb-4 -mt-3 text-[12px]" style={{ color: 'var(--fill-danger)' }}>
                      {dialogError}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button className="flex-1" disabled={busy} onClick={() => setDialog(null)}>
                      {t('cmp.fm.cancel')}
                    </Button>
                    <Button
                      variant="primary"
                      className="flex-1"
                      disabled={busy || !nameInput.trim()}
                      onClick={applyRename}
                    >
                      {busy ? t('cmp.fm.processing') : t('cmp.fm.confirm')}
                    </Button>
                  </div>
                </>
              )}

              {dialog.kind === 'create' && (
                <>
                  <h2 className="title mb-1">{t('cmp.fm.newFile')}</h2>
                  <p className="caption mb-4 break-all">{t('cmp.fm.createHint', { path })}</p>
                  <input
                    autoFocus
                    value={nameInput}
                    spellCheck={false}
                    placeholder={t('cmp.fm.namePlaceholder')}
                    className="input no-drag mb-5 w-full"
                    onChange={(e) => setNameInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') applyCreate()
                    }}
                  />
                  {dialogError && (
                    <p className="mb-4 -mt-3 text-[12px]" style={{ color: 'var(--fill-danger)' }}>
                      {dialogError}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button className="flex-1" disabled={busy} onClick={() => setDialog(null)}>
                      {t('cmp.fm.cancel')}
                    </Button>
                    <Button
                      variant="primary"
                      className="flex-1"
                      disabled={busy || !nameInput.trim()}
                      onClick={applyCreate}
                    >
                      {busy ? t('cmp.fm.processing') : t('cmp.fm.create')}
                    </Button>
                  </div>
                </>
              )}

              {dialog.kind === 'edit' && (
                <>
                  <h2 className="title mb-1">{t('cmp.fm.editFile')}</h2>
                  <p className="caption mb-3 truncate" title={dialog.entry.path}>
                    {dialog.entry.name}
                  </p>
                  {editLoading ? (
                    <div className="flex items-center justify-center gap-2 py-12">
                      <Spinner size={20} />
                      <span className="caption">{t('cmp.fm.readingFile')}</span>
                    </div>
                  ) : (
                    <textarea
                      autoFocus
                      value={editText}
                      spellCheck={false}
                      className="input no-drag mb-4 min-h-[240px] w-full font-mono text-[13px]"
                      onChange={(e) => setEditText(e.target.value)}
                    />
                  )}
                  {dialogError && (
                    <p className="mb-4 text-[12px]" style={{ color: 'var(--fill-danger)' }}>
                      {dialogError}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button className="flex-1" disabled={busy} onClick={() => setDialog(null)}>
                      {t('cmp.fm.cancel')}
                    </Button>
                    <Button
                      variant="primary"
                      className="flex-1"
                      disabled={busy || editLoading || editFailed}
                      onClick={applySave}
                    >
                      {busy ? t('cmp.fm.saving') : t('cmp.fm.save')}
                    </Button>
                  </div>
                </>
              )}

              {dialog.kind === 'delete' && (
                <>
                  <h2 className="title mb-1">{t('cmp.fm.deleteTitle')}</h2>
                  <p className="caption mb-3">
                    {dialog.entry.isDir
                      ? t('cmp.fm.deleteDirConfirm', { n: dialog.entry.name })
                      : t('cmp.fm.deleteFileConfirm', { n: dialog.entry.name })}
                  </p>
                  <p className="caption mb-5 break-all" style={{ opacity: 0.6 }}>
                    {dialog.entry.path}
                  </p>
                  {dialogError && (
                    <p className="mb-4 text-[12px]" style={{ color: 'var(--fill-danger)' }}>
                      {dialogError}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button className="flex-1" disabled={busy} onClick={() => setDialog(null)}>
                      {t('cmp.fm.cancel')}
                    </Button>
                    <Button variant="danger" className="flex-1" disabled={busy} onClick={applyDelete}>
                      {busy ? t('cmp.fm.deleting') : t('cmp.fm.delete')}
                    </Button>
                  </div>
                </>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

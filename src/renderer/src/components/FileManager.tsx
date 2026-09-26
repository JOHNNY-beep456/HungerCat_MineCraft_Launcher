// ---------------------------------------------------------------------------
// 启动器自实现的资源管理器。
//
// 用途：替代「打开系统资源管理器」。过去 Win10 桌面模式会把 explorer.exe 的窗口
// 搬进启动器桌面，那类窗口的标题栏画在客户区，搬动 / 遮蔽后必须抖动尺寸才能恢复
// 渲染表面，是移动窗口崩溃的主要来源之一。现在改成在启动器自己的窗口里列出目录。
//
// 能力：只读浏览 + 打开（进目录、用系统默认程序打开文件、在系统资源管理器中定位）。
// 不做删除 / 重命名 / 移动，避免误操作。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry, FilePlace } from '@shared/types'
import { Button, Icon, Spinner } from './ui'

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

export function FileManager({
  initialPath,
  onClose,
  className = ''
}: {
  initialPath: string
  /** 有关闭按钮时传（普通模式下是覆盖层；桌面模式里由窗口标题栏负责关闭） */
  onClose?: () => void
  className?: string
}): JSX.Element {
  const [places, setPlaces] = useState<FilePlace[]>([])
  const [path, setPath] = useState(initialPath)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [address, setAddress] = useState(initialPath)
  /** 已访问过的目录（后退用的历史栈，不含当前） */
  const history = useRef<string[]>([])

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
    void window.api.files.open(entry.path).then((msg) => {
      if (msg) setError(msg)
    })
  }

  const selectedEntry = entries.find((e) => e.path === selected) ?? null

  return (
    <div className={`flex h-full min-h-0 flex-col ${className}`}>
      {/* 工具栏：后退 / 上级 / 刷新 + 地址栏 */}
      <div className="flex shrink-0 items-center gap-2 px-3 pt-3">
        <Button size="sm" icon="chevronLeft" onClick={back} disabled={history.current.length === 0} title="后退">
          后退
        </Button>
        <Button size="sm" icon="chevronRight" onClick={up} disabled={!parentOf(path)} title="上一级" />
        <Button size="sm" icon="refresh" onClick={refresh} title="刷新" />
        <input
          className="input min-w-0 flex-1 no-drag"
          value={address}
          spellCheck={false}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && address.trim()) go(address.trim())
            if (e.key === 'Escape') setAddress(path)
          }}
          title="输入路径后回车跳转"
        />
        {onClose && <Button size="sm" icon="xmark" onClick={onClose} title="关闭" />}
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
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {loading ? (
              <div className="flex h-full items-center justify-center gap-2">
                <Spinner size={20} />
                <span className="caption">正在读取…</span>
              </div>
            ) : entries.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <span className="caption">这个文件夹是空的</span>
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
                      title="在系统资源管理器中定位"
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
                  : `${entries.length} 项`}
              </span>
            )}
            <button
              type="button"
              className="shrink-0 no-drag opacity-60 hover:opacity-100"
              title="在系统资源管理器中打开当前目录"
              onClick={() => void window.api.files.reveal(path)}
            >
              在系统资源管理器中打开
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

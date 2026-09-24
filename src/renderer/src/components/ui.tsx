import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import defaultAvatar from '../assets/stevE.jpg'

/* ------------------------------------------------------------------ */
/* Icons (SF-Symbols-style stroke icons)                               */
/* ------------------------------------------------------------------ */

const ICON_PATHS: Record<string, ReactNode> = {
  home: (
    <>
      <path d="M4 11l8-7 8 7" />
      <path d="M6 10v9h12v-9" />
    </>
  ),
  cube: (
    <>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
      <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-3.9 3.6-6 8-6s8 2.1 8 6" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11" />
      <path d="M7 11l5 5 5-5" />
      <path d="M4 19h16" />
    </>
  ),
  settings: (
    <>
      <path d="M4 8h10M18 8h2M4 16h2M10 16h10" />
      <circle cx="16" cy="8" r="2" />
      <circle cx="8" cy="16" r="2" />
    </>
  ),
  play: <path d="M8.5 5.5v13l10-6.5z" fill="currentColor" stroke="none" />,
  plus: <path d="M12 5v14M5 12h14" />,
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2" />
      <path d="M6 7l1 13h10l1-13" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 11-2.34-5.66" />
      <path d="M20 4v5h-5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M16 16l4 4" />
    </>
  ),
  check: <path d="M5 13l4 4L19 7" />,
  xmark: <path d="M6 6l12 12M18 6L6 18" />,
  folder: <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />,
  link: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M18 13v5a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h5" />
    </>
  ),
  chevronRight: <path d="M9 6l6 6-6 6" />,
  chevronLeft: <path d="M15 6l-6 6 6 6" />,
  moon: <path d="M20 14A8 8 0 1110 4a6.5 6.5 0 0010 10z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 012-2h10" />
    </>
  ),
  stop: <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />,
  box: (
    <>
      <path d="M3 7l9-4 9 4v10l-9 4-9-4V7z" />
      <path d="M3 7l9 4 9-4M12 11v10" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3a9 9 0 100 18h1.5a1.5 1.5 0 001.5-1.5 1.5 1.5 0 00-1.5-1.5H12a1.5 1.5 0 010-3 9 9 0 000-12z" />
      <circle cx="7.5" cy="11.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="11" cy="7.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="16" cy="9.5" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </>
  )
}

export function Icon({
  name,
  size = 20,
  className,
  style
}: {
  name: keyof typeof ICON_PATHS | string
  size?: number
  className?: string
  style?: CSSProperties
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden
    >
      {ICON_PATHS[name] ?? null}
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/* Glass card                                                          */
/* ------------------------------------------------------------------ */

export function GlassCard({
  className = '',
  ...props
}: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={`glass rounded-3xl ${className}`} {...props} />
}

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  icon?: string
  size?: 'sm' | 'md' | 'lg'
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', icon, size = 'md', className = '', children, ...props },
  ref
): JSX.Element {
  const v = variant === 'ghost' ? '' : `btn-${variant}`
  const s = size === 'sm' ? 'h-8 px-3 text-[13px]' : size === 'lg' ? 'h-11 px-6 text-[15px]' : ''
  return (
    <button ref={ref} className={`btn ${v} ${s} ${className}`} {...props}>
      {icon ? <Icon name={icon} size={size === 'lg' ? 20 : 17} /> : null}
      {children}
    </button>
  )
})

/* ------------------------------------------------------------------ */
/* Progress bar                                                        */
/* ------------------------------------------------------------------ */

export function ProgressBar({ percent, className = '' }: { percent: number; className?: string }): JSX.Element {
  return (
    <div className={`h-2 w-full rounded-full overflow-hidden ${className}`} style={{ background: 'var(--fill-secondary)' }}>
      <motion.div
        className="h-full rounded-full"
        style={{ background: 'var(--fill-primary)' }}
        animate={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
        transition={{ type: 'spring', bounce: 0, duration: 0.4 }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 下载速度格式化                                                        */
/* ------------------------------------------------------------------ */

/** 把字节/秒速度格式化为人类可读形式（自动选单位，低位数 2 位）。 */
export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '--'
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let i = 0
  let v = bytesPerSecond
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  // B/s 用整数，KB/s 及以上保留 2 位小数。
  return i === 0 ? `${Math.round(v)} ${units[i]}` : `${v.toFixed(2)} ${units[i]}`
}

/* ------------------------------------------------------------------ */
/* Spinner（像素猫吃鱼加载动画）                                         */
/* ------------------------------------------------------------------ */

/** 像素猫（每字符一个像素块，# 填充，. 镂空为眼睛）。 */
const CAT_PIXELS = [
  '#.....#',
  '##...##',
  '#######',
  '#######',
  '#.##.##',
  '#######',
  '.#####.',
  '..###..',
  '..###..'
]

/** 像素鱼（头朝左、尾朝右）。 */
const FISH_PIXELS = [
  '...##..',
  '..####.',
  '######.',
  '..####.',
  '...##..'
]

function pixelBlocks(rows: string[], ox: number, oy: number, s: number): ReactNode {
  const blocks: ReactNode[] = []
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      if (row[c] === '#') {
        blocks.push(<rect key={`${r}-${c}`} x={ox + c * s} y={oy + r * s} width={s} height={s} />)
      }
    }
  })
  return blocks
}

/** 像素描边猫捧着吃鱼，颜色随主题色。 */
export function CatFishLoader({ size = 26, className = '' }: { size?: number; className?: string }): JSX.Element {
  const h = Math.round((size * 36) / 48)
  return (
    <svg
      width={size}
      height={h}
      viewBox="0 0 48 36"
      className={className}
      fill="currentColor"
      shapeRendering="crispEdges"
      style={{ color: 'var(--fill-primary)' }}
      aria-hidden
    >
      <g className="catfish-bob">{pixelBlocks(CAT_PIXELS, 4, 4, 3)}</g>
      <g className="catfish-wag">{pixelBlocks(FISH_PIXELS, 25, 15, 3)}</g>
    </svg>
  )
}

export function Spinner({ size = 20, className = '' }: { size?: number; className?: string }): JSX.Element {
  return (
    <span className={`inline-block align-middle ${className}`} aria-label="加载中" role="status">
      <CatFishLoader size={size} />
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Loading placeholder                                                 */
/* ------------------------------------------------------------------ */

export function LoadingState({ text = '加载中…' }: { text?: string }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-12">
      <Spinner size={26} />
      <span className="caption">{text}</span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Switch                                                              */
/* ------------------------------------------------------------------ */

export function Switch({
  checked,
  onChange,
  disabled
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-[28px] w-[48px] items-center rounded-full transition-colors duration-200 no-drag"
      style={{ background: checked ? 'var(--fill-success)' : 'var(--fill-secondary-hover)', opacity: disabled ? 0.5 : 1 }}
    >
      <motion.span
        className="inline-block h-[24px] w-[24px] rounded-full bg-white shadow"
        animate={{ x: checked ? 21 : 2 }}
        transition={{ type: 'spring', bounce: 0.25, duration: 0.35 }}
      />
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* Checkbox                                                            */
/* ------------------------------------------------------------------ */

export function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  disabled
}: {
  checked: boolean
  indeterminate?: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}): JSX.Element {
  const active = checked || indeterminate
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="no-drag inline-flex shrink-0 items-center justify-center rounded-[6px] transition-colors"
      style={{
        width: 18,
        height: 18,
        background: active ? 'var(--fill-primary)' : 'transparent',
        border: `1.5px solid ${active ? 'var(--fill-primary)' : 'var(--text-tertiary)'}`,
        opacity: disabled ? 0.5 : 1
      }}
    >
      {indeterminate ? (
        <span style={{ width: 8, height: 2, background: '#fff', borderRadius: 1 }} />
      ) : checked ? (
        <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 13l4 4L19 7" />
        </svg>
      ) : null}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* Segmented control                                                   */
/* ------------------------------------------------------------------ */

export function Segmented<T extends string>({
  options,
  value,
  onChange
}: {
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
}): JSX.Element {
  const layoutId = useId()
  return (
    <div className="inline-flex flex-wrap rounded-xl p-1 gap-1" style={{ background: 'var(--fill-secondary)' }}>
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className="relative rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors no-drag whitespace-nowrap"
            style={{ color: active ? 'var(--text-primary)' : 'var(--text-secondary)' }}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-0 rounded-lg"
                style={{ background: 'var(--fill-secondary-hover)' }}
                transition={{ type: 'spring', bounce: 0.2, duration: 0.4 }}
              />
            )}
            <span className="relative z-10">{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Select（玻璃拟态下拉，替代原生 select）                                */
/* ------------------------------------------------------------------ */

/**
 * 与全应用一致的下拉选择器：触发器沿用 .input 观感，浮层用 glass-strong +
 * 与首页版本选择相同的 spring 入场；支持点击外部 / Esc 关闭。
 * 原生 select 无法适配玻璃主题（系统弹层不受样式控制），故统一用它。
 *
 * 浮层经 portal 渲染到 body 并用 fixed 定位：这样既不会被祖先的 overflow
 * 裁剪（可滚动卡片内也能完整显示），也会按视口夹取水平位置——最右侧的下拉
 * 不再超出窗口边缘，下方空间不足时改为向上展开。
 */
export function Select({
  value,
  onChange,
  options,
  disabled,
  placeholder = '请选择',
  className = ''
}: {
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
  disabled?: boolean
  placeholder?: string
  className?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{
    left: number
    width: number
    top?: number
    bottom?: number
    listMax: number
  } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const GAP = 8
  const ROW_H = 36
  const LIST_MAX = 288

  // 打开时按触发器位置计算浮层坐标；滚动 / 窗口缩放时跟随
  useEffect(() => {
    if (!open) return
    const place = (): void => {
      const el = rootRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const width = Math.max(r.width, 176)
      // 水平夹取：避免最右 / 最左的下拉超出视口被裁
      const left = Math.min(Math.max(r.left, GAP), Math.max(GAP, window.innerWidth - width - GAP))
      // 竖向：预估高度，下方不够且上方够则向上展开（用 bottom 锚定，无需知道实际高度）
      const estH = Math.min(options.length * ROW_H, LIST_MAX) + 12
      const spaceBelow = window.innerHeight - r.bottom - GAP
      const up = spaceBelow < estH && r.top - GAP - estH > 0
      const avail = up ? r.top - GAP - GAP : spaceBelow - 12
      setPos({
        left,
        width,
        top: up ? undefined : r.bottom + GAP,
        bottom: up ? window.innerHeight - r.top + GAP : undefined,
        listMax: Math.max(96, Math.min(LIST_MAX, avail))
      })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, options.length])

  // 点击组件外部或按 Esc 关闭浮层（浮层已 portal 到 body，需单独判断）
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (!rootRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const current = options.find((o) => o.value === value)

  return (
    <div ref={rootRef} className={`relative inline-block text-left ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="input flex w-full items-center justify-between gap-2 no-drag"
        style={{ opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer' }}
      >
        <span className="truncate">{current ? current.label : placeholder}</span>
        <Icon
          name="chevronRight"
          size={14}
          className="shrink-0 opacity-50 transition-transform duration-200"
          style={{ transform: open ? 'rotate(-90deg)' : 'rotate(90deg)' }}
        />
      </button>

      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div
              ref={panelRef}
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ type: 'spring', bounce: 0.15, duration: 0.32 }}
              className="glass-strong fixed z-[100] overflow-hidden rounded-2xl p-1.5"
              style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom }}
            >
              <div className="overflow-y-auto" style={{ maxHeight: pos.listMax }} role="listbox">
                {options.length === 0 ? (
                  <div className="px-3 py-3 text-center text-[13px] opacity-60">无可选项</div>
                ) : (
                  options.map((o) => {
                    const active = o.value === value
                    return (
                      <button
                        key={o.value}
                        type="button"
                        role="option"
                        aria-selected={active}
                        onClick={() => {
                          onChange(o.value)
                          setOpen(false)
                        }}
                        className="flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left no-drag transition-colors"
                        style={{ background: active ? 'var(--fill-secondary)' : 'transparent' }}
                        onMouseEnter={(e) => {
                          if (!active) e.currentTarget.style.background = 'var(--fill-secondary)'
                        }}
                        onMouseLeave={(e) => {
                          if (!active) e.currentTarget.style.background = 'transparent'
                        }}
                      >
                        <span className="truncate text-[13px] font-medium">{o.label}</span>
                        {active && <Icon name="check" size={14} style={{ color: 'var(--fill-primary)' }} />}
                      </button>
                    )
                  })
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Avatar (Minecraft head render)                                      */
/* ------------------------------------------------------------------ */

/**
 * 从账号保存的认证基址取站点根：`https://{域名}/api/yggdrasil` → `https://{域名}`。
 * 兼容只填域名的输入（自动补 https://），用于拼接头像接口 `/avatar/player/{name}`。
 */
export function yggdrasilOrigin(server: string): string {
  const s = server.trim().replace(/\/+$/, '')
  if (!s) return ''
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`
  return withScheme.match(/^(https?:\/\/[^/]+)/i)?.[1] ?? ''
}

export function Avatar({
  name,
  uuid,
  skinUrl,
  authType,
  yggdrasilServer,
  size = 44
}: {
  name?: string
  uuid?: string
  /** textures.minecraft.net/texture/<hash> URL, preferred over uuid lookup. */
  skinUrl?: string
  /** 账号认证类型；yggdrasil 账号优先走认证站面像 API。 */
  authType?: 'microsoft' | 'offline' | 'yggdrasil'
  /** Yggdrasil 认证服务器地址（完整认证基址），用于推导第三方头像接口。 */
  yggdrasilServer?: string
  size?: number
}): JSX.Element {
  const [srcIndex, setSrcIndex] = useState(0)
  // skinFailed = 皮肤贴图本身也无法加载时，直接落到内置默认头像，绝不显示问号。
  const [skinFailed, setSkinFailed] = useState(false)
  useEffect(() => {
    setSrcIndex(0)
    setSkinFailed(false)
  }, [uuid, skinUrl, authType, yggdrasilServer])

  // 按优先级收集在线面像候选；每个失败后通过 srcIndex +1 回退到下一候选项。
  const sources: string[] = []
  const hash = skinUrl?.match(/([0-9a-f]{64})/i)?.[1]

  if (authType === 'yggdrasil') {
    // 第三方账号：头像统一走认证站根域的 /avatar/player/{角色名}
    //（official 头像源按 uuid 在很多第三方站会 404，minotar 又只返回 Steve 占位图）。
    const origin = yggdrasilOrigin(yggdrasilServer ?? '')
    if (name && origin) sources.push(`${origin}/avatar/player/${encodeURIComponent(name)}`)
    if (hash) sources.push(`https://mc-heads.net/avatar/${hash}`)
  } else {
    // 正版 / 离线账号：Mojang 官方面像源按 uuid 优先，名字兜底，逐级回退。
    if (uuid) sources.push(`https://mc-heads.net/avatar/${uuid}`)
    if (uuid) sources.push(`https://minotar.net/helm/${uuid}`)
    if (uuid) sources.push(`https://crafatar.com/avatars/${uuid}?overlay`)
    if (hash) sources.push(`https://mc-heads.net/avatar/${hash}`)
    if (name) sources.push(`https://minotar.net/avatar/${encodeURIComponent(name)}`)
  }

  // 在线面像源（失败逐个回退）。
  const faceUrl = sources[srcIndex]
  if (faceUrl) {
    return (
      <img
        src={faceUrl}
        width={size}
        height={size}
        alt={name ?? ''}
        className="rounded-xl"
        draggable={false}
        onError={() => {
          // 本候选源加载失败：记录并回退到下一候选。
          console.warn(`头像源加载失败，回退下一候选：${faceUrl}`)
          setSrcIndex((i) => i + 1)
        }}
        style={{ imageRendering: 'auto', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.1)' }}
      />
    )
  }

  // 兜底一：在线面像源全部失败后，直接裁切皮肤贴图渲染头部（脸 + 帽子层）。
  // 皮肤贴图自身加载失败时也会落到默认头像。
  if (skinUrl && !skinFailed) {
    const scale = size * 8
    const layer = (px: number): CSSProperties => ({
      position: 'absolute',
      inset: 0,
      backgroundImage: `url(${skinUrl})`,
      backgroundSize: `${scale}px ${scale}px`,
      backgroundPosition: `${-px}px ${-size}px`,
      imageRendering: 'pixelated'
    })
    return (
      <>
        {/* 不可见的皮肤探测图：加载失败即回退默认头像 */}
        <img
          src={skinUrl}
          alt=""
          aria-hidden
          className="hidden"
          onError={() => {
            console.warn(`皮肤贴图加载失败，回退默认头像：${skinUrl}`)
            setSkinFailed(true)
          }}
        />
        <div
          style={{
            position: 'relative',
            width: size,
            height: size,
            overflow: 'hidden',
            borderRadius: '0.75rem',
            flexShrink: 0
          }}
        >
          <div style={layer(size)} />
          <div style={layer(size * 5)} />
        </div>
      </>
    )
  }

  // 兜底二：一律落到内置默认头像，绝不显示问号/字母占位。
  return (
    <img
      src={defaultAvatar}
      width={size}
      height={size}
      alt="默认头像"
      className="rounded-xl"
      draggable={false}
      style={{ objectFit: 'cover', flexShrink: 0 }}
    />
  )
}

import {
  forwardRef,
  useEffect,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode
} from 'react'
import { motion } from 'motion/react'
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
/* Avatar (Minecraft head render)                                      */
/* ------------------------------------------------------------------ */

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
  /** 账号认证类型；yggdrasil 账号会绕过官方头像服务，直接用皮肤纹理渲染。 */
  authType?: 'microsoft' | 'offline' | 'yggdrasil'
  /** Yggdrasil 认证服务器地址，用于识别 LittleSkin 等第三方皮肤站的头像接口。 */
  yggdrasilServer?: string
  size?: number
}): JSX.Element {
  const [srcIndex, setSrcIndex] = useState(0)
  useEffect(() => setSrcIndex(0), [uuid, skinUrl, authType, yggdrasilServer])

  const initial = (name ?? '?').charAt(0).toUpperCase()

  // 第三方（Yggdrasil）账号：官方头像服务按 uuid 查不到，minotar 会返回 Steve 占位图
  // 而非 404，导致显示错误头像。LittleSkin 提供官方头像 API，
  // 优先通过角色名直取头像，失败时再裁切皮肤纹理渲染头部（含帽子层），
  // 并以字母占位垫底，皮肤加载失败时也能正常显示。
  if (authType === 'yggdrasil') {
    const isLittleSkin =
      (yggdrasilServer ?? '').includes('littleskin.cn') ||
      (skinUrl ?? '').includes('littleskin.cn')

    if (isLittleSkin && name && srcIndex === 0) {
      const src = `https://littleskin.cn/avatar/player/${encodeURIComponent(name)}`
      return (
        <img
          src={src}
          width={size}
          height={size}
          alt={name}
          className="rounded-xl"
          draggable={false}
          onError={() => setSrcIndex(1)}
          style={{ imageRendering: 'auto', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.1)' }}
        />
      )
    }

    const scale = size * 8
    const layer = (px: number): CSSProperties => ({
      position: 'absolute',
      inset: 0,
      backgroundImage: `url(${skinUrl ?? ''})`,
      backgroundSize: `${scale}px ${scale}px`,
      backgroundPosition: `${-px}px ${-size}px`,
      imageRendering: 'pixelated'
    })
    return (
      <div
        style={{
          position: 'relative',
          width: size,
          height: size,
          borderRadius: '0.75rem',
          overflow: 'hidden',
          flexShrink: 0,
          background: 'var(--fill-primary)'
        }}
      >
        <div
          className="flex h-full w-full items-center justify-center font-bold text-white"
          style={{ fontSize: size * 0.44 }}
        >
          {initial}
        </div>
        {skinUrl && (
          <>
            <div style={layer(size)} />
            <div style={layer(size * 5)} />
          </>
        )}
      </div>
    )
  }

  // 正版 / 离线账号：依次尝试多个头像源（首个失败后自动回退），保证两类账号都能显示头像。
  const sources: string[] = []
  const hash = skinUrl?.match(/([0-9a-f]{64})/i)?.[1]
  if (hash) sources.push(`https://mc-heads.net/avatar/${hash}/${Math.round(size * 2)}`)
  if (uuid) sources.push(`https://crafatar.com/avatars/${uuid}?size=${Math.round(size * 2)}&overlay`)
  if (uuid) sources.push(`https://minotar.net/helm/${uuid}/${Math.round(size * 2)}.png`)
  // 未登录 / 无任何账号信息时，使用本地默认头像（stevE.jpg）
  if (sources.length === 0) {
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
        onError={() => setSrcIndex((i) => i + 1)}
        style={{ imageRendering: 'auto', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.1)' }}
      />
    )
  }

  // 兜底：有皮肤纹理时，裁切皮肤中的头部（脸部 (8,8) + 帽子层 (40,8)）。
  if (skinUrl) {
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
    )
  }

  return (
    <div
      className="flex items-center justify-center rounded-xl font-bold text-white"
      style={{ width: size, height: size, background: 'var(--fill-primary)', fontSize: size * 0.44 }}
    >
      {initial}
    </div>
  )
}

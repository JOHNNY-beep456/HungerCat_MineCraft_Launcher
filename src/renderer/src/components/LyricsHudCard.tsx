import { useEffect, useRef, useState } from 'react'
import type { NeteaseLyricsState } from '@shared/types'

const TEXT = {
  'zh-CN': { loading: '正在获取歌词…', missing: '未找到这首歌的歌词', previous: '‹ 上一句', next: '下一句 ›', previousHint: '歌词偏后？回到上一句（热键 Ctrl+Alt+[）', nextHint: '歌词偏前？跳到下一句（热键 Ctrl+Alt+]）' },
  'zh-TW': { loading: '正在取得歌詞…', missing: '未找到這首歌的歌詞', previous: '‹ 上一句', next: '下一句 ›', previousHint: '歌詞偏後？回到上一句（快速鍵 Ctrl+Alt+[）', nextHint: '歌詞偏前？跳到下一句（快速鍵 Ctrl+Alt+]）' },
  en: { loading: 'Fetching lyrics…', missing: 'No lyrics found for this song', previous: '‹ Previous', next: 'Next ›', previousHint: 'Lyrics ahead? Return to the previous line (Ctrl+Alt+[)', nextHint: 'Lyrics behind? Skip to the next line (Ctrl+Alt+])' }
} as const
export type LyricsLocale = keyof typeof TEXT
export function lyricsLocale(): LyricsLocale {
  if ('__TAURI_INTERNALS__' in window && window.api.platform === 'win32' && new URLSearchParams(window.location.search).get('window') === 'ai-hud') {
    const native = (window as Window & { __HC_AI_HUD_LOCALE__?: unknown }).__HC_AI_HUD_LOCALE__
    if (native === 'zh-CN' || native === 'zh-TW' || native === 'en') return native
  }
  for (const raw of [document.documentElement.lang, ...(navigator.languages ?? []), navigator.language]) {
    if (typeof raw !== 'string') continue
    const value = raw.trim().replace(/_/g, '-').toLowerCase()
    if (/^zh-(tw|hk|mo|hant)(-|$)/.test(value)) return 'zh-TW'
    if (/^zh(-|$)/.test(value)) return 'zh-CN'
    if (/^en(-|$)/.test(value)) return 'en'
  }
  return 'zh-CN'
}

/** 只接收既有歌词 DTO，忽略额外字段，超限 / 不完整快照不进入视图。 */
export function projectLyricsState(value: unknown): NeteaseLyricsState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const state = value as Record<string, unknown>
  if (typeof state.enabled !== 'boolean' || typeof state.status !== 'string' || !['off', 'idle', 'loading', 'sync', 'nolyric', 'error'].includes(state.status)) return null
  for (const key of ['title', 'artist', 'prev', 'current', 'next']) {
    if (typeof state[key] !== 'string' || state[key].length > 8192) return null
  }
  for (const key of ['source', 'message']) {
    if (state[key] !== undefined && (typeof state[key] !== 'string' || state[key].length > 8192)) return null
  }
  return { enabled: state.enabled, status: state.status as NeteaseLyricsState['status'], title: state.title as string, artist: state.artist as string,
    source: state.source as string | undefined, prev: state.prev as string, current: state.current as string, next: state.next as string, message: state.message as string | undefined }
}

/** 先订阅再取快照；新事件优先，卸载后和迟到快照不写视图。 */
export function useLyricsHudState(): NeteaseLyricsState | null {
  const [state, setState] = useState<NeteaseLyricsState | null>(null)
  useEffect(() => {
    let disposed = false, receivedEvent = false
    let off: (() => void) | undefined
    try {
      off = window.api.music.onLyricsState((value) => {
        const next = projectLyricsState(value)
        if (disposed || !next) return
        receivedEvent = true
        setState(next)
      })
    } catch { /* 订阅失败时仍可读取当前快照。 */ }
    void (async () => {
      try {
        const next = projectLyricsState(await window.api.music.lyricsState())
        if (!disposed && !receivedEvent && next) setState(next)
      } catch { /* 读取失败不覆盖实时事件。 */ }
    })()
    return () => { disposed = true; try { off?.() } catch { /* 回调自身已失活。 */ } }
  }, [])
  return state
}

/** 与 Electron HUD 共用同一块三行歌词卡片，不引入主题或账号 provider。 */
export function LyricsHudCard({ state, opacity = 1, language = lyricsLocale() }: { state: NeteaseLyricsState | null; opacity?: number; language?: LyricsLocale }): JSX.Element | null {
  if (!state?.enabled || state.status === 'off' || state.status === 'idle') return null
  const text = TEXT[language]
  return (
    <div className="rounded-2xl p-2.5" style={{ background: 'rgba(18, 18, 24, 0.72)', backdropFilter: 'blur(10px)', border: '1px solid rgba(255,255,255,0.10)', boxShadow: '0 8px 28px rgba(0,0,0,0.35)', opacity }}>
      <div className="mb-1 flex items-baseline gap-1.5">
        <span className="shrink-0 text-[11px] font-semibold" style={{ color: '#ff8fa3', letterSpacing: 0.3 }}>{state.source || 'SMTC'}</span>
        <span className="truncate text-[10px]" style={{ color: 'rgba(255,255,255,0.5)', flex: 1 }}>{[state.title, state.artist].filter(Boolean).join(' · ')}</span>
        {state.status === 'sync' && <LyricsNudgeControls language={language} />}
      </div>
      {state.status === 'sync' ? (
        <div className="space-y-0.5 text-center">
          <div className="truncate text-[11px]" style={{ color: 'rgba(255,255,255,0.42)' }}>{state.prev || '\u00a0'}</div>
          <div className="text-[14px] font-semibold leading-snug" style={{ color: '#ffffff', textShadow: '0 1px 3px rgba(0,0,0,0.55)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{state.current || '…'}</div>
          <div className="truncate text-[11px]" style={{ color: 'rgba(255,255,255,0.55)' }}>{state.next || '\u00a0'}</div>
        </div>
      ) : <div className="text-[11px]" style={{ color: 'rgba(255,255,255,0.6)' }}>{state.status === 'loading' ? text.loading : (state.message ?? text.missing)}</div>}
    </div>
  )
}

/** 局部鼠标命中与固定热键共用后端逐句校准；离开、失焦和卸载均恢复穿透。 */
function LyricsNudgeControls({ language }: { language: LyricsLocale }): JSX.Element {
  const [flash, setFlash] = useState<0 | -1 | 1>(0)
  const hoverRef = useRef(false)
  const text = TEXT[language]
  useEffect(() => {
    if (flash === 0) return
    const timer = setTimeout(() => setFlash(0), 350)
    return () => clearTimeout(timer)
  }, [flash])
  useEffect(() => {
    const setOver = (over: boolean): void => {
      if (over === hoverRef.current) return
      hoverRef.current = over
      window.api.hud.setInteractive(over)
    }
    const onMove = (event: MouseEvent): void => setOver(!!(event.target as HTMLElement | null)?.closest?.('[data-hud-hit]'))
    const onLeave = (): void => setOver(false)
    const onPointer = (event: Event): void => {
      const point: unknown = (event as CustomEvent).detail
      if (!point || typeof point !== 'object') return
      const { x, y } = point as Record<string, unknown>
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return
      setOver(!!document.elementFromPoint(x, y)?.closest('[data-hud-hit]'))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseleave', onLeave)
    window.addEventListener('blur', onLeave)
    window.addEventListener('hc:lyrics-pointer', onPointer)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseleave', onLeave)
      window.removeEventListener('blur', onLeave)
      window.removeEventListener('hc:lyrics-pointer', onPointer)
      if (hoverRef.current) window.api.hud.setInteractive(false)
    }
  }, [])
  const button = (direction: -1 | 1): JSX.Element => (
    <button type="button" data-hud-hit title={direction === -1 ? text.previousHint : text.nextHint}
      onClick={(event) => { event.stopPropagation(); setFlash(direction); window.api.music.lyricsNudge(direction) }}
      style={{ background: flash === direction ? 'rgba(255,143,163,0.35)' : 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 6, color: 'rgba(255,255,255,0.75)', fontSize: 10, lineHeight: 1, padding: '3px 7px', cursor: 'pointer', transition: 'background 0.15s' }}>
      {direction === -1 ? text.previous : text.next}
    </button>
  )
  return <span className="flex shrink-0 items-center gap-1" style={{ opacity: 0.55, pointerEvents: 'auto' }} data-hud-hit>{button(-1)}{button(1)}</span>
}

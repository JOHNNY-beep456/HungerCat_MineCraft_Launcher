import { useEffect, useState } from 'react'
import type { MpHudPlayer, MpHudState } from '@shared/types'
import { nativeInvoke } from '../../../tauri/native-invoke'

type Locale = 'zh-CN' | 'zh-TW' | 'en'
function locale(): Locale {
  const injected = (window as unknown as { __HC_AI_HUD_LOCALE__?: unknown }).__HC_AI_HUD_LOCALE__
  const value = typeof injected === 'string' ? injected : document.documentElement.lang || navigator.language
  return value === 'en' || value?.startsWith('en-') ? 'en' : /^(zh-TW|zh-HK|zh-Hant)/i.test(value || '') ? 'zh-TW' : 'zh-CN'
}

/** 只投影现有显示字段；不把完整大厅、聊天或后端对象交给浮层。 */
export function projectMultiplayerHud(value: unknown): MpHudState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.enabled !== 'boolean' || typeof raw.opacity !== 'number' || !Number.isFinite(raw.opacity)
    || raw.opacity < 0 || raw.opacity > 1 || !Array.isArray(raw.players) || raw.players.length > 129) return null
  const players: MpHudPlayer[] = []
  for (const item of raw.players) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const p = item as Record<string, unknown>
    if (typeof p.id !== 'string' || !p.id || p.id.length > 512 || typeof p.name !== 'string' || !p.name || p.name.length > 128 || typeof p.isSelf !== 'boolean') return null
    const row: MpHudPlayer = { id: p.id, name: p.name, isSelf: p.isSelf }
    if (p.virtualIp !== undefined) {
      if (typeof p.virtualIp !== 'string' || p.virtualIp.length > 64) return null
      row.virtualIp = p.virtualIp
    }
    players.push(row)
  }
  return { enabled: raw.enabled, opacity: raw.opacity, players }
}

export function useMultiplayerHudState(): MpHudState | null {
  const [state, setState] = useState<MpHudState | null>(null)
  useEffect(() => {
    let alive = true, received = false
    let off: (() => void) | undefined
    // 等真实 native listen 注册完成再读取快照，不能把同步 bridge 订阅误当注册回执。
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        if (!alive) return
        const unsubscribe = await listen<{ channel?: string; payload?: unknown }>('launcher:event', ({ payload }) => {
          if (!alive || payload?.channel !== 'mp:hudState') return
          const next = projectMultiplayerHud(payload.payload)
          if (next) { received = true; setState(next) }
        })
        if (!alive) { unsubscribe(); return }
        off = unsubscribe
        // 仅固定无参投影；不增加公开 LauncherApi，也不读取完整大厅状态。
        const value = await nativeInvoke<unknown>('launcher_call', { channel: 'mp:hudState', args: [] })
        const next = projectMultiplayerHud(value)
        if (alive && !received && next) setState(next)
      } catch { /* 失败保持空卡片，不伪造成员或扩大读取权限 */ }
    })()
    return () => { alive = false; try { off?.() } catch { /* 已卸载 */ } }
  }, [])
  return state
}

/** 与 Electron GameHud 共用原有成员卡片的结构、颜色、尺寸和顺序。 */
export function MultiplayerHudCard({ state, opacity }: { state: MpHudState | null; opacity?: number }): JSX.Element | null {
  if (!state?.enabled || !state.players.length) return null
  const lang = locale()
  const text = lang === 'en' ? { title: 'Lobby status', count: 'players', self: ' (me)' }
    : lang === 'zh-TW' ? { title: '大廳狀態', count: '人', self: '（我）' } : { title: '大厅状态', count: '人', self: '（我）' }
  return (
    <div className="rounded-2xl p-2.5" style={{ background: 'rgba(18, 18, 24, 0.72)', backdropFilter: 'blur(10px)', border: '1px solid rgba(255,255,255,0.10)', boxShadow: '0 8px 28px rgba(0,0,0,0.35)', ...(opacity === undefined ? {} : { opacity }) }}>
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-[11px] font-semibold" style={{ color: '#8fd', letterSpacing: 0.3 }}>MCTier · {text.title}</span>
        <span className="text-[10px]" style={{ color: 'rgba(255,255,255,0.45)' }}>{state.players.length} {text.count}</span>
      </div>
      <div className="space-y-1">
        {state.players.map((p) => (
          <div key={p.id} className="flex items-center gap-2">
            <span className="truncate text-[12px]" style={{ color: 'rgba(255,255,255,0.86)', flex: 1 }}>{p.name}{p.isSelf ? text.self : ''}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
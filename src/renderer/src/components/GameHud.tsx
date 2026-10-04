import { useEffect, useState } from 'react'
import type { MpHudState } from '@shared/types'

/**
 * 游戏内 HUD 浮层。
 *
 * 独立窗口，透明 + 置顶 + 鼠标穿透（由主进程设置 `setIgnoreMouseEvents`），
 * 游戏全屏时也能看到当前大厅成员、谁在说话、麦克风状态。
 * 与 MCTier 的 `GameHudOverlay` 对应。
 *
 * 本组件**不使用 useApp()**：浮层窗口不需要主题/文案体系，内联文案最省事，
 * 也避免因缺少 provider 而渲染失败。
 */
export function GameHud(): JSX.Element | null {
  const [state, setState] = useState<MpHudState | null>(null)

  useEffect(() => {
    let alive = true
    const off = window.api.mp.onHudState((s) => {
      if (alive) setState(s)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  if (!state || !state.enabled || state.players.length === 0) return null

  return (
    <div
      className="h-screen w-screen p-2"
      style={{ opacity: state.opacity, pointerEvents: 'none', userSelect: 'none' }}
    >
      <div
        className="rounded-2xl p-2.5"
        style={{
          background: 'rgba(18, 18, 24, 0.72)',
          backdropFilter: 'blur(10px)',
          border: '1px solid rgba(255,255,255,0.10)',
          boxShadow: '0 8px 28px rgba(0,0,0,0.35)'
        }}
      >
        <div className="mb-1.5 flex items-center gap-1.5">
          <span className="text-[11px] font-semibold" style={{ color: '#8fd', letterSpacing: 0.3 }}>
            MCTier · 大厅状态
          </span>
          <span className="text-[10px]" style={{ color: 'rgba(255,255,255,0.45)' }}>
            {state.players.length} 人
          </span>
        </div>
        <div className="space-y-1">
          {state.players.map((p) => (
            <div key={p.id} className="flex items-center gap-2">
              {/* 说话指示：说话时绿点发光并轻微放大 */}
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: p.speaking ? '#5fd39a' : 'rgba(255,255,255,0.22)',
                  boxShadow: p.speaking ? '0 0 8px rgba(95,211,154,0.9)' : 'none',
                  transform: p.speaking ? 'scale(1.25)' : 'scale(1)',
                  transition: 'all 120ms ease-out',
                  flexShrink: 0
                }}
              />
              <span
                className="truncate text-[12px]"
                style={{ color: p.speaking ? '#eafff6' : 'rgba(255,255,255,0.86)', flex: 1 }}
              >
                {p.name}
                {p.isSelf ? '（我）' : ''}
              </span>
              {/* 麦克风 / 静音状态 */}
              <span className="text-[10px]" style={{ color: p.isMuted ? '#ff7b7b' : 'rgba(255,255,255,0.5)' }}>
                {p.isMuted ? '已静音' : p.micEnabled ? '🎙' : '—'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

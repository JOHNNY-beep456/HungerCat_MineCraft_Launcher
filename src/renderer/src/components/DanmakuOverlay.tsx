import { useEffect, useRef, useState } from 'react'
import type { MpDanmaku } from '@shared/types'

/** 屏幕上的一条弹幕（记录轨道与动画时长）。 */
interface FlyingDanmaku extends MpDanmaku {
  track: number
  durationMs: number
  createdAt: number
}

/** 弹幕保留上限：超出即回收最旧的，避免长时间运行后 DOM 累积。 */
const MAX_DANMAKU = 60

/**
 * 消息弹幕浮层。
 *
 * 独立窗口，透明 + 置顶 + 鼠标穿透（主进程设置），聊天消息以横向滚动弹幕呈现，
 * 与 MCTier 的 `DanmakuOverlay` 对应。轨道数 / 字号 / 速度 / 不透明度全部来自
 * 「设置 → 联机 → 消息弹幕」，由主进程随每条弹幕下发，因此改设置即时生效。
 *
 * 不使用 useApp()：弹幕窗口只做展示，内联实现最稳。
 */
export function DanmakuOverlay(): JSX.Element {
  const [items, setItems] = useState<FlyingDanmaku[]>([])
  const [tracks, setTracks] = useState(4)
  const [screenH, setScreenH] = useState(600)
  const trackCursor = useRef(0)

  // 初始配置（轨道数决定容器高度分配）。
  useEffect(() => {
    void window.api.mp
      .danmakuConfig()
      .then((c) => setTracks(Math.max(1, Math.min(8, c.tracks))))
      .catch(() => undefined)
    const onResize = (): void => setScreenH(window.innerHeight)
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const off = window.api.mp.onDanmaku((d) => {
      setTracks(Math.max(1, Math.min(8, d.tracks)))
      // 轨道轮转分配，避免所有弹幕挤在同一条线上。
      const track = trackCursor.current % Math.max(1, d.tracks)
      trackCursor.current += 1
      const item: FlyingDanmaku = {
        ...d,
        track,
        // 速度是「像素/秒」，横跨屏幕所需时长 = 屏宽 / 速度；给一个下限防止过快。
        durationMs: Math.max(4000, (window.innerWidth + 400) / Math.max(1, d.speed) * 1000),
        createdAt: Date.now()
      }
      setItems((prev) => {
        const next = [...prev, item]
        return next.length > MAX_DANMAKU ? next.slice(next.length - MAX_DANMAKU) : next
      })
      // 动画结束后回收（时长 + 1s 余量）。
      window.setTimeout(() => {
        setItems((prev) => prev.filter((x) => x.id !== item.id))
      }, item.durationMs + 1000)
    })
    return off
  }, [])

  const lineHeight = Math.max(28, Math.min(64, screenH / tracks))

  return (
    <div
      className="h-screen w-screen overflow-hidden"
      style={{ pointerEvents: 'none', userSelect: 'none', position: 'relative' }}
    >
      {items.map((d) => (
        <div
          key={d.id}
          style={{
            position: 'absolute',
            top: d.track * lineHeight + 8,
            left: '100%',
            whiteSpace: 'nowrap',
            fontSize: d.fontSize,
            opacity: d.opacity,
            color: '#ffffff',
            fontWeight: 600,
            textShadow: '0 1px 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.6)',
            animation: `hungercat-danmaku ${d.durationMs}ms linear forwards`
          }}
        >
          {d.text}
        </div>
      ))}
      {/* 弹幕动画关键帧：从右侧屏外滑到左侧屏外。内联 style 无法定义 keyframes，这里用 <style>。*/}
      <style>{`
        @keyframes hungercat-danmaku {
          from { transform: translateX(0); }
          to { transform: translateX(calc(-100vw - 100%)); }
        }
      `}</style>
    </div>
  )
}

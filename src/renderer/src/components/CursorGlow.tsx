import { useEffect, useRef } from 'react'
import { useApp } from '../store'
import { subscribeCursor } from '../cursor'

const SIZE = 560
const HALF = SIZE / 2

/** 跟随鼠标的光晕（screen 混合，照亮下方元素；亮度随距离自然递减）。 */
export function CursorGlow(): JSX.Element {
  const { settings } = useApp()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || settings.reducedMotion) return

    let raf = 0
    let x = window.innerWidth / 2
    let y = window.innerHeight / 2

    const apply = (): void => {
      raf = 0
      el.style.transform = `translate3d(${x - HALF}px, ${y - HALF}px, 0)`
    }

    const move = (nx: number, ny: number): void => {
      x = nx
      y = ny
      if (!raf) raf = requestAnimationFrame(apply)
    }

    const onMove = (e: MouseEvent): void => move(e.clientX, e.clientY)

    window.addEventListener('mousemove', onMove, { passive: true })
    // 鼠标在自定义主页 iframe 内时宿主收不到 mousemove：由沙箱回传坐标，这里一并订阅。
    const unsubscribe = subscribeCursor(move)
    apply()
    return () => {
      window.removeEventListener('mousemove', onMove)
      unsubscribe()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [settings.reducedMotion])

  if (settings.reducedMotion) return <></>

  return <div ref={ref} className="cursor-glow" aria-hidden />
}

import { useEffect, useRef } from 'react'
import { useApp } from '../store'

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

    const onMove = (e: MouseEvent): void => {
      x = e.clientX
      y = e.clientY
      if (!raf) raf = requestAnimationFrame(apply)
    }

    window.addEventListener('mousemove', onMove, { passive: true })
    apply()
    return () => {
      window.removeEventListener('mousemove', onMove)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [settings.reducedMotion])

  if (settings.reducedMotion) return <></>

  return <div ref={ref} className="cursor-glow" aria-hidden />
}

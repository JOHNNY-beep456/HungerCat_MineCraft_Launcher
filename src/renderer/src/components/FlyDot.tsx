import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { useRuntime } from '../runtime'

/** 下载开始时，一颗光球从按钮处飞向侧边栏「下载」项。 */
export function FlyDot(): JSX.Element | null {
  const { flyFrom } = useRuntime()
  const [anim, setAnim] = useState<{ from: { x: number; y: number }; to: { x: number; y: number }; key: number } | null>(null)

  useEffect(() => {
    if (!flyFrom) return
    const el = document.getElementById('nav-download')
    const r = el?.getBoundingClientRect()
    const to = r
      ? { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      : { x: 48, y: window.innerHeight - 48 }
    setAnim({ from: { x: flyFrom.x, y: flyFrom.y }, to, key: flyFrom.key })
  }, [flyFrom])

  if (!anim) return null

  return (
    <motion.div
      key={anim.key}
      className="pointer-events-none fixed z-[80] h-4 w-4 rounded-full"
      style={{ background: 'var(--fill-primary)', boxShadow: '0 0 16px 6px var(--fill-primary)' }}
      initial={{ x: anim.from.x - 8, y: anim.from.y - 8, scale: 0.4, opacity: 1 }}
      animate={{ x: anim.to.x - 8, y: anim.to.y - 8, scale: 0.9, opacity: 0 }}
      transition={{ duration: 0.7, ease: 'easeIn' }}
      onAnimationComplete={() => setAnim(null)}
    />
  )
}

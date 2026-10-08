import type { ReactNode } from 'react'

/** 设置项行：左侧标题 / 描述，右侧操作控件。版本设置板块内多处复用。 */
export function Row({ label, desc, children }: { label: string; desc?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="glass-soft flex items-center justify-between gap-4 rounded-2xl p-4">
      <div>
        <div className="text-[14px] font-medium">{label}</div>
        {desc && <div className="caption mt-0.5">{desc}</div>}
      </div>
      {children}
    </div>
  )
}

/** 加载器展示名：首字母大写。 */
export function loaderLabel(loader: string): string {
  return loader.charAt(0).toUpperCase() + loader.slice(1)
}

/** 文件体积格式化：B / KB / MB / GB。 */
export function formatBytes(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}

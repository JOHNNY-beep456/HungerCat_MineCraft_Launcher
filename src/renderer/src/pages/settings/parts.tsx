import type { ReactNode } from 'react'
import { Icon } from '../../components/ui'

/** 设置页各板块共用的「板块」外壳：玻璃卡片 + 图标标题 + 纵向内容间距。 */
export function Section({ title, icon, children }: { title: string; icon: string; children: ReactNode }): JSX.Element {
  return (
    <div className="glass rounded-[26px] p-5">
      <div className="mb-3 flex items-center gap-2">
        <Icon name={icon} size={17} className="opacity-70" />
        <span className="title">{title}</span>
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

/** 设置页各板块共用的「一行设置」：左侧标签 + 右侧控件。 */
export function Row({ label, children, className }: { label: string; children: ReactNode; className?: string }): JSX.Element {
  return (
    <div className={`flex items-center justify-between gap-4 ${className ?? ''}`}>
      <span className="text-[13px] opacity-80">{label}</span>
      {children}
    </div>
  )
}

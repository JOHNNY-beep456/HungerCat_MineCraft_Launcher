import { createPortal } from 'react-dom'
import { useApp } from '../../store'
import { Button, Icon } from '../../components/ui'
import type { DepMissing } from './mod-dependencies'

/**
 * 缺前置确认弹窗：列出缺失的必需前置，由用户决定是否一并下载。
 * 必须 portal 到 body：带 transform 的入场动画祖先会让 fixed 定位改为相对该容器解析。
 */
export function DependencyPromptDialog({
  targetLabel,
  missing,
  busy = false,
  onCancel,
  onConfirm
}: {
  /** 目标实例展示名（实例 id 或「id - 目录别名」）。 */
  targetLabel: string
  missing: DepMissing[]
  /** 确认后正在下载前置与本体时禁用按钮，避免重复提交。 */
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  const { t } = useApp()
  return createPortal(
    <div className="fixed inset-0 z-[130] flex items-center justify-center p-6">
      <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={busy ? undefined : onCancel} />
      <div className="glass-strong relative z-10 w-full max-w-md rounded-[28px] p-6">
        <div className="mb-2 flex items-center gap-2">
          <Icon name="info" size={20} style={{ color: 'var(--fill-primary)' }} />
          <span className="title">{t('res.dep.title')}</span>
        </div>
        <p className="caption mt-2">{t('res.dep.desc', { target: targetLabel })}</p>
        <ul className="mt-3 max-h-56 space-y-1 overflow-y-auto">
          {missing.map((m) => (
            <li
              key={m.projectId}
              className="truncate rounded-lg px-3 py-1.5 text-[13px]"
              style={{ background: 'var(--chip-bg)' }}
              title={m.title}
            >
              {m.title}
            </li>
          ))}
        </ul>
        <div className="mt-5 flex gap-2">
          <Button className="flex-1" disabled={busy} onClick={onCancel}>
            {t('res.dep.cancel')}
          </Button>
          <Button variant="primary" className="flex-1" icon="download" disabled={busy} onClick={onConfirm}>
            {busy ? t('res.downloading') : t('res.dep.confirm')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/**
 * AI 工具调用的「需要你确认」弹窗（主窗口版）。
 *
 * 危险操作（删实例 / 删文件 / 重命名）默认要求逐次确认。确认框出现的**位置**
 * 由主进程决定：悬浮球存在时只发给悬浮球（那是用户正在看的地方），否则落到
 * 主窗口 —— 因此两处各有一份 UI，互不重复弹。
 *
 * 这里只依赖 useApp() 的文案，展示逻辑与 AiBall 内的确认区完全一致。
 */
import { useEffect, useState } from 'react'
import type { AiToolRequest } from '@shared/types'
import { useApp } from '../store'
import { Button } from './ui'

export function AiToolPrompt(): JSX.Element | null {
  const { t } = useApp()
  const [req, setReq] = useState<AiToolRequest | null>(null)

  useEffect(() => window.api.ai.onToolRequest((r) => setReq(r)), [])

  if (!req) return null

  const decide = async (approved: boolean): Promise<void> => {
    const current = req
    setReq(null)
    if (current) await window.api.ai.decideTool(current.id, approved)
  }

  return (
    <div
      className="fixed inset-0 z-[140] flex items-center justify-center p-6"
      style={{ background: 'var(--scrim)' }}
      role="dialog"
      aria-modal="true"
    >
      <div className="glass-strong w-full max-w-md rounded-[24px] p-5">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="title">{t('ai.confirmTitle')}</h2>
          {req.risk === 'dangerous' && (
            <span
              className="caption rounded-md px-1.5 py-0.5"
              style={{ background: 'var(--fill-danger)', color: '#fff' }}
            >
              {t('ai.confirmRisk')}
            </span>
          )}
        </div>
        <p className="mb-2 text-[13px] leading-relaxed">{req.summary}</p>
        <details className="mb-3">
          <summary className="caption cursor-pointer">{t('ai.confirmArgs')}</summary>
          <pre
            className="selectable mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-xl p-2 font-mono text-[12px]"
            style={{ background: 'rgba(0,0,0,0.2)' }}
          >
            {JSON.stringify(req.args, null, 2)}
          </pre>
        </details>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => void decide(false)}>
            {t('ai.confirmDeny')}
          </Button>
          {/* 与悬浮球内的确认区保持一致：允许是主操作，需要一眼可辨。 */}
          <Button variant="primary" onClick={() => void decide(true)}>
            {t('ai.confirmAllow')}
          </Button>
        </div>
      </div>
    </div>
  )
}
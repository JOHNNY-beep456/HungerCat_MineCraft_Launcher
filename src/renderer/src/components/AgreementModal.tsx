import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import type { AgreementContent } from '@shared/types'
import { useApp } from '../store'
import { Button, Icon, LoadingState } from './ui'

export function AgreementModal(): JSX.Element {
  const { updateSettings } = useApp()
  const [content, setContent] = useState<AgreementContent | null>(null)
  const [error, setError] = useState(false)
  const [agreeing, setAgreeing] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const c = await window.api.about.agreement()
        if (alive) setContent(c)
      } catch {
        if (alive) setError(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const agree = async (): Promise<void> => {
    setAgreeing(true)
    try {
      await updateSettings({ agreementAcceptedAt: Date.now() })
    } finally {
      setAgreeing(false)
    }
  }

  return (
    <motion.div
      className="fixed inset-0 z-[100] flex items-center justify-center p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
    >
      <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} />
      <motion.div
        className="glass-strong relative z-10 flex max-h-[82vh] w-full max-w-2xl flex-col rounded-[28px] p-7"
        initial={{ scale: 0.95, opacity: 0, y: 16 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ type: 'spring', bounce: 0.16, duration: 0.45 }}
      >
        <div className="mb-2 flex items-center gap-2">
          <Icon name="box" size={20} />
          <span className="title">欢迎使用 Hunger Cat 启动器</span>
        </div>
        <p className="caption mb-4">首次使用前，请阅读并同意以下协议。</p>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-2xl p-1 pr-2">
          {content === null && !error ? (
            <LoadingState text="正在加载协议…" />
          ) : error ? (
            <div className="space-y-3 text-[13px] leading-relaxed opacity-80">
              <p>无法连接服务器获取最新协议，请访问服务端查看完整内容。</p>
              <p>继续使用即表示你同意遵守服务端公布的隐私政策与用户协议。</p>
            </div>
          ) : (
            <>
              <AgreementBlock title="隐私政策" body={content?.privacy ?? ''} />
              <AgreementBlock title="用户协议" body={content?.terms ?? ''} />
            </>
          )}
        </div>

        <div className="mt-5 flex items-center justify-between gap-3">
          <span className="caption">
            {content?.updatedAt ? `更新于 ${new Date(content.updatedAt).toLocaleDateString()}` : '点击同意即代表你已阅读并同意'}
          </span>
          <Button variant="primary" size="lg" icon="check" onClick={() => void agree()} disabled={agreeing}>
            {agreeing ? '处理中…' : '同意并继续'}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  )
}

function AgreementBlock({ title, body }: { title: string; body: string }): JSX.Element {
  return (
    <div className="glass-soft rounded-2xl p-4">
      <div className="headline mb-2">{title}</div>
      <div className="selectable whitespace-pre-wrap break-words text-[13px] leading-relaxed opacity-80">
        {body || '（暂无内容）'}
      </div>
    </div>
  )
}

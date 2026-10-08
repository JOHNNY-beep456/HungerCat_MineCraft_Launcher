import { useEffect, useState } from 'react'
import type { DevModeStatus } from '@shared/types'
import { useApp } from '../../store'
import { Button, Segmented, Switch } from '../../components/ui'
import { type TFunction } from '../../i18n'
import { Row, Section } from './parts'

/** 「开发模式」板块：邮箱验证码授权、开关与主页安全防护档位。 */
export function DeveloperSection(): JSX.Element {
  const { t } = useApp()
  const [dev, setDev] = useState<DevModeStatus | null>(null)
  const [devEmail, setDevEmail] = useState('')
  const [devCode, setDevCode] = useState('')
  const [devSending, setDevSending] = useState(false)
  const [devVerifying, setDevVerifying] = useState(false)
  const [devError, setDevError] = useState('')
  const [devNotice, setDevNotice] = useState('')
  const [devCooldown, setDevCooldown] = useState(0)

  // 订阅主进程广播的开发模式状态变化（开关 / 解除 / 到期自动关闭）。
  useEffect(() => {
    void window.api.devMode.status().then(setDev).catch(() => {})
    return window.api.devMode.onChanged(setDev)
  }, [])

  // 发送验证码后的重发冷却倒计时。
  useEffect(() => {
    if (devCooldown <= 0) return
    const t = setInterval(() => setDevCooldown((v) => (v <= 1 ? 0 : v - 1)), 1000)
    return () => clearInterval(t)
  }, [devCooldown])

  /** 发送开发模式验证码到指定邮箱。 */
  const sendDevCode = async (): Promise<void> => {
    const email = devEmail.trim()
    if (!email) {
      setDevError(t('settings.dev.err.emailRequired'))
      return
    }
    setDevSending(true)
    setDevError('')
    setDevNotice('')
    try {
      const r = await window.api.devMode.sendCode(email)
      setDevCooldown(r.cooldown || 60)
      setDevNotice(t('settings.dev.notice.sent', { n: Math.round((r.ttl || 600) / 60) }))
    } catch (err) {
      setDevError(err instanceof Error ? err.message : String(err))
    } finally {
      setDevSending(false)
    }
  }

  /** 校验验证码，成功后获得 1 天授权。 */
  const verifyDevCode = async (): Promise<void> => {
    const email = devEmail.trim()
    const code = devCode.trim()
    if (!email || !code) {
      setDevError(t('settings.dev.err.inputRequired'))
      return
    }
    setDevVerifying(true)
    setDevError('')
    setDevNotice('')
    try {
      await window.api.devMode.verify(email, code)
      setDevCode('')
      setDevNotice(t('settings.dev.notice.verified'))
      setDev(await window.api.devMode.status())
    } catch (err) {
      setDevError(err instanceof Error ? err.message : String(err))
    } finally {
      setDevVerifying(false)
    }
  }

  /** 开关开发模式。 */
  const toggleDev = async (v: boolean): Promise<void> => {
    setDevError('')
    try {
      setDev(await window.api.devMode.setEnabled(v))
    } catch (err) {
      setDevError(err instanceof Error ? err.message : String(err))
    }
  }

  /** 解除授权：服务端作废令牌并清空本地授权。 */
  const revokeDev = async (): Promise<void> => {
    if (!window.confirm(t('settings.dev.confirm.revoke'))) return
    setDevError('')
    setDevNotice('')
    try {
      setDev(await window.api.devMode.revoke())
      setDevNotice(t('settings.dev.notice.revoked'))
    } catch (err) {
      setDevError(err instanceof Error ? err.message : String(err))
    }
  }

  /** 切换主页安全防护档位。 */
  const setDevSecurity = async (mode: 'full' | 'warn' | 'off'): Promise<void> => {
    setDev(await window.api.devMode.setSecurityMode(mode))
  }

  return (
    <Section title={t('settings.section.devMode')} icon="info">
      {!dev?.granted ? (
        <>
          <p className="caption">
            {t('settings.dev.intro')}
          </p>
          <Row label={t('settings.dev.email')}>
            <input
              type="email"
              value={devEmail}
              onChange={(e) => setDevEmail(e.target.value)}
              placeholder="you@example.com"
              className="input w-56"
            />
          </Row>
          <Row label={t('settings.dev.code')}>
            <div className="flex items-center gap-2">
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={devCode}
                onChange={(e) => setDevCode(e.target.value.replace(/\D/g, ''))}
                placeholder={t('settings.dev.code.placeholder')}
                className="input w-28"
              />
              <Button
                size="sm"
                icon="mail"
                disabled={devSending || devCooldown > 0}
                onClick={() => void sendDevCode()}
              >
                {devSending ? t('settings.dev.sending') : devCooldown > 0 ? `${devCooldown}s` : t('settings.dev.sendCode')}
              </Button>
            </div>
          </Row>
          <div className="flex items-center gap-2">
            <Button variant="primary" icon="check" disabled={devVerifying} onClick={() => void verifyDevCode()}>
              {devVerifying ? t('settings.dev.verifying') : t('settings.dev.verify')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <Row label={t('settings.dev.status')}>
            <span className="chip">{t('settings.dev.status.granted')} · {dev.emailMasked || '—'}</span>
          </Row>
          <Row label={t('settings.dev.remaining')}>
            <span className="chip">{formatDevRemaining(dev.expiresAt, t)}</span>
          </Row>
          <Row label={t('settings.dev.enabled')}>
            <Switch checked={dev.enabled} onChange={(v) => void toggleDev(v)} />
          </Row>
          <Row label={t('settings.dev.security')}>
            <Segmented
              value={dev.securityMode}
              onChange={(v) => void setDevSecurity(v)}
              options={[
                { value: 'full', label: t('settings.dev.security.full') },
                { value: 'warn', label: t('settings.dev.security.warn') },
                { value: 'off', label: t('settings.dev.security.off') }
              ]}
            />
          </Row>
          <p className="caption -mt-1">
            {dev.securityMode === 'full' && t('settings.dev.security.full.desc')}
            {dev.securityMode === 'warn' && t('settings.dev.security.warn.desc')}
            {dev.securityMode === 'off' && t('settings.dev.security.off.desc')}
            {!dev.enabled && t('settings.dev.security.disabledNotice')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon="info" onClick={() => void window.api.devMode.openTools()}>
              {t('settings.dev.openTools')}
            </Button>
            <Button
              size="sm"
              icon="terminal"
              onClick={async () => {
                const ok = await window.api.devMode.openDevTools()
                if (!ok) setDevError(t('settings.dev.openDevToolsError'))
                else setDevError('')
              }}
            >
              {t('settings.dev.openDevTools')}
            </Button>
            <Button size="sm" variant="ghost" icon="xmark" onClick={() => void revokeDev()}>
              {t('settings.dev.revoke')}
            </Button>
          </div>
        </>
      )}
      {devError && (
        <div className="glass-soft rounded-xl p-3 text-[13px]" style={{ color: 'var(--fill-danger)' }}>
          {devError}
        </div>
      )}
      {devNotice && !devError && (
        <div className="glass-soft rounded-xl p-3 text-[13px] opacity-80">{devNotice}</div>
      )}
    </Section>
  )
}

/** 把开发模式到期时间格式化为「剩余 x 小时 y 分钟」。 */
function formatDevRemaining(expiresAt: number, t: TFunction): string {
  const ms = expiresAt - Date.now()
  if (ms <= 0) return t('settings.dev.expired')
  const totalMin = Math.floor(ms / 60000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? t('settings.dev.remainingHM', { h, m }) : t('settings.dev.remainingM', { m })
}

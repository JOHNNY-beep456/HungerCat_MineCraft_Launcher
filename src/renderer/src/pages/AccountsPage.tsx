import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import type { AuthStatus, DeviceCodeInfo, YggdrasilProfileOption } from '@shared/types'
import { useApp } from '../store'
import { Avatar, Button, GlassCard, Icon, Segmented, Spinner, yggdrasilSiteLabel } from '../components/ui'

/** 账号页视图状态：账号列表，或某一种登录整页。 */
type AccountView = 'list' | 'microsoft' | 'yggdrasil' | 'offline'

// 第三方认证服务器：界面只需填域名，主进程会自动补全 /api/yggdrasil。
const LITTLESKIN_DOMAIN = 'littleskin.cn'
const CHANMAO_DOMAIN = 'skin.johnnyblog.top'

/** 第三方登录 IPC 的保护性超时：即使主进程某次请求异常挂起，弹窗也不会永久停在「登录中」。统一为 10s。 */
const YGG_LOGIN_TIMEOUT_MS = 10_000

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

type YggPreset = 'littleskin' | 'chanmao' | 'custom'

const YGG_PRESETS: Array<{ value: YggPreset; domain: string }> = [
  { value: 'littleskin', domain: LITTLESKIN_DOMAIN },
  { value: 'chanmao', domain: CHANMAO_DOMAIN }
]

export function AccountsPage(): JSX.Element {
  const { t, accounts, selectedAccount, selectAccount, removeAccount, reloadAccounts, settings } = useApp()
  const [view, setView] = useState<AccountView>('list')
  const [info, setInfo] = useState<DeviceCodeInfo | null>(null)
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [copied, setCopied] = useState(false)
  const started = useRef(false)

  const [offlineName, setOfflineName] = useState('')
  const [offlineError, setOfflineError] = useState<string | null>(null)

  const [yggPreset, setYggPreset] = useState<YggPreset>('littleskin')
  const [yggServer, setYggServer] = useState(LITTLESKIN_DOMAIN)
  const [yggEmail, setYggEmail] = useState('')
  const [yggPassword, setYggPassword] = useState('')
  const [yggLoading, setYggLoading] = useState(false)
  const [yggError, setYggError] = useState<string | null>(null)
  // 弹窗生命周期守卫：关闭/取消后置 false，防止登录的异步结果在弹窗关闭后
  // 继续 setState（React 对已卸载/隐藏组件的 setState 会造成无响应）。
  const yggAlive = useRef(false)
  // 多角色选择：服务端返回多个角色时弹出的「选择角色」弹窗（可多选）。
  const [yggProfiles, setYggProfiles] = useState<YggdrasilProfileOption[] | null>(null)
  const [yggPicked, setYggPicked] = useState<Set<string>>(new Set())
  const [yggCommitting, setYggCommitting] = useState(false)
  const [yggModalError, setYggModalError] = useState<string | null>(null)

  // 进入账号页时，补全第三方账号缺失的「站点名称」（自动获取 Yggdrasil 元数据里的
  // meta.serverName），随后刷新全局账号状态，让列表 / 侧栏都能显示站点名。
  // best-effort：失败静默保留原状，不影响任何登录功能。
  useEffect(() => {
    let alive = true
    void window.api.accounts
      .refreshSiteNames()
      .then(() => {
        if (alive) void reloadAccounts()
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [reloadAccounts])

  const begin = useCallback(async () => {
    setView('microsoft')
    setStatus(null)
    setInfo(null)
    started.current = true
    try {
      const device = await window.api.auth.begin()
      if (started.current) setInfo(device)
    } catch (err) {
      setStatus({ state: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  const cancel = useCallback(() => {
    started.current = false
    setView('list')
    setInfo(null)
    setStatus(null)
    void window.api.auth.cancel()
  }, [])

  useEffect(() => {
    return window.api.auth.onStatus((s) => {
      if (!started.current) return
      setStatus(s)
      if (s.state === 'success') {
        started.current = false
        void reloadAccounts()
        setTimeout(() => {
          setView('list')
          setInfo(null)
          setStatus(null)
        }, 900)
      }
    })
  }, [reloadAccounts])

  const copyCode = (): void => {
    if (!info) return
    void navigator.clipboard.writeText(info.userCode).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const addOffline = async (): Promise<void> => {
    const name = offlineName.trim()
    if (!name) return
    setOfflineError(null)
    try {
      await window.api.accounts.addOffline(name)
      setView('list')
      setOfflineName('')
      void reloadAccounts()
    } catch (err) {
      setOfflineError(err instanceof Error ? err.message : String(err))
    }
  }

  // 打开第三方登录页：重置生命周期守卫。
  const openYgg = useCallback((): void => {
    yggAlive.current = true
    setView('yggdrasil')
    setYggError(null)
  }, [])

  // 关闭/取消第三方登录页：先置守卫 false（尽快丢弃在途登录结果），再回到列表。
  const closeYgg = useCallback((): void => {
    yggAlive.current = false
    setYggLoading(false)
    setYggProfiles(null)
    setView('list')
    setYggError(null)
  }, [])

  const chooseYggPreset = (v: YggPreset): void => {
    setYggPreset(v)
    setYggError(null)
    const preset = YGG_PRESETS.find((p) => p.value === v)
    if (preset) setYggServer(preset.domain)
  }

  const addYggdrasil = async (): Promise<void> => {
    if (!yggEmail.trim() || !yggPassword.trim()) return
    setYggError(null)
    setYggLoading(true)
    try {
      // 统一 10s 保护性超时：即使认证服务器挂起，这里也不会永久 pending。
      const result = await withTimeout(
        window.api.accounts.addYggdrasil(yggServer, yggEmail.trim(), yggPassword),
        YGG_LOGIN_TIMEOUT_MS,
        t('acc.yggTimeout')
      )
      // 关闭期间守卫会被置 false，这里直接放弃处理，避免离开页面后再 setState。
      if (!yggAlive.current) return
      // 多角色：弹出选择弹窗（可多选），选完再批量建号。
      if (result.profiles && result.profiles.length > 0) {
        setYggProfiles(result.profiles)
        // 默认勾选第一个角色，其余由用户按需勾选，避免误把全部角色一并添加。
        setYggPicked(new Set([result.profiles[0].id]))
        setYggModalError(null)
        return
      }
      setView('list')
      setYggEmail('')
      setYggPassword('')
      void reloadAccounts()
    } catch (err) {
      // 超时/失败仅在弹窗仍然打开时展示错误信息。
      if (yggAlive.current) setYggError(err instanceof Error ? err.message : String(err))
    } finally {
      if (yggAlive.current) setYggLoading(false)
    }
  }

  /** 切换某个角色是否被选中（多选）。 */
  const toggleYggProfile = (id: string): void => {
    setYggModalError(null)
    setYggPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 提交多角色选择：批量创建账号后回到列表。 */
  const confirmYggProfiles = async (): Promise<void> => {
    const ids = yggProfiles?.filter((p) => yggPicked.has(p.id)).map((p) => p.id) ?? []
    if (ids.length === 0) {
      setYggModalError(t('acc.yggPickRequired'))
      return
    }
    setYggCommitting(true)
    setYggModalError(null)
    try {
      await window.api.accounts.addYggdrasilProfiles(ids)
      if (!yggAlive.current) return
      setYggProfiles(null)
      setView('list')
      setYggEmail('')
      setYggPassword('')
      void reloadAccounts()
    } catch (err) {
      if (yggAlive.current) setYggModalError(err instanceof Error ? err.message : String(err))
    } finally {
      if (yggAlive.current) setYggCommitting(false)
    }
  }

  return (
    <div className="flex h-full flex-col gap-5">
      {/* 账号列表 ⇄ 登录整页：同一时刻只渲染一个视图，按 key 切换做淡入入场。
          只用入场、不用 AnimatePresence 的 mode="wait" 退场——退场会延后新视图挂载，
          若退场期间发生重渲染（如刚删除账号），新视图可能一直不挂载而出现空白屏。 */}
      {view === 'list' && (
        <motion.div
          key="list"
          className="flex min-h-0 flex-1 flex-col gap-5"
          initial={{ opacity: 0, y: 10, scale: 0.995 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
        >
      <div className="flex items-end justify-between">
        <div>
          <h1 className="display">{t('acc.title')}</h1>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setView('offline')}>{t('acc.offlineAccount')}</Button>
          <Button
            onClick={openYgg}
            disabled={settings.mode === 'local'}
            title={settings.mode === 'local' ? t('acc.localModeDisabled') : undefined}
          >
            {t('acc.thirdParty')}
          </Button>
          <Button
            variant="primary"
            icon="plus"
            onClick={begin}
            disabled={settings.mode === 'local'}
            title={settings.mode === 'local' ? t('acc.localModeDisabled') : undefined}
          >
            {t('acc.microsoft')}
          </Button>
        </div>
      </div>

      <div className="grid flex-1 auto-rows-min grid-cols-1 gap-3 overflow-y-auto pr-1 md:grid-cols-2">
        {accounts.length === 0 && (
          <div className="glass col-span-full flex flex-col items-center justify-center gap-3 rounded-[28px] p-12 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl" style={{ background: 'var(--fill-secondary)' }}>
              <Icon name="user" size={30} className="opacity-60" />
            </div>
            <div className="title">{t('acc.emptyTitle')}</div>
            <p className="caption max-w-xs">{t('acc.emptyDesc')}</p>
            {settings.mode === 'local' ? (
              <Button icon="plus" onClick={() => setView('offline')}>
                {t('acc.createOffline')}
              </Button>
            ) : (
              <Button variant="primary" icon="plus" onClick={begin}>
                {t('acc.microsoftTitle')}
              </Button>
            )}
          </div>
        )}

        {accounts.map((a) => {
          const isSel = selectedAccount?.id === a.id
          // 第三方账号显示站点名称（自动获取；缺失时回落到认证域名，再缺则用通用标签）。
          const siteLabel = a.authType === 'yggdrasil' ? yggdrasilSiteLabel(a) || t('acc.chipThirdParty') : ''
          return (
            <motion.div
              key={a.id}
              layout
              className="glass flex items-center gap-3 rounded-[24px] p-4"
            >
              <Avatar name={a.name} uuid={a.id} skinUrl={a.skinUrl} authType={a.authType} yggdrasilServer={a.yggdrasilServer} offline={a.offline} size={48} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="title truncate">{a.name}</span>
                  {a.offline && <span className="chip">{t('acc.chipOffline')}</span>}
                  {a.authType === 'yggdrasil' && <span className="chip">{siteLabel}</span>}
                  {isSel && (
                    <span className="chip" style={{ color: 'var(--fill-primary)' }}>
                      {t('acc.inUse')}
                    </span>
                  )}
                </div>
                <div className="caption selectable truncate">{a.id}</div>
              </div>
              <div className="flex items-center gap-1">
                {!isSel && (
                  <Button size="sm" onClick={() => void selectAccount(a.id)}>
                    {t('acc.use')}
                  </Button>
                )}
                <Button
                  size="sm"
                  icon="trash"
                  variant="ghost"
                  onClick={() => void removeAccount(a.id)}
                  title={t('acc.remove')}
                />
              </div>
            </motion.div>
          )
        })}
      </div>
        </motion.div>
      )}

      {view === 'microsoft' && (
        <motion.div
          key="microsoft"
          className="flex min-h-0 flex-1 flex-col gap-5"
          initial={{ opacity: 0, y: 10, scale: 0.995 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
        >
          {/* 页头 */}
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="display">{t('acc.microsoftTitle')}</h2>
              <p className="caption mt-1">{t('acc.microsoftSubtitle')}</p>
            </div>
            <Button icon="chevronLeft" onClick={cancel}>
              {t('acc.back')}
            </Button>
          </div>

          {/* 主内容区（可滚动） */}
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="flex max-w-3xl flex-col gap-5 pb-6">
              {status?.state === 'success' ? (
                <GlassCard className="flex flex-col items-center gap-3 py-12">
                  <div
                    className="flex h-14 w-14 items-center justify-center rounded-full text-white"
                    style={{ background: 'var(--fill-success)' }}
                  >
                    <Icon name="check" size={28} />
                  </div>
                  <div className="title">{t('acc.success')}</div>
                  <p className="caption">{status.account.name}</p>
                  <p className="caption mt-1 opacity-60">{t('acc.returning')}</p>
                </GlassCard>
              ) : (
                <>
                  <GlassCard className="p-6">
                    <div className="mb-5">
                      <h3 className="headline">{t('acc.deviceCode')}</h3>
                      <p className="caption mt-0.5">{t('acc.deviceCodeHint')}</p>
                    </div>
                    <div className="glass-soft rounded-2xl p-6 text-center">
                      <div className="caption mb-1">{t('acc.yourCode')}</div>
                      {info ? (
                        <button
                          onClick={copyCode}
                          className="group relative mx-auto block text-4xl font-bold tracking-[0.2em] no-drag"
                          title={t('acc.clickToCopy')}
                        >
                          {info.userCode}
                          <span className="ml-1 align-middle text-sm opacity-0 transition-opacity group-hover:opacity-60">
                            {copied ? t('acc.copied') : t('acc.copy')}
                          </span>
                        </button>
                      ) : (
                        <div className="flex items-center justify-center gap-2 py-1 text-[13px] opacity-70">
                          <Spinner size={16} />
                          <span>{t('acc.fetchingCode')}</span>
                        </div>
                      )}
                    </div>
                  </GlassCard>

                  <GlassCard className="p-6">
                    <div className="mb-4">
                      <h3 className="headline">{t('acc.steps')}</h3>
                      <p className="caption mt-0.5">{t('acc.stepsHint')}</p>
                    </div>
                    <div className="space-y-2">
                      <Step n={1} text={t('acc.step1', { url: info?.verificationUri ?? 'microsoft.com/link' })} />
                      <Step n={2} text={t('acc.step2')} />
                      <Step n={3} text={t('acc.step3')} />
                    </div>
                  </GlassCard>
                </>
              )}

              {status?.state === 'error' && (
                <div
                  className="flex items-center gap-3 rounded-xl p-3 text-[13px]"
                  style={{ background: 'rgba(255,69,58,0.14)', color: 'var(--fill-danger)' }}
                >
                  <Icon name="xmark" size={18} />
                  <span>{t('acc.loginFailed', { error: status.error })}</span>
                </div>
              )}

              {status?.state === 'waiting' && (
                <div
                  className="flex items-center gap-3 rounded-xl p-4 text-[13px]"
                  style={{ background: 'var(--fill-secondary)' }}
                >
                  <Spinner size={20} />
                  <span className="caption">{t('acc.waiting', { elapsed: status.elapsed, expiresIn: status.expiresIn })}</span>
                </div>
              )}
            </div>
          </div>

          {/* 底部操作栏 */}
          <div className="glass-strong shrink-0 rounded-3xl p-4">
            <div className="flex flex-wrap items-center justify-end gap-3">
              <Button
                size="lg"
                className="min-w-[112px]"
                onClick={cancel}
                disabled={status?.state === 'success'}
              >
                {t('acc.cancel')}
              </Button>
              {status?.state === 'error' ? (
                <Button variant="primary" size="lg" className="min-w-[176px]" onClick={begin}>
                  {t('acc.retry')}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="lg"
                  className="min-w-[176px]"
                  icon="link"
                  onClick={() => info && window.api.shell.openExternal(info.verificationUri)}
                >
                  {t('acc.openBrowser')}
                </Button>
              )}
            </div>
          </div>
        </motion.div>
      )}

      {view === 'yggdrasil' && (
        <motion.div
          key="yggdrasil"
          className="flex min-h-0 flex-1 flex-col gap-5"
          initial={{ opacity: 0, y: 10, scale: 0.995 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
        >
          {/* 页头 */}
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="display">{t('acc.yggTitle')}</h2>
              <p className="caption mt-1">{t('acc.yggSubtitle')}</p>
            </div>
            <Button icon="chevronLeft" onClick={closeYgg}>
              {t('acc.back')}
            </Button>
          </div>

          {/* 主内容区（可滚动） */}
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="flex max-w-3xl flex-col gap-5 pb-6">
              <GlassCard className="p-6">
                <div className="mb-5">
                  <h3 className="headline">{t('acc.authServer')}</h3>
                  <p className="caption mt-0.5">{t('acc.authServerHint')}</p>
                </div>
                <Segmented
                  options={[
                    { value: 'littleskin', label: 'LittleSkin' },
                    { value: 'chanmao', label: t('acc.presetChanmao') },
                    { value: 'custom', label: t('acc.presetCustom') }
                  ]}
                  value={yggPreset}
                  onChange={chooseYggPreset}
                />
                <div className="caption mb-2 mt-4">{t('acc.serverDomain')}</div>
                <input
                  value={yggServer}
                  onChange={(e) => {
                    setYggServer(e.target.value)
                    setYggError(null)
                  }}
                  disabled={yggPreset !== 'custom'}
                  placeholder={t('acc.serverPlaceholder')}
                  className="input w-full"
                />
                <p className="caption mt-2">{t('acc.serverNote')}</p>
              </GlassCard>

              <GlassCard className="p-6">
                <div className="mb-5">
                  <h3 className="headline">{t('acc.accountInfo')}</h3>
                  <p className="caption mt-0.5">{t('acc.accountInfoHint')}</p>
                </div>
                <div className="caption mb-2">{t('acc.emailOrUsername')}</div>
                <input
                  autoFocus
                  value={yggEmail}
                  onChange={(e) => {
                    setYggEmail(e.target.value)
                    setYggError(null)
                  }}
                  placeholder="example@littleskin.cn"
                  className="input mb-3 w-full"
                />
                <div className="caption mb-2">{t('acc.password')}</div>
                <input
                  type="password"
                  value={yggPassword}
                  onChange={(e) => {
                    setYggPassword(e.target.value)
                    setYggError(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && yggEmail.trim() && yggPassword.trim()) void addYggdrasil()
                  }}
                  placeholder="••••••••"
                  className="input w-full"
                />
              </GlassCard>

              {yggError && (
                <div
                  className="flex items-center gap-3 rounded-xl p-3 text-[13px]"
                  style={{ background: 'rgba(255,69,58,0.14)', color: 'var(--fill-danger)' }}
                >
                  <Icon name="xmark" size={18} />
                  <span>{yggError}</span>
                </div>
              )}
            </div>
          </div>

          {/* 底部操作栏 */}
          <div className="glass-strong shrink-0 rounded-3xl p-4">
            <div className="flex flex-wrap items-center justify-end gap-3">
              <Button size="lg" className="min-w-[112px]" onClick={closeYgg}>
                {t('acc.cancel')}
              </Button>
              <Button
                variant="primary"
                size="lg"
                className="min-w-[176px]"
                disabled={yggLoading || !yggEmail.trim() || !yggPassword.trim()}
                onClick={() => void addYggdrasil()}
              >
                {yggLoading ? t('acc.signingIn') : t('acc.signIn')}
              </Button>
            </div>
          </div>
        </motion.div>
      )}

      {view === 'offline' && (
        <motion.div
          key="offline"
          className="flex min-h-0 flex-1 flex-col gap-5"
          initial={{ opacity: 0, y: 10, scale: 0.995 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
        >
          {/* 页头 */}
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="display">{t('acc.offlineAccount')}</h2>
              <p className="caption mt-1">{t('acc.offlineSubtitle')}</p>
            </div>
            <Button icon="chevronLeft" onClick={() => setView('list')}>
              {t('acc.back')}
            </Button>
          </div>

          {/* 主内容区（可滚动） */}
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="flex max-w-3xl flex-col gap-5 pb-6">
              <GlassCard className="p-6">
                <div className="mb-5">
                  <h3 className="headline">{t('acc.playerName')}</h3>
                  <p className="caption mt-0.5">{t('acc.playerNameHint')}</p>
                </div>
                <input
                  autoFocus
                  value={offlineName}
                  onChange={(e) => {
                    setOfflineName(e.target.value)
                    setOfflineError(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && offlineName.trim()) void addOffline()
                  }}
                  placeholder={t('acc.playerPlaceholder')}
                  className="input w-full"
                />
                {offlineError && (
                  <div
                    className="mt-4 flex items-center gap-3 rounded-xl p-3 text-[13px]"
                    style={{ background: 'rgba(255,69,58,0.14)', color: 'var(--fill-danger)' }}
                  >
                    <Icon name="xmark" size={18} />
                    <span>{offlineError}</span>
                  </div>
                )}
              </GlassCard>
            </div>
          </div>

          {/* 底部操作栏 */}
          <div className="glass-strong shrink-0 rounded-3xl p-4">
            <div className="flex flex-wrap items-center justify-end gap-3">
              <Button size="lg" className="min-w-[112px]" onClick={() => setView('list')}>
                {t('acc.cancel')}
              </Button>
              <Button
                variant="primary"
                size="lg"
                className="min-w-[176px]"
                disabled={!offlineName.trim()}
                onClick={() => void addOffline()}
              >
                {t('acc.create')}
              </Button>
            </div>
          </div>
        </motion.div>
      )}

      {/* 多角色选择弹窗（可多选）：勾选后一次性添加为多个账号。 */}
      {yggProfiles && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-6">
          <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={() => (yggCommitting ? undefined : setYggProfiles(null))} />
          <motion.div
            role="dialog"
            aria-label={t('acc.yggProfilesTitle')}
            className="glass-strong relative z-10 flex max-h-[80vh] w-full max-w-lg flex-col rounded-[28px] p-6"
            initial={{ scale: 0.94, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            transition={{ type: 'spring', bounce: 0.16, duration: 0.35 }}
          >
            <div className="mb-4">
              <h3 className="title">{t('acc.yggProfilesTitle')}</h3>
              <p className="caption mt-1">{t('acc.yggProfilesHint')}</p>
            </div>

            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {yggProfiles.map((p) => {
                const checked = yggPicked.has(p.id)
                return (
                  <button
                    key={p.id}
                    type="button"
                    disabled={yggCommitting}
                    onClick={() => toggleYggProfile(p.id)}
                    className="flex w-full items-center gap-3 rounded-2xl p-3 text-left no-drag transition-colors"
                    style={{ background: checked ? 'var(--fill-primary)' : 'var(--fill-secondary)' }}
                  >
                    <span
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md"
                      style={{
                        background: checked ? '#fff' : 'transparent',
                        border: checked ? 'none' : '1.5px solid var(--divider)',
                        color: 'var(--fill-primary)'
                      }}
                    >
                      {checked && <Icon name="check" size={14} />}
                    </span>
                    <Avatar name={p.name} uuid={p.id} skinUrl={p.skinUrl} yggdrasilServer={yggServer} authType="yggdrasil" size={36} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-semibold" style={{ color: checked ? '#fff' : 'var(--text-primary)' }}>
                        {p.name}
                      </div>
                      <div className="caption truncate" style={{ color: checked ? 'rgba(255,255,255,0.8)' : undefined }}>
                        {p.id}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>

            {yggModalError && (
              <div
                className="mt-4 flex items-center gap-3 rounded-xl p-3 text-[13px]"
                style={{ background: 'rgba(255,69,58,0.14)', color: 'var(--fill-danger)' }}
              >
                <Icon name="xmark" size={18} />
                <span>{yggModalError}</span>
              </div>
            )}

            <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <span className="caption">{t('acc.yggPickedCount', { n: yggPicked.size })}</span>
              <div className="flex items-center gap-3">
                <Button className="min-w-[96px]" disabled={yggCommitting} onClick={() => setYggProfiles(null)}>
                  {t('acc.cancel')}
                </Button>
                <Button
                  variant="primary"
                  className="min-w-[140px]"
                  disabled={yggCommitting || yggPicked.size === 0}
                  onClick={() => void confirmYggProfiles()}
                >
                  {yggCommitting ? t('acc.yggAdding') : t('acc.yggAddSelected')}
                </Button>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  )
}

function Step({ n, text }: { n: number; text: string }): JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <span
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-bold text-white"
        style={{ background: 'var(--fill-primary)' }}
      >
        {n}
      </span>
      <span className="text-[13px] opacity-80">{text}</span>
    </div>
  )
}

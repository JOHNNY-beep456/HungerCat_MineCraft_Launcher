import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { AuthStatus, DeviceCodeInfo } from '@shared/types'
import { useApp } from '../store'
import { Avatar, Button, Icon, Segmented } from '../components/ui'

const LITTLESKIN_SERVER = 'https://littleskin.cn/api/yggdrasil'
const CHANMAO_SERVER = 'https://skin.johnnyblog.top/api/yggdrasil'

type YggPreset = 'littleskin' | 'chanmao' | 'custom'

const YGG_PRESETS: Array<{ value: YggPreset; server: string }> = [
  { value: 'littleskin', server: LITTLESKIN_SERVER },
  { value: 'chanmao', server: CHANMAO_SERVER }
]

export function AccountsPage(): JSX.Element {
  const { accounts, selectedAccount, selectAccount, removeAccount, reloadAccounts, settings } = useApp()
  const [loginOpen, setLoginOpen] = useState(false)
  const [info, setInfo] = useState<DeviceCodeInfo | null>(null)
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [copied, setCopied] = useState(false)
  const started = useRef(false)

  const [offlineOpen, setOfflineOpen] = useState(false)
  const [offlineName, setOfflineName] = useState('')
  const [offlineError, setOfflineError] = useState<string | null>(null)

  const [yggdrasilOpen, setYggdrasilOpen] = useState(false)
  const [yggPreset, setYggPreset] = useState<YggPreset>('littleskin')
  const [yggServer, setYggServer] = useState(LITTLESKIN_SERVER)
  const [yggEmail, setYggEmail] = useState('')
  const [yggPassword, setYggPassword] = useState('')
  const [yggLoading, setYggLoading] = useState(false)
  const [yggError, setYggError] = useState<string | null>(null)

  const begin = useCallback(async () => {
    setLoginOpen(true)
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
    setLoginOpen(false)
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
          setLoginOpen(false)
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
      setOfflineOpen(false)
      setOfflineName('')
      void reloadAccounts()
    } catch (err) {
      setOfflineError(err instanceof Error ? err.message : String(err))
    }
  }

  const addYggdrasil = async (): Promise<void> => {
    if (!yggEmail.trim() || !yggPassword.trim()) return
    setYggError(null)
    setYggLoading(true)
    try {
      await window.api.accounts.addYggdrasil(yggServer, yggEmail.trim(), yggPassword)
      setYggdrasilOpen(false)
      setYggEmail('')
      setYggPassword('')
      void reloadAccounts()
    } catch (err) {
      setYggError(err instanceof Error ? err.message : String(err))
    } finally {
      setYggLoading(false)
    }
  }

  const chooseYggPreset = (v: YggPreset): void => {
    setYggPreset(v)
    setYggError(null)
    const preset = YGG_PRESETS.find((p) => p.value === v)
    if (preset) setYggServer(preset.server)
  }

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="display">账号</h1>
          <p className="caption mt-1">使用微软账号登录，无需申请开发者应用</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setOfflineOpen(true)}>离线账号</Button>
          <Button
            onClick={() => setYggdrasilOpen(true)}
            disabled={settings.mode === 'local'}
            title={settings.mode === 'local' ? '本地模式已关闭在线登录' : undefined}
          >
            第三方
          </Button>
          <Button
            variant="primary"
            icon="plus"
            onClick={begin}
            disabled={settings.mode === 'local'}
            title={settings.mode === 'local' ? '本地模式已关闭在线登录' : undefined}
          >
            微软账号
          </Button>
        </div>
      </div>

      <div className="grid flex-1 auto-rows-min grid-cols-1 gap-3 overflow-y-auto pr-1 md:grid-cols-2">
        {accounts.length === 0 && (
          <div className="glass col-span-full flex flex-col items-center justify-center gap-3 rounded-[28px] p-12 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl" style={{ background: 'var(--fill-secondary)' }}>
              <Icon name="user" size={30} className="opacity-60" />
            </div>
            <div className="title">还没有账号</div>
            <p className="caption max-w-xs">登录你的微软账号后即可启动正版 Minecraft</p>
            {settings.mode === 'local' ? (
              <Button icon="plus" onClick={() => setOfflineOpen(true)}>
                创建离线账号
              </Button>
            ) : (
              <Button variant="primary" icon="plus" onClick={begin}>
                登录微软账号
              </Button>
            )}
          </div>
        )}

        {accounts.map((a) => {
          const isSel = selectedAccount?.id === a.id
          return (
            <motion.div
              key={a.id}
              layout
              className="glass flex items-center gap-3 rounded-[24px] p-4"
            >
              <Avatar name={a.name} uuid={a.id} skinUrl={a.skinUrl} authType={a.authType} yggdrasilServer={a.yggdrasilServer} size={48} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="title truncate">{a.name}</span>
                  {a.offline && <span className="chip">离线</span>}
                  {a.authType === 'yggdrasil' && <span className="chip">第三方</span>}
                  {isSel && (
                    <span className="chip" style={{ color: 'var(--fill-primary)' }}>
                      使用中
                    </span>
                  )}
                </div>
                <div className="caption selectable truncate">{a.id}</div>
              </div>
              <div className="flex items-center gap-1">
                {!isSel && (
                  <Button size="sm" onClick={() => void selectAccount(a.id)}>
                    使用
                  </Button>
                )}
                <Button
                  size="sm"
                  icon="trash"
                  variant="ghost"
                  onClick={() => void removeAccount(a.id)}
                  title="移除账号"
                />
              </div>
            </motion.div>
          )
        })}
      </div>

      {/* Login sheet */}
      <AnimatePresence>
        {loginOpen && (
          <motion.div
            className="absolute inset-0 z-50 flex items-center justify-center p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="absolute inset-0"
              style={{ background: 'var(--scrim)' }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={cancel}
            />
            <motion.div
              className="glass-strong relative z-10 w-full max-w-md rounded-[32px] p-8"
              initial={{ opacity: 0, scale: 0.92, y: 24 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: 16 }}
              transition={{ type: 'spring', bounce: 0.2, duration: 0.45 }}
            >
              <div className="mb-6 text-center">
                <h2 className="title">登录微软账号</h2>
                <p className="caption mt-1">设备代码登录 · 无需申请开发者权限</p>
              </div>

              {status?.state === 'success' ? (
                <div className="flex flex-col items-center gap-3 py-6">
                  <div
                    className="flex h-14 w-14 items-center justify-center rounded-full text-white"
                    style={{ background: 'var(--fill-success)' }}
                  >
                    <Icon name="check" size={28} />
                  </div>
                  <div className="title">登录成功</div>
                  <p className="caption">{status.account.name}</p>
                </div>
              ) : status?.state === 'error' ? (
                <div className="flex flex-col items-center gap-4 py-2">
                  <div
                    className="flex h-14 w-14 items-center justify-center rounded-full text-white"
                    style={{ background: 'var(--fill-danger)' }}
                  >
                    <Icon name="xmark" size={28} />
                  </div>
                  <div className="title">登录失败</div>
                  <p className="caption text-center">{status.error}</p>
                  <div className="flex gap-2">
                    <Button onClick={cancel}>关闭</Button>
                    <Button variant="primary" onClick={begin}>
                      重试
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="glass-soft mb-5 rounded-2xl p-5 text-center">
                    <div className="caption mb-1">你的登录代码</div>
                    <button
                      onClick={copyCode}
                      className="group relative mx-auto block text-3xl font-bold tracking-[0.2em] no-drag"
                      title="点击复制"
                    >
                      {info?.userCode ?? '······'}
                      <span className="ml-1 align-middle text-sm opacity-0 transition-opacity group-hover:opacity-60">
                        {copied ? '✓ 已复制' : '复制'}
                      </span>
                    </button>
                  </div>

                  <div className="mb-6 space-y-2">
                    <Step n={1} text={`打开浏览器访问 ${info?.verificationUri ?? 'microsoft.com/link'}`} />
                    <Step n={2} text="输入上面的代码并登录你的微软账号" />
                    <Step n={3} text="授权 Xbox Live，等待自动完成" />
                  </div>

                  {status?.state === 'waiting' && (
                    <p className="mb-4 text-center text-[12px] opacity-60">
                      等待授权… 已等待 {status.elapsed}s / {status.expiresIn}s
                    </p>
                  )}

                  <div className="flex gap-2">
                    <Button className="flex-1" onClick={cancel}>
                      取消
                    </Button>
                    <Button
                      variant="primary"
                      className="flex-1"
                      icon="link"
                      onClick={() => info && window.api.shell.openExternal(info.verificationUri)}
                    >
                      打开浏览器
                    </Button>
                  </div>
                </>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Offline account sheet */}
      <AnimatePresence>
        {offlineOpen && (
          <motion.div
            className="absolute inset-0 z-50 flex items-center justify-center p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="absolute inset-0"
              style={{ background: 'var(--scrim)' }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOfflineOpen(false)}
            />
            <motion.div
              className="glass-strong relative z-10 w-full max-w-sm rounded-[32px] p-7"
              initial={{ opacity: 0, scale: 0.92, y: 24 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: 16 }}
              transition={{ type: 'spring', bounce: 0.2, duration: 0.45 }}
            >
              <h2 className="title mb-1">离线账号</h2>
              <p className="caption mb-5">无需登录，仅用于单机游戏（无法进入正版服务器）</p>
              {offlineError && (
                <div
                  className="mb-4 rounded-xl p-3 text-[13px]"
                  style={{ background: 'rgba(255,69,58,0.14)', color: 'var(--fill-danger)' }}
                >
                  {offlineError}
                </div>
              )}
              <div className="caption mb-2">玩家名</div>
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
                placeholder="例如 Steve"
                className="input mb-5 w-full"
              />
              <div className="flex gap-2">
                <Button className="flex-1" onClick={() => setOfflineOpen(false)}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  className="flex-1"
                  disabled={!offlineName.trim()}
                  onClick={() => void addOffline()}
                >
                  创建
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Yggdrasil (LittleSkin / 自定义第三方) login sheet */}
      <AnimatePresence>
        {yggdrasilOpen && (
          <motion.div
            className="absolute inset-0 z-50 flex items-center justify-center p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="absolute inset-0"
              style={{ background: 'var(--scrim)' }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setYggdrasilOpen(false)}
            />
            <motion.div
              className="glass-strong relative z-10 w-full max-w-sm rounded-[32px] p-7"
              initial={{ opacity: 0, scale: 0.92, y: 24 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: 16 }}
              transition={{ type: 'spring', bounce: 0.2, duration: 0.45 }}
            >
              <h2 className="title mb-1">第三方账号登录</h2>
              <p className="caption mb-5">LittleSkin 或自定义 Yggdrasil 认证服务器</p>
              {yggError && (
                <div
                  className="mb-4 rounded-xl p-3 text-[13px]"
                  style={{ background: 'rgba(255,69,58,0.14)', color: 'var(--fill-danger)' }}
                >
                  {yggError}
                </div>
              )}

              <Segmented
                options={[
                  { value: 'littleskin', label: 'LittleSkin' },
                  { value: 'chanmao', label: '馋猫认证中心' },
                  { value: 'custom', label: '自定义' }
                ]}
                value={yggPreset}
                onChange={chooseYggPreset}
              />

              <div className="caption mb-2 mt-4">认证服务器</div>
              <input
                value={yggServer}
                onChange={(e) => {
                  setYggServer(e.target.value)
                  setYggError(null)
                }}
                disabled={yggPreset !== 'custom'}
                placeholder="https://example.com/api/yggdrasil"
                className="input mb-3 w-full"
              />

              <div className="caption mb-2">邮箱 / 用户名</div>
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

              <div className="caption mb-2">密码</div>
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
                className="input mb-5 w-full"
              />

              <div className="flex gap-2">
                <Button className="flex-1" onClick={() => setYggdrasilOpen(false)}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  className="flex-1"
                  disabled={yggLoading || !yggEmail.trim() || !yggPassword.trim()}
                  onClick={() => void addYggdrasil()}
                >
                  {yggLoading ? '登录中…' : '登录'}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
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

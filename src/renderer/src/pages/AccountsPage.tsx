import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { AuthStatus, DeviceCodeInfo } from '@shared/types'
import { useApp } from '../store'
import { Avatar, Button, GlassCard, Icon, Segmented, Spinner } from '../components/ui'

/** 账号页视图状态：账号列表，或某一种登录整页。 */
type AccountView = 'list' | 'microsoft' | 'yggdrasil' | 'offline'

const LITTLESKIN_SERVER = 'https://littleskin.cn/api/yggdrasil'
const CHANMAO_SERVER = 'https://skin.johnnyblog.top/api/yggdrasil'

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

const YGG_PRESETS: Array<{ value: YggPreset; server: string }> = [
  { value: 'littleskin', server: LITTLESKIN_SERVER },
  { value: 'chanmao', server: CHANMAO_SERVER }
]

export function AccountsPage(): JSX.Element {
  const { accounts, selectedAccount, selectAccount, removeAccount, reloadAccounts, settings } = useApp()
  const [view, setView] = useState<AccountView>('list')
  const [info, setInfo] = useState<DeviceCodeInfo | null>(null)
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [copied, setCopied] = useState(false)
  const started = useRef(false)

  const [offlineName, setOfflineName] = useState('')
  const [offlineError, setOfflineError] = useState<string | null>(null)

  const [yggPreset, setYggPreset] = useState<YggPreset>('littleskin')
  const [yggServer, setYggServer] = useState(LITTLESKIN_SERVER)
  const [yggEmail, setYggEmail] = useState('')
  const [yggPassword, setYggPassword] = useState('')
  const [yggLoading, setYggLoading] = useState(false)
  const [yggError, setYggError] = useState<string | null>(null)
  // 弹窗生命周期守卫：关闭/取消后置 false，防止登录的异步结果在弹窗关闭后
  // 继续 setState（React 对已卸载/隐藏组件的 setState 会造成无响应）。
  const yggAlive = useRef(false)

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
    setView('list')
    setYggError(null)
  }, [])

  const chooseYggPreset = (v: YggPreset): void => {
    setYggPreset(v)
    setYggError(null)
    const preset = YGG_PRESETS.find((p) => p.value === v)
    if (preset) setYggServer(preset.server)
  }

  const addYggdrasil = async (): Promise<void> => {
    if (!yggEmail.trim() || !yggPassword.trim()) return
    setYggError(null)
    setYggLoading(true)
    try {
      // 统一 10s 保护性超时：即使认证服务器挂起，这里也不会永久 pending。
      await withTimeout(
        window.api.accounts.addYggdrasil(yggServer, yggEmail.trim(), yggPassword),
        YGG_LOGIN_TIMEOUT_MS,
        '认证服务器连接超时，请检查地址后重试'
      )
      // 关闭期间守卫会被置 false，这里直接放弃处理，避免离开页面后再 setState。
      if (!yggAlive.current) return
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

  return (
    <div className="flex h-full flex-col gap-5">
      {/* 账号列表 ⇄ 登录整页：两态视图切换，按 key 区分并做淡入 + 轻微 y/scale 过渡 */}
      <AnimatePresence mode="wait" initial={false}>
      {view === 'list' && (
        <motion.div
          key="list"
          className="flex min-h-0 flex-1 flex-col gap-5"
          initial={{ opacity: 0, y: 10, scale: 0.995 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.995, transition: { duration: 0.15 } }}
          transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
        >
      <div className="flex items-end justify-between">
        <div>
          <h1 className="display">账号</h1>
          <p className="caption mt-1">使用微软账号登录，无需申请开发者应用</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setView('offline')}>离线账号</Button>
          <Button
            onClick={openYgg}
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
              <Button icon="plus" onClick={() => setView('offline')}>
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
        </motion.div>
      )}

      {view === 'microsoft' && (
        <motion.div
          key="microsoft"
          className="flex min-h-0 flex-1 flex-col gap-5"
          initial={{ opacity: 0, y: 10, scale: 0.995 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.995, transition: { duration: 0.15 } }}
          transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
        >
          {/* 页头 */}
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="display">登录微软账号</h2>
              <p className="caption mt-1">设备代码登录 · 无需申请开发者权限</p>
            </div>
            <Button icon="chevronLeft" onClick={cancel}>
              返回
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
                  <div className="title">登录成功</div>
                  <p className="caption">{status.account.name}</p>
                  <p className="caption mt-1 opacity-60">即将返回账号列表…</p>
                </GlassCard>
              ) : (
                <>
                  <GlassCard className="p-6">
                    <div className="mb-5">
                      <h3 className="headline">设备代码</h3>
                      <p className="caption mt-0.5">在你的浏览器中打开链接并输入下面的代码</p>
                    </div>
                    <div className="glass-soft rounded-2xl p-6 text-center">
                      <div className="caption mb-1">你的登录代码</div>
                      {info ? (
                        <button
                          onClick={copyCode}
                          className="group relative mx-auto block text-4xl font-bold tracking-[0.2em] no-drag"
                          title="点击复制"
                        >
                          {info.userCode}
                          <span className="ml-1 align-middle text-sm opacity-0 transition-opacity group-hover:opacity-60">
                            {copied ? '✓ 已复制' : '复制'}
                          </span>
                        </button>
                      ) : (
                        <div className="flex items-center justify-center gap-2 py-1 text-[13px] opacity-70">
                          <Spinner size={16} />
                          <span>正在获取登录代码…</span>
                        </div>
                      )}
                    </div>
                  </GlassCard>

                  <GlassCard className="p-6">
                    <div className="mb-4">
                      <h3 className="headline">操作步骤</h3>
                      <p className="caption mt-0.5">完成下面三步即可自动授权并登录</p>
                    </div>
                    <div className="space-y-2">
                      <Step n={1} text={`打开浏览器访问 ${info?.verificationUri ?? 'microsoft.com/link'}`} />
                      <Step n={2} text="输入上面的代码并登录你的微软账号" />
                      <Step n={3} text="授权 Xbox Live，等待自动完成" />
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
                  <span>登录失败：{status.error}</span>
                </div>
              )}

              {status?.state === 'waiting' && (
                <div
                  className="flex items-center gap-3 rounded-xl p-4 text-[13px]"
                  style={{ background: 'var(--fill-secondary)' }}
                >
                  <Spinner size={20} />
                  <span className="caption">等待授权… 已等待 {status.elapsed}s / {status.expiresIn}s</span>
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
                取消
              </Button>
              {status?.state === 'error' ? (
                <Button variant="primary" size="lg" className="min-w-[176px]" onClick={begin}>
                  重试
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="lg"
                  className="min-w-[176px]"
                  icon="link"
                  onClick={() => info && window.api.shell.openExternal(info.verificationUri)}
                >
                  打开浏览器
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
          exit={{ opacity: 0, y: -8, scale: 0.995, transition: { duration: 0.15 } }}
          transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
        >
          {/* 页头 */}
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="display">第三方账号登录</h2>
              <p className="caption mt-1">LittleSkin 或自定义 Yggdrasil 认证服务器</p>
            </div>
            <Button icon="chevronLeft" onClick={closeYgg}>
              返回
            </Button>
          </div>

          {/* 主内容区（可滚动） */}
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="flex max-w-3xl flex-col gap-5 pb-6">
              <GlassCard className="p-6">
                <div className="mb-5">
                  <h3 className="headline">认证服务器</h3>
                  <p className="caption mt-0.5">选择预设或填写自定义 Yggdrasil 兼容地址</p>
                </div>
                <Segmented
                  options={[
                    { value: 'littleskin', label: 'LittleSkin' },
                    { value: 'chanmao', label: '馋猫认证中心' },
                    { value: 'custom', label: '自定义' }
                  ]}
                  value={yggPreset}
                  onChange={chooseYggPreset}
                />
                <div className="caption mb-2 mt-4">认证服务器地址</div>
                <input
                  value={yggServer}
                  onChange={(e) => {
                    setYggServer(e.target.value)
                    setYggError(null)
                  }}
                  disabled={yggPreset !== 'custom'}
                  placeholder="https://example.com/api/yggdrasil"
                  className="input w-full"
                />
              </GlassCard>

              <GlassCard className="p-6">
                <div className="mb-5">
                  <h3 className="headline">账号信息</h3>
                  <p className="caption mt-0.5">输入认证服务器发放给你的登录凭据</p>
                </div>
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
                取消
              </Button>
              <Button
                variant="primary"
                size="lg"
                className="min-w-[176px]"
                disabled={yggLoading || !yggEmail.trim() || !yggPassword.trim()}
                onClick={() => void addYggdrasil()}
              >
                {yggLoading ? '登录中…' : '登录'}
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
          exit={{ opacity: 0, y: -8, scale: 0.995, transition: { duration: 0.15 } }}
          transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
        >
          {/* 页头 */}
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="display">离线账号</h2>
              <p className="caption mt-1">无需登录，仅用于单机游戏（无法进入正版服务器）</p>
            </div>
            <Button icon="chevronLeft" onClick={() => setView('list')}>
              返回
            </Button>
          </div>

          {/* 主内容区（可滚动） */}
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="flex max-w-3xl flex-col gap-5 pb-6">
              <GlassCard className="p-6">
                <div className="mb-5">
                  <h3 className="headline">玩家名</h3>
                  <p className="caption mt-0.5">输入一个仅用于单机离线模式的玩家名</p>
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
                  placeholder="例如 Steve"
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
                取消
              </Button>
              <Button
                variant="primary"
                size="lg"
                className="min-w-[176px]"
                disabled={!offlineName.trim()}
                onClick={() => void addOffline()}
              >
                创建
              </Button>
            </div>
          </div>
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

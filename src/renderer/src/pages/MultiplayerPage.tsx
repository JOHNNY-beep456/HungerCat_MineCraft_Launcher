import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { MpBinaryStatus, MpLobby, MpPlayer, MpWorld } from '@shared/types'
import { useApp } from '../store'
import { Button, Icon, Select, Spinner } from '../components/ui'
import { MultiplayerLicenseGate, MCTIER_REPO, MCTIER_LICENSE, MCTIER_WEBSITE, MCTIER_ICON } from '../components/MultiplayerLicenseGate'
import {
  MultiplayerSettings,
  BUILTIN_NODES,
  DEFAULT_EASYTier,
  DEFAULT_SIGNALING
} from '../components/MultiplayerSettings'
import { MultiplayerChat } from '../components/MultiplayerChat'
import { MultiplayerVoiceControls } from '../components/MultiplayerVoiceControls'

type View = 'home' | 'settings' | 'form' | 'help'
type FormMode = 'create' | 'join'

/**
 * 「联机」板块。
 *
 * 界面与设置项移植自 MCTier（https://github.com/pmh1314520/MCTier）。
 * 该板块使用 JS 重写，首次进入须先确认 MCTier 的自定义「源码可得 / 非商业许可」，
 * 以避免与本启动器的开源协议产生冲突（详见 MultiplayerLicenseGate）。
 */
export function MultiplayerPage({ onExit }: { onExit?: () => void } = {}): JSX.Element {
  const { t, settings, updateSettings, selectedAccount } = useApp()
  const [view, setView] = useState<View>('home')
  const [formMode, setFormMode] = useState<FormMode>('create')
  const [formError, setFormError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  /** 组网二进制自检结果：未就绪时禁用「创建 / 加入」，并给出准备指引。 */
  const [binStatus, setBinStatus] = useState<MpBinaryStatus | null>(null)
  /** 当前大厅（后端真实状态）。 */
  const [lobby, setLobby] = useState<MpLobby | null>(null)
  /** 大厅成员（含自己）。 */
  const [players, setPlayers] = useState<MpPlayer[]>([])
  /** 已复制的地址（短暂展示对勾）。 */
  const [copied, setCopied] = useState<string | null>(null)

  /** 自己的虚拟域名（仅开启「虚拟域名」时存在）。 */
  const selfDomain = players.find((p) => p.isSelf)?.virtualDomain ?? ''

  const accepted = settings.multiplayerLicenseAcceptedAt > 0

  // 进入板块时做一次二进制自检 + 拉取已有大厅状态。
  useEffect(() => {
    if (!accepted) return
    let alive = true
    void (async () => {
      try {
        const [status, current, members] = await Promise.all([
          window.api.mp.binariesStatus(),
          window.api.mp.getLobby(),
          window.api.mp.getPlayers()
        ])
        if (alive) {
          setBinStatus(status)
          setLobby(current)
          setPlayers(members)
        }
      } catch {
        /* 自检失败不阻塞界面，启动时会再报错 */
      }
    })()
    return () => {
      alive = false
    }
  }, [accepted])

  /**
   * 大厅状态双向同步。
   *
   * 主界面与悬浮窗是两个独立渲染进程：在悬浮窗里点「退出大厅」只改了主进程那份状态，
   * 主界面不会自己知道。这里订阅主进程广播，收到后重新拉取真实状态，并据此做两件事：
   *  1. 退出大厅（lobby 变为 null）时回到主界面，而不是继续停在创建/加入表单上；
   *  2. 组网成功（lobby 变为非 null）时若还停在表单上，自动进入主界面展示大厅信息，
   *     避免「虚拟 IP 分配完了，页面却还留在填表页」。
   */
  useEffect(() => {
    if (!accepted) return
    let alive = true
    const off = window.api.mp.onLobbyChanged(() => {
      void (async () => {
        try {
          const [current, members] = await Promise.all([
            window.api.mp.getLobby(),
            window.api.mp.getPlayers()
          ])
          if (!alive) return
          setLobby(current)
          setPlayers(members)
          if (!current) {
            setBusy(false)
            setSubmitted(false)
            setFormError(null)
            setView((v) => (v === 'form' ? 'home' : v))
          }
        } catch {
          /* 单次同步失败忽略，下次广播会再试 */
        }
      })()
    })
    return () => {
      alive = false
      off()
    }
  }, [accepted])

  /**
   * 表单页的「进入大厅」意图标记。
   *
   * 点「创建/加入」之后要等 EasyTier 分组网并分配虚拟 IP（可能几十秒），期间必须留在
   * 表单页显示进度。用 ref 记住「用户想进大厅」，等主进程广播大厅就绪后由上面的 effect
   * 统一切回主界面，避免把同步逻辑写成两处竞态。
   */
  const wantLobbyRef = useRef(false)

  // 兜底：组网成功但广播因故没送到时，轮询发现已在大厅也应离开表单页。
  useEffect(() => {
    if (view !== 'form' || lobby || !wantLobbyRef.current) return
    let alive = true
    const timer = setInterval(() => {
      void (async () => {
        try {
          const current = await window.api.mp.getLobby()
          if (alive && current) {
            setLobby(current)
            setPlayers(await window.api.mp.getPlayers())
          }
        } catch {
          /* 忽略单次失败 */
        }
      })()
    }, 1500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [view, lobby])

  // 在大厅中时轮询成员列表：P2P 发现是异步的，成员会陆续出现（含各自虚拟 IP）。
  useEffect(() => {
    if (!accepted || !lobby) return
    let alive = true
    const timer = setInterval(() => {
      void (async () => {
        try {
          const members = await window.api.mp.getPlayers()
          if (alive) setPlayers(members)
        } catch {
          /* 忽略单次失败 */
        }
      })()
    }, 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [accepted, lobby])

  /** 复制文本到剪贴板并短暂显示对勾。 */
  const copyText = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(text)
      setTimeout(() => setCopied(null), 1400)
    } catch {
      /* 剪贴板不可用则忽略 */
    }
  }

  // 表单草稿：默认沿用启动器当前账号与已保存的联机配置。
  const [lobbyName, setLobbyName] = useState(settings.multiplayerLobbyName)
  const [lobbyPassword, setLobbyPassword] = useState(settings.multiplayerLobbyPassword)
  const [playerName, setPlayerName] = useState(
    settings.multiplayerPlayerName || selectedAccount?.name || ''
  )
  const [useDomain, setUseDomain] = useState(settings.multiplayerUseDomain)
  const [node, setNode] = useState(
    settings.multiplayerUsePrivateServer ? settings.multiplayerEasytierServer : BUILTIN_NODES[0].address
  )
  const [signaling, setSignaling] = useState(
    settings.multiplayerUsePrivateServer ? settings.multiplayerSignalingServer : DEFAULT_SIGNALING
  )

  const nodeOptions = useMemo(
    () => [
      ...BUILTIN_NODES.map((n) => ({ name: t(n.name), address: n.address })),
      ...(Array.isArray(settings.multiplayerCustomNodes) ? settings.multiplayerCustomNodes : []).map(
        (n) => ({ name: n.name, address: n.address })
      )
    ],
    [settings.multiplayerCustomNodes, t]
  )

  // ESC 返回主界面
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !accepted) return
      setFormError(null)
      setSubmitted(false)
      setView((v) => (v === 'home' ? v : 'home'))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [accepted])

  const openForm = (mode: FormMode): void => {
    setFormMode(mode)
    setFormError(null)
    setSubmitted(false)
    setView('form')
  }

  const openUrl = (url: string): void => {
    void window.api.shell.openExternal(url)
  }

  const submitForm = async (): Promise<void> => {
    const name = lobbyName.trim()
    const pass = lobbyPassword.trim()
    const player = playerName.trim()
    if (name.length < 4 || name.length > 32) {
      setFormError(t('mp.form.errName'))
      return
    }
    if (pass && (pass.length < 8 || pass.length > 32 || !/[a-zA-Z]/.test(pass) || !/[0-9]/.test(pass))) {
      setFormError(t('mp.form.errPassword'))
      return
    }
    if (player.length < 1 || player.length > 8) {
      setFormError(t('mp.form.errPlayer'))
      return
    }
    if (!/^(tcp|udp|ws|wss|txt):\/\/.+$/.test(node.trim())) {
      setFormError(t('mp.form.errNode'))
      return
    }
    if (!/^wss:\/\/.+$/.test(signaling.trim())) {
      setFormError(t('mp.form.errSignaling'))
      return
    }

    // 先保存配置，再调用主进程真实组网。
    await updateSettings({
      multiplayerLobbyName: name,
      multiplayerLobbyPassword: pass,
      multiplayerPlayerName: player,
      multiplayerUseDomain: useDomain,
      multiplayerEasytierServer: node.trim(),
      multiplayerSignalingServer: signaling.trim()
    })

    setBusy(true)
    // 标记「用户想进大厅」：组网成功后由广播 handler 统一离开表单页。
    wantLobbyRef.current = true
    try {
      const playerId = selectedAccount?.id ?? `local-${Date.now()}`
      const params = {
        name,
        password: pass,
        playerName: player,
        playerId,
        serverNode: node.trim(),
        signalingServer: signaling.trim(),
        useDomain
      }
      const created = formMode === 'create'
        ? await window.api.mp.createLobby(params)
        : await window.api.mp.joinLobby(params)

      // 计数落盘：加入次数 / 房主次数。
      await updateSettings({
        multiplayerJoinCount: formMode === 'join' ? settings.multiplayerJoinCount + 1 : settings.multiplayerJoinCount,
        multiplayerHostCount: formMode === 'create' ? settings.multiplayerHostCount + 1 : settings.multiplayerHostCount
      })
      setLobby(created)
      setPlayers(await window.api.mp.getPlayers())
      setFormError(null)
      setSubmitted(true)
      // 组网成功后自动打开悬浮窗，便于游戏时查看大厅状态（与 MCTier 行为一致）。
      void window.api.mp.openMiniWindow()
      // 关键：这里必须离开表单页。以前接口返回后什么都不做，用户就卡在填表页，
      // 完全看不出「虚拟 IP 已经分配好了」。
      wantLobbyRef.current = false
      setView('home')
    } catch (err) {
      wantLobbyRef.current = false
      setSubmitted(false)
      setFormError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /** 退出当前大厅并回到主界面。 */
  const leaveLobby = async (): Promise<void> => {
    // 退出意图优先于「进入大厅」意图：清掉标记，避免广播回来时又切回主界面之外的分支。
    wantLobbyRef.current = false
    setBusy(true)
    try {
      await window.api.mp.leaveLobby()
      await window.api.mp.closeMiniWindow()
      setLobby(null)
      setPlayers([])
      setSubmitted(false)
      setView('home')
    } finally {
      setBusy(false)
    }
  }

  const acceptLicense = (): void => setView('home')

  /**
   * 拒绝许可协议：不做任何确认、不写入任何设置，直接退出「联机」板块。
   * 优先回到启动器主界面；若未提供 onExit（例如 Win10 桌面窗口），则退化为停留在本页。
   */
  const rejectLicense = (): void => {
    if (onExit) onExit()
  }

  return (
    <div className="relative flex h-full flex-col gap-5">
      {/* 未同意许可协议：只显示门禁，其余内容不渲染，避免协议冲突 */}
      <AnimatePresence>
        {!accepted && <MultiplayerLicenseGate onAgree={acceptLicense} onReject={rejectLicense} />}
      </AnimatePresence>

      {accepted && view === 'settings' && <MultiplayerSettings onBack={() => setView('home')} />}

      {accepted && view === 'help' && (
        <>
          <div className="flex items-end justify-between">
            <div>
              <h1 className="display">{t('mp.help.title')}</h1>
              <p className="caption mt-1">{t('mp.help.subtitle')}</p>
            </div>
            <Button icon="chevronLeft" onClick={() => setView('home')}>
              {t('mp.back')}
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="mx-auto max-w-xl space-y-4">
              {[1, 2, 3, 4].map((n) => (
                <div key={n} className="glass rounded-[24px] p-5">
                  <div className="mb-2 flex items-center gap-2.5">
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-bold text-white"
                      style={{ background: 'var(--fill-primary)' }}
                    >
                      {n}
                    </span>
                    <span className="title">{t(`mp.help.step${n}.title`)}</span>
                  </div>
                  <p className="selectable text-[13px] leading-relaxed opacity-85">
                    {t(`mp.help.step${n}.body`)}
                  </p>
                </div>
              ))}

              <div className="glass rounded-[24px] p-5">
                <div className="mb-2 flex items-center gap-2">
                  <Icon name="info" size={16} style={{ color: 'var(--fill-warning, #f0b34a)' }} />
                  <span className="headline">{t('mp.help.note.title')}</span>
                </div>
                <p className="selectable text-[12.5px] leading-relaxed opacity-85">
                  {t('mp.help.note.body')}
                </p>
              </div>
            </div>
          </div>
        </>
      )}

      {accepted && view === 'home' && (
        <>
          <div className="flex items-end justify-between">
            <div>
              <h1 className="display">{t('mp.title')}</h1>
              <p className="caption mt-1">{t('mp.subtitle')}</p>
            </div>
            <span className="chip" style={{ borderColor: 'var(--fill-primary)', color: 'var(--fill-primary)' }}>
              {t('mp.source.badge')}
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="mx-auto flex max-w-xl flex-col items-center gap-5 pt-6">
              <motion.div
                initial={{ scale: 0.85, opacity: 0, rotate: -8 }}
                animate={{ scale: 1, opacity: 1, rotate: 0 }}
                transition={{ delay: 0.05, duration: 0.45, ease: [0.34, 1.56, 0.64, 1] }}
                className="glass flex h-24 w-24 items-center justify-center rounded-[28px] p-3"
              >
                {/* MCTier 官方图标（与客户端主界面一致） */}
                <img
                  src={MCTIER_ICON}
                  alt="MCTier"
                  className="h-full w-full rounded-[18px] object-contain"
                  draggable={false}
                />
              </motion.div>

              <motion.div
                initial={{ y: -12, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.12, duration: 0.4 }}
                className="text-center"
              >
                <div className="title">MCTier</div>
                <div className="caption mt-1">{t('mp.subtitle')}</div>
              </motion.div>

              {/* 按钮组：必须显式建立层叠上下文（translateZ(0)）并抬高 z-index。
                  motion 的初始动画会留下 `transform: none` 的残留取值，
                  会让这里生成 stacking context；而下方没有 transform 的卡片
                  （组网自检 / 大厅信息）在后绘制时就会盖到按钮上方。
                  由于卡片自身是 position:relative，被压住的按钮虽然看得见，
                  却收不到点击（表现为「点击无反应」）。 */}
              <motion.div
                initial={{ y: 16, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.18, duration: 0.4 }}
                style={{ transform: 'translateZ(0)' }}
                className="relative z-20 flex w-full max-w-sm flex-col gap-2.5"
              >
                {lobby ? (
                  <>
                    {/* 「当前大厅」= 唤起大厅悬浮窗（含成员 / 虚拟 IP / 退出大厅），
                        与下方大厅卡片里的「悬浮窗」按钮行为一致。 */}
                    <Button
                      variant="primary"
                      size="lg"
                      icon="box"
                      onClick={() => void window.api.mp.openMiniWindow()}
                    >
                      {t('mp.lobby.current')}
                    </Button>
                    <Button size="lg" icon="stop" variant="danger" disabled={busy} onClick={() => void leaveLobby()}>
                      {t('mp.lobby.leave')}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="primary"
                      size="lg"
                      icon="plus"
                      disabled={busy || binStatus?.ready === false}
                      onClick={() => openForm('create')}
                    >
                      {t('mp.create')}
                    </Button>
                    <Button
                      size="lg"
                      icon="users"
                      disabled={busy || binStatus?.ready === false}
                      onClick={() => openForm('join')}
                    >
                      {t('mp.join')}
                    </Button>
                  </>
                )}
                <Button size="lg" icon="settings" onClick={() => setView('settings')}>
                  {t('mp.settings')}
                </Button>
                <Button size="lg" icon="info" onClick={() => setView('help')}>
                  {t('mp.help')}
                </Button>
              </motion.div>

              {/* 组网内核自检：未就绪时给出明确指引（而非让用户在启动时才碰到报错） */}
              {binStatus && !binStatus.ready && (
                <div className="glass relative z-0 w-full rounded-[24px] p-4">
                  <div className="mb-1.5 flex items-center gap-2">
                    <Icon name="info" size={16} style={{ color: 'var(--fill-danger)' }} />
                    <span className="headline">{t('mp.bin.title')}</span>
                  </div>
                  <p className="selectable text-[12.5px] leading-relaxed opacity-85">{binStatus.reason}</p>
                  <p className="caption selectable mt-2 break-all">{binStatus.dir}</p>
                  <div className="mt-3">
                    <Button size="sm" icon="folder" onClick={() => void window.api.mp.openResourceDir()}>
                      {t('mp.bin.openDir')}
                    </Button>
                  </div>
                </div>
              )}

              {/* 已在大厅：语音 / 浮层控制 + 世界列表 + 聊天 + 成员列表 */}
              {lobby && <MultiplayerVoiceControls />}

              {lobby && (
                <WorldList onCopy={(t) => void copyText(t)} copied={copied} />
              )}

              {lobby && <MultiplayerChat />}

              {lobby && (
                <div className="glass relative z-0 w-full rounded-[24px] p-4">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Icon name="wifi" size={16} style={{ color: 'var(--fill-success)' }} />
                      <span className="headline truncate">{lobby.name}</span>
                      <span className="chip shrink-0">{t('mp.lobby.playerCount', { n: players.length })}</span>
                    </div>
                    <Button size="sm" icon="box" onClick={() => void window.api.mp.openMiniWindow()}>
                      {t('mp.lobby.openMini')}
                    </Button>
                  </div>

                  {/* 自己的虚拟地址 */}
                  <div className="glass-soft mb-2 flex items-center justify-between gap-2 rounded-xl px-3 py-2">
                    <span className="caption selectable truncate">
                      {lobby.virtualIp
                        ? `${t('mp.lobby.myAddress')}：${lobby.virtualIp}:25565`
                        : t('mp.lobby.assigning')}
                    </span>
                    {lobby.virtualIp && (
                      <button
                        className="shrink-0 opacity-70 transition-opacity hover:opacity-100"
                        title={t('mp.set.tools.copy')}
                        onClick={() => void copyText(`${lobby.virtualIp}:25565`)}
                      >
                        <Icon
                          name={copied === `${lobby.virtualIp}:25565` ? 'check' : 'copy'}
                          size={15}
                        />
                      </button>
                    )}
                  </div>

                  {/* 自己的虚拟域名（开启「虚拟域名」时显示，可在 MC 直接连接里使用） */}
                  {selfDomain && (
                    <div className="glass-soft mb-2 flex items-center justify-between gap-2 rounded-xl px-3 py-2">
                      <span className="caption selectable truncate" style={{ color: 'var(--fill-primary)' }}>
                        {t('mp.lobby.myDomain')}：{selfDomain}
                      </span>
                      <button
                        className="shrink-0 opacity-70 transition-opacity hover:opacity-100"
                        title={t('mp.set.tools.copy')}
                        onClick={() => void copyText(selfDomain)}
                      >
                        <Icon name={copied === selfDomain ? 'check' : 'copy'} size={15} />
                      </button>
                    </div>
                  )}

                  {/* 玩家列表 */}
                  <div className="space-y-1.5">
                    {players.map((p) => {
                      const addr = p.virtualIp ? `${p.virtualIp}:25565` : ''
                      return (
                        <div
                          key={p.id}
                          className="glass-soft flex items-center gap-2.5 rounded-xl px-3 py-2"
                        >
                          <span
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-bold text-white"
                            style={{
                              background: p.isSelf ? 'var(--fill-primary)' : 'var(--fill-secondary-hover)'
                            }}
                          >
                            {p.name.charAt(0).toUpperCase()}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-[13px] font-medium">{p.name}</span>
                              {p.isSelf && <span className="chip">{t('mp.mini.me')}</span>}
                            </div>
                            <div className="caption selectable truncate">
                              {addr || t('mp.lobby.assigning')}
                            </div>
                            {p.virtualDomain && (
                              <div className="caption selectable truncate" style={{ color: 'var(--fill-primary)' }}>
                                {p.virtualDomain}
                              </div>
                            )}
                          </div>
                          {addr && (
                            <button
                              className="shrink-0 opacity-70 transition-opacity hover:opacity-100"
                              title={t('mp.set.tools.copy')}
                              onClick={() => void copyText(addr)}
                            >
                              <Icon name={copied === addr ? 'check' : 'copy'} size={15} />
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              <div className="caption mt-1 text-center">{t('mp.clickHint')}</div>

              {/* 功能说明：明确区分「已移植的界面」与「依赖 MCTier 后端的组网」 */}
              <div className="glass mt-2 w-full rounded-[24px] p-4">
                <div className="mb-1.5 flex items-center gap-2">
                  <Icon name="info" size={16} style={{ color: 'var(--fill-warning, #f0b34a)' }} />
                  <span className="headline">{t('mp.notice.title')}</span>
                </div>
                <p className="selectable text-[12.5px] leading-relaxed opacity-80">{t('mp.notice.body')}</p>
              </div>

              {/* 来源与许可标注（MCTier 许可条款第 3 条要求） */}
              <div className="glass w-full rounded-[24px] p-4">
                <div className="mb-1.5 flex items-center gap-2">
                  <Icon name="globe" size={16} />
                  <span className="headline">{t('mp.source.badge')}</span>
                </div>
                <p className="selectable text-[12.5px] leading-relaxed opacity-80">{t('mp.source.line')}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" icon="link" onClick={() => openUrl(MCTIER_REPO)}>
                    {t('mp.openSource')}
                  </Button>
                  <Button size="sm" icon="link" onClick={() => openUrl(MCTIER_LICENSE)}>
                    {t('mp.openLicense')}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {accepted && view === 'form' && (
        <>
          <div className="flex items-end justify-between">
            <div>
              <h1 className="display">
                {formMode === 'create' ? t('mp.form.createTitle') : t('mp.form.joinTitle')}
              </h1>
              <p className="caption mt-1">{t('mp.subtitle')}</p>
            </div>
            <Button icon="chevronLeft" onClick={() => setView('home')}>
              {t('mp.back')}
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="glass mx-auto max-w-xl space-y-4 rounded-[24px] p-6">
              <FormRow label={t('mp.form.lobbyName')}>
                <input
                  className="mp-input"
                  value={lobbyName}
                  maxLength={32}
                  placeholder={t('mp.form.lobbyNamePh')}
                  onChange={(e) => setLobbyName(e.target.value)}
                />
              </FormRow>

              <FormRow label={t('mp.form.lobbyPassword')}>
                <input
                  className="mp-input"
                  type="password"
                  value={lobbyPassword}
                  maxLength={32}
                  placeholder={t('mp.form.lobbyPasswordPh')}
                  onChange={(e) => setLobbyPassword(e.target.value)}
                />
              </FormRow>

              <FormRow label={t('mp.form.playerName')}>
                <input
                  className="mp-input"
                  value={playerName}
                  maxLength={8}
                  placeholder={t('mp.form.playerNamePh')}
                  onChange={(e) => setPlayerName(e.target.value)}
                />
              </FormRow>

              <FormRow label={t('mp.form.node')}>
                <Select
                  value={node}
                  onChange={setNode}
                  options={nodeOptions.map((n) => ({
                    value: n.address,
                    label: `${n.name} · ${n.address}`
                  }))}
                />
              </FormRow>

              <FormRow label={t('mp.form.signaling')}>
                <input
                  className="mp-input selectable"
                  value={signaling}
                  placeholder={DEFAULT_SIGNALING}
                  onChange={(e) => setSignaling(e.target.value)}
                />
              </FormRow>

              <div className="flex items-center gap-3 py-1">
                <div className="flex-1">
                  <div className="text-[13.5px] font-medium">{t('mp.form.useDomain')}</div>
                </div>
                <button
                  className="glass-soft no-drag rounded-xl px-3 py-1.5 text-[12.5px]"
                  style={{
                    color: useDomain ? 'var(--fill-primary)' : undefined,
                    borderColor: useDomain ? 'var(--fill-primary)' : undefined
                  }}
                  onClick={() => setUseDomain((v) => !v)}
                >
                  {useDomain ? 'ON' : 'OFF'}
                </button>
              </div>

              {formError && (
                <div className="text-[12.5px]" style={{ color: 'var(--fill-danger, #e5484d)' }}>
                  {formError}
                </div>
              )}

              {/* 组网需要等 EasyTier 分配虚拟 IP（最长 60s），必须给出进度反馈，
                  否则用户会以为「点了没反应」。 */}
              {busy && !formError && (
                <div className="flex items-center gap-2.5 rounded-2xl p-3" style={{ background: 'var(--fill-secondary)' }}>
                  <Spinner size={16} />
                  <span className="text-[12.5px] opacity-85">
                    {formMode === 'create' ? t('mp.form.creating') : t('mp.form.joining')}
                  </span>
                </div>
              )}

              {submitted && (
                <div
                  className="rounded-2xl p-3 text-[12.5px] leading-relaxed"
                  style={{ background: 'var(--fill-success-soft, rgba(95,211,154,0.14))', color: 'var(--fill-success, #5fd39a)' }}
                >
                  {t('mp.form.submitted')}
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <Button
                  className="flex-1"
                  disabled={busy}
                  onClick={() => {
                    setSubmitted(false)
                    setView('home')
                  }}
                >
                  {t('mp.form.cancel')}
                </Button>
                <Button
                  variant="primary"
                  className="flex-1"
                  icon="check"
                  disabled={busy}
                  onClick={() => void submitForm()}
                >
                  {busy
                    ? formMode === 'create'
                      ? t('mp.form.submitCreating')
                      : t('mp.form.submitJoining')
                    : formMode === 'create'
                      ? t('mp.form.submitCreate')
                      : t('mp.form.submitJoin')}
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function FormRow({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <div className="mb-1.5 text-[13px] font-medium">{label}</div>
      {children}
    </div>
  )
}

/**
 * 「世界列表」卡片：展示大厅内探测到的 Minecraft 世界，并支持手动直连 / 自动注入。
 *
 * 这是「能看到成员名字、游戏里却连不上」的界面侧解法：
 *   - 自动注入开启时，世界会直接出现在 MC 的「局域网」列表里，点一下即可进；
 *   - 关闭自动注入时，可复制 `虚拟IP:端口` 手动在「直接连接」里输入。
 */
function WorldList({ onCopy, copied }: { onCopy: (text: string) => void; copied: string | null }): JSX.Element {
  const { t } = useApp()
  const [worlds, setWorlds] = useState<MpWorld[]>([])
  const [port, setPort] = useState(25565)
  const [autoLan, setAutoLan] = useState(true)
  const [scanning, setScanning] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [p, auto] = await Promise.all([window.api.mp.getWorldPort(), window.api.mp.getAutoLan()])
        if (alive) {
          setPort(p)
          setAutoLan(auto)
        }
      } catch {
        /* 忽略 */
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // 每 4 秒拉一次扫描结果（主进程每 8 秒自行扫描，这里只取快照）。
  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      try {
        const list = await window.api.mp.getWorlds()
        if (alive) setWorlds(list)
      } catch {
        /* 忽略单次失败 */
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 4000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  const rescan = async (): Promise<void> => {
    setScanning(true)
    try {
      setWorlds(await window.api.mp.scanWorlds())
    } catch {
      /* 忽略 */
    } finally {
      setScanning(false)
    }
  }

  return (
    <div className="glass relative z-0 w-full rounded-[24px] p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon name="box" size={16} style={{ color: 'var(--fill-primary)' }} />
          <span className="headline">{t('mp.world.title')}</span>
        </div>
        <Button size="sm" icon="refresh" disabled={scanning} onClick={() => void rescan()}>
          {scanning ? t('mp.world.scanning') : t('mp.world.rescan')}
        </Button>
      </div>

      {/* 自动注入开关：开启后世界直接出现在 MC 局域网列表 */}
      <div className="glass-soft mb-2 flex items-center justify-between gap-2 rounded-xl px-3 py-2">
        <div className="min-w-0">
          <div className="text-[12.5px] font-medium">{t('mp.world.autoLan')}</div>
          <div className="caption">{t('mp.world.autoLanDesc')}</div>
        </div>
        <button
          className="glass-soft no-drag shrink-0 rounded-xl px-3 py-1.5 text-[12.5px]"
          style={{ color: autoLan ? 'var(--fill-primary)' : undefined, borderColor: autoLan ? 'var(--fill-primary)' : undefined }}
          onClick={() => {
            const next = !autoLan
            setAutoLan(next)
            void window.api.mp.setAutoLan(next)
          }}
        >
          {autoLan ? 'ON' : 'OFF'}
        </button>
      </div>

      {/* 世界端口：MC 默认 25565，「对局域网开放」常是随机端口。
          现在主进程会自动探测常见端口，这里只在非常规端口时才需手动指定。 */}
      <div className="glass-soft mb-1 flex items-center justify-between gap-2 rounded-xl px-3 py-2">
        <span className="caption shrink-0">{t('mp.world.port')}</span>
        <input
          className="mp-input selectable no-drag"
          style={{ width: 100 }}
          value={port}
          onChange={(e) => setPort(Number(e.target.value.replace(/\D/g, '')) || 0)}
          onBlur={() => {
            if (port > 0) {
              // 主进程会立刻按新端口重扫并回传最新世界列表，这里直接刷新界面，
              // 让「虚拟 IP:端口」即时更新（不再等 8 秒轮询）。
              void window.api.mp.setWorldPort(port).then((list) => {
                if (Array.isArray(list)) setWorlds(list)
              })
            }
          }}
        />
      </div>
      <p className="caption mb-2 px-1">{t('mp.world.portHint')}</p>

      {worlds.length === 0 ? (
        <div className="caption py-2 text-center">{t('mp.world.empty')}</div>
      ) : (
        <div className="space-y-1.5">
          {worlds.map((w) => {
            // 可连接地址优先用本地代理口：--no-tun 下虚拟 IP 没有系统路由，
            // 直接连 `虚拟IP:端口` 必然失败；复制代理口才能真正进世界。
            const addr =
              w.connectPort != null
                ? `${w.connectHost ?? '127.0.0.1'}:${w.connectPort}`
                : `${w.ip}:${w.port}`
            return (
              <div key={`${w.ip}:${w.port}`} className="glass-soft flex items-center gap-2.5 rounded-xl px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{w.motd || addr}</div>
                  <div className="caption selectable truncate">
                    {addr}
                    {w.version ? ` · ${w.version}` : ''}
                    {w.players.max > 0 ? ` · ${w.players.online}/${w.players.max}` : ''}
                    {` · ${w.latencyMs}ms`}
                  </div>
                </div>
                <button
                  className="shrink-0 opacity-70 transition-opacity hover:opacity-100"
                  title={t('mp.set.tools.copy')}
                  onClick={() => onCopy(addr)}
                >
                  <Icon name={copied === addr ? 'check' : 'copy'} size={15} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

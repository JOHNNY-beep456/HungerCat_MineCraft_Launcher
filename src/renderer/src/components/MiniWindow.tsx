import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { MpMiniState } from '@shared/types'
import { useApp } from '../store'
import { Button, Icon } from './ui'
import { MultiplayerChat } from './MultiplayerChat'
import { VoiceControls } from './VoiceControls'

/** 悬浮窗宽度（固定）。 */
const WIN_WIDTH = 300
/** 折叠态高度：仅容下标题栏。 */
const COLLAPSED_HEIGHT = 56
/** 标题栏高度（与下方 px-3 py-2.5 + 两行文字保持一致），用于换算内容区可用高度。 */
const HEADER_HEIGHT = 52
/** 展开态高度上下限：下限保证基本可读，上限避免超出屏幕。 */
const MIN_EXPANDED_HEIGHT = 320
const MAX_EXPANDED_HEIGHT = 760

/** 把目标高度夹到合法区间并取整。 */
function clampHeight(h: number): number {
  return Math.max(MIN_EXPANDED_HEIGHT, Math.min(MAX_EXPANDED_HEIGHT, Math.round(h)))
}

/**
 * 大厅悬浮窗（类似 MCTier 的迷你窗）。
 *
 * 独立窗口，无边框 + 置顶 + 可拖拽，方便游戏时随时查看大厅人数与每个人的虚拟 IP。
 * 顶部区域自己实现拖拽（`-webkit-app-region: drag`），交互控件加 `no-drag`。
 */
export function MiniWindow(): JSX.Element {
  const { t } = useApp()
  const [state, setState] = useState<MpMiniState | null>(null)
  /** 折叠态：只留一条标题栏，节省屏幕空间。 */
  const [collapsed, setCollapsed] = useState(false)
  const [copiedIp, setCopiedIp] = useState<string | null>(null)
  /** 退出大厅进行中：置灰按钮，避免连点重复调用。 */
  const [leaving, setLeaving] = useState(false)
  /** 麦克风开关状态（主进程持有，这里镜像展示）。 */
  const [micEnabled, setMicEnabled] = useState(false)
  /** 内容区 DOM 引用：用于按实际内容高度自适应窗口高度。 */
  const bodyRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.mp.getMicEnabled().then((v) => {
      if (alive) setMicEnabled(v)
    })
    const off = window.api.mp.onMicChanged((v) => setMicEnabled(v))
    return () => {
      alive = false
      off()
    }
  }, [])

  useEffect(() => {
    let alive = true
    void window.api.mp.miniState().then((s) => {
      if (alive) setState(s)
    })
    const off = window.api.mp.onMiniState((s) => setState(s))
    return () => {
      alive = false
      off()
    }
  }, [])

  const inLobby = !!state?.lobby

  /**
   * 兜底轮询：成员加入/离开主要靠主进程推送，但推送可能在「窗口刚创建、渲染进程繁忙、
   * 或广播恰好错过」时丢失。这里按 2 秒拉一次快照，保证成员列表一定会自动刷新，
   * 不依赖单次推送必达（主界面 MultiplayerPage 同样有此兜底）。
   */
  useEffect(() => {
    if (!inLobby) return
    let alive = true
    const timer = setInterval(() => {
      void window.api.mp
        .miniState()
        .then((s) => {
          if (alive) setState(s)
        })
        .catch(() => undefined)
    }, 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [inLobby])

  /**
   * 退出大厅。
   *
   * 只调用 leaveLobby 是「假退出」的来源：它确实停了组网，但本窗口不会自己刷新，
   * 主界面也收不到通知。现在改成：
   *  1. 先置忙，避免连点；
   *  2. 等主进程真正清理完（leaveLobby 返回时状态已是 idle）；
   *  3. 主动拉一次快照，把界面刷成「未加入大厅」；
   *  4. 主界面不在时才关闭本窗口——主界面还在的话，用户很可能要接着创建/加入，
   *     直接关掉悬浮窗反而突兀。
   */
  const leaveLobby = async (): Promise<void> => {
    if (leaving) return
    setLeaving(true)
    try {
      await window.api.mp.leaveLobby()
      setState(await window.api.mp.miniState())
      const hasMain = await window.api.mp.hasMainWindow()
      if (!hasMain) await window.api.mp.closeMiniWindow()
    } finally {
      setLeaving(false)
    }
  }

  // 折叠时把窗口高度收窄（宽度保持不变），展开时恢复。
  //
  // 展开高度不再写死：内容（地址卡 + 成员列表 + 聊天 + 语音控制条 + 退出按钮）
  // 会随成员数量与虚拟域名开关变化，固定高度必然「要么留白、要么截断」。
  // 这里按实测内容高度自适应，并夹在 [MIN, MAX] 之间；超出上限时由内容区
  // 自己的滚动兜底（见下方 overflow-y-auto），保证任何情况下都够看、够点。
  useEffect(() => {
    if (collapsed) {
      void window.api.mp.miniResize(WIN_WIDTH, COLLAPSED_HEIGHT)
      return
    }
    const el = bodyRef.current
    if (!el) return
    // 高度 = 标题栏 + 内容自然高度；scrollHeight 已包含内边距。
    // 用 rAF 等一帧再测：成员列表 / 域名行是在本次 state 更新后才渲染出来的，
    // 立刻测量会拿到旧高度，导致窗口偏短（这正是「内容显示不全」的成因之一）。
    let raf = 0
    const measure = (): void => {
      const h = clampHeight(HEADER_HEIGHT + el.scrollHeight)
      void window.api.mp.miniResize(WIN_WIDTH, h)
    }
    raf = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(raf)
    // 依赖用 state?.players?.length（而非下面的 players）：players 在本行之后才声明。
  }, [collapsed, state, state?.players?.length])


  const lobby = state?.lobby ?? null
  const players = state?.players ?? []
  // 人数 = 自己 + 其他人；后端 players 已含自己（isSelf 标记）。
  const count = players.length
  /** 自己的虚拟域名（仅开启「虚拟域名」时存在）。 */
  const selfDomain = players.find((p) => p.isSelf)?.virtualDomain ?? ''

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedIp(text)
      setTimeout(() => setCopiedIp(null), 1400)
    } catch {
      /* 剪贴板不可用则忽略 */
    }
  }

  return (
    <div
      className="flex h-screen w-screen flex-col overflow-hidden rounded-[16px]"
      // 悬浮窗是半透明无边框窗，必须自带不透明底：透明窗口里没有壁纸层，
      // 而 --surface-strong / --glass-bg 依赖 data-skin / data-theme 才被赋值，
      // 悬浮窗窗口根节点上二者都没有，直接用会退化成「半透明叠半透明」的看不清。
      style={{
        background: 'var(--glass-bg-strong, rgba(28, 28, 38, 0.96))',
        color: 'var(--text-primary)'
      }}
    >
      {/* 拖拽区 + 标题栏 */}
      <div
        className="flex shrink-0 items-center gap-2 px-3 py-2.5"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <Icon name="wifi" size={15} style={{ color: 'var(--fill-success)' }} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-semibold leading-tight">
            {lobby?.name ?? t('mp.mini.noLobby')}
          </div>
          <div className="caption leading-tight">
            {count > 0 ? t('mp.mini.count', { n: count }) : t('mp.mini.idle')}
          </div>
        </div>
        <button
          className="no-drag opacity-70 transition-opacity hover:opacity-100"
          title={micEnabled ? t('mp.voice.micOn') : t('mp.voice.micOff')}
          style={{ color: micEnabled ? 'var(--fill-success, #5fd39a)' : undefined }}
          onClick={() => void window.api.mp.setMicEnabled(!micEnabled)}
        >
          <Icon name="mic" size={15} />
        </button>
        <button
          className="no-drag opacity-70 transition-opacity hover:opacity-100"
          title={collapsed ? t('mp.mini.expand') : t('mp.mini.collapse')}
          onClick={() => setCollapsed((v) => !v)}
        >
          <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={15} />
        </button>
        <button
          className="no-drag opacity-70 transition-opacity hover:opacity-100"
          title={t('mp.mini.close')}
          onClick={() => void window.api.mp.closeMiniWindow()}
        >
          <Icon name="xmark" size={15} />
        </button>
      </div>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            ref={bodyRef}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            // 内容区整体可滚动：窗口高度已按内容自适应，但当内容超出屏幕上限
            // （MAX_EXPANDED_HEIGHT）时，这里负责让「退出大厅」等底部控件仍可达，
            // 而不是被 overflow-hidden 直接切掉。
            style={{ overflowY: 'auto', overflowX: 'hidden' }}
            className="flex min-h-0 flex-1 flex-col"
          >
            {!lobby ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
                <Icon name="globe" size={26} className="opacity-40" />
                <span className="caption">{t('mp.mini.empty')}</span>
              </div>
            ) : (
              <>
                {/* 自己的虚拟地址 */}
                <div className="shrink-0 px-3 pb-2">
                  <div className="glass-soft rounded-xl p-2.5">
                    <div className="caption mb-1">{t('mp.mini.myAddress')}</div>
                    <div className="flex items-center gap-2">
                      <span className="selectable flex-1 truncate text-[12.5px] font-medium">
                        {lobby.virtualIp ? `${lobby.virtualIp}:25565` : t('mp.mini.assigning')}
                      </span>
                      {lobby.virtualIp && (
                        <button
                          className="no-drag opacity-70 transition-opacity hover:opacity-100"
                          title={t('mp.set.tools.copy')}
                          onClick={() => void copy(`${lobby.virtualIp}:25565`)}
                        >
                          <Icon name={copiedIp === `${lobby.virtualIp}:25565` ? 'check' : 'copy'} size={14} />
                        </button>
                      )}
                    </div>

                    {/* 虚拟域名：开启后可直接在 MC「直接连接」里用域名进入 */}
                    {selfDomain && (
                      <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--divider)' }}>
                        <div className="mb-1 flex items-center gap-1.5">
                          <Icon name="globe" size={12} style={{ color: 'var(--fill-primary)' }} />
                          <span className="caption">{t('mp.mini.domain')}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="selectable flex-1 truncate text-[12.5px] font-medium">
                            {selfDomain}
                          </span>
                          <button
                            className="no-drag opacity-70 transition-opacity hover:opacity-100"
                            title={t('mp.set.tools.copy')}
                            onClick={() => void copy(selfDomain)}
                          >
                            <Icon name={copiedIp === selfDomain ? 'check' : 'copy'} size={14} />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* 玩家列表 */}
                <div className="caption shrink-0 px-3 pb-1">
                  {t('mp.mini.players')} ({count})
                </div>
                {/* 玩家列表：不再自行滚动 / 不再 flex-1 撑高。
                    成员多时按内容自然增高，由外层内容区统一滚动；否则内层滚动会
                    把高度压成 0（flex 收缩），反而看不到成员。 */}
                <div className="shrink-0 space-y-1.5 px-3 pb-3">
                  {players.map((p) => {
                    const addr = p.virtualIp ? `${p.virtualIp}:25565` : ''
                    return (
                      <div key={p.id} className="glass-soft flex items-center gap-2 rounded-xl px-2.5 py-2">
                        <span
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
                          style={{ background: p.isSelf ? 'var(--fill-primary)' : 'var(--fill-secondary-hover)' }}
                        >
                          {p.name.charAt(0).toUpperCase()}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-[12px] font-medium">{p.name}</span>
                            {p.isSelf && <span className="chip">{t('mp.mini.me')}</span>}
                          </div>
                          <div className="caption selectable truncate">
                            {addr || t('mp.mini.assigning')}
                          </div>
                          {p.virtualDomain && (
                            <div className="caption selectable truncate" style={{ color: 'var(--fill-primary)' }}>
                              {p.virtualDomain}
                            </div>
                          )}
                        </div>
                        {addr && (
                          <button
                            className="no-drag shrink-0 opacity-70 transition-opacity hover:opacity-100"
                            title={t('mp.set.tools.copy')}
                            onClick={() => void copy(addr)}
                          >
                            <Icon name={copiedIp === addr ? 'check' : 'copy'} size={14} />
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>

                {/* 聊天：悬浮窗内也能收发（消息流与主界面共用同一份） */}
                <div className="shrink-0 px-3 pb-2 [&_.headline]:text-[12px] [&_.max-h-64]:max-h-32">
                  <MultiplayerChat />
                </div>

                {/* 语音与浮层：麦克风 / 全局静音 / 变声器 / HUD 浮层 / 消息弹幕。
                    与主界面同一套共享状态，游戏时无需切回主窗口即可调节。
                    位置按设计置于「退出大厅」上方。 */}
                <div className="shrink-0 px-3 pb-2">
                  <div className="glass-soft rounded-xl p-2.5">
                    <div className="mb-2 flex items-center gap-1.5">
                      <Icon name="mic" size={13} style={{ color: 'var(--fill-primary)' }} />
                      <span className="text-[12px] font-semibold">{t('mp.voice.title')}</span>
                    </div>
                    <VoiceControls compact />
                  </div>
                </div>

                {/* 退出大厅 */}
                <div className="shrink-0 px-3 pb-3">
                  <Button
                    size="sm"
                    variant="danger"
                    icon="stop"
                    className="w-full"
                    disabled={leaving}
                    onClick={() => void leaveLobby()}
                  >
                    {leaving ? t('mp.mini.leaving') : t('mp.lobby.leave')}
                  </Button>
                </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

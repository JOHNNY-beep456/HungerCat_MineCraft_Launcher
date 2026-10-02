import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { MpMiniState } from '@shared/types'
import { useApp } from '../store'
import { Button, Icon } from './ui'

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
  useEffect(() => {
    void window.api.mp.miniResize(300, collapsed ? 56 : 420)
  }, [collapsed])

  const lobby = state?.lobby ?? null
  const players = state?.players ?? []
  // 人数 = 自己 + 其他人；后端 players 已含自己（isSelf 标记）。
  const count = players.length

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
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            style={{ overflow: 'hidden' }}
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
                  </div>
                </div>

                {/* 玩家列表 */}
                <div className="caption shrink-0 px-3 pb-1">
                  {t('mp.mini.players')} ({count})
                </div>
                <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-3">
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

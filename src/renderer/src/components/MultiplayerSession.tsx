import { useEffect, useRef, useState } from 'react'
import type { MpLobby, MpPlayer } from '@shared/types'
import { useApp } from '../store'
import { playSound, disposeSounds, type SoundOptions } from '../multiplayer/sounds'

/**
 * 联机会话「大脑」：不渲染任何界面，只在挂载期间持有提示音与浮层同步。
 *
 * 数据流：大厅状态（主进程）→ onLobbyChanged → 刷新成员 → 提示音判定；
 * 聊天消息 → onChat → 提示音；HUD / 弹幕开关 → 主进程增删浮层窗口。
 */
export function MultiplayerSession(): JSX.Element | null {
  const { settings } = useApp()
  const [lobby, setLobby] = useState<MpLobby | null>(null)
  const [players, setPlayers] = useState<MpPlayer[]>([])
  /** 上一次的成员 id 集合：用于提示音「加入 / 离开」判定。 */
  const prevIds = useRef<Set<string>>(new Set())
  /** 是否处于大厅（用布尔值做依赖，避免 lobby 对象频繁换新导致 effect 高频触发）。 */
  const inLobby = !!lobby

  // 读取大厅状态 + 订阅变化。
  // 注意：不能因 enableMultiplayer 关闭就跳过——主进程是事实来源，大厅状态随时可能变化；
  // 关掉开关时主进程返回 null 大厅，本效应自然无副作用。
  useEffect(() => {
    let alive = true
    const refresh = async (): Promise<void> => {
      try {
        const [l, p] = await Promise.all([window.api.mp.getLobby(), window.api.mp.getPlayers()])
        if (!alive) return
        setLobby(l)
        setPlayers(p)
      } catch {
        /* 忽略单次失败 */
      }
    }
    void refresh()
    const off = window.api.mp.onLobbyChanged(() => void refresh())
    return () => {
      alive = false
      off()
    }
  }, [])

  /**
   * HUD / 弹幕开关变化 → 同步浮层窗口。
   *
   * 本组件常驻挂载，因此无论用户在「联机控制条」「联机设置页」还是悬浮窗里改开关，
   * 都能覆盖到；主进程按设置决定窗口增删并补推 HUD 状态。
   * 不在大厅时一律关闭，避免残留浮层。
   */
  useEffect(() => {
    if (!inLobby) {
      void window.api.mp.closeHudWindow()
      void window.api.mp.closeDanmakuWindow()
      return
    }
    void window.api.mp.syncOverlays()
  }, [inLobby, settings.multiplayerHudEnabled, settings.multiplayerDanmakuEnabled])

  // 提示音：新消息 / 成员加入 / 成员离开。
  useEffect(() => {
    const soundOpts: SoundOptions = {
      volume: settings.multiplayerSoundVolume,
      enabled: true,
      dndEnabled: settings.multiplayerDndEnabled,
      dndStart: settings.multiplayerDndStart,
      dndEnd: settings.multiplayerDndEnd
    }
    const off = window.api.mp.onChat((msg) => {
      // 自己发的不响（避免自言自语提示）。
      if (msg.isSelf) return
      playSound('newMessage', soundOpts, settings.multiplayerSoundNewMsg)
    })
    return off
  }, [
    settings.multiplayerSoundVolume,
    settings.multiplayerSoundNewMsg,
    settings.multiplayerDndEnabled,
    settings.multiplayerDndStart,
    settings.multiplayerDndEnd
  ])

  useEffect(() => {
    if (!inLobby) {
      prevIds.current = new Set()
      return
    }
    const soundOpts: SoundOptions = {
      volume: settings.multiplayerSoundVolume,
      enabled: true,
      dndEnabled: settings.multiplayerDndEnabled,
      dndStart: settings.multiplayerDndStart,
      dndEnd: settings.multiplayerDndEnd
    }
    const ids = new Set(players.map((p) => p.id))
    const prev = prevIds.current
    if (prev.size > 0) {
      const joined = [...ids].some((id) => !prev.has(id))
      const left = [...prev].some((id) => !ids.has(id))
      if (joined) playSound('userJoined', soundOpts, settings.multiplayerSoundJoined)
      if (left) playSound('userLeft', soundOpts, settings.multiplayerSoundLeft)
    }
    prevIds.current = ids
  }, [players, inLobby, settings.multiplayerSoundVolume, settings.multiplayerSoundJoined, settings.multiplayerSoundLeft, settings.multiplayerDndEnabled, settings.multiplayerDndStart, settings.multiplayerDndEnd])

  // 卸载时释放音频资源。
  useEffect(() => () => disposeSounds(), [])

  return null
}

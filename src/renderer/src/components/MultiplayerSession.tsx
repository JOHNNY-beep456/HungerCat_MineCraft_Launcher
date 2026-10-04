import { useEffect, useRef, useState } from 'react'
import type { MpLobby, MpPlayer } from '@shared/types'
import { useApp } from '../store'
import { VoiceEngine } from '../multiplayer/voice'
import { playSound, disposeSounds, type SoundOptions } from '../multiplayer/sounds'

/**
 * 联机会话「大脑」：不渲染任何界面，只在挂载期间持有 **语音引擎** 与 **提示音**。
 *
 * 为什么单独抽成一个组件并挂在 App 根部（而非联机页面里）：
 *   - 语音引擎必须在整个大厅存续期间常驻 —— 用户切到其它页面、或只看悬浮窗时，
 *     通话不能断；
 *   - 引擎是**每个渲染进程唯一**的（麦克风与 PeerConnection 不可复制），
 *     悬浮窗是另一个渲染进程，绝不能在那里再建一个引擎。
 *
 * 数据流：
 *   大厅状态（主进程）→ onLobbyChanged → 本组件刷新成员 → 引擎同步中继与播放节点
 *   麦克风开关（任意界面 IPC）→ 主进程广播 mp:micChanged → 本组件驱动引擎
 *   语音音频（主进程 UDP 中继回来）→ onVoiceAudio → 引擎解码播放
 */
export function MultiplayerSession(): JSX.Element | null {
  const { settings } = useApp()
  const engineRef = useRef<VoiceEngine | null>(null)
  const [lobby, setLobby] = useState<MpLobby | null>(null)
  const [players, setPlayers] = useState<MpPlayer[]>([])
  const [micEnabled, setMicEnabled] = useState(false)
  const [globalMuted, setGlobalMuted] = useState(false)
  /** 上一次的成员 id 集合：用于提示音「加入 / 离开」判定。 */
  const prevIds = useRef<Set<string>>(new Set())
  /** 是否处于大厅（用布尔值做依赖，避免 lobby 对象频繁换新导致 effect 高频触发）。 */
  const inLobby = !!lobby

  // 读取大厅状态 + 订阅变化。
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

  // 麦克风状态（主进程是事实来源）。
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

  // 全局静音状态（主进程是事实来源）。
  useEffect(() => {
    let alive = true
    void window.api.mp.getGlobalMuted().then((v) => {
      if (alive) setGlobalMuted(v)
    })
    const off = window.api.mp.onGlobalMutedChanged((v) => setGlobalMuted(v))
    return () => {
      alive = false
      off()
    }
  }, [])

  // 自身语音标识（各端一致的规整玩家名）。所有语音 effect 都以它为依赖：
  // 它由成员列表推导，可能晚于 lobby 到达；若 effect 不依赖它，引擎会带着
  // 空的 selfId 启动，导致「不排除自己 / 建不出连接」，语音始终不工作。
  const selfVoiceId = players.find((p) => p.isSelf)?.voiceId ?? ''

  // 引擎生命周期：进入大厅启动，离开即停。
  useEffect(() => {
    if (!engineRef.current) engineRef.current = new VoiceEngine()
    const engine = engineRef.current
    if (!lobby) {
      engine.stop()
      return
    }
    // 语音引擎以 voiceId 为准寻址：它由玩家名规整得到，各端一致。
    // 用 p.id 会因「信令来源 / 路由表来源」两个不同 id 而对不上，语音永远连不通。
    engine.start(selfVoiceId, settings.multiplayerVoiceChanger, {
      onError: (msg) => console.warn('[联机] 语音：', msg),
      onRemoteAudio: () => undefined
    })
    return () => {
      engine.stop()
    }
    // 在大厅状态或自身 voiceId 变化时重建（voiceId 就绪即携带正确身份启动）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobby?.name, lobby?.virtualIp, selfVoiceId])

  // 成员变化 → 增删连接。
  useEffect(() => {
    const engine = engineRef.current
    if (!engine || !inLobby) return
    // 用 voiceId 建连：与信令里的 from/to 同一套键，才能正确对上每个成员。
    // 依赖 selfVoiceId：自身标识就绪的那一刻补建一次，避免「先 sync 后 start」漏连。
    engine.syncPeers(
      players.map((p) => ({ id: p.voiceId ?? p.id, virtualIp: p.virtualIp ?? '' }))
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inLobby, players, selfVoiceId])

  // 语音音频（主进程 UDP 中继回来）→ 引擎解码播放。
  useEffect(() => {
    const off = window.api.mp.onVoiceAudio(({ from, data }) => {
      engineRef.current?.handleAudio(from, data)
    })
    return off
  }, [])

  // 麦克风开关 → 引擎。
  useEffect(() => {
    void engineRef.current?.setMicEnabled(micEnabled).catch(() => undefined)
  }, [micEnabled])

  // 变声器预设 → 引擎（运行中切换只 replaceTrack，不重协商）。
  useEffect(() => {
    void engineRef.current?.setPreset(settings.multiplayerVoiceChanger)
  }, [settings.multiplayerVoiceChanger])

  // 输入 / 输出设备 → 引擎。dep 带 selfVoiceId：引擎在进入大厅后重建时，
  // 保证设备选择也重新下发一次（否则重建后的引擎会丢选定的设备）。
  useEffect(() => {
    void engineRef.current
      ?.setDevices(settings.multiplayerMicDeviceId, settings.multiplayerSpeakerDeviceId)
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.multiplayerMicDeviceId, settings.multiplayerSpeakerDeviceId, selfVoiceId])

  /**
   * HUD / 弹幕开关变化 → 同步浮层窗口。
   *
   * 本组件常驻挂载，因此无论用户在「联机控制条」「联机设置页」还是悬浮窗里改开关，
   * 都能覆盖到；主进程按设置决定窗口增删并补推 HUD 状态。
   * 不在大厅时一律关闭，避免残留浮层。
   */
  useEffect(() => {
    // 依赖用布尔值而非 lobby 对象：lobby 每次成员状态变化都会换新对象，
    // 用对象会让本 effect 在「说话中」高频重复触发（每次 pushHudState）。
    if (!inLobby) {
      void window.api.mp.closeHudWindow()
      void window.api.mp.closeDanmakuWindow()
      return
    }
    void window.api.mp.syncOverlays()
  }, [inLobby, settings.multiplayerHudEnabled, settings.multiplayerDanmakuEnabled])

  // 全局静音 → 引擎；同时把每个成员的单人静音状态同步过去。
  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    engine.setGlobalMuted(globalMuted)
    for (const p of players) engine.setPeerMuted(p.voiceId ?? p.id, p.isMuted)
  }, [globalMuted, players])

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

// ---------------------------------------------------------------------------
// 联机提示音（消息 / 加入 / 离开）。
//
// MCTier 用 `NewMsg.mp3` / `UserJoined.mp3` / `UserLeft.mp3` 三个音频文件；
// 本启动器刻意**不引入二进制素材**（避免仓库体积与授权问题），改用 Web Audio
// 实时合成三种短提示音。音色偏「玻璃拟态」：正弦基音 + 快速包络，短促不刺耳。
//
// 约定：
//   - 音量取 `multiplayerSoundVolume`（0–1）；
//   - 每一类可单独开关（multiplayerSoundNewMsg / Joined / Left）；
//   - 免打扰时段（multiplayerDndEnabled + Start/End）内完全不响。
// ---------------------------------------------------------------------------

export type SoundType = 'newMessage' | 'userJoined' | 'userLeft'

export interface SoundOptions {
  volume: number
  enabled: boolean
  dndEnabled: boolean
  dndStart: number
  dndEnd: number
}

/** 单例 AudioContext：懒创建，避免在用户未开启联机时占用音频设备。 */
let ctx: AudioContext | null = null

function audioCtx(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null
  if (!ctx) {
    try {
      ctx = new AudioContext()
    } catch {
      return null
    }
  }
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
  return ctx
}

/** 排一个音符：正弦波 + 指数衰减包络。 */
function tone(
  ac: AudioContext,
  freq: number,
  startAt: number,
  duration: number,
  peak: number,
  type: OscillatorType = 'sine'
): void {
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  osc.type = type
  osc.frequency.value = freq
  const t0 = ac.currentTime + startAt
  gain.gain.setValueAtTime(0, t0)
  gain.gain.linearRampToValueAtTime(peak, t0 + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)
  osc.connect(gain)
  gain.connect(ac.destination)
  osc.start(t0)
  osc.stop(t0 + duration + 0.02)
}

/** 当前是否处于免打扰时段（支持跨零点，如 22:00–08:00）。 */
export function isDndActive(opts: SoundOptions, now = new Date()): boolean {
  if (!opts.dndEnabled) return false
  const minutes = now.getHours() * 60 + now.getMinutes()
  const { dndStart, dndEnd } = opts
  if (dndStart === dndEnd) return false
  // 跨零点：起点大于终点时，命中区间为 [start, 24h) ∪ [0, end)。
  return dndStart < dndEnd
    ? minutes >= dndStart && minutes < dndEnd
    : minutes >= dndStart || minutes < dndEnd
}

/**
 * 播放一个提示音。
 *
 * @param enabled 该音效自身的开关（如「新消息」）。
 * @returns 是否真的播放了（供测试与诊断）。
 */
export function playSound(type: SoundType, opts: SoundOptions, enabled: boolean): boolean {
  if (!enabled) return false
  if (isDndActive(opts)) return false
  const volume = Math.max(0, Math.min(1, opts.volume))
  if (volume <= 0) return false
  const ac = audioCtx()
  if (!ac) return false
  const peak = 0.22 * volume

  switch (type) {
    case 'newMessage':
      // 两声上行短音（叮-咚）。
      tone(ac, 880, 0, 0.14, peak)
      tone(ac, 1320, 0.1, 0.18, peak * 0.9)
      break
    case 'userJoined':
      // 上行三音，明亮。
      tone(ac, 660, 0, 0.12, peak)
      tone(ac, 880, 0.1, 0.12, peak)
      tone(ac, 1174, 0.2, 0.2, peak)
      break
    case 'userLeft':
      // 下行两音，柔和。
      tone(ac, 660, 0, 0.14, peak)
      tone(ac, 440, 0.12, 0.24, peak * 0.85)
      break
  }
  return true
}

/** 释放音频上下文（退出大厅时可选调用）。 */
export function disposeSounds(): void {
  if (ctx) {
    void ctx.close().catch(() => undefined)
    ctx = null
  }
}

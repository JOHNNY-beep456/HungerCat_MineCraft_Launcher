// ---------------------------------------------------------------------------
// 变声器（Web Audio 实时变调）。
//
// 移植自 MCTier 的 `services/voice/voiceChanger.ts` 思路：不改音色素材，只在
// 麦克风流与发送轨道之间插一段 **实时变调** 的 Web Audio 图，用「保持时长的变调」
// （相位声码器的简化版：双粒度交叉淡化）改变音高，从而得到萝莉 / 大叔等效果。
//
// 为什么用 AudioWorklet 而不是 ScriptProcessor：
//   ScriptProcessor 跑在主线程，音视频编码时容易卡顿甚至爆音；Worklet 跑在音频
//   渲染线程，延迟稳定。Worklet 模块用 Blob URL 内联注入，免去额外构建产物。
//
// 关键设计：输出接到 `MediaStreamAudioDestinationNode`，得到一条**稳定轨道**。
// 切换音色只改参数（`setPitch`），不需要对每条 PeerConnection 重新协商，
// 因此换音色是「瞬时」的，不会中断通话。
// ---------------------------------------------------------------------------

/** 预设 → 半音偏移（0 表示原声）。与设置项 `multiplayerVoiceChanger` 一一对应。 */
export const VOICE_PRESETS: Record<string, number> = {
  off: 0,
  uncle: -6,
  deep: -3,
  cute: 4,
  loli: 7
}

/**
 * 粒度变调 Worklet 源码。
 *
 * 算法：把输入写入环形缓冲；用两个相隔半粒度的读指针，各自以 `pitch` 倍速扫过缓冲
 * （正向变调 = 读指针相对写指针前进更快），再用半窗函数做交叉淡化。窗口与此消彼长
 * 保证拼接处幅度连续，听感上是「音高变了、时长没变」。
 * 粒度取 1024 帧（48kHz 下约 21ms，双粒度引入约 10ms 延迟），对语音足够低。
 */
const PITCH_WORKLET_SRC = `
class PitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'pitch', defaultValue: 1, minValue: 0.5, maxValue: 2, automationRate: 'k-rate' }]
  }
  constructor() {
    super()
    this.size = 8192
    this.buf = new Float32Array(this.size)
    this.write = 0
    this.grain = 1024
    this.phase = 0
  }
  process(inputs, outputs, params) {
    const input = inputs[0] && inputs[0][0]
    const output = outputs[0] && outputs[0][0]
    if (!output) return true
    const pitch = params.pitch[0]
    const size = this.size
    const grain = this.grain
    for (let i = 0; i < output.length; i++) {
      const x = input ? input[i] : 0
      this.buf[this.write] = x
      // 半窗交叉淡化：两个读指针在 [0,1) 相位上相隔 0.5 个粒度。
      const t1 = this.phase
      const t2 = (this.phase + 0.5) % 1
      const d1 = t1 * grain
      const d2 = t2 * grain
      const g1 = Math.sin(Math.PI * t1)
      const g2 = Math.sin(Math.PI * t2)
      const s1 = this.read(d1)
      const s2 = this.read(d2)
      output[i] = s1 * g1 + s2 * g2
      // 相位推进：pitch=1 时相位不动（原声等价，仅有固定半粒度延迟）。
      this.phase = (this.phase + (1 - pitch) + 1) % 1
      this.write = (this.write + 1) % size
    }
    return true
  }
  read(delay) {
    const size = this.size
    let pos = this.write - delay
    while (pos < 0) pos += size
    const i0 = Math.floor(pos) % size
    const i1 = (i0 + 1) % size
    const frac = pos - Math.floor(pos)
    return this.buf[i0] * (1 - frac) + this.buf[i1] * frac
  }
}
registerProcessor('hungercat-pitch-shifter', PitchShifter)
`

/** 变声引擎：持有 Web Audio 图与输出轨道。 */
export class VoiceChanger {
  private ctx: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private worklet: AudioWorkletNode | null = null
  private dest: MediaStreamAudioDestinationNode | null = null
  private input: MediaStream | null = null
  private preset = 'off'

  /** 当前预设标识。 */
  get currentPreset(): string {
    return this.preset
  }

  /**
   * 用给定的麦克风流构建变声图，返回可发送的音频轨道。
   *
   * 原声（off）时**完全旁路**：直接返回原始音轨，不搭 Web Audio 图 ——
   * 既省开销，也避免多余桥接在某些设备上引入回声/回环问题。
   */
  async process(input: MediaStream, preset: string): Promise<MediaStreamTrack> {
    this.input = input
    this.preset = preset
    const semitones = VOICE_PRESETS[preset] ?? 0
    if (semitones === 0) {
      this.teardownGraph()
      return input.getAudioTracks()[0]
    }
    await this.ensureGraph(input)
    this.setSemitones(semitones)
    return this.dest!.stream.getAudioTracks()[0]
  }

  /** 运行中切换预设：只改参数，返回是否仍走变声（false 表示已回原声旁路）。 */
  setPreset(preset: string): boolean {
    this.preset = preset
    const semitones = VOICE_PRESETS[preset] ?? 0
    if (semitones === 0) {
      this.teardownGraph()
      return false
    }
    return true
  }

  private setSemitones(semitones: number): void {
    if (!this.worklet) return
    const pitch = Math.pow(2, semitones / 12)
    const p = this.worklet.parameters.get('pitch')
    if (p) p.value = pitch
  }

  private async ensureGraph(input: MediaStream): Promise<void> {
    if (this.ctx) {
      // 复用已有图，只换源（换麦克风设备时）。
      if (this.input !== input && this.source) {
        try {
          this.source.disconnect()
        } catch {
          /* 已断开 */
        }
        this.source = this.ctx.createMediaStreamSource(input)
        this.source.connect(this.worklet!)
      }
      if (this.ctx.state === 'suspended') await this.ctx.resume()
      return
    }
    const ctx = new AudioContext({ sampleRate: 48000 })
    const blob = new Blob([PITCH_WORKLET_SRC], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    try {
      await ctx.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    const source = ctx.createMediaStreamSource(input)
    const worklet = new AudioWorkletNode(ctx, 'hungercat-pitch-shifter', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1]
    })
    const dest = ctx.createMediaStreamDestination()
    source.connect(worklet)
    worklet.connect(dest)
    this.ctx = ctx
    this.source = source
    this.worklet = worklet
    this.dest = dest
  }

  private teardownGraph(): void {
    if (this.worklet) {
      try {
        this.worklet.disconnect()
      } catch {
        /* 已断开 */
      }
    }
    if (this.source) {
      try {
        this.source.disconnect()
      } catch {
        /* 已断开 */
      }
    }
    if (this.ctx) {
      void this.ctx.close().catch(() => undefined)
    }
    this.ctx = null
    this.source = null
    this.worklet = null
    this.dest = null
  }

  /** 释放全部资源（退出大厅时调用）。 */
  dispose(): void {
    this.teardownGraph()
    this.input = null
  }
}

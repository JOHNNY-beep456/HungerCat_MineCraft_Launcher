// ---------------------------------------------------------------------------
// 语音聊天引擎（UDP 中继 + Opus）。
//
// ── 传输层为什么不用 WebRTC ──────────────────────────────────────────
// 之前是 WebRTC mesh：媒体点对点 UDP，靠 ICE 找双方直达路径。但本项目 EasyTier 是
// `--no-tun`（系统里没有虚拟网卡与 10.126.126.0/24 路由），WebRTC 的 host 候选只有
// 物理网卡地址 —— 同一局域网能用，**跨网络必然打不通**（又没有 TURN 中继）。
//
// 现在改为走 EasyTier 已经打通的那条通道：**UDP 端口转发**（见主进程 voice-relay.ts）。
// 本引擎只负责：
//   1. 采集麦克风 → （可选变声）→ 统一重采样到 48kHz 单声道 PCM；
//   2. 用 WebCodecs 的 AudioEncoder 编成 Opus（20ms 一帧），经 IPC 交给主进程 UDP 发出；
//   3. 主进程收到的音频帧经 IPC 回来 → AudioDecoder 解码 → 排进 jitter buffer 播放。
//
// 编码只用 Opus（32kbps）：mesh 下带宽是 N² 级，原始 PCM（48k×16bit≈768kbps / 人）不可行。
// ---------------------------------------------------------------------------

import { VoiceChanger } from './voice-changer'

/** Opus 统一采样率与帧长（20ms）。两端都用它，避免重采样不一致导致音调偏移。 */
const SAMPLE_RATE = 48_000
const FRAME_MS = 20
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000
/** Opus 目标码率（语音足够，mesh 下带宽可控）。 */
const OPUS_BITRATE = 32_000
/** 播放端 jitter buffer：先缓冲这么久再播，吸收 UDP 抖动与乱序。 */
const JITTER_BUFFER_S = 0.06
/** 落后超过这个时间就直接重新对齐（长时间卡顿后不追旧数据）。 */
const RESYNC_BEHIND_S = 0.25

/** 说话判定的 RMS 门限与回落时间。 */
const SPEAK_RMS_ON = 0.02
const SPEAK_HOLD_MS = 450

/* ------------------------------------------------------------------ */
/* WebCodecs 最小类型（避免依赖 TS DOM lib 是否收录 WebCodecs）           */
/* ------------------------------------------------------------------ */

interface EncodedChunkLike {
  byteLength: number
  /** 支持写入 ArrayBuffer 或视图（视图会直接写进其底层缓冲）。 */
  copyTo(dest: ArrayBuffer | ArrayBufferView): void
}
interface AudioEncoderLike {
  configure(cfg: Record<string, unknown>): void
  encode(data: unknown): void
  close(): void
}
interface DecodedAudioLike {
  numberOfFrames: number
  sampleRate: number
  numberOfChannels: number
  copyTo(dest: Float32Array, opts: { planeIndex: number; format?: string }): void
  close(): void
}
interface AudioDecoderLike {
  configure(cfg: Record<string, unknown>): void
  decode(chunk: unknown): void
  close(): void
}
interface WebCodecsCtor {
  AudioEncoder?: new (init: {
    output: (chunk: EncodedChunkLike) => void
    error: (err: Error) => void
  }) => AudioEncoderLike
  AudioDecoder?: new (init: {
    output: (data: DecodedAudioLike) => void
    error: (err: Error) => void
  }) => AudioDecoderLike
  AudioData?: new (init: Record<string, unknown>) => unknown
  EncodedAudioChunk?: new (init: Record<string, unknown>) => unknown
}

function webcodecs(): WebCodecsCtor {
  return window as unknown as WebCodecsCtor
}

/**
 * 把 getUserMedia 抛出的错误翻成【可操作】的中文提示。
 *
 * 这几种失败在 Windows 上极常见，但原生错误信息只有英文枚举名，
 * 用户看不懂也不知道怎么办 —— 语音「没反应」多半就是卡在这里。
 */
export function describeMicError(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  const raw = err instanceof Error ? err.message : String(err)
  switch (name) {
    case 'NotAllowedError':
      return '麦克风权限被拒绝。请到 Windows「设置 → 隐私和安全性 → 麦克风」中允许桌面应用使用麦克风，然后重启启动器再试。'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '没有检测到麦克风设备，请先连接麦克风（或检查是否被禁用）。'
    case 'NotReadableError':
    case 'TrackStartError':
      return '麦克风被其它程序占用（如游戏内语音、录音软件），请关闭占用程序后重试。'
    case 'OverconstrainedError':
      return '当前麦克风不支持所需的音频参数，请更换设备后重试。'
    default:
      return `无法获取麦克风：${raw}`
  }
}

export interface VoiceEngineHooks {
  /** 本机是否正在说话（已去抖）。 */
  onSpeaking?: (speaking: boolean) => void
  /** 出错提示（如麦克风被拒绝）。 */
  onError?: (message: string) => void
  /** 某成员是否有音频到达（用于成员列表展示连接状态）。 */
  onRemoteAudio?: (peerId: string, active: boolean) => void
}

/** 一位成员的播放侧状态。 */
interface PeerPlayback {
  decoder: AudioDecoderLike | null
  gain: GainNode
  /** 下一帧的播放时刻（AudioContext 时间轴），用于连续排布。 */
  nextAt: number
  /** 解码时间戳计数（AudioDecoder 要求严格递增）。 */
  ts: number
  muted: boolean
  active: boolean
}

export class VoiceEngine {
  private selfId = ''
  private preset = 'off'
  private hooks: VoiceEngineHooks = {}

  /** 采集 / 播放共用一个 48kHz 上下文。 */
  private ctx: AudioContext | null = null
  private masterGain: GainNode | null = null

  private rawStream: MediaStream | null = null
  private changer = new VoiceChanger()
  private captureSource: MediaStreamAudioSourceNode | null = null
  private captureProc: ScriptProcessorNode | null = null
  private analyser: AnalyserNode | null = null

  private encoder: AudioEncoderLike | null = null
  private audioDataCtor: WebCodecsCtor['AudioData'] | null = null
  /** 待编码 PCM（攒够一帧就编）。 */
  private pcmPending = new Float32Array(FRAME_SAMPLES * 4)
  private pcmLen = 0
  private encodeTs = 0

  private peers = new Map<string, PeerPlayback>()
  /**
   * 需要发送音频的成员 id（voiceId）。
   *
   * 必须与 `peers`（播放侧节点）分开：播放节点是在「**收到**对方音频」时才惰性建立的，
   * 若用它当发送目标，就会出现「对方还没说话 → 我没建节点 → 我也永远不发给对方」的死锁，
   * 双方都听不到声音。
   */
  private targets: string[] = []
  /** 被单人静音的成员（节点可能尚未建立，需先记下来）。 */
  private mutedPeers = new Set<string>()
  private micEnabled = false
  private globalMuted = false
  /** 偏好的输入（麦克风）设备 id，空 = 跟随系统默认。 */
  private inputDeviceId = ''
  /** 偏好的输出（扬声器）设备 id，空 = 跟随系统默认。 */
  private outputDeviceId = ''
  /** 解码能力缺失是否已上报（只报一次）。 */
  private reportedDecodeUnsupported = false

  private speakTimer: ReturnType<typeof setInterval> | null = null
  private speaking = false
  private lastLoudAt = 0

  /** 启动引擎（加入大厅后调用）。此时不申请麦克风，只记录自身 id 与音色。 */
  start(selfId: string, preset: string, hooks: VoiceEngineHooks): void {
    this.selfId = selfId
    this.preset = preset
    this.hooks = hooks
  }

  get isMicEnabled(): boolean {
    return this.micEnabled
  }

  /**
   * 同步成员：把「需要互通音频的成员」交给主进程建立 UDP 转发，并维护播放侧节点。
   *
   * @param peers 成员列表，`id` 为语音标识（voiceId），`virtualIp` 为其虚拟 IP。
   */
  syncPeers(peers: Array<{ id: string; virtualIp: string }>): void {
    // 自身 id 未就绪时不建任何连接：否则会把「自己」也当成成员去连。
    if (!this.selfId) return
    const wanted = peers.filter((p) => p.id && p.id !== this.selfId)

    // 主进程据此建立 / 回收每个成员的 UDP 转发。
    void window.api.mp
      .voiceRelaySync(wanted.map((p) => ({ id: p.id, virtualIp: p.virtualIp ?? '' })))
      .catch(() => undefined)

    const want = new Set(wanted.map((p) => p.id))
    this.targets = [...want]
    for (const [id, peer] of [...this.peers.entries()]) {
      if (want.has(id)) continue
      this.closePeer(id, peer)
      this.peers.delete(id)
    }
  }

  /**
   * 开关麦克风。
   *
   * 首次开启才申请设备权限；关闭时停止送帧（保留采集流，便于快速重开）。
   */
  async setMicEnabled(enabled: boolean): Promise<void> {
    this.micEnabled = enabled
    if (!enabled) {
      this.setSpeaking(false)
      return
    }
    try {
      await this.ensureCapture()
    } catch (err) {
      this.micEnabled = false
      const msg = describeMicError(err)
      this.hooks.onError?.(msg)
      // 同步抛给界面：否则用户只看到「点了没反应」，无从排查。
      void window.api.mp.reportVoiceError(msg).catch(() => undefined)
      throw err
    }
  }

  /** 运行中切换音色：重建采集图（不涉及协商）。 */
  async setPreset(preset: string): Promise<void> {
    this.preset = preset
    if (!this.micEnabled || !this.rawStream) return
    this.teardownCapture()
    try {
      await this.ensureCapture()
    } catch (err) {
      console.warn('[语音] 切换音色失败：', err)
    }
  }

  /**
   * 切换输入 / 输出设备。
   *
   * - 输出：把播放上下文切到选定设备（`AudioContext.setSinkId`）；不支持或设备无效时
   *   静默回退到系统默认，绝不因设备选择失败而让语音整体不可用；
   * - 输入：若麦克风已开，重建采集链路，让编码器改用新设备的 PCM。
   */
  async setDevices(inputDeviceId: string, outputDeviceId: string): Promise<void> {
    const nextInput = inputDeviceId || ''
    const inputChanged = nextInput !== this.inputDeviceId
    this.inputDeviceId = nextInput
    this.outputDeviceId = outputDeviceId || ''
    await this.applySink()
    if (!inputChanged || !this.micEnabled) return
    this.teardownCapture()
    this.rawStream?.getTracks().forEach((t) => t.stop())
    this.rawStream = null
    try {
      await this.ensureCapture()
    } catch (err) {
      const msg = describeMicError(err)
      this.hooks.onError?.(msg)
      void window.api.mp.reportVoiceError(msg).catch(() => undefined)
    }
  }

  /**
   * 把播放上下文切到选定的输出设备。
   *
   * `AudioContext.setSinkId` 仅较新的 Chromium 提供；不支持或设备无效时静默回退。
   */
  private async applySink(): Promise<void> {
    const ctx = this.ctx as unknown as { setSinkId?: (id: string) => Promise<void> } | null
    if (!ctx || typeof ctx.setSinkId !== 'function') return
    try {
      await ctx.setSinkId(this.outputDeviceId)
    } catch (err) {
      console.warn('[语音] 切换输出设备失败（回退默认）：', err)
    }
  }

  /** 全局静音：只影响播放（不听别人），不影响自己说话。 */
  setGlobalMuted(muted: boolean): void {
    this.globalMuted = muted
    if (this.masterGain) this.masterGain.gain.value = muted ? 0 : 1
  }

  /** 单人静音。 */
  setPeerMuted(peerId: string, muted: boolean): void {
    if (muted) this.mutedPeers.add(peerId)
    else this.mutedPeers.delete(peerId)
    const peer = this.peers.get(peerId)
    if (!peer) return
    peer.muted = muted
    peer.gain.gain.value = muted ? 0 : 1
  }

  /** 处理一帧来自主进程的成员音频（UDP 中继）。 */
  handleAudio(from: string, data: Uint8Array): void {
    if (!from || from === this.selfId) return
    if (!this.ctx) {
      // 「只听不说」也必须能听见：播放上下文此前只在开麦时建立，
      // 不开麦的用户会把收到的音频全部丢掉。这里按需补建（首帧丢弃即可）。
      void this.ensureContext().catch(() => undefined)
      return
    }
    const ctx = this.ctx
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
    const peer = this.ensurePeer(from)
    if (!peer.decoder) return
    const Chunk = webcodecs().EncodedAudioChunk
    if (!Chunk) return
    try {
      peer.ts += FRAME_MS * 1000
      peer.decoder.decode(
        new Chunk({ type: 'key', timestamp: peer.ts, data: new Uint8Array(data) })
      )
    } catch {
      /* 单帧解码失败丢弃即可 */
    }
  }

  /** 停止并释放全部资源（退出大厅）。 */
  stop(): void {
    this.stopSpeakingLoop()
    for (const [id, peer] of [...this.peers.entries()]) this.closePeer(id, peer)
    this.peers.clear()
    this.targets = []
    this.mutedPeers.clear()

    this.teardownCapture()
    this.encoder?.close()
    this.encoder = null
    this.rawStream?.getTracks().forEach((t) => t.stop())
    this.rawStream = null
    this.changer.dispose()
    if (this.ctx) {
      void this.ctx.close().catch(() => undefined)
      this.ctx = null
    }
    this.masterGain = null
    this.analyser = null
    this.micEnabled = false
    this.speaking = false
    this.pcmLen = 0

    // 通知主进程关闭中继套接字并回收转发登记。
    void window.api.mp.voiceRelayStop().catch(() => undefined)
  }

  /* ---------------- 采集 / 编码 ---------------- */

  /** 建好采集链路与会话上下文（幂等）。 */
  private async ensureCapture(): Promise<void> {
    const ctx = await this.ensureContext()
    if (!this.rawStream) {
      const audio: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
      // 指定了具体设备才加精确约束；空串表示跟随系统默认（不加约束，避免「exact 匹配
      // 默认设备」在部分系统上反而报 OverconstrainedError）。
      if (this.inputDeviceId) audio.deviceId = { exact: this.inputDeviceId }
      this.rawStream = await navigator.mediaDevices.getUserMedia({ audio, video: false })
      // 拿到流即代表已获得设备权限，此时切输出设备的成功率最高。
      void this.applySink().catch(() => undefined)
    }
    // 编解码器不可用时直接报错，避免「开了麦却没人能听到」这种哑失败。
    const wc = webcodecs()
    if (!wc.AudioEncoder || !wc.AudioData) {
      throw new Error('当前运行环境不支持 WebCodecs 音频编码，无法发送语音')
    }
    if (!this.encoder) {
      this.encoder = new wc.AudioEncoder({
        output: (chunk) => this.onEncoded(chunk),
        error: (err) => console.warn('[语音] 编码器错误：', err.message)
      })
      this.encoder.configure({
        codec: 'opus',
        sampleRate: SAMPLE_RATE,
        numberOfChannels: 1,
        bitrate: OPUS_BITRATE
      })
      this.audioDataCtor = wc.AudioData
    }
    if (this.captureProc) return

    // 变声（off 时旁路，返回原始音轨）→ 统一进 48kHz 的 Web Audio 图取 PCM。
    const track = await this.changer.process(this.rawStream, this.preset)
    const stream = new MediaStream([track])
    const source = ctx.createMediaStreamSource(stream)
    const proc = ctx.createScriptProcessor(1024, 1, 1)
    // 必须连到 destination 才会被驱动；用 0 增益避免把麦克风回放出来（啸叫）。
    const sink = ctx.createGain()
    sink.gain.value = 0
    proc.onaudioprocess = (e): void => this.onPcm(e.inputBuffer.getChannelData(0))
    source.connect(proc)
    proc.connect(sink)
    sink.connect(ctx.destination)

    // 音量检测（说话指示）复用同一路信号。
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    source.connect(analyser)

    this.captureSource = source
    this.captureProc = proc
    this.analyser = analyser
    this.startSpeakingLoop()
  }

  /** 断开采集图（保留 encoder 与 rawStream，便于快速重开）。 */
  private teardownCapture(): void {
    if (this.captureProc) {
      try {
        this.captureProc.disconnect()
      } catch {
        /* 已断开 */
      }
      this.captureProc.onaudioprocess = null
      this.captureProc = null
    }
    if (this.captureSource) {
      try {
        this.captureSource.disconnect()
      } catch {
        /* 已断开 */
      }
      this.captureSource = null
    }
    this.analyser = null
    this.stopSpeakingLoop()
  }

  /** 取到帧 PCM → 攒够 20ms 就编码并通过 IPC 发出。 */
  private onPcm(chunk: Float32Array): void {
    if (!this.micEnabled) return
    // 缓冲不足时扩容（正常情况下不会触发）。
    if (this.pcmLen + chunk.length > this.pcmPending.length) {
      const grown = new Float32Array(Math.max(this.pcmPending.length * 2, this.pcmLen + chunk.length))
      grown.set(this.pcmPending.subarray(0, this.pcmLen))
      this.pcmPending = grown
    }
    this.pcmPending.set(chunk, this.pcmLen)
    this.pcmLen += chunk.length

    while (this.pcmLen >= FRAME_SAMPLES) {
      const frame = this.pcmPending.subarray(0, FRAME_SAMPLES)
      this.encodeFrame(frame)
      this.pcmPending.copyWithin(0, FRAME_SAMPLES, this.pcmLen)
      this.pcmLen -= FRAME_SAMPLES
    }
  }

  private encodeFrame(frame: Float32Array): void {
    const encoder = this.encoder
    const Ctor = this.audioDataCtor
    if (!encoder || !Ctor) return
    let audioData: unknown
    try {
      audioData = new Ctor({
        format: 'f32-planar',
        sampleRate: SAMPLE_RATE,
        numberOfFrames: FRAME_SAMPLES,
        numberOfChannels: 1,
        // 拷贝一份：subarray 是原缓冲视图，后续会被 copyWithin 覆盖。
        data: new Float32Array(frame),
        timestamp: this.encodeTs
      })
    } catch (err) {
      console.warn('[语音] 构造 AudioData 失败：', err)
      return
    }
    this.encodeTs += FRAME_MS * 1000
    try {
      encoder.encode(audioData)
    } catch (err) {
      console.warn('[语音] 编码失败：', err)
    }
  }

  /** 编码完成：发给所有已知成员（不依赖播放节点是否已建立）。 */
  private onEncoded(chunk: EncodedChunkLike): void {
    const size = chunk.byteLength
    if (!size || this.targets.length === 0) return
    const payload = new Uint8Array(size)
    // 注意：必须写进 payload 本体。早前写成 `copyTo(payload.buffer.slice(...))`,
    // 那是写进一个「切出来的新缓冲」，payload 始终是全零 —— 对方只会听到静音。
    chunk.copyTo(payload)
    for (const id of this.targets) {
      void window.api.mp.sendVoiceAudio(id, payload).catch(() => undefined)
    }
  }

  /* ---------------- 播放 / 解码 ---------------- */

  private ensurePeer(peerId: string): PeerPlayback {
    const existing = this.peers.get(peerId)
    if (existing) return existing
    const ctx = this.ctx!
    const muted = this.mutedPeers.has(peerId)
    const gain = ctx.createGain()
    gain.gain.value = muted ? 0 : 1
    gain.connect(this.masterGain!)
    const peer: PeerPlayback = {
      decoder: null,
      gain,
      nextAt: 0,
      ts: 0,
      muted,
      active: false
    }
    const wc = webcodecs()
    if (!wc.AudioDecoder) {
      // 「听不到别人说话」多半是运行环境缺少 WebCodecs 解码能力，必须显式告知，
      // 否则用户只会看到「语音没反应」。
      this.reportDecodeUnsupported()
    } else {
      try {
        peer.decoder = new wc.AudioDecoder({
          output: (data) => this.onDecoded(peerId, data),
          error: (err) => console.warn('[语音] 解码器错误：', err.message)
        })
        peer.decoder.configure({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 })
      } catch {
        peer.decoder = null
        this.reportDecodeUnsupported()
      }
    }
    this.peers.set(peerId, peer)
    return peer
  }

  /** 解码能力缺失只上报一次，避免每帧刷屏。 */
  private reportDecodeUnsupported(): void {
    if (this.reportedDecodeUnsupported) return
    this.reportedDecodeUnsupported = true
    const msg = '当前运行环境不支持 WebCodecs 音频解码，无法播放语音。请更新启动器 / 系统后重试。'
    this.hooks.onError?.(msg)
    void window.api.mp.reportVoiceError(msg).catch(() => undefined)
  }

  /** 解码得到 PCM → 按 jitter buffer 排进播放时间轴。 */
  private onDecoded(peerId: string, data: DecodedAudioLike): void {
    const ctx = this.ctx
    const peer = this.peers.get(peerId)
    if (!ctx || !peer) {
      data.close()
      return
    }
    const frames = data.numberOfFrames
    const rate = data.sampleRate || SAMPLE_RATE
    try {
      if (frames > 0) {
        const buf = ctx.createBuffer(1, frames, rate)
        const out = buf.getChannelData(0)
        // 解码输出通常已是 f32-planar；显式要求该格式，必要时由实现做转换。
        data.copyTo(out, { planeIndex: 0, format: 'f32-planar' })
        const now = ctx.currentTime
        let at = peer.nextAt
        // 首次、或明显落后（卡顿后）→ 以「当前 + 缓冲」为基准重新对齐。
        if (at < now + JITTER_BUFFER_S - RESYNC_BEHIND_S) at = now + JITTER_BUFFER_S
        const src = ctx.createBufferSource()
        src.buffer = buf
        src.connect(peer.gain)
        src.start(at)
        peer.nextAt = at + buf.duration
        if (!peer.active) {
          peer.active = true
          this.hooks.onRemoteAudio?.(peerId, true)
        }
      }
    } catch (err) {
      console.warn('[语音] 播放失败：', err)
    } finally {
      data.close()
    }
  }

  private closePeer(id: string, peer: PeerPlayback): void {
    try {
      peer.decoder?.close()
    } catch {
      /* 已关闭 */
    }
    peer.decoder = null
    try {
      peer.gain.disconnect()
    } catch {
      /* 已断开 */
    }
    if (peer.active) this.hooks.onRemoteAudio?.(id, false)
    peer.active = false
  }

  /* ---------------- 上下文 / 说话检测 ---------------- */

  private async ensureContext(): Promise<AudioContext> {
    if (!this.ctx) {
      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
      const master = ctx.createGain()
      master.gain.value = this.globalMuted ? 0 : 1
      master.connect(ctx.destination)
      this.ctx = ctx
      this.masterGain = master
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    // 让播放走选定的输出设备（不支持时静默回退默认）。
    void this.applySink().catch(() => undefined)
    return this.ctx
  }

  /** 本地音量检测：驱动「说话中」指示。 */
  private startSpeakingLoop(): void {
    if (!this.analyser || this.speakTimer) return
    const data = new Float32Array(this.analyser.fftSize)
    this.speakTimer = setInterval(() => {
      if (!this.analyser) return
      this.analyser.getFloatTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
      const rms = Math.sqrt(sum / data.length)
      const now = Date.now()
      if (rms >= SPEAK_RMS_ON) this.lastLoudAt = now
      const shouldSpeak = this.micEnabled && now - this.lastLoudAt < SPEAK_HOLD_MS
      if (shouldSpeak !== this.speaking) this.setSpeaking(shouldSpeak)
    }, 120)
  }

  private stopSpeakingLoop(): void {
    if (this.speakTimer) {
      clearInterval(this.speakTimer)
      this.speakTimer = null
    }
  }

  private setSpeaking(speaking: boolean): void {
    if (this.speaking === speaking) return
    this.speaking = speaking
    this.hooks.onSpeaking?.(speaking)
    void window.api.mp.setSpeaking(speaking).catch(() => undefined)
  }
}

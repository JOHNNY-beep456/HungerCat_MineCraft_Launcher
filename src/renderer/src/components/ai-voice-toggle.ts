/** 有界录音消费者；只有显式 start/toggle 才请求麦克风。 */
export interface AiVoiceOptions {
  canStart: () => boolean
  recording: (recording: boolean) => void
  status: (status: 'idle' | 'listening' | 'thinking') => void
  notice: (kind: 'clear' | 'unsupported' | 'listening' | 'error', error?: unknown) => void
  transcribe: (bytes: Uint8Array, mime: string) => Promise<{ ok: boolean; text?: string; error?: string }>
  send: (text: string, current: () => boolean) => Promise<void>
}
const MAX_RECORD_MS = 60_000
const MAX_AUDIO_BYTES = 12 * 1024 * 1024

/** current() 每次取最新闭包；stop 发送本次录音，cancel/dispose 丢弃所有迟到结果。 */
export function createAiVoiceRecorder(options: () => AiVoiceOptions): {
  start: () => Promise<void>; stop: () => void; toggle: () => Promise<void>
  cancel: () => void; dispose: () => void
} {
  let disposed = false, generation = 0
  let phase: 'idle' | 'acquiring' | 'recording' | 'stopping' | 'transcribing' = 'idle'
  let recorder: MediaRecorder | null = null
  let stream: MediaStream | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let chunks: Blob[] = [], bytes = 0
  const clearTimer = (): void => { if (timer !== undefined) clearTimeout(timer); timer = undefined }
  const release = (value: MediaStream | null): void => { value?.getTracks().forEach((track) => { try { track.stop() } catch { /* 已结束 */ } }) }
  const current = (token: number): boolean => !disposed && generation === token
  const idle = (): void => { options().recording(false); options().status('idle') }
  const cancel = (): void => {
    generation++
    clearTimer()
    const old = recorder; recorder = null
    if (old) {
      old.onstop = null; old.ondataavailable = null; old.onerror = null
      try { if (old.state !== 'inactive') old.stop() } catch { /* 不把取消当作提交 */ }
    }
    release(stream); stream = null; chunks = []; bytes = 0; phase = 'idle'
    if (!disposed) { idle(); options().notice('clear') }
  }
  const stop = (): void => {
    if (phase === 'acquiring') { cancel(); return }
    if (phase !== 'recording' || !recorder) return
    clearTimer()
    phase = 'stopping'
    try {
      recorder.stop()
      // stop 的数据提交回调可能稍后到达；立即释放设备，回调仍只消费本次已采集音频。
      release(stream); stream = null
    } catch (error) { cancel(); options().notice('error', error) }
  }
  const start = async (): Promise<void> => {
    if (disposed || phase !== 'idle' || !options().canStart()) return
    if (typeof navigator.mediaDevices?.getUserMedia !== 'function' || typeof MediaRecorder === 'undefined') {
      options().notice('unsupported'); return
    }
    const token = ++generation
    phase = 'acquiring'
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!current(token) || !options().canStart()) {
        release(acquired)
        if (current(token)) { phase = 'idle'; idle() }
        return
      }
      stream = acquired
      let next: MediaRecorder
      try { next = new MediaRecorder(acquired, { mimeType: 'audio/webm;codecs=opus' }) }
      catch { next = new MediaRecorder(acquired) }
      recorder = next; chunks = []; bytes = 0
      next.ondataavailable = (event) => {
        if (!current(token) || event.data.size === 0) return
        bytes += event.data.size
        if (bytes > MAX_AUDIO_BYTES) { cancel(); options().notice('error', new Error('录音超过 12 MiB / 錄音超過 12 MiB / Recording exceeds 12 MiB')); return }
        chunks.push(event.data)
      }
      next.onerror = () => {
        if (!current(token)) return
        cancel(); options().notice('error', new Error('录音失败 / 錄音失敗 / Recording failed'))
      }
      next.onstop = () => {
        if (!current(token)) { release(acquired); return }
        clearTimer(); release(acquired); stream = null; recorder = null
        next.ondataavailable = null; next.onerror = null; next.onstop = null
        phase = 'transcribing'; options().recording(false)
        const audio = new Blob(chunks, { type: next.mimeType || 'audio/webm' })
        chunks = []; bytes = 0
        void (async () => {
          try {
            if (audio.size < 1024) return
            if (!current(token)) return
            options().notice('listening'); options().status('thinking')
            const data = new Uint8Array(await audio.arrayBuffer())
            if (!current(token)) return
            const result = await options().transcribe(data, (next.mimeType || 'audio/webm').split(';')[0])
            if (!current(token)) return
            options().notice('clear')
            if (result.ok && result.text) await options().send(result.text, () => current(token))
            else if (!result.ok) options().notice('error', result.error ?? '')
          } catch (error) { if (current(token)) options().notice('error', error) }
          finally { if (current(token)) { phase = 'idle'; idle() } }
        })()
      }
      next.start(250) // 定期检查字节上限，不能只在 60 秒结束后才发现超限。
      phase = 'recording'; options().recording(true); options().notice('clear'); options().status('listening')
      timer = setTimeout(stop, MAX_RECORD_MS)
    } catch (error) {
      if (current(token)) { cancel(); options().notice('error', error) }
    }
  }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    cancel()
    window.removeEventListener('pagehide', dispose)
  }
  window.addEventListener('pagehide', dispose)
  return {
    start, stop,
    async toggle() { if (phase === 'acquiring' || phase === 'recording') stop(); else await start() },
    cancel, dispose,
  }
}

export function isTauriVoiceDesktop(): boolean {
  return '__TAURI_INTERNALS__' in window && window.api.platform === 'win32'
}

/** 先注册监听再读取布尔快照；事件使迟到快照失效，卸载后迟到 unlisten 也会立即执行。 */
export function watchAiVoiceEnabled(receive: (enabled: boolean) => void): () => void {
  let disposed = false, eventReceived = false
  let off: (() => void) | undefined
  void (async () => {
    try {
      const [{ listen }, { nativeInvoke }] = await Promise.all([
        import('@tauri-apps/api/event'), import('../../../tauri/native-invoke'),
      ])
      if (disposed) return
      const unsubscribe = await listen<{ channel?: string; payload?: unknown }>('launcher:event', ({ payload }) => {
        if (disposed || payload?.channel !== 'ai:voiceState' || typeof payload.payload !== 'boolean') return
        eventReceived = true; receive(payload.payload)
      })
      if (disposed) { unsubscribe(); return }
      off = unsubscribe
      const enabled = await nativeInvoke<unknown>('launcher_call', { channel: 'ai:voiceState', args: [] })
      if (!disposed && !eventReceived && typeof enabled === 'boolean') receive(enabled)
    } catch { if (!disposed && !eventReceived) receive(false) }
  })()
  return () => { disposed = true; try { off?.() } catch { /* 已失活的监听不再写入 */ } }
}

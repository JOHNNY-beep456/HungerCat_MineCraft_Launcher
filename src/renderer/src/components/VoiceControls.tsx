import { useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from '../store'
import { describeMicError } from '../multiplayer/voice'
import { Icon, Select } from './ui'

/**
 * 语音 / 浮层控制条（共用组件）。
 *
 * 同时用于「联机」主界面与大厅悬浮窗，保证两处的开关口径完全一致：
 *   - 麦克风 / 全局静音：主进程持有状态，读写 IPC（任意界面开关都会广播到所有窗口）；
 *   - 变声器 / HUD 浮层 / 消息弹幕：写入设置，主进程据此调整语音引擎与浮层窗口。
 *
 * `compact` 为悬浮窗等窄容器准备：字号更小、间距更紧凑。
 */
export function VoiceControls({ compact = false }: { compact?: boolean }): JSX.Element {
  const { t, settings, updateSettings } = useApp()
  const [micEnabled, setMicEnabled] = useState(false)
  const [globalMuted, setGlobalMuted] = useState(false)
  /**
   * 语音引擎的错误提示（麦克风被拒 / 设备占用 / 连接失败）。
   *
   * 必须有这个出口：引擎失败原先只写进控制台，界面上毫无反应，
   * 用户看到的就是「点了开麦没用」，既不知道原因也无从处理。
   */
  const [voiceError, setVoiceError] = useState('')

  /** 可选音频设备列表（无权限时 label 多为空串，用「麦克风 N」兜底展示）。 */
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  /** 麦克风测试：是否进行中 / 实时音量 0–1 / 错误提示。 */
  const [testing, setTesting] = useState(false)
  const [level, setLevel] = useState(0)
  const [testError, setTestError] = useState('')
  const testStreamRef = useRef<MediaStream | null>(null)
  const testCtxRef = useRef<AudioContext | null>(null)
  const testAnalyserRef = useRef<AnalyserNode | null>(null)
  const testRafRef = useRef(0)

  /** 重新枚举音频设备（权限变化 / 插拔设备后调用）。 */
  const refreshDevices = useCallback(async (): Promise<void> => {
    try {
      setDevices(await navigator.mediaDevices.enumerateDevices())
    } catch {
      /* 枚举失败不影响语音本身 */
    }
  }, [])

  useEffect(() => {
    void refreshDevices()
    // 插入 / 拔出设备时刷新列表；labels 在取得权限后才会出现，测试成功时也会重枚举。
    const md = navigator.mediaDevices
    const onChange = (): void => void refreshDevices()
    md?.addEventListener?.('devicechange', onChange)
    return () => md?.removeEventListener?.('devicechange', onChange)
  }, [refreshDevices])

  /** 停止麦克风测试：断开采集、关闭上下文、停掉动画帧。 */
  const stopMicTest = useCallback((): void => {
    if (testRafRef.current) {
      cancelAnimationFrame(testRafRef.current)
      testRafRef.current = 0
    }
    testStreamRef.current?.getTracks().forEach((tr) => tr.stop())
    testStreamRef.current = null
    if (testCtxRef.current) {
      void testCtxRef.current.close().catch(() => undefined)
      testCtxRef.current = null
    }
    testAnalyserRef.current = null
    setLevel(0)
    setTesting(false)
  }, [])

  /**
   * 开始麦克风测试：用当前选定的麦克风采集，实时显示音量条。
   *
   * 只接到 AnalyserNode，**绝不**接到 destination —— 否则会把自己的声音外放形成啸叫。
   * 这个功能同时是「语音没声音」的诊断手段：音量条不动就说明采集侧（设备 / 权限 / 驱动）有问题。
   */
  const startMicTest = useCallback(async (): Promise<void> => {
    setTestError('')
    stopMicTest()
    try {
      const audio: MediaTrackConstraints = {}
      if (settings.multiplayerMicDeviceId) audio.deviceId = { exact: settings.multiplayerMicDeviceId }
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false })
      const ctx = new AudioContext()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      testStreamRef.current = stream
      testCtxRef.current = ctx
      testAnalyserRef.current = analyser
      setTesting(true)
      const data = new Float32Array(analyser.fftSize)
      const tick = (): void => {
        const a = testAnalyserRef.current
        if (!a) return
        a.getFloatTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
        const rms = Math.sqrt(sum / data.length)
        // 放大 6 倍便于观察小声说话，上限 1。
        setLevel(Math.min(1, rms * 6))
        testRafRef.current = requestAnimationFrame(tick)
      }
      testRafRef.current = requestAnimationFrame(tick)
      // 取得权限后设备标签才可见，重枚举一次让下拉显示真实设备名。
      void refreshDevices()
    } catch (err) {
      setTestError(describeMicError(err))
      stopMicTest()
    }
  }, [settings.multiplayerMicDeviceId, refreshDevices, stopMicTest])

  // 卸载时务必停掉测试，避免残留占用麦克风。
  useEffect(() => stopMicTest, [stopMicTest])

  useEffect(() => {
    let alive = true
    void Promise.all([window.api.mp.getMicEnabled(), window.api.mp.getGlobalMuted()]).then(([m, g]) => {
      if (alive) {
        setMicEnabled(m)
        setGlobalMuted(g)
      }
    })
    const offMic = window.api.mp.onMicChanged((v) => setMicEnabled(v))
    const offMute = window.api.mp.onGlobalMutedChanged((v) => setGlobalMuted(v))
    // 开麦成功即清掉上一次的错误，避免旧提示一直挂着。
    const offErr = window.api.mp.onVoiceError((msg) => setVoiceError(msg))
    return () => {
      alive = false
      offMic()
      offMute()
      offErr()
    }
  }, [])

  const toggleMic = async (): Promise<void> => {
    const next = !micEnabled
    setMicEnabled(next)
    // 成功则清空错误；失败时主进程会广播 onVoiceError（这里不必自行处理）。
    if (next) setVoiceError('')
    await window.api.mp.setMicEnabled(next).catch(() => undefined)
  }
  const toggleMute = (): void => {
    const next = !globalMuted
    setGlobalMuted(next)
    void window.api.mp.setGlobalMuted(next)
  }

  // 窄容器下统一收敛的尺寸参数。
  const text = compact ? 'text-[12px]' : 'text-[13px]'
  const pad = compact ? 'px-2.5 py-1.5' : 'px-3 py-2'
  const gap = compact ? 'gap-1.5' : 'gap-2'

  /** 设备下拉选项：首项「系统默认」用空串表示；label 为空时用「麦克风/扬声器 N」占位。 */
  const buildDeviceOptions = (
    list: MediaDeviceInfo[],
    fallback: string
  ): Array<{ value: string; label: string }> => [
    { value: '', label: t('mp.voice.deviceDefault') },
    ...list.map((d, i) => ({ value: d.deviceId, label: d.label || `${fallback} ${i + 1}` }))
  ]
  const inputOptions = buildDeviceOptions(
    devices.filter((d) => d.kind === 'audioinput'),
    t('mp.voice.deviceMic')
  )
  const outputOptions = buildDeviceOptions(
    devices.filter((d) => d.kind === 'audiooutput'),
    t('mp.voice.deviceSpeaker')
  )

  return (
    <div className={compact ? 'flex flex-col gap-2' : 'contents'}>
      {/* 麦克风 / 全局静音 */}
      <div className={`flex flex-wrap ${gap} ${compact ? '' : 'mb-2.5'}`}>
        <button
          className={`glass-soft no-drag flex items-center gap-1.5 rounded-xl ${pad} ${text} transition-transform active:scale-[0.97]`}
          style={{
            color: micEnabled ? 'var(--fill-success, #5fd39a)' : undefined,
            borderColor: micEnabled ? 'var(--fill-success, #5fd39a)' : undefined
          }}
          onClick={() => void toggleMic()}
          title={t('mp.voice.mic')}
        >
          <Icon name="mic" size={compact ? 13 : 15} />
          {micEnabled ? t('mp.voice.micOn') : t('mp.voice.micOff')}
        </button>
        <button
          className={`glass-soft no-drag flex items-center gap-1.5 rounded-xl ${pad} ${text} transition-transform active:scale-[0.97]`}
          style={{
            color: globalMuted ? 'var(--fill-danger, #e5484d)' : undefined,
            borderColor: globalMuted ? 'var(--fill-danger, #e5484d)' : undefined
          }}
          onClick={toggleMute}
          title={t('mp.voice.globalMute')}
        >
          <Icon name="stop" size={compact ? 13 : 15} />
          {globalMuted ? t('mp.voice.muted') : t('mp.voice.speaking')}
        </button>
      </div>

      {/* 设备选择：麦克风 / 扬声器（跨设备时「默认设备不一定是想要的」很常见） */}
      <div className={`flex flex-col ${gap} ${compact ? '' : 'mb-2'}`}>
        <div className="flex items-center gap-2">
          <span className={`shrink-0 ${text} font-medium`}>{t('mp.voice.micDevice')}</span>
          <div className="min-w-0 flex-1">
            <Select
              value={settings.multiplayerMicDeviceId}
              onChange={(v) => void updateSettings({ multiplayerMicDeviceId: v })}
              options={inputOptions}
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`shrink-0 ${text} font-medium`}>{t('mp.voice.speakerDevice')}</span>
          <div className="min-w-0 flex-1">
            <Select
              value={settings.multiplayerSpeakerDeviceId}
              onChange={(v) => void updateSettings({ multiplayerSpeakerDeviceId: v })}
              options={outputOptions}
            />
          </div>
        </div>
      </div>

      {/* 麦克风测试：本地采集的实时音量条，用来确认「说话到底有没有被采集到」 */}
      <div className={`flex flex-wrap items-center ${gap} ${compact ? '' : 'mb-2'}`}>
        <button
          className={`glass-soft no-drag flex items-center gap-1.5 rounded-xl ${pad} ${text} transition-transform active:scale-[0.97]`}
          style={{
            color: testing ? 'var(--fill-success, #5fd39a)' : undefined,
            borderColor: testing ? 'var(--fill-success, #5fd39a)' : undefined
          }}
          onClick={() => (testing ? stopMicTest() : void startMicTest())}
        >
          <Icon name="mic" size={compact ? 13 : 15} />
          {testing ? t('mp.voice.micTestStop') : t('mp.voice.micTest')}
        </button>
        {testing && (
          <div className="min-w-[80px] flex-1">
            <div
              className="h-1.5 w-full overflow-hidden rounded-full"
              style={{ background: 'var(--fill-muted, rgba(127,127,127,0.25))' }}
            >
              <div
                className="h-full rounded-full transition-[width] duration-75"
                style={{ width: `${Math.round(level * 100)}%`, background: 'var(--fill-success, #5fd39a)' }}
              />
            </div>
          </div>
        )}
      </div>
      {testing && (
        <div className={`${compact ? '' : 'mb-2.5'} ${text} opacity-70`}>
          {level < 0.02 ? t('mp.voice.micTestSilent') : t('mp.voice.micTestHint')}
        </div>
      )}
      {testError && (
        <div
          className={`${compact ? '' : 'mb-2.5'} ${text}`}
          style={{ color: 'var(--text-warning, #f0b34a)' }}
          role="alert"
        >
          {testError}
        </div>
      )}

      {/* 语音错误提示：麦克风被拒 / 被占用 / 连接失败等，给出可操作的处理建议 */}
      {voiceError && (
        <div
          className={`mb-2.5 flex items-start gap-1.5 rounded-xl px-3 py-2 ${text}`}
          style={{
            background: 'var(--fill-warning-soft, rgba(240,179,74,0.12))',
            color: 'var(--text-warning, #f0b34a)'
          }}
          role="alert"
        >
          <Icon name="info" size={compact ? 13 : 15} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1 leading-relaxed">{voiceError}</span>
          <button
            type="button"
            aria-label={t('mp.voice.errorClose')}
            title={t('mp.voice.errorClose')}
            className="shrink-0 opacity-70 transition-opacity hover:opacity-100"
            onClick={() => setVoiceError('')}
          >
            <Icon name="xmark" size={compact ? 12 : 14} />
          </button>
        </div>
      )}

      {/* 变声器 */}
      <div className={`flex items-center gap-2 ${compact ? '' : 'mb-2'}`}>
        <span className={`shrink-0 ${text} font-medium`}>{t('mp.voice.changer')}</span>
        <div className="min-w-0 flex-1">
          <Select
            value={settings.multiplayerVoiceChanger}
            onChange={(v) => void updateSettings({ multiplayerVoiceChanger: v })}
            options={[
              { value: 'off', label: t('mp.set.voiceOff') },
              { value: 'loli', label: t('mp.set.voiceLoli') },
              { value: 'uncle', label: t('mp.set.voiceUncle') },
              { value: 'cute', label: t('mp.set.voiceCute') },
              { value: 'deep', label: t('mp.set.voiceDeep') }
            ]}
          />
        </div>
      </div>

      {/* 浮层开关 */}
      <div className={`flex flex-wrap ${gap}`}>
        <button
          className={`glass-soft no-drag flex items-center gap-1.5 rounded-xl ${pad} ${text} transition-transform active:scale-[0.97]`}
          style={{
            color: settings.multiplayerHudEnabled ? 'var(--fill-primary)' : undefined,
            borderColor: settings.multiplayerHudEnabled ? 'var(--fill-primary)' : undefined
          }}
          onClick={() => void updateSettings({ multiplayerHudEnabled: !settings.multiplayerHudEnabled })}
        >
          <Icon name="wifi" size={compact ? 13 : 15} />
          {t('mp.voice.hud')} {settings.multiplayerHudEnabled ? 'ON' : 'OFF'}
        </button>
        <button
          className={`glass-soft no-drag flex items-center gap-1.5 rounded-xl ${pad} ${text} transition-transform active:scale-[0.97]`}
          style={{
            color: settings.multiplayerDanmakuEnabled ? 'var(--fill-primary)' : undefined,
            borderColor: settings.multiplayerDanmakuEnabled ? 'var(--fill-primary)' : undefined
          }}
          onClick={() => void updateSettings({ multiplayerDanmakuEnabled: !settings.multiplayerDanmakuEnabled })}
        >
          <Icon name="message" size={compact ? 13 : 15} />
          {t('mp.voice.danmaku')} {settings.multiplayerDanmakuEnabled ? 'ON' : 'OFF'}
        </button>
      </div>
    </div>
  )
}

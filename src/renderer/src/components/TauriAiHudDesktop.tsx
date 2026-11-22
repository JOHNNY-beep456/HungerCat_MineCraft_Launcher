import { useEffect } from 'react'
import { TauriAiHudCard, useAiHudState } from './TauriAiHud'
import { LyricsHudCard, useLyricsHudState } from './LyricsHudCard'
import { MultiplayerHudCard, useMultiplayerHudState } from './MultiplayerHudCard'
import { createAiVoiceRecorder, isTauriVoiceDesktop, watchAiVoiceEnabled } from './ai-voice-toggle'

/** 桌面窗口的命令消费者与只读卡片分离；移动 / 内嵌视图不导入本组件。 */
export function TauriAiHudDesktop(): JSX.Element {
  const ai = useAiHudState()
  const lyrics = useLyricsHudState()
  const multiplayer = useMultiplayerHudState()
  useEffect(() => {
    if (!isTauriVoiceDesktop()) return
    let enabled = false, disposed = false
    const voice = createAiVoiceRecorder(() => ({
      canStart: () => enabled && !disposed,
      recording: () => undefined,
      status: (status) => {
        if (!disposed) void window.api.ai.setHudStatus(status).catch(() => undefined)
      },
      // 卡片显示后端的状态；错误不写进回复，不增加另一套外观或泄露原始异常。
      notice: () => undefined,
      transcribe: (bytes, mime) => window.api.ai.transcribe(bytes, mime),
      async send(text, current) {
        if (!enabled || disposed || !current()) return
        await window.api.ai.chat(text, '用户正在游戏内通过热键语音提问。')
      },
    }))
    const offState = watchAiVoiceEnabled((value) => {
      enabled = value
      if (!enabled) voice.cancel()
    })
    const offToggle = window.api.ai.onVoiceToggle(() => { void voice.toggle() })
    // 游戏结束 / HUD 开关关闭先取消本页采集，不等待异步窗口销毁完成。
    const offHud = window.api.ai.onHudState((state) => { if (!state.enabled) voice.cancel() })
    return () => {
      disposed = true; enabled = false
      offHud(); offToggle(); offState(); voice.dispose()
    }
  }, [])
  return (
    <div className="h-screen w-screen space-y-2 p-2" style={{ pointerEvents: 'none', userSelect: 'none' }}>
      <MultiplayerHudCard state={multiplayer} opacity={multiplayer?.opacity} />
      <TauriAiHudCard state={ai} stacked />
      <LyricsHudCard state={lyrics} opacity={ai?.opacity ?? 0.8} />
    </div>
  )
}

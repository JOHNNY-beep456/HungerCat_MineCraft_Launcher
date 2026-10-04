import { useApp } from '../store'
import { Icon } from './ui'
import { VoiceControls } from './VoiceControls'

/**
 * 大厅内的「语音与浮层」卡片（主界面用）。
 *
 * 具体控件收敛在共用组件 VoiceControls 中，保证与大厅悬浮窗内的同名开关口径一致。
 */
export function MultiplayerVoiceControls(): JSX.Element {
  const { t } = useApp()

  return (
    <div className="glass relative z-0 w-full rounded-[24px] p-4">
      <div className="mb-2.5 flex items-center gap-2">
        <Icon name="mic" size={16} style={{ color: 'var(--fill-primary)' }} />
        <span className="headline">{t('mp.voice.title')}</span>
      </div>
      <VoiceControls />
    </div>
  )
}

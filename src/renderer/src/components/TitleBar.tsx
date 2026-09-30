import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { Icon } from './ui'
import { useApp } from '../store'
import { translateStatus, useTranslateState, type TranslateState } from '../translate-status'
import logo from '../assets/logo.png'

/** 呼吸灯颜色与是否闪烁（灰=静态、橙/绿=闪烁、红=静态）。 */
const TRANSLATE_LIGHT: Record<TranslateState, { color: string; pulse: boolean; key: string }> = {
  off: { color: '#8e8e93', pulse: false, key: 'translate.status.off' },
  none: { color: '#8e8e93', pulse: false, key: 'translate.status.none' },
  translating: { color: '#ff9f0a', pulse: true, key: 'translate.status.translating' },
  done: { color: '#30d158', pulse: true, key: 'translate.status.done' },
  error: { color: '#ff453a', pulse: false, key: 'translate.status.error' }
}

export function TitleBar({ onLogoDoubleClick }: { onLogoDoubleClick?: () => void }): JSX.Element {
  const { t, settings, locale } = useApp()
  const isMac = window.api.platform === 'darwin'
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.api.window.isMaximized().then(setMaximized)
  }, [])

  // 与 useAutoTranslate 的判定保持一致：设置开启、非本地模式、非英语界面时才算启用。
  const translateEnabled = !!settings.autoTranslateResources && settings.mode !== 'local' && locale !== 'en'
  useEffect(() => {
    translateStatus.setEnabled(translateEnabled)
    translateStatus.setLocale(locale)
  }, [translateEnabled, locale])
  const translateState = useTranslateState()
  const light = TRANSLATE_LIGHT[translateState]

  return (
    <header className="titlebar-drag fixed top-0 left-0 right-0 z-50 flex h-12 items-center px-3">
      {/* On macOS the native traffic lights live in the top-left corner. */}
      {isMac && <div className="w-[76px]" />}

      <div className="flex items-center gap-2 opacity-90">
        <img
          src={logo}
          width={22}
          height={22}
          alt=""
          className="h-[22px] w-[22px] rounded-[6px] object-contain no-drag"
          draggable={false}
          onDoubleClick={onLogoDoubleClick}
          title={onLogoDoubleClick ? t('titlebar.reopenOnboarding') : undefined}
        />
        <span className="text-[13px] font-semibold tracking-tight">HungerCat MineCraft Launcher</span>

        {/* 翻译状态呼吸灯：灰=未开启/无需翻译（静止），橙=翻译中、绿=已翻译（闪烁），红=出错（静止）。 */}
        <span
          className="ml-1 flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
          style={{ background: 'var(--fill-secondary)', color: 'var(--text-secondary)' }}
          title={t(light.key)}
        >
          <span
            className={`translate-dot${light.pulse ? ' translate-dot--pulse' : ''}`}
            style={{ '--dot-color': light.color } as CSSProperties}
          />
          {t(light.key)}
        </span>
      </div>

      <div className="flex-1" />

      {!isMac && (
        <div className="no-drag flex items-center gap-1">
          <WinButton label={t('titlebar.minimize')} onClick={() => window.api.window.minimize()}>
            <Icon name="download" size={15} className="rotate-180" />
          </WinButton>
          <WinButton
            label={maximized ? t('titlebar.restore') : t('titlebar.maximize')}
            onClick={() => {
              void window.api.window.maximize()
              setMaximized((v) => !v)
            }}
          >
            {maximized ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="6" y="6" width="12" height="12" rx="1" />
                <path d="M9 6V5a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2h-1" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="5" y="5" width="14" height="14" rx="1" />
              </svg>
            )}
          </WinButton>
          <WinButton label={t('titlebar.close')} danger onClick={() => window.api.window.close()}>
            <Icon name="xmark" size={16} />
          </WinButton>
        </div>
      )}
    </header>
  )
}

function WinButton({
  children,
  onClick,
  danger,
  label
}: {
  children: ReactNode
  onClick: () => void
  danger?: boolean
  label: string
}): JSX.Element {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-7 w-10 items-center justify-center rounded-lg transition-colors duration-150"
      style={{ color: 'var(--text-secondary)' }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = danger ? '#ff453a' : 'var(--fill-secondary)'
        e.currentTarget.style.color = danger ? '#fff' : 'var(--text-primary)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
        e.currentTarget.style.color = 'var(--text-secondary)'
      }}
    >
      {children}
    </button>
  )
}

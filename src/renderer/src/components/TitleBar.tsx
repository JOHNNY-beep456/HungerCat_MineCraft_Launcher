import { useEffect, useState, type ReactNode } from 'react'
import { Icon } from './ui'
import logo from '../assets/logo.png'

export function TitleBar(): JSX.Element {
  const isMac = window.api.platform === 'darwin'
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.api.window.isMaximized().then(setMaximized)
  }, [])

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
          className="h-[22px] w-[22px] rounded-[6px] object-contain"
          draggable={false}
        />
        <span className="text-[13px] font-semibold tracking-tight">Hunger Cat Launcher</span>
      </div>

      <div className="flex-1" />

      {!isMac && (
        <div className="no-drag flex items-center gap-1">
          <WinButton label="最小化" onClick={() => window.api.window.minimize()}>
            <Icon name="download" size={15} className="rotate-180" />
          </WinButton>
          <WinButton
            label={maximized ? '还原' : '最大化'}
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
          <WinButton label="关闭" danger onClick={() => window.api.window.close()}>
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

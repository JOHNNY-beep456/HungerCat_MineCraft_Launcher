import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { Icon } from './ui'
import { useApp } from '../store'
import { translateStatus, useTranslateState, type TranslateState } from '../translate-status'

/**
 * 启动器 logo 的 URL。
 *
 * logo 放在 `src/renderer/public/` 而不是 `src/renderer/src/assets/`，是为了让**安装向导
 * 也能引用同一份文件**（`src/renderer/public/installer/index.html` 里用的是
 * `../logo.png`）。走 Vite 的资源导入会生成带哈希的文件名，安装向导那套非 Vite 编写的
 * HTML 没法稳定引用；而安装模式只加载 `out/renderer/installer/index.html` 那一页，
 * 启动器自己的 `assets/logo-<hash>.png` 不会被用到 —— 两份同图会各占一份体积。
 *
 * `public/` 内容原样落到 `out/renderer/logo.png`；渲染层构建 base 为 `./`，
 * 故 BASE_URL + 'logo.png' 即 `<启动器目录>/logo.png`，与原先的导入结果一致。
 */
const logo = `${import.meta.env.BASE_URL}logo.png`

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
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.api.window.isMaximized().then(setMaximized)
  }, [])

  // 与 useAutoTranslate 的判定保持一致：设置开启、非本地模式时即视为启用（英语界面也启用）。
  const translateEnabled = !!settings.autoTranslateResources && settings.mode !== 'local'
  useEffect(() => {
    translateStatus.setEnabled(translateEnabled)
    translateStatus.setLocale(locale)
  }, [translateEnabled, locale])
  const translateState = useTranslateState()
  const light = TRANSLATE_LIGHT[translateState]

  return (
    <header className="titlebar-drag fixed top-0 left-0 right-0 z-50 flex h-12 items-center px-3">
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
    </header>
  )
}

/**
 * 窗口控制按钮。
 *
 * 形状与配色**全部交给 CSS**（`.winbtn` / `.winbtn--danger` + `--winbtn-*` 令牌），
 * 组件只负责「点哪个」。之前这里是 `rounded-lg` + 内联 `#ff453a` 写死的，
 * 于是无论切到哪套皮肤都是 8px 圆角 + 同一档苹果红，与皮肤本身的设计语言对不上。
 */
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
      className={`winbtn${danger ? ' winbtn--danger' : ''}`}
    >
      {children}
    </button>
  )
}

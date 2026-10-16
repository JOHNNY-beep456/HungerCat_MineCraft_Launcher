/**
 * GitHub（Primer）配色的**预览卡**。
 *
 * 每张卡在自己的元素上挂 `data-gh-theme`，因此五张卡能同时显示五套配色 ——
 * 因为 index.css 里五套令牌正是挂在同一个属性值下的，卡片自带一份作用域即可。
 *
 * 悬停 / 键盘聚焦时把该档写进 app 上下文的 githubPreview，整个界面会立即切到
 * 那一档（渲染层解析后写到 <html> 的 data-gh-theme 上）。移开即恢复设置里的取值。
 * 预览只改 DOM 属性、不写设置 —— 「只是看一眼」不该变成真的改了配置。
 *
 * 点击则是确认应用。
 */
import { useApp } from '../../store'
import type { LauncherSettings } from '@shared/types'

/** 可预览的五个 Primer 配色（不含 system：system 跟随主题，没有独立配色可看）。 */
const PREVIEWABLE: Array<{ id: Exclude<LauncherSettings['githubStyle'], 'system'>; labelKey: string }> = [
  { id: 'light', labelKey: 'settings.exp.github.light' },
  { id: 'dark', labelKey: 'settings.exp.github.dark' },
  { id: 'dimmed', labelKey: 'settings.exp.github.dimmed' },
  { id: 'light-hc', labelKey: 'settings.exp.github.lightHc' },
  { id: 'dark-hc', labelKey: 'settings.exp.github.darkHc' }
]

export function GithubSkinPreview(): JSX.Element {
  const { settings, updateSettings, t, setGithubPreview } = useApp()
  const active = settings.githubStyle

  return (
    <div className="mt-1 grid grid-cols-2 gap-2.5 lg:grid-cols-3">
      {PREVIEWABLE.map((p) => {
        const isActive = active === p.id
        return (
          <button
            key={p.id}
            type="button"
            aria-pressed={isActive}
            data-gh-theme={p.id}
            className="no-drag group overflow-hidden rounded-[10px] text-left transition-transform hover:-translate-y-0.5"
            style={{
              // 卡面本身用该档的 canvas-default，与真实界面同源。
              // 描边用该档自己的 border-default，选中的那一档换成强调色 —— 每张卡都自带
              // 一份 --gh-* 作用域（靠它自己的 data-gh-theme），所以这里的 var() 解析到的
              // 正是它要展示的那一档，不会串到当前生效的配色上。
              background: 'var(--gh-canvas-default)',
              border: `2px solid var(${isActive ? '--gh-accent-emphasis' : '--gh-border-muted'})`,
              opacity: active === 'system' ? 1 : isActive ? 1 : 0.68
            }}
            onPointerEnter={() => setGithubPreview(p.id)}
            onPointerLeave={() => setGithubPreview(null)}
            onFocus={() => setGithubPreview(p.id)}
            onBlur={() => setGithubPreview(null)}
            onClick={() => void updateSettings({ githubStyle: p.id })}
          >
            {/* 缩略界面：左侧栏 + 内容区。刻意只画 Primer 的关键构件 —— 画布、描边、
                次级画布、强调色实底按钮、accent-subtle 标签、以及一道焦点环。 */}
            <div className="flex h-[74px]">
              <div
                className="w-[26%] shrink-0"
                style={{
                  background: 'var(--gh-canvas-subtle)',
                  borderRight: 'var(--gh-border-width) solid var(--gh-border-default)'
                }}
              >
                {/* 侧栏选中项：accent 左边条 + 强调色文字 */}
                <div className="flex items-center" style={{ borderLeft: '2px solid var(--gh-accent-emphasis)' }}>
                  <span
                    className="ml-1.5 truncate text-[7px] leading-[13px]"
                    style={{ color: 'var(--gh-accent-fg)' }}
                  >
                    Nav
                  </span>
                </div>
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-2">
                <div className="flex items-center gap-1.5">
                  <span
                    className="rounded-[3px] px-1.5 text-[7px] font-medium leading-[14px]"
                    style={{ background: 'var(--gh-accent-emphasis)', color: 'var(--gh-on-emphasis)' }}
                  >
                    Primary
                  </span>
                  <span
                    className="rounded-[3px] px-1.5 text-[7px] font-medium leading-[14px]"
                    style={{
                      background: 'var(--gh-accent-subtle)',
                      color: 'var(--gh-accent-fg)',
                      boxShadow: '0 0 0 1px var(--gh-border-default)'
                    }}
                  >
                    Secondary
                  </span>
                </div>
                <div
                  className="rounded-[3px]"
                  style={{
                    background: 'var(--gh-canvas-default)',
                    border: 'var(--gh-border-width) solid var(--gh-border-default)',
                    boxShadow: 'var(--gh-shadow-rest)'
                  }}
                >
                  <div
                    className="rounded-[3px]"
                    style={{ outline: '2px solid var(--gh-accent-fg)', outlineOffset: '-1px' }}
                  >
                    <span className="block h-[9px] px-1 text-[6px] leading-[9px]" style={{ color: 'var(--gh-fg-default)' }}>
                      Card
                    </span>
                  </div>
                </div>
              </div>
            </div>
            {/* 分隔线用 border-muted，与真实界面的 --divider 同源 */}
            <div
              className="flex items-center justify-between px-2 py-1.5"
              style={{ borderTop: 'var(--gh-border-width) solid var(--gh-border-muted)' }}
            >
              <span className="text-[10px] font-medium leading-none" style={{ color: 'var(--gh-fg-default)' }}>
                {t(p.labelKey)}
              </span>
              {isActive && (
                <span className="text-[9px] leading-none" style={{ color: 'var(--gh-accent-fg)' }}>
                  ✓
                </span>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}
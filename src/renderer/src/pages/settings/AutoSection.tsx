import { Fragment, type ReactNode } from 'react'
import type { LauncherSettings } from '@shared/types'
import { sectionFields, type SettingDisableWhen, type SettingUIRow } from '@shared/settings'
import { useApp } from '../../store'
import { Segmented, Select, Switch } from '../../components/ui'
import { Row, Section } from './parts'
import { CUSTOM_ROWS } from './rows'

/**
 * 数字输入框的取值钳制。
 *
 * 直接写 `Number(v) || 8` 有两个坑：清空输入框或输入 0 会被静默改成 8（用户以为
 * 生效了其实没有），而手输超过 max 的值又会被原样保存（`max` 只约束上下箭头）。
 * 这里统一：非法 / 空值 / 0 一律回落到上一次的有效值，合法值夹到 [min, max]。
 */
function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 求值「何时禁用」条件（纯数据枚举 → 依据当前设置判断）。 */
function isDisabled(when: SettingDisableWhen[] | undefined, s: LauncherSettings): boolean {
  if (!when || when.length === 0) return false
  return when.some((c) => {
    if (c === 'local') return s.mode === 'local'
    if (c === 'autoThemeFromWallpaper') return s.autoThemeFromWallpaper
    if (c === 'autoTranslateOff') return !s.autoTranslateResources
    return false
  })
}

/**
 * **数据驱动的设置字段列表**（不含板块外壳）。
 *
 * 全部从共享注册表 `@shared/settings` 的 `sectionFields(section)` 读取：
 *   · 标准控件（number / switch / segmented / select）直接按 `ui` 元数据渲染；
 *   · `control: 'custom'` 的字段交给渲染层 `CUSTOM_ROWS` 里对应的行组件。
 * 因此新增一项设置只要改注册表（简单项无需任何组件代码），板块布局无需改动。
 */
export function AutoFields({ section }: { section: string }): JSX.Element {
  const { settings, updateSettings, t } = useApp()
  const fields = sectionFields(section)

  /** 渲染一个标准控件。 */
  const renderControl = (ui: SettingUIRow, value: unknown, disabled: boolean, set: (v: unknown) => void): JSX.Element => {
    switch (ui.control) {
      case 'switch':
        return <Switch checked={Boolean(value)} disabled={disabled} onChange={set} />
      case 'number':
        return (
          <input
            type="number"
            min={ui.min}
            max={ui.max}
            value={Number(value)}
            disabled={disabled}
            onChange={(e) =>
              set(clampInt(e.target.value, ui.min ?? 0, ui.max ?? Number.MAX_SAFE_INTEGER, Number(value)))
            }
            className="input w-24"
          />
        )
      case 'segmented':
        return (
          <Segmented
            value={String(value)}
            disabled={disabled}
            onChange={set}
            options={(ui.options ?? []).map((o) => ({ value: o.value, label: t(o.labelKey) }))}
          />
        )
      case 'select':
        return (
          <Select
            value={String(value)}
            disabled={disabled}
            onChange={set}
            options={(ui.options ?? []).map((o) => ({ value: o.value, label: t(o.labelKey) }))}
          />
        )
    }
  }

  return (
    <>
      {fields.map(({ key, def }) => {
        const ui = def.ui
        if (!ui) return null
        // 自定义行组件（交互复杂的一行）。
        if (ui.control === 'custom') {
          const Comp = CUSTOM_ROWS[key]
          return Comp ? <Comp key={String(key)} /> : null
        }
        const disabled = ui.disabled || isDisabled(ui.disableWhen, settings)
        const set = (v: unknown): void => void updateSettings({ [key]: v } as Partial<LauncherSettings>)
        return (
          <Fragment key={String(key)}>
            <Row label={t(ui.labelKey)}>{renderControl(ui, settings[key], disabled, set)}</Row>
            {ui.hintKey && <p className="caption -mt-1">{t(ui.hintKey)}</p>}
          </Fragment>
        )
      })}
    </>
  )
}

/**
 * **数据驱动的设置板块**：板块外壳 + 自动渲染的字段 + 可选的自定义节点。
 *
 * @param section   板块 id（对应注册表 `ui.section`）
 * @param titleKey  板块标题的 i18n 键
 * @param icon      板块图标名
 * @param intro     字段之前的自定义节点（如置顶提示）
 * @param children  字段之后的整块自定义 UI（如「更新」板块的检测 / 下载区）
 * @param footnotes 末尾的整段说明（i18n 键，按顺序渲染）
 */
export function AutoSection({
  section,
  titleKey,
  icon,
  intro,
  children,
  footnotes
}: {
  section: string
  titleKey: string
  icon: string
  intro?: ReactNode
  children?: ReactNode
  footnotes?: string[]
}): JSX.Element {
  const { t } = useApp()
  return (
    <Section title={t(titleKey)} icon={icon}>
      {intro}
      <AutoFields section={section} />
      {children}
      {footnotes?.map((k) => (
        <p key={k} className="caption px-1">
          {t(k)}
        </p>
      ))}
    </Section>
  )
}

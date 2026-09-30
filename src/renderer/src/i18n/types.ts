/** i18n 基础类型与语言清单（从 index 拆出，避免 fragment 与 index 循环依赖）。 */

export type Locale = 'zh-CN' | 'zh-TW' | 'en'

/** 设置页语言选项（label 用各自母语书写，便于辨认）。 */
export const LOCALES: Array<{ value: Locale; label: string }> = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en', label: 'English' }
]

export function isLocale(v: unknown): v is Locale {
  return v === 'zh-CN' || v === 'zh-TW' || v === 'en'
}

/** 单个语言的「键 → 文案」字典。 */
export type LocaleDict = Record<Locale, Record<string, string>>

export type TFunction = (key: string, vars?: Record<string, string | number>) => string

/** 语言兜底顺序：目标语言 → 简体中文 → 键名。 */
export const FALLBACK: Locale = 'zh-CN'

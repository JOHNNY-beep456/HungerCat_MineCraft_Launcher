/**
 * i18n 基础类型。
 *
 * `Locale` 不再是固定字面量联合，而是普通 `string`：语言清单由 `index.ts` 通过
 * `import.meta.glob` 从 `locales/<语言>/meta.json` **自动发现**，新增一门语言只需
 * 新建目录并放入 JSON，无需改动任何代码（也就无需在此维护联合类型）。
 */

export type Locale = string

/** 单个语言的「键 → 文案」字典。 */
export type LocaleDict = Record<string, Record<string, string>>

export type TFunction = (key: string, vars?: Record<string, string | number>) => string

/** 语言兜底：目标语言缺词 → 简体中文 → 键名。 */
export const FALLBACK: Locale = 'zh-CN'

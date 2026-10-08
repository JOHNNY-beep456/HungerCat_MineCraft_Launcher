/**
 * 轻量 i18n：不引入第三方库。
 *
 * - 简体中文（zh-CN）为源语言，也是兜底语言；
 * - 目标语言缺失某个键时回落到简体中文，再缺失则原样返回键名（便于发现漏翻）；
 * - 键用点号分层（如 `nav.home`、`settings.language`）。
 *
 * 语言清单与词典**全部自动发现**，本文件不含任何语言名 / 分片名的硬编码：
 *   · `locales/<语言>/meta.json` 提供该语言的显示名与排序（`label` / `order`）；
 *   · `locales/<语言>/<域>.json` 是该语言的词典分片（`meta.json` 之外的都是分片）。
 * 因此新增一门语言 = 新建目录并放入 JSON，设置页的语言选项与界面文案会**自动**出现，
 * 无需改动本文件或任何其它代码。
 */
import { FALLBACK, type Locale, type LocaleDict, type TFunction } from './types'

/** 语言目录的元信息（`locales/<语言>/meta.json`）。 */
interface LocaleMeta {
  /** 显示名（用该语言母语书写，便于辨认），如「简体中文」。 */
  label: string
  /** 排序权重，越小越靠前；缺省排到最后。 */
  order?: number
}

/**
 * 自动收集所有语言目录下的元信息与词典分片。
 * `import` 选项取默认导出，JSON 会直接得到解析后的对象。
 */
const metaModules = import.meta.glob<LocaleMeta>('./locales/*/meta.json', {
  eager: true,
  import: 'default'
})
const dictModules = import.meta.glob<Record<string, string>>('./locales/*/*.json', {
  eager: true,
  import: 'default'
})

/** 从 glob 路径 `./locales/<语言>/<文件>.json` 解析出语言 id 与文件名。 */
function parsePath(path: string): { locale: string; file: string } | null {
  const m = /\/locales\/([^/]+)\/([^/]+)\.json$/.exec(path)
  return m ? { locale: m[1], file: m[2] } : null
}

/** 语言清单（设置页语言选项即由此渲染，新增语言自动出现）。 */
export const LOCALES: Array<{ value: Locale; label: string }> = Object.entries(metaModules)
  .map(([path, meta]) => {
    const parsed = parsePath(path)
    return parsed ? { value: parsed.locale, order: meta.order ?? Number.MAX_SAFE_INTEGER, label: meta.label } : null
  })
  .filter((x): x is { value: string; order: number; label: string } => x !== null)
  .sort((a, b) => a.order - b.order || a.value.localeCompare(b.value))
  .map(({ value, label }) => ({ value, label }))

const LOCALE_IDS = new Set(LOCALES.map((l) => l.value))

/** 判断某值是否是「已发现的语言 id」。 */
export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && LOCALE_IDS.has(v)
}

/**
 * 每种语言的分片集合，键为语言 id、值为该语言的全部分片。
 * 分片之间键前缀互不重叠，故合并顺序只在「同名键」时才有意义。
 */
const BUNDLES: Record<Locale, Array<Record<string, string>>> = {}
for (const [path, dict] of Object.entries(dictModules)) {
  const parsed = parsePath(path)
  if (!parsed || parsed.file === 'meta') continue
  ;(BUNDLES[parsed.locale] ??= []).push(dict)
}

/** 合并每种语言的全部分片，得到最终字典。 */
function buildDicts(): Record<Locale, Record<string, string>> {
  const out: Record<Locale, Record<string, string>> = {}
  for (const loc of Object.keys(BUNDLES)) {
    const dict: Record<string, string> = {}
    for (const part of BUNDLES[loc]) Object.assign(dict, part)
    out[loc] = dict
  }
  return out
}

const DICTS: LocaleDict = buildDicts()

/** 兜底语言：优先 zh-CN，被删则退到清单里的第一个语言。 */
const FALLBACK_LOCALE: Locale = DICTS[FALLBACK] ? FALLBACK : (LOCALES[0]?.value ?? FALLBACK)

/** 生成某语言的翻译函数：目标语言 → 简体中文 → 键名。 */
export function createTranslator(locale: Locale): TFunction {
  const dict = DICTS[locale] ?? DICTS[FALLBACK_LOCALE]
  const fallback = DICTS[FALLBACK_LOCALE]
  return (key, vars) => {
    let s = dict?.[key] ?? fallback?.[key] ?? key
    if (vars) {
      for (const k of Object.keys(vars)) s = s.split(`{${k}}`).join(String(vars[k]))
    }
    return s
  }
}

export type { Locale, TFunction }

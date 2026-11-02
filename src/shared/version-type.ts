/**
 * 版本「显示类型」判定。
 *
 * 官方版本清单只给 `release` / `snapshot` / `old_beta` / `old_alpha` 四种类型，
 * 而**愚人节版**（Minecraft 每年 4 月 1 日的玩笑版本）在清单里就是 `snapshot`，
 * 光看 type 分辨不出来。这里给出一套判定，供两处共用：
 *
 *   · 资源下载 → 版本列表的分栏（正式版 / 快照 / 愚人节版）；
 *   · 实例列表与管理页的「实例类型识别」（这个实例是什么版本）。
 *
 * ## 判定规则（按可靠性排序）
 *
 * 1. **已知 id 白名单** —— 最可靠。规则覆盖不到的要靠它，例如：
 *    - `2.0`（2013）在清单里是 `release` 类型，纯靠规则会被当成正式版；
 *    - `15w14a`（2015 Love and Hugs）符合标准快照格式 `YYwWWx`，规则也识别不出来。
 * 2. **格式启发式** —— 标准快照是 `YYwWWx`（如 `24w14a`），
 *    标准发行号是 `1.20.1` / `1.7.10`。愚人节版的 id 基本都会破坏这两种格式
 *    （`1.RV-Pre1`、`3D Shareware v1.34`、`20w14infinite`、`22w13oneBlockAtATime`、
 *    `23w13a_or_b`、`24w14potato`、`25w14craftmine`）。
 * 3. 没有 type 时（已安装实例只拿到 base mcVersion）只走 1 + 2。
 *
 * 说明：白名单是**人工维护**的，官方出新的愚人节版时未必第一时间收录；
 * 但第 2 条规则能兜住绝大多数新版本，所以白名单不是硬依赖。
 */

export type DisplayVersionType = 'release' | 'snapshot' | 'aprilfools' | 'old_beta' | 'old_alpha'

/** 已知愚人节版本 id（统一小写比较）。按年份排列，便于以后追加。 */
export const APRIL_FOOLS_IDS: ReadonlySet<string> = new Set([
  '2.0', // 2013 Minecraft 2.0（清单里是 release 类型）
  '15w14a', // 2015 Love and Hugs（格式与常规快照一致，只能靠白名单）
  '1.rv-pre1', // 2016 Trendy
  '3d shareware v1.34', // 2019
  '20w14infinite', // 2020
  '22w13oneblockatatime', // 2022
  '23w13a_or_b', // 2023 Vote Update
  '24w14potato', // 2024 Poisonous Potato
  '25w14craftmine', // 2025 Craftmine
  // 2011 的 "Minecraft 4k"、2010 的 "2.0.0" 等未进入官方清单，故不列
])

/** 标准发行号：1.20.1 / 1.7.10 / 2.0 */
const STANDARD_RELEASE = /^\d+\.\d+(\.\d+)?$/
/** 标准每周快照：24w14a */
const STANDARD_SNAPSHOT = /^\d{2}w\d{2}[a-z]$/

/**
 * 新命名格式的快照：`26.4-snapshot-1`（年份.季度-snapshot-序号）。
 *
 * 官方从 2026 年起启用这种写法，它**不是**愚人节版。之前用「不符合标准格式 ⇒ 愚人节」
 * 的兜底规则，把这类快照全部误判成了愚人节版（实例列表里显示成「· 愚人节版」）。
 */
const NEW_STYLE_SNAPSHOT = /^\d+\.\d+-snapshot-\d+$/i

/** 愚人节命名习惯：标准快照前缀 + 后缀单词（20w14infinite / 24w14potato / 23w13a_or_b） */
const SNAPSHOT_WITH_SUFFIX = /^\d{2}w\d{2}[a-z]?.+$/

/** 是否愚人节版。`type` 可缺省（已安装实例只拿得到 base 版本号）。 */
export function isAprilFoolsVersion(id: string, type?: string): boolean {
  const raw = (id ?? '').trim()
  if (!raw) return false
  // 1. 白名单优先：`2.0` 与 `15w14a` 只能靠它识别。
  if (APRIL_FOOLS_IDS.has(raw.toLowerCase())) return true
  // 2. 明确不是快照的，不可能是愚人节"快照版"。
  if (type === 'release' || type === 'old_beta' || type === 'old_alpha') return false
  // 3. 标准发行号与标准快照格式 → 常规版本。
  if (STANDARD_RELEASE.test(raw)) return false
  if (STANDARD_SNAPSHOT.test(raw)) return false
  if (NEW_STYLE_SNAPSHOT.test(raw)) return false
  // 4. **高精度**的愚人节命名习惯：标准快照前缀 + 后缀单词。
  //    如 20w14infinite / 22w13oneBlockAtATime / 23w13a_or_b / 24w14potato / 25w14craftmine。
  //    注意：这里**不能**写成「不符合标准格式就算愚人节」—— 那样会把新命名格式的普通快照
  //    （如 26.4-snapshot-1）全部误判成愚人节版。
  if (SNAPSHOT_WITH_SUFFIX.test(raw)) return true
  // 5. 其余一律**不是**愚人节版。宁可漏判（落到「快照」分栏，只是少了标签），
  //    也不能错判（普通快照被标成愚人节版，用户直接看到错误信息）。
  return false
}

/**
 * 归一到界面用的四类（旧版仍保留 old_beta / old_alpha，便于将来加远古版本分栏）。
 *
 * `type` 缺省时按 id 推断：标准快照格式 → snapshot，其余 → release。
 * 这一步是必需的 —— 已安装实例只拿得到 base 版本号（如 `24w14a`），
 * 若一律按 release 处理，快照实例会被标成「正式版」。
 */
export function displayVersionType(id: string, type?: string): DisplayVersionType {
  if (type === 'old_beta' || type === 'old_alpha') return type
  if (isAprilFoolsVersion(id, type)) return 'aprilfools'
  if (type === 'snapshot') return 'snapshot'
  if (!type) {
    // 没有 type：靠格式判断是不是快照（愚人节版已在上面拦掉）。
    // 两种快照写法都要认：24w14a（旧）与 26.4-snapshot-1（2026 起的新格式）。
    const raw = (id ?? '').trim()
    return STANDARD_SNAPSHOT.test(raw) || NEW_STYLE_SNAPSHOT.test(raw) ? 'snapshot' : 'release'
  }
  return 'release'
}

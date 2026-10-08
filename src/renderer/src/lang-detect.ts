// ---------------------------------------------------------------------------
// 轻量语言检测（渲染层侧，纯本地、无网络）。
//
// 用途：翻译前先判断「文本是否已经是当前设置的语言」——一致则原样返回，不发起
// 翻译请求（省流量、避免把中文翻成中文的怪异结果）。覆盖本项目最常见的几类：
// 中文（简/繁）、日文、韩文、西里尔文、以及拉丁字母（英文及其它拉丁语系）。
//
// 说明：这不是通用 NLP 检测器，只做「字符集 + 少量高频特征」级别的判断，
// 对本项目（界面文案 / MOTD / 模组简介）已足够；无法判定时返回 'unknown'。
// ---------------------------------------------------------------------------

export type DetectedLang = 'zh' | 'ja' | 'ko' | 'ru' | 'latin' | 'unknown'

/**
 * 检测文本的主导语言（按字符集归类）。
 *
 * 判定顺序（命中即返回）：
 *   1. 日文假名占「相当比例」→ ja；
 *   2. 韩文谚文 → ko；
 *   3. 西里尔字母 → ru；
 *   4. 中日韩统一表意文字（汉字）→ zh；
 *   5. 拉丁字母 → latin（英文及其它拉丁语系）；
 *   6. 其余（纯数字 / 符号 / 空）→ unknown。
 *
 * 为什么假名要「占相当比例」才算日文：中文里偶尔会出现装饰性的日文假名（最典型是
 * 「の」，如「AI交流の猫窝」）。若一见到假名就判为日文，这类中文会被误当作日文送去
 * 翻译——实测在线接口会把「馋猫网|…|AI交流の猫窝」在 to_lang=zh 时翻成**英文**，
 * 导致中文界面显示英文。因此只有假名相对汉字足够多（或纯假名）时才归日文。
 */
export function detectLang(text: string | undefined): DetectedLang {
  const s = (text ?? '').trim()
  if (!s) return 'unknown'

  // 各字符集命中计数（只统计字母/表意文字，忽略数字与符号）。
  let latin = 0
  let cjk = 0
  let kana = 0
  let hangul = 0
  let cyrillic = 0

  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x3040 && code <= 0x30ff) kana++ // 平假名 / 片假名
    else if (code >= 0xff66 && code <= 0xff9d) kana++ // 半角片假名
    else if (code >= 0xac00 && code <= 0xd7a3) hangul++ // 谚文音节
    else if (code >= 0x1100 && code <= 0x11ff) hangul++ // 谚文字母
    else if (code >= 0x0400 && code <= 0x04ff) cyrillic++ // 西里尔字母
    else if (code >= 0x4e00 && code <= 0x9fff) cjk++ // CJK 统一表意文字
    else if (code >= 0x3400 && code <= 0x4dbf) cjk++ // CJK 扩展 A
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin++ // 拉丁字母
  }

  // 日文：纯假名，或假名数量达到汉字的一半以上（日文通常假名+汉字混排且假名偏多）。
  // 仅零星假名的文本（如中文里的「の」）不判为日文，避免被误送去翻译。
  if (kana > 0 && (cjk === 0 || kana * 2 >= cjk)) return 'ja'
  if (hangul > 0) return 'ko'
  if (cyrillic > 0) return 'ru'
  // 汉字占主导（相对拉丁字母）时归中文；英中混排以汉字为准更符合「已是中文」预期。
  if (cjk > 0 && cjk >= latin) return 'zh'
  if (latin > 0) return 'latin'
  return 'unknown'
}

/**
 * 文本是否可认为「已经是目标语言」——是则无需翻译。
 *
 * target 为界面语言（zh-CN / zh-TW / en）。
 *   - 中文（简体，zh-CN）：检测为 zh 即视为已是目标语言；
 *   - 繁中（zh-TW）：**不**因「含汉字」就跳过——简体与繁体同属 CJK，必须交给翻译
 *     接口做简→繁转换，否则切到繁体后简体文本会被误判为「已是目标语言」而原样显示；
 *   - 英文（en）：检测为 latin 即视为已是英文；
 *   - 其它情况（unknown / 语言明显不同）→ 需要翻译。
 */
export function isTargetLang(text: string | undefined, target: string): boolean {
  const lang = detectLang(text)
  if (lang === 'unknown') return false
  if (target === 'en') return lang === 'latin'
  if (target === 'zh-CN' || target === 'zh') return lang === 'zh'
  // zh-TW 及其它目标语言：本地无法可靠判定，一律认为需要翻译（交给接口处理简繁 / 语种）。
  return false
}

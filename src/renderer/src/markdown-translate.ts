// ---------------------------------------------------------------------------
// Markdown 感知的翻译辅助。
//
// 直接把整段 Markdown 源码丢给通用翻译引擎会破坏语法：`## 标题` 的 `#` 后空格被吞、
// 列表符号被替换、`[文字](url)` / ![图](url) 的括号与 URL 被打乱、行内 `code` 被改写，
// 结果 marked 无法再识别这些标记，渲染出来就是「一堆纯文本」。
//
// 这里的做法：先把源码切成「可翻译文本」与「必须原样保留的片段」（代码块、行内代码、
// 链接/图片的 URL 与括号结构、各类行首标记、HTML 标签），只把真正的自然语言送翻译，
// 再按原位回填。这样译文只替换文字部分，Markdown 结构分毫不动。
// ---------------------------------------------------------------------------

/** 一个「待翻译文本 / 固定片段」单元：text 为 null 表示原样保留。 */
interface Piece {
  /** 需要翻译的纯文本；null 表示该片段原样保留（不翻译）。 */
  text: string | null
  /** 原样保留片段的内容（text 为 null 时使用）。 */
  raw: string
}

/**
 * 把一段 Markdown 源码切成若干片段。
 *
 * 采用逐行 + 行内两级处理，尽量简单可靠（不引入完整 Markdown 解析器）：
 *   - 围栏代码块（``` / ~~~）整块原样保留；
 *   - 行首的标题 / 列表 / 引用 / 表格等「结构前缀」原样保留，只翻其后的文字；
 *   - 行内的链接、图片、行内代码、HTML 标签、自动链接原样保留，只翻其余文字。
 */
function tokenize(markdown: string): Piece[] {
  const pieces: Piece[] = []
  const lines = markdown.split('\n')
  let inFence = false
  let fenceMarker = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const nl = i < lines.length - 1 ? '\n' : ''

    // 围栏代码块：开合标记整行保留，块内所有内容也保留
    const fenceMatch = line.match(/^\s*(```+|~~~+)/)
    if (fenceMatch) {
      const marker = fenceMatch[1][0]
      if (!inFence) {
        inFence = true
        fenceMarker = marker
      } else if (marker === fenceMarker) {
        inFence = false
        fenceMarker = ''
      }
      pieces.push({ text: null, raw: line + nl })
      continue
    }
    if (inFence) {
      pieces.push({ text: null, raw: line + nl })
      continue
    }

    // 行首结构前缀：引用、标题、列表、表格对齐行等
    // 匹配 `> `、`#{1,6} `、`- `、`* `、`+ `、`1. `、`1) ` 等，保留前缀只翻其后文字
    const prefixMatch = line.match(/^(\s*(?:>+\s*|#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)+)(.*)$/)
    if (prefixMatch) {
      pieces.push({ text: null, raw: prefixMatch[1] })
      pushInline(pieces, prefixMatch[2])
      pieces.push({ text: null, raw: nl })
      continue
    }

    // 纯结构行（分割线、空行、表格分隔、纯 HTML 块）原样保留
    if (/^\s*$/.test(line) || /^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      pieces.push({ text: null, raw: line + nl })
      continue
    }

    pushInline(pieces, line)
    pieces.push({ text: null, raw: nl })
  }

  return pieces
}

/**
 * 处理一行内的行内语法：把链接、图片、行内代码、HTML 标签、自动链接原样保留，
 * 中间的自然语言文字作为可翻译片段。
 */
function pushInline(pieces: Piece[], line: string): void {
  // 依次匹配：行内代码 `x`、图片 ![alt](url)、链接 [text](url)、自动链接 <url>、HTML 标签
  const inlineRe =
    /(`+)([\s\S]*?)\1|!\[([^\]]*)\]\(([^)]*)\)|\[([^\]]*)\]\(([^)]*)\)|<(https?:\/\/[^>\s]+)>|<\/?[a-zA-Z][^>]*>/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = inlineRe.exec(line)) !== null) {
    if (m.index > last) {
      pieces.push({ text: line.slice(last, m.index), raw: '' })
    }
    if (m[2] !== undefined) {
      // 行内代码：整段保留
      pieces.push({ text: null, raw: m[0] })
    } else if (m[3] !== undefined) {
      // 图片 ![alt](url)：alt 可翻译，语法与 url 保留
      pieces.push({ text: null, raw: '![' })
      if (m[3]) pieces.push({ text: m[3], raw: '' })
      pieces.push({ text: null, raw: `](${m[4]})` })
    } else if (m[5] !== undefined) {
      // 链接 [text](url)：text 可翻译，语法与 url 保留
      pieces.push({ text: null, raw: '[' })
      if (m[5]) pieces.push({ text: m[5], raw: '' })
      pieces.push({ text: null, raw: `](${m[6]})` })
    } else {
      // 自动链接 / HTML 标签：整段保留
      pieces.push({ text: null, raw: m[0] })
    }
    last = m.index + m[0].length
  }
  if (last < line.length) {
    pieces.push({ text: line.slice(last), raw: '' })
  }
}

/**
 * 把 Markdown 源码编译为「可翻译文本列表 + 回填函数」。
 *
 * 用法：
 *   const built = compileMarkdown(md)
 *   const tr = useAutoTranslate([...built.texts, ...其它文案])
 *   const rendered = built.rebuild((s) => tr(s))
 *
 * rebuild 只替换可翻译片段，其余片段原样拼接，因此 Markdown 结构不会被破坏。
 */
export function compileMarkdown(markdown: string): {
  texts: string[]
  rebuild: (translate: (text: string) => string) => string
} {
  const pieces = tokenize(markdown)
  const texts: string[] = []
  for (const p of pieces) {
    if (p.text !== null) texts.push(p.text)
  }
  const rebuild = (translate: (text: string) => string): string => {
    let out = ''
    for (const p of pieces) {
      if (p.text === null) {
        out += p.raw
      } else {
        // 仅翻译有实际内容的片段（空串片段直接跳过，避免无谓请求与错位）
        out += p.text.trim() ? translate(p.text) : p.text
      }
    }
    return out
  }
  return { texts, rebuild }
}

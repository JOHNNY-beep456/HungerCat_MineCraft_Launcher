// ---------------------------------------------------------------------------
// 自定义主页脚本的静态安全检测。
//
// 检测发生在脚本「安装时」与「每次读取时」，结果决定脚本能否运行：
//   - reject：疑似伪装/混淆的危险代码、删除文件或格式化命令、对外下载可执行文件
//             / 压缩包 / svg —— 一律拒绝运行。
//   - warn  ：会链接外部服务但不下载上述文件 —— 列出外链清单，交由用户确认。
//   - safe  ：纯本地界面脚本，可直接运行。
//
// 外链脚本（.js/.mjs）不直接拒绝：标记为 code 后由 homepage.ts 取回正文，再用同一套
// 规则判断——正文命中危险规则即拒绝，取不回正文同样拒绝（无法核对即不放行）。取回的
// 正文按「脚本库」模式检测：UMD 包装里的 require / module.exports / process.env 不算危险。
//
// 这里只是「第一道闸」，真正的隔离由渲染层的 sandbox iframe + CSP 承担。
// ---------------------------------------------------------------------------

import type { HomepageExternal, HomepageMeta, HomepageRisk } from '@shared/types'
import { mergeAdjacentLiterals, scanHomepageCode } from '@shared/homepage-runtime'

/**
 * 「危险代码」规则表见 @shared/homepage-runtime：主进程的静态检测与渲染层的运行时
 * 检测共用同一份定义，避免两处判定漂移。
 */

/**
 * 判定为「危险下载」的扩展名：可执行文件、压缩包、矢量图。
 *
 * 只针对 URL 的**路径部分**做判定（见 urlPath）：不能拿整个 URL 去测，否则
 * `https://example.com/x` 里的 `.com`（com 是历史遗留的可执行扩展名）会被误判成
 * 「下载 .com 可执行文件」。末尾的分隔符在调用处剥掉，因此 `payload.exe/` 也能命中（F-07）。
 */
const DANGEROUS_EXT_RE = /\.(exe|msi|msp|dll|com|scr|sys|bat|cmd|ps1|psm1|vbs|vbe|wsf|wsh|sh|bash|zsh|jar|class|apk|app|dmg|pkg|deb|rpm|iso|img|zip|rar|7z|tar|gz|tgz|bz2|xz|svg)(?=[?#"'`\s<>)]|$)/i

/** 外链脚本扩展名：内容需取回后按同一套规则判断。 */
const SCRIPT_EXT_RE = /\.(js|mjs|jse)(?=[?#"'`\s<>)]|$)/i

/**
 * 已知「只是命名空间标识、不会真的发请求」的地址，不计入外链清单。
 * 放宽后的裸地址收集会扫到 SVG / XML 的 xmlns，故需要放行这类固定 URI。
 */
const NAMESPACE_URL_RE = /^(?:https?:)?\/\/(?:www\.)?(?:w3\.org|purl\.org)\//i

/** 取 URL 的「路径 + 查询」部分（去掉协议与主机）；不成形的返回空串。 */
function urlPath(url: string): string {
  const m = /^[a-z]+:\/\/[^/?#]*(\/[^]*)?$/i.exec(url)
  return m?.[1] ?? ''
}

/** 外部地址的用途推断：属性/调用点 → 中文说明。 */
interface ExternalHit {
  url: string
  kind: string
}

/** 抓取带用途的外部地址（属性写法）。 */
function collectAttributed(source: string, out: Map<string, ExternalHit>): void {
  // `ping` 是 <a>/<area> 的「后台信标」属性，点击时会把地址悄悄 POST 出去（D10）。
  // 它的值可能是空格分隔的多个地址，这里逐个拆开，避免整串被当成一个畸形 URL。
  const attrRe = /<(script|link|img|iframe|a|area|form|source|video|audio|embed|object|use|image)\b[^>]*?\b(href|src|action|data|poster|xlink:href|ping)\s*=\s*["']([^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = attrRe.exec(source)) !== null) {
    const tag = m[1].toLowerCase()
    const attr = m[2].toLowerCase()
    const urls = attr === 'ping' ? m[3].trim().split(/\s+/).filter(Boolean) : [m[3].trim()]
    for (const raw of urls) {
      const url = raw.trim()
      if (!isExternal(url)) continue
      const kind =
        tag === 'script'
          ? '脚本'
          : tag === 'link'
            ? '样式'
            : tag === 'img' || tag === 'source' || tag === 'image' || tag === 'video' || tag === 'audio'
              ? '图片/媒体'
              : tag === 'iframe'
                ? '页面嵌套'
                : tag === 'form'
                  ? '表单提交'
                  : '链接'
      if (!out.has(url)) out.set(url, { url, kind })
    }
  }
}

/** 抓取 JS 里发起的外部请求（fetch / XHR / WebSocket / 事件源 / 信标）。 */
function collectRequests(source: string, out: Map<string, ExternalHit>): void {
  const reqRe = /(?:fetch|open|sendBeacon|WebSocket|EventSource|importScripts|import)\s*\(\s*["'`]([^"'`]+)["'`]/gi
  let m: RegExpExecArray | null
  while ((m = reqRe.exec(source)) !== null) {
    const url = m[1].trim()
    if (!isExternal(url)) continue
    if (!out.has(url)) out.set(url, { url, kind: '接口请求' })
  }
}

/** 抓取 CSS 里的外部引用与剩余的裸地址。 */
function collectBare(source: string, out: Map<string, ExternalHit>): void {
  // 不再要求 `//` 前面紧挨引号/等号等字符：拼接或模板字面量构造出的地址前面可能是 `}`、
  // 标识符等任意字符（F-08）。代价是会扫到 JS 行注释里的 `//文字`，所以要求主机名带点
  // 且末尾是至少两位的 TLD（或 IPv4），把 `//注释` 这类排除掉。
  const urlRe = /(?:https?:)?\/\/(?:[a-z0-9][a-z0-9.-]*\.[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#][^\s"'`<>()\\]*)?/gi
  let m: RegExpExecArray | null
  while ((m = urlRe.exec(source)) !== null) {
    const url = m[0].trim()
    if (NAMESPACE_URL_RE.test(url)) continue
    if (!isExternal(url)) continue
    if (!out.has(url)) out.set(url, { url, kind: '外部地址' })
  }
}

/** 是否指向外部服务（排除 data: / blob: / file: / 相对路径）。 */
function isExternal(url: string): boolean {
  const u = url.trim()
  if (!u) return false
  if (/^(?:data|blob|file|about|javascript|mailto|tel):/i.test(u)) return false
  if (/^\/\//.test(u)) return true
  return /^https?:/i.test(u)
}

/** 归一化地址用于展示与去重。 */
function normalizeUrl(url: string): string {
  const u = url.trim().replace(/["'`,;]+$/, '')
  return u.startsWith('//') ? `https:${u}` : u
}

/**
 * 对脚本正文做静态安全检测。
 * @param source 脚本原始 HTML 源码
 * @param options.library 分析对象是取回的第三方脚本库正文（非主页 HTML 本身）：
 *   跳过 UMD 包装相关的 Node 能力规则，且不把代码里的普通地址当成「链接的外部服务」。
 */
export function analyzeScript(source: string, options?: { library?: boolean }): HomepageRisk {
  // 规则匹配（含内联 base64 折叠 / 相邻字面量合并）统一由 @shared/homepage-runtime 完成：
  // 渲染层的运行时检测用的是同一份规则表。静态检测不截断——脚本落地时已有体积上限，
  // 截断只会给「把载荷放到上限之后」留下绕过空间（F-01）。
  const blocks = scanHomepageCode(source, options?.library ? 'library' : 'code', { maxLength: 0 })

  // 拼接 / 模板字面量构造出的地址在原文里看不出来，再看一份「合并相邻字面量」的文本（F-08）。
  const merged = mergeAdjacentLiterals(source)

  const found = new Map<string, ExternalHit>()
  collectAttributed(source, found)
  collectRequests(source, found)
  collectRequests(merged, found)
  collectBare(source, found)
  collectBare(merged, found)

  const externals: HomepageExternal[] = []
  for (const hit of found.values()) {
    const url = normalizeUrl(hit.url)
    // 只看路径：末尾的分隔符先剥掉，`.../payload.exe/` 才能按可执行文件拦下（F-07），
    // 而主机名里的 `.com` / `.sh` / `.app` 不会被误当成危险后缀。
    const base = urlPath(url).split(/[?#]/)[0].replace(/[/\\]+$/, '')
    if (DANGEROUS_EXT_RE.test(base)) {
      const reason = `包含对外的可执行文件 / 压缩包 / 矢量图下载：${url}`
      if (!blocks.includes(reason)) blocks.push(reason)
      continue
    }
    // 外链脚本交由上层取回正文后再判断，这里只做标记，不算作拒绝。
    const code = SCRIPT_EXT_RE.test(base)
    // 脚本库正文里的普通地址只是代码中的字符串，不代表页面链接了外部服务，不列入清单。
    if (options?.library && !code) continue
    externals.push({ url, kind: hit.kind, code: code || undefined })
  }

  // 外链清单不截断：列表被截断会让排在后面的地址对用户不可见，等于把需要确认的东西藏起来（F-12）。
  externals.sort((a, b) => a.url.localeCompare(b.url))
  const level: HomepageRisk['level'] = blocks.length > 0 ? 'reject' : externals.length > 0 ? 'warn' : 'safe'
  return { level, blocks, externals }
}

/** 解析脚本首部的 `<!--@hcpage { … } -->` 元信息块；缺失或损坏时回落到默认值。 */
export function parseHomepageMeta(source: string, fallbackName: string): HomepageMeta {
  const meta: HomepageMeta = {
    id: '',
    name: fallbackName,
    author: '',
    version: '',
    description: '',
    minLauncher: ''
  }
  const m = /<!--\s*@hcpage([\s\S]*?)-->/.exec(source)
  if (!m) return meta
  try {
    const raw = JSON.parse(m[1].trim()) as Record<string, unknown>
    const pick = (k: string): string => (typeof raw[k] === 'string' ? (raw[k] as string).trim() : '')
    // id 只取元信息块里的编号，缺失即视为「无编号脚本」，不拿本地文件名顶替。
    meta.id = pick('id')
    meta.name = pick('name') || meta.name
    meta.author = pick('author')
    meta.version = pick('version')
    meta.description = pick('description')
    meta.minLauncher = pick('minLauncher')
  } catch {
    /* 元信息块损坏时按「无编号、无元信息」处理，不阻断安装 */
  }
  return meta
}

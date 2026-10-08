// ---------------------------------------------------------------------------
// 脚本执行：组装注入 iframe 的 srcDoc。
//
// 主页脚本是「单文件 HTML」，运行在 sandbox="allow-scripts" 的 iframe 里。
// 这里把 CSP、基础样式与 SDK 注入到脚本 HTML 的 <head>，再交给 buildSrcDoc 合并。
// ---------------------------------------------------------------------------

import type { HomepageSource } from '@shared/types'
import { buildSrcDoc } from '@shared/srcdoc'
import { buildCsp } from './security'
import { SDK } from './sdk'

/**
 * 组装 iframe 的 srcDoc。
 *
 * 未授权联网时不放行任何源（CSP connect-src 'none'）；头像源与皮肤源属宿主自身
 * 可信资源，单独放行 img-src。脚本内容经 buildSrcDoc 与注入项合并。
 */
export function buildFrameSrcDoc(
  entry: HomepageSource | null,
  approvedOrigins: string[],
  avatarOrigin: string,
  skinOrigin: string
): string {
  if (!entry) return ''
  const csp = buildCsp(entry.networkApproved ? approvedOrigins : [], avatarOrigin, skinOrigin)
  const inject = [
    `<meta id="hc-csp" http-equiv="Content-Security-Policy" content="${csp}">`,
    `<style id="hc-base">
        :root { color-scheme: light dark; }
        html, body { margin: 0; padding: 0; min-height: 100%; background: transparent; }
        body { font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: var(--hc-text-primary, #111); }
      </style>`,
    `<script id="hc-sdk">${SDK}</script>`
  ].join('')
  return buildSrcDoc(entry.content, inject)
}

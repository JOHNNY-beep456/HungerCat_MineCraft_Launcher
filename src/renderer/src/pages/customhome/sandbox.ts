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
        :root {
          color-scheme: light dark;
          /* 形状 / 材质兜底：宿主会在 init / update 时用真实值覆盖。
             这几项默认给中性值，保证「宿主令牌缺失」时页面仍按常规圆角、
             实色卡片渲染，而不是出现 0 圆角或 none 模糊导致布局塌陷。 */
          --hc-radius-control: 12px;
          --hc-radius-card: 24px;
          --hc-radius-full: 999px;
          --hc-surface-material: solid;
          --hc-surface-blur: none;
          --hc-surface-border-width: 1px;
        }
        html, body { margin: 0; padding: 0; min-height: 100%; background: transparent; }
        body { font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: var(--hc-text-primary, #111); }
        /* 卡片：圆角与描边宽度跟随宿主；材质为实色时不挂 backdrop-filter，
           省掉一整层合成开销（宿主给的是 none 时 var() 解析为 none，天然失效）。 */
        .hc-surface {
          border-radius: var(--hc-radius-card);
          border: var(--hc-surface-border-width, 1px) solid var(--hc-glass-border, transparent);
          background: var(--hc-glass-bg, transparent);
          backdrop-filter: var(--hc-surface-blur);
        }
      </style>`,
    `<script id="hc-sdk">${SDK}</script>`
  ].join('')
  return buildSrcDoc(entry.content, inject)
}

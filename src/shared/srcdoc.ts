// ---------------------------------------------------------------------------
// 沙箱 iframe 的 srcDoc 组装：把 CSP meta 与安全 SDK 注入到「真实 <head>」的最前面。
//
// 放在 @shared 是为了能被单独测试：注入点是整条安全链的根——一旦注入内容落进注释或
// 字符串里，CSP 与 window.hc 会双双缺失，sandbox 隔离就静默失效（F-02）。
// ---------------------------------------------------------------------------

/**
 * 把「注释 / <script> / <style> 的正文」等长替换为空格，仅用于定位真实标签。
 *
 * 若用正则在原文里直接找 `<head>`，源码里 `<!-- <head> -->` 这样的注释（或脚本字符串里的
 * `"<head>"`）会先被命中，注入内容就落进注释里彻底失效。掩掉这些区域后再找，
 * 索引仍与原文一一对应（等长替换保证）。
 */
export function maskNonMarkup(html: string): string {
  const blank = (m: string): string => ' '.repeat(m.length)
  const blankBody = (m: string, open: string, close: string): string =>
    open + ' '.repeat(Math.max(0, m.length - open.length - close.length)) + close
  return html
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script\s*>)/gi, blankBody)
    .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style\s*>)/gi, blankBody)
}

/** 把注入内容插到真实 <head> 的最前面；没有 head 就补一个。 */
export function buildSrcDoc(html: string, inject: string): string {
  const masked = maskNonMarkup(html)
  const head = /<head\b[^>]*>/i.exec(masked)
  if (head) {
    const at = head.index + head[0].length
    return html.slice(0, at) + inject + html.slice(at)
  }
  const htmlTag = /<html\b[^>]*>/i.exec(masked)
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length
    return `${html.slice(0, at)}<head>${inject}</head>${html.slice(at)}`
  }
  return `<!DOCTYPE html><html><head>${inject}</head><body>${html}</body></html>`
}

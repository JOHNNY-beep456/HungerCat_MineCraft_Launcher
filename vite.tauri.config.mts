import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

/** 共用 HTML 的 Electron CSP 不能与 Tauri 策略叠加，否则独立主页会被 default-src 拦截。 */
export function tauriHtmlPolicy(html: string): string {
  const config = JSON.parse(readFileSync(new URL('./src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
  const policy: unknown = config.app?.security?.csp
  if (typeof policy !== 'string' || !policy.trim()) throw new Error('Tauri 主文档 CSP 缺失')
  const matches = [...html.matchAll(/<meta\b[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi)]
  if (matches.length !== 1) throw new Error('共享入口必须恰好包含一条 CSP，拒绝生成未知策略')
  const escaped = policy.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  return html.replace(matches[0][0], `<meta http-equiv="Content-Security-Policy" content="${escaped}" />`)
}

// Tauri 只构建共享 React 界面，业务运行于 Rust / 原生平台模块。
export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [
    { name: 'hcmcl-tauri-html-policy', transformIndexHtml: { order: 'pre', handler: tauriHtmlPolicy } },
    react(), tailwindcss()
  ],
  resolve: {
    alias: {
      '@': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  clearScreen: false,
  server: { host: '0.0.0.0', port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    outDir: resolve('out/tauri'),
    emptyOutDir: true,
    target: 'es2021'
  }
})

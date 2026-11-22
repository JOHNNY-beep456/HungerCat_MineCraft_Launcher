import { invoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core'
import { localizeBackendError } from '@shared/backend-text'

/** 标记仅注入可信主文档；沙箱页面仍只使用 hc 的 postMessage 白名单桥。 */
export function nativeInvoke<T>(command: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  const marker: unknown = (window as Window & { __HC_NATIVE_DOCUMENT__?: unknown }).__HC_NATIVE_DOCUMENT__
  if (window !== window.top || typeof marker !== 'string' || !/^[a-f0-9]{64}$/.test(marker)) {
    return Promise.reject(new Error('当前文档无权调用原生业务 / 目前文件無權呼叫原生業務 / This document cannot invoke native business commands'))
  }
  const headers = new Headers(options?.headers)
  headers.set('x-hcmcl-document', marker)
  // 以普通记录传给 Tauri；Headers 实例不能按其 Object.entries 路径序列化。
  // 拒绝值按当前界面语言解析（Rust 侧三语串），已解析过的字符串不会被二次改写。
  return invoke<T>(command, args, { ...options, headers: Object.fromEntries(headers.entries()) })
    .catch((cause: unknown) => { throw localizeBackendError(cause) })
}

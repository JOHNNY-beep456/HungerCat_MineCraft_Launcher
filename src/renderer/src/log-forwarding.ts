/** 日志旁路必须先于原生 API 的 pagehide 清理停用，不能让报告失败再报告自身。 */
export function installRendererLogForwarding(
  target: Window,
  report: (level: 'info' | 'warn' | 'error', message: string) => void
): () => void {
  let active = true
  let sending = false
  const originals = { warn: console.warn, error: console.error }
  const stringify = (value: unknown): string => {
    if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
    if (typeof value === 'string') return value
    try { return JSON.stringify(value) ?? String(value) } catch { return String(value) }
  }
  const send = (level: 'info' | 'warn' | 'error', message: string): void => {
    if (!active || sending) return
    sending = true
    try {
      // 日志旁路不是业务请求；同步异常和意外返回的 rejected Promise 都不能反向写 console。
      void Promise.resolve(report(level, message)).catch(() => {})
    } catch { /* 旁路失败保留原始 console，不影响页面。 */ }
    finally { sending = false }
  }
  const wrappers = {
    warn: (...args: unknown[]): void => { originals.warn.apply(console, args); send('warn', args.map(stringify).join(' ')) },
    error: (...args: unknown[]): void => { originals.error.apply(console, args); send('error', args.map(stringify).join(' ')) }
  }
  console.warn = wrappers.warn
  console.error = wrappers.error
  const onError = (event: ErrorEvent): void => {
    send('error', event.error ? stringify(event.error) : `${event.message} (${event.filename}:${event.lineno}:${event.colno})`)
  }
  const onRejection = (event: PromiseRejectionEvent): void => { send('error', `未处理的 Promise 拒绝: ${stringify(event.reason)}`) }
  const dispose = (): void => {
    if (!active) return
    active = false
    if (console.warn === wrappers.warn) console.warn = originals.warn
    if (console.error === wrappers.error) console.error = originals.error
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
    target.removeEventListener('pagehide', dispose, true)
  }
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  // capture 先于 bridge.ts 已注册的 bubble dispose；不可只靠注册先后顺序。
  target.addEventListener('pagehide', dispose, { capture: true, once: true })
  return dispose
}
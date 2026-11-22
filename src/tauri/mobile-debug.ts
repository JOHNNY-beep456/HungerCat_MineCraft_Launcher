/** 移动端日志页的本地挂载协议；不授予原生能力，也不新增公开 IPC。 */
export interface TauriMobileDebugRequest {
  readonly id: number
  opened: () => void
  closed: () => void
  failed: () => void
}

export interface TauriMobileDebugHost {
  show: (request: TauriMobileDebugRequest) => void
  hide: (id: number) => void
}

export interface TauriMobileDebugController {
  attach: (host: TauriMobileDebugHost) => () => void
  open: () => Promise<void>
  close: () => Promise<void>
  visible: () => boolean
  dispose: () => void
}

type Completion = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }
type Session = {
  id: number
  host: TauriMobileDebugHost
  phase: 'opening' | 'open' | 'closing'
  opened: Completion
  closed?: Completion
  timer: ReturnType<typeof setTimeout> | undefined
}

function completion(): Completion {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  // 挂载失败可能早于调用方接住返回的 Promise；仍保留原 Promise 的拒绝语义。
  void promise.catch(() => {})
  return { promise, resolve, reject }
}
function unavailable(): Error {
  return new Error('移动日志页面未挂载 / 行動日誌頁面未掛載 / The mobile log page is not mounted')
}
function failed(): Error {
  return new Error('移动日志页面操作未完成 / 行動日誌頁面操作未完成 / The mobile log page operation did not complete')
}

/** 只有宿主真实提交后的回执才成功；迟到回执、卸载和 dispose 都不能复活旧页面。 */
export function createTauriMobileDebugController(): TauriMobileDebugController {
  let host: TauriMobileDebugHost | undefined
  let session: Session | undefined
  let disposed = false
  let sequence = 0
  const clearTimer = (current: Session): void => {
    if (current.timer !== undefined) clearTimeout(current.timer)
    current.timer = undefined
  }
  const rejectSession = (current: Session): void => {
    if (session !== current) return
    session = undefined
    clearTimer(current)
    current.opened.reject(failed())
    current.closed?.reject(failed())
    // 这是本地视图，不持有文件/上传事务；失败后要求宿主撤下本轮页面。
    try { current.host.hide(current.id) } catch { /* 原错误保持固定，不回显宿主异常。 */ }
  }
  const arm = (current: Session): void => {
    clearTimer(current)
    current.timer = setTimeout(() => rejectSession(current), 15_000)
  }
  const controller: TauriMobileDebugController = {
    attach(next) {
      if (disposed) throw unavailable()
      if (host) throw new Error('移动日志宿主已注册 / 行動日誌宿主已註冊 / A mobile log host is already registered')
      host = next
      let detached = false
      return () => {
        if (detached) return
        detached = true
        if (host !== next) return
        host = undefined
        const current = session
        if (current?.host === next) rejectSession(current)
      }
    },
    open() {
      if (disposed || !host) return Promise.reject(unavailable())
      if (session?.phase === 'open') return Promise.resolve()
      if (session?.phase === 'opening') return session.opened.promise
      if (session) return Promise.reject(failed())
      const current: Session = { id: ++sequence, host, phase: 'opening', opened: completion(), timer: undefined }
      session = current
      arm(current)
      const request: TauriMobileDebugRequest = {
        id: current.id,
        opened() {
          if (disposed || session !== current || host !== current.host || current.phase !== 'opening') return
          clearTimer(current)
          current.phase = 'open'
          current.opened.resolve()
        },
        closed() {
          if (session !== current) return
          session = undefined
          clearTimer(current)
          if (current.phase !== 'open') current.opened.reject(failed())
          current.closed?.resolve()
        },
        failed() { rejectSession(current) }
      }
      try { current.host.show(request) } catch { rejectSession(current) }
      return current.opened.promise
    },
    close() {
      if (disposed) return Promise.reject(unavailable())
      const current = session
      if (!current) return Promise.resolve()
      if (current.phase === 'closing') return current.closed!.promise
      current.phase = 'closing'
      current.opened.reject(failed())
      current.closed = completion()
      arm(current)
      try { current.host.hide(current.id) } catch { rejectSession(current) }
      return current.closed.promise
    },
    visible: () => !disposed && session?.phase === 'open',
    dispose() {
      if (disposed) return
      disposed = true
      const current = session
      if (current) rejectSession(current)
      host = undefined
    }
  }
  return controller
}

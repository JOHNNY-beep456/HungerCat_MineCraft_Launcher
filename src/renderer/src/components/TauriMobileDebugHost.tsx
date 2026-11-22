import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  attachTauriMobileDebugHost,
  type TauriMobileDebugHost as MobileHost,
  type TauriMobileDebugRequest
} from '../../../tauri/bridge'
import { DebugLogWindow } from './DebugLogWindow'

const TEXT = {
  'zh-CN': { title: '启动器日志', back: '返回', failed: '日志页面操作未完成，请重试。' },
  'zh-TW': { title: '啟動器日誌', back: '返回', failed: '日誌頁面操作未完成，請重試。' },
  en: { title: 'Launcher logs', back: 'Back', failed: 'The log page operation did not complete. Please retry.' }
} as const

function publicLocale(): keyof typeof TEXT {
  for (const value of [document.documentElement.lang, ...(navigator.languages ?? []), navigator.language]) {
    const language = value.trim().replace(/_/g, '-').toLowerCase()
    if (/^zh-(tw|hk|mo|hant)(-|$)/.test(language)) return 'zh-TW'
    if (/^zh(-|$)/.test(language)) return 'zh-CN'
    if (/^en(-|$)/.test(language)) return 'en'
  }
  return 'zh-CN'
}

type Registration = {
  active: boolean
  pending: TauriMobileDebugRequest | null
  opened: TauriMobileDebugRequest | null
  retiring: Set<TauriMobileDebugRequest>
  dialog: HTMLDialogElement | null
  returnFocus: HTMLElement | null
}
type View = { registration: Registration; request: TauriMobileDebugRequest | null } | null

/** 仅由移动 Tauri 入口挂载；原生 dialog 提供焦点圈定和底层交互隔离。 */
export function TauriMobileDebugHost(): JSX.Element {
  const [locale] = useState(publicLocale)
  const text = TEXT[locale]
  const [view, setView] = useState<View>(null)
  const [error, setError] = useState(false)
  const registrationRef = useRef<Registration | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)

  const closeOwnedDialog = (registration: Registration): boolean => {
    const dialog = registration.dialog
    try {
      if (dialog?.open) dialog.close()
      if (dialog?.open) return false
    } catch {
      return false
    }
    registration.dialog = null
    const previous = registration.returnFocus
    registration.returnFocus = null
    if (previous?.isConnected) {
      try { previous.focus({ preventScroll: true }) } catch { /* 已关闭，不回显焦点恢复异常。 */ }
    }
    return true
  }

  useEffect(() => {
    const registration: Registration = {
      active: true, pending: null, opened: null, retiring: new Set(), dialog: null, returnFocus: null
    }
    registrationRef.current = registration
    setView({ registration, request: null })
    const host: MobileHost = {
      show(request) {
        if (!registration.active) return
        if (registration.pending === request) return
        if (!registration.pending && !registration.dialog) {
          registration.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
        }
        if (registration.pending) registration.retiring.add(registration.pending)
        registration.pending = request
        setError(false)
        setView({ registration, request })
      },
      hide(id) {
        if (!registration.active || registration.pending?.id !== id) return
        registration.retiring.add(registration.pending)
        registration.pending = null
        // 即使 show/hide 同批使 dialog 从未出现，仍提交一轮并确认 closed。
        setView({ registration, request: null })
      }
    }
    let detach: (() => void) | undefined
    try { detach = attachTauriMobileDebugHost(window.api, host) }
    catch { setError(true) }
    return () => {
      // 先失活，detach 同步产生的 hide 或迟到操作都不能写入下一轮宿主。
      registration.active = false
      if (registrationRef.current === registration) registrationRef.current = null
      try { detach?.() } finally { closeOwnedDialog(registration) }
      registration.pending = null
      registration.opened = null
      registration.retiring.clear()
    }
  }, [])

  useLayoutEffect(() => {
    if (!view) return
    const registration = view.registration
    if (!registration.active || registrationRef.current !== registration) return
    if (registration.retiring.size > 0) {
      const closed = closeOwnedDialog(registration)
      const retiring = [...registration.retiring]
      registration.retiring.clear()
      registration.opened = null
      for (const request of retiring) {
        if (closed) request.closed()
        else request.failed()
      }
      if (!closed) setError(true)
    }
    const request = view.request
    if (!request || registration.pending !== request || registration.opened === request) return
    // 父 layout effect 执行时，真实日志子组件已 commit，dialog ref 已连接。
    const dialog = dialogRef.current
    try {
      if (!dialog?.isConnected) throw new Error('dialog unavailable')
      registration.dialog = dialog
      dialog.showModal()
      if (!dialog.open || !dialog.isConnected) throw new Error('dialog not open')
      registration.opened = request
      request.opened()
    } catch {
      closeOwnedDialog(registration)
      registration.pending = null
      setView({ registration, request: null })
      setError(true)
      request.failed()
    }
  }, [view])

  const requestClose = (): void => {
    const registration = registrationRef.current
    const request = registration?.pending
    if (!registration?.active || !request) return
    try {
      void window.api.debug.closeWindow().catch(() => {
        if (registration.active && registrationRef.current === registration && registration.pending === request) setError(true)
      })
    } catch {
      if (registration.active && registration.pending === request) setError(true)
    }
  }

  return (
    <>
      {error && !view?.request && <div className="hc-mobile-debug__notice" role="alert">{text.failed}</div>}
      {view?.request && (
        <dialog
          key={view.request.id}
          ref={dialogRef}
          className="hc-mobile-debug"
          aria-label={text.title}
          aria-modal="true"
          onCancel={(event) => { event.preventDefault(); requestClose() }}
          onClose={() => {
            const registration = registrationRef.current
            if (!registration?.active || registration.pending !== view.request || registration.opened !== view.request) return
            // 非控制器触发的原生关闭也经同一公开关闭入口清理控制器票据。
            requestClose()
          }}
        >
          <header className="hc-mobile-debug__header">
            <button type="button" className="hc-mobile-debug__back" autoFocus onClick={requestClose}>{text.back}</button>
            <h1>{text.title}</h1>
          </header>
          {error && <div className="hc-mobile-debug__error" role="alert">{text.failed}</div>}
          <DebugLogWindow embedded />
        </dialog>
      )}
    </>
  )
}

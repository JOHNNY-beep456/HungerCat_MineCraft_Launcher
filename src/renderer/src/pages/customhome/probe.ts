// ---------------------------------------------------------------------------
// 会话级主页校验。
//
// 主页的「联网核对编号 + 哈希」只在启动时做一次：结果按 id 缓存在模块里，
// 之后无论怎么在页面间来回切换、重挂主页 iframe，都不会再发第二次请求。
//
// 这么做不只是省流量：每次进主页都联网，网络一抖就会把本来能跑的主页拦在
// 闸门后面，用户看到的是「刚才能用、现在不能用」。一次校验 + 会话内复用，
// 行为才是稳定的。
//
// 内容真的变了（导入新版 / 手工替换）时必须重新核对——旧凭证不能套到新内容上，
// 这条由 `CustomHomePage` 在放行时比对哈希兜底。
// ---------------------------------------------------------------------------

import { useSyncExternalStore } from 'react'
import type { HomepageVerifyResult } from '@shared/types'

export type ProbePhase = 'idle' | 'checking' | 'ready' | 'attention' | 'failed'

export interface ProbeView {
  /** 本次探测对应的主页 id。 */
  id: string
  phase: ProbePhase
  /** 已确认可运行的内容哈希；非 ready 时为空串。 */
  sha256: string
  /** 失败或需要处理时给界面看的一句话。 */
  message: string
}

interface ProbeState {
  id: string
  phase: ProbePhase
  sha256: string
  message: string
  result: HomepageVerifyResult | null
  error: Error | null
  promise: Promise<HomepageVerifyResult> | null
}

const idle = (): ProbeState => ({ id: '', phase: 'idle', sha256: '', message: '', result: null, error: null, promise: null })
let state: ProbeState = idle()
let snapshot: ProbeView = { id: '', phase: 'idle', sha256: '', message: '' }
const listeners = new Set<() => void>()

function publish(): void {
  snapshot = { id: state.id, phase: state.phase, sha256: state.sha256, message: state.message }
  for (const listener of listeners) listener()
}

/**
 * 是否需要用户处理（等价于闸门里「不能直接放行」的那些分支）。
 *
 * 这里刻意与 `HomepageGate` 的判定保持一致：图标闪不闪，取决于用户点进去
 * 之后是不是真的要看到确认界面。两处判断分叉就会出现「图标不闪但主页被拦」。
 */
function needsAttention(result: HomepageVerifyResult): boolean {
  const entry = result.entry
  if (entry.risk.level === 'reject') return true
  if (result.notFound || result.outdated) return true
  if (entry.verify === 'mismatch' && !(result.locallyEdited === true && entry.confirmed)) return true
  if (entry.risk.level === 'warn' && !entry.networkApproved) return true
  if (result.reachable && entry.verify === 'verified') return false
  return !entry.confirmed
}

export function subscribeProbe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function probeSnapshot(): ProbeView {
  return snapshot
}

/** React 订阅入口：侧栏图标与主页宿主共用同一份状态。 */
export function useHomepageProbe(): ProbeView {
  return useSyncExternalStore(subscribeProbe, probeSnapshot, probeSnapshot)
}

/** 已缓存的结果（同一 id）；没有就返回 null。 */
export function cachedProbe(id: string): HomepageVerifyResult | null {
  return state.id === id ? state.result : null
}

/**
 * 取会话内的一次校验结果；同一个 id 只会真正联网一次。
 *
 * `force` 只给用户主动「重试」用：自动流程永远不会重发，失败也保持失败，
 * 否则切来切去就变成了反复联网。
 */
export async function ensureProbe(id: string, force = false): Promise<HomepageVerifyResult> {
  if (!id) throw new Error('未选择主页')
  if (!force && state.id === id) {
    if (state.result) return state.result
    if (state.error) throw state.error
    if (state.promise) return state.promise
  }
  // 换主页 / 强制重试才重置；同一 id 的失败结果保留，避免自动重试。
  if (state.id !== id || force) {
    state = { ...idle(), id, phase: 'checking' }
    publish()
  } else {
    state.phase = 'checking'
    state.error = null
    publish()
  }
  const promise = window.api.homepage.verify(id).then(
    (result) => {
      state.result = result
      state.promise = null
      state.phase = needsAttention(result) ? 'attention' : 'ready'
      state.sha256 = state.phase === 'ready' ? result.entry.sha256 : ''
      state.message = result.message ?? ''
      publish()
      return result
    },
    (error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error))
      state.promise = null
      state.phase = 'failed'
      state.sha256 = ''
      state.error = failure
      state.message = failure.message
      publish()
      throw failure
    }
  )
  state.promise = promise
  void promise.catch(() => undefined)
  return promise
}

/** 用户在闸门里确认后，把这次结果提升为「可运行」，让占用与图标状态跟上。 */
export function approveProbe(id: string, sha256: string): void {
  if (state.id !== id || !sha256) return
  state.phase = 'ready'
  state.sha256 = sha256
  publish()
}

/** 切到内置主页 / 关闭自定义主页时清空，下一次启用会重新核对一次。 */
export function resetProbe(): void {
  state = idle()
  publish()
}

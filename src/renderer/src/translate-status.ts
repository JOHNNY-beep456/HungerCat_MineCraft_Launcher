import { useSyncExternalStore } from 'react'

/**
 * 翻译子系统的全局状态，供标题栏呼吸灯展示。
 *
 * - `off`：未开启翻译（设置关闭 / 本地模式 / 界面语言为英语）
 * - `none`：已开启但当前无需翻译（当前页面没有可翻译内容）
 * - `translating`：正在翻译
 * - `done`：已翻译
 * - `error`：翻译出错
 *
 * 状态按「当前已挂载的翻译实例」聚合：某个页面挂载 useAutoTranslate 即注册一份统计，
 * 离开页面即注销。这样切换页面时状态会随旧实例注销 / 新实例注册即时刷新，
 * 而不是被历史页面的结果永久占用。
 */
export type TranslateState = 'off' | 'none' | 'translating' | 'done' | 'error'

type Listener = () => void

/** 单个翻译实例（一次 useAutoTranslate 挂载）的统计。 */
interface InstanceState {
  /** 该实例正在进行中的批次数量。 */
  inflight: number
  /** 该实例是否出现过翻译失败。 */
  failed: boolean
  /** 该实例当前可见文案中已存在真实译文的条数。 */
  translated: number
}

const listeners = new Set<Listener>()
const instances = new Map<number, InstanceState>()

let enabled = false
let locale = ''
let seq = 0
let snapshot: TranslateState = 'off'

const EMPTY: InstanceState = { inflight: 0, failed: false, translated: 0 }

function derive(): TranslateState {
  if (!enabled) return 'off'
  let inflight = 0
  let translated = 0
  let failed = false
  for (const st of instances.values()) {
    inflight += st.inflight
    translated += st.translated
    if (st.failed) failed = true
  }
  if (inflight > 0) return 'translating'
  if (failed) return 'error'
  if (translated > 0) return 'done'
  return 'none'
}

function emit(): void {
  const next = derive()
  if (next === snapshot) return
  snapshot = next
  for (const l of listeners) l()
}

function getInstance(id: number): InstanceState {
  let st = instances.get(id)
  if (!st) {
    st = { ...EMPTY }
    instances.set(id, st)
  }
  return st
}

export const translateStatus = {
  /** 为一次 useAutoTranslate 挂载分配唯一 id。 */
  nextId(): number {
    seq += 1
    return seq
  },
  /** 依据设置 / 语言 / 模式设置当前是否启用翻译。 */
  setEnabled(next: boolean): void {
    if (enabled === next) return
    enabled = next
    // 关闭翻译时清空所有实例统计，重新开启后从「无需翻译」起步。
    if (!next) instances.clear()
    emit()
  },
  /** 设置当前目标语言；语言变化时旧译文失效，重置已翻译 / 错误统计。 */
  setLocale(next: string): void {
    if (locale === next) return
    locale = next
    for (const st of instances.values()) {
      st.translated = 0
      st.failed = false
    }
    emit()
  },
  /** 更新某个实例的统计（如：当前可见文案里已翻译的条数）。 */
  report(id: number, patch: Partial<InstanceState>): void {
    Object.assign(getInstance(id), patch)
    emit()
  },
  /** 某个实例的一批翻译开始。 */
  begin(id: number): void {
    getInstance(id).inflight += 1
    emit()
  },
  /** 某个实例的一批翻译结束；`ok` 为是否成功。 */
  end(id: number, ok: boolean): void {
    const st = instances.get(id)
    if (!st) return
    st.inflight = Math.max(0, st.inflight - 1)
    // 恢复成功即清除错误态，避免一次瞬时网络故障让指示灯长期停在红色。
    st.failed = !ok
    emit()
  },
  /** 实例卸载（离开页面）：注销统计，使呼吸灯即时刷新。 */
  remove(id: number): void {
    if (instances.delete(id)) emit()
  }
}

function getSnapshot(): TranslateState {
  return snapshot
}

function subscribe(cb: Listener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** 订阅当前翻译状态（用于标题栏呼吸灯）。 */
export function useTranslateState(): TranslateState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

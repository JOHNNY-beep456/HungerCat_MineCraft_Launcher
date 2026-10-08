import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useApp } from './store'
import { translateStatus } from './translate-status'
import { isTargetLang } from './lang-detect'

/**
 * 资源名 / 简介自动翻译（实验性）。
 *
 * 由主进程转发到网络进程，调用免费在线翻译接口完成翻译。
 * 译文按「目标语言 + 原文」缓存，跨组件 / 跨页面复用；失败时回退原文，
 * 界面不会因翻译失败而报错或空白。本地模式下不联网、不翻译。
 */
const cache = new Map<string, string>()
/** 已发出但未返回的键，避免并发重复请求同一段文案。 */
const inflight = new Set<string>()
/**
 * 未翻出来的键 → { 上次失败时间, 已尝试次数 }。
 *
 * 不能像以前那样「失败即永久拉黑」：接口偶发限流（HTTP 429）时，被拉黑的那几条
 * 就会永远是原文，直到重启应用。改为冷却一段时间后再试，界面可以自愈；
 * 次数上限则作为「接口长期不可用」时的兜底，避免无限重试。
 */
const failedAt = new Map<string, { at: number; tries: number }>()
/**
 * 已确认「无需翻译」的键（如简介本来就是目标语言）。落定后不再重试。
 */
const settled = new Set<string>()
/** 失败后重新尝试的冷却时间（毫秒）。 */
const RETRY_COOLDOWN = 30_000
/** 同一条最多尝试的轮数：超过则认为确实无需翻译，不再重试。 */
const RETRY_MAX = 3

/** 单轮最多提交的条数：分批推进，让译文分几批逐步出现，而不是一次性等很久。 */
const BATCH = 6

/**
 * 译文缓存版本号：任何一次译文写入都会递增。使用 useSyncExternalStore 订阅它，
 * 「用到译文的组件」就能在译文到达的那一刻立刻重渲染，原文随之被替换。
 * 这是「翻译完成后即时替换」的可靠保证——不再依赖 effect 是否恰好重跑、
 * 也不再依赖 setState 的时机（原实现用 effect 内的闭包变量做守卫，
 * 在 StrictMode / effect 重跑时会把重渲染触发一并作废）。
 */
let cacheVersion = 0
const cacheListeners = new Set<() => void>()
function emitCache(): void {
  cacheVersion += 1
  for (const l of cacheListeners) l()
}
function subscribeCache(cb: () => void): () => void {
  cacheListeners.add(cb)
  return () => {
    cacheListeners.delete(cb)
  }
}
function getCacheVersion(): number {
  return cacheVersion
}

const keyOf = (target: string, text: string): string => `${target}\u0000${text}`

/**
 * 归一化文本：翻译请求、写入缓存、查表取值三处必须使用同一份文本。
 * 统一去掉首尾空白——否则「带尾随空白的简介」写入缓存用 trim 后的键、
 * 取值却用原文的键，会出现「呼吸灯显示已翻译，而界面仍是原文」的不一致。
 */
const norm = (text: string | undefined): string => (text ?? '').trim()

/**
 * 传入当前页面「可见」的文案列表；返回取译文的函数（未开启 / 未命中时回退原文）。
 * 未缓存的文案按批翻译：每轮取若干条，返回后触发下一轮，直至全部处理完。
 */
export function useAutoTranslate(texts: Array<string | undefined>): (text: string | undefined) => string {
  const { settings, locale } = useApp()
  // 英语界面同样需要翻译：不少资源简介是中文 / 其它语言，应翻成英文。
  // 「已是目标语言」的条目（英文界面下的英文原文）由语言检测提前跳过，不会发请求。
  const enabled = !!settings.autoTranslateResources && settings.mode !== 'local'
  const [tick, setTick] = useState(0)
  // 每个挂载实例一个稳定 id，用于向「翻译状态」注册 / 注销自己的统计。
  const [id] = useState(() => translateStatus.nextId())
  // 用内容拼接作为依赖：文案集合变化时才重新发起翻译。
  const signature = texts.filter(Boolean).join('\u0001')

  // 订阅译文缓存：任何译文写入都会让本组件重渲染，从而即时用译文替换原文。
  useSyncExternalStore(subscribeCache, getCacheVersion, getCacheVersion)

  // 组件是否仍挂载：用 ref 而非「每次 effect 运行独立的 alive 变量」——后者在
  // StrictMode 的 setup→cleanup→setup（开发模式）或文案集合变化导致 effect 重跑时，
  // 会把在飞请求的「完成后再渲染」触发一并作废，表现为译文已缓存但界面不刷新。
  const mounted = useRef(true)
  // 卸载即注销：离开页面时呼吸灯立刻回落，而不是停留在上一页的「已翻译」。
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      translateStatus.remove(id)
    }
  }, [id])

  useEffect(() => {
    // 回填全局状态供标题栏呼吸灯展示（幂等，多实例共享）。
    translateStatus.setEnabled(enabled)
    translateStatus.setLocale(locale)
    if (!enabled) {
      translateStatus.remove(id)
      return
    }

    // 一次遍历同时完成两件事：统计「已存在真实译文」的条数、收集仍需翻译的文案。
    let translatedCount = 0
    // 被「失败冷却」拦下的条目中最早的可重试时刻（0 表示没有）。
    let retryAt = 0
    const pending: string[] = []
    // 目标是否为中文（简 / 繁）：用于丢弃「不含汉字」的异常译文（见下方写入处）。
    const isZhTarget = locale === 'zh-CN' || locale === 'zh-TW'
    for (const raw of texts) {
      const s = norm(raw)
      if (!s || s.length > 1800) continue
      const k = keyOf(locale, s)
      const cached = cache.get(k)
      if (cached !== undefined) {
        // 命中缓存：译文不同于原文才算「已翻译」；相同（已是目标语言 / 失败）则跳过。
        if (cached !== s) translatedCount += 1
        continue
      }
      if (inflight.has(k) || settled.has(k)) continue
      // 语言检测：文本已是目标语言（如中文界面下的中文简介）则落定为「无需翻译」，
      // 不发起任何翻译请求。这样「与设置语言一致就不翻译」，也避免中→中的无谓调用。
      if (isTargetLang(s, locale)) {
        settled.add(k)
        continue
      }
      const f = failedAt.get(k)
      if (f) {
        // 尝试次数用尽：视为确实无需翻译，不再重试。
        if (f.tries >= RETRY_MAX) continue
        const due = f.at + RETRY_COOLDOWN
        if (Date.now() < due) {
          if (!retryAt || due < retryAt) retryAt = due
          continue
        }
      }
      inflight.add(k)
      pending.push(s)
    }
    translateStatus.report(id, { translated: translatedCount })
    if (pending.length === 0) {
      // 没有可提交项、但存在「冷却中」的条目时，到点自动再试一轮；
      // 否则偶发限流造成的失败要等到下次重新挂载页面才会重试。
      if (retryAt) {
        const timer = setTimeout(
          () => {
            if (mounted.current) setTick((v) => v + 1)
          },
          Math.max(500, retryAt - Date.now())
        )
        return () => clearTimeout(timer)
      }
      return
    }

    // 只取本轮允许的条数，其余交回给自己（移出 inflight 以便下一轮重新收集）。
    const batch = pending.slice(0, BATCH)
    for (const s of pending.slice(BATCH)) inflight.delete(keyOf(locale, s))

    translateStatus.begin(id)
    void window.api.translate
      .texts(batch, locale)
      .then((pairs) => {
        // 写入时同样归一化，保证与 tr() 的查表键一致。
        let wrote = false
        let anyFailed = false
        for (const [src, dst] of pairs) {
          const key = norm(src)
          if (!key) continue
          const k = keyOf(locale, key)
          const out = norm(dst)
          // 空译文 = 这条没翻出来（接口限流 / 失败）。绝不能写进缓存：
          // 缓存一旦被当成「已有译文」，该条就被永久定格在原文，
          // 界面再也换不成译文（呼吸灯还会显示「已翻译」，极具误导性）。
          // 记入冷却表，过一会儿再试。
          if (!out) {
            const prev = failedAt.get(k)
            failedAt.set(k, { at: Date.now(), tries: (prev?.tries ?? 0) + 1 })
            anyFailed = true
            continue
          }
          // 目标为中文，却翻出「不含任何汉字」的结果：说明在线接口把中文误判成日/英并
          // 翻成了英文（实测「馋猫网|…|AI交流の猫窝」在 to_lang=zh 时会翻成英文）。
          // 丢弃该译文、保留原文，避免中文界面显示英文；落定为「无需翻译」以免反复请求。
          if (isZhTarget && !/[\u4e00-\u9fff\u3400-\u4dbf]/.test(out)) {
            settled.add(k)
            failedAt.delete(k)
            continue
          }
          // 译文与原文相同 = 确实无需翻译，落定后不再重试。
          if (out === key) {
            settled.add(k)
            failedAt.delete(k)
            continue
          }
          cache.set(k, out)
          failedAt.delete(k)
          wrote = true
        }
        // 译文刚写入即通知所有订阅者重渲染——这是「原文即时被替换」的关键。
        if (wrote) emitCache()
        // 「已翻译」条数由下一轮 effect 依据缓存重新统计，这里只需结束本批。
        // 一条都没写成功且确实失败过，才算「翻译出错」；全部「无需翻译」不算错。
        translateStatus.end(id, wrote || !anyFailed)
      })
      .catch(() => {
        for (const s of batch) {
          const k = keyOf(locale, s)
          const prev = failedAt.get(k)
          failedAt.set(k, { at: Date.now(), tries: (prev?.tries ?? 0) + 1 })
        }
        translateStatus.end(id, false)
      })
      .finally(() => {
        for (const s of batch) inflight.delete(keyOf(locale, s))
        // 递增以触发下一轮：若还有未处理项会被重新收集，处理完则自然停止。
        // 用 mounted ref 而非本次 effect 的闭包变量做守卫，避免 StrictMode 下
        // setup→cleanup→setup 把「继续处理下一批」的触发一并作废。
        if (mounted.current) setTick((v) => v + 1)
      })
    // texts 以 signature 代表，避免每次渲染都触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, locale, signature, tick])

  return (text) => {
    const s = text ?? ''
    if (!enabled || !s) return s
    const key = norm(s)
    if (!key) return s
    return cache.get(keyOf(locale, key)) ?? s
  }
}

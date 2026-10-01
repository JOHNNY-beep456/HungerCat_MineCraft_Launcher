// ---------------------------------------------------------------------------
// 在线翻译（网络进程侧）。
//
// 采用「多接口自动回退」：按顺序尝试多个免费翻译接口，任一成功即返回，
// 全部失败才回退原文。这样单个接口失效（改版 / 限流 / 网络不可达）不会让
// 整个功能不可用——尤其 Google 的 translate.googleapis.com 在国内常不可达。
//
// 接口顺序（兼顾可用性与质量）：
//   1. uapis.cn（国内可直连、接口简单、速度快）；
//   2. MyMemory（老牌免费接口，作兜底）。
//
// 本模块只做网络请求，全部经网络进程执行，不阻塞 UI。
// ---------------------------------------------------------------------------

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

/** 单个接口的单次请求超时（毫秒）。整体最坏耗时 = 上限 × 接口数，仍在主进程超时内。 */
const PER_PROVIDER_TIMEOUT = 12_000

function log(...args: unknown[]): void {
  console.log('[翻译]', ...args)
}

/* ------------------------------------------------------------------ */
/* 语言代码映射                                                        */
/* ------------------------------------------------------------------ */

/** 目标语言 → uapis.cn 语言代码（简体=zh，繁体=zh-TW，英语=en）。 */
function uapiLang(target: string): string {
  if (target === 'zh-TW') return 'zh-TW'
  if (target === 'zh-CN' || target === 'zh') return 'zh'
  return target || 'zh'
}

/** 目标语言 → MyMemory 的 langpair 代码。 */
function myMemoryLang(target: string): string {
  if (target === 'zh-TW') return 'zh-TW'
  if (target === 'zh-CN' || target === 'zh') return 'zh-CN'
  return target || 'zh-CN'
}

/* ------------------------------------------------------------------ */
/* 接口 1：uapis.cn                                                    */
/* ------------------------------------------------------------------ */

const UAPI_URL = 'https://uapis.cn/api/v1/translate/text'

async function uapiTranslate(text: string, target: string, apiKey: string): Promise<string> {
  const res = await fetch(`${UAPI_URL}?to_lang=${encodeURIComponent(uapiLang(target))}`, {
    method: 'POST',
    // KEY 走 Authorization 请求头（实测：不带头 = 访客额度；头写错会返回 401
    // INVALID_API_KEY，而 apikey 头会被忽略，故不能用它）。
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({ text: text.slice(0, 3000) }),
    signal: AbortSignal.timeout(PER_PROVIDER_TIMEOUT)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as { translate?: string }
  const out = data.translate
  if (typeof out === 'string' && out.trim()) return out
  throw new Error('返回结构异常')
}

/* ------------------------------------------------------------------ */
/* 接口 3：MyMemory                                                    */
/* ------------------------------------------------------------------ */

async function myMemoryTranslate(text: string, target: string): Promise<string> {
  // 注意：MyMemory 的源语言自动检测关键字是 `Autodetect`，写成 `auto` 会被拒绝
  // （返回 "AUTO IS AN INVALID SOURCE LANGUAGE"）。
  const url =
    'https://api.mymemory.translated.net/get' +
    `?q=${encodeURIComponent(text.slice(0, 500))}&langpair=Autodetect|${encodeURIComponent(myMemoryLang(target))}`
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(PER_PROVIDER_TIMEOUT) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as {
    responseData?: { translatedText?: string }
    responseStatus?: number | string
  }
  // MyMemory 出错时 HTTP 仍为 200，真实状态在 responseStatus（如 403 配额用尽），
  // 错误说明则被塞进 translatedText，需以 responseStatus 为准判定。
  const status = Number(data.responseStatus ?? 200)
  const out = data.responseData?.translatedText
  if (status === 200 && typeof out === 'string' && out.trim()) return out
  throw new Error(out ? `接口返回错误：${String(out).slice(0, 60)}` : `状态 ${status}`)
}

/* ------------------------------------------------------------------ */
/* 回退链                                                              */
/* ------------------------------------------------------------------ */

/**
 * 翻译提供方列表：按顺序尝试，任一成功即返回。
 * `needsKey` 表示该接口是否使用用户的 API KEY（MyMemory 免费接口不需要）。
 */
const PROVIDERS: Array<{
  name: string
  needsKey: boolean
  run: (text: string, target: string, apiKey: string) => Promise<string>
}> = [
  { name: 'uapis', needsKey: true, run: uapiTranslate },
  { name: 'mymemory', needsKey: false, run: (text, target) => myMemoryTranslate(text, target) }
]

/* ------------------------------------------------------------------ */
/* 请求节流                                                            */
/* ------------------------------------------------------------------ */

/**
 * 节流参数分两档，取决于用户是否填了 uapis.cn 的 API KEY：
 *
 * - 访客额度：实测为「每窗口 4 次」，突发并发会被直接拒绝
 *   （HTTP 429 且响应体为 {"code":429,"limit":4}）。这正是「前几条翻译出来了、
 *   后面一堆仍是英文」的原因。实测间隔 ≥300ms 即不再触发限流，这里留出余量。
 * - 已填 KEY：配额显著放宽，不再需要人为间隔，改为多路并发，
 *   整页文案可在 1 秒左右翻完。数值取 8——对多数付费额度都是一个留有余量的选择，
 *   万一额度更低也只是偶发 429，会走退避重试（不会被缓存成「没翻出来」）。
 */
const GUEST_GAP = 400
const GUEST_CONCURRENCY = 1
const KEYED_GAP = 0
const KEYED_CONCURRENCY = 8

/** 当前生效的节流参数，由 translateTexts 在每批开始前按是否带 KEY 设定。 */
let gap = GUEST_GAP
let concurrency = GUEST_CONCURRENCY
let lastRequestAt = 0
let active = 0
const waiters: Array<() => void> = []

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 受限执行：最多 `concurrency` 个请求同时在飞，且相邻请求起始间隔 ≥ `gap`。
 *
 * 节流必须做在请求出口处，而不是靠上层「少发几条」——上层一次提交一批是正常的，
 * 限流与否取决于这一批请求怎么打出去。
 */
async function schedule<T>(task: () => Promise<T>): Promise<T> {
  if (active >= concurrency) {
    await new Promise<void>((resolve) => waiters.push(resolve))
  }
  active++
  try {
    if (gap > 0) {
      const wait = lastRequestAt + gap - Date.now()
      if (wait > 0) await sleep(wait)
    }
    lastRequestAt = Date.now()
    return await task()
  } finally {
    active--
    // 让出名额给排队中的请求（无论成败）。
    waiters.shift()?.()
  }
}

/* ------------------------------------------------------------------ */
/* 接口熔断                                                            */
/* ------------------------------------------------------------------ */

/** 遇限流时的最大重试次数与退避基数（毫秒）。 */
const RETRY_MAX = 2
const RETRY_BACKOFF = 800

/**
 * 接口熔断：连续失败达到阈值后，在冷却期内直接跳过该接口。
 * 否则一个失效接口（改版 / 长期不可用）会让每次翻译都白等若干秒超时。
 *
 * 注意：HTTP 429 属于「临时限流」，由上面的节流与退避重试处理，**不计入熔断**——
 * 否则一次限流就会把本来可用的接口封禁 5 分钟。
 */
const breaker = new Map<string, { fails: number; until: number }>()
const BREAKER_THRESHOLD = 3
const BREAKER_COOLDOWN = 5 * 60 * 1000

/** 是否属于「限流」错误：应退避重试，而非判定接口不可用。 */
function isRateLimited(message: string): boolean {
  return /429|rate limit|too many/i.test(message)
}

function isBroken(name: string): boolean {
  const b = breaker.get(name)
  if (!b) return false
  if (Date.now() >= b.until) {
    breaker.delete(name)
    return false
  }
  return b.fails >= BREAKER_THRESHOLD
}

function markOk(name: string): void {
  breaker.delete(name)
}

function markFail(name: string): void {
  const b = breaker.get(name) ?? { fails: 0, until: 0 }
  b.fails += 1
  b.until = Date.now() + BREAKER_COOLDOWN
  breaker.set(name, b)
}

/**
 * 单条翻译：依次尝试各接口（各自带限流退避重试）。
 *
 * 全部失败时返回**空串**（而不是原文）——这样上层能区分两种情况：
 * 「这次没翻出来，稍后应重试」与「本来无需翻译」。若失败也返回原文，
 * 渲染层只能看到「译文 == 原文」，会把失败当成功缓存，导致该条永远是原文。
 */
async function translateOne(text: string, target: string, apiKey: string): Promise<string> {
  const q = text.trim()
  if (!q) return text
  const errors: string[] = []
  for (const p of PROVIDERS) {
    if (isBroken(p.name)) {
      errors.push(`${p.name}:已熔断跳过`)
      continue
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const out = await schedule(() => p.run(q, target, p.needsKey ? apiKey : ''))
        if (out && out.trim()) {
          markOk(p.name)
          return out
        }
        errors.push(`${p.name}:空结果`)
        markFail(p.name)
        break
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // 限流：退避后重试同一接口；其它错误（参数错 / 结构异常）重试无意义，直接换下一个。
        if (isRateLimited(msg) && attempt < RETRY_MAX) {
          errors.push(`${p.name}:${msg}(重试 ${attempt + 1})`)
          await sleep(RETRY_BACKOFF * 2 ** attempt)
          continue
        }
        errors.push(`${p.name}:${msg}`)
        if (!isRateLimited(msg)) markFail(p.name)
        break
      }
    }
  }
  // 全部失败：记录原因（便于在 Debug 日志窗口定位），返回空串表示「未翻出来」。
  log(`全部接口失败 → ${errors.join(' | ')}`)
  return ''
}

/* ------------------------------------------------------------------ */
/* 对外：批量翻译                                                       */
/* ------------------------------------------------------------------ */

interface TranslateParams {
  texts: string[]
  /** 目标语言（zh-CN / zh-TW / en）。 */
  target: string
  /** uapis.cn 的 API KEY；留空则使用访客额度（串行 + 间隔发送）。 */
  apiKey?: string
}

/** 单次请求最多翻译的条数（每条一次 HTTP 请求，限制批量以免请求过久）。 */
const MAX_BATCH = 40

/**
 * 文本是否已是目标语言（用于跳过无谓的翻译请求）。
 *
 * 只对「英文目标」做判断：不含 CJK 即视为已是英文。
 * 中文目标（简体 / 繁体）**不能**因为「含中文」就跳过——简体与繁体同属 CJK，
 * 否则把界面切到繁体时，简体文本会被误判为「已是目标语言」而原样返回，
 * 表现为「切换为繁体后译文仍是简体」。
 */
function alreadyTarget(text: string, target: string): boolean {
  if (target !== 'en') return false
  return !/[\u4e00-\u9fff\u3400-\u4dbf]/.test(text)
}

/**
 * 批量翻译：按当前档位（访客 / 已填 KEY）并发执行，失败的条目返回空串。
 * 并发与间隔都由 schedule() 统一控制，这里按档位取几个 worker 即可。
 */
export async function translateTexts(p: TranslateParams): Promise<Array<[string, string]>> {
  const target = p.target || 'zh-CN'
  const apiKey = typeof p.apiKey === 'string' ? p.apiKey.trim() : ''
  const list = (Array.isArray(p.texts) ? p.texts : []).slice(0, MAX_BATCH)
  const out: Array<[string, string]> = new Array(list.length)
  let okCount = 0

  // 按是否带 KEY 切换档位：访客串行 + 间隔；带 KEY 多路并发、无人工间隔。
  gap = apiKey ? KEYED_GAP : GUEST_GAP
  concurrency = apiKey ? KEYED_CONCURRENCY : GUEST_CONCURRENCY

  let cursor = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++
      if (i >= list.length) return
      const raw = list[i]
      const s = typeof raw === 'string' ? raw : String(raw ?? '')
      const q = s.trim()
      // 空文本 / 过长文本 / 已是目标语言：无需翻译，原样返回。
      if (!q || q.length > 1800 || alreadyTarget(q, target)) {
        out[i] = [s, s]
        continue
      }
      const translated = await translateOne(s, target, apiKey)
      // 空串代表「这次没翻出来」，不算成功（也不等于原文，以免被上层当成功缓存）。
      if (translated && translated !== s) okCount++
      out[i] = [s, translated]
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, () => worker())
  )

  log(`批量完成：目标=${target} 共 ${list.length} 条，成功 ${okCount} 条${apiKey ? '（已用 API KEY）' : '（访客额度）'}`)
  return out
}

/* ------------------------------------------------------------------ */
/* 对外：API KEY 连通性测试                                             */
/* ------------------------------------------------------------------ */

/** 连通性测试用的固定短句（英文，便于判断是否真的翻出来了）。 */
const TEST_TEXT = 'Hello, world!'

/**
 * 用给定 API KEY 真实请求一次 uapis 翻译接口，返回可直接展示给用户的结论。
 *
 * 必须走真实请求而不是只校验格式——KEY 可能格式正确但已失效 / 额度用尽。
 * 测试文本固定为英文短句，返回非空译文即视为可用。
 */
export async function testUapisKey(apiKey: string): Promise<{ ok: boolean; message: string }> {
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (!key) return { ok: false, message: '未填写 API KEY' }
  try {
    const res = await fetch(`${UAPI_URL}?to_lang=zh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ text: TEST_TEXT }),
      signal: AbortSignal.timeout(PER_PROVIDER_TIMEOUT)
    })
    const data = (await res.json().catch(() => ({}))) as {
      translate?: string
      code?: string
      message?: string
    }
    if (res.ok && typeof data.translate === 'string' && data.translate.trim()) {
      return { ok: true, message: `连接成功，测试译文：${data.translate.trim()}` }
    }
    if (res.status === 401 || data.code === 'INVALID_API_KEY') {
      return { ok: false, message: data.message || 'API KEY 无效或已失效' }
    }
    if (res.status === 429) return { ok: false, message: '请求过于频繁（429），请稍后重试' }
    return { ok: false, message: data.message || `请求失败（HTTP ${res.status}）` }
  } catch (err) {
    return { ok: false, message: `无法连接 uapis.cn：${err instanceof Error ? err.message : String(err)}` }
  }
}

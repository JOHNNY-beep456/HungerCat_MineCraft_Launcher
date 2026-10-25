/**
 * AI 接口客户端：把「一套对话」翻译成各家 HTTP 协议。
 *
 * 设计要点：
 *   · **只有本文件认识各家协议**。上层（service.ts）只看到 `AiTurn`：
 *     一句回复正文 + 若干个工具调用请求，与具体厂商无关。
 *   · 五种格式（openai / anthropic / gemini / ollama / custom）覆盖了绝大多数
 *     可用端点：各类兼容网关（one-api、new-api、vLLM、LM Studio…）都走 openai 那套；
 *     custom 则是「按 OpenAI 请求体原样发到 aiBaseUrl」，给不改路径的特殊网关用。
 *   · 不做流式：这里的回复要经过「工具确认 → 执行 → 回灌」的多轮编排，流式反而
 *     让状态更难收敛；一次请求拿完整结果，界面用「思考中」占位即可。
 *   · 所有请求都带 AbortSignal，用户点「取消」时能立刻断开。
 */
import { net } from 'electron'
import type { AiApiFormat, AiChatMessage, AiToolSpec } from '@shared/types'

/** 一次请求用到的连接参数（由设置 + 安全存储拼出来）。 */
export interface AiProfile {
  format: AiApiFormat
  /** 版本根地址，如 `https://api.openai.com/v1`（不带尾斜杠）。 */
  baseUrl: string
  model: string
  /** 密钥；Ollama 这类本地服务可为空串。 */
  apiKey: string
  /** 附加请求头（用户自定义，已解析）。 */
  headers: Record<string, string>
}

/** 模型要求调用的一次工具。 */
export interface AiToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

/** 一轮模型输出。 */
export interface AiTurn {
  text: string
  toolCalls: AiToolCall[]
}

/** 请求失败：message 已经是可直接展示给用户的文案。 */
export class AiRequestError extends Error {}

/** 聊天请求的绝对超时：模型「想得久」很常见，但也不该无限等。 */
const CHAT_TIMEOUT_MS = 120_000
/** 语音转写的超时。 */
const STT_TIMEOUT_MS = 90_000

/** 去掉尾部斜杠，避免拼出 `//chat/completions`。 */
function trimBase(base: string): string {
  return base.trim().replace(/\/+$/, '')
}

/**
 * 解析用户填的自定义请求头。
 *
 * 允许 `{"X-Foo":"bar"}` 这种 JSON 对象；也容忍「一行一个 `Key: Value`」的写法
 * （很多人习惯直接粘贴 curl 里的头）。解析不出来就抛错——静默忽略会让人以为
 * 生效了，反而更难排查。
 */
export function parseHeaders(raw: string): Record<string, string> {
  const text = raw.trim()
  if (!text) return {}
  const out: Record<string, string> = {}
  if (text.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      throw new AiRequestError(`请求头不是合法的 JSON：${err instanceof Error ? err.message : String(err)}`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AiRequestError('请求头必须是 JSON 对象，例如 {"X-Foo":"bar"}')
    }
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v)
    }
    return out
  }
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const k = line.slice(0, idx).trim()
    const v = line.slice(idx + 1).trim()
    if (k) out[k] = v
  }
  return out
}

/** 读响应体并把非 2xx 转成可读错误。 */
async function readJson(res: Response, what: string): Promise<unknown> {
  const text = await res.text()
  if (!res.ok) {
    // 尽量把服务端给的错误信息露出来（常见是「模型不存在 / 密钥无效 / 余额不足」）。
    let detail = text.slice(0, 400)
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string }
      const e = typeof j.error === 'string' ? j.error : j.error?.message
      detail = e ?? j.message ?? detail
    } catch {
      /* 非 JSON 就原文截断 */
    }
    throw new AiRequestError(`${what}失败（HTTP ${res.status}）：${detail || res.statusText}`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new AiRequestError(`${what}失败：响应不是 JSON（前 200 字）：${text.slice(0, 200)}`)
  }
}

/** 把工具清单转成 OpenAI 的 function 声明。 */
function openAiTools(tools: AiToolSpec[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema }
  }))
}

/** 把工具清单转成 Anthropic 的 tools 声明。 */
function anthropicTools(tools: AiToolSpec[]): unknown[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))
}

/** 把工具清单转成 Gemini 的 functionDeclarations。 */
function geminiTools(tools: AiToolSpec[]): unknown[] {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema
      }))
    }
  ]
}

/** 安全地把模型给的参数解析成对象。 */
function asArgs(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      const j = JSON.parse(raw) as unknown
      if (j && typeof j === 'object' && !Array.isArray(j)) return j as Record<string, unknown>
    } catch {
      /* 忽略：当成空参数 */
    }
  }
  return {}
}

/** 发一次聊天请求，返回这一轮的正文与工具调用。 */
export async function requestChat(
  profile: AiProfile,
  messages: AiChatMessage[],
  tools: AiToolSpec[],
  signal: AbortSignal
): Promise<AiTurn> {
  const base = trimBase(profile.baseUrl)
  if (!base) throw new AiRequestError('未配置 API 地址，请到「设置 - AI 助手」填写')
  if (!profile.model.trim()) throw new AiRequestError('未配置模型 ID，请到「设置 - AI 助手」填写')

  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...profile.headers }
  let url = base
  let body: Record<string, unknown>

  const systemMsgs = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const talk = messages.filter((m) => m.role !== 'system')

  switch (profile.format) {
    case 'openai':
    case 'custom': {
      url = profile.format === 'custom' ? base : `${base}/chat/completions`
      if (profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`
      body = { model: profile.model, messages, temperature: 0.3, stream: false }
      if (tools.length > 0) {
        body.tools = openAiTools(tools)
        body.tool_choice = 'auto'
      }
      break
    }
    case 'anthropic': {
      url = `${base}/messages`
      headers['x-api-key'] = profile.apiKey
      headers['anthropic-version'] = '2023-06-01'
      body = {
        model: profile.model,
        max_tokens: 2048,
        temperature: 0.3,
        system: systemMsgs || undefined,
        messages: talk.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
      }
      if (tools.length > 0) body.tools = anthropicTools(tools)
      break
    }
    case 'gemini': {
      url = `${base}/models/${encodeURIComponent(profile.model)}:generateContent`
      if (profile.apiKey) headers['x-goog-api-key'] = profile.apiKey
      body = {
        contents: talk.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        })),
        generationConfig: { temperature: 0.3 },
        systemInstruction: systemMsgs ? { parts: [{ text: systemMsgs }] } : undefined
      }
      if (tools.length > 0) body.tools = geminiTools(tools)
      break
    }
    case 'ollama':
    default: {
      url = `${base}/api/chat`
      if (profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`
      body = { model: profile.model, messages, stream: false, options: { temperature: 0.3 } }
      if (tools.length > 0) body.tools = openAiTools(tools)
      break
    }
  }

  // 用 Electron 的 net 而不是全局 fetch：它会走系统代理设置（
  // 公司网络里 API 常常只能经代理访问），并且与项目其它网络请求行为一致。
  const timeout = timeoutSignal(signal, CHAT_TIMEOUT_MS)
  try {
    const res = await net.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: timeout.signal
    })
    const json = (await readJson(res, 'AI 请求')) as Record<string, unknown>

    return parseChatResponse(profile.format, json)
  } finally {
    timeout.dispose()
  }
}

/**
 * 组合「用户取消」与「超时」两个信号。
 *
 * 返回 `signal` 与 `dispose`：**请求结束后必须 dispose**，否则那个
 * `setTimeout` 会一直挂到超时才释放（每次对话泄漏一个 120 秒的定时器，
 * 以及一个挂在外部 signal 上的监听器）。
 */
function timeoutSignal(outer: AbortSignal, ms: number): { signal: AbortSignal; dispose: () => void } {
  const ctrl = new AbortController()
  const onAbort = (): void => ctrl.abort(outer.reason)
  const timer = setTimeout(() => ctrl.abort(new AiRequestError(`请求超时（${Math.round(ms / 1000)} 秒无响应）`)), ms)
  if (outer.aborted) onAbort()
  else outer.addEventListener('abort', onAbort, { once: true })

  let done = false
  const dispose = (): void => {
    if (done) return
    done = true
    clearTimeout(timer)
    outer.removeEventListener('abort', onAbort)
  }
  // 已中止（超时 / 取消）时顺手把自己清理掉。
  ctrl.signal.addEventListener('abort', dispose, { once: true })
  return { signal: ctrl.signal, dispose }
}

/** 按格式解析各家的响应体。 */
function parseChatResponse(format: AiApiFormat, json: Record<string, unknown>): AiTurn {
  const toolCalls: AiToolCall[] = []
  let text = ''

  if (format === 'anthropic') {
    const blocks = (json.content as Array<Record<string, unknown>> | undefined) ?? []
    for (const b of blocks) {
      if (b.type === 'text' && typeof b.text === 'string') text += b.text
      if (b.type === 'tool_use' && typeof b.name === 'string') {
        toolCalls.push({ id: String(b.id ?? b.name), name: b.name, args: asArgs(b.input) })
      }
    }
    return { text: text.trim(), toolCalls }
  }

  if (format === 'gemini') {
    const cands = (json.candidates as Array<Record<string, unknown>> | undefined) ?? []
    const parts =
      ((cands[0]?.content as Record<string, unknown> | undefined)?.parts as
        | Array<Record<string, unknown>>
        | undefined) ?? []
    for (const p of parts) {
      if (typeof p.text === 'string') text += p.text
      const fc = p.functionCall as { name?: string; args?: unknown } | undefined
      if (fc && typeof fc.name === 'string') {
        toolCalls.push({ id: `${fc.name}-${toolCalls.length}`, name: fc.name, args: asArgs(fc.args) })
      }
    }
    return { text: text.trim(), toolCalls }
  }

  // ollama：{ message: { content, tool_calls: [{ function: { name, arguments } }] } }
  if (format === 'ollama') {
    const msg = (json.message as Record<string, unknown> | undefined) ?? {}
    if (typeof msg.content === 'string') text = msg.content
    const calls = (msg.tool_calls as Array<Record<string, unknown>> | undefined) ?? []
    calls.forEach((c, i) => {
      const fn = (c.function as { name?: string; arguments?: unknown } | undefined) ?? {}
      if (typeof fn.name === 'string') {
        toolCalls.push({ id: `${fn.name}-${i}`, name: fn.name, args: asArgs(fn.arguments) })
      }
    })
    return { text: text.trim(), toolCalls }
  }

  // openai / custom：{ choices: [{ message: { content, tool_calls } }] }
  const choices = (json.choices as Array<Record<string, unknown>> | undefined) ?? []
  const msg = (choices[0]?.message as Record<string, unknown> | undefined) ?? {}
  if (typeof msg.content === 'string') text = msg.content
  else if (Array.isArray(msg.content)) {
    // 少数网关把 content 返回成 [{type:'text',text}] 数组。
    for (const part of msg.content as Array<Record<string, unknown>>) {
      if (typeof part.text === 'string') text += part.text
    }
  }
  const calls = (msg.tool_calls as Array<Record<string, unknown>> | undefined) ?? []
  calls.forEach((c, i) => {
    const fn = (c.function as { name?: string; arguments?: unknown } | undefined) ?? {}
    if (typeof fn.name === 'string') {
      toolCalls.push({ id: String(c.id ?? `${fn.name}-${i}`), name: fn.name, args: asArgs(fn.arguments) })
    }
  })
  return { text: text.trim(), toolCalls }
}

/**
 * 语音转文字。
 *
 * 只实现 OpenAI 兼容的 `/audio/transcriptions`（multipart，`file` + `model`）：
 * 这是事实标准，多数兼容网关都提供；其余格式直接给出可读提示，由界面回落到
 * 「仅用文字聊天」，而不是静默失败。
 */
export async function requestTranscription(
  profile: AiProfile,
  audio: Uint8Array,
  mime: string,
  signal: AbortSignal
): Promise<string> {
  if (profile.format !== 'openai' && profile.format !== 'custom') {
    throw new AiRequestError('当前接口格式不支持语音识别，请改用 OpenAI 兼容接口，或仅使用文字聊天')
  }
  const base = trimBase(profile.baseUrl)
  const url = `${base}/audio/transcriptions`
  const form = new FormData()
  const ext = mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : 'webm'
  // 复制成独立的 ArrayBuffer：Uint8Array 的底层可能是 SharedArrayBuffer，
  // Blob 不接受这种 buffer（TS 也会在此报错），拷一份最省心。
  const bytes = new Uint8Array(audio)
  form.append('file', new Blob([bytes.buffer as ArrayBuffer], { type: mime }), `speech.${ext}`)
  form.append('model', profile.model.startsWith('whisper') ? profile.model : 'whisper-1')

  const headers: Record<string, string> = { ...profile.headers }
  if (profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`
  const timeout = timeoutSignal(signal, STT_TIMEOUT_MS)
  try {
    const res = await net.fetch(url, {
      method: 'POST',
      headers,
      body: form,
      signal: timeout.signal
    })
    const json = (await readJson(res, '语音识别')) as { text?: string }
    return (json.text ?? '').trim()
  } finally {
    timeout.dispose()
  }
}
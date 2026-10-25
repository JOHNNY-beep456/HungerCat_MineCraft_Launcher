/**
 * AI 助手主进程服务：对话编排 + 工具授权 + 报错分析 + 语音转写。
 *
 * 这里是「一个助手」的全部状态所在：
 *   · 对话历史（按设置里的 `aiHistoryTurns` 截断，避免上下文无限膨胀）；
 *   · 正在等待用户裁决的工具调用（`ai:toolRequest` ↔ `ai:toolDecision`）；
 *   · 当前请求的取消信号（用户可以随时点「停止」）；
 *   · 浮层状态（idle / thinking / speaking / listening），供游戏内 HUD 显示。
 *
 * 与界面之间只走两条路：IPC 返回值（同步结果）和广播事件（工具确认、浮层状态）。
 * 渲染层因此可以完全无状态地「问一句、看一眼」。
 */
import { app } from 'electron'
import type {
  AiApiFormat,
  AiChatMessage,
  AiChatResult,
  AiErrorAnalysis,
  AiHudState,
  AiToolPolicy,
  AiToolRequest,
  AiToolSpec,
  LauncherSettings
} from '@shared/types'
import { settings } from '../store'
import { getAiKey } from '../secret'
import { getLogBuffer } from '../logger'
import { AI_TOOLS, AI_TOOL_MAP, executeAiTool } from './tools'
import {
  AiRequestError,
  parseHeaders,
  requestChat,
  requestTranscription,
  type AiProfile,
  type AiToolCall
} from './client'
import type { IpcContext } from '../handlers/context'

/** 一轮对话最多允许几次「模型 → 工具 → 模型」往返，防止模型在工具间打转。 */
const MAX_TOOL_ROUNDS = 4

/** 等待用户点「允许 / 拒绝」的最长时间；超时按拒绝处理。 */
const TOOL_CONFIRM_TIMEOUT_MS = 180_000

/** 浮层推送节流：模型思考期间状态不变，不必每毫秒推一次。 */
interface PendingDecision {
  resolve: (approved: boolean) => void
  timer: NodeJS.Timeout
}

export interface AiServiceDeps {
  ctx: IpcContext
  /** 广播给所有渲染层（主窗口 + 浮层 + 悬浮球）。 */
  broadcast: (channel: string, payload: unknown) => void
}

export interface AiService {
  /** 一轮对话。 */
  chat(text: string, context: string | undefined): Promise<AiChatResult>
  /** 取消进行中的对话（含等待确认）。 */
  cancel(): void
  /** 用户对工具调用的裁决。 */
  decideTool(id: string, approved: boolean): void
  /** 报错自动分析。 */
  analyzeError(text: string): Promise<AiErrorAnalysis>
  /** 连通性测试。 */
  test(): Promise<{ ok: boolean; message: string }>
  /** 语音转写。 */
  transcribe(audio: Uint8Array, mime: string): Promise<{ ok: boolean; text: string; error?: string }>
  /** 清空历史。 */
  reset(): void
  /** 浮层状态变化（渲染层同步过来）。 */
  setHudStatus(status: AiHudState['status']): void
  /** 进入 / 退出游戏，决定浮层是否显示。 */
  setHudActive(active: boolean): void
  /** 当前浮层快照（新建浮层窗口时补推）。 */
  hudState(): AiHudState
  /** 工具清单（设置页权限表用）。 */
  tools(): AiToolSpec[]
}

/** 把设置里的格式收敛成可用的字面量。 */
function normalizeFormat(v: unknown): AiApiFormat {
  return v === 'anthropic' || v === 'gemini' || v === 'ollama' || v === 'custom' ? v : 'openai'
}

/** 各格式的默认地址：用户清空地址后给一个能用的起点。 */
export function defaultBaseUrl(format: AiApiFormat): string {
  switch (format) {
    case 'anthropic':
      return 'https://api.anthropic.com/v1'
    case 'gemini':
      return 'https://generativelanguage.googleapis.com/v1beta'
    case 'ollama':
      return 'http://127.0.0.1:11434'
    default:
      return 'https://api.openai.com/v1'
  }
}

/** 从当前设置 + 安全存储拼出连接参数。 */
export function currentProfile(s: LauncherSettings): AiProfile {
  const format = normalizeFormat(s.aiFormat)
  return {
    format,
    baseUrl: (s.aiBaseUrl || defaultBaseUrl(format)).trim(),
    model: (s.aiModel || '').trim(),
    apiKey: getAiKey(),
    headers: parseHeaders(s.aiHeaders || '')
  }
}

/** 判断一个工具「现在该怎么处理」：用户策略优先，缺省按风险等级推导。 */
export function policyFor(s: LauncherSettings, name: string): AiToolPolicy {
  const explicit = s.aiToolPolicy?.[name]
  if (explicit === 'allow' || explicit === 'ask' || explicit === 'deny') return explicit
  // 需求约定：危险操作必须先问用户；只读查询直接放行。
  return AI_TOOL_MAP.get(name)?.risk === 'dangerous' ? 'ask' : 'allow'
}

/** 给模型看的系统提示词：角色 + 当前现场 + 工具使用纪律。 */
function systemPrompt(s: LauncherSettings, context: string | undefined): string {
  const toolsOn = s.aiToolsEnabled
  const lines = [
    '你是「饥饿猫我的世界启动器」（HungerCat MineCraft Launcher）内置的 AI 助手。',
    '回答用简体中文，简洁、可执行；涉及操作步骤时给编号列表。',
    '你了解 Minecraft 启动器、Forge/Fabric 模组、Java 运行时、崩溃日志分析等知识。',
    '',
    toolsOn
      ? '你可以调用启动器工具来查询与操作用户的实例。规则：'
      : '本轮没有可用的启动器工具（用户未开启「允许 AI 操作启动器」），只能给建议，不要假装已经执行。',
    toolsOn ? '1) 需要事实（有哪些实例、模组、账号、是否在运行）时先调用查询工具，不要凭印象回答。' : '',
    toolsOn ? '2) 删除、重命名等破坏性操作必须先向用户复述「要删什么」，用户同意后系统才会真正执行，不要先斩后奏。' : '',
    toolsOn ? '3) 工具返回失败时如实说明失败原因，不要编造成功。' : '',
    '',
    `启动器信息：版本 ${app.getVersion()}，平台 ${process.platform}，当前游戏目录 ${s.gameDirAbs || s.gameDir || '(未设置)'}。`
  ]
  if (context && context.trim()) {
    lines.push('', '当前界面现场（由启动器提供，可能不完整）：', context.trim())
  }
  return lines.filter((l) => l !== '').join('\n')
}

/** 创建 AI 服务。 */
export function createAiService(deps: AiServiceDeps): AiService {
  const { ctx, broadcast } = deps

  /** 完整对话历史（含 system 之外的往返）。 */
  let history: AiChatMessage[] = []
  /** 当前请求的取消信号。 */
  let currentAbort: AbortController | null = null
  /** 等待用户裁决的工具调用。 */
  const pending = new Map<string, PendingDecision>()
  /** 浮层状态。 */
  let hud: AiHudState = { enabled: false, opacity: 0.85, status: 'idle', text: '', lastUser: '' }
  /** 是否处于「游戏运行中」（渲染层在启动 / 退出时同步过来）。 */
  let hudActive = false

  const pushHud = (): void => {
    const s = settings.get()
    hud.enabled = hudActive && s.aiEnabled && s.aiHudEnabled
    hud.opacity = typeof s.aiHudOpacity === 'number' ? s.aiHudOpacity : 0.85
    broadcast('ai:hudState', hud)
  }

  /** 历史截断：只保留最近 N 轮（一轮 = user + assistant）。 */
  const trimHistory = (): void => {
    const turns = Math.max(1, Math.min(50, Math.round(settings.get().aiHistoryTurns) || 10))
    const max = turns * 2
    if (history.length > max) history = history.slice(history.length - max)
  }

  /** 统一的前置校验：开关、地址、模型。 */
  function assertReady(): AiProfile {
    const s = settings.get()
    if (!s.aiEnabled) throw new AiRequestError('AI 助手未开启，请到「设置 - AI 助手」打开总开关')
    const profile = currentProfile(s)
    if (!profile.baseUrl) throw new AiRequestError('未配置 API 地址')
    if (!profile.model) throw new AiRequestError('未配置模型 ID')
    // Ollama 与自建无鉴权网关允许空密钥，其余格式提醒一下更友好。
    if (!profile.apiKey && profile.format !== 'ollama' && profile.format !== 'custom') {
      throw new AiRequestError('未配置 API 密钥（本地 Ollama 可忽略此项）')
    }
    return profile
  }

  /** 发起一次工具确认：广播给主窗口，等用户点。 */
  function askUser(req: AiToolRequest, signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const done = (approved: boolean): void => {
        const item = pending.get(req.id)
        if (!item) return
        clearTimeout(item.timer)
        pending.delete(req.id)
        resolve(approved)
      }
      const timer = setTimeout(() => done(false), TOOL_CONFIRM_TIMEOUT_MS)
      pending.set(req.id, { resolve: done, timer })
      signal.addEventListener(
        'abort',
        () => {
          pending.get(req.id)?.resolve(false)
        },
        { once: true }
      )
      broadcast('ai:toolRequest', req)
    })
  }

  /** 把一次工具调用按策略处理，返回要回灌给模型的文本。 */
  async function handleToolCall(call: AiToolCall, profile: AiProfile, signal: AbortSignal): Promise<string> {
    const spec = AI_TOOL_MAP.get(call.name)
    if (!spec) return `工具 ${call.name} 不存在，已忽略。`
    const s = settings.get()
    if (!s.aiToolsEnabled) return `用户未开启「允许 AI 操作启动器」，工具 ${call.name} 未执行。`

    const policy = policyFor(s, call.name)
    if (policy === 'deny') return `用户策略禁止执行 ${call.name}，未执行。`

    if (policy === 'ask') {
      hud.status = 'thinking'
      const approved = await askUser(
        {
          id: `${call.id}-${Date.now()}`,
          name: call.name,
          title: spec.title,
          risk: spec.risk,
          args: call.args,
          summary: summarizeCall(call.name, call.args)
        },
        signal
      )
      if (!approved) return `用户拒绝了 ${call.name}，未执行。请询问用户接下来怎么做。`
    }

    const result = await executeAiTool(ctx, call.name, call.args)
    return result.ok ? `工具 ${call.name} 执行成功：\n${result.text}` : `工具 ${call.name} 执行失败：${result.text}`
  }

  return {
    tools: () => AI_TOOLS,

    reset(): void {
      history = []
    },

    cancel(): void {
      currentAbort?.abort(new AiRequestError('已取消'))
      currentAbort = null
      // 等待中的确认一并按拒绝收尾，避免界面一直挂着「等待确认」。
      for (const [, item] of pending) item.resolve(false)
      pending.clear()
      hud.status = 'idle'
      pushHud()
    },

    decideTool(id: string, approved: boolean): void {
      pending.get(id)?.resolve(approved)
    },

    setHudStatus(status: AiHudState['status']): void {
      hud.status = status
      pushHud()
    },

    setHudActive(active: boolean): void {
      hudActive = active
      pushHud()
    },

    hudState(): AiHudState {
      const s = settings.get()
      hud.enabled = hudActive && s.aiEnabled && s.aiHudEnabled
      // 旧版本设置文件里可能没有这一项，缺省时给回默认不透明度。
      hud.opacity = typeof s.aiHudOpacity === 'number' ? s.aiHudOpacity : 0.85
      return hud
    },

    async chat(text: string, context: string | undefined): Promise<AiChatResult> {
      const input = text.trim()
      if (!input) return { ok: true, text: '', usedTools: [] }
      let profile: AiProfile
      try {
        profile = assertReady()
      } catch (err) {
        return { ok: false, text: '', error: err instanceof Error ? err.message : String(err), usedTools: [] }
      }

      const abort = new AbortController()
      currentAbort = abort
      const usedTools: string[] = []
      hud.lastUser = input
      hud.status = 'thinking'
      pushHud()

      try {
        const s = settings.get()
        const messages: AiChatMessage[] = [
          { role: 'system', content: systemPrompt(s, context) },
          ...history,
          { role: 'user', content: input }
        ]
        const tools = s.aiToolsEnabled ? AI_TOOLS : []

        for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
          const turn = await requestChat(profile, messages, tools, abort.signal)
          if (turn.toolCalls.length === 0) {
            history.push({ role: 'user', content: input }, { role: 'assistant', content: turn.text })
            trimHistory()
            hud.text = turn.text
            hud.status = 'idle'
            pushHud()
            return { ok: true, text: turn.text, usedTools }
          }

          // 有工具调用：先把模型这轮的话（可能为空）与调用意图记进消息流，
          // 再逐个执行，把结果作为 user 消息回灌——这是各家工具调用最通用的写法。
          const intent = turn.text ? `${turn.text}\n` : ''
          messages.push({
            role: 'assistant',
            content: `${intent}[调用工具] ${turn.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(', ')}`
          })
          for (const call of turn.toolCalls) {
            usedTools.push(call.name)
            const outcome = await handleToolCall(call, profile, abort.signal)
            messages.push({ role: 'user', content: `【工具结果】${outcome}` })
          }
        }

        // 往返次数用尽：把情况如实告诉用户，而不是假装完成。
        const fallback = '（这次操作步骤太多，我停在了中间。可以给我更具体的指令，或分几步来做。）'
        hud.text = fallback
        hud.status = 'idle'
        pushHud()
        return { ok: true, text: fallback, usedTools }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        hud.status = 'idle'
        pushHud()
        // 用户主动取消不算错误：返回 ok 让界面安静收场。
        if (abort.signal.aborted && message.includes('已取消')) return { ok: true, text: '', usedTools }
        return { ok: false, text: '', error: message, usedTools }
      } finally {
        if (currentAbort === abort) currentAbort = null
      }
    },

    async analyzeError(text: string): Promise<AiErrorAnalysis> {
      const s = settings.get()
      if (!s.aiEnabled) return { ok: false, text: '', error: 'AI 助手未开启' }
      let profile: AiProfile
      try {
        // 请求头写错时 parseHeaders 会抛错，这里统一收敛成可读结果，
        // 免得上层拿到一个 rejected promise。
        profile = currentProfile(s)
      } catch (err) {
        return { ok: false, text: '', error: err instanceof Error ? err.message : String(err) }
      }
      if (!profile.model) return { ok: false, text: '', error: '未配置模型 ID' }

      // 自动分析用**自己的** controller，不去占用 currentAbort：
      // 否则玩家一边聊天一边触发报错分析时，会把聊天请求的取消句柄顶掉，
      // 之后点「取消」就再也停不下那次对话了。
      const abort = new AbortController()
      // 带上最近日志：崩溃 / 下载失败的真正线索通常就在里面。
      const logs = getLogBuffer()
        .slice(-60)
        .map((l) => `[${l.level}] ${l.message}`)
        .join('\n')
      const prompt = [
        '下面是用户在使用启动器时遇到的错误。请：',
        '1) 先用一两句话说明最可能的原因（区分“看得出来的”和“猜测”）；',
        '2) 给出 2–4 条按优先级排序的处理步骤，尽量点明设置项 / 文件位置；',
        '3) 若信息不足，明确说还需要什么信息（例如完整崩溃报告的最后 30 行）。',
        '不要输出与本问题无关的客套话。',
        '',
        `启动器版本：${app.getVersion()}，平台：${process.platform}，游戏目录：${s.gameDirAbs || s.gameDir || '(未设置)'}`,
        '',
        '【错误】',
        text.slice(0, 6000),
        logs ? `\n【最近日志】\n${logs.slice(0, 6000)}` : ''
      ].join('\n')

      try {
        const turn = await requestChat(profile, [{ role: 'user', content: prompt }], [], abort.signal)
        return { ok: true, text: turn.text }
      } catch (err) {
        return { ok: false, text: '', error: err instanceof Error ? err.message : String(err) }
      }
    },

    async test(): Promise<{ ok: boolean; message: string }> {
      const s = settings.get()
      let profile: AiProfile
      try {
        profile = currentProfile(s)
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
      if (!profile.model) return { ok: false, message: '请先填写模型 ID' }
      if (!profile.baseUrl) return { ok: false, message: '请先填写 API 地址' }
      const abort = new AbortController()
      try {
        const turn = await requestChat(
          profile,
          [{ role: 'user', content: '连通性测试：只回复 OK 两个字母。' }],
          [],
          abort.signal
        )
        const short = turn.text.slice(0, 40).replace(/\s+/g, ' ')
        return { ok: true, message: `连接正常，模型返回：${short || '(空)'}` }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    },

    async transcribe(audio: Uint8Array, mime: string): Promise<{ ok: boolean; text: string; error?: string }> {
      const s = settings.get()
      if (!s.aiEnabled) return { ok: false, text: '', error: 'AI 助手未开启' }
      let profile: AiProfile
      try {
        profile = currentProfile(s)
      } catch (err) {
        return { ok: false, text: '', error: err instanceof Error ? err.message : String(err) }
      }
      // 语音模型单独配置（默认 whisper-1），与聊天模型解耦。
      const sttProfile: AiProfile = { ...profile, model: (s.aiVoiceModel || 'whisper-1').trim() }
      const abort = new AbortController()
      try {
        const text = await requestTranscription(sttProfile, audio, mime, abort.signal)
        return { ok: true, text }
      } catch (err) {
        return { ok: false, text: '', error: err instanceof Error ? err.message : String(err) }
      }
    }
  }
}

/** 给确认框写一句人话，说明这次工具调用会动什么。 */
function summarizeCall(name: string, args: Record<string, unknown>): string {
  const v = (k: string): string => (typeof args[k] === 'string' ? String(args[k]) : '')
  switch (name) {
    case 'launcher_delete_version':
      return `将彻底删除实例「${v('versionId')}」，包括它的版本目录与（隔离时的）存档、模组。此操作不可恢复。`
    case 'launcher_delete_path':
      return `将删除文件 / 文件夹：${v('path')}。此操作不可恢复。`
    case 'launcher_rename_version':
      return `将把实例「${v('versionId')}」重命名为「${v('newName')}」。`
    default:
      return `${AI_TOOL_MAP.get(name)?.title ?? name}：${JSON.stringify(args)}`
  }
}
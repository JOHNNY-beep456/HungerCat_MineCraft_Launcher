/**
 * 「AI 助手」设置板块。
 *
 * 整块手工绘制（而不是走 `AutoSection` 的注册表渲染），因为这里的每一行都彼此联动：
 *   · 换「接口格式」要同时改默认地址、密钥是否必填、地址后面的路径提示；
 *   · 密钥不是普通输入框——它经主进程**先真发一次请求验通、再加密落盘**，界面只显示
 *     「已设置 / 未设置」，永远拿不到明文（与「翻译 KEY」同一套存储）；
 *   · 「工具权限」是一张随工具清单变化的表，开关一关整张表要跟着收起。
 * 把这些塞进逐行注册的 `control: 'custom'` 会让读者在注册表和组件之间来回跳，
 * 集中在一个文件里反而更短、更好改。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AiApiFormat, AiToolPolicy, AiToolSpec, LauncherSettings } from '@shared/types'
import { useApp } from '../../store'
import { Button, Select, Switch } from '../../components/ui'
import { Row, Section } from './parts'

/** 各格式的默认地址：切换格式时若当前地址还是「上一个格式的默认值」，就顺手换掉。 */
const DEFAULT_BASE: Record<AiApiFormat, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  ollama: 'http://127.0.0.1:11434',
  custom: ''
}

/** 需要密钥的格式（Ollama / 自定义网关常常不需要）。 */
const NEEDS_KEY: Record<AiApiFormat, boolean> = {
  openai: true,
  anthropic: true,
  gemini: true,
  ollama: false,
  custom: false
}

export function AiSection(): JSX.Element {
  const { settings, updateSettings, reloadSettings, t } = useApp()
  const [key, setKey] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyMsg, setKeyMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null)
  const [testBusy, setTestBusy] = useState(false)
  const [testMsg, setTestMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null)
  const [tools, setTools] = useState<AiToolSpec[]>([])
  const [headers, setHeaders] = useState(settings.aiHeaders)
  const [headerErr, setHeaderErr] = useState('')
  /**
   * 地址与模型 ID 走「本地编辑 + 失焦落盘」。
   *
   * 之前是 onChange 直接 updateSettings：每敲一个字符就写一次 settings.json，
   * 输入长地址时既卡又在无谓地刷盘。请求头早就这么做了，这两项保持一致。
   */
  const [baseUrl, setBaseUrl] = useState(settings.aiBaseUrl)
  const [model, setModel] = useState(settings.aiModel)

  const enabled = settings.aiEnabled
  const format = settings.aiFormat as AiApiFormat

  /** 工具清单：只拉一次（工具是编译期固定的）。 */
  useEffect(() => {
    void window.api.ai.tools().then(setTools).catch(() => setTools([]))
  }, [])

  /** 请求头是文本域，本地编辑、失焦时落盘（避免每敲一个字符写一次设置）。 */
  useEffect(() => setHeaders(settings.aiHeaders), [settings.aiHeaders])
  // 外部改动（切格式时自动换默认地址）也要反映到输入框。
  useEffect(() => setBaseUrl(settings.aiBaseUrl), [settings.aiBaseUrl])
  useEffect(() => setModel(settings.aiModel), [settings.aiModel])

  /**
   * 校验请求头，和主进程 parseHeaders 的规则保持一致：
   * 以 `{` 开头按 JSON 对象解析，否则按「一行一个 Key: Value」。
   * 校验放在失焦时做，非法就当场提示，而不是等用户去聊天时才看到一条报错。
   */
  const commitHeaders = useCallback(async (): Promise<void> => {
    const text = headers.trim()
    if (!text) {
      setHeaderErr('')
      await updateSettings({ aiHeaders: '' })
      return
    }
    if (text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setHeaderErr(t('settings.ai.headersNotObject'))
          return
        }
      } catch {
        setHeaderErr(t('settings.ai.headersBadJson'))
        return
      }
    }
    setHeaderErr('')
    await updateSettings({ aiHeaders: headers })
  }, [headers, t, updateSettings])

  /** 切格式：地址若仍是某个格式的默认值，就跟着换成新格式的默认值。 */
  const changeFormat = useCallback(
    async (next: AiApiFormat): Promise<void> => {
      const patch: Partial<LauncherSettings> = { aiFormat: next }
      const isDefault = Object.values(DEFAULT_BASE).includes(settings.aiBaseUrl.trim())
      if (isDefault || !settings.aiBaseUrl.trim()) patch.aiBaseUrl = DEFAULT_BASE[next]
      // 换到不需要密钥的格式时，地址也换成该格式的默认值更省事。
      await updateSettings(patch)
    },
    [settings.aiBaseUrl, updateSettings]
  )

  /** 悬浮球 / 总开关变化后让主进程立刻同步窗口（不必重启）。 */
  const syncBall = useCallback((): void => {
    void window.api.ai.ball.sync()
  }, [])

  const saveKey = useCallback(async (): Promise<void> => {
    const v = key.trim()
    if (!v) {
      setKeyMsg({ text: t('settings.ai.keyHint'), kind: 'err' })
      return
    }
    setKeyBusy(true)
    setKeyMsg(null)
    try {
      const r = await window.api.ai.setKey(v)
      if (r.ok) {
        setKey('')
        await reloadSettings()
      }
      setKeyMsg({ text: r.message, kind: r.ok ? 'ok' : 'err' })
    } catch (err) {
      setKeyMsg({ text: err instanceof Error ? err.message : String(err), kind: 'err' })
    } finally {
      setKeyBusy(false)
    }
  }, [key, reloadSettings, t])

  const removeKey = useCallback(async (): Promise<void> => {
    setKeyBusy(true)
    try {
      const r = await window.api.ai.clearKey()
      await reloadSettings()
      setKeyMsg({ text: r.message, kind: 'ok' })
    } finally {
      setKeyBusy(false)
    }
  }, [reloadSettings])

  const runTest = useCallback(async (): Promise<void> => {
    setTestBusy(true)
    setTestMsg(null)
    try {
      const r = await window.api.ai.test()
      setTestMsg({ text: r.message, kind: r.ok ? 'ok' : 'err' })
    } catch (err) {
      setTestMsg({ text: err instanceof Error ? err.message : String(err), kind: 'err' })
    } finally {
      setTestBusy(false)
    }
  }, [])

  /** 设置单个工具的授权策略。 */
  const setPolicy = useCallback(
    async (name: string, policy: AiToolPolicy): Promise<void> => {
      await updateSettings({ aiToolPolicy: { ...settings.aiToolPolicy, [name]: policy } })
    },
    [settings.aiToolPolicy, updateSettings]
  )

  /** 工具当前生效的策略（未显式设置时按风险等级推导，与主进程保持一致）。 */
  const policyOf = useCallback(
    (spec: AiToolSpec): AiToolPolicy => {
      const explicit = settings.aiToolPolicy?.[spec.name]
      if (explicit === 'allow' || explicit === 'ask' || explicit === 'deny') return explicit
      return spec.risk === 'dangerous' ? 'ask' : 'allow'
    },
    [settings.aiToolPolicy]
  )

  const formatOptions = useMemo(
    () => [
      { value: 'openai', label: 'OpenAI 兼容（Chat Completions）' },
      { value: 'anthropic', label: 'Anthropic（Claude Messages）' },
      { value: 'gemini', label: 'Google Gemini' },
      { value: 'ollama', label: 'Ollama（本地）' },
      { value: 'custom', label: '自定义端点（按 OpenAI 请求体）' }
    ],
    []
  )

  return (
    <Section title={t('settings.row.ai')} icon="message">
      <Row label={t('settings.row.aiEnabled')}>
        <Switch
          checked={enabled}
          onChange={(v) => {
            void updateSettings({ aiEnabled: v })
            // 关掉总开关时悬浮球要立刻消失；打开时按子开关决定是否出现。
            window.setTimeout(syncBall, 60)
          }}
        />
      </Row>
      <p className="caption -mt-1">{enabled ? t('settings.ai.onHint') : t('settings.ai.offHint')}</p>

      {enabled && (
        <>
          {/* ---------- 连接 ---------- */}
          <Row label={t('settings.row.aiFormat')}>
            <Select
              value={format}
              onChange={(v) => void changeFormat(v as AiApiFormat)}
              className="w-[300px] max-w-[70%]"
              options={formatOptions}
            />
          </Row>
          <p className="caption -mt-1">{t('settings.ai.formatHint')}</p>

          <Row label={t('settings.row.aiBaseUrl')}>
            <input
              className="input w-[320px] max-w-[70%]"
              value={baseUrl}
              placeholder={DEFAULT_BASE[format]}
              spellCheck={false}
              onChange={(e) => setBaseUrl(e.target.value)}
              onBlur={() => {
                if (baseUrl !== settings.aiBaseUrl) void updateSettings({ aiBaseUrl: baseUrl.trim() })
              }}
            />
          </Row>
          <p className="caption -mt-1">{t('settings.ai.baseUrlHint')}</p>

          <Row label={t('settings.row.aiApiKey')}>
            <div className="flex items-center gap-2">
              <input
                type="password"
                className="input w-56 no-drag"
                value={key}
                placeholder={
                  settings.aiApiKeySet
                    ? t('settings.ai.keySet')
                    : NEEDS_KEY[format]
                      ? 'sk-…'
                      : t('settings.ai.keyUnset')
                }
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setKey(e.target.value)}
              />
              <Button size="sm" disabled={keyBusy || !key.trim()} onClick={() => void saveKey()} className="no-drag">
                {keyBusy ? t('settings.ai.keyTesting') : t('settings.ai.keySave')}
              </Button>
              {settings.aiApiKeySet && (
                <Button size="sm" variant="ghost" disabled={keyBusy} onClick={() => void removeKey()} className="no-drag">
                  {t('settings.ai.keyDelete')}
                </Button>
              )}
            </div>
          </Row>
          <p
            className="caption -mt-1"
            style={{ color: keyMsg?.kind === 'err' ? 'var(--fill-danger)' : undefined }}
          >
            {keyMsg?.text ?? (settings.aiApiKeySet ? t('settings.ai.keySet') : t('settings.ai.keyHint'))}
          </p>

          <Row label={t('settings.row.aiHeaders')}>
            <textarea
              className="input w-[320px] max-w-[70%] py-2"
              rows={2}
              value={headers}
              placeholder='{"X-Api-Version":"2024-01"}'
              spellCheck={false}
              onChange={(e) => setHeaders(e.target.value)}
              onBlur={() => void commitHeaders()}
              style={{ height: 'auto' }}
            />
          </Row>
          <p
            className="caption -mt-1"
            style={{ color: headerErr ? 'var(--fill-danger)' : undefined }}
          >
            {headerErr || t('settings.ai.headersHint')}
          </p>

          <Row label={t('settings.row.aiModel')}>
            <input
              className="input w-[280px] max-w-[65%]"
              value={model}
              placeholder="gpt-4o-mini"
              spellCheck={false}
              onChange={(e) => setModel(e.target.value)}
              onBlur={() => {
                if (model !== settings.aiModel) void updateSettings({ aiModel: model.trim() })
              }}
            />
          </Row>
          <p className="caption -mt-1">{t('settings.ai.modelHint')}</p>

          <Row label={t('settings.ai.test')}>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" disabled={testBusy} onClick={() => void runTest()}>
                {testBusy ? t('settings.ai.testing') : t('settings.ai.test')}
              </Button>
            </div>
          </Row>
          {testMsg && (
            <p className="caption -mt-1" style={{ color: testMsg.kind === 'err' ? 'var(--fill-danger)' : undefined }}>
              {testMsg.text}
            </p>
          )}

          {/* ---------- 行为 ---------- */}
          <Row label={t('settings.row.aiHistoryTurns')}>
            <input
              type="number"
              min={1}
              max={50}
              className="input w-24"
              value={settings.aiHistoryTurns}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10)
                if (Number.isFinite(n)) void updateSettings({ aiHistoryTurns: Math.min(50, Math.max(1, n)) })
              }}
            />
          </Row>
          <p className="caption -mt-1">{t('settings.ai.historyHint')}</p>

          <Row label={t('settings.row.aiAutoAnalyze')}>
            <Switch
              checked={settings.aiAutoAnalyzeErrors}
              onChange={(v) => void updateSettings({ aiAutoAnalyzeErrors: v })}
            />
          </Row>
          <p className="caption -mt-1">{t('settings.ai.autoAnalyzeHint')}</p>

          <Row label={t('settings.row.aiVoice')}>
            <Switch
              checked={settings.aiVoiceEnabled}
              onChange={(v) => void updateSettings({ aiVoiceEnabled: v })}
            />
          </Row>
          <p className="caption -mt-1">{t('settings.ai.voiceHint')}</p>

          {/* ---------- 悬浮球 ---------- */}
          <Row label={t('settings.row.aiBall')}>
            <Switch
              checked={settings.aiBallEnabled}
              onChange={(v) => {
                void updateSettings({ aiBallEnabled: v })
                window.setTimeout(syncBall, 60)
              }}
            />
          </Row>
          <p className="caption -mt-1">{t('settings.ai.ballHint')}</p>

          {/* ---------- 游戏内浮层 ---------- */}
          <Row label={t('settings.row.aiHud')}>
            <Switch checked={settings.aiHudEnabled} onChange={(v) => void updateSettings({ aiHudEnabled: v })} />
          </Row>
          <p className="caption -mt-1">{t('settings.ai.hudHint')}</p>
          {settings.aiHudEnabled && (
            <Row label={t('settings.row.aiHudOpacity')}>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0.2}
                  max={1}
                  step={0.05}
                  value={settings.aiHudOpacity}
                  onChange={(e) => void updateSettings({ aiHudOpacity: Number(e.target.value) })}
                />
                <span className="caption w-10 text-right">{Math.round(settings.aiHudOpacity * 100)}%</span>
              </div>
            </Row>
          )}

          {/* ---------- 工具（MCP） ---------- */}
          <Row label={t('settings.row.aiTools')}>
            <Switch checked={settings.aiToolsEnabled} onChange={(v) => void updateSettings({ aiToolsEnabled: v })} />
          </Row>
          <p className="caption -mt-1">{t('settings.ai.toolsHint')}</p>

          {settings.aiToolsEnabled && (
            <>
              <p className="caption px-1" style={{ fontWeight: 600 }}>
                {t('settings.row.aiToolPolicy')}
              </p>
              <p className="caption px-1 -mt-1">{t('settings.ai.toolPolicyHint')}</p>
              <div className="flex flex-col gap-1.5 px-1">
                {tools.map((spec) => (
                  <div key={spec.name} className="flex items-center gap-3">
                    <span className="flex-1 truncate text-[13px]" title={spec.description}>
                      {spec.title}
                      <span className="caption ml-2">
                        {spec.risk === 'dangerous' ? t('settings.ai.toolDanger') : t('settings.ai.toolSafe')}
                      </span>
                    </span>
                    <Select
                      value={policyOf(spec)}
                      onChange={(v) => void setPolicy(spec.name, v as AiToolPolicy)}
                      className="w-[150px]"
                      options={[
                        { value: 'ask', label: t('settings.ai.policyAsk') },
                        { value: 'allow', label: t('settings.ai.policyAllow') },
                        { value: 'deny', label: t('settings.ai.policyDeny') }
                      ]}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </Section>
  )
}
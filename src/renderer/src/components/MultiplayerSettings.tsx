import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useApp } from '../store'
import { Button, Icon, Segmented, Switch } from './ui'
import { MCTIER_REPO, MCTIER_LICENSE, MCTIER_WEBSITE } from './MultiplayerLicenseGate'

/** 自定义节点条目（内置节点不存进设置）。 */
export interface EasyTierNode {
  name: string
  address: string
}

/** MCTier 内置的备用节点（不可删除），与客户端保持一致。 */
export const BUILTIN_NODES: EasyTierNode[] = [
  { name: 'mp.set.nodeBuiltinUS', address: 'udp://us01.225284.xyz:11010' },
  { name: 'mp.set.nodeBuiltinCN', address: 'tcp://225284.xyz:11010' },
  { name: 'mp.set.nodeBuiltinXiamen', address: 'tcp://easytier.weiai.org.cn:11010' }
]

const BUILTIN_ADDRESSES = BUILTIN_NODES.map((n) => n.address)
const NODE_ADDRESS_RE = /^(tcp|udp|ws|wss|txt):\/\/.+$/

/** 默认私有服务器地址（与 MCTier 客户端一致）。 */
export const DEFAULT_EASYTier = 'udp://us01.225284.xyz:11010'
export const DEFAULT_SIGNALING = 'wss://mctier.pmhs.top/signaling'

type HotkeyKey =
  | 'multiplayerMicHotkey'
  | 'multiplayerGlobalMuteHotkey'
  | 'multiplayerPushToTalkHotkey'
  | 'multiplayerSummonHotkey'

const DEFAULT_HOTKEYS: Record<HotkeyKey, string> = {
  multiplayerMicHotkey: 'Ctrl+M',
  multiplayerGlobalMuteHotkey: 'Ctrl+T',
  multiplayerPushToTalkHotkey: 'F2',
  multiplayerSummonHotkey: 'Ctrl+Alt+M'
}

const HOTKEY_ITEMS: Array<{ key: HotkeyKey; label: string; desc: string }> = [
  { key: 'multiplayerMicHotkey', label: 'mp.set.hotkeyMic', desc: 'mp.set.hotkeyMicDesc' },
  { key: 'multiplayerGlobalMuteHotkey', label: 'mp.set.hotkeyMute', desc: 'mp.set.hotkeyMuteDesc' },
  { key: 'multiplayerPushToTalkHotkey', label: 'mp.set.hotkeyPTT', desc: 'mp.set.hotkeyPTTDesc' },
  { key: 'multiplayerSummonHotkey', label: 'mp.set.hotkeySummon', desc: 'mp.set.hotkeySummonDesc' }
]

const VOICE_OPTIONS = [
  { value: 'off', label: 'mp.set.voiceOff' },
  { value: 'loli', label: 'mp.set.voiceLoli' },
  { value: 'uncle', label: 'mp.set.voiceUncle' },
  { value: 'cute', label: 'mp.set.voiceCute' },
  { value: 'deep', label: 'mp.set.voiceDeep' }
]

const minutesToHHMM = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

/** 联机设置面板：全部设置项移植自 MCTier 的「软件设置」，保存到启动器配置。 */
export function MultiplayerSettings({ onBack }: { onBack: () => void }): JSX.Element {
  const { t, settings, updateSettings, selectedAccount } = useApp()
  const s = settings

  const set = <K extends keyof typeof s>(key: K, value: (typeof s)[K]): void => {
    void updateSettings({ [key]: value } as never)
  }

  /* ---------- 节点管理 ---------- */
  const customNodes = Array.isArray(s.multiplayerCustomNodes) ? s.multiplayerCustomNodes : []
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState<EasyTierNode>({ name: '', address: '' })
  const [nodeError, setNodeError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)

  const allNodes = useMemo(
    () => [...BUILTIN_NODES, ...customNodes.map((n) => ({ name: n.name, address: n.address }))],
    [customNodes]
  )

  const saveNodes = (nodes: EasyTierNode[]): void => {
    set('multiplayerCustomNodes', nodes.filter((n) => !BUILTIN_ADDRESSES.includes(n.address)))
  }

  const commitNode = (): void => {
    const name = draft.name.trim()
    const address = draft.address.trim()
    if (!name) {
      setNodeError(t('mp.set.nodeErrName'))
      return
    }
    if (!NODE_ADDRESS_RE.test(address)) {
      setNodeError(t('mp.set.nodeErrAddress'))
      return
    }
    const duplicated = allNodes.some((n, i) => i !== editing && n.address.trim() === address)
    if (duplicated) {
      setNodeError(t('mp.set.nodeErrDup'))
      return
    }
    const next = [...allNodes.map((n) => ({ name: n.name, address: n.address }))]
    if (editing !== null) {
      if (editing >= next.length) next.push({ name, address })
      else next[editing] = { name, address }
    }
    saveNodes(next)
    setEditing(null)
    setDraft({ name: '', address: '' })
    setNodeError(null)
  }

  /* ---------- 快捷键录制 ---------- */
  const [recording, setRecording] = useState<HotkeyKey | null>(null)
  const [hotkeyError, setHotkeyError] = useState<string | null>(null)

  const hotkeys = useMemo<Record<HotkeyKey, string>>(
    () => ({
      multiplayerMicHotkey: s.multiplayerMicHotkey || '',
      multiplayerGlobalMuteHotkey: s.multiplayerGlobalMuteHotkey || '',
      multiplayerPushToTalkHotkey: s.multiplayerPushToTalkHotkey || '',
      multiplayerSummonHotkey: s.multiplayerSummonHotkey || ''
    }),
    [s.multiplayerMicHotkey, s.multiplayerGlobalMuteHotkey, s.multiplayerPushToTalkHotkey, s.multiplayerSummonHotkey]
  )

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const mods: string[] = []
      if (e.ctrlKey) mods.push('Ctrl')
      if (e.altKey) mods.push('Alt')
      if (e.shiftKey) mods.push('Shift')
      if (e.metaKey) mods.push('Meta')
      const key = e.key
      const isModifier = ['Control', 'Alt', 'Shift', 'Meta'].includes(key)
      if (isModifier) return
      if (key === 'Escape' && mods.length === 0) {
        setRecording(null)
        return
      }
      const normalized = [...mods, key.length === 1 ? key.toUpperCase() : key].join('+')
      const conflict = HOTKEY_ITEMS.find(
        (it) => it.key !== recording && (hotkeys[it.key] || '').toLowerCase() === normalized.toLowerCase()
      )
      if (conflict) {
        setHotkeyError(t('mp.set.hotkeyErrDup', { key: normalized, name: t(conflict.label) }))
        setRecording(null)
        return
      }
      setHotkeyError(null)
      set(recording, normalized)
      setRecording(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, hotkeys, t])

  const resetHotkeys = (): void => {
    setHotkeyError(null)
    void updateSettings(DEFAULT_HOTKEYS as never)
  }

  /* ---------- 工具：端口直连地址 ---------- */
  const [quickIp, setQuickIp] = useState('10.126.126.1')
  const [quickPort, setQuickPort] = useState('25565')
  const [copied, setCopied] = useState(false)
  const quickAddress = `${quickIp.trim()}:${quickPort.trim()}`
  const copyAddress = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(quickAddress)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  /* ---------- 掷骰子 ---------- */
  const [dice, setDice] = useState<number | null>(null)

  const statsHours = (s.multiplayerStatsMinutes / 60).toFixed(1)

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="display">{t('mp.set.title')}</h1>
          <p className="caption mt-1">{t('mp.set.subtitle')}</p>
        </div>
        <Button icon="chevronLeft" onClick={onBack}>
          {t('mp.back')}
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {/* ============ 玩家身份 ============ */}
        <Card icon="user" color="var(--fill-primary)" title={t('mp.set.card.player')} desc={t('mp.set.card.playerDesc')}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('mp.set.playerName')} desc={t('mp.set.playerNameDesc')}>
              <input
                className="mp-input"
                value={s.multiplayerPlayerName}
                maxLength={16}
                placeholder={t('mp.form.playerNamePh')}
                onChange={(e) => set('multiplayerPlayerName', e.target.value)}
              />
            </Field>
            <div className="flex items-end">
              <Button
                icon="refresh"
                onClick={() => set('multiplayerPlayerName', selectedAccount?.name ?? '')}
                disabled={!selectedAccount}
              >
                {t('mp.set.playerNameSync')}
              </Button>
            </div>
          </div>
        </Card>

        {/* ============ 界面主题 ============ */}
        <Card icon="palette" color="var(--fill-success)" title={t('mp.set.card.appearance')} desc={t('mp.set.card.appearanceDesc')}>
          <div className="flex justify-center">
            <Segmented
              value={s.multiplayerTheme}
              onChange={(v) => set('multiplayerTheme', v)}
              options={[
                { value: 'system', label: t('mp.set.theme.system') },
                { value: 'light', label: t('mp.set.theme.light') },
                { value: 'dark', label: t('mp.set.theme.dark') }
              ]}
            />
          </div>
        </Card>

        {/* ============ 应用启动 ============ */}
        <Card icon="play" color="var(--fill-primary)" title={t('mp.set.card.app')} desc={t('mp.set.card.appDesc')}>
          <Toggle label={t('mp.set.autoStartup')} desc={t('mp.set.autoStartupDesc')} checked={false} onChange={() => undefined} disabled />
          <Toggle label={t('mp.set.alwaysOnTop')} desc={t('mp.set.alwaysOnTopDesc')} checked={false} onChange={() => undefined} disabled />
          <Toggle label={t('mp.set.rememberPos')} desc={t('mp.set.rememberPosDesc')} checked={false} onChange={() => undefined} disabled />
          <Toggle label={t('mp.set.closeToTray')} desc={t('mp.set.closeToTrayDesc')} checked={false} onChange={() => undefined} disabled />
          <Toggle label={t('mp.set.startMinimized')} desc={t('mp.set.startMinimizedDesc')} checked={false} onChange={() => undefined} disabled />
          <Toggle label={t('mp.set.gpu')} desc={t('mp.set.gpuDesc')} checked={false} onChange={() => undefined} disabled />
        </Card>

        {/* ============ 自动大厅 ============ */}
        <Card icon="users" color="var(--fill-primary)" title={t('mp.set.card.autoLobby')} desc={t('mp.set.card.autoLobbyDesc')}>
          <Toggle
            label={t('mp.set.autoLobby')}
            desc={t('mp.set.autoLobbyDesc')}
            checked={s.multiplayerAutoLobbyEnabled}
            onChange={(v) => set('multiplayerAutoLobbyEnabled', v)}
          />
          <AnimatePresence initial={false}>
            {s.multiplayerAutoLobbyEnabled && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.28 }}
                style={{ overflow: 'hidden' }}
              >
                <div className="mt-2 space-y-3 pl-1">
                  <Field label={t('mp.set.lobbyName')}>
                    <input
                      className="mp-input"
                      value={s.multiplayerLobbyName}
                      maxLength={32}
                      placeholder={t('mp.form.lobbyNamePh')}
                      onChange={(e) => set('multiplayerLobbyName', e.target.value)}
                    />
                  </Field>
                  <Field label={t('mp.set.lobbyPassword')}>
                    <input
                      className="mp-input"
                      type="password"
                      value={s.multiplayerLobbyPassword}
                      maxLength={32}
                      placeholder={t('mp.form.lobbyPasswordPh')}
                      onChange={(e) => set('multiplayerLobbyPassword', e.target.value)}
                    />
                  </Field>
                  <Toggle
                    label={t('mp.set.useDomain')}
                    checked={s.multiplayerUseDomain}
                    onChange={(v) => set('multiplayerUseDomain', v)}
                  />
                  <p className="caption leading-relaxed">{t('mp.set.autoLobbyNote')}</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </Card>

        {/* ============ 私有服务器 ============ */}
        <Card icon="server" color="var(--fill-primary)" title={t('mp.set.card.private')} desc={t('mp.set.card.privateDesc')}>
          <Toggle
            label={t('mp.set.usePrivate')}
            desc={t('mp.set.usePrivateDesc')}
            checked={s.multiplayerUsePrivateServer}
            onChange={(v) => set('multiplayerUsePrivateServer', v)}
          />
          <AnimatePresence initial={false}>
            {s.multiplayerUsePrivateServer && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.28 }}
                style={{ overflow: 'hidden' }}
              >
                <div className="mt-2 space-y-3 pl-1">
                  <Field label={t('mp.set.easytierServer')}>
                    <input
                      className="mp-input selectable"
                      value={s.multiplayerEasytierServer}
                      placeholder={DEFAULT_EASYTier}
                      onChange={(e) => set('multiplayerEasytierServer', e.target.value)}
                    />
                  </Field>
                  <Field label={t('mp.set.signalingServer')}>
                    <input
                      className="mp-input selectable"
                      value={s.multiplayerSignalingServer}
                      placeholder={DEFAULT_SIGNALING}
                      onChange={(e) => set('multiplayerSignalingServer', e.target.value)}
                    />
                  </Field>
                  <p className="caption">{t('mp.set.privateNote')}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" icon="link" onClick={() => void window.api.shell.openExternal(MCTIER_WEBSITE)}>
                      {t('mp.set.goWebsite')}
                    </Button>
                    <Button
                      size="sm"
                      icon="refresh"
                      onClick={() => {
                        set('multiplayerEasytierServer', DEFAULT_EASYTier)
                        set('multiplayerSignalingServer', DEFAULT_SIGNALING)
                      }}
                    >
                      {t('mp.set.reset')}
                    </Button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </Card>

        {/* ============ 自定义节点 ============ */}
        <Card icon="globe" color="var(--fill-primary)" title={t('mp.set.card.nodes')} desc={t('mp.set.card.nodesDesc')}>
          <div className="space-y-2">
            {allNodes.map((node, index) => {
              const isBuiltin = index < BUILTIN_NODES.length
              const isEditing = editing === index
              return (
                <div key={`${node.address}-${index}`} className="glass-soft rounded-2xl p-3">
                  {isEditing ? (
                    <div className="space-y-2">
                      <input
                        className="mp-input"
                        placeholder={t('mp.set.nodeName')}
                        value={draft.name}
                        maxLength={32}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      />
                      <input
                        className="mp-input selectable"
                        placeholder={t('mp.set.nodeAddress')}
                        value={draft.address}
                        onChange={(e) => setDraft({ ...draft, address: e.target.value })}
                      />
                      {nodeError && (
                        <div className="text-[12px]" style={{ color: 'var(--fill-danger, #e5484d)' }}>
                          {nodeError}
                        </div>
                      )}
                      <div className="flex gap-2">
                        <Button size="sm" variant="primary" icon="check" onClick={commitNode}>
                          {t('mp.set.nodeSave')}
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => {
                            setEditing(null)
                            setNodeError(null)
                          }}
                        >
                          {t('mp.set.nodeCancel')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13.5px] font-medium">
                            {isBuiltin ? t(node.name) : node.name}
                          </span>
                          {isBuiltin && <span className="chip">{t('mp.set.nodeBuiltin')}</span>}
                        </div>
                        <div className="caption selectable truncate">{node.address}</div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {isBuiltin ? (
                          <span className="caption opacity-60">{t('mp.set.nodeBuiltinLocked')}</span>
                        ) : (
                          <>
                            <button
                              className="no-drag opacity-70 transition-opacity hover:opacity-100"
                              title={t('mp.set.nodeEdit')}
                              onClick={() => {
                                setEditing(index)
                                setDraft({ name: node.name, address: node.address })
                                setNodeError(null)
                              }}
                            >
                              <Icon name="settings" size={16} />
                            </button>
                            <button
                              className="no-drag opacity-70 transition-opacity hover:opacity-100"
                              title={t('mp.set.nodeDelete')}
                              onClick={() => setConfirmDelete(index)}
                            >
                              <Icon name="trash" size={16} style={{ color: 'var(--fill-danger)' }} />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}

            {editing === allNodes.length && (
              <div className="glass-soft rounded-2xl p-3">
                <div className="space-y-2">
                  <input
                    className="mp-input"
                    placeholder={t('mp.set.nodeName')}
                    value={draft.name}
                    maxLength={32}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                  <input
                    className="mp-input selectable"
                    placeholder={t('mp.set.nodeAddress')}
                    value={draft.address}
                    onChange={(e) => setDraft({ ...draft, address: e.target.value })}
                  />
                  {nodeError && (
                    <div className="text-[12px]" style={{ color: 'var(--fill-danger, #e5484d)' }}>
                      {nodeError}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Button size="sm" variant="primary" icon="check" onClick={commitNode}>
                      {t('mp.set.nodeSave')}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        setEditing(null)
                        setNodeError(null)
                      }}
                    >
                      {t('mp.set.nodeCancel')}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {editing === null && (
              <Button
                icon="plus"
                onClick={() => {
                  setEditing(allNodes.length)
                  setDraft({ name: '', address: '' })
                  setNodeError(null)
                }}
              >
                {t('mp.set.nodeAdd')}
              </Button>
            )}
          </div>
        </Card>

        {/* ============ 全局快捷键 ============ */}
        <Card icon="keyboard" color="var(--fill-warning, #f0b34a)" title={t('mp.set.card.hotkeys')} desc={t('mp.set.card.hotkeysDesc')}>
          {hotkeyError && (
            <div className="mb-2 text-[12px]" style={{ color: 'var(--fill-danger, #e5484d)' }}>
              {hotkeyError}
            </div>
          )}
          {HOTKEY_ITEMS.map((item) => (
            <Toggle
              key={item.key}
              label={t(item.label)}
              desc={t(item.desc)}
              checked={false}
              onChange={() => undefined}
              disabled
              right={
                <div className="flex items-center gap-2">
                  <button
                    className="mp-hotkey no-drag"
                    onClick={() => setRecording(item.key)}
                    style={{ borderColor: recording === item.key ? 'var(--fill-primary)' : undefined }}
                  >
                    {recording === item.key ? t('mp.set.hotkeyPh') : hotkeys[item.key] || t('mp.set.hotkeyPh')}
                  </button>
                  <button
                    className="no-drag opacity-60 transition-opacity hover:opacity-100"
                    title={t('mp.set.nodeDelete')}
                    onClick={() => set(item.key, '')}
                  >
                    <Icon name="xmark" size={14} />
                  </button>
                </div>
              }
            />
          ))}
          <div className="mt-1">
            <Button size="sm" icon="refresh" onClick={resetHotkeys}>
              {t('mp.set.hotkeyReset')}
            </Button>
          </div>
        </Card>

        {/* ============ 提示音 ============ */}
        <Card icon="play" color="var(--fill-primary)" title={t('mp.set.card.sound')} desc={t('mp.set.card.soundDesc')}>
          <div className="glass-soft rounded-2xl p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[13px] font-medium">{t('mp.set.soundVolume')}</span>
              <span className="caption">{Math.round(s.multiplayerSoundVolume * 100)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={s.multiplayerSoundVolume}
              onChange={(e) => set('multiplayerSoundVolume', Number(e.target.value))}
              className="mp-range no-drag w-full"
            />
          </div>
          <div className="mt-2 space-y-2">
            {(['soundNewMsg', 'soundJoined', 'soundLeft'] as const).map((k) => (
              <div key={k} className="glass-soft flex items-center gap-3 rounded-2xl p-2.5">
                <span className="flex-1 text-[13px] font-medium">{t(`mp.set.${k}`)}</span>
                <span className="chip">{t('mp.set.soundDefault')}</span>
                <Switch checked onChange={() => undefined} disabled />
              </div>
            ))}
          </div>
          <div className="mt-3">
            <Toggle
              label={t('mp.set.dnd')}
              desc={t('mp.set.dndDesc')}
              checked={s.multiplayerDndEnabled}
              onChange={(v) => set('multiplayerDndEnabled', v)}
            />
            <AnimatePresence initial={false}>
              {s.multiplayerDndEnabled && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.25 }}
                  style={{ overflow: 'hidden' }}
                >
                  <div className="mt-2 flex items-center gap-2 pl-1">
                    <input
                      type="time"
                      className="mp-input no-drag"
                      style={{ width: 120 }}
                      value={minutesToHHMM(s.multiplayerDndStart)}
                      onChange={(e) => {
                        const [h, m] = e.target.value.split(':').map(Number)
                        set('multiplayerDndStart', h * 60 + m)
                      }}
                    />
                    <span className="caption">{t('mp.set.dndTo')}</span>
                    <input
                      type="time"
                      className="mp-input no-drag"
                      style={{ width: 120 }}
                      value={minutesToHHMM(s.multiplayerDndEnd)}
                      onChange={(e) => {
                        const [h, m] = e.target.value.split(':').map(Number)
                        set('multiplayerDndEnd', h * 60 + m)
                      }}
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </Card>

        {/* ============ 消息弹幕 ============ */}
        <Card icon="message" color="var(--fill-primary)" title={t('mp.set.card.danmaku')} desc={t('mp.set.card.danmakuDesc')}>
          <Toggle
            label={t('mp.set.danmakuEnabled')}
            desc={t('mp.set.danmakuEnabledDesc')}
            checked={s.multiplayerDanmakuEnabled}
            onChange={(v) => set('multiplayerDanmakuEnabled', v)}
          />
          <AnimatePresence initial={false}>
            {s.multiplayerDanmakuEnabled && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.28 }}
                style={{ overflow: 'hidden' }}
              >
                <div className="mt-2 space-y-3 pl-1">
                  <SliderRow
                    label={t('mp.set.danmakuFontSize')}
                    value={`${s.multiplayerDanmakuFontSize}px`}
                    min={12}
                    max={32}
                    step={1}
                    current={s.multiplayerDanmakuFontSize}
                    onChange={(v) => set('multiplayerDanmakuFontSize', v)}
                  />
                  <SliderRow
                    label={t('mp.set.danmakuSpeed')}
                    value={`${s.multiplayerDanmakuSpeed}s`}
                    min={4}
                    max={20}
                    step={1}
                    current={s.multiplayerDanmakuSpeed}
                    onChange={(v) => set('multiplayerDanmakuSpeed', v)}
                  />
                  <SliderRow
                    label={t('mp.set.danmakuOpacity')}
                    value={`${Math.round(s.multiplayerDanmakuOpacity * 100)}%`}
                    min={0.2}
                    max={1}
                    step={0.05}
                    current={s.multiplayerDanmakuOpacity}
                    onChange={(v) => set('multiplayerDanmakuOpacity', v)}
                  />
                  <SliderRow
                    label={t('mp.set.danmakuTracks')}
                    value={String(s.multiplayerDanmakuTracks)}
                    min={1}
                    max={8}
                    step={1}
                    current={s.multiplayerDanmakuTracks}
                    onChange={(v) => set('multiplayerDanmakuTracks', v)}
                  />
                  <div
                    className="relative overflow-hidden rounded-xl"
                    style={{ background: 'var(--fill-secondary)', height: 46 }}
                  >
                    <span
                      className="absolute whitespace-nowrap"
                      style={{
                        top: 12,
                        color: 'var(--text-primary)',
                        opacity: s.multiplayerDanmakuOpacity,
                        fontSize: s.multiplayerDanmakuFontSize
                      }}
                    >
                      <motion.span
                        style={{ display: 'inline-block' }}
                        initial={{ x: '100%' }}
                        animate={{ x: '-100%' }}
                        transition={{
                          duration: s.multiplayerDanmakuSpeed,
                          repeat: Infinity,
                          ease: 'linear'
                        }}
                      >
                        {t('mp.set.danmakuPreviewMsg')}
                      </motion.span>
                    </span>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </Card>

        {/* ============ 游戏内 HUD ============ */}
        <Card icon="wifi" color="var(--fill-primary)" title={t('mp.set.card.hud')} desc={t('mp.set.card.hudDesc')}>
          <Toggle
            label={t('mp.set.hudEnabled')}
            desc={t('mp.set.hudEnabledDesc')}
            checked={s.multiplayerHudEnabled}
            onChange={(v) => set('multiplayerHudEnabled', v)}
          />
          <AnimatePresence initial={false}>
            {s.multiplayerHudEnabled && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.25 }}
                style={{ overflow: 'hidden' }}
              >
                <div className="mt-2 pl-1">
                  <SliderRow
                    label={t('mp.set.hudOpacity')}
                    value={`${Math.round(s.multiplayerHudOpacity * 100)}%`}
                    min={0.2}
                    max={1}
                    step={0.05}
                    current={s.multiplayerHudOpacity}
                    onChange={(v) => set('multiplayerHudOpacity', v)}
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </Card>

        {/* ============ 变声器 ============ */}
        <Card icon="mic" color="var(--fill-primary)" title={t('mp.set.card.voice')} desc={t('mp.set.card.voiceDesc')}>
          <div className="flex flex-wrap gap-2">
            {VOICE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className="glass-soft no-drag rounded-xl px-3 py-2 text-[13px] transition-transform active:scale-[0.97]"
                style={{
                  borderColor: s.multiplayerVoiceChanger === opt.value ? 'var(--fill-primary)' : undefined,
                  color: s.multiplayerVoiceChanger === opt.value ? 'var(--fill-primary)' : undefined
                }}
                onClick={() => set('multiplayerVoiceChanger', opt.value)}
              >
                {t(opt.label)}
              </button>
            ))}
          </div>
        </Card>

        {/* ============ 联机工具 ============ */}
        <Card icon="link" color="var(--fill-primary)" title={t('mp.set.card.tools')} desc={t('mp.set.card.toolsDesc')}>
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t('mp.set.tools.ip')}>
              <div className="flex items-center gap-2">
                <input
                  className="mp-input selectable"
                  style={{ width: 150 }}
                  value={quickIp}
                  onChange={(e) => setQuickIp(e.target.value)}
                />
                <span className="caption">:</span>
                <input
                  className="mp-input selectable"
                  style={{ width: 90 }}
                  value={quickPort}
                  onChange={(e) => setQuickPort(e.target.value)}
                />
              </div>
            </Field>
            <Button icon="copy" onClick={() => void copyAddress()}>
              {copied ? t('mp.set.tools.copied') : t('mp.set.tools.copy')}
            </Button>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <span className="text-[13px] font-medium">{t('mp.set.tools.dice')}</span>
            <Button size="sm" icon="refresh" onClick={() => setDice(1 + Math.floor(Math.random() * 6))}>
              {t('mp.set.tools.game')}
            </Button>
            {dice !== null && (
              <span className="chip" style={{ fontSize: 16, padding: '2px 12px' }}>
                {dice}
              </span>
            )}
          </div>
        </Card>

        {/* ============ 数据统计 ============ */}
        <Card icon="info" color="var(--fill-success)" title={t('mp.set.card.stats')} desc={t('mp.set.card.statsDesc')}>
          <div className="grid grid-cols-3 gap-3">
            <Stat label={t('mp.set.statsMinutes')} value={`${statsHours} ${t('mp.set.statsUnitHour')}`} />
            <Stat label={t('mp.set.statsJoins')} value={String(s.multiplayerJoinCount)} />
            <Stat label={t('mp.set.statsHosts')} value={String(s.multiplayerHostCount)} />
          </div>
          <div className="mt-3">
            <Button
              size="sm"
              icon="trash"
              variant="danger"
              onClick={() => {
                set('multiplayerStatsMinutes', 0)
                set('multiplayerJoinCount', 0)
                set('multiplayerHostCount', 0)
              }}
            >
              {t('mp.set.statsReset')}
            </Button>
          </div>
        </Card>

        {/* ============ 来源与许可标注 ============ */}
        <Card icon="globe" color="var(--fill-primary)" title={t('mp.source.badge')}>
          <p className="selectable text-[12.5px] leading-relaxed opacity-80">{t('mp.source.line')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" icon="link" onClick={() => void window.api.shell.openExternal(MCTIER_REPO)}>
              {t('mp.openSource')}
            </Button>
            <Button size="sm" icon="link" onClick={() => void window.api.shell.openExternal(MCTIER_LICENSE)}>
              {t('mp.openLicense')}
            </Button>
            <Button
              size="sm"
              icon="refresh"
              variant="danger"
              onClick={() => void updateSettings({ multiplayerLicenseAcceptedAt: 0 })}
            >
              {t('mp.license.revoke')}
            </Button>
          </div>
        </Card>
      </div>

      {/* 删除节点确认 */}
      <AnimatePresence>
        {confirmDelete !== null && (
          <ConfirmDialog
            title={t('mp.set.nodeDelete')}
            body={t('mp.set.nodeDeleteConfirm', { name: allNodes[confirmDelete]?.name ?? '' })}
            confirmLabel={t('mp.set.nodeDelete')}
            cancelLabel={t('mp.set.nodeCancel')}
            onCancel={() => setConfirmDelete(null)}
            onConfirm={() => {
              saveNodes(allNodes.filter((_, i) => i !== confirmDelete))
              setConfirmDelete(null)
            }}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 局部展示组件                                                        */
/* ------------------------------------------------------------------ */

function Card({
  icon,
  color,
  title,
  desc,
  children
}: {
  icon: string
  color?: string
  title: string
  desc?: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className="glass rounded-[24px] p-5">
      <div className="mb-1 flex items-center gap-2.5">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl"
          style={{ background: 'var(--fill-secondary)', color: color ?? 'var(--text-primary)' }}
        >
          <Icon name={icon} size={16} />
        </span>
        <span className="title">{title}</span>
      </div>
      {desc && <p className="caption mb-3 leading-relaxed">{desc}</p>}
      <div className={desc ? '' : 'mt-3'}>{children}</div>
    </section>
  )
}

function Toggle({
  label,
  desc,
  checked,
  onChange,
  disabled,
  right
}: {
  label: string
  desc?: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  right?: ReactNode
}): JSX.Element {
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium">{label}</div>
        {desc && <div className="caption leading-relaxed">{desc}</div>}
      </div>
      <div className="shrink-0">{right ?? <Switch checked={checked} onChange={onChange} disabled={disabled} />}</div>
    </div>
  )
}

function Field({ label, desc, children }: { label: string; desc?: string; children: ReactNode }): JSX.Element {
  return (
    <div>
      <div className="mb-1.5 text-[13px] font-medium">{label}</div>
      {children}
      {desc && <div className="caption mt-1">{desc}</div>}
    </div>
  )
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  current,
  onChange
}: {
  label: string
  value: string
  min: number
  max: number
  step: number
  current: number
  onChange: (v: number) => void
}): JSX.Element {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[13px] font-medium">{label}</span>
        <span className="caption">{value}</span>
      </div>
      <input
        type="range"
        className="mp-range no-drag w-full"
        min={min}
        max={max}
        step={step}
        value={current}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="glass-soft rounded-2xl p-3 text-center">
      <div className="text-[17px] font-semibold">{value}</div>
      <div className="caption mt-0.5">{label}</div>
    </div>
  )
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  onCancel,
  onConfirm
}: {
  title: string
  body: string
  confirmLabel: string
  cancelLabel: string
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  return (
    <motion.div
      className="fixed inset-0 z-[110] flex items-center justify-center p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={onCancel} />
      <motion.div
        className="glass-strong relative z-10 w-full max-w-md rounded-[28px] p-6"
        initial={{ scale: 0.94, opacity: 0, y: 12 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.94, opacity: 0, y: 12 }}
        transition={{ type: 'spring', bounce: 0.18, duration: 0.4 }}
      >
        <div className="mb-2 flex items-center gap-2">
          <Icon name="info" size={18} style={{ color: 'var(--fill-danger)' }} />
          <span className="title">{title}</span>
        </div>
        <p className="caption mt-2 selectable leading-relaxed">{body}</p>
        <div className="mt-5 flex gap-2">
          <Button className="flex-1" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button className="flex-1" variant="danger" icon="check" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  )
}

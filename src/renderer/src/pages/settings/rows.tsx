/**
 * 设置页的**自定义行组件**。
 *
 * 注册表（`@shared/settings`）中 `control: 'custom'` 的设置项，由这里按字段名提供
 * 具体控件。这样「板块的顺序与存在性」仍由注册表决定，只有交互复杂的一行才需要写组件。
 * 组件键与 `LauncherSettings` 字段名一一对应（见文件末尾的 `CUSTOM_ROWS`）。
 */
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { createPortal } from 'react-dom'
import type { JavaRuntime, LauncherSettings } from '@shared/types'
import { useApp } from '../../store'
import { Button, Icon, Segmented, Select, Switch } from '../../components/ui'
import { dataUrlToBlobUrl } from '../../wallpaper'
import { LOCALES } from '../../i18n'
import { Row } from './parts'
import { GithubSkinPreview } from './GithubSkinPreview'

/* ================================================================== */
/* 外观：强调色 / 背景 / 壁纸                                          */
/* ================================================================== */

const ACCENTS = ['#0a84ff', '#30d158', '#ff9f0a', '#ff375f', '#bf5af2', '#ff453a']

/** 背景预设色卡：colors 为深色模式渐变，lightColors 为浅色模式渐变（与 index.css 一一对应）。
 *  首个「午夜」即默认背景（index.css 的 .app-background 基色与之相同）。 */
const BACKGROUNDS: Array<{ key: string; label: string; colors: string[]; lightColors: string[] }> = [
  { key: 'midnight', label: 'settings.bg.midnight', colors: ['#04060f', '#0b1330', '#10101c'], lightColors: ['#eef1fa', '#e8ecf8', '#f2f0fb'] },
  { key: 'sunset', label: 'settings.bg.sunset', colors: ['#2a0a14', '#7a2a1e', '#d4762a'], lightColors: ['#fff4ec', '#ffe9d9', '#ffe2cf'] },
  { key: 'forest', label: 'settings.bg.forest', colors: ['#04120f', '#0a2e24', '#144d3a'], lightColors: ['#eefaf3', '#e4f6ec', '#eef9e8'] },
  { key: 'rose', label: 'settings.bg.rose', colors: ['#2a0a1c', '#6b1740', '#c94d6e'], lightColors: ['#fff0f6', '#ffe6f0', '#fbeafc'] },
  { key: 'mono', label: 'settings.bg.mono', colors: ['#0d0d10', '#1c1c22', '#2a2a30'], lightColors: ['#f4f4f6', '#ededf0', '#e6e6ea'] }
]

/** 语言：选项来自自动发现的语言清单（新增语言目录即自动出现）。 */
function LanguageRow(): JSX.Element {
  const { settings, updateSettings, t } = useApp()
  return (
    <Row label={t('settings.language')}>
      <Segmented
        value={settings.language}
        onChange={(v) => void updateSettings({ language: v })}
        options={LOCALES.map((l) => ({ value: l.value, label: l.label }))}
      />
    </Row>
  )
}

function AccentRow(): JSX.Element {
  const { settings, updateSettings, t } = useApp()
  return (
    <Row label={t('settings.row.accent')}>
      <div className="flex items-center gap-2">
        {ACCENTS.map((c) => (
          <button
            key={c}
            onClick={() => void updateSettings({ accentColor: c })}
            className="h-6 w-6 rounded-full border-2 no-drag"
            style={{ background: c, borderColor: settings.accentColor === c ? 'var(--text-primary)' : 'transparent' }}
          />
        ))}
        <input
          type="color"
          value={settings.accentColor}
          onChange={(e) => void updateSettings({ accentColor: e.target.value })}
          className="h-7 w-9 cursor-pointer rounded border-0 bg-transparent p-0 no-drag"
        />
      </div>
    </Row>
  )
}

function BackgroundRow(): JSX.Element {
  const { settings, updateSettings, theme, t } = useApp()
  return (
    <Row label={t('settings.row.background')}>
      <div className="flex items-center gap-2">
        {BACKGROUNDS.map((b) => (
          <button
            key={b.key}
            title={t(b.label)}
            onClick={() => void updateSettings({ background: b.key })}
            className="h-8 w-8 rounded-xl border-2 no-drag"
            style={{
              background: `linear-gradient(135deg, ${(theme === 'light' ? b.lightColors : b.colors).join(',')})`,
              borderColor: settings.background === b.key ? 'var(--fill-primary)' : 'var(--divider)'
            }}
          />
        ))}
      </div>
    </Row>
  )
}

/** 壁纸：选图 / 清除 / 预览；选图失败时显示原因（否则「点了没反应」会被当成功能不可用）。 */
function WallpaperRow(): JSX.Element {
  const { settings, updateSettings, reloadSettings, t } = useApp()
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState('')
  const [error, setError] = useState<string | null>(null)

  const choose = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.api.settings.pickWallpaper()
      await reloadSettings()
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      // Electron 的 invoke 会给主进程错误套一层 "Error invoking remote method '...'"，剥掉只留原因。
      const msg = raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '')
      setError(t('settings.wallpaper.failed', { msg }))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.api.settings.clearWallpaper()
      await reloadSettings()
    } finally {
      setBusy(false)
    }
  }

  /** 读取当前壁纸并转成 blob 预览地址（data URL 过长会让 <img> 拒绝加载）。 */
  useEffect(() => {
    if (!settings.backgroundImage) {
      setPreview('')
      return
    }
    let alive = true
    let objectUrl = ''
    void window.api.settings.wallpaperData().then(async (dataUrl) => {
      if (!alive) return
      objectUrl = dataUrl ? await dataUrlToBlobUrl(dataUrl) : ''
      if (!alive) {
        if (objectUrl) URL.revokeObjectURL(objectUrl)
        return
      }
      setPreview(objectUrl)
    })
    return () => {
      alive = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [settings.backgroundImage])

  return (
    <>
      <Row label={t('settings.row.wallpaper')}>
        <div className="flex items-center gap-2">
          {preview && (
            <img
              src={preview}
              alt={t('settings.wallpaper.preview')}
              className="h-8 w-12 rounded-lg object-cover"
              style={{ border: '1px solid var(--divider)' }}
            />
          )}
          <Button size="sm" icon="folder" disabled={busy} onClick={() => void choose()}>
            {busy
              ? t('settings.wallpaper.processing')
              : settings.backgroundImage
                ? t('settings.wallpaper.change')
                : t('settings.wallpaper.choose')}
          </Button>
          {settings.backgroundImage && (
            <Button size="sm" variant="ghost" icon="xmark" disabled={busy} onClick={() => void remove()}>
              {t('settings.wallpaper.clear')}
            </Button>
          )}
        </div>
      </Row>
      {error && (
        <div className="glass-soft rounded-xl p-3 text-[13px]" style={{ color: 'var(--fill-danger)' }}>
          {error}
        </div>
      )}
    </>
  )
}

/**
 * 减少动态效果：只反映用户自己的选择。
 *
 * 此前极简模式下会被强制显示为开启并置灰（不可点），但极简模式本身已经在 CSS 里
 * 关掉了模糊/阴影/光斑/光晕与各段动画，不需要再借用这个开关；强制置灰反而让用户
 * 以为设置被篡改、也无法在回到普通模式前调整它。
 */
function ReducedMotionRow(): JSX.Element {
  const { settings, updateSettings, t } = useApp()
  return (
    <Row label={t('settings.row.reducedMotion')}>
      <Switch
        checked={settings.reducedMotion}
        onChange={(v) => void updateSettings({ reducedMotion: v })}
      />
    </Row>
  )
}

/* ================================================================== */
/* 运行模式                                                            */
/* ================================================================== */

/** 运行模式：极简只是「暂时按默认皮肤渲染」，不再清空 experimental —— 设置保留，切回普通自动恢复。 */
function ModeRow(): JSX.Element {
  const { settings, updateSettings, t } = useApp()
  return (
    <>
      <Row label={t('settings.row.mode')}>
        <Segmented
          value={settings.mode}
          onChange={(v) => void updateSettings({ mode: v })}
          options={[
            { value: 'normal', label: t('settings.mode.normal') },
            { value: 'local', label: t('settings.mode.local') },
            { value: 'minimal', label: t('settings.mode.minimal') }
          ]}
        />
      </Row>
    </>
  )
}

/** uapis.cn API KEY：填写后经主进程做连通性测试，通过则加密保存到本机（系统安全存储，不写入设置文件，界面不回显）。
 *  用于正版玩家信息（头像 / 皮肤 / 3D 模型）与提升翻译配额；留空则使用访客额度。 */
export function UapisKeyRow(): JSX.Element {
  const { settings, reloadSettings, t } = useApp()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null)

  const saved = settings.uapisApiKeySet

  const save = async (): Promise<void> => {
    const k = key.trim()
    if (!k) {
      setMsg({ text: t('settings.uapisKey.empty'), kind: 'err' })
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      const result = await window.api.translate.setKey(k)
      if (result.ok) {
        await reloadSettings()
        setKey('')
        setMsg({ text: t('settings.uapisKey.statusSet'), kind: 'ok' })
      } else {
        setMsg({ text: result.message, kind: 'err' })
      }
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : String(err), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      const result = await window.api.translate.clearKey()
      await reloadSettings()
      setMsg({ text: result.message, kind: 'ok' })
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : String(err), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Row label={t('settings.row.uapisKey')}>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={saved ? t('settings.uapisKey.placeholderSet') : t('settings.uapisKey.placeholder')}
            spellCheck={false}
            autoComplete="off"
            className="input w-56 no-drag"
          />
          <Button size="sm" disabled={busy || !key.trim()} onClick={save} className="no-drag">
            {busy ? t('settings.uapisKey.testing') : t('settings.uapisKey.save')}
          </Button>
          {saved && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={remove} className="no-drag">
              {t('settings.uapisKey.delete')}
            </Button>
          )}
        </div>
      </Row>
      <p className="caption -mt-1" style={{ color: msg?.kind === 'err' ? 'var(--fill-danger)' : undefined }}>
        {msg?.text ?? (saved ? t('settings.uapisKey.statusSet') : t('settings.uapisKey.statusUnset'))}
      </p>
    </>
  )
}

/* ================================================================== */
/* 实验性功能                                                          */
/* ================================================================== */

/** 界面皮肤：七套互斥皮肤（极简下禁用）+ Win10 桌面模式提示。 */
function ExperimentalRow(): JSX.Element {
  const { settings, updateSettings, t } = useApp()
  const flatMode = settings.mode === 'minimal'
  const [win10Notice, setWin10Notice] = useState(false)
  return (
    <>
      <Row label={t('settings.row.mica')}>
        <Switch
          checked={settings.experimental === 'mica'}
          disabled={flatMode}
          onChange={(v) => void updateSettings({ experimental: v ? 'mica' : 'off' })}
        />
      </Row>
      <Row label={t('settings.row.mac')}>
        <Switch
          checked={settings.experimental === 'mac'}
          disabled={flatMode}
          onChange={(v) => void updateSettings({ experimental: v ? 'mac' : 'off' })}
        />
      </Row>
      {/* 模糊玻璃：还原优化前的重特效（90px 模糊光斑 + 玻璃磨砂）。
          普通模式默认已扁平化，这个选项专门给想要原观感的人用。 */}
      <Row label={t('settings.row.frosted')}>
        <Switch
          checked={settings.experimental === 'frosted'}
          disabled={flatMode}
          onChange={(v) => void updateSettings({ experimental: v ? 'frosted' : 'off' })}
        />
      </Row>
      <Row label={t('settings.row.material')}>
        <Switch
          checked={settings.experimental === 'material'}
          disabled={flatMode}
          onChange={(v) => void updateSettings({ experimental: v ? 'material' : 'off' })}
        />
      </Row>
      <Row label={t('settings.row.github')}>
        <Switch
          checked={settings.experimental === 'github'}
          disabled={flatMode}
          onChange={(v) => void updateSettings({ experimental: v ? 'github' : 'off' })}
        />
      </Row>
      <Row label={t('settings.row.winui3')}>
        <Switch
          checked={settings.experimental === 'winui3'}
          disabled={flatMode}
          onChange={(v) => void updateSettings({ experimental: v ? 'winui3' : 'off' })}
        />
      </Row>
      <Row label={t('settings.row.winui2')}>
        <Switch
          checked={settings.experimental === 'winui2'}
          disabled={flatMode}
          onChange={(v) => void updateSettings({ experimental: v ? 'winui2' : 'off' })}
        />
      </Row>
      <Row label={t('settings.row.minecraft')}>
        <Switch
          checked={settings.experimental === 'minecraft'}
          disabled={flatMode}
          onChange={(v) => void updateSettings({ experimental: v ? 'minecraft' : 'off' })}
        />
      </Row>
      <Row label={t('settings.row.win10')}>
        <Switch
          checked={settings.experimental === 'win10'}
          disabled={flatMode}
          onChange={(v) => {
            // 开启前先弹提示：该功能 Bug 较多，仅建议尝鲜 / 测试。
            if (v) setWin10Notice(true)
            else void updateSettings({ experimental: 'off' })
          }}
        />
      </Row>
      {/* Material Design 3 的风格类型：只有启用 M3 皮肤时才出现（极简下不生效，隐藏）。 */}
      {!flatMode && settings.experimental === 'material' && (
        <>
          <Row label={t('settings.row.materialStyle')}>
            <Segmented
              value={settings.materialStyle}
              onChange={(v) => void updateSettings({ materialStyle: v })}
              options={[
                { value: 'baseline', label: t('settings.exp.material.baseline') },
                { value: 'you', label: t('settings.exp.material.you') },
                { value: 'expressive', label: t('settings.exp.material.expressive') }
              ]}
            />
          </Row>
        </>
      )}

      {/* GitHub（Primer）的配色子主题：只有启用 GitHub 皮肤时才出现（极简下不生效，隐藏）。
          五套配色共用同一套组件与令牌结构，只有取值不同 —— 与 M3 同一套路。 */}
      {!flatMode && settings.experimental === 'github' && (
        <>
          <Row label={t('settings.row.githubStyle')}>
            <Segmented
              value={settings.githubStyle}
              onChange={(v) => void updateSettings({ githubStyle: v })}
              options={[
                { value: 'system', label: t('settings.exp.github.system') },
                { value: 'light', label: t('settings.exp.github.light') },
                { value: 'dark', label: t('settings.exp.github.dark') },
                { value: 'dimmed', label: t('settings.exp.github.dimmed') },
                { value: 'light-hc', label: t('settings.exp.github.lightHc') },
                { value: 'dark-hc', label: t('settings.exp.github.darkHc') }
              ]}
              scroll
            />
          </Row>
          <GithubSkinPreview />
          <p className="caption -mt-1">{t('settings.exp.github.previewHint')}</p>
        </>
      )}

      {createPortal(
        <AnimatePresence>
          {win10Notice && (
            <motion.div
              className="fixed inset-0 z-[115] flex items-center justify-center p-6"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={() => setWin10Notice(false)} />
              <motion.div
                className="glass-strong relative z-10 w-full max-w-md rounded-[32px] p-7"
                initial={{ scale: 0.92, opacity: 0, y: 24 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.94, opacity: 0, y: 16 }}
                transition={{ type: 'spring', bounce: 0.2, duration: 0.45 }}
              >
                <div className="mb-2 flex items-center gap-2">
                  <Icon name="info" size={20} style={{ color: 'var(--fill-danger)' }} />
                  <span className="title">{t('settings.win10.title')}</span>
                </div>
                <p className="caption mt-3">{t('settings.win10.desc')}</p>
                <div className="mt-6 flex items-center gap-2">
                  <Button className="flex-1" onClick={() => setWin10Notice(false)}>
                    {t('settings.common.cancel')}
                  </Button>
                  <Button
                    variant="primary"
                    className="flex-1"
                    icon="check"
                    onClick={() => {
                      setWin10Notice(false)
                      void updateSettings({ experimental: 'win10' })
                    }}
                  >
                    {t('settings.win10.confirm')}
                  </Button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  )
}

/** 联机板块开关：正在联机时禁用（关开关不会停掉组网进程）。 */
function EnableMultiplayerRow(): JSX.Element {
  const { settings, updateSettings, t } = useApp()
  const [inLobby, setInLobby] = useState(false)

  useEffect(() => {
    let alive = true
    const sync = (): void => {
      void window.api.mp
        .getLobby()
        .then((lobby) => {
          if (alive) setInLobby(lobby !== null)
        })
        .catch(() => {
          /* 联机模块不可用时按「未联机」处理 */
        })
    }
    sync()
    const off = window.api.mp.onLobbyChanged(sync)
    return () => {
      alive = false
      off()
    }
  }, [])

  return (
    <>
      <Row label={t('settings.row.multiplayer')}>
        <Switch
          checked={settings.enableMultiplayer}
          disabled={inLobby}
          onChange={(v) => void updateSettings({ enableMultiplayer: v })}
        />
      </Row>
      <p className="caption -mt-1">
        {inLobby ? t('settings.exp.multiplayer.inLobby') : t('settings.exp.multiplayer.desc')}
      </p>
    </>
  )
}

/* ================================================================== */
/* 游戏                                                                */
/* ================================================================== */

function GameDirRow(): JSX.Element {
  const { settings, updateSettings, t } = useApp()
  return (
    <Row label={t('settings.row.gameDir')}>
      <div className="flex items-center gap-2">
        <span className="caption max-w-[200px] selectable truncate">{settings.gameDir}</span>
        <Button
          size="sm"
          icon="folder"
          onClick={async () => {
            const dir = await window.api.shell.chooseDirectory()
            if (dir) void updateSettings({ gameDir: dir })
          }}
        >
          {t('settings.game.change')}
        </Button>
      </div>
    </Row>
  )
}

/** 主显示器尺寸（逻辑像素）。workWidth/workHeight 为工作区（已排除任务栏）。 */
interface PrimaryDisplay {
  width: number
  height: number
  workWidth: number
  workHeight: number
  scaleFactor: number
}

/** 自定义游戏窗口尺寸的合法范围：与主进程保持一致。 */
const MIN_WINDOW = 320
const MAX_WINDOW = 16384

/** 收敛自定义窗口尺寸：非法 / 越界时回退到给定默认值或边界值。 */
function clampWindowSize(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, Math.round(value)))
}

/**
 * 「游戏窗口尺寸 → 自定义」的预览图：按比例画出屏幕外框与窗口区域。
 * 尺寸超出屏幕时禁用预览并给出警告——此时窗口在真实屏幕上必然会被裁切，画出来只会误导。
 */
function WindowSizePreview({
  display,
  width,
  height,
  t
}: {
  display: PrimaryDisplay
  width: number
  height: number
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element {
  const BOX_W = 232
  const BOX_H = 140
  const exceed = width > display.width || height > display.height
  const scale = Math.min(BOX_W / display.width, BOX_H / display.height)
  const sw = Math.max(1, Math.round(display.width * scale))
  const sh = Math.max(1, Math.round(display.height * scale))
  return (
    <div className="glass-soft flex flex-col items-center gap-2 rounded-2xl px-3 py-3">
      <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center">
        <span className="caption font-medium">{t('settings.game.custom.preview')}</span>
        <span className="caption">
          {t('settings.game.custom.screen', {
            sw: display.width,
            sh: display.height,
            ww: display.workWidth,
            wh: display.workHeight
          })}
        </span>
      </div>
      <div
        className="relative rounded-[10px] border border-dashed"
        style={{ width: sw, height: sh, borderColor: 'var(--divider)', background: 'var(--fill-secondary)' }}
      >
        {exceed ? (
          <div className="absolute inset-0 grid place-items-center px-3 text-center">
            <span className="caption" style={{ color: 'var(--fill-danger)' }}>
              {t('settings.game.custom.locked')}
            </span>
          </div>
        ) : (
          <div
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[6px]"
            style={{
              width: Math.max(2, Math.round(width * scale)),
              height: Math.max(2, Math.round(height * scale)),
              background: 'var(--fill-primary)',
              opacity: 0.5,
              boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.4)'
            }}
          />
        )}
      </div>
      <span className="caption">
        {width} × {height}
      </span>
    </div>
  )
}

/** 游戏窗口尺寸：预设 + 「自定义」时的宽高输入与预览（含超出屏幕警告）。 */
function GameWindowSizeRow(): JSX.Element {
  const { settings, updateSettings, t } = useApp()
  const [display, setDisplay] = useState<PrimaryDisplay | null>(null)
  // 输入框用字符串暂存：避免输入过程中的中间态（空串、「1」）被当成数字写回设置。
  const [winWText, setWinWText] = useState('')
  const [winHText, setWinHText] = useState('')
  // 用户是否正在编辑输入框：编辑期间不用 settings 回填，免得把正在输入的内容冲掉。
  const dirty = useRef(false)

  useEffect(() => {
    void window.api.display
      .primary()
      .then(setDisplay)
      .catch(() => setDisplay(null))
  }, [])
  useEffect(() => {
    if (dirty.current) return
    setWinWText(String(settings.gameWindowWidth))
    setWinHText(String(settings.gameWindowHeight))
  }, [settings.gameWindowWidth, settings.gameWindowHeight])

  const commit = (): void => {
    dirty.current = false
    const w = clampWindowSize(parseInt(winWText, 10), settings.gameWindowWidth)
    const h = clampWindowSize(parseInt(winHText, 10), settings.gameWindowHeight)
    setWinWText(String(w))
    setWinHText(String(h))
    void updateSettings({ gameWindowWidth: w, gameWindowHeight: h })
  }

  // 预览用的实时尺寸：输入非法时回退到已保存的值，避免预览跳动到边界值。
  const previewW = clampWindowSize(parseInt(winWText, 10), settings.gameWindowWidth)
  const previewH = clampWindowSize(parseInt(winHText, 10), settings.gameWindowHeight)
  const previewExceed = !!display && (previewW > display.width || previewH > display.height)

  return (
    <>
      <Row label={t('settings.row.gameWindowSize')}>
        <Segmented
          value={settings.gameWindowSize}
          onChange={(v) => void updateSettings({ gameWindowSize: v })}
          options={[
            { value: '720p', label: '720P' },
            { value: '1080p', label: '1080P' },
            { value: 'maximized', label: t('settings.game.size.maximized') },
            { value: 'fullscreen', label: t('settings.game.size.fullscreen') },
            { value: 'custom', label: t('settings.game.size.custom') }
          ]}
        />
      </Row>
      {settings.mode !== 'minimal' && settings.experimental === 'win10' && (
        <p className="caption -mt-1">{t('settings.game.desktopFullscreenNotice')}</p>
      )}
      {settings.gameWindowSize === 'custom' && (
        <>
          <Row label={`${t('settings.game.custom.width')} / ${t('settings.game.custom.height')}`}>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={MIN_WINDOW}
                max={MAX_WINDOW}
                value={winWText}
                onChange={(e) => {
                  dirty.current = true
                  setWinWText(e.target.value)
                }}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
                className="input w-24"
              />
              <span className="caption">×</span>
              <input
                type="number"
                min={MIN_WINDOW}
                max={MAX_WINDOW}
                value={winHText}
                onChange={(e) => {
                  dirty.current = true
                  setWinHText(e.target.value)
                }}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
                className="input w-24"
              />
              <span className="caption">px</span>
            </div>
          </Row>
          {display && (
            <>
              <WindowSizePreview display={display} width={previewW} height={previewH} t={t} />
              {previewExceed && (
                <p className="caption" style={{ color: 'var(--fill-danger)' }}>
                  {t('settings.game.custom.exceed', {
                    w: previewW,
                    h: previewH,
                    sw: display.width,
                    sh: display.height
                  })}
                </p>
              )}
            </>
          )}
        </>
      )}
    </>
  )
}

/** 调试模式：开关 + 开启后打开日志窗口按钮。 */
function DebugModeRow(): JSX.Element {
  const { settings, updateSettings, t } = useApp()
  return (
    <Row label={t('settings.row.debugMode')}>
      <div className="flex items-center gap-2">
        <Switch checked={settings.debugMode} onChange={(v) => void updateSettings({ debugMode: v })} />
        {settings.debugMode && (
          <Button size="sm" icon="info" onClick={() => void window.api.debug.openWindow()}>
            {t('settings.game.openLogWindow')}
          </Button>
        )}
      </div>
    </Row>
  )
}

/** 调试密钥：填入后可上传诊断日志；采集前需同意收集。 */
function DebugKeyRow(): JSX.Element {
  const { settings, updateSettings, t } = useApp()
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  /** 待确认的调试密钥：需用户同意收集日志后才真正采集 / 上传。 */
  const [consentPending, setConsentPending] = useState<string | null>(null)

  const doUpload = async (key: string): Promise<void> => {
    setBusy(true)
    setResult(null)
    try {
      await updateSettings({ debugKey: key, debugMode: true, feedbackLogConsent: true })
      const res = await window.api.debug.submitLogs(key)
      setResult({
        ok: res.ok,
        message: res.ok ? t('settings.debugKey.ok', { n: res.remaining }) : t('settings.debugKey.fail')
      })
      if (res.ok) setInput('')
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  /** 上传入口：未同意收集时先弹同意框，同意后才开始采集 / 上传。 */
  const submit = (): void => {
    const key = input.trim()
    if (!key) {
      setResult({ ok: false, message: t('settings.debugKey.empty') })
      return
    }
    if (!settings.feedbackLogConsent) {
      setConsentPending(key)
      return
    }
    void doUpload(key)
  }

  const clear = async (): Promise<void> => {
    setBusy(true)
    setResult(null)
    try {
      await updateSettings({ debugKey: '' })
      setInput('')
      setResult({ ok: true, message: t('settings.debugKey.cleared') })
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Row label={t('settings.row.debugKey')}>
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              setResult(null)
            }}
            placeholder={
              settings.debugKey ? t('settings.debugKey.placeholderSet') : t('settings.debugKey.placeholder')
            }
            spellCheck={false}
            autoComplete="off"
            className="input w-56"
          />
          <Button size="sm" icon="check" disabled={busy} onClick={() => submit()}>
            {busy ? t('settings.debugKey.uploading') : t('settings.debugKey.upload')}
          </Button>
          {settings.debugKey && (
            <Button size="sm" variant="ghost" icon="xmark" disabled={busy} onClick={() => void clear()}>
              {t('settings.debugKey.clear')}
            </Button>
          )}
        </div>
      </Row>
      <p className="caption -mt-1">
        {settings.debugKey ? t('settings.debugKey.statusSet') : t('settings.debugKey.statusUnset')}
      </p>
      {settings.feedbackLogConsent && (
        <div className="glass-soft mt-1 flex items-center gap-2 rounded-xl p-3 text-[13px]">
          <Icon name="info" size={15} className="opacity-70" />
          <span className="min-w-0 flex-1 opacity-80">{t('settings.debugKey.consentNotice')}</span>
          <Button
            size="sm"
            variant="ghost"
            icon="xmark"
            onClick={() => void updateSettings({ feedbackLogConsent: false, debugMode: false, debugKey: '' })}
          >
            {t('settings.debugKey.consentDisable')}
          </Button>
        </div>
      )}
      {result && (
        <p
          className="caption -mt-1"
          style={{ color: result.ok ? 'var(--fill-success)' : 'var(--fill-danger)' }}
        >
          {result.message}
        </p>
      )}

      {createPortal(
        <AnimatePresence>
          {consentPending && (
            <motion.div
              className="fixed inset-0 z-[115] flex items-center justify-center p-6"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={() => setConsentPending(null)} />
              <motion.div
                className="glass-strong relative z-10 w-full max-w-md rounded-[32px] p-7"
                initial={{ scale: 0.92, opacity: 0, y: 24 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.94, opacity: 0, y: 16 }}
                transition={{ type: 'spring', bounce: 0.2, duration: 0.45 }}
              >
                <div className="mb-2 flex items-center gap-2">
                  <Icon name="info" size={20} />
                  <span className="title">{t('feedback.collect.title')}</span>
                </div>
                <p className="caption mt-3">{t('feedback.collect.desc')}</p>
                <div className="mt-6 flex items-center gap-2">
                  <Button className="flex-1" onClick={() => setConsentPending(null)}>
                    {t('feedback.collect.decline')}
                  </Button>
                  <Button
                    variant="primary"
                    className="flex-1"
                    icon="check"
                    onClick={() => {
                      const key = consentPending
                      setConsentPending(null)
                      if (key) void doUpload(key)
                    }}
                  >
                    {t('feedback.collect.accept')}
                  </Button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  )
}

/** 已安装模组仅识别本地元数据（不联网查询）；本地模式下强制开启且禁用。 */
function MetadataOnlyRow(): JSX.Element {
  const { settings, updateSettings, t } = useApp()
  return (
    <Row label={t('settings.row.metadataOnly')}>
      <Switch
        checked={settings.mode === 'local' || settings.metadataOnlyMods}
        disabled={settings.mode === 'local'}
        onChange={(v) => void updateSettings({ metadataOnlyMods: v })}
      />
    </Row>
  )
}

/* ================================================================== */
/* Java                                                                */
/* ================================================================== */

/** Java 自动检测开关：关闭前二次确认（关闭后改为手动指定 Java）。 */
function JavaAutoRow(): JSX.Element {
  const { settings, updateSettings, t } = useApp()
  const [notice, setNotice] = useState(false)
  return (
    <>
      <Row label={t('settings.row.javaAutoDetect')}>
        <Switch
          checked={settings.javaAutoDetect}
          onChange={(v) => {
            // 关闭自动检测会改成「使用手动指定的 Java」，先二次确认再落盘；开启则直接生效。
            if (v) void updateSettings({ javaAutoDetect: true })
            else setNotice(true)
          }}
        />
      </Row>
      {settings.javaAutoDetect && <p className="caption -mt-1">{t('settings.java.autoDetectHint')}</p>}

      {createPortal(
        <AnimatePresence>
          {notice && (
            <motion.div
              className="fixed inset-0 z-[115] flex items-center justify-center p-6"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={() => setNotice(false)} />
              <motion.div
                className="glass-strong relative z-10 w-full max-w-md rounded-[32px] p-7"
                initial={{ scale: 0.92, opacity: 0, y: 24 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.94, opacity: 0, y: 16 }}
                transition={{ type: 'spring', bounce: 0.2, duration: 0.45 }}
              >
                <div className="mb-2 flex items-center gap-2">
                  <Icon name="info" size={20} style={{ color: 'var(--fill-danger)' }} />
                  <span className="title">{t('settings.java.manual.title')}</span>
                </div>
                <p className="caption mt-3">{t('settings.java.manual.desc')}</p>
                <div className="mt-6 flex items-center gap-2">
                  <Button className="flex-1" onClick={() => setNotice(false)}>
                    {t('settings.common.cancel')}
                  </Button>
                  <Button
                    variant="primary"
                    className="flex-1"
                    icon="check"
                    onClick={() => {
                      setNotice(false)
                      void updateSettings({ javaAutoDetect: false })
                    }}
                  >
                    {t('settings.java.manual.confirm')}
                  </Button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  )
}

/** 已检测到的 Java：下拉选择 + 手动指定 / 重新检测。 */
function JavaPathRow(): JSX.Element {
  const { settings, updateSettings, t } = useApp()
  const [javas, setJavas] = useState<JavaRuntime[]>([])
  const [detecting, setDetecting] = useState(false)
  const [pickError, setPickError] = useState<string | null>(null)

  const pick = async (): Promise<void> => {
    setPickError(null)
    try {
      const jr = await window.api.java.pick()
      if (!jr) return
      setJavas((prev) => (prev.some((j) => j.path === jr.path) ? prev : [...prev, jr]))
      await updateSettings({ javaPath: jr.path })
    } catch (err) {
      setPickError(err instanceof Error ? err.message : String(err))
    }
  }

  const detect = async (): Promise<void> => {
    setDetecting(true)
    try {
      setJavas(await window.api.java.detect())
    } finally {
      setDetecting(false)
    }
  }

  useEffect(() => {
    void detect()
  }, [])

  return (
    <div className="mt-2">
      <div className="mb-2 flex items-center justify-between">
        <span className="caption">{t('settings.java.detected')}</span>
        <div className="flex items-center gap-2">
          <Button size="sm" icon="folder" onClick={() => void pick()}>
            {t('settings.java.pick')}
          </Button>
          <Button size="sm" icon="refresh" onClick={detect} disabled={detecting}>
            {detecting ? t('settings.java.detecting') : t('settings.java.redetect')}
          </Button>
        </div>
      </div>
      {pickError && (
        <div className="mb-2 text-[12px]" style={{ color: 'var(--fill-danger, #e5484d)' }}>
          {pickError}
        </div>
      )}
      {/* 已检测到的 Java 改为下拉框：选项标题 = 「Java 版本 · 厂商 · 位数」，备注行显示路径。
          自动检测开启 / 检测中 / 尚未检测到时禁用（与原先「列表整体置灰」的行为一致）。 */}
      <Select
        className="w-full"
        value={settings.javaPath ?? ''}
        onChange={(v) => void updateSettings({ javaPath: v, javaAutoDetect: false })}
        disabled={settings.javaAutoDetect || detecting || javas.length === 0}
        placeholder={javas.length === 0 ? t('settings.java.none') : undefined}
        options={javas.map((j) => ({
          value: j.path,
          label: `Java ${j.major} · ${j.vendor ?? t('settings.java.unknown')} · ${
            j.is64Bit ? t('settings.java.arch64') : t('settings.java.arch32')
          }`,
          note: j.path
        }))}
      />
    </div>
  )
}

/* ================================================================== */
/* 注册表：字段名 → 自定义行组件                                        */
/* ================================================================== */

/** 键 = `LauncherSettings` 字段名；注册表中 `control: 'custom'` 的项在此提供组件。 */
export const CUSTOM_ROWS: Partial<Record<keyof LauncherSettings, () => JSX.Element>> = {
  mode: ModeRow,
  language: LanguageRow,
  accentColor: AccentRow,
  background: BackgroundRow,
  backgroundImage: WallpaperRow,
  reducedMotion: ReducedMotionRow,
  experimental: ExperimentalRow,
  enableMultiplayer: EnableMultiplayerRow,
  gameDir: GameDirRow,
  gameWindowSize: GameWindowSizeRow,
  debugMode: DebugModeRow,
  debugKey: DebugKeyRow,
  metadataOnlyMods: MetadataOnlyRow,
  javaAutoDetect: JavaAutoRow,
  javaPath: JavaPathRow
}

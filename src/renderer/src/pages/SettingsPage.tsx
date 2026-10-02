import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type {
  DevModeStatus,
  DownloadProgress,
  JavaRuntime,
  UpdateCheckResult,
  UpdateInfo
} from '@shared/types'
import { useApp } from '../store'
import { Button, Icon, Markdown, ProgressBar, Segmented, Switch } from '../components/ui'
import { dataUrlToBlobUrl } from '../wallpaper'
import { LOCALES, type TFunction } from '../i18n'

const ACCENTS = ['#0a84ff', '#30d158', '#ff9f0a', '#ff375f', '#bf5af2', '#ff453a']

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
 *
 * 尺寸超出屏幕时**禁用预览**（不画窗口区域）并给出警告——因为此时窗口在真实屏幕上
 * 必然会被裁切，画出来只会误导。启动时也会再警告一次（见主进程 launch:start）。
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
  t: TFunction
}): JSX.Element {
  const BOX_W = 232
  const BOX_H = 140
  const exceed = width > display.width || height > display.height
  // 按屏幕尺寸等比缩放，保证各种分辨率下预览框大小一致。
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
      {/* 屏幕外框（虚线示意） */}
      <div
        className="relative rounded-[10px] border border-dashed"
        style={{ width: sw, height: sh, borderColor: 'var(--divider)', background: 'var(--fill-secondary)' }}
      >
        {exceed ? (
          // 超出屏幕：禁用预览，只留警告。
          <div className="absolute inset-0 grid place-items-center px-3 text-center">
            <span className="caption" style={{ color: 'var(--fill-danger)' }}>
              {t('settings.game.custom.locked')}
            </span>
          </div>
        ) : (
          /* 窗口区域：居中摆放，一眼看出占屏比例 */
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

/** 背景预设色卡：colors 为深色模式渐变，lightColors 为浅色模式渐变（与 index.css 一一对应）。
 *  首个「午夜」即默认背景（index.css 的 .app-background 基色与之相同）。 */
const BACKGROUNDS: Array<{ key: string; label: string; colors: string[]; lightColors: string[] }> = [
  { key: 'midnight', label: 'settings.bg.midnight', colors: ['#04060f', '#0b1330', '#10101c'], lightColors: ['#eef1fa', '#e8ecf8', '#f2f0fb'] },
  { key: 'sunset', label: 'settings.bg.sunset', colors: ['#2a0a14', '#7a2a1e', '#d4762a'], lightColors: ['#fff4ec', '#ffe9d9', '#ffe2cf'] },
  { key: 'forest', label: 'settings.bg.forest', colors: ['#04120f', '#0a2e24', '#144d3a'], lightColors: ['#eefaf3', '#e4f6ec', '#eef9e8'] },
  { key: 'rose', label: 'settings.bg.rose', colors: ['#2a0a1c', '#6b1740', '#c94d6e'], lightColors: ['#fff0f6', '#ffe6f0', '#fbeafc'] },
  { key: 'mono', label: 'settings.bg.mono', colors: ['#0d0d10', '#1c1c22', '#2a2a30'], lightColors: ['#f4f4f6', '#ededf0', '#e6e6ea'] }
]

export function SettingsPage(): JSX.Element {
  const { settings, updateSettings, reloadSettings, theme, locale, t } = useApp()
  const [javas, setJavas] = useState<JavaRuntime[]>([])
  const [detecting, setDetecting] = useState(false)
  /** 手动指定 Java 时的识别失败提示。 */
  const [javaPickError, setJavaPickError] = useState<string | null>(null)

  // ── 游戏窗口尺寸（自定义 + 预览）────────────────────────────────────────
  /** 主显示器尺寸，仅用于「自定义」尺寸的预览；取不到时不显示预览。 */
  const [display, setDisplay] = useState<PrimaryDisplay | null>(null)
  // 输入框用字符串暂存：避免输入过程中的中间态（空串、「1」）被当成数字写回设置。
  const [winWText, setWinWText] = useState('')
  const [winHText, setWinHText] = useState('')
  // 用户是否正在编辑输入框：编辑期间不用 settings 回填，免得把正在输入的内容冲掉。
  const winSizeDirty = useRef(false)
  useEffect(() => {
    void window.api.display
      .primary()
      .then(setDisplay)
      .catch(() => setDisplay(null))
  }, [])
  useEffect(() => {
    if (winSizeDirty.current) return
    setWinWText(String(settings.gameWindowWidth))
    setWinHText(String(settings.gameWindowHeight))
  }, [settings.gameWindowWidth, settings.gameWindowHeight])

  /** 提交自定义尺寸：解析 → 收敛到合法范围 → 落盘（失焦或回车时调用）。 */
  const commitWindowSize = (): void => {
    winSizeDirty.current = false
    const w = clampWindowSize(parseInt(winWText, 10), settings.gameWindowWidth)
    const h = clampWindowSize(parseInt(winHText, 10), settings.gameWindowHeight)
    setWinWText(String(w))
    setWinHText(String(h))
    void updateSettings({ gameWindowWidth: w, gameWindowHeight: h })
  }

  // 预览用的实时尺寸：输入非法时回退到已保存的值，避免预览跳动到边界值。
  const previewW = clampWindowSize(parseInt(winWText, 10), settings.gameWindowWidth)
  const previewH = clampWindowSize(parseInt(winHText, 10), settings.gameWindowHeight)
  const previewExceed =
    !!display && (previewW > display.width || previewH > display.height)

  /** 手动指定 Java 可执行文件：选中即由主进程读取版本信息（自动识别 major / 厂商 / 位数），
   *  然后加入列表并记为当前 Java。不改动「自动检测」开关 —— 手动模式下它本就是关闭的，
   *  自动检测模式下则只是补充一个检测不到的 Java 路径，不应因此关掉自动切换。 */
  const pickJava = async (): Promise<void> => {
    setJavaPickError(null)
    try {
      const jr = await window.api.java.pick()
      if (!jr) return
      setJavas((prev) => (prev.some((j) => j.path === jr.path) ? prev : [...prev, jr]))
      await updateSettings({ javaPath: jr.path })
    } catch (err) {
      setJavaPickError(err instanceof Error ? err.message : String(err))
    }
  }
  const [wallpaperBusy, setWallpaperBusy] = useState(false)
  const [wallpaperPreview, setWallpaperPreview] = useState('')
  /** 开启 Win10 桌面模式前的提示弹窗。 */
  const [win10Notice, setWin10Notice] = useState(false)
  /** 开启「联机」板块前的提示弹窗（实验性功能，提示可能有 bug）。 */
  const [multiplayerNotice, setMultiplayerNotice] = useState(false)
  /**
   * 当前是否正在联机（已加入大厅）。
   *
   * 联机中不允许切换「联机板块」开关：开关只控制入口可见性，关掉并不能停掉
   * 已在运行的 EasyTier 组网与信令，界面藏了、进程还在，语义混乱且难排查。
   * 因此这里订阅主进程的大厅状态，联机期间把开关置灰并提示先退出大厅。
   */
  const [inLobby, setInLobby] = useState(false)
  /** 关闭 Java「自动检测」前的二次确认弹窗。 */
  const [javaManualNotice, setJavaManualNotice] = useState(false)

  /** 选图 → 主进程弹框、复制进数据目录、写设置；随后刷新 store 触发壁纸 effect。
   *  取消选择时返回的仍是原设置，刷新一次不会有副作用。 */
  const chooseWallpaper = async (): Promise<void> => {
    setWallpaperBusy(true)
    try {
      await window.api.settings.pickWallpaper()
      await reloadSettings()
    } finally {
      setWallpaperBusy(false)
    }
  }

  /** 清除自定义壁纸：删文件 + 清设置，随后刷新 store 回落到背景预设。 */
  const removeWallpaper = async (): Promise<void> => {
    setWallpaperBusy(true)
    try {
      await window.api.settings.clearWallpaper()
      await reloadSettings()
    } finally {
      setWallpaperBusy(false)
    }
  }

  /** 读取当前壁纸并转成 blob 预览地址（没有则清空）。data URL 过长会让 <img> 拒绝加载。 */
  useEffect(() => {
    if (!settings.backgroundImage) {
      setWallpaperPreview('')
      return
    }
    let alive = true
    /** 本次创建的对象地址：预览更新 / 卸载时释放。 */
    let objectUrl = ''
    void window.api.settings.wallpaperData().then((dataUrl) => {
      if (!alive) return
      objectUrl = dataUrl ? dataUrlToBlobUrl(dataUrl) : ''
      setWallpaperPreview(objectUrl)
    })
    return () => {
      alive = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [settings.backgroundImage])

  const [appVersion, setAppVersion] = useState('')
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null)
  const [updateProgress, setUpdateProgress] = useState<DownloadProgress | null>(null)
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'downloading' | 'done' | 'error' | 'opened'>('idle')
  const [updatePath, setUpdatePath] = useState<string | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [pendingUpdate, setPendingUpdate] = useState<UpdateInfo | null>(null)

  // ── 自动翻译的 uapis.cn API KEY ─────────────────────────────────────────
  // 输入框始终为空：已保存的 KEY 只存在主进程的系统加密存储里，不会回显到界面，
  // 用户需要更换时直接输入新的 KEY 覆盖即可。
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [apiKeyBusy, setApiKeyBusy] = useState(false)
  const [apiKeyResult, setApiKeyResult] = useState<{ ok: boolean; message: string } | null>(null)

  /** 保存 API KEY：测试与加密落盘都在主进程完成，这里只负责展示结论。 */
  const saveApiKey = async (): Promise<void> => {
    const key = apiKeyInput.trim()
    if (!key) {
      setApiKeyResult({ ok: false, message: t('settings.uapisKey.empty') })
      return
    }
    setApiKeyBusy(true)
    setApiKeyResult(null)
    try {
      const res = await window.api.translate.setKey(key)
      setApiKeyResult(res)
      // 成功才清空输入框，失败时保留内容方便用户核对。
      if (res.ok) setApiKeyInput('')
      await reloadSettings()
    } catch (err) {
      setApiKeyResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setApiKeyBusy(false)
    }
  }

  /** 主动删除已保存的 KEY（删除后回到访客额度）。 */
  const clearApiKey = async (): Promise<void> => {
    setApiKeyBusy(true)
    setApiKeyResult(null)
    try {
      const res = await window.api.translate.clearKey()
      setApiKeyResult(res)
      setApiKeyInput('')
      await reloadSettings()
    } catch (err) {
      setApiKeyResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setApiKeyBusy(false)
    }
  }

  // ── 开发模式 ────────────────────────────────────────────────────────────
  const [dev, setDev] = useState<DevModeStatus | null>(null)
  const [devEmail, setDevEmail] = useState('')
  const [devCode, setDevCode] = useState('')
  const [devSending, setDevSending] = useState(false)
  const [devVerifying, setDevVerifying] = useState(false)
  const [devError, setDevError] = useState('')
  const [devNotice, setDevNotice] = useState('')
  const [devCooldown, setDevCooldown] = useState(0)

  // 订阅主进程广播的开发模式状态变化（开关 / 解除 / 到期自动关闭）。
  useEffect(() => {
    void window.api.devMode.status().then(setDev).catch(() => {})
    return window.api.devMode.onChanged(setDev)
  }, [])

  /**
   * 跟踪是否正在联机。
   *
   * 联机状态由主进程持有，且可能在别处变化（如在大厅内退出），因此除了首帧拉取，
   * 还要订阅主进程广播——否则用户在大厅里退出后，设置页的开关会一直保持禁用。
   */
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

  // 发送验证码后的重发冷却倒计时。
  useEffect(() => {
    if (devCooldown <= 0) return
    const t = setInterval(() => setDevCooldown((v) => (v <= 1 ? 0 : v - 1)), 1000)
    return () => clearInterval(t)
  }, [devCooldown])

  /** 发送开发模式验证码到指定邮箱。 */
  const sendDevCode = async (): Promise<void> => {
    const email = devEmail.trim()
    if (!email) {
      setDevError(t('settings.dev.err.emailRequired'))
      return
    }
    setDevSending(true)
    setDevError('')
    setDevNotice('')
    try {
      const r = await window.api.devMode.sendCode(email)
      setDevCooldown(r.cooldown || 60)
      setDevNotice(t('settings.dev.notice.sent', { n: Math.round((r.ttl || 600) / 60) }))
    } catch (err) {
      setDevError(err instanceof Error ? err.message : String(err))
    } finally {
      setDevSending(false)
    }
  }

  /** 校验验证码，成功后获得 1 天授权。 */
  const verifyDevCode = async (): Promise<void> => {
    const email = devEmail.trim()
    const code = devCode.trim()
    if (!email || !code) {
      setDevError(t('settings.dev.err.inputRequired'))
      return
    }
    setDevVerifying(true)
    setDevError('')
    setDevNotice('')
    try {
      await window.api.devMode.verify(email, code)
      setDevCode('')
      setDevNotice(t('settings.dev.notice.verified'))
      setDev(await window.api.devMode.status())
    } catch (err) {
      setDevError(err instanceof Error ? err.message : String(err))
    } finally {
      setDevVerifying(false)
    }
  }

  /** 开关开发模式。 */
  const toggleDev = async (v: boolean): Promise<void> => {
    setDevError('')
    try {
      setDev(await window.api.devMode.setEnabled(v))
    } catch (err) {
      setDevError(err instanceof Error ? err.message : String(err))
    }
  }

  /** 解除授权：服务端作废令牌并清空本地授权。 */
  const revokeDev = async (): Promise<void> => {
    if (!window.confirm(t('settings.dev.confirm.revoke'))) return
    setDevError('')
    setDevNotice('')
    try {
      setDev(await window.api.devMode.revoke())
      setDevNotice(t('settings.dev.notice.revoked'))
    } catch (err) {
      setDevError(err instanceof Error ? err.message : String(err))
    }
  }

  /** 切换主页安全防护档位。 */
  const setDevSecurity = async (mode: 'full' | 'warn' | 'off'): Promise<void> => {
    setDev(await window.api.devMode.setSecurityMode(mode))
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
    void window.api.getVersion().then(setAppVersion).catch(() => setAppVersion(''))
  }, [])

  // 订阅更新下载进度
  useEffect(() => {
    return window.api.update.onProgress((p) => {
      if (p.phase === 'done') {
        setUpdateStatus('done')
        setUpdateProgress(null)
      } else {
        setUpdateStatus('downloading')
        setUpdateProgress(p)
      }
    })
  }, [])

  const doDownload = async (info: UpdateInfo, run: boolean): Promise<void> => {
    setUpdateStatus('downloading')
    setUpdateProgress(null)
    setUpdateError(null)
    try {
      const path = run ? await window.api.update.downloadAndRun(info) : await window.api.update.download(info)
      setUpdatePath(path)
      setUpdateStatus('done')
    } catch (err) {
      setUpdateStatus('error')
      setUpdateError(err instanceof Error ? err.message : String(err))
    }
  }

  /** 判断更新应执行的动作：exe 链接 → 下载并运行；有文件名 → 下载；否则 → 浏览器打开链接。 */
  const updateAction = (info: UpdateInfo): 'downloadAndRun' | 'download' | 'openLink' => {
    if (/\.exe(\?|#|$)/i.test(info.url)) return 'downloadAndRun'
    if (info.filename && info.filename.trim() !== '') return 'download'
    return 'openLink'
  }

  const ACTION_LABEL: Record<ReturnType<typeof updateAction>, string> = {
    downloadAndRun: t('settings.update.action.downloadAndRun'),
    download: t('settings.update.action.download'),
    openLink: t('settings.update.action.openLink')
  }

  /** 关闭更新日志弹窗后，按链接类型执行下载 / 运行 / 打开。 */
  const confirmPending = async (): Promise<void> => {
    const info = pendingUpdate
    if (!info) return
    setPendingUpdate(null)
    const action = updateAction(info)
    if (action === 'openLink') {
      try {
        await window.api.shell.openExternal(info.url)
        setUpdateStatus('opened')
      } catch (err) {
        setUpdateStatus('error')
        setUpdateError(err instanceof Error ? err.message : String(err))
      }
    } else {
      await doDownload(info, action === 'downloadAndRun')
    }
  }

  const checkUpdate = async (): Promise<void> => {
    setUpdateChecking(true)
    setUpdateError(null)
    try {
      const r = await window.api.update.check()
      setUpdateResult(r)
      if (r.hasUpdate && r.latest) {
        // 先展示更新日志让用户确认，再执行下载 / 运行 / 打开
        setPendingUpdate(r.latest)
        setUpdateStatus('idle')
      } else {
        setUpdateStatus('idle')
      }
    } catch (err) {
      setUpdateStatus('error')
      setUpdateError(err instanceof Error ? err.message : String(err))
    } finally {
      setUpdateChecking(false)
    }
  }

  return (
    <div className="flex h-full flex-col gap-5">
      <div>
        <h1 className="display">{t('settings.title')}</h1>
        <p className="caption mt-1">{t('settings.subtitle')}</p>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {/* 模式 */}
        <Section title={t('settings.section.mode')} icon="settings">
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
          <p className="caption -mt-1">
            {settings.mode === 'normal' && t('settings.mode.normal.desc')}
            {settings.mode === 'local' && t('settings.mode.local.desc')}
            {settings.mode === 'minimal' && t('settings.mode.minimal.desc')}
          </p>
        </Section>

        {/* 外观 */}
        <Section title={t('settings.appearance')} icon="palette">
          <Row label={t('settings.language')}>
            <Segmented
              value={settings.language}
              onChange={(v) => void updateSettings({ language: v })}
              options={LOCALES.map((l) => ({ value: l.value, label: l.label }))}
            />
          </Row>
          <p className="caption -mt-1">{t('settings.language.desc')}</p>
          <Row label={t('settings.row.theme')}>
            <Segmented
              value={settings.theme}
              disabled={settings.autoThemeFromWallpaper}
              onChange={(v) => void updateSettings({ theme: v })}
              options={[
                { value: 'light', label: t('settings.theme.light') },
                { value: 'dark', label: t('settings.theme.dark') },
                { value: 'system', label: t('settings.theme.system') }
              ]}
            />
          </Row>
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
          <Row label={t('settings.row.wallpaper')}>
            <div className="flex items-center gap-2">
              {wallpaperPreview && (
                <img
                  src={wallpaperPreview}
                  alt={t('settings.wallpaper.preview')}
                  className="h-8 w-12 rounded-lg object-cover"
                  style={{ border: '1px solid var(--divider)' }}
                />
              )}
              <Button size="sm" icon="folder" disabled={wallpaperBusy} onClick={() => void chooseWallpaper()}>
                {wallpaperBusy
                  ? t('settings.wallpaper.processing')
                  : settings.backgroundImage
                    ? t('settings.wallpaper.change')
                    : t('settings.wallpaper.choose')}
              </Button>
              {settings.backgroundImage && (
                <Button size="sm" variant="ghost" icon="xmark" disabled={wallpaperBusy} onClick={() => void removeWallpaper()}>
                  {t('settings.wallpaper.clear')}
                </Button>
              )}
            </div>
          </Row>
          <Row label={t('settings.row.reducedMotion')}>
            <Switch
              checked={settings.reducedMotion}
              onChange={(v) => void updateSettings({ reducedMotion: v })}
            />
          </Row>
          <Row label={t('settings.row.lowUsage')}>
            <Switch
              checked={settings.lowUsageMode}
              onChange={(v) => void updateSettings({ lowUsageMode: v })}
            />
          </Row>
          <p className="caption -mt-1">{t('settings.lowUsage.desc')}</p>

          {/* 自动翻译（实验性，会联网） */}
          <Row label={t('settings.row.autoTranslate')}>
            <Switch
              checked={settings.autoTranslateResources}
              disabled={settings.mode === 'local' || locale === 'en'}
              onChange={(v) => void updateSettings({ autoTranslateResources: v })}
            />
          </Row>
          <p className="caption -mt-1">
            {locale === 'en'
              ? t('settings.exp.autoTranslate.disabledEn')
              : t('settings.exp.autoTranslate.desc')}
          </p>
          {/* 子选项：仅在「自动翻译」开启后可用；关闭后只翻译简介与正文，保留资源名原文。 */}
          {settings.autoTranslateResources && locale !== 'en' && (
            <>
              <Row label={t('settings.row.translateResourceNames')}>
                <Switch
                  checked={settings.translateResourceNames}
                  onChange={(v) => void updateSettings({ translateResourceNames: v })}
                />
              </Row>
              <Row label={t('settings.row.uapisKey')}>
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    value={apiKeyInput}
                    onChange={(e) => {
                      setApiKeyInput(e.target.value)
                      setApiKeyResult(null)
                    }}
                    placeholder={
                      settings.uapisApiKeySet
                        ? t('settings.uapisKey.placeholderSet')
                        : t('settings.uapisKey.placeholder')
                    }
                    spellCheck={false}
                    autoComplete="off"
                    className="input w-56"
                  />
                  <Button
                    size="sm"
                    icon="check"
                    disabled={apiKeyBusy}
                    onClick={() => void saveApiKey()}
                  >
                    {apiKeyBusy ? t('settings.uapisKey.testing') : t('settings.uapisKey.save')}
                  </Button>
                  {settings.uapisApiKeySet && (
                    <Button size="sm" variant="ghost" icon="xmark" disabled={apiKeyBusy} onClick={() => void clearApiKey()}>
                      {t('settings.uapisKey.delete')}
                    </Button>
                  )}
                </div>
              </Row>
              <p className="caption -mt-1">
                {settings.uapisApiKeySet
                  ? t('settings.uapisKey.statusSet')
                  : t('settings.uapisKey.statusUnset')}
              </p>
              <p className="caption -mt-1">{t('settings.uapisKey.desc')}</p>
              {apiKeyResult && (
                <p
                  className="caption -mt-1"
                  style={{ color: apiKeyResult.ok ? 'var(--fill-success)' : 'var(--fill-danger)' }}
                >
                  {apiKeyResult.message}
                </p>
              )}
            </>
          )}
        </Section>

        {/* 实验性功能（多项互斥） */}
        <Section title={t('settings.section.experimental')} icon="info">
          <Row label={t('settings.row.mica')}>
            <Switch
              checked={settings.experimental === 'mica'}
              onChange={(v) => void updateSettings({ experimental: v ? 'mica' : 'off' })}
            />
          </Row>
          <Row label={t('settings.row.mac')}>
            <Switch
              checked={settings.experimental === 'mac'}
              onChange={(v) => void updateSettings({ experimental: v ? 'mac' : 'off' })}
            />
          </Row>
          <Row label={t('settings.row.win10')}>
            <Switch
              checked={settings.experimental === 'win10'}
              onChange={(v) => {
                // 开启前先弹提示：该功能 Bug 较多，仅建议尝鲜 / 测试。
                if (v) setWin10Notice(true)
                else void updateSettings({ experimental: 'off' })
              }}
            />
          </Row>
          <p className="caption -mt-1">
            {t('settings.exp.mutex')}
            {settings.experimental === 'mica' && t('settings.exp.mica.desc')}
            {settings.experimental === 'mac' && t('settings.exp.mac.desc')}
            {settings.experimental === 'win10' && t('settings.exp.win10.desc')}
          </p>
          <Row label={t('settings.row.autoThemeWallpaper')}>
            <Switch
              checked={settings.autoThemeFromWallpaper}
              onChange={(v) => void updateSettings({ autoThemeFromWallpaper: v })}
            />
          </Row>
          <p className="caption -mt-1">{t('settings.exp.autoTheme.desc')}</p>

          {/* 联机板块：实验性功能，默认隐藏。开启前必须确认「可能有 bug」提示。
              正在联机时禁用切换：关掉开关并不会停掉已在运行的组网进程，
              会变成「界面藏了、进程还在」的混乱状态，因此要求先退出大厅。 */}
          <Row label={t('settings.row.multiplayer')}>
            <Switch
              checked={settings.enableMultiplayer}
              disabled={inLobby}
              onChange={(v) => {
                if (v) setMultiplayerNotice(true)
                else void updateSettings({ enableMultiplayer: false })
              }}
            />
          </Row>
          <p className="caption -mt-1">
            {inLobby ? t('settings.exp.multiplayer.inLobby') : t('settings.exp.multiplayer.desc')}
          </p>
        </Section>

        {/* 开发模式 */}
        <Section title={t('settings.section.devMode')} icon="info">
          {!dev?.granted ? (
            <>
              <p className="caption">
                {t('settings.dev.intro')}
              </p>
              <Row label={t('settings.dev.email')}>
                <input
                  type="email"
                  value={devEmail}
                  onChange={(e) => setDevEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="input w-56"
                />
              </Row>
              <Row label={t('settings.dev.code')}>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={devCode}
                    onChange={(e) => setDevCode(e.target.value.replace(/\D/g, ''))}
                    placeholder={t('settings.dev.code.placeholder')}
                    className="input w-28"
                  />
                  <Button
                    size="sm"
                    icon="mail"
                    disabled={devSending || devCooldown > 0}
                    onClick={() => void sendDevCode()}
                  >
                    {devSending ? t('settings.dev.sending') : devCooldown > 0 ? `${devCooldown}s` : t('settings.dev.sendCode')}
                  </Button>
                </div>
              </Row>
              <div className="flex items-center gap-2">
                <Button variant="primary" icon="check" disabled={devVerifying} onClick={() => void verifyDevCode()}>
                  {devVerifying ? t('settings.dev.verifying') : t('settings.dev.verify')}
                </Button>
              </div>
            </>
          ) : (
            <>
              <Row label={t('settings.dev.status')}>
                <span className="chip">{t('settings.dev.status.granted')} · {dev.emailMasked || '—'}</span>
              </Row>
              <Row label={t('settings.dev.remaining')}>
                <span className="chip">{formatDevRemaining(dev.expiresAt, t)}</span>
              </Row>
              <Row label={t('settings.dev.enabled')}>
                <Switch checked={dev.enabled} onChange={(v) => void toggleDev(v)} />
              </Row>
              <Row label={t('settings.dev.security')}>
                <Segmented
                  value={dev.securityMode}
                  onChange={(v) => void setDevSecurity(v)}
                  options={[
                    { value: 'full', label: t('settings.dev.security.full') },
                    { value: 'warn', label: t('settings.dev.security.warn') },
                    { value: 'off', label: t('settings.dev.security.off') }
                  ]}
                />
              </Row>
              <p className="caption -mt-1">
                {dev.securityMode === 'full' && t('settings.dev.security.full.desc')}
                {dev.securityMode === 'warn' && t('settings.dev.security.warn.desc')}
                {dev.securityMode === 'off' && t('settings.dev.security.off.desc')}
                {!dev.enabled && t('settings.dev.security.disabledNotice')}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" icon="info" onClick={() => void window.api.devMode.openTools()}>
                  {t('settings.dev.openTools')}
                </Button>
                <Button
                  size="sm"
                  icon="terminal"
                  onClick={async () => {
                    const ok = await window.api.devMode.openDevTools()
                    if (!ok) setDevError(t('settings.dev.openDevToolsError'))
                    else setDevError('')
                  }}
                >
                  {t('settings.dev.openDevTools')}
                </Button>
                <Button size="sm" variant="ghost" icon="xmark" onClick={() => void revokeDev()}>
                  {t('settings.dev.revoke')}
                </Button>
              </div>
            </>
          )}
          {devError && (
            <div className="glass-soft rounded-xl p-3 text-[13px]" style={{ color: 'var(--fill-danger)' }}>
              {devError}
            </div>
          )}
          {devNotice && !devError && (
            <div className="glass-soft rounded-xl p-3 text-[13px] opacity-80">{devNotice}</div>
          )}
        </Section>

        {/* 游戏 */}
        <Section title={t('settings.section.game')} icon="cube">
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
          <Row label={t('settings.row.versionIsolation')}>
            <Switch
              checked={settings.versionIsolation}
              onChange={(v) => void updateSettings({ versionIsolation: v })}
            />
          </Row>
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
          {settings.experimental === 'win10' && (
            <p className="caption -mt-1">{t('settings.game.desktopFullscreenNotice')}</p>
          )}
          {/* 自定义尺寸：输入框 + 预览；超出屏幕时禁用预览并警告（启动时也会再警告一次）。 */}
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
                      winSizeDirty.current = true
                      setWinWText(e.target.value)
                    }}
                    onBlur={commitWindowSize}
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
                      winSizeDirty.current = true
                      setWinHText(e.target.value)
                    }}
                    onBlur={commitWindowSize}
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
          <Row label={t('settings.row.closeOnLaunch')}>
            <Switch
              checked={settings.closeOnLaunch}
              onChange={(v) => void updateSettings({ closeOnLaunch: v })}
            />
          </Row>
          <Row label={t('settings.row.debugMode')}>
            <div className="flex items-center gap-2">
              <Switch
                checked={settings.debugMode}
                onChange={(v) => void updateSettings({ debugMode: v })}
              />
              {settings.debugMode && (
                <Button size="sm" icon="info" onClick={() => void window.api.debug.openWindow()}>
                  {t('settings.game.openLogWindow')}
                </Button>
              )}
            </div>
          </Row>
          <Row label={t('settings.row.metadataOnly')}>
            <Switch
              checked={settings.mode === 'local' || settings.metadataOnlyMods}
              disabled={settings.mode === 'local'}
              onChange={(v) => void updateSettings({ metadataOnlyMods: v })}
            />
          </Row>
        </Section>

        {/* Java */}
        <Section title={t('settings.section.java')} icon="settings">
          <Row label={t('settings.row.javaAutoDetect')}>
            <Switch
              checked={settings.javaAutoDetect}
              onChange={(v) => {
                // 关闭自动检测会改成「使用手动指定的 Java」，先二次确认再落盘；开启则直接生效。
                if (v) void updateSettings({ javaAutoDetect: true })
                else setJavaManualNotice(true)
              }}
            />
          </Row>
          {settings.javaAutoDetect && (
            <p className="caption -mt-1">{t('settings.java.autoDetectHint')}</p>
          )}
          <div className="mt-2">
            <div className="mb-2 flex items-center justify-between">
              <span className="caption">{t('settings.java.detected')}</span>
              <div className="flex items-center gap-2">
                <Button size="sm" icon="folder" onClick={() => void pickJava()}>
                  {t('settings.java.pick')}
                </Button>
                <Button size="sm" icon="refresh" onClick={detect} disabled={detecting}>
                  {detecting ? t('settings.java.detecting') : t('settings.java.redetect')}
                </Button>
              </div>
            </div>
            {javaPickError && (
              <div className="mb-2 text-[12px]" style={{ color: 'var(--fill-danger, #e5484d)' }}>
                {javaPickError}
              </div>
            )}
            <div className="space-y-1.5">
              {javas.length === 0 && !detecting && (
                <div className="caption">{t('settings.java.none')}</div>
              )}
              {javas.map((j) => {
                // 自动检测开启时列表只作展示：手动选择被禁用并置灰。
                const disabledJava = settings.javaAutoDetect
                const active = !disabledJava && settings.javaPath === j.path
                return (
                  <button
                    key={j.path}
                    disabled={disabledJava}
                    onClick={() => void updateSettings({ javaPath: j.path, javaAutoDetect: false })}
                    className="glass-soft flex w-full items-center justify-between rounded-xl px-3 py-2 no-drag"
                    style={{
                      borderColor: active ? 'var(--fill-primary)' : undefined,
                      opacity: disabledJava ? 0.5 : 1,
                      cursor: disabledJava ? 'not-allowed' : undefined
                    }}
                  >
                    <div className="flex items-center gap-2">
                      {active && <Icon name="check" size={15} style={{ color: 'var(--fill-primary)' }} />}
                      <div className="text-left">
                        <div className="text-[13px] font-medium">Java {j.major}</div>
                        <div className="caption selectable truncate max-w-[360px]">{j.path}</div>
                      </div>
                    </div>
                    <span className="chip">
                      {j.vendor ?? t('settings.java.unknown')} · {j.is64Bit ? t('settings.java.arch64') : t('settings.java.arch32')}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </Section>

        {/* 下载 */}
        <Section title={t('settings.section.download')} icon="download">
          {/* 两个维度必须分开呈现，否则用户会以为「改了并发数，单文件下载就该变快」：
              并发数管「同时下几个文件」，连接数管「一个文件开几条连接」。 */}
          <Row label={t('settings.row.concurrency')}>
            <input
              type="number"
              min={1}
              max={64}
              value={settings.maxDownloadConcurrency}
              onChange={(e) => {
                const n = clampInt(e.target.value, 1, 64, settings.maxDownloadConcurrency)
                void updateSettings({ maxDownloadConcurrency: n })
              }}
              className="input w-24"
            />
          </Row>
          <Row label={t('settings.row.connections')}>
            <input
              type="number"
              min={1}
              max={256}
              value={settings.downloadConnections}
              onChange={(e) => {
                const n = clampInt(e.target.value, 1, 256, settings.downloadConnections)
                void updateSettings({ downloadConnections: n })
              }}
              className="input w-24"
            />
          </Row>
          <p className="caption px-1">{t('settings.hint.download')}</p>
        </Section>

        {/* 更新 */}
        {settings.mode !== 'local' && (
          <Section title={t('settings.section.update')} icon="refresh">
          <Row label={t('settings.row.currentVersion')}>
            <span className="chip">{appVersion || '…'}</span>
          </Row>
          <Row label={t('settings.row.autoCheckLauncher')}>
            <Switch
              checked={settings.autoCheckLauncherUpdate}
              onChange={(v) => void updateSettings({ autoCheckLauncherUpdate: v })}
            />
          </Row>
          <p className="caption -mt-1">
            {t('settings.update.autoLauncher.desc')}
          </p>
          <Row label={t('settings.row.autoCheckHomepage')}>
            <Switch
              checked={settings.autoCheckHomepageUpdate}
              onChange={(v) => void updateSettings({ autoCheckHomepageUpdate: v })}
            />
          </Row>
          <p className="caption -mt-1">
            {t('settings.update.autoHomepage.desc')}
          </p>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[13px] opacity-80">{t('settings.update.check')}</span>
              <Button size="sm" icon="refresh" onClick={() => void checkUpdate()} disabled={updateChecking || updateStatus === 'downloading'}>
                {updateChecking ? t('settings.update.checking') : updateStatus === 'downloading' ? t('settings.update.downloading') : t('settings.update.check')}
              </Button>
            </div>

            {updateStatus === 'error' && updateError && (
              <div className="glass-soft rounded-xl p-3 text-[13px]" style={{ color: 'var(--fill-danger)' }}>
                {updateError}
              </div>
            )}

            {updateResult && updateStatus === 'idle' && !updateResult.hasUpdate && (
              <div className="glass-soft rounded-xl p-3 text-[13px] opacity-70">
                {t('settings.update.upToDate', { v: updateResult.currentVersion })}
              </div>
            )}

            {updateResult?.latest && (updateStatus === 'downloading' || updateStatus === 'done') && (
              <div className="glass-soft rounded-xl p-3">
                <div className="mb-1 flex items-center justify-between text-[13px]">
                  <span className="font-medium">
                    {updateStatus === 'done'
                      ? t('settings.update.done')
                      : t('settings.update.downloadingVersion', { v: updateResult.latest.version })}
                  </span>
                  {updateProgress && <span className="chip">{updateProgress.percent}%</span>}
                </div>
                {updateStatus === 'downloading' && <ProgressBar percent={updateProgress?.percent ?? 0} />}
                {updateStatus === 'downloading' && updateProgress && updateProgress.totalBytes > 0 && (
                  <div className="caption mt-1.5">
                    {formatBytes(updateProgress.currentBytes)} / {formatBytes(updateProgress.totalBytes)}
                  </div>
                )}
                {updateStatus === 'done' && (
                  <>
                    <div className="mt-2 flex items-center gap-2">
                      <Button size="sm" variant="primary" icon="box" onClick={() => updatePath && void window.api.shell.openPath(updatePath)}>
                        {t('settings.update.install')}
                      </Button>
                    </div>
                    {updatePath && (
                      <div className="caption selectable mt-2 break-all opacity-70">{t('settings.update.savedTo', { path: updatePath })}</div>
                    )}
                  </>
                )}
                {updateResult.latest.notes && (
                  <Markdown
                    text={updateResult.latest.notes}
                    className="caption mt-2 border-t pt-2"
                  />
                )}
              </div>
            )}

            {updateResult?.latest && updateStatus === 'opened' && (
              <div className="glass-soft rounded-xl p-3">
                <div className="mb-1 text-[13px] font-medium">
                  {t('settings.update.opened', { v: updateResult.latest.version })}
                </div>
                <div className="caption selectable break-all opacity-70">{updateResult.latest.url}</div>
                {updateResult.latest.notes && (
                  <Markdown
                    text={updateResult.latest.notes}
                    className="caption mt-2 border-t pt-2"
                  />
                )}
              </div>
            )}
          </div>
        </Section>
        )}
      </div>

      {/* 关闭 Java「自动检测」前的二次确认：关闭后将改为手动指定的 Java */}
      <AnimatePresence>
        {javaManualNotice && (
          <motion.div
            className="fixed inset-0 z-[115] flex items-center justify-center p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div
              className="absolute inset-0"
              style={{ background: 'var(--scrim)' }}
              onClick={() => setJavaManualNotice(false)}
            />
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
                <Button className="flex-1" onClick={() => setJavaManualNotice(false)}>
                  {t('settings.common.cancel')}
                </Button>
                <Button
                  variant="primary"
                  className="flex-1"
                  icon="check"
                  onClick={() => {
                    setJavaManualNotice(false)
                    void updateSettings({ javaAutoDetect: false })
                  }}
                >
                  {t('settings.java.manual.confirm')}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 开启 Win10 桌面模式前的提示：功能稳定性较差，仅建议尝鲜 / 测试 */}
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
      </AnimatePresence>

      {/* 开启「联机」板块前的提示：该模块依赖组网内核与 P2P 信令，可能有 bug */}
      <AnimatePresence>
        {multiplayerNotice && (
          <motion.div
            className="fixed inset-0 z-[115] flex items-center justify-center p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={() => setMultiplayerNotice(false)} />
            <motion.div
              className="glass-strong relative z-10 w-full max-w-md rounded-[32px] p-7"
              initial={{ scale: 0.92, opacity: 0, y: 24 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.94, opacity: 0, y: 16 }}
              transition={{ type: 'spring', bounce: 0.2, duration: 0.45 }}
            >
              <div className="mb-2 flex items-center gap-2">
                <Icon name="info" size={20} style={{ color: 'var(--fill-danger)' }} />
                <span className="title">{t('settings.mpNotice.title')}</span>
              </div>
              <p className="caption mt-3 selectable leading-relaxed">{t('settings.mpNotice.desc')}</p>
              <div className="mt-6 flex items-center gap-2">
                <Button className="flex-1" onClick={() => setMultiplayerNotice(false)}>
                  {t('settings.common.cancel')}
                </Button>
                <Button
                  variant="primary"
                  className="flex-1"
                  icon="check"
                  onClick={() => {
                    setMultiplayerNotice(false)
                    void updateSettings({ enableMultiplayer: true })
                  }}
                >
                  {t('settings.mpNotice.confirm')}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 更新日志确认弹窗：先展示更新内容，确认后再下载 / 运行 / 打开链接 */}
      <AnimatePresence>
        {pendingUpdate && (
          <motion.div
            className="fixed inset-0 z-[115] flex items-center justify-center p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} />
            <motion.div
              className="glass-strong relative z-10 w-full max-w-md rounded-[32px] p-7"
              initial={{ scale: 0.92, opacity: 0, y: 24 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.94, opacity: 0, y: 16 }}
              transition={{ type: 'spring', bounce: 0.2, duration: 0.45 }}
            >
              <div className="mb-2 flex items-center gap-2">
                <Icon name="download" size={20} style={{ color: 'var(--fill-primary)' }} />
                <span className="title">{t('settings.updLog.title', { v: pendingUpdate.version })}</span>
              </div>
              <div className="mb-5 mt-3">
                <div className="caption mb-2">{t('settings.updLog.notes')}</div>
                {/* 更新日志按 Markdown 渲染（标题 / 列表 / 代码块 / 链接等） */}
                <Markdown
                  text={pendingUpdate.notes}
                  fallback={t('settings.updLog.empty')}
                  className="glass-soft max-h-[38vh] overflow-y-auto rounded-2xl p-4 text-[13px] leading-relaxed opacity-80"
                />
              </div>
              <div className="flex items-center gap-2">
                <Button className="flex-1" onClick={() => setPendingUpdate(null)}>
                  {t('settings.common.cancel')}
                </Button>
                <Button variant="primary" className="flex-1" icon="check" onClick={() => void confirmPending()}>
                  {ACTION_LABEL[updateAction(pendingUpdate)]}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  )
}

/** 把开发模式到期时间格式化为「剩余 x 小时 y 分钟」。 */
function formatDevRemaining(expiresAt: number, t: TFunction): string {
  const ms = expiresAt - Date.now()
  if (ms <= 0) return t('settings.dev.expired')
  const totalMin = Math.floor(ms / 60000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? t('settings.dev.remainingHM', { h, m }) : t('settings.dev.remainingM', { m })
}

function formatBytes(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}

function Section({ title, icon, children }: { title: string; icon: string; children: ReactNode }): JSX.Element {
  return (
    <div className="glass rounded-[26px] p-5">
      <div className="mb-3 flex items-center gap-2">
        <Icon name={icon} size={17} className="opacity-70" />
        <span className="title">{title}</span>
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[13px] opacity-80">{label}</span>
      {children}
    </div>
  )
}

/**
 * 数字输入框的取值钳制。
 *
 * 直接写 `Number(v) || 8` 有两个坑：清空输入框或输入 0 会被静默改成 8（用户以为
 * 生效了其实没有），而手输超过 max 的值又会被原样保存（`max` 只约束上下箭头）。
 * 这里统一：非法 / 空值 / 0 一律回落到上一次的有效值，合法值夹到 [min, max]。
 */
function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(min, n))
}

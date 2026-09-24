import { useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { DownloadProgress, JavaRuntime, UpdateCheckResult, UpdateInfo } from '@shared/types'
import { useApp } from '../store'
import { Button, Icon, ProgressBar, Segmented, Switch } from '../components/ui'

const ACCENTS = ['#0a84ff', '#30d158', '#ff9f0a', '#ff375f', '#bf5af2', '#ff453a']

/** 背景预设色卡：colors 为深色模式渐变，lightColors 为浅色模式渐变（与 index.css 一一对应）。
 *  首个「午夜」即默认背景（index.css 的 .app-background 基色与之相同）。 */
const BACKGROUNDS: Array<{ key: string; label: string; colors: string[]; lightColors: string[] }> = [
  { key: 'midnight', label: '午夜', colors: ['#04060f', '#0b1330', '#10101c'], lightColors: ['#eef1fa', '#e8ecf8', '#f2f0fb'] },
  { key: 'sunset', label: '日落', colors: ['#2a0a14', '#7a2a1e', '#d4762a'], lightColors: ['#fff4ec', '#ffe9d9', '#ffe2cf'] },
  { key: 'forest', label: '森林', colors: ['#04120f', '#0a2e24', '#144d3a'], lightColors: ['#eefaf3', '#e4f6ec', '#eef9e8'] },
  { key: 'rose', label: '玫瑰', colors: ['#2a0a1c', '#6b1740', '#c94d6e'], lightColors: ['#fff0f6', '#ffe6f0', '#fbeafc'] },
  { key: 'mono', label: '黑白', colors: ['#0d0d10', '#1c1c22', '#2a2a30'], lightColors: ['#f4f4f6', '#ededf0', '#e6e6ea'] }
]

export function SettingsPage(): JSX.Element {
  const { settings, updateSettings, theme } = useApp()
  const [javas, setJavas] = useState<JavaRuntime[]>([])
  const [detecting, setDetecting] = useState(false)

  const [appVersion, setAppVersion] = useState('')
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null)
  const [updateProgress, setUpdateProgress] = useState<DownloadProgress | null>(null)
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'downloading' | 'done' | 'error' | 'opened'>('idle')
  const [updatePath, setUpdatePath] = useState<string | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [pendingUpdate, setPendingUpdate] = useState<UpdateInfo | null>(null)

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
    downloadAndRun: '确认下载并运行',
    download: '确认下载',
    openLink: '确认打开链接'
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
        <h1 className="display">设置</h1>
        <p className="caption mt-1">自定义启动器的外观与运行方式</p>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {/* 模式 */}
        <Section title="模式" icon="settings">
          <Row label="运行模式">
            <Segmented
              value={settings.mode}
              onChange={(v) => void updateSettings({ mode: v })}
              options={[
                { value: 'normal', label: '普通模式' },
                { value: 'local', label: '本地模式' },
                { value: 'minimal', label: '极简模式' }
              ]}
            />
          </Row>
          <p className="caption -mt-1">
            {settings.mode === 'normal' && '完整功能与液态玻璃界面'}
            {settings.mode === 'local' && '关闭所有联网功能（资源下载、更新、在线登录等），仅保留本地游玩'}
            {settings.mode === 'minimal' && 'UI 二维化：去除模糊、阴影与动态背景，功能保持不变'}
          </p>
        </Section>

        {/* 外观 */}
        <Section title="外观" icon="palette">
          <Row label="主题">
            <Segmented
              value={settings.theme}
              onChange={(v) => void updateSettings({ theme: v })}
              options={[
                { value: 'light', label: '浅色' },
                { value: 'dark', label: '深色' },
                { value: 'system', label: '跟随系统' }
              ]}
            />
          </Row>
          <Row label="主题色">
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
          <Row label="背景">
            <div className="flex items-center gap-2">
              {BACKGROUNDS.map((b) => (
                <button
                  key={b.key}
                  title={b.label}
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
          <Row label="减少动态效果">
            <Switch
              checked={settings.reducedMotion}
              onChange={(v) => void updateSettings({ reducedMotion: v })}
            />
          </Row>
        </Section>

        {/* 游戏 */}
        <Section title="游戏" icon="cube">
          <Row label="游戏目录">
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
                更改
              </Button>
            </div>
          </Row>
          <Row label="版本隔离（每版本独立目录）">
            <Switch
              checked={settings.versionIsolation}
              onChange={(v) => void updateSettings({ versionIsolation: v })}
            />
          </Row>
          <Row label="启动游戏后关闭启动器">
            <Switch
              checked={settings.closeOnLaunch}
              onChange={(v) => void updateSettings({ closeOnLaunch: v })}
            />
          </Row>
          <Row label="Debug 模式（显示启动日志）">
            <div className="flex items-center gap-2">
              <Switch
                checked={settings.debugMode}
                onChange={(v) => void updateSettings({ debugMode: v })}
              />
              {settings.debugMode && (
                <Button size="sm" icon="info" onClick={() => void window.api.debug.openWindow()}>
                  打开日志窗口
                </Button>
              )}
            </div>
          </Row>
          <Row label="模组信息仅识别元数据（不联网查询 Modrinth）">
            <Switch
              checked={settings.mode === 'local' || settings.metadataOnlyMods}
              disabled={settings.mode === 'local'}
              onChange={(v) => void updateSettings({ metadataOnlyMods: v })}
            />
          </Row>
        </Section>

        {/* Java */}
        <Section title="Java 运行时" icon="settings">
          <Row label="自动检测">
            <Switch
              checked={settings.javaAutoDetect}
              onChange={(v) => void updateSettings({ javaAutoDetect: v })}
            />
          </Row>
          <div className="mt-2">
            <div className="mb-2 flex items-center justify-between">
              <span className="caption">已检测到的 Java</span>
              <Button size="sm" icon="refresh" onClick={detect} disabled={detecting}>
                {detecting ? '检测中' : '重新检测'}
              </Button>
            </div>
            <div className="space-y-1.5">
              {javas.length === 0 && !detecting && (
                <div className="caption">未检测到 Java，请手动指定路径</div>
              )}
              {javas.map((j) => {
                const active = settings.javaPath === j.path
                return (
                  <button
                    key={j.path}
                    onClick={() => void updateSettings({ javaPath: j.path, javaAutoDetect: false })}
                    className="glass-soft flex w-full items-center justify-between rounded-xl px-3 py-2 no-drag"
                    style={{ borderColor: active ? 'var(--fill-primary)' : undefined }}
                  >
                    <div className="flex items-center gap-2">
                      {active && <Icon name="check" size={15} style={{ color: 'var(--fill-primary)' }} />}
                      <div className="text-left">
                        <div className="text-[13px] font-medium">Java {j.major}</div>
                        <div className="caption selectable truncate max-w-[360px]">{j.path}</div>
                      </div>
                    </div>
                    <span className="chip">
                      {j.vendor ?? '未知'} · {j.is64Bit ? '64位' : '32位'}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </Section>

        {/* 下载 */}
        <Section title="下载" icon="download">
          <Row label="下载镜像">
            <Segmented
              value={settings.mirror}
              onChange={(v) => void updateSettings({ mirror: v })}
              options={[
                { value: 'mojang', label: '官方源' },
                { value: 'bmclapi', label: 'BMCLAPI' }
              ]}
            />
          </Row>
          <Row label="并发连接数">
            <input
              type="number"
              min={1}
              max={32}
              value={settings.maxDownloadConcurrency}
              onChange={(e) => void updateSettings({ maxDownloadConcurrency: Number(e.target.value) || 8 })}
              className="input w-24"
            />
          </Row>
        </Section>

        {/* 更新 */}
        {settings.mode !== 'local' && (
          <Section title="更新" icon="refresh">
          <Row label="当前版本">
            <span className="chip">{appVersion || '…'}</span>
          </Row>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[13px] opacity-80">检测更新</span>
              <Button size="sm" icon="refresh" onClick={() => void checkUpdate()} disabled={updateChecking || updateStatus === 'downloading'}>
                {updateChecking ? '检测中…' : updateStatus === 'downloading' ? '下载中…' : '检测更新'}
              </Button>
            </div>

            {updateStatus === 'error' && updateError && (
              <div className="glass-soft rounded-xl p-3 text-[13px]" style={{ color: 'var(--fill-danger)' }}>
                {updateError}
              </div>
            )}

            {updateResult && updateStatus === 'idle' && !updateResult.hasUpdate && (
              <div className="glass-soft rounded-xl p-3 text-[13px] opacity-70">
                已是最新版本（当前 {updateResult.currentVersion}）
              </div>
            )}

            {updateResult?.latest && (updateStatus === 'downloading' || updateStatus === 'done') && (
              <div className="glass-soft rounded-xl p-3">
                <div className="mb-1 flex items-center justify-between text-[13px]">
                  <span className="font-medium">
                    {updateStatus === 'done' ? '下载完成' : `正在下载 v${updateResult.latest.version}`}
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
                        立即安装
                      </Button>
                    </div>
                    {updatePath && (
                      <div className="caption selectable mt-2 break-all opacity-70">已保存到：{updatePath}</div>
                    )}
                  </>
                )}
                {updateResult.latest.notes && (
                  <div className="caption mt-2 whitespace-pre-wrap border-t pt-2" style={{ borderColor: 'var(--divider)' }}>
                    {updateResult.latest.notes}
                  </div>
                )}
              </div>
            )}

            {updateResult?.latest && updateStatus === 'opened' && (
              <div className="glass-soft rounded-xl p-3">
                <div className="mb-1 text-[13px] font-medium">
                  已在浏览器中打开下载链接（v{updateResult.latest.version}）
                </div>
                <div className="caption selectable break-all opacity-70">{updateResult.latest.url}</div>
                {updateResult.latest.notes && (
                  <div className="caption mt-2 whitespace-pre-wrap border-t pt-2" style={{ borderColor: 'var(--divider)' }}>
                    {updateResult.latest.notes}
                  </div>
                )}
              </div>
            )}
          </div>
        </Section>
        )}
      </div>

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
                <span className="title">发现新版本 v{pendingUpdate.version}</span>
              </div>
              <div className="mb-5 mt-3">
                <div className="caption mb-2">更新日志</div>
                <div className="glass-soft max-h-[38vh] selectable overflow-y-auto whitespace-pre-wrap break-words rounded-2xl p-4 text-[13px] leading-relaxed opacity-80">
                  {pendingUpdate.notes?.trim() || '暂无更新日志。'}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button className="flex-1" onClick={() => setPendingUpdate(null)}>
                  取消
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

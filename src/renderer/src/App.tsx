import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { AppProvider, useApp } from './store'
import { RuntimeProvider } from './runtime'
import { TitleBar } from './components/TitleBar'
import { Sidebar, type PageId } from './components/Sidebar'
import { JavaPrompt } from './components/JavaPrompt'
import { FlyDot } from './components/FlyDot'
import { AgreementModal } from './components/AgreementModal'
import { OnboardingModal } from './components/OnboardingModal'
import { SecurityBlockedOverlay } from './components/SecurityBlockedOverlay'
import { CursorGlow } from './components/CursorGlow'
import { DownloadOrb } from './components/DownloadOrb'
import { Win10Desktop } from './components/Win10Desktop'
import { FileManager } from './components/FileManager'
import { Button, Icon, Markdown } from './components/ui'
import { renderPage, type ResourcePreset } from './pages/router'
import { InstanceManagePage } from './pages/InstanceManagePage'

function Shell(): JSX.Element {
  const { settings, t, reloadAccounts, securityAlert, clearSecurityAlert, fileManagerPath, closeFileManager, lowUsageNotice, dismissLowUsageNotice, launcherUpdateNotice, dismissLauncherUpdateNotice } = useApp()
  const [page, setPage] = useState<PageId>('home')
  const [managingId, setManagingId] = useState<string | null>(null)
  const [tokenExpiredError, setTokenExpiredError] = useState<string | null>(null)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [resourcePreset, setResourcePreset] = useState<ResourcePreset>(null)
  const needAgreement = !settings.agreementAcceptedAt

  // 首次同意协议后自动弹出新手引导（仅一次；之后通过双击左上角图标再次唤起）。
  useEffect(() => {
    if (!needAgreement && !settings.onboardingDone) setOnboardingOpen(true)
  }, [needAgreement, settings.onboardingDone])

  const navigate = (p: PageId): void => {
    setManagingId(null)
    setPage(p)
  }

  // 引导「安装 26.2 原版」：跳到资源下载的「版本」标签并预填版本号。
  const installVanillaGuide = (): void => {
    setOnboardingOpen(false)
    setResourcePreset({ tab: 'versions', search: '26.2' })
    navigate('resources')
    setTimeout(() => setResourcePreset(null), 0)
  }

  // 启动时检测选中账户令牌：微软 / 第三方账号若已/即将过期则自动刷新，刷新失败弹窗提醒。
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const acc = await window.api.accounts.selected()
        if (!acc || acc.offline) return
        // 与启动流程一致，提前 60 秒即视为过期，主动刷新一次；
        // expiresAt 缺失（老账号）也视为需刷新
        if (typeof acc.expiresAt === 'number' && acc.expiresAt >= Date.now() + 60_000) return
        try {
          await window.api.auth.refresh(acc)
          await reloadAccounts()
        } catch (err) {
          if (alive) setTokenExpiredError(err instanceof Error ? err.message : String(err))
        }
      } catch {
        /* 忽略：取账户失败不影响启动 */
      }
    })()
    return () => {
      alive = false
    }
  }, [reloadAccounts])

  // 本地模式：资源下载 / 进度 / 关于均不展示，切换后自动退回首页
  useEffect(() => {
    if (settings.mode === 'local' && (page === 'resources' || page === 'downloads' || page === 'about')) {
      setManagingId(null)
      setPage('home')
    }
  }, [settings.mode, page])

  // 实验性 Win10 桌面整块替换外壳（侧栏 / 标题栏 / 玻璃背景），
  // 仿 Mac 玻璃只是皮肤，外壳保持不变。
  const desktop = settings.experimental === 'win10'

  // 安全拦截：命中危险代码时强制系统全屏（连 Windows 任务栏一起盖住），
  // 关闭提示后由主进程按拦截前记住的状态精确还原（桌面模式的全屏不会被退掉）。
  // 用 ref 记录「是否进过拦截态」：启动时不要在没拦截的情况下动窗口状态。
  const securityAlertWasOn = useRef(false)
  useEffect(() => {
    if (securityAlert) {
      securityAlertWasOn.current = true
      void window.api.window.securityFullscreen(true)
      return
    }
    if (!securityAlertWasOn.current) return
    securityAlertWasOn.current = false
    void window.api.window.securityFullscreen(false)
  }, [securityAlert])

  return (
    <MotionConfig reducedMotion={settings.reducedMotion ? 'always' : 'user'}>
      <div className="relative h-full">
        {desktop ? (
          <Win10Desktop />
        ) : (
          <>
            <div className="app-background" aria-hidden>
              <div className="blob blob-1" />
              <div className="blob blob-2" />
              <div className="blob blob-3" />
            </div>

            <TitleBar onLogoDoubleClick={() => setOnboardingOpen(true)} />

            <div className="flex h-full pt-12">
              <div className="w-[224px] shrink-0">
                <Sidebar active={page} onNavigate={navigate} />
              </div>

              <main className="min-w-0 flex-1 p-5 pl-2">
                {/* 页面 ⇄ 实例管理整页：用 key 切换同一容器内的两态视图，做淡入 + 轻微 y/scale 过渡。
                    这里只做入场（不加 AnimatePresence 退场），避免退场延后新页面挂载。 */}
                <motion.div
                  key={managingId ? 'manage' : page}
                  className="h-full"
                  initial={{ opacity: 0, y: 12, scale: 0.995 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ type: 'spring', bounce: 0, duration: 0.35 }}
                >
                  {managingId ? (
                    <InstanceManagePage versionId={managingId} onBack={() => setManagingId(null)} onRename={setManagingId} />
                  ) : (
                    renderPage(page, setManagingId, resourcePreset)
                  )}
                </motion.div>
              </main>
            </div>

            <DownloadOrb onNavigate={navigate} />
            <CursorGlow />
          </>
        )}

        {/* 自实现资源管理器（非桌面模式）：覆盖层，替代系统文件资源管理器。
            桌面模式下由 Win10Desktop 以「窗口」形式承载，这里不重复渲染。 */}
        <AnimatePresence>
          {!desktop && fileManagerPath && (
            <motion.div
              className="fixed inset-0 z-[100] flex items-center justify-center p-6"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={closeFileManager} />
              <motion.div
                className="glass-strong relative z-10 h-[72vh] w-full max-w-4xl overflow-hidden rounded-[24px]"
                initial={{ scale: 0.97, opacity: 0, y: 14 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.97, opacity: 0, y: 10 }}
                transition={{ type: 'spring', bounce: 0.14, duration: 0.4 }}
              >
                <FileManager initialPath={fileManagerPath} onClose={closeFileManager} />
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        <JavaPrompt />
        <FlyDot />
        <AnimatePresence>{needAgreement && <AgreementModal />}</AnimatePresence>
        <OnboardingModal
          open={onboardingOpen}
          onNavigate={navigate}
          onInstallVanilla={installVanillaGuide}
          onFinish={() => setOnboardingOpen(false)}
        />
        <AnimatePresence>
          {tokenExpiredError && (
            <motion.div
              className="fixed inset-0 z-[110] flex items-center justify-center p-6"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} />
              <motion.div
                className="glass-strong relative z-10 w-full max-w-md rounded-[28px] p-7"
                initial={{ scale: 0.95, opacity: 0, y: 16 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.96, opacity: 0, y: 12 }}
                transition={{ type: 'spring', bounce: 0.16, duration: 0.45 }}
              >
                <div className="mb-3 flex items-center gap-3">
                  <div
                    className="flex h-11 w-11 items-center justify-center rounded-2xl text-white"
                    style={{ background: 'var(--fill-danger)' }}
                  >
                    <Icon name="user" size={22} />
                  </div>
                  <div>
                    <h2 className="title">{t('shell.tokenExpired.title')}</h2>
                    <p className="caption">{t('shell.tokenExpired.subtitle')}</p>
                  </div>
                </div>
                <p className="caption selectable mb-5">{tokenExpiredError}</p>
                <div className="flex gap-2">
                  <Button className="flex-1" onClick={() => setTokenExpiredError(null)}>
                    {t('shell.tokenExpired.later')}
                  </Button>
                  <Button
                    variant="primary"
                    className="flex-1"
                    onClick={() => {
                      setTokenExpiredError(null)
                      navigate('accounts')
                    }}
                  >
                    {t('shell.tokenExpired.goLogin')}
                  </Button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 首次启动检测到低配电脑：已自动开启「超低占用模式」的一次性提醒。 */}
        <AnimatePresence>
          {lowUsageNotice && (
            <motion.div
              className="fixed inset-0 z-[110] flex items-center justify-center p-6"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={dismissLowUsageNotice} />
              <motion.div
                className="glass-strong relative z-10 w-full max-w-md rounded-[28px] p-7"
                initial={{ scale: 0.95, opacity: 0, y: 16 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.96, opacity: 0, y: 12 }}
                transition={{ type: 'spring', bounce: 0.16, duration: 0.45 }}
              >
                <div className="mb-3 flex items-center gap-3">
                  <div
                    className="flex h-11 w-11 items-center justify-center rounded-2xl text-white"
                    style={{ background: 'var(--fill-primary)' }}
                  >
                    <Icon name="info" size={22} />
                  </div>
                  <div>
                    <h2 className="title">{t('shell.lowUsage.title')}</h2>
                    <p className="caption">{t('shell.lowUsage.subtitle')}</p>
                  </div>
                </div>
                <p className="caption selectable mb-5">
                  {t('shell.lowUsage.detail')}
                </p>
                <div className="flex gap-2">
                  <Button className="flex-1" onClick={dismissLowUsageNotice}>
                    {t('shell.lowUsage.confirm')}
                  </Button>
                  <Button
                    variant="primary"
                    className="flex-1"
                    onClick={() => {
                      dismissLowUsageNotice()
                      navigate('settings')
                    }}
                  >
                    {t('shell.lowUsage.goSettings')}
                  </Button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 启动时自动检查到新版本：提示前往「设置 → 更新」查看更新日志并下载。 */}
        <AnimatePresence>
          {launcherUpdateNotice && (
            <motion.div
              className="fixed inset-0 z-[112] flex items-center justify-center p-6"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={dismissLauncherUpdateNotice} />
              <motion.div
                className="glass-strong relative z-10 w-full max-w-md rounded-[28px] p-7"
                initial={{ scale: 0.95, opacity: 0, y: 16 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.96, opacity: 0, y: 12 }}
                transition={{ type: 'spring', bounce: 0.16, duration: 0.45 }}
              >
                <div className="mb-3 flex items-center gap-3">
                  <div
                    className="flex h-11 w-11 items-center justify-center rounded-2xl text-white"
                    style={{ background: 'var(--fill-primary)' }}
                  >
                    <Icon name="download" size={22} />
                  </div>
                  <div>
                    <h2 className="title">{t('shell.update.title', { n: launcherUpdateNotice.version })}</h2>
                    <p className="caption">{t('shell.update.subtitle')}</p>
                  </div>
                </div>
                {launcherUpdateNotice.notes?.trim() && (
                  <Markdown
                    text={launcherUpdateNotice.notes}
                    className="glass-soft mb-5 max-h-[30vh] overflow-y-auto rounded-2xl p-4 text-[13px] leading-relaxed opacity-80"
                  />
                )}
                <div className="flex gap-2">
                  <Button className="flex-1" onClick={dismissLauncherUpdateNotice}>
                    {t('shell.update.later')}
                  </Button>
                  <Button
                    variant="primary"
                    className="flex-1"
                    onClick={() => {
                      dismissLauncherUpdateNotice()
                      navigate('settings')
                    }}
                  >
                    {t('shell.update.goUpdate')}
                  </Button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 自定义主页运行时被安全策略拦截：全屏提示（z 最高，压住桌面模式与其它弹窗） */}
        <AnimatePresence>
          {securityAlert && <SecurityBlockedOverlay alert={securityAlert} onClose={clearSecurityAlert} />}
        </AnimatePresence>
      </div>
    </MotionConfig>
  )
}

export default function App(): JSX.Element {
  return (
    <AppProvider>
      <RuntimeProvider>
        <Shell />
      </RuntimeProvider>
    </AppProvider>
  )
}

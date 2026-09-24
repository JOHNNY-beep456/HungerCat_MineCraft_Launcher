import { useEffect, useState } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { AppProvider, useApp } from './store'
import { RuntimeProvider, useRuntime } from './runtime'
import { TitleBar } from './components/TitleBar'
import { Sidebar, type PageId } from './components/Sidebar'
import { JavaPrompt } from './components/JavaPrompt'
import { FlyDot } from './components/FlyDot'
import { AgreementModal } from './components/AgreementModal'
import { OnboardingModal } from './components/OnboardingModal'
import { CursorGlow } from './components/CursorGlow'
import { Button, Icon, formatSpeed } from './components/ui'
import { HomePage } from './pages/HomePage'
import { ResourceDownloadPage, type Tab } from './pages/ResourceDownloadPage'
import { AccountsPage } from './pages/AccountsPage'
import { DownloadsPage } from './pages/DownloadsPage'
import { SettingsPage } from './pages/SettingsPage'
import { AboutPage } from './pages/AboutPage'
import { InstancesPage } from './pages/InstancesPage'
import { InstanceManagePage } from './pages/InstanceManagePage'

function renderPage(
  page: PageId,
  onManage: (versionId: string) => void,
  resourcePreset: { tab: Extract<Tab, 'versions'>; search: string } | null
): JSX.Element {
  switch (page) {
    case 'home':
      return <HomePage />
    case 'resources':
      return <ResourceDownloadPage initialTab={resourcePreset?.tab} presetSearch={resourcePreset?.search} />
    case 'instances':
      return <InstancesPage onManage={onManage} />
    case 'accounts':
      return <AccountsPage />
    case 'downloads':
      return <DownloadsPage />
    case 'settings':
      return <SettingsPage />
    case 'about':
      return <AboutPage />
  }
}

/**
 * 全局右下角常驻的下载进度光球：对所有进行中下载任务（phase !== 'done'）
 * 汇总总进度与实时速度。仅在有进行中任务时渲染，无任务即从 DOM 卸载，
 * 不产生常驻遮挡。点击跳到「进度」页。
 */
function DownloadOrb({ onNavigate }: { onNavigate: (p: PageId) => void }): JSX.Element | null {
  const { downloads } = useRuntime()
  // done 的进度会被 runtime 即时移除，这里再过滤一次以兜底瞬时空窗。
  const active = downloads.filter((d) => d.phase !== 'done')
  const totalCurrent = active.reduce((s, d) => s + (d.currentBytes || 0), 0)
  const totalTotal = active.reduce((s, d) => s + (d.totalBytes || 0), 0)
  const percent = totalTotal > 0 ? Math.round((totalCurrent / totalTotal) * 100) : 0
  const speed = active.reduce((s, d) => s + (d.speed || 0), 0)

  return (
    <AnimatePresence>
      {active.length > 0 && (
        <motion.button
          key="download-orb"
          onClick={() => onNavigate('downloads')}
          className="glass-strong no-drag fixed right-5 bottom-6 z-[90] flex h-16 w-16 cursor-pointer flex-col items-center justify-center overflow-hidden rounded-full"
          style={{ boxShadow: '0 8px 24px -6px var(--fill-primary)' }}
          initial={{ opacity: 0, scale: 0.6, y: 16 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.6, y: 16 }}
          transition={{ type: 'spring', bounce: 0.18, duration: 0.45 }}
          whileHover={{ scale: 1.06 }}
          whileTap={{ scale: 0.95 }}
          aria-label="查看下载进度"
          title="查看下载进度"
        >
          <div
            className="pointer-events-none absolute inset-0 rounded-full"
            style={{ background: 'linear-gradient(140deg, var(--fill-primary) 0%, transparent 65%)', opacity: 0.55 }}
          />
          <span className="relative text-[15px] font-bold leading-none" style={{ color: 'var(--text-primary)' }}>
            {percent}%
          </span>
          <span className="relative mt-1 text-[9px] leading-none opacity-80">{formatSpeed(speed)}</span>
        </motion.button>
      )}
    </AnimatePresence>
  )
}

function Shell(): JSX.Element {
  const { settings, reloadAccounts } = useApp()
  const [page, setPage] = useState<PageId>('home')
  const [managingId, setManagingId] = useState<string | null>(null)
  const [tokenExpiredError, setTokenExpiredError] = useState<string | null>(null)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [resourcePreset, setResourcePreset] = useState<{ tab: Extract<Tab, 'versions'>; search: string } | null>(null)
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

  // 启动时检测选中账户令牌：仅微软账户，若已/即将过期则自动刷新，刷新失败弹窗提醒。
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

  return (
    <MotionConfig reducedMotion={settings.reducedMotion ? 'always' : 'user'}>
      <div className="relative h-full">
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

        <JavaPrompt />
        <FlyDot />
        <DownloadOrb onNavigate={navigate} />
        <CursorGlow />
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
                    <h2 className="title">账户令牌已过期</h2>
                    <p className="caption">无法自动刷新，请重新登录微软账号</p>
                  </div>
                </div>
                <p className="caption selectable mb-5">{tokenExpiredError}</p>
                <div className="flex gap-2">
                  <Button className="flex-1" onClick={() => setTokenExpiredError(null)}>
                    稍后处理
                  </Button>
                  <Button
                    variant="primary"
                    className="flex-1"
                    onClick={() => {
                      setTokenExpiredError(null)
                      navigate('accounts')
                    }}
                  >
                    前往登录
                  </Button>
                </div>
              </motion.div>
            </motion.div>
          )}
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

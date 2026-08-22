import { useEffect, useState } from 'react'
import { MotionConfig, motion } from 'motion/react'
import { AppProvider, useApp } from './store'
import { RuntimeProvider } from './runtime'
import { TitleBar } from './components/TitleBar'
import { Sidebar, type PageId } from './components/Sidebar'
import { JavaPrompt } from './components/JavaPrompt'
import { FlyDot } from './components/FlyDot'
import { AgreementModal } from './components/AgreementModal'
import { CursorGlow } from './components/CursorGlow'
import { Button, Icon } from './components/ui'
import { HomePage } from './pages/HomePage'
import { ResourceDownloadPage } from './pages/ResourceDownloadPage'
import { AccountsPage } from './pages/AccountsPage'
import { DownloadsPage } from './pages/DownloadsPage'
import { SettingsPage } from './pages/SettingsPage'
import { AboutPage } from './pages/AboutPage'
import { InstancesPage } from './pages/InstancesPage'
import { InstanceManagePage } from './pages/InstanceManagePage'

function renderPage(page: PageId, onManage: (versionId: string) => void): JSX.Element {
  switch (page) {
    case 'home':
      return <HomePage />
    case 'resources':
      return <ResourceDownloadPage />
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

function Shell(): JSX.Element {
  const { settings, reloadAccounts } = useApp()
  const [page, setPage] = useState<PageId>('home')
  const [managingId, setManagingId] = useState<string | null>(null)
  const [tokenExpiredError, setTokenExpiredError] = useState<string | null>(null)
  const needAgreement = !settings.agreementAcceptedAt

  const navigate = (p: PageId): void => {
    setManagingId(null)
    setPage(p)
  }

  // 启动时检测选中账户令牌：仅微软账户，若已/即将过期则自动刷新，刷新失败弹窗提醒。
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const acc = await window.api.accounts.selected()
        if (!acc || acc.offline) return
        // 与启动流程一致，提前 60 秒即视为过期，主动刷新一次
        if (acc.expiresAt >= Date.now() + 60_000) return
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

        <TitleBar />

        <div className="flex h-full pt-12">
          <div className="w-[224px] shrink-0">
            <Sidebar active={page} onNavigate={navigate} />
          </div>

          <main className="min-w-0 flex-1 p-5 pl-2">
            {managingId ? (
              <InstanceManagePage versionId={managingId} onBack={() => setManagingId(null)} onRename={setManagingId} />
            ) : (
              <motion.div
                key={page}
                className="h-full"
                initial={{ opacity: 0, y: 12, scale: 0.995 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ type: 'spring', bounce: 0, duration: 0.35 }}
              >
                {renderPage(page, setManagingId)}
              </motion.div>
            )}
          </main>
        </div>

        <JavaPrompt />
        <FlyDot />
        <CursorGlow />
        {needAgreement && <AgreementModal />}
        {tokenExpiredError && (
          <motion.div
            className="fixed inset-0 z-[110] flex items-center justify-center p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          >
            <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} />
            <motion.div
              className="glass-strong relative z-10 w-full max-w-md rounded-[28px] p-7"
              initial={{ scale: 0.95, opacity: 0, y: 16 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
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

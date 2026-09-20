import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { PageId } from './Sidebar'
import { useApp } from '../store'
import { Button, Icon } from './ui'

interface GuideStep {
  icon: string
  target: string | null
  page: PageId | null
  title: string
  body: string
}

/**
 * 新手引导（聚光讲解）。每一步只在侧边栏对应导航上开一个「聚光灯」圆角高亮框，
 * 自动切换到对应页面，让玩家在真实界面里了解各功能与加载器 / 模组的关系，
 * 最后引导安装一份 26.2 原版实例。
 */
const STEPS: GuideStep[] = [
  {
    icon: 'home',
    target: 'nav-home',
    page: 'home',
    title: '启动游戏',
    body: '这是启动器首页。从下拉菜单选择已安装的版本、调整内存后，点击「启动」即可进入游戏。首次启动会自动下载所需文件。'
  },
  {
    icon: 'cube',
    target: 'nav-resources',
    page: 'resources',
    title: '资源下载 · 模组',
    body: '这里是下载中心，分为「模组 / 资源包 / 光影 / 整合包 / 版本」。以模组为例：它们为游戏添加新内容或改变玩法。大多数模组依赖一个「加载器」才能运行。'
  },
  {
    icon: 'box',
    target: 'nav-instances',
    page: 'instances',
    title: '实例与加载器',
    body: '每个「实例」就是一份独立的游戏安装（包含原版 + 加载器 + 模组）。加载器（如 Fabric、Forge、Quilt、NeoForge）是模组运行的基础框架。安装实例时可选择对应加载器；选择 Fabric 时还可勾选一并安装 Fabric API。'
  },
  {
    icon: 'user',
    target: 'nav-accounts',
    page: 'accounts',
    title: '账号',
    body: '点击这里登录微软正版或第三方（如 LittleSkin / 馋猫认证中心）账号，即可正常联机；不登录也可作为离线账号游玩。'
  },
  {
    icon: 'download',
    target: null,
    page: null,
    title: '安装 26.2 原版',
    body: '下面带你安装一个新实例。点击「去安装」，我们会在「资源下载 → 版本」中帮你预填版本号 26.2；在其中点选该版本并按「安装」即可（选择 Fabric 时可勾选 Fabric API）。'
  },
  {
    icon: 'info',
    target: null,
    page: null,
    title: '再次查看本引导',
    body: '引导到此结束。之后想再次查看，随时双击顶部左上角的「Hunger Cat 图标」，即可重新打开这份新手引导。'
  }
]

const INSTALL_INDEX = 4

export function OnboardingModal({
  open,
  onNavigate,
  onInstallVanilla,
  onFinish
}: {
  open: boolean
  onNavigate: (p: PageId) => void
  onInstallVanilla: () => void
  onFinish: () => void
}): JSX.Element {
  const { updateSettings } = useApp()
  const [index, setIndex] = useState(0)
  // 回调用 ref 持有，避免在 useEffect 依赖里反复触发导航
  const onNavigateRef = useRef(onNavigate)
  const onInstallRef = useRef(onInstallVanilla)
  const onFinishRef = useRef(onFinish)
  onNavigateRef.current = onNavigate
  onInstallRef.current = onInstallVanilla
  onFinishRef.current = onFinish

  const step = STEPS[index]
  const last = index === STEPS.length - 1
  const isInstall = index === INSTALL_INDEX
  // 目标高亮框（侧边栏导航）的视口矩形
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null)

  // 每进入一步：若该步与某页面绑定，则自动切换到该页面
  useEffect(() => {
    if (!open) return
    if (step.page) onNavigateRef.current(step.page)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index])

  // 测量目标元素位置（等页面切换完成后再量），跟随窗口尺寸变化
  useEffect(() => {
    if (!open) return
    const measure = (): void => {
      if (!step.target) {
        setRect(null)
        return
      }
      const el = document.getElementById(step.target)
      if (!el) {
        setRect(null)
        return
      }
      const r = el.getBoundingClientRect()
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
    }
    const timer = setTimeout(measure, 80)
    window.addEventListener('resize', measure)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('resize', measure)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index])

  const next = (): void => {
    if (last) {
      void updateSettings({ onboardingDone: true })
      onFinishRef.current()
      setIndex(0)
    } else {
      setIndex((i) => i + 1)
    }
  }

  const prev = (): void => setIndex((i) => Math.max(0, i - 1))

  // 讲解卡片定位：优先放在高亮框右侧，无目标时居中
  const tipStyle: CSSProperties = rect
    ? {
        left: Math.min(rect.left + rect.width + 16, (window.innerWidth || 0) - 360),
        top: Math.max(12, Math.min(rect.top, (window.innerHeight || 0) - 320))
      }
    : { left: '50%', top: '50%', transform: 'translate(-50%,-50%)' }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[125]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          style={{ pointerEvents: 'none' }}
        >
          {/* 聚光灯高亮框：透明框 + 超大扩散阴影压暗其余区域 */}
          {rect && (
            <motion.div
              className="absolute rounded-[18px]"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: 'spring', bounce: 0.2, duration: 0.4 }}
              style={{
                top: rect.top - 5,
                left: rect.left - 5,
                width: rect.width + 10,
                height: rect.height + 10,
                boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
                border: '2px solid var(--fill-primary)'
              }}
            />
          )}

          {/* 讲解卡片 */}
          <motion.div
            className="glass-strong fixed z-[126] w-[340px] max-w-[calc(100vw-32px)] rounded-[28px] p-6"
            style={{ ...tipStyle, pointerEvents: 'auto', boxShadow: 'var(--glass-shadow)' }}
            initial={{ opacity: 0, scale: 0.94, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: 'spring', bounce: 0.18, duration: 0.4 }}
          >
            <div className="mb-4 flex items-center gap-3">
              <div
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-white"
                style={{ background: 'var(--fill-primary)' }}
              >
                <Icon name={step.icon} size={22} />
              </div>
              <div className="min-w-0">
                <h2 className="title leading-tight">{step.title}</h2>
                <span className="caption">
                  {index + 1} / {STEPS.length}
                </span>
              </div>
            </div>
            <p className="caption mb-5 leading-relaxed">{step.body}</p>

            <div className="mb-5 flex items-center gap-1.5">
              {STEPS.map((_, i) => (
                <span
                  key={i}
                  className="h-1.5 flex-1 rounded-full"
                  style={{ background: i <= index ? 'var(--fill-primary)' : 'var(--fill-secondary)' }}
                />
              ))}
            </div>

            <div className="flex items-center gap-2">
              <Button disabled={index === 0} onClick={prev} className="w-24">
                上一步
              </Button>
              {isInstall ? (
                <Button
                  variant="primary"
                  className="flex-1"
                  icon="download"
                  onClick={() => {
                    void updateSettings({ onboardingDone: true })
                    onInstallRef.current()
                    setIndex(0)
                  }}
                >
                  去安装 26.2 原版
                </Button>
              ) : (
                <Button variant="primary" className="flex-1" onClick={next}>
                  {last ? '完成' : '下一步'}
                </Button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useApp } from '../store'
import { Button, Icon } from './ui'

interface Step {
  icon: string
  title: string
  body: string
}

/** 新手引导步骤。最后一步必须说明如何再次唤起本引导。 */
const STEPS: Step[] = [
  {
    icon: 'home',
    title: '欢迎使用',
    body: '欢迎来到 Hunger Cat 启动器。左侧导航栏是你进入一切的入口：「启动游戏」「实例」「资源下载」「账号」「设置」等板块都从这里进入。下面带你快速上手。'
  },
  {
    icon: 'user',
    title: '登录账号',
    body: '点击左侧「账号」即可登录。支持微软正版账号、第三方认证（LittleSkin / 馋猫认证中心 / 自定义）以及离线账号。未登录时会显示默认头像。'
  },
  {
    icon: 'box',
    title: '安装游戏',
    body: '在「实例」页安装游戏版本，可选择原版，或同时安装 Fabric / Forge 等加载器；安装 Fabric 时还可勾选一并安装对应版本的 Fabric API。'
  },
  {
    icon: 'play',
    title: '启动游戏',
    body: '回到「启动游戏」页，选择已安装的版本、调整内存后点击「启动」即可进入游戏。首次启动会自动下载所需的游戏文件，请耐心等待。'
  },
  {
    icon: 'info',
    title: '再次查看本引导',
    body: '本引导到这里就结束了。之后若想再次查看，随时双击顶部左上角的「Hunger Cat 图标」，即可重新打开这份新手引导。'
  }
]

export function OnboardingModal({
  open,
  onFinish
}: {
  open: boolean
  onFinish: () => void
}): JSX.Element {
  const { updateSettings } = useApp()
  const [index, setIndex] = useState(0)
  const last = index === STEPS.length - 1
  const step = STEPS[index]

  const next = (): void => {
    if (last) {
      void updateSettings({ onboardingDone: true })
      onFinish()
      setIndex(0)
    } else {
      setIndex((i) => i + 1)
    }
  }

  const prev = (): void => setIndex((i) => Math.max(0, i - 1))

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[105] flex items-center justify-center p-6"
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
            <div className="mb-6 flex flex-col items-center gap-4 text-center">
              <div
                className="flex h-16 w-16 items-center justify-center rounded-2xl text-white"
                style={{ background: 'var(--fill-primary)' }}
              >
                <Icon name={step.icon} size={32} />
              </div>
              <div>
                <h2 className="title">{step.title}</h2>
                <p className="caption mt-2 leading-relaxed">{step.body}</p>
              </div>
            </div>

            <div
              className="mb-6 flex items-center gap-1.5"
              style={{ color: 'var(--fill-primary)' }}
            >
              {STEPS.map((_, i) => (
                <span
                  key={i}
                  className="h-1.5 flex-1 rounded-full"
                  style={{
                    background: i <= index ? 'var(--fill-primary)' : 'var(--fill-secondary)'
                  }}
                />
              ))}
            </div>

            <div className="flex items-center gap-2">
              <span className="caption">{index + 1} / {STEPS.length}</span>
              <div className="flex-1" />
              <Button disabled={index === 0} onClick={prev} className="w-24">
                上一步
              </Button>
              <Button variant="primary" onClick={() => void next()} className="w-24">
                {last ? '完成' : '下一步'}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
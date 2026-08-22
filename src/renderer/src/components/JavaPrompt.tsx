import { AnimatePresence, motion } from 'motion/react'
import { useRuntime } from '../runtime'
import { Button, Icon, ProgressBar } from './ui'

export function JavaPrompt(): JSX.Element {
  const { javaPrompt, busy, download, installJavaAndLaunch, cancelJavaPrompt } = useRuntime()

  return (
    <AnimatePresence>
      {javaPrompt && (
        <motion.div
          className="absolute inset-0 z-[60] flex items-center justify-center p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            className="absolute inset-0"
            style={{ background: 'var(--scrim)' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={busy ? undefined : cancelJavaPrompt}
          />
          <motion.div
            className="glass-strong relative z-10 w-full max-w-md rounded-[32px] p-8"
            initial={{ opacity: 0, scale: 0.92, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: 16 }}
            transition={{ type: 'spring', bounce: 0.2, duration: 0.45 }}
          >
            <div className="mb-4 flex items-center gap-3">
              <div
                className="flex h-11 w-11 items-center justify-center rounded-2xl text-white"
                style={{ background: 'var(--fill-danger)' }}
              >
                <Icon name="settings" size={22} />
              </div>
              <div>
                <h2 className="title">Java 版本不匹配</h2>
                <p className="caption">该版本需要 Java {javaPrompt.required} 或更高版本</p>
              </div>
            </div>

            <p className="mb-5 text-[13px] opacity-80">
              未检测到兼容的 Java 运行时。你可以自动下载并安装 Java {javaPrompt.required}（Adoptium
              Temurin），或取消本次启动。
            </p>

            {busy && download && (
              <div className="mb-5">
                <div className="mb-1.5 flex items-center justify-between text-[12px]">
                  <span className="truncate">{download.task}</span>
                  <span className="opacity-60">{download.percent}%</span>
                </div>
                <ProgressBar percent={download.percent} />
              </div>
            )}

            <div className="flex gap-2">
              <Button className="flex-1" disabled={busy} onClick={cancelJavaPrompt}>
                取消启动
              </Button>
              <Button
                variant="primary"
                className="flex-1"
                disabled={busy}
                onClick={() => void installJavaAndLaunch()}
              >
                {busy ? '安装中…' : `自动安装 Java ${javaPrompt.required}`}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

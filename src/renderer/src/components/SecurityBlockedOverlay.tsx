// ---------------------------------------------------------------------------
// 自定义主页运行时的安全拦截提示（全屏遮罩）。
//
// 主页脚本在运行时被查出「删除 / 修改文件、格式化、伪装代码」后，宿主会立即
// 停用并封锁该脚本，并用本组件以全屏遮罩告知用户：
//   - 挡住了什么（命中的危险行为 + 具体位置：哪个元素 / 哪条指令）；
//   - 已经做了什么（立即停用 + 永久封锁，不会自动恢复）；
//   - 还能做什么（打开脚本目录自行检查，确认有问题就删掉）。
//
// 渲染在应用最外层，覆盖侧栏 / 标题栏，也覆盖实验性 Win10 桌面模式。
// ---------------------------------------------------------------------------

import { motion } from 'motion/react'
import type { SecurityAlert } from '../store'
import { Button, Icon } from './ui'

export function SecurityBlockedOverlay({
  alert,
  onClose
}: {
  alert: SecurityAlert
  onClose: () => void
}): JSX.Element {
  return (
    <motion.div
      className="fixed inset-0 z-[200] flex items-center justify-center p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      role="alertdialog"
      aria-modal="true"
      aria-label="主页脚本已被安全策略停用"
    >
      <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} />
      <motion.div
        className="glass-strong relative z-10 flex max-h-[85vh] w-full max-w-lg flex-col rounded-[28px] p-6"
        initial={{ scale: 0.95, opacity: 0, y: 16 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ type: 'spring', bounce: 0.16, duration: 0.45 }}
      >
        <div className="mb-4 flex items-center gap-3">
          <div
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-white"
            style={{ background: 'var(--fill-danger)' }}
          >
            <Icon name="xmark" size={24} />
          </div>
          <div className="min-w-0">
            <h2 className="title">已立即停用该自定义主页</h2>
            <p className="caption">脚本运行时被检测到危险代码，已封锁并退回内置界面</p>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          <div
            className="rounded-2xl px-3.5 py-3 text-[13px] leading-relaxed"
            style={{ background: 'rgba(255,69,58,0.12)', color: 'var(--fill-danger)' }}
          >
            <div className="mb-1 flex items-center gap-1.5 font-semibold">
              <Icon name="xmark" size={14} />
              <span>命中的危险行为</span>
            </div>
            <div className="selectable break-all">{alert.reason}</div>
          </div>

          {alert.detail && (
            <div className="glass-soft rounded-2xl px-3.5 py-2.5">
              <div className="caption mb-1">拦截位置</div>
              <div className="selectable break-all text-[12.5px]">{alert.detail}</div>
            </div>
          )}

          <div className="glass-soft flex items-center justify-between gap-3 rounded-2xl px-3.5 py-2.5">
            <div className="caption">被封锁的脚本</div>
            <span className="chip shrink-0">{alert.homepageId}</span>
          </div>

          <p className="caption leading-relaxed">
            删除 / 修改文件、格式化磁盘、伪装（混淆）代码这类行为一旦在运行时出现，就会
            立即停用该主页并永久封锁它。封锁不会因为脚本内容改动而解除：
            请在「主页 → 脚本目录」里自行检查该脚本，确认无误后再删除并重新导入。
          </p>

          <p className="caption leading-relaxed">
            为确保你能看到本提示，启动器已被切到系统全屏（连 Windows 任务栏一起盖住）；
            点「我已了解」后会恢复成原来的窗口大小。
          </p>
        </div>

        <div className="mt-5 flex gap-2">
          <Button
            variant="primary"
            className="flex-1"
            icon="folder"
            onClick={() => void window.api.homepage.openDir()}
          >
            打开脚本目录
          </Button>
          <Button className="flex-1" onClick={onClose}>
            我已了解
          </Button>
        </div>
      </motion.div>
    </motion.div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { HomepageEntry } from '@shared/types'
import { Button, Icon, LoadingState } from './ui'

/** 运行前的判定流程所处阶段。 */
type GateState = 'checking' | 'confirm' | 'externals' | 'reject' | 'mismatch' | 'incompatible' | 'error'

/** 比较语义化版本：current 低于 required 时返回 true。 */
function olderThan(current: string, required: string): boolean {
  const a = current.split(/[.\-+]/).map((x) => parseInt(x, 10))
  const b = required.split(/[.\-+]/).map((x) => parseInt(x, 10))
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = Number.isFinite(a[i]) ? a[i] : 0
    const y = Number.isFinite(b[i]) ? b[i] : 0
    if (x !== y) return x < y
  }
  return false
}

/**
 * 主页脚本运行前的安全闸门：联网核对编号 + SHA256，并落实三级安全策略。
 *
 *   - 静态检测命中「拒绝」规则 → 直接拒绝，只能关闭；
 *   - 编号哈希不一致（脚本被改动）→ 拒绝运行；
 *   - 命中「警告」（存在外部服务地址）→ 逐条写明有什么，用户确认后才放行；
 *   - 有编号且联网校验一致 → 直接通过；
 *   - 无编号 / 服务端不可达 → 本地检测 + 首次确认。
 */
export function HomepageGate({
  id,
  onApproved,
  onCancel,
  cancelLabel = '取消'
}: {
  id: string
  /** 通过全部检查后回调；参数为最新条目。 */
  onApproved: (entry: HomepageEntry) => void
  onCancel: () => void
  cancelLabel?: string
}): JSX.Element {
  const [state, setState] = useState<GateState>('checking')
  const [entry, setEntry] = useState<HomepageEntry | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  // onApproved 常为内联闭包：用 ref 固定引用，避免父组件重渲染触发重复校验。
  const approvedRef = useRef(onApproved)
  useEffect(() => {
    approvedRef.current = onApproved
  })

  const run = useCallback(async (): Promise<void> => {
    setState('checking')
    setMessage('')
    try {
      const res = await window.api.homepage.verify(id)
      const e = res.entry
      setEntry(e)
      setMessage(res.message)
      if (e.risk.level === 'reject') return setState('reject')
      if (e.verify === 'mismatch') return setState('mismatch')
      // 脚本要求的最低启动器版本高于当前版本：直接拒绝，避免未知行为。
      if (e.meta.minLauncher) {
        const version = await window.api.getVersion()
        if (olderThan(version, e.meta.minLauncher)) {
          setMessage(`该脚本要求启动器版本不低于 ${e.meta.minLauncher}，当前版本为 ${version}`)
          return setState('incompatible')
        }
      }
      // 外部服务地址必须逐条告知并获得用户同意，与编号校验彼此独立。
      if (e.risk.level === 'warn' && !e.networkApproved) return setState('externals')
      if (res.reachable && e.verify === 'verified') return approvedRef.current(e)
      if (e.confirmed) return approvedRef.current(e)
      setState('confirm')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
      setState('error')
    }
  }, [id])

  useEffect(() => {
    void run()
  }, [run])

  const approve = async (network: boolean): Promise<void> => {
    setBusy(true)
    try {
      const next = await window.api.homepage.confirm(id, network)
      onApproved(next)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
      setState('error')
    } finally {
      setBusy(false)
    }
  }

  const risk = entry?.risk
  const externals = risk?.externals ?? []

  const rejected = state === 'reject' || state === 'mismatch' || state === 'incompatible'
  const title =
    state === 'reject'
      ? '已拒绝运行'
      : state === 'mismatch'
        ? '脚本已被改动'
        : state === 'incompatible'
          ? '启动器版本过低'
          : state === 'externals'
            ? '该脚本会连接外部服务'
            : state === 'confirm'
              ? '首次运行确认'
              : state === 'error'
                ? '无法完成安全检查'
                : '正在安全检查'
  const subtitle =
    state === 'reject'
      ? '检测到危险代码，无法运行'
      : state === 'mismatch'
        ? '编号与脚本哈希不一致'
        : state === 'incompatible'
          ? '请升级启动器后再使用该脚本'
          : state === 'externals'
            ? '确认后才会允许联网'
            : state === 'confirm'
              ? '该脚本没有可用编号'
              : state === 'error'
                ? '请重试或关闭'
                : '正在联网核对编号与 SHA256'

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[120] flex items-center justify-center p-6"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} />
        <motion.div
          className="glass-strong relative z-10 flex max-h-[80vh] w-full max-w-lg flex-col rounded-[28px] p-6"
          initial={{ scale: 0.95, opacity: 0, y: 16 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.96, opacity: 0, y: 12 }}
          transition={{ type: 'spring', bounce: 0.16, duration: 0.45 }}
        >
          <div className="mb-3 flex items-center gap-3">
            <div
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-white"
              style={{ background: rejected ? 'var(--fill-danger)' : 'var(--fill-primary)' }}
            >
              <Icon name={rejected ? 'xmark' : state === 'externals' ? 'link' : 'check'} size={22} />
            </div>
            <div className="min-w-0">
              <h2 className="title">{title}</h2>
              <p className="caption">{subtitle}</p>
            </div>
          </div>

          {state === 'checking' ? (
            <LoadingState text="正在安全检查…" />
          ) : (
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
              {entry && (
                <div className="glass-soft flex items-center justify-between gap-3 rounded-2xl px-3.5 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-semibold">{entry.meta.name || entry.id}</div>
                    <div className="caption truncate">
                      {entry.meta.author ? `${entry.meta.author} · ` : ''}
                      {entry.meta.id ? `编号 ${entry.meta.id}` : '无编号'}
                    </div>
                  </div>
                  <span className="chip shrink-0">SHA256 {entry.sha256.slice(0, 8)}</span>
                </div>
              )}

              {message && <p className="caption selectable">{message}</p>}

              {state === 'reject' && (
                <div>
                  <div className="mb-1.5 text-[13px] font-semibold">命中的危险规则</div>
                  <ul className="space-y-1.5">
                    {(risk?.blocks ?? []).map((b, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-2 rounded-xl px-3 py-2 text-[12.5px] leading-relaxed"
                        style={{ background: 'rgba(255,69,58,0.12)' }}
                      >
                        <span className="mt-0.5 shrink-0" style={{ color: 'var(--fill-danger)' }}>
                          <Icon name="xmark" size={14} />
                        </span>
                        <span className="selectable break-all">{b}</span>
                      </li>
                    ))}
                    {(risk?.blocks ?? []).length === 0 && <li className="caption">检测到危险特征。</li>}
                  </ul>
                </div>
              )}

              {state === 'externals' && (
                <div>
                  <div className="mb-1.5 text-[13px] font-semibold">将访问以下外部地址（{externals.length}）</div>
                  <ul className="space-y-1.5">
                    {externals.map((x, i) => (
                      <li key={i} className="rounded-xl px-3 py-2" style={{ background: 'var(--fill-secondary)' }}>
                        <div className="text-[12px] font-semibold opacity-70">{x.kind}</div>
                        <div className="selectable break-all text-[12.5px]">{x.url}</div>
                      </li>
                    ))}
                  </ul>
                  <p className="caption mt-2">
                    允许后仅放宽网络访问（connect-src / img-src），脚本仍运行在无同源、无本地文件权限的沙箱中。
                  </p>
                </div>
              )}

              {state === 'confirm' && (
                <p className="caption">
                  该脚本没有服务端编号，无法联网核对哈希。本地静态检测已通过（未发现删除文件、格式化、下载可执行文件等危险行为），
                  但无法确认作者与内容来源。首次运行需要你确认；脚本内容一旦被改动，确认会自动失效。
                </p>
              )}
            </div>
          )}

          <div className="mt-5 flex gap-2">
            {rejected || state === 'error' ? (
              <>
                <Button className="flex-1" onClick={onCancel}>
                  关闭
                </Button>
                {state === 'error' && (
                  <Button variant="primary" className="flex-1" onClick={() => void run()}>
                    重试
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button className="flex-1" onClick={onCancel} disabled={busy}>
                  {cancelLabel}
                </Button>
                <Button
                  variant="primary"
                  className="flex-1"
                  disabled={busy || state === 'checking'}
                  onClick={() => void approve(state === 'externals')}
                >
                  {state === 'externals' ? '允许并运行' : '确认并运行'}
                </Button>
              </>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

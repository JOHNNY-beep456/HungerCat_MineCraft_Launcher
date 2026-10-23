import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { VersionDirInstance } from '@shared/types'
import { allVersionDirs, useApp, versionDirLabel } from '../store'
import { useRuntime, useRuntimeActions } from '../runtime'
import { Button, Select } from './ui'

/**
 * 整合包导入确认框（实例名 + 目标版本目录）。
 *
 * 为什么挂在 Shell 层、读全局的 `modpackPending`：
 * 整合包的「下载 + 解析」动辄几十秒，用户完全可能在这期间切到别的页面。以前这份
 * 待导入状态挂在「资源下载 → 项目详情」的组件里，页面一卸载就随组件一起丢掉 ——
 * 下载完成后弹窗再也不会出现，用户看到的现象就是「切了个页面，安装就没反应了」。
 *
 * 放在 Shell 层后，弹窗与当前在哪个页面无关；确认 / 取消都会清掉全局状态。
 */
export function ModpackImportDialog(): JSX.Element {
  const { t } = useApp()
  const { settings } = useApp()
  const { modpackPending } = useRuntime()
  const { clearModpackPending } = useRuntimeActions()

  const [name, setName] = useState('')
  const [dirId, setDirId] = useState('')
  const [installed, setInstalled] = useState<VersionDirInstance[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** 安装成功后的实例名；非空表示切到「完成」状态。 */
  const [done, setDone] = useState('')

  const dirOptions = useMemo(
    () => allVersionDirs(settings).map((d) => ({ value: d.id, label: versionDirLabel(d) })),
    [settings]
  )
  const targetDirId = dirId || settings.selectedVersionDirId || 'default'

  // 每次接到新的待导入整合包：清空上一轮状态，并拉一次已安装列表（用于重名判断与默认名）。
  useEffect(() => {
    if (!modpackPending) return
    setError('')
    setDone('')
    setDirId('')
    setName(modpackPending.probe.name)
    let alive = true
    void window.api.installed
      .listAll()
      .then(
        (list) => {
          if (!alive) return
          setInstalled(list)
          setName(uniqueInstanceName(modpackPending.probe.name, modpackPending.probe.mcVersion, list))
        },
        () => {
          /* 拉不到已安装列表：沿用整合包自带的名字，重名交给主进程判定 */
        }
      )
    return () => {
      alive = false
    }
  }, [modpackPending])

  const nameTaken =
    name.trim() !== '' && installed.some((ins) => ins.dirId === targetDirId && ins.id === name.trim())

  const confirm = async (): Promise<void> => {
    if (!modpackPending || !name.trim()) return
    setBusy(true)
    setError('')
    try {
      await window.api.modpack.import(modpackPending.temp, name.trim(), targetDirId)
      setDone(name.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AnimatePresence>
      {modpackPending && (
        <motion.div
          className="fixed inset-0 z-[128] flex items-center justify-center p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div
            className="absolute inset-0"
            style={{ background: 'var(--scrim)' }}
            onClick={() => {
              if (!busy) clearModpackPending()
            }}
          />
          <motion.div
            className="glass-strong relative z-10 w-full max-w-sm rounded-[28px] p-6"
            initial={{ scale: 0.94, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0, y: 12 }}
            transition={{ type: 'spring', bounce: 0.18, duration: 0.4 }}
          >
            {done ? (
              <>
                <h2 className="title mb-1">{t('res.modpack.doneTitle')}</h2>
                <p className="caption mb-5">{t('res.modpackInstalled', { name: done })}</p>
                <Button variant="primary" className="w-full" onClick={clearModpackPending}>
                  {t('res.modpack.close')}
                </Button>
              </>
            ) : (
              <>
                <h2 className="title mb-1">{t('res.modpack.title')}</h2>
                <p className="caption mb-4">{t('res.modpack.desc', { name: modpackPending.probe.name })}</p>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && name.trim() && !nameTaken && !busy) void confirm()
                  }}
                  placeholder={t('res.modpack.namePlaceholder')}
                  className="input mb-3 w-full"
                  disabled={busy}
                />
                <div className="caption mb-2">{t('res.modpack.installDir')}</div>
                <Select value={targetDirId} onChange={setDirId} className="mb-5 w-full" options={dirOptions} disabled={busy} />
                {nameTaken && (
                  <p className="mb-4 -mt-3 text-[12px]" style={{ color: 'var(--fill-danger)' }}>
                    {t('res.modpack.nameTaken', { name: name.trim() })}
                  </p>
                )}
                {error && (
                  <p className="mb-4 text-[12px]" style={{ color: 'var(--fill-danger)' }}>
                    {t('res.installFailed', { msg: error })}
                  </p>
                )}
                <div className="flex gap-2">
                  <Button className="flex-1" disabled={busy} onClick={clearModpackPending}>
                    {t('res.cancel')}
                  </Button>
                  <Button
                    variant="primary"
                    className="flex-1"
                    disabled={!name.trim() || nameTaken || busy}
                    onClick={() => void confirm()}
                  >
                    {busy ? t('res.installing') : t('res.install')}
                  </Button>
                </div>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** 取一个在当前版本目录里不重名的实例名（同名就追加 -2、-3…）。 */
function uniqueInstanceName(base: string, mcVersion: string | undefined, installed: VersionDirInstance[]): string {
  const taken = (n: string): boolean => installed.some((ins) => ins.id === n) || (!!mcVersion && mcVersion === n)
  if (!taken(base)) return base
  for (let i = 2; i < 10000; i++) {
    const cand = `${base}-${i}`
    if (!taken(cand)) return cand
  }
  return `${base}-${Date.now()}`
}

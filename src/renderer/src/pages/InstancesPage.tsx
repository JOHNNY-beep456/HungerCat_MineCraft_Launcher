import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { InstalledVersion, ModpackProbe } from '@shared/types'
import { useApp } from '../store'
import { useRuntimeActions } from '../runtime'
import { Button, Icon, LoadingState, Spinner } from '../components/ui'

export function InstancesPage({ onManage }: { onManage: (versionId: string) => void }): JSX.Element {
  const { settings, selectedAccount } = useApp()
  const { launch } = useRuntimeActions()
  const [installed, setInstalled] = useState<InstalledVersion[] | null>(null)
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState<string | null>(null)
  const [renameProbe, setRenameProbe] = useState<{ probe: ModpackProbe; filePath: string } | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [dragOver, setDragOver] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setInstalled(await window.api.installed.list())
    } catch {
      /* installed:list 失败时保持上次列表 */
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    return window.api.modpack.onProgress((p) => {
      if (p.phase === 'done') {
        setImportMsg(null)
        setImporting(false)
        void refresh()
      } else {
        setImporting(true)
        setImportMsg(p.task)
      }
    })
  }, [refresh])

  const doLaunch = (versionId: string, opts?: { world?: string; server?: string }): void => {
    if (!selectedAccount) return
    void launch({
      versionId,
      accountId: selectedAccount.id,
      gameDir: settings.gameDir,
      memoryMb: settings.memoryMb,
      javaPath: settings.javaPath || undefined,
      quickPlaySingleplayer: opts?.world,
      quickPlayMultiplayer: opts?.server
    })
  }

  const renameTaken =
    renameProbe !== null && renameValue.trim() !== '' && (installed ?? []).some((v) => v.id === renameValue.trim())

  // 在既有实例中取一个不重名、且不等于其 MC 版本号的实例名
  // （避免打开弹窗时默认值被占用、导入按钮置灰，或与版本号同名时静默合并进原版）。
  const uniqueInstanceName = (base: string, mcVersion?: string): string => {
    const list = installed ?? []
    const taken = (n: string): boolean => list.some((v) => v.id === n) || (!!mcVersion && mcVersion === n)
    if (!taken(base)) return base
    for (let i = 2; i < 10000; i++) {
      const cand = `${base}-${i}`
      if (!taken(cand)) return cand
    }
    return `${base}-${Date.now()}`
  }

  const beginImport = async (filePath: string): Promise<void> => {
    if (!filePath) return
    setImportMsg(null)
    try {
      const probe = await window.api.modpack.probe(filePath)
      // 总是弹出弹窗，让用户自定义实例名（默认取不重名的实例名，可再手动修改）
      setRenameProbe({ probe, filePath })
      setRenameValue(uniqueInstanceName(probe.name, probe.mcVersion))
    } catch (err) {
      setImportMsg(`导入失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const confirmImport = async (): Promise<void> => {
    if (!renameProbe) return
    const name = renameValue.trim()
    if (!name) return
    if ((installed ?? []).some((v) => v.id === name)) {
      setImportMsg(`实例名「${name}」已存在，请更换`)
      return
    }
    const probe = renameProbe.probe
    const filePath = renameProbe.filePath
    setRenameProbe(null)
    try {
      await window.api.modpack.import(filePath, name)
    } catch (err) {
      setImportMsg(`导入失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const pickImport = async (): Promise<void> => {
    const p = await window.api.shell.pickFile([{ name: '整合包', extensions: ['mrpack', 'zip'] }])
    if (p) await beginImport(p)
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    const path = window.api.shell.getPathForFile(file)
    if (path) void beginImport(path)
  }

  return (
    <div
      className="flex h-full flex-col gap-5"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="flex items-end justify-between">
        <div>
          <h1 className="display">实例</h1>
          <p className="caption mt-1">管理已安装版本；拖入 .mrpack / .zip 整合包即可导入</p>
        </div>
        <div className="flex gap-2">
          <Button icon="refresh" onClick={() => void refresh()}>
            刷新
          </Button>
          <Button variant="primary" icon="download" onClick={() => void pickImport()} disabled={importing}>
            {importing ? '导入中…' : '导入整合包'}
          </Button>
        </div>
      </div>

      {importMsg && (
        <div className="glass-soft flex items-center gap-2 rounded-2xl px-4 py-3 text-[13px]">
          <Spinner size={15} />
          <span className="truncate">{importMsg}</span>
        </div>
      )}

      <div
        className={`min-h-0 flex-1 overflow-y-auto rounded-[24px] pr-1 transition-opacity ${dragOver ? 'opacity-70' : ''}`}
      >
        {installed === null ? (
          <LoadingState text="正在获取已安装版本…" />
        ) : installed.length === 0 ? (
          <div className="glass flex items-center gap-3 rounded-[24px] p-5">
            <Icon name="cube" size={20} className="opacity-50" />
            <div>
              <div className="headline">还没有安装任何版本</div>
              <div className="caption">可拖入整合包文件，或点击右上角「导入整合包」</div>
            </div>
          </div>
        ) : (
          <div className="space-y-3 pb-4">
            {installed.map((v) => (
              <InstanceCard
                key={v.id}
                v={v}
                gameDir={settings.gameDir}
                canLaunch={!!selectedAccount}
                onManage={() => onManage(v.id)}
                onLaunch={doLaunch}
              />
            ))}
          </div>
        )}
      </div>

      {/* 重命名弹窗（文件夹名冲突） */}
      <AnimatePresence>
        {renameProbe && (
          <motion.div
            className="absolute inset-0 z-50 flex items-center justify-center p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={() => setRenameProbe(null)} />
            <motion.div
              className="glass-strong relative z-10 w-full max-w-sm rounded-[28px] p-6"
              initial={{ scale: 0.94, opacity: 0, y: 12 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.94, opacity: 0, y: 12 }}
              transition={{ type: 'spring', bounce: 0.18, duration: 0.4 }}
            >
              <h2 className="title mb-1">设置实例名</h2>
              <p className="caption mb-4">
                整合包「{renameProbe.probe.name}」，请输入实例名（不能与已有实例重名）：
              </p>
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && renameValue.trim() && !renameTaken && void confirmImport()}
                placeholder="实例名"
                className="input mb-5 w-full"
              />
              {renameTaken && (
                <p className="mb-4 -mt-3 text-[12px]" style={{ color: 'var(--fill-danger)' }}>
                  实例名「{renameValue.trim()}」已存在
                </p>
              )}
              <div className="flex gap-2">
                <Button className="flex-1" onClick={() => setRenameProbe(null)}>
                  取消
                </Button>
                <Button variant="primary" className="flex-1" disabled={!renameValue.trim() || renameTaken} onClick={() => void confirmImport()}>
                  导入
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function InstanceCard({
  v,
  gameDir,
  canLaunch,
  onManage,
  onLaunch
}: {
  v: InstalledVersion
  gameDir: string
  canLaunch: boolean
  onManage: () => void
  onLaunch: (versionId: string, opts?: { world?: string; server?: string }) => void
}): JSX.Element {
  return (
    <div className="glass rounded-[24px] p-4">
      <div className="flex items-center gap-3">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white"
          style={{ background: 'linear-gradient(135deg,#30d158,#0a84ff)' }}
        >
          <Icon name="cube" size={19} />
        </div>
        <button className="group min-w-0 flex-1 text-left no-drag" onClick={onManage} title="进入实例管理">
          <div className="truncate text-[15px] font-semibold group-hover:underline">{v.id}</div>
          <div className="caption">
            {v.mcVersion}
            {v.loader ? ` · ${loaderLabel(v.loader)}` : ''} · {v.worlds.length} 存档 · {v.servers.length} 服务器
          </div>
        </button>
        <Button size="sm" icon="settings" onClick={onManage} title="进入实例管理">
          管理
        </Button>
        <Button size="sm" icon="folder" onClick={() => void window.api.shell.openPath(gameDir)} title="打开游戏目录">
          目录
        </Button>
        <Button size="sm" variant="primary" icon="play" disabled={!canLaunch} onClick={() => onLaunch(v.id)}>
          启动
        </Button>
      </div>

      {(v.worlds.length > 0 || v.servers.length > 0) && (
        <div className="mt-3 space-y-2 border-t pt-3" style={{ borderColor: 'var(--divider)' }}>
          {v.worlds.map((w) => (
            <QuickRow key={`w-${w}`} label={`${v.id} - ${w}`} icon="home" onPlay={() => onLaunch(v.id, { world: w })} />
          ))}
          {v.servers.map((s) => (
            <QuickRow key={`s-${s.address}`} label={`${v.id} - ${s.name}`} icon="link" onPlay={() => onLaunch(v.id, { server: s.address })} />
          ))}
        </div>
      )}
    </div>
  )
}

function QuickRow({ label, icon, onPlay }: { label: string; icon: string; onPlay: () => void }): JSX.Element {
  return (
    <div className="glass-soft flex items-center gap-2 rounded-xl px-3 py-2">
      <Icon name={icon} size={15} className="shrink-0 opacity-60" />
      <span className="min-w-0 flex-1 truncate text-[13px]">{label}</span>
      <button
        onClick={onPlay}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white transition-transform active:scale-90 no-drag"
        style={{ background: 'var(--fill-primary)' }}
        title="一键启动"
      >
        <Icon name="play" size={14} />
      </button>
    </div>
  )
}

function loaderLabel(loader: string | null): string {
  if (!loader) return '原版'
  return loader.charAt(0).toUpperCase() + loader.slice(1)
}

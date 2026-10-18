import { useEffect, useMemo, useState } from 'react'
import type { JavaRuntime } from '@shared/types'
import { instanceJavaPath } from '@shared/settings'
import { useApp } from '../../store'
import { Button, Select } from '../../components/ui'
import { Row } from './shared'

/** 版本设置与目录操作板块：Java、重命名、禁用、启动、打开目录、导出整合包、删除实例。 */
export function VersionPanel({
  versionId,
  disabled,
  deleting,
  renaming,
  renameValue,
  renameError,
  onRenameValueChange,
  onRename,
  onToggleDisabled,
  onLaunch,
  onExport,
  onDeleteRequest
}: {
  versionId: string
  disabled: boolean
  deleting: boolean
  renaming: boolean
  renameValue: string
  renameError: string | null
  onRenameValueChange: (v: string) => void
  onRename: () => void
  onToggleDisabled: () => void
  onLaunch: () => void
  onExport: () => void
  onDeleteRequest: () => void
}): JSX.Element {
  const { t, settings, updateSettings, selectedAccount, openFileManager } = useApp()
  const instanceJava = instanceJavaPath(settings, versionId)

  const [javas, setJavas] = useState<JavaRuntime[]>([])
  const [picking, setPicking] = useState(false)
  const [pickError, setPickError] = useState<string | null>(null)

  // 已检测到的 Java 与设置页共用同一份来源（含各版本目录下自带的运行时）。
  useEffect(() => {
    void window.api.java
      .detect()
      .then(setJavas)
      .catch(() => {
        /* 检测失败就只显示「跟随全局设置」与手动选择，不阻塞设置 */
      })
  }, [])

  /** 写入 / 清除本实例的 Java 覆盖。空串表示「跟随全局设置」。 */
  const setInstanceJava = (path: string): void => {
    const next = { ...(settings.versionJava ?? {}) }
    if (path) next[versionId] = path
    else delete next[versionId]
    void updateSettings({ versionJava: next })
  }

  const browse = async (): Promise<void> => {
    setPickError(null)
    setPicking(true)
    try {
      const jr = await window.api.java.pick()
      if (!jr) return
      setJavas((prev) => (prev.some((j) => j.path === jr.path) ? prev : [...prev, jr]))
      setInstanceJava(jr.path)
    } catch (err) {
      setPickError(err instanceof Error ? err.message : String(err))
    } finally {
      setPicking(false)
    }
  }

  const javaOptions = useMemo(() => {
    const globalNote = settings.javaAutoDetect
      ? t('ins.javaGlobalAuto')
      : settings.javaPath || t('ins.javaGlobalNone')
    const opts: Array<{ value: string; label: string; note?: string }> = [
      { value: '', label: t('ins.javaFollowGlobal'), note: globalNote }
    ]
    for (const j of javas) {
      opts.push({
        value: j.path,
        label: `Java ${j.major} · ${j.vendor ?? t('settings.java.unknown')} · ${
          j.is64Bit ? t('settings.java.arch64') : t('settings.java.arch32')
        }`,
        note: j.path
      })
    }
    // 手动选过、但这次没被自动检测到的路径也要能显示出来（例如装在自定义目录里）。
    if (instanceJava && !javas.some((j) => j.path === instanceJava)) {
      opts.push({ value: instanceJava, label: t('ins.javaUnavailable'), note: instanceJava })
    }
    return opts
  }, [javas, instanceJava, settings.javaAutoDetect, settings.javaPath, t])

  return (
    <div className="space-y-3">
      <div className="glass-soft rounded-2xl p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[14px] font-medium">{t('ins.javaRuntime')}</div>
            <div className="caption mt-0.5">{t('ins.javaRuntimeDesc')}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Select
              className="w-[240px]"
              value={instanceJava ?? ''}
              onChange={setInstanceJava}
              options={javaOptions}
            />
            <Button size="sm" icon="folder" disabled={picking} onClick={() => void browse()}>
              {t('ins.javaBrowse')}
            </Button>
          </div>
        </div>
        {pickError && (
          <div className="mt-2 text-[12px]" style={{ color: 'var(--fill-danger)' }}>
            {pickError}
          </div>
        )}
      </div>
      <div className="glass-soft rounded-2xl p-4">
        <div className="text-[14px] font-medium">{t('ins.renameVersion')}</div>
        <div className="caption mt-0.5">{t('ins.renameVersionDesc')}</div>
        <div className="mt-3 flex gap-2">
          <input
            value={renameValue}
            onChange={(e) => onRenameValueChange(e.target.value)}
            onKeyDown={(e) =>
              e.key === 'Enter' &&
              !renaming &&
              renameValue.trim() &&
              renameValue.trim() !== versionId &&
              void onRename()
            }
            placeholder={t('ins.newInstanceNamePlaceholder')}
            className="input flex-1"
            disabled={renaming}
          />
          <Button
            size="sm"
            variant="primary"
            disabled={renaming || !renameValue.trim() || renameValue.trim() === versionId}
            onClick={() => void onRename()}
          >
            {renaming ? t('ins.renaming') : t('ins.rename')}
          </Button>
        </div>
        {renameError && (
          <div className="mt-2 text-[12px]" style={{ color: 'var(--fill-danger)' }}>
            {renameError}
          </div>
        )}
      </div>
      <Row label={t('ins.disableVersion')} desc={t('ins.disableVersionDesc')}>
        <Button size="sm" variant={disabled ? 'primary' : 'secondary'} onClick={() => void onToggleDisabled()}>
          {disabled ? t('ins.enable') : t('ins.disable')}
        </Button>
      </Row>
      <Row label={t('ins.launchGame')}>
        <Button size="sm" variant="primary" icon="play" disabled={!selectedAccount || disabled} onClick={() => onLaunch()}>
          {t('ins.launch')}
        </Button>
      </Row>
      <Row label={t('ins.openVersionDir')}>
        <Button
          size="sm"
          icon="folder"
          onClick={() => void window.api.manage.openDir(versionId, 'version').then(openFileManager)}
        >
          {t('ins.open')}
        </Button>
      </Row>
      <Row label={t('ins.exportModpack')} desc={t('ins.exportModpackDesc')}>
        <Button size="sm" icon="box" onClick={() => onExport()}>
          {t('ins.exportModpack')}
        </Button>
      </Row>
      <Row label={t('ins.deleteVersion')} desc={t('ins.deleteVersionDesc')}>
        <Button size="sm" variant="danger" icon="trash" disabled={deleting} onClick={() => onDeleteRequest()}>
          {deleting ? t('ins.deleting') : t('ins.delete')}
        </Button>
      </Row>
    </div>
  )
}

import { useApp } from '../../store'
import { Button } from '../../components/ui'
import { Row } from './shared'

/** 版本设置与目录操作板块：重命名、禁用、启动、打开目录、导出整合包、删除实例。 */
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
  const { t, selectedAccount, openFileManager } = useApp()
  return (
    <div className="space-y-3">
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

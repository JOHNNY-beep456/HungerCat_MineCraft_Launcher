import { useApp } from '../../store'
import { Button } from '../../components/ui'
import { loaderLabel } from './shared'

/** 实例管理页顶部：返回、标题（版本名 + 禁用后缀 + 加载器）、启动按钮。 */
export function InstanceHeader({
  versionId,
  disabled,
  loader,
  onBack,
  onLaunch
}: {
  versionId: string
  disabled: boolean
  loader: string | null | undefined
  onBack: () => void
  onLaunch: () => void
}): JSX.Element {
  const { t, selectedAccount } = useApp()
  return (
    <div className="flex items-center gap-3">
      <Button size="sm" icon="chevronLeft" onClick={onBack}>
        {t('ins.back')}
      </Button>
      <div className="min-w-0 flex-1">
        <h1 className="display truncate">{t('ins.manageTitle')}</h1>
        <p className="caption mt-1 selectable truncate">
          {versionId}
          {disabled ? t('ins.disabledSuffix') : ''}
          {loader ? ` · ${loaderLabel(loader)}` : ''}
        </p>
      </div>
      <Button size="sm" icon="play" disabled={!selectedAccount || disabled} onClick={onLaunch}>
        {t('ins.launch')}
      </Button>
    </div>
  )
}

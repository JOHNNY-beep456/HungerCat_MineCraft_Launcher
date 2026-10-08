import { useApp } from '../../store'
import { Button, Segmented, Spinner } from '../../components/ui'
import type { ResFilter } from './types'

/** 资源筛选栏：全部 / 已启用 / 已禁用 / 可更新 + 后台更新检测状态。 */
export function ResourceFilterBar({
  resFilter,
  onResFilterChange,
  filterOptions,
  checking,
  checkedCount,
  onRecheck
}: {
  resFilter: ResFilter
  onResFilterChange: (v: ResFilter) => void
  filterOptions: Array<{ value: ResFilter; label: string }>
  checking: boolean
  checkedCount: number
  onRecheck: () => void
}): JSX.Element {
  const { t } = useApp()
  return (
    <div className="glass-soft flex flex-wrap items-center gap-2 rounded-2xl px-3 py-2">
      <Segmented value={resFilter} onChange={onResFilterChange} options={filterOptions} />
      <span className="ml-auto flex items-center gap-2">
        {checking ? (
          <>
            <Spinner size={14} />
            <span className="caption">{t('ins.checkingUpdates', { n: checkedCount })}</span>
          </>
        ) : (
          <Button size="sm" icon="refresh" onClick={onRecheck}>
            {t('ins.checkUpdates')}
          </Button>
        )}
      </span>
    </div>
  )
}

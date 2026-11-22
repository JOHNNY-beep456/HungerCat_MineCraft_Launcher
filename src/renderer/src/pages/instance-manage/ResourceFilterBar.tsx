import { useApp } from '../../store'
import { Button, Checkbox, Segmented, Spinner } from '../../components/ui'
import type { ResFilter } from './types'

/**
 * 资源筛选栏：全部 / 已启用 / 已禁用 / 可更新 + 后台更新检测状态。
 *
 * 切到「可更新」后可批量勾选：全选框、已选计数、「更新所选」与「全部更新」。
 * 批量执行中把按钮换成进度，避免重复触发（后端按根目录串行写，重复点击只会排队）。
 */
export function ResourceFilterBar({
  resFilter,
  onResFilterChange,
  filterOptions,
  checking,
  checkedCount,
  onRecheck,
  updatableCount,
  selectedCount,
  allSelected,
  batch,
  onToggleAll,
  onUpdateSelected,
  onUpdateAll
}: {
  resFilter: ResFilter
  onResFilterChange: (v: ResFilter) => void
  filterOptions: Array<{ value: ResFilter; label: string }>
  checking: boolean
  checkedCount: number
  onRecheck: () => void
  updatableCount: number
  selectedCount: number
  allSelected: boolean
  batch: { done: number; total: number } | null
  onToggleAll: (next: boolean) => void
  onUpdateSelected: () => void
  onUpdateAll: () => void
}): JSX.Element {
  const { t } = useApp()
  // 批量执行中即使用户切走分栏也要保留进度入口，否则看不到正在跑的任务。
  const showBatchBar = updatableCount > 0 && (resFilter === 'updatable' || batch !== null)
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
      {showBatchBar && (
        <div
          className="flex w-full flex-wrap items-center gap-2 border-t pt-2"
          style={{ borderColor: 'var(--divider)' }}
        >
          <Checkbox
            checked={allSelected}
            indeterminate={selectedCount > 0 && !allSelected}
            onChange={onToggleAll}
            disabled={batch !== null}
          />
          <span className="caption">{t('ins.selectedCount', { n: selectedCount })}</span>
          <span className="ml-auto flex items-center gap-2">
            {batch ? (
              <>
                <Spinner size={14} />
                <span className="caption">{t('ins.batchUpdating', { done: batch.done, total: batch.total })}</span>
              </>
            ) : (
              <>
                <Button size="sm" disabled={selectedCount === 0} onClick={onUpdateSelected}>
                  {t('ins.updateSelected', { n: selectedCount })}
                </Button>
                <Button size="sm" variant="primary" icon="refresh" onClick={onUpdateAll}>
                  {t('ins.updateAll', { n: updatableCount })}
                </Button>
              </>
            )}
          </span>
        </div>
      )}
    </div>
  )
}

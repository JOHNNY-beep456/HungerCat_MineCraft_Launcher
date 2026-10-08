import type { SchematicEntry } from '@shared/types'
import { useApp } from '../../store'
import { Button, Icon } from '../../components/ui'
import { formatBytes } from './shared'

/** 投影 / 原理图板块：列出 .schematic 文件并支持删除。 */
export function SchematicsPanel({
  versionId,
  schematics,
  onReload
}: {
  versionId: string
  schematics: SchematicEntry[]
  onReload: () => void
}): JSX.Element {
  const { t, openFileManager } = useApp()
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="headline">{t('ins.schematicsCount', { n: schematics.length })}</span>
        <Button size="sm" icon="folder" onClick={() => void window.api.manage.openDir(versionId, 'schematics').then(openFileManager)}>
          {t('ins.openDir')}
        </Button>
      </div>
      {schematics.length === 0 ? (
        <div className="caption py-4 text-center opacity-60">
          {t('ins.noSchematics')}
        </div>
      ) : (
        schematics.map((s) => (
          <div key={s.path} className="glass-soft flex items-center gap-2 rounded-xl px-3 py-2">
            <Icon name="box" size={15} className="opacity-60" />
            <span className="min-w-0 flex-1 truncate text-[13px]">{s.name}</span>
            <span className="caption">{formatBytes(s.size)}</span>
            <button
              onClick={async () => {
                await window.api.manage.deleteFile(s.path)
                void onReload()
              }}
              className="no-drag opacity-50 hover:opacity-100"
            >
              <Icon name="trash" size={15} />
            </button>
          </div>
        ))
      )}
    </div>
  )
}

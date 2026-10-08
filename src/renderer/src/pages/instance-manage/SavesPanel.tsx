import { useApp } from '../../store'
import { Button, Icon } from '../../components/ui'

/** 世界 / 存档板块：列出存档，支持直接进入某个世界与删除。 */
export function SavesPanel({
  versionId,
  worlds,
  onLaunchWorld,
  onReload
}: {
  versionId: string
  worlds: string[]
  onLaunchWorld: (world: string) => void
  onReload: () => void
}): JSX.Element {
  const { t, selectedAccount, openFileManager } = useApp()
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="headline">{t('ins.savesCount', { n: worlds.length })}</span>
        <Button size="sm" icon="folder" onClick={() => void window.api.manage.openDir(versionId, 'saves').then(openFileManager)}>
          {t('ins.openDir')}
        </Button>
      </div>
      {worlds.length === 0 ? (
        <div className="caption py-4 text-center opacity-60">{t('ins.noSaves')}</div>
      ) : (
        worlds.map((w) => (
          <div key={w} className="glass-soft flex items-center gap-2 rounded-xl px-3 py-2">
            <Icon name="home" size={15} className="opacity-60" />
            <span className="min-w-0 flex-1 truncate text-[13px]">{versionId} - {w}</span>
            <Button size="sm" icon="play" disabled={!selectedAccount} onClick={() => onLaunchWorld(w)}>
              {t('ins.launch')}
            </Button>
            <button
              onClick={async () => {
                await window.api.manage.deleteWorld(versionId, w)
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

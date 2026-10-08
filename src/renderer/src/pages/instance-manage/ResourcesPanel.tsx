import type { DragEvent } from 'react'
import type { ResourceFile, ResourceUpdateInfo } from '@shared/types'
import { useApp } from '../../store'
import { modListTitles } from '../../mod-title'
import { Button, Icon } from '../../components/ui'
import { formatBytes } from './shared'
import { OnlineInstaller } from './OnlineInstaller'

/**
 * 资源包 / 光影板块。
 *
 * 两者结构几乎一致（在线安装面板 + 拖拽导入 + 列表），差异只在目标目录、图标、
 * 删除接口与 Modrinth 默认链接上，故合并为一个按 variant 分支的组件。
 */
export function ResourcesPanel({
  variant,
  versionId,
  mcVersion,
  onMcVersionChange,
  shaderLoader,
  onShaderLoaderChange,
  dragOver,
  setDragOver,
  onResDrop,
  items,
  visibleItems,
  updates,
  busyId,
  onApplyUpdate,
  onReload,
  onInstalled,
  onInstallLocal
}: {
  variant: 'resourcepack' | 'shader'
  versionId: string
  mcVersion: string
  onMcVersionChange: (v: string) => void
  shaderLoader: string
  onShaderLoaderChange: (v: string) => void
  dragOver: boolean
  setDragOver: (v: boolean) => void
  onResDrop: (e: DragEvent<HTMLDivElement>, kind: 'resourcepacks' | 'shaderpacks') => void
  items: ResourceFile[]
  visibleItems: ResourceFile[]
  updates: Record<string, ResourceUpdateInfo>
  busyId: string | null
  onApplyUpdate: (up: ResourceUpdateInfo, enabled: boolean) => void
  onReload: () => void
  onInstalled: (message: string, ok: boolean) => void
  onInstallLocal: (paths: string[], kind: 'resourcepacks' | 'shaderpacks') => void
}): JSX.Element {
  const { t, settings, openFileManager } = useApp()
  const isShader = variant === 'shader'
  // 光影的目录名是 shaderpacks，资源包是 resourcepacks。
  const dirKind: 'resourcepacks' | 'shaderpacks' = isShader ? 'shaderpacks' : 'resourcepacks'

  return (
    <div className="space-y-3">
      {settings.mode !== 'local' && (
        <OnlineInstaller
          type={variant}
          versionId={versionId}
          mcVersion={mcVersion}
          onMcVersionChange={onMcVersionChange}
          loaders={isShader ? [
            { value: 'iris', label: 'Iris' },
            { value: 'optifine', label: 'OptiFine' }
          ] : []}
          loader={isShader ? shaderLoader : ''}
          onLoaderChange={isShader ? onShaderLoaderChange : undefined}
          onDone={onInstalled}
        />
      )}

      <div
        className={`rounded-2xl border-2 border-dashed p-5 text-center transition-colors ${dragOver ? 'opacity-80' : ''}`}
        style={{ borderColor: dragOver ? 'var(--fill-primary)' : 'var(--divider)' }}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => void onResDrop(e, dirKind)}
      >
        <Icon name="download" size={22} className="mx-auto mb-1 opacity-60" />
        <p className="text-[13px] opacity-80">{isShader ? t('ins.dropShaderFiles') : t('ins.dropResourceFiles')}</p>
        <Button
          size="sm"
          icon="folder"
          className="mt-2"
          onClick={async () => {
            const paths = await window.api.shell.pickFiles([
              { name: isShader ? t('ins.filterShaders') : t('ins.filterResourcepacks'), extensions: ['zip'] }
            ])
            if (paths.length > 0) await onInstallLocal(paths, dirKind)
          }}
        >
          {t('ins.selectLocalFiles')}
        </Button>
      </div>

      <div className="flex items-center justify-between">
        <span className="headline">
          {isShader ? t('ins.shadersCount', { n: items.length }) : t('ins.resourcepacksCount', { n: items.length })}
        </span>
        <Button
          size="sm"
          icon="folder"
          onClick={() =>
            void (isShader
              ? window.api.manage.openDir(versionId, 'shaderpacks')
              : window.api.resources.open(versionId, 'resourcepacks')
            ).then(openFileManager)
          }
        >
          {t('ins.openDir')}
        </Button>
      </div>
      {items.length === 0 ? (
        <div className="caption py-4 text-center opacity-60">
          {isShader ? t('ins.noShaders') : t('ins.noResourcepacks')}
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="caption py-4 text-center opacity-60">{t('ins.noUpdatable')}</div>
      ) : (
        visibleItems.map((p) => {
          const up = updates[p.path]
          const pair = modListTitles(p, settings.modTitleStyle)
          return (
            <div key={p.path} className="glass-soft flex items-center gap-2 rounded-xl px-3 py-2">
              {p.iconUrl ? (
                <img
                  src={p.iconUrl}
                  width={28}
                  height={28}
                  alt=""
                  draggable={false}
                  className="shrink-0 rounded-lg object-cover"
                />
              ) : (
                <Icon name={isShader ? 'palette' : 'image'} size={15} className="shrink-0 opacity-60" />
              )}
              <div className="min-w-0 flex-1" title={p.description ?? p.name}>
                <div className="truncate text-[13px] font-medium leading-tight">{pair.title}</div>
                {pair.detail && <div className="caption truncate leading-tight">{pair.detail}</div>}
              </div>
              {up && (
                <span className="caption shrink-0" title={`${up.title} · ${up.slug}`}>
                  {up.currentVersion
                    ? `${up.currentVersion} → ${up.latestVersion}`
                    : t('ins.updateTo', { version: up.latestVersion })}
                </span>
              )}
              <span className="caption">{formatBytes(p.size)}</span>
              {up && (
                <button
                  onClick={() => void onApplyUpdate(up, true)}
                  disabled={busyId === p.path}
                  className="mica no-drag shrink-0 rounded-lg px-2 py-1 text-[12px] font-medium"
                  style={{ color: 'var(--fill-primary)' }}
                >
                  {busyId === p.path ? t('ins.updating') : t('ins.update')}
                </button>
              )}
              {p.slug && (
                <button
                  type="button"
                  title={t('ins.openModrinthTitle')}
                  onClick={() =>
                    void window.api.shell.openExternal(
                      p.pageUrl ?? (isShader ? `https://modrinth.com/shader/${p.slug}` : `https://modrinth.com/resourcepack/${p.slug}`)
                    )
                  }
                  className="no-drag opacity-50 hover:opacity-100"
                >
                  <Icon name="link" size={15} />
                </button>
              )}
              <button
                onClick={async () => {
                  if (isShader) await window.api.manage.deleteFile(p.path)
                  else await window.api.resources.remove(p.path)
                  void onReload()
                }}
                className="no-drag opacity-50 hover:opacity-100"
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
          )
        })
      )}
    </div>
  )
}

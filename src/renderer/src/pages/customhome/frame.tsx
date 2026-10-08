// ---------------------------------------------------------------------------
// 渲染容器：按状态渲染加载态 / 错误态 / 安全闸门 / 沙箱 iframe。
// 只负责呈现，不承载任何装载或安全逻辑；装载与安全由外层组合根注入。
// ---------------------------------------------------------------------------

import type { RefObject } from 'react'
import type { HomepageEntry, HomepageSource } from '@shared/types'
import { useApp } from '../../store'
import { HomepageGate } from '../../components/HomepageGate'
import { LoadingState } from '../../components/ui'

export interface HomepageFrameProps {
  /** 主页条目；为 null 时显示加载态。 */
  entry: HomepageSource | null
  /** 读取条目失败时的错误信息；非空时显示错误态。 */
  error: string | null
  /** 已组装好的 iframe 源码。 */
  srcDoc: string
  /** 是否已通过安全闸门、可直接运行脚本。 */
  approved: boolean
  /** 承载脚本的 iframe 元素 ref（由组合根持有并共享给能力桥）。 */
  frameRef: RefObject<HTMLIFrameElement>
  /** 闸门放行回调。 */
  onApproved: (next: HomepageEntry) => void
  /** 闸门关闭 / 取消回调。 */
  onCancel: () => void
}

/** 「启动游戏」板块中自定义主页的渲染容器。 */
export function HomepageFrame({
  entry,
  error,
  srcDoc,
  approved,
  frameRef,
  onApproved,
  onCancel
}: HomepageFrameProps): JSX.Element {
  const { t } = useApp()

  if (error) {
    return (
      <div className="glass flex h-full flex-col items-center justify-center gap-3 rounded-[28px] p-10 text-center">
        <div className="headline">{t('ch.loadFailed')}</div>
        <p className="caption selectable max-w-md">{error}</p>
      </div>
    )
  }

  if (!entry) return <LoadingState text={t('ch.loading')} />

  return (
    <div className="relative h-full">
      {approved ? (
        <iframe
          ref={frameRef}
          title={entry.meta.name || t('ch.frameTitle')}
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          className="h-full w-full border-0 no-drag"
          style={{ background: 'transparent' }}
        />
      ) : (
        <HomepageGate
          id={entry.id}
          cancelLabel={t('ch.useBuiltin')}
          onApproved={onApproved}
          onCancel={onCancel}
        />
      )}
    </div>
  )
}

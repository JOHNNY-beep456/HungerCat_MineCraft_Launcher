// ---------------------------------------------------------------------------
// 主页会话守卫：启动时核对一次，运行期间占住主页文件。
//
// 放在 Shell 根上而不是主页组件里，有两个原因：
//   1. 校验必须「仅在启动时」发生一次——用户一开应用就停在启动游戏页，
//      但如果他直接切到别的页，挂在主页里的逻辑就永远不会跑；
//   2. 占用要覆盖整个运行期，而不是只在主页 iframe 显示的那几秒：
//      切走再切回来之间正是文件最容易被换掉的窗口。
//
// 不渲染任何界面；状态由侧栏图标的闪烁体现。
// ---------------------------------------------------------------------------

import { useEffect } from 'react'
import { useApp } from '../store'
import { ensureProbe, resetProbe, useHomepageProbe } from '../pages/customhome/probe'

export function HomepageSession(): null {
  const { settings } = useApp()
  const probe = useHomepageProbe()
  const id = settings.homepageId || ''

  useEffect(() => {
    if (!id) {
      resetProbe()
      void window.api.homepage.release().catch(() => undefined)
      return
    }
    // 整个进程只发这一次；失败也保持失败，不在导航时偷偷重试。
    void ensureProbe(id).catch(() => undefined)
  }, [id])

  useEffect(() => {
    if (!id || probe.id !== id || probe.phase !== 'ready' || !probe.sha256) return
    // 后端在持有句柄时会再核一次哈希；内容对不上就拒绝占用（也就不会放行）。
    void window.api.homepage.hold(id, probe.sha256).catch(() => undefined)
  }, [id, probe.id, probe.phase, probe.sha256])

  return null
}

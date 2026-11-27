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
import { bootStep } from '../startup'
import { ensureProbe, resetProbe, useHomepageProbe } from '../pages/customhome/probe'

export function HomepageSession(): null {
  const { settings, t } = useApp()
  const probe = useHomepageProbe()
  const id = settings.homepageId || ''

  useEffect(() => {
    if (!id) {
      resetProbe()
      void window.api.homepage.release().catch(() => undefined)
      return
    }
    // 整个进程只发这一次；失败也保持失败，不在导航时偷偷重试。
    //
    // 这一次**在载入遮罩里做完**：登记成启动步骤，`main.tsx` 会等到它结束（最长 3s）
    // 才撤骨架。以前用 `runWhenIdle` 推到首帧之后，结果是界面先出来、侧栏首页图标
    // 一边闪一边提示「正在核对」—— 用户看到的是「界面已经能用，却还有事没做完」。
    // 核对要读主页文件、算 SHA-256 再联网，放在遮罩背后正好，也不与首屏渲染抢主线程。
    const done = bootStep(t('boot.checkingHomepage'))
    let cancelled = false
    void ensureProbe(id)
      .catch(() => undefined)
      .finally(() => {
        // 换主页 / 卸载时也要释放这一步，否则遮罩会白等到超时。
        if (!cancelled) done()
      })
    return () => {
      cancelled = true
      done()
    }
    // t 只用于步骤文案，切换语言时不需要重跑核对。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    if (!id || probe.id !== id || probe.phase !== 'ready' || !probe.sha256) return
    // 后端在持有句柄时会再核一次哈希；内容对不上就拒绝占用（也就不会放行）。
    void window.api.homepage.hold(id, probe.sha256).catch(() => undefined)
  }, [id, probe.id, probe.phase, probe.sha256])

  return null
}

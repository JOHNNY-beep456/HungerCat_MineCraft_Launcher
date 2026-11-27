/**
 * 启动期工具：一「延后」、一「等完」。
 *
 * `runWhenIdle`：把非首屏必需的工作（目录扫描、原生内核探测、皮肤补全等）推迟到浏览器
 * 首个空闲帧之后再做，避免与首屏渲染抢主线程、IO 与网络进程 fork，从而压低
 * 「打开启动器」时的瞬时 CPU / 内存峰值。功能与结果完全不变，只是晚一点发生。
 * 优先 requestIdleCallback（真正空闲时执行）；不支持时退化为 setTimeout 宏任务，
 * 两者都在首帧提交之后执行。返回取消函数，供 effect 清理时调用。
 *
 * `bootStep` / `waitForBoot`：把「启动时只做一次、以前会在界面出现后才显示进度」的操作
 * 放进载入遮罩里完成（见文件后半部分）。两者用途相反但互补：**看得见的**检查要被遮罩等完，
 * **看不见的**杂活才丢到空闲帧。
 */
export function runWhenIdle(task: () => void, timeout = 2000): () => void {
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
    .requestIdleCallback
  const cic = (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback
  if (typeof ric === 'function') {
    const id = ric(task, { timeout })
    return () => {
      if (typeof cic === 'function') cic(id)
    }
  }
  const timer = setTimeout(task, 0)
  return () => clearTimeout(timer)
}

/* ------------------------------------------------------------------ */
/* 载入界面里的启动检查                                                  */
/* ------------------------------------------------------------------ */

/**
 * 启动检查的登记处：让「启动时只做一次」的操作发生在载入遮罩背后，
 * 而不是界面已经出来之后再单独显示（典型例子是主页联网核对 —— 以前界面先出现，
 * 侧栏首页图标一边闪一边提示「正在核对」，观感像「界面出来了才开始干活」）。
 *
 * 规则：
 *   · 组件在 effect 里 `const done = bootStep(label)`，结束后调用 `done()`（幂等）；
 *   · `main.tsx` 在挂载后 `await waitForBoot(3000)` 再撤骨架 —— 只等「登记过的步骤」，
 *     没有登记就立即放行，不会无谓拖慢冷启动；
 *   · **必须有上限**：网络卡住时不能把载入界面钉死。超时后照常撤骨架，
 *     未完成的检查继续在后台跑（结果仍会更新，只是不再有独立的加载指示）。
 *
 * `markBootReady()` 由 App 在「设置就绪」时调用：只有这时才知道要跑哪些检查
 * （主页核对依赖 homepageId）。React 的 effect 是子先父后，所以 App 标记就绪时，
 * 子组件的步骤已经登记完毕，不会出现「先判定为空、随后又冒出一步」的竞态。
 */
interface BootStep {
  id: number
  label: string
}

const steps: BootStep[] = []
let nextStepId = 1
let bootReady = false
let settled = false
const settleWaiters: Array<() => void> = []

/** 把当前步骤文字写进载入骨架的 `#hc-boot-task`（没有 DOM / 没有该节点就静默跳过）。 */
function renderBootStatus(): void {
  // 源码级测试夹具里可能只有极简 document，甚至没有 document：骨架纯属观感，
  // 不能因为缺 DOM 就让启动检查的登记逻辑抛错。
  if (typeof document === 'undefined') return
  const el = document.getElementById('hc-boot-task')
  if (!el) return
  const label = steps.length > 0 ? steps[steps.length - 1].label : ''
  el.textContent = label
  el.dataset['on'] = label ? 'true' : 'false'
}

function finishBoot(): void {
  if (settled) return
  settled = true
  renderBootStatus()
  for (const waiter of settleWaiters.splice(0)) waiter()
}

function checkBootSettled(): void {
  if (bootReady && steps.length === 0) finishBoot()
}

/** 设置已就绪：允许「全部检查完成」的判定。重复调用无副作用。 */
export function markBootReady(): void {
  if (bootReady) return
  bootReady = true
  checkBootSettled()
}

/**
 * 登记一步启动检查，返回「完成」回调（幂等）。
 *
 * 载入界面已经撤掉后再登记（例如用户手动切主页触发的重查）直接返回空函数：
 * 那时不该再把遮罩拉回来，界面自己会显示进行中的状态。
 */
export function bootStep(label: string): () => void {
  if (settled) return () => undefined
  const step: BootStep = { id: nextStepId++, label }
  steps.push(step)
  renderBootStatus()
  let done = false
  return () => {
    if (done) return
    done = true
    const index = steps.findIndex((s) => s.id === step.id)
    if (index >= 0) steps.splice(index, 1)
    renderBootStatus()
    checkBootSettled()
  }
}

/**
 * 等到「设置就绪 + 所有已登记的检查完成」，或到达 `deadlineMs`。
 * 超时是刻意保留的兜底，不是失误：详见本节开头的说明。
 */
export function waitForBoot(deadlineMs: number): Promise<void> {
  if (settled) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finishBoot, Math.max(0, deadlineMs))
    settleWaiters.push(() => {
      clearTimeout(timer)
      resolve()
    })
    // 没有登记任何步骤时不要干等：设置就绪即放行。
    checkBootSettled()
  })
}

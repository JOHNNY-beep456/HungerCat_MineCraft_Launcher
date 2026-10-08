/**
 * 启动期「延后执行」工具：把非首屏必需的工作（联网检查、目录扫描、原生内核探测等）
 * 推迟到浏览器首个空闲帧之后再做，避免与首屏渲染抢主线程、IO 与网络进程 fork，
 * 从而压低「打开启动器」时的瞬时 CPU / 内存峰值。功能与结果完全不变，只是晚一点发生。
 *
 * 优先 requestIdleCallback（真正空闲时执行）；不支持时退化为 setTimeout 宏任务，
 * 两者都在首帧提交之后执行。返回取消函数，供 effect 清理时调用。
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

/**
 * 本地操作看门狗 —— 为「非网络」的本地异步 / 阻塞步骤统一加超时。
 *
 * 约定：任何预期很快、却可能挂起的本地操作（本地解析、单文件读写、内存设置应用等）
 * 都通过 `withLocalTimeout` 包裹。超时后该操作被强制判废并向调用方抛错，由调用方
 * 捕获并友好降级，绝不把启动器整个搞崩；错误同时经日志系统（见 logger.ts）记录。
 *
 * 注意：**不作用于网络请求**。HTTP / fetch / 下载流维持各自的 10s 超时
 * （`AbortSignal.timeout(10_000)`），不走本看门狗，避免把正常下载误杀。
 */

/**
 * 监视一个本地 Promise，超过 `timeoutMs`（默认 1s）未完成即判超时失败。
 *
 * - 正常完成：原样返回结果。
 * - 超时：记录 error 日志（含 label 与 ms），reject 一个带明确中文信息的 Error。
 * - 定时器必然在 `finally` 中清理；超时后原操作即便稍后才 settle，其结果也会被
 *   丢弃（忽略过期回调），不留悬挂状态。
 *
 * @param p      待监视的本地操作 Promise（其自身冒泡的取消 / 失败仍原样透传）。
 * @param label  日志中可读的操作名，便于在 debug 日志里定位。
 */
export function withLocalTimeout<T>(
  p: Promise<T>,
  label: string,
  opts: { timeoutMs?: number } = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 1000
  // 记录起始时间，错误信息能带上实际超时毫秒数。
  const start = Date.now()
  let timer: ReturnType<typeof setTimeout> | null = null
  return new Promise<T>((resolve, reject) => {
    let settled = false
    timer = setTimeout(() => {
      if (settled) return
      settled = true
      const ms = Date.now() - start
      console.error(`本地操作超时已强制结束: ${label} (${ms}ms)`)
      reject(new Error(`本地操作执行超时（>${timeoutMs}ms），已强制结束: ${label}`))
    }, timeoutMs)
    p.then(
      (v) => {
        if (settled) return
        settled = true
        resolve(v)
      },
      (e) => {
        if (settled) return
        settled = true
        reject(e)
      }
    )
  }).finally(() => {
    if (timer != null) {
      clearTimeout(timer)
      timer = null
    }
  })
}
// ---------------------------------------------------------------------------
// 网络进程（utilityProcess）↔ 后端进程（主进程 broker）之间的通用消息协议。
//
// 三进程数据流：渲染层(preload IPC) → 后端进程 → MessagePort → 网络进程 → 回传。
// 协议核心约定：
//   - 每个请求带自增 ref(id)，支持并发与乱序匹配（broker 按 ref 找到对应的 Promise）。
//   - 响应带 ok 标志 + 序列化后的 error.message，broker 侧统一还原成 Error 抛出，
//     单请求失败不拖垮 broker（错误边界）。
//   - 下载/长任务进度用 type:'progress' + taskId 单独事件流式回传。
//   - 取消用 type:'abort' + ref 沿链路下传，直到网络进程的 AbortSignal。
// ---------------------------------------------------------------------------

/** 后端(broker) → 网络进程 */
export type NetRequestMessage =
  /** 初始化握手：真正的通信端口随本消息的 e.ports[0] 一起转移给子进程。 */
  | { type: 'init' }
  /** 发起一次网络操作 */
  | { type: 'request'; ref: number; method: string; params?: unknown; taskId?: string }
  /** 按 ref 取消一个在途操作（Abort 传播） */
  | { type: 'abort'; ref: number }

/** 网络进程 → 后端(broker) */
export type NetResponseMessage =
  | { type: 'result'; ref: number; ok: true; data?: unknown }
  | { type: 'result'; ref: number; ok: false; error: string }
  | { type: 'progress'; ref: number; taskId: string; data: unknown }

/** 网络进程内某个网络操作执行时获得的上下文。 */
export interface NetHandlerCtx {
  /** 该请求的取消信号（broker 侧触发 abort 时，这里同步 abort）。 */
  signal: AbortSignal
  /** 渲染层传入的任务标识，用于进度按 taskId 汇总。 */
  taskId?: string
  /** 流式回传进度事件；最终由 broker 汇总后送达渲染层对应通道。 */
  emit: (data: unknown) => void
}

/** 网络进程向 broker 暴露的可调用方法表签名。 */
export type NetHandler = (params: any, ctx: NetHandlerCtx) => Promise<unknown>
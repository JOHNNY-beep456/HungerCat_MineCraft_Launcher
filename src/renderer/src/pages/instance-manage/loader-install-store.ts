import type { ForgeKind, LoaderKind } from '@shared/types'

/**
 * 加载器就地安装的「任务状态」外部存储。
 *
 * ## 为什么不能放在组件里
 *
 * 安装过程有两段：合并 profile（Forge 家族还要跑安装器，几分钟）与下载依赖库。
 * 原先这些状态（busy / 实时日志 / 错误 / 互斥锁）全都是 `LoaderInstallCard` 的
 * 局部 state，于是：
 *
 *   · **离开实例管理页 → 组件卸载 → 状态全丢**：IPC 调用还在主进程里跑，界面却
 *     什么都不显示，用户回到页面只看到「安装」按钮，以为没开始过；
 *   · 重进页面后 `busyRef` 是全新的 → 互斥失效 → 再点一次就会**重复合并**，
 *     并把上一次仍在跑的下载搅乱。
 *
 * 把任务状态提到模块级、按「版本目录 id + 实例 id」索引，就能做到：
 *
 *   · 组件卸载不影响任务，异步流程照常推进；
 *   · 重新挂载时用 `useSyncExternalStore` 读回当前进度（合并中 / 下载中 / 失败）；
 *   · 互斥锁跟着任务走，而不是跟着组件实例走。
 *
 * 有意**不持久化到磁盘**：主进程随窗口关闭而退出，安装本身也就中断了，
 * 存盘只会留下一个永远停在「安装中」的假状态。
 */

export type LoaderInstallPhase = 'merging' | 'downloading' | 'done' | 'error'

export interface LoaderInstallJob {
  key: string
  kind: LoaderKind | ForgeKind
  loaderVersion: string
  phase: LoaderInstallPhase
  /** 仅 phase === 'error' 时有值。 */
  error: string | null
  /** 安装器 / 下载的最近一行输出。 */
  log: string
  startedAt: number
  finishedAt: number | null
}

/** 任务键：同一实例在不同版本目录下互不干扰。 */
export function loaderJobKey(dirId: string, instanceId: string): string {
  return `${dirId}|${instanceId}`
}

const jobs = new Map<string, LoaderInstallJob>()
const listeners = new Set<() => void>()

function emit(): void {
  // 复制一份再遍历：监听器在回调里可能取消订阅（组件卸载）。
  for (const fn of [...listeners]) fn()
}

/** 供 useSyncExternalStore 订阅。 */
export function subscribeLoaderJobs(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** 读取某个实例的当前任务（无任务返回 null）。返回值引用稳定，可直接当快照用。 */
export function getLoaderJob(key: string): LoaderInstallJob | null {
  return jobs.get(key) ?? null
}

/** 是否有任务正在推进（合并中 / 下载中）。 */
export function isLoaderJobRunning(key: string): boolean {
  const job = jobs.get(key)
  return !!job && (job.phase === 'merging' || job.phase === 'downloading')
}

function patch(key: string, next: Partial<LoaderInstallJob>): void {
  const cur = jobs.get(key)
  if (!cur) return
  jobs.set(key, { ...cur, ...next })
  emit()
}

/** 清掉任务（成功后由界面调用，让卡片回到可再次使用的状态）。 */
export function clearLoaderJob(key: string): void {
  if (jobs.delete(key)) emit()
}

export interface StartLoaderInstallArgs {
  dirId: string
  instanceId: string
  mcVersion: string
  kind: LoaderKind | ForgeKind
  loaderVersion: string
  /**
   * 下载依赖库的动作（`runtime.tsx` 的 installVersion）。
   * 由调用方注入，store 不依赖 React 上下文。
   */
  installVersion: (id: string, dirId?: string) => Promise<void>
}

function isForgeKind(kind: LoaderKind | ForgeKind): kind is ForgeKind {
  return kind === 'forge' || kind === 'neoforge'
}

/**
 * 启动一次就地安装。**同步返回**：界面靠订阅 store 拿状态，不必 await。
 * 已存在进行中的任务时直接忽略（重进页面后重复点击不会二次合并）。
 */
export function startLoaderInstall(args: StartLoaderInstallArgs): void {
  const key = loaderJobKey(args.dirId, args.instanceId)
  if (isLoaderJobRunning(key)) return

  jobs.set(key, {
    key,
    kind: args.kind,
    loaderVersion: args.loaderVersion,
    phase: 'merging',
    error: null,
    log: '',
    startedAt: Date.now(),
    finishedAt: null
  })
  emit()
  void run(key, args)
}

async function run(key: string, args: StartLoaderInstallArgs): Promise<void> {
  // Forge 家族会持续推送安装器输出；Fabric / Quilt 没有这条通道。
  const off = isForgeKind(args.kind) ? window.api.forge.onLog((line) => patch(key, { log: line })) : null
  try {
    // 第一步：把加载器 profile 合并进本实例的版本 JSON（Forge 家族内含跑安装器）。
    await window.api.loaders.installInPlace(
      args.kind,
      args.mcVersion,
      args.loaderVersion,
      args.instanceId,
      args.dirId
    )
    // 第二步：下载加载器依赖的库与资源。独立成一个阶段，重进页面时能看出走到哪了。
    patch(key, { phase: 'downloading', log: '' })
    await args.installVersion(args.instanceId, args.dirId)
    patch(key, { phase: 'done', finishedAt: Date.now() })
  } catch (err) {
    patch(key, {
      phase: 'error',
      error: err instanceof Error ? err.message : String(err),
      finishedAt: Date.now()
    })
  } finally {
    off?.()
  }
}

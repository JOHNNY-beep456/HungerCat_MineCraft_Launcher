import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ForgeKind, LoaderKind } from '@shared/types'
import { useApp } from '../../store'
import { useRuntimeActions } from '../../runtime'
import { Button, Select } from '../../components/ui'
import {
  clearLoaderJob,
  getLoaderJob,
  loaderJobKey,
  startLoaderInstall,
  subscribeLoaderJobs
} from './loader-install-store'

/**
 * 原版实例的「安装模组加载器」卡片（**就地安装**）。
 *
 * ## 语义：装进当前实例，不新建
 *
 * 加载器在启动器里的形态是一份「继承原版」的增量 JSON。这里把它与原版版本
 * **合并成自包含 JSON**，直接写回实例自己的 `versions/<id>/<id>.json`：
 *
 *   · 实例 id 不变 → 列表里还是同一个实例，不用重新积累；
 *   · 版本目录不变 → 存档、资源包、光影、投影、模组、实例级设置全部原样保留；
 *   · 原版 JSON 备份为 `<id>.json.vanilla.bak`，需要时可还原。
 *
 * ## 任务状态不在本组件里
 *
 * 安装任务与它的进度（合并中 / 下载中 / 失败 / 实时日志）都存在
 * `loader-install-store`，按「版本目录 + 实例」索引。这样离开实例管理页、
 * 组件卸载后任务照常推进，重新进来还能看到当前进度 —— 组件只是它的一个视图。
 */

/** 四种加载器统一成一组选项，具体走哪条实现由主进程按 kind 分流。 */
type AnyKind = LoaderKind | ForgeKind

const KIND_OPTIONS: Array<{ value: AnyKind; label: string }> = [
  { value: 'fabric', label: 'Fabric' },
  { value: 'quilt', label: 'Quilt' },
  { value: 'forge', label: 'Forge' },
  { value: 'neoforge', label: 'NeoForge' }
]

function isForgeKind(kind: AnyKind): kind is ForgeKind {
  return kind === 'forge' || kind === 'neoforge'
}

/**
 * 渲染端兜底超时。
 *
 * Forge / NeoForge 的版本清单来自 maven，慢的时候能挂几十秒；不给时限的话按钮会
 * 一直停在「加载中」，用户以为卡死。超时按「该加载器此版本不可用」处理并提示。
 */
function withTimeout<T>(p: Promise<T>, ms: number, tip: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(tip)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

export function LoaderInstallCard({
  instanceId,
  mcVersion,
  dirId,
  onInstalled
}: {
  /** 目标实例 id：安装后仍是它（就地安装，不产生新实例）。 */
  instanceId: string
  /** 实例的基础原版版本（如 1.20.1），加载器要装在这个版本之上。 */
  mcVersion: string
  /** 实例所属版本目录 id。 */
  dirId: string
  /** 安装完成后回调，由上层刷新实例元数据。 */
  onInstalled: () => void
}): JSX.Element {
  const { t } = useApp()
  const { installVersion } = useRuntimeActions()

  const jobKey = loaderJobKey(dirId, instanceId)
  /** 订阅外部任务状态：重进页面时这里会立刻拿到仍在进行的安装。 */
  const job = useSyncExternalStore(
    subscribeLoaderJobs,
    () => getLoaderJob(jobKey),
    () => getLoaderJob(jobKey)
  )
  const running = job?.phase === 'merging' || job?.phase === 'downloading'

  const [kind, setKind] = useState<AnyKind>('fabric')
  const [versions, setVersions] = useState<string[]>([])
  const [ver, setVer] = useState('')
  const [loading, setLoading] = useState(false)
  /** 仅「取版本清单」失败用；安装失败走 job.error。 */
  const [versError, setVersError] = useState<string | null>(null)

  /**
   * 请求序号：快速切换加载器时，先发的请求可能后返回，
   * 用序号把陈旧响应丢掉，避免版本列表被写回上一个加载器的数据。
   */
  const seq = useRef(0)

  // 换加载器或换实例时重新拉版本清单，并把选中版本复位。
  // 有任务在跑时也拉：恢复显示时用得上同一份清单。
  useEffect(() => {
    const mySeq = ++seq.current
    setVersions([])
    setVer('')
    setVersError(null)
    setLoading(true)
    void withTimeout(
      isForgeKind(kind)
        ? window.api.forge.versions(kind, mcVersion)
        : window.api.loaders.versions(kind, mcVersion),
      10_000,
      t('ins.loader.timeout', { kind })
    )
      .then((list) => {
        if (mySeq !== seq.current) return
        setVersions(list)
        if (list.length > 0) setVer(list[0])
        else setVersError(t('ins.loader.none', { kind, mc: mcVersion }))
      })
      .catch((err) => {
        if (mySeq !== seq.current) return
        setVersError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (mySeq === seq.current) setLoading(false)
      })
  }, [kind, mcVersion, t])

  /*
   * 任务完成 → 通知上层刷新实例元数据（loader 变非空后本卡片会自然消失），
   * 然后清掉任务。放在 effect 里而不是 store 内部，是因为「刷新」属于界面职责。
   *
   * doneRef 防重复：父组件的 onInstalled 是内联箭头，每次渲染 identity 都变，
   * 没有这个守卫会把「刷新」触发两次以上。
   */
  const doneRef = useRef(false)
  useEffect(() => {
    if (job?.phase !== 'done') {
      // 任务被清掉（含用户重进页面后拿到全新任务）时复位，允许下一轮再次通知。
      if (!job) doneRef.current = false
      return
    }
    if (doneRef.current) return
    doneRef.current = true
    onInstalled()
    clearLoaderJob(jobKey)
  }, [job, jobKey, onInstalled])

  const install = (): void => {
    if (running) return
    // 状态由 store 持有，这里同步返回：离开页面也不会打断安装。
    startLoaderInstall({
      dirId,
      instanceId,
      mcVersion,
      kind,
      loaderVersion: ver,
      installVersion
    })
  }

  const canInstall = !running && !loading && !!ver && !!mcVersion
  const phaseText =
    job?.phase === 'merging' ? t('ins.loader.phaseMerge') : t('ins.loader.phaseDownload')
  const error = job?.phase === 'error' ? job.error : versError
  const lastLine = job?.log ? job.log.split(/\r?\n/).filter((s) => s.trim()).pop() : ''

  return (
    <div className="glass-soft rounded-2xl p-4">
      <div className="text-[14px] font-medium">{t('ins.loader.installTitle')}</div>
      <div className="caption mt-0.5">{t('ins.loader.installDesc', { mc: mcVersion })}</div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/*
          有任务时按任务里的加载器 / 版本显示：重进页面后本地 state 是默认值，
          若照着本地 state 渲染，界面会显示 fabric 而实际在装 forge。
        */}
        <Select
          className="w-[150px]"
          value={job ? job.kind : kind}
          onChange={(v) => setKind(v as AnyKind)}
          options={KIND_OPTIONS}
          disabled={running}
        />
        <Select
          className="w-[190px]"
          value={job ? job.loaderVersion : ver}
          onChange={setVer}
          options={versions.map((v) => ({ value: v, label: v }))}
          disabled={running || loading || versions.length === 0}
          placeholder={loading ? t('ins.loader.loading') : t('ins.loader.version')}
        />
        <Button size="sm" variant="primary" disabled={!canInstall} onClick={install}>
          {running ? phaseText : t('ins.loader.install')}
        </Button>
      </div>

      {error && (
        /*
         * whitespace-pre-wrap：安装器失败信息里带着「最近输出」的多行日志，
         * 默认 HTML 会把换行折叠成空格，几行日志挤成一坨根本没法读。
         */
        <div
          className="mt-2 whitespace-pre-wrap break-words text-[12px]"
          style={{ color: 'var(--fill-danger)' }}
        >
          {error}
        </div>
      )}
      {running && lastLine && (
        <div className="caption mt-2 truncate" title={lastLine}>
          {lastLine}
        </div>
      )}
    </div>
  )
}

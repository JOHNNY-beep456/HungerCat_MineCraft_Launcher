// TODO(网络进程迁移): 实际下载执行（installVersion 的网络字节流，基于 stream-download.ts）待迁入网络进程，
// 用 progress 事件流式回传并保住 phase:'done' 语义。本模块暂保留主进程下载路径，不退化。
import { createHash } from 'crypto'
import { createReadStream, existsSync, promises as fsp } from 'fs'
import { dirname, join } from 'path'
import type { DownloadProgress, Library, VersionJson } from '@shared/types'
import { OFFICIAL, candidateUrls, clientJarCandidates } from './mirror'
import { streamDownload } from './stream-download'
import { netRequest } from './broker'
import { extractArchive } from './archive'
import { ProgressReporter, computePercent } from './transfer-util'

const UA = 'HungerCatLauncher/0.1'

interface DownloadTask {
  /** 主地址：候选列表的第一项（按当前「文件下载源」策略排序）。 */
  url: string
  /**
   * 备用候选地址（有序）：主地址缺失（404）/ 缓慢 / 不可达时逐个尝试。
   *
   * 这解决了「BMCLAPI 部分文件 404」的老问题：以前只有一个固定回退地址，
   * 镜像 404 后就整任务失败；现在候选是**有序列表**，镜像缺什么就落回官方源，
   * 反之（镜像优先策略下）官方慢就换镜像。
   */
  fallbackUrls?: string[]
  dest: string
  sha1?: string
  size?: number
  label: string
  phase: DownloadProgress['phase']
  extract?: boolean
  /**
   * 可选任务：下载失败（尤其 404）时**跳过而不中断整体安装**。
   * 用于单个资源对象（assets/objects）——某个对象在 CDN 上缺失不该让整个游戏启动失败。
   * 关键文件（客户端 jar、库、资源索引）保持必选，缺失时必须报错。
   */
  optional?: boolean
}

const isWindows = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const osName = isWindows ? 'windows' : isMac ? 'osx' : 'linux'

/**
 * 按当前「文件下载源」策略构造有序候选地址。
 *
 * 旧实现只产出「官方 + 一个固定镜像」两项，且镜像顺序写死。现在改为读取
 * `mirror.ts` 的策略（用户可在设置里选「镜像优先 / 官方优先 / 自动」），
 * 并把**所有**候选（可能只有一项）都带上，供下载层逐个回退。
 */
function urlsFor(officialUrl: string): { url: string; fallbackUrls?: string[] } {
  const candidates = candidateUrls(officialUrl)
  const [first, ...rest] = candidates
  return rest.length > 0 ? { url: first, fallbackUrls: rest } : { url: first }
}

/**
 * 从错误中取结构化信息。网络进程现在回传 `{code, status, retryAfter}`（见 net-protocol.ts），
 * broker 会把它还原成 `NetError` 实例，因此这里**不再依赖错误文案正则**。
 * 旧实现用 `/HTTP[^\d]*404/` 匹配中文文案，改一个字就断链，是典型的隐式协议。
 */
interface StructuredError {
  code?: string
  status?: number
  retryAfter?: string
}
function structured(err: unknown): StructuredError {
  const e = err as StructuredError & { name?: string }
  return { code: e?.code, status: e?.status, retryAfter: e?.retryAfter }
}

/** 是否 HTTP 404（官方源缺文件）—— 按 status 判断，不再匹配文案。 */
function isHttp404(err: unknown): boolean {
  return structured(err).status === 404
}

/** 是否「缓慢 / 挂起」（传输层停滞看门狗）：命中即切镜像回退。 */
function isSlowOrTimeout(err: unknown): boolean {
  const s = structured(err)
  return s.code === 'timeout' || s.status === 408
}

/**
 * 服务端限流退避：优先尊重 Retry-After，其次按状态码给基数，最后指数退避。
 * 旧实现固定 `500ms × attempt`，完全无视 429 的 Retry-After，会把限流打成持续 429。
 */
function retryDelayMs(err: unknown, attempt: number): number {
  const { status, retryAfter } = structured(err)
  if (retryAfter) {
    const sec = Number(retryAfter)
    if (Number.isFinite(sec) && sec > 0) return Math.min(sec * 1000, 30_000)
  }
  const base = status === 429 ? 3000 : 500
  return Math.min(base * Math.pow(2, attempt - 1), 20_000)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 快路径判定：目标文件是否已存在且内容正确（大小已知比对大小；否则比对 SHA-1）。
 * 供 installVersion 的预校验阶段与 downloadFile 共用，避免逻辑分叉。
 */
async function isTaskSatisfied(task: DownloadTask): Promise<boolean> {
  if (!existsSync(task.dest)) return false
  try {
    if (task.size != null) {
      const st = await fsp.stat(task.dest)
      return st.size === task.size
    }
    if (task.sha1) {
      const [, digest] = await Promise.all([fsp.stat(task.dest), sha1File(task.dest)])
      return digest === task.sha1
    }
  } catch {
    /* 读不了视为未满足，走完整下载 */
  }
  return false
}

async function downloadFile(
  task: DownloadTask,
  onBytes: (n: number) => void,
  signal?: AbortSignal,
  retries = 3,
  onSize?: (size: number) => void,
  /** 单文件并发连接数；缺省由传输层用默认值（64）。 */
  connections?: number
): Promise<void> {
  await fsp.mkdir(dirname(task.dest), { recursive: true })
  // Fast path: an existing file already matches the known size, or (when the
  // size is unknown) its SHA-1. Count those bytes as already done.
  if (await isTaskSatisfied(task)) {
    const st = await fsp.stat(task.dest).catch(() => null)
    onBytes(st?.size ?? task.size ?? 0)
    if (task.size == null && st) onSize?.(st.size)
    return
  }
  const tmp = task.dest + '.part'
  // 候选源：按设置里的「文件下载源」策略排序的有序列表（至少一项）。
  // 任一候选 404（缺文件）或缓慢（停滞超时）时立刻切到下一个候选重下，
  // 不占用常规重试次数 —— 这正是「镜像部分文件 404 时自动回退官方源」的实现。
  const candidates = [task.url, ...(task.fallbackUrls ?? [])].filter(Boolean)
  let candidateIndex = 0
  let attempt = 0
  let sizeReported = false
  for (;;) {
    if (signal?.aborted) throw new Error('下载已取消')
    const url = candidates[candidateIndex]
    try {
      await streamDownload(url, tmp, {
        signal,
        onBytes,
        onSize: (size) => {
          if (task.size == null && !sizeReported) {
            sizeReported = true
            onSize?.(size)
          }
        },
        sizeHint: task.size,
        connections
      })
      if (task.sha1) {
        const digest = await sha1File(tmp)
        if (digest !== task.sha1) throw new Error(`SHA1 校验失败: ${url}`)
      }
      await fsp.rename(tmp, task.dest)
      return
    } catch (err) {
      if (signal?.aborted) {
        await fsp.rm(tmp, { force: true }).catch(() => {})
        throw new Error('下载已取消')
      }
      // 当前候选缺失（404）或缓慢（停滞超时）：立即切到下一个候选重下，不占用常规重试次数。
      const slow = isSlowOrTimeout(err)
      if (candidateIndex + 1 < candidates.length && (isHttp404(err) || slow)) {
        // 换源必须丢弃旧源写入的分段数据（不同源同一文件的字节可能不一致）。
        await fsp.rm(tmp, { force: true }).catch(() => {})
        candidateIndex++
        console.warn(
          `[下载] 来源${slow ? '响应缓慢' : '缺少该文件'}，切换备用源：${task.label} → ${candidates[candidateIndex]}`
        )
        continue
      }
      // 同源重试：**不删 .part** —— 传输层（Rust/TS）会从已写入偏移续传，
      // 百 MB 级文件遇一次网络抖动不必从头再来（跨调用断点续传的第一层）。
      // 仅在最终失败时才清理，避免残留垃圾文件持续占用磁盘。
      if (attempt === retries) {
        await fsp.rm(tmp, { force: true }).catch(() => {})
        throw err
      }
      attempt++
      await sleep(retryDelayMs(err, attempt))
    }
  }
}

function sha1File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1')
    // 1 MB 分块：默认 64 KB 会让大文件（client.jar、资源包）产生数万次 data 事件，
    // 校验阶段耗时明显偏高。
    const stream = createReadStream(path, { highWaterMark: 1024 * 1024 })
    stream.on('data', (d) => hash.update(d))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/** Fetch a Maven `.sha1` sidecar; returns the hex hash or undefined on failure. */
async function fetchSha1Sidecar(jarUrl: string): Promise<string | undefined> {
  try {
    // 真实网络执行在网络进程（download:sha1），统一 10s 超时；失败/取消返回 undefined。
    return await netRequest<string | undefined>('download:sha1', { url: jarUrl, ua: UA })
  } catch {
    return undefined
  }
}

export function libraryAllowed(lib: Library): boolean {
  if (!lib.rules || lib.rules.length === 0) return true
  let allowed = false
  for (const rule of lib.rules) {
    if (rule.os && rule.os.name && rule.os.name !== osName) continue
    if (rule.features) {
      const matches = Object.entries(rule.features).every(([, v]) => v === false)
      if (!matches) continue
    }
    allowed = rule.action === 'allow'
  }
  return allowed
}

export function libraryPaths(name: string): { prefix: string; base: string } {
  const [group, artifact, version] = name.split(':')
  // Always forward slashes — these are Maven paths used in both URLs and (via
  // path.join) filesystem locations.
  const prefix = `${group.replace(/\./g, '/')}/${artifact}/${version}`
  return { prefix, base: `${artifact}-${version}` }
}

function nativeClassifierCandidates(): string[] {
  const arch = process.arch
  if (isWindows) return ['natives-windows', 'natives-windows-arm64', 'natives-windows-x86_64']
  if (isMac) return arch === 'arm64' ? ['natives-macos-arm64', 'natives-macos'] : ['natives-macos', 'natives-macos-arm64']
  return arch === 'arm64' ? ['natives-linux-arm64', 'natives-linux'] : ['natives-linux']
}

export function pickClassifier(lib: Library): string | null {
  const classifiers = lib.downloads?.classifiers
  if (classifiers) {
    for (const c of nativeClassifierCandidates()) {
      if (classifiers[c]) return c
    }
  }
  const key = isWindows ? 'windows' : isMac ? 'osx' : 'linux'
  const c = lib.natives?.[key]
  return typeof c === 'string' ? c : null
}

async function collectTasks(json: VersionJson, gameDir: string): Promise<DownloadTask[]> {
  const tasks: DownloadTask[] = []

  // 资源索引（assetIndex）不在这里建任务：installVersion 会在拿到索引后单独下载并解析
  // （必须先用它才能枚举资源对象）。此前两处都建了任务，导致每次启动都把索引下载/校验
  // 两遍，是「自动补齐文件耗时过长」的冗余之一。

  // Profile libraries（Fabric / Quilt 等）不带 sha1，需要逐个拉取 `.sha1` sidecar。
  // 原实现把 await 放在 for 循环内，十几个库就是十几次串行 HTTP，是「随版本安装
  // Fabric / Fabric API 时特别慢」的主因；这里先并行取回全部 sidecar，再构造任务。
  const allLibs = json.libraries ?? []
  await Promise.all(
    allLibs
      // 排除「仅 natives」库（有 classifiers、无 artifact）：它们没有主 jar，
      // 取主 jar 的 .sha1 只会白白 404 一次，故不纳入 sidecar 预取。
      .filter((lib) => libraryAllowed(lib) && !lib.downloads?.artifact && !lib.downloads?.classifiers && !lib.sha1)
      .map(async (lib) => {
        const { prefix, base } = libraryPaths(lib.name)
        const repo = (lib.url ?? '').replace(/\/+$/, '')
        const officialUrl = repo
          ? `${repo}/${prefix}/${base}.jar`
          : OFFICIAL.libraryUrl(`${prefix}/${base}.jar`)
        const sha1 = await fetchSha1Sidecar(urlsFor(officialUrl).url)
        if (sha1) lib.sha1 = sha1
      })
  )

  for (const lib of allLibs) {
    if (!libraryAllowed(lib)) continue
    const { prefix, base } = libraryPaths(lib.name)
    const repo = (lib.url ?? '').replace(/\/+$/, '')
    if (lib.downloads?.artifact) {
      const a = lib.downloads.artifact
      const officialUrl = a.url ?? (repo ? `${repo}/${prefix}/${base}.jar` : OFFICIAL.libraryUrl(`${prefix}/${base}.jar`))
      tasks.push({
        ...urlsFor(officialUrl),
        dest: join(gameDir, 'libraries', a.path ?? `${prefix}/${base}.jar`),
        sha1: a.sha1,
        size: a.size,
        label: lib.name,
        phase: 'libraries'
      })
    } else if (lib.downloads?.classifiers) {
      // 「仅 natives」库：只有 downloads.classifiers、没有 downloads.artifact
      // （典型如 net.java.jinput:jinput-platform:2.0.5，1.12.2 等老版本都会引用）。
      // 这类库在服务端**根本没有主 jar**，若仍去下载主 jar 就会 404（BlobNotFound），
      // 进而让整个启动失败。因此跳过主 jar 任务，只保留下面的 classifier natives 任务。
    } else {
      const officialUrl = repo ? `${repo}/${prefix}/${base}.jar` : OFFICIAL.libraryUrl(`${prefix}/${base}.jar`)
      const pair = urlsFor(officialUrl)
      // sha1 已在上面的并行阶段取回并写回 lib；这里直接使用即可。
      // 并行阶段失败（sidecar 拿不到）时保持 undefined，改由 size 判断是否需重下。
      const sha1 = lib.sha1
      tasks.push({
        ...pair,
        dest: join(gameDir, 'libraries', prefix, `${base}.jar`),
        sha1,
        label: lib.name,
        phase: 'libraries'
      })
    }
    if (lib.natives) {
      const classifier = pickClassifier(lib)
      if (classifier) {
        const cd = lib.downloads?.classifiers?.[classifier]
        const officialUrl = cd?.url ?? (repo ? `${repo}/${prefix}/${base}-${classifier}.jar` : OFFICIAL.libraryUrl(`${prefix}/${base}-${classifier}.jar`))
        tasks.push({
          ...urlsFor(officialUrl),
          dest: join(gameDir, 'libraries', cd?.path ?? `${prefix}/${base}-${classifier}.jar`),
          sha1: cd?.sha1,
          size: cd?.size,
          label: `${lib.name} (natives)`,
          phase: 'libraries',
          extract: true
        })
      }
    }
  }

  const client = json.downloads?.client
  if (!client?.url) throw new Error(`版本 ${json.id} 缺少客户端 jar`)
  const baseVersion = json.clientVersion ?? json.id
  // 客户端 jar 也走有序候选：官方 downloads.client.url 与镜像 /version/<id>/client，
  // 顺序随「文件下载源」策略走，任一 404 / 缓慢都能自动落到另一个。
  const clientCandidates = clientJarCandidates(client.url, baseVersion).filter(Boolean)
  tasks.push({
    url: clientCandidates[0],
    ...(clientCandidates.length > 1 ? { fallbackUrls: clientCandidates.slice(1) } : {}),
    dest: join(gameDir, 'versions', json.id, `${json.id}.jar`),
    sha1: client.sha1,
    size: client.size,
    label: `${json.id}.jar`,
    phase: 'client'
  })

  const loggingFile = json.logging?.client?.file
  if (loggingFile?.url) {
    tasks.push({
      url: loggingFile.url,
      dest: join(gameDir, 'assets', 'log_configs', loggingFile.id),
      sha1: loggingFile.sha1,
      size: loggingFile.size,
      label: `日志配置 ${loggingFile.id}`,
      phase: 'logging',
      // 日志配置非关键：缺失时游戏仍可启动，故设为可选。
      optional: true
    })
  }

  return tasks
}

export interface InstallResult {
  nativesDir: string
  librariesDir: string
  assetIndexId: string
}

/**
 * 版本级完整性指纹：**只用本地信息**（版本 JSON + 已落盘文件的 mtime/size）算出。
 *
 * 目的：让「已装好的版本再次启动」能走一个便宜的短路，跳过 collectTasks 里的
 * `.sha1` sidecar 网络预取，以及数千个资源对象任务构造 + 逐个 stat。
 *
 * 为什么不把数千个资源对象也逐个 stat 进来：那正是要省掉的开销。资源对象由
 * 「资源索引文件」唯一确定（索引不变 → 哈希集合不变），因此只在指纹里纳入索引
 * 文件的 mtime/size 与对象数量即可，代价极低又能察觉索引变化。
 */
async function installStampFingerprint(json: VersionJson, gameDir: string): Promise<string> {
  const parts: string[] = [`id=${json.id}`, `client=${json.clientVersion ?? json.inheritsFrom ?? json.id}`]

  // 资源索引：id + sha1 + 索引文件自身的 mtime/size
  const ai = json.assetIndex
  if (ai) {
    parts.push(`assetIndex=${ai.id}|${ai.sha1 ?? ''}|${ai.size ?? ''}`)
    try {
      const st = await fsp.stat(join(gameDir, 'assets', 'indexes', `${ai.id}.json`))
      parts.push(`assetIndexFile=${st.mtimeMs}|${st.size}`)
    } catch {
      parts.push('assetIndexFile=missing')
    }
  }

  // 库 / natives / 客户端 jar / 日志配置：逐个 stat（数量有限，通常几十个），
  // 与 collectTasks 的落盘路径保持一致，但不触发任何网络请求。
  const allLibs = json.libraries ?? []
  for (const lib of allLibs) {
    if (!libraryAllowed(lib)) continue
    const { prefix, base } = libraryPaths(lib.name)
    const dests: string[] = []
    if (lib.downloads?.artifact) {
      dests.push(join(gameDir, 'libraries', lib.downloads.artifact.path ?? `${prefix}/${base}.jar`))
    } else if (!lib.downloads?.classifiers) {
      dests.push(join(gameDir, 'libraries', prefix, `${base}.jar`))
    }
    if (lib.natives) {
      const classifier = pickClassifier(lib)
      if (classifier) {
        const cd = lib.downloads?.classifiers?.[classifier]
        dests.push(join(gameDir, 'libraries', cd?.path ?? `${prefix}/${base}-${classifier}.jar`))
      }
    }
    for (const dest of dests) {
      try {
        const st = await fsp.stat(dest)
        parts.push(`${dest}|${st.mtimeMs}|${st.size}`)
      } catch {
        parts.push(`${dest}|missing`)
      }
    }
  }

  const client = json.downloads?.client
  if (client?.url) {
    const dest = join(gameDir, 'versions', json.id, `${json.id}.jar`)
    try {
      const st = await fsp.stat(dest)
      parts.push(`${dest}|${st.mtimeMs}|${st.size}`)
    } catch {
      parts.push(`${dest}|missing`)
    }
  }

  const loggingFile = json.logging?.client?.file
  if (loggingFile?.url) {
    const dest = join(gameDir, 'assets', 'log_configs', loggingFile.id)
    try {
      const st = await fsp.stat(dest)
      parts.push(`${dest}|${st.mtimeMs}|${st.size}`)
    } catch {
      // 日志配置是可选的：缺失不应让指纹失配，从而误触发一次完整安装。
      parts.push(`${dest}|optional-missing`)
    }
  }

  return createHash('sha1').update(parts.join('\n')).digest('hex')
}

export async function installVersion(
  json: VersionJson,
  gameDir: string,
  concurrency: number,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
  /**
   * 单文件并发连接数（来自设置 downloadConnections）。
   * 与 `concurrency` 是不同维度：前者决定「一个文件开几条连接」，
   * 后者决定「同时下几个文件」。
   */
  connections?: number
): Promise<InstallResult> {
  const assetIndexEarly = json.assetIndex
  const nativesDirEarly = join(gameDir, 'natives', json.id)
  const librariesDir = join(gameDir, 'libraries')
  const stampPath = join(gameDir, 'versions', json.id, '.install-stamp')

  // 快路径：上次安装成功后写过指纹，且本次本地文件（库/客户端/资源索引）都没变，
  // 就说明该版本仍然完整 —— 直接返回，跳过 collectTasks 的 sidecar 网络预取与数千次 stat。
  // 这是「热启动」（已装好的版本再次启动）的主要加速点。
  try {
    const fingerprint = await installStampFingerprint(json, gameDir)
    const prev = await fsp.readFile(stampPath, 'utf-8').catch(() => '')
    if (prev.trim() === fingerprint) {
      console.info(`[下载] 版本 ${json.id} 完整性指纹未变，跳过补齐校验`)
      onProgress({
        task: '完成',
        current: 0,
        total: 0,
        currentBytes: 0,
        totalBytes: 0,
        phase: 'done',
        percent: 100
      })
      return { nativesDir: nativesDirEarly, librariesDir, assetIndexId: assetIndexEarly.id }
    }
  } catch {
    // 指纹计算过程中的任何异常都视为「无法短路」，退回完整安装流程，保证功能不退化。
  }

  const tasks = await collectTasks(json, gameDir)
  console.info(`[下载] 开始安装版本 ${json.id}，共 ${tasks.length} 个下载任务`)
  const assetIndex = json.assetIndex

  const indexDest = join(gameDir, 'assets', 'indexes', `${assetIndex.id}.json`)
  await downloadFile(
    {
      url: assetIndex.url,
      dest: indexDest,
      sha1: assetIndex.sha1,
      size: assetIndex.size,
      label: `资源索引 ${assetIndex.id}`,
      phase: 'assets'
    },
    () => {},
    signal
  )
  const indexData = JSON.parse(await fsp.readFile(indexDest, 'utf-8')) as {
    objects: Record<string, { hash: string; size: number }>
  }
  for (const [name, obj] of Object.entries(indexData.objects)) {
    tasks.push({
      ...urlsFor(OFFICIAL.assetUrl(obj.hash)),
      dest: join(gameDir, 'assets', 'objects', obj.hash.slice(0, 2), obj.hash),
      sha1: obj.hash,
      size: obj.size,
      label: `资源 ${name}`,
      phase: 'assets',
      // 单个资源对象可选：Mojang CDN 上若该对象已缺失（404 BlobNotFound），
      // 跳过即可，不该让整个游戏启动失败。
      optional: true
    })
  }

  const total = tasks.length
  let totalBytes = tasks.reduce((s, t) => s + (t.size ?? 0), 0)
  let latestPhase: DownloadProgress['phase'] = 'assets'
  let latestLabel = ''

  // 速度统计 + 80ms 节流上报统一由 ProgressReporter 负责（与 modpack 共用同一实现，
  // 避免两处逐行复制的编排代码各自漂移）。
  const reporter = new ProgressReporter({
    emit: (snap) => {
      onProgress({
        task: latestLabel,
        current: snap.done,
        total: snap.total,
        currentBytes: snap.doneBytes,
        totalBytes: snap.totalBytes,
        phase: latestPhase,
        percent: computePercent(snap),
        speed: snap.speed
      })
    }
  })
  reporter.setTotals(0, total)

  const emit = (phase: DownloadProgress['phase'], label: string, force = false): void => {
    latestPhase = phase
    latestLabel = label
    reporter.report(force)
  }

  const queue = tasks
  let index = 0

  /**
   * 每个任务本次已计入的字节数。**按任务记账**而非全局累加：
   * 重试 / 镜像回退时同一任务会从 0 重新下载，若仍全局 `doneBytes += n`，
   * 之前的字节会重复累计 → 进度虚高、速度虚高（旧实现正是如此）。
   * 这里改为「用任务当前总量覆盖该任务贡献的增量」，任何重下都自然回到正确口径。
   */
  const taskBytes = new Map<DownloadTask, number>()
  /** 提交某任务的最新已下载字节，返回相对上次的增量（可能为负，表示重下回退）。 */
  const accountBytes = (task: DownloadTask, bytes: number): number => {
    const prev = taskBytes.get(task) ?? 0
    if (bytes === prev) return 0
    taskBytes.set(task, bytes)
    return bytes - prev
  }

  // 预校验（快路径）：先用高并发把「文件已存在且大小/哈希相符」的任务提前消化掉。
  //
  // 为什么要单独做这一步：启动前的「自动补齐」绝大多数任务其实早已完成，只需要一次
  // stat 判断 —— 但旧的实现把它们和真正的下载混在同一个 worker 池里，而该池并发只有
  // maxDownloadConcurrency（默认 8），于是数千个资源对象只能按 8 路排队逐个 stat，
  // 底层 libuv 线程池又只有 4 线程，叠加起来就是「补齐校验时间过长」。
  // stat 不占带宽，可以放心用高并发；把已完成的任务标记出来，下载池只需处理真正缺失的。
  const VERIFY_CONCURRENCY = 48
  const verified = new Uint8Array(queue.length)
  {
    let vindex = 0
    const verifyWorkers = Array.from({ length: Math.min(VERIFY_CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        if (signal?.aborted) return
        const i = vindex++
        if (i >= queue.length) return
        const task = queue[i]
        if (await isTaskSatisfied(task)) verified[i] = 1
      }
    })
    await Promise.all(verifyWorkers)
    if (signal?.aborted) throw new Error('下载已取消')
    // 把已完成任务计入进度统计，让进度条一开始就反映真实完成度。
    for (let i = 0; i < queue.length; i++) {
      if (verified[i]) {
        reporter.incDone()
        reporter.addDoneBytes(queue[i].size ?? 0)
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      if (signal?.aborted) return
      const i = index++
      if (i >= queue.length) return
      if (verified[i]) continue
      const task = queue[i]
      // 本任务本次的累计字节：每次下载尝试从 0 起算，失败重下时用新值覆盖，
      // 保证「进度口径 = 当前真实落盘量」而非历史累加。
      let taskDownloaded = 0
      try {
        await downloadFile(
          task,
          (n) => {
            taskDownloaded += n
            reporter.addDoneBytes(accountBytes(task, taskDownloaded))
            emit(task.phase, task.label)
          },
          signal,
          3,
          (size) => {
            // 该任务的预期总大小先撤回上一次的估算再加新值，避免重复计入 totalBytes。
            const prevSize = taskBytes.get(task)
            if (prevSize != null && task.size == null) {
              reporter.addTotalBytes(-prevSize)
            }
            reporter.addTotalBytes(size)
            emit(task.phase, task.label)
          },
          connections
        )
        reporter.incDone()
        taskBytes.set(task, taskDownloaded)
      } catch (err) {
        // 可选任务（单个资源对象）失败不中断整体安装：CDN 上缺失的个别资源
        // 不该让游戏无法启动。记一条警告便于排查，随后继续下一条。
        if (task.optional && !signal?.aborted) {
          console.warn(`[下载] 可选资源缺失，已跳过：${task.label}（${err instanceof Error ? err.message : String(err)}）`)
          reporter.incDone()
        } else {
          // 必选文件失败：把「是哪个文件」拼进错误信息，否则用户只看到裸 404，
          // 既无法判断原因也无从处理（对应启动时的 404 BlobNotFound 难以定位）。
          const detail = err instanceof Error ? err.message : String(err)
          throw new Error(`缺少必需文件「${task.label}」：${detail}`)
        }
      } finally {
        emit(task.phase, task.label)
      }
    }
  })
  let nativesDir = ''
  try {
    try {
      await Promise.all(workers)

      if (signal?.aborted) {
        throw new Error('下载已取消')
      }

      // Save the resolved version JSON (strip inheritsFrom — it is already merged),
      // keeping the base Minecraft version in `clientVersion`. Prefer the value
      // mergeVersions already computed (child.inheritsFrom), then inheritsFrom, then
      // the id; otherwise loader instances end up with their folder name.
      const { inheritsFrom: _inheritsFrom, ...resolved } = json
      resolved.clientVersion = json.clientVersion ?? json.inheritsFrom ?? json.id
      await fsp.mkdir(join(gameDir, 'versions', json.id), { recursive: true })
      await fsp.writeFile(join(gameDir, 'versions', json.id, `${json.id}.json`), JSON.stringify(resolved, null, 2), 'utf-8')

      nativesDir = join(gameDir, 'natives', json.id)
      await fsp.mkdir(nativesDir, { recursive: true })
      // 只在 native jar 内容变化时重新解压：以「jar 的 mtime+size」和上一次解压记录比对。
      // 旧实现每次启动都无条件把所有 native jar 串行解压一遍，即使 jar 完全没变，
      // 也要把 zip 全部条目重新 inflate 写盘 —— 这是「自动补齐文件耗时过长」的主要来源之一。
      await extractNativesIfChanged(
        queue.filter((t) => t.extract),
        nativesDir
      )

      // 全部环节成功后写「版本完整性指纹」：下次启动若本地文件未变即可短路。
      // 写失败不影响本次安装（只是下次不能走快路径），故 catch 掉。
      await installStampFingerprint(json, gameDir)
        .then((fp) => fsp.writeFile(stampPath, fp, 'utf-8'))
        .catch(() => {})
    } finally {
      // 一旦结束（无论成功 / 取消 / 失败），标记 finished 并清除节流定时器，丢弃
      // 所有尚未发出的进度上报。此前仅在成功路径清除定时器，失败 / 取消 / 超时时
      // 残留的 setTimeout 会在 installVersion 返回后继续发送过期进度，把渲染端已
      // 清理的进度条目「复活」，导致补全结束后进度条卡住。
      reporter.finish()
    }
  } catch (err) {
    // 失败 / 取消 / worker 任务超时：补发 done 事件清掉渲染端残留的进度条目，
    // 否则界面会永远停在下载态无法恢复（对应「下载版本卡死」）。
    if (signal?.aborted) console.warn(`[下载] 版本 ${json.id} 安装已取消`)
    else console.error(`[下载] 版本 ${json.id} 安装失败: ${err instanceof Error ? err.message : String(err)}`)
    onProgress({
      task: latestLabel || '下载中断',
      current: 0,
      total,
      currentBytes: 0,
      totalBytes: 0,
      phase: 'done',
      percent: 0,
      speed: 0
    })
    throw err
  }
  console.info(`[下载] 版本 ${json.id} 安装完成`)
  onProgress({ task: '完成', current: total, total, currentBytes: reporter.getDoneBytes(), totalBytes: 0, phase: 'done', percent: 100 })
  return { nativesDir, librariesDir: join(gameDir, 'libraries'), assetIndexId: assetIndex.id }
}

async function extractJar(jarPath: string, destDir: string): Promise<void> {
  try {
    await extractArchive(jarPath, destDir)
  } catch (err) {
    // 与旧行为一致：natives 解压失败不中断安装（缺 native 由启动阶段暴露），但留下日志。
    console.warn(`[下载] natives 解压失败：${jarPath} ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 仅在 native jar 有变化时解压 natives。
 *
 * 判据：把每个待解压 jar 的「文件名 + mtime + size」拼成一个指纹，存到
 * `<nativesDir>/.extract-stamp`。指纹一致说明本次启动与上次相比 native jar 没变，
 * 直接跳过解压 —— 省掉每次启动把全部 native 条目重新 inflate 写盘的开销。
 */
async function extractNativesIfChanged(tasks: DownloadTask[], nativesDir: string): Promise<void> {
  const stampPath = join(nativesDir, '.extract-stamp')
  const parts: string[] = []
  for (const t of tasks) {
    try {
      const st = await fsp.stat(t.dest)
      parts.push(`${t.dest}|${st.mtimeMs}|${st.size}`)
    } catch {
      // jar 缺失：指纹里保留一项，确保与上次不一致从而触发解压（解压时再报错并跳过）。
      parts.push(`${t.dest}|missing`)
    }
  }
  const fingerprint = createHash('sha1').update(parts.join('\n')).digest('hex')
  const prev = await fsp.readFile(stampPath, 'utf-8').catch(() => '')
  if (prev.trim() === fingerprint) return

  for (const task of tasks) {
    await extractJar(task.dest, nativesDir)
  }
  await fsp.writeFile(stampPath, fingerprint, 'utf-8').catch(() => {})
}

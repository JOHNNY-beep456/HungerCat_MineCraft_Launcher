// TODO(网络进程迁移): 实际下载执行（installVersion 的网络字节流，基于 stream-download.ts）待迁入网络进程，
// 用 progress 事件流式回传并保住 phase:'done' 语义。本模块暂保留主进程下载路径，不退化。
import { createHash } from 'crypto'
import { createReadStream, existsSync, promises as fsp } from 'fs'
import { dirname, join } from 'path'
import type { DownloadProgress, Library, VersionJson } from '@shared/types'
import { OFFICIAL, bmclapiClientJarUrl, bmclapiUrl } from './mirror'
import { streamDownload } from './stream-download'
import { netRequest } from './broker'
import { extractArchive } from './archive'

const UA = 'HungerCatLauncher/0.1'

interface DownloadTask {
  url: string
  /** 回退地址：主用（官方）缺失 / 缓慢时自动切到此地址重下（通常是 BMCLAPI 镜像）。 */
  fallbackUrl?: string
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
 * 构造「官方主用 + BMCLAPI 回退」的候选对。
 * 官方源缺失（HTTP 404）或缓慢（连接停滞超时）时，由 downloadFile 切到镜像重下。
 * 若该地址无法镜像（例如第三方 Maven 仓库），则不设置回退地址。
 */
function urlsFor(officialUrl: string): { url: string; fallbackUrl?: string } {
  const mirrored = bmclapiUrl(officialUrl)
  return mirrored !== officialUrl ? { url: officialUrl, fallbackUrl: mirrored } : { url: officialUrl }
}

/**
 * 判断错误是否为 HTTP 404。网络进程只回传错误文案（错误对象不跨进程序列化），
 * 故从 `下载失败 (HTTP 404)` 这类文案中识别。
 */
function isHttp404(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /HTTP[^\d]*404/.test(msg)
}

/**
 * 判断错误是否为「缓慢 / 挂起」：网络进程的停滞看门狗在连续 10s 收不到任何字节时会抛出
 * 「网络连接超时」。命中即视为官方源缓慢，切到镜像回退。
 */
function isSlowOrTimeout(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /网络连接超时/.test(msg)
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
  // 候选源：官方源在前、BMCLAPI 镜像在后。官方源返回 HTTP 404（缺文件）或响应缓慢
  // （停滞超时）时立刻切到镜像重下，不占用常规重试次数；其它错误仍按原逻辑重试。
  const candidates = task.fallbackUrl && task.fallbackUrl !== task.url ? [task.url, task.fallbackUrl] : [task.url]
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
      try {
        await fsp.rm(tmp, { force: true })
      } catch {
        /* ignore */
      }
      // 官方源缺失（404）或缓慢（停滞超时）：立即切到镜像回退重下，不占用常规重试次数。
      const slow = isSlowOrTimeout(err)
      if (candidateIndex + 1 < candidates.length && (isHttp404(err) || slow)) {
        candidateIndex++
        console.warn(`[下载] 官方源${slow ? '响应缓慢' : '缺少该文件'}，回退镜像源：${task.label}`)
        continue
      }
      if (attempt === retries) throw err
      attempt++
      await sleep(500 * attempt)
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
  const mirrorClient = bmclapiClientJarUrl(baseVersion)
  tasks.push({
    url: client.url,
    ...(mirrorClient !== client.url ? { fallbackUrl: mirrorClient } : {}),
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
  let done = 0
  let doneBytes = 0
  let totalBytes = tasks.reduce((s, t) => s + (t.size ?? 0), 0)

  // 实时速度统计：在上一次进度上报的基础上累计字节增量与时间差，据此算出
  // 近似的下载速度（字节/秒）。时间戳跟随 sendProgress 记录，覆盖并发的多 worker。
  let speed = 0
  let lastSpeedAt = Date.now()
  let lastSpeedBytes = 0

  // 主进程同样节流进度上报：每个网络分块都会触发 onBytes，乘以并发工作线程后
  // 会造成极高频的 IPC 序列化与发送。这里合并到约 80ms 一次，仅结束态强制立即
  // 上报，既保持进度条流畅，又显著降低 IPC 与 CPU 占用。
  const EMIT_INTERVAL = 80
  let lastEmitAt = 0
  let emitTimer: ReturnType<typeof setTimeout> | null = null
  let latestPhase: DownloadProgress['phase'] = 'assets'
  let latestLabel = ''
  let finished = false

  const sendProgress = (): void => {
    // installVersion 一旦结束（成功 / 取消 / 失败），节流定时器或仍在后台运行的
    // worker 触发的上报一律丢弃，避免渲染端清理进度条目之后又被过期事件「复活」，
    // 导致下载结束后进度条卡住。
    if (finished) return
    emitTimer = null
    const now = Date.now()
    const delta = now - lastSpeedAt
    const bytes = doneBytes - lastSpeedBytes
    lastSpeedAt = now
    lastSpeedBytes = doneBytes
    // 只在有意义的时间窗口内更新速度（避免首帧瞬时峰值 / 结束前后抖动），
    // 无字节增量时平滑衰减而非骤降。
    if (delta > 0) {
      const inst = bytes / delta // 字节/毫秒
      speed = inst > 0 ? Math.max(0, Math.min(inst * 1000, 1024 * 1024 * 1024)) : speed * 0.5
    }
    lastEmitAt = now
    // Byte-based percent whenever the total is known; fall back to task count
    // while sizes are still being discovered.
    const percent =
      totalBytes > 0
        ? Math.min(100, Math.round((doneBytes / totalBytes) * 100))
        : total > 0
          ? Math.min(100, Math.round((done / total) * 100))
          : 0
    onProgress({
      task: latestLabel,
      current: done,
      total,
      currentBytes: doneBytes,
      totalBytes,
      phase: latestPhase,
      percent,
      speed: Math.round(speed)
    })
  }

  const emit = (phase: DownloadProgress['phase'], label: string, force = false): void => {
    latestPhase = phase
    latestLabel = label
    if (force) {
      if (emitTimer != null) {
        clearTimeout(emitTimer)
        emitTimer = null
      }
      sendProgress()
      return
    }
    const now = Date.now()
    if (now - lastEmitAt >= EMIT_INTERVAL) {
      sendProgress()
    } else if (emitTimer == null) {
      emitTimer = setTimeout(sendProgress, EMIT_INTERVAL)
    }
  }

  const queue = tasks
  let index = 0

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
        done++
        doneBytes += queue[i].size ?? 0
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
      try {
        await downloadFile(
          task,
          (n) => {
            doneBytes += n
            emit(task.phase, task.label)
          },
          signal,
          3,
          (size) => {
            totalBytes += size
            emit(task.phase, task.label)
          },
          connections
        )
        done++
      } catch (err) {
        // 可选任务（单个资源对象）失败不中断整体安装：CDN 上缺失的个别资源
        // 不该让游戏无法启动。记一条警告便于排查，随后继续下一条。
        if (task.optional && !signal?.aborted) {
          console.warn(`[下载] 可选资源缺失，已跳过：${task.label}（${err instanceof Error ? err.message : String(err)}）`)
          done++
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
    } finally {
      // 一旦结束（无论成功 / 取消 / 失败），标记 finished 并清除节流定时器，丢弃
      // 所有尚未发出的进度上报。此前仅在成功路径清除定时器，失败 / 取消 / 超时时
      // 残留的 setTimeout 会在 installVersion 返回后继续发送过期进度，把渲染端已
      // 清理的进度条目「复活」，导致补全结束后进度条卡住。
      finished = true
      if (emitTimer != null) {
        clearTimeout(emitTimer)
        emitTimer = null
      }
    }
  } catch (err) {
    // 失败 / 取消 / worker 任务超时：补发 done 事件清掉渲染端残留的进度条目，
    // 否则界面会永远停在下载态无法恢复（对应「下载版本卡死」）。
    if (signal?.aborted) console.warn(`[下载] 版本 ${json.id} 安装已取消`)
    else console.error(`[下载] 版本 ${json.id} 安装失败: ${err instanceof Error ? err.message : String(err)}`)
    onProgress({
      task: latestLabel || '下载中断',
      current: done,
      total,
      currentBytes: doneBytes,
      totalBytes,
      phase: 'done',
      percent: 0,
      speed: Math.round(speed)
    })
    throw err
  }
  console.info(`[下载] 版本 ${json.id} 安装完成`)
  onProgress({ task: '完成', current: total, total, currentBytes: doneBytes, totalBytes, phase: 'done', percent: 100 })
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

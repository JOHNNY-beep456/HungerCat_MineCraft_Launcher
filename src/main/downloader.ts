// TODO(网络进程迁移): 实际下载执行（installVersion 的网络字节流，基于 stream-download.ts）待迁入网络进程，
// 用 progress 事件流式回传并保住 phase:'done' 语义。本模块暂保留主进程下载路径，不退化。
import { createHash } from 'crypto'
import { createReadStream, existsSync, promises as fsp } from 'fs'
import { dirname, join } from 'path'
import type { DownloadProgress, Library, VersionJson } from '@shared/types'
import { clientJarUrl, mirrorConfig, mirrorUrl, type MirrorKind } from './mirror'
import { streamDownload } from './stream-download'
import { netRequest } from './broker'
import { extractArchive } from './archive'

const UA = 'HungerCatLauncher/0.1'

interface DownloadTask {
  url: string
  dest: string
  sha1?: string
  size?: number
  label: string
  phase: DownloadProgress['phase']
  extract?: boolean
}

const isWindows = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const osName = isWindows ? 'windows' : isMac ? 'osx' : 'linux'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function downloadFile(
  task: DownloadTask,
  onBytes: (n: number) => void,
  signal?: AbortSignal,
  retries = 3,
  onSize?: (size: number) => void
): Promise<void> {
  await fsp.mkdir(dirname(task.dest), { recursive: true })
  // Fast path: an existing file already matches the known size, or (when the
  // size is unknown) its SHA-1. Count those bytes as already done.
  if (existsSync(task.dest)) {
    if (task.size != null) {
      const st = await fsp.stat(task.dest)
      if (st.size === task.size) {
        onBytes(task.size)
        return
      }
    } else if (task.sha1) {
      try {
        const [st, digest] = await Promise.all([fsp.stat(task.dest), sha1File(task.dest)])
        if (digest === task.sha1) {
          onBytes(st.size)
          onSize?.(st.size)
          return
        }
      } catch {
        /* fall through to re-download */
      }
    }
  }
  const tmp = task.dest + '.part'
  let sizeReported = false
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new Error('下载已取消')
    try {
      await streamDownload(task.url, tmp, {
        signal,
        onBytes,
        onSize: (size) => {
          if (task.size == null && !sizeReported) {
            sizeReported = true
            onSize?.(size)
          }
        },
        sizeHint: task.size
      })
      if (task.sha1) {
        const digest = await sha1File(tmp)
        if (digest !== task.sha1) throw new Error(`SHA1 校验失败: ${task.url}`)
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
      if (attempt === retries) throw err
      await sleep(500 * (attempt + 1))
    }
  }
}

function sha1File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1')
    const stream = createReadStream(path)
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

async function collectTasks(json: VersionJson, gameDir: string, kind: MirrorKind): Promise<DownloadTask[]> {
  const tasks: DownloadTask[] = []
  const mc = mirrorConfig(kind)

  // Asset index (small file; leave on Mojang — BMCLAPI has no direct mirror).
  const assetIndex = json.assetIndex
  tasks.push({
    url: assetIndex.url,
    dest: join(gameDir, 'assets', 'indexes', `${assetIndex.id}.json`),
    sha1: assetIndex.sha1,
    size: assetIndex.size,
    label: `资源索引 ${assetIndex.id}`,
    phase: 'assets'
  })

  for (const lib of json.libraries ?? []) {
    if (!libraryAllowed(lib)) continue
    const { prefix, base } = libraryPaths(lib.name)
    const repo = (lib.url ?? '').replace(/\/+$/, '')
    if (lib.downloads?.artifact) {
      const a = lib.downloads.artifact
      const url = a.url ?? (repo ? `${repo}/${prefix}/${base}.jar` : mc.libraryUrl(`${prefix}/${base}.jar`))
      tasks.push({
        url: mirrorUrl(url, kind),
        dest: join(gameDir, 'libraries', a.path ?? `${prefix}/${base}.jar`),
        sha1: a.sha1,
        size: a.size,
        label: lib.name,
        phase: 'libraries'
      })
    } else {
      const jarUrl = repo ? `${repo}/${prefix}/${base}.jar` : mc.libraryUrl(`${prefix}/${base}.jar`)
      // Profile libraries (Fabric/Quilt) ship no sha1/size. Fetch the .sha1
      // sidecar once and persist it on the library so later launches can
      // verify and skip without re-fetching.
      let sha1 = lib.sha1
      if (!sha1) {
        sha1 = await fetchSha1Sidecar(jarUrl)
        if (sha1) lib.sha1 = sha1
      }
      tasks.push({
        url: mirrorUrl(jarUrl, kind),
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
        const url = cd?.url ?? (repo ? `${repo}/${prefix}/${base}-${classifier}.jar` : mc.libraryUrl(`${prefix}/${base}-${classifier}.jar`))
        tasks.push({
          url: mirrorUrl(url, kind),
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
  const clientJar = clientJarUrl(baseVersion, kind) ?? client.url
  tasks.push({
    url: clientJar,
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
      phase: 'logging'
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
  kind: MirrorKind,
  concurrency: number,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<InstallResult> {
  const tasks = await collectTasks(json, gameDir, kind)
  console.info(`[下载] 开始安装版本 ${json.id}，共 ${tasks.length} 个下载任务`)
  const assetIndex = json.assetIndex
  const mc = mirrorConfig(kind)

  const indexDest = join(gameDir, 'assets', 'indexes', `${assetIndex.id}.json`)
  await downloadFile(
    { url: assetIndex.url, dest: indexDest, sha1: assetIndex.sha1, size: assetIndex.size, label: 'index', phase: 'assets' },
    () => {},
    signal
  )
  const indexData = JSON.parse(await fsp.readFile(indexDest, 'utf-8')) as {
    objects: Record<string, { hash: string; size: number }>
  }
  for (const [name, obj] of Object.entries(indexData.objects)) {
    tasks.push({
      url: mc.assetUrl(obj.hash),
      dest: join(gameDir, 'assets', 'objects', obj.hash.slice(0, 2), obj.hash),
      sha1: obj.hash,
      size: obj.size,
      label: `资源 ${name}`,
      phase: 'assets'
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
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      if (signal?.aborted) return
      const i = index++
      if (i >= queue.length) return
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
          }
        )
        done++
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
      for (const task of queue.filter((t) => t.extract)) {
        await extractJar(task.dest, nativesDir)
      }
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

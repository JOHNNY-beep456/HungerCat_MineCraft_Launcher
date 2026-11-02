// 元数据获取（forge 版本清单）已迁至网络进程（forge:versions）；安装器 jar 下载走
// streamDownload（broker 代理到网络进程）。spawn java 运行安装器属后端编排，仍留本进程。
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, promises as fsp } from 'fs'
import { dirname, join } from 'path'
import type { DownloadProgress, ForgeKind, VersionJson } from '@shared/types'
import { netRequest } from './broker'
import { streamDownload } from './stream-download'
import { mergeLoaderProfileInPlace, resolveVersionJson } from './versions'
import { candidateUrls } from './mirror'

/**
 * Forge / NeoForge installation. Unlike Fabric/Quilt (which expose a clean
 * profile JSON), Forge-family loaders ship a Java installer that must be run to
 * generate the version profile and download the loader libraries.
 */

const UA = { 'User-Agent': 'HungerCatLauncher/0.1' }

/** Forge 安装器 jar 的 Maven 下载地址（真实网络 IO 由网络进程承担）。 */
const INSTALLER: Record<ForgeKind, { installer: (v: string) => string }> = {
  forge: {
    installer: (v) => `https://maven.minecraftforge.net/net/minecraftforge/forge/${v}/forge-${v}-installer.jar`
  },
  neoforge: {
    installer: (v) => `https://maven.neoforged.net/releases/net/neoforged/neoforge/${v}/neoforge-${v}-installer.jar`
  }
}

export function forgeVersions(kind: ForgeKind, mcVersion: string): Promise<string[]> {
  return netRequest<string[]>('forge:versions', { kind, mcVersion })
}

/**
 * 预置 Forge 安装器要自己从 **Mojang** 下载的文件（主要是 client mappings）。
 *
 * ## 为什么需要这一步
 *
 * Forge 安装器在客户端安装流程里有一个 `DOWNLOAD_MOJMAPS` 任务，要从
 * `piston-data.mojang.com` 拉 `client-<版本>-<时间戳>-mappings.txt`，写到
 * `<gameDir>/libraries/net/minecraft/client/...`。这个域名在国内常年不可达，
 * 而安装器内部的下载器**没有超时**：它会挂着，既不报错也不退出 ——
 * 现象就是「运行安装器后一直不动」（实测日志停在 `Task: DOWNLOAD_MOJMAPS`）。
 *
 * 启动器自己有多源下载（官方 → BMCLAPI，见 mirror.ts），且
 * `piston-data.mojang.com/v1/objects/<40位哈希>/…` 正好能被 BMCLAPI 的
 * `objects/<哈希>` 端点镜像。所以先把它下到安装器期望的路径，
 * 安装器检查该文件已存在就会把这步标成 `Skip: true` 直接跳过。
 *
 * ## 失败不阻断
 *
 * 这一步只是「尽力优化」：下载失败时仍继续运行安装器（它可能自己成功，例如在
 * 能访问 Mojang 的网络里）。真的卡住时由安装器的无输出看门狗兜底报错。
 */
async function prefetchInstallerMojangFiles(
  gameDir: string,
  mcVersion: string,
  onLog: (line: string) => void
): Promise<void> {
  let mappings: { url?: string; path?: string; size?: number } | undefined
  try {
    const json = await resolveVersionJson(mcVersion, gameDir)
    mappings = json.downloads?.client_mappings
  } catch (err) {
    onLog(`读取 ${mcVersion} 版本信息失败，跳过映射表预下载：${err instanceof Error ? err.message : String(err)}\n`)
    return
  }
  if (!mappings?.url || !mappings.path) return

  const dest = join(gameDir, 'libraries', mappings.path)
  // 安装器只判断「文件在不在」，但大小不对说明是残缺文件，仍要重下。
  try {
    const st = await fsp.stat(dest)
    if (!mappings.size || st.size === mappings.size) {
      onLog('映射表已就绪，安装器会跳过该下载\n')
      return
    }
  } catch {
    /* 不存在：继续下载 */
  }

  onLog('预下载 Mojang 映射表（安装器自身访问 Mojang 时会卡住）…\n')
  await fsp.mkdir(dirname(dest), { recursive: true }).catch(() => {})

  // 按当前「文件下载源」策略给出的候选顺序逐个尝试（auto = 官方 → 镜像）。
  for (const url of candidateUrls(mappings.url)) {
    try {
      await streamDownload(url, dest)
      onLog('映射表已就绪\n')
      return
    } catch (err) {
      onLog(`映射表下载失败（${url.includes('bmclapi') ? '镜像' : '官方'}）：${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
  onLog('映射表预下载失败，安装器若卡在 DOWNLOAD_MOJMAPS 请切换「文件下载源」后重试\n')
}

/**
 * 版本目录快照：`id → <id>.json 的 mtimeMs`。
 *
 * ## 为什么不能只看「目录是否新增」（踩过的坑）
 *
 * 原先用 `!before.has(id)` 判断哪个目录是安装器这一趟生成的。但安装器在
 * **下载阶段就会先把 `versions/<id>/` 建出来**（profile JSON 落盘后才开始拉库）。
 * 于是只要上一次安装被中断（例如看门狗杀掉卡住的进程），那个目录就留在了磁盘上；
 * 用户重试时它已经在 `before` 里 → 「新增」永远判不出来 →
 * 明明装成功了却报「安装器未生成版本配置文件」。
 *
 * 改用 JSON 的 mtime，同时覆盖两种情形：
 *   · 目录是新的（before 里没有）；
 *   · 目录早就在，但这一趟被重写（mtime 变新）。
 */
async function listVersionStamps(gameDir: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  let entries: string[]
  try {
    entries = await fsp.readdir(join(gameDir, 'versions'))
  } catch {
    return out
  }
  for (const id of entries) {
    try {
      const st = await fsp.stat(join(gameDir, 'versions', id, `${id}.json`))
      out.set(id, st.mtimeMs)
    } catch {
      /* 没有 <id>.json：空目录或非版本目录，忽略 */
    }
  }
  return out
}

/**
 * 安装器「安静」多久算卡死。
 *
 * 为什么需要它（而不是只留一个总超时）：Forge / NeoForge 的所需文件都在
 * maven.minecraftforge.net / maven.neoforged.net 上，国内常年连不上。安装器在那种
 * 情况下**不报错也不退出**，只是挂在一次 TCP 连接上 —— 只有整轮 10 分钟的总超时
 * 兜底，用户要干等十分钟才看到一条错误，体感就是「卡住不动」。
 * 2 分钟无任何输出足够区分「慢」与「死」：正常安装器下载时一直在刷进度。
 */
const INSTALLER_STALL_MS = 2 * 60 * 1000

/** 安装器整轮上限（保持原有语义：够慢网跑完，又不至于无限等）。 */
const INSTALLER_HARD_TIMEOUT_MS = 10 * 60 * 1000

/** 判定「安静」的轮询间隔；比阈值小得多，保证及时（2 分钟内必有结论）。 */
const INSTALLER_STALL_POLL_MS = 5 * 1000

/** 日志节流窗口：安装器输出极密（进度条用 \r 刷新），逐块转发会把 IPC 和渲染打满。 */
const LOG_FLUSH_MS = 120

/** 出错时附带多少字符的最近输出，够看清它停在哪一步。 */
const LOG_TAIL_CHARS = 600

/**
 * 终止安装器进程**树**。
 *
 * `child.kill()` 在 Windows 上只结束直接子进程（java.exe）。而被终止的 java 若正
 * 在写版本目录 / 持有安装器 jar，残留进程会让后续的「删除临时版本目录」失败，
 * 重试时还会因为文件被占用继续失败 —— 于是看起来像「装一次就再也装不动」。
 * 用 `taskkill /T /F` 连子树一起收。
 */
function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {
        child.kill()
      })
    } catch {
      child.kill()
    }
    return
  }
  child.kill('SIGKILL')
}

export async function installForge(
  kind: ForgeKind,
  mcVersion: string,
  version: string,
  gameDir: string,
  javaPath: string,
  onLog: (line: string) => void,
  customId?: string,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal,
  /**
   * 运行安装器前必须先完成的前置（通常是原版下载的 Promise）。
   * 安装器 jar 会先下载（可与原版下载并发），但安装器本身必须等它完成后再运行 ——
   * 安装器需要原版已就绪才能正确注入加载器 profile。
   */
  beforeRun?: Promise<unknown>
): Promise<string> {
  const installerUrl = INSTALLER[kind].installer(version)
  const installerDir = join(gameDir, '.installers')
  await fsp.mkdir(installerDir, { recursive: true })
  const installerPath = join(installerDir, `${kind}-${version}-installer.jar`)

  const taskId = `forge-install-${version}`
  const label = `${kind === 'neoforge' ? 'NeoForge' : 'Forge'} ${version}`

  /*
   * 先补齐安装器会自己从 Mojang 拉的文件（client mappings）。
   * 放在「下载安装器」之前：这一步走启动器的多源下载，通常很快；而安装器自己
   * 去拉时会因为访问不到 piston-data.mojang.com 而静默挂住，是本次卡死的主因。
   */
  await prefetchInstallerMojangFiles(gameDir, mcVersion, onLog)

  onLog(`下载 ${kind} 安装器 ${version}…\n`)
  // 安装器下载委托给网络进程（stream:download），进度经 onBytes/onSize 回流。
  let received = 0
  let totalBytes = 0
  await streamDownload(installerUrl, installerPath, {
    signal,
    onBytes: (n) => {
      received += n
      onProgress?.({
        taskId,
        // 大任务标题 = 加载器名；`task` 是当前阶段（下载/运行安装器）的小行。
        jobTitle: label,
        task: '下载安装器',
        current: 0,
        total: 1,
        currentBytes: received,
        totalBytes,
        phase: 'mod',
        percent: totalBytes > 0 ? Math.min(100, Math.round((received / totalBytes) * 100)) : 0
      })
    },
    onSize: (s) => {
      totalBytes = s
    }
  })

  // 安装器 jar 已就绪；但必须等原版下载完成后再运行（安装器需要原版已就绪）。
  // 这样「安装器下载」与「原版下载」可以并发，而安装步骤仍严格晚于原版。
  if (beforeRun) {
    onLog(`等待原版下载完成…\n`)
    await beforeRun
    if (signal?.aborted) throw new Error('下载已取消')
  }

  onLog(`运行安装器 (Java ${javaPath})…\n`)
  onProgress?.({ taskId, jobTitle: label, task: '运行安装器', current: 0, total: 1, currentBytes: 0, totalBytes: 0, phase: 'mod', percent: 0 })

  // The Forge/NeoForge client installer refuses to run unless the official
  // launcher's `launcher_profiles.json` exists AND parses to an object carrying a
  // `profiles` map in the target directory (it injects the loader profile into it
  // afterwards). A missing or malformed file makes the installer abort with
  // "There is no minecraft launcher profile ...", so repair it before running.
  const launcherProfiles = join(gameDir, 'launcher_profiles.json')
  let profilesUsable = false
  if (existsSync(launcherProfiles)) {
    try {
      const parsed = JSON.parse(await fsp.readFile(launcherProfiles, 'utf-8')) as { profiles?: unknown }
      profilesUsable = !!parsed && typeof parsed === 'object' && !!parsed.profiles && typeof parsed.profiles === 'object'
    } catch {
      profilesUsable = false
    }
  }
  if (!profilesUsable) {
    await fsp.writeFile(launcherProfiles, JSON.stringify({ profiles: {} }, null, 2), 'utf-8')
  }

  // 安装前快照（id → JSON mtime）。安装器生成的 profile id 形如
  // "1.20.1-forge-47.x" / "neoforge-21.1.x"，不是 maven 版本号本身。
  const before = await listVersionStamps(gameDir)
  /** 安装器最近输出，出错时随错误一起返回（tail 在 Promise 内部维护）。 */
  let installerTail = ''

  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('下载已取消'))
      return
    }
    /*
     * stdio 必须显式指定，不能留默认值。
     *
     * Node 默认给子进程三条**管道**，其中 stdin 是一条永不关闭的管道：父进程从不
     * 写入，也不发 EOF。Java 安装器只要有任何一处读 System.in（重试询问、
     * BufferedReader.readLine 等），就会一直阻塞在「等输入」上 —— 进程不退出、
     * 不报错、也没有输出，界面上就是「运行安装器… 永远不动」。
     * 把 stdin 设成 'ignore'（等价于 /dev/null，读到立即得到 EOF）就能消除这一整类死等。
     */
    const child = spawn(javaPath, ['-jar', installerPath, '--installClient', gameDir], {
      cwd: gameDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let settled = false
    let lastOutputAt = Date.now()
    /** 最近输出（出错时附带，帮助用户看清停在哪一步）。 */
    let tail = ''
    /** 同步到外层：安装器正常退出但产物判定失败时，也要能把输出带进错误里。 */
    const syncTail = (): void => {
      installerTail = tail
    }
    /** 日志节流缓冲：合并 120ms 内的所有块再转发一次。 */
    let pending = ''
    let flushTimer: NodeJS.Timeout | null = null
    let stallTimer: NodeJS.Timeout | null = null
    let hardTimer: NodeJS.Timeout | null = null

    const flushLog = (): void => {
      flushTimer = null
      if (!pending) return
      const text = pending
      pending = ''
      onLog(text)
    }
    const pushLog = (text: string): void => {
      lastOutputAt = Date.now()
      tail = (tail + text).slice(-LOG_TAIL_CHARS * 2)
      syncTail()
      pending += text
      // 节流：安装器一次写入几十 KB 很常见，逐块 IPC 会把渲染层刷成重渲染风暴。
      if (flushTimer === null) flushTimer = setTimeout(flushLog, LOG_FLUSH_MS)
    }
    const stopTimers = (): void => {
      if (flushTimer !== null) clearTimeout(flushTimer)
      if (stallTimer !== null) clearInterval(stallTimer)
      if (hardTimer !== null) clearTimeout(hardTimer)
      flushTimer = null
      stallTimer = null
      hardTimer = null
    }
    /** 收尾：只结算一次，终止进程树，清理定时器，把剩余日志吐出去。 */
    const finish = (err?: Error): void => {
      if (settled) return
      settled = true
      stopTimers()
      flushLog()
      signal?.removeEventListener('abort', onAbort)
      if (err === undefined) {
        resolve()
        return
      }
      killTree(child)
      reject(err)
    }
    /** 拼一条带「最近输出」的错误，避免用户只看到一句「超时」。 */
    const withTail = (msg: string): Error => {
      const clean = tail.replace(/\r/g, '\n').trim().slice(-LOG_TAIL_CHARS)
      return new Error(clean ? `${msg}\n\n最近输出：\n${clean}` : msg)
    }

    const onAbort = (): void => finish(new Error('下载已取消'))
    signal?.addEventListener('abort', onAbort, { once: true })

    // 「无输出看门狗」：比总超时灵敏得多，网络被墙时 2 分钟就给出可读结论。
    stallTimer = setInterval(() => {
      if (Date.now() - lastOutputAt < INSTALLER_STALL_MS) return
      finish(
        withTail(
          `${kind} 安装器已 ${INSTALLER_STALL_MS / 1000} 秒没有任何输出，已终止。` +
            `通常是无法连接下载服务器（maven.minecraftforge.net / maven.neoforged.net），` +
            `请检查网络或改用镜像后重试。`
        )
      )
    }, INSTALLER_STALL_POLL_MS)

    // 总超时仍然保留：防止安装器一直刷输出却永远跑不完。
    hardTimer = setTimeout(() => {
      finish(
        withTail(
          `${kind} 安装器运行超时（超过 ${INSTALLER_HARD_TIMEOUT_MS / 60000} 分钟），请重试或更换网络`
        )
      )
    }, INSTALLER_HARD_TIMEOUT_MS)

    child.stdout?.on('data', (d: Buffer) => pushLog(d.toString()))
    child.stderr?.on('data', (d: Buffer) => pushLog(d.toString()))
    child.on('error', (err) => finish(withTail(`${kind} 安装器无法启动：${err.message}`)))
    child.on('exit', (code) => {
      if (code === 0) finish()
      else finish(withTail(`${kind} 安装器退出码 ${code}`))
    })
  })

  onLog(`${kind} 安装完成\n`)
  onProgress?.({ taskId, jobTitle: label, task: '安装完成', current: 1, total: 1, currentBytes: totalBytes, totalBytes, phase: 'done', percent: 100 })

  const after = await listVersionStamps(gameDir)

  /*
   * 找「这一趟被写入的版本配置」，按可靠性依次尝试：
   *
   *   1. 新增，或 <id>.json 的 mtime 变新 —— 正常情况下就是它；
   *      用 mtime 而不是「目录是否新增」，是为了兼容「上次中断留下的残留目录」
   *      （见 listVersionStamps 的说明）。
   *   2. 命名规则兜底：安装器幂等跳过写 JSON 时 mtime 不变，
   *      就按 `<mcVersion>-forge-<ver>` / `neoforge-<ver>` 这类命名去找。
   *
   * 始终排除 mcVersion：安装器会顺带补原版目录，那是它自己的副产物。
   */
  let generatedId: string | undefined
  let bestMtime = -Infinity
  for (const [id, mtime] of after) {
    if (id === mcVersion) continue
    const prev = before.get(id)
    if (prev !== undefined && mtime <= prev) continue
    if (mtime > bestMtime) {
      bestMtime = mtime
      generatedId = id
    }
  }

  if (!generatedId) {
    // maven 版本形如 "1.20.1-47.2.0"（forge）/ "21.1.190"（neoforge），
    // 目录名里通常包含它的尾段，用尾段匹配比整串更稳。
    const tailOfVersion = version.split('-').pop() ?? version
    generatedId = [...after.keys()].find(
      (id) =>
        id !== mcVersion &&
        id.toLowerCase().includes(kind) &&
        (id.includes(tailOfVersion) || id.includes(version))
    )
  }

  if (!generatedId) {
    const clean = installerTail.replace(/\r/g, '\n').trim().slice(-LOG_TAIL_CHARS)
    throw new Error(
      `${kind} 安装器未生成版本配置文件` +
        `（若这次安装曾被中断，versions/ 下可能留下残缺目录，可删除后重试）` +
        (clean ? `\n\n最近输出：\n${clean}` : '')
    )
  }
  return finalizeForgeInstall(gameDir, generatedId, customId)
}

/**
 * 把 Forge / NeoForge **就地安装到已有实例**（不新建实例）。
 *
 * Forge 家族没有可用的 profile JSON 接口，只能跑安装器；而安装器按 maven 版本号
 * 固定生成 `versions/<1.20.1-forge-47.x>/`，没法指定写到哪个实例里。所以流程是：
 *
 *   1. 照常跑安装器（它会顺带把 Forge 的库下载进 `libraries/`，那是全实例共享的）；
 *   2. 读它生成的 profile JSON；
 *   3. 把 profile 合并进目标实例自己的版本 JSON（实例 id / 目录 / 存档全不变）；
 *   4. 删掉安装器生成的临时版本目录 —— 否则实例列表里会多出一个多余的版本项。
 *
 * 第 4 步是 best-effort：删不掉只是多一条列表项，不影响安装结果，所以不抛错。
 */
export async function installForgeInPlace(
  kind: ForgeKind,
  mcVersion: string,
  version: string,
  gameDir: string,
  instanceId: string,
  javaPath: string,
  onLog: (line: string) => void,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal,
  beforeRun?: Promise<unknown>
): Promise<void> {
  // customId 传 undefined：让安装器保留自己的命名，我们只在合并后清理。
  const generatedId = await installForge(
    kind,
    mcVersion,
    version,
    gameDir,
    javaPath,
    onLog,
    undefined,
    onProgress,
    signal,
    beforeRun
  )

  const generatedJsonPath = join(gameDir, 'versions', generatedId, `${generatedId}.json`)
  let profile: VersionJson
  try {
    profile = JSON.parse(await fsp.readFile(generatedJsonPath, 'utf-8')) as VersionJson
  } catch (err) {
    throw new Error(
      `${kind} 安装器已运行，但读取它生成的版本配置失败：` +
        (err instanceof Error ? err.message : String(err))
    )
  }

  await mergeLoaderProfileInPlace(gameDir, instanceId, profile)
  onLog(`已并入实例「${instanceId}」\n`)

  /*
   * 清理安装器留下的临时版本目录（其 JSON 已合并进实例，留着只是重复条目）。
   *
   * 但要先确认这个目录**确实是本次安装写入的**：识别不出来时会走「命名规则兜底」，
   * 那条路有可能指到用户自己建的实例上（名字里恰好含 forge 与版本号）。
   * 删别人的实例是不可逆的数据损失，所以用「JSON 的 mtime 是不是刚刚」当闸门：
   * 不是本次写入的就不动，只在日志里说明。
   */
  if (generatedId !== instanceId) {
    const dir = join(gameDir, 'versions', generatedId)
    let fresh = false
    try {
      const st = await fsp.stat(join(dir, `${generatedId}.json`))
      fresh = Date.now() - st.mtimeMs < 10 * 60 * 1000
    } catch {
      /* 没有 JSON：不删 */
    }
    if (fresh) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    } else {
      onLog(`已保留 ${generatedId}：它不是本次安装写入的目录，删除可能误伤已有实例\n`)
    }
  }
}

/** 若指定了自定义版本名，重命名安装器生成的版本目录并更新 JSON 的 id。 */
async function finalizeForgeInstall(gameDir: string, generatedId: string, customId?: string): Promise<string> {
  if (!customId || customId === generatedId) return generatedId
  const srcDir = join(gameDir, 'versions', generatedId)
  const dstDir = join(gameDir, 'versions', customId)
  if (existsSync(join(dstDir, `${customId}.json`))) {
    throw new Error(`版本名「${customId}」已存在`)
  }
  const json = JSON.parse(await fsp.readFile(join(srcDir, `${generatedId}.json`), 'utf-8'))
  json.id = customId
  await fsp.rename(srcDir, dstDir)
  await fsp.writeFile(join(dstDir, `${customId}.json`), JSON.stringify(json, null, 2), 'utf-8')
  await fsp.rm(join(dstDir, `${generatedId}.json`), { force: true }).catch(() => {})
  return customId
}

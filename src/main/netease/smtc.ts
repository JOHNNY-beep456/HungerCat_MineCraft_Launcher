/**
 * Windows 媒体会话（SMTC）采样器。
 *
 * 为什么需要它：网易云音乐客户端（3.x 起）会把播放状态注册进系统的
 * `GlobalSystemMediaTransportControlsSessionManager`，系统任务栏的媒体控件、
 * 键盘上的播放 / 上一首键都走这一套。启动器拿不到客户端内部状态（它是 CEF 应用、
 * 不提供本地接口），于是统一走这条**系统级**通道：曲名、歌手、专辑、播放状态、
 * 播放进度、总时长全在里面。
 *
 * 为什么是一个常驻 PowerShell 子进程而不是每次 spawn 一个：
 *   · 单次 `powershell.exe` 冷启动 300–800ms，而歌词要 0.5 秒级跟随；
 *   · 每 0.4 秒拉一个进程会成为系统里最显眼的 CPU 抖动源。
 * 所以脚本写成「循环采样、逐行吐 JSON」，Node 侧只负责按行解析；进程退出了再拉起。
 *
 * 脚本通过 `-EncodedCommand`（UTF-16LE + Base64）传入，不落临时文件：
 * 免去杀软对「写入并执行 .ps1」的误报，也避免中文路径 / 引号转义问题。
 */

import { spawn, type ChildProcessByStdio } from 'child_process'
import type { Readable } from 'stream'
import { createInterface } from 'readline'

/** 采样子进程类型：stdin 忽略，stdout / stderr 都是管道。 */
type SmtcProcess = ChildProcessByStdio<null, Readable, Readable>

/** 一条媒体会话（只保留歌词需要的字段）。 */
export interface SmtcSession {
  /** 会话所属应用的 AUMID，用来识别「这是不是网易云」。 */
  aumid: string
  /**
   * 来源应用的**可读名称**（如「网易云音乐」）。
   *
   * AUMID 是给系统看的标识（`cloudmusic.exe` / `Netease.CloudMusic_xxx!App`），
   * 直接显示给用户很难看。采样脚本按 AUMID 找到归属进程，取它的
   * `FileDescription` / `ProductName`（本地化名称），都取不到才退回进程名 / AUMID。
   * 空串表示没解析出来，调用方自行兜底。
   */
  source: string
  title: string
  artist: string
  album: string
  /** `Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus` 的字符串形式。 */
  status: 'Playing' | 'Paused' | 'Stopped' | 'Closed' | 'Changing' | 'Opened' | ''
  /**
   * 这一次**是否真的读到了**播放状态。
   *
   * 为什么单独记：`status` 读失败时是空串，而空串此前被当成「没在播放」，
   * 于是进度被钉死在锚点、歌词停止滚动（暂停才该这样）。读不到 ≠ 暂停 ——
   * WinRT 调用偶发失败、客户端切换曲目瞬间都可能拿不到状态，这时应当**沿用上一次
   * 已知的状态**继续按本地时钟外推，而不是误判成暂停。
   */
  statusKnown: boolean
  /**
   * 时间轴起点（秒）。
   *
   * `Position` 与 `EndTime` 都在**这个坐标系**里，而 LRC 歌词的时间戳从 0 开始。
   * 绝大多数本地文件 `start = 0`，两者原点一致；但流式 / 分段加载的媒体（网易云的
   * 在线播放、某些长音频）可能给出非 0 的 StartTime —— 此时直接拿 `Position` 去比对
   * LRC 会整体偏移，表现为「歌词和唱的对不上、而且换一次打开偏移量还可能不同」。
   * 所以对外暴露位置前必须减去它，见 `service.ts` 的换算。
   */
  start: number
  /** 采样瞬间的播放位置（秒，**绝对时间轴**，需减去 `start` 才是歌曲内时间）。 */
  pos: number
  /**
   * `pos` 对应的实际时刻（epoch ms，来自 `LastUpdatedTime`）。
   *
   * 官方文档：`Position` 是「播放位置，当前为 LastUpdatedTime」—— 它是带时间戳的
   * 快照，不是「此刻的位置」。播放器可能长时间不更新，所以必须靠这个时间戳把
   * 「采样时刻」与「位置所属时刻」之间的差补上，才能算出真正的当前进度。
   * 0 表示没读到（此时调用方退化为「把 pos 当作采样时刻的位置」）。
   */
  updatedAt: number
  /** 总时长（秒）；0 表示未知。 */
  end: number
}

/** 一次采样（含采样时间戳，供 Node 侧做进度外推）。 */
export interface SmtcSample {
  /** 采样完成时刻（epoch ms，北京时间无关，只用于算时间差）。 */
  ts: number
  sessions: SmtcSession[]
}

/**
 * 采样脚本。
 *
 * 约束：**纯 ASCII**。Windows PowerShell 5.1 按系统代码页（本项目场景是 GBK）
 * 解析通过命令行传入的脚本，任何非 ASCII 字符都会变成乱码语法错误。
 * 视频标题里的中文由 `[Console]::OutputEncoding = UTF8` 负责无损传出。
 *
 * 健壮性：每一段 WinRT 调用都单独 try/catch —— 某个客户端取属性失败，
 * 不该让整个采样循环退出（否则一首歌出问题就再也不刷新了）。
 */
const SMTC_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { Add-Type -AssemblyName System.Runtime.WindowsRuntime } catch {}
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*'
})[0]
$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]
function Await($op, $t) {
  if ($null -eq $op) { return $null }
  if ($null -eq $asTaskGeneric) { return $null }
  try {
    $task = $asTaskGeneric.MakeGenericMethod($t).Invoke($null, @($op))
    if (-not $task.Wait(2500)) { return $null }
    return $task.Result
  } catch { return $null }
}
$manager = $null
# Cache of "pid -> friendly app name". The media session only exposes an AUMID
# (e.g. "cloudmusic.exe"), which is not what a user should see in the overlay.
# Resolve the owning process once and reuse it: Get-Process is comparatively
# expensive and this loop runs every 400 ms.
$nameCache = @{}
while ($true) {
  if ($null -eq $manager) {
    $manager = Await ($mgrType::RequestAsync()) $mgrType
  }
  $sessions = @()
  if ($null -ne $manager) {
    $sessions = @($manager.GetSessions())
    if ($null -eq $sessions) { $sessions = @() }
  }
  $list = @()
  foreach ($s in $sessions) {
    if ($null -eq $s) { continue }
    $aumid = ''
    $source = ''
    $title = ''
    $artist = ''
    $album = ''
    $status = ''
    $start = 0.0
    $pos = 0.0
    $end = 0.0
    $updated = [long]0
    try { $aumid = [string]$s.SourceAppUserModelId } catch {}
    # Friendly source name: prefer the executable's FileDescription / ProductName
    # (localized, e.g. "NetEase Cloud Music"), then the process name, then the AUMID.
    # Cached per AUMID because Get-Process is expensive in a 400 ms loop.
    try {
      if ($nameCache.ContainsKey($aumid)) {
        $source = $nameCache[$aumid]
      } else {
        # Match strictly: the AUMID must CONTAIN the process name (or vice versa).
        # Loose matching (splitting on dots) is dangerous - "com.bilibili.bilibiliPC"
        # would split to "com" and match anything containing "com"
        # (observed: it resolved to "Memory Compression").
        #
        # Android-style AUMIDs ("com.vendor.app") carry the useful token in the last
        # segment, so try that too - but only as an exact (case-insensitive) match.
        $tokens = @()
        if ($aumid) {
          $tokens += $aumid.ToLower()
          $segs = $aumid.Split('.')
          if ($segs.Count -gt 0) { $tokens += $segs[$segs.Count - 1].ToLower() }
        }
        $cand = $null
        try {
          $cand = Get-Process | Where-Object {
            $pn = [string]$_.ProcessName
            if (-not $pn) { return $false }
            $lowPn = $pn.ToLower()
            foreach ($tk in $tokens) {
              if (-not $tk) { continue }
              if ($tk.Contains($lowPn) -or $lowPn.Contains($tk)) { return $true }
            }
            return $false
          } | Select-Object -First 1
        } catch {}
        if ($null -ne $cand) {
          $desc = ''
          $prod = ''
          try { $desc = [string]$cand.MainModule.FileVersionInfo.FileDescription } catch {}
          try { $prod = [string]$cand.MainModule.FileVersionInfo.ProductName } catch {}
          if ($desc) { $source = $desc }
          elseif ($prod) { $source = $prod }
          else { $source = [string]$cand.ProcessName }
        }
        if (-not $source) { $source = '' }
        $nameCache[$aumid] = $source
      }
    } catch {}
    try {
      $p = Await ($s.TryGetMediaPropertiesAsync()) $propsType
      if ($null -ne $p) {
        $title = [string]$p.Title
        $artist = [string]$p.Artist
        $album = [string]$p.AlbumTitle
      }
    } catch {}
    try { $status = [string]$s.GetPlaybackInfo().PlaybackStatus } catch {}
    try {
      $tl = $s.GetTimelineProperties()
      $start = [double]$tl.StartTime.TotalSeconds
      $pos = [double]$tl.Position.TotalSeconds
      $end = [double]$tl.EndTime.TotalSeconds
      # Position is the playback position AS OF LastUpdatedTime, so the timestamp
      # must be reported too - otherwise the real current progress cannot be derived.
      # See timeline.ts for the full explanation.
      $updated = [long]$tl.LastUpdatedTime.ToUnixTimeMilliseconds()
    } catch {}
    $list += [pscustomobject]@{
      aumid = $aumid
      source = $source
      title = $title
      artist = $artist
      album = $album
      status = $status
      start = $start
      pos = $pos
      end = $end
      updated = $updated
    }
  }
  $stamp = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  $payload = [pscustomobject]@{ ts = $stamp; sessions = $list }
  try {
    $line = ConvertTo-Json -InputObject $payload -Depth 4 -Compress
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
  } catch {}
  Start-Sleep -Milliseconds 400
}
`

/** 只有 Windows 有 SMTC；其它平台直接当作「不支持」。 */
export function isSmtcSupported(): boolean {
  return process.platform === 'win32'
}

/** 把脚本包成 powershell.exe 能吃的 `-EncodedCommand` 参数。 */
function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** 解析一行采样输出；格式不认识就返回 null（绝不抛给上层）。 */
function parseLine(line: string): SmtcSample | null {
  const text = line.trim()
  if (!text || text[0] !== '{') return null
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  const ts = Number(record['ts'])
  const rawSessions = record['sessions']
  // PowerShell 在只有一个元素时可能把数组序列化成对象，这里统一成数组。
  const items = Array.isArray(rawSessions) ? rawSessions : rawSessions ? [rawSessions] : []
  const sessions: SmtcSession[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const s = item as Record<string, unknown>
    const status = typeof s['status'] === 'string' ? s['status'].trim() : ''
    /**
     * 位置：`0` 是**合法值**（歌曲开头 / 刚拖动到 0 秒）。
     *
     * 旧写法 `Number(pos) > 0 ? Number(pos) : 0` 把 0 与「读不到」都归成 0，
     * 结果「从中途开始播放」时若播放器先报了 0，就会被当成真实位置去锚定。
     * 这里只在「根本不是有限数字」时才回落 0，并用量标志区分是否读到。
     */
    const rawPos = Number(s['pos'])
    const posKnown = Number.isFinite(rawPos)
    const rawEnd = Number(s['end'])
    /**
     * 时间轴起点：只在「是有限的非负数」时采用，否则按 0 处理。
     *
     * 负值 / NaN 都说明没读到或值异常，回落 0 等价于「按常规时间轴处理」，
     * 这是最安全的行为（绝大多数曲目 start 就是 0）。
     */
    const rawStart = Number(s['start'])
    const start = Number.isFinite(rawStart) && rawStart > 0 ? rawStart : 0
    /**
     * `LastUpdatedTime`：`Position` 所属的时刻（epoch ms）。
     *
     * 实机采样（网易云暂停时）看到过这样的值：
     *
     *     status=Paused, pos=0, start=0, end=0, updated=-11644473600000
     *
     * `-11644473600000` 是 1601-01-01（Windows FILETIME 纪元）的 Unix 毫秒值，
     * 也就是 `.NET DateTimeOffset` 的零值 —— 表示「这个字段没有有意义的值」。
     * 这里把一切 `<= 0` 的都归一成 0（未读到），下游 `isUsableTimestamp` 会再挡一次
     * 「早于 2000 年」的各种哨兵变体，两道防线都不可省：
     * 若拿它去参与时间差外推，位置会被推到几百年之后。
     */
    const rawUpdated = Number(s['updated'])
    const updatedAt = Number.isFinite(rawUpdated) && rawUpdated > 0 ? rawUpdated : 0
    sessions.push({
      aumid: typeof s['aumid'] === 'string' ? s['aumid'] : '',
      source: typeof s['source'] === 'string' ? s['source'].trim() : '',
      title: typeof s['title'] === 'string' ? s['title'] : '',
      artist: typeof s['artist'] === 'string' ? s['artist'] : '',
      album: typeof s['album'] === 'string' ? s['album'] : '',
      status: (status as SmtcSession['status']) ?? '',
      // 空串 = PowerShell 那段 try/catch 没拿到状态，不能当作「没在播放」。
      statusKnown: status !== '',
      start,
      pos: posKnown && rawPos >= 0 ? rawPos : 0,
      updatedAt,
      end: Number.isFinite(rawEnd) && rawEnd > 0 ? rawEnd : 0
    })
  }
  return { ts: Number.isFinite(ts) ? ts : Date.now(), sessions }
}

/**
 * 启动采样循环，返回「停止」函数（幂等）。
 *
 * `onSample` 每 ~400ms 被调用一次；进程异常退出会自动重拉（3 秒起，逐次退避到 30 秒），
 * 这样用户在任务管理器里手动结束 PowerShell、或系统更新重启 WMI，都不需要重开启动器。
 */
export function startSmtcPoller(
  onSample: (sample: SmtcSample) => void,
  onError?: (message: string) => void
): () => void {
  if (!isSmtcSupported()) return () => undefined

  let stopped = false
  let child: SmtcProcess | null = null
  let restartTimer: NodeJS.Timeout | null = null
  let restartDelay = 3000
  let lastError = ''

  const report = (message: string): void => {
    // 同样的错误只报一次，避免每 3 秒刷一行日志。
    if (message === lastError) return
    lastError = message
    onError?.(message)
  }

  const spawnOnce = (): void => {
    if (stopped) return
    let proc: SmtcProcess
    try {
      proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(SMTC_SCRIPT)],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
    } catch (err) {
      report(`无法启动 powershell.exe：${err instanceof Error ? err.message : String(err)}`)
      scheduleRestart()
      return
    }
    child = proc
    const rl = createInterface({ input: proc.stdout })
    rl.on('line', (line) => {
      const sample = parseLine(line)
      if (!sample) return
      // 成功吐出数据说明链路恢复正常，把退避时间收回去。
      restartDelay = 3000
      lastError = ''
      onSample(sample)
    })
    // stderr：PowerShell 在重定向时会把「错误记录」序列化成 CLIXML（`#< CLIXML` + `<Objs>`），
    // 里面通常只是无害的告警。剥掉这层壳，只有真正的人类可读信息才写进日志。
    proc.stderr.on('data', (chunk: Buffer) => {
      const raw = chunk.toString('utf8')
      const text = raw
        .replace(/#< CLIXML/g, '')
        .split('<Objs')[0]
        .replace(/\s+/g, ' ')
        .trim()
      if (text) report(`smtc: ${text.slice(0, 200)}`)
    })
    proc.on('error', (err) => {
      report(`smtc 进程错误：${err.message}`)
    })
    proc.on('exit', () => {
      if (child === proc) child = null
      if (stopped) return
      scheduleRestart()
    })
  }

  function scheduleRestart(): void {
    if (stopped || restartTimer) return
    restartTimer = setTimeout(() => {
      restartTimer = null
      restartDelay = Math.min(Math.round(restartDelay * 1.6), 30000)
      spawnOnce()
    }, restartDelay)
  }

  spawnOnce()

  return () => {
    stopped = true
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    const proc = child
    child = null
    if (proc && !proc.killed) {
      try {
        proc.kill()
      } catch {
        /* 已退出 */
      }
    }
  }
}

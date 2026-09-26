// ---------------------------------------------------------------------------
// 自定义主页宿主。
//
// 主页脚本是「单文件 HTML」，运行在 sandbox="allow-scripts" 的 iframe 里：
//   - 没有 allow-same-origin ⇒ 不透明 origin，拿不到启动器的 DOM / 存储 / Cookie；
//   - 没有 allow-popups / allow-top-navigation / allow-forms ⇒ 不能开窗、跳转顶层、提交表单；
//   - 注入 Content-Security-Policy：默认 connect-src 'none' 彻底断网，只有用户
//     对外部地址清单逐条确认后才放宽；
//   - 注入 SDK，脚本通过 window.hc 使用宿主能力（postMessage 白名单桥）。
//
// 宿主能力（与需求一一对应）：总内存 / 已用内存 / 分配给游戏的内存（可改）/
// 玩家头像 / 玩家名 / 版本列表 / 选中版本（可改）/ 选中版本的加载器与版本号 /
// 启动器版本号 / 运行日志（仅 Debug 模式）/ 启动游戏（带 Java 检测回退）/
// 结束游戏 / 运行状态 / 明暗模式 / 当前主题。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  HomepageSource,
  InstalledVersion,
  LaunchOptions,
  MinecraftAccount,
  SystemMemoryInfo
} from '@shared/types'
import { scanHomepageCode } from '@shared/homepage-runtime'
import { useApp } from '../store'
import { useRuntime } from '../runtime'
import { HomepageGate } from '../components/HomepageGate'
import { LoadingState, yggdrasilOrigin } from '../components/ui'
import { HomePage } from './HomePage'

/** 注入 iframe 的设计令牌：宿主变量名 → 暴露给脚本的 --hc-* 变量名。 */
const TOKENS: Array<[string, string]> = [
  ['--hc-text-primary', '--text-primary'],
  ['--hc-text-secondary', '--text-secondary'],
  ['--hc-text-tertiary', '--text-tertiary'],
  ['--hc-fill-primary', '--fill-primary'],
  ['--hc-fill-secondary', '--fill-secondary'],
  ['--hc-fill-danger', '--fill-danger'],
  ['--hc-fill-success', '--fill-success'],
  ['--hc-glass-bg', '--glass-bg'],
  ['--hc-glass-border', '--glass-border'],
  ['--hc-divider', '--divider'],
  ['--hc-scrim', '--scrim']
]

/**
 * 沙箱内 SDK。写在字符串里以免被构建工具包装或改名。
 * 只暴露白名单能力；所有调用都是异步 Promise，10 秒无响应即超时。
 */
const SDK = [
  '(function () {',
  "  'use strict'",
  '  var pending = new Map()',
  '  var seq = 0',
  '  var listeners = Object.create(null)',
  '  var snapshot = {}',
  '  var cspMeta = document.getElementById("hc-csp")',
  '  var cspContent = cspMeta ? cspMeta.getAttribute("content") : ""',
  '',
  '  function on(name) {',
  '    return function (cb) {',
  '      if (typeof cb !== "function") return function () {}',
  '      if (!listeners[name]) listeners[name] = []',
  '      listeners[name].push(cb)',
  '      return function () {',
  '        var i = listeners[name].indexOf(cb)',
  '        if (i >= 0) listeners[name].splice(i, 1)',
  '      }',
  '    }',
  '  }',
  '',
  '  function emit(name, payload) {',
  '    var arr = listeners[name] || []',
  '    for (var i = 0; i < arr.length; i++) {',
  '      try { arr[i](payload) } catch (e) { console.error("[hc] 回调异常: " + e) }',
  '    }',
  '  }',
  '',
  '  function send(method, params) {',
  '    return new Promise(function (resolve, reject) {',
  '      var id = ++seq',
  '      pending.set(id, { resolve: resolve, reject: reject })',
  '      parent.postMessage({ hc: 1, kind: "call", id: id, method: method, params: params || {} }, "*")',
  '      setTimeout(function () {',
  '        if (pending.has(id)) { pending.delete(id); reject(new Error("调用超时：" + method)) }',
  '      }, 10000)',
  '    })',
  '  }',
  '',
  '  function applyTokens(tokens) {',
  '    if (!tokens) return',
  '    var root = document.documentElement',
  '    for (var k in tokens) {',
  '      if (Object.prototype.hasOwnProperty.call(tokens, k)) root.style.setProperty(k, tokens[k])',
  '    }',
  '  }',
  '',
  '  window.addEventListener("message", function (e) {',
  '    var d = e.data',
  '    if (!d || d.hc !== 1) return',
  '    if (d.kind === "result") {',
  '      var p = pending.get(d.id)',
  '      if (!p) return',
  '      pending.delete(d.id)',
  '      if (d.ok) p.resolve(d.data)',
  '      else p.reject(new Error(d.error || "调用失败"))',
  '      return',
  '    }',
  '    if (d.kind === "log") { emit("log", d.data); return }',
  '    if (d.kind === "init" || d.kind === "update") {',
  '      applyTokens(d.data && d.data.tokens)',
  '      snapshot = (d.data && d.data.snapshot) || {}',
  '      emit("update", snapshot)',
  '      return',
  '    }',
  '  })',
  '',
  '  // CSP 看门狗：脚本若移除策略 meta，立即按原内容补回。',
  '  function guard() {',
  '    if (!cspContent || !window.MutationObserver) return',
  '    try {',
  '      var head = document.head || document.documentElement',
  '      new MutationObserver(function () {',
  '        if (document.getElementById("hc-csp")) return',
  '        var m = document.createElement("meta")',
  '        m.id = "hc-csp"',
  '        m.setAttribute("http-equiv", "Content-Security-Policy")',
  '        m.setAttribute("content", cspContent)',
  '        head.insertBefore(m, head.firstChild)',
  '      }).observe(document.documentElement, { childList: true, subtree: true })',
  '    } catch (e) {}',
  '  }',
  '',
  '  var api = {',
  '    version: "1.0",',
  '    onReady: on("ready"),',
  '    onUpdate: on("update"),',
  '    onLog: on("log"),',
  '    state: function () { return snapshot },',
  '    system: { memory: function () { return send("system.memory") } },',
  '    settings: {',
  '      memory: {',
  '        get: function () { return send("settings.memory.get") },',
  '        set: function (mb) { return send("settings.memory.set", { memoryMb: mb }) }',
  '      }',
  '    },',
  '    account: {',
  '      current: function () { return send("account.current") },',
  '      avatar: function () { return send("account.avatar") }',
  '    },',
  '    versions: {',
  '      list: function () { return send("versions.list") },',
  '      selected: function () { return send("versions.selected") },',
  '      select: function (id) { return send("versions.select", { id: id }) },',
  '      info: function () { return send("versions.info") },',
  '      loader: function () { return send("versions.loader") },',
  '      number: function () { return send("versions.number") }',
  '    },',
  '    launcher: { version: function () { return send("launcher.version") } },',
  '    game: {',
  '      launch: function () { return send("game.launch") },',
  '      stop: function () { return send("game.stop") },',
  '      state: function () { return send("game.state") }',
  '    },',
  '    log: {',
  '      info: function (m) { return send("log.write", { level: "info", message: String(m) }) },',
  '      warn: function (m) { return send("log.write", { level: "warn", message: String(m) }) },',
  '      error: function (m) { return send("log.write", { level: "error", message: String(m) }) }',
  '    },',
  '    theme: { get: function () { return send("theme.get") } },',
  '    openExternal: function (url) { return send("shell.openExternal", { url: url }) }',
  '  }',
  '',
  '  try {',
  '    Object.defineProperty(window, "hc", { value: api, writable: false, configurable: false })',
  '  } catch (e) { window.hc = api }',
  '',
  '  // ---- 运行时安全探针 ----',
  '  // 每个「新加载进来的元素」与「动态写入/执行的源码」都要交给宿主检查：',
  '  // 脚本可以用字符串拼接绕过静态匹配，只能在运行时按实际发生的行为再查一遍。',
  '  var probeQueue = []',
  '  var probeChars = 0',
  '  var probeScheduled = false',
  '  var probeDropped = false',
  '  var PROBE_MAX_ITEMS = 20000',
  '  var PROBE_MAX_CHARS = 200000',
  '',
  '  function scheduleProbe() {',
  '    if (probeScheduled) return',
  '    probeScheduled = true',
  '    if (window.requestAnimationFrame) window.requestAnimationFrame(flushProbe)',
  '    else setTimeout(flushProbe, 16)',
  '  }',
  '',
  '  function flushProbe() {',
  '    probeScheduled = false',
  '    if (!probeQueue.length) return',
  '    var batch = probeQueue.splice(0, 200)',
  '    for (var k = 0; k < batch.length; k++) probeChars -= batch[k].text.length',
  '    if (probeDropped) { probeDropped = false; batch.push({ where: "element-flood", text: "" }) }',
  '    if (probeQueue.length) scheduleProbe()',
  '    parent.postMessage({ hc: 1, kind: "probe", batch: batch }, "*")',
  '  }',
  '',
  '  function probe(where, text) {',
  '    if (text === null || text === undefined) return',
  '    var s = String(text)',
  '    if (!s) return',
  '    if (s.length > 8000) s = s.slice(0, 8000)',
  '    if (probeQueue.length >= PROBE_MAX_ITEMS || probeChars >= PROBE_MAX_CHARS) {',
  '      probeDropped = true',
  '      return',
  '    }',
  '    probeQueue.push({ where: where, text: s })',
  '    probeChars += s.length',
  '    scheduleProbe()',
  '  }',
  '',
  '  var WATCH_TAGS = { SCRIPT: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, FORM: 1, BASE: 1, META: 1, LINK: 1, A: 1 }',
  '  var WATCH_ATTR = { LINK: "href", A: "href" }',
  '',
  '  function probeNode(n) {',
  '    try {',
  '      var tag = n.tagName ? String(n.tagName).toUpperCase() : ""',
  '      if (!WATCH_TAGS[tag]) return',
  '      var name = "element:" + tag.toLowerCase()',
  '      var attr = WATCH_ATTR[tag]',
  '      if (attr) { probe(name, attr + "=" + (n.getAttribute(attr) || "")); return }',
  '      if (tag === "SCRIPT") {',
  '        var src = n.getAttribute("src") || ""',
  '        probe(name + ":src", src)',
  '        if (!src) probe(name + ":inline", n.textContent || "")',
  '        return',
  '      }',
  '      probe(name, n.outerHTML || "")',
  '    } catch (e) {}',
  '  }',
  '',
  '  function watch() {',
  '    if (window.MutationObserver) {',
  '      try {',
  '        new window.MutationObserver(function (records) {',
  '          for (var i = 0; i < records.length; i++) {',
  '            var added = records[i].addedNodes',
  '            for (var j = 0; j < added.length; j++) {',
  '              var n = added[j]',
  '              if (n && n.nodeType === 1) probeNode(n)',
  '            }',
  '          }',
  '        }).observe(document.documentElement, { childList: true, subtree: true })',
  '      } catch (e) {}',
  '    }',
  '    try {',
  '      var rawWrite = document.write',
  '      if (typeof rawWrite === "function") {',
  '        document.write = function (s) { probe("document.write", s); return rawWrite.apply(document, arguments) }',
  '      }',
  '    } catch (e) {}',
  '    try {',
  '      var rawWriteln = document.writeln',
  '      if (typeof rawWriteln === "function") {',
  '        document.writeln = function (s) { probe("document.writeln", s); return rawWriteln.apply(document, arguments) }',
  '      }',
  '    } catch (e) {}',
  '    try {',
  '      var rawEval = window.eval',
  '      if (typeof rawEval === "function") {',
  '        window.eval = function (s) { probe("eval", s); return rawEval.apply(window, arguments) }',
  '      }',
  '    } catch (e) {}',
  '    var wrapTimer = function (name) {',
  '      var raw = window[name]',
  '      if (typeof raw !== "function") return',
  '      window[name] = function (fn) {',
  '        if (typeof fn === "string") probe(name + ":string", fn)',
  '        return raw.apply(window, arguments)',
  '      }',
  '    }',
  '    wrapTimer("setTimeout")',
  '    wrapTimer("setInterval")',
  '  }',
  '',
  '  guard()',
  '  watch()',
  '  parent.postMessage({ hc: 1, kind: "hello" }, "*")',
  '  emit("ready", snapshot)',
  '})()'
].join('\n')

/**
 * SDK 语法自检（模块加载时执行一次）。
 *
 * SDK 是字符串常量，tsc 与构建都不会校验其内部语法：一处笔误（例如漏写逗号）
 * 就会让整块 SDK 解析失败、window.hc 永不挂载，而且运行期没有任何提示。
 *
 * 渲染进程的 CSP 是 script-src 'self' 'unsafe-inline'（不含 'unsafe-eval'），
 * new Function / eval 会被直接拦成 EvalError，所以这里改用「插入一段只解析、不执行的
 * <script>」：把源码包进一个永不调用的函数，语法错误会以 SyntaxError 形式上报到
 * window 的 error 事件，从而在不放宽 CSP 的前提下完成自检。
 */
function checkSdkSyntax(): void {
  let settled = false
  const script = document.createElement('script')
  script.textContent = `void function () {\n${SDK}\n}`

  const onError = (e: ErrorEvent): void => {
    if (settled) return
    // 只认「本文档内联脚本」的语法错误，避免把别处的运行时错误算到 SDK 头上
    if (e.filename && e.filename !== location.href) return
    if (!(e.error instanceof SyntaxError)) return
    settled = true
    window.removeEventListener('error', onError, true)
    const detail = `SDK 存在语法错误，window.hc 将不可用：${e.error.message}`
    console.error('[自定义主页]', detail)
    try {
      window.api.homepage.log('error', `[自定义主页] ${detail}`)
    } catch {
      /* 启动早期日志通道可能尚未就绪，此时仅保留控制台输出 */
    }
  }

  window.addEventListener('error', onError, true)
  ;(document.head ?? document.documentElement).appendChild(script)
  script.remove()
  // 解析失败是异步上报的：留一个短窗口后撤掉监听，避免长期占用 error 事件。
  window.setTimeout(() => {
    if (settled) return
    settled = true
    window.removeEventListener('error', onError, true)
  }, 50)
}

checkSdkSyntax()

/** 选中版本的加载器 / 版本号摘要。 */
interface SelectedVersionInfo {
  id: string
  /** 版本号（Minecraft 版本，如 1.21.4）。 */
  number: string
  /** 加载器标识（fabric / quilt / forge / neoforge），原版为空串。 */
  loader: string
  /** 加载器显示名，无加载器为「原版」。 */
  loaderName: string
}

/** 宿主 → 脚本的初始/增量载荷。 */
interface HostSnapshot {
  memory: SystemMemoryInfo | null
  /** 分配给游戏的内存（MB），脚本可通过 hc.settings.memory.set 修改。 */
  allocatedMemory: number
  account: { name: string; id: string; avatarUrl: string; authType: string } | null
  versions: InstalledVersion[]
  selectedVersionId: string
  /** 选中版本的加载器与版本号；无已安装版本时为 null。 */
  selectedVersion: SelectedVersionInfo | null
  /** 启动器版本号（如 0.4.11）。 */
  launcherVersion: string
  launch: {
    state: string | null
    running: boolean
    starting: boolean
    busy: boolean
    pid: number | null
    /** 仅 Debug 模式为 true；为 false 时宿主不推送日志。 */
    debug: boolean
  }
  theme: { mode: 'light' | 'dark'; setting: string; accentColor: string; background: string }
}

interface FrameCall {
  hc: 1
  kind: 'call'
  id: number
  method: string
  params?: Record<string, unknown>
}

interface FrameHello {
  hc: 1
  kind: 'hello'
}

/** 沙箱内运行时探针上报：新增元素 / 动态写入的源码，需要宿主再查一遍。 */
interface FrameProbe {
  hc: 1
  kind: 'probe'
  batch?: Array<{ where?: string; text?: string }>
}

/** 探针队列溢出（脚本在极短时间内插入海量元素）：按规避检查处理。 */
const FLOOD_WHERE = 'element-flood'

/** 加载器显示名，与内置页 HomePage 的保持一致：无加载器即「原版」。 */
function loaderLabel(loader: string | null): string {
  if (!loader) return '原版'
  return loader.charAt(0).toUpperCase() + loader.slice(1)
}

/** 推导玩家头像地址（与启动器内头像组件的优先级保持一致）。 */
function avatarUrl(acc: MinecraftAccount | null): string {
  if (!acc) return ''
  const hash = acc.skinUrl?.match(/([0-9a-f]{64})/i)?.[1]
  if (acc.authType === 'yggdrasil') {
    const origin = yggdrasilOrigin(acc.yggdrasilServer ?? '')
    if (origin) return `${origin}/avatar/player/${encodeURIComponent(acc.name)}`
  }
  if (hash) return `https://textures.minecraft.net/texture/${hash}`
  if (acc.offline) return ''
  return `https://mc-heads.net/avatar/${acc.id}`
}

/** 组装 iframe 的 CSP：默认断网，仅保留内联脚本/样式与 data: 资源。 */
function buildCsp(networkApproved: boolean, avatarHost: string): string {
  const dirs: string[] = []
  const add = (name: string, values: string): void => {
    dirs.push(`${name} ${values}`)
  }
  add('default-src', "'none'")
  add('script-src', networkApproved ? "'unsafe-inline' https:" : "'unsafe-inline'")
  add('style-src', networkApproved ? "'unsafe-inline' https:" : "'unsafe-inline'")
  const img = ['data:', 'blob:']
  // 头像图来自启动器自身使用的官方/认证站源，与脚本外链无关，单独放行。
  if (avatarHost) img.push(avatarHost)
  if (networkApproved) img.push('https:')
  add('img-src', img.join(' '))
  add('font-src', networkApproved ? 'data: https:' : 'data:')
  add('media-src', networkApproved ? 'data: https:' : "'none'")
  add('connect-src', networkApproved ? 'https:' : "'none'")
  add('form-action', "'none'")
  add('frame-src', "'none'")
  add('object-src', "'none'")
  add('base-uri', "'none'")
  return dirs.join('; ')
}

/** 把注入内容插到 <head> 最前面；没有 head 就补一个。 */
function buildSrcDoc(html: string, inject: string): string {
  const head = /<head[^>]*>/i.exec(html)
  if (head) {
    const at = head.index + head[0].length
    return html.slice(0, at) + inject + html.slice(at)
  }
  const htmlTag = /<html[^>]*>/i.exec(html)
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length
    return `${html.slice(0, at)}<head>${inject}</head>${html.slice(at)}`
  }
  return `<!DOCTYPE html><html><head>${inject}</head><body>${html}</body></html>`
}

/** 「启动游戏」板块的替代界面：有自定义主页时顶替内置启动页。 */
export function HomeRoute(): JSX.Element {
  const { settings } = useApp()
  if (!settings.homepageId) return <HomePage />
  return <CustomHomePage key={settings.homepageId} id={settings.homepageId} />
}

export function CustomHomePage({ id }: { id: string }): JSX.Element {
  const { settings, selectedAccount, theme, updateSettings, reloadSettings, raiseSecurityAlert } = useApp()
  const { launchState, launchLog, launchPid, busy, launch, stopLaunch } = useRuntime()

  const [entry, setEntry] = useState<HomepageSource | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 本次会话已通过安全闸门。 */
  const [passed, setPassed] = useState(false)
  const [memInfo, setMemInfo] = useState<SystemMemoryInfo | null>(null)
  const [installed, setInstalled] = useState<InstalledVersion[]>([])
  /** 启动器版本号（暴露给脚本，用于自检 / 提示最低版本）。 */
  const [launcherVersion, setLauncherVersion] = useState('')

  const frameRef = useRef<HTMLIFrameElement>(null)
  const dispatchRef = useRef<(method: string, params: Record<string, unknown>) => Promise<unknown>>(
    async () => null
  )
  const sentLogRef = useRef(0)

  /* ---------------- 数据装载 ---------------- */

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const src = await window.api.homepage.read(id)
        if (alive) setEntry(src)
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    void (async () => {
      try {
        const list = await window.api.installed.list()
        if (alive) setInstalled(list)
      } catch {
        /* 已安装列表偶发失败不阻塞主页 */
      }
    })()
    void (async () => {
      try {
        const v = await window.api.getVersion()
        if (alive) setLauncherVersion(v)
      } catch {
        /* 取不到版本号不影响主页运行 */
      }
    })()
    const refreshMemory = (): void => {
      void window.api.system.memory().then(
        (m) => alive && setMemInfo(m),
        () => alive && setMemInfo(null)
      )
    }
    refreshMemory()
    const timer = setInterval(refreshMemory, 30000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [id])

  /* ---------------- 选中版本 ---------------- */

  // 选中版本持久化在设置里，脚本与内置页共享；首次进入时回落到第一个已安装版本。
  useEffect(() => {
    if (installed.length === 0) return
    if (installed.some((v) => v.id === settings.selectedVersionId)) return
    void updateSettings({ selectedVersionId: installed[0].id })
  }, [installed, settings.selectedVersionId, updateSettings])

  const selectedVersionId = useMemo(
    () =>
      installed.some((v) => v.id === settings.selectedVersionId)
        ? settings.selectedVersionId
        : installed[0]?.id ?? '',
    [installed, settings.selectedVersionId]
  )

  const selectedVersion = useMemo<SelectedVersionInfo | null>(() => {
    const v = installed.find((item) => item.id === selectedVersionId)
    if (!v) return null
    return {
      id: v.id,
      number: v.mcVersion || v.id,
      loader: v.loader ?? '',
      loaderName: loaderLabel(v.loader)
    }
  }, [installed, selectedVersionId])

  const accountInfo = useMemo(
    () =>
      selectedAccount
        ? {
            name: selectedAccount.name,
            id: selectedAccount.id,
            avatarUrl: avatarUrl(selectedAccount),
            authType: selectedAccount.authType ?? (selectedAccount.offline ? 'offline' : 'microsoft')
          }
        : null,
    [selectedAccount]
  )

  const starting =
    launchState === 'starting' || launchState === 'downloading' || launchState === 'launching'
  const running = launchState === 'running'

  /* ---------------- 运行时安全拦截 ---------------- */

  /** 已触发过封锁：同一脚本的多次命中只提示一次。 */
  const lockedRef = useRef(false)

  /**
   * 运行时发现「删除 / 修改文件、格式化、伪装代码」时立即处置：
   *   1. 立刻弹出全屏提示（同步执行，先于异步的停用动作）；
   *   2. 封锁该脚本并停用（主进程顺手清空 homepageId）；
   *   3. 刷新设置，让「启动游戏」页退回内置界面 —— 遮罩仍在最上层，脚本不会再跑。
   *
   * 检查点有两处：每条指令运行前、沙箱内每个元素加载后（见下面的 dispatch 与 probe）。
   */
  const lockdown = useCallback(
    (reason: string, detail: string): void => {
      if (lockedRef.current) return
      lockedRef.current = true
      raiseSecurityAlert({ homepageId: id, reason, detail })
      void (async () => {
        try {
          await window.api.homepage.block(id, reason)
        } catch {
          /* 封锁失败也必须继续停用 */
        }
        try {
          await reloadSettings()
        } catch {
          /* 忽略 */
        }
      })()
    },
    [id, raiseSecurityAlert, reloadSettings]
  )

  /* ---------------- 能力桥 ---------------- */

  const clampMemory = useCallback(
    (raw: unknown): number => {
      const mb = Math.round(Number(raw))
      if (!Number.isFinite(mb)) throw new Error('内存参数非法')
      const cap = Math.max(1024, Math.floor((memInfo?.free ?? 16384) / 512) * 512)
      return Math.max(1024, Math.min(mb, cap))
    },
    [memInfo]
  )

  const dispatch = useCallback(
    async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      // 每条指令运行前都过一遍安全检查：脚本可能把危险代码藏进参数交给宿主执行。
      let probeText = method
      try {
        probeText = `${method} ${JSON.stringify(params ?? {})}`
      } catch {
        /* 参数不可序列化时只查方法名 */
      }
      const hits = scanHomepageCode(probeText, 'payload')
      if (hits.length > 0) {
        lockdown(hits[0], `指令 ${method}：${hits.join('；')}`)
        throw new Error('该指令被安全策略拦截，已停用该主页')
      }
      switch (method) {
        case 'system.memory':
          return memInfo
        case 'settings.memory.get':
          return settings.memoryMb
        case 'settings.memory.set': {
          const mb = clampMemory(params['memoryMb'])
          await updateSettings({ memoryMb: mb })
          return mb
        }
        case 'account.current':
          return accountInfo
        case 'account.avatar':
          return accountInfo?.avatarUrl ?? ''
        case 'versions.list':
          return installed
        case 'versions.selected':
          return selectedVersionId
        case 'versions.select': {
          const next = String(params['id'] ?? '')
          if (!installed.some((v) => v.id === next)) throw new Error(`版本不可用：${next || '(空)'}`)
          await updateSettings({ selectedVersionId: next })
          return next
        }
        case 'versions.info':
          return selectedVersion
        case 'versions.loader':
          // 无选中版本时同样视为「原版」：它没有加载器。
          return selectedVersion?.loaderName ?? '原版'
        case 'versions.number':
          return selectedVersion?.number ?? ''
        case 'launcher.version':
          return launcherVersion
        case 'game.state':
          return {
            state: launchState,
            running,
            starting,
            busy,
            pid: launchPid,
            versionId: selectedVersionId,
            debug: settings.debugMode
          }
        case 'game.launch': {
          // 回退：无账号 / 无已安装版本时给出可读错误；Java 不兼容由运行时的 Java 提示接管。
          if (!selectedAccount) throw new Error('尚未登录账号，请先在「账号」页登录')
          if (!selectedVersionId) throw new Error('没有已安装的游戏版本，请先在「资源下载」页安装')
          const opts: LaunchOptions = {
            versionId: selectedVersionId,
            accountId: selectedAccount.id,
            gameDir: settings.gameDir,
            memoryMb: settings.memoryMb,
            javaPath: settings.javaPath || undefined
          }
          await launch(opts)
          return { ok: true, versionId: selectedVersionId }
        }
        case 'game.stop':
          if (!running && !starting && !busy) return { ok: true, stopped: false }
          stopLaunch()
          return { ok: true, stopped: true }
        case 'log.write': {
          const level = params['level']
          const message = String(params['message'] ?? '')
          window.api.homepage.log(
            level === 'warn' || level === 'error' ? level : 'info',
            message.slice(0, 4000)
          )
          return null
        }
        case 'theme.get':
          return {
            mode: theme,
            setting: settings.theme,
            accentColor: settings.accentColor,
            background: settings.background,
            reducedMotion: settings.reducedMotion,
            debug: settings.debugMode
          }
        case 'shell.openExternal': {
          if (!entry?.networkApproved) throw new Error('该脚本未获得联网授权，禁止打开外部链接')
          const url = String(params['url'] ?? '')
          if (!/^https?:\/\//i.test(url)) throw new Error('仅允许打开 http/https 链接')
          await window.api.shell.openExternal(url)
          return url
        }
        default:
          throw new Error(`不支持的接口：${method}`)
      }
    },
    [
      memInfo,
      clampMemory,
      lockdown,
      updateSettings,
      settings.memoryMb,
      settings.gameDir,
      settings.javaPath,
      settings.debugMode,
      settings.theme,
      settings.accentColor,
      settings.background,
      settings.reducedMotion,
      accountInfo,
      installed,
      selectedVersionId,
      selectedVersion,
      launcherVersion,
      launchState,
      running,
      starting,
      busy,
      launchPid,
      selectedAccount,
      launch,
      stopLaunch,
      entry?.networkApproved,
      theme
    ]
  )

  // 每次渲染后刷新，保证消息处理器始终调用最新的能力实现。
  useEffect(() => {
    dispatchRef.current = dispatch
  })

  const readTokens = useCallback((): Record<string, string> => {
    const cs = getComputedStyle(document.documentElement)
    const out: Record<string, string> = {}
    for (const [target, source] of TOKENS) {
      const value = cs.getPropertyValue(source).trim()
      if (value) out[target] = value
    }
    out['--hc-accent'] = settings.accentColor
    return out
  }, [settings.accentColor])

  const snapshot: HostSnapshot = useMemo(
    () => ({
      memory: memInfo,
      allocatedMemory: settings.memoryMb,
      account: accountInfo,
      versions: installed,
      selectedVersionId,
      selectedVersion,
      launcherVersion,
      launch: {
        state: launchState,
        running,
        starting,
        busy,
        pid: launchPid,
        debug: settings.debugMode
      },
      theme: {
        mode: theme,
        setting: settings.theme,
        accentColor: settings.accentColor,
        background: settings.background,
        reducedMotion: settings.reducedMotion
      }
    }),
    [
      memInfo,
      settings.memoryMb,
      settings.debugMode,
      settings.theme,
      settings.accentColor,
      settings.background,
      settings.reducedMotion,
      accountInfo,
      installed,
      selectedVersionId,
      selectedVersion,
      launcherVersion,
      launchState,
      running,
      starting,
      busy,
      launchPid,
      theme
    ]
  )

  const postToFrame = useCallback((payload: unknown): void => {
    frameRef.current?.contentWindow?.postMessage(payload, '*')
  }, [])

  // 宿主 → 脚本：hello 时回 init，之后每次快照变化推 update。令牌在 rAF 里读，
  // 确保主题切换后的计算结果样式已经生效。
  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const handle = requestAnimationFrame(() => {
      frame.contentWindow?.postMessage(
        { hc: 1, kind: 'update', data: { tokens: readTokens(), snapshot } },
        '*'
      )
    })
    return () => cancelAnimationFrame(handle)
  }, [snapshot, readTokens])

  // 脚本 → 宿主：只接受本 iframe 发来的消息。
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const frame = frameRef.current
      if (!frame || e.source !== frame.contentWindow) return
      const data = e.data as FrameCall | FrameHello | FrameProbe | null
      if (!data || typeof data !== 'object' || data.hc !== 1) return

      // 沙箱内「每个元素加载」后的探针：把新增元素 / 动态写入的源码再查一遍。
      if (data.kind === 'probe') {
        if (!Array.isArray(data.batch)) return
        for (const item of data.batch) {
          const where = String(item?.where ?? 'element')
          if (where === FLOOD_WHERE) {
            lockdown('短时间内在页面中插入大量元素，疑似规避安全检查', '运行时探针队列溢出')
            return
          }
          const hits = scanHomepageCode(String(item?.text ?? ''), 'code')
          if (hits.length > 0) {
            lockdown(hits[0], `${where}：${hits.join('；')}`)
            return
          }
        }
        return
      }

      if (data.kind === 'hello') {
        sentLogRef.current = 0
        postToFrame({ hc: 1, kind: 'init', data: { tokens: readTokens(), snapshot } })
        if (settings.debugMode && launchLog.length > 0) {
          const lines = launchLog.slice(-200)
          sentLogRef.current = launchLog.length
          postToFrame({ hc: 1, kind: 'log', data: { lines } })
        }
        return
      }

      if (data.kind !== 'call') return
      const call = data
      void (async () => {
        try {
          const result = await dispatchRef.current(call.method, call.params ?? {})
          postToFrame({ hc: 1, kind: 'result', id: call.id, ok: true, data: result ?? null })
        } catch (err) {
          postToFrame({
            hc: 1,
            kind: 'result',
            id: call.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      })()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [postToFrame, readTokens, snapshot, settings.debugMode, launchLog, lockdown])

  // 运行日志：仅在 Debug 模式推送给脚本，且只推增量。
  useEffect(() => {
    if (!settings.debugMode) {
      sentLogRef.current = launchLog.length
      return
    }
    if (launchLog.length <= sentLogRef.current) return
    const lines = launchLog.slice(sentLogRef.current)
    sentLogRef.current = launchLog.length
    postToFrame({ hc: 1, kind: 'log', data: { lines } })
  }, [launchLog, settings.debugMode, postToFrame])

  /* ---------------- 渲染 ---------------- */

  const srcDoc = useMemo(() => {
    if (!entry) return ''
    const csp = buildCsp(entry.networkApproved, accountInfo?.avatarUrl ? new URL(accountInfo.avatarUrl).origin : '')
    const inject = [
      `<meta id="hc-csp" http-equiv="Content-Security-Policy" content="${csp}">`,
      `<style id="hc-base">
        :root { color-scheme: light dark; }
        html, body { margin: 0; padding: 0; min-height: 100%; background: transparent; }
        body { font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: var(--hc-text-primary, #111); }
      </style>`,
      `<script id="hc-sdk">${SDK}</script>`
    ].join('')
    return buildSrcDoc(entry.content, inject)
  }, [entry, accountInfo?.avatarUrl])

  if (error) {
    return (
      <div className="glass flex h-full flex-col items-center justify-center gap-3 rounded-[28px] p-10 text-center">
        <div className="headline">自定义主页无法加载</div>
        <p className="caption selectable max-w-md">{error}</p>
      </div>
    )
  }

  if (!entry) return <LoadingState text="正在载入自定义主页…" />

  // 闸门放行的脚本在本会话内直接运行；已验证的联网脚本不写 confirmed，
  // 所以需要单独记住「本次已通过」，否则会在闸门与运行之间来回抖动。
  const approved = passed || (entry.risk.level !== 'reject' && entry.confirmed)

  return (
    <div className="relative h-full">
      {approved ? (
        <iframe
          ref={frameRef}
          title={entry.meta.name || '自定义主页'}
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          className="h-full w-full border-0 no-drag"
          style={{ background: 'transparent' }}
        />
      ) : (
        <HomepageGate
          id={entry.id}
          cancelLabel="使用内置界面"
          onApproved={(next) => {
            setEntry((prev) => (prev ? { ...prev, ...next } : prev))
            setPassed(true)
          }}
          onCancel={() => void window.api.homepage.setActive('')}
        />
      )}
    </div>
  )
}

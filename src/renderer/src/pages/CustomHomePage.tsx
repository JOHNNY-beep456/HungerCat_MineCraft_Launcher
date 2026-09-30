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
// 版本目录列表 / 当前版本目录（可改，版本列表随之收敛）/
// 启动器版本号 / 运行日志（仅 Debug 模式）/ 启动游戏（带 Java 检测回退）/
// 结束游戏 / 运行状态 / 明暗模式 / 当前主题。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  HomepageExternal,
  HomepageSource,
  InstalledVersion,
  LaunchOptions,
  MinecraftAccount,
  SystemMemoryInfo,
  VersionDir
} from '@shared/types'
import { scanHomepageCodeAsync } from '@shared/homepage-runtime'
import { buildSrcDoc } from '@shared/srcdoc'
import { activeGameDir, useAdaptivePolling, useApp, versionDirLabel } from '../store'
import { emitCursor } from '../cursor'
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
  '  // 先按引用抓住原生 API：脚本随后可能覆盖 window.requestAnimationFrame / String /',
  '  // MutationObserver 等，让运行时探针彻底瘫痪（F-03）。此处早于任何脚本执行，',
  '  // 拿到的必然是原生实现，探针从此不受覆盖影响。',
  '  var nativeRaf = window.requestAnimationFrame',
  '  var nativeSetTimeout = window.setTimeout',
  '  var nativeString = String',
  '  var nativeObserver = window.MutationObserver',
  '  var nativeNow = Date.now',
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
  '      // 用原生定时器：脚本覆盖 window.setTimeout 也不能让 SDK 的超时保护失效（F-03）。',
  '      nativeSetTimeout(function () {',
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
  '    // 用初始化时抓住的原生观察器：脚本覆盖 window.MutationObserver 会让看门狗失效（F-03）。',
  '    if (!cspContent || typeof nativeObserver !== "function") return',
  '    try {',
  '      var head = document.head || document.documentElement',
  '      new nativeObserver(function () {',
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
  '    versionDirs: {',
  '      list: function () { return send("versiondirs.list") },',
  '      selected: function () { return send("versiondirs.selected") },',
  '      select: function (id) { return send("versiondirs.select", { id: id }) }',
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
  '  var PROBE_MAX_CHARS = 1000000',
  '  // 短时间内的元素插入速率：脚本可能一次性插入海量元素，把危险载荷挤出探针队列（F-06 / B07）。',
  '  // 队列长度会被逐帧排空，单看队列会漏判，所以要额外按「每秒插入量」判断。',
  '  var burstCount = 0',
  '  var burstAt = 0',
  '  var PROBE_BURST_MAX = 20000',
  '',
  '  function countInsert() {',
  '    var now = nativeNow()',
  '    if (now - burstAt > 1000) { burstAt = now; burstCount = 0 }',
  '    burstCount++',
  '    if (burstCount > PROBE_BURST_MAX) {',
  '      // 达标即刻预约上报：离屏洪水不经过 MutationObserver，探针队列可能一直是空的，',
  '      // 不能再指望 probe() 来触发 flushProbe，否则 element-flood 永远发不出去（F-06 / B07）。',
  '      probeDropped = true',
  '      scheduleProbe()',
  '    }',
  '  }',
  '',
  '  function scheduleProbe() {',
  '    if (probeScheduled) return',
  '    probeScheduled = true',
  '    // 用初始化时抓住的原生引用：脚本覆盖 window.requestAnimationFrame 也瘫痪不了探针（F-03 / B02）。',
  '    if (typeof nativeRaf === "function") nativeRaf(flushProbe)',
  '    else nativeSetTimeout(flushProbe, 16)',
  '  }',
  '',
  '  function flushProbe() {',
  '    probeScheduled = false',
  '    // 队列空但已判定洪水时也要上报：element-flood 是 fail-closed 信号，不能被早退吞掉（B07）。',
  '    if (!probeQueue.length && !probeDropped) return',
  '    var batch = probeQueue.splice(0, 200)',
  '    for (var k = 0; k < batch.length; k++) probeChars -= batch[k].text.length',
  '    if (probeDropped) { probeDropped = false; batch.push({ where: "element-flood", text: "" }) }',
  '    if (probeQueue.length) scheduleProbe()',
  '    parent.postMessage({ hc: 1, kind: "probe", batch: batch }, "*")',
  '  }',
  '',
  '  function probe(where, text) {',
  '    if (text === null || text === undefined) return',
  '    // 用原生 String：脚本覆盖 window.String 让探针把内容转成空串以躲过检查（F-03 / B03）。',
  '    var s = nativeString(text)',
  '    if (!s) return',
  '    // 不再对单条做 8000 字符截断：截断后危险关键字可能落在被砍掉的部分，',
  '    // 只要把载荷塞到超长注释之后即可漏检（F-01 / B01）。容量由累计上限兜底。',
  '    if (probeQueue.length >= PROBE_MAX_ITEMS || probeChars >= PROBE_MAX_CHARS) {',
  '      probeDropped = true',
  '      return',
  '    }',
  '    probeQueue.push({ where: where, text: s })',
  '    probeChars += s.length',
  '    scheduleProbe()',
  '  }',
  '',
  '  // 需要观察「属性后改」的属性：脚本常先插入一个干净元素，之后再赋值 src / href（F-06 / B04 / B05）。',
  '  var URL_ATTRS = ["src", "href", "xlink:href", "action", "formaction", "poster", "data", "background", "cite", "ping", "srcset", "manifest", "longdesc"]',
  '  var ATTR_FILTER = ["src", "href", "xlink:href", "action", "formaction", "poster", "data", "background", "cite", "ping", "srcset", "manifest", "longdesc", "style", "srcdoc", "http-equiv", "content"]',
  '',
  '  // 只认 http(s):// 与 // 开头的真正外链；data: / blob: / 相对路径 / #锚点都不算。',
  '  function isExternalUrl(u) {',
  '    var s = nativeString(u).trim()',
  '    if (!s) return false',
  '    if (/^(?:data|blob|file|about|javascript|mailto|tel):/i.test(s)) return false',
  '    if (s.charAt(0) === "#") return false',
  '    return /^(?:https?:)?\\/\\//i.test(s)',
  '  }',
  '',
  '  // 外部资源 / 导航地址：交给宿主按「是否已授权联网」判断（B04 / B05）；',
  '  // javascript: 伪协议直接标记为伪装代码。',
  '  function probeUrl(where, url) {',
  '    if (url === null || url === undefined) return',
  '    var s = nativeString(url).trim()',
  '    if (!s) return',
  '    if (/^javascript:/i.test(s)) { probe("element:" + where + "#javascript", s); return }',
  '    if (/^(?:data|blob):/i.test(s)) return',
  '    if (isExternalUrl(s)) probe("net:" + where, s)',
  '  }',
  '',
  '  // CSS 里的 url(...)：外部地址按联网事件上报，是隐蔽信标的常用手法（F-06 / B09）。',
  '  function probeCss(text) {',
  '    var css = nativeString(text)',
  '    if (!css) return',
  '    if (css.length > 20000) css = css.slice(0, 20000)',
  '    var re = /url\\(\\s*["\']?([^"\')]+)["\']?\\s*\\)/gi',
  '    var m',
  '    while ((m = re.exec(css)) !== null) {',
  '      if (isExternalUrl(m[1])) probe("net:css", m[1].trim())',
  '    }',
  '  }',
  '',
  '  // 摘掉 <meta http-equiv="refresh">（F-05 / D01）：meta refresh 能让沙箱「自我导航」，',
  '  // 把拼接出的数据带出去，这条通路不受 connect-src 管辖，必须在生效「前」就地消灭。',
  '  // 立即改写 http-equiv 使其失效；再从 DOM 移除。改属性会再触发一次 attributes 记录，',
  '  // 但那时 http-equiv 已不是 refresh，函数会直接返回，不会自激。',
  '  function defuseMetaRefresh(el) {',
  '    var eq = ""',
  '    try { eq = (el.getAttribute("http-equiv") || "").toLowerCase() } catch (e) { eq = "" }',
  '    if (eq !== "refresh") return',
  '    try { if (el.setAttribute) el.setAttribute("http-equiv", "x-hc-defused") } catch (e) {}',
  '    try { if (el.removeAttribute) el.removeAttribute("content") } catch (e) {}',
  '    var drop = function () {',
  '      try { if (el.parentNode) el.parentNode.removeChild(el) } catch (e) {}',
  '    }',
  '    if (typeof nativeSetTimeout === "function") nativeSetTimeout(drop, 0)',
  '    else drop()',
  '  }',
  '',
  '  // 元素本体：先查 URL 属性（外链按联网上报），再按标签补充正文。',
  '  function probeElement(el) {',
  '    var tag = el.tagName ? nativeString(el.tagName).toUpperCase() : ""',
  '    var hasAttr = true',
  '    try { hasAttr = !el.attributes || el.attributes.length > 0 } catch (e) { hasAttr = true }',
  '    if (hasAttr) {',
  '      for (var i = 0; i < URL_ATTRS.length; i++) {',
  '        var a = URL_ATTRS[i]',
  '        var v = null',
  '        try { v = el.getAttribute ? el.getAttribute(a) : null } catch (e) { v = null }',
  '        if (v) probeUrl(tag.toLowerCase() + ":" + a, v)',
  '      }',
  '      var cv = null',
  '      try { cv = el.getAttribute ? el.getAttribute("srcdoc") : null } catch (e) { cv = null }',
  '      if (cv) probe("element:" + tag.toLowerCase() + ":srcdoc", cv)',
  '      var st = null',
  '      try { st = el.getAttribute ? el.getAttribute("style") : null } catch (e) { st = null }',
  '      if (st) probeCss(st)',
  '    }',
  '    if (tag === "SCRIPT") {',
  '      var src = ""',
  '      try { src = el.getAttribute("src") || "" } catch (e) { src = "" }',
  '      if (!src) probe("element:script:inline", el.textContent || "")',
  '      return',
  '    }',
  '    if (tag === "STYLE") {',
  '      var css = el.textContent || ""',
  '      probeCss(css)',
  '      probe("element:style", css)',
  '      return',
  '    }',
  '    if (tag === "TEMPLATE") { probe("element:template", el.innerHTML || ""); return }',
  '    if (tag === "META") {',
  '      var eq = ""',
  '      try { eq = (el.getAttribute("http-equiv") || "").toLowerCase() } catch (e) { eq = "" }',
  '      if (eq === "refresh") {',
  '        var c = ""',
  '        try { c = el.getAttribute("content") || "" } catch (e) { c = "" }',
  '        var um = /url\\s*=\\s*([^;\\s]+)/i.exec(c)',
  '        if (um) probeUrl("meta:refresh", um[1])',
  '        // 先上报再摘除：导航必须在这条 meta 生效前被消灭（F-05 / D01）。',
  '        defuseMetaRefresh(el)',
  '      }',
  '    }',
  '  }',
  '',
  '  // 递归遍历新增子树：文本节点也要查（createTextNode 注入危险内容，F-06 / B03 / B08）。',
  '  function probeSubtree(n) {',
  '    if (!n) return',
  '    if (n.nodeType === 3) { probe("text", n.data || n.nodeValue || ""); return }',
  '    if (n.nodeType !== 1) return',
  '    countInsert()',
  '    probeElement(n)',
  '    var kids = n.childNodes',
  '    if (!kids) return',
  '    for (var i = 0; i < kids.length; i++) probeSubtree(kids[i])',
  '  }',
  '',
  '  function watch() {',
  '    if (typeof nativeObserver === "function") {',
  '      try {',
  '        new nativeObserver(function (records) {',
  '          for (var i = 0; i < records.length; i++) {',
  '            var rec = records[i]',
  '            if (rec.type === "attributes") {',
  '              var an = rec.attributeName',
  '              var target = rec.target',
  '              var av = null',
  '              try { av = target.getAttribute ? target.getAttribute(an) : null } catch (e) { av = null }',
  '              if (!av) continue',
  '              if (an === "style") { probeCss(av); continue }',
  '              if (an === "srcdoc") { probe("element:iframe:srcdoc", av); continue }',
  '              var t = target.tagName ? nativeString(target.tagName).toLowerCase() : "element"',
  '              probeUrl(t + ":" + an, av)',
  '              // 先插一个干净的 meta，之后再改 http-equiv / content 造出 refresh 也要摘掉（F-05 / D01）。',
  '              if (t === "meta") defuseMetaRefresh(target)',
  '              continue',
  '            }',
  '            var added = rec.addedNodes',
  '            if (!added) continue',
  '            for (var j = 0; j < added.length; j++) probeSubtree(added[j])',
  '          }',
  '        }).observe(document.documentElement, {',
  '          childList: true,',
  '          subtree: true,',
  '          attributes: true,',
  '          attributeFilter: ATTR_FILTER',
  '        })',
  '      } catch (e) {}',
  '    }',
  '    // write / writeln 会把整页重写并按字符串注入内容。探针本身会被探针队列截断，',
  '    // 所以「是否含脚本/事件处理器」在沙箱内按完整字符串判定，再用 # 标记回传（F-10）。',
  '    var writeInject = function (s) {',
  '      var str = s === null || s === undefined ? "" : nativeString(s)',
  '      var flags = []',
  '      if (/<script[\\s>]/i.test(str)) flags.push("script")',
  '      if (/<iframe[\\s>]/i.test(str)) flags.push("iframe")',
  '      if (/\\son[a-z]+\\s*=/i.test(str)) flags.push("handler")',
  '      if (/javascript:/i.test(str)) flags.push("javascript")',
  '      return flags',
  '    }',
  '    try {',
  '      var rawWrite = document.write',
  '      if (typeof rawWrite === "function") {',
  '        document.write = function (s) {',
  '          var f = writeInject(s)',
  '          probe("document.write" + (f.length ? "#" + f.join(",") : ""), s)',
  '          return rawWrite.apply(document, arguments)',
  '        }',
  '      }',
  '    } catch (e) {}',
  '    try {',
  '      var rawWriteln = document.writeln',
  '      if (typeof rawWriteln === "function") {',
  '        document.writeln = function (s) {',
  '          var f = writeInject(s)',
  '          probe("document.writeln" + (f.length ? "#" + f.join(",") : ""), s)',
  '          return rawWriteln.apply(document, arguments)',
  '        }',
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
  '',
  '    // 元素创建洪水：脚本可以把海量节点建进离屏的 DocumentFragment，再在 setTimeout 之前',
  '    // 同步 appendChild（此刻 fragment 还是空的）——节点永远不进实时 DOM，MutationObserver',
  '    // 与插入计数都看不到。故在 createElement/createElementNS 上按「创建量/秒」直接计数，',
  '    // 创建即算，堵住这条离屏洪水通道（F-06 / B07）。',
  '    var wrapCreate = function (name) {',
  '      try {',
  '        var raw = document[name]',
  '        if (typeof raw !== "function") return',
  '        document[name] = function () {',
  '          countInsert()',
  '          return raw.apply(document, arguments)',
  '        }',
  '      } catch (e) {}',
  '    }',
  '    wrapCreate("createElement")',
  '    wrapCreate("createElementNS")',
  '',
  '    // ---- 运行时网络探针 ----',
  '    // CSP 的 connect-src 是兜底；这里再主动上报「实际发起的外部请求」的地址，',
  '    // 由宿主判断该脚本是否已获准联网 —— 拼接/模板构造出的地址静态收集不到（F-08）。',
  '    var wrapNet = function (name, where) {',
  '      var Ctor = window[name]',
  '      if (typeof Ctor !== "function") return',
  '      var wrapped = function (url) {',
  '        try { probe(where, url) } catch (e) {}',
  '        var args = [].slice.call(arguments)',
  '        if (window.Reflect && window.Reflect.construct) return window.Reflect.construct(Ctor, args)',
  '        var o = Object.create(Ctor.prototype)',
  '        Ctor.apply(o, args)',
  '        return o',
  '      }',
  '      try { window[name] = wrapped } catch (e) {}',
  '    }',
  '    try {',
  '      var rawFetch = window.fetch',
  '      if (typeof rawFetch === "function") {',
  '        window.fetch = function (input) {',
  '          try { probe("net:fetch", input && input.url ? input.url : input) } catch (e) {}',
  '          return rawFetch.apply(window, arguments)',
  '        }',
  '      }',
  '    } catch (e) {}',
  '    try {',
  '      var xhrProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype',
  '      var rawOpen = xhrProto && xhrProto.open',
  '      if (typeof rawOpen === "function") {',
  '        xhrProto.open = function (method, url) {',
  '          try { probe("net:xhr", url) } catch (e) {}',
  '          return rawOpen.apply(this, arguments)',
  '        }',
  '      }',
  '    } catch (e) {}',
  '    wrapNet("WebSocket", "net:websocket")',
  '    wrapNet("EventSource", "net:sse")',
  '    // ---- WebRTC 探针（D08）：RTCPeerConnection 完全绕过 connect-src，可借 STUN 泄露内网',
  '    // 地址、借 data channel 外发数据。任何构造都按「隐蔽通道」上报，由宿主一律封锁。',
  '    try {',
  '      var RawRTC = window.RTCPeerConnection || window.webkitRTCPeerConnection',
  '      if (typeof RawRTC === "function") {',
  '        var wrapRtc = function (Ctor) {',
  '          var Wrapped = function (cfg) {',
  '            var urls = []',
  '            try {',
  '              var servers = cfg && cfg.iceServers',
  '              if (servers && servers.length) {',
  '                for (var i = 0; i < servers.length; i++) {',
  '                  var s = servers[i] || {}',
  '                  var u = s.urls',
  '                  if (typeof u === "string") urls.push(u)',
  '                  else if (u && u.length) { for (var j = 0; j < u.length; j++) urls.push(nativeString(u[j])) }',
  '                }',
  '              }',
  '            } catch (e) {}',
  '            try { probe("danger:webrtc", "RTCPeerConnection" + (urls.length ? " iceServers=" + urls.join(",") : "")) } catch (e) {}',
  '            if (window.Reflect && window.Reflect.construct) return window.Reflect.construct(Ctor, [].slice.call(arguments))',
  '            return new Ctor(cfg)',
  '          }',
  '          try { Wrapped.prototype = Ctor.prototype } catch (e) {}',
  '          return Wrapped',
  '        }',
  '        var RtcWrapped = wrapRtc(RawRTC)',
  '        try { window.RTCPeerConnection = RtcWrapped } catch (e) {}',
  '        try { if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = RtcWrapped } catch (e) {}',
  '      }',
  '    } catch (e) {}',
  '    try {',
  '      if (navigator && typeof navigator.sendBeacon === "function") {',
  '        var rawBeacon = navigator.sendBeacon',
  '        navigator.sendBeacon = function (url) {',
  '          try { probe("net:beacon", url) } catch (e) {}',
  '          return rawBeacon.apply(navigator, arguments)',
  '        }',
  '      }',
  '    } catch (e) {}',
  '  }',
  '',
  '  guard()',
  '  watch()',
  '  // 光标光晕跟随：鼠标在 iframe 内时宿主收不到 mousemove，光晕会定格在进入前的位置。',
  '  // 这里把 iframe 内的坐标回传，宿主换算成窗口坐标后驱动光晕。仅坐标，不含脚本内容。',
  '  // 每帧最多回传一次，避免高频 mousemove 产生大量 postMessage。',
  '  try {',
  '    var cursorPending = false',
  '    var cursorX = 0',
  '    var cursorY = 0',
  '    var flushCursor = function () {',
  '      cursorPending = false',
  '      parent.postMessage({ hc: 1, kind: "cursor", x: cursorX, y: cursorY }, "*")',
  '    }',
  '    document.addEventListener("mousemove", function (e) {',
  '      cursorX = e.clientX',
  '      cursorY = e.clientY',
  '      if (cursorPending) return',
  '      cursorPending = true',
  '      if (typeof nativeRaf === "function") nativeRaf(flushCursor)',
  '      else nativeSetTimeout(flushCursor, 16)',
  '    }, { passive: true })',
  '  } catch (e) {}',
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

/** 暴露给脚本的版本目录信息：在原始字段上补一个展示名 label，方便直接渲染。 */
interface VersionDirInfo {
  /** 目录唯一 id；默认目录固定为 'default'。 */
  id: string
  /** 目录绝对路径。 */
  path: string
  /** 用户设置的别名（可为空串）。 */
  alias: string
  /** 展示名：优先别名，默认目录无别名时用「默认版本列表目录」。 */
  label: string
  /** 是否为默认目录（不可删除）。 */
  isDefault: boolean
}

/** 宿主 → 脚本的初始/增量载荷。 */
interface HostSnapshot {
  memory: SystemMemoryInfo | null
  /** 分配给游戏的内存（MB），脚本可通过 hc.settings.memory.set 修改。 */
  allocatedMemory: number
  account: { name: string; id: string; avatarUrl: string; authType: string } | null
  /** 当前版本目录下的已安装版本；切换版本目录后随之变化。 */
  versions: InstalledVersion[]
  selectedVersionId: string
  /** 选中版本的加载器与版本号；无已安装版本时为 null。 */
  selectedVersion: SelectedVersionInfo | null
  /** 版本目录列表（默认目录在最前）。 */
  versionDirs: VersionDirInfo[]
  /** 当前生效的版本目录 id；'' 或缺省视为默认目录。 */
  selectedVersionDirId: string
  /** 启动器版本号（如 0.5.0-dev2）。 */
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

/** 沙箱内鼠标移动上报：iframe 内的坐标，宿主换算成窗口坐标后驱动光标光晕。 */
interface FrameCursor {
  hc: 1
  kind: 'cursor'
  x: number
  y: number
}

/** 探针队列溢出（脚本在极短时间内插入海量元素）：按规避检查处理。 */
const FLOOD_WHERE = 'element-flood'

/** 加载器显示名，与内置页 HomePage 的保持一致：无加载器即「原版」。 */
function loaderLabel(loader: string | null): string {
  if (!loader) return '原版'
  return loader.charAt(0).toUpperCase() + loader.slice(1)
}

/** 版本目录 → 暴露给脚本的结构（补上展示名 label）。 */
function toVersionDirInfo(d: VersionDir): VersionDirInfo {
  return {
    id: d.id,
    path: d.path,
    alias: d.alias ?? '',
    label: versionDirLabel(d),
    isDefault: !!d.isDefault
  }
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

/** 取 http(s)（含协议相对 //）地址的「源」；data: / javascript: / 相对路径一律返回空串。 */
function httpOrigin(raw: unknown): string {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  try {
    if (s.startsWith('//')) return new URL(`https:${s}`).origin
    if (/^https?:\/\//i.test(s)) return new URL(s).origin
  } catch {
    return ''
  }
  return ''
}

/**
 * 授权联网时真正放行的「源」清单（F-04）：只允许安装时静态收集到、且用户在闸门看过的那些源，
 * 而不是整个 https:。CSP 与运行期探针共用这一份清单，任何越界源都视为外泄。
 */
function homepageOrigins(externals: HomepageExternal[] | undefined, extra: string[] = []): string[] {
  const set = new Set<string>()
  for (const item of externals ?? []) {
    const origin = httpOrigin(item?.url)
    if (origin) set.add(origin)
  }
  for (const e of extra) if (e) set.add(e)
  return [...set]
}

/** 组装 iframe 的 CSP：默认断网；仅在用户授权后，按「安装清单里的源」逐条放行（F-04）。 */
function buildCsp(sources: string[], avatarHost: string): string {
  const allow = sources.filter(Boolean)
  const net = allow.length > 0
  const dirs: string[] = []
  const add = (name: string, values: string): void => {
    dirs.push(`${name} ${values}`)
  }
  add('default-src', "'none'")
  add('script-src', net ? `'unsafe-inline' ${allow.join(' ')}` : "'unsafe-inline'")
  add('style-src', net ? `'unsafe-inline' ${allow.join(' ')}` : "'unsafe-inline'")
  const img = ['data:', 'blob:']
  // 头像图来自启动器自身使用的官方/认证站源，与脚本外链无关，单独放行。
  if (avatarHost) img.push(avatarHost)
  if (net) img.push(...allow)
  add('img-src', img.join(' '))
  add('font-src', net ? `data: ${allow.join(' ')}` : 'data:')
  add('media-src', net ? `data: ${allow.join(' ')}` : "'none'")
  add('connect-src', net ? allow.join(' ') : "'none'")
  add('form-action', "'none'")
  add('frame-src', "'none'")
  add('object-src', "'none'")
  add('base-uri', "'none'")
  return dirs.join('; ')
}

/** 「启动游戏」板块的替代界面：有自定义主页时顶替内置启动页。 */
export function HomeRoute(): JSX.Element {
  const { settings } = useApp()
  if (!settings.homepageId) return <HomePage />
  return <CustomHomePage key={settings.homepageId} id={settings.homepageId} />
}

export function CustomHomePage({ id }: { id: string }): JSX.Element {
  const { settings, selectedAccount, theme, updateSettings, reloadSettings, raiseSecurityAlert, t } = useApp()
  const { launchState, launchLog, launchPid, busy, launch, stopLaunch } = useRuntime()

  const [entry, setEntry] = useState<HomepageSource | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 本次会话已通过安全闸门。 */
  const [passed, setPassed] = useState(false)
  const [memInfo, setMemInfo] = useState<SystemMemoryInfo | null>(null)
  const [installed, setInstalled] = useState<InstalledVersion[]>([])
  /** 版本目录列表（默认目录在最前）。 */
  const [dirs, setDirs] = useState<VersionDir[]>([])
  /** 启动器版本号（暴露给脚本，用于自检 / 提示最低版本）。 */
  const [launcherVersion, setLauncherVersion] = useState('')

  /** 当前生效的版本目录 id；'' 视为默认目录。 */
  const activeDirId = settings.selectedVersionDirId || 'default'

  const frameRef = useRef<HTMLIFrameElement>(null)
  const dispatchRef = useRef<(method: string, params: Record<string, unknown>) => Promise<unknown>>(
    async () => null
  )
  const sentLogRef = useRef(0)
  /** 沙箱内 SDK 是否已握手（收到 hello）。用于判定 CSP/SDK 注入是否真的生效。 */
  const helloRef = useRef(false)

  /**
   * 运行时探针批次的串行链：探针扫描已异步化（分片让出事件循环），用一条 Promise 链
   * 保证批次按到达顺序处理——既不会乱序，也不会因为让出事件循环而漏掉任何一批。
   */
  const probeChainRef = useRef<Promise<void>>(Promise.resolve())

  /** 内存轮询的存活标记：组件卸载后不再 setState。 */
  const memAliveRef = useRef(true)
  useEffect(
    () => () => {
      memAliveRef.current = false
    },
    []
  )
  const refreshMemory = useCallback((): void => {
    void window.api.system.memory().then(
      (m) => memAliveRef.current && setMemInfo(m),
      () => memAliveRef.current && setMemInfo(null)
    )
  }, [])

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
        const v = await window.api.getVersion()
        if (alive) setLauncherVersion(v)
      } catch {
        /* 取不到版本号不影响主页运行 */
      }
    })()
    refreshMemory()
    return () => {
      alive = false
    }
  }, [id])

  // 已用内存轮询：常规 30s；超低占用模式下放宽周期并在窗口不可见时暂停。
  useAdaptivePolling(refreshMemory, 30000, settings.lowUsageMode)

  // 已安装版本随「当前版本目录」收敛：切换目录后重新拉取，内置选择器与脚本接口随之更新。
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const list = await window.api.installed.list()
        if (alive) setInstalled(list)
      } catch {
        /* 已安装列表偶发失败不阻塞主页 */
      }
    })()
    return () => {
      alive = false
    }
  }, [activeDirId])

  // 版本目录列表：供内置选择器与 hc.versionDirs.* 使用。
  useEffect(() => {
    void window.api.versionDirs.list().then(setDirs).catch(() => undefined)
  }, [])

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

  // 版本目录列表（含展示名），供内置选择器与 hc.versionDirs.* 共用。
  const versionDirInfos = useMemo<VersionDirInfo[]>(() => dirs.map(toVersionDirInfo), [dirs])

  // 切换版本目录：主进程持久化选中项并失效缓存，installed 副作用随之重新拉取。
  const selectVersionDir = useCallback(
    async (next: string): Promise<string> => {
      if (!dirs.some((d) => d.id === next)) throw new Error(`版本目录不可用：${next || '(空)'}`)
      if (next !== activeDirId) {
        await window.api.versionDirs.select(next)
        await reloadSettings()
      }
      return next
    },
    [dirs, activeDirId, reloadSettings]
  )

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

  // 授权联网时真正放行的「源」（F-04）：只含安装清单里的源（外加启动器自身的头像源）。
  // CSP、能力桥（openExternal）与运行期探针共用这一份清单，任何清单外的源都视为越权外泄。
  const avatarOrigin = accountInfo?.avatarUrl ? httpOrigin(accountInfo.avatarUrl) : ''
  const approvedOrigins = useMemo(
    () => homepageOrigins(entry?.risk.externals, avatarOrigin ? [avatarOrigin] : []),
    [entry, avatarOrigin]
  )

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

  /**
   * 当前生效的安全档位（开发模式专用）：
   * 仅在开发模式「已授权且已开启」时才采用用户选择的档位，否则一律为「完全模拟」。
   * 这样档位可以在设置页里保留，但离开开发模式后不会削弱正式环境的安全防护。
   */
  const securityMode = useMemo<'full' | 'warn' | 'off'>(() => {
    const granted = settings.devModeGrantedUntil > Date.now()
    if (!granted || !settings.devModeEnabled) return 'full'
    return settings.devModeSecurityMode
  }, [settings.devModeGrantedUntil, settings.devModeEnabled, settings.devModeSecurityMode])

  /**
   * 安全命中的三档处置（对应 homepage-debug.html 的 securityHit）：
   *   - off  完全关闭：不检测，直接放行；
   *   - warn 仅提示  ：写一条警告日志后放行，不阻止脚本；
   *   - full 完全模拟：照常封锁并停用该主页（返回 true，调用方应中止当前动作）。
   */
  const securityHit = useCallback(
    (reason: string, detail: string): boolean => {
      if (securityMode === 'off') return false
      if (securityMode === 'warn') {
        const line = `[安全·仅提示] ${reason}${detail ? ` ｜ ${detail}` : ''}（真实启动器会立即停用该主页）`
        console.warn(line)
        window.api.homepage.log('warn', line)
        return false
      }
      lockdown(reason, detail)
      return true
    },
    [securityMode, lockdown]
  )

  const clampMemory = useCallback(
    (raw: unknown): number => {
      const mb = Math.round(Number(raw))
      const cap = Math.max(1024, Math.floor((memInfo?.free ?? 16384) / 512) * 512)
      if (!Number.isFinite(mb)) {
        if (securityHit('主页脚本传入了非法的内存参数（疑似伪造 / 探测）', `memoryMb=${String(raw)}`)) {
          throw new Error('内存参数非法')
        }
        // 仅提示 / 完全关闭：不阻断，回落到当前设置值。
        return settings.memoryMb
      }
      if (mb < 1024 || mb > cap) {
        if (
          securityHit(
            '主页脚本请求写入超出范围的内存参数（疑似越权篡改启动配置）',
            `memoryMb=${mb}（允许 1024–${cap} MB）`
          )
        ) {
          throw new Error(`内存参数超出允许范围（1024–${cap} MB）`)
        }
        // 仅提示 / 完全关闭：夹到允许范围内，避免真的写入越权值。
        return Math.min(cap, Math.max(1024, mb))
      }
      return mb
    },
    [memInfo, securityHit, settings.memoryMb]
  )

  const dispatch = useCallback(
    async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      // 每条指令运行前都过一遍安全检查：脚本可能把危险代码藏进参数交给宿主执行。
      // 「完全关闭」档位下跳过扫描，便于开发者自由调试。
      if (securityMode !== 'off') {
        let probeText = method
        try {
          probeText = `${method} ${JSON.stringify(params ?? {})}`
        } catch {
          /* 参数不可序列化时只查方法名 */
        }
        // 异步扫描（分片让出事件循环），避免拖长指令响应；判定与同步版完全一致。
        const hits = await scanHomepageCodeAsync(probeText, 'payload')
        if (hits.length > 0) {
          if (securityHit(hits[0], `指令 ${method}：${hits.join('；')}`)) {
            throw new Error('该指令被安全策略拦截，已停用该主页')
          }
        }
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
        case 'versiondirs.list':
          return versionDirInfos
        case 'versiondirs.selected':
          return activeDirId
        case 'versiondirs.select': {
          const next = String(params['id'] ?? '')
          await selectVersionDir(next)
          return next
        }
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
            gameDir: activeGameDir(settings),
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
          // 单条日志必须折叠成一行：换行能让脚本伪造出多条「启动器日志」，
          // 在控制台 / 日志里混淆真实输出（F-14 / D07）。顺带剔除其它控制字符。
          const message = String(params['message'] ?? '')
            .replace(/[\r\n\u2028\u2029]+/g, ' ⏎ ')
            .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
            .slice(0, 4000)
          window.api.homepage.log(
            level === 'warn' || level === 'error' ? level : 'info',
            message
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
          // 只放行安装清单里声明过的源：拼接 / 运行期生成的地址静态收集不到，多半是诱骗外链（F-13 / D06 / C10③）。
          const origin = httpOrigin(url)
          if (!origin || !approvedOrigins.includes(origin)) {
            // 完全模拟：直接封锁；仅提示 / 完全关闭：放行继续打开。
            if (securityHit('脚本请求打开安装清单之外的链接（疑似诱骗外链）', url)) {
              throw new Error('该链接不在安装时声明的外部地址清单内，已拒绝打开')
            }
          }
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
      securityHit,
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
      versionDirInfos,
      activeDirId,
      selectVersionDir,
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
      approvedOrigins,
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
      versionDirs: versionDirInfos,
      selectedVersionDirId: activeDirId,
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
      versionDirInfos,
      activeDirId,
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
    /**
     * 处理一批运行时探针（新增元素 / 动态写入的源码）。
     *
     * 扫描已异步化（scanHomepageCodeAsync 分片让出事件循环），因此调用方把批次串行挂在
     * probeChainRef 上：先到的批次先处理，绝不让任何一批被跳过（漏一批 = 漏一次检测）。
     * 到达这里的元素其实已经进了 DOM，所以这里做的是「发现即封停」，真正的预防由
     * 沙箱 iframe + CSP 承担。
     */
    const handleProbeBatch = async (batch: NonNullable<FrameProbe['batch']>): Promise<void> => {
      for (const item of batch) {
        const where = String(item?.where ?? 'element')
        const text = String(item?.text ?? '')
        if (where === FLOOD_WHERE) {
          if (securityHit('短时间内在页面中插入大量元素，疑似规避安全检查', '运行时探针队列溢出')) return
          continue
        }
        // 绕过 CSP 的隐蔽通道（WebRTC / STUN）：与是否授权联网无关，一律封锁（D08）。
        if (where.startsWith('danger:')) {
          if (securityHit('脚本使用了绕过 CSP 的隐蔽通道（WebRTC，疑似外泄 / 内网探测）', `${where.slice(7)} → ${text}`)) return
          continue
        }
        // 未获准联网的脚本真的发起外部请求时立即封锁：拼接 / 模板构造出的地址静态收集不到（F-08），
        // 这是 CSP 之外的第二道兜底。
        if (where.startsWith('net:')) {
          const origin = httpOrigin(text)
          // 启动器通过 hc.account.avatar() 暴露的头像源属于宿主可信资源，不是脚本外链：
          // 无论脚本是否授权联网都放行，否则只是显示玩家头像的主页会被误判成「非法联网」。
          if (origin && avatarOrigin && origin === avatarOrigin) continue
          if (!entry?.networkApproved) {
            if (securityHit('未获准联网的脚本发起了外部请求（疑似伪装行为）', `${where.slice(4)} → ${text}`)) return
            continue
          }
          // 已授权也要比对「源」：清单只放行安装时看到的那些源，其余一律按越权外泄处理（F-04 / D03 / D04）。
          if (origin && !approvedOrigins.includes(origin)) {
            if (
              securityHit(
                '脚本访问了安装清单之外的外部地址（疑似越权外泄）',
                `${where.slice(4)} → ${text}（不在授权源清单内）`
              )
            ) {
              return
            }
          }
          continue
        }
        // write / writeln 注入脚本，或元素属性写成 javascript: 伪协议：按「伪装代码」处理（F-10 / B06）。
        if (where.includes('#')) {
          const [kind, flags] = where.split('#')
          if (
            securityHit(
              '运行时动态写入了脚本 / 事件处理器 / javascript: 伪协议内容（疑似伪装代码）',
              `${kind} 写入内容含：${flags}`
            )
          ) {
            return
          }
          continue
        }
        // 不截断：截断会让危险关键字落在被砍掉的部分而漏检（F-01 / B01）。
        // 异步扫描（分片让出事件循环）与同步版判定完全一致，只改变何时出结论。
        const hits = await scanHomepageCodeAsync(text, 'code', { maxLength: 0 })
        if (hits.length > 0) {
          if (securityHit(hits[0], `${where}：${hits.join('；')}`)) return
        }
      }
    }

    const onMessage = (e: MessageEvent): void => {
      const frame = frameRef.current
      if (!frame || e.source !== frame.contentWindow) return
      const data = e.data as FrameCall | FrameHello | FrameProbe | FrameCursor | null
      if (!data || typeof data !== 'object' || data.hc !== 1) return

      // 沙箱内鼠标移动：换算成宿主窗口坐标，驱动跟随光标的光晕（iframe 会吞掉 mousemove）。
      if (data.kind === 'cursor') {
        const rect = frame.getBoundingClientRect()
        emitCursor(rect.left + Number(data.x || 0), rect.top + Number(data.y || 0))
        return
      }

      // 沙箱内「每个元素加载」后的探针：把新增元素 / 动态写入的源码再查一遍。
      if (data.kind === 'probe') {
        if (!Array.isArray(data.batch)) return
        const batch = data.batch
        // 串行排队：保证批次顺序，且不让「让出事件循环」影响「每一批迟早都会被检查」。
        probeChainRef.current = probeChainRef.current
          .then(() => handleProbeBatch(batch))
          .catch(() => {
            /* 单批异常不阻断后续批次 */
          })
        return
      }

      if (data.kind === 'hello') {
        helloRef.current = true
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
  }, [postToFrame, readTokens, snapshot, settings.debugMode, launchLog, securityHit, entry?.networkApproved, approvedOrigins, avatarOrigin])

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
    const csp = buildCsp(entry.networkApproved ? approvedOrigins : [], avatarOrigin)
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
  }, [entry, approvedOrigins, avatarOrigin])

  // 闸门放行的脚本在本会话内直接运行；已验证的联网脚本不写 confirmed，
  // 所以需要单独记住「本次已通过」，否则会在闸门与运行之间来回抖动。
  const approved = !!entry && (passed || (entry.risk.level !== 'reject' && entry.confirmed))

  // 安全组件握手看门狗：SDK 会在解析期同步发一条 hello。迟迟收不到，说明注入点被
  // 注释 / 畸形结构劫持（F-02）——CSP 与 window.hc 都可能没生效。无法确认隔离就一律封锁，
  // 绝不带着未知状态继续跑。
  useEffect(() => {
    helloRef.current = false
  }, [srcDoc])
  useEffect(() => {
    if (!approved || !srcDoc) return
    if (securityMode === 'off') return
    const timer = window.setTimeout(() => {
      if (helloRef.current) return
      securityHit(
        '主页安全组件未生效，已拒绝运行',
        '未收到沙箱内安全检查 SDK 的握手（window.hc 缺失，CSP 也可能未注入）'
      )
    }, 6000)
    return () => window.clearTimeout(timer)
  }, [approved, srcDoc, securityMode, securityHit])

  // 主进程在导航发生「前」拦下沙箱主页的对外跳转（F-05 / D01 / D02）：meta refresh 由 SDK
  // 就地摘除、location 赋值由主进程阻断。这类导航不受 connect-src 管辖，命中即视为外泄，
  // 这里负责把全屏封锁遮罩弹出来。
  useEffect(() => {
    return window.api.homepage.onNavBlocked((url) => {
      securityHit('沙箱主页尝试跳转到外部地址（导航外泄）', url)
    })
  }, [securityHit])

  if (error) {
    return (
      <div className="glass flex h-full flex-col items-center justify-center gap-3 rounded-[28px] p-10 text-center">
        <div className="headline">{t('ch.loadFailed')}</div>
        <p className="caption selectable max-w-md">{error}</p>
      </div>
    )
  }

  if (!entry) return <LoadingState text={t('ch.loading')} />

  return (
    <div className="relative h-full">
      {approved ? (
        <iframe
          ref={frameRef}
          title={entry.meta.name || t('ch.frameTitle')}
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          className="h-full w-full border-0 no-drag"
          style={{ background: 'transparent' }}
        />
      ) : (
        <HomepageGate
          id={entry.id}
          cancelLabel={t('ch.useBuiltin')}
          onApproved={(next) => {
            setEntry((prev) => (prev ? { ...prev, ...next } : prev))
            setPassed(true)
          }}
          // 关闭 / 取消：停用该主页并刷新设置，让外层 HomeRoute 退回内置「启动游戏」界面
          //（只调 setActive('') 而不刷新，界面会一直停在闸门弹窗上，表现为「关闭无效」）。
          onCancel={() => {
            void window.api.homepage.setActive('').then(reloadSettings)
          }}
        />
      )}
    </div>
  )
}

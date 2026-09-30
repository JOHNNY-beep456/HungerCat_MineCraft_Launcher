// ---------------------------------------------------------------------------
// Win32 外部窗口显示（实验性 Win10 桌面用）。
//
// 目标：把 Minecraft（javaw.exe 的 GLFW 窗口）这类**别的进程的窗口**显示在启动器
// 桌面里，并且保持完全可交互（不是截图镜像）。
//
// 只捕获 Minecraft：文件资源管理器改由启动器**自己实现**的资源管理器页面呈现
// （见 renderer 的 FileManager），不再把 explorer.exe 的窗口搬进桌面。
// 原因：资源管理器窗口的标题栏画在客户区里（XAML 岛），被搬动 / 遮蔽后要额外抖动
// 尺寸才能恢复渲染表面，是「移动窗口崩溃 / 白屏」的主要来源；自家页面没有这些问题。
//
// 做法（关键：**绝不 SetParent**）：
//   1. EnumWindows 列出顶层窗口，按进程名 + 窗口类识别出 MC；
//   2. 把外部窗口**按客户区对齐**摆到桌面窗口预留矩形的屏幕位置上：
//      窗口整体上移/左移一个非客户区尺寸，使其客户区正好落在预留矩形里，
//      于是它自己的标题栏/边框被启动器窗口的界面挡住，看起来就是「嵌在桌面里」；
//   3. 在**启动器自己的窗口**上用 SetWindowRgn 把该矩形挖成空洞：启动器窗口
//      在这些矩形里不画任何像素，下层的外部窗口就直接透出来；
//   4. 外部窗口始终是独立的顶层窗口，保持原有窗口层级、样式、交换链不变。
//
// 为什么不能 SetParent（已实测）：
//   跨进程重父化会让 DirectComposition / XAML island 子窗口不再合成 ——
//   资源管理器的文件列表整块空白、Chromium（与 MC 的 GL 交换链同类）100% 不渲染，
//   MC 表现为白屏，且强制改尺寸也无法恢复。
//   只搬位置、不动窗口层级，则外部窗口的渲染完全不受影响。
//
// 必须记住外部窗口的原始位置，退出桌面模式/关窗/退出程序时 releaseAll()
// 把它们放回原处（这里不会销毁任何外部窗口，仅恢复位置）。
//
// 非 Windows 或缺少原生模块时整体降级为「不支持」，不影响启动器其它功能。
// ---------------------------------------------------------------------------

import type { NativeWindowInfo, NativeWindowRect } from '@shared/types'

export type { NativeWindowInfo, NativeWindowRect }

/* ------------------------------ Win32 常量 ------------------------------ */

const SWP_NOACTIVATE = 0x0010
const SWP_NOZORDER = 0x0004
const SWP_NOSIZE = 0x0001
const SWP_SHOWWINDOW = 0x0040

const RGN_DIFF = 4
/** HWND_TOP == 0：提到「普通窗口」的最上层（仍低于宿主窗口的 topmost 层） */
const HWND_TOP = null

/** GetGUIThreadInfo().flags：该线程正处在「移动 / 缩放」模态循环里 */
const GUI_INMOVESIZE = 0x00000002
/** GUITHREADINFO 在 x64 下的字节数 */
const GUITHREADINFO_SIZE = 72

/** RedrawWindow 标志；刻意不带 RDW_UPDATENOW，避免同步等待外部窗口的线程 */
const RDW_INVALIDATE = 0x0001
const RDW_ERASE = 0x0004
const RDW_ALLCHILDREN = 0x0080
const RDW_FRAME = 0x0400

/** 连续失败多少次后进入退避（不再对同一个窗口反复下发） */
const MAX_APPLY_FAILURES = 5
/** 退避时长：期间对它的摆放请求一律跳过，避免把一个已经异常的窗口打死 */
const APPLY_COOLDOWN_MS = 5000
/** 被推迟（用户正在拖它 / 退避中）后多久重试一次 */
const PLACE_RETRY_MS = 400

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

/** Java 进程可能的名字 */
const JAVA_EXES = ['javaw.exe', 'java.exe', 'minecraft.exe']
/** Minecraft 的窗口类（GLFW / LWJGL） */
const MC_CLASSES = ['GLFW30', 'LWJGL']

/* ------------------------------ 绑定 ------------------------------ */

interface Win32 {
  EnumWindows: (cb: unknown, lparam: number) => boolean
  EnumWindowsProc: unknown
  IsWindowVisible: (hwnd: bigint) => boolean
  IsWindow: (hwnd: bigint) => boolean
  IsIconic: (hwnd: bigint) => boolean
  GetWindowTextW: (hwnd: bigint, buf: Buffer, max: number) => number
  GetClassNameW: (hwnd: bigint, buf: Buffer, max: number) => number
  GetWindowThreadProcessId: (hwnd: bigint, pid: number[]) => number
  GetParent: (hwnd: bigint) => unknown
  GetWindowRect: (hwnd: bigint, rect: number[]) => boolean
  GetClientRect: (hwnd: bigint, rect: number[]) => boolean
  ClientToScreen: (hwnd: bigint, point: number[]) => boolean
  SetWindowPos: (
    hwnd: bigint,
    after: bigint | null,
    x: number,
    y: number,
    w: number,
    h: number,
    flags: number
  ) => boolean
  /** 给宿主窗口设置区域（空洞）；rgn 传 null 表示恢复整块 */
  SetWindowRgn: (hwnd: bigint, rgn: unknown, redraw: boolean) => number
  SetForegroundWindow: (hwnd: bigint) => boolean
  GetGUIThreadInfo: (tid: number, buf: Buffer) => boolean
  RedrawWindow: (hwnd: bigint, rect: null, rgn: null, flags: number) => boolean
  OpenProcess: (access: number, inherit: boolean, pid: number) => unknown
  QueryFullProcessImageNameW: (handle: bigint, flags: number, buf: Buffer, size: number[]) => boolean
  CloseHandle: (handle: unknown) => boolean
}

interface Gdi32 {
  CreateRectRgn: (l: number, t: number, r: number, b: number) => unknown
  CombineRgn: (dst: unknown, a: unknown, b: unknown, mode: number) => number
  DeleteObject: (obj: unknown) => boolean
}

/** koffi 模块（延迟加载；缺失时整体降级） */
/* eslint-disable @typescript-eslint/no-explicit-any */
/** FFI 边界用动态签名：真正的类型约束由上面的 Win32 / Gdi32 接口保证 */
type KoffiFn = (...args: any[]) => any
interface KoffiLib {
  func: (def: string) => KoffiFn
}
type KoffiModule = {
  load: (lib: string) => KoffiLib
  proto: (def: string) => unknown
  pointer: (type: unknown) => unknown
  register: (fn: KoffiFn, type: unknown) => unknown
  unregister: (cb: unknown) => void
}

let koffiModule: KoffiModule | null = null
let win32: Win32 | null = null
let gdi32: Gdi32 | null = null
let bindFailed = false

/** 被摆到桌面里的窗口：id -> 原始位置 / 当前空洞矩形（客户端设备像素） */
interface Placed {
  original: NativeWindowRect
  /** 当前要挖的洞；undefined = 不显示（最小化 / 被自己的窗口盖住 / 开始菜单打开） */
  hole?: NativeWindowRect
  /** 最近一次用过的洞，用于「暂时不显示」后再恢复 */
  lastHole?: NativeWindowRect
  /** 最近一次真正下发到系统的窗口矩形，用来跳过无变化的重排 */
  applied?: NativeWindowRect
  /** 当前是否已经把它提到过最上层，避免每次下发都重复改层级 */
  raised?: boolean
  /** 连续下发失败次数；达到上限进入退避 */
  failCount?: number
  /** 退避截止时间（epoch ms）；期间跳过一切下发 */
  cooldownUntil?: number
}
const placed = new Map<string, Placed>()
/** 窗口元信息缓存（用于列表展示） */
const metaCache = new Map<string, { title: string; exe: string; kind: 'minecraft' }>()
/** 被推迟的下发：用户正在亲手拖它 / 退避结束时重新摆放一次 */
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
/**
 * 渲染层正在拖动的桌面窗口（的 id）。
 *
 * 拖动期间**一次 SetWindowPos 都不能下发**：拖动的一方（渲染层在改预留矩形，
 * 或者用户正按着这个外部窗口的标题栏）和我们又同时对同一个窗口做移动，
 * MC 的 GL 窗口会直接崩掉。这里由渲染层在 pointerdown / pointerup 时精确置位，
 * 补上「渲染层状态更新是异步的」这段空窗期 —— 光靠渲染层的 hidden 标志封不住。
 */
const dragging = new Set<string>()
/** 宿主（启动器）窗口句柄 */
let hostHwnd: bigint | null = null

function loadKoffi(): KoffiModule | null {
  if (koffiModule) return koffiModule
  try {
    // 延迟 require：非 Windows / 缺原生模块时只让本功能不可用，不影响启动器
    koffiModule = require('koffi') as KoffiModule
    return koffiModule
  } catch (err) {
    console.warn('[桌面] 无法加载 koffi，外部窗口捕获不可用：', err)
    return null
  }
}

function loadWin32(): Win32 | null {
  if (win32 || bindFailed) return win32
  if (process.platform !== 'win32') {
    bindFailed = true
    return null
  }
  const koffi = loadKoffi()
  if (!koffi) {
    bindFailed = true
    return null
  }
  try {
    const user32 = koffi.load('user32.dll')
    const gdi = koffi.load('gdi32.dll')
    win32 = {
      EnumWindows: user32.func('bool __stdcall EnumWindows(void *lpEnumFunc, intptr_t lParam)'),
      EnumWindowsProc: koffi.proto('bool __stdcall EnumWindowsProc(void *hwnd, intptr_t lParam)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(void *hwnd)'),
      IsWindow: user32.func('bool __stdcall IsWindow(void *hwnd)'),
      IsIconic: user32.func('bool __stdcall IsIconic(void *hwnd)'),
      GetWindowTextW: user32.func('int __stdcall GetWindowTextW(void *hwnd, void *buf, int max)'),
      GetClassNameW: user32.func('int __stdcall GetClassNameW(void *hwnd, void *buf, int max)'),
      GetWindowThreadProcessId: user32.func(
        'uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)'
      ),
      GetParent: user32.func('void *__stdcall GetParent(void *hwnd)'),
      GetWindowRect: user32.func('bool __stdcall GetWindowRect(void *hwnd, _Out_ int *rect)'),
      GetClientRect: user32.func('bool __stdcall GetClientRect(void *hwnd, _Out_ int *rect)'),
      ClientToScreen: user32.func('bool __stdcall ClientToScreen(void *hwnd, _Inout_ int *point)'),
      SetWindowPos: user32.func(
        'bool __stdcall SetWindowPos(void *hwnd, void *after, int x, int y, int w, int h, uint32 flags)'
      ),
      SetWindowRgn: user32.func('int __stdcall SetWindowRgn(void *hwnd, void *rgn, bool redraw)'),
      SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(void *hwnd)'),
      GetGUIThreadInfo: user32.func(
        'bool __stdcall GetGUIThreadInfo(uint32 tid, _Out_ void *pgui)'
      ),
      RedrawWindow: user32.func(
        'bool __stdcall RedrawWindow(void *hwnd, void *updateRect, void *updateRgn, uint32 flags)'
      ),
      OpenProcess: kernel32OpenProcess(koffi),
      QueryFullProcessImageNameW: kernel32QueryName(koffi),
      CloseHandle: kernel32CloseHandle(koffi)
    }
    gdi32 = {
      CreateRectRgn: gdi.func('void *__stdcall CreateRectRgn(int l, int t, int r, int b)'),
      CombineRgn: gdi.func('int __stdcall CombineRgn(void *dst, void *a, void *b, int mode)'),
      DeleteObject: gdi.func('bool __stdcall DeleteObject(void *obj)')
    }
    return win32
  } catch (err) {
    bindFailed = true
    console.warn('[桌面] 绑定 Win32 失败，外部窗口捕获不可用：', err)
    return null
  }
}

/* kernel32 的三个函数单独取，避免上面对象字面量过长 */
let koffiKernel32: KoffiLib | null = null
function kernel32Lib(koffi: KoffiModule): KoffiLib {
  if (!koffiKernel32) koffiKernel32 = koffi.load('kernel32.dll')
  return koffiKernel32
}
function kernel32OpenProcess(koffi: KoffiModule): Win32['OpenProcess'] {
  return kernel32Lib(koffi).func('void *__stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)')
}
function kernel32QueryName(koffi: KoffiModule): Win32['QueryFullProcessImageNameW'] {
  return kernel32Lib(koffi).func(
    'bool __stdcall QueryFullProcessImageNameW(void *proc, uint32 flags, void *buf, _Inout_ uint32 *size)'
  )
}
function kernel32CloseHandle(koffi: KoffiModule): Win32['CloseHandle'] {
  return kernel32Lib(koffi).func('bool __stdcall CloseHandle(void *handle)')
}

export function isNativeWindowSupported(): boolean {
  return loadWin32() !== null
}

/** 父窗口句柄是否有效（koffi 对 NULL 指针可能返回 null 或 0n） */
function isNullPtr(value: unknown): boolean {
  return value === null || value === undefined || value === 0n || value === 0
}

/* ------------------------------ 工具 ------------------------------ */

function wide(buf: Buffer): string {
  const s = buf.toString('utf16le')
  const nul = s.indexOf('\u0000')
  return (nul >= 0 ? s.slice(0, nul) : s).trim()
}

function processName(pid: number): string {
  const api = win32
  if (!api || pid <= 0) return ''
  const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (isNullPtr(handle)) return ''
  try {
    const buf = Buffer.alloc(1024)
    const size = [1024]
    if (!api.QueryFullProcessImageNameW(handle as bigint, 0, buf, size)) return ''
    const full = wide(buf)
    return (full.split('\\').pop() || '').toLowerCase()
  } catch {
    return ''
  } finally {
    try {
      api.CloseHandle(handle)
    } catch {
      /* 忽略 */
    }
  }
}

function rectOf(hwnd: bigint): NativeWindowRect | null {
  const api = win32
  if (!api) return null
  const r = [0, 0, 0, 0]
  if (!api.GetWindowRect(hwnd, r)) return null
  return { x: r[0], y: r[1], w: r[2] - r[0], h: r[3] - r[1] }
}

function clientSizeOf(hwnd: bigint): { w: number; h: number } | null {
  const api = win32
  if (!api) return null
  const r = [0, 0, 0, 0]
  if (!api.GetClientRect(hwnd, r)) return null
  return { w: r[2], h: r[3] }
}

/**
 * 该窗口所属线程是否正处在「移动 / 缩放」的模态循环里（即用户正在亲手拖动这个窗口）。
 *
 * 此时绝对不能再对它 SetWindowPos：两个线程同时对同一个窗口做移动，GL 窗口（MC）
 * 会直接崩掉（实测）。Windows 的 GetGUIThreadInfo 能跨进程读到这个状态，
 * 拿不到就当作「不在拖动」，退回原来的行为。
 */
function inMoveSizeLoop(hwnd: bigint): boolean {
  const api = win32
  if (!api) return false
  try {
    const tid = api.GetWindowThreadProcessId(hwnd, [0])
    if (!tid) return false
    const buf = Buffer.alloc(GUITHREADINFO_SIZE)
    buf.writeUInt32LE(GUITHREADINFO_SIZE, 0)
    if (!api.GetGUIThreadInfo(tid, buf)) return false
    if ((buf.readUInt32LE(4) & GUI_INMOVESIZE) === 0) return false
    // 同一线程可能正在拖它的另一个窗口；hwndMoveSize 为 0 时无法区分，按「是」处理
    const moveSize = buf.readBigUInt64LE(40)
    return moveSize === 0n || moveSize === hwnd
  } catch {
    return false
  }
}

/**
 * 让被重新露出的外部窗口重画一次。
 *
 * 「最小化」在这里不是真的最小化，而是**收起空洞**：启动器界面（topmost + 全不透明）
 * 会把它整个盖住。露出瞬间异步请求一次重绘即可（不带 RDW_UPDATENOW，免得同步
 * 等外部窗口的线程）。
 */
function refreshExternal(hwnd: bigint): void {
  const api = win32
  if (!api) return
  try {
    api.RedrawWindow(hwnd, null, null, RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN | RDW_FRAME)
  } catch {
    /* 忽略 */
  }
}

/**
 * 推迟一次摆放：用户正在亲手拖这个窗口（或它正处在失败退避期）时，
 * 本轮跳过 SetWindowPos，但稍后必须补上，否则窗口会永远停在旧位置。
 */
function schedulePlaceRetry(id: string): void {
  if (retryTimers.has(id)) return
  const timer = setTimeout(() => {
    retryTimers.delete(id)
    const entry = placed.get(id)
    if (!entry || !entry.hole) return
    // 还在拖动（渲染层在拖这个桌面窗口，或用户正按着它自己的标题栏）：
    // 继续往后推，绝不在人家手里动这个窗口 —— 直到真的松手再补上。
    const hwnd = resolve(id)
    if (dragging.has(id) || (hwnd !== null && inMoveSizeLoop(hwnd))) {
      schedulePlaceRetry(id)
      return
    }
    placeWindow(id, entry.hole, entry.raised === true)
  }, PLACE_RETRY_MS)
  // 别让这个定时器拖住进程退出
  timer.unref()
  retryTimers.set(id, timer)
}

/**
 * 渲染层开始 / 结束拖动某个桌面窗口。
 * 拖动期间禁止对它下发任何 SetWindowPos（含延迟重试）；松手后补一次摆放。
 */
export function setDragging(id: string, on: boolean): void {
  if (on) {
    dragging.add(id)
    return
  }
  dragging.delete(id)
  const entry = placed.get(id)
  if (entry?.hole) schedulePlaceRetry(id)
}

function clearRetry(id: string): void {
  const timer = retryTimers.get(id)
  if (timer) {
    clearTimeout(timer)
    retryTimers.delete(id)
  }
}

/** 客户区左上角的屏幕坐标 */
function clientOriginOf(hwnd: bigint): { x: number; y: number } | null {
  const api = win32
  if (!api) return null
  const p = [0, 0]
  if (!api.ClientToScreen(hwnd, p)) return null
  return { x: p[0], y: p[1] }
}

/** 该窗口是否属于我们要显示的目标（只认 Minecraft） */
function classify(exe: string, cls: string, title: string): 'minecraft' | null {
  if (JAVA_EXES.includes(exe) && (MC_CLASSES.includes(cls) || /minecraft/i.test(title))) {
    return 'minecraft'
  }
  return null
}

/* ------------------------------ 枚举 ------------------------------ */

interface RawWindow {
  id: string
  hwnd: bigint
  title: string
  cls: string
  exe: string
}

function enumerateTopLevel(): RawWindow[] {
  const api = loadWin32()
  const koffi = koffiModule
  if (!api || !koffi) return []
  const out: RawWindow[] = []
  const seen = new Set<string>()
  let cb: unknown = null

  try {
    cb = koffi.register((hwnd: bigint) => {
      try {
        const id = hwnd.toString()
        if (seen.has(id)) return true
        seen.add(id)
        if (!api.IsWindowVisible(hwnd)) return true
        // 已被系统最小化的窗口不捕获：它的矩形在 (-32000,-32000)，摆不了
        if (api.IsIconic(hwnd)) return true
        // 只取顶层窗口：被摆进桌面的窗口仍是顶层窗口，会照常出现在这里
        if (!isNullPtr(api.GetParent(hwnd))) return true
        const titleBuf = Buffer.alloc(512)
        api.GetWindowTextW(hwnd, titleBuf, 256)
        const title = wide(titleBuf)
        if (!title) return true
        const classBuf = Buffer.alloc(256)
        api.GetClassNameW(hwnd, classBuf, 128)
        const cls = wide(classBuf)
        const pidBuf = [0]
        api.GetWindowThreadProcessId(hwnd, pidBuf)
        const pid = pidBuf[0]
        // 排除启动器自己的窗口
        if (pid === process.pid) return true
        out.push({ id, hwnd, title, cls, exe: processName(pid) })
      } catch {
        /* 单个窗口出错不影响整轮枚举 */
      }
      return true
    }, koffi.pointer(api.EnumWindowsProc))
    api.EnumWindows(cb, 0)
  } catch (err) {
    console.warn('[桌面] 枚举窗口失败：', err)
  } finally {
    if (cb) {
      try {
        koffi.unregister(cb)
      } catch {
        /* 忽略 */
      }
    }
  }
  return out
}

/** 列出可显示在桌面里的外部窗口（目前只有 Minecraft） */
export function listWindows(): NativeWindowInfo[] {
  const api = loadWin32()
  if (!api) return []
  const out: NativeWindowInfo[] = []
  for (const raw of enumerateTopLevel()) {
    const kind = classify(raw.exe, raw.cls, raw.title)
    if (!kind) continue
    metaCache.set(raw.id, { title: raw.title, exe: raw.exe, kind })
    out.push({ id: raw.id, title: raw.title, exe: raw.exe, kind, placed: placed.has(raw.id) })
  }
  // 已摆放的窗口必须始终留在列表里：即使某一轮枚举失败，也不能让渲染层以为它消失了
  // （否则桌面窗口会被移除，而宿主窗口上的空洞还在）
  for (const id of Array.from(placed.keys())) {
    if (out.some((w) => w.id === id)) continue
    const meta = metaCache.get(id)
    if (meta && resolve(id)) {
      out.push({ id, title: meta.title, exe: meta.exe, kind: meta.kind, placed: true })
    }
  }

  // 已消失的窗口清理掉（含已摆放的），并同步去掉它们的空洞
  let pruned = 0
  for (const id of Array.from(placed.keys())) {
    if (!out.some((w) => w.id === id) && !resolve(id)) {
      placed.delete(id)
      metaCache.delete(id)
      clearRetry(id)
      pruned++
    }
  }
  if (pruned > 0) applyRegion()
  return out.sort((a, b) => a.title.localeCompare(b.title))
}

/** 解析句柄字符串；窗口已销毁返回 null */
function resolve(id: string): bigint | null {
  const api = loadWin32()
  if (!api) return null
  let hwnd: bigint
  try {
    hwnd = BigInt(id)
  } catch {
    return null
  }
  try {
    return api.IsWindow(hwnd) ? hwnd : null
  } catch {
    return null
  }
}

/* ------------------------------ 空洞 ------------------------------ */

/** 最近一次下发到系统的空洞集合，用于跳过重复的 SetWindowRgn */
let lastRegionKey: string | null = null

/** 按当前所有可见空洞重建宿主窗口的区域：整块客户区 − 各空洞 */
function applyRegion(): void {
  const api = win32
  const gdi = gdi32
  if (!api || !gdi || !hostHwnd) return
  try {
    const holes = Array.from(placed.values())
      .map((p) => p.hole)
      .filter((h): h is NativeWindowRect => !!h)
    const size = clientSizeOf(hostHwnd)
    const key =
      holes.length === 0
        ? ''
        : `${size?.w ?? 0}x${size?.h ?? 0}|${holes
            .map((h) => `${h.x},${h.y},${h.w},${h.h}`)
            .sort()
            .join(';')}`
    // 空洞没变就不动窗口（SetWindowRgn 会触发整窗重绘/DWM 重排，别每帧都做）
    if (key === lastRegionKey) return
    lastRegionKey = key

    if (holes.length === 0) {
      // 没有空洞：清除区域，宿主窗口恢复整块（SetWindowRgn 传 null）
      api.SetWindowRgn(hostHwnd, null, true)
      return
    }
    if (!size) return
    const region = gdi.CreateRectRgn(0, 0, size.w, size.h)
    for (const h of holes) {
      const cut = gdi.CreateRectRgn(h.x, h.y, h.x + h.w, h.y + h.h)
      gdi.CombineRgn(region, region, cut, RGN_DIFF)
      gdi.DeleteObject(cut)
    }
    // SetWindowRgn 之后区域归系统所有，不能自己 DeleteObject
    api.SetWindowRgn(hostHwnd, region, true)
  } catch (err) {
    console.warn('[桌面] 更新窗口空洞失败：', err)
  }
}

/* ------------------------------ 摆放 / 收回 ------------------------------ */

/** 宿主窗口句柄（启动器窗口），每次调用前同步一次 */
export function setHost(parentId: string): void {
  try {
    hostHwnd = BigInt(parentId)
  } catch {
    hostHwnd = null
  }
}

/**
 * 把外部窗口摆到桌面预留矩形处（hole 为**客户端设备像素**）：
 * 让它的**客户区**正好覆盖该矩形，非客户区（标题栏/边框）被启动器界面挡住。
 *
 * raise=true 时把它提到普通窗口最上层（聚焦的那个窗口用），否则保持现有层级，
 * 这样多个外部窗口之间的前后关系由「谁被聚焦」决定。
 */
export function placeWindow(id: string, hole: NativeWindowRect, raise = false): boolean {
  const api = loadWin32()
  const hwnd = resolve(id)
  if (!api || !hwnd) {
    // 窗口已经没了（被关掉）：顺手清掉记录与空洞，别留一个透不出东西的洞
    forget(id)
    return false
  }
  // 退化矩形不下发：0 宽/高的 SetWindowPos 会让外部窗口进入异常状态
  if (hole.w <= 0 || hole.h <= 0) return true
  // 已被系统最小化的窗口不能摆（它的 rect 在 -32000，客户区尺寸为 0）：
  // 对它 SetWindowPos / 取 DWM 属性都会出问题，而且此时也不该显示它，
  // 所以顺手把空洞收起来，等它还原后下一轮再摆回来。
  try {
    if (api.IsIconic(hwnd)) {
      const cur = placed.get(id)
      if (cur?.hole) {
        cur.lastHole = cur.hole
        cur.hole = undefined
        applyRegion()
      }
      return true
    }
  } catch {
    /* 忽略 */
  }

  const host = hostHwnd
  const hostOrigin = host ? clientOriginOf(host) : null
  if (!hostOrigin) return false

  const entry = placed.get(id)
  // 渲染层正拖着这个桌面窗口：拖动期间一次都不下发（也不改洞），等松手后补。
  // 关键是**不要**在这里写 entry.hole —— 拖动时渲染层会把洞收起来（setVisible
  // false），这里再写回洞就等于把它又露出来了。
  if (dragging.has(id)) return true
  // 失败退避期：这个窗口的下发已经连续失败过，先晾一会儿再试，别把它打死。
  if (entry?.cooldownUntil !== undefined && Date.now() < entry.cooldownUntil) {
    schedulePlaceRetry(id)
    return true
  }
  // 用户正亲手拖动 / 缩放这个窗口（它的线程在移动循环里）：这时候再 SetWindowPos
  // 就是两个线程同时移动同一个窗口，MC 的 GL 窗口会直接崩掉 —— 本轮什么都不做，
  // 记一个延迟重试，等它松手后补上（否则窗口会永远停在用户拖到的位置）。
  if (inMoveSizeLoop(hwnd)) {
    if (entry) {
      entry.hole = hole
      entry.lastHole = hole
    }
    schedulePlaceRetry(id)
    return true
  }

  // 「最小化」= 收起空洞（entry.hole 变 undefined）。本轮如果是从「无洞」恢复成「有洞」，
  // 说明窗口刚被重新露出，做完摆放后要额外让它重绘一次。
  const wasHidden = entry !== undefined && entry.hole === undefined

  const win = rectOf(hwnd)
  const clientOrigin = clientOriginOf(hwnd)
  const clientSize = clientSizeOf(hwnd)
  if (!win || !clientOrigin || !clientSize) return false

  const ncLeft = clientOrigin.x - win.x
  const ncTop = clientOrigin.y - win.y
  const ncW = win.w - clientSize.w
  const ncH = win.h - clientSize.h

  const target: NativeWindowRect = {
    x: hostOrigin.x + hole.x - ncLeft,
    y: hostOrigin.y + hole.y - ncTop,
    w: hole.w + ncW,
    h: hole.h + ncH
  }

  const prev = entry?.applied
  const raised = entry?.raised === true
  const rectSame =
    prev !== undefined && prev.x === target.x && prev.y === target.y && prev.w === target.w && prev.h === target.h
  // 位置/尺寸与「是否已提层」都没变就什么都不做
  // （拖动时高频下发、空闲时定时兜底下发，绝大多数都属于这种）
  if (rectSame && raise === raised) {
    if (!entry) return false
    entry.hole = hole
    entry.lastHole = hole
    // 这里也必须重建区域：从「收起空洞」恢复时位置没变，但空洞要从无到有
    applyRegion()
    if (wasHidden) refreshExternal(hwnd)
    return true
  }
  // 尺寸没变就用 SWP_NOSIZE：只挪位置不触发 WM_SIZE，
  // 避免 MC 这类窗口每帧重建帧缓冲（拖拽时尤其关键）
  const sizeChanged = !prev || prev.w !== target.w || prev.h !== target.h
  // 已经提过层就不要每次都重提（重复改层级同样会扰动外部窗口）
  const needTop = raise && !raised

  if (!entry) {
    placed.set(id, { original: win, hole, lastHole: hole })
  } else {
    entry.hole = hole
    entry.lastHole = hole
  }

  try {
    const ok = api.SetWindowPos(
      hwnd,
      needTop ? HWND_TOP : null,
      target.x,
      target.y,
      target.w,
      target.h,
      (needTop ? 0 : SWP_NOZORDER) |
        SWP_NOACTIVATE |
        SWP_SHOWWINDOW |
        (sizeChanged ? 0 : SWP_NOSIZE)
    )
    const current = placed.get(id)
    if (!ok) {
      // 下发被系统拒绝：计数，连续失败到上限就退避一段时间，避免高频空转。
      if (current) {
        const fails = (current.failCount ?? 0) + 1
        current.failCount = fails
        if (fails >= MAX_APPLY_FAILURES) {
          current.cooldownUntil = Date.now() + APPLY_COOLDOWN_MS
          current.failCount = 0
          console.warn(`[桌面] 窗口 ${id} 连续摆放失败，暂停 ${APPLY_COOLDOWN_MS}ms 后重试`)
          schedulePlaceRetry(id)
        }
      }
      return true
    }
    if (current) {
      current.applied = target
      current.raised = raise
      current.failCount = 0
      current.cooldownUntil = undefined
    }
  } catch (err) {
    console.warn(`[桌面] 摆放窗口 ${id} 失败：`, err)
    return false
  }
  applyRegion()
  if (wasHidden) refreshExternal(hwnd)
  return true
}

/**
 * 是否在宿主窗口上给该窗口留洞。
 * false 常用于：最小化 / 被启动器自己的窗口盖住 / 开始菜单打开（此时宿主窗口
 * 恢复整块，把外部窗口压在下面，于是启动器界面完整可见）。
 */
export function setHoleVisible(id: string, visible: boolean): boolean {
  const entry = placed.get(id)
  if (!entry) return false
  if (!resolve(id)) {
    forget(id)
    return false
  }
  if (!visible) {
    if (entry.hole) {
      entry.lastHole = entry.hole
      entry.hole = undefined
      applyRegion()
    }
    return true
  }
  const hole = entry.lastHole
  if (!hole) return true
  // 不在这里预设 entry.hole：让 placeWindow 自己识别「从无洞到有洞」并顺带刷新外部窗口
  const ok = placeWindow(id, hole, entry.raised === true)
  if (!ok) {
    // 宿主窗口暂时不可用（例如取不到客户区原点）：至少把记录恢复，别让这个窗口再也显示不出来
    entry.hole = hole
    applyRegion()
  }
  return ok
}

/** 忘掉某个窗口（已销毁 / 被关掉）：清记录并重建区域 */
function forget(id: string): void {
  clearRetry(id)
  dragging.delete(id)
  if (!placed.delete(id)) return
  metaCache.delete(id)
  applyRegion()
}

/** 从桌面收回，放回原位置（不会关闭该窗口） */
export function releaseWindow(id: string): boolean {
  const api = loadWin32()
  const entry = placed.get(id)
  placed.delete(id)
  clearRetry(id)
  dragging.delete(id)
  const hwnd = resolve(id)
  if (!api || !hwnd || !entry) {
    applyRegion()
    return false
  }
  try {
    api.SetWindowPos(
      hwnd,
      null,
      entry.original.x,
      entry.original.y,
      entry.original.w,
      entry.original.h,
      SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW
    )
    return true
  } catch (err) {
    console.warn(`[桌面] 收回窗口 ${id} 失败：`, err)
    return false
  } finally {
    applyRegion()
  }
}

/**
 * 退出桌面模式 / 关闭启动器 / 退出程序前必须调用：
 * 把外部窗口放回原来的位置与大小（本方案不会销毁它们，但位置要还原）。
 */
export function releaseAll(): number {
  let n = 0
  for (const id of Array.from(placed.keys())) {
    if (releaseWindow(id)) n++
  }
  for (const id of Array.from(retryTimers.keys())) clearRetry(id)
  dragging.clear()
  metaCache.clear()
  // releaseWindow 内部会重建区域；这里兜底确保宿主窗口恢复整块（并让区域缓存失效）
  lastRegionKey = null
  applyRegion()
  return n
}

export function placedCount(): number {
  return placed.size
}

/** 宿主窗口移动 / 缩放 / 尺寸变化后重新摆放所有窗口（空洞用客户端坐标，天然跟随） */
export function resyncAll(): void {
  for (const [id, entry] of Array.from(placed.entries())) {
    const hole = entry.hole
    if (!hole) continue
    placeWindow(id, hole, entry.raised === true)
  }
  applyRegion()
}

/** 聚焦外部窗口（点任务栏条目时用） */
export function focusWindow(id: string): boolean {
  const api = loadWin32()
  const hwnd = resolve(id)
  if (!api || !hwnd) return false
  try {
    api.SetForegroundWindow(hwnd)
    return true
  } catch {
    return false
  }
}

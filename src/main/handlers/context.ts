// IPC 处理器与组合根（index.ts）之间的共享上下文。
//
// index.ts 仍持有全部模块级可变状态（窗口 / 进程引用、缓存、去抖表等）与窗口 / 广播辅助函数；
// 各域处理器模块通过本接口的「取值 / 赋值函数」访问这些可变引用，通过「动作函数」
// 调用 index.ts 中的共享逻辑。这样既完成了按域拆分，又保持 index.ts 里既有代码的语义不变。
import type { BrowserWindow, WebContents } from 'electron'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import type { JavaRuntime, LauncherSettings, MpChatMessage } from '@shared/types'
import type { DeviceCodeSession } from '../auth'
import type { DedupCache } from '../ipc-cache'
import type { Lobby, LobbyPlayer } from '../multiplayer/lobby'

export interface IpcContext {
  // ---- 可变窗口 / 进程引用（取值 / 赋值）----
  mainWindow(): BrowserWindow | null
  setMainWindow(w: BrowserWindow | null): void
  miniWindow(): BrowserWindow | null
  setMiniWindow(w: BrowserWindow | null): void
  gameProcess(): ChildProcessWithoutNullStreams | null
  setGameProcess(p: ChildProcessWithoutNullStreams | null): void
  authSession(): DeviceCodeSession | null
  setAuthSession(s: DeviceCodeSession | null): void

  // ---- 桌面外壳（实验性 Win10 桌面）状态 ----
  desktopShellOn(): boolean
  setDesktopShellOn(v: boolean): void
  desktopShellTimer(): ReturnType<typeof setInterval> | null
  setDesktopShellTimer(t: ReturnType<typeof setInterval> | null): void

  // ---- 常量映射 / 缓存（只读引用，处理器在其上增删查）----
  downloadAborts: Map<string, AbortController>
  activeInstalls: Map<string, Promise<unknown>>
  versionsCache: DedupCache
  installedCache: DedupCache

  // ---- 共享动作函数 ----
  installedCacheKey(s: LauncherSettings): string
  suitableJavaFor(s: LauncherSettings, required: number): Promise<JavaRuntime | null>
  applyWindowBackground(): void
  pinDesktopShell(): void
  isIsolated(versionId: string): boolean
  dirPathById(s: LauncherSettings, dirId?: string): string
  installKey(versionId: string, dirId?: string): string
  sendToSender(sender: WebContents, channel: string, payload: unknown): void

  // ---- 窗口 / 浮层 / 广播辅助 ----
  createDebugWindow(): void
  closeDebugWindow(): void
  createMiniWindow(): void
  closeMiniWindow(): void
  pushMiniWindowState(): void
  isMainWindow(win: BrowserWindow): boolean
  buildMiniState(): { lobby: Lobby | null; players: LobbyPlayer[]; appState: string }
  createDevWindow(): void
  closeDevWindow(): void
  closeNativeDevTools(): void
  broadcastDevMode(): void

  // ---- AI 助手 ----
  /**
   * 请求主窗口用「用户点启动」那条完整链路启动一个实例。
   *
   * 启动涉及账号刷新、Java 选择、进度事件与渲染层状态机，主进程侧重复实现一遍
   * 只会产生两套行为；因此 AI 工具只负责「请主界面去启动」，由渲染层走原路径。
   */
  requestLaunch(versionId: string): void

  /**
   * 按当前设置重新同步浮层窗口（联机 HUD / 弹幕 / AI 浮层）。
   *
   * 设置页改「游戏内浮层」这类开关时调用：浮层的存续条件是「设置开着 + 现场需要」，
   * 只在启动 / 进大厅时算一次的话，玩家在游戏里打开开关会看不到任何变化。
   */
  syncOverlays(): void

  /**
   * 按设置重新占用 / 归还 AI 语音全局快捷键。
   *
   * 热键是全局抢注的：没开 AI 的用户不该被占走 `Ctrl+Alt+V`。
   */
  syncAiShortcuts(): void
}

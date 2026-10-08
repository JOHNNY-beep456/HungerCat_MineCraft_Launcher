// ---------------------------------------------------------------------------
// 自定义主页拆分模块的共享类型。
// 这些类型描述「宿主 ↔ 沙箱脚本」之间的载荷与内部数据结构，被 data / bridge /
// sandbox 等模块共同引用，故集中在此。
// ---------------------------------------------------------------------------

import type { InstalledVersion, SystemMemoryInfo } from '@shared/types'

/** 选中版本的加载器 / 版本号摘要。 */
export interface SelectedVersionInfo {
  id: string
  /** 版本号（Minecraft 版本，如 1.21.4）。 */
  number: string
  /** 加载器标识（fabric / quilt / forge / neoforge），原版为空串。 */
  loader: string
  /** 加载器显示名，无加载器为「原版」。 */
  loaderName: string
}

/** 暴露给脚本的版本目录信息：在原始字段上补一个展示名 label，方便直接渲染。 */
export interface VersionDirInfo {
  /** 目录唯一 id；默认目录固定为 'default'。 */
  id: string
  /** 目录绝对路径。 */
  path: string
  /** 用户设置的别名（可为空串）。 */
  alias: string
  /** 展示名：优先别名，默认目录无别名时用「默认」。 */
  label: string
  /** 是否为默认目录（不可删除）。 */
  isDefault: boolean
}

/** 暴露给脚本的当前账号信息。 */
export interface AccountInfo {
  name: string
  id: string
  avatarUrl: string
  authType: string
  siteName: string
}

/** 当前账号的 3D 模型皮肤数据（供主页 hc.model3d 使用）。 */
export interface ModelSkin {
  skinUrl: string
  capeUrl: string
  skinModel: string
}

/** 宿主 → 脚本的初始/增量载荷。 */
export interface HostSnapshot {
  memory: SystemMemoryInfo | null
  /** 分配给游戏的内存（MB），脚本可通过 hc.settings.memory.set 修改。 */
  allocatedMemory: number
  account: AccountInfo | null
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

/** 脚本 → 宿主：能力调用。 */
export interface FrameCall {
  hc: 1
  kind: 'call'
  id: number
  method: string
  params?: Record<string, unknown>
}

/** 脚本 → 宿主：SDK 握手。 */
export interface FrameHello {
  hc: 1
  kind: 'hello'
}

/** 沙箱内运行时探针上报：新增元素 / 动态写入的源码，需要宿主再查一遍。 */
export interface FrameProbe {
  hc: 1
  kind: 'probe'
  batch?: Array<{ where?: string; text?: string }>
}

/** 沙箱内鼠标移动上报：iframe 内的坐标，宿主换算成窗口坐标后驱动光标光晕。 */
export interface FrameCursor {
  hc: 1
  kind: 'cursor'
  x: number
  y: number
}

// ---------------------------------------------------------------------------
// Shared types between main process, preload and renderer.
// ---------------------------------------------------------------------------

export interface MinecraftAccount {
  /** Player UUID (undashed) */
  id: string
  /** In-game name */
  name: string
  accessToken: string
  refreshToken: string
  /** epoch ms when accessToken expires */
  expiresAt: number
  skinUrl?: string
  capeUrl?: string
  /** skin model type */
  skinModel?: 'classic' | 'slim'
  addedAt: number
  /** true for offline (cracked) accounts — no Microsoft login */
  offline?: boolean
  /** 账号认证类型（缺省视为微软账号）。 */
  authType?: 'microsoft' | 'offline' | 'yggdrasil'
  /** Yggdrasil 认证服务器地址（authlib-injector 的 API 根地址）。 */
  yggdrasilServer?: string
  /**
   * 第三方认证站点名称（自动获取，来自 Yggdrasil 元数据的 `meta.serverName`，
   * 如「LittleSkin」「馋猫认证中心」），用于界面标注账号所属站点。
   */
  siteName?: string
  /** Yggdrasil 客户端令牌（用于刷新令牌）。 */
  clientToken?: string
}

/** 第三方（Yggdrasil）登录时，供「多角色选择」弹窗展示的角色项。 */
export interface YggdrasilProfileOption {
  /** 角色 UUID（已去连字符）。 */
  id: string
  name: string
  skinUrl?: string
  skinModel?: 'classic' | 'slim'
}

/**
 * 第三方登录结果：
 * - 单角色：直接返回可用账号；
 * - 多角色：返回待选角色列表，由界面弹窗选择（可多选）后再提交。
 */
export interface YggdrasilLoginOutcome {
  account?: MinecraftAccount
  profiles?: YggdrasilProfileOption[]
}

export interface DeviceCodeInfo {
  userCode: string
  deviceCode: string
  verificationUri: string
  message: string
  expiresIn: number
  interval: number
}

export type AuthStatus =
  | { state: 'waiting'; elapsed: number; expiresIn: number }
  | { state: 'success'; account: MinecraftAccount }
  | { state: 'error'; error: string }

export interface VersionSummary {
  id: string
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha'
  releaseTime: string
}

export interface VersionManifest {
  latest: { release: string; snapshot: string }
  versions: VersionSummary[]
}

export interface AssetIndexRef {
  id: string
  sha1: string
  size: number
  totalSize: number
  url: string
}

export interface LibraryDownload {
  sha1?: string
  size?: number
  path?: string
  url?: string
}

export interface Library {
  name: string
  /** Custom Maven repository base URL (used by Fabric/Quilt loaders). */
  url?: string
  /** Enriched SHA-1 for profile libraries that ship no metadata (Fabric/Quilt). */
  sha1?: string
  downloads?: {
    artifact?: LibraryDownload
    classifiers?: Record<string, LibraryDownload>
  }
  natives?: Record<string, string>
  extract?: { exclude: string[] }
  rules?: Array<{
    action: 'allow' | 'disallow'
    os?: { name?: string }
    features?: Record<string, boolean>
  }>
}

export interface VersionJson {
  id: string
  inheritsFrom?: string
  /** Base vanilla Minecraft version (set on resolved/saved profiles). */
  clientVersion?: string
  mainClass: string
  type: string
  time: string
  releaseTime: string
  assets: string
  assetIndex: AssetIndexRef
  javaVersion?: { component: string; majorVersion: number }
  libraries: Library[]
  downloads?: {
    client?: LibraryDownload & { url: string }
    client_mappings?: LibraryDownload
  }
  arguments?: {
    game?: Array<string | { rules: unknown[]; value: string | string[] }>
    jvm?: Array<string | { rules: unknown[]; value: string | string[] }>
  }
  minecraftArguments?: string
  logging?: {
    client?: {
      argument: string
      file: { id: string; sha1: string; size: number; url: string }
      type: string
    }
  }
}

export type DownloadPhase = 'assets' | 'libraries' | 'client' | 'logging' | 'java' | 'mod' | 'done'

export interface DownloadProgress {
  /** 下载任务标识（用于并发下载的区分，缺省为 'main'） */
  taskId?: string
  task: string
  current: number
  total: number
  currentBytes: number
  totalBytes: number
  phase: DownloadPhase
  percent: number
  /** 实时下载速度（字节/秒），主进程按两次进度回调计算。 */
  speed?: number
}

/**
 * 当前实际使用的下载器状态（「进度」页展示）。
 *
 * 下载传输层是「原生优先、TS 兜底」：能加载到 Rust 编译的 .node 就走原生内核，
 * 否则自动降级到内置 TS 实现。两者功能一致、速度不同，界面需要让用户知道
 * 现在跑的是哪一个——尤其在排查「下载为什么没变快」时。
 */
export interface DownloadEngineStatus {
  /** 是否成功加载原生内核。 */
  available: boolean
  /** 解析到的 .node 绝对路径；未找到时为 null。 */
  path: string | null
  /** 当前平台目录名（如 win32-x64），用于说明为何没有该平台产物。 */
  platform: string
}

export interface JavaRuntime {
  path: string
  version: string
  major: number
  is64Bit: boolean
  vendor?: string
}

/** 系统内存信息（单位 MB）。 */
export interface SystemMemoryInfo {
  total: number
  used: number
  free: number
}

/** 系统硬件信息：用于首次启动的「低配电脑」判定（超低占用模式自动开启）。 */
export interface SystemHardwareInfo {
  /** 逻辑 CPU 核心数。 */
  cpuCores: number
  /** 物理内存总量（单位 MB）。 */
  totalMemMb: number
  /** 是否判定为低配电脑（2010 年代老机器）：核心数或内存低于阈值。 */
  lowEnd: boolean
}

export interface LaunchOptions {
  versionId: string
  accountId: string
  gameDir: string
  memoryMb: number
  javaPath?: string
  extraJvmArgs?: string[]
  extraGameArgs?: string[]
  fullscreen?: boolean
  demo?: boolean
  /** window width/height for older versions */
  resolution?: { width: number; height: number }
  /** launch directly into a single-player world (1.19.3+) */
  quickPlaySingleplayer?: string
  /** launch and connect directly to a server (1.19.3+) */
  quickPlayMultiplayer?: string
}

export interface InstalledVersion {
  id: string
  /** Base vanilla Minecraft version (from the version JSON's clientVersion/inheritsFrom). */
  mcVersion: string
  /** Mod loader (fabric/quilt/forge/neoforge) or null for vanilla. */
  loader: string | null
  worlds: string[]
  servers: Array<{ name: string; address: string }>
}

/** 从外部 .minecraft 目录扫描到的可导入版本。 */
export interface ExternalVersion {
  id: string
  /** 基础 Minecraft 版本（尽力解析）。 */
  mcVersion: string
  /** 模组加载器；原版为 null。 */
  loader: string | null
  /** 版本目录大小（字节）。 */
  size: number
  /** 当前版本目录中是否已存在同名版本。 */
  conflict: boolean
}

/** 导入重名版本时的处理策略。 */
export type ConflictPolicy = 'rename' | 'overwrite' | 'skip'

/**
 * 版本目录：一个独立的「版本列表根目录」，内含各自的 versions/ 与运行目录。
 * 默认目录来自设置页的 gameDir，其余由用户在实例页 / 主页添加，可设别名。
 */
export interface VersionDir {
  /** 稳定 id（默认目录固定为 'default'）。 */
  id: string
  /** 别名（界面展示用）；为空时回退到目录名。 */
  alias: string
  /** 版本列表根目录的绝对路径。 */
  path: string
  /** 是否为「默认版本列表目录」（来自设置页的 gameDir，不可删除）。 */
  isDefault?: boolean
}

export interface ModEntry {
  name: string
  path: string
  enabled: boolean
  size: number
  /** 识别出的模组显示名（优先 Modrinth 标题，回退到 JAR 元数据中的名称）。 */
  displayName?: string
  /** Modrinth 项目图标，命中时才有。 */
  iconUrl?: string
  /** Modrinth 项目 slug，命中时才有，用于打开详情页。 */
  slug?: string
  /** Modrinth 项目简介，命中时才有。 */
  description?: string
  /** 元数据来源；缺省为 Modrinth。 */
  source?: ModSource
  /** 项目主页地址（见 ModrinthProject.pageUrl）。 */
  pageUrl?: string
}

export interface SchematicEntry {
  name: string
  path: string
  size: number
}

export interface JavaCheckResult {
  required: number
  compatible: boolean
  available: JavaRuntime[]
}

/** Directories reachable from a version's management UI. */
export type VersionDirKind = 'mods' | 'saves' | 'shaderpacks' | 'schematics' | 'version' | 'run'

export type LaunchState =
  | 'starting'
  | 'downloading'
  | 'launching'
  | 'running'
  | 'exited'
  | 'error'

export interface LaunchEvent {
  /**
   * 状态变更；**可选**。纯日志行只带 `log` 不带 `state`——否则每来一行游戏输出
   * 都会把状态强行重置为 `running`，导致用户点击「停止」后状态立刻又被日志刷回
   * 「运行中」，表现为「状态更新不及时」。
   */
  state?: LaunchState
  pid?: number
  log?: string
  exitCode?: number
  error?: string
}

export interface LauncherSettings {
  theme: 'light' | 'dark' | 'system'
  /** 界面语言：简体中文（默认）/ 繁体中文 / 英语。 */
  language: 'zh-CN' | 'zh-TW' | 'en'
  memoryMb: number
  /**
   * 并行下载的**文件数量**（worker 池大小）。
   * 注意与 `downloadConnections` 区分：这一项决定「同时下几个文件」，
   * 而后者决定「单个文件开几条连接」。
   */
  maxDownloadConcurrency: number
  /**
   * 单个文件的**并发连接数**（多连接分段下载）。
   *
   * 与 `maxDownloadConcurrency` 是两个独立维度：
   *   - 版本安装会同时下几千个小文件 → 靠 maxDownloadConcurrency 铺并发；
   *   - 单个大文件（客户端 jar / 整合包 / 大模组）→ 靠本项铺并发。
   * 服务端（BMCLAPI 等）常按连接限速，此时连接数才是带宽上限。
   */
  downloadConnections: number
  /** 默认版本列表目录（原「游戏目录」）。 */
  gameDir: string
  /** 额外的版本目录（不含默认目录）；可设别名，实例页与主页可切换。 */
  versionDirs: VersionDir[]
  /** 当前选中的版本目录 id；空串表示默认目录（gameDir）。 */
  selectedVersionDirId: string
  /**
   * 是否启用「联机」板块（实验性，默认关闭）。
   *
   * 联机模块依赖 EasyTier 组网内核与 P2P 信令，稳定性和兼容性尚不充分，
   * 因此默认隐藏：不在侧栏 / 桌面图标中出现，也不接受导航进入。
   * 用户需在「设置 - 实验性功能」中主动开启并确认风险提示后才可用。
   */
  enableMultiplayer: boolean
  javaAutoDetect: boolean
  javaPath?: string
  closeOnLaunch: boolean
  reducedMotion: boolean
  /**
   * 超低占用模式：为 2010 年代老电脑设计。在不改变界面 / 动画 / 功能的前提下，
   * 降低后台持续开销（窗口不可见时暂停动画与轮询、延长刷新间隔、关闭鼠标光晕）。
   */
  lowUsageMode: boolean
  /** 是否已完成首次启动的硬件检测（保证低配提醒只出现一次）。 */
  hardwareChecked: boolean
  /** Each version gets its own isolated game directory (saves/mods/config). */
  versionIsolation: boolean
  /** Custom accent color (hex). */
  accentColor: string
  /** Background preset key. */
  background: string
  /**
   * 自定义壁纸：启动器数据目录下的文件名（空串 = 只用背景预设）。
   * 选图时先把图片复制进 userData 再只存文件名，避免原路径失效。
   */
  backgroundImage: string
  /**
   * 实验性（默认关闭）：设置自定义壁纸后，界面明暗按壁纸整体色调自动切换
   * （偏暗的壁纸 → 深色界面，偏亮的壁纸 → 浅色界面）。未设壁纸或采样失败时，
   * 仍由 theme 决定。与实验性界面皮肤相互独立。
   */
  autoThemeFromWallpaper: boolean
  /**
   * MC 游戏窗口尺寸：720P / 1080P / 最大化（铺满工作区）/ 全屏 / 自定义。
   * 桌面模式（experimental = 'win10'）下强制按「全屏」处理。
   */
  gameWindowSize: '720p' | '1080p' | 'maximized' | 'fullscreen' | 'custom'
  /** 自定义游戏窗口宽（仅 gameWindowSize === 'custom' 时生效），逻辑像素。 */
  gameWindowWidth: number
  /** 自定义游戏窗口高（仅 gameWindowSize === 'custom' 时生效），逻辑像素。 */
  gameWindowHeight: number
  /** 运行模式：normal 普通 / local 本地（关闭联网功能）/ minimal 极简（UI 二维化）。 */
  mode: 'normal' | 'local' | 'minimal'
  /** Version ids the user has disabled. */
  disabledVersions: string[]
  /** 强制隔离的实例 id（整合包导入的实例自动加入）。 */
  isolatedVersions: string[]
  /** epoch ms when the user accepted the privacy/terms agreement (0 = not yet). */
  agreementAcceptedAt: number
  /** 是否已完成新手引导；完成后仅在双击左上角图标时再次唤起。 */
  onboardingDone: boolean
  /** Debug 模式：开启后显示启动日志（右侧控制台），关闭则隐藏并以 PCL 风格进度替代。 */
  debugMode: boolean
  /** 已安装模组仅识别 JAR 元数据名称、不联网查询 Modrinth；本地模式下强制生效。 */
  metadataOnlyMods: boolean
  /** 当前启用的自定义主页脚本 id；空串表示使用内置「启动游戏」界面。 */
  homepageId: string
  /** 上次选中的游戏版本 id（自定义主页与内置页共享，持久化后脚本可读写）。 */
  selectedVersionId: string
  /**
   * 实验性界面（默认关闭，多项互斥）：
   *   off    默认界面（原毛玻璃：半透明磨砂 + 扁平半透明控件）
   *   mica   3D 云母：近实心底色 + 面板受光渐变 + 倒角与三层投影，更有厚度
   *   mac    仿 Mac 玻璃皮肤：苹方字体 + 更通透的玻璃与文字色
   *   win10  Win10 桌面：自动全屏，功能以桌面图标呈现，双击打开
   * 用单一字段表达「相斥」，避免多个布尔同时为真。
   */
  experimental: 'off' | 'mica' | 'mac' | 'win10'
  /**
   * 开发模式授权到期时间（epoch ms，0 = 未授权）。
   * 需在后台白名单内的邮箱通过验证码验证后才能获得，有效期 1 天；
   * 到期自动关闭，再次开启需重新验证邮箱。
   */
  devModeGrantedUntil: number
  /** 开发模式授权令牌（服务端签发，用于查询状态 / 解除授权）。 */
  devModeToken: string
  /** 授权邮箱的掩码展示形式（如 a***@example.com），仅用于界面显示。 */
  devModeEmailMasked: string
  /** 开发模式当前是否开启（仅在授权有效期内可自由开关）。 */
  devModeEnabled: boolean
  /**
   * 开发模式下的主页安全防护档位：
   *   full 完全模拟（默认，拦截危险操作）
   *   warn 仅提示不阻止（照常执行但提示真实情况）
   *   off  完全关闭（不做任何安全检查）
   */
  devModeSecurityMode: 'full' | 'warn' | 'off'
  /**
   * 启动时自动检查启动器更新（默认开启）。
   * 关闭后仅在设置页手动点「检测更新」时才检查。
   */
  autoCheckLauncherUpdate: boolean
  /**
   * 每次进入启动器自动检查已安装的联网校验主页是否有更新（默认开启）。
   * 关闭后不自动检查，「主页 → 可更新」栏也不显示自动结果。
   */
  autoCheckHomepageUpdate: boolean
  /**
   * 实验性（默认关闭）：自动翻译资源名与简介。
   * 开启后经免费在线翻译接口即时翻译（会联网）；本地模式下不翻译。
   */
  autoTranslateResources: boolean
  /**
   * 自动翻译的子选项：是否翻译资源名（模组 / 资源包 / 光影的名称）。
   * 仅在 autoTranslateResources 开启时生效，默认开启；关闭后只翻译简介与正文。
   */
  translateResourceNames: boolean
  /**
   * 是否已保存 uapis.cn 的 API KEY。
   *
   * 这是**派生状态**，不是持久字段：真实 KEY 由主进程经系统安全存储加密保存，
   * 既不下发到渲染层，也不写入 settings.json，所以这里只暴露「有没有」。
   * 访客额度的限额更低，填了 KEY 后翻译并发会相应提高。
   */
  uapisApiKeySet: boolean
  /**
   * 「联机」板块是否已同意 MCTier 许可协议（epoch ms，0 = 未同意）。
   *
   * MCTier 自有代码采用「源码可得（source-available）非商业许可」，
   * 与本启动器的开源协议不兼容，因此单独设门禁：首次进入联机板块必须确认。
   */
  multiplayerLicenseAcceptedAt: number
  /**
   * 联机 · 玩家名称（大厅中显示的名字）。
   */
  multiplayerPlayerName: string
  /**
   * 联机 · 是否使用私有服务器（自建 EasyTier 节点 / WebRTC 信令）。
   */
  multiplayerUsePrivateServer: boolean
  /** 联机 · 私有 EasyTier 节点地址。 */
  multiplayerEasytierServer: string
  /** 联机 · 私有 WebRTC 信令服务器地址。 */
  multiplayerSignalingServer: string
  /** 联机 · 是否使用虚拟域名。 */
  multiplayerUseDomain: boolean
  /** 联机 · 启动时自动创建/加入大厅。 */
  multiplayerAutoLobbyEnabled: boolean
  /** 联机 · 自动大厅名称。 */
  multiplayerLobbyName: string
  /** 联机 · 自动大厅密码。 */
  multiplayerLobbyPassword: string
  /** 联机 · 自定义 EasyTier 节点列表（备用节点，内置节点不在此保存）。 */
  multiplayerCustomNodes: Array<{ name: string; address: string }>
  /** 联机 · 提示音音量（0–1）。 */
  multiplayerSoundVolume: number
  /** 联机 · 消息免打扰。 */
  multiplayerDndEnabled: boolean
  /** 联机 · 免打扰起始（自 0 点起的分钟数）。 */
  multiplayerDndStart: number
  /** 联机 · 免打扰结束（自 0 点起的分钟数）。 */
  multiplayerDndEnd: number
  /** 联机 · 全局快捷键：麦克风开关。 */
  multiplayerMicHotkey: string
  /** 联机 · 全局快捷键：全局听筒开关。 */
  multiplayerGlobalMuteHotkey: string
  /** 联机 · 全局快捷键：临时开麦（按住说话）。 */
  multiplayerPushToTalkHotkey: string
  /** 联机 · 全局快捷键：唤出主窗口。 */
  multiplayerSummonHotkey: string
  /** 联机 · 消息弹幕开关。 */
  multiplayerDanmakuEnabled: boolean
  /** 联机 · 弹幕字号（px）。 */
  multiplayerDanmakuFontSize: number
  /** 联机 · 弹幕速度（秒/屏）。 */
  multiplayerDanmakuSpeed: number
  /** 联机 · 弹幕透明度（0–1）。 */
  multiplayerDanmakuOpacity: number
  /** 联机 · 弹幕轨道数。 */
  multiplayerDanmakuTracks: number
  /** 联机 · 游戏内 HUD 浮层开关。 */
  multiplayerHudEnabled: boolean
  /** 联机 · HUD 浮层透明度（0–1）。 */
  multiplayerHudOpacity: number
  /** 联机 · 默认变声器音色。 */
  multiplayerVoiceChanger: string
  /** 联机 · 界面主题偏好（跟随系统 / 亮色 / 暗色）。 */
  multiplayerTheme: 'system' | 'light' | 'dark'
  /** 联机 · 联机时长与统计的本地数据。 */
  multiplayerStatsMinutes: number
  /** 联机 · 加入大厅次数。 */
  multiplayerJoinCount: number
  /** 联机 · 作为房主次数。 */
  multiplayerHostCount: number
}

/* ------------------------------------------------------------------ */
/* 关于页 / 协议 / 更新（来自服务端）                                    */
/* ------------------------------------------------------------------ */

/** 主进程日志窗口的单条日志。 */
export interface DebugLogEntry {
  /** epoch ms */
  ts: number
  level: 'info' | 'warn' | 'error'
  message: string
}

export interface AboutLink {
  name: string
  url: string
}

export interface AboutPerson {
  id: string
  name: string
  /** 职位 / 描述，可选。 */
  role?: string
  /** 头像 URL（可选）。 */
  avatar?: string
  links: AboutLink[]
}

export interface AboutGroup {
  id: string
  name: string
  people: AboutPerson[]
}

export interface AgreementContent {
  privacy: string
  terms: string
  /** 服务端更新时间（epoch ms），可选。 */
  updatedAt?: number
}

export interface UpdateInfo {
  /** 最新版本号，如 "0.2.0"。 */
  version: string
  /** 下载地址（服务端上传的文件或外部链接）。 */
  url: string
  /** 文件名（缺省时从 url 推导）。 */
  filename?: string
  /** 更新说明，可选。 */
  notes?: string
  /** 发布时间（epoch ms），可选。 */
  publishedAt?: number
}

/** 整合包格式。native 为启动器自带格式。 */
export type ModpackFormat = 'modrinth' | 'mcbbs' | 'native'

/** 可导出条目的通用描述（用于文件树复选展示）。 */
export interface ExportItem {
  name: string
  /** 字节数；目录或未知大小时为 0。 */
  size: number
}

/** 导出一个实例时可选择的全部内容清单（由主进程扫描得到）。 */
export interface ModpackExportInventory {
  hasGameSettings: boolean
  hasModConfigs: boolean
  hasServersList: boolean
  worlds: ExportItem[]
  resourcePacks: ExportItem[]
  hasJei: boolean
  gunPacks: ExportItem[]
  disabledMods: ExportItem[]
  schematics: ExportItem[]
}

/** 用户在导出界面所做的选择。 */
export interface ModpackExportOptions {
  format: ModpackFormat
  includeGameSettings: boolean
  includeModConfigs: boolean
  includeServersList: boolean
  worlds: string[]
  resourcePacks: string[]
  includeJei: boolean
  gunPacks: string[]
  includeDisabledMods: boolean
  schematics: string[]
}

/* ------------------------------------------------------------------ */
/* 启动器自实现的资源管理器（替代打开系统资源管理器）                     */
/* ------------------------------------------------------------------ */

/** 目录里的一项。 */
export interface FileEntry {
  name: string
  /** 绝对路径 */
  path: string
  isDir: boolean
  /** 字节数；目录为 0 */
  size: number
  /** 修改时间（epoch ms） */
  mtime: number
}

/** 左栏快捷入口：驱动器或常用位置。 */
export interface FilePlace {
  name: string
  path: string
  kind: 'drive' | 'place'
}

/** 内置编辑器读到的文本文件内容。 */
export interface FileTextContent {
  content: string
  /** 字节数 */
  size: number
  /** 修改时间（epoch ms） */
  mtime: number
}

/** 整合包探测结果（导入前用于展示与重命名）。 */
export interface ModpackProbe {
  format: ModpackFormat
  name: string
  mcVersion: string
  loader: string | null
  loaderVersion: string
  summary: string
}

export interface UpdateCheckResult {
  /** 当前启动器版本。 */
  currentVersion: string
  /** 服务端发布的最新版本信息；服务端不可达时为 null。 */
  latest: UpdateInfo | null
  hasUpdate: boolean
  /**
   * 服务端最新版本是否为测试版（版本号带 `-` 后缀，如 0.5.0-dev1）。
   * 为 true 时启动自动检查不弹提示（仍可由设置页手动检查 / 安装）。
   */
  latestIsPrerelease: boolean
}

export type LoaderKind = 'fabric' | 'quilt'

/** Forge-family loaders, installed by running their installer with Java. */
export type ForgeKind = 'forge' | 'neoforge'

/** Modrinth project types we surface in the UI. */
export type ModrinthType = 'mod' | 'resourcepack' | 'shader' | 'modpack'

/**
 * 资源来源。缺省（undefined）视为 Modrinth；CurseForge 的结果会显式标注。
 * 之所以用可选字段而不是必填：Modrinth 的 DTO 由网络进程构造，路径很长，
 * 让「只有新增来源才需要标注」可以把改动面压到最小。
 */
export type ModSource = 'modrinth' | 'curseforge'

/** 资源下载页的来源筛选。 */
export type SourceFilter = 'all' | 'modrinth' | 'curseforge'

/** Folder names inside a game directory. */
export type ResourceKind = 'resourcepacks' | 'shaderpacks'

export interface ResourceFile {
  name: string
  size: number
  path: string
  /** Modrinth 项目标题（联网补齐后才有；「仅获取元数据」或本地模式下不联网，恒为空）。 */
  displayName?: string
  /** Modrinth 项目图标，命中时才有。 */
  iconUrl?: string
  /** Modrinth 项目 slug，命中时才有，用于打开详情页。 */
  slug?: string
  /** Modrinth 项目简介，命中时才有。 */
  description?: string
  /** 元数据来源；缺省为 Modrinth。 */
  source?: ModSource
  /** 项目主页地址（见 ModrinthProject.pageUrl）。 */
  pageUrl?: string
}

/** 后台补齐已安装光影 / 资源包 Modrinth 元数据时的推送载荷。 */
export interface ResourceUpdated {
  versionId: string
  kind: ResourceKind
  file: ResourceFile
}

/** 可检测更新的资源类型：模组 / 资源包 / 光影。 */
export type UpdateKind = 'mod' | 'resourcepack' | 'shader'

/**
 * 单个资源的更新检测结果。
 *
 * **只在「能确认本地文件确实来自该项目、且该项目有更新的兼容版本」时才产生**：
 * 认错项目会导致更新时删掉用户的资源，所以定位不到本地版本时一律不报（见 resource-updates.ts）。
 */
export interface ResourceUpdateInfo {
  /** 本地文件绝对路径；与 ModEntry.path / ResourceFile.path 一致，作为界面 key。 */
  path: string
  kind: UpdateKind
  /** 本地当前版本号（能从版本列表里定位到时才有）。 */
  currentVersion: string
  /** Modrinth 上最新的兼容版本号。 */
  latestVersion: string
  /** 最新版本的下载文件（primary 优先）。 */
  fileUrl: string
  filename: string
  size: number
  /** Modrinth 项目 slug。 */
  slug: string
  /** Modrinth 项目标题。 */
  title: string
}

/** 更新检测的增量推送：每判定完一项推送一次；update 为 null 表示该项无更新 / 无法判断。 */
export interface ResourceUpdateEvent {
  versionId: string
  path: string
  kind: UpdateKind
  update: ResourceUpdateInfo | null
}

export interface ModrinthProject {
  slug: string
  title: string
  description: string
  icon_url?: string
  downloads: number
  categories: string[]
  project_type: string
  /** 来源；缺省为 Modrinth。 */
  source?: ModSource
  /**
   * 项目主页地址。CurseForge 是 curseforge.com/…，Modrinth 由界面按类型拼；
   * 有这个字段时界面优先用它，避免把 CurseForge 项目链到 modrinth.com。
   */
  pageUrl?: string
  /** 是否允许第三方渠道下载（CurseForge 的 allowModDistribution；false = 只能去官网下）。 */
  downloadable?: boolean
}

/** Modrinth 单个项目的完整信息（含 body 完整介绍，用于「完整介绍」弹窗）。 */
export interface ModrinthProjectDetail {
  slug: string
  title: string
  description: string
  /** 完整介绍正文（Markdown）。 */
  body: string
  icon_url?: string
  downloads: number
  categories: string[]
  project_type: string
  /** 来源；缺省为 Modrinth。 */
  source?: ModSource
  /** 项目主页地址（见 ModrinthProject.pageUrl）。 */
  pageUrl?: string
}

/** Modrinth 搜索分页结果。 */
export interface ModrinthSearchResult {
  hits: ModrinthProject[]
  /** 搜索结果总数（用于判断是否还有更多可加载）。 */
  totalHits: number
}

/** Modrinth 版本声明的依赖项。 */
export interface ModrinthDependency {
  /** 依赖的具体版本 id；null 表示不限版本，取适配的任意版本。 */
  version_id: string | null
  /** 依赖的项目 id。 */
  project_id: string | null
  /** 依赖的文件名（部分条目提供）。 */
  file_name: string | null
  /** required=必需前置；optional=可选；incompatible=互斥；embedded=已内嵌。 */
  dependency_type: 'required' | 'optional' | 'incompatible' | 'embedded'
}

export interface ModrinthVersion {
  id: string
  name: string
  version_number: string
  game_versions: string[]
  loaders: string[]
  downloads: number
  date_published?: string
  files: Array<{ url: string; filename: string; primary: boolean; size: number }>
  /** 依赖声明；required 项在安装到实例时需检查是否已有前置。 */
  dependencies?: ModrinthDependency[]
  /** 来源；缺省为 Modrinth。 */
  source?: ModSource
  /** 是否可在启动器内直接下载（CurseForge 禁止分发时为 false）。 */
  downloadable?: boolean
  /** 文件页地址（禁止分发时用于跳转官网）。 */
  pageUrl?: string
}

/* ------------------------------------------------------------------ */
/* 自定义主页（单文件 HTML 脚本）                                        */
/* ------------------------------------------------------------------ */

/**
 * 脚本元信息块 `<!--@hcpage { … } -->` 的解析结果。
 * 服务端分配编号后会把 id 注入该块，其余字节保持不变。
 */
export interface HomepageMeta {
  /** 服务端分配的编号（HC-XXXXXX）；空串表示无编号脚本，走本地检测流程。 */
  id: string
  name: string
  author: string
  version: string
  description: string
  /** 要求的最低启动器版本；空串表示不限制。 */
  minLauncher: string
}

/** 静态检测发现的外部地址。 */
export interface HomepageExternal {
  url: string
  /** 用途：脚本 / 样式 / 图片 / 接口请求 / 页面嵌套 / 链接。 */
  kind: string
  /** 是否为外链脚本（.js/.mjs）：内容会被取回后按本地规则判断，而非直接拒绝。 */
  code?: boolean
}

/** 脚本静态安全检测结果。 */
export interface HomepageRisk {
  /** safe 可直接运行；warn 需用户确认；reject 一律拒绝运行。 */
  level: 'safe' | 'warn' | 'reject'
  /** 命中「拒绝运行」规则的中文原因。 */
  blocks: string[]
  /** 检测到的外部地址清单（写明有什么）。 */
  externals: HomepageExternal[]
}

/** 运行时被安全策略拦截后的封锁记录（按脚本标识绑定，内容改动不会自动解除）。 */
export interface HomepageBlock {
  /** epoch ms */
  at: number
  /** 命中的危险行为说明。 */
  reason: string
}

/** 联网校验结果。 */
export type HomepageVerify = 'verified' | 'mismatch' | 'local' | 'unchecked'

/** 本地已安装的主页脚本（不含脚本正文）。 */
export interface HomepageEntry {
  /** 本地文件标识（文件名主干），用于引用脚本。 */
  id: string
  meta: HomepageMeta
  sha256: string
  size: number
  /** epoch ms */
  installedAt: number
  risk: HomepageRisk
  /** 最近一次联网校验结果；'local' 表示无编号脚本无需联网。 */
  verify: HomepageVerify
  /** 当前脚本内容是否已被用户确认运行（无编号脚本首次确认）。 */
  confirmed: boolean
  /** 当前脚本内容是否已被用户授权联网。 */
  networkApproved: boolean
  /** 是否为当前启用的主页。 */
  active: boolean
  /** 运行时被安全策略拦截过：一旦存在即永久禁止再启用，只能删除或重新导入。 */
  blocked?: HomepageBlock
}

/** 本地已安装的主页脚本（含脚本正文）。 */
export interface HomepageSource extends HomepageEntry {
  content: string
}

/** 联网校验的完整返回。 */
export interface HomepageVerifyResult {
  entry: HomepageEntry
  /** 联网请求是否成功；false 表示服务端不可达，按无编号脚本流程处理。 */
  reachable: boolean
  /** 面向用户的中文说明。 */
  message: string
  /** 服务端查无此编号（未上架 / 已下架 / 私密）；与「哈希不一致」需分别提示。 */
  notFound?: boolean
  /**
   * 哈希不一致、但线上存在新版本：说明只是本地版本过期，而非脚本被篡改。
   * 界面应优先引导更新；只有确认没有新版本时才按「哈希不一致」拒绝运行。
   */
  outdated?: boolean
  /** 存在新版本时的本地版本号（用于提示「v旧 → v新」）。 */
  localVersion?: string
  /** 存在新版本时的线上最新版本号。 */
  latestVersion?: string
}

/** 主页市场条目（服务端下发）。 */
export interface MarketScript {
  id: string
  name: string
  author: string
  description: string
  version: string
  sha256: string
  size: number
  downloads: number
  /** epoch ms */
  updatedAt: number
  /** 服务端上的脚本下载地址。 */
  url: string
}

/** 主页「可更新」检测结果：某个已安装脚本在服务端有更新版本。 */
export interface HomepageUpdate {
  /** 本地已安装脚本的标识（HomepageEntry.id）。 */
  localId: string
  /** 服务端编号（HC-XXXXXX）。 */
  id: string
  name: string
  author: string
  /** 本地已安装版本号。 */
  localVersion: string
  /** 服务端最新版本号。 */
  latestVersion: string
  /** 服务端最新脚本 SHA256（与本地不同即视为有更新）。 */
  latestSha256: string
  /** 服务端上的下载地址。 */
  url: string
  /** 服务端最新脚本大小（字节）；已知时可跳过下载前的 HEAD 探测。 */
  size?: number
  /** 服务端更新时间（epoch ms）。 */
  updatedAt: number
}

/** 投稿内容（启动器内自助投稿）。 */
export interface HomepageSubmitPayload {
  filename: string
  /** 脚本原文（base64）。 */
  contentBase64: string
  name: string
  author: string
  description: string
  version: string
  visibility: 'public' | 'private'
  /** 开发者邮箱：用于接收验证码与审核结果 / 永久管理链接。 */
  email: string
  /** 邮箱验证码（6 位数字）。 */
  code: string
}

/** 发送邮箱验证码的结果。 */
export interface HomepageEmailCodeResult {
  ok: boolean
  /** 验证码有效期（秒）。 */
  ttl: number
  /** 重新发送的冷却时间（秒）。 */
  cooldown: number
}

/* ------------------------------------------------------------------ */
/* 开发模式                                                             */
/* ------------------------------------------------------------------ */

/** 开发模式当前状态（供设置页渲染）。 */
export interface DevModeStatus {
  /** 是否有仍在有效期内的授权（未到期且未解除）。 */
  granted: boolean
  /** 授权到期时间（epoch ms，0 = 无）。 */
  expiresAt: number
  /** 开发模式是否开启（granted 为 false 时恒为 false）。 */
  enabled: boolean
  /** 掩码后的授权邮箱，用于展示（如 a***@example.com）。 */
  emailMasked: string
  /** 用户选择的档位（即使未授权也保留，便于下次验证后沿用）。 */
  securityMode: 'full' | 'warn' | 'off'
  /** 实际生效的档位：开发模式未开启时恒为 'full'。 */
  effectiveSecurityMode: 'full' | 'warn' | 'off'
}

/** 开发模式验证码发送结果。 */
export interface DevModeCodeResult {
  ok: boolean
  /** 验证码有效期（秒）。 */
  ttl: number
  /** 重新发送的冷却时间（秒）。 */
  cooldown: number
}

/** 开发模式验证结果。 */
export interface DevModeVerifyResult {
  ok: boolean
  /** 授权到期时间（epoch ms）。 */
  expiresAt: number
  error?: string
}

/** 投稿结果。 */
export interface HomepageSubmitResult {
  id: string
  sha256: string
  visibility: 'public' | 'private'
  /** 服务端注入编号后的最终脚本（base64），私密投稿审核后服务端会删文件，只能靠它留存。 */
  contentBase64: string
}

/** The API surface exposed to the renderer through the preload bridge. */
export interface LauncherApi {
  platform: string
  /** 当前启动器版本号。 */
  getVersion: () => Promise<string>
  debug: {
    /** 读取主进程日志滚动缓冲。 */
    getLogs: () => Promise<DebugLogEntry[]>
    /** 订阅增量日志，返回退订函数。 */
    onLog: (cb: (entry: DebugLogEntry) => void) => () => void
    /** 打开 / 唤起独立日志窗口。 */
    openWindow: () => Promise<void>
    /** 关闭独立日志窗口。 */
    closeWindow: () => Promise<void>
    /** Debug 模式是否开启。 */
    isEnabled: () => Promise<boolean>
  }
  auth: {
    begin: () => Promise<DeviceCodeInfo>
    cancel: () => Promise<void>
    refresh: (account: MinecraftAccount) => Promise<MinecraftAccount>
    onStatus: (cb: (s: AuthStatus) => void) => () => void
  }
  accounts: {
    list: () => Promise<MinecraftAccount[]>
    selected: () => Promise<MinecraftAccount | null>
    /** 补全第三方账号缺失的站点名称（自动获取 meta.serverName），返回更新后的账号列表。 */
    refreshSiteNames: () => Promise<MinecraftAccount[]>
    /** 删除账号：返回删除后的账号列表与新的选中账号（避免再单独读一次导致竞态）。 */
    remove: (id: string) => Promise<{ accounts: MinecraftAccount[]; selected: MinecraftAccount | null }>
    select: (id: string) => Promise<MinecraftAccount | null>
    addOffline: (name: string) => Promise<MinecraftAccount>
    /** 第三方登录：单角色直接返回账号；多角色返回待选角色列表。 */
    addYggdrasil: (server: string, email: string, password: string) => Promise<YggdrasilLoginOutcome>
    /** 提交多角色选择结果，批量创建账号（返回新建的账号列表）。 */
    addYggdrasilProfiles: (ids: string[]) => Promise<MinecraftAccount[]>
  }
  versions: {
    list: () => Promise<VersionManifest>
    get: (id: string) => Promise<VersionJson>
    createVanilla: (baseVersion: string, customName: string) => Promise<void>
    /** 扫描外部 .minecraft 目录中的可导入版本（标注重名）。 */
    scanExternal: (mcDir: string) => Promise<ExternalVersion[]>
    /** 从外部 .minecraft 导入指定版本；重名按 onConflict 策略处理。 */
    importExternal: (
      mcDir: string,
      versionId: string,
      onConflict: ConflictPolicy
    ) => Promise<{ id: string; action: 'imported' | 'renamed' | 'skipped' }>
  }
  installed: {
    list: () => Promise<InstalledVersion[]>
  }
  versionDirs: {
    /** 列出全部版本目录（首项恒为默认目录，isDefault=true）。 */
    list: () => Promise<VersionDir[]>
    /** 添加一个版本目录（可带别名）；返回最新列表。 */
    add: (input: { path: string; alias?: string }) => Promise<VersionDir[]>
    /** 修改某个版本目录的别名 / 路径；返回最新列表。 */
    update: (id: string, patch: { alias?: string; path?: string }) => Promise<VersionDir[]>
    /** 删除某个版本目录（默认目录不可删）；返回最新列表。 */
    remove: (id: string) => Promise<VersionDir[]>
    /** 切换当前版本目录（空串 = 默认目录）；返回生效后的目录 id。 */
    select: (id: string) => Promise<string>
  }
  loaders: {
    versions: (kind: LoaderKind, mcVersion: string) => Promise<string[]>
    install: (kind: LoaderKind, mcVersion: string, loaderVersion: string, customId?: string) => Promise<string>
  }
  forge: {
    versions: (kind: ForgeKind, mcVersion: string) => Promise<string[]>
    install: (kind: ForgeKind, mcVersion: string, version: string, customId?: string) => Promise<string>
    onLog: (cb: (line: string) => void) => () => void
  }
  resources: {
    list: (versionId: string, kind: ResourceKind) => Promise<ResourceFile[]>
    remove: (path: string) => Promise<void>
    open: (versionId: string, kind: ResourceKind) => Promise<string>
    /** 已安装光影 / 资源包的 Modrinth 元数据后台补齐推送（逐个送达所在实例） */
    onUpdated: (cb: (p: ResourceUpdated) => void) => () => void
    /**
     * 进入实例管理时异步检测该实例的模组 / 资源包 / 光影是否有更新。
     * 立即返回「已确认可更新」的清单；其余项在后台判定完后经 onUpdateChecked 逐个推送。
     * 联网关闭（本地模式 / 仅识别元数据）时直接返回空数组。
     */
    checkUpdates: (versionId: string) => Promise<ResourceUpdateInfo[]>
    /** 更新检测的增量推送：每判定完一项推送一次 */
    onUpdateChecked: (cb: (p: ResourceUpdateEvent) => void) => () => void
    /** 把某个资源更新到最新版：下载新版 → 删除旧文件（模组保留原有启用 / 禁用状态） */
    applyUpdate: (versionId: string, update: ResourceUpdateInfo, enabled: boolean) => Promise<string>
  }
  download: {
    install: (id: string) => Promise<{ versionId: string; assetIndex: string }>
    /** 取消下载：传 taskId 只取消该任务，不传则取消全部。 */
    cancel: (taskId?: string) => Promise<boolean>
    /** 当前实际使用的下载器（原生 Rust 内核是否可用）。 */
    engine: () => Promise<DownloadEngineStatus>
    onProgress: (cb: (p: DownloadProgress) => void) => () => void
  }
  mods: {
    search: (
      query: string,
      type?: ModrinthType,
      category?: string,
      gameVersion?: string,
      loader?: string,
      offset?: number,
      /** 来源筛选：全部（两源合并）/ 仅 Modrinth / 仅 CurseForge。 */
      source?: SourceFilter
    ) => Promise<ModrinthSearchResult>
    versions: (
      slug: string,
      loaders: string[],
      gameVersions: string[],
      /** 项目来源；缺省按 Modrinth 处理。 */
      source?: ModSource,
      type?: ModrinthType
    ) => Promise<ModrinthVersion[]>
    /** 获取项目完整信息（含 Markdown 正文），用于「完整介绍」弹窗。 */
    project: (id: string, type?: ModrinthType) => Promise<ModrinthProjectDetail>
    install: (
      fileUrl: string,
      filename: string,
      versionId: string,
      type?: ModrinthType,
      /** 已知文件大小：可跳过下载前的 HEAD 探测（CurseForge 这类重定向 CDN 上能省约 1s/文件）。 */
      sizeHint?: number
    ) => Promise<string>
    downloadTo: (fileUrl: string, destPath: string, sizeHint?: number) => Promise<string>
    installFabricApi: (mcVersion: string, versionId: string) => Promise<string>
  }
  java: {
    detect: () => Promise<JavaRuntime[]>
    check: (versionId: string) => Promise<JavaCheckResult>
    install: (major: number) => Promise<string>
    /** 手动选择 Java 可执行文件，返回识别出的版本信息；用户取消或无法识别时为 null / 抛错。 */
    pick: () => Promise<JavaRuntime | null>
  }
  manage: {
    mods: (versionId: string) => Promise<ModEntry[]>
    onModsUpdated: (cb: (e: { versionId: string; mod: ModEntry }) => void) => () => void
    toggleMod: (path: string) => Promise<void>
    deleteMod: (path: string) => Promise<void>
    installLocalMod: (versionId: string, sourcePath: string) => Promise<string>
    deleteWorld: (versionId: string, worldName: string) => Promise<void>
    schematics: (versionId: string) => Promise<SchematicEntry[]>
    deleteFile: (path: string) => Promise<void>
    deleteVersion: (versionId: string) => Promise<void>
    renameVersion: (versionId: string, newName: string) => Promise<void>
    openDir: (versionId: string, kind: VersionDirKind) => Promise<string>
  }
  launch: {
    start: (opts: LaunchOptions) => Promise<{ pid: number }>
    stop: () => Promise<boolean>
    onEvent: (cb: (e: LaunchEvent) => void) => () => void
  }
  settings: {
    get: () => Promise<LauncherSettings>
    set: (partial: Partial<LauncherSettings>) => Promise<LauncherSettings>
    /** 弹系统选图框选自定义壁纸；选中后复制进数据目录并写进设置（取消则原样返回） */
    pickWallpaper: () => Promise<LauncherSettings>
    /** 清除自定义壁纸（删文件 + 清设置） */
    clearWallpaper: () => Promise<LauncherSettings>
    /** 读取当前壁纸的 data URL；没设置 / 文件丢失时返回空串 */
    wallpaperData: () => Promise<string>
  }
  system: {
    memory: () => Promise<SystemMemoryInfo>
    /** 探测 CPU 核心数与内存总量，并给出「是否低配」判定（首次启动自动检测用）。 */
    hardware: () => Promise<SystemHardwareInfo>
  }
  homepage: {
    /** 列出本地已安装的主页脚本。 */
    list: () => Promise<HomepageEntry[]>
    /** 读取脚本正文与静态检测结果。 */
    read: (id: string) => Promise<HomepageSource>
    /** 打开文件选择器导入本地脚本；用户取消时返回 null。 */
    importFile: () => Promise<HomepageEntry | null>
    /** 从主页市场下载并安装脚本。sizeHint 为已知文件大小时可跳过 HEAD 探测。 */
    download: (url: string, filename: string, sizeHint?: number) => Promise<HomepageEntry>
    /** 删除已安装脚本。 */
    remove: (id: string) => Promise<void>
    /** 联网核对编号 + SHA256；无编号或服务端不可达时回落本地流程。 */
    verify: (id: string) => Promise<HomepageVerifyResult>
    /** 记录用户对当前脚本内容的确认（network=true 表示同时授权联网）。 */
    confirm: (id: string, network: boolean) => Promise<HomepageEntry>
    /** 设置当前启用的主页脚本，空串表示回到内置界面。 */
    setActive: (id: string) => Promise<void>
    /**
     * 运行时检测到危险代码（删除 / 修改文件、格式化、伪装代码）时调用：
     * 永久封锁该脚本并立即停用（回到内置界面），由渲染层弹出全屏提示。
     */
    block: (id: string, reason: string) => Promise<void>
    /** 打开主页脚本目录。 */
    openDir: () => Promise<string>
    /** 拉取主页市场列表。 */
    market: () => Promise<MarketScript[]>
    /**
     * 检查已安装的「联网校验」主页是否有更新：逐个用编号查服务端，
     * 比对服务端最新 SHA256 与本地哈希，不一致即视为有更新。
     */
    checkUpdates: () => Promise<HomepageUpdate[]>
    /** 从服务端下载并覆盖安装某个可更新脚本，返回更新后的本地条目。 */
    update: (update: HomepageUpdate) => Promise<HomepageEntry>
    /** 自助投稿。 */
    submit: (payload: HomepageSubmitPayload) => Promise<HomepageSubmitResult>
    /** 投稿前给开发者邮箱发送验证码。 */
    sendEmailCode: (email: string) => Promise<HomepageEmailCodeResult>
    /** 把服务端回传的已编号脚本落到本地（投稿后可直接启用）。 */
    installNumbered: (input: {
      filename: string
      contentBase64: string
      replaceId?: string
    }) => Promise<HomepageEntry>
    /** 把脚本日志写入主进程调试日志缓冲区（仅在 Debug 模式可见）。 */
    log: (level: DebugLogEntry['level'], message: string) => void
    /**
     * 订阅「沙箱主页尝试自我导航（跳转）到外部地址」事件：主进程已在导航发生前拦截，
     * 渲染层据此弹出全屏封锁遮罩（F-05 导航外泄）。
     */
    onNavBlocked: (cb: (url: string) => void) => () => void
  }
  devMode: {
    /** 读取开发模式当前状态（含授权是否有效、是否开启、档位）。 */
    status: () => Promise<DevModeStatus>
    /** 向指定邮箱发送开发模式验证码（邮箱须在后台白名单内）。 */
    sendCode: (email: string) => Promise<DevModeCodeResult>
    /** 校验验证码；通过后获得 1 天授权。 */
    verify: (email: string, code: string) => Promise<DevModeVerifyResult>
    /** 在授权有效期内开关开发模式。 */
    setEnabled: (enabled: boolean) => Promise<DevModeStatus>
    /** 在授权有效期内解除授权（立即关闭并作废令牌）。 */
    revoke: () => Promise<DevModeStatus>
    /** 设置主页安全防护档位。 */
    setSecurityMode: (mode: 'full' | 'warn' | 'off') => Promise<DevModeStatus>
    /** 打开独立「开发者工具（F12）」窗口（仅在开发模式开启时生效）。 */
    openTools: () => Promise<void>
    /** 关闭独立开发者工具窗口。 */
    closeTools: () => Promise<void>
    /**
     * 打开主窗口的原生 Chromium DevTools（元素 / 控制台 / 网络 / 源代码），
     * 以独立窗口（detach）形式展示，避免挤占主界面；仅在开发模式开启时生效。
     * 返回是否成功打开。
     */
    openDevTools: () => Promise<boolean>
    /** 关闭主窗口的原生 Chromium DevTools。 */
    closeDevTools: () => Promise<void>
    /** 订阅开发模式状态变化（到期自动关闭等），返回退订函数。 */
    onChanged: (cb: (s: DevModeStatus) => void) => () => void
  }
  modpack: {
    probe: (filePath: string) => Promise<ModpackProbe>
    download: (url: string, filename: string) => Promise<string>
    import: (filePath: string, customName?: string) => Promise<{ versionId: string; name: string }>
    importFromUrl: (url: string, filename: string, customName?: string) => Promise<{ versionId: string; name: string }>
    exportInventory: (versionId: string) => Promise<ModpackExportInventory>
    export: (versionId: string, options: ModpackExportOptions) => Promise<string>
    onProgress: (cb: (p: DownloadProgress) => void) => () => void
  }
  about: {
    list: () => Promise<AboutGroup[]>
    agreement: () => Promise<AgreementContent>
  }
  update: {
    check: () => Promise<UpdateCheckResult>
    download: (info: UpdateInfo) => Promise<string>
    downloadAndRun: (info: UpdateInfo) => Promise<string>
    onProgress: (cb: (p: DownloadProgress) => void) => () => void
  }
  translate: {
    /**
     * 经在线翻译接口批量翻译文本，返回 [原文, 译文] 对。
     * 未翻出来的条目译文为空串（区别于「无需翻译」时返回原文），便于上层决定是否重试。
     */
    texts: (texts: string[], target: string) => Promise<Array<[string, string]>>
    /**
     * 保存 API KEY：先真实请求一次做连通性测试，通过才加密落盘。
     * 返回可直接展示给用户的结论（成功 / KEY 无效 / 限流 / 无法连接 / 系统不支持安全存储）。
     */
    setKey: (key: string) => Promise<{ ok: boolean; message: string }>
    /** 删除已保存的 API KEY，回到访客额度。 */
    clearKey: () => Promise<{ ok: boolean; message: string }>
  }
  window: {
    minimize: () => Promise<void>
    maximize: () => Promise<void>
    close: () => Promise<void>
    isMaximized: () => Promise<boolean>
    /** 切换全屏（Win10 桌面模式进入时全屏、退出时还原），返回切换后的状态。 */
    setFullscreen: (on: boolean) => Promise<boolean>
    /** 置顶窗口（通用能力；桌面模式已改为普通全屏，不再调用）。 */
    setAlwaysOnTop: (on: boolean) => Promise<boolean>
    /**
     * 桌面模式外壳：普通全屏（不置顶、不隐藏系统任务栏）；关闭时还原。
     */
    setDesktopMode: (on: boolean) => Promise<boolean>
    /**
     * 安全拦截期间强制系统全屏（连 Windows 任务栏一起盖住）。
     *
     * on=true 时记住当前窗口状态再全屏；on=false 时精确还原（本来是全屏 / 最大化都不会被破坏）。
     * 从未强制过就调用 on=false 时不做任何事，避免误改窗口状态。
     */
    securityFullscreen: (on: boolean) => Promise<boolean>
  }
  /** 显示器信息（用于「游戏窗口尺寸」的自定义与预览）。 */
  display: {
    /**
     * 主显示器尺寸，均为逻辑像素（DIP）。
     * width/height 为整屏；workWidth/workHeight 为工作区（已排除任务栏，
     * 任务栏设为自动隐藏时二者相等）。
     */
    primary: () => Promise<{
      width: number
      height: number
      workWidth: number
      workHeight: number
      scaleFactor: number
    }>
  }
  /**
   * 启动器自实现的资源管理器：只做「浏览 + 打开」，
   * 用于替代打开系统资源管理器（桌面模式下不再捕获 explorer 窗口）。
   */
  files: {
    /** 左栏快捷入口：驱动器（Windows 盘符）+ 常用位置（游戏目录 / 下载 / 主页目录…） */
    places: () => Promise<FilePlace[]>
    /** 列出一个目录；失败时抛出带中文说明的错误 */
    list: (path: string) => Promise<FileEntry[]>
    /** 用系统默认程序打开文件 / 目录（返回空串表示成功） */
    open: (path: string) => Promise<string>
    /** 在**系统**资源管理器中定位该项（应急出口） */
    reveal: (path: string) => Promise<void>
    /** 改名（只换同一目录下的名字，不移动）；同级重名会被拒绝。返回新路径 */
    rename: (path: string, name: string) => Promise<string>
    /** 在目录下新建空文件；已存在同名文件会被拒绝。返回新路径 */
    createFile: (dir: string, name: string) => Promise<string>
    /** 删除文件或目录（目录连同内容一起删） */
    remove: (path: string) => Promise<void>
    /** 读取文本文件给内置编辑器用；二进制 / 过大文件会拒绝 */
    readText: (path: string) => Promise<FileTextContent>
    /** 保存内置编辑器里的文本（覆盖原文件） */
    writeText: (path: string, content: string) => Promise<void>
  }
  shell: {
    openExternal: (url: string) => Promise<void>
    openPath: (path: string) => Promise<string>
    chooseDirectory: () => Promise<string | null>
    pickFile: (filters?: Array<{ name: string; extensions: string[] }>) => Promise<string | null>
    pickFiles: (filters?: Array<{ name: string; extensions: string[] }>) => Promise<string[]>
    saveFile: (defaultName: string) => Promise<string | null>
    getPathForFile: (file: File) => string
  }
  /** 联机板块（界面与后端移植自 MCTier）。 */
  mp: MpApi
}

/* ------------------------------------------------------------------ */
/* 联机板块（MCTier 移植）                                              */
/* ------------------------------------------------------------------ */

/** 组网二进制自检结果。 */
export interface MpBinaryStatus {
  /** 二进制名 → 是否存在。 */
  present: Record<string, boolean>
  missing: string[]
  corrupted: string[]
  /** 资源目录（提示用户放文件的位置）。 */
  dir: string
  /** core + 驱动是否就绪。 */
  ready: boolean
  reason: string
}

export type MpAppState = 'idle' | 'connecting' | 'in-lobby'

/** 大厅信息。 */
export interface MpLobby {
  name: string
  password: string
  serverNode: string
  signalingServer: string
  virtualIp: string
  useDomain: boolean
  isHost: boolean
  createdAt: string
}

/** 大厅成员。 */
export interface MpPlayer {
  id: string
  name: string
  virtualIp?: string
  virtualDomain?: string
  useDomain?: boolean
  micEnabled: boolean
  isMuted: boolean
  joinedAt: string
  isSelf: boolean
}

/** 创建 / 加入大厅的入参。 */
export interface MpJoinParams {
  name: string
  password: string
  playerName: string
  playerId: string
  serverNode: string
  signalingServer: string
  useDomain?: boolean
}

export interface MpApi {
  binariesStatus: () => Promise<MpBinaryStatus>
  openResourceDir: () => Promise<string>
  /** 当前是否以管理员 / root 运行（创建虚拟网卡必需）。 */
  isElevated: () => Promise<boolean>
  createLobby: (params: MpJoinParams) => Promise<MpLobby>
  joinLobby: (params: MpJoinParams) => Promise<MpLobby>
  leaveLobby: () => Promise<void>
  forceStop: () => Promise<void>
  getAppState: () => Promise<MpAppState>
  getLobby: () => Promise<MpLobby | null>
  getPlayers: () => Promise<MpPlayer[]>
  setMicEnabled: (enabled: boolean) => Promise<void>
  getMicEnabled: () => Promise<boolean>
  setGlobalMuted: (muted: boolean) => Promise<void>
  getGlobalMuted: () => Promise<boolean>
  mutePlayer: (playerId: string, muted: boolean) => Promise<void>
  isPlayerMuted: (playerId: string) => Promise<boolean>
  parseVirtualIp: (text: string) => Promise<string | null>
  openExternal: (url: string) => Promise<void>
  /** 大厅悬浮窗（类似 MCTier 的迷你窗）：创建 / 关闭 / 快照 / 尺寸。 */
  openMiniWindow: () => Promise<void>
  closeMiniWindow: () => Promise<void>
  miniState: () => Promise<MpMiniState>
  miniResize: (width: number, height: number) => Promise<void>
  onMiniState: (cb: (state: MpMiniState) => void) => () => void
  /**
   * 大厅状态变化广播（主界面 / 悬浮窗都可能发起操作，需双向同步）。
   *
   * 回调不携带数据：收到后由调用方重新 `getLobby() / getPlayers()` 拉取，
   * 这样只有一个事实来源（主进程），不会因广播的旧快照产生状态错乱。
   */
  onLobbyChanged: (cb: () => void) => () => void
  /** 当前窗口是否为主界面（悬浮窗据此决定退出大厅后是否自行关闭）。 */
  hasMainWindow: () => Promise<boolean>
  onMicChanged: (cb: (enabled: boolean) => void) => () => void
}

/** 悬浮窗所需的大厅快照。 */
export interface MpMiniState {
  lobby: MpLobby | null
  players: MpPlayer[]
  appState: MpAppState
}

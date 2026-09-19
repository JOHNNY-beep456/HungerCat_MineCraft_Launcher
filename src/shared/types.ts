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
  /** Yggdrasil 客户端令牌（用于刷新令牌）。 */
  clientToken?: string
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
  state: LaunchState
  pid?: number
  log?: string
  exitCode?: number
  error?: string
}

export interface LauncherSettings {
  theme: 'light' | 'dark' | 'system'
  memoryMb: number
  maxDownloadConcurrency: number
  mirror: 'mojang' | 'bmclapi'
  gameDir: string
  javaAutoDetect: boolean
  javaPath?: string
  closeOnLaunch: boolean
  reducedMotion: boolean
  /** Each version gets its own isolated game directory (saves/mods/config). */
  versionIsolation: boolean
  /** Custom accent color (hex). */
  accentColor: string
  /** Background preset key. */
  background: string
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
}

/* ------------------------------------------------------------------ */
/* 关于页 / 协议 / 更新（来自服务端）                                    */
/* ------------------------------------------------------------------ */

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
}

export type LoaderKind = 'fabric' | 'quilt'

/** Forge-family loaders, installed by running their installer with Java. */
export type ForgeKind = 'forge' | 'neoforge'

/** Modrinth project types we surface in the UI. */
export type ModrinthType = 'mod' | 'resourcepack' | 'shader' | 'modpack'

/** Folder names inside a game directory. */
export type ResourceKind = 'resourcepacks' | 'shaderpacks'

export interface ResourceFile {
  name: string
  size: number
  path: string
}

export interface ModrinthProject {
  slug: string
  title: string
  description: string
  icon_url?: string
  downloads: number
  categories: string[]
  project_type: string
}

/** Modrinth 搜索分页结果。 */
export interface ModrinthSearchResult {
  hits: ModrinthProject[]
  /** 搜索结果总数（用于判断是否还有更多可加载）。 */
  totalHits: number
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
}

/** The API surface exposed to the renderer through the preload bridge. */
export interface LauncherApi {
  platform: string
  /** 当前启动器版本号。 */
  getVersion: () => Promise<string>
  auth: {
    begin: () => Promise<DeviceCodeInfo>
    cancel: () => Promise<void>
    refresh: (account: MinecraftAccount) => Promise<MinecraftAccount>
    onStatus: (cb: (s: AuthStatus) => void) => () => void
  }
  accounts: {
    list: () => Promise<MinecraftAccount[]>
    selected: () => Promise<MinecraftAccount | null>
    remove: (id: string) => Promise<MinecraftAccount[]>
    select: (id: string) => Promise<MinecraftAccount | null>
    addOffline: (name: string) => Promise<MinecraftAccount>
    addYggdrasil: (server: string, email: string, password: string) => Promise<MinecraftAccount>
  }
  versions: {
    list: () => Promise<VersionManifest>
    get: (id: string) => Promise<VersionJson>
    createVanilla: (baseVersion: string, customName: string) => Promise<void>
  }
  installed: {
    list: () => Promise<InstalledVersion[]>
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
  }
  download: {
    install: (id: string) => Promise<{ versionId: string; assetIndex: string }>
    cancel: () => Promise<boolean>
    onProgress: (cb: (p: DownloadProgress) => void) => () => void
  }
  mods: {
    search: (query: string, type?: ModrinthType, category?: string, gameVersion?: string, loader?: string, offset?: number) => Promise<ModrinthSearchResult>
    versions: (slug: string, loaders: string[], gameVersions: string[]) => Promise<ModrinthVersion[]>
    install: (fileUrl: string, filename: string, versionId: string, type?: ModrinthType) => Promise<string>
    downloadTo: (fileUrl: string, destPath: string) => Promise<string>
    installFabricApi: (mcVersion: string, versionId: string) => Promise<string>
  }
  java: {
    detect: () => Promise<JavaRuntime[]>
    check: (versionId: string) => Promise<JavaCheckResult>
    install: (major: number) => Promise<string>
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
  }
  system: {
    memory: () => Promise<SystemMemoryInfo>
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
  window: {
    minimize: () => Promise<void>
    maximize: () => Promise<void>
    close: () => Promise<void>
    isMaximized: () => Promise<boolean>
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
}

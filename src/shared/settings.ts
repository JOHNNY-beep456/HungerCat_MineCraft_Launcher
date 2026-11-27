/**
 * 设置的**单一真源**（主进程与渲染层共用）。
 *
 * 目标：让「改一处、其它板块自动响应」成为默认行为，而不是靠人工同步。
 *
 * 1. **默认值集中**：`SETTINGS_DEFS` 里的 `default` 是唯一默认值来源。
 *    主进程 `getDefaultSettings()` 与渲染层兜底对象都从这里派生，不再各写一份
 *    （历史上两处各写一份、改一处忘另一处，是隐蔽 bug 的温床）。
 *
 * 2. **设置页自动渲染**：某项设置若带 `ui` 字段，设置页对应板块即会**自动渲染**：
 *    - `control` 为 `number` / `switch` / `segmented` / `select` 时，标签、控件、选项、
 *      说明全部来自 `ui`，无需任何组件代码；
 *    - `control` 为 `custom` 时，由渲染层的自定义行组件接管（键 = 字段名）。
 *    因此新增设置（如「下载器」多一个可配置参数）只要在此登记 `default` + `ui`，
 *    设置页就会自动出现对应配置项，无需改任何板块代码。
 *
 * 约束：本文件必须保持**纯数据 / 无副作用**，不得引入 electron、node 或浏览器专有 API
 * （自定义行组件在渲染层注册，不放这里），因为它同时被主进程（node）与渲染层（浏览器）打包。
 */
import type { LauncherSettings } from './types'

/** 设置页可渲染的控件类型；`custom` 表示交由渲染层自定义行组件渲染。 */
export type SettingControl = 'number' | 'switch' | 'segmented' | 'select' | 'custom'

/**
 * 控件「何时禁用」的已知条件（纯数据枚举，由设置页求值）。
 *   local                    当前为「本地」运行模式
 *   autoThemeFromWallpaper   开启了「随壁纸切主题」
 *   autoTranslateOff         关闭了「自动翻译」
 *   accentLocked             当前皮肤自带主色（覆盖 --fill-primary），主题色不生效
 *   backgroundLocked         当前皮肤固定/隐藏了整窗背景，背景预设与壁纸不生效
 */
export type SettingDisableWhen =
  | 'local'
  | 'autoThemeFromWallpaper'
  | 'autoTranslateOff'
  | 'accentLocked'
  | 'backgroundLocked'

/** 皮肤标识（与 `LauncherSettings.experimental` 同域）。 */
export type SkinId = LauncherSettings['experimental']

/**
 * 各皮肤**接管**了哪两类外观设置。
 *
 * 这张表是实证得出的，不是按印象填的：判定依据是 index.css 里该皮肤是否
 *   · 覆盖 `--fill-primary`            → 主题色被皮肤自带主色取代（accent）
 *   · 隐藏或重绘 `.app-background`      → 背景预设/壁纸被皮肤接管（background）
 * 例如 win10 直接把 `.app-background` 设为 display:none，material 把背景换成
 * M3 的 surface 色；而 glass / mac / mica 两项都沿用用户的设置，故不在表内。
 *
 * 被接管的项在设置页置灰，并跳过对应设置的实际应用（见 store 的壁纸 effect）。
 */
export const SKIN_LOCKS: Partial<Record<SkinId, { accent?: boolean; background?: boolean }>> = {
  github: { accent: true, background: true },
  material: { background: true },
  minecraft: { accent: true, background: true },
  winui2: { accent: true, background: true },
  winui3: { accent: true, background: true },
  win10: { background: true },
  pcl2: { accent: true, background: true }
}

/** 取某皮肤接管的项（未列出的皮肤表示两项都尊重用户设置）。 */
export function skinLocks(skin: SkinId | undefined): { accent: boolean; background: boolean } {
  const l = (skin && SKIN_LOCKS[skin]) || {}
  return { accent: Boolean(l.accent), background: Boolean(l.background) }
}

/**
 * 当前皮肤是否接管主题色 / 背景（供设置页置灰与 store 跳过实际应用共用）。
 * 与 `SKIN_LOCKS` 单点对应，避免两处判断漂移。
 */
export function skinTakesOver(s: Pick<LauncherSettings, 'experimental'>): {
  accent: boolean
  background: boolean
} {
  return skinLocks(s.experimental)
}

/**
 * 自定义背景色**此刻是否真的会显示**。返回阻止原因，可用时返回 null。
 *
 *   skin     当前皮肤固定 / 隐藏了整窗背景（SKIN_LOCKS.background）
 *   wallpaper 设了自定义壁纸，图片会盖住整层背景
 *   minimal  极简模式把 `.app-background` 强制成 `--bg-flat`（`!important`）
 *
 * 这三条与 index.css 的实际规则一一对应：只要其中一条成立，自定义背景色就算设了也看不见，
 * 所以设置页据此整组置灰并说明原因（只置灰不说话，用户会以为功能坏了）。
 */
export type CustomBackgroundBlocker = 'skin' | 'wallpaper' | 'minimal'

export function customBackgroundBlockedBy(
  s: Pick<LauncherSettings, 'experimental' | 'backgroundImage' | 'mode'>
): CustomBackgroundBlocker | null {
  if (skinTakesOver(s).background) return 'skin'
  if (s.backgroundImage) return 'wallpaper'
  if (s.mode === 'minimal') return 'minimal'
  return null
}

/** 渐变方向 → CSS 角度。纵向 = 从上到下；横向 = 从左到右；斜向 = 左上到右下。 */
const CUSTOM_BG_ANGLE: Record<LauncherSettings['customBackgroundDirection'], number> = {
  vertical: 180,
  horizontal: 90,
  diagonal: 135
}

/** 合法颜色：只认 `#RRGGBB`（与主进程 accentColor 的校验口径一致）。 */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
}

/**
 * 把设置解析成可直接交给 CSS 的 `background` 值；未启用或当前不生效时返回 null。
 *
 * 生成规则由「颜色个数」决定：1 色 → 纯色；2 / 3 色 → 均匀色标的多段渐变。
 * 颜色先按 `isHexColor` 过滤：旧配置 / 手改过文件时宁可少一段也不要把非法值拼进 CSS。
 */
export function customBackgroundCss(
  s: Pick<
    LauncherSettings,
    | 'experimental'
    | 'backgroundImage'
    | 'mode'
    | 'customBackgroundEnabled'
    | 'customBackgroundCount'
    | 'customBackgroundDirection'
    | 'customBackgroundColors'
  >
): string | null {
  if (!s.customBackgroundEnabled) return null
  if (customBackgroundBlockedBy(s)) return null
  const count = Math.min(3, Math.max(1, Math.trunc(Number(s.customBackgroundCount) || 1)))
  const colors = (s.customBackgroundColors ?? []).slice(0, count).filter(isHexColor)
  if (colors.length === 0) return null
  if (colors.length === 1) return colors[0]
  const angle = CUSTOM_BG_ANGLE[s.customBackgroundDirection] ?? CUSTOM_BG_ANGLE.diagonal
  const step = 100 / (colors.length - 1)
  const stops = colors.map((c, i) => `${c} ${Math.round(i * step)}%`).join(', ')
  return `linear-gradient(${angle}deg, ${stops})`
}

/**
 * 导航栏位置的实际生效值。
 * App（真正渲染导航）与设置页（显示当前值）都走这一个函数，避免显示与实际不一致。
 */
export function effectiveNavPosition(
  s: Pick<LauncherSettings, 'experimental' | 'navPosition'>
): LauncherSettings['navPosition'] {
  return s.navPosition
}

/** 选项：`labelKey` 为 i18n 键，由设置页自动翻译。 */
export interface SettingOption {
  value: string
  labelKey: string
}

/** 通用 UI 元数据（不含控件细节）。 */
interface SettingUIMeta {
  /** 所属板块 id：设置页按此分组渲染（如 `'download'`）。 */
  section: string
  /** 满足任一条件时禁用控件。 */
  disableWhen?: SettingDisableWhen[]
}

/** 标准控件（标签 + 控件 + 选项 / 说明）。 */
export interface SettingUIRow extends SettingUIMeta {
  control: Exclude<SettingControl, 'custom'>
  /** 行标签的 i18n 键。 */
  labelKey: string
  /** number 控件的取值范围。 */
  min?: number
  max?: number
  /** segmented / select 的选项。 */
  options?: SettingOption[]
  /** 行下方说明文字的 i18n 键（可选）。 */
  hintKey?: string
  /** 控件是否始终禁用。 */
  disabled?: boolean
}

/** 自定义控件：由渲染层按字段名查找自定义行组件。 */
export interface SettingUICustom extends SettingUIMeta {
  control: 'custom'
}

export type SettingUI = SettingUIRow | SettingUICustom

/** 单项设置：默认值 + 可选 UI 元数据。 */
export interface SettingDef<T = unknown> {
  default: T
  ui?: SettingUI
}

/** 全部设置定义：键必须与 `LauncherSettings` 完全一致（漏一项即编译报错）。 */
export type SettingsDefs = { [K in keyof LauncherSettings]-?: SettingDef<LauncherSettings[K]> }

/**
 * 设置注册表。
 *
 * - 键 = `LauncherSettings` 字段名；
 * - `default` = 该项默认值（唯一来源）；
 * - `ui` = 可选；带上即会在设置页对应板块出现（顺序 = 本文件声明顺序）。
 *
 * 分组顺序即设置页各板块内的显示顺序。
 */
export const SETTINGS_DEFS: SettingsDefs = {
  /* ============ 通用（板块 id：general） ============ */
  /* 顺序即渲染顺序，按「设置页 → 通用」的条目次序排列：
     明暗模式 → 运行模式 → 主题 → 减少动态效果 → uapis.cn API KEY
     → 背景 → 自定义背景色 → 自定义壁纸 → 导航栏位置 → 显示服务器状态 → 关闭按钮行为 */
  /* 明暗模式（light/dark/system）：文档把它列在「通用」的首位。 */
  theme: {
    default: 'system',
    ui: {
      section: 'general',
      control: 'segmented',
      labelKey: 'settings.row.lightDark',
      disableWhen: ['autoThemeFromWallpaper'],
      options: [
        { value: 'light', labelKey: 'settings.theme.light' },
        { value: 'dark', labelKey: 'settings.theme.dark' },
        { value: 'system', labelKey: 'settings.theme.system' }
      ]
    }
  },
  mode: { default: 'normal', ui: { section: 'general', control: 'custom' } },
  /* 界面主题（皮肤）：原先在「实验性功能」里是九个互斥开关，靠「开一个自动关别的」
     表达单选，读起来像能多选、换皮肤还得点两下。现在做成下拉，主题类型作为子选项。 */
  experimental: { default: 'off', ui: { section: 'general', control: 'custom' } },
  /** 皮肤的子选项：由「界面主题」行按当前皮肤决定是否出现，故无独立 ui。 */
  materialStyle: { default: 'you' },
  githubStyle: { default: 'system' },
  accentColor: {
    default: '#0a84ff',
    ui: { section: 'general', control: 'custom' }
  },
  reducedMotion: { default: false, ui: { section: 'general', control: 'custom' } },
  /* uapis.cn API KEY：真实 KEY 经主进程加密保存，不落入 settings.json。
     这一项是「自定义行」，注册在 `uapisApiKeySet`（派生字段）上，以便让它排在
     「减少动态效果」与「背景」之间 —— AutoSection 的自定义子节点只能追加在末尾，
     排不到中间去。 */
  uapisApiKeySet: { default: false, ui: { section: 'general', control: 'custom' } },
  background: { default: 'midnight', ui: { section: 'general', control: 'custom' } },
  /* 自定义背景色：只有总开关带 `ui`，整组（开关 + 颜色个数 + 方向 + 三个颜色槽位）
     由渲染层的同一个自定义行渲染；后三项是它的子字段，与「主题类型 / 主题色」同一模式。
     顺序排在「背景」之后、「自定义壁纸」之前：壁纸会盖住整个背景层，说在它后面才合逻辑。 */
  customBackgroundEnabled: { default: false, ui: { section: 'general', control: 'custom' } },
  customBackgroundCount: { default: 2 },
  customBackgroundDirection: { default: 'diagonal' },
  customBackgroundColors: { default: ['#0a84ff', '#bf5af2', '#ff9f0a'] },
  backgroundImage: { default: '', ui: { section: 'general', control: 'custom' } },
  /* 导航栏位置：上 / 下 / 左 / 右。上、下是横向长条，左、右是竖栏。
     老配置里的布尔值 topNav 在读取时迁移成 'top' / 'left'（见 main/store.ts）。 */
  navPosition: {
    default: 'left',
    ui: {
      section: 'general',
      control: 'segmented',
      labelKey: 'settings.row.navPosition',
      options: [
        { value: 'top', labelKey: 'settings.nav.top' },
        { value: 'bottom', labelKey: 'settings.nav.bottom' },
        { value: 'left', labelKey: 'settings.nav.left' },
        { value: 'right', labelKey: 'settings.nav.right' }
      ]
    }
  },
  showServerStatus: {
    default: true,
    ui: { section: 'general', control: 'switch', labelKey: 'settings.row.showServerStatus' }
  },
  /* 关闭按钮行为：三选一（每次询问 / 退至后台 / 直接关闭）。 */
  closeBehavior: {
    default: 'ask',
    ui: {
      section: 'general',
      control: 'segmented',
      labelKey: 'settings.row.closeBehavior',
      hintKey: 'settings.closeBehavior.hint',
      options: [
        { value: 'ask', labelKey: 'settings.closeBehavior.ask' },
        { value: 'tray', labelKey: 'settings.closeBehavior.tray' },
        { value: 'quit', labelKey: 'settings.closeBehavior.quit' }
      ]
    }
  },

  /* ============ 语言（板块 id：language） ============ */
  language: { default: 'zh-CN', ui: { section: 'language', control: 'custom' } },
  autoTranslateResources: {
    default: false,
    ui: {
      section: 'language',
      control: 'switch',
      labelKey: 'settings.row.autoTranslate',
      disableWhen: ['local'],
      hintKey: 'settings.exp.autoTranslate.desc'
    }
  },
  translateResourceNames: {
    default: true,
    ui: {
      section: 'language',
      control: 'switch',
      labelKey: 'settings.row.translateResourceNames',
      disableWhen: ['local', 'autoTranslateOff']
    }
  },

  /* ============ 实验性功能（板块 id：experimental） ============ */
  autoThemeFromWallpaper: {
    default: false,
    ui: {
      section: 'experimental',
      control: 'switch',
      labelKey: 'settings.row.autoThemeWallpaper',
      hintKey: 'settings.exp.autoTheme.desc'
    }
  },
  enableMultiplayer: { default: false, ui: { section: 'experimental', control: 'custom' } },
  /* 进程级开关，必须在 app ready 之前读；自定义行里带「需重启」提示与重启按钮。 */
  hardwareAcceleration: { default: false, ui: { section: 'experimental', control: 'custom' } },

  /* ============ 游戏（板块 id：game） ============ */
  /* 顺序即渲染顺序：默认版本目录 → 版本隔离 → 模组信息仅识别元数据 → HUD 显示
     → 游戏窗口尺寸 → 启动游戏后关闭启动器 → Java 运行时（原独立板块，已并入）。 */
  gameDir: { default: '', ui: { section: 'game', control: 'custom' } },
  versionIsolation: {
    default: false,
    ui: { section: 'game', control: 'switch', labelKey: 'settings.row.versionIsolation' }
  },
  metadataOnlyMods: { default: false, ui: { section: 'game', control: 'custom' } },
  /* 游戏内 HUD 浮层：三块内容共用同一个透明置顶穿透窗口（见主进程 syncOverlayWindows），
     所以只有一个总开关 + 一组「显示内容」子选项。整块由 `pages/settings/rows.tsx` 的
     `HudDisplayRows` 手工绘制（主开关关掉时子选项要整体收起，注册表逐行渲染做不到），
     因此只有 `hudEnabled` 带 ui（custom），其余字段只登记默认值。 */
  hudEnabled: { default: false, ui: { section: 'game', control: 'custom' } },
  hudOpacity: { default: 0.8 },
  hudShowMultiplayer: { default: true },
  hudShowAi: { default: true },
  hudShowLyrics: { default: false },
  gameWindowSize: { default: '720p', ui: { section: 'game', control: 'custom' } },
  /** 自定义窗口尺寸：随 gameWindowSize 的自定义行一起渲染，故无独立 ui。 */
  gameWindowWidth: { default: 1280 },
  gameWindowHeight: { default: 720 },
  closeOnLaunch: {
    default: false,
    ui: { section: 'game', control: 'switch', labelKey: 'settings.row.closeOnLaunch' }
  },
  /* Java 运行时：原「Java 运行时」板块已并入「游戏」。
     开关（自动检测）与版本下拉是两条独立自定义行，注册顺序即渲染顺序：
     先开关、再版本选择（关闭自动检测后，下拉才会可用 —— 联动在行内部处理）。 */
  javaAutoDetect: { default: true, ui: { section: 'game', control: 'custom' } },
  javaPath: { default: undefined, ui: { section: 'game', control: 'custom' } },
  /** 实例级 Java 覆盖（versionId → 路径）：在「实例 → 版本」页设置，不占设置页的板块。 */
  versionJava: { default: {} },

  /* ============ 开发者选项（板块 id：dev） ============ */
  /* 原「开发模式」板块 + 原属于「游戏」的 Debug 模式 / 调试密钥，合并为「开发者选项」。
     「开发模式」本身的授权流程是手工绘制的（`DeveloperSection` 的 intro），
     这三项作为注册表字段排在它后面。 */
  debugMode: { default: false, ui: { section: 'dev', control: 'custom' } },
  debugKey: { default: '', ui: { section: 'dev', control: 'custom' } },

  /* ============ 下载（板块 id：download） ============ */
  // CurseForge 官方 API 密钥：应用内嵌的公共客户端密钥（CF 控制台按应用签发），
  // 用户在设置页不可见；失效时在这里更换。留空则 CurseForge 源整体不可用。
  curseforgeApiKey: { default: '$2a$10$X3Oi59zph7PyOAEO/0kyxuQmxAOJxOunNaDT3LJmw2jPzUzZaFCr.' },
  downloadSource: {
    default: 'auto',
    ui: {
      section: 'download',
      control: 'select',
      labelKey: 'settings.row.downloadSource',
      options: [
        { value: 'mirror-first', labelKey: 'settings.source.mirrorFirst' },
        { value: 'auto', labelKey: 'settings.source.auto' },
        { value: 'official-first', labelKey: 'settings.source.officialFirst' }
      ]
    }
  },
  versionListSource: {
    default: 'auto',
    ui: {
      section: 'download',
      control: 'select',
      labelKey: 'settings.row.versionListSource',
      options: [
        { value: 'mirror-first', labelKey: 'settings.source.mirrorFirstList' },
        { value: 'auto', labelKey: 'settings.source.auto' },
        { value: 'official-first', labelKey: 'settings.source.officialFirst' }
      ]
    }
  },
  downloadAcceleration: {
    default: 'auto',
    ui: {
      section: 'download',
      control: 'select',
      labelKey: 'settings.row.acceleration',
      options: [
        { value: 'auto', labelKey: 'settings.accel.auto' },
        { value: 'balanced', labelKey: 'settings.accel.balanced' },
        { value: 'turbo', labelKey: 'settings.accel.turbo' }
      ]
    }
  },
  maxDownloadConcurrency: {
    default: 16,
    ui: { section: 'download', control: 'number', labelKey: 'settings.row.concurrency', min: 1, max: 64 }
  },
  downloadConnections: {
    default: 16,
    ui: { section: 'download', control: 'number', labelKey: 'settings.row.connections', min: 1, max: 256 }
  },

  /* ============ 社区资源（原板块已撤销） ============ */
  /* 「社区资源」板块按设置页改版要求移除。这两个字段仍被下载层与 Mod 列表使用
     （`main/mirror.ts` 的镜像策略、`modListTitles` 的标题展示），因此**保留数据与
     默认值，只去掉 ui 元数据** —— 去掉 ui 后它们不再出现在设置页，行为保持原样。
     注意：这两项此前本就是 `disabled: true`（占位说明），界面上本来也改不了。 */
  communitySource: { default: 'auto' },
  modTitleStyle: { default: 'translated-first' },

  /* ============ 公告 & 更新（板块 id：announce） ============ */
  /* 原「公告」与「更新」两个板块合并成一个（设置页改版要求），因此这里的板块 id
     统一为 `announce`，条目顺序即渲染顺序：公告显示 → 自动检查启动器更新
     → 自动检查主页更新。 */
  announcementDisplay: {
    default: 'all',
    ui: {
      section: 'announce',
      control: 'select',
      labelKey: 'settings.row.announcementDisplay',
      options: [
        { value: 'all', labelKey: 'settings.announcement.all' },
        { value: 'important-only', labelKey: 'settings.announcement.importantOnly' }
      ]
    }
  },
  autoCheckLauncherUpdate: {
    default: true,
    ui: { section: 'announce', control: 'switch', labelKey: 'settings.row.autoCheckLauncher' }
  },
  autoCheckHomepageUpdate: {
    default: true,
    ui: { section: 'announce', control: 'switch', labelKey: 'settings.row.autoCheckHomepage' }
  },

  /* ============ AI 助手（板块 id：ai） ============ */
  /* 这里只登记默认值，不带 `ui`：AI 板块整块由 `pages/settings/AiSection.tsx` 手工绘制。
     原因是这一块的每一行都彼此联动——换接口格式要改默认地址与占位提示、密钥要
     「先测通再落盘」、工具权限是一张随工具清单变化的表——用 `control: 'custom'`
     逐行注册反而要在注册表与渲染层之间来回跳，不如集中在一个组件里读起来清楚。 */
  aiEnabled: { default: false },
  aiFormat: { default: 'openai' },
  aiBaseUrl: { default: 'https://api.openai.com/v1' },
  /* 派生字段：真实密钥在主进程安全存储里，这里只反映「有没有」。 */
  aiApiKeySet: { default: false },
  aiHeaders: { default: '' },
  aiModel: { default: 'gpt-4o-mini' },
  aiHistoryTurns: { default: 10 },
  aiVoiceEnabled: { default: false },
  /* 语音识别模型（OpenAI 兼容接口的 model 字段），不单列一行。 */
  aiVoiceModel: { default: 'whisper-1' },
  aiBallEnabled: { default: false },
  /* 悬浮球位置：-1 = 从未拖动过，按「右下角」现算。 */
  aiBallX: { default: -1 },
  aiBallY: { default: -1 },
  aiAutoAnalyzeErrors: { default: true },
  aiToolsEnabled: { default: false },
  /* 每个工具的授权策略（工具名 → allow / ask / deny）。 */
  aiToolPolicy: { default: {} },

  /* ============ 以下为无独立设置行的字段（默认值仍在此登记） ============ */
  memoryMb: { default: 4096 },
  versionDirs: { default: [] },
  selectedVersionDirId: { default: '' },
  disabledVersions: { default: [] },
  isolatedVersions: { default: [] },
  agreementAcceptedAt: { default: 0 },
  agreementAcceptedVersion: { default: '' },
  announcementSeen: { default: {} },
  onboardingDone: { default: false },
  feedbackLogConsent: { default: false },
  homepageId: { default: '' },
  selectedVersionId: { default: '' },
  hardwareChecked: { default: false },
  /* uapis.cn 的 KEY 是否已保存：注册在「通用」板块顶部（见上面 general 区），
     那里带着 ui 元数据，此处不再重复声明（重复键会覆盖前一处，把设置行弄丢）。 */
  /* 派生字段（不持久化，只随 settings:get 下发给渲染层）：
     portable 决定「默认目录」是否置灰，gameDirAbs 是便携版相对路径解析后的绝对路径。 */
  portable: { default: false },
  gameDirAbs: { default: '' },

  /* ============ 开发者模式（内部状态，UI 由服务端授权流程自绘） ============ */
  devModeGrantedUntil: { default: 0 },
  devModeToken: { default: '' },
  devModeEmailMasked: { default: '' },
  devModeEnabled: { default: false },
  devModeSecurityMode: { default: 'full' },

  /* ============ 联机（专用面板，见 MultiplayerSettings.tsx） ============ */
  multiplayerLicenseAcceptedAt: { default: 0 },
  multiplayerPlayerName: { default: '' },
  multiplayerUsePrivateServer: { default: false },
  multiplayerEasytierServer: { default: 'udp://us01.225284.xyz:11010' },
  multiplayerSignalingServer: { default: 'wss://mctier.pmhs.top/signaling' },
  multiplayerUseDomain: { default: false },
  multiplayerAutoLobbyEnabled: { default: false },
  multiplayerLobbyName: { default: '' },
  multiplayerLobbyPassword: { default: '' },
  multiplayerCustomNodes: { default: [] },
  multiplayerSoundVolume: { default: 0.8 },
  multiplayerSoundNewMsg: { default: true },
  multiplayerSoundJoined: { default: true },
  multiplayerSoundLeft: { default: true },
  multiplayerDndEnabled: { default: false },
  multiplayerDndStart: { default: 1320 },
  multiplayerDndEnd: { default: 480 },
  multiplayerSummonHotkey: { default: 'Ctrl+Alt+M' },
  multiplayerDanmakuEnabled: { default: true },
  multiplayerDanmakuFontSize: { default: 16 },
  multiplayerDanmakuSpeed: { default: 8 },
  multiplayerDanmakuOpacity: { default: 0.85 },
  multiplayerDanmakuTracks: { default: 4 },
  multiplayerTheme: { default: 'system' },
  multiplayerStatsMinutes: { default: 0 },
  multiplayerJoinCount: { default: 0 },
  multiplayerHostCount: { default: 0 }
}

/** 深拷贝默认值：数组 / 对象必须各自独立，避免多处共享同一引用。 */
function cloneDefault<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneDefault(item)) as unknown as T
  if (value && typeof value === 'object') return { ...(value as Record<string, unknown>) } as T
  return value
}

/**
 * 由注册表派生一份全新的默认设置对象。
 * 主进程与渲染层都用它，保证两边默认值永远一致。
 */
export function defaultSettings(): LauncherSettings {
  const out: Record<string, unknown> = {}
  for (const [key, def] of Object.entries(SETTINGS_DEFS) as Array<[string, SettingDef]>) {
    // 可选字段（如 javaPath）默认 undefined：不写入对象，保持与旧行为一致。
    if (def.default === undefined) continue
    out[key] = cloneDefault(def.default)
  }
  return out as unknown as LauncherSettings
}

/** 设置页自动渲染用的「板块字段」：键 + 定义。 */
export interface SectionField {
  key: keyof LauncherSettings
  def: SettingDef
}

/**
 * 取某板块下、带 UI 元数据的字段列表（顺序即注册表中的声明顺序）。
 * 设置页据此自动渲染配置项，新增带 `ui` 的设置会自动出现在对应板块。
 */
export function sectionFields(section: string): SectionField[] {
  const out: SectionField[] = []
  for (const [key, def] of Object.entries(SETTINGS_DEFS) as Array<[keyof LauncherSettings, SettingDef]>) {
    if (def?.ui && def.ui.section === section) out.push({ key, def })
  }
  return out
}

/**
 * 实例级 Java 覆盖路径。
 *
 * 返回 `undefined` 表示「跟随全局设置」：没有条目、空串、纯空白都算未指定。
 * 路径本身是否还能用（文件存在、能跑 `-version`）由主进程在启动 / 检查时再验证，
 * 这里只做取值归一，方便主进程与渲染层共用同一套判定。
 */
export function instanceJavaPath(
  s: Pick<LauncherSettings, 'versionJava'>,
  versionId: string | undefined
): string | undefined {
  if (!versionId) return undefined
  const path = s.versionJava?.[versionId]
  return typeof path === 'string' && path.trim() ? path.trim() : undefined
}

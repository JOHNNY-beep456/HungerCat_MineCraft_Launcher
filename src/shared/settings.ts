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
 */
export type SettingDisableWhen = 'local' | 'autoThemeFromWallpaper' | 'autoTranslateOff'

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
  /* ============ 运行模式（板块 id：mode） ============ */
  mode: { default: 'normal', ui: { section: 'mode', control: 'custom' } },
  showServerStatus: {
    default: true,
    ui: {
      section: 'mode',
      control: 'switch',
      labelKey: 'settings.row.showServerStatus',
      hintKey: 'settings.showServerStatus.desc'
    }
  },

  /* ============ 外观（板块 id：appearance） ============ */
  language: { default: 'zh-CN', ui: { section: 'appearance', control: 'custom' } },
  theme: {
    default: 'system',
    ui: {
      section: 'appearance',
      control: 'segmented',
      labelKey: 'settings.row.theme',
      disableWhen: ['autoThemeFromWallpaper'],
      options: [
        { value: 'light', labelKey: 'settings.theme.light' },
        { value: 'dark', labelKey: 'settings.theme.dark' },
        { value: 'system', labelKey: 'settings.theme.system' }
      ]
    }
  },
  accentColor: { default: '#0a84ff', ui: { section: 'appearance', control: 'custom' } },
  background: { default: 'midnight', ui: { section: 'appearance', control: 'custom' } },
  backgroundImage: { default: '', ui: { section: 'appearance', control: 'custom' } },
  reducedMotion: { default: false, ui: { section: 'appearance', control: 'custom' } },
  autoTranslateResources: {
    default: false,
    ui: {
      section: 'appearance',
      control: 'switch',
      labelKey: 'settings.row.autoTranslate',
      disableWhen: ['local'],
      hintKey: 'settings.exp.autoTranslate.desc'
    }
  },
  translateResourceNames: {
    default: true,
    ui: {
      section: 'appearance',
      control: 'switch',
      labelKey: 'settings.row.translateResourceNames',
      disableWhen: ['local', 'autoTranslateOff']
    }
  },

  /* ============ 实验性功能（板块 id：experimental） ============ */
  experimental: { default: 'off', ui: { section: 'experimental', control: 'custom' } },
  autoThemeFromWallpaper: {
    default: false,
    ui: {
      section: 'experimental',
      control: 'switch',
      labelKey: 'settings.row.autoThemeWallpaper',
      hintKey: 'settings.exp.autoTheme.desc'
    }
  },
  topNav: {
    default: false,
    ui: {
      section: 'experimental',
      control: 'switch',
      labelKey: 'settings.row.topNav',
      hintKey: 'settings.exp.topNav.desc'
    }
  },
  enableMultiplayer: { default: false, ui: { section: 'experimental', control: 'custom' } },

  /* ============ 游戏（板块 id：game） ============ */
  gameDir: { default: '', ui: { section: 'game', control: 'custom' } },
  versionIsolation: {
    default: false,
    ui: { section: 'game', control: 'switch', labelKey: 'settings.row.versionIsolation' }
  },
  gameWindowSize: { default: '720p', ui: { section: 'game', control: 'custom' } },
  /** 自定义窗口尺寸：随 gameWindowSize 的自定义行一起渲染，故无独立 ui。 */
  gameWindowWidth: { default: 1280 },
  gameWindowHeight: { default: 720 },
  closeOnLaunch: {
    default: false,
    ui: { section: 'game', control: 'switch', labelKey: 'settings.row.closeOnLaunch' }
  },
  debugMode: { default: false, ui: { section: 'game', control: 'custom' } },
  debugKey: { default: '', ui: { section: 'game', control: 'custom' } },
  metadataOnlyMods: { default: false, ui: { section: 'game', control: 'custom' } },

  /* ============ Java（板块 id：java） ============ */
  javaAutoDetect: { default: true, ui: { section: 'java', control: 'custom' } },
  javaPath: { default: undefined, ui: { section: 'java', control: 'custom' } },

  /* ============ 下载（板块 id：download） ============ */
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

  /* ============ 社区资源（板块 id：community） ============ */
  communitySource: {
    default: 'auto',
    ui: {
      section: 'community',
      control: 'select',
      labelKey: 'settings.row.communitySource',
      disabled: true,
      hintKey: 'settings.hint.communitySource',
      options: [
        { value: 'mirror-first', labelKey: 'settings.source.mirrorFirstList' },
        { value: 'auto', labelKey: 'settings.communitySource.auto' },
        { value: 'official-first', labelKey: 'settings.source.officialFirst' }
      ]
    }
  },
  modTitleStyle: {
    default: 'translated-first',
    ui: {
      section: 'community',
      control: 'select',
      labelKey: 'settings.row.modTitleStyle',
      disabled: true,
      hintKey: 'settings.hint.modTitleStyle',
      options: [
        { value: 'translated-first', labelKey: 'settings.modTitle.translatedFirst' },
        { value: 'filename-first', labelKey: 'settings.modTitle.filenameFirst' }
      ]
    }
  },

  /* ============ 公告（板块 id：notice） ============ */
  announcementDisplay: {
    default: 'all',
    ui: {
      section: 'notice',
      control: 'select',
      labelKey: 'settings.row.announcementDisplay',
      options: [
        { value: 'all', labelKey: 'settings.announcement.all' },
        { value: 'important-only', labelKey: 'settings.announcement.importantOnly' }
      ]
    }
  },

  /* ============ 更新（板块 id：update） ============ */
  autoCheckLauncherUpdate: {
    default: true,
    ui: {
      section: 'update',
      control: 'switch',
      labelKey: 'settings.row.autoCheckLauncher',
      hintKey: 'settings.update.autoLauncher.desc'
    }
  },
  autoCheckHomepageUpdate: {
    default: true,
    ui: {
      section: 'update',
      control: 'switch',
      labelKey: 'settings.row.autoCheckHomepage',
      hintKey: 'settings.update.autoHomepage.desc'
    }
  },

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
  hardwareLowEnd: { default: false },
  /** 派生字段：真实 KEY 由主进程安全存储持有，这里只反映「有没有」。 */
  uapisApiKeySet: { default: false },

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
  multiplayerMicHotkey: { default: 'Ctrl+M' },
  multiplayerGlobalMuteHotkey: { default: 'Ctrl+T' },
  multiplayerPushToTalkHotkey: { default: 'F2' },
  multiplayerSummonHotkey: { default: 'Ctrl+Alt+M' },
  multiplayerDanmakuEnabled: { default: true },
  multiplayerDanmakuFontSize: { default: 16 },
  multiplayerDanmakuSpeed: { default: 8 },
  multiplayerDanmakuOpacity: { default: 0.85 },
  multiplayerDanmakuTracks: { default: 4 },
  multiplayerHudEnabled: { default: false },
  multiplayerHudOpacity: { default: 0.8 },
  multiplayerVoiceChanger: { default: 'off' },
  multiplayerMicDeviceId: { default: '' },
  multiplayerSpeakerDeviceId: { default: '' },
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

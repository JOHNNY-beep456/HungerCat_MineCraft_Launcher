import { app } from 'electron'
import { createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { cpus, totalmem } from 'os'
import { join } from 'path'
import type { LauncherSettings, MinecraftAccount, SystemHardwareInfo, VersionDir } from '@shared/types'
import { hasUapisKey, setUapisKey } from './secret'

/** Offline-mode UUID, derived deterministically from the player name (MD5). */
function offlineUuid(name: string): string {
  const md5 = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest()
  md5[6] = (md5[6] & 0x0f) | 0x30
  md5[8] = (md5[8] & 0x3f) | 0x80
  return md5.toString('hex')
}

/** 9 个默认角色皮肤（textures.minecraft.net 的 SHA-1 纹理哈希，提取自 1.20.1 客户端 jar）。 */
const DEFAULT_SKINS: Array<{ name: string; hash: string; model: 'classic' | 'slim' }> = [
  { name: 'Steve', hash: '46b9aa7b7965f9397e49fb5a0051711b6b8c1a08', model: 'classic' },
  { name: 'Alex', hash: '2e191c48e7c0fe120a3adb2425773688d15021fe', model: 'slim' },
  { name: 'Ari', hash: '745417f10866ee5130469efb9edcddf27f1ce5b3', model: 'slim' },
  { name: 'Efe', hash: 'dfc845526527f29cfc46279d033bd05a86ed085c', model: 'slim' },
  { name: 'Kai', hash: '706559d6bdf11a18621d830efa7c4c6a12b1a2b4', model: 'slim' },
  { name: 'Makena', hash: '74ce72ce43faa29eef0a12e66b0000de6a912eaf', model: 'slim' },
  { name: 'Noor', hash: '4d3fbd9d52341356ab76c15e973e61562afe8344', model: 'slim' },
  { name: 'Sunny', hash: '64ae4556d10665de238c7106912d45e70cdc27de', model: 'slim' },
  { name: 'Zuri', hash: '1277a561362c72b2aa906f67713178da04a805fb', model: 'slim' }
]

export function createOfflineAccount(name: string): MinecraftAccount {
  const trimmed = name.trim().slice(0, 16) || 'Steve'
  const skin = DEFAULT_SKINS[Math.floor(Math.random() * DEFAULT_SKINS.length)]
  return {
    id: offlineUuid(trimmed),
    name: trimmed,
    accessToken: '0',
    refreshToken: '',
    expiresAt: Number.MAX_SAFE_INTEGER,
    skinUrl: `https://textures.minecraft.net/texture/${skin.hash}`,
    skinModel: skin.model,
    addedAt: Date.now(),
    offline: true
  }
}

function dataDir(): string {
  return app.getPath('userData')
}

function readJson<T>(file: string, fallback: T): T {
  try {
    const p = join(dataDir(), file)
    if (!existsSync(p)) return fallback
    return JSON.parse(readFileSync(p, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, data: unknown): void {
  const dir = dataDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), JSON.stringify(data, null, 2), 'utf-8')
}

/**
 * 探测本机硬件配置，并判定是否为「低配电脑」（2010 年代老机器）。
 * 判定阈值：逻辑核心数 ≤ 2，或物理内存 < 4GB。
 * 用于首次启动自动开启「超低占用模式」并提醒用户。
 */
export function detectHardware(): SystemHardwareInfo {
  const cpuCores = cpus()?.length ?? 0
  const totalMemMb = Math.round(totalmem() / 1024 / 1024)
  const lowEnd = cpuCores <= 2 || totalMemMb < 4096
  return { cpuCores, totalMemMb, lowEnd }
}

export function getDefaultSettings(): LauncherSettings {
  return {
    theme: 'system',
    language: 'zh-CN',
    memoryMb: 4096,
    maxDownloadConcurrency: 8,
    mirror: 'mojang',
    gameDir: join(app.getPath('documents'), 'HungerCatMC'),
    versionDirs: [],
    selectedVersionDirId: '',
    javaAutoDetect: true,
    closeOnLaunch: false,
    reducedMotion: false,
    lowUsageMode: false,
    hardwareChecked: false,
    versionIsolation: false,
    accentColor: '#0a84ff',
    background: 'midnight',
    backgroundImage: '',
    autoThemeFromWallpaper: false,
    gameWindowSize: '720p',
    gameWindowWidth: 1280,
    gameWindowHeight: 720,
    mode: 'normal',
    disabledVersions: [],
    isolatedVersions: [],
    agreementAcceptedAt: 0,
    onboardingDone: false,
    debugMode: false,
    metadataOnlyMods: false,
    homepageId: '',
    selectedVersionId: '',
    experimental: 'off',
    devModeGrantedUntil: 0,
    devModeToken: '',
    devModeEmailMasked: '',
    devModeEnabled: false,
    devModeSecurityMode: 'full',
    autoCheckLauncherUpdate: true,
    autoCheckHomepageUpdate: true,
    autoTranslateResources: false,
    translateResourceNames: true,
    uapisApiKeySet: false
  }
}

export const settings = {
  get(): LauncherSettings {
    const raw = readJson<Partial<LauncherSettings> & { uapisApiKey?: unknown }>('settings.json', {})
    // 迁移：早期版本把 uapis.cn 的 API KEY 明文写在 settings.json 里。这里把它搬进
    // 系统安全存储并抹掉明文（若系统不支持安全存储，宁可丢弃也不保留明文），
    // 之后 KEY 不再落明文、也不随设置下发到渲染层。
    if (typeof raw.uapisApiKey === 'string') {
      const legacy = raw.uapisApiKey.trim()
      delete raw.uapisApiKey
      if (legacy) setUapisKey(legacy)
      writeJson('settings.json', raw)
    }
    const s = { ...getDefaultSettings(), ...raw }
    // 派生状态：KEY 是否已保存以主进程的加密存储为准（该字段本身不持久化）。
    s.uapisApiKeySet = hasUapisKey()
    // 旧版本有独立的「原毛玻璃」实验项（'glass'），现已取消并成为默认观感，
    // 读到旧值时归一为 'off'，避免落到一个已不存在的皮肤上。
    if ((s.experimental as string) === 'glass') s.experimental = 'off'
    // 版本目录兜底：清洗无效项，并确保选中项有效（失效则回退默认目录）。
    const dirs = Array.isArray(s.versionDirs)
      ? s.versionDirs.filter(
          (d) => d && typeof d.id === 'string' && d.id !== 'default' && typeof d.path === 'string' && d.path
        )
      : []
    s.versionDirs = dirs.map((d) => ({ id: d.id, alias: typeof d.alias === 'string' ? d.alias : '', path: d.path }))
    if (s.selectedVersionDirId && !dirs.some((d) => d.id === s.selectedVersionDirId)) {
      s.selectedVersionDirId = ''
    }
    return s
  },
  set(partial: Partial<LauncherSettings>): LauncherSettings {
    const next = { ...this.get(), ...partial }
    // 派生字段不落盘：免得 settings.json 里的值与真实存储不一致。
    delete (next as Partial<LauncherSettings>).uapisApiKeySet
    writeJson('settings.json', next)
    return { ...next, uapisApiKeySet: hasUapisKey() }
  }
}

/** 汇总全部版本目录：默认目录（gameDir）恒在首位。 */
export function allVersionDirs(s: LauncherSettings): VersionDir[] {
  return [
    { id: 'default', alias: '', path: s.gameDir, isDefault: true },
    ...(s.versionDirs ?? []).map((d) => ({ id: d.id, alias: d.alias ?? '', path: d.path }))
  ]
}

/** 当前生效的版本目录（选中项失效时回退默认目录）。 */
export function activeVersionDir(s: LauncherSettings): VersionDir {
  const dirs = allVersionDirs(s)
  return dirs.find((d) => d.id === s.selectedVersionDirId) ?? dirs[0]
}

/** 当前生效的版本列表根目录路径（实例相关 IPC 都以此为准）。 */
export function activeGameDir(s: LauncherSettings): string {
  return activeVersionDir(s).path
}

interface AccountsFile {
  selectedId: string | null
  accounts: MinecraftAccount[]
}

const emptyAccounts: AccountsFile = { selectedId: null, accounts: [] }

export const accounts = {
  all(): AccountsFile {
    return readJson<AccountsFile>('accounts.json', emptyAccounts)
  },
  list(): MinecraftAccount[] {
    return this.all().accounts
  },
  selected(): MinecraftAccount | null {
    const f = this.all()
    return f.accounts.find((a) => a.id === f.selectedId) ?? f.accounts[0] ?? null
  },
  upsert(account: MinecraftAccount): MinecraftAccount[] {
    const f = this.all()
    const idx = f.accounts.findIndex((a) => a.id === account.id)
    if (idx >= 0) f.accounts[idx] = account
    else f.accounts.push(account)
    if (!f.selectedId) f.selectedId = account.id
    writeJson('accounts.json', f)
    return f.accounts
  },
  remove(id: string): MinecraftAccount[] {
    const f = this.all()
    f.accounts = f.accounts.filter((a) => a.id !== id)
    if (f.selectedId === id) f.selectedId = f.accounts[0]?.id ?? null
    writeJson('accounts.json', f)
    return f.accounts
  },
  select(id: string): MinecraftAccount | null {
    const f = this.all()
    if (!f.accounts.some((a) => a.id === id)) return null
    f.selectedId = id
    writeJson('accounts.json', f)
    return f.accounts.find((a) => a.id === id) ?? null
  }
}

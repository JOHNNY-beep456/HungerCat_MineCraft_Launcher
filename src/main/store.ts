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
 * 异步原子写：先写临时文件再 rename 覆盖，避免写一半崩溃导致文件损坏。
 *
 * 为什么需要它：`settings.set`（以及账号增删改）原先用 `writeFileSync` 同步整文件写盘，
 * 会把主进程事件循环卡住几百微秒到数毫秒。而「切换版本 / 切换版本目录」这类操作每次都要
 * 写一次设置，高频点选时就会累积成肉眼可见的卡顿 / 未响应。
 *
 * 改成异步后：内存缓存立即更新并返回（渲染层马上拿到新值），落盘在后台完成。
 * 同一文件的多次写入排队串行执行（`writeChain`），保证「后写的覆盖先写的」，不会乱序。
 */
const writeChain = new Map<string, Promise<void>>()

function writeJsonAsync(file: string, data: unknown): void {
  const dir = dataDir()
  const target = join(dir, file)
  const tmp = `${target}.tmp`
  const payload = JSON.stringify(data, null, 2)
  const prev = writeChain.get(file) ?? Promise.resolve()
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      const { promises: fsp } = await import('fs')
      await fsp.mkdir(dir, { recursive: true })
      await fsp.writeFile(tmp, payload, 'utf-8')
      await fsp.rename(tmp, target)
    })
    .catch((err) => {
      console.error(`[设置] 异步写盘失败：${file}`, err)
    })
  writeChain.set(file, next)
}

/** 等待所有在途异步写盘完成（退出前调用，避免丢掉最后一次设置写入）。 */
export async function flushWrites(): Promise<void> {
  await Promise.all([...writeChain.values()]).catch(() => undefined)
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

/**
 * 设置的内存缓存。
 *
 * settings.get() 原先每次都要「同步 stat + readFileSync + JSON.parse」，而它在主进程里被调用
 * 一百多次（几乎每个 IPC 处理器开头都要取一次，activeGameDir / windowBackgroundColor 等又会
 * 反复调）——每一次调用都是一次阻塞事件循环的同步读盘，累积起来就是「切换页面 / 切换版本目录
 * 时卡顿、未响应」的主要来源之一。
 *
 * 生命周期：只有本进程会写 settings.json（且在 set() 里同步更新缓存），因此缓存是可靠的。
 * 唯一的例外是「不落在 settings.json 里的派生字段」（如 uapisApiKeySet 由系统安全存储决定），
 * 密钥变化后由调用方调 invalidateSettingsCache() 失效，见 index.ts 的 translate:setKey / clearKey。
 */
let cachedSettings: LauncherSettings | null = null

/** 让设置缓存失效（派生字段变化后调用；下次 get() 会重新读盘并归一化）。 */
export function invalidateSettingsCache(): void {
  cachedSettings = null
}

export const settings = {
  get(): LauncherSettings {
    if (cachedSettings) return cachedSettings
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
    // 下载源强制官方（Mojang）：镜像选择已置灰停用，这里把历史遗留的 'bmclapi'
    // 一律归一为 'mojang'，避免旧配置继续走镜像源。
    s.mirror = 'mojang'
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
    cachedSettings = s
    return s
  },
  set(partial: Partial<LauncherSettings>): LauncherSettings {
    const next = { ...this.get(), ...partial }
    // 派生字段不落盘：免得 settings.json 里的值与真实存储不一致。
    delete (next as Partial<LauncherSettings>).uapisApiKeySet
    // 下载源强制官方：镜像选择已置灰停用，任何写入都改不回镜像源。
    next.mirror = 'mojang'
    // 内存缓存先行：渲染层立刻拿到新值（乐观更新），落盘在后台异步完成，
    // 不再让「切换版本 / 切换版本目录」此类高频写入同步阻塞主进程事件循环。
    cachedSettings = { ...next, uapisApiKeySet: hasUapisKey() }
    writeJsonAsync('settings.json', next)
    return cachedSettings
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
    writeJsonAsync('accounts.json', f)
    return f.accounts
  },
  remove(id: string): MinecraftAccount[] {
    const f = this.all()
    f.accounts = f.accounts.filter((a) => a.id !== id)
    if (f.selectedId === id) f.selectedId = f.accounts[0]?.id ?? null
    writeJsonAsync('accounts.json', f)
    return f.accounts
  },
  select(id: string): MinecraftAccount | null {
    const f = this.all()
    if (!f.accounts.some((a) => a.id === id)) return null
    f.selectedId = id
    writeJsonAsync('accounts.json', f)
    return f.accounts.find((a) => a.id === id) ?? null
  }
}

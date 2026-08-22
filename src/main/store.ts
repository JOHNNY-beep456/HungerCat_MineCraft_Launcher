import { app } from 'electron'
import { createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { LauncherSettings, MinecraftAccount } from '@shared/types'

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

export function getDefaultSettings(): LauncherSettings {
  return {
    theme: 'system',
    memoryMb: 4096,
    maxDownloadConcurrency: 8,
    mirror: 'mojang',
    gameDir: join(app.getPath('documents'), 'HungerCatMC'),
    javaAutoDetect: true,
    closeOnLaunch: false,
    reducedMotion: false,
    versionIsolation: false,
    accentColor: '#0a84ff',
    background: 'default',
    mode: 'normal',
    disabledVersions: [],
    isolatedVersions: [],
    agreementAcceptedAt: 0,
    debugMode: false,
    metadataOnlyMods: false
  }
}

export const settings = {
  get(): LauncherSettings {
    return { ...getDefaultSettings(), ...readJson<Partial<LauncherSettings>>('settings.json', {}) }
  },
  set(partial: Partial<LauncherSettings>): LauncherSettings {
    const next = { ...this.get(), ...partial }
    writeJson('settings.json', next)
    return next
  }
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

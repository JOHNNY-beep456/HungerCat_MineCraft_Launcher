import { app } from 'electron'
import { createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { cpus, totalmem } from 'os'
import { join } from 'path'
import type { LauncherSettings, MinecraftAccount, SystemHardwareInfo, VersionDir } from '@shared/types'
import { defaultSettings } from '@shared/settings'
import { hasUapisKey, setUapisKey } from './secret'
import { setSourceStrategies } from './mirror'

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
 * 虚拟机 / 云主机特征：CPU 型号里常出现这些厂商或产品名。
 * 命中即视为虚拟化环境（常见于云主机、沙盒，硬件能力不可靠）。
 */
const VM_MARKERS = [
  'virtual',
  'qemu',
  'vmware',
  'virtualbox',
  'vbox',
  'kvm',
  'hyper-v',
  'hyperv',
  'microsoft hv',
  'xen',
  'bochs',
  'parallels',
  'bhyve',
  'openstack',
  'amazon ec2',
  'google compute',
  'droplet'
]

/**
 * Intel 桌面 / 移动 CPU 世代 → 首发年份（粗略）。取该世代的主力上市年份即可：
 * 我们的判定只关心「是否 ≤ 2020」，同一世代跨 1~2 年对结论影响很小。
 */
function intelCoreYear(model: string): number {
  const m = model.toLowerCase()
  // Core 代数：i3/i5/i7/i9-<gen><digits>。末两位以上数字的前段即世代号（如 i7-10700 → 10）。
  const core = m.match(/i[3579][-_ ]?(\d{4,5})/)
  if (core) {
    const digits = core[1]
    const gen = digits.length >= 5 ? Number(digits.slice(0, 2)) : Number(digits[0])
    const genYear: Record<number, number> = {
      1: 2008,
      2: 2011,
      3: 2012,
      4: 2013,
      5: 2014,
      6: 2015,
      7: 2016,
      8: 2017,
      9: 2018,
      10: 2020,
      11: 2021,
      12: 2021,
      13: 2022,
      14: 2023
    }
    if (genYear[gen]) return genYear[gen]
  }
  return 0
}

/** AMD Ryzen → 首发年份；更老的 AMD（FX / A 系列 / Phenom 等）一律算 2010 年代。 */
function amdYear(model: string): number {
  const m = model.toLowerCase()
  const ryzen = m.match(/ryzen\s*(?:[3579]\s*)?(\d)(\d{3})/)
  if (ryzen) {
    const series = Number(ryzen[1])
    const seriesYear: Record<number, number> = { 1: 2017, 2: 2018, 3: 2019, 4: 2020, 5: 2020, 6: 2021, 7: 2022, 8: 2024, 9: 2024 }
    if (seriesYear[series]) return seriesYear[series]
  }
  if (/fx|phenom|athlon|a\d{1,2}-\d|sempron|opteron/.test(m)) return 2014
  return 0
}

/**
 * 从 CPU 型号字符串估算发布年份（0 = 无法识别）。
 * 覆盖 Intel Core / Xeon、AMD Ryzen 等常见台式与笔记本型号；识别不出返回 0，
 * 由调用方按「未知即不因 CPU 判低配」处理，避免误伤新机型。
 */
function estimateCpuYear(model: string): number {
  if (!model) return 0
  const m = model.toLowerCase()
  const intel = intelCoreYear(m)
  if (intel) return intel
  const amd = amdYear(m)
  if (amd) return amd
  // 老 Xeon（E5-26xx v3 等）按世代粗估：整体落后于消费级，给一个偏早的年份。
  if (/xeon/.test(m)) {
    const v = m.match(/v(\d)\b/)
    if (v) return 2013 + Math.max(0, Number(v[1]) - 3)
    return 2013
  }
  return 0
}

/**
 * 探测本机硬件配置，并判定是否为「低配电脑」。
 * 判定规则（满足其一即为低配，用于自动开启「超低占用模式」）：
 *   1. CPU 为 2000~2020 年的产物（按型号估算年份 ≤ 2020）；
 *   2. 运行在虚拟机 / 云主机中（性能不可靠）；
 *   3. 物理内存 < 16GB。
 * 型号无法识别时不因 CPU 判低配，避免误伤较新的机器。
 */
export function detectHardware(): SystemHardwareInfo {
  const info = cpus()?.[0]
  const cpuCores = cpus()?.length ?? 0
  const cpuModel = (info?.model ?? '').trim()
  const totalMemMb = Math.round(totalmem() / 1024 / 1024)
  const lower = cpuModel.toLowerCase()
  const isVirtualMachine = VM_MARKERS.some((k) => lower.includes(k))
  const cpuYear = estimateCpuYear(cpuModel)
  const lowEnd = isVirtualMachine || (cpuYear > 0 && cpuYear <= 2020) || totalMemMb < 16384
  return { cpuCores, cpuModel, cpuYear, isVirtualMachine, totalMemMb, lowEnd }
}

export function getDefaultSettings(): LauncherSettings {
  // 默认值来自共享注册表（@shared/settings），与渲染层兜底对象同源。
  // 这里只覆盖「依赖运行时」的一项：默认版本目录取系统「文档」目录下的固定子目录。
  return {
    ...defaultSettings(),
    gameDir: join(app.getPath('documents'), 'HungerCatMC')
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
    // 把来源策略同步给下载层：mirror.ts 是「当前策略」的唯一持有者，
    // 下载/版本列表都从这里取候选顺序，避免每处调用都去读设置（也便于测试）。
    setSourceStrategies({
      download: s.downloadSource,
      versionList: s.versionListSource,
      community: s.communitySource
    })
    cachedSettings = s
    return s
  },
  set(partial: Partial<LauncherSettings>): LauncherSettings {
    const next = { ...this.get(), ...partial }
    // 派生字段不落盘：免得 settings.json 里的值与真实存储不一致。
    delete (next as Partial<LauncherSettings>).uapisApiKeySet
    // 内存缓存先行：渲染层立刻拿到新值（乐观更新），落盘在后台异步完成，
    // 不再让「切换版本 / 切换版本目录」此类高频写入同步阻塞主进程事件循环。
    cachedSettings = { ...next, uapisApiKeySet: hasUapisKey() }
    setSourceStrategies({
      download: next.downloadSource,
      versionList: next.versionListSource,
      community: next.communitySource
    })
    writeJsonAsync('settings.json', next)
    return cachedSettings
  }
}

/** 汇总全部版本目录：默认目录（gameDir）恒在首位，别名固定为「默认」。 */
export function allVersionDirs(s: LauncherSettings): VersionDir[] {
  return [
    { id: 'default', alias: '默认', path: s.gameDir, isDefault: true },
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

/**
 * 账号内存缓存。
 *
 * 与 settings 同理：`accounts.json` 的写盘已改为异步（writeJsonAsync），若读接口仍每次去读盘，
 * 就会出现「刚删了账号、紧接着的 selected() 又读回删除前的旧文件」这种竞态 ——
 * 渲染层于是把已删除账号当成当前账号显示（左下角仍显示被删用户）。
 *
 * 因此这里同样以内存为唯一真源：所有读写都走缓存，写操作同步更新缓存、异步落盘。
 * 只有本进程会写 accounts.json，故缓存可靠。
 */
let cachedAccounts: AccountsFile | null = null

/** 让账号缓存失效（下次读取时重新读盘归一化）。 */
export function invalidateAccountsCache(): void {
  cachedAccounts = null
}

export const accounts = {
  all(): AccountsFile {
    if (cachedAccounts) return cachedAccounts
    const raw = readJson<Partial<AccountsFile>>('accounts.json', emptyAccounts)
    cachedAccounts = {
      selectedId: typeof raw.selectedId === 'string' ? raw.selectedId : null,
      accounts: Array.isArray(raw.accounts) ? raw.accounts : []
    }
    return cachedAccounts
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
  remove(id: string): { accounts: MinecraftAccount[]; selected: MinecraftAccount | null } {
    const f = this.all()
    f.accounts = f.accounts.filter((a) => a.id !== id)
    if (f.selectedId === id) f.selectedId = f.accounts[0]?.id ?? null
    writeJsonAsync('accounts.json', f)
    // 一并返回删除后的「选中账号」，渲染层无需再单独发一次 selected() ——
    // 那次单独读取既多一次 IPC，也正是此前读到旧盘数据的竞态来源。
    return { accounts: f.accounts, selected: this.selected() }
  },
  select(id: string): MinecraftAccount | null {
    const f = this.all()
    if (!f.accounts.some((a) => a.id === id)) return null
    f.selectedId = id
    writeJsonAsync('accounts.json', f)
    return f.accounts.find((a) => a.id === id) ?? null
  }
}

import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 敏感凭据的本地存储（目前只有 uapis.cn 的翻译 KEY）。
 *
 * 一律经 Electron safeStorage 加密后再落盘：Windows 走 DPAPI、macOS 走钥匙串，
 * 密文只能由「当前系统用户 + 当前机器」解开。由此保证：
 * 1) 磁盘上不存在明文——直接翻 settings.json 或本文件都拿不到 KEY；
 * 2) KEY 只留在主进程——它不在 LauncherSettings 里，因此不会随设置下发到渲染层，
 *    界面也无从回显。
 *
 * 若系统不支持安全存储（部分 Linux 缺少密钥环），保存会被拒绝而不是退回明文。
 *
 * 注意：CurseForge 的 KEY 不在这里——它由 curseforge-key.ts 作为内置默认值随程序分发，
 * 无需用户配置，也不存在本机保存这一说。
 */
const FILES = {
  uapis: 'uapis-key.bin'
} as const

type SecretName = keyof typeof FILES

/** 内存缓存：读一次就常驻，避免每次调用都解密。 */
const cache = new Map<SecretName, string>()
const loaded = new Set<SecretName>()

function keyPath(name: SecretName): string {
  return join(app.getPath('userData'), FILES[name])
}

/** 当前系统是否支持安全存储（不支持时无法加密，也就无法保存 KEY）。 */
export function isSecretStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** 读取已保存的凭据（解密后缓存于内存）；未保存 / 解不开时返回空串。 */
function readSecret(name: SecretName): string {
  if (!loaded.has(name)) {
    loaded.add(name)
    try {
      const p = keyPath(name)
      if (existsSync(p) && isSecretStorageAvailable()) {
        cache.set(name, safeStorage.decryptString(readFileSync(p)))
      }
    } catch {
      // 换了系统用户 / 密钥环变更导致解不开：按「未设置」处理，不抛错以免影响启动。
      cache.set(name, '')
    }
  }
  return cache.get(name) ?? ''
}

/** 保存凭据（加密后落盘）：成功返回 null，失败返回可直接展示给用户的原因。 */
function writeSecret(name: SecretName, key: string, label: string): string | null {
  const value = key.trim()
  if (!value) return `未填写 ${label}`
  if (!isSecretStorageAvailable()) {
    return `当前系统不支持安全存储（缺少系统密钥环），为避免明文保存，已拒绝写入 ${label}`
  }
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(keyPath(name), safeStorage.encryptString(value))
    cache.set(name, value)
    loaded.add(name)
    return null
  } catch (err) {
    return `保存失败：${err instanceof Error ? err.message : String(err)}`
  }
}

/** 删除已保存的凭据（用户主动清除时调用）。 */
function dropSecret(name: SecretName): void {
  cache.set(name, '')
  loaded.add(name)
  try {
    rmSync(keyPath(name), { force: true })
  } catch {
    // 文件不存在 / 无权限：忽略——内存缓存已清空，等价于「未设置」。
  }
}

/* -------------------- uapis.cn（翻译） -------------------- */

export function getUapisKey(): string {
  return readSecret('uapis')
}

export function hasUapisKey(): boolean {
  return getUapisKey() !== ''
}

/** 保存 uapis KEY：成功返回 null，失败返回可展示原因。 */
export function setUapisKey(key: string): string | null {
  return writeSecret('uapis', key, 'API KEY')
}

/** 删除已保存的 uapis KEY。 */
export function clearUapisKey(): void {
  dropSecret('uapis')
}

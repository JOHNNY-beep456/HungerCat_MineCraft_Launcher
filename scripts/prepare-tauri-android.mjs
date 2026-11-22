// 仅恢复已审的 Android Node 启动器；不启动 CLI、Gradle、SDK 或任何外部进程。
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync,
  unlinkSync, writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'

export const CLI_VERSION = '2.12.4'
export const LAUNCHER_MARKER = 'HCMCL_ANDROID_NODE_LAUNCHER_V1'
export const MAINTAINED_TEMPLATE = 'scripts/tauri-android-BuildTask.kt'
export const GENERATED_TASK = 'src-tauri/gen/android/buildSrc/src/main/java/top/johnnyblog/hcmcl/kotlin/BuildTask.kt'

// V1 维护副本按 LF 摘要锁定；旧模板按审计时的 CRLF 摘要锁定。
// 只兼容 LF/CRLF，不放宽空白、路径、参数、标记或额外代码。
const MAINTAINED_SHA256_LF = '50e79f395d10b1a5c8b5a5d301650002ddd6ac033fd26604cb3afe1d979c9068'
const LEGACY_SHA256_CRLF = '3cb54727082c4047d07fa14a5a2c79cd4d3d9a3fbd17bd2cb1ff5b2e108f3f55'
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

function fail(code, message) {
  throw Object.assign(new Error(`[${code}] ${message}`), { code })
}

function readRegular(path, label, limit = 64 * 1024) {
  let stat
  let bytes
  try {
    stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) {
      fail('ANDROID_PREPARE_FILE', `${label}必须是限额内的普通文件：${path}`)
    }
    bytes = readFileSync(path)
  } catch (error) {
    if (error.code?.startsWith('ANDROID_PREPARE_')) throw error
    fail('ANDROID_PREPARE_FILE', `无法读取${label}：${path}`)
  }
  if (bytes.length > limit) fail('ANDROID_PREPARE_FILE', `${label}超过大小限制`)
  return { bytes, stat }
}

function textOf(bytes, label) {
  let text
  try { text = decoder.decode(bytes) }
  catch { fail('ANDROID_PREPARE_ENCODING', `${label}不是有效 UTF-8`) }
  if (text.startsWith('\uFEFF') || text.includes('\u0000') || /\r(?!\n)/u.test(text)) {
    fail('ANDROID_PREPARE_ENCODING', `${label}包含不支持的 BOM、空字符或换行`)
  }
  return text.replace(/\r\n/gu, '\n')
}

function sameIdentity(a, b) {
  return a.isFile() && !a.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
}

/** 项目根可由离线 fixture 指定；生产入口始终从本脚本位置解析，不依赖 cwd。 */
export function prepareTauriAndroid(projectRoot = PROJECT_ROOT) {
  const root = resolve(projectRoot)
  const cliRoot = join(root, 'node_modules', '@tauri-apps', 'cli')
  const cliPackage = readRegular(join(cliRoot, 'package.json'), '项目 Tauri CLI 包描述')
  let installed
  try { installed = JSON.parse(textOf(cliPackage.bytes, 'Tauri CLI 包描述')) }
  catch (error) {
    if (error.code?.startsWith('ANDROID_PREPARE_')) throw error
    fail('ANDROID_PREPARE_CLI_VERSION', '无法解析项目 Tauri CLI 包描述')
  }
  if (!installed || typeof installed !== 'object' || Array.isArray(installed) ||
      installed.name !== '@tauri-apps/cli' || installed.version !== CLI_VERSION) {
    fail('ANDROID_PREPARE_CLI_VERSION', `仅支持实际安装的 @tauri-apps/cli ${CLI_VERSION}；请审计新版本后再更新准备脚本`)
  }
  // 只读取包描述并确认入口存在；绝不 import/require 或执行安装包代码。
  readRegular(join(cliRoot, 'tauri.js'), '项目 Tauri CLI 入口', 1024 * 1024)

  const maintainedPath = join(root, MAINTAINED_TEMPLATE)
  const maintained = readRegular(maintainedPath, '项目维护的 BuildTask 副本')
  const maintainedText = textOf(maintained.bytes, '项目维护副本')
  if (sha256(maintainedText) !== MAINTAINED_SHA256_LF ||
      maintainedText.split(LAUNCHER_MARKER).length !== 2) {
    fail('ANDROID_PREPARE_MAINTAINED_TEMPLATE', '维护副本与已审 V1 不一致；拒绝用未知内容覆盖 Android 工程')
  }

  const targetPath = join(root, GENERATED_TASK)
  const target = readRegular(targetPath, '生成的 BuildTask')
  const currentText = textOf(target.bytes, '生成的 BuildTask')
  if (currentText === maintainedText) return { changed: false, targetPath, cliVersion: CLI_VERSION }
  if (sha256(currentText.replace(/\n/gu, '\r\n')) !== LEGACY_SHA256_CRLF) {
    fail('ANDROID_PREPARE_UNKNOWN_TEMPLATE', '生成的 BuildTask 既非已审旧模板，也非当前维护副本；请人工审计，不会进行宽泛替换')
  }

  // 同目录临时文件完整写入、同步后再替换；替换前再次检查目标与维护副本。
  const temporary = join(dirname(targetPath), `.hcmcl-android-launcher-${randomUUID()}.tmp`)
  let fd
  let ownsTemporary = false
  try {
    fd = openSync(temporary, 'wx', target.stat.mode & 0o777)
    ownsTemporary = true
    writeFileSync(fd, maintained.bytes)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    const freshTarget = readRegular(targetPath, '替换前的 BuildTask')
    const freshMaintained = readRegular(maintainedPath, '替换前的维护副本')
    if (!sameIdentity(freshTarget.stat, target.stat) || !freshTarget.bytes.equals(target.bytes) ||
        !freshMaintained.bytes.equals(maintained.bytes)) {
      fail('ANDROID_PREPARE_CHANGED', '校验期间文件发生变化，已停止替换；请重新准备')
    }
    renameSync(temporary, targetPath)
    ownsTemporary = false
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (ownsTemporary) unlinkSync(temporary)
  }
  const published = readRegular(targetPath, '替换后的 BuildTask')
  if (!published.bytes.equals(maintained.bytes)) {
    fail('ANDROID_PREPARE_VERIFY', '替换后读回与维护副本不一致；请检查并发修改，不能继续构建')
  }
  return { changed: true, targetPath, cliVersion: CLI_VERSION }
}

// 导入模块只暴露函数，不读取工程、不写文件，也不触发外部命令。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) fail('ANDROID_PREPARE_ARGUMENTS', '准备步骤不接受命令行参数')
    const result = prepareTauriAndroid()
    console.log(result.changed ? 'Android Node 启动器已恢复为已审维护副本。' : 'Android Node 启动器已是已审维护副本，无需修改。')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

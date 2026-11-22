// 离线合成 fixture：仅临时目录文件 I/O，不运行 Node 子进程、CLI、Gradle 或网络。
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, utimesSync, writeFileSync
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const maintained = readFileSync(new URL('./tauri-android-BuildTask.kt', import.meta.url))
const digest = (value) => createHash('sha256').update(value).digest('hex')

// 完整重建审计过的旧文件；不可通过删掉未知代码来制造“可接受模板”。
const legacyLF = String.raw`import java.io.File
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction
import javax.inject.Inject
import org.gradle.process.ExecOperations

abstract class BuildTask : DefaultTask() {
    @get:Inject
    abstract val execOperations: ExecOperations

    @Input
    var rootDirRel: String? = null
    @Input
    var projectDir: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    @TaskAction
    fun assemble() {
        val executable = """C:\Program Files\nodejs\node""";
        try {
            runTauriCli(executable)
        } catch (e: Exception) {
            if (Os.isFamily(Os.FAMILY_WINDOWS)) {
                // Try different Windows-specific extensions
                val fallbacks = listOf(
                    "$executable.exe",
                    "$executable.cmd",
                    "$executable.bat",
                )

                var lastException: Exception = e
                for (fallback in fallbacks) {
                    try {
                        runTauriCli(fallback)
                        return
                    } catch (fallbackException: Exception) {
                        lastException = fallbackException
                    }
                }
                throw lastException
            } else {
                throw e;
            }
        }
    }

    fun runTauriCli(executable: String) {
        val rootDirRel = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val target = target ?: throw GradleException("target cannot be null")
        val release = release ?: throw GradleException("release cannot be null")
        val args = listOf("tauri", "android", "android-studio-script");

        execOperations.exec {
            workingDir(File(projectDir, rootDirRel))
            executable(executable)
            args(args)
            if (logger.isEnabled(LogLevel.DEBUG)) {
                args("-vv")
            } else if (logger.isEnabled(LogLevel.INFO)) {
                args("-v")
            }
            if (release) {
                args("--release")
            }
            args(listOf("--target", target))
        }.assertNormalExitValue()
    }
}
`
// 明确以审计文件摘要选择末尾换行，不依赖测试宿主的行尾习惯。
const legacy = [legacyLF, legacyLF.slice(0, -1)]
  .map((source) => Buffer.from(source.replace(/\n/gu, '\r\n')))
  .find((bytes) => digest(bytes) === '3cb54727082c4047d07fa14a5a2c79cd4d3d9a3fbd17bd2cb1ff5b2e108f3f55')

let passed = 0
let failed = 0
let processAttempts = 0
let networkAttempts = 0
const originalProcesses = new Map()
const originalFetch = globalThis.fetch
const temporaryRoot = mkdtempSync(join(tmpdir(), 'HCMCL Android launcher fixtures '))

async function test(label, run) {
  try { await run(); passed++; console.log(`  ok   ${label}`) }
  catch (error) { failed++; console.error(`  FAIL ${label}: ${error.stack ?? error.message}`) }
}

function projectFixture(target = legacy, options = {}) {
  const root = mkdtempSync(join(temporaryRoot, '项目 含空格 '))
  const paths = {
    root,
    target: join(root, 'src-tauri/gen/android/buildSrc/src/main/java/top/johnnyblog/hcmcl/kotlin/BuildTask.kt'),
    maintained: join(root, 'scripts/tauri-android-BuildTask.kt'),
    cliPackage: join(root, 'node_modules/@tauri-apps/cli/package.json'),
    cliScript: join(root, 'node_modules/@tauri-apps/cli/tauri.js'),
    settings: join(root, 'src-tauri/gen/android/tauri.settings.gradle'),
    userKotlin: join(root, 'src-tauri/gen/android/app/src/main/java/top/johnnyblog/hcmcl/Keep.kt')
  }
  for (const file of Object.values(paths).slice(1)) mkdirSync(dirname(file), { recursive: true })
  writeFileSync(paths.target, target ?? 'fixture 缺少旧模板')
  writeFileSync(paths.maintained, options.maintained ?? maintained)
  writeFileSync(paths.cliPackage, JSON.stringify({
    name: options.name ?? '@tauri-apps/cli', version: options.version ?? '2.12.4'
  }))
  // 若准备函数 import/require/执行入口，fixture 必须立刻失败。
  writeFileSync(paths.cliScript, 'throw new Error("fixture CLI 入口绝不能执行")\n')
  writeFileSync(paths.settings, 'fixture Cargo settings，禁止改动\n')
  writeFileSync(paths.userKotlin, 'fixture 用户 Kotlin，禁止改动\n')
  return paths
}

// 摘要整个合成工程，验证拒绝路径零写及成功路径只改一个目标。
function snapshot(root) {
  const entries = []
  function walk(directory, relative = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const key = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path, key)
      else {
        assert.ok(entry.isFile(), `fixture 不能包含特殊文件：${key}`)
        const stat = lstatSync(path)
        entries.push([key, digest(readFileSync(path)), stat.mode, stat.mtimeMs])
      }
    }
  }
  walk(root)
  return entries.sort(([left], [right]) => left.localeCompare(right))
}

try {
  // 导入准备模块前即安装拦截；被测代码即使后来增加进程调用也不能执行。
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    originalProcesses.set(name, childProcess[name])
    childProcess[name] = () => { processAttempts++; throw new Error(`fixture 禁止外部进程：${name}`) }
  }
  syncBuiltinESMExports()
  globalThis.fetch = () => { networkAttempts++; throw new Error('fixture 禁止网络') }
  const { prepareTauriAndroid } = await import('./prepare-tauri-android.mjs')

  await test('合成旧模板与已审原文件摘要完全一致', () => {
    assert.ok(legacy, '完整旧模板必须匹配审计摘要，不能跳过恢复分支')
    assert.equal(legacy.length, 2467)
    assert.equal(digest(maintained.toString('utf8').replace(/\r\n/gu, '\n')),
      '50e79f395d10b1a5c8b5a5d301650002ddd6ac033fd26604cb3afe1d979c9068')
  })

  await test('含空格及中文工程路径可恢复旧模板且不触碰其它文件', () => {
    assert.ok(legacy)
    const current = projectFixture()
    const before = snapshot(current.root)
    const result = prepareTauriAndroid(current.root)
    assert.equal(result.changed, true)
    assert.equal(result.cliVersion, '2.12.4')
    assert.equal(result.targetPath, current.target)
    assert.deepEqual(readFileSync(current.target), maintained)
    const changed = snapshot(current.root).filter((row) => row[0].endsWith('/BuildTask.kt'))
    assert.equal(changed.length, 1)
    assert.deepEqual(snapshot(current.root).filter((row) => row[0] !== changed[0][0]),
      before.filter((row) => row[0] !== changed[0][0]))
  })

  await test('已修文件重复准备幂等并保持修改时间', () => {
    const current = projectFixture(maintained)
    const fixedTime = new Date('2024-01-02T03:04:05Z')
    utimesSync(current.target, fixedTime, fixedTime)
    const before = snapshot(current.root)
    assert.equal(prepareTauriAndroid(current.root).changed, false)
    assert.equal(prepareTauriAndroid(current.root).changed, false)
    assert.deepEqual(snapshot(current.root), before)
  })

  await test('旧模板及已修模板均兼容 LF/CRLF 且保持内容严格一致', () => {
    assert.ok(legacy)
    const oldLF = projectFixture(legacy.toString('utf8').replace(/\r\n/gu, '\n'))
    assert.equal(prepareTauriAndroid(oldLF.root).changed, true)
    const maintainedCRLF = maintained.toString('utf8').replace(/\r\n/gu, '\n').replace(/\n/gu, '\r\n')
    const repairedCRLF = projectFixture(maintainedCRLF)
    const before = snapshot(repairedCRLF.root)
    assert.equal(prepareTauriAndroid(repairedCRLF.root).changed, false)
    assert.deepEqual(snapshot(repairedCRLF.root), before)
    const copiedCRLF = projectFixture(legacy, { maintained: maintainedCRLF })
    assert.equal(prepareTauriAndroid(copiedCRLF.root).changed, true)
    assert.equal(readFileSync(copiedCRLF.target, 'utf8'), maintainedCRLF)
  })

  await test('未知模板及仅伪造标记的模板拒绝并零写', () => {
    for (const source of ['未知模板\n', `${maintained.toString('utf8')}\n// 未审变更\n`,
      legacy.toString('utf8').replace('android-studio-script', '其它命令')]) {
      const current = projectFixture(source)
      const before = snapshot(current.root)
      assert.throws(() => prepareTauriAndroid(current.root), { code: 'ANDROID_PREPARE_UNKNOWN_TEMPLATE' })
      assert.deepEqual(snapshot(current.root), before)
    }
  })

  await test('实际 CLI 包名称或版本变化拒绝且不会覆盖旧模板', () => {
    for (const options of [{ version: '2.12.5' }, { version: '2.12.4-dev' }, { name: '其它包' }]) {
      const current = projectFixture(undefined, options)
      const before = snapshot(current.root)
      assert.throws(() => prepareTauriAndroid(current.root), { code: 'ANDROID_PREPARE_CLI_VERSION' })
      assert.deepEqual(snapshot(current.root), before)
    }
  })

  await test('带标记但未审的维护副本拒绝且零写', () => {
    const current = projectFixture(undefined, { maintained: `${maintained.toString('utf8')}\n// 未审维护变更\n` })
    const before = snapshot(current.root)
    assert.throws(() => prepareTauriAndroid(current.root), { code: 'ANDROID_PREPARE_MAINTAINED_TEMPLATE' })
    assert.deepEqual(snapshot(current.root), before)
  })

  await test('损坏的 CLI 包描述与缺失入口拒绝且不生成目标文件', () => {
    for (const source of ['{ broken json', 'null', '[]', '"2.12.4"']) {
      const malformed = projectFixture()
      writeFileSync(malformed.cliPackage, source)
      const malformedBefore = snapshot(malformed.root)
      assert.throws(() => prepareTauriAndroid(malformed.root), { code: 'ANDROID_PREPARE_CLI_VERSION' })
      assert.deepEqual(snapshot(malformed.root), malformedBefore)
    }
    const missing = projectFixture()
    rmSync(missing.cliScript)
    const missingBefore = snapshot(missing.root)
    assert.throws(() => prepareTauriAndroid(missing.root), { code: 'ANDROID_PREPARE_FILE' })
    assert.deepEqual(snapshot(missing.root), missingBefore)
  })

  await test('缺失生成工程明确拒绝，不创建 Kotlin 目录或猜测模板', () => {
    const current = projectFixture()
    rmSync(current.target)
    const before = snapshot(current.root)
    assert.throws(() => prepareTauriAndroid(current.root), { code: 'ANDROID_PREPARE_FILE' })
    assert.equal(existsSync(current.target), false)
    assert.deepEqual(snapshot(current.root), before)
  })

  await test('维护启动器保持绝对脚本参数及 Node 优先级并只调用一次 exec', () => {
    const source = maintained.toString('utf8').replace(/\r\n/gu, '\n')
    const ordered = [
      'gradleProperty("hcmcl.node")', 'environmentVariable("HCMCL_NODE")',
      'environmentVariable("NODE_BINARY")', '?: "node"'
    ].map((anchor) => source.indexOf(anchor))
    assert.ok(ordered.every((offset) => offset >= 0))
    assert.ok(ordered.every((offset, index) => index === 0 || offset > ordered[index - 1]))
    assert.ok(source.includes('File(root, "../node_modules/@tauri-apps/cli/tauri.js").canonicalFile'))
    assert.ok(source.includes('mutableListOf(cliScript.path, "android", "android-studio-script")'))
    assert.equal(source.match(/execOperations\.exec\s*\{/gu)?.length, 1)
    assert.ok(source.includes('executable(node)'))
    assert.ok(source.includes('args(cliArgs)'))
    assert.ok(source.includes('setIgnoreExitValue(false)'))
    assert.ok(!source.includes('catch ('))
  })

  await test('两个 npm Android 入口先准备且保留原命令及架构参数', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    assert.equal(pkg.scripts['android:dev'], 'node scripts/prepare-tauri-android.mjs && tauri android dev')
    assert.equal(pkg.scripts['android:build'], 'node scripts/prepare-tauri-android.mjs && tauri android build')
  })

  await test('导入及所有准备分支未尝试执行外部进程或网络', () => {
    assert.equal(processAttempts, 0)
    assert.equal(networkAttempts, 0)
  })
} finally {
  for (const [name, original] of originalProcesses) childProcess[name] = original
  syncBuiltinESMExports()
  if (originalFetch === undefined) delete globalThis.fetch
  else globalThis.fetch = originalFetch
  rmSync(temporaryRoot, { recursive: true, force: true })
}

console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exitCode = 1

// 编译 Android 引导类的 jar（hcmcl.Boot 与自有的事件桥），放进 APK 的 assets/runtime。
// 桌面打包不会读这个目录，产物只影响 APK。
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 引导类的源码属于「PE（Android）版」自有代码，已随该版本移到 HCMCL PE 目录。
const SOURCE = join(ROOT, 'HCMCL PE', 'android-boot')
const BUILD = join(ROOT, '.local', 'android-runtime', 'boot-build')
const TARGET_DIR = join(ROOT, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'assets', 'runtime')
const JAR = join(TARGET_DIR, 'boot.jar')

// javac 与 jar 必须来自同一个 JDK：只依赖 PATH 时，Windows 上常出现 javac 有、jar 没有的割裂。
function tool(name) {
  const candidates = []
  if (process.env.JAVA_HOME) candidates.push(join(process.env.JAVA_HOME, 'bin', name + '.exe'))
  for (const version of ['jdk-21', 'jdk-17', 'jdk-22', 'jdk-23']) {
    candidates.push(join('C:\\Program Files\\Java', version, 'bin', name + '.exe'))
  }
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return name
}

/** 递归收集源文件：引导 jar 里既有引导类也有替换用的 GLFW 事件桥。 */
function sources(dir) {
  const found = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) found.push(...sources(path))
    else if (name.endsWith('.java')) found.push(path)
  }
  return found
}

if (existsSync(BUILD)) rmSync(BUILD, { recursive: true, force: true })
mkdirSync(BUILD, { recursive: true })
mkdirSync(TARGET_DIR, { recursive: true })

const files = sources(SOURCE)
execFileSync(tool('javac'), ['--release', '17', '-encoding', 'UTF-8', '-d', BUILD, ...files], {
  stdio: 'inherit'
})
execFileSync(tool('jar'), ['--create', '--file', JAR, '-C', BUILD, '.'], { stdio: 'inherit' })

// 布局版本：Kotlin 侧据此判断已解压的运行时是否需要重建。
cpSync(join(SOURCE, 'VERSION'), join(TARGET_DIR, 'VERSION'))
console.log(`boot.jar -> ${JAR}（${files.length} 个源文件）`)

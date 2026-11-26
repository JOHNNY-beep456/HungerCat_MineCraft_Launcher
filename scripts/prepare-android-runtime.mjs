// 把 Android 专用的运行时装进 Android 工程。
// 只在构建 Android 时运行；桌面打包完全不读 jniLibs/assets，因此不影响其他平台体积。
// 源目录由 .local/android-runtime 提供（已 gitignore），仓库本身不保存这些二进制。
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, '.local', 'android-runtime')
const ANDROID = join(ROOT, 'src-tauri', 'gen', 'android', 'app', 'src', 'main')
const ABI_DIRS = { arm64: 'arm64-v8a', x86_64: 'x86_64', x86: 'x86' }
const JRE_DIRS = { arm64: 'jre-arm64', x86_64: 'jre-x86_64', x86: 'jre-x86' }

// 一次只灌一个 ABI：jniLibs 下有几个目录，Gradle 就会打进几个 ABI 的原生库。
// 出包脚本按「准备 → 构建 → 签名」逐 ABI 循环，产物因此是各自独立的单架构 APK。
const ONLY = process.argv[2]
if (ONLY && !ABI_DIRS[ONLY]) {
  throw new Error(`未知 ABI：${ONLY}（可选 ${Object.keys(ABI_DIRS).join(' / ')}）`)
}

// JVM 只需要这些库即可启动解释器与类库；AWT/JDWP/字体渲染在无头启动里用不到，
// 但保留 freetype 与 lcms 以便后续 Forge 安装器走图形路径。
const REQUIRED = [
  'libjava.so', 'libnio.so', 'libnet.so', 'libzip.so', 'libjimage.so', 'libverify.so',
  'libjli.so', 'libmanagement.so', 'libmanagement_ext.so', 'libextnet.so', 'libj2pkcs11.so',
  'libsyslookup.so', 'libinstrument.so', 'libprefs.so', 'librmi.so', 'libjaas.so',
  'libfreetype.so', 'liblcms.so', 'libfontmanager.so', 'libawt.so', 'libawt_headless.so',
  'libjavajpeg.so', 'libmlib_image.so', 'libjawt.so'
]

// LWJGL 的 Android 实现：GLFW 的全部 JNI 都在 libpojavexec 里（GLFW 类通过
// System.loadLibrary("pojavexec") 加载），gl4es 负责 GL -> GLES 转发，libopenal 提供音频。
// 这几个库只进 APK 的 lib/<abi>/，桌面版仍使用版本清单里的官方 LWJGL。
const LWJGL_LIBS = [
  'libpojavexec.so', 'liblinkerhook.so', 'liblwjgl.so', 'liblwjgl_opengl.so',
  'liblwjgl_stb.so', 'liblwjgl_tinyfd.so', 'libgl4es_114.so', 'libopenal.so'
]
const LWJGL_JAR = join('assets', 'components', 'lwjgl3', 'lwjgl-glfw-classes.jar')
const POJAV_APK = join(SOURCE, 'PojavLauncher.apk')

function ensure(path) {
  mkdirSync(path, { recursive: true })
}

/**
 * 清空一个即将重新生成的目录。
 *
 * 直接递归删除在部分环境下会被安全策略拦下（单目录上万个文件时尤其慢），
 * 因此优先把它整体移出工程目录到 `.local` 的回收区——那里不进任何打包产物。
 */
function resetDir(path) {
  if (!existsSync(path)) return
  const trash = join(SOURCE, 'trash', `${Date.now()}`)
  ensure(dirname(trash))
  try {
    renameSync(path, trash)
  } catch {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      /* 交给后续拷贝覆盖 */
    }
  }
}

/** 从 PojavLauncher.apk 解出指定成员；已存在则跳过。 */
function extractMember(member, marker) {
  if (existsSync(join(SOURCE, 'pojav', marker))) return
  if (!existsSync(POJAV_APK)) {
    throw new Error(
      `缺少 PojavLauncher.apk（${POJAV_APK}）：Android 图形层构件由它提供，请先下载到该路径`
    )
  }
  ensure(join(SOURCE, 'pojav'))
  const errors = []
  // Windows 上 unzip 不一定在 PATH；bsdtar 自带 zip 支持，作为兜底。
  for (const [cmd, args] of [
    ['unzip', ['-o', '-q', POJAV_APK, member, '-d', join(SOURCE, 'pojav')]],
    ['tar', ['-xf', POJAV_APK, '-C', join(SOURCE, 'pojav'), member.replace(/\/\*$/, '')]]
  ]) {
    try {
      execFileSync(cmd, args, { stdio: 'ignore' })
      if (existsSync(join(SOURCE, 'pojav', marker))) return
    } catch (error) {
      errors.push(`${cmd}: ${error.message.split('\n')[0]}`)
    }
  }
  throw new Error(`无法从 APK 解出 ${member}（${errors.join('; ')}）`)
}

function ensurePojav(abi) {
  const dir = ABI_DIRS[abi]
  extractMember(`lib/${dir}/*`, join('lib', dir, 'libpojavexec.so'))
  return join(SOURCE, 'pojav', 'lib', dir)
}

function copySos(abi, target) {
  const lib = join(SOURCE, JRE_DIRS[abi], 'lib')
  if (!existsSync(lib)) throw new Error(`缺少 ${abi} 的 JRE：${lib}`)
  ensure(target)
  let copied = 0
  for (const name of REQUIRED) {
    const from = join(lib, name)
    if (!existsSync(from)) continue
    cpSync(from, join(target, name))
    copied++
  }
  // libjvm 原本在 lib/server/ 下，APK 的 jniLibs 不允许子目录，因此提到根并改名。
  const jvm = join(lib, 'server', 'libjvm.so')
  if (!existsSync(jvm)) throw new Error(`缺少 ${abi} 的 libjvm.so`)
  cpSync(jvm, join(target, 'libjvm.so'))
  copied++
  return copied
}

function copyLwjgl(abi, target) {
  const from = ensurePojav(abi)
  let copied = 0
  for (const name of LWJGL_LIBS) {
    const path = join(from, name)
    if (!existsSync(path)) throw new Error(`Pojav APK 缺少 ${abi} 的 ${name}`)
    cpSync(path, join(target, name))
    copied++
  }
  return copied
}

function copyLwjglJar() {
  extractMember(LWJGL_JAR, LWJGL_JAR)
  const out = join(ANDROID, 'assets', 'runtime', 'lwjgl')
  ensure(out)
  cpSync(join(SOURCE, 'pojav', LWJGL_JAR), join(out, 'lwjgl-glfw-classes.jar'))
}

function copyRuntime(abi) {
  const src = join(SOURCE, JRE_DIRS[abi])
  const out = join(ANDROID, 'assets', 'runtime', 'jre')
  resetDir(out)
  ensure(out)
  // 平台无关部分：类库镜像、配置、发布信息。可执行文件本身不用，JVM 由 libhcmcl_tauri 进程内创建。
  // lib/security 必须带上：cacerts 决定 HTTPS 与正版登录的根证书，缺失会让网络栈整体不可用。
  for (const part of ['conf', 'lib/modules', 'lib/security', 'lib/jvm.cfg', 'lib/classlist', 'lib/tzdb.dat', 'release']) {
    const from = join(src, part)
    if (!existsSync(from)) continue
    const to = join(out, part)
    ensure(dirname(to))
    cpSync(from, to, { recursive: true })
  }
  return out
}

const report = []
// 先清掉其它 ABI 的目录，否则上一步留下的原生库会被一起打进这个 APK。
for (const [abi, dir] of Object.entries(ABI_DIRS)) {
  if (ONLY && abi !== ONLY) resetDir(join(ANDROID, 'jniLibs', dir))
}
for (const [abi, dir] of Object.entries(ABI_DIRS)) {
  if (ONLY && abi !== ONLY) continue
  const target = join(ANDROID, 'jniLibs', dir)
  ensure(target)
  const count = copySos(abi, target)
  const lwjgl = copyLwjgl(abi, target)
  const out = copyRuntime(abi)
  const size = readdirSync(target).reduce((sum, name) => sum + statSync(join(target, name)).size, 0)
  report.push({ abi, dir, sos: count, lwjgl, bytes: size, assets: out })
}
copyLwjglJar()

writeFileSync(join(SOURCE, 'install-report.json'), JSON.stringify(report, null, 2))
for (const item of report) {
  console.log(`${item.dir}: ${item.sos} 个 JRE 库 + ${item.lwjgl} 个图形库，${(item.bytes / 1048576).toFixed(1)} MiB`)
}

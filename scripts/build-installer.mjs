#!/usr/bin/env node
/**
 * 构建安装程序（`HCMCL-<版本> Setup.exe`）。
 *
 * 早前的做法是「先打包启动器免安装目录 → 整目录复制成 installer/payload → 再把
 * 安装器本身用 portable 目标封成单文件 exe」。安装器是另一个 Electron 应用，
 * 于是安装包里带着**两份** Electron 运行时（约 2 × 268 MB 未压缩）—— 这是体积
 * 最大的一项来源。
 *
 * 现在安装模式并进了启动器（`src/main/installer/`）：主进程检测到 electron-builder
 * 的 portable 目标注入的 `PORTABLE_EXECUTABLE_FILE` 就切到安装界面，
 * `Setup.exe` **就是启动器自身**，只有一份运行时。因此本脚本只剩一次打包。
 *
 * 产物与应急兜底：
 *   `HCMCL-<版本> Setup.exe`   portable（主产物）
 *   `HungerCat ... Setup.exe`  nsis（应急，不依赖安装模式代码路径）
 *
 * 前置：electron-vite 的产物需已生成（`npm run dist:installer` 会先跑）。
 *
 * `--legacy` 走已停用的旧方案（安装器套启动器、双运行时），仅供回滚兜底。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'release')
const installerDir = join(root, 'installer')
const payloadDir = join(installerDir, 'payload')
const builderCli = join(root, 'node_modules', 'electron-builder', 'cli.js')

/** 每类产物保留的最新 N 个（更早的历史安装包清掉，否则 release/ 会无限膨胀）。 */
const KEEP_PER_GROUP = 5

/** 运行 electron-builder（cwd 决定使用哪个工程的 package.json / 配置）。 */
function runBuilder(args, cwd) {
  console.log(`\n> electron-builder ${args.join(' ')}\n  (cwd=${cwd})`)
  execFileSync(process.execPath, [builderCli, ...args], { cwd, stdio: 'inherit' })
}

/** 目录总字节数（用于清理日志）。 */
function dirBytes(dir) {
  let bytes = 0
  try {
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else bytes += statSync(p).size
      }
    }
    walk(dir)
  } catch {
    /* 忽略 */
  }
  return bytes
}

/**
 * 清掉旧安装包，每类只保留最新的 KEEP_PER_GROUP 个。
 *
 * release/ 是 .gitignore 的构建产物目录，一个 70 MB 的安装包攒几十个就是好几 GB。
 * 只删 exe 及其同名 blockmap，不动 latest.yml / builder-*.yml。
 */
function pruneOldArtifacts() {
  if (!existsSync(outDir)) return
  const groups = [
    { name: 'portable', re: /^HCMCL-.*\.exe$/i },
    { name: 'nsis', re: /^HungerCat MineCraft Launcher Setup .*\.exe$/i },
    // 更早期的历史命名，一并纳入清理
    { name: 'legacy-nsis', re: /^Hunger Cat Launcher Setup .*\.exe$/i }
  ]
  for (const g of groups) {
    const hits = readdirSync(outDir)
      .filter((f) => g.re.test(f))
      .map((f) => ({ f, size: statSync(join(outDir, f)).size }))
      .sort((a, b) => b.f.localeCompare(a.f))
    const drop = hits.slice(KEEP_PER_GROUP)
    for (const { f } of drop) {
      rmSync(join(outDir, f), { force: true })
      rmSync(join(outDir, `${f}.blockmap`), { force: true })
    }
    if (drop.length > 0) {
      const freed = drop.reduce((s, x) => s + x.size, 0)
      console.log(`  清理 ${g.name} 旧安装包 ${drop.length} 个（保留最新 ${KEEP_PER_GROUP} 个），释放 ${(freed / 1048576).toFixed(0)} MB`)
    }
  }
}

/**
 * 清掉早前「安装器套启动器」方案留下的 installer/payload。
 * 新方案不再复制载荷，那里现在是纯粹的陈旧文件。
 */
function pruneStalePayload() {
  if (!existsSync(payloadDir)) return
  const bytes = dirBytes(payloadDir)
  rmSync(payloadDir, { recursive: true, force: true })
  console.log(`  清理陈旧 installer/payload（${(bytes / 1048576).toFixed(0)} MB）—— 新方案不再需要`)
}

/**
 * 清掉早前安装器的产物目录 `release/installer/`。
 * 新方案的产物与启动器同处 `release/`（沿用 electron-builder 的默认输出目录），
 * 那个子目录里只剩旧方案留下的安装包。
 */
function pruneLegacyInstallerOut() {
  const legacyOut = join(outDir, 'installer')
  if (!existsSync(legacyOut)) return
  const bytes = dirBytes(legacyOut)
  rmSync(legacyOut, { recursive: true, force: true })
  console.log(`  清理旧安装器产物目录 release/installer（${(bytes / 1048576).toFixed(0)} MB）—— 新产物在 release/ 根下`)
}

if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('[错误] 未找到 out/ 构建产物，请先执行 `npm run build`。')
  process.exit(1)
}
if (!existsSync(join(root, 'out', 'renderer', 'installer', 'index.html'))) {
  console.error('[错误] 未找到 out/renderer/installer/ —— 安装器界面资源缺失，请先执行 `npm run build`。')
  process.exit(1)
}
if (!existsSync(builderCli)) {
  console.error('[错误] 未找到 electron-builder，请先执行 `npm install`。')
  process.exit(1)
}

console.log('> 清理历史产物')
pruneOldArtifacts()
pruneStalePayload()
pruneLegacyInstallerOut()

/**
 * `--legacy`：走**已停用**的「安装器套启动器」旧方案，仅供回滚。
 *
 * 新方案稳定后本函数与 installer/ 一并删除。现在保留它，是因为 installer/ 作为回滚
 * 兜底必须仍能**重新产出**旧式安装包 —— 只留一份不能重建的源码等于没有退路。
 * 代价是体积：旧方案带两份 Electron 运行时，安装包约是新方案的两倍。
 */
if (process.argv.includes('--legacy')) {
  console.warn('\n!! 正在构建已停用的旧式安装包（双运行时，体积约为新方案的两倍）')
  const unpacked = join(outDir, 'win-unpacked')
  console.log('\n[1/3] 打包启动器免安装目录 → installer/payload')
  runBuilder(['--win', '--dir', '--publish', 'never'], root)
  console.log('\n[2/3] 复制载荷')
  cpSync(unpacked, payloadDir, { recursive: true })
  console.log('\n[3/3] 封装安装器（portable）')
  runBuilder(['--win', 'portable', '--publish', 'never'], installerDir)
  console.log('\n完成（旧方案）：产物见 release/installer/')
  process.exit(0)
}

// 一次打包同时出 portable（主产物）与 nsis（应急兜底）。
runBuilder(['--win', 'portable', 'nsis', '--publish', 'never'], root)

// 认产物时要按**本次构建的名字**精确匹配，不能用宽松的 /Setup .*\.exe$/：
// release/ 里还留着更早的 `Hunger Cat Launcher Setup 0.5.0-*.exe`（产品名尚未
// 改成 "HungerCat MineCraft Launcher" 时的产物），宽松匹配会把 0.5.0 的老包
// 当成本次的兜底产物报出来。
// 认产物时要按**本次构建的名字**精确匹配，不能用宽松的 /Setup .*\.exe$/：
// release/ 里还留着更早的 `Hunger Cat Launcher Setup 0.5.0-*.exe`（产品名尚未
// 改成 "HungerCat MineCraft Launcher" 时的产物），宽松匹配会把 0.5.0 的老包
// 当成本次的兜底产物报出来。
//
// productName 不在 package.json 里，而在 electron-builder.yml —— 那是打包真正
// 依据的名字，nsis 的默认 artifactName 正是 `${productName} Setup ${version}.exe`。
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
const productName = yml.match(/^productName:\s*(.+)$/m)?.[1]?.trim()
if (!productName) {
  console.error('[错误] 未能从 electron-builder.yml 读到 productName，无法核对 nsis 产物名。')
  process.exit(1)
}
const expectedNsis = `${productName} Setup ${version}.exe`.toLowerCase()
const portableName = (f) => /^HCMCL-.*\.exe$/i.test(f)
const exes = existsSync(outDir) ? readdirSync(outDir).filter(portableName) : []
const nsisExe = existsSync(outDir)
  ? readdirSync(outDir).find((f) => f.toLowerCase() === expectedNsis)
  : undefined

console.log('\n完成：')
for (const f of exes) {
  console.log(`  主产物   release/${f}  ${(statSync(join(outDir, f)).size / 1048576).toFixed(1)} MB`)
}
if (nsisExe) {
  console.log(`  兜底产物 release/${nsisExe}  ${(statSync(join(outDir, nsisExe)).size / 1048576).toFixed(1)} MB`)
}
if (exes.length === 0 && !nsisExe) {
  console.error('  [错误] 未找到任何安装包产物，请检查上面的打包日志。')
  process.exit(1)
}
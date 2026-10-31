// ---------------------------------------------------------------------------
//  把完整性级别统一提升为 Medium（默认 release/，--project 覆盖整个项目）。
//
//  ## 背景（实测结论，含走过的弯路）
//
//  本工作区目录（DSH 沙箱）带 Low 完整性标签 + No-Write-Up，在这里新建的 exe 会
//  **继承 Low**。Windows 启动进程时取「令牌完整性」与「镜像完整性」的较小值，于是
//  这些 exe 跑起来是 Low 进程；Low 进程写不进 %TEMP%（Medium），NSIS 安装器就会在
//  启动阶段失败。这个失败不只在用户双击时出现 —— **构建本身就会挂**：
//  electron-builder 做 NSIS 时会先产出中间安装器并**运行它**来生成卸载程序，
//  中间安装器是 Low 进程，启动即退出码 2，整个 --win 步骤报
//      ⨯ Exit code: 2. Command failed: ...-setup.exe
//
//  ## 只提 release/ 是**错的**（踩过）
//
//  只把 release/ 目录设为 Medium 会让构建更糟：node_modules 里的 app-builder.exe、
//  electron.exe 仍是 Low，Low 进程写 Medium 目录属于「写高」，直接被拒：
//      ⨯ mkdir ...\release\win-unpacked: Access is denied
//  所以必须**整棵树一起提** —— 让构建工具自身也是 Medium，进程才是 Medium，
//  才能写 Medium 目录。正确做法是对项目根执行一次
//      icacls "<项目根>" /setintegritylevel (OI)(CI)Medium /T /C
//  根目录带上 (OI)(CI) 后，**之后新建的文件都会继承 Medium**，不再产生 Low。
//
//  ## 三个模式
//
//    node scripts/fix-artifact-integrity.mjs            # 只修 release/（构建收尾用）
//    node scripts/fix-artifact-integrity.mjs --project  # 修整个项目树（一次性修复）
//    node scripts/fix-artifact-integrity.mjs --check    # 只检查不修改
//
//  --project 用单次 `icacls /T /C` 完成（1.8 万个文件约数十秒），比逐文件调用快
//  两个数量级 —— 逐文件调用会起上万个进程，命令行直接卡死。
// ---------------------------------------------------------------------------
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  process.stdout.write('[integrity] 非 Windows，跳过\n')
  process.exit(0)
}

const ARGS = process.argv.slice(2)
const CHECK_ONLY = ARGS.includes('--check')
const PROJECT = ARGS.includes('--project')
const DIR_ARG = ARGS.find((a) => !a.startsWith('--'))
// --project 时目标是项目根（脚本位于 <root>/scripts/）。
// 用 fileURLToPath 而不是 url.pathname：后者会把空格等字符保留为 %20。
const ROOT = PROJECT
  ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  : path.resolve(DIR_ARG ?? 'release')

/** 调 icacls；失败返回 false（不抛，交给调用方汇总）。 */
function icacls(args) {
  try {
    execFileSync('icacls', args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** 读当前完整性标签。 */
function readLevel(target) {
  try {
    const out = execFileSync('icacls', [target], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    if (/High Mandatory Level/i.test(out)) return 'High'
    if (/Medium Mandatory Level/i.test(out)) return 'Medium'
    if (/Low Mandatory Level/i.test(out)) return 'Low'
    return 'none'
  } catch {
    return 'unknown'
  }
}

try {
  if (!statSync(ROOT).isDirectory()) throw new Error('not a directory')
} catch {
  process.stdout.write(`[integrity] 目录不存在，跳过：${ROOT}\n`)
  process.exit(0)
}

/* ---------------- 检查模式 ---------------- */

if (CHECK_ONLY) {
  // 检查用单次 /T /C 输出再解析，避免逐文件起进程。
  let out = ''
  try {
    out = execFileSync('icacls', [ROOT, '/T', '/C'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 512 * 1024 * 1024
    })
  } catch {
    /* /C 下仍然可能整条失败，按未知处理 */
  }
  let cur = ''
  let total = 0
  let low = 0
  const lowList = []
  for (const line of out.split(/\r?\n/)) {
    if (/^[A-Za-z]:[\\/]/.test(line)) {
      cur = line.trim()
      total += 1
      continue
    }
    if (/Low Mandatory Level/i.test(line)) {
      low += 1
      if (lowList.length < 10) lowList.push(cur)
    }
  }
  for (const item of lowList) process.stdout.write(`  ! Low ${item}\n`)
  process.stdout.write(`[integrity] 检查：${total} 个对象，${low} 个是 Low\n`)
  process.exit(low === 0 ? 0 : 1)
}

/* ---------------- 修复模式 ---------------- */

const rel = path.relative(process.cwd(), ROOT) || '.'

// --project：一条命令搞定整棵树，且根目录带上 (OI)(CI) 让后续新建项继承。
if (PROJECT) {
  const ok = icacls([ROOT, '/setintegritylevel', '(OI)(CI)Medium', '/T', '/C'])
  process.stdout.write(
    ok
      ? `[integrity] ${rel}：整棵树已设为 Medium（含继承，之后新建文件自动为 Medium）\n`
      : `[integrity] ${rel}：整棵树设置失败（可能有文件被占用）\n`
  )
  process.exit(ok ? 0 : 1)
}

/* release 模式：逐项处理，覆盖顶层与 win-unpacked 等子目录。
   目录设 (OI)(CI)Medium（让新建子项继承），文件设 Medium。 */
let dirOk = 0
let dirFail = 0
let fileOk = 0
let fileFail = 0

const walk = (dir) => {
  if (icacls([dir, '/setintegritylevel', '(OI)(CI)Medium'])) dirOk += 1
  else dirFail += 1

  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walk(full)
      continue
    }
    // 只处理可执行体：.exe / .dll / .node。其它文件（yml、blockmap、7z）不影响
    // 进程完整性，改它们没有意义，还拖慢构建。
    if (!/\.(exe|dll|node)$/i.test(name)) continue
    if (icacls([full, '/setintegritylevel', 'Medium'])) fileOk += 1
    else fileFail += 1
  }
}

walk(ROOT)

process.stdout.write(
  `[integrity] ${rel}：` +
    `目录 ${dirOk} 个已设 Medium${dirFail ? `（${dirFail} 失败）` : ''}，` +
    `文件 ${fileOk} 个已设 Medium${fileFail ? `（${fileFail} 失败）` : ''}\n`
)

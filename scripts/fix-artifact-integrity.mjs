// ---------------------------------------------------------------------------
//  把 release/ 下产物的完整性级别重置为 Medium。
//
//  背景：本工作区目录（DSH 沙箱）带了 Low 完整性标签 + No-Write-Up，因此在这里
//  新构建出来的 exe 会继承 Low 标签。Windows 启动进程时取「令牌完整性」和
//  「镜像完整性」的较小值，于是双击这些 exe 得到的是 Low 完整性进程；Low 进程
//  写不进 %TEMP%（Medium），NSIS 安装器就会在启动阶段报
//    NSIS Error / Error writing temporary file. Make sure your temp folder is valid.
//
//  把产物标签改回 Medium 后，普通双击即可正常打开安装向导，也不需要管理员权限。
//  在普通目录（无 Low 标签）里构建时这一步是空操作。
//
//  用法：node scripts/fix-artifact-integrity.mjs [目录，默认 release]
// ---------------------------------------------------------------------------
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

if (process.platform !== 'win32') {
  process.stdout.write('[integrity] 非 Windows，跳过\n')
  process.exit(0)
}

const dir = path.resolve(process.argv[2] ?? 'release')

let files
try {
  files = readdirSync(dir)
} catch {
  process.stdout.write(`[integrity] 目录不存在，跳过：${dir}\n`)
  process.exit(0)
}

let changed = 0
let failed = 0
for (const name of files) {
  if (!name.toLowerCase().endsWith('.exe')) continue
  const full = path.join(dir, name)
  try {
    if (!statSync(full).isFile()) continue
    execFileSync('icacls', [full, '/setintegritylevel', 'Medium'], { stdio: 'ignore' })
    changed += 1
  } catch {
    failed += 1
  }
}

process.stdout.write(
  `[integrity] ${dir}：${changed} 个 exe 已设为 Medium` + (failed > 0 ? `，${failed} 个失败` : '') + '\n'
)

// 准备联机板块所需的第三方二进制资源。
//
// 放到 resources/easytier/（随 electron-builder 的 extraResources 打包）：
//   - wintun.dll        （Wintun 预编译二进制许可，可再分发）
//   - WinDivert64.sys   （LGPL-3.0，可再分发）
//   - easytier-core.exe / easytier-cli.exe
//
// 关于 easytier-core / cli：EasyTier 官方发布包里的这两个文件在 PE 导入表中静态导入了
// Npcap 的 packet.dll。Npcap 不是开源软件、未经 Nmap Project 书面许可不得随其它软件
// 再分发，因此 MCTier 官方也刻意不从发布包提取它们，而是用
// scripts/build-easytier-npcap-free.ps1 自行重建。
//
// 本脚本默认只准备「可再分发」的 wintun.dll / WinDivert64.sys，并把官方包里的
// easytier-core/cli 放到 easytier-core.vendor/ 作为「仅本机调试」的占位（不随包分发）。
// 正式发布请务必改为使用自行重建的无 Npcap 版本。
//
// 用法：node scripts/prepare-easytier-binaries.mjs [--with-vendor-core]
//
// 注意：Node 需要 --use-system-ca 才能在本机校验证书链，
// 即 `node --use-system-ca scripts/prepare-easytier-binaries.mjs`。

import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, resolve } from 'path'

const ZIP_URL =
  'https://github.com/EasyTier/EasyTier/releases/download/v2.5.0/easytier-windows-x86_64-v2.5.0.zip'

/** 可直接再分发、随安装包发布的文件。 */
const REDISTRIBUTABLE = ['wintun.dll', 'WinDivert64.sys']
/** 官方包的 easytier 核心：含 Npcap 静态导入，仅作本机调试占位，不随包分发。 */
const VENDOR_CORE = ['easytier-core.exe', 'easytier-cli.exe']

const withVendorCore = process.argv.includes('--with-vendor-core')

// 脚本位于 <repo>/scripts/，仓库根目录即上一级。
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const targetDir = join(repoRoot, 'resources', 'easytier')
const vendorDir = join(targetDir, 'easytier-core.vendor')
const tmp = process.env.TEMP ?? process.env.TMP ?? '/tmp'
const tmpZip = join(tmp, 'easytier-v2.5.0-windows-x86_64.zip')
const tmpExtract = join(tmp, `easytier-extract-${Date.now()}`)

async function download(url, dest) {
  if (existsSync(dest) && statSync(dest).size > 1024 * 1024) {
    console.log(`复用已缓存的压缩包：${dest}`)
    return
  }
  console.log(`下载 ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
  console.log(`已保存 ${(statSync(dest).size / 1024 / 1024).toFixed(1)} MB`)
}

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

function findFile(all, name) {
  return all.find((p) => p.toLowerCase().endsWith(name.toLowerCase()))
}

await download(ZIP_URL, tmpZip)

mkdirSync(tmpExtract, { recursive: true })
// Windows 自带 tar（bsdtar）可直接解 zip，避免额外依赖。
execFileSync('tar', ['-xf', tmpZip, '-C', tmpExtract], { stdio: 'inherit' })

mkdirSync(targetDir, { recursive: true })
const all = walk(tmpExtract)

const report = []
for (const name of REDISTRIBUTABLE) {
  const src = findFile(all, name)
  if (!src) {
    console.warn(`未在压缩包中找到 ${name}`)
    continue
  }
  const dst = join(targetDir, name)
  copyFileSync(src, dst)
  report.push(`  ${name}  sha256=${sha256(dst)}`)
}

if (withVendorCore) {
  mkdirSync(vendorDir, { recursive: true })
  for (const name of VENDOR_CORE) {
    const src = findFile(all, name)
    if (!src) {
      console.warn(`未在压缩包中找到 ${name}`)
      continue
    }
    const dst = join(vendorDir, name)
    copyFileSync(src, dst)
    report.push(`  (vendor) ${name}  sha256=${sha256(dst)}`)
  }
}

console.log(`\n已写入 ${targetDir}：`)
console.log(report.length ? report.join('\n') : '  （无）')
if (!withVendorCore) {
  console.log('\n提示：未包含 easytier-core/cli。正式使用请用 MCTier 的')
  console.log('      scripts/build-easytier-npcap-free.ps1 重建无 Npcap 版本后放入本目录，')
  console.log('      或加 --with-vendor-core 放入官方版本占位（含 Npcap，切勿随包分发）。')
}

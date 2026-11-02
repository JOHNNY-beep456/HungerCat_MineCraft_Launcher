import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = dirname(fileURLToPath(import.meta.url))
const version = JSON.parse(readFileSync(join(root, '../package.json'), 'utf8')).version
const exe = join(root, 'src/artifacts/win-x64/PCCL2.Native.exe')
if (!existsSync(exe)) throw new Error('请先运行 PCCL2-PAK/build.ps1')
// 完整上游前端是 .NET Framework 4.8 程序：运行时安装包随组件分发，
// 使缺少该运行时的机器也能完成安装，而不是启动即闪退。
const runtime = join(root, 'runtime/NDP48-x86-x64-AllOS-ENU.exe')
if (!existsSync(runtime)) throw new Error('缺少 runtime/NDP48-x86-x64-AllOS-ENU.exe')
const name = `PCCL2-${version}-win-x64.zip`
const destination = join(root, name)
// ZIP 采用标准 ZIP32 / deflate，无目录前缀；执行器路径保持为已构建产物。
const program = [
  'import sys,zipfile',
  'z=zipfile.ZipFile(sys.argv[3],"w",zipfile.ZIP_DEFLATED)',
  'z.write(sys.argv[1],"PCCL2.Native.exe")',
  'z.write(sys.argv[2],"runtime/NDP48-x86-x64-AllOS-ENU.exe")',
  'z.close()'
].join('; ')
const result = spawnSync('python', ['-c', program, exe, runtime, destination], { stdio: 'inherit' })
if (result.status !== 0) throw new Error('ZIP 构建失败')
const bytes = readFileSync(destination)
const manifest = {
  schemaVersion: 1,
  component: 'pccl2',
  version,
  platform: 'win32',
  arch: 'x64',
  entry: 'PCCL2.Native.exe',
  url: `./${name}`,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  size: bytes.length,
  bridgeVersion: 1,
  // 声明随包携带 .NET Framework 4.8 运行时安装程序。
  runtime: 'net48-bundled'
}
writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
writeFileSync(join(root, 'SHA256SUMS.txt'), `${manifest.sha256}  ${name}\n`)
console.log(JSON.stringify({ package: resolve(destination), version, size: bytes.length, sha256: manifest.sha256 }, null, 2))

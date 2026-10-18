/**
 * 更新包身份解析单测。
 *
 * 直接跑 TS（Node 22+ 原生类型擦除），无需编译：
 *   node scripts/test-update-resolve.mjs
 *
 * 覆盖：双包齐全、只发安装版（含旧服务端仅有 url）、只发便携版。
 */
import { resolveUpdateForIdentity } from '../src/main/update-resolve.ts'

let pass = 0
let fail = 0

function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`)
  }
}

const both = {
  version: '1.0.0',
  url: 'https://x/ins.exe',
  filename: 'ins.exe',
  installerUrl: 'https://x/ins.exe',
  installerFilename: 'ins.exe',
  portableUrl: 'https://x/port.exe',
  portableFilename: 'port.exe'
}

console.log('双包齐全：各取所需')
eq('便携版取 portable', resolveUpdateForIdentity(both, true).url, 'https://x/port.exe')
eq('便携版文件名', resolveUpdateForIdentity(both, true).filename, 'port.exe')
eq('安装版取 installer', resolveUpdateForIdentity(both, false).url, 'https://x/ins.exe')
eq('安装版文件名', resolveUpdateForIdentity(both, false).filename, 'ins.exe')

console.log('\n旧服务端：只有 url（迁移前数据）→ 两种身份都回退到它')
const legacy = { version: '1.0.0', url: 'https://x/legacy.exe', filename: 'legacy.exe' }
eq('便携版回退', resolveUpdateForIdentity(legacy, true).url, 'https://x/legacy.exe')
eq('安装版回退', resolveUpdateForIdentity(legacy, false).url, 'https://x/legacy.exe')

console.log('\n只发安装版（新结构，portable 为空）→ 便携版回退安装版')
const insOnly = {
  version: '1.0.0',
  url: 'https://x/ins.exe',
  filename: 'ins.exe',
  installerUrl: 'https://x/ins.exe',
  installerFilename: 'ins.exe',
  portableUrl: '',
  portableFilename: ''
}
eq('便携版回退', resolveUpdateForIdentity(insOnly, true).url, 'https://x/ins.exe')
eq('安装版正常', resolveUpdateForIdentity(insOnly, false).url, 'https://x/ins.exe')

console.log('\n只发便携版（installer/url 均为空）→ 安装版回退便携版')
const portOnly = {
  version: '1.0.0',
  url: '',
  filename: '',
  installerUrl: '',
  installerFilename: '',
  portableUrl: 'https://x/port.exe',
  portableFilename: 'port.exe'
}
eq('安装版回退', resolveUpdateForIdentity(portOnly, false).url, 'https://x/port.exe')
eq('便携版正常', resolveUpdateForIdentity(portOnly, true).url, 'https://x/port.exe')

console.log('\n一条地址都没有 → 空 url（调用方据此判定无更新）')
eq('便携版', resolveUpdateForIdentity({ version: '1.0.0', url: '' }, true).url, '')
eq('安装版', resolveUpdateForIdentity({ version: '1.0.0', url: '' }, false).url, '')

console.log('\n其余字段应原样保留')
const kept = resolveUpdateForIdentity(both, true)
eq('version', kept.version, '1.0.0')
eq('installerUrl 未被破坏', kept.installerUrl, 'https://x/ins.exe')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

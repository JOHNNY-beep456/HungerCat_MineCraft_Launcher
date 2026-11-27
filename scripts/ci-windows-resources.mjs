/**
 * CI 专用：确认 Windows 安装包要随包的联机内核（easytier-core / cli）存在且架构正确，
 * 否则把 `src-tauri/tauri.windows.conf.json` 里的 resources 映射去掉再构建。
 *
 * 为什么需要这一步：
 *   - `resources/easytier/` 是本地构建产物，**不入库**（体积 + Npcap 许可问题），
 *     由 `scripts/build-easytier-npcap-free.ps1` 按架构重建。CI 上若没构建出来，
 *     Tauri 会因为「resource path doesn't exist」直接失败。
 *   - 但把错架构的内核塞进包里同样不行：运行时会比对 PE machine
 *     （src-tauri/src/multiplayer/resources.rs），不一致就判为「文件损坏」。
 *     所以这里既查存在性，也查架构。
 *
 * 策略：
 *   x64        —— 缺少或不匹配时**失败**：主平台不能悄悄少掉联机能力。
 *   x86/arm64  —— 缺少或不匹配时降级：去掉 resources 继续出包，并在日志里告警。
 *                 （这两个架构的内核需要交叉编译，历史上也从未真正打包过对应架构的内核。）
 *
 * 用法：node scripts/ci-windows-resources.mjs --arch x64|--arch x86|--arch arm64 [--allow-strip]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RES_DIR = resolve(ROOT, 'resources/easytier')
const WIN_CONF = resolve(ROOT, 'src-tauri/tauri.windows.conf.json')

const MACHINE = {
  x64: 0x8664,
  x86: 0x14c,
  arm64: 0xaa64
}

const args = process.argv.slice(2)
const arch = (args[args.indexOf('--arch') + 1] ?? '').toLowerCase()
const allowStrip = args.includes('--allow-strip')

if (!(arch in MACHINE)) {
  console.error(`未知架构：${arch || '(空)'}；可选 ${Object.keys(MACHINE).join(' / ')}`)
  process.exit(2)
}

/** 读取 PE/COFF 的 Machine 字段；不是合法 PE 时返回 null。 */
function peMachine(path) {
  try {
    const head = readFileSync(path, { encoding: null }).subarray(0, 0x400)
    if (head.length < 0x40 || head.readUInt16LE(0) !== 0x5a4d) return null // 'MZ'
    const peOffset = head.readUInt32LE(0x3c)
    if (peOffset + 6 > head.length) return null
    if (head.readUInt32LE(peOffset) !== 0x00004550) return null // 'PE\0\0'
    return head.readUInt16LE(peOffset + 4)
  } catch {
    return null
  }
}

const files = ['easytier-core.exe', 'easytier-cli.exe']
const found = files.map((name) => {
  const path = resolve(RES_DIR, name)
  if (!existsSync(path)) return { name, state: 'missing' }
  const machine = peMachine(path)
  const ok = machine === MACHINE[arch]
  return {
    name,
    state: ok ? 'ok' : 'wrong-arch',
    machine: machine === null ? 'not-pe' : `0x${machine.toString(16)}`
  }
})

const usable = found.every((f) => f.state === 'ok')
console.log(`联机内核（${arch}）：`, found.map((f) => `${f.name}=${f.state}${f.machine ? `(${f.machine})` : ''}`).join(', '))

if (usable) {
  console.log('随包内核就绪，保持 resources 映射不变。')
  process.exit(0)
}

const detail = found.map((f) => `${f.name}: ${f.state}`).join('; ')

if (arch === 'x64') {
  console.error(`x64 安装包必须带联机内核，但当前不可用（${detail}）。请先运行 scripts/build-easytier-npcap-free.ps1 -Arch x64。`)
  process.exit(1)
}

if (!allowStrip) {
  console.error(`联机内核不可用（${detail}）；若要降级出包请加 --allow-strip。`)
  process.exit(1)
}

// 去掉 resources 映射：Tauri 会因为缺文件而拒绝构建，这里改成「不带内核」的包。
// 只动 bundle.resources，其余（nsis 模板 / 安装钩子 / installMode）原样保留。
const conf = JSON.parse(readFileSync(WIN_CONF, 'utf8'))
if (conf.bundle?.resources) {
  delete conf.bundle.resources
  writeFileSync(WIN_CONF, `${JSON.stringify(conf, null, 2)}\n`, 'utf8')
}

console.log(
  `::warning::${arch} 包将**不含**联机内核（${detail}）；联机板块在该架构上不可用。` +
    ' 需要时请用 scripts/build-easytier-npcap-free.ps1 -Arch ' + arch + ' 构建后重新出包。'
)
process.exit(0)

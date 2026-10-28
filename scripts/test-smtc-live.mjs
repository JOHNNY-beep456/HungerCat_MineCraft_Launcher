/**
 * 实跑 SMTC 采样脚本一次，确认语法正确、字段齐全。
 *
 * 这条测试的价值：脚本是**通过命令行传给 PowerShell 的一整段字符串**，
 * 改错一个字符（哪怕只是中文注释）都编译期查不出来，只能运行时才发现。
 * 上面那条 ASCII 测试挡一类问题，这里挡「语法/字段名写错」这一类。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(resolve(ROOT, 'src/main/netease/smtc.ts'), 'utf8')
const tick = src.indexOf('`', src.indexOf('const SMTC_SCRIPT'))
const end = src.indexOf('`', tick + 1)
const script = src.slice(tick + 1, end)

// 脚本本身是无限循环（每 400ms 采样一次）。只让它跑一轮就杀：
// 用一个带超时的调用，取它输出的第一行 JSON。
const encoded = Buffer.from(script, 'utf16le').toString('base64')
const result = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
  { timeout: 6000, encoding: 'utf8', windowsHide: true }
)

const out = (result.stdout ?? '').trim()
const stderr = (result.stderr ?? '').trim()

let pass = 0
let fail = 0
function ok(label, cond, detail) {
  if (cond) {
    pass++
    console.log('  ok   ' + label)
  } else {
    fail++
    console.log('  FAIL ' + label + (detail ? '\n       ' + detail : ''))
  }
}

// 超时被杀是预期的（脚本是死循环），不算失败
const timedOut = result.error && String(result.error.message || '').includes('ETIMEDOUT')
console.log('执行状态：' + (timedOut ? '超时结束（预期，脚本是死循环）' : 'exit=' + result.status))

// 语法错误会出现在 stderr
const syntaxError = /ParserError|Unexpected token|was not recognized|invalid/i.test(stderr)
ok('脚本无语法错误', !syntaxError, stderr.slice(0, 600))

// 应当至少输出一行 JSON
const firstLine = out.split('\n').find((l) => l.trim().startsWith('{'))
ok('输出了 JSON 采样', Boolean(firstLine), out.slice(0, 400) || '(无输出)')

if (firstLine) {
  let payload = null
  try {
    payload = JSON.parse(firstLine)
  } catch (e) {
    ok('JSON 可解析', false, String(e))
  }
  if (payload) {
    ok('JSON 可解析', true)
    ok('含 ts 字段', typeof payload.ts === 'number', String(payload.ts))
    ok('含 sessions 字段', payload.sessions !== undefined)
    // 字段名必须与 parseLine 读取的一致
    const items = Array.isArray(payload.sessions)
      ? payload.sessions
      : payload.sessions
        ? [payload.sessions]
        : []
    if (items.length > 0) {
      const s = items[0]
      for (const key of ['aumid', 'title', 'artist', 'album', 'status', 'start', 'pos', 'end', 'updated']) {
        ok('会话含 ' + key + ' 字段', key in s, JSON.stringify(Object.keys(s)))
      }
      console.log('\n  实际采样到 ' + items.length + ' 个媒体会话：')
      for (const s of items) {
        console.log(
          '    ' + (s.aumid || '(无AUMID)') +
            ' | ' + (s.title || '(无标题)') +
            ' | status=' + s.status +
            ' | pos=' + s.pos + ' start=' + s.start + ' end=' + s.end +
            ' updated=' + s.updated
        )
      }
    } else {
      console.log('\n  （当前系统没有媒体会话在播放，跳过字段级检查）')
    }
  }
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
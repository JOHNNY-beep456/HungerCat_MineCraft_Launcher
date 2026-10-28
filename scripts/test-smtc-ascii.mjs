/**
 * 校验：SMTC 采样脚本必须是纯 ASCII。
 *
 * 原因：Windows PowerShell 5.1 会按系统代码页（本项目场景为 GBK）解析通过命令行传入的
 * 脚本，任何非 ASCII 字符都会变成乱码语法错误，整段采样直接跑不起来。
 * 中文只能出现在注释里——但那也在脚本体内，所以注释也必须用英文。
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(resolve(ROOT, 'src/main/netease/smtc.ts'), 'utf8')

const start = src.indexOf('const SMTC_SCRIPT')
if (start === -1) {
  console.error('找不到 SMTC_SCRIPT 定义')
  process.exit(1)
}
const tick = src.indexOf('`', start)
const end = src.indexOf('`', tick + 1)
if (tick === -1 || end === -1) {
  console.error('无法定位脚本字面量边界')
  process.exit(1)
}
const body = src.slice(tick + 1, end)

const bad = []
for (let i = 0; i < body.length; i++) {
  if (body.charCodeAt(i) > 127) {
    const lineNo = body.slice(0, i).split('\n').length
    bad.push({ line: lineNo, char: body[i] })
  }
}

console.log('脚本长度:', body.length, '字符')
if (bad.length === 0) {
  console.log('✓ 纯 ASCII，符合 PowerShell 5.1 约束')
} else {
  console.log('!! 发现 ' + bad.length + ' 个非 ASCII 字符（会导致脚本语法错误）:')
  const byLine = new Map()
  for (const b of bad) byLine.set(b.line, (byLine.get(b.line) ?? '') + b.char)
  for (const [line, chars] of byLine) {
    console.log('  第 ' + line + ' 行: ' + JSON.stringify(chars))
    console.log('    ' + body.split('\n')[line - 1].trim())
  }
  process.exit(1)
}
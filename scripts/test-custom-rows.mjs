/**
 * 校验「注册表里每个 control: 'custom' 的字段，在 CUSTOM_ROWS 里都有对应组件」。
 *
 * 这是一个很容易静默失败的点：`AutoFields` 拿到 `control: 'custom'` 后会去
 * `CUSTOM_ROWS[key]` 找组件，找不到就 `return null` —— 页面上**什么都不显示**，
 * 既不报错也没有警告。板块重组时把字段挪到新板块后忘了登记，就会踩这个坑。
 *
 * 运行：node scripts/test-custom-rows.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
let fail = 0
function ok(label, condition, detail) {
  if (condition) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${detail === undefined ? '' : `\n       ${detail}`}`)
  }
}

const { SETTINGS_DEFS } = await import('../src/shared/settings.ts')

const rowsSrc = readFileSync(resolve(ROOT, 'src/renderer/src/pages/settings/rows.tsx'), 'utf8')

/** 解析 CUSTOM_ROWS 对象字面量里的键（文件末尾那段，键形如 `  key: Component,`）。 */
const marker = rowsSrc.indexOf('export const CUSTOM_ROWS')
ok('能定位到 CUSTOM_ROWS 定义', marker !== -1)
const tail = rowsSrc.slice(marker)
// 取第一个 `= {` 之后到最后一个 `}` 之间的内容
const open = tail.indexOf('{')
const close = tail.lastIndexOf('}')
const body = open !== -1 && close > open ? tail.slice(open + 1, close) : ''
const customRowKeys = new Set(
  [...body.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1])
)

console.log('\nCUSTOM_ROWS 已登记:', [...customRowKeys].join(', '))

/** 注册表里所有 custom 字段。 */
const customFields = Object.entries(SETTINGS_DEFS)
  .filter(([, def]) => def?.ui?.control === 'custom')
  .map(([key]) => key)

console.log('注册表 custom 字段:', customFields.join(', '))

console.log('\n一致性')
{
  const missing = customFields.filter((k) => !customRowKeys.has(k))
  ok('每个 custom 字段都有行组件', missing.length === 0, `缺少组件: ${missing.join(', ')}`)
}

console.log('\n本次重组重点字段')
{
  // 这几个是重组后新挂到注册表上的（之前是板块手工子节点）
  for (const key of ['uapisApiKeySet', 'hudEnabled']) {
    ok(`${key} 已登记行组件`, customRowKeys.has(key))
    const def = SETTINGS_DEFS[key]
    ok(`${key} 在注册表里是 custom`, def?.ui?.control === 'custom', `实际: ${def?.ui?.control}`)
    ok(`${key} 属于预期板块`, def?.ui?.section === (key === 'hudEnabled' ? 'game' : 'general'), `实际: ${def?.ui?.section}`)
  }
}

console.log('\n反向检查：行组件都有对应字段')
{
  const orphan = [...customRowKeys].filter((k) => !(k in SETTINGS_DEFS))
  ok('没有孤儿行组件（键名都能对上字段）', orphan.length === 0, orphan.join(', '))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

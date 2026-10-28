/**
 * 核对「设置页板块结构」是否符合改版文档。
 *
 * 不渲染 React，只读两处真源并交叉比对：
 *   1. `src/shared/settings.ts` 的 SETTINGS_DEFS（板块归属 + 声明顺序）
 *   2. `src/renderer/src/pages/SettingsPage.tsx` 的板块挂载顺序
 *
 * 这样即便某天有人往注册表里加了个 `section: 'foo'` 却没在组合根里挂载
 * （或反过来），都会在这里被立刻抓住 —— 那个字段会静默不显示。
 *
 * 运行：node scripts/test-settings-layout.mjs
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

/** 收集某板块下的字段（保持声明顺序）。 */
function fieldsOf(section) {
  return Object.entries(SETTINGS_DEFS)
    .filter(([, def]) => def?.ui?.section === section)
    .map(([key]) => key)
}

const pageSrc = readFileSync(resolve(ROOT, 'src/renderer/src/pages/SettingsPage.tsx'), 'utf8')
/** 组合根里挂载的板块组件顺序。 */
const mounted = [...pageSrc.matchAll(/<(\w+Section)\s*\/>/g)].map((m) => m[1])

const SECTION_BY_COMPONENT = {
  GeneralSection: 'general',
  LanguageSection: 'language',
  GameSection: 'game',
  AiSection: 'ai',
  DownloadSection: 'download',
  ExperimentalSection: 'experimental',
  DeveloperSection: 'dev',
  UpdateSection: 'announce'
}

console.log('板块顺序（按改版文档）')
{
  const expected = [
    'GeneralSection',
    'LanguageSection',
    'GameSection',
    'AiSection',
    'DownloadSection',
    'ExperimentalSection',
    'DeveloperSection',
    'UpdateSection'
  ]
  ok('挂载顺序与文档一致', JSON.stringify(mounted) === JSON.stringify(expected), `实际: ${mounted.join(' → ')}`)
  ok('8 个板块', mounted.length === 8, `实际 ${mounted.length} 个`)
}

console.log('注册表板块必须都被挂载')
{
  const allSections = new Set(
    Object.values(SETTINGS_DEFS)
      .map((def) => def?.ui?.section)
      .filter(Boolean)
  )
  const mountedSections = new Set(mounted.map((c) => SECTION_BY_COMPONENT[c]))
  const orphan = [...allSections].filter((s) => !mountedSections.has(s))
  ok('没有「有字段但未挂载」的板块', orphan.length === 0, `孤儿板块: ${orphan.join(', ')}`)
}

console.log('「社区资源」板块已撤销')
{
  const hasCommunity = mounted.includes('CommunitySection')
  ok('组合根不再挂载社区资源板块', !hasCommunity)
  const communityFields = Object.entries(SETTINGS_DEFS).filter(([, d]) => d?.ui?.section === 'community')
  ok('没有字段仍指向 community 板块', communityFields.length === 0, communityFields.map(([k]) => k).join(','))
  // 底层字段必须保留（下载层 / Mod 列表还在用）
  ok('communitySource 字段保留', 'communitySource' in SETTINGS_DEFS)
  ok('modTitleStyle 字段保留', 'modTitleStyle' in SETTINGS_DEFS)
}

console.log('「通用」板块条目与顺序')
{
  const fields = fieldsOf('general')
  const expected = [
    'theme', // 明暗模式
    'mode', // 运行模式
    'experimental', // 主题（皮肤）
    'accentColor', // 主题色
    'reducedMotion', // 减少动态效果
    'uapisApiKeySet', // uapis.cn API KEY
    'background', // 背景
    'backgroundImage', // 自定义壁纸
    'navPosition', // 导航栏位置
    'showServerStatus', // 显示服务器状态
    'closeBehavior' // 关闭按钮行为
  ]
  ok('条目集合正确', JSON.stringify([...fields].sort()) === JSON.stringify([...expected].sort()), `实际: ${fields.join(', ')}`)
  ok('明暗模式在最前', fields[0] === 'theme', `首位是 ${fields[0]}`)
  ok('运行模式第二', fields[1] === 'mode', `第二位是 ${fields[1]}`)
  ok('uapis KEY 在减少动态效果之后、背景之前', fields.indexOf('uapisApiKeySet') === fields.indexOf('reducedMotion') + 1 && fields.indexOf('background') === fields.indexOf('uapisApiKeySet') + 1)
}

console.log('「语言」板块')
{
  const fields = fieldsOf('language')
  ok('含语言 / 自动翻译 / 翻译资源名', JSON.stringify(fields) === JSON.stringify(['language', 'autoTranslateResources', 'translateResourceNames']), fields.join(', '))
}

console.log('「游戏」板块（含 Java 与 HUD）')
{
  const fields = fieldsOf('game')
  ok('HUD 显示在游戏板块', fields.includes('hudEnabled'))
  ok('Java 运行时并入游戏板块', fields.includes('javaAutoDetect') && fields.includes('javaPath'))
  ok('默认版本目录在首位', fields[0] === 'gameDir', fields[0])
  ok('模组元数据在 HUD 之前', fields.indexOf('metadataOnlyMods') < fields.indexOf('hudEnabled'))
  ok('Java 在末尾', fields[fields.length - 1] === 'javaPath', `末位是 ${fields[fields.length - 1]}`)
}

console.log('「开发者选项」板块')
{
  const fields = fieldsOf('dev')
  ok('含 Debug 模式与调试密钥', JSON.stringify(fields) === JSON.stringify(['debugMode', 'debugKey']), fields.join(', '))
  ok('Debug 项已不在游戏板块', !fieldsOf('game').includes('debugMode') && !fieldsOf('game').includes('debugKey'))

  // 「开发模式」与「调试」两个子标题：键必须真的存在，否则 t() 会原样显示键名。
  const devSrc = readFileSync(resolve(ROOT, 'src/renderer/src/pages/settings/DeveloperSection.tsx'), 'utf8')
  ok('用 SubHeading 渲染「开发模式」子标题', /SubHeading title=\{t\('settings\.dev\.subtitle'\)\}/.test(devSrc))
  ok('用 SubHeading 渲染「调试」子标题', /SubHeading title=\{t\('settings\.dev\.debugSubtitle'\)\}/.test(devSrc))
  ok('邮箱验证码区域在「开发模式」子标题之后', devSrc.indexOf("settings.dev.subtitle") < devSrc.indexOf("settings.dev.email"))
  ok('Debug 字段在「调试」子标题之后', devSrc.indexOf("settings.dev.debugSubtitle") < devSrc.indexOf('<AutoFields section="dev" />'))
}

console.log('「公告 & 更新」板块（原两块合并）')
{
  const fields = fieldsOf('announce')
  ok('含公告展示 + 两个自动检查', JSON.stringify(fields) === JSON.stringify(['announcementDisplay', 'autoCheckLauncherUpdate', 'autoCheckHomepageUpdate']), fields.join(', '))
  ok('旧的 notice / update 板块已不存在', fieldsOf('notice').length === 0 && fieldsOf('update').length === 0)
}

console.log('「部分实验性功能」板块')
{
  const fields = fieldsOf('experimental')
  ok('仍含壁纸明暗 / 联机 / GPU 加速', JSON.stringify(fields) === JSON.stringify(['autoThemeFromWallpaper', 'enableMultiplayer', 'hardwareAcceleration']), fields.join(', '))
}

console.log('派生字段不可被写回')
{
  // uapisApiKeySet 现在带 ui，必须仍然被 store 过滤掉（否则会写进 settings.json）
  const storeSrc = readFileSync(resolve(ROOT, 'src/main/store.ts'), 'utf8')
  ok('store 仍会剔除 uapisApiKeySet', storeSrc.includes('delete (next as Partial<LauncherSettings>).uapisApiKeySet'))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

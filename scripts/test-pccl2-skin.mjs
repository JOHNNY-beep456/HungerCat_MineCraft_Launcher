/**
 * PCCL2 原生 WPF 迁移回归测试。
 *
 * 验证 Electron 渲染层已移除旧 React 版式，同时保留原生桥接入口、页面导航
 * 与其它皮肤的接管表。该测试只检查源码结构，不启动 Electron。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8')
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

const app = read('src/renderer/src/App.tsx')
const home = read('src/renderer/src/pages/CustomHomePage.tsx')
const resources = read('src/renderer/src/pages/ResourceDownloadPage.tsx')
const settings = read('src/renderer/src/pages/SettingsPage.tsx')
const css = read('src/renderer/src/index.css')
const bridge = read('src/main/pccl2/bridge.ts')
const preload = read('src/preload/index.ts')
const shared = read('src/shared/settings.ts')

console.log('Electron 渲染层已切换到原生 PCCL2')
ok('旧标题栏组件已删除', !existsSync(resolve(ROOT, 'src/renderer/src/components/Pccl2TitleBar.tsx')))
ok('旧 PCCL2 主页组件已删除', !existsSync(resolve(ROOT, 'src/renderer/src/pages/Pccl2HomePage.tsx')))
ok('App 使用普通 TitleBar', /<TitleBar onLogoDoubleClick/.test(app))
ok('App 保留原生窗口导航订阅', /window\.api\.pccl2\.onNavigate/.test(app))
ok('App 无旧 PCCL2 标题栏分支', !/Pccl2TitleBar|const pccl2 =|!pccl2/.test(app))
ok('自定义主页优先于内置主页', /if \(settings\.homepageId\)[\s\S]{0,180}return <HomePage/.test(home))
ok('HomeRoute 保留 onNavigate 类型入口', /onNavigate\?: \(p: PageId\) => void/.test(home))
ok('资源下载页无旧 PCCL2 子导航', !/isPccl2Skin|TAB_ICON|pccl2-subnav/.test(resources))
ok('设置页保留全部 8 个设置板块', (settings.match(/<(General|Language|Game|Ai|Download|Experimental|Developer|Update)Section \/>/g) || []).length === 8)
ok('设置页无旧 PCCL2 分组导航', !/isPccl2Skin|pccl2-subnav|GROUPS/.test(settings))
ok('旧 PCCL2 CSS 已从 marker 起移除', !/PCCL2|pccl2/i.test(css))
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:[^"\\]|\\.)*"/g, '""')
ok('剩余 CSS 花括号平衡', (stripped.match(/\{/g) || []).length === (stripped.match(/\}/g) || []).length)

console.log('\n原生桥接与下载安装入口')
ok('原生桥接注册导航消息', /webContents\.send\('pccl2:navigate'/.test(bridge))
ok('原生桥接支持打开与恢复', /ipcMain\.handle\('pccl2:open'/.test(bridge) && /ipcMain\.handle\('pccl2:restore'/.test(bridge))
ok('预加载层保留原生 PCCL2 API', /onNavigate: subscribe/.test(preload) && /ipcRenderer\.invoke\('pccl2:open'/.test(preload))
ok('组件下载保留 HTTPS 与 SHA-256 校验', /u\.protocol !== 'https:'/.test(read('src/main/pccl2/component.ts')) && /sha256File\(archive\)/.test(read('src/main/pccl2/component.ts')))

console.log('\n其它皮肤接管表保持有效')
const { skinLocks } = await import('../src/shared/settings.ts')
for (const skin of ['github', 'minecraft', 'winui2', 'winui3']) {
  const locks = skinLocks(skin)
  ok(`${skin} 仍接管主题色与背景`, locks.accent && locks.background)
}
for (const skin of ['material', 'win10']) {
  const locks = skinLocks(skin)
  ok(`${skin} 仍接管背景`, !locks.accent && locks.background)
}
for (const skin of ['glass', 'mac', 'mica']) {
  const locks = skinLocks(skin)
  ok(`${skin} 仍尊重主题色与背景`, !locks.accent && !locks.background)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

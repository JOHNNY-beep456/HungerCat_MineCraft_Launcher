/**
 * 纯 CSS 3D 玩家模型的回归测试（离线，源码断言）。
 *
 * 锁住一类很容易被"优化"回去的缺陷：给盒子的面加
 * `backface-visibility: hidden` 来剔除背面。
 *
 * 模型是封闭盒子，6 个面都朝外，背面本会被正面挡住，所以剔除看起来等价。
 * 但 CSS 3D 没有 z-buffer：背面判定靠法线与视线的点积，当某个面转到几乎侧对
 * 镜头（法线 ⟂ 视线）时判定处在临界点，浮点误差会让结果在相邻帧之间翻转 ——
 * 该面瞬间消失，模型露出缺口。自转动画用 steps() 离散化，会长时间停在整数角度，
 * 正好把临界帧停得最久，于是表现为「随机缺一块，且停住能看见」。
 *
 * 运行：node scripts/test-player3d.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(resolve(ROOT, 'src/renderer/src/components/PlayerModel3D.tsx'), 'utf8')

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

console.log('面材质：不要剔除背面')
ok(
  'faceStyle 不再设置 backfaceVisibility',
  !/backfaceVisibility:\s*'hidden'/.test(src),
  '临界角度的背面判定会翻转，导致面随机消失'
)
ok(
  '保留了「为什么不能加」的说明',
  /刻意\*\*不设\*\* backface-visibility/.test(src),
  '否则后来者会把它当成性能优化加回去'
)

console.log('\n盒体结构：封闭且保持 3D')
ok(
  '有 perspective（否则 3D 会退化成平面投影）',
  /perspective:/.test(src)
)
const boxBody = src.slice(src.indexOf('function Box('), src.indexOf('/** 各部位的贴图区域'))
ok('Box 容器使用 preserve-3d', /transformStyle: 'preserve-3d'/.test(boxBody))
ok(
  '6 个面齐全（前后左右上下）',
  ['translateZ\\(\\$\\{d / 2\\}px\\)', 'rotateY\\(180deg\\)', 'rotateY\\(90deg\\)', 'rotateY\\(-90deg\\)', 'rotateX\\(90deg\\)', 'rotateX\\(-90deg\\)'].every(
    (re) => new RegExp(re).test(boxBody)
  ),
  '缺一面就会真的缺一块'
)
ok(
  '每个面都带 translateZ（深度不同，排序才不会 tie）',
  (boxBody.match(/translateZ\(/g) || []).length >= 6
)
ok(
  '面按盒子中心摆放（非立方体盒子不会错位）',
  /\(w - d\) \/ 2/.test(boxBody) &&
    /\(h - d\) \/ 2/.test(boxBody) &&
    /left: ox/.test(boxBody) &&
    /top: oy/.test(boxBody),
  '左/右面与上/下面若不居中，4×12×4 的手臂顶面会错进头部'
)

console.log('\n3D 上下文链：舞台与自转层')
ok(
  '舞台（拖动旋转层）preserve-3d',
  /transform: `rotateX\(\$\{rot\.x\}deg\) rotateY\(\$\{rot\.y\}deg\)`/.test(src)
)
ok(
  '自转层 preserve-3d 且拖动时暂停动画',
  /className="player3d-spin"/.test(src) && /animationPlayState: dragging \? 'paused' : 'running'/.test(src)
)
ok(
  '漫游旋转限制在 ±89°（避免越过极点翻转）',
  /Math\.max\(-89, Math\.min\(89,/.test(src)
)

console.log('\n纹理映射')
ok(
  '按皮肤真实高度缩放（兼容旧版 64×32）',
  /backgroundSize: `\$\{64 \* unit\}px \$\{skinH \* unit\}px`/.test(src)
)
ok('像素风渲染', /imageRendering: 'pixelated'/.test(src))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

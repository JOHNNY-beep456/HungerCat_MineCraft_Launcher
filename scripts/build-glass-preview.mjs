/**
 * 生成可独立打开的液态玻璃预览页（docs/liquid-glass-preview.html）。
 *
 * 复用 index.html 里已注入的两张贴图与滤镜链，把启动器里的六个构件
 * （背景 / 面板 / 次级按钮 / 芯片 / 输入框 / 开关 / 分段）并排展示，
 * 便于在不打包 Electron 的情况下直接用浏览器核对观感。
 *
 * 运行：node scripts/build-glass-preview.mjs   （运行后自删亦可）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const htmlSrc = readFileSync(resolve(ROOT, 'src/renderer/index.html'), 'utf8')

// 抽出已注入的整段 <svg id="hc-liquid-glass-defs"> … </svg>
const m = htmlSrc.match(/<svg id="hc-liquid-glass-defs"[\s\S]*?<\/svg>/)
if (!m) {
  console.error('index.html 里没有找到滤镜定义，先跑 scripts/_inject_glass_filter.mjs')
  process.exit(1)
}
const svgDefs = m[0]

const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>液态玻璃预览 — HungerCat Launcher</title>
<style>
:root{
  --accent:#0a84ff;
  --text-primary:rgba(0,0,0,.92);
  --text-secondary:rgba(60,60,67,.68);
  --lg-rim-top:rgba(255,255,255,.86);
  --lg-rim-side:rgba(255,255,255,.34);
  --lg-rim-low:rgba(255,255,255,.08);
  --lg-rim-bottom:rgba(255,255,255,.72);
  --lg-ctl-fill:rgba(255,255,255,.72);
}
*{box-sizing:border-box}
body{
  margin:0;min-height:100vh;display:flex;gap:32px;justify-content:center;align-items:center;
  flex-wrap:wrap;padding:48px;font:14px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
  background:linear-gradient(160deg,#eef1fa 0%,#e8ecf8 45%,#f2f0fb 100%);
}
.dark{
  background:linear-gradient(160deg,#2a0a14 0%,#7a2a1e 50%,#d4762a 100%);
  --text-primary:rgba(248,248,250,.97);--text-secondary:rgba(238,238,247,.74);
  --lg-rim-top:rgba(255,255,255,.44);--lg-rim-side:rgba(255,255,255,.15);
  --lg-rim-low:rgba(255,255,255,.05);--lg-rim-bottom:rgba(255,255,255,.24);
  --lg-ctl-fill:rgba(255,255,255,.14);
}
.col{display:flex;flex-direction:column;gap:18px;align-items:flex-start}
/* 面板 */
.glass{
  width:420px;padding:22px;border-radius:24px;position:relative;
  background:
    linear-gradient(rgba(255,255,255,.10),rgba(255,255,255,.10)) padding-box,
    linear-gradient(180deg,var(--lg-rim-top) 0%,var(--lg-rim-side) 15%,var(--lg-rim-low) 46%,var(--lg-rim-side) 78%,var(--lg-rim-bottom) 100%) border-box;
  border:1px solid transparent;
  backdrop-filter:blur(48px) saturate(180%);
  box-shadow:0 1px 2px rgba(15,23,42,.14),0 12px 28px -14px rgba(15,23,42,.45);
  color:var(--text-primary);
}
.col.dark .glass{
  background:
    linear-gradient(rgba(10,12,20,.46),rgba(10,12,20,.46)) padding-box,
    linear-gradient(180deg,var(--lg-rim-top) 0%,var(--lg-rim-side) 15%,var(--lg-rim-low) 46%,var(--lg-rim-side) 78%,var(--lg-rim-bottom) 100%) border-box;
  backdrop-filter:blur(48px) saturate(190%) brightness(.8);
}
h3{margin:0 0 6px;font-size:15px;letter-spacing:-.01em}
p{margin:0 0 16px;font-size:12.5px;color:var(--text-secondary)}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}

/* 抬起件：近实心白 + 镜边 + 柔和阴影（对齐参考文件的纯白滑块观感） */
.btn,.chip{
  height:38px;padding:0 18px;border-radius:12px;border:1px solid transparent;cursor:pointer;
  font-size:14px;font-weight:600;color:var(--text-primary);
  background:
    linear-gradient(var(--lg-ctl-fill),var(--lg-ctl-fill)) padding-box,
    linear-gradient(180deg,var(--lg-rim-top) 0%,var(--lg-rim-side) 38%,var(--lg-rim-low) 100%) border-box;
  box-shadow:inset 0 1px 1px rgba(255,255,255,.45),0 1px 2px rgba(15,23,42,.12);
}
.chip{height:26px;padding:0 12px;border-radius:999px;font-size:12px;background-color:var(--lg-ctl-fill)}
/* 凹陷件 */
.input{
  height:36px;padding:0 12px;border-radius:10px;border:1px solid rgba(60,60,67,.14);
  background-color:rgba(15,23,42,.055);color:var(--text-primary);outline:none;font-size:14px;
  box-shadow:inset 0 1px 2px rgba(15,23,42,.1),inset 0 -1px 0 rgba(255,255,255,.35);
}
.dark .input{background-color:rgba(0,0,0,.26);box-shadow:inset 0 1px 2px rgba(0,0,0,.4),inset 0 -1px 0 rgba(255,255,255,.07)}

/* 开关：轨道内凹 + 纯白滑块 + 折射 */
.switch{
  position:relative;display:inline-flex;align-items:center;width:48px;height:28px;border-radius:999px;
  border:0;cursor:pointer;padding:0;background:#30d158;
  box-shadow:inset 0 1px 3px rgba(15,23,42,.22),inset 0 -1px 0 rgba(255,255,255,.4);
}
.dark .switch{box-shadow:inset 0 1px 3px rgba(0,0,0,.55),inset 0 -1px 0 rgba(255,255,255,.12)}
.switch i{
  position:absolute;left:23px;width:24px;height:24px;border-radius:999px;
  background-color:rgba(255,255,255,.86);
  backdrop-filter:url(#hc-liquid-glass);
  box-shadow:0 4px 15px rgba(0,0,0,.1),0 1px 3px rgba(0,0,0,.14);
}
.dark .switch i{background-color:rgba(255,255,255,.78);box-shadow:0 4px 15px rgba(0,0,0,.45),0 1px 3px rgba(0,0,0,.5)}
.switch.off{background:rgba(120,120,128,.32)}
.switch.off i{left:2px}

/* 分段：槽 + 折射的选中珠 */
.seg{display:inline-flex;padding:3px;border-radius:999px;
  background:linear-gradient(rgba(255,255,255,.1),rgba(255,255,255,.1)) padding-box,
             linear-gradient(rgba(255,255,255,.34),rgba(255,255,255,.34)) border-box;
  border:1px solid transparent;
  box-shadow:inset 0 1px 2px rgba(15,23,42,.14),inset 0 -1px 0 rgba(255,255,255,.5);
}
.dark .seg{box-shadow:inset 0 1px 2px rgba(0,0,0,.3),inset 0 -1px 0 rgba(255,255,255,.1)}
.seg b{position:relative;padding:5px 16px;border-radius:999px;font-size:12.5px;font-weight:600;color:var(--text-primary);background:rgba(255,255,255,.014)}
.seg b.on{
  background-color:rgba(255,255,255,.014);
  backdrop-filter:url(#hc-liquid-glass);
  box-shadow:inset 0 1px 1px rgba(255,255,255,.55),inset 0 -1px 1px rgba(255,255,255,.35),0 6px 14px -8px rgba(15,23,42,.5);
}
.note{font-size:12px;color:var(--text-secondary);max-width:420px}
</style>
</head>
<body>
${svgDefs}
<div class="col">
  <div class="glass">
    <h3>浅色 · 液态玻璃</h3>
    <p>面板 = 强模糊 + 镜边渐变；控件 = 近实心白 + 镜边 + 柔和阴影。开关与分段选中块带 SVG 折射。</p>
    <div class="row" style="margin-bottom:14px">
      <button class="btn">次级按钮</button>
      <span class="chip">芯片</span>
      <input class="input" style="width:150px" placeholder="输入框" value="可读性">
    </div>
    <div class="row" style="margin-bottom:14px">
      <button class="switch"><i></i></button>
      <button class="switch off"><i></i></button>
      <span class="seg"><b class="on">按架构</b><b>按类型</b></span>
    </div>
    <div class="note">如果开关滑块与分段选中块看不到「边缘折光」，说明浏览器不支持 backdrop-filter: url()（Safari 不支持；Chrome / Electron 支持）。</div>
  </div>
</div>

<div class="col dark">
  <div class="glass">
    <h3>深色 · 液态玻璃</h3>
    <p>深色玻璃是烟色底片（不是加白雾）：先压亮度再提饱和，白字才稳定落在 4.5:1 以上。</p>
    <div class="row" style="margin-bottom:14px">
      <button class="btn">次级按钮</button>
      <span class="chip">芯片</span>
      <input class="input" style="width:150px" placeholder="输入框" value="可读性">
    </div>
    <div class="row">
      <button class="switch"><i></i></button>
      <button class="switch off"><i></i></button>
      <span class="seg"><b class="on">按架构</b><b>按类型</b></span>
    </div>
    <div class="note">背景故意用高饱和日落，用来验证深色玻璃在明亮背景上的可读性。</div>
  </div>
</div>
</body>
</html>
`

mkdirSync(resolve(ROOT, 'docs'), { recursive: true })
writeFileSync(resolve(ROOT, 'docs/liquid-glass-preview.html'), page)
console.log('已生成 docs/liquid-glass-preview.html（' + Math.round(page.length / 1024) + ' KB）')

// ---------------------------------------------------------------------------
// 「模糊玻璃」背景光斑的模糊烘焙。
//
// 为什么需要它：`.blob` 用 `filter: blur(90px)` + transform 漂移动画时，
// Chromium 每一帧都要把 40~52vw 的巨大图层重新模糊一遍（实测模糊玻璃只有
// ~14fps，加 will-change 反而更糟）。把模糊**一次性**画进 canvas、导出成
// 贴图后，元素上不再有 filter，动画只剩合成器位移；漂移再用 steps() 离散化，
// 玻璃面板的 backdrop 重模糊频率从 60 次/秒降到 2 次/秒。
//
// 贴图按元素实际像素宽度换算模糊半径，保证缩放后与 CSS 的 blur(90px) 等效。
// 烘焙失败时保持 data-blob-baked 缺省，CSS 自动回落到原先的 filter 写法。
// ---------------------------------------------------------------------------

/** 贴图边长。模糊本身就是低频信号，256 足够；512 要 3 倍时间（实测 62ms vs 21ms），
    而烘焙发生在首帧之前，越短越不容易让人感到「模糊迟迟不出现」。 */
const SIZE = 256

/** 画布上模糊半径 = CSS 90px 按「贴图 / 元素像素宽」缩放。 */
const CSS_BLUR_PX = 90

/** CSS `radial-gradient(circle, …)` 未指定尺寸时按 farthest-corner 取半径。 */
const FARTHEST_CORNER = Math.SQRT1_2

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** 解析百分比停靠点（"60%" → 0.6），非法值回落默认。 */
function stop(raw: string, fallback: number): number {
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) / 100 : fallback
}

/** 烘焙单个光斑：返回 PNG data URL。 */
function bakeOne(index: number, elementWidth: number): string {
  const c0 = cssVar(`--blob-${index}-c0`) || '#ffffff'
  const c1 = cssVar(`--blob-${index}-c1`) || c0
  const s0 = stop(cssVar(`--blob-${index}-s0`), 0.6)
  const s1 = stop(cssVar(`--blob-${index}-s1`), 0.72)

  const source = document.createElement('canvas')
  source.width = source.height = SIZE
  const sctx = source.getContext('2d')
  if (!sctx) throw new Error('2d context unavailable')

  // 与 CSS 完全一致：圆心在中间，半径取 farthest-corner。
  const radius = SIZE * FARTHEST_CORNER
  const gradient = sctx.createRadialGradient(SIZE / 2, SIZE / 2, 0, SIZE / 2, SIZE / 2, radius)
  gradient.addColorStop(0, c0)
  gradient.addColorStop(Math.min(0.999, s0), c1)
  gradient.addColorStop(Math.min(1, Math.max(s0 + 0.001, s1)), 'rgba(0, 0, 0, 0)')
  sctx.fillStyle = gradient
  sctx.fillRect(0, 0, SIZE, SIZE)

  // 模糊一次性烘焙进贴图。
  const out = document.createElement('canvas')
  out.width = out.height = SIZE
  const octx = out.getContext('2d')
  if (!octx) throw new Error('2d context unavailable')
  const blur = (CSS_BLUR_PX * SIZE) / Math.max(1, elementWidth)
  octx.filter = `blur(${blur.toFixed(2)}px)`
  octx.drawImage(source, 0, 0)

  return out.toDataURL('image/png')
}

/**
 * 预解码 data URL，确保切换烘焙档时贴图已就绪。
 * 否则 `data-blob-baked` 已打开、图片却还没解码完，会出现一瞬间「光斑消失」。
 */
function decodeImage(url: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      if (typeof img.decode === 'function') img.decode().then(() => resolve(), () => resolve())
      else resolve()
    }
    img.onerror = () => resolve()
    img.src = url
  })
}

/**
 * 烘焙当前背景预设下的三个光斑，等贴图解码完成后写入 `--blob-N-img`
 * 并打开 `data-blob-baked` 开关。返回是否成功。
 *
 * 解码之前不打开开关：此时 CSS 仍走 `filter: blur(90px)` 兜底，模糊从第一帧
 * 就在（只是稍重），不会出现「光斑/模糊迟迟不出现」的空窗。
 */
export async function bakeBlobTextures(): Promise<boolean> {
  const root = document.documentElement
  const blobs = [1, 2, 3].map((i) => document.querySelector<HTMLElement>(`.app-background .blob-${i}`))
  // 光斑没渲染（未启用 / 极简模式）时不是错误，保持回落即可。
  if (blobs.some((el) => !el)) return false

  try {
    const urls: string[] = []
    for (let i = 0; i < blobs.length; i++) {
      const width = blobs[i]!.getBoundingClientRect().width
      urls.push(bakeOne(i + 1, width))
    }
    await Promise.all(urls.map((u) => decodeImage(u)))
    urls.forEach((u, i) => root.style.setProperty(`--blob-${i + 1}-img`, `url("${u}")`))
    root.dataset['blobBaked'] = 'on'
    return true
  } catch {
    // 极端环境下（无 canvas / 贴图过大）静默回落，不影响可用性。
    clearBlobTextures()
    return false
  }
}

/** 关掉烘焙档并清掉贴图（切走「模糊玻璃」时调用）。 */
export function clearBlobTextures(): void {
  const root = document.documentElement
  delete root.dataset['blobBaked']
  for (const i of [1, 2, 3]) root.style.removeProperty(`--blob-${i}-img`)
}
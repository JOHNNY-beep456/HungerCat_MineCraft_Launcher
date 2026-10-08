/**
 * 自定义壁纸：把主进程读回的 data URL 转成 Blob 对象地址。
 *
 * 为什么不直接把 data URL 挂到 CSS / <img>：浏览器会把 url(...) 与 src 的值按 URL 解析，
 * 而 Chromium 对解析出的 URL 有长度上限（url::kMaxURLChars ≈ 2MB）。超过上限时该 url()
 * 会被判为无效 —— 大图（base64 后动辄好几 MB）设了却不生效就是这个原因。
 * 改挂一个只有几十字节的 blob: 地址即可绕开长度限制，且不损失画质。
 *
 * 实现用 `fetch(dataUrl)` 交给浏览器解码，避免旧写法里 `atob` + 逐字节 charCodeAt 的
 * 大循环 —— 数 MB 的壁纸会在渲染线程产生明显的同步 CPU 尖峰，拖慢启动首帧。
 */
export async function dataUrlToBlobUrl(dataUrl: string): Promise<string> {
  if (!dataUrl) return ''
  try {
    const res = await fetch(dataUrl)
    const blob = await res.blob()
    return URL.createObjectURL(blob)
  } catch {
    return ''
  }
}

/**
 * 采样壁纸整体色调，判断其偏亮还是偏暗（实验性「背景自适应明暗」用）。
 *
 * 把图片画进 16×16 的小画布再求平均色，用 BT.601 感知亮度判断：< 0.5 视为偏暗。
 * 忽略几乎全透明的像素，避免透明 PNG 被当成纯黑。加载 / 解码失败返回 null。
 */
export function detectWallpaperTone(url: string): Promise<'light' | 'dark' | null> {
  return new Promise((resolve) => {
    if (!url) {
      resolve(null)
      return
    }
    const img = new Image()
    img.onload = () => {
      try {
        const size = 16
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(null)
          return
        }
        ctx.drawImage(img, 0, 0, size, size)
        const { data } = ctx.getImageData(0, 0, size, size)
        let r = 0
        let g = 0
        let b = 0
        let n = 0
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 8) continue
          r += data[i]
          g += data[i + 1]
          b += data[i + 2]
          n += 1
        }
        if (!n) {
          resolve(null)
          return
        }
        const lum = (0.299 * (r / n) + 0.587 * (g / n) + 0.114 * (b / n)) / 255
        resolve(lum < 0.5 ? 'dark' : 'light')
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

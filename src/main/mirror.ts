/**
 * 下载源策略。
 *
 * 始终以 **Mojang 官方源为主**；当官方源缺失（HTTP 404）或缓慢（连接停滞超时）时，
 * 由下载层自动回退到 **BMCLAPI 国内镜像**重试。原先「手动选择镜像源」的设置已移除，
 * 用户无需再关心下载源。
 */

export interface DownloadEndpoints {
  /** 版本清单 URL。 */
  manifest: string
  /** 单个原版版本 JSON 的直连地址（仅 BMCLAPI 提供；官方需经清单定位 entry.url）。 */
  versionJson: (id: string) => string
  /** 资源对象（assets）地址。 */
  assetUrl: (hash: string) => string
  /** Maven 依赖地址，path 形如 com/mojang/foo/1.0/foo-1.0.jar。 */
  libraryUrl: (path: string) => string
  /** piston-data 对象（客户端 jar）地址。 */
  objectUrl: (hash: string) => string
}

/** Mojang 官方源（主用）。 */
export const OFFICIAL: DownloadEndpoints = {
  manifest: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  versionJson: () => '',
  assetUrl: (hash) => `https://resources.download.minecraft.net/${hash.slice(0, 2)}/${hash}`,
  libraryUrl: (path) => `https://libraries.minecraft.net/${path}`,
  objectUrl: (hash) => `https://piston-data.mojang.com/v1/objects/${hash}/client.jar`
}

/** BMCLAPI 国内镜像（官方源缺失 / 缓慢时的回退）。 */
export const BMCLAPI: DownloadEndpoints = {
  manifest: 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json',
  versionJson: (id) => `https://bmclapi2.bangbang93.com/version/${encodeURIComponent(id)}/json`,
  assetUrl: (hash) => `https://bmclapi2.bangbang93.com/assets/${hash}`,
  libraryUrl: (path) => `https://bmclapi2.bangbang93.com/maven/${path}`,
  objectUrl: (hash) => `https://bmclapi2.bangbang93.com/objects/${hash}`
}

/**
 * 把 Mojang 官方下载地址改写为 BMCLAPI 镜像地址；不是已知的官方地址时原样返回。
 * 用于构造「官方主用 + 镜像回退」的候选对。
 */
export function bmclapiUrl(url: string): string {
  if (!url) return url
  if (url.startsWith('https://libraries.minecraft.net/')) {
    return BMCLAPI.libraryUrl(url.slice('https://libraries.minecraft.net/'.length))
  }
  if (url.startsWith('https://resources.download.minecraft.net/')) {
    const hash = url.split('/').filter(Boolean).pop()
    return hash && /^[0-9a-f]{40}$/.test(hash) ? BMCLAPI.assetUrl(hash) : url
  }
  if (url.startsWith('https://piston-data.mojang.com/')) {
    const m = url.match(/([0-9a-f]{40})/)
    return m ? BMCLAPI.objectUrl(m[1]) : url
  }
  return url
}

/** BMCLAPI 的客户端 jar 地址（官方 client.url 失败后的回退）。 */
export function bmclapiClientJarUrl(baseVersion: string): string {
  return `https://bmclapi2.bangbang93.com/version/${encodeURIComponent(baseVersion)}/client`
}

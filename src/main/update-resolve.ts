import type { UpdateInfo } from '@shared/types'

/**
 * 按「便携版 / 安装版」身份挑选对应的更新包，把结果写回 `url` / `filename`。
 *
 * 服务端自 0.6.15 起为每个版本同时保存两组地址：
 *   installerUrl —— 安装版（NSIS 安装包）
 *   portableUrl  —— 便携版（单文件 portable exe）
 *
 * 挑选顺序（以便携版为例）：
 *   1. portableUrl   本类型包，首选
 *   2. installerUrl  回退到另一种
 *   3. url           再回退到旧服务端的唯一字段
 *
 * 为什么允许跨类型回退：历史版本全部只发过安装版包。若「缺本类型就直接判定无更新」，
 * 便携版用户会在补传便携包之前一直收不到更新；跨类型回退保证迁移期间行为与迁移前一致。
 * 后台补传对应包后，用户会自动改走新包，无需客户端升级。
 *
 * 纯函数、不依赖 Electron，便于单测（见 scripts/test-update-resolve.mjs）。
 */
export function resolveUpdateForIdentity(info: UpdateInfo, portable: boolean): UpdateInfo {
  /** 依次取第一个非空地址；文件名跟随所选地址。 */
  const pick = (...candidates: Array<[string | undefined, string | undefined]>) => {
    for (const [u, n] of candidates) {
      if (u && u.trim()) return { url: u.trim(), filename: n?.trim() || undefined }
    }
    return { url: '', filename: undefined }
  }

  const installer: Array<[string | undefined, string | undefined]> = [
    [info.installerUrl, info.installerFilename],
    [info.url, info.filename]
  ]
  const portableCandidates: Array<[string | undefined, string | undefined]> = [
    [info.portableUrl, info.portableFilename]
  ]

  const chosen = portable
    ? pick(...portableCandidates, ...installer)
    : pick(...installer, ...portableCandidates)

  return {
    ...info,
    url: chosen.url,
    filename: chosen.filename
  }
}

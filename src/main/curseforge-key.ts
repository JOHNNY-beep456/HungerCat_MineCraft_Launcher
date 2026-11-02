import { getCurseforgeKey } from './secret'

// 开源仓库不得包含 CurseForge API Key。
// 优先使用本机加密配置，分发环境也可显式注入环境变量。
export function defaultCurseforgeKey(): string {
  return getCurseforgeKey() || process.env.HCMCL_CURSEFORGE_API_KEY?.trim() || ''
}

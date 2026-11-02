import { getCurseforgeKey } from './secret'

declare const __HCMCL_BUNDLED_CURSEFORGE_KEY__: string

// 实际默认值由 electron-vite 从 Git 忽略的本地文件注入主进程构建。
// 用户加密配置优先，其次运行环境覆盖，最后使用分发版自带的 Key。
export function defaultCurseforgeKey(): string {
  const bundled = typeof __HCMCL_BUNDLED_CURSEFORGE_KEY__ === 'string' ? __HCMCL_BUNDLED_CURSEFORGE_KEY__ : ''
  return getCurseforgeKey() || process.env.HCMCL_CURSEFORGE_API_KEY?.trim() || bundled
}

// ---------------------------------------------------------------------------
// 宿主状态映射：把内部数据整理成「脚本可见」的结构。全部为纯函数。
// ---------------------------------------------------------------------------

import type { MinecraftAccount, VersionDir } from '@shared/types'
import { versionDirLabel } from '../../store'
import { yggdrasilOrigin } from '../../components/ui'
import type { VersionDirInfo } from './types'

/** 加载器显示名，与内置页 HomePage 的保持一致：无加载器即「原版」。 */
export function loaderLabel(loader: string | null): string {
  if (!loader) return '原版'
  return loader.charAt(0).toUpperCase() + loader.slice(1)
}

/** 版本目录 → 暴露给脚本的结构（补上展示名 label）。 */
export function toVersionDirInfo(d: VersionDir): VersionDirInfo {
  return {
    id: d.id,
    path: d.path,
    alias: d.alias ?? '',
    label: versionDirLabel(d),
    isDefault: !!d.isDefault
  }
}

/** 推导玩家头像地址（与启动器内头像组件的优先级保持一致）。 */
export function avatarUrl(acc: MinecraftAccount | null): string {
  if (!acc) return ''
  const hash = acc.skinUrl?.match(/([0-9a-f]{64})/i)?.[1]
  if (acc.authType === 'yggdrasil') {
    const origin = yggdrasilOrigin(acc.yggdrasilServer ?? '')
    if (origin) return `${origin}/avatar/player/${encodeURIComponent(acc.name)}`
  }
  if (hash) return `https://textures.minecraft.net/texture/${hash}`
  if (acc.offline) return ''
  return `https://mc-heads.net/avatar/${acc.id}`
}

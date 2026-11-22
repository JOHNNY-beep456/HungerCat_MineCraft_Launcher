import type { TFunction } from './i18n'

/**
 * 把模组安装失败的错误消息转成界面语言文案。
 *
 * Rust 侧兼容性检查返回 `HC_COMPAT|<KIND>|...` 机器可读码（见 src-tauri/src/catalog/install/compatibility.rs），
 * 这里按当前语言翻译；识别不了的错误原样返回（其它安装错误自带文案）。
 *
 * 码格式：
 *   HC_COMPAT|GAME|<实例游戏版本>|<文件支持列表>
 *   HC_COMPAT|LOADER|<实例加载器>|<文件支持列表>
 *   HC_COMPAT|NO_LOADER / METADATA / EVIDENCE
 */
export function formatInstallError(message: string, t: TFunction): string {
  if (!message.startsWith('HC_COMPAT|')) return message
  const parts = message.split('|')
  const kind = parts[1]
  if (kind === 'GAME' && parts.length >= 4) {
    return t('res.compat.game', { instance: parts[2], files: parts[3] })
  }
  if (kind === 'LOADER' && parts.length >= 4) {
    return t('res.compat.loader', { instance: parts[2], files: parts[3] })
  }
  if (kind === 'NO_LOADER') return t('res.compat.noLoader')
  if (kind === 'METADATA') return t('res.compat.metadata')
  if (kind === 'EVIDENCE') return t('res.compat.evidence')
  return message
}

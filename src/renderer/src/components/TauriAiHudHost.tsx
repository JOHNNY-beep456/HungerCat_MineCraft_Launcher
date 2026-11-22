import { TauriAiHud } from './TauriAiHud'

/** 移动端仅展示启动器内卡片，不冒充跨应用或真实游戏覆盖层。 */
export function TauriAiHudHost(): JSX.Element | null {
  if (!('__TAURI_INTERNALS__' in window) || !['android', 'ios'].includes(window.api.platform)) return null
  return <TauriAiHud embedded />
}

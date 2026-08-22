/// <reference types="vite/client" />
import type { LauncherApi } from '@shared/types'

declare global {
  interface Window {
    api: LauncherApi
  }
}

export {}

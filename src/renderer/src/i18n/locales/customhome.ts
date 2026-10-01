import type { LocaleDict } from '../types'

/** 自定义主页宿主（CustomHomePage）界面文案。键名以 `ch.` 前缀。注意：注入沙箱的 SDK 脚本内文案不属于界面文案，不翻译。 */
export const messages: LocaleDict = {
  'zh-CN': {
    'ch.loadFailed': '自定义主页无法加载',
    'ch.loading': '正在载入自定义主页…',
    'ch.frameTitle': '自定义主页',
    'ch.useBuiltin': '使用内置界面'
  },
  'zh-TW': {
    'ch.loadFailed': '自訂主頁無法載入',
    'ch.loading': '正在載入自訂主頁…',
    'ch.frameTitle': '自訂主頁',
    'ch.useBuiltin': '使用內建介面'
  },
  en: {
    'ch.loadFailed': 'Failed to load the custom homepage',
    'ch.loading': 'Loading custom homepage…',
    'ch.frameTitle': 'Custom homepage',
    'ch.useBuiltin': 'Use built-in interface'
  }
}

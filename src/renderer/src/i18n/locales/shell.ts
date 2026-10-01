import type { LocaleDict } from '../types'

/** 应用外壳（App.tsx、router.tsx）文案。键名以 `shell.` 前缀。 */
export const messages: LocaleDict = {
  'zh-CN': {
    'shell.tokenExpired.title': '账户令牌已过期',
    'shell.tokenExpired.subtitle': '无法自动刷新，请重新登录该账号',
    'shell.tokenExpired.later': '稍后处理',
    'shell.tokenExpired.goLogin': '前往登录',
    'shell.lowUsage.title': '已开启超低占用模式',
    'shell.lowUsage.subtitle': '检测到本机配置较低，已自动优化后台占用',
    'shell.lowUsage.detail':
      '窗口最小化或被遮挡时会暂停背景装饰动画、关闭鼠标光晕，并放缓内存与窗口扫描等后台刷新；可见时的动画与界面观感完全不变。如不需要，可在设置中关闭。',
    'shell.lowUsage.confirm': '知道了',
    'shell.lowUsage.goSettings': '前往设置',
    'shell.update.title': '发现新版本 v{n}',
    'shell.update.subtitle': '可在「设置 → 更新」查看更新日志并下载',
    'shell.update.later': '稍后',
    'shell.update.goUpdate': '前往更新',
    'shell.win10.fileExplorer': '文件资源管理器',
    'shell.win10.instanceManage': '实例管理 · {id}',
    'shell.win10.openOnDoubleClick': '{name}（双击打开）',
    'shell.win10.start': '开始',
    'shell.win10.downloadProgress': '下载进度',
    'shell.win10.exitLauncher': '退出启动器',
    'shell.win10.modeNormal': '普通模式'
  },
  'zh-TW': {
    'shell.tokenExpired.title': '帳戶權杖已過期',
    'shell.tokenExpired.subtitle': '無法自動重新整理，請重新登入該帳號',
    'shell.tokenExpired.later': '稍後處理',
    'shell.tokenExpired.goLogin': '前往登入',
    'shell.lowUsage.title': '已開啟超低資源模式',
    'shell.lowUsage.subtitle': '偵測到本機配置較低，已自動最佳化背景資源占用',
    'shell.lowUsage.detail':
      '視窗最小化或被遮擋時會暫停背景裝飾動畫、關閉滑鼠光暈，並放緩記憶體與視窗掃描等背景重新整理；可見時的動畫與介面觀感完全不變。如不需要，可在設定中關閉。',
    'shell.lowUsage.confirm': '知道了',
    'shell.lowUsage.goSettings': '前往設定',
    'shell.update.title': '發現新版本 v{n}',
    'shell.update.subtitle': '可在「設定 → 更新」檢視更新日誌並下載',
    'shell.update.later': '稍後',
    'shell.update.goUpdate': '前往更新',
    'shell.win10.fileExplorer': '檔案總管',
    'shell.win10.instanceManage': '實例管理 · {id}',
    'shell.win10.openOnDoubleClick': '{name}（連按兩下開啟）',
    'shell.win10.start': '開始',
    'shell.win10.downloadProgress': '下載進度',
    'shell.win10.exitLauncher': '結束啟動器',
    'shell.win10.modeNormal': '一般模式'
  },
  en: {
    'shell.tokenExpired.title': 'Account token expired',
    'shell.tokenExpired.subtitle': 'Could not refresh automatically. Please sign in to this account again.',
    'shell.tokenExpired.later': 'Later',
    'shell.tokenExpired.goLogin': 'Go to sign-in',
    'shell.lowUsage.title': 'Low-usage mode enabled',
    'shell.lowUsage.subtitle': 'This device looks low-spec, so background usage was optimized automatically',
    'shell.lowUsage.detail':
      "When the window is minimized or covered, background decoration animations pause, the cursor glow turns off, and background refreshes such as memory and window scanning slow down; animations and visuals are unchanged while visible. You can turn this off in Settings if you don't need it.",
    'shell.lowUsage.confirm': 'Got it',
    'shell.lowUsage.goSettings': 'Go to Settings',
    'shell.update.title': 'New version v{n} available',
    'shell.update.subtitle': 'View the changelog and download it in Settings → Update',
    'shell.update.later': 'Later',
    'shell.update.goUpdate': 'Go to update',
    'shell.win10.fileExplorer': 'File Explorer',
    'shell.win10.instanceManage': 'Instance management · {id}',
    'shell.win10.openOnDoubleClick': '{name} (double-click to open)',
    'shell.win10.start': 'Start',
    'shell.win10.downloadProgress': 'Download progress',
    'shell.win10.exitLauncher': 'Quit launcher',
    'shell.win10.modeNormal': 'Normal mode'
  }
}

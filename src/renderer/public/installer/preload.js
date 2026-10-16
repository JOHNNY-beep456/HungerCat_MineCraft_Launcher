'use strict'

/** 安装器预加载：仅暴露安装所需的少量接口。 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('installer', {
  /** 基本信息：应用名、版本、默认目录、载荷是否就绪。 */
  info: () => ipcRenderer.invoke('installer:info'),
  /** 打开系统目录选择框，返回所选目录或 null。 */
  chooseDir: () => ipcRenderer.invoke('installer:chooseDir'),
  /** 开始安装；opts = { dir, desktopShortcut, startMenuShortcut }。 */
  start: (opts) => ipcRenderer.invoke('installer:start', opts),
  /** 取消进行中的安装。 */
  cancel: () => ipcRenderer.invoke('installer:cancel'),
  /** 启动已安装的启动器。 */
  launch: (exePath) => ipcRenderer.invoke('installer:launch', exePath),
  /** 在资源管理器中打开目录。 */
  openFolder: (dir) => ipcRenderer.invoke('installer:openFolder', dir),
  /** 最小化窗口。 */
  minimize: () => ipcRenderer.invoke('installer:minimize'),
  /** 退出安装器。 */
  quit: () => ipcRenderer.invoke('installer:quit'),
  /** 订阅进度事件（phase / percent / detail）。返回取消订阅函数。 */
  onProgress: (cb) => {
    const listener = (_e, payload) => cb(payload)
    ipcRenderer.on('installer:progress', listener)
    return () => ipcRenderer.removeListener('installer:progress', listener)
  }
})

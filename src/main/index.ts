/**
 * 主进程入口 —— 直接启动启动器。
 *
 * `portable.exe` 现在就是启动器自身（electron-builder 的 portable 目标）。
 * 安装模式已移除，直接以启动器身份运行。
 *
 * 便携版的数据目录重定向必须在这里、且在任何业务模块加载之前完成：
 * 一旦有模块读过 app.getPath('userData')，再改就晚了。
 */
import { applyPortablePaths } from './portable'

applyPortablePaths()

void import('./app')

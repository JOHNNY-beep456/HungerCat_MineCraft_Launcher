/**
 * 主进程入口 —— 直接启动启动器。
 *
 * `Setup.exe` 现在就是启动器自身（electron-builder 的 portable 目标）。
 * 安装模式已移除，直接以启动器身份运行。
 */
void import('./app')
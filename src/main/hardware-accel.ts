import { app } from 'electron'

/**
 * 硬件加速开关（实验性设置 `hardwareAcceleration`）。
 *
 * 这是**进程级**开关：Chromium 只允许在 app ready 之前决定是否启用
 * （`app.disableHardwareAcceleration()` 在 ready 之后调用不再生效），
 * 所以启动时读一次设置，之后修改必须重启启动器才生效。
 *
 * 默认关闭是面向低端集显 / 虚拟机 / 远程桌面的保守选择。关掉 GPU 时
 * Windows 上仍会保留一个做软件合成的 GPU 进程（实测约 110MB），但渲染转到 CPU，
 * 能省显存并降低显卡驱动相关的崩溃；代价是 `backdrop-filter`（模糊玻璃）这类
 * 特效会明显掉帧。
 */

/** 本次进程实际使用的值；设置页据此判断「改完是否已经重启生效」。 */
let bootedValue = false

/** 在 app ready 之前调用一次：按设置决定是否启用硬件加速。 */
export function applyHardwareAcceleration(enabled: boolean): void {
  bootedValue = enabled
  if (enabled) return
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
}

/** 本次进程启动时实际使用的值（不是设置里当前的值）。 */
export function hardwareAccelerationBooted(): boolean {
  return bootedValue
}

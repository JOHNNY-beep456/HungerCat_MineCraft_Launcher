/**
 * 主进程入口 —— 只做一件事：**判断这次是启动器还是安装器**。
 *
 * 背景：`Setup.exe` 现在**就是启动器自身**。以前安装器是另一个 Electron 应用，
 * 把打包好的启动器当载荷塞进 `extraResources`，于是安装包里有**两份** Electron
 * 运行时（约 2 × 268 MB 未压缩）。合并之后只剩一份，安装包体积因此大减。
 *
 * 判定用环境变量而非命令行参数：自动更新走 `runUpdate()`（server.ts），
 * 那里是 `spawn(exePath, [])` —— 不带参数地拉起下载下来的 Setup.exe，
 * 靠参数判定会在「更新后点安装」时直接进入正常界面，装机流程当场断掉。
 *
 * 两个分支都用**动态 import**：安装模式不加载 ./app 及其依赖，启动模式同理
 * 不加载 ./installer。这样两条路都只初始化自己需要的东西。
 * 动态 import 在当前脚本的微任务里完成，远早于 Electron 的 ready 事件，
 * 因此 ./app 里 `app.commandLine.appendSwitch(...)` 仍然来得及在 ready 之前生效。
 */
import { isInstallerMode } from './installer/detect'

if (isInstallerMode()) {
  void import('./installer').then((m) => m.runInstallerMode())
} else {
  void import('./app')
}
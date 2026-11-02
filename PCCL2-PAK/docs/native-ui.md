# PCCL2 原生 Windows 界面

本组件使用 .NET 8 WPF 的 XAML 控件（Window、Button、ComboBox、ListBox、TextBox、ProgressBar），不依赖 WebView。账户认证、Minecraft 启动、资源搜索和下载仍由 Electron 后端完成。原生组件不接收访问令牌、不读写启动器凭据。

## 构建

```powershell
dotnet build PCCL2-PAK/src/PCCL2.Native.csproj -c Release
./PCCL2-PAK/build.ps1 -FrameworkDependent
./PCCL2-PAK/build.ps1
```

默认发布 win-x64 自包含单文件，可作为 Windows 下载组件分发；构建输出位于 `src/artifacts/win-x64/`。框架依赖模式需要 .NET 8 Windows Desktop Runtime。构建不要求修改系统证书、网络代理或权限策略。源码、构建中间文件与发布产物均限制在 PCCL2-PAK 范围内。

## 进程协议

宿主通过重定向 stdin/stdout 启动 `PCCL2.Native.exe --bridge-stdio`。UTF-8、每行一个 JSON；stdout 只发送请求，stderr 仅输出不含响应正文的诊断标签。

```json
{"id":"唯一字符串","method":"state.get","params":null}
{"id":"相同字符串","result":{}}
{"id":"相同字符串","error":"可向用户显示的错误"}
{"event":"progress","data":{"taskId":"任务标识","message":"正在下载","progress":0.5}}
```

请求以并发映射表关联响应；默认 30 秒超时，清单 60 秒、搜索 90 秒、启动 300 秒、版本安装 3600 秒、资源安装 1800 秒。所有失败显示在底部状态区，下载取消请求可与安装并行。正常关闭先请求 `shell.restore`，最多等待 3 秒退出；stdin EOF 直接退出，不终止宿主。Loaded 后发送一次 `ui.ready`，成功后请求 `state.get`。

所用方法：`ui.ready`、`state.get`、`versions.manifest`、`versions.install`、`launch`、`launch.stop`、`accounts.select`、`settings.set`、`shell.restore`、`downloads.cancel`、`resources.search`、`resources.versions`、`resources.install`、`instances.manage`、`accounts.manage`。

- `state.get`：`settings`、`accounts`、`installed`、`versionDirs`。账户选择优先顶层 `selectedAccountId`，再取设置同名字段或 `activeAccountId`。`installed` 条目使用 `id`、`loader`。
- 版本清单支持数组或 `{versions:[]}`；版本使用 `id`、`type`。
- 搜索支持数组或 `{hits:[]}`；资源标识依次支持 `projectId`、`project_id`、`slug`、`id`，显示 `title/name` 与 `description`。分页使用 `offset`。
- 资源版本支持数组或 `{versions:[]}`，使用 `id` 与 `name/version_number`。
- 进度支持 `message/status/phase`、`percent`（0–100）或 `progress`（0–1），以及 `taskId/id`。
- 设置仅提交 `memoryMb`（512–65536 整数）、`downloadSource`、`language`；语言支持简体中文、繁體中文、English。
- 账户、实例高级管理在宿主完整界面中打开。

## 布局与可访问性

蓝色顶栏包含启动、下载、设置、更多；启动页左栏为账户头像、账户与版本选择、启动/停止按钮，右侧保持空白淡彩渐变。所有操作使用原生键盘焦点与控件自动化名称，资源搜索支持 Enter；版本和资源列表可通过方向键选择。窗口支持系统标题栏、缩放和最小尺寸。头像只使用后端提供的 HTTPS 皮肤地址，并截取原皮肤脸部，不把 UUID 发送给第三方头像服务。

## 本次验证

.NET SDK 8.0.422，Windows Desktop Runtime 8.0.28。Release build、win-x64 framework-dependent publish、win-x64 self-contained single-file publish 均实际成功。`node PCCL2-PAK/src/bridge-smoke.mjs` 实际启动 WPF 进程，验证 Loaded 握手一次、stdout JSON、状态加载、进度输入及 stdin EOF 后退出码 0。

未验证：与真实 Electron 后端的端到端账户切换、Minecraft 启动、在线安装，以及参考截图的像素级匹配。模拟桥接证明原生进程可加载并通信，不代表网络下载与游戏启动已经实测。

# PCCL2 Native Windows 组件（0.7.5-alpha3）

这是 **Windows x64 按需下载**的完整原版 VB/WPF 前端组件。它不是 Electron 内置主题，也不是 PCL 官方发行版。

## 你要上传的文件

请将以下三个文件上传至**同一 HTTPS 目录**：

1. `PCCL2-0.7.5-alpha3-win-x64.zip` — 改造后的 VB/WPF 原生组件，附带官方 **.NET Framework 4.8 离线安装程序**；它不是免安装的自包含 CLR。系统已有 4.8 时直接使用，缺少时由宿主检测并执行安装。
2. `manifest.json` — 组件版本、平台、入口、大小及 SHA-256。
3. `SHA256SUMS.txt` — 供你人工复核包哈希（清单也包含它）。

启动器设置中的 **PCCL2 原生组件清单 HTTPS 地址**应填写为：

```text
https://你的域名/你的目录/manifest.json
```

清单内的 `url` 使用相对地址 `./PCCL2-0.7.5-alpha3-win-x64.zip`，因此三个文件必须同目录。请允许 HTTPS 访问该目录和 ZIP，不要把它们放到需要浏览器登录才能下载的位置。

## 使用行为

- 首次选择原生组件时，启动器联网获取清单并下载组件；验证 SHA-256 后安装到用户数据目录 `components/pccl2/`。
- 安装后可离线打开，不必每次重新下载。
- 更新时重新获取清单；版本相同也会校验当前清单和安装状态。
- 关闭原生窗口或选择“返回完整启动器”，Electron 界面会恢复。
- 其他系统显示 PCCL2 入口但禁用；本组件只支持 Windows x64。
- 原生 UI 使用完整上游 VB/WPF 主窗口、页面、控件、导航和动画；窗口标题为 `PCL-HCMCL`，已移除开源版首次说明弹窗。账号、下载与实例相关服务沿用宿主配置。

## HCMCL 操作与社区资源

- 启动页使用 HCMCL 账号和实例；选择账号只保存选择，不会启动游戏。
- 实例页点击“启动”先返回“启动”页，再调用 HCMCL 启动服务并显示依赖下载、启动及错误流程。
- 首次打开显示“本组件基于PCL2开源代码编写，以遵循其协议”，确认后记录已读状态。
- 社区资源元数据按 Modrinth / CurseForge 原始 API 格式透传，搜索不再被误识别成项目详情。
- CurseForge Key 不包含在公开源码中；可在资源搜索页的密码输入框安全保存到本机加密存储，或用 `HCMCL_CURSEFORGE_API_KEY` 环境变量配置。Modrinth 无需 Key。
- `tools/`、`runtime/`、编译缓存和构建产物不进入 Git。构建需要 .NET SDK（依赖库）和包含 .NET Framework 4.8 开发工具的桌面 MSBuild；发布组件时另行准备微软官方离线运行时安装程序。

## 来源与署名

原生 UI 的 XAML、导航矢量、颜色和部分标准控件模板直接取自 **龙腾猫跃 / Meloong-Git 的 PCL**：

- 仓库：https://github.com/Meloong-Git/PCL
- 固定提交：`93ede5d9e638c99fcec853a9ba1eecd91ceee7f5`
- 原始许可：[reference/upstream/LICENCE](reference/upstream/LICENCE)
- 精确复用与适配范围：[reference/STYLE-SOURCES.md](reference/STYLE-SOURCES.md)

用户已声明取得原作者同意；我未独立核验授权文件或范围。包中包含原生 EXE 和微软官方 .NET Framework 4.8 离线安装程序，不含账号令牌。参考源码、许可原文与构建脚本留在本目录供审查。

## 本轮修复

- 组件同时发送 `ui.ready` RPC 帧及事件帧：兼容已发布旧宿主与修复后的新宿主。
- 旧宿主模拟使用真实 WPF 进程验证，握手完成后持续运行 32 秒，无 readiness timeout 导致的退出。
- 账号、任务、实例为读取 HCMCL 数据的独立原生页面，按钮复用上游 `MyButton`。
- 开屏改用 HCMCL 图标，并将原 1024×1024 图像的宽高缩至 10%，内嵌资源为 102×102；窗口与任务栏仍用完整 HCMCL ICO。

## 构建与校验

在本目录执行：

```powershell
./build.ps1
node package.mjs
```

发布产物为 `src/artifacts/win-x64/PCCL2.Native.exe`。`package.mjs` 以普通 ZIP32 / deflate 打包，不附加注释或扩展字段，并重新生成清单与 SHA-256。

## 验证边界

WPF 构建和真实进程握手已验证；包下载、ZIP 安全与桥接运行测试在 Node 中验证。真实 Electron 安装/启动、线上 HTTPS 下载及 Minecraft 实际启动需要部署清单后验证。样式不是完整复制整个 PCL 核心或其业务模块，具体差异见来源映射文档。

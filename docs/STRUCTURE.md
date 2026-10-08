# 目录结构与板块职责

## 顶层

| 路径 | 说明 |
| --- | --- |
| `src/main/` | 主进程（后端 / 编排） |
| `src/preload/` | 唯一的 IPC 桥，暴露 `window.api` |
| `src/renderer/` | 渲染进程（React 界面） |
| `src/shared/` | 主进程 / preload / 渲染层三方共享的契约与纯逻辑 |
| `native/downloader/` | Rust 原生下载内核（napi-rs） |
| `scripts/` | 构建脚本（原生内核、EasyTier 二进制准备等） |
| `server/` | PHP 服务端 —— **不纳入版本控制，不要提交** |
| `docs/` | 本开发文档 |

## 主进程

### `src/main/index.ts` — 组合根

只保留：应用/窗口生命周期、窗口创建（主窗 / 调试窗 / 迷你窗 / 开发窗 / HUD / 弹幕）、
托盘、模块级共享状态、IPC 统一插桩（`wrapIpc`）、以及把各域处理器装配起来。
**业务逻辑一律不写在这里。**

### `src/main/handlers/` — IPC 处理器（按域拆分）

共 145 个 IPC 频道，`context.ts` 提供处理器与组合根之间的共享上下文（窗口取值/赋值函数、
共享动作函数），其余 13 个文件按域注册：

| 文件 | 频道数 | 职责 |
| --- | --- | --- |
| `auth.ts` | 3 | 微软设备代码流：登录 / 取消 / 刷新 |
| `accounts.ts` | 9 | 账号列表 / 选择 / 增删，以及第三方（Yggdrasil）账号与皮肤 |
| `versions.ts` | 19 | 版本清单 / 实例列表 / 版本目录 / 加载器（Fabric、Forge）/ 下载安装 |
| `mods.ts` | 24 | Modrinth 搜索安装、整合包导入导出、资源包与光影、实例文件管理 |
| `java.ts` | 4 | Java 运行时检测 / 适配检查 / 自动安装 / 手动指定 |
| `launch.ts` | 2 | 启动游戏（预下载 / Java 选择 / 窗口尺寸）与停止 |
| `settings.ts` | 9 | 应用设置 / 应用版本 / 主显示器 / 系统内存硬件 / 自定义壁纸 |
| `homepage.ts` | 22 | 自定义主页管理 / 市场 / 投稿，以及用户反馈与服务端限制 |
| `network.ts` | 12 | 关于 / 协议 / 公告 / 更新、翻译、Minecraft 玩家与服务器信息 |
| `debug.ts` | 15 | 日志窗口与日志上传、开发模式（开发工具窗 / 原生 DevTools / 授权） |
| `window.ts` | 8 | 最小化 / 最大化 / 关闭 / 全屏 / 置顶 / 桌面外壳 / 安全拦截强制全屏 |
| `files.ts` | 13 | 自实现资源管理器，以及系统 Shell（打开外链 / 目录 / 文件选择框） |
| `multiplayer.ts` | 5 | 联机悬浮窗：大厅迷你窗的打开 / 关闭 / 快照 / 主窗口探测 / 尺寸调整 |
| `context.ts` | — | `IpcContext` 定义（不是处理器） |

> 另有 `src/main/multiplayer/index.ts` 自行注册 37 个联机频道（历史原因，未并入 handlers）。

### `src/main/*.ts` — 业务模块

| 模块 | 职责 |
| --- | --- |
| `broker.ts` | 网络进程代理：`utilityProcess.fork` + MessagePort + `netRequest()` |
| `store.ts` | 应用设置的读写与持久化 |
| `logger.ts` | 滚动日志缓冲（供调试窗口 / 上报） |
| `local-timeout.ts` | 本地操作看门狗（不作用于网络请求） |
| `ipc-cache.ts` | 高频、重复的读取通道的结果缓存 + 并发去抖 |
| `secret.ts` | 敏感信息（密钥等）的加密存储 |
| `mirror.ts` | 下载源策略：多源有序候选 + 自动回退 |
| `network-profile.ts` | 下载加速档位 → 实际并发参数（单文件连接数 / 文件并发数） |
| `native-downloader.ts` | 原生下载内核的加载与调用（可选依赖，失败自动回退） |
| `stream-download.ts` | stream 下载代理（转发到网络进程，公开签名与旧实现一致） |
| `transfer-util.ts` | 下载编排共享工具：worker 池 + 速度统计与节流上报 |
| `downloader.ts` | 版本安装编排：解析 JSON、算缺失文件、SHA-1 校验、进度 |
| `versions.ts` / `installed.ts` | 版本清单与 JSON / 已安装实例扫描与 `servers.dat` 读写 |
| `import-version.ts` | 从外部 `.minecraft` 导入版本（重名策略） |
| `loaders.ts` / `forge.ts` | Fabric、Quilt 安装 / Forge、NeoForge 安装器 |
| `java.ts` | Java 运行时检测、版本适配与自动安装 |
| `launcher.ts` | 启动游戏编排（命令行、日志回流） |
| `manage.ts` / `resources.ts` / `resource-updates.ts` | 实例文件管理 / 资源包与光影 / 更新检测 |
| `modrinth.ts` / `curseforge.ts` / `curseforge-key.ts` / `sources.ts` | 资源来源编排（Modrinth 优先，CurseForge 补充） |
| `mcmod.ts` / `mcmod-util.ts` | MC百科中文译名（网络编排 / 纯计算，后者可脱离 Electron 单测） |
| `modpack.ts` / `archive.ts` | 整合包导入导出 / 内嵌压缩包读写（zip、tar、tar.gz） |
| `homepage.ts` / `homepage-analyzer.ts` | 自定义主页管理 / 安装与读取时的静态安全检测 |
| `feedback.ts` / `debug-report.ts` | 用户反馈 / 调试日志上报 |
| `devmode.ts` | 开发模式授权 |
| `auth.ts` / `yggdrasil.ts` | 微软 OAuth / 第三方认证编排 |
| `server.ts` | 服务端 JSON 请求编排与更新文件下载 |
| `files.ts` | 文件系统基础操作 |
| `wallpaper.ts` | 自定义壁纸的选图、存放与读取 |

### `src/main/network/` — 网络进程

| 模块 | 职责 |
| --- | --- |
| `index.ts` | 网络进程入口（`process.parentPort` 收发） |
| `stream-download.ts` | 传输层：分块下载、10s 停滞看门狗、取消 |
| `minecraft.ts` | 玩家信息与服务器状态（uapis.cn，必要时退回 TCP SLP 补 MOTD） |
| `translate.ts` | 在线翻译（多接口自动回退） |

### `src/main/multiplayer/` — 联机

| 模块 | 职责 |
| --- | --- |
| `index.ts` | 联机 IPC 与编排 |
| `easytier.ts` | EasyTier 组网（虚拟网络） |
| `lan-bridge.ts` | 局域网桥：TCP 代理 + 组播公告（解决「看得到名字却连不上」） |
| `lobby.ts` / `signaling.ts` / `resources.ts` | 大厅 / P2P 信令 / 联机资源 |
| `voice-relay.ts` | 语音中继（走 EasyTier UDP 端口转发，不用 WebRTC） |

## 渲染层

### `src/renderer/src/pages/`

页面级组件。**超大页面已按板块拆成子目录**，根文件只做组合：

| 目录 / 文件 | 说明 |
| --- | --- |
| `settings/` | 设置页各板块：`AutoSection.tsx`（注册表驱动的自动渲染 + `AutoFields`）、`rows.tsx`（自定义行组件 `CUSTOM_ROWS`）、`parts.tsx`（外壳原语）、`*Section.tsx`（板块声明，多为一行 `<AutoSection/>`）。除 `DeveloperSection`（服务端授权流程）外均由注册表驱动，见 [SETTINGS.md](./SETTINGS.md) |
| `customhome/` | 自定义主页：`sdk.ts`（注入的 SDK）、`bridge.ts`（postMessage 分发）、`security.ts`（CSP 与三档处置）、`data.ts`（宿主状态）、`sandbox.ts`、`frame.tsx` |
| `instance-manage/` | 实例管理各板块：`ModsPanel`、`ResourcesPanel`、`SavesPanel`、`SchematicsPanel`、`VersionPanel`、`OnlineInstaller`、`ModDetailSheet`… |
| 其余 `*Page.tsx` | 单文件页面（`HomePage`、`InstancesPage`、`VersionsPage`、`AccountsPage`、`MultiplayerPage`、`ResourceDownloadPage`、`HomepagePage`、`FeedbackPage`、`AboutPage`、`DownloadsPage`、`ExportPage`） |
| `router.tsx` | 页面路由表 |

### `src/renderer/src/components/`

通用组件：`ui.tsx`（基础控件）、`Sidebar.tsx`（侧栏 + 顶栏导航）、`TitleBar.tsx`、
各类弹窗（`AgreementModal`、`AnnouncementModal`、`OnboardingModal`、`JavaPrompt`…）、
`FileManager.tsx`（自实现资源管理器）、`PlayerModel3D.tsx`、`Win10Desktop.tsx`（桌面模式）、
联机相关（`MultiplayerSession`、`MultiplayerChat`、`VoiceControls`…）、
调试窗口（`DebugLogWindow`、`DevToolsWindow`）、`CursorGlow` / `DownloadOrb` 等装饰。

### `src/renderer/src/i18n/`

`index.ts`（自动发现 + 组装）、`types.ts`（基础类型）、`locales/<语言>/{meta.json,<板块>.json}`。
规范见 [I18N.md](./I18N.md)。

### `src/renderer/src/` 顶层模块

| 模块 | 职责 |
| --- | --- |
| `App.tsx` / `main.tsx` / `mini-bootstrap.tsx` | 应用外壳 / 入口 / 迷你窗入口 |
| `store.tsx` / `runtime.tsx` | 全局状态 / 运行时状态 |
| `startup.ts` | `runWhenIdle`：把非首屏工作推迟到空闲帧 |
| `cursor.ts` | 鼠标位置总线（供 iframe 沙箱回传后驱动光晕） |
| `wallpaper.ts` | data URL → blob: 地址（绕开 Chromium URL 长度上限） |
| `lang-detect.ts` | 轻量语言检测（避免把中文翻成中文） |
| `markdown-translate.ts` | Markdown 感知翻译（保护语法结构） |
| `mod-title.ts` | Mod 标题样式映射（原名 / 译名） |
| `launch-diagnosis.ts` | 启动异常诊断（一句话结论 + 最关键的一条错误） |
| `announcement.ts` | 公告筛选（展示范围 / 时机，纯逻辑可单测） |
| `translate.ts` / `translate-status.ts` | 翻译编排与状态 |
| `multiplayer/` | 语音采集/播放、变声、音效 |

## 共享层 `src/shared/`

| 模块 | 职责 |
| --- | --- |
| `types.ts` | **跨进程类型契约**，含 `LauncherApi`（渲染层 API 的唯一真相） |
| `settings.ts` | **设置注册表**：默认值 + 可选 UI 元数据（主进程 / 渲染层共用，见 [SETTINGS.md](./SETTINGS.md)） |
| `net-protocol.ts` | 主进程 ↔ 网络进程的消息协议 |
| `homepage-runtime.ts` | 主页脚本危险代码规则表（主进程静态检测与渲染层运行时检测共用） |
| `srcdoc.ts` | 沙箱 iframe 的 CSP / SDK 注入点 |

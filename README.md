# 本项目不接受PR！！！

# HungerCat MineCraft Launcher

跨 **Windows / macOS** 的 Minecraft Java 版启动器，功能对标 **现有开源启动器**，界面采用 **Apple Design** 风格，微软登录使用**免申请的 OAuth 设备代码流**。

---

## 当前版本：0.7.6-dev1

- 新增 **PCL2 主题**：蓝色顶栏、白色侧栏、浅蓝渐变背景、小圆角卡片与描边控件，支持浅色和深色模式。可在「设置」的皮肤主题选项中切换。
- 主题复用现有 Electron / React 页面和 HCMCL 业务接口，保留账号、下载、实例管理、内存调节及启动功能；导航位置仍遵循用户设置。
- 修复启动面板中长版本名称挤压按钮的问题，版本选择与管理操作支持窄面板布局。
- 移除旧 PCCL2 原生组件、组件安装入口和专用桥接接口；当前 PCL2 主题无需安装 WPF 组件或 .NET Framework。
- 已生成 Windows x64 安装版与便携版：`HCMCL0.7.6-dev1-win-x64-setup.exe`、`HCMCL0.7.6-dev1-win-x64-portable.exe`。本地产物位于 `release/`，不随源码提交；公开发布以 [Releases](https://github.com/JOHNNY-beep456/HungerCat_MineCraft_Launcher/releases) 中实际上传的文件为准。

本版本类型检查、生产构建、12 项自动回归脚本及 Windows 产物完整性检查通过。本机 Electron 存在启动即退出的环境限制，最新主题的实机外观、安装包安装和启动效果尚未验证；Windows 产物未签名。

## 功能特性

| 模块 | 说明 |
| --- | --- |
| 🪟 跨平台 | Electron + electron-builder，同时输出 Windows `nsis` 与 macOS `dmg` |
| 🎨 Apple Design | 液态玻璃材质、圆角、弹簧动画、动态渐变壁纸、浅色/深色/跟随系统主题 |
| 🔐 微软登录 | **设备代码流**，使用公共 client_id |
| 🌐 第三方登录 | Yggdrasil 外置登录（LittleSkin 等），支持自定义认证服务器地址 |
| 👤 账号管理 | 多账号、皮肤/披风展示、令牌自动刷新、账号切换；第三方账号头像经 LittleSkin 官方头像接口正确显示 |
| 💾 内存管理 | 已用内存 **每 30 秒动态刷新**；为游戏预留的内存自动 **不超过剩余可用内存** |
| 📦 版本管理 | Mojang 版本清单、版本列表/搜索/筛选、正式版与快照 |
| ⬇️ 下载引擎 | 资源/库文件并发下载、SHA1 校验、断点跳过、BMCLAPI 国内镜像 |
| ☕ Java 运行时 | 自动检测（JAVA_HOME/常见安装目录）、按版本主版本号匹配 |
| 🚀 启动引擎 | 自动构建 JVM 参数、子进程启动、实时日志、内存分配 |
| 🧩 版本隔离 | 每个版本独立的 saves/mods/config 目录（PCL 同款） |
| 🧵 加载器安装 | Fabric / Quilt 走官方 meta 接口免安装器；Forge / NeoForge 运行官方安装器一键安装 |
| 🛠 模组管理 | Modrinth（暂不支持 CurseForge）搜索、按版本/加载器匹配、一键安装到 mods 目录 |
| 📦 整合包导入/导出 | 导入 Fabric/Quilt 整合；导出支持勾选游戏设置、模组配置、服务器列表、存档、资源包、TACZ 枪支包、禁用模组、原理图 |
| 🎒 资源包 / 光影 | 资源包与光影的在线获取（Modrinth）+ 已安装列表管理、一键打开目录 |
| 🕹️ 离线模式 | 免账号离线登录（仅单机），离线 UUID 生成，与正版账号并存 |
| 🚀 国内加速 | 下载镜像可在设置中切换：Mojang 官方 / BMCLAPI 国内镜像（资源、库、客户端 jar 全覆盖） |
| ⚙️ 设置 | 主题、内存、镜像、并发数、Java 路径、游戏目录等持久化 |
| 🎵 网易云歌词浮层 | 实验性（默认关闭）：读取系统媒体会话里网易云音乐的「正在播放」，在游戏内 HUD 浮层上逐句显示歌词（仅 Windows；歌词经网易云接口实时获取） |

## 技术栈

- **桌面框架**：Electron 33（主进程 Node.js 负责下载/校验/启动）
- **构建**：electron-vite（Vite 5 + TypeScript）
- **界面**：React 18 + Tailwind CSS 4 + `motion`（弹簧动画）
- **打包**：electron-builder
- **第三方认证**：Yggdrasil API + authlib-injector（自动下载并注入 JVM 参数）
- **头像服务**：LittleSkin 官方头像接口 `littleskin.cn/avatar/player/{name}`（含皮肤纹理裁切兜底）

## 目录结构

```
src/
├── main/                 # 主进程（后端 / 编排）
│   ├── index.ts          # 组合根：窗口、生命周期、托盘、IPC 插桩
│   ├── handlers/         # IPC 处理器（按域拆分：versions / mods / homepage / window …）
│   ├── network/          # 网络进程（utilityProcess）：专职网络 IO
│   ├── multiplayer/      # 联机（EasyTier / 大厅 / 信令 / 语音中继）
│   ├── netease/          # 网易云歌词浮层（系统媒体会话采样 + 歌词接口 + 逐句同步）
│   ├── ai/               # AI 助手（对话编排 / 工具授权 / 悬浮球）
│   ├── downloader.ts     # 下载引擎（资源/库/客户端/SHA1）
│   ├── launcher.ts       # JVM 参数构建 + 子进程启动
│   ├── store.ts          # 设置/账号持久化
│   └── …                 # auth / yggdrasil / versions / loaders / forge / modrinth /
│                         # modpack / manage / resources / server / mirror / wallpaper …
├── preload/index.ts      # contextBridge 安全桥接（window.api）
├── shared/               # 跨进程契约（types.ts 的 LauncherApi、net-protocol.ts …）
└── renderer/             # 渲染进程（React）
    └── src/
        ├── components/   # 通用组件与弹窗
        ├── pages/        # 页面（settings / customhome / instance-manage 已按板块拆目录）
        ├── i18n/         # 多语言（locales/<语言>/<板块>.json）
        ├── store.tsx     # 设置/账号/内存状态
        ├── runtime.tsx   # 下载/启动运行状态
        └── assets/       # logo 等静态资源
```

> 架构、各板块职责、i18n 规范与构建调试流程详见 [docs/](./docs/README.md)。

## 开发与构建

```bash
# 安装依赖
npm install

# 开发模式（热更新）
npm run dev

# 运行已构建的产物
npm run start

# 类型检查
npm run typecheck

# 构建产物到 out/
npm run build

# Windows x64：原生下载器、EasyTier、安装版和便携版
node scripts/build-all.mjs --platform win --arch x64

# 已安装依赖时可跳过安装步骤
node scripts/build-all.mjs --platform win --arch x64 --skip-install

# Windows 全架构（arm64 原生下载器不可用时降级为 TS 下载器）
node scripts/build-all.mjs --platform win --arch all

# 仅对当前构建环境执行 Electron 打包
npm run dist:win

# 自动回归（不包含需真实媒体会话的 SMTC live 检查）
node scripts/verify-publication.mjs

# 检查 Windows 产物完整性标签
node scripts/fix-artifact-integrity.mjs --check
```

> 项目已内置 `.npmrc`，Electron 与 electron-builder 二进制默认从
> **npmmirror 国内镜像**（`npmmirror.com/mirrors/`）下载，无需直连 GitHub。
> 若仍处于 TLS 拦截代理环境导致证书校验失败，可再设置
> `$env:NODE_OPTIONS="--use-system-ca"` 后重新 `npm install`。

Windows 打包所需的 NSIS、winCodeSign 等组件同样走
`electron_builder_binaries_mirror`（已在 `.npmrc` 配置）。若需临时切换镜像，可在命令前设置环境变量：

```bash
# Windows (PowerShell)
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"

# macOS / Linux
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
```

## 微软登录原理（免申请）

使用微软 OAuth 2.0 **Device Code Flow（设备代码流）**，无需注册任何 Azure 应用：

1. `POST https://login.live.com/oauth20_connect.srf`，使用公共 client_id `00000000441cc96b`（任天堂 Switch 版 Minecraft，免申请、社区广泛验证可用），scope 为 `service::user.auth.xboxlive.com::MBI_SSL`
2. 用户访问 `microsoft.com/link` 输入一次性代码并授权
3. 轮询 `login.live.com/oauth20_token.srf`（携带设备码响应返回的 Cookie）取得微软访问令牌
4. 令牌链：**Xbox Live (XBL) → XSTS → Minecraft 服务 → 玩家档案**

官方 Minecraft Launcher 的 client_id `000000004C12AE6F` 为等价备选方案，在 `src/main/auth.ts` 中可一行切换。

## 第三方登录原理（Yggdrasil）

除微软正版登录外，还支持 LittleSkin 等基于 **Yggdrasil 协议** 的第三方正版认证服务器：

1. 登录时调用 `{server}/authserver/authenticate` 校验邮箱/密码，取得 `accessToken` 与 `clientToken`，并从 `textures` 属性解析皮肤/披风。
2. 首次启动前自动下载 **authlib-injector.jar**（含国内镜像双回退），并以 `-javaagent:authlib-injector.jar={server}` 注入 JVM 参数。
3. 进入游戏后，皮肤、玩家头颅与服务器鉴权都会打到该第三方认证服务器。
4. 账号头像优先从 LittleSkin 官方接口 `littleskin.cn/avatar/player/{name}` 获取，失败时回退到皮肤纹理裁切头部。

> 提示：使用 Yggdrasil 外置登录时，游戏可能需要对目标服务器配置对应的「外置登录模式」，且第三方账号无法进入开启正版验证的服务器。

## 说明

- 首次启动某一版本时，会从镜像源下载该版本的资源、库文件与客户端 jar（数百 MB），随后再次启动会跳过已下载文件。
- 模组/资源包/光影通过 Modrinth 安装；CurseForge 需要申请 API Key，故默认未接入。
- Forge / NeoForge 通过运行官方安装器（需 Java）生成版本；支持现代版本（1.13+），旧版（≤1.12.2）的 Swing 安装器暂不支持无头安装。
- 离线模式仅用于单机游戏，无法进入开启正版验证的服务器。
- 内存分配上限由系统剩余可用内存动态限制，避免启动时预留内存超出系统内存导致卡死。

## License

本项目采用**自定义开源许可协议（HCMCL自定义开源许可协议 v1.0）**发布，详见 [LICENSE](./LICENSE)。

核心约定：

- **强制署名**：使用/修改/再分发本项目或将其嵌入其他作品，必须在显著位置保留原作者署名。
- **禁止商用**：不得将本项目或其派生版本用于任何商业盈利目的。
- **禁止出售源代码**：不得以任何形式出售或转售本项目源代码及其产物。

如需在本协议授权范围之外使用，请联系原始作者单独洽谈。

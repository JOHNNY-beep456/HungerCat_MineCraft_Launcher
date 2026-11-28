# 本项目不接受PR！！！

# HungerCat MineCraft Launcher

基于 **Tauri v2 + Rust + React** 的 Minecraft Java 版启动器，覆盖 **Windows / macOS / Linux / Android**，界面采用 **Apple Design** 风格，微软登录使用**免申请的 OAuth 设备代码流**。

---

## 当前版本：0.8.3

面向 **Microsoft Store** 的分发准备版：功能不变，改的是「打包成商店包之后必须换掉的行为」。
商店包可以产出，**尚未提交认证**。

- **包形态下更新交给商店**：以 MSIX 包身份运行时，检查更新不再提示自建源的新版本，
  下载 / 自动安装通道直接拒绝并提示去 Microsoft Store 更新。
- **MSIX 清单补齐 Windows 10 2004+ 的标记**（`uap10:RuntimeBehavior` + `uap10:TrustLevel`），
  与原有的 `EntryPoint` 并存；缺这两个属性时会被当作 appContainer，装完启动即崩。
- **商店包产出方式**：`scripts/package-msix.ps1 -Store` 打单架构商店包，
  `scripts/package-msix-bundle.ps1` 合成 `.msixbundle` / `.msixupload`；
  CI 配置三个仓库变量（`STORE_IDENTITY_NAME` / `STORE_PUBLISHER` / `STORE_PUBLISHER_DISPLAY_NAME`）
  后自动产出，未配置时跳过。商店包不进 Release，只作为 Actions 产物交付。
- **版本号**：`0.8.3`（Android `versionCode` 9860）。
- **上架操作手册**：[`docs/store-submission.md`](./docs/store-submission.md)
  （含 Partner Center 步骤、清单要点、AppData 重定向等这个应用特有的坑）。

> 商店版与直接下载版是**两套用户数据**：MSIX 会把 `%APPDATA%` 重定向到包私有目录，
> 重装 / 卸载会连带清理；默认游戏目录在「文档」下，不受影响。

### 上一版：0.8.2（背景色自定义、启动检查移入载入界面、全平台自动化出包）

- **启动检查在载入界面里完成**：主页安全联网核对这类「启动时只做一次」的操作，现在由载入
  遮罩等它结束（最长 3 秒）再露出界面，遮罩上会显示「正在校验主页安全性…」。
  以前是界面先出来、侧栏首页图标再一边闪一边提示「正在核对」，看起来像还没准备完。
  超过 3 秒会先放行，检查在后台继续（结果照常更新）。
- **背景色自定义**（设置 → 通用 → 自定义背景色）：可选 1 / 2 / 3 种颜色 ——
  1 种为纯色，2 种为渐变并可选择**纵向 / 横向 / 斜向**，3 种为三色渐变，带实时预览。
  **仅在背景色真正生效时可调**：界面主题固定了背景、已设置自定义壁纸、或处于极简模式时，
  子控件会置灰并写明原因（总开关仍可关掉，避免卡在「开着但不生效」的死角）。
- **修复外壳整体下移**：主页曾出现「标题栏下一条空白带 + 启动按钮消失」。原因是外壳用
  `h-full` 依赖祖先高度链，被上游间距推下去的同时高度仍按 100% 计算，底部正好被裁掉。
  现在外壳固定为 `fixed inset-0`（钉在视口上），不再受任何祖先影响。
- **启动提速**：首帧静态骨架（不再闪白底）、入口 chunk 并行加载、页面按需加载
  （`App-*.js` 437 kB → 164 kB）、非首屏请求改到首个空闲帧。
- **全平台产物由 `build-tauri` 工作流构建**（推 `v*` 标签触发，汇总成 Draft Release）：
  - Windows：`.exe`（NSIS）与 `.msi`，各 x64 / x86 / arm64；`.msix` 三架构（自签名，附 `.cer`）
  - Linux：`.deb`（x86_64 / aarch64 / armv7l）、`.AppImage`（x86_64 / aarch64）
  - macOS：`.dmg`（Intel / Apple Silicon），**未签名**，首次打开需右键 →「打开」

> MSIX 由 `scripts/package-msix.ps1` 调用 Windows SDK 的 `makeappx` 封装（Tauri 只支持 NSIS / MSI）：
> 侧载包安装前需信任随包的开发证书。各平台的验证边界见 [`plan.md`](./plan.md) 第 58–64 节。

### 已发布的 0.8.0（首个正式版）

线上正式版仍是 0.8.0，重点是把桌面三端的安装包补齐。

- **Windows**：x64 / x86 / ARM64，各提供 `.exe`（NSIS）与 `.msi`。
- **Linux**：x86_64 / aarch64 的 `.deb` 与 `.AppImage`；armv7l 的 `.deb`（交叉编译）。
- **macOS**：Intel 与 Apple Silicon 各一个 `.dmg`，**未签名**，首次打开需右键 →「打开」。
- **Android**：完整启动链路、可自定义的触控布局、多 Java 运行时（17 内置 / 21 / 25 下载）；APK 需自行对齐与签名，未随 0.8.0 出包。

安装包以 [Releases](https://github.com/JOHNNY-beep456/HungerCat_MineCraft_Launcher/releases) 中实际上传的文件为准。
只有 Windows x64 在本机做过安装与启动验证；x86 / ARM64、Linux armv7l、macOS 与 Android 均为构建层验证，见 [`plan.md`](./plan.md) 第 56 节。

Electron 版已归档到 `HCMCL_old/`（仅本地保留、不入库），不再随根项目构建。

## 功能特性

| 模块 | 说明 |
| --- | --- |
| 🪟 多平台 | Tauri v2 + Rust 内核，输出 Windows `NSIS`/`MSI`、Linux `deb`/`AppImage`、macOS `dmg` |
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
| 📱 Android | 进程内 JNI 启动 JRE（17 内置，21/25 按清单下载），LWJGL for Android 图形桥；可自定义触控布局（摇杆 / 键盘 / 陀螺仪）、游戏内输入法、运行时管理 |
| 🧱 覆盖安装 | Windows NSIS 可识别并清理旧 Electron 版与其它版本，复用原安装目录、保留用户数据 |

## 技术栈

- **桌面框架**：Tauri v2（Rust 后端 + 系统 WebView 前端）
- **构建**：Vite 5 + TypeScript（`vite.tauri.config.mts`）
- **界面**：React 18 + Tailwind CSS 4 + `motion`（弹簧动画）；主样式集中在单文件 `src/renderer/src/index.css`
- **打包**：Tauri Bundler（NSIS / MSI / deb / AppImage / dmg）+ Gradle（Android）
- **移动端**：进程内 JVM（JNI）+ LWJGL for Android + 自研 Kotlin 触控层（`HCMCL PE/`）
- **第三方认证**：Yggdrasil API + authlib-injector（自动下载并注入 JVM 参数）
- **头像服务**：LittleSkin 官方头像接口 `littleskin.cn/avatar/player/{name}`（含皮肤纹理裁切兜底）

## 目录结构

```
src-tauri/
├── src/                    # Rust 后端（组合根：lib.rs / main.rs）
│   ├── runtime.rs          # 启动编排（桌面 spawn 子进程 / Android 进程内 JVM）
│   ├── downloads.rs        # 下载与校验
│   ├── auth.rs             # 微软登录（设备代码流）
│   ├── account_import.rs   # PCL2 / HMCL / 官方启动器账号导入
│   ├── java_runtime.rs     # Java 检测与多运行时
│   ├── android_host.rs     # Android Activity 与图形桥（JNI）
│   ├── android_jvm.rs      # 进程内 HotSpot 与输入事件
│   ├── android_runtime.rs  # Android Java 运行时下载与校验
│   ├── homepage/           # 自定义主页与会话
│   ├── modpack/            # 整合包导入导出
│   ├── multiplayer/        # 联机（大厅 / 信令 / 语音中继）
│   └── services.rs         # 发布清单与更新通道选择
├── installer-hooks.nsh     # NSIS 覆盖安装与旧版清理钩子
└── gen/android/            # Android Gradle 工程
src/
├── renderer/src/           # React 前端（pages / components / i18n / index.css）
├── shared/                 # 跨端类型契约
└── tauri/                  # 前端调用 Rust 命令的 bridge
HCMCL PE/                   # Android 自有源码（引导 Java + 手写 Kotlin）
```

> 架构、各板块职责、i18n 规范与构建调试流程详见 [docs/](./docs/README.md)。

## 开发与构建

```bash
# 安装依赖
npm install

# 开发模式（Tauri，热更新）
npm run dev

# 类型检查（web tsconfig）
npm run typecheck

# 前端构建到 out/tauri
npm run build:tauri:web

# 当前平台完整构建 + 打包（Windows 出 NSIS + MSI）
npm run build:tauri
```

### Windows（本地三架构）

需要 Visual Studio Build Tools；本机缺 `combase.lib` 时用 `.local/sdk-shim` 垫片补齐，
ARM64 还要 LLVM 的 `clang`：

```powershell
$env:NODE_OPTIONS = ''          # 避开沙箱删除钩子，否则 vite 清 out/tauri 会超时

npx tauri build --bundles nsis,msi                                     # x64
npx tauri build --target i686-pc-windows-msvc    --bundles nsis,msi    # x86
npx tauri build --target aarch64-pc-windows-msvc --bundles nsis,msi    # ARM64
```

产物在 `src-tauri/target/<triple>/release/bundle/{nsis,msi}`（x64 不带 triple 前缀）。
**MSI 要求版本号没有非数字预发布段**：`0.8.0` 能出包，`0.8.0-beta12` 与 `0.8.1-dev1` 都会被 wix 拒绝。

### Linux / macOS（GitHub Actions）

由 `.github/workflows/build-tauri.yml` 构建，推送 `v*` 标签触发，产物汇总到草稿 Release：

- Linux：x86_64 / aarch64 出 `deb` + `AppImage`，armv7l 交叉编译出 `deb`
- macOS：Intel 与 Apple Silicon 各一个 `dmg`（未签名）

### Android

```powershell
$env:ANDROID_HOME='F:\Android\Sdk'
$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
$env:NDK_HOME="$env:ANDROID_HOME\ndk\27.2.12479018"
$env:NODE_OPTIONS=''

npm run android:runtime      # 先把 JRE 原生库与 LWJGL for Android 装进 jniLibs/assets
npm run android:build:arm64  # 或 android:build:x86
```

`tauri android build` 出的是未签名 APK，需要自行 `zipalign` + `apksigner`；同一应用升级必须沿用同一签名。

> SDK 垫片、证书、交叉编译这些环境坑都记在 [`AGENTS.md`](./AGENTS.md)。

## 微软登录原理（免申请）

使用微软 OAuth 2.0 **Device Code Flow（设备代码流）**，无需注册任何 Azure 应用：

1. `POST https://login.live.com/oauth20_connect.srf`，使用公共 client_id `00000000441cc96b`（任天堂 Switch 版 Minecraft，免申请、社区广泛验证可用），scope 为 `service::user.auth.xboxlive.com::MBI_SSL`
2. 用户访问 `microsoft.com/link` 输入一次性代码并授权
3. 轮询 `login.live.com/oauth20_token.srf`（携带设备码响应返回的 Cookie）取得微软访问令牌
4. 令牌链：**Xbox Live (XBL) → XSTS → Minecraft 服务 → 玩家档案**

官方 Minecraft Launcher 的 client_id `000000004C12AE6F` 为等价备选方案，在 `src-tauri/src/auth.rs` 中可一行切换。

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
- **Android 版**：图形层只有 GL4ES 一套转发，没有渲染器切换与分辨率缩放；摇杆输出的是离散方向键组合（图形层没有轴通道，不冒充模拟量）；Forge / NeoForge / OptiFine 依赖桌面 `java -jar` 安装器语义，手机上不提供安装入口；退出游戏后的二次启动尚未验证。
- **Windows 覆盖安装**：NSIS 安装器会识别旧 Electron 版与其它版本目录，复用原安装目录并保留 `%APPDATA%\HungerCatLauncher` 数据；卸载或清理失败时中止安装，不会形成两版并存。

## License

本项目采用**自定义开源许可协议（HCMCL自定义开源许可协议 v1.0）**发布，详见 [LICENSE](./LICENSE)。

核心约定：

- **强制署名**：使用/修改/再分发本项目或将其嵌入其他作品，必须在显著位置保留原作者署名。
- **禁止商用**：不得将本项目或其派生版本用于任何商业盈利目的。
- **禁止出售源代码**：不得以任何形式出售或转售本项目源代码及其产物。

如需在本协议授权范围之外使用，请联系原始作者单独洽谈。

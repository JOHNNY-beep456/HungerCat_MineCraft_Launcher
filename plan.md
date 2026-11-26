# HCMCL / HCMCLL 进度与接续计划

> 更新时间：2026-11-25，Asia/Shanghai（UTC+08:00）。此前迁移、真实 Electron 覆盖安装及用户数据补迁记录见第 1–29 节；HUD 阴影、AI 悬浮球与 `0.8.0-dev2` 见第 30 节；`0.8.0-dev3` 的三项修复见第 33–35 节；实例遍历预算与资源扫描降级、液态玻璃与中文安装器、后端三语文案、小文件下载与安装白名单、全链路下载瓶颈、可更新分栏批量更新、首次入库与三系统打包见第 36–42 节；**Android 全链路见第 43–54 节**（43 打通与 x86 出包、44 路径误判、47 平台边界、48 内置运行时、49 图形层、50 触控层、51 移动端启动尺寸、52 卡住可观测性与运行时调研、53 多 Java 运行时、54 启动参数与布局管理），**当前版本 `0.8.0`（versionCode 9800）**。完整原生窗口、DPI、鼠标穿透、socket、组网、真实账号与游戏行为仍未验收；未执行发布、提交或推送。当前根项目版本以 [package.json](<package.json>) 为准。
>
> **整体仍在迁移与补齐阶段，尚未完成全功能验收。** 下文分别标明源码落盘、本地测试通过、平台限制和未验证事项，不以文件存在、分支数量或旧包代替产品完成。

## 1. 总目标与已经确定的范围

| 产品 / 工作线 | 确定方案 | 当前结论 |
| --- | --- | --- |
| HCMCL | Electron 向 **Tauri v2 + React + Rust** 迁移，保留全部现有功能，增加 Android 支持 | 桥、宿主及多个业务域已有实现；Electron 基线仍保留作对齐依据，尚未全部替换 |
| HCMCLL / Lite | **纯 C++17 + SDL2 / SDL_ttf / SDL_image**，完全无 Qt 的现代暗黑自绘界面 | Windows / Linux 已有真实构建和多批本地测试；完整业务与 UI 仍有缺口 |
| PHP 服务端 | 两产品共用同站、同数据存储及同后台 | 仅更新、公告、关于按产品区分，其余接口共享；本地实现不等于线上已部署 |
| Android 与分发 | 继续完成 Android x86 / arm64 及 Lite 分发、前台 Lite 下载入口 | 发布目标仍开放；Android 当前没有 APK / 设备 / 游戏验收 |

已经生效的范围调整：

- 旧 VB/WPF PCCL2 原生组件已按用户要求永久删除，不能恢复为当前方案；Electron 的 PCL2 风格主题是另一项能力。
- 旧 Qt Lite 代码与测试只作历史参考，不能当作 SDL 新版的完成证据；主目标不再使用 Qt。
- **仅 Lite 排除歌词**，根 HCMCL 的歌词目标保留；AI 录音、STT、TTS、HUD 与相关目标仍在范围内。
- 先前微软登录修改要求已经被用户取消，不恢复该修改，不擅改认证协议或 Client ID。
- 用户要求在质量不变的情况下提速，继续采用分离写域、冻结交接、Lead 集中验证，避免重复跑已经通过且源码未变的批次。

## 2. 状态口径与当前协作状态

- **源码已落盘**：有实际代码与调用路径，不代表已运行。
- **本地验证通过**：仅证明对应源码版本、平台及测试范围，不能外推到真实账号、网络、游戏、系统窗口或设备。
- **静态接管**：公开接口能到达某个处理分支，可能仍包含条件拒绝或明确不支持，不是功能完成率。
- **未验收**：仍缺用户流程、实际平台行为、构建产物或端到端证据。

开发工具 / Inspector、HUD 异步销毁与退出、OfflineTranslate 三项已完成有界源码收口，详见第 11 节；随后接入 Windows GPU 启动策略（第 12 节）、AI 桌面悬浮球（第 13 节）、球存活时的重启门禁（第 14 节）、Windows 固定语音热键和桌面消费者（第 15 节），以及当前受管游戏输出的共享诊断接入（第 16 节）、普通模组 / Fabric API 安装的实例兼容核验（第 17 节）、Windows 网易云歌词与共享 HUD 卡片（第 18 节），以及六个联机诊断入口与 Windows 固定资源映射（第 19 节）、Windows core 受管启停与取消 / 退出等待（第 20 节），以及同代次物理 UDP 成员发现与有界聊天（第 21 节）、联机共享 HUD 投影与原卡片复用（第 22 节）、独立弹幕（第 23 节）与联机小窗（第 24 节）。Task98/99/100/97 及第 4、7 节为旧批次证据，不能当作当前源码结果。成员 inactive 仅表示没有执行中的回合。

当前主产品迁移目标为 `goal-6099fbe7-c063-405f-a546-f62b8acc5cba`；完整功能、外观与真实环境验收仍未完成。此前 `goal-c71640a0-a7cb-4a89-99e1-525d1c4dc2b7` 为历史目标记录。

## 3. HCMCL：已经落盘的主要迁移能力

详细证据见 [Tauri 迁移审计](<docs/tauri-migration.md>)。该审计的最新正式统计早于当前 HUD 批次，不能直接当作本次源码的最终统计。

| 领域 | 当前已有实现 | 仍需保留的边界 |
| --- | --- | --- |
| 架构与桥 | 保留 React 与既有 LauncherApi 合同，Tauri command 分发到 Rust 域模块；受信任主窗、来源及白名单控制 | 不能以桥方法存在声称业务全部迁完；未实现通道明确报错 |
| 设置、账号、目录 | 设置白名单、派生字段、系统保护凭据引用、目录选择、账号批量 insert-only 持久化 | Electron 全量配置 / 加密数据兼容迁移仍未完成真实验收 |
| 认证及账号导入 | Microsoft / Yggdrasil、来源 OAuth 参数、PCL / HMCL / 官方账号导入预览及会话提交 | 真实登录、刷新和来源凭据迁移未验；未知保护封装需重登录，不能猜密钥或通用 Client ID |
| 下载与运行时 | 原版下载、缓存及校验、任务取消、Java 安装、桌面启动与诊断、共享目录操作锁 | 真实 Java / Minecraft / Forge 安装到启动未验；Android 不能直接使用桌面 JVM spawn |
| 加载器 | Fabric / Quilt 事务安装；Forge / NeoForge 的官方安装器绑定、独立 staging、超时与进程树收尾 | 现代 NeoForge 有联合 metadata/profile 校验；旧版及真实发布 JAR 的兼容性不能据夹具外推 |
| 资源与整合包 | 搜索、普通安装 / Fabric API、文件管理、资源更新检测与审批应用、整合包探测 / 下载 / 导入 / 导出、外部版本导入；普通模组 / Fabric API 已接入官方标签与实例 MC / loader、提交前配置复核，专用固定源 OfflineTranslate 已接入源码 | required 依赖完整闭环与真实安装 / 游戏兼容仍未验；OfflineTranslate 真实签名地址、代理和游戏兼容未验 |
| 事务和生命周期 | 根目录跨进程锁、WAL 与有身份凭据的恢复、owned worker、取消后真实收尾、重启全域空闲门禁 | 不承诺任意断电恢复或同权限外部进程的 inode CAS；未知状态保守保持忙碌 |
| 远程服务与 AI | 共用 PHP 协议、反馈附件系统交接、五种 AI 协议、13 工具审批执行、OpenAI/custom 转写、翻译；Windows 桌面悬浮球、固定 Ctrl+Alt+V 与有界语音消费者已接入源码 | 真实 HTTP、工具全流程、热键注册 / 设备权限 / 音频、悬浮球窗口 / DPI / 全屏置顶、更新安装与线上兼容未整体验收 |
| 桌面与调试 | 文件选择 / 导出、窗口模式、系统硬件、托管壁纸、日志缓冲与主动提交、移动应用内日志页；Windows WebView2 启动 GPU 策略、冻结值查询、当前受管游戏输出到共享诊断，以及 SMTC / 网易云歌词、共享三行 HUD 卡片已接入源码 | 真实 GPU / 重启、窗口焦点 / 穿透 / DPI、歌词媒体采样 / 网络 / 热键、游戏日志和上传未验；非 Windows GPU / 歌词策略仍有缺口 |
| 开发授权 | 六个授权 / 状态通道、私有令牌、epoch / CAS；四个 Tools / DevTools 通道、受限共享界面和 Windows Inspector 已接入 | 真实 PHP 授权未验；Inspector HWND 关联仍为保守启发式；最新销毁收尾未重跑原生 smoke，见第 11 节 |
| 联机诊断、core、UDP 与桌面浮层 | 六个诊断入口、Windows 固定 core / cli 映射、自有 Job 启停与清理；同代次物理 UDP 发现 / 心跳 / 离开、实际报文投影成员、300 条有界聊天、共享 HUD、独立弹幕与联机小窗已接入源码，见第 19–24 节 | 会话 / UDP / HUD / 弹幕 / 小窗原生行为未实测；EasyTier 路由 / no-tun 跨网目标与转发、LAN 世界仍未迁完；协议无大厅认证，不以文件、虚拟 IP、物理 UDP 或卡片夹具证明来源、许可或双机 Minecraft 可连接 |

### 3.1 最近一次正式接口统计：HUD 之前

[Tauri 迁移审计](<docs/tauri-migration.md>)于 2026-11-10 11:50 的统计为：

- 原合同 **239 个成员**：212 invoke、2 send、23 events、2 local。
- 212 个 invoke 中 **148 个显式接管**：147 个业务 / 平台条件分支，1 个 GPU 策略查询明确 Err。
- 余项 **64 个**：4 个开发工具明确未实现，60 个未接业务处理。
- 事件生产者 **11/23**。
- 余项分组：主页 18、联机 32、AI 7、开发工具 4、OfflineTranslate 1。

**这些是 HUD 之前的静态计数，不是完成率。** 本批 HUD 复用了现有公开合同，没有新增成员；Task98/99 的本地代码回归已完成，但不把本地夹具上调为真实窗口、设备或游戏验收。

## 4. 历史批次：AI HUD P0 代码收口（2026-11-10 快照）

当前批次复用既有六字段 DTO：`enabled / active / opacity / status / text / lastUser`。语言和 revision 仅为 Rust 内部状态，不扩展公开合同。

| 子任务 | 当前状态 | 已有证据 / 待办 |
| --- | --- | --- |
| Task98：状态与聊天生命周期 | **代码与本地回归完成；任务板 completed** | [ai_hud.rs](<src-tauri/src/ai_hud.rs>)、[services.rs](<src-tauri/src/services.rs>)、[runtime.rs](<src-tauri/src/runtime.rs>)保留六字段 DTO；Windows/Linux 全量回归执行生产状态夹具，真实 AppHandle/游戏进程仍未实测 |
| Task99：只读桌面宿主 | **代码与 Windows 本地回归完成；任务板 completed** | [ai_hud_window.rs](<src-tauri/src/ai_hud_window.rs>)与[独立 capability](<src-tauri/capabilities/ai-hud.json>)采用 UI 队列、锁外 native 调用、generation 防迟到、close 幂等及 8 次销毁重试预算；Linux 最新补丁后的精确回归结果受 WSL 环境影响未取得；真实透明/焦点/穿透/关闭重开仍未实机验收 |
| Task100：前端展示与移动宿主 | **已完成该有界子任务** | [TauriAiHud.tsx](<src/renderer/src/components/TauriAiHud.tsx>)、[移动宿主](<src/renderer/src/components/TauriAiHudHost.tsx>)及[入口](<src/renderer/src/main.tsx>)已接；前端夹具 22/22、类型检查和 Web 构建通过，尚无原生 / 设备视觉验收 |
| 主线接线 | **源码与本地回归完成** | [runtime.rs](<src-tauri/src/runtime.rs>)使用唯一游戏 session；[lib.rs](<src-tauri/src/lib.rs>)接初始化、设置刷新、权限、关闭与重启 readiness；真实 Tauri AppHandle、游戏进程和原生窗口仍未实测 |

平台设计：Windows / Linux 独立透明、非聚焦、鼠标穿透只读窗；Android / iOS 为应用主树内只读卡片，不创建外部悬浮窗。macOS 在当前未启用相关透明能力的配置下明确不支持此桌面宿主。本批没有迁移完整 AI 球、麦克风、联机或歌词 HUD。

### 4.1 已运行的本批检查

- `node scripts/test-tauri-ai-hud.mjs`：**22 通过 / 0 失败**。`npm run typecheck`：**exit 0**；`npm run build:tauri:web`：**exit 0**，Vite **530 modules / 6.47s**。覆盖 TSX 转译、轻量 Hooks / DOM、三语、订阅后快照、事件优先、卸载隔离、只读路由、移动宿主及 CSS 范围。
- Windows 在官方 `cargo clean -p hcmcl-tauri` 后从当前源码重编：最终 `ai_hud_window::tests` **7/0**（728 filtered；新增 `close_retry_budget_is_finite_and_preserves_pending_until_exhausted`），最终 `cargo test --lib --locked` **735/0/0**（25.44s），最终 `cargo check --lib --locked` **exit 0**（约 109 条既有 warning）；未安装 rustfmt，`cargo fmt --all -- --check` 仍不可用。
- Linux/WSL：此前当前源码快照的可读结果为 HUD **6/0**、全量 **758/0/0**；本轮补丁后的 WSL 调用受 `ERROR_INVALID_DATA` 及 `Failed to translate 'D:\BtSoft\panel\script'`、`D:\platform-tools` 环境问题影响，未得到新的可读 `test result` 行，因此不把它当作本轮补丁后的精确 Linux 全量证据。本轮新增 close 预算夹具已在 Windows 最终全量 **735** 中执行。
- Android 使用进程级 NDK `CC/AR/RANLIB/CARGO_TARGET_*_LINKER`，当前源码 `cargo check --locked --offline --all-targets` 三 target 均 **exit 0**：aarch64-linux-android、i686-linux-android、x86_64-linux-android；每个 target 仍有约 319 lib / 132 lib-test warnings。仅是 Rust cfg 交叉检查。
- Lite 单独验证：隔离私有 keyring 的 WSL CTest **27/27**（含独立 6/6 子集）；普通 WSL CTest **15/18**，失败为 `common`、`identity`、`media`，原因含 `系统凭据保护不可用：Secret Service 默认钥匙串不可用` 与身份环境断言；Windows 当前源码重建因 `cmake: command not found` 未执行，旧缓存 Windows 可执行文件结果只能标为 cached old binaries；Windows 合成打包夹具 **8/0**，不执行 PE/打包主流程。Lite 仍为 migration-in-progress，不等于完整游戏/在线/发布验收。

此前 Windows `STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)` / `3221225785` 的失败发生在旧测试进程装载阶段；官方包级 clean 后当前 Windows 产物已能进入并通过测试。诊断仍未证明此前具体 DLL/export 根因，不能把 clean 当作根因结论。

### 4.2 本批收口结果与保留边界

1. **Task99 原生调用与状态锁：已完成源码收口。** native WebviewWindowBuilder、属性设置、show/destroy 均在线程安全 UI 队列执行；状态锁只覆盖短快照，窗口销毁先失效 generation/language/visible，事件回调不等待 inner 锁。
2. **Task99 pending / retry：已完成确定性收口。** Gate 的 `Closed`、`Restarting` 与其他失败分类保留；重启拒绝保留 pending 并去重调度，关闭销毁错误最多重试 8 次，重复 close 不增加预算；`close_retry_budget_is_finite_and_preserves_pending_until_exhausted` 已执行。
3. **Task99 退出与未知状态：已完成本地回归。** worker 的 busy/pending/unknown/generation 语义由 7 个 HUD 宿主测试覆盖；真实 Tauri UI 队列、透明窗口、焦点与穿透仍未实机验收。
4. **Task98 锁顺序：已完成本地回归。** HUD 读取权威 GAME session 时采用 HUD -> GAME 顺序；退出先标记 done、清理 exact Arc slot、释放 GAME，再调用 `game_stopped`。
5. **Task98 聊天集成：已完成本地回归。** settings refresh、代次失效、caller drop、reset、迟到 completion、IPC waiter 保持忙碌等生产状态夹具均在 Windows 全量 735 测试中执行。
6. **既有断言维护：前端合同保持。** `test-tauri-ai-hud.mjs` 22/22、typecheck 与 Web 构建通过；239 成员合同及六字段 HUD DTO 未扩展。
7. **环境与平台验证：证据已冻结。** Windows 当前源码全量 735/0/0；Linux/WSL 此前当前源码快照为 HUD 6/0、全量 758/0/0，最新补丁调用受 `ERROR_INVALID_DATA`/路径转换环境影响而没有可读 test-result 行；Android 三 target Rust cfg exit 0；此前 Windows 0xc0000139 的具体 DLL/export 根因仍未知。

### 4.3 当前冻结源码身份

以下摘要为本次工具读回结果，用于接续核对，不代替测试。

| 文件 | 当前 SHA-256 |
| --- | --- |
| [ai_hud.rs](<src-tauri/src/ai_hud.rs>) | `76096e1c31c139902602c52b9e356c61944a5def531a1e6fe2c4840b0f1d67fe` |
| [services.rs](<src-tauri/src/services.rs>) | `b4e80b7806eddb593eec8c459f6438edcff330ecbdc5c9d54a91cc407257551f` |
| [ai_hud_window.rs](<src-tauri/src/ai_hud_window.rs>) | `aa6a99e9133989f4ff6248b1c4e834741bc922bab1dbad6e4e57374a7cf81c0d` |
| [runtime.rs](<src-tauri/src/runtime.rs>) | `28c4c80f3250e207911d905a1882e40c1d0bf5117a72753ca00bf8f2b4d08804` |
| [lifecycle.rs](<src-tauri/src/lifecycle.rs>) | `7d379d9445118a7140c25e84b7f176b32d8cb91241a387e02d6d9627ca6efedd` |
| [lib.rs](<src-tauri/src/lib.rs>) | `dfdf09b94e5c7a5f39c828ba5856afd2c600fef7f889381ba418d0f065fcbfd2` |

## 5. Lite：当前已验证增量与剩余范围

详细功能范围见 [PARITY](<HungerCat MineCraft Launcher Lite/docs/PARITY.md>)，当前状态见 [STATUS](<HungerCat MineCraft Launcher Lite/docs/STATUS.md>)，构建记录见 [BUILD](<HungerCat MineCraft Launcher Lite/docs/BUILD.md>)。173 个功能 ID 仍完整保留，不能沿用旧 Qt 的完成统计。

已经落盘并有不同批次本地验证的能力包括：无 Qt SDL 暗黑主窗及八导航、异步任务 / 取消、账号与实例基本业务、实例设置、QuickPlay 入口、本地资源 / 整合包导入、文件管理、壁纸、系统信息、About / 公告、反馈详情及单附件保存。

最近 Task97 内容搜索 / 状态筛选已完成：

- 按 displayName / name / filename / modId / version 搜索；ASCII 大小写折叠，中文按 UTF-8 原文匹配，不宣称完整 Unicode 折叠。
- 模组全部 / 启用 / 禁用三态；切实例 / 目录 / 类型清旧状态，同 scope 刷新保留过滤。
- 隐藏选择清理、固定目标确认、generation 拒绝迟到列表，不改后端权威内容列表。
- Windows CTest **18/18，170.42s**，native-window **91.30s**。
- Linux CTest **18/18，71.61s**，native-window **54.25s**。
- 两平台三语专项每种语言 **2/0**；Linux 隔离 Secret Service **4/0/0**。
- Windows 结果来自已收集会话输出，没有非空独立日志；Linux 日志在 STATUS 中有链接。本地 Engine / SDL dummy / 临时文件夹具不等于真实游戏或人工视觉验收。

Task97 完成不代表 Task7 整体 UI 已完成。主要剩余项：

1. 全部实例 / 资源详情、兼容依赖安装、分页、预览汇总与完整进度失败处理。
2. 自定义主页隔离 renderer / SDK；旧 Qt HomeView 不在当前构建内，不能算实现。
3. AI 完整配置、桌面球、Markdown、主动录音 / STT / TTS、HUD 与全局热键 UI。
4. EasyTier 正式发行供应与校验、节点 CRUD、世界 / 端口 / 可达地址 UI，以及真实双机验收。
5. 更新检查 → 下载 → prepare → 二次退出确认 → helper → 失败恢复的完整 UI 与真实更新验收。
6. 反馈附件上传、TTL / 限制界面、真实线上兼容；现有单附件保存只是子流程。
7. 四向导航、完整主题 / 皮肤 / 自动明暗、GIF、最小模式、窗口 / 托盘、3D 与其余外观消费。
8. Electron 账号 / 配置完整迁移，macOS 构建与系统凭据 / 输入 / 音频，以及人工视觉和干净机验证。

旧 Windows / Linux reviewed 开发归档及首页 smoke 仅证明当时快照，不能宣称包含后续反馈、实例、筛选等所有增量。当前需要在功能冻结后重新生成并核验最终包。

## 6. Android：已有底座与真实缺口

依据 [Android 运行栈方案](<docs/android-runtime.md>)：

- 已有 Tauri Android 工程，包名 `top.johnnyblog.hcmcl`；compile / target SDK 36、min SDK 24。
- 本机已有 JDK 17、SDK 36、NDK `30.0.16248370` 与相关 Rust targets；过往 ARM64 / i686 / x86_64 Rust cfg 检查有通过记录。
- 已有 Android Keystore 内部秘密存储与 SAF 主动授权文件导入 / 导出源码；不得再称“没有移动文件或安全存储实现”。
- **未接受 SDK 许可；未完成 Kotlin / Gradle、native link、APK / AAB、设备 / provider 验收。** Rust cargo check 不等于 Android 可安装或可玩。
- 尚缺 Android / Bionic JRE、JVM / JNI 装载、匹配的 LWJGL / GLFW / OpenAL、renderer、Surface、触控 / 键鼠 / IME / 手柄、音频及游戏进程 / 服务生命周期闭包。
- 不能删除移动端拒绝后调用桌面 Java，也不能把 Linux glibc JRE 或桌面 natives 当成 Android 包。
- 首验候选为 `arm64-v8a + Android/Bionic Java 17 + vanilla Minecraft 1.20.1 + 待锁定 renderer`；这是后续受控组合，不是现有支持声明，也不永久缩减全功能目标。

## 7. 历史有效验证基线（当前收口结果见第 11 节）

| 范围 | 最近已收集结果 | 适用边界 |
| --- | --- | --- |
| HUD 前端（本批） | 22/22；node + web typecheck exit 0；Vite 530 modules / 6.47s | 轻量 Hooks / DOM 与构建，不是原生窗口 / 移动设备视觉 |
| HUD Rust（本批） | Windows 定向 **7/0**、最终全量 **735/0/0（25.44s）**；Linux/WSL 此前快照 HUD **6/0**、全量 **758/0/0**，最新补丁调用无可读 test-result 行 | 本地 Rust 与状态夹具通过，不是透明窗口 / 焦点 / 穿透 / 游戏实测；旧 `0xc0000139` 具体 DLL 根因未知 |
| Tauri Task96（HUD 前基线） | Windows 串行 **709/0/0，138.25s**；Linux clean **733/0/0，11.65s** | 不背书当前 HUD 源码。此前 Windows 并发 703/2 的 installer 时序夹具失败保留历史，不掩盖或擅定根因 |
| Android Task96（HUD 前基线） | 逐 target clean 后三目标 cfg 通过：**52.74s / 27.81s / 27.07s** | 仅 Rust 编译检查；不是 Gradle / link / APK / 设备结果 |
| Lite Task97 | 两平台各 CTest **18/18**，三语专项各 **2/0**；Linux keyring **4/0/0** | 本地临时文件 / Engine / SDL，不是 Java / 游戏 / 外网 / macOS |
| 文档验证（Task97 收口时） | **1159** 本地链接、**33** 外链条目、**997** 行锚与 **2** 标题锚检查；239 合同不变；173 ID 集合一致 | 外链未联网校验；这是旧文档批次结果，当前 HUD 文档尚未更新 |

原始 239 成员合同的 LF SHA-256：`6ffe2170c9000b1f651095c5ef779da790f883919c6a8ba16c278a46cb75c36b`。源码 / 文档摘要只用于身份比对，不是功能成功证据。

## 8. 后续执行顺序与验收要求

### P0：收口当前 HUD 批次

- [x] 完成 Task99 状态 / UI 队列重构，明确 close、show、事件重入、pending 调度及错误收尾；使用生产状态逻辑的确定性时序夹具。
- [x] 验证 Task98 runtime / HUD 锁顺序、退出顺序、聊天代次与 Storage 刷新集成，并运行本批状态夹具。
- [x] 定位 Windows 测试进程启动阶段现象；官方包级 clean 后当前源码可运行，具体 DLL/export 根因仍保留未知。
- [x] 冻结源码后执行 Windows / Linux Rust 回归及 Android 三目标 cfg；平台边界按证据记录。
- [x] 更新进度计划、迁移文档与 Android 文档；保留 239 合同与历史静态统计。
- [ ] 完成 Windows / Linux 实际 HUD 透明、非聚焦、穿透、关闭 / 重开和移动主树卡片的实机验收；当前 Electron 无法启动、无 Android 设备/原生窗口证据，保持未验证。

### P1：继续双产品业务缺口

- [ ] Tauri：继续主页外链脚本与非 Windows guard、no-tun / LAN、真实平台验收；Windows 根项目歌词、Danmaku 与联机小窗已有源码和离线定向检查，实机媒体、浮层拖动 / 窗口、网络与穿透待验，分别见第 18、23、24 节。开发工具和 OfflineTranslate 的真实流程边界见第 11 节。
- [ ] Tauri：补普通资源安装完整 required 依赖与真实安装 / 游戏兼容验收；本轮普通模组 / Fabric API 的实例 MC / loader 和提交前配置复核见第 17 节。真实游戏日志与服务交接仍待验收，当前受管输出到共享诊断的源码接线及离线缓冲检查见第 16 节。
- [ ] Lite：按第 5 节及 173 ID 矩阵逐项补 UI 和业务，不因已有后端而跳过用户流程。
- [ ] 共享 PHP：先做明确的本地兼容验证；用户已说明线上暂未更新，不擅自部署，不用本地夹具推断线上兼容。
- [ ] Android：先形成纯领域启动计划、能力矩阵与运行包校验，再按固定供应 / 许可 / ABI / renderer 集成完整运行宿主。

### P2：真实环境与发布

- [ ] 真实账号、Java / Minecraft、Forge / NeoForge、外网资源 / 整合包、双机联机和音频逐项验收，失败保留复现证据。
- [ ] Android 许可与构建前置条件满足后完成 Kotlin / Gradle、native link、x86 / arm64 产物、设备及游戏验收；不在未授权状态接受 SDK 条款。
- [ ] 完成功能冻结后的 Lite 新包、依赖与许可清单、哈希、独立成员核验及干净机 / Linux ABI 检查；补 macOS 证据。
- [ ] 完成前台 Lite 下载入口与产品分流元数据；发布 / 上传 / 部署须遵循已有授权边界，不以旧开发包冒充最终发布。当前 Lite 本批验证已独立记录，但仍不是完整发布验收。

## 9. 接续工作必须保留的纪律

- 保留根项目账号导入等已有未提交改动，不覆盖用户工作；本次没有 commit / push。
- 不提交 PHP 服务端目录，不读取真实 config / data 或凭据，不擅部署。反馈、市场、协议等共享接口不要误加产品隔离。
- 不绕过 TLS 校验。旧 push 的 `schannel: CRYPT_E_NO_REVOCATION_CHECK (0x80092012)` 仍是历史阻塞，不自动重试或关闭证书校验。
- 不接受 Android SDK 许可；相关前置事项按用户授权处理。
- 新增界面中文注释与简 / 繁 / 英文案齐全；React CSS 仍集中于 [index.css](<src/renderer/src/index.css>)。
- 按 [AGENTS.md](<AGENTS.md>)执行范围与验证要求；早期 Electron 无法运行的限制不能自动套到已实际构建 / 运行过的 SDL / Tauri，也不能反过来把局部窗口成功外推为完整产品成功。
- 各 owner 按独立写域工作，冻结后由 Lead 集成和构建；先消化实际结果再推进，避免盲目重复调用。
- 文档中不写猜测完成率；任务完成、源码状态、测试平台、产物版本及真实端到端结论分别记录。

## 10. Tauri v2 功能与外观对齐批次（2026-11-11，UTC+08:00）

当前主目标为 **主产品 HCMCL 从 Electron 迁移到 Tauri v2，功能与外观保持不变**；活动目标 `goal-6099fbe7-c063-405f-a546-f62b8acc5cba`。保留共用 React / CSS 与 Electron 对照，Lite 是独立产品，不借此改写 Lite。前文 239 合同、148/64、11/23 及 P0 测量均保留其历史时间点，不能拿旧静态覆盖当最新完成率。

- [x] 桌面壳：桌面主窗口对齐 1200×800 / 最小 960×640；固定主文档拖拽命令，不增加宽泛 window 权限；纯 native 控制不等 Storage 全量锁。
- [x] close intent 与真实退出分离：取消 / 退后台不关闭 Gate、不撤销业务授权；native 托盘验证后才隐藏，恢复窗口 / 双击与真正退出接线；真实退出先关闭 Gate，再后台顺序取消，最后 exit / restart。磁盘发布停滞仍可能延迟退出，不声称有界退出。
- [x] Windows 隔离本地配置实测：启动 1200×800、最大化 / 还原、取消后 API 可用、退后台进程保留、托盘双击恢复、完全关闭后进程退出。该证据不等于 Electron 逐像素对比或真实游戏验收。
- [x] 有界业务补齐：本地 Mod 元数据名称、官方 `26.4-snapshot-1` 证据识别、raw/gzip UTF-8 / Java MUTF-8 服务器列表、版本清单 / metadata 按 auto / mirror-first / official-first 复用安装器源策略与 SHA-1 缓存验证；本地模式无网络夹具通过。
- [x] 主页生产源码：18 个原公开 channel、纯 Rust 扫描、handle-relative 本地仓库、SHA 确认 / 永久 blocked、市场固定协议、主页设置 CAS、独立文档源与每 frame 单次票据、代次 / 配额 / 旧回复隔离已集成。远程协议只跑本机回环夹具，没有真实提交或服务端操作。
- [x] 当前源码回归（票据撤销修复后）：Windows 全量 Rust **794/0/0（26.64s）**；主页 Rust **33/0**；23 个脚本 **0 失败**（含主页 VM 23/0、HTML policy 4/0）；typecheck 通过，Tauri Web **533 modules / 2.48s**。此前 789/32/23 仅作为历史快照保留，不外推到后续改动。
- [x] 定位并修复真实主页阻断：共用入口 meta CSP 的 `default-src 'self'` 与 Tauri 独立主页源冲突；仅 Tauri HTML transform 替换为当前配置 CSP，Electron 入口不变、主脚本仍 `'self'`；专门变换夹具 **4/0**。
- [x] 修复后精确隔离端口实测：主页文档 **HTTP 200**、SDK 对象与代次存在，超过 6 秒无握手告警，父 DOM 访问被拒，主文档 native marker 在子框架缺失。子框架仍可见 Tauri 内部对象，需以实际命令拒绝测试判定权限，不把“对象存在”直接当越权或“marker 缺失”直接当完整安全证明。
- [x] 完成主页隔离 Windows 原生验收：干净 synthetic profile 下主页 HTTP 200、SDK 读内存/版本/主题成功、父 DOM 访问被拒、子 frame 缺少 native marker；主文档无 marker 的 `launcher_call` 得到确定拒绝；重载产生新 generation；导航后 iframe 被移除并展示三语拦截文案。验收记录为 `.local/tauri-homepage-verify-19462.json`，隔离进程已退出。子 frame 内部 Tauri 对象可见但未直接执行其 invoke（直接调用会触发主页自身 `net:fetch` 探针并永久封锁），因此不把对象可见或该跳过项写成子 frame invoke 拒绝证明。
- [x] 票据重放 / revoke 后拒绝已加入 `homepage::protocol` 确定性负向夹具：全局 URL 兜底不会再次放行已消费票据，旧 frame 不能消费替代票据；主页定向 **33/0**。该夹具不替代 WebView2 原生回归。
- [ ] 外链脚本仍拒绝执行，尚无固定依赖字节 / 用户同意后下载闭环；非 Windows 子框架 native guard 仍显式不可用。
- [x] 游戏 fullscreen / maximized / custom 尺寸与保存设置优先级的纯决策与主启动接线已冻结并通过当前全量 Rust；真实显示器 / Java / 游戏窗口仍未验收。
- [ ] 继续联机、剩余 AI / overlay / lyrics / 工具、自动依赖，以及真实账号 / Java / Minecraft / Forge / 服务端 / 音频 / 多平台逐项验收。现阶段不把源码可达、夹具或隔离调试 EXE 作为全功能等价或正式 Tauri 发布包。

最近独立主产品 Windows x64 发布打包仍是 2026-11-10 的 **Electron**；不得把它称为 Tauri 产物。后续只有功能 / 外观验收满足后才提供正式 Tauri Windows x64 包；不 commit / push / 上传 / 部署。

## 11. 当前有界收口（2026-11-11 20:30，UTC+08:00）

本节对应用户要求尽快完成手上工作并更新操作纪律与计划；只收口以下已有改动，不开新迁移项。**源码集成完成不等于完整 Tauri 迁移或原生验收完成。**

### 11.1 已集成源码

- 开发工具：[devmode_tools.rs](<src-tauri/src/devmode_tools.rs>)按精确实例保留 Creating / Open / Closing / Uncertain owner，创建后句柄、授权、show / focus 失败统一回收；旧事件不能清除新代。销毁请求每 500ms 最多尝试 8 次，缺少回执继续保留 owner / Gate；只有精确 Destroyed 与 Window / Webview 两张 manager 表均释放才结束等待。close / shutdown 在 UI 外异步等待，未确认时拒绝重开及重启。新增状态夹具已编译，未成功执行。
- HUD：[ai_hud_window.rs](<src-tauri/src/ai_hud_window.rs>)及[生命周期模型](<src-tauri/src/ai_hud_window/lifecycle.rs>)等待旧实例销毁及双表释放，再在后续 UI 回合读取最新期望状态，避免同标签立即重建；保留有界销毁预算、未知 owner 和异步 shutdown。document-start 仅注入受限语言变量，[TauriAiHud.tsx](<src/renderer/src/components/TauriAiHud.tsx>)读取三语白名单，不访问尚未建立的 documentElement；移动端回退不变。
- 退出：[desktop_shell.rs](<src-tauri/src/desktop_shell.rs#L204-L237>)在业务取消后依次尝试 HUD 与开发工具异步收尾；任何一项失败均不退出，Gate 保持关闭，允许原生退出入口重试。不阻塞 UI，也不承诺磁盘发布停滞时有界退出。
- OfflineTranslate：[catalog.rs](<src-tauri/src/catalog.rs>)、[安装器](<src-tauri/src/catalog/install.rs>)及[专用传输](<src-tauri/src/catalog/offline_translate.rs>)接入既有固定文件名与单参数接口；沿用目录隔离、根锁、取消和 no-overwrite 事务。固定 HTTPS 源不允许调用方替换，最多 64MiB、两个缓冲许可、禁止重定向和代理，超时受限；真实 writer 收尾后才 seal / commit / done 100。自算 SHA-512 仅证明提交一致性，不证明来源真实性；未访问真实签名地址。
- [Cargo.toml](<src-tauri/Cargo.toml#L16-L18>)启用 Tauri Rust `unstable` 以查询双表，不增加前端 capability；升级时复核 API / 事件顺序。[AGENTS.md](<AGENTS.md#L229-L236>)已记录这些纪律，并纠正“Electron 无法启动等于所有宿主 UI 都无法验证”的旧表述。

### 11.2 本轮实际验证及限制

| 检查 | 实际结果 | 结论边界 |
| --- | --- | --- |
| 开发工具前端定向 | **15 通过 / 0 失败** | TSX / VM 行为，不是最新原生 teardown 证明 |
| HUD 前端定向 | **24 通过 / 0 失败** | 含 documentElement 为 null 的真实注入模板及三语；不是 WebView / 游戏实测 |
| TypeScript 类型检查 | **exit 0** | 对应本轮共享前端改动 |
| Tauri Web 构建 | **exit 0，533 modules / 5.59s** | 前端可构建，不是原生发布包 |
| Rust 定向执行 | 测试程序编译完成，但启动退出 **3221225785 / 0xc0000139** | 未产生可信测试计数，不能记为通过；具体 DLL / export 根因未查明，不重复启动同一失败进程 |
| `cargo check --lib --locked --offline` | **exit 0** | 早于最后的开发工具重试预算补丁 |
| `cargo check --tests --locked --offline` | **exit 0，27.70s**；lib 115、lib-test 68 warnings | 覆盖最后重试补丁及测试代码的编译检查；没有执行测试，也不是链接 / 原生运行证明 |

先前两个隔离 Windows tools / Inspector smoke 已验证其当时源码的创建、复用、关闭、再次打开、授权撤销及正常退出，但**早于当前销毁跟踪改动**，不外推为最新源码通过。Inspector 的 HWND 关联仍是 PID / 新窗口 / 标题 / class / cookie 启发式，不是官方 WebView2 归属 API。按减少不必要测试的要求，本次没有重复全量测试、重新构建隔离原生程序或触碰真实 profile / 游戏。

### 11.3 接续边界

当前三项以“源码集成与编译检查完成、运行验收未完成”交接；task-12 / task-15 的源码子任务可据此收口，task-14 / task-16 已冻结。完整迁移目标继续保留，不声明全功能或外观等价。

截至本节快照，剩余包括：主页固定外链依赖及非 Windows guard、联机与弹幕、剩余 AI / overlay / 歌词、自动依赖闭环、GPU 启动策略、真实账号 / Java / Minecraft / Forge / 数据迁移与多平台验收；之后的 Windows GPU 源码接线见第 12 节，不回改历史验收口径。`mp:closeHudWindow` 与 `mp:closeDanmakuWindow` 仍明确未适配，不能用 no-op 冒充完成或误关共享 AI HUD。OfflineTranslate 的签名过期、重定向需求、真实 JAR / Fabric 兼容和代理行为未验。历史 239 / 148 / 64 / 11/23 不作为当前完成率。没有生成正式 Tauri 发布包，没有提交、推送、上传或部署。

## 12. Windows 硬件加速启动策略（2026-11-11 20:53，UTC+08:00）

- 新增 [hardware_accel.rs](<src-tauri/src/hardware_accel.rs>)，在 [lib.rs](<src-tauri/src/lib.rs>)注册的第一个应用插件初始化时冻结策略，早于 Tauri 配置主 WebView 创建。使用官方 `app.path().app_data_dir()`，自动遵循 `appDirectoriesOverride`，不误用 WebView 的 LocalData 路径，也不构造完整 Storage / 读取 keyring。
- 对 `storage-state.json` 只做 `schema` 与 `settings.hardwareAcceleration` 投影，最多 8MiB，拒绝文件 reparse point；无文件或投影失败沿用保守默认 `false`，不写回或修复用户数据。其它字段由解析器忽略，不生成账号 / 秘密字段快照。
- Windows 关闭策略只向本进程的 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 追加 `--disable-gpu`，保留继承参数与 Wry 默认参数，后续开发工具 / HUD / 日志窗沿用同一环境。开启时不主动添加禁用开关；最终 Exit 前还原本模块添加的参数，避免 Tauri 重启继承旧禁用值，不覆盖其它组件后来更换的环境值。
- `app:hardwareAccelerationBooted` 现在返回本进程冻结的请求布尔值，不随 `settings:set` 变动；共享 [设置界面](<src/renderer/src/pages/settings/rows.tsx#L808-L845>)及重启提示无须修改。该值与 Electron 一样是启动策略快照，**不是实际 GPU 遥测**；WebView2 注册表 / 环境策略与驱动可能影响最终渲染。非 Windows 仍明确报未接线，不伪造等价。
- 已执行一次 `cargo check --tests --locked --offline`：**exit 0，13.73s**，lib 115 / lib-test 68 warnings。覆盖新增生产源码及四个纯逻辑夹具的编译；夹具未执行，未重试此前 0xc0000139 的测试进程，没有重跑全量测试 / Web 构建 / 原生 smoke，也未打开真实 profile、账号或网络服务。源码检查确认首插件初始化早于自动配置窗口创建，WebView2 SDK 规定环境参数追加到 Wry 传参。
- task-17 按“Windows 源码接线与编译完成、实际 GPU / 重启流程未验”收口。全产品功能 / 外观 / 用户数据迁移验收继续开放；下一批仍从第 11.3 节其它缺口中选择，不生成正式 Tauri 包，不提交、推送或部署。

## 13. Windows AI 桌面悬浮球（2026-11-11 21:55，UTC+08:00）

### 13.1 本轮源码接入

- 新增 [ai_ball.rs](<src-tauri/src/ai_ball.rs>)、[Windows 宿主](<src-tauri/src/ai_ball/native.rs>)与[几何计算](<src-tauri/src/ai_ball/geometry.rs>)，复用既有 [AiBall.tsx](<src/renderer/src/components/AiBall.tsx>) 的 JSX / CSS，不另做一套外观。沿用 Electron 的 76×76 / 400×580 逻辑尺寸、主屏工作区 margin 24、夹边与右下角展开锚点；实际窗口位置返回给调用方，按原接口选择持久化。
- [lib.rs](<src-tauri/src/lib.rs>)接通四个 `ai:ball:*` 通道，Storage 就绪和设置提交后同步启用状态。独立球页仅开放所需聊天 / 取消 / 重置 / 转写 / 一次性工具决策 / HUD 状态及球操作；设置读取只返回 `language` / `aiVoiceEnabled`。保留文档标记、固定来源与精确自有实例核验；[独立 capability](<src-tauri/capabilities/ai-ball.json>)只有事件订阅 / 取消订阅，不开放主窗、账号或目录权限。
- 原生窗口透明、无框、置顶且不进任务栏，创建时隐藏并登记 owner，再显示；native 操作在 UI 回合执行，Storage 读写在后台。移动 / 展开后的 `aiBallX/Y` 写入等待真实 writer 完成，IPC 等待方离开不会截断该有序提交。页面先订阅再请求原生展开态；[main.tsx](<src/renderer/src/main.tsx>)不再把受限球页日志发到主窗专用发送口。
- 私有复用 [HUD 生命周期模型](<src-tauri/src/ai_hud_window/lifecycle.rs>)，不改原 HUD 状态；旧实例精确 `Destroyed` 与 Window / Webview 双表释放后才可复建，未知保留 owner / Gate。销毁只排队不算成功，[退出链](<src-tauri/src/desktop_shell.rs#L204-L237>)分别等待 HUD、球、开发工具，任一失败都不跳过其它清理，也不宣称退出。
- [services.rs](<src-tauri/src/services.rs>)把同一工具确认 DTO 投递给主窗及当前自有球，仍共用原一次性审批队列与执行前重检。球事件使用 `emit_to` 指定 label；辅助球不可用不取消已经交付主窗的确认。[AGENTS.md](<AGENTS.md#L229-L238>)已补充这些接线纪律。

### 13.2 实际检查与未验收项

| 检查 | 本轮实际结果 | 结论边界 |
| --- | --- | --- |
| `npm run typecheck` | **exit 0** | 覆盖共享球页订阅及类型改动；无外观 / 设备证明 |
| `node scripts/test-tauri-progress.mjs` | **13 通过 / 0 失败** | 入口顺序与精确白名单断言，不是原生窗口测试 |
| `cargo check --tests --locked --offline` | 首次 **exit 0，19.43s**；定向事件投递修正后最终 **exit 0，6.64s**；lib 116 / lib-test 69 warnings | 生产代码及夹具编译检查；没有执行 Rust 测试或链接 / 启动当前原生程序 |

新增的设置 / 通道 / 几何夹具仅编译，未执行；未重复全量、Web 构建或隔离 native smoke，未重试此前 0xc0000139 测试进程，未打开真实 profile、账号或网络服务。

当前实现是 **Windows 源码接入与编译完成，不是悬浮球或完整迁移验收**。真实窗口焦点 / 透明度、跨 DPI、全屏置顶、拖动手感、麦克风 / STT / 朗读 / 工具交互仍未实测；全局语音热键未接线，非 Windows 四个球操作明确报未实现。本节快照中存活球持有普通 Gate lease，须先停用才能重启；该已知差异随后由第 14 节的精确显示资源票据接线修复，真实重启流程仍未实测。

Task-18 以此有界源码子任务口径收口；完整功能、外观、用户数据与 Windows x64 Tauri 发布验收目标继续开放。Electron 基线、独立 Lite 和未提交改动保留，没有提交、推送、部署或生成正式 Tauri 产物。

## 14. 稳定 AI 悬浮球的正常重启接线（2026-11-11 22:35，UTC+08:00）

- 问题来自第 13 节：球窗口整个存活期持有普通业务 `Request`，即使已空闲也会被 `active != 0` 的重启门禁拒绝。本轮只修此差异，不扩大其它域的重启条件，不改共享 React / CSS、IPC 权限、配置格式或账号行为。
- [lifecycle.rs](<src-tauri/src/lifecycle.rs>)增加独立显示资源 `Resource` 与不可自行构造的 `ResourcePermit`。许可须同属一个 Gate，资源 ID 集合须精确相等，重复 / 过期 / 外来 / 缺失许可均拒绝；普通业务计数必须为零，未知状态和 Gate closed 仍拒绝。许可不会减去活动请求，不释放资源，不代表 native 收尾完成；未确认资源或业务 guard 被丢弃仍保留粘滞未知。
- [ai_ball.rs](<src-tauri/src/ai_ball.rs>)将长期显示 owner 改用资源登记；球命令、位置保存与真实 writer 仍使用普通业务登记及有序 operations 锁。只有稳定、无 pending / refresh / retry / busy / error、无 Closing / Uncertain、且精确 binding 与资源票齐全的球能参与重启；球缺席时也必须核验 manager 双表为空。
- [Windows 预检](<src-tauri/src/ai_ball/native.rs>)在 UI 回合做固定来源、精确 native stamp、当前实例与 manager 双表核验，锁外执行 native getter，再入锁核验原资源。[lib.rs](<src-tauri/src/lib.rs>)异步预检后原子冻结入口，再核验同一资源票；任一步失败只回滚未提交的重启门禁，不销毁资源或清除 owner。冻结后新业务被拒绝。
- 真正退出仍沿用[异步退出链](<src-tauri/src/desktop_shell.rs#L204-L237>)，分别等待 HUD、球和开发工具收尾；球精确 `Destroyed` 与双表释放才 finish 资源。任何未确认都不调用 `app.exit` / `request_restart`。HUD / 开发工具等其它域原有保守重启限制保持不变。
- 已执行 `cargo check --tests --locked --offline`：**exit 0，18.96s**，lib 116 / lib-test 69 warnings。新增三条生产 Gate 显示资源夹具经[独立离线状态 harness](<.local/restart-resource-check-20261111-r4/src/lib.rs>)直接引用当前生产模块运行：**3 通过 / 0 失败 / 5 filtered out**；编译 10.66s，执行 0.00s。覆盖精确许可、普通业务阻塞、门禁回滚、过期 / 外来 / 重复 / 缺失许可、未知丢弃及 closed 拒绝。球宿主的新增投影夹具仅编译，未执行。
- 未启动 Tauri / WebView / 游戏、未读取真实 profile / 账号或访问网络；未重试此前 0xc0000139 测试程序，没有全量测试 / Web 构建 / 原生 smoke。当前证据只支持源码接线、编译和 Gate 纯状态行为，**真实球存活时的重启、GPU 重启切换和原生收尾时序仍未验收**。Task-19 以此有界子任务收口，完整迁移与 Windows x64 Tauri 正式产物目标继续开放。

## 15. Windows 固定语音热键与有界录音消费者（2026-11-12 07:15，UTC+08:00）

### 15.1 本轮源码接线

- 新增 [ai_voice.rs](<src-tauri/src/ai_voice.rs>)与[固定热键消息线程](<src-tauri/src/ai_voice/shortcut.rs>)，对齐 Electron 的 `Ctrl+Alt+V`。只在 `aiEnabled && aiVoiceEnabled` 时请求注册，使用 `RegisterHotKey` 与 `MOD_NOREPEAT`，不安装键盘钩子、不读取普通按键。设置初始化 / 提交后在后台同步；冲突或线程故障记录明确提示，不返回伪造的系统注册成功。
- 热键投递在 UI 回合核验固定来源、精确 native 实例与 Window / Webview 双表，优先当前活动可见 HUD，其次自有悬浮球；事件用指定 label 的 `emit_to`。设置关闭或退出时发送当前布尔状态，使仍存活的消费者立即取消；[退出链](<src-tauri/src/desktop_shell.rs#L204-L237>)分别等待热键线程真实结束、HUD、球与开发工具收尾，任一失败仍尝试其余项并保留失败状态。
- [lib.rs](<src-tauri/src/lib.rs>)为精确自有桌面 HUD 增加快照、转写、聊天、HUD 状态四个窄入口；除布尔快照外，调用还须语音开启且 HUD 活动可见。内部 `ai:voiceState` 仅返回开关布尔值，不读取账号 / 目录，不表示热键已注册；没有增加公开 `LauncherApi` 方法或扩大 capability。原有主窗来源、文档标记、球白名单及工具审批保持原约束。
- [录音消费者](<src/renderer/src/components/ai-voice-toggle.ts>)仅在显式 start / toggle 时请求设备，最多 60 秒 / 12 MiB，按 250ms 音频块检查容量；重复停止只提交一次，停止后立即释放音轨。取消、开关关闭、页面结束、组件卸载及迟到权限结果均释放设备或使后续结果失效，迟到转写不再发送聊天。先订阅状态再取布尔快照，已收到的新事件优先于迟到快照。
- [AiBall.tsx](<src/renderer/src/components/AiBall.tsx>)沿用原 JSX / CSS、录音按钮与聊天流程，增加固定热键消费及最新开关校验；[TauriAiHudDesktop.tsx](<src/renderer/src/components/TauriAiHudDesktop.tsx>)只为 Windows 独立桌面 HUD 接入命令消费者，继续渲染原卡片。移动 / 内嵌与非 Windows HUD 仍使用[只读视图](<src/renderer/src/components/TauriAiHud.tsx>)，没有另做外观。

### 15.2 实际检查与待验收范围

| 检查 | 本轮实际结果 | 结论边界 |
| --- | --- | --- |
| `cargo check --tests --locked --offline` | **exit 0，15.83s**；lib 116 / lib-test 69 warnings | 生产代码及新增 Rust 夹具通过编译；未执行原生热键 / Rust 测试程序 |
| `npm run typecheck` | **exit 0** | 共享消费者与桌面包装组件类型通过 |
| `npm run build:tauri:web` | **exit 0，535 modules，4.40s** | Web 产物构建完成，不证明设备或窗口行为 |
| `node scripts/test-tauri-ai-voice.mjs` | **5 通过 / 0 失败** | 直接转译生产 helper，在无设备 / 无网络 VM 中核验录音边界、释放、迟到结果与状态订阅顺序 |
| `node scripts/test-tauri-ai-hud.mjs` | **24 通过 / 0 失败** | 保留卡片、语言、桌面入口与移动 / 内嵌只读边界的定向检查 |
| `node scripts/test-tauri-progress.mjs` | 修正内部快照导致的旧计数断言后 **13 通过 / 0 失败** | 原公开 212 invoke / 2 send / 23 events 仍单独计数，内部快照调用与事件各一项；不是当前业务完成率 |

未重复全量测试，未重试此前 0xc0000139 测试程序，未注册真实全局热键、请求麦克风、启动原生窗口或访问真实 STT / AI 服务。**热键冲突与注销、WebView2 设备权限、真实音频 / 转写、HUD / 球切换和退出时序仍未实测**；非 Windows 热键策略未接线，内部快照返回关闭。Task-20 按源码、定向检查与构建口径收口，完整功能 / 外观 / 数据迁移及 Windows x64 Tauri 发布验收继续开放。没有提交、推送、部署或生成正式发布包。

## 16. 受管游戏输出接入共享诊断（2026-11-12 07:35，UTC+08:00）

- [runtime.rs](<src-tauri/src/runtime.rs#L718-L732>)在当前受管进程的既有输出消费点，将原有日志预算内的正文与一次性容量提示交给共享诊断；保留原本地文件、`launch:event` 和界面。继续使用原单行 65,536 字节、128 条通道及每次游戏正文 8 MiB 的预算，不读取历史日志、启动参数或额外文件，不改游戏启动、停止与退出码处理。
- [debug.rs](<src-tauri/src/debug.rs#L34-L58>)新增固定 `info` / `game` 来源入口，传入本次已知秘密，再由现有缓冲模块统一脱敏后入账和定向投递。stdout / stderr 在此没有可靠的严重级别，不能将 stderr 自动统计为错误；诊断接入失败被隔离，不阻断游戏或原启动日志。
- 复用[生产缓冲](<src-tauri/src/debug/buffer.rs>)的滚动限制：最多 2,000 条 / 8 MiB 序列化数据，单条连同 JSON 结构最多 8,000 字节；主动诊断只取连续最新后缀，最多 800 条 / 400 KiB。已知秘密在截断前处理，通用规则继续覆盖常见 URL、鉴权与结构化秘密；不承诺识别任意未标注秘密。原日志文件与启动事件沿用既有脱敏路径，共享缓冲另行应用通用规则。
- 原日志读取权限、主窗 / 日志窗 / 已授权工具页的定向事件和用户主动诊断上传流程保持现状；没有扩大 capability、增加公开合同成员或自动上传。共享 React / CSS、Electron 基线和 Lite 未改。
- 已执行 `cargo check --tests --locked --offline`：**exit 0，6.81s**，lib 116 / lib-test 69 warnings。通过[独立离线 harness](<.local/game-diagnostic-check-20261112-r6/src/lib.rs>)直接引用当前生产缓冲模块，仅执行既有的秘密脱敏、滚动容量和诊断最新后缀三项检查：**3 通过 / 0 失败 / 3 filtered out**；编译 9.23s，测试 5.14s。没有复制脱敏或容量算法，也没有执行 Tauri 原生测试程序。
- 本轮没有全量测试、Web 构建、Java / Minecraft、真实 profile / 账号、历史日志读取或网络上传。**实际游戏输出到窗口 / 诊断快照的全流程、真实游戏兼容及上传仍未验证**；离线缓冲检查只证明对应模块行为。Task-21 按源码、编译与这三项定向检查收口，完整功能 / 外观 / 用户数据及 Windows x64 Tauri 正式产物目标继续开放，没有提交、推送或部署。

## 17. 普通模组安装的实例兼容核验（2026-11-12 07:59，UTC+08:00）

- [普通安装 worker](<src-tauri/src/catalog/install.rs>)为资源类型 `mod` 的 `mods:install` 与 `mods:installFabricApi` 增加实例 MC / 实际加载器检查。目标仍由原目录、实例和隔离策略确定；资源包、光影以及专用 OfflineTranslate 的既有路径保持原语义，共享 React / CSS、公开 LauncherApi 和前置依赖确认弹窗没有改动。
- [实例配置证据](<src-tauri/src/resource_updates/local.rs#L270-L300>)复用既有版本继承解析，只读取目标实例及父配置，不扫描全部已安装模组。继承深度上限 32，单配置 32 MiB、配置总量 128 MiB，记录各配置身份和 SHA-512。创建 staging 前及事务提交前重新核验同一证据、目录、设置和隔离标记，配置变化或无法准确识别版本 / 加载器时拒绝发布；不承诺同权限外部进程与提交之间的原子配置 CAS。
- [兼容标签模块](<src-tauri/src/catalog/install/compatibility.rs>)将 Modrinth 官方项目类型、客户端支持和版本标签，或 CurseForge 官方文件 / 项目关联及 MC / 加载器标签，与同一文件的官方 URL、大小和哈希绑定。按完整 MC 版本和实际 Fabric / Quilt / Forge / NeoForge 比较，Forge 与 NeoForge 保持区分；Fabric API 同时检查调用方版本与目标实例，再绑定所选官方版本的真实文件。
- 下载和发布继续使用原 root lock、owned worker、取消、真实 writer 收尾和无覆盖事务；失败不发送完成 100%。没有扩大下载来源、添加未确认的依赖或改变用户安装确认。完整递归、仅版本 id 的 required 依赖及跨来源依赖处理仍待补齐，不能将本轮标签校验当作完整依赖闭环。
- 已执行 `cargo check --tests --locked --offline`：**exit 0，14.46s**，lib 116 / lib-test 69 warnings。通过[独立离线 harness](<.local/resource-install-compat-check-20261112-r7/src/lib.rs>)直接引用生产兼容模块，仅执行 Modrinth 精确标签、CurseForge Forge / NeoForge 区分及 Fabric API 目标一致性三个检查：**3 通过 / 0 失败 / 0 filtered out**，编译 4.22s，执行 0.00s。新增的错误目标不启动传输、传输中配置变化阻止发布两项安装夹具仅编译，未执行。
- 本轮没有重复全量测试、Web 构建、Tauri 原生测试程序，也没有访问真实配置 / 账号、官方网络源或启动 Java / Minecraft。**真实官方响应、下载到发布的全流程、配置竞争时序和游戏兼容仍未验证**。Task-22 按源码、编译和三个标签检查收口；完整功能、外观、用户数据迁移及 Windows x64 Tauri 发布验收目标继续开放，没有提交、推送或部署。

## 18. Windows 网易云歌词与共享 HUD（2026-11-12 09:17，UTC+08:00）

### 18.1 本轮源码接线

- [歌词协调器](<src-tauri/src/lyrics.rs>)按 `hudEnabled && hudShowLyrics && mode != local` 开关工作，不依赖游戏运行或 AI 开启。设置在后台读取，快照只投递主窗与当前 HUD；公开接口沿用无参 `music:lyricsState` 和 `music:lyricsNudge(-1 | 1)`，不增加 LauncherApi 或 capability。
- [Windows 媒体线程](<src-tauri/src/lyrics/native.rs>)通过公开 SMTC 读取已知网易云 AUMID，最多枚举 64 个会话，优先正在播放的匹配会话；采样间隔 400ms，单项元数据文本 2,048 字节。WinRT 异步操作在 2.5 秒后请求取消，仍由原线程持有操作及 Gate 票直到可确认终态；退出最多等待 5 秒，未完成则保留 owner / 失败状态。[退出链](<src-tauri/src/desktop_shell.rs#L204-L237>)分别尝试语音、歌词、HUD、球及开发工具收尾后才允许退出或重启。
- [固定歌词查询](<src-tauri/src/lyrics/network.rs>)沿用网易云搜索与歌词端点、标题 / 歌手顺序、空候选后备和最多三个匹配候选；5 秒连接 / 8 秒请求超时、2 MiB JSON、禁止重定向。原文无内容时采用翻译歌词；全部尝试均网络失败才进入网络重试状态，不把普通未匹配当作网络失败。未接受任意调用方 URL。
- [进度模型](<src-tauri/src/lyrics/model.rs>)沿用标题 / 歌手 / 已知时长判定、重复快照指纹、暂停 / seek / 切歌、±1 逐句校准、30 秒网络重试及最多 12 首缓存。LRC 512 KiB / 4,096 行、单行 2,048 字节；系统 epoch 时钟回拨遵循既有 Electron 估算公式。关闭和切歌使旧 generation 的结果失效，250ms ticker 只在显示内容变化时发布。
- [共享歌词卡片](<src/renderer/src/components/LyricsHudCard.tsx>)从 Electron HUD 提取并保留原暗色圆角、粉色来源、前 / 当前 / 后三行和 350ms 校准反馈，补齐三语；[GameHud](<src/renderer/src/components/GameHud.tsx>)与 [Windows Tauri 包装组件](<src/renderer/src/components/TauriAiHudDesktop.tsx>)共用同一组件。先订阅后取快照，新事件优先于迟到快照，卸载屏蔽迟到回调。只读 AI 卡片的移动 / 内嵌路径维持原入口。
- [同一 HUD 宿主](<src-tauri/src/ai_hud_window.rs>)由 AI 或歌词任一需求显示，按 Electron 主屏工作区右上角 20 逻辑像素及普通 360×300 / 歌词 460×420 尺寸定位。歌词命令和 `hud:setInteractive` 只作用于固定来源、精确自有 native 实例；仍须等精确 Destroyed 和 manager 双表释放才重建。穿透恢复以有界单 UI 回调读取当前鼠标点并在本页命中控制区，不记录轨迹；离开、失焦、卡片隐藏和卸载恢复穿透。

### 18.2 已执行检查与未验收项

| 检查 | 本轮实际结果 | 结论边界 |
| --- | --- | --- |
| `cargo check --tests --locked --offline` | **exit 0，22.52s**；lib 117 / lib-test 70 warnings | 修正一处固定脚本 format 花括号后通过；生产与 Rust 夹具编译，不是原生执行 |
| [生产歌词模型离线 harness](<.local/lyrics-model-check-20261112-r8/src/lib.rs>) | **4 通过 / 0 失败 / 0 filtered out**；编译 8.80s，执行 0.02s | 直接引用模型：LRC / 匹配 / 时钟回拨 / 重复采样、暂停、校准和关闭迟到结果；不含媒体 / 网络 |
| `node scripts/test-tauri-lyrics.mjs` | **4 通过 / 0 失败** | 转译真实共享 TSX；三语、DTO、订阅时序、±1 控件和穿透恢复调用；不含真实 DOM / WebView 命中 |
| `node scripts/test-tauri-ai-hud.mjs` | **24 通过 / 0 失败** | 卡片、语言、入口及移动 / 内嵌只读边界的定向回归 |
| `node scripts/test-tauri-progress.mjs` | **13 通过 / 0 失败** | 纳入固定歌词权限分支且保留其余门禁；原公开合同统计继续单独保留 |
| `npm run typecheck` / `npm run build:tauri:web` | **exit 0 / exit 0，536 modules，3.21s** | 共享 React 类型及 Tauri Web 构建；不证明跨宿主实际外观等价 |

未执行全量测试或旧 0xc0000139 原生测试程序，未读取真实用户配置 / 账号、采样真实 SMTC、联网取词、注册系统热键或启动 Java / Minecraft。**真实媒体会话 / 时间轴、歌词端点与匹配、Ctrl+Alt+[ / ] 冲突及注销、WinRT 取消终态、窗口 DPI / 全屏置顶 / 焦点 / 鼠标穿透、两宿主视觉对照仍未验证**；非 Windows 歌词仅返回关闭状态，业务校准明确不支持。Task-23 按本轮源码、编译与上述定向检查收口；完整功能、外观、用户数据和 Windows x64 Tauri 发布验收继续开放，没有提交、推送或部署。

## 19. 联机资源自检与诊断入口（2026-11-12 10:06，UTC+08:00）

- [联机诊断分发](<src-tauri/src/multiplayer.rs>)接入既有六个通道：`mp:binariesStatus`、`mp:openResourceDir`、`mp:isElevated`、`mp:parseVirtualIp`、`mp:danmakuConfig`、`mp:openExternal`。[主窗分发](<src-tauri/src/lib.rs>)在通用设置、密钥和游戏目录处理前接管；原主窗来源、DocumentAccess、通道白名单及 Gate 保持不变，只有弹幕配置等待 Storage。没有新增 LauncherApi、capability 或联机成功占位。
- [资源状态](<src-tauri/src/multiplayer/resources.rs>)只检查官方 `app.path().resource_dir()/easytier` 下固定 core / cli，保留六字段状态合同，区分缺失和不可用；拒绝链接 / reparse 路径，限制文件大小，Windows 核对基本 MZ / PE、当前架构和可执行非 DLL 标记。固定目录打开不创建目录、不接受调用方路径，也不回落到开发 vendor。检查是即时基本格式观察，不是签名、哈希来源、许可或进程可运行性证明。
- [Windows 资源映射](<src-tauri/tauri.windows.conf.json>)只列现有正式 `easytier-core.exe` 与 `easytier-cli.exe`，目标分别为 `easytier/` 下同名文件；没有混入驱动或 vendor。仓库现有构建脚本的说明不构成当前二进制来源与许可闭环，不能据此声称已具备发布合规证据；本轮没有新增或伪造许可文件。
- [纯投影](<src-tauri/src/multiplayer/model.rs>)按原规则返回首个 `10.126.126.1–254` 匹配文本并保留前导零，诊断输入最多 1 MiB；弹幕仅投影既有 enabled / fontSize / speed / opacity / tracks 五字段，合法整数浮点值沿用 Storage 语义。[权限查询](<src-tauri/src/multiplayer/platform.rs>)只读当前进程 TokenElevation，不提权、不读取账号或组信息、不启动命令；失败返回错误而不是伪报 false。系统链接交接仅允许有界、无凭据及控制字符的 http / https / mailto 地址。文件读取和系统交接在后台执行，持有独立请求票直到真实返回。
- 最终 `cargo check --tests --locked --offline`：**exit 0，8.02s**，lib-test 70 warnings；修正最后的 FFI 指针声明与整数投影后通过。通过[独立离线 harness](<.local/multiplayer-diagnostic-check-20261112-r9/src/lib.rs>)直接引用生产 model / resources：**4 通过 / 0 失败 / 0 filtered out**，编译 7.82s、执行 0.02s，覆盖虚拟 IP、五字段投影、缺失 / 合成 PE 及错误架构。Windows 配置 JSON 校验通过，两条映射源均存在；未复制算法，没有运行主 crate 原生测试程序或重复 UI / Web / 全量检查。
- **当前进程令牌 API、Tauri 资源目录与系统打开操作、真实二进制签名 / 来源 / 许可、EasyTier 启动、网络与双机互联均未实测。** 截至本节快照，大厅 / 会话、LAN、聊天和 HUD / 弹幕浮层仍待迁移；页面仍依赖未接入的大厅与成员接口，不能因六个诊断入口可达就声称联机页面或完整联机可用。后续受管 core 启停源码接线见第 20 节，不回改本节原验证范围。Task-24 按源码、编译、四项定向检查和映射校验收口，完整功能、外观、数据迁移及 Windows x64 Tauri 正式验收继续开放，没有提交、推送、部署或发布。

## 20. Windows EasyTier 受管 core 会话（2026-11-12 11:36，UTC+08:00）

- [会话分发与所有者](<src-tauri/src/multiplayer/session.rs>)接通既有 `mp:createLobby` / `mp:joinLobby`、`mp:getAppState` / `mp:getLobby` / `mp:getPlayers`、`mp:leaveLobby` / `mp:forceStop` 七个入口。沿用原主窗来源、DocumentAccess、白名单与 Gate，不增加 LauncherApi 或 capability；非 Windows 创建 / 加入明确不支持。共享 React / CSS 没有改动。
- [参数与代次模型](<src-tauri/src/multiplayer/session_model.rs>)保留大厅名、密码、玩家、节点与自身 DTO 的基线，拒绝任意程序 / 额外命令参数。固定 core 参数保留 `--no-tun`、显式 DHCP、AES-256-GCM、回环 RPC 和按节点选择的监听协议；默认节点与信令地址沿用 Electron。信令地址目前仅保留合同，尚未启动信令服务。回环临时端口选择后释放再启动仍有系统竞争，失败如实返回，未声称原子保留。
- [私有会话文件](<src-tauri/src/multiplayer/session_files.rs>)只从正式固定资源复制 core 到应用 LocalData 下本次 UUID 目录；最多 512 MiB、64 KiB 分块，取消检查、同步写入和 SHA-512 复核后持有只读程序句柄及目录祖先身份。复制哈希证明本次字节一致，不是发行来源、签名或许可认证。清理只针对本次身份目录，不扫描或删除其它会话。
- [Windows 进程所有者](<src-tauri/src/multiplayer/process.rs>)先挂起创建子进程，加入自有 `KILL_ON_JOB_CLOSE` Job 后再放行。stdout / stderr 使用 64 个有界块、每块最多 8 KiB；每管道仅前 1 MiB 参与启动识别，其余继续排空但不记日志。启动最多等待 10 秒，从当前 core 的实际输出取得虚拟 IP 后才发布当前自己成员；不虚构对端，不把虚拟 IP 当作 Minecraft 已可连接。原按镜像名杀进程的做法没有迁入，不自动提权。
- 启动取消按停止 revision 与精确 generation 保护；IPC 等待者离开不丢弃后台进程所有权。退房和 forceStop 只取消自有会话，等待 Job 空、child 已回收、管道线程已结束、私有目录清理完成，再释放票和发布 idle。五秒内未确认则返回错误，后台仍保留 owner / Gate 并继续收尾，禁止假 idle、假退出或放行重启。启动中的内部通知不发送空大厅退房事件；仅就绪及确认清理后广播。[应用退出链](<src-tauri/src/desktop_shell.rs>)独立尝试会话、语音、歌词、HUD、球及开发工具的异步收尾，一项失败不跳过其它项。
- 最终 `cargo check --tests --locked --offline`：**exit 0，6.39s**，lib 130 / lib-test 74 warnings（含私有复用目录模块带来的未使用项）；修正最初两处类型 / chrono 功能配置错误后通过。通过[独立离线 harness](<.local/multiplayer-session-check-20261112-r10/src/lib.rs>)直接引用生产会话模型：**3 通过 / 0 失败 / 0 filtered out**，编译 11.73s、执行 0.00s；覆盖参数拒绝命令覆盖、自己成员 / 大厅 DTO、旧代次与未确认清理不得发布就绪或 idle。没有复制算法，未运行主 crate 原生测试程序、重复 UI / Web / 全量测试。
- **未启动真实 EasyTier、Tauri 会话窗口、网络或 Minecraft，也未读取真实 profile / 账号。** Job / 挂起放行 / 管道回收、取消与实际退出时序、私有目录清理、端口占用及节点兼容均待原生验收；二进制来源与许可仍待闭环。对端发现、信令聊天、no-tun 转发与 LAN 世界、多人 HUD / 弹幕尚未迁完。Task-25 仅按本轮源码、编译与三项模型检查收口；完整功能、外观、用户数据迁移及 Windows x64 Tauri 正式产物目标继续开放，没有提交、推送、部署或发布。后续物理 UDP 成员与聊天源码见第 21 节，不扩大本节既有验证范围。

## 21. 同代次 UDP 成员发现与聊天（2026-11-12 12:10，UTC+08:00）

- [消息模型](<src-tauri/src/multiplayer/signaling_model.rs>)沿用 Electron 的 `player-discovery` / `player-discovery-response`、`heartbeat`、`player-left`、`chat` JSON 字段；只按实际通过格式核验的报文投影成员，不虚构对端。玩家 ID、名称、虚拟 IP 和内容仅是协议数据，**不是大厅认证或可信身份**。同一物理网段可能存在其它大厅或伪造报文，本轮没有增加密码认证或加密信令，也不声称 UDP 大厅隔离已验收。
- [唯一套接字所有者](<src-tauri/src/multiplayer/signaling.rs>)在当前 Windows core 真正输出虚拟 IP 后绑定 `0.0.0.0` 的 47777 起最多 100 个端口；非阻塞广播到既有端口及已发现物理地址。发现前 10 次每秒、之后每 5 秒，心跳 30 秒、超过 90 秒过期；离开抑制 6 秒、聊天 ID 去重 30 秒。没有调用方指定目的地址、后台探测任务或任意转发接口；**尚未接入 EasyTier 路由、回环可达目标或 no-tun 端口转发**。
- 收包最大 8 KiB、每回合最多 32 个报文；成员最多 128、离开抑制 512、去重 1024、聊天历史 300 条。聊天最长 4096 UTF-8 字节 / 2000 UTF-16 单元，拒绝危险控制字符但保留换行 / 回车 / Tab；出包每秒最多 256 次，每次同受 8 KiB 限制。正常客户端仍需实际网络验收这些新增容量上限的兼容性。报文原文不进诊断日志、无磁盘历史。
- [会话接线](<src-tauri/src/multiplayer/session.rs>)补上既有 `mp:sendChat` / `mp:getMessages`，沿用原主窗、DocumentAccess、白名单与 Gate，未新增公开 LauncherApi 或 capability。32 项有界命令队列每回合最多消费 8 项，每项保留自己的请求票至实际发送处理或拒绝；IPC waiter 离开不取消 owner。一次生成的消息 ID 同时用于线报文和本地回显；UDP send 只代表尝试交给本机网络栈，**不是对端收取回执**。本地回显不能当作远端送达。
- 当前成员快照由真实自己与实际报文成员组成，按 ID、非空虚拟 IP 和归一化名字合并；`mp:lobbyChanged` / `mp:chat` 仅向主窗指定 label 投递，保留共享 React / CSS 与既有 DTO。队列处理和事件发布前复核同代次、活动状态与取消标志。发现绑定失败时固定警告、不伪造成员，core 会话继续保留，聊天明确报服务不可用。
- 停止时同一后台线程先拒绝后续业务，消费并释放唯一 socket、拒绝排队命令，再继续既有 Job / child / reader / 私有目录清理；不留下 socket clone 或 detached send task。离开报文最多尝试一轮，发送失败不阻塞真实 socket 释放，也不冒充远端离开确认；只有原会话实际清理确认后才发布 idle 和释放 owner / Gate。
- 最终 `cargo check --tests --locked --offline`：**exit 0，6.35s**，lib 130 / lib-test 74 warnings；首次检查 13.05s 后修正多行消息校验与发布前取消复核，再执行最终增量检查。通过[独立离线 harness](<.local/multiplayer-signaling-check-20261112-r11/src/lib.rs>)直接引用生产 `signaling_model.rs` 和 `session_model.rs`：**7 通过 / 0 失败 / 0 filtered out**，编译 9.54s、执行 0.11s（2 项孤立复用 dead-code warnings）。覆盖发现回执 / 更新 / 离开抑制 / 过期、稳定 ID 与旧格式消息去重、多行与控制字符、输入及各表容量、参数和 DTO、旧代次 / 未确认收尾。没有复制算法；未运行 socket、主 crate 原生测试程序或重复 UI / Web / 全量测试。
- **真实 socket / 防火墙 / 端口冲突、跨进程收发、停止竞争、Tauri 事件到界面、EasyTier / no-tun 跨网、Minecraft 和双机连通均未验证**，没有读取真实 profile / 账号或采集真实玩家数据。LAN 世界桥与多人 HUD / 弹幕在本节时点仍未迁完；后续共享 HUD 源码见第 22 节，不扩大本节验证范围。二进制来源 / 许可及完整数据 / 外观验收仍开放。Task-26 仅按源码、最终编译与七项纯模型检查收口；完整迁移与 Windows x64 Tauri 正式产物目标保持开放，没有提交、推送、部署或发布。

## 22. 联机成员共享 HUD（2026-11-12 12:58，UTC+08:00）

- [纯显示投影](<src-tauri/src/multiplayer/hud.rs>)只读取 HUD 总开关、联机子开关和透明度；[会话接线](<src-tauri/src/multiplayer/session.rs>)以当前真实 Live 代次、非空大厅、未取消及未关闭为显示条件。最多投影 129 项（真实自己及既有最多 128 个报文成员），仅交付 `enabled`、`opacity` 及成员的 `id/name/isSelf/virtualIp`，不附带大厅密码、启动参数、路由、聊天或账号。该投影不把 UDP 身份升级为可信认证。
- Storage 初始化及成功设置提交后在后台串行刷新小设置快照；UI 回合只读该缓存与内存会话，不等待 Storage / 文件 / 密钥。实际就绪、成员更新、请求停止和确认清理均更新共享需求。退出时沿用原会话和共享窗口各自的真实收尾，不改变 owner / Gate 释放条件。
- [共享 HUD owner](<src-tauri/src/ai_hud_window.rs>)显示条件改为 AI、歌词、联机三项需求的或；仍是原固定来源、原标签及精确 native 绑定，保留 `Destroyed` 回执和双 manager 表释放后才重建的状态机。成员更新最多排一个 UI 回合，回合内核验当前自有实例并读取最新投影后以 `emit_to` 定向 HUD，不捕获旧成员列表或向其它页面广播。`mp:openHudWindow` / `mp:closeHudWindow` 重算三块内容的总需求；退房不 terminal-close 仍用于 AI / 歌词的宿主。
- 新增内部无参 `mp:hudState` 调用，只允许原受信任主窗或经精确实例核验的共享 HUD；原 DocumentAccess、生成白名单及 Gate 保持。没有新增公开 LauncherApi 方法、capability 或 HUD 的大厅 / 聊天 / 设置权限。`mp:syncOverlays` 先执行真实 HUD 重算，但弹幕部分仍明确报未实现，不能把部分接线冒充整项成功；弹幕开关、弹幕窗口与联机小窗留待后续完成。
- [MultiplayerHudCard](<src/renderer/src/components/MultiplayerHudCard.tsx>)由 [Electron GameHud](<src/renderer/src/components/GameHud.tsx>)和 [Tauri 桌面共享 HUD](<src/renderer/src/components/TauriAiHudDesktop.tsx>)复用，保留原成员顺序、圆角、背景、模糊、颜色、文字尺寸及自己标记，补齐三语；不修改共享样式表。Tauri 消费者等待 native listen 注册完成后再读内部快照，实时有效事件使迟到快照失效；卸载后迟到监听回执立即退订，迟到事件 / 快照不再写状态。Linux / macOS / 移动只读入口未因此宣称具备 Windows 联机会话。
- 最终 `cargo check --tests --locked --offline` **exit 0，8.55s**（lib 130 / lib-test 74 warnings）；第一次接线检查 15.65s 后补充后台设置串行与定向事件收口，再做最终增量检查。`npm run typecheck` **exit 0**；`npm run build:tauri:web` **exit 0，537 modules，2.45s**。没有运行主 crate 原生 Rust 测试程序或重复全量测试。
- [直接生产投影离线 harness](<.local/multiplayer-hud-check-20261112-r12/src/lib.rs>) **2 通过 / 0 失败 / 0 filtered out**，编译 4.79s、执行 0.00s，覆盖开关 / 活动条件、字段投影、透明度与人数边界；[真实共享 TSX 的定向 VM 检查](<scripts/test-tauri-multiplayer-hud.mjs>) **5 通过 / 0 失败**，覆盖三语 / 样式 / 隐藏、DTO、监听先于快照、事件优先和卸载竞争；桥与精确权限检查 **13 通过 / 0 失败**。这些检查只模拟 Hooks / 监听回执并直接复用生产函数，不是 React / WebView 或真实玩家验收。
- **共享窗口创建 / 销毁竞争、设置 / 退房与原生事件时序、DPI、全屏置顶、点击穿透、实际外观及真实联机均未实测**；没有启动 core / socket、读取真实 profile / 账号或采集真实玩家数据。Task-27 仅按源码、最终编译 / 前端构建和上述定向检查收口；no-tun / LAN、弹幕 / 小窗、真实用户数据迁移、二进制来源 / 许可及完整 Windows x64 Tauri 发布验收仍开放，没有提交、推送、部署或发布。

## 23. Windows 联机弹幕窗口（2026-11-12 19:20，UTC+08:00）

- [独立弹幕宿主](<src-tauri/src/multiplayer/danmaku.rs>)复用同一受管联机会话的真实聊天，按当前 generation 入有界 mailbox；[消息投影](<src-tauri/src/multiplayer/danmaku_model.rs>)只保留既有 `MpDanmaku` 五项展示字段，拒绝格式无效内容，最多保留 60 条待显示消息。设置只投影既有弹幕开关、字号、速度、不透明度与轨道数；不读取账号、密码、完整设置或主窗状态。
- 窗口沿用 Electron 固定 `index.html?window=danmaku`、独立透明全屏、置顶、不抢焦点和鼠标穿透预期；它与 AI / 歌词 / 成员 HUD 分属各自宿主，不能用退房清理共享 HUD 的方式关闭弹幕。页面挂载后先注册现有 `launcher:event` 监听，再通过窄权限 `mp:danmakuConfig` 完成 ready / 配置握手；实时消息优先于迟到配置，卸载清理 listener、resize 与动画 timer。UI 与既有 `DanmakuOverlay` JSX / 样式未改。
- 仅弹幕 label 获得 `core:event:allow-listen` 与 `core:event:allow-unlisten`；桥仍只允许 `mp:danmakuConfig`，后端以精确来源 / native 实例再次授权。聊天通过 `emit_to` 投递到该固定 label，不广播到主窗或其它页面。窗口打开的成功语义是原生窗体可见；页面 ready 后才接收配置并刷新队列，不把可见误报为完整页面或网络就绪。
- 显式 open / close 与 automatic `syncOverlays` 使用单调控制意图；被更新意图取代的等待请求返回 superseded。生命周期只有在同一实例收到 `Destroyed` 且 Window 与 Webview manager 表同时无该标签后才释放 Gate；销毁后的双表检查间隔 250ms、最多 8 次，超限仍保留不确定 owner。只有创建前纯边界失败被标为可恢复，并且后续 UI 回合确认两表均空后才能清除；builder / native / destroy 队列错误不得因缺少本地句柄而伪恢复。退出时 multiplayer session 与 Danmaku 分域异步收尾。
- 最终 `cargo check --tests --locked --offline`：**exit 0，7.34s**，lib 133 / lib-test 75 warnings。独立离线 harness `<.local/danmaku-lifecycle-check-r13/src/lib.rs>` 直接引用生产生命周期、联机模型与弹幕投影：**15 通过 / 0 失败 / 0 filtered out**；[弹幕真实 TSX 定向检查](<scripts/test-tauri-danmaku.mjs>) **2 通过 / 0 失败**；[桥与精确权限检查](<scripts/test-tauri-progress.mjs>) **13 通过 / 0 失败**；`npm run typecheck` exit 0。没有运行 Rust 测试可执行文件、全量测试、Web 构建或真实窗口。
- **真实窗口创建 / 重建竞争、Windows DPI、鼠标穿透、置顶与全屏、多显示器、socket / EasyTier / 对端消息、真实 profile 与组网均未实测**；离线模型和 TSX 夹具不证明原生窗口或 Minecraft 联机等价。Task-28 仅按源码、最终 Rust 编译及直接生命周期 / 投影 / TSX / 权限检查收口；完整迁移、数据兼容、跨宿主完整外观对照及验收后的 Windows x64 Tauri 产物仍未完成。没有提交、推送、部署或发布。


## 24. Windows 联机小窗与受限页面（2026-11-13 22:36，UTC+08:00）

- [小窗宿主](<src-tauri/src/multiplayer/mini.rs>)接入既有 `mp:openMiniWindow` / `mp:closeMiniWindow` / `mp:miniState` / `mp:miniResize` / `mp:hasMainWindow`，另以内部 `mp:miniDrag` 代替 Electron app-region；不增加公开 LauncherApi 方法或通用 window capability。固定 `index.html?window=mini`、精确 native 身份和[独立 capability](<src-tauri/capabilities/mini.json>)保持最小事件权限；[业务白名单](<src-tauri/src/multiplayer.rs>)只允许小窗快照、聊天、退房、尺寸与拖动，非 Windows 明确不支持。
- 普通 close 只撤销本次显示请求，销毁确认后可再次 open；应用退出才进入 terminal。窗口存活及清理期间保留 owner / Gate，只有精确 `Destroyed` 且 Window / Webview 双表为空才释放。native 操作在短 UI 回合执行，事件改为合帧异步投递，没有线程运行时内 `block_on`；成员快照读取最新状态，聊天邮箱最多 300 条并按会话代次失效。
- [共享 MiniWindow](<src/renderer/src/components/MiniWindow.tsx>)与[聊天](<src/renderer/src/components/MultiplayerChat.tsx>)先订阅再读快照，实时事件优先于迟到快照，卸载屏蔽迟到回调。[挂载入口](<src/renderer/src/mini-bootstrap.tsx>)先完成受限握手再创建唯一 React root；[共享 Provider](<src/renderer/src/store.tsx>)只接收外观投影，不读取完整设置、壁纸、账号、目录或密钥，也不重复执行主窗启动检查。小窗快照不交付大厅密码、节点或信令地址。
- `cargo check --tests --locked --offline` **exit 0**；`npm run typecheck` **exit 0**；`npm run build:tauri:web` **exit 0，537 modules / 4.04s**；`npm run build` **exit 0，renderer 536 modules / 2.53s**。[小窗真实 TSX 定向检查](<scripts/test-tauri-mini.mjs>) **5 通过 / 0 失败**，覆盖快照与聊天事件顺序、卸载、单 root、拖动和权限；桥 **13/0**、弹幕 **2/0**、共享 HUD **5/0** 均通过。
- Windows `cargo test --lib --locked --offline multiplayer::mini::tests` 在链接阶段因 SDK 环境缺少 `combase.lib` 以 `LNK1181` 结束，未进入测试。WSL 首次实际执行为 **3 通过 / 1 失败**：旧夹具在显示需求仍为 true 时错误期望 Destroy；改为显式关闭需求后，最终小窗生命周期 **4/4（927 filtered）**，外观投影与窄白名单 **2/2（929 filtered）**。修正没有放宽精确回执、双表清理、普通关闭重开或 terminal 不可重开的断言。
- **真实小窗创建 / 重开、拖动、折叠尺寸、DPI、多显示器、焦点、置顶、实际外观、设置 / 退房竞争、core / socket / EasyTier / Minecraft 与双机互联均未实测**；没有读取真实 profile / 账号或采集真实玩家数据。本批只按源码、编译、WSL 生产状态夹具与 TSX 定向检查收口；no-tun / LAN、二进制来源 / 许可、完整数据与外观迁移及 Windows x64 Tauri 发布验收仍开放，没有提交、推送、部署或发布。

## 25. Windows Rust 测试链路打通（2026-11-14 05:34，UTC+08:00）

- 第 24 节的 Windows `LNK1181: combase.lib` 已定位：本机 SDK（10.0.26100.0 `um/x64`，482 个 lib）独缺该文件，正规修复为修复 / 重装 Windows 11 SDK；当前以 `.local/sdk-shim/combase.lib`（`dumpbin //exports` 本机 `combase.dll` + `lib //def` 生成，gitignore）经 `LIB` 环境变量注入，未改动仓库或全局环境。
- 链接通过后测试 exe 启动即 `0xc0000139 (STATUS_ENTRYPOINT_NOT_FOUND)`：根因是测试可执行文件没有应用清单，`comctl32.dll!TaskDialogIndirect` 静态导入只绑定到 System32 的 v5.82（无此导出），与旧批次 HUD 测试进程同现象。[build.rs](<src-tauri/build.rs>) 在 Windows target 输出 `cargo:rustc-link-arg=/MANIFESTDEPENDENCY:…Common-Controls v6…` 修复，cdylib 与测试链接均自带 v6 依赖；`mt -inputresource` 曾确认原 exe 无任何清单资源。
- [通道守卫断言](<src-tauri/src/lib.rs>)与前端约定对齐：types.ts 全量 215 invoke = 公开 212 + 3 个内部通道（`ai:voiceState` / `mp:hudState` / `mp:miniDrag`），断言改为 215 全量且剔除内部后 212，公开 239 合同不变。
- 修复后 Windows `cargo test --lib --locked --offline`（`--test-threads=4`）**917 通过 / 0 失败 / 0 ignored，执行 48.49s**；此前并行首轮中 `downloads::tests::bounded_concurrency_dedup_and_cache` 的 1 次失败在单线程复跑与全量复跑中均通过，记为并行时序敏感。`test-tauri-mini` **5/0**、`test-tauri-progress` **13/0**、`test-tauri-danmaku` **2/0**、`test-tauri-multiplayer-hud` **5/0** 复跑通过；`git diff --check` 干净。
- `npm run build:tauri`：Web 与 Rust release 编译成功（`hcmcl-tauri.exe`，release 5m27s，112 条既有 warning）；打包阶段 WiX / NSIS 及 `nsis_tauri_utils.dll` 的 GitHub 下载在本网络多次 `timeout: global`，已按 tauri-bundler 的固定 URL 与 SHA1 经镜像预置到 `%LOCALAPPDATA%/tauri/{WixTools314,NSIS}`（哈希核对一致，未改仓库）。`bundle --bundles nsis` 成功产出 `target/release/bundle/nsis/HungerCat MineCraft Launcher_0.7.6-dev2_x64-setup.exe`（13.30 MiB）；`--check` 完整性 288 个对象 0 个 Low。MSI 目标因版本号预发布段 `dev2` 非纯数字被 WiX 规则拒绝，属版本方案限制，不是编译缺陷。产物未安装、未启动、未签名验证。
- 本节只证明 Windows 本机当前源码的编译与单元测试；真实窗口、DPI、拖动、组网、安装包安装与干净机验收仍未做，没有提交、推送或发布。

## 26. 覆盖安装旧 Electron 版与用户数据迁移（2026-11-14，UTC+08:00）

- 目标：Tauri NSIS 安装包可直接覆盖安装旧 Electron 版并保留用户数据。分三层落地：
  1. **安装器**：[installer-hooks.nsh](<src-tauri/installer-hooks.nsh>) 经 `bundle.windows.nsis.installerHooks` 接入，PREINSTALL 阶段查 HKCU/HKLM 卸载键 `com.hungercat.launcher`（旧版 appId），以 `/S` 静默运行旧卸载器并有界等待（60×500ms）旧主程序文件消失。electron-builder 卸载默认保留 %APPDATA% 用户数据；本钩子只移除旧程序文件。旧版按全机器（HKLM）安装时卸载器可能因权限失败，此时安装继续、旧文件保留，数据迁移不受影响——该边界未实机验证。
  2. **运行时迁移**：[storage/migration.rs](<src-tauri/src/storage/migration.rs>) 在新数据目录无状态文件且旧 Electron userData 目录存在时首启迁移：设置逐键白名单校验（未知 / 派生 / 坏值键跳过）、账号白名单字段经 `validate_account`（在线账号凭据由既有 persist 提取进系统 keyring，绝不写进状态文件）、`uapis-key.bin` / `ai-key.bin` 经 Windows DPAPI / Linux basic_text 解密进 `api:*` 槽位、`homepages` / `wallpapers` / `homepages.json` 有界复制（2000 文件 / 单文件 512MiB，只复制不删除不覆盖）。macOS safeStorage（v10/v11）与反馈会话不迁移；CurseForge Key 在 Tauri 端无对应设置字段，跳过待后续接线。迁移失败一律回落全新默认数据，不阻断启动；测试构建（`cfg(test)`）不触发真实迁移。
  3. **服务端**：[releases.php](<server/releases.php>) 的 `hc_update_for_target` 在版本没有 Electron 产物时回退到同 target 的 Tauri 安装包（win→nsis/msi、mac→dmg、linux→appimage），载荷带 `migrateRuntime: 'tauri-v2'` 标记，选择顺序与既有 `hc_pick_version_for_target` 一致；有 Electron 产物时绝不回退，Tauri 客户端也绝不回退 Electron 产物。内联 PHP 验证四组场景：迁移兜底命中、Electron 产物优先、无匹配 target 空版本、latestVersion 优先。
- 验证：Windows `cargo test --lib --locked --offline storage::` **42 通过 / 0 失败**（含 4 个迁移夹具：设置白名单与派生剔除、账号校验与选中回退、无可识别文件不迁移、资源有界复制不覆盖）；`php -l server/releases.php` exit 0；NSIS 重打包成功（makensis 编译钩子无错误）。
- **未验证**：真实覆盖安装全流程（旧版在位 → 安装新版 → 数据迁移 → 启动）未实机执行；DPAPI 解密只在真实旧数据上才有意义，夹具未覆盖；HKLM 全机器安装的权限边界、卸载器静默行为、多显示器 / 杀软干扰均未测。服务端改动未部署；`server/` 五个测试文件（test-admin-release.mjs / test-downloads.php / test-index-render.php / test-lite.php / test-s3.php）已按用户要求删除。没有提交、推送或发布。

## 27. Electron 源码归档至 HCMCL_old 与 win x64 安装包（2026-11-14，UTC+08:00）

- 目标：仓库根变为纯 Tauri 产品，Electron 宿主整体归档；同时交付最新 win x64 NSIS 安装包。
- **归档（`HCMCL_old/`，tracked 文件用 `git mv`）**：`src/main`、`src/preload`、`electron.vite.config.ts`、`electron-builder.yml`、`tsconfig.node.json`、`build-all.cmd/.sh`、`build/`（图标）、`native/`（Electron 原生下载器）、`out/{main,preload,renderer}`、`.github/workflows/build-mac.yml` → `HCMCL_old/build-mac.yml`（mac CI 已停用）；Electron 专属脚本与测试（build-all.mjs、build-native-downloader.*、test-lyrics / test-settings-layout / test-portable-paths / test-update-resolve / test-loader-install / test-account-import / test-download-progress / test-smtc-* / test-version-type 等）移入 `HCMCL_old/scripts/`。留根脚本为全部 `test-tauri-*` 与 test-i18n / test-player3d / test-custom-rows / test-window-lifecycle / test-debug-log-window / fix-artifact-integrity / prepare-* / verify-publication 等 Tauri 与共享工具。
- **package.json**：`dev` 改为 `tauri dev`；删除 build / start / preview / win / dist* / native:build* / Electron 专属 test:* 脚本；`typecheck` 只剩 `tsc --noEmit -p tsconfig.web.json`。electron / electron-builder / electron-vite 依赖**有意保留**在 devDependencies，未清理（`HCMCL_old` 对照构建仍可用根 node_modules）。
- **AGENTS.md**：速览改为「Electron 已归档」、§3 mac 工作流指向 `HCMCL_old/build-mac.yml`（停用）、最低验证改为 `build:tauri:web`、§5 标注「代码已归档仅供对照」、§7 测试清单改为遍历留根 `scripts/test-*.mjs`、§8 检查单同步。
- **验证（移动后）**：`npm run typecheck` exit 0；`npm run build:tauri:web` exit 0（537 modules）；`cargo check --lib --locked --offline`（含 sdk-shim LIB）exit 0；留根 19 个 `scripts/test-*.mjs` **合计 256 通过 / 0 失败**。Rust 代码未受移动影响（build.rs 引用的 `src/tauri` / `src/renderer` 未动）。
- **安装包**：迁移代码之后的 `src-tauri/target/release/bundle/nsis/HungerCat MineCraft Launcher_0.7.6-dev2_x64-setup.exe`（13.30 MiB）为当前最新，已复制为 `release/HCMCL0.7.6-dev2-win-x64-setup.exe`；`fix-artifact-integrity --check` 288 个对象 0 个 Low。本次归档只移动源码，未重新打包。
- **注意**：`HCMCL_old/` 内脚本假定自身在仓库根运行（相对路径 `src/main` 等），直接进该目录对照阅读可以，从根目录直接运行会找不到文件；mac 构建工作流已停用，mac 产物暂无构建通道。electron 依赖保留未清理是有意决定。
- **未验证**：归档后未重新跑全量 `cargo test`（Rust 代码未变，Windows 全量 917/0 为移动前结果）；安装包未实机安装；未提交、推送、部署或发布。

## 28. 覆盖安装与数据迁移的本机实测修复（2026-11-14，UTC+08:00）

- 起因：用户报告 0.7.6-dev2 NSIS 包无法覆盖安装旧版、无法保留旧版数据。第 26 节的实现当时只做过源码级检查，未实机验证。
- **诊断过程的关键发现**：本机测试时两个 NSIS 安装器都「挂起」，根因不是产品缺陷而是测试方法——Git Bash 路径转换把 `/S` 变成 `S:/`，安装器进入 GUI 模式在无控制台的后台干等；`MSYS_NO_PATHCONV=1` 后静默安装 2.7 秒完成。另外 `$!` 是 MSYS pid，杀不掉真实 Windows 进程（迁移测试残留了 4 个 hcmcl-tauri 窗口进程，已清理）。
- **真实修复（唯一的产品级缺陷）**：旧版正在运行时主程序文件被占用，electron 卸载器删不掉 → 新旧两版并存，表现为「无法覆盖安装」。[installer-hooks.nsh](<src-tauri/installer-hooks.nsh>) 在 ExecWait 之前插入 tauri 模板自带的 `CheckIfAppIsRunning`（RestartManager）处理旧 exe：静默安装直接结束旧进程，GUI 模式弹窗询问；超时仍删不掉时只记录 DetailPrint，不阻断新版安装。重打包 makensis 编译无错误。
- **本机实测（仿真旧版卸载键 + 真实新安装包 `/S`）**：旧程序目录被移除、新卸载键写入、旧用户数据目录原样保留。首启迁移实测通过：`theme/language/maxDownloadConcurrency` 等设置落进新状态文件；离线账号（`offline_uuid` 与 `accessToken:'0'` 与旧版 store.ts 一致）迁移并保留 selected；PowerShell 现场构造的 `DPAPI`+CryptProtectData 密文被解密进 `api:uapis` 槽位；`wallpapers/marker.txt` 与 `homepages.json` 复制到位、不覆盖已有文件。测试中两次「账号被拒」均为夹具错误（id 非 offline_uuid、accessToken 非 '0'），非产品缺陷。
- **环境限制（未验证项）**：真实 electron 安装器（0.7.6-dev1，80MB）在本机静默安装挂起约 5 分钟无进展（CPU≈0，疑似本机 Kaspersky 干预），真实 electron 卸载器的注册表格式与数据保留行为未能实机复核，依据的是 electron-builder 既有约定（卸载键=appId、默认不删 %APPDATA%）；HKLM 全机器安装、GUI 模式询问弹窗未实机演练；`CheckIfAppIsRunning` 对真实运行中旧进程的强制结束未实测（本机连 notepad 副本都被环境拦截无法启动）。
- 产物：`release/HCMCL0.7.6-dev2-win-x64-setup.exe` 已更新为含新钩子的重打包（13.30 MiB），完整性 288 对象 0 Low。测试残留（假旧版目录 / 注册表键 / 迁移出的新数据目录 / 新版安装）已全部清理。没有提交、推送或部署。


## 29. 真实 Electron 覆盖安装、已有状态补迁与 8.0.0-dev1 交付（2026-11-14，UTC+08:00）

- 第 28 节的仿真验证没有覆盖真实 Electron 的注册身份和数据目录，因此当时仍有两个实际缺陷：卸载键误用 `com.hungercat.launcher`，读不到真实旧版；迁移目录误用带空格的产品名，且已有 `storage-state.json` 时永不补迁。本节取代第 28 节中「真实 electron 安装器未验证」「卸载键=appId」的旧结论。
- **真实身份与安装模式**：旧 Electron 卸载键为 `Software\Microsoft\Windows\CurrentVersion\Uninstall\92545c4c-67bc-5d37-9e32-fd7da970a258`，安装路径在 `Software\92545c4c-67bc-5d37-9e32-fd7da970a258` 的 `InstallLocation`。真实数据目录来自 [Electron app.ts](<HCMCL_old/src/main/app.ts>) 的 `app.setName('HungerCatLauncher')`，Windows 为 `%APPDATA%\HungerCatLauncher`；新版目录仍为 `%APPDATA%\top.johnnyblog.hcmcl`。
- [安装钩子](<src-tauri/installer-hooks.nsh>)分别查 HKCU / HKLM 的 GUID 卸载项与安装目录，复用旧路径并保留用户数据；[Windows 配置](<src-tauri/tauri.windows.conf.json>)使用 `installMode: both`。卸载器复制到 `$PLUGINSDIR` 后以 `_?=` 等待，带 `/S /KEEP_APP_DATA --updated /currentuser|allusers`，再最多等待 60×500ms 让旧主程序消失。失败或残留中止安装；目标目录之外的旧 Tauri 也清理，避免错误版本造成的两版并存。`CheckIfAppIsRunning` 必须位于 PREINSTALL 宏内，否则 `nsis_tauri_utils` 尚未注册，NSIS 编译失败。
- [运行时迁移](<src-tauri/src/storage/migration.rs>)改用真实 `HungerCatLauncher` 目录，并增加已有新状态文件时的一次性补迁：新版非默认设置、现有账号与选中账号优先，默认项采用旧值；成功提交后写 `.electron-migration-v1.json`，避免以后重复导入已删除账号。[Storage 接线](<src-tauri/src/storage.rs>)只在首次迁移或补迁时持久化并写完成标记，原有白名单、凭据安全存储和有界资源复制不变。
- **真实覆盖安装验证**：先安装真实 `release/HCMCL0.7.5-alpha3-win-x64-setup.exe`，重现 Electron 位于 `C:\Program Files\HungerCat MineCraft Launcher`、旧 Tauri 另装于 `%LOCALAPPDATA%\HungerCat MineCraft Launcher` 的两版并存；再安装功能版 `8.0.0-dev1`。实测旧 Electron 主程序和 GUID 注册项消失，新版保留在原 Program Files 目录，另装 Tauri 主程序及 HKCU 卸载项清理，新 HKLM 卸载项和主程序 FileVersion 均为 `8.0.0-dev1`；两个真实用户数据目录保持存在。
- **两种迁移路径实测**：为避免读取或修改真实账号 / 密钥，先临时改名保存两个真实数据目录，以合成离线账号、设置、主页和壁纸分别验证「已有空 storage-state.json 的补迁」和「完全没有新状态文件的首次迁移」。两者均正确迁入 `theme=dark`、`language=en`、`maxDownloadConcurrency=7`、账号 `MigrationTest`、选中 ID、主页与壁纸；旧文件未删除，新状态文件中无明文 `accessToken`。合成夹具已删除，真实用户目录已恢复；恢复后未再启动新版，因此没有用本轮测试改写真实新状态。
- **检查与最终产物**：`npm run typecheck` 通过；根目录全部 19 个 `scripts/test-*.mjs` 通过；Windows `cargo test --manifest-path src-tauri/Cargo.toml storage::migration::tests -- --nocapture` **7 通过 / 0 失败**。最终 `npx tauri build --bundles nsis` exit 0，NSIS 构建成功，既有 Rust warning 不作为本轮功能失败。交付包为 [HCMCL8.0.0-dev1-win-x64-setup.exe](<release/HCMCL8.0.0-dev1-win-x64-setup.exe>)，13,964,108 字节（13.32 MiB），FileVersion `8.0.0-dev1`，SHA-256 `05bf241a396a0c723bb98054a62b3f755681b363bbb499ea11c8fb3972863295`；完整性检查 **289 个对象 / 0 Low**。最终包另以 PowerShell `Start-Process -Wait -ArgumentList '/S'` 安装烟测通过，结束时仅一项 HKLM 新版安装记录，Electron 与重复 Tauri 项均不存在。
- 版本已同步至 `8.0.0-dev1`：`package.json`、`package-lock.json` 两处、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 与 `src-tauri/Cargo.lock`。
- **仍未验证**：标准非管理员账户的 UAC 流程、HKCU Electron 安装、GUI 弹窗、旧版运行中的强制关闭、真实在线账号 / DPAPI 的本轮端到端、便携版数据迁移。便携版 exe 旁 `./HCMCL` 不在本模块范围。本轮只验收上述覆盖安装与迁移路径，不外推为完整游戏、真实网络、原生窗口或全平台发布验收；未提交、推送或部署。


## 30. HUD 阴影、AI 悬浮球 / 对话修复与 0.8.0-dev2 交付（2026-11-15，UTC+08:00）

- **HUD 阴影**：[共享 HUD 宿主](<src-tauri/src/ai_hud_window.rs>)在透明、无边框窗口上补充 `.shadow(false)`，不改变固定来源、精确实例及销毁双表门禁。[前端定向回归](<scripts/test-tauri-ai-hud.mjs>)增加阴影断言，最终 **25 通过 / 0 失败**。标准发布二进制在隔离设置下实际创建 460×420 歌词 HUD，窗口外扩 24 像素的截图未见系统投影；该证据仅覆盖当次 Windows 原生场景，不外推为全部 HUD 内容、DPI、穿透与媒体时序验收。
- **AI 悬浮球根因与修复**：真实诊断显示 builder、尺寸设置与 `show()` 均成功，但首次 `ai:ballExpanded` 投递时 WebView 仍报告 `about:blank`，固定来源授权拒绝后状态机将窗口销毁。[首次同步判断](<src-tauri/src/ai_ball.rs>)现在只对这一过渡态返回等待，合法打包页面才允许同步，外部或错误页面仍然拒绝；[原生显示路径](<src-tauri/src/ai_ball/native.rs>)在页面未就绪时返回 `Step::Wait`，没有放宽 `allowed_url`。新增 Rust 回归先以缺少函数编译失败证明覆盖有效，修复后全量 **925 通过 / 0 失败**。标准构建后的同一二进制实测持续存在可见 76×76 AI 球，截图显示蓝色圆形消息按钮，不再发生 Create → 首次事件失败 → Destroy。
- **主窗「对话」板块**：新增 [AiChatPage](<src/renderer/src/pages/AiChatPage.tsx>)，复用既有 `ai.chat/cancel/reset`；[Sidebar](<src/renderer/src/components/Sidebar.tsx>)只在 AI 开启且非 local 模式显示「对话」，路由保留 AI 开关兜底，三语 `nav.chat` 已同步。[定向检查](<scripts/test-tauri-ai-chat.mjs>) **2 通过 / 0 失败**；隔离原生实例中通过真实鼠标点击进入该导航，截图确认 AI 助手聊天页、输入区与新对话按钮正常显示。没有发起在线 AI 请求。
- **验证方法与资源边界**：早期仅用 `cargo build` 的诊断程序缺少 `out/tauri` 前端资源，出现空白 WebView；该现象不冒充产品渲染结论。最终改用标准 `npx tauri build --bundles nsis`，先构建 538 个前端模块，再编译 Rust 与 NSIS，并以同一个发布 exe 复验。合成设置只含开关，无真实账号或密钥；真实新旧数据目录在每次夹具运行后均恢复，最终确认真实 Roaming 目录存在、备份与 `.local/ai-ball-repro-20261115` 夹具均已删除。
- **完整检查**：`npm run typecheck` exit 0；根目录全部 **20 个** `scripts/test-*.mjs` 合计 **253 通过 / 0 失败**；Windows `cargo test --manifest-path src-tauri/Cargo.toml --lib` **925 通过 / 0 失败**（27.13s）；`git diff --check` 无错误（只有既有换行提示）。六处版本号一致：`package.json`、`package-lock.json` 两处、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 均为 **0.8.0-dev2**。
- **安装包**：`npx tauri build --bundles nsis` exit 0，目标 NSIS 已复制为 [HCMCL0.8.0-dev2-win-x64-setup.exe](<release/HCMCL0.8.0-dev2-win-x64-setup.exe>)，**13,952,373 字节（13.31 MiB）**，FileVersion **0.8.0-dev2**，SHA-256 **`de3293d370e7a52d7d052f42a1f9a9526449c4ff91eaef289404dd0f3a4ea0c0`**；`node scripts/fix-artifact-integrity.mjs --check` 为 **290 个对象 / 0 Low**。
- **仍未验证**：本版安装包未重新执行真实覆盖安装、标准用户 UAC、干净机启动与数据迁移；旧 Electron 覆盖和补迁证据见第 29 节，不能自动外推为本包安装验收。未测试真实在线 AI 对话、账号、Minecraft、完整 SMTC / 网络歌词时序、多显示器 DPI、全屏置顶、鼠标穿透或跨平台外观。本轮未修改 `HCMCL_old/`、未更新服务端，未提交、推送、部署或发布。


## 31. 覆盖安装数据保留与服务端适配修复、0.8.0-dev2 重交付（2026-11-15，UTC+08:00）

- **根因一（先卸载再安装丢数据）**：NSIS 原生「Already Installed → 先卸载再安装」流程中，安装器调用旧版卸载器时不带任何保留参数；用户一旦勾选 *Delete the application data*，旧卸载器按勾选删除用户数据。新版安装器此前未干预卸载参数。旧包基线（SHA-256 `de3293…`）已在本机复现勾选删除后标记数据被删（`OLD_DELETED=True`）。
- **修复一**：[installer.nsi](<src-tauri/installer.nsi>)（基于 Tauri CLI 2.12.4 官方模板）在 `PageLeaveReinstall` 卸载分支、`/P` 与 `_?=` 之前向卸载参数追加 `/KEEP_APP_DATA /UPDATE`；[installer-hooks.nsh](<src-tauri/installer-hooks.nsh>) 新增 `HcKeepAppData`，`NSIS_HOOK_PREUNINSTALL` 检测到该参数后强制 `DeleteAppDataCheckboxState 0`、`UpdateMode 1`。`/UPDATE` 为旧版 Tauri 卸载器**原生支持**，因此已发布的旧安装无需换卸载器即可保数据；用户从开始菜单**独立卸载**不携带该参数，保留明确删除数据的能力。[tauri.windows.conf.json](<src-tauri/tauri.windows.conf.json>) NSIS 增加 `"template": "installer.nsi"`。
- **根因二（未适配最新服务端）**：`server/lite.php` Tauri 清单的布尔字段与 Rust 端解析不一致；Rust [services.rs](<src-tauri/src/services.rs>) `parse_url()` 上限 4096、`artifact_filename()` 上限 160 且禁止 `+`，而服务端契约是最长 **8192** 字节 URL、最长 **180** 字节产物名且**允许 `+`**。
- **修复二**：`services.rs` 上限改为 8192 / 180 并允许 `+`，新增 Rust 回归 `tauri_update_accepts_the_php_artifact_filename_and_url_contract`；`lite.php` 用 `hc_version_prerelease()` / `hc_version_important()` 归一化布尔字段。
- **静态验证**：`npm run typecheck` 0 错误；全部 **21 个** `scripts/test-*.mjs` 通过（新增 [test-tauri-installer.mjs](<scripts/test-tauri-installer.mjs>)，**6 通过 / 0 失败**）；`cargo test --manifest-path src-tauri/Cargo.toml --lib`（SDK shim）**926 passed / 0 failed**；`php -l server/lite.php` 无语法错误；`npx tauri build --bundles nsis` exit 0。
- **真实 GUI 实测（提权 UIAutomation）**：临时脚本把三个数据目录的真实内容以 GUID 备份后换入合成标记，结束或失败一律恢复。完整 old→new 场景：旧包安装 → 写入标记 → 新包走「Already Installed → Uninstall（**勾选 Delete the application data**）→ 重装」→ 断言 **`NEW_PRESERVED=True NEW_UNINSTALL=True`、`INSTALLER_DATA_TEST=PASS`、`REAL_DATA_RESTORED=TRUE`**，新包安装器退出码 0。即新安装器在**勾选删除数据**的卸载重装路径下仍保住了用户数据；旧基线同一路径会删数据（已复现），修复有效。测试自动化结论：NSIS 完成页的 *Finish* 按钮 UIA Invoke 静默无效，必须物理鼠标点击（已记录，后续复测直接用）。真实 `storage-state.json` 恢复后确认在位，临时脚本与日志已删除。
- **交付包**：[HCMCL0.8.0-dev2-win-x64-setup.exe](<release/HCMCL0.8.0-dev2-win-x64-setup.exe>) 已由修复版重新复制，**13,966,148 字节（13.32 MiB）**，FileVersion **0.8.0-dev2**，SHA-256 **`a7f52938281a682c2e1fbb1696137b754972d3964684bb3d8bc90fa92beb7e19`**；`node scripts/fix-artifact-integrity.mjs --check` 为 **290 个对象 / 0 Low**。测试机最终状态：修复版已装于 Program Files，HKLM 卸载项 `0.8.0-dev2`。
- **服务端边界**：`server/lite.php` 仅本地修改，**未部署**；线上 `api.php?action=update&runtime=tauri-v2&target=win32-x64` 现返回空 Tauri 清单（线上 `latestVersion` 为 0.7.4 且无 `tauriArtifacts`），客户端显示无更新是合理行为，不代表适配失效。
- **仍未验证**：干净机覆盖安装与标准用户 UAC（本轮为管理员账户实机）；服务端部署后 Tauri 更新链路的真实端到端（当前线上无 Tauri 清单可拉）；真实账号 / Minecraft / 网络端到端。不外推为完整发布验收；未提交、推送或部署。


## 32. 首启「正在加载协议…」卡死：存储快照 BOM 兼容性修复（2026-11-15，UTC+08:00）

- **现象**：首启欢迎弹窗永远停在「正在加载协议…」，界面整体呈默认状态；进程无任何外发 TCP/UDP 连接，即协议请求从未发出。
- **定位方法**：以 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 启动安装版，经 CDP `Runtime.evaluate` 手动调用 `window.api.about.agreementStatus()` 得到拒绝原因 `存储快照损坏，原件已保留`；前端设置加载被拒 → `settings` 永空 → 协议核对 effect 因 `!settings` 永不执行 → 弹窗恒为加载态。
- **根因**：`%APPDATA%\top.johnnyblog.hcmcl\storage-state.json` 被带 **UTF-8 BOM** 的写法落盘（此前测试夹具经 PowerShell `Out-File` 类写入遗留），`serde_json::from_slice` 不接受 BOM → `read_state` 判定快照损坏 → 存储初始化失败 → 全部依赖存储的 IPC 拒绝。
- **修复**：[storage.rs](<src-tauri/src/storage.rs>) `read_state` 在解析前剥掉单个前导 UTF-8 BOM；既有测试 `invalid_snapshot_and_failed_write_preserve_original` 增加两条断言：带 BOM 的合法快照可解析且内容一致、带 BOM 的非法 JSON 仍报错。数据级同步修复本机现场文件（备份后 `tail -c +4` 去 BOM，JSON 校验通过）。
- **实测**：修复后重启安装版，`settings.get()` 正常返回；`about:agreementStatus` 经 CDP 实测返回 `needsConsent=true`、正文完整（隐私 3088 字、条款 1960 字、`updatedAt=1787457722000`），用户确认弹窗协议显示正常。诊断脚本与备份等临时文件已删除。
- **检查与产物**：`npm run typecheck` 0 错误；全部 **21 个** `scripts/test-*.mjs` 通过；`cargo test --lib` **926 passed / 0 failed**（新增断言并入既有用例）；`npx tauri build --bundles nsis` exit 0。安装包已重新复制为 [HCMCL0.8.0-dev2-win-x64-setup.exe](<release/HCMCL0.8.0-dev2-win-x64-setup.exe>)，**13,955,629 字节（13.31 MiB）**，FileVersion **0.8.0-dev2**，SHA-256 **`2e43c65127839cfb6b47432b96ed23e25f380dfc95ea28eb62fe1e56c295664b`**；`fix-artifact-integrity.mjs --check` **289 个对象 / 0 Low**。
- **仍未验证**：BOM 修复在干净机/真实损坏快照下的恢复路径（本机验证的是合法 BOM 快照）；其它平台数据目录。服务端协议接口本身经线上只读核验正常（第 31 节），本轮未改服务端。未提交、推送或部署。


## 33. 0.8.0-dev3 版本提升、硬件加速投影 BOM 兼容，及「三子进程拆分」核查结论（2026-11-15，UTC+08:00）

- **版本**：六处同步至 **0.8.0-dev3**：`package.json`、`package-lock.json` 两处、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`；AGENTS.md 与 plan.md 头部的「当前版本」行同步更新。
- **硬件加速启动投影 BOM 兼容**：[hardware_accel.rs](<src-tauri/src/hardware_accel.rs>) `decode_requested` 由 `from_reader` 改为有界读入后剥掉单个前导 UTF-8 BOM 再 `from_slice`，与第 32 节 `storage::read_state` 的容忍策略一致；避免「用户已开启硬件加速 + 快照带 BOM」被保守策略误判为投影无效而静默关 GPU。新增两条断言：带 BOM 合法投影可读、带 BOM 非法 JSON 仍报错；既有体积上限/尾输入/类型校验语义不变（先读全量再判超限，与原 `limited.limit()==0` 等价）。
- **「IPC/网络/前端拆为 3 个子进程提速」核查结论（未执行拆分，证据如下）**：
  - 前端已是独立子进程：WebView2 渲染运行在独立 `msedgewebview2.exe` 进程树，与本进程异步（本轮调试中多次观察到其子进程与独立 EBWebView 用户数据目录）。
  - IPC 全异步且无串行点：`launcher_call` 为 async，生命周期 `Gate::enter` 只是活动计数票据（[lifecycle.rs](<src-tauri/src/lifecycle.rs>)），并发命令互不等待；前端多窗口（主窗/小窗/HUD/悬浮球）的 IPC 并行无锁竞争。
  - 网络全异步：reqwest 在 tokio 上运行，`.timeout(30s)` 为总超时；协议/公告/更新检查互不阻塞 IPC；下载流式带进度事件。
  - 重 IO/CPU 一律 `spawn_blocking`（138 处调用点）；全库无 UI 路径 `block_on`，唯一 `thread::sleep` 生产用法是 auth 回环监听线程的 WouldBlock 重试。
  - 真正的串行点是 `Storage` 的单一 `Mutex<Data>`，但读路径是微秒级设置克隆，未测得竞争；为其引入 RwLock 的改动面与收益不匹配。
  - 结论：请求描述的三层异步已是现状；把网络硬拆进 sidecar 子进程会让每次 API 响应（最大 8 MiB JSON）与下载流过一道进程桥，触碰第 10 节全部网络纪律边界并重写大半 926 个 Rust 测试的验证面，实测收益≈0（网络本就不阻塞 IPC）且大概率更慢。若未来目标是崩溃隔离而非速度，可单独立项评估网络 sidecar。
- **检查与产物**：`npm run typecheck` 0 错误；全部 **21 个** `scripts/test-*.mjs` 通过；`cargo test --lib` **926 passed / 0 failed**（新增断言并入既有用例）；`npx tauri build --bundles nsis` exit 0。安装包复制为 [HCMCL0.8.0-dev3-win-x64-setup.exe](<release/HCMCL0.8.0-dev3-win-x64-setup.exe>)，**13,977,706 字节（13.33 MiB）**，FileVersion **0.8.0-dev3**，SHA-256 **`4b9f442989c01dd478195a2c4a6affa516105da5162877ba3ea3170b663952fa`**；`fix-artifact-integrity.mjs --check` **290 个对象 / 0 Low**。
- **仍未验证**：dev3 安装包的真实覆盖安装（本轮仅版本与投影修复，未重跑第 31 节安装器场景）；硬件加速开启后的实际 GPU 状态（`hardwareAccelerationBooted` 仅为启动快照，非实测）。未提交、推送或部署。


## 34. 安装错误三语拼接 / Forge 加载器误判 / 依赖提示缺失 / 扫描提速 / CurseForge 密钥 / 大壁纸失效（2026-11-15，UTC+08:00）

- **安装兼容性错误按界面语言显示（图片1/图片2 红框）**：[compatibility.rs](<src-tauri/src/catalog/install/compatibility.rs>) 的 MISMATCH/INVALID 及 install.rs 的「缺少官方兼容证据」由三语拼接硬编码字符串改为 `HC_COMPAT|GAME|实例|文件列表`、`HC_COMPAT|LOADER|…`、`NO_LOADER` / `METADATA` / `EVIDENCE` 机器码（详情列表至多 8 项 + 省略号，有界）；新增 [mod-install-error.ts](<src/renderer/src/mod-install-error.ts>) 按当前语言翻译，未知错误原样返回，实例管理与资源下载两个安装入口的 catch 均已接入；三语 `res.compat.*` 文案齐全。
- **「同一版本却检测不通过」根因与修复**：用户实例 `1.20.1-forge` 为就地合并安装的自包含 Forge JSON（无 `inheritsFrom`，libraries 只有 `net.minecraftforge:fmlloader/fmlearlydisplay/forgespi` 坐标，无 `net.minecraftforge:forge`），而 `exact_loader_coordinate` 只认 `net.minecraftforge:forge` → Rust 侧 loader 探测为 None → `Tags::check` 拒绝一切模组安装；且资源扫描在 `profile_loader.is_none()` 时**整体跳过 mods 目录**（[local.rs](<src-tauri/src/resource_updates/local.rs>) `scan_dir`），Forge 实例的「联网识别模组信息 / 识别可更新模组」也因此失效。修复：坐标表增加 `("net.minecraftforge","fmlloader") => forge`；新增真实形状回归（clientVersion + fmlloader 坐标 → mc 1.20.1 + loader forge）。Modrinth 实测 JEI 15.74.0.234 同时存在 forge/fabric 两文件，加载器识别修复后同版本文件可正常安装。
- **版本管理界面安装提示依赖**：`findMissingDependencies` 与缺前置弹窗抽取为共享模块（[mod-dependencies.ts](<src/renderer/src/pages/shared/mod-dependencies.ts>) + [DependencyPromptDialog.tsx](<src/renderer/src/pages/shared/DependencyPromptDialog.tsx>)），[InstanceManagePage](<src/renderer/src/pages/InstanceManagePage.tsx>) 在线安装接入同一检查：缺失必需前置先弹窗、确认后前置与本体**并发**安装；资源下载页改为复用共享实现。同时修复切换实例后在线安装筛选不重置的旧逻辑（`prev === 'fabric'` 门导致上一个实例的版本/加载器被带给新实例）。
- **扫描提速**：CDP 实测真机 `installed.list()` 16 实例 447ms、`installed.listAll()` 70 实例 1766ms。根因：每实例串行读取（版本 JSON + 存档目录 + servers.dat NBT）且 `local_meta`/`version_type` 每次调用现编译 7 个正则。修复（[runtime.rs](<src-tauri/src/runtime.rs>)）：`installed()` 改为 scoped 线程并行计算各实例行（结果按目录名序回填，错误语义不变）；正则经 `static_regex` 惰性缓存一次编译终身复用。资源列表（manage.mods/resources.list）实测 30-50ms 本已较快，未改。
- **CurseForge 密钥**：新密钥实测可用（`api.curseforge.com` 返回数据）。Tauri 版此前**完全没有**该设置项（界面与默认值都没有），密钥只存在于 Electron/Lite 版。修复：`curseforgeApiKey` 登记进 [settings.ts](<src/shared/settings.ts>)（内置新密钥为默认）、[storage.rs](<src-tauri/src/storage.rs>) defaults（旧存档经 decode_state 以 defaults 为基底自动补全）与 [types.ts](<src/shared/types.ts>)。**注意：旧版二进制校验拒绝含此字段的存档**——现场存档曾写入后被回滚，安装新包后默认值自动生效，无需手改存档。
- **大体积自定义壁纸失效**：后端 `wallpaperData` 对真实 7MB PNG 正常返回 9.3MB data URL（Rust 侧 `read_held`/`normalize` 实测通过）；失效点在前端 `dataUrlToBlobUrl` 的 `fetch(dataUrl)`——Chromium 对 data: URL 解析有 ~2MB 上限，壁纸 base64 后超过即抛 `Failed to fetch`（CDP 实测 9.3MB 必现），`catch` 返回空串后壁纸被静默置 off。修复（[wallpaper.ts](<src/renderer/src/wallpaper.ts>)）：小图保持 `fetch` 快速路径，大图回退 `atob` 手动解码转 Blob（CDP 实测 7MB 解码并完整加载 2879×1799 仅 66ms）。新增环境变量触发的真实文件回归探针（无 env 时自动跳过）。
- **验证**：`npm run typecheck` 0 错误；全部 **22 个** `scripts/test-*.mjs` 通过（新增 [test-mod-compat.mjs](<scripts/test-mod-compat.mjs>) 6 项）；`cargo test --lib` **929 passed / 0 failed**；`npx tauri build --bundles nsis` exit 0。诊断脚本与测试壁纸文件已清理，现场存档恢复（无 backgroundImage、无 curseforgeApiKey、无遗留壁纸文件）。
- **交付包**（仍为 0.8.0-dev3，替换上一版）：[HCMCL0.8.0-dev3-win-x64-setup.exe](<release/HCMCL0.8.0-dev3-win-x64-setup.exe>)，**13,978,732 字节（13.33 MiB）**，FileVersion **0.8.0-dev3**，SHA-256 **`3c4a79a763ecd7cf265e2fdc4e9371470fc04e8b5ca81b83c12298aa0298fae0`**；`fix-artifact-integrity.mjs --check` **290 个对象 / 0 Low**。
- **仍未验证**：`installed()` 并行提速后的实测数字（需新包装机后复测）；Modrinth/CF 端到端安装与更新检测在真机的完整走通（本轮以 API 数据与单元测试佐证）；未提交、推送或部署。


## 35. 下载提速：分段多连接下载、写盘批处理与客户端调优（2026-11-16，UTC+08:00）

- **分段多连接下载（`downloadConnections` 首次真正生效）**：此前 `downloadConnections`（默认 16）在 Tauri 版是死设置——单文件始终是单连接。现于 [downloads.rs](<src-tauri/src/downloads.rs>) 实现：已知大小且 ≥ **16 MiB** 的文件按 `downloadConnections`（钳制 2..16）拆成等长区间，每区间独立 `Range: bytes=start-end` 请求（206 + Content-Range 起点/终点/总大小三重校验，不一致即报错），并发下载到独立暂存文件（`SegmentCleanup` 兜底清理），串接后走与单流共用的 `finalize_download`（尺寸/摘要复核 + sidecar + 原子替换）。进度用全局 `AtomicU64` 聚合（区间不相交，总和单调）。服务器不按边界返回 206 时分段整体放弃，**回退到既有单流续传路径**；小文件阈值以下行为与旧版完全一致。真实 CDN 已验证：`piston-data.mojang.com`（CloudFront）对 `bytes=0-1048575` 返回 `206 / Content-Range: bytes 0-1048575/23028853`，语义精确匹配。
- **写盘批处理**：传输循环从 16KB 逐块写盘（每块一次阻塞线程派发）改为攒约 **1 MiB** 再落盘；错误/取消路径先冲刷缓冲区再返回（回归捕捉到的真实缺陷：读错误会把未落盘的 partial 丢弃，破坏续传前提）。分段传输同规则。
- **客户端调优**：生产 Client 显式 `pool_max_idle_per_host(64)`（16-48 并发下同主机连接复用）、`no_gzip/no_brotli/no_deflate`（游戏文件本就压缩，省双方 CPU）、UA 更新为 `HCMCL-Tauri/0.8.0`。
- **支撑改动**：`Cancel` 内部状态改 `Arc` 以支持 Clone（分段任务跨线程共享取消信号，方法语义不变）；传输收尾逻辑抽取为 `finalize_download` 供单流/分段共用；测试夹具支持 Range end 边界、每连接回改阻塞读（原实现从非阻塞 listener 继承非阻塞 socket，并发读即丢连接）、`has_range` 区分「0 起始区间」与「无 Range」。
- **验证**：`downloads::` 26 项测试连续多轮全绿（新增分段组装 + 阈值以下走单流两项）；`cargo test --lib` 全量 **931 passed / 0 failed**；`npm run typecheck` 0 错误；22 个 `scripts/test-*.mjs` 全绿；`npx tauri build --bundles nsis` exit 0。
- **交付包**（仍为 0.8.0-dev3，再次替换）：[HCMCL0.8.0-dev3-win-x64-setup.exe](<release/HCMCL0.8.0-dev3-win-x64-setup.exe>)，**13,996,619 字节（13.35 MiB）**，FileVersion **0.8.0-dev3**，SHA-256 **`320c4098821d9db24594707bc372e13202c0a4f79de51fb277cea146fe5782f4`**；`fix-artifact-integrity.mjs --check` **290 个对象 / 0 Low**。
- **仍未验证**：真实网络下的分段下载端到端（单连接 vs 分段的实际速率对比未在本机测速；BMCLAPI 对象路径 404 为既有镜像行为，与本轮无关）；未提交、推送或部署。


## 36. 实例遍历预算与资源扫描 / 更新检测的降级修复（2026-11-22 10:12，UTC+08:00）

- **现象**：`Better MC [FABRIC] BMC3`（343 个 mods）的 `manage.mods` 直接报「实例内容超过遍历预算」，模组列表整页空白，后台图标 / 名称补齐事件为 **0** 条。
- **根因**：物理隔离探测 [isolation.rs](<src-tauri/src/modpack/isolation.rs>) 的 `dir_has_entries` 用**预算 1** 调 `names()`，目录条目数 >1 时预算耗尽返回错误，被上层当成「目录探测失败」整体抛出。判断「目录非空」本来只需要 1 条，预算耗尽恰恰是「非空」的证据。
- **修复**：`dir_has_entries` 捕获带「遍历预算」字样的错误并视为**非空**，其余 IO 错误语义不变。
- **验证**：`cargo test` 隔离相关 5 项通过；`npx tauri build --bundles nsis` 通过后以 CDP 实测，`manage.mods('Better MC [FABRIC] BMC3')` 返回 **343 个模组**、`enrichMods` 返回 true、30 秒内收到 **124 条带图标**的补齐事件（修复前为 0）。
- **同一批的另一组红框报错**（资源读取 / 更新检测）：
  1. [resource_updates/local.rs](<src-tauri/src/resource_updates/local.rs>)：`MAX_ZIP_ENTRIES` 4096 → **65536**（汽鸣铁道 24,311 条目、机械动力 13,334 条目均超旧上限）；解析 `fabric.mod.json` / `mods.toml` 前剥掉单个前导 UTF-8 BOM；**单个 jar 元数据异常降级为「无元数据提示」**，不再让整批扫描失败（取消仍向上传播）。
  2. [catalog/update.rs](<src-tauri/src/catalog/update.rs>)：Modrinth `client_side=unsupported`（Almanac 等 server_only 库）与 CurseForge 腿的官方校验 `invalid()` 一律降级为「该模组无更新」；**传输错误 / 超时 / 取消 / 指纹唯一性失败仍报错**，避免掩盖真实网络故障。3 个断言旧严格语义的测试同步改为「无更新」语义。
- **检查与产物**：`catalog::update` **19/19**、`resource_updates` **60/60** 通过；`npx tauri build --bundles nsis` exit 0。安装包仍为 dev3（同名替换）：`bundle/nsis/HungerCat MineCraft Launcher_0.8.0-dev3_x64-setup.exe`，**14,024,486 字节（13.37 MiB）**，10:12 生成。
- **仍未验证**：除上述两个实例外的其它异常 jar（本轮只按现场 5 个异常 `fabric.mod.json` 与 2 个超大压缩包验证）；更新检测降级后的真实 Modrinth / CurseForge 全量走通。未提交、推送或部署。


## 37. 液态玻璃主题按 Apple 设计规范收口 + 中文安装器（0.8.0-dev4，2026-11-22 10:58，UTC+08:00）

- **审计结论**：按 `apple-design` 规范逐条核对 mac 皮肤，材质层次（近实心白 + 镜边 + 柔和阴影）、光学字号与 tracking、SVG 折射的挂载范围、`@supports not (backdrop-filter…)` / `prefers-contrast` / `prefers-reduced-transparency` 降级分支均已合规，本轮只补两处增量。
- **改动**（[index.css](<src/renderer/src/index.css>)）：新增 `--lg-ease-standard`（`cubic-bezier(0.25,1,0.5,1)`，近似阻尼 1.0 的弹簧曲线）与 `--lg-ease-momentum`；`.btn` 过渡改用弹簧曲线、按压位移收到 120ms；`prefers-reduced-motion` 与 `[data-reduced-motion]` 下把 mac 玻璃控件的 CSS 过渡压平到 1ms（JS 弹簧本就由 `MotionConfig` 接管，两处不重复处理）。
- **安装器语言**：[tauri.conf.json](<src-tauri/tauri.conf.json>) 新增 `bundle.windows.nsis.languages: ["SimpChinese"]`。
- **版本**：五处同步 `0.8.0-dev4`（`package.json`、`package-lock.json` 两处、`tauri.conf.json`、`Cargo.toml`、`Cargo.lock`）。
- **检查与产物**：`npx tauri build --bundles nsis` exit 0（构建期校验过 tauri CLI 会拒绝未知语言名，`makensis` 成功链接语言文件）。安装包 **14,020,593 字节（13.37 MiB）**，10:58。
- **仍未验证**：安装向导的实际文案未目视确认（安装器资源被压缩，无法离线核验字符串）；液态玻璃改动只做静态审查与构建校验，未跑真实窗口观感对照。


## 38. 后端三语文案按界面语言解析 + 小文件下载事件节流（0.8.0-beta1，2026-11-22 13:59，UTC+08:00）

- **根因**：Rust 侧没有界面语言上下文，198 条面向用户的文案以「简体 / 繁體 / English」三段并列下发给前端，Webview 原样渲染成三语长串；界面语言切成 en 也只是多显示一段英文。
- **方案**：新增 [backend-text.ts](<src/shared/backend-text.ts>)（`resolveBackendText` / `resolveBackendValue` / `localizeBackendError`），在 [transport.ts](<src/tauri/transport.ts>) 的 **call 返回值、call 拒绝值、`launcher:event` 负载**三处解析（`resolveBackendValue` 深度遍历、写时复制、节点预算）；[store.tsx](<src/renderer/src/store.tsx>) 在语言变化时 `setBackendLanguage(locale)`；[native-invoke.ts](<src/tauri/native-invoke.ts>) 兜住直接调用方。
- **防误伤判据**（宁可漏译不可截断用户数据）：恰三段 + 前两段含中文 + 第三段无中文 + 简繁长度比 ≤2.2 + **第二段确实命中繁体专用字且不劣于简体**。字表由 zh-CN / zh-TW 词典同键同长对齐矿出并剔除跨语种噪声。反例回归：实例名 `机械动力 / 附属 / Create` 必须原样保留。
- **小文件下载过慢**（[downloads.rs](<src-tauri/src/downloads.rs>)）：`Progress::update` 每次调用在锁内对 `bytes` / `sizes` 两个 BTreeMap 全量 `sum()` → **O(n²)**（数千个 library / asset 时数千万次遍历，且持锁阻塞全部并发下载）；`done=true` 还绕过 80ms 节流，每个小文件完成都 emit 一次 IPC + 前端重渲染。修复：`ProgressData` 增加 `sum_bytes` / `sum_sizes` 以差值增量维护；完成事件与普通进度共用 80ms 节流窗口，仅全部完成时强制立即发。
- **检查与产物**：新增 [test-backend-text.mjs](<scripts/test-backend-text.mjs>)（22 项，含 Rust 侧 198 条三语串 100% 可解析的语料断言）；CDP 实测 en → `Invalid homepage identifier`、zh-CN → `主页标识无效`，无三段并列，语言已还原；downloads 模块 27 项（新增 200 文件节流回归：事件 <400 条且 `currentBytes == totalBytes`）通过。安装包 **14,024,391 字节（13.37 MiB）**，13:59。
- **仍未验证 / 遗留**：**Rust 仍有约 3183 条单语中文字面量**（多为内部日志与校验消息），en / ja 界面下仍显中文，属既有问题，需按模块分批翻译才能彻底「全部按语言显示」；小文件修复未做真实全量安装的宏观耗时对比。


## 39. 版本安装白名单放行镜像节点 + 官方等价回退（0.8.0-beta2，2026-11-22 14:32，UTC+08:00）

- **现场证据**：CDP 调 `window.api.download.install('26.4-snapshot-10')` 复现，真实被拒主机是 `bmclapi17.sakura.sld.tw`——镜像清单会把库地址改写到自己就近的分发节点，而白名单只枚举了 `bmclapi2.bangbang93.com`。
- **定案原则**：**提速优先、不丢地址**（丢弃未登记地址等于把镜像的全部收益扔掉，还会退化成官方直连）。
- **修复**（[downloads.rs](<src-tauri/src/downloads.rs>)）：
  1. `allowed_download_host` 改为「官方域后缀（`*.mojang.com` / `*.minecraft.net`，要求前导点防仿冒）+ `mirror_node_host`（`bmclapi*` 且属 `bangbang93.com` / `sakura.sld.tw`）+ 已知 maven 仓库」；错误信息回显具体主机名便于排查。
  2. 新增 `official_equivalent`：把节点地址按 `/maven`、`/assets`、`/objects`、`/v1/packages`、`/v1/objects` 反推成官方等价地址；`file_urls` 据此把节点地址当镜像首选、官方作回退（mirror-first 下首选节点，auto 下官方优先）。
  3. `library_task` 对仍未登记的主机**归一到官方仓库**而不是失败，作为兜底。
- **实测**：`26.4-snapshot-10` 全流程 DONE，**616,878,074 bytes** 全部完成，进度事件仅 **161 条**（节流生效），`versions/26.4-snapshot-10` 含 json + 42,620,484 bytes client jar 与 natives。版本号五处同步 `0.8.0-beta2`；安装包 **14,092,433 字节（13.44 MiB）**，14:32。
- **仍未验证**：其它镜像节点（不同 CDN 域名）与 CurseForge / Modrinth 文件 CDN 的白名单覆盖；本轮只走通一个原版快照版本。


## 40. 下载链路同源性能瓶颈的全量排查与修复（0.8.0-beta4，2026-11-22 15:16，UTC+08:00）

- **排查范围**：按第 38 节「小文件变慢」的三条根因逐条比对全部网络写入路径——[downloads.rs](<src-tauri/src/downloads.rs>)、[catalog.rs](<src-tauri/src/catalog.rs>)（模组 / 资源包安装、更新应用、API 查询、导出下载）、[java_runtime.rs](<src-tauri/src/java_runtime.rs>)、[modpack/network.rs](<src-tauri/src/modpack/network.rs>) 与 `modpack/download.rs`、`resource_updates/*`、`homepage/*`。整合包进度已有 100ms 节流、主页客户端本就是实例级复用，无需改动。
- **发现三类同源问题**：
  1. **逐块 `write_all + flush` 漏改三处**：`catalog::download_temp`（模组下载）、`java_runtime::Client::package`（JRE 下载）、`modpack::network::download`（整合包归档）仍是每 8–64KB 一次写 + 刷新，等于每块派发一次后台阻塞写。
  2. **HTTP 客户端逐请求新建，四处**：`catalog::remote_request`（每次 Modrinth / CurseForge 查询）、`download_temp`（每个模组）、`write_export_download`（每个更新文件）、`java_runtime::Client::new`。每次都全新 TLS 握手 + 独立连接池——批量补齐 343 个模组元数据就是 343 次握手。
  3. **摘要校验占用异步线程**：`downloads::satisfied` 在 tokio worker 上同步读全文件算 sha1 + sha256（`download_one` 预检与 `finalize_download` 复核），几十个并发下载里夹着几百 MB 哈希会把网络任务挤出线程。
- **修复**：新增 `DOWNLOAD_CHUNK_BUFFER`（1 MiB）/ `buffer_download_chunk` / `flush_download_buffer` 供三处复用；catalog 增加进程级 `api_client()` / `transfer_client()`（连接池复用，原 20s / 30s / 180s 超时改为**请求级 `timeout`** 保持语义不变）；java 用 `OnceLock` 共享客户端并移除仅用于逐块刷新的 `AsyncWriteExt`；新增 `satisfied_in_context`——无摘要走轻量快路径（只比尺寸 / 存在），有摘要才 `spawn_blocking`。
- **检查与产物**：`cargo check --all-targets` 通过；`downloads` **30/30**、`modpack::network` **7/7**、`catalog::tests::export_writer` **2/2** 通过。安装包 **14,095,024 字节（13.44 MiB）**，15:16。
- **环境阻塞（影响后续本地构建）**：本机 Windows SDK（10.0.26100 / 22621 的 `um\x64`）缺 `combase.lib`，链接报 `LNK1181`。已用 `dumpbin /exports C:\Windows\System32\combase.dll` + `lib /def` 重建导入库到 `%TEMP%\hcmcl-sdkfix\combase.lib`，构建 / 测试时以 `$env:LIB` 注入（**未写入系统目录、未改仓库**）。此后本地打包都必须带同样 LIB，或修复 SDK 安装补齐该库。
- **仍未验证**：真实网络下 343 个模组元数据补齐的耗时对比（本轮以代码路径与单元测试佐证，未跑完整实例的宏观测速）。


## 41. 可更新分栏的多选与批量更新（0.8.0-beta5，2026-11-22 15:40，UTC+08:00）

- **功能**：[ResourceFilterBar](<src/renderer/src/pages/instance-manage/ResourceFilterBar.tsx>) 在切到「可更新」后多出一行操作区——全选框（支持半选态）、已选计数、「更新所选（n）」「全部更新（n）」；执行中整行换成 `正在更新…（done/total）`，切到别的分栏也保留进度入口。[ModsPanel](<src/renderer/src/pages/instance-manage/ModsPanel.tsx>) / [ResourcesPanel](<src/renderer/src/pages/instance-manage/ResourcesPanel.tsx>) 仅在「可更新」筛选下渲染每行勾选框，批量期间行内更新 / 启用禁用 / 删除一律禁用。
- **修正一处既有统计偏差**：[InstanceManagePage](<src/renderer/src/pages/InstanceManagePage.tsx>) 原来 `updatableCount` 统计的是模组 + 资源包 + 光影三类总和，站到模组页也会把光影计入。现在按 `tabKind` 分流，筛选标签计数与「全部更新」都只作用于当前分栏，不会在模组页顺手换掉光影。
- **批量执行语义**：`applyUpdates` **串行**逐项应用——后端每项都要拿根目录跨进程写锁并重扫目录，并发提交只会互相排队、还让首项迟迟完不成；串行也保证中途失败时已完成项仍是完整状态。中途**不 reload**（刷新会作废后续项绑定的目录快照），全部结束后统一 reload 并汇总「已更新 n 项」或「已更新 n 项，m 项失败：…」。批量期间禁用「检查更新」，避免重扫清空目标列表。
- **文案**：三语新增 `ins.selectedCount` / `updateSelected` / `updateAll` / `batchUpdating` / `batchUpdateDone` / `batchUpdatePartial`（`locales/ja` 目录本身为空，无需补）。
- **检查与产物**：`npm run typecheck` 0 错误；`node scripts/test-i18n.mjs` **14/14** 通过。安装包 **14,099,110 字节（13.45 MiB）**，15:40。
- **构建期新坑**：vite 清空 `dist` 走 `rmSync`，被注入的 Node 安全删除垫片拦截（`genie-trash` ETIMEDOUT），`beforeBuildCommand` 失败；构建命令内临时 `NODE_OPTIONS=''` 后通过（只影响清空自身产物目录）。详见 AGENTS.md 第 3 节。
- **仍未验证**：批量更新未做端到端点击验证（需实例内真有可更新项才跑得通，本轮以类型检查与 i18n 校验为准）；串行执行在几十项规模下的实际耗时未测。


## 42. 首次入库、三系统多架构打包与 CI 构建链（2026-11-22 18:00–19:10，UTC+08:00）

- **提交范围**：主提交 `21f9e2f`（384 文件，+73047/−32242）把 Tauri 主产品整体入库，并**排除** `HCMCL_old/`、`HungerCat MineCraft Launcher Lite/`、`.workbuddy/`、`src-tauri/target/`、`session.md`、根目录零字节 `nul`（后四项已补进 `.gitignore`）。之后两次修正提交：`8c1e564`（macOS 改为交叉编译）、`fd44252`（图标 + CI 运行器）。
- **推送**：`schannel: CRYPT_E_NO_REVOCATION_CHECK (0x80092012)` 依旧出现（吊销列表不可达）。**未关闭证书校验**：改为 `git -c http.sslBackend=openssl -c http.sslCAInfo=<系统根证书 PEM>`，即换 TLS 后端、仍按系统根证书链校验；PEM 由 `Cert:\LocalMachine\Root` + `CurrentUser\Root` + 两级 CA 导出（156 张）。三次 push 均成功，`origin/main` 已到 `fd44252`。
- **Windows 三架构本机构建**（均 `--bundles nsis`，MSI 因预发布段非纯数字不可用）：
  | 架构 | 关键前置 | 产物 | 大小 |
  | --- | --- | --- | --- |
  | x64 | 既有 | `bundle/nsis/…_0.8.0-beta5_x64-setup.exe` | 14,099,110 B |
  | arm64 | `aarch64-pc-windows-msvc` 目标 + **clang**（ring 汇编）+ `combase.lib /machine:ARM64` | `target/aarch64-pc-windows-msvc/release/bundle/nsis/…_arm64-setup.exe` | 13,113,901 B |
  | ia32 | `i686-pc-windows-msvc` 目标 + `combase.lib /machine:X86` | `target/i686-pc-windows-msvc/release/bundle/nsis/…_x86-setup.exe` | 13,230,084 B |
  三份已复制到 `release/HCMCL0.8.0-beta5-win-{x64,arm64,ia32}-setup.exe`（gitignore）。
- **新增 CI**：[build-tauri.yml](<.github/workflows/build-tauri.yml>)，`workflow_dispatch` 或 `v*` 标签触发；Linux 为 `ubuntu-22.04`（x86_64）+ `ubuntu-24.04-arm`（aarch64）出 `deb` + `AppImage`，macOS 为 `macos-15-intel` 交叉编译 `x86_64-apple-darwin` 与 `aarch64-apple-darwin` 各出 dmg；标签触发时汇总为 Draft Release。
- **CI 两次失败与根因**：
  1. `macos-14` 运行器报 `configuration 'macos-14-arm64-us-default' is not supported`（本仓库拿不到 arm64 macOS 托管机），`macos-13` 已退役、任务会无限排队 → 改为 Intel 机交叉编译两个 target。
  2. Linux `AppImage` 打包 **panic**：`couldn't find a square icon to use as AppImage icon`，退出码 134。根因是 `bundle.icon` 缺省候选只有 `icon.ico` / `icon.png`，没有 bundler 认可的方形 PNG。用 `npx tauri icon src-tauri/icons/icon.png` 生成 32/64/128/128@2x PNG 与 `icon.icns`，并在 `tauri.conf.json` 显式声明 `bundle.icon`。**Windows 侧不受影响**（仍用原 `icon.ico`，故三份本地产物无需重打）。
- **CI 结果**：`build-tauri` run [45010415449](https://github.com/JOHNNY-beep456/HungerCat_MineCraft_Launcher/actions/runs/45010415449) **completed success**，四个产物均上传：`hcmcl-linux-x86_64`、`hcmcl-linux-aarch64`、`hcmcl-macos-x86_64`（13,909,778 B dmg）、`hcmcl-macos-aarch64`（13,465,840 B dmg）。Release 汇总 job 因非标签触发按设计跳过。
- **仍未验证**：三架构 Windows 包均未做真实安装（本轮只到 makensis 出包）；macOS dmg 未签名未公证，未在 Apple 硬件上打开；Linux 包未在桌面环境安装运行；aarch64 Linux 未在真机验证。产物由用户自行从 Actions 下载，本机只保留了 macOS 两个 dmg 的下载副本。

## 43. Android 端打通与 x86 出包（2026-11-23 15:20–16:10，UTC+08:00）

- **起点**：Android 的源码侧此前已就位，缺的是本机工具链与实际出包。已有：`src-tauri/gen/android` 完整 Gradle 工程（AGP 9.3.1 / Kotlin 2.2.10 / Gradle 9.6.1 / `compileSdk 36` / `minSdk 24`）、`mobile_files` / `mobile_export` / `mobile_security` 三个移动模块、原生侧 `HcmclFilesPlugin.kt`、`security/HcmclSecretStore.kt`、`MainActivity` 的 `enableEdgeToEdge()`，以及 Rust 侧 61 处 `cfg(desktop)` / `cfg(mobile)` 与 `#[cfg(target_os="android")]` 分支。`cargo check --target x86_64-linux-android --lib` 在改造前即通过（524 条 unused 警告，无 error）。
- **工具链（本机新装，全部在 `F:/Android/Sdk`）**：cmdline-tools 12.0、`platform-tools`、`platforms;android-36`、`build-tools;36.0.0`、`ndk;27.2.12479018`；JDK 复用系统 `C:/Program Files\Java\jdk-21`。
- **三个构建期阻塞与解法**：
  1. **Gradle wrapper 下载被 JDK PKIX 挡住**（本机 TLS 由中间设备签发，JDK `cacerts` 不认）→ `JAVA_TOOL_OPTIONS=-Djavax.net.ssl.trustStoreType=Windows-ROOT` 让 JDK 直接用系统根证书库；`services.gradle.org` 仍被中断时，从腾讯镜像取 zip 并把 wrapper 的 `distributionUrl` 临时指向 `file:/…`（**构建后已还原为官方地址**）。
  2. **配置缓存与维护版 `BuildTask` 不兼容**：该任务（哈希锁定、转调 Tauri CLI）在执行期读 `project.providers`，Gradle 9 报 `Invocation of 'Task.project' … unsupported with the configuration cache` → `gradle.properties` 改为 `org.gradle.configuration-cache=false`，不改任务实现。
  3. **`tauri android build` 只出 unsigned APK** → `zipalign -p -f 4` + `apksigner sign --ks … --ks-pass file:…`，密钥与口令在 `.local/android-keystore/`（`/.local/` 已 gitignore）。
- **前端移动外壳（本次改动）**：`main.tsx` 在挂载前注入 `<html data-platform>`；`App.tsx` 在 Android/iOS 上强制 `navPosition='bottom'`、隐藏 `TitleBar` 与 `CursorGlow`、`pt-12 → pt-0`、禁用实验性 Win10 桌面外壳；`index.css` 新增移动端段（`env(safe-area-inset-*)` 避让、触摸语义、下载球上移、内容留白 12px）；`index.html` 增加 `viewport-fit=cover`。
- **产物**（`release/`，均已 gitignore）：
  | ABI | 文件 | 大小 | SHA-256（前 32 位） |
  | --- | --- | --- | --- |
  | x86_64 | `HCMCL0.8.0-beta5-android-x86_64.apk` | 32,447,799 B | `930a56ad61ed96ed91d89ecf19fd581c` |
  | x86 | `HCMCL0.8.0-beta5-android-x86.apk` | 33,807,668 B | `4444c3a262812cad2acbcec8596fdb69` |
  两者同一签名（证书 SHA-256 `b13babf0…e58b61`），`aapt2` 校验：`package=top.johnnyblog.hcmcl`、`versionCode=8000`、`versionName=0.8.0-beta5`、`minSdk 24` / `targetSdk 36`、`native-code` 分别为 `x86_64` / `x86`。包内仅含对应 ABI 的 `libhcmcl_tauri.so`（约 30.7 MB，前端资源编入该库，`assets/` 只有 `tauri.conf.json` 与 baseline profile）。
- **未验证**：未在真机/模拟器启动；WebView 真实渲染、Keystore 桥读写、文件导入导出授权流程、返回键与后台驻留均未运行验证。ARM（`aarch64` / `armv7`）未出包；手机竖屏多列布局仍需逐页打磨。

## 44. Android 路径误判修复与 beta6 出包（2026-11-23 18:10–19:10，UTC+08:00）

- **用户反馈（三张 Android 截图）**：① 资源下载 → 版本「版本清单加载失败：拒绝通过符号链接访问游戏文件」；② 主页「无法打开现存整合包目录」；③ 实例页「导入失败：无法打开现存整合包目录」且列表一直停在「正在获取已安装版本…」。
- **根因是同一件事的两个面**：Android 的应用私有目录前缀由系统维护，启动器沿用了桌面的「全路径无链接」与「从 `/` 逐级 `openat`」两套硬假设。
  1. **祖先软链接被当恶意链接**：`/data/user/0` 与 `/data/data` 是同一目录的两种写法，`runtime::absolute`、`downloads::absolute`、`catalog::checked_absolute`、`install_lock` 逐级 `symlink_metadata` 时把祖先判成链接 → `versions:list`（版本清单）、`installed:list` / `listAll`（实例列表与实例页加载态）全部直接失败。
  2. **祖先不可读导致锚点链断裂**：`modpack::access::Directory::open` 从 `/` 逐级 `openat`，而 Android 的 `/data` 是 `drwxrwx--x`（others 只有 `x`），`O_RDONLY` 打开目录要读权限 → `EACCES` → 主页脚本目录、整合包导入、实例文件管理统一报「无法打开现存整合包目录」。
  3. **前端加载态没有收敛**：`installed:list` 抛错时 `InstalledPage.refresh` 只 `catch {}`，首次进入即永久停在加载态。
- **修复**：
  - 新增 `src-tauri/src/path_alias.rs` 统一策略：`ancestor_alias_allowed()` = Android，`link_is_fatal(final_segment)` = 末级或桌面。**末级永远是启动器自建对象，任何平台都拒绝链接**；祖先级只在 Android 放开。
  - 逐级校验改为 `peekable()` + `final_segment`：`runtime::absolute`、`downloads::absolute`、`catalog::checked_absolute`、`install_lock::absolute_components`、`services::tool_scope`、`mobile_files::plain_path`（Android 上同时跳过 `canonicalize(path) != path` 的整条相等断言）。
  - `modpack::access`：`Anchor` 增加 `alias` 标记；`Directory::open` 在祖先级允许跟随系统别名链接并在 `verify()` 里用 `native::root(path, follow)` 复验身份（链接被改指向仍会被身份比对抓住）；`native::root/child` 在 `EACCES/EPERM` 时退回 **`O_PATH`** 锚点——句柄仍能 `openat` 与 `fstat`，只是不能枚举，正好对上「祖先可穿不可读」。
  - 前端 `InstancesPage.refresh` 失败时 `setInstalled(prev => prev ?? [])`，加载态必然收敛。
- **验证**：`cargo check --all-targets` 通过；`cargo check --target x86_64-linux-android --lib` 通过（542 警告 0 error）；`cargo test --lib` **940 passed / 0 failed**（含 `access` 的「末级链接必须被拒」与「祖先换名不可重绑」用例，确认桌面语义未退化）；`npm run typecheck` 通过。
- **产物**（`release/`，均已 gitignore；同 beta5 签名，`versionCode=8000` 可覆盖升级）：
  | ABI | 文件 | 大小 | SHA-256（前 32 位） |
  | --- | --- | --- | --- |
  | x86_64 | `HCMCL0.8.0-beta6-android-x86_64.apk` | 32,537,911 B | `e4f8a73453806201ca1c5961286cfa33` |
  | x86 | `HCMCL0.8.0-beta6-android-x86.apk` | 33,778,996 B | `fea611a79fef00e581d868adaa0f7881` |
  `aapt2` 复核：`versionName=0.8.0-beta6`、`native-code` 分别为 `x86_64` / `x86`、`minSdk 24` / `targetSdk 36`；`apksigner` 证书 SHA-256 仍为 `b13babf0…e58b61`（与 beta5 一致，可直接覆盖安装）。
- **构建期小坑**：Gradle wrapper 再次去 `services.gradle.org` 拉 9.6.1 并 `Read timed out`。本机 `~/.gradle/wrapper/dists/gradle-9.6.1-bin/` 里已有完整解压副本（另一个 URL 哈希目录），把它复制到按官方 URL 算出的哈希目录并补 `gradle-9.6.1-bin.zip.ok` 即可离线复用，无需改 `distributionUrl`。
- **仍未验证**：本机无 Android 设备/模拟器，修复只在交叉编译与单元测试层面成立；真机上的 WebView 渲染、文件导入导出、Keystore 桥仍未运行验证。

## 45. 下载重试与换源（0.8.0-beta7，2026-11-23 19:00–20:10，UTC+08:00）

- **用户反馈**：① 「一旦下载堵塞或 404 就直接错误而不是继续尝试或更换源」；② 某依赖 `it.unimi.dsi:fastutil:8.5.18` 下载失败。
- **定位到的四个独立缺陷**：
  1. `download_one` 里 `if e.fatal { return Err(...) }` 先于一切重试判断；`TransferError::status` 又把 400/401/403 标成 fatal，镜像 403 会终止整个文件。
  2. `downloads::ordered` 与 `version_metadata::Policy` 的 `official-first` 分支只返回官方单候选，等于「官方优先」直接砍掉镜像兜底；`auto` 才有两个候选。
  3. 20 秒读取超时只覆盖「完全无数据」，TCP 半开时的滴流会让下载永久卡住且不触发任何失败。
  4. 依赖候选只来自版本 JSON 声明的仓库（Fabric/Quilt/Forge maven）；`fastutil` 这类传递依赖实际在 Maven Central，主仓库 404/错误页即判失败。
- **修复**：
  - `download_one` 改为三级兜底：同源按预算重试（`attempts()`，停滞类只再试一次）→ `hopeless()`（400/401/403/404/410/416）直接换源 → 全部来源轮空后 `DOWNLOAD_PASSES=2` 整体再试一轮；换源前仍丢弃本来源半成品（不同来源的续传校验器不可互认）。
  - `ordered` 两种策略都保留官方与镜像；`version_metadata::Policy` 同改，`list()` / `source_version()` 各加一轮重试（`retry_pause` 1.2s，取消优先）。
  - `transfer_task` / `transfer_segment` 增加低速看门狗：30 秒不足 32 KiB 判定为「速度过低」，落盘后返回 `slow` 错误交给上层换源。
  - 新增 `library_urls`：主仓库为 Mojang / Fabric / Quilt / Forge maven 时，追加 `https://repo1.maven.org/maven2/<path>` 作为最后候选。摘要仍由版本 JSON 的 sha1 复核，`allowed_download_host` 已放行该域。
  - `modpack::network`：`download_attempt` + `download_with_resolver`，`ARCHIVE_ATTEMPTS=2`，仅对 `retryable()`（连接失败/超时/读取失败/5xx/408/429/DNS 超时）重试，重试前 `seek(0)` + `set_len(0)`。
- **测试**：`cargo test --lib` 944 passed / 0 failed。新增 `source_strategy_never_drops_the_fallback_candidate`、`missing_file_retries_every_source_twice_before_failing`（4 次请求 = 2 来源 × 2 轮）、`truncated_body_is_retried_on_the_same_source_before_switching`；并把 `paths_and_source_order` 的 `official-first` 断言更新为「两个候选」。
- **仍未做**：资源安装（Modrinth / CurseForge 单文件）的 `write_export_download` 仍是单次请求，重试需要重建 writer 与重新 bind，本轮未改；整合包 `retryable` 用错误文本判定，属既有字符串错误风格的延续。

### 45.1 fastutil 实测（2026-11-23 19:12）

- `HEAD https://maven.fabricmc.net/it/unimi/dsi/fastutil/8.5.18/fastutil-8.5.18.jar` → **404**
- `HEAD https://repo1.maven.org/maven2/it/unimi/dsi/fastutil/8.5.18/fastutil-8.5.18.jar` → **200**

Fabric 的 profile JSON 把 `it.unimi.dsi:fastutil` 指向自己的 maven，但该仓库并不托管这个传递依赖，所以此前必然拿到 404 并直接终止安装。`library_urls` 的 Central 兜底即针对此类「声明仓库不托管」的情况。
- **产物（0.8.0-beta7，同 beta6 签名）**：`release/HCMCL0.8.0-beta7-win-x64-setup.exe`（14,091,863 B，SHA-256 `9ceec707…c1e927`）、`release/HCMCL0.8.0-beta7-android-x86_64.apk`（32,464,183 B，`d26a1fa0…3d1c4fa7`）、`release/HCMCL0.8.0-beta7-android-x86.apk`（33,848,628 B，`e4e5bd17…7cdeee12`）。
- **收尾**：`TransferError.fatal` 字段在三级兜底落地后已无读取方，一并删除，避免留下死字段。

## 46. 进度卡死与回退（0.8.0-beta8，2026-11-23 19:37–20:55，UTC+08:00）

- **用户反馈（两张 Android 截图为同一次下载的先后两帧）**：进度停在「文件 5460/5461 · 572.0 MB / 574.1 MB · 99.9%」，当前文件 `it.unimi.dsi:fastutil:8.5.18`，过一会儿回退到「553.4 MB / 574.1 MB · 96%」并重新下同一文件。
- **两个现象是两个独立缺陷**：
  1. **99.9% 其实是分子口径问题**：`Progress::update` 的 `percent` 只按「已完成文件数 / 总文件数」算并夹到 99.9，5460/5461 从第一秒起就是 99.9%。最后一个文件恰好是 20 MiB 的大依赖，于是整个收尾阶段（下载 + 串接 + 校验）显示成不动。
  2. **回退是分段下载的整体放弃**：`transfer_any` 里 `if let Ok(())=segmented_transfer(...)` 把错误吞掉，然后 `remove_file(temp)` + `state=None` 退回单流从 0 开始。fastutil 19.9 MiB ≥ `SEGMENT_MIN_BYTES`(16 MiB)，按 16 路切成 1.2 MiB 的碎请求；任意一段超时/被镜像拒绝，整个文件就推回起点，进度因此掉 18.6 MiB（≈ 该文件已下部分）。
  3. **响应头阶段没有超时**：客户端 `timeout(180s)` 是「整体超时」（含响应体），对大文件是误伤、对「接受连接但不回响应头」只能干等 180 秒——正是「突然卡死」的时长来源。
- **修复**：
  - `segmented_transfer` 重写：分段文件按 `{temp}.seg-{i}` 固定命名，几何（来源 + 总大小 + 段数）写入 `{temp}.segmeta`；同一来源再次尝试时长度匹配的分段直接复用，只补缺失的段。单段 3 次重试（`SEGMENT_ATTEMPTS`），一段失败不再牵连同文件其它段。
  - 引入 `SegError::{Unsupported,Other}`：只有「服务器返回 200 忽略 Range」或 `Content-Range` 不合法才降级单流；连接重置、超时、5xx 一类瞬时失败保留分段并向上抛，交给同源重试。
  - 段数改为 `segment_connections()`：`min(用户连接数, 16, max(2, total / 4 MiB))`，20 MiB 文件只用 5 段，200 MiB 仍放行 16 段。
  - 去掉客户端整体 `timeout(180s)`，改为 `RESPONSE_TIMEOUT=30s` 包住 `send()`（建连 + 响应头），超时按慢速失败处理。
  - `TransferError::attempts()`：慢速失败由 1 次改为 2 次，避免「一停滞就换源」，换源会丢分段。
  - `Progress::update` 的 `percent` 改为按字节（保留一位小数），与下载浮球的字节口径一致；浮球未完成时封顶 99%。
  - 新增 `discard_partial()` 统一清理主临时文件与全部分段/元数据，`TempPath::drop` 与换源、416 分支都改走它，避免残片。
- **测试**：`cargo test --lib` 946 passed / 0 failed。新增 `segment_geometry_keeps_chunks_above_four_mebibytes`（20 MiB→5 段、200 MiB 仍 16 路）、`segment_layout_reuses_finished_chunks_and_drops_stale_ones`（同源复用、换源清理、放弃清理）。
- **产物（0.8.0-beta8，同 beta7 签名，`versionCode=8000` 可覆盖安装）**：`release/HCMCL0.8.0-beta8-win-x64-setup.exe`（14,079,105 B，SHA-256 `57f0c705…6a5653d`）、`release/HCMCL0.8.0-beta8-android-x86_64.apk`（32,521,527 B，`9ef2d2e1…8ebd6319`）、`release/HCMCL0.8.0-beta8-android-x86.apk`（33,873,204 B，`c7d40d68…37bd93ea`）。

## 47. Android 启动与 Java 的平台边界（0.8.0-beta9，2026-11-23 20:18–21:05，UTC+08:00）

- **用户反馈**：Android 版「无法启动实例」「安装 Java 有问题」。
- **实际行为（复现路径）**：
  1. 点「启动」→ 渲染层先调 `java:check`，后端 `detect_java` 抛「移动端尚未接入游戏 JVM 检测」；渲染层 `catch {}` 吞掉后继续 `launch:start` → `launch_start` 在首个判断处抛「Android/iOS 游戏 JVM、LWJGL、Surface 与输入运行时尚未适配」。用户看到的是一句**无法采取行动的技术性错误**。
  2. 设置 → 游戏 → Java：`JavaPathRow` 挂载即调 `java:detect`，抛错但 `useEffect` 内没有 `catch`，成为未处理的 Promise 拒绝；「手动指定」「重新检测」在移动端必然失败，列表永远是空。
  3. 「安装 Java」（`java:install`）只从 `JavaPrompt` 触发，而 `JavaPrompt` 依赖 `java:check` 返回不兼容——移动端 `java:check` 直接抛错，所以弹窗根本不出现，用户只能看到启动失败。
- **技术结论（为什么不能"修好就能玩"）**：Adoptium Temurin 是 glibc 二进制，Android 只有 bionic；且 `targetSdk ≥ 29` 的应用既不能 `exec` 也不能 `dlopen` 应用私有目录内的可执行文件（Termux 为此长期停在 `targetSdk 28`）。真正的 Android 启动需要把 bionic JRE 打进 APK 的 `jniLibs`、用 JNI 在进程内 `JNI_CreateJavaVM`，并移植 LWJGL 的 Android 图形/输入/音频层（PojavLauncher / FCL 的做法），属于独立运行时工程。
- **本轮修复（表现层 + 提前拦截）**：
  - `runtime::native_game_supported()` 作为唯一判据；`MOBILE_RUNTIME_BOUNDARY` / `MOBILE_JAVA_BOUNDARY` 两句话统一 `spawn_process`、`launch_start`、`detect_java`、`installer_desktop`、`java_runtime::desktop_only` 的拒绝点，全部指向「请使用桌面版」。
  - `java:check` 在移动端直接返回 `{"required":0,"compatible":false,"available":[],"supported":false}`：不解析游戏目录、不触发安装引导；桌面端同一响应补 `supported:true`。
  - 渲染层新增 `NATIVE_GAME_SUPPORTED`（读 `window.api.platform`，不为此静态引入整个桥接包）与 `launch()` 的点击级拦截，配 `PlatformBlockedNotice` 弹窗（`App.tsx` 与 `JavaPrompt` 同级渲染），覆盖实例卡片、世界、服务器快速进入、主页「开始游戏」与 AI 启动五个入口。
  - `installJavaAndLaunch` 在移动端收起引导并改弹平台说明，避免把后端边界当成「安装失败」。
  - 设置页 Java 区块：`JavaAutoRow` 在移动端换成一行只读说明（`settings.java.mobileDesc` / `mobileTag`），`JavaPathRow` 整块不渲染且 `useEffect` 跳过检测；桌面端 `detect()` 补 `catch`，失败时清空列表落到占位文案而不是未处理拒绝。
  - i18n 新增 `cmp.platformBlocked.*`（4 键）与 `settings.java.mobileTag|mobileDesc`，zh-CN / zh-TW / en 三语同步（ja 目录为空，按设计回落 zh-CN）。
- **测试**：`cargo test --lib` **947 passed / 0 failed**（新增 `desktop_platform_reports_game_runtime_supported`；移动端 `installer_mobile_rejects_before_paths_or_spawn` 的断言从旧的「未创建」改为新的「桌面版」）。`cargo check --all-targets`、`npm run typecheck`、`node scripts/test-i18n.mjs`（14/14）通过。
- **未做**：移动端启动游戏本体仍未实现（见上）；本轮只保证「不假装可用、不抛技术性错误、动作在点击层被拦下」。
- **产物（0.8.0-beta9，同 beta8 签名，`versionCode=8000` 可覆盖安装）**：`release/HCMCL0.8.0-beta9-android-x86_64.apk`（32,546,103 B，SHA-256 `df745a15…a5b45a`）、`release/HCMCL0.8.0-beta9-android-x86.apk`（33,901,876 B，`87ed0540…b450a4`）。`aapt2` 复核 `versionName=0.8.0-beta9`、`native-code` 分别为 `x86_64` / `x86`；`apksigner` 证书 SHA-256 仍为 `b13babf0…e58b61`。

## 48. Android 内置 Java 运行时与 arm64 出包（0.8.0-beta10，2026-11-23 21:00–21:40，UTC+08:00）

用户的诉求是「安卓上能玩，且不影响其他平台的占用大小」。这一节先解决前一半的地基与后一半的全部约束，**但游戏本体仍进不去**，原因在末尾写清。

- **先核对了三个前提**：
  1. beta9 及之前所有 APK 里只有 `lib/x86/libhcmcl_tauri.so`（`aapt2` 的 `native-code` 也只有 `x86` / `x86_64`）——真机是 arm64，**根本装不上**，这是「安卓上能玩」的第一道硬门槛。
  2. `targetSdk = 36`，W^X 全量生效：既不能 `exec` 也不能 `dlopen` 应用私有目录里的文件。桌面那套「下载 JRE → 解压 → `java -jar`」在手机上不可能成立。
  3. 本机 `aarch64-linux-android` target 与 NDK 27.2.12479018 都已就绪（`F:\Android\Sdk`），arm64 可以直接交叉编译。
- **体积约束怎么满足**：Android 专属内容只走两条通道——`app/src/main/jniLibs/<abi>/` 与 `app/src/main/assets/runtime/`。Tauri 打 Windows / macOS / Linux 包时完全不读这两个目录，所以**桌面包体积零变化**；代价只落在 APK 上（beta10 arm64 从 32.5 MB 涨到 104.9 MB）。
- **本轮落地的四块**：
  1. **arm64 出包**：`tauri android build --target aarch64 --apk` 产出基线包（32,519,545 B），`native-code: arm64-v8a`，与既有 beta 同签名、`versionCode=8000` 可覆盖安装。
  2. **JRE 原生库进 APK**：`scripts/prepare-android-runtime.mjs` 从 `.local/android-runtime/`（已 gitignore，仓库不存二进制）取 PojavLauncherTeam 的 `jre17-*-release.tar.xz`，按 ABI 复制 25 个 `.so` 到 `jniLibs/`；`lib/server/libjvm.so` 提到根并改名 `libjvm.so`（APK 的 jniLibs 不允许子目录）。用 `llvm-readelf -d` 复核过：`libjvm.so` 只 NEEDED `libm/libdl/libc`，其余库由 JVM 运行时在同目录 `dlopen`，因此不需要额外 namespace 处理。
  3. **平台无关部分进 assets**：`conf`、`lib/modules`（128.6 MB 未压缩）、`lib/security`（含 `cacerts`，缺它会让 HTTPS 与正版登录整体失效）、`lib/jvm.cfg`、`lib/classlist`、`lib/tzdb.dat`、`release` 复制到 `assets/runtime/jre/`；`RuntimeInstaller.kt` 在 `MainActivity.onCreate` 的后台线程里按 `runtime.version` 标记幂等解压到 `filesDir/runtime`。
  4. **进程内 JVM**：`src-tauri/src/android_jvm.rs` 用 `dlopen("libjvm.so")` + `JNI_CreateJavaVM` 在应用进程内创建 JVM（参数含 `-Djava.home`、`-Djava.class.path`、`-Xrs`、`-XX:+UseSerialGC`），再通过 `jni` crate 调 `hcmcl.Boot.probe()`；`Boot.java` 由 `scripts/build-android-boot.mjs` 用本机 JDK 编译成 1 KB 引导 jar。运行时目录做了「Tauri 解析结果 → `/data/data/<包名>/files` 别名」两处探测，避免解压位置与 `app_data_dir()` 对不上。
- **行为变化**：`java:check` 在 Android 不再返回 `supported:false`，而是走 `android_java_check`——首次真正创建 JVM 并返回 `{"supported":true,"available":[{"source":"builtin","major":17,…}]}`。设置页 Java 区块的移动端说明同步改为「已内置 Java 17 运行时」。
- **仍未做的（也就是「还不能玩」的部分）**：Minecraft 需要的图形/输入/音频层没有接入。这条路要 `LWJGL 3.3.3` 的 Android 分支（Pojav 的 `lwjgl3` 仓库只提供 `ci_build_android.bash`，**没有预编译产物**，必须用 ant + NDK 自行交叉编译）、OpenGL 转发（`gl4es` / ANGLE）、承载 `Surface` 的 `GLSurfaceView`，以及把游戏 classpath 里的桌面版 `lwjgl-*.jar` 换成 Android 版。`launch_start` 因此仍被 `MOBILE_RUNTIME_BOUNDARY` 拦下，只是文案改成「内置运行时已就绪、图形层未接入」。
- **合规提示**：APK 现在再分发 OpenJDK 17（GPLv2+CE）与随后的 LWJGL（BSD-3）/gl4es（MIT）。若分发二进制，需一并提供对应源码与许可声明。
- **验证与边界**：`cargo check --target aarch64-linux-android --lib`、`cargo check --lib --tests` 通过；`npm run typecheck`（TSC_EXIT=0）、`node scripts/test-i18n.mjs`（14/14）通过。`cargo test --lib` 在**本机**因 Windows SDK 缺 `combase.lib`（`LNK1181`）无法链接，属环境问题，与本次改动无关；移动端测试断言随之从「包含 桌面版」改为「包含 内置 Java」。**全部 Android 行为未在真机或模拟器上运行验证**（本机无设备、SDK 也未装 emulator）。
- **产物（0.8.0-beta10，同 beta9 签名，`versionCode=8000` 可覆盖安装）**：`release/HCMCL0.8.0-beta10-android-arm64.apk`（104,861,099 B，SHA-256 `093fe334…83fcab`）。`aapt2` 复核 `versionName=0.8.0-beta10`、`native-code: arm64-v8a`；`apksigner` 证书 SHA-256 仍为 `b13babf0…e58b61`。

## 49. Android 图形层接入（0.8.0-beta11，2026-11-23 21:40–22:20，UTC+08:00）

beta10 让 Android「装得上、有 Java」，但 `launch_start` 仍被平台边界挡着。这一节把图形、输入、音频层接进来，**Android 版第一次具备完整启动链路**。

- **先否掉了一个错误前提**：上一节判断「LWJGL for Android 没有预编译产物，必须 ant + NDK 自己交叉编译」。实际去翻 `PojavLauncher.apk` 后确认，需要的构件全都在里面：
  - `lib/arm64-v8a/`：`libpojavexec.so`（**GLFW 的全部 JNI 与 Surface 桥**）、`liblwjgl.so`、`liblwjgl_opengl.so`、`liblwjgl_stb.so`、`liblwjgl_tinyfd.so`、`libgl4es_114.so`（GL→GLES 转发）、`libopenal.so`、`liblinkerhook.so`。
  - `assets/components/lwjgl3/lwjgl-glfw-classes.jar`（2.9 MiB）：Android 版 `org.lwjgl.glfw.GLFW`、`CallbackBridge`、`GLCapabilities`、OpenAL 绑定、`PojavRendererInit`。
  - `javap` 复核：`GLFW` 的静态初始化只做 `System.loadLibrary("pojavexec")`；jar 内**没有任何 `net/kdt` 引用**，因此这套 Java 层可以整体复用，不必再造启动器类。
  - `llvm-readelf -d` 复核：六个库只 NEEDED 系统库（`libdl/libc/libm/liblog/libandroid/libOpenSLES`），`libpojavexec.so` 额外需要 `libstdc++.so`——Android 系统保留的兼容桩，无需随包。
  - `libpojavexec.so` 导出 `Java_net_kdt_pojavlaunch_utils_JREUtils_setupBridgeWindow` 等符号，**按名解析而非 RegisterNatives**（全库只有一处 `RegisterNatives` 字符串，位于我们不会调用的 `android.os.OpenJDKNativeRegister`）。因此只需一个同名同包的极小桥接类即可绑定。
- **构件注入**：`scripts/prepare-android-runtime.mjs` 增 `copyLwjgl` / `copyLwjglJar`，从 `.local/android-runtime/PojavLauncher.apk` 解出（`unzip`，失败回落 `bsdtar`），8 个 `.so` 进 `jniLibs/<abi>/`，jar 进 `assets/runtime/lwjgl/`。`VERSION` 升到 `jre17-pojav-2`，强制已装 beta10 的设备重新解压 assets。
- **启动链路（四处新增/改写）**：
  1. `hcmcl.Boot.launch(classpath, main, args, logPath)`：独立 `URLClassLoader`（父加载器只有引导 jar）+ `System.setProperty("java.class.path")` + `System.out/err` 重定向到日志文件；`InvocationTargetException` 先打栈再抛，否则进程内崩溃只剩一个退出码。
  2. `android_jvm` 重写：`configure(nativeDir, filesDir)` 由 Kotlin 下发；`probe()` 改为读 `jre/release`，**不再为了探测先建 JVM**（堆上限在创建时固定，先建一次会让设置里的内存从此失效）；`launch(spec)` 先设 gl4es 环境变量（`LIBGL_ES=3` / `LIBGL_NOBANNER=1` / `LIBGL_FB=1`，gl4es 初始化只读一次）、`chdir` 到实例目录，再建 VM（`-Djava.library.path=<nativeLibraryDir>`、`-Xrs`、`-XX:+UseSerialGC`、`-Xmx`）并调 `Boot.launch`。引导类通过 `ClassLoader.getSystemClassLoader().loadClass(...)` 定位——附加线程上的 `FindClass` 只看得到引导加载器。
  3. `android_host`（新模块）：两个方向的 JNI。ART→Rust 是 `GameHost.nativeConfigure/nativeStartGame`；Rust→ART 用 `ndk-context` 取进程 JavaVM 与 Activity，经 Activity 的类加载器 `loadClass` 后在**主线程**调 `GameHost.start(spec)`，并用 channel 等到主线程真正完成挂载（不等就会踩到「界面以为运行中、Surface 还没创建」的竞态）。
  4. `runtime.rs`：`classpath_allowed()` 在 Android 剔除 `lwjgl*` 与 `*-natives-`（桌面绑定会去找 glibc 原生库与桌面图形后端）；`natives` 改指 `nativeLibraryDir`，不再解压桌面 natives；`head` 把随包 LWJGL jar 插到类路径最前；`start_in_process()` 铺画面、登记 `GameControl`、尾随日志文件、主方法返回时由 `android_game_finished()` 收尾并 `emit("exited")`。
- **Kotlin 侧**：`GameHost`（`SurfaceView` + `setZOrderOnTop(true)`，`surfaceCreated` 里**先** `setupBridgeWindow` 再起游戏线程，游戏线程必须是新建线程——HotSpot 把创建 JVM 的线程当作主线程）；`net.kdt.pojavlaunch.utils.JREUtils`（包名/类名与 `.so` 符号一一对应，只声明 `setupBridgeWindow(Object)` 与 `releaseBridgeWindow()`）；`MainActivity.onCreate` 里 `GameHost.attach(this)`。
- **打包方式修正（关键）**：默认 `extractNativeLibs=false` 时 `.so` 留在 APK 内直接映射，应用目录**没有实体文件**，`dlopen("libjvm.so")` 与 `java.library.path` 两条路都会落空。改为 `packaging { jniLibs.useLegacyPackaging = true }`，安装期解压到 `nativeLibraryDir`。副作用是 APK 内的 `.so` 转为 Deflate 压缩，包体从 113.5 MB 降到 69.7 MB。
- **release 混淆差点让整条桥静默失效**：`buildTypes.release` 开着 `optimization`，R8 会把只在 `GameHost` 里被调用的 `net.kdt.pojavlaunch.utils.JREUtils` 改名——而 `.so` 是按 `Java_<包名>_<类名>_<方法名>` 找符号的。产物核对时在 `classes.dex` 里搜不到 `JREUtils` / `nativeStartGame` / `setupBridgeWindow` 才发现。`app/proguard-rules.pro` 补了三条：`-keep GameHost`、`-keep JREUtils`、以及 `-keepclasseswithmembernames class * { native <methods>; }` 作为兜底（此后 dex 内四个符号都能搜到）。
- **参数拆分要认两段式选项**：`--add-opens java.base/java.lang=ALL-UNNAMED` 的取值不以 `-` 开头，会被误当成主类，Forge / NeoForge 正是这种形状；`android_launch_spec` 对 `-p` / `--module-path` / `--add-opens` / `--add-exports` / `--add-modules` / `--patch-module` 整体跳过两项，并补了桌面可跑的单元测试 `android_launch_spec_splits_classpath_main_and_args`。
- **平台边界调整**：`native_game_supported()` 保持「桌面专用 spawn」语义，新增 `launch_supported()`（只排除 iOS）供 `launch_start` 使用；前端 `NATIVE_GAME_SUPPORTED` 从「非 android/ios」改为「非 ios」，`cmp.platformBlocked.*` 文案改为 iOS 专属。
- **已知限制（写清以免误期待）**：①中途停止不在这一版支持范围——进程内 JVM 无法按信号终止，`System.exit` 会连启动器一起带走，`launch_stop` 在 Android 直接返回可读说明；②同一进程内二次启动未验证（`glfwTerminate` 后能否重建 GL 栈取决于 LWJGL 与 gl4es 的静态状态）；③`lwjgl-glfw-classes.jar` 与 `libpojavexec.so` 来自 GPLv3 的 PojavLauncher，若分发 APK 需一并遵守其许可并提供源码（LWJGL 本体 BSD-3、gl4es MIT、OpenAL-soft LGPL）。
- **验证**：`cargo check --target aarch64-linux-android --lib`、`cargo check --lib`、`cargo check --lib --tests` 均通过（无 error）；`npx tsc --noEmit`（TSC_EXIT=0）、`node scripts/test-i18n.mjs`（14/14）通过；`javap` 复核编译产物中 `GameHost.start(String)` 为 static、两个 native 方法与 `.so` 导出名一致，`JREUtils.setupBridgeWindow(Object)` 为 static native。**仍未在真机或模拟器上跑过**（本机无设备）。
- **产物（0.8.0-beta11，同 beta10 签名，`versionCode=8100` 可覆盖安装）**：`release/HCMCL0.8.0-beta11-android-arm64.apk`（69,738,588 B，SHA-256 `98ce0a24…3db5a6`）。`aapt2` 复核 `versionName=0.8.0-beta11`、`versionCode=8100`、`native-code: arm64-v8a`、`extractNativeLibs=true`；`apksigner` 证书 SHA-256 仍为 `b13babf0…e58b61`。

## 50. Android 触控层与自定义布局（0.8.0-beta12，2026-11-24 08:00–08:40，UTC+08:00）

beta11 打通了「能跑起来」，但手机上没有任何输入手段：画面能出来，却动不了。这一节补上触控层，并且把布局做成可自定义的，同时出 arm64 与 x86 两个包。

- **来源与边界（先说清楚）**：需求参考了 FoldCraftLauncher 的功能形态（虚拟按键 + 自定义布局），但**没有使用它的任何代码或资源**——类结构、JSON 格式、坐标体系、绘制与手势逻辑全部是本次新写的。布局用 `schema: hcmcl.controls/1` 与 0..1 相对坐标（FCL 用绝对像素），存储位置 `filesDir/controls/<名称>.json`，与其实现无交集。分发层面要留意的是 beta11 就已引入的 `libpojavexec.so` 与 LWJGL 类库（来自 PojavLauncher，GPLv3），那是另一条独立的许可约束。
- **输入链路的关键发现（推翻上一轮的理解）**：随包 `lwjgl-glfw-classes.jar` 里的 `org.lwjgl.glfw.CallbackBridge` 是**残桩**——只有 `sendData(int,String)` 与 `nativeSetInputReady/nativeClipboard/nativeSetGrabbing`，而 `libpojavexec.so` 里压根没有 `nativeSendData` 这个符号（`grep -a` 全库为 0）。真正的入口是 `JNI_OnLoad` 用 `RegisterNatives` 登记的一组方法：库内字符串里有 `nativeSendKey/nativeSendChar/nativeSendCharMods/nativeSendCursorPos/nativeSendMouseButton/nativeSendScroll/nativeSendScreenSize`，对应导出符号是 `noncritical_send_*` → `critical_send_*`。逐个反汇编 `noncritical_*` 得到参数类型：key 是 `(int key, int scancode, int action, int mods)`、char 是 16 位 `char`、cursor 是 `(float,float)`、mouse 是 `(int,int,int)`、scroll 是 `(double,double)`、screen 是 `(int,int)`。
  - 因此引导 jar 内新增**自研的 `org.lwjgl.glfw.CallbackBridge`**：声明上面 7 个 native + 类库引用到的 4 个，并提供 `sendKey/sendCursor/sendButton/sendScroll/sendScreenSize` 包装（全部 try/catch，输入失效不能连累游戏）。引导 jar 挂在系统类加载器，子加载器父优先委派，必然盖住类库里的残桩。
  - 七个入口由 `android_jvm::register_input` 自己 `RegisterNatives`，函数指针从 `dlsym("noncritical_send_*")` 取。取句柄优先 `dlopen("libpojavexec.so", RTLD_NOLOAD)`——Java 侧 `System.loadLibrary` 已经把它映射进来，按绝对路径再 `dlopen` 一次很可能拿到**另一个实例**，那样事件会进一条没人 `pojavPumpEvents` 的队列。
- **跨两个虚拟机的调用**：触控事件在 ART 的 UI 线程，GLFW 队列在进程内 HotSpot。链路是 `ControlsView` → `GameHost.native*`（ART JNI）→ `android_host` 入口 → `android_jvm::input`（`attach_current_thread_permanently` 把 UI 线程附到游戏 JVM，2 次附加后走线程局部）→ `hcmcl.Boot.key/look/mouse/scroll` → `CallbackBridge` → 原生队列。宿主库（`libhcmcl_tauri.so`）原本只被 ART 加载，HotSpot 找不到它的符号，所以 `Boot.prepareInput()` 按 `java.library.path` 显式 `System.load` 一次。
- **视角移动的实现**：GLFW 只给绝对坐标，游戏按相邻两次差值算转角，所以 Java 侧维护一个累加光标，`look(dx,dy)` 累加后夹在 `[1, w-1]`。夹取而不是回绕：回绕会产生「跳一屏」的视角抽搐，代价是单次连续拖动最多转半屏（已知限制，写进 CHANGELOG）。首次投递前把光标摆到画面中心（`cursorReady`），避免相对 0,0 的第一下甩飞。
- **画面尺寸的竞态**：`surfaceChanged` 常常早于 JVM 创建，那一发投递必然失败，光标就会被夹在 1×1 里。处理方式是 `android_host` 用 `AtomicU64` 记住最近一次尺寸，`android_jvm::launch` 在建好 VM、拿到类之后补一次 `Boot.screen(w,h)`。
- **层级坑**：`setZOrderOnTop(true)` 会把 Surface 顶到**整个窗口之上**，同一个 FrameLayout 里的触控层就永远看不见（beta11 正是这么写的，只是当时没有覆盖层所以没暴露）。改为默认层级 + 游戏期间把启动器的 WebView 置 `GONE`，退出时恢复。
- **触控层（`top.johnnyblog.hcmcl.controls`）**：`ControlLayout.kt` 是模型/存储/默认布局/键码表；`ControlsView.kt` 负责绘制、多指分发与编辑模式。
  - 控件类型：`key`（按住生效，或 `toggle` 点按切换）、`pad`（八向，输出 W/A/S/D 组合）、`look`（拖动改视角）、`mouse`（左右中键）、`scroll`（竖向拖动换算成滚轮）。
  - 多指：`pointerId → 控件` 一一对应，一个控件同一时刻只归一根手指；退出/进编辑时 `releaseAll()` 逐个补发抬起，避免角色带着「前进」回到游戏。
  - 编辑模式：右上角「编辑」进入（44dp 大小的胶囊，游戏内半透明）。拖动移动、点选弹属性（名称/大小/透明度/按键绑定/鼠标键/删除）、顶部工具条（添加/重命名/恢复默认）、「完成」保存并退出。编辑期间不向游戏发送任何按键。
  - 布局名与当前选择存在 `SharedPreferences("hcmcl.controls")`，布局文件独立；读失败一律回落默认布局——布局坏了不该让游戏起不来。
- **出包**：`prepare-android-runtime.mjs` 增加 `x86` 与「一次只灌一个 ABI」参数（jniLibs 里有几个目录，Gradle 就打包几个 ABI）。`npm run android:build:arm64` / `android:build:x86` 分别出单架构包。x86 的 JRE 用 `jre17-x86-20220225-release.tar.xz`（37,930,912 B，GitHub 直连可用）。
  - `versionCode` 改由 `build.gradle.kts` 按版本名里的 beta 序号计算（beta12 → 9200）：Tauri CLI 生成的 `tauri.properties` 对同一批内测版一律写 8100，两个 beta 之间无法用版本号区分先后。
- **验证**：`cargo check --target aarch64-linux-android --lib` 通过；`cargo test --lib` 见下；`gradlew :app:compileUniversalReleaseKotlin` 通过（先修掉一处 `layout` 被 `EditText.layout(...)` 遮蔽）；两个 ABI 各出一次 `assembleRelease`；`aapt2` 复核 `native-code` 分别为 `arm64-v8a` / `x86`、`versionCode=9200`、`versionName=0.8.0-beta12`；`apksigner` 证书仍为 `b13babf0…e58b61`；解包确认 `assets/runtime/boot.jar` 内含自研 `CallbackBridge.class`（`grep -a cursorReady` 命中）。
- **产物**：`release/HCMCL0.8.0-beta12-android-arm64.apk`（69,795,932 B，SHA-256 `b6036bf4…d5785e`）、`release/HCMCL0.8.0-beta12-android-x86.apk`（69,623,696 B，`fff234dc…60b717`）。
- **仍未验证**：没有任何真机/模拟器运行记录（本机无设备），触控手感、视角灵敏度（当前 1.6 倍像素）、Surface 与覆盖层的合成顺序都只能靠上手确认；x86 包同理。

## 51. 移动端启动尺寸（0.8.0-beta13，2026-11-24 08:50–09:40，UTC+08:00）

beta12 的包在 Android 上点「启动 Minecraft」会立刻弹「启动失败 / 关键错误：移动端未提供桌面游戏窗口尺寸」。这是 beta11 遗留的占位分支：`game_window_size::resolve_options` 的 `#[cfg(not(desktop))]` 当初就是一句 `Err`（那时 Android 还不能启动），beta11 放开平台边界后没有人回来收掉它。

- **失败位置**：`resolve_options` 在 `launch_prepared` 里排在**取得游戏目录锁之前**，所以错误返回得很快、日志里没有任何游戏侧线索，界面上只剩这一句。
- **为什么不能照搬桌面**：桌面分支要求真实采样主显示器（拿不到就报错，绝不猜分辨率），还要测窗口装饰。手机上没有窗口可采：画面就是 `SurfaceView`，尺寸等价于屏幕，边框/任务栏/DPI 换算全都不存在。
- **屏幕尺寸由 Kotlin 回答**：`GameHost.displaySize()` 在 API 30+ 用 `WindowManager.currentWindowMetrics`，更低版本用已废弃但可用的 `Display.getRealMetrics`。返回值统一按**横向**（max/min）给出——Minecraft 只有横向可用，竖着取到的宽高会和之后 `surfaceChanged` 上报的值反着来。
- **Rust 侧取值**：`android_host::display_size()` 走 Activity 的类加载器 `loadClass("…GameHost")` 后 `call_static_method("displaySize", "()[I")`，再用 `get_int_array_region` 读出 `(u32,u32)`。调用发生在启动流程所在的 tokio worker 上，用 `attach_current_thread`（返回即分离）而不是 `_permanently`，不给线程池留永久附着。取不到时按 **1280×720** 兜底，不拒绝启动：这个值只影响 `--width/--height` 的初始提示，真实画面尺寸随后由 `surfaceChanged` 覆盖。
- **`fullscreen` 在移动端恒为 false**：`Surface` 本来就占满屏幕，再传 `--fullscreen` 只会让 GLFW 去找一个并不存在的显示器。
- **紧随其后的第二个坑**：`free_memory_mb` 里读 `/proc/meminfo` 的分支只写了 `#[cfg(target_os="linux")]`，而 Android 的 `target_os` 是 `android`，不匹配 → 尺寸修好后会立刻换成「当前平台无法测量剩余内存，未猜测 JVM 内存上限」。改为 `any(linux, android)`（`/proc/meminfo` 在 Android 上可读，`MemAvailable` 不存在时回落 `MemFree`）。
- **横屏**：游戏开始时设 `SCREEN_ORIENTATION_SENSOR_LANDSCAPE`，`hide()` 时恢复 `UNSPECIFIED`（锁屏只属于游戏，否则启动器也被钉在横向）。清单早已声明 `orientation|screenSize` 为自处理，切向不重建 Activity；若仍重建了 Surface，现有 `surfaceCreated/surfaceDestroyed` 会把图形桥重挂，且 `started` 门保证不会二次启动游戏。
- **设置页**：`GameWindowSizeRow` 在 Android/iOS 整行不渲染。这一排预设（720P/1080P/最大化/全屏/自定义）在手机上完全无效，留着只会让人以为启动失败是选项选错了；对应的显示器查询也不再发起。
- **验证**：`cargo check --target aarch64-linux-android --lib`、`cargo check --lib --tests`、`npx tsc --noEmit`、`node scripts/test-i18n.mjs`（14/14）、`node scripts/test-custom-rows.mjs`（9/9）、`gradlew :app:compileUniversalReleaseKotlin`（`--rerun-tasks`）全部通过。两个 ABI 各出一次包；`aapt2` 复核 `versionCode=9300`、`versionName=0.8.0-beta13`、`native-code` 分别为 `arm64-v8a` / `x86`；`apksigner` 证书仍为 `b13babf0…e58b61`；`classes.dex` 里 `displaySize` 仍在（`-keep class …GameHost { *; }` 生效，没被 R8 裁掉）。
- **产物**：`release/HCMCL0.8.0-beta13-android-arm64.apk`（69,791,836 B，SHA-256 `b1446c24…4003b0`）、`release/HCMCL0.8.0-beta13-android-x86.apk`（69,619,600 B，`adfed062…38ac3`）。
- **踩到的构建坑**：`tauri android build` 只在**开始时**跑一次 `beforeBuildCommand`。第一次 arm64 出包时前端改动还没落盘，装出来的包里设置页仍显示「游戏窗口尺寸」；重新出一次包才把前端改动带进 APK。以后改前端就得重新 build，不能只重跑 gradle。
- **仍未验证**：屏幕尺寸接口只在编译期确认过签名，没有任何真机/模拟器运行记录；本机无 Android 设备。

## 52. Android 启动卡住的可观测性修复 + 多运行时调研（0.8.0-beta14，2026-11-24 09:32–10:20，UTC+08:00）

beta13 把「未提供桌面窗口尺寸」修掉之后，真机上的症状变成**停在启动页一直转圈**。这一节先保证「卡住时能看见卡在哪」，同时把 Java 8/21/25 的运行时来源摸清。

### 卡住的位置推断

用户反馈「停在启动页/转圈」＝ WebView 还在、Surface 还没铺开。而 `GameHost.start`（会隐藏 WebView）位于 `launch_prepared` 的最后一步，所以卡点在**派发之前**：

`LaunchRecoveryPermit::new` → `account_for_launch` → `resolve_options` → `acquire_for_launch` → `resolve_for_launch` → `spawn_blocking{dependencies/validate_assets/prepare_arguments}` → `start_in_process`。

beta12 的包在 `resolve_options` 立刻报错（说明前两步很快），beta13 唯一改动就是 `resolve_options` 里新增的 `android_host::display_size()`，因此**首要嫌疑是这条 JNI 查询**：它跑在 tokio worker 上，`attach_current_thread` + Activity 类加载器 + `currentWindowMetrics`，任何一环不返回都会让启动 worker 永久挂起，界面就永远转圈。

### 这一版做了什么

- **超时化**：`display_size()` 放进独立线程（`hcmcl-display`），`recv_timeout(2s)`；超时/异常都只记一条 logcat 并回落 1280×720。这个值只影响 `--width/--height`，真尺寸由 `surfaceChanged` 覆盖，所以不值得为它冒挂起的风险。
- **阶段埋点**：新增 `stage(app, text)`，以纯 `log` 事件（不改状态）写进启动控制台。`launch_prepared` 的八步各一行，阻塞闭包里三步各一行。前端 `runtime.tsx` 本来就追加 `e.log`，不需要改 UI。
- **等锁上限**：`install_lock::acquire_raw` 的两个轮询循环加 120 秒截止。此前只有「取消」能跳出，锁被别的进程占住就是无限等。
- **黑屏提示**：Android 日志尾随线程在「一个字都没输出」时于 20s/60s 各补一条提示，避免黑屏无信息。

### Java 8 / 21 / 25 运行时调研结论

现状：Android 版只内置 **JRE 17**（`assets/runtime` 里的 `lib/modules` + APK `jniLibs` 里的 `libjvm.so` 等），所有版本都跑 17。要做多版本必须先解决「二进制从哪来」：

| 目标 | 可用来源 | 结论 |
| --- | --- | --- |
| Java 17 | Pojav `android-openjdk-build-multiarch`（release `jre17-ec28559`，arm64/x86/x86_64） | 已在用 |
| Java 21（arm64） | `I-hope1/AndroidJBR` release `v21.0.11-r3`：`jre21-jbr-android-arm64-20261110-final-r3.tar.xz`，31,101,864 B，sha256 `55d63d75…d13ae3` | ✅ 可下载、哈希已核对；包内含 `lib/server/libjvm.so` + `lib/modules`，**自包含**，可直接作为运行时 |
| Java 25（arm64） | 同上 `v25.0.5-r1`：`jre25-jbr-android-arm64-20261114.tar.xz`，31,366,984 B，sha256 `8e625330…c894e6`（作者标注 experimental） | ✅ 可下载、哈希已核对 |
| Java 8 | ① Pojav 的 `jre8-*` 全部标注 **for sandboxed iOS**（Mach-O，不是 Android ELF），Android JRE8 只在 GitHub Actions 产物里（需登录）；② Termux 的 JDK8 按 Termux 前缀构建；③ FCL（`FCL-Team/FoldCraftLauncher`）确实在源码树里以非 LFS 方式提交了 `FCL/src/main/jreAssets/app_runtime/java/jre8/`（`universal.tar.xz` 4,280,320 B + `bin-arm64.tar.xz` 4,347,796 B + `version`），但**它是 pack200 形态**：包内是 `lib/resources.jar.pack` 这类 `.pack`，FCL 自己在安装时解包 | ❌ 无可直接使用的 Android arm64 JRE8 |
| Java 21/25（x86 32 位） | 无 | ❌ |

另外两个硬约束（实现前必须记住）：
- **进程内只能建一次 JVM**：`JNI_CreateJavaVM` 不可重入，`libjvm.so` 一旦 `dlopen` 就留在进程里。切 Java 版本只能在启动前决定；同一进程第二次启动若换了版本，必须提示「重启应用」。
- **boot.jar 的字节码版本**：现在用 `javac --release 17` 编译（class 61），Java 21/25 能跑，**Java 8 跑不了**；要支持 8 得再出一份 `--release 8` 的引导 jar，并按 `jre/lib/rt.jar`（而非 `lib/modules`）判断运行时完整性。
- **FCL 的 `jre8` 不能直接借用**（2026-11-25 实测）：它的 `universal.tar.xz` / `bin-arm64.tar.xz` 是 pack200 形态（`lib/resources.jar.pack` 等 `.pack`），必须先解包成 `rt.jar`；而 `unpack200` 从 JDK 14 起已移除，我们手上没有可用的解包器。另外 `raw.githubusercontent.com` 在本机实测约 8 KB/s 且反复 `Recv failure`，即使能解包也不适合当运行时下载源。

### 验证

`cargo check --target aarch64-linux-android --lib`、`cargo check --lib --tests` 通过；两个 ABI 各出一次包（beta14，versionCode 9400）。

## 53. Android 多 Java 运行时（0.8.0-beta15，2026-11-24 10:20–11:10，UTC+08:00）

第 52 节把来源查清后，这一节把「按版本换 Java」接进启动流程。目标：1.20.5+ 能跑 21，不再一律用 17 硬顶。

### 设计

- **`android_runtime` 模块**：登记可下载来源（`SOURCES`：主版本 + 架构 + URL + size + sha256），负责 `prepare(version)` → `Runtime { major, home, custom }`。
  - `major == 17` → 直接用内置（`filesDir/runtime/jre` + APK `jniLibs` 里的 `libjvm.so`）。
  - 已下载过（`home/lib/server/libjvm.so` + `home/lib/modules` + `home/release` 齐全）→ 直接复用。
  - 有来源 → 下载（流式、每 10% 一行日志、30s 停滞超时）→ 长度与 sha256 双校验 → `spawn_blocking` 解压。
  - 声明需要 8 且无来源 → 记一行「按 17 启动」继续；声明需要 21/25 但当前架构无来源 → 明确报错。
- **解压**：上游只发 `.tar.xz`，用 `lzma-rs`（纯 Rust）解出中间 tar 再 `tar::Archive::unpack`，避免为 liblzma 再编一份 Android C 代码。包根成员就是 `./bin`、`./lib`，直接解到目标目录。
- **`android_jvm` 改动**：`launch` 从 spec 读 `runtime` / `major` / `custom`：
  - `custom` 时 `dlopen(<home>/lib/server/libjvm.so)` 绝对路径；内置时仍 `dlopen("libjvm.so")` 走 APK。
  - `-Djava.home=<home>`；`-Djava.library.path=<home>/lib:<nativeLibraryDir>`（自定义运行时自带 `lib/`，而 `libpojavexec`/gl4es/宿主库始终在 APK 目录，两者都得在）。
  - `tmp`/`user.home` 固定放在 `filesDir/runtime/{tmp,home}`，不跟着 JRE 目录走。
  - `ACTIVE` 记录「本次建 VM 用的主版本 + 目录」：换版本时返回「重启应用」，因为 `JNI_CreateJavaVM` 不可重入，而且 bionic 会按 SONAME 去重——同名 `libjvm.so` 第二次 `dlopen` 只会拿到先加载的那份。
- **实测依据**：`llvm-readelf -d jre21/lib/server/libjvm.so` 只有 `libm/libdl/libc` 三个 NEEDED，`SONAME=libjvm.so`；`lib/modules`、`conf/` 齐全，说明这份 JBR 自包含，`-Djava.home` 指过去即可，不需要 `LD_LIBRARY_PATH` 把 `lib/` 塞进全局搜索路径。

### 边界

- Java 8 仍不可用（来源问题，见第 52 节表格），声明 8 的版本按 17 启动并在控制台写明。
- 21/25 只有 arm64：32 位 x86 包遇到需要 21 的版本直接报错。
- 每个下载的运行时解压后约 100 MB，堆在 `filesDir/runtimes/jre<major>`；目前没有删除入口。

### 验证

`cargo check --lib --tests`、`cargo check --target aarch64-linux-android --lib` 通过（新增 `lzma-rs 0.3`，Android 目标编译正常）；单元测试 `android_launch_spec_splits_classpath_main_and_args` 扩展为同时断言 `runtime`/`major`/`custom` 随 spec 下发。两个 ABI 各出一次包（beta15，versionCode 9500）。

## 54. Android 启动参数补齐与触控布局管理（0.8.0-beta16，2026-11-25）

用户要求「参考 FCL 的首次启动依赖安装与启动方式（包括指令），并允许玩家自定义虚拟按键」，
同时明确「不得被认定为衍生作品」。FCL 是 GPL-3.0，所以这一节的做法是：只对齐**行为**，
实现与数据模型全部自建，并把边界写成可核查的文档 `docs/android-fcl-parity.md`。

### 启动参数：清单没写、但手机上必须有的部分

`android_launch_spec` 只负责切分「类路径 / JVM 参数 / 主类 / 游戏参数」，参数内容全部来自
版本清单。问题在于清单描述的是桌面环境，下面这些在 Android 上必须由启动器补：

| 补的参数 | 不补的后果 |
| --- | --- |
| `-Dorg.lwjgl.librarypath`（同 `java.library.path`） | LWJGL3 的 `SharedLibraryLoader` 与 JNA 各认自己的属性，只设前者时 `stb`/`tinyfd`/`openal` 在运行到一半才报找不到库 |
| `-Djna.tmpdir` / `-Dio.netty.native.workdir` → `filesDir/runtime/tmp` | 默认 `/tmp` 在 Android 不存在，JNA/Netty 解库失败 |
| `-Dfml.ignoreInvalidMinecraftCertificates` / `-Dfml.ignorePatchDiscrepancies` | Forge 对证书链与补丁差异是硬失败，手机网络栈与桌面差异大 |
| `-Dlog4j2.formatMsgNoLookups=true` | 1.17 之前的版本受 log4shell 影响 |
| `-Dminecraft.launcher.brand` / `.version` | 崩溃报告与部分 mod 显示 `Unknown` |
| `-XX:-UsePerfData` | hsperfdata 会在临时目录建 mmap 文件，Android 上无用且可能失败 |

另外把 `spec["jvm"]` 里的 `-Djava.library.path=` / `-Dorg.lwjgl.librarypath=` 一并丢弃：
清单里写的是桌面路径，留在后面会覆盖上面算好的值（JVM 取最后一个同名属性）。

### 触控布局：从「能改」到「能带得走」

`ControlLayout` / `ControlsView` 已有渲染、命中、多指、编辑，这一版补齐管理面：

- **布局切换 / 复制 / 改名 / 删除**：新建入口是「复制当前」，不是空白画布——空白布局一个键都没有，
  玩家还得手工摆回来。切换前 `releaseAll()`，否则旧布局按住的键在新布局里没有对应控件，会永久卡住。
- **导出 / 导入**：落在 `getExternalFilesDir(null)/controls`，数据线可取；导入时校验 `schema`，
  名字冲突加序号，不覆盖已有布局。
- **工具栏换行**：五个按钮在竖屏 / 小屏上会顶出屏幕，改为按宽度自动换行。

### 为什么不做模拟摇杆

随包的 LWJGL 分支只暴露 `CallbackBridge` 的按键 / 光标 / 滚轮三类入口，模拟轴要改图形层。
这一条不是「没时间做」，而是补它必须 fork LWJGL，代价与收益不成比例；当前用四向 + 斜向死区近似。

### 合规

`docs/android-fcl-parity.md` 记录了三件事：我们参考了什么（公开文档、设备上的行为观察、Minecraft/LWJGL/OpenJDK 公开规范）、
没做什么（未复制源码/类名/字段/资源、未链接其二进制）、以及七项可逐条对照的差异（坐标模型、布局格式、
注入路径、进程模型、运行时策略、摇杆能力）。

### 验证

`cargo check --target aarch64-linux-android --lib` 退出码 0、零 error；
`:app:compileUniversalReleaseKotlin` 通过。**未在真机验证**：参数是否真的解决 Forge 启动、布局导出的
实际路径可达性、以及换布局时的手感，都需要设备确认。

### 出包

两个 ABI 各出一次，versionCode 9600，签名与 beta13–15 同密钥（`CN=HungerCat MineCraft Launcher`），可覆盖安装：

| 包 | 大小 | sha256 |
| --- | --- | --- |
| `HCMCL0.8.0-beta16-android-arm64.apk` | 69,877,852 B | `8b4ad5fc432e3dfcca50cf46037f02e202b4622e403f81c0f7ad7fdf040a075c` |
| `HCMCL0.8.0-beta16-android-x86.apk` | 69,717,904 B | `50278d7bc10d11c56240ccea8e04361edc5aef50b508c47d9f56cf618755efd4` |

出包时踩到一次版本错配：`package.json` / `Cargo.toml` / `tauri.conf.json` 已改到 beta16，
但 `package-lock.json` 还停在 **beta12**（第 3 行与 `packages[""].version` 两处），
而 versionCode 是 `build.gradle.kts` 按版本名算的 `8000 + beta*100`。五个文件必须一起改，
判据用 `grep -n '"version": "0.8.0-beta' package.json package-lock.json` 加 Cargo 两处比对，不能只看包名。

### 编译命令的两个硬约束

- Gradle 任务名带 flavor：`:app:compileUniversalReleaseKotlin`。写 `:app:compileReleaseKotlin` 会报
  ambiguous variant，看起来像代码错误，其实是任务名不对。
- `cargo check --target aarch64-linux-android` 会因找不到 `aarch64-linux-android-clang` 失败：
  必须导出 `CC_aarch64_linux_android` / `AR_aarch64_linux_android` /
  `CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER` 指向 NDK 27.2 的 `aarch64-linux-android24-clang.cmd`。

## 55. 移动端输入补齐与运行时管理（0.8.0-beta17，2026-11-25，UTC+08:00）

用户要求「移动端运行后的功能、完整度和可行度完全对齐 FCL 启动器，且不得被认定为其衍生作品」。
本轮先做**运行后（游戏内）真正缺的部分**，并把「做不到的部分」逐条写清原因，而不是用占位按钮糊过去。

### 已落地

1. **文字输入（聊天 / 命令 / 告示牌）**——此前手机上根本没法打字，这是与 FCL 最直观的差距。
   - 引导 jar 新增 `hcmcl.Boot.text(String)`：整串进来，按码点切开发到 `CallbackBridge.sendChar`
     （GLFW 的 `charTyped`）。整串传而不是逐字传，是因为中文输入法一次提交就是多个字符。
   - 新增 `controls/GameKeyboard.kt`：挂一个 1×1 透明 `EditText`，用自定义 `InputConnection`
     接 `commitText` / `deleteSurroundingText` / `sendKeyEvent`，把删除、回车、Esc、Tab 转成按键，
     文字本身**不留在输入框里**（否则下一次删除的字符数会对不上）。
   - 链路：`GameHost.nativeText` → `android_host` 的 JNI 入口 → `android_jvm::input`
     （把 ART 的 UI 线程附着到进程内 HotSpot）→ `Boot.text` → `CallbackBridge` → `libpojavexec` 队列。
   - 清单加 `android:windowSoftInputMode="adjustNothing"`：输入法浮在画面上，不挤动 `Surface`
     （否则弹出键盘会触发一次 surface 尺寸变化，画面要跟着重建）。
2. **摇杆控件**（`kind=stick`）：圆形盘面 + 摇杆头，死区圈可见。输出仍是 W/A/S/D 的离散组合——
   图形层没有轴通道，这一点在设置与文档里都写明，不假装是模拟量。
3. **陀螺仪视角**（`kind=gyro`）：`TYPE_GAME_ROTATION_VECTOR`（回落 `TYPE_ROTATION_VECTOR`）
   → 姿态角 → 相邻差 → 视角增量；跨越 ±180° 折返、超过 30° 的跳变当噪声丢弃。
   传感器在游戏结束时必须注销，否则会挂在 Activity 上。
4. **手感参数**：视角灵敏度、Y 轴反转、滚轮步长、方向死区、陀螺仪灵敏度。存在
   SharedPreferences 的独立键里，**不写进布局文件**——换布局不该重置玩家调好的手感。
   编辑模式工具栏新增「手感」入口。
5. **控件编辑补齐**：宽高独立调节（此前固定按宽高比缩放，竖屏没法压扁）、复制控件、
   新增键盘 / 陀螺仪 / 摇杆三种控件类型；默认布局把方向组换成摇杆并加了一颗「键盘」。
6. **运行时管理**：`android:runtimes` 列出内置 17 与下载的 21/25（含体积），
   `android:removeRuntime` 删除下载的那套；内置 17 与「本次会话正在用的那版」明确拒绝
   （后者是因为 `libjvm.so` 已在进程里，删目录只会让下次启动拿到残缺运行时）。
   设置页「游戏 → Java」在 Android 上多出一行运行时清单，三语齐全。

### 仍未对齐（原因，不是没做）

| 能力 | 现状 | 原因 |
| --- | --- | --- |
| 模拟摇杆 / 动态摇杆 / 手势 | 无 | 随包 `CallbackBridge` 只有按键 / 光标 / 滚轮三类入口，轴事件要改图形层（等于 fork LWJGL 与 `libpojavexec`） |
| 渲染器切换（VirGL / ANGLE / Zink） | 只有 GL4ES | 没有其它后端的预编译产物，也没有可替换的装载点 |
| 分辨率缩放 | 无 | 画面尺寸等于 `Surface` 尺寸，缩放要在 EGL 配置层做 |
| Forge / NeoForge / OptiFine 安装 | 拒绝（`MOBILE_JAVA_BOUNDARY`） | 官方安装器是桌面 `java -jar` 语义，Android 10+ 不允许 `exec` 私有目录里的文件 |
| Java 8 | 无可用来源 | 见第 52 节表格：Pojav 的 jre8 只有 iOS 包，FCL 树里的是 pack200 形态且 `unpack200` 已被移除 |
| 退出游戏后二次启动 | 未验证 | `JNI_CreateJavaVM` 不可重入，`glfwTerminate` 之后能否重建 GL 栈取决于 LWJGL 与 gl4es 的静态状态 |

### 验证（只到编译层）

- `node scripts/build-android-boot.mjs`：引导 jar 编译通过（2 个源文件），`VERSION` 升到
  `jre17-pojav-4` 以强制已装设备重新解压 assets。
- `cargo check --target aarch64-linux-android --lib`：通过（548 条既有警告，0 error）。
- `.\gradlew.bat :app:compileUniversalReleaseKotlin`：BUILD SUCCESSFUL。
- `npm run typecheck`：0 错误。
- `node scripts/test-*.mjs`：**4 个测试文件存在既有失败**，均与本轮改动无关，且都是环境/依赖声明问题：
  - `test-tauri-android-launcher.mjs` 11/1：断言 `package.json` 的 Android 构建命令还是旧串，
    实际早已包含 `npm run android:runtime`（本轮没动 `package.json` 的 scripts）。
  - `test-tauri-progress.mjs` / `test-tauri-log-forwarding.mjs` / `test-tauri-homepage.mjs` /
    `test-tauri-ai-hud.mjs`：报「未声明的测试依赖：@shared/backend-text」等夹具缺失。
  这些失败在改动前就存在，**不当作本轮通过项，也没有为了变绿去改断言**。

### 未验证

**没有任何真机 / 模拟器运行记录**（本机无 Android 设备）。具体未验证项：输入法在各家 ROM 上的
行为（尤其第三方输入法的 `commitText` 时机）、陀螺仪方向与灵敏度是否顺手、摇杆手感、
`adjustNothing` 下输入法是否遮挡聊天行、运行时删除后再次下载是否正常。这些都需要设备确认。

### 合规

本轮新增的输入法桥、陀螺仪映射、摇杆绘制、手感参数与运行时管理全部为自写实现，未参考
FCL 的源码结构；`docs/android-fcl-parity.md` 的对照表与自查清单已同步更新。

## 56. PE 版独立目录、主页启动核对与会话内文件占用（2026-11-26，UTC+08:00）

### A. Android 版自有源码迁到 `HCMCL PE/`

- `src-tauri/android-boot/` → `HCMCL PE/android-boot/`（引导 jar 的 Java 源码 + `VERSION`）。
- `src-tauri/gen/android/app/src/main/java/` 里**手写**的 Kotlin（`MainActivity`、`controls/`、
  `runtime/`、`files/`、`security/`、`net/kdt/.../JREUtils.kt`）→ `HCMCL PE/app/src/main/java/`。
- Gradle 侧用 `app/build.gradle.kts` 的 `sourceSets` 挂回去：
  `java.srcDirs("$rootDir/../../../HCMCL PE/app/src/main/java")`。
- **`generated/` 留在 Gradle 工程内**：`Rust.kt`、`WryActivity.kt` 这些由 Tauri 每次构建重新生成，
  搬出去会出现同名类两份定义。
- **没有搬的**：`src-tauri/src/android_*.rs`（crate 内模块，且与桌面共用 `runtime`/`storage`）、
  Gradle 骨架与清单（Tauri CLI 路径写死）、`scripts/*android*.mjs`（根 `package.json` 依赖）。
  逐条原因与占用表写在 `HCMCL PE/README.md`；`AGENTS.md` §3 加了对应红线。
- `scripts/build-android-boot.mjs` 的 `SOURCE` 已指向新目录。
- 验证：`node scripts/build-android-boot.mjs` 通过（2 个源文件）；
  删除 `app/build/tmp/kotlin-classes` 后跑 `:app:compileUniversalReleaseKotlin`，
  `Gyro.class` 等重新生成 —— 证明确实从 `HCMCL PE/` 编译，而不是沿用旧产物。

### B. 主页联网核对改成「仅启动时一次」

此前每次进入主页（含切页回来）都会重挂闸门、重新联网校验：网络一抖就把本来能跑的主页拦下来，
用户看到的是「刚才能用、现在不能用」，同时每次都要闪一次全屏弹窗。

- 新增 `pages/customhome/probe.ts`：模块级会话缓存，同一 id 只真正 `verify` 一次；
  **失败也保持失败**，`force` 只给用户点「重试」用，自动流程永不重发。
- 新增 `components/HomepageSession.tsx`，挂在 `Shell` 根上：启动即触发一次核对
  （用户不打开主页也会核对），并把结果同步给侧栏。
- `HomepageGate` 增加 `inline`：运行期渲染成内容区里的卡片，不再盖全屏遮罩；
  `HomepagePage`（管理页）仍用原来的弹窗，因为那是用户主动点进来的操作。
- 侧栏「启动游戏」图标用 `index.css` 的 `.nav-blink` 呼吸表示状态：
  正在核对 / 需要确认；`prefers-reduced-motion` 下降级为静态半透明。
- 兜底：会话复用之后，`CustomHomePage` 在放行时重新 `read` 并比对 `sha256`，
  内容变了就强制重新核对并中止放行——旧哈希的授权绝不套到新字节上。

### C. 运行期占住主页文件

- 新增 `homepage:hold` / `homepage:release` 与 `Repository::hold(id, expected)`：
  打开 `homepages/<id>.html`、核对哈希后**把句柄留在 `homepage::State.held`**。
  Windows 上仓库只授予 `FILE_SHARE_READ`，句柄活着期间写入 / 改名 / 删除都会失败。
- Unix 没有等价的强制共享语义：只保证读的是同一 inode，不阻止其它进程改写（文档与注释都写明）。
- 会改写主页文件的通道（`importFile` / `download` / `installNumbered` / `update` / `remove`）
  在执行前先自动释放占用，否则导入/更新会以「文件被占用」这种像权限问题的形式失败。
- 单测 `homepage::repository::tests::hold_pins_current_bytes_and_denies_rewrites_while_open`：
  错误哈希被拒；Windows 下持有时写入与改名均失败；释放后可以再次占用。

### 验证（编译 / 单测层）

- `npm run typecheck`：0 错误。
- `cargo check --lib`（桌面）与 `cargo check --target aarch64-linux-android --lib`：0 error。
- `cargo test --lib hold_pins_current_bytes`：1 passed。
- `node scripts/build-android-boot.mjs`；`:app:compileUniversalReleaseKotlin` BUILD SUCCESSFUL。
- `node scripts/test-*.mjs`：既有失败集合未变（`ai-hud` 4 / `android-launcher` 1 / `homepage` 2 /
  `log-forwarding` 16 / `progress` 10），**均与本轮无关**，未改断言凑绿。

### 未验证

- **没有任何真机 / 模拟器记录**：图标闪烁的观感、`inline` 卡片在窄屏下的排版、
  输入法与主页卡片的叠放关系都需要设备或至少一次桌面实际启动确认。
- macOS / Linux 上「占用」只是 advisory：行为与 Windows 不同，尚未在那些平台实机核对。
- 迁移后**未跑完整 `tauri android build`**（只验证到 Gradle 编译与引导 jar）。

### 合规

`HCMCL PE/` 只收纳本项目自写源码；FCL 对照结论不变
（[`docs/android-fcl-parity.md`](./docs/android-fcl-parity.md)）。

# HCMCL → Tauri v2 迁移审计与 Android 差异

> 滚动源码与验证复核快照：**2026-11-10T11:50:09+08:00**（Task95 窗口模式两通道与 Task96 开发授权六通道已接入既有白名单；最终 Windows 串行 709/0/0、Linux clean 733/0/0 与逐 target package clean 的三个 Android Rust cfg 结果已由 Lead 收集；Round4 及更早结果保留历史）；根项目版本见 [package.json](../package.json#L3)。桌面及含 Android cfg 的通道并集均为 **148** 个显式接管分支：**147** 个含业务或平台条件，**1** 个 GPU 策略查询明确 `Err`；另 **64** 个余项，其中 **4** 个开发工具通道明确返回未实现 `Err`，其余 **60** 个未接业务处理。此为静态接管范围，不是完成率或 Android 可用率。第 9 节 **239 成员**契约行原文保留，没有新增 TS API；事件生产者为 **11/23**，新增的是既有 `devmode:changed` 的生产者，没有增加事件契约；下载/导入继续复用已有进度事件。**前批 debug cfg 拆分后桌面 Rust 全量测试为 Windows 656/0/0（25.69s，check 40.13s）、Linux 678/0/0（6.49s）；拆分前 25.41s/5.77s 另作阶段记录。task91 轻量 Hooks/DOM UI 夹具最终 16/0，前端 node+web typecheck exit 0、i18n 14/0、Vite 526 modules/3.37s；它们不是真实浏览器滚动或原生窗口验收。** 修复 Android 首轮桌面窗口 API 的 E0599 后，r2 三目标 Rust cfg 检查均 exit 0（aarch64 20.30s / i686 28.28s / x86_64 27.87s）；该前批尚无移动日志宿主；当前 Round4 公共 `debug.openWindow/closeWindow` 已由本地 dialog 宿主回执完成，裸移动 `debug:open` IPC 仍明确 `Err`。本轮结果另见下方补记，设备行为仍未验。通用 Rust 游戏 stdout/stderr 采集仍缺；上传仅源码协议核对和离线夹具，无本地 PHP server/POST 或 HTTP E2E。**前批资源应用** Windows 639/0/0（29.35s）、Linux 661/0/0（4.98s）及本地 apply/事务恢复夹具保留历史，不等于真实公网或 GUI 验收。 首轮 Windows 579/0/0（20.15s）、Linux 601/0/0（4.92s）及 Android 三目标 Rust cfg（45.86s / 31.65s / 31.44s）保留为历史；前批 detector/local 窄修 Android 三目标 Rust cfg 为 aarch64 42.93s / i686 22.24s / x86_64 21.09s；该批同名日志已覆盖首轮，旧时间只作历史会话记录。前批 apply 的 Android 三目标 Rust cfg 均 exit 0：aarch64 70.00s / i686 36.56s / x86_64 37.87s；不执行 Android 测试或原生运行栈验收。`resources:applyUpdate` 已接入既有三参数合同；`resources:updated` 仍无生产者且未新增事件。前批 resources:open/download:engine 的 Windows Rust **552/0/0、18.84s**、Linux Rust **572/0/0、5.35s**、前端 typecheck exit 0 / i18n **14/14** / Vite **526 modules、3.81s** 继续保留；Android 前批三目标 Rust cfg check 均 exit 0，arm64 **42.20s**、i686 **24.87s**、x86_64 **24.31s**。这些 552/572 与旧 Android 日志只代表目录/引擎前批；本轮检测最新桌面回归、Android 窄修 cfg 及首轮历史在第 2.3 节分别记录。各批持久化日志和仅 Lead 会话输出在第 2.3 节分别标注；Task96 最终 Windows 串行全量及本批 typecheck/桥结果只引用 Lead 已收集会话输出，不捏造工作区日志链接。Lite WSL CTest **18/18、62.81s** 与隔离 Secret Service **4/0/0**、Windows QuickPlay 构建/测试 exit 0 也来自 Lead 会话，QuickPlay 无保留统计；Lite 结果不替代本轮 Rust 证据。此前 Linux **564/1** 的隔离设置夹具修正及 565/0/0、01:23 等历史批次继续保留。Android 本轮也仅有 Rust cfg 证据，不等于 Kotlin/Gradle、链接、APK、设备/provider、JVM 或游戏验收。作者仅核读源码/日志并更新两份授权文档，未执行命令、构建或测试，未读取真实秘密/私有配置，未接受 SDK 许可；详细批次和未验项见第 2.3 节。

**前批 Round4 移动日志页增量（2026-11-10 06:42 UTC+08:00，历史）**：公共 openWindow/closeWindow 已接入本地 dialog 宿主，getLogs 继续使用受来源核验的 IPC；该批不增加通道或事件，当时统计为 **140/72、10/23、239 成员**，不是当前 Task95/96 统计。本轮 Windows **657/0/0、32.90s**（编译 2m03s）、Linux **679/0/0、5.86s**（编译 2m26s）及三 Android Rust cfg **38.71s/23.04s/28.32s**见第 2.3 节新日志。控制器 11/0、宿主及联动 23/0、日志组件 16/0、桥 12/0 为 Lead 收集的会话输出，日志未持久化；typecheck、i18n 14/0 与 Vite 528 modules/2.91s 有已核读日志。此前 656/678、526 modules 和 r2 Android 时间仅为上一批历史，不能作本轮证明；真实浏览器、APK/设备、焦点/硬件 Back/viewport、上传与游戏运行仍未验。

## 1. 结论与判定口径

根项目现在同时存在 Electron 基线和正在迁移的 **Tauri v2 + Rust 实现**。Electron 入口仍是 [index](../src/main/index.ts#L10) 与 [preload](../src/preload/index.ts#L49)；Tauri 已有 [配置](../src-tauri/tauri.conf.json#L1)、[Rust 组合根](../src-tauri/src/lib.rs#L124)、[兼容桥](../src/tauri/bridge.ts#L1) 和 [传输层](../src/tauri/transport.ts#L1)，[React 启动入口](../src/renderer/src/main.tsx#L93) 会在挂载前等待桥的 `ready`。旧稿“未发现 src-tauri”的判断已经过期，本快照撤回该判断。当前是部分业务迁入 Rust，不是 Electron 全功能已经替换；Android 原生安全存储与 SAF 插件源码也已写入，但尚无 APK、Android JVM 或真实游戏画面证据。

完整功能范围包括账号、版本/加载器、Java、启动与诊断、资源/整合包/文件管理、设置及所有外观实验、自定义主页、反馈、更新/公告/关于、开发模式、AI/语音、联机/聊天/局域网桥、窗口/托盘/浮层、实验性歌词。根项目仍有 [music API](../src/preload/index.ts#L421) 与 [歌词服务初始化](../src/main/app.ts#L1331)。Lite 删除歌词的要求不自动删除根项目能力。联机语音则已被当前根源码明确移除，见 [src/main/multiplayer/index.ts](../src/main/multiplayer/index.ts#L83)；现有语音业务是 AI 录音、转写与播报，不能把旧注释当作现有联机语音实现。

状态用语：

- **现有源码**：已读到入口、业务实现或平台分支，未因此声称真实环境成功。
- **显式接管/静态可达**：公开白名单中的通道经组合根到达已读分支；含业务实现、参数/模式拒绝或平台 `Err`，不等于验收通过。统一拒绝与平台条件拒绝单列，均不算业务完成；没有真实运行的空态/成功回包也不能冒充能力验收。
- **未接管**：模块返回 `Ok(None)` 后继续分发；所有模块均未接管时组合根返回“尚未完成 Tauri 平台适配”。`None`、明确 `Err`、空数据或固定 `true` 均不能自动计作功能完成。
- **迁移计划/验收要求**：第 9 节保留完整 Electron 契约；各行目标不是完成状态，当前 Rust 覆盖以第 2.1 节为准。
- **平台限制**：当前行为不能原样搬到目标平台，必须替代、改交互或返回明确的不支持；不能用成功占位掩盖。
- **待实测**：源码和框架能力不足以证明，例如真实账号刷新、Forge 安装、Android Java 画面、双机组网、音频、签名更新。

当前落地选择已经是 **React 兼容桥 → Tauri command → Rust 域模块**，未读到已打包运行的 Node 业务 sidecar；第 4 节保留 Node 过渡与 Rust 重写的取舍分析，不把备选架构描述为现状。Android 必须使用 **Rust + Android 原生插件/JNI + 独立游戏运行适配层**，不能复用“启动 Node sidecar，再 `spawn(java)`”作为移动端实现。数据模型和协议可共享，桌面进程与移动游戏运行宿主不同。

## 2. API 基线与桥接契约

[preload](../src/preload/index.ts#L41) 共有 **239 个叶子成员**：212 个 `invoke`、2 个 `send`、23 个事件订阅、2 个本地成员。`homepage.log` 虽返回 `void`，内部仍发 `invoke`；`manage.onModsUpdated` 的泛型含对象，不应被简单正则漏算。`platform` 与 `shell.getPathForFile` 不走 IPC。附录逐项列出这 239 个成员、通道及源码位置，不能只迁移常用页面。

[LauncherApi 与相关 DTO](../src/shared/types.ts) 是协议依据，不直接把 Electron 事件对象或 Node 对象搬进 Tauri。`Uint8Array` 语音、反馈/主页 base64、错误及进度都需要明确编码和体积上限。

计划协议要求：

1. 在受信任 React 顶层注入兼容的 `LauncherApi` 适配器，用 Tauri command/Channel 或事件实现；不向任意 iframe、远程页面公开通用 `invoke(action, args)`、shell 或任意文件能力。
2. Rust 原生宿主保存能力和窗口身份，按调用窗口/来源、方法白名单和 schema 校验；sidecar 不自选权限。特权参数（账号令牌、Java 路径、覆盖目标、更新包身份）由宿主验证，不能仅依赖前端输入。
3. 统一结构化请求 `id/method/params`、结果、取消、进度与错误。sidecar stdout 只承载有上限的帧，日志走 stderr；必须处理碎片、重复 ID、超长帧、退出、背压和协议版本，不允许拼 shell 命令。
4. 保留本次实际快照、按 taskId 的取消、安装去重、错误类型及订阅清理。Tauri `listen` 注册是异步的，适配器必须处理“组件已卸载但订阅才完成”，再调用 unlisten；不能把旧同步清理代码原样替换。
5. `auth/status`、下载、启动、资源更新等事件限定到原始请求窗口；AI 工具确认只投递到用户当前交互窗口，防止主窗与球窗重复批准；大厅查询事件仍按通知后回读快照的语义。现有路由见 [AI 广播](../src/main/app.ts#L1309)、[mini/大厅广播](../src/main/app.ts#L1018)。
6. binary/路径选择、窗口状态与系统权限用不同 DTO。Android 不返回假绝对路径；`platform` 应有显式 `android` 值及能力快照，不能把 Android 伪装成 Linux 触发旧分支。
7. 保留中文/繁中/英文、普通/本地/极简模式和所有既有入口。离线模式的禁止联网须放到服务层，不只隐藏按钮；错误不能返回原始令牌、含密钥 URL、密码或完整启动参数。

### 2.1 当前 Tauri / Rust 实际覆盖（静态可达，不是完成率）

统计以 [212 个调用白名单](../src/tauri/types.ts#L8) 为全集，核对 [组合根](../src-tauri/src/lib.rs#L138) 与 Storage/auth/desktop/loaders/forge/downloads/runtime/catalog/services、[账号导入](../src-tauri/src/account_import.rs#L187)、[Java runtime 安装器](../src-tauri/src/java_runtime.rs#L1)、[桌面导出宿主](../src-tauri/src/desktop_export.rs#L219)、[Android 文件宿主](../src-tauri/src/mobile_files.rs#L63)、[Minecraft 查询](../src-tauri/src/minecraft.rs#L401) 和 [modpack 模块](../src-tauri/src/modpack.rs#L37) 的公开分发及实际调用链，再将互不重复通道求并集。仅内部 helper、测试字符串、`ai:models` 等未在白名单的分支、`Ok(None)` 和最终 fallback 不算接管；Android 与桌面同名导出只计一次。当前统计快照 **2026-11-10T11:50:09+08:00** 在前批 140 条集合上新增桌面窗口模式两条与开发授权六条，净增 8，合计 **148**。组合根仍为 3、debug 仍为 5、catalog 仍为 17；既有 debug:getLogs 从组合根迁入的历史调整不重复加数。四个开发工具通道的统一未实现 `Err` 不纳入这 148 条业务/平台条件接管集合，另列在 64 个余项中。以下 Round4 测试数字只代表当时源码，不背书本批 Task95/96；本批验证进度见第 2.3 节。资源应用 [resources:applyUpdate](../src-tauri/src/resource_updates.rs#L227) 属于前批；前批目录宿主与 [download:engine](../src-tauri/src/downloads.rs#L258)仍保留。前批 Round4 移动日志页的桌面 Rust 测试为 Windows 657/0/0（32.90s）、Linux 679/0/0（5.86s），Android 三目标 Rust cfg 均 exit 0（38.71s / 23.04s / 28.32s）；公共 API 的 dialog 视图不增加 IPC，getLogs 仍为受核验来源的原通道。前批 cfg 拆分的 656/678、Android r2 20.30s / 28.28s / 27.87s 与 task91 16/0 单独保留历史；本轮离线控制器/宿主模型仍非真实浏览器/GUI；资源应用前批的 639/661、Android 70.00s / 36.56s / 37.87s 与更早 detector-only 的 581/603 均单独保留历史；壁纸三通道、外部版本两通道及 servers.dat 一通道仍按前批保留；保留既有 `feedback:open-file`、账号导入、三格式导出、启动前刷新、整合包六分支与 `system:hardware`。桌面 `app:relaunch` 已有 Rust 分发，移动端明确拒绝；前批更新应用路由保留既有三参数与 DTO；本批 debug 仍使用既有白名单，原生 command 与事件契约均不增加。前批静态通道净增四条；本轮已实现移动公共 API 的本地日志页，但静态计数及离线回执测试不能推断真实设备或上传验收通过；各批证据见第 2.3 节。modpack 的六条公开分支（probe/exportInventory/export/download/import/importFromUrl）均有 Rust 分发；普通 `catalog` 资源安装的目标/依赖/进度闭合仍未完成，不把它另计为本批通道；本批导入自身已有有界 plan、远程成员应用与 overrides/materialize 链。导入测试主要使用合成来源替身或受控缓存，真实外网 URL→Claim→Input 全链仍未验。测试结果只证明对应 Rust 测试/编译范围，不能将静态分支数换算为功能完成率。原生 command 入口仍只有 `launcher_call` / `launcher_send`，未扩大 TS 白名单。`loaders:installInPlace` 参数扩展、`shell:saveFile` 保存能力及既有桌面/Android `mods:downloadTo` 不重复增加通道数。第 2.3 节列本批验证边界。

| 类别 | 源码统计 | 不能据此推导的结论 |
| --- | --- | --- |
| invoke（桌面 cfg） | **212** 个中 **148** 个显式接管：**147** 个含业务或条件分支、**1** 个 GPU 启动策略查询统一返回 `Err`；另 **64** 个余项（4 Tools 明确未实现 Err +60 未接业务处理） | 147 不是已完成数；本批窗口模式净增 2、开发授权净增 6，debug 不重复加数；受限窗口、上传源码与离线夹具不等于真实 GUI/HTTP 或完整游戏日志迁移 |
| invoke（含 Android cfg 的并集） | 同为 **148** 个显式接管 / **64** 个余项（4 Tools 明确 Err +60 未接业务处理）；壁纸走 SAF 单文件授权，外部版本扫描/导入明确拒绝无目录树授权的移动平台；servers.dat 使用内部实例根；`manage:openDir` 与 `resources:open` 在移动端明确拒绝 | 148 不是 Android 可用数；新增桌面模式与安全全屏在移动平台仍明确拒绝。移动公共 API 已走应用内 dialog 宿主并等待真实挂载/关闭回执，裸 `debug:open` IPC 仍拒绝；该 JS 视图替代不增加 Rust 接管数。三目标仅 Rust cfg 检查，未运行 Android 测试、Kotlin/Gradle、native link、APK 或设备验收。`shell:saveFile` 已包含在 desktop 27，Java/启动和多个桌面操作仍拒绝 |
| send | **2** 个中 **1** 个处理日志摘要，**1** 个 HUD 交互明确拒绝 | 日志正文被丢弃，不等于旧日志/上传完整迁移 |
| event | **23** 个订阅契约中 **11** 个读到 Rust 生产者，另 **12** 个未读到；本批新增既有 `devmode:changed` 的生产者，`resources:update-checked` 按前批保留，`resources:updated` 仍缺；整合包继续共用 `modpack:progress` 与 `download:progress`，没有新增事件契约 | 生产者或 envelope 源码存在不证明真实 UI/公网链路消费；检测及最新读取修补的桌面本地测试已执行，真实 UI 消费仍未验。下载与导入 reporter 按 `launcher:event` + `{channel,payload}` 投递，真实安装器、取消和多窗生命周期仍未验 |
| local | **2** 个兼容成员已有前端逻辑：显式平台检测与拖放路径提示 | `getPathForFile` 提示不是文件授权；本地导入使用 picker/SAF 授权，通用主窗文件管理另有绝对路径校验 |

以下 **148** 个 invoke 分组互不重复，桌面与 Android cfg 的显式接管并集相同；账号导入、modpack 下载/导入/导出及其他各项的平台限制仍须逐项判断，这不是功能通过清单：

| Rust 模块 / 数量 | 当前可达通道 | 已读实现与主要缺口 |
| --- | --- | --- |
| [组合根](../src-tauri/src/lib.rs#L219) **3** | `app:version`、`app:hardwareAccelerationBooted`、`app:relaunch` | 版本来自包信息；GPU 启动策略查询明确 `Err`，不再用常量 `true`。桌面重启通过全局 IPC 门禁及各域空闲检查后才 `request_restart()`，移动端明确拒绝；未实测 GUI 重启。Electron 原 GPU 方法返回已应用策略，也不是 GPU 探针，保存设置不能证明 WebView 已应用 |
| [Storage](../src-tauri/src/storage.rs#L103) **14** | `settings:get/set`；`accounts:list/selected/select/remove/addOffline`；`versionDirs:list/add/update/remove/select`；`ai:clearKey`、`translate:clearKey` | 设置白名单、账号展示 DTO、目录规范化、受保护凭据引用；删除账号先经 auth 清理。不等于旧 Electron 全量配置/加密 blob 兼容迁移或所有设置副作用已接线 |
| [auth](../src-tauri/src/auth.rs#L872) **7** | `auth:begin/cancel/refresh`；`accounts:addYggdrasil/addYggdrasilProfiles/refreshSiteNames`；`yggdrasil:skin` | Microsoft 设备码/取消/刷新、Yggdrasil 多角色与站点 URL 校验、后台秘密；另有内部导入验证，不重复增加公开通道。删除账号先失效导入再写 Storage，避免迟到导入复活；未真实外网登录/刷新 |
| [account_import](../src-tauri/src/account_import.rs#L187) **3** | `accounts:importPreview/importCommit/importCancel` | PCL2/HMCL/官方来源、picker/SAF 授权读取、四字段预览、600 秒会话、提交前验证及 Storage insert-only。未知保护封装保持 protected/需重登录；临时 access 与来源 OAuth 刷新参数分别处理。取消、真实保存与未知 panic 边界见下文；不能据本地夹具宣称真实账号可移植 |
| [desktop](../src-tauri/src/desktop.rs#L571) **27** | `window:minimize/maximize/close/isMaximized/setFullscreen/setAlwaysOnTop/setDesktopMode/securityFullscreen`；桌面模式与安全全屏共用窗口实例代次、短时生命周期登记和保守失败状态；`display:primary`、`system:memory/hardware`；`shell:openExternal/openPath/chooseDirectory/pickFile/pickFiles/saveFile`；`files:places/list/open/reveal/rename/createFile/remove/readText/writeText`；`java:pick` | 桌面窗口、选择器、文件/文本操作；可信主窗的通用文件管理允许经路径/链接等校验的绝对路径，不是所有调用都受 picker 根限制。本地资源导入才消费 picker/SAF 身份授权。移动明确拒绝项另表列出 |
| [loaders](../src-tauri/src/loaders.rs#L231) **3** | `loaders:versions/install/installInPlace` | Fabric/Quilt 官方 profile 校验、共享目录锁、依赖安装、就地合并、一次原版 JSON 备份及 natives 恢复已接；`installInPlace(kind=forge/neoforge, …)` 现在先委派 Forge 编排，不重复算通道。`loaders:versions/install` 的 Forge 参数仍不是独立 `forge:*` 的替身。仅本地夹具，不宣称真实安装/启动通过 |
| [forge](../src-tauri/src/forge.rs#L164) **2** | `forge:versions/install` | Maven 清单/安装分发、Java、官方 JAR 摘要、独占 staging、profile/MC/版本绑定、事务发布及等待原版后取锁；接管上述 Forge/NeoForge 就地参数。现代 NeoForge 不再要求 runtime profile 自身库，改为安装 metadata/嵌入与输出 profile/启动参数联合绑定，并复核提升固定四项运行产物；见下文。Android/iOS 与 local 安装仍拒绝。新增人工固定源码形状夹具已通过，不是实际 21.1.190 JAR 验收 |
| [downloads](../src-tauri/src/downloads.rs#L191) **4** | `download:install/cancel`、`download:engine`、`versions:createVanilla` | `download:engine` 在 Storage/settings/game_dir 前受 trusted main、参数校验和 Gate 保护，返回 `available:false`、`path:null`、`backend:"tauri-rust"` 与编译目标平台/架构，`available:false/path:null` 仅表示未加载 Electron 的可选 `.node` 模块；`backend:"tauri-rust"` 标识内置 Rust 后端，状态响应本身不测量真实下载或网络健康；其余为原版清单/继承依赖、哈希/缓存、去重取消、共享锁与可信 dirId。组合根取消入口现已前置到 Storage 等待、通用 settings/keys 读取及实例根解析之前，并按 cfg 转发桌面/SAF 导出取消；桌面导出已缓存授权时的语言、取消只查内存状态，移动端同类取消入口也已改为使用已登记任务的缓存语言；尚未进行存储锁故障注入，不能据外层顺序声称整个调用链已验证。本批 Windows/Linux Rust 回归和 Android 三目标 Rust cfg 检查通过，但真实存储/密钥库故障注入仍未执行；已进入提交则明确报错而非伪报撤销。运行时安装有独立 `java:install` 分支；取消仍复用 `download:cancel`，不增加事件契约。Android 跳过桌面 natives，同名 `createVanilla` no-op 也不证明可启动 |
| [Java runtime installer](../src-tauri/src/java_runtime.rs#L62) **1** | `java:install`（既有白名单通道） | 桌面仅支持 Windows/macOS/Linux x64/aarch64，安装 major 8–99；固定 Adoptium metadata/release 来源、SHA-256/大小复核、最多 2 GiB 归档、独占 staging、安全 ZIP/TAR.gz 提取、目标 OS/CPU 与 JVM 核心库检查，再做无覆盖发布、二次探测和 Storage CAS。拥有任务取消、同根锁、窗口关闭收尾及 runtime 探测缓存失效。Android/iOS 在登记任务、联网和建目录前明确 `Err`；本地模式只读验证过的缓存、不联网。主线程未获证据的真实 JRE 下载/执行与游戏启动仍未验 |
| [runtime](../src-tauri/src/runtime.rs#L628) **8** | `versions:list/get`；`installed:list/listAll`；`java:detect/check`；`launch:start/stop` | 启动固定初始账号 UUID，先由 [auth::account_for_launch](../src-tauri/src/auth.rs#L908) 在游戏根锁前检查并按来源策略刷新；临期 Microsoft 仅用保存的 source client/endpoint/scope 完整链，Yggdrasil 按同 server/access/client 组刷新一次并重建全部实际角色。刷新 CAS 核对原账号及 Ygg 角色集；账号快照在持 Storage 锁下与固定进程派发线性化。逐次 LaunchRequest generation、owned worker、stop waiter RAII 防止旧 start 越过 stop；关闭只 signal，不等待认证/存储/游戏退出。缺依赖仍须先安装；Android Java 检测/检查/启动拒绝，空态 stop 成功不代表游戏支持 |
| [catalog](../src-tauri/src/catalog.rs#L1347) **17** | `mods:search/project/versions/install/installFabricApi`；`resources:list/remove`；`manage:mods/schematics/toggleMod/deleteMod/installLocalMod/installLocalResource/deleteWorld/deleteFile/renameVersion/deleteVersion` | 在线安装/Fabric API 的官方元数据、文件名/哈希/大小、禁止覆盖、local/metadata-only 与共享锁校验已写；普通 `mods:install` 已接入受控任务级进度/取消注册、JobGuard 与真实写入收尾；仍未绑定完整目标 MC/loader/必需依赖。Fabric API 按传入 MC/Fabric 筛选。[官方导出绑定](../src-tauri/src/catalog.rs#L545) / [流式写入](../src-tauri/src/catalog.rs#L642) 已由桌面与 Android 宿主共用，不额外计作此模块的公开通道；不能以另存闭环补称普通安装已有兼容/取消闭环。资源更新检测与应用独立归入下列 resource_updates，不增加 catalog 的 17 条；modpack 另有下列探测、清单、导出、下载与导入六条分支 |
| [services](../src-tauri/src/services.rs#L948) **29** | `about:list/agreement/agreementStatus`；`ai:setKey`、`translate:setKey`；`update:check/download/downloadAndRun`；`announcement:list`、`limits:get`；`feedback:send-code/login/session/list/detail/submit/message/withdraw/logout/open-file`；`ai:test/chat/analyzeError/cancel/reset/tools/decideTool/transcribe`；`translate:texts` | PHP/反馈、五聊天协议、翻译、协议指纹与 Tauri 下载；AI 严格 schema 的 13 工具审批/执行和新 OpenAI/custom 转写均有源码；真实外网/音频/UI 未验。球/HUD 未接。反馈附件已按会话绑定的编码 URL 交给系统浏览器，未实测浏览器/Android Intent 或线上下载；更新交接不等于签名更新或安装完成 |
| [平台导出宿主](../src-tauri/src/lib.rs#L193) **1** | `mods:downloadTo`（桌面 / Android 同名） | 在实例根解析前消费当前主窗一次性保存能力：桌面 [desktop_export](../src-tauri/src/desktop_export.rs#L219) 使用 `hcmcl-desktop-save:UUID`，Android [mobile_files](../src-tauri/src/mobile_files.rs#L504) 使用 `hcmcl-save:UUID`；两者经官方 metadata/原始文件名/hash/大小绑定再写入并提交。不是任意 URL/路径写入；桌面只发布新文件且绝不覆盖已有目标。`shell:saveFile` 两平台实现仍只占 desktop 27 中已有一项 |
| [Minecraft 查询](../src-tauri/src/minecraft.rs#L401) **2** | `minecraft:userinfo/serverstatus` | 固定 UAPIS HTTPS/no-redirect 与本地模式拒绝；userinfo 校验 UUID，serverstatus 可在 UAPIS 无 MOTD 时回退有界 Java SLP。源码可达，不代表公网服务已验；不实现 Android Java Edition 运行 |
| [modpack](../src-tauri/src/modpack.rs#L37) **6** | `modpack:probe/exportInventory/export/download/import/importFromUrl` | probe 接受 picker 授权文件或本进程下载能力，并在读取后重验；[inventory](../src-tauri/src/modpack/inventory.rs#L80) 只读枚举且不含 shaderpacks。export 三格式、源只读/句柄重验、classic ZIP 预算及无覆盖发布，导出自动包含 shaderpacks，输出在游戏根 modpacks 内。download 经公网/DNS 固定与受控暂存后返回 opaque 归档能力；import/importFromUrl 复用单一 owned supervisor，把 picker 或 URL Claim 变为受控 Input，再构建隔离实例并无覆盖发布。它们都不是 SAF 保存或真实游戏安装/启动证明 |
| [wallpaper](../src-tauri/src/wallpaper.rs#L284) **3** | `settings:pickWallpaper/clearWallpaper/wallpaperData` | Storage 初始化后、通用设置/密钥和实例根解析前分发；桌面 picker / Android SAF 单文件授权，受控图片规范化、应用私有托管副本、设置 CAS、仅清理自有旧文件及 data URL。owned blocking worker 持 Gate 至真实收尾，未知清理保持限制；不等于完整外观副作用或 Android picker/provider 实测 |
| [external_versions](../src-tauri/src/external_versions.rs#L498) **2** | `versions:scanExternal/importExternal` | 桌面消费主动选择的目录身份，检查来源/目标分离、版本继承/root JAR 与关联库，按冲突策略在独立 staging 发布；独立 supervisor 持来源/root/job/Gate 至收尾，取消不撤销已提交版本。Android/iOS 在模块入口明确拒绝无 SAF tree 授权，单文件授权不能代替目录树 |
| [instance_servers](../src-tauri/src/instance_servers.rs#L356) **1** | `installed:addServer` | 有界解析现有 servers.dat/NBT 后追加 name/address，保留非目标原始 NBT 字节，根锁内重读隔离设置，按平台句柄进行原子新建/替换。owned worker 保持 Gate/root 至 writer 与清理结束，未知状态 sticky；不保证同权限外部进程 inode CAS、崩溃持久性或真实游戏读写 |
| [manage_open_dir](../src-tauri/src/manage_open_dir.rs#L333) **2** | `manage:openDir`、`resources:open` | 严格接受两个字符串参数；`manage:openDir` 仅允许 `mods/saves/shaderpacks/schematics/version/run`，`resources:open` 仅允许 `resourcepacks/shaderpacks`；在同一游戏目录锁与 Storage 设置锁内复核登记根目录和实例隔离状态，用句柄锚定创建/检查目标后返回验证过的路径字符串。它不调用系统文件管理器；Android/iOS 明确返回不支持，移动端不提供该桌面目录访问能力。取消、锁忙、根/设置变化和未知收尾均返回固定三语错误并保守保持生命周期占用；本地夹具不等于真实文件管理器或外部并发验收 |
| [resource_updates](../src-tauri/src/resource_updates.rs#L226) **2** | `resources:checkUpdates` / `resources:applyUpdate` | `checkUpdates` 严格接受一个 versionId；`applyUpdate` 保留原有三参数与严格 DTO。local/metadataOnly 下检测返回空数组、应用拒绝写入。普通检测模式在设置快照后解析实例根，检查 mods/resourcepacks/shaderpacks 并经受控 Modrinth/CurseForge 元数据检测，保留有界并发、取消、240 秒截止与上下文复核；owned worker 持 ScanGuard/Gate 至真实收尾，重启和窗口关闭已有挂钩。`resources:update-checked` 使用既有 launcher:event envelope；应用保留既有三参数合同（versionId、UpdateInfo、enabled），重扫并绑定当前实例/清单，以 Modrinth required 同类型依赖生成计划，官方元数据重绑并核验哈希，跨类型依赖明确拒绝。额外 Install/Enable/Replace 动作须对完整计划取得[主窗原生确认](../src-tauri/src/resource_updates/approval.rs#L211)，票据绑定计划摘要，须在 180 秒单调时限内单次消费；移动端额外依赖动作明确拒绝。[应用 owned worker](../src-tauri/src/resource_updates/apply.rs#L195) 持 Gate/root/job 至真实清理；[有界 WAL 恢复](../src-tauri/src/resource_updates/transaction.rs#L420)仅处理有身份凭据的现场，未知收尾保留锁；不承诺任意断电恢复、同UID外部inode CAS或多文件原子提交。Windows/Linux 全量本地Rust测试与Android三目标Rust cfg见2.3；真实公网和GUI未验。应用进度复用 `download:progress`，`resources:updated` 无生产者 |
| [debug](../src-tauri/src/debug.rs#L147) **5** | `debug:getLogs/open/close/isEnabled/submit` | getLogs 从组合根迁入；固定 debug 窗来源仍受限，cfg(mobile) 额外允许受信任 main 读取。其他原生方法和 rendererLog 仍限主窗。桌面走原生窗口，移动公共 openWindow/closeWindow 走当前桥实例的本地 HTML dialog 宿主并等待回执，裸移动 open IPC 仍明确 Err；不增加接管通道。isEnabled 只是保存的 debugMode，不是窗口或上传许可。缓冲/固定目的地上传已有源码，通用游戏日志 sink、真实 GUI/HTTP 和设备行为仍未验 |
| [devmode](../src-tauri/src/devmode.rs#L321) **6** | `devmode:status/sendCode/verify/setEnabled/revoke/setSecurityMode` | [严格参数分发](../src-tauri/src/devmode.rs#L162)与[组合根专用路由](../src-tauri/src/lib.rs#L248)已接入；仅读取[开发授权快照](../src-tauri/src/storage.rs#L431)，不经通用 API 密钥或游戏目录。固定官方 HTTPS、无 product 参数、禁代理/重定向/自动重试；真实 token 仅内部，前端和 main 窗事件只收脱敏状态。关闭开关只承接本进程已验证且未失效的 grant，enabled=false 时 effectiveSecurityMode=full，不从磁盘快照建立信任。epoch/Permit 与[Storage CAS](../src-tauri/src/storage.rs#L437)阻止迟到提交；mode 保存与失效在同一 blocking 任务内执行，丢弃 caller 不跳过失效。owned worker 至真实持久化收尾；四个 Tools 通道仍明确 Err。局部 helper/模拟提交测试不等于完整 Tauri/Storage/HTTP E2E，真实 PHP/账号/设备网络未验 |

`a/b` 仅缩写同一前缀下的显式通道。本批桌面与跨 cfg 并集求和均为 **3 + 14 + 7 + 3 + 27 + 4 + 2 + 3 + 1 + 8 + 17 + 29 + 1 + 2 + 6 + 3 + 2 + 1 + 2 + 2 + 5 + 6 = 148**；排除 GPU 统一 `Err` 后为 **147 个含业务或平台条件分支**，不是完成数，也不是 Android 可用数。[账号导入](../src-tauri/src/lib.rs#L158) 在通用设置/密钥及 game dir 快照之前接管，秘密只留 Rust 会话；auth 的 `accounts:remove` 前置清理与 Storage 同名分支不重复计数。`java:install` 在 game dir 解析前为 Android/iOS 分发明确拒绝；`minecraft:userinfo/serverstatus` 和 `modpack:probe/download` 也不依赖实例根，`exportInventory/export` 则在解析后使用该根。`ai:models` 有 [内部 services 分支](../src-tauri/src/services.rs#L421)，但不在 TS / 生成的 Rust 白名单，公开桥不可达，不计入。

桌面与跨 cfg 并集的 **64** 个余项分组数量均为：app **0**、debug **0**、accounts **0**、versions **0**、installed **0**、resources **0**、download **0**、mods **1**、java **0**、manage **0**、settings **0**、system **0**、homepage **18**、feedback **0**、devmode **4**、modpack **0**、ai **7**、minecraft **0**、window **0**、mp **32**、music **2**。其中 `devmode:openTools/closeTools/openDevTools/closeDevTools` 四项已由组合根明确返回未实现 `Err`，其余 60 项未接业务处理；不能把这 64 项统称为全部最终 fallback，前置门禁或设置处理也可能先拒绝。明确平台 `Err` 另按限制表说明。modpack 六条公开分支 **`modpack:probe/exportInventory/export/download/import/importFromUrl`** 均已进入 Rust 分发；`manage:openDir` 与 `resources:open` 已进入 Rust 分发，`download:engine` 返回内置 Rust 后端的兼容状态，`available:false` 仅沿用 Electron 可选 `.node` 未加载的语义；主页 18 与联机 32 仍整组缺口；开发授权六通道已有业务分发，开发工具四通道仍明确不支持。账号导入三条已接，不代表 Electron 全配置/加密 blob 兼容迁移完成；`resources:checkUpdates/applyUpdate` 均有 Rust 分发；apply 保留原三参数合同、同类型依赖计划、官方元数据重绑与哈希验证、主窗审批及有界事务恢复路径；真实公网/GUI仍未验。第 9 节保留全部 239 项原 Electron 契约。Forge/NeoForge 已有分发与编排，现代 NeoForge 已改为联合绑定，但真实发布 JAR 与安装→启动验收仍开放。

**Task95/96 的实现边界与最终证据。** [桌面窗口模式状态机](../src-tauri/src/desktop_window_modes.rs#L263)承接既有 desktop/security 两通道，desktop 由 25 计为 27；移动端仍明确拒绝，不能据静态接管宣称 Android 桌面模式可用。开发授权的[进程内已验证 grant 保留](../src-tauri/src/devmode.rs#L84)只用于关闭开关后的有效授权，不把已保存 token 当作已验证授权；关闭后 [effectiveSecurityMode](../src-tauri/src/devmode.rs#L107) 必为 full。[专用提交](../src-tauri/src/devmode.rs#L225)等待真实 blocking 工作返回；[mode 提交与失效](../src-tauri/src/lib.rs#L192)留在同一 blocking 任务，caller 丢弃后也执行，不依赖 IPC 续体。后台 epoch/Permit、完整授权快照 CAS、只投 main 的脱敏事件、关闭/到期失效与只读重启忙碌检查均有源码。四个 Tools 仅统一未实现 Err，不能计入 147 个业务/条件分支。固定官方 HTTPS 客户端不携 product，不自动重试；没有真实 PHP/账号/设备网络或 worker 全流程 E2E 证据。冻结来源为 devmode.rs 492 行 `3aeebb0e8536c09ba38fb91cf630c51e5ce554ab9c18602be3e4b67926ff5470`、lib.rs 508 行 `573ea256f22cf5752445c080cb02e4f7071ab0f4cc34a9761cbeb3545c9b5496`、storage.rs `f38f4ae42efd1ce8719bc5bb59bbb03dff9b35dab418d58ceda22cf725e66a98`；这些摘要是源码身份，不替代测试。最终 Windows 串行全量、Linux clean 全量与三个逐 target package clean Android Rust cfg 均已收集；证据来源、历史失败与真实环境边界见第 2.3 节。

**Round4 已接入移动应用内日志页；通用游戏日志采集与真实 GUI/HTTP 验收仍开放。** [组合根权限门](../src-tauri/src/lib.rs#L196)对 debug:getLogs 调用 [Rust 来源核验](../src-tauri/src/debug.rs#L73)：桌面 debug 固定本地页面及唯一 window=debug 查询保持原校验；只有 Rust cfg(mobile) 才额外允许受信任 main 来源读取，页面平台参数不能授予该权限。其他原生业务与发送仍要求受信任主窗，[日志窗 capability](../src-tauri/capabilities/debug.json#L5)仍仅事件 listen/unlisten。[桌面窗口](../src-tauri/src/debug.rs#L116)关联 main 并限制导航/新窗；[裸移动 open IPC](../src-tauri/src/debug.rs#L141)明确返回 Err。移动公共 [openWindow/closeWindow](../src/tauri/bridge.ts#L28)则在 ready 后调用本 API 实例 WeakMap 中的本地控制器，使用 [TauriMobileDebugHost](../src/renderer/src/components/TauriMobileDebugHost.tsx#L36) 的 HTML dialog 与嵌入日志组件，等 showModal/关闭提交回执才完成 Promise。仅 [Tauri 移动入口](../src/renderer/src/main.tsx#L85)挂载该宿主；[控制器](../src/tauri/mobile-debug.ts#L48)对未挂载、失败、15 秒超时明确拒绝并请求撤页，忽略迟到回执，卸载/dispose 不复活旧页面。宿主关闭异常不保证立即撤页；返回/Escape、焦点恢复、安全区与 viewport 仅有源码和离线模型，不等于设备/APK/硬件 Back/真实浏览器验收。isEnabled 仍只查询 debugMode，不能代替上传同意。

[内存缓冲](../src-tauri/src/debug/buffer.rs#L8)最多 2000 条/8 MiB，完整序列化单条最多 8000 字节、来源最多 128 字节；诊断快照取最新连续后缀，最多 800 条/400 KiB。已知秘密及常见命名结构、URL/auth/JWT/opaque 等模式在入账或诊断投影时处理，**不保证识别任意未标注秘密**。[rendererLog](../src-tauri/src/debug.rs#L48)不存正文，只记级别、最多 32768 字节的长度摘要和会话累计数。当前生产入账仅 renderer 摘要；没有接入通用 Rust 游戏/安装器 stdout/stderr sink，既有 launch/Forge 事件不能据此改称完整调试日志采集。

[主动上传](../src-tauri/src/debug/upload.rs#L250)仅主窗，严格一个 8–128 位十六进制 key；normal/minimal 且 feedbackLogConsent=true，多次读取设置复核同意与模式。Storage 没有单调设置纪元，不能探知中间撤回后又同意。[白名单诊断 DTO](../src-tauri/src/debug/upload.rs#L168)不带账户、完整设置或私有游戏路径；日志最多 400 KiB、完整请求 512 KiB、响应 64 KiB。[固定 HTTPS 客户端](../src-tauri/src/debug/upload.rs#L186)禁代理、重定向和自动重试，连接 10 秒/总请求 60 秒，只接受 ok=true 及安全整数 remaining，错误不回显原 HTTP/密钥。[owned worker](../src-tauri/src/debug/upload.rs#L250)持独立 slot/Gate 至阻塞读取真实结束；IPC drop、取消和关闭只 signal，未知 panic 保留 sticky。取消/超时可能已被服务端接收，不能撤销上传或假定额度未消耗。**本批只有源码协议核对和离线 fixtures，没有本地 PHP server/POST 或 HTTP E2E；真实 GUI 与上传未验。**

**只读硬件快照已接，启发式字段不是设备认证或设置策略。** [desktop 分发](../src-tauri/src/desktop.rs#L475) 接管既有 `system:hardware`，仅主窗、无参数，在 blocking worker 中调用 [hardware_info](../src-tauri/src/desktop_hardware.rs#L58)。结果严格保留 **`cpuCores/cpuModel/cpuYear/isVirtualMachine/totalMemMb` 五字段**：逻辑处理器数和物理总内存必须为有效正值，内存按 MiB 四舍五入；型号不可读或无效时为空串，无法识别的发布年份为 **0**。年份仅沿用型号启发式，**不是实测生产年份**；虚拟化布尔值仅匹配 17 个大小写不敏感的 CPU 型号 marker，`false` 不证明物理机，`true` 也不是虚拟化认证。该只读接口不自动改运行模式或设置，更不代表 GPU 启动策略查询已实现。Windows 使用固定系统 API 与只读注册表，Linux/Android 使用有界 sysfs/proc 读取；ARM 板名/ABI/implementer 不冒充 CPU 型号。Windows 与 Linux 在前述 claim/hardware 历史批次均实际通过 [宿主采样测试](../src-tauri/src/desktop_hardware.rs#L347)；macOS 只有源码/解码夹具，Android 只有 ARM64 Rust cfg 检查，二者均无本批原生宿主/设备验证。

**账号导入的实际边界。** [会话预览](../src-tauri/src/account_import/session.rs#L91) 每条只返回 **`key/name/type/status` 四字段**，不回 UUID、access/refresh/client token 或源路径；会话另有随机 ID 和 `protected/unsupported/invalid` 警告，最多 500 条、600 秒 TTL，绑定 main 窗口与单槽。`ready/temporary/refresh` 可提交，`relogin/duplicate` 跳过；`temporary` 表示只有当前未过期 access，不能承诺长期刷新。[文件入口](../src-tauri/src/account_import/files.rs#L16) 对 picker 授权、链接/reparse/hardlink 和句柄身份/大小/时间前后重验，支持受控 UTF-8/BOM、UTF-16；**每文件 8 MiB、最多 8 文件/合计 32 MiB**。Android 会先经过共用 SAF 的最多 64 文件/2 GiB 批次复制到私有缓存，再执行账号模块这些更小限制，不能声称 provider 流在 8 MiB 前就已停止。Windows 注册表只读固定 HKCU PCL/PCL2/PCLDebug 字段；其他平台拒绝此来源，不借 shell 扫描。

[解析器](../src-tauri/src/account_import/parser.rs#L95) 只接受来源明确的 Microsoft OAuth client ID、scope 和 consumers/live 端点，不猜本启动器参数；有效 access 无可信 refresh 时仅作 temporary，过期且缺来源刷新参数则需重登录。HMCL 明文或 `hmcl-obfuscated-v1` 认证封装有解析；PCL 只解明确明文/已知 Identify 的 wrapping，**未知生产 Identify 不猜密钥、不解密**，固定 Debug Identify 也不代表生产可解；官方受保护封装同样不承诺解密。[auth 内部验证](../src-tauri/src/auth.rs#L624) 对有效 Microsoft access 核对精确 profile UUID，过期项才用来源 OAuth 参数刷新并走认证链；Yggdrasil 按服务器/access/client 组合分组刷新一次，再按返回角色重建，不接受未知角色。真实来源令牌可能已轮换，取消不能撤销该远端副作用。

[提交 worker](../src-tauri/src/account_import.rs#L114) 在刷新前再查已有 UUID，验证成功后调用 [Storage insert-only](../src-tauri/src/storage.rs#L232)：同锁重查并跳过并发出现的 UUID，不覆盖现有账号、不改变原选择，持久化成功才更新内存。IPC 丢弃仅发取消；会话 TTL、窗口关闭和取消不提前释放真实凭据/磁盘保存，保存 join 不放入 `select`。删除账号先失效导入并取得提交门，防迟到复活。未知 panic/保存结果不确定会保留 busy，提示**重启后核对已保存账号**，不是宣称取消已回滚或立即可重试。本地 crypto 向量/会话屏障不证明真实 PCL/HMCL/官方账号或源令牌可移植。

**整合包受控下载已接，下载不等于安装。** [入口/模式门](../src-tauri/src/modpack.rs#L28) 在任务登记、建缓存、DNS 与 HTTP 之前拒绝 local 模式；[组合根](../src-tauri/src/lib.rs#L201) 在实例根解析前接管 `modpack:download/probe`，坏 gameDir 不阻断该缓存链路。[网络层](../src-tauri/src/modpack/network.rs#L112) 只允许 HTTPS 标准 443 端口，拒绝凭据、fragment、控制字符及非公网目标；禁代理、禁自动重定向，每跳重新解析并验证全部 DNS 答案后将连接固定到已验证地址，最多 5 次重定向。总时限 180 秒、DNS/连接各 10 秒、分片读取 20 秒，单归档最多 2 GiB；文件写入/flush/sync 则等待真实收尾，不能据 HTTP 时限承诺磁盘 IO 在限时内结束。流中 SHA-256 与落盘后的全字节重算用来核对本地传输/缓存一致性，**不是官方来源摘要、签名或可信整合包证明**；公网 HTTPS 下载仍未实测。

[缓存 Stage](../src-tauri/src/modpack/download_store.rs#L115) 从宿主 app_cache_dir 建立私有目录/独占 owner 与 payload，持祖先/目录/文件身份，Unix 目录 0700、文件 0600；不接受渲染层路径。成功仅返回 **`hcmcl-pack-download:UUID`**，不泄露缓存路径；[注册表](../src-tauri/src/modpack/download.rs#L38) 至多 8 个能力、缓存合计 4 GiB、TTL 600 秒，清理中的票据与字节仍计预算，登记新下载还预留单包 2 GiB。`probe` 识别该能力后读取封存归档，读取结束再次核验 **closed/poisoned、TTL、同一 Arc 指针与取消状态**，不能因开始读取时有效就迟到返回成功；这不授予安装或任意路径读取能力。

[owned 下载 worker](../src-tauri/src/modpack/download.rs#L163) 保持 JobGuard、busy 和 Stage 到写入、flush/sync、File 真正关闭及显式清理完成；IPC 丢弃/取消/关闭只发信号，不提前释放文件或 busy，已经发布能力后取消不假称撤销。失败清理或 panic 结果未知会粘滞保留 poisoned/busy，后续 probe/下载失败关闭；进程崩溃遗留缓存**不自动扫描删除**。下载使用已有 `modpack:progress` / `download:progress` 名称，不新增订阅；当前 [下载 reporter](../src-tauri/src/modpack/download.rs#L271) 与导入 reporter 均发送 `launcher:event`，负载为 `{channel,payload}`，由[兼容桥](../src/tauri/transport.ts#L73)按既有格式消费。Windows/Linux 均有 `progress_uses_the_native_envelope_consumed_by_the_existing_bridge` 测试，但测试通过不等于真实 Tauri UI、公网下载或安装已验。opaque 能力可供探测/作为导入来源，不代表已安装或可启动。

**整合包导出与导入编排已接，但完整安装/启动与 SAF/provider 交接仍未闭合。** [Options/规划](../src-tauri/src/modpack/export.rs#L17) 严格校验十字段选项，支持 **`modrinth/mcbbs/native`**，输出为选定游戏根 `modpacks/<实例>.mrpack` 或 `.zip`，不调用 SAF 保存选择器。配置/服务器/模组/世界/resourcepacks/JEI/TACZ/禁用模组/蓝图按选项读取，shaderpacks 自动加入；只读 inventory 本身仍不列 shaderpacks。源元数据继承最多 32 层、单 JSON 4 MiB/合计 16 MiB；源规划每文件 2 GiB、合计 16 GiB、最多 10 万遍历条目/深度 64。Modrinth 清单使用本地 overrides、`files` 为空，识别到 loader 时其版本写为 `*`，不宣称精确版本锁定或官方远程文件引用。

[写入器](../src-tauri/src/modpack/export.rs#L100) 受同一 [reader](../src-tauri/src/modpack/parser.rs#L7) 的保守预算约束：**classic ZIP 不超过 2 GiB、最多 50000 文件条目、中央目录 16 MiB**，不支持 ZIP64；写完再走 probe 的 manifest 4 MiB、总展开 16 GiB、压缩比 1000 等校验。超预算就拒绝，不截掉用户内容后宣称成功。[access](../src-tauri/src/modpack/access.rs#L152) 保持祖先/源句柄：普通文件仍比较完整 Stamp（身份、大小、mtime/ctime）；目录 Node 仅核目录类型/身份，不把本任务增删成员引起的大小/时间变化误判为换绑。[导出计划](../src-tauri/src/modpack/export.rs#L95) 独立重读并比较 names/原先缺失项，成员变化和文件变化仍中止，未弱化普通文件校验。[output](../src-tauri/src/modpack/output.rs#L15) 使用独占 staging 和句柄化 no-replace 发布，已有或并发出现的目标始终保留；仅清理本任务拥有的临时对象，不删除未知孩子。

[owned 导出 worker](../src-tauri/src/modpack/export.rs#L114) 使用 64 KiB 缓冲/约 100ms 进度，持有 JobGuard、同根锁和 busy 至真实写入、flush/sync、File 关闭及清理收尾；IPC 丢弃只 signal，不 abort 持有文件的任务。取消与发布 gate 串行，发布开始后不保证撤销；已发布文件不伪删除。未知 cleanup/panic 会粘滞保留 busy，需重启检查暂存/目标，不能假装取消成功后安全重试。`download:cancel` 已转发此任务；真实多平台文件系统、picker/provider、公网包和完整导入→导出→启动仍未验。

**整合包导入六分支中的两个新增入口已接入，但这是受限导入编排而非产品验收。** [modpack 分发](../src-tauri/src/modpack.rs#L73) 对 `modpack:import`（已有 picker 授权文件或已 claim 的 opaque 归档能力）和 `modpack:importFromUrl`（严格 HTTPS 来源/文件名）都复用 [owned supervisor](../src-tauri/src/modpack/import.rs#L202)。URL 入口直接调用内部 `download::claim_from_url`，不先调用公开 `modpack:download/start`；来源随后包装为受控 `Input`，不是把路径或 cache path 交给渲染层。`start_with_opener` 的合成 opener 测试替换来源打开并复用真实台账/编排，但不能证明真实 URL→Claim→Input 的公网全链。

导入 supervisor 持有来源、实例根锚点、JobGuard、根锁、远程成员会话和 [isolated Stage](../src-tauri/src/modpack/install_stage.rs#L142) 到实际收尾。规划阶段只读并有界解析 Modrinth/CurseForge/McBBS/原生清单，要求精确 MC/加载器版本；随后编排 Fabric/Quilt 或 Forge/NeoForge profile，先登记生成器实际返回的文件/目录回执（路径、大小、SHA-256），再应用远程成员与 `overrides`/`client-overrides`，写 profile 与 instance marker，最后由 Stage `finish` 全树复核并以 no-replace 发布。生成器内部失败可能没有 partial receipt；未知/未核实的输出不会按文件名盲目收养，Stage/JobGuard/根锁保持 busy 并拒绝“成功清理”。

来源读取和 finish 使用同一 reader gate；等待 Future 被取消或丢弃只发信号，owned worker 仍等待阻塞 reader 真正返回、关闭文件/claim 后才收尾。取消与来源撤权在实际 commit gate 再检查；commit 已开始或已发布时不能承诺回滚，发布后身份复核失败也保留已发布目标。已验证的测试覆盖合成缓存/picker、取消、窗口关闭、来源撤权、回执登记和 sticky cleanup；没有真实公网 URL、原生 picker/provider、真实 Modrinth/CurseForge 文件或实际 Minecraft 安装/启动证据；Android 本批只有 ARM64 Rust cfg 检查，没有 Kotlin/Gradle、链接、APK、设备或游戏证据。

AI 当前链路是 [五协议标准化](../src-tauri/src/ai_protocol.rs#L336) → [13 工具 schema/风险校验](../src-tauri/src/ai_tool_runtime.rs#L193) → [单次审批状态](../src-tauri/src/ai_approval.rs#L17) → [真实动作](../src-tauri/src/ai_actions.rs#L138)。[聊天执行器](../src-tauri/src/services.rs#L583) 每次执行前重读设置及真实根/目录，危险操作强制询问，审批有 180 秒 TTL，取消清队列；最多 4 轮工具并在第 5 轮总结。模型参数中的“确认”不能代替用户批准。`usedTools` 只记成功动作，但 [launch 工具](../src-tauri/src/ai_actions.rs#L178) 成功仅表示已发 `ai:launchRequest`，需主界面实际启动结果；[资源工具](../src-tauri/src/ai_actions.rs#L199) 绑定精确 MC/loader/可分发文件，遇必需依赖拒绝安装主文件。已经开始的事务会等待收尾，取消不声称撤销既成副作用。诊断/test 的无工具请求仍拒绝工具响应，不能据该分支旧注释否定聊天执行器。

新 [ai:transcribe 后端](../src-tauri/src/services.rs#L289) 已接入公开分发：仅 OpenAI/custom，字节数组每项 0..255、音频非空且最多 12 MiB，MIME 白名单 WebM/Ogg/WAV/M4A/MP3；独立转写状态、90 秒 multipart 请求、流式响应上限及文本校验/秘密替换，`ai:cancel` 和主窗关闭会取消转写，`ai:reset` 不取消独立转写或当前聊天，并通过历史代际阻止旧请求完成后写入新历史；与 Electron 会将旧请求结果追加到当前历史的行为仍有差异。本批 Windows Rust 已执行 reset/内存控制局部夹具，Android 仅通过 ARM64 cfg 检查；不证明真实音频或 Android 设备行为。它没有新增事件。当前语音模型仅接受 `whisper*` 前缀，否则回退 `whisper-1`；这是现有实现限制。**已实现的是后端，不是完整语音 UI**：球/HUD 窗口尚未迁移，Android 麦克风权限、录制/codec、TTS 与真实外网转写尚未验证。

本批静态读到事件生产者 **11** 个（应用复用 `download:progress`，真实消费仍未验）：`debug:log`（[受限投递](../src-tauri/src/debug.rs#L42)）、`auth:status`（[auth](../src-tauri/src/auth.rs#L141)）、`download:progress`（[downloads](../src-tauri/src/downloads.rs#L195)、[loaders](../src-tauri/src/loaders.rs#L255)、[Forge](../src-tauri/src/forge.rs#L167)、[Java runtime](../src-tauri/src/java_runtime.rs#L357)、[桌面导出](../src-tauri/src/desktop_export.rs#L217)、[Android 导出](../src-tauri/src/mobile_files.rs#L502)、[整合包导出](../src-tauri/src/modpack/export.rs#L136)、[整合包下载](../src-tauri/src/modpack/download.rs#L271)）、`launch:event`（[runtime](../src-tauri/src/runtime.rs#L531)）、`update:progress`（[services](../src-tauri/src/services.rs#L789)）、`ai:toolRequest`（[审批请求](../src-tauri/src/services.rs#L559)）、`ai:launchRequest`（[动作](../src-tauri/src/ai_actions.rs#L181)）、`forge:log`（[Forge 安装器日志](../src-tauri/src/forge.rs#L167)），以及 **`modpack:progress`**（[export](../src-tauri/src/modpack/export.rs#L136) / [download](../src-tauri/src/modpack/download.rs#L271)）。另有 `resources:update-checked`（[检测事件 envelope 与派发](../src-tauri/src/resource_updates.rs#L179)）与 `devmode:changed`（[main 窗口脱敏状态事件](../src-tauri/src/devmode.rs#L118)）；后者是既有订阅新增生产者，不增加契约成员。下载继续复用已有进度事件，检测也只接入既有订阅，不增加第 24 个契约。其余 **12** 个未读到本批生产者：`resources:updated`、`manage:mods-updated`、`homepage:nav-blocked`、`ai:hudState`、`ai:ballExpanded`、`ai:voiceToggle`、`mp:miniState`、`mp:lobbyChanged`、`mp:chat`、`mp:hudState`、`mp:danmaku`、`music:lyricsState`。[debug send 分发](../src-tauri/src/debug.rs#L171)对 `debug:rendererLog` 只记正文长度与会话累计摘要，不留正文；共享缓冲上限 2000 条/8 MiB，诊断后缀最多 800 条/400 KiB；`hud:setInteractive` 明确拒绝。debug:log 是既有生产者迁移，不增加事件数。

**桌面资源另存闭环已接：** [shell:saveFile](../src-tauri/src/desktop_export.rs#L170) 由原生保存选择器授予一次性 `hcmcl-desktop-save:UUID`，取消返回 null，不向 JS 返回目标路径；原始建议文件名保留为官方 metadata 身份，不能用用户在选择器改出的名字换绑另一资源。现有 [ResourceDownloadPage 调用](../src/renderer/src/pages/ResourceDownloadPage.tsx#L867) 仍将返回的 opaque 字符串传给 `mods.downloadTo`。当前实现只允许创建**新目标文件**，已有文件即使经保存对话框确认也拒绝覆盖。[export_download](../src-tauri/src/desktop_export.rs#L219) 在实例根解析前消费同主窗/epoch 的能力，共用 catalog 的官方 MR/CF URL、原始文件名、hash/大小/类别/分发许可绑定；10 分钟能力、单槽、一次消费与取消/commit 同锁均有源码。IPC 丢弃只发取消，不提前丢弃写入任务、授权或 staging。

[Stage](../src-tauri/src/desktop_export.rs#L29) 使用已打开的父目录链、同父暂存目录和文件身份，等待下载校验、sync 及写 File 关闭后，按源句柄/inode 发布且禁止替换目标；Windows 保持祖先目录的 deny-delete 句柄并用 `SetFileInformationByHandle` 的 no-replace 发布，Unix 分支使用对应句柄化操作而不退回不安全覆盖。并发出现的目标也拒绝；清理失败保留 sticky 限制，不伪报另存成功。取消/主窗关闭失效能力，已进入提交不声称撤销；任务保留到真实关闭/清理收尾。此前五个 Windows 文件/生命周期夹具不是原生选择器 UI、Linux/macOS 文件系统或真实公网下载验收。新 modpack 内部归档输出独立实现；它与反馈附件等业务的 SAF/provider 保存交接仍未因此实现。

**安装器链路与限制：** [Forge 编排](../src-tauri/src/forge.rs#L143) 会在根锁之前等待原版登记任务真实结束，再取得同根安装锁；[installer 下载](../src-tauri/src/downloads.rs#L173) 在线读取官方 SHA-1 并重新验证缓存，任务拥有独占标记的 staging，以复制而非 hardlink 提供输入，预置 mappings、校验安装器元数据及输出 profile，再按绑定范围推广库和运行产物，最后事务发布目标 JSON/一次原版备份。当前独立目录是所有权与回滚边界，**不是 OS 安全沙箱**。[runner](../src-tauri/src/runtime.rs#L325) 使用复核后的绝对 Java、固定 `installer.jar`/`-jar --installClient`、null stdin；按输出字节活动设 **120 秒静默 / 600 秒总时限**，单行/最近输出各 **16 KiB**、日志推送总限 **2 MiB**、约 **100ms** 节流；失败/取消后终止归属进程组或 Windows Job、wait 并 join 两条管道后返回。Unix 安装器若恶意脱组不由此机制沙箱约束。

**现代 NeoForge 源码修正已落地，但真实发布物未验：** [checked_profile / validate_neo_profile](../src-tauri/src/forge.rs#L56) 不再强制 runtime libraries 含自身坐标，而严格绑定 exact profile ID、MC、mainClass、纯字符串且不重复的 NeoForge/MC/launchTarget/FML/NeoForm 参数，并拒绝矛盾库。[neo_metadata](../src-tauri/src/forge.rs#L91) 将 install_profile 的 spec/profile/version/MC/json 与嵌入 profile 联合校验，绑定 `PATCHED`、`MC_SRG`、`MC_EXTRA` 和 exact universal 路径/官方 SHA-1/大小；[产物核验与提升](../src-tauri/src/forge.rs#L109) 先验证固定四项均存在、每项最多 512 MiB、有效 JAR/CRC 与总展开预算，再精确复制并重算摘要，不将 processor 工具库或虚构 classpath 注入 profile。processor 声明 outputs 时才解析并核对对应官方摘要；没有声明时只报告本地产物哈希，不能编造官方哈希。嵌入与最终 profile 的 FML/NeoForm 必须一致。本批 [三个固定官方源码形状的人工夹具](../src-tauri/src/forge.rs#L197) 覆盖元数据、运行产物与发布，修正了旧夹具人为加入自身库的失真；它们**不是下载或运行真实 21.1.190 installer JAR 的证据**。旧 1.20.1 `net.neoforged:forge` 协议仍明确不支持；Electron [仓库模板](../src/main/forge.ts#L25) 同为现代 `net.neoforged:neoforge`。

上述联合绑定修正有固定上游源码依据，不是只从人工夹具猜测：NeoForge **`624c929f49920c250166e2a8df7af87f16d220ef`** 的 [CreateLauncherProfile](https://github.com/neoforged/NeoForge/blob/624c929f49920c250166e2a8df7af87f16d220ef/buildSrc/src/main/java/net/neoforged/neodev/installer/CreateLauncherProfile.java#L69-L111) 从依赖集合生成 libraries，game 参数携带 `--fml.neoForgeVersion` / `--fml.mcVersion` / `--fml.neoFormVersion` 等，不主动加入本项目自身库；[打包步骤](https://github.com/neoforged/NeoForge/blob/624c929f49920c250166e2a8df7af87f16d220ef/buildSrc/src/main/java/net/neoforged/neodev/NeoDevPlugin.java#L348-L363) 直接将其作为 `version.json`。自身 client 坐标及 MC srg/extra 位于 [install_profile data](https://github.com/neoforged/NeoForge/blob/624c929f49920c250166e2a8df7af87f16d220ef/buildSrc/src/main/java/net/neoforged/neodev/installer/CreateInstallerProfile.java#L86-L98)，[installer libraries](https://github.com/neoforged/NeoForge/blob/624c929f49920c250166e2a8df7af87f16d220ef/buildSrc/src/main/java/net/neoforged/neodev/installer/CreateInstallerProfile.java#L166-L195) 另含 exact universal 及官方摘要。当前修正采用上述元数据与运行产物联合绑定，不向 profile 注入虚构坐标。以上为固定源码结构依据，未将源码提交与真实 21.1.190 发布二进制建立验收映射，**不是已取得或运行的发布 JAR**；processor 条目未声明 outputs 时也不能编造生成文件官方哈希。

**反馈附件浏览器交接已接，成功不等于文件已下载。** [公开分发](../src-tauri/src/services.rs#L979) 保留原 `feedback:open-file(id,name)` 两参数和 `{ok,error?}` 合同；[组合根](../src-tauri/src/lib.rs#L265) 在游戏目录解析前接管。只允许当前同服务且未过期的内存会话、合法反馈 ID 与单个附件名；local、非法参数、锁忙/中毒、服务变化和系统交接失败均返回固定三语错误。[handoff](../src-tauri/src/services.rs#L186) 用 query 编码构造共享 `feedback.php` 的 id/file/token，不加产品参数，不把 URL/令牌返回前端或记录日志。系统浏览器接收链接不代表保存完成；它与 Lite 的原生新文件另存流程不同。实际 opener 调用运行在 [owned blocking worker](../src-tauri/src/services.rs#L210)，额外持全局请求守卫到系统调用真实返回；IPC 丢弃不提前放行重启，panic 保留未知状态。四个本地夹具覆盖参数/模式/会话/锁、编码/脱敏、三语错误及真实阻塞屏障；没有启动真实浏览器、访问线上服务或验证 Android Intent。用户说明线上 PHP 尚未更新，本批未部署。

**桌面重启的生命周期门禁。** [组合根](../src-tauri/src/lib.rs#L131) 已移除旧的“向各域发取消信号后直接 `tauri::process::restart`”路径；该自由函数不能等待业务 worker 收尾，前批仅编译通过不证明其时序安全。当前先通过 [Gate](../src-tauri/src/lifecycle.rs#L27) 原子封闭新 IPC；有在途请求、存储初始化未成功、各域 owner/待用票据/清理仍在、锁忙或状态未知时均拒绝重启，检查不取消任务、不清票。IPC 或登记的初始化异常 drop 保留收尾未知；检查失败只撤销本次重启门，正常业务仍可继续查询或主动取消。仅当存储及 runtime/downloads/auth/AI/STT/Java/modpack/外部版本导入/资源检测/桌面导出/`manage:openDir` 都确认空闲时，才保持门禁并交给 `AppHandle::request_restart()`；壁纸与 servers.dat 的独立 worker 同样由 Gate 保留实际收尾。认证后台轮询额外保留真实 worker 计数及异常标记；没有修改 OAuth client、scope 或登录协议。Windows/Linux 本地测试覆盖登记竞争、取消未收尾、锁忙/中毒、真实阻塞写入及异常 drop；尚未运行真实 GUI 重启，也没有外部账号/Java/游戏并发端到端证明。

**本轮参数和取消入口：局部回归已执行，真实故障链仍未验。** [manifest_force](../src-tauri/src/runtime.rs#L697) 将缺省/桥接 null 解释为 false，保留显式 true/false，并拒绝其他类型或多余位置参数；前一批 [Rust fixture](../.local/tauri-current-cancel-windows-tests-r1.log#L1081) 已纳入 **535/0/0**，前一阶段 Lead 会话的全量 Windows Rust 复测为 **546/0/0、18.62s**；前批 resources:open/download:engine 的持久化日志结果为 Windows **552/0/0、18.84s**、Linux **572/0/0、5.35s**，不覆盖本轮 detector/local。[桥参数及取消顺序 fixture](../scripts/test-tauri-progress.mjs#L116) 随当前 Node 脚本 **12/0** 通过（Lead 会话结果，无保证持久化日志）。[download:cancel](../src-tauri/src/lib.rs#L217) 与 [AI task_control_call](../src-tauri/src/lib.rs#L223) 位于 wait_for_storage、通用 settings/keys/game_dir 之前；trusted_main、参数白名单和 Gate 仍保留。导出取消原先 language(app) 的隐藏 Storage 依赖已改为[桌面缓存语言](../src-tauri/src/desktop_export.rs#L148)及[移动端缓存语言](../src-tauri/src/mobile_files.rs#L442)，运行 worker 继续持 owner，提交开始不伪报撤销；本批 Windows [桌面 owner/缓存语言夹具](../.local/tauri-current-cancel-windows-tests-r1.log#L743)与[移动语言纯夹具](../.local/tauri-current-cancel-windows-tests-r1.log#L915)已执行。AI cancel 独立尝试聊天/转写两个信号，reset 清历史并增代际但不取消任务或移除 owner；[异常 AI 状态继续信号转写](../.local/tauri-current-cancel-windows-tests-r1.log#L1103)、[reset 代际](../.local/tauri-current-cancel-windows-tests-r1.log#L1109)和[无 Storage 的内存控制](../.local/tauri-current-cancel-windows-tests-r1.log#L1110)均通过。本批 [Android ARM64 cfg](../.local/tauri-current-cancel-android-check-r1.log#L1514)亦通过，但不执行上述 Android 测试或 Kotlin；没有真实存储/密钥库阻塞故障注入、provider 或端到端取消证据。

平台和明确拒绝单列，**不能再将这些计为目标平台可用**：

| 拒绝范围 | 当前实际行为与源码 |
| --- | --- |
| 全平台 GPU 启动策略查询与移动端重启 | [lib](../src-tauri/src/lib.rs#L212) 的 `app:hardwareAccelerationBooted` 直接 `Err`；设置持久化不证明策略生效。桌面 `app:relaunch` 使用上述全局门禁与各域只读空闲检查，通过后才 `request_restart()`；Android/iOS 在 [平台门](../src-tauri/src/lib.rs#L128) 明确返回不支持错误。真实 GUI 重启仍未验证 |
| Android 的 desktop 27 通道 | 前置 [SAF 路由](../src-tauri/src/mobile_files.rs#L63) 接管 `shell:pickFile/pickFiles` 两导入，`shell:saveFile` 已改为返回一次性保存能力；`shell:openExternal/system:memory/system:hardware` 有共享分支，其余 **21** 个由 [desktop 平台门](../src-tauri/src/desktop.rs#L558) 拒绝，含新增桌面模式与安全全屏。即 **2 SAF 导入 + 1 SAF 保存能力 + 3 共享分支 + 21 平台 Err = 27**；新增硬件只有 Rust cfg 检查，没有 Android 原生采样/设备证明，不因保存能力或共享分支存在就把它们算作设备可用 |
| `mods:downloadTo` 平台差异 | [组合根](../src-tauri/src/lib.rs#L193) 在实例根解析前分别交给桌面/Android 导出；两者只接受本平台当前会话的一次性保存能力与官方资源，不能传普通绝对路径或任意目标 URI。桌面仅新文件/no-overwrite 且有 Windows 夹具；Android 走 SAF/provider，仍无设备提交证明。整合包已有内部 modpacks 输出，但整合包/反馈的 SAF 保存交接仍缺，不是通用保存权限 |
| Android Java / 游戏运行 | 新接管的 `java:install` 在任务登记/联网/建目录前由[组合根](../src-tauri/src/lib.rs#L206)拒绝桌面 JRE 安装；[Java 检测](../src-tauri/src/runtime.rs#L266)也拒绝，`java:check` 随检测失败；[launch:start](../src-tauri/src/runtime.rs#L551)明确无 JVM/GL/Surface/输入，`launch:stop`空态成功不代表可运行 |
| Forge / NeoForge 平台/模式门 | `forge:versions` 已走官方 Maven metadata/短期缓存，本地模式只读已有缓存；[mobile_guard/local_guard](../src-tauri/src/forge.rs#L15) 在安装登记/下载前拒绝 Android/iOS 和本地模式的 installer 执行。桌面分发与现代 NeoForge 联合绑定源码修正已接，不等于已实跑真实发布 JAR 或游戏；`loaders:installInPlace` 只是同名参数扩展，不另算通道 |
| 更新安装交接 | [包类型门](../src-tauri/src/services.rs#L841) 仅 Windows nsis/msi、macOS dmg；Linux/Android 的 `update:downloadAndRun` 明确 `Err`。下载可用不等于签名校验/自动安装/回滚可用 |

更新发布 target 由 [release_target_for](../src-tauri/src/services.rs#L703) 按 OS/ABI 映射：Android `x86 → android-x86`、`aarch64 → android-arm64`、`arm → android-armv7`；桌面 Windows `x86 → win32-ia32`、Windows `x86_64 → win32-x64`，Linux/macOS 使用对应 `linux-*` / `darwin-*` 键。选择器要求 artifact target 精确相等；Android 只接受 `kind=apk` 且文件名以 `.apk` 结束，`android-ia32` 不会由桌面 `win32-ia32` 代替。映射测试 [release_targets_keep_android_x86_and_desktop_ia32_distinct](../src-tauri/src/services.rs#L985) 覆盖上述 Android x86/arm64/armv7 及桌面 ia32 区分；这是 Rust 选择逻辑测试，不是 APK 构建或 Android 安装证据。

前端桥已有 212/2/23 白名单、JSON/二进制编码、异步订阅 ready/dispose 与显式 Android 平台值；[build.rs](../src-tauri/build.rs#L14) 从 TS 调用/发送表生成 Rust 白名单，[main capability](../src-tauri/capabilities/main.json#L5) 只授权主窗事件监听。组合根再核验窗口标签、来源、参数数量/64 MiB 体积，第三方 iframe 不能凭同名通道获得原生权限。当前已有主窗与按需创建的受限桌面 debug 窗口；日志页只可调用固定 getLogs 及监听事件，其他业务仍限主窗。AI 球/HUD/mini/弹幕/开发工具多窗生命周期仍未实现；移动日志页已由主 WebView 内的本地 dialog 宿主承接既有公共 API，未增加原生 command、窗口 capability 或 239 成员合同。

### 2.2 Android 已写源码与仍未闭合的边界

- **Keystore：Rust Android 分支已通过检查，Kotlin/设备未验。** [Rust 内部桥](../src-tauri/src/mobile_security.rs#L62) 注册 [Kotlin HcmclSecretStore](../src-tauri/gen/android/app/src/main/java/top/johnnyblog/hcmcl/security/HcmclSecretStore.kt#L1)，AndroidKeyStore AES-256-GCM、12 字节随机 IV/128 位 tag、域/引用 AAD、AtomicFile 密文保存及读回校验均有源码，Storage 已消费受保护引用；网页直接调插件被拒、无明文 fallback。但 [run_mobile_plugin](../src-tauri/src/mobile_security.rs#L77) 仍是后台同步等待且**没有 deadline**，UI/初始化线程拒绝不解决插件失联的长期等待。第 2.3 节 cargo 检查不编译 Kotlin，不证明密钥丢失/锁屏/恢复流程。
- **SAF 导入：授权链已写，provider 未验。** [Android 分发](../src-tauri/src/lib.rs#L169)、[ACTION_OPEN_DOCUMENT 插件](../src-tauri/gen/android/app/src/main/java/top/johnnyblog/hcmcl/files/HcmclFilesPlugin.kt#L301) 将用户文档经 ContentResolver 分块复制到私有 staging，64 文件/2 GiB 批次、会话/生命周期授权、网页插件调用拒绝；[require_picked_file](../src-tauri/src/desktop.rs#L255) 已转接 `require_imported_file`，catalog 本地导入可消费授权。账号导入也消费该暂存授权，但其 8 MiB/8 文件/32 MiB 检查发生在 SAF 拷贝之后；没有持久文档树版本目录、真实 provider/撤权/进程恢复证据。
- **SAF 保存能力与官方资源导出：宿主已接，不是设备验收。** [shell:saveFile](../src-tauri/src/mobile_files.rs#L454) 调用原生 CREATE 选择器，用户取消返回 null，成功仅返回 **`hcmcl-save:UUID`**；第三方 URI、staging 路径、原生 ticket 均不暴露给 JS。该能力只由同一主窗/会话的 [mods:downloadTo(url, capability, sizeHint)](../src-tauri/src/mobile_files.rs#L504) 一次消费，不能用于通用文件 IPC。宿主绑定的是用户原始建议文件名，不把 provider 改名当作官方文件身份；不依赖实例根可用性。桌面同名 `mods:downloadTo` 本批已接并有 Windows 夹具，使用另一种 opaque 能力与只新文件发布；不能以此替代 SAF/provider 设备证明。modpack 已有宿主缓存受控下载/探测及游戏根内部三格式归档输出；本批新增导入在桌面/Linux 测试覆盖，并通过 Android ARM64 Rust cfg 检查；仍不能从资源另存或缓存下载推导 SAF/provider 保存、安装或导出已实现。
- **导出来源、落盘与提交边界。** [prepare_export_download](../src-tauri/src/catalog.rs#L545) 拒 local/metadata-only，重新读取 Modrinth/CurseForge 官方元数据，绑定精确 URL、原始文件名、大小及 SHA-1/SHA-512；CurseForge 还检查 Minecraft 项目类别及分发许可，不接受任意 HTTPS 下载。[open_staging](../src-tauri/src/mobile_files.rs#L571) 仅原位打开原生创建的同一零字节、0600、无链接 inode，不 create/truncate/rename 替换身份。[流式下载](../src-tauri/src/catalog.rs#L642) 禁重定向、请求超时 180 秒、64 KiB 分片/容量 2 的有界队列，校验全部字节的大小/哈希并等待 sync 与 File 关闭，之后才由宿主进入 [commit_save](../src-tauri/src/mobile_files.rs#L545)。Rust 成功回包要求原生报告字节数一致且 `cleanupIncomplete=false`；这仍不证明 provider 的原子提交、持久化或可恢复性。
- **单槽、10 分钟 TTL 与不可伪取消。** [mobile_export 状态机](../src-tauri/src/mobile_export.rs#L5) 使单槽覆盖 picker、待用能力、下载、提交及清理；TTL 只使未消费 picker/能力过期，不提前释放下载 worker。取消与进入 commit 在同锁内串行化；[download:cancel](../src-tauri/src/downloads.rs#L192) 支持该 taskId 或全部，进入提交后明确 `CommitStarted`，不能回“已撤销”。IPC future 丢弃只发取消信号，不 abort 后台 worker；slot/staging 保留到真实写入、sync、File 关闭及清理收尾，再允许下一次导出。进度复用已有 `download:progress`，提交前最多 99%，无确认成功不报 100%；不是新增事件契约。
- **未知原生结果是粘滞失败，不是可重试成功。** [CleanupStatus](../src-tauri/src/mobile_export.rs#L10) 保留未知 create/commit 原生失败或 `cleanupIncomplete`；后续空 cancel 的成功不能证明旧文档已删，也不能清除该状态。当前会话据此拒绝新导出，提示先检查目标，不直接重试覆盖/制造重复文档。[close/destroy](../src-tauri/src/mobile_files.rs#L300) 失效授权时延后处理仍在写入的会话，避免提前删 root。这是保守错误处理，不是保证恢复成功。
- **SAF 取消/销毁：不保证立即清理。** [独立取消执行器](../src-tauri/gen/android/app/src/main/java/top/johnnyblog/hcmcl/files/HcmclFilesPlugin.kt#L61) 在后台取消信号/关闭流；[cleanup](../src-tauri/gen/android/app/src/main/java/top/johnnyblog/hcmcl/files/HcmclFilesPlugin.kt#L182) 将仍待 picker 回调纳入 `cleanupIncomplete`；[onDestroy](../src-tauri/gen/android/app/src/main/java/top/johnnyblog/hcmcl/files/HcmclFilesPlugin.kt#L547) 清空实例待办，仅留未完成 CREATE 请求 ID 供迟到结果尽力删除。远端 provider 可能不响应取消/关闭，后台仍可阻塞；有界内存、HTTP 超时和等待 worker 关闭不能推导 native provider 在有限时间内退出/清理成功。这些 Kotlin 修改尚无 Kotlin/设备运行证据。
- **游戏/外设仍缺。** [launch:start](../src-tauri/src/runtime.rs#L551) 明确不支持；未实现 Java SE JVM、LWJGL/Surface/输入/音频运行器。下载分支 [跳过桌面 natives](../src-tauri/src/downloads.rs#L135) 并标记 `android-unadapted`，不等于已有 Android 替代库。Forge/NeoForge 版本清单虽可达，安装与就地执行仍在 [移动门](../src-tauri/src/forge.rs#L15) 提前拒绝；不能把 Rust installer runner 的编译当作 Android JVM。托盘/穿透/全局热键、EasyTier、录音/TTS、跨应用歌词均未因 Rust 可编译自动支持。本机记录显示 SDK 包含 36、NDK 30.0.16248370、JDK 17，但仓库配置只能直接确认 Android `compileSdk/targetSdk=36`；没有从项目配置证明 NDK/JDK 版本固定，也没有许可接受、Kotlin/Gradle 编译、链接、APK、设备或游戏证据。

### 2.3 本次可引用的验证证据

**Task95/96 当前最终证据（2026-11-10 11:50 UTC+08:00）**：Lead 已收集 Windows 串行全量 **709 passed / 0 failed / 0 ignored / 0 filtered，138.25s**（`--test-threads=1`，main 0），来源为 job `bash-cb618e1585294fa0` 会话输出，未链接不存在的工作区日志；Linux clean 全量 **733/0/0、11.65s** 有下表日志。Android 对每个 target 先清理 package 再真实编译当前源码，三条日志均显示开头 `Compiling hcmcl-tauri` 和当前 devmode.rs:363，结果为 **52.74s / 27.81s / 27.07s**。这只证明 Rust cfg 检查，不是 Android 测试、native link、Kotlin/Gradle、APK/AAB、设备/provider、JVM/游戏或 SDK 许可接受。先前 Windows **703/2** 的 installer 负载敏感时序夹具失败保留；随后独立串行 installer **10/0/0、8.43s**，最终以新的串行全量 709/0/0 为准，不能把旧失败抹为从未发生。开发授权/Storage 窄测 **12/0（8+4）**及 lib 的两项 mode 提交夹具随最新全量执行；这些 helper 和模拟提交不是完整 Tauri/Storage/HTTP 端到端。node+web typecheck 与桥 **12/0** 为 Lead 已收集会话结果，不造持久日志。没有真实 PHP/账号/设备网络、worker 全流程 E2E、原生 GUI/任务栏/焦点或游戏验收。

**前批 Round4 移动日志页证据保留，真实 GUI/HTTP 与 Android 运行栈仍未验。** 本轮 Windows 657/0/0（32.90s，编译 2m03s）、Linux 679/0/0（5.86s，编译 2m26s）及三 Android Rust cfg 38.71s / 23.04s / 28.32s 有下表持久日志。控制器 11/0、宿主及联动 23/0、日志组件 16/0、桥 12/0 为 Lead 收集会话输出，日志未持久化；宿主夹具转译真实 TSX，但使用轻量 Hooks/FakeDialog，子日志组件用 EmbeddedProbe 替身，不等于真实 React/browser 集成。node+web typecheck exit 0、i18n 14/0、Vite 528 modules/2.91s 已核读。当前 debug.rs 核读 revision 为 `ab542271aa58c669cb40e8d1c6a9ab72860076a2736ee9e6e5e0d3518442b528`，宿主为 `b33a41806e027ff53f0449abcd0f6af3563ab891be5453e4753639da1eeb9913`。公共 API 与裸移动 IPC 的区别、超时/卸载及设备边界见第 2.1 节。

**前批 debug 证据保留。** cfg 分离后 Windows Rust 656/0/0（25.69s、check 40.13s）和 Linux 678/0/0（6.49s）通过；Android r2 三目标只做 Rust cfg。轻量 Hooks/DOM 日志窗夹具 16/0、桥 12/0、Android 准备 12/0、node+web typecheck exit 0、i18n 14/0、Vite 526 modules/3.37s 有下表最终日志。UI 首轮 9/7 源于跨 VM Promise 同化续体未排空；Lead 仅将测试 settle 的两次 microtask 改为 setImmediate 排空，保留原断言与生产组件，随后 16/0；这不是 React 浏览器或原生窗口实测。无本地 PHP server/POST、HTTP E2E 或通用游戏 stdout/stderr sink。前批 debug.rs revision 为 `85adb17d3af7625345ce85b8c98ea5de606c20da9d7576b3d0c4c1282b183887`，buffer.rs 为 `34ea4796a2374a6e46b4cbd53893ffffaa11bd3c32e76cb7756be123b5e638bc`，upload.rs 为 `fdd0c285c87183f58d7570f6c1bd2d18293b31caffe02570c2eb320155faeaeb`；它们是本次核读来源，不以静态 revision 代替验收。

**前批资源更新检测与应用均有桌面本地 Rust 证据；真实公网、GUI 与 Android 运行栈仍未验。** [应用分发](../src-tauri/src/lib.rs#L289)及 [resource_updates](../src-tauri/src/resource_updates.rs#L227) 的 Windows/Linux 本地全量测试分别为 639/0/0（29.35s）与 661/0/0（4.98s）。Apply 保留既有三参数，按当前实例/清单重扫并绑定，以 Modrinth required 同类型依赖生成计划，使用官方元数据重绑和下载哈希验证；跨类型依赖拒绝。额外 Install/Enable/Replace 须经主窗原生全计划审批，票据绑定计划摘要、单次消费、180 秒单调时限。owned worker 持 Gate/root/job 至真实清理；有界 WAL 恢复仅处理有身份凭据的现场，未知收尾保留锁；不承诺任意断电恢复、同 UID 外部 inode CAS 或多文件原子提交。Apply 复用 `download:progress`，`resources:updated` 无生产者。前批 detector/local 的 581/603 桌面测试和 42.93/22.24/21.09 Android cfg 是检测/读取修补证据，不作 apply 验收。`local.rs` revision `c5b38164c48609fbd8d06cc9b3ac55b00a5de4fa31c55f93817ae1b2e689628c` 的 16 GiB 是候选逻辑资源总量（非全流程 IO）；metadata 分块 64 KiB、limit+1，哈希前预算/expected_size 与解析前后取消检查通过前批测试，但同步解析不可即时中断。Apply 的 Android 三目标仅 Rust cfg 检查，不运行 Android 测试或链接，也不是 Kotlin/Gradle、APK、设备/provider、JVM、游戏或 SDK 许可接受证据。

以下结果由 Lead 在各自批次执行并收集，作者只读文件及会话回报，未运行命令。**2026-11-10 06:42 UTC+08:00** 新增 Round4 移动页的 Windows 657/Linux 679、Android 三目标 Rust cfg、控制器/宿主及联动/日志组件/桥和前端结果；本轮与下方 debug 前批结果分别记录。**2026-11-09 21:30 UTC+08:00** 增记 debug cfg 拆分后最终 Windows 656 / Linux 678、修复后 Android r2 三目标 Rust cfg，以及桥/Android 准备各 12/0。cfg 拆分前桌面结果保留阶段历史；task91 UI 首轮 9/7 为测试调度问题，修正 settle 后最终 16/0；前端最终 typecheck/i18n/Vite 日志已收集，但轻量 Hooks/DOM 不等于真实浏览器/GUI；源码协议核对和离线夹具不等于 HTTP E2E，未启动本地 PHP server 或 POST。**2026-11-09 19:50 UTC+08:00** 增记前批资源 apply 的 Windows 639 / Linux 661 及 Android 三目标 Rust cfg；此前 581/603 桌面与 42.93/22.24/21.09 Android 为 detector/local 前批证据，不冒充 apply 验收。首轮 579/601 保留历史。Android 首轮与窄修复查使用相同日志路径；当前文件只对应最新 42.93s / 22.24s / 21.09s，不将已覆盖的旧内容标成当前文件证据。Linux 首次非 login 环境缺 Cargo PATH 导致 127，Lead 补 `/home/johnny/.cargo/bin` 后 r2 才实际执行首轮 601 项测试；不把启动失败当作源码测试失败。**2026-11-09 06:40 UTC+08:00** 记录前批 resources:open/download:engine 的 Windows Rust 552 项、Linux Rust 572 项、Android 三目标 Rust cfg 及前端 typecheck/i18n/Vite 会话结果；此前 **2026-11-09 01:23 UTC+08:00** 的 Windows Rust 535 项、Android ARM64 cfg 45.61s、Node 三项及独立 Lite 两平台 CTest 仍按历史保留；旧 529/48.71s、claim/hardware、pack-import、反馈等历史结果与当时源码摘要保留，不冒充当前证据。Node 三项、Lite CTest 总时间及单独隔离 keyring 只保证 Lead 本会话输出，不捏造日志；Rust 原文与 Lite 模块细节有下列文件链接。此前 Linux 环境失败不代表源码失败；前一阶段 Linux **565/0/0、4.90s（编译2m10s）**为 Lead 会话输出，无持久化日志；前批 resources:open/download:engine 的 Linux **572/0/0、5.35s（编译2m23s）**见下表持久化日志。先前 **564/1** 是未启用隔离设置的链接夹具错误，修正夹具后复测通过。真实存储/密钥库故障注入与 Android Kotlin/Gradle/APK/设备/JVM 仍无证据：

| 实际证据 | 结果 | 能证明与不能证明的范围 |
| --- | --- | --- |
| Task96 最终 Windows 串行全量（Lead 会话输出） | job `bash-cb618e1585294fa0` collect exit 0；**709 passed / 0 failed / 0 ignored / 0 filtered，138.25s**；`--test-threads=1`，main 0；工作区预期日志不存在，不创建链接 | 最终串行本地 Rust 全量；先前 703/2 与串行 installer 10/0/0 的复核过程保留，不据此宣称真实 Windows GUI、官方 PHP 或完整 worker E2E |
| Task96 最终 Linux clean [Rust test](../.local/tauri-task96-final-linux-tests-20261110.log#L1938) | **733 passed / 0 failed / 0 ignored / 0 filtered，11.65s**；[真实编译 hcmcl-tauri](../.local/tauri-task96-final-linux-tests-20261110.log#L382)、[测试编译 2m16s](../.local/tauri-task96-final-linux-tests-20261110.log#L1200)、[main 0](../.local/tauri-task96-final-linux-tests-20261110.log#L1944)；Lead job `bash-30015ab9be3d43f5` collect exit 0 | 包含八项 devmode、四项 Storage 与两项 lib mode 提交测试；本地 helper/模拟提交不等于完整 Tauri/Storage/HTTP 端到端、真实账号或设备网络 |
| Task96 最终 Android 逐 target package clean Rust cfg | [aarch64 52.74s](../.local/tauri-task96-final-clean-aarch64-linux-android-20261110.log#L1883)、[i686 27.81s](../.local/tauri-task96-final-clean-i686-linux-android-20261110.log#L1883)、[x86_64 27.07s](../.local/tauri-task96-final-clean-x86_64-linux-android-20261110.log#L1883)；Lead job `bash-412111c32e7b4770` collect exit 0。三条均在第 1 行真实编译当前 package，第 836 行引用当前 devmode.rs:363 | 旧首轮输出有旧缓存行号，未用于当前源码证明；本行才是 clean 重查。只检查 Rust cfg，不执行 Android 测试或原生链接，不是 Kotlin/Gradle、APK/AAB、设备、JVM/游戏或 SDK 许可接受 |
| Task96 窄测与前端（Lead 会话输出） | clean 窄测 **12/0：8 devmode +4 Storage**；node+web typecheck exit 0、桥 **12/0**；未保证持久日志，不造链接 | 参数、状态投影、epoch/Permit/CAS、helper 与模拟提交的局部验证；不把它们升级为完整 Tauri host、系统密钥库、HTTP 或 worker 全流程 E2E |
| Task96 最终复测前历史（Lead 会话输出） | Windows clean lib **705/0/0、39.04s**；另 all-target **703/2**（两项 installer 负载敏感时序夹具）；独立串行 installer **10/0/0、8.43s**；Linux 先前 **729/0/0、5.71s** | 保留真实失败及复核过程；当前源码最终结论以上方 Windows 709/0/0、Linux 733/0/0 与 Android clean 重查为准 |
| Round4 Windows 移动日志页 [Rust test](../.local/tauri-mobile-debug-windows-tests-20261109.log#L1379) | **657 passed / 0 failed / 0 ignored，32.90s**；[实际测试编译 2m03s](../.local/tauri-mobile-debug-windows-tests-20261109.log#L717)；Lead collect exit 0 | 本轮来源校验及既有 Rust 本地测试；不是真实移动页面、浏览器、上传或游戏验收 |
| Round4 Linux 移动日志页 [Rust test](../.local/tauri-mobile-debug-linux-20261109.log#L1779) | **679 passed / 0 failed / 0 ignored，5.86s**；[实际测试编译 2m26s](../.local/tauri-mobile-debug-linux-20261109.log#L1095)；Lead collect exit 0 | 本轮 Rust 本地回归；不证明 Android 设备、GUI 或公网行为 |
| Round4 Android 三目标 Rust cfg | [aarch64 38.71s](../.local/tauri-mobile-debug-aarch64-linux-android-20261109.log#L1757)、[i686 23.04s](../.local/tauri-mobile-debug-i686-linux-android-20261109.log#L1757)、[x86_64 28.32s](../.local/tauri-mobile-debug-x86_64-linux-android-20261109.log#L1757)，Lead collect 均 exit 0 | 仅 Rust cfg 检查，不执行 Android 测试、native link、Kotlin/Gradle、APK/AAB、设备/provider、JVM/game 或 SDK 许可接受。公共 API 本地 dialog 与裸移动 open IPC Err 分别描述；真机焦点、硬件 Back、viewport 未验 |
| Round4 移动日志页与前端 | 控制器 **11/0**、宿主及联动 **23/0**、日志组件 **16/0**、桥 **12/0** 为 **Lead 收集会话输出，日志未持久化**；[node+web typecheck](../.local/tauri-mobile-debug-typecheck-20261109.log#L4) Lead collect exit 0；[i18n 14/0](../.local/tauri-mobile-debug-i18n-20261109.log#L27)；[Vite 528 modules](../.local/tauri-mobile-debug-web-build-20261109.log#L7)/[2.91s](../.local/tauri-mobile-debug-web-build-20261109.log#L25) | 控制器回执/迟到/超时/卸载及宿主 show/hide commit、三语、Escape/返回、StrictMode 等离线模型；宿主测试中的 DebugLogWindow 为 EmbeddedProbe 替身，另有日志组件独立夹具，不等于完整 React/browser 集成、真实焦点/硬件 Back/viewport 或 HTTP E2E |
| Windows 前批 debug 最终 [Rust test](../.local/tauri-debug-final-windows-tests-20261109.log#L1378) | **656 passed / 0 failed / 0 ignored，25.69s**；[测试编译 2m22s](../.local/tauri-debug-final-windows-tests-20261109.log#L717)、[独立 check 40.13s](../.local/tauri-debug-final-windows-check-20261109.log#L717)；lib 95 warnings/11 duplicates、lib-test 55/47；main 0/0 | cfg(desktop/mobile) 分离后结果；日志/脱敏/上传授权和 owned worker 均为本地离线夹具，没有本地 PHP server/POST、HTTP E2E、真实窗口或通用游戏 stdout/stderr 采集验收 |
| Linux 前批 debug 最终 [Rust test](../.local/tauri-debug-final-linux-20261109.log#L1778) | **678 passed / 0 failed / 0 ignored，6.49s**；[测试编译 2m24s](../.local/tauri-debug-final-linux-20261109.log#L1095)；lib 95 warnings/11 duplicates、lib-test 55/47；main 0/0 | 与最终 desktop/mobile cfg 对应；Rust 本地测试不等于真实 GUI、线上上传或设备行为 |
| Android 前批 debug r2 Rust cfg | [aarch64](../.local/tauri-debug-aarch64-linux-android-r2-20261109.log#L1757) **exit 0、20.30s**；[i686](../.local/tauri-debug-i686-linux-android-r2-20261109.log#L1757) **exit 0、28.28s**；[x86_64](../.local/tauri-debug-x86_64-linux-android-r2-20261109.log#L1757) **exit 0、27.87s** | 首轮因 desktop unminimize 未隔离而 ARM64 E0599，随后整个原生窗口限定 cfg(desktop)，移动 open 明确三语 Err。仅 Rust cfg，不执行 Android 测试，不是 native link、Kotlin/Gradle、APK/device、JVM/game 或 SDK 许可接受，该前批尚无移动日志宿主；Round4 实现与验证另列，真实设备未验 |
| debug 拆分前桌面阶段历史 | [Windows](../.local/tauri-debug-windows-tests-20261109.log#L1378) **656/0/0、25.41s**（[编译 1m13s](../.local/tauri-debug-windows-tests-20261109.log#L717)）；[Linux](../.local/tauri-debug-linux-20261109.log#L1778) **678/0/0、5.77s**（[编译 2m23s](../.local/tauri-debug-linux-20261109.log#L1095)） | 对应同批 cfg 分离前相同桌面逻辑；最终源码复查以上方 final 日志为准，不把历史记录当移动修复后的证据 |
| 前批 debug 桥与 Android 准备 | [桥脚本](../.local/tauri-debug-bridge-tests-r2-20261109.log#L14) **12/0**；[准备脚本](../.local/tauri-debug-android-launcher-tests-r2-20261109.log#L13) **12/0** | 桥契约/事件和合成文件系统夹具；准备脚本不执行 CLI/Gradle/网络。前端和 UI 最终结果另列下行，没有真实 host/窗口/HTTP 验收 |
| 前批 debug 日志窗与前端最终 r2 | [轻量 Hooks/DOM UI](../.local/tauri-debug-window-tests-r2-20261109.log#L17) **16/0**；[node+web typecheck](../.local/tauri-debug-final-typecheck-r2-20261109.log#L4) Lead collect exit 0；[i18n](../.local/tauri-debug-final-i18n-r2-20261109.log#L27) **14/0**；[Vite](../.local/tauri-debug-final-web-build-r2-20261109.log#L7) **526 modules**、[3.37s](../.local/tauri-debug-final-web-build-r2-20261109.log#L24) | 真实组件的转译、三语/文本渲染、先订阅后快照、迟到/重复/清空、卸载、3000 条上限、贴底/暂停等由轻量 Hook/DOM 夹具验证。首轮 9/7 的跨 VM Promise 调度仅修测试 settle，不改生产或断言；最终不是 React 浏览器真实布局/滚动、Tauri 原生窗口或 HTTP 上传 E2E |
| Windows 前批资源应用 [Rust test](../.local/tauri-resource-apply-windows-tests-20261109.log#L1357) | **639 passed / 0 failed / 0 ignored，29.35s**；[测试编译 3m16s](../.local/tauri-resource-apply-windows-tests-20261109.log#L713)；[独立 check 49.89s](../.local/tauri-resource-apply-windows-check-20261109.log#L713)；Lead 收集 exit 0 | 包含 [首次启动恢复真实 pending journal](../.local/tauri-resource-apply-windows-tests-20261109.log#L1348)、[真实选择/计划/多文件事务](../.local/tauri-resource-apply-windows-tests-20261109.log#L1355)及 12 项事务测试；依赖使用受控 metadata/Transport，不证明真实公网、GUI/人工审批或游戏流程 |
| Linux 前批资源应用 [Rust test](../.local/tauri-resource-apply-linux-20261109.log#L1757) | **661 passed / 0 failed / 0 ignored，4.98s**；[测试编译 3m34s](../.local/tauri-resource-apply-linux-20261109.log#L1091)；Lead 收集 exit 0 | 包含 [首次启动恢复](../.local/tauri-resource-apply-linux-20261109.log#L1634)、[真实选择/计划/多文件事务](../.local/tauri-resource-apply-linux-20261109.log#L1704)及事务/审批夹具；本地文件系统测试不保证任意断电恢复、同 UID 外部 inode CAS 或多文件原子提交 |
| Android 前批资源应用 Rust cfg | [aarch64](../.local/tauri-resource-apply-aarch64-linux-android-20261109.log#L1727) **exit 0、70.00s**；[i686](../.local/tauri-resource-apply-i686-linux-android-20261109.log#L1727) **exit 0、36.56s**；[x86_64](../.local/tauri-resource-apply-x86_64-linux-android-20261109.log#L1727) **exit 0、37.87s** | 仅 `cargo check --locked --offline --all-targets`；不执行 Android 测试，不是 native link、Kotlin/Gradle、APK/AAB、设备/provider、JVM/游戏或 SDK 许可接受证据 |
| Windows 前批 detector/local [Rust test r2](../.local/tauri-resource-updates-windows-20261109-r2.log#L1328) | **581 passed / 0 failed / 0 ignored，19.05s**；[测试编译 3m32s](../.local/tauri-resource-updates-windows-20261109-r2.log#L742)，lib 93 warnings（12 duplicates）、lib-test 54 warnings（43 duplicates）；Lead 收集 exit 0 | 新增 [元数据取消/超限](../.local/tauri-resource-updates-windows-20261109-r2.log#L1199)和 [candidate 总预算前置](../.local/tauri-resource-updates-windows-20261109-r2.log#L1204)均通过；覆盖当前 c5b38164 local.rs 增量，不证明真实公网、GUI 或实际玩家流程 |
| Linux 前批 detector/local [Rust test r3](../.local/tauri-resource-updates-linux-20261109-r3.log#L1722) | **603 passed / 0 failed / 0 ignored，4.98s**；[测试编译 2m45s](../.local/tauri-resource-updates-linux-20261109-r3.log#L1114)，lib 92 warnings（11 duplicates）、lib-test 53 warnings（43 duplicates）；Lead 收集 exit 0 | [metadata 分块取消/超限](../.local/tauri-resource-updates-linux-20261109-r3.log#L1590)和 [candidate 总预算](../.local/tauri-resource-updates-linux-20261109-r3.log#L1594)均通过；与首轮 Unix 链接/变更夹具一起构成桌面本地证据，不是外网或设备验收 |
| Windows 资源检测首轮历史 [clean Rust test](../.local/tauri-resource-updates-windows-20261109.log#L1339) | **579 passed / 0 failed / 0 ignored，20.15s**；[测试编译 2m13s](../.local/tauri-resource-updates-windows-20261109.log#L755)，lib 94 warnings（11 duplicates）、lib-test 55 warnings（45 duplicates） | 首轮已执行 9 个 catalog update 夹具，包括 CF schema、完整分页、策略和取消；本地扫描含 MC/loader/继承、目录与文件变更，受控元数据不证明真实公网 CF/MR；其后读取修补由上方 r2 单独验证 |
| Linux 资源检测首轮历史 [Rust test r2](../.local/tauri-resource-updates-linux-20261109-r2.log#L1728) | **601 passed / 0 failed / 0 ignored，4.92s**；[测试编译 2m23s](../.local/tauri-resource-updates-linux-20261109-r2.log#L1122)，lib 93 warnings（11 duplicates）、lib-test 54 warnings（44 duplicates） | [Unix 祖先 symlink/文件变更](../.local/tauri-resource-updates-linux-20261109-r2.log#L1615)等通过；先前 Cargo PATH 127 后重跑。其后读取修补以最新 r3 为准 |
| Android 前批 detector/local 窄修 Rust cfg | [aarch64](../.local/tauri-resource-updates-aarch64-linux-android-20261109.log#L1735) **exit 0、42.93s**；[i686](../.local/tauri-resource-updates-i686-linux-android-20261109.log#L1735) **exit 0、22.24s**；[x86_64](../.local/tauri-resource-updates-x86_64-linux-android-20261109.log#L1735) **exit 0、21.09s**；各 lib 276 warnings（52 duplicates）、lib-test 104 warnings（94 duplicates）；Lead job `bash-f0776d70ef7248cc` collect 0 | 最新 c5b38164 local.rs 的 Rust cfg 检查，不运行 Android 测试，不是 native link、Kotlin/Gradle、APK/AAB、设备/provider、JVM/游戏或 SDK 许可接受。三个同名日志已被此次覆盖；首轮 45.86s/31.65s/31.44s 与 lib 277/52、lib-test 105/95 仅保留为历史会话记录 |
| 前批 detector/local 前端（Lead 会话结果） | job `bash-0be9a71442734a20` exit 0；typecheck、i18n **14/0**，Vite **526 modules、3.96s**；未保证持久化日志 | TypeScript、三语键和 bundle 本地检查，不连接真实 Tauri host，不证明 Rust 检测网络/GUI 或 Android 游戏 |
| 前轮文档 validator（Lead 会话结果） | job `bash-371cfd298e60406b` exit 0；**965 local / 33 external（未联网校验）/ 812 line + 2 heading**；契约 **239 = I212 + S2 + E23 + L2**，LF SHA-256 `6ffe2170c9000b1f651095c5ef779da790f883919c6a8ba16c278a46cb75c36b`；diff PASS、errors=[] | 仅验证执行时的两文档快照；不是本次新增链接的重跑结果，也不是业务/网络测试。本轮 CAS 不编辑契约正文，新增锚点由文件工具核读，最终 validator 待 Lead 另收集 |
| Windows [前一批干净 Rust cargo test](../.local/tauri-current-cancel-windows-tests-r1.log#L1178) | **535 passed / 0 failed / 0 ignored，21.15s**；[测试编译 2m00s](../.local/tauri-current-cancel-windows-tests-r1.log#L638)，lib 77 warnings（3 duplicates）、lib-test 44 warnings（35 duplicates）；main 测试二进制 0 tests/0 failures | 本批 null 参数、桌面缓存语言/owner、移动语言纯逻辑、AI reset/内存控制夹具实际通过；无真实存储/密钥库故障注入、GUI、外网账号/游戏端到端证明 |
| Android [前一批 ARM64 Rust cfg check](../.local/tauri-current-cancel-android-check-r1.log#L1514) | **PASS，45.61s**；224 lib warnings（23 duplicates）、91 test warnings（83 duplicates） | 只编译检查 ARM64 Rust cfg，不运行 Android 测试、Kotlin/Gradle、最终链接、APK/AAB、设备/provider、JVM 或 Minecraft；SDK 许可未接受 |
| Node 本批三项（Lead 会话输出） | [进度桥](../scripts/test-tauri-progress.mjs) **12/0**、[Android 启动器](../scripts/test-tauri-android-launcher.mjs) **12/0**、[账号导入](../scripts/test-account-import.mjs) **26/0**；未保证持久化日志 | Node 脚本的局部桥/模板/合成来源测试；Android 启动器夹具只做文件系统模拟，不执行真实 CLI/Gradle 或构建 APK |
| Windows 前批 resources:open/download:engine Rust 全量测试（持久化日志） | **552 passed / 0 failed / 0 ignored，18.84s**；[测试编译 2m29s](../.local/tauri-resources-engine-windows-r1.log#L685)；[日志](../.local/tauri-resources-engine-windows-r1.log#L1242)；lib 87 warnings（8 duplicates）、lib-test 50 warnings（41 duplicates） | 全量 Rust 测试包含本批资源目录宿主与 download:engine 兼容状态夹具；不证明真实公网下载、外网账号、Java/Minecraft、GUI 或 Android 原生链路 |
| Linux 前批 resources:open/download:engine Rust 全量测试（持久化日志） | **572 passed / 0 failed / 0 ignored，5.35s**；[测试编译 2m23s](../.local/tauri-resources-engine-linux-r1.log#L1054)；新目录构建；[日志](../.local/tauri-resources-engine-linux-r1.log#L1631)；lib 86 warnings（8 duplicates）、lib-test 49 warnings（40 duplicates） | 全量 Rust 测试包含本批资源目录宿主与 download:engine 兼容状态夹具；不证明真实公网下载、外网账号、Java/Minecraft、GUI 或 Android 原生链路 |
| Android 前批三目标 Rust cfg check（Lead 持久化日志） | [arm64](../.local/tauri-resources-engine-android-arm64-r1.log#L1666) **exit 0、42.20s**；[i686](../.local/tauri-resources-engine-android-i686-r1.log#L1666) **exit 0、24.87s**；[x86_64](../.local/tauri-resources-engine-android-x86_64-r1.log#L1666) **exit 0、24.31s**；三目标分别均为 lib 268 warnings（49 duplicates）、lib-test 99 warnings（90 duplicates） | 顺序执行 `cargo check --locked --offline --all-targets`；仅 Rust cfg 编译检查，不运行 Android 测试，也不是 Kotlin/Gradle、native link、APK/AAB、设备/provider、JVM/Minecraft 或 SDK 许可接受的证据 |
| Lite WSL / QuickPlay（独立产品，Lead 会话输出） | WSL CTest **18/18、62.81s**，隔离 Secret Service **4/0/0**；Windows QuickPlay 构建/测试 exit 0，无保留统计 | QuickPlay 使用测试替身的 Java 检查、进程和世界/服务器清单，不证明真实 Java、Minecraft 游戏、外网服务器或人工 UI 验收；Lite 结果不替代 Rust Linux/Android 证据 |
| Lite Linux 本批全新目录（独立产品） | Lead 会话收集 CTest **18/18、37.82s**；[window](<../HungerCat MineCraft Launcher Lite/build-native-linux-task67-r1/Testing/Temporary/LastTest.log#L688>) **30/0、18.99s**、[common](<../HungerCat MineCraft Launcher Lite/build-native-linux-task67-r1/Testing/Temporary/LastTest.log#L32>) **22/0**、[catalog](<../HungerCat MineCraft Launcher Lite/build-native-linux-task67-r1/Testing/Temporary/LastTest.log#L229>) **43/0**、[engine](<../HungerCat MineCraft Launcher Lite/build-native-linux-task67-r1/Testing/Temporary/LastTest.log#L642>) **11/0**；单独隔离 Secret Service **4/0/0** | C++17/SDL 全新目录，不是 Linux Rust 验证。普通 CTest credential 为 **3/0/1**，与另行 keyring 往返分开；总时间/keyring 为会话输出。GCC15.2.0、`-O3 -DNDEBUG -std=c++17` 的 `-Wfree-nonheap-object` 完整诊断未留存，不能绑定源码；未证实内存缺陷或假阳性，18项通过不作归因 |
| Lite Windows 本批干净构建（独立产品） | Lead 会话收集 full build/CTest exit0，**18/18、115.69s**；[原始 LastTest](<../HungerCat MineCraft Launcher Lite/build-native-win-task67-r1/Testing/Temporary/LastTest.log>) | 原文件含非 UTF-8 内容，作者的文件工具未能解码；数值来自 Lead 收集结果，不捏造模块分组，也不证明 Rust、干净机器或完整游戏验收 |
| HCMCL React/Tauri web 前端（前一批会话） | Lead 会话收集 `npm run typecheck` 与 `npm run build:tauri:web` 均 exit 0；Vite 5.4.21 构建 526 个模块，3.79s；未保证持久化日志 | 保留历史结果；仅 TypeScript 与 web bundle 检查，不连接 Rust/Tauri host，不证明窗口、Android WebView、IPC 业务或游戏流程 |
| HCMCL resources:open/download:engine 前端（前批会话） | Lead 会话收集 typecheck exit 0、三语 i18n **14 通过 / 0 失败**、Vite **526 modules、3.81s**；未保证持久化日志 | 下载页区分内置 Rust 后端与 Electron 可选 `.node` 状态；仅类型、语言键与 web bundle 证据，不证明真实窗口交互、下载、Android WebView 或游戏流程 |
| Lite Windows SDL 首页离线 smoke | [1280×820 PNG](<../HungerCat MineCraft Launcher Lite/build-native-win-task67-r1/lite-home-smoke.png>)；本批 Windows SDL 主程序运行三帧后保存并由 Lead 视觉检查 | 只验证首页渲染与基本布局，不执行联网、账号或启动操作，不等于交互验收或完整游戏验证 |
| Windows [反馈浏览器交接 clean check/test](../.local/tauri-feedback-open-windows-r1.log#L1188) | **cargo check --all-targets PASS / 1m22s；468 passed / 0 failed / 0 ignored**；测试编译 **2m05s**、执行 **14.83s**；54 lib / 36 lib-test warnings（check 中 28 duplicates） | 退出码 0；四个新增 handoff 测试均实际执行，阻塞 opener 是合成回调，不启动真实浏览器或联网，不证明完整 React 点击链 |
| Linux [反馈浏览器交接 clean check/test](../.local/tauri-feedback-open-linux-r1.log#L1170) | **cargo check --all-targets PASS / 26.87s；478 passed / 0 failed / 0 ignored**；测试编译 **47.07s**、执行 **4.91s**；55 lib / 35 lib-test warnings（check 中 29 duplicates） | WSL 退出码 0；本地状态/编码/真实线程屏障，不证明桌面 opener、Android Intent、线上旧服务或完整游戏路径 |
| Android [反馈浏览器交接 ARM64 Rust check](../.local/tauri-feedback-open-android-r1.log#L610) | **PASS / 56.16s**，87 warnings；clean 移除 91 files / 201.2 MiB | 仅 ARM64 Rust cfg；无 Kotlin/Gradle、最终链接、APK、设备/浏览器、JVM 或游戏证据；SDK license 未接受 |
| Windows [cargo check --locked --offline --all-targets（claim/hardware r1）](../.local/tauri-claim-hardware-windows-check-r1.log#L462) | **PASS / 43.81s**；54 lib warnings、36 lib-test warnings（28 duplicates） | Lead 收集退出码 0；当前 Windows host 全目标检查，不证明 macOS/Android 原生运行 |
| Windows [cargo test --lib（claim/hardware r1）](../.local/tauri-claim-hardware-windows-tests-r1.log#L708) | **451 passed / 0 failed / 0 ignored**；测试编译 **1m37s**，执行 **15.84s**；[宿主硬件五字段采样](../.local/tauri-claim-hardware-windows-tests-r1.log#L361) 通过，12 个硬件相关测试名均出现 | 含真实 Windows host 只读采样与五字段/未知年份/VM marker/失败解析/无参数合同夹具；不是 macOS、Android 设备或游戏验收 |
| Windows [生命周期重启门禁 clean check/test（Lead 收集摘录）](../.local/tauri-lifecycle-windows-check-tests-r1.log#L10) | **cargo check --all-targets PASS；464 passed / 0 failed / 0 ignored**，测试编译 **45.12s**，执行 **17.02s**；clean 移除 297 files / 1.4 GiB；54 lib / 36 lib-test warnings（28 duplicates） | 退出码 0；包含全局 IPC/初始化门禁、各域只读空闲检查和真实 writer 屏障夹具；该链接为明确标注的结果摘录，不是原始 stdout。未执行真实 GUI 重启或外部账号/游戏端到端 |
| Linux [生命周期重启门禁 clean check/test](../.local/tauri-lifecycle-linux-check-tests-r1.log#L1166) | **cargo check --all-targets PASS / 15.11s；474 passed / 0 failed / 0 ignored**，测试编译 **40.34s**，执行 **4.81s**；clean 移除 348 files / 1.2 GiB；55 lib / 35 lib-test warnings（29 duplicates） | WSL 退出码 0；实际执行新增门禁、取消未收尾、锁忙/中毒与阻塞写入测试。两条 PATH translation 警告仍在；不证明 GUI 重启、macOS、Android 设备或完整游戏路径 |
| Linux [cargo check --locked --offline --all-targets + cargo test --lib（claim/hardware r1）](../.local/tauri-claim-hardware-linux-check-tests-r1.log#L448) | clean 移除 **348 files / 1.2 GiB**；check **PASS / 21.50s**，55 lib / 35 lib-test warnings（29 duplicates）；测试编译 **1m01s**；[461 passed / 0 failed / 0 ignored](../.local/tauri-claim-hardware-linux-check-tests-r1.log#L1153)，执行 **5.14s**；[宿主采样](../.local/tauri-claim-hardware-linux-check-tests-r1.log#L807) 通过，12 个硬件相关测试名均出现 | WSL Linux host 真正读取 sysfs/proc，不是 Android 设备；日志另有两条 PATH translation 警告，不能把编译警告省略成无警告 |
| Android [cargo check --lib --target aarch64-linux-android（claim/hardware r1）](../.local/tauri-claim-hardware-android-check-r1.log#L494) | **PASS / 41.39s**，69 warnings | 仅 ARM64 Rust cfg 检查；硬件原生/设备采样、Kotlin/Gradle、最终链接、APK、Keystore/SAF provider、JVM/游戏仍未验；SDK license 未接受 |
| Android [cargo check --lib --target aarch64-linux-android（生命周期门禁 r1）](../.local/tauri-lifecycle-android-check-r1.log#L609) | **PASS / 16.25s**，87 warnings；clean 移除 91 files / 200.9 MiB | 仅验证 Rust ARM64 cfg，包括请求/初始化门禁和移动端重启拒绝分支；未执行 Activity 重启，不证明 Kotlin/Gradle、最终链接、APK、设备、SAF/Keystore 或游戏路径；SDK license 未接受 |
| Windows [前批冻结集成 cargo check --locked --offline --all-targets（r6）](../.local/tauri-native-batch-windows-check-r6.log#L626) | **PASS / 11.54s**；44 warnings（35 duplicates） | 对应 wallpaper、instance_servers、external_versions 前批集成；不为本轮 manifest_force/桥 null/取消顺序新修复背书，不证明 Linux/macOS/Android 原生运行或真实产品链路 |
| Windows [前批冻结集成 cargo test --locked --offline --all-targets（r3）](../.local/tauri-native-batch-windows-tests-r3.log#L1160) | **529 passed / 0 failed / 0 ignored**；执行 **21.79s**；`src/main.rs` 测试二进制 0 tests/0 failures | 前批集成全量 Rust fixture；该旧批当时未包含后续参数/取消修复，本批 535 项另行记载；不证明真实账号、外网、Java、Forge/NeoForge、Minecraft 或 GUI E2E |
| Android [前批冻结集成 cargo check --locked --offline --all-targets --target aarch64-linux-android（r3）](../.local/tauri-native-batch-android-arm-check-r3.log#L1737) | **PASS / 48.71s**；223 lib warnings、91 test warnings（83 duplicates） | 仅前批 Android ARM64 Rust cfg/typecheck，包含壁纸模块但未执行图片/SAF/provider 测试；不覆盖本轮新修复，也不证明 Kotlin/Gradle、原生链接、APK/AAB、设备、JVM/LWJGL/Surface、输入/音频或游戏 |
| Linux [前一批当前源码回归](../.local/tauri-native-batch-linux-tests-r1.log) | **未完成**；WSL 启动路径转换失败，离线缓存还缺新增 `image` 依赖 | 这是执行环境阻塞，不能据此判定 Linux 源码失败；本批最终 Linux 结果仅为 Lead 会话输出，见下表新增行 |
| task62 [壁纸模块](../src-tauri/src/wallpaper.rs#L1) | **冻结 revision `b08cfcdea0345e0501abdae367232f38b570ff251dd7577b00668faa01fdb0d0`**；前批 Windows r6 与全量测试覆盖真实 PNG/BMP/GIF、CAS、无覆盖发布和生命周期清理夹具 | Windows 编译/测试已有证据；Android 已有前批 ARM64 Rust cfg 检查，未执行该模块测试或 SAF/provider 设备验收；Linux 当前回归未完成 |
| task63 [servers.dat 模块](../src-tauri/src/instance_servers.rs#L1) | **冻结 revision `acc8c8933e1606ed4638653a45a4312391ff9da7630889a5cd8b5074590ad79d`**；Windows 侧 NT 原子新建/替换和旧句柄读取夹具已纳入 529 项回归 | 不宣称同权限外部进程 inode CAS、Linux 当前源码回归或真实游戏读写 |
| task64 [外部实例导入模块](../src-tauri/src/external_versions.rs#L1) | **冻结 revision `29fe964053de31320690a0fa107337f5a106c28c74d28a641c8243252aa0ae6e`**；自引用 root JAR、外部引用、缺 root JAR 语义已纳入前批冻结集成源码 | 不宣称真实外部实例、公网导入、移动 SAF tree 或 Linux 当前源码回归 |
| 前批参数/取消静态读取记录（历史） | [runtime](../src-tauri/src/runtime.rs#L697) revision `99595bb9a5cecb62ff8c541e501368f3f0d2cd272ffb02696ee4d82a41965d85`；[桥脚本](../scripts/test-tauri-progress.mjs#L116) 当时读取 revision `2762992d39edf1a21102c6dbe0e7bc54022436e58e4ef3427cb373ede9be57ac`（含 null 参数、取消顺序、导出取消及 reset 行为静态 fixture）；[组合根](../src-tauri/src/lib.rs#L210) 与 [AI/STT 控制](../src-tauri/src/services.rs#L464) 已按源码核对 | **当时尚未编译/执行，未做存储/密钥库故障注入**；本行保留当时静态读取摘要，不将历史 529/ARM64 检查与桥 8/0 视为新修复证据；后续本批 535/ARM64 45.61s/Node 12 结果另列于表首。另曾核读[桌面导出取消](../src-tauri/src/desktop_export.rs#L283) revision `aad2047d91aea9461922df794f4fe50e49fc5c197d74d4655c84120454d466b8`，当时新增缓存语言/owner 局部 fixture 未运行；移动端 [取消源码](../src-tauri/src/mobile_files.rs#L442) revision `356d8b8a99e29d4d4997a0816a33e2ddaf138a93c93248d89abdeb30c011212b` 当时已改为缓存语言、尚未编译或运行 |
| Windows [cargo check --locked --offline --all-targets（pack-import r1）](../.local/tauri-pack-import-windows-check-r1.log#L462) | **PASS / 26.91s**；lib test 生成 36 warnings（28 duplicates） | clean-crate Windows host 全目标检查；Lead 收集退出码 0，仍有警告，不证明 macOS/Android 原生运行 |
| Windows [cargo test --lib（pack-import r1）](../.local/tauri-pack-import-windows-tests-r1.log#L693) | **436 passed / 0 failed / 0 ignored**；[running 436 tests](../.local/tauri-pack-import-windows-tests-r1.log#L255)，测试编译 1m40s，执行 **14.54s**；`progress_uses_the_native_envelope_consumed_by_the_existing_bridge` 于 [L490](../.local/tauri-pack-import-windows-tests-r1.log#L490) 通过，关键 import tests 从 [L518](../.local/tauri-pack-import-windows-tests-r1.log#L518) 起通过 | 覆盖六分支导入的合成 picker/cache 来源、native envelope、回执/阶段/取消/撤权/unknown cleanup；不证明真实公网 URL→Claim→Input、native picker/provider、账号服务或游戏 |
| Linux [cargo check --locked --offline --all-targets + cargo test --lib（pack-import r1）](../.local/tauri-pack-import-linux-check-tests-r1.log#L448) | check **PASS / 20.86s**；测试编译 **45.71s**；[446 passed / 0 failed / 0 ignored](../.local/tauri-pack-import-linux-check-tests-r1.log#L1138)，执行 **4.85s**，check 35 warnings；`progress_uses_the_native_envelope_consumed_by_the_existing_bridge` 于 [L930](../.local/tauri-pack-import-linux-check-tests-r1.log#L930) 通过，关键 import tests 从 [L958](../.local/tauri-pack-import-linux-check-tests-r1.log#L958) 起通过 | clean-crate Linux host 检查与 Rust 测试；含真实本地文件/stage 夹具，不证明公网 URL、Kotlin/Gradle、provider 或游戏；Android ARM cfg 另见本表 r2 行 |
| Windows [cargo check --locked --offline --all-targets（r6）](../.local/tauri-pack-download-windows-r6-check.log#L418) | **PASS / 6.15s**；47 lib warnings、lib test 30 warnings（24 duplicates） | 前批受控下载 evidence；不证明 macOS/Android 原生运行 |
| Windows [cargo test --lib（r6 全量）](../.local/tauri-pack-download-windows-r6-tests.log#L567) | **332 passed / 0 failed / 0 ignored**；[编译 15.11s](../.local/tauri-pack-download-windows-r6-tests.log#L230)，执行 **6.98s** | 前批下载地址/DNS/重定向、缓存能力/取消/清理夹具；不证明真实公网下载、picker/provider、账号服务或游戏 |
| Linux [cargo check --locked --offline --all-targets（r6）](../.local/tauri-pack-download-linux-r6-check-tests.log#L418) / [cargo test --lib（r6 全量）](../.local/tauri-pack-download-linux-r6-check-tests.log#L974) | **PASS**；check **4.92s**，test **341 passed / 0 failed / 0 ignored**，执行 **4.66s**；[测试编译 9.89s](../.local/tauri-pack-download-linux-r6-check-tests.log#L628)，49 lib / 29 test warnings（check 中 24 duplicates） | 前批受控下载证据；不证明真实 keyring/认证服务、干净机器或完整产品验收 |
| Android [cargo check --lib --target aarch64-linux-android（pack-import r2）](../.local/tauri-pack-import-android-check-r2.log#L712) | **PASS / 47.75s**，69 warnings | 前批 pack-import Android ARM64 Rust cfg 检查；仍非 Kotlin/Gradle、最终链接、APK、Keystore/SAF provider 设备测试、JVM/游戏运行；SDK license 未接受 |
| Node [前批进度桥回归](../scripts/test-tauri-progress.mjs) | 前批 Lead 执行退出码 0；[8 通过 / 0 失败](../.local/tauri-pack-import-progress-r4.log#L10) | 对应当时既有 envelope、裸事件/未知通道拒绝、退订清理及导入可选参数；该旧批尚未执行后续 null/布尔 fixture，当前 Node 12/0 另列于表首，不混用批次 |
| Lite Windows [原生窗口测试程序](../.local/lite-system-ui-windows-direct-r1.log#L19) | 使用 Visual Studio CMake 重新生成 `HungerCatLite.exe` 与 `hcl_native_window_tests.exe`；直接执行测试程序 [18 通过 / 0 失败](../.local/lite-system-ui-windows-direct-r1.log#L19)（3 语言 × 6 流程） | 覆盖 SDL 输入、许可/文件 CRUD、壁纸、About 回环 HTTP、归档导入/实例切换与 `system.info` 真实 Windows 数据；CTest 当前构建目录报告无已注册测试；不证明 Lite 真实 Minecraft/跨平台完整业务 |
| Lite Linux [WSL 直接 runner](../.local/lite-system-ui-linux-direct-r2.log#L11) | CMake/CTest 在 WSL 内直接运行，**18/18 通过、0 失败，28.01s**；隔离 Secret Service **4/0/0** | 覆盖 Lite Linux C++17/SDL 现有 CTest 与隔离凭据往返；WSL 有两个 PATH translation 警告，外层 MSYS 脚本仍有环境性 127；不证明所有 Linux 发行版、macOS、真实 Minecraft/Java 或远程服务 |

前批 [启动前刷新 Windows 310 项](../.local/tauri-launch-refresh-r2-windows-tests.log#L545)、[Linux 318 项](../.local/tauri-launch-refresh-r2-linux-check-tests.log#L945)、[Java Windows 240 项](../.local/tauri-java-install-windows-r2-tests-utf8.log#L449)、[Linux 245 项](../.local/tauri-java-install-linux-r2-check-tests-utf8.log#L1524)、[桌面导出/Neo Windows 175 项](../.local/tauri-desktop-export-neo-tests-utf8.log#L368) 均为历史，不用于声称本批代码通过。最近已完成的前一阶段证据为上表 **Windows Rust test 546/0/0（18.62s）**、**Linux Rust test 565/0/0（4.90s）**、**Android ARM64 cfg check（1m18s）** 与 **Node 12/0、12/0、26/0**；前批 resources:open/download:engine 的 Windows **552/0/0（18.84s）**、Linux **572/0/0（5.35s）**、Android 三目标 Rust cfg 及前端会话结果另列，均只代表目录/引擎前批；检测首轮 579/601 和三目标 cfg 作为历史，最新读取修补已由 Windows 581 / Linux 603 本地回归验证，Android 最新窄修三目标 cfg 均 exit 0（42.93s/22.24s/21.09s），同名日志已覆盖，旧时间仅保留为历史会话记录；参数/取消局部 fixture 已执行，真实存储/密钥库故障注入仍未执行；无专门持久化日志的会话结果不伪装为日志文件。Windows check r6（11.54s）/529项（21.79s）、Android48.71s及 Windows468/Linux478/Android56.16s 均按原历史保留。更早批次的 Linux 回归曾因环境未完成：WSL 启动存在 `D:\\BtSoft\\panel\\script`、`D:\\platform-tools` 路径转换问题，离线缓存也缺新增 `image` 依赖，因此不把该次失败归因于源码。历史 Windows/Linux 批次仍包含实际 host 硬件五字段采样；Lite Linux 另有 WSL CTest 18/18 与隔离凭据 4/0/0 证据；这些数字不是 Android 测试数或产品完成率。前批 pack-import 的 **Windows 436 项、Linux 446 项、Android ARM64 Rust cfg check 47.75s（69 warnings）** 独立保留；其 Android r2 由原生 Node 环境脚本收集，Lead 记录 collect exit 0，修复了 r1 的 MSYS 路径空格收集问题。pack-import 测试使用合成 picker/cache 来源和本地受控 stage；`start_with_opener` 是合成 Input+真实缓存 claim 的测试替身，不证明真实外网 URL→Claim→Input 全链。生成器内部失败可能无 partial receipts；source/stage/root/job cleanup 未知时维持 busy，失败关闭不是全部回滚。下载网络夹具仅在 `cfg(test)` 内使用受控回环拨号，不开放生产 HTTP/私网例外；合成账号与 loopback 不证明真实登录/刷新或公网整合包下载。系统 keyring 写入仍由生产 secure_set/delete 负责，Linux Ygg 测试仅注入测试专用持久化函数。三平台 cargo 结果不等于 macOS 检查、Kotlin/Gradle/原生链接/APK/Android 设备或 JVM 游戏验收；真实 picker/provider、外网认证、UAPIS/SLP、资源/整合包下载、Java/Forge/NeoForge 安装与启动、双机 MP、麦克风/TTS、签名更新仍**未验证**。SDK 36 / NDK 30 / JDK 17 是工具链事实，不是许可接受或 APK 证明；Lite SDL/PHP 夹具也不替代当前 Rust 迁移证据。

## 3. 主进程依赖盘点

| 模块与源码证据 | 现有实现与耦合 | 桌面迁移计划 | Android 限制/改造 |
| --- | --- | --- | --- |
| [index](../src/main/index.ts#L10)、[app](../src/main/app.ts#L313)、[context](../src/main/handlers/context.ts#L13) | app 生命周期、BrowserWindow/WebContents、ChildProcess 引用、多个缓存与 AbortController 由组合根持有 | 拆成 AppHost/WindowHost/TaskHost/GameRuntime/StorageHost；Rust 管生命周期，业务 sidecar 不创建系统窗口 | Activity/Service 生命周期，进后台不等于桌面托盘；游戏运行与 WebView 不应共享脆弱的页面生命周期 |
| [preload](../src/preload/index.ts#L1)、[所有域注册](../src/main/app.ts#L1293) | contextBridge、ipcRenderer、ipcMain 注册与统一日志包装 | 兼容 API 适配器 + schema 白名单；移除主进程 IPC 插桩对 Electron 的 monkey patch | Kotlin/Rust command；相机/麦克风/文件等能力必须走移动权限，不继承旧默认媒体放行 |
| [broker](../src/main/broker.ts#L14)、[网络 worker](../src/main/network/index.ts#L1105) | Electron utilityProcess + process.parentPort；请求/取消/进度/结构化错误；短请求 45 秒、流 idle 90 秒、崩溃退避 | 可用受控 child_process/worker + stdio/IPC 取代；保留隔离、取消、超时和去重；再按域迁 Rust HTTP | 没有可直接套用的 Node utilityProcess；网络由 Rust/Android 层执行，后台下载需服务/调度及恢复策略 |
| [auth](../src/main/auth.ts)、[yggdrasil](../src/main/yggdrasil.ts)、[accounts handler](../src/main/handlers/accounts.ts#L14) | Microsoft 设备码、取消/刷新，Yggdrasil 多角色与皮肤、owner 绑定导入 | TS 协议可先保留；宿主只返回展示 DTO/随机会话引用；保持取消与窗口销毁清理 | 设备码可复用协议；浏览器跳转、深链、Keystore、后台轮询/恢复需实现；不能读其他应用私有账号 |
| [account-import](../src/main/account-import.ts#L66)、[parser](../src/main/account-import-parser.ts) | Electron 文件对话框、8 MiB/10 分钟会话、Windows PCL 注册表 PowerShell | picker 与读取抽象；Windows 固定注册表读取迁 Rust 原生；解析可保留 | 用户通过 SAF 主动选导出文件；Windows 注册表读取明确不支持；不能扫描其他应用沙箱 |
| [store](../src/main/store.ts#L1)、[portable](../src/main/portable.ts#L18) | app.getPath(userData)、序列化写入、便携环境变量、gameDirAbs 派生字段、多个版本目录 | 宿主先确定 data/config/game 根，再初始化业务；一次性迁移旧目录，保留备份、目录别名及相对路径语义 | 应用私有目录与被授权的文档树分开；不能把 PORTABLE_EXECUTABLE_DIR 作为 Android 产品身份 |
| [secret](../src/main/secret.ts#L1) | safeStorage 加密、系统钥匙环可用性检查；反馈/AI/翻译/CF 密钥二进制文件 | 系统凭据服务/受保护存储；拒明文 fallback；旧 blob 需显式兼容导出工具或重登录，不能假定 Rust 能解密 | Android Keystore 包装密钥；备份恢复/设备迁移后失效明确提示；凭据不经 JS 或日志 |
| [versions](../src/main/versions.ts)、[loaders](../src/main/loaders.ts)、[downloader](../src/main/downloader.ts)、[mirror](../src/main/mirror.ts) | 元数据合并、规则、镜像、校验、去重、资源/本机库下载，Node fs/path/crypto | 业务算法先保留，文件/网络适配；Rust 渐进替换需共享黄金输入输出样本 | 清单和依赖算法可复用；下载的 LWJGL/native 不能仍选桌面 linux classifiers，需 Android 运行器的替代库/ABI 策略 |
| [java](../src/main/java.ts#L409)、[Forge](../src/main/forge.ts#L163) | Java 检测 `execFile`；JRE 下载解压；Forge/NeoForge Java 安装器子进程、取消、2 分钟无输出与 10 分钟总超时 | 受控进程服务，平台/架构、可执行校验与子树清理保留；安装器与原版并行依赖排序保留 | 桌面 JRE 不能直接执行；需 Bionic/ABI 匹配 JVM、安装器兼容验证，见第 5 节 |
| [launcher](../src/main/launcher.ts#L65)、[launch handler](../src/main/handlers/launch.ts#L75) | 参数占位、认证、预下载、Java 优先级、隔离、QuickPlay、spawn/PID/log；隐藏 BrowserWindow 量装饰 | 启动配置与 OS 进程/屏幕适配分离；Rust/sidecar 管进程树；日志必须脱敏 | 需要 JVM+JNI+Surface/GL+输入/音频，不是普通 Process；PID 不是完整的成功标准 |
| [mods handler](../src/main/handlers/mods.ts#L43)、[modrinth](../src/main/modrinth.ts)、[curseforge](../src/main/curseforge.ts)、[mcmod](../src/main/mcmod.ts) | 多源搜索、详情、依赖、译名、兼容版本、CF 分发限制、Fabric API/离线汉化 | 可移植 HTTP/解析先保留；完整目标实例/加载器绑定、依赖确认/任务取消继续保留 | 安装/搜索可移植不代表所有模组能在移动 GL/JVM 上运行；按具体 MC/loader/mod/native 验证，不承诺全模组兼容 |
| [manage](../src/main/manage.ts)、[resources](../src/main/resources.ts)、[resource-updates](../src/main/resource-updates.ts)、[installed](../src/main/installed.ts) | mods 启停、存档、投影、资源包/光影、servers.dat NBT、后台元数据与升级 | 受限文件能力与实例任务锁；保留未知 NBT、启停状态、导入部分失败明细 | 运行目录建议内部可寻址文件系统；SAF 导入导出事务化，不假设 URI 支持 mmap/原子 rename/随机写 |
| [archive](../src/main/archive.ts)、[modpack](../src/main/modpack.ts)、[import-version](../src/main/import-version.ts) | ZIP/整合包探测、下载导入导出、外部版本冲突策略、可执行权限 | 保留越界/链接/大小保护与取消/回滚；迁 Rust 时不以解压成功等于版本可启动 | 文档流落内部 staging；拒 zip-slip/解压炸弹；导出的完整实例不保证 Android 可运行 |
| [native-downloader](../src/main/native-downloader.ts#L112) | napi `.node` 动态加载；实际状态与 TS fallback；Rust 扫描器增强 | Node 过渡须重编目标 Node/N-API 并验证依赖；Rust 直接调用应拆 core crate，不能 dlopen `.node` 当 Rust API | Android 需 Android target/NDK 编译核心并 JNI/Rust FFI；缺产物明确回退，不把 Linux `.node` 复制过去 |
| [files handler](../src/main/handlers/files.ts#L19)、[files](../src/main/files.ts) | Electron shell/dialog、用户可手输路径、文本编辑/删除 | 原生 picker/opener + 受限根/句柄，不给网页任意 fs；根、链接、覆盖确认检查后端化 | SAF content URI 与持久授权；系统打开用 MIME/FileProvider/Intent，撤销权限可恢复报错 |
| [wallpaper](../src/main/wallpaper.ts#L47)、[settings handler](../src/main/handlers/settings.ts#L12) | dialog/nativeImage、8 MiB 重编码/2560 边、GIF 32 MiB、窗口底色/托盘/浮层同步 | Rust 图像/选择器或受限浏览器解码；保持动图与副作用；显示器逻辑像素与物理像素明确 | URI 图片复制私有目录；Insets/密度/旋转/软键盘；色彩、内存预算与 GIF 帧兼容实测 |
| [hardware-accel](../src/main/hardware-accel.ts#L20)、[app 初始化](../src/main/app.ts#L1377) | Electron Chromium 开关、V8 参数与 app ready 前设置 | 按 WebView2/WebKitGTK/WKWebView 做能力报告；旧硬件加速开关不能照搬 Chromium switches | Android WebView/Surface/游戏 GL 分层；不能以启动器 GPU 开关替代游戏渲染器选择 |
| [homepage](../src/main/homepage.ts#L15)、[analyzer](../src/main/homepage-analyzer.ts)、[安全桥](../src/renderer/src/pages/customhome/security.ts#L41) | HTML 仓库/市场/投稿/hash 授权、静态扫描、iframe CSP、postMessage 白名单 | 只复用受信任顶层的兼容桥，保留 opaque-origin sandbox；Tauri capabilities 不得授权第三方 iframe；不能把静态扫描称为完备沙箱 | Android WebView 下 CSP/自定义协议/消息源逐项验证；不降低隔离换可用性 |
| [AI client](../src/main/ai/client.ts#L14)、[service](../src/main/ai/service.ts#L13)、[tools](../src/main/ai/tools.ts) | Electron net.fetch、app 版本信息；5 聊天协议、工具批准/取消、诊断；STT 仅 OpenAI/custom | HTTP 与 AppInfo 注入；工具风险策略留宿主；不把对话工具变成任意 shell | 录音权限+WebView/Kotlin codec 回退；云 STT 保留；Ollama/custom 的本机地址不代表 Android 本机有服务 |
| [AI ball](../src/main/ai/ball.ts#L69)、[HUD](../src/main/app.ts#L718) | 透明置顶多窗、工作区夹位、鼠标穿透、全局热键、TTS/MediaRecorder | 桌面窗口标签/作用域、焦点/游戏全屏/Wayland 实测；不承诺所有合成器等效 | 默认应用内 AI 面板/游戏内 native UI；跨应用悬浮需要特别授权与服务，桌面穿透语义不等价 |
| [multiplayer](../src/main/multiplayer/index.ts#L53)、[easytier](../src/main/multiplayer/easytier.ts)、[LAN bridge](../src/main/multiplayer/lan-bridge.ts) | 组网 core/cli 子进程、信令/聊天、TCP/UDP 本地转发、LAN 注入；no-tun | TS 网络逻辑先保留；原生资源定位、进程/socket 生命周期迁宿主；真实双机验收 | 无桌面 core/cli 自动支持；要移植 Android ABI、前台服务、组播/网络切换；若选 VPN 路线需 VpnService 用户同意，no-tun 路线不能伪称 VPN 已实现 |
| [资源自检](../src/main/multiplayer/resources.ts#L77) | 当前仅检查文件存在，corrupted 恒为空，复制按大小判断 | 迁移时补签名/哈希+ABI 清单与可信分发；不能把旧 ready 显示升级为已验证二进制 | 未有 Android 内核和许可/构建证据前返回不可用，不放占位可执行文件 |
| [netease/SMTC](../src/main/netease/smtc.ts#L231)、[歌词服务](../src/main/netease/service.ts)、[时间轴](../src/main/netease/timeline.ts) | Windows PowerShell/WinRT 采样、网易云歌词匹配、估算/校准、HUD 快照 | Windows 可暂留固定脚本或改 Rust WinRT；非 Windows 不能声明原生对齐 | 没有 SMTC；跨应用媒体读取需 Android MediaSession/通知监听等合法授权及播放器发布数据，缺时间轴不能伪造精确同步 |
| [feedback](../src/main/feedback.ts)、[devmode](../src/main/devmode.ts)、[debug-report](../src/main/debug-report.ts#L12)、[logger](../src/main/logger.ts#L1) | shell 打开附件、AppInfo/数据目录、环形日志、邮箱会话/开发授权/到期；旧 logger/debug report 未提供统一脱敏保证 | 保留会话、TTL、限额、附件权限、显式日志提交；DevTools 改宿主调试能力 | 分享/保存附件走 URI；开发检查器与桌面 Chromium DevTools 不等价；生产构建不开放任意调试 |
| [server](../src/main/server.ts#L5)、[update-resolve](../src/main/update-resolve.ts) | app/platform 身份、PHP JSON、下载和外部替换脚本、spawn 更新器 | Tauri 独立 product/target/签名产物；重做便携/安装身份；不误装 Electron 或 Lite 更新 | APK/商店/系统安装器签名流程；不能覆盖运行中应用或执行桌面安装包 |

没有直接 Electron import 的模块也未必可放到浏览器：fs/path/os/crypto、Node streams、zlib、net/dgram、child_process、Buffer、`.node` 与本地权限仍需保留在 sidecar 或移植到 Rust。把所有 TS bundle 进 React 不构成迁移。

### 3.1 已确认、应在迁移中纠正的现有平台假设

- [Java 下载](../src/main/java.ts#L415) 仍把非 Windows 都选 `linux`，只分 arm64/x64；[launcher 的 OS 常量](../src/main/launcher.ts#L8) 同样按 Windows/其余二分；[发布 target](../src/main/server.ts#L32) 把 macOS 归成 linux。迁移必须使用显式目标表，不把现有缺陷封装成新的“跨平台支持”。
- [启动器日志](../src/main/launcher.ts#L179) 会打印拼接后的完整启动命令；构建命令中含认证占位。迁移日志需要按参数名脱敏，不能原样复刻成泄密接口。
- [媒体权限](../src/main/app.ts#L1459) 的注释还提及已移除联机语音，代码实际上对所有请求 `media` 放行。新宿主要按受信任窗口、来源、实际音频权限及用户动作授权，不复制全局放行。
- [联机 IPC 的管理员注释](../src/main/multiplayer/index.ts#L63) 与 [no-tun 资源说明](../src/main/multiplayer/resources.ts#L16) 不一致；权限判断需以实际运行模式为准，不向所有平台索要管理员/root。

## 4. 桌面 Node 过渡与 Rust 迁移取舍

| 决策项 | Tauri + 独立 Node sidecar 过渡 | Rust 原生业务迁移 |
| --- | --- | --- |
| 功能保留 | 可复用现有认证/下载/版本/整合包/联机/AI 编排，回归面较小；仍须去 Electron import | 一次性重写多域风险大；需与旧逻辑逐项比较，而非只做同名 command |
| 体积/内存 | 仍携带 Node，保留 JS 堆和业务进程；不应承诺“Tauri 一换立刻极小” | 可减少 Node 运行时；最终数据以实际产物/进程测量为准 |
| 平台 | 桌面每个 OS/架构需打包 Node 与原生依赖；macOS 签名/公证、Windows 动态库、Linux glibc 要验证 | Rust core 可编 Android，但 JNI/系统权限/游戏渲染仍是平台工作 |
| 原生下载器 | N-API 版本/Node ABI/目标依赖需重编验证，不能沿用 Electron `.node` 文件作为证明 | 抽 downloader/scanner 纯 Rust core，桥由桌面与 Android 共用，需拆 crate/接口 |
| 安全 | Rust 验证 command 后转白名单；私有管道不暴露网络服务；Node 权限大且要独立约束 | 统一权限/路径/凭据服务可减少双层边界；仍需防任意 URL/路径/进程参数 |
| 生命周期 | 需要一套 task/event 协议、父子退出、取消、崩溃恢复和日志分流 | 原生异步任务更集中，但不能丢失原 dedup/abort/错误语义 |
| Android | 不采用桌面 shell/Node sidecar 路线作为默认方案；官方 Shell 移动端仅提供 URL 打开 | 已写 Keystore/SAF Rust-Kotlin 插件与部分共享 Rust 业务；JNI 游戏后端/JVM/Surface/输入尚未实现，且没有 APK 验证 |

当前已落地的分层是 React → 兼容 LauncherApi → Rust 能力/窗口/任务路由 → Rust 域模块；桌面 Node adapter 仅为保留业务的备选过渡，不是已安装的执行依赖。后续仍建议把 AppInfo、DataPaths、Dialogs、Credentials、NetworkTransport、NativeDownloader、ProcessRunner、GameRuntime、WindowHost、EventSink、Clock/TaskRegistry 作为显式依赖，避免 TS 业务到处检测 Electron。过渡 sidecar 使用固定绝对入口和受控环境，不读取用户传来的 JS/命令路径，不启动带公开端口的通用 API server；若以后确实选 loopback，仍须随机凭据/来源校验且不开放任意本机网页访问。

迁 Rust 的建议顺序是：先数据/网络与校验基础、账号和凭据、下载/版本/资源与归档，再启动/加载器/联机/AI 等复杂状态机。每域完成须满足附录入口与事件等价、失败/取消与本地模式等价，并在该目标平台实测后才能切换默认实现。不能删除旧实现后用未完成 stub 补齐 API 数量。

## 5. Android 是独立游戏运行适配工程

### 5.1 Java 与图形/输入的真实缺口

当前 [Java 检测/下载](../src/main/java.ts#L409) 得到的是桌面可执行文件路径；[spawnGame](../src/main/launcher.ts#L179) 依赖桌面 JVM、LWJGL 本机库、独立窗口与进程 stdout/exit。Android 系统的 ART/Kotlin/Java 应用运行环境不等于可直接执行 Minecraft 桌面 JAR 的 Java SE JVM；系统 WebView 能运行 React 也不表示能运行 Java Edition。

必须单独实现并验证以下链路，完成前 `launch.start` 要返回稳定的 `unsupported`/`runtime_not_ready`，不能返回占位 PID：

| 工作包 | 迁移计划 | 验收必须看到的事实 |
| --- | --- | --- |
| Android JVM 与 ABI | 选择可合法分发、适配 Bionic/Android ABI 的 OpenJDK/JVM，支持所需 Java 8/17/21；核验 JNI、动态链接、路径编码、证书、压缩与 native lookup | 每 ABI 真机打印版本并执行受控 Java；类版本/GC/内存/agent 支持由实际运行器报告；不能用桌面 linux glibc JRE 代替 |
| 游戏加载 | Kotlin/NDK/JNI 启动适配；可考虑独立 Android 游戏进程/Service 隔离崩溃；传递经验证的启动配置、文件与日志句柄 | 首次安装→依赖校验→真实 Java Edition 菜单/世界；开始/失败/退出/停止不依赖 WebView 存活；无假 PID/假 running |
| LWJGL/GLFW 与显示 | 替换或桥接桌面 GLFW/LWJGL 到 Android NativeWindow/Surface/EGL；选择适用 GL/EGL 或 Vulkan 转译方案，GL4ES/Zink 等只是候选，需许可/驱动/版本评估 | 指定 GPU/系统/MC/加载器组合的可重复画面；Surface 重建、旋转、上下文丢失、帧同步与分辨率不黑屏；WebView canvas 不是游戏 Surface |
| 本机库/音频 | 为每个 Android ABI 提供所需 JNI/LWJGL/OpenAL 等适配库；避免桌面 ALSA/X11/glibc 依赖 | 实际加载成功，音频输出/设备切换/暂停恢复正常；缺库给可读错误，不忽略崩溃 |
| 输入 | 触摸布局、多指、鼠标相对移动/捕获、键盘、手柄、IME、软键盘、返回键、剪贴板与焦点桥 | 游戏内移动/视角/背包/聊天/中文输入可操作；触控不能只映射成网页点击；冲突与按键释放不粘键 |
| Forge/NeoForge 与 mod | 安装器 headless/AWT/Java/processor 与游戏 runtime 分离；Fabric/Quilt profile 可复用解析但 native mod 另验 | 先原版，再代表性 Fabric/Forge/NeoForge 实例；失败可恢复且存档保留；不能从“JAR 已下载”推导“模组兼容” |
| 认证与 authlib | 设备码/刷新可移植；第三方 injector 与 JVM agent 能力需匹配运行器 | 真账号登录/过期刷新/取消、第三方多角色与皮肤、隐私日志；不可绕过正版许可/认证 |
| 生命周期/内存 | Activity 前后台、前台服务通知、进程被回收、热限制、低内存、音频焦点、锁屏、旋转状态机 | 后台/恢复/系统杀进程后任务如实终止或恢复；设置中的 memoryMb 受设备实际预算限制；不保证后台永驻 |

Android 对应用私有可写目录中下载并执行代码有现代安全限制，安装/分发方式和目标 SDK 也影响 native 加载；不能设计成“下载任意 ELF，chmod 后运行”。实际打包的 JNI/libjvm/native 库、下载运行时数据的界限、APK 签名和目标 SDK 必须由 Android 原型验证。当前已有 [Android MainActivity 源码](../src-tauri/gen/android/app/src/main/java/top/johnnyblog/hcmcl/MainActivity.kt#L1) 与第 2.2 节的两个插件，不再是“没有 Android 工程”；但**没有 APK/NDK 游戏运行器产物、GPU 运行证据或真实安装器日志**，因此本节 JVM/GL/输入等游戏工作包仍未完成。

### 5.2 文件、窗口、网络与媒体差异

| 现有语义 | Android 迁移计划/限制 | 验收标准 |
| --- | --- | --- |
| 任意绝对目录、拖入 File→OS path、多版本根 | 使用应用私有游戏目录及 SAF 文档树/文件令牌；外部 URI 经 ContentResolver 流式导入 staging，存可持久授权而非猜 `/storage/...` 路径 | 授权/拒绝/撤销/移动文档/重启后权限都可控；Zip/文本/账号导入不越权；不得读其他应用私有目录 |
| rename/覆盖/删除/归档随机访问 | 对内部 fs 走安全事务；文档提供者可能不支持原子 rename、seek、锁，须复制/验证/提交并明确失败 | 无破坏性 fallback；中断不吞旧文件；导出失败可重试，空间不足真实反馈 |
| 系统打开文件/外链 | 外链用 Intent；文件分享使用 URI、MIME、临时读权限，不能发送 `file://` | 可选应用打开、取消与无处理器提示；令牌不出现在 URL/日志 |
| BrowserWindow/多浮窗/托盘/全局热键/鼠标穿透 | 主 Activity 内导航/分屏与应用内卡片；系统悬浮层另需特殊权限和可见服务；托盘/最大化等桌面语义返回明确限制 | 不显示有效但无动作的开关；返回键/系统手势/安全区域不被强制全屏抢占；不绕过用户退出 |
| display.primary 工作区 DIP/窗口装饰探针 | 使用 WindowMetrics、density、Insets、方向与软键盘信息，游戏渲染像素独立 | 横竖屏、挖孔/导航条/IME 与触控坐标匹配；不能套 Electron 的隐藏窗口装饰尺寸 |
| Windows SMTC/PowerShell 歌词 | Android 无 SMTC；需媒体会话/通知监听等受控原生能力，依赖用户授权和播放器提供信息 | 没权限/没时间轴/暂停/切歌必须明示；不把估算称为准确；Linux/macOS 当前也不能声称已有该 Windows 功能 |
| AI MediaRecorder/WebM、speechSynthesis、全局录音热键 | 前台录音先验证 WebView codec；必要时 Kotlin AudioRecord/MediaRecorder/TTS 插件；后台录音有额外限制 | 运行时麦克风授权、取消释放、来电/耳机/后台清理、STT 仅支持的格式、TTS 不可用可用文字 |
| EasyTier core/cli 与 TCP/UDP LAN | Android native 集成或受控 ABI 进程/库方案；前台 Service、组播、Wi-Fi/蜂窝切换、NAT；VPN 与 no-tun 分开设计 | 至少两台真实设备/桌面互联，世界可连接、消息送达、退房停止资源；可见成员不等于游戏连通 |
| 原生下载器与后台任务 | Rust Android core + OS 生命周期管理；任务持久化与校验后恢复，权限失效停止 | 熄屏/网络变更/磁盘不足/取消/重启数据一致，不伪报百分比和完成 |
| 更新、自替换与重启 | 桌面 Tauri 签名更新独立；Android 走受信任 APK/系统安装器或商店策略，用户批准，不能执行 EXE/AppImage/DMG | product/平台/ABI/版本/签名不匹配拒绝；失败不破坏账号/实例；下载不等于安装 |

### 5.3 WebView 差异也要验收

Tauri 不再为所有平台捆同一个 Chromium：Windows WebView2、macOS WKWebView、Linux WebKitGTK、Android System WebView 的版本和支持范围不同。现有皮肤/玻璃、CSS 3D 玩家模型、动画、iframe、Markdown、音频编码、speechSynthesis、`backdrop-filter`、文件选择与网络 CSP 都不能只在 Electron 33 下验证。保留所有外观选择与 reduced-motion/contrast/fallback；不支持的特效可降级，但功能入口与导航位置不能因迁移消失。相关现有实现见 [shared settings](../src/shared/settings.ts)、[renderer store](../src/renderer/src/store.tsx)、[PlayerModel3D](../src/renderer/src/components/PlayerModel3D.tsx)、[样式](../src/renderer/src/index.css)。

## 6. PHP 服务端兼容与产品分流

沿用同一 PHP 服务端，**只对更新、公告、关于做产品/平台分流**。账号、反馈、主页市场/投稿、开发授权、limits、调试提交等业务保持现有协议；不因换宿主创建第二套用户数据或放宽鉴权。[当前远程调用入口](../src/main/server.ts#L20) 是 `server:api`，协议/公告处理见 [network handler](../src/main/handlers/network.ts#L79)。

当前 [Rust 更新查询](../src-tauri/src/services.rs#L772) 已采用 **`runtime=tauri-v2` + 精确 `target`**，不是旧稿建议但尚未落实的 `product=hcmcl-tauri`。选择器只接受 [tauriArtifacts](../src-tauri/src/services.rs#L761) 中 runtime/OS-ABI/包类型匹配、具有 HTTPS URL、SHA256 和大小的产物；不回退 Electron installerUrl 或 Lite 包。关于/公告仍复用现有 PHP action，所需产品内容分流应单独核对 PHP 部署，不能从客户端字段推定服务端已部署。Android 需要自身 APK/商店元信息，不能匹配桌面下载。

当前 [更新下载/交接](../src-tauri/src/services.rs#L854) 会重新选择可信产物、校验 SHA256/大小并缓存；`downloadAndRun` 仅在支持的桌面包类型上交给系统，不保证安装完成，Android APK 安装交接仍明确不支持。**尚未实现 Tauri updater 签名验证与完整安装回滚链路**。若后续使用 updater，PHP 必须提供其版本、URL 与签名，密钥由发布流程管理，不拿 SHA256 或 EXE 地址冒充签名；同时保留 important/prerelease/notes。公告/关于的条目可按产品/平台查询，协议仍须遵守已有同意指纹与离线判断，不能顺手改变其他端点的权限/数据隔离。

本次未读取或修改私有 PHP 配置，也未访问生产账号接口；这一节是与源调用点对齐的迁移约束，不是服务端完成声明。

## 7. 分阶段交付与接受标准

| 阶段 | 尚待交付 | 接受标准；未达到不能宣称完成 |
| --- | --- | --- |
| A：协议冻结 | 全 239 成员 DTO/权限/事件契约、能力表、受信任窗口标签 | 附录零漏项；非法方法/参数/来源拒绝；取消与卸载无泄漏；无任意 shell/fs |
| B：桌面宿主闭合 | React/Tauri/Rust 壳、资源另存、Minecraft 查询、账号导入三通道、modpack 六分支受控下载/探测/清单/三格式内部导出/导入、只读 `system:hardware` 五字段快照及桌面 `java:install` 已有源码；壁纸三通道、外部版本两通道、servers.dat 一通道、`manage:openDir`、`resources:open`、`download:engine` 与 `resources:checkUpdates/applyUpdate` 已有分发；资源应用的 Windows/Linux 本地 Rust 全量测试为 639/661 项通过，Android 三目标仅 Rust cfg 检查通过，真实 GUI/公网/设备尚未验；debug 五条 invoke 已有受限桌面窗/缓冲/主动诊断上传源码，最终 Windows/Linux 656/678 项测试通过，前批 Android r2 仅 Rust cfg；Round4 公共 API 已有本地 dialog 日志页，裸移动 IPC 仍拒绝，本轮 Windows/Linux 657/679 项通过且三 Android target 仅 Rust cfg；仍无通用游戏日志 sink、真实 GUI/HTTP 验收，轻量 Hooks/DOM UI 16/0 仅局部验证。本批已接桌面模式两通道和开发授权六通道，仍有 64 个余项（4 Tools 明确 Err +60 未接业务处理）；Task96 最终 Windows 串行 709/0/0、Linux clean 733/0/0 与三目标 Android clean Rust cfg 已收集，真实服务/GUI/设备仍未验，不以旧缓存或历史结果替代当前证据，另补平台限制、配置/凭据兼容、任务生命周期和真实环境验收；Node 仅备选 | 所有桌面域保留完整入口；三平台目标分别构建；真实登录/刷新、原版/四 loader、导入导出、联机、AI/语音/浮层实测；体积/内存只报测量值 |
| C：Rust 按域替换 | core DTO、HTTP/下载/文件/认证/资源/安装状态机迁移 | 每域黄金样本与本地夹具通过，再做真实环境；断网/取消/崩溃/文件冲突保持数据；不以同名空实现通过清单 |
| D：Android 最小游戏链路 | Kotlin/JNI runtime、Android JVM/GL/音频/输入/SAF | 指定真机/ABI/Android/MC 原版实际画面、能进世界/输入/退出，生命周期恢复/日志真实；仅 UI APK 不算完成 |
| E：Android 功能对齐 | 认证、资源/pack/loader、网络、AI/媒体/外观、更新等逐项关闭缺口 | 每个附录 API 有移动实现或清晰平台限制与交互替代；不能把限制改名“已支持”；真实多机/外网/权限拒绝测试 |
| F：发布切换 | Tauri 签名产物、PHP 产品分流、旧 Electron 用户迁移/恢复路径 | 错产品/错架构/错签名拒绝，用户数据备份可恢复；每个平台发布流程可重复；旧端更新策略独立 |

当前优先十项（按真实剩余缺口，而非重新列已写模块）：

1. **P0 Android 游戏可行性**：JVM/ABI/JNI/GL/Surface/输入/音频原型；APK 与真机证据前不承诺可启动 Java Edition。
2. **P0 凭据/SAF 原生验收**：Keystore 同步等待仍需 deadline/失败恢复；SAF 保存能力→官方资源导出→提交/取消宿主已经接线，不能再列“全部未接”。尚需 Kotlin/Gradle/链接/APK 与真机验证锁屏/丢钥匙/撤权、picker/下载/commit 的取消竞态、provider 卡死/空间不足/进程恢复及未知结果 sticky 限制；pack 已有内部归档输出，但 pack/反馈的 SAF/provider 保存交接仍未接。Windows 纯状态/夹具和 Android cargo check 不能替代这些事实。
3. **P1 旧账号与配置实证**：`accounts:importPreview/Commit/Cancel` 已有四字段预览、来源限定验证及 insert-only 保存，不再列为未接。需用真实 PCL/HMCL/官方来源验证临时账号、源 OAuth 刷新参数、令牌轮换、取消/删除竞态与未知 panic 恢复；未知 PCL 生产 Identify 保持 protected。Electron 全配置/加密 blob/路径/选择/目录别名仍需明确兼容或重新登录，不以三通道接管宣称全迁移。
4. **P1 完整安装→启动链**：保留原版/Fabric/Quilt、Forge/NeoForge 安装编排/就地事务及本批 Neo 联合绑定/四项产物提升修正；桌面 `java:install` 现有受控 Adoptium 下载、归档校验与运行时发布源码已接，但 Android/iOS 明确拒绝，且尚未实测真实 JRE 下载/执行。下一步用真实发布 JAR、Java 和指定 MC 验证，而不是继续依赖人工固定源码形状。启动前账号刷新、固定 UUID、Storage 快照 CAS、Ygg 全角色组和启动/停止生命周期已有源码与本地回归；仍缺依赖自动补全及真实账号、QuickPlay/诊断/取消全流程验收。模拟子进程或已有依赖启动均非全链路。
5. **P1 catalog/pack 闭合**：普通线上资源安装仍需补目标 MC/loader/必需依赖/分发限制闭包；Task94 已补齐两条既有安装入口的任务级进度/取消注册、根目录设置复核、官方哈希/大小校验、禁止覆盖与真实写入收尾，Windows/Linux 离线全量测试分别 673/697 通过，三个 Android ABI 仅完成 Rust cfg 检查（aarch64 87s、i686 38s、x86_64 39s）；外层 IPC 丢弃仍按既有生命周期 Gate 将状态置为 `uncertain`，后台收尾不会自动恢复重启，因此不能把它写成完整取消/重启闭环；这些结果不等于真实公网、Java/Minecraft 或 Android APK/设备验收。Task95 又以冻结的窗口模式状态机接入 `window:setDesktopMode`/`window:securityFullscreen`：Windows 695/0、Linux 719/0 的 clean 全量 Rust 测试通过，新增 22 组 FakeWindow/门禁夹具随桌面测试执行；aarch64/i686/x86_64 Android Rust cfg 分别 2m46s/1m16s/56.74s 结束。真实任务栏、Alt+Tab、窗口管理器全屏/焦点和 Android 真机仍未验，安全全屏的 `set_focus` 也不等同 Electron `moveTop`。本批整合包导入已有独立的 plan、远程成员应用和 overrides/materialize 链，不能把这部分再列为未接线。外部版本扫描/冲突导入已有独立 Rust 分发，移动目录树授权仍缺；资源检测与应用事务均有桌面本地Rust夹具通过，公网/GUI仍未验；应用复用 `download:progress`，`resources:updated` 仍无生产者；modpack 六分支已有 Rust 分发；受控 download→opaque 能力→probe、只读 inventory、三格式内部 export、picker/URL→owned Input→隔离 Stage 导入已接，但本地流摘要、缓存/reader 预算、source 句柄/无覆盖、生成器回执及 owned worker 夹具不等于官方包信任、真实公网 URL→Claim→Input、跨平台发布、Android SAF/provider 交接或游戏安装启动。仍需验证公网/DNS 重定向、过期/关闭/崩溃残留、取消与真实文件系统；桌面/SAF 官方资源另存仍需三平台 picker、真实下载与 provider 验收。
6. **P1 Tauri 更新发布**：签名校验、安装/回滚/重启与 Android APK/商店交接，精确 runtime/target；PHP 更新/公告/关于内容分流需部署核验，不误装其他产品。
7. **P1 EasyTier 全域**：32 个调用与对应事件、可信二进制/ABI/许可、TCP/UDP/LAN、退出清理、至少两台真实设备联机；成员列表不等于游戏连通。
8. **P1 主页与开发模式**：18 个主页调用、HTML/hash/CSP/来源授权/完整 SDK仍有缺口，第三方 iframe 不获原生能力，失败可回内置主页。开发授权六通道已有 Rust 业务分发和脱敏状态事件；四个 Tools 明确未实现 Err。仍需真实 PHP/邮箱授权、撤销/到期、设备网络与 worker 全流程验收，不把 helper 和模拟提交夹具称为完整 Tauri/Storage/HTTP E2E。
9. **P1 AI/媒体与多窗**：现有五协议工具批准/执行/取消与 STT 后端需做真实供应商/动作/音频验证；补球窗/HUD、Android 麦克风/codec、TTS、mini/弹幕/托盘/热键/歌词和本批仍无生产者的 12 个事件。`ai:launchRequest` 要看主界面真实启动，不把请求发送视为游戏运行。
10. **P2 全功能与发布验收**：反馈附件浏览器交接已有 Rust 分发及合成会话/后台调用夹具，仍需真实系统浏览器、Android Intent 与线上旧服务兼容验收；debug 已有受限桌面窗口、有界脱敏缓冲和主动上传源码及离线夹具，移动应用内日志页已由公共 API 的本地 dialog 宿主承接；仍需通用 Rust 游戏/安装器 stdout/stderr sink，以及真实 GUI/设备焦点、硬件 Back、viewport、上传/撤回与额度不确定性验收；本轮控制器 11/0、宿主及联动 23/0 和前批 task91 16/0 均只覆盖离线模型；known patterns 不保证任意秘密。另补完整外观副作用和真实硬件能力；壁纸选择/清除/data 三通道已有分发与前批 Windows 图片/CAS/生命周期夹具，仍需 Linux 回归、真实 picker/Android provider 和外观联动验收；`system:hardware` 只读五字段已有 Rust 分发及 Windows/Linux 宿主采样，不再列为未接，但型号/年份/VM 启发式不能替代 GPU 能力、macOS 原生采样或 Android 真机验证。Windows/macOS/Linux WebView 与 Android 真机分项验收，再给出实际包体/内存与发布结论。

## 8. 外部能力依据与验证边界

本次已读取的官方资料：

- [Tauri sidecar](https://v2.tauri.app/develop/sidecar/)：外部二进制按 target triple 打包，权限/参数必须配置；不是 Node 默认存在。
- [Tauri Shell](https://v2.tauri.app/plugin/shell/)：Android/iOS 只允许 `open` URL，不能据此声称移动子进程/Node/Java 已支持。
- [Tauri File System](https://v2.tauri.app/plugin/file-system/)：移动端默认限制应用目录；资料中的旧 external-storage permission 示例不等价于现代 Android 任意共享目录授权，仍需 SAF/目标 SDK 实测。
- [Tauri updater](https://v2.tauri.app/plugin/updater/)：更新要求签名，签名不可关闭；实际目标支持与锁定插件版本仍需构建核实。页面纯文本表格丢失支持图标，本文不据空白表格推断 Android 安装支持。
- [Tauri global shortcut](https://v2.tauri.app/plugin/global-shortcut/)：插件权限为显式开放；本文不从纯文本表格空白推断 Android 全局快捷键存在。

Android 官方 [SAF 文档](https://developer.android.com/training/data-storage/shared/documents-files) 与 [Android 10 行为变化](https://developer.android.com/about/versions/10/behavior-changes-10) 在本次抓取时超时，未把抓取失败伪装成已核实文段。文中的 Android 设计限制需在所选 target SDK、原生插件版本和真机上复核；尤其执行/动态加载规则、前台服务、通知/媒体会话权限与发布商店政策。外部资料是技术参考，不替代本仓库源码，也不是本次已实现的证据。

## 9. preload 全部 API 与事件逐项矩阵

以下保留初稿按 TypeScript AST 枚举并校对的 **239 成员 Electron 契约基线**，不删账号导入、四 loader、AI、联机或歌词。契约行本身保持原文与基线哈希；本轮 `app:relaunch` 的实现状态和验证证据写在矩阵说明与第 2.3 节，不改写这条成员基线。每行“现有源码”仍指 Electron；“桌面目标/验收要求”和“Android 限制/验收”是必须满足的目标，**不是当前 Tauri 完成状态**；本批桌面与含 Android cfg 并集均为 **148 显式接管 / 64 余项（4 Tools 明确 Err +60 未接业务处理）**，事件为 **11 有生产者 / 12 未读到生产者**，见第 2.1 节。前批补计既有 debug 五项中的四个新增静态分支，getLogs 从组合根迁入不重复计数；前批 Round4 仅补移动公共 API 的本地 dialog 视图；本批窗口模式两通道与开发授权六通道也均来自既有白名单，不增加 IPC 或契约成员，原合同资源应用分发与事务路径按前批保留。debug:log 仍是既有事件，应用复用 `download:progress`，未新增事件，`resources:updated` 仍无生产者。前批 Windows/Linux 本地 Rust 测试及 Android 三目标 Rust cfg 结果保留历史；当前 Task96 最终 Windows 串行 709/0/0、Linux clean 733/0/0 与逐 target clean Android Rust cfg 均已收集，不能沿用旧缓存结果；其证据范围与历史失败见第 2.3 节。真实公网/GUI 和 Android 运行栈未验。前批壁纸 3、外部版本 2、servers.dat 1 及既有 `modpack:download/import/importFromUrl`、`system:hardware` 继续保留，不增加契约成员；modpack 六分支均已有 Rust 分发，下载/导入不等于安装。桌面/Android 同名导出、既有保存通道与就地参数不重复加数；统计不是完成率。`I`=invoke，`S`=send，`E`=订阅返回 unsubscribe，`L`=本地成员。形参和返回 DTO 以 [shared/types](../src/shared/types.ts) 为准；事件生产者基线链接也不等于已存在 Rust 生产者。


### 9.1 app

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `platform` | L process.platform；[preload:50](../src/preload/index.ts#L50) | 平台/能力快照；保留同步读取兼容层 | 显式 android 值，不归入 linux |
| `getVersion()` | I `app:version`；[preload:51](../src/preload/index.ts#L51)；[实现:63](../src/main/handlers/settings.ts#L63) | AppInfo/生命周期原生 command | Activity 生命周期；硬件加速不是桌面 Chromium 开关 |
| `hardwareAccelerationBooted()` | I `app:hardwareAccelerationBooted`；[preload:52](../src/preload/index.ts#L52)；[实现:1368](../src/main/app.ts#L1368) | 按 WebView 引擎报告实际能力，非复制 Electron switch | WebView 与游戏 GL 分开，不能伪报旧开关有效 |
| `relaunch()` | I `app:relaunch`；[preload:53](../src/preload/index.ts#L53)；[实现:1369](../src/main/app.ts#L1369) | AppInfo/生命周期原生 command | Activity 生命周期；硬件加速不是桌面 Chromium 开关 |

### 9.2 debug

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `debug.getLogs()` | I `debug:getLogs`；[preload:55](../src/preload/index.ts#L55)；[实现:20](../src/main/handlers/debug.ts#L20) | 脱敏日志服务；日志窗由 WindowHost 创建 | 应用内日志页/分享；不提供桌面独立 DevTools |
| `debug.onLog(cb)` | E `debug:log`；[preload:56](../src/preload/index.ts#L56)；[实现:491](../src/main/app.ts#L491) | 事件路由/订阅取消；负载 DebugLogEntry；脱敏日志服务；日志窗由 WindowHost 创建 | 应用内日志页/分享；不提供桌面独立 DevTools |
| `debug.openWindow()` | I `debug:open`；[preload:57](../src/preload/index.ts#L57)；[实现:21](../src/main/handlers/debug.ts#L21) | 脱敏日志服务；日志窗由 WindowHost 创建 | 应用内日志页/分享；不提供桌面独立 DevTools |
| `debug.closeWindow()` | I `debug:close`；[preload:58](../src/preload/index.ts#L58)；[实现:24](../src/main/handlers/debug.ts#L24) | 脱敏日志服务；日志窗由 WindowHost 创建 | 应用内日志页/分享；不提供桌面独立 DevTools |
| `debug.isEnabled()` | I `debug:isEnabled`；[preload:59](../src/preload/index.ts#L59)；[实现:27](../src/main/handlers/debug.ts#L27) | 脱敏日志服务；日志窗由 WindowHost 创建 | 应用内日志页/分享；不提供桌面独立 DevTools |
| `debug.submitLogs(key: string)` | I `debug:submit`；[preload:60](../src/preload/index.ts#L60)；[实现:29](../src/main/handlers/debug.ts#L29) | 脱敏日志服务；日志窗由 WindowHost 创建 | 应用内日志页/分享；不提供桌面独立 DevTools |
| `debug.reportLog(level: DebugLogEntry['level'], message: string)` | S `debug:rendererLog`；[preload:61](../src/preload/index.ts#L61)；[实现:31](../src/main/handlers/debug.ts#L31) | 单向脱敏/限流日志 command；不可拼接协议 stdout | 同样限制长度/敏感字段，应用内诊断 |

### 9.3 auth

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `auth.begin()` | I `auth:begin`；[preload:65](../src/preload/index.ts#L65)；[实现:11](../src/main/handlers/auth.ts#L11) | 受控认证会话与网络；按 owner 取消 | 设备码协议可迁；浏览器/Keystore/后台恢复待实现 |
| `auth.cancel()` | I `auth:cancel`；[preload:66](../src/preload/index.ts#L66)；[实现:20](../src/main/handlers/auth.ts#L20) | 受控认证会话与网络；按 owner 取消 | 设备码协议可迁；浏览器/Keystore/后台恢复待实现 |
| `auth.refresh(account: MinecraftAccount)` | I `auth:refresh`；[preload:67](../src/preload/index.ts#L67)；[实现:24](../src/main/handlers/auth.ts#L24) | 后端按账号 ID/类型读凭据，保留 MS/Ygg 分派 | Keystore+网络；不把完整令牌往返 JS |
| `auth.onStatus(cb)` | E `auth:status`；[preload:68](../src/preload/index.ts#L68)；[实现:17](../src/main/handlers/auth.ts#L17) | 事件路由/订阅取消；负载 AuthStatus；受控认证会话与网络；按 owner 取消 | 设备码协议可迁；浏览器/Keystore/后台恢复待实现 |

### 9.4 accounts

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `accounts.list()` | I `accounts:list`；[preload:71](../src/preload/index.ts#L71)；[实现:28](../src/main/handlers/accounts.ts#L28) | 账号仓库/导入会话与凭据服务 | 私有账号仓库；外部导入经 SAF；无 Windows 注册表 |
| `accounts.selected()` | I `accounts:selected`；[preload:72](../src/preload/index.ts#L72)；[实现:29](../src/main/handlers/accounts.ts#L29) | 账号仓库/导入会话与凭据服务 | 私有账号仓库；外部导入经 SAF；无 Windows 注册表 |
| `accounts.refreshSiteNames()` | I `accounts:refreshSiteNames`；[preload:73](../src/preload/index.ts#L73)；[实现:31](../src/main/handlers/accounts.ts#L31) | 账号仓库/导入会话与凭据服务 | 私有账号仓库；外部导入经 SAF；无 Windows 注册表 |
| `accounts.remove(id: string)` | I `accounts:remove`；[preload:74](../src/preload/index.ts#L74)；[实现:42](../src/main/handlers/accounts.ts#L42) | 账号仓库/导入会话与凭据服务 | 私有账号仓库；外部导入经 SAF；无 Windows 注册表 |
| `accounts.select(id: string)` | I `accounts:select`；[preload:75](../src/preload/index.ts#L75)；[实现:43](../src/main/handlers/accounts.ts#L43) | 账号仓库/导入会话与凭据服务 | 私有账号仓库；外部导入经 SAF；无 Windows 注册表 |
| `accounts.addOffline(name: string)` | I `accounts:addOffline`；[preload:76](../src/preload/index.ts#L76)；[实现:44](../src/main/handlers/accounts.ts#L44) | 账号仓库/导入会话与凭据服务 | 私有账号仓库；外部导入经 SAF；无 Windows 注册表 |
| `accounts.previewImport(source, local)` | I `accounts:importPreview`；[preload:77](../src/preload/index.ts#L77)；[实现:17](../src/main/handlers/accounts.ts#L17) | 宿主 picker+owner/TTL 绑定预览，凭据不出服务 | SAF 多文件导入；local PCL 注册表明确不支持 |
| `accounts.commitImport(sessionId, keys)` | I `accounts:importCommit`；[preload:78](../src/preload/index.ts#L78)；[实现:25](../src/main/handlers/accounts.ts#L25) | 校验同 owner 随机引用/TTL/状态再提交 | Keystore 与网络刷新；不能跨应用扫描账号 |
| `accounts.cancelImport(sessionId)` | I `accounts:importCancel`；[preload:79](../src/preload/index.ts#L79)；[实现:26](../src/main/handlers/accounts.ts#L26) | 销毁会话并清除临时凭据；窗口销毁也清理 | Activity/页面销毁清理，不能只关 UI |
| `accounts.addYggdrasil(server: string, email: string, password: string)` | I `accounts:addYggdrasil`；[preload:80](../src/preload/index.ts#L80)；[实现:50](../src/main/handlers/accounts.ts#L50) | 账号仓库/导入会话与凭据服务 | 私有账号仓库；外部导入经 SAF；无 Windows 注册表 |
| `accounts.addYggdrasilProfiles(ids: string[])` | I `accounts:addYggdrasilProfiles`；[preload:82](../src/preload/index.ts#L82)；[实现:58](../src/main/handlers/accounts.ts#L58) | 账号仓库/导入会话与凭据服务 | 私有账号仓库；外部导入经 SAF；无 Windows 注册表 |
| `accounts.yggdrasilSkin(server: string, uuid: string)` | I `yggdrasil:skin`；[preload:84](../src/preload/index.ts#L84)；[实现:65](../src/main/handlers/accounts.ts#L65) | 账号仓库/导入会话与凭据服务 | 私有账号仓库；外部导入经 SAF；无 Windows 注册表 |

### 9.5 versions

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `versions.list(force?: boolean)` | I `versions:list`；[preload:87](../src/preload/index.ts#L87)；[实现:24](../src/main/handlers/versions.ts#L24) | 元数据/版本服务，网络与文件由 adapter 提供 | 安装元数据可迁；native/JVM/实际游戏支持另验 |
| `versions.get(id: string)` | I `versions:get`；[preload:88](../src/preload/index.ts#L88)；[实现:29](../src/main/handlers/versions.ts#L29) | 元数据/版本服务，网络与文件由 adapter 提供 | 安装元数据可迁；native/JVM/实际游戏支持另验 |
| `versions.createVanilla(baseVersion: string, customName: string, dirId?: string)` | I `versions:createVanilla`；[preload:89](../src/preload/index.ts#L89)；[实现:33](../src/main/handlers/versions.ts#L33) | 元数据/版本服务，网络与文件由 adapter 提供 | 安装元数据可迁；native/JVM/实际游戏支持另验 |
| `versions.scanExternal(mcDir: string)` | I `versions:scanExternal`；[preload:91](../src/preload/index.ts#L91)；[实现:38](../src/main/handlers/versions.ts#L38) | 元数据/版本服务，网络与文件由 adapter 提供 | 安装元数据可迁；native/JVM/实际游戏支持另验 |
| `versions.importExternal(mcDir: string, versionId: string, onConflict: ConflictPolicy)` | I `versions:importExternal`；[preload:93](../src/preload/index.ts#L93)；[实现:41](../src/main/handlers/versions.ts#L41) | 元数据/版本服务，网络与文件由 adapter 提供 | 安装元数据可迁；native/JVM/实际游戏支持另验 |

### 9.6 installed

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `installed.list()` | I `installed:list`；[preload:101](../src/preload/index.ts#L101)；[实现:51](../src/main/handlers/versions.ts#L51) | 实例扫描与 servers.dat 服务 | 私有游戏根或授权导入；NBT 不等于游戏可启动 |
| `installed.listAll()` | I `installed:listAll`；[preload:102](../src/preload/index.ts#L102)；[实现:59](../src/main/handlers/versions.ts#L59) | 实例扫描与 servers.dat 服务 | 私有游戏根或授权导入；NBT 不等于游戏可启动 |
| `installed.addServer(versionId: string, name: string, address: string)` | I `installed:addServer`；[preload:103](../src/preload/index.ts#L103)；[实现:71](../src/main/handlers/versions.ts#L71) | 实例扫描与 servers.dat 服务 | 私有游戏根或授权导入；NBT 不等于游戏可启动 |

### 9.7 versionDirs

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `versionDirs.list()` | I `versionDirs:list`；[preload:107](../src/preload/index.ts#L107)；[实现:87](../src/main/handlers/versions.ts#L87) | 目录仓库与原生授权句柄 | 私有根+SAF 文档树；不接受伪绝对路径 |
| `versionDirs.add(input: { path: string; alias?: string })` | I `versionDirs:add`；[preload:108](../src/preload/index.ts#L108)；[实现:88](../src/main/handlers/versions.ts#L88) | 目录仓库与原生授权句柄 | 私有根+SAF 文档树；不接受伪绝对路径 |
| `versionDirs.update(id: string, patch: { alias?: string; path?: string })` | I `versionDirs:update`；[preload:109](../src/preload/index.ts#L109)；[实现:100](../src/main/handlers/versions.ts#L100) | 目录仓库与原生授权句柄 | 私有根+SAF 文档树；不接受伪绝对路径 |
| `versionDirs.remove(id: string)` | I `versionDirs:remove`；[preload:111](../src/preload/index.ts#L111)；[实现:119](../src/main/handlers/versions.ts#L119) | 目录仓库与原生授权句柄 | 私有根+SAF 文档树；不接受伪绝对路径 |
| `versionDirs.select(id: string)` | I `versionDirs:select`；[preload:112](../src/preload/index.ts#L112)；[实现:128](../src/main/handlers/versions.ts#L128) | 目录仓库与原生授权句柄 | 私有根+SAF 文档树；不接受伪绝对路径 |

### 9.8 loaders

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `loaders.versions(kind: LoaderKind, mcVersion: string)` | I `loaders:versions`；[preload:115](../src/preload/index.ts#L115)；[实现:137](../src/main/handlers/versions.ts#L137) | 加载器服务、实例锁与安装任务 | 解析可迁；Android JVM/installer/loader 兼容待实测 |
| `loaders.install(kind: LoaderKind, mcVersion: string, loaderVersion: string, customId?: string, dirId?: string)` | I `loaders:install`；[preload:116](../src/preload/index.ts#L116)；[实现:138](../src/main/handlers/versions.ts#L138) | 加载器服务、实例锁与安装任务 | 解析可迁；Android JVM/installer/loader 兼容待实测 |
| `loaders.installInPlace(kind: LoaderKind &#124; ForgeKind, mcVersion: string, loaderVersion: string, instanceId: string, dirId?: string)` | I `loaders:installInPlace`；[preload:119](../src/preload/index.ts#L119)；[实现:153](../src/main/handlers/versions.ts#L153) | 加载器服务、实例锁与安装任务 | 解析可迁；Android JVM/installer/loader 兼容待实测 |

### 9.9 forge

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `forge.versions(kind: ForgeKind, mcVersion: string)` | I `forge:versions`；[preload:128](../src/preload/index.ts#L128)；[实现:204](../src/main/handlers/versions.ts#L204) | 受控 JVM 安装器任务与超时/子树清理 | Android JVM/processor/AWT/native 未实现，不能直接 spawn |
| `forge.install(kind: ForgeKind, mcVersion: string, version: string, customId?: string, waitForVersion?: string, dirId?: string)` | I `forge:install`；[preload:129](../src/preload/index.ts#L129)；[实现:205](../src/main/handlers/versions.ts#L205) | 受控 JVM 安装器任务与超时/子树清理 | Android JVM/processor/AWT/native 未实现，不能直接 spawn |
| `forge.onLog(cb)` | E `forge:log`；[preload:131](../src/preload/index.ts#L131)；[实现:223](../src/main/handlers/versions.ts#L223) | 事件路由/订阅取消；负载 string；受控 JVM 安装器任务与超时/子树清理 | Android JVM/processor/AWT/native 未实现，不能直接 spawn |

### 9.10 resources

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `resources.list(versionId: string, kind: ResourceKind)` | I `resources:list`；[preload:134](../src/preload/index.ts#L134)；[实现:287](../src/main/handlers/mods.ts#L287) | 实例资源与元数据/升级任务 | 内部运行文件系统；SAF 导入导出，光影兼容另验 |
| `resources.remove(path: string)` | I `resources:remove`；[preload:135](../src/preload/index.ts#L135)；[实现:301](../src/main/handlers/mods.ts#L301) | 实例资源与元数据/升级任务 | 内部运行文件系统；SAF 导入导出，光影兼容另验 |
| `resources.open(versionId: string, kind: ResourceKind)` | I `resources:open`；[preload:136](../src/preload/index.ts#L136)；[实现:302](../src/main/handlers/mods.ts#L302) | 实例资源与元数据/升级任务 | 内部运行文件系统；SAF 导入导出，光影兼容另验 |
| `resources.onUpdated(cb)` | E `resources:updated`；[preload:137](../src/preload/index.ts#L137)；[实现:296](../src/main/handlers/mods.ts#L296) | 事件路由/订阅取消；负载 ResourceUpdated；实例资源与元数据/升级任务 | 内部运行文件系统；SAF 导入导出，光影兼容另验 |
| `resources.checkUpdates(versionId: string)` | I `resources:checkUpdates`；[preload:138](../src/preload/index.ts#L138)；[实现:308](../src/main/handlers/mods.ts#L308) | 实例资源与元数据/升级任务 | 内部运行文件系统；SAF 导入导出，光影兼容另验 |
| `resources.onUpdateChecked(cb)` | E `resources:update-checked`；[preload:139](../src/preload/index.ts#L139)；[实现:325](../src/main/handlers/mods.ts#L325) | 事件路由/订阅取消；负载 ResourceUpdateEvent；实例资源与元数据/升级任务 | 内部运行文件系统；SAF 导入导出，光影兼容另验 |
| `resources.applyUpdate(versionId: string, update: ResourceUpdateInfo, enabled: boolean)` | I `resources:applyUpdate`；[preload:140](../src/preload/index.ts#L140)；[实现:329](../src/main/handlers/mods.ts#L329) | 实例资源与元数据/升级任务 | 内部运行文件系统；SAF 导入导出，光影兼容另验 |

### 9.11 download

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `download.install(id: string, dirId?: string)` | I `download:install`；[preload:144](../src/preload/index.ts#L144)；[实现:235](../src/main/handlers/versions.ts#L235) | 任务服务/校验/取消/实际引擎报告 | Rust Android 下载核心、后台恢复和权限；无桌面 .node |
| `download.cancel(taskId?: string)` | I `download:cancel`；[preload:145](../src/preload/index.ts#L145)；[实现:265](../src/main/handlers/versions.ts#L265) | 任务服务/校验/取消/实际引擎报告 | Rust Android 下载核心、后台恢复和权限；无桌面 .node |
| `download.engine()` | I `download:engine`；[preload:147](../src/preload/index.ts#L147)；[实现:275](../src/main/handlers/versions.ts#L275) | 任务服务/校验/取消/实际引擎报告 | Rust Android 下载核心、后台恢复和权限；无桌面 .node |
| `download.onProgress(cb)` | E `download:progress`；[preload:148](../src/preload/index.ts#L148)；[实现:248](../src/main/handlers/versions.ts#L248) | 事件路由/订阅取消；负载 DownloadProgress；任务服务/校验/取消/实际引擎报告 | Rust Android 下载核心、后台恢复和权限；无桌面 .node |

### 9.12 mods

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `mods.search(query: string, type?: ModrinthType, category?: string, gameVersion?: string, loader?: string, offset?: number, source?: SourceFilter)` | I `mods:search`；[preload:151](../src/preload/index.ts#L151)；[实现:46](../src/main/handlers/mods.ts#L46) | 源适配/目标实例校验/依赖与下载任务 | 资源查询可迁；mod native/GL 兼容不能保证 |
| `mods.project(id: string, type?: ModrinthType)` | I `mods:project`；[preload:160](../src/preload/index.ts#L160)；[实现:65](../src/main/handlers/mods.ts#L65) | 源适配/目标实例校验/依赖与下载任务 | 资源查询可迁；mod native/GL 兼容不能保证 |
| `mods.versions(slug: string, loaders: string[], gameVersions: string[], source?: ModSource, type?: ModrinthType)` | I `mods:versions`；[preload:162](../src/preload/index.ts#L162)；[实现:59](../src/main/handlers/mods.ts#L59) | 源适配/目标实例校验/依赖与下载任务 | 资源查询可迁；mod native/GL 兼容不能保证 |
| `mods.install(fileUrl: string, filename: string, versionId: string, type?: ModrinthType, sizeHint?: number, dirId?: string)` | I `mods:install`；[preload:164](../src/preload/index.ts#L164)；[实现:68](../src/main/handlers/mods.ts#L68) | 源适配/目标实例校验/依赖与下载任务 | 资源查询可迁；mod native/GL 兼容不能保证 |
| `mods.downloadTo(fileUrl: string, destPath: string, sizeHint?: number)` | I `mods:downloadTo`；[preload:166](../src/preload/index.ts#L166)；[实现:190](../src/main/handlers/mods.ts#L190) | 源适配/目标实例校验/依赖与下载任务 | 资源查询可迁；mod native/GL 兼容不能保证 |
| `mods.installFabricApi(mcVersion: string, versionId: string)` | I `mods:installFabricApi`；[preload:168](../src/preload/index.ts#L168)；[实现:113](../src/main/handlers/mods.ts#L113) | 源适配/目标实例校验/依赖与下载任务 | 资源查询可迁；mod native/GL 兼容不能保证 |
| `mods.installOfflineTranslate(versionId: string)` | I `mods:installOfflineTranslate`；[preload:170](../src/preload/index.ts#L170)；[实现:151](../src/main/handlers/mods.ts#L151) | 源适配/目标实例校验/依赖与下载任务 | 资源查询可迁；mod native/GL 兼容不能保证 |

### 9.13 java

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `java.detect()` | I `java:detect`；[preload:174](../src/preload/index.ts#L174)；[实现:14](../src/main/handlers/java.ts#L14) | 桌面运行时探测/安装的 ProcessHost | 需 Android JVM/ABI/NDK 适配，非系统 ART 或桌面 JRE |
| `java.check(versionId: string)` | I `java:check`；[preload:175](../src/preload/index.ts#L175)；[实现:15](../src/main/handlers/java.ts#L15) | 桌面运行时探测/安装的 ProcessHost | 需 Android JVM/ABI/NDK 适配，非系统 ART 或桌面 JRE |
| `java.install(major: number)` | I `java:install`；[preload:176](../src/preload/index.ts#L176)；[实现:30](../src/main/handlers/java.ts#L30) | 桌面运行时探测/安装的 ProcessHost | 需 Android JVM/ABI/NDK 适配，非系统 ART 或桌面 JRE |
| `java.pick()` | I `java:pick`；[preload:177](../src/preload/index.ts#L177)；[实现:71](../src/main/handlers/java.ts#L71) | 桌面运行时探测/安装的 ProcessHost | 需 Android JVM/ABI/NDK 适配，非系统 ART 或桌面 JRE |

### 9.14 manage

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `manage.mods(versionId: string, dirId?: string)` | I `manage:mods`；[preload:180](../src/preload/index.ts#L180)；[实现:338](../src/main/handlers/mods.ts#L338) | 受限实例文件服务与冲突/取消语义 | 内部实例根+SAF 流式导入；外部文件提供者能力不同 |
| `manage.onModsUpdated(cb)` | E `manage:mods-updated`；[preload:181](../src/preload/index.ts#L181)；[实现:346](../src/main/handlers/mods.ts#L346) | 事件路由/订阅取消；负载 { versionId, mod: ModEntry }；受限实例文件服务与冲突/取消语义 | 内部实例根+SAF 流式导入；外部文件提供者能力不同 |
| `manage.toggleMod(path: string)` | I `manage:toggleMod`；[preload:182](../src/preload/index.ts#L182)；[实现:351](../src/main/handlers/mods.ts#L351) | 受限实例文件服务与冲突/取消语义 | 内部实例根+SAF 流式导入；外部文件提供者能力不同 |
| `manage.deleteMod(path: string)` | I `manage:deleteMod`；[preload:183](../src/preload/index.ts#L183)；[实现:352](../src/main/handlers/mods.ts#L352) | 受限实例文件服务与冲突/取消语义 | 内部实例根+SAF 流式导入；外部文件提供者能力不同 |
| `manage.installLocalMod(versionId: string, sourcePath: string)` | I `manage:installLocalMod`；[preload:184](../src/preload/index.ts#L184)；[实现:353](../src/main/handlers/mods.ts#L353) | 受限实例文件服务与冲突/取消语义 | 内部实例根+SAF 流式导入；外部文件提供者能力不同 |
| `manage.installLocalResource(versionId: string, kind: 'mods' &#124; 'resourcepacks' &#124; 'shaderpacks', sourcePath: string)` | I `manage:installLocalResource`；[preload:186](../src/preload/index.ts#L186)；[实现:358](../src/main/handlers/mods.ts#L358) | 受限实例文件服务与冲突/取消语义 | 内部实例根+SAF 流式导入；外部文件提供者能力不同 |
| `manage.deleteWorld(versionId: string, worldName: string)` | I `manage:deleteWorld`；[preload:188](../src/preload/index.ts#L188)；[实现:365](../src/main/handlers/mods.ts#L365) | 受限实例文件服务与冲突/取消语义 | 内部实例根+SAF 流式导入；外部文件提供者能力不同 |
| `manage.schematics(versionId: string)` | I `manage:schematics`；[preload:189](../src/preload/index.ts#L189)；[实现:369](../src/main/handlers/mods.ts#L369) | 受限实例文件服务与冲突/取消语义 | 内部实例根+SAF 流式导入；外部文件提供者能力不同 |
| `manage.deleteFile(path: string)` | I `manage:deleteFile`；[preload:190](../src/preload/index.ts#L190)；[实现:373](../src/main/handlers/mods.ts#L373) | 受限实例文件服务与冲突/取消语义 | 内部实例根+SAF 流式导入；外部文件提供者能力不同 |
| `manage.deleteVersion(versionId: string)` | I `manage:deleteVersion`；[preload:191](../src/preload/index.ts#L191)；[实现:374](../src/main/handlers/mods.ts#L374) | 受限实例文件服务与冲突/取消语义 | 内部实例根+SAF 流式导入；外部文件提供者能力不同 |
| `manage.renameVersion(versionId: string, newName: string)` | I `manage:renameVersion`；[preload:192](../src/preload/index.ts#L192)；[实现:386](../src/main/handlers/mods.ts#L386) | 受限实例文件服务与冲突/取消语义 | 内部实例根+SAF 流式导入；外部文件提供者能力不同 |
| `manage.openDir(versionId: string, kind: VersionDirKind)` | I `manage:openDir`；[preload:194](../src/preload/index.ts#L194)；[实现:412](../src/main/handlers/mods.ts#L412) | 受限实例文件服务与冲突/取消语义 | 内部实例根+SAF 流式导入；外部文件提供者能力不同 |

### 9.15 launch

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `launch.start(opts: LaunchOptions)` | I `launch:start`；[preload:197](../src/preload/index.ts#L197)；[实现:63](../src/main/handlers/launch.ts#L63) | GameRuntime 状态机；Java/下载/进程/日志适配 | 需 JNI/JVM+GL/Surface/输入/音频完整运行器，当前未实现 |
| `launch.stop()` | I `launch:stop`；[preload:198](../src/preload/index.ts#L198)；[实现:71](../src/main/handlers/launch.ts#L71) | GameRuntime 状态机；Java/下载/进程/日志适配 | 需 JNI/JVM+GL/Surface/输入/音频完整运行器，当前未实现 |
| `launch.onEvent(cb)` | E `launch:event`；[preload:199](../src/preload/index.ts#L199)；[实现:67](../src/main/handlers/launch.ts#L67) | 事件路由/订阅取消；负载 LaunchEvent；GameRuntime 状态机；Java/下载/进程/日志适配 | 需 JNI/JVM+GL/Surface/输入/音频完整运行器，当前未实现 |

### 9.16 settings

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `settings.get()` | I `settings:get`；[preload:202](../src/preload/index.ts#L202)；[实现:12](../src/main/handlers/settings.ts#L12) | schema 设置仓库与宿主副作用 | 能力表/权限/系统 Insets；不把不支持开关伪报成功 |
| `settings.set(partial: Partial<LauncherSettings>)` | I `settings:set`；[preload:203](../src/preload/index.ts#L203)；[实现:13](../src/main/handlers/settings.ts#L13) | schema 设置仓库与宿主副作用 | 能力表/权限/系统 Insets；不把不支持开关伪报成功 |
| `settings.pickWallpaper()` | I `settings:pickWallpaper`；[preload:204](../src/preload/index.ts#L204)；[实现:76](../src/main/handlers/settings.ts#L76) | schema 设置仓库与宿主副作用 | 能力表/权限/系统 Insets；不把不支持开关伪报成功 |
| `settings.clearWallpaper()` | I `settings:clearWallpaper`；[preload:205](../src/preload/index.ts#L205)；[实现:77](../src/main/handlers/settings.ts#L77) | schema 设置仓库与宿主副作用 | 能力表/权限/系统 Insets；不把不支持开关伪报成功 |
| `settings.wallpaperData()` | I `settings:wallpaperData`；[preload:206](../src/preload/index.ts#L206)；[实现:78](../src/main/handlers/settings.ts#L78) | schema 设置仓库与宿主副作用 | 能力表/权限/系统 Insets；不把不支持开关伪报成功 |

### 9.17 system

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `system.memory()` | I `system:memory`；[preload:209](../src/preload/index.ts#L209)；[实现:79](../src/main/handlers/settings.ts#L79) | 原生内存/硬件适配 | Android 系统信息和应用预算，不等于桌面空闲 RAM |
| `system.hardware()` | I `system:hardware`；[preload:210](../src/preload/index.ts#L210)；[实现:85](../src/main/handlers/settings.ts#L85) | 原生内存/硬件适配 | Android 系统信息和应用预算，不等于桌面空闲 RAM |

### 9.18 homepage

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `homepage.list()` | I `homepage:list`；[preload:213](../src/preload/index.ts#L213)；[实现:47](../src/main/handlers/homepage.ts#L47) | 仓库/市场服务+隔离脚本桥，限定 hash 授权 | SAF 导入；WebView CSP/iframe/SDK 必须验证且无原生权限 |
| `homepage.read(id: string)` | I `homepage:read`；[preload:214](../src/preload/index.ts#L214)；[实现:48](../src/main/handlers/homepage.ts#L48) | 仓库/市场服务+隔离脚本桥，限定 hash 授权 | SAF 导入；WebView CSP/iframe/SDK 必须验证且无原生权限 |
| `homepage.importFile()` | I `homepage:importFile`；[preload:215](../src/preload/index.ts#L215)；[实现:49](../src/main/handlers/homepage.ts#L49) | 仓库/市场服务+隔离脚本桥，限定 hash 授权 | SAF 导入；WebView CSP/iframe/SDK 必须验证且无原生权限 |
| `homepage.download(url: string, filename: string, sizeHint?: number)` | I `homepage:download`；[preload:216](../src/preload/index.ts#L216)；[实现:50](../src/main/handlers/homepage.ts#L50) | 仓库/市场服务+隔离脚本桥，限定 hash 授权 | SAF 导入；WebView CSP/iframe/SDK 必须验证且无原生权限 |
| `homepage.remove(id: string)` | I `homepage:remove`；[preload:218](../src/preload/index.ts#L218)；[实现:53](../src/main/handlers/homepage.ts#L53) | 仓库/市场服务+隔离脚本桥，限定 hash 授权 | SAF 导入；WebView CSP/iframe/SDK 必须验证且无原生权限 |
| `homepage.verify(id: string)` | I `homepage:verify`；[preload:219](../src/preload/index.ts#L219)；[实现:54](../src/main/handlers/homepage.ts#L54) | 仓库/市场服务+隔离脚本桥，限定 hash 授权 | SAF 导入；WebView CSP/iframe/SDK 必须验证且无原生权限 |
| `homepage.confirm(id: string, network: boolean)` | I `homepage:confirm`；[preload:220](../src/preload/index.ts#L220)；[实现:55](../src/main/handlers/homepage.ts#L55) | 仓库/市场服务+隔离脚本桥，限定 hash 授权 | SAF 导入；WebView CSP/iframe/SDK 必须验证且无原生权限 |
| `homepage.setActive(id: string)` | I `homepage:setActive`；[preload:221](../src/preload/index.ts#L221)；[实现:56](../src/main/handlers/homepage.ts#L56) | 仓库/市场服务+隔离脚本桥，限定 hash 授权 | SAF 导入；WebView CSP/iframe/SDK 必须验证且无原生权限 |
| `homepage.block(id: string, reason: string)` | I `homepage:block`；[preload:222](../src/preload/index.ts#L222)；[实现:58](../src/main/handlers/homepage.ts#L58) | 仓库/市场服务+隔离脚本桥，限定 hash 授权 | SAF 导入；WebView CSP/iframe/SDK 必须验证且无原生权限 |
| `homepage.openDir()` | I `homepage:openDir`；[preload:223](../src/preload/index.ts#L223)；[实现:59](../src/main/handlers/homepage.ts#L59) | 仓库/市场服务+隔离脚本桥，限定 hash 授权 | SAF 导入；WebView CSP/iframe/SDK 必须验证且无原生权限 |
| `homepage.securityEngine()` | I `homepage:securityEngine`；[preload:224](../src/preload/index.ts#L224)；[实现:61](../src/main/handlers/homepage.ts#L61) | 仓库/市场服务+隔离脚本桥，限定 hash 授权 | SAF 导入；WebView CSP/iframe/SDK 必须验证且无原生权限 |
| `homepage.market()` | I `homepage:market`；[preload:225](../src/preload/index.ts#L225)；[实现:64](../src/main/handlers/homepage.ts#L64) | 仓库/市场服务+隔离脚本桥，限定 hash 授权 | SAF 导入；WebView CSP/iframe/SDK 必须验证且无原生权限 |
| `homepage.checkUpdates()` | I `homepage:checkUpdates`；[preload:226](../src/preload/index.ts#L226)；[实现:65](../src/main/handlers/homepage.ts#L65) | 仓库/市场服务+隔离脚本桥，限定 hash 授权 | SAF 导入；WebView CSP/iframe/SDK 必须验证且无原生权限 |
| `homepage.update(update)` | I `homepage:update`；[preload:227](../src/preload/index.ts#L227)；[实现:66](../src/main/handlers/homepage.ts#L66) | 仓库/市场服务+隔离脚本桥，限定 hash 授权 | SAF 导入；WebView CSP/iframe/SDK 必须验证且无原生权限 |
| `homepage.submit(payload)` | I `homepage:submit`；[preload:228](../src/preload/index.ts#L228)；[实现:68](../src/main/handlers/homepage.ts#L68) | 仓库/市场服务+隔离脚本桥，限定 hash 授权 | SAF 导入；WebView CSP/iframe/SDK 必须验证且无原生权限 |
| `homepage.sendEmailCode(email: string)` | I `homepage:send-email-code`；[preload:229](../src/preload/index.ts#L229)；[实现:67](../src/main/handlers/homepage.ts#L67) | 仓库/市场服务+隔离脚本桥，限定 hash 授权 | SAF 导入；WebView CSP/iframe/SDK 必须验证且无原生权限 |
| `homepage.installNumbered(input)` | I `homepage:installNumbered`；[preload:230](../src/preload/index.ts#L230)；[实现:90](../src/main/handlers/homepage.ts#L90) | 仓库/市场服务+隔离脚本桥，限定 hash 授权 | SAF 导入；WebView CSP/iframe/SDK 必须验证且无原生权限 |
| `homepage.log(level, message)` | I `homepage:log`；[preload:231](../src/preload/index.ts#L231)；[实现:94](../src/main/handlers/homepage.ts#L94) | 保留 fire-and-forget invoke、控制符折叠及 Debug 门禁 | 不授权脚本任意文件日志或系统接口 |
| `homepage.onNavBlocked(cb)` | E `homepage:nav-blocked`；[preload:234](../src/preload/index.ts#L234)；[实现:359](../src/main/app.ts#L359) | 事件路由/订阅取消；负载 string URL；仓库/市场服务+隔离脚本桥，限定 hash 授权 | SAF 导入；WebView CSP/iframe/SDK 必须验证且无原生权限 |

### 9.19 feedback

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `feedback.sendCode(email: string)` | I `feedback:send-code`；[preload:237](../src/preload/index.ts#L237)；[实现:69](../src/main/handlers/homepage.ts#L69) | 服务端会话/附件/限额与受控 opener | 附件 URI/分享/Keystore；动态权限和大小限制 |
| `feedback.submit(payload: FeedbackSubmitPayload)` | I `feedback:submit`；[preload:238](../src/preload/index.ts#L238)；[实现:70](../src/main/handlers/homepage.ts#L70) | 服务端会话/附件/限额与受控 opener | 附件 URI/分享/Keystore；动态权限和大小限制 |
| `feedback.list(email: string, code: string)` | I `feedback:list`；[preload:239](../src/preload/index.ts#L239)；[实现:71](../src/main/handlers/homepage.ts#L71) | 服务端会话/附件/限额与受控 opener | 附件 URI/分享/Keystore；动态权限和大小限制 |
| `feedback.detail(id: string, email: string, code: string)` | I `feedback:detail`；[preload:240](../src/preload/index.ts#L240)；[实现:72](../src/main/handlers/homepage.ts#L72) | 服务端会话/附件/限额与受控 opener | 附件 URI/分享/Keystore；动态权限和大小限制 |
| `feedback.message(payload: FeedbackMessagePayload)` | I `feedback:message`；[preload:242](../src/preload/index.ts#L242)；[实现:75](../src/main/handlers/homepage.ts#L75) | 服务端会话/附件/限额与受控 opener | 附件 URI/分享/Keystore；动态权限和大小限制 |
| `feedback.openFile(id: string, name: string)` | I `feedback:open-file`；[preload:243](../src/preload/index.ts#L243)；[实现:78](../src/main/handlers/homepage.ts#L78) | 服务端会话/附件/限额与受控 opener | 附件 URI/分享/Keystore；动态权限和大小限制 |
| `feedback.withdraw(email: string, code: string, id: string)` | I `feedback:withdraw`；[preload:244](../src/preload/index.ts#L244)；[实现:79](../src/main/handlers/homepage.ts#L79) | 服务端会话/附件/限额与受控 opener | 附件 URI/分享/Keystore；动态权限和大小限制 |
| `feedback.login(email: string, code: string, ttl: number)` | I `feedback:login`；[preload:246](../src/preload/index.ts#L246)；[实现:84](../src/main/handlers/homepage.ts#L84) | 服务端会话/附件/限额与受控 opener | 附件 URI/分享/Keystore；动态权限和大小限制 |
| `feedback.session()` | I `feedback:session`；[preload:248](../src/preload/index.ts#L248)；[实现:87](../src/main/handlers/homepage.ts#L87) | 服务端会话/附件/限额与受控 opener | 附件 URI/分享/Keystore；动态权限和大小限制 |
| `feedback.logout()` | I `feedback:logout`；[preload:249](../src/preload/index.ts#L249)；[实现:88](../src/main/handlers/homepage.ts#L88) | 服务端会话/附件/限额与受控 opener | 附件 URI/分享/Keystore；动态权限和大小限制 |

### 9.20 limits

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `limits.get()` | I `limits:get`；[preload:252](../src/preload/index.ts#L252)；[实现:89](../src/main/handlers/homepage.ts#L89) | 原有 PHP 限额读取与缓存 | 相同业务协议，离线/失败不能伪报无上限 |

### 9.21 devMode

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `devMode.status()` | I `devmode:status`；[preload:255](../src/preload/index.ts#L255)；[实现:38](../src/main/handlers/debug.ts#L38) | 授权/过期与受控调试窗口服务 | 应用内诊断；WebView 调试与桌面 Chromium DevTools 不等价 |
| `devMode.sendCode(email: string)` | I `devmode:sendCode`；[preload:256](../src/preload/index.ts#L256)；[实现:42](../src/main/handlers/debug.ts#L42) | 授权/过期与受控调试窗口服务 | 应用内诊断；WebView 调试与桌面 Chromium DevTools 不等价 |
| `devMode.verify(email: string, code: string)` | I `devmode:verify`；[preload:257](../src/preload/index.ts#L257)；[实现:43](../src/main/handlers/debug.ts#L43) | 授权/过期与受控调试窗口服务 | 应用内诊断；WebView 调试与桌面 Chromium DevTools 不等价 |
| `devMode.setEnabled(enabled: boolean)` | I `devmode:setEnabled`；[preload:258](../src/preload/index.ts#L258)；[实现:48](../src/main/handlers/debug.ts#L48) | 授权/过期与受控调试窗口服务 | 应用内诊断；WebView 调试与桌面 Chromium DevTools 不等价 |
| `devMode.revoke()` | I `devmode:revoke`；[preload:259](../src/preload/index.ts#L259)；[实现:56](../src/main/handlers/debug.ts#L56) | 授权/过期与受控调试窗口服务 | 应用内诊断；WebView 调试与桌面 Chromium DevTools 不等价 |
| `devMode.setSecurityMode(mode: 'full' &#124; 'warn' &#124; 'off')` | I `devmode:setSecurityMode`；[preload:260](../src/preload/index.ts#L260)；[实现:63](../src/main/handlers/debug.ts#L63) | 授权/过期与受控调试窗口服务 | 应用内诊断；WebView 调试与桌面 Chromium DevTools 不等价 |
| `devMode.openTools()` | I `devmode:openTools`；[preload:261](../src/preload/index.ts#L261)；[实现:68](../src/main/handlers/debug.ts#L68) | 授权/过期与受控调试窗口服务 | 应用内诊断；WebView 调试与桌面 Chromium DevTools 不等价 |
| `devMode.closeTools()` | I `devmode:closeTools`；[preload:262](../src/preload/index.ts#L262)；[实现:71](../src/main/handlers/debug.ts#L71) | 授权/过期与受控调试窗口服务 | 应用内诊断；WebView 调试与桌面 Chromium DevTools 不等价 |
| `devMode.openDevTools()` | I `devmode:openDevTools`；[preload:263](../src/preload/index.ts#L263)；[实现:76](../src/main/handlers/debug.ts#L76) | 授权/过期与受控调试窗口服务 | 应用内诊断；WebView 调试与桌面 Chromium DevTools 不等价 |
| `devMode.closeDevTools()` | I `devmode:closeDevTools`；[preload:264](../src/preload/index.ts#L264)；[实现:88](../src/main/handlers/debug.ts#L88) | 授权/过期与受控调试窗口服务 | 应用内诊断；WebView 调试与桌面 Chromium DevTools 不等价 |
| `devMode.onChanged(cb)` | E `devmode:changed`；[preload:265](../src/preload/index.ts#L265)；[实现:1518](../src/main/app.ts#L1518) | 事件路由/订阅取消；负载 DevModeStatus；授权/过期与受控调试窗口服务 | 应用内诊断；WebView 调试与桌面 Chromium DevTools 不等价 |

### 9.22 files

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `files.places()` | I `files:places`；[preload:268](../src/preload/index.ts#L268)；[实现:21](../src/main/handlers/files.ts#L21) | 用户授权的文件服务与原生 opener | SAF/ContentResolver；不可把 content URI 当 fs path |
| `files.list(path: string)` | I `files:list`；[preload:269](../src/preload/index.ts#L269)；[实现:41](../src/main/handlers/files.ts#L41) | 用户授权的文件服务与原生 opener | SAF/ContentResolver；不可把 content URI 当 fs path |
| `files.open(path: string)` | I `files:open`；[preload:270](../src/preload/index.ts#L270)；[实现:42](../src/main/handlers/files.ts#L42) | 用户授权的文件服务与原生 opener | SAF/ContentResolver；不可把 content URI 当 fs path |
| `files.reveal(path: string)` | I `files:reveal`；[preload:271](../src/preload/index.ts#L271)；[实现:43](../src/main/handlers/files.ts#L43) | 用户授权的文件服务与原生 opener | SAF/ContentResolver；不可把 content URI 当 fs path |
| `files.rename(path: string, name: string)` | I `files:rename`；[preload:272](../src/preload/index.ts#L272)；[实现:45](../src/main/handlers/files.ts#L45) | 用户授权的文件服务与原生 opener | SAF/ContentResolver；不可把 content URI 当 fs path |
| `files.createFile(dir: string, name: string)` | I `files:createFile`；[preload:273](../src/preload/index.ts#L273)；[实现:46](../src/main/handlers/files.ts#L46) | 用户授权的文件服务与原生 opener | SAF/ContentResolver；不可把 content URI 当 fs path |
| `files.remove(path: string)` | I `files:remove`；[preload:274](../src/preload/index.ts#L274)；[实现:47](../src/main/handlers/files.ts#L47) | 用户授权的文件服务与原生 opener | SAF/ContentResolver；不可把 content URI 当 fs path |
| `files.readText(path: string)` | I `files:readText`；[preload:275](../src/preload/index.ts#L275)；[实现:48](../src/main/handlers/files.ts#L48) | 用户授权的文件服务与原生 opener | SAF/ContentResolver；不可把 content URI 当 fs path |
| `files.writeText(path: string, content: string)` | I `files:writeText`；[preload:276](../src/preload/index.ts#L276)；[实现:49](../src/main/handlers/files.ts#L49) | 用户授权的文件服务与原生 opener | SAF/ContentResolver；不可把 content URI 当 fs path |

### 9.23 modpack

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `modpack.probe(filePath: string)` | I `modpack:probe`；[preload:279](../src/preload/index.ts#L279)；[实现:224](../src/main/handlers/mods.ts#L224) | 归档与实例任务，保留冲突/回滚/导出选项 | 内部 staging+SAF 导出；包下载成功不代表 Android 兼容 |
| `modpack.download(url: string, filename: string)` | I `modpack:download`；[preload:280](../src/preload/index.ts#L280)；[实现:225](../src/main/handlers/mods.ts#L225) | 归档与实例任务，保留冲突/回滚/导出选项 | 内部 staging+SAF 导出；包下载成功不代表 Android 兼容 |
| `modpack.import(filePath: string, customName?: string, dirId?: string)` | I `modpack:import`；[preload:281](../src/preload/index.ts#L281)；[实现:237](../src/main/handlers/mods.ts#L237) | 归档与实例任务，保留冲突/回滚/导出选项 | 内部 staging+SAF 导出；包下载成功不代表 Android 兼容 |
| `modpack.importFromUrl(url: string, filename: string, customName?: string, dirId?: string)` | I `modpack:importFromUrl`；[preload:282](../src/preload/index.ts#L282)；[实现:256](../src/main/handlers/mods.ts#L256) | 归档与实例任务，保留冲突/回滚/导出选项 | 内部 staging+SAF 导出；包下载成功不代表 Android 兼容 |
| `modpack.exportInventory(versionId: string)` | I `modpack:exportInventory`；[preload:283](../src/preload/index.ts#L283)；[实现:274](../src/main/handlers/mods.ts#L274) | 归档与实例任务，保留冲突/回滚/导出选项 | 内部 staging+SAF 导出；包下载成功不代表 Android 兼容 |
| `modpack.export(versionId: string, options: ModpackExportOptions)` | I `modpack:export`；[preload:284](../src/preload/index.ts#L284)；[实现:278](../src/main/handlers/mods.ts#L278) | 归档与实例任务，保留冲突/回滚/导出选项 | 内部 staging+SAF 导出；包下载成功不代表 Android 兼容 |
| `modpack.onProgress(cb)` | E `modpack:progress`；[preload:285](../src/preload/index.ts#L285)；[实现:245](../src/main/handlers/mods.ts#L245) | 事件路由/订阅取消；负载 DownloadProgress；归档与实例任务，保留冲突/回滚/导出选项 | 内部 staging+SAF 导出；包下载成功不代表 Android 兼容 |

### 9.24 about

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `about.list()` | I `about:list`；[preload:288](../src/preload/index.ts#L288)；[实现:27](../src/main/handlers/network.ts#L27) | PHP 内容服务；协议指纹与离线判断保留 | 关于/公告产品分流；协议同意不因移动端跳过 |
| `about.agreement()` | I `about:agreement`；[preload:289](../src/preload/index.ts#L289)；[实现:79](../src/main/handlers/network.ts#L79) | PHP 内容服务；协议指纹与离线判断保留 | 关于/公告产品分流；协议同意不因移动端跳过 |
| `about.agreementStatus()` | I `about:agreementStatus`；[preload:290](../src/preload/index.ts#L290)；[实现:82](../src/main/handlers/network.ts#L82) | PHP 内容服务；协议指纹与离线判断保留 | 关于/公告产品分流；协议同意不因移动端跳过 |
| `about.announcements()` | I `announcement:list`；[preload:291](../src/preload/index.ts#L291)；[实现:103](../src/main/handlers/network.ts#L103) | PHP 内容服务；协议指纹与离线判断保留 | 关于/公告产品分流；协议同意不因移动端跳过 |

### 9.25 update

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `update.check()` | I `update:check`；[preload:294](../src/preload/index.ts#L294)；[实现:104](../src/main/handlers/network.ts#L104) | 产品/目标/签名绑定更新器，重做安装身份 | APK/商店/系统安装器；不能运行桌面包或自替换 APK |
| `update.download(info: UpdateInfo)` | I `update:download`；[preload:295](../src/preload/index.ts#L295)；[实现:126](../src/main/handlers/network.ts#L126) | 产品/目标/签名绑定更新器，重做安装身份 | APK/商店/系统安装器；不能运行桌面包或自替换 APK |
| `update.downloadAndRun(info: UpdateInfo)` | I `update:downloadAndRun`；[preload:296](../src/preload/index.ts#L296)；[实现:132](../src/main/handlers/network.ts#L132) | 重做 Tauri 签名/安装流程与确认，禁执行前端任意包 | 系统 APK/商店批准安装；下载≠安装 |
| `update.onProgress(cb)` | E `update:progress`；[preload:297](../src/preload/index.ts#L297)；[实现:129](../src/main/handlers/network.ts#L129) | 事件路由/订阅取消；负载 DownloadProgress；产品/目标/签名绑定更新器，重做安装身份 | APK/商店/系统安装器；不能运行桌面包或自替换 APK |

### 9.26 ai

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `ai.chat(text: string, context?: string)` | I `ai:chat`；[preload:300](../src/preload/index.ts#L300)；[实现:15](../src/main/handlers/ai.ts#L15) | AI 服务/网络/凭据/批准与任务取消 | 云协议可迁；本机模型地址/权限/后台能力需单独适配 |
| `ai.cancel()` | I `ai:cancel`；[preload:301](../src/preload/index.ts#L301)；[实现:17](../src/main/handlers/ai.ts#L17) | AI 服务/网络/凭据/批准与任务取消 | 云协议可迁；本机模型地址/权限/后台能力需单独适配 |
| `ai.decideTool(id: string, approved: boolean)` | I `ai:decideTool`；[preload:302](../src/preload/index.ts#L302)；[实现:21](../src/main/handlers/ai.ts#L21) | 只接受当前 owner 未决请求；风险政策在宿主校验 | 手机 UI 确认；后台/重复确认不能绕过政策 |
| `ai.onToolRequest(cb)` | E `ai:toolRequest`；[preload:303](../src/preload/index.ts#L303)；[实现:221](../src/main/ai/service.ts#L221) | 事件路由/订阅取消；负载 AiToolRequest；AI 服务/网络/凭据/批准与任务取消 | 云协议可迁；本机模型地址/权限/后台能力需单独适配 |
| `ai.analyzeError(text: string)` | I `ai:analyzeError`；[preload:304](../src/preload/index.ts#L304)；[实现:25](../src/main/handlers/ai.ts#L25) | AI 服务/网络/凭据/批准与任务取消 | 云协议可迁；本机模型地址/权限/后台能力需单独适配 |
| `ai.test()` | I `ai:test`；[preload:305](../src/preload/index.ts#L305)；[实现:27](../src/main/handlers/ai.ts#L27) | AI 服务/网络/凭据/批准与任务取消 | 云协议可迁；本机模型地址/权限/后台能力需单独适配 |
| `ai.setKey(key: string)` | I `ai:setKey`；[preload:306](../src/preload/index.ts#L306)；[实现:44](../src/main/handlers/ai.ts#L44) | 实际连通性测试后安全保存，渲染仅派生已设置状态 | Keystore；禁明文 fallback |
| `ai.clearKey()` | I `ai:clearKey`；[preload:307](../src/preload/index.ts#L307)；[实现:60](../src/main/handlers/ai.ts#L60) | AI 服务/网络/凭据/批准与任务取消 | 云协议可迁；本机模型地址/权限/后台能力需单独适配 |
| `ai.tools()` | I `ai:tools`；[preload:308](../src/preload/index.ts#L308)；[实现:29](../src/main/handlers/ai.ts#L29) | AI 服务/网络/凭据/批准与任务取消 | 云协议可迁；本机模型地址/权限/后台能力需单独适配 |
| `ai.reset()` | I `ai:reset`；[preload:309](../src/preload/index.ts#L309)；[实现:31](../src/main/handlers/ai.ts#L31) | AI 服务/网络/凭据/批准与任务取消 | 云协议可迁；本机模型地址/权限/后台能力需单独适配 |
| `ai.transcribe(audio: Uint8Array, mime: string)` | I `ai:transcribe`；[preload:310](../src/preload/index.ts#L310)；[实现:35](../src/main/handlers/ai.ts#L35) | 受限二进制/编码传输，保留 openai/custom STT 条件 | 麦克风运行时授权/codec 原生回退；不支持格式明确提示 |
| `ai.ball.sync()` | I `ai:ball:sync`；[preload:312](../src/preload/index.ts#L312)；[实现:68](../src/main/handlers/ai.ts#L68) | 桌面球窗生命周期由原生宿主统一管理 | 默认应用内面板，跨应用悬浮另需授权 |
| `ai.ball.expand(open: boolean)` | I `ai:ball:expand`；[preload:313](../src/preload/index.ts#L313)；[实现:71](../src/main/handlers/ai.ts#L71) | 桌面原生球窗展开/收起与焦点同步 | 应用内面板替代，非系统任意浮窗 |
| `ai.ball.move(x: number, y: number, persist: boolean)` | I `ai:ball:move`；[preload:314](../src/preload/index.ts#L314)；[实现:74](../src/main/handlers/ai.ts#L74) | 原生窗口坐标/工作区夹取和持久化 | 应用内布局坐标或授权 overlay，不使用桌面工作区 |
| `ai.ball.position()` | I `ai:ball:position`；[preload:315](../src/preload/index.ts#L315)；[实现:78](../src/main/handlers/ai.ts#L78) | 返回实际球窗逻辑坐标 | 应用内坐标/能力限制，不伪造系统窗口坐标 |
| `ai.onHudState(cb)` | E `ai:hudState`；[preload:317](../src/preload/index.ts#L317)；[实现:178](../src/main/ai/service.ts#L178) | 事件路由/订阅取消；负载 AiHudState；AI 服务/网络/凭据/批准与任务取消 | 云协议可迁；本机模型地址/权限/后台能力需单独适配 |
| `ai.onBallExpanded(cb)` | E `ai:ballExpanded`；[preload:318](../src/preload/index.ts#L318)；[实现:153](../src/main/ai/ball.ts#L153) | 事件路由/订阅取消；负载 boolean；AI 服务/网络/凭据/批准与任务取消 | 云协议可迁；本机模型地址/权限/后台能力需单独适配 |
| `ai.hudState()` | I `ai:hudState`；[preload:319](../src/preload/index.ts#L319)；[实现:88](../src/main/handlers/ai.ts#L88) | AI 服务/网络/凭据/批准与任务取消 | 云协议可迁；本机模型地址/权限/后台能力需单独适配 |
| `ai.onVoiceToggle(cb)` | E `ai:voiceToggle`；[preload:320](../src/preload/index.ts#L320)；[实现:953](../src/main/app.ts#L953) | 事件路由/订阅取消；负载 void；AI 服务/网络/凭据/批准与任务取消 | 云协议可迁；本机模型地址/权限/后台能力需单独适配 |
| `ai.onLaunchRequest(cb)` | E `ai:launchRequest`；[preload:321](../src/preload/index.ts#L321)；[实现:1264](../src/main/app.ts#L1264) | 事件路由/订阅取消；负载 string versionId；AI 服务/网络/凭据/批准与任务取消 | 云协议可迁；本机模型地址/权限/后台能力需单独适配 |
| `ai.setHudActive(active: boolean)` | I `ai:setHudActive`；[preload:322](../src/preload/index.ts#L322)；[实现:82](../src/main/handlers/ai.ts#L82) | AI 服务/网络/凭据/批准与任务取消 | 云协议可迁；本机模型地址/权限/后台能力需单独适配 |
| `ai.setHudStatus(status: AiHudState['status'])` | I `ai:setHudStatus`；[preload:323](../src/preload/index.ts#L323)；[实现:85](../src/main/handlers/ai.ts#L85) | AI 服务/网络/凭据/批准与任务取消 | 云协议可迁；本机模型地址/权限/后台能力需单独适配 |

### 9.27 translate

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `translate.texts(texts: string[], target: string)` | I `translate:texts`；[preload:326](../src/preload/index.ts#L326)；[实现:29](../src/main/handlers/network.ts#L29) | 网络/密钥服务及限流/本地模式 | 网络+Keystore；限流/离线相同规则 |
| `translate.setKey(key: string)` | I `translate:setKey`；[preload:327](../src/preload/index.ts#L327)；[实现:37](../src/main/handlers/network.ts#L37) | 网络/密钥服务及限流/本地模式 | 网络+Keystore；限流/离线相同规则 |
| `translate.clearKey()` | I `translate:clearKey`；[preload:328](../src/preload/index.ts#L328)；[实现:53](../src/main/handlers/network.ts#L53) | 网络/密钥服务及限流/本地模式 | 网络+Keystore；限流/离线相同规则 |

### 9.28 minecraft

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `minecraft.userinfo(name: string)` | I `minecraft:userinfo`；[preload:331](../src/preload/index.ts#L331)；[实现:59](../src/main/handlers/network.ts#L59) | 玩家/服务器 HTTP 查询服务 | 网络可迁；非 Java 游戏运行支持证明 |
| `minecraft.serverStatus(address: string)` | I `minecraft:serverstatus`；[preload:332](../src/preload/index.ts#L332)；[实现:66](../src/main/handlers/network.ts#L66) | 玩家/服务器 HTTP 查询服务 | 网络可迁；非 Java 游戏运行支持证明 |

### 9.29 window

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `window.minimize()` | I `window:minimize`；[preload:335](../src/preload/index.ts#L335)；[实现:7](../src/main/handlers/window.ts#L7) | 按窗口标签授权的 WindowHost | Activity/应用内 UI；桌面最大化/置顶/托盘/穿透不等价 |
| `window.maximize()` | I `window:maximize`；[preload:336](../src/preload/index.ts#L336)；[实现:8](../src/main/handlers/window.ts#L8) | 按窗口标签授权的 WindowHost | Activity/应用内 UI；桌面最大化/置顶/托盘/穿透不等价 |
| `window.close()` | I `window:close`；[preload:337](../src/preload/index.ts#L337)；[实现:14](../src/main/handlers/window.ts#L14) | 按窗口标签授权的 WindowHost | Activity/应用内 UI；桌面最大化/置顶/托盘/穿透不等价 |
| `window.isMaximized()` | I `window:isMaximized`；[preload:338](../src/preload/index.ts#L338)；[实现:17](../src/main/handlers/window.ts#L17) | 按窗口标签授权的 WindowHost | Activity/应用内 UI；桌面最大化/置顶/托盘/穿透不等价 |
| `window.setFullscreen(on: boolean)` | I `window:setFullscreen`；[preload:339](../src/preload/index.ts#L339)；[实现:18](../src/main/handlers/window.ts#L18) | 按窗口标签授权的 WindowHost | Activity/应用内 UI；桌面最大化/置顶/托盘/穿透不等价 |
| `window.setAlwaysOnTop(on: boolean)` | I `window:setAlwaysOnTop`；[preload:340](../src/preload/index.ts#L340)；[实现:26](../src/main/handlers/window.ts#L26) | 按窗口标签授权的 WindowHost | Activity/应用内 UI；桌面最大化/置顶/托盘/穿透不等价 |
| `window.setDesktopMode(on: boolean)` | I `window:setDesktopMode`；[preload:341](../src/preload/index.ts#L341)；[实现:38](../src/main/handlers/window.ts#L38) | 保留桌面外壳状态/退出恢复，不操作用户系统桌面 | 应用内全屏工作区；不接管 Android 系统桌面 |
| `window.securityFullscreen(on: boolean)` | I `window:securityFullscreen`；[preload:342](../src/preload/index.ts#L342)；[实现:75](../src/main/handlers/window.ts#L75) | 宿主安全遮罩与精确恢复，按平台限制 | 应用内安全遮罩，不能抢系统 UI/阻止退出 |

### 9.30 display

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `display.primary()` | I `display:primary`；[preload:345](../src/preload/index.ts#L345)；[实现:65](../src/main/handlers/settings.ts#L65) | 显示器/DPI/工作区适配 | WindowMetrics/density/Insets/方向；游戏 Surface 像素独立 |

### 9.31 shell

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `shell.openExternal(url: string)` | I `shell:openExternal`；[preload:348](../src/preload/index.ts#L348)；[实现:52](../src/main/handlers/files.ts#L52) | 受限 picker/opener 与用户授权句柄 | Intent/SAF URI；无任意 shell 或本机 File 绝对路径 |
| `shell.openPath(path: string)` | I `shell:openPath`；[preload:349](../src/preload/index.ts#L349)；[实现:53](../src/main/handlers/files.ts#L53) | 受限 picker/opener 与用户授权句柄 | Intent/SAF URI；无任意 shell 或本机 File 绝对路径 |
| `shell.chooseDirectory()` | I `shell:chooseDirectory`；[preload:350](../src/preload/index.ts#L350)；[实现:54](../src/main/handlers/files.ts#L54) | 受限 picker/opener 与用户授权句柄 | Intent/SAF URI；无任意 shell 或本机 File 绝对路径 |
| `shell.pickFile(filters)` | I `shell:pickFile`；[preload:351](../src/preload/index.ts#L351)；[实现:59](../src/main/handlers/files.ts#L59) | 受限 picker/opener 与用户授权句柄 | Intent/SAF URI；无任意 shell 或本机 File 绝对路径 |
| `shell.pickFiles(filters)` | I `shell:pickFiles`；[preload:352](../src/preload/index.ts#L352)；[实现:67](../src/main/handlers/files.ts#L67) | 受限 picker/opener 与用户授权句柄 | Intent/SAF URI；无任意 shell 或本机 File 绝对路径 |
| `shell.saveFile(defaultName: string)` | I `shell:saveFile`；[preload:353](../src/preload/index.ts#L353)；[实现:75](../src/main/handlers/files.ts#L75) | 受限 picker/opener 与用户授权句柄 | Intent/SAF URI；无任意 shell 或本机 File 绝对路径 |
| `shell.getPathForFile(file: File)` | L webUtils.getPathForFile；[preload:354](../src/preload/index.ts#L354) | 替换 webUtils 的拖放路径桥；只返回受信任文件令牌 | File/content URI 不能还原任意系统绝对路径，改导入流 |

### 9.32 mp

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `mp.binariesStatus()` | I `mp:binariesStatus`；[preload:358](../src/preload/index.ts#L358)；[实现:61](../src/main/multiplayer/index.ts#L61) | 实际目标/依赖/哈希校验，不能仅照搬存在性 ready | 缺 Android 构建/签名/ABI 时返回不可用 |
| `mp.openResourceDir()` | I `mp:openResourceDir`；[preload:359](../src/preload/index.ts#L359)；[实现:62](../src/main/multiplayer/index.ts#L62) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.isElevated()` | I `mp:isElevated`；[preload:360](../src/preload/index.ts#L360)；[实现:64](../src/main/multiplayer/index.ts#L64) | 按实际 no-tun/特权路径报告能力，去过期管理员假设 | 不要求 root；VPN 需用户授权且与 no-tun 不同 |
| `mp.createLobby(params)` | I `mp:createLobby`；[preload:361](../src/preload/index.ts#L361)；[实现:67](../src/main/multiplayer/index.ts#L67) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.joinLobby(params)` | I `mp:joinLobby`；[preload:362](../src/preload/index.ts#L362)；[实现:68](../src/main/multiplayer/index.ts#L68) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.leaveLobby()` | I `mp:leaveLobby`；[preload:363](../src/preload/index.ts#L363)；[实现:69](../src/main/multiplayer/index.ts#L69) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.forceStop()` | I `mp:forceStop`；[preload:364](../src/preload/index.ts#L364)；[实现:70](../src/main/multiplayer/index.ts#L70) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.getAppState()` | I `mp:getAppState`；[preload:365](../src/preload/index.ts#L365)；[实现:73](../src/main/multiplayer/index.ts#L73) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.getLobby()` | I `mp:getLobby`；[preload:366](../src/preload/index.ts#L366)；[实现:74](../src/main/multiplayer/index.ts#L74) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.getPlayers()` | I `mp:getPlayers`；[preload:367](../src/preload/index.ts#L367)；[实现:75](../src/main/multiplayer/index.ts#L75) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.parseVirtualIp(text: string)` | I `mp:parseVirtualIp`；[preload:368](../src/preload/index.ts#L368)；[实现:86](../src/main/multiplayer/index.ts#L86) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.openExternal(url: string)` | I `mp:openExternal`；[preload:369](../src/preload/index.ts#L369)；[实现:125](../src/main/multiplayer/index.ts#L125) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.scanWorlds()` | I `mp:scanWorlds`；[preload:371](../src/preload/index.ts#L371)；[实现:89](../src/main/multiplayer/index.ts#L89) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.getWorlds()` | I `mp:getWorlds`；[preload:372](../src/preload/index.ts#L372)；[实现:90](../src/main/multiplayer/index.ts#L90) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.getWorldPort()` | I `mp:getWorldPort`；[preload:373](../src/preload/index.ts#L373)；[实现:91](../src/main/multiplayer/index.ts#L91) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.setWorldPort(port: number)` | I `mp:setWorldPort`；[preload:374](../src/preload/index.ts#L374)；[实现:92](../src/main/multiplayer/index.ts#L92) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.getAutoLan()` | I `mp:getAutoLan`；[preload:375](../src/preload/index.ts#L375)；[实现:98](../src/main/multiplayer/index.ts#L98) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.setAutoLan(enabled: boolean)` | I `mp:setAutoLan`；[preload:376](../src/preload/index.ts#L376)；[实现:99](../src/main/multiplayer/index.ts#L99) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.getLanBroadcastCount()` | I `mp:getLanBroadcastCount`；[preload:377](../src/preload/index.ts#L377)；[实现:104](../src/main/multiplayer/index.ts#L104) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.openMiniWindow()` | I `mp:openMiniWindow`；[preload:379](../src/preload/index.ts#L379)；[实现:7](../src/main/handlers/multiplayer.ts#L7) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.closeMiniWindow()` | I `mp:closeMiniWindow`；[preload:380](../src/preload/index.ts#L380)；[实现:12](../src/main/handlers/multiplayer.ts#L12) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.miniState()` | I `mp:miniState`；[preload:381](../src/preload/index.ts#L381)；[实现:13](../src/main/handlers/multiplayer.ts#L13) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.miniResize(width: number, height: number)` | I `mp:miniResize`；[preload:382](../src/preload/index.ts#L382)；[实现:20](../src/main/handlers/multiplayer.ts#L20) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.onMiniState(cb)` | E `mp:miniState`；[preload:383](../src/preload/index.ts#L383)；[实现:1018](../src/main/app.ts#L1018) | 事件路由/订阅取消；负载 MpMiniState；组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.onLobbyChanged(cb: () => void)` | E `mp:lobbyChanged`；[preload:389](../src/preload/index.ts#L389)；[实现:1032](../src/main/app.ts#L1032) | 事件路由/订阅取消；负载 void；回读大厅快照；组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.hasMainWindow()` | I `mp:hasMainWindow`；[preload:394](../src/preload/index.ts#L394)；[实现:16](../src/main/handlers/multiplayer.ts#L16) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.sendChat(content: string)` | I `mp:sendChat`；[preload:396](../src/preload/index.ts#L396)；[实现:78](../src/main/multiplayer/index.ts#L78) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.getMessages()` | I `mp:getMessages`；[preload:397](../src/preload/index.ts#L397)；[实现:81](../src/main/multiplayer/index.ts#L81) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.onChat(cb)` | E `mp:chat`；[preload:398](../src/preload/index.ts#L398)；[实现:1497](../src/main/app.ts#L1497) | 事件路由/订阅取消；负载 MpChatMessage；组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.openHudWindow()` | I `mp:openHudWindow`；[preload:404](../src/preload/index.ts#L404)；[实现:107](../src/main/multiplayer/index.ts#L107) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.closeHudWindow()` | I `mp:closeHudWindow`；[preload:405](../src/preload/index.ts#L405)；[实现:108](../src/main/multiplayer/index.ts#L108) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.onHudState(cb)` | E `mp:hudState`；[preload:406](../src/preload/index.ts#L406)；[实现:905](../src/main/app.ts#L905) | 事件路由/订阅取消；负载 MpHudState；组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.openDanmakuWindow()` | I `mp:openDanmakuWindow`；[preload:411](../src/preload/index.ts#L411)；[实现:109](../src/main/multiplayer/index.ts#L109) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.closeDanmakuWindow()` | I `mp:closeDanmakuWindow`；[preload:412](../src/preload/index.ts#L412)；[实现:110](../src/main/multiplayer/index.ts#L110) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.syncOverlays()` | I `mp:syncOverlays`；[preload:413](../src/preload/index.ts#L413)；[实现:112](../src/main/multiplayer/index.ts#L112) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.onDanmaku(cb)` | E `mp:danmaku`；[preload:414](../src/preload/index.ts#L414)；[实现:925](../src/main/app.ts#L925) | 事件路由/订阅取消；负载 MpDanmaku；组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |
| `mp.danmakuConfig()` | I `mp:danmakuConfig`；[preload:419](../src/preload/index.ts#L419)；[实现:113](../src/main/multiplayer/index.ts#L113) | 组网服务/资源/进程与 socket 生命周期 | Android ABI 内核、前台服务/LAN 适配待实现 |

### 9.33 music

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `music.onLyricsState(cb)` | E `music:lyricsState`；[preload:423](../src/preload/index.ts#L423)；[实现:1340](../src/main/app.ts#L1340) | 事件路由/订阅取消；负载 NeteaseLyricsState；歌词服务+Windows 媒体适配与 HUD | 无 SMTC；媒体会话/通知权限、播放器时间轴均需另做 |
| `music.lyricsState()` | I `music:lyricsState`；[preload:424](../src/preload/index.ts#L424)；[实现:1344](../src/main/app.ts#L1344) | 歌词服务+Windows 媒体适配与 HUD | 无 SMTC；媒体会话/通知权限、播放器时间轴均需另做 |
| `music.lyricsNudge(direction: -1 &#124; 1)` | I `music:lyricsNudge`；[preload:426](../src/preload/index.ts#L426)；[实现:1347](../src/main/app.ts#L1347) | 保留上一/下一句重锚，不伪报精准时间轴 | 无 SMTC；媒体数据不可用则明确不可校准 |

### 9.34 hud

| API / 当前参数 | Electron 基线源码 / 通道 | 桌面目标/验收要求（现状见 2.1） | Android 限制/验收要求 |
| --- | --- | --- | --- |
| `hud.setInteractive(interactive: boolean)` | S `hud:setInteractive`；[preload:430](../src/preload/index.ts#L430)；[实现:1357](../src/main/app.ts#L1357) | HUD 窗口交互适配 | 应用内/游戏 native overlay；跨应用悬浮特殊权限 |

## 10. P0 AI HUD 与 Lite 当前证据补记（2026-11-10 21:36，UTC+08:00）

本节只追加当前批次证据，前文的历史统计与时间点保持不变。当前 HUD 仍复用六字段只读 DTO：`enabled / active / opacity / status / text / lastUser`；239 成员合同仍为 **I212/S2/E23/L2**，显式接管仍按历史口径 **148/64**，事件生产者 **11/23**，本批没有新增公开成员。

- **Task98（状态、运行时与聊天）**：`ai_hud.rs`、`services.rs`、`runtime.rs` 的生产状态夹具已在当前源码 Windows 全量回归中执行；覆盖 settings refresh、HUD→GAME 权威 session、精确 Arc slot 清理、stale exit、caller drop/reset/late completion、IPC waiter 保持 busy。Windows `cargo test --lib --locked` 为 **735 passed / 0 failed / 0 ignored**。
- **Task99（桌面宿主）**：`ai_hud_window.rs` 将 native WebviewWindowBuilder 与属性调用放入 UI 队列，native 调用外不持久有 inner 锁；所有失效后的 destroy 路径统一先失效 generation/language/visible；`Closed`、`Restarting`、其他 Gate 错误分类保留；close 幂等，销毁失败最多 **8 次**延迟重试。最终定向宿主测试为 **7 passed / 0 failed / 728 filtered**，最终 Windows 全量为 **735 passed / 0 failed / 0 ignored**，包含 `close_retry_budget_is_finite_and_preserves_pending_until_exhausted`。真实透明、非聚焦、鼠标穿透、窗口关闭/重开尚未实机验收。
- **前端与 Web 构建**：`node scripts/test-tauri-ai-hud.mjs` **22/0**，`npm run typecheck` exit 0，`npm run build:tauri:web` exit 0（Vite 530 modules / 6.47s）。这些是源码夹具与构建证据，不是浏览器视觉或原生窗口验收。
- **Linux/WSL**：此前当前源码快照的可读结果为 HUD **6/0**、全量 **758/0/0**；本轮补丁后的 WSL 调用受到 `ERROR_INVALID_DATA` 及 `Failed to translate 'D:\BtSoft\panel\script'`、`D:\platform-tools` 影响，未得到新的可读 `test result` 行，不能把退出状态当作本轮补丁后的精确 Linux 全量证据。本轮 Windows 最终全量已执行新增 close 预算测试。
- **Windows 启动错误**：旧增量测试进程曾在入口前报 `STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)` / `3221225785`；官方 `cargo clean -p hcmcl-tauri` 后当前源码测试进程可正常进入并通过。诊断未找到可证明的具体 DLL/export 根因，因此不把 clean 等同于根因修复。
- **Android**：当前进程显式指向 NDK 30.0.16248370 的 versioned clang.cmd、llvm-ar.exe、llvm-ranlib.exe，aarch64-linux-android、i686-linux-android、x86_64-linux-android 的 `cargo check --locked --offline --all-targets` 均 exit 0（约 319 lib / 132 lib-test warnings）。这只证明 Rust cfg 交叉编译；SDK license、Kotlin/Gradle、native link、APK/AAB、设备/provider、JVM、Surface、输入、音频与 Minecraft 游戏闭环仍未验证。
- **Lite（独立产品证据）**：WSL 普通 CTest **15/18**，`common`、`identity`、`media` 因 Secret Service 不可用（`系统凭据保护不可用：Secret Service 默认钥匙串不可用`）及身份环境断言失败；私有 HOME/D-Bus/gnome-keyring 隔离子集 **6/6**，隔离全套 **27/27**。Windows 当前源码重建因环境缺少 `cmake`（`cmake: command not found`）未发生；旧缓存 Windows 可执行文件全返回 0，只能作为 cached old binaries；合成打包夹具 **8/0**，不运行 PE 或真实打包主流程。Lite README 仍标明 migration-in-progress/not full release，不能据此声称完整游戏、在线、macOS 或发布验收。

本补记不改变“Electron 无法启动”“未做真实网络/服务器/账号/Java/游戏/设备验收”等既有边界，也不创建发布产物。

## 11. 主产品 Tauri v2 对齐批次（2026-11-11，UTC+08:00）

用户本轮目标是主产品改用 **Tauri v2 并保持原功能、外观不变**。本节记录新的当前源码证据，不把前面历史 239 成员表、148/64 静态分支、11/23 生产者改成未经重新审计的完成比例。Electron 仍为行为 / 外观参考，React 与 CSS 共用；独立 Lite 保持原范围。2026-11-10 的主产品 Windows x64 包是 Electron，不是 Tauri 发布结果。

### 11.1 桌面壳与真实 Windows 隔离流程

- 桌面主窗口初始 1200×800、最小 960×640，与 Electron 基线一致；移动基础配置不随桌面调整。标题栏仍用现有组件和样式；Tauri 拖拽走固定无参数、可信主文档与 UI 队列的命令，不开放通用 native window 权限。
- 原始 `CloseRequested` 改为关闭意图；取消 / 退后台不提前关 Gate、不撤销导入 / 授权 / 导出等域。真正退出先 once-only 关闭 Gate，再后台顺序取消域，随后 explicit exit / restart；不持文件发布锁阻塞 UI。磁盘挂起可能延迟后台清理，不能声称有界退出。
- Windows 使用真实 tray rect 验证后才隐藏，托盘菜单 / 双击恢复并 unminimize/show/focus；创建失败保持窗口可见。Linux 没有已验证恢复入口时明确拒绝隐藏，不能把这称为 Linux 托盘等价。
- **已实测，仅限本机 synthetic profile**：1200×800 启动、最大化 / 还原、原生三选关闭对话框、取消后业务 API 可用、退后台进程保留、托盘双击恢复、完全关闭后进程退出。没有触真实账号 / 配置 / 游戏，也未完成 Electron 与 Tauri 逐像素对比、macOS/Linux native 验收。

### 11.2 有界业务兼容修复

- `manage:mods` 复用本地名称合同：按 Fabric → Quilt → Forge/NeoForge 元数据读取显示名称，保留文件名 fallback、排序、启用状态、大小和路径。ZIP32 stored/deflate、CRC / 本地与中央头校验；预算限制，ZIP64 / 加密等不支持项回退，不解压执行或联网。
- 官方完整 `26.4-snapshot-1` 只在既有可信版本证据链下识别，不从自定义实例名猜测；资源查询和三种整合包导出保留完整版本。
- 服务器列表使用同一有界 raw/gzip NBT 和 UTF-8 / Java MUTF-8 parser，含 emoji；只投影 name/address，不写回原文件。
- `versions:list/get`、Java 检查、启动与安装器统一私有 metadata 实现：auto 为 official → mirror、mirror-first 反向、official-first 仅官方；force、五分钟缓存、本地零请求、清单 SHA-1 绑定 raw 缓存、继承深度 / 总量与逐跳 URL 验证。启动沿用已有 root guard；持锁不重入目前是源码审计，未伪称专门真实启动夹具。

### 11.3 主页生产接线与未完成部分

- 原 18 个公开主页 channel 已有 Rust 生产分发；纯 Rust 扫描器和本地仓库、SHA 确认、永久 blocked、选中主页 CAS、市场固定动作和受限下载已接入。2 MiB 本地 / 512 KiB 市场、文件句柄身份 / 相对原子发布、部分事务未确认时 Gate 不假收尾。Unix 同 UID 恶意改名的最后命名操作不具 inode CAS，该边界保留。
- 主页从独立 `hc-homepage` 文档源加载，保持 opaque `sandbox=allow-scripts`；每个 native frame 一次授权，绑定当前 id / SHA / generation，30 秒票据、单次响应、每次重新读仓库与批准状态；旧 frame 不得消费新票据或上报新 generation。非 Windows 尚无等效子框架导航 guard，显式不可用。
- 共用 SDK 从原 TS 字符串构建进入 Rust；主机端校验 frame source + generation、32 并发调用 / 64 probe 批次 / 4 MiB 队列与 JSON 预算；异步扫描、执行、回复各点检查代次。批准后重新读完整内容，禁止把新批准 metadata 与旧正文拼接。业务 native invoke 另需仅可信 top 文档持有的随机 header，保留原 trusted-main 和 Gate。
- **真实失败与根因**：初次确认后 6 秒无 hello，主页永久封锁并退内置。精确捕获证明共享 Electron HTML meta CSP 缺少 frame-src，回退到 default-src self，阻止 hc-homepage iframe；Tauri 配置允许项不能覆盖另一条 CSP。只在 Tauri Vite HTML transform 替换入口 meta，保留主脚本 self 与 Electron 原入口，不放宽 watchdog 或 sandbox。
- **修复后 Windows 实测**：精确独立调试端口的主页响应 200、SDK 与 generation 存在，6 秒后仍运行，子框架读父 DOM 被拒，主文档 native marker 不存在于 child。子框架的 Tauri 内部对象仅观察到 plugins 命名空间，不能因对象可见就声称越权；原生调用 / 导航负向验证单独记录，不能由 marker 缺失推断全安全。
- 外链脚本目前明确拒绝执行：没有把未固定字节的外部代码下载 / 执行当成功能等价。后续需用户同意后取回、来源 / 大小 / 哈希与完整扫描闭环。远端市场 / 邮箱 / 提交仅本机 loopback 夹具，未实际向服务写入。limits 失败与强制摘要等更严格策略仍需与 Electron 产品合同核对。
- 最新隔离原生验收（2026-11-11 13:13，UTC+08:00）：干净 synthetic profile、独立端口 19462、仅运行 `.local` 产物。主页响应 HTTP 200；SDK 成功读取 memory=4096、launcherVersion=0.7.6-dev2、theme=light；父 DOM 访问被拒，child 没有 `__HC_NATIVE_DOCUMENT__`，generation 前后重载不同。主文档无 `x-hcmcl-document` 的 `launcher_call` 返回确定拒绝文案。触发 `about:blank` 后 iframe 被移除，页面出现三语“主页尝试离开已授权文档”拦截结果；隔离进程随后退出。验收记录 `.local/tauri-homepage-verify-19462.json`，产物 `hcmcl-tauri-homepage.exe` 46,837,248 bytes，SHA-256 `94CEB2387F83B9B7F8DFE7F3D1346BFD1B2194F6C378D4A051EFD65F42CB3FB5`，无 `portable.flag`。
- 该轮仍观察到 WebView2/Tauri 重载时的 callback 清理 warning，以及子 frame 内部 `__TAURI_INTERNALS__` 可见。验收器没有直接调用 child invoke：该动作会先触发自定义主页自身的 `net:fetch` 运行时探针并永久封锁夹具，所以 child invoke 拒绝仍保持未验收；不能将其改写成正向安全证明。
- 后续确定性协议回归补出并修复一次性票据重放窗口：全局 URL 兜底现在同时要求票据未消费，`revoke` 后旧票据不能再次 `take`，旧 frame 不能消费替代票据。当前源码主页协议 **33/0**，全量 Rust **794/0/0（26.64s）**；这仍是 Rust/夹具证据，不替代 WebView2 原生 replay/revoke 验收。

### 11.4 已收集验证与剩余验收

- 当前阶段快照 Windows Rust 全量 **789 passed / 0 failed / 0 ignored（26.16s）**；主页定向 **32/0**；新版主机 / SDK 行为 VM **23/0**；HTML CSP 真实变换夹具 **4/0**；typecheck exit 0，Tauri Web **532 modules / 3.16s**。之后 native CSP 警告清理、游戏尺寸等新改动必须重跑，不把旧结果外推。
- 更早 shell / 小业务批次曾全量 **755/0/0**；全 20 个 JS 测试与隔离 Electron compile-only 构建通过。compile-only 用进程级 synthetic build key，未读取真实本地 key，也不是可分发 Electron 包。
- 当前仍有联机 / overlay / AI 球 / 歌词 / 工具 / OfflineTranslate、依赖安装闭环及真实账号 / Java / Minecraft / Forge / 网络 / 音频 / 多平台缺口。开发 smoke EXE 不作为正式 Tauri 发布产物；功能和外观尚未完整验收。

本批不 commit / push / 上传 / 部署，不接受 Android SDK 许可，不读取真实配置 / 凭据。后续以具体用户流程与失败复现证据推进，不写猜测完成率。

## 12. Windows 联机小窗补记（2026-11-13，UTC+08:00）

本节只追加当前源码证据，不改写第 2.1 节的历史静态统计。原 **239 = I212/S2/E23/L2** 公开合同保持不变；内部 `mp:miniDrag` 只用于固定小窗拖动，不增加 LauncherApi 方法。

- [小窗宿主](../src-tauri/src/multiplayer/mini.rs)与[联机分发](../src-tauri/src/multiplayer.rs)已接入五个既有小窗调用、成员 / 聊天定向事件和受限外观读取。固定来源、精确 native 实例与窄白名单由 Rust 复核；[capability](../src-tauri/capabilities/mini.json)仅有事件监听 / 退订。快照不包含大厅密码、节点、信令、账号、目录或密钥，非 Windows 明确不支持。
- 普通关闭与应用 terminal 分离：前者确认销毁后允许重开，后者不可复活。任何 owner / Gate 释放都要求精确 `Destroyed` 和 Window / Webview 双表为空；销毁入队、窗口不可见或 UI 回调返回不算完成。状态 / 聊天在 UI 回合合帧投递，不在异步运行时内 `block_on`，聊天邮箱上限 300。
- [MiniWindow](../src/renderer/src/components/MiniWindow.tsx)、[MultiplayerChat](../src/renderer/src/components/MultiplayerChat.tsx)复用 Electron JSX / CSS，先订阅再读快照，实时事件使迟到快照失效，卸载屏蔽迟到回调。[mini-bootstrap](../src/renderer/src/mini-bootstrap.tsx)只创建一个 React root，内部拖动经 `launcher_call` 进入同一来源与实例门禁；[Provider](../src/renderer/src/store.tsx)在小窗不请求壁纸或主窗启动业务。
- 已执行：`cargo check --tests --locked --offline` exit 0；node + web typecheck exit 0；Tauri Web 537 modules / 4.04s、Electron renderer 536 modules / 2.53s 均构建成功；[小窗 TSX 夹具](../scripts/test-tauri-mini.mjs) **5/0**，桥 **13/0**、弹幕 **2/0**、共享 HUD **5/0**。
- Windows Rust 测试在链接时因 `LNK1181: 无法打开输入文件 combase.lib` 停止，未执行测试；已核对本机 Windows SDK 目录没有该库，不把此环境问题写成源码测试失败或通过。WSL 首轮 **3/1** 暴露旧夹具在 `enabled=true` 时错误期望 Destroy；改成显式关闭需求后，小窗生命周期 **4/4**、外观投影 / 白名单 **2/2**。精确 Destroyed、双表释放、普通关闭重开和 terminal 不可重开的断言均保留。
- 真实 WebView2 小窗、拖动 / 折叠、DPI、多显示器、焦点 / 置顶、视觉对照、设置与退房竞争、EasyTier / socket / Minecraft / 双机行为仍未验收。本节不是 no-tun / LAN 或发布完成声明；没有真实 profile / 账号 / 玩家数据、APK / 设备、提交、推送、部署或发布操作。

## 13. 覆盖安装旧 Electron 版补记（2026-11-14，UTC+08:00）

本节只追加当前源码证据。目标：Tauri NSIS 安装包覆盖安装旧 Electron 版并保留用户数据。

- [安装器钩子](../src-tauri/installer-hooks.nsh)（`bundle.windows.nsis.installerHooks`）在 PREINSTALL 查 HKCU/HKLM 卸载键 `com.hungercat.launcher`，以 `/S` 运行旧卸载器并有界等待旧主程序文件消失（60×500ms）；electron-builder 卸载默认保留 %APPDATA% 用户数据，钩子只移除旧程序文件。HKLM 全机器安装的权限失败时安装继续、旧文件保留，该边界未实机验证。
- [首启迁移](../src-tauri/src/storage/migration.rs)：新数据目录无状态文件且旧 Electron userData 目录存在时触发。设置逐键白名单校验（未知 / 派生 / 坏值跳过）；账号白名单字段经 `validate_account`，在线凭据由既有 persist 提取进系统 keyring，绝不写进状态文件；`uapis-key.bin` / `ai-key.bin` 经 Windows DPAPI / Linux basic_text 解密进 `api:*` 槽位；homepages / wallpapers / homepages.json 有界复制（2000 文件 / 单文件 512MiB，只复制不删除不覆盖）。macOS safeStorage 与反馈会话不迁移；CurseForge Key 在 Tauri 端无对应字段，跳过待接线。失败回落全新默认数据，不阻断启动；`cfg(test)` 不触发真实迁移。
- [服务端更新兜底](../server/releases.php)：版本没有 Electron 产物时 `hc_update_for_target` 回退到同 target 的 Tauri 安装包（win→nsis/msi、mac→dmg、linux→appimage），载荷带 `migrateRuntime: 'tauri-v2'`；有 Electron 产物绝不回退，Tauri 客户端绝不回退 Electron 产物。选择顺序与 `hc_pick_version_for_target` 一致。
- 已执行：Windows `cargo test --lib --locked --offline` **921 通过 / 0 失败 / 47.33s**（含 4 个迁移夹具）；`php -l server/releases.php` exit 0；内联 PHP 四组场景（兜底命中 / Electron 优先 / 无匹配空版本 / latestVersion 优先）符合预期；NSIS 重打包成功。
- 真实覆盖安装全流程、真实旧数据的 DPAPI 解密、HKLM 权限边界、卸载器静默行为、服务端部署均未验收；没有提交、推送、部署或发布。

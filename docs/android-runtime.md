# Android Minecraft Java 运行栈：证据、首验范围与实施边界

> 运行栈研究快照：2026-11-07，UTC+8；依据当日约 20:27–20:45 的本地源码与固定上游源码研究更新。构建入口、验证记录与资源检测/应用、debug、Task95/96 状态补记截至 **2026-11-10 11:50 UTC+08:00**，见第 7.1 节；研究结论与设备验收状态不因本地夹具而上调。
>
> **本文是实施方案，不是 Android 游戏支持声明。** 2026-11-07 的运行栈研究批次只更新本文，没有修改运行代码、依赖、许可或 Manifest。后续构建启动入口修补单独记录在第 7.1 节；它不等于集成 Android 游戏运行栈。没有下载 JRE/原生二进制、接受 SDK 条款、构建 APK 或进行设备验证。早期稿中的“未见 SAF / Keystore”不再代表当前代码：这些宿主适配已出现，但不等于具备 Minecraft Java 运行栈。
>
> 全功能跨平台对齐仍是总目标。先验收一个受控组合，是定位问题和逐步扩大矩阵的安排，不是永久删减其他版本、加载器或产品功能。

## 1. 结论与首验范围

- **可复用启动器领域逻辑，不能复用桌面执行环境。** 元数据、版本继承、资源校验、实例事务和参数语义可以保留；普通进程启动、桌面 Linux natives、窗口、输入和音频不能直接变成 Android 实现。
- 当前仓库尚缺 Android JVM/JNI、修改版 LWJGL/GLFW、Surface/输入/音频和 renderer 的完整运行闭包。解除移动端拒绝、生成 Gradle 工程、通过 Rust 交叉检查，均不能证明游戏可运行。
- 可先推进纯启动计划、能力矩阵、运行包校验、单次票据和隔离宿主协议；资源不足应明确返回缺失或不支持，不伪报 `running`。
- **首个实机验收候选固定为 `arm64-v8a + Android/Bionic Java 17 + vanilla Minecraft 1.20.1 + 一个待选定 renderer`。** 设备/API/GPU/驱动和组件版本必须另行锁定。这个组合尚未在 HCMCL 验证，不能写成已支持。
- Java 8 / LWJGL2 旧版本、Java 16 的代表版本、1.20.5+ 的 Java 21、Fabric/Quilt、Forge/NeoForge、原生模组和着色器，均需后续独立验收，不能从上游能力或单组合成功直接外推。

## 2. 当前仓库的真实边界

下列链接定位本次读取的代码；并发迁移可能改变行号，以符号和相邻逻辑为准。本文不把其他成员的构建结果表述为本轮实测。

| 层 | 已读证据 | Android 缺口或限制 |
| --- | --- | --- |
| 移动端执行入口 | [runtime.rs：进程启动](../src-tauri/src/runtime.rs#L230-L246)、[Java 探测](../src-tauri/src/runtime.rs#L267-L302)、[游戏启动](../src-tauri/src/runtime.rs#L493-L565) | Android/iOS 分支明确拒绝桌面 Java 探测、安装器和游戏进程启动。桌面 classpath、`java.library.path`、argv 与 `spawn` 不是 Android 后端。不能只删除拒绝分支。 |
| OS 规则和原生依赖 | [runtime.rs：规则与依赖选择](../src-tauri/src/runtime.rs#L118-L173) | 当前按 OS 规则和 Maven natives 选择依赖，尚无受控 Android runtime overlay。机械使用 `android` 可能排除必要库，伪装 `linux` 又会引入桌面 native。 |
| 原 Electron 启动链 | [launcher.ts：平台和参数](../src/main/launcher.ts#L8-L166)、[spawnGame](../src/main/launcher.ts#L179-L203) | 原实现面向 Windows/Linux，并使用桌面子进程；只能作为业务语义参考，不能当作 Android 已实现代码。 |
| Android 工程 | [app 构建配置](../src-tauri/gen/android/app/build.gradle.kts)、[MainActivity](../HCMCL PE/app/src/main/java/top/johnnyblog/hcmcl/MainActivity.kt)、[Manifest](../src-tauri/gen/android/app/src/main/AndroidManifest.xml) | 本次快照为 compile/target SDK 36、min SDK 24。主 Activity 是 Tauri 壳；没有游戏 Surface Activity、`:game` 进程或游戏前台服务。定向扫描未发现游戏 C/C++/AIDL、`libjvm`、GLFW、OpenAL 或 `ANativeWindow` 桥。 |
| Rust / Android 依赖接线 | [Cargo.toml](../src-tauri/Cargo.toml)、[生成的 Android 依赖接线](../src-tauri/gen/android/app/tauri.build.gradle.kts) | 已有 Tauri/Rust 和 AndroidX 接线，不提供 Android JRE、修改版 LWJGL 或 renderer。生成文件也不是新增游戏依赖的自动入口。 |
| 已有移动端安全与文件宿主 | [mobile_security.rs](../src-tauri/src/mobile_security.rs)、[Keystore 插件](../HCMCL PE/app/src/main/java/top/johnnyblog/hcmcl/security/HcmclSecretStore.kt)、[mobile_files.rs](../src-tauri/src/mobile_files.rs)、[SAF 插件](../HCMCL PE/app/src/main/java/top/johnnyblog/hcmcl/files/HcmclFilesPlugin.kt) | 已有内部秘密存储与授权文件导入/导出源码，不能再称“完全没有 SAF/Keystore”。它们不提供 JVM、显示、输入或游戏生命周期，且不替代设备验收。 |
| 整体迁移状态 | [Tauri 迁移说明](tauri-migration.md) | 其他域的源码、夹具和平台检查有各自证据；桌面测试或 Android 交叉编译成功不等于真实 JVM / Minecraft 游戏运行成功。 |

### 2.1 Android 不是桌面 Linux

同为 AArch64 只说明指令集相同；Android 使用 Bionic、自己的链接器/namespace、权限、显示和生命周期模型。不能把 glibc Linux JRE 或 `natives-linux` 当作 Android 运行包，也不能通过降低 target SDK 来绕开平台限制。

Android 10 对应用可写目录中直接执行二进制有额外限制，见 [Android 官方行为变更](https://developer.android.com/about/versions/10/behavior-changes-10#execute-permission)。这不是“Android 完全没有进程 API”的断言，而是说明“下载 Linux JRE → chmod → 普通 spawn”不能作为本项目已可行的运行方案。代码装载、包来源和分发政策必须分别审查。

### 2.2 参数与依赖需要受控 overlay

纯领域解析之后，Android 计划应绑定 MC/loader、JRE、Java bindings/native、renderer、ABI/API、原始 profile 摘要和支持能力。保留普通 Java 库的可证明依赖与顺序，精确替换匹配组合的 LWJGL/GLFW/OpenAL 等集合；不能靠“文件名含 lwjgl 就全删”解决。

classpath、native search path、AWT/headless、内存和分辨率由 Android adapter 输出。账号与资源占位符的有效语义需要保留，但完整 argv、令牌和含凭据的计划不得进入 JS、通知、公开日志或共享临时文件。

## 3. 固定成熟源码提供的证据

以下只证明成熟项目采用了这些机制，不证明代码已集成、发布二进制已验证或 HCMCL 具有相同兼容范围。链接固定完整 commit，避免将可移动分支或 CI `latest` 当作供应锁定。

### 3.1 Pojav：历史参考，不作为当前维护承诺

固定提交：`b12ad048157b3aa255d078c235dd4571e1900309`。该仓库已归档，固定 [README](https://github.com/PojavLauncherTeam/PojavLauncher/blob/b12ad048157b3aa255d078c235dd4571e1900309/README.md) 明示停止支持，因此本文不把它作为长期维护承诺。

| 机制 | 固定源码与观察 |
| --- | --- |
| JRE 动态装载与启动 | [JREUtils.java:76–95](https://github.com/PojavLauncherTeam/PojavLauncher/blob/b12ad048157b3aa255d078c235dd4571e1900309/app_pojavlauncher/src/main/java/net/kdt/pojavlaunch/utils/JREUtils.java#L76-L95) 显式装载 libjli/libjvm/libjava/net/nio/awt/fontmanager/OpenAL；[280–327](https://github.com/PojavLauncherTeam/PojavLauncher/blob/b12ad048157b3aa255d078c235dd4571e1900309/app_pojavlauncher/src/main/java/net/kdt/pojavlaunch/utils/JREUtils.java#L280-L327) 进入 `VMLauncher.launchJVM`，不是普通桌面 java 子进程。 |
| Android JRE 供应 | [android.yml:37–65](https://github.com/PojavLauncherTeam/PojavLauncher/blob/b12ad048157b3aa255d078c235dd4571e1900309/.github/workflows/android.yml#L37-L65) 使用 Android OpenJDK 多架构构建链；[NewJREUtil.java:37–43](https://github.com/PojavLauncherTeam/PojavLauncher/blob/b12ad048157b3aa255d078c235dd4571e1900309/app_pojavlauncher/src/main/java/net/kdt/pojavlaunch/NewJREUtil.java#L37-L43) 分别处理 universal 和 ABI binpack。不能据此信任任意 Linux 压缩包。 |
| 游戏进程与服务 | [Manifest:100–131](https://github.com/PojavLauncherTeam/PojavLauncher/blob/b12ad048157b3aa255d078c235dd4571e1900309/app_pojavlauncher/src/main/AndroidManifest.xml#L100-L131) 将游戏界面/服务放在 `:game`，包含 specialUse 前台服务设计；这是需单独实现的 Android 生命周期，不是 Tauri WebView 的自然能力。 |

### 3.2 Zalith Launcher 2：完整运行闭包的具体参考

固定提交：`dbf5a414504cdeb584d9e8fb437078b77b512ba4`。这是已读公开源码快照，不等于对其某发布 APK 的实测。

| 机制 | 固定源码与观察 |
| --- | --- |
| JNI / JLI | [jre_launcher.c:123–187](https://github.com/ZalithLauncher/ZalithLauncher2/blob/dbf5a414504cdeb584d9e8fb437078b77b512ba4/ZalithLauncher/src/main/jni/jre_launcher.c#L123-L187) 使用 `dlopen(libjli, RTLD_GLOBAL)`、`dlsym(JLI_Launch)`，并从 ART 的 native 入口进入游戏 JVM。不是一个通用 `JNI_CreateJavaVM` 调用就能覆盖。 |
| 运行库匹配和装载 | [Launcher.kt:83–111](https://github.com/ZalithLauncher/ZalithLauncher2/blob/dbf5a414504cdeb584d9e8fb437078b77b512ba4/ZalithLauncher/src/main/java/com/movtery/zalithlauncher/game/launch/Launcher.kt#L83-L111) 按 LWJGL/ABI 检查组件；[511–537](https://github.com/ZalithLauncher/ZalithLauncher2/blob/dbf5a414504cdeb584d9e8fb437078b77b512ba4/ZalithLauncher/src/main/java/com/movtery/zalithlauncher/game/launch/Launcher.kt#L511-L537) 装载 JRE 依赖与 OpenAL。Java JAR、JNI native、加载顺序必须共同锁定。 |
| Surface / renderer | [egl_bridge.c:84–99](https://github.com/ZalithLauncher/ZalithLauncher2/blob/dbf5a414504cdeb584d9e8fb437078b77b512ba4/ZalithLauncher/src/main/jni/egl_bridge.c#L84-L99) 管理 Surface 到 `ANativeWindow` 的获取与释放；[203–231](https://github.com/ZalithLauncher/ZalithLauncher2/blob/dbf5a414504cdeb584d9e8fb437078b77b512ba4/ZalithLauncher/src/main/jni/egl_bridge.c#L203-L231) 处理渲染线程和尺寸初始化。WebView/WebGL 显示启动器不等于桌面 OpenGL 游戏有 Surface。 |
| 输入桥 | [input_bridge_v3.c:189–220](https://github.com/ZalithLauncher/ZalithLauncher2/blob/dbf5a414504cdeb584d9e8fb437078b77b512ba4/ZalithLauncher/src/main/jni/input_bridge_v3.c#L189-L220) 提供事件泵；[632–657](https://github.com/ZalithLauncher/ZalithLauncher2/blob/dbf5a414504cdeb584d9e8fb437078b77b512ba4/ZalithLauncher/src/main/jni/input_bridge_v3.c#L632-L657) 提供键鼠事件。触控/相对鼠标、键码、IME 字符、滚轮、手柄和失焦清键均需协议。 |
| 兼容范围不是无限 | [GL4ESRenderer.kt:23–36](https://github.com/ZalithLauncher/ZalithLauncher2/blob/dbf5a414504cdeb584d9e8fb437078b77b512ba4/ZalithLauncher/src/main/java/com/movtery/zalithlauncher/game/renderer/renderers/GL4ESRenderer.kt#L23-L36) 指定 GL4ES 库及最大 MC 版本 1.21.4。它是上游代码中的限制，不是 HCMCL 的支持证明，也不能代替 GPU/驱动实测。 |
| 进程 / 服务 | [Manifest:115–178](https://github.com/ZalithLauncher/ZalithLauncher2/blob/dbf5a414504cdeb584d9e8fb437078b77b512ba4/ZalithLauncher/src/main/AndroidManifest.xml#L115-L178) 体现游戏/JVM 的独立进程；[GameService.kt:35–72](https://github.com/ZalithLauncher/ZalithLauncher2/blob/dbf5a414504cdeb584d9e8fb437078b77b512ba4/ZalithLauncher/src/main/java/com/movtery/zalithlauncher/game/launch/GameService.kt#L35-L72) 使用前台通知和 `START_NOT_STICKY`，不承诺后台永久存活。 |

ART 与 HotSpot 的 `JavaVM` / `JNIEnv`、线程 attach 和对象引用不能交叉使用；独立 `:game` 进程内也仍存在 ART 边界。参见 [Android JNI 官方建议](https://developer.android.com/training/articles/perf-jni)。须采用经过验证的窄桥接设计，不大范围复制启动器 UI 或整个项目。

## 4. 最小实现范围与生命周期契约

以下是后续代码小批的设计边界，不表示这些拟议文件已经存在。本批没有更改任何运行代码。

### 4.1 前置层：本机可以先推进，不需要下载或加载 JRE

建议新增纯 Rust `src-tauri/src/android_runtime.rs`，承载 `LaunchPlan`、能力矩阵、单次票据、会话 epoch 和明确错误；新增 Android `runtime/HcmclRuntimePlugin.kt` 与 `runtime/RuntimePackage.kt`，提供 internal-only 的启动/停止/状态协议及已选包验证。仅在现有 [runtime.rs](../src-tauri/src/runtime.rs) 和 [lib.rs](../src-tauri/src/lib.rs) 增加必要的窄分发/插件接线。

最低要求：

- WebView 只提交实例 ID、账号 ID 等业务字段，不开放任意命令、argv、native 路径、动态库或 PID 操作；后台读取已保存账号。
- 包验证覆盖 manifest、ELF ABI、大小/摘要、条目/路径、符号链接和组合版本；此阶段不自动下载、不 `dlopen`。失配或缺资源明确返回错误，不发布虚假的 `running`。
- 同一会话的单次票据绑定窗口/epoch，取消、IPC drop、迟到结果和重放均有可测试规则；UI future 丢弃不应导致已开始的宿主事务失去所有者。
- 状态区分 accepted/preparing、VM 启动、可观察的运行阶段、exited、failed、cancelled；`accepted`、PID 非零或 HelloJVM 成功均不等于 Minecraft 菜单可交互。
- 凭据不经 JS、Intent 明文参数、通知、公开日志或共享文件传递；跨进程通道限定本应用和会话，必要时使用受限 Binder/FD/内部票据。

### 4.2 运行层：先锁定组件供应和许可，再实现窄适配

最小拟议范围为 Android `runtime/HcmclGameActivity.kt`（Surface/输入）、`runtime/HcmclGameService.kt`（`:game` 前台服务与状态）、`runtime/HcmclNative.kt`，以及 `app/src/main/cpp/CMakeLists.txt`、`hcmcl_runtime_bridge.cpp`。它们应包装选定的成熟引擎窄 ABI，不自造半套 GLFW 后就宣布完成。

还需后续明确的小批修改 [Manifest](../src-tauri/gen/android/app/src/main/AndroidManifest.xml)、[app 构建配置](../src-tauri/gen/android/app/build.gradle.kts) 和组件锁定/第三方通知资料：独立非导出 Activity/Service、准确的 FGS/通知权限、NDK/CMake/ABI、匹配的 JAR/AAR/.so 与逐项来源。**这些都不在本轮文档改动中。**

生命周期必须满足：

1. JRE 初始化、解包和游戏执行不阻塞主线程；Surface/Activity 操作遵守 Android UI 线程要求。
2. 游戏进程承载自身 env/cwd/信号/退出桥，结束后销毁并允许重启，不杀 Tauri 主进程。`:game` 是同 UID 的崩溃隔离，不是 `isolatedProcess` 安全沙箱，仍可能访问同 UID 文件。
3. MainActivity 重建只重新附着状态；Surface 丢失/恢复按 generation 获取和释放 native window；失焦释放抓鼠标和按键，音频焦点/设备变化单独处理。
4. stop 要等待实际进程退出和 native/线程资源回收，再释放 running 槽；取消不是伪撤销，已提交的存档或外部副作用不能谎称回滚。
5. 处理前后台、通知停止、锁屏、低内存、OOM、崩溃和系统杀进程；不自动重启携带旧令牌的 JVM，也不承诺 FGS 永远存活。
6. 游戏根使用应用内可寻址目录；现有 SAF 负责授权复制/导出，不把 `content://` 猜成 Java cwd 或 POSIX path。直接在任意文档树运行整个游戏是另一项文件系统工程。

## 5. 组件供应与许可：仍需明确决策

首验运行闭包至少包括：Android/Bionic Java 17 ARM64、对应的修改版 LWJGL3/GLFW Java 与 native、OpenAL、选定 renderer 及 EGL/GLES 或 Vulkan 依赖，以及所需的 freetype/AWT/Cacio 等辅助组件。宿主构建 JDK 不是手机内运行的 JRE；ABI 相同也不代表库可加载。

| 待定项 | 决策与证据要求 |
| --- | --- |
| 设备与 renderer | 锁定首验设备/API/GPU/驱动、页大小、一个 renderer 和必要扩展。GL4ES、Mesa/Zink 等只是候选路线，不承诺全部 GPU 或着色器。 |
| 源码与供应方式 | 受控源码构建还是合法现成组件；APK 随包还是经签名 manifest 更新；明确维护和漏洞修复责任。固定源 commit、构建工具链、ABI/API、大小和密码学摘要，不能直接信任可变 `latest` CI 产物。 |
| 完整 native 闭包 | 校验全部 ELF 依赖、符号、加载顺序、打包位置和适用的 16 KiB 页要求，不只检查 Tauri 的 Rust .so。失败必须可诊断和回退，不降 target 或关 TLS 校验。 |
| 分发与后台政策 | target SDK 36 的前台服务类型、specialUse 用途、通知、后台运行及发布渠道政策需要确认；不复制上游整套权限。麦克风等额外能力另行收口。 |
| 许可证和相应源码 | 每个 JRE、JAR、AAR、.so、字体、补丁与依赖形成清单，保留版权/许可/修改记录，准备适用的相应源码和替换/重链接材料。不得将上游总许可证标签当作全包审计。 |

### 5.1 许可证边界不由进程隔离自动解决

当前根 [LICENSE:33–57](../LICENSE#L33-L57) 包含非商用、禁止出售和派生限制。不能把这些额外限制施加于摘取的 GPL/LGPL 覆盖代码，也不能因为项目作者拥有自有代码版权，就推定能豁免第三方条件。

- 固定 [Pojav LICENSE](https://github.com/PojavLauncherTeam/PojavLauncher/blob/b12ad048157b3aa255d078c235dd4571e1900309/LICENSE) 为 LGPLv3；采用时须按实际复制、修改和组合方式核对义务。
- 固定 [Zalith Launcher 2 LICENSE](https://github.com/ZalithLauncher/ZalithLauncher2/blob/dbf5a414504cdeb584d9e8fb437078b77b512ba4/LICENSE) 及 Kotlin 头涉及 GPLv3 或更高版本，不能直接摘入后统一套上本项目非商用限制。
- Zalith 的 [jre_launcher.c 文件头](https://github.com/ZalithLauncher/ZalithLauncher2/blob/dbf5a414504cdeb584d9e8fb437078b77b512ba4/ZalithLauncher/src/main/jni/jre_launcher.c#L1-L20) 是 GPLv2 + Classpath Exception，说明单文件与整项目许可可能不同；不能将例外扩大到所有代码。
- 修改版 LWJGL、GL4ES、OpenAL、Mesa/MobileGlues、AWT 和字体须针对最终选定制品分别核验；README 中的 BSD/MIT/LGPL 标签不足以授权整包再分发。
- 独立 `:game` 进程不自动消除许可义务。采用/发布方案需权利人及适当专业人员确认；本文不代替法律判断、不重新许可，也未替用户接受任何条款。

Minecraft 本体、资产和账号不属于这些开源运行栈的授权范围；仍须遵守 [Minecraft EULA](https://www.minecraft.net/eula) 与官方使用/分发要求，不将账号令牌、私人 API Key 或第三方签名材料放入发布包。

## 6. 分层验收：上一层成功不能冒充下一层

所有阶段当前均未由本轮执行。每层记录独立证据；失败不得通过伪成功、跳过校验或保留假 running 状态掩盖。

| 层级 | 验收内容 | 通过后仍不能声称 |
| --- | --- | --- |
| A：纯协议与计划 | 固定 metadata/overlay、ABI/hash/路径负例、未知组合、旧票据/重放、取消/drop/迟到结果、凭据不外泄；假后端不装载 JRE | Android JVM 已启动或游戏可运行 |
| B：构建与装载前检查 | Android 编译、R8/JNI 保留与符号、全部 ELF 依赖/ABI/页对齐、组件摘要和许可材料 | Minecraft 已显示或可玩；Rust 交叉检查只是其中一项 |
| C：自有 HelloJVM | 仅在 `:game` 运行自有测试程序，正常退出/强停/连续重进，Tauri 主进程不死，线程和锁实际回收 | LWJGL、renderer 或 Minecraft 已兼容 |
| D：图形、输入、音频 | Surface 三角形、旋转/锁屏/恢复、键鼠/触控/IME、OpenAL 声音和焦点切换 | Minecraft 世界可进入和保存 |
| E：首验原版闭环 | ARM64 + Java 17 + vanilla 1.20.1 + 锁定 renderer；从合法来源安装/校验，菜单交互、进世界、移动/视角/声音、保存退出、连续重启 | 全版本、全 GPU、加载器或全部功能支持 |
| F：故障与生命周期 | 断网、空间不足、坏包、OOM、Activity/Surface 销毁、IPC drop、前后台和通知停止；真实收尾后可再启动，日志脱敏 | 系统不会杀进程、后台永久运行或任意副作用可撤销 |
| G：扩大矩阵 | 按 MC/JRE/loader/模组原生依赖/GPU 逐组合验证；Forge/NeoForge 包括 installer/processor 和取消回滚 | 上游支持范围自动成为 HCMCL 支持范围 |

真机记录至少包含 Android/API/target、ABI、GPU/驱动、页大小、MC/loader、JRE/LWJGL/renderer 源 commit 与制品 hash、内存配置及脱敏失败日志。模拟器能验证部分协议，不能代替真实 GPU、性能、功耗和后台策略验证。

## 7. 本轮完成与未完成

**已完成：**固定公开源码证据、本仓库缺口和首验候选的文档化；最小实现范围、供应/许可待定项和分层验收边界整理。

**未完成、不能声称完成：**运行时供应锁定/完整许可证审计、任何 JRE 或原生组件集成、Android 游戏构建/装载、真实账号登录、HelloJVM、Surface/音频/输入实测、Minecraft/加载器运行、跨 GPU/设备兼容性及性能验证。

后续以受控小批推进前置协议与包验证，再依据组件和许可决策集成运行层。本文不把已有移动端安全/文件适配或桌面迁移结果降格为“没有实现”，也不把它们升级为“Android 已支持 Minecraft Java”。

### 7.1 构建入口、资源、debug 与开发授权：本地证据及移动限制

此补记记录构建入口及 Lead 收集的局部验证结果，不更新第 6 节的运行栈验收结果。Task95 的[桌面窗口模式](<../src-tauri/src/desktop_window_modes.rs#L263>)承接既有 setDesktopMode/securityFullscreen 两通道，移动端仍明确拒绝；Task96 的[开发授权六通道](<../src-tauri/src/devmode.rs#L321>)为 status/sendCode/verify/setEnabled/revoke/setSecurityMode，经[专用路由](<../src-tauri/src/lib.rs#L248>)读取[授权快照](<../src-tauri/src/storage.rs#L431>)并以 epoch/Permit 与 [Storage CAS](<../src-tauri/src/storage.rs#L437>)阻止迟到提交。固定官方 HTTPS 不携 product，禁代理、重定向与自动重试；token 只留内部，main 窗只接收脱敏状态。关闭开关仅保留本进程已验证且未失效的 grant，禁用时 effectiveSecurityMode=full，磁盘快照不能建立授权信任。mode 保存与授权失效在同一 blocking 任务执行，caller 丢弃也不跳过失效；owned worker 保留至真实持久化收尾。四个开发工具通道仍明确未实现 Err。这些源码路径和本地夹具不证明真实 PHP、邮箱/账号、设备网络、原生 GUI 或完整 worker E2E。

**Task96 最终 clean 证据（Lead 收集）**：Windows 串行 Rust 全量 **709 passed / 0 failed / 0 ignored，138.25s**（`--test-threads=1`，main 0）来自会话输出；预期工作区日志不存在，不添加伪造链接。此前 all-target **703/2** 的两个 installer 时序夹具失败与独立串行 installer **10/0/0、8.43s**保留为历史；不能覆盖失败记录。Linux clean [全量测试 733/0/0、11.65s](<../.local/tauri-task96-final-linux-tests-20261110.log#L1938>)，实际编译 [hcmcl-tauri](<../.local/tauri-task96-final-linux-tests-20261110.log#L382>)、测试编译 2m16s（[日志](<../.local/tauri-task96-final-linux-tests-20261110.log#L1200>)），main 0（[日志](<../.local/tauri-task96-final-linux-tests-20261110.log#L1944>)）。Android 三个 target 均清理 package 后重新编译当前源码：[aarch64 52.74s](<../.local/tauri-task96-final-clean-aarch64-linux-android-20261110.log#L1883>)、[i686 27.81s](<../.local/tauri-task96-final-clean-i686-linux-android-20261110.log#L1883>)、[x86_64 27.07s](<../.local/tauri-task96-final-clean-x86_64-linux-android-20261110.log#L1883>)；各日志第 1 行为 `Compiling hcmcl-tauri`，第 836 行引用当前 `devmode.rs:363`。这些 Android 结果只证明 Rust cfg 检查，不是 Android 测试、native link、Kotlin/Gradle、APK/AAB、设备/provider、JVM/游戏或 SDK 许可接受。窄测 **12/0（8 devmode +4 Storage）**、node+web typecheck exit 0、桥 **12/0** 是 Lead 会话结果且未保证持久化日志；helper 与模拟提交不等于完整 Tauri/Storage/HTTP E2E。真实 PHP/账号/设备网络、原生 GUI/任务栏/焦点和游戏仍未验。

**前批 Round4 移动日志页证据（历史）**：[Windows Rust 657/0/0、32.90s](<../.local/tauri-mobile-debug-windows-tests-20261109.log#L1379>)（[实际测试编译 2m03s](<../.local/tauri-mobile-debug-windows-tests-20261109.log#L717>)）；[Linux Rust 679/0/0、5.86s](<../.local/tauri-mobile-debug-linux-20261109.log#L1779>)（[实际测试编译 2m26s](<../.local/tauri-mobile-debug-linux-20261109.log#L1095>)）。三目标仅 Rust cfg：[aarch64 38.71s](<../.local/tauri-mobile-debug-aarch64-linux-android-20261109.log#L1757>)、[i686 23.04s](<../.local/tauri-mobile-debug-i686-linux-android-20261109.log#L1757>)、[x86_64 28.32s](<../.local/tauri-mobile-debug-x86_64-linux-android-20261109.log#L1757>)。控制器 **11/0**、宿主及联动 **23/0**、日志组件 **16/0**、桥 **12/0** 为 **Lead 收集会话输出，日志未持久化**；这些是离线控制器/轻量 Hooks 与 dialog 模型，宿主测试中的 DebugLogWindow 使用 EmbeddedProbe 替身，不能声称完整 React 浏览器集成或硬件 Back/焦点/viewport 实测。[node+web typecheck](<../.local/tauri-mobile-debug-typecheck-20261109.log#L4>) Lead collect exit 0、[i18n 14/0](<../.local/tauri-mobile-debug-i18n-20261109.log#L27>)、[Vite 528 modules](<../.local/tauri-mobile-debug-web-build-20261109.log#L7>)/[2.91s](<../.local/tauri-mobile-debug-web-build-20261109.log#L25>)通过。**公共 API 的本地 dialog 打开/关闭已有实现和离线回执测试；裸移动 debug:open IPC 仍明确 Err。Rust cfg 不执行 Android 测试，不是 native link、Kotlin/Gradle、APK/AAB、设备、JVM/game 或 SDK 许可接受；真实焦点圈定、硬件 Back 与 viewport 仍未验证。**

**前批 debug 证据保留**：cfg 分离后 [Windows Rust 656/0/0、25.69s](<../.local/tauri-debug-final-windows-tests-20261109.log#L1378>)（[编译 2m22s](<../.local/tauri-debug-final-windows-tests-20261109.log#L717>)、[check 40.13s](<../.local/tauri-debug-final-windows-check-20261109.log#L717>)），[Linux Rust 678/0/0、6.49s](<../.local/tauri-debug-final-linux-20261109.log#L1778>)（[编译 2m24s](<../.local/tauri-debug-final-linux-20261109.log#L1095>)）均由 Lead collect exit 0。Android 首轮因桌面 unminimize 未 cfg 隔离而 ARM64 E0599，修复后 r2 三目标 Rust cfg 均 exit 0：[aarch64 20.30s](<../.local/tauri-debug-aarch64-linux-android-r2-20261109.log#L1757>)、[i686 28.28s](<../.local/tauri-debug-i686-linux-android-r2-20261109.log#L1757>)、[x86_64 27.87s](<../.local/tauri-debug-x86_64-linux-android-r2-20261109.log#L1757>)。**该前批仅 Rust cfg，当时尚无应用内日志宿主；当前移动页以本节 Round4 源码及证据为准，前批结果不背书本轮。** 最终 [轻量 Hooks/DOM UI 16/0](<../.local/tauri-debug-window-tests-r2-20261109.log#L17>)、[node+web typecheck](<../.local/tauri-debug-final-typecheck-r2-20261109.log#L4>) Lead collect exit 0、[i18n 14/0](<../.local/tauri-debug-final-i18n-r2-20261109.log#L27>)、[Vite 526 modules](<../.local/tauri-debug-final-web-build-r2-20261109.log#L7>)/[3.37s](<../.local/tauri-debug-final-web-build-r2-20261109.log#L24>)均已收集；UI 不是真实 React 浏览器滚动或 Tauri 原生窗口验收。上传只核对源码协议并执行离线夹具，没有本地 PHP server/POST 或 HTTP E2E。

**前批资源应用证据保留**：Windows [Rust 测试 639/0/0、29.35s](<../.local/tauri-resource-apply-windows-tests-20261109.log#L1357>)（[编译 3m16s](<../.local/tauri-resource-apply-windows-tests-20261109.log#L713>)、[独立 check 49.89s](<../.local/tauri-resource-apply-windows-check-20261109.log#L713>)）；Linux [Rust 测试 661/0/0、4.98s](<../.local/tauri-resource-apply-linux-20261109.log#L1757>)（[编译 3m34s](<../.local/tauri-resource-apply-linux-20261109.log#L1091>)）。Android 三目标 Rust cfg check 均 exit 0：[aarch64 70.00s](<../.local/tauri-resource-apply-aarch64-linux-android-20261109.log#L1727>)、[i686 36.56s](<../.local/tauri-resource-apply-i686-linux-android-20261109.log#L1727>)、[x86_64 37.87s](<../.local/tauri-resource-apply-x86_64-linux-android-20261109.log#L1727>)。这只是 `cargo check --locked --offline --all-targets`，不运行 Android 测试，不是 Kotlin/Gradle、native link、APK、设备/provider、JVM、游戏或 SDK 许可验收。下方 detector/local 的 581/603、Android 42.93/22.24/21.09，以及更早目录宿主/下载引擎的 552/572 均明确保留为前批历史，不用于背书 apply。应用本地事务夹具不证明真实公网、GUI/人工审批、Android 写入或 Minecraft 游戏流程。本文作者只核读源码、日志与会话回报并编辑本文档，未执行命令、联网、构建或测试。

- [debug 五条既有 invoke](<../src-tauri/src/debug.rs#L147>)仍为 **148 显式（147 业务/平台条件 +1 GPU Err）/64 余项**的一部分；其中 4 个 devmode Tools 通道明确 Err、其余 60 个没有业务处理，不能统称为最终 fallback；root 3/debug 5，Round4 JS 视图不增加已迁 IPC。事件现为 **11/23**（含既有 `devmode:changed` 新增生产者，未增加事件契约），Electron 合同仍 **239 = I212/S2/E23/L2**，契约正文未修改。[Rust 来源核验](<../src-tauri/src/debug.rs#L73>)保留桌面固定 debug 窗校验，仅 cfg(mobile) 额外允许受信任 main 来源读取；其他原生方法与 rendererLog 仍限主窗，[capability](<../src-tauri/capabilities/debug.json#L5>)仅事件监听/退订。[桌面窗口](<../src-tauri/src/debug.rs#L116>)仍走 native；[裸 mobile open](<../src-tauri/src/debug.rs#L141>)明确 Err，公共 [openWindow/closeWindow](<../src/tauri/bridge.ts#L28>)在 ready 后使用当前桥实例 WeakMap 控制器与 [应用内 HTML dialog 宿主](<../src/renderer/src/components/TauriMobileDebugHost.tsx#L36>)，挂载/关闭提交回执后才完成 Promise。[控制器](<../src/tauri/mobile-debug.ts#L48>)在未挂载、失败或 15 秒超时拒绝并请求撤页；迟到回执、卸载和 dispose 不复活旧视图，宿主关闭异常不保证即时撤页。仅 [Tauri 移动入口](<../src/renderer/src/main.tsx#L85>)挂载宿主；[embedded 日志组件](<../src/renderer/src/components/DebugLogWindow.tsx#L93>)沿用文档/系统语言，不改主文档标题和语言。返回/Escape、焦点恢复、安全区/44px 控件有源码及离线模型，真实浏览器和设备未验。isEnabled 仅表示 debugMode，不是窗口或上传许可。
- [日志缓冲](<../src-tauri/src/debug/buffer.rs#L8>)只驻内存，最多 2000 条/8 MiB，序列化单条 8000 字节、来源 128 字节；诊断取最新连续后缀最多 800 条/400 KiB。[renderer 摘要](<../src-tauri/src/debug.rs#L48>)不留正文，仅级别/至多 32768 字节长度/会话累计数。当前没有通用 Rust 游戏/安装器 stdout/stderr sink，不能把现有游戏/Forge 事件或 renderer 摘要称为完整调试日志。脱敏覆盖 known values/常见结构和模式，不保证发现任意未标注秘密。
- [主动诊断上传](<../src-tauri/src/debug/upload.rs#L250>)要求主窗显式一个 8–128 位十六进制 key，normal/minimal 且 feedbackLogConsent=true；isEnabled 不是同意。多次设置快照复核不能探知中间撤回后又同意（无单调 epoch）。白名单 DTO 不收账户/完整设置/私有游戏路径；日志 400 KiB、请求 512 KiB、响应 64 KiB。[固定 HTTPS](<../src-tauri/src/debug/upload.rs#L186>)禁代理/重定向/自动重试、连接 10 秒/请求 60 秒，只接受 ok=true 与安全整数 remaining。独立 slot/owned Gate 持有至阻塞读取真实完成，IPC drop/关闭仅 signal、未知 panic sticky；取消/超时不能保证服务端未接收，也不能假定额度未消耗。没有实际 PHP server/POST、HTTP E2E 或真机证明。
- debug 桌面阶段历史：[Windows](<../.local/tauri-debug-windows-tests-20261109.log#L1378>) 656/0/0、25.41s 与 [Linux](<../.local/tauri-debug-linux-20261109.log#L1778>) 678/0/0、5.77s 属前批 cfg 拆分前同一桌面逻辑；本轮 Round4 另列，不用该历史结果背书当前源码。[桥](<../.local/tauri-debug-bridge-tests-r2-20261109.log#L14>)与 [Android 准备](<../.local/tauri-debug-android-launcher-tests-r2-20261109.log#L13>)各 12/0。UI 首轮 9/7 是跨 VM Promise 同化续体未排空，Lead 仅将测试 settle 两 microtask 改为 setImmediate 排空，保留原断言与生产组件，最终轻量 Hooks/DOM 16/0；覆盖文本/三语、订阅先于快照、迟到/卸载/重复、3000 条上限和贴底/暂停，但不证明真实浏览器布局滚动、原生窗口或线上上传。
- [项目维护的 BuildTask](<../scripts/tauri-android-BuildTask.kt>) 与 [Android 工程中的 BuildTask](<../src-tauri/gen/android/buildSrc/src/main/java/top/johnnyblog/hcmcl/kotlin/BuildTask.kt>) 将 Node 可执行文件与项目内绝对 `tauri.js` 路径分开传参，不经 shell。Node 选择顺序为 Gradle 属性 `hcmcl.node`、环境变量 `HCMCL_NODE`、`NODE_BINARY`、最后 `node`。保留日志等级、release 与原有 target 参数；非零退出不触发备用进程重试。
- [准备脚本](<../scripts/prepare-tauri-android.mjs>) 只检查文件并恢复已审模板，不启动 CLI、Gradle、SDK 或联网。它要求实际安装的 `@tauri-apps/cli` 名称及版本为 `2.12.4`，校验维护副本与已审旧模板的完整摘要，仅兼容 LF/CRLF；未知模板明确拒绝，不进行宽泛替换。准备前后复核目标，使用同目录临时文件写入、同步及替换后读回；这不是对同 UID 外部并发修改的通用 CAS 保证。
- [npm Android 入口](<../package.json>) 在原 `tauri android dev/build` 前运行该准备脚本。不修改生成的 [Cargo 依赖路径设置](<../src-tauri/gen/android/tauri.settings.gradle>)、应用权限或默认 ABI 表；现有四项 ABI/arch/target 配对不代表四架构已构建通过。
- [离线回归脚本](<../scripts/test-tauri-android-launcher.mjs>) 包含 12 组合成夹具，涵盖含空格及中文路径、幂等、行尾、未知模板、错误版本、缺文件、仅目标文件改变和禁止启动子进程/网络。Lead 本会话收集 Node 实际执行结果 **12 通过 / 0 失败**，未保证持久化日志；这是合成文件系统夹具，不执行真实 CLI 或 Gradle。
- 前一批历史证据保留：[Windows Rust](<../.local/tauri-current-cancel-windows-tests-r1.log#L1178>) **535/0/0、21.15s**、[Android ARM64 Rust cfg](<../.local/tauri-current-cancel-android-check-r1.log#L1514>) **45.61s**；[进度桥](<../scripts/test-tauri-progress.mjs>) **12/0**、[账号导入](<../scripts/test-account-import.mjs>) **26/0** 为 Lead 会话结果，未保证持久化日志。它们验证各自局部参数/取消及合成来源，不证明 Android 游戏运行。
- 前批 `resources:open` / `download:engine` 的持久化日志为 [Windows Rust](<../.local/tauri-resources-engine-windows-r1.log#L1242>) **552/0/0、18.84s**（测试编译 2m29s）与 [Linux Rust](<../.local/tauri-resources-engine-linux-r1.log#L1631>) **572/0/0、5.35s**（测试编译 2m23s）。前端 typecheck exit 0、三语 i18n **14 通过 / 0 失败**、Vite **526 modules、3.81s** 为 Lead 会话结果，未保证持久化日志。`resources:open` 在 Android/iOS 明确拒绝桌面目录访问；`download:engine` 以 `backend:"tauri-rust"` 标识内置后端，`available:false/path:null` 沿用 Electron 可选 `.node` 未加载的语义，不是下载实测或网络健康结论。完整范围见 [迁移说明第 2.3 节](<tauri-migration.md#23-本次可引用的验证证据>)。
- 前批 Lead 收集三个 Android Rust target 的 `cargo check --locked --offline --all-targets` 均 exit 0：[arm64 日志](<../.local/tauri-resources-engine-android-arm64-r1.log#L1666>) **42.20s**，lib 268 warnings（49 duplicates）、test 99 warnings（90 duplicates）；[i686 日志](<../.local/tauri-resources-engine-android-i686-r1.log#L1666>) **24.87s**；[x86_64 日志](<../.local/tauri-resources-engine-android-x86_64-r1.log#L1666>) **24.31s**；i686 与 x86_64 分别同为 lib 268 warnings（49 duplicates）、lib-test 99 warnings（90 duplicates）。这只是 Rust cfg 编译检查，不执行 Android 测试、Kotlin/Gradle、native link、APK/AAB、设备/provider、JVM 或此启动器。
- 当前 [resources:checkUpdates/applyUpdate 分发](<../src-tauri/src/resource_updates.rs#L226>) 与 [组合根](<../src-tauri/src/lib.rs#L289>) 均已接入；local/metadataOnly 下检测在扫描、登记或联网前返回空数组，应用在登记或写入前明确拒绝；普通检测路径对实例 mods/resourcepacks/shaderpacks 做受控元数据检测，源码含取消、截止时间、上下文复核及 [resources:update-checked 事件](<../src-tauri/src/resource_updates.rs#L179>)。这是既有契约的静态接入；当前迁移文档计数为 **148 显式 / 64 余项、11/23 事件生产者**（147 业务/平台条件 +1 GPU Err；64 余项包括 4 Tools 明确 Err 与 60 未接业务处理），仍是 239 成员，不新增契约成员。[Apply](<../src-tauri/src/resource_updates/apply.rs#L195>) 沿用原三参数和严格 DTO，限同类型 Modrinth required 依赖，官方元数据重绑并核验哈希；额外 Install/Enable/Replace 须[主窗绑定全计划审批](<../src-tauri/src/resource_updates/approval.rs#L211>)，票据绑定计划摘要、单次消费且 180 秒单调时限过期；移动端额外依赖动作明确拒绝。owned worker 持有 Gate/root/job 到真实清理，[有界 WAL 恢复](<../src-tauri/src/resource_updates/transaction.rs#L420>)遇未知现场保留锁，不承诺任意断电恢复、同 UID 外部 inode CAS 或多文件原子提交。应用复用 `download:progress`，`resources:updated` 是未读到生产者，且不代表应用完成。源码/本地测试不证明真实公网、GUI/人工操作、Android资源写入或游戏闭环；旧 detector/资源宿主日志不背书 apply。
- 前批 detector/local 桌面回归：[Windows-r2](<../.local/tauri-resource-updates-windows-20261109-r2.log#L1328>) **581/0/0、19.05s**（[测试编译 3m32s](<../.local/tauri-resource-updates-windows-20261109-r2.log#L742>)，lib 93 warnings/12 duplicates、lib-test 54/43）；[Linux-r3](<../.local/tauri-resource-updates-linux-20261109-r3.log#L1722>) **603/0/0、4.98s**（[测试编译 2m45s](<../.local/tauri-resource-updates-linux-20261109-r3.log#L1114>)，lib 92/11、lib-test 53/43）。[local.rs](<../src-tauri/src/resource_updates/local.rs>) 为 781 行 revision `c5b38164c48609fbd8d06cc9b3ac55b00a5de4fa31c55f93817ae1b2e689628c`，candidate 哈希前检查逻辑大小预算/expected_size、metadata 64 KiB 分块取消与 limit+1 超限读取及解析前后取消检查的两项新增夹具均实际通过；16 GiB 是候选资源逻辑大小之和，不是全流程总 IO 上限，同步有界解析本身不保证即时响应取消。父模块 318 行 revision 为 `9524b5d5d0e1b2b7001be2ee277c052d9be922217b3918b28e114e5b2232adb9`，整批成功并复核后派发事件，派发仍可取消或失败。
- 资源检测首轮历史：[Windows](<../.local/tauri-resource-updates-windows-20261109.log#L1339>) **579/0/0、20.15s**（编译 2m13s，lib 94/11、lib-test 55/45）；[Linux-r2](<../.local/tauri-resource-updates-linux-20261109-r2.log#L1728>) **601/0/0、4.92s**（编译 2m23s，lib 93/11、lib-test 54/44）。CF schema/分页/策略/取消和本地 MC/loader/继承/变更等夹具通过，Linux [Unix 祖先 symlink/文件变更](<../.local/tauri-resource-updates-linux-20261109-r2.log#L1615>)通过。首次非 login Cargo PATH 127 后，Lead 补 `/home/johnny/.cargo/bin` 才真实重跑；环境失败不当作源码失败。其后的读取修补以最新 581/603 为准。
- 前批 detector/local 窄修 Android 三目标 Rust check 均 exit 0：[aarch64](<../.local/tauri-resource-updates-aarch64-linux-android-20261109.log#L1735>) **42.93s**、[i686](<../.local/tauri-resource-updates-i686-linux-android-20261109.log#L1735>) **22.24s**、[x86_64](<../.local/tauri-resource-updates-x86_64-linux-android-20261109.log#L1735>) **21.09s**，各 lib 276 warnings/52 duplicates、lib-test 104/94；Lead job `bash-f0776d70ef7248cc` collect 0。三个日志当前均为 1735 行，已覆盖首轮同名文件；首轮 45.86s/31.65s/31.44s 与 lib 277/52、lib-test 105/95 仅保留为历史会话记录。这只是最新 c5b38164 local.rs 的 Rust cfg 编译检查，不执行 Android 测试或链接，不代表 Kotlin/Gradle、APK/AAB、设备/provider、JVM/游戏或 SDK 许可接受。
- 前批 detector/local 前端为 Lead 会话 job `bash-0be9a71442734a20` exit 0：typecheck、i18n **14/0**、Vite **526 modules、3.96s**；未保证持久化日志，不证明真实 host/GUI/网络或 Android 游戏。前轮文档 validator job `bash-371cfd298e60406b` exit 0：**965 local / 33 external（未联网校验）/ 812 line + 2 heading**，239=I212/S2/E23/L2，LF SHA-256 `6ffe2170c9000b1f651095c5ef779da790f883919c6a8ba16c278a46cb75c36b`，diff PASS/errors=[]；它只验证执行时文档快照，不冒充本次新增链接的重跑结果，最终 validator 待 Lead 另收集。
- 当前仍未验证：真实 Android 项目中的 CLI 回调、Kotlin/Gradle 编译、Android native link、APK/AAB、设备/provider、HelloJVM、Surface、输入、音频与 Minecraft 游戏闭环。上述三个 target 仅是 Rust cfg 检查，SDK 许可仍未接受，不能用入口修补或 Rust cfg 结果声明 Android 可玩。

### 7.2 P0 AI HUD 与 Lite 当前证据补记（2026-11-10 21:36，UTC+08:00）

- 当前源码 `cargo check --locked --offline --all-targets` 通过 aarch64-linux-android、i686-linux-android、x86_64-linux-android 三目标；环境通过进程级 `CC_<target>`、`AR_<target>`、`RANLIB_<target>` 与 `CARGO_TARGET_<TARGET>_LINKER` 指向 NDK 30.0.16248370，未写入全局环境。各 target 仍有约 319 lib / 132 lib-test warnings。
- 这只是 Rust cfg 交叉编译检查，不等于 Android Gradle/Kotlin、native link、APK/AAB、设备/provider、JVM/JNI、Surface、输入、音频、Minecraft 游戏或 Android HUD 卡片实机验收；SDK license 仍未接受。
- HCMCL Lite 为独立验证线：WSL 普通 CTest 15/18 的缺口是 Secret Service 与身份环境；私有 keyring 隔离子集 6/6、隔离全套 27/27；Windows 当前源码重建因 `cmake: command not found` 未执行，旧缓存二进制不能代表当前源码，合成打包夹具 8/0 也不执行 PE/真实打包。
- 因而 Android 文档不把 Lite CTest、Tauri Rust cfg 或 AI HUD 状态夹具升级为 Android 游戏支持结论。

### 7.3 Tauri 主页隔离 Windows 验收补记（2026-11-11 13:13，UTC+08:00）

本条只记录主产品 Tauri 桌面 synthetic profile 的边界，不代表 Android 能力：

- 独立端口 19462 的干净隔离验收通过主页 HTTP 200、SDK 读操作、父 DOM 隔离、主文档无 marker 调用拒绝、generation 重载和导航拦截；进程随后退出。产物与记录留在 `.local`，不读取真实配置、账号或凭据。
- child 内部 Tauri 对象仍可见；验收器没有直接执行 child invoke，以免触发自定义主页自身的 `net:fetch` 探针并把夹具永久封锁。因此 child invoke 拒绝仍未证明。桌面 Rust 协议夹具随后验证了已消费票据与 `revoke` 后旧票据不能重放；这不改变 Android 没有原生子框架 guard 的边界。
- 这项桌面验收不改变 Android 的未验证边界：没有 Android Gradle/Kotlin、native link、APK/AAB、设备/provider、JVM/JNI、Surface、输入、音频或 Minecraft 闭环证据。
# AGENTS.md

给在本仓库工作的 AI / 协作者的**操作规则**。架构与目录说明见 [`docs/`](./docs/README.md)，
这里只写「会咬人的地方」和「怎么验证」。**踩过的坑都带现象与根因，别只抄结论。**

---

## 0. 三十秒速览

| 项 | 值 |
| --- | --- |
| 技术栈 | 主产品为 Tauri v2 + Rust + React/TypeScript；**Electron 版已归档到 `HCMCL_old/`（2026-11-14），不再随根构建**，仅作对照；Lite 为独立产品 |
| 样式 | **单文件** `src/renderer/src/index.css`（4000+ 行）+ Tailwind 工具类；皮肤靠 `[data-skin]` 切换 |
| 服务端 | PHP，位于 `server/`，**gitignore，不入库**，手动部署 |
| 当前版本 | 以 `package.json` 为准；当前 `0.8.0`（Android versionCode 9800，未出包），批次进度及验证时间点见 `plan.md` 第 43–55 节 |

```bash
npm run dev                # Tauri 开发（热更新）
npm run typecheck          # 必跑：web tsconfig（Electron 的 node tsconfig 已随归档移走）
npm run build:tauri:web    # 前端构建到 out/tauri
npm run build:tauri        # Tauri 完整构建 + 打包（Windows 出 NSIS；MSI 需要纯数字预发布段）
```

`HCMCL_old/` 内是 Electron 版完整源码、electron-builder / electron-vite 配置、打包脚本
（`build-all.mjs` 等）与只读对照测试；其内部相对路径保持原样，直接进该目录即可对照阅读，
不再从根目录运行。mac 构建工作流随归档移到 `HCMCL_old/build-mac.yml`（已停用）。

---

## 1. 硬性纪律

1. **不提交 `server/`**（含 SMTP 密码、管理员哈希）。用户要求"服务端文件"时，一律放进 `server/`。
2. **不擅自 `git commit` / `push`**，除非用户明确要求。
3. **不谎称已验证**。本机 **Electron 启动即退出**，Electron 界面与两宿主完整外观对照仍未实机确认；
   Tauri / SDL 的局部原生证据按实际平台、源码快照与场景记录，不能套用 Electron 的限制，也不能外推为全功能验收。
   未覆盖项必须写明「未验证」并给出依据，禁止用"应该没问题"糊过去。
4. **不为了推送而关闭证书校验**（`GIT_SSL_NO_VERIFY` / `sslVerify=false`）。
   本网络下 `git push` 报 `schannel: CRYPT_E_NO_REVOCATION_CHECK (0x80092012)`
   （无法访问证书吊销列表）——这是环境问题，**请用户在有条件的环境推送**，不要偷偷绕过。
5. 注释与界面文案用**中文**；i18n 三语（zh-CN / zh-TW / en）必须齐全。
6. 只改必要范围。用户说"只修这一处"就**不要**顺手重构别的模块。
7. 用户说"不要做测试了"时，就不跑功能测试，只做语法/构建校验。

---

## 2. Windows 文件完整性（Medium）—— **最容易踩且最费解**

**现象**：`electron-builder` 打包失败，报
`⨯ Exit code: 2. Command failed: ...-setup.exe`（像是安装包坏了，其实不是）。

**根因链**：工作区目录带 **Low** 完整性标签 → 新生成的文件继承 Low → NSIS 中间安装器是 Low 进程 →
写不进 `%TEMP%`（Medium）→ 安装器启动即退出码 2 → 整个 `--win` 步骤失败。

**正确做法（整棵树一起提，缺一不可）**：

```bash
icacls "<项目根>" /setintegritylevel "(OI)(CI)Medium" /T /C
npm run fix:integrity        # 只修 release/
npm run fix:integrity:all    # 整棵树（一次性修复）
node scripts/fix-artifact-integrity.mjs --check   # 只检查，有 Low 则退出码 1
```

**反面教材**：只把 `release/` 设为 Medium 会让构建**更糟** ——
`node_modules` 里的 `app-builder.exe` 仍是 Low，Low 进程写 Medium 目录被拒（写高）：
`⨯ mkdir ...\release\win-unpacked: Access is denied`。必须让构建工具自身也变成 Medium。

> Git Bash 会做路径转换，`icacls /setintegritylevel` 需加 `MSYS_NO_PATHCONV=1`。

---

## 3. 构建与发布

- **Windows 构建 / 测试的两道坎**（2026-11-14 定位，2026-11-22 再次确认后者仍在）：
  - `LINK : fatal error LNK1181: 无法打开输入文件“combase.lib”`：本机 Windows SDK
    （10.0.26100.0 `um/x64`，482 个 lib）**偏偏缺 `combase.lib`**（`keyring` → `windows-sys` 需要）。
    正规修复是 Visual Studio Installer 修复 / 重装 Windows 11 SDK；本机临时垫片在
    `.local/sdk-shim/combase.lib`（由 `dumpbin //exports C:\Windows\System32\combase.dll` +
    `lib //def` 生成，gitignore 不入库）。**`cargo test` 与 `tauri build` 都要带**，缺了只在前者或后者之一暴露：
    ```bash
    LIB="<项目根>/.local/sdk-shim" cargo test --lib
    ```
    PowerShell 下注意 `LIB` 用 `;` 分隔，且**必须把 sdk-shim 放最前**再拼 MSVC `lib/x64` 与 SDK 的
    `um/x64`、`ucrt/x64`，否则会先命中同名但缺失的目录而报同样的 LNK1181。
  - 链接过后测试 exe 启动即 `0xc0000139 (STATUS_ENTRYPOINT_NOT_FOUND)`：**测试可执行文件没有应用清单**，
    静态导入的 `comctl32.dll!TaskDialogIndirect` 只会绑定到 System32 的 v5.82（无此导出）。
    修复：`src-tauri/build.rs` 在 Windows target 输出
    `cargo:rustc-link-arg=/MANIFESTDEPENDENCY:…Common-Controls v6…`，让测试 / cdylib 链接自带 v6 依赖。
    诊断时先别信「SDK 已补齐」——用 `dumpbin //imports` + `mt -inputresource` 核实。
- **`tauri build` 的前端阶段可能被 Node 安全删除垫片拦住**（2026-11-22）：
  现象是 `beforeBuildCommand \`npm run build:tauri:web\` failed`，栈里是
  `[safe-delete] 操作失败: spawnSync …genie-trash…win32-x64.exe ETIMEDOUT`，
  根因是 vite `prepareOutDir` → `emptyDir` → `fs.rmSync` 被注入的 `NODE_OPTIONS=--require …shim` 劫持去走回收站。
  **这不是项目代码问题**：构建命令内临时清空该变量即可（只影响清空自身产物目录）：
  ```powershell
  $env:NODE_OPTIONS = ''; npx.cmd tauri build --bundles nsis
  ```
  别为此改 `vite.config` 的 `emptyOutDir`，也别删 `out/` 里别人的东西。
- **mac 无法在 Windows 上构建**（需要 `hdiutil` / `codesign`）：走 GitHub Actions
  `.github/workflows/build-mac.yml`，触发条件是 **push tag `v*`**。
- **Tauri 安装包覆盖旧 Electron 版**（2026-11-14 已用真实 Electron HKLM 安装实测通过）：
  - 旧 Electron 的注册身份不是 `com.hungercat.launcher`，而是 GUID
    `92545c4c-67bc-5d37-9e32-fd7da970a258`。卸载键位于
    `Software\Microsoft\Windows\CurrentVersion\Uninstall\<GUID>`；安装路径要读
    `Software\<GUID>` 的 `InstallLocation`。`src-tauri/installer-hooks.nsh` 分别查 HKCU / HKLM，
    NSIS `installMode` 必须为 `both`，复用旧目录并传对应的 `/currentuser` / `/allusers`。
  - 卸载器先复制到 `$PLUGINSDIR`，再以 `_?=` 同步执行 `/S /KEEP_APP_DATA --updated`，
    有界等待旧主程序消失（60×500ms）；卸载失败或残留必须中止安装，不能静默形成两版并存。
    目标目录之外的旧 Tauri 安装也会清理，但不删除应用数据。
  - `CheckIfAppIsRunning` 必须在 PREINSTALL 宏中展开；放在文件顶部函数会因
    `nsis_tauri_utils` 插件尚未注册而编译失败。它负责处理旧版运行中的占用，静默安装结束旧进程，
    GUI 模式先询问；标准用户 UAC、HKCU Electron 和 GUI 弹窗仍未实机验证。
  - 本机以真实 `0.7.5-alpha3` Electron 安装到 `C:\Program Files\HungerCat MineCraft Launcher`，
    再装 `8.0.0-dev1`：旧 GUID 项与主程序移除，新版留在原目录；错误版本另装的 Tauri 及其 HKCU
    卸载项也被清理，两个真实用户数据目录保持存在。最终包再次 `/S` 烟测后只有一个 HKLM 新版安装项。
  - 静默安装烟测用 PowerShell `Start-Process -Wait -ArgumentList '/S'`；`installMode=both` 后
    直接从 Git Bash 启动可能报 `Permission denied`（提升权限需求），不能据此认定包损坏。
  - 用户数据迁移在 `src-tauri/src/storage/migration.rs`：旧 Electron 在 `app.ts` 调用
    `app.setName('HungerCatLauncher')`，所以真实目录是 `%APPDATA%\HungerCatLauncher`，不是带空格的
    产品名。无新状态文件时首启迁移；已有状态文件但未迁移过时也会一次性补迁，成功落盘后写
    `.electron-migration-v1.json`，避免重复导入。补迁时新版非默认设置、现有账号及选中账号优先，
    默认项采用旧值。两条路径均用合成数据实测通过；合成夹具删除后真实目录已恢复。
  - 设置逐键白名单校验，账号字段白名单 + 凭据进 keyring，`uapis/ai` 两个 .bin 秘密经 DPAPI
    （Windows）/ basic_text 明文（Linux）解密进 `api:*` 槽位；homepages/wallpapers 有界复制
    （2000 文件 / 单文件 512MiB，不覆盖不删除）。macOS safeStorage（v10/v11）与
    feedback-session.bin 不迁移；CurseForge Key 在 Tauri 无对应字段，跳过。便携版 exe 旁 `./HCMCL`
    不在本模块范围。**迁移失败必须保留当前数据或回落默认数据，不能阻断启动**；测试构建不触发真实迁移。
- mac 产物默认**未签名**（`CSC_IDENTITY_AUTO_DISCOVERY: false`），首次打开需右键 →「打开」。
- **Windows arm64 没有原生下载器**（本机无 clang / arm64 MSVC 工具链）→ 自动降级为 TS 下载器，
  功能等价但更慢。不要以为打包坏了。
- **多架构 Windows 打包**（2026-11-22 实测 x64 / arm64 / ia32 全部出包）：
  ```powershell
  # 每个架构都要自己的 combase.lib（导入库是架构相关的），放在 .local/sdk-shim/<arch>/
  lib.exe /def:.local\sdk-shim\combase.def /machine:X86   /out:.local\sdk-shim\x86\combase.lib
  lib.exe /def:.local\sdk-shim\combase.def /machine:ARM64 /out:.local\sdk-shim\arm64\combase.lib
  # arm64 还要 clang（ring 的汇编），否则 cc-rs 报 failed to find tool "clang"
  $env:PATH = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\Llvm\x64\bin;$env:PATH"
  $env:NODE_OPTIONS = ''
  npx tauri build --target aarch64-pc-windows-msvc --bundles nsis
  npx tauri build --target i686-pc-windows-msvc    --bundles nsis
  ```
  产物在 `src-tauri/target/<triple>/release/bundle/nsis/`。**MSI 一律不要**：
  预发布版本号（`0.8.0-beta5`）的预发布段不是纯数字，wix 直接失败。
- **推送到 GitHub 时 schannel 报 `CRYPT_E_NO_REVOCATION_CHECK`**：这是网络侧吊销列表不可达，
  不是凭据问题。**不要关证书校验**；正解是换 TLS 后端并让它用系统根证书（校验照旧，只是不走 CRL）：
  ```powershell
  # 把 Windows 根/中间证书导出成 PEM 一次即可
  Get-ChildItem Cert:\LocalMachine\Root, Cert:\CurrentUser\Root, Cert:\LocalMachine\CA, Cert:\CurrentUser\CA |
    Where-Object RawData | Sort-Object Thumbprint -Unique | ForEach-Object {
      "-----BEGIN CERTIFICATE-----"; [Convert]::ToBase64String($_.RawData,'InsertLineBreaks'); "-----END CERTIFICATE-----"
    } | Set-Content "$env:TEMP\win-root-ca.pem" -Encoding ascii
  ```
  ```bash
  git -c http.sslBackend=openssl -c http.sslCAInfo="$TEMP/win-root-ca.pem" push origin main
  ```
  `gh api` 走 Go 的 TLS 栈，通常不受影响，可用它判断「网络通、只是 git 的 schannel 不行」。
- **Linux / macOS 由 `.github/workflows/build-tauri.yml` 构建**（本机只有 Windows 工具链）：
  - Linux：`ubuntu-22.04`（x86_64）+ `ubuntu-24.04-arm`（aarch64），出 `deb` + `AppImage`。
  - **Linux armv7l 只能交叉编译**（0.8.0 首次跑通，run `45819646535`）：托管运行器没有 armv7 硬件。
    `ubuntu-22.04` 上 `dpkg --add-architecture armhf`，再把 `/etc/apt/sources.list` 里每行 `deb `
    改写成 `deb [arch=amd64] `（否则 apt 认为 armhf 无源而静默跳过），另挂
    `ports.ubuntu.com/ubuntu-ports` 的 jammy 三组源（main/universe/restricted/multiverse），
    然后装 `libwebkit2gtk-4.1-dev:armhf` 等——`libc6-dev` 是 `Multi-Arch: same`，可以和 amd64 共存，
    不会再撞文件冲突。构建时设 `PKG_CONFIG_LIBDIR` 只指向 `/usr/lib/arm-linux-gnueabihf/pkgconfig`
    与 `/usr/share/pkgconfig`，`CC_/AR_/CARGO_TARGET_…_LINKER` 指向 `arm-linux-gnueabihf-*`。
    **只出 `.deb`**：AppImage 的 linuxdeploy / FUSE 运行时是架构相关的，交叉打包不成立。
  - macOS：**拿不到 arm64 运行器**（`macos-14` 报 `configuration 'macos-14-arm64-us-default'
    is not supported`，`macos-13` 已退役会一直排队），因此在 `macos-15-intel` 上**交叉编译**
    `x86_64-apple-darwin` 与 `aarch64-apple-darwin` 两个 target，各出一个 dmg。
  - **AppImage 打包会 panic**：`couldn't find a square icon to use as AppImage icon`——`bundle.icon`
    缺省候选里只有 `.ico`/`.icns`，没有方形 PNG。用 `npx tauri icon src-tauri/icons/icon.png -o <临时目录>`
    生成 32/64/128/128@2x 与 `icon.icns` 复制到 `src-tauri/icons/`，并在 `tauri.conf.json` 显式列出。
- **Android 由 `src-tauri/gen/android` 的 Gradle 工程构建**（2026-11-23 首次打通；x86_64 / x86 / arm64 均出包，arm64 自 0.8.0-beta10 起可用）：
  - 前置：Android SDK（`platform-tools`、`platforms;android-36`、`build-tools;36.0.0`）+ NDK `27.2.12479018`
    + JDK 17+；Rust 目标 `x86_64-linux-android` / `i686-linux-android` / `aarch64-linux-android`。
    本机 SDK 在 `F:\Android\Sdk`（非默认位置），构建前必须显式导出：
    ```powershell
    $env:ANDROID_HOME='F:\Android\Sdk'; $env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
    $env:NDK_HOME="$env:ANDROID_HOME\ndk\27.2.12479018"; $env:JAVA_HOME='C:\Program Files\Java\jdk-21'
    $env:NODE_OPTIONS=''
    npx.cmd tauri android build -t x86_64     # 或 -t i686 / -t aarch64
    ```
  - **JDK 的 PKIX 校验会挡住 Gradle 下载**：本机 TLS 由中间设备签发，JDK `cacerts` 不认，
    报 `unable to find valid certification path to requested target`。**不要为此关证书校验**，
    加 `$env:JAVA_TOOL_OPTIONS='-Djavax.net.ssl.trustStoreType=Windows-ROOT'` 让 JDK 直接用系统根证书库。
    若 `services.gradle.org` 仍被中断，从国内镜像（如 `mirrors.cloud.tencent.com/gradle/`）下 zip，
    再把 wrapper 的 `distributionUrl` 临时指向 `file:/…`（构建后记得还原）。
  - **必须关闭 Gradle 配置缓存**：`gradle.properties` 里保持 `org.gradle.configuration-cache=false`。
    维护版 `BuildTask.kt`（哈希锁定、调用 Tauri CLI）在执行期读 `project.providers`，开着会直接失败：
    `Invocation of 'Task.project' … unsupported with the configuration cache`。
  - `tauri android build` 出的是 **unsigned** APK，需自行对齐与签名：
    ```powershell
    zipalign -p -f 4 app-universal-release-unsigned.apk app-aligned.apk
    apksigner sign --ks <keystore> --ks-key-alias hcmcl --out <name>.apk app-aligned.apk
    apksigner verify --print-certs <name>.apk
    ```
    密钥在本机 `.local/android-keystore/`（`/.local/` 已 gitignore）。**同一应用升级必须沿用同一签名**，
    丢失后只能卸载重装。
  - `-t x86_64` 的产物文件名仍叫 `app-universal-release-unsigned.apk`（universal flavor + 只含该 ABI 的
    `abiFilters`），别误认为多架构包；用 `aapt2 dump badging <apk> | Select-String native-code` 核实。
  - **编译检查的任务名带 flavor**：改完 Kotlin 用 `:app:compileUniversalReleaseKotlin`；
    写 `:app:compileReleaseKotlin` 会报 ambiguous variant，报错文本像代码问题、实际是任务名不对。
    只改 Rust 时 `cargo check --target aarch64-linux-android --lib` 需要先导出
    `CC_aarch64_linux_android` / `AR_aarch64_linux_android` / `CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER`
    指向 NDK 27.2 的 `aarch64-linux-android24-clang.cmd`，否则报找不到 `aarch64-linux-android-clang`。
  - **出包前先把 `out/tauri` 挪走**：沙箱的删除钩子会卡在 `safe-delete ETIMEDOUT`，
    vite 清空目录失败导致整个 `tauri android build` 失败。改成 `Move-Item out\tauri .local\trash\…` 再构建。
  - **Android 已具备完整启动链路（0.8.0-beta11 起）**：JRE 原生库（含 `libjvm.so`）与 LWJGL for Android
    的 8 个图形库由 `scripts/prepare-android-runtime.mjs` 从 `.local/android-runtime/`（JRE tar + 
    `PojavLauncher.apk`，均已 gitignore）装进 `jniLibs/<abi>/`，类库镜像、`boot.jar` 与
    `assets/runtime/lwjgl/lwjgl-glfw-classes.jar` 进 `assets/runtime/`，再由 `src-tauri/src/android_jvm.rs`
    在进程内 `JNI_CreateJavaVM`。**构建 Android 前必须先跑 `npm run android:runtime`**。
  - **`useLegacyPackaging` 不能关**：进程内 `dlopen("libjvm.so")` 与 `java.library.path` 都需要
    `nativeLibraryDir` 下的实体文件，默认的「留在 APK 内直接映射」两条路都会落空。
  - **平台判据分两个**：`runtime::launch_supported()`（只排除 iOS）决定能否发起启动；
    `runtime::native_game_supported()`（仅桌面）决定是否走 spawn 子进程的桌面路径。
    `launch_start` 用前者，`spawn_process` / `detect_java` / 安装器用后者。
  - **Android 启动的三段式**：`runtime::start_in_process` 组装 spec → `android_host::show_game`
    （`ndk-context` 取 ART 的 JavaVM + Activity，经其类加载器在主线程调 `GameHost.start`）→
    `surfaceCreated` 里先 `JREUtils.setupBridgeWindow` 再起游戏线程 → JNI `nativeStartGame` →
    `android_jvm::launch` → `hcmcl.Boot.launch`。**顺序不能改**：GLFW 在建窗时就要拿到 `ANativeWindow`。
  - `net.kdt.pojavlaunch.utils.JREUtils` 的包名/类名由 `libpojavexec.so` 的 `Java_...` 符号决定，
    改动它等于让图形桥静默失效。
  - **触控层（0.8.0-beta12 起）**：`top.johnnyblog.hcmcl.controls` 是自研实现，与 FoldCraftLauncher
    没有任何代码关系（只参考了「虚拟按键可自定义」这一功能形态），不要往里粘第三方源码。
    布局是自有 JSON（`hcmcl.controls/1`，坐标 0..1 相对值）放在 `filesDir/controls/*.json`，
    与游戏数据分离；默认布局写在 `ControlLayout.default()`，不要在别处再复制一份。
    **FCL 是 GPL-3.0，代码级借用会传染**：用户明确要求「不得被认定为衍生作品」，
    参考来源只允许是公开文档、设备上的行为观察、Minecraft/LWJGL/OpenJDK 公开规范。
    边界与七项可对照差异写在 [`docs/android-fcl-parity.md`](./docs/android-fcl-parity.md)，新增触控能力前先读它。
  - **布局管理（0.8.0-beta16 起）**：编辑模式可复制当前布局为新布局、改名、切换、删除，
    并可导出 / 导入 JSON 到 `getExternalFilesDir(null)/controls`（数据线可取）。
    **切换布局前必须 `releaseAll()`**——旧布局按住的键在新布局里没有对应控件，不松开就永久卡住。
    导入要校验 `schema`，重名加序号而不是覆盖；新建入口是「复制当前」，不要改成空白画布。
  - **`ControlsView` 里的 `layout` 字段会遮蔽 `View.layout(...)`**：在 `EditText(context).apply { … }`、
    匿名内部类等处直接写 `layout.name` 会解析到 View 的方法而编译失败。必须先
    `val current = this@ControlsView.layout`（`rename()` 与 `duplicateLayout()` 都踩过，别第三次）。
  - **输入事件的三个跳**：`ControlsView`（ART）→ `GameHost.native*` → `android_host` 的 JNI 入口
    → `android_jvm::input`（把 UI 线程附着到进程内 HotSpot）→ `hcmcl.Boot.key/look/mouse/scroll`
    → `org.lwjgl.glfw.CallbackBridge` → `libpojavexec` 的事件队列。中间任何一环都不能省：
    触控事件属于 ART，GLFW 队列属于 HotSpot，两者只能靠 JNI 连。
  - **引导 jar 自带 `org/lwjgl/glfw/CallbackBridge`**：随包类库里的同名类是残缺的（只有 `sendData` 桩），
    图形层真正注册的是 `nativeSendKey/nativeSendChar/nativeSendCursorPos/nativeSendMouseButton/
    nativeSendScroll/nativeSendScreenSize`。引导 jar 在系统类加载器上，父优先委派会盖住类库版本；
    七个发送入口由 `android_jvm::register_input` 用 `dlsym("noncritical_send_*")` 主动登记，
    并优先 `RTLD_NOLOAD` 取**已加载的那份** `libpojavexec.so`（否则会得到没有窗口的第二份实例）。
  - **`GameHost` 不能用 `setZOrderOnTop(true)`**：那会让 Surface 盖住整个窗口，触控层就看不见了。
    改法是游戏期间把启动器的 WebView `GONE` 掉，退出时恢复。
  - **窗口尺寸只有桌面版**（0.8.0-beta13）：`game_window_size::resolve_options` 的桌面分支要真实采样
    显示器与窗口装饰；Android 走 `mobile_decision()`，尺寸 = 屏幕（`GameHost.displaySize()` 经
    `android_host::display_size()` 取回，横向、取不到则 1280×720），`fullscreen` 恒为 false
    （Surface 已占满屏幕，传 `--fullscreen` 只会让 GLFW 去找不存在的显示器）。
    设置页的「游戏窗口尺寸」整行在移动端不渲染。
  - **`free_memory_mb()` 的 `/proc/meminfo` 分支必须同时覆盖 `linux` 与 `android`**：Android 的
    `target_os` 不是 `linux`，漏掉就会以「无法测量剩余内存」拒绝启动。
  - **屏幕尺寸查询必须带超时**（0.8.0-beta14）：`android_host::display_size()` 在独立线程里调
    `GameHost.displaySize()`，`recv_timeout(2s)` 超时回落 720P 并记日志。JNI 调用一旦挂住就没有下限，
    裸 `recv()` 会把「尺寸拿不到」变成「启动页永久转圈」——现象和真正跑起来之前的等待完全一样，极难区分。
  - **多 Java 运行时由 `src-tauri/src/android_runtime.rs` 决定（0.8.0-beta15）**：按版本清单的
    `javaVersion.majorVersion` 选 17（内置）/ 21 / 25（首次启动下载）。`SOURCES` 表只登记**核对过 sha256**
    的来源，下载走流式 + 长度与 SHA-256 双校验，失败删 `.part`；`.tar.xz` 用 `lzma-rs`（纯 Rust）解，
    不引入 liblzma 的 C 代码。解压后必须给 `lib/**/*.so` 与 `bin/*` 补 `0o755`——xz 包里的权限是 0644，
    `dlopen` 需要可执行映射。完整性判据是 `lib/server/libjvm.so` + `lib/modules` + `release` 三者齐全。
  - **`JNI_CreateJavaVM` 不可重入，且 bionic 按 SONAME 去重**：同名 `libjvm.so` 第二次 `dlopen` 只会拿到
    先加载的那份，所以自定义运行时要 `dlopen(<home>/lib/server/libjvm.so)` **绝对路径**。
    `android_jvm` 的 `ACTIVE` 记住「本次建 VM 的主版本 + 目录」，换版本时明确返回「重启应用后再启动」，
    不能悄悄跑在旧版本上。
  - **清单里的桌面路径参数必须丢弃**（0.8.0-beta16）：`jvm` 段的 `-Djava.library.path=` /
    `-Dorg.lwjgl.librarypath=` 指向桌面目录，JVM 取**最后一个**同名属性，留着会覆盖算好的值。
    同时在 `android_jvm` 里补 `-Dorg.lwjgl.librarypath`（LWJGL3 的 `SharedLibraryLoader` 与 JNA 各认
    自己的属性，只设 `java.library.path` 时 `stb`/`tinyfd`/`openal` 会在跑到一半才报找不到库）、
    `-Djna.tmpdir` / `-Dio.netty.native.workdir`（默认 `/tmp` 在 Android 不存在）、
    `-Dfml.ignoreInvalidMinecraftCertificates` / `-Dfml.ignorePatchDiscrepancies`、`-Dlog4j2.formatMsgNoLookups`、
    `-Dminecraft.launcher.brand/version`、`-XX:-UsePerfData`。
  - **Java 8 在 Android 上没有可用来源**（2026-11-25 复核四条路）：Pojav 的 `jre8-*` 全是
    for sandboxed iOS（Mach-O）；Pojav Android 版只在需登录的 Actions 产物里；Termux 的 JDK8 按 Termux
    前缀构建、不可重定位；FCL 源码树里的 jre8 是 **pack200 形态**（`lib/resources.jar.pack`），
    而 `unpack200` 自 JDK 14 起已移除。声明需要 8 的版本按 17 启动并在控制台写明原因，
    要真正支持还得补一份 `javac --release 8` 的引导 jar（现有是 class 61，且完整性判据是 `lib/rt.jar`）。
  - **Android 暂不支持中途停止游戏**：进程内 JVM 不能按信号终止，`System.exit` 会连启动器一起退出；
    `launch_stop` 在 Android 返回可读说明而不是假装停掉。
  - **文字输入是第四类事件**（0.8.0-beta17）：`Boot.text(String)` 整串进来按码点切开发给
    `CallbackBridge.sendChar`，**不要**改成逐字一次 JNI（中文输入法一次提交多个字符）。
    Kotlin 侧 `GameKeyboard` 用 1×1 透明 `EditText` + 自定义 `InputConnection`，
    文字**绝不能留在输入框里**——留在里面会让下一次 `deleteSurroundingText` 的字符数对不上。
    改 `Boot.java` 后必须同时升 `src-tauri/android-boot/VERSION`，否则已装设备不会重新解压 assets。
  - **`windowSoftInputMode` 必须是 `adjustNothing`**：`adjustResize` 会在弹出输入法时改变
    `Surface` 尺寸，触发一次 `surfaceChanged` 与画面重建；输入法应当浮在画面上而不是挤动游戏。
  - **摇杆输出仍是离散方向键**：随包 `CallbackBridge` 没有轴事件入口，`kind=stick` 只是
    圆形外观 + 可见死区，**不要**在文案或文档里写成「模拟摇杆」。
  - **陀螺仪要注销**：`Gyro.release()` 在 `GameHost.hide()` 里调用，漏掉会一直挂在 Activity 上；
    姿态差超过 30° 一律当噪声丢弃，否则切前后台会让视角甩飞。
  - **运行时删除的拒绝对**：内置 17（随 APK）与「本次会话已创建过 JVM 的那一版」都不能删；
    后者是因为 `libjvm.so` 已在进程里，删目录只会让下次启动拿到残缺运行时。
  - **体积隔离**：`jniLibs/` 与 `assets/runtime/` 只进 APK，桌面打包不读这两个目录，Windows / macOS /
    Linux 安装包体积不受影响。这两处均已 gitignore，由脚本再生成。
    **前端只需拦截 iOS**（`runtime.tsx` 的 `NATIVE_GAME_SUPPORTED` + `PlatformBlockedNotice`），
    设置页 Java 区块在移动端换成内置运行时说明。移动外壳由 `<html data-platform>` 驱动
    （`App.tsx` 强制底部导航、隐藏自定义标题栏与指针光晕）。
  - **Android 路径必须走 `path_alias` 的「末级严格、祖先放开」策略**：`/data/user/0` 与 `/data/data`
    是同一目录的两种写法，且 `/data` 只有执行权限、没有读权限。任何「逐级 `symlink_metadata` 拒绝链接」或
    「从 `/` 逐级 `openat`」的写法在 Android 上都会误判。当前规则：末级（启动器自建对象）任何平台都拒绝链接；
    祖先级只在桌面拒绝（`crate::path_alias::link_is_fatal(final_segment)`）；目录锚点打不开时退回 `O_PATH`
    （仍可 `openat`/`fstat`，只是不能枚举）。新增路径校验代码前先看 `modpack/access.rs` 的 `native` 模块。
  - **Gradle wrapper 只在首次真正下载**：本机 `~/.gradle/wrapper/dists/gradle-9.6.1-bin/` 下已有完整解压副本，
    若 `gradlew` 又去 `services.gradle.org` 拉 zip（`Read timed out`），把已解压的 `gradle-9.6.1` 拷进 wrapper
    按官方 URL 算出的哈希目录并补 `gradle-9.6.1-bin.zip.ok`，即可离线复用，不必改 `distributionUrl`。
  - **Android 自有源码在 `HCMCL PE/`**（0.8.0-beta17）：引导 Java → `HCMCL PE/android-boot/`，
    手写 Kotlin → `HCMCL PE/app/src/main/java/`，由 `app/build.gradle.kts` 的
    `sourceSets`（`$rootDir/../../../HCMCL PE/app/src/main/java`）挂进 Gradle。
    **`generated/` 必须留在 `src-tauri/gen/android/app/src/main/java/`**：Tauri 每次构建会重新生成
    `Rust.kt` / `WryActivity.kt` 等同名类，搬出去就是两份定义、直接编译失败。
    `src-tauri/src/android_*.rs`、Gradle 骨架与 `scripts/*android*.mjs` 也不搬（Tauri 与 npm 脚本路径写死），
    原因与占用表见 `HCMCL PE/README.md`。改完 Kotlin 的验证命令不变：
    `.\gradlew.bat :app:compileUniversalReleaseKotlin`；只改引导 Java 时记得先跑
    `node scripts/build-android-boot.mjs`（`android:build` 不会自动重编 `boot.jar`）。
- **版本号涉及五个文件**，必须同时改：`package.json` 的 `version`、`package-lock.json` 的
  `version` 与 `packages[""].version`、`src-tauri/tauri.conf.json` 的 `version`、
  `src-tauri/Cargo.toml` 的包版本，以及 `src-tauri/Cargo.lock` 内 `hcmcl-tauri` 的版本。
  出 beta16 时就漏了 `package-lock.json`（停在 beta12 两处），而 versionCode 由 `build.gradle.kts`
  按版本名算 `8000 + beta*100`——只改前三个会出现包名与 code 对不上的错配。核对方式：
  ```bash
  grep -n '"version": "0.8.0-beta' package.json package-lock.json
  grep -n '^version = "0.8.0' src-tauri/Cargo.toml
  grep -n -A2 'name = "hcmcl-tauri"' src-tauri/Cargo.lock
  ```
- 提交前的最低验证：`npm run typecheck` + 全量 `node scripts/test-*.mjs` + `npm run build:tauri:web`。

---

## 4. 前端 / 样式陷阱

### 4.1 不要手写 `-webkit-backdrop-filter`

本项目的 CSS 构建会做**前缀去重**：同时写标准属性与前缀属性时，**只保留前缀版**，
标准属性被删掉 → 磨砂静默失效。**只写标准属性** `backdrop-filter`。

### 4.2 CSS 3D 模型：绝不用 `backface-visibility: hidden`

**现象**：玩家 3D 模型「随机缺一块」，且在整数角度停住时看得见。

**根因**：CSS 3D 没有 z-buffer，背面剔除靠「法线 · 视线」符号。面转到几乎侧对镜头时点积≈0，
浮点误差让判定**帧间翻转** → 面瞬间消失。自转动画是 `steps()` 离散的，长期停在整数角度，
正好把临界帧停得最久。

**做法**：封闭盒子**不要剔除背面**（远面由深度排序画在近面之后）。
回归测试：`node scripts/test-player3d.mjs`（会断言不该出现 `backfaceVisibility`）。

### 4.3 液态玻璃皮肤

- 控件（按钮/芯片/下拉）在 `[data-skin='mac']` 下曾被复位成**中性灰实块** → 难看。
  正解：**近实心白 + 镜边渐变 + 柔和阴影**（参考 Apple Liquid Glass 演示里纯白滑块的做法）。
- 双背景镜边技法：`padding-box` 层**必须不透明**，否则镜边渐变会铺满整个元素。
- 小件（开关滑块、分段选中珠）挂 SVG 折射 `backdrop-filter: url(#hc-liquid-glass)`；
  **不要**给大面积面板挂，`feDisplacementMap` 开销与面积成正比。
- 必须保留 `@supports not (backdrop-filter…)` 实色降级、`prefers-contrast: more`、
  `prefers-reduced-transparency` 分支。

### 4.4 i18n JSON 手改容易坏

追加键时注意**逗号**：锚点是中间项时，插入的每一项都要带尾逗号；锚点是最后一项则不能带。
**改完必须 `JSON.parse` 校验**再落盘。回归测试：`node scripts/test-i18n.mjs`。
`locales/ja/` 目前是空目录（既无 `meta.json` 也无分片），i18n 的自动发现不会把它当成可选语言；
新增键只需覆盖 zh-CN / zh-TW / en，但不要顺手删掉该目录。

### 4.5 资源更新是「按类型分栏 + 串行应用」

- 一次 `resources.checkUpdates` 会把**模组 / 资源包 / 光影**一起判定，结果放在同一个
  `updates: Record<path, ResourceUpdateInfo>` 里。任何计数、全选、批量动作都必须先按
  `kind` 过滤到当前分栏（`InstanceManagePage` 的 `tabKind`）——早期 `updatableCount` 直接数
  `Object.keys(updates).length`，在模组页把光影也算进去了。
- **批量更新必须串行**：`resources.applyUpdate` 每项都要拿根目录跨进程写锁并重扫目录，
  并发提交只会互排队，还让首项迟迟完不成。串行还有个好处——中途失败时已完成的项仍是完整状态。
- **批量中途不要 `reload()`**：刷新会换掉 `currentResourceSnapshot`，后续项的前置校验
  （`scopedUpdates[up.path] === up` 与快照路径比对）全部失效。统一在全部结束后 reload。
- 同样地，批量执行期间要禁用「检查更新」与单行删除 / 启停，否则会清空目标列表或改动文件集合。

### 4.6 自定义主页：只启动核对一次，运行期占住文件

- **联网核对只在启动时做一次**：`pages/customhome/probe.ts` 是模块级会话缓存，
  `ensureProbe(id)` 对同一 id 只发一次请求，失败也保持失败（`force` 只给用户点「重试」用）。
  `components/HomepageSession.tsx` 挂在 `Shell` 根上触发，所以用户不打开主页也会在启动时核对。
  **不要**把核对逻辑塞回主页组件——切页重挂会变成反复联网。
- **不再弹全屏闸门**：运行期给 `HomepageGate` 传 `inline`，卡片直接渲染在内容区，状态由
  「启动游戏」导航图标呼吸（`index.css` 的 `.nav-blink`）表达。只有管理页（`HomepagePage`）仍用弹窗。
- **旧哈希不能套到新内容**：`CustomHomePage` 放行时会重新 `read` 并比对 `sha256`，不一致就
  `ensureProbe(id, true)` 重新核对并中止放行。改这块时别把比对删了——会话复用之后它是唯一的兜底。
- **运行期占用主页文件**：`homepage:hold` 用 `Repository::hold` 打开 `homepages/<id>.html`
  并**把句柄留在 `homepage::State.held` 里**。Windows 上该句柄只授予 `FILE_SHARE_READ`，
  期间写入 / 改名 / 删除都会失败（`native.rs` 的 `homepage_native_windows_denies_shared_writes_and_deletion`
  已锁定这条行为）；Unix 没有等价强制语义，只保证读的是同一 inode。
  **改主页的通道（`importFile`/`download`/`installNumbered`/`update`/`remove`）会先自动释放占用**，
  否则导入会报「文件正被占用」这种看起来像权限问题的错误。

---

## 5. 主进程 / Electron 陷阱（代码已归档至 `HCMCL_old/`，仅供对照）

### 5.1 `settings.set()` 必须补回派生字段

`set()` 为了「派生字段不落盘」会 `delete` 掉 `portable` / `gameDirAbs` / `*KeySet`，
但**内存缓存必须补回**，否则任何一次 `set()` 之后：

- `gameDirAbs` 丢失 → 资源管理器拿到相对路径 `./.minecraft` → 报「路径不存在或已被移动」
- `portable` 丢失 → 「默认版本目录」不再置灰（重启又好了）

回归测试：`node scripts/test-portable-paths.mjs`。

### 5.2 便携版路径

`PORTABLE_GAME_DIR = './.minecraft'` 是**相对启动器目录**的写法；用前必须
`resolvePortablePath()`。便携版进程工作目录是解压出的临时目录，**相对路径在 `readdir` 里必然失败**。

### 5.3 Forge / NeoForge 安装器（三个连环坑）

| 现象 | 根因 | 做法 |
| --- | --- | --- |
| 运行安装器后永远不动 | `spawn` 默认给 stdin 一条**永不关闭**的管道，Java 一读 `System.in` 就永等 EOF | `stdio: ['ignore', 'pipe', 'pipe']` |
| 卡住且无日志，最后输出 `Task: DOWNLOAD_MOJMAPS` | 安装器要从 `piston-data.mojang.com` 拉 client mappings，国内不可达，它内部**没有超时** | 跑安装器**之前**用启动器多源下载预置到 `<gameDir>/libraries/<client_mappings.path>`（镜像层能把 `piston-data/v1/objects/<hash>` 改写到 BMCLAPI） |
| `安装器未生成版本配置文件` | 靠「目录是否新增」识别产物；上次中断已建出目录 → 永远判不出 | 改用 **JSON 的 mtime 快照**（新增或 mtime 变新），加命名规则兜底，并给删除操作加「10 分钟内才删」的守卫 |

另外：安装器必须有 **2 分钟无输出看门狗**与 **10 分钟总超时**，超时用
`taskkill /pid <pid> /T /F` 杀**进程树**（`child.kill()` 只杀直接子进程），
错误信息要附「最近输出」。

### 5.4 加载器安装状态不能放组件里

安装分两段（合并 profile → 下载依赖库），Forge 还要跑安装器（分钟级）。
状态必须放在 `loader-install-store.ts`（按 `dirId|instanceId` 索引、`useSyncExternalStore` 订阅），
否则**离开页面再回来状态全丢**，而且 `busyRef` 复原会导致**重复安装**。

### 5.5 就地安装语义

加载器装进**已有实例**：把 profile 合并进 `versions/<id>/<id>.json`（`mergeVersions` 产出自包含 JSON），
**实例 id / 目录 / 存档 / 资源包不变**；原版 JSON 备份为 `<id>.json.vanilla.bak`（**只备份一次**）。
不要做成"新建实例"。

---

## 6. 服务端（PHP）规则

1. **所有服务端文件必须在 `server/` 内**。维护脚本（`migrate-*` / `test-*`）也要放进去，
   并加 **CLI 守卫**（`PHP_SAPI !== 'cli'` → 404）+ `.htaccess` 屏蔽。
2. **命令行 PHP 可能比 Web PHP 旧**（面板环境常见）。禁用 8.1+ 语法：
   - ❌ 一等可调用 `array_map(rawurlencode(...), …)` → ✅ `array_map('rawurlencode', …)`
   - ❌ `mixed` 类型声明 → ✅ 不写类型
   - ❌ `match` 表达式 → ✅ `switch`
   - `str_contains` / `str_starts_with` / `str_ends_with` 在 `lib.php` 有垫片，可直接用
3. `curl_close()` 自 PHP 8.5 起废弃（会产生 Deprecated 输出污染 JSON）→ 用 `hc_curl_close()`。
4. `admin.php` 是**纯 HTML+JS（没有 `<?php`）**，所以配置状态一律通过 API 拿，不能在里面写 PHP。
5. **S3 私有桶**：绝不能把对象直链写进版本产物（会 `AccessDenied`）。
   写 `api.php?action=download&key=…`（下载代理现场签 5 分钟预签名 GET 再 302）。
   代理必须**白名单校验** key（只允许 data.json 里被引用过的对象）。
6. 上传直传 S3：`admin_s3_sign`（预签名 PUT）→ 浏览器直传 → `admin_s3_commit`。
   commit **重新推导对象键**，不信任前端传的 key。
7. **旧 Electron 客户端的更新兜底**（2026-11-14）：版本没有 Electron 产物时，
   `hc_update_for_target` 允许回退到同 target 的 Tauri 安装包（win→nsis/msi、mac→dmg、
   linux→appimage），载荷带 `migrateRuntime: 'tauri-v2'` 标记；有 Electron 产物时绝不回退，
   Tauri 客户端（`runtime=tauri-v2` 查询）也绝不回退 Electron 产物。选择顺序与既有
   `hc_pick_version_for_target` 一致（latestVersion 优先，其次 publishedAt 最新）。
8. 语法检查用 `php -l` 并以**退出码**判定（PowerShell 管道会让输出乱码）。

---

## 7. 测试约定

- 每个 `scripts/test-*.mjs` 输出 `结果：N 通过 / 0 失败`，退出码非 0 即失败。
- 多数测试是**源码级断言**（正则匹配实现）。**移动代码时必须同步更新断言**，
  否则会留下"测试通过但早已失效"的假绿。
- 测试文件常见自伤：
  - `const X = read(...)` 声明在使用之后 → **TDZ 报错**
  - 两个段落重复声明同名 `const` → 直接语法错误
  - 正则里 `\\` 与引号转义
- 现有测试清单：

```bash
# 一次跑全部（逐个执行，取结果行）；Electron 对照测试已随归档移到 HCMCL_old/scripts/
for t in scripts/test-*.mjs; do
  echo -n "$t : "; node "$t" 2>/dev/null | grep '^结果'
done
```

---

## 8. 交付前检查单

- [ ] `npm run typecheck` 0 错误
- [ ] 全量 `scripts/test-*.mjs` 全绿
- [ ] `npm run build:tauri:web` 成功（需要安装包时 `npm run build:tauri`；本机打包前先按第 3 节注入 `LIB` 并清空 `NODE_OPTIONS`）
- [ ] 新增/修改的 UI 文案三语齐全
- [ ] 改动涉及构建产物时：`npm run fix:integrity:check` 无 Low
- [ ] **改版本时五处一致**（第 3 节末尾的四个 `grep` 全部命中同一段版本号）
- [ ] **出 Android 包时**：`:app:compileUniversalReleaseKotlin` 通过 → `zipalign -p 4` → `apksigner sign` →
      `aapt2 dump badging` 的 `versionCode` 与 `native-code` 与预期一致 → 记录字节数与 sha256
- [ ] 报告里**明确写出哪些没有实机验证**及残留风险

---

## 9. 关于「无法验证」的诚实边界

本机 **Electron 无法启动**（启动即退出，多次尝试），因此 Electron 的界面、动画与交互，
以及 Electron / Tauri 完整外观对照仍不能声称已实机验证。

Tauri / SDL 已有部分隔离原生场景记录，只能证明对应平台与源码快照下实际执行的步骤。
合成授权不是服务端授权，空配置不是用户数据迁移，CDP / HWND 观察也不是完整产品验收。

以下事项仍须保留「未验证 + 依据 + 待验证点」：

- 未实际运行的界面外观、动画、交互与跨宿主一致性
- 真实发布包安装、干净机启动与数据迁移
- Forge / Minecraft / 真实账号、网络服务与设备端到端行为

不能用构建成功或历史局部 smoke 代替当前源码的这些结论。

---

## 10. Tauri v2 迁移专项验证纪律（2026-11-11）

- Electron 保留为功能与外观对照基线；共享 React / CSS 代码能够构建，不等于 Tauri 原生窗口、权限、游戏启动或数据迁移已经等价。
- Tauri / Wry 的 `destroy()` 只表示销毁请求已排队；只有精确实例收到 `Destroyed`，且 Window 与 Webview manager 两张表均释放后，才可认为标签可重建。异步收尾超时必须保留 owner / Gate lease，禁止把排队成功、UI 回调返回或窗口不可见当作完成。
- 退出链必须在 `app.exit` / `request_restart` 前尝试并等待固定语音热键线程、歌词查询与媒体线程、HUD、AI 悬浮球、开发工具及联机会话 / 弹幕 / 小窗各自的异步收尾；一项失败不能跳过其余项，任何一项未确认都保持进程存活并报告失败，不能在 UI 线程使用 `block_on` / 阻塞 `recv`。
- 当前双表核验使用 Tauri Rust `get_window` / `get_webview`，依赖 `unstable` 特性；升级时需复核 API 与事件顺序，不据此扩大前端 capability。开发工具存在或其清理未确认时仍拒绝重启；未知 builder 副作用保留 owner，不能自动清空为成功。
- OfflineTranslate 只能走专用固定 HTTPS 源和固定文件名，不能接受调用方 URL / 文件名，不能扩大通用 Modrinth / CurseForge 白名单；有界下载、禁止重定向、取消后等待真实 writer 收尾和 no-overwrite 事务必须保留。自算 SHA-512 仅证明本次提交字节一致，不证明来源真实性。
- 新增或冻结的原生/网络夹具必须注明是否执行。合成授权、空 profile、离线构建和源码夹具都不能冒充真实服务端授权、真实 URL、Minecraft / Fabric 兼容或发布验收；用户要求减少测试时只做与当前改动直接相关的定向检查。
- Windows GPU 策略必须在首个应用插件初始化时读取并冻结，不能移到 Tauri 应用 `setup`（配置主 WebView 已在它之前创建）。启动设置使用官方 `app.path().app_data_dir()` 及有界单布尔投影；不要从 WebView 的 LocalData 猜测设置路径或为了此查询初始化凭据库。进程附加参数保留继承值，不用单窗 `.additional_browser_args` 覆盖 Wry 默认；重启前还原本模块添加的禁用参数。`hardwareAccelerationBooted` 只表示启动请求快照，不等于实测 GPU 状态；非 Windows 策略不得冒充已接线。
- AI 悬浮球必须复用共享页面，采用固定来源、精确自有实例及独立业务白名单；其设置读取只投影 `language` / `aiVoiceEnabled`，不能借此开放账号、目录或主窗权限。几何与 native 操作留在 UI 回合，Storage 读写在后台且等待真实 writer，持久化只写 `aiBallX/Y`。事件使用指定 label 的 `emit_to`，不要把 `window.emit` 误当作单窗投递；主窗与悬浮球共用同一个一次性工具确认队列。
- 稳定 AI 球显示资源与执行中业务分别登记。重启许可必须对应同一 Gate 的全部精确存活资源，不能按数量抵消业务请求或提前 finish owner；冻结入口前后都须在 UI 回合核验固定来源、native 身份、manager 双表及同一资源票。运行中的操作 / writer、Closing / Uncertain / 缺失 owner 仍拒绝，真正释放继续等待既有销毁回执；其它域（含 HUD / 开发工具）的重启限制不因此放宽。
- Windows AI 语音只在 `aiEnabled && aiVoiceEnabled` 时登记固定 `Ctrl+Alt+V`，使用专用消息线程且不安装键盘钩子。投递前在 UI 回合核验精确自有 HUD / 球，状态事件用 `emit_to`；内部 `ai:voiceState` 仅返回开关布尔值，不能冒充系统注册成功。桌面 HUD 命令消费者与移动 / 内嵌只读卡片分离，仅开放快照、转写、聊天和状态四个入口，实际业务须活动可见且语音开启。录音仅显式切换时请求设备，60 秒 / 12 MiB 封顶；取消、页面结束及迟到权限 / 转写结果均须释放或失效，退出要等待热键线程真实结束而非仅发送注销消息。
- 游戏日志只从当前受管进程的既有有界输出消费点进入共享诊断，保留原 `launch:event` 与本地日志，不扫描历史日志、启动参数或账号对象。入缓冲前传入本次已知秘密并复用通用脱敏器，固定 `info` / `game`，不要把 stderr 自动判为错误；缓冲和诊断快照继续受条数及序列化字节预算约束。日志接入失败不能中止游戏，上传仍须原用户授权；通用规则不能保证识别任意未标注秘密，离线缓冲检查也不等于真实游戏或上传验收。
- 普通模组与 Fabric API 安装必须从目标实例的有界版本继承链确认 MC / 实际加载器，并将官方同一文件的兼容标签与哈希绑定；不能信任调用方 game 字符串、文件名或 Forge 子串推断 NeoForge。写入前和提交前复核同一配置证据、目录与隔离策略，配置变化则取消发布；不扫描全量模组来代替版本证据。required 依赖仍按共享界面的现有提示与用户确认处理，不暗装额外依赖，也不把三个标签夹具当作真实源、完整依赖闭包或游戏兼容验收。
- Windows 歌词只在 `hudEnabled && hudShowLyrics && mode != local` 时读取公开 SMTC 并查询固定网易云接口，不依赖游戏或 AI 开关。SMTC 的 `Cancel()` 只是请求，异步操作与 Gate 票必须持有到可确认终态；退出有界等待真实媒体线程，不能把超时或发送取消视为完成。曲目切换、关闭及迟到歌词响应须按 generation 失效；重复时间轴快照不能反复重锚，暂停、seek、逐句校准及系统时钟变化沿用 Electron 进度语义。共享三行卡片保留原样式与三语，HUD 只增歌词快照 / ±1 校准及精确自有窗口的穿透开关；穿透恢复只探测当前鼠标点，不保存轨迹。离线模型 / TSX 检查不等于真实 SMTC、联网歌词、系统热键、DPI 或鼠标穿透验收。
- 联机诊断使用官方 `app.path().resource_dir()` 下固定 `easytier/` 资源，不回落到开发 vendor、不接受调用方文件路径，也不为诊断启动 core / cli 或申请提权。文件状态及 Windows PE / 架构检查只证明当次基本可用性，不能当作签名、来源、许可或真实组网验收；Windows 资源映射只列明正式 core / cli，驱动和 vendor 不得混入。主窗来源、DocumentAccess 与 Gate 保持原门禁；后台读取和系统交接持有自己的请求票至真实返回，弹幕配置只投影既有五字段，不因诊断读取账号、密钥或通用游戏目录。权限查询只读当前进程令牌，未知错误不能伪报为普通权限；完整大厅、LAN、浮层、二进制许可 / 来源与双机互联需另行完成。
- Windows 受管 EasyTier 会话只从固定包资源复制 core 到本次 UUID 私有目录，保持只读程序句柄及目录身份；复制哈希只证明字节一致，不证明发行来源。进程先挂起、加入自有 Job 后再运行，保留 `--no-tun` / DHCP / 加密固定参数，不接受任意 exe、额外参数、不自动提权或按镜像名杀进程。就绪仅由当前代次的实际输出触发；成员只发布真实自己，不虚构对端。启动取消和 IPC waiter 离开后，后台 owner 仍持有 Job、管道线程、目录与 Gate，直到确认 Job 空、child 已回收、reader 已结束且私有目录清理完成才可变为 idle；收尾未知不得清票或允许退出 / 重启。启动中的内部通知不伪发空大厅退房事件；仅就绪与确认清理后广播。虚拟 IP 输出不证明 Minecraft、信令、LAN 转发或双机连通，纯状态夹具与编译结果不能代替原生验收。
- UDP 成员发现与聊天只能由当前受管 core 会话的同代次后台 owner 持有；不接受前端指定目的地址，不以报文中的 playerId / virtualIp 作为大厅身份认证。报文、成员表、离开抑制、去重表、历史、命令队列和每回合收发均设上限，控制字符与畸形字段须拒绝；正常多行聊天保留。聊天票持有至实际消费或拒绝，即使 IPC waiter 离开也不能提前 finish。退房先停止业务、释放唯一 socket、拒绝排队命令，再继续原 Job / child / reader / 目录收尾；不得以发送 player-left 或 UDP send 成功当作远端确认。物理 UDP 广播不等于 no-tun 跨网可达，协议无认证的边界与后续转发 / LAN 验收须明确保留。
- 联机 HUD 与 AI / 歌词共用同一窗口 owner，退房或 `closeHudWindow` 只能重算所有内容的需求，不能终止仍承载其它卡片的宿主。成员从真实活动会话投影，仅公开 `enabled` / `opacity` / 展示成员；HUD 内部快照不开放完整大厅、聊天、设置或主窗业务权限。设置在后台串行读取，只把小投影交付 UI；事件在短 UI 回合复核精确实例后按 label 投递并读取最新状态。前端等待 native listen 注册回执后再读无参快照，实时事件覆盖迟到快照，卸载须处理迟到 unlisten；Electron 与 Tauri 复用原卡片。`syncOverlays` 需要分别重算已接入的 HUD 与弹幕，不得用任一分支冒充其它联机浮层；编译 / 纯投影 / TSX 检查不证明真实窗口、玩家、DPI、穿透或组网验收。
- Windows 弹幕窗口必须保持独立固定来源、固定 `danmaku` label、透明置顶不抢焦点和鼠标穿透；只接收当前受管会话同代次的真实聊天，配置只投影既有五字段，不能读取账号、密码或主窗设置。页面必须先注册 `launcher:event` 监听再请求 `mp:danmakuConfig`，实时消息优先于迟到快照，卸载清理 listener / resize / timer。窗口 owner 只有在精确 `Destroyed` 且 Window 与 Webview manager 双表为空后才释放；控制请求绑定单调意图序号，过期请求报 superseded。预构建边界失败可在 UI 确认无 native 副作用后恢复，builder/native/队列不确定状态必须保留 owner / Gate；源码夹具和编译不等于真实窗口、DPI、穿透、socket 或组网验收。
- Windows 联机小窗使用固定 `mini` 来源、精确自有实例和独立窄白名单；外观只投影共享 Provider 所需字段，不读取壁纸、账号、目录或密钥。普通 close 只撤销本次显示请求并允许重开，应用退出才进入 terminal；二者都须等待精确 `Destroyed` 与 manager 双表为空后才释放 owner / Gate。状态与聊天投递不得在线程运行时内 `block_on`，前端先订阅再读快照，实时事件优先于迟到快照，卸载屏蔽迟到回调。内部 `mp:miniDrag` 不增加公开 LauncherApi 或通用 window capability；源码 / TSX 夹具不证明真实拖动、DPI、焦点、外观或联机验收。
- Android 进程内 JVM 的边界必须原样保留：`JNI_CreateJavaVM` 只在 `surfaceCreated` 之后调用（GLFW 建窗要 `ANativeWindow`），屏幕尺寸与其它 JNI 查询一律带超时并可降级，跨线程调用先 `attach_current_thread` 再释放。运行时选择按 `javaVersion.majorVersion` 走「内置 / 已下载 / 有来源可下载 / 明确拒绝」四条分支，**不允许**在无来源时静默换用别的版本而不写明。`SOURCES` 只登记核对过 sha256 的条目；新增来源前先下载实测哈希，不能把「上游文件存在」当作可下载。声明的验证只到 `cargo check --target aarch64-linux-android` 与 Kotlin 编译，编译通过不等于 Forge 能起、运行时可解压、触控可用——设备端表现（尤其 Java 8/21 的真实启动与触控手感）一律标注未验证。

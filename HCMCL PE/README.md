# HCMCL PE

Android（PE，Pocket Edition）版的自有源码。桌面版与 PE 版共用同一个 Rust 核心与前端，
这里放的是**只有 Android 才有的那一层**：引导 JVM、进程内宿主、触控界面。

## 目录

```
HCMCL PE/
  android-boot/                 引导 jar 的 Java 源码（最终打进 assets/runtime/boot.jar）
    VERSION                      布局版本；改动引导类后必须升，否则已装设备不会重新解压
    hcmcl/Boot.java              启动游戏、按键 / 字符 / 视角 / 鼠标 / 滚轮入口
    org/lwjgl/glfw/CallbackBridge.java  自有事件桥，登记到已加载的 libpojavexec
  app/src/main/java/             手写的 Kotlin 源码
    top/johnnyblog/hcmcl/MainActivity.kt
    top/johnnyblog/hcmcl/controls/     触控层：布局、绘制、输入、输入法、陀螺仪
    top/johnnyblog/hcmcl/runtime/      GameHost（ART ↔ HotSpot 的桥）、运行时安装器
    top/johnnyblog/hcmcl/files/        文件选择 / 导入导出插件
    top/johnnyblog/hcmcl/security/     密钥存储
    net/kdt/pojavlaunch/utils/JREUtils.kt  图形桥（类名由 libpojavexec 的导出符号决定）
```

`app/src/main/java` 由 `src-tauri/gen/android/app/build.gradle.kts` 的 `sourceSets`
挂进 Gradle 工程，路径是 `$rootDir/../../../HCMCL PE/app/src/main/java`。

## 不在这个目录里的东西（以及为什么）

| 内容 | 位置 | 原因 |
| --- | --- | --- |
| Rust 侧 `android_*.rs` | `src-tauri/src/` | Tauri 的模块在 crate 内解析；它们与桌面共用 `runtime`、`storage`，搬出去只能靠 `#[path]` 硬指，得不偿失 |
| Gradle 工程骨架（清单、`res/`、`build.gradle.kts`） | `src-tauri/gen/android/` | Tauri CLI 把该路径写死；`tauri android init/build` 只认这里 |
| `generated/`（`Rust.kt`、`WryActivity.kt` 等） | `src-tauri/gen/android/app/src/main/java/...` | 每次构建由 Tauri 重新生成；搬到别处会与生成物同名冲突 |
| JRE / LWJGL / `libpojavexec` 等二进制资产 | `src-tauri/gen/android/app/src/main/{jniLibs,assets}/` | 由 `npm run android:runtime` 从 `.local/android-runtime/` 装进来，体积大且不入库 |
| 构建脚本 | `scripts/*android*.mjs` | 根 `package.json` 的 npm 脚本与它们互相引用，移动会牵一发动全身 |

## 构建

命令都在仓库根（与桌面版同一套）：

```bash
node scripts/build-android-boot.mjs   # 编译引导 jar（源码在本目录）
npm run android:runtime               # 装 JRE / LWJGL / Pojav 图形库（首次或换版本时）
node scripts/prepare-tauri-android.mjs  # 恢复已审的 Android Node 启动器
npm run android:build                 # 正式出包（tauri android build）
```

注意：`android:build` / `android:dev` **不会**自动重编引导 jar，改过 `android-boot/` 就要先跑上面第一条。

出的是 **unsigned** APK，签名与对齐步骤见 `AGENTS.md`。

## 与 FoldCraftLauncher 的关系

PE 版的触控层、输入法桥、陀螺仪映射、摇杆与运行时管理都是本项目自写实现，
**不包含、也不链接 FoldCraftLauncher 的任何代码**。边界与逐项差异见
[`docs/android-fcl-parity.md`](../docs/android-fcl-parity.md)。

## 验证

本目录的改动至少要过两条：

```powershell
node scripts/build-android-boot.mjs                              # 引导 jar
cd src-tauri/gen/android; .\gradlew.bat :app:compileUniversalReleaseKotlin
```

真机行为（输入法、陀螺仪、摇杆手感、图形栈）无法在编译期验证，变更说明里必须写明「未验证」。

# Android 启动流程与触控层：行为对齐与独立实现说明

本文说明 Android 版「首次启动的依赖准备与启动方式」以及「玩家自定义虚拟按键」两块能力。
两块都参考了 FoldCraftLauncher（下称 FCL）的**公开行为**，但**没有使用其源码**。

---

## 1. 独立实现声明

FCL 以 **GPL-3.0** 发布。任何与其源码的代码级接触（复制、改写、逐行翻译、把类与字段
搬过来改个名字）都会让本项目被认定为衍生作品，从而被同一许可证传染。因此本项目对 FCL
只做**行为层面**的参考，具体边界如下。

**我们看了什么**

- FCL 仓库的公开说明文档，以及社区为其生成的架构说明（描述它「做了什么」，不含实现）。
- 在自己的设备上运行 FCL，观察其首次启动流程、目录布局与控制器的交互手感。
- Minecraft 版本清单格式、LWJGL3 属性名、OpenJDK 目录结构等**公开规范**——这些是
  Mojang / LWJGL / OpenJDK 的公共契约，不属于任何启动器。

**我们没有做什么**

- 没有把 FCL 的源码、类名、字段名、资源文件、JSON 布局格式复制进本仓库。
- 没有链接、反编译或再分发 FCL 的任何二进制。
- 没有沿用它的模块划分（`FCLLibrary` / `FCLCore` / `FCL` 三层）与任务体系。

**如何自证**

| 维度 | FCL | 本项目 | 结论 |
| --- | --- | --- | --- |
| 布局坐标 | 以参考分辨率为基准的像素值，运行时按屏幕缩放 | 直接存 0..1 的相对比例，不做分辨率换算 | 数据模型不同 |
| 布局文件 | 自有 JSON 结构（含按钮样式、动态摇杆等字段） | `hcmcl.controls/1` schema，字段为 `id/kind/x/y/w/h/label/keys/toggle/alpha/button` | 格式不兼容，无字段借用 |
| 布局标识 | 类名即标识（`ControlButtonData` 等） | `kind` 字符串 + `ControlKind` 枚举（`key/pad/look/mouse/scroll`） | 命名体系不同 |
| 输入注入 | 自建输入队列，经 AWT/LWJGL 自定义通道投递 | 直接调用随包 LWJGL 分支里 `org.lwjgl.glfw.CallbackBridge` 的 native 入口 | 注入路径不同 |
| 进程模型 | 起子进程跑 `java`，注入 `JAVA_HOME`/`PATH` | 进程内 `JNI_CreateJavaVM`，游戏与启动器同一个 Linux 进程 | 架构不同 |
| 运行时来源 | 四套运行时随 APK 分发，另支持导入 `.tar.xz` | 只随包内置 17；21/25 按需下载；无导入入口 | 策略不同 |
| 摇杆 | 模拟轴 + 动态摇杆（按住任意位置生成） | 圆形摇杆控件，输出八向离散方向键；死区可见可调 | 能力差异，见 §4.2 |
| 文字输入 | 自带输入法桥，游戏内直接唤出键盘 | 1×1 透明 `EditText` + 自定义 `InputConnection`，字符走 GLFW 字符回调 | 接口相同、实现独立 |
| 陀螺仪 | 陀螺仪/手势视角 | 姿态传感器（旋转矢量）取相邻差值 → 视角增量 | 数据来源与映射自建 |
| 运行时管理 | 随包多套 + 导入 `.tar.xz` | 内置 17 + 下载 21/25，可列出与删除；无导入 | 策略不同，见 §2.3 |

上面任何一行都不是「功能等价物」的通用说法，而是可逐项对照代码验证的差异点。

---

## 2. 首次启动：依赖准备

Android 上没有「解压 JRE 后 `exec bin/java`」这条路——Android 10 起应用私有目录不允许
执行，且 bionic 上的 JRE 需要针对 Android 交叉编译。本项目的准备分三段落，全部幂等。

### 2.1 APK 内的运行时 → 应用目录

`RuntimeInstaller` 把 `assets/runtime` 整个复制到 `filesDir/runtime`，成功后在
`filesDir/runtime.version` 写入版本串。下次启动比对版本串与 `jre/lib/modules` 是否存在，
一致就跳过——不能每次都复制上百 MB。

原生库（`libjvm.so`、`libpojavexec.so`、gl4es 等）**不进这一步**：它们随 APK 的
`lib/<abi>/` 由 linker 直接映射，重复解压只会浪费空间并带来两套库不一致的风险。

### 2.2 游戏依赖

版本清单解析 → 库文件、资源索引、客户端 jar 的校验与补全 → 原生库。

桌面版会把 `natives` 从 jar 里解出来再传给 `-Djava.library.path`；Android 版**跳过解压**，
直接把 APK 的 `nativeLibraryDir` 当作原生库目录。原因很直接：jar 里带的是 glibc 的
`liblwjgl.so`，在 bionic 上加载必然失败；真正能用的是随包的 Android 分支。

### 2.3 Java 运行时

- 版本清单声明 17 → 用随包内置的那套。
- 声明 21 / 25 → 首次启动下载（长度 + SHA-256 双校验）→ 解压 → 给 `lib/*.so` 补 `0o755`。
- 声明 8 → 目前无公开可用的 Android aarch64 构建，按 17 启动并在控制台写明原因。
- 已下载的 21 / 25 可以在「设置 → 游戏 → Java → 已安装的运行时」里删除以释放空间；
  内置 17（随 APK）与本次会话已经创建过 JVM 的那一版不可删除。

### 2.4 加载器

Fabric / Quilt 走 meta API 生成版本档案，属于普通依赖安装，Android 上可用。
Forge / NeoForge 的官方安装器是**桌面 java 进程**，需要 `exec` 一个 JVM——这条路在
Android 上被明确拒绝（`MOBILE_JAVA_BOUNDARY`），不会假装成功。

---

## 3. 启动方式：从版本清单到进程内 JVM

### 3.1 参数组装链路

```
版本清单 arguments.jvm / arguments.game
        ↓ 变量替换（${classpath} ${natives_directory} ${auth_player_name} …）
完整 argv（与桌面版完全一致）
        ↓ android_launch_spec()：按「第一个非 '-' 项」切分
classpath / jvm[] / main / args[]
        ↓ 交给 hcmcl.Boot.launch（JNI 静态方法）
游戏主类在子类加载器里被调用
```

切分规则有个坑：`--add-opens java.base/java.lang=ALL-UNNAMED` 这类「取值单独一个 token」
的 JVM 参数必须整体跳过，否则取值会被当成主类名。Forge / NeoForge 的清单正是这个形状。

### 3.2 运行期补的参数

版本清单只描述「游戏需要什么」，不含「在手机上跑需要什么」。下面这些由本模块补，
每一条都对应一个在 Android 上会真实出问题的默认值：

| 参数 | 不补会怎样 |
| --- | --- |
| `-Djava.library.path=<runtime/lib>:<nativeLibraryDir>` | `System.loadLibrary` 找不到随包库 |
| `-Dorg.lwjgl.librarypath=<同上>` | LWJGL3 的 `SharedLibraryLoader` 与 JNA 各认各的属性，只设前者时 stb/tinyfd/openal 会在运行到一半才报错 |
| `-Djna.tmpdir` / `-Dio.netty.native.workdir` → 应用临时目录 | 默认落在 `/tmp`（Android 不存在），JNA/Netty 解库失败 |
| `-Djava.io.tmpdir` / `-Duser.home` → `filesDir/runtime/{tmp,home}` | 默认指向不可写路径，且不会跟着 JRE 版本漂移 |
| `-Dfml.ignoreInvalidMinecraftCertificates` / `-Dfml.ignorePatchDiscrepancies` | Forge 对证书链与二进制补丁差异是硬失败，手机网络栈差异大 |
| `-Dlog4j2.formatMsgNoLookups=true` | 1.17 之前的版本受 log4shell 影响 |
| `-Dminecraft.launcher.brand` / `.version` | 崩溃报告与部分 mod 显示 `Unknown` |
| `-XX:+UseSerialGC` `-XX:-UsePerfData` `-Xrs` | 低内存设备上 G1 收益不明显；hsperfdata 无用；HotSpot 的信号处理与 ART 冲突 |
| `-Xmx` 由可用内存推导 | 默认堆在手机上不是太小就是超限被杀 |

清单里如果自带 `-Djava.library.path=` 或 `-Dorg.lwjgl.librarypath=`（桌面路径），会被
**丢弃**，由上面的值接管——保留会出现「后写的覆盖先写的」，最终指向不存在的目录。

### 3.3 与 FCL 的关键差异

FCL 起子进程，我们进程内建 JVM。代价与收益：

- 收益：不需要可执行目录，不受 Android 10 的执行限制；输入事件不用跨进程序列化；
  退出时能确定地回收。
- 代价：`JNI_CreateJavaVM` 不可重入，一个进程只能有一个 JVM。因此**换 Java 版本必须
  重启应用**，这一点在启动前就会明确报错，而不是悄悄跑在旧版本上。

---

## 4. 玩家自定义虚拟按键

### 4.1 现有能力

| 能力 | 说明 |
| --- | --- |
| 控件类型 | 按键 / 方向组 / 摇杆 / 视角区 / 鼠标键 / 滚轮 / 键盘 / 陀螺仪 |
| 布局坐标 | 屏幕比例，横竖屏与不同分辨率共用一套 |
| 多指 | 一根手指只归一个控件，互不打断 |
| 状态键 | 潜行、疾跑可设为「点按切换」 |
| 调整 | 拖拽位置、宽高独立调节、透明度、改绑定键、改鼠标键、复制控件、删除 |
| 多布局 | 复制当前为新布局、重命名、切换、删除 |
| 布局流转 | 导出到 `Android/data/<包名>/files/controls`，拷到别的设备再导入 |
| 误触保护 | 右上角小按钮进编辑模式；编辑期间不下发任何按键；退出前强制松开所有键 |
| 手感参数 | 视角灵敏度、Y 轴反转、滚轮步长、方向死区、陀螺仪灵敏度（与布局分开保存） |

编辑期间「不下发按键」不是体验问题而是正确性问题：改布局时角色还在跑，按住的键
会被玩家当成卡键。

### 4.2 输入法、摇杆、陀螺仪与手感参数（0.8.0-beta17 起）

| 能力 | 实现要点 |
| --- | --- |
| 文字输入 | 挂一个 1×1 透明 `EditText`，用自定义 `InputConnection` 接 `commitText` / `deleteSurroundingText` / `sendKeyEvent`，把字符转成 GLFW 字符回调、把删除与回车转成按键。输入框本身不留文字，避免二次删除错位 |
| 摇杆 | 圆形盘面 + 可拖动的摇杆头；输出仍是 W/A/S/D 组合（图形层没有轴通道） |
| 陀螺仪 | `TYPE_GAME_ROTATION_VECTOR`（回落 `TYPE_ROTATION_VECTOR`）→ 姿态角 → 相邻差 → 视角增量；超过 30° 的跳变当噪声丢弃 |
| 手感参数 | 视角灵敏度、Y 轴反转、滚轮步长、方向死区、陀螺仪灵敏度；存在独立的 SharedPreferences 键里，不写进布局文件 |

「手感参数不进布局」是刻意的：换一套按键位置不该把玩家调好的灵敏度重置。编辑模式工具栏的
「手感」入口即时写盘，陀螺仪正在开启时也会立刻用新参数重配。

文字输入这条链路的每一跳都不能省：`InputConnection`（ART）→ `GameHost.nativeText`（ART JNI）
→ `android_host` → `android_jvm::input`（附着到进程内 HotSpot）→ `hcmcl.Boot.text`
→ `org.lwjgl.glfw.CallbackBridge.sendChar` → `libpojavexec` 的事件队列。

### 4.3 刻意与 FCL 不同的地方

- **没有模拟摇杆 / 动态摇杆 / 手势模式**。随包的 LWJGL 分支只暴露按键、光标、滚轮三类事件
  入口，做模拟轴需要改图形层本身（等于 fork LWJGL 与 `libpojavexec`）。当前摇杆与方向组
  输出的都是离散方向键，手感与真模拟量有差距。
- **没有像素级自定义图标与配色**。当前用文字标签 + 统一圆角样式，键盘与摇杆图标是自绘的
  简单几何形状，不引用任何外部图片资源。
- **没有渲染器切换**（VirGL / ANGLE / Zink 等）：随包只有 `libgl4es_114.so` 一套转发层，
  其它后端既没有预编译产物也没有可替换的装载点。
- **没有分辨率缩放**：画面尺寸等于 `Surface` 尺寸，缩放要在 EGL 配置层做，属于图形层改造。
- **Forge / NeoForge 安装仍被拒绝**：官方安装器是桌面 `java -jar` 语义，Android 上不可 `exec`。

这些差异是能力取舍或平台阻塞，不是实现差异；如果要补齐，仍然走自己的数据模型与代码。

---

## 5. 合规自查清单

- [x] 未复制 FCL 源码、注释、类名、字段名、资源。
- [x] 未使用 FCL 的布局文件格式；本项目的 schema 字段与语义均自行定义（新增的
      `stick` / `keyboard` / `gyro` 三个 `kind` 也是自有取值，仍属 `hcmcl.controls/1`）。
- [x] 未链接或再分发 FCL 二进制。
- [x] 参考的三方规范（Minecraft 版本清单、LWJGL 属性名、OpenJDK 目录结构、
      Android `InputConnection` / `SensorManager` API）均为公开契约。
- [x] 随包的 JRE 17、LWJGL 分支另有其来源与许可证，单独记录在 `docs/` 的第三方声明中。
- [x] 输入法桥、陀螺仪映射、摇杆绘制与手感参数都是本仓库自写实现，未参考其源码结构。

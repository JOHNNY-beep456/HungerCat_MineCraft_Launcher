# 开发、构建与调试

## 一、环境要求

| 项 | 说明 |
| --- | --- |
| Node.js | 建议 18+（与 Electron 33 匹配） |
| npm | 随 Node 安装 |
| Rust 工具链 | **仅**编译原生下载内核时需要（`npm run native:build`） |
| PHP | **仅**本地调试 `server/` 时需要 |

```bash
npm install
npm run dev
```

## 二、常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发模式（electron-vite dev，主进程 / preload / 渲染层均热更新） |
| `npm run typecheck` | 类型检查：`tsc --noEmit` 跑 **node + web** 两份 tsconfig |
| `npm run build` | 构建到 `out/`（主进程含 `index.js` 与 `network.js` 两个入口） |
| `npm start` / `npm run preview` | 预览已构建产物 |
| `npm run native:build` | 编译 Rust 原生下载内核（release） |
| `npm run native:build:debug` | 同上，debug 版 |
| `npm run dist:win` / `dist:mac` / `dist` | 构建并打包安装包（输出到 `release/`） |
| `npm run dist:installer` | 构建安装包（主产物 portable + 兜底 nsis，输出到 `release/`） |

> 没有 lint 脚本。**提交前请至少跑 `npm run typecheck` 与 `npm run build`。**

## 三、类型检查的两份配置

| 配置 | 覆盖 |
| --- | --- |
| `tsconfig.node.json` | 主进程、preload、`src/shared` |
| `tsconfig.web.json` | 渲染层（`src/renderer/src/**`），开启了 `resolveJsonModule`，语言 JSON 可直接 import |

路径别名（见 `electron.vite.config.ts`）：`@main`、`@shared`、`@`（渲染层根）。

## 四、构建产物与打包

- `npm run build` 产出 `out/`：
  - `out/main/index.js` —— 后端 / 编排进程入口
  - `out/main/network.js` —— 网络进程入口（由 `broker.ts` 用 `utilityProcess.fork` 拉起）
  - `out/preload/index.js`、`out/renderer/**`
- 打包用 electron-builder（`electron-builder.yml`），输出到 `release/`：
  - `asar: true`；**原生库必须放在 asar 之外**（无法从 asar 内 `dlopen`），
    故 `resources/native/` 与 `resources/easytier/` 走 `extraResources`。
  - 运行时经 `process.resourcesPath/native/<platform>-<arch>/` 定位原生内核；
    缺失该平台产物时**自动降级**到 TS 下载器，不会崩。
  - 目标：Windows（nsis，可改安装目录）、macOS（dmg / zip）、Linux（AppImage）。

### 自研安装程序（安装模式并入启动器）

`Setup.exe` **就是启动器自身**：走 electron-builder 的 `portable` 目标封成单文件 exe，
主进程检测到 electron-builder 注入的 `PORTABLE_EXECUTABLE_FILE` 就切到安装模式，
跑自己的安装向导（界面复刻启动器的玻璃拟态风格：深色 + `#0a84ff` 强调色）。

```
src/main/installer/        安装模式主进程（正常启动时整个目录都不会被加载）
├── detect.ts              安装模式判定（环境变量）+ 载荷源 = 应用自身所在目录
├── paths.ts               安装目录 / 快捷方式目录 / 注册表键名（复刻 NSIS 布局）
├── fsops.ts               量尺寸 / 递归复制（临时关 asar 拦截）
├── registry.ts            注册表读写 + 是否已安装探测 + 注册卸载项
├── shortcut.ts            快捷方式 + 卸载脚本
├── install.ts             安装主流程 + UAC 提权子进程
├── headless.ts            --hc-info / --hc-selftest / --hc-elevated-install
└── index.ts               窗口与 installer:* IPC
src/renderer/public/installer/   安装向导界面（原样拷贝，不经 Vite 编译）
├── index.html  style.css  app.js  preload.js  assets/logo.png
```

- **为什么并进来**：早前安装器是**另一个** Electron 应用，把打包好的启动器当载荷塞进
  `extraResources`，于是安装包里带着**两份** Electron 运行时（约 2 × 268 MB 未压缩）——
  这是安装包体积最大的一项来源。并进来后只剩一份。
- **流程**：`scripts/build-installer.mjs` 一次 `electron-builder --win portable nsis`，
  同时产出主产物 `release/HCMCL-<版本> Setup.exe` 与兜底的 nsis 包。
  脚本还会顺手清掉历史安装包（每类保留最新 5 个）、陈旧的 `installer/payload`
  与旧方案产物目录 `release/installer/`。
- **一键**：`build-installer.bat`（原生内核 → typecheck → build → 安装器打包）。
- **判定必须用环境变量而非命令行参数**：自动更新走 `runUpdate()`，那里是
  `spawn(exePath, [])` 不带参数地拉起下载下来的 `Setup.exe`；靠参数判定会在
  「更新后点安装」时直接进入正常界面，装机流程当场断掉。
- **`out/main/chunks/` 陷阱**：入口 `src/main/index.ts` 用动态 `import()` 让两条路互不
  加载，Rollup 因此把 `app.ts` / `installer/index.ts` 切成 `out/main/chunks/*.js`，
  `__dirname` 落在 `chunks/`。渲染层页面与预加载脚本要从 `OUT_DIR`
  （= `resolve(__dirname, '..', '..')`，即 `out/`）解析，**不能**直接 `__dirname` 拼
  `../renderer/index.html` —— 少回退一层打包后直接 `ERR_FILE_NOT_FOUND`。
- **安装范围**（界面可选）：
  - **仅为当前用户**：装到 `%LOCALAPPDATA%\Programs\...`，写 `HKCU`，建当前用户桌面 / 开始菜单
    快捷方式，**免管理员**；
  - **为所有用户**：装到 `%ProgramFiles%`，写 `HKLM`，建公共桌面 / 开始菜单快捷方式，
    需要管理员权限——经 **UAC 提权**后用本程序的无界面子进程（`--hc-elevated-install`）完成安装，
    子进程把结果写入临时文件，父进程等待并读取。
- **自动检测与覆盖**（与 electron-builder 自带安装器**双向兼容**）：启动时按下列顺序识别
  **是否已安装**及其**范围**与**安装者**：
  1. **electron-builder 布局**（本安装器与自带安装器都写这里）：安装信息键 `Software\<GUID>` 的
     `InstallLocation`、卸载项键 `...\Uninstall\<GUID>` 的 `DisplayName`/`DisplayVersion`；
     按 `HKCU`/`HKLM` 判定单用户 / 机器级。`GUID = UUIDv5(appId, 50e065bc-3134-11e6-9bab-38c9862bdaf3)`
     （`appId` 与 electron-builder.yml 一致）；
  2. 兼容本安装器早期版本的键（`...\Uninstall\HungerCatMC`）；
  3. 回退检查该范围的默认安装目录里是否已有启动器（其它安装器 / 旧版 / 记录丢失）。
  选中与已装项相同的范围时，安装目录自动填为原目录并提示「将覆盖安装」；**单用户安装仅在当前
  登录用户就是原安装者时才显示覆盖**（未记录安装者时，因单用户目录 / `HKCU` 天然属于本人，
  视为可覆盖）。不同范围的已装项相互独立，只作提示。
- **写入校验**：卸载项写完会**回读校验**；机器级安装若未真正提权导致写入失败，会**明确报错**
  而不是静默成功（避免「装完却检测不到」）。
- **安装内容**：复制载荷到目标目录、可选桌面 / 开始菜单快捷方式、**按 electron-builder 的布局写入
  注册表**（安装信息键 `Software\<GUID>`：`InstallLocation`/`KeepShortcuts`/`ShortcutName`；卸载项键
  `...\Uninstall\<GUID>`：`DisplayName`/`DisplayVersion`/`UninstallString`/`InstallDate` 等；另附本
  安装器自有的 `InstallScope`/`InstallUser` 与快捷方式实际路径），并生成 `uninstall.cmd`。
- **卸载**：由安装器生成的 `uninstall.cmd` 完成——脚本先把自身复制到 `%TEMP%`（**安装目录以
  字面量写进脚本**，避免临时副本误删 `%TEMP%`），再删除安装目录、注册表项，以及从注册表读取到的
  实际快捷方式路径（OneDrive 重定向桌面等场景也能删干净）；**机器级安装的卸载会先经 UAC 提权**
  （`HKLM` / `Program Files` / 公共快捷方式都需要管理员）。
- **asar 注意**：载荷含 `resources\app.asar`，复制时需临时 `process.noAsar = true`——
  否则 Electron 会把**路径中含 `.asar`** 的文件当成 asar 归档解析，对其 `stat` / `copyFile`
  误报 `ENOENT`（普通 Node 无此拦截）。
- **排查/自检**：`--hc-info` 打印检测结果（写 `%TEMP%\HungerCat-Info.log`）；
  `--hc-selftest <目录> [--scope all|user]` 无界面跑一次安装（结果写 `%TEMP%\HungerCat-Selftest.log`）；
  安装错误（含 code / path / 栈）写 `%TEMP%\HungerCat-Install-Error.log`。

## 五、原生下载内核（可选）

```
native/downloader/    Rust 源码（napi-rs）：lib.rs、scan.rs、homepage.rs
scripts/build-native-downloader.mjs  编译脚本，产物进 resources/native/<platform>-<arch>/
```

它只是**加速器**：加载失败（未编译 / 平台不匹配 / ABI 问题）时 `native-downloader.ts`
返回 `null`，调用方回退到 `stream-download.ts`，功能一致、速度不同。

## 六、调试

| 手段 | 位置 / 用法 |
| --- | --- |
| 调试日志窗口 | 设置 → 游戏 → 调试模式，可查看滚动日志 |
| 原生 DevTools | 需先开启「开发模式」（设置 → 开发模式，邮箱验证码授权） |
| 主页调试器 | 主页相关页面提供的调试入口，可查看 SDK 接口与消息流 |
| 日志上报 | 调试窗口内提交，经 `debug-report.ts` 上报到服务端 |

主进程 IPC 有**统一插桩**（`wrapIpc`）：每个 `ipcMain.handle` 调用都会打印
开始 / 完成 / 失败日志，排查 IPC 问题先看这里。

## 七、版本号约定

版本号在**两处**同步修改：

1. `package.json` 的 `version`
2. `package-lock.json`：顶层 `version` **和** `packages[""].version`

> 安装模式并入启动器后，`Setup.exe` 用的是**启动器自己的** `version`（`app.getVersion()`），
> 不再需要单独同步安装器版本号。`installer/package.json` 仅剩已停用的旧方案（保留作回滚兜底），
> 其 `version` 已无实际意义，但为免困惑仍保持与根工程一致。

命名沿用语义化 + 阶段后缀：`0.6.8-dev1` / `-alpha1` / `-beta1` / `-hotfix1`，
正式版不带后缀。「主版本号」指去掉后缀的部分（启动器更新推送按它比较）。

## 八、硬性约定（务必遵守）

1. **不要提交 `server/`** —— 服务端只留本地。
2. **未经明确要求不要 `git commit` / 提 PR**。
3. 注释与界面文案用**中文**（多语言文案见 [I18N.md](./I18N.md)）。
4. 改动后跑 `npm run typecheck` + `npm run build`。
5. 接口变更**先改** `src/shared/types.ts`（`LauncherApi` 是渲染层 API 的唯一真相），
   再同步 `preload` 与 `handlers/`。
6. 新增 IPC 频道时，在 `src/main/handlers/` 的**对应域**文件里注册，不要写回 `index.ts`。
7. 大文件 / 二进制（原生库、EasyTier、安装包）不进 Git。

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

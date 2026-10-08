# HungerCat MineCraft Launcher · 开发文档

Electron + React + TypeScript 的 Minecraft 启动器。原生下载内核为 Rust（napi-rs），
配套 PHP 服务端位于 `server/`（**不纳入版本控制**）。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 进程模型、IPC 契约、关键数据流与设计取舍 |
| [STRUCTURE.md](./STRUCTURE.md) | 目录结构与各板块职责（逐个模块说明） |
| [SETTINGS.md](./SETTINGS.md) | 设置注册表（单一真源）与跨板块联动、语言自动发现 |
| [I18N.md](./I18N.md) | 语言系统规范（JSON 分片、键命名、三语一致性） |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | 开发、构建、调试、打包与硬性约定 |

## 常用命令

```bash
npm run dev        # 启动开发环境（electron-vite dev，热更新）
npm run typecheck  # 类型检查（node + web 两份 tsconfig，提交前必跑）
npm run build      # 构建产物到 out/
npm start          # 预览已构建产物（electron-vite preview）
npm run dist:win   # 构建并打包 Windows 安装包
```

## 一分钟了解代码放哪

| 我要改… | 去这里 |
| --- | --- |
| 界面某个页面 | `src/renderer/src/pages/`（大页面已按板块拆成子目录） |
| 通用 UI 组件 / 弹窗 | `src/renderer/src/components/` |
| 界面文案（多语言） | `src/renderer/src/i18n/locales/<语言>/<板块>.json` |
| 设置默认值 / 配置项 | `src/shared/settings.ts`（注册表；见 [SETTINGS.md](./SETTINGS.md)） |
| 新增一门语言 | 新建 `src/renderer/src/i18n/locales/<语言>/` 放 JSON，无需改代码 |
| 某个 IPC 接口的行为 | `src/main/handlers/` 对应域文件 |
| 业务逻辑（下载 / 启动 / 联机等） | `src/main/` 对应模块 |
| 渲染层能调用的 API 定义 | `src/shared/types.ts` 的 `LauncherApi` |
| 网络请求实现 | `src/main/network/`（跑在独立网络进程里） |

## 硬性约定（务必遵守）

1. **不要提交 `server/`** —— 服务端代码只留在本地，不进入仓库。
2. **未经明确要求不要 `git commit` / 提 PR**。
3. 注释与界面文案使用**中文**（英文、繁体为翻译文案，见 [I18N.md](./I18N.md)）。
4. 改动后必须通过 `npm run typecheck` 与 `npm run build`。

# 架构总览

## 一、进程模型

启动器是**四层**结构，层与层之间只通过明确定义的契约通信：

```
┌──────────────────────────────────────────────────────────────┐
│ 渲染进程 (Chromium)                                          │
│ React 18 + Tailwind 4 + motion；src/renderer/src/**           │
│ 只调用 window.api.*（不直接碰 Node / Electron）                │
└───────────────▲──────────────────────────┬───────────────────┘
                │ window.api（类型 = LauncherApi）
┌───────────────┴──────────────────────────▼───────────────────┐
│ preload（唯一的 IPC 桥）  src/preload/index.ts                 │
│ contextBridge.exposeInMainWorld('api', api)                  │
└───────────────▲──────────────────────────┬───────────────────┘
                │ ipcRenderer.invoke / on
┌───────────────┴──────────────────────────▼───────────────────┐
│ 后端 / 编排进程（主进程）                                      │
│ src/main/index.ts（组合根：窗口、生命周期、托盘）               │
│   └── src/main/handlers/*（按域注册 IPC，见 STRUCTURE.md）      │
│   └── src/main/*.ts（业务模块：下载、启动、整合包、主页…）       │
└───────────────▲──────────────────────────┬───────────────────┘
                │ MessagePort（协议见 shared/net-protocol.ts）
┌───────────────┴──────────────────────────▼───────────────────┐
│ 网络进程（Electron utilityProcess.fork，out/main/network.js）  │
│ src/main/network/**：专职网络 IO，不 touch ipcMain / WebContents│
│   └── native-downloader.ts → Rust napi 内核（可选加速器）       │
└──────────────────────────────────────────────────────────────┘
```

### 为什么要拆出网络进程

网络慢或阻塞会拖住事件循环。把全部 `fetch` / 下载 / 刷新 token 的**执行**挪到独立进程后，
主进程只做编排，渲染层 UI 不会因网络抖动卡顿。代价是跨进程通信，
所以有 [net-protocol.ts](../src/shared/net-protocol.ts) 这份协议。

### 原生下载内核是可选项

`src/main/native-downloader.ts` 按平台目录（`resources/native/<platform>-<arch>/`）加载
Rust 编译的 napi 库。**加载失败不算错误**：返回 `null`，调用方自动回退到
`stream-download.ts` 的纯 TS 实现 —— 功能完全一致，只是速度不同。
这样任何环境都能跑，打包也不会因缺库而崩。

## 二、契约

| 契约 | 位置 | 说明 |
| --- | --- | --- |
| `LauncherApi` | [shared/types.ts](../src/shared/types.ts) | 渲染层能调用的全部 API 的**唯一真相**。改接口先改这里。 |
| `NetRequestMessage` 等 | [shared/net-protocol.ts](../src/shared/net-protocol.ts) | 主进程 ↔ 网络进程的消息协议。 |
| 危险代码规则表 | [shared/homepage-runtime.ts](../src/shared/homepage-runtime.ts) | 主页脚本静态检测（主进程）与运行时检测（渲染层）**共用同一份规则**。 |
| srcDoc 组装 | [shared/srcdoc.ts](../src/shared/srcdoc.ts) | 沙箱 iframe 的 CSP 与 SDK 注入点（注入失败会静默失去隔离，故单独抽出便于测试）。 |

### 跨进程错误的表示

错误以**结构**而非文案跨边界：`{ code, status?, retryAfter?, message }`。
`code` 是稳定枚举（镜像回退 / 取消 / 超时 / 未知），`status` / `retryAfter` 供决策，
`message` **只用于日志与 UI 展示，不参与任何逻辑判断**。
这样改一句文案不会断链。

### 超时策略

- **本地看门狗**：`src/main/local-timeout.ts` 的 `withLocalTimeout` 包裹本地文件系统等
  可能卡住的操作，超时即判废并向调用方抛错，由调用方友好降级，绝不把启动器搞崩。
- **网络请求不走看门狗**：HTTP / fetch / 下载流维持各自的 10s 超时
  （`AbortSignal.timeout(10_000)`），避免把正常下载误杀。

## 三、关键数据流

### 1. 下载并安装一个版本

```
渲染层 VersionsPage → window.api.download.install(id, dirId?)
  → handlers/versions.ts → downloader.ts（编排：解析 JSON、算缺失文件、校验 SHA-1）
      → 每个文件 → broker.netRequest('stream:download') → 网络进程
          → native-downloader（可用时）或 stream-download.ts
      ← { type:'progress', ref, taskId, data } 流式回流 → 主进程转发
  ← ipcMain → 渲染层 onProgress → 进度条
```

`maxDownloadConcurrency`（文件并发）与 `downloadConnections`（单文件连接数）由
`src/main/network-profile.ts` 换算成「克制且安全」的实际参数 ——
并发并非越大越快：Wi-Fi 上过多并发连接会让空口竞争恶化、吞吐反而下降。

### 2. 启动游戏

```
launch:start → launcher.ts（拼命令行、选 Java、应用窗口尺寸）
  → child_process.spawn → 日志回流 → launch-diagnosis.ts（渲染层）识别失败原因
```

### 3. 自定义主页（沙箱）

```
CustomHomePage（组合根）
  ├── pages/customhome/data.ts      拉取条目 / 版本 / 账号等宿主状态
  ├── pages/customhome/security.ts  CSP 构建 + 三档安全处置
  ├── pages/customhome/bridge.ts    postMessage 双向分发（hc.* SDK ↔ 宿主）
  ├── pages/customhome/sdk.ts       注入 iframe 的 SDK 源码
  └── pages/customhome/frame.tsx    沙箱 iframe 容器
```

安全链有两道：安装/读取时的**静态检测**（`main/homepage-analyzer.ts`）与
元素/指令运行前的**运行时检测**，二者共用 `shared/homepage-runtime.ts` 的规则表。

## 四、渲染层内部结构

| 文件 | 职责 |
| --- | --- |
| [App.tsx](../src/renderer/src/App.tsx) | 应用外壳：标题栏、导航（侧栏 / 顶栏）、页面切换、全局弹窗编排 |
| [store.tsx](../src/renderer/src/store.tsx) | 全局状态（设置 / 账号 / 公告 / 更新提示等），`useApp()` 的提供者 |
| [runtime.tsx](../src/renderer/src/runtime.tsx) | 运行时状态（下载任务等），`useRuntime()` 的提供者 |
| [pages/router.tsx](../src/renderer/src/pages/router.tsx) | 页面路由表 |
| [startup.ts](../src/renderer/src/startup.ts) | `runWhenIdle`：把非首屏必需的联网 / 扫描推迟到首个空闲帧，压低启动瞬时占用 |

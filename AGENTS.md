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
| 当前版本 | 以 `package.json` 为准；当前 `0.8.0-beta5`，批次进度及验证时间点见 `plan.md` |

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
- **版本号涉及五个文件**，必须同时改：`package.json` 的 `version`、`package-lock.json` 的
  `version` 与 `packages[""].version`、`src-tauri/tauri.conf.json` 的 `version`、
  `src-tauri/Cargo.toml` 的包版本，以及 `src-tauri/Cargo.lock` 内 `hcmcl-tauri` 的版本。
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

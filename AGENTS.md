# AGENTS.md

给在本仓库工作的 AI / 协作者的**操作规则**。架构与目录说明见 [`docs/`](./docs/README.md)，
这里只写「会咬人的地方」和「怎么验证」。**踩过的坑都带现象与根因，别只抄结论。**

---

## 0. 三十秒速览

| 项 | 值 |
| --- | --- |
| 技术栈 | Electron 33 + React + TypeScript（electron-vite）；原生下载内核 Rust（napi-rs） |
| 样式 | **单文件** `src/renderer/src/index.css`（4000+ 行）+ Tailwind 工具类；皮肤靠 `[data-skin]` 切换 |
| 服务端 | PHP，位于 `server/`，**gitignore，不入库**，手动部署 |
| 当前版本 | 见 `package.json`（`0.7.5-dev4` 起） |

```bash
npm run dev         # 开发（热更新）
npm run typecheck   # 必跑：node + web 两份 tsconfig
npm run build       # 构建到 out/
node scripts/build-all.mjs --platform win --arch x64      # 打包（另有 linux / all）
node scripts/build-all.mjs --platform win --arch all      # 全架构
```

---

## 1. 硬性纪律

1. **不提交 `server/`**（含 SMTP 密码、管理员哈希）。用户要求"服务端文件"时，一律放进 `server/`。
2. **不擅自 `git commit` / `push`**，除非用户明确要求。
3. **不谎称已验证**。本机 **Electron 启动即退出**，任何 UI/交互/动画效果都**无法实机确认**；
   必须写明「未验证」并给出判断依据，禁止用"应该没问题"糊过去。
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

- **mac 无法在 Windows 上构建**（需要 `hdiutil` / `codesign`）：走 GitHub Actions
  `.github/workflows/build-mac.yml`，触发条件是 **push tag `v*`**。
- mac 产物默认**未签名**（`CSC_IDENTITY_AUTO_DISCOVERY: false`），首次打开需右键 →「打开」。
- **Windows arm64 没有原生下载器**（本机无 clang / arm64 MSVC 工具链）→ 自动降级为 TS 下载器，
  功能等价但更慢。不要以为打包坏了。
- **版本号有三处**，必须同时改：
  `package.json` 的 `version`、`package-lock.json` 的 `version` 与 `packages[""].version`。
- 提交前的最低验证：`npm run typecheck` + 全量 `node scripts/test-*.mjs` + `npm run build`。

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

---

## 5. 主进程 / Electron 陷阱

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
7. 语法检查用 `php -l` 并以**退出码**判定（PowerShell 管道会让输出乱码）。

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
# 一次跑全部（逐个执行，取结果行）
for t in test-lyrics test-i18n test-settings-layout test-custom-rows test-window-lifecycle \
         test-update-resolve test-portable-paths test-loader-install test-player3d; do
  echo -n "$t : "; node "scripts/$t.mjs" 2>/dev/null | grep '^结果'
done
```

---

## 8. 交付前检查单

- [ ] `npm run typecheck` 0 错误
- [ ] 全量 `scripts/test-*.mjs` 全绿
- [ ] `npm run build` 成功
- [ ] 新增/修改的 UI 文案三语齐全
- [ ] 改动涉及构建产物时：`npm run fix:integrity:check` 无 Low
- [ ] 报告里**明确写出哪些没有实机验证**及残留风险

---

## 9. 关于「无法验证」的诚实边界

本机 **Electron 无法启动**（启动即退出，多次尝试）。因此以下内容**只能靠代码与测试推断**，
不得声称已验证：

- 任何界面外观、动画、交互手感
- 真实打包产物能否安装/启动
- Forge 安装器端到端（需要真实 Java + 可达网络）

遇到这类结论，必须写「未验证 + 依据 + 建议用户验证的点」。

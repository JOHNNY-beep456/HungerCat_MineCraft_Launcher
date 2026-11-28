# 上架 Microsoft Store

本文件是 `HungerCat MineCraft Launcher` 通过 MSIX 上架 Microsoft Store 的完整操作手册，
以及**这个应用特有的坑**。命令行、变量名、清单要素都以仓库现状为准，不是通用教程。

---

## 1. 一次性的准备（人工，只能在 Partner Center 做）

1. 注册开发者账号：<https://storedeveloper.microsoft.com>（个人或公司，一次性费用）。
2. 在 Partner Center **预留应用名称**。预留名决定 `Identity/@Name`，后面所有包都用它。
3. 打开 **应用管理 → 应用标识**，抄下三个值（**逐字符复制，不要手打**）：

| Partner Center 字段 | 对应参数 | 说明 |
| --- | --- | --- |
| 包名称 / Package/Identity/Name | `-IdentityName` | 形如 `12345HungerCat.HCMCL` |
| 发布者 / Package/Identity/Publisher | `-Publisher` | 形如 `CN=1A2B3C4D-...`，是证书**主题**，不是显示名 |
| 发布者显示名称 | `-PublisherDisplayName` | 商店页上显示的发行方，如 `HungerCat` |

> `Publisher` 不是 `CN=HungerCat`。侧载包用 `CN=HungerCat` 只是因为自签证书自己说了算；
> 商店会拿 `Publisher` 和你的账号绑定关系做校验，不一致会在上传阶段直接拒。

把三个值配成仓库变量（Settings → Secrets and variables → Actions → **Variables**）：

```
STORE_IDENTITY_NAME            = 12345HungerCat.HCMCL
STORE_PUBLISHER                = CN=1A2B3C4D-0000-0000-0000-000000000000
STORE_PUBLISHER_DISPLAY_NAME   = HungerCat
```

不是 secret：它们会出现在每个安装包的清单里，本来就不保密。用 Variables 只是为了不改代码。

---

## 2. 出包

### 2.1 CI（推荐，能出三架构 bundle）

配置好上面三个变量后，跑一次 `build-tauri` 工作流（`workflow_dispatch` 即可，不必打标签）：

- Windows 三个架构各自额外打一份**商店 Identity** 的 MSIX（`hcmcl-store-msix-{x64,x86,arm64}`）；
- `store-bundle` job 合成 `.msixbundle` 与 `.msixupload`（`hcmcl-store-upload`）；
- 运行页面的 **Summary** 里有文件清单与体积；
- **商店包不会进 GitHub Release** —— Release 是给直接下载用户的，那里放的是自签侧载包。

下载 `hcmcl-store-upload`，里面两个文件都可用：

| 文件 | 用途 |
| --- | --- |
| `*.msixupload` | 上传到 Partner Center 的首选（ZIP 封装，可带 `.appxsym` 符号） |
| `*.msixbundle` | 同样的内容，未封装；需要单独提交包时用它 |

### 2.2 本机（只出单架构，用于验证）

```powershell
# 先把 exe 构建出来（会同时产出 easytier/ 资源）
npx tauri build --bundles nsis

./scripts/package-msix.ps1 `
  -Arch x64 -Version 0.8.3 `
  -ExeDir src-tauri/target/release `
  -OutDir dist-msix-store `
  -IdentityName '12345HungerCat.HCMCL' `
  -Publisher 'CN=1A2B3C4D-...' `
  -PublisherDisplayName 'HungerCat' `
  -Store
```

`-Store` 会做四件事：拒绝侧载默认 Identity、要求 `CN=` 前缀、强制签名、跳过「自签仅供侧载」的告警。
签名用的是一个**以商店 Publisher 为主题的临时自签证书**（Visual Studio 打商店包也是这么做的）：
商店发布时会用 Microsoft 证书覆盖它，但本机 `Add-AppxPackage` 验收需要它有签名。

单架构就能验证清单与载荷，**但提交用的 bundle 建议始终来自 CI**（三架构齐全）。

---

## 3. 提交

Partner Center → 应用 → **新建提交**，按顺序：

1. **定价和可用性**：市场、价格（可免费）、发布节奏。
2. **属性**：类别（游戏 / 工具）、系统要求（会显示 `10.0.17763.0` 起）。
3. **年龄分级**：完成问卷（含在线交互 → 需如实勾选联机、AI 助手）。
4. **包**：上传 `.msixupload`。上传后应显示 **三个架构**（x64 / x86 / arm64）且都可用；
   若只显示一个，说明 bundle 里少了包，回到第 2 节重打。
5. **商店列表**：语言、描述、截图、商店图标、隐私政策 URL、支持联系方式。
6. **提交认证**。

### 列表素材要点

| 素材 | 要求 | 仓库现状 |
| --- | --- | --- |
| 桌面截图 | ≥ 1366×768，1–10 张，PNG | **需自备**（用真实界面截图，不要用渲染占位） |
| 商店图标 | 300×300 以内 PNG | 可由 `src-tauri/icons/icon.png` 导出 |
| 隐私政策 URL | 必填（应用会联网、会存账号令牌） | 需自行提供可访问页面 |
| 支持联系方式 | 必填 | 需自行填写 |

---

## 4. 这个应用特有的坑（重点）

### 4.1 安装目录只读

MSIX 把 payload 放在 `C:\Program Files\WindowsApps\...`，**不可写**。当前代码只有一处读安装目录：
`storage.rs` 探测 `portable.flag`（只读，不创建），所以没有违规写入。**后续不要**在 exe 旁边落
日志、缓存或配置——那在侧载包上会失败。

### 4.2 `%APPDATA%` 会被重定向（用户数据与 NSIS 版互不可见）

打包应用的 AppData 写入被系统透明重定向到：

```
%LOCALAPPDATA%\Packages\<PackageFamilyName>\LocalCache\Roaming\...
```

影响：

- 商店版与 NSIS/免安装版的**设置、账号、皮肤缓存是两套**，不会互相继承；
- 卸载包会连同这份数据一起删除（这正是 MSIX 的设计目标）；
- 默认游戏目录在**文档**下（`Documents\HungerCatMC`），不在重定向范围内，存档不受影响；
- 下载的 Java 运行时在 AppData 里 → 重装后需要重新下载。

这是系统行为，代码不需要改，但**要在商店描述或 FAQ 里说明**，否则用户会来问「我的账号没了」。

### 4.3 更新必须走商店

`services.rs` 的更新通道在包形态下已改为：

- `update:check` → 直接返回「无新版本」（`latest: null`），不去自建更新源查；
- `update:download` / `update:downloadAndRun` → 返回错误，提示去 Microsoft Store 更新。

原因不只是政策：商店版下载 NSIS 安装器去覆盖，会在 `WindowsApps` 之外多装一份免安装副本，
两个形态争同一份用户数据。判定用 `packaged::is_packaged()`（`GetCurrentPackageFullName`）。

### 4.4 `runFullTrust` 是受限能力

清单声明了 `rescap:Capability Name="runFullTrust"`。桌面应用经 Desktop Bridge 打包属于正常用法，
但认证时会看**为什么需要完全信任**：本应用要读写任意游戏目录、拉起 `java.exe` 与随包的
`easytier-core.exe`、调用原生系统 API（歌词/媒体控制）。提交时在「给认证人员的说明」里写清这几点。

同时清单保留 `EntryPoint="Windows.FullTrustApplication"` 与 `uap10:RuntimeBehavior="packagedClassicApp"`
`uap10:TrustLevel="mediumIL"` 两套标记：前者给 Win10 1809~1903，后者给 19041+。**少写后者会被当成
appContainer**，表现是启动就崩、写注册表失败。

### 4.5 WebView2 运行时

应用依赖 Evergreen WebView2。Windows 11 自带；Windows 10 由 Edge 更新带来，绝大多数机器已有。
MSIX 没有可声明的「WebView2 框架包依赖」，所以不能靠清单兜底。缺失时 Tauri 会启动失败——
如果认证机器报启动即退出，先确认该机器有没有 WebView2 Runtime。

### 4.6 联机内核随包

`easytier/` 会进包（无 Npcap 版本，用户态运行、不装驱动）。CI 对三个架构都现编；x86/arm64
构建失败时该架构的包会**不含内核**，联机板块不可用（日志有 `::warning::`）。上架前确认三个
架构都有内核，否则等于对外承诺了不存在的功能。

### 4.7 商标

产品名与图标含 "Minecraft"。认证可能以商标为由质询，这属于发行方要自己承担的风险：
商店显示名/图标建议弱化官方商标元素，描述里说明「非官方启动器，与 Mojang / Microsoft 无关」。

---

## 5. 提交前自检

本机（需要先信任随包的 `.cer`）：

```powershell
# 1) 结构自检：清单、身份、架构
makeappx unpack /p "HungerCat MineCraft Launcher_0.8.3_x64.msix" /d .check /o

# 2) 真装一次（会走完整部署流程，能暴露清单问题）
Import-Certificate -FilePath "HungerCat MineCraft Launcher_0.8.3_x64.cer" -CertStoreLocation Cert:\CurrentUser\TrustedPeople
Add-AppxPackage -Path "HungerCat MineCraft Launcher_0.8.3_x64.msix"

# 3) 启动、登录、开一次游戏、开一次联机；再卸载确认数据清理
Get-AppxPackage *HCMCL* | Remove-AppxPackage
```

`Add-AppxPackage` 报 `0x800B0109` = 证书没进 `TrustedPeople`；报 `0x80073CF3` = 依赖/身份冲突，
先 `Remove-AppxPackage` 旧版本。

WACK（Windows App Certification Kit，随 Windows SDK 安装）能提前跑一遍认证项，但它会真的
启动应用，需要交互桌面；CI 里跑不了，本机跑一次即可。

---

## 6. 版本与更新

- `Identity/@Version` 必须是四段纯数字，脚本把 `0.8.3` 补成 `0.8.3.0`；
  **带 `-dev` 的版本会被脚本直接拒绝**，这是刻意的——MSIX 不接受预发布段。
- 每次向商店提交新包，`Version` 都要比上一次大，否则上传会提示版本重复。
- 商店更新与 `tauri.conf.json` 的 `version` 同源，改版本号仍然是五处同步（见 `AGENTS.md` §4）。

---

## 7. 常见失败对照

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 上传报 Identity 不匹配 | `-IdentityName` 与预留名不一致 | 回 Partner Center 复制，别手打 |
| 上传报 Publisher 不匹配 | `-Publisher` 用了 `CN=HungerCat` | 用账号的发布者主题 |
| 认证报「未声明 runFullTrust」 | 清单被改回 UWP 形态 | 检查 `package-msix.ps1` 的 manifest 段 |
| 装完启动即退出 | `uap10:TrustLevel` 缺失 → 跑在 appContainer | 补齐 uap10 两个属性 |
| 本机装不上，`0x800B0109` | 自签证书未信任 | 导入 `.cer` 到 `TrustedPeople` |
| `makeappx unpack` 报 `0x80080203` | 对 bundle 用了 `unpack` | 用 `makeappx unbundle` |
| 上传后只显示一个架构 | bundle 少包 | 看 `store-bundle` job 的 inspect 表 |

---

## 8. 当前状态（据实记录）

- 打包链路已在本机验证：x64 商店包 `makeappx pack` + 签名成功，三架构合成 `.msixbundle`
  并经 `unbundle` 回读校验通过，`.msixupload` 生成成功。
- **尚未真正向 Partner Center 提交过**：没有账号侧的 Identity 值，也就没有跑过一次真实上传与认证。
- **没有在本机 `Add-AppxPackage` 安装过商店包**：只做了结构校验；安装后的启动、WebView2、
  随包 easytier 拉起、AppData 重定向的实际落点，都还没实测。
- 商店列表素材（截图、隐私政策、支持联系方式）不在仓库范围内。

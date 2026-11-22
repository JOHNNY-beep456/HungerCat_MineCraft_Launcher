# 外部账号导入

从「账号 → 导入账号」选择 PCL2、HMCL 或官方启动器，读取来源后勾选账号，再导入。读取和解析在主进程完成，预览只展示名称、账号类型和状态。来源文件与注册表均只读，不修改来源启动器的数据。

## 支持范围

| 来源 | 读取方式 | 支持与限制 |
| --- | --- | --- |
| PCL2 | 当前 Windows 用户的 PCL/PCL2/PCLDebug 注册表，或用户选择的 `.reg` 导出文件 | 识别公开设置字段中的离线、微软和第三方账号。加密字段需要已知源标识；公开调试源码的固定标识可处理，普通发行版的标识与 OAuth 客户端参数无法保证恢复。无法恢复时提示重新登录。也支持由用户提供的同字段明文 JSON 转换数据，但这不是 PCL 官方导出格式。 |
| HMCL 旧版 | `hmcl.json` 的顶层 `accounts`，或旧共享账号数组 | 识别离线、微软、authlib-injector 账号，保留角色 UUID。微软刷新缺少源 OAuth 客户端参数时，不使用 HCMCL 的默认客户端代替。 |
| HMCL 新版 | `config/accounts.json` 与配套 `config/private/account-private-data.json`；共享账号对应 `user-accounts.json` 与 `private/user-account-private-data.json` | 按 `accountID` 配对元数据和私密记录，使用 `profileID` 作为角色 UUID；支持 `plain` 与已核实的 `hmcl-obfuscated-v1` 封装，并验证认证标签。可一起多选，也可跟随第二次文件选择提示分别选择。未知封装或配套数据缺失不会恢复凭据。 |
| 官方启动器 | `launcher_accounts.json`、旧 `launcher_profiles.json` | 新格式读取微软角色和现有 Minecraft 访问令牌；旧 `authenticationDatabase` 仅展示需重新登录的角色。没有可靠的微软刷新授权参数时，仅允许现有游戏凭据临时使用。不会把 Minecraft 令牌作为微软令牌刷新。 |

不要把“支持读取”理解为所有来源都可以免登录迁移。PCL 普通发行版的加密格式、缺失的 HMCL OAuth 构建参数，以及官方文件未包含的刷新信息，都可能要求重新登录。实现不扫描系统凭据库，也没有依据将所有官方启动器凭据描述为某种操作系统加密格式。

## 状态与提交

- **可导入**：离线账号，或具备有效访问凭据和完整源刷新参数的微软账号。
- **临时可用**：现有 Minecraft 凭据尚未到期，但没有可用的微软刷新参数；到期后需要重新登录。
- **需要联网验证**：凭据需要刷新。微软账号沿用源 `clientId`、`scope` 和限定的微软端点；第三方账号保留完整认证根地址。
- **需要重新登录**：缺少可信身份、有效凭据或可用刷新条件，不可勾选。
- **账号已存在**：以 HCMCL 已有角色 UUID 判重，不覆盖已有账号或切换现有选中账号。

前三种状态默认勾选；在线账号提交时都要验证角色身份，返回其他 UUID 或请求失败时不保存。JWT 到期字段只用于展示和刷新决策，不代替在线鉴权。刷新可能轮换源令牌，使来源启动器之后需要重新登录；页面会提示此风险。

预览会话按渲染进程隔离，十分钟到期；取消、重新读取、窗口销毁和提交结束后均释放临时凭据。每次至多选择八个来源文件，每文件至多 8 MiB，预览至多五百条。支持 UTF-8 和带 BOM 的 UTF-16 文件。

## 实现位置与验证

- [`src/main/account-import-parser.ts`](../src/main/account-import-parser.ts)：纯格式解析和字段校验。
- [`src/main/account-import.ts`](../src/main/account-import.ts)：只读文件选择、临时会话、在线验证、去重与保存。
- [`src/renderer/src/pages/AccountImportView.tsx`](../src/renderer/src/pages/AccountImportView.tsx)：来源选择、账号预览和结果，含简体、繁体、英文文案。
- [`scripts/test-account-import.mjs`](../scripts/test-account-import.mjs)：虚构凭据与内存服务替身测试，不读取真实账号或注册表，不访问外部认证服务。

运行 `node scripts/test-account-import.mjs`、`npm run typecheck`、`node scripts/verify-publication.mjs` 与 `npm run build`。本机 Electron 启动即退出，界面交互、真实账号文件和真实认证服务的端到端迁移尚未实机验证。

## 格式来源

解析器按公开格式独立实现，不包含用户凭据。以下固定版本用于核对字段和协议：

- PCL：[`Meloong-Git/PCL@93ede5d9e638c99fcec853a9ba1eecd91ceee7f5`](https://github.com/Meloong-Git/PCL/tree/93ede5d9e638c99fcec853a9ba1eecd91ceee7f5) 的设置注册、字符串加密/哈希和登录缓存逻辑。公开调试版标识不代表正式发行版；不猜测源客户端 ID。
- HMCL：[`HMCL-dev/HMCL@3.16.4`](https://github.com/HMCL-dev/HMCL/tree/3.16.4)，提交 `fbcc17472f08e877d60d6b715734e8054e9e61ee`。核对 `AccountPrivateData`、`ProtectedPayload`、`LegacyConfigMigrator`、`MicrosoftSession`、`OfflineAccount`、`YggdrasilSession` 与 `AuthlibInjectorAccount`。`hmcl-obfuscated-v1` 使用的应用级常量在上游公开，不是某个用户的私钥；解码仍须验证 Poly1305 标签。
- OAuth：HMCL 的 `MicrosoftService` 与 `OAuth`。`XboxLive.signin offline_access` 链路使用 Xbox `d=` 前缀；HCMCL 原有旧式 scope 保持 `t=` 分支。微软刷新地址仅允许既有 Live 端点或 Consumers v2.0 端点，导入文件不能指定任意接收令牌的 URL。
- 官方文件：按 `accounts.*.minecraftProfile` 和旧 `authenticationDatabase.*.profiles` 结构处理，未保证兼容所有官方启动器历史版本。

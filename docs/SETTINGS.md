# 设置系统与跨板块联动

本项目的核心约定之一是：**单独修改某一个板块，其它板块能直接响应**，而不是靠人工
在多处同步。为此，设置与语言都改成了「声明式 + 自动发现」：

| 联动点 | 声明位置 | 自动响应方 |
| --- | --- | --- |
| 设置默认值 | `src/shared/settings.ts` 的 `SETTINGS_DEFS` | 主进程 `getDefaultSettings()` + 渲染层兜底对象 |
| 设置配置项（UI） | `SETTINGS_DEFS` 中的 `ui` 元数据 | 设置页各板块（`AutoFields` / `AutoSection`） |
| 语言清单 | `locales/<语言>/meta.json` | 设置页语言选项（`LOCALES`） |
| 语言文案 | `locales/<语言>/<板块>.json` | 全部界面（`createTranslator`） |

一句话：**改声明处即可，改完不用动消费方**。

---

## 一、设置注册表：`src/shared/settings.ts`

这是设置的**单一真源**，被主进程（node 环境）与渲染层（浏览器环境）同时打包，
因此**必须保持纯数据 / 无副作用**，不得引入 electron、node 或浏览器专有 API
（自定义行组件放在渲染层，不在这里）。

### 1.1 结构

```ts
export const SETTINGS_DEFS: SettingsDefs = {
  // 键 = LauncherSettings 的字段名；default = 默认值；ui = 可选，带上即可被设置页自动渲染
  downloadConnections: {
    default: 16,
    ui: { section: 'download', control: 'number', labelKey: 'settings.row.connections', min: 1, max: 256 }
  },
  // 交互复杂的一行：标记 custom，具体控件由渲染层 rows.tsx 按字段名提供
  gameDir: { default: '', ui: { section: 'game', control: 'custom' } },
  // …
}
```

- `SettingsDefs` 是 `{ [K in keyof LauncherSettings]-?: SettingDef<LauncherSettings[K]> }`，
  即**字段必须与 `LauncherSettings` 完全一致**——漏登记一项，`npm run typecheck` 直接报错。
- `default` 会被 `defaultSettings()` 深拷贝后派生出完整默认对象。
- **声明顺序 = 各板块内的显示顺序**（分组顺序见文件中的分区注释）。

### 1.2 `ui` 元数据

`ui.control` 取 `number` / `switch` / `segmented` / `select` / `custom`：

| 字段 | 适用 | 说明 |
| --- | --- | --- |
| `section` | 全部 | 所属板块 id，决定渲染到哪个板块 |
| `control` | 全部 | 控件类型；`custom` 表示交给渲染层自定义行组件 |
| `labelKey` | 标准控件 | 行标签的 i18n 键 |
| `min` / `max` | `number` | 取值范围 |
| `options` | `segmented` / `select` | 选项（`{ value, labelKey }`，`labelKey` 为 i18n 键） |
| `hintKey` | 标准控件 | 行下方说明文字的 i18n 键（可选） |
| `disabled` | 标准控件 | 是否始终禁用 |
| `disableWhen` | 全部 | 满足任一条件时禁用（见下） |

`disableWhen` 是**纯数据枚举**，由设置页求值，避免把判断逻辑写进注册表：

| 取值 | 含义 |
| --- | --- |
| `local` | 当前为「本地」运行模式 |
| `autoThemeFromWallpaper` | 开启了「随壁纸切主题」 |
| `autoTranslateOff` | 关闭了「自动翻译」 |

> 不带 `ui` 的字段不会被设置页渲染（纯内部字段，如 `hardwareChecked`、`memoryMb` 等）。

### 1.3 导出的函数

| 函数 | 用途 |
| --- | --- |
| `defaultSettings()` | 由注册表派生一份全新的默认设置对象（数组 / 对象各自独立拷贝） |
| `sectionFields(section)` | 取某板块下带 `ui` 的字段列表，顺序 = 注册表声明顺序 |

---

## 二、默认值的单一真源

历史上默认值在**两处各写一份**（主进程 `store.ts`、渲染层 `store.tsx` 的兜底对象），
改一处忘另一处会导致「渲染层兜底与真实默认不一致」这类隐蔽问题。现在两处都从
`defaultSettings()` 派生：

```ts
// 主进程 src/main/store.ts —— 仅覆盖依赖运行时的一项（默认版本目录取系统「文档」目录）
export function getDefaultSettings(): LauncherSettings {
  return { ...defaultSettings(), gameDir: join(app.getPath('documents'), 'HungerCatMC') }
}

// 渲染层 src/renderer/src/store.tsx —— 加载完成前的兜底
settings: settings ?? defaultSettings(),
```

---

## 三、设置页自动渲染

渲染层 `src/renderer/src/pages/settings/` 下：

| 文件 | 职责 |
| --- | --- |
| `AutoSection.tsx` | `AutoFields`（按注册表渲染字段）+ `AutoSection`（板块外壳 + 字段 + 自定义节点） |
| `rows.tsx` | **自定义行组件**及映射 `CUSTOM_ROWS`（键 = 字段名），供 `control: 'custom'` 使用 |
| `parts.tsx` | `Section` / `Row` 外壳原语 |
| `*Section.tsx` | 各板块，绝大多数只是对 `AutoSection` 的一行声明 |

### 3.1 板块声明

绝大多数板块已无任何配置项硬编码：

```tsx
// src/renderer/src/pages/settings/GameSection.tsx
export function GameSection(): JSX.Element {
  return <AutoSection section="game" titleKey="settings.section.game" icon="cube" />
}
```

`AutoSection` 额外支持：`intro`（字段之前的节点）、`children`（字段之后的整块自定义 UI）、
`footnotes`（末尾整段说明）。例如「更新」板块的检测 / 下载区放在 `children`。

**已迁移到注册表的板块**：`mode`、`appearance`、`experimental`、`game`、`java`、
`download`、`community`、`notice`、`update`。

> 例外：`DeveloperSection`（开发模式）是**服务端授权流程**，渲染的是 `DevModeStatus`
> 而非设置项，故保持自绘；联机设置是专用富面板，见 `components/MultiplayerSettings.tsx`。

### 3.2 新增一项设置的完整流程

以「下载器」新增「最大重试次数」为例：

1. 在 `LauncherSettings` 里加字段（`src/shared/types.ts`）：`maxDownloadRetries: number`
2. 在注册表登记默认值 + UI 元数据（`src/shared/settings.ts`）：

   ```ts
   maxDownloadRetries: {
     default: 3,
     ui: { section: 'download', control: 'number', labelKey: 'settings.row.maxRetries', min: 0, max: 20 }
   },
   ```

3. 补三语文案（`locales/zh-CN|zh-TW|en/core.json`）：`{ "settings.row.maxRetries": "最大重试次数" }`
4. 跑 `npm run typecheck`。

**无需改动任何板块代码**——「下载」板块会自动多出一行「最大重试次数」。

### 3.3 需要特殊交互的设置

若某项设置需要自定义控件（取色器、目录选择、滑动条、弹窗确认等）：

1. 注册表里标 `control: 'custom'`（仍决定它属于哪个板块、排在何处）；
2. 在 `rows.tsx` 写一个行组件，并加进 `CUSTOM_ROWS`（键 = 字段名）。

板块本身仍无需改动。当前的自定义行组件见 `rows.tsx` 末尾的 `CUSTOM_ROWS`。

---

## 四、语言自动发现（联动到设置页语言选项）

语言清单与词典**全部自动发现**，`i18n/index.ts` 里没有任何语言名 / 分片名的硬编码：

- `locales/<语言>/meta.json`：该语言的显示名与排序；
- `locales/<语言>/<板块>.json`：词典分片（`meta.json` 之外的文件都算分片）。

```ts
// 自动收集全部语言目录
const metaModules = import.meta.glob('./locales/*/meta.json', { eager: true, import: 'default' })
const dictModules = import.meta.glob('./locales/*/*.json', { eager: true, import: 'default' })
```

`LOCALES` 由 `metaModules` 生成，设置页「外观」板块的语言选项（`rows.tsx` 的 `LanguageRow`）
直接用它渲染。

### 4.1 新增一门语言

1. 新建目录 `locales/<语言 id>/`，放入 `meta.json`：

   ```json
   { "label": "日本語", "order": 3 }
   ```

   （`label` 用该语言母语书写，便于辨认；`order` 越小越靠前。）

2. 放入词典分片（与现有语言同名的 `<板块>.json`，键集合应一致）。
3. 跑 `npm run typecheck`。

**无需改动任何代码**——设置页语言选项与界面文案会自动出现该语言。
`LauncherSettings.language` 是普通 `string`，非法 / 未知值会回落到简体中文。

---

## 五、约束与注意事项

- `src/shared/settings.ts` 必须保持纯数据 / 无副作用（被两个环境打包）。
- 新增设置务必**同时**改 `LauncherSettings`（类型）与 `SETTINGS_DEFS`（默认值 + 可选 UI），
  否则 `typecheck` 会报错——这是刻意的保护。
- 标准控件只覆盖「标量 + 简单枚举」；需要特殊交互的用 `control: 'custom'` + `rows.tsx`。
- `ui.options[].labelKey` 与 `ui.labelKey` / `ui.hintKey` 都是 **i18n 键**，需按
  [I18N.md](./I18N.md) 的规范补三语文案。
- 键名 / 语言 id 一旦发布就不要再改（等同破坏性变更）。

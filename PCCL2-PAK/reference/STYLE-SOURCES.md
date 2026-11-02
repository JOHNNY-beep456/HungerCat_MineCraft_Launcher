# PCL 原生 WPF 样式来源与适配记录

本实现为第三方 PCCL2 的标准 WPF 样式适配，视觉参考作者为龙腾猫跃（Meloong-Git），不是 PCL 官方发行版。用户在本任务中表示已获得作者许可；这是用户提供的授权声明，本代理没有独立核验授权文件或授权范围。

## 固定来源

- 仓库：https://github.com/Meloong-Git/PCL
- 固定提交：`93ede5d9e638c99fcec853a9ba1eecd91ceee7f5`
- 提交链接：https://github.com/Meloong-Git/PCL/commit/93ede5d9e638c99fcec853a9ba1eecd91ceee7f5
- 取证日期：2026-11-01（Asia/Shanghai）。先以 GitHub commits/HEAD API 解析提交，再以 contents API 的 `ref` 参数逐个下载。
- 下载使用 Python `urllib.request` 默认 TLS 验证。curl 的 Windows 证书吊销检查失败后切换 Python 的正常证书验证；未设置任何跳过 TLS 验证选项。
- `upstream/` 保存选定原始文件，未下载仓库或依赖树。`fetch-upstream.py` 提供可复现下载。
- 原始许可文件名为 **LICENCE**（不是 LICENSE），其完整 UTF-8 原文保存在 [LICENCE](upstream/LICENCE)，没有改写。它包含《PCL 分发有限许可》的外部链接及《PCL 存储库合理使用指南》。这不是 MIT/GPL 等通用许可；此记录不声称已完成许可合规审查。

## 源码到本地映射

| 固定提交中的上游路径 / 行 | 本地位置 | 采用内容与改写范围 |
| --- | --- | --- |
| `Plain Craft Launcher 2/Application.xaml:22–39` | `../src/App.xaml` 的 `ColorBrush1/2/3/4/5/7/8` | 直接采用颜色值：`#343D4A`、`#0B5BCB`、`#1370F3`、`#4890F5`、`#96C0F9`、`#E0EAFD`、`#EAF2FE`。不是 Electron CSS 提取。 |
| `Application.xaml:61–66,119–132` | 全局文本、按钮、侧栏 | 13px 文本、`#55FFFFFF` 按钮底色、`#F1FFFFFF` 侧栏来自上游。未复制 PCL 私有字体，使用系统 Microsoft YaHei UI/Segoe UI。 |
| `FormMain.xaml:100–120,139–150` | `../src/MainWindow.xaml` 顶部与侧栏 | 48px 蓝色标题区域、白色导航、浅白侧栏。保留本项目标准 OS 标题栏及已有生命周期事件；没有移植上游无边框窗口、缩放器与 VB 窗口管理。 |
| `Controls/MyButton.xaml:6–14` | `App.xaml` 隐式 Button 模板 | 3px 圆角、1px 轮廓、居中内容与中心缩放。标准 WPF Button 替代上游自定义 Border 控件；常规/主按钮均蓝色轮廓，主按钮白底，不再是实心蓝块。 |
| `Controls/MyButton.xaml.vb:72–94,150–173` | Button 原生触发器和 Storyboard | 悬停进入100ms、退出200ms；按压0.955/80ms，释放恢复1/300ms。上游 VB 动画调度器改写为 XAML Storyboard；悬停用浅蓝叠层淡入淡出，未逐帧复制色彩插值、额外700ms缩放与自定义缓动。 |
| `Application.xaml:241–281` 与 `Controls/MyTextBox.vb` | TextBox 模板 | 蓝色边线、3px圆角、输入内容宿主 `PART_ContentHost`、焦点浅蓝底。保留本地文本事件；未移植上游验证提示、剪贴板拦截和自定义属性。 |
| `Application.xaml:336–369` 与 `Controls/MyComboBox.vb` | ComboBox/ComboBoxItem 模板 | 3px轮廓、可切换下拉、SelectionBoxItem、`PART_Popup`、Fade、320px上限。使用标准 ToggleButton/ScrollViewer，适配当前非可编辑下拉框，未移植删除项与可编辑模式。 |
| `Controls/MyCard.vb:63–70` | Card 样式 | 5px圆角与 `#F5FFFFFF` 背景直接取值；上游 SystemDropShadowChrome 改为原生 DropShadowEffect，阴影数值为近似适配。 |
| `Controls/MyListItem.xaml`、`Controls/MyRadioButton.xaml` | 列表项和 Nav 样式 | 参考选中/悬停浅蓝与白色导航的结构语言，标准控件模板重写，未复制自定义列表或导航控件。 |

## 布局基线与本地保留项

900×550 窗口、启动侧栏300px、其他页面侧栏122px采用用户指定截图基线。这些尺寸不是声称来自当前上游 `FormMain.xaml` 的默认窗口尺寸（其为850×500）。标准 Windows 窗口装饰占用客户区，不能声称截图与 PCL 无边框窗口逐像素相同。

启动页保留账户、版本、启动/停止；下载页的原两项顶部切换移动到122px左栏；设置与更多保留现有命名容器并增加相同宽度左栏。所有既有 x:Name、事件处理器和业务绑定保留，未修改 C#。状态栏、账户头像占位、空白启动背景、功能数量和部分辅助文本颜色属于本地实现。主背景改用上游蓝色系，去除先前粉色渐变。

## 本次直接复用的编译资源

- `PCCL2-PAK/src/Upstream/PclPalette.xaml`：直接整理自固定提交 `Application.xaml:22–66` 的颜色、颜色对象和透明度资源；保留上游键名，供本项目现有样式通过 `StaticResource` 实际使用。
- `PCCL2-PAK/src/Upstream/PclStandardTemplates.xaml`：直接整理自固定提交 `Application.xaml:81–98`、`136–147`、`Application.xaml:约 490–526` 的标准 WPF `Label`、`Thumb`、`ListBoxItem`、`ComboBoxItem` 样式/模板。为保持独立编译，模板改为显式字典键 `PclLabel`、`PclScrollBarThumb`、`PclListBoxItem`、`PclComboBoxItem`，其中隐式 `Label`、`ListBoxItem`、`ComboBoxItem` 已在 `App.xaml` 中基于这些资源工作。
- `App.xaml` 仅合并上述字典，并保留既有 `Nav`、`Primary`、`Card`、`Heading` 键及现有隐式 `Button`、`TextBox`、`ComboBox` 依赖；`MainWindow.xaml/.cs` 未修改。

上游 `MyButton.xaml`、`MyListItem.xaml`、`MyRadioButton.xaml` 包含自定义 CLR 控件和 VB 代码行为，不能在本项目无 PCL 核心类型时直接作为编译资源；本实现继续使用标准 WPF 控件模板适配，因此不声称完整复刻 PCL 前端。上游 `Application.xaml` 中依赖 `MeloongCore`、`PCL.Controls.Behaviors`、`MyTextBox`、`MyComboBox`、`MyScrollViewer` 的资源同样被明确排除。

## 验证与限制

执行 `dotnet build PCCL2-PAK/src/PCCL2.Native.csproj -c Release`，要求 0 警告、0 错误；未进行原生窗口截图或像素比对。

此记录撰写时没有对本次修改后的原生窗口进行截图或像素比对；先前版本的 smoke pass 不能作为本次外观验证。应检查900×550下账户/启动区是否溢出、下拉弹层、四页侧栏、键盘焦点与按钮动画。这里声称的是来源可追溯的 WPF 适配，不声称完整复刻或视觉完全匹配。

## 附录：主窗口无边框适配（2026-11-01）

此附录更新上文对标准 OS 标题栏、未修改 C# 和未截图验证的历史描述，不改写前次记录。MainWindow.xaml 现在使用标准 WPF WindowChrome（48px CaptionHeight、6px ResizeBorderThickness），由原生标题命中区处理拖动、双击、系统菜单与缩放。最小化/最大化/还原/关闭调用 SystemCommands，关闭仍经过原有桥接生命周期。MainWindow.xaml.cs 使用 WM_GETMINMAXINFO 与当前显示器工作区修正最大化边界，避免遮盖任务栏。

四个顶部导航的 Geometry 直接取自固定上游 FormMain.xaml:121–130（启动、下载、设置、更多），最小化和关闭图形取自107–110行；最大化/还原为本地标准矩形线框。独立 IsNavSelected 附加属性驱动白色选中底，保留原 Tag 路由及全部既有 x:Name/事件。本次主窗口适配未更改 App.xaml。

启动左栏为300px纯白：登录方式入口、居中头像和用户名、账户选择、底部版本及轮廓启动/停止按钮；登录入口复用真实账户管理桥接，不增加认证协议。右区为 ColorBrush8 纯色，无水印。更多页展示第三方声明、原作者龙腾猫跃（Meloong-Git）、仓库和固定提交 URL，不作许可结论。新增界面文案提供简中/繁中/英文。

实际 Release 构建0警告0错误；直接运行本次构建的 WPF exe 完成 stdio ui.ready/state.get、含 null authType 的状态载入与 EOF 正常退出冒烟。原生截图验证900×550启动页、更多页及选中态，实际调用最大化/还原/关闭并读回确认；最大化后底部状态栏完整显示。拖动、双击、边缘缩放、多显示器/不同DPI、真实游戏启动与在线认证尚未逐项实测。已修复状态加载优先使用 settings.selectedVersionId，以及 null/缺省/offline authType 归类离线。


## 完整原版前端接入（用户后续要求）

在后续要求下，组件不再采用本文前半部分所述的简化适配 WPF。`src/PclFrontend/upstream/` 使用固定提交 `93ede5d9e638c99fcec853a9ba1eecd91ceee7f5` 的完整 VB/WPF 项目，以及对应 `MeloongCore` 提交 `4c60c2962c3b50bc3fe96ed5dd9259b980173580`。原始页面、控件、导航和动画保持原项目结构；宿主桥接只负责窗口生命周期。

用户声明已取得作者许可，未独立核验授权范围。组件主窗口标题为 `PCL-HCMCL`；按用户要求移除了上游开源版首次说明弹窗，其他页面与主题保留。宿主配置与敏感凭据不进入组件清单或包内。

原项目需要桌面 MSBuild 与 .NET Framework 4.8，已用本机 Visual Studio Build Tools 实际构建成功。完整原版页面已启动并发出 ui.ready；完整 Electron 端到端与真实游戏启动仍未验证。

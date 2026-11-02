namespace PCCL2.Native;

internal static class Strings
{
    private static readonly Dictionary<string, string[]> Text = new()
    {
        ["launch"] = ["启动", "啟動", "Launch"], ["download"] = ["下载", "下載", "Download"],
        ["settings"] = ["设置", "設定", "Settings"], ["more"] = ["更多", "更多", "More"],
        ["account"] = ["游戏账户", "遊戲帳戶", "Game account"], ["manageAccounts"] = ["管理账户", "管理帳戶", "Manage accounts"],
        ["version"] = ["游戏版本", "遊戲版本", "Game version"], ["manageInstance"] = ["版本设置", "版本設定", "Manage version"],
        ["play"] = ["启动游戏", "啟動遊戲", "Launch game"], ["stop"] = ["停止游戏", "停止遊戲", "Stop game"],
        ["versions"] = ["游戏版本", "遊戲版本", "Game versions"], ["resources"] = ["社区资源", "社群資源", "Community resources"],
        ["downloadTitle"] = ["下载 Minecraft", "下載 Minecraft", "Download Minecraft"], ["refresh"] = ["刷新", "重新整理", "Refresh"],
        ["installVersion"] = ["安装选中版本", "安裝選取版本", "Install selected version"],
        ["discover"] = ["发现社区资源", "探索社群資源", "Discover community resources"], ["search"] = ["搜索", "搜尋", "Search"],
        ["moreResults"] = ["更多结果", "更多結果", "More results"], ["installResource"] = ["安装到实例", "安裝至實例", "Install to instance"],
        ["settingsTitle"] = ["启动器设置", "啟動器設定", "Launcher settings"], ["memory"] = ["游戏内存（MiB）", "遊戲記憶體（MiB）", "Game memory (MiB)"],
        ["source"] = ["下载源", "下載來源", "Download source"], ["language"] = ["界面语言", "介面語言", "Language"],
        ["save"] = ["保存设置", "儲存設定", "Save settings"], ["about"] = ["原生 Windows 界面 · 熟悉的 Minecraft 体验", "原生 Windows 介面 · 熟悉的 Minecraft 體驗", "Native Windows interface · Your familiar Minecraft experience"],
        ["restore"] = ["返回完整启动器", "返回完整啟動器", "Return to full launcher"], ["refreshState"] = ["刷新启动器状态", "重新整理啟動器狀態", "Refresh launcher state"],
        ["cancel"] = ["取消下载", "取消下載", "Cancel download"], ["connecting"] = ["正在连接启动器…", "正在連線至啟動器…", "Connecting to launcher…"],
        ["ready"] = ["准备就绪", "準備就緒", "Ready"], ["working"] = ["正在处理…", "正在處理…", "Working…"],
        ["done"] = ["操作完成", "操作完成", "Completed"], ["offline"] = ["离线账户", "離線帳戶", "Offline account"],
        ["online"] = ["已登录账户", "已登入帳戶", "Signed-in account"], ["noAccount"] = ["请添加游戏账户", "請新增遊戲帳戶", "Add a game account"],
        ["noVersion"] = ["请先安装并选择游戏版本", "請先安裝並選擇遊戲版本", "Install and select a game version first"],
        ["choose"] = ["请先选择要操作的项目", "請先選擇要操作的項目", "Select an item first"],
        ["memoryError"] = ["请输入 512–65536 范围内的整数内存值。", "請輸入 512–65536 範圍內的整數記憶體值。", "Enter a whole number between 512 and 65536 MiB."],
        ["standalone"] = ["请从启动器打开 PCCL2，以连接账户与下载服务。", "請從啟動器開啟 PCCL2，以連線至帳戶與下載服務。", "Open PCCL2 from the launcher to connect accounts and downloads."],
        ["empty"] = ["没有找到匹配项目", "找不到符合項目", "No matching items"],
        ["mod"] = ["模组", "模組", "Mods"], ["resourcepack"] = ["资源包", "資源包", "Resource packs"], ["shader"] = ["光影", "光影", "Shaders"],
        ["auto"] = ["自动选择", "自動選擇", "Automatic"], ["mirror-first"] = ["优先镜像源", "優先鏡像來源", "Prefer mirror"], ["official-first"] = ["优先官方源", "優先官方來源", "Prefer official"],
        ["error"] = ["操作失败", "操作失敗", "Operation failed"], ["release"] = ["正式版", "正式版", "Release"], ["snapshot"] = ["快照", "快照", "Snapshot"],
    };
    public static string Get(string key, string language) => Text.TryGetValue(key, out var values) ? values[language == "zh-TW" ? 1 : language.StartsWith("en") ? 2 : 0] : key;
}

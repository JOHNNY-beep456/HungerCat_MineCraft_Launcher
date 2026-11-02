using System.ComponentModel;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media.Imaging;

namespace PCCL2.Native;

public partial class MainWindow : Window
{
    // 保留导航 Tag 的路由语义；独立附加属性承载选中态与上游矢量图形。
    public static readonly DependencyProperty IsNavSelectedProperty = DependencyProperty.RegisterAttached("IsNavSelected", typeof(bool), typeof(MainWindow), new PropertyMetadata(false));
    public static bool GetIsNavSelected(DependencyObject obj) => (bool)obj.GetValue(IsNavSelectedProperty);
    public static void SetIsNavSelected(DependencyObject obj, bool value) => obj.SetValue(IsNavSelectedProperty, value);
    public static readonly DependencyProperty NavIconProperty = DependencyProperty.RegisterAttached("NavIcon", typeof(System.Windows.Media.Geometry), typeof(MainWindow));
    public static System.Windows.Media.Geometry GetNavIcon(DependencyObject obj) => (System.Windows.Media.Geometry)obj.GetValue(NavIconProperty);
    public static void SetNavIcon(DependencyObject obj, System.Windows.Media.Geometry value) => obj.SetValue(NavIconProperty, value);
    private string Local(string cn, string tw, string en) => language == "en" ? en : language == "zh-TW" ? tw : cn;
    private void MinimizeClick(object sender, RoutedEventArgs e) => SystemCommands.MinimizeWindow(this);
    private void MaximizeClick(object sender, RoutedEventArgs e) { if (WindowState == WindowState.Maximized) SystemCommands.RestoreWindow(this); else SystemCommands.MaximizeWindow(this); }
    private void CloseClick(object sender, RoutedEventArgs e) => SystemCommands.CloseWindow(this);
    // 使用当前显示器工作区，避免无边框最大化覆盖任务栏；坐标为 Win32 物理像素，支持负坐标副屏。
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct NativePoint { public int X, Y; }
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct NativeRect { public int Left, Top, Right, Bottom; }
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct MinMaxInfo { public NativePoint Reserved, MaxSize, MaxPosition, MinTrackSize, MaxTrackSize; }
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct MonitorInfo { public int Size; public NativeRect Monitor, Work; public uint Flags; }
    [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Auto)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    private IntPtr WindowMessage(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (message == 0x0024)
        {
            var monitor = new MonitorInfo { Size = System.Runtime.InteropServices.Marshal.SizeOf<MonitorInfo>() };
            if (GetMonitorInfo(MonitorFromWindow(hwnd, 2), ref monitor))
            {
                var bounds = System.Runtime.InteropServices.Marshal.PtrToStructure<MinMaxInfo>(lParam);
                bounds.MaxPosition = new NativePoint { X = monitor.Work.Left - monitor.Monitor.Left, Y = monitor.Work.Top - monitor.Monitor.Top };
                bounds.MaxSize = new NativePoint { X = monitor.Work.Right - monitor.Work.Left, Y = monitor.Work.Bottom - monitor.Work.Top };
                System.Runtime.InteropServices.Marshal.StructureToPtr(bounds, lParam, false);
                handled = true;
            }
        }
        return IntPtr.Zero;
    }
    private void UpdateCaption()
    {
        var maximized = WindowState == WindowState.Maximized;
        MaximizeGlyph.Data = System.Windows.Media.Geometry.Parse(maximized ? "M3,0 H12 V9 M0,3 H9 V12 H0 Z" : "M0,0 H12 V12 H0 Z");
        System.Windows.Automation.AutomationProperties.SetName(MaximizeButton, maximized ? Local("还原", "還原", "Restore") : Local("最大化", "最大化", "Maximize"));
        MaximizeButton.ToolTip = System.Windows.Automation.AutomationProperties.GetName(MaximizeButton);
    }
    public record Item(string Id, string Name, string Description = "", JsonElement Data = default);
    private readonly Bridge? bridge;
    private string language = "zh-CN";
    private bool updating, closing, allowClose;
    private List<Item> manifest = [];
    private List<Item> resourceHits = [];
    private int resourceGeneration;
    private string? taskId;
    private string? lastQuery, lastType;
    private string T(string key) => Strings.Get(key, language);
    private static JsonElement P(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var p) ? p : default;
    private static string S(JsonElement e, string name, string fallback = "") => P(e, name).ValueKind == JsonValueKind.String ? P(e, name).GetString()! : fallback;
    private static IEnumerable<JsonElement> Array(JsonElement e) => e.ValueKind == JsonValueKind.Array ? e.EnumerateArray().ToArray() : [];
    private static string? Id(ComboBox control) => (control.SelectedItem as Item)?.Id;
    public MainWindow(bool bridged)
    {
        InitializeComponent();
        ApplyLanguage();
        // WindowChrome 的原生标题命中区处理拖动、双击最大化、系统菜单与边缘缩放。
        StateChanged += (_, _) => UpdateCaption();
        SourceInitialized += (_, _) => System.Windows.Interop.HwndSource.FromHwnd(new System.Windows.Interop.WindowInteropHelper(this).Handle)?.AddHook(WindowMessage);
        if (bridged)
        {
            bridge = new Bridge();
            bridge.Event += (name, data) => Dispatcher.BeginInvoke(() => OnEvent(name, data));
            bridge.Disconnected += () => Dispatcher.BeginInvoke(() => { allowClose = true; Close(); });
        }
        Closed += (_, _) => bridge?.Dispose();
    }
    private void ApplyLanguage()
    {
        (Button button, string key)[] buttons = [(NavLaunch,"launch"),(NavDownload,"download"),(NavSettings,"settings"),(NavMore,"more"),(ManageAccounts,"manageAccounts"),(ManageInstance,"manageInstance"),(LaunchButton,"play"),(StopButton,"stop"),(VersionsTab,"versions"),(ResourcesTab,"resources"),(RefreshManifest,"refresh"),(InstallVersionButton,"installVersion"),(SearchButton,"search"),(MoreResults,"moreResults"),(InstallResourceButton,"installResource"),(SaveSettings,"save"),(RestoreShell,"restore"),(RefreshState,"refreshState"),(CancelDownload,"cancel")];
        foreach (var (button, key) in buttons) { button.Content = T(key); System.Windows.Automation.AutomationProperties.SetName(button, T(key)); }
        (TextBlock text, string key)[] labels = [(AccountLabel,"account"),(VersionLabel,"version"),(DownloadHeading,"downloadTitle"),(ResourcesHeading,"discover"),(SettingsHeading,"settingsTitle"),(MemoryLabel,"memory"),(SourceLabel,"source"),(LanguageLabel,"language"),(AboutText,"about")];
        foreach (var (text,key) in labels) text.Text = T(key);
        AccountLabel.Text = Local("登录方式", "登入方式", "Login method");
        OfflineLogin.Content = Local("离线登录", "離線登入", "Offline");
        OnlineLogin.Content = Local("正版登录", "正版登入", "Microsoft");
        AttributionText.Text = Local("第三方界面参考，非 PCL 官方发行版。视觉与导航图形参考 PCL，原作者：龙腾猫跃（Meloong-Git）。", "第三方介面參考，非 PCL 官方發行版。視覺與導覽圖形參考 PCL，原作者：龍騰貓躍（Meloong-Git）。", "Third-party interface reference; not an official PCL distribution. Visuals and navigation geometry reference PCL by 龙腾猫跃 (Meloong-Git).");
        System.Windows.Automation.AutomationProperties.SetName(MinimizeButton, Local("最小化", "最小化", "Minimize"));
        System.Windows.Automation.AutomationProperties.SetName(CloseButton, Local("关闭", "關閉", "Close"));
        MinimizeButton.ToolTip = System.Windows.Automation.AutomationProperties.GetName(MinimizeButton);
        CloseButton.ToolTip = System.Windows.Automation.AutomationProperties.GetName(CloseButton);
        UpdateCaption();
        var resourceType = Id(ResourceType) ?? "mod";
        ResourceType.ItemsSource = new[] { "mod", "resourcepack", "shader" }.Select(id => new Item(id,T(id))).ToList();
        ResourceType.SelectedItem = ResourceType.Items.Cast<Item>().First(i => i.Id == resourceType);
        var source = Id(SourceInput) ?? "auto";
        SourceInput.ItemsSource = new[] { "auto", "mirror-first", "official-first" }.Select(id => new Item(id,T(id))).ToList();
        SourceInput.SelectedItem = SourceInput.Items.Cast<Item>().FirstOrDefault(i => i.Id == source) ?? SourceInput.Items[0];
        LanguageInput.ItemsSource = new[] { new Item("zh-CN","简体中文"), new Item("zh-TW","繁體中文"), new Item("en","English") };
        LanguageInput.SelectedItem = LanguageInput.Items.Cast<Item>().FirstOrDefault(i => i.Id == language) ?? LanguageInput.Items[0];
        StatusText.Text = T("connecting");
    }
    private async void WindowLoaded(object sender, RoutedEventArgs e)
    {
        if (bridge is null) { StatusText.Text = T("standalone"); return; }
        bridge.Start();
        await Run(async () => { await bridge.Request("ui.ready"); await LoadState(); });
    }
    private async Task<JsonElement> Request(string method, object? args = null, int timeout = 30)
    {
        if (bridge is null) throw new InvalidOperationException(T("standalone"));
        return await bridge.Request(method, args, timeout);
    }
    private async Task Run(Func<Task> action, Button? button = null)
    {
        if (button is not null) button.IsEnabled = false;
        StatusText.Text = T("working");
        try { await action(); StatusText.Text = T("done"); }
        catch (Exception e) { StatusText.Text = T("error") + ": " + e.Message; }
        finally { if (button is not null) button.IsEnabled = true; }
    }
    private async Task LoadState()
    {
        var state = await Request("state.get");
        var settings = P(state, "settings");
        language = S(settings,"language","zh-CN");
        updating = true;
        try
        {
            ApplyLanguage();
            var oldAccount = Id(Accounts);
            var accounts = Array(P(state,"accounts")).Select(a => new Item(S(a,"id"),S(a,"name"),Data:a)).ToList();
            Accounts.ItemsSource = accounts;
            var selected = S(state,"selectedAccountId",S(settings,"selectedAccountId",S(settings,"activeAccountId",oldAccount ?? "")));
            Accounts.SelectedItem = accounts.FirstOrDefault(a => a.Id == selected) ?? accounts.FirstOrDefault();
            UpdateAccount();
            var oldVersion = Id(InstalledVersions);
            var installed = Array(P(state,"installed")).Select(v => new Item(S(v,"id"),S(v,"id") + (S(v,"loader") is { Length: >0 } loader ? " · " + loader : ""),Data:v)).ToList();
            InstalledVersions.ItemsSource = installed;
            InstalledVersions.SelectedItem = installed.FirstOrDefault(v => v.Id == S(settings,"selectedVersionId")) ?? installed.FirstOrDefault(v => v.Id == oldVersion) ?? installed.FirstOrDefault();
            var target = Id(TargetInstance);
            TargetInstance.ItemsSource = installed;
            TargetInstance.SelectedItem = installed.FirstOrDefault(v => v.Id == target) ?? installed.FirstOrDefault();
            MemoryInput.Text = P(settings,"memoryMb").ValueKind == JsonValueKind.Number ? P(settings,"memoryMb").ToString() : "4096";
            SourceInput.SelectedItem = SourceInput.Items.Cast<Item>().FirstOrDefault(i => i.Id == S(settings,"downloadSource")) ?? SourceInput.Items[0];
        }
        finally { updating = false; }
        StatusText.Text = T("ready");
    }
    private void UpdateAccount()
    {
        var account = Accounts.SelectedItem as Item;
        AccountName.Text = account?.Name ?? T("noAccount");
        var authType = account is null ? "" : S(account.Data,"authType");
        var offline = account is not null && (P(account.Data,"offline").ValueKind == JsonValueKind.True || string.IsNullOrWhiteSpace(authType) || authType == "offline");
        AccountType.Text = account is null ? "HCMCL PCCL2" : T(offline ? "offline" : "online");
        Avatar.Source = null;
        // 皮肤纹理只截取脸部；不向第三方头像服务发送账户标识。
        if (account is not null && Uri.TryCreate(S(account.Data,"skinUrl"), UriKind.Absolute, out var uri) && uri.Scheme == "https")
        {
            try
            {
                var image = new BitmapImage(); image.BeginInit(); image.UriSource = uri; image.CacheOption = BitmapCacheOption.OnDemand; image.EndInit();
                void SetFace() { if (ReferenceEquals(Accounts.SelectedItem, account) && image.PixelWidth >= 16 && image.PixelHeight >= 16) Avatar.Source = new CroppedBitmap(image,new Int32Rect(8,8,8,8)); }
                image.DownloadCompleted += (_, _) => SetFace(); image.DownloadFailed += (_, _) => { };
                if (!image.IsDownloading) SetFace();
            }
            catch (Exception) { Console.Error.WriteLine("PCCL2: avatar unavailable"); }
        }
    }
    private async void AccountChanged(object sender, SelectionChangedEventArgs e)
    {
        UpdateAccount();
        if (!updating && Id(Accounts) is { } id) await Run(async () => { await Request("accounts.select",new { accountId=id }); });
    }
    private async void Navigate(object sender, RoutedEventArgs e)
    {
        var page = (sender as Button)?.Tag as string;
        foreach (var button in new[] { NavLaunch, NavDownload, NavSettings, NavMore }) SetIsNavSelected(button, Equals(button.Tag, page));
        LaunchPage.Visibility = page == "Launch" ? Visibility.Visible : Visibility.Collapsed;
        DownloadPage.Visibility = page == "Download" ? Visibility.Visible : Visibility.Collapsed;
        SettingsPage.Visibility = page == "Settings" ? Visibility.Visible : Visibility.Collapsed;
        MorePage.Visibility = page == "More" ? Visibility.Visible : Visibility.Collapsed;
        if (page == "Download" && manifest.Count == 0) await Run(LoadManifest);
    }
    private async Task LoadManifest()
    {
        var data = await Request("versions.manifest", timeout:60);
        manifest = Array(data.ValueKind == JsonValueKind.Array ? data : P(data,"versions")).Select(v => new Item(S(v,"id"),S(v,"id") + "    ·    " + T(S(v,"type")),Data:v)).ToList();
        FilterManifest();
    }
    private void FilterManifest() { if (ManifestList is not null) ManifestList.ItemsSource = manifest.Where(i => i.Id.Contains(VersionFilter.Text, StringComparison.OrdinalIgnoreCase)).ToList(); }
    private void VersionFilterChanged(object sender, TextChangedEventArgs e) => FilterManifest();
    private async void RefreshManifestClick(object sender, RoutedEventArgs e) => await Run(LoadManifest, RefreshManifest);
    private void VersionsTabClick(object sender, RoutedEventArgs e) { VersionsPane.Visibility=Visibility.Visible; ResourcesPane.Visibility=Visibility.Collapsed; }
    private void ResourcesTabClick(object sender, RoutedEventArgs e) { VersionsPane.Visibility=Visibility.Collapsed; ResourcesPane.Visibility=Visibility.Visible; SearchQuery.Focus(); }
    private async void InstallVersionClick(object sender, RoutedEventArgs e) => await Run(async () =>
    {
        var version = ManifestList.SelectedItem as Item ?? throw new InvalidOperationException(T("choose"));
        await Request("versions.install",new { versionId=version.Id },3600); await LoadState();
    },InstallVersionButton);
    private async void LaunchClick(object sender, RoutedEventArgs e) => await Run(async () =>
    {
        var versionId = Id(InstalledVersions) ?? throw new InvalidOperationException(T("noVersion"));
        var accountId = Id(Accounts) ?? throw new InvalidOperationException(T("noAccount"));
        await Request("launch",new { versionId,accountId },300);
    },LaunchButton);
    private async void StopClick(object sender, RoutedEventArgs e) => await Run(async () => { await Request("launch.stop"); }, StopButton);
    private async void ManageAccountsClick(object sender,RoutedEventArgs e) => await Run(async () => { await Request("accounts.manage"); });
    private async void ManageInstanceClick(object sender,RoutedEventArgs e) => await Run(async () => { await Request("instances.manage",new { versionId=Id(InstalledVersions) ?? throw new InvalidOperationException(T("noVersion")) }); });
    private async void RefreshStateClick(object sender,RoutedEventArgs e) => await Run(LoadState,RefreshState);
    private async void RestoreShellClick(object sender,RoutedEventArgs e) => await Run(async () => { await Request("shell.restore"); });
    private async void CancelDownloadClick(object sender,RoutedEventArgs e) => await Run(async () => { await Request("downloads.cancel",new { taskId }); },CancelDownload);
    private async void SaveSettingsClick(object sender,RoutedEventArgs e) => await Run(async () =>
    {
        if (!int.TryParse(MemoryInput.Text,out var memoryMb) || memoryMb < 512 || memoryMb > 65536) throw new InvalidOperationException(T("memoryError"));
        await Request("settings.set",new { patch=new { memoryMb, downloadSource=Id(SourceInput), language=Id(LanguageInput) } });
        await LoadState();
    },SaveSettings);
    private async Task Search(bool append)
    {
        var query = SearchQuery.Text.Trim(); var type=Id(ResourceType) ?? "mod";
        append = append && query == lastQuery && type == lastType;
        var generation=++resourceGeneration;
        var data=await Request("resources.search",new { query,type,offset=append ? resourceHits.Count : 0 },90);
        if (generation != resourceGeneration) return;
        var hits=Array(data.ValueKind == JsonValueKind.Array ? data : P(data,"hits")).Select(h => new Item(S(h,"projectId",S(h,"project_id",S(h,"slug",S(h,"id")))),S(h,"title",S(h,"name")),S(h,"description"),h)).ToList();
        resourceHits=append ? resourceHits.Concat(hits).DistinctBy(h => h.Id).ToList() : hits;
        lastQuery=query; lastType=type; ResourceList.ItemsSource=resourceHits;
        ResourceVersions.ItemsSource=null;
        if (hits.Count == 0) ProgressText.Text=T("empty");
    }
    private async void SearchClick(object sender,RoutedEventArgs e) => await Run(() => Search(false),SearchButton);
    private async void MoreResultsClick(object sender,RoutedEventArgs e) => await Run(() => Search(true),MoreResults);
    private async void SearchKeyDown(object sender,KeyEventArgs e) { if (e.Key == Key.Enter) { e.Handled=true; await Run(() => Search(false),SearchButton); } }
    private async void ResourceChanged(object sender,SelectionChangedEventArgs e)
    {
        ResourceVersions.ItemsSource=null;
        if (ResourceList.SelectedItem is not Item item) return;
        await Run(async () =>
        {
            var result=await Request("resources.versions",new { projectId=item.Id, type=Id(ResourceType) ?? "mod" },90);
            if (!ReferenceEquals(ResourceList.SelectedItem, item)) return;
            ResourceVersions.ItemsSource=Array(result.ValueKind == JsonValueKind.Array ? result : P(result,"versions")).Select(v => new Item(S(v,"id"),S(v,"name",S(v,"version_number")),Data:v)).ToList();
            if (ResourceVersions.Items.Count > 0) ResourceVersions.SelectedIndex=0;
        });
    }
    private async void InstallResourceClick(object sender,RoutedEventArgs e) => await Run(async () =>
    {
        var project=ResourceList.SelectedItem as Item ?? throw new InvalidOperationException(T("choose"));
        var versionId=Id(ResourceVersions) ?? throw new InvalidOperationException(T("choose"));
        var instanceId=Id(TargetInstance) ?? throw new InvalidOperationException(T("noVersion"));
        await Request("resources.install",new { projectId=project.Id,versionId,instanceId,type=Id(ResourceType) ?? "mod" },1800);
    },InstallResourceButton);
    private void OnEvent(string name,JsonElement data)
    {
        if (name != "progress") return;
        taskId=S(data,"taskId",S(data,"id",taskId ?? ""));
        StatusText.Text=S(data,"message",S(data,"status",S(data,"phase",T("working"))));
        var value=P(data,"percent"); var fractional=false;
        if (value.ValueKind != JsonValueKind.Number) { value=P(data,"progress"); fractional=true; }
        if (value.TryGetDoubleSafe(out var number)) { TaskProgress.IsIndeterminate=false; TaskProgress.Value=Math.Clamp(fractional && number <= 1 ? number*100 : number,0,100); ProgressText.Text=$"{TaskProgress.Value:0}%"; }
        else { TaskProgress.IsIndeterminate=true; ProgressText.Text=""; }
    }
    private async void WindowClosing(object? sender,CancelEventArgs e)
    {
        if (allowClose || bridge is null) return;
        e.Cancel=true;
        if (closing) return;
        closing=true;
        try { await bridge.Request("shell.restore",timeoutSeconds:3); }
        catch (Exception) { Console.Error.WriteLine("PCCL2: restore unavailable during close"); }
        finally { allowClose=true; Close(); }
    }
}
internal static class JsonNumbers
{
    public static bool TryGetDoubleSafe(this JsonElement element,out double value) { value=0; return element.ValueKind == JsonValueKind.Number && element.TryGetDouble(out value) && double.IsFinite(value); }
}

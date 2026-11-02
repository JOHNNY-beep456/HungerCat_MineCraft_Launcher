Imports Newtonsoft.Json.Linq
Imports System.Threading.Tasks

' 原生启动页仅使用 HCMCL 账号与实例，不触发上游自动登录/自动启动。
Public Class HcmclLaunchLeft
    Inherits MyPageLeft
    Private ReadOnly Accounts As New ComboBox With {.Margin = New Thickness(0, 12, 0, 12), .MinHeight = 32, .DisplayMemberPath = "Content", .SelectedValuePath = "Tag"}
    Private ReadOnly InstanceText As New TextBlock With {.TextWrapping = TextWrapping.Wrap, .Margin = New Thickness(0, 12, 0, 12)}
    Private ReadOnly Message As New TextBlock With {.TextWrapping = TextWrapping.Wrap, .Margin = New Thickness(0, 8, 0, 8)}
    Private Refreshing As Boolean
    Private VersionId As String = ""

    Public Sub New()
        Width = 300
        Dim body As New StackPanel With {.Margin = New Thickness(24)}
        body.Children.Add(New TextBlock With {.Text = "HCMCL 账号", .FontSize = 18})
        body.Children.Add(Accounts)
        Dim manage As New MyButton With {.Text = "管理账号", .Height = 35}
        AddHandler manage.Click, Sub(s, e) FrmMain.PageChange(FormMain.PageType.HcmclAccounts)
        body.Children.Add(manage)
        body.Children.Add(InstanceText)
        Dim choose As New MyButton With {.Text = "选择实例", .Height = 35}
        AddHandler choose.Click, Sub(s, e) FrmMain.PageChange(FormMain.PageType.HcmclInstances)
        body.Children.Add(choose)
        Dim launch As New MyButton With {.Text = "启动游戏", .Height = 45, .Margin = New Thickness(0, 16, 0, 0), .ColorType = MyButton.ColorState.Highlight}
        AddHandler launch.Click, Sub(s, e) HcmclLaunchFlow.Start(VersionId)
        body.Children.Add(launch)
        body.Children.Add(Message)
        Children.Add(body)
        AddHandler Loaded, Sub() RefreshState()
        AddHandler Accounts.SelectionChanged, AddressOf SelectAccount
    End Sub

    Public Async Sub RefreshState()
        If Refreshing Then Return
        Refreshing = True
        Try
            Dim state = Await Task.Run(Function() HcmclHostBridge.Request("state.get"))
            Accounts.Items.Clear()
            For Each account In CType(state("accounts"), JArray)
                Dim id = account("id").ToString()
                Dim item As New ComboBoxItem With {.Content = account("name").ToString() & " · " & account("authType").ToString(), .Tag = id}
                Accounts.Items.Add(item)
                If id = state("selectedAccountId")?.ToString() Then Accounts.SelectedItem = item
            Next
            VersionId = If(state("settings")("selectedVersionId")?.ToString(), "")
            InstanceText.Text = "当前实例：" & If(String.IsNullOrEmpty(VersionId), "尚未选择", VersionId)
            Message.Text = If(Accounts.Items.Count = 0, "请先添加账号。选择账号只更新选择，不会启动游戏。", "切换账号不会启动游戏。")
        Catch ex As Exception
            Message.Text = "读取 HCMCL 状态失败：" & ex.Message
        Finally
            Refreshing = False
        End Try
    End Sub

    Private Async Sub SelectAccount(sender As Object, e As SelectionChangedEventArgs)
        If Refreshing OrElse Accounts.SelectedItem Is Nothing Then Return
        Dim id = CType(Accounts.SelectedItem, ComboBoxItem).Tag.ToString()
        Try
            Await Task.Run(Function() HcmclHostBridge.Request("accounts.select", New JObject From {{"accountId", id}}))
            Message.Text = "账号已选择，尚未启动游戏。"
        Catch ex As Exception
            Message.Text = "选择账号失败：" & ex.Message
        End Try
    End Sub
End Class

Public Class HcmclLaunchRight
    Inherits MyPageRight
    Private ReadOnly Steps As New TextBlock With {.TextWrapping = TextWrapping.Wrap, .Margin = New Thickness(24), .FontSize = 15}
    Public Sub New()
        Child = New ScrollViewer With {.Content = Steps, .VerticalScrollBarVisibility = ScrollBarVisibility.Auto}
        Steps.Text = "请选择 HCMCL 账号和实例。点击启动后，此处显示准备、下载依赖和游戏启动流程。"
    End Sub
    Public Sub ShowStep(text As String)
        Steps.Text &= Environment.NewLine & Date.Now.ToString("HH:mm:ss") & "  " & text
    End Sub
    Public Sub BeginLaunch(version As String)
        Steps.Text = "正在启动：" & version
    End Sub
End Class

Public Module HcmclLaunchFlow
    Public LeftPage As HcmclLaunchLeft
    Public RightPage As HcmclLaunchRight
    Private Running As Boolean
    Private Hooked As Boolean

    Public Sub EnsurePages()
        If LeftPage Is Nothing Then LeftPage = New HcmclLaunchLeft
        If RightPage Is Nothing Then RightPage = New HcmclLaunchRight
        If Not Hooked Then
            AddHandler HcmclHostBridge.ProgressReceived, AddressOf OnProgress
            Hooked = True
        End If
    End Sub

    Private Sub OnProgress(data As JToken)
        If Not Running OrElse data Is Nothing Then Return
        Dim state = data("state")?.ToString()
        Dim text As String = Nothing
        Select Case state
            Case "downloading" : text = "正在检查并下载游戏依赖……"
            Case "launching" : text = "正在准备 Java 并启动游戏进程……"
            Case "running", "started" : text = "游戏进程已启动。"
            Case "exited" : text = "游戏进程已退出。"
            Case "error" : text = "启动失败：" & data("error")?.ToString()
        End Select
        If text Is Nothing AndAlso data("percent") IsNot Nothing Then text = "依赖下载进度：" & data("percent").ToString() & "%"
        If text IsNot Nothing Then RightPage.Dispatcher.BeginInvoke(New Action(Sub() RightPage.ShowStep(text)))
    End Sub

    Public Async Sub Start(versionId As String)
        If Running Then Return
        EnsurePages()
        FrmMain.PageChange(FormMain.PageType.Launch)
        RightPage.BeginLaunch(If(versionId, ""))
        Running = True
        Try
            RightPage.ShowStep("读取 HCMCL 账号与实例配置……")
            Dim state = Await Task.Run(Function() HcmclHostBridge.Request("state.get"))
            Dim accountId = state("selectedAccountId")?.ToString()
            If String.IsNullOrWhiteSpace(versionId) Then Throw New InvalidOperationException("请先选择实例")
            If String.IsNullOrWhiteSpace(accountId) Then Throw New InvalidOperationException("请先选择账号")
            Await Task.Run(Function() HcmclHostBridge.Request("settings.set", New JObject From {{"patch", New JObject From {{"selectedVersionId", versionId}}}}))
            LeftPage.RefreshState()
            RightPage.ShowStep("请求 HCMCL 启动服务……")
            Dim result = Await Task.Run(Function() HcmclHostBridge.Request("launch", New JObject From {{"versionId", versionId}, {"accountId", accountId}}, 300000))
            RightPage.ShowStep("游戏进程已启动，PID：" & result("pid")?.ToString())
            If Environment.GetEnvironmentVariable("HCMCL_VERIFY_PAGE") = "launch" AndAlso FrmMain.PageCurrent.Page = FormMain.PageType.Launch Then HcmclHostBridge.NotifyVerifiedPage("launch", 1)
        Catch ex As Exception
            RightPage.ShowStep("启动失败：" & ex.Message)
        Finally
            Running = False
        End Try
    End Sub
End Module

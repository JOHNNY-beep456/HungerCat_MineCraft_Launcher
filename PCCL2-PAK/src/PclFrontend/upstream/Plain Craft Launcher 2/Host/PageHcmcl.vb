Imports Newtonsoft.Json.Linq
Imports System.Threading.Tasks
Imports System.Windows.Threading

' HCMCL 数据页：沿用上游窗口、页面动画和配色，业务数据来自宿主。
Public Class PageHcmcl
    Inherits MyPageRight

    Private ReadOnly Mode As String
    Private ReadOnly Body As New StackPanel With {.Margin = New Thickness(24)}
    Private ReadOnly Status As New TextBlock With {.TextWrapping = TextWrapping.Wrap, .Margin = New Thickness(0, 8, 0, 16)}
    Private ReadOnly Rows As New StackPanel
    Private ReadOnly InputName As New TextBox With {.MinWidth = 160, .Margin = New Thickness(0, 4, 8, 4), .Padding = New Thickness(8)}
    Private ReadOnly Timer As New DispatcherTimer With {.Interval = TimeSpan.FromSeconds(2)}
    Private Busy As Boolean

    Public Sub New(kind As String)
        Mode = kind
        Dim title = If(kind = "accounts", "HCMCL 账号", If(kind = "instances", "HCMCL 实例", "HCMCL 下载任务"))
        Body.Children.Add(New TextBlock With {.Text = title, .FontSize = 24, .Margin = New Thickness(0, 0, 0, 12)})
        Dim toolbar As New WrapPanel
        toolbar.Children.Add(MakeButton("刷新", Sub() ReloadData()))
        If Mode = "accounts" Then
            InputName.ToolTip = "离线玩家名：3–16 位英文字母、数字或下划线"
            toolbar.Children.Add(InputName)
            toolbar.Children.Add(MakeButton("添加离线账号", Sub() AddOffline()))
            toolbar.Children.Add(MakeButton("微软登录", Sub() BeginLogin()))
            toolbar.Children.Add(MakeButton("取消登录", Sub() RunAction("auth.cancel")))
        ElseIf Mode = "instances" Then
            toolbar.Children.Add(MakeButton("停止游戏", Sub() RunAction("launch.stop")))
        Else
            toolbar.Children.Add(MakeButton("取消全部下载", Sub() RunAction("downloads.cancel")))
        End If
        Body.Children.Add(toolbar)
        Body.Children.Add(Status)
        Body.Children.Add(Rows)
        Child = New ScrollViewer With {.Content = Body, .VerticalScrollBarVisibility = ScrollBarVisibility.Auto}
        AddHandler Loaded, Sub()
                               ReloadData()
                               If Mode <> "instances" Then Timer.Start()
                           End Sub
        AddHandler Unloaded, Sub() Timer.Stop()
        AddHandler Timer.Tick, Sub() ReloadData()
    End Sub

    Private Function MakeButton(text As String, action As Action) As MyButton
        '直接复用上游控件，统一边框、圆角、主题色和鼠标动画。
        Dim button As New MyButton With {.Text = text, .MinWidth = 90, .Height = 35, .Padding = New Thickness(13, 0, 13, 0), .Margin = New Thickness(0, 4, 8, 4)}
        AddHandler button.Click, Sub(sender, e) action()
        Return button
    End Function

    Private Function TextOf(value As JToken, key As String) As String
        If value Is Nothing OrElse value(key) Is Nothing Then Return ""
        Return value(key).ToString()
    End Function

    Private Async Sub ReloadData()
        If Busy Then Return
        Busy = True
        Try
            Dim result As JToken
            If Mode = "downloads" Then
                result = Await Task.Run(Function() HcmclHostBridge.Request("downloads.list"))
            Else
                result = Await Task.Run(Function() HcmclHostBridge.Request("state.get"))
            End If
            Rows.Children.Clear()
            If Mode = "accounts" Then
                RenderAccounts(result)
                Dim auth = Await Task.Run(Function() HcmclHostBridge.Request("auth.status"))
                If TextOf(auth, "state") = "error" Then Status.Text = TextOf(auth, "error")
                If TextOf(auth, "state") = "success" Then Status.Text = "微软账号已保存到 HCMCL。"
            ElseIf Mode = "instances" Then
                RenderInstances(result)
            Else
                RenderDownloads(result)
            End If
            HcmclHostBridge.NotifyVerifiedPage(Mode, Rows.Children.Count)
        Catch ex As Exception
            Status.Text = "读取失败：" & ex.Message
        Finally
            Busy = False
        End Try
    End Sub

    Private Function NewRow(title As String, detail As String) As StackPanel
        Dim panel As New StackPanel With {.Margin = New Thickness(16)}
        panel.Children.Add(New TextBlock With {.Text = title, .FontSize = 17, .TextWrapping = TextWrapping.Wrap})
        panel.Children.Add(New TextBlock With {.Text = detail, .Margin = New Thickness(0, 6, 0, 6), .TextWrapping = TextWrapping.Wrap})
        Dim border As New Border With {.Child = panel, .CornerRadius = New CornerRadius(8), .Margin = New Thickness(0, 0, 0, 12), .Background = New SolidColorBrush(Color.FromArgb(180, 255, 255, 255))}
        Rows.Children.Add(border)
        Return panel
    End Function

    Private Sub RenderAccounts(state As JToken)
        Dim list = TryCast(state("accounts"), JArray)
        If list Is Nothing OrElse list.Count = 0 Then
            Status.Text = "暂无账号，可添加离线账号或通过微软设备代码登录。"
            Return
        End If
        For Each account In list
            Dim id = TextOf(account, "id")
            Dim selected = id = TextOf(state, "selectedAccountId")
            Dim panel = NewRow(TextOf(account, "name") & If(selected, "  · 当前账号", ""), TextOf(account, "authType"))
            Dim actions As New WrapPanel
            actions.Children.Add(MakeButton("选择", Sub() RunAction("accounts.select", New JObject From {{"accountId", id}})))
            actions.Children.Add(MakeButton("删除", Sub()
                                                     If MessageBox.Show("从 HCMCL 删除此账号？", "确认删除", MessageBoxButton.YesNo) = MessageBoxResult.Yes Then
                                                         RunAction("accounts.remove", New JObject From {{"accountId", id}})
                                                     End If
                                                 End Sub))
            panel.Children.Add(actions)
        Next
    End Sub

    Private Sub RenderInstances(state As JToken)
        Dim list = TryCast(state("installed"), JArray)
        If list Is Nothing OrElse list.Count = 0 Then
            Status.Text = "当前 HCMCL 版本目录没有已安装实例：" & TextOf(state, "gameDir")
            Return
        End If
        Status.Text = "版本目录：" & TextOf(state, "gameDir")
        For Each instance In list
            Dim id = TextOf(instance, "id")
            Dim accountId = TextOf(state, "selectedAccountId")
            Dim panel = NewRow(id, TextOf(instance, "mcVersion") & "  " & TextOf(instance, "loader"))
            Dim actions As New WrapPanel
            actions.Children.Add(MakeButton("选择实例", Sub() RunAction("settings.set", New JObject From {{"patch", New JObject From {{"selectedVersionId", id}}}})))
            actions.Children.Add(MakeButton("启动", Sub() HcmclLaunchFlow.Start(id)))
            panel.Children.Add(actions)
        Next
    End Sub

    Private Sub RenderDownloads(list As JToken)
        Dim items = TryCast(list, JArray)
        If items Is Nothing OrElse items.Count = 0 Then
            Status.Text = "当前没有运行中的 HCMCL 下载任务。"
            Return
        End If
        Status.Text = "任务来自 HCMCL 下载队列，每两秒刷新。"
        For Each item In items
            Dim id = TextOf(item, "id")
            Dim panel = NewRow(TextOf(item, "title"), TextOf(item, "state"))
            If TextOf(item, "cancellable") = "True" OrElse TextOf(item, "cancellable") = "true" Then
                panel.Children.Add(MakeButton("取消", Sub() RunAction("downloads.cancel", New JObject From {{"taskId", id}})))
            End If
        Next
    End Sub

    Private Async Sub RunAction(method As String, Optional parameters As JObject = Nothing, Optional timeout As Integer = 30000)
        Status.Text = "正在处理……"
        Try
            Await Task.Run(Function() HcmclHostBridge.Request(method, parameters, timeout))
            Status.Text = "操作已完成。"
            ReloadData()
        Catch ex As Exception
            Status.Text = "操作失败：" & ex.Message
        End Try
    End Sub

    Private Sub AddOffline()
        Dim name = InputName.Text.Trim()
        RunAction("accounts.addOffline", New JObject From {{"name", name}})
    End Sub

    Private Async Sub BeginLogin()
        Status.Text = "正在向 HCMCL 申请微软登录代码……"
        Try
            Dim info = Await Task.Run(Function() HcmclHostBridge.Request("auth.begin", timeoutMs:=60000))
            Status.Text = "请打开 " & TextOf(info, "verificationUri") & "，输入代码：" & TextOf(info, "userCode") & "。登录完成后账号会自动刷新。"
        Catch ex As Exception
            Status.Text = "登录失败：" & ex.Message
        End Try
    End Sub
End Class

Imports Newtonsoft.Json.Linq

''' <summary>把 HCMCL 的服务投影到上游原始页面，不修改 XAML 与控件行为。</summary>
Public Module HcmclServiceAdapter
    Private HostState As JObject
    Private SelectedAccountId As String = ""

    Public Sub Initialize()
        Try
            InitializeCore()
        Catch ex As Exception
            File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "hcmcl-init-error.txt"), ex.ToString())
            Throw
        End Try
    End Sub

    Private Sub InitializeCore()
        Dim stage = "state.get"
        Try
            Dim stateToken = HcmclHostBridge.Request("state.get", timeoutMs:=15000)
            If stateToken Is Nothing Then Throw New InvalidOperationException("HCMCL state.get returned null result")
            HostState = TryCast(stateToken, JObject)
            If HostState Is Nothing Then Throw New InvalidOperationException("HCMCL state.get expected object, received " & stateToken.Type.ToString())
            stage = "gameDir-read"
            If HostState Is Nothing Then Throw New InvalidOperationException("HCMCL state.get returned no state")
            Dim gameDirToken As JToken = Nothing
            HostState.TryGetValue("gameDir", gameDirToken)
            stage = "gameDir-check"
            Dim gameDir = If(gameDirToken IsNot Nothing, gameDirToken.ToString(), "")
            stage = "gameDir-apply"
            If Not String.IsNullOrWhiteSpace(gameDir) Then
                '目录由上游初始化完成，宿主仅提供配置；不在此触发目录选择器的变更逻辑。
                '后续由 HCMCL 的目录选择操作显式更新。
            End If
            stage = "accounts"
            Dim accounts = TryCast(HostState("accounts"), JArray)
            If accounts Is Nothing Then Return
            Dim microsoft As New JObject
            Dim offline As New List(Of String)
            For Each account As JObject In accounts
                Dim id = If(account("id") IsNot Nothing, account("id").ToString(), "")
                Dim name = If(account("name") IsNot Nothing, account("name").ToString(), "")
                If String.IsNullOrWhiteSpace(id) OrElse String.IsNullOrWhiteSpace(name) Then Continue For
                microsoft(id) = name
                If account("offline") IsNot Nothing AndAlso account("offline").Value(Of Boolean) = True Then offline.Add(id)
            Next
            Settings.Set("LoginMsJson", microsoft.ToString(Newtonsoft.Json.Formatting.None))
            If offline.Count > 0 Then Settings.Set("LoginLegacyName", offline.Join("¨"c))
            stage = "selectedAccount"
            SelectedAccountId = If(HostState("selectedAccountId") IsNot Nothing, HostState("selectedAccountId").ToString(), "")
            Dim selected = accounts.FirstOrDefault(Function(a) If(a("id") IsNot Nothing, a("id").ToString(), "") = SelectedAccountId)
            If selected IsNot Nothing Then
                Settings.Set("CacheMsV2Name", If(selected("name") IsNot Nothing, selected("name").ToString(), ""))
                Settings.Set("CacheMsV2Uuid", If(selected("uuid") IsNot Nothing, selected("uuid").ToString(), ""))
                Settings.Set("LoginType", If(selected("offline") IsNot Nothing AndAlso selected("offline").Value(Of Boolean) = True, CInt(McLoginType.Legacy), CInt(McLoginType.Ms)))
            End If
            stage = "selectedVersion"
            Dim hostSettings = TryCast(HostState("settings"), JObject)
            Dim version = If(hostSettings IsNot Nothing AndAlso hostSettings("selectedVersionId") IsNot Nothing, hostSettings("selectedVersionId").ToString(), Nothing)
            If Not String.IsNullOrWhiteSpace(version) Then
                For Each group In McInstanceList
                    For Each instance In group.Value
                        If instance.Name = version Then
                            McInstanceSelected = instance
                            Exit For
                        End If
                    Next
                Next
            End If
        Catch ex As Exception
            Throw New InvalidOperationException("HCMCL initialization stage: " & stage, ex)
        End Try
    End Sub

    ' 请求主启动器切到 HCMCL 独有板块，并结束原生窗口回到主界面。
    Public Sub NavigateHost(method As String)
        HcmclHostBridge.Request(method, New JObject From {{"from", "pccl2"}}, 15000)
    End Sub

    Public Function InstallResource(projectId As String, versionId As String, instanceId As String, platform As String, resourceType As String) As JToken
        If String.IsNullOrWhiteSpace(instanceId) Then Throw New InvalidOperationException("请先在 HCMCL 中选择要安装到的实例")
        Dim kind As String = If(resourceType = "ResourcePack", "resourcepack", If(resourceType = "Shader", "shader", "mod"))
        Return HcmclHostBridge.Request("resources.install", New JObject From {
            {"projectId", projectId},
            {"resourceVersionId", versionId},
            {"instanceId", instanceId},
            {"type", kind}
        }, 3600000)
    End Function

    Public Function LoaderVersions(kind As String, mcVersion As String) As JToken
        Return HcmclHostBridge.Request("loaders.versions", New JObject From {{"kind", kind}, {"mcVersion", mcVersion}}, 60000)
    End Function

    Public Function Manifest() As JObject
        Dim manifestResult = CType(HcmclHostBridge.Request("versions.manifest", timeoutMs:=60000), JObject)
        Return manifestResult
    End Function

    Public Function ResourceRequest(url As String, Optional method As String = "GET", Optional content As String = Nothing) As JToken
        Dim parameters As New JObject From {{"url", url}, {"method", method}}
        If content IsNot Nothing Then parameters("content") = content
        Return HcmclHostBridge.Request("resources.metadata", parameters, 60000)
    End Function

    Public Function InstallSelected(request As McInstallRequest) As Boolean
        If request.Components.ModLoaderVersions.Count > 0 Then
            Throw New NotSupportedException("此安装配置包含 HCMCL 当前不支持的组件，请回到完整启动器安装")
        End If
        HcmclHostBridge.Request("versions.install", New JObject From {{"versionId", request.Components.MinecraftVersion}}, 3600000)
        Return True
    End Function

    Public Function LaunchSelected() As Boolean
        Dim versionId As String = If(McInstanceSelected IsNot Nothing, McInstanceSelected.Name, HostState("settings")("selectedVersionId")?.ToString())
        If String.IsNullOrWhiteSpace(versionId) Then Throw New InvalidOperationException("请先在 HCMCL 中安装并选择一个版本")
        If String.IsNullOrWhiteSpace(SelectedAccountId) Then Throw New InvalidOperationException("请先在 HCMCL 中选择账号")
        HcmclHostBridge.Request("launch", New JObject From {{"versionId", versionId}, {"accountId", SelectedAccountId}}, 300000)
        Return True
    End Function

    Public Function Launch(versionId As String, accountId As String) As JToken
        Return HcmclHostBridge.Request("launch", New JObject From {{"versionId", versionId}, {"accountId", accountId}}, 300000)
    End Function

    Public Function SelectAccount(accountId As String) As JToken
        SelectedAccountId = accountId
        Return HcmclHostBridge.Request("accounts.select", New JObject From {{"accountId", accountId}}, 10000)
    End Function

    Private Function ParseQuery(query As String) As Dictionary(Of String, String)
        Dim result As New Dictionary(Of String, String)(StringComparer.OrdinalIgnoreCase)
        For Each pair In query.TrimStart("?"c).Split("&"c)
            Dim parts = pair.Split({"="c}, 2)
            If parts.Length = 2 Then result(parts(0)) = Uri.UnescapeDataString(parts(1).Replace("+", " "))
        Next
        Return result
    End Function

    Private Function ResourceTypeFromFacet(facets As String) As String
        If facets Is Nothing Then Return "mod"
        If facets.Contains("resourcepack") Then Return "resourcepack"
        If facets.Contains("shader") Then Return "shader"
        Return "mod"
    End Function
    Private Function ResourceTypeFromClass(classId As String) As String
        Select Case classId
            Case "12" : Return "resourcepack"
            Case "6552" : Return "shader"
            Case Else : Return "mod"
        End Select
    End Function
End Module

Imports System.Collections.Concurrent
Imports System.IO
Imports System.Text
Imports System.Threading
Imports Newtonsoft.Json.Linq

''' <summary>受控的 HCMCL 原生 RPC。上游 UI 不直接调用 HTTP 服务。</summary>
Public Module HcmclHostBridge
    Private Output As TextWriter
    Private Input As TextReader
    Private ReadySent As Boolean
    Private Closing As Integer
    Private NextId As Integer
    Private ReadOnly Pending As New ConcurrentDictionary(Of String, Tuple(Of ManualResetEventSlim, JObject))
    Private ReadOnly Results As New ConcurrentDictionary(Of String, JObject)
    Public Event ProgressReceived(data As JToken)

    Public Sub Start(args As String())
        If Not args.Contains("--bridge-stdio") Then Return
        Output = New StreamWriter(Console.OpenStandardOutput(), New UTF8Encoding(False)) With {.AutoFlush = True}
        Input = New StreamReader(Console.OpenStandardInput(), Encoding.UTF8)
        AddHandler AppDomain.CurrentDomain.ProcessExit, AddressOf NotifyExit
        AddHandler AppDomain.CurrentDomain.UnhandledException, AddressOf NotifyUnhandledException
        Dim worker As New Thread(AddressOf ReadLoop) With {.IsBackground = True, .Name = "HCMCL-RPC-reader"}
        worker.Start()
    End Sub

    Private Sub ReadLoop()
        Try
            While Closing = 0
                Dim line = Input.ReadLine()
                If line Is Nothing Then Exit While
                If line.Length > 1048576 Then Continue While
                Dim response = JObject.Parse(line)
                If response("event")?.ToString() = "progress" Then
                    RaiseEvent ProgressReceived(response("data"))
                    Continue While
                End If
                Dim id = response("id")?.ToString()
                If id IsNot Nothing Then
                    Dim waiter As Tuple(Of ManualResetEventSlim, JObject) = Nothing
                    If Pending.TryGetValue(id, waiter) Then
                        Results(id) = response
                        waiter.Item1.Set()
                    End If
                End If
            End While
        Catch ex As Exception
            '输入关闭或进程结束，静默退出读取线程。
        Finally
            For Each item In Pending.Values : item.Item1.Set() : Next
        End Try
    End Sub

    Public Function Request(method As String, Optional parameters As JObject = Nothing, Optional timeoutMs As Integer = 30000) As JToken
        If Output Is Nothing Then Throw New InvalidOperationException("HCMCL bridge is not connected")
        Dim id = Interlocked.Increment(NextId).ToString()
        Dim waiter = Tuple.Create(New ManualResetEventSlim(False), New JObject)
        If Not Pending.TryAdd(id, waiter) Then Throw New InvalidOperationException("duplicate RPC id")
        Try
            Dim rpcRequest As New JObject From {{"id", id}, {"method", method}}
            If parameters IsNot Nothing Then rpcRequest("params") = parameters
            SyncLock Output
                Output.WriteLine(rpcRequest.ToString(Newtonsoft.Json.Formatting.None))
            End SyncLock
            If Not waiter.Item1.Wait(timeoutMs) Then Throw New TimeoutException($"HCMCL request timed out: {method}")
            Dim response As JObject = Nothing
            If Not Results.TryGetValue(id, response) Then Throw New InvalidOperationException($"HCMCL no result for {method}")
            If response("error") IsNot Nothing Then Throw New InvalidOperationException(response("error").ToString())
            Dim result As JToken = response.GetValue("result")
            If result Is Nothing Then Throw New InvalidOperationException($"HCMCL {method} response has no result")
            Return result
        Finally
            Dim ignored As Tuple(Of ManualResetEventSlim, JObject) = Nothing
            Pending.TryRemove(id, ignored)
            Dim completed As JObject = Nothing
            Results.TryRemove(id, completed)
            '读取线程可能正发送 Set；不在此销毁仍可能被访问的等待句柄。
        End Try
    End Function

    Public Function RequestObject(method As String, Optional parameters As JObject = Nothing, Optional timeoutMs As Integer = 30000) As JObject
        Dim result = Request(method, parameters, timeoutMs)
        Dim obj = TryCast(result, JObject)
        If obj Is Nothing Then Throw New InvalidOperationException($"HCMCL {method} did not return a JSON object: {If(result Is Nothing, "null", result.Type.ToString())}")
        Return obj
    End Function

    Public Sub NotifyVerifiedPage(mode As String, rows As Integer)
        If Output Is Nothing OrElse Environment.GetEnvironmentVariable("HCMCL_VERIFY_PAGE") <> mode Then Return
        SyncLock Output
            Output.WriteLine((New JObject From {{"event", "ui.page"}, {"page", mode}, {"rows", rows}}).ToString(Newtonsoft.Json.Formatting.None))
        End SyncLock
    End Sub

    Public Sub NotifyReady()
        If Output Is Nothing OrElse ReadySent Then Return
        ReadySent = True
        SyncLock Output
            '兼容已发布的旧宿主：它仅接受带 id 的 ui.ready RPC，不接受事件帧。
            Output.WriteLine((New JObject From {{"id", "native-ready"}, {"method", "ui.ready"}, {"params", JValue.CreateNull()}}).ToString(Newtonsoft.Json.Formatting.None))
            If Environment.GetEnvironmentVariable("HCMCL_READY_RPC_ONLY") <> "1" Then Output.WriteLine("{""event"":""ui.ready""}")
        End SyncLock
    End Sub
    Public Sub NotifyExit(sender As Object, e As EventArgs)
        If Interlocked.Exchange(Closing, 1) <> 0 Then Return
        If Output IsNot Nothing Then Write("exit")
        For Each item In Pending.Values : item.Item1.Set() : Next
    End Sub
    Public Sub NotifyUnhandledException(sender As Object, e As UnhandledExceptionEventArgs)
        If Output IsNot Nothing Then Write("error")
    End Sub
    Private Sub Write(eventName As String)
        SyncLock Output
            Output.WriteLine("{""event"":""" & eventName & """}")
        End SyncLock
    End Sub
End Module

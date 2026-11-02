using System.Collections.Concurrent;
using System.IO;
using System.Text;
using System.Text.Json;

namespace PCCL2.Native;

// stdout 仅承载协议请求；诊断信息不包含响应正文或账户凭据。
public sealed class Bridge : IDisposable
{
    private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement>> pending = new();
    private readonly SemaphoreSlim writerLock = new(1, 1);
    private readonly StreamWriter output = new(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
    private readonly StreamReader input = new(Console.OpenStandardInput(), Encoding.UTF8);
    private readonly CancellationTokenSource lifetime = new();
    private int started;
    public event Action<string, JsonElement>? Event;
    public event Action? Disconnected;
    public void Start()
    {
        if (Interlocked.Exchange(ref started, 1) == 0) _ = Task.Run(ReadLoop);
    }
    public async Task<JsonElement> Request(string method, object? parameters = null, int timeoutSeconds = 30)
    {
        if (lifetime.IsCancellationRequested) throw new IOException("连接已断开 / Connection closed");
        var id = Guid.NewGuid().ToString("N");
        var completion = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        pending[id] = completion;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        timeout.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds));
        using var registration = timeout.Token.Register(() => completion.TrySetException(new TimeoutException("请求超时或连接断开 / Request timed out or disconnected")));
        try
        {
            await writerLock.WaitAsync(timeout.Token);
            try { await output.WriteLineAsync(JsonSerializer.Serialize(new { id, method, @params = parameters })); }
            finally { writerLock.Release(); }
            return await completion.Task;
        }
        finally { pending.TryRemove(id, out _); }
    }
    private async Task ReadLoop()
    {
        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                var line = await input.ReadLineAsync(lifetime.Token);
                if (line is null) break;
                try
                {
                    using var document = JsonDocument.Parse(line);
                    var root = document.RootElement;
                    if (root.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String && pending.TryGetValue(id.GetString()!, out var response))
                    {
                        if (root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.String) response.TrySetException(new InvalidOperationException(error.GetString()));
                        else response.TrySetResult(root.TryGetProperty("result", out var result) ? result.Clone() : default);
                    }
                    else if (root.TryGetProperty("event", out var name) && name.ValueKind == JsonValueKind.String)
                        Event?.Invoke(name.GetString()!, root.TryGetProperty("data", out var data) ? data.Clone() : default);
                }
                catch (JsonException) { Console.Error.WriteLine("PCCL2: invalid bridge JSON"); }
            }
        }
        catch (Exception e) when (e is IOException or OperationCanceledException or ObjectDisposedException) { Console.Error.WriteLine("PCCL2: bridge closed"); }
        finally
        {
            lifetime.Cancel();
            foreach (var entry in pending.Values) entry.TrySetException(new IOException("连接已断开 / Connection closed"));
            Disconnected?.Invoke();
        }
    }
    public void Dispose() { lifetime.Cancel(); }
}

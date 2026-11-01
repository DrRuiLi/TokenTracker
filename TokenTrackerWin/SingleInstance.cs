using System.IO;
using System.IO.Pipes;

namespace TokenTrackerWin;

/// <summary>
/// Single-instance activation and deep-link forwarding. Subsequent manual launches
/// bring the dashboard forward; <c>tokentracker://</c> links retain their own handler.
/// </summary>
internal static class SingleInstance
{
    private const string PipeName = "TokenTracker.Windows.Tray.DeepLink";
    public const string ActivateMessage = "activate";

    /// <summary>
    /// Try to hand <paramref name="payload"/> to an already-running instance. Returns
    /// true if delivered (caller should then exit). Short timeout so a cold start where
    /// nobody is listening fails fast.
    /// </summary>
    public static bool TryForwardToPrimary(string payload)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out);
            client.Connect(1500);
            using var writer = new StreamWriter(client) { AutoFlush = true };
            writer.WriteLine(payload);
            return true;
        }
        catch { return false; }
    }

    /// <summary>
    /// Start listening (primary instance only). Handlers run on a thread-pool thread
    /// and must marshal to the UI thread themselves.
    /// </summary>
    public static void StartListener(Action onActivate, Action<string> onDeepLink, CancellationToken token)
    {
        _ = Task.Run(async () =>
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    using var server = new NamedPipeServerStream(
                        PipeName, PipeDirection.In, 1,
                        PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
                    await server.WaitForConnectionAsync(token);
                    using var reader = new StreamReader(server);
                    var line = await reader.ReadLineAsync();
                    if (line == ActivateMessage) onActivate();
                    else if (!string.IsNullOrWhiteSpace(line)) onDeepLink(line);
                }
                catch (OperationCanceledException) { break; }
                catch { /* drop this connection, keep listening */ }
            }
        }, token);
    }
}

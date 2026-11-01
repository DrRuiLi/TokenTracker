namespace TokenTrackerWin;

/// <summary>Sleep hidden renderers, retaining the document and its login state.</summary>
internal sealed class WebViewActivity : IDisposable
{
    private readonly Action<bool> _setVisible;
    private readonly Action _resume;
    private readonly Func<Task<bool>> _suspend;
    private readonly Action<string> _log;
    private bool _shouldRun;
    private Task? _suspensionTask;
    private bool _disposed;

    internal Task WhenSettled => _suspensionTask ?? Task.CompletedTask;

    public WebViewActivity(Action<bool> setVisible, Action resume,
        Func<Task<bool>> suspend, Action<string> log)
    {
        _setVisible = setVisible;
        _resume = resume;
        _suspend = suspend;
        _log = log;
    }

    public void Update(bool visible, bool keepRunning = false)
    {
        if (_disposed) return;
        _shouldRun = visible || keepRunning;
        try
        {
            _setVisible(visible);
            if (_shouldRun) _resume();
            else if (_suspensionTask is not { IsCompleted: false }) _suspensionTask = SuspendAsync();
        }
        catch (Exception ex) { _log($"webview activity update failed: {ex.Message}"); }
    }

    private async Task SuspendAsync()
    {
        try
        {
            // Allow WPF's Visibility change to reach the composition controller.
            await Task.Yield();
            if (_disposed || _shouldRun) return;
            var suspended = await _suspend();
            if (!_disposed) _log($"hidden webview suspended={suspended}");
        }
        catch (Exception ex)
        {
            if (!_disposed) _log($"webview suspend failed: {ex.Message}");
        }
        finally
        {
            // A suspend can finish after a tray click or OAuth has reopened the
            // document. Never leave that document sleeping.
            if (!_disposed && _shouldRun)
            {
                try { _resume(); }
                catch (Exception ex) { _log($"webview resume failed: {ex.Message}"); }
            }
        }
    }

    public void Dispose() => _disposed = true;
}

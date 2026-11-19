using System.Net.Http;
using System.Text.Json;

namespace TokenTrackerWin.TrccFork.MetricsBar;

internal sealed class MetricsBarPoller : IDisposable
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(2) };
    private readonly System.Windows.Forms.Timer _timer = new();
    private readonly MetricsBarFallbackSampler _fallback = new();
    private MetricsBarSettings _settings = new();
    private Dictionary<string, double?> _values = new(StringComparer.Ordinal);
    public event Action? Updated;

    public MetricsBarPoller()
    {
        _timer.Tick += (_, _) => _ = PollAsync();
    }

    public IReadOnlyDictionary<string, double?> Current => _values;

    public void ApplySettings(MetricsBarSettings settings)
    {
        _settings = settings.Clone();
        _timer.Interval = Math.Clamp(settings.RefreshMs, 500, 10_000);
        if (settings.Enabled) _timer.Start();
        else _timer.Stop();
        _ = PollAsync();
    }

    public void Dispose()
    {
        _timer.Stop();
        _timer.Dispose();
        _fallback.Dispose();
    }

    private async Task PollAsync()
    {
        var port = _settings.TrccPort;
        if (port > 0)
        {
            try
            {
                var url = $"http://127.0.0.1:{port}/api/metrics";
                var json = await Http.GetStringAsync(url).ConfigureAwait(false);
                var doc = JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty("metrics", out var metrics))
                {
                    var parsed = ParseMetrics(metrics);
                    _values = parsed;
                    Updated?.Invoke();
                    return;
                }
            }
            catch { /* fall through */ }
        }

        _values = _fallback.Sample().ToDictionary(kv => kv.Key, kv => kv.Value, StringComparer.Ordinal);
        Updated?.Invoke();
    }

    private static Dictionary<string, double?> ParseMetrics(JsonElement metrics)
    {
        var dict = new Dictionary<string, double?>(StringComparer.Ordinal);
        foreach (var key in MetricsBarSettings.AllColumns)
        {
            if (!metrics.TryGetProperty(key, out var el) || el.ValueKind == JsonValueKind.Null)
            {
                dict[key] = null;
                continue;
            }
            dict[key] = el.ValueKind switch
            {
                JsonValueKind.Number => el.GetDouble(),
                _ => null,
            };
        }
        return dict;
    }
}
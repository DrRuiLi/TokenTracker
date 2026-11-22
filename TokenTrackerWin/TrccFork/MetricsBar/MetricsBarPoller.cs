using System.Net.Http;
using System.Text.Json;

namespace TokenTrackerWin.TrccFork.MetricsBar;

internal sealed class MetricsBarPoller : IDisposable
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(2) };
    private static readonly (string Alias, string Key)[] ApiAliases =
    [
        ("temp_c", "temp"),
        ("gpu_temp_c", "gpu_temp"),
        ("power_w", "power"),
        ("disk_read_bps", "disk_read"),
        ("disk_write_bps", "disk_write"),
        ("up_bps", "up"),
        ("dl_bps", "dl"),
    ];

    private readonly System.Windows.Forms.Timer _timer = new();
    private readonly MetricsBarFallbackSampler _fallback = new();
    private MetricsBarSettings _settings = new();
    private Dictionary<string, double?> _values = new(StringComparer.Ordinal);
    private int _polling;
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
        if (Interlocked.Exchange(ref _polling, 1) == 1) return;
        try
        {
            var port = _settings.TrccPort;
            if (port > 0)
            {
                try
                {
                    var url = $"http://127.0.0.1:{port}/api/metrics";
                    var json = await Http.GetStringAsync(url).ConfigureAwait(false);
                    using var doc = JsonDocument.Parse(json);
                    if (doc.RootElement.TryGetProperty("metrics", out var metrics))
                    {
                        Publish(FillMissing(ParseMetrics(metrics), _fallback.Sample()));
                        return;
                    }
                }
                catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
                {
                    // Sidecar is down or slow. The local sampler covers CPU, memory, and rates.
                }
                catch (Exception ex)
                {
                    // A parse error must not discard a good payload on the next poll,
                    // but this response cannot be trusted. Log it instead of hiding it.
                    Diag.Log("metrics-bar", $"metrics parse failed: {ex.GetType().Name}: {ex.Message}");
                }
            }

            Publish(_fallback.Sample().ToDictionary(kv => kv.Key, kv => kv.Value, StringComparer.Ordinal));
        }
        finally
        {
            Interlocked.Exchange(ref _polling, 0);
        }
    }

    private void Publish(Dictionary<string, double?> next)
    {
        if (NearlySame(_values, next)) return;
        _values = next;
        Updated?.Invoke();
    }

    private static bool NearlySame(Dictionary<string, double?> current, Dictionary<string, double?> next)
    {
        if (current.Count != next.Count) return false;
        foreach (var kv in next)
        {
            if (!current.TryGetValue(kv.Key, out var old)) return false;
            if (old is null || kv.Value is null)
            {
                if (old is not null || kv.Value is not null) return false;
                continue;
            }
            if (Math.Abs(old.Value - kv.Value.Value) > 0.05) return false;
        }
        return true;
    }

    private static Dictionary<string, double?> ParseMetrics(JsonElement metrics)
    {
        var dict = new Dictionary<string, double?>(StringComparer.Ordinal);
        foreach (var key in MetricsBarSettings.AllColumns)
            dict[key] = ReadNumber(metrics, key);

        // trcc/sysmetrics.py publishes temp_c, power_w, gpu_temp_c, and the rate aliases.
        // A missing column key must not throw: that used to drop the whole payload,
        // so the taskbar kept the sampler that cannot see those sensors.
        foreach (var (alias, key) in ApiAliases)
        {
            if (dict.TryGetValue(key, out var existing) && existing is not null) continue;
            var value = ReadNumber(metrics, alias);
            if (value is not null) dict[key] = value;
        }
        return dict;
    }

    private static Dictionary<string, double?> FillMissing(
        Dictionary<string, double?> values, Dictionary<string, double?> fallback)
    {
        foreach (var (key, value) in fallback)
            if ((!values.TryGetValue(key, out var current) || current is null) && value is not null)
                values[key] = value;
        return values;
    }

    private static double? ReadNumber(JsonElement metrics, string key)
    {
        if (!metrics.TryGetProperty(key, out var el) || el.ValueKind != JsonValueKind.Number)
            return null;
        return el.TryGetDouble(out var n) ? n : null;
    }
}

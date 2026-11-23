using System.IO;
using System.Text.Json;

namespace TokenTrackerWin.TrccFork.MetricsBar;

internal sealed class MetricsBarSettings
{
    internal static JsonSerializerOptions JsonOptions { get; } = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
    };

    public const int DefaultTrccPort = 17691;

    private static readonly string FilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "TokenTracker", "metrics-bar.json");

    public static readonly string[] AllColumns =
        ["cpu", "gpu", "temp", "gpu_temp", "vram", "power", "mem", "disk_read", "disk_write", "up", "dl"];

    // Left-to-right order. Hidden items are skipped, then the rest stack two per column.
    public static readonly string[] DefaultColumnOrder =
        ["cpu", "temp", "power", "gpu", "gpu_temp", "vram", "mem", "disk_read", "disk_write", "up", "dl"];

    public bool Enabled { get; set; }
    public int RefreshMs { get; set; } = 1000;
    public double Opacity { get; set; } = 0.92;
    public int TrccPort { get; set; } = DefaultTrccPort;
    public string[] Columns { get; set; } = ["cpu", "temp", "power", "gpu", "gpu_temp", "vram", "mem", "disk_read", "disk_write", "up", "dl"];
    public string[] ColumnOrder { get; set; } = ["cpu", "temp", "power", "gpu", "gpu_temp", "vram", "mem", "disk_read", "disk_write", "up", "dl"];
    public string Background { get; set; } = "#1e2024";
    public string Text { get; set; } = "#e8eaed";
    public string TextDim { get; set; } = "#9aa0a8";

    public static MetricsBarSettings Load()
    {
        try
        {
            if (!File.Exists(FilePath)) return new MetricsBarSettings();
            var settings = JsonSerializer.Deserialize<MetricsBarSettings>(File.ReadAllText(FilePath), JsonOptions) ?? new();
            settings.Normalize();
            return settings;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return new MetricsBarSettings();
        }
    }

    public void Save()
    {
        Normalize();
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            File.WriteAllText(FilePath + ".tmp", JsonSerializer.Serialize(this, JsonOptions));
            File.Move(FilePath + ".tmp", FilePath, true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Diag.Log("metrics-bar", $"settings save failed: {ex.Message}");
        }
    }

    public static string SettingsPath => FilePath;

    public void Normalize()
    {
        RefreshMs = Math.Clamp(RefreshMs, 500, 10_000);
        Opacity = Math.Clamp(Opacity, 0.4, 1.0);
        TrccPort = Math.Clamp(TrccPort, 0, 65535);
        var oldColumns = Columns ?? [];
        // The set that shipped before power had its own column. Keep a custom
        // selection, and put power back only when the saved list is still a default.
        string[][] defaults =
        [
            ["cpu", "mem", "temp", "power", "up", "dl"],
            ["cpu", "gpu", "temp", "gpu_temp", "vram", "mem", "disk_read", "disk_write", "up", "dl"],
        ];
        if (defaults.Any(expected => SameColumns(oldColumns, expected)))
            oldColumns = ["cpu", "gpu", "temp", "gpu_temp", "vram", "power", "mem", "disk_read", "disk_write", "up", "dl"];
        Columns = oldColumns
            .Where(c => AllColumns.Contains(c, StringComparer.Ordinal))
            .Distinct()
            .ToArray();
        if (Columns.Length == 0) Columns = ["cpu", "temp"];

        var seen = new HashSet<string>(StringComparer.Ordinal);
        var order = new List<string>();
        foreach (var key in ColumnOrder ?? [])
        {
            if (!AllColumns.Contains(key, StringComparer.Ordinal) || !seen.Add(key)) continue;
            order.Add(key);
        }
        foreach (var key in DefaultColumnOrder)
        {
            if (seen.Add(key)) order.Add(key);
        }
        ColumnOrder = order.ToArray();
    }

    private static bool SameColumns(IReadOnlyList<string> columns, IReadOnlyList<string> expected)
    {
        if (columns.Count != expected.Count) return false;
        var set = new HashSet<string>(expected, StringComparer.Ordinal);
        foreach (var column in columns)
            if (!set.Contains(column)) return false;
        return true;
    }

    public MetricsBarSettings Clone() =>
        JsonSerializer.Deserialize<MetricsBarSettings>(JsonSerializer.Serialize(this), JsonOptions) ?? new();
}

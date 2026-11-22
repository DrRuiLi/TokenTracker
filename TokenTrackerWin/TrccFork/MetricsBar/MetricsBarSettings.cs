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
        ["cpu", "gpu", "temp", "gpu_temp", "vram", "mem", "disk_read", "disk_write", "up", "dl"];

    public bool Enabled { get; set; }
    public int RefreshMs { get; set; } = 1000;
    public double Opacity { get; set; } = 0.92;
    public int TrccPort { get; set; } = DefaultTrccPort;
    public string[] Columns { get; set; } = ["cpu", "gpu", "temp", "gpu_temp", "vram", "mem", "disk_read", "disk_write", "up", "dl"];
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
        var legacyDefaults = new HashSet<string>(["cpu", "mem", "temp", "power", "up", "dl"], StringComparer.Ordinal);
        if (oldColumns.Length == legacyDefaults.Count && oldColumns.All(legacyDefaults.Contains))
            oldColumns = ["cpu", "gpu", "temp", "gpu_temp", "vram", "mem", "disk_read", "disk_write", "up", "dl"];
        Columns = oldColumns
            .Where(c => AllColumns.Contains(c, StringComparer.Ordinal))
            .Distinct()
            .ToArray();
        if (Columns.Length == 0) Columns = ["cpu", "temp"];
    }

    public MetricsBarSettings Clone() =>
        JsonSerializer.Deserialize<MetricsBarSettings>(JsonSerializer.Serialize(this), JsonOptions) ?? new();
}

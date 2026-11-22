using System.Drawing;
using System.Globalization;

namespace TokenTrackerWin.TrccFork.MetricsBar;

/// <summary>
/// Two-row taskbar columns. Width comes from a stable sample string, so a
/// value change never resizes the window.
/// </summary>
internal sealed class MetricsTaskbarLayout
{
    private static readonly (string Top, string Bottom)[] DefaultPairs =
    [
        ("cpu", "temp"),
        ("gpu", "gpu_temp"),
        ("vram", "mem"),
        ("disk_read", "disk_write"),
        ("up", "dl"),
    ];

    internal sealed class Cell
    {
        public string Key = "";
        public string Label = "";
        public string Value = "";
        public int ColorState;
        public Rectangle Bounds;
    }

    internal sealed class Column
    {
        public Cell? Top;
        public Cell? Bottom;
        public int Width;
    }

    public IReadOnlyList<Column> Columns { get; private init; } = [];
    public int PanelWidth { get; private init; }
    public int ClientHeight { get; private init; }
    public int LineHeight { get; private init; }
    public float FontPt { get; private init; }

    public static string StructureKey(MetricsBarSettings settings, int clientHeight, int dpi, bool english, int maxPanelWidth) =>
        string.Concat(string.Join(",", settings.Columns), "|", clientHeight.ToString(CultureInfo.InvariantCulture),
            "|", dpi.ToString(CultureInfo.InvariantCulture), "|", english ? "1" : "0",
            "|", maxPanelWidth.ToString(CultureInfo.InvariantCulture));

    public static MetricsTaskbarLayout Build(
        MetricsBarSettings settings,
        IReadOnlyDictionary<string, double?> values,
        bool english,
        int clientHeight,
        Graphics measure,
        int maxPanelWidth = 0)
    {
        var visible = new HashSet<string>(settings.Columns, StringComparer.Ordinal);
        var cols = new List<Column>();

        foreach (var (topKey, bottomKey) in DefaultPairs)
        {
            var showTop = visible.Contains(topKey);
            var showBottom = visible.Contains(bottomKey);
            if (!showTop && !showBottom) continue;
            cols.Add(new Column
            {
                Top = showTop ? MakeCell(topKey, values, english) : null,
                Bottom = showBottom ? MakeCell(bottomKey, values, english) : null,
            });
        }

        if (cols.Count == 0)
        {
            foreach (var key in settings.Columns)
                cols.Add(new Column { Top = MakeCell(key, values, english) });
        }

        var height = Math.Max(16, clientHeight);
        var twoLine = cols.Exists(c => c.Top != null && c.Bottom != null);
        var lineHeight = twoLine ? Math.Max(8, height / 2) : height;
        var fontPt = MetricsTaskbarPalette.FitPointSize(measure, lineHeight);

        const int pad = 4;
        var gap = 8;
        var inner = 6;
        var total = MeasureColumns(measure, cols, fontPt, gap, inner, pad);
        var limit = maxPanelWidth > pad * 2 ? maxPanelWidth : 0;
        while (limit > 0 && total > limit && (fontPt > 7f || gap > 4 || inner > 2))
        {
            if (fontPt > 7f) fontPt = (float)Math.Round((fontPt - 0.5f) * 2) / 2f;
            else if (gap > 4) gap -= 2;
            else inner -= 2;
            total = MeasureColumns(measure, cols, fontPt, gap, inner, pad);
        }

        var topH = twoLine ? height / 2 : height;
        var x = pad;
        foreach (var col in cols)
        {
            if (col.Top != null && col.Bottom != null)
            {
                col.Top.Bounds = new Rectangle(x, 0, col.Width, topH);
                col.Bottom.Bounds = new Rectangle(x, topH, col.Width, height - topH);
            }
            else if (col.Top != null)
            {
                col.Top.Bounds = new Rectangle(x, 0, col.Width, twoLine ? topH : height);
            }
            else if (col.Bottom != null)
            {
                col.Bottom.Bounds = new Rectangle(x, twoLine ? topH : 0, col.Width, twoLine ? height - topH : height);
            }
            x += col.Width + gap;
        }

        var layout = new MetricsTaskbarLayout
        {
            Columns = cols,
            PanelWidth = Math.Max(pad * 2 + 8, total),
            ClientHeight = height,
            LineHeight = lineHeight,
            FontPt = fontPt,
        };
        layout.ApplyValues(values);
        return layout;
    }

    public bool ApplyValues(IReadOnlyDictionary<string, double?> values)
    {
        var changed = false;
        foreach (var col in Columns)
        {
            changed |= ApplyCell(col.Top, values);
            changed |= ApplyCell(col.Bottom, values);
        }
        return changed;
    }

    private static bool ApplyCell(Cell? cell, IReadOnlyDictionary<string, double?> values)
    {
        if (cell is null) return false;
        values.TryGetValue(cell.Key, out var v);
        var text = FormatTaskbarValue(cell.Key, v);
        var state = ColorStateFor(cell.Key, v);
        if (text == cell.Value && state == cell.ColorState) return false;
        cell.Value = text;
        cell.ColorState = state;
        return true;
    }

    private static int MeasureColumns(Graphics g, List<Column> cols, float fontPt, int gap, int inner, int pad)
    {
        using var font = MetricsTaskbarPalette.CreateFont(fontPt);
        var total = pad * 2;
        foreach (var col in cols)
        {
            var wTop = MeasureCell(g, col.Top, font, inner);
            var wBottom = MeasureCell(g, col.Bottom, font, inner);
            col.Width = Math.Max(wTop, wBottom);
            total += col.Width;
        }
        if (cols.Count > 1) total += (cols.Count - 1) * gap;
        return total;
    }

    private static int MeasureCell(Graphics g, Cell? cell, Font font, int inner)
    {
        if (cell is null) return 0;
        var flags = TextFormatFlags.NoPadding | TextFormatFlags.SingleLine;
        var wLabel = TextRenderer.MeasureText(g, cell.Label, font, Size.Empty, flags).Width;
        var wValue = TextRenderer.MeasureText(g, SampleValue(cell.Key), font, Size.Empty, flags).Width;
        // Same digit count as the live formatter, plus a couple of pixels for bold glyphs.
        return wLabel + wValue + inner + 2;
    }

    private static Cell MakeCell(string key, IReadOnlyDictionary<string, double?> values, bool english)
    {
        values.TryGetValue(key, out var v);
        return new Cell
        {
            Key = key,
            Label = ShortLabel(key, english),
            Value = FormatTaskbarValue(key, v),
            ColorState = ColorStateFor(key, v),
        };
    }

    private static string ShortLabel(string key, bool english) => key switch
    {
        "cpu" => "CPU",
        "temp" => "CPU",
        "gpu" => "GPU",
        "gpu_temp" => "GPU",
        "vram" => english ? "VRAM" : "显存",
        "power" => "PWR",
        "mem" => english ? "MEM" : "内存",
        "disk_read" => english ? "READ" : "读",
        "disk_write" => english ? "WRITE" : "写",
        "up" => "↑",
        "dl" => "↓",
        _ => key.ToUpperInvariant(),
    };

    /// <summary>Widest text the live formatter can produce for this key.</summary>
    private static string SampleValue(string key) => key switch
    {
        "cpu" or "gpu" or "vram" or "mem" => "99.9%",
        "temp" or "gpu_temp" => "99.9°",
        "power" => "999.9W",
        "disk_read" or "disk_write" or "up" or "dl" => "99.9MB",
        _ => "999.9",
    };

    internal static string FormatTaskbarValue(string key, double? value)
    {
        if (value is not { } v || double.IsNaN(v)) return "—";
        return key switch
        {
            "cpu" or "gpu" or "vram" or "mem" => $"{v:0.#}%",
            "temp" => $"{v:0.#}°",
            "gpu_temp" => $"{v:0.#}°",
            "power" => $"{v:0.#}W",
            "disk_read" or "disk_write" => FormatNetCompact(v),
            "up" or "dl" => FormatNetCompact(v),
            _ => $"{v:0.#}",
        };
    }

    private static string FormatNetCompact(double bps)
    {
        if (bps >= 1024 * 1024) return $"{bps / (1024 * 1024):0.#}MB";
        if (bps >= 1024) return $"{bps / 1024:0.#}KB";
        return $"{bps:0}B";
    }

    private static int ColorStateFor(string key, double? value)
    {
        if (value is not { } v) return 0;
        return key switch
        {
            "cpu" or "gpu" or "vram" or "mem" when v >= 85 => 2,
            "cpu" or "gpu" or "vram" or "mem" when v >= 60 => 1,
            "temp" or "gpu_temp" when v >= 85 => 2,
            "temp" or "gpu_temp" when v >= 70 => 1,
            _ => 0,
        };
    }
}

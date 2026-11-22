using System.Drawing;
using System.Globalization;

namespace TokenTrackerWin.TrccFork.MetricsBar;

internal readonly record struct MetricsColumn(string Key, string Label, string Value, Color? ValueColor);

internal static class MetricsBarRenderer
{
    public static void RenderTaskbar(Graphics g, Rectangle bounds, Color chromaKey,
        MetricsTaskbarLayout layout, bool lightTaskbar)
    {
        g.Clear(chromaKey);
        if (layout.Columns.Count == 0 || bounds.Width <= 0 || bounds.Height <= 0) return;

        MetricsTaskbarPalette.ConfigureGraphics(g);
        var font = MetricsTaskbarPalette.CachedFont(layout.FontPt <= 0 ? 9f : layout.FontPt);
        var labelColor = MetricsTaskbarPalette.LabelColor(lightTaskbar);

        foreach (var col in layout.Columns)
        {
            DrawCell(g, col.Top, font, labelColor, lightTaskbar);
            DrawCell(g, col.Bottom, font, labelColor, lightTaskbar);
        }
    }

    private static void DrawCell(Graphics g, MetricsTaskbarLayout.Cell? cell, Font font,
        Color labelColor, bool light)
    {
        if (cell is null || cell.Bounds == Rectangle.Empty) return;
        var rc = cell.Bounds;
        var valueColor = cell.Value == "—"
            ? labelColor
            : MetricsTaskbarPalette.ValueColor(cell.ColorState, light);

        // Label and value get separate rectangles. One shared rect with NoClipping
        // paints a long value through the label and into the next column.
        var measureFlags = TextFormatFlags.NoPadding | TextFormatFlags.SingleLine;
        var labelWidth = TextRenderer.MeasureText(g, cell.Label, font, Size.Empty, measureFlags).Width;
        const int gap = 4;
        var labelRect = new Rectangle(rc.Left, rc.Top, Math.Min(labelWidth, Math.Max(0, rc.Width - gap)), rc.Height);
        var valueLeft = Math.Min(rc.Right, labelRect.Right + gap);
        var valueRect = new Rectangle(valueLeft, rc.Top, Math.Max(0, rc.Right - valueLeft), rc.Height);
        var flags = TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding
            | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis;
        if (labelRect.Width > 0)
            TextRenderer.DrawText(g, cell.Label, font, labelRect, labelColor, flags | TextFormatFlags.Left);
        if (valueRect.Width > 0)
            TextRenderer.DrawText(g, cell.Value, font, valueRect, valueColor, flags | TextFormatFlags.Right);
    }

    public static void Render(Graphics g, Rectangle bounds, MetricsBarSettings theme,
        IReadOnlyList<MetricsColumn> cols, bool lightTaskbar)
    {
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        using var bg = new SolidBrush(ParseColor(theme.Background, lightTaskbar ? "#f2f3f5" : "#1e2024"));
        using var border = new Pen(ParseColor(theme.TextDim, "#555860"), 1f);
        g.FillRectangle(bg, bounds);
        g.DrawLine(border, bounds.Left, bounds.Top, bounds.Right, bounds.Top);

        if (cols.Count == 0) return;

        var labelColor = ParseColor(theme.Text, lightTaskbar ? "#1a1d24" : "#e8eaed");
        var dimColor = ParseColor(theme.TextDim, "#9aa0a8");
        using var labelFont = new Font("Segoe UI", 9f, FontStyle.Regular, GraphicsUnit.Point);
        using var valueFont = new Font("Segoe UI Semibold", 9f, FontStyle.Bold, GraphicsUnit.Point);

        int x = bounds.Left + 12;
        int colWidth = Math.Max(80, (bounds.Width - 24) / cols.Count);
        foreach (var col in cols)
        {
            var rc = new Rectangle(x, bounds.Top, colWidth - 8, bounds.Height);
            TextRenderer.DrawText(g, col.Label, labelFont, rc, dimColor,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
            var valueColor = col.ValueColor ?? labelColor;
            TextRenderer.DrawText(g, col.Value, valueFont, rc, valueColor,
                TextFormatFlags.Right | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
            x += colWidth;
        }
    }

    internal static IReadOnlyList<MetricsColumn> BuildColumns(
        MetricsBarSettings settings, IReadOnlyDictionary<string, double?> values, bool english)
    {
        var list = new List<MetricsColumn>();
        foreach (var key in settings.Columns)
        {
            if (!values.TryGetValue(key, out var v)) v = null;
            list.Add(new MetricsColumn(
                key,
                LabelFor(key, english),
                FormatValue(key, v),
                ColorFor(key, v)));
        }
        return list;
    }

    private static string LabelFor(string key, bool english) => key switch
    {
        "cpu" => "CPU",
        "mem" => english ? "MEM" : "内存",
        "temp" => english ? "TEMP" : "温度",
        "power" => english ? "PWR" : "功耗",
        "up" => english ? "UP" : "上行",
        "dl" => english ? "DN" : "下行",
        _ => key.ToUpperInvariant(),
    };

    private static string FormatValue(string key, double? value)
    {
        if (value is not { } v) return "—";
        return key switch
        {
            "cpu" or "mem" => $"{v:0.#}%",
            "temp" => $"{v:0.#}°",
            "power" => $"{v:0.#}W",
            "up" or "dl" => FormatBps(v),
            _ => v.ToString("0.#", CultureInfo.InvariantCulture),
        };
    }

    private static Color? ColorFor(string key, double? value)
    {
        if (value is not { } v) return null;
        return key switch
        {
            "temp" when v >= 85 => Color.FromArgb(220, 80, 70),
            "temp" when v >= 70 => Color.FromArgb(230, 170, 60),
            "cpu" when v >= 90 => Color.FromArgb(220, 80, 70),
            _ => null,
        };
    }

    private static string FormatBps(double bps)
    {
        if (bps >= 1024 * 1024) return $"{bps / (1024 * 1024):0.#} MB/s";
        if (bps >= 1024) return $"{bps / 1024:0.#} KB/s";
        return $"{bps:0} B/s";
    }

    private static Color ParseColor(string hex, string fallback)
    {
        try
        {
            var h = string.IsNullOrWhiteSpace(hex) ? fallback : hex.Trim();
            if (!h.StartsWith('#')) h = "#" + h;
            return ColorTranslator.FromHtml(h);
        }
        catch
        {
            return ColorTranslator.FromHtml(fallback);
        }
    }
}

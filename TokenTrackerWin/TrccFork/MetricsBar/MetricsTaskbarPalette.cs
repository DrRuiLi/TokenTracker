using System.Drawing;
using System.Drawing.Text;

namespace TokenTrackerWin.TrccFork.MetricsBar;

/// <summary>LiteMonitor taskbar colors (MIT, Diorser/LiteMonitor TaskbarRenderer).</summary>
internal static class MetricsTaskbarPalette
{
    private static readonly Color LabelLight = Color.FromArgb(20, 20, 20);
    private static readonly Color SafeLight = Color.FromArgb(0x00, 0x80, 0x40);
    private static readonly Color WarnLight = Color.FromArgb(0xB5, 0x75, 0x00);
    private static readonly Color CritLight = Color.FromArgb(0xC0, 0x30, 0x30);

    private static readonly Color LabelDark = Color.White;
    private static readonly Color SafeDark = Color.FromArgb(0x66, 0xFF, 0x99);
    private static readonly Color WarnDark = Color.FromArgb(0xFF, 0xD6, 0x66);
    private static readonly Color CritDark = Color.FromArgb(0xFF, 0x66, 0x66);

    private static Font? _cached;
    private static float _cachedPt = -1;

    public static Font CreateFont(float pt) =>
        new("Microsoft YaHei UI", pt, FontStyle.Bold, GraphicsUnit.Point);

    /// <summary>Shared font for paint. Callers must not dispose it.</summary>
    public static Font CachedFont(float pt)
    {
        var rounded = (float)Math.Round(pt * 2) / 2f;
        if (_cached is null || Math.Abs(_cachedPt - rounded) > 0.01f)
        {
            _cached?.Dispose();
            _cachedPt = rounded;
            _cached = CreateFont(rounded);
        }
        return _cached;
    }

    public static float FitPointSize(Graphics g, int lineHeight)
    {
        const float preferred = 9f;
        using var probe = CreateFont(preferred);
        var textH = TextRenderer.MeasureText(g, "Ag显存", probe, Size.Empty,
            TextFormatFlags.NoPadding | TextFormatFlags.SingleLine).Height;
        var limit = Math.Max(8, lineHeight - 1);
        if (textH <= limit || textH <= 0) return preferred;
        var fitted = preferred * limit / textH;
        fitted = (float)Math.Round(fitted * 2) / 2f;
        return Math.Clamp(fitted, 7f, preferred);
    }

    public static void ConfigureGraphics(Graphics g)
    {
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.HighQuality;
        g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
        g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
    }

    public static Color LabelColor(bool light) => light ? LabelLight : LabelDark;

    public static Color ValueColor(int state, bool light)
    {
        if (state >= 2) return light ? CritLight : CritDark;
        if (state == 1) return light ? WarnLight : WarnDark;
        return light ? SafeLight : SafeDark;
    }
}

using System.Drawing;
using System.Runtime.InteropServices;

namespace TokenTrackerWin.TrccFork.MetricsBar;

internal sealed class MetricsBarForm : Form
{
    private const int BarHeight = 36;
    private MetricsBarSettings _theme = new();
    private IReadOnlyList<MetricsColumn> _columns = [];
    private bool _english;

    public MetricsBarForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        BackColor = Color.Black;
        Height = ScaleHeight(BarHeight);
    }

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= 0x80; // WS_EX_TOOLWINDOW
            cp.ExStyle &= ~0x00040000; // WS_EX_APPWINDOW
            cp.ExStyle |= 0x00000008; // WS_EX_TOPMOST
            return cp;
        }
    }

    protected override void OnPaintBackground(PaintEventArgs e) { }

    protected override void OnPaint(PaintEventArgs e)
    {
        var light = SystemUsesLightTaskbar();
        MetricsBarRenderer.Render(e.Graphics, ClientRectangle, _theme, _columns, light);
    }

    public void UpdateView(MetricsBarSettings theme, IReadOnlyList<MetricsColumn> columns, bool english)
    {
        _theme = theme;
        _columns = columns;
        _english = english;
        Opacity = theme.Opacity;
        int h = ScaleHeight(BarHeight);
        int w = Math.Max(320, columns.Count * 108 + 24);
        Bounds = TaskbarDock.BoundsForBar(w, h);
        Invalidate();
    }

    private int ScaleHeight(int px) =>
        (int)Math.Round(px * DeviceDpi / 96.0);

    private static bool SystemUsesLightTaskbar()
    {
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return (key?.GetValue("SystemUsesLightTheme") as int?) == 1;
        }
        catch { return false; }
    }
}
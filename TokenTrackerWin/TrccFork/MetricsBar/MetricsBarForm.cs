using System.Drawing;

namespace TokenTrackerWin.TrccFork.MetricsBar;

internal sealed class MetricsBarForm : Form
{
    private const int WmEraseBkgnd = 0x0014;

    private readonly TaskbarEmbedder _embedder;
    private MetricsTaskbarLayout _layout = new();
    private bool _english;
    private string _structureKey = "";
    private int _logicalWidth = 160;
    private int _logicalHeight = 48;

    public MetricsBarForm(TaskbarEmbedder embedder)
    {
        _embedder = embedder;
        AutoScaleMode = AutoScaleMode.None;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        TopMost = false;
        ControlBox = false;
        SetStyle(
            ControlStyles.UserPaint
            | ControlStyles.AllPaintingInWmPaint
            | ControlStyles.OptimizedDoubleBuffer
            | ControlStyles.Opaque,
            true);
        UpdateStyles();
        BackColor = _embedder.ChromaKey;
    }

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= TaskbarNative.WsExToolwindow;
            cp.ExStyle |= TaskbarNative.WsExNoactivate;
            cp.ExStyle |= TaskbarNative.WsExLayered;
            cp.ExStyle &= ~0x00040000; // WS_EX_APPWINDOW
            return cp;
        }
    }

    public int PanelWidth => _logicalWidth;

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        _embedder.RefreshHandles();
        _embedder.ApplyLayeredStyle(this);
        _embedder.Attach(this);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WmEraseBkgnd)
        {
            m.Result = 1;
            return;
        }
        base.WndProc(ref m);
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        MetricsBarRenderer.RenderTaskbar(e.Graphics, ClientRectangle, _embedder.ChromaKey,
            _layout, _embedder.IsLightTheme);
    }

    public void UpdateView(MetricsBarSettings theme, IReadOnlyDictionary<string, double?> values, bool english)
    {
        _english = english;
        _embedder.ApplyLayeredStyle(this);
        var paint = false;
        for (var attempt = 0; attempt < 3; attempt++)
        {
            var height = PaintHeight();
            var maxWidth = _embedder.AvailableClientWidth();
            var key = MetricsTaskbarLayout.StructureKey(theme, height, DeviceDpi, _english, maxWidth)
                + "|" + MetricsTaskbarLayout.ContentSignature(theme, values);
            var relayout = key != _structureKey || _layout.Columns.Count == 0;
            if (relayout)
            {
                using var g = CreateMeasureGraphics();
                _layout = MetricsTaskbarLayout.Build(theme, values, _english, height, g, maxWidth);
                _structureKey = key;
                _logicalWidth = _layout.PanelWidth;
                _logicalHeight = height;
            }

            var textChanged = _layout.ApplyValues(values);
            var geometryChanged = false;
            if (relayout && IsHandleCreated)
                geometryChanged = _embedder.Place(this, _logicalWidth, _logicalHeight);

            var actual = PaintHeight();
            if (relayout && Math.Abs(actual - height) > 3 && attempt < 2)
                continue;

            paint = relayout || textChanged || geometryChanged;
            break;
        }

        if (paint) Invalidate();
    }

    /// <summary>Re-hang after Explorer restarts or the taskbar band moves. Does not repaint values.</summary>
    public bool MaintainEmbed()
    {
        if (!IsHandleCreated) return false;
        var heightBefore = _embedder.TaskbarHeight;
        var lightBefore = _embedder.IsLightTheme;
        _embedder.RefreshHandles();
        var themeChanged = _embedder.ApplyLayeredStyle(this);
        var bandChanged = heightBefore != _embedder.TaskbarHeight;
        if (bandChanged) _structureKey = "";
        var placed = _logicalWidth > 0 && _embedder.Place(this, _logicalWidth, PaintHeight());
        if (themeChanged || lightBefore != _embedder.IsLightTheme) Invalidate();
        return bandChanged || placed;
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        _embedder.Detach(this);
        base.OnFormClosed(e);
    }

    private int PaintHeight()
    {
        if (_embedder.HasPlaced && IsHandleCreated && ClientSize.Height >= 16)
            return ClientSize.Height;
        return Math.Max(24, _embedder.TaskbarHeight);
    }

    private Graphics CreateMeasureGraphics() =>
        IsHandleCreated ? CreateGraphics() : Graphics.FromHwnd(nint.Zero);
}

using System.Drawing;
using Microsoft.Win32;

namespace TokenTrackerWin.TrccFork.MetricsBar;

/// <summary>Embeds the metrics form inside explorer's taskbar band (Win11 SetParent pattern).</summary>
internal sealed class TaskbarEmbedder
{
    private static readonly bool IsWin11 =
        Environment.OSVersion.Version >= new Version(10, 0, 22000);

    private nint _hTaskbar;
    private nint _hTray;
    private Rectangle _taskbarRect;
    private int _taskbarHeight = 48;
    private Color _chromaKey = Color.FromArgb(40, 40, 41);
    private bool _light;
    private bool _layerReady;
    private uint _appliedKey;
    private bool _hasPlaced;
    private int _lastX = int.MinValue;
    private int _lastY;
    private int _lastPhysW;
    private int _lastPhysH;
    private int _basisClientW;
    private int _basisClientH;
    private int _basisPhysW;
    private int _basisPhysH;
    private nint _basisParent;

    public Color ChromaKey => _chromaKey;
    public int TaskbarHeight => _taskbarHeight;
    public bool HasPlaced => _hasPlaced;
    public Rectangle TaskbarRectangle => _taskbarRect;

    public void RefreshHandles()
    {
        _hTaskbar = TaskbarNative.FindWindow("Shell_TrayWnd", null);
        _hTray = _hTaskbar != 0
            ? TaskbarNative.FindWindowEx(_hTaskbar, 0, "TrayNotifyWnd", null)
            : 0;
        UpdateTaskbarRect();
        UpdateTheme();
    }

    public void UpdateTaskbarRect()
    {
        if (_hTaskbar == 0 || !TaskbarNative.GetWindowRect(_hTaskbar, out var r))
        {
            _taskbarRect = Screen.PrimaryScreen?.Bounds ?? Rectangle.Empty;
            _taskbarHeight = 48;
            return;
        }

        var phys = Rectangle.FromLTRB(r.left, r.top, r.right, r.bottom);
        var screen = Screen.FromHandle(_hTaskbar);
        var work = screen.WorkingArea;
        var full = screen.Bounds;
        var reservedBottom = full.Bottom - work.Bottom;

        if (reservedBottom > 2)
            _taskbarRect = new Rectangle(phys.Left, work.Bottom, phys.Width, reservedBottom);
        else if (IsWin11 && phys.Width >= phys.Height)
        {
            var dpi = GetTaskbarDpi();
            var standard = (int)Math.Round(48.0 * dpi / 96.0);
            if (phys.Height > standard * 0.8)
                _taskbarRect = new Rectangle(phys.Left, phys.Bottom - standard, phys.Width, standard);
            else
                _taskbarRect = phys;
        }
        else
            _taskbarRect = phys;

        _taskbarHeight = Math.Max(24, _taskbarRect.Height);
    }

    public void UpdateTheme()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            // Taskbar paint follows the system theme. AppsUseLightTheme is often
            // light while the taskbar stays dark, and mixing them paints the wrong key.
            _light = key?.GetValue("SystemUsesLightTheme") is int system && system == 1;
        }
        catch
        {
            _light = false;
        }

        _chromaKey = _light ? Color.FromArgb(210, 210, 211) : Color.FromArgb(40, 40, 41);
    }

    /// <returns>true when the color key changed and the window must repaint.</returns>
    public bool ApplyLayeredStyle(MetricsBarForm form)
    {
        var changed = form.BackColor.ToArgb() != _chromaKey.ToArgb();
        if (changed)
            form.BackColor = _chromaKey;
        if (!form.IsHandleCreated) return changed;

        var key = (uint)(_chromaKey.R | (_chromaKey.G << 8) | (_chromaKey.B << 16));
        if (_layerReady && _appliedKey == key) return changed;

        TaskbarNative.SetLayeredWindowAttributes(form.Handle, key, 0, TaskbarNative.LwaColorkey);
        _appliedKey = key;
        _layerReady = true;
        return true;
    }

    public bool Attach(MetricsBarForm form)
    {
        if (_hTaskbar == 0) RefreshHandles();
        if (_hTaskbar == 0 || !form.IsHandleCreated) return false;
        if (TaskbarNative.GetParent(form.Handle) == _hTaskbar) return true;

        TaskbarNative.SetParent(form.Handle, _hTaskbar);
        ApplyChildStyle(form.Handle);
        var parent = TaskbarNative.GetParent(form.Handle);
        var ok = parent == _hTaskbar;
        if (!ok)
            Diag.Log("metrics-bar", $"SetParent failed parent={parent} taskbar={_hTaskbar}");
        else
            ResetPlacementBasis();
        return ok;
    }

    private static void ApplyChildStyle(nint hwnd)
    {
        var style = TaskbarNative.GetWindowLong(hwnd, TaskbarNative.GwlStyle);
        style &= unchecked((int)~0x80000000);
        style &= ~(TaskbarNative.WsCaption | TaskbarNative.WsThickFrame | TaskbarNative.WsSysmenu
                   | TaskbarNative.WsMinimizebox | TaskbarNative.WsMaximizebox | TaskbarNative.WsBorder);
        style |= TaskbarNative.WsChild | TaskbarNative.WsVisible | TaskbarNative.WsClipSiblings;
        TaskbarNative.SetWindowLong(hwnd, TaskbarNative.GwlStyle, style);

        var ex = TaskbarNative.GetWindowLong(hwnd, TaskbarNative.GwlExstyle);
        ex |= TaskbarNative.WsExLayered | TaskbarNative.WsExToolwindow | TaskbarNative.WsExNoactivate;
        ex &= ~0x00040000; // WS_EX_APPWINDOW
        TaskbarNative.SetWindowLong(hwnd, TaskbarNative.GwlExstyle, ex);

        TaskbarNative.SetWindowPos(
            hwnd, 0, 0, 0, 0, 0,
            TaskbarNative.SwpNomove | TaskbarNative.SwpNosize | TaskbarNative.SwpNoZOrder
            | TaskbarNative.SwpFramechanged | TaskbarNative.SwpNoActivate);
    }

    /// <summary>
    /// Moves the child so its client area matches <paramref name="clientWidth"/> x
    /// <paramref name="clientHeight"/> (the pixels OnPaint and TextRenderer share).
    /// Returns false when the window is already there, so a value refresh does not
    /// call SetWindowPos.
    /// </summary>
    public bool Place(MetricsBarForm form, int clientWidth, int clientHeight)
    {
        if (!form.IsHandleCreated) return false;
        if (_hTaskbar == 0) RefreshHandles();
        if (_hTaskbar == 0) return false;
        if (TaskbarNative.GetParent(form.Handle) != _hTaskbar)
            Attach(form);
        if (_basisParent != _hTaskbar)
            ResetPlacementBasis();

        var wantW = Math.Max(8, clientWidth);
        var wantH = Math.Max(16, clientHeight);
        var physW = ToPhysical(wantW, _basisClientW, _basisPhysW);
        var physH = ToPhysical(wantH, _basisClientH, _basisPhysH);

        if (!TryClientOrigin(physW, out var x, out var y))
            return false;

        // Same HWND rectangle as last time: SetWindowPos would only flash.
        if (_hasPlaced && x == _lastX && y == _lastY && physW == _lastPhysW && physH == _lastPhysH)
            return false;

        TaskbarNative.SetWindowPos(
            form.Handle, 0, x, y, physW, physH,
            TaskbarNative.SwpNoZOrder | TaskbarNative.SwpNoActivate);

        _lastX = x;
        _lastY = y;
        _lastPhysW = physW;
        _lastPhysH = physH;
        _basisPhysW = physW;
        _basisPhysH = physH;
        _basisClientW = Math.Max(1, form.ClientSize.Width);
        _basisClientH = Math.Max(1, form.ClientSize.Height);
        _basisParent = _hTaskbar;
        _hasPlaced = true;
        return true;
    }

    private void ResetPlacementBasis()
    {
        _hasPlaced = false;
        _basisClientW = _basisClientH = 0;
        _basisPhysW = _basisPhysH = 0;
        _lastX = int.MinValue;
        _basisParent = _hTaskbar;
    }

    private static int ToPhysical(int wantClient, int basisClient, int basisPhys)
    {
        if (basisClient > 8 && basisPhys > 8)
            return Math.Max(1, (int)Math.Round(wantClient * (basisPhys / (double)basisClient)));
        return Math.Max(1, wantClient);
    }

    private bool TryClientOrigin(int physW, out int x, out int y)
    {
        var dpi = Math.Max(96, GetTaskbarDpi());
        var gap = Math.Max(4, dpi * 6 / 96);
        if (_hTray != 0
            && TaskbarNative.GetWindowRect(_hTray, out var tr)
            && TaskbarNative.GetWindowRect(_hTaskbar, out var parent))
        {
            x = tr.left - physW - gap - parent.left;
            y = Math.Max(0, _taskbarRect.Top - parent.top);
            return true;
        }

        if (TaskbarNative.GetWindowRect(_hTaskbar, out var taskbar))
        {
            x = taskbar.right - taskbar.left - physW - Math.Max(gap, dpi * 90 / 96);
            y = Math.Max(0, _taskbarRect.Top - taskbar.top);
            return true;
        }

        x = y = 0;
        return false;
    }

    public void Detach(MetricsBarForm form)
    {
        if (!form.IsHandleCreated) return;
        TaskbarNative.SetParent(form.Handle, 0);
    }

    private static int GetTaskbarDpi()
    {
        var tb = TaskbarNative.FindWindow("Shell_TrayWnd", null);
        if (tb == 0) return 96;
        try { return (int)TaskbarNative.GetDpiForWindow(tb); }
        catch { return 96; }
    }

    public bool IsLightTheme => _light;
}
using System.Runtime.InteropServices;

namespace TokenTrackerWin.TrccFork.MetricsBar;

/// <summary>P/Invoke for LiteMonitor-style taskbar child embedding (MIT, Diorser/LiteMonitor).</summary>
internal static class TaskbarNative
{
    internal const int GwlStyle = -16;
    internal const int GwlExstyle = -20;
    internal const int WsChild = 0x40000000;
    internal const int WsVisible = 0x10000000;
    internal const int WsClipSiblings = 0x04000000;
    internal const int WsCaption = 0x00C00000;
    internal const int WsThickFrame = 0x00040000;
    internal const int WsSysmenu = 0x00080000;
    internal const int WsMinimizebox = 0x00020000;
    internal const int WsMaximizebox = 0x00010000;
    internal const int WsBorder = 0x00800000;
    internal const uint SwpNomove = 0x0002;
    internal const uint SwpNosize = 0x0001;
    internal const uint SwpFramechanged = 0x0020;
    internal const int WsExLayered = 0x80000;
    internal const int WsExToolwindow = 0x80;
    internal const int WsExNoactivate = 0x08000000;
    internal const uint LwaColorkey = 0x1;
    internal const uint SwpNoZOrder = 0x0004;
    internal const uint SwpNoActivate = 0x0010;

    [StructLayout(LayoutKind.Sequential)]
    internal struct Point
    {
        public int X, Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct Rect
    {
        public int left, top, right, bottom;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern nint FindWindow(string cls, string? name);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern nint FindWindowEx(nint parent, nint after, string cls, string? name);

    [DllImport("user32.dll")]
    internal static extern int GetWindowLong(nint hWnd, int idx);

    [DllImport("user32.dll")]
    internal static extern int SetWindowLong(nint hWnd, int idx, int value);

    [DllImport("user32.dll")]
    internal static extern bool GetWindowRect(nint hWnd, out Rect rect);

    [DllImport("user32.dll")]
    internal static extern nint SetParent(nint child, nint parent);

    [DllImport("user32.dll")]
    internal static extern nint GetParent(nint hWnd);

    [DllImport("user32.dll")]
    internal static extern bool SetWindowPos(nint hWnd, nint insertAfter, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll")]
    internal static extern bool SetLayeredWindowAttributes(nint hwnd, uint crKey, byte bAlpha, uint dwFlags);

    [DllImport("user32.dll")]
    internal static extern bool IsWindow(nint hWnd);

    [DllImport("user32.dll")]
    internal static extern uint GetDpiForWindow(nint hWnd);
}

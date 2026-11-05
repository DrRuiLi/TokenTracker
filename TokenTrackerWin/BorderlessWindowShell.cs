using System.Runtime.InteropServices;

namespace TokenTrackerWin;

/// <summary>
/// Win32 helpers for borderless WPF dashboard windows: maximize within the monitor
/// work area (taskbar-safe) and keep injected WebView title buttons clickable.
/// </summary>
internal static class BorderlessWindowShell
{
    internal const int NativeCaptionHeightPx = 28;
    internal const int TitleButtonWidthPx = 44;
    internal const int TitleButtonCount = 3;

    private const int WM_GETMINMAXINFO = 0x0024;
    private const int WM_NCHITTEST = 0x0084;
    private const int HTCLIENT = 1;
    private const int MONITOR_DEFAULTTONEAREST = 2;

    internal static bool TryHandleMessage(
        nint hwnd,
        int msg,
        nint lParam,
        out nint result)
    {
        result = nint.Zero;
        if (msg == WM_GETMINMAXINFO)
        {
            ApplyMaximizeWorkArea(hwnd, lParam);
            return true;
        }

        if (msg == WM_NCHITTEST && TryTitleButtonClientHit(hwnd, lParam, out result))
            return true;

        return false;
    }

    internal static void ApplyMaximizeWorkArea(nint hwnd, nint lParam)
    {
        var monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if (monitor == 0) return;

        var info = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
        if (!GetMonitorInfo(monitor, ref info)) return;

        var mmi = Marshal.PtrToStructure<MINMAXINFO>(lParam);
        mmi.ptMaxPosition.X = info.rcWork.Left;
        mmi.ptMaxPosition.Y = info.rcWork.Top;
        mmi.ptMaxSize.X = info.rcWork.Right - info.rcWork.Left;
        mmi.ptMaxSize.Y = info.rcWork.Bottom - info.rcWork.Top;
        Marshal.StructureToPtr(mmi, lParam, true);
    }

    private static bool TryTitleButtonClientHit(nint hwnd, nint lParam, out nint result)
    {
        result = nint.Zero;
        if (!GetWindowRect(hwnd, out var window)) return false;

        var lParamValue = lParam.ToInt64();
        var x = (short)(lParamValue & 0xFFFF);
        var y = (short)((lParamValue >> 16) & 0xFFFF);

        var buttonStripWidth = TitleButtonWidthPx * TitleButtonCount;
        var buttonLeft = window.Right - buttonStripWidth;
        if (x >= buttonLeft && x < window.Right
            && y >= window.Top && y < window.Top + NativeCaptionHeightPx)
        {
            result = HTCLIENT;
            return true;
        }

        return false;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MINMAXINFO
    {
        public POINT ptReserved;
        public POINT ptMaxSize;
        public POINT ptMaxPosition;
        public POINT ptMinTrackSize;
        public POINT ptMaxTrackSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public int dwFlags;
    }

    [DllImport("user32.dll")]
    private static extern nint MonitorFromWindow(nint hwnd, int flags);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern bool GetMonitorInfo(nint hMonitor, ref MONITORINFO lpmi);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(nint hwnd, out RECT lpRect);
}

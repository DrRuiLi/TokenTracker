using System.Drawing;
using System.Runtime.InteropServices;

namespace TokenTrackerWin.TrccFork.MetricsBar;

internal static class TaskbarDock
{
    private const int AbmGetTaskbarPos = 0x00000005;

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left, Top, Right, Bottom;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct AppBarData
    {
        public uint cbSize;
        public nint hWnd;
        public uint uCallbackMessage;
        public uint uEdge;
        public Rect rc;
        public int lParam;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Auto)]
    private static extern uint SHAppBarMessage(uint dwMessage, ref AppBarData data);

    /// <summary>Place a horizontal bar along the primary taskbar (typically above it).</summary>
    public static Rectangle BoundsForBar(int barWidth, int barHeight)
    {
        var screen = Screen.PrimaryScreen ?? Screen.AllScreens[0];
        var work = screen.WorkingArea;
        int top = work.Bottom - barHeight;

        var abd = new AppBarData { cbSize = (uint)Marshal.SizeOf<AppBarData>() };
        if (SHAppBarMessage(AbmGetTaskbarPos, ref abd) != 0)
        {
            var task = Rectangle.FromLTRB(abd.rc.Left, abd.rc.Top, abd.rc.Right, abd.rc.Bottom);
            if (abd.uEdge is 2 or 3) // bottom / top
            {
                if (abd.uEdge == 2)
                    top = task.Top - barHeight;
                else
                    top = task.Bottom;
            }
        }

        int left = work.Left + Math.Max(0, (work.Width - barWidth) / 2);
        return new Rectangle(left, top, Math.Min(barWidth, work.Width), barHeight);
    }
}
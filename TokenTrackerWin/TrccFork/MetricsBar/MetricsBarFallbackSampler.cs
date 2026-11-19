using System.Diagnostics;
using System.Net.NetworkInformation;

namespace TokenTrackerWin.TrccFork.MetricsBar;

/// <summary>When trcc /api/metrics is unreachable.</summary>
internal sealed class MetricsBarFallbackSampler : IDisposable
{
    private PerformanceCounter? _cpu;
    private long _lastSent;
    private long _lastRecv;
    private double _lastSampleTime;

    public MetricsBarFallbackSampler()
    {
        try { _cpu = new PerformanceCounter("Processor", "% Processor Time", "_Total"); _cpu.NextValue(); }
        catch { _cpu = null; }
    }

    public Dictionary<string, double?> Sample()
    {
        var dict = new Dictionary<string, double?>(StringComparer.Ordinal)
        {
            ["cpu"] = ReadCpu(),
            ["mem"] = ReadMem(),
            ["temp"] = null,
            ["power"] = null,
        };
        var (up, dl) = ReadNet();
        dict["up"] = up;
        dict["dl"] = dl;
        return dict;
    }

    private double? ReadCpu()
    {
        try { return _cpu is null ? null : Math.Clamp(_cpu.NextValue(), 0, 100); }
        catch { return null; }
    }

    private static double? ReadMem()
    {
        try
        {
            NativeMemoryStatus.Get(out var st);
            if (st.TotalPhys == 0) return null;
            return (st.TotalPhys - st.AvailPhys) * 100.0 / st.TotalPhys;
        }
        catch { return null; }
    }

    private (double?, double?) ReadNet()
    {
        try
        {
            var interfaces = NetworkInterface.GetAllNetworkInterfaces()
                .Where(n => n.OperationalStatus == OperationalStatus.Up
                            && n.NetworkInterfaceType != NetworkInterfaceType.Loopback);
            long sent = 0, recv = 0;
            foreach (var n in interfaces)
            {
                var stats = n.GetIPv4Statistics();
                sent += stats.BytesSent;
                recv += stats.BytesReceived;
            }
            var now = Environment.TickCount64 / 1000.0;
            double? up = null, dl = null;
            if (_lastSampleTime > 0)
            {
                var dt = Math.Max(0.001, now - _lastSampleTime);
                up = Math.Max(0, (sent - _lastSent) / dt);
                dl = Math.Max(0, (recv - _lastRecv) / dt);
            }
            _lastSent = sent;
            _lastRecv = recv;
            _lastSampleTime = now;
            return (up, dl);
        }
        catch
        {
            return (null, null);
        }
    }

    public void Dispose() => _cpu?.Dispose();

    private static class NativeMemoryStatus
    {
        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        internal struct MemoryStatusEx
        {
            public uint Length;
            public uint MemoryLoad;
            public ulong TotalPhys;
            public ulong AvailPhys;
            public ulong TotalPageFile;
            public ulong AvailPageFile;
            public ulong TotalVirtual;
            public ulong AvailVirtual;
            public ulong AvailExtendedVirtual;
        }

        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GlobalMemoryStatusEx(ref MemoryStatusEx lpBuffer);

        internal static void Get(out MemoryStatusEx st)
        {
            st = new MemoryStatusEx { Length = (uint)System.Runtime.InteropServices.Marshal.SizeOf<MemoryStatusEx>() };
            GlobalMemoryStatusEx(ref st);
        }
    }
}
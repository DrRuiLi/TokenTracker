using System.Diagnostics;
using System.Management;
using System.Net.NetworkInformation;
using LibreHardwareMonitor.Hardware;

namespace TokenTrackerWin.TrccFork.MetricsBar;

/// <summary>When trcc /api/metrics is unreachable.</summary>
internal sealed class MetricsBarFallbackSampler : IDisposable
{
    private PerformanceCounter? _cpu;
    private PerformanceCounter? _diskRead;
    private PerformanceCounter? _diskWrite;
    private readonly List<(string Group, PerformanceCounter Counter)> _gpuCounters = [];
    private long _lastGpuScan;
    private long _lastSensorScan;
    private Dictionary<string, double?> _sensorValues = new(StringComparer.Ordinal);
    private readonly object _sensorLock = new();
    private Computer? _computer;
    private long _lastSent;
    private long _lastRecv;
    private double _lastSampleTime;

    public MetricsBarFallbackSampler()
    {
        try { _cpu = new PerformanceCounter("Processor", "% Processor Time", "_Total"); _cpu.NextValue(); }
        catch { _cpu = null; }
        try
        {
            _diskRead = new PerformanceCounter("PhysicalDisk", "Disk Read Bytes/sec", "_Total");
            _diskWrite = new PerformanceCounter("PhysicalDisk", "Disk Write Bytes/sec", "_Total");
            _diskRead.NextValue();
            _diskWrite.NextValue();
        }
        catch
        {
            _diskRead?.Dispose();
            _diskWrite?.Dispose();
            _diskRead = _diskWrite = null;
        }
        TryOpenLhm();
    }

    public Dictionary<string, double?> Sample()
    {
        var dict = new Dictionary<string, double?>(StringComparer.Ordinal)
        {
            ["cpu"] = ReadCpu(),
            ["mem"] = ReadMem(),
            ["temp"] = null,
            ["gpu_temp"] = null,
            ["gpu"] = ReadGpu(),
            ["vram"] = null,
            ["power"] = null,
            ["disk_read"] = ReadCounter(_diskRead),
            ["disk_write"] = ReadCounter(_diskWrite),
        };
        var (up, dl) = ReadNet();
        dict["up"] = up;
        dict["dl"] = dl;
        var sensors = ReadGpuSensors();
        foreach (var (key, value) in sensors)
            if (value is not null) dict[key] = value;
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

    public void Dispose()
    {
        _cpu?.Dispose();
        _diskRead?.Dispose();
        _diskWrite?.Dispose();
        foreach (var (_, counter) in _gpuCounters) counter.Dispose();
        try { _computer?.Close(); }
        catch { }
    }

    private static double? ReadCounter(PerformanceCounter? counter)
    {
        try { return counter?.NextValue(); }
        catch { return null; }
    }

    private double? ReadGpu()
    {
        try
        {
            if (_gpuCounters.Count == 0 || Environment.TickCount64 - _lastGpuScan >= 30_000)
                RefreshGpuCounters();
            if (_gpuCounters.Count == 0) return null;

            var groups = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
            foreach (var (group, counter) in _gpuCounters)
            {
                var value = Math.Max(0, counter.NextValue());
                groups[group] = groups.GetValueOrDefault(group) + value;
            }
            return groups.Count == 0 ? null : Math.Clamp(groups.Values.Max(), 0, 100);
        }
        catch { return null; }
    }

    private Dictionary<string, double?> ReadGpuSensors()
    {
        if (Environment.TickCount64 - _lastSensorScan < 2_000) return _sensorValues;
        _lastSensorScan = Environment.TickCount64;
        lock (_sensorLock)
        {
            if (_computer is not null)
            {
                var fromLhm = ReadLhmGpuSensors();
                if (fromLhm.Values.Any(v => v is not null))
                {
                    _sensorValues = fromLhm;
                    return fromLhm;
                }
            }
        }
        var next = new Dictionary<string, double?>(StringComparer.Ordinal)
        {
            ["gpu"] = null,
            ["gpu_temp"] = null,
            ["vram"] = null,
        };

        foreach (var ns in new[] { @"root\LibreHardwareMonitor", @"root\OpenHardwareMonitor" })
        {
            try
            {
                using var searcher = new ManagementObjectSearcher(ns,
                    "SELECT Name, Identifier, SensorType, Value FROM Sensor " +
                    "WHERE SensorType = 'Load' OR SensorType = 'Temperature'");
                using var sensors = searcher.Get();
                foreach (ManagementObject sensor in sensors)
                {
                    using (sensor)
                    {
                        var name = Convert.ToString(sensor["Name"]) ?? "";
                        var id = Convert.ToString(sensor["Identifier"]) ?? "";
                        if (!(name.Contains("gpu", StringComparison.OrdinalIgnoreCase)
                              || id.Contains("gpu", StringComparison.OrdinalIgnoreCase))) continue;
                        if (!double.TryParse(Convert.ToString(sensor["Value"], System.Globalization.CultureInfo.InvariantCulture),
                                System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var value))
                            continue;
                        var type = Convert.ToString(sensor["SensorType"]);
                        if (type == "Load" && id.Contains("/load/", StringComparison.OrdinalIgnoreCase))
                        {
                            var key = name.Contains("memory", StringComparison.OrdinalIgnoreCase) ? "vram" : "gpu";
                            if (value is >= 0 and <= 100)
                                next[key] = Math.Max(next[key] ?? 0, value);
                        }
                        else if (type == "Temperature" && id.Contains("/temperature/", StringComparison.OrdinalIgnoreCase)
                                 && value is > 0 and < 125)
                        {
                            if (next["gpu_temp"] is null || name.Contains("GPU Core", StringComparison.OrdinalIgnoreCase))
                                next["gpu_temp"] = value;
                        }
                    }
                }
                if (next.Values.Any(v => v is not null)) break;
            }
            catch { /* LibreHardwareMonitor/OpenHardwareMonitor is optional. */ }
        }

        _sensorValues = next;
        return next;
    }

    private void TryOpenLhm()
    {
        try
        {
            if (!new System.Security.Principal.WindowsPrincipal(
                    System.Security.Principal.WindowsIdentity.GetCurrent())
                .IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator)) return;
            var computer = new Computer { IsGpuEnabled = true };
            computer.Open();
            _computer = computer;
        }
        catch { /* Embedded LibreHardwareMonitor sensors require administrator access. */ }
    }

    private Dictionary<string, double?> ReadLhmGpuSensors()
    {
        var values = new Dictionary<string, double?>(StringComparer.Ordinal)
        {
            ["gpu"] = null,
            ["gpu_temp"] = null,
            ["vram"] = null,
        };
        foreach (var hardware in _computer!.Hardware)
        {
            if (hardware.HardwareType is not (HardwareType.GpuNvidia or HardwareType.GpuAmd or HardwareType.GpuIntel))
                continue;
            try { hardware.Update(); }
            catch { continue; }
            foreach (var sensor in hardware.Sensors)
            {
                if (sensor.Value is not { } value) continue;
                var id = sensor.Identifier.ToString();
                if (sensor.SensorType == SensorType.Load && id.Contains("/load/", StringComparison.OrdinalIgnoreCase)
                    && value is >= 0 and <= 100)
                {
                    var key = sensor.Name.Contains("memory", StringComparison.OrdinalIgnoreCase) ? "vram" : "gpu";
                    values[key] = Math.Max(values[key] ?? 0, value);
                }
                else if (sensor.SensorType == SensorType.Temperature
                         && id.Contains("/temperature/", StringComparison.OrdinalIgnoreCase)
                         && value is > 0 and < 125)
                {
                    if (values["gpu_temp"] is null || sensor.Name.Contains("GPU Core", StringComparison.OrdinalIgnoreCase))
                        values["gpu_temp"] = value;
                }
            }
        }
        return values;
    }

    private void RefreshGpuCounters()
    {
        _lastGpuScan = Environment.TickCount64;
        foreach (var (_, counter) in _gpuCounters) counter.Dispose();
        _gpuCounters.Clear();
        try
        {
            var category = new PerformanceCounterCategory("GPU Engine");
            foreach (var instance in category.GetInstanceNames())
            {
                var typeAt = instance.LastIndexOf("_engtype_", StringComparison.OrdinalIgnoreCase);
                var luidAt = instance.IndexOf("luid_", StringComparison.OrdinalIgnoreCase);
                if (typeAt < 0 || luidAt < 0) continue;
                var group = instance[luidAt..];
                var pidAt = group.IndexOf("_pid_", StringComparison.OrdinalIgnoreCase);
                if (pidAt >= 0) group = group[..pidAt];
                try
                {
                    var counter = new PerformanceCounter("GPU Engine", "Utilization Percentage", instance);
                    counter.NextValue();
                    _gpuCounters.Add(($"{group[..Math.Min(typeAt - luidAt, group.Length)]}{instance[typeAt..]}", counter));
                }
                catch { /* Some GPU engines disappear between enumeration and open. */ }
            }
        }
        catch { /* GPU performance counters are not available on every driver. */ }
    }

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

"""Live Windows (and Linux) system metrics for the dashboard.

CPU / MEM / net: psutil, sampled inline (cheap).
Power W and CPU temp °C: read by a background SensorPoller thread so a slow
source never stalls rendering or the USB keep-alive.  Windows sources, in
order: embedded LibreHardwareMonitorLib (pythonnet + system .NET 8, admin
only), LibreHardwareMonitor / OpenHardwareMonitor WMI, MSAcpi.  Linux: psutil
sensors / hwmon.  Missing values stay None — renderer shows "—".
"""
from __future__ import annotations

import collections
import functools
import logging
import os
import platform
import sys
import threading
import time
from pathlib import Path
from typing import Deque, Dict, List, Optional, Tuple

log = logging.getLogger("trcc_dash.sysmetrics")

HIST = 40
SENSOR_PERIOD_S = 2.0
WMI_RECONNECT_S = 10.0
ACPI_PERIOD_S = 60.0

_WMI_NAMESPACES = ("root\\LibreHardwareMonitor", "root\\OpenHardwareMonitor")
_TEMP_PREFER = ("CPU Package", "Core (Tctl/Tdie)", "Tctl/Tdie", "Tctl", "Tdie",
                "CPU CCD", "Core Max", "Core Average", "CPU Core")
_POWER_PREFER = ("CPU Package", "Package", "CPU PPT", "CPU Cores")

# (name, identifier, value)
SensorRow = Tuple[str, str, float]


def _cpu_rows(rows: List[SensorRow]) -> List[SensorRow]:
    """LHM/OHM identifiers look like /intelcpu/0/temperature/0 or /amdcpu/0/power/0."""
    return [r for r in rows if "cpu" in r[1].lower()]


def _prefer(rows: List[SensorRow], prefer: tuple) -> Optional[float]:
    lower = [(n.lower(), v) for n, _i, v in rows]
    for key in prefer:
        k = key.lower()
        for n, v in lower:
            if k in n:
                return v
    return None


def pick_cpu_temp(rows: List[SensorRow]) -> Optional[float]:
    rows = [r for r in _cpu_rows(rows) if 0 < r[2] < 125]
    if not rows:
        return None
    v = _prefer(rows, _TEMP_PREFER)
    return v if v is not None else max(r[2] for r in rows)


def pick_cpu_power(rows: List[SensorRow]) -> Optional[float]:
    rows = [r for r in _cpu_rows(rows) if 0 < r[2] < 1000]
    return _prefer(rows, _POWER_PREFER) if rows else None


@functools.lru_cache(maxsize=1)
def is_admin() -> bool:
    if os.name != "nt":
        return hasattr(os, "geteuid") and os.geteuid() == 0
    try:
        import ctypes
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


_LHM_DLL = "LibreHardwareMonitorLib.dll"


def find_lhm_dir() -> Optional[Path]:
    """Bundled LibreHardwareMonitorLib: PyInstaller dir, exe dir, source vendor/."""
    here = Path(__file__).resolve().parent
    dirs = []
    if getattr(sys, "frozen", False):
        dirs += [Path(getattr(sys, "_MEIPASS", here)) / "lhm", Path(sys.executable).resolve().parent / "lhm"]
    dirs += [here / "lhm", here / "vendor" / "lhm"]
    for d in dirs:
        if (d / _LHM_DLL).is_file():
            return d
    return None


_clr_lock = threading.Lock()
_clr_loaded = False


class LhmSource:
    """Embedded LibreHardwareMonitorLib (CPU sensors only).

    Needs the system .NET 8+ runtime and admin rights; reads MSR/SMU through
    the PawnIO kernel driver (installed system-wide, e.g. by LiteMonitor).
    Without admin every value reads 0, which pick_* treat as missing.
    """

    def __init__(self, dll_dir: Path):
        global _clr_loaded
        with _clr_lock:
            if not _clr_loaded:
                from pythonnet import load
                load("coreclr")       # a process can host only one runtime
                _clr_loaded = True
        import clr  # type: ignore
        if str(dll_dir) not in sys.path:
            sys.path.append(str(dll_dir))
        clr.AddReference(str(dll_dir / _LHM_DLL))
        from LibreHardwareMonitor.Hardware import Computer, SensorType  # type: ignore
        self._types = (SensorType.Temperature, SensorType.Power)
        self._computer = Computer()
        self._computer.IsCpuEnabled = True
        self._computer.Open()

    def rows(self) -> List[SensorRow]:
        out: List[SensorRow] = []
        for hw in self._computer.Hardware:
            hw.Update()
            for s in hw.Sensors:
                if s.SensorType in self._types and s.Value is not None:
                    out.append((str(s.Name), s.Identifier.ToString(), float(s.Value)))
        return out

    def close(self) -> None:
        try:
            self._computer.Close()
        except Exception:
            pass


SOURCE_LABELS = {
    "lhm": "内置传感器",
    "wmi": "LibreHardwareMonitor",
    "acpi": "ACPI 温度",
    "linux": "Linux 传感器",
}


class SensorPoller(threading.Thread):
    """Owns every slow sensor source; exposes the latest temp/power values."""

    def __init__(self, period: float = SENSOR_PERIOD_S, embedded: bool = True):
        super().__init__(name="sensor-poller", daemon=True)
        self.period = period
        self.temp_c: Optional[float] = None
        self.power_w: Optional[float] = None
        self.source: Optional[str] = None      # key of SOURCE_LABELS that produced values
        self.embedded_status = "未启用"          # human-readable state of the embedded source
        self._stop_evt = threading.Event()
        self._is_windows = platform.system() == "Windows"
        self._embedded = embedded
        self._lhm: Optional[LhmSource] = None
        self._wmi = None
        self._wmi_next_try = 0.0
        self._wmi_missing_logged = False
        self._acpi_dead = False
        self._acpi_last = 0.0
        self._acpi_val: Optional[float] = None

    def stop(self) -> None:
        self._stop_evt.set()

    def _wait_period(self) -> bool:
        """Sleep until the next sample. A shorter period takes effect immediately.
        True means the poller was asked to stop."""
        started = time.monotonic()
        limit = self.period
        while True:
            limit = min(limit, self.period)
            remaining = limit - (time.monotonic() - started)
            if remaining <= 0:
                return False
            if self._stop_evt.wait(min(0.25, remaining)):
                return True

    def run(self) -> None:
        com = None
        if self._is_windows:
            try:
                import pythoncom  # type: ignore
                pythoncom.CoInitialize()
                com = pythoncom
            except Exception as e:
                log.info("pywin32 不可用，跳过 LibreHardwareMonitor WMI: %s", e)
            self._open_embedded()
        try:
            while True:
                try:
                    self._poll_once()
                except Exception as e:
                    log.debug("sensor poll failed: %s", e)
                if self._wait_period():
                    break
        finally:
            self._wmi = None
            if self._lhm is not None:
                self._lhm.close()
                self._lhm = None
            if com is not None:
                try:
                    com.CoUninitialize()
                except Exception:
                    pass

    def _open_embedded(self) -> None:
        if not self._embedded:
            self.embedded_status = "已关闭"
            return
        if not is_admin():
            self.embedded_status = "需要管理员权限"
            log.info("非管理员运行，内置传感器（LibreHardwareMonitorLib）不可用")
            return
        dll_dir = find_lhm_dir()
        if dll_dir is None:
            self.embedded_status = "缺少 LibreHardwareMonitorLib.dll"
            log.warning("未找到 vendor/lhm/%s", _LHM_DLL)
            return
        try:
            t0 = time.perf_counter()
            self._lhm = LhmSource(dll_dir)
            self.embedded_status = "运行中"
            log.info("内置传感器已启用（%.1f s）", time.perf_counter() - t0)
        except Exception as e:
            self._lhm = None
            self.embedded_status = "加载失败（需要 .NET 8 运行时）"
            log.warning("内置传感器加载失败: %s", e)

    def _poll_once(self) -> None:
        source = None
        if self._is_windows:
            temp = power = None
            if self._lhm is not None:
                try:
                    rows = self._lhm.rows()
                    temp, power = pick_cpu_temp(rows), pick_cpu_power(rows)
                    if temp is not None or power is not None:
                        source = "lhm"
                except Exception as e:
                    log.debug("embedded sensor read failed: %s", e)
            if temp is None and power is None:
                rows = self._wmi_rows()
                temp = pick_cpu_temp(rows) if rows else None
                power = pick_cpu_power(rows) if rows else None
                if temp is not None or power is not None:
                    source = "wmi"
            if temp is None:
                temp = self._acpi_temp()
                if temp is not None and source is None:
                    source = "acpi"
        else:
            temp, power = _linux_temp(), _linux_power()
            if temp is not None or power is not None:
                source = "linux"
        self.temp_c, self.power_w, self.source = temp, power, source

    # ---- Windows: LHM / OHM WMI, one cached connection ----
    def _wmi_connect(self):
        import win32com.client  # type: ignore
        locator = win32com.client.Dispatch("WbemScripting.SWbemLocator")
        for ns in _WMI_NAMESPACES:
            try:
                svc = locator.ConnectServer(".", ns)
                svc.ExecQuery("SELECT Name FROM Sensor")  # namespace exists?
                log.info("使用 %s 读取功耗/温度", ns)
                return svc
            except Exception:
                continue
        return None

    def _wmi_rows(self) -> List[SensorRow]:
        now = time.monotonic()
        if self._wmi is None:
            if now < self._wmi_next_try:
                return []
            self._wmi_next_try = now + WMI_RECONNECT_S
            try:
                self._wmi = self._wmi_connect()
            except ImportError:
                self._wmi_next_try = float("inf")
                log.info("未安装 pywin32，跳过 LibreHardwareMonitor WMI")
                return []
            except Exception as e:
                log.debug("WMI connect failed: %s", e)
                self._wmi = None
            if self._wmi is None:
                if not self._wmi_missing_logged:
                    log.info("未检测到 LibreHardwareMonitor/OpenHardwareMonitor WMI（需保持其运行）")
                    self._wmi_missing_logged = True
                return []
        try:
            res = self._wmi.ExecQuery(
                "SELECT Name, Identifier, Value FROM Sensor "
                "WHERE SensorType = 'Temperature' OR SensorType = 'Power'")
            rows: List[SensorRow] = []
            for s in res:
                try:
                    rows.append((str(s.Name), str(s.Identifier), float(s.Value)))
                except Exception:
                    continue
            return rows
        except Exception as e:
            log.debug("WMI query failed, reconnecting later: %s", e)
            self._wmi = None
            return []

    # ---- Windows fallback: MSAcpi thermal zone (often motherboard, not CPU) ----
    def _acpi_temp(self) -> Optional[float]:
        # Hidden PowerShell at most once a minute; give up for good after the
        # first failure so the windowed exe never flashes console windows.
        if self._acpi_dead:
            return None
        now = time.monotonic()
        if self._acpi_last and now - self._acpi_last < ACPI_PERIOD_S:
            return self._acpi_val
        self._acpi_last = now
        self._acpi_val = None
        try:
            import subprocess
            out = subprocess.check_output(
                [
                    "powershell", "-NoProfile", "-Command",
                    "(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature "
                    "-ErrorAction SilentlyContinue | Select-Object -First 1).CurrentTemperature",
                ],
                timeout=5,
                stderr=subprocess.DEVNULL,
                stdin=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            raw = out.decode(errors="replace").strip()
            if raw.isdigit():
                c = int(raw) / 10.0 - 273.15   # tenths of Kelvin
                if 0 < c < 125:
                    self._acpi_val = c
                    return c
        except Exception:
            pass
        self._acpi_dead = True
        return None


def _linux_temp() -> Optional[float]:
    try:
        import psutil
        temps = psutil.sensors_temperatures(fahrenheit=False)
    except Exception:
        return None
    if not temps:
        return None
    for key in ("k10temp", "coretemp", "zenpower", "acpitz"):
        vals = [e.current for e in temps.get(key, []) if e.current is not None]
        if vals:
            return float(vals[0] if key == "k10temp" else max(vals))
    for entries in temps.values():
        for e in entries:
            if e.current is not None:
                return float(e.current)
    return None


def _linux_power() -> Optional[float]:
    import pathlib
    for p in pathlib.Path("/sys/class/hwmon").glob("hwmon*/power1_input"):
        try:
            uw = int(p.read_text().strip())   # microwatts
            if uw > 0:
                return uw / 1e6
        except Exception:
            continue
    return None


class MetricsCollector:
    def __init__(self, history: int = HIST, start_sensors: bool = True,
                 sensor_period: float = SENSOR_PERIOD_S):
        self.n = history
        self._cpu: Deque[float] = collections.deque(maxlen=history)
        self._mem: Deque[float] = collections.deque(maxlen=history)
        self._power: Deque[float] = collections.deque(maxlen=history)
        self._temp: Deque[float] = collections.deque(maxlen=history)
        self._up: Deque[float] = collections.deque(maxlen=history)
        self._dl: Deque[float] = collections.deque(maxlen=history)
        self._net0 = None
        self._t0 = None
        self._last_power: Optional[float] = None
        self._last_temp: Optional[float] = None
        self._sensors: Optional[SensorPoller] = None
        if start_sensors:
            self._sensors = SensorPoller(period=sensor_period)
            self._sensors.start()
        try:
            import psutil
            psutil.cpu_percent(interval=None)   # prime
        except Exception:
            pass

    def set_sensor_period(self, period: float) -> None:
        if self._sensors is not None:
            self._sensors.period = float(period)

    def close(self) -> None:
        if self._sensors is not None:
            self._sensors.stop()

    def sensor_info(self) -> Dict:
        s = self._sensors
        return {
            "sensor_source": s.source if s else None,
            "sensor_embedded": s.embedded_status if s else "未启用",
            "admin": is_admin(),
        }

    def sample(self) -> Dict:
        import psutil

        cpu = float(psutil.cpu_percent(interval=None))
        vm = psutil.virtual_memory()
        mem = float(vm.percent)
        used_gb = vm.used / (1024 ** 3)
        total_gb = vm.total / (1024 ** 3)

        now = time.monotonic()
        io = psutil.net_io_counters()
        up_bps = dl_bps = 0.0
        if self._net0 is not None and self._t0 is not None:
            dt = max(1e-3, now - self._t0)
            up_bps = max(0.0, (io.bytes_sent - self._net0.bytes_sent) / dt)
            dl_bps = max(0.0, (io.bytes_recv - self._net0.bytes_recv) / dt)
        self._net0 = io
        self._t0 = now

        if self._sensors is not None:
            if self._sensors.temp_c is not None:
                self._last_temp = self._sensors.temp_c
            if self._sensors.power_w is not None:
                self._last_power = self._sensors.power_w

        self._cpu.append(cpu)
        self._mem.append(mem)
        self._up.append(up_bps)
        self._dl.append(dl_bps)
        if self._last_power is not None:
            self._power.append(self._last_power)
        if self._last_temp is not None:
            self._temp.append(self._last_temp)

        return {
            "cpu": cpu,
            "cpu_hist": list(self._cpu) or [cpu],
            "mem": mem,
            "mem_used_gb": used_gb,
            "mem_total_gb": total_gb,
            "mem_hist": list(self._mem) or [mem],
            "power_w": self._last_power,
            "power_hist": list(self._power) or ([self._last_power] if self._last_power is not None else [0]),
            "temp_c": self._last_temp,
            "temp_hist": list(self._temp) or ([self._last_temp] if self._last_temp is not None else [0]),
            "up_bps": up_bps,
            "up_hist": list(self._up) or [up_bps],
            "dl_bps": dl_bps,
            "dl_hist": list(self._dl) or [dl_bps],
        }

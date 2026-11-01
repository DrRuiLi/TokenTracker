"""X-subscription usage from the grok.com billing CSV.

The export is downloaded by the dedicated Edge profile
(%LOCALAPPDATA%\\trcc-token-dash\\edge-profile). Sign in once with
open-grok-login.bat and close that window. Everyday Edge is not touched.

The raw CSV contains account identifiers, so only the billing id, time,
model and token total are kept.
"""
from __future__ import annotations

import csv
import ctypes
import datetime as dt
import json
import logging
import os
import subprocess
import threading
import time
import urllib.parse
from ctypes import wintypes
from pathlib import Path

log = logging.getLogger("trcc_dash.grok")

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
TOKEN_KEYS = (
    "prompt-text-tokens",
    "completion-text-tokens",
    "cached-prompt-text-tokens",
    "cache-write-text-tokens",
)
TZ = dt.timezone(dt.timedelta(hours=8))
DOWNLOAD_TIMEOUT_S = 120.0


class GrokBillingError(RuntimeError):
    pass


def app_dir() -> Path:
    base = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
    path = base / "trcc-token-dash"
    path.mkdir(parents=True, exist_ok=True)
    return path


def profile_dir() -> Path:
    return app_dir() / "edge-profile"


def store_path() -> Path:
    return app_dir() / "grok-billing.jsonl"


def _zulu(ts: dt.datetime) -> str:
    return ts.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def export_url(start: dt.datetime, end: dt.datetime) -> str:
    query = urllib.parse.urlencode({
        "scope": "user",
        "startTime": _zulu(start),
        "endTime": _zulu(end),
    })
    return "https://grok.com/dashboard/api/dashboard/v2/export-billing-items-csv?" + query


def local_window(now: dt.datetime | None = None, days_back: int = 1) -> tuple[dt.datetime, dt.datetime]:
    """Local yesterday through the end of today, as UTC instants."""
    now = now or dt.datetime.now(TZ)
    if now.tzinfo is None:
        now = now.replace(tzinfo=TZ)
    now = now.astimezone(TZ)
    start = dt.datetime.combine(now.date() - dt.timedelta(days=days_back), dt.time.min, tzinfo=TZ)
    end = dt.datetime.combine(now.date() + dt.timedelta(days=1), dt.time.min, tzinfo=TZ)
    return start, end


def usage_tokens(raw) -> int:
    if not raw:
        return 0
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except json.JSONDecodeError:
        return 0
    if not isinstance(data, dict):
        return 0
    total = 0
    for key in TOKEN_KEYS:
        try:
            total += int(float(data.get(key) or 0))
        except (TypeError, ValueError):
            continue
    return total


def events_from_csv(path: Path) -> list[dict]:
    """Return billing rows. Skips a truncated final line."""
    out = []
    with path.open(encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            item_id = (row.get("Billing Item ID") or "").strip()
            raw_time = (row.get("Event Time") or "").strip()
            if not item_id or not raw_time:
                continue
            model = (row.get("Model") or "").strip() or (row.get("Product") or "").strip() or "unknown"
            out.append({
                "id": item_id,
                "t": raw_time,
                "model": model,
                "tokens": usage_tokens(row.get("Usage")),
                "product": (row.get("Product") or "").strip(),
            })
    return out


def _read_store(path: Path) -> dict[str, dict]:
    items = {}
    if not path.is_file():
        return items
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("id"):
                items[row["id"]] = row
    return items


def merge_store(events: list[dict], path: Path | None = None) -> int:
    """Insert rows by billing id. Returns how many ids were new or changed."""
    path = path or store_path()
    items = _read_store(path)
    changed = 0
    for row in events:
        prev = items.get(row["id"])
        if prev != row:
            items[row["id"]] = row
            changed += 1
    tmp = path.with_suffix(".jsonl.tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as fh:
        for row in items.values():
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    os.replace(tmp, path)
    return changed


def stats_from_store(path: Path | None = None, now=None, queue_path: Path | None = None):
    """Aggregate the store, and fill days the export does not cover from the queue."""
    from render import _aggregate, _parse_ts, iter_queue_events
    path = path or store_path()
    events = []
    covered = set()
    for row in _read_store(path).values():
        try:
            ts = _parse_ts(row.get("t") or "")
        except ValueError:
            continue
        events.append((ts, row.get("model") or "unknown", int(row.get("tokens") or 0)))
        covered.add(ts.date())
    if queue_path is None:
        queue_path = Path.home() / ".tokentracker" / "tracker" / "queue.jsonl"
    if queue_path.is_file() and covered:
        for ts, model, n in iter_queue_events(queue_path):
            if ts.date() not in covered:
                events.append((ts, model, n))
    elif queue_path.is_file() and not events:
        events.extend(iter_queue_events(queue_path))
    return _aggregate(events, now)


_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _hidden_kwargs() -> dict:
    """Start a process with no console and no visible window."""
    info = subprocess.STARTUPINFO()
    info.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    info.wShowWindow = 0
    return {"creationflags": _NO_WINDOW, "startupinfo": info}


def _profile_pids(profile: Path) -> list[int]:
    marker = str(profile).lower()
    try:
        out = subprocess.check_output(
            ["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command",
             "Get-CimInstance Win32_Process -Filter \"name='msedge.exe'\" "
             "| Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],
            text=True, errors="replace", timeout=20,
            **_hidden_kwargs(),
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if not out.strip():
        return []
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return []
    if isinstance(data, dict):
        data = [data]
    pids = []
    for row in data:
        cmd = (row.get("CommandLine") or "").lower()
        if marker in cmd and row.get("ProcessId"):
            pids.append(int(row["ProcessId"]))
    return pids


def _descendants(root: int) -> set[int]:
    """Process ids in the tree under root, including root. No console."""
    if os.name != "nt" or root <= 0:
        return {root} if root > 0 else set()

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", ctypes.c_long),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", ctypes.c_wchar * 260),
        ]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel.Process32FirstW.restype = wintypes.BOOL
    kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel.Process32NextW.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    snap = kernel.CreateToolhelp32Snapshot(0x00000002, 0)
    if not snap or snap == ctypes.c_void_p(-1).value:
        return {root}
    parents: dict[int, int] = {}
    entry = PROCESSENTRY32W()
    entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
    ok = kernel.Process32FirstW(snap, ctypes.byref(entry))
    while ok:
        parents[int(entry.th32ProcessID)] = int(entry.th32ParentProcessID)
        ok = kernel.Process32NextW(snap, ctypes.byref(entry))
    kernel.CloseHandle(snap)
    pids = {root}
    changed = True
    while changed:
        changed = False
        for pid, parent in parents.items():
            if parent in pids and pid not in pids:
                pids.add(pid)
                changed = True
    return pids


def _hide_windows(pids: set[int]) -> None:
    if os.name != "nt" or not pids:
        return
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    get_long = user32.GetWindowLongW
    set_long = user32.SetWindowLongW
    GWL_EXSTYLE = -20
    WS_EX_TOOLWINDOW = 0x00000080
    WS_EX_APPWINDOW = 0x00040000

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def _visit(hwnd, _lparam):
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value not in pids:
            return True
        style = get_long(hwnd, GWL_EXSTYLE)
        set_long(hwnd, GWL_EXSTYLE, (style | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW)
        user32.ShowWindow(hwnd, 0)
        return True

    user32.EnumWindows(_visit, 0)


def _watch_windows(root: int, profile: Path, stop: threading.Event) -> None:
    """Keep the dedicated Edge off-screen and off the taskbar while it downloads."""
    extra: set[int] = set()
    next_scan = 0.0
    while not stop.is_set():
        now = time.monotonic()
        if now >= next_scan:
            extra.update(_profile_pids(profile))
            next_scan = now + 1.5
        _hide_windows(_descendants(root) | extra)
        stop.wait(0.05)


def _kill_profile(profile: Path) -> None:
    for pid in _profile_pids(profile):
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            capture_output=True,
            **_hidden_kwargs(),
        )


def _set_download_dir(profile: Path, dest: Path) -> None:
    prefs_path = profile / "Default" / "Preferences"
    if not prefs_path.is_file():
        raise GrokBillingError("专用 Edge 还没有登录，请先运行 open-grok-login.bat")
    prefs = json.loads(prefs_path.read_text(encoding="utf-8"))
    prefs.setdefault("download", {})
    prefs["download"]["default_directory"] = str(dest)
    prefs["download"]["prompt_for_download"] = False
    prefs["download"]["directory_upgrade"] = True
    prefs_path.write_text(json.dumps(prefs, separators=(",", ":")), encoding="utf-8")


def _wait_csv(dest: Path, started: float, timeout: float) -> Path:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        partial = list(dest.glob("*.crdownload"))
        ready = [p for p in dest.glob("*.csv") if p.stat().st_mtime >= started - 1]
        if ready and not partial:
            return max(ready, key=lambda p: p.stat().st_mtime)
        time.sleep(0.5)
    raise GrokBillingError("专用 Edge 没有在限定时间内下完用量 CSV")


def download_csv(start: dt.datetime, end: dt.datetime, timeout: float = DOWNLOAD_TIMEOUT_S) -> Path:
    """Launch the dedicated Edge, wait for the CSV, then close that Edge only."""
    profile = profile_dir()
    if not (profile / "Default" / "Network" / "Cookies").is_file():
        raise GrokBillingError("专用 Edge 还没有登录，请先运行 open-grok-login.bat")
    if not Path(EDGE).is_file():
        raise GrokBillingError("找不到 Microsoft Edge")
    if _profile_pids(profile):
        raise GrokBillingError("专用登录窗口还开着，请先关掉它")
    dest = app_dir() / "grok-download"
    dest.mkdir(parents=True, exist_ok=True)
    for old in dest.glob("*"):
        try:
            old.unlink()
        except OSError:
            pass
    _set_download_dir(profile, dest)
    started = time.time()
    proc = subprocess.Popen(
        [
            EDGE,
            f"--user-data-dir={profile}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--disable-sync",
            "--disable-notifications",
            "--disable-session-crashed-bubble",
            "--hide-crash-restore-bubble",
            "--window-position=-32000,-32000",
            "--window-size=200,200",
            export_url(start, end),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        **_hidden_kwargs(),
    )
    stop_watch = threading.Event()
    watcher = threading.Thread(
        target=_watch_windows, args=(proc.pid, profile, stop_watch),
        name="grok-edge-hide", daemon=True,
    )
    watcher.start()
    try:
        return _wait_csv(dest, started, timeout)
    finally:
        stop_watch.set()
        watcher.join(timeout=1)
        _kill_profile(profile)


def refresh_billing(now: dt.datetime | None = None, days_back: int = 1) -> int:
    start, end = local_window(now, days_back)
    csv_path = download_csv(start, end)
    try:
        events = events_from_csv(csv_path)
    finally:
        try:
            csv_path.unlink()
        except OSError:
            pass
    if not events:
        raise GrokBillingError("用量 CSV 没有记录")
    return merge_store(events)

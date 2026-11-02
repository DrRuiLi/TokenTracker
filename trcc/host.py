"""Headless side-screen host: no window and no tray icon.

TokenTracker's local server starts this with ``--serve``. The process exits
when that parent exits (``--parent-pid``), so it follows TokenTracker.
"""
from __future__ import annotations

import copy
import ctypes
import logging
import os
import subprocess
import sys
import threading
import time
from typing import Any, Dict, Optional

import control_api
import settings as cfg
from sysmetrics import is_admin
from theme_edit import COLOR_KEYS, color_groups_meta, flat_colors, set_color
from theme_presets import PRESET_IDS, preset_theme, presets_meta
from layouts import LAYOUT_IDS, layouts_meta
from worker import PushWorker

log = logging.getLogger("trcc_dash.host")

APP_TITLE = "利民副屏 Token 仪表盘"
RANGES = {"render_interval": (0.2, 10.0, 0.2), "sensor_interval": (0.5, 60.0, 0.5)}
API_EDITABLE = frozenset(("rotation", "mirror", "render_interval", "sensor_interval",
                          "close_action", "colors", "theme_preset", "layout"))
_WAIT_TIMEOUT = 0x102


def parent_alive(pid: int) -> bool:
    """False when pid is missing or has exited. pid 0 means 'no parent to watch'."""
    if pid <= 0:
        return True
    if sys.platform != "win32":
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    handle = ctypes.windll.kernel32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
    if not handle:
        return False
    try:
        return ctypes.windll.kernel32.WaitForSingleObject(handle, 0) == _WAIT_TIMEOUT
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


def apply_partial(settings: Dict[str, Any], data: Dict[str, Any]) -> Dict[str, Any]:
    """Return sanitized settings with ``data`` applied. Raises ValueError."""
    if not isinstance(data, dict):
        raise ValueError("JSON object expected")
    unknown = set(data) - API_EDITABLE
    if unknown:
        raise ValueError(f"unknown keys: {', '.join(sorted(unknown))}")
    s = copy.deepcopy(settings)
    if "rotation" in data:
        if data["rotation"] not in cfg.ROTATIONS:
            raise ValueError("rotation must be one of 0/90/180/270")
        s["rotation"] = data["rotation"]
    if "mirror" in data:
        if not isinstance(data["mirror"], bool):
            raise ValueError("mirror must be true/false")
        s["mirror"] = data["mirror"]
    for key, (lo, hi, _) in RANGES.items():
        if key in data:
            value = data[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"{key} must be a number")
            s[key] = min(hi, max(lo, float(value)))
    if "close_action" in data:
        if data["close_action"] not in cfg.CLOSE_ACTIONS:
            raise ValueError("close_action must be ask/tray/exit")
        s["close_action"] = data["close_action"]
    if "theme_preset" in data:
        preset = data["theme_preset"]
        if preset not in PRESET_IDS:
            raise ValueError("unknown theme preset")
        s["theme"] = preset_theme(preset)
    if "layout" in data:
        if data["layout"] not in LAYOUT_IDS:
            raise ValueError("unknown layout")
        s["layout"] = data["layout"]
    colors = data.get("colors")
    if colors is not None:
        if not isinstance(colors, dict):
            raise ValueError("colors must be an object")
        for key, value in colors.items():
            if key not in COLOR_KEYS or not cfg.valid_hex(value):
                raise ValueError(f"bad colour: {key}")
            set_color(s["theme"], key, value)
    return cfg.sanitize(s)


def reset_settings(settings: Dict[str, Any], pushing: bool) -> Dict[str, Any]:
    keep = {k: settings[k] for k in ("api_port", "close_action")}
    fresh = cfg.defaults()
    fresh.update(keep)
    fresh["autostart"] = pushing
    return fresh


def settings_payload(settings: Dict[str, Any], *, tray: bool, window_visible: bool,
                     api_port: Optional[int], can_elevate: bool, hosted: bool) -> dict:
    return {
        "settings": {
            "rotation": settings["rotation"], "mirror": settings["mirror"],
            "render_interval": settings["render_interval"],
            "sensor_interval": settings["sensor_interval"],
            "layout": settings["layout"],
            "close_action": settings.get("close_action", "ask"),
            "autostart": settings["autostart"],
            "colors": flat_colors(settings["theme"]),
            "theme_preset": settings["theme_preset"],
        },
        "app": {
            "title": APP_TITLE,
            "tray": tray,
            "window_visible": window_visible,
            "api_port": api_port,
            "can_elevate": can_elevate,
            "hosted": hosted,
        },
        "meta": {
            "rotations": list(cfg.ROTATIONS),
            "ranges": {k: list(v) for k, v in RANGES.items()},
            "close_actions": [{"id": k, "label": v} for k, v in (
                ("ask", "每次询问"), ("tray", "最小化到托盘"), ("exit", "退出程序"),
            )],
            "color_groups": color_groups_meta(),
            "theme_presets": presets_meta(),
            "layouts": layouts_meta(),
        },
    }


def _already_serving(port: int) -> bool:
    import json
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/state", timeout=1) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        return body.get("api_version") == control_api.API_VERSION
    except Exception:
        return False


class DashHost:
    """PushWorker plus the control API, with commands handled on the caller thread."""

    def __init__(self, csv_override=None, usage_file=None, parent_pid: int = 0, serve_args=None):
        self.settings = cfg.load()
        self.parent_pid = parent_pid
        self.serve_args = list(serve_args or [])
        self.worker = PushWorker(self.settings, csv_override=csv_override, usage_file=usage_file)
        self.api = None
        self._lock = threading.Lock()
        self._stopped = threading.Event()

    def start(self) -> None:
        port = int(self.settings.get("api_port") or 0)
        if port and _already_serving(port):
            log.info("副屏已在运行（端口 %s），本进程退出", port)
            raise SystemExit(0)
        self.worker.start()
        self.api = control_api.start_server(self, port)

    def stop(self) -> None:
        if self._stopped.is_set():
            return
        self._stopped.set()
        if self.api is not None:
            self.api.stop()
        try:
            cfg.save(self.settings)
        except Exception as exc:
            log.warning("保存设置失败: %s", exc)
        self.worker.stop()

    def call(self, cmd: str, payload=None, timeout: float = 3.0):
        if self._stopped.is_set():
            raise TimeoutError("quitting")
        if not self._lock.acquire(timeout=timeout):
            raise TimeoutError(cmd)
        try:
            return self._exec(cmd, payload)
        finally:
            self._lock.release()

    def _view(self) -> dict:
        api = self.api
        return settings_payload(
            self.settings,
            tray=False,
            window_visible=False,
            api_port=api.port if api else None,
            can_elevate=sys.platform == "win32" and not is_admin(),
            hosted=True,
        )

    def _publish(self) -> None:
        self.worker.update_settings(self.settings)
        cfg.save(self.settings)

    def _exec(self, cmd: str, payload):
        if cmd == "get_settings":
            return self._view()
        if cmd == "set_settings":
            self.settings = apply_partial(self.settings, payload)
            self._publish()
            return self._view()
        if cmd == "reset":
            self.settings = reset_settings(self.settings, self.worker.pushing)
            self._publish()
            return self._view()
        if cmd == "push":
            on = bool(payload)
            if on != self.worker.pushing:
                self.worker.set_pushing(on)
                self.settings["autostart"] = on
                cfg.save(self.settings)
            return {"pushing": self.worker.pushing}
        if cmd == "show":
            raise ValueError("由 TokenTracker 托管，没有独立窗口")
        if cmd == "relaunch_admin":
            return {"ok": self._relaunch_admin()}
        if cmd == "quit":
            threading.Thread(target=self.stop, name="host-stop", daemon=True).start()
            return {"ok": True}
        raise ValueError(f"unknown command: {cmd}")

    def _relaunch_admin(self) -> bool:
        if sys.platform != "win32" or is_admin():
            return False
        args = self.serve_args or ["--serve"]
        if self.parent_pid and "--parent-pid" not in args:
            args = args + ["--parent-pid", str(self.parent_pid)]
        if getattr(sys, "frozen", False):
            exe, cmd = sys.executable, args
        else:
            exe = Path_pythonw(sys.executable)
            cmd = [os.path.abspath(sys.argv[0])] + args
        cfg.save(self.settings)
        rc = ctypes.windll.shell32.ShellExecuteW(
            None, "runas", exe, subprocess.list2cmdline(cmd), os.getcwd(), 0)
        if rc <= 32:
            return False
        threading.Thread(target=self.stop, name="host-stop", daemon=True).start()
        return True


def Path_pythonw(executable: str) -> str:
    sibling = os.path.join(os.path.dirname(executable), "pythonw.exe")
    return sibling if os.path.isfile(sibling) else executable


def run_serve(csv_override=None, usage_file=None, parent_pid: int = 0, serve_args=None) -> int:
    host = DashHost(csv_override=csv_override, usage_file=usage_file, parent_pid=parent_pid, serve_args=serve_args)
    try:
        host.start()
    except SystemExit as exc:
        return int(exc.code or 0)
    log.info("副屏托管运行中 parent=%s", parent_pid or "none")
    try:
        while host.worker.is_alive() and not host._stopped.is_set():
            if not parent_alive(parent_pid):
                log.info("TokenTracker 已退出，停止副屏")
                break
            time.sleep(0.5)
    except KeyboardInterrupt:
        log.info("已停止")
    finally:
        host.stop()
    return 0

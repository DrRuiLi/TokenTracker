"""Background render + USB push loop (no GUI dependency).

The UI thread never touches USB or the network: it calls update_settings(),
set_pushing(), refresh_cursor() and reads snapshot()/latest_preview().
"""
from __future__ import annotations

import collections
import copy
import datetime as dt
import logging
import threading
import time
from typing import Any, Dict, Optional

from device import BulkLcd, DeviceBusyError, orient_image
from render import render, placeholder_metrics, W, H
from sysmetrics import MetricsCollector
from cursor_usage import CursorUsage

log = logging.getLogger("trcc_dash.worker")

KEEPALIVE_S = 0.15        # this panel falls back to its logo ~2-3 s without frames
RECONNECT_S = 3.0
TZ = dt.timezone(dt.timedelta(hours=8))


def empty_stats() -> Dict[str, Any]:
    today = dt.datetime.now(TZ)
    return {
        "today": 0,
        "days": [((today.date() - dt.timedelta(days=i)).isoformat(), 0) for i in range(29, -1, -1)],
        "hours": [0] * 24,
        "current_hour": today.hour,
        "models": [],
        "total_7d": 0,
        "total_30d": 0,
        "heat": [],
        "total_all": 0,
        "active_days": 0,
        "first_date": None,
    }


class PushWorker(threading.Thread):
    def __init__(self, settings: Dict[str, Any], csv_override=None, vid=None, pid=None):
        super().__init__(name="push-worker", daemon=True)
        self._lock = threading.Lock()
        self._settings = copy.deepcopy(settings)
        self._stop_evt = threading.Event()
        self._dirty = threading.Event()
        self._pushing = bool(settings.get("autostart", True))
        self._vid, self._pid = vid, pid
        self.usage = CursorUsage(refresh_s=float(settings.get("cursor_refresh", 90)),
                                 csv_override=csv_override)
        self._preview = None          # oriented PIL image, as sent
        self._preview_seq = 0
        self._status: Dict[str, Any] = {
            "connected": False, "pm": None, "sub": None, "size": None,
            "usb_error": None, "push_fps": 0.0, "render_ms": 0.0,
        }
        self._sent = collections.deque(maxlen=64)
        self._metrics: Optional[MetricsCollector] = None

    # ---- UI-facing API (thread-safe, non-blocking) ----
    def update_settings(self, settings: Dict[str, Any]) -> None:
        with self._lock:
            self._settings = copy.deepcopy(settings)
        self.usage.refresh_s = float(settings.get("cursor_refresh", 90))
        metrics = self._metrics
        if metrics is not None:
            metrics.set_sensor_period(float(settings.get("sensor_interval", 2.0)))
        self._dirty.set()

    def set_pushing(self, on: bool) -> None:
        with self._lock:
            self._pushing = bool(on)
        self._dirty.set()

    @property
    def pushing(self) -> bool:
        with self._lock:
            return self._pushing

    def refresh_cursor(self) -> None:
        self.usage.refresh_async(force=True)

    def stop(self, timeout: float = 5.0) -> None:
        """Signal stop and wait; one USB write can block up to 2 s."""
        self._stop_evt.set()
        if self.is_alive():
            self.join(timeout)

    def latest_preview(self):
        with self._lock:
            return self._preview_seq, self._preview

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            st = dict(self._status)
            st["pushing"] = self._pushing
        st["cursor_error"] = self.usage.last_error
        st["cursor_ok"] = self.usage.last_ok_wall
        st["cursor_busy"] = self.usage.busy
        m = self._metrics
        st.update(m.sensor_info() if m is not None
                  else {"sensor_source": None, "sensor_embedded": "未启用", "admin": False})
        return st

    # ---- worker ----
    def _set_status(self, **kw) -> None:
        with self._lock:
            self._status.update(kw)

    def _open(self, settings) -> Optional[BulkLcd]:
        kw = {"serial": settings.get("serial") or None}
        if self._vid is not None:
            kw["vid"] = self._vid
        if self._pid is not None:
            kw["pid"] = self._pid
        lcd = BulkLcd(**kw)
        try:
            prof = lcd.open()
        except DeviceBusyError as e:
            self._set_status(connected=False, usb_error=str(e))
            lcd.close()
            return None
        except Exception as e:  # not found, no backend, handshake...
            self._set_status(connected=False, usb_error=str(e) or type(e).__name__)
            lcd.close()
            return None
        self._set_status(connected=True, pm=prof.pm, sub=prof.sub,
                         size=(prof.width, prof.height), usb_error=None)
        return lcd

    def wait_frame(self, timeout: float) -> bool:
        """Block until at least one frame has been pushed to the panel."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and not self._stop_evt.is_set():
            if self._sent:
                return True
            time.sleep(0.05)
        return bool(self._sent)

    def run(self) -> None:
        try:
            with self._lock:
                sensor_period = float(self._settings.get("sensor_interval", 2.0))
            metrics = MetricsCollector(sensor_period=sensor_period)
        except Exception as e:
            log.warning("系统指标不可用，使用占位数据: %s", e)
            metrics = None
        self._metrics = metrics
        if metrics is not None:
            with self._lock:
                sensor_period = float(self._settings.get("sensor_interval", sensor_period))
            metrics.set_sensor_period(sensor_period)
        stats = self.usage.get_stats() if self.usage.csv_override else self.usage.load_cache()
        self.usage.refresh_async(force=True)
        lcd: Optional[BulkLcd] = None
        next_connect = 0.0
        last_render = 0.0
        try:
            while not self._stop_evt.is_set():
                now = time.monotonic()
                with self._lock:
                    settings = self._settings
                    pushing = self._pushing

                # USB connect / disconnect follows the start/stop toggle
                if pushing and lcd is None and now >= next_connect:
                    lcd = self._open(settings)
                    next_connect = now + RECONNECT_S
                    last_render = 0.0
                elif not pushing and lcd is not None:
                    lcd.close()
                    lcd = None
                    self._set_status(connected=False, push_fps=0.0)

                interval = float(settings.get("render_interval", 1.0))
                if self._dirty.is_set() or now - last_render >= interval:
                    self._dirty.clear()
                    self.usage.refresh_async()
                    stats = self.usage.current() or stats
                    try:
                        m = metrics.sample() if metrics else placeholder_metrics()
                    except Exception:
                        m = placeholder_metrics()
                    t0 = time.perf_counter()
                    img = render(m, stats or empty_stats(), settings.get("theme"))
                    rot = int(settings.get("rotation", 0)) % 360
                    mirror = bool(settings.get("mirror", False))
                    size = (lcd.profile.width, lcd.profile.height) if (lcd and lcd.profile) else (W, H)
                    oriented = orient_image(img, size[0], size[1], rot, mirror)
                    if lcd is not None:
                        lcd.rotate_deg, lcd.mirror = rot, mirror
                        try:
                            lcd.prepare(oriented, oriented=True)
                        except Exception as e:
                            lcd = self._drop(lcd, e)
                            next_connect = time.monotonic() + RECONNECT_S
                    with self._lock:
                        self._preview = oriented
                        self._preview_seq += 1
                    self._set_status(render_ms=(time.perf_counter() - t0) * 1000)
                    last_render = now

                if lcd is not None:
                    try:
                        if lcd.resend():
                            self._sent.append(time.monotonic())
                    except Exception as e:
                        lcd = self._drop(lcd, e)
                        next_connect = time.monotonic() + RECONNECT_S
                    if len(self._sent) >= 2:
                        span = self._sent[-1] - self._sent[0]
                        fps = (len(self._sent) - 1) / span if span > 0 else 0.0
                        if time.monotonic() - self._sent[-1] > 2:
                            fps = 0.0
                        self._set_status(push_fps=fps)
                self._stop_evt.wait(KEEPALIVE_S if lcd is not None else 0.25)
        finally:
            if lcd is not None:
                lcd.close()
            if metrics is not None:
                metrics.close()
            self._set_status(connected=False, push_fps=0.0)

    def _drop(self, lcd: BulkLcd, err: Exception):
        log.warning("USB 写入失败，稍后重连: %s", err)
        try:
            lcd.close()
        except Exception:
            pass
        self._sent.clear()
        self._set_status(connected=False, usb_error=f"USB 写入失败: {err}", push_fps=0.0)
        return None

"""Read TokenTracker usage for the side screen (no network, no Edge).

When started by TokenTracker, ``usage_file`` points at merged-usage.jsonl.
Standalone mode reads that file if present, otherwise the queue.
"""
from __future__ import annotations

import datetime as dt
import logging
import os
import threading
import time
from pathlib import Path
from typing import Optional

log = logging.getLogger("trcc_dash.usage")

DEFAULT_POLL_S = 2.0
TZ = dt.timezone(dt.timedelta(hours=8))


def _stats_stale(stats, now: dt.datetime) -> bool:
    days = stats.get("days") or []
    return (
        not days
        or days[-1][0] != now.date().isoformat()
        or stats.get("current_hour") != now.hour
    )


def _default_queue() -> Path:
    return Path.home() / ".tokentracker" / "tracker" / "queue.jsonl"


def _default_merged() -> Path:
    return Path.home() / ".tokentracker" / "tracker" / "merged-usage.jsonl"


class UsageReader:
    def __init__(
        self,
        poll_s: float = DEFAULT_POLL_S,
        csv_override: Optional[Path] = None,
        usage_file: Optional[Path] = None,
    ):
        self.poll_s = poll_s
        self.csv_override = Path(csv_override) if csv_override else None
        self.usage_file = Path(usage_file) if usage_file else None
        self._last_fetch = 0.0
        self._last_mtime = 0.0
        self._stats = None
        self._source: Optional[Path] = None
        self._error: Optional[str] = None
        self._lock = threading.Lock()
        self._busy = False
        self.last_ok_wall: Optional[float] = None

    @property
    def busy(self) -> bool:
        return self._busy

    @property
    def last_error(self) -> Optional[str]:
        return self._error

    def _resolve_path(self) -> Optional[Path]:
        if self.usage_file is not None:
            return self.usage_file
        merged = _default_merged()
        if merged.is_file() and merged.stat().st_size > 0:
            return merged
        queue = _default_queue()
        return queue if queue.is_file() else None

    def _load(self, path: Path):
        if path.suffix == ".jsonl":
            from render import token_stats_from_queue
            stats = token_stats_from_queue(path)
        else:
            from render import token_stats_from_csv
            stats = token_stats_from_csv(path)
        self._stats, self._source = stats, path
        try:
            self._last_mtime = path.stat().st_mtime
        except OSError:
            self._last_mtime = 0.0
        return stats

    def refresh_async(self, force: bool = False) -> None:
        now = time.monotonic()
        with self._lock:
            if self._busy or (not force and self._last_fetch and now - self._last_fetch < self.poll_s):
                return
            self._busy = True
            self._last_fetch = now

        def _run():
            try:
                self.get_stats(force=True)
            except Exception as e:
                self._error = str(e)
            finally:
                self._last_fetch = time.monotonic()
                self._busy = False

        threading.Thread(target=_run, name="usage-read", daemon=True).start()

    def load_cache(self):
        if self._stats is None:
            if self.csv_override and self.csv_override.is_file():
                try:
                    self._load(self.csv_override)
                    self.last_ok_wall = time.time()
                except Exception as e:
                    self._error = str(e)
                    log.warning("本地 CSV 读取失败: %s", e)
                return self._stats
            path = self._resolve_path()
            if path and path.is_file():
                try:
                    self._load(path)
                    self._error = None
                    self.last_ok_wall = time.time()
                    log.info("使用 TokenTracker 用量 %s", path)
                except Exception as e:
                    self._error = str(e)
                    log.warning("用量读取失败: %s", e)
            elif not self._error:
                self._error = "未找到 TokenTracker 用量文件（请先运行 TokenTracker）"
        return self._stats

    def current(self):
        stats, src = self._stats, self._source
        if stats is None or src is None:
            return stats
        if _stats_stale(stats, dt.datetime.now(TZ)) and src.is_file():
            try:
                return self._load(src)
            except Exception as e:
                log.debug("re-aggregate failed: %s", e)
        return stats

    def get_stats(self, force: bool = False):
        now = time.monotonic()
        if self.csv_override and self.csv_override.is_file():
            self._load(self.csv_override)
            self._error = None
            self.last_ok_wall = time.time()
            return self._stats

        if (
            not force
            and self._stats is not None
            and (now - self._last_fetch) < self.poll_s
        ):
            return self._stats

        path = self._resolve_path()
        if path is None or not path.is_file():
            if not self._stats:
                self._error = self._error or "未找到 TokenTracker 用量文件"
            return self._stats

        try:
            mtime = path.stat().st_mtime
        except OSError:
            mtime = 0.0
        if (
            not force
            and self._stats is not None
            and self._source == path
            and mtime <= self._last_mtime
        ):
            return self._stats

        try:
            self._load(path)
            self._error = None
            self.last_ok_wall = time.time()
        except Exception as e:
            self._error = str(e)
            log.warning("用量读取失败: %s", e)
        return self._stats

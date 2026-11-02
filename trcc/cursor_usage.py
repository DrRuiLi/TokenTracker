"""Fetch Cursor usage CSV using the locally signed-in Cursor session.

Cookie shape (independently reimplemented; no TokenTracker code copied):
  WorkosCursorSessionToken={userId}%3A%3A{jwt}
  jwt  ← ItemTable key cursorAuth/accessToken in state.vscdb
  userId ← JWT `sub` (same account as the token), then
           ~/.cursor/cli-config.json authInfo.authId (CLI may be another account)

NEVER log the JWT / cookie.
"""
from __future__ import annotations

import base64
import datetime as dt
import json
import logging
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import List, Optional, Tuple

log = logging.getLogger("trcc_dash.cursor")

CSV_URL = "https://cursor.com/api/dashboard/export-usage-events-csv?strategy=tokens"
CSV_TIMEOUT_S = 90.0
_CSV_HEADERS = {
    "Accept": "*/*",
    "Referer": "https://www.cursor.com/settings",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
}
_WORKOS_OAUTH_RE = re.compile(r"^(google-oauth2|github|oidc|auth0)\|[^|]+$")
DEFAULT_REFRESH_S = 90
TZ = dt.timezone(dt.timedelta(hours=8))


class CursorHTTPError(RuntimeError):
    def __init__(self, code: int):
        super().__init__(f"Cursor CSV HTTP {code}")
        self.code = code


def _appdata_candidates() -> list[Path]:
    home = Path.home()
    out = []
    if os.name == "nt":
        appdata = os.environ.get("APPDATA") or str(home / "AppData" / "Roaming")
        for name in ("Cursor", "Cursor Nightly", "Cursor Dev"):
            out.append(Path(appdata) / name)
    elif sys_platform() == "darwin":
        base = home / "Library" / "Application Support"
        for name in ("Cursor", "Cursor Nightly"):
            out.append(base / name)
    else:
        xdg = os.environ.get("XDG_CONFIG_HOME") or str(home / ".config")
        for name in ("Cursor", "Cursor Nightly"):
            out.append(Path(xdg) / name)
    return out


def sys_platform() -> str:
    import sys
    return sys.platform


def find_state_db() -> Optional[Path]:
    for app in _appdata_candidates():
        p = app / "User" / "globalStorage" / "state.vscdb"
        if p.is_file():
            return p
    return None


def find_cli_config() -> Optional[Path]:
    p = Path.home() / ".cursor" / "cli-config.json"
    return p if p.is_file() else None


def _normalize_subject(subject: str) -> Optional[str]:
    if not subject:
        return None
    m = re.search(r"\|(user_[A-Za-z0-9_]+)$", subject)
    if m:
        return m.group(1)
    if _WORKOS_OAUTH_RE.match(subject):
        return subject
    return None


def _userid_from_cli() -> Optional[str]:
    cfg = find_cli_config()
    if not cfg:
        return None
    try:
        data = json.loads(cfg.read_text(encoding="utf-8"))
        return _normalize_subject((data.get("authInfo") or {}).get("authId") or "")
    except Exception:
        return None


def _userid_from_jwt(jwt: str) -> Optional[str]:
    try:
        parts = jwt.split(".")
        if len(parts) != 3:
            return None
        pad = "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + pad))
        return _normalize_subject(payload.get("sub") or "")
    except Exception:
        return None


def _query_token(uri: str) -> Optional[str]:
    con = sqlite3.connect(uri, uri=True, timeout=2.0)
    try:
        row = con.execute(
            "SELECT value FROM ItemTable WHERE key = ?",
            ("cursorAuth/accessToken",),
        ).fetchone()
    finally:
        con.close()
    if not row or not row[0]:
        return None
    val = row[0]
    if isinstance(val, bytes):
        val = val.decode("utf-8", errors="replace")
    val = str(val).strip()
    return val if len(val) >= 10 else None


def _read_access_token(state_db: Path) -> Optional[str]:
    # state.vscdb can grow to tens of GB: never copy it, open it read-only in
    # place.  If Cursor holds a lock, immutable=1 skips locking entirely.
    base = state_db.resolve().as_uri()
    last: Optional[Exception] = None
    for mode in ("?mode=ro", "?mode=ro&immutable=1"):
        try:
            return _query_token(base + mode)
        except sqlite3.Error as e:
            last = e
    log.warning("无法读取 Cursor 登录状态: %s", type(last).__name__ if last else "unknown")
    return None


def extract_session_cookies() -> List[Tuple[str, str]]:
    """Return candidate (cookie_header_value, user_id) pairs, best first.

    Never log the token.  Raises RuntimeError with a user-facing reason.
    """
    db = find_state_db()
    if not db:
        raise RuntimeError("未找到 Cursor state.vscdb（请确认本机已登录 Cursor）")
    jwt = _read_access_token(db)
    if not jwt:
        raise RuntimeError("state.vscdb 中没有 cursorAuth/accessToken（请在 Cursor 里重新登录）")
    out: List[Tuple[str, str]] = []
    for uid in (_userid_from_jwt(jwt), _userid_from_cli()):
        if uid and uid not in (u for _c, u in out):
            out.append((f"WorkosCursorSessionToken={uid}%3A%3A{jwt}", uid))
    if not out:
        raise RuntimeError("无法解析 Cursor userId")
    return out


def extract_session_cookie() -> Optional[Tuple[str, str]]:
    """Return the best (cookie_header_value, user_id) or None."""
    try:
        return extract_session_cookies()[0]
    except RuntimeError as e:
        log.warning("%s", e)
        return None


def usage_csv_problem(text: str) -> Optional[str]:
    """None when the body is a real usage export.

    Cursor answers HTTP 200 with a one-line '# Error fetching data...' body when
    its own export is aborted. That still starts with a Date header, so the
    header check alone would accept it and wipe a good cache.
    """
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not lines:
        return "Cursor CSV 为空"
    header = lines[0]
    if "Date" not in header or "Total Tokens" not in header:
        return "Cursor CSV 响应不像用量导出（可能未登录或接口变更）"
    for ln in lines[1:]:
        if ln.startswith("#"):
            return "Cursor 导出失败: " + ln.lstrip("#").strip()[:160]
        if ln.split(",", 1)[0].strip().strip('"')[:1].isdigit():
            return None
    return "Cursor CSV 没有用量数据"


def fetch_usage_csv(cookie: str, timeout: float = CSV_TIMEOUT_S) -> str:
    headers = dict(_CSV_HEADERS)
    headers["Cookie"] = cookie
    try:
        import requests  # certifi CA bundle + system/env proxy handling
        r = requests.get(CSV_URL, headers=headers, timeout=timeout)
        if r.status_code != 200:
            raise CursorHTTPError(r.status_code)
        text = r.content.decode("utf-8-sig", errors="replace")
    except ImportError:
        req = urllib.request.Request(CSV_URL, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            raise CursorHTTPError(e.code) from e
        text = raw.decode("utf-8-sig", errors="replace")
    problem = usage_csv_problem(text)
    if problem:
        raise RuntimeError(problem)
    return text


def tokentracker_queue_path() -> Path:
    return Path.home() / ".tokentracker" / "tracker" / "queue.jsonl"


def _csv_usable(path: Path) -> bool:
    try:
        return usage_csv_problem(path.read_text(encoding="utf-8-sig")) is None
    except OSError:
        return False


def cache_path() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME") or (Path.home() / ".cache"))
    d = base / "trcc-token-dash"
    d.mkdir(parents=True, exist_ok=True)
    return d / "usage.csv"


def _write_cache(path: Path, text: str) -> None:
    # newline="" keeps the server's line endings (no \r\r\n on Windows)
    tmp = path.with_suffix(".csv.tmp")
    tmp.write_text(text, encoding="utf-8", newline="")
    os.replace(tmp, path)


def _stats_stale(stats, now: dt.datetime) -> bool:
    days = stats.get("days") or []
    return (not days or days[-1][0] != now.date().isoformat()
            or stats.get("current_hour") != now.hour)


class CursorUsage:
    def __init__(self, refresh_s: float = DEFAULT_REFRESH_S, csv_override: Optional[Path] = None,
                 usage_file: Optional[Path] = None):
        self.refresh_s = refresh_s
        self.csv_override = Path(csv_override) if csv_override else None
        self.usage_file = Path(usage_file) if usage_file else None
        self._last_fetch = 0.0
        self._stats = None
        self._source: Optional[Path] = None    # CSV the current stats came from
        self._error: Optional[str] = None
        self._lock = threading.Lock()
        self._busy = False
        self.last_ok_wall: Optional[float] = None   # time.time() of last good fetch

    @property
    def busy(self) -> bool:
        return self._busy

    @property
    def last_error(self) -> Optional[str]:
        return self._error

    def refresh_async(self, force: bool = False) -> None:
        """Kick a background refresh; never blocks the frame loop."""
        now = time.monotonic()
        with self._lock:
            if self._busy or (not force and self._last_fetch and now - self._last_fetch < self.refresh_s):
                return
            self._busy = True
            self._last_fetch = now  # also on failure: no retry storm

        def _run():
            try:
                self.get_stats(force=True)
            except Exception as e:
                self._error = str(e)
            finally:
                # interval counts from completion: one download can take ~50 s
                self._last_fetch = time.monotonic()
                self._busy = False
        threading.Thread(target=_run, name="cursor-fetch", daemon=True).start()

    def _load(self, path: Path):
        if path.name == "grok-billing.jsonl":
            from grok_billing import stats_from_store
            stats = stats_from_store(path)
        elif path.suffix == ".jsonl":
            from render import token_stats_from_queue
            stats = token_stats_from_queue(path)
        else:
            from render import token_stats_from_csv
            stats = token_stats_from_csv(path)
        self._stats, self._source = stats, path
        return stats

    def _use_local(self) -> bool:
        """Cache CSV if it is a real export, otherwise TokenTracker's queue."""
        path = cache_path()
        if _csv_usable(path):
            self._load(path)
            log.info("使用本地缓存用量 CSV")
            return True
        queue = tokentracker_queue_path()
        if queue.is_file():
            self._load(queue)
            note = "已改用 TokenTracker 本地记录"
            self._error = f"{self._error}；{note}" if self._error else note
            self.last_ok_wall = time.time()
            log.info("使用 TokenTracker 本地记录 %s", queue)
            return True
        return False

    def load_cache(self):
        if self._stats is None:
            try:
                from grok_billing import store_path
                saved = store_path()
                if saved.is_file() and saved.stat().st_size > 0:
                    self._load(saved)
                    log.info("使用已保存的 Grok 用量")
                else:
                    self._use_local()
            except Exception as e:
                log.warning("本地用量读取失败: %s", e)
        return self._stats

    def current(self):
        """Latest stats, re-aggregated from the source CSV when the day/hour
        has rolled over since they were built (works offline too)."""
        stats, src = self._stats, self._source
        if stats is None or src is None:
            return stats
        if _stats_stale(stats, dt.datetime.now(TZ)) and src.is_file():
            try:
                return self._load(src)
            except Exception as e:
                log.debug("re-aggregate failed: %s", e)
        return stats

    def _refresh_grok(self) -> bool:
        """Download the X-subscription billing CSV and use it when present.

        Dates covered by that export replace the older Cursor queue, so the
        same day is not counted twice. A failed download keeps the last store.
        """
        from grok_billing import GrokBillingError, refresh_billing, stats_from_store, store_path
        path = store_path()
        try:
            added = refresh_billing()
            self._stats = stats_from_store(path)
            self._source = path
            self._error = None
            self.last_ok_wall = time.time()
            log.info("Grok 用量已刷新，新增 %s 条", added)
            return True
        except GrokBillingError as e:
            self._error = str(e)
            log.warning("刷新 Grok 用量失败: %s", e)
            if path.is_file() and path.stat().st_size > 0:
                try:
                    self._stats = stats_from_store(path)
                    self._source = path
                    return True
                except Exception:
                    pass
            return False

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
            and (now - self._last_fetch) < self.refresh_s
        ):
            return self._stats

        # Hosted by TokenTracker: its merged view is the single display source
        # (all local provider rows plus the X billing rows written by this
        # sidecar). The sidecar still owns the X billing refresh, but never
        # substitutes its private Cursor CSV/cache for TokenTracker's data.
        if self.usage_file is not None:
            self._refresh_grok()
            try:
                if self.usage_file.is_file():
                    self._load(self.usage_file)
                    self.last_ok_wall = time.time()
                    return self._stats
                self._use_local()
            except Exception as e:
                self._error = str(e)
            return self._stats

        if self._refresh_grok():
            return self._stats

        path = cache_path()
        try:
            text = None
            last_exc: Optional[Exception] = None
            for attempt in range(3):
                try:
                    for cookie, _uid in extract_session_cookies():
                        try:
                            text = fetch_usage_csv(cookie)
                            break
                        except CursorHTTPError as e:
                            last_exc = e
                            if e.code not in (401, 403):
                                raise
                except RuntimeError as e:
                    # Export body was an error page; Cursor often recovers on retry.
                    last_exc = e
                    text = None
                    if attempt < 2:
                        time.sleep(2)
                        continue
                    raise
                break
            if text is None:
                raise last_exc or RuntimeError("无 Cursor 登录态")
            _write_cache(path, text)
            self._load(path)
            self._error = None
            self.last_ok_wall = time.time()
            log.info("Cursor 用量已刷新 → cache %s", path)
        except Exception as e:
            self._error = str(e)
            log.warning("刷新 Cursor 用量失败: %s", e)
            if self._stats is None:
                try:
                    self._use_local()
                except Exception:
                    pass
            elif self._source is not None and self._source.suffix == ".jsonl":
                self._error = f"{e}；已改用 TokenTracker 本地记录"
        return self._stats



"""Local HTTP control API for the TokenTracker "副屏" page.

Binds 127.0.0.1 only.  Browsers may call it from a loopback origin
(TokenTracker's dashboard, e.g. http://127.0.0.1:17680); any other Origin and
any non-loopback Host header (DNS rebinding) is rejected, so a random web page
cannot drive the USB device.

The bridge object (gui.App) provides:
  bridge.call(cmd, payload=None, timeout=...) -> result   (runs on the Tk thread)
  bridge.worker                                            (PushWorker)
"""
from __future__ import annotations

import io
import json
import logging
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional
from urllib.parse import urlsplit

from sysmetrics import SOURCE_LABELS

log = logging.getLogger(__name__)

API_VERSION = 1
MAX_BODY = 64 * 1024
CALL_TIMEOUT_S = 3.0

_LOOPBACK_ORIGIN = re.compile(r"^https?://(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$", re.I)
_LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "[::1]")


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def origin_allowed(origin: Optional[str]) -> bool:
    """No Origin (curl, <img>) or a loopback origin."""
    return not origin or bool(_LOOPBACK_ORIGIN.match(origin))


def host_allowed(host: Optional[str], port: int) -> bool:
    if not host:
        return False
    host = host.strip().lower()
    if host.startswith("["):
        name, sep, rest = host.partition("]")
        name += sep
        if rest and not rest.startswith(":"):
            return False
        p = rest[1:]
    else:
        name, _, p = host.partition(":")
    return name in _LOOPBACK_HOSTS and (not p or p == str(port))


def status_view(snap: dict) -> dict:
    st = dict(snap)
    src = st.get("sensor_source")
    st["sensor_label"] = SOURCE_LABELS.get(src, src) if src else None
    if st.get("size") is not None:
        st["size"] = list(st["size"])
    return st


class _PreviewCache:
    def __init__(self):
        self._lock = threading.Lock()
        self._seq = None
        self._png = b""

    def get(self, worker) -> tuple:
        seq, img = worker.latest_preview()
        if img is None:
            return seq, None
        with self._lock:
            if seq != self._seq:
                buf = io.BytesIO()
                img.save(buf, "PNG", optimize=False, compress_level=3)
                self._seq, self._png = seq, buf.getvalue()
            return self._seq, self._png


class _Handler(BaseHTTPRequestHandler):
    server_version = "trcc-token-dash"
    protocol_version = "HTTP/1.1"

    # ---- plumbing ----
    def log_message(self, fmt, *args):  # keep stdout quiet
        log.debug("api %s", fmt % args)

    def _cors(self):
        origin = self.headers.get("Origin")
        if origin and origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def _send(self, status: int, body: bytes, ctype: str, extra: Optional[dict] = None):
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, obj: Any):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _guard(self) -> bool:
        if not host_allowed(self.headers.get("Host"), self.server.server_address[1]):
            self._json(403, {"error": "bad host"})
            return False
        if not origin_allowed(self.headers.get("Origin")):
            self._json(403, {"error": "origin not allowed"})
            return False
        return True

    def _body(self) -> dict:
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            raise ApiError(415, "Content-Type must be application/json")
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError(400, "bad Content-Length")
        if n > MAX_BODY:
            raise ApiError(413, "body too large")
        raw = self.rfile.read(n) if n else b"{}"
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(400, "invalid JSON")
        if not isinstance(data, dict):
            raise ApiError(400, "JSON object expected")
        return data

    def _call(self, cmd: str, payload=None):
        try:
            return self.server.bridge.call(cmd, payload, timeout=CALL_TIMEOUT_S)
        except TimeoutError:
            raise ApiError(503, "app busy")
        except ValueError as e:
            raise ApiError(400, str(e))

    # ---- verbs ----
    def do_OPTIONS(self):
        if not self._guard():
            return
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def _dispatch(self, method: str):
        if not self._guard():
            return
        path = urlsplit(self.path).path.rstrip("/") or "/"
        route = _ROUTES.get((method, path))
        if route is None:
            self._json(404 if not any(p == path for _, p in _ROUTES) else 405,
                       {"error": "not found"})
            return
        try:
            route(self)
        except ApiError as e:
            self._json(e.status, {"error": str(e)})
        except Exception as e:  # never kill the server thread
            log.exception("api %s %s failed", method, path)
            self._json(500, {"error": f"{type(e).__name__}: {e}"})

    # ---- routes ----
    def r_state(self):
        b = self.server.bridge
        info = self._call("get_settings")
        seq, _ = b.worker.latest_preview()
        self._json(200, {
            "api_version": API_VERSION,
            "status": status_view(b.worker.snapshot()),
            "preview_seq": seq,
            **info,
        })

    def r_preview(self):
        seq, png = self.server.preview.get(self.server.bridge.worker)
        if png is None:
            self._json(404, {"error": "no frame yet"})
            return
        self._send(200, png, "image/png", {"X-Preview-Seq": str(seq)})

    def r_settings(self):
        self._json(200, self._call("set_settings", self._body()))

    def r_reset(self):
        self._json(200, self._call("reset"))

    def r_push(self):
        on = self._body().get("on")
        if not isinstance(on, bool):
            raise ApiError(400, "'on' must be true/false")
        self._json(200, self._call("push", on))

    def r_refresh_cursor(self):
        self.server.bridge.worker.refresh_cursor()
        self._json(200, {"ok": True})

    def r_show(self):
        self._json(200, self._call("show"))

    def r_relaunch_admin(self):
        self._json(200, self._call("relaunch_admin"))


_ROUTES = {
    ("GET", "/api/state"): _Handler.r_state,
    ("GET", "/api/preview.png"): _Handler.r_preview,
    ("POST", "/api/settings"): _Handler.r_settings,
    ("POST", "/api/settings/reset"): _Handler.r_reset,
    ("POST", "/api/push"): _Handler.r_push,
    ("POST", "/api/cursor/refresh"): _Handler.r_refresh_cursor,
    ("POST", "/api/window/show"): _Handler.r_show,
    ("POST", "/api/admin/relaunch"): _Handler.r_relaunch_admin,
}


class ControlServer:
    """Serves on its own thread.  Binding is retried for a while because an
    elevated relaunch starts while the previous instance still owns the port."""

    def __init__(self, bridge, port: int, bind_retries: int = 20, retry_s: float = 0.5):
        self.bridge = bridge
        self.port = port
        self.error: Optional[str] = None
        self._retries, self._retry_s = bind_retries, retry_s
        self._httpd: Optional[ThreadingHTTPServer] = None
        self._stop = threading.Event()
        self._ready = threading.Event()
        self._thread = threading.Thread(target=self._run, name="control-api", daemon=True)

    @property
    def listening(self) -> bool:
        return self._httpd is not None and self.error is None

    def start(self) -> "ControlServer":
        self._thread.start()
        return self

    def wait_ready(self, timeout: float) -> bool:
        return self._ready.wait(timeout)

    def _run(self):
        for attempt in range(self._retries + 1):
            if self._stop.is_set():
                return
            try:
                httpd = ThreadingHTTPServer(("127.0.0.1", self.port), _Handler)
                break
            except OSError as e:
                self.error = f"端口 {self.port} 被占用"
                if attempt == self._retries:
                    log.warning("control API port %s unavailable: %s", self.port, e)
                    self._ready.set()
                    return
                self._stop.wait(self._retry_s)
        if self._stop.is_set():
            httpd.server_close()
            return
        httpd.daemon_threads = True
        httpd.bridge = self.bridge
        httpd.preview = _PreviewCache()
        self.port = httpd.server_address[1]
        self._httpd, self.error = httpd, None
        self._ready.set()
        httpd.serve_forever(poll_interval=0.25)

    def stop(self) -> None:
        self._stop.set()
        httpd = self._httpd
        if httpd is not None:
            try:
                httpd.shutdown()
                httpd.server_close()
            except Exception:
                pass


def start_server(bridge, port: int, **kw) -> Optional[ControlServer]:
    """Start on 127.0.0.1:port in the background; None if disabled (port 0)."""
    if not port:
        return None
    return ControlServer(bridge, port, **kw).start()

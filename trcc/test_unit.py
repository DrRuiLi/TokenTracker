"""Box-side unit tests (no USB required)."""
from __future__ import annotations

import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from device import (
    build_frame_header,
    build_handshake_payload,
    encode_jpeg,
    pack_frame,
    resolve_profile,
)
import datetime as dt
import tempfile

from render import render, placeholder_metrics, token_stats_from_csv, TZ
from PIL import Image

_MODELS = ("claude-4.5-sonnet", "gpt-5", "auto", "composer-1")


def _make_csv(days_back=60, include_today=True, line_end="\n") -> Path:
    """Synthetic Cursor usage export ending at the real current time."""
    now = dt.datetime.now(dt.timezone.utc)
    rows = ['Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),'
            'Cache Read,Output Tokens,Total Tokens,Cost']
    start = 0 if include_today else 1
    for d in range(start, days_back):
        for k in range(3):
            ts = now - dt.timedelta(days=d, hours=k * 3)
            if not include_today and ts.astimezone(TZ).date() == now.astimezone(TZ).date():
                continue
            n = 1000 * (d + 1) + 137 * k
            rows.append(f'{ts.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]}Z,Included,'
                        f'{_MODELS[(d + k) % 4]},No,1,1,0,1,"{n:,}",0.01')
    p = Path(tempfile.mkdtemp()) / "usage.csv"
    p.write_text(line_end.join(rows) + line_end, encoding="utf-8", newline="")
    return p


CSV = _make_csv()


def test_handshake_payload():
    p = build_handshake_payload()
    assert len(p) == 64
    assert p[0:4] == bytes([0x12, 0x34, 0x56, 0x78])
    assert p[56] == 1


def test_frame_header():
    h = build_frame_header(2, 960, 320, 12345)
    assert len(h) == 64
    assert h[0:4] == bytes([0x12, 0x34, 0x56, 0x78])
    assert struct.unpack_from("<I", h, 4)[0] == 2
    assert struct.unpack_from("<I", h, 8)[0] == 960
    assert struct.unpack_from("<I", h, 12)[0] == 320
    assert struct.unpack_from("<I", h, 56)[0] == 2
    assert struct.unpack_from("<I", h, 60)[0] == 12345


def test_profile_960x320():
    # HydroNous R1 reports PM=17 SUB=5 and is upright at 0° (verified on hardware)
    for pm, sub in ((17, 5), (17, 3), (13, 5), (18, 6)):
        p = resolve_profile(pm, sub)
        assert (p.width, p.height) == (960, 320) and p.jpeg and p.encode_deg == 0


def test_orient_rotation_mirror():
    from device import orient_image
    img = Image.new("RGB", (960, 320), (0, 0, 0))
    img.putpixel((0, 0), (255, 0, 0))          # top-left marker
    r180 = orient_image(img, 960, 320, 180)
    assert r180.size == (960, 320) and r180.getpixel((959, 319))[0] > 200
    mir = orient_image(img, 960, 320, 0, mirror=True)
    assert mir.getpixel((959, 0))[0] > 200
    r90 = orient_image(img, 960, 320, 90)       # letterboxed, not stretched
    assert r90.size == (960, 320) and r90.getpixel((0, 160)) == (0, 0, 0)
    for deg in (0, 90, 180, 270):
        data = encode_jpeg(img, 960, 320, rotate_deg=deg, mirror=True)
        assert data[:2] == b"\xff\xd8"
        assert Image.open(__import__("io").BytesIO(data)).size == (960, 320)


def test_jpeg_encode_size_and_rotation():
    img = Image.new("RGB", (960, 320), (10, 20, 30))
    data = encode_jpeg(img, 960, 320, rotate_deg=0)
    assert data[:2] == b"\xff\xd8"
    frame = pack_frame(data, 960, 320, jpeg=True)
    assert frame[:4] == bytes([0x12, 0x34, 0x56, 0x78])
    assert struct.unpack_from("<I", frame, 60)[0] == len(data)
    assert len(frame) == 64 + len(data)
    # 180° still yields 960x320 JPEG
    data2 = encode_jpeg(img, 960, 320, rotate_deg=180)
    assert data2[:2] == b"\xff\xd8"


def test_token_stats_csv():
    assert CSV.is_file(), f"missing {CSV}"
    s = token_stats_from_csv(CSV)
    assert s["today"] > 0
    assert len(s["days"]) == 30
    assert len(s["hours"]) == 24
    assert s["total_30d"] >= s["today"]
    assert s["heat"]
    assert s["days"][-1][0] == dt.datetime.now(TZ).date().isoformat()


def test_today_zero_when_no_usage_today():
    s = token_stats_from_csv(_make_csv(include_today=False))
    now = dt.datetime.now(TZ)
    assert s["today"] == 0 and s["models"] == []
    assert s["days"][-1] == (now.date().isoformat(), 0)
    assert s["current_hour"] == now.hour
    assert s["total_7d"] > 0


def test_csv_crlf_and_bad_rows():
    p = _make_csv(line_end="\r\n")
    with open(p, "a", encoding="utf-8", newline="") as fh:
        fh.write("not-a-date,Included,x,No,1,1,0,1,5,0\r\n,,,,,,,,,\r\n")
    a, b = token_stats_from_csv(p), token_stats_from_csv(CSV)
    assert a["total_all"] == b["total_all"] > 0


def test_usage_current_reaggregates_after_rollover():
    from usage_reader import UsageReader
    u = UsageReader(csv_override=CSV)
    u.get_stats()
    stale = dict(u._stats)
    stale["days"] = stale["days"][:-1]          # pretend built yesterday
    u._stats = stale
    cur = u.current()
    assert cur["days"][-1][0] == dt.datetime.now(TZ).date().isoformat()


def test_sensor_picking():
    from sysmetrics import pick_cpu_temp, pick_cpu_power
    rows = [
        ("GPU Core", "/gpu-nvidia/0/temperature/0", 70.0),
        ("Core (Tctl/Tdie)", "/amdcpu/0/temperature/2", 61.5),
        ("CCD1 (Tdie)", "/amdcpu/0/temperature/3", 58.0),
        ("Temperature", "/nvme/0/temperature/0", 45.0),
        ("Package", "/amdcpu/0/power/0", 88.0),
        ("GPU Package", "/gpu-nvidia/0/power/0", 210.0),
    ]
    assert pick_cpu_temp(rows) == 61.5
    assert pick_cpu_power(rows) == 88.0
    assert pick_cpu_temp([("GPU Core", "/gpu/0/temperature/0", 70.0)]) is None
    assert pick_cpu_power([("CPU Core #1", "/intelcpu/0/power/1", 5.0)]) is None
    assert pick_cpu_temp([("Core #1", "/intelcpu/0/temperature/0", 50.0),
                          ("Core #2", "/intelcpu/0/temperature/1", 55.0)]) == 55.0


def test_sensor_source_priority():
    from sysmetrics import SensorPoller, find_lhm_dir
    assert find_lhm_dir() is not None

    class FakeLhm:
        def __init__(self, rows):
            self._rows = rows
        def rows(self):
            return self._rows

    p = SensorPoller(embedded=False)
    p._is_windows = True
    p._wmi_rows = lambda: [("Package", "/amdcpu/0/power/0", 40.0),
                           ("Core (Tctl/Tdie)", "/amdcpu/0/temperature/2", 55.0)]
    p._acpi_temp = lambda: None
    p._lhm = FakeLhm([("Package", "/amdcpu/0/power/0", 51.0),
                      ("Core (Tctl/Tdie)", "/amdcpu/0/temperature/2", 64.0)])
    p._poll_once()
    assert (p.temp_c, p.power_w, p.source) == (64.0, 51.0, "lhm")
    p._lhm = FakeLhm([("Package", "/amdcpu/0/power/0", 0.0),        # non-admin reads 0
                      ("Core (Tctl/Tdie)", "/amdcpu/0/temperature/2", 0.0)])
    p._poll_once()
    assert (p.temp_c, p.power_w, p.source) == (55.0, 40.0, "wmi")
    p._wmi_rows = lambda: []
    p._poll_once()
    assert (p.temp_c, p.power_w, p.source) == (None, None, None)
    import time
    p.period = 0.05
    t0 = time.perf_counter()
    assert p._wait_period() is False
    assert time.perf_counter() - t0 < 1.0


def test_find_libusb_source_tree():
    from device import find_libusb
    p = find_libusb()
    assert p is not None and p.name == "libusb-1.0.dll"


def test_theme_default_and_custom():
    from render import DEFAULT_THEME
    from PIL import ImageChops
    s = token_stats_from_csv(CSV)
    m = placeholder_metrics()
    a = render(m, s)
    b = render(m, s, {})
    assert ImageChops.difference(a, b).getbbox() is None
    c = render(m, s, {"bg_top": "#400000", "bg_bot": "#200000", "cpu": "#00ff00",
                      "models": ["#ff0000", "#00ff00", "#0000ff", "#ffff00"]})
    assert c.size == (960, 320)
    assert ImageChops.difference(a, c).getbbox() is not None
    assert c.getpixel((480, 2))[0] > c.getpixel((480, 2))[2]   # red-ish background
    c.save(HERE / "preview_theme.png")


def test_settings_roundtrip(tmp=None):
    import tempfile, json
    import settings as cfg
    d = Path(tempfile.mkdtemp())
    p = d / "settings.json"
    assert cfg.load(p) == cfg.defaults()
    st = cfg.defaults()
    st["rotation"] = 180
    st["mirror"] = True
    st["render_interval"] = 0.01          # clamped to 0.2
    st["theme"]["cpu"] = "#ABCDEF"
    st["theme"]["models"][2] = "#123456"
    cfg.save(st, p)
    back = cfg.load(p)
    assert back["rotation"] == 180 and back["mirror"] is True
    assert back["render_interval"] == 0.2
    assert back["theme"]["cpu"] == "#abcdef" and back["theme"]["models"][2] == "#123456"
    p.write_text(json.dumps({"rotation": 45, "theme": {"cpu": "nope", "bogus": "#000000"}}))
    bad = cfg.load(p)
    assert bad["rotation"] == 0 and bad["theme"]["cpu"] == cfg.defaults()["theme"]["cpu"]
    p.write_text("{corrupt")
    assert cfg.load(p) == cfg.defaults()
    assert cfg.defaults()["close_action"] == "ask"
    st = cfg.defaults()
    st["close_action"] = "tray"
    cfg.save(st, p)
    assert cfg.load(p)["close_action"] == "tray"
    p.write_text(json.dumps({"close_action": "minimize"}))
    assert cfg.load(p)["close_action"] == "ask"
    assert cfg.defaults()["api_port"] == cfg.DEFAULT_API_PORT
    for raw, want in ((0, 0), (18000, 18000), (80, cfg.DEFAULT_API_PORT), ("x", cfg.DEFAULT_API_PORT)):
        p.write_text(json.dumps({"api_port": raw}))
        assert cfg.load(p)["api_port"] == want


def test_worker_preview_without_usb():
    import time
    from worker import PushWorker
    import settings as cfg
    st = cfg.defaults()
    st["autostart"] = False
    st["rotation"] = 180
    w = PushWorker(st, csv_override=CSV)
    w.start()
    deadline = time.time() + 10
    while time.time() < deadline and w.latest_preview()[1] is None:
        time.sleep(0.1)
    seq, img = w.latest_preview()
    assert img is not None and img.size == (960, 320)
    snap = w.snapshot()
    assert snap["pushing"] is False and snap["connected"] is False
    st["theme"]["bg_bot"] = "#ff0000"
    w.update_settings(st)
    deadline = time.time() + 5
    while time.time() < deadline and w.latest_preview()[0] == seq:
        time.sleep(0.05)
    assert w.latest_preview()[0] != seq
    w.stop()
    assert not w.is_alive()


def test_control_api_guards():
    from control_api import host_allowed, origin_allowed
    assert origin_allowed(None) and origin_allowed("")
    assert origin_allowed("http://127.0.0.1:17680") and origin_allowed("http://localhost:5173")
    assert not origin_allowed("https://evil.example")
    assert not origin_allowed("http://127.0.0.1.evil.example")
    assert host_allowed("127.0.0.1:17691", 17691) and host_allowed("localhost", 17691)
    assert host_allowed("[::1]:17691", 17691)
    assert not host_allowed("127.0.0.1:1", 17691)
    assert not host_allowed("evil.example:17691", 17691)
    assert not host_allowed(None, 17691)


class _FakeWorker:
    def __init__(self):
        self.refreshed = 0
        self.img = Image.new("RGB", (960, 320), (10, 20, 30))

    def latest_preview(self):
        return 7, self.img

    def snapshot(self):
        return {"connected": True, "size": (960, 320), "pushing": True,
                "sensor_source": "lhm", "sensor_embedded": "运行中", "admin": True}

    def refresh_cursor(self):
        self.refreshed += 1


class _FakeBridge:
    def __init__(self):
        self.worker = _FakeWorker()
        self.calls = []

    def call(self, cmd, payload=None, timeout=3.0):
        self.calls.append((cmd, payload))
        if cmd == "set_settings" and payload.get("rotation") == 45:
            raise ValueError("rotation must be one of 0/90/180/270")
        return {"settings": {"rotation": 0}, "app": {}, "meta": {}}


def test_control_api_http():
    import json as _json
    import urllib.error
    import urllib.request
    from control_api import ControlServer

    bridge = _FakeBridge()
    srv = ControlServer(bridge, 0).start()
    assert srv.wait_ready(5) and srv.listening
    base = f"http://127.0.0.1:{srv.port}"

    def req(method, path, body=None, headers=None):
        data = _json.dumps(body).encode() if body is not None else None
        h = {"Content-Type": "application/json"} if body is not None else {}
        h.update(headers or {})
        r = urllib.request.Request(base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(r, timeout=5) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    try:
        st, hd, body = req("GET", "/api/state", headers={"Origin": "http://127.0.0.1:17680"})
        assert st == 200 and hd["Access-Control-Allow-Origin"] == "http://127.0.0.1:17680"
        j = _json.loads(body)
        assert j["status"]["sensor_label"] == "内置传感器" and j["preview_seq"] == 7
        assert j["status"]["size"] == [960, 320]

        st, hd, body = req("GET", "/api/preview.png")
        assert st == 200 and hd["Content-Type"] == "image/png"
        assert Image.open(__import__("io").BytesIO(body)).size == (960, 320)

        assert req("GET", "/api/state", headers={"Origin": "https://evil.example"})[0] == 403
        assert req("GET", "/api/state", headers={"Host": "evil.example"})[0] == 403
        assert req("OPTIONS", "/api/settings", headers={"Origin": "http://localhost:5173"})[0] == 204

        assert req("POST", "/api/settings", {"rotation": 90})[0] == 200
        assert bridge.calls[-1] == ("set_settings", {"rotation": 90})
        st, _, body = req("POST", "/api/settings", {"rotation": 45})
        assert st == 400 and "rotation" in _json.loads(body)["error"]
        # form posts (no preflight from browsers) are refused
        r = urllib.request.Request(base + "/api/push", data=b"on=1", method="POST",
                                   headers={"Content-Type": "application/x-www-form-urlencoded"})
        try:
            urllib.request.urlopen(r, timeout=5)
            raise AssertionError("form post accepted")
        except urllib.error.HTTPError as e:
            assert e.code == 415
        assert req("POST", "/api/push", {"on": "yes"})[0] == 400
        assert req("POST", "/api/push", {"on": False})[0] == 200
        assert bridge.calls[-1] == ("push", False)
        assert req("POST", "/api/cursor/refresh", {})[0] == 200 and bridge.worker.refreshed == 1
        assert req("GET", "/api/nope")[0] == 404
        assert req("GET", "/api/settings")[0] == 405
    finally:
        srv.stop()


def test_control_api_port_taken():
    import socket
    from control_api import ControlServer
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    s.listen(1)
    try:
        srv = ControlServer(_FakeBridge(), s.getsockname()[1], bind_retries=1, retry_s=0.05).start()
        assert srv.wait_ready(5) and not srv.listening and "被占用" in srv.error
    finally:
        s.close()


def test_theme_edit_derived_shades():
    from settings import default_theme_hex
    from theme_edit import COLOR_KEYS, flat_colors, set_color
    th = default_theme_hex()
    set_color(th, "daily_bar", "#ff0000")
    assert th["daily_bar"] == "#ff0000" and th["daily_bar_dim"] != "#ff0000"
    set_color(th, "models.2", "#00ff00")
    assert th["models"][2] == "#00ff00"
    set_color(th, "heatmap", "#0000ff")
    assert th["heat_levels"][-1] == "#0000ff"
    assert set(flat_colors(th)) == COLOR_KEYS


def test_host_settings_and_parent():
    import os
    from host import apply_partial, parent_alive, reset_settings
    import settings as cfg
    base = cfg.defaults()
    changed = apply_partial(base, {"rotation": 90, "mirror": True, "render_interval": 2,
                                   "sensor_interval": 0.1})
    assert changed["rotation"] == 90 and changed["mirror"] is True
    assert changed["render_interval"] == 2
    assert changed["sensor_interval"] == 0.5
    try:
        apply_partial(base, {"rotation": 45})
        raise AssertionError("bad rotation accepted")
    except ValueError:
        pass
    reset = reset_settings(changed, pushing=False)
    assert reset["rotation"] == 0 and reset["api_port"] == changed["api_port"]
    assert reset["autostart"] is False
    assert parent_alive(os.getpid())
    assert not parent_alive(2_100_000_000)


def test_queue_dedup_timezone_and_billable_heal():
    import json, tempfile
    from render import token_stats_from_queue, TZ
    p = Path(tempfile.mkdtemp()) / "queue.jsonl"
    rows = [
        {"source": "cursor", "model": "auto", "hour_start": "2026-11-01T02:00:00.000Z",
         "total_tokens": 100, "billable_total_tokens": 0},
        {"source": "cursor", "model": "auto", "hour_start": "2026-11-01T02:00:00.000Z",
         "total_tokens": 50, "billable_total_tokens": 50},
        {"source": "cursor", "model": "auto", "hour_start": "2026-11-01T02:30:00.000Z",
         "total_tokens": 25, "billable_total_tokens": 25},
        {"source": "cursor", "model": "gpt", "hour_start": "2026-11-01T03:00:00.000Z",
         "total_tokens": 40, "billable_total_tokens": 0},
    ]
    p.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
    s = token_stats_from_queue(p, now=dt.datetime(2026, 11, 1, 12, tzinfo=TZ))
    # 02:00Z/02:30Z -> 10:00 +8, later duplicate wins (50+25); 03:00Z -> 11:00, billable healed to 40
    assert s["today"] == 115
    assert s["hours"][10] == 75 and s["hours"][11] == 40
    assert s["models"][0] == ("auto", 75)
    assert s["total_all"] == 115 and s["active_days"] == 1


def test_preview_render():
    s = token_stats_from_csv(CSV)
    img = render(placeholder_metrics(), s)
    assert img.size == (960, 320)
    out = HERE / "preview.png"
    img.save(out)
    print("preview ->", out, "today=", s["today"])


if __name__ == "__main__":
    for fn in (
        test_handshake_payload,
        test_frame_header,
        test_profile_960x320,
        test_orient_rotation_mirror,
        test_jpeg_encode_size_and_rotation,
        test_theme_default_and_custom,
        test_settings_roundtrip,
        test_worker_preview_without_usb,
        test_token_stats_csv,
        test_today_zero_when_no_usage_today,
        test_csv_crlf_and_bad_rows,
        test_usage_current_reaggregates_after_rollover,
        test_sensor_picking,
        test_sensor_source_priority,
        test_find_libusb_source_tree,
        test_control_api_guards,
        test_control_api_http,
        test_control_api_port_taken,
        test_theme_edit_derived_shades,
        test_host_settings_and_parent,
        test_queue_dedup_timezone_and_billable_heal,
        test_preview_render,
    ):
        fn()
        print("OK", fn.__name__)
    print("all passed")

"""960x320 dashboard renderer for the Thermalright side screen (TRCC).

render(metrics, token_stats) -> PIL.Image (RGB, 960x320)
token_stats_from_csv(path) builds token_stats from a Cursor usage CSV export.
Drawn at SS x supersampling and downscaled for smooth edges.
"""
import csv, collections, datetime as dt, json, os
from PIL import Image, ImageDraw, ImageFont

W, H = 960, 320
SS = 3  # supersample factor
TZ = dt.timezone(dt.timedelta(hours=8))  # Asia/Shanghai

_FONT_CANDIDATES = [
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "Inter.ttf"),
    "/usr/share/fonts/truetype/sand-box/google/Inter/Inter-VariableFont_opsz,wght.ttf",
    "C:/Windows/Fonts/segoeui.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]
_font_cache = {}

def font(size, weight="Regular"):
    key = (size, weight)
    if key in _font_cache:
        return _font_cache[key]
    for p in _FONT_CANDIDATES:
        if os.path.exists(p):
            f = ImageFont.truetype(p, int(size * SS))
            try:
                f.set_variation_by_name(weight)
            except Exception:
                pass
            break
    else:
        f = ImageFont.load_default()
    _font_cache[key] = f
    return f

# ---- theme -------------------------------------------------------------
# Every colour the dashboard draws comes from a theme dict.  DEFAULT_THEME is
# the approved preview look; render(..., theme=) merges overrides on top.
DEFAULT_THEME = {
    "bg_top": (10, 14, 28), "bg_bot": (4, 6, 12),
    "card": (24, 25, 30), "card_hi": (40, 42, 50), "border": (64, 66, 76),
    "text": (245, 246, 250), "text_dim": (150, 153, 164), "axis": (70, 72, 82),
    "track": (52, 54, 62),
    "cpu": (30, 144, 255), "mem": (160, 120, 240), "power": (240, 160, 60),
    "temp": (240, 90, 90), "up": (45, 200, 170), "dl": (30, 144, 255),
    "daily_bar": (30, 144, 255), "daily_bar_dim": (12, 60, 130), "daily_bar_hi": (120, 190, 255),
    "hourly_bar": (30, 144, 255), "hourly_bar_dim": (12, 60, 130),
    "heat_empty": (38, 40, 48),
    "heat_levels": [(16, 52, 104), (18, 82, 168), (24, 116, 226), (60, 158, 255)],
    "today_ring": (245, 246, 250),
    "models": [(88, 140, 255), (160, 120, 240), (45, 200, 170), (240, 140, 80)],
    "weekly_bar": (240, 140, 80),
}

# Back-compat module constants (default look)
BG_TOP, BG_BOT = DEFAULT_THEME["bg_top"], DEFAULT_THEME["bg_bot"]
CARD, CARD_HI, BORDER = DEFAULT_THEME["card"], DEFAULT_THEME["card_hi"], DEFAULT_THEME["border"]
WHITE, GRAY, DIM = DEFAULT_THEME["text"], DEFAULT_THEME["text_dim"], DEFAULT_THEME["axis"]
BLUE, BLUE_DK = DEFAULT_THEME["daily_bar"], DEFAULT_THEME["daily_bar_dim"]
MODEL_COLORS = DEFAULT_THEME["models"]
TRACK = DEFAULT_THEME["track"]


def _rgb(v):
    """'#rrggbb' | (r,g,b) | [r,g,b] -> (r,g,b)."""
    if isinstance(v, str):
        s = v.lstrip("#")
        return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))
    return tuple(int(x) for x in v[:3])


def blend(a, b, t):
    return tuple(int(round(a[i] * (1 - t) + b[i] * t)) for i in range(3))


def heat_levels_for(color, empty):
    c = _rgb(color)
    return [blend(empty, c, t) for t in (0.3, 0.5, 0.75, 1.0)]


def resolve_theme(theme=None):
    t = {k: (list(v) if isinstance(v, list) else v) for k, v in DEFAULT_THEME.items()}
    for k, v in (theme or {}).items():
        if k not in DEFAULT_THEME:
            continue
        if k in ("heat_levels", "models"):
            t[k] = [_rgb(x) for x in v]
        else:
            t[k] = _rgb(v)
    return t


def fmt_tokens(n):
    for div, suf in ((1e9, "B"), (1e6, "M"), (1e3, "K")):
        if n >= div:
            v = n / div
            return (f"{v:.2f}" if v < 10 and suf == "B" else f"{v:.1f}") + suf
    return str(int(n))

def fmt_rate(bps):
    for div, suf in ((1e9, "GB/s"), (1e6, "MB/s"), (1e3, "KB/s")):
        if bps >= div:
            v = bps / div
            return (f"{v:.1f}" if v < 100 else f"{v:.0f}"), suf
    return f"{bps:.0f}", "B/s"

# Static layers depend only on theme colours / geometry; cache them per key.
_bg_cache = {}
_card_cache = {}
_CACHE_MAX = 64


def _cache_put(cache, key, value):
    if len(cache) >= _CACHE_MAX:
        cache.clear()
    cache[key] = value
    return value


def _background(top, bot):
    key = (top, bot)
    img = _bg_cache.get(key)
    if img is None:
        img = Image.new("RGB", (W * SS, H * SS), bot)
        d = ImageDraw.Draw(img)
        for y in range(H * SS):
            t = y / (H * SS)
            d.line([(0, y), (W * SS, y)], fill=tuple(int(top[i] * (1 - t) + bot[i] * t) for i in range(3)))
        _cache_put(_bg_cache, key, img)
    return img


class _Ctx:
    def __init__(self, theme):
        self.th = th = theme
        self.img = _background(th["bg_top"], th["bg_bot"]).copy()
        self.d = ImageDraw.Draw(self.img)

    def s(self, *v):
        return [int(round(x * SS)) for x in v]

    def card(self, x, y, w, h, r=14):
        # glassy card: subtle top highlight gradient + border
        CARD, CARD_HI, BORDER = self.th["card"], self.th["card_hi"], self.th["border"]
        size = (int(w * SS), int(h * SS))
        key = (size, r, CARD, CARD_HI)
        cached = _card_cache.get(key)
        if cached is None:
            layer = Image.new("RGB", size, CARD)
            ld = ImageDraw.Draw(layer)
            gh = int(h * SS * 0.45)
            for i in range(gh):
                t = 1 - i / gh
                c = tuple(int(CARD[k] + (CARD_HI[k] - CARD[k]) * t * 0.6) for k in range(3))
                ld.line([(0, i), (w * SS, i)], fill=c)
            mask = Image.new("L", size, 0)
            ImageDraw.Draw(mask).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], r * SS, fill=255)
            cached = _cache_put(_card_cache, key, (layer, mask))
        layer, mask = cached
        self.img.paste(layer, (int(x * SS), int(y * SS)), mask)
        self.d.rounded_rectangle(self.s(x, y, x + w, y + h), r * SS, outline=BORDER, width=SS)

    def text(self, xy, txt, size, color=None, weight="Regular", anchor="la"):
        color = self.th["text"] if color is None else color
        self.d.text(self.s(*xy), txt, font=font(size, weight), fill=color, anchor=anchor)

    def tw(self, txt, size, weight="Regular"):
        return font(size, weight).getlength(txt) / SS

    def bars(self, x, y, w, h, vals, gap=2, hi_last=True, color=None, dim=None, radius=1.5, hi=None):
        color = self.th["daily_bar"] if color is None else color
        dim = self.th["daily_bar_dim"] if dim is None else dim
        hi = self.th["daily_bar_hi"] if hi is None else hi
        if not vals:
            return
        n = len(vals)
        mx = max(vals) or 1
        bw = (w - gap * (n - 1)) / n
        for i, v in enumerate(vals):
            bh = max(1.5, h * v / mx) if v > 0 else 1
            bx = x + i * (bw + gap)
            last = hi_last and i == n - 1
            top = hi if last else color
            self._vbar(bx, y + h - bh, bw, bh, top, dim if not last else color, radius)

    def _vbar(self, x, y, w, h, top, bot, radius):
        X0, Y0, X1, Y1 = self.s(x, y, x + w, y + h)
        if X1 <= X0 or Y1 <= Y0:
            return
        layer = Image.new("RGB", (X1 - X0, Y1 - Y0))
        ld = ImageDraw.Draw(layer)
        for i in range(Y1 - Y0):
            t = i / max(1, Y1 - Y0 - 1)
            ld.line([(0, i), (X1 - X0, i)], fill=tuple(int(top[k] * (1 - t) + bot[k] * t) for k in range(3)))
        mask = Image.new("L", layer.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, layer.size[0] - 1, layer.size[1] - 1], int(radius * SS), fill=255)
        self.img.paste(layer, (X0, Y0), mask)

    def spark(self, x, y, w, h, vals, color=None, vmax=None):
        color = self.th["cpu"] if color is None else color
        CARD = self.th["card"]
        if len(vals) < 2:
            return
        mx = vmax if vmax else (max(vals) or 1)
        mn = 0
        pts = [(x + w * i / (len(vals) - 1), y + h - h * (min(v, mx) - mn) / (mx - mn or 1)) for i, v in enumerate(vals)]
        # gradient fill under the line
        X0, Y0, X1, Y1 = self.s(x, y, x + w, y + h)
        fill = Image.new("RGB", (X1 - X0, Y1 - Y0))
        fd = ImageDraw.Draw(fill)
        for i in range(Y1 - Y0):
            t = i / max(1, Y1 - Y0 - 1)
            a = 0.55 * (1 - t)
            fd.line([(0, i), (X1 - X0, i)], fill=tuple(int(CARD[k] * (1 - a) + color[k] * a) for k in range(3)))
        mask = Image.new("L", fill.size, 0)
        poly = [((px - x) * SS, (py - y) * SS) for px, py in pts] + [(w * SS, h * SS), (0, h * SS)]
        ImageDraw.Draw(mask).polygon(poly, fill=255)
        self.img.paste(fill, (X0, Y0), mask)
        self.d.line([tuple(self.s(px, py)) for px, py in pts], fill=color, width=int(1.8 * SS), joint="curve")

    def hbar(self, x, y, w, h, frac, color):
        self.d.rounded_rectangle(self.s(x, y, x + w, y + h), h * SS / 2, fill=self.th["track"])
        if frac > 0:
            self.d.rounded_rectangle(self.s(x, y, x + max(h, w * min(1, frac)), y + h), h * SS / 2, fill=color)


def _metric_card(c, x, y, w, h, label, value, unit, sub, series, color=None, vmax=None):
    GRAY, WHITE = c.th["text_dim"], c.th["text"]
    c.card(x, y, w, h, r=12)
    c.text((x + 12, y + 9), label, 14, GRAY, "SemiBold")
    if sub:
        c.text((x + w - 12, y + 9), sub, 14, GRAY, "Medium", anchor="ra")
    c.text((x + 12, y + 27), value, 28, WHITE, "Bold")
    c.text((x + 14 + c.tw(value, 28, "Bold"), y + 39), unit, 15, GRAY, "SemiBold")
    c.spark(x + 1, y + h - 30, w - 2, 24, series, color, vmax)


HEAT_EMPTY = DEFAULT_THEME["heat_empty"]
HEAT_LEVELS = DEFAULT_THEME["heat_levels"]

def _heatmap(c, x, y, w, t, cell=10, gap=2):
    HEAT_EMPTY, HEAT_LEVELS, WHITE = c.th["heat_empty"], c.th["heat_levels"], c.th["today_ring"]
    daily = dict(t.get("heat", []))
    today = dt.date.fromisoformat(t["days"][-1][0]) if t.get("days") else dt.date.today()
    ncol = int((w + gap) // (cell + gap))
    x += (w - (ncol * (cell + gap) - gap)) / 2  # center
    start = today - dt.timedelta(days=today.weekday()) - dt.timedelta(weeks=ncol - 1)
    vals = [v for v in daily.values() if v > 0]
    mx = max(vals) if vals else 1
    for col in range(ncol):
        for row in range(7):
            d = start + dt.timedelta(weeks=col, days=row)
            if d > today:
                continue
            v = daily.get(d.isoformat(), 0)
            if v <= 0:
                fill = HEAT_EMPTY
            else:
                f = (v / mx) ** 0.6  # compress so mid days stay visible
                fill = HEAT_LEVELS[min(3, int(f * 4))]
            cx, cy = x + col * (cell + gap), y + row * (cell + gap)
            c.d.rounded_rectangle(c.s(cx, cy, cx + cell, cy + cell), 2 * SS, fill=fill)
            if d == today:
                c.d.rounded_rectangle(c.s(cx - 1, cy - 1, cx + cell + 1, cy + cell + 1), 3 * SS, outline=WHITE, width=int(1.5 * SS))


def grok_bot_cache_path():
    return os.path.join(os.path.expanduser("~"), ".tokentracker", "tracker", "cursor-usage-limits-cache.json")


def grok_bot_view(window, now):
    """Weekly Grok Bot window -> used percent, remaining-time percent, and 'N d N h'."""
    if not isinstance(window, dict) or now is None:
        return None
    try:
        used = float(window.get("used_percent"))
    except (TypeError, ValueError):
        return None
    if used != used or used < 0 or used > 100:
        return None
    raw_reset = window.get("reset_at")
    if not isinstance(raw_reset, str) or not raw_reset.strip():
        return None
    try:
        reset = dt.datetime.fromisoformat(raw_reset.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if reset.tzinfo is None:
        reset = reset.replace(tzinfo=dt.timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=TZ)
    remain = (reset - now).total_seconds()
    if remain <= 0:
        return None
    try:
        window_s = float(window.get("limit_window_seconds"))
    except (TypeError, ValueError):
        window_s = 0
    if window_s <= 0:
        window_s = 7 * 24 * 3600
    # Hours only. The label is time left; the tick is time already passed, so it grows right.
    remain_hours = int(remain // 3600)
    window_hours = max(1, int(round(window_s / 3600.0)))
    remain_hours = min(window_hours, remain_hours)
    elapsed_hours = window_hours - remain_hours
    days, hours = divmod(remain_hours, 24)
    return {
        "used_percent": used,
        "remain_hours": remain_hours,
        "elapsed_hours": elapsed_hours,
        "window_hours": window_hours,
        "remain_percent": 100.0 * remain_hours / window_hours,
        "elapsed_percent": 100.0 * elapsed_hours / window_hours,
        "remain_label": f"{days} d {hours} h",
    }


def load_grok_bot_view(path=None, now=None):
    path = path or grok_bot_cache_path()
    now = now or dt.datetime.now(dt.timezone.utc)
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError, UnicodeError):
        return None
    cursor = data.get("cursor") if isinstance(data, dict) else None
    window = cursor.get("quaternary_window") if isinstance(cursor, dict) else None
    return grok_bot_view(window, now)


def _attach_grok_bot(token_stats):
    stats = dict(token_stats or {})
    if "grok_bot" not in stats:
        stats["grok_bot"] = load_grok_bot_view()
    return stats


def _today_weekly_bounds():
    """Right column: TODAY card above a separate WEEKLY card."""
    gap, weekly_h = 8, 64
    top = 8
    total = H - 16
    today_h = total - gap - weekly_h
    return top, today_h, top + today_h + gap, weekly_h


def _weekly_tick(view):
    if not view:
        return 0, None
    frac = max(0.0, min(1.0, view["used_percent"] / 100.0))
    if view.get("window_hours"):
        elapsed = view.get("elapsed_hours")
        if elapsed is None:
            elapsed = view["window_hours"] - view.get("remain_hours", 0)
        tick = elapsed / view["window_hours"]
    else:
        tick = 1 - view.get("remain_percent", 0) / 100.0
    return frac, max(0.0, min(1.0, tick))


def _draw_weekly_card(c, view, x, y, w, h):
    """WEEKLY and the remaining time share one baseline. The percent stays at the TODAY figure size."""
    c.card(x, y, w, h, r=14)
    pad = 14
    title_y = y + 12
    c.text((x + pad, title_y), "WEEKLY", 14, c.th["text_dim"], "SemiBold")
    pct = f"{view['used_percent']:.0f}%" if view else "—"
    pct_size = 34
    pct_box = font(pct_size, "Bold").getbbox(pct)
    ink_w = (pct_box[2] - min(0, pct_box[0])) / SS
    pct_h = (pct_box[3] - pct_box[1]) / SS
    pct_right = x + w - pad
    c.text((pct_right - pct_box[2] / SS, y + (h - pct_h) / 2), pct, pct_size, c.th["text"], "Bold", anchor="lt")
    bar_h = 12
    bar_x = x + pad
    bar_right = pct_right - ink_w - 8
    bar_w = max(40, bar_right - bar_x)
    bar_y = y + h - 12 - bar_h
    if view:
        ascent, _ = font(14, "SemiBold").getmetrics()
        c.text((bar_right, title_y + ascent / SS), view["remain_label"], 13, c.th["text_dim"], "Medium", anchor="rs")
    frac, tick = _weekly_tick(view)
    c.hbar(bar_x, bar_y, bar_w, bar_h, frac, c.th["weekly_bar"])
    if tick is None:
        return
    tx = bar_x + bar_w * tick
    mark = c.th["text"]
    c.d.line(c.s(tx, bar_y - 4, tx, bar_y + bar_h + 3), fill=mark, width=max(SS, int(1.6 * SS)))
    c.d.line(c.s(tx - 3.5, bar_y - 4, tx + 3.5, bar_y - 4), fill=mark, width=max(SS, int(1.6 * SS)))


def _draw_fixed_model_rows(c, t, x, y, w, *, count=3, row_height=42):
    colors = c.th["models"]
    total = t.get("today", 0) or 1
    models = (t.get("models") or [])[:count]
    if not models:
        c.text((x, y), "No model usage yet", 13, c.th["text_dim"], "Medium")
        return
    for i, (name, tokens) in enumerate(models):
        row_y = y + i * row_height
        color = colors[i % len(colors)]
        c.d.ellipse(c.s(x, row_y + 5, x + 8, row_y + 13), fill=color)
        pct = f"{100 * tokens / total:.0f}%"
        c.text((x + w, row_y), pct, 13, c.th["text_dim"], "SemiBold", anchor="ra")
        label = str(name)
        max_width = w - 48
        while c.tw(label, 14, "Medium") > max_width and len(label) > 4:
            label = label[:-2] + "…"
        c.text((x + 14, row_y), label, 14, c.th["text"], "Medium")
        c.hbar(x + 14, row_y + 18, w - 14, 4, tokens / total, color)


def _draw_model_rows(c, t, x, y, w, *, count=4, row_height=37):
    colors = c.th["models"]
    total = t.get("today", 0) or 1
    models = t.get("models", [])[:count]
    if not models:
        c.text((x, y), "No model usage yet", 13, c.th["text_dim"], "Medium")
        return
    for i, (name, tokens) in enumerate(models):
        row_y = y + i * row_height
        color = colors[i % len(colors)]
        c.d.ellipse(c.s(x, row_y + 5, x + 8, row_y + 13), fill=color)
        pct = f"{100 * tokens / total:.0f}%"
        c.text((x + w, row_y), pct, 13, c.th["text_dim"], "SemiBold", anchor="ra")
        label = str(name)
        max_width = w - 48
        while c.tw(label, 14, "Medium") > max_width and len(label) > 4:
            label = label[:-2] + "…"
        c.text((x + 14, row_y), label, 14, c.th["text"], "Medium")
        c.hbar(x + 14, row_y + 21, w - 14, 4, tokens / total, color)


def _system_values(metrics, th):
    up_v, up_u = fmt_rate(metrics["up_bps"])
    dl_v, dl_u = fmt_rate(metrics["dl_bps"])
    return [
        ("CPU", f"{metrics['cpu']:.0f}%", th["cpu"]),
        ("MEM", f"{metrics['mem']:.0f}%", th["mem"]),
        ("POWER", f"{metrics.get('power_w') or 0:.0f} W", th["power"]),
        ("TEMP", f"{metrics.get('temp_c') or 0:.0f}°C", th["temp"]),
        ("UP", f"{up_v} {up_u}", th["up"]),
        ("DOWN", f"{dl_v} {dl_u}", th["dl"]),
    ]


def _render_token_focus(metrics, t, th):
    c = _Ctx(th)
    m, gap = 8, 8
    left_x, left_w = m, 500
    right_x, right_w = left_x + left_w + gap, W - m - (left_x + left_w + gap)
    c.card(left_x, m, left_w, H - 2 * m)
    c.text((left_x + 16, 19), "TODAY · TOKEN USAGE", 14, th["text_dim"], "SemiBold")
    c.text((left_x + 16, 38), fmt_tokens(t.get("today", 0)), 55, th["text"], "Bold")
    c.text((left_x + 18, 105), f"7D  {fmt_tokens(t.get('total_7d', 0))}", 16, th["text_dim"], "Medium")
    c.text((left_x + 230, 105), f"30D  {fmt_tokens(t.get('total_30d', 0))}", 16, th["text_dim"], "Medium")
    c.text((left_x + 18, 137), "DAILY ACTIVITY", 12, th["axis"], "SemiBold")
    days = t.get("days", [])
    c.bars(left_x + 18, 155, left_w - 36, 57, [v for _, v in days], gap=2,
           color=th["daily_bar"], dim=th["daily_bar_dim"], hi=th["daily_bar_hi"])
    _heatmap(c, left_x + 18, 229, left_w - 36, t, cell=9, gap=2)

    c.card(right_x, m, right_w, H - 2 * m)
    c.text((right_x + 14, 19), "TODAY BY MODEL", 13, th["text_dim"], "SemiBold")
    _draw_model_rows(c, t, right_x + 14, 42, right_w - 28, count=4, row_height=35)
    c.d.line(c.s(right_x + 14, 190, right_x + right_w - 14, 190), fill=th["border"], width=SS)
    values = _system_values(metrics, th)
    for i, (label, value, color) in enumerate(values):
        col, row = i % 2, i // 2
        x = right_x + 14 + col * (right_w / 2)
        y = 204 + row * 32
        c.d.ellipse(c.s(x, y + 5, x + 7, y + 12), fill=color)
        c.text((x + 12, y), label, 11, th["axis"], "SemiBold")
        c.text((x + 12, y + 12), value, 13, th["text"], "SemiBold")
    return c.img.resize((W, H), Image.LANCZOS)


def _render_system_first(metrics, t, th):
    c = _Ctx(th)
    m, gap = 8, 8
    left_x, left_w = m, 620
    right_x, right_w = left_x + left_w + gap, W - m - (left_x + left_w + gap)
    c.card(left_x, m, left_w, H - 2 * m)
    c.text((left_x + 14, 16), "SYSTEM STATUS", 13, th["text_dim"], "SemiBold")
    values = _system_values(metrics, th)
    series = [metrics["cpu_hist"], metrics["mem_hist"], metrics["power_hist"],
              metrics["temp_hist"], metrics["up_hist"], metrics["dl_hist"]]
    vmax = [100, 100, None, 100, None, None]
    card_gap, card_w, card_h = 8, (left_w - 28 - 2 * 8) / 3, 112
    for i, ((label, value, color), hist) in enumerate(zip(values, series)):
        col, row = i % 3, i // 3
        x, y = left_x + 14 + col * (card_w + card_gap), 39 + row * (card_h + 8)
        c.card(x, y, card_w, card_h, r=10)
        c.text((x + 10, y + 9), label, 12, th["text_dim"], "SemiBold")
        c.text((x + 10, y + 28), value, 23, th["text"], "Bold")
        c.spark(x + 9, y + 68, card_w - 18, 32, hist, color, vmax[i])

    top, today_h, weekly_y, weekly_h = _today_weekly_bounds()
    c.card(right_x, top, right_w, today_h)
    c.text((right_x + 14, 16), "TODAY", 13, th["text_dim"], "SemiBold")
    c.text((right_x + 14, 34), fmt_tokens(t.get("today", 0)), 34, th["text"], "Bold")
    c.text((right_x + 14, 78), f"7D  {fmt_tokens(t.get('total_7d', 0))}", 14, th["text_dim"], "Medium")
    c.text((right_x + 14, 98), f"30D  {fmt_tokens(t.get('total_30d', 0))}", 14, th["text_dim"], "Medium")
    c.text((right_x + 14, 122), "TOP MODELS", 12, th["text_dim"], "SemiBold")
    _draw_fixed_model_rows(c, t, right_x + 14, 140, right_w - 28, count=3, row_height=36)
    _draw_weekly_card(c, t.get("grok_bot"), right_x, weekly_y, right_w, weekly_h)
    return c.img.resize((W, H), Image.LANCZOS)


def _pulse_color(color, th):
    # The one-second renderer cadence gives the live indicator a restrained pulse.
    import math
    wave = (1 + math.sin(dt.datetime.now().timestamp() * 3.2)) / 2
    return blend(th["card_hi"], color, 0.55 + wave * 0.45)


def _live_mark(c, x, y, color):
    pulse = _pulse_color(color, c.th)
    c.d.ellipse(c.s(x, y, x + 7, y + 7), fill=pulse)
    c.d.ellipse(c.s(x - 3, y - 3, x + 10, y + 10), outline=blend(c.th["card"], pulse, 0.45), width=SS)


def _system_chip(c, x, y, w, h, item, history=None, *, style="spark", sub=None):
    label, value, color = item
    c.card(x, y, w, h, r=9 if style == "spark" else 14)
    c.d.rounded_rectangle(c.s(x + 1, y + 1, x + 5, y + h - 1), 2 * SS, fill=color)
    c.text((x + 12, y + 7), label, 10 if style == "rail" else 11, c.th["text_dim"], "SemiBold")
    c.text((x + 12, y + 21), value, 18 if style == "rail" else (16 if sub else 20), c.th["text"], "Bold")
    if sub:
        c.text((x + 12, y + h - 12), sub, 8, c.th["text_dim"], "Medium")
    if style == "spark" and history:
        c.spark(x + w - 51, y + 12, 40, h - 22, history, color)
    elif style == "rail":
        numeric = None
        for suffix in ("%", " W", "°C"):
            if value.endswith(suffix):
                try:
                    numeric = float(value[:-len(suffix)])
                except ValueError:
                    pass
                break
        if label == "MEM":
            numeric = float(value.rstrip("%"))
        if numeric is not None:
            c.hbar(x + 12, y + h - 10, w - 24, 3, numeric / 100, color)
        elif history:
            c.spark(x + 12, y + h - 20, w - 24, 12, history, color)


def _system_row(c, x, y, w, item, history=None):
    label, value, color = item
    c.d.rounded_rectangle(c.s(x, y + 1, x + 3, y + 19), 1.5 * SS, fill=color)
    # Minimal line icons keep each metric recognizable at this small scale.
    cx, cy = x + 13, y + 10
    if label == "CPU":
        c.d.rounded_rectangle(c.s(cx - 5, cy - 5, cx + 5, cy + 5), 2 * SS, outline=color, width=SS)
        for k in (-3, 0, 3):
            c.d.line(c.s(cx + k, cy - 8, cx + k, cy - 5), fill=color, width=SS)
            c.d.line(c.s(cx + k, cy + 5, cx + k, cy + 8), fill=color, width=SS)
    elif label == "MEM":
        c.d.rounded_rectangle(c.s(cx - 7, cy - 4, cx + 7, cy + 4), 2 * SS, outline=color, width=SS)
        for k in (-4, 0, 4):
            c.d.line(c.s(cx + k, cy - 2, cx + k, cy + 2), fill=color, width=SS)
    elif label == "POWER":
        c.d.line(c.s(cx + 1, cy - 8, cx - 4, cy + 1, cx + 1, cy + 1, cx - 1, cy + 8), fill=color, width=2 * SS, joint="curve")
    elif label == "TEMP":
        c.d.rounded_rectangle(c.s(cx - 2, cy - 8, cx + 2, cy + 3), 2 * SS, outline=color, width=SS)
        c.d.ellipse(c.s(cx - 4, cy + 1, cx + 4, cy + 9), fill=color)
    else:
        up = label == "UP"
        end_y = cy - 6 if up else cy + 6
        c.d.line(c.s(cx, cy + (5 if up else -5), cx, end_y), fill=color, width=2 * SS)
        c.d.line(c.s(cx - 4, end_y + (4 if up else -4), cx, end_y, cx + 4, end_y + (4 if up else -4)), fill=color, width=2 * SS, joint="curve")
    c.text((x + 27, y + 1), value, 14, c.th["text"], "SemiBold")
    if history:
        c.spark(x + w - 62, y + 2, 55, 16, history, color)


def _draw_usage_summary(c, t, x, y, w, h, *, style="orbit"):
    c.card(x, y, w, h, r=12 if style == "orbit" else 20)
    color = c.th["daily_bar"]
    _live_mark(c, x + 15, y + 15, color)
    c.text((x + 27, y + 9), "TODAY", 11, c.th["text_dim"], "SemiBold")
    today = fmt_tokens(t.get("today", 0))
    c.text((x + 12, y + 26), today, 33 if w > 260 else 29, c.th["text"], "Bold")
    y0 = y + (67 if h > 230 else 62)
    gap = 8
    values = [("7 DAYS", t.get("total_7d", 0)), ("30 DAYS", t.get("total_30d", 0))]
    tile_w = (w - 24 - gap) / 2
    for i, (label, total) in enumerate(values):
        tx = x + 12 + i * (tile_w + gap)
        c.d.rounded_rectangle(c.s(tx, y0, tx + tile_w, y0 + 42), 7 * SS, fill=c.th["card_hi"])
        c.text((tx + 8, y0 + 5), label, 9, c.th["text_dim"], "SemiBold")
        c.text((tx + 8, y0 + 18), fmt_tokens(total), 17, c.th["text"], "Bold")
    active = t.get("active_days", 0)
    first = t.get("first_date")
    since = first[5:].replace("-", "/") if first else "—"
    c.text((x + 12, y0 + 49), f"ALL  {fmt_tokens(t.get('total_all', 0))}", 12, c.th["text"], "SemiBold")
    c.text((x + w - 12, y0 + 49), f"{active} days · {since}", 10, c.th["text_dim"], "Medium", anchor="ra")


def _draw_daily_panel(c, t, x, y, w, h, *, variant="bars"):
    c.text((x, y), "30-DAY ACTIVITY", 10, c.th["text_dim"], "SemiBold")
    days = t.get("days", [])
    avg = sum(v for _, v in days) / max(1, len(days))
    peak = max((v for _, v in days), default=0)
    c.text((x + w, y), f"AVG {fmt_tokens(avg)} · PEAK {fmt_tokens(peak)}", 8, c.th["text_dim"], "Medium", anchor="ra")
    if variant == "wave" and len(days) > 1:
        vals = [v for _, v in days]
        vmax = max(vals) or 1
        pts = [(x + w * i / (len(vals) - 1), y + 40 - 34 * v / vmax) for i, v in enumerate(vals)]
        c.spark(x, y + 6, w, 38, vals, c.th["daily_bar"], vmax)
        c.d.line([tuple(c.s(*p)) for p in pts], fill=c.th["daily_bar_hi"], width=2 * SS, joint="curve")
    else:
        c.bars(x, y + 8, w, 39, [v for _, v in days], gap=1.2,
               color=c.th["daily_bar"], dim=c.th["daily_bar_dim"], hi=c.th["daily_bar_hi"])


def _draw_hourly_panel(c, t, x, y, w, h, *, variant="bars"):
    c.text((x, y), "TODAY BY HOUR", 10, c.th["text_dim"], "SemiBold")
    hours = t.get("hours", [0] * 24)
    cur = min(23, max(0, int(t.get("current_hour", 23))))
    vals = hours[:cur + 1] + [0] * (23 - cur)
    top = y + 14
    chart_h = max(14, h - 28)
    if variant == "wave" and len(vals) > 1:
        mx = max(vals) or 1
        pts = [(x + w * i / (len(vals) - 1), top + chart_h - chart_h * v / mx) for i, v in enumerate(vals)]
        c.spark(x, top, w, chart_h, vals, c.th["hourly_bar"], mx)
        c.d.line([tuple(c.s(*p)) for p in pts], fill=c.th["hourly_bar"], width=2 * SS, joint="curve")
    else:
        c.bars(x, top, w, chart_h, vals, gap=1, hi_last=False,
               color=c.th["hourly_bar"], dim=c.th["hourly_bar_dim"])
    c.text((x, y + h - 11), "00", 8, c.th["axis"], "Medium")
    c.text((x + w / 2, y + h - 11), "12", 8, c.th["axis"], "Medium", anchor="ma")
    c.text((x + w, y + h - 11), "24", 8, c.th["axis"], "Medium", anchor="ra")


def _draw_model_panel(c, t, x, y, w, h, *, style="rows", count=4):
    c.card(x, y, w, h, r=12 if style == "rows" else 18)
    c.text((x + 12, y + 9), "TODAY BY MODEL", 10, c.th["text_dim"], "SemiBold")
    models = t.get("models", [])[:count]
    total = t.get("today", 0) or 1
    colors = c.th["models"]
    if not models:
        c.text((x + 12, y + 34), "No model usage yet", 12, c.th["text_dim"], "Medium")
        return
    row_h = min(36, max(25, (h - 32) / len(models)))
    top = y + 29
    for i, (name, tokens) in enumerate(models):
        row_y = top + i * row_h
        col = colors[i % len(colors)]
        label = str(name)
        max_width = w - 95
        while c.tw(label, 11, "Medium") > max_width and len(label) > 4:
            label = label[:-2] + "…"
        c.d.ellipse(c.s(x + 12, row_y + 3, x + 19, row_y + 10), fill=col)
        c.text((x + 24, row_y), label, 11, c.th["text"], "Medium")
        c.text((x + w - 12, row_y), f"{fmt_tokens(tokens)} · {tokens * 100 / total:.0f}%", 9, c.th["text_dim"], "SemiBold", anchor="ra")
        c.hbar(x + 12, row_y + 15, w - 24, 3, tokens / total, col)


def _render_constellation(metrics, t, th):
    c = _Ctx(th)
    m, gap, top_h, body_y, body_h = 8, 8, 54, 70, 242
    values = _system_values(metrics, th)
    histories = [metrics["cpu_hist"], metrics["mem_hist"], metrics["power_hist"],
                 metrics["temp_hist"], metrics["up_hist"], metrics["dl_hist"]]
    chip_gap = 6
    chip_w = (W - 2 * m - 5 * chip_gap) / 6
    for i, (item, hist) in enumerate(zip(values, histories)):
        sub = f"{metrics['mem_used_gb']:.1f}/{metrics['mem_total_gb']:.0f}G" if item[0] == "MEM" else None
        _system_chip(c, m + i * (chip_w + chip_gap), m, chip_w, top_h, item, hist, sub=sub)

    _draw_usage_summary(c, t, m, body_y, 300, body_h, style="orbit")
    x = m + 300 + gap
    w = 272
    c.card(x, body_y, w, body_h, r=12)
    _draw_daily_panel(c, t, x + 12, body_y + 10, w - 24, 55)
    _heatmap(c, x + 12, body_y + 73, w - 24, t, cell=6, gap=1)
    _draw_hourly_panel(c, t, x + 12, body_y + 137, w - 24, 83)
    _draw_model_panel(c, t, m + 300 + gap + w + gap, body_y, W - m - (m + 300 + gap + w + gap), body_h, style="orbit", count=5)
    return c.img.resize((W, H), Image.LANCZOS)


def _render_signal_wave(metrics, t, th):
    c = _Ctx(th)
    m, gap = 8, 8
    left_w, chart_w = 220, 420
    _draw_usage_summary(c, t, m, m, left_w, H - 2 * m, style="signal")
    charts_x = m + left_w + gap
    c.card(charts_x, m, chart_w, H - 2 * m, r=20)
    _live_mark(c, charts_x + 20, m + 19, th["hourly_bar"])
    c.text((charts_x + 33, m + 12), "TOKEN RHYTHM", 12, th["text_dim"], "SemiBold")
    _draw_daily_panel(c, t, charts_x + 16, m + 39, chart_w - 32, 60, variant="wave")
    _heatmap(c, charts_x + 16, m + 111, chart_w - 32, t, cell=6, gap=1)
    _draw_hourly_panel(c, t, charts_x + 16, m + 174, chart_w - 32, 52, variant="wave")

    right_x = charts_x + chart_w + gap
    right_w = W - m - right_x
    c.card(right_x, m, right_w, 104, r=20)
    c.text((right_x + 12, m + 7), "SYSTEM PULSE", 9, th["text_dim"], "SemiBold")
    values = _system_values(metrics, th)
    histories = [metrics["cpu_hist"], metrics["mem_hist"], metrics["power_hist"],
                 metrics["temp_hist"], metrics["up_hist"], metrics["dl_hist"]]
    # Six short level meters fit in a 2x3 grid, with rate sparklines for network.
    cell_w, cell_h = (right_w - 30) / 2, 24
    for i, (item, hist) in enumerate(zip(values, histories)):
        label, value, color = item
        gx = right_x + 12 + (i % 2) * (cell_w + 6)
        gy = m + 25 + (i // 2) * 24
        c.d.ellipse(c.s(gx, gy + 4, gx + 5, gy + 9), fill=color)
        c.text((gx + 9, gy), label, 8, th["text_dim"], "SemiBold")
        shown_value = value
        if label == "MEM":
            shown_value = f"{value} {metrics['mem_used_gb']:.1f}/{metrics['mem_total_gb']:.0f}G"
        c.text((gx + cell_w, gy), shown_value, 7 if label == "MEM" else 8, th["text"], "SemiBold", anchor="ra")
        if item[0] in ("UP", "DOWN"):
            c.spark(gx + 8, gy + 11, cell_w - 8, 9, hist, color)
        else:
            try:
                numeric = float(value.rstrip("% W°C"))
            except ValueError:
                numeric = 0
            scale = 100 if item[0] in ("CPU", "MEM", "TEMP") else 200
            c.hbar(gx + 8, gy + 14, cell_w - 8, 3, numeric / scale, color)
    _draw_model_panel(c, t, right_x, m + 112, right_w, H - 2 * m - 112, style="signal", count=5)
    return c.img.resize((W, H), Image.LANCZOS)


def _render_telemetry(metrics, t, th):
    c = _Ctx(th)
    m, gap = 8, 8
    left_w, center_w = 224, 404
    _draw_usage_summary(c, t, m, m, left_w, H - 2 * m, style="terminal")

    center_x = m + left_w + gap
    c.card(center_x, m, center_w, H - 2 * m, r=8)
    c.text((center_x + 12, m + 10), "ACTIVITY LOG · 30D", 10, th["text_dim"], "SemiBold")
    _draw_daily_panel(c, t, center_x + 12, m + 31, center_w - 24, 57)
    _heatmap(c, center_x + 12, m + 96, center_w - 24, t, cell=7, gap=1)
    _draw_hourly_panel(c, t, center_x + 12, m + 162, center_w - 24, 56)
    active = t.get("active_days", 0)
    first = t.get("first_date")
    since = first[5:].replace("-", "/") if first else "—"
    c.d.line(c.s(center_x + 12, m + 224, center_x + center_w - 12, m + 224), fill=th["border"], width=SS)
    c.text((center_x + 12, m + 230), f"{fmt_tokens(t.get('total_all', 0))} TOKENS  ·  {active} ACTIVE DAYS  ·  SINCE {since}", 8, th["text_dim"], "SemiBold")

    right_x = center_x + center_w + gap
    right_w = W - m - right_x
    c.card(right_x, m, right_w, H - 2 * m, r=8)
    _live_mark(c, right_x + 18, m + 19, th["up"])
    c.text((right_x + 31, m + 12), "LIVE TELEMETRY", 10, th["text_dim"], "SemiBold")
    values = _system_values(metrics, th)
    values = [
        (label, f"{value} {metrics['mem_used_gb']:.1f}/{metrics['mem_total_gb']:.0f}G", color)
        if label == "MEM" else (label, value, color)
        for label, value, color in values
    ]
    histories = [metrics["cpu_hist"], metrics["mem_hist"], metrics["power_hist"],
                 metrics["temp_hist"], metrics["up_hist"], metrics["dl_hist"]]
    for i, (item, hist) in enumerate(zip(values, histories)):
        _system_row(c, right_x + 12, m + 35 + i * 23, right_w - 24, item, hist)
    c.d.line(c.s(right_x + 12, m + 180, right_x + right_w - 12, m + 180), fill=th["border"], width=SS)
    c.text((right_x + 12, m + 187), "MODEL DISTRIBUTION", 9, th["text_dim"], "SemiBold")
    models = t.get("models", [])
    if models:
        total = t.get("today", 0) or 1
        colors = th["models"]
        x = right_x + 12
        bar_y = m + 204
        bar_w = right_w - 24
        cursor = x
        for i, (_, n) in enumerate(models):
            part = bar_w * n / total
            c.d.rectangle(c.s(cursor, bar_y, cursor + part, bar_y + 7), fill=colors[i % len(colors)])
            cursor += part
        row_x, row_w, row_top, row_h = right_x + 12, right_w - 24, m + 222, 17
        for i, (name, tokens) in enumerate(models[:5]):
            row_y = row_top + i * row_h
            col = th["models"][i % len(th["models"])]
            label = str(name)
            while c.tw(label, 8, "Medium") > row_w - 80 and len(label) > 4:
                label = label[:-2] + "…"
            c.d.ellipse(c.s(row_x, row_y + 2, row_x + 5, row_y + 7), fill=col)
            c.text((row_x + 8, row_y), label, 8, th["text"], "Medium")
            c.text((row_x + row_w, row_y), f"{fmt_tokens(tokens)} · {tokens * 100 / total:.0f}%", 8, th["text_dim"], "SemiBold", anchor="ra")
            c.hbar(row_x, row_y + 11, row_w, 2, tokens / total, col)
    else:
        c.text((right_x + 12, m + 205), "No model usage yet", 10, th["text_dim"], "Medium")
    return c.img.resize((W, H), Image.LANCZOS)


def render(metrics, token_stats, theme=None, layout="classic"):
    """metrics: cpu, cpu_hist, mem, mem_used_gb, mem_total_gb, mem_hist, power_w, power_hist,
    temp_c, temp_hist, up_bps, up_hist, dl_bps, dl_hist.
    token_stats: today, days(list of (date_str, tokens) oldest->newest, ~30), hours(24 ints),
    models(list of (name, tokens) sorted desc), total_7d, total_30d,
    heat(list of (date_str, tokens), full history), total_all, active_days, first_date."""
    th = resolve_theme(theme)
    token_stats = _attach_grok_bot(token_stats)
    if layout == "token-focus":
        return _render_token_focus(metrics, token_stats, th)
    if layout == "system-first":
        return _render_system_first(metrics, token_stats, th)
    if layout == "constellation":
        return _render_constellation(metrics, token_stats, th)
    if layout == "signal-wave":
        return _render_signal_wave(metrics, token_stats, th)
    if layout == "telemetry":
        return _render_telemetry(metrics, token_stats, th)
    c = _Ctx(th)
    WHITE, GRAY, DIM = th["text"], th["text_dim"], th["axis"]
    MODEL_COLORS = th["models"]
    M, G = 8, 8
    # ---- left: system metrics 2x3 grid ----
    lw = 296
    cw = (lw - G) / 2
    ch = (H - 2 * M - 2 * G) / 3
    m = metrics
    up_v, up_u = fmt_rate(m["up_bps"])
    dl_v, dl_u = fmt_rate(m["dl_bps"])
    def _num(v, fmt="{:.0f}"):
        return "—" if v is None else fmt.format(v)
    cards = [
        ("CPU", f"{m['cpu']:.0f}", "%", None, m["cpu_hist"], th["cpu"], 100),
        ("MEM", f"{m['mem']:.0f}", "%", f"{m['mem_used_gb']:.1f}/{m['mem_total_gb']:.0f}G", m["mem_hist"], th["mem"], 100),
        ("POWER", _num(m.get("power_w")), "W", None, m["power_hist"], th["power"], None),
        ("CPU TEMP", _num(m.get("temp_c")), "°C", None, m["temp_hist"], th["temp"], 100),
        ("UP", up_v, up_u, None, m["up_hist"], th["up"], None),
        ("DOWN", dl_v, dl_u, None, m["dl_hist"], th["dl"], None),
    ]
    for i, (lab, val, unit, sub, hist, col, vmax) in enumerate(cards):
        cx = M + (i % 2) * (cw + G)
        cy = M + (i // 2) * (ch + G)
        _metric_card(c, cx, cy, cw, ch, lab, val, unit, sub, hist, col, vmax)

    t = token_stats
    # ---- middle: trend (7d / 30d + 30-day bars) ----
    mx0 = M + lw + G
    mw = 300
    c.card(mx0, M, mw, H - 2 * M)
    c.text((mx0 + 14, M + 12), "7 DAYS", 14, GRAY, "SemiBold")
    c.text((mx0 + 14, M + 30), fmt_tokens(t["total_7d"]), 30, WHITE, "Bold")
    c.text((mx0 + 150, M + 12), "30 DAYS", 14, GRAY, "SemiBold")
    c.text((mx0 + 150, M + 30), fmt_tokens(t["total_30d"]), 30, WHITE, "Bold")
    days = t["days"]
    avg = sum(v for _, v in days) / max(1, len(days))
    c.text((mx0 + 14, M + 70), f"avg {fmt_tokens(avg)}/day", 14, GRAY, "Medium")
    peak = max(days, key=lambda kv: kv[1]) if days else ("", 0)
    c.text((mx0 + mw - 14, M + 70), f"peak {fmt_tokens(peak[1])}", 14, GRAY, "Medium", anchor="ra")
    bx, bw_ = mx0 + 14, mw - 28
    by, bh_ = M + 88, 72
    c.bars(bx, by, bw_, bh_, [v for _, v in days], gap=2)
    # heatmap: columns = weeks (Mon..Sun rows), ending with today's week
    _heatmap(c, bx, by + bh_ + 10, bw_, t)
    cap = f"{fmt_tokens(t.get('total_all', 0))} tokens · {t.get('active_days', 0)} active days"
    c.text((bx, H - M - 30), cap, 14, GRAY, "Medium")
    since = "since " + t["first_date"][5:].replace("-", "/") if t.get("first_date") else ""
    if since and c.tw(cap, 14, "Medium") + c.tw(since, 14, "Medium") + 16 <= bw_:
        c.text((bx + bw_, H - M - 30), since, 14, GRAY, "Medium", anchor="ra")

    # ---- right: today detail, with WEEKLY as its own card underneath ----
    rx0 = mx0 + mw + G
    rw = W - M - rx0
    _top, today_h, weekly_y, weekly_h = _today_weekly_bounds()
    c.card(rx0, M, rw, today_h)
    c.text((rx0 + 14, M + 12), "TODAY", 14, GRAY, "SemiBold")
    c.text((rx0 + 14, M + 30), fmt_tokens(t["today"]), 34, WHITE, "Bold")
    # hourly bars
    hx, hy, hw, hh = rx0 + 150, M + 16, rw - 164, 50
    hours = t["hours"]
    cur = t.get("current_hour", 23)
    c.bars(hx, hy, hw, hh, hours[:cur + 1] + [0] * (23 - cur), gap=1.5, hi_last=False,
           color=th["hourly_bar"], dim=th["hourly_bar_dim"])
    c.d.line(c.s(hx, hy + hh + 1, hx + hw, hy + hh + 1), fill=DIM, width=SS)
    for hr, anc in ((0, "la"), (12, "ma"), (23, "ra")):
        px = hx if hr == 0 else hx + hw if hr == 23 else hx + hw / 2
        c.text((px, hy + hh + 5), f"{hr:02d}h" if hr != 23 else "24h", 14, GRAY, "Medium", anchor=anc)
    # Up to three models at a fixed pitch. WEEKLY sits in the card below.
    _draw_fixed_model_rows(c, t, rx0 + 14, M + 96, rw - 28, count=3, row_height=46)
    _draw_weekly_card(c, t.get("grok_bot"), rx0, weekly_y, rw, weekly_h)

    return c.img.resize((W, H), Image.LANCZOS)


def _parse_ts(raw):
    s = raw.strip().replace("Z", "+00:00")
    try:
        ts = dt.datetime.fromisoformat(s)
    except ValueError:
        # Python 3.10 only accepts 3 or 6 fractional digits: drop them
        head, _, rest = s.partition(".")
        tz = rest[next((i for i, ch in enumerate(rest) if ch in "+-"), len(rest)):] if rest else ""
        ts = dt.datetime.fromisoformat(head + tz)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=TZ)
    return ts.astimezone(TZ)


def _parse_int(v):
    try:
        return int(float(str(v).replace(",", "").strip() or 0))
    except ValueError:
        return 0


def _aggregate(events, now=None, ndays=30):
    """events: (aware datetime, model name, token count). Dates are Asia/Shanghai."""
    daily = collections.Counter()
    hourly = collections.defaultdict(collections.Counter)
    models = collections.defaultdict(collections.Counter)
    for ts, model, n in events:
        daily[ts.date()] += n
        hourly[ts.date()][ts.hour] += n
        models[ts.date()][(model or "unknown").strip()] += n
    now = now or dt.datetime.now(TZ)
    if now.tzinfo is None:
        now = now.replace(tzinfo=TZ)
    now = now.astimezone(TZ)
    today = now.date()
    days = [today - dt.timedelta(days=i) for i in range(ndays - 1, -1, -1)]
    return {
        "today": daily[today],
        "days": [(d.isoformat(), daily[d]) for d in days],
        "hours": [hourly[today][h] for h in range(24)],
        "current_hour": now.hour,
        "models": [(k, v) for k, v in models[today].most_common() if v > 0],
        "total_7d": sum(daily[d] for d in days[-7:]),
        "total_30d": sum(daily[d] for d in days),
        # full history for the heatmap
        "heat": [(d.isoformat(), v) for d, v in sorted(daily.items())],
        "total_all": sum(daily.values()),
        "active_days": sum(1 for v in daily.values() if v > 0),
        "first_date": min(daily).isoformat() if daily else None,
    }


def token_stats_from_csv(path, now=None, ndays=30):
    """Aggregate a Cursor usage CSV (all rows incl. Free) by Asia/Shanghai date/hour.

    `now` defaults to the real current time, so a day with no usage yet shows 0
    for TODAY instead of repeating the last active day.
    """
    events = []
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for r in csv.DictReader(fh):
            raw = r.get("Date")
            if not raw:
                continue
            try:
                ts = _parse_ts(raw)
            except ValueError:
                continue
            events.append((ts, r.get("Model") or "unknown", _parse_int(r.get("Total Tokens"))))
    return _aggregate(events, now, ndays)


def iter_queue_events(path, source=None):
    """Yield (time, model, tokens) from TokenTracker's queue.jsonl.

    The file is append-only: a later row with the same source, model and
    hour_start replaces the earlier one. Cursor rows with billable_total_tokens
    below total_tokens are healed up to the total (TokenTracker issue #106).

    source=None (the default) yields EVERY source: TokenTracker's dashboard
    counts all of them, and its merged-usage.jsonl view — queue rows plus the
    billing export — must match. Pass a source name to filter.
    """
    latest = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if source is not None and (row.get("source") or "") != source:
                continue
            if not row.get("hour_start"):
                continue
            key = (row.get("source") or "", row.get("model") or "", row.get("hour_start"))
            latest[key] = row
    for row in latest.values():
        try:
            ts = _parse_ts(row["hour_start"])
        except ValueError:
            continue
        total = _parse_int(row.get("total_tokens"))
        billable = _parse_int(row.get("billable_total_tokens"))
        n = max(total, billable)
        if n <= 0:
            continue
        yield ts, row.get("model") or "unknown", n


def token_stats_from_queue(path, now=None, ndays=30, source=None):
    """Aggregate TokenTracker's queue.jsonl the way its dashboard does (all sources)."""
    return _aggregate(list(iter_queue_events(path, source)), now, ndays)


def placeholder_metrics():
    import math, random
    rnd = random.Random(7)
    def series(base, amp, n=40, lo=0):
        return [max(lo, base + amp * math.sin(i / 4) + rnd.uniform(-amp, amp) * 0.6) for i in range(n)]
    return {
        "cpu": 23, "cpu_hist": series(22, 10),
        "mem": 41, "mem_used_gb": 26.3, "mem_total_gb": 64, "mem_hist": series(41, 2),
        "power_w": 86, "power_hist": series(85, 20),
        "temp_c": 54, "temp_hist": series(54, 5),
        "up_bps": 1.2e6, "up_hist": series(1.2e6, 8e5),
        "dl_bps": 38.4e6, "dl_hist": series(30e6, 20e6),
    }


if __name__ == "__main__":
    import sys
    stats = token_stats_from_csv(sys.argv[1])
    img = render(placeholder_metrics(), stats)
    out = sys.argv[2] if len(sys.argv) > 2 else "preview.png"
    img.save(out)
    img.resize((W * 2, H * 2), Image.NEAREST).save(out.replace(".png", "_2x.png"))
    print(stats["today"], stats["total_7d"], stats["total_30d"], stats["current_hour"])

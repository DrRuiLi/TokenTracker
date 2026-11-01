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


def render(metrics, token_stats, theme=None):
    """metrics: cpu, cpu_hist, mem, mem_used_gb, mem_total_gb, mem_hist, power_w, power_hist,
    temp_c, temp_hist, up_bps, up_hist, dl_bps, dl_hist.
    token_stats: today, days(list of (date_str, tokens) oldest->newest, ~30), hours(24 ints),
    models(list of (name, tokens) sorted desc), total_7d, total_30d,
    heat(list of (date_str, tokens), full history), total_all, active_days, first_date."""
    th = resolve_theme(theme)
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

    # ---- right: today detail ----
    rx0 = mx0 + mw + G
    rw = W - M - rx0
    c.card(rx0, M, rw, H - 2 * M)
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
    # models
    models = t["models"][:4]
    total = t["today"] or 1
    top = M + 98
    rowh = (H - M - 12 - top) / max(1, len(models))
    for i, (name, n) in enumerate(models):
        y = top + i * rowh
        col = MODEL_COLORS[i % len(MODEL_COLORS)]
        c.d.ellipse(c.s(rx0 + 14, y + 5, rx0 + 22, y + 13), fill=col)
        pct = f"{100 * n / total:.0f}%"
        pw = 40
        c.text((rx0 + rw - 14, y), pct, 14, GRAY, "SemiBold", anchor="ra")
        c.text((rx0 + rw - 14 - pw, y), fmt_tokens(n), 15, WHITE, "SemiBold", anchor="ra")
        maxname = rw - 28 - 14 - pw - 60
        nm = name
        while c.tw(nm, 15, "Medium") > maxname and len(nm) > 4:
            nm = nm[:-2] + "…" if not nm.endswith("…") else nm[:-2] + "…"
        c.text((rx0 + 28, y), nm, 15, WHITE, "Medium")
        c.hbar(rx0 + 14, y + 23, rw - 28, 4, n / total, col)

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


def iter_queue_events(path, source="cursor"):
    """Yield (time, model, tokens) from TokenTracker's queue.jsonl.

    The file is append-only: a later row with the same source, model and
    hour_start replaces the earlier one. Cursor rows with billable_total_tokens
    below total_tokens are healed up to the total (TokenTracker issue #106).
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
            if (row.get("source") or "") != source or not row.get("hour_start"):
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


def token_stats_from_queue(path, now=None, ndays=30, source="cursor"):
    """Aggregate TokenTracker's queue.jsonl the way its dashboard does."""
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

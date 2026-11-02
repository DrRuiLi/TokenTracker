"""Ready-made theme presets for the side-screen dashboard.

Each preset is a small override dict on top of DEFAULT_THEME; derived shades
(daily_bar_dim/_hi, hourly_bar_dim, heat_levels) are recomputed the same way
theme_edit.set_color does for a single picked colour. ``theme_preset`` in the
saved settings is always re-derived from the actual theme dict, so a hand-
edited settings.json still reports the right state ("custom" when nothing
matches).
"""
from __future__ import annotations

from typing import Any, Dict, List

from render import DEFAULT_THEME
from theme_edit import set_color

# Presets that the renderer treats as "not a preset".
CUSTOM = "custom"

# Settings key values must be valid theme keys of DEFAULT_THEME. Virtual keys
# ("heatmap" for the hot end of heat_levels) are derived via set_color below.
_PRESET_OVERRIDES: Dict[str, Dict[str, Any]] = {
    # 深空蓝: exactly the shipped default look.
    "deep-space": {},
    # 浅色: light panels on a pale background, dark text.
    "light": {
        "bg_top": "#f0f3f8", "bg_bot": "#dfe4ec",
        "card": "#ffffff", "card_hi": "#f3f6fa", "border": "#cbd2de",
        "text": "#1a1d24", "text_dim": "#5c6370", "axis": "#a0a6b4",
        "track": "#d8dde6",
        "cpu": "#1e64d0", "mem": "#7a4fd0", "power": "#d08020",
        "temp": "#d04040", "up": "#10a080", "dl": "#1e64d0",
        "daily_bar": "#2563eb", "hourly_bar": "#2563eb",
        "heat_empty": "#e2e7f0", "heatmap": "#2563eb",
        "today_ring": "#1a1d24",
        "models": ["#2563eb", "#7a4fd0", "#10a080", "#d08020"],
    },
    # 极光青: near-black teal with cyan accents.
    "aurora": {
        "bg_top": "#071e26", "bg_bot": "#041016",
        "card": "#0a2630", "card_hi": "#103846", "border": "#1d5263",
        "text": "#eafcfd", "text_dim": "#88b3bd", "axis": "#2a5563",
        "track": "#12333d",
        "cpu": "#22d3ee", "mem": "#a78bfa", "power": "#fbbf24",
        "temp": "#fb7185", "up": "#34d399", "dl": "#38bdf8",
        "daily_bar": "#2dd4bf", "hourly_bar": "#22d3ee",
        "heat_empty": "#0e2c35", "heatmap": "#22d3ee",
        "today_ring": "#eafcfd",
        "models": ["#22d3ee", "#a78bfa", "#34d399", "#fb7185"],
    },
    # 熔岩橙: warm near-black with orange/red heat.
    "lava": {
        "bg_top": "#1e0f08", "bg_bot": "#100703",
        "card": "#291509", "card_hi": "#3a1e0d", "border": "#5e3317",
        "text": "#fff4ec", "text_dim": "#c0a48f", "axis": "#6b4a33",
        "track": "#3a2412",
        "cpu": "#fb923c", "mem": "#f472b6", "power": "#facc15",
        "temp": "#ef4444", "up": "#4ade80", "dl": "#38bdf8",
        "daily_bar": "#f97316", "hourly_bar": "#fb923c",
        "heat_empty": "#2e1a0c", "heatmap": "#f97316",
        "today_ring": "#fff4ec",
        "models": ["#f97316", "#facc15", "#ef4444", "#a3e635"],
    },
    # 紫罗兰: deep violet with purple accents.
    "violet": {
        "bg_top": "#150e26", "bg_bot": "#0b0716",
        "card": "#1d1436", "card_hi": "#2a1e4d", "border": "#463376",
        "text": "#f4f0ff", "text_dim": "#a99fca", "axis": "#55487e",
        "track": "#2b2148",
        "cpu": "#818cf8", "mem": "#c084fc", "power": "#fbbf24",
        "temp": "#f472b6", "up": "#34d399", "dl": "#60a5fa",
        "daily_bar": "#8b5cf6", "hourly_bar": "#a78bfa",
        "heat_empty": "#251a44", "heatmap": "#a78bfa",
        "today_ring": "#f4f0ff",
        "models": ["#8b5cf6", "#c084fc", "#34d399", "#fbbf24"],
    },
}

# UI order plus the controls-page metadata: Chinese label + one representative
# swatch colour (Chinese here mirrors the close_actions meta labels).
_PRESETS: List[Dict[str, str]] = [
    {"id": "deep-space", "label": "深空蓝", "swatch": "#1e90ff"},
    {"id": "light", "label": "浅色", "swatch": "#2563eb"},
    {"id": "aurora", "label": "极光青", "swatch": "#22d3ee"},
    {"id": "lava", "label": "熔岩橙", "swatch": "#f97316"},
    {"id": "violet", "label": "紫罗兰", "swatch": "#8b5cf6"},
]

PRESET_IDS = frozenset(_PRESET_OVERRIDES)

# Keys whose companions are derived, applied last via set_color.
_DERIVED_KEYS = ("daily_bar", "hourly_bar", "heat_empty", "heatmap")


def _hex(c) -> str:
    return "#{:02x}{:02x}{:02x}".format(*[int(x) for x in c[:3]])


def default_theme_hex() -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for k, v in DEFAULT_THEME.items():
        out[k] = [_hex(x) for x in v] if k in ("heat_levels", "models") else _hex(v)
    return out


def preset_theme(pid: str) -> Dict[str, Any]:
    """Full theme dict (hex strings) for one preset id, raises KeyError."""
    overrides = _PRESET_OVERRIDES[pid]
    theme = default_theme_hex()
    for k, v in overrides.items():
        if k in _DERIVED_KEYS:
            continue
        if k == "models":
            theme["models"] = [c.lower() for c in v]
        else:
            theme[k] = v
    for k in _DERIVED_KEYS:
        if k in overrides:
            set_color(theme, k, overrides[k])
    return theme


def theme_preset_for(theme: Dict[str, Any]) -> str:
    """Preset id whose theme equals ``theme``, else ``custom``."""
    if not isinstance(theme, dict):
        return CUSTOM
    for entry in _PRESETS:
        if preset_theme(entry["id"]) == theme:
            return entry["id"]
    return CUSTOM


def presets_meta() -> List[Dict[str, str]]:
    """[{id, label, swatch}] for the controls page, in UI order."""
    return [dict(entry) for entry in _PRESETS]

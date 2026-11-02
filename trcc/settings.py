"""Persisted user settings: %LOCALAPPDATA%\\trcc-token-dash\\settings.json."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

from theme_presets import default_theme_hex, theme_preset_for

ROTATIONS = (0, 90, 180, 270)
CLOSE_ACTIONS = ("ask", "tray", "exit")
DEFAULT_API_PORT = 17691


DEFAULTS: Dict[str, Any] = {
    "rotation": 0,          # clockwise degrees; 0 is upright on HydroNous R1 (PM=17 SUB=5)
    "mirror": False,
    "render_interval": 1.0,  # seconds between re-renders
    "sensor_interval": 2.0,  # seconds between CPU temp / power samples
    "layout": "classic",
    "serial": "181104191B22C003",
    "autostart": True,       # start pushing when the window opens
    "close_action": "ask",   # window close button: ask / tray (keep pushing) / exit
    "api_port": DEFAULT_API_PORT,  # 127.0.0.1 control API used by the TokenTracker page; 0 = off
    "theme": default_theme_hex(),
    "theme_preset": "deep-space",  # re-derived from theme by _sanitize
}


def settings_dir() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME") or (Path.home() / ".config"))
    d = base / "trcc-token-dash"
    d.mkdir(parents=True, exist_ok=True)
    return d


def settings_path() -> Path:
    return settings_dir() / "settings.json"


def defaults() -> Dict[str, Any]:
    return copy.deepcopy(DEFAULTS)


def _sanitize(data: Dict[str, Any]) -> Dict[str, Any]:
    s = defaults()
    if not isinstance(data, dict):
        return s
    for k in ("mirror", "autostart"):
        if k in data:
            s[k] = bool(data[k])
    try:
        r = int(data.get("rotation", s["rotation"])) % 360
        s["rotation"] = r if r in ROTATIONS else 0
    except (TypeError, ValueError):
        pass
    for k, lo, hi in (("render_interval", 0.2, 10.0), ("sensor_interval", 0.5, 60.0)):
        try:
            v = float(data.get(k, s[k]))
            s[k] = min(hi, max(lo, v))
        except (TypeError, ValueError):
            pass
    if isinstance(data.get("serial"), str):
        s["serial"] = data["serial"].strip()
    if data.get("close_action") in CLOSE_ACTIONS:
        s["close_action"] = data["close_action"]
    from layouts import LAYOUT_IDS
    if data.get("layout") in LAYOUT_IDS:
        s["layout"] = data["layout"]
    try:
        port = int(data.get("api_port", s["api_port"]))
        if port == 0 or 1024 <= port <= 65535:
            s["api_port"] = port
    except (TypeError, ValueError):
        pass
    th = data.get("theme")
    if isinstance(th, dict):
        for k, v in th.items():
            if k not in s["theme"]:
                continue
            if k in ("heat_levels", "models"):
                if isinstance(v, list) and len(v) == len(s["theme"][k]) and all(_valid_hex(x) for x in v):
                    s["theme"][k] = [x.lower() for x in v]
            elif _valid_hex(v):
                s["theme"][k] = v.lower()
    # theme_preset is a display state derived from the theme itself, so it
    # survives hand-edited settings.json files and legacy installs.
    s["theme_preset"] = theme_preset_for(s["theme"])
    return s


def sanitize(data: Dict[str, Any]) -> Dict[str, Any]:
    return _sanitize(data)


def valid_hex(v) -> bool:
    return _valid_hex(v)


def _valid_hex(v) -> bool:
    if not isinstance(v, str) or not v.startswith("#") or len(v) != 7:
        return False
    try:
        int(v[1:], 16)
        return True
    except ValueError:
        return False


def load(path: Optional[Path] = None) -> Dict[str, Any]:
    p = Path(path) if path else settings_path()
    try:
        return _sanitize(json.loads(p.read_text(encoding="utf-8")))
    except FileNotFoundError:
        return defaults()
    except Exception:
        # Corrupt file: keep a copy, fall back to defaults
        try:
            p.replace(p.with_suffix(".json.bad"))
        except OSError:
            pass
        return defaults()


def save(settings: Dict[str, Any], path: Optional[Path] = None) -> Path:
    p = Path(path) if path else settings_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(_sanitize(settings), ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, p)
    return p

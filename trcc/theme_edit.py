"""User-editable theme colours, shared by the Tk window and the control API.

Some keys are 'virtual' (heatmap, models.N) or drive derived shades
(daily_bar -> daily_bar_dim/_hi); set_color keeps those in sync.
"""
from __future__ import annotations

from typing import Dict, List, Tuple

from render import blend, heat_levels_for, _rgb

# (group label, [(theme key, label), ...])
COLOR_GROUPS: List[Tuple[str, List[Tuple[str, str]]]] = [
    ("背景与卡片", [
        ("bg_top", "背景（上）"), ("bg_bot", "背景（下）"),
        ("card", "卡片底色"), ("card_hi", "卡片高光"), ("border", "卡片边框"),
        ("track", "进度条底"),
    ]),
    ("文字", [
        ("text", "主文字"), ("text_dim", "次要文字"), ("axis", "坐标轴线"),
    ]),
    ("系统指标", [
        ("cpu", "CPU"), ("mem", "内存"), ("power", "功耗"),
        ("temp", "CPU 温度"), ("up", "上行"), ("dl", "下行"),
    ]),
    ("Token 图表", [
        ("daily_bar", "每日柱状图"), ("heatmap", "热图"), ("today_ring", "热图今日框"),
        ("heat_empty", "热图空格"), ("hourly_bar", "今日按小时"),
        ("weekly_bar", "周用量"),
    ]),
    ("模型占比", [
        ("models.0", "模型 1"), ("models.1", "模型 2"),
        ("models.2", "模型 3"), ("models.3", "模型 4"),
    ]),
]

COLOR_KEYS = frozenset(k for _, items in COLOR_GROUPS for k, _ in items)


def _hex(c) -> str:
    return "#{:02x}{:02x}{:02x}".format(*c[:3])


def _scale(c, k):
    return tuple(max(0, min(255, int(round(x * k)))) for x in c)


def get_color(theme, key) -> str:
    if key == "heatmap":
        return theme["heat_levels"][-1]
    if key.startswith("models."):
        return theme["models"][int(key.split(".")[1])]
    return theme[key]


def set_color(theme, key, hexval) -> None:
    """Write a picked colour, deriving the companion shades the renderer uses."""
    c = _rgb(hexval)
    if key == "heatmap":
        theme["heat_levels"] = [_hex(x) for x in heat_levels_for(c, _rgb(theme["heat_empty"]))]
    elif key == "heat_empty":
        theme["heat_empty"] = _hex(c)
        top = _rgb(theme["heat_levels"][-1])
        theme["heat_levels"] = [_hex(x) for x in heat_levels_for(top, c)]
    elif key.startswith("models."):
        theme["models"][int(key.split(".")[1])] = _hex(c)
    elif key == "daily_bar":
        theme["daily_bar"] = _hex(c)
        theme["daily_bar_dim"] = _hex(_scale(c, 0.45))
        theme["daily_bar_hi"] = _hex(blend(c, (255, 255, 255), 0.45))
    elif key == "hourly_bar":
        theme["hourly_bar"] = _hex(c)
        theme["hourly_bar_dim"] = _hex(_scale(c, 0.45))
    else:
        theme[key] = _hex(c)


def flat_colors(theme) -> Dict[str, str]:
    return {k: get_color(theme, k) for k in COLOR_KEYS}


def color_groups_meta() -> list:
    return [{"label": g, "items": [{"key": k, "label": l} for k, l in items]}
            for g, items in COLOR_GROUPS]

"""Selectable compositions for the 960x320 side-screen dashboard."""

LAYOUTS = (
    {"id": "classic", "label": "经典"},
    {"id": "token-focus", "label": "用量聚焦"},
    {"id": "system-first", "label": "系统优先"},
    {"id": "constellation", "label": "星环仪表"},
    {"id": "signal-wave", "label": "信号波形"},
    {"id": "telemetry", "label": "遥测控制台"},
)
LAYOUT_IDS = frozenset(item["id"] for item in LAYOUTS)


def layouts_meta():
    return [dict(item) for item in LAYOUTS]

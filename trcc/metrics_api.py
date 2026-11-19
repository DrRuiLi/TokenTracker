"""Loopback HTTP route for live system metrics (taskbar bar poller)."""
from __future__ import annotations

from typing import Dict


def register_metrics_routes(routes: Dict) -> None:
    def r_metrics(self):
        data = self._call("get_metrics")
        self._json(200, data)

    routes[("GET", "/api/metrics")] = r_metrics
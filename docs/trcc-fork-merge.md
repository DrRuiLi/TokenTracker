# TRCC fork — upstream merge touchpoints

When merging upstream TokenTracker into this tree, re-apply or resolve these fork-only hooks:

| Area | Path | Marker |
|------|------|--------|
| Taskbar metrics bar | `TokenTrackerWin/TrayApplicationContext.cs` | `#region TRCC fork: metrics bar` |
| WebView bridge | `TokenTrackerWin/DashboardWindow.cs` | `#region TRCC fork: metrics bar` |
| Side screen page | `dashboard/src/pages/TrccPage.jsx` | `MetricsBarSection` import + component |
| Implementation (no upstream conflict) | `TokenTrackerWin/TrccFork/` | entire tree |
| Implementation (no upstream conflict) | `trcc/` | entire tree |
| Copy keys | `dashboard/src/content/copy.csv` | `metrics_bar.*` rows |

New features should land under `TokenTrackerWin/TrccFork/`, `trcc/`, or `dashboard/src/pages/trcc/` rather than editing upstream files beyond thin `#region TRCC fork` blocks.
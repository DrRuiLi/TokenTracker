/** Windows native taskbar metrics bar settings (WebView2 postMessage). */

const isWindowsNative = () =>
  typeof window !== "undefined" && Boolean(window.chrome?.webview?.postMessage);

function postNative(payload) {
  if (!isWindowsNative()) return false;
  try {
    window.chrome.webview.postMessage(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function requestMetricsBarSettings() {
  return postNative({ type: "metrics_bar_get" });
}

export function saveMetricsBarSettings(settings) {
  return postNative({ type: "metrics_bar_settings", settings });
}

export function onMetricsBarSettings(callback) {
  if (typeof window === "undefined") return () => {};
  const handler = (event) => {
    if (event?.detail && typeof callback === "function") callback(event.detail);
  };
  window.addEventListener("tokentracker:metrics-bar-settings", handler);
  return () => window.removeEventListener("tokentracker:metrics-bar-settings", handler);
}

export const METRICS_BAR_COLUMNS = [
  { id: "cpu", labelKey: "metrics_bar.col.cpu" },
  { id: "gpu", labelKey: "metrics_bar.col.gpu" },
  { id: "temp", labelKey: "metrics_bar.col.temp" },
  { id: "power", labelKey: "metrics_bar.col.power" },
  { id: "gpu_temp", labelKey: "metrics_bar.col.gpu_temp" },
  { id: "vram", labelKey: "metrics_bar.col.vram" },
  { id: "mem", labelKey: "metrics_bar.col.mem" },
  { id: "disk_read", labelKey: "metrics_bar.col.disk_read" },
  { id: "disk_write", labelKey: "metrics_bar.col.disk_write" },
  { id: "up", labelKey: "metrics_bar.col.up" },
  { id: "dl", labelKey: "metrics_bar.col.dl" },
];

// Left-to-right taskbar order. Hidden items are skipped, then the rest
// stack two per column, upper list item on top.
export const DEFAULT_COLUMN_ORDER = [
  "cpu", "temp", "power", "gpu", "gpu_temp", "vram", "mem", "disk_read", "disk_write", "up", "dl",
];

const COLUMN_IDS = new Set(METRICS_BAR_COLUMNS.map((col) => col.id));

export function normalizeColumnOrder(order) {
  const seen = new Set();
  const next = [];
  for (const id of Array.isArray(order) ? order : []) {
    if (!COLUMN_IDS.has(id) || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  for (const id of DEFAULT_COLUMN_ORDER) {
    if (!seen.has(id)) next.push(id);
  }
  return next;
}

export function visibleColumns(columnOrder, visible) {
  const shown = visible instanceof Set ? visible : new Set(visible);
  return normalizeColumnOrder(columnOrder).filter((id) => shown.has(id));
}

export function toggleMetric(settings, id) {
  if (!COLUMN_IDS.has(id)) return settings;
  const shown = new Set(settings.columns);
  if (shown.has(id)) {
    if (shown.size <= 1) return settings;
    shown.delete(id);
  } else {
    shown.add(id);
  }
  const columnOrder = normalizeColumnOrder(settings.columnOrder);
  return { ...settings, columnOrder, columns: visibleColumns(columnOrder, shown) };
}

export function moveMetric(settings, index, delta) {
  const columnOrder = normalizeColumnOrder(settings.columnOrder);
  const target = index + delta;
  if (index < 0 || index >= columnOrder.length || target < 0 || target >= columnOrder.length) return settings;
  return reorderMetrics(settings, columnOrder[index], columnOrder[target]);
}

export function reorderMetrics(settings, activeId, overId) {
  const columnOrder = normalizeColumnOrder(settings.columnOrder);
  const from = columnOrder.indexOf(activeId);
  const to = columnOrder.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return settings;
  const next = columnOrder.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return {
    ...settings,
    columnOrder: next,
    columns: visibleColumns(next, settings.columns),
  };
}

export const DEFAULT_METRICS_BAR_SETTINGS = {
  enabled: false,
  refreshMs: 1000,
  opacity: 0.92,
  trccPort: 17691,
  columns: [...DEFAULT_COLUMN_ORDER],
  columnOrder: [...DEFAULT_COLUMN_ORDER],
  background: "#1e2024",
  text: "#e8eaed",
  textDim: "#9aa0a8",
};

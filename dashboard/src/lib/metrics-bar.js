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

export const DEFAULT_METRICS_BAR_SETTINGS = {
  enabled: false,
  refreshMs: 1000,
  opacity: 0.92,
  trccPort: 17691,
  columns: ["cpu", "gpu", "temp", "power", "gpu_temp", "vram", "mem", "disk_read", "disk_write", "up", "dl"],
  background: "#1e2024",
  text: "#e8eaed",
  textDim: "#9aa0a8",
};

import React, { useCallback, useEffect, useState } from "react";
import { copy } from "../../lib/copy";
import { isNativeWindowsApp } from "../../lib/native-bridge";
import {
  DEFAULT_METRICS_BAR_SETTINGS,
  METRICS_BAR_COLUMNS,
  onMetricsBarSettings,
  requestMetricsBarSettings,
  saveMetricsBarSettings,
} from "../../lib/metrics-bar.js";
import { SectionCard, SettingsRow, ToggleSwitch } from "../../components/settings/Controls.jsx";

function mergeSettings(detail) {
  if (!detail || typeof detail !== "object") return { ...DEFAULT_METRICS_BAR_SETTINGS };
  return {
    ...DEFAULT_METRICS_BAR_SETTINGS,
    enabled: Boolean(detail.Enabled ?? detail.enabled),
    refreshMs: Number(detail.RefreshMs ?? detail.refreshMs) || 1000,
    opacity: Number(detail.Opacity ?? detail.opacity) || 0.92,
    trccPort: Number(detail.TrccPort ?? detail.trccPort) || 17691,
    columns: Array.isArray(detail.Columns ?? detail.columns)
      ? (detail.Columns ?? detail.columns)
      : DEFAULT_METRICS_BAR_SETTINGS.columns,
    background: detail.Background ?? detail.background ?? DEFAULT_METRICS_BAR_SETTINGS.background,
    text: detail.Text ?? detail.text ?? DEFAULT_METRICS_BAR_SETTINGS.text,
    textDim: detail.TextDim ?? detail.textDim ?? DEFAULT_METRICS_BAR_SETTINGS.textDim,
  };
}

function toNativePayload(settings) {
  return {
    Enabled: settings.enabled,
    RefreshMs: settings.refreshMs,
    Opacity: settings.opacity,
    TrccPort: settings.trccPort,
    Columns: settings.columns,
    Background: settings.background,
    Text: settings.text,
    TextDim: settings.textDim,
  };
}

export function MetricsBarSection({ trccPort }) {
  const native = isNativeWindowsApp();
  const [settings, setSettings] = useState({ ...DEFAULT_METRICS_BAR_SETTINGS, trccPort: trccPort ?? 17691 });
  const [ready, setReady] = useState(!native);

  useEffect(() => {
    if (!native) return undefined;
    const off = onMetricsBarSettings((detail) => {
      setSettings((prev) => mergeSettings({ ...detail, TrccPort: trccPort ?? detail?.TrccPort ?? prev.trccPort }));
      setReady(true);
    });
    requestMetricsBarSettings();
    return off;
  }, [native, trccPort]);

  const persist = useCallback(
    (next) => {
      const merged = { ...next, trccPort: trccPort ?? next.trccPort };
      setSettings(merged);
      if (native) saveMetricsBarSettings(toNativePayload(merged));
    },
    [native, trccPort],
  );

  const toggleColumn = (id) => {
    const cols = new Set(settings.columns);
    if (cols.has(id)) cols.delete(id);
    else cols.add(id);
    const next = { ...settings, columns: [...cols] };
    if (next.columns.length === 0) next.columns = ["cpu"];
    persist(next);
  };

  if (!native) {
    return (
      <SectionCard title={copy("metrics_bar.section.title")}>
        <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("metrics_bar.native_only")}</p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title={copy("metrics_bar.section.title")} subtitle={copy("metrics_bar.section.hint")}>
      <div className="flex flex-col gap-5 py-2">
        <SettingsRow
          label={copy("metrics_bar.enabled")}
          hint={copy("metrics_bar.enabled.hint")}
          control={
            <ToggleSwitch
              checked={settings.enabled}
              onChange={(enabled) => persist({ ...settings, enabled })}
              disabled={!ready}
            />
          }
        />
        <SettingsRow
          label={copy("metrics_bar.refresh")}
          control={
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={500}
                max={5000}
                step={500}
                value={settings.refreshMs}
                onChange={(e) => persist({ ...settings, refreshMs: Number(e.target.value) })}
                className="w-full max-w-xs"
              />
              <span className="text-sm tabular-nums text-oai-gray-600 dark:text-oai-gray-300">
                {settings.refreshMs} ms
              </span>
            </div>
          }
        />
        <SettingsRow
          label={copy("metrics_bar.opacity")}
          control={
            <input
              type="range"
              min={40}
              max={100}
              value={Math.round(settings.opacity * 100)}
              onChange={(e) => persist({ ...settings, opacity: Number(e.target.value) / 100 })}
              className="w-full max-w-xs"
            />
          }
        />
        <div>
          <div className="mb-2 text-sm font-medium text-oai-gray-800 dark:text-oai-gray-200">
            {copy("metrics_bar.columns")}
          </div>
          <div className="flex flex-wrap gap-2">
            {METRICS_BAR_COLUMNS.map((col) => (
              <button
                key={col.id}
                type="button"
                className={`rounded-full border px-3 py-1 text-xs ${
                  settings.columns.includes(col.id)
                    ? "border-oai-blue-500 bg-oai-blue-50 text-oai-blue-700 dark:bg-oai-blue-950 dark:text-oai-blue-200"
                    : "border-oai-gray-300 text-oai-gray-600 dark:border-oai-gray-600 dark:text-oai-gray-300"
                }`}
                onClick={() => toggleColumn(col.id)}
              >
                {copy(col.labelKey)}
              </button>
            ))}
          </div>
        </div>
      </div>
    </SectionCard>
  );
}
import React, { useCallback, useEffect, useRef, useState } from "react";
import { AppWindow, MonitorCog, RefreshCw, RotateCcw, ShieldAlert } from "lucide-react";
import { copy } from "../lib/copy";
import { cn } from "../lib/cn";
import {
  TrccApiError,
  isValidTrccPort,
  readTrccPort,
  saveTrccPort,
  trccApi,
  trccPreviewUrl,
} from "../lib/trcc-api.js";
import {
  SETTINGS_INPUT_CLASS,
  SectionCard,
  SegmentedControl,
  SettingsRow,
  ToggleSwitch,
} from "../components/settings/Controls.jsx";
import { Button } from "../ui/components/Button.jsx";
import { Card } from "../ui/components/Card.jsx";
import { ConfirmModal } from "../ui/components/ConfirmModal.jsx";
import { showToast } from "../ui/components/Toast.jsx";

const POLL_MS = 1000;
const COLOR_DEBOUNCE_MS = 200;

function formatClock(epochSeconds) {
  if (!epochSeconds) return null;
  return new Date(epochSeconds * 1000).toLocaleTimeString();
}

function deviceText(st) {
  if (st.connected) {
    const [w, h] = st.size || [0, 0];
    return copy("trcc.status.connected", {
      pm: st.pm ?? "-",
      sub: st.sub ?? "-",
      w,
      h,
      fps: Number(st.push_fps || 0).toFixed(1),
    });
  }
  if (!st.pushing) return copy("trcc.status.stopped");
  return st.usb_error ? `${copy("trcc.status.connecting")} ${st.usb_error}` : copy("trcc.status.connecting");
}

function cursorText(st) {
  if (st.cursor_busy) return copy("trcc.status.cursor_busy");
  const t = formatClock(st.cursor_ok);
  return t ? copy("trcc.status.cursor_ok", { time: t }) : copy("trcc.status.cursor_never");
}

function NumberField({ value, min, max, step, onCommit, ariaLabel }) {
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);

  const commit = () => {
    const v = Number.parseFloat(draft);
    if (!Number.isFinite(v)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, v));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <input
      type="number"
      inputMode="decimal"
      min={min}
      max={max}
      step={step}
      value={draft}
      aria-label={ariaLabel}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      className={cn(SETTINGS_INPUT_CLASS, "w-24 text-right tabular-nums")}
    />
  );
}

function StatusRow({ label, value, tone }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 text-sm">
      <span className="shrink-0 text-oai-gray-500 dark:text-oai-gray-400">{label}</span>
      <span
        className={cn(
          "min-w-0 break-words text-right",
          tone === "ok" && "text-emerald-600 dark:text-emerald-400",
          tone === "warn" && "text-orange-600 dark:text-orange-400",
          !tone && "text-oai-gray-900 dark:text-oai-gray-200",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function OfflineCard({ port, onRetry }) {
  const [draft, setDraft] = useState(String(port));
  const submit = (e) => {
    e.preventDefault();
    const v = Number.parseInt(draft, 10);
    if (isValidTrccPort(v)) onRetry(v);
  };
  return (
    <Card className="rounded-lg">
      <div className="flex items-start gap-3">
        <MonitorCog className="mt-0.5 h-5 w-5 shrink-0 text-oai-gray-400" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-medium text-oai-black dark:text-white">{copy("trcc.offline.title")}</h2>
          <p className="mt-1 text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("trcc.offline.body")}</p>
          <form onSubmit={submit} className="mt-4 flex flex-wrap items-center gap-2">
            <label htmlFor="trcc-port" className="text-sm text-oai-gray-600 dark:text-oai-gray-300">
              {copy("trcc.offline.port")}
            </label>
            <input
              id="trcc-port"
              type="number"
              min={1024}
              max={65535}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className={cn(SETTINGS_INPUT_CLASS, "w-28 tabular-nums")}
            />
            <Button type="submit" variant="secondary" size="sm">
              {copy("trcc.offline.retry")}
            </Button>
          </form>
        </div>
      </div>
    </Card>
  );
}

export function TrccPage() {
  const [port, setPort] = useState(readTrccPort);
  const [data, setData] = useState(null); // last /api/state (settings/app/meta/status)
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [colorDraft, setColorDraft] = useState({});
  const [confirmReset, setConfirmReset] = useState(false);
  const aliveRef = useRef(true);
  const colorQueue = useRef({});
  const colorTimer = useRef(null);

  const load = useCallback(async () => {
    try {
      const next = await trccApi.state(port);
      if (!aliveRef.current) return;
      setData(next);
      setOffline(false);
    } catch (err) {
      if (!aliveRef.current) return;
      if (err instanceof TrccApiError && err.status === 0) setOffline(true);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [port]);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void load();
    }, POLL_MS);
    return () => {
      aliveRef.current = false;
      clearInterval(timer);
    };
  }, [load]);

  useEffect(() => () => clearTimeout(colorTimer.current), []);

  const mergeResponse = useCallback((resp) => {
    if (resp && aliveRef.current) setData((prev) => (prev ? { ...prev, ...resp } : prev));
  }, []);

  const run = useCallback(
    async (fn) => {
      try {
        const resp = await fn();
        mergeResponse(resp);
        return resp;
      } catch (err) {
        showToast({ title: copy("trcc.error.save", { error: err?.message || String(err) }), timeout: 5000 });
        return null;
      }
    },
    [mergeResponse],
  );

  const patch = useCallback((p) => run(() => trccApi.updateSettings(port, p)), [port, run]);

  const flushColors = useCallback(async () => {
    const batch = colorQueue.current;
    colorQueue.current = {};
    if (Object.keys(batch).length === 0) return;
    await patch({ colors: batch });
    setColorDraft((prev) => {
      const next = { ...prev };
      for (const [k, v] of Object.entries(batch)) if (next[k] === v) delete next[k];
      return next;
    });
  }, [patch]);

  const onColor = (key, value) => {
    setColorDraft((prev) => ({ ...prev, [key]: value }));
    colorQueue.current[key] = value;
    clearTimeout(colorTimer.current);
    colorTimer.current = setTimeout(() => void flushColors(), COLOR_DEBOUNCE_MS);
  };

  const changePort = (p) => {
    saveTrccPort(p);
    setLoading(true);
    setPort(p);
  };

  const togglePush = async () => {
    const on = !data.status.pushing;
    const resp = await run(() => trccApi.setPushing(port, on));
    if (resp) setData((prev) => ({ ...prev, status: { ...prev.status, pushing: resp.pushing } }));
  };

  const relaunchAdmin = async () => {
    const resp = await run(() => trccApi.relaunchAdmin(port));
    if (!resp) return;
    showToast({
      title: resp.ok ? copy("trcc.admin.requested") : copy("trcc.admin.cancelled"),
      timeout: 6000,
    });
  };

  const online = Boolean(data) && !offline;
  const st = data?.status;
  const s = data?.settings;
  const meta = data?.meta;
  const app = data?.app;

  return (
    <div className="flex flex-col flex-1 text-oai-black dark:text-oai-white font-oai antialiased">
      <main className="flex-1 pt-8 sm:pt-10 pb-12 sm:pb-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex flex-row items-start justify-between gap-4 mb-8">
            <div className="min-w-0">
              <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-oai-black dark:text-white mb-3">
                {copy("nav.trcc")}
              </h1>
              <p className="text-oai-gray-500 dark:text-oai-gray-400 text-sm sm:text-base">
                {copy("trcc.page.subtitle")}
              </p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              {!loading ? (
                <span className="hidden sm:inline-flex items-center gap-2 text-xs text-oai-gray-500 dark:text-oai-gray-400">
                  <span
                    aria-hidden
                    className={cn("h-2 w-2 rounded-full", online ? "bg-emerald-500" : "bg-oai-gray-400")}
                  />
                  {online ? copy("trcc.conn.online") : copy("trcc.conn.offline")}
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => void load()}
                aria-label={copy("trcc.refresh")}
                title={copy("trcc.refresh")}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 text-oai-gray-600 dark:text-oai-gray-400 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 hover:text-oai-black dark:hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500"
              >
                <RefreshCw className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </div>

          {loading && !data ? (
            <div className="h-40 rounded-lg bg-oai-gray-100 dark:bg-oai-gray-900 animate-pulse" />
          ) : null}

          {!loading && !online ? <OfflineCard port={port} onRetry={changePort} /> : null}

          {online ? (
            <div className="flex flex-col gap-6">
              <Card className="rounded-lg">
                <div className="mb-3 flex items-center justify-between gap-4">
                  <h2 className="text-sm font-medium text-oai-gray-500 dark:text-oai-gray-300 uppercase tracking-wide">
                    {copy("trcc.preview.title")}
                  </h2>
                  <span className="text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("trcc.preview.hint")}</span>
                </div>
                <div className="flex aspect-[3/1] w-full items-center justify-center overflow-hidden rounded-md bg-black">
                  {data.preview_seq ? (
                    <img
                      src={trccPreviewUrl(port, data.preview_seq)}
                      alt={copy("trcc.preview.title")}
                      className="h-full w-full object-contain"
                      draggable={false}
                    />
                  ) : (
                    <span className="text-sm text-oai-gray-500">{copy("trcc.preview.empty")}</span>
                  )}
                </div>
              </Card>

              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <SectionCard title={copy("trcc.section.push")}>
                  <SettingsRow
                    label={copy("trcc.push.label")}
                    hint={copy("trcc.push.hint")}
                    control={
                      <ToggleSwitch
                        checked={Boolean(st.pushing)}
                        onChange={() => void togglePush()}
                        ariaLabel={copy("trcc.push.label")}
                      />
                    }
                  />
                  <SettingsRow
                    label={copy("trcc.rotation.label")}
                    control={
                      <SegmentedControl
                        value={s.rotation}
                        onChange={(v) => void patch({ rotation: v })}
                        options={meta.rotations.map((deg) => ({ value: deg, label: `${deg}°` }))}
                      />
                    }
                  />
                  <SettingsRow
                    label={copy("trcc.mirror.label")}
                    control={
                      <ToggleSwitch
                        checked={Boolean(s.mirror)}
                        onChange={() => void patch({ mirror: !s.mirror })}
                        ariaLabel={copy("trcc.mirror.label")}
                      />
                    }
                  />
                  {meta.theme_presets?.length ? (
                    <SettingsRow
                      label={copy("trcc.theme.label")}
                      control={
                        <SegmentedControl
                          value={s.theme_preset}
                          onChange={(v) => void patch({ theme_preset: v })}
                          options={meta.theme_presets.map((preset) => ({
                            value: preset.id,
                            label: copy(`trcc.theme.${preset.id}`),
                          }))}
                        />
                      }
                    />
                  ) : null}
                  <SettingsRow
                    label={copy("trcc.layout.label")}
                    control={
                      <SegmentedControl
                        value={s.layout || "classic"}
                        onChange={(v) => void patch({ layout: v })}
                        options={(meta.layouts || []).map((layout) => ({
                          value: layout.id,
                          label: copy(`trcc.layout.${layout.id}`),
                        }))}
                      />
                    }
                  />
                  <SettingsRow
                    label={copy("trcc.interval.label")}
                    control={
                      <NumberField
                        value={s.render_interval}
                        min={meta.ranges.render_interval[0]}
                        max={meta.ranges.render_interval[1]}
                        step={meta.ranges.render_interval[2]}
                        ariaLabel={copy("trcc.interval.label")}
                        onCommit={(v) => void patch({ render_interval: v })}
                      />
                    }
                  />
                  {meta.ranges.sensor_interval ? (
                    <SettingsRow
                      label={copy("trcc.sensor_interval.label")}
                      hint={copy("trcc.sensor_interval.hint")}
                      control={
                        <NumberField
                          value={s.sensor_interval}
                          min={meta.ranges.sensor_interval[0]}
                          max={meta.ranges.sensor_interval[1]}
                          step={meta.ranges.sensor_interval[2]}
                          ariaLabel={copy("trcc.sensor_interval.label")}
                          onCommit={(v) => void patch({ sensor_interval: v })}
                        />
                      }
                    />
                  ) : null}
                  {app.tray ? (
                    <SettingsRow
                      label={copy("trcc.close_action.label")}
                      control={
                        <SegmentedControl
                          value={s.close_action}
                          onChange={(v) => void patch({ close_action: v })}
                          options={meta.close_actions.map((a) => ({ value: a.id, label: a.label }))}
                        />
                      }
                    />
                  ) : null}
                </SectionCard>

                <SectionCard title={copy("trcc.section.status")}>
                  <StatusRow
                    label={copy("trcc.status.device")}
                    value={deviceText(st)}
                    tone={st.connected ? "ok" : st.pushing ? "warn" : undefined}
                  />
                  <StatusRow
                    label={copy("trcc.status.cursor")}
                    value={st.cursor_error ? `${cursorText(st)} · ${st.cursor_error}` : cursorText(st)}
                    tone={st.cursor_error ? "warn" : undefined}
                  />
                  <StatusRow
                    label={copy("trcc.status.sensor")}
                    value={st.sensor_label || copy("trcc.status.sensor_none", { reason: st.sensor_embedded || "-" })}
                    tone={st.sensor_label ? undefined : "warn"}
                  />
                  <StatusRow
                    label={copy("trcc.status.render")}
                    value={`${Math.round(st.render_ms || 0)} ms`}
                  />
                  {app.can_elevate ? (
                    <SettingsRow
                      label={copy("trcc.status.admin")}
                      hint={copy("trcc.status.admin_hint")}
                      control={
                        <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => void relaunchAdmin()}>
                          <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
                          <span>{copy("trcc.admin.relaunch")}</span>
                        </Button>
                      }
                    />
                  ) : (
                    <StatusRow label={copy("trcc.status.admin")} value={copy("trcc.status.admin_yes")} tone="ok" />
                  )}
                  {app.hosted ? null : (
                    <SettingsRow
                      label={copy("trcc.window.label")}
                      control={
                        <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => void run(() => trccApi.showWindow(port))}>
                          <AppWindow className="h-3.5 w-3.5" aria-hidden />
                          <span>{copy("trcc.window.open")}</span>
                        </Button>
                      }
                    />
                  )}
                </SectionCard>
              </div>

              <SectionCard
                title={copy("trcc.section.colors")}
                subtitle={copy("trcc.colors.hint")}
                action={
                  <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => setConfirmReset(true)}>
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                    <span>{copy("trcc.reset.button")}</span>
                  </Button>
                }
              >
                <div className="grid grid-cols-2 gap-x-6 gap-y-5 py-4 sm:grid-cols-3 lg:grid-cols-5">
                  {meta.color_groups.map((group) => (
                    <div key={group.label} className="flex flex-col gap-2">
                      <div className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">{group.label}</div>
                      {group.items.map((item) => {
                        const value = colorDraft[item.key] ?? s.colors[item.key];
                        return (
                          <label key={item.key} className="flex cursor-pointer items-center gap-2 text-sm text-oai-gray-900 dark:text-oai-gray-200">
                            <input
                              type="color"
                              value={value}
                              onChange={(e) => onColor(item.key, e.target.value)}
                              className="h-7 w-9 shrink-0 cursor-pointer rounded border border-oai-gray-300 bg-transparent p-0.5 dark:border-oai-gray-700"
                            />
                            <span className="truncate">{item.label}</span>
                          </label>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </SectionCard>
            </div>
          ) : null}
        </div>
      </main>

      <ConfirmModal
        open={confirmReset}
        title={copy("trcc.reset.title")}
        description={copy("trcc.reset.body")}
        confirmLabel={copy("trcc.reset.confirm")}
        cancelLabel={copy("trcc.cancel")}
        destructive
        onConfirm={() => {
          setConfirmReset(false);
          setColorDraft({});
          void run(() => trccApi.reset(port));
        }}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  );
}

export default TrccPage;

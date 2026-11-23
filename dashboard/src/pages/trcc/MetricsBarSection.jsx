import React, { useCallback, useEffect, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, ChevronUp, GripVertical } from "lucide-react";
import { copy } from "../../lib/copy";
import { cn } from "../../lib/cn";
import { isNativeWindowsApp } from "../../lib/native-bridge";
import {
  DEFAULT_METRICS_BAR_SETTINGS,
  METRICS_BAR_COLUMNS,
  moveMetric,
  normalizeColumnOrder,
  onMetricsBarSettings,
  reorderMetrics,
  requestMetricsBarSettings,
  saveMetricsBarSettings,
  toggleMetric,
} from "../../lib/metrics-bar.js";
import { SectionCard, SettingsRow, ToggleSwitch } from "../../components/settings/Controls.jsx";

const COLUMN_LABELS = Object.fromEntries(METRICS_BAR_COLUMNS.map((col) => [col.id, col.labelKey]));

function mergeSettings(detail) {
  if (!detail || typeof detail !== "object") return { ...DEFAULT_METRICS_BAR_SETTINGS };
  const columns = Array.isArray(detail.Columns ?? detail.columns)
    ? (detail.Columns ?? detail.columns)
    : DEFAULT_METRICS_BAR_SETTINGS.columns;
  return {
    ...DEFAULT_METRICS_BAR_SETTINGS,
    enabled: Boolean(detail.Enabled ?? detail.enabled),
    refreshMs: Number(detail.RefreshMs ?? detail.refreshMs) || 1000,
    opacity: Number(detail.Opacity ?? detail.opacity) || 0.92,
    trccPort: Number(detail.TrccPort ?? detail.trccPort) || 17691,
    columns,
    columnOrder: normalizeColumnOrder(detail.ColumnOrder ?? detail.columnOrder),
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
    ColumnOrder: settings.columnOrder,
    Background: settings.background,
    Text: settings.text,
    TextDim: settings.textDim,
  };
}

function MetricOrderRow({ id, index, count, visible, ready, onlyVisible, onMove, onToggle }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const name = copy(COLUMN_LABELS[id] || id);
  const style = {
    transform: CSS.Transform.toString(transform) || undefined,
    transition,
    zIndex: isDragging ? 20 : undefined,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-2 py-1.5",
        isDragging && "relative rounded-md bg-oai-gray-100 dark:bg-oai-gray-800",
      )}
    >
      <button
        type="button"
        aria-label={copy("metrics_bar.move_up", { name })}
        disabled={!ready || index === 0}
        onClick={() => onMove(index, -1)}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-oai-gray-500 hover:bg-oai-gray-100 hover:text-oai-black disabled:pointer-events-none disabled:opacity-30 dark:text-oai-gray-400 dark:hover:bg-oai-gray-800 dark:hover:text-white"
      >
        <ChevronUp className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        aria-label={copy("metrics_bar.move_down", { name })}
        disabled={!ready || index === count - 1}
        onClick={() => onMove(index, 1)}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-oai-gray-500 hover:bg-oai-gray-100 hover:text-oai-black disabled:pointer-events-none disabled:opacity-30 dark:text-oai-gray-400 dark:hover:bg-oai-gray-800 dark:hover:text-white"
      >
        <ChevronDown className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        className="inline-flex h-7 w-7 cursor-grab items-center justify-center rounded-md text-oai-gray-400 active:cursor-grabbing dark:text-oai-gray-500"
        aria-label={name}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" aria-hidden />
      </button>
      <span className="min-w-0 flex-1 text-sm text-oai-gray-900 dark:text-oai-gray-200">{name}</span>
      <div onPointerDown={(event) => event.stopPropagation()}>
        <ToggleSwitch
          checked={visible}
          onChange={onToggle}
          disabled={!ready || (visible && onlyVisible)}
          ariaLabel={name}
        />
      </div>
    </div>
  );
}

export function MetricsBarSection({ trccPort, mode = "taskbar" }) {
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

  const toggleColumn = (id) => persist(toggleMetric(settings, id));
  const moveColumn = (index, delta) => persist(moveMetric(settings, index, delta));
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (!native) {
    return (
      <SectionCard title={copy(mode === "hardware" ? "trcc.section.hardware" : "trcc.section.taskbar")}>
        <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("metrics_bar.native_only")}</p>
      </SectionCard>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {mode === "taskbar" ? (
        <SectionCard title={copy("metrics_bar.section.title")} subtitle={copy("metrics_bar.section.hint")}>
          <div className="flex flex-col gap-2 py-2">
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
          </div>
        </SectionCard>
      ) : null}
      {mode === "taskbar" ? (
        <SectionCard title={copy("metrics_bar.columns")} subtitle={copy("metrics_bar.columns.hint")}>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={({ active, over }) => {
              if (over && active.id !== over.id) persist(reorderMetrics(settings, active.id, over.id));
            }}
          >
            <SortableContext items={settings.columnOrder} strategy={verticalListSortingStrategy}>
              {settings.columnOrder.map((id, index) => (
                <MetricOrderRow
                  key={id}
                  id={id}
                  index={index}
                  count={settings.columnOrder.length}
                  visible={settings.columns.includes(id)}
                  ready={ready}
                  onlyVisible={settings.columns.length <= 1}
                  onMove={moveColumn}
                  onToggle={() => toggleColumn(id)}
                />
              ))}
            </SortableContext>
          </DndContext>
        </SectionCard>
      ) : null}
    </div>
  );
}

import React, { useCallback, useEffect, useState } from "react";
import { copy } from "../../../lib/copy";
import {
  fetchGrokLoginStatus,
  openGrokLoginWindow,
  setGrokBillingRefreshInterval,
} from "../../../lib/grok-login-api.js";
import { showToast } from "../../components/Toast.jsx";

function secondsToDraftMinutes(seconds) {
  if (!Number.isFinite(seconds)) return "";
  const minutes = seconds / 60;
  return Number.isInteger(minutes) ? String(minutes) : String(Math.round(minutes * 10) / 10);
}

function parseDraftMinutes(raw, { minSeconds, maxSeconds }) {
  const minutes = Number(String(raw).trim());
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const seconds = Math.round(minutes * 60);
  if (seconds < minSeconds || seconds > maxSeconds) return null;
  return seconds;
}

export function GrokXLoginButton() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [prefBusy, setPrefBusy] = useState(false);
  const [draftMinutes, setDraftMinutes] = useState("");

  const minSeconds = status?.refreshIntervalMinSeconds ?? 60;
  const maxSeconds = status?.refreshIntervalMaxSeconds ?? 86_400;

  const load = useCallback(async () => {
    try {
      const next = await fetchGrokLoginStatus();
      if (next?.platform === "win32") {
        setStatus(next);
        setDraftMinutes(secondsToDraftMinutes(next.refreshIntervalSeconds));
      } else {
        setStatus(null);
      }
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  const saveRefreshInterval = async () => {
    if (!status || prefBusy) return;
    const seconds = parseDraftMinutes(draftMinutes, { minSeconds, maxSeconds });
    if (seconds === null) {
      showToast({ title: copy("trcc.grok.refresh_invalid"), timeout: 6000 });
      setDraftMinutes(secondsToDraftMinutes(status.refreshIntervalSeconds));
      return;
    }
    if (seconds === status.refreshIntervalSeconds) return;
    setPrefBusy(true);
    try {
      const next = await setGrokBillingRefreshInterval(seconds);
      if (next?.platform === "win32") {
        setStatus(next);
        setDraftMinutes(secondsToDraftMinutes(next.refreshIntervalSeconds));
      }
    } catch (err) {
      showToast({
        title: copy("trcc.error.save", { error: err?.message || String(err) }),
        timeout: 6000,
      });
      setDraftMinutes(secondsToDraftMinutes(status.refreshIntervalSeconds));
    } finally {
      setPrefBusy(false);
    }
  };

  if (!status) return null;

  const signIn = async (event) => {
    event.stopPropagation();
    setBusy(true);
    try {
      const next = await openGrokLoginWindow();
      if (next?.platform === "win32") {
        setStatus(next);
        setDraftMinutes(secondsToDraftMinutes(next.refreshIntervalSeconds));
      }
      showToast({ title: copy("trcc.grok.opened"), timeout: 6000 });
    } catch (err) {
      showToast({
        title: copy("trcc.error.save", { error: err?.message || String(err) }),
        timeout: 6000,
      });
    } finally {
      setBusy(false);
    }
  };

  const minMinutes = minSeconds / 60;
  const maxMinutes = maxSeconds / 60;

  return (
    <div
      className="flex shrink-0 items-center gap-1.5"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <label className="sr-only" htmlFor="grok-billing-refresh-minutes">
        {copy("trcc.grok.refresh_label")}
      </label>
      <div
        className="flex items-center gap-1 rounded-md border border-oai-gray-200 bg-white px-1.5 py-0.5 dark:border-oai-gray-700 dark:bg-oai-gray-900"
        title={copy("trcc.grok.refresh_hint", { min: minMinutes, max: maxMinutes })}
      >
        <input
          id="grok-billing-refresh-minutes"
          type="number"
          inputMode="decimal"
          min={minMinutes}
          max={maxMinutes}
          step="any"
          disabled={prefBusy}
          value={draftMinutes}
          onChange={(event) => setDraftMinutes(event.target.value)}
          onBlur={() => void saveRefreshInterval()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void saveRefreshInterval();
            }
          }}
          className="w-12 border-0 bg-transparent p-0.5 text-right text-xs font-medium text-oai-gray-700 focus:outline-none focus:ring-0 disabled:opacity-50 dark:text-oai-gray-200"
        />
        <span className="text-xs text-oai-gray-500 dark:text-oai-gray-400">
          {copy("trcc.grok.refresh_unit")}
        </span>
      </div>
      <button
        type="button"
        title={status.signedIn ? copy("trcc.grok.signed_in") : copy("trcc.grok.hint")}
        disabled={busy}
        onClick={(event) => {
          event.stopPropagation();
          void signIn(event);
        }}
        className="shrink-0 rounded-md border border-oai-gray-200 bg-white px-2 py-1 text-xs font-medium text-oai-gray-700 transition-colors hover:bg-oai-gray-50 disabled:opacity-50 dark:border-oai-gray-700 dark:bg-oai-gray-900 dark:text-oai-gray-200 dark:hover:bg-oai-gray-800"
      >
        {copy("trcc.grok.button")}
      </button>
    </div>
  );
}

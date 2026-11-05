import React, { useCallback, useEffect, useState } from "react";
import { copy } from "../../../lib/copy";
import { fetchGrokLoginStatus, openGrokLoginWindow } from "../../../lib/grok-login-api.js";
import { showToast } from "../../components/Toast.jsx";

export function GrokXLoginButton() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await fetchGrokLoginStatus();
      setStatus(next?.platform === "win32" ? next : null);
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

  if (!status) return null;

  const signIn = async (event) => {
    event.stopPropagation();
    setBusy(true);
    try {
      const next = await openGrokLoginWindow();
      setStatus(next?.platform === "win32" ? next : null);
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

  return (
    <button
      type="button"
      title={status.signedIn ? copy("trcc.grok.signed_in") : copy("trcc.grok.hint")}
      disabled={busy}
      onClick={(event) => {
        event.stopPropagation();
        void signIn(event);
      }}
      onKeyDown={(event) => event.stopPropagation()}
      className="shrink-0 rounded-md border border-oai-gray-200 bg-white px-2 py-1 text-xs font-medium text-oai-gray-700 transition-colors hover:bg-oai-gray-50 disabled:opacity-50 dark:border-oai-gray-700 dark:bg-oai-gray-900 dark:text-oai-gray-200 dark:hover:bg-oai-gray-800"
    >
      {copy("trcc.grok.button")}
    </button>
  );
}

import React, { useCallback, useEffect, useState } from "react";
import { AlertCircle } from "lucide-react";
import { copy } from "../../../lib/copy";
import { fetchGrokLoginStatus } from "../../../lib/grok-login-api.js";

function StatusText({ tone = "neutral", children }) {
  if (tone === "error") {
    return (
      <div className="flex items-start gap-2 text-xs leading-relaxed text-oai-gray-600 dark:text-oai-gray-300">
        <AlertCircle size={15} aria-hidden className="mt-0.5 shrink-0 text-red-500 dark:text-red-400" />
        <span className="min-w-0 break-words">{children}</span>
      </div>
    );
  }
  return <div className="text-[11px] leading-snug text-oai-gray-500 dark:text-oai-gray-400">{children}</div>;
}

export function CursorGrokLoginStatus({ fallback = null }) {
  const [status, setStatus] = useState(undefined);

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
    const timer = setInterval(() => void load(), 8000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  if (status === undefined) return <StatusText>{copy("trcc.grok.checking")}</StatusText>;
  if (!status) return fallback;
  if (status.uncertain) return <StatusText>{copy("trcc.grok.status_unknown")}</StatusText>;
  if (status.signedIn) return <StatusText>{copy("trcc.grok.status_in")}</StatusText>;
  return <StatusText tone="error">{copy("trcc.grok.status_out")}</StatusText>;
}

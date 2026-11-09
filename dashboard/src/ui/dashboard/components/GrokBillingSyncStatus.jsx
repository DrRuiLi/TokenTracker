import React, { useCallback, useEffect, useState } from "react";
import { AlertCircle } from "lucide-react";
import { copy } from "../../../lib/copy";
import { fetchGrokLoginStatus } from "../../../lib/grok-login-api.js";

const POLL_MS = 30_000;

function formatSyncedAt(ms) {
  if (!Number.isFinite(ms)) return copy("trcc.grok.billing_never");
  return new Date(ms).toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function GrokBillingSyncStatus() {
  const [billing, setBilling] = useState(null);

  const load = useCallback(async () => {
    try {
      const next = await fetchGrokLoginStatus();
      setBilling(next?.platform === "win32" ? next.billing ?? null : null);
    } catch {
      setBilling(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  if (!billing?.failing) return null;

  const time = formatSyncedAt(billing.lastSuccessAt);
  const text =
    billing.code === "cloudflare-challenge"
      ? copy("trcc.grok.billing_challenge", { time })
      : copy("trcc.grok.billing_failing", { time, error: billing.error || "" });

  return (
    <div
      role="status"
      className="mt-1 flex items-start gap-2 text-xs leading-relaxed text-oai-gray-600 dark:text-oai-gray-300"
    >
      <AlertCircle size={15} aria-hidden className="mt-0.5 shrink-0 text-amber-500 dark:text-amber-400" />
      <span className="min-w-0 break-words">{text}</span>
    </div>
  );
}

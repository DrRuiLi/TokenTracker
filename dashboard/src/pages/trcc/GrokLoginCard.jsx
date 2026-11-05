import React, { useCallback, useEffect, useState } from "react";
import { LogIn } from "lucide-react";
import { copy } from "../../lib/copy";
import { fetchGrokLoginStatus, openGrokLoginWindow } from "../../lib/grok-login-api.js";
import { SectionCard, SettingsRow } from "../../components/settings/Controls.jsx";
import { Button } from "../../ui/components/Button.jsx";
import { showToast } from "../../ui/components/Toast.jsx";

export function GrokLoginCard() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await fetchGrokLoginStatus();
      setStatus(next);
      setUnavailable(false);
    } catch {
      setUnavailable(true);
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

  const signIn = async () => {
    setBusy(true);
    try {
      const next = await openGrokLoginWindow();
      setStatus(next);
      setUnavailable(false);
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

  const windows = status?.platform === "win32";
  const signedIn = Boolean(status?.signedIn);
  const stateLabel = unavailable
    ? copy("trcc.grok.local_only")
    : !status
      ? copy("trcc.grok.checking")
      : windows
        ? (signedIn ? copy("trcc.grok.signed_in") : copy("trcc.grok.signed_out"))
        : copy("trcc.grok.unsupported");

  return (
    <SectionCard title={copy("trcc.grok.title")} subtitle={copy("trcc.grok.hint")}>
      <SettingsRow
        label={stateLabel}
        control={
          <Button
            variant="secondary"
            size="sm"
            className="gap-1.5"
            disabled={busy || unavailable || (status && !windows)}
            onClick={() => void signIn()}
          >
            <LogIn className="h-3.5 w-3.5" aria-hidden />
            <span>{copy("trcc.grok.login")}</span>
          </Button>
        }
      />
    </SectionCard>
  );
}

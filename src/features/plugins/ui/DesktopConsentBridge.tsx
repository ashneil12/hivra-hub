import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  allowApp,
  consentFrom,
  refuseApp,
  setVisible,
  type ConsentState,
} from "../../../../plugins/desktop-control/bin/consent.mjs";
import { plainError } from "../model/pluginInstall";
import { DesktopConsent } from "./DesktopConsent";

/** Reads and writes consent. A late reply does not paint over a newer one. */
export function DesktopConsentBridge({ on }: { on: boolean }) {
  const [consent, setConsent] = useState<ConsentState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);

  const read = useCallback(() => {
    const ticket = ++generation.current;
    return invoke("desktop_consent_read")
      .then((value) => {
        if (!mounted.current || ticket !== generation.current) return;
        const parsed = consentFrom(value);
        if (!parsed) {
          setConsent(null);
          setError("Desktop consent couldn't be read.");
          return;
        }
        setConsent(parsed);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!mounted.current || ticket !== generation.current) return;
        setConsent(null);
        setError(plainError(caught));
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    void read();
    return () => {
      mounted.current = false;
    };
  }, [read]);

  async function commit(current: ConsentState, next: ConsentState) {
    if (next === current) return;
    const expected = current.revision;
    const ticket = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const value = await invoke("desktop_consent_write", {
        expectedRevision: expected,
        consent: { ...next, revision: expected + 1 },
      });
      if (!mounted.current || ticket !== generation.current) return;
      const parsed = consentFrom(value);
      if (!parsed) setError("Desktop consent couldn't be read.");
      else setConsent(parsed);
    } catch (caught) {
      if (!mounted.current || ticket !== generation.current) return;
      setError(plainError(caught));
      const again = ++generation.current;
      try {
        const value = await invoke("desktop_consent_read");
        if (!mounted.current || again !== generation.current) return;
        const parsed = consentFrom(value);
        if (parsed) setConsent(parsed);
      } catch {
        // The write's own message stays on screen.
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  if (!consent) {
    return error ? <p className="mt-2 text-[13px] text-red-400">{error}</p> : null;
  }

  return (
    <>
      {error ? <p className="mt-2 text-[13px] text-red-400">{error}</p> : null}
      <DesktopConsent
        consent={consent}
        on={on}
        busy={busy}
        onAllow={(project, app) => void commit(consent, allowApp(consent, project, app))}
        onRefuse={(project, app) => void commit(consent, refuseApp(consent, project, app))}
        onVisible={(project, visible) => void commit(consent, setVisible(consent, project, visible))}
      />
    </>
  );
}

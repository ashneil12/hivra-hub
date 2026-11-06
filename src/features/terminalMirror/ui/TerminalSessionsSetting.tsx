// WP-85. Off until the person turns it on. The install is shown before it runs.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { INSTALL_PREVIEW } from "../../../../plugins/hivra-mirror/src/install.ts";

const TRY_AGAIN = "That didn't go through. Try again.";

type Status = {
  enabled: boolean;
  version: number;
  note: string | null;
  stale: boolean;
};

function asStatus(value: unknown): Status | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.enabled !== "boolean") return null;
  if (typeof row.version !== "number" || !Number.isFinite(row.version)) return null;
  return {
    enabled: row.enabled,
    version: row.version,
    note: typeof row.note === "string" && row.note.trim() ? row.note : null,
    stale: row.stale === true,
  };
}

export function TerminalSessionsSetting() {
  const [enabled, setEnabled] = useState(false);
  const [version, setVersion] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [ask, setAsk] = useState(false);
  const gen = useRef(0);

  useEffect(() => {
    const mine = ++gen.current;
    setReady(false);
    setEnabled(false);
    setAsk(false);
    void invoke("terminal_mirror_status")
      .then((got) => {
        if (mine !== gen.current) return;
        const next = asStatus(got);
        if (!next) {
          setNote(TRY_AGAIN);
          setReady(true);
          return;
        }
        setEnabled(next.enabled);
        setVersion(next.version);
        setNote(next.note);
        setReady(true);
      })
      .catch(() => {
        if (mine !== gen.current) return;
        setNote(TRY_AGAIN);
        setReady(true);
      });
  }, []);

  async function save(next: boolean) {
    const mine = ++gen.current;
    try {
      const got = asStatus(await invoke("terminal_mirror_set", { enabled: next, expectedVersion: version }));
      if (mine !== gen.current) return;
      if (!got) {
        setNote(TRY_AGAIN);
        return;
      }
      setEnabled(got.enabled);
      setVersion(got.version);
      setNote(got.stale ? "That changed somewhere else. Try again." : got.note);
      setAsk(false);
    } catch (error) {
      if (mine !== gen.current) return;
      setNote(typeof error === "string" && error.trim() ? error : TRY_AGAIN);
    }
  }

  return (
    <div className="px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] text-content">Show my terminal Claude sessions</p>
          {note ? <p className="mt-0.5 text-[12px] text-content/60">{note}</p> : null}
        </div>
        <button
          type="button"
          role="switch"
          aria-label="Show my terminal Claude sessions"
          aria-checked={enabled}
          disabled={!ready}
          onClick={() => {
            if (!ready) return;
            if (!enabled) {
              setAsk(true);
              return;
            }
            void save(false);
          }}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${enabled ? "bg-accent" : "bg-content/20"} disabled:opacity-40`}
        >
          <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${enabled ? "left-4.5" : "left-0.5"}`} />
        </button>
      </div>
      {ask && !enabled ? (
        <div className="mt-2">
          <ul className="space-y-0.5 text-[12px] text-content/70">
            {INSTALL_PREVIEW.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <button type="button" className="mt-2 text-[12px] text-content" onClick={() => void save(true)}>
            Turn it on
          </button>
        </div>
      ) : null}
    </div>
  );
}

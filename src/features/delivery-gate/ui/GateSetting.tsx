// Hivra WP-81: per project, off until the person turns it on. A late reply cannot overwrite a newer project.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { playCue } from "../../settings/model/sounds";

const TRY_AGAIN = "That didn't go through. Try again.";

type Setting = {
  enabled: boolean;
  version: number;
  note: string | null;
};

function asSetting(value: unknown): Setting | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.enabled !== "boolean") return null;
  if (typeof row.version !== "number" || !Number.isFinite(row.version)) return null;
  const note = typeof row.note === "string" ? row.note : null;
  return { enabled: row.enabled, version: row.version, note };
}

function message(error: unknown): string {
  return typeof error === "string" && error.trim() ? error : TRY_AGAIN;
}

export function GateSetting({ project }: { project: string }) {
  const [enabled, setEnabled] = useState(false);
  const [version, setVersion] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const gen = useRef(0);
  const projectNow = useRef(project);
  projectNow.current = project;

  useEffect(() => {
    const mine = ++gen.current;
    const folder = project.trim();
    // The previous project's on/off must not stay on screen while this one loads.
    setReady(false);
    setEnabled(false);
    setVersion(0);
    setNote(null);
    if (!folder) return;
    void invoke("gate_setting_get", { project: folder })
      .then((got) => {
        if (mine !== gen.current) return;
        const next = asSetting(got);
        if (!next) {
          setNote(TRY_AGAIN);
          return;
        }
        setEnabled(next.enabled);
        setVersion(next.version);
        setNote(next.note);
        setReady(true);
      })
      .catch((error: unknown) => {
        if (mine !== gen.current) return;
        setNote(message(error));
      });
  }, [project]);

  async function toggle() {
    const folder = projectNow.current.trim();
    if (!folder || !ready) return;
    const mine = ++gen.current;
    const next = !enabled;
    try {
      const got = asSetting(
        await invoke("gate_setting_set", { project: folder, enabled: next, expectedVersion: version }),
      );
      if (mine !== gen.current) return;
      if (!got) {
        setNote(TRY_AGAIN);
        return;
      }
      setEnabled(got.enabled);
      setVersion(got.version);
      setNote(got.note);
      playCue("switch");
    } catch (error) {
      if (mine !== gen.current) return;
      setNote(message(error));
    }
  }

  return (
    <div className="flex items-start justify-between gap-3 border-b border-stroke px-3 py-2">
      <div className="min-w-0">
        <p className="text-[13px] text-content">Check work before it goes to GitHub</p>
        {note ? <p className="mt-0.5 text-[12px] text-content/60">{note}</p> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-label="Check work before it goes to GitHub"
        aria-checked={enabled}
        disabled={!project.trim() || !ready}
        onClick={() => void toggle()}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${enabled ? "bg-accent" : "bg-content/20"}`}
      >
        <span
          className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${enabled ? "left-4.5" : "left-0.5"}`}
        />
      </button>
    </div>
  );
}

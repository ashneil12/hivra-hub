// WP-162: per project, off until the person turns it on. A late reply cannot overwrite a newer project.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { playCue } from "../../settings/model/sounds";

const TRY_AGAIN = "That didn't go through. Try again.";
const HELP =
  "When this is off, a conflict is only reported. Nothing is merged or rebased, and main is never changed.";

type Strategy = "merge" | "rebase";

type Setting = {
  updateConflicting: boolean;
  strategy: Strategy;
  version: number;
};

function asStrategy(value: unknown): Strategy | null {
  return value === "merge" || value === "rebase" ? value : null;
}

function asSetting(value: unknown): Setting | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const strategy = asStrategy(row.strategy);
  if (typeof row.updateConflicting !== "boolean" || !strategy) return null;
  if (typeof row.version !== "number" || !Number.isFinite(row.version)) return null;
  return { updateConflicting: row.updateConflicting, strategy, version: row.version };
}

function message(error: unknown): string {
  return typeof error === "string" && error.trim() ? error : TRY_AGAIN;
}

export function ProgrammeUpdateSetting({ project }: { project: string }) {
  const [updateConflicting, setUpdateConflicting] = useState(false);
  const [strategy, setStrategy] = useState<Strategy>("merge");
  const [version, setVersion] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const gen = useRef(0);
  const projectNow = useRef(project);
  projectNow.current = project;

  useEffect(() => {
    const mine = ++gen.current;
    const folder = project.trim();
    setReady(false);
    setUpdateConflicting(false);
    setStrategy("merge");
    setVersion(0);
    setNote(null);
    if (!folder) return;
    void invoke("programme_update_settings_get", { project: folder })
      .then((got) => {
        if (mine !== gen.current) return;
        const next = asSetting(got);
        if (!next) {
          setNote(TRY_AGAIN);
          return;
        }
        setUpdateConflicting(next.updateConflicting);
        setStrategy(next.strategy);
        setVersion(next.version);
        setReady(true);
      })
      .catch((error: unknown) => {
        if (mine !== gen.current) return;
        setNote(message(error));
      });
  }, [project]);

  async function save(nextOn: boolean, nextStrategy: Strategy) {
    const folder = projectNow.current.trim();
    if (!folder || !ready) return;
    const mine = ++gen.current;
    try {
      const got = asSetting(
        await invoke("programme_update_settings_set", {
          project: folder,
          updateConflicting: nextOn,
          strategy: nextStrategy,
          expectedVersion: version,
        }),
      );
      if (mine !== gen.current) return;
      if (!got) {
        setNote(TRY_AGAIN);
        return;
      }
      setUpdateConflicting(got.updateConflicting);
      setStrategy(got.strategy);
      setVersion(got.version);
      setNote(null);
      playCue("switch");
    } catch (error) {
      if (mine !== gen.current) return;
      setNote(message(error));
    }
  }

  const folder = project.trim();
  const locked = !folder || !ready;

  return (
    <div className="border-b border-stroke px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] text-content">Update conflicting packages from main</p>
          <p className="mt-0.5 text-[12px] text-content/60">{HELP}</p>
          {note ? <p className="mt-0.5 text-[12px] text-content/60">{note}</p> : null}
        </div>
        <button
          type="button"
          role="switch"
          aria-label="Update conflicting packages from main"
          aria-checked={updateConflicting}
          disabled={locked}
          onClick={() => void save(!updateConflicting, strategy)}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${updateConflicting ? "bg-accent" : "bg-content/20"}`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${updateConflicting ? "left-4.5" : "left-0.5"}`}
          />
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <p className="text-[12px] text-content/60">Bring main in by</p>
        <button
          type="button"
          aria-pressed={strategy === "merge"}
          disabled={locked}
          onClick={() => void save(updateConflicting, "merge")}
          className="text-[13px] text-content"
        >
          Merge
        </button>
        <button
          type="button"
          aria-pressed={strategy === "rebase"}
          disabled={locked}
          onClick={() => void save(updateConflicting, "rebase")}
          className="text-[13px] text-content"
        >
          Rebase
        </button>
      </div>
    </div>
  );
}

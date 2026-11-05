// WP-77: per project, off until the person turns it on. A late reply cannot overwrite a newer project.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { playCue } from "../../settings/model/sounds";

const TRY_AGAIN = "That didn't go through. Try again.";

type Setting = {
  enabled: boolean;
  label: string;
  repo: string | null;
  version: number;
  stale: boolean;
  note: string | null;
};

function asSetting(value: unknown): Setting | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.enabled !== "boolean" || typeof row.label !== "string") return null;
  if (typeof row.version !== "number" || !Number.isFinite(row.version)) return null;
  return {
    enabled: row.enabled,
    label: row.label,
    repo: typeof row.repo === "string" ? row.repo : null,
    version: row.version,
    stale: row.stale === true,
    note: typeof row.note === "string" ? row.note : null,
  };
}

function message(error: unknown): string {
  return typeof error === "string" && error.trim() ? error : TRY_AGAIN;
}

export function GithubIssuesSetting({ project }: { project: string }) {
  const [enabled, setEnabled] = useState(false);
  const [label, setLabel] = useState("hivra");
  const [repo, setRepo] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const gen = useRef(0);
  const projectNow = useRef(project);
  projectNow.current = project;

  const storedLabel = useRef("hivra");

  function apply(next: Setting) {
    storedLabel.current = next.label || "hivra";
    setEnabled(next.enabled);
    setLabel(next.label || "hivra");
    setRepo(next.repo);
    setVersion(next.version);
    setNote(next.note);
    setReady(true);
  }

  useEffect(() => {
    const mine = ++gen.current;
    const folder = project.trim();
    setReady(false);
    setEnabled(false);
    setLabel("hivra");
    setRepo(null);
    setVersion(0);
    setNote(null);
    if (!folder) return;
    void invoke("github_issues_setting_get", { project: folder })
      .then((got) => {
        if (mine !== gen.current) return;
        const next = asSetting(got);
        if (!next) {
          setNote(TRY_AGAIN);
          return;
        }
        apply(next);
      })
      .catch((error: unknown) => {
        if (mine !== gen.current) return;
        setNote(message(error));
      });
  }, [project]);

  async function save(nextEnabled: boolean, nextLabel: string) {
    const folder = projectNow.current.trim();
    if (!folder || !ready) return;
    const mine = ++gen.current;
    try {
      const got = asSetting(
        await invoke("github_issues_setting_set", {
          project: folder,
          enabled: nextEnabled,
          label: nextLabel.trim() || "hivra",
          expectedVersion: version,
        }),
      );
      if (mine !== gen.current) return;
      if (!got) {
        setNote(TRY_AGAIN);
        return;
      }
      apply(got);
      playCue("switch");
    } catch (error) {
      if (mine !== gen.current) return;
      setNote(message(error));
    }
  }

  const shown = label.trim() || "hivra";
  return (
    <div className="border-b border-stroke px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] text-content">Take GitHub issues labelled …</p>
          {repo ? <p className="mt-0.5 text-[12px] text-content/60">{repo}</p> : null}
          {note ? <p className="mt-0.5 text-[12px] text-content/60">{note}</p> : null}
        </div>
        <button
          type="button"
          role="switch"
          aria-label={`Take GitHub issues labelled ${shown}`}
          aria-checked={enabled}
          disabled={!project.trim() || !ready}
          onClick={() => void save(!enabled, shown)}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${enabled ? "bg-accent" : "bg-content/20"}`}
        >
          <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${enabled ? "left-4.5" : "left-0.5"}`} />
        </button>
      </div>
      <label className="mt-2 block text-[12px] text-content/70">
        Label
        <input
          aria-label="Label"
          value={label}
          disabled={!project.trim() || !ready}
          onChange={(event) => setLabel(event.target.value)}
          onBlur={() => {
            const next = label.trim() || "hivra";
            if (ready && next !== storedLabel.current) void save(enabled, next);
          }}
          className="mt-1 w-full rounded-md border border-stroke bg-transparent px-2 py-1 text-[12px] text-content"
        />
      </label>
    </div>
  );
}

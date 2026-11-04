// WP-13: the ordered crew rules a person edits. Plugin rules are shown underneath and are not editable.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CLI_ORDER, EFFORTS, cliLabel } from "../model/clis";
import { draftRule, moveRule, type RuleDraft } from "../model/rules";
import { defaultLine, type Presence } from "../model/resolve";

export type ShownRule = {
  labels: string[];
  paths: string[];
  cli?: string;
  model?: string;
  effort?: string;
};

type Row = RuleDraft;

type Loaded = {
  rules?: ShownRule[];
  plugins?: ShownRule[];
  revision?: number;
  signedIn?: Presence[];
};

const EMPTY: Row = { labels: "", paths: "", cli: "", model: "", effort: "" };

function toRow(rule: ShownRule): Row {
  return {
    labels: rule.labels.join(", "),
    paths: rule.paths.join(", "),
    cli: rule.cli ?? "",
    model: rule.model ?? "",
    effort: rule.effort ?? "",
  };
}

function ruleText(rule: ShownRule): string {
  const match = rule.labels.length > 0 ? rule.labels.join(", ") : rule.paths.join(", ");
  const pick = [rule.cli ? cliLabel(rule.cli) : "", rule.model ?? "", rule.effort ?? ""].filter(Boolean).join(", ");
  return pick ? `${match} uses ${pick}` : match;
}

type Props = {
  cwd?: string;
  /** When set, the page never calls the app. The browser spec and tests use this. */
  initial?: { rules: ShownRule[]; plugins: ShownRule[]; signedIn: Presence[] };
};

export function CrewRulesPage({ cwd, initial }: Props) {
  const [scope, setScope] = useState<"project" | "mono">("project");
  const [monoId, setMonoId] = useState("");
  const [rows, setRows] = useState<Row[]>(() => (initial?.rules ?? []).map(toRow));
  const [plugins, setPlugins] = useState<ShownRule[]>(initial?.plugins ?? []);
  const [signedIn, setSignedIn] = useState<Presence[]>(initial?.signedIn ?? []);
  const [draft, setDraft] = useState<Row>(EMPTY);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const loadGen = useRef(0);

  useEffect(() => {
    if (initial) return;
    const scopeId = scope === "project" ? (cwd ?? "").trim() : monoId.trim();
    if (!scopeId) return;
    const mine = ++loadGen.current;
    let alive = true;
    invoke<Loaded | undefined>("crew_rules_get", { scope, scopeId, project: cwd ?? null })
      .then((got) => {
        if (!alive || mine !== loadGen.current || !got || typeof got !== "object") return;
        setRows(Array.isArray(got.rules) ? got.rules.map(toRow) : []);
        setPlugins(Array.isArray(got.plugins) ? got.plugins : []);
        setRevision(typeof got.revision === "number" ? got.revision : 0);
        if (Array.isArray(got.signedIn)) setSignedIn(got.signedIn);
      })
      .catch(() => {
        if (alive && mine === loadGen.current) {
          setNotice("The saved rules couldn't be read. You can still edit, and saving will try again.");
        }
      });
    return () => {
      alive = false;
    };
  }, [initial, scope, monoId, cwd]);

  function add() {
    const made = draftRule(draft);
    if (typeof made === "string") {
      setNotice(made);
      return;
    }
    setRows((current) => [...current, toRow(made)]);
    setDraft(EMPTY);
    setNotice(null);
  }

  async function save() {
    if (initial) return;
    const scopeId = scope === "project" ? (cwd ?? "").trim() : monoId.trim();
    if (!scopeId) {
      setNotice(scope === "project" ? "Open a project first." : "Name the Mono first.");
      return;
    }
    const rules = [];
    for (const row of rows) {
      const made = draftRule(row);
      if (typeof made === "string") {
        setNotice(made);
        return;
      }
      rules.push({ labels: made.labels, paths: made.paths, cli: made.cli ?? null, model: made.model ?? null, effort: made.effort ?? null });
    }
    try {
      const got = await invoke<Loaded | undefined>("crew_rules_set", {
        scope,
        scopeId,
        project: cwd ?? null,
        rules,
        revision,
        budget: null,
      });
      if (got && typeof got.revision === "number") setRevision(got.revision);
      setNotice("Saved.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Those rules couldn't be saved.");
    }
  }

  return (
    <section className="flex flex-col gap-4" data-setting-id="crew-rules">
      <h2 className="text-sm font-medium text-content">Crew</h2>
      <p className="text-[13px] text-content/70">
        Each task uses the first rule that matches. Yours come first. A plugin's rules sit underneath.
      </p>
      <p className="text-[13px] text-content/80">{defaultLine(signedIn)}</p>
      <div className="flex gap-2" role="group" aria-label="Where these rules apply">
        <button
          type="button"
          className="rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85"
          aria-pressed={scope === "project"}
          onClick={() => setScope("project")}
        >
          This project
        </button>
        <button
          type="button"
          className="rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85"
          aria-pressed={scope === "mono"}
          onClick={() => setScope("mono")}
        >
          A Mono
        </button>
      </div>
      {scope === "mono" ? (
        <label className="flex flex-col gap-1 text-xs text-content/70">
          Mono
          <input
            aria-label="Mono"
            className="rounded-md border border-content/15 bg-transparent px-2 py-1 text-[13px] text-content"
            value={monoId}
            onChange={(event) => setMonoId(event.target.value)}
          />
        </label>
      ) : null}
      <ol className="flex flex-col gap-3">
        {rows.map((row, index) => (
          <li key={index} className="flex flex-wrap items-end gap-2" data-crew-rule>
            <Field label={`Labels for rule ${index + 1}`} value={row.labels} onChange={(labels) => update(index, { labels })} />
            <Field label={`Paths for rule ${index + 1}`} value={row.paths} onChange={(paths) => update(index, { paths })} />
            <Select
              label={`CLI for rule ${index + 1}`}
              value={row.cli}
              options={CLI_ORDER.map((cli) => [cli, cliLabel(cli)])}
              onChange={(cli) => update(index, { cli })}
            />
            <Field label={`Model for rule ${index + 1}`} value={row.model} onChange={(model) => update(index, { model })} />
            <Select
              label={`Effort for rule ${index + 1}`}
              value={row.effort}
              options={EFFORTS.map((effort) => [effort, effort])}
              onChange={(effort) => update(index, { effort })}
            />
            <button type="button" className="rounded-md bg-content/8 px-2 py-1 text-xs" aria-label={`Move rule ${index + 1} up`} disabled={index === 0} onClick={() => setRows((current) => moveRule(current, index, -1))}>
              Move up
            </button>
            <button type="button" className="rounded-md bg-content/8 px-2 py-1 text-xs" aria-label={`Move rule ${index + 1} down`} disabled={index === rows.length - 1} onClick={() => setRows((current) => moveRule(current, index, 1))}>
              Move down
            </button>
            <button type="button" className="rounded-md bg-content/8 px-2 py-1 text-xs" aria-label={`Remove rule ${index + 1}`} onClick={() => setRows((current) => current.filter((_, at) => at !== index))}>
              Remove
            </button>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Labels for a new rule" value={draft.labels} onChange={(labels) => setDraft({ ...draft, labels })} />
        <Field label="Paths for a new rule" value={draft.paths} onChange={(paths) => setDraft({ ...draft, paths })} />
        <Select label="CLI for a new rule" value={draft.cli} options={CLI_ORDER.map((cli) => [cli, cliLabel(cli)])} onChange={(cli) => setDraft({ ...draft, cli })} />
        <Field label="Model for a new rule" value={draft.model} onChange={(model) => setDraft({ ...draft, model })} />
        <Select label="Effort for a new rule" value={draft.effort} options={EFFORTS.map((effort) => [effort, effort])} onChange={(effort) => setDraft({ ...draft, effort })} />
        <button type="button" className="rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base" onClick={add}>
          Add rule
        </button>
      </div>
      {plugins.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-xs text-content/60">From plugins</h3>
          <ul className="flex flex-col gap-1">
            {plugins.map((rule, index) => (
              <li key={index} data-plugin-rule className="text-[13px] text-content/75">
                {ruleText(rule)}. From a plugin
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {notice ? <p className="text-[13px] text-content/80">{notice}</p> : null}
      {initial ? null : (
        <button type="button" className="self-start rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base" onClick={() => void save()}>
          Save
        </button>
      )}
    </section>
  );

  function update(index: number, patch: Partial<Row>) {
    setRows((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  }
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-content/70">
      {label}
      <input
        aria-label={label}
        className="rounded-md border border-content/15 bg-transparent px-2 py-1 text-[13px] text-content"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-content/70">
      {label}
      <select
        aria-label={label}
        className="rounded-md border border-content/15 bg-transparent px-2 py-1 text-[13px] text-content"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Any</option>
        {options.map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

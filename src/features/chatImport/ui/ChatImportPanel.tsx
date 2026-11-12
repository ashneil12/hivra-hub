// Bring your chats over: find every past Claude Code and Codex chat, pick what comes in and where, then bring it in
// while the app stays usable. The same panel serves Settings and first run. It takes the run as a prop, so a browser
// test can drive it without Tauri.

import { useSyncExternalStore } from "react";
import { formatDay } from "../../historyImport/model/preview";
import {
  keepNewest,
  mergeLookAlikes,
  summarize,
  SOURCE_TITLE,
  type Choices,
  type Group,
  type ProjectRef,
} from "../model/plan";
import type { ChatImportRun, ImportState } from "../model/runner";

const BTN =
  "shrink-0 rounded-md border border-content/20 px-2.5 py-1 text-xs text-content/85 hover:bg-content/8 disabled:opacity-50";
const PRIMARY =
  "rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base hover:opacity-90 disabled:opacity-50";
const PILL = "h-7 rounded-full px-3 text-[12px]";

const DAY = 86_400_000;
export const SINCE: { id: string; label: string; days: number | null }[] = [
  { id: "all", label: "All time", days: null },
  { id: "year", label: "Last year", days: 365 },
  { id: "half", label: "Last 6 months", days: 182 },
  { id: "quarter", label: "Last 3 months", days: 91 },
  { id: "month", label: "Last month", days: 30 },
];

const n = (value: number) => value.toLocaleString("en-GB");
const plural = (count: number, one: string, many = `${one}s`) => `${n(count)} ${count === 1 ? one : many}`;

export function useImportState(run: ChatImportRun): ImportState {
  return useSyncExternalStore(run.subscribe, run.get, run.get);
}

/** One line for anywhere in the app while a run is going. Empty when there is nothing to say. */
export function importStatusLine(state: ImportState): string {
  if (state.phase === "finding") return `Looking through your past chats: ${n(state.seen)} found so far.`;
  if (state.phase === "importing") return `Bringing in your chats: ${n(state.done)} of ${n(state.toImport)}.`;
  if (state.phase === "done")
    return `Brought in ${plural(state.imported, "chat")}${state.projectsMade ? ` and started ${plural(state.projectsMade, "project")}` : ""}.`;
  return "";
}

function sinceId(fromMs: number | null, now: number): string {
  if (fromMs == null) return "all";
  const days = Math.round((now - fromMs) / DAY);
  return SINCE.find((item) => item.days === days)?.id ?? "all";
}

function sourcesText(sources: readonly string[]): string {
  return sources.map((source) => SOURCE_TITLE[source as keyof typeof SOURCE_TITLE] ?? source).join(" and ");
}

export type ChatImportPanelProps = {
  run: ChatImportRun;
  /** Projects the app has, for "Goes into". */
  projects: ProjectRef[];
  /** Fixed in tests. */
  now?: number;
  /** First run shows a shorter heading. */
  compact?: boolean;
};

export function ChatImportPanel({ run, projects, now = Date.now(), compact }: ChatImportPanelProps) {
  const state = useImportState(run);
  return (
    <section className="flex max-w-2xl flex-col gap-4" data-chat-import data-phase={state.phase}>
      {compact ? null : (
        <div>
          <h2 className="text-[15px] font-medium text-content">Bring your chats over</h2>
          <p className="mt-1 text-[13px] leading-5 text-content/60">
            Your past Claude Code and Codex chats come in as projects and chats here. You choose what comes in and where.
            Nothing in those tools' own folders is changed.
          </p>
        </div>
      )}
      {state.phase === "idle" ? (
        <div>
          <button type="button" className={PRIMARY} data-chat-import-find onClick={() => void run.find()}>
            Find my chats
          </button>
        </div>
      ) : null}
      {state.phase === "finding" ? (
        <Working line={`Looking through your chats: ${n(state.seen)}${state.total ? ` of ${n(state.total)}` : ""} found.`} onCancel={() => run.cancel()} />
      ) : null}
      {state.phase === "ready" && state.choices ? (
        <Picker state={state} choices={state.choices} projects={projects} now={now} run={run} />
      ) : null}
      {state.phase === "importing" ? (
        <Working
          line={`Bringing in your chats: ${n(state.done)} of ${n(state.toImport)}. You can keep using the app while this runs.`}
          onCancel={() => run.cancel()}
        />
      ) : null}
      {state.phase === "done" || state.phase === "cancelled" || state.phase === "failed" ? <Finished state={state} run={run} /> : null}
    </section>
  );
}

function Working({ line, onCancel }: { line: string; onCancel: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <p className="text-[13px] text-content/70" data-chat-import-progress>
        {line}
      </p>
      <button type="button" className={BTN} data-chat-import-cancel onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

function Finished({ state, run }: { state: ImportState; run: ChatImportRun }) {
  const left: string[] = [];
  if (state.alreadyHere) left.push(`${plural(state.alreadyHere, "chat was", "chats were")} already here`);
  if (state.oneShots) left.push(`${plural(state.oneShots, "chat")} where you wrote only once ${state.oneShots === 1 ? "was" : "were"} left out`);
  if (state.failed) left.push(`${plural(state.failed, "chat")} couldn't be read`);
  if (state.cut) left.push(`${plural(state.cut, "very long chat")} came in with its start only`);
  const head =
    state.phase === "failed"
      ? `That stopped: ${state.error ?? "something went wrong"}. Nothing was lost; you can run it again.`
      : state.phase === "cancelled"
        ? `Stopped. ${plural(state.imported, "chat")} came in before you stopped it.`
        : `Brought in ${plural(state.imported, "chat")}${state.projectsMade ? ` and started ${plural(state.projectsMade, "project")}` : ""}.`;
  return (
    <div className="flex flex-col gap-2" data-chat-import-result>
      <p className="text-[13px] text-content">{head}</p>
      {left.length ? <p className="text-[13px] text-content/60">{left.join(". ")}.</p> : null}
      <div>
        <button type="button" className={BTN} data-chat-import-again onClick={() => run.reset()}>
          Start again
        </button>
      </div>
    </div>
  );
}

function Picker({
  state,
  choices,
  projects,
  now,
  run,
}: {
  state: ImportState;
  choices: Choices;
  projects: ProjectRef[];
  now: number;
  run: ChatImportRun;
}) {
  const groups = state.groups;
  const total = groups.reduce((sum, group) => sum + group.chats, 0);
  const summary = summarize(groups, choices, projects);
  const set = (next: Choices) => run.choose(next);
  const since = sinceId(choices.fromMs, now);
  if (state.missing.length === 2) {
    return (
      <p className="text-[13px] text-content/70" data-chat-import-empty>
        No Claude Code or Codex chats were found on this computer.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-content/70" data-chat-import-found>
        Found {plural(total, "chat")} in {plural(groups.length, "folder")}.
        {state.active ? ` ${plural(state.active, "chat")} still being written ${state.active === 1 ? "was" : "were"} left for later.` : ""}
      </p>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Chats from">
        {SINCE.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={since === item.id}
            data-chat-import-since={item.id}
            className={`${PILL} ${since === item.id ? "bg-content text-background-base" : "border border-content/20 text-content/80"}`}
            onClick={() => set({ ...choices, fromMs: item.days == null ? null : now - item.days * DAY })}
          >
            {item.label}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-[13px] text-content">
        <input
          type="checkbox"
          data-chat-import-one-shots
          checked={choices.skipOneShots}
          onChange={() => set({ ...choices, skipOneShots: !choices.skipOneShots })}
        />
        Leave out chats where you wrote only once (scripts and quick one-off runs)
      </label>
      {total === 0 ? (
        <p className="text-[13px] text-content/70" data-chat-import-empty>
          No chats in that time. Pick a longer time above.
        </p>
      ) : null}
      <ul className="flex flex-col divide-y divide-stroke rounded-lg border border-stroke empty:hidden" data-chat-import-groups>
        {groups.map((group) => (
          <GroupRow key={group.key || "none"} group={group} groups={groups} choices={choices} projects={projects} onChange={set} />
        ))}
      </ul>
      <div className="flex items-center gap-3">
        <button
          type="button"
          className={PRIMARY}
          data-chat-import-go
          disabled={summary.chats === 0}
          onClick={() => void run.bringIn()}
        >
          Bring in {plural(summary.chats, "chat")}
        </button>
        <p className="text-[12px] text-content/60">
          {summary.newProjects ? `${plural(summary.newProjects, "new project")}, ` : ""}
          {plural(summary.projects, "project")} in all. It runs in the background.
        </p>
      </div>
    </div>
  );
}

function GroupRow({
  group,
  groups,
  choices,
  projects,
  onChange,
}: {
  group: Group;
  groups: Group[];
  choices: Choices;
  projects: ProjectRef[];
  onChange: (next: Choices) => void;
}) {
  const choice = choices.groups[group.key] ?? { take: false };
  const homeless = !group.exists && !group.existing;
  const update = (patch: Partial<typeof choice>) =>
    onChange({ ...choices, groups: { ...choices.groups, [group.key]: { ...choice, ...patch } } });
  const others = groups.filter((other) => other.key !== group.key && other.key && (other.exists || other.existing));
  const lookAlikes = groups.filter((other) => group.lookAlikes.includes(other.key));
  const value = choice.into ?? "";
  const label = group.key ? group.name : "Chats with no folder";
  const notes: string[] = [];
  notes.push(`${plural(group.chats, "chat")} from ${sourcesText(group.sources)}, ${formatDay(group.firstMs)} to ${formatDay(group.lastMs)}`);
  if (group.existing) notes.push("Already a project here, so they go into it");
  if (group.worktrees) notes.push(`Includes ${plural(group.worktrees, "worktree")} of this repo`);
  if (homeless && group.key) notes.push("This folder is gone, so pick a project for these chats");
  if (!group.key) notes.push("Pick a project for these chats");
  return (
    <li className="flex flex-col gap-1.5 px-3 py-2.5" data-chat-import-group={group.key || "none"}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          role="checkbox"
          aria-checked={choice.take}
          aria-label={`Bring in ${label}`}
          data-chat-import-take
          disabled={homeless && !choice.into}
          className={`grid size-4 shrink-0 place-items-center rounded border ${choice.take ? "border-content bg-content text-background-base" : "border-content/40"} disabled:opacity-50`}
          onClick={() => update({ take: !choice.take })}
        >
          {choice.take ? <span className="text-[10px] leading-none">✓</span> : null}
        </button>
        <span className="min-w-0 flex-1 truncate text-[13px] text-content" title={group.key}>
          {label}
        </span>
        <select
          aria-label={`Where ${label} goes`}
          data-chat-import-into
          className="max-w-[45%] rounded-md bg-content/8 px-2 py-1 text-[12px] text-content"
          value={value}
          onChange={(event) => update({ into: event.target.value || undefined, take: event.target.value ? true : choice.take })}
        >
          <option value="">{homeless ? "Pick a project" : group.existing ? "Its project here" : "Its own project"}</option>
          {others.map((other) => (
            <option key={other.key} value={other.key}>
              Into {other.name}
            </option>
          ))}
          {projects
            .filter((project) => project.id !== group.existing?.id && !others.some((other) => other.existing?.id === project.id))
            .map((project) => (
              <option key={project.id} value={`project:${project.id}`}>
                Into {project.name}
              </option>
            ))}
        </select>
      </div>
      <p className="pl-6 text-[12px] text-content/60">{notes.join(". ")}.</p>
      {lookAlikes.length ? (
        <div className="flex flex-wrap items-center gap-2 pl-6" data-chat-import-lookalike>
          <span className="text-[12px] text-content/70">Looks like {lookAlikes.map((other) => other.name).join(", ")}.</span>
          <button type="button" className={BTN} data-chat-import-merge onClick={() => onChange(mergeLookAlikes(choices, groups, group.key))}>
            Merge into one
          </button>
          <button type="button" className={BTN} data-chat-import-newest onClick={() => onChange(keepNewest(choices, groups, group.key))}>
            Keep only the newest
          </button>
        </div>
      ) : null}
    </li>
  );
}

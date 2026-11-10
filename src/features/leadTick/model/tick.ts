// WP-160: one lead tick for one project. Plain code, no model and no tokens: it reads the programme (WP-159), reads CI
// for the programme's pull requests through the PR watch, sends a green one to the project's one merge path only when
// the person turned Ship on green on (and never a parked or never-merge package), and starts the next queued package
// through the First Mate's own delegate_task when a builder slot is free. The lead never edits the project itself
// (WP-10): a worker builds the package. Every step goes through ports, so each is tested with fakes.
//
// The WP-155 helper (scripts/hivra-ship-green.mjs) is what a person runs by hand; it only reports. Inside the app the
// merge goes through delivery's merge path (src-tauri/src/delivery/merge.rs), which reads the pull request fresh,
// refuses red, pending, draft and conflicting ones and open decisions, pins the head and logs who allowed it. It merges
// without asking only when the project's "merge without asking" is on; otherwise it asks the person.

import type { ProgrammePackage, ProgrammeStatus } from "../../programme/model/programme";

/** What the tick reads from a PR watch (pr_watch.rs `Watch`). */
export type TickWatch = {
  repo: string;
  number: number;
  title: string;
  headRef: string;
  headSha: string | null;
  state: "watching" | "ended";
  endReason: string | null;
  status: {
    pr: "open" | "merged" | "closed" | "";
    draft: boolean;
    checks: number;
    pending: number;
    failed: string[];
    passed: boolean;
    mergeable: "mergeable" | "conflicting" | "unknown" | "";
  };
};

/** delivery_merge's answer (merge.rs `MergeOutcome`). */
export type TickMergeOutcome =
  | { outcome: "merged"; headSha: string; allowedBy: string }
  | { outcome: "refused"; reason: string }
  | { outcome: "needsYou"; headSha: string; question: string };

export type SlotAnswer = { ok: true } | { ok: false; reason: string };

export type LeadTickPorts = {
  /** The project's programme, best first (programme_list). */
  list(): Promise<ProgrammePackage[]>;
  /** A status move on the version just read (programme_set_status). A stale version throws. */
  setStatus(id: string, version: number, status: ProgrammeStatus): Promise<ProgrammePackage>;
  /** Whether a new builder may start: worker limits and builder health (WP-161). `inFlight` is the programme's building packages. */
  slot(inFlight: number): SlotAnswer;
  /** The First Mate's delegate_task, under this request ID. */
  delegate(requestId: string, input: Record<string, unknown>): Promise<unknown>;
  /** The PR watches (pr_watch_list). */
  watches(): Promise<TickWatch[]>;
  /** The one merge path, as the First Mate (delivery_merge). */
  merge(repo: string, number: number): Promise<TickMergeOutcome>;
  /** One activity row. */
  note(line: string): void;
  /** One work log outcome line. */
  outcome(line: string): void;
};

export type LeadTickInput = {
  /** The project folder: the worker's project. */
  folder: string;
  shipOnGreen: boolean;
  /** Keys of things already said (store.ts `noted`). */
  noted: readonly string[];
};

export type LeadTickResult = {
  /** The short line for the Crew card and the activity log. */
  line: string;
  /** Things the person should hear about, each said once. */
  attention: string[];
  noted: string[];
};

/** The request ID a package starts under: the same claim never starts twice. */
export function tickRequestId(packageId: string, claimedVersion: number): string {
  return `lead-tick-${packageId}-${claimedVersion}`;
}

// ---- never merge: the WP-155 helper's rule (scripts/hivra-ship-green.mjs securityParkReason) ---------------------------

export const NEVER_MERGE_PACKAGES = ["WP-92", "WP-150", "WP-158"] as const;
const PARK_LABELS = new Set(["security-park", "never-merge", "never-merge-here"]);

function mentions(text: string, id: string): boolean {
  const match = /^WP-(\d+)$/.exec(id);
  if (!match || !text) return false;
  return new RegExp(`(?:^|[^A-Za-z0-9])(?:WP[-_ ]?${match[1]}|wp/${match[1]})(?![0-9])`, "i").test(text);
}

/** Why a pull request is never merged by the tick, or "" when it may be. */
export function neverMergeReason(pr: { title?: string; branch?: string; labels?: readonly string[] }): string {
  const labels = (pr.labels ?? []).map(String);
  for (const label of labels) {
    if (PARK_LABELS.has(label.trim().toLowerCase().replace(/[\s_]+/g, "-"))) return `security-park label ${label}`;
  }
  for (const id of NEVER_MERGE_PACKAGES) {
    for (const field of [pr.title ?? "", pr.branch ?? "", ...labels]) if (mentions(field, id)) return `never-merge package ${id}`;
  }
  const phrase = [pr.title ?? "", pr.branch ?? "", ...labels].join("\n");
  if (/security[-\s]+park/i.test(phrase) || /never\s+merge\s+here/i.test(phrase)) return "security-park title";
  return "";
}

// ---- the tick ------------------------------------------------------------------------------------------------------

/** The store matches branch names without case (programme enqueue and the open-row check), so the tick does too. */
function watchFor(row: ProgrammePackage, watches: readonly TickWatch[]): TickWatch | undefined {
  const branch = row.branch.toLowerCase();
  const mine = watches.filter((w) => w.headRef.toLowerCase() === branch);
  // A live watch first, then the latest ended one.
  return mine.find((w) => w.state === "watching") ?? mine[mine.length - 1];
}

function merged(watch: TickWatch): boolean {
  return watch.status.pr === "merged" || watch.endReason === "merged";
}

function green(watch: TickWatch): boolean {
  const s = watch.status;
  return s.pr === "open" && !s.draft && s.passed && s.failed.length === 0 && s.pending === 0 && s.mergeable !== "conflicting";
}

function brief(row: ProgrammePackage): Record<string, unknown> {
  return {
    title: `${row.wp}: ${row.title}`,
    intent: `The programme lists ${row.wp} (${row.title}) as the next package, and the lead tick started it.`,
    brief: [
      `Build programme package ${row.wp}: ${row.title}.`,
      `Read the brief at ${row.briefPath} fully and build every item in it, tests first.`,
      `Work on the branch ${row.branch}, push it and open a pull request from it.`,
      row.notes.trim() ? `Notes from the programme: ${row.notes.trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    goal: `A pull request from ${row.branch} is open with every item in the brief at ${row.briefPath} done and its checks passing.`,
    project: "",
    isolation: "worktree",
  };
}

function waiting(result: unknown): boolean {
  return !!result && typeof result === "object" && (result as { status?: unknown }).status === "waiting";
}

export async function runLeadTick(input: LeadTickInput, ports: LeadTickPorts): Promise<LeadTickResult> {
  const noted = new Set(input.noted);
  const did: string[] = [];
  const attention: string[] = [];
  const once = (key: string, line: string, into: string[]) => {
    if (noted.has(key)) return;
    noted.add(key);
    into.push(line);
  };
  const finish = (line: string): LeadTickResult => {
    const out = { line, attention, noted: [...noted] };
    if (did.length || attention.length) ports.note(`Lead tick: ${[...did, ...attention].join(" ")}`);
    return out;
  };

  // (a) the programme.
  let rows: ProgrammePackage[];
  try {
    rows = await ports.list();
  } catch {
    return finish("Couldn't read the programme. The next tick tries again.");
  }
  const open = rows.filter((row) => row.status !== "merged");
  if (!open.length) return finish("Nothing on the programme.");

  // (c) CI for the programme's pull requests, and (d) ship on green.
  const live = rows.filter((row) => row.status === "building" || row.status === "pr_open");
  let watches: TickWatch[] = [];
  if (live.length) {
    try {
      watches = await ports.watches();
    } catch {
      // The PR watch didn't answer: CI is read again next tick. Starting a package does not wait on it.
    }
  }
  for (const found of live) {
    let row = found;
    const watch = watchFor(row, watches);
    if (!watch) continue;
    const pr = `#${watch.number} (${row.wp})`;
    const head = watch.headSha ?? "";
    try {
      if (merged(watch)) {
        await ports.setStatus(row.id, row.version, "merged");
        ports.outcome(`Merged ${row.wp}: ${row.title} (#${watch.number}).`);
        did.push(`${row.wp} merged (#${watch.number}).`);
        continue;
      }
      if (watch.status.pr === "closed") {
        once(`closed:${row.id}:${watch.number}`, `${pr} was closed without merging.`, attention);
        continue;
      }
      if (row.status === "building") {
        row = await ports.setStatus(row.id, row.version, "pr_open");
        did.push(`${row.wp} is in review (#${watch.number}).`);
      }
    } catch {
      continue;
    }
    if (watch.status.failed.length) {
      once(`red:${watch.number}:${head}`, `CI failed on ${pr}: ${watch.status.failed.slice(0, 3).join(", ")}.`, attention);
      continue;
    }
    if (!green(watch)) continue;
    const park = row.securityPark || row.status === "parked" ? "security park" : neverMergeReason({ title: `${row.wp} ${watch.title}`, branch: row.branch });
    if (park) {
      once(`park:${watch.number}:${head}`, `${pr} is green but is parked for a security check and is never merged by the tick.`, attention);
      continue;
    }
    if (!input.shipOnGreen) {
      once(`green:${watch.number}:${head}`, `${pr} is green. Ship on green is off, so it waits for you.`, did);
      continue;
    }
    let outcome: TickMergeOutcome;
    try {
      outcome = await ports.merge(watch.repo, watch.number);
    } catch (error) {
      once(`merge-error:${watch.number}:${head}`, `Couldn't merge ${pr}: ${error instanceof Error ? error.message : String(error)}`, attention);
      continue;
    }
    if (outcome.outcome === "merged") {
      try {
        await ports.setStatus(row.id, row.version, "merged");
      } catch {
        // The next tick reads the watch and settles the row.
      }
      ports.outcome(`Merged ${row.wp}: ${row.title} (#${watch.number}).`);
      did.push(`Merged ${row.wp} (#${watch.number}).`);
    } else if (outcome.outcome === "needsYou") {
      once(`ask:${watch.number}:${outcome.headSha}`, `${pr} needs your word to merge: ${outcome.question}`, attention);
    } else {
      once(`refused:${watch.number}:${head}:${outcome.reason}`, `${pr} was not merged: ${outcome.reason}`, attention);
    }
  }

  // (b) start the next package when a builder slot is free. One per tick.
  const next = rows.find((row) => row.status === "queued" && !row.securityPark);
  let held = "";
  if (next) {
    const building = rows.filter((row) => row.status === "building").length;
    const slot = ports.slot(building);
    if (!slot.ok) {
      held = `${next.wp} waits: ${slot.reason}`;
    } else {
      let claimed: ProgrammePackage | undefined;
      try {
        claimed = await ports.setStatus(next.id, next.version, "building");
      } catch {
        // Another window claimed it, or it changed: the next tick reads it again.
      }
      if (claimed) {
        try {
          const result = await ports.delegate(tickRequestId(claimed.id, claimed.version), { ...brief(claimed), project: input.folder });
          did.push(
            waiting(result)
              ? `Started ${claimed.wp}; its brief is waiting for a fresh-eyes review or a free builder.`
              : `Started ${claimed.wp}.`,
          );
        } catch (error) {
          try {
            await ports.setStatus(claimed.id, claimed.version, "failed");
          } catch {
            // Left building; the person sees it on the programme.
          }
          attention.push(`Couldn't start ${claimed.wp}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  const parts = [...did, ...attention];
  if (held) parts.push(held);
  return finish(parts.length ? parts.join(" ") : "Nothing to do this tick.");
}

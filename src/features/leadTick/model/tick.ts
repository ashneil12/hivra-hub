// WP-160: one lead tick for one project. Plain code, no model and no tokens: it reads the programme (WP-159), reads CI
// for the programme's pull requests through the PR watch, sends a green one to the project's one merge path only when
// the person turned Ship on green on (and never a parked or never-merge package), and starts the next queued package
// through the First Mate's own delegate_task when a builder slot is free. The lead never edits the project itself
// (WP-10): a worker builds the package. Every step goes through ports, so each is tested with fakes.

import type { ProgrammePackage, ProgrammeStatus } from "../../programme/model/programme";
import neverMerge from "./neverMerge.json";

/** What the tick reads from a PR watch (pr_watch.rs `Watch`). */
export type TickWatch = {
  repo: string;
  number: number;
  title: string;
  headRef: string;
  headSha: string | null;
  /**
   * The project the watch belongs to: the project's hub id, or the project folder when a Crew delivery made the watch
   * (delivery names only the folder). Null when the watch names none.
   */
  project: string | null;
  state: "watching" | "ended";
  endReason: string | null;
  /** When the watch ended (ms), or null while it still watches. */
  endedAt: number | null;
  status: {
    pr: "open" | "merged" | "closed" | "";
    draft: boolean;
    checks: number;
    pending: number;
    failed: string[];
    passed: boolean;
    mergeable: "mergeable" | "conflicting" | "unknown" | "";
    /** The pull request's label names (pr_watch.rs `Status`). */
    labels: string[];
    /** Commits main has that the branch lacks (pr_watch.rs `Status`, WP-202). Absent on an older watch. */
    behind?: number;
    /** GitHub's merge state (pr_watch.rs `Status`, WP-202). Absent on an older watch. */
    mergeState?: string;
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
  /** The clock (ms): a building package with no pull request for STALE_BUILD_MS is settled. */
  now: number;
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

/** The longest said-once key the store keeps (store.ts reads and writes keys up to this length). */
export const NOTED_KEY_MAX = 300;
const PART_MAX = 64;

function hash(text: string): string {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * A said-once key. Short parts stay readable; a long part (a refusal's reason, a row id) becomes a hash, so a key always
 * fits NOTED_KEY_MAX and the same thing keeps the same key from one tick to the next.
 */
export function noteKey(...parts: string[]): string {
  const key = parts.map((part) => (part.length > PART_MAX ? `#${hash(part)}` : part)).join(":");
  return key.length > NOTED_KEY_MAX ? `#${hash(key)}` : key;
}

/** A building package with no pull request for this long holds a builder slot for nothing: the tick settles it. */
export const STALE_BUILD_MS = 6 * 60 * 60 * 1000;

// ---- never merge: the WP-155 helper's rule (scripts/hivra-ship-green.mjs securityParkReason) ---------------------------
// One list, read by the tick and by the helper (both from neverMerge.json).

export const NEVER_MERGE_PACKAGES: readonly string[] = neverMerge.packages;
const PARK_LABELS = new Set<string>(neverMerge.labels);

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

function folderKey(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

/**
 * The watch for this package: same branch (case-insensitive, as the store matches branches), same project (by hub id, or
 * by folder for a watch a Crew delivery made), and not one that ended before the package was claimed (that is an earlier
 * attempt). A live watch first, then the latest ended one.
 */
function watchFor(row: ProgrammePackage, watches: readonly TickWatch[], folder: string): TickWatch | undefined {
  const branch = row.branch.toLowerCase();
  const key = folderKey(folder);
  const mine = watches.filter((w) => {
    if (w.headRef.toLowerCase() !== branch) return false;
    const same = w.project === row.projectId || (w.project !== null && key !== "" && folderKey(w.project) === key);
    if (!same) return false;
    if (row.claimedAt !== null && w.endedAt !== null && w.endedAt < row.claimedAt) return false;
    return true;
  });
  return mine.find((w) => w.state === "watching") ?? mine[mine.length - 1];
}

/** Whether GitHub says the branch is behind main (WP-202): the merge state, or a count of commits behind. */
function behindMain(watch: TickWatch): boolean {
  return watch.status.mergeState === "BEHIND" || (watch.status.behind ?? 0) > 0;
}

function merged(watch: TickWatch): boolean {
  return watch.status.pr === "merged" || watch.endReason === "merged";
}

function green(watch: TickWatch): boolean {
  const s = watch.status;
  return s.pr === "open" && !s.draft && s.passed && s.failed.length === 0 && s.pending === 0 && s.mergeable !== "conflicting";
}

/** merge.rs's refusal for a pull request GitHub already merged: its exact words for this pull request, and nothing else. */
function alreadyMerged(reason: string, watch: TickWatch): boolean {
  return reason.trim().toLowerCase() === `${watch.repo}#${watch.number} is already merged.`.toLowerCase();
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

  // Builder slots in use: the building packages (a settled one below gives its slot back).
  let building = rows.filter((row) => row.status === "building").length;

  // (c) CI for the programme's pull requests, and (d) ship on green.
  const live = rows.filter((row) => row.status === "building" || row.status === "pr_open");
  let watches: TickWatch[] = [];
  let watchesRead = false;
  if (live.length) {
    try {
      watches = await ports.watches();
      watchesRead = true;
    } catch {
      // The PR watch didn't answer: CI is read again next tick. Starting a package does not wait on it.
    }
  }
  for (const found of live) {
    let row = found;
    const watch = watchFor(row, watches, input.folder);
    if (!watch) {
      // A building package with no pull request after 6 hours no longer holds a builder slot. Its status stays as it is: a
      // pull request that turns up later still moves it on. Not decided on a watch list that didn't answer.
      if (watchesRead && row.status === "building" && row.claimedAt !== null && input.now - row.claimedAt >= STALE_BUILD_MS) {
        building -= 1;
        once(
          noteKey("stale", row.id, String(found.claimedAt)),
          `${row.wp} has no pull request after 6 hours, so it no longer holds a builder slot.`,
          attention,
        );
      }
      continue;
    }
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
        // A building package whose pull request was closed unmerged is failed, so the builder slot it holds is free.
        let freed = "";
        if (row.status === "building") {
          row = await ports.setStatus(row.id, row.version, "failed");
          building -= 1;
          freed = ` ${row.wp} is marked failed and its builder slot is free.`;
        }
        once(noteKey("closed", row.id, String(watch.number)), `${pr} was closed without merging.${freed}`, attention);
        continue;
      }
      if (row.status === "building") {
        row = await ports.setStatus(row.id, row.version, "pr_open");
        did.push(`${row.wp} is in review (#${watch.number}).`);
      }
    } catch {
      continue;
    }
    // A red CI is said in the line, not as a ping: the PR watch already sends the ci-red notice for it.
    if (watch.status.failed.length) {
      once(noteKey("red", String(watch.number), head), `CI failed on ${pr}: ${watch.status.failed.slice(0, 3).join(", ")}.`, did);
      continue;
    }
    if (!green(watch)) continue;
    // WP-202: green on an old main is not green to merge. The crew updates the branch from main, pushes, and waits.
    if (behindMain(watch)) {
      once(noteKey("behind", String(watch.number), head), `${pr} is green but behind main: update it from main, push and wait for green again.`, attention);
      continue;
    }
    const park =
      row.securityPark || row.status === "parked"
        ? "security park"
        : neverMergeReason({ title: `${row.wp} ${watch.title}`, branch: row.branch, labels: watch.status.labels ?? [] });
    if (park) {
      once(noteKey("park", String(watch.number), head), `${pr} is green but is parked for a security check and is never merged by the tick.`, attention);
      continue;
    }
    if (!input.shipOnGreen) {
      once(noteKey("green", String(watch.number), head), `${pr} is green. Ship on green is off, so it waits for you.`, did);
      continue;
    }
    // The package is read again just before the merge: a park that landed while CI was being read holds it.
    let current: ProgrammePackage | undefined;
    try {
      current = (await ports.list()).find((r) => r.id === row.id);
    } catch {
      continue;
    }
    if (!current) continue;
    if (current.securityPark || current.status === "parked") {
      once(noteKey("park", String(watch.number), head), `${pr} is green but is parked for a security check and is never merged by the tick.`, attention);
      continue;
    }
    if (current.status === "merged") {
      did.push(`${current.wp} is already merged (#${watch.number}).`);
      continue;
    }
    // Only a package still in review merges: one that moved (failed, queued, back to building) while CI was read waits.
    if (current.status !== "pr_open") continue;
    row = current;
    let outcome: TickMergeOutcome;
    try {
      outcome = await ports.merge(watch.repo, watch.number);
    } catch (error) {
      once(
        noteKey("merge-error", String(watch.number), head),
        `Couldn't merge ${pr}: ${error instanceof Error ? error.message : String(error)}`,
        attention,
      );
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
      once(noteKey("ask", String(watch.number), outcome.headSha), `${pr} needs your word to merge: ${outcome.question}`, attention);
    } else if (alreadyMerged(outcome.reason, watch)) {
      // GitHub already has it: the package is settled, not refused.
      try {
        await ports.setStatus(row.id, row.version, "merged");
      } catch {
        // The next tick reads the watch and settles the row.
      }
      ports.outcome(`Merged ${row.wp}: ${row.title} (#${watch.number}).`);
      did.push(`${row.wp} is already merged (#${watch.number}).`);
    } else {
      once(noteKey("refused", String(watch.number), head, outcome.reason), `${pr} was not merged: ${outcome.reason}`, attention);
    }
  }

  // (b) start the next package when a builder slot is free. One per tick.
  const next = rows.find((row) => row.status === "queued" && !row.securityPark);
  let held = "";
  if (next) {
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

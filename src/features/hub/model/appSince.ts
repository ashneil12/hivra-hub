// The app's own share of Today's "Since …" paragraph (C9; Ash 14 Oct: "give me a quick summary of what's been happening
// since then"). Ash OS writes the paragraph about the projects' work; this adds, in the same plain words, what only the
// app knows since Ash was last active: the work his Monos handed out, what finished and reported back, what is stuck or
// failed, and the Bot changes made. Real events only; nothing here is invented, and with nothing new it says nothing.
//
// A pure function over the events, so a future model-written summary can take the same input (see `AppSinceInput`).
import type { Delegation } from "../../monos/model/delegations";
import type { StuckWorker } from "../../monos/model/workerStuck";

export type AppSinceInput = {
  /** Epoch ms Ash was last active (the start of "Since …"). */
  sinceMs: number;
  /** Every delegation row the app knows. */
  rows: readonly Delegation[];
  /** The workers stuck now. */
  stuck: readonly StuckWorker[];
  /** Bot changes that still stand, made since `sinceMs` (botChangesSince). */
  changes: readonly { bot: string; line: string }[];
  /** The Mono a row's work answers to, by name ("EXO lead"). */
  nameOf: (row: Delegation) => string;
  /**
   * Ash OS's jobs that are stuck or with Ash now, with when they last moved (epoch ms). They join the app's own stuck
   * and failed workers in ONE count and ONE list, so the paragraph never says "0 stuck or failed" next to "1 failed: …"
   * (PM 22 Oct): Ash OS's own sentences about stuck or failed work are left out of the paragraph (`withoutStuckTalk`).
   */
  jobs?: readonly { title: string; failed: boolean; at: number }[];
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "A, B and C"; more than three: "A, B and 2 more". */
function list(items: readonly string[]): string {
  const shown = items.length > 3 ? [...items.slice(0, 2), `${items.length - 2} more`] : items;
  return shown.length <= 1 ? (shown[0] ?? "") : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/** Each child chat's newest row (a later try in the same chat replaces an earlier one). */
function newest(rows: readonly Delegation[]): Delegation[] {
  const latest = new Map<string, Delegation>();
  for (const row of rows) {
    const known = latest.get(row.childSession);
    if (!known || row.createdAt > known.createdAt) latest.set(row.childSession, row);
  }
  return [...latest.values()];
}

/** One plain paragraph, or "" when nothing happened in the app since then. */
export function appSinceText({ sinceMs, rows, stuck, changes, nameOf, jobs = [] }: AppSinceInput): string {
  const current = newest(rows);
  const sentences: string[] = [];

  // Handed out, by the Mono that did it.
  const handed = current.filter((r) => r.createdAt >= sinceMs);
  if (handed.length) {
    const byMono = new Map<string, number>();
    for (const r of handed) byMono.set(nameOf(r), (byMono.get(nameOf(r)) ?? 0) + 1);
    const parts = [...byMono.entries()].map(([name, n], i) => (i === 0 ? `${name} handed out ${plural(n, "job", "jobs")}` : `${name} ${n}`));
    sentences.push(`${list(parts)}.`);
  }

  // Finished since then, and whether its report reached the Mono that asked.
  const finished = current.filter((r) => r.state === "completed" && (r.settledAt ?? 0) >= sinceMs);
  if (finished.length) {
    const reported = finished.filter((r) => r.delivery === "delivered" || r.delivery === "acknowledged").length;
    const titles = list(finished.map((r) => r.title?.trim() || "a job"));
    sentences.push(
      reported === finished.length
        ? `${finished.length === 1 ? "One" : finished.length} finished and reported back: ${titles}.`
        : `${finished.length === 1 ? "One" : finished.length} finished: ${titles}.`,
    );
  }

  // Got stuck or failed since then: what happened, not a standing reminder (anything older is in Today's lists below).
  const title = (s: StuckWorker) => s.row.title?.trim() || "a job";
  const recent = stuck.filter((s) => s.since >= sinceMs);
  const seen = new Set<string>();
  const once = (items: string[]) =>
    items.filter((t) => {
      const key = t.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const recentJobs = jobs.filter((j) => j.at >= sinceMs);
  // Failed first, so a job both lists know as failed is counted once, as failed.
  const failed = once([...recent.filter((s) => s.kind === "failed").map(title), ...recentJobs.filter((j) => j.failed).map((j) => j.title.trim() || "a job")]);
  const waiting = once([...recent.filter((s) => s.kind !== "failed").map(title), ...recentJobs.filter((j) => !j.failed).map((j) => j.title.trim() || "a job")]);
  if (waiting.length) sentences.push(`${waiting.length} got stuck or asked for an answer: ${list(waiting)}.`);
  if (failed.length) sentences.push(`${failed.length} failed: ${list(failed)}.`);

  // Bot changes that still stand.
  if (changes.length) {
    const bots = [...new Set(changes.map((c) => c.bot))];
    sentences.push(`${list(bots)} made ${plural(changes.length, "change", "changes")} to how ${bots.length === 1 ? "it works" : "they work"}, each with Undo in Bot changes.`);
  }

  return sentences.join(" ");
}

/**
 * Ash OS's paragraph as a glance (C9; Ash: what happened, "no PR lists, no standing reminders"). Sentences that only
 * restate what waits on Ash ("102 things are waiting on you") or list pull requests are left out; Today's lists below
 * hold that detail. Everything else is Ash OS's words, unchanged.
 */
const STANDING = /\bwaiting (?:on|for) you\b|\bstill (?:open|pending|waiting)\b|\b(?:don'?t forget|reminder)\b/i;
const PR_LIST = /\bPRs?\b|\bpull requests?\b|(?:^|[\s(])#\d+\b/i;
export function sinceGlance(text: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence.trim() && !STANDING.test(sentence) && !PR_LIST.test(sentence))
    .join(" ")
    .trim();
}

/**
 * Ash OS's paragraph without its own sentences on stuck or failed work ("0 stuck or failed", "1 thing got stuck"): the
 * app says that part once, from one list (appSinceText's `jobs` + its own workers), so the count and the list agree.
 */
const STUCK_TALK = /\b(?:stuck|fail(?:ed|s|ing|ure|ures)?|broke|broken|gave up)\b/i;
const STUCK_CLAUSE = /(?:,\s*|\s+and\s+)\b(?:\d+|no|one|two|three|four|five)\s+(?:things?\s+|jobs?\s+)?(?:got\s+)?(?:stuck(?:\s+or\s+failed)?|failed)\b/gi;
export function withoutStuckTalk(text: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    // "3 things finished and 0 got stuck." keeps "3 things finished."; a sentence that is only about stuck work goes.
    .map((sentence) => sentence.replace(STUCK_CLAUSE, "").replace(/\s+([.,!?])/g, "$1").replace(/^[,\s]+/, ""))
    .filter((sentence) => /[a-z]{3}/i.test(sentence.replace(/[.!?]/g, "")) && !STUCK_TALK.test(sentence))
    .join(" ")
    .trim();
}

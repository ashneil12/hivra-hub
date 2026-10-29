// The app's own share of Today's "Since …" paragraph (C9; Ash 14 Oct: "give me a quick summary of what's been happening
// since then"). Ash OS writes the paragraph about the projects' work; this adds, in the same plain words, what only the
// app knows since Ash was last active: the work his Monos handed out, what finished and reported back, what is stuck or
// failed, and the Bot changes made. Real events only; nothing here is invented, and with nothing new it says nothing.
//
// A pure function over the events, so a future model-written summary can take the same input (see `AppSinceInput`).
import { stuckNeedsAsh } from "../../monos/model/stuckChip";
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
  jobs?: readonly { title: string; failed: boolean; at: number; /** The red Needs you: Ash must act (r49). */ needsYou?: boolean }[];
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "A, B and C"; more than three: "A, B and 2 more". */
function list(items: readonly string[]): string {
  const shown = items.length > 3 ? [...items.slice(0, 2), `${items.length - 2} more`] : items;
  return shown.length <= 1 ? (shown[0] ?? "") : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/** "Tally lead" → "Tally Lead": a Lead is a role and keeps its capital, as in "with its Lead". */
const leadName = (name: string) => name.replace(/\blead$/, "Lead");

/**
 * Today's one paragraph: Ash OS's words, then the app's. Ash OS's "Nothing new here since then." is dropped when the
 * app has news (Critiquito, 29 Oct: it read "Nothing new here since then. Tally lead handed out 1 job.").
 */
const NOTHING_NEW = /^nothing new\b[^.!?]*[.!?]?$/i;
export function sinceParagraph(ashOs: string, app: string): string {
  const own = app ? ashOs.split(/(?<=[.!?])\s+/).filter((sentence) => !NOTHING_NEW.test(sentence.trim())).join(" ").trim() : ashOs;
  return [own, app].filter(Boolean).join(" ");
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

  // Handed out, by the Mono that did it, and what of it is done (Critiquito, 29 Oct: "The Lead handed out 5 jobs and all
  // 5 are done: …"). A Lead is "the Lead" when it is the only one handing out work, and "Lead" keeps its capital.
  const handed = current.filter((r) => r.createdAt >= sinceMs);
  const finished = current.filter((r) => r.state === "completed" && (r.settledAt ?? 0) >= sinceMs);
  const reported = finished.filter((r) => r.delivery === "delivered" || r.delivery === "acknowledged").length;
  const titles = list(finished.map((r) => r.title?.trim() || "a job"));
  const byMono = new Map<string, number>();
  for (const r of handed) byMono.set(leadName(nameOf(r)), (byMono.get(leadName(nameOf(r))) ?? 0) + 1);
  const monos = [...byMono.entries()];
  const soleLead = monos.length === 1 && /\bLead$/.test(monos[0][0]);
  const parts = monos.map(([name, n], i) => (i === 0 ? `${soleLead ? "The Lead" : name} handed out ${plural(n, "job", "jobs")}` : `${name} ${n}`));
  const allDone = handed.length > 0 && finished.length === handed.length && handed.every((r) => finished.includes(r));
  if (allDone) {
    const done = reported === finished.length ? (handed.length === 1 ? "it is done" : `all ${handed.length} are done`) : handed.length === 1 ? "it finished but hasn't reported back yet" : `all ${handed.length} finished, not all reported back yet`;
    sentences.push(`${list(parts)} and ${done}: ${titles}.`);
  } else {
    if (handed.length) sentences.push(`${list(parts)}.`);
    // Finished since then, and whether its report reached the Mono that asked.
    if (finished.length)
      sentences.push(
        reported === finished.length
          ? `${finished.length === 1 ? "One is" : `${finished.length} are`} done and reported back: ${titles}.`
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
  // r49, the states' own words: the red Needs you first (only Ash can sort it), told on its own; then what failed with
  // its Lead; then what is with its Lead or waiting on an answer. Each is counted once, in the first group it is in.
  const red = (s: StuckWorker) => s.kind !== "asking" && stuckNeedsAsh(s);
  const jobTitle = (j: { title: string }) => j.title.trim() || "a job";
  const needsYou = once([...recent.filter(red).map(title), ...recentJobs.filter((j) => j.needsYou).map(jobTitle)]);
  const failed = once([...recent.filter((s) => s.kind === "failed" && !red(s)).map(title), ...recentJobs.filter((j) => j.failed && !j.needsYou).map(jobTitle)]);
  const waiting = once([...recent.filter((s) => s.kind !== "failed").map(title), ...recentJobs.filter((j) => !j.failed && !j.needsYou).map(jobTitle)]);
  if (needsYou.length) sentences.push(`${needsYou.length} ${needsYou.length === 1 ? "needs" : "need"} you: ${list(needsYou)}.`);
  if (failed.length) sentences.push(`${failed.length} failed and ${failed.length === 1 ? "is" : "are"} with ${failed.length === 1 ? "its" : "their"} Lead: ${list(failed)}.`);
  if (waiting.length) sentences.push(`${waiting.length} ${waiting.length === 1 ? "is with its Lead or waiting on an answer" : "are with their Lead or waiting on an answer"}: ${list(waiting)}.`);

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

// One proper place for decisions (scorecard D2; Ash 19 Oct: nothing sorts in the background, so the app must show
// what holds). Settings > Decisions reads two real sources and invents nothing:
//
// - What is still open for a project: the inbox's own needs (hubData().listNeeds(projectId)). Answering happens in
//   the Inbox or the project's chat, never in a second copy on this page.
// - What is already decided: the project's current memory as Ash OS composes it for a Lead's fresh session
//   (hubMemoryPrimer.ts): the project's never-do rules and decisions, newest first, then
//   Ash's global layer (`ash`). Each line is the short form `- <text> [14 Oct]` (studio/memory.py `_compact`), so a
//   line has a day when it was saved with one.
//
// There is no decisions action to call: Ash OS composes this text, its project folders hold the full files, and the
// primer is the newest-first current set of both layers. `more` says how many current lines did not fit the budget;
// the page points at the folders for those. Superseded lines are not here at all (they are history: `ash_recall`).
import { hubData } from "./hubData";
import { fetchMemoryPrimer, type MemoryPrimer } from "./hubMemoryPrimer";
import type { Need, ProjectItem } from "./types";

export type MemoryLine = {
  kind: "never" | "decision";
  text: string;
  /** The day Ash OS printed ("14 Oct"), when the line was saved with one. */
  when?: string;
  /** Ash's global layer: true under a heading that names it "(ash: Ash's global memory, every project)". */
  global: boolean;
};

export type ParsedMemory = {
  lines: MemoryLine[];
  /** How many current lines did not fit the primer's budget (Ash OS's own footnote). */
  more: number;
  /** Whether the memory said plainly that it holds nothing yet. */
  empty: boolean;
};

/** `## <label>: never do` / `## <label>: decisions, newest first` (ashos/core.py memory_primer). */
const NEVER_HEAD = ": never do";
const DECISION_HEAD = ": decisions, newest first";
/** A trailing `[14 Oct]` is the saved day, not part of the sentence. */
const BULLET = /^- (.*?)(?: \[(\d{1,2} [A-Z][a-z]{2})\])?$/;
const FOOTNOTE = /^\((\d+) more current lines did not fit here/;
const NOTHING_YET = "(Nothing is in this memory yet.)";

/**
 * The primer text as rows: each bullet under a heading, in the order Ash OS wrote it (newest first per section, the
 * project's layer before Ash's global one). Anything that is not a heading or a bullet — the opening sentence, blank
 * lines, the footnote — is not a row.
 */
export function parseMemoryPrimer(text: string): ParsedMemory {
  const lines: MemoryLine[] = [];
  let kind: MemoryLine["kind"] | null = null;
  let global = false;
  let more = 0;
  let empty = false;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("## ")) {
      const head = line.slice(3).trim();
      if (head.endsWith(NEVER_HEAD)) kind = "never";
      else if (head.endsWith(DECISION_HEAD)) kind = "decision";
      else kind = null;
      global = head.includes("(ash: ");
      continue;
    }
    const foot = FOOTNOTE.exec(line);
    if (foot) {
      more = Number(foot[1]);
      continue;
    }
    if (line.trim() === NOTHING_YET) empty = true;
    if (!kind) continue;
    const bullet = BULLET.exec(line);
    if (!bullet || !bullet[1].trim()) continue;
    lines.push({ kind, text: bullet[1].trim(), ...(bullet[2] ? { when: bullet[2] } : {}), global });
  }
  return { lines, more, empty };
}

export type ProjectDecisions = ParsedMemory & {
  /** Where the project's and Ash's memory files really are (the primer says; the guess is the standard folder). */
  memoryDir?: string;
  globalDir?: string;
};

/**
 * A project's decisions for the page, from Ash OS. Undefined when Ash OS can't be reached (the page then says where
 * the files are instead of pretending the memory is empty). Read through fetchMemoryPrimer, so it shares its 60 s cache.
 */
export async function projectDecisions(
  project: string,
  options: { call?: (action: string, payload: Record<string, unknown>) => Promise<unknown>; now?: () => number; timeoutMs?: number } = {},
): Promise<ProjectDecisions | undefined> {
  const primer: MemoryPrimer | undefined = await fetchMemoryPrimer(project, options);
  if (!primer) return undefined;
  return { ...parseMemoryPrimer(primer.text), memoryDir: primer.memory_dir, globalDir: primer.global_dir };
}

/** An open ask, as the page lists it. Nothing is answered from here: it opens the project's Asking view. */
export type DecisionAsk = { id: string; title: string; why: string; later: boolean };

/** The inbox's open asks for one project, waiting first and parked ("later") under them. */
export function asksFrom(needs: readonly Need[]): DecisionAsk[] {
  return needs
    .map((n) => ({ id: n.id, title: n.title, why: n.why, later: !!n.later }))
    .sort((a, b) => Number(a.later) - Number(b.later));
}

/** The open asks a project has right now (read from the same list Today uses). */
export function projectAsks(project: string): DecisionAsk[] {
  return asksFrom(hubData().listNeeds(project));
}

/** D2 (PM r57): the Decisions item every project lists after its own items, opening that project's Decisions. */
export const DECISIONS_ITEM: ProjectItem = { id: "decisions", kind: "section", title: "Decisions", sectionType: "decisions" };

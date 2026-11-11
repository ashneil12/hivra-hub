// WP-157: a retro's proposals, held as pending learn store changes. Nothing here writes a file.
//
// An edit waits in the learn state (`state.retro`) until the person accepts or rejects it in
// Settings, Memory, Learn from chats. The accept there is the learn store's own write: a hash
// check on the file, the size cap and the secret check. A rejected edit is remembered so the
// next retro does not offer it again.

import { anchoredHunks, renderHunkLines } from "../../memory/backpass/diff";
import { acceptProposal, PROFILE_CAP, type Proposal } from "../../memory/backpass/learn";
import { emptyOpinions } from "../../memory/backpass/profile";
import { budgetGateKind, budgetStatus } from "../../memory/backpass/tokens";
import { mentionsSecret } from "../../memory/model/doc";
import { RETRO_EDIT_CAP, type Evidence, type PendingEdit } from "./retro";
import { isDay } from "./workLog";

const EVIDENCE_CAP = 10;
const EVIDENCE_LINE_CAP = 600;
const DECLINED_CAP = 100;

export type StagedEdit = PendingEdit & { stagedAt: string };

export type RetroState = { staged: StagedEdit[]; declined: string[] };

export type Verdict =
  | { kind: "ready"; proposal: Proposal; next: string }
  | { kind: "present" }
  | { kind: "full" }
  | { kind: "stale" };

export type Skipped = { declined: number; present: number; full: number };

export type Plan = {
  /** The whole learn state to save, or null when nothing changes. */
  state: Record<string, unknown> | null;
  staged: StagedEdit[];
  skipped: Skipped;
};

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** One line that cannot start a heading or pass for an evidence line of its own. */
function oneLine(text: string): string {
  let line = squash(text).replace(/^#+\s*/, "");
  if (/^evidence\s*:/i.test(line)) line = `Note: ${line}`;
  return line;
}

/** The opinion block an accepted edit adds to opinions.md, citing the log lines behind it. */
export function opinionBlock(edit: Pick<PendingEdit, "title" | "text" | "evidence">): string {
  const links = edit.evidence.map((row) => `[work log ${row.day}](work-log:${row.day})`).join(", ");
  return [`## ${oneLine(edit.title)}`, "", oneLine(edit.text), "", `Evidence: ${links}`].join("\n");
}

/**
 * The learn store shows an opinion to agents only once two lines back it. An edit with one line
 * is still saved when accepted, and the person is told it waits for a second.
 */
export function agentsWillSee(edit: Pick<PendingEdit, "evidence">): boolean {
  return edit.evidence.length >= 2;
}

function appended(original: string, block: string): string {
  if (!original.trim()) return `${emptyOpinions()}\n${block}\n`;
  return `${original.replace(/\n*$/, "\n")}\n${block}\n`;
}

function secretIn(edit: PendingEdit): boolean {
  return mentionsSecret(`${opinionBlock(edit)}\n${edit.evidence.map((row) => row.line).join("\n")}`);
}

/** The edit measured against the file as it is now. Accepting writes `next`, and only `next`. */
export function proposalFor(original: string, edit: PendingEdit): Verdict {
  const block = opinionBlock(edit);
  if (squash(original).includes(squash(block.split("\n\nEvidence:")[0]))) return { kind: "present" };
  const next = appended(original, block);
  if (budgetGateKind(budgetStatus(original, next, PROFILE_CAP))) return { kind: "full" };
  const hunks = anchoredHunks(original, next);
  if (hunks.length === 0) return { kind: "stale" };
  const proposal: Proposal = {
    id: edit.id,
    file: "opinions.md",
    role: "opinions",
    title: edit.title,
    kind: "add",
    hunks,
    quotes: edit.evidence.map((row) => ({ sessionId: `work log ${row.day}`, quote: row.line })),
    transcripts: edit.evidence.length,
    gapIds: [],
    diff: hunks.map((hunk) => renderHunkLines(hunk.lines)).join("\n"),
  };
  try {
    if (acceptProposal(original, proposal) !== next) return { kind: "stale" };
  } catch {
    return { kind: "stale" };
  }
  return { kind: "ready", proposal, next };
}

function evidenceOf(value: unknown): Evidence[] {
  if (!Array.isArray(value)) return [];
  const out: Evidence[] = [];
  for (const row of value) {
    const item = asObject(row);
    if (!item || typeof item.day !== "string" || !isDay(item.day)) continue;
    if (typeof item.line !== "string" || !item.line.trim()) continue;
    out.push({ day: item.day, line: item.line.trim().slice(0, EVIDENCE_LINE_CAP) });
    if (out.length >= EVIDENCE_CAP) break;
  }
  return out;
}

function editOf(value: unknown): PendingEdit | null {
  const row = asObject(value);
  if (!row) return null;
  if (typeof row.id !== "string" || !row.id || row.file !== "opinions.md") return null;
  if (typeof row.title !== "string" || !row.title.trim()) return null;
  if (typeof row.text !== "string" || !row.text.trim()) return null;
  const evidence = evidenceOf(row.evidence);
  if (evidence.length === 0) return null;
  return { id: row.id, file: "opinions.md", title: row.title.trim(), text: row.text.trim(), evidence };
}

/** The saved state is untrusted. A bad row is left out. */
export function parseRetroState(state: unknown): RetroState {
  const retro = asObject(asObject(state)?.retro);
  const staged: StagedEdit[] = [];
  if (Array.isArray(retro?.staged)) {
    for (const value of retro.staged) {
      const edit = editOf(value);
      const at = asObject(value)?.stagedAt;
      if (!edit || typeof at !== "string") continue;
      staged.push({ ...edit, stagedAt: at });
      if (staged.length >= RETRO_EDIT_CAP) break;
    }
  }
  const declined = Array.isArray(retro?.declined)
    ? retro.declined.filter((id): id is string => typeof id === "string" && id !== "").slice(-DECLINED_CAP)
    : [];
  return { staged, declined };
}

/**
 * What a retro leaves waiting. At most 5, never an edit that was turned down, is already in the
 * file, does not fit or looks like a secret. A new retro replaces the ones waiting. A retro that
 * finds nothing new leaves them alone. Every other key of the state is kept as it was.
 */
export function planStaging(
  state: unknown,
  original: string,
  edits: readonly PendingEdit[],
  at: string,
): Plan {
  const root = asObject(state) ?? {};
  const prior = parseRetroState(root);
  const skipped: Skipped = { declined: 0, present: 0, full: 0 };
  const staged: StagedEdit[] = [];
  const seen = new Set<string>();
  for (const value of edits.slice(0, RETRO_EDIT_CAP)) {
    const edit = editOf(value);
    if (!edit || seen.has(edit.id) || secretIn(edit)) continue;
    seen.add(edit.id);
    if (prior.declined.includes(edit.id)) {
      skipped.declined += 1;
      continue;
    }
    const verdict = proposalFor(original, edit);
    if (verdict.kind === "present") skipped.present += 1;
    else if (verdict.kind === "full") skipped.full += 1;
    else if (verdict.kind === "ready") {
      const kept = prior.staged.find((row) => row.id === edit.id);
      staged.push({ ...edit, stagedAt: kept?.stagedAt ?? at });
    }
  }
  if (staged.length === 0 || JSON.stringify(staged) === JSON.stringify(prior.staged)) {
    return { state: null, staged: staged.length === 0 ? [] : staged, skipped };
  }
  return { state: { ...root, retro: { staged, declined: prior.declined } }, staged, skipped };
}

/**
 * The state with one waiting edit taken out, or null when it was not waiting. A rejected edit is
 * remembered, so the next retro leaves it out.
 */
export function withoutStaged(state: unknown, id: string, decline: boolean): Record<string, unknown> | null {
  const root = asObject(state) ?? {};
  const retro = parseRetroState(root);
  if (!retro.staged.some((row) => row.id === id)) return null;
  const declined = decline
    ? [...retro.declined.filter((known) => known !== id), id].slice(-DECLINED_CAP)
    : retro.declined;
  return { ...root, retro: { staged: retro.staged.filter((row) => row.id !== id), declined } };
}

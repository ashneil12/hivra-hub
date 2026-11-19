// WP-83: a proposal is measured from a staging copy. Nothing here writes a file.
//
// A gap in one chat is remembered and not proposed. The same gap in a second chat
// is proposed. A quote that is not in its transcript is dropped first. A rejected
// edit stays rejected until a new chat backs it. A file that would go over its cap
// is refused unless the same edit removes or merges something.

import { applyEdit } from "./apply";
import { anchoredHunks, renderHunkLines, type Hunk } from "./diff";
import {
  emptyGapLedger,
  pruneGapLedger,
  recordSightings,
  sessionCount,
  type GapLedger,
  type Sighting as LedgerSighting,
} from "./ledger";
import { isSuppressedByRejection, type RejectEdit, type Rejections } from "./rejection";
import { refusalFor } from "./proposalGuard";
import { foldSpace } from "./quote";
import { scopeRefusal, type FileRole, type Scope } from "./scope";
import { budgetGateKind, budgetStatus } from "./tokens";

export const INSTRUCTION_CAP = 2000;
export const PROFILE_CAP = 1500;
export const MIN_SESSIONS = 2;
export const CAP_REFUSAL = "This edit must remove or merge something so the file stays under its size.";

export function capFor(role: FileRole): number {
  return role === "opinions" || role === "voice" ? PROFILE_CAP : INSTRUCTION_CAP;
}

export type Transcript = { id: string; text: string };

export type LessonSighting = {
  sessionId: string;
  quote: string;
  proposedInstruction: string;
  matchesGap?: string;
};

export type Proposal = {
  id: string;
  file: string;
  role: FileRole;
  title: string;
  kind: "add" | "rewrite" | "remove";
  hunks: Hunk[];
  quotes: { sessionId: string; quote: string }[];
  transcripts: number;
  gapIds: string[];
  diff: string;
};

export type LearnInput = {
  transcripts: Transcript[];
  sightings: LessonSighting[];
  file: string;
  role: FileRole;
  original: string;
  staged: string;
  /** The model's own find and replace. It is never applied. */
  claimed?: { find: string; replace: string };
  title: string;
  ledger?: GapLedger;
  rejections?: Rejections;
  scope: Scope;
  capTokens?: number;
  now?: string;
  /** How long a sighting still counts. `90d` when omitted. `all` keeps every one. */
  maxAge?: string;
};

export type LearnResult = {
  proposals: Proposal[];
  ledger: GapLedger;
  droppedQuotes: number;
  refused: string | null;
  written: false;
};

function measureKind(hunks: Hunk[]): Proposal["kind"] {
  let ins = false;
  let del = false;
  for (const hunk of hunks) {
    if (hunk.added > 0) ins = true;
    if (hunk.removed > 0) del = true;
    for (const line of hunk.lines) {
      if (line.type === "ins") ins = true;
      if (line.type === "del") del = true;
    }
  }
  if (ins && del) return "rewrite";
  if (del && !ins) return "remove";
  return "add";
}

function quoteOk(quote: string, transcript: string): boolean {
  if (quote.trim().length < 8) return false;
  return foldSpace(transcript).includes(foldSpace(quote));
}

/** Propose from evidence. Does not write, and does not use `claimed`. */
export function learn(input: LearnInput): LearnResult {
  const ledger: GapLedger = structuredClone(input.ledger ?? emptyGapLedger());
  const refusedScope = scopeRefusal(input.file, input.role, input.scope);
  if (refusedScope) {
    return { proposals: [], ledger, droppedQuotes: 0, refused: refusedScope, written: false };
  }

  const byId = new Map(input.transcripts.map((row) => [row.id, row.text]));
  const seen = new Set<string>();
  const valid: LedgerSighting[] = [];
  let droppedQuotes = 0;
  const now = input.now ?? "1970-01-01T00:00:00.000Z";
  for (const sighting of input.sightings) {
    const text = byId.get(sighting.sessionId);
    if (text === undefined || !quoteOk(sighting.quote, text)) {
      droppedQuotes += 1;
      continue;
    }
    if (seen.has(sighting.sessionId)) continue;
    seen.add(sighting.sessionId);
    valid.push({
      sessionId: sighting.sessionId,
      quote: sighting.quote.trim().slice(0, 600),
      proposedInstruction: sighting.proposedInstruction,
      file: input.file,
      matchesGap: sighting.matchesGap,
      observedAt: now,
    });
  }
  recordSightings(ledger, valid);
  if (Number.isFinite(Date.parse(now))) {
    pruneGapLedger(ledger, { maxAge: input.maxAge ?? "90d", nowMs: Date.parse(now) });
  }
  const live = new Set<string>();
  for (const entry of Object.values(ledger.entries)) {
    if (entry.memoryPath !== input.file) continue;
    for (const sessionId of Object.keys(entry.sessions)) live.add(sessionId);
  }
  const counted = valid.filter((row) => live.has(row.sessionId));

  const hunks = anchoredHunks(input.original, input.staged);
  if (counted.length < MIN_SESSIONS || hunks.length === 0) {
    return { proposals: [], ledger, droppedQuotes, refused: null, written: false };
  }
  // WP-101: what the edit adds may not bring a recipient, a link, a key or a permission grant into an agent's
  // instructions. Only the added lines are read, so an edit that keeps what the file already had still passes.
  const guarded = refusalFor(hunks);
  if (guarded) {
    return { proposals: [], ledger, droppedQuotes, refused: guarded, written: false };
  }

  let projected: string;
  try {
    projected = applyEdit(input.original, { id: "measure", file: input.file, hunks });
  } catch {
    return { proposals: [], ledger, droppedQuotes, refused: "The measured edit no longer matches the file.", written: false };
  }
  // `claimed` is the model's own find and replace. The hunks above were measured
  // from the staging copy, so this value is never applied.
  void input.claimed;
  const cap = input.capTokens ?? capFor(input.role);
  const budget = budgetStatus(input.original, projected, cap);
  const gate = budgetGateKind(budget);
  if (gate) {
    return { proposals: [], ledger, droppedQuotes, refused: CAP_REFUSAL, written: false };
  }

  const touched = Object.values(ledger.entries).filter(
    (entry) => entry.memoryPath === input.file && sessionCount(entry) >= MIN_SESSIONS,
  );
  const gapIds = touched.map((entry) => entry.id);
  const kind = measureKind(hunks);
  const edit: RejectEdit = {
    kind,
    file: input.file,
    title: input.title,
    transcripts: counted.length,
    hunks,
    gapIds,
  };
  if (input.rejections && isSuppressedByRejection(edit, input.rejections)) {
    return { proposals: [], ledger, droppedQuotes, refused: null, written: false };
  }

  const proposal: Proposal = {
    id: gapIds[0] || hunks[0].find.slice(0, 12),
    file: input.file,
    role: input.role,
    title: input.title,
    kind,
    hunks,
    quotes: counted.map((row) => ({ sessionId: row.sessionId, quote: row.quote })),
    transcripts: counted.length,
    gapIds,
    diff: hunks.map((hunk) => renderHunkLines(hunk.lines)).join("\n"),
  };
  return { proposals: [proposal], ledger, droppedQuotes, refused: null, written: false };
}

/**
 * Apply an accepted proposal. The caller writes the text only after the person accepts. WP-101: the edit is measured
 * again against the file as it is now, so an edit that slipped a recipient, a link, a key or a permission grant in
 * (an edit made after the proposal was measured) throws the plain reason instead of returning text.
 */
export function acceptProposal(original: string, proposal: Proposal): string {
  const next = applyEdit(original, { id: proposal.id, file: proposal.file, hunks: proposal.hunks });
  const guarded = refusalFor(anchoredHunks(original, next));
  if (guarded) throw new Error(guarded);
  return next;
}

export type LearnedState = { revision: number; ledger: GapLedger; rejections: Rejections };

/** A lost race is a retry, not a blind overwrite. */
export async function saveLearned(
  load: () => Promise<LearnedState>,
  cas: (revision: number, next: LearnedState) => Promise<boolean>,
  next: Omit<LearnedState, "revision">,
): Promise<"saved" | "retry"> {
  const current = await load();
  const ok = await cas(current.revision, { ...next, revision: current.revision });
  return ok ? "saved" : "retry";
}

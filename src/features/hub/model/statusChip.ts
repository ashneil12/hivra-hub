// One status chip per state, the same on Today, Being built and the rail (Critiquito on the r26 Today shot, 22 Oct:
// red "Stuck" rows beside a red "Needs you" row, and Ash couldn't tell them apart). Red means one thing: Ash must act
// ("Needs you"). Everything else is a calm grey ring and a plain word for what is happening:
//   - Ash OS "stuck": the job's self-repair is still retrying (after 1, 5 and 15 minutes) → "Retrying"
//   - Ash OS "sent_to_lead", or one of this app's workers stalled or failed under its Lead → "With <Lead>"
//   - Ash OS "lead_gave_up" (the Lead gave up; it's Ash's now) → "Needs you", red
//   - a Lead's failed turn only Ash can fix (r27b: billing, sign-in, a request the model refuses) → "Needs you", red;
//     one that comes right by itself (usage limit, overloaded, a dropped connection, unknown) → "Can't answer", grey
// Every red "Needs you" shows its reason and "Open <Lead>'s chat" (NeedsYouChip in StatusMark.tsx).
// The job logic is untouched: only what the row says and its colour.
import { gaveUpAsNeedsYou } from "./hubWork";
import type { StuckState, Worker } from "./types";
import { stuckOwner } from "../../monos/model/workerStuck";

export type ChipTone = "red" | "grey";
export type Chip = { word: string; tone: ChipTone };

export const NEEDS_YOU: Chip = { word: "Needs you", tone: "red" };
export const RETRYING: Chip = { word: "Retrying", tone: "grey" };
/** Its Lead's last turn failed: the words Today has always used for it. */
export const CANT_ANSWER: Chip = { word: "Can't answer", tone: "grey" };
/** "With Hivra lead"; a job with no Lead yet reads "With its lead". */
export function withLead(lead?: string | null): Chip {
  const name = lead?.trim();
  return { word: name && name !== "Nobody yet" ? `With ${name}` : "With its lead", tone: "grey" };
}

/** The chip for an Ash OS stuck state. */
export function stuckChip(state: StuckState, lead?: string | null): Chip {
  if (state === "lead_gave_up") return gaveUpAsNeedsYou() ? NEEDS_YOU : { word: "Stuck", tone: "red" }; // old look: dev flag only
  if (state === "sent_to_lead") return withLead(lead);
  return RETRYING;
}

/**
 * A Lead's failed turn, by the error kind the app already has (`plainFailure` in turnFailure.ts turns the provider's
 * error class into a tone): red = only Ash can fix it, grey = it should come right by itself or with Try again.
 */
export function failureChip(tone: "red" | "grey" | undefined): Chip {
  return tone === "red" ? NEEDS_YOU : CANT_ANSWER;
}

/** "Sent to Hivra lead at 2:20pm": Ash OS's own time, the Lead's name from the job itself (the chip's one source). */
export function sentNote(sentText: string | undefined, gotIt: string | undefined, lead: string | null | undefined): string | undefined {
  if (!sentText) return undefined;
  const name = lead?.trim();
  const m = /^Sent to .+? at (.+)$/.exec(sentText);
  const text = m && name && name !== "Nobody yet" ? `Sent to ${name} at ${m[1]}` : sentText;
  return gotIt ? `${text} · ${gotIt}` : text;
}

/** The chip for a Being built row, or undefined when it isn't stuck. A stalled app worker is its Lead's to handle. */
export function workerChip(w: Pick<Worker, "stuck" | "who" | "stuckWorker" | "finishedAt" | "leadCantAnswer">): Chip | undefined {
  if (w.finishedAt || !w.stuck) return undefined;
  if (w.leadCantAnswer) return failureChip(w.leadCantAnswer);
  // r30b: the app's own worker under the job, by the red rule (workerStuck.ts stuckOwner): red only for a billing or
  // sign-in refusal, grey Retrying while a retry has it, else grey With <Lead>.
  if (w.stuck !== "lead_gave_up" && w.stuckWorker) {
    const owner = w.stuckWorker.kind === "asking" ? "with-lead" : stuckOwner(w.stuckWorker);
    return owner === "needs-you" ? NEEDS_YOU : owner === "retrying" ? RETRYING : withLead(w.who);
  }
  return stuckChip(w.stuck, w.who);
}

/** A word Ash OS put on a Need row, as a chip: only "Needs you" (or a job the Lead gave up on) is red. */
export function wireChip(word: string, lead?: string | null): Chip {
  if (word === "Needs you") return NEEDS_YOU;
  if (word === "Stuck") return RETRYING;
  if (word === "Sent to lead") return withLead(lead);
  return { word, tone: "grey" };
}

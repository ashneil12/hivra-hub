import { gaveUpAsNeedsYou } from "../model/hubWork";
import { NEEDS_YOU, stuckChip, wireChip, type Chip, type ChipTone } from "../model/statusChip";
import type { Need, StuckState } from "../model/types";

const RED = "rgb(239 68 68)";

/** The circle on its own: 14px, a 2px ring. Red only for Needs you; every other state a calm grey. */
function Ring({ circle }: { circle: ChipTone }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden className={`inline-block align-baseline ${circle === "red" ? "" : "text-content/40"}`}>
      <circle cx="7" cy="7" r="6" fill="none" strokeWidth="2" stroke={circle === "red" ? RED : "currentColor"} />
    </svg>
  );
}

/** A 14px circle and a plain grey word: the only status mark the hub uses (statusChip.ts says which). */
export function CircleWord({ circle, word, ringOnly = false }: { circle: ChipTone; word: string; ringOnly?: boolean }) {
  // Ring only (Critiquito, round 23: the agent note already says "got stuck"): the word becomes the ring's accessible
  // name, so a screen reader still hears it and the line doesn't say it twice.
  if (ringOnly) {
    return (
      <span role="img" aria-label={word} title={word} className="inline-block shrink-0 leading-none" data-hub-circle={circle} data-hub-ring-only>
        <Ring circle={circle} />
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-content/60" data-hub-circle={circle} data-hub-chip={word}>
      <Ring circle={circle} />
      {word}
    </span>
  );
}

export function ChipMark({ chip, ringOnly = false }: { chip: Chip; ringOnly?: boolean }) {
  return <CircleWord circle={chip.tone} word={chip.word} ringOnly={ringOnly} />;
}

/** The mark for an Ash OS stuck state: Retrying, With <Lead>, or (the Lead gave up) the red Needs you. */
export function StatusMark({ state, lead, ringOnly = false }: { state: StuckState; lead?: string | null; ringOnly?: boolean }) {
  return <ChipMark chip={stuckChip(state, lead)} ringOnly={ringOnly} />;
}

/**
 * The mark on a Needs row. A job the Lead gave up on (a job's row that Ash OS marks red) reads "Needs you" (D5, Ash 21
 * Oct 20:40), whatever word Ash OS sends; the old red "Stuck" only behind the `monocode:hub-gaveup-style=stuck` dev flag.
 * Since r27 every other row is grey (Retrying, With its lead): red is only for Needs you.
 */
export function needMark(need: Pick<Need, "circle" | "word" | "jobId">): { circle: ChipTone; word: string } | null {
  if (!need.circle || !need.word) return null;
  if (need.jobId && need.circle === "red") return { circle: "red", word: gaveUpAsNeedsYou() ? "Needs you" : "Stuck" };
  // Red only for Needs you; any other word Ash OS sends is a grey chip in the same words as Being built.
  const chip = wireChip(need.word);
  return { circle: chip.tone, word: chip.word };
}

/** "Open Hivra lead's chat": every red Needs you carries it (r27b), so Ash can act from where he sees it. */
export function OpenLeadLink({ name, onOpen }: { name?: string | null; onOpen: () => void }) {
  return (
    <button
      type="button"
      data-hub-open-lead
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      className="shrink-0 cursor-default rounded text-xs text-content/80 underline decoration-content/30 underline-offset-2 hover:text-content"
    >
      Open {name?.trim() || "its Lead"}&apos;s chat
    </button>
  );
}

/** The red Needs you chip with its reason and the link to the Lead's chat (Today, Being built and the rail alike). */
export function NeedsYouChip({ reason, lead, onOpenLead }: { reason?: string; lead?: string | null; onOpenLead: () => void }) {
  return (
    <span data-hub-needs-you className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
      <ChipMark chip={NEEDS_YOU} />
      {reason ? <span data-hub-needs-reason className="min-w-0 break-words text-content/60">{reason}</span> : null}
      <OpenLeadLink name={lead} onOpen={onOpenLead} />
    </span>
  );
}

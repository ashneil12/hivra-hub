import { SecondaryButton } from "../../../shared/ui/SecondaryButton";
import { gaveUpAsNeedsYou } from "../model/hubWork";
import { NEEDS_YOU, stuckChip, wireChip, type Chip, type ChipTone } from "../model/statusChip";
import { askNeedsAsh } from "../model/askNeeds";
import type { Need, StuckState } from "../model/types";

const RED = "rgb(239 68 68)";
/** r70b (Critiquito): the red "Needs you" word, a touch lighter than the bar so it reads on the dark card (~#ff6b6b). */
export const NEEDS_YOU_RED = "#ff6b6b";

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
  // r69 (PM's blind r67 (a)): the red state's word is red too, so the row reads Needs you, not only its ring.
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 text-xs ${circle === "red" ? "" : "text-content/60"}`}
      style={circle === "red" ? { color: NEEDS_YOU_RED } : undefined}
      data-hub-circle={circle}
      data-hub-chip={word}
    >
      <Ring circle={circle} />
      {word}
    </span>
  );
}

/**
 * r69 (PM's blind r67 (a); Ash, 29 Oct: "do NOT tint or fill the row background red"): a Needs you row is marked by a
 * 2px red bar on its left edge plus the red "Needs you" word; its background stays neutral. An inset shadow, so the
 * row's text doesn't move by the bar's width.
 */
export function redRowProps(
  red: boolean,
  /** A shadow the element already has (a pinned card's drop shadow), kept under the bar. */
  keepShadow?: string,
): { style?: { boxShadow: string }; "data-hub-red-row"?: true } {
  if (!red) return {};
  return { style: { boxShadow: [`inset 2px 0 0 ${RED}`, keepShadow].filter(Boolean).join(", ") }, "data-hub-red-row": true };
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
export function needMark(
  need: Pick<Need, "circle" | "word" | "jobId"> & Partial<Pick<Need, "actionTarget" | "state">>,
  counted = false,
): { circle: ChipTone; word: string } | null {
  // r67: an open ask the badge counts is something only Ash can do, so it reads red, older asks included (askNeeds.ts).
  if (askNeedsAsh(need, counted)) return { circle: NEEDS_YOU.tone, word: NEEDS_YOU.word };
  if (!need.circle || !need.word) return null;
  if (need.jobId && need.circle === "red") return { circle: "red", word: gaveUpAsNeedsYou() ? "Needs you" : "Stuck" };
  // Red only for Needs you; any other word Ash OS sends is a grey chip in the same words as Being built.
  const chip = wireChip(need.word);
  return { circle: chip.tone, word: chip.word };
}

/** "Open Hivra lead's chat": every red Needs you carries it (r27b), so Ash can act from where he sees it. */
export function OpenLeadLink({ name, onOpen }: { name?: string | null; onOpen: () => void }) {
  return (
    <SecondaryButton
      data-hub-open-lead
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      Open {name?.trim() || "its Lead"}&apos;s chat
    </SecondaryButton>
  );
}

/**
 * Where "Open <Lead>'s chat" goes, on every row of Today, Being built and the rail (r28: it sat inline on some rows and
 * on its own line on others): on its own line, under the reason.
 */
export function NeedsYouLinkLine({ name, onOpen }: { name?: string | null; onOpen: () => void }) {
  return (
    <div className="mt-0.5 flex" data-hub-needs-link>
      <OpenLeadLink name={name} onOpen={onOpen} />
    </div>
  );
}

/** The red Needs you chip with its reason, and the link to the Lead's chat on its own line under it (the rail). */
export function NeedsYouChip({ reason, lead, onOpenLead }: { reason?: string; lead?: string | null; onOpenLead: () => void }) {
  return (
    <span data-hub-needs-you className="flex min-w-0 flex-col text-xs">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <ChipMark chip={NEEDS_YOU} />
        {reason ? <span data-hub-needs-reason className="min-w-0 break-words text-content/60">{reason}</span> : null}
      </span>
      <NeedsYouLinkLine name={lead} onOpen={onOpenLead} />
    </span>
  );
}

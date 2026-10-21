import { gaveUpAsNeedsYou } from "../model/hubWork";
import type { Need, StuckState } from "../model/types";

const AMBER = "rgb(245 158 11)";
const RED = "rgb(239 68 68)";

/** A 14px circle and a plain grey word: the only status mark the hub uses. Red = stuck or needs you, amber = sent to lead. */
export function CircleWord({ circle, word }: { circle: "amber" | "red"; word: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-content/60" data-hub-circle={circle}>
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
        <circle cx="7" cy="7" r="6" fill="none" strokeWidth="2" stroke={circle === "red" ? RED : AMBER} />
      </svg>
      {word}
    </span>
  );
}

/** The only status the hub shows: a 14px circle and a plain word. */
export function StatusMark({ state }: { state: StuckState }) {
  // Stuck is one red wherever it shows (Critiquito, 21 Oct): stuck or given up by the Lead. Only "Sent to lead" is amber.
  return state === "sent_to_lead" ? <CircleWord circle="amber" word="Sent to lead" /> : <CircleWord circle="red" word="Stuck" />;
}

/**
 * The mark on a Needs row. A job the Lead gave up on (a job's row that Ash OS marks red) reads red "Stuck", whatever
 * word Ash OS sends, and any "Stuck" row is the same red; "Needs you" only behind the `monocode:hub-gaveup-style=needs_you` dev flag.
 */
export function needMark(need: Pick<Need, "circle" | "word" | "jobId">): { circle: "amber" | "red"; word: string } | null {
  if (!need.circle || !need.word) return null;
  if (need.jobId && need.circle === "red") return { circle: "red", word: gaveUpAsNeedsYou() ? "Needs you" : "Stuck" };
  // Stuck is one red on every row, whatever circle Ash OS sends with it.
  if (need.word === "Stuck") return { circle: "red", word: "Stuck" };
  return { circle: need.circle, word: need.word };
}

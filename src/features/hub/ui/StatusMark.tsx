import { gaveUpAsNeedsYou } from "../model/hubWork";
import type { Need, StuckState } from "../model/types";

const AMBER = "rgb(245 158 11)";
const RED = "rgb(239 68 68)";

/** The circle on its own: 14px, a 2px ring. Inline, so it sits on the text's baseline like a letter would. */
function Ring({ circle }: { circle: "amber" | "red" }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden className="inline-block align-baseline">
      <circle cx="7" cy="7" r="6" fill="none" strokeWidth="2" stroke={circle === "red" ? RED : AMBER} />
    </svg>
  );
}

/** A 14px circle and a plain grey word: the only status mark the hub uses. Red = stuck or needs you, amber = sent to lead. */
export function CircleWord({ circle, word, ringOnly = false }: { circle: "amber" | "red"; word: string; ringOnly?: boolean }) {
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
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-content/60" data-hub-circle={circle}>
      <Ring circle={circle} />
      {word}
    </span>
  );
}

/** The only status the hub shows: a 14px circle and a plain word. */
export function StatusMark({ state, ringOnly = false }: { state: StuckState; ringOnly?: boolean }) {
  // Stuck is one red wherever it shows (Critiquito, 21 Oct): stuck or given up by the Lead. Only "Sent to lead" is amber.
  return state === "sent_to_lead" ? <CircleWord circle="amber" word="Sent to lead" ringOnly={ringOnly} /> : <CircleWord circle="red" word="Stuck" ringOnly={ringOnly} />;
}

/**
 * The mark on a Needs row. A job the Lead gave up on (a job's row that Ash OS marks red) reads "Needs you" (D5, Ash 21
 * Oct 20:40), whatever word Ash OS sends; the old red "Stuck" only behind the `monocode:hub-gaveup-style=stuck` dev flag.
 * Any other "Stuck" row (still fixing itself) is the one red.
 */
export function needMark(need: Pick<Need, "circle" | "word" | "jobId">): { circle: "amber" | "red"; word: string } | null {
  if (!need.circle || !need.word) return null;
  if (need.jobId && need.circle === "red") return { circle: "red", word: gaveUpAsNeedsYou() ? "Needs you" : "Stuck" };
  // Stuck is one red on every row, whatever circle Ash OS sends with it.
  if (need.word === "Stuck") return { circle: "red", word: "Stuck" };
  return { circle: need.circle, word: need.word };
}

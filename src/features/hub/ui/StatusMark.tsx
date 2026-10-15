import type { StuckState } from "../model/types";

const AMBER = "rgb(245 158 11)";
const RED = "rgb(239 68 68)";

/** A 14px circle and a plain grey word: the only status mark the hub uses. Amber = stuck, red = needs you. */
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
  const gaveUp = state === "lead_gave_up";
  return <CircleWord circle={gaveUp ? "red" : "amber"} word={gaveUp ? "Lead gave up" : state === "sent_to_lead" ? "Sent to lead" : "Stuck"} />;
}

// Tells Ash OS when Ash really used the app, so "Since <time>" means since he last left, not since a window opened.
//
// Real use only, as Ash defines it (C9): typing or clicking in the app, and only while the window is visible. Scrolling,
// hovering, focusing the window or reopening the app does not move "Since": the app merely being open is not use. No
// timer ever reports on its own, so an open window left alone changes nothing. Reports are at most one a minute and
// carry the time of the latest input. Ash OS decides what counts as leaving (a gap of 30 minutes with no input);
// the first input after such a gap is reported at once, because the last report is far enough back.

/** At most one report this often. */
export const REPORT_GAP_MS = 60_000;
/** Ash OS treats a gap this long without input as having left (it tells the app too; kept here for the tests). */
export const IDLE_MS = 30 * 60_000;

/** Typing and a completed click. Not pointermove, wheel, focus or visibilitychange. */
export const INPUT_EVENTS = ["keydown", "click"] as const;

type Listener = (event?: unknown) => void;
export type ActivityEnv = {
  target: { addEventListener(type: string, fn: Listener, options?: unknown): void; removeEventListener(type: string, fn: Listener, options?: unknown): void };
  visible: () => boolean;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
};

function browserEnv(): ActivityEnv | undefined {
  if (typeof window === "undefined" || typeof document === "undefined") return undefined;
  return {
    target: window,
    visible: () => document.visibilityState !== "hidden",
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

/** Start listening. Returns the function that stops it. Without a window (tests, servers) it does nothing. */
export function startActivityTracking(report: (at: Date) => void, env: ActivityEnv | undefined = browserEnv()): () => void {
  if (!env) return () => undefined;
  let lastInput: number | undefined;
  let lastReport: number | undefined;
  let timer: unknown;

  const flush = () => {
    timer = undefined;
    if (lastInput === undefined) return;
    const at = lastInput;
    lastInput = undefined;
    lastReport = env.now();
    report(new Date(at));
  };
  const onInput: Listener = () => {
    if (!env.visible()) return;
    const now = env.now();
    lastInput = now;
    if (timer !== undefined) return;
    const wait = lastReport === undefined ? 0 : Math.max(0, lastReport + REPORT_GAP_MS - now);
    timer = env.setTimer(flush, wait);
  };

  const options = { capture: true, passive: true };
  for (const type of INPUT_EVENTS) env.target.addEventListener(type, onInput, options);
  return () => {
    for (const type of INPUT_EVENTS) env.target.removeEventListener(type, onInput, options);
    if (timer !== undefined) env.clearTimer(timer);
    timer = undefined;
  };
}

import { appIdentity } from "../../../app/model/appIdentity";

/** Where the dev copy under hub:verify-live keeps what its live lines showed (the bench reads local storage). */
export const VERIFY_LIVE_LINES_KEY = "monocode:verify-live-lines";
const KEEP = 40;

/** One live line as it was on screen: its text, and whether the MonoCode runner sat right after the timer. */
export type SeenLiveLine = { key: string; text: string; runner: boolean; runnerAfterText: boolean; stalled: boolean };

/** What a rendered live line shows, read from its own element (so the bench checks the screen, not the model). */
export function readLiveLine(el: Element, key: string): SeenLiveLine | null {
  const text = el.querySelector("[data-live-activity-text]");
  if (!text?.textContent) return null;
  const runner = el.querySelector("[data-live-runner]");
  return {
    key,
    text: text.textContent,
    runner: !!runner,
    runnerAfterText: !!runner && text.nextElementSibling === runner,
    stalled: el.hasAttribute("data-live-activity-stalled"),
  };
}

/**
 * Notes a live line for the verify bench. Only in a dev copy running a verify plan; a no-op everywhere else (Ash's app
 * never writes this key). Keeps the latest few, one per line and text.
 */
export function noteLiveLine(seen: SeenLiveLine | null, storage: Storage | undefined = globalThis.localStorage, onBench = !!appIdentity()?.verify) {
  if (!seen || !onBench || !storage) return;
  let lines: SeenLiveLine[] = [];
  try {
    const parsed = JSON.parse(storage.getItem(VERIFY_LIVE_LINES_KEY) ?? "[]");
    if (Array.isArray(parsed)) lines = parsed;
  } catch {
    lines = [];
  }
  if (lines.some((line) => line.key === seen.key && line.text === seen.text && line.runner === seen.runner)) return;
  storage.setItem(VERIFY_LIVE_LINES_KEY, JSON.stringify([...lines, seen].slice(-KEEP)));
}

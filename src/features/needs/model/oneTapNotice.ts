// A one tap that the store refused. The row stays; Home and the Inbox say why, in the store's own words.

const MISSED = "That didn't go through. Try again.";
const NOTICE_MAX = 180;

/** How long a refusal stays up when the next tap does not clear it. */
export const ONE_TAP_NOTICE_MS = 12_000;

let notice: string | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

export function oneTapRefusal(): string | undefined {
  return notice;
}

function clipNotice(reason: string): string | undefined {
  const text = reason.replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  if (text.length <= NOTICE_MAX) return text;
  return `${text.slice(0, NOTICE_MAX - 3).trimEnd()}...`;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function arm(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    if (notice === undefined) return;
    notice = undefined;
    emit();
  }, ONE_TAP_NOTICE_MS);
}

/**
 * The store said no, or the call never came back. `reason` is the sentence the store already
 * wrote for a person. A blank becomes one calm line. The same words do not notify again, but
 * they do stay up for another while.
 */
export function noteOneTapRefusal(reason?: string): void {
  const text = (typeof reason === "string" ? clipNotice(reason) : undefined) ?? MISSED;
  const same = notice === text;
  notice = text;
  arm();
  if (!same) emit();
}

export function resetOneTapRefusal(): void {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  if (notice === undefined) return;
  notice = undefined;
  emit();
}

export function subscribeOneTapRefusal(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

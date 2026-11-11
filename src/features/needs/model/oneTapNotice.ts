// A one tap that the store refused. The row stays; Home says so in one sentence.

const REFUSAL = "That changed while you were looking";

let notice: string | undefined;
const listeners = new Set<() => void>();

export function oneTapRefusal(): string | undefined {
  return notice;
}

/** The store said no, or the call never came back. Always the same sentence, never the raw error. */
export function noteOneTapRefusal(): void {
  if (notice === REFUSAL) return;
  notice = REFUSAL;
  for (const listener of listeners) listener();
}

export function resetOneTapRefusal(): void {
  if (notice === undefined) return;
  notice = undefined;
  for (const listener of listeners) listener();
}

export function subscribeOneTapRefusal(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

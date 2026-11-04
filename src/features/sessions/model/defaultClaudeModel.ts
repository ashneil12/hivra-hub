/**
 * The Claude model a new Mono starts on, kept in a leaf so hub modules can read
 * it without importing models.ts. models.ts and session.ts import each other;
 * pulling that cycle into a module tests reload per case deadlocks the loader.
 * models.ts points this at `defaultModelId` once it has loaded, so a live
 * catalog still wins.
 */
export const DEFAULT_CLAUDE_MODEL_ID = "claude:sonnet-5";

let read = (): string => DEFAULT_CLAUDE_MODEL_ID;

export function defaultClaudeModelId(): string {
  return read();
}

/** models.ts registers the live default (built-in id, or the catalog's). */
export function useDefaultClaudeModelId(next: () => string): void {
  read = next;
}

// WP-88: reading every project is off unless the soul asks and the person has turned it on.
// The template id is never special. A hand-edited flag that is not exactly true stays off.

export const EVERY_PROJECT_LINE = "Every project: read";

export type ScopeMono = {
  id?: string;
  instructions?: string;
  everyProject?: boolean;
};

/** The marker is one whole line, after carriage returns are normalised. Anything else is not a request. */
export function soulAsks(soul: string | null | undefined): boolean {
  if (typeof soul !== "string" || !soul.trim()) return false;
  return soul.replace(/\r\n?/g, "\n").split("\n").some((line) => line.trim() === EVERY_PROJECT_LINE);
}

/** Both have to say yes. A string, 1, or a missing field is off. */
export function readsEveryProject(mono: ScopeMono | null | undefined): boolean {
  return !!mono && mono.everyProject === true && soulAsks(mono.instructions);
}

/**
 * The soul file can ask when the roster copy does not. A timeout does not turn the scope on,
 * and it does not turn off a scope the roster already asked for.
 */
export async function scopeOpen(
  mono: ScopeMono | null | undefined,
  readSoul?: () => Promise<string | null | undefined>,
): Promise<boolean> {
  if (!mono || mono.everyProject !== true) return false;
  if (soulAsks(mono.instructions)) return true;
  if (!readSoul) return false;
  try {
    return soulAsks(await readSoul());
  } catch {
    return false;
  }
}

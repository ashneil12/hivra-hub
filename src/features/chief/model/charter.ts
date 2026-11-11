// WP-215: the captain's charter is fixed text. A personality sits beside it and never rewrites it.

export const CAPTAIN_CHARTER =
  "The captain owns priorities across projects. It writes every ask down as a task before any work starts. It hands work to first mates and never starts crew itself. It answers in this order: what is always the owner's, then a rule the owner set, then a standing answer, then a learned preference, then a confident first mate's pick, and only then one short turn of its own. It passes up only the owner's kinds: a red line, money past the owner's limit, anything public or sent in the owner's name, keys, and anything that cannot be undone.";

const PERSONALITY = "\n## Personality\n";

export function hasCaptainCharter(soul: string | null | undefined): boolean {
  return typeof soul === "string" && soul.includes(CAPTAIN_CHARTER);
}

/**
 * A soul that carries the charter keeps its Role section exactly those words.
 * Extra sentences, or the charter parked in a comment with a new role in its place, are put back.
 * A soul that does not carry the charter is unchanged.
 */
export function withLockedRole(soul: string): string {
  const text = soul.replace(/\r\n?/g, "\n");
  if (!hasCaptainCharter(text)) return text;
  const marker = "\n## Role\n";
  const at = text.indexOf(marker);
  if (at < 0) {
    const nl = text.indexOf("\n");
    const insertAt = nl < 0 ? text.length : nl + 1;
    return `${text.slice(0, insertAt)}\n## Role\n${CAPTAIN_CHARTER}\n${text.slice(insertAt)}`;
  }
  const bodyStart = at + marker.length;
  const rest = text.slice(bodyStart);
  const next = rest.search(/\n## /);
  const after = next < 0 ? "" : rest.slice(next);
  return `${text.slice(0, bodyStart)}${CAPTAIN_CHARTER}\n${after}`;
}

/** The coordinator starter, a Mono flagged as the captain, or one still named Chief of Staff. */
export function isCaptainMono(
  mono: { id?: string; name?: string; captain?: boolean; templateId?: string } | null | undefined,
): boolean {
  if (!mono) return false;
  if (mono.captain === true) return true;
  const id = (mono.id ?? "").trim();
  const template = (mono.templateId ?? "").trim();
  if (id === "coordinator" || template === "coordinator") return true;
  return (mono.name ?? "").trim() === "Chief of Staff";
}

/** The personality section, or empty when the soul has none. The charter is not part of it. */
export function personalityOf(soul: string): string {
  const text = soul.replace(/\r\n?/g, "\n");
  const start = text.indexOf(PERSONALITY);
  if (start < 0) return "";
  const rest = text.slice(start + PERSONALITY.length);
  const next = rest.search(/\n## /);
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

/**
 * Replaces only the personality section. The charter's place in the soul stays put.
 * A soul with no charter, or no personality section, is refused.
 */
export function applyPersonality(soul: string, personality: string): string {
  const text = soul.replace(/\r\n?/g, "\n");
  const charterAt = text.indexOf(CAPTAIN_CHARTER);
  if (charterAt < 0) throw new Error("This soul has no captain charter.");
  const start = text.indexOf(PERSONALITY);
  if (start < 0) throw new Error("This soul has no personality section.");
  const bodyStart = start + PERSONALITY.length;
  const rest = text.slice(bodyStart);
  const next = rest.search(/\n## /);
  const after = next < 0 ? "" : rest.slice(next);
  // A heading inside the personality would cut the following sections off. It is dropped, and so is anything after it.
  const clean = personality.replace(/\r\n?/g, "\n").split(/\n## /)[0]?.trim() ?? "";
  const nextSoul = `${text.slice(0, bodyStart)}${clean}\n${after}`;
  if (nextSoul.indexOf(CAPTAIN_CHARTER) !== charterAt) {
    throw new Error("The captain charter is fixed.");
  }
  return nextSoul;
}

/** The charter is not editable. Settings changes the personality beside it. */
export function editCharter(): never {
  throw new Error("The captain charter is fixed. Edit the personality beside it.");
}

/**
 * Puts the charter into a soul that does not have it yet. One that already has it is unchanged.
 * An existing coordinator gets it on load; a new one gets it from the starter template.
 */
export function ensureCaptainCharter(soul: string): string {
  const text = soul.replace(/\r\n?/g, "\n");
  if (text.includes(CAPTAIN_CHARTER)) return text;
  const role = "\n## Role\n";
  const at = text.indexOf(role);
  if (at >= 0) {
    const insertAt = at + role.length;
    return `${text.slice(0, insertAt)}${CAPTAIN_CHARTER}\n${text.slice(insertAt)}`;
  }
  const head = text.startsWith("# Soul") ? text : `# Soul\n\n${text}`;
  const nl = head.indexOf("\n");
  const insertAt = nl < 0 ? head.length : nl + 1;
  return `${head.slice(0, insertAt)}\n## Role\n${CAPTAIN_CHARTER}\n${head.slice(insertAt)}`;
}

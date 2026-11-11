// WP-182: a Mono's session instruction. Unset or empty skills keep today's text
// byte for byte. A named list keeps only those skill lines, in the pstack format.
import { indexLines, PSTACK_AUTOPILOT, sessionInstruction } from "../../plugins/model/pstackAutopilot";

export type MonoSessionInput = {
  pstackRoot?: string;
  mcodeRoot?: string;
  plainEnglish: boolean;
  /** Skill names to list. Absent or empty means every installed skill. */
  skills?: readonly string[];
  /** Slash command names. They do not change the instruction text. */
  commands?: readonly string[];
  /** Extra index entries (name, for, when, rel), so a skill outside pstack can be listed. */
  extra?: readonly unknown[];
  extraRoot?: string;
  /** Skills the slash catalog found. A chosen name with no index line uses one of these. */
  discovered?: readonly { name?: unknown; description?: unknown }[];
};

function named(skills: readonly string[] | undefined): string[] {
  if (!skills?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const skill of skills) {
    if (typeof skill !== "string") continue;
    const name = skill.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function filterSkillBlock(block: string, keep: ReadonlySet<string>): string | undefined {
  const groups: { root?: string; skills: string[] }[] = [];
  let current: { root?: string; skills: string[] } = { skills: [] };
  const seen = new Set<string>();
  for (const line of block.split("\n")) {
    if (!line || line === PSTACK_AUTOPILOT) continue;
    if (line.includes(" | ")) {
      const name = line.slice(0, line.indexOf(" | "));
      if (!keep.has(name) || seen.has(name)) continue;
      seen.add(name);
      current.skills.push(line);
      continue;
    }
    if (current.root || current.skills.length) groups.push(current);
    current = { root: line, skills: [] };
  }
  if (current.root || current.skills.length) groups.push(current);
  const kept = groups.filter((group) => group.skills.length > 0);
  if (!kept.length) return undefined;
  return kept
    .map((group) => (group.root ? [group.root, ...group.skills] : group.skills).join("\n"))
    .join("\n");
}

/** The instruction for one Mono. Unset skills return today's string, not a rebuild of it. */
export function monoSessionInstruction(input: MonoSessionInput): string {
  const today = sessionInstruction({
    pstackRoot: input.pstackRoot,
    mcodeRoot: input.mcodeRoot,
    plainEnglish: input.plainEnglish,
  });
  const keep = named(input.skills);
  if (!keep.length) return today;

  const listed = sessionInstruction({
    pstackRoot: input.pstackRoot,
    mcodeRoot: input.mcodeRoot,
    plainEnglish: false,
  });
  const body = listed.startsWith(`${PSTACK_AUTOPILOT}\n`)
    ? listed.slice(PSTACK_AUTOPILOT.length + 1)
    : listed.startsWith(PSTACK_AUTOPILOT)
      ? listed.slice(PSTACK_AUTOPILOT.length)
      : listed;
  const extraLines = input.extraRoot ? indexLines(input.extra, input.extraRoot) : undefined;
  const extra = extraLines && input.extraRoot ? `${input.extraRoot}\n${extraLines}` : undefined;
  const filtered = filterSkillBlock([body, extra].filter(Boolean).join("\n"), new Set(keep));
  const have = new Set<string>();
  for (const line of (filtered ?? "").split("\n")) {
    const at = line.indexOf(" | ");
    if (at > 0) have.add(line.slice(0, at));
  }
  const purposes = new Map<string, string>();
  for (const row of input.discovered ?? []) {
    if (!row || typeof row.name !== "string") continue;
    const name = row.name.trim();
    if (!name || purposes.has(name)) continue;
    const description = typeof row.description === "string" ? row.description.replace(/\|/g, "/").replace(/\s+/g, " ").trim() : "";
    if (description) purposes.set(name, description);
  }
  const extras = keep
    .filter((name) => !have.has(name))
    .map((name) => `${name} | ${purposes.get(name) ?? "Named by this Mono."}`);
  const skillBody = [filtered, extras.length ? extras.join("\n") : undefined].filter(Boolean).join("\n");
  const parts: string[] = [];
  if (skillBody) parts.push(`${PSTACK_AUTOPILOT}\n${skillBody}`);
  if (input.plainEnglish) {
    const plain = sessionInstruction({ plainEnglish: true });
    if (plain) parts.push(plain);
  }
  return parts.join("\n\n");
}

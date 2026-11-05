// WP-89: the line in force also sees the project's crew rules and a plugin's.
// A read that fails is not "there are no rules". The next open tries again.

import { mergeRules, sanitizeRule, type CrewRule } from "./rules";

type Loaded = { rules?: unknown; plugins?: unknown };

type Source = (project: string) => Promise<Loaded | undefined>;

let source: Source | undefined;

/** The app sets this to the crew table. Tests set a stand-in. Absent: only the Mono's own rules. */
export function setLineRulesSource(next: Source | undefined): void {
  source = next;
}

function asRules(value: unknown, who: CrewRule["source"]): CrewRule[] {
  if (!Array.isArray(value)) return [];
  const out: CrewRule[] = [];
  for (const entry of value) {
    const rule = sanitizeRule(entry, who);
    if (!rule) continue;
    out.push(rule);
    if (out.length >= 40) break;
  }
  return out;
}

/**
 * Mono rules, then this project's, then plugins. Null means the read failed:
 * keep whatever the line already showed. An empty list is a real answer.
 */
export async function lineRulesFor(
  project: string | undefined,
  mono: readonly CrewRule[] = [],
): Promise<CrewRule[] | null> {
  const own = asRules(mono, "person");
  const folder = project?.trim();
  if (!folder || !source) return mergeRules(own, [], []);
  try {
    const got = await source(folder);
    if (!got || typeof got !== "object") return mergeRules(own, [], []);
    return mergeRules(own, asRules(got.rules, "person"), asRules(got.plugins, "plugin"));
  } catch {
    return null;
  }
}

// The built-in protected paths: a change to one of these gets the full checks in every testing mode but No testing. The list
// is sensitivePaths.json, which the Rust side includes too (include_str!), so the two can never drift. This file only reads
// it and holds the words the Settings line shows.

import sensitivePathsFile from "./sensitivePaths.json";

export type SensitivePathGroup = {
  readonly id: string;
  readonly label: string;
  readonly patterns: readonly string[];
};

/**
 * Reads the built-in list. Any shape it doesn't expect gives an empty list (a wrong file shows nothing, it never throws).
 * One bad group empties the whole list, so a half-read list is never shown as if it were complete.
 */
export function parseSensitivePaths(value: unknown): readonly SensitivePathGroup[] {
  try {
    if (!value || typeof value !== "object") return [];
    const file = value as { version?: unknown; groups?: unknown };
    if (file.version !== 1 || !Array.isArray(file.groups)) return [];
    const groups: SensitivePathGroup[] = [];
    for (const entry of file.groups as unknown[]) {
      if (!entry || typeof entry !== "object") return [];
      const group = entry as { id?: unknown; label?: unknown; patterns?: unknown };
      if (typeof group.id !== "string" || !group.id.trim()) return [];
      if (typeof group.label !== "string" || !group.label.trim()) return [];
      if (!Array.isArray(group.patterns) || group.patterns.length === 0) return [];
      for (const pattern of group.patterns as unknown[]) {
        if (typeof pattern !== "string" || pattern === "" || /\s/.test(pattern)) return [];
      }
      groups.push({ id: group.id, label: group.label, patterns: [...(group.patterns as string[])] });
    }
    return groups;
  } catch {
    return [];
  }
}

export const SENSITIVE_PATH_GROUPS: readonly SensitivePathGroup[] = parseSensitivePaths(sensitivePathsFile);

/** The line under the testing modes, always shown when the project is tested at all. */
export const SENSITIVE_PATHS_LINE =
  "Changes to keys, permissions, the sandbox, billing, migrations, CI or installers always get the full checks.";

/** The last sentence of the More text: where a person adds paths of their own. */
export const SENSITIVE_PATHS_ADD_MORE = "Add more paths to a project's protected list.";

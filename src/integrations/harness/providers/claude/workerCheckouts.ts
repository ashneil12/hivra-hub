import type { ClaudeCliSettings } from "./claudeProtocol";

/**
 * r82 (c02 r81: all five jobs were back and the roll-up never came, because the Lead's read of a worker's App.tsx
 * stopped on "Allow it to read App.tsx?"). A Lead checks its workers' work in their checkouts, the project's sibling
 * `<project>-worktrees/` folder, which is outside its own folder, so every read there asked Ash. Reading them is
 * allowed; writing there still asks, as before. A worker (already inside that folder) gets nothing new.
 */
export function workerCheckoutsRule(cwd: string | undefined): string | undefined {
  const folder = cwd?.replace(/\/+$/, "");
  if (!folder || !folder.startsWith("/")) return undefined;
  const parent = folder.slice(0, folder.lastIndexOf("/"));
  if (/-worktrees$/.test(parent) || /-worktrees$/.test(folder)) return undefined;
  // Claude Code reads "//" as an absolute path; a Read rule covers Grep and Glob too.
  return `Read(/${folder}-worktrees/**)`;
}

/** `settings` plus the read rule for the project's worker checkouts, for a process working in `cwd`. */
export function withWorkerCheckoutsReadable(settings: ClaudeCliSettings, cwd: string | undefined): ClaudeCliSettings {
  const rule = workerCheckoutsRule(cwd);
  if (!rule) return settings;
  const allow = [...(settings.permissions?.allow ?? [])];
  if (!allow.includes(rule)) allow.push(rule);
  return { ...settings, permissions: { ...settings.permissions, allow } };
}

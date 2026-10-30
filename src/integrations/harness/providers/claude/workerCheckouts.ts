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

/**
 * The read rule as Claude Code arguments, for a process working in `cwd`. A flag, not `--settings`: the dev copy keeps
 * only a few known settings keys (harness.rs, dev Claude settings), so a settings rule never reached its Leads (r82 c02 #3).
 */
export function workerCheckoutsArgs(cwd: string | undefined): string[] {
  const rule = workerCheckoutsRule(cwd);
  return rule ? ["--allowedTools", rule] : [];
}

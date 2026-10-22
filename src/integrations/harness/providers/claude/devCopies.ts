// Our own engineering copies of the hub and Ash OS (worktrees, bundles, QA folders) live under ~/Worktrees. A hub chat
// (a Mono, a worker, a coding chat) must never read them: a Mono that searched a dev copy took unshipped code as the hub's
// truth (Alfred's A1 run, 22 Oct). Claude Code's deny rules hold even in bypassPermissions, so every hub-launched Claude
// Code process gets them, unless the chat itself works inside one of those folders.
import type { ClaudeCliSettings } from "./claudeProtocol";

/** Folders under the home folder that hold dev copies, never a project of Ash's. */
export const DEV_COPY_DIRS = ["Worktrees"] as const;

function homeOf(cwd: string): string | undefined {
  return /^(\/Users\/[^/]+|\/home\/[^/]+)(?=\/|$)/.exec(cwd)?.[1];
}

/** The deny rules for the dev-copy folders: file tools (Read also covers Grep and Glob) and any shell command naming them. */
export function devCopyDenyRules(): string[] {
  return DEV_COPY_DIRS.flatMap((dir) => [`Read(~/${dir}/**)`, `Edit(~/${dir}/**)`, `Bash(*${dir}/*)`, `Bash(*${dir})`]);
}

/** `settings` plus the dev-copy deny rules, for a process working in `cwd`. A chat working inside a dev copy keeps access. */
export function withDevCopiesOff(settings: ClaudeCliSettings | undefined, cwd: string | undefined): ClaudeCliSettings {
  const base = settings ?? {};
  const home = cwd ? homeOf(cwd) : undefined;
  if (cwd && home && DEV_COPY_DIRS.some((dir) => cwd === `${home}/${dir}` || cwd.startsWith(`${home}/${dir}/`))) return base;
  const deny = [...(base.permissions?.deny ?? [])];
  for (const rule of devCopyDenyRules()) if (!deny.includes(rule)) deny.push(rule);
  return { ...base, permissions: { ...base.permissions, deny } };
}

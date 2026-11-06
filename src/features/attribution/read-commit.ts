// SPDX-License-Identifier: Apache-2.0
// Hivra WP-86. Read one commit from a temporary repository. The ledger keeps
// the counts, not this patch.

import { execFileSync } from "node:child_process";

import { attributeCommit, type CommitView, type LedgerRow } from "./attribute-commit";
import type { JournalLine } from "./evidence/journal-overlap/overlap";

function git(repo: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", repo, ...args], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Added lines from a unified patch. `+++` headers are not lines of code. */
export function addedLines(patch: string): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  let truncated = false;
  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("+++")) continue;
    if (!line.startsWith("+")) continue;
    if (lines.length >= 5000) {
      truncated = true;
      break;
    }
    lines.push(line.slice(1));
  }
  return { lines, truncated };
}

function counts(numstat: string): { fileCount: number; lineCount: number } {
  let fileCount = 0;
  let lineCount = 0;
  for (const raw of numstat.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    fileCount += 1;
    const added = Number(parts[0]);
    const removed = Number(parts[1]);
    if (Number.isFinite(added)) lineCount += added;
    if (Number.isFinite(removed)) lineCount += removed;
  }
  return { fileCount, lineCount };
}

/** The commit as the ledger sees it. A git failure throws; the caller keeps the rows it had. */
export function readCommit(repo: string, sha: string, env: NodeJS.ProcessEnv): CommitView {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error("git didn't answer");
  const message = git(repo, ["log", "-1", "--format=%B", sha], env);
  const patch = git(repo, ["show", "-U0", "--format=", sha], env);
  const numstat = git(repo, ["show", "--numstat", "--format=", sha], env);
  const added = addedLines(patch);
  const tally = counts(numstat);
  return {
    sha,
    message,
    addedLines: added.lines,
    fileCount: tally.fileCount,
    lineCount: tally.lineCount,
    truncated: added.truncated,
  };
}

export function attributeRepoCommit(
  repo: string,
  sha: string,
  env: NodeJS.ProcessEnv,
  journal: readonly JournalLine[],
): LedgerRow {
  return attributeCommit(readCommit(repo, sha, env), journal);
}

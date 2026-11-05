// SPDX-License-Identifier: Apache-2.0
// Design: HumanLayer packages/git-attribution attribute-commit (Apache-2.0).
// The upstream tree was not in the local sources checkout, so this is a rewrite.

import type { JournalLine } from "./evidence/journal-overlap/overlap";
import { inferRun } from "./evidence/journal-overlap/overlap";
import { trailers } from "./evidence/trailer/session-trailer";
import { redactHuman } from "./redact-human-commit";

export type Tier = "confirmed" | "inferred" | "person";

export type CommitView = {
  sha: string;
  message: string;
  addedLines: readonly string[];
  fileCount: number;
  lineCount: number;
  /** When the patch was cut short, overlap is not evidence. A trailer still counts. */
  truncated?: boolean;
};

export type LedgerRow = {
  sha: string;
  tier: Tier;
  chatId: string | null;
  taskId: string | null;
  agent: string | null;
  fileCount: number;
  lineCount: number;
  subject: string | null;
};

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/[\t\f\v ]+/g, " ").trim();
}

function subjectOf(message: string): string | null {
  const line = oneLine(message.split(/\r\n|\n|\r/)[0] ?? "");
  if (!line) return null;
  return line.length > 200 ? line.slice(0, 200) : line;
}

/**
 * Confirmed when the trailer block names a chat. Otherwise inferred when the
 * journal owns at least half of the distinctive added lines. Otherwise the
 * person's, and then only the counts are kept.
 */
export function attributeCommit(
  commit: CommitView,
  journal: readonly JournalLine[],
  agentHint: string | null = null,
): LedgerRow {
  const found = trailers(commit.message);
  const counts = {
    sha: commit.sha,
    fileCount: commit.fileCount,
    lineCount: commit.lineCount,
  };
  if (found.chat) {
    const fromJournal = journal.find((row) => row.chatId === found.chat && (found.task === null || row.taskId === found.task));
    return {
      ...counts,
      tier: "confirmed",
      chatId: found.chat,
      taskId: found.task,
      agent: fromJournal?.agent ?? agentHint,
      subject: subjectOf(commit.message),
    };
  }
  const run = commit.truncated ? null : inferRun(commit.addedLines, journal);
  if (run) {
    return {
      ...counts,
      tier: "inferred",
      chatId: run.chatId,
      taskId: run.taskId,
      agent: run.agent ?? agentHint,
      subject: subjectOf(commit.message),
    };
  }
  return redactHuman({
    ...counts,
    tier: "person",
    chatId: null,
    taskId: null,
    agent: null,
    subject: subjectOf(commit.message),
  });
}

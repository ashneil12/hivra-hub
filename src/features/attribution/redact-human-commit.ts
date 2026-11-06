// SPDX-License-Identifier: Apache-2.0
// Design: HumanLayer packages/git-attribution redact-human-commit (Apache-2.0).
// The upstream tree was not in the local sources checkout, so this is a rewrite.

import type { LedgerRow } from "./attribute-commit";

/** A person's commit keeps counts only. The message, the diff, and any credit are dropped. */
export function redactHuman(row: LedgerRow): LedgerRow {
  if (row.tier !== "person") return row;
  return {
    ...row,
    chatId: null,
    taskId: null,
    agent: null,
    subject: null,
  };
}

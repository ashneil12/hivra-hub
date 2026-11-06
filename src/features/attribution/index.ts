// SPDX-License-Identifier: Apache-2.0
// Design: HumanLayer packages/git-attribution (https://github.com/humanlayer/humanlayer).
// The upstream tree was not in the local sources checkout, so this is a rewrite.
//
// Two kinds of evidence, and nothing else is added to a commit:
// 1. A prepare-commit-msg trailer, stamped through the crew's environment
//    (GIT_CONFIG_* sets core.hooksPath). The repository's hooks and config
//    are never changed. The hook then runs the repository's own hook.
// 2. A journal of line hashes. When a person later commits those lines, the
//    commit is inferred, unless the lines are boilerplate.
// A commit that neither claims is the person's. Only file and line counts
// are kept: never the message, and never the diff.

export { isBoilerplate } from "./gate";
export { gitConfigEnv } from "./git-env";
export { validId } from "./session-attribution";
export { attributeCommit, type CommitView, type LedgerRow } from "./attribute-commit";
export { attributePullRequest, type PrCredit } from "./attribute-pull-request";
export { redactHuman } from "./redact-human-commit";
export { trailers } from "./evidence/trailer/session-trailer";
export { hooksDir } from "./evidence/trailer/session-hooks-dir";
export { repoHook } from "./evidence/trailer/forwarded-hooks";
export { hookScript, installHookScript } from "./evidence/trailer/hook-scripts";
export { hashLine, inferRun, type JournalLine } from "./evidence/journal-overlap/overlap";
export { normalizeLine } from "./evidence/journal-overlap/normalize";
export { mergeLedger, keepRows, RANK } from "./evidence/commit-ledger/ledger";
export { commitLine } from "./commit-line";

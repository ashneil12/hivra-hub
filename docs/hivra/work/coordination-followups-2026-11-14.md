# Coordination follow-ups — 14 November 2026

## Observed, not inferred

The earlier chat-reliability patch merged in PR #397 and the updater committed daily revision `d30f261290eeecd0183ab0252e55375e351a11ee` at 01:22:28 UTC. The native Home page then rendered its real cards. This establishes recovery after restart; it does not establish the original blank page's native cause.

Read-only inspection of the local delegation records and saved worker transcripts found:

- A leadership handoff was recorded **completed** after roughly 5.6 seconds with only the provider's weekly-limit refusal as its result. The report had no summary or evidence. It was a failed request classified as finished work, not completed engineering.
- The first streaming job was cancelled after 51.9 minutes. Its replacement reached its last recorded update after 57.5 minutes. These are record-to-update wall times, not measured model or CPU time.
- Five review refusals occurred from 23:40:16 to 23:49:49 UTC. They repeatedly cited changed test assertions whose original test files/names were absent from the task brief. The worker revised reports and ultimately renamed tests. Renaming is not evidence that a test became stronger; no review gate is weakened in this patch.
- The first ask worker was recorded failed/silent after 40.9 minutes. Its saved transcript contains 133 tool blocks and ends mid-implementation. The streaming replacement has 209 saved tool blocks. Block counts are not unique command counts and do not establish where all elapsed time went.
- The streaming worker's final report explicitly described local commits, not a merge or installation. The coordinator's "cuts 1.1–1.3 seconds off every cold start" wording was stronger than the evidence: prompt-write/init timing does not prove improved time to first reply.

No raw transcript, account credential, or personal chat identifier is committed here. Historical task records are not rewritten.

## Changes

- Home's load gets a ten-second deadline. A stalled native read produces visible retry feedback instead of an indefinitely blank area. Refresh events coalesce behind the current read, so frequent task changes cannot continually discard the first successful result. This fixes reproduced failure paths; the original native stall remains unproven.
- Message times stay visible on desktop while copy/edit controls still reveal on hover. Existing stored times are used; missing historical timestamps are not invented. The time tooltip contains the full date and time.
- A past Needs you snapshot has a collapsed Earlier requests section, not a red current heading or a check implying completion. Actual live requests retain their cards.
- After five quiet minutes with open jobs, the owner chat gets a factual app note even when nothing changed. "No new worker report yet" does not imply progress. Status questions and generated resume messages do not move the work boundary, and completed siblings remain in their work cohort. Cancelled duplicates are excluded. The note is tagged as a visible status notice so it is not hidden in Activity. No provider turn is created by this note.
- Work such as "Add a progress bar" remains a work request; "Can you update me on progress?" remains a status request.
- The completion boundary recognizes the exact one-line CLI usage-limit refusal even when the process exits successfully, and returns failed/usage_limit with retryability. Ordinary reports discussing quota are preserved. Claude's error classifier also recognizes weekly/daily/monthly limit wording. Reset times are retained only when supplied as structured data, not guessed from prose. A known usage-limit refusal no longer instructs the Lead to hand the work to another worker on the same exhausted account.

The review-policy requirement that an intended changed test be named in its brief remains intact. Better repair routing and brief amendment are separate from silently relaxing that requirement.

## Checks

Counts overlap; do not add them as unique coverage.

- Before-fix source replay against the installed base: 8 failed / 35 passed across 6 files, reproducing loading, refresh cancellation, history and unchanged-progress failures.
- `npx vitest run src/features/home src/features/asks/ui src/features/monos/model/progressNote.r101.test.ts src/features/monos/model/progressNote.r102.test.ts src/features/monos/model/statusReply.r78.test.ts src/features/monos/model/workerStartNudge.r84.test.ts src/features/hub/model/askLedger.test.ts src/features/monos/model/followedBriefs.test.ts src/features/monos/model/monoSessionCompletion.test.ts src/integrations/harness/providers/claude/claudeFailure.test.ts src/features/sessions/ui/AgentTranscript.inlineWork.test.ts`: 35 files / 214 passed, no skips. Existing React act warnings.
- After the final status-request correction: `npx vitest run src/features/monos/model/statusReply.r78.test.ts src/features/monos/model/progressNote.r101.test.ts src/features/monos/model/workerStartNudge.r84.test.ts`: 21 passed, no skips.
- `npx playwright test tests/browser/coordination-followups.spec.ts tests/browser/mono-stream.spec.ts --project=chromium`: 3 passed, no skips, covering visible loading/error feedback, collapsed history, streaming and non-hover timestamps. Final browser rerun also checks an actual generated progress note remains visible: 3 passed in 14.3 seconds. Existing NO_COLOR/FORCE_COLOR and Babel large-module warnings.
- `npm run check:affected`: 675 passed / 8 failed in 81 web files; 1 script test passed, no skips. All eight failures were the FilePaneNavigation editor import/setup path under concurrent load. `npx vitest run src/features/files/ui/FilePaneNavigation.test.ts` then passed all 9 tests in isolation; this is recorded separately, not presented as a green affected run. A later status-parser correction is covered by the focused command above.
- Final additional quota/progress checks (`npx vitest run src/features/monos/model/progressNote.r101.test.ts src/features/monos/model/progressNote.r102.test.ts src/features/monos/model/monoSessionRehand.r65.test.ts src/features/monos/model/monoSessionCompletionFailure.test.ts src/features/monos/model/monoSessionCompletion.test.ts src/features/monos/model/followedBriefs.test.ts`): 48 passed, no skips.
- Final `npm run check:affected` on the committed source: 1,114 files, 10,443 passed / 33 failed / 13 skipped. All 33 failure names exactly match the previously reproduced unchanged-main failures. The script stage passed 1 test, no skips; TypeScript passed. No Rust source changed. The affected run remains red; the owner-authorized release bypass is explicit.
- `npx tsc --noEmit`: passed. `git diff --check`: passed.
- Independent review: three rounds. Accepted findings were work-cohort shrinkage, confusing status-control work with a status question, and retaining "update me/us" status requests. Regression assertions cover each; the narrow refusal normalization had no reported finding.

Screenshots in `proofs/coordination-followups/` use synthetic fixture data. Source/browser checks do not prove a real five-minute periodic update was observed in the daily app, nor real-provider reply latency. Delivery and native acceptance require the next updater receipt.

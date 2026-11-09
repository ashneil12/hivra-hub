# Flaky tests

Known CI failures that are not treated as product bugs. A title here is fixed, retried, or quarantined. Do not skip a test, and do not weaken what it checks, without a line in this file.

Measured 9 Nov 2026 from 13 completed red CI runs, plus titles the lead already merges past. Status starts as open until the commit that fixes, retries, or quarantines that title.

| Test | OS / browser | Last seen | Cause | Status |
| --- | --- | --- | --- | --- |
| `tests/browser/agents-page.spec.ts` "every button stays on one line, and rows still fit, from a wide page to a narrow one" | WebKit | 9 Nov 2026, 10 of 13 red runs | The width loop slept a fixed 250 ms, then measured the iframe before WebKit had flushed layout. It now waits two frames and polls the same measure (2 s). A wrap that stays still fails. | fixed |
| `tests/browser/agents-page.spec.ts` "the Agents page follows the agents live, and answers, takes a pick and stops through the app's own hands" | WebKit | 9 Nov 2026, 4 of 13 red runs | WebKit fires load twice for one srcdoc. The second event tore the bridge down, so the attention row never landed. A second load of the same window stays. A push the frame did not take is tried again and is not marked sent. The asserts on w:d5 are unchanged. | fixed |
| `tests/browser/video-preview.spec.ts` "file preview decodes, plays and seeks a video, then pauses on tab change" | WebKit | 9 Nov 2026, 3 of 13 red runs | Cold WebKit media pipeline. The test already polls 15 s for metadata, then calls `play()` once. | open |
| `tests/browser/workflow-run.spec.ts` "a Stop that fails comes back with the reason instead of Stopping… for good" | WebKit | 6 Nov 2026 (0 of the 13 runs on 9 Nov; still on the lead's known list) | The failed-stop reason is read once, while the row can still say "Stopping…". | open |
| `stacks::tests::two_writers_do_not_lose_a_stack` | Windows | 9 Nov 2026, one rust run after #103 | Two writers share the stack lock. A Windows sharing violation is not retried, so one writer gives up. | open |
| `activity::tests::two_connections_both_keep_their_rows` | Windows | 9 Nov 2026, one rust run after #103 | Two connections insert at once. A transient lock past the short busy retry drops a row. | open |
| `attribution::tests::two_crews_installing_together_both_get_the_hook` and `a_crew_commit_carries_the_trailers_and_the_repo_hook_still_runs` | Windows | 9 Nov 2026, one rust run after #103 | The failure string is "git didn't answer": git timed out or was briefly missing, and that one miss is final. | open |
| `host/windows-bootstrap.test.ts` "updates an existing Windows host…" | Windows | run 42706613294 | `node.exe` is copied while another process still has it open (sharing violation). | open |
| Windows Ship drill (`hub:ship --drill-rollback`) | Windows | run 42701085403, cancelled after 45+ minutes | A rename or a child with no timeout can sit until a person cancels the job. A finished drill is about 2.5 minutes. | open |
